/**
 * Generates every fixture in this directory. Run with `npm run fixtures`.
 *
 * The fixtures are generated rather than collected so that they are unambiguously synthetic —
 * this is a public repo and a real exhibit bundle or a real signature must never end up in its
 * history — and so that a fixture can be reasoned about: when a test fails on `mixed.pdf`, the
 * page sizes and rotations it holds are written down here rather than being a property of a
 * binary nobody can read.
 *
 * Images are built as PNGs by the little encoder below (no image dependency), then converted
 * with macOS `sips` where a real JPEG is needed. That makes this script macOS-only, which is
 * acceptable: the fixtures are committed, so only someone regenerating them needs sips.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(HERE, name);

// ---------------------------------------------------------------------------------------------
// A minimal PNG encoder. Enough for flat-coloured test artwork, and it means the fixture
// generator has no image dependency of its own.
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {{width:number, height:number, rgba:(x:number,y:number)=>[number,number,number,number]}} spec */
function encodePng({ width, height, rgba }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; // filter type 0 (None) — simplest, and these images are tiny
    p += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = rgba(x, y);
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
      p += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Stand-in artwork for a seal: a dark ring with a diagonal bar through it, on transparency.
 * Deliberately not a real seal, signature or logo.
 */
function sealPixels(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.min(width, height) * 0.45;
  const inner = outer * 0.72;
  return (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy);
    const onRing = d <= outer && d >= inner;
    const onBar = Math.abs(dy - dx * 0.6) < height * 0.07 && d < inner;
    if (onRing || onBar) return [26, 26, 30, 255];
    return [0, 0, 0, 0];
  };
}

function sips(args) {
  execFileSync('/usr/bin/sips', args, { stdio: 'pipe' });
}

/**
 * Inject an EXIF APP1 segment declaring orientation 6 ("rotate 90° clockwise for display").
 *
 * The pixels are untouched, which is exactly the real-world case this fixture exists for: a
 * seal photographed or scanned on a phone whose bytes are upright but whose flag says
 * otherwise. pdf-lib's embedJpg ignores the flag, so without honouring it the stamp lands
 * sideways on every page of the bundle.
 */
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.concat([
    Buffer.from('MM', 'ascii'), // big-endian
    Buffer.from([0x00, 0x2a]), // 42, the TIFF magic
    Buffer.from([0x00, 0x00, 0x00, 0x08]), // IFD0 begins at offset 8
    Buffer.from([0x00, 0x01]), // one entry
    Buffer.from([0x01, 0x12]), // tag 0x0112, Orientation
    Buffer.from([0x00, 0x03]), // type 3, SHORT
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // count 1
    // A SHORT is left-justified in the four-byte value field.
    Buffer.from([0x00, orientation, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // no IFD1
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);

  // Drop any EXIF block the encoder already wrote — sips writes one with no orientation tag —
  // so the fixture has exactly one, the way a real file does. Then insert after SOI, and after
  // an APP0/JFIF segment if there is one, since JFIF is conventionally first.
  let cursor = 2;
  let stripped = jpeg;
  while (cursor < stripped.length - 1 && stripped[cursor] === 0xff) {
    const marker = stripped[cursor + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = stripped.readUInt16BE(cursor + 2);
    if (marker === 0xe1 && stripped.subarray(cursor + 4, cursor + 8).toString('ascii') === 'Exif') {
      stripped = Buffer.concat([stripped.subarray(0, cursor), stripped.subarray(cursor + 2 + length)]);
      continue;
    }
    cursor += 2 + length;
  }

  let insertAt = 2;
  if (stripped[2] === 0xff && stripped[3] === 0xe0) insertAt = 4 + stripped.readUInt16BE(4);
  return Buffer.concat([stripped.subarray(0, insertAt), app1, stripped.subarray(insertAt)]);
}

// ---------------------------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------------------------

/** Draws something identifiable on a page so a rendered preview can be eyeballed. */
function decorate(page, label) {
  const { width, height } = page.getSize();
  page.drawRectangle({
    x: 12,
    y: 12,
    width: width - 24,
    height: height - 24,
    borderColor: rgb(0.75, 0.75, 0.78),
    borderWidth: 1,
  });
  page.drawText(label, { x: 28, y: height - 48, size: 16, color: rgb(0.1, 0.1, 0.12) });
}

async function makeA4Portrait() {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 3; i += 1) decorate(doc.addPage([595, 842]), `A4 portrait — page ${i}`);
  writeFileSync(out('a4-portrait.pdf'), await doc.save());
}

/**
 * The awkward bundle: every page a different shape. This is the fixture that catches anything
 * assuming one page size for the whole document.
 */
async function makeMixed() {
  const doc = await PDFDocument.create();
  decorate(doc.addPage([595, 842]), 'A4 portrait, rotate 0');
  decorate(doc.addPage([842, 595]), 'A4 landscape, rotate 0');
  const rotated = doc.addPage([595, 842]);
  decorate(rotated, 'A4 portrait, rotate 270');
  rotated.setRotation(degrees(270));
  decorate(doc.addPage([842, 1191]), 'A3 portrait, rotate 0');
  writeFileSync(out('mixed.pdf'), await doc.save());
}

/** A page whose CropBox origin is not (0,0) — the assumption that quietly ruins placement. */
async function makeCropped() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([655, 932]); // an A4 area plus a 30/45pt bleed
  decorate(page, 'Cropped: CropBox origin (30, 45)');
  page.node.set(
    PDFName.of('CropBox'),
    doc.context.obj([PDFNumber.of(30), PDFNumber.of(45), PDFNumber.of(625), PDFNumber.of(887)]),
  );
  writeFileSync(out('cropped.pdf'), await doc.save());
}

/**
 * Assemble a minimal PDF by hand from a list of indirect objects, with a correct cross-
 * reference table. Used for the two fixtures pdf-lib cannot produce itself.
 *
 * @param {string[]} objects  each a complete "N 0 obj ... endobj" string, in order from 1
 * @param {string} trailerEntries  the trailer dictionary's contents, without the << >>
 */
function minimalPdf(objects, trailerEntries) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} ${trailerEntries} >>\n`;
  pdf += `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

