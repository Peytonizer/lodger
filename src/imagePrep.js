/**
 * imagePrep.js — turning a picked file into bytes pdf-lib can embed reliably.
 *
 * pdf-lib embeds JPEG and PNG bytes directly, which is what keeps the output small, but it is
 * a byte-level embedder rather than a decoder: it copies the compressed data into the PDF and
 * tells the viewer what it is. So anything the *file* says that pdf-lib doesn't read — an EXIF
 * orientation flag, a CMYK colour space, progressive coding — either lands wrong or fails to
 * render, and it fails on every page of the bundle at once.
 *
 * The fix is to look at the bytes before trusting them, and re-encode through a canvas when
 * they aren't the plain thing pdf-lib assumes. Everything above `prepareImage` is pure byte
 * parsing and is tested in Node against the fixtures; only the canvas step needs a browser.
 */

/**
 * @typedef {Object} JpegInspection
 * @property {boolean} parsed         false if the marker walk hit something malformed
 * @property {number} width
 * @property {number} height
 * @property {number} components      3 = YCbCr, 1 = greyscale, 4 = CMYK or YCCK
 * @property {boolean} progressive
 * @property {number} orientation     EXIF orientation, 1 when absent or unreadable
 * @property {boolean} adobe          an APP14 Adobe marker is present
 */

/**
 * @typedef {Object} PreparedImage
 * @property {Uint8Array} bytes
 * @property {'jpeg'|'png'} format
 * @property {number} pixelWidth
 * @property {number} pixelHeight
 * @property {boolean} hasAlpha
 * @property {boolean} renormalised   true if it went through the canvas
 * @property {string|null} reason     why, in words, for the UI
 */

/** Thrown when a picked file is not something lodger will embed. */
export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

