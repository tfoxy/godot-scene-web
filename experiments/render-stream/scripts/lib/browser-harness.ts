// Gate 7 browser harness (G7h; protocol/gate7-design.md "Q6. Browser harness", D9, D22). This is
// the ONLY place that launches Chromium for gate 7 -- every later increment (G7e, G7a, G7b, G7l,
// G7g, G7u, G7r, G7k) launches through `launchHarnessBrowser` / `HarnessServer` / `SuspensionController`
// here, never raw Playwright, so the D9 flags, the stripped environment and the provenance guard
// are never duplicated or drifted.
//
// NEVER headed, never Xvfb, never a desktop window (memory xvfb-does-not-isolate-on-wayland).
// `headless: false` is deliberate: it is what stops Playwright adding its OWN old-headless
// switches, while `--headless=new --enable-gpu --use-angle=vulkan` is what actually removes the
// window and keeps the real GPU -- the exact pattern `packages/test-harness/test/canvasGlyphPixelXvfb.test.ts`
// established, pinned here for gate 7 (D9).
//
// PROVENANCE IS A GATE, NOT A LOG LINE. `checkBrowserProvenance` refuses the leg
// (`browser-provenance`, D22: a harness refusal, never a `success`) unless the renderer names
// ANGLE, NVIDIA and Vulkan; no Chromium process holds a Wayland socket FD; `DISPLAY` and
// `WAYLAND_DISPLAY` are unset in the launch environment; and the binary's sha256 matches
// `EXPECTED_CHROMIUM_SHA256`. A silent SwiftShader fallback would otherwise keep every later suite
// green while describing software, exactly the failure mode `canvasGlyphPixelXvfb.test.ts`'s
// `assertHardwareRenderer` already guards against for the pixel suites.

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, normalize } from "node:path";

import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "@playwright/test";

// ---------------------------------------------------------------------------------------------
// D9: launch flags. These are the ONLY flags that change what Chromium renders with or into --
// anything else (viewport, user-data-dir, …) is per-call in `launchHarnessBrowser`'s options.
// ---------------------------------------------------------------------------------------------

/** D9's always-on flags: real GPU (RTX 2060) through ANGLE/Vulkan, no window, DPR 1, sRGB. Never
 * `--enable-features=Vulkan` (memory webgpu-parity-findings: that one breaks WebGL canvases here
 * by moving the whole GPU process -- `--use-angle=vulkan` is the narrow, correct flag). */
export const BROWSER_LAUNCH_ARGS = [
  "--headless=new",
  "--enable-gpu",
  "--use-angle=vulkan",
  "--force-device-scale-factor=1",
  "--force-color-profile=srgb",
] as const;

/** D9: layered on for every leg EXCEPT suspension legs, which need Chromium's REAL throttling
 * heuristics active to be worth measuring. */
export const BACKGROUND_THROTTLING_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
] as const;

/** D9's sabotage flag: forces software rendering so `checkBrowserProvenance` can be proven to
 * refuse (G7h's sabotage case). Never used outside that one self-test. */
export const SABOTAGE_SWIFTSHADER_ARGS = [
  "--headless=new",
  "--enable-gpu",
  "--use-angle=swiftshader",
] as const;

/**
 * chromium-1223 / "Google Chrome for Testing" 148.0.7778.96's `chrome` binary sha256, recorded
 * 2026-10-14 from the cache this repo's pinned `@playwright/test` (1.60.0, `browsers.json`
 * revision 1223) resolves via `chromium.executablePath()`. `checkBrowserProvenance` refuses the
 * leg if a differently provisioned box's cache disagrees -- this is the "recorded one" D9 means.
 */
export const EXPECTED_CHROMIUM_SHA256 =
  "adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f";
export const EXPECTED_CHROMIUM_VERSION = "148.0.7778.96";

