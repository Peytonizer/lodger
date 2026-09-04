/**
 * stamp.js — drawing the stamp onto every page of a merged document.
 *
 * Two things here are load-bearing:
 *
 * 1. The image is embedded once and the resulting XObject drawn on every page. Embedding per
 *    page multiplies the file size by the page count, which on a three-hundred-page bundle is
 *    the difference between a sensible file and an unusable one.
 *
 * 2. Every element is drawn with `rotate: degrees(page rotation)`. A viewer rotates the page
 *    clockwise by /Rotate to display it, and pdf-lib's rotation is anticlockwise, so the two
 *    cancel and the stamp appears upright to the reader. Without it the stamp is drawn square
 *    to the paper and displayed lying on its side — on exactly the scanned pages that most
 *    need the stamp.
 *
 * Where the stamp goes is not decided here: geometry.js decides, in visual space, and this
 * module maps the result into user space and hands it to pdf-lib.
 */
import { StandardFonts, degrees, rgb } from 'pdf-lib';

import { stampLayout, userFromVisual } from './geometry.js';

/** Stroke weight of the number circle, in points. */
const CIRCLE_BORDER_WIDTH_PT = 1;

/**
 * The circle is stroked and not filled, so whatever is under it stays visible. A white fill
 * would hide page content, and lodger's job is to add to a document rather than take from it.
 */
const INK = rgb(0, 0, 0);

/**
 * The label for one page of the bundle.
 *
 * Numbering is continuous across the merged document: page 1 of document 1 is `startAt`, and
 * it counts on unbroken into document 2. Bundles get produced in parts and part two often has
 * to start at 43, which is what `startAt` is for.
 */
export function pageLabel(index, settings) {
  return String(settings.startAt + index);
}

/**
 * Draw the stamp on every page.
 *
 * @param {Object} args
 * @param {import('pdf-lib').PDFDocument} args.doc  the merged document, modified in place
 * @param {import('./geometry.js').PageGeometry[]} args.pages
 * @param {import('./imagePrep.js').PreparedImage|null} args.image
 * @param {import('./geometry.js').StampSettings} args.settings
 * @returns {Promise<{layouts: import('./geometry.js').StampLayout[]}>}
 */
export async function stampDocument({ doc, pages, image, settings, font }) {
  const typeface = font ?? (await doc.embedFont(StandardFonts.HelveticaBold));

  // Embedded once, outside the loop. This is the whole reason the file stays a sane size.
  let embedded = null;
  if (image) {
    embedded = await (image.format === 'png' ? doc.embedPng(image.bytes) : doc.embedJpg(image.bytes));
  }

  const layouts = stampDocument.plan({ pages, image, settings, font: typeface });
  const pdfPages = doc.getPages();

  for (const [index, geometry] of pages.entries()) {
    const page = pdfPages[index];
    const layout = layouts[index];

    // Counter-rotation: cancels the rotation the viewer applies when displaying the page.
    const rotate = degrees(geometry.rotate);

    if (embedded && layout.image) {
      // pdf-lib anchors an image at its own bottom-left and rotates about that point, so after
      // the counter-rotation the anchor is exactly the image's visual bottom-left corner.
      const anchor = userFromVisual(geometry, layout.image.x, layout.image.y);
      page.drawImage(embedded, {
        x: anchor.x,
        y: anchor.y,
        width: layout.image.width,
        height: layout.image.height,
        rotate,
      });
    }

    // A circle is rotation-symmetric, so its centre maps straight across with no rotation.
    const centre = userFromVisual(geometry, layout.circle.cx, layout.circle.cy);
    page.drawCircle({
      x: centre.x,
      y: centre.y,
      size: layout.circle.r,
      borderColor: INK,
      borderWidth: CIRCLE_BORDER_WIDTH_PT,
    });

    // Text is anchored at the start of its baseline and rotated about that point, so the same
    // rule as the image applies.
    const baseline = userFromVisual(geometry, layout.text.x, layout.text.y);
    page.drawText(layout.text.label, {
      x: baseline.x,
      y: baseline.y,
      size: layout.text.size,
      font: typeface,
      color: INK,
      rotate,
    });
  }

  return { layouts };
}

/**
 * Where the stamp goes on every page, without writing anything.
 *
 * Hung off `stampDocument` rather than exported separately to make the relationship impossible
 * to miss: this is the calculation the drawing above performs, and the preview draws its
 * result. There is one placement calculation in lodger, and this is it.
 *
 * @returns {import('./geometry.js').StampLayout[]}
 */
stampDocument.plan = function plan({ pages, image, settings, font }) {
  const aspect = image ? image.pixelWidth / image.pixelHeight : null;
  const measure = (text, size) => font.widthOfTextAtSize(text, size);
  return pages.map((geometry, index) =>
    stampLayout(geometry, settings, aspect, pageLabel(index, settings), measure),
  );
};
