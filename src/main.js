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
import {
  disposePreview,
  openPreviewStepper,
  pageCaption,
  paintOverlays,
  rasterisePreview,
} from './preview.js';
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
  /** The step-through viewer, open only while that view is showing. */
  stepper: null,
  /** The step-through viewer's currently rendered page, and the position it's showing. */
  stepPage: null,
  stepIndex: 0,
  /** The stamp layouts for every page, from the last `planBundle`. Read by the stepper too. */
  layouts: null,
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
    footerMarginPt: document.querySelector('#footerMarginPt'),
    startAt: document.querySelector('#startAt'),
  },
  exportButton: document.querySelector('[data-export]'),
  exportNote: document.querySelector('[data-export-note]'),
  messages: document.querySelector('[data-messages]'),
  preview: document.querySelector('[data-preview]'),
  previewCount: document.querySelector('[data-preview-count]'),
  previewStepToggle: document.querySelector('[data-preview-step-toggle]'),
  previewStep: document.querySelector('[data-preview-step]'),
  previewStepFigure: document.querySelector('[data-preview-step-figure]'),
  previewStepPrev: document.querySelector('[data-preview-step-prev]'),
  previewStepNext: document.querySelector('[data-preview-step-next]'),
  previewStepIndicator: document.querySelector('[data-preview-step-indicator]'),
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

  // The bytes underneath any open stepper are about to be replaced, and the page it was showing
  // may not even exist in the new bundle — closing it and returning to the grid is simpler and
  // safer than trying to keep it pointed at the same page.
  if (state.stepper) await exitStepMode();

  disposePreview(state.rendered);
  state.rendered = [];
  state.merged = null;
  setStepToggleEnabled(false);

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
    setStepToggleEnabled(true);
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
  paintStepPage();

  renderMessages(dom.messages, [...refusals, ...warningEntries(warnings)]);

  const total = state.merged.pages.length;
  const shown = state.rendered.length;
  dom.previewCount.textContent = `${shown} of ${total} page${total === 1 ? '' : 's'} shown`;
  setExportState(true, `${total} page${total === 1 ? '' : 's'} ready.`);
}

function setStepToggleEnabled(enabled) {
  dom.previewStepToggle.disabled = !enabled;
}

/**
 * Open the step-through viewer on the current bundle and show its first page. Separate from
 * the grid's own pdf.js document (see `openPreviewStepper`), so it renders on demand rather
 * than rasterising the whole bundle at once.
 */
async function enterStepMode() {
  if (!state.merged || state.stepper) return;
  state.stepper = await openPreviewStepper(state.merged.bytes);
  state.stepIndex = 0;
  dom.preview.hidden = true;
  dom.previewStep.hidden = false;
  dom.previewStepToggle.textContent = 'Show overview';
  dom.previewStepToggle.setAttribute('aria-pressed', 'true');
  await renderStepPage();
}

/** Close the step-through viewer and return to the representative grid. */
async function exitStepMode() {
  const stepper = state.stepper;
  state.stepper = null;
  if (state.stepPage) {
    state.stepPage.base.close();
    state.stepPage = null;
  }
  dom.previewStep.hidden = true;
  dom.preview.hidden = false;
  dom.previewStepToggle.textContent = 'Step through all pages';
  dom.previewStepToggle.setAttribute('aria-pressed', 'false');
  if (stepper) await stepper.close();
}

/** Move to `index` in the step-through viewer, if it's a real page and not the one already shown. */
function stepTo(index) {
  if (!state.stepper || !state.merged) return;
  const total = state.merged.pages.length;
  if (index < 0 || index >= total || index === state.stepIndex) return;
  state.stepIndex = index;
  renderStepPage();
}

/** Rasterise the page the stepper is currently pointed at and paint the stamp over it. */
async function renderStepPage() {
  if (!state.stepper || !state.merged) return;
  const paneWidth = Math.max(240, dom.previewStepFigure.clientWidth || 520);
  const geometry = state.merged.pages[state.stepIndex];
  const rendered = await state.stepper.render(state.stepIndex, geometry, paneWidth);

  if (state.stepPage) state.stepPage.base.close();

  const figure = document.createElement('figure');
  figure.className = 'preview-page';
  figure.style.margin = '0';

  const caption = document.createElement('figcaption');
  const origin = state.merged.origins[state.stepIndex];
  const chip = document.createElement('span');
  chip.className = `origin-chip origin-${origin.document + 1}`;
  chip.textContent = state.merged.sources[origin.document]?.name ?? `Document ${origin.document + 1}`;
  const label = document.createElement('span');
  caption.append(chip, label);

  figure.append(caption, rendered.canvas);
  dom.previewStepFigure.replaceChildren(figure);

  state.stepPage = { ...rendered, label };
  paintStepPage();
  updateStepControls();
}

/** Repaint the stepper's current page. Cheap — no re-rasterisation — same as the grid's repaint. */
function paintStepPage() {
  if (!state.stepPage) return;
  if (state.layouts) {
    paintOverlays([state.stepPage], {
      layouts: state.layouts,
      settings: state.settings,
      imageBitmap: state.imageBitmap,
    });
  } else {
    // No image picked yet, so there's no layout to draw — still keep the caption's numbering
    // current, the same information the grid shows in this state.
    state.stepPage.label.textContent = pageCaption(state.stepPage.index, state.stepPage.geometry, state.settings);
  }
}

function updateStepControls() {
  const total = state.merged.pages.length;
  dom.previewStepIndicator.textContent = `Page ${state.stepIndex + 1} of ${total}`;
  dom.previewStepPrev.disabled = state.stepIndex === 0;
  dom.previewStepNext.disabled = state.stepIndex === total - 1;
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

dom.previewStepToggle.addEventListener('click', () => {
  if (state.stepper) exitStepMode();
  else enterStepMode();
});
dom.previewStepPrev.addEventListener('click', () => stepTo(state.stepIndex - 1));
dom.previewStepNext.addEventListener('click', () => stepTo(state.stepIndex + 1));
// Arrow keys are the natural way to page through a document once the viewer has focus, and
// checking every page in a long bundle by mouse click alone would be tedious. Scoped to the
// stepper being open so the settings fields' own left/right editing is untouched.
document.addEventListener('keydown', (event) => {
  if (!state.stepper) return;
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowLeft') stepTo(state.stepIndex - 1);
  else if (event.key === 'ArrowRight') stepTo(state.stepIndex + 1);
});

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
