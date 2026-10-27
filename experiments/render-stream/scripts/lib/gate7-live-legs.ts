// Gate 7 browser receivers inside the gates' OWN runners (G7l, gate7-design.md Q4 "Live client",
// Q6, Q8; protocol/gate7/g7l.md). `lib/legs.sh` substitutes a browser for the
// native receiver when the runner's environment has `GATE7_LIVE_KIND=web|gsw`: it writes the
// native leg's words to `<dir>/native-env.txt` and `<dir>/native-argv.txt` and asks this module to
// run the leg. Every live leg of gates 1, 2, 5 and 5.5 (host words, windows, stall, reconnect,
// resync, sabotages) is reused verbatim, and each gate's own checker judges the leg directory as
// it judges a native one.
//
// The page contract (both receivers; the web export's receiver/web/shell.html and the GSW
// receiver's): `<origin>/<web-bundle|gsw-bundle>/receiver.html?env=<base64url JSON>#token=<hex>`.
// `?env=` is `{env, engine_args, canvas, sabotage}` as in G7e's file legs. The env is the native
// leg's RS_RECEIVER_* words, mapped:
//   - RS_RECEIVER_OUT, _RECORDING, _STORE_DIR, _SHADER_LIBRARY, _PERF_OUT, _RECEIVED_OUT (any
//     absolute path): its URL path under the static root (the runner's evidence directory, so the
//     page's origin serves the leg's inputs and the receiver's in-memory filesystem uses the same
//     paths); a path outside the static root is a refusal, never silently passed through;
//   - RS_RECEIVER_CACHE_DIR: dropped (native only; the web's cache is the HTTP cache, Q4);
//   - RS_RECEIVER_TOKEN_FILE: dropped; the file is read here and the token goes in the URL's
//     fragment only, which the shell removes before anything runs (D3). It never appears in
//     env.txt, argv.txt, page-config.json, console.jsonl or any log written here
//     (`token-not-logged`);
//   - added: RS_RECEIVER_EVIDENCE_URL (/evidence/<nonce>; PUTs land in RS_RECEIVER_OUT's
//     directory), RS_RECEIVER_BUILD_SHA256, RS_RECEIVER_PROTOCOL=7 on a live leg (8 kept: G8g; 9: G8kb), and
//     RS_RECEIVER_MANIFEST_SHA256 (GATE7_MANIFEST_SHA256) on a live leg when set (the web
//     export's bundle must be a Rust-core build: requireRustBundle, G7gd);
//   - a native `--headless` leg: a browser always renders, so the leg runs rendered, with the
//     credit stage its native receiver used (`applied`, forced under --headless) unless the leg
//     names one.
// engine_args are the native argv's engine words after `--path/--rendering-driver/
// --display-driver/--headless` (`--max-fps 60` for a live receiver); `--resolution WxH` becomes the
// canvas size (default 640x360).
//
// The harness server listens on the FIXED page port (GATE7_HARNESS_PORT, or one leg's
// GATE7_PAGE_PORT), so the page's origin is `http://127.0.0.1:<port>`, which the runner passed to
// every host as GRC_LIVE_ALLOWED_ORIGINS. Its static root is the runner's evidence directory (or
// GATE7_STATIC_ROOT), with the bundle linked in as `/web-bundle` or `/gsw-bundle`. One fresh
// browser and profile per leg (D9): each browser runs on its own new profile directory (G7hp: a
// `gsw-chromium-profile-*` directory `mkdtemp`'d under the system temp dir, never under `--out` --
// GPUCache/ShaderCache/GraphiteDawnCache have no evidence value and ran ~250 MB per leg), kept
// after the leg. A warm leg (RS_RECEIVER_CACHE_MODE=warm on a cold leg's RS_RECEIVER_CACHE_DIR)
// instead starts on a copy of that cold leg's profile, so its "disk cache" is the cold leg's HTTP
// cache (Q4); the runner keeps
// every live host on one fixed port (GATE7_HOST_PORT), because that cache is keyed by the payload
// URL, port included. Per leg, as gate7-web-legs.ts's runOne: provenance.json
// (`browser-provenance`, checked on about:blank of that browser), console.jsonl, stdout.log (the
// engine's printed lines), exit-code.txt (124 on timeout), timings.json, env.txt, argv.txt and
// page-config.json.
//
// Two ways to run a leg:
//   - `browser-receiver` (one process per leg, runBrowserReceiver): launches, checks and runs.
//     SIGTERM SIGKILLs every Chromium process of the leg.
//   - `browser-daemon` (serveBrowserDaemon; what legs.sh uses): one process per runner that keeps
//     the NEXT leg's fresh browser launched and its provenance checked while the current leg runs,
//     so a leg costs only its page load and engine start (measured 2026-10-16 under load: the
//     one-shot launcher's node start-up, Chromium launch and provenance took about 7 s, which
//     made the receiver join a live host after its S = 300 frame budget). A leg is one HTTP GET
//     `/run?dir=…&port=…&timeout_s=…` from `curl` that streams `exit=<code>` at the end. When that
//     client goes away before the leg ends (the gate-1 `killed` leg SIGTERMs curl), every
//     Chromium process of the leg is SIGKILLed at once, the browser analogue of a SIGKILLed native
//     receiver (the host sees an abnormal close, 1006), and the leg's files are written with what
//     was seen so far (exit code 143). The daemon exits when its parent (the runner) is gone.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type BrowserContext,
  type CDPSession,
  chromium,
} from "@playwright/test";

