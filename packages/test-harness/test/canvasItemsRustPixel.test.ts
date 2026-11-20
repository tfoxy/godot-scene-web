// @vitest-environment node
//
// THE RUST `canvas-items` EXECUTOR, BYTE-IDENTICAL TO THE TYPESCRIPT EXECUTOR, ON A REAL GPU.
//
// Every case of `../src/canvas-pixel/canvas-items-cases` is drawn twice in one page: as a packed
// `PDL1` list through `packages/canvas/rust-prototype`'s `canvas-items` executor (the
// `canvas-items-test` wasm module), and as the equivalent `@godot-scene-web/canvas` DrawList
// through the TypeScript executor into the canvas package's `StageTarget`. Per frame, every byte must agree:
//   - the shot: Rust `read_target` == TypeScript `StageTarget.readPixels` (RGBA8 readback of the
//     RGB10_A2 or RGBA8 target), alpha included;
//   - the presentation: the Rust canvas after its blit == the TypeScript canvas after `blit()`;
//   - compositor-equals-readback: the Rust canvas == the Rust shot.
// Plus draw-count parity (calls issued == `merged_draw_count()` == the spec's own count) and, on
// transform-only frames, zero vertex and index bytes with exactly the changed item rows uploaded.
//
// THE SABOTAGES must each fail at least one case: `drop-draws` (every second merged call skipped)
// and `stale-item-row` (dirty item rows not uploaded). They are run here too, inverted.
//
// LAUNCH: `--headless=new --enable-gpu --use-angle=vulkan`, DISPLAY and WAYLAND_DISPLAY removed:
// the real GPU, no window, never headed, never Xvfb (Xvfb does not contain a headed Chromium
// under Wayland).
// Opt in with GSW_CANVAS_ITEMS_PIXEL=1. The wasm is built first by
// `packages/canvas/rust-prototype/scripts/build-canvas-items-test.sh` (cargo, offline, incremental).
//
// Artifacts (never committed): `artifacts/canvas-items-pixel/<case>-f<frame>-{rust,ts}.png`.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCases,
  buildDamageCases,
  caseByName,
  changedItems,
  expectedDrawCalls,
} from "../src/canvas-pixel/canvas-items-cases";
// TYPE-ONLY: the entry writes to `window` at module scope.
import type { ItemsCaseResult } from "../src/canvas-pixel/canvas-items-entry";
import { compareRgbaBuffers } from "../src/image-diff";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const ARTIFACTS = join(ROOT, "artifacts", "canvas-items-pixel");
const WASM = join(ARTIFACTS, "wasm");
const BUILD = join(
  ROOT,
  "packages",
  "canvas",
  "rust-prototype",
  "scripts",
  "build-canvas-items-test.sh",
);
const ENABLED = process.env.GSW_CANVAS_ITEMS_PIXEL === "1";
const CASES = buildCases().map((c) => c.name);

interface Diff {
  differingBytes: number;
  maxDelta: number;
  worst: string;
}

/** Every byte, alpha included (pixelmatch cannot see a wrong alpha convention). */
function byteDiff(
  expected: readonly number[],
  actual: readonly number[],
  width: number,
): Diff {
  let differingBytes = 0;
  let maxDelta = 0;
  let worst = "";
  if (expected.length !== actual.length) {
    return {
      differingBytes: Math.max(expected.length, actual.length),
      maxDelta: 255,
      worst: `length ${expected.length} vs ${actual.length}`,
    };
  }
  for (let i = 0; i < expected.length; i += 1) {
    const delta = Math.abs(expected[i] - actual[i]);
    if (delta === 0) continue;
    differingBytes += 1;
    if (delta > maxDelta) {
      maxDelta = delta;
      const pixel = i >> 2;
      worst = `(${pixel % width},${Math.floor(pixel / width)}) ch${i & 3} expected ${expected[i]} got ${actual[i]}`;
    }
  }
  return { differingBytes, maxDelta, worst };
}

