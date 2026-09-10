import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWebgpuForTest,
  acquireWebgpuDevice,
  type WebgpuShared,
} from "../src/webgpu/device";
import {
  __resetWebgpuTextureCacheForTest,
  __webgpuTextureCacheKeysForTest,
  getBakedTextureGpu,
  getImageTextureGpu,
  imageTextureCacheKey,
} from "../src/webgpu/textures";
import {
  installWebgpuStub,
  type StubCall,
  type WebgpuStubHandle,
} from "./support/webgpu-stub";

let stub: WebgpuStubHandle | null = null;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// jsdom's `Image` never loads anything, so the decode half of the cache is driven by hand: every
// constructed image is recorded and `load(w, h)` fires the runtime's own `onload`.
class FakeImage {
  static instances: FakeImage[] = [];
  crossOrigin: string | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  src = "";
  constructor() {
    FakeImage.instances.push(this);
  }
  static last(): FakeImage {
    const image = FakeImage.instances.at(-1);
    if (!image) throw new Error("no Image was constructed");
    return image;
  }
  load(width: number, height: number): void {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }
}

let originalImage: typeof globalThis.Image;

async function withDevice(): Promise<WebgpuShared> {
  stub = installWebgpuStub();
  const shared = await acquireWebgpuDevice();
  if (!shared) throw new Error("expected the stub device");
  return shared;
}

const calls = (name: string): StubCall[] =>
  (stub?.calls ?? []).filter((call) => call.name === name);

function textureExtent(size: unknown): [number, number, number] {
  if (Array.isArray(size))
    return [
      size[0] as number,
      size[1] as number,
      (size[2] as number | undefined) ?? 1,
    ];
  const extent = size as {
    width: number;
    height: number;
    depthOrArrayLayers?: number;
  };
  return [extent.width, extent.height, extent.depthOrArrayLayers ?? 1];
}

beforeEach(() => {
  __resetWebgpuForTest();
  __resetWebgpuTextureCacheForTest();
  FakeImage.instances = [];
  originalImage = globalThis.Image;
  globalThis.Image = FakeImage as unknown as typeof globalThis.Image;
});

afterEach(() => {
  globalThis.Image = originalImage;
  stub?.uninstall();
  stub = null;
  __resetWebgpuTextureCacheForTest();
  __resetWebgpuForTest();
});

