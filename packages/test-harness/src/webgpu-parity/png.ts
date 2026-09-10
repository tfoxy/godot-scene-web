// A minimal, dependency-free PNG encoder — enough to turn a raw RGBA buffer into a `data:` URL.
//
// WHY NOT `sharp`, WHICH THIS PACKAGE ALREADY DEPENDS ON. The fixture textures (`./fixtures`) are
// INPUTS to a renderer comparison, and both sides must be handed the same bytes. `sharp` is
// node-only, so a fixture list built on it could not be imported by the browser entry, and the
// data-URLs would have to be injected into the page by the test — which works right up until
// someone wants to open the harness page by hand. Encoding here keeps `fixtures.ts` a plain,
// importable-anywhere value.
//
// WHY NOT `canvas.toDataURL()`. Same reason in reverse (it needs a DOM), plus it would make the
// texture bytes a property of whichever browser ran the test.
//
// The deflate stream is STORED (uncompressed) blocks. A fixture texture is at most a few KB, the
// PNG is never shipped anywhere, and a real compressor here would be code with no reader.

import { bytesToBase64 } from "./pixels";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** DEFLATE's stored-block payload ceiling (`LEN` is 16 bits). */
const MAX_STORED_BLOCK = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let index = 0; index < bytes.length; index++) {
    a = (a + bytes[index]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib container around STORED deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / MAX_STORED_BLOCK));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  // CMF = deflate, 32 KB window; FLG chosen so (CMF<<8 | FLG) % 31 === 0.
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  let read = 0;
  for (let block = 0; block < blocks; block++) {
    const size = Math.min(MAX_STORED_BLOCK, raw.length - read);
    out[at++] = block === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    out[at++] = size & 0xff;
    out[at++] = (size >> 8) & 0xff;
    out[at++] = ~size & 0xff;
    out[at++] = (~size >> 8) & 0xff;
    out.set(raw.subarray(read, read + size), at);
    at += size;
    read += size;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

/**
 * Encode top-down RGBA (`width * height * 4` bytes) as an 8-bit RGBA PNG.
 *
 * Deterministic down to the byte: the same pixels always produce the same file, which is what
 * lets a fixture texture be part of a comparison's identity rather than a variable in it.
 */
export function encodePngRgba(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePngRgba: expected ${width * height * 4} bytes for ${width}x${height}, got ${rgba.length}`,
    );
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlace

  // Every scanline carries filter type 0 (None) — the rows are tiny and a filter would only make
  // the bytes harder to reason about.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    raw.set(
      rgba.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1,
    );
  }

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** `encodePngRgba` as a `data:image/png;base64,…` URL — the form the runtimes take textures in. */
export function pngDataUrl(
  width: number,
  height: number,
  rgba: Uint8Array,
): string {
  return `data:image/png;base64,${bytesToBase64(encodePngRgba(width, height, rgba))}`;
}
