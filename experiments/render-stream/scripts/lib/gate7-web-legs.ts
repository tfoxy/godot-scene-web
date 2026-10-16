// Gate 7 web-export file legs (G7e, gate7-design.md Q4, Q6, Q8, D10, D21): replays a native
// receiver leg of a source run in the web-export receiver, through `browser-harness.ts` only.
//
// A web leg is DERIVED from its native leg, never re-specified: the native leg's env.txt (what
// lib/legs.sh passed) and argv.txt are read back and mapped --
//   - RS_RECEIVER_RECORDING: the recording is copied into the web leg's directory (as the native
//     leg has its own copy) and named by its same-origin URL path;
//   - RS_RECEIVER_OUT: the web leg directory's URL path (the receiver writes into its in-memory
//     filesystem there, and RsIo PUTs every file to RS_RECEIVER_EVIDENCE_URL at exit);
//   - RS_RECEIVER_CACHE_DIR: dropped (native only; the web's cache is the HTTP cache, Q4);
//   - any other absolute path: under the native leg dir -> the web leg dir; under the source run ->
//     its URL under /sources/<gate>/ (a symlink in the gate 7 run directory); anything else is a
//     refusal, never silently passed through;
//   - every other value verbatim (shot seqs, sabotages, budgets);
//   - G7xw: with `core: "rust"` on the run (a `Web (rust core)` bundle), RS_RECEIVER_CORE=rust is
//     added to every leg, as lib/legs.sh's receiver_core_env adds the runner's own natively.
// Engine arguments after argv.txt's fixed `--path/--rendering-driver/--display-driver/--headless`
// pass through, except `--resolution WxH`, which becomes the canvas size (the presentation size,
// DPR 1; the shell sets the canvas attributes and CSS size, Q4 item 6). The default is the
// receiver project's 640x360.
//
// Per leg: one fresh browser (D9: a fresh profile per cold leg), `browser-provenance` on
// about:blank, the page `/web-bundle/receiver.html?env=<base64url JSON>`, every console message
// and page error to console.jsonl, the engine's printed lines to stdout.log, the shell's exit
// code to exit-code.txt (124 on timeout), its performance marks and navigation timing to
// timings.json, and, when `compositor` is set, a CDP screenshot of the canvas taken while the
// receiver's PUT of applied.json is held open (the page cannot quit before it is answered), for
// `compositor-equals-readback` (Q7).

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { CDPSession } from "@playwright/test";

import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  HarnessServer,
  launchHarnessBrowser,
} from "./browser-harness";
import { quietAcquire } from "./quiet-lock";

export interface WebLegSpec {
  /** The leg's id, e.g. "receiver" or "sabotage-freeze/receiver" (the native leg's own path). */
  leg: string;
  /** The native leg directory in the source run. */
  nativeDir: string;
  /** The web leg directory (created). */
  webDir: string;
  /** Q7's `css-opacity` sabotage: the shell sets `opacity: 0.99` on the canvas. */
  sabotage?: "css-opacity";
  /** Take the compositor screenshot at the applied.json PUT. */
  compositor?: boolean;
  /** A probe leg's extra RS_RECEIVER_* values; a value `@leg/<path>` names <path> in the web leg
   * directory (e.g. RS_RECEIVER_PERF_OUT for the render-time probe). Never set on a leg whose
   * evidence is compared with its native leg. */
  extraEnv?: Readonly<Record<string, string>>;
}

export interface WebRunContext {
  /** The gate 7 run directory: the harness's static root. */
  out: string;
  /** The gate name the source belongs to ("gate0"); its run is linked at /sources/<gate>. */
  gate: string;
  sourceDir: string;
  /** The web-export bundle directory (build-web-receiver.sh), linked at /web-bundle. */
  bundleDir: string;
  /** build.json's pck sha256 (web) or the bundle's sha256 (gsw), passed as
   * RS_RECEIVER_BUILD_SHA256. */
  buildSha256: string;
  /** Which browser receiver (G7a): `web` (default) serves `/web-bundle/receiver.html`, the web
   * export's shell; `gsw` serves `/gsw-bundle/receiver.html`, the GSW canvas receiver
   * (web/gsw-receiver/). Both read the same `?env=` page configuration and report through the
   * same `window.__rsShell` contract. */
  kind?: "web" | "gsw";
  /** G7xw: the web export's core. `rust` adds RS_RECEIVER_CORE=rust to every leg's env (the
   * bundle must be build-web-receiver.sh --core rust's); absent or `gdscript` adds nothing. */
  core?: "gdscript" | "rust";
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface WebLegResult {
  leg: string;
  webDir: string;
  exitCode: number;
  provenanceOk: boolean;
  wallMs: number;
}

const DEFAULT_CANVAS: [number, number] = [640, 360];
const FIXED_ARGS_WITH_VALUE = new Set([
  "--path",
  "--rendering-driver",
  "--display-driver",
]);

/** Parses env.txt (lib/legs.sh write_invocation): NAME=value lines; comments and DISPLAY skipped. */
export function parseEnvTxt(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (name === "DISPLAY") continue;
    out.push([name, line.slice(eq + 1)]);
  }
  return out;
}

