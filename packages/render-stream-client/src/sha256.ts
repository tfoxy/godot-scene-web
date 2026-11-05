// Pure-JS SHA-256 (FIPS 180-4), the loader's fallback where `crypto.subtle` is missing: it exists
// only in secure contexts, so a plain-http LAN page has none (CAR8). Used only then.
//
// Incremental, so that the loader can hash the core in chunks as they download and yield between
// them. On a moto g31 the 2.5 MB core took ~280 ms in one call (750 ms at 4x CPU throttle) with the
// first, DataView-per-word port: a main-thread block no deadline could interrupt. This version takes
// ~170 ms (~410 ms at 4x), median of 7 cold runs.
//
// Written for V8's int32 paths: words are built from bytes with shifts, the state lives in locals
// across all the blocks of one `update()` call, and the 64 rounds run unrolled by eight so that the
// eight working variables rotate by name instead of being shuffled.

const K = new Int32Array(64);
{
  let n = 0;
  for (let c = 2; n < 64; c++) {
    let prime = true;
    for (let d = 2; d * d <= c; d++) if (c % d === 0) prime = false;
    if (prime) K[n++] = (Math.cbrt(c) % 1) * 2 ** 32;
  }
}

/** The message schedule, shared: a hash is never interrupted inside a block. */
const W = new Int32Array(64);

const S0 = (x: number) =>
  ((x >>> 2) | (x << 30)) ^ ((x >>> 13) | (x << 19)) ^ ((x >>> 22) | (x << 10));
const S1 = (x: number) =>
  ((x >>> 6) | (x << 26)) ^ ((x >>> 11) | (x << 21)) ^ ((x >>> 25) | (x << 7));
const s0 = (x: number) =>
  ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
const s1 = (x: number) =>
  ((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10);

/** Compresses the whole blocks of `src[off, end)` into `s` (the eight state words), in place. */
function blocks(
  s: Int32Array,
  src: Uint8Array,
  off: number,
  end: number,
): void {
  let a = s[0];
  let b = s[1];
  let c = s[2];
  let d = s[3];
  let e = s[4];
  let f = s[5];
  let g = s[6];
  let h = s[7];
  const w = W;
  for (; off + 64 <= end; off += 64) {
    for (let i = 0, j = off; i < 16; i++, j += 4)
      w[i] =
        (src[j] << 24) | (src[j + 1] << 16) | (src[j + 2] << 8) | src[j + 3];
    for (let i = 16; i < 64; i++)
      w[i] = (w[i - 16] + s0(w[i - 15]) + w[i - 7] + s1(w[i - 2])) | 0;
    const a0 = a;
    const b0 = b;
    const c0 = c;
    const d0 = d;
    const e0 = e;
    const f0 = f;
    const g0 = g;
    const h0 = h;
    let t = 0;
    for (let i = 0; i < 64; i += 8) {
      t = (h + S1(e) + (g ^ (e & (f ^ g))) + K[i + 0] + w[i + 0]) | 0;
      d = (d + t) | 0;
      h = (t + S0(a) + ((a & b) | (c & (a | b)))) | 0;
      t = (g + S1(d) + (f ^ (d & (e ^ f))) + K[i + 1] + w[i + 1]) | 0;
      c = (c + t) | 0;
      g = (t + S0(h) + ((h & a) | (b & (h | a)))) | 0;
      t = (f + S1(c) + (e ^ (c & (d ^ e))) + K[i + 2] + w[i + 2]) | 0;
      b = (b + t) | 0;
      f = (t + S0(g) + ((g & h) | (a & (g | h)))) | 0;
      t = (e + S1(b) + (d ^ (b & (c ^ d))) + K[i + 3] + w[i + 3]) | 0;
      a = (a + t) | 0;
      e = (t + S0(f) + ((f & g) | (h & (f | g)))) | 0;
      t = (d + S1(a) + (c ^ (a & (b ^ c))) + K[i + 4] + w[i + 4]) | 0;
      h = (h + t) | 0;
      d = (t + S0(e) + ((e & f) | (g & (e | f)))) | 0;
      t = (c + S1(h) + (b ^ (h & (a ^ b))) + K[i + 5] + w[i + 5]) | 0;
      g = (g + t) | 0;
      c = (t + S0(d) + ((d & e) | (f & (d | e)))) | 0;
      t = (b + S1(g) + (a ^ (g & (h ^ a))) + K[i + 6] + w[i + 6]) | 0;
      f = (f + t) | 0;
      b = (t + S0(c) + ((c & d) | (e & (c | d)))) | 0;
      t = (a + S1(f) + (h ^ (f & (g ^ h))) + K[i + 7] + w[i + 7]) | 0;
      e = (e + t) | 0;
      a = (t + S0(b) + ((b & c) | (d & (b | c)))) | 0;
    }
    a = (a + a0) | 0;
    b = (b + b0) | 0;
    c = (c + c0) | 0;
    d = (d + d0) | 0;
    e = (e + e0) | 0;
    f = (f + f0) | 0;
    g = (g + g0) | 0;
    h = (h + h0) | 0;
  }
  s[0] = a;
  s[1] = b;
  s[2] = c;
  s[3] = d;
  s[4] = e;
  s[5] = f;
  s[6] = g;
  s[7] = h;
}

export class Sha256 {
  private readonly h = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  /** The bytes of a block not complete yet. */
  private readonly tail = new Uint8Array(64);
  private tailLen = 0;
  private length = 0;

  update(data: ArrayBuffer | Uint8Array): this {
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    const n = src.length;
    this.length += n;
    let i = 0;
    if (this.tailLen > 0) {
      i = Math.min(64 - this.tailLen, n);
      this.tail.set(src.subarray(0, i), this.tailLen);
      this.tailLen += i;
      if (this.tailLen < 64) return this;
      blocks(this.h, this.tail, 0, 64);
      this.tailLen = 0;
    }
    const whole = i + ((n - i) & ~63);
    if (whole > i) blocks(this.h, src, i, whole);
    if (whole < n) {
      this.tail.set(src.subarray(whole));
      this.tailLen = n - whole;
    }
    return this;
  }

  /** The digest, as 32 bytes. Call once. */
  digest(): Uint8Array {
    const len = this.length;
    const padded = new Uint8Array(((this.tailLen + 9 + 63) >> 6) << 6);
    padded.set(this.tail.subarray(0, this.tailLen));
    padded[this.tailLen] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(len / 2 ** 29));
    view.setUint32(padded.length - 4, (len << 3) >>> 0);
    blocks(this.h, padded, 0, padded.length);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i]);
    return out;
  }
}

/** SHA-256 of `data` as 32 bytes. */
export function sha256(data: ArrayBuffer | Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}
