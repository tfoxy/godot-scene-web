// @vitest-environment node
//
// THE RUST `canvas-items` EXECUTOR'S ITEM-SPACE PROGRAMS, ON A REAL GPU, AGAINST A HAND MODEL.
//
// Every case of `../src/canvas-pixel/canvas-items-program-cases` is Godot `canvas_item` shader code
// transpiled by `@godot-scene-web/effects` (`transpileGodotItemShader`), compiled by the executor
// (`define_program`) and drawn through a `PDL1` list whose draws name bindings (`set_binding`),
// into Godot's non-transparent RGB10_A2 target. The TypeScript executor has no programs, so each
// expected pixel is the shader's arithmetic by hand, converted as the target and its readback
// convert; every pixel of each expectation's rect must match within its `maxDelta` (0 but for a
// product in the blend unit), alpha included (pixelmatch cannot see a wrong alpha convention). A program
// that does not compile must be refused at definition, and its draws skipped.
//
// LAUNCH as canvasItemsRustPixel.test.ts: `--headless=new --enable-gpu --use-angle=vulkan`, DISPLAY
// and WAYLAND_DISPLAY removed, never headed, never Xvfb. Opt in with GSW_CANVAS_ITEMS_PIXEL=1; the
// wasm is the same `canvas-items-test` build.
//
// Every case runs twice, in `executor-webgl.ts`'s y-down orientation and in Godot's
// (`ExecOptions::godot_orientation`, the GSW receiver's), against the same expectations.
//
// J1: every case also links in the background (`begin_program`, settled by `poll_programs` one
// animation frame later or by KHR_parallel_shader_compile): before the first poll every program is
// pending and its draws are skipped; once settled the target meets the same expectations. A few
// cases also lose the context while their links are pending: nothing settles while lost, the
// restore recompiles them, and the re-sent frame meets the same expectations.
//
// Artifacts (never committed): `artifacts/canvas-items-pixel/program-<case>[-godot|-async|-loss].png`.

import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgramCases } from "../src/canvas-pixel/canvas-items-program-cases";
import type {
  ProgramCaseResult,
  ProgramMode,
} from "../src/canvas-pixel/canvas-items-program-entry";

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
const CASES = buildProgramCases();

let browser: Browser;
let page: Page;

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [
      join(here, "..", "src", "canvas-pixel", "canvas-items-program-entry.ts"),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
    conditions: ["development"],
    write: false,
    absWorkingDir: join(here, ".."),
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file)
    throw new Error("canvas-items programs: esbuild produced no output");
  return file.text;
}