export interface MappedLeg {
  env: Record<string, string>;
  engineArgs: string[];
  canvas: [number, number];
  /** Files to copy into the web leg dir before the run: [from, to]. */
  copies: Array<[string, string]>;
  dropped: string[];
}

/** The web leg's env, engine args and canvas, mapped from its native leg (header). */
export function mapNativeLeg(
  spec: WebLegSpec,
  ctx: Pick<WebRunContext, "out" | "gate" | "sourceDir">,
  envTxt: string,
  argvTxt: string,
): MappedLeg {
  const env: Record<string, string> = {};
  const copies: Array<[string, string]> = [];
  const dropped: string[] = [];
  const urlOf = (hostPath: string): string => {
    const rel = relative(ctx.out, hostPath);
    if (rel.startsWith(".."))
      throw new Error(`${hostPath} is outside the gate 7 run ${ctx.out}`);
    return `/${rel.split("\\").join("/")}`;
  };
  const sourceLink = join(ctx.out, "sources", ctx.gate);
  const mapPath = (name: string, value: string): string => {
    const native = resolve(spec.nativeDir);
    const source = resolve(ctx.sourceDir);
    if (value === native || value.startsWith(`${native}/`)) {
      return urlOf(join(spec.webDir, relative(native, value)));
    }
    if (value === source || value.startsWith(`${source}/`)) {
      return urlOf(join(sourceLink, relative(source, value)));
    }
    throw new Error(
      `${spec.leg}: ${name}=${value} is neither under the native leg nor the source run`,
    );
  };
  for (const [name, value] of parseEnvTxt(envTxt)) {
    if (!name.startsWith("RS_RECEIVER_")) {
      dropped.push(name);
      continue;
    }
    if (name === "RS_RECEIVER_CACHE_DIR") {
      dropped.push(name);
      continue;
    }
    if (name === "RS_RECEIVER_RECORDING") {
      const to = join(spec.webDir, "recording.rs2");
      copies.push([value, to]);
      env[name] = urlOf(to);
      continue;
    }
    env[name] = value.startsWith("/") ? mapPath(name, value) : value;
  }
  const argv = argvTxt.split("\n").filter((l) => l !== "");
  const engineArgs: string[] = [];
  let canvas: [number, number] = [...DEFAULT_CANVAS];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headless") continue;
    if (FIXED_ARGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a === "--resolution") {
      const m = /^(\d+)x(\d+)$/.exec(argv[i + 1] ?? "");
      if (!m) throw new Error(`${spec.leg}: bad --resolution ${argv[i + 1]}`);
      canvas = [Number(m[1]), Number(m[2])];
      i++;
      continue;
    }
    engineArgs.push(a);
  }
  return { env, engineArgs, canvas, copies, dropped };
}

/** The web-export shell's `?env=` encoding (also used directly by gate7-bench.ts's web arm). */
export function base64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ensureLink(target: string, link: string): void {
  if (existsSync(link)) return;
  symlinkSync(target, link);
}

