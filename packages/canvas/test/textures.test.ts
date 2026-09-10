import { describe, expect, it } from "vitest";
import type { CanvasTextureSource } from "../src/textures";
import { createTextureCache } from "../src/textures";
import { createFakeGl, type FakeGl } from "./fake-gl";

/** A stand-in for a decoded `ImageBitmap`: the cache only reads its dimensions
 *  and hands the object to `texImage2D`. */
function bitmap(width: number, height: number): CanvasTextureSource {
  return { width, height } as unknown as CanvasTextureSource;
}

/** `pixelStorei` settings in force at the Nth `texImage2D`. */
function unpackStateAt(fake: FakeGl, uploadIndex: number) {
  const state = new Map<number, unknown>();
  let seen = 0;
  for (const call of fake.calls) {
    if (call.name === "pixelStorei")
      state.set(call.args[0] as number, call.args[1]);
    if (call.name === "texImage2D") {
      if (seen === uploadIndex) return state;
      seen += 1;
    }
  }
  return state;
}

describe("texture cache uploads", () => {
  it("uploads PREMULTIPLIED and un-flipped", () => {
    // Premultiplied so LINEAR filtering blends coverage-weighted colour (a
    // straight-alpha upload fringes every sprite edge and bleeds atlas padding);
    // un-flipped so image row 0 is V=0, which is the origin the draw-list's
    // page-pixel source rects are measured from.
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("card.png", bitmap(256, 128));
    const unpack = unpackStateAt(fake, 0);
    expect(unpack.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(true);
    expect(unpack.get(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false);
    expect(unpack.get(gl.UNPACK_ALIGNMENT)).toBe(4);
  });

  it("does not premultiply a source that already carries rgb times alpha", () => {
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("premultiplied-bitmap", bitmap(4, 4), {
      premultiplied: true,
    });
    expect(unpackStateAt(fake, 0).get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(
      false,
    );
  });

  it("clamps and filters linearly, with no mipmaps", () => {
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("card.png", bitmap(4, 4));
    const params = fake
      .named("texParameteri")
      .map((call) => [call.args[1], call.args[2]]);
    expect(params).toContainEqual([gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE]);
    expect(params).toContainEqual([gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]);
    expect(params).toContainEqual([gl.TEXTURE_MIN_FILTER, gl.LINEAR]);
    expect(fake.named("generateMipmap")).toHaveLength(0);
  });

  it("reads the size from whichever property the source carries", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    expect(cache.acquire("bitmap", bitmap(300, 200))).toMatchObject({
      width: 300,
      height: 200,
    });
    const image = {
      naturalWidth: 64,
      naturalHeight: 32,
      width: 0,
      height: 0,
    } as unknown as CanvasTextureSource;
    expect(cache.acquire("image", image)).toMatchObject({
      width: 64,
      height: 32,
    });
  });

  it("premultiplies BYTE uploads in JS rather than trusting the unpack flag", () => {
    // `UNPACK_PREMULTIPLY_ALPHA_WEBGL` over an ArrayBufferView is not worth
    // depending on, and a test that cannot see the bytes cannot tell.
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquireBytes(
      "swatch",
      new Uint8Array([255, 128, 0, 128, 255, 255, 255, 255]),
      2,
      1,
    );
    const upload = fake.named("texImage2D")[0];
    expect([...(upload.args[8] as Uint8Array)]).toEqual([
      128, 64, 0, 128, 255, 255, 255, 255,
    ]);
    expect(unpackStateAt(fake, 0).get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(
      false,
    );
  });

  it("takes already-premultiplied bytes verbatim", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquireBytes("swatch", new Uint8Array([10, 20, 30, 40]), 1, 1, {
      premultiplied: true,
    });
    expect([...(fake.named("texImage2D")[0].args[8] as Uint8Array)]).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it("uses the exact integer premultiply identity for every byte pair without changing input", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    const pixels = new Uint8Array(256 * 256 * 4);
    for (let alpha = 0; alpha < 256; alpha += 1) {
      for (let channel = 0; channel < 256; channel += 1) {
        const i = (alpha * 256 + channel) * 4;
        pixels[i] = channel;
        pixels[i + 1] = channel;
        pixels[i + 2] = channel;
        pixels[i + 3] = alpha;
      }
    }
    cache.acquireBytes("all-byte-pairs", pixels, 256, 256);
    const uploaded = fake.named("texImage2D")[0].args[8] as Uint8Array;
    let mismatch = -1;
    for (let alpha = 0; alpha < 256; alpha += 1) {
      for (let channel = 0; channel < 256; channel += 1) {
        const i = (alpha * 256 + channel) * 4;
        const t = channel * alpha + 0x80;
        const value = (t + (t >> 8)) >> 8;
        if (
          pixels[i] !== channel ||
          pixels[i + 1] !== channel ||
          pixels[i + 2] !== channel ||
          pixels[i + 3] !== alpha ||
          uploaded[i] !== value ||
          uploaded[i + 1] !== value ||
          uploaded[i + 2] !== value ||
          uploaded[i + 3] !== alpha
        ) {
          mismatch = i;
          break;
        }
      }
      if (mismatch !== -1) break;
    }
    expect(mismatch).toBe(-1);
  });
});

describe("texture cache samplers", () => {
  it("generates mips, accounts for their full chain, and permits NEAREST magnification", () => {
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("mipped", bitmap(4, 4), {
      mipmap: true,
      magFilter: gl.NEAREST,
    });
    expect(cache.stats.bytes).toBe((16 + 4 + 1) * 4);
    expect(fake.named("generateMipmap")).toHaveLength(1);
    expect(fake.named("texParameteri")).toContainEqual({
      name: "texParameteri",
      args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR],
    });
    expect(fake.named("texParameteri")).toContainEqual({
      name: "texParameteri",
      args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    });
    cache.update("mipped", bitmap(4, 4));
    expect(fake.named("generateMipmap")).toHaveLength(2);
    fake.reset();
    expect(cache.updateRegion("mipped", bitmap(1, 1), 0, 0)).toBe(null);
    expect(fake.calls).toEqual([]);
    cache.release("mipped");
    expect(cache.stats.bytes).toBe(0);
  });

  it("accounts for every NPOT level and reaccounts after a full update", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("npot", bitmap(5, 3), { mipmap: true });
    // 5x3, 2x1, 1x1.
    expect(cache.stats.bytes).toBe((15 + 2 + 1) * 4);
    cache.update("npot", bitmap(3, 2));
    // 3x2, 1x1. A changed size is a deliberate re-spec and a fresh chain.
    expect(cache.stats.bytes).toBe((6 + 1) * 4);
    expect(cache.stats.respecs).toBe(2);
    expect(fake.named("generateMipmap")).toHaveLength(2);
    cache.release("npot");
    expect(cache.stats.bytes).toBe(0);
  });

  it("does not generate a mipmap for zero-sized storage, then does after a real update", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("parked-mipped", bitmap(0, 0), { mipmap: true });
    expect(fake.named("generateMipmap")).toHaveLength(0);
    cache.update("parked-mipped", bitmap(1, 1));
    expect(fake.named("generateMipmap")).toHaveLength(1);
  });
});

