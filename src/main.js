/**
 * main.js — the wiring.
 *
 * Holds the small amount of state a session has and decides what to redo when it changes:
 * picking a document re-merges and re-rasterises, changing a setting only repaints the stamp.
 * Everything it needs to know how to do lives in a module of its own; this file is the
 * sequence, not the substance.
 *
 * State lives in a plain object and nowhere else — no localStorage, no IndexedDB, no cookies.
 * Closing the tab is the whole of the cleanup, which is what lets the page promise that
 * nothing is stored.
 */
import '@fontsource-variable/fraunces/full.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-mono/400.css';
import './css/style.css';

import { defaultSettings } from './geometry.js';
import { ImageError, prepareImage } from './imagePrep.js';
import { DocumentError, loadDocument } from './merge.js';
import { mergeSources, outputFilename, planBundle, renderBundle } from './pipeline.js';
import { disposePreview, paintOverlays, rasterisePreview } from './preview.js';
import { readSettings, setPickerState, wirePicker, wireSettings } from './ui/controls.js';
import { renderMessages, warningEntries } from './ui/messages.js';

const state = {
  /** @type {(import('./merge.js').LoadedDocument|null)[]} */
  documents: [null, null],
  /** @type {import('./imagePrep.js').PreparedImage|null} */
  image: null,
  /** Decoded once, so the overlay isn't re-decoding it on every repaint. */
  imageBitmap: null,
  settings: defaultSettings(),
  /** Refusals, which persist until the offending file is replaced. */
  refusals: new Map(),
  /** The merged document, kept between settings changes so it isn't rebuilt needlessly. */
  merged: null,
  /** The rasterised preview pages, kept for the same reason. */
  rendered: [],
};

const dom = {
  pickers: {
    doc1: document.querySelector('[data-picker="doc1"]'),
    doc2: document.querySelector('[data-picker="doc2"]'),
    image: document.querySelector('[data-picker="image"]'),
  },
  form: {
    imageScalePct: document.querySelector('#imageScalePct'),
    marginPt: document.querySelector('#marginPt'),
    numberFontSizePt: document.querySelector('#numberFontSizePt'),
    startAt: document.querySelector('#startAt'),
  },
  exportButton: document.querySelector('[data-export]'),
  exportNote: document.querySelector('[data-export-note]'),
  messages: document.querySelector('[data-messages]'),
  preview: document.querySelector('[data-preview]'),
  previewCount: document.querySelector('[data-preview-count]'),
  build: document.querySelector('[data-build]'),
};

/** Lets a superseded rebuild abandon its half-finished work. */
let generation = 0;
/** The rebuild currently running, so a picker that lands mid-rebuild can wait for it. */
let inFlight = null;

const documentsReady = () => state.documents.every(Boolean);
const ready = () => documentsReady() && state.image !== null;

async function pickDocument(slot, file) {
  const picker = slot === 0 ? dom.pickers.doc1 : dom.pickers.doc2;
  state.documents[slot] = null;
  state.refusals.delete(`doc${slot}`);
  setPickerState(picker, { state: 'empty', text: `Reading “${file.name}”…` });

  try {
    const loaded = await loadDocument(new Uint8Array(await file.arrayBuffer()), file.name);
    state.documents[slot] = loaded;
    setPickerState(picker, {
      state: 'loaded',
      text: file.name,
      meta: `${loaded.pageCount} page${loaded.pageCount === 1 ? '' : 's'}`,
    });
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    state.refusals.set(`doc${slot}`, error.message);
    setPickerState(picker, { state: 'error', text: file.name, meta: 'not used' });
  }
  await rebuild();
}

async function pickImage(file) {
  const picker = dom.pickers.image;
  state.image = null;
  state.imageBitmap?.close();
  state.imageBitmap = null;
  state.refusals.delete('image');
  setPickerState(picker, { state: 'empty', text: `Reading “${file.name}”…` });

  try {
    const prepared = await prepareImage(file);
    state.image = prepared;
    // The overlay draws the *prepared* bytes, not the picked file, so what is on screen is
    // what will be embedded — including any rotation that was applied to it.
    state.imageBitmap = await createImageBitmap(
      new Blob([prepared.bytes], { type: prepared.format === 'png' ? 'image/png' : 'image/jpeg' }),
    );
    setPickerState(picker, {
      state: 'loaded',
      text: file.name,
      meta: `${prepared.pixelWidth}×${prepared.pixelHeight}px`,
    });
  } catch (error) {
    if (!(error instanceof ImageError)) throw error;
    state.refusals.set('image', error.message);
    setPickerState(picker, { state: 'error', text: file.name, meta: 'not used' });
  }
  // The image doesn't change the merge, only what is drawn on it — so a repaint is enough,
  // but only once any rebuild already running has finished. Picking all three files quickly
  // enough lands here while the merge is still in flight, and repainting against a preview
  // that has not been rasterised yet leaves the pane empty until something else happens.
  if (inFlight) await inFlight;
  if (state.merged) repaint();
  else await rebuild();
}