import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  type BrowserProvenance,
  checkBrowserProvenance,
  collectChromiumProcesses,
  HarnessServer,
  type LaunchedBrowser,
  linkTo,
  resolvePinnedChromium,
} from "./browser-harness";
import {
  desktopLifecycleActions,
  LifecycleDriver,
  type LifecycleSpec,
  lifecycleEnvOf,
  parseLifecycleSpec,
} from "./gate7-lifecycle";
import {
  type BackingStore,
  base64url,
  parseEnvTxt,
  webStoreEnv,
} from "./gate7-web-legs";
import { type MemSamplerHandle, startMemSampler } from "./gate7k-samplers";

export type BrowserReceiverKind = "web" | "gsw";

export interface BrowserRunContext {
  kind: BrowserReceiverKind;
  bundleDir: string;
  staticRoot: string;
  buildSha256: string;
  manifestSha256?: string;
  /** G7wf (web only): the payload GET mechanism, from GATE7_WEB_FETCH. `fetch` (the default) is
   * the browser's fetch() and adds nothing to the page; `httpclient` adds
   * RS_RECEIVER_WEB_FETCH=httpclient (Godot's web HTTPClient, the pre-G7wf path, for the A/B). */
  webFetch?: WebFetch;
  log?: (line: string) => void;
}

/** G7wf: the web export's payload GET mechanism (RS_RECEIVER_WEB_FETCH). */
export type WebFetch = "fetch" | "httpclient";

/** G7wf: GATE7_WEB_FETCH, unset or "" meaning `fetch`. */
export function webFetchOf(text: string | undefined): WebFetch {
  const v = text === undefined || text === "" ? "fetch" : text;
  if (v !== "fetch" && v !== "httpclient")
    throw new Error(`GATE7_WEB_FETCH must be fetch or httpclient (got ${v})`);
  return v;
}

/** G7gd: the web export runs only the shared Rust core, so its bundle must be a
 * build-web-receiver.sh build whose build.json says `core: "rust"`; an older GDScript-core bundle
 * (no `core`, or `gdscript`) is refused. The GSW receiver always runs the Rust core. */
export function requireRustBundle(
  kind: BrowserReceiverKind,
  bundleDir: string,
): void {
  if (kind !== "web") return;
  const build = JSON.parse(
    readFileSync(join(bundleDir, "build.json"), "utf8"),
  ) as { core?: string };
  if (build.core !== "rust")
    throw new Error(
      `the web export runs only the Rust core since G7gd; ${bundleDir} is a ${build.core ?? "gdscript"}-core bundle (rebuild with build-web-receiver.sh)`,
    );
}

/** The env words the run adds to every web leg (live and file replays alike): only G7wf's fetch
 * mechanism (G7gd removed the core words; the Rust core is the bundle's only core). */
export function webPageEnv(
  ctx: Pick<BrowserRunContext, "kind" | "webFetch">,
): Record<string, string> {
  return {
    // G7wf: only the A/B's pre-G7wf arm names the mechanism; the default page env is unchanged.
    ...(ctx.kind === "web" && ctx.webFetch === "httpclient"
      ? { RS_RECEIVER_WEB_FETCH: "httpclient" }
      : {}),
    ...(ctx.kind === "web" ? webStoreEnv() : {}),
  };
}


export interface BrowserLegRequest {
  /** The receiver leg directory: holds native-env.txt / native-argv.txt, receives the evidence. */
  dir: string;
  /** The page's port (GATE7_HARNESS_PORT; origin-refused uses a second, non-allowed one). */
  port: number;
  timeoutMs: number;
}

export interface MappedBrowserLeg {
  env: Record<string, string>;
  engineArgs: string[];
  canvas: [number, number];
  /** The bearer token for the fragment ("" when the native leg had none). Never logged. */
  token: string;
  live: boolean;
  headless: boolean;
  dropped: string[];
  /** A warm leg: the cold leg's receiver directory (its page-config.json names its profile). */
  warmFrom: string | null;
  /** G7u: RS_RECEIVER_LIFECYCLE (a harness word, dropped from the page env), parsed. */
  lifecycle: LifecycleSpec | null;
  /** G7u: RS_RECEIVER_SHELL_SABOTAGE (a harness word): the page config's `sabotage`. */
  shellSabotage: "css-opacity" | null;
  /** G7v: RS_RECEIVER_DEV_PROBE (a harness word, `1` or `fit`): inject
   * browser-probes/dev-probe.js before any page script (`fit` also applies the keep-rule CSS
   * fit; device legs only). null on every other leg. */
  devProbe: "plain" | "fit" | null;
  /** G7v: RS_RECEIVER_DEV_SAMPLE (a harness word, device legs): `light` samples the phone's
   * conditions and CPU caps every 30 s; `soak` adds renderer/GPU PSS (0.2 Hz), gfxinfo GPU memory
   * and the CDP JS heap (Q13b "Samplers"). null: none. */
  devSample: "light" | "soak" | null;
  /** G7v device startup-warm (harness words RS_RECEIVER_DEV_KEEP_TAB / RS_RECEIVER_DEV_WARM, both
   * `1`): keep this leg's tab open for the next leg / navigate the tab the previous leg kept (the
   * same browser context, so its HTTP and code caches are warm). Device only. */
  devTab: { keep: boolean; warm: boolean };
}