describe("texture cache lifetime", () => {
  it("decodes once per key and refcounts the rest", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    const first = cache.acquire("card.png", bitmap(4, 4));
    const second = cache.acquire("card.png", bitmap(4, 4));
    expect(second).toBe(first);
    expect(cache.stats.uploads).toBe(1);

    cache.release("card.png");
    expect(fake.named("deleteTexture")).toHaveLength(0);
    expect(cache.peek("card.png")).toBe(first);
    cache.release("card.png");
    expect(fake.named("deleteTexture")).toHaveLength(1);
    expect(cache.peek("card.png")).toBeUndefined();
    expect(cache.stats.entries).toBe(0);
    expect(cache.stats.evictions).toBe(1);
  });

  it("tracks resident bytes as entries come and go", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("a", bitmap(100, 50));
    expect(cache.stats.bytes).toBe(100 * 50 * 4);
    cache.acquire("b", bitmap(10, 10));
    expect(cache.stats.bytes).toBe(100 * 50 * 4 + 400);
    cache.release("a");
    expect(cache.stats.bytes).toBe(400);
  });

  it("re-uploads through update, keeping the refcount and re-measuring", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    const handle = cache.acquire("label", bitmap(64, 16));
    cache.acquire("label", bitmap(64, 16));
    const updated = cache.update("label", bitmap(96, 16));
    expect(updated).toBe(handle);
    expect(updated.width).toBe(96);
    expect(cache.stats.uploads).toBe(2);
    expect(cache.stats.bytes).toBe(96 * 16 * 4);
    cache.release("label");
    cache.release("label");
    expect(cache.stats.entries).toBe(0);
  });
});

