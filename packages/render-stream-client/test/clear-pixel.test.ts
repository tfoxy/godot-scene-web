// @vitest-environment node
// Opt in with GSW_STREAM_CLEAR_PIXEL=1. Build the production wasm locally, offline, first:
// experiments/render-stream/scripts/build-rs-core.sh --wasm-only
// Like the test-harness Rust pixel tests, this opens headless Chromium and reads executor bytes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const enabled = process.env.GSW_STREAM_CLEAR_PIXEL === "1";

/** A resource-free rectangle over the unchanged golden session's host clear colour. */
async function recording(): Promise<string> {
  const dir = join(root, "experiments/render-stream/protocol/golden-6");
  const original = await readFile(join(dir, "full.rs6"));
  const decoded = JSON.parse(
    await readFile(join(dir, "full.decoded.json"), "utf8"),
  );
  const tx = decoded.records.find(
    (r: { meta: { type: string } }) => r.meta.type === "transaction",
  ).meta;
  tx.unsupported = [];
  tx.canvases[0].items = [1];
  tx.items = [tx.items[0]];
  tx.items[0].commands = [{ op: "add_rect", aa: false, f: 0 }];
  tx.textures = [];
  const floats: Record<string, number[]> = {
    item_f32: [1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    canvas_f32: [1, 0, 0, 1, 0, 0, 1, 1, 1, 1],
    cmd_f32: [0, 0, 4, 4, 1, 0.5, 0.25, 0.5],
  };
  const blocks = tx.blocks.map((b: { name: string; count: number }) => {
    const values = floats[b.name] ?? [];
    b.count = values.length;
    return Buffer.from(new Float32Array(values).buffer);
  });
  const u32 = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(n);
    return out;
  };
  const meta = Buffer.from(JSON.stringify(tx));
  const body = Buffer.concat([
    u32(meta.length),
    meta,
    u32(blocks.length),
    ...blocks.flatMap((b: Buffer) => [u32(b.length), b]),
  ]);
  const sessionEnd = 12 + original.readUInt32LE(8);
  return Buffer.concat([
    original.subarray(0, sessionEnd),
    u32(body.length),
    body,
  ]).toString("base64");
}

it.skipIf(!enabled)(
  "reads transparent clear and 50% coverage through the production executor",
  async () => {
    const wasmDir = join(root, "artifacts/render-stream/rs-core/latest/gsw-rs");
    const bundle = await build({
      entryPoints: [
        join(root, "experiments/render-stream/web/client-options-probe.ts"),
      ],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["development"],
      write: false,
    });
    const env = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--enable-gpu",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--force-color-profile=srgb",
      ],
      env,
      timeout: 20000,
    });
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => console.error(error));
      await page.route("**/*", async (route) => {
        const name = new URL(route.request().url()).pathname;
        if (name.startsWith("/rust/"))
          return route.fulfill({
            contentType: name.endsWith(".wasm")
              ? "application/wasm"
              : "text/javascript",
            body: await readFile(join(wasmDir, name.slice(6))),
          });
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        });
      });
      await page.goto("http://127.0.0.1:19762/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.addScriptTag({
        content: bundle.outputFiles[0].text,
        type: "module",
      });
      await page.waitForFunction(() => !!window.clientOptionsProbe);
      const data = await recording();
      const run = (transparentClear?: boolean) =>
        page.evaluate((input) => window.clientOptionsProbe(input), {
          recording: data,
          transparentClear,
        });
      const off = await run();
      const explicitOff = await run(false);
      const on = await run(true);
      expect(explicitOff.pixelsSha256).toBe(off.pixelsSha256);
      for (const result of [off, explicitOff, on]) {
        expect(result.glError).toBe(0);
        expect(result.attributes).toMatchObject({
          alpha: true,
          premultipliedAlpha: true,
        });
      }
      expect(off.clear).toEqual([64, 64, 128, 255]);
      expect(on.clear).toEqual([0, 0, 0, 0]);
      const half = on.half;
      console.log(
        `executor RGBA8 bytes: off clear=${off.clear}, transparent clear=${on.clear}, half=${half}`,
      );
      expect(Math.abs(half[3] / 255 - 0.5)).toBeLessThanOrEqual(1 / 255);
      expect(half.slice(0, 3).every((v) => v <= half[3])).toBe(true);
    } finally {
      await browser.close();
    }
  },
  120000,
);