/** G7v: browser-probes/dev-probe.js with its FIT switch set. */
export function devProbeScript(mode: "plain" | "fit"): string {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "browser-probes", "dev-probe.js"),
    "utf8",
  );
  return src.replace("/*FIT*/ false", mode === "fit" ? "true" : "false");
}

/** G7v: the page expression the harness reads dev-probe.json from (null without the probe). */
export const DEV_PROBE_REPORT_EXPRESSION =
  "window.__rsDevProbe ? window.__rsDevProbe.report() : null";

const DEFAULT_CANVAS: [number, number] = [640, 360];
const FIXED_ARGS_WITH_VALUE = new Set([
  "--path",
  "--rendering-driver",
  "--display-driver",
]);
/** GRT2b part B (results/grt.md "Part 2b"; a measured prototype, never a default): with
 * GATE7_FAST_FRAMES=1 in the daemon's environment, Chromium's frame pacing is unthrottled so a
 * rAF-driven receiver can keep up with an RS_FAST_FRAMES host (lib/legs.sh). */
export const FAST_FRAME_ARGS = [
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
] as const;
const LAUNCH_ARGS = [
  ...BROWSER_LAUNCH_ARGS,
  ...BACKGROUND_THROTTLING_ARGS,
  ...(process.env.GATE7_FAST_FRAMES === "1" ? FAST_FRAME_ARGS : []),
];

/** A host path as a URL path under the static root (refuses one outside it). */
export function urlPathUnder(staticRoot: string, hostPath: string): string {
  const rel = relative(resolve(staticRoot), resolve(hostPath));
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/"))
    throw new Error(
      `${hostPath} is outside the harness static root ${staticRoot}`,
    );
  return `/${rel.split("\\").join("/")}`;
}

/** Maps a native leg's words to the page configuration (header). */
export function mapBrowserLeg(
  staticRoot: string,
  nativeEnv: Array<[string, string]>,
  nativeArgv: string[],
  readToken: (path: string) => string = (p) => readFileSync(p, "utf8").trim(),
): MappedBrowserLeg {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  let token = "";
  let cacheDir = "";
  let lifecycle: LifecycleSpec | null = null;
  let shellSabotage: "css-opacity" | null = null;
  let devProbe: "plain" | "fit" | null = null;
  let devSample: "light" | "soak" | null = null;
  const devTab = { keep: false, warm: false };
  for (const [name, value] of nativeEnv) {
    if (!name.startsWith("RS_RECEIVER_")) {
      dropped.push(name);
      continue;
    }
    // G7u's harness words (lib/gate7-lifecycle.ts): never in the page env.
    if (name === "RS_RECEIVER_LIFECYCLE") {
      dropped.push(name);
      lifecycle = parseLifecycleSpec(value);
      continue;
    }
    if (name === "RS_RECEIVER_SHELL_SABOTAGE") {
      dropped.push(name);
      if (value !== "css-opacity")
        throw new Error(
          `RS_RECEIVER_SHELL_SABOTAGE must be css-opacity (got ${JSON.stringify(value)})`,
        );
      shellSabotage = value;
      continue;
    }
    if (name === "RS_RECEIVER_DEV_PROBE") {
      dropped.push(name);
      if (value !== "1" && value !== "fit")
        throw new Error(
          `RS_RECEIVER_DEV_PROBE must be 1 or fit (got ${JSON.stringify(value)})`,
        );
      devProbe = value === "fit" ? "fit" : "plain";
      continue;
    }
    if (name === "RS_RECEIVER_DEV_KEEP_TAB" || name === "RS_RECEIVER_DEV_WARM") {
      dropped.push(name);
      if (value !== "1")
        throw new Error(`${name} must be 1 (got ${JSON.stringify(value)})`);
      if (name === "RS_RECEIVER_DEV_KEEP_TAB") devTab.keep = true;
      else devTab.warm = true;
      continue;
    }
    if (name === "RS_RECEIVER_DEV_SAMPLE") {
      dropped.push(name);
      if (value !== "light" && value !== "soak")
        throw new Error(
          `RS_RECEIVER_DEV_SAMPLE must be light or soak (got ${JSON.stringify(value)})`,
        );
      devSample = value;
      continue;
    }
    if (name === "RS_RECEIVER_CACHE_DIR") {
      dropped.push(name);
      cacheDir = value;
      continue;
    }
    if (name === "RS_RECEIVER_TOKEN_FILE") {
      dropped.push(name);
      token = readToken(value);
      continue;
    }
    env[name] = value.startsWith("/") ? urlPathUnder(staticRoot, value) : value;
  }
  const live = env.RS_RECEIVER_MODE === "live";
  const engineArgs: string[] = [];
  let canvas: [number, number] = [...DEFAULT_CANVAS];
  let headless = false;
  // nativeArgv[0] is the binary.
  for (let i = 1; i < nativeArgv.length; i++) {
    const a = nativeArgv[i];
    if (a === "--headless") {
      headless = true;
      continue;
    }
    if (FIXED_ARGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a === "--resolution") {
      const m = /^(\d+)x(\d+)$/.exec(nativeArgv[i + 1] ?? "");
      if (!m) throw new Error(`bad --resolution ${nativeArgv[i + 1]}`);
      canvas = [Number(m[1]), Number(m[2])];
      i++;
      continue;
    }
    engineArgs.push(a);
  }
  if (live) {
    // G8g: a gate 8 live leg asks for render-stream/8 (the native leg's own word); G8kb: g8l's
    // basis leg asks for /9 (GSW's hello since G8kp, the web export's through receiver.gd since
    // G8ku); W11c: /10 and /11 (GSW's hello; the web export's /11 offer is W11e's, and refuses
    // itself until then); every other live leg speaks /7, the browsers' default.
    if (
      env.RS_RECEIVER_PROTOCOL !== undefined &&
      !["7", "8", "9", "10", "11"].includes(env.RS_RECEIVER_PROTOCOL)
    )
      throw new Error(
        `RS_RECEIVER_PROTOCOL=${env.RS_RECEIVER_PROTOCOL}: a browser receiver speaks only render-stream/7 to /11`,
      );
    env.RS_RECEIVER_PROTOCOL = env.RS_RECEIVER_PROTOCOL ?? "7";
    // The native receiver forces `applied` under --headless (frame_post_draw never fires there);
    // the browser renders, so the leg keeps the stage its native receiver actually used.
    if (headless && env.RS_RECEIVER_CREDIT_STAGE === undefined)
      env.RS_RECEIVER_CREDIT_STAGE = "applied";
  }
  // A warm leg (RS_RECEIVER_CACHE_MODE=warm on another leg's cache directory): its browser starts
  // on a copy of that leg's browser profile, whose HTTP cache is the web's "disk cache" (Q4).
  const warmFrom =
    env.RS_RECEIVER_CACHE_MODE === "warm" && cacheDir !== ""
      ? dirname(cacheDir)
      : null;
  return {
    env,
    engineArgs,
    canvas,
    token,
    live,
    headless,
    dropped,
    warmFrom,
    lifecycle,
    shellSabotage,
    devProbe,
    devSample,
    devTab,
  };
}

