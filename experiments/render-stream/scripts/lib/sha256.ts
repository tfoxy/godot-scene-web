// Pure, synchronous, dependency-free SHA-256 (FIPS 180-4, section 6.2). No `node:crypto`, no
// `node:*` import at all -- this is the module gate7-design.md G7j adds so
// render-stream-2.ts/-mesh.ts/-shader.ts can be bundled for a browser (gate7-design.md Q5: the GSW
// canvas receiver has no synchronous native hash; `crypto.subtle.digest` is async, and the decoder
// is pure sync code that hashes mid-decode).
//
// sha256Hex() is the reference most callers want: bytes in, lowercase hex digest out, exactly like
// `createHash("sha256").update(bytes).digest("hex")`. It is verified byte-identical to
// `node:crypto` on every golden payload and 10 000 random lengths by
// `scripts/test/self-test-browser-decoder.ts` (G7j's own self-test), which is what lets Node
// callers keep using `node:crypto` (faster on the large texture/mesh payloads self-tests hash
// repeatedly) while the browser uses this implementation, with no observable difference in output
// either way.
//
// setHashImpl()/HashFn exist so render-stream-2.ts, render-stream-mesh.ts and
// render-stream-shader.ts can take an INJECTED hash rather than hard-importing one: each of those
// three files keeps its own local `hashImpl` variable (defaulting to sha256Hex here) and its own
// `setHashImpl()`, so a caller can swap in a `node:crypto`-backed function per module without this
// file -- or the three library files -- ever importing `node:crypto` themselves.

export type HashFn = (bytes: Uint8Array) => string;

// FIPS 180-4 4.2.2: the first 32 bits of the fractional parts of the cube roots of the first 64
// primes.
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// FIPS 180-4 5.3.3: the first 32 bits of the fractional parts of the square roots of the first 8
// primes.
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Pads `bytes` to FIPS 180-4's message schedule (5.1.1: append 0x80, then zeros, then the 64-bit
 * big-endian bit length, to a multiple of 64 bytes) and returns the padded buffer's DataView.
 * Exported only for the sabotage self-test, which builds a deliberately broken variant by writing
 * zero into the length field instead of calling this.
 */
function padMessage(bytes: Uint8Array): DataView {
  const bitLenHigh = Math.floor((bytes.length * 8) / 0x100000000);
  const bitLenLow = (bytes.length * 8) >>> 0;
  const withOne = bytes.length + 1;
  const padZeros = (56 - (withOne % 64) + 64) % 64;
  const totalLen = withOne + padZeros + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHigh, false);
  view.setUint32(totalLen - 4, bitLenLow, false);
  return view;
}

/** The compression function (FIPS 180-4 6.2.2) over an already-padded message, returning the
 * eight final hash words. Shared by `sha256Hex()` and the sabotage self-test's broken variant --
 * only the padding differs between them, never this. */
function compress(view: DataView): number[] {
  let h0 = H0[0];
  let h1 = H0[1];
  let h2 = H0[2];
  let h3 = H0[3];
  let h4 = H0[4];
  let h5 = H0[5];
  let h6 = H0[6];
  let h7 = H0[7];

  const w = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const wi15 = w[i - 15];
      const wi2 = w[i - 2];
      const s0 = rotr(wi15, 7) ^ rotr(wi15, 18) ^ (wi15 >>> 3);
      const s1 = rotr(wi2, 17) ^ rotr(wi2, 19) ^ (wi2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7];
}

function wordsToHex(words: readonly number[]): string {
  let out = "";
  for (const word of words) {
    out += (word >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

/** FIPS 180-4 SHA-256 of `bytes`, as a 64-character lowercase hex digest. Pure and synchronous:
 * no I/O, no `node:crypto`, safe to bundle for a browser. */
export function sha256Hex(bytes: Uint8Array): string {
  return wordsToHex(compress(padMessage(bytes)));
}

/**
 * A deliberately WRONG "sha256" that writes zero into the 64-bit length field instead of the
 * message's true bit length -- i.e. it skips the one meaningful part of FIPS 180-4's length
 * padding (5.1.1) while keeping the same block framing (0x80, zero fill, 64-byte blocks). For any
 * non-empty input this diverges from `sha256Hex()` (the length field is the only place the
 * message's size enters the computation at all), which is exactly what
 * `self-test-browser-decoder.ts`'s sabotage case needs: injecting this must make the golden
 * resource-hash checks fail, proving the self-test actually exercises real hash output rather than
 * passing on a stub.
 */
export function brokenSha256NoLengthPadding(bytes: Uint8Array): string {
  const view = padMessage(bytes);
  // Overwrite the two big-endian length words the real padding wrote with zero.
  view.setUint32(view.byteLength - 8, 0, false);
  view.setUint32(view.byteLength - 4, 0, false);
  return wordsToHex(compress(view));
}
