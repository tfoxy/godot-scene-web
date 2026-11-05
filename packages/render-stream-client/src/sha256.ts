// Pure-JS SHA-256 (FIPS 180-4), the loader's fallback where `crypto.subtle` is missing: it exists
// only in secure contexts, so a plain-http LAN page has none (CAR8). Used only then.
//
// Incremental, so that the loader can hash the core in chunks and yield between them: on a moto
// g31 the 2.5 MB core takes 250-310 ms in one call (720 ms at 4x CPU throttle), a main-thread
// block no deadline could interrupt.

const K = new Uint32Array(64);
{
  let n = 0;
  for (let c = 2; n < 64; c++) {
    let prime = true;
    for (let d = 2; d * d <= c; d++) if (c % d === 0) prime = false;
    if (prime) K[n++] = (Math.cbrt(c) % 1) * 2 ** 32;
  }
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  /** The bytes of a block not complete yet. */
  private readonly tail = new Uint8Array(64);
  private readonly tailView = new DataView(this.tail.buffer);
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
      this.block(this.tailView, 0);
      this.tailLen = 0;
    }
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (; i + 64 <= n; i += 64) this.block(view, i);
    if (i < n) {
      this.tail.set(src.subarray(i));
      this.tailLen = n - i;
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
    for (let off = 0; off < padded.length; off += 64) this.block(view, off);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i]);
    return out;
  }

  private block(view: DataView, off: number): void {
    const h = this.h;
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        hh +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        ((e & f) ^ (~e & g)) +
        K[i] +
        w[i];
      const t2 =
        (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
}

/** SHA-256 of `data` as 32 bytes. */
export function sha256(data: ArrayBuffer | Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}