/** Reads a bundle's build.json digest: the web export's .pck sha256, or the GSW bundle's sha256. */
export function bundleBuildSha256(
  bundleDir: string,
  kind: BrowserReceiverKind,
): string {
  const build = JSON.parse(
    readFileSync(join(bundleDir, "build.json"), "utf8"),
  ) as { pck?: { sha256?: string }; sha256?: string };
  const sha = kind === "web" ? build.pck?.sha256 : build.sha256;
  if (!sha) throw new Error(`${bundleDir}/build.json names no build sha256`);
  return sha;
}

/** A launched browser on its own profile directory, not yet used by a leg. */
export interface PreparedBrowser {
  context: BrowserContext;
  launched: LaunchedBrowser;
  /** Checked on about:blank before the leg; null when it is checked after the leg instead (a
   * warm leg, whose browser cannot be launched ahead: it needs the cold leg's profile). */
  provenance: BrowserProvenance | null;
  profileDir: string;
  preparedMs: number;
}

function launchEnvOf(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "DISPLAY" || k === "WAYLAND_DISPLAY") continue;
    env[k] = v;
  }
  return env;
}

/** D9's launch (browser-harness.ts launchHarnessBrowser's args, executable and stripped
 * environment) on a persistent profile directory: a fresh empty one for a cold leg (D9), or a copy
 * of a cold leg's for a warm one, whose HTTP cache is then the "disk cache" it starts warm on
 * (gate7-design.md Q4). Playwright refuses `--user-data-dir` in `launch()`'s args, so a profile
 * needs launchPersistentContext; its context.browser() is the Browser provenance reads. */
async function launchOnProfile(profileDir: string): Promise<{
  context: BrowserContext;
  launched: LaunchedBrowser;
}> {
  await mkdir(profileDir, { recursive: true });
  const { executablePath } = resolvePinnedChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath,
    args: [...LAUNCH_ARGS],
    env: launchEnvOf(),
    viewport: { width: DEFAULT_CANVAS[0], height: DEFAULT_CANVAS[1] },
    deviceScaleFactor: 1,
  });
  const browser = context.browser();
  if (!browser) {
    await context.close().catch(() => {});
    throw new Error("launchPersistentContext gave no Browser");
  }
  return { context, launched: { browser, executablePath } };
}

/** `browser-provenance` on about:blank of `prepared`'s own browser. */
async function checkProvenanceOf(
  prepared: Pick<PreparedBrowser, "context" | "launched">,
): Promise<BrowserProvenance> {
  const page = await prepared.context.newPage();
  try {
    await page.goto("about:blank");
    const launchEnv: Record<string, string | undefined> = launchEnvOf();
    return await checkBrowserProvenance(
      page,
      prepared.launched,
      LAUNCH_ARGS,
      launchEnv,
    );
  } finally {
    await page.close().catch(() => {});
  }
}

/** Launches one browser on `profileDir` (fresh unless `copyFrom` names a closed cold leg's
 * profile to copy first) and, unless `checkAfter`, checks its provenance now. */
