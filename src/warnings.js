/**
 * warnings.js — everything worth saying before the user exports.
 *
 * A bundle usually gets printed and filed, and by then it is too late to notice that the seal
 * was 60 pixels wide or that the stamp landed on top of a footer. These checks are cheap and
 * they run before the export, not after it. None of them stops the export: they inform a
 * decision that is the user's to make. Refusals — the things lodger will not do at all — are
 * thrown as DocumentError or ImageError at load time instead.
 */
import { effectiveDpi, geometrySignature, visualSize } from './geometry.js';

/**
 * @typedef {Object} Warning
 * @property {string} code
 * @property {string} message
 * @property {number} [page]   1-based index into the merged bundle, where one page is at fault
 */

/** Below this, artwork starts to look soft in print. */
export const DPI_WARN = 150;

/** Below this it looks obviously wrong, and the wording escalates to match. */
export const DPI_BAD = 96;

/**
 * @param {Object} args
 * @param {import('./merge.js').LoadedDocument[]} args.sources
 * @param {import('./geometry.js').PageGeometry[]} args.pages
 * @param {import('./geometry.js').StampLayout[]} args.layouts
 * @param {import('./imagePrep.js').PreparedImage|null} args.image
 * @param {import('./geometry.js').StampSettings} args.settings
 * @returns {Warning[]}
 */
export function collectWarnings({ sources, pages, layouts, image, settings }) {
  const warnings = [];

  if (image) {
    // The image is scaled to a percentage of page width, so the *largest* page in the bundle
    // draws it biggest and therefore at the lowest resolution. Checking the first page would
    // pass a bundle whose A3 pages are the problem.
    let worst = null;
    for (const [index, page] of pages.entries()) {
      const drawn = (visualSize(page).width * settings.imageScalePct) / 100;
      const dpi = effectiveDpi(image.pixelWidth, drawn);
      if (!worst || dpi < worst.dpi) worst = { dpi, page: index + 1, drawn };
    }
    if (worst && worst.dpi < DPI_WARN) {
      const rounded = Math.round(worst.dpi);
      warnings.push({
        code: 'low-dpi',
        page: worst.page,
        message:
          worst.dpi < DPI_BAD
            ? `The image is ${image.pixelWidth}px wide, which works out to about ${rounded} DPI ` +
              `at the size it will be drawn. It will look obviously soft in print — use artwork ` +
              `at least ${Math.ceil((worst.drawn / 72) * DPI_WARN)}px wide.`
            : `The image is ${image.pixelWidth}px wide, which works out to about ${rounded} DPI ` +
              `at the size it will be drawn. That is a little soft for print; ` +
              `${Math.ceil((worst.drawn / 72) * DPI_WARN)}px or more would be crisp.`,
      });
    }

    if (image.format === 'jpeg') {
      warnings.push({
        code: 'jpeg-opaque',
        message:
          'JPEG has no transparency, so the stamp sits on an opaque rectangle that will cover ' +
          'anything under it. Save the artwork as a PNG if it needs to sit on top of content.',
      });
    }

    if (image.renormalised && image.reason) {
      warnings.push({
        code: 'image-renormalised',
        message: `The image was re-encoded before embedding because ${image.reason}.`,
      });
    }
  }

  const collision = layouts.findIndex((layout) => layout.collides);
  if (collision !== -1) {
    warnings.push({
      code: 'collision',
      page: collision + 1,
      message:
        `On page ${collision + 1} the number circle overlaps the image. Reduce the image size ` +
        'or the number size — lodger will not move the stamp on its own, because a stamp that ' +
        'shifts on some pages and not others is worse than one you chose.',
    });
  }

  const signatures = new Set(pages.map(geometrySignature));
  if (signatures.size > 1) {
    warnings.push({
      code: 'mixed-geometry',
      message:
        `This bundle has ${signatures.size} different page sizes or rotations in it. The stamp ` +
        'is placed against each page separately; the preview shows one page of each so you can ' +
        'check them.',
    });
  }

  if (sources.some((source) => source.hasRoundedRotation)) {
    warnings.push({
      code: 'bad-rotate',
      message:
        'A page declares a rotation that is not a quarter turn, which is malformed. lodger has ' +
        'rounded it to the nearest quarter turn — check that page in the preview.',
    });
  }

  return warnings;
}
