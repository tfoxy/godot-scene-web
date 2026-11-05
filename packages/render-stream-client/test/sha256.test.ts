import { describe, expect, it } from "vitest";
import { sha256 } from "../src/sha256";

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

describe("sha256 fallback", () => {
  it("matches the FIPS vectors", () => {
    expect(hex(sha256(enc("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(enc("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      hex(
        sha256(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(hex(sha256(enc("a".repeat(1_000_000))))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("agrees with crypto.subtle on random buffers of every padding length", async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed & 0xff;
    };
    const sizes = [...Array.from({ length: 130 }, (_, i) => i), 4096, 100003];
    for (const n of sizes) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = rnd();
      const want = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
      expect(hex(sha256(buf.buffer))).toBe(hex(want));
    }
  });
});
