/**
 * geometry.js — the coordinate model.
 *
 * This is the single place in lodger that reasons about page rotation, and it is pure: plain
 * numbers in, plain numbers out, no pdf-lib types and no DOM. Both the exporter and the
 * preview call it, which is the only thing keeping the two in agreement.
 *
 * The problem it solves: PDF user space has its origin at the bottom-left of the page box and
 * is measured in points, but a page also carries a /Rotate value that the viewer applies when
 * displaying it, and a CropBox whose origin is not always (0, 0). A stamp placed "in the
 * bottom-right corner" means the bottom-right corner *as the reader sees it*, which on a page
 * rotated 270° is nowhere near the bottom-right in user space.
 *
 * See SPEC.md, "The coordinate model", for the derivation.
 */

/**
 * @typedef {Object} PageGeometry
 * @property {number} x0      Lower-left x of the CropBox (or MediaBox) in user space.
 * @property {number} y0      Lower-left y of the CropBox (or MediaBox) in user space.
 * @property {number} w       Box width in points.
 * @property {number} h       Box height in points.
 * @property {0|90|180|270} rotate  Normalised /Rotate value.
 */

/**
 * @typedef {Object} StampSettings
 * @property {number} imageScalePct     Image width as a percentage of visual page width.
 * @property {number} marginPt          Inset from the page edge, in points.
 * @property {number} numberFontSizePt  Font size of the numeral, in points.
 * @property {number} startAt           The number given to the first page of the bundle.
 */

/**
 * @typedef {Object} StampLayout
 * @property {{x:number,y:number,width:number,height:number}} image  Visual pts, bottom-left anchor.
 * @property {{cx:number,cy:number,r:number}} circle                 Visual pts.
 * @property {{x:number,y:number,size:number,label:string}} text     Visual pts, baseline start.
 * @property {boolean} collides   True when the circle would overlap the image.
 */

/**
 * Digits in Helvetica-Bold are exactly cap height: no ascender above, no descender below.
 * Centring on the font *size* instead would push every numeral visibly low in its circle,
 * because the size includes room for accents and descenders that a digit never uses.
 *
 * If the font ever becomes configurable, replace this with a real metric lookup rather than
 * reusing Helvetica's number for a face that isn't Helvetica.
 */
export const HELVETICA_BOLD_CAP_HEIGHT_RATIO = 0.718;

/** Smallest circle we will draw, in points, regardless of how narrow the numeral is. */
export const MIN_CIRCLE_RADIUS_PT = 9;

/** Clear space between the numeral's edge and the circle's stroke, in points. */
export const CIRCLE_TEXT_PADDING_PT = 4;

/** Defaults for every stamp setting, and the range each one is clamped to. */
export const SETTING_BOUNDS = {
  imageScalePct: { min: 1, max: 40, default: 12 },
  marginPt: { min: 0, max: 72, default: 18 },
  numberFontSizePt: { min: 6, max: 24, default: 11 },
  startAt: { min: 1, max: 99999, default: 1 },
};

/** @returns {StampSettings} */
export function defaultSettings() {
  return {
    imageScalePct: SETTING_BOUNDS.imageScalePct.default,
    marginPt: SETTING_BOUNDS.marginPt.default,
    numberFontSizePt: SETTING_BOUNDS.numberFontSizePt.default,
    startAt: SETTING_BOUNDS.startAt.default,
  };
}

/**
 * Coerce one setting into range, falling back to the default for anything unparseable.
 * The UI's number inputs can produce NaN, empty strings and out-of-range values freely, and
 * a NaN reaching the geometry silently places the stamp nowhere.
 */
