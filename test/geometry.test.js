import { describe, expect, it } from 'vitest';

import {
  CIRCLE_TEXT_PADDING_PT,
  SETTING_BOUNDS,
  HELVETICA_BOLD_CAP_HEIGHT_RATIO,
  MIN_CIRCLE_RADIUS_PT,
  clampSetting,
  clampSettings,
  defaultSettings,
  effectiveDpi,
  geometrySignature,
  normaliseRotation,
  stampLayout,
  userFromVisual,
  visualFromUser,
  visualSize,
} from '../src/geometry.js';

/** A4 portrait, box origin at (0,0). */
const a4 = (rotate = 0) => ({ x0: 0, y0: 0, w: 595, h: 842, rotate });

/** A page cropped out of a larger sheet — the box origin is not (0,0). */
const cropped = (rotate = 0) => ({ x0: 30, y0: 45, w: 595, h: 842, rotate });

/** Helvetica-Bold digit advance widths are 0.556 em; enough to exercise the layout. */
const measure = (text, size) => text.length * size * 0.556;

describe('normaliseRotation', () => {
  it('passes through the four legal values', () => {
    for (const r of [0, 90, 180, 270]) {
      expect(normaliseRotation(r)).toEqual({ rotate: r, rounded: false });
    }
  });

  it('wraps values outside 0–359', () => {
    expect(normaliseRotation(360).rotate).toBe(0);
    expect(normaliseRotation(450).rotate).toBe(90);
    expect(normaliseRotation(-90).rotate).toBe(270);
    expect(normaliseRotation(-450).rotate).toBe(270);
  });

  it('snaps a non-multiple of 90 and says that it did', () => {
    expect(normaliseRotation(87)).toEqual({ rotate: 90, rounded: true });
    expect(normaliseRotation(315)).toEqual({ rotate: 0, rounded: true });
  });

  it('treats a missing or malformed value as 0', () => {
    expect(normaliseRotation(undefined).rotate).toBe(0);
    expect(normaliseRotation(Number.NaN).rotate).toBe(0);
  });
});

describe('visualSize', () => {
  it('leaves an unrotated page alone', () => {
    expect(visualSize(a4(0))).toEqual({ width: 595, height: 842 });
    expect(visualSize(a4(180))).toEqual({ width: 595, height: 842 });
  });

  it('swaps the axes on a quarter-turned page', () => {
    expect(visualSize(a4(90))).toEqual({ width: 842, height: 595 });
    expect(visualSize(a4(270))).toEqual({ width: 842, height: 595 });
  });
});

describe('userFromVisual', () => {
  it('is the identity plus the box origin at rotate 0', () => {
    expect(userFromVisual(a4(0), 100, 200)).toEqual({ x: 100, y: 200 });
    expect(userFromVisual(cropped(0), 100, 200)).toEqual({ x: 130, y: 245 });
  });

  it('maps the visual origin to the displayed bottom-left for every rotation', () => {
    // Whatever the rotation, visual (0,0) is the corner the reader sees at bottom-left.
    expect(userFromVisual(a4(0), 0, 0)).toEqual({ x: 0, y: 0 });
    expect(userFromVisual(a4(90), 0, 0)).toEqual({ x: 595, y: 0 });
    expect(userFromVisual(a4(180), 0, 0)).toEqual({ x: 595, y: 842 });
    expect(userFromVisual(a4(270), 0, 0)).toEqual({ x: 0, y: 842 });
  });

  it('maps the far visual corner to the box corner diagonally opposite', () => {
    // Visual top-right is a different box corner for each rotation. These are the four
    // corners of a 595x842 box, one per rotation, and no two are the same.
    const expected = {
      0: { x: 595, y: 842 },
      90: { x: 0, y: 842 },
      180: { x: 0, y: 0 },
      270: { x: 595, y: 0 },
    };
    for (const rotate of [0, 90, 180, 270]) {
      const g = a4(rotate);
      const { width, height } = visualSize(g);
      expect(userFromVisual(g, width, height)).toEqual(expected[rotate]);
    }
  });

  it('round-trips through visualFromUser for every rotation, cropped or not', () => {
    for (const make of [a4, cropped]) {
      for (const rotate of [0, 90, 180, 270]) {
        const g = make(rotate);
        for (const [vx, vy] of [[0, 0], [10, 20], [300, 700], [841.9, 594.9]]) {
          const { width, height } = visualSize(g);
          if (vx > width || vy > height) continue;
          const u = userFromVisual(g, vx, vy);
          const back = visualFromUser(g, u.x, u.y);
          expect(back.x).toBeCloseTo(vx, 9);
          expect(back.y).toBeCloseTo(vy, 9);
        }
      }
    }
  });

  it('keeps every mapped point inside the page box', () => {
    for (const rotate of [0, 90, 180, 270]) {
      const g = cropped(rotate);
      const { width, height } = visualSize(g);
      for (const [vx, vy] of [[0, 0], [width, 0], [0, height], [width, height], [width / 2, height / 2]]) {
        const { x, y } = userFromVisual(g, vx, vy);
        expect(x).toBeGreaterThanOrEqual(g.x0 - 1e-9);
        expect(x).toBeLessThanOrEqual(g.x0 + g.w + 1e-9);
        expect(y).toBeGreaterThanOrEqual(g.y0 - 1e-9);
        expect(y).toBeLessThanOrEqual(g.y0 + g.h + 1e-9);
      }
    }
  });

  it('rejects a rotation that was never normalised', () => {
    expect(() => userFromVisual({ x0: 0, y0: 0, w: 595, h: 842, rotate: 45 }, 0, 0)).toThrow();
  });
});