export async function prepareBrowser(
  profileDir: string,
  copyFrom?: string,
  checkAfter = false,
): Promise<PreparedBrowser> {
  const t0 = Date.now();
  if (copyFrom) await cp(copyFrom, profileDir, { recursive: true });
  const { context, launched } = await launchOnProfile(profileDir);
  try {
    const provenance = checkAfter
      ? null
      : await checkProvenanceOf({ context, launched });
    return {
      context,
      launched,
      provenance,
      profileDir,
      preparedMs: Date.now() - t0,
    };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

interface PageState {
  lines: { t: number; stream: string; line: string }[];
  error: string | null;
  exit: { code: number; t: number } | null;
  contextLost: boolean;
  wasmHeapBytes: number | null;
  backingStore: BackingStore;
  marks: { name: string; t: number }[];
  navigation: unknown[];
  resources: unknown[];
}

/** A running leg's handle: abort() SIGKILLs its Chromium processes and writes its files. */
export interface LegHandle {
  done: Promise<number>;
  abort: () => Promise<number>;
}

/** Runs one leg in `prepared` (header). The browser is closed when the leg ends. */
export function runBrowserLeg(
  ctx: BrowserRunContext,
  req: BrowserLegRequest,
  prepared: PreparedBrowser,
): LegHandle {
  const log = ctx.log ?? ((line: string) => console.error(line));
  const started = Date.now();
  const dir = resolve(req.dir);
  const staticRoot = resolve(ctx.staticRoot);
  const { launched } = prepared;
  let provenance = prepared.provenance;
  const consoleLines: string[] = [];
  let exitCode = 124;
  let state: PageState | null = null;
  let aborted = false;
  let finished = false;
  let server: HarnessServer | undefined;
  let token = "";
  // G7u: a lifecycle leg's driver (lib/gate7-lifecycle.ts); null on every other leg.
  let lifecycle: LifecycleDriver | null = null;
  // G7k (Q10 startup/soak): opt-in (GATE7_MEM_SAMPLE=1, set only for g7-k's own legs), so every
  // other group's evidence and CDP traffic is unchanged. null on every leg that does not ask.
  let memSampler: MemSamplerHandle | null = null;

  const writeEvidence = async (): Promise<void> => {
    await writeFile(
      join(dir, "console.jsonl"),
      consoleLines.join("\n") + (consoleLines.length ? "\n" : ""),
    );
    // A lifecycle leg's stdout.log is every document's lines in order (a reload: the first
    // document's, stashed by the shim at pagehide, then the last one's).
    const lines = [
      ...(lifecycle?.earlierLines ?? []).flatMap((d) =>
        d.lines.map((l) => ({ ...l, line: scrub(l.line) })),
      ),
      ...(state?.lines ?? []),
    ];
    await writeFile(
      join(dir, "stdout.log"),
      `${lines
        .map((l) => (l.stream === "err" ? `[stderr] ${l.line}` : l.line))
        .join("\n")}\n`,
    );
    if (lifecycle) await lifecycle.write();
    await writeFile(
      join(dir, "timings.json"),
      `${scrub(JSON.stringify({ schema: "render-stream-web-timings/1", wall_ms: Date.now() - started, browser_prepared_ms: prepared.preparedMs, exit: state?.exit ?? null, error: state?.error ?? null, context_lost: state?.contextLost ?? false, wasm_heap_bytes: state?.wasmHeapBytes ?? null, backing_store: state?.backingStore ?? null, marks: state?.marks ?? [], navigation: state?.navigation ?? [], resources: state?.resources ?? [], aborted, lines: (state?.lines ?? []).slice(0, 400).map((l) => ({ t: l.t, line: l.line })) }, null, 2))}\n`,
    );
    await writeFile(join(dir, "exit-code.txt"), `${exitCode}\n`);
  };
  const scrub = (text: string): string =>
    token !== "" ? text.split(token).join("<token>") : text;

  const run = async (): Promise<number> => {
    const nativeEnv = parseEnvTxt(
      readFileSync(join(dir, "native-env.txt"), "utf8"),
    );
    const nativeArgv = readFileSync(join(dir, "native-argv.txt"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const mapped = mapBrowserLeg(staticRoot, nativeEnv, nativeArgv);
    token = mapped.token;
    const outPath = nativeEnv.find(([n]) => n === "RS_RECEIVER_OUT")?.[1];
    if (!outPath) throw new Error(`${dir}: the leg has no RS_RECEIVER_OUT`);
    const evidenceDir = dirname(outPath);
    await mkdir(evidenceDir, { recursive: true });

    const bundleName = ctx.kind === "gsw" ? "gsw-bundle" : "web-bundle";
    const replaced = linkTo(
      resolve(ctx.bundleDir),
      join(staticRoot, bundleName),
    );
    if (replaced)
      console.error(
        `browser-receiver: ${bundleName} pointed at ${replaced}; now ${resolve(ctx.bundleDir)}`,
      );
    server = new HarnessServer({
      staticRoot,
      evidenceRoot: join(staticRoot, ".evidence"),
      allowedLegNonces: [],
      // G7k: the startup-warm legs need a bundle a warm profile's HTTP cache can reuse.
      staticCache: process.env.GATE7_STATIC_CACHE === "1",
    });
    const { origin } = await server.start(req.port);
    const nonce = randomBytes(8).toString("hex");
    server.addLeg(nonce, evidenceDir);
    const env: Record<string, string> = {
      ...mapped.env,
      RS_RECEIVER_EVIDENCE_URL: `/evidence/${nonce}`,
      RS_RECEIVER_BUILD_SHA256: ctx.buildSha256,
      ...(ctx.manifestSha256 && mapped.live
        ? { RS_RECEIVER_MANIFEST_SHA256: ctx.manifestSha256 }
        : {}),
      ...webPageEnv(ctx),
    };
    const pageConfig = {
      env,
      engine_args: mapped.engineArgs,
      canvas: mapped.canvas,
      sabotage: mapped.shellSabotage,
    };
    if (mapped.lifecycle) {
      const lcEnv = lifecycleEnvOf();
      if (lcEnv.env !== "desktop")
        throw new Error(
          "lifecycle: GATE7_LIFECYCLE_ENV=device reached the desktop browser harness; the device daemon runs device lifecycle legs",
        );
      lifecycle = new LifecycleDriver(
        mapped.lifecycle,
        lcEnv.env,
        ctx.kind,
        dir,
        mapped.canvas,
      );
    }
    // The URL as written down: never with the fragment.
    const url = `${origin}/${bundleName}/receiver.html?env=${base64url(JSON.stringify(pageConfig))}`;
    const navigateTo =
      mapped.token !== "" ? `${url}#token=${mapped.token}` : url;
    await writeFile(
      join(dir, "page-config.json"),
      `${JSON.stringify(
        {
          url,
          kind: ctx.kind,
          ...(ctx.kind === "web" ? { core: "rust" } : {}),
          origin,
          token: mapped.token !== "" ? "fragment" : null,
          headless_native: mapped.headless,
          profile: prepared.profileDir,
          warm_from: mapped.warmFrom,
          provenance_checked: provenance ? "before" : "after",
          ...pageConfig,
          dropped: mapped.dropped,
          ...(mapped.lifecycle
            ? {
                lifecycle: {
                  spec: mapped.lifecycle,
                  env: lifecycle?.env ?? "desktop",
                  injected: "page.addInitScript(lifecycle-shim.js)",
                },
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(dir, "env.txt"),
      `${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    await writeFile(
      join(dir, "argv.txt"),
      `${[url, ...mapped.engineArgs].join("\n")}\n`,
    );
    const writeProvenance = async (p: BrowserProvenance): Promise<boolean> => {
      await writeFile(
        join(dir, "provenance.json"),
        `${JSON.stringify(p, null, 2)}\n`,
      );
      if (!p.ok)
        await writeFile(
          join(dir, "harness-refused.txt"),
          `browser-provenance: ${p.reasons.join("; ")}\n`,
        );
      return p.ok;
    };
    if (provenance && !(await writeProvenance(provenance))) return exitCode;
    const page = await prepared.context.newPage();
    await page.setViewportSize({
      width: mapped.canvas[0],
      height: mapped.canvas[1],
    });
    page.on("console", (m) => {
      consoleLines.push(
        JSON.stringify({
          t: Date.now(),
          type: m.type(),
          text: scrub(m.text()),
        }),
      );
    });
    page.on("pageerror", (e) => {
      consoleLines.push(
        JSON.stringify({
          t: Date.now(),
          type: "pageerror",
          text: scrub(String(e)),
        }),
      );
    });
    page.on("dialog", (d) => {
      consoleLines.push(
        JSON.stringify({
          t: Date.now(),
          type: "dialog",
          text: scrub(d.message()),
        }),
      );
      d.dismiss().catch(() => {});
    });
    const readState = (): Promise<PageState | null> =>
      page
        .evaluate(() => ({
          lines: window.__rsShell?.lines ?? [],
          error: window.__rsShell?.error ?? null,
          exit: window.__rsShell?.exit ?? null,
          contextLost: window.__rsShell?.contextLost ?? false,
          wasmHeapBytes: window.__rsWasmHeap?.() ?? null,
          // G7g presentation-check: every canvas's backing store at exit, and the page's DPR.
          backingStore: {
            device_pixel_ratio: window.devicePixelRatio,
            inner: [window.innerWidth, window.innerHeight] as [number, number],
            canvases: [...document.querySelectorAll("canvas")].map((c) => ({
              width: c.width,
              height: c.height,
              client_width: c.clientWidth,
              client_height: c.clientHeight,
            })),
          },
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
    // G7u: a lifecycle leg gets the shim before any page script (it survives a reload).
    if (lifecycle)
      await page.addInitScript({ content: lifecycle.initScript() });
    // G7v: the dev probe (timing only; never on a leg that does not ask).
    if (mapped.devProbe)
      await page.addInitScript({ content: devProbeScript(mapped.devProbe) });
    await page.goto(navigateTo);
    // G7k: started after the navigation (so provenance's own about:blank page from
    // `checkProvenanceOf` is never sampled) and before the leg's own work, so a startup leg's
    // first second is covered too.
    if (process.env.GATE7_MEM_SAMPLE === "1")
      memSampler = await startMemSampler(
        launched.browser,
        page,
        join(dir, "mem-timeline.jsonl"),
      );
    const deadline = Date.now() + req.timeoutMs;
    if (lifecycle) {
      // One evaluate per poll: exit, error, the shim's pending action and its state. A poll
      // during a navigation (the reload leg; the web export's context-loss reload) rejects and
      // reads as null: never an exit.
      const lc = lifecycle;
      const actions = desktopLifecycleActions(page);
      let session: CDPSession | null = null;
      const shoot = async (): Promise<void> => {
        session ??= await prepared.context.newCDPSession(page);
        await lc.screenshot(page, session);
      };
      while (Date.now() < deadline && !aborted) {
        const snap = await LifecycleDriver.poll(page);
        if (snap?.state) lc.state = snap.state;
        if (snap?.exit) {
          exitCode = snap.exit.code;
          break;
        }
        if (snap?.error) break;
        if (snap?.pending) {
          const closed = await lc.perform(
            page,
            snap.pending,
            actions,
            async () => {
              await shoot();
              await lc.readFinal(page);
              state = await readState();
            },
          );
          if (closed) {
            // The closed tab is the leg's normal end (gate 1d's killed receiver, gracefully).
            exitCode = 0;
            break;
          }
          continue;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (aborted) return exitCode;
      if (!lc.closed) {
        await shoot();
        await lc.readFinal(page);
      }
    } else {
      while (Date.now() < deadline && !aborted) {
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
      if (aborted) return exitCode;
    }
    if (!lifecycle?.closed) state = await readState();
    if (mapped.devProbe) {
      const probe = await page
        .evaluate(DEV_PROBE_REPORT_EXPRESSION)
        .catch(() => null);
      await writeFile(
        join(dir, "dev-probe.json"),
        `${JSON.stringify(probe ?? { schema: "render-stream-gate7-dev-probe/1", error: "no report" })}\n`,
      );
    }
    if (state && token !== "") {
      // Defence in depth: the receiver never prints the token, but nothing written here may.
      state.lines = state.lines.map((l) => ({ ...l, line: scrub(l.line) }));
    }
    await page.close().catch(() => {});
    if (!provenance) {
      // A warm leg's browser (launched on the cold leg's profile when the leg was asked for):
      // the same check, on the same browser, after the leg.
      provenance = await checkProvenanceOf(prepared);
      await writeProvenance(provenance);
    }
    return exitCode;
  };

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    // Awaited, and bounded inside stop() itself: `prepared.context.close()` below must never
    // race an in-flight CDP session this module still owns.
    await memSampler?.stop().catch(() => {});
    await writeEvidence().catch((err) =>
      log(`browser-receiver: writing evidence failed: ${String(err)}`),
    );
    await prepared.context.close().catch(() => {});
    await server?.stop().catch(() => {});
  };

  const done = run()
    .catch(async (err: unknown) => {
      log(`browser-receiver: ${relative(staticRoot, dir)}: ${String(err)}`);
      await writeFile(
        join(dir, "launcher-error.txt"),
        `${String(err)}\n`,
      ).catch(() => {});
      return exitCode;
    })
    .then(async (code) => {
      if (!aborted) {
        await finish();
        log(
          `browser-receiver: ${relative(staticRoot, dir)} exit=${code} (${Date.now() - started} ms)`,
        );
      }
      return code;
    });

  const abort = async (): Promise<number> => {
    if (aborted || finished) return exitCode;
    aborted = true;
    exitCode = 143;
    const fresh = await Promise.race([
      collectChromiumProcesses(launched.browser)
        .then((ps) => ps.map((p) => p.pid))
        .catch(() => [] as number[]),
      new Promise<number[]>((r) => setTimeout(() => r([]), 500)),
    ]);
    const pids = [
      ...new Set([
        ...fresh,
        ...(provenance?.processes ?? []).map((p) => p.pid),
      ]),
    ];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    log(
      `browser-receiver: ${relative(staticRoot, dir)} aborted: SIGKILLed ${pids.length} Chromium processes`,
    );
    await finish();
    return exitCode;
  };
  return { done, abort };
}

/** The cold leg's profile a warm leg starts on (its page-config.json `profile`), or null for a
 * cold leg. Throws when a warm leg's cold leg ran no browser. */
export function warmProfileOf(dir: string, staticRoot: string): string | null {
  const nativeEnv = parseEnvTxt(
    readFileSync(join(dir, "native-env.txt"), "utf8"),
  );
  const nativeArgv = readFileSync(join(dir, "native-argv.txt"), "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const { warmFrom } = mapBrowserLeg(
    staticRoot,
    nativeEnv,
    nativeArgv,
    () => "",
  );
  if (!warmFrom) return null;
  const page = join(warmFrom, "page-config.json");
  if (!existsSync(page))
    throw new Error(
      `warm leg ${dir}: its cold leg ${warmFrom} ran no browser (no page-config.json)`,
    );
  const profile = (
    JSON.parse(readFileSync(page, "utf8")) as { profile?: string }
  ).profile;
  if (!profile || !existsSync(profile))
    throw new Error(
      `warm leg ${dir}: the cold leg's profile ${profile} is gone`,
    );
  return profile;
}

/** The one-shot launcher (`gate7-tool.ts browser-receiver`): prepare, run, SIGTERM aborts. Its
 * profile is a fresh directory under the system temp directory (G7hp), removed on every exit --
 * normal return, a thrown error from `prepareBrowser`/`runBrowserLeg`, and SIGTERM (after
 * `leg.abort()` has SIGKILLed the leg's Chromium processes, so nothing still holds the files). */
export async function runBrowserReceiver(
  ctx: BrowserRunContext,
  req: BrowserLegRequest,
): Promise<number> {
  const warm = warmProfileOf(resolve(req.dir), resolve(ctx.staticRoot));
  const profileRoot = await mkdtemp(join(tmpdir(), "gsw-chromium-profile-"));
  const cleanup = (): Promise<void> =>
    rm(profileRoot, { recursive: true, force: true }).catch(() => {});
  try {
    const prepared = await prepareBrowser(
      join(profileRoot, "p"),
      warm ?? undefined,
      warm !== null,
    );
    const leg = runBrowserLeg(ctx, req, prepared);
    const onTerm = (): void => {
      leg
        .abort()
        .finally(cleanup)
        .finally(() => process.exit(143));
    };
    process.on("SIGTERM", onTerm);
    try {
      return await leg.done;
    } finally {
      process.off("SIGTERM", onTerm);
    }
  } finally {
    await cleanup();
  }
}

/** `gate7-tool.ts browser-daemon` (header): serves legs one at a time on 127.0.0.1:<port 0>,
 * writes `{port, pid}` to `readyFile`, keeps one prepared browser spare, and exits when
 * `parentPid` is gone. */
export async function serveBrowserDaemon(
  ctx: BrowserRunContext,
  readyFile: string,
  parentPid: number,
  opts: { spare?: "during" | "after" } = {},
): Promise<void> {
  // G7r: `after` launches the next leg's spare browser only once this leg has finished, so no
  // Chromium start-up (process spawn, GPU process, provenance page) runs inside a timing leg's
  // measured window; `during` (G7l's default) overlaps it with the leg to save wall time.
  const spareAfter = opts.spare === "after";
  const log = ctx.log ?? ((line: string) => console.error(line));
  // One profile directory per browser, never reused by a cold leg (D9), kept for warm legs (a
  // warm leg copies a sibling cold leg's profile, discovered lazily from that leg's
  // page-config.json, so no single profile can be retired before this daemon itself shuts down).
  // G7hp: the root is a `gsw-chromium-profile-*` directory `mkdtemp`'d under the system temp dir,
  // never under the evidence tree (a profile's GPUCache/ShaderCache/GraphiteDawnCache run ~250 MB
  // per leg and have no evidence value); `shutdown` below removes it whole, and the `process.on
  // ("exit", ...)` handler is a synchronous last-resort net for a crash that skips `shutdown`.
  const profileRoot = await mkdtemp(join(tmpdir(), "gsw-chromium-profile-"));
  process.on("exit", () => {
    try {
      rmSync(profileRoot, { recursive: true, force: true });
    } catch {
      // best-effort net; the graceful `shutdown` path below already removed it
    }
  });
  let profileCount = 0;
  const nextProfile = (): string => join(profileRoot, String(++profileCount));
  const prepareSpare = (): Promise<PreparedBrowser> => {
    const p = prepareBrowser(nextProfile());
    p.catch((err) => log(`browser-daemon: preparing failed: ${String(err)}`));
    return p;
  };
  let spare: Promise<PreparedBrowser> | null = spareAfter
    ? null
    : prepareSpare();
  let busy = false;
  const takeSpare = async (): Promise<PreparedBrowser> => {
    const p = spare ?? prepareSpare();
    spare = null;
    try {
      return await p;
    } catch {
      return prepareBrowser(nextProfile());
    }
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/run") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (busy) {
      response.writeHead(409);
      response.end("busy\n");
      return;
    }
    const dir = url.searchParams.get("dir") ?? "";
    const port = Number(url.searchParams.get("port"));
    const timeoutS = Number(url.searchParams.get("timeout_s") ?? "180");
    if (!dir.startsWith("/") || !Number.isInteger(port) || port <= 0) {
      response.writeHead(400);
      response.end("dir (absolute) and port are required\n");
      return;
    }
    busy = true;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    void (async () => {
      let leg: LegHandle | undefined;
      let gone = false;
      response.on("close", () => {
        if (!response.writableEnded) {
          gone = true;
          void leg?.abort();
        }
      });
      try {
        const warm = warmProfileOf(dir, resolve(ctx.staticRoot));
        // A warm leg starts on a copy of its cold leg's profile, launched now (its provenance is
        // checked after the leg); the spare stays for the next cold leg.
        const prepared = warm
          ? await prepareBrowser(nextProfile(), warm, true)
          : await takeSpare();
        // The next leg's browser launches and is checked while this one runs (G7l), or after it
        // (G7r's timing legs, `--spare after`: below).
        if (!spare && !spareAfter) spare = prepareSpare();
        response.write(
          `started ${dir} (browser prepared in ${prepared.preparedMs} ms)\n`,
        );
        leg = runBrowserLeg(
          ctx,
          { dir, port, timeoutMs: timeoutS * 1000 },
          prepared,
        );
        if (gone) await leg.abort();
        const code = await leg.done;
        response.end(`exit=${code}\n`);
      } catch (err) {
        response.end(`error ${String(err)}\nexit=124\n`);
      } finally {
        busy = false;
        if (spareAfter && !spare) spare = prepareSpare();
      }
    })();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await writeFile(readyFile, `${JSON.stringify({ port, pid: process.pid })}\n`);
  log(
    `browser-daemon: listening on 127.0.0.1:${port} (kind ${ctx.kind}, spare ${spareAfter ? "after" : "during"} each leg)`,
  );
  const shutdown = async (): Promise<void> => {
    server.close();
    const s = spare;
    spare = null;
    if (s) await s.then((p) => p.context.close()).catch(() => {});
    await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      if (!busy) void shutdown();
    }
  }, 1000).unref();
  await new Promise<never>(() => {});
}