export function clampSetting(key, value) {
  const bounds = SETTING_BOUNDS[key];
  if (!bounds) throw new Error(`Unknown setting: ${key}`);
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/** Coerce a whole settings object. */
export function clampSettings(settings) {
  return {
    imageScalePct: clampSetting('imageScalePct', settings?.imageScalePct),
    marginPt: clampSetting('marginPt', settings?.marginPt),
    numberFontSizePt: clampSetting('numberFontSizePt', settings?.numberFontSizePt),
    startAt: Math.round(clampSetting('startAt', settings?.startAt)),
  };
}

/**
 * Normalise a raw /Rotate value to one of 0, 90, 180, 270.
 *
 * Returns the rounded angle plus whether rounding was needed, because a page whose /Rotate is
 * not a multiple of 90 is malformed and the user deserves to be told rather than silently
 * given a stamp at an angle we invented.
 *
 * @returns {{rotate: 0|90|180|270, rounded: boolean}}
 */
export function normaliseRotation(raw) {
  const n = Number.isFinite(raw) ? raw : 0;
  const wrapped = ((n % 360) + 360) % 360;
  const snapped = (Math.round(wrapped / 90) * 90) % 360;
  return {
    rotate: /** @type {0|90|180|270} */ (snapped),
    rounded: Math.abs(wrapped - snapped) > 1e-9 && Math.abs(wrapped - snapped - 360) > 1e-9,
  };
}

/**
 * The page's size as the reader sees it. A 90°- or 270°-rotated portrait page is displayed
 * landscape, so its visual width is the box's height.
 *
 * @param {PageGeometry} g
 * @returns {{width:number, height:number}}
 */
export function visualSize(g) {
  return g.rotate === 90 || g.rotate === 270
    ? { width: g.h, height: g.w }
    : { width: g.w, height: g.h };
}

/**
 * Map a point in visual space (origin at the bottom-left of the page *as displayed*, x right,
 * y up, in points) to PDF user space.
 *
 * A viewer rotates the page clockwise by /Rotate to display it, so this is the inverse of that
 * rotation, composed with the box's own origin offset.
 *
 * @param {PageGeometry} g
 * @param {number} vx
 * @param {number} vy
 * @returns {{x:number, y:number}}
 */
export function userFromVisual(g, vx, vy) {
  switch (g.rotate) {
    case 0:
      return { x: g.x0 + vx, y: g.y0 + vy };
    case 90:
      // Displayed landscape: visual +x runs up the box, visual +y runs left across it.
      return { x: g.x0 + g.w - vy, y: g.y0 + vx };
    case 180:
      return { x: g.x0 + g.w - vx, y: g.y0 + g.h - vy };
    case 270:
      // Displayed landscape the other way: visual +x runs down the box, visual +y runs right.
      return { x: g.x0 + vy, y: g.y0 + g.h - vx };
    default:
      throw new Error(`Unsupported rotation: ${g.rotate}`);
  }
}

/**
 * Map a point in PDF user space back to visual space. lodger's exporter only needs the
 * forward direction; this exists so the tests can round-trip corners and prove the transform,
 * which is how the worked example in SPEC.md is asserted.
 *
 * @param {PageGeometry} g
 * @returns {{x:number, y:number}}
 */
export function visualFromUser(g, ux, uy) {
  const bx = ux - g.x0;
  const by = uy - g.y0;
  switch (g.rotate) {
    case 0:
      return { x: bx, y: by };
    case 90:
      return { x: by, y: g.w - bx };
    case 180:
      return { x: g.w - bx, y: g.h - by };
    case 270:
      return { x: g.h - by, y: bx };
    default:
      throw new Error(`Unsupported rotation: ${g.rotate}`);
  }
}

/**
 * A key identifying pages that are laid out identically. Used to pick preview pages and to
 * warn about mixed geometry: one page from each distinct signature is one page from each way
 * the placement could go wrong.
 *
 * @param {PageGeometry} g
 */
export function geometrySignature(g) {
  const { width, height } = visualSize(g);
  return `${round2(width)}x${round2(height)}r${g.rotate}`;
}

/**
 * Where every part of the stamp goes, in visual space.
 *
 * The image is sized relative to the page (so it stays proportionate across A4 and A3) and
 * inset by an absolute margin (so it clears the trim edge and survives printing). The circle
 * sits on the same optical baseline: its bottom edge is the same margin above the page edge
 * as the image's bottom edge is.
 *
 * @param {PageGeometry} g
 * @param {StampSettings} settings
 * @param {number|null} imageAspect  natural pixel width / natural pixel height, or null for no image
 * @param {string} label             the numeral to draw, already formatted
 * @param {(text:string, size:number) => number} measureText  usually font.widthOfTextAtSize
 * @returns {StampLayout}
 */
export function stampLayout(g, settings, imageAspect, label, measureText) {
  const { width: vw } = visualSize(g);
  const { imageScalePct, marginPt, numberFontSizePt } = settings;

  let image = null;
  if (imageAspect && Number.isFinite(imageAspect) && imageAspect > 0) {
    const width = (vw * imageScalePct) / 100;
    const height = width / imageAspect;
    image = { x: vw - marginPt - width, y: marginPt, width, height };
  }

  const textWidth = measureText(label, numberFontSizePt);
  const r = Math.max(MIN_CIRCLE_RADIUS_PT, textWidth / 2 + CIRCLE_TEXT_PADDING_PT);
  const circle = { cx: vw / 2, cy: marginPt + r, r };

  const capHeight = numberFontSizePt * HELVETICA_BOLD_CAP_HEIGHT_RATIO;
  const text = {
    x: circle.cx - textWidth / 2,
    y: circle.cy - capHeight / 2,
    size: numberFontSizePt,
    label,
  };

  // Never move anything to resolve this — report it and let the user change the scale. Shifting
  // the stamp on some pages and not others is worse than a stamp the user chose to overlap.
  const collides = image !== null && circle.cx + circle.r > image.x;

  return { image, circle, text, collides };
}

/** Effective print resolution of the image at the size it will be drawn, in DPI. */
export function effectiveDpi(pixelWidth, drawnWidthPt) {
  if (!drawnWidthPt) return Infinity;
  return pixelWidth / (drawnWidthPt / 72);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
