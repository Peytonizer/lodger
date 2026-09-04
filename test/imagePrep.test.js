import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  detectFormat,
  inspectJpeg,
  inspectPng,
  orientationTransform,
  readExifOrientation,
  renormalisationReason,
} from '../src/imagePrep.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** Build a byte sequence from a list of numbers and ASCII strings. */
const bytes = (...parts) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : [part],
    ),
  );

describe('detectFormat', () => {
  it('identifies the two formats lodger accepts', () => {
    expect(detectFormat(read('seal-baseline.jpg'))).toBe('jpeg');
    expect(detectFormat(read('seal-cmyk.jpg'))).toBe('jpeg');
    expect(detectFormat(read('seal-exif-6.jpg'))).toBe('jpeg');
    expect(detectFormat(read('seal.png'))).toBe('png');
    expect(detectFormat(read('seal-tiny.png'))).toBe('png');
  });

  it('names the formats it refuses, so the message can be specific', () => {
    expect(detectFormat(read('not-an-image.heic'))).toBe('heic');
    expect(detectFormat(read('a4-portrait.pdf'))).toBe('pdf');
    expect(detectFormat(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0))).toBe('gif');
    expect(detectFormat(bytes('RIFF', 0, 0, 0, 0, 'WEBP', 0, 0))).toBe('webp');
    expect(detectFormat(bytes(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('bmp');
    expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('tiff');
    expect(detectFormat(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    expect(detectFormat(bytes('<?xml version="1.0"?><svg></svg>'))).toBe('svg');
  });

  it('goes by the bytes, not the name', () => {
    // A PNG saved as "logo.jpg" is the everyday version of this, and the reason the sniffer
    // exists at all: the extension is whatever somebody typed.
    expect(detectFormat(read('seal.png'))).toBe('png');
  });

  it('does not read past the end of a truncated file', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBe('unknown');
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('inspectJpeg', () => {
  it('reads dimensions and components from a baseline JPEG', () => {
    const info = inspectJpeg(read('seal-baseline.jpg'));
    expect(info.parsed).toBe(true);
    expect(info.width).toBe(240);
    expect(info.height).toBe(160);
    expect(info.components).toBe(3);
    expect(info.progressive).toBe(false);
    expect(info.orientation).toBe(1);
  });

  it('detects a CMYK JPEG by its four components', () => {
    const info = inspectJpeg(read('seal-cmyk.jpg'));
    expect(info.components).toBe(4);
  });

  it('reads an EXIF orientation flag', () => {
    const info = inspectJpeg(read('seal-exif-6.jpg'));
    expect(info.orientation).toBe(6);
    // The flag is a lie about upright pixels — the dimensions are unchanged.
    expect(info.width).toBe(240);
    expect(info.height).toBe(160);
  });

  it('reports orientation 1 for a JPEG with EXIF but no orientation tag', () => {
    // The baseline fixture has an EXIF block written by the encoder with no 0x0112 tag in it,
    // which is the common case and must not be mistaken for a rotation.
    expect(inspectJpeg(read('seal-baseline.jpg')).orientation).toBe(1);
  });

  it('detects a progressive frame marker', () => {
    // SOI, then an SOF2 frame: precision 8, 200 high, 100 wide, 3 components. A frame segment
    // is 8 bytes plus 3 per component, so the length is 17 and nine component bytes follow.
    const jpeg = bytes(
      0xff, 0xd8,
      0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x00, 0x64, 0x03,
      1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    );
    const info = inspectJpeg(jpeg);
    expect(info.parsed).toBe(true);
    expect(info.progressive).toBe(true);
    expect(info.width).toBe(100);
    expect(info.height).toBe(200);
  });

  it('skips segments it does not care about to reach the frame', () => {
    const jpeg = bytes(
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x06, 'JFIF', // an APP0 to step over
      0xff, 0xfe, 0x00, 0x05, 'abc', // a comment to step over
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x01, 1, 0x11, 0,
    );
    const info = inspectJpeg(jpeg);
    expect(info.parsed).toBe(true);
    expect(info.components).toBe(1);
    expect(info.height).toBe(10);
    expect(info.width).toBe(20);
  });

  it('stops at the start of scan rather than walking into entropy-coded data', () => {
    const jpeg = bytes(
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x03,
      1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0x00, 0x3f, 0x00,
      0xff, 0xc2, 0xff, 0xc2, 0xff, 0xc2, // scan bytes that look like markers
    );
    expect(inspectJpeg(jpeg).progressive).toBe(false);
  });

  it('reports parsed:false rather than throwing on a malformed file', () => {
    expect(inspectJpeg(bytes(0xff, 0xd8, 0x00, 0x00, 0x00)).parsed).toBe(false);
    // A length field that runs off the end of the buffer.
    expect(inspectJpeg(bytes(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00)).parsed).toBe(false);
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8])).parsed).toBe(false);
  });

  it('detects an APP14 Adobe marker', () => {
    const jpeg = bytes(
      0xff, 0xd8,
      0xff, 0xee, 0x00, 0x09, 'Adobe', 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x14, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x04,
      1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 4, 0x11, 1,
    );
    const info = inspectJpeg(jpeg);
    expect(info.adobe).toBe(true);
    expect(info.components).toBe(4);
  });
});

describe('readExifOrientation', () => {
  /** A TIFF block holding one orientation tag, in either byte order. */
  const tiff = (order, value) => {
    const big = order === 'MM';
    const u16 = (n) => (big ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
    const u32 = (n) => (big ? [0, 0, n >> 8, n & 0xff] : [n & 0xff, n >> 8, 0, 0]);
    return bytes(order, ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(value), 0, 0, 0, 0, 0, 0);
  };

  it('reads big-endian and little-endian EXIF alike', () => {
    expect(readExifOrientation(tiff('MM', 6), 0)).toBe(6);
    expect(readExifOrientation(tiff('II', 6), 0)).toBe(6);
    expect(readExifOrientation(tiff('MM', 8), 0)).toBe(8);
  });

  it('falls back to upright for anything it cannot read', () => {
    expect(readExifOrientation(bytes('XX', 0, 0, 0, 0, 0, 0), 0)).toBe(1);
    expect(readExifOrientation(tiff('MM', 99), 0)).toBe(1);
    expect(readExifOrientation(new Uint8Array(2), 0)).toBe(1);
  });
});

describe('inspectPng', () => {
  it('reads dimensions and alpha', () => {
    const info = inspectPng(read('seal.png'));
    expect(info.parsed).toBe(true);
    expect(info.width).toBe(240);
    expect(info.height).toBe(160);
    expect(info.colourType).toBe(6);
    expect(info.hasAlpha).toBe(true);
    expect(info.interlaced).toBe(false);
  });

  it('reads the small fixture at its real size', () => {
    const info = inspectPng(read('seal-tiny.png'));
    expect(info.width).toBe(60);
    expect(info.height).toBe(40);
  });

  it('reports parsed:false on something that is not a PNG', () => {
    expect(inspectPng(read('seal-baseline.jpg')).parsed).toBe(false);
  });
});

describe('renormalisationReason', () => {
  const jpeg = (over = {}) => ({
    parsed: true,
    width: 240,
    height: 160,
    components: 3,
    progressive: false,
    orientation: 1,
    adobe: false,
    ...over,
  });

  it('leaves a plain baseline RGB JPEG alone', () => {
    expect(renormalisationReason('jpeg', jpeg())).toBeNull();
  });

  it('leaves a greyscale JPEG alone', () => {
    expect(renormalisationReason('jpeg', jpeg({ components: 1 }))).toBeNull();
  });

  it('re-encodes for each of the reasons the spec names, saying which', () => {
    expect(renormalisationReason('jpeg', jpeg({ orientation: 6 }))).toMatch(/orientation 6/);
    expect(renormalisationReason('jpeg', jpeg({ progressive: true }))).toMatch(/progressive/);
    expect(renormalisationReason('jpeg', jpeg({ components: 4 }))).toMatch(/CMYK/);
    expect(renormalisationReason('jpeg', jpeg({ parsed: false }))).toMatch(/structure/);
  });

  it('leaves a plain PNG alone but re-encodes what pdf-lib cannot decode', () => {
    const png = { parsed: true, bitDepth: 8, interlaced: false };
    expect(renormalisationReason('png', png)).toBeNull();
    expect(renormalisationReason('png', { ...png, interlaced: true })).toMatch(/interlaced/);
    expect(renormalisationReason('png', { ...png, bitDepth: 16 })).toMatch(/16-bit/);
  });

  it('agrees with the fixtures', () => {
    expect(renormalisationReason('jpeg', inspectJpeg(read('seal-baseline.jpg')))).toBeNull();
    expect(renormalisationReason('jpeg', inspectJpeg(read('seal-cmyk.jpg')))).toMatch(/CMYK/);
    expect(renormalisationReason('jpeg', inspectJpeg(read('seal-exif-6.jpg')))).toMatch(
      /orientation 6/,
    );
    expect(renormalisationReason('png', inspectPng(read('seal.png')))).toBeNull();
  });
});

/** Apply a canvas matrix to a point, the way ctx.setTransform would. */
const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

describe('orientationTransform', () => {
  it('is the identity for an upright image', () => {
    const t = orientationTransform(1, 240, 160);
    expect(t.swap).toBe(false);
    expect(apply(t.matrix, 0, 0)).toEqual([0, 0]);
    expect(apply(t.matrix, 240, 160)).toEqual([240, 160]);
  });

  it('swaps the canvas dimensions for the sideways orientations only', () => {
    for (const o of [1, 2, 3, 4]) expect(orientationTransform(o, 240, 160).swap).toBe(false);
    for (const o of [5, 6, 7, 8]) expect(orientationTransform(o, 240, 160).swap).toBe(true);
  });

  it('rotates orientation 6 a quarter turn clockwise', () => {
    // Canvas is 160x240. The image's top-left corner must land at the canvas's top-right.
    const { matrix } = orientationTransform(6, 240, 160);
    expect(apply(matrix, 0, 0)).toEqual([160, 0]);
    expect(apply(matrix, 240, 0)).toEqual([160, 240]);
    expect(apply(matrix, 0, 160)).toEqual([0, 0]);
  });

  it('rotates orientation 8 a quarter turn anticlockwise', () => {
    const { matrix } = orientationTransform(8, 240, 160);
    expect(apply(matrix, 0, 0)).toEqual([0, 240]);
    expect(apply(matrix, 240, 0)).toEqual([0, 0]);
  });

  it('turns orientation 3 upside down', () => {
    const { matrix } = orientationTransform(3, 240, 160);
    expect(apply(matrix, 0, 0)).toEqual([240, 160]);
    expect(apply(matrix, 240, 160)).toEqual([0, 0]);
  });

  it('keeps every corner inside the canvas for all eight orientations', () => {
    for (let o = 1; o <= 8; o += 1) {
      const { swap, matrix } = orientationTransform(o, 240, 160);
      const [cw, ch] = swap ? [160, 240] : [240, 160];
      for (const [x, y] of [[0, 0], [240, 0], [0, 160], [240, 160]]) {
        const [px, py] = apply(matrix, x, y);
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThanOrEqual(cw);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThanOrEqual(ch);
      }
    }
  });
});
