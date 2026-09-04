/**
 * preview.js — rendering the pages most worth checking, with the stamp drawn on them.
 *
 * The preview never computes a placement of its own. It is handed the very `StampLayout`
 * objects the exporter draws from and converts their visual points into canvas pixels. A
 * second placement calculation for the screen would drift from the one that writes the file,
 * and the whole point of a preview is to be able to trust it.
 *
 * What it rasterises is the merged document *before* stamping, with the stamp painted over the
 * top, and the two halves are deliberately separate.
 *
 * The reason is responsiveness: changing a setting only moves the stamp, and re-rasterising
 * several PDF pages on every keystroke of a number field is slow and visibly janky. Rasterising
 * happens when a document changes; painting happens on every keystroke over the pages already
 * rendered.
 *
 * It also keeps the numeral faithful. pdf.js has no font data for the standard 14 unless it can
 * fetch it, and this page's CSP allows no requests at all, so it would render an embedded
 * Helvetica-Bold in a substituted face — legible, but not the face the exported PDF uses.
 * Painting the numeral ourselves needs no font file and no network.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { HELVETICA_BOLD_CAP_HEIGHT_RATIO, geometrySignature, visualSize } from './geometry.js';
import { pageLabel } from './stamp.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** At most this many pages are rendered, however many distinct shapes the bundle has. */
export const MAX_PREVIEW_PAGES = 8;

/**
 * Choose which pages to show.
 *
 * The first page of each source document, because that is what someone checks first, plus the
 * first page of every distinct size-and-rotation group in the bundle — those are precisely the
 * pages the placement is most likely to get wrong, and the only ones where looking tells you
 * something the previous page didn't.
 *
 * @param {import('./geometry.js').PageGeometry[]} pages
 * @param {{document:number, page:number}[]} origins
 * @returns {{indices: number[], omitted: number}}
 */
export function choosePreviewPages(pages, origins) {
  const wanted = new Set();
  for (const [index, origin] of origins.entries()) {
    if (origin.page === 0) wanted.add(index);
  }

  const seen = new Set();
  for (const index of wanted) seen.add(geometrySignature(pages[index]));
  for (const [index, page] of pages.entries()) {
    const signature = geometrySignature(page);
    if (!seen.has(signature)) {
      seen.add(signature);
      wanted.add(index);
    }
  }

  const ordered = [...wanted].toSorted((a, b) => a - b);
  return {
    indices: ordered.slice(0, MAX_PREVIEW_PAGES),
    omitted: Math.max(0, ordered.length - MAX_PREVIEW_PAGES),
  };
}

/**
 * Draw the stamp over a page canvas.
 *
 * pdf.js renders a page as it is displayed, so the canvas is already in visual space — only
 * the scale and the direction of the y axis differ. `scale` converts points to pixels; the
 * flip is because canvas y grows downwards and visual y grows up.
 */