/** Runs `legs` one after another, each in its own browser, on one harness server. */
export async function runWebLegs(
  ctx: WebRunContext,
  legs: WebLegSpec[],
): Promise<WebLegResult[]> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  await mkdir(join(ctx.out, "sources"), { recursive: true });
  ensureLink(resolve(ctx.sourceDir), join(ctx.out, "sources", ctx.gate));
  ensureLink(
    resolve(ctx.bundleDir),
    join(ctx.out, ctx.kind === "gsw" ? "gsw-bundle" : "web-bundle"),
  );
  let onApplied: (() => Promise<void>) | undefined;
  const server = new HarnessServer({
    staticRoot: ctx.out,
    evidenceRoot: join(ctx.out, ".evidence"),
    allowedLegNonces: [],
    onPut: async (_nonce, path) => {
      if (path === "applied.json" && onApplied) await onApplied();
    },
  });
  const { origin } = await server.start();
  const results: WebLegResult[] = [];
  try {
    for (const spec of legs) {
      // Measurement isolation: one file leg, one shared quiet hold (lib/quiet-lock.ts).
      const hold = await quietAcquire(
        "shared",
        `gate7-${ctx.kind ?? "web"}:${ctx.gate}/${spec.leg}`,
        { log: join(ctx.out, "quiet-lock.jsonl") },
      );
      try {
        results.push(
          await runOne(ctx, spec, server, origin, (hook) => {
            onApplied = hook;
          }),
        );
      } finally {
        await hold.release();
      }
      log(
        `gate7-${ctx.kind ?? "web"}: ${spec.leg} exit=${results[results.length - 1].exitCode}`,
      );
    }
  } finally {
    await server.stop();
  }
  return results;
}

