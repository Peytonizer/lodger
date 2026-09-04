/**
 * pipeline.js — merge, plan, stamp, save.
 *
 * Split into three steps rather than one, because they change on different schedules and the
 * expensive one changes least often:
 *
 *  - `mergeSources` runs when a document is picked. It is the slow step, and it produces the
 *    unstamped bytes the preview rasterises.
 *  - `planBundle` runs on every settings keystroke. It is pure arithmetic over page geometry —
 *    no PDF is written — so the preview can respond immediately.
 *  - `renderBundle` runs once, when the user exports.
 *
 * The preview draws the layouts `planBundle` returns and the exporter draws the same ones, so
 * there is one placement calculation in the program and no way for the two to disagree.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { mergeDocuments } from './merge.js';
import { stampDocument } from './stamp.js';
import { collectWarnings } from './warnings.js';

/**
 * Merge the sources and hand back everything downstream needs.
 *
 * `bytes` is the merged document *before* stamping. That is deliberate: the preview rasterises
 * these bytes and draws the stamp over the top, rather than rasterising an already-stamped
 * document. The reason is the Content-Security-Policy — with no `connect-src`, pdf.js cannot
 * fetch the standard font data it would need to render the embedded Helvetica-Bold numeral, so
 * a preview of stamped bytes would show the number in a substituted font or not at all.
 * Loosening the CSP to fix that would trade the page's central promise for a cosmetic gain.
 *
 * @param {import('./merge.js').LoadedDocument[]} sources
 */
let metricsFontPromise = null;

/**
 * A Helvetica-Bold to measure with, embedded in a document of its own.
 *
 * Planning needs the font's metrics but the merged document has no use for the font itself —
 * nothing is drawn with it until the export stamps a fresh copy in. Embedding it into the
 * document the preview rasterises would put an unused font object in those bytes and make
 * pdf.js log a warning about font data it cannot fetch under this CSP. It renders correctly
 * either way; this simply keeps the previewed bytes to what the preview actually needs.
 *
 * The metrics are the standard ones, so the numbers this measures with are the numbers the
 * exporter draws with.
 */
function metricsFont() {
  metricsFontPromise ??= PDFDocument.create().then((doc) =>
    doc.embedFont(StandardFonts.HelveticaBold),
  );
  return metricsFontPromise;
}

export async function mergeSources(sources) {
  const { doc, pages, origins } = await mergeDocuments(sources);
  const font = await metricsFont();
  const bytes = await doc.save();
  return { doc, font, pages, origins, bytes, sources };
}

/**
 * Work out where the stamp goes on every page, and what is worth warning about. No PDF is
 * written, so this is cheap enough to run on every keystroke.
 *
 * @param {Awaited<ReturnType<typeof mergeSources>>} merged
 * @param {{image: import('./imagePrep.js').PreparedImage|null, settings: import('./geometry.js').StampSettings}} options
 */
export function planBundle(merged, { image, settings }) {
  const layouts = stampDocument.plan({
    pages: merged.pages,
    image,
    settings,
    font: merged.font,
  });
  const warnings = collectWarnings({
    sources: merged.sources,
    pages: merged.pages,
    layouts,
    image,
    settings,
  });
  return { layouts, warnings };
}

/**
 * Draw the stamp and save. Called once, on export.
 *
 * @param {Awaited<ReturnType<typeof mergeSources>>} merged
 */
export async function renderBundle(merged, { image, settings }) {
  await stampDocument({ doc: merged.doc, pages: merged.pages, image, settings });
  return merged.doc.save();
}

/**
 * Build a finished bundle in one call. The UI uses the three steps above; this is the whole
 * sequence for anything that just wants the bytes, and it is what the tests exercise.
 */
export async function buildBundle({ sources, image, settings }) {
  const merged = await mergeSources(sources);
  const { layouts, warnings } = planBundle(merged, { image, settings });
  const bytes = await renderBundle(merged, { image, settings });
  return { bytes, pages: merged.pages, origins: merged.origins, layouts, warnings };
}

/**
 * A filename for the download: the first source's name with a suffix, so a bundle assembled
 * from "affidavit.pdf" is recognisable as having come from it.
 */
export function outputFilename(sources) {
  const first = sources[0]?.name ?? 'bundle.pdf';
  return `${first.replace(/\.pdf$/i, '')}-stamped.pdf`;
}