export interface LaunchOptions {
  /** D9: on by default (deterministic legs); omit (false) for suspension legs so Chromium's own
   * backgrounding heuristics stay live. */
  disableBackgroundThrottling?: boolean;
  /** Extra args layered on top of D9's fixed set (e.g. SABOTAGE_SWIFTSHADER_ARGS replaces
   * `--use-angle=vulkan`, which is why that constant is a full override, not an addition). */
  args?: readonly string[];
  /** A fresh profile per cold leg (D9); omit for a `warm` leg that must reuse one. */
  userDataDir?: string;
}

export interface LaunchedBrowser {
  browser: Browser;
  executablePath: string;
}

/** Launches Chromium under D9. `headless: false` + `--headless=new` is the deliberate pairing
 * (see header); the environment is stripped of `DISPLAY`/`WAYLAND_DISPLAY` regardless of what
 * this process inherited, because a leaked `WAYLAND_DISPLAY` is exactly what let Ozone escape
 * Xvfb containment in the prior finding (memory xvfb-does-not-isolate-on-wayland). */
export async function launchHarnessBrowser(
  options: LaunchOptions = {},
): Promise<LaunchedBrowser> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "DISPLAY" || k === "WAYLAND_DISPLAY") continue;
    env[k] = v;
  }
  const args = options.args
    ? [...options.args]
    : [
        ...BROWSER_LAUNCH_ARGS,
        ...(options.disableBackgroundThrottling === false
          ? []
          : BACKGROUND_THROTTLING_ARGS),
      ];
  const executablePath = chromium.executablePath();
  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: [...args],
    env,
  });
  return { browser, executablePath };
}

// ---------------------------------------------------------------------------------------------
// Provenance (D9, D22 `browser-provenance`).
// ---------------------------------------------------------------------------------------------

export interface ChromiumProcessInfo {
  pid: number;
  type: string;
  waylandFds: number;
}

/**
 * Every Chromium process behind `browser` (browser, GPU, renderer, network/storage services),
 * straight from CDP's `SystemInfo.getProcessInfo` -- the authoritative source, since this
 * Playwright build's `Browser` client object exposes no `.process()` (confirmed empirically:
 * `typeof browser.process === "undefined"` here, unlike older Playwright docs), so there is no OS
 * pid to walk a `ps` tree from. `SystemInfo.getProcessInfo` is a BROWSER-TARGET-ONLY command
 * (`newBrowserCDPSession`, not a page session -- sending it on a page session throws "only
 * supported on the browser target" and was observed to leave that session unable to close
 * cleanly afterwards, so this function always opens its own short-lived session and detaches it).
 */
export async function collectChromiumProcesses(
  browser: Browser,
): Promise<ChromiumProcessInfo[]> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = (await session.send(
      "SystemInfo.getProcessInfo" as never,
    )) as {
      processInfo: { type: string; id: number }[];
    };
    return result.processInfo.map((p) => ({
      pid: p.id,
      type: p.type,
      waylandFds: countWaylandFds(p.id),
    }));
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Counts `/proc/<pid>/fd` entries that resolve to a Wayland socket. Wayland sockets show a real
 * filesystem path (unlike X11's abstract sockets, which appear as `socket:[inode]` with no path
 * and are not evidence of anything) -- memory xvfb-does-not-isolate-on-wayland states the rule
 * this function implements: COUNT WAYLAND FDs, NEVER X11 ONES. */
