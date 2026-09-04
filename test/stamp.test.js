import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/geometry.js';
import { loadDocument } from '../src/merge.js';
import { buildBundle, outputFilename } from '../src/pipeline.js';
import { pageLabel } from '../src/stamp.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const load = (name) => loadDocument(read(name), name);

/** A PreparedImage as imagePrep would hand one over, without needing a browser. */
const preparedPng = () => ({
  bytes: read('seal.png'),
  format: 'png',
  pixelWidth: 240,
  pixelHeight: 160,
  hasAlpha: true,
  renormalised: false,
  reason: null,
});

const preparedTinyPng = () => ({ ...preparedPng(), bytes: read('seal-tiny.png'), pixelWidth: 60, pixelHeight: 40 });

const preparedJpeg = () => ({
  bytes: read('seal-baseline.jpg'),
  format: 'jpeg',
  pixelWidth: 240,
  pixelHeight: 160,
  hasAlpha: false,
  renormalised: false,
  reason: null,
});

/** Count the image XObjects actually stored in a saved PDF. */
async function countImageObjects(bytes) {
  const doc = await PDFDocument.load(bytes);
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      count += 1;
    }
  }
  return count;
}

describe('pageLabel', () => {
  it('numbers continuously from 1 by default', () => {
    const settings = defaultSettings();
    expect(pageLabel(0, settings)).toBe('1');
    expect(pageLabel(6, settings)).toBe('7');
  });

  it('starts where the settings say, for part two of a bundle', () => {
    const settings = { ...defaultSettings(), startAt: 43 };
    expect(pageLabel(0, settings)).toBe('43');
    expect(pageLabel(1, settings)).toBe('44');
  });
});