async function png(
  name: string,
  data: readonly number[],
  width: number,
  height: number,
): Promise<void> {
  await sharp(Buffer.from(Uint8Array.from(data)), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toFile(join(ARTIFACTS, `${name}.png`));
}

let browser: Browser;
let page: Page;

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [
      join(here, "..", "src", "canvas-pixel", "canvas-items-entry.ts"),
    ],
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
  if (!file) throw new Error("canvas-items: esbuild produced no output");
  return file.text;
}

async function run(
  name: string,
  sabotage = "",
  contextLoss = false,
): Promise<ItemsCaseResult> {
  const result = await page.evaluate(
    ([caseName, mode, loss]) =>
      window.__gswCanvasItems.run(caseName, mode, loss),
    [name, sabotage, contextLoss] as [string, string, boolean],
  );
  expect(result.tsGlError, `${name}: TypeScript gl.getError()`).toBe(0);
  expect(result.rustGlError, `${name}: Rust gl.getError()`).toBe(0);
  return result;
}

interface Verdict {
  shot: Diff;
  canvas: Diff;
  readback: Diff;
  drawCalls: number;
  expectedCalls: number;
  merged: number;
}

function judge(name: string, result: ItemsCaseResult): Verdict[] {
  const spec = caseByName(name);
  return result.frames.map((frame) => ({
    shot: byteDiff(frame.tsTarget, frame.rustTarget, result.width),
    canvas: byteDiff(frame.tsCanvas, frame.rustCanvas, result.width),
    readback: byteDiff(frame.rustTarget, frame.rustCanvas, result.width),
    drawCalls: frame.stats.drawCalls,
    expectedCalls: expectedDrawCalls(spec),
    merged: frame.mergedDrawCount,
  }));
}

function failed(verdicts: Verdict[]): boolean {
  return verdicts.some(
    (v) =>
      v.shot.differingBytes > 0 ||
      v.canvas.differingBytes > 0 ||
      v.readback.differingBytes > 0 ||
      v.drawCalls !== v.expectedCalls,
  );
}