/**
 * A structurally valid PDF with no pages at all.
 *
 * Hand-written because pdf-lib cannot make one: `PDFDocument.create()` starts with zero pages,
 * but `save()` silently adds a blank A4 page to an empty document, so a fixture built the
 * obvious way is a one-page PDF that quietly passes the test it was meant to fail.
 */
function makeZeroPages() {
  writeFileSync(
    out('zero-pages.pdf'),
    minimalPdf(
      [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
      ],
      '/Root 1 0 R',
    ),
  );
}

/**
 * A PDF whose trailer declares an /Encrypt dictionary.
 *
 * Hand-written because pdf-lib cannot produce encrypted output and qpdf isn't a dependency
 * worth adding for one fixture. It is enough for its purpose: pdf-lib decides a document is
 * encrypted by looking for /Encrypt in the trailer, so this exercises the real refusal path.
 * The document is not actually encrypted, and nothing in lodger tries to decrypt anything.
 */
function makeEncrypted() {
  writeFileSync(
    out('encrypted.pdf'),
    minimalPdf(
      [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n',
        '4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>\nendobj\n',
      ],
      '/Root 1 0 R /Encrypt 4 0 R',
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

function makeImages() {
  const tmp = join(HERE, '.tmp');
  mkdirSync(tmp, { recursive: true });

  // The seal, with transparency, as picked artwork ought to be.
  writeFileSync(out('seal.png'), encodePng({ width: 240, height: 160, rgba: sealPixels(240, 160) }));

  // Too few pixels for the size it gets drawn at — the low-DPI warning's fixture.
  writeFileSync(out('seal-tiny.png'), encodePng({ width: 60, height: 40, rgba: sealPixels(60, 40) }));

  // sips won't flatten transparency the way we want, so make an opaque source for the JPEGs.
  const opaque = encodePng({
    width: 240,
    height: 160,
    rgba: (x, y) => {
      const [r, g, b, a] = sealPixels(240, 160)(x, y);
      return a === 0 ? [255, 255, 255, 255] : [r, g, b, 255];
    },
  });
  const opaquePath = join(tmp, 'opaque.png');
  writeFileSync(opaquePath, opaque);

  const baseline = out('seal-baseline.jpg');
  sips([opaquePath, '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', '--out', baseline]);

  // CMYK: passes through some tools and renders wrong in others, so lodger re-encodes it.
  sips([
    baseline,
    '-m',
    '/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc',
    '--out',
    out('seal-cmyk.jpg'),
  ]);

  writeFileSync(out('seal-exif-6.jpg'), withExifOrientation(readFileSync(baseline), 6));

  // Not an image lodger accepts. Just enough of an ISO base media file for the sniffer to
  // recognise the brand and name it in the refusal.
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('heicmif1', 'ascii'),
  ]);
  writeFileSync(out('not-an-image.heic'), ftyp);

  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  await makeA4Portrait();
  await makeMixed();
  await makeCropped();
  makeZeroPages();
  makeEncrypted();
  makeImages();
  console.log('fixtures written to', HERE);
}

await main();
