import { readTexturePixels } from "@godot-scene-web/canvas-effects/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWebgpuForTest,
  acquireWebgpuDevice,
  type WebgpuShared,
} from "../src/webgpu/device";
import {
  installWebgpuStub,
  type WebgpuStubHandle,
} from "./support/webgpu-stub";

let stub: WebgpuStubHandle | null = null;

async function withDevice(): Promise<WebgpuShared> {
  stub = installWebgpuStub();
  const shared = await acquireWebgpuDevice();
  if (!shared) throw new Error("expected the stub device");
  return shared;
}

beforeEach(() => {
  __resetWebgpuForTest();
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  __resetWebgpuForTest();
});

describe("readTexturePixels", () => {
  it("pads bytesPerRow to 256 and strips the padding back out", async () => {
    const shared = await withDevice();
    // 3 px wide = 12 bytes of real pixels per row, which is not a legal `bytesPerRow`.
    const width = 3;
    const height = 2;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i + 1;
    const texture = shared.device.createTexture({
      size: [width, height, 1],
      format: "rgba8unorm",
      usage: 0x01,
    });
    (texture as unknown as { pixels: Uint8Array }).pixels = pixels;

    const read = await readTexturePixels(shared, texture, width, height);

    expect(read).toEqual(pixels);
    const copy = (stub?.calls ?? []).find(
      (call) => call.name === "encoder.copyTextureToBuffer",
    );
    expect(copy?.args[1]).toMatchObject({ bytesPerRow: 256, rowsPerImage: 2 });
    expect(copy?.args[2]).toEqual([width, height, 1]);
  });

  it("allocates a padded staging buffer, maps it for READ and destroys it", async () => {
    const shared = await withDevice();
    const texture = shared.device.createTexture({
      size: [70, 4, 1],
      format: "rgba8unorm",
      usage: 0x01,
    });
    (texture as unknown as { pixels: Uint8Array }).pixels = new Uint8Array(
      70 * 4 * 4,
    );

    const read = await readTexturePixels(shared, texture, 70, 4);

    expect(read).toHaveLength(70 * 4 * 4);
    // 70 px = 280 bytes/row, padded to 512.
    const staging = stub?.buffers.at(-1);
    expect(staging?.size).toBe(512 * 4);
    // COPY_DST | MAP_READ — the only two usages a readback buffer may combine.
    expect(staging?.usage).toBe(0x0008 | 0x0001);
    expect(staging?.destroyed).toBe(true);
    const names = (stub?.calls ?? []).map((call) => call.name);
    expect(names).toContain("buffer.mapAsync");
    expect(names.indexOf("queue.submit")).toBeLessThan(
      names.indexOf("buffer.mapAsync"),
    );
    expect(names.indexOf("buffer.unmap")).toBeLessThan(
      names.indexOf("buffer.destroy"),
    );
  });
});