/** Merge and rasterise. Runs when a document changes — the expensive path. */
async function rebuild() {
  const run = rebuildInner();
  inFlight = run;
  try {
    await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function rebuildInner() {
  const mine = (generation += 1);
  const stale = () => mine !== generation;

  disposePreview(state.rendered);
  state.rendered = [];
  state.merged = null;

  if (!documentsReady()) {
    showEmptyPreview();
    repaint();
    return;
  }

  dom.preview.classList.add('is-busy');
  try {
    const sources = /** @type {import('./merge.js').LoadedDocument[]} */ (state.documents);
    const merged = await mergeSources(sources);
    if (stale()) return;
    state.merged = merged;

    const { pages } = await rasterisePreview({
      container: dom.preview,
      bytes: merged.bytes,
      pages: merged.pages,
      origins: merged.origins,
      sourceNames: sources.map((source) => source.name),
      signal: { get aborted() { return stale(); } },
    });
    if (stale()) return;
    state.rendered = pages;
    repaint();
  } catch (error) {
    if (stale()) return;
    state.merged = null;
    showEmptyPreview();
    renderMessages(dom.messages, [
      ...refusalEntries(),
      { kind: 'refuse', message: `The documents couldn't be merged: ${error.message}` },
    ]);
    setExportState(false, 'Nothing was written.');
  } finally {
    if (!stale()) dom.preview.classList.remove('is-busy');
  }
}

/** Re-plan and repaint. Runs on every settings change — the cheap path. */
function repaint() {
  state.settings = readSettings(dom.form);
  const refusals = refusalEntries();

  if (!state.merged || !ready()) {
    renderMessages(dom.messages, refusals);
    setExportState(
      false,
      refusals.length > 0 ? 'Fix the problem above to continue.' : 'Both documents and an image are needed.',
    );
    dom.previewCount.textContent = '';
    return;
  }

  const { layouts, warnings } = planBundle(state.merged, {
    image: state.image,
    settings: state.settings,
  });
  state.layouts = layouts;

  paintOverlays(state.rendered, {
    layouts,
    settings: state.settings,
    imageBitmap: state.imageBitmap,
  });

  renderMessages(dom.messages, [...refusals, ...warningEntries(warnings)]);

  const total = state.merged.pages.length;
  const shown = state.rendered.length;
  dom.previewCount.textContent = `${shown} of ${total} page${total === 1 ? '' : 's'} shown`;
  setExportState(true, `${total} page${total === 1 ? '' : 's'} ready.`);
}

function refusalEntries() {
  return [...state.refusals.values()].map((message) => ({ kind: 'refuse', message }));
}

function showEmptyPreview() {
  const empty = document.createElement('div');
  empty.className = 'preview-empty';
  const text = document.createElement('p');
  text.textContent =
    'Load the documents and a stamp image, and the pages most worth checking will appear here — ' +
    'the first page of each document, and one of every page size and rotation in the bundle.';
  empty.append(text);
  dom.preview.replaceChildren(empty);
  dom.previewCount.textContent = '';
}

function setExportState(enabled, note) {
  dom.exportButton.disabled = !enabled;
  dom.exportNote.textContent = note;
}

/**
 * Stamp and save.
 *
 * The stamp is drawn now rather than during the preview, so a settings change costs a repaint
 * rather than a rewrite of the whole document. The object URL is revoked as soon as the
 * download has started, so the bytes aren't left reachable for the life of the tab.
 */
async function exportBundle() {
  if (!state.merged || !ready()) return;
  setExportState(false, 'Stamping…');
  try {
    const bytes = await renderBundle(state.merged, {
      image: state.image,
      settings: state.settings,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = outputFilename(state.merged.sources);
    link.click();
    URL.revokeObjectURL(url);

    // The document has now been drawn on, so it can't be stamped again with different
    // settings. Re-merge from the sources the user already loaded, which is quick and leaves
    // the page usable rather than subtly wrong.
    setExportState(false, 'Saved. Re-reading the documents…');
    await rebuild();
  } catch (error) {
    renderMessages(dom.messages, [
      ...refusalEntries(),
      { kind: 'refuse', message: `The bundle couldn't be written: ${error.message}` },
    ]);
    setExportState(true, 'Nothing was written.');
  }
}

wirePicker(dom.pickers.doc1, (file) => pickDocument(0, file));
wirePicker(dom.pickers.doc2, (file) => pickDocument(1, file));
wirePicker(dom.pickers.image, (file) => pickImage(file));
wireSettings(dom.form, repaint);
dom.exportButton.addEventListener('click', exportBundle);
dom.build.textContent = `build ${import.meta.env.VITE_COMMIT_SHA}`;

/**
 * The light/dark toggle.
 *
 * The choice is not remembered between sessions, because nothing here is: lodger stores
 * nothing at all, and one convenience setting is not worth qualifying that promise for. The
 * page follows the system preference until someone says otherwise.
 */
{
  const toggle = document.querySelector('[data-theme-toggle]');
  const label = document.querySelector('[data-theme-label]');
  const systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  let dark = systemDark?.matches ?? false;

  const apply = () => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    toggle.setAttribute('aria-pressed', String(dark));
    label.textContent = dark ? 'Dark' : 'Light';
  };

  toggle.addEventListener('click', () => {
    dark = !dark;
    apply();
  });
  apply();
}