describe("cache keys are the SAME strings as the WebGL cache's", () => {
  it("builds an image key as `<clamp|repeat>:<url>`", () => {
    expect(imageTextureCacheKey("cards/glow.png", false)).toBe(
      "clamp:cards/glow.png",
    );
    expect(imageTextureCacheKey("cards/glow.png", true)).toBe(
      "repeat:cards/glow.png",
    );
  });

  it("still matches the literal `getImageTexture` builds in shared-gl (drift guard)", () => {
    // `shared-gl.ts` exports no key builder, so string-equality is proven from BOTH sides: the
    // assertion above pins this module's output, and this one pins the template the GL cache keys
    // with (`getImageTexture`, shared-gl.ts:318). If that line moves or changes shape, this fails
    // and the two caches stop being provably parallel.
    const source = readFileSync(
      resolve("packages/html/src/webgl/shared-gl.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /\$\{opts\.repeat \? "repeat" : "clamp"\}:\$\{url\}/,
    );
  });

  it("uses a baked key VERBATIM (the caller builds `particle-lut:{…}` for both caches)", async () => {
    const shared = await withDevice();
    // Exactly what `lutTextureFor` hands `getBakedTexture` on the GL side (particles/runtime.ts).
    const key = `particle-lut:${JSON.stringify({ kind: "gradient", width: 256 })}`;
    getBakedTextureGpu(shared, key, () => bakedLut());
    expect(__webgpuTextureCacheKeysForTest()).toEqual([key]);
  });

  it("keys an image entry under the url + repeat mode it was asked for", async () => {
    const shared = await withDevice();
    getImageTextureGpu(shared, "sprite.png");
    getImageTextureGpu(shared, "sprite.png", { repeat: true });
    expect(__webgpuTextureCacheKeysForTest()).toEqual([
      "clamp:sprite.png",
      "repeat:sprite.png",
    ]);
  });
});

describe("getImageTextureGpu: placeholder then loaded", () => {
  it("returns a 1x1 transparent placeholder immediately", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    expect(entry.loaded).toBe(false);
    expect(entry.width).toBe(1);
    expect(entry.height).toBe(1);
    expect(entry.listeners.size).toBe(0);
    const write = calls("queue.writeTexture")[0];
    expect(write.args[1]).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(FakeImage.last().crossOrigin).toBe("anonymous");
    expect(FakeImage.last().src).toBe("sprite.png");
  });

  it("uploads with STRAIGHT alpha on decode and reports the decoded size", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    FakeImage.last().load(64, 32);
    expect(entry.loaded).toBe(true);
    expect(entry.width).toBe(64);
    expect(entry.height).toBe(32);
    const copy = calls("queue.copyExternalImageToTexture")[0];
    // Premultiplication happens ONCE, in WGSL at fragment output — not here.
    expect(copy.args[1]).toMatchObject({ premultipliedAlpha: false });
    expect(copy.args[2]).toEqual([64, 32]);
    expect(calls("createTexture")[1].args[1]).toEqual([64, 32, 1]);
    expect(calls("createTexture")[1].args[2]).toBe("rgba8unorm");
  });

  it("fires listeners once on load and clears them", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    let fired = 0;
    entry.listeners.add(() => {
      fired += 1;
    });
    FakeImage.last().load(8, 8);
    expect(fired).toBe(1);
    expect(entry.listeners.size).toBe(0);
  });

  it("REPLACES texture and view on decode (a GPUTexture cannot be resized)", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    const placeholder = entry.texture;
    const placeholderView = entry.view;
    // The listener is the seam a consumer rebuilds its bind group in — so the new handles must
    // already be in place when it runs.
    let viewAtNotify: unknown;
    entry.listeners.add(() => {
      viewAtNotify = entry.view;
    });
    FakeImage.last().load(4, 4);
    expect(entry.texture).not.toBe(placeholder);
    expect(entry.view).not.toBe(placeholderView);
    expect(viewAtNotify).toBe(entry.view);
    expect((placeholder as unknown as { destroyed: boolean }).destroyed).toBe(
      true,
    );
  });

  it("hands the SAME entry to a second caller and uploads once", async () => {
    const shared = await withDevice();
    const first = getImageTextureGpu(shared, "sprite.png");
    const second = getImageTextureGpu(shared, "sprite.png");
    expect(second).toBe(first);
    expect(calls("createTexture")).toHaveLength(1);
    expect(FakeImage.instances).toHaveLength(1);
  });

  it("samples clamped-linear by default and repeat when asked", async () => {
    const shared = await withDevice();
    getImageTextureGpu(shared, "a.png");
    getImageTextureGpu(shared, "b.png", { repeat: true });
    const samplers = calls("createSampler").map(
      (call) => call.args[0] as GPUSamplerDescriptor,
    );
    expect(samplers[0]).toMatchObject({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    expect(samplers[1]).toMatchObject({
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    // Two entries, but a sampler per (filter, wrap) pair — not per texture.
    expect(samplers).toHaveLength(2);
    getImageTextureGpu(shared, "c.png");
    expect(calls("createSampler")).toHaveLength(2);
  });
});

describe("getBakedTextureGpu", () => {
  it("uploads baked pixels synchronously and is loaded on return", async () => {
    const shared = await withDevice();
    const entry = getBakedTextureGpu(shared, "particle-lut:x", () =>
      bakedLut(),
    );
    expect(entry.loaded).toBe(true);
    expect(entry.width).toBe(256);
    expect(entry.height).toBe(1);
    const write = calls("queue.writeTexture").at(-1);
    expect(write?.args[2]).toEqual({ bytesPerRow: 256 * 4, rowsPerImage: 1 });
    expect(textureExtent(write?.args[3])).toEqual([256, 1, 1]);
  });

  it("samples NEAREST for a CONSTANT-interpolation LUT (linear would smear each hard step)", async () => {
    const shared = await withDevice();
    getBakedTextureGpu(shared, "particle-lut:const", () => bakedLut(), {
      nearest: true,
    });
    expect(calls("createSampler")[0].args[0]).toMatchObject({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
    });
  });

  it("defaults to LINEAR for an interpolated ramp", async () => {
    const shared = await withDevice();
    getBakedTextureGpu(shared, "particle-lut:linear", () => bakedLut());
    expect(calls("createSampler")[0].args[0]).toMatchObject({
      magFilter: "linear",
    });
  });

  it("bakes once per key", async () => {
    const shared = await withDevice();
    let bakes = 0;
    const bake = () => {
      bakes += 1;
      return bakedLut();
    };
    const first = getBakedTextureGpu(shared, "particle-lut:x", bake);
    const second = getBakedTextureGpu(shared, "particle-lut:x", bake);
    expect(second).toBe(first);
    expect(bakes).toBe(1);
  });
});

describe("the cache lives and dies with the device", () => {
  it("is emptied (and its textures destroyed) when the device is lost", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    getBakedTextureGpu(shared, "particle-lut:x", () => bakedLut());
    expect(__webgpuTextureCacheKeysForTest()).toHaveLength(2);

    stub?.loseDevice();
    await flush();

    expect(__webgpuTextureCacheKeysForTest()).toEqual([]);
    expect((entry.texture as unknown as { destroyed: boolean }).destroyed).toBe(
      true,
    );
  });

  it("does not upload into a dead device when a pending image decodes late", async () => {
    const shared = await withDevice();
    const entry = getImageTextureGpu(shared, "sprite.png");
    let fired = 0;
    entry.listeners.add(() => {
      fired += 1;
    });
    stub?.loseDevice();
    await flush();
    const before = calls("queue.copyExternalImageToTexture").length;

    FakeImage.last().load(64, 64);

    expect(calls("queue.copyExternalImageToTexture")).toHaveLength(before);
    expect(entry.loaded).toBe(false);
    expect(fired).toBe(0);
  });

  it("starts clean on a NEW device generation", async () => {
    const shared = await withDevice();
    getImageTextureGpu(shared, "sprite.png");
    stub?.uninstall();
    __resetWebgpuForTest();

    const next = await withDevice();
    expect(next.device).not.toBe(shared.device);
    getImageTextureGpu(next, "other.png");
    expect(__webgpuTextureCacheKeysForTest()).toEqual(["clamp:other.png"]);
  });
});

function bakedLut(): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  return { width: 256, height: 1, data: new Uint8ClampedArray(256 * 4) };
}
