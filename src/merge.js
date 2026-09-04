/**
 * merge.js — loading source documents and combining them into one.
 *
 * Merging is `copyPages`, never rasterising: the pages arrive in the output as the objects
 * they already were, so text stays selectable and searchable and the file stays the size it
 * ought to be. The stamp is drawn on top afterwards, in stamp.js.
 *
 * The public surface takes an *ordered array* of documents rather than a first and a second,
 * even though v1's UI only offers two. Adding a third input is then a change to the UI and
 * nothing else. See IDEAS.md entry 1.
 */
import { PDFDocument } from 'pdf-lib';

import { normaliseRotation } from './geometry.js';

/**
 * @typedef {Object} LoadedDocument
 * @property {string} name        the file's name, for messages
 * @property {PDFDocument} doc
 * @property {number} pageCount
 * @property {import('./geometry.js').PageGeometry[]} pages
 * @property {boolean} hasRoundedRotation  true if any page's /Rotate was not a multiple of 90
 */

/** Thrown for every condition lodger refuses to proceed on, carrying a code for the UI. */
export class DocumentError extends Error {
  /** @param {'encrypted'|'corrupt'|'empty'} code */
  constructor(code, message) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

/**
 * Read one page's geometry.
 *
 * The CropBox is what a viewer displays, so it is what the stamp must be positioned against;
 * the MediaBox is only the fallback for a page that doesn't declare one. Neither is guaranteed
 * to start at the origin — a page trimmed out of a larger sheet routinely doesn't — which is
 * why x0 and y0 are carried through rather than assumed away.
 *
 * @param {import('pdf-lib').PDFPage} page
 * @returns {{geometry: import('./geometry.js').PageGeometry, rounded: boolean}}
 */
export function pageGeometry(page) {
  const box = page.getCropBox() ?? page.getMediaBox();
  const { rotate, rounded } = normaliseRotation(page.getRotation().angle);
  return {
    geometry: {
      x0: box.x,
      y0: box.y,
      w: box.width,
      h: box.height,
      rotate,
    },
    rounded,
  };
}

/**
 * Load one source PDF from bytes, refusing anything lodger will not act on.
 *
 * Encryption is refused rather than worked around: pdf-lib would open the document with
 * `ignoreEncryption`, but stripping a document's protection is not this tool's decision to
 * make, and a bundle silently assembled from documents someone protected is worse than an
 * error message.
 *
 * @param {Uint8Array} bytes
 * @param {string} name
 * @returns {Promise<LoadedDocument>}
 */
export async function loadDocument(bytes, name) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (error) {
    if (/encrypted/i.test(error?.message ?? '')) {
      throw new DocumentError(
        'encrypted',
        `“${name}” is password-protected. lodger won't remove a document's protection — ` +
          'open it in a PDF reader with the password and save an unprotected copy first.',
      );
    }
    throw new DocumentError('corrupt', `“${name}” could not be read as a PDF.`);
  }

  const pdfPages = doc.getPages();
  if (pdfPages.length === 0) {
    throw new DocumentError('empty', `“${name}” has no pages in it.`);
  }

  const pages = [];
  let hasRoundedRotation = false;
  for (const page of pdfPages) {
    const { geometry, rounded } = pageGeometry(page);
    pages.push(geometry);
    hasRoundedRotation = hasRoundedRotation || rounded;
  }

  return { name, doc, pageCount: pdfPages.length, pages, hasRoundedRotation };
}

/**
 * Copy every page of every source, in order, into one new document.
 *
 * @param {LoadedDocument[]} sources
 * @returns {Promise<{doc: PDFDocument, pages: import('./geometry.js').PageGeometry[], origins: {document:number, page:number}[]}>}
 *   `origins` records which source page each merged page came from, so a message about page 7
 *   can say which document it was page 3 of.
 */
export async function mergeDocuments(sources) {
  if (sources.length === 0) throw new DocumentError('empty', 'There is nothing to merge.');

  const merged = await PDFDocument.create();
  const pages = [];
  const origins = [];

  for (const [documentIndex, source] of sources.entries()) {
    const indices = source.doc.getPageIndices();
    const copied = await merged.copyPages(source.doc, indices);
    for (const [pageIndex, page] of copied.entries()) {
      merged.addPage(page);
      pages.push(pageGeometry(page).geometry);
      origins.push({ document: documentIndex, page: pageIndex });
    }
  }

  return { doc: merged, pages, origins };
}