async function runOne(
  ctx: WebRunContext,
  spec: WebLegSpec,
  server: HarnessServer,
  origin: string,
  setHook: (hook: (() => Promise<void>) | undefined) => void,
): Promise<WebLegResult> {
  const started = Date.now();
  await mkdir(spec.webDir, { recursive: true });
  const mapped = mapNativeLeg(
    spec,
    ctx,
    readFileSync(join(spec.nativeDir, "env.txt"), "utf8"),
    readFileSync(join(spec.nativeDir, "argv.txt"), "utf8"),
  );
  for (const [from, to] of mapped.copies) {
    await mkdir(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  // G7b: the runner's record of the seqs it asked to be shot is an input, not receiver evidence
  // (gate 5.5d's checker reads it from the leg directory).
  if (existsSync(join(spec.nativeDir, "shot-seqs.txt")))
    copyFileSync(
      join(spec.nativeDir, "shot-seqs.txt"),
      join(spec.webDir, "shot-seqs.txt"),
    );
  const nonce = randomBytes(8).toString("hex");
  server.addLeg(nonce, spec.webDir);
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.extraEnv ?? {})) {
    extra[name] = value.startsWith("@leg/")
      ? `/${relative(ctx.out, join(spec.webDir, value.slice(5)))}`
      : value;
  }
  const env = {
    ...mapped.env,
    ...extra,
    ...(ctx.core === "rust" ? { RS_RECEIVER_CORE: "rust" } : {}),
    RS_RECEIVER_EVIDENCE_URL: `/evidence/${nonce}`,
    RS_RECEIVER_BUILD_SHA256: ctx.buildSha256,
  };
  const pageConfig = {
    env,
    engine_args: mapped.engineArgs,
    canvas: mapped.canvas,
    sabotage: spec.sabotage ?? null,
  };
  const bundle = ctx.kind === "gsw" ? "gsw-bundle" : "web-bundle";
  const url = `${origin}/${bundle}/receiver.html?env=${base64url(JSON.stringify(pageConfig))}`;
  await writeFile(
    join(spec.webDir, "page-config.json"),
    `${JSON.stringify({ url, ...pageConfig, dropped: mapped.dropped }, null, 2)}\n`,
  );
  await writeFile(
    join(spec.webDir, "env.txt"),
    `${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );
  await writeFile(
    join(spec.webDir, "argv.txt"),
    `${[url, ...mapped.engineArgs].join("\n")}\n`,
  );

  const launchArgs = [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS];
  const launched = await launchHarnessBrowser();
  const consoleLines: string[] = [];
  let exitCode = 124;
  let provenanceOk = false;
  try {
    const context = await launched.browser.newContext({
      viewport: { width: mapped.canvas[0], height: mapped.canvas[1] },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      consoleLines.push(
        JSON.stringify({ t: Date.now(), type: m.type(), text: m.text() }),
      );
    });
    page.on("pageerror", (e) => {
      consoleLines.push(
        JSON.stringify({ t: Date.now(), type: "pageerror", text: String(e) }),
      );
    });
    page.on("dialog", (d) => {
      consoleLines.push(
        JSON.stringify({ t: Date.now(), type: "dialog", text: d.message() }),
      );
      d.dismiss().catch(() => {});
    });
    await page.goto("about:blank");
    const launchEnv: Record<string, string | undefined> = { ...process.env };
    delete launchEnv.DISPLAY;
    delete launchEnv.WAYLAND_DISPLAY;
    const provenance = await checkBrowserProvenance(
      page,
      launched,
      launchArgs,
      launchEnv,
    );
    provenanceOk = provenance.ok;
    await writeFile(
      join(spec.webDir, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    if (!provenance.ok) {
      await writeFile(
        join(spec.webDir, "harness-refused.txt"),
        `browser-provenance: ${provenance.reasons.join("; ")}\n`,
      );
      return {
        leg: spec.leg,
        webDir: spec.webDir,
        exitCode: 124,
        provenanceOk,
        wallMs: Date.now() - started,
      };
    }
    const session: CDPSession = await context.newCDPSession(page);
    setHook(
      spec.compositor
        ? async () => {
            const shot = (await session.send("Page.captureScreenshot", {
              format: "png",
              clip: {
                x: 0,
                y: 0,
                width: mapped.canvas[0],
                height: mapped.canvas[1],
                scale: 1,
              },
              captureBeyondViewport: false,
            })) as { data: string };
            await mkdir(join(spec.webDir, "compositor"), { recursive: true });
            await writeFile(
              join(spec.webDir, "compositor", "screenshot.png"),
              Buffer.from(shot.data, "base64"),
            );
          }
        : undefined,
    );
    await page.goto(url);
    const deadline = Date.now() + (ctx.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      const exit = await page
        .evaluate(() => window.__rsShell?.exit ?? null)
        .catch(() => null);
      if (exit) {
        exitCode = exit.code;
        break;
      }
      const failed = await page
        .evaluate(() => window.__rsShell?.error ?? null)
        .catch(() => null);
      if (failed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const state = await page
      .evaluate(() => ({
        lines: window.__rsShell?.lines ?? [],
        error: window.__rsShell?.error ?? null,
        exit: window.__rsShell?.exit ?? null,
        contextLost: window.__rsShell?.contextLost ?? false,
        wasmHeapBytes: window.__rsWasmHeap?.() ?? null,
        marks: performance
          .getEntriesByType("mark")
          .map((m) => ({ name: m.name, t: m.startTime })),
        navigation: performance
          .getEntriesByType("navigation")
          .map((n) => n.toJSON()),
        resources: performance.getEntriesByType("resource").map((r) => {
          const e = r as PerformanceResourceTiming;
          return {
            name: e.name,
            start: e.startTime,
            end: e.responseEnd,
            transfer: e.transferSize,
            decoded: e.decodedBodySize,
          };
        }),
      }))
      .catch(() => null);
    await writeFile(
      join(spec.webDir, "stdout.log"),
      (state?.lines ?? [])
        .map((l) => (l.stream === "err" ? `[stderr] ${l.line}` : l.line))
        .join("\n") + "\n",
    );
    await writeFile(
      join(spec.webDir, "timings.json"),
      `${JSON.stringify({ schema: "render-stream-web-timings/1", wall_ms: Date.now() - started, exit: state?.exit ?? null, error: state?.error ?? null, context_lost: state?.contextLost ?? false, wasm_heap_bytes: state?.wasmHeapBytes ?? null, marks: state?.marks ?? [], navigation: state?.navigation ?? [], resources: state?.resources ?? [], lines: (state?.lines ?? []).slice(0, 400).map((l) => ({ t: l.t, line: l.line })) }, null, 2)}\n`,
    );
    setHook(undefined);
    await session.detach().catch(() => {});
    await context.close().catch(() => {});
  } finally {
    setHook(undefined);
    server.removeLeg(nonce);
    await writeFile(
      join(spec.webDir, "console.jsonl"),
      consoleLines.join("\n") + (consoleLines.length ? "\n" : ""),
    );
    await writeFile(join(spec.webDir, "exit-code.txt"), `${exitCode}\n`);
    await launched.browser.close().catch(() => {});
  }
  return {
    leg: spec.leg,
    webDir: spec.webDir,
    exitCode,
    provenanceOk,
    wallMs: Date.now() - started,
  };
}

declare global {
  interface Window {
    __rsShell?: {
      exit: { code: number; t: number } | null;
      error: string | null;
      contextLost: boolean;
      lines: { t: number; stream: string; line: string }[];
    };
    __rsWasmHeap?: () => number | null;
  }
}
