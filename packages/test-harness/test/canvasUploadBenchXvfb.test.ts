// @vitest-environment node
//
// WHAT AN EFFECT-CANVAS UPLOAD COSTS, on this box's real GPU.
//
// NOT PART OF ANY DEFAULT RUN. It is a measurement, not an assertion: the numbers
// move with the driver, the display and what else the machine is doing, so a
// threshold here would fail for reasons that are nobody's bug. It is skipped
// unless `GSW_CANVAS_UPLOAD_BENCH` is set — `pnpm bench:canvas-upload` sets it,
// along with the Xvfb wrapper and the flag that lets a `console.log` out of
// vitest's reporter.
//
// It prints a table and asserts only that the table exists. What it is FOR is
// choosing a per-frame upload budget: a consumer compositing `@godot-scene-web/
// html`'s per-node effect canvases into one stage has to decide how many
// megabytes of them it may upload before a frame goes late, and that number
// should come from this table rather than from a guess about texture bandwidth.
//
// HEADED, for `canvasPixelXvfb.test.ts`'s reason and more so here: headless gets
// SwiftShader, whose upload cost is a CPU memcpy and says nothing at all about
// what a GPU driver charges. The `renderer` line in the output is the receipt.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
// TYPE-ONLY: the entry writes to `window` at module scope (see the pixel test).
import type {
  UploadBenchResult,
  UploadBenchRow,
} from "../src/canvas-pixel/upload-bench-entry";

const here = dirname(fileURLToPath(import.meta.url));

const ENABLED = Boolean(
  process.env.GSW_CANVAS_UPLOAD_BENCH && process.env.DISPLAY,
);

function megapixels(row: UploadBenchRow): number {
  return (row.width * row.height) / 1e6;
}

/** The table, as markdown, so it can be pasted into a round note unchanged. */
function formatTable(result: UploadBenchResult): string {
  const lines: string[] = [];
  lines.push(`renderer: ${result.renderer || "(masked)"}`);
  lines.push(
    `MAX_TEXTURE_SIZE ${result.maxTextureSize}, devicePixelRatio ${result.devicePixelRatio}`,
  );
  lines.push(
    `crossOriginIsolated ${result.crossOriginIsolated}, clock resolution ${result.clockResolutionMs.toFixed(6)} ms`,
  );
  lines.push("");
  lines.push(
    "| size | Mpx | MB | placement | source | method | call ms | upload ms | upload p95 | ms/Mpx | sync ms | baseline ms |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of result.rows) {
    const mpx = megapixels(row);
    lines.push(
      `| ${row.width}x${row.height} | ${mpx.toFixed(2)} | ${(mpx * 4).toFixed(2)} | ` +
        `${row.placement} | ${row.freshness} | ${row.method} | ${row.callMs.toFixed(3)} | ` +
        `${row.uploadMs.toFixed(3)} | ${row.uploadP95Ms.toFixed(3)} | ` +
        `${(row.uploadMs / mpx).toFixed(3)} | ${row.syncMs.toFixed(3)} | ` +
        `${row.baselineMs.toFixed(3)} |`,
    );
  }
  return lines.join("\n");
}

describe.skipIf(!ENABLED)("canvas texture upload cost", () => {
  it("prices a 2D-canvas upload by size, path, placement and freshness", async () => {
    const bundleText = await bundleBenchEntry();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: false, args: [] });
      const page = await browser.newPage({
        viewport: { width: 400, height: 300 },
      });
      page.on("pageerror", (error) => {
        console.error(
          `upload-bench page error: ${error.stack ?? error.message}`,
        );
      });
      // COOP+COEP, which is the whole reason this file serves its own headers.
      // Outside a cross-origin-isolated page `performance.now()` is quantised to
      // 100 microseconds, and a 14 MB texture upload on a discrete GPU lands
      // UNDER that — every cell reads either 0.0 or 0.1 ms and the table says
      // nothing. Isolated, the clock resolves 5 microseconds. `crossOriginIsolated`
      // comes back in the result so a run that silently lost it is obvious.
      await page.route("**/*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
          body: "<!doctype html><html><body></body></html>",
        }),
      );
      await page.goto("http://localhost/gsw-canvas-upload-bench");
      await page.addScriptTag({ content: bundleText, type: "module" });
      await page.waitForFunction(
        () => "__gswCanvasUploadBench" in window,
        undefined,
        { timeout: 15000 },
      );
      const result = await page.evaluate(() =>
        window.__gswCanvasUploadBench.run(),
      );
      console.log(`\n${formatTable(result)}\n`);
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.samples).toBeGreaterThanOrEqual(20);
      }
    } finally {
      await browser?.close();
    }
  }, 600000);
});

/** The pixel suite's bundling recipe, with `conditions: ["development"]` so the
 *  page runs `@godot-scene-web/canvas`'s SOURCE rather than a stale `dist/`. */
async function bundleBenchEntry(): Promise<string> {
  const entry = join(
    here,
    "..",
    "src",
    "canvas-pixel",
    "upload-bench-entry.ts",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
    conditions: ["development"],
    write: false,
    sourcemap: "inline",
    absWorkingDir: join(here, ".."),
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error("upload-bench: esbuild produced no output for the entry");
  }
  return file.text;
}