describe('buildBundle', () => {
  const settings = defaultSettings();

  it('produces a loadable PDF with every page of every source', async () => {
    const sources = [await load('a4-portrait.pdf'), await load('mixed.pdf')];
    const { bytes } = await buildBundle({ sources, image: preparedPng(), settings });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(7);
  });

  it('leaves every page size and rotation exactly as it was', async () => {
    // Stamping adds; it must not resize, rotate or rasterise anything.
    const sources = [await load('a4-portrait.pdf'), await load('mixed.pdf')];
    const before = [...sources[0].pages, ...sources[1].pages];
    const { bytes } = await buildBundle({ sources, image: preparedPng(), settings });
    const after = await loadDocument(bytes, 'out.pdf');
    expect(after.pages).toEqual(before);
  });

  it('preserves a non-zero CropBox origin', async () => {
    const sources = [await load('cropped.pdf')];
    const { bytes } = await buildBundle({ sources, image: preparedPng(), settings });
    const after = await loadDocument(bytes, 'out.pdf');
    expect(after.pages[0]).toEqual({ x0: 30, y0: 45, w: 595, h: 842, rotate: 0 });
  });

  it('embeds the image once, not once per page', async () => {
    // The difference between a sensible file and an unusable one on a long bundle. Count the
    // image objects in a one-page bundle and a seven-page one: embedding per page would scale
    // the count with the pages, and embedding once keeps it flat.
    const one = await buildBundle({ sources: [await load('cropped.pdf')], image: preparedPng(), settings });
    const seven = await buildBundle({
      sources: [await load('a4-portrait.pdf'), await load('mixed.pdf')],
      image: preparedPng(),
      settings,
    });
    expect(await countImageObjects(seven.bytes)).toBe(await countImageObjects(one.bytes));
  });

  it('embeds a transparent PNG as an image plus its soft mask, and nothing more', async () => {
    // pdf-lib splits an alpha PNG into two XObjects: the colour data and an /SMask holding the
    // alpha channel. Both are /Subtype /Image, so two is the right answer here and one is the
    // right answer for a JPEG, which has no alpha to carry.
    const sources = [await load('a4-portrait.pdf')];
    const png = await buildBundle({ sources, image: preparedPng(), settings });
    const jpeg = await buildBundle({ sources, image: preparedJpeg(), settings });
    expect(await countImageObjects(png.bytes)).toBe(2);
    expect(await countImageObjects(jpeg.bytes)).toBe(1);
  });

  it('does not grow much per page once the image is in', async () => {
    const one = await buildBundle({ sources: [await load('cropped.pdf')], image: preparedPng(), settings });
    const many = await buildBundle({
      sources: [await load('a4-portrait.pdf'), await load('mixed.pdf')],
      image: preparedPng(),
      settings,
    });
    // Seven pages must not cost seven times a one-page bundle.
    expect(many.bytes.length).toBeLessThan(one.bytes.length * 3);
  });

  it('stamps with no image at all', async () => {
    // Not offered by v1's UI, but the drawing code must not assume artwork exists.
    const sources = [await load('a4-portrait.pdf')];
    const { bytes, layouts } = await buildBundle({ sources, image: null, settings });
    expect(await countImageObjects(bytes)).toBe(0);
    expect(layouts.every((l) => l.image === null)).toBe(true);
  });

  it('lays out every page separately in a mixed bundle', async () => {
    const sources = [await load('mixed.pdf')];
    const { layouts } = await buildBundle({ sources, image: preparedPng(), settings });
    // A4 portrait, A4 landscape, A4 rotated 270 (displayed landscape), A3 portrait.
    expect(layouts.map((l) => Math.round(l.image.width))).toEqual([71, 101, 101, 101]);
    expect(layouts.map((l) => Math.round(l.circle.cx))).toEqual([298, 421, 421, 421]);
  });

  it('numbers continuously across both documents from the start-at value', async () => {
    const sources = [await load('a4-portrait.pdf'), await load('mixed.pdf')];
    const { layouts } = await buildBundle({
      sources,
      image: preparedPng(),
      settings: { ...settings, startAt: 43 },
    });
    expect(layouts.map((l) => l.text.label)).toEqual(['43', '44', '45', '46', '47', '48', '49']);
  });

  it('warns about a low-resolution image against the widest page, not the first', async () => {
    // The image is scaled to a percentage of page *width*, so what matters is the widest page
    // rather than the largest by area. In mixed.pdf that is page 2 (A4 landscape, 842pt), and
    // pages 3 and 4 are exactly as wide — the first of the tie is the one named, and page 1
    // (A4 portrait, 595pt) is not it.
    const sources = [await load('mixed.pdf')];
    const { warnings } = await buildBundle({ sources, image: preparedTinyPng(), settings });
    const dpi = warnings.find((w) => w.code === 'low-dpi');
    expect(dpi).toBeDefined();
    expect(dpi.page).toBe(2);
    expect(dpi.message).toMatch(/60px/);
  });

  it('does not warn about resolution when the artwork is big enough', async () => {
    const sources = [await load('mixed.pdf')];
    const { warnings } = await buildBundle({ sources, image: preparedPng(), settings });
    expect(warnings.map((w) => w.code)).not.toContain('low-dpi');
  });

  it('warns that a JPEG will be opaque', async () => {
    const sources = [await load('a4-portrait.pdf')];
    const { warnings } = await buildBundle({ sources, image: preparedJpeg(), settings });
    expect(warnings.map((w) => w.code)).toContain('jpeg-opaque');
  });

  it('does not warn about opacity for a PNG', async () => {
    const sources = [await load('a4-portrait.pdf')];
    const { warnings } = await buildBundle({ sources, image: preparedPng(), settings });
    expect(warnings.map((w) => w.code)).not.toContain('jpeg-opaque');
  });

  it('warns about mixed geometry, and stays quiet on a uniform bundle', async () => {
    const mixed = await buildBundle({ sources: [await load('mixed.pdf')], image: preparedPng(), settings });
    expect(mixed.warnings.map((w) => w.code)).toContain('mixed-geometry');

    const uniform = await buildBundle({
      sources: [await load('a4-portrait.pdf')],
      image: preparedPng(),
      settings,
    });
    expect(uniform.warnings.map((w) => w.code)).not.toContain('mixed-geometry');
  });

  it('says nothing at all about a well-formed bundle with good artwork', async () => {
    const sources = [await load('a4-portrait.pdf')];
    const { warnings } = await buildBundle({ sources, image: preparedPng(), settings });
    expect(warnings).toEqual([]);
  });
});

describe('outputFilename', () => {
  it('names the download after the first source', () => {
    expect(outputFilename([{ name: 'affidavit.pdf' }])).toBe('affidavit-stamped.pdf');
    expect(outputFilename([{ name: 'Affidavit.PDF' }])).toBe('Affidavit-stamped.pdf');
  });

  it('copes with nothing loaded', () => {
    expect(outputFilename([])).toBe('bundle-stamped.pdf');
  });
});
