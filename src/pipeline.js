/**
 * pipeline.js — merge, stamp, save.
 *
 * The one place that knows the whole sequence, so the UI can ask for a bundle without knowing
 * how one is made, and the tests can exercise the real path end to end without a browser.
 */
import { mergeDocuments } from './merge.js';
import { stampDocument } from './stamp.js';
import { collectWarnings } from './warnings.js';

/**
 * Build the finished bundle.
 *
 * @param {Object} args
 * @param {import('./merge.js').LoadedDocument[]} args.sources  in the order they merge
 * @param {import('./imagePrep.js').PreparedImage|null} args.image
 * @param {import('./geometry.js').StampSettings} args.settings
 * @returns {Promise<{bytes: Uint8Array, pages: import('./geometry.js').PageGeometry[], layouts: import('./geometry.js').StampLayout[], warnings: import('./warnings.js').Warning[]}>}
 */
export async function buildBundle({ sources, image, settings }) {
  const { doc, pages } = await mergeDocuments(sources);
  const { layouts } = await stampDocument({ doc, pages, image, settings });
  const warnings = collectWarnings({ sources, pages, layouts, image, settings });
  const bytes = await doc.save();
  return { bytes, pages, layouts, warnings };
}

/**
 * A filename for the download: the first source's name with a suffix, so a bundle assembled
 * from "affidavit.pdf" is recognisable as having come from it.
 */
export function outputFilename(sources) {
  const first = sources[0]?.name ?? 'bundle.pdf';
  return `${first.replace(/\.pdf$/i, '')}-stamped.pdf`;
}