describe.skipIf(!ENABLED)(
  "canvas-items item-space programs (G7s) against a hand model",
  () => {
    beforeAll(async () => {
      execFileSync(BUILD, { stdio: "inherit" });
      const glue = await readFile(join(WASM, "canvas_items.js"));
      const wasm = await readFile(join(WASM, "canvas_items_bg.wasm"));
      await mkdir(ARTIFACTS, { recursive: true });
      const code = await bundle();
      const env = { ...process.env };
      delete env.DISPLAY;
      delete env.WAYLAND_DISPLAY;
      browser = await chromium.launch({
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
        console.error(`programs page error: ${error.stack ?? error.message}`),
      );
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
      await page.goto("http://localhost/gsw-canvas-items-programs");
      await page.addScriptTag({ content: code, type: "module" });
      await page.waitForFunction(
        () => "__gswCanvasItemsPrograms" in window,
        undefined,
        { timeout: 15000 },
      );
    }, 600000);

    afterAll(async () => {
      await browser?.close();
    });

    async function check(
      name: string,
      orientation: string,
      mode: ProgramMode,
    ): Promise<ProgramCaseResult> {
      const spec = CASES.find((c) => c.name === name);
      if (!spec) throw new Error(name);
      const godot = orientation === "godot";
      const result: ProgramCaseResult = await page.evaluate(
        ([n, g, m]) => window.__gswCanvasItemsPrograms.run(n, g, m),
        [name, godot, mode] as const,
      );
      const suffix =
        (godot ? "-godot" : "") +
        (mode === "async"
          ? "-async"
          : mode === "async-loss"
            ? "-loss"
            : mode === "async-loss-poll"
              ? "-loss-poll"
              : "");
      await sharp(Buffer.from(Uint8Array.from(result.target)), {
        raw: { width: result.width, height: result.height, channels: 4 },
      })
        .png()
        .toFile(join(ARTIFACTS, `program-${name}${suffix}.png`));
      expect(result.renderer).toMatch(/ANGLE/);
      expect(result.renderer).not.toMatch(/swiftshader|llvmpipe/i);
      expect(result.glError, `${name}: gl.getError()`).toBe(0);
      expect(Object.keys(result.defineErrors).map(Number).sort()).toEqual(
        [...(spec.failing ?? [])].sort(),
      );
      for (const id of spec.failing ?? [])
        expect(result.defineErrors[id]).toMatch(/link failed|ERROR/);
      expect(result.stats.drawsSkipped).toBe(spec.skipped ?? 0);
      const problems: string[] = [];
      for (const e of spec.expect) {
        const [x0, y0, w, h] = e.rect;
        let worst = 0;
        let at = "";
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++) {
            const i = (y * result.width + x) * 4;
            for (let c = 0; c < 4; c++) {
              const d = Math.abs(result.target[i + c] - e.rgba[c]);
              if (d > worst) {
                worst = d;
                at = `(${x},${y}) got ${result.target.slice(i, i + 4).join(",")} expected ${e.rgba.join(",")}`;
              }
            }
          }
        console.log(
          `canvas-items program ${name} (${orientation}, ${mode}): ${e.why}: max delta ${worst}${at ? ` ${at}` : ""}`,
        );
        if (worst > e.maxDelta)
          problems.push(`${e.why}: max delta ${worst} > ${e.maxDelta} ${at}`);
      }
      expect(problems).toEqual([]);
      return result;
    }

    // Every case also in Godot's orientation (`ExecOptions::godot_orientation`, as the GSW
    // receiver draws): the same expectations, read back in design rows.
    it.each(
      CASES.flatMap((c) => [
        [c.name, "y-down"],
        [c.name, "godot"],
      ]),
    )(
      "%s (%s): every expected pixel within its delta",
      async (name, orientation) => {
        await check(name, orientation, "sync");
      },
      120000,
    );

    it.each(
      CASES.map((c) => [c.name]),
    )("%s (background link): pending and skipped before the first poll, then the same pixels", async (name) => {
      const spec = CASES.find((c) => c.name === name);
      if (!spec) throw new Error(name);
      const result = await check(name, "godot", "async");
      const ids = spec.programs.map((p) => p.id).sort();
      expect(result.linking?.pendingBeforePoll.slice().sort()).toEqual(ids);
      expect(result.linking?.skippedBeforePoll).toBeGreaterThanOrEqual(
        spec.skipped ?? 0,
      );
      console.log(
        `canvas-items program ${name} (background link): ${JSON.stringify(result.linking)} skipped once settled ${result.stats.drawsSkipped}`,
      );
      if (ids.length > 0) {
        expect(result.linking?.polls).toBeGreaterThanOrEqual(1);
        // Some draw names a program: before the poll, more draws were skipped than after.
        if (spec.bindings.length > 0)
          expect(result.linking?.skippedBeforePoll).toBeGreaterThan(
            spec.skipped ?? 0,
          );
      }
    }, 120000);

    // A context lost while links are pending: the case with a failing program among them too.
    it.each(
      CASES.filter((c, i) => i < 3 || (c.failing?.length ?? 0) > 0).map((c) => [
        c.name,
      ]),
    )("%s (background link, context lost while pending): settles after the restore", async (name) => {
      const result = await check(name, "godot", "async-loss");
      expect(result.linking?.settledWhileLost).toBe(0);
      expect(result.linking?.stateWhileLost).toBe("lost");
    }, 120000);

    // A poll in the task that loses the context, before its event: the status reads fail on the
    // dead context. The links stay pending, the restore recompiles them, and each is reported
    // exactly once and drawn.
    it.each(
      CASES.filter((c) => c.programs.length > 0).map((c) => [c.name]),
    )("%s (background link, polled as the context is lost): reported once after the restore", async (name) => {
      const spec = CASES.find((c) => c.name === name);
      if (!spec) throw new Error(name);
      const result = await check(name, "godot", "async-loss-poll");
      expect(result.linking?.settledWhileLost).toBe(0);
      expect(result.linking?.stateWhileLost).toBe("lost");
      const once = Object.fromEntries(spec.programs.map((p) => [p.id, 1]));
      expect(result.linking?.reports).toEqual(once);
    }, 120000);
  },
);