const startsWith = (bytes, signature, offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * Identify a file from its leading bytes.
 *
 * Never trust the extension or the browser's MIME type: a `.jpg` that is really a PNG embeds
 * fine, a `.png` that is really a HEIC does not, and the person who renamed it is not going to
 * be the one who works out why the bundle came out blank.
 *
 * The formats lodger refuses are still recognised by name, so the refusal can say what the
 * file actually is and what to do about it.
 *
 * @returns {'jpeg'|'png'|'gif'|'webp'|'bmp'|'tiff'|'heic'|'svg'|'pdf'|'unknown'}
 */
export function detectFormat(bytes) {
  if (bytes.length < 12) return 'unknown';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  // ISO base media: a `ftyp` box at offset 4, whose brand says which flavour.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'heic';
  }
  const head = ascii(bytes, 0, Math.min(bytes.length, 200)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

/** Human-readable names for the refusal message. */
const FORMAT_NAMES = {
  gif: 'a GIF',
  webp: 'a WebP image',
  bmp: 'a BMP image',
  tiff: 'a TIFF image',
  heic: 'a HEIC image',
  svg: 'an SVG',
  pdf: 'a PDF',
  unknown: 'not an image lodger recognises',
};

// C4 is a Huffman table, C8 is reserved, CC is an arithmetic coding table — not frames.
const isFrameMarker = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

// The four progressive frame types: DCT and arithmetic, each in a plain and a differential
// flavour. pdf-lib embeds the bytes without decoding them, and a progressive JPEG renders
// wrong or not at all in some PDF viewers.
const isProgressiveMarker = (m) => m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce;

/**
 * Walk a JPEG's segment markers.
 *
 * A JPEG is a sequence of `FF xx` markers, most carrying a two-byte big-endian length that
 * includes the length bytes themselves. Three things here matter to lodger, and all three are
 * invisible unless the file is parsed:
 *
 *  - the SOF (start-of-frame) marker, whose *identity* says whether the file is baseline or
 *    progressive, and whose payload says how many colour components it has (4 means CMYK);
 *  - an APP14 `Adobe` marker, which confirms an inverted CMYK encoding;
 *  - an APP1 `Exif` marker, holding the orientation flag pdf-lib ignores.
 *
 * @param {Uint8Array} bytes
 * @returns {JpegInspection}
 */
export function inspectJpeg(bytes) {
  const result = {
    parsed: false,
    width: 0,
    height: 0,
    components: 0,
    progressive: false,
    orientation: 1,
    adobe: false,
  };

  let sawExif = false;
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) return result;
    // Fill bytes: any number of FFs may pad the gap before a marker.
    while (bytes[i] === 0xff && bytes[i + 1] === 0xff) i += 1;
    const marker = bytes[i + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan, or end of image: the entropy-coded data begins and there is nothing
    // further worth parsing. Everything lodger needs appears before this.
    if (marker === 0xda || marker === 0xd9) break;

    if (i + 4 > bytes.length) return result;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return result;
    const payload = i + 4;

    if (isFrameMarker(marker)) {
      // SOF payload: precision(1) height(2) width(2) components(1)
      result.height = (bytes[payload + 1] << 8) | bytes[payload + 2];
      result.width = (bytes[payload + 3] << 8) | bytes[payload + 4];
      result.components = bytes[payload + 5];
      result.progressive = isProgressiveMarker(marker);
      result.parsed = true;
    } else if (marker === 0xee && ascii(bytes, payload, 5) === 'Adobe') {
      result.adobe = true;
    } else if (marker === 0xe1 && !sawExif && ascii(bytes, payload, 6) === 'Exif\0\0') {
      // Only the first EXIF block counts. A well-formed JPEG has one; a file that has picked
      // up a second along the way must not have the first one's orientation overwritten by a
      // later block that happens not to carry the tag.
      sawExif = true;
      result.orientation = readExifOrientation(bytes, payload + 6);
    }

    i += 2 + length;
  }
  return result;
}

/**
 * Read tag 0x0112 (Orientation) out of IFD0 of an EXIF block.
 *
 * EXIF is a TIFF file glued inside a JPEG segment, with its own byte order — which is why
 * everything here goes through the byte-order-aware readers rather than a DataView default.
 * Returns 1 (upright) for anything missing or unreadable: guessing an orientation is worse
 * than leaving the image as it is.
 */
export function readExifOrientation(bytes, tiffStart) {
  try {
    const order = ascii(bytes, tiffStart, 2);
    if (order !== 'II' && order !== 'MM') return 1;
    const big = order === 'MM';
    const u16 = (o) => (big ? (bytes[o] << 8) | bytes[o + 1] : (bytes[o + 1] << 8) | bytes[o]);
    const u32 = (o) =>
      big
        ? ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
        : ((bytes[o + 3] << 24) | (bytes[o + 2] << 16) | (bytes[o + 1] << 8) | bytes[o]) >>> 0;

    if (u16(tiffStart + 2) !== 42) return 1;
    const ifd0 = tiffStart + u32(tiffStart + 4);
    const count = u16(ifd0);
    for (let n = 0; n < count; n += 1) {
      const entry = ifd0 + 2 + n * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch {
    return 1;
  }
  return 1;
}

/**
 * Read a PNG's IHDR. Colour types 4 and 6 carry an alpha channel; a tRNS chunk gives a
 * palette or greyscale image transparency too.
 */
export function inspectPng(bytes) {
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR') {
    return { parsed: false, width: 0, height: 0, bitDepth: 8, colourType: 6, interlaced: false, hasAlpha: true };
  }
  const colourType = bytes[25];
  let hasAlpha = colourType === 4 || colourType === 6;

  // Walk the chunk list for tRNS. Stop at IDAT: transparency is declared before pixel data.
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32(offset);
    const type = ascii(bytes, offset + 4, 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }

  return {
    parsed: true,
    width: u32(16),
    height: u32(20),
    bitDepth: bytes[24],
    colourType,
    interlaced: bytes[28] !== 0,
    hasAlpha,
  };
}

/**
 * Decide whether the file has to be re-encoded before pdf-lib sees it, and say why in words
 * the UI can show. Returns null when the bytes can be embedded as they are.
 */
export function renormalisationReason(format, inspection) {
  if (format === 'jpeg') {
    if (!inspection.parsed) return "its structure isn't what lodger expected";
    if (inspection.orientation !== 1) return `it carries EXIF orientation ${inspection.orientation}`;
    if (inspection.progressive) return "it's a progressive JPEG";
    if (inspection.components === 4) return "it's a CMYK JPEG";
    if (inspection.adobe && inspection.components !== 3 && inspection.components !== 1) {
      return "it's an Adobe-encoded JPEG";
    }
    return null;
  }
  if (!inspection.parsed) return "its structure isn't what lodger expected";
  // pdf-lib's PNG decoder handles neither Adam7 interlacing nor 16-bit channels.
  if (inspection.interlaced) return "it's an interlaced PNG";
  if (inspection.bitDepth === 16) return "it's a 16-bit PNG";
  return null;
}

/**
 * The canvas transform that undoes each EXIF orientation, expressed against the image's
 * original pixel dimensions. Orientations 5–8 turn the image on its side, so the canvas has
 * to be created with its width and height swapped.
 *
 * @returns {{swap: boolean, matrix: [number,number,number,number,number,number]}}
 */
export function orientationTransform(orientation, width, height) {
  switch (orientation) {
    case 2:
      return { swap: false, matrix: [-1, 0, 0, 1, width, 0] }; // mirrored
    case 3:
      return { swap: false, matrix: [-1, 0, 0, -1, width, height] }; // upside down
    case 4:
      return { swap: false, matrix: [1, 0, 0, -1, 0, height] }; // mirrored vertically
    case 5:
      return { swap: true, matrix: [0, 1, 1, 0, 0, 0] }; // transposed
    case 6:
      return { swap: true, matrix: [0, 1, -1, 0, height, 0] }; // rotated 90° clockwise
    case 7:
      return { swap: true, matrix: [0, -1, -1, 0, height, width] }; // transverse
    case 8:
      return { swap: true, matrix: [0, -1, 1, 0, 0, width] }; // rotated 90° anticlockwise
    default:
      return { swap: false, matrix: [1, 0, 0, 1, 0, 0] };
  }
}

/**
 * Rewrite a JPEG's EXIF orientation tag to 1, leaving the pixels alone.
 *
 * This exists because `createImageBitmap`'s `imageOrientation` option cannot be relied on.
 * Chromium applies the EXIF flag even when passed `imageOrientation: 'none'`, so a decoder
 * that was asked for raw pixels hands back rotated ones — and rotating those again produces a
 * seal that is upside down or sideways on every page of the bundle. Which way it goes wrong
 * depends on the browser, which is the worst kind of bug to have in a tool whose output gets
 * filed.
 *
 * Clearing the flag in the bytes removes the disagreement entirely: with nothing for the
 * decoder to apply, every browser returns the same pixels, and the rotation is applied exactly
 * once, by us, from the flag we already parsed and can show the user.
 *
 * @returns {Uint8Array} a copy, with the tag set to 1; the input is not modified
 */
export function clearExifOrientation(bytes) {
  const out = new Uint8Array(bytes);
  let i = 2;
  while (i < out.length - 1) {
    if (out[i] !== 0xff) return out;
    const marker = out[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return out;
    if (i + 4 > out.length) return out;
    const length = (out[i + 2] << 8) | out[i + 3];
    if (length < 2 || i + 2 + length > out.length) return out;
    const payload = i + 4;

    if (marker === 0xe1 && ascii(out, payload, 6) === 'Exif\0\0') {
      const tiff = payload + 6;
      const order = ascii(out, tiff, 2);
      if (order === 'II' || order === 'MM') {
        const big = order === 'MM';
        const u16 = (o) => (big ? (out[o] << 8) | out[o + 1] : (out[o + 1] << 8) | out[o]);
        const u32 = (o) =>
          big
            ? ((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]) >>> 0
            : ((out[o + 3] << 24) | (out[o + 2] << 16) | (out[o + 1] << 8) | out[o]) >>> 0;
        const ifd0 = tiff + u32(tiff + 4);
        const count = u16(ifd0);
        for (let n = 0; n < count; n += 1) {
          const entry = ifd0 + 2 + n * 12;
          if (u16(entry) === 0x0112) {
            // A SHORT is left-justified in the four-byte value field.
            out[entry + 8] = big ? 0 : 1;
            out[entry + 9] = big ? 1 : 0;
          }
        }
      }
      return out;
    }
    i += 2 + length;
  }
  return out;
}

/**
 * Re-encode through a canvas, applying the EXIF orientation as we go.
 *
 * The flag is cleared from the bytes first (see above) so the decoder cannot apply it too.
 */
async function renormalise(bytes, format, orientation) {
  const source = format === 'jpeg' && orientation !== 1 ? clearExifOrientation(bytes) : bytes;
  const blob = new Blob([source], { type: format === 'png' ? 'image/png' : 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const { swap, matrix } = orientationTransform(orientation, bitmap.width, bitmap.height);
  const width = swap ? bitmap.height : bitmap.width;
  const height = swap ? bitmap.width : bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.setTransform(...matrix);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  // A PNG source keeps its alpha; a JPEG never had any, so it goes back out as a JPEG at a
  // quality high enough that a re-encode is not visible at stamp size.
  const outFormat = format === 'png' ? 'png' : 'jpeg';
  const encoded = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new ImageError('image-encode', 'The image could not be re-encoded.'))),
      outFormat === 'png' ? 'image/png' : 'image/jpeg',
      0.92,
    );
  });

  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    format: outFormat,
    pixelWidth: width,
    pixelHeight: height,
  };
}