export function drawStampOverlay(context, layout, visual, scale, imageBitmap) {
  const px = (v) => v * scale;
  const py = (v) => (visual.height - v) * scale;

  context.save();

  if (layout.image && imageBitmap) {
    context.drawImage(
      imageBitmap,
      px(layout.image.x),
      py(layout.image.y + layout.image.height),
      px(layout.image.width),
      px(layout.image.height),
    );
  }

  context.strokeStyle = '#000000';
  context.lineWidth = Math.max(1, scale);
  context.beginPath();
  context.arc(px(layout.circle.cx), py(layout.circle.cy), px(layout.circle.r), 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = '#000000';
  context.font = `bold ${px(layout.text.size)}px Helvetica, Arial, sans-serif`;
  context.textAlign = 'center';
  // Match the exporter's vertical centring: the numeral's cap height straddles the circle's
  // centre. Canvas offers no cap-height baseline, so it is computed here the same way
  // geometry.js computes it rather than approximated with textBaseline: 'middle'.
  const capHeight = px(layout.text.size * HELVETICA_BOLD_CAP_HEIGHT_RATIO);
  context.fillText(layout.text.label, px(layout.circle.cx), py(layout.circle.cy) + capHeight / 2);

  context.restore();
}

/**
 * Rasterise the chosen pages into `container` and hand back what is needed to repaint them.
 *
 * @returns {Promise<{shown: number, omitted: number, pages: object[]}>}
 */
export async function rasterisePreview({ container, bytes, pages, origins, sourceNames, signal }) {
  const { indices, omitted } = choosePreviewPages(pages, origins);

  // pdf.js takes ownership of the buffer it is given and detaches it, which would leave the
  // caller holding an empty Uint8Array. Hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  const rendered = [];

  try {
    const fragment = document.createDocumentFragment();
    const paneWidth = Math.max(240, container.clientWidth || 520);
    // Render at device resolution so pages aren't soft on a retina screen, but cap the
    // multiplier: eight pages at 3x is a lot of memory for a preview.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);

    // Sequential on purpose: rasterising every page at once holds all their canvases in memory
    // simultaneously, and they are wanted in order anyway.
    for (const index of indices) {
      if (signal?.aborted) return { shown: 0, omitted: 0, pages: [] };

      // oxlint-disable-next-line no-await-in-loop
      const page = await doc.getPage(index + 1);
      const geometry = pages[index];
      const visual = visualSize(geometry);
      const scale = (paneWidth / visual.width) * dpr;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      // oxlint-disable-next-line no-await-in-loop
      await page.render({ canvasContext: context, viewport }).promise;
      // Keep the unstamped page so a settings change can repaint the overlay without going
      // back to pdf.js for another rasterisation.
      // oxlint-disable-next-line no-await-in-loop
      const base = await createImageBitmap(canvas);
      page.cleanup();

      const figure = document.createElement('figure');
      figure.className = 'preview-page';
      figure.style.margin = '0';

      const caption = document.createElement('figcaption');
      const origin = origins[index];
      const chip = document.createElement('span');
      chip.className = `origin-chip origin-${origin.document + 1}`;
      chip.textContent = sourceNames[origin.document] ?? `Document ${origin.document + 1}`;
      const label = document.createElement('span');
      caption.append(chip, label);

      figure.append(caption, canvas);
      fragment.append(figure);
      rendered.push({ index, canvas, context, base, visual, scale, geometry, label });
    }

    if (signal?.aborted) return { shown: 0, omitted: 0, pages: [] };

    const list = document.createElement('div');
    list.className = 'preview-pages';
    list.append(fragment);
    container.replaceChildren(list);

    return { shown: indices.length, omitted, pages: rendered };
  } finally {
    // The loading task owns the worker-side document; the proxy has no destroy of its own.
    await task.destroy();
  }
}

/**
 * Repaint the stamp on already-rasterised pages. Cheap enough to run on every keystroke.
 *
 * @param {object[]} rendered  from rasterisePreview
 */
export function paintOverlays(rendered, { layouts, settings, imageBitmap }) {
  for (const item of rendered) {
    const { context, canvas, base, visual, scale, index, geometry, label } = item;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(base, 0, 0);
    drawStampOverlay(context, layouts[index], visual, scale, imageBitmap);
    label.textContent = ` Page ${index + 1} — ${describe(geometry)}, numbered ${pageLabel(index, settings)}`;
  }
}

/** Release the retained page bitmaps. */
export function disposePreview(rendered) {
  for (const item of rendered) item.base.close();
}

const mm = (pt) => Math.round((pt / 72) * 25.4);

/** "210×297mm portrait" and friends, for the caption. */
function describe(geometry) {
  const { width, height } = visualSize(geometry);
  const orientation = width > height ? 'landscape' : 'portrait';
  const rotation = geometry.rotate === 0 ? '' : `, rotated ${geometry.rotate}°`;
  return `${mm(width)}×${mm(height)}mm ${orientation}${rotation}`;
}
