// Pixel-buffer helpers shared by BOTH ends of the WebGL↔WebGPU parity harness: the node-side test
// and the browser entry esbuild bundles into the page.
//
// Everything here is pure and free of `Buffer`, `btoa`/`atob`, `sharp` and the DOM, for one reason:
// the fixture textures (`./fixtures`) must be byte-identical whether they are produced in node or in
// the page, and the captured pixels must survive the trip out of the page unchanged. A helper that
// existed in two implementations — one node, one browser — would be a place for the two sides of an
// image comparison to differ for a reason that has nothing to do with the renderer under test.

/**
 * Straight-alpha RGBA → premultiplied RGBA (a new buffer; the input is untouched).
 *
 * WHY THE COMPARISON HAPPENS IN PREMULTIPLIED SPACE. A `GPUCanvasContext` can only be configured
 * `alphaMode: "opaque" | "premultiplied"`, so the WebGPU side of this harness is premultiplied by
 * construction. Un-premultiplying it to meet the WebGL side would divide by alpha, and every fully
 * transparent pixel (most of a particle canvas) has alpha 0 — the colour there is not merely
 * unknown, it does not exist, and whatever the two renderers happen to leave in those bytes would
 * read as a difference. Multiplying the WebGL side instead is exact and total: transparent pixels
 * become (0,0,0,0) on both sides.
 */
export function premultiplyRgba(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    out[index] = Math.round((rgba[index] * alpha) / 255);
    out[index + 1] = Math.round((rgba[index + 1] * alpha) / 255);
    out[index + 2] = Math.round((rgba[index + 2] * alpha) / 255);
    out[index + 3] = alpha;
  }
  return out;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes → standard base64. Built in chunks: a 128² capture is 64 KB, and one `+=` per byte over
 *  that is the kind of accidental O(n²) that turns a fast test into a slow one. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    chunk += BASE64_ALPHABET[a >> 2];
    chunk += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    chunk +=
      index + 1 < bytes.length
        ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)]
        : "=";
    chunk += index + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : "=";
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  chunks.push(chunk);
  return chunks.join("");
}

const BASE64_INDEX = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/** Standard base64 → bytes. The inverse of `bytesToBase64`, used node-side to decode a capture. */
export function base64ToBytes(text: string): Uint8Array {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 128 && BASE64_INDEX[code] >= 0) {
      length++;
    }
  }
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? BASE64_INDEX[code] : -1;
    if (value < 0) {
      continue;
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (accumulator >> bits) & 0xff;
    }
  }
  return out;
}