describe.skipIf(!ENABLED)(
  "canvas-items (Rust) against G7c's TypeScript executor, byte-identical",
  () => {
    beforeAll(async () => {
      execFileSync(BUILD, { stdio: "inherit" });
      const glue = await readFile(join(WASM, "canvas_items.js"));
      const wasm = await readFile(join(WASM, "canvas_items_bg.wasm"));
      const types = await readFile(join(WASM, "canvas_items.d.ts"), "utf8");
      // The canvas-items-only module must not carry the wgpu renderer's exports (D30).
      expect(types).not.toMatch(/RustRenderer/);
      await mkdir(ARTIFACTS, { recursive: true });
      const code = await bundle();
      const env = { ...process.env };
      delete env.DISPLAY;
      delete env.WAYLAND_DISPLAY;
      browser = await chromium.launch({
        // `headless: false` so Playwright adds no old-headless switches; `--headless=new` is
        // what removes the window.
        headless: false,
        args: [
          "--headless=new",
          "--enable-gpu",
          "--use-angle=vulkan",
          "--force-device-scale-factor=1",
          "--force-color-profile=srgb",
        ],
        env,
      });
      page = await browser.newPage({ viewport: { width: 400, height: 300 } });
      page.on("pageerror", (error) =>
        console.error(
          `canvas-items page error: ${error.stack ?? error.message}`,
        ),
      );
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning")
          console.log(`canvas-items page ${message.type()}: ${message.text()}`);
      });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/rust/canvas_items.js")
          return route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: glue,
          });
        if (url.pathname === "/rust/canvas_items_bg.wasm")
          return route.fulfill({
            status: 200,
            contentType: "application/wasm",
            body: wasm,
          });
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        });
      });
      await page.goto("http://localhost/gsw-canvas-items");
      await page.addScriptTag({ content: code, type: "module" });
      await page.waitForFunction(
        () => "__gswCanvasItems" in window,
        undefined,
        { timeout: 15000 },
      );
      const probe = await run("solidQuads");
      console.log(`canvas-items renderer: ${probe.renderer}`);
      // A software rasterizer would make every equality a statement about SwiftShader.
      expect(probe.renderer).toMatch(/ANGLE/);
      expect(probe.renderer).not.toMatch(/swiftshader|llvmpipe/i);
    }, 600000);

    afterAll(async () => {
      await browser?.close();
    });

    it.each(
      CASES,
    )("%s: shot, canvas and readback byte-identical", async (name) => {
      const result = await run(name);
      const verdicts = judge(name, result);
      for (const [f, frame] of result.frames.entries()) {
        await png(
          `${name}-f${f}-rust`,
          frame.rustTarget,
          result.width,
          result.height,
        );
        await png(
          `${name}-f${f}-ts`,
          frame.tsTarget,
          result.width,
          result.height,
        );
        const v = verdicts[f];
        console.log(
          `canvas-items ${name} f${f}: shot ${v.shot.differingBytes}B (max ${v.shot.maxDelta}) canvas ${v.canvas.differingBytes}B readback ${v.readback.differingBytes}B calls ${v.drawCalls}/${v.expectedCalls} glCalls ${frame.stats.glCalls} items ${frame.stats.itemRows} vtxB ${frame.stats.vertexBytes} idxB ${frame.stats.indexBytes}${v.shot.worst ? ` worst ${v.shot.worst}` : ""}`,
        );
        expect(v.shot, `${name} frame ${f}: shot`).toMatchObject({
          differingBytes: 0,
        });
        expect(v.canvas, `${name} frame ${f}: canvas`).toMatchObject({
          differingBytes: 0,
        });
        expect(v.readback, `${name} frame ${f}: readback`).toMatchObject({
          differingBytes: 0,
        });
        // Draw-count parity: the spec's runs == the draw list's own count == calls issued.
        expect(v.merged).toBe(v.expectedCalls);
        expect(v.drawCalls).toBe(v.expectedCalls);
        expect(frame.stats.drawsSkipped).toBe(0);
        if (f > 0) {
          // The transform-only path: only the changed item rows move.
          expect(frame.stats.vertexBytes).toBe(0);
          expect(frame.stats.indexBytes).toBe(0);
          expect(frame.stats.textureUploads).toBe(0);
          expect(frame.stats.itemRows).toBe(changedItems(caseByName(name), f));
          expect(frame.stats.itemRows).toBeGreaterThan(0);
        }
      }
      // The same verdict through the shared harness comparator (pixelmatch AND channel delta).
      const last = result.frames[result.frames.length - 1];
      const shared = await compareRgbaBuffers(
        Uint8Array.from(last.tsTarget),
        Uint8Array.from(last.rustTarget),
        {
          width: result.width,
          height: result.height,
          maxChannelDelta: 0,
          maxDiffRatio: 0,
        },
      );
      expect(shared.ok).toBe(true);
    }, 120000);

    it.each(CASES)("damage enabled: %s stays byte-identical", async (name) => {
      const result = await page.evaluate(
        (n) => window.__gswCanvasItems.run(n, "", false, true),
        name,
      );
      for (const v of judge(name, result)) {
        expect(v.shot.differingBytes).toBe(0);
        expect(v.canvas.differingBytes).toBe(0);
        expect(v.readback.differingBytes).toBe(0);
      }
      for (const frame of result.frames)
        if (frame.stats.damageMode !== 3)
          expect(frame.stats.plannedCalls).toBe(
            expectedDrawCalls(caseByName(name)),
          );
      expect(result.frames[0].stats.damageMode).toBe(1);
    }, 120000);

    it.each(
      buildDamageCases().flatMap((c) =>
        [false, true].flatMap((godot) =>
          (["rgba8", "rgb10a2"] as const).map((format) => ({
            name: c.name,
            godot,
            format,
          })),
        ),
      ),
    )("partial replay $name orientation=$godot format=$format", async ({
      name,
      godot,
      format,
    }) => {
      const compared = await page.evaluate(
        async ({ name, godot, format }) => {
          const full = await window.__gswCanvasItems.damageSequence(
            name,
            false,
            "",
            godot,
            format,
          );
          const partial = await window.__gswCanvasItems.damageSequence(
            name,
            true,
            "",
            godot,
            format,
          );
          const diff = (a: number[], b: number[]) => {
            let bytes = 0;
            let first = "";
            for (let k = 0; k < a.length; k++)
              if (a[k] !== b[k]) {
                bytes++;
                if (!first) first = `byte ${k}: ${a[k]} vs ${b[k]}`;
              }
            return { differingBytes: bytes, first };
          };
          return {
            errors: [full.glError, partial.glError],
            frames: partial.frames.map((frame, i) => ({
              target: diff(full.frames[i].target, frame.target),
              canvas: diff(full.frames[i].canvas, frame.canvas),
              stats: frame.stats,
              fullStats: full.frames[i].stats,
            })),
          };
        },
        { name, godot, format },
      );
      await writeFile(
        join(ARTIFACTS, `${name}-${godot}-${format}-damage.json`),
        JSON.stringify(compared),
      );
      expect(compared.errors).toEqual([0, 0]);
      for (const [i, frame] of compared.frames.entries()) {
        expect(frame.target, `${name} f${i} target`).toMatchObject({
          differingBytes: 0,
        });
        expect(frame.canvas, `${name} f${i} canvas`).toMatchObject({
          differingBytes: 0,
        });
        expect(frame.stats.damageMode, `${name} f${i}`).toBe(i === 0 ? 1 : 2);
        expect(frame.stats.plannedCalls).toBe(frame.fullStats.plannedCalls);
        if (i > 0) {
          expect(frame.stats.damageCalls).toBe(frame.stats.drawCalls);
          expect(frame.stats.damageCalls).toBeGreaterThan(0);
          if (name === "damage-two-groups") {
            expect(frame.stats.damageOpsSkipped).toBe(1);
            expect(frame.stats.screenCopies).toBe(1);
            expect(frame.fullStats.screenCopies).toBe(2);
          }
          if (name === "damage-distant")
            expect(frame.stats.damageRegions).toBeGreaterThanOrEqual(2);
        }
      }
    }, 120000);

    it("partial replay clear sabotage changes blended mover pixels", async () => {
      const result = await page.evaluate(async () => {
        const full = await window.__gswCanvasItems.damageSequence(
          "damage-blend",
          false,
        );
        const broken = await window.__gswCanvasItems.damageSequence(
          "damage-blend",
          true,
          "damage-no-scissor-clear",
        );
        return {
          mode: broken.frames[1].stats.damageMode,
          differingBytes: broken.frames[1].target.reduce(
            (n, b, i) => n + Number(b !== full.frames[1].target[i]),
            0,
          ),
        };
      });
      expect(result.mode).toBe(2);
      expect(result.differingBytes).toBeGreaterThan(0);
    }, 120000);

    it("identical damage frame skips draw, blit and fence and retains the canvas", async () => {
      await page.evaluate(() => window.__gswCanvasItems.damageStart());
      try {
        const canvas = page.locator("#damage-canvas");
        const first = await canvas.screenshot();
        const stats = await page.evaluate(() =>
          window.__gswCanvasItems.damageNext(false),
        );
        const second = await canvas.screenshot();
        expect(stats.damageMode).toBe(3);
        expect(stats.drawCalls).toBe(0);
        expect(stats.plannedCalls).toBe(0);
        expect(stats.fenceIssued).toBe(0);
        expect(second).toEqual(first);
      } finally {
        await page.evaluate(() => window.__gswCanvasItems.damageEnd());
      }
    }, 120000);

    it("texture-op-only damage redraws a referenced texture", async () => {
      await page.evaluate(() => window.__gswCanvasItems.damageStart());
      try {
        const canvas = page.locator("#damage-canvas");
        const first = await canvas.screenshot();
        const stats = await page.evaluate(() =>
          window.__gswCanvasItems.damageNext(true),
        );
        const second = await canvas.screenshot();
        expect([1, 2]).toContain(stats.damageMode);
        expect(stats.drawCalls).toBeGreaterThan(0);
        expect(stats.textureUploads).toBe(1);
        expect(second).not.toEqual(first);
      } finally {
        await page.evaluate(() => window.__gswCanvasItems.damageEnd());
      }
    }, 120000);

    it.each([
      false,
      true,
    ])("damage invalidation: freeing a sampled surface (all=%s) removes its colour", async (all) => {
      const result = await page.evaluate(
        (freeAll) => window.__gswCanvasItems.damageSurfaceFree(freeAll),
        all,
      );
      expect(result.glError).toBe(0);
      expect(result.before.slice(0, 4)).toEqual([255, 0, 0, 255]);
      expect(result.steadyStats?.damageMode).toBe(3);
      expect(byteDiff(result.expected, result.after, 32).differingBytes).toBe(
        0,
      );
      expect(byteDiff(result.expected, result.canvas, 32).differingBytes).toBe(
        0,
      );
      expect(result.stats).toMatchObject({
        damageMode: 1,
        damageReason: 100,
        drawCalls: 1,
      });
      expect(result.repeatStats.damageMode).toBe(3);
    }, 120000);

    it("damage invalidation: disabling DropDraws redraws every call", async () => {
      const result = await page.evaluate(() =>
        window.__gswCanvasItems.damageSabotageTransition(),
      );
      expect(result.glError).toBe(0);
      expect(
        byteDiff(result.expected, result.before, 32).differingBytes,
      ).toBeGreaterThan(0);
      expect(byteDiff(result.expected, result.after, 32).differingBytes).toBe(
        0,
      );
      expect(byteDiff(result.expected, result.canvas, 32).differingBytes).toBe(
        0,
      );
      expect(result.stats).toMatchObject({
        damageMode: 1,
        damageReason: 104,
        drawCalls: 2,
      });
      expect(result.repeatStats.damageMode).toBe(3);
    }, 120000);

    it("recovers from a lost context: refuses while lost, re-creates on restore, needs a full re-send", async () => {
      const result = await run("texturedMesh", "", true);
      const verdicts = judge("texturedMesh", result);
      console.log(
        `canvas-items contextLoss: ${JSON.stringify(result.loss)} after-restore shot ${verdicts[1].shot.differingBytes}B`,
      );
      expect(result.loss?.stateAfterLoss).toBe("lost");
      expect(result.loss?.executeWhileLost).toMatch(/lost/);
      expect(result.loss?.stateAfterRestore).toBe("restored");
      expect(result.loss?.executeWithoutResend).toMatch(/dirty\.all/);
      expect(verdicts).toHaveLength(2);
      expect(verdicts[1].shot.differingBytes).toBe(0);
      expect(verdicts[1].readback.differingBytes).toBe(0);
      expect(result.frames[1].stats.textureUploads).toBe(1);
    }, 120000);

    // DEPTH_TILES: `depthTiles` drawn with the list's depth tables (the tile pre-pass, the
    // backdrop depth-tested under the cover's core) must equal the same list without them, byte
    // for byte, in both orientations and after a restored context; a tile the cover does NOT
    // overwrite must change pixels, and only inside that tile (so the tables really reach the
    // GPU, at the right rows).
    it.each([
      false,
      true,
    ])("depth tiles change no pixel (Godot orientation %s), and a wrong tile shows", async (godot) => {
      const good = { tiles: [32, 32, 64, 32, 1], draws: [0, 0] };
      const wrong = { tiles: [0, 0, 32, 32, 1], draws: [0, 0] };
      const none = { tiles: [], draws: [] };
      // The depth program links without a status read (settled on a later frame without
      // KHR_parallel_shader_compile), so the first frame with tables after the executor's
      // objects are made (creation, a restored context) may still draw untested: the same pixels
      // either way. The second such frame must use them.
      const runs = [
        none,
        good,
        good,
        wrong,
        wrong,
        none,
        { ...good, loseFirst: true },
        good,
      ];
      const result = await page.evaluate(
        ([g, r]) => window.__gswCanvasItems.depth("depthTiles", g, r),
        [godot, runs] as [
          boolean,
          { tiles: number[]; draws: number[]; loseFirst?: boolean }[],
        ],
      );
      expect(result.glError).toBe(0);
      const plain = result.targets[0];
      const withWrong = result.targets[4];
      const w = result.width;
      await png(`depthTiles-godot${godot}-wrong`, withWrong, w, result.height);
      for (const k of [1, 2, 5, 6, 7]) {
        expect(
          byteDiff(plain, result.targets[k], w),
          `run ${k} (${JSON.stringify(runs[k])})`,
        ).toMatchObject({ differingBytes: 0 });
      }
      expect(result.stats[2]).toMatchObject({ depthTiles: 1, depthTested: 1 });
      expect(result.stats[7]).toMatchObject({ depthTiles: 1, depthTested: 1 });
      expect(result.stats[5]).toMatchObject({ depthTiles: 0, depthTested: 0 });
      expect(result.stats[4]).toMatchObject({ depthTiles: 1, depthTested: 1 });
      // The wrong tile rejects the backdrop where the cover's frame lets it show.
      const outside: string[] = [];
      let inside = 0;
      for (let p = 0; p < plain.length / 4; p += 1) {
        const differs = [0, 1, 2, 3].some(
          (c) => plain[4 * p + c] !== withWrong[4 * p + c],
        );
        if (!differs) continue;
        const [x, y] = [p % w, Math.floor(p / w)];
        if (x < 32 && y < 32) inside += 1;
        else outside.push(`(${x},${y})`);
      }
      console.log(
        `canvas-items depthTiles godot=${godot}: wrong tile changes ${inside} px inside, ${outside.length} outside`,
      );
      expect(outside).toEqual([]);
      // The tile outside the cover's opaque core (x >= 28 and y >= 12 is inside it), less
      // [0, 16) x [0, 12), where the backdrop samples only its alpha-0 corner texel (nothing to
      // reject): 32·32 - 4·20 - 16·12.
      expect(inside).toBe(32 * 32 - 4 * 20 - 16 * 12);
    }, 120000);

    it("signals its fence on a later task", async () => {
      const polls = await page.evaluate(
        (name) => window.__gswCanvasItems.fence(name),
        "manyItems",
      );
      console.log(`canvas-items fence polls: ${polls.join(",")}`);
      expect(polls).toContain(1);
      expect(polls[polls.length - 1]).toBe(-1);
    }, 60000);

    it.each([
      "drop-draws",
      "stale-item-row",
    ])("the %s sabotage fails at least one case", async (sabotage) => {
      const failing: string[] = [];
      for (const name of CASES) {
        const verdicts = judge(name, await run(name, sabotage));
        if (failed(verdicts)) {
          const worst = verdicts.find((v) => v.shot.differingBytes > 0);
          failing.push(
            `${name}${worst ? ` (shot ${worst.shot.differingBytes}B, max ${worst.shot.maxDelta})` : " (calls)"}`,
          );
        }
      }
      console.log(
        `canvas-items sabotage ${sabotage} fails ${failing.length}/${CASES.length}: ${failing.join("; ")}`,
      );
      expect(failing.length).toBeGreaterThan(0);
      // Exactly the predicted set: drop-draws bites wherever a case plans a second merged call
      // (counted across its frames: a fresh executor per case);
      // stale-item-row wherever a frame after the first moves item rows (the transform-only
      // path), and nowhere else, since every first frame is `dirty.all`.
      const predicted = buildCases()
        .filter((spec) =>
          sabotage === "drop-draws"
            ? expectedDrawCalls(spec) * spec.frames.length >= 2
            : spec.frames.length > 1,
        )
        .map((spec) => spec.name);
      expect(failing.map((f) => f.split(" ")[0])).toEqual(predicted);
    }, 600000);
  },
);