// `update` is the streaming entry point: ONE key, a new frame of the same surface
// on it every tick. A re-spec per frame would free and reallocate the mip level
// each time to write exactly the same number of texels, so the same-size case has
// to go in over the storage that is already there.
describe("texture cache re-upload fast path", () => {
  it("re-uploads a same-size source with texSubImage2D, sparing the re-spec", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("fx://glow", bitmap(256, 128));
    fake.reset();

    const again = cache.update("fx://glow", bitmap(256, 128));
    expect(fake.named("texImage2D")).toHaveLength(0);
    const sub = fake.named("texSubImage2D");
    expect(sub).toHaveLength(1);
    // Whole level, from its origin: (target, level, xoffset, yoffset, …).
    expect(sub[0].args.slice(0, 4)).toEqual([fake.gl.TEXTURE_2D, 0, 0, 0]);
    // The size claim is unchanged, so no byte accounting moved either.
    expect(again).toMatchObject({ width: 256, height: 128 });
    expect(cache.stats.bytes).toBe(256 * 128 * 4);
    // It is still an upload; what it is not is a re-spec.
    expect(cache.stats.uploads).toBe(2);
    expect(cache.stats.respecs).toBe(1);
    // Sampler parameters live on the texture object and nothing here changed
    // them, so the fast path does not restate them.
    expect(fake.named("texParameteri")).toHaveLength(0);
  });

  it("keeps the PREMULTIPLIED, un-flipped unpack state on the fast path", () => {
    // The one thing a second upload path can silently get wrong: the same pixels
    // arriving straight instead of premultiplied, which nothing errors on and
    // which shows up as dark fringes three screens later.
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("fx://glow", bitmap(64, 64));
    fake.reset();
    cache.update("fx://glow", bitmap(64, 64));

    const unpack = new Map<number, unknown>();
    for (const call of fake.calls) {
      if (call.name === "pixelStorei")
        unpack.set(call.args[0] as number, call.args[1]);
      if (call.name === "texSubImage2D") break;
    }
    expect(unpack.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(true);
    expect(unpack.get(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false);
  });

  it("re-specifies when the source changes size, and again when it changes back", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("fx://glow", bitmap(256, 128));
    cache.update("fx://glow", bitmap(256, 64)); // shorter: re-spec
    cache.update("fx://glow", bitmap(256, 64)); // settled: fast path
    expect(cache.stats.respecs).toBe(2);
    expect(cache.stats.uploads).toBe(3);
    expect(fake.named("texSubImage2D")).toHaveLength(1);
    expect(cache.stats.bytes).toBe(256 * 64 * 4);
  });

  it("re-specifies an entry it had to create, and streams from then on", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    // `update` on an absent key still creates the entry (with one reference).
    cache.update("fx://spark", bitmap(32, 32));
    expect(fake.named("texImage2D")).toHaveLength(1);
    cache.update("fx://spark", bitmap(32, 32));
    cache.update("fx://spark", bitmap(32, 32));
    expect(cache.stats.respecs).toBe(1);
    expect(fake.named("texSubImage2D")).toHaveLength(2);
    cache.release("fx://spark");
    expect(cache.stats.entries).toBe(0);
  });

  it("does NOT stream into storage a zero-sized source never allocated", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    // A source reporting 0x0 — a parked effect canvas — is RECORDED as 1x1,
    // because that is what a UV divide needs, over a level GL specified from
    // nothing.
    cache.acquire("fx://parked", bitmap(0, 0));
    expect(cache.peek("fx://parked")).toMatchObject({ width: 1, height: 1 });
    // The wake-up frame really is 1x1. Tested against the CLAIM this looks like
    // a match and streams a texel into a level that has none; tested against the
    // storage it re-specifies, which is the only thing that can be right.
    cache.update("fx://parked", bitmap(1, 1));
    expect(fake.named("texSubImage2D")).toHaveLength(0);
    expect(fake.named("texImage2D")).toHaveLength(2);
  });

  it("does not confuse a BYTE entry's storage with a source of the same claim", () => {
    // `acquireBytes` specifies its own storage, so a later same-size source
    // update over it is a legitimate fast path — and a different size is not.
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquireBytes("swatch", new Uint8Array([1, 2, 3, 4]), 1, 1, {
      premultiplied: true,
    });
    fake.reset();
    cache.update("swatch", bitmap(1, 1));
    expect(fake.named("texSubImage2D")).toHaveLength(1);
    cache.update("swatch", bitmap(2, 1));
    expect(fake.named("texImage2D")).toHaveLength(1);
  });

  it("throws on a retain of something it never had", () => {
    const cache = createTextureCache(createFakeGl().gl);
    expect(() => cache.retain("missing")).toThrow(/unknown key/);
  });

  it("hands out ONE white texel, uploaded once", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    expect(cache.white()).toBe(cache.white());
    expect(cache.white()).toMatchObject({ width: 1, height: 1 });
    expect(fake.named("texImage2D")).toHaveLength(1);
    expect([...(fake.named("texImage2D")[0].args[8] as Uint8Array)]).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it("forgets everything on reset WITHOUT calling the dead context", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("a", bitmap(4, 4));
    cache.white();
    cache.reset();
    expect(fake.named("deleteTexture")).toHaveLength(0);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.stats.entries).toBe(0);
    expect(cache.stats.bytes).toBe(0);
    // The next acquire rebuilds on the restored context.
    cache.acquire("a", bitmap(4, 4));
    expect(cache.stats.entries).toBe(1);
  });

  it("deletes everything on dispose, including the white texel", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("a", bitmap(4, 4));
    cache.acquire("b", bitmap(4, 4));
    cache.white();
    cache.dispose();
    expect(fake.named("deleteTexture")).toHaveLength(3);
    expect(cache.stats.entries).toBe(0);
  });
});