export function countWaylandFds(pid: number): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return 0; // Process already gone, or we lack permission -- not evidence of a Wayland FD.
  }
  for (const entry of entries) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${entry}`);
      if (target.includes("wayland")) count++;
    } catch {
      // The fd closed between readdir and readlink -- ignore, it is not a Wayland socket now.
    }
  }
  return count;
}

export interface BrowserProvenance {
  ok: boolean;
  reasons: string[];
  renderer: string | null;
  vendor: string | null;
  extensions: string[];
  executablePath: string;
  binarySha256: string;
  version: string | null;
  args: readonly string[];
  displayEnvUnset: boolean;
  processes: ChromiumProcessInfo[];
  totalWaylandFds: number;
}

/**
 * The `browser-provenance` check (D9, D22): refuses (`ok: false`, never a `success`) unless the
 * renderer string names ANGLE, NVIDIA and Vulkan; no Chromium process (browser, GPU, renderer,
 * zygote) holds a Wayland FD; `DISPLAY`/`WAYLAND_DISPLAY` were unset in the launch environment;
 * and the binary sha256 matches `EXPECTED_CHROMIUM_SHA256`. Must be run against a page that has
 * already loaded `browser-probes/index.html` (or any page with a WebGL2 context), because the
 * renderer string is read from `WEBGL_debug_renderer_info`, never merely logged.
 */
export async function checkBrowserProvenance(
  page: Page,
  launched: LaunchedBrowser,
  launchArgs: readonly string[],
  launchEnv: Record<string, string | undefined>,
): Promise<BrowserProvenance> {
  const reasons: string[] = [];
  const glInfo = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return { webgl2: false as const };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      webgl2: true as const,
      renderer: dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : null,
      vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
      extensions: gl.getSupportedExtensions() ?? [],
    };
  });
  const renderer = glInfo.webgl2 ? glInfo.renderer : null;
  const vendor = glInfo.webgl2 ? glInfo.vendor : null;
  const extensions = glInfo.webgl2 ? glInfo.extensions : [];

  if (!glInfo.webgl2) {
    reasons.push("no-webgl2: the probe page has no WebGL2 context");
  } else if (!renderer) {
    reasons.push("WEBGL_debug_renderer_info reported no renderer string");
  } else if (
    !/ANGLE/i.test(renderer) ||
    !/NVIDIA/i.test(renderer) ||
    !/Vulkan/i.test(renderer)
  ) {
    reasons.push(
      `renderer "${renderer}" does not name ANGLE, NVIDIA and Vulkan together (SwiftShader or another backend may have been selected)`,
    );
  }

  const binarySha256 = sha256File(launched.executablePath);
  if (binarySha256 !== EXPECTED_CHROMIUM_SHA256) {
    reasons.push(
      `binary sha256 ${binarySha256} != recorded ${EXPECTED_CHROMIUM_SHA256} for ${launched.executablePath}`,
    );
  }

  const version = await page
    .evaluate(() => navigator.userAgent)
    .then((ua) => ua.match(/Chrome\/(\S+)/)?.[1] ?? null)
    .catch(() => null);

  const processes = await collectChromiumProcesses(launched.browser);
  const totalWaylandFds = processes.reduce((sum, p) => sum + p.waylandFds, 0);
  if (totalWaylandFds > 0) {
    reasons.push(
      `${totalWaylandFds} Wayland fd(s) open across ${processes.length} Chromium process(es) -- Ozone escaped containment`,
    );
  }

  const displayEnvUnset =
    launchEnv.DISPLAY === undefined && launchEnv.WAYLAND_DISPLAY === undefined;
  if (!displayEnvUnset) {
    reasons.push(
      "DISPLAY or WAYLAND_DISPLAY was set in the launch environment",
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    renderer,
    vendor,
    extensions,
    executablePath: launched.executablePath,
    binarySha256,
    version,
    args: launchArgs,
    displayEnvUnset,
    processes,
    totalWaylandFds,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Q6 "Servers": a minimal loopback HTTP harness. One instance serves the page origin (static GET
// + evidence PUT, D10); G7h's self-test also runs a second instance in `resource` role to give
// probes 5 and 6 a genuinely cross-origin target for preflight/cache behaviour.
// ---------------------------------------------------------------------------------------------

export interface HarnessServerOptions {
  /** Readonly static root (the probe page, a bundle, recordings, …), served at `GET /<path>`. */
  staticRoot: string;
  /** Evidence PUTs land under `<evidenceRoot>/<legNonce>/<path>` (D10). Required even if a given
   * server never serves `resource` traffic. */
  evidenceRoot: string;
  /** The only leg nonces this server will accept a PUT under (D10: "into that leg's directory
   * only"). A PUT whose nonce segment is not in this set, or whose path resolves outside that
   * leg's own directory, is rejected with 403 -- this is the "evidence PUT outside the leg nonce
   * rejected" check (G7h `Checks`). */
  allowedLegNonces: readonly string[];
  /** `resource` role additionally answers CORS preflights and GETs with cache headers for
   * `Authorization`-bearing cross-origin fetches (probes 5 and 6); `page` role is a plain static
   * + evidence server. Both roles share the same evidence-PUT guard. */
  role?: "page" | "resource";
  /** `resource` role only: origins allowed to receive `Access-Control-Allow-Origin` (D3). */
  allowedOrigins?: readonly string[];
}

export interface ResourceHitCounts {
  get: number;
  options: number;
}

/** A loopback HTTP server for gate 7's browser legs (Q6 "Servers", D10). `start()`/`stop()` are
 * the whole lifecycle; `getHit(path)` exposes per-path GET/OPTIONS counts for the `resource` role
 * so a probe can tell "served from the browser's own cache" (no new hit) apart from "refetched". */
export class HarnessServer {
  private server: Server | undefined;
  private readonly hits = new Map<string, ResourceHitCounts>();
  private readonly resourceBodies = new Map<
    string,
    { body: Buffer; contentType: string }
  >();

  constructor(private readonly options: HarnessServerOptions) {}

  /** `resource` role only: registers a GET body served at `path` with `Cache-Control: private,
   * max-age=31536000, immutable` and a stable `ETag` (the same policy `capture/src/rs_ws.cpp`
   * uses for `/resources/sha256/<hash>`, reused here so probe 6 measures the real production
   * cache header, not a stand-in). */
  setResource(
    path: string,
    body: Buffer,
    contentType = "application/octet-stream",
  ): void {
    this.resourceBodies.set(path, { body, contentType });
  }

  getHits(path: string): ResourceHitCounts {
    return this.hits.get(path) ?? { get: 0, options: 0 };
  }

  resetHits(): void {
    this.hits.clear();
  }

  async start(port = 0): Promise<{ port: number; origin: string }> {
    await mkdir(this.options.evidenceRoot, { recursive: true });
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((res, rej) => {
      this.server?.listen(port, "127.0.0.1", () => res());
      this.server?.on("error", rej);
    });
    const addr = this.server?.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return { port: actualPort, origin: `http://127.0.0.1:${actualPort}` };
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => this.server?.close(() => res()));
  }

  private bumpHit(path: string, kind: "get" | "options"): void {
    const cur = this.hits.get(path) ?? { get: 0, options: 0 };
    cur[kind]++;
    this.hits.set(path, cur);
  }

  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin || !(this.options.allowedOrigins ?? []).includes(origin))
      return {};
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    };
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;

    if (req.method === "OPTIONS") {
      this.bumpHit(url.pathname, "options");
      const headers = {
        ...this.corsHeaders(origin),
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "authorization",
        "Access-Control-Max-Age": "7200",
      };
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/evidence/")) {
      await this.handlePut(url, req, res);
      return;
    }

    if (
      this.options.role === "resource" &&
      this.resourceBodies.has(url.pathname)
    ) {
      this.bumpHit(url.pathname, "get");
      const entry = this.resourceBodies.get(url.pathname);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      const etag = `"${createHash("sha256").update(entry.body).digest("hex").slice(0, 16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ...this.corsHeaders(origin), ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        ...this.corsHeaders(origin),
        "Content-Type": entry.contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: etag,
        "Content-Length": String(entry.body.length),
      });
      res.end(entry.body);
      return;
    }

    if (req.method === "GET") {
      await this.handleStaticGet(url, res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private async handleStaticGet(url: URL, res: ServerResponse): Promise<void> {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = normalize(join(this.options.staticRoot, rel));
    const root = normalize(this.options.staticRoot);
    if (!target.startsWith(root)) {
      res.writeHead(403);
      res.end("outside static root");
      return;
    }
    if (!existsSync(target)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(target) });
    createReadStream(target).pipe(res);
  }

  /**
   * D10's rule, enforced: a PUT lands only under `<evidenceRoot>/<legNonce>/<path>`, and only for
   * a `legNonce` this server was constructed with (`allowedLegNonces`). Both a nonce outside the
   * allowlist and a `..`-escaping path are 403, never a silent write elsewhere -- this is G7h's
   * "an evidence PUT outside the leg nonce rejected" check.
   */
  private async handlePut(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean); // ["evidence", "<nonce>", ...rest]
    const nonce = parts[1];
    const restParts = parts.slice(2);
    if (
      !nonce ||
      !this.options.allowedLegNonces.includes(nonce) ||
      restParts.length === 0
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("rejected: unknown leg nonce");
      return;
    }
    const legRoot = normalize(join(this.options.evidenceRoot, nonce));
    const target = normalize(join(legRoot, ...restParts));
    if (!target.startsWith(`${legRoot}/`) && target !== legRoot) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("rejected: path escapes leg directory");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    res.writeHead(200);
    res.end("ok");
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

// ---------------------------------------------------------------------------------------------
// Suspension controller (D14, Q6 "Suspension controller", Q1b). See the G7h "As built" note in
// gate7-design.md: on this Chromium build (148.0.7778.96, headless=new) NONE of Q1b's three
// candidate hide mechanisms change `document.visibilityState`, and `Page.setWebLifecycleState`
// alone does not stop rAF callbacks or timers either -- every method below is still implemented
// because later increments (G7u) need a controller to call, but each returns `tookEffect` from an
// actual in-page measurement rather than asserting success from the CDP call's own return value.
// ---------------------------------------------------------------------------------------------

export interface SuspensionResult {
  mechanism: string;
  attemptedAtMs: number;
  visibilityStateAfter: string | null;
  /** Measured, not assumed: true only if rAF/timer activity actually stopped or visibility
   * actually changed after the call. See the header note -- expect `false` on this build. */
  tookEffect: boolean;
  detail: string;
}

export class SuspensionController {
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly session: CDPSession,
  ) {}

  /** Candidate 1 of Q1b: opens an auxiliary page and activates its target. Measured effect: see
   * header. */
  async hideViaActivateAuxiliary(): Promise<SuspensionResult> {
    const before = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    const aux = await this.context.newPage();
    await aux.goto("about:blank");
    const auxSession = await this.context.newCDPSession(aux);
    const info = await auxSession.send("Target.getTargetInfo");
    await auxSession.send("Target.activateTarget", {
      targetId: info.targetInfo.targetId,
    });
    await this.page.waitForTimeout(200);
    const visibilityStateAfter = await this.page.evaluate(
      () => document.visibilityState,
    );
    const after = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    // Detach before close -- an attached CDP session outliving its target's close was the one
    // leak candidate found while hardening this controller (G7h "As built").
    await auxSession.detach().catch(() => {});
    await aux.close();
    return {
      mechanism: "Target.activateTarget(auxiliary page)",
      attemptedAtMs: Date.now(),
      visibilityStateAfter,
      tookEffect: visibilityStateAfter === "hidden" || after === before,
      detail: `rafCount ${before} -> ${after} over 200ms`,
    };
  }

  /** Candidate 2 of Q1b. Measured effect: see header. */
  async hideViaMinimize(): Promise<SuspensionResult> {
    const before = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    const win = await this.session.send("Browser.getWindowForTarget");
    await this.session.send("Browser.setWindowBounds", {
      windowId: (win as { windowId: number }).windowId,
      bounds: { windowState: "minimized" },
    });
    await this.page.waitForTimeout(200);
    const visibilityStateAfter = await this.page.evaluate(
      () => document.visibilityState,
    );
    const after = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    await this.session.send("Browser.setWindowBounds", {
      windowId: (win as { windowId: number }).windowId,
      bounds: { windowState: "normal" },
    });
    return {
      mechanism: "Browser.setWindowBounds(minimized)",
      attemptedAtMs: Date.now(),
      visibilityStateAfter,
      tookEffect: visibilityStateAfter === "hidden" || after === before,
      detail: `rafCount ${before} -> ${after} over 200ms`,
    };
  }

  /** Candidate 3 of Q1b ("Emulation focus/visibility overrides"): the only CDP command in that
   * family, `Emulation.setFocusEmulationEnabled`, simulates FOCUS, not occlusion -- it is included
   * for completeness of the probe, not because it was expected to hide anything. */
  async hideViaFocusEmulation(): Promise<SuspensionResult> {
    const before = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    await this.session.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    await this.page.waitForTimeout(200);
    const visibilityStateAfter = await this.page.evaluate(
      () => document.visibilityState,
    );
    const after = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    await this.session.send("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    return {
      mechanism: "Emulation.setFocusEmulationEnabled(false)",
      attemptedAtMs: Date.now(),
      visibilityStateAfter,
      tookEffect: visibilityStateAfter === "hidden" || after === before,
      detail: `rafCount ${before} -> ${after} over 200ms`,
    };
  }

  /** D14's "frozen" leg: `Page.setWebLifecycleState({state:"frozen"})`. Measured over `sampleMs`
   * of real time with NO devtools polling in between (a `page.evaluate` round trip during the
   * window could itself pump tasks) -- the window is measured passively via a resolved promise
   * timer in Node, then read once at the end. */
  async freeze(sampleMs = 1000): Promise<SuspensionResult> {
    const before = await this.page.evaluate(
      () => window.__probe?.rafCount() ?? -1,
    );
    await this.session.send("Page.setWebLifecycleState", { state: "frozen" });
    await new Promise((r) => setTimeout(r, sampleMs));
    const visibilityStateAfter = await this.page
      .evaluate(() => document.visibilityState)
      .catch(() => "eval-failed");
    const after = await this.page
      .evaluate(() => window.__probe?.rafCount() ?? -1)
      .catch(() => -1);
    await this.session.send("Page.setWebLifecycleState", { state: "active" });
    return {
      mechanism: "Page.setWebLifecycleState(frozen)",
      attemptedAtMs: Date.now(),
      visibilityStateAfter,
      tookEffect: after === before,
      detail: `rafCount ${before} -> ${after} over ${sampleMs}ms`,
    };
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async close(): Promise<void> {
    await this.page.close();
  }

  /** `WEBGL_lose_context` from inside the page -- the one suspension mechanism that is a real web
   * API rather than a CDP override, so it DOES take effect (D14: GSW recovers in place, the web
   * export only alerts "please reload", `lgd.js:735-738`). */
  async loseContext(): Promise<boolean> {
    return this.page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
      const ext = gl?.getExtension("WEBGL_lose_context");
      if (!ext) return false;
      ext.loseContext();
      return true;
    });
  }
}

declare global {
  interface Window {
    __probe?: {
      rafCount: () => number;
      resetRafCount: () => void;
      timerCount: () => number;
      resetTimerCount: () => void;
      visibilityEvents: () => { t: number; state: string }[];
      visibilityState: () => string;
      canvasRect: () => { width: number; height: number };
      glInfo: () => {
        webgl2: boolean;
        renderer?: string | null;
        vendor?: string | null;
        extensions?: string[];
        hasTimerQuery?: boolean;
        linkError?: string | null;
      };
      drawFlatColor: (r: number, g: number, b: number, a?: number) => void;
      readPixelsRect: (x: number, y: number, w: number, h: number) => number[];
    };
  }
}