// The worked example from SPEC.md, "The coordinate model". If this fails, the transform is
// wrong — the numbers here were derived by hand from the rotation matrices, not from the code.
describe('SPEC.md worked example — A4 portrait with /Rotate 90', () => {
  const g = a4(90);

  it('has the anchor the spec says it has', () => {
    expect(userFromVisual(g, 700, 20)).toEqual({ x: 575, y: 700 });
  });

  it('places a 60x40 image on the visual rectangle the spec says it does', () => {
    // pdf-lib draws the image from its own bottom-left, rotated counter-clockwise by /Rotate
    // about that anchor. Under a 90° CCW rotation the image's local +x runs along user +y and
    // its local +y runs along user -x.
    const anchor = userFromVisual(g, 700, 20);
    const corners = {
      bottomLeft: anchor,
      bottomRight: { x: anchor.x, y: anchor.y + 60 },
      topLeft: { x: anchor.x - 40, y: anchor.y },
      topRight: { x: anchor.x - 40, y: anchor.y + 60 },
    };
    expect(visualFromUser(g, corners.bottomLeft.x, corners.bottomLeft.y)).toEqual({ x: 700, y: 20 });
    expect(visualFromUser(g, corners.bottomRight.x, corners.bottomRight.y)).toEqual({ x: 760, y: 20 });
    expect(visualFromUser(g, corners.topLeft.x, corners.topLeft.y)).toEqual({ x: 700, y: 60 });
    expect(visualFromUser(g, corners.topRight.x, corners.topRight.y)).toEqual({ x: 760, y: 60 });
  });
});

describe('geometrySignature', () => {
  it('groups pages that are laid out identically', () => {
    expect(geometrySignature(a4(0))).toBe(geometrySignature(cropped(0)));
  });

  it('separates a rotated page from an unrotated one of the same box', () => {
    expect(geometrySignature(a4(0))).not.toBe(geometrySignature(a4(90)));
  });

  it('separates a landscape page from a portrait one', () => {
    const landscape = { x0: 0, y0: 0, w: 842, h: 595, rotate: 0 };
    expect(geometrySignature(landscape)).not.toBe(geometrySignature(a4(0)));
  });

  it('gives a rotated portrait page and a true landscape page different signatures', () => {
    // Same visual size, but they are not the same page and the stamp maths differs.
    const landscape = { x0: 0, y0: 0, w: 842, h: 595, rotate: 0 };
    expect(visualSize(landscape)).toEqual(visualSize(a4(90)));
    expect(geometrySignature(landscape)).not.toBe(geometrySignature(a4(90)));
  });
});