// A PAGE is one texture that many small sources are written into over its life: a
// label atlas, a sprite sheet baked at runtime. `update` cannot serve that — it
// replaces the whole thing, so one 40x18 label landing on a 1024x1024 page would
// re-upload four megabytes to change seven hundred texels. `updateRegion` writes
// only what changed, and its entire risk surface is the RECT: a write that runs
// off the page is a silent `INVALID_VALUE` on the context, which the caller never
// sees and the next frame cannot explain. So every refusal below is asserted for
// making NO DRIVER CALL AT ALL, not merely for answering null.
describe("texture cache region writes", () => {
  /** Every call that could have touched the driver's texture state. */
  function glTouches(fake: FakeGl): string[] {
    return fake.calls
      .map((call) => call.name)
      .filter((name) => name !== "bindTexture" && name !== "pixelStorei");
  }

  it("writes one region into existing storage — no re-spec, no re-configure", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquireBytes("txp://0", new Uint8Array(64 * 64 * 4), 64, 64, {
      premultiplied: true,
    });
    fake.reset();

    const handle = cache.updateRegion("txp://0", bitmap(40, 18), 8, 24);
    const sub = fake.named("texSubImage2D");
    expect(sub).toHaveLength(1);
    // (target, level, xoffset, yoffset, …) — the caller's offset, verbatim.
    expect(sub[0].args.slice(0, 4)).toEqual([fake.gl.TEXTURE_2D, 0, 8, 24]);
    expect(fake.named("texImage2D")).toHaveLength(0);
    expect(fake.named("texParameteri")).toHaveLength(0);
    // The PAGE's dimensions come back, not the region's: that is what a UV divide
    // needs, and a caller writing a region already knows its own rect.
    expect(handle).toMatchObject({ width: 64, height: 64 });
    expect(cache.stats.uploads).toBe(2);
    expect(cache.stats.respecs).toBe(1);
    // Refcount and byte accounting belong to the ALLOCATION, which did not move.
    expect(cache.stats.bytes).toBe(64 * 64 * 4);
    cache.release("txp://0");
    expect(cache.stats.entries).toBe(0);
  });

  it("keeps the PREMULTIPLIED, un-flipped unpack state — the same contract as every other upload", () => {
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("txp://0", bitmap(128, 128));
    fake.reset();
    cache.updateRegion("txp://0", bitmap(16, 16), 0, 0);

    const unpack = new Map<number, unknown>();
    for (const call of fake.calls) {
      if (call.name === "pixelStorei")
        unpack.set(call.args[0] as number, call.args[1]);
      if (call.name === "texSubImage2D") break;
    }
    expect(unpack.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(true);
    expect(unpack.get(gl.UNPACK_FLIP_Y_WEBGL)).toBe(false);
  });

  it("packs many regions into ONE allocation — the whole reason this exists", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquireBytes("txp://0", new Uint8Array(256 * 256 * 4), 256, 256, {
      premultiplied: true,
    });
    for (let i = 0; i < 12; i++) {
      expect(cache.updateRegion("txp://0", bitmap(32, 16), 0, i * 16)).not.toBe(
        null,
      );
    }
    expect(fake.named("texImage2D")).toHaveLength(1);
    expect(fake.named("texSubImage2D")).toHaveLength(12);
    expect(cache.stats.respecs).toBe(1);
    expect(cache.stats.bytes).toBe(256 * 256 * 4);
  });

  it("refuses an unknown key without touching the driver", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    fake.reset();
    expect(cache.updateRegion("txp://never", bitmap(4, 4), 0, 0)).toBe(null);
    expect(glTouches(fake)).toEqual([]);
    expect(cache.stats.uploads).toBe(0);
  });

  it("refuses a rect that runs off the page — every edge, and negative origins", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("txp://0", bitmap(64, 64));
    fake.reset();

    expect(cache.updateRegion("txp://0", bitmap(8, 8), 57, 0)).toBe(null); // right
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 0, 57)).toBe(null); // bottom
    expect(cache.updateRegion("txp://0", bitmap(8, 8), -1, 0)).toBe(null); // left
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 0, -1)).toBe(null); // top
    expect(cache.updateRegion("txp://0", bitmap(65, 1), 0, 0)).toBe(null); // wider than the page
    expect(glTouches(fake)).toEqual([]);
    expect(cache.stats.uploads).toBe(1); // the acquire's, and nothing since

    // …and the exact-fit corner IS allowed: the refusal is `>`, not `>=`.
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 56, 56)).not.toBe(null);
    expect(fake.named("texSubImage2D")).toHaveLength(1);
  });

  it("refuses a fractional or non-finite offset rather than letting GL round it", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("txp://0", bitmap(64, 64));
    fake.reset();
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 1.5, 0)).toBe(null);
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 0, Number.NaN)).toBe(
      null,
    );
    expect(glTouches(fake)).toEqual([]);
  });

  it("refuses a zero-sized source, and storage that was never really allocated", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("txp://0", bitmap(64, 64));
    // Nothing to write: a 0-wide source uploads no texels, and clamping it up to
    // 1 would claim a texel it never wrote.
    expect(cache.updateRegion("txp://0", bitmap(0, 8), 0, 0)).toBe(null);

    // `update`'s zero-size trap, restated for regions: an entry made from a 0x0
    // source CLAIMS 1x1 over a level GL specified from nothing, so a 1x1 region
    // write into it would be a sub-image past the end of a level that is not
    // there. The test is against `storageW`, never against the claim.
    cache.acquire("txp://parked", bitmap(0, 0));
    expect(cache.peek("txp://parked")).toMatchObject({ width: 1, height: 1 });
    fake.reset();
    expect(cache.updateRegion("txp://parked", bitmap(1, 1), 0, 0)).toBe(null);
    expect(glTouches(fake)).toEqual([]);
  });

  it("is dead after a reset — a lost context's entries are gone, not writable", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    cache.acquire("txp://0", bitmap(64, 64));
    cache.reset();
    fake.reset();
    expect(cache.updateRegion("txp://0", bitmap(8, 8), 0, 0)).toBe(null);
    expect(glTouches(fake)).toEqual([]);
  });
});
