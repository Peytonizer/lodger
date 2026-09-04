import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { geometrySignature } from '../src/geometry.js';
import { DocumentError, loadDocument, mergeDocuments } from '../src/merge.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const load = (name) => loadDocument(read(name), name);

describe('loadDocument', () => {
  it('reads page count and per-page geometry', async () => {
    const doc = await load('a4-portrait.pdf');
    expect(doc.pageCount).toBe(3);
    expect(doc.pages).toHaveLength(3);
    expect(doc.pages[0]).toEqual({ x0: 0, y0: 0, w: 595, h: 842, rotate: 0 });
  });

  it('reads each page of a mixed bundle separately, not the first page four times', async () => {
    const doc = await load('mixed.pdf');
    expect(doc.pages).toEqual([
      { x0: 0, y0: 0, w: 595, h: 842, rotate: 0 },
      { x0: 0, y0: 0, w: 842, h: 595, rotate: 0 },
      { x0: 0, y0: 0, w: 595, h: 842, rotate: 270 },
      { x0: 0, y0: 0, w: 842, h: 1191, rotate: 0 },
    ]);
    expect(new Set(doc.pages.map(geometrySignature)).size).toBe(4);
  });

  it('reads a CropBox whose origin is not (0,0)', async () => {
    const doc = await load('cropped.pdf');
    expect(doc.pages[0]).toEqual({ x0: 30, y0: 45, w: 595, h: 842, rotate: 0 });
  });

  it('refuses an encrypted document by name, without decrypting it', async () => {
    const error = await load('encrypted.pdf').catch((e) => e);
    expect(error).toBeInstanceOf(DocumentError);
    expect(error.code).toBe('encrypted');
    expect(error.message).toContain('encrypted.pdf');
    expect(error.message).toMatch(/password/i);
  });

  it('refuses a document with no pages', async () => {
    const error = await load('zero-pages.pdf').catch((e) => e);
    expect(error).toBeInstanceOf(DocumentError);
    expect(error.code).toBe('empty');
  });

  it('refuses bytes that are not a PDF at all', async () => {
    const error = await loadDocument(read('seal.png'), 'seal.png').catch((e) => e);
    expect(error).toBeInstanceOf(DocumentError);
    expect(error.code).toBe('corrupt');
  });
});

describe('mergeDocuments', () => {
  it('concatenates in the order given', async () => {
    const a = await load('a4-portrait.pdf');
    const b = await load('mixed.pdf');
    const merged = await mergeDocuments([a, b]);
    expect(merged.doc.getPageCount()).toBe(7);
    expect(merged.pages).toHaveLength(7);
  });

  it('produces a different order when the sources are given in a different order', async () => {
    const a = await load('a4-portrait.pdf');
    const b = await load('mixed.pdf');
    const forwards = await mergeDocuments([a, b]);
    const backwards = await mergeDocuments([b, a]);
    expect(forwards.pages.map(geometrySignature)).not.toEqual(
      backwards.pages.map(geometrySignature),
    );
    expect(forwards.pages.map(geometrySignature).sort()).toEqual(
      backwards.pages.map(geometrySignature).sort(),
    );
  });

  it('preserves every page size and rotation through the copy', async () => {
    // The whole point of copyPages over rasterising: pages arrive as they were.
    const a = await load('a4-portrait.pdf');
    const b = await load('mixed.pdf');
    const merged = await mergeDocuments([a, b]);
    expect(merged.pages).toEqual([...a.pages, ...b.pages]);
  });

  it('preserves a non-zero CropBox origin through the copy', async () => {
    const c = await load('cropped.pdf');
    const merged = await mergeDocuments([c]);
    expect(merged.pages[0]).toEqual({ x0: 30, y0: 45, w: 595, h: 842, rotate: 0 });
  });

  it('records which source document and page each merged page came from', async () => {
    const a = await load('a4-portrait.pdf');
    const b = await load('mixed.pdf');
    const merged = await mergeDocuments([a, b]);
    expect(merged.origins[0]).toEqual({ document: 0, page: 0 });
    expect(merged.origins[2]).toEqual({ document: 0, page: 2 });
    expect(merged.origins[3]).toEqual({ document: 1, page: 0 });
    expect(merged.origins[6]).toEqual({ document: 1, page: 3 });
  });

  it('keeps the merged document loadable, with the same geometry, after a save round trip', async () => {
    const a = await load('a4-portrait.pdf');
    const b = await load('mixed.pdf');
    const merged = await mergeDocuments([a, b]);
    const reloaded = await loadDocument(await merged.doc.save(), 'merged.pdf');
    expect(reloaded.pages).toEqual(merged.pages);
  });

  it('handles a single source', async () => {
    const a = await load('a4-portrait.pdf');
    const merged = await mergeDocuments([a]);
    expect(merged.doc.getPageCount()).toBe(3);
  });

  it('refuses an empty list rather than producing an empty PDF', async () => {
    await expect(mergeDocuments([])).rejects.toBeInstanceOf(DocumentError);
  });
});