/**
 * Read a picked file and hand back bytes that will embed and render correctly.
 *
 * @param {File} file
 * @returns {Promise<PreparedImage>}
 */
export async function prepareImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);

  if (format !== 'jpeg' && format !== 'png') {
    const what = FORMAT_NAMES[format] ?? 'not an image lodger recognises';
    throw new ImageError(
      'image-format',
      `“${file.name}” is ${what}. lodger stamps JPEG and PNG artwork — re-export it as one of ` +
        'those and try again.',
    );
  }

  const inspection = format === 'jpeg' ? inspectJpeg(bytes) : inspectPng(bytes);
  const hasAlpha = format === 'png' ? inspection.hasAlpha : false;
  const reason = renormalisationReason(format, inspection);

  if (!reason) {
    return {
      bytes,
      format,
      pixelWidth: inspection.width,
      pixelHeight: inspection.height,
      hasAlpha,
      renormalised: false,
      reason: null,
    };
  }

  try {
    const converted = await renormalise(bytes, format, inspection.orientation ?? 1);
    return { ...converted, hasAlpha: converted.format === 'png' && hasAlpha, renormalised: true, reason };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(
      'image-decode',
      `“${file.name}” couldn't be decoded — ${reason}, and this browser wouldn't re-encode it. ` +
        'Re-export it as a plain JPEG or PNG.',
    );
  }
}