describe('stampLayout', () => {
  const settings = defaultSettings();

  it('puts the image in the visual bottom-right, inset by the margin', () => {
    const layout = stampLayout(a4(0), settings, 2, '1', measure);
    expect(layout.image.width).toBeCloseTo(595 * 0.12, 6);
    expect(layout.image.height).toBeCloseTo((595 * 0.12) / 2, 6);
    expect(layout.image.x + layout.image.width).toBeCloseTo(595 - 4, 6);
    expect(layout.image.y).toBe(4);
  });

  it('sizes the image against the visual width, not the box width', () => {
    const rotated = stampLayout(a4(90), settings, 2, '1', measure);
    expect(rotated.image.width).toBeCloseTo(842 * 0.12, 6);
    expect(rotated.image.x + rotated.image.width).toBeCloseTo(842 - 4, 6);
  });

  it('preserves the image aspect ratio', () => {
    for (const aspect of [0.5, 1, 2.35]) {
      const layout = stampLayout(a4(0), settings, aspect, '1', measure);
      expect(layout.image.width / layout.image.height).toBeCloseTo(aspect, 9);
    }
  });

  it('omits the image when there is none', () => {
    const layout = stampLayout(a4(0), settings, null, '1', measure);
    expect(layout.image).toBeNull();
    expect(layout.collides).toBe(false);
  });

  it('centres the circle horizontally and sits it on the image baseline', () => {
    const layout = stampLayout(a4(0), settings, 2, '1', measure);
    expect(layout.circle.cx).toBeCloseTo(595 / 2, 6);
    // Bottom of the circle is the same distance above the page edge as the image's bottom.
    expect(layout.circle.cy - layout.circle.r).toBeCloseTo(layout.image.y, 6);
  });

  it('never draws a circle smaller than the minimum', () => {
    const layout = stampLayout(a4(0), settings, 2, '1', measure);
    expect(layout.circle.r).toBe(MIN_CIRCLE_RADIUS_PT);
  });

  it('grows the circle for a wider numeral', () => {
    const one = stampLayout(a4(0), settings, 2, '1', measure);
    const hundred = stampLayout(a4(0), settings, 2, '100', measure);
    expect(hundred.circle.r).toBeGreaterThan(one.circle.r);
    expect(hundred.circle.r).toBeCloseTo(measure('100', 11) / 2 + CIRCLE_TEXT_PADDING_PT, 9);
  });

  it('centres 1, 10 and 100 on the same optical line', () => {
    // Different circle sizes, but each numeral's cap height straddles its own circle centre.
    for (const label of ['1', '10', '100']) {
      const layout = stampLayout(a4(0), settings, 2, label, measure);
      const capHeight = layout.text.size * HELVETICA_BOLD_CAP_HEIGHT_RATIO;
      const textCentre = layout.text.y + capHeight / 2;
      expect(textCentre).toBeCloseTo(layout.circle.cy, 9);
      expect(layout.text.x + measure(label, 11) / 2).toBeCloseTo(layout.circle.cx, 9);
    }
  });

  it('does not collide at the defaults on A4', () => {
    expect(stampLayout(a4(0), settings, 2, '1', measure).collides).toBe(false);
    expect(stampLayout(a4(90), settings, 2, '1', measure).collides).toBe(false);
  });

  // The circle's centre and the image's width both scale with the page, so collision is
  // driven by the two absolute terms: the margin and the circle's radius. On A4 it takes a
  // deliberately extreme combination; on a small page it happens readily. Both are asserted
  // so that a future change to the defaults or the bounds shows up here.
  it('reports a collision on a small page that the same settings clear on A4', () => {
    const extreme = { ...settings, imageScalePct: 40, numberFontSizePt: 24 };
    const small = { x0: 0, y0: 0, w: 200, h: 300, rotate: 0 };
    expect(stampLayout(small, extreme, 2, '100', measure).collides).toBe(true);
    expect(stampLayout(a4(0), extreme, 2, '100', measure).collides).toBe(false);
  });

  it('does not collide anywhere in the allowed settings range on A4', () => {
    // Documents the headroom: nothing the UI permits puts the stamp on top of the image on a
    // normal page. If a bound in SETTING_BOUNDS is widened, this is the test that notices.
    const worst = {
      imageScalePct: SETTING_BOUNDS.imageScalePct.max,
      marginPt: SETTING_BOUNDS.marginPt.min,
      numberFontSizePt: SETTING_BOUNDS.numberFontSizePt.max,
      startAt: 1,
    };
    expect(stampLayout(a4(0), worst, 2, '99999', measure).collides).toBe(false);
  });
});

describe('clampSetting', () => {
  it('returns the default for anything unparseable', () => {
    expect(clampSetting('imageScalePct', '')).toBe(12);
    expect(clampSetting('imageScalePct', Number.NaN)).toBe(12);
    expect(clampSetting('marginPt', undefined)).toBe(4);
  });

  it('clamps to the bounds rather than rejecting', () => {
    expect(clampSetting('imageScalePct', 999)).toBe(40);
    expect(clampSetting('imageScalePct', -5)).toBe(1);
    expect(clampSetting('marginPt', 0)).toBe(0);
  });

  it('parses a numeric string from a form field', () => {
    expect(clampSetting('numberFontSizePt', '14')).toBe(14);
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    expect(() => clampSetting('nonsense', 1)).toThrow();
  });

  it('rounds startAt to a whole page number', () => {
    expect(clampSettings({ startAt: 43.7 }).startAt).toBe(44);
  });

  it('fills in every default from an empty object', () => {
    expect(clampSettings({})).toEqual(defaultSettings());
    expect(clampSettings(undefined)).toEqual(defaultSettings());
  });
});

describe('effectiveDpi', () => {
  it('computes DPI at the drawn size', () => {
    // 200px drawn 1 inch wide is 200 DPI.
    expect(effectiveDpi(200, 72)).toBeCloseTo(200, 9);
    // The spec's example: a 200px logo drawn 25mm (~70.9pt) wide is about 203 DPI.
    expect(effectiveDpi(200, 70.87)).toBeGreaterThan(200);
    expect(effectiveDpi(60, 70.87)).toBeLessThan(70);
  });

  it('does not divide by zero when nothing is drawn', () => {
    expect(effectiveDpi(200, 0)).toBe(Infinity);
  });
});
