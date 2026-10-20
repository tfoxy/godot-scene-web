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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
} from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "@playwright/test";

// G7d (D24): the device path IS perf-harness's, imported, never copied.
import {
  type Adb,
  AdbError,
  type DeviceBrowser,
  type DeviceConditions,
  openDeviceBrowser,
  reverseServerPort,
} from "../../../../packages/perf-harness/src/device";

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

/**
 * GRT: where the pinned Chromium is launched from. Playwright's shared cache
 * (`~/.cache/ms-playwright/`, or PLAYWRIGHT_BROWSERS_PATH) is garbage-collected by ANY repo's
 * `playwright install` on this box -- at 03:56 on 2026-10-20 another repo's install deleted
 * `chromium-1223` and every browser leg failed at launch. So the harness launches a repo-private
 * copy, `<RS_PRIVATE_BROWSERS_DIR or ~/.cache/godot-render-stream/ms-playwright>/chromium-1223/`,
 * which no other repo's Playwright knows about:
 *   1. the private copy, when its `chrome` matches EXPECTED_CHROMIUM_SHA256;
 *   2. else, when the shared cache's binary matches, the private copy is SEEDED from it (`cp -a` of
 *      the whole revision directory into a temp dir, sha-checked, moved into place under a flock;
 *      nothing is ever downloaded) and launched; if seeding fails, the verified shared binary is
 *      launched;
 *   3. else it throws, naming both paths.
 * checkBrowserProvenance still hashes whatever was launched against the same pin.
 */
export const PRIVATE_BROWSERS_DIR =
  process.env.RS_PRIVATE_BROWSERS_DIR ??
  join(homedir(), ".cache", "godot-render-stream", "ms-playwright");

export interface PinnedChromium {
  executablePath: string;
  /** private: the repo-private copy; seeded: copied there now; shared: Playwright's cache. */
  source: "private" | "seeded" | "shared";
  privatePath: string;
  sharedPath: string;
}

let pinnedChromium: PinnedChromium | undefined;

/** The pinned Chromium to launch (header above; memoized per process). */
export function resolvePinnedChromium(): PinnedChromium {
  if (pinnedChromium && existsSync(pinnedChromium.executablePath))
    return pinnedChromium;
  const sharedPath = chromium.executablePath();
  // `<browsers root>/chromium-<rev>/<sub path>`: the private copy keeps the same layout.
  let revDir = dirname(sharedPath);
  while (
    !basename(revDir).startsWith("chromium-") &&
    dirname(revDir) !== revDir
  )
    revDir = dirname(revDir);
  const privateRev = join(PRIVATE_BROWSERS_DIR, basename(revDir));
  const privatePath = join(privateRev, relative(revDir, sharedPath));
  const matches = (p: string): boolean =>
    existsSync(p) && sha256File(p) === EXPECTED_CHROMIUM_SHA256;
  const done = (
    executablePath: string,
    source: PinnedChromium["source"],
  ): PinnedChromium => {
    pinnedChromium = { executablePath, source, privatePath, sharedPath };
    return pinnedChromium;
  };
  if (matches(privatePath)) return done(privatePath, "private");
  if (matches(sharedPath)) {
    // Under a flock on <private dir>/.seed.lock, so concurrent seeders never replace a copy
    // another process already verified and launched: the check-and-replace is one critical
    // section, and only a copy that does NOT match is ever replaced.
    mkdirSync(PRIVATE_BROWSERS_DIR, { recursive: true });
    const seed = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
exec 9>"$PRIVATE_DIR/.seed.lock"
flock 9
ok() { [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$SHA" ]; }
if ok "$PRIVATE_BIN"; then echo present; exit 0; fi
tmp="$PRIVATE_REV.tmp-$$"
rm -rf "$tmp"
cp -a "$SHARED_REV" "$tmp"
ok "$tmp/$SUB" || { rm -rf "$tmp"; echo "the copy's sha256 is not $SHA" >&2; exit 3; }
rm -rf "$PRIVATE_REV"
mv "$tmp" "$PRIVATE_REV"
echo seeded`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PRIVATE_DIR: PRIVATE_BROWSERS_DIR,
          PRIVATE_REV: privateRev,
          PRIVATE_BIN: privatePath,
          SHARED_REV: revDir,
          SUB: relative(revDir, sharedPath),
          SHA: EXPECTED_CHROMIUM_SHA256,
        },
      },
    );
    if (seed.status === 0 && matches(privatePath)) {
      const seeded = seed.stdout.trim() === "seeded";
      if (seeded)
        console.error(
          `browser-harness: seeded the private pinned Chromium ${privateRev} from ${revDir}`,
        );
      return done(privatePath, seeded ? "seeded" : "private");
    }
    console.error(
      `browser-harness: WARNING: could not seed ${privateRev} (${seed.stderr.trim() || `exit ${seed.status}`}); launching the verified shared copy ${sharedPath}`,
    );
    return done(sharedPath, "shared");
  }
  throw new Error(
    `browser-harness: no pinned Chromium ${EXPECTED_CHROMIUM_VERSION} (sha256 ${EXPECTED_CHROMIUM_SHA256}): ` +
      `the private copy ${privatePath} is ${existsSync(privatePath) ? "a different build" : "missing"} and ` +
      `the shared Playwright cache's ${sharedPath} is ${existsSync(sharedPath) ? "a different build" : "missing"} ` +
      `(another repo's \`playwright install\` may have collected it). Restore either one with the pinned build; ` +
      `this harness never downloads a browser.`,
  );
}

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
  const { executablePath } = resolvePinnedChromium();
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
  /** G7d: serve every static GET with `Cross-Origin-Opener-Policy: same-origin`,
   * `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`,
   * so the page is `crossOriginIsolated` and `performance.now()` resolves to 5 µs instead of
   * Chrome's 100 µs (the bench times phases of tens of microseconds). `http://127.0.0.1` is a
   * secure context, on the phone too (adb reverse keeps the origin byte-identical). */
  crossOriginIsolated?: boolean;
  /** G7k (startup-warm): static files carry `Cache-Control: max-age=3600` plus an ETag and
   * Last-Modified, as a real deployment serves its bundle -- with no validators or freshness
   * Chromium's HTTP cache cannot reuse a response, so a warm profile would never be warm. Off by
   * default (every other leg's server is unchanged). */
  staticCache?: boolean;
  /** G7e: per-nonce evidence directories. A nonce listed here writes into its own directory
   * (a leg's directory, D10) instead of `<evidenceRoot>/<nonce>`; the same `..` guard applies. */
  evidenceDirs?: Readonly<Record<string, string>>;
  /** G7e: awaited after a PUT's body is written and before it is answered, so the page's next
   * step (the web-export receiver quits only after its last PUT is answered) waits for it -- the
   * compositor screenshot of `compositor-equals-readback` is taken here. */
  onPut?: (nonce: string, relativePath: string) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// G7d: a minimal RFC 6455 server side (no `ws` dependency in this workspace, as G7h's echo). It
// parses masked client frames of any length (7-, 16- and 64-bit), reassembles continuation frames,
// answers pings and closes, and sends unmasked frames. Used by the device probes' adb-reverse RTT
// echo (`/echo`) and by self-test-device-harness.ts's recorded-CDP fake.
// ---------------------------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface ServerWebSocket {
  send(data: Buffer | string): void;
  close(): void;
  onMessage(fn: (data: Buffer, isText: boolean) => void): void;
  onClose(fn: () => void): void;
}

/** Completes the upgrade on `socket` and returns the connection, or null (and destroys the
 * socket) when the request is not a WebSocket upgrade. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
): ServerWebSocket | null {
  const key = req.headers["sec-websocket-key"];
  if (
    req.headers.upgrade?.toLowerCase() !== "websocket" ||
    typeof key !== "string"
  ) {
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const messageFns: ((data: Buffer, isText: boolean) => void)[] = [];
  const closeFns: (() => void)[] = [];
  let buffered = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentText = false;
  let closed = false;
  const frame = (opcode: number, payload: Buffer): Buffer => {
    const len = payload.length;
    const head =
      len < 126
        ? Buffer.from([0x80 | opcode, len])
        : len < 65536
          ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | opcode;
              h[1] = 127;
              h.writeBigUInt64BE(BigInt(len), 2);
              return h;
            })();
    return Buffer.concat([head, payload]);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const fin = (buffered[0] & 0x80) !== 0;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      let len = buffered[1] & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (buffered.length < 4) return;
        len = buffered.readUInt16BE(2);
        pos = 4;
      } else if (len === 127) {
        if (buffered.length < 10) return;
        len = Number(buffered.readBigUInt64BE(2));
        pos = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffered.length < pos + maskLen + len) return;
      const mask = masked ? buffered.subarray(pos, pos + 4) : null;
      const payload = Buffer.from(
        buffered.subarray(pos + maskLen, pos + maskLen + len),
      );
      if (mask)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffered = buffered.subarray(pos + maskLen + len);
      if (opcode === 0x8) {
        if (!closed) socket.write(frame(0x8, Buffer.alloc(0)));
        socket.end();
        finish();
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        fragmentText = opcode === 0x1;
      } else if (opcode === 0x0) {
        fragments.push(payload);
      }
      if (fin) {
        const data = Buffer.concat(fragments);
        fragments = [];
        for (const fn of messageFns) fn(data, fragmentText);
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", () => finish());
  return {
    send(data) {
      if (closed) return;
      const text = typeof data === "string";
      socket.write(frame(text ? 0x1 : 0x2, text ? Buffer.from(data) : data));
    },
    close() {
      if (closed) return;
      socket.write(frame(0x8, Buffer.alloc(0)));
      socket.end();
      finish();
    },
    onMessage(fn) {
      messageFns.push(fn);
    },
    onClose(fn) {
      closeFns.push(fn);
    },
  };
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

  private readonly nonces: Set<string>;
  private readonly evidenceDirs: Map<string, string>;

  constructor(private readonly options: HarnessServerOptions) {
    this.nonces = new Set(options.allowedLegNonces);
    this.evidenceDirs = new Map(Object.entries(options.evidenceDirs ?? {}));
  }

  /** G7e: admits one more leg nonce (optionally with its own evidence directory) on a running
   * server, so one server can serve a run's legs one after another. */
  addLeg(nonce: string, evidenceDir?: string): void {
    this.nonces.add(nonce);
    if (evidenceDir) this.evidenceDirs.set(nonce, evidenceDir);
  }

  /** G7e: retires a leg nonce; later PUTs under it are 403 like any unknown nonce. */
  removeLeg(nonce: string): void {
    this.nonces.delete(nonce);
    this.evidenceDirs.delete(nonce);
  }

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

  private echoPath: string | null = null;
  private tickPath: string | null = null;

  /** G7d: answer WebSocket upgrades at `path` with an echo (call before `start()`). */
  enableWebSocketEcho(path = "/echo"): void {
    this.echoPath = path;
  }

  /** G7d: a 60 Hz host stand-in at `path`: every connection gets a 16-byte message per tick,
   * scheduled against `t0 + k H` (never "now + H", memory rate-schedule-anchor-not-now), for the
   * device probes' panel-phase drift (hold p50 over time, Q13c). */
  enableTicker(path = "/tick"): void {
    this.tickPath = path;
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
    if (this.echoPath !== null || this.tickPath !== null) {
      const { echoPath, tickPath } = this;
      this.server.on("upgrade", (req, socket) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === echoPath) {
          const ws = acceptWebSocket(req, socket);
          // Echo every message back as it came (text or binary): the device probes' RTT and
          // throughput through adb reverse (Q13b "Transport").
          ws?.onMessage((data, isText) =>
            ws.send(isText ? data.toString("utf8") : data),
          );
          return;
        }
        if (url.pathname === tickPath) {
          const ws = acceptWebSocket(req, socket);
          if (ws) startTicker(ws, 60);
          return;
        }
        socket.destroy();
      });
    }
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
    if (statSync(target).isDirectory()) {
      // G7e: `GET <dir>/?list` answers the directory's files, recursively, as a JSON array of
      // paths relative to it (sorted) -- how the web-export receiver learns a store's contents.
      if (!url.searchParams.has("list")) {
        res.writeHead(403);
        res.end("directory");
        return;
      }
      const body = Buffer.from(JSON.stringify(listFiles(target)));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(body.length),
      });
      res.end(body);
      return;
    }
    const st = statSync(target);
    const cacheHeaders: Record<string, string> = this.options.staticCache
      ? {
          "Cache-Control": "public, max-age=3600",
          ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
          "Last-Modified": st.mtime.toUTCString(),
        }
      : {};
    const isolation: Record<string, string> = this.options.crossOriginIsolated
      ? {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "no-store",
        }
      : {};
    res.writeHead(200, {
      "Content-Type": contentTypeFor(target),
      ...isolation,
      ...cacheHeaders,
    });
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
    if (!nonce || !this.nonces.has(nonce) || restParts.length === 0) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("rejected: unknown leg nonce");
      return;
    }
    const legRoot = normalize(
      this.evidenceDirs.get(nonce) ?? join(this.options.evidenceRoot, nonce),
    );
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
    if (this.options.onPut) {
      await this.options.onPut(nonce, target.slice(legRoot.length + 1));
    }
    res.writeHead(200);
    res.end("ok");
  }
}

function startTicker(ws: ServerWebSocket, hz: number): void {
  const periodMs = 1000 / hz;
  const t0 = performance.now();
  let k = 0;
  let stopped = false;
  ws.onClose(() => {
    stopped = true;
  });
  const tick = () => {
    if (stopped) return;
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(k, 0);
    payload.writeDoubleLE(performance.now(), 8);
    ws.send(payload);
    k++;
    setTimeout(tick, Math.max(0, t0 + k * periodMs - performance.now()));
  };
  setTimeout(tick, periodMs);
}

/** Every file under `root`, recursively, as sorted `/`-joined paths relative to it. */
function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && statSync(join(root, rel)).isDirectory());
    if (isDir) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
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

// ---------------------------------------------------------------------------------------------
// G7d: `env: "device"` (gate7-design.md D24, D28, Q13b). Chrome on a phone is ATTACHED through
// perf-harness's `openDeviceBrowser` (adb forward to the DevTools socket, adb reverse for the
// harness port, the flattened CDP attach, the lock and foreground rules), never launched, so D9's
// flags, binary sha256 and Wayland guard cannot apply: `checkDeviceProvenance` replaces
// `checkBrowserProvenance` on device legs. `--device <id>` resolves through the committed device
// table to a serial, passed to `selectDevice` because both phones may be attached at once.
// ---------------------------------------------------------------------------------------------

export const DEVICE_TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "gate7-devices.json",
);

export type DeviceId = "g31" | "g86";
export type HarnessEnv = "desktop" | "device";

export interface DeviceTableEntry {
  label: string;
  serial: string;
  model: string;
  manufacturer: string;
  adb_model: string | null;
  adb_product: string | null;
  android_release: string;
  chrome_package: string;
  chrome_version_at_table: string;
  gpu_renderer_pattern: string;
  angle_required: boolean;
  panel_modes_hz: number[];
  predicted_tp_ms: number;
  tp_rule: string;
  dpr_milli: number;
  screen_css_px: [number, number];
  attendance: "standing-approval" | "operator-attended";
  session_settings: ("stay-awake-usb" | "landscape-lock")[];
  required_workloads: string[];
  stretch_workloads: string[];
  cpu_clusters:
    | {
        name: string;
        cpus: string;
        probe_cpu: number;
        cpuinfo_max_khz: number;
      }[]
    | null;
  half_tick_budget_ms: number;
}

export function loadDeviceTable(
  path = DEVICE_TABLE_PATH,
): Record<string, DeviceTableEntry> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    schema?: string;
    devices?: Record<string, DeviceTableEntry>;
  };
  if (parsed.schema !== "render-stream-gate7-devices/1" || !parsed.devices) {
    throw new Error(`${path} is not a render-stream-gate7-devices/1 table`);
  }
  return parsed.devices;
}

/** A leg the harness refuses (D22): `harness-refused`, never a pass and never a skip. */
export type HarnessRefusalReason =
  | "browser-provenance"
  | "device-provenance"
  | "device-unavailable"
  | "device-orientation";

export class HarnessRefusal extends Error {
  constructor(
    readonly reason: HarnessRefusalReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** A command-line misuse: the runner exits 2 before anything is launched. */
export class HarnessUsageError extends Error {}

/**
 * `--env` / `--device` resolution (D28: "Device arms never run without both flags"). Desktop with no
 * device is the default; `--env device` without `--device`, `--device` without `--env device`, and
 * an id the table does not name are usage errors.
 */
export function resolveDeviceSelection(
  env: HarnessEnv,
  deviceId: string | undefined,
  table: Record<string, DeviceTableEntry>,
): { env: HarnessEnv; id: DeviceId | null; entry: DeviceTableEntry | null } {
  if (env === "desktop") {
    if (deviceId)
      throw new HarnessUsageError(
        `--device ${deviceId} needs --env device (device arms never run without both flags)`,
      );
    return { env, id: null, entry: null };
  }
  if (!deviceId)
    throw new HarnessUsageError(
      `--env device needs --device <${Object.keys(table).join("|")}> (device arms never run without both flags)`,
    );
  const entry = table[deviceId];
  if (!entry)
    throw new HarnessUsageError(
      `--device ${deviceId} is not in the device table (known: ${Object.keys(table).join(", ")})`,
    );
  return { env, id: deviceId as DeviceId, entry };
}

/** What the page itself reports on a device leg, read by one `Runtime.evaluate`. */
export interface DevicePageFacts {
  renderer: string | null;
  vendor: string | null;
  userAgent: string;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  orientation: string | null;
  visibilityState: string;
  crossOriginIsolated: boolean;
}

/** The expression `DevicePageFacts` comes from (a fresh canvas, so it never touches the page's
 * own WebGL context). */
export const DEVICE_PAGE_FACTS_EXPRESSION = `(() => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const dbg = gl ? gl.getExtension("WEBGL_debug_renderer_info") : null;
  const facts = {
    renderer: gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
    vendor: gl && dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
    userAgent: navigator.userAgent,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    orientation: screen.orientation ? screen.orientation.type : null,
    visibilityState: document.visibilityState,
    crossOriginIsolated: self.crossOriginIsolated === true,
  };
  const lose = gl ? gl.getExtension("WEBGL_lose_context") : null;
  if (lose) lose.loseContext();
  return facts;
})()`;

export interface DeviceFacts {
  serial: string;
  model: string;
  manufacturer: string;
  androidRelease: string;
  /** `/json/version`'s `Browser`, e.g. `Chrome/154.0.8037.127`. */
  chromeVersion: string;
  /** The same device's Chrome at its previous recorded run, when known (a change is named). */
  previousChromeVersion: string | null;
  conditions: DeviceConditions;
  page: DevicePageFacts | null;
}

export interface DeviceProvenance {
  ok: boolean;
  /** The refusal class when not ok (`device-orientation` when only the orientation failed). */
  refusal: HarnessRefusalReason | null;
  reasons: string[];
  /** Recorded, never refused: the ANGLE backend on the g31, a Chrome version change. */
  notes: string[];
  angle: boolean;
  renderer: string | null;
  chromeVersion: string;
  facts: DeviceFacts;
}

/**
 * The `device-provenance` check (Q13b, D22). Requires: the device table's model on its serial; a
 * `WEBGL_debug_renderer_info` renderer naming the table's GPU (ANGLE required only where the table
 * says so: the g86; the g31's backend is recorded) and never SwiftShader; thermal status `none` and
 * the battery at 20 % or more (perf-harness's invalidation conditions); a visible page; landscape
 * (`device-orientation` otherwise). The Chrome version is recorded, and a change since the previous
 * run is a note, not a refusal.
 */
export function checkDeviceProvenance(
  entry: DeviceTableEntry,
  facts: DeviceFacts,
): DeviceProvenance {
  const reasons: string[] = [];
  const notes: string[] = [];
  let orientationOnly = true;
  const fail = (text: string, orientation = false) => {
    reasons.push(text);
    if (!orientation) orientationOnly = false;
  };
  if (facts.serial !== entry.serial)
    fail(`serial ${facts.serial} is not the table's ${entry.serial}`);
  if (facts.model !== entry.model)
    fail(
      `model "${facts.model}" on ${facts.serial} is not the table's "${entry.model}"`,
    );
  const renderer = facts.page?.renderer ?? null;
  const angle = renderer !== null && /ANGLE/.test(renderer);
  if (!facts.page) {
    fail("no page facts: the attached tab never answered");
  } else if (renderer === null) {
    fail("WEBGL_debug_renderer_info reported no renderer string");
  } else {
    if (/SwiftShader|llvmpipe|software/i.test(renderer))
      fail(`renderer "${renderer}" is a software rasterizer`);
    if (!renderer.includes(entry.gpu_renderer_pattern))
      fail(
        `renderer "${renderer}" does not name the table's GPU "${entry.gpu_renderer_pattern}"`,
      );
    if (entry.angle_required && !angle)
      fail(
        `renderer "${renderer}" does not name ANGLE, which the table requires`,
      );
    if (!entry.angle_required)
      notes.push(
        `GPU backend: ${angle ? "ANGLE" : "native GLES"} (recorded, not required)`,
      );
  }
  if (
    facts.previousChromeVersion &&
    facts.previousChromeVersion !== facts.chromeVersion
  )
    notes.push(
      `Chrome changed since the previous run: ${facts.previousChromeVersion} -> ${facts.chromeVersion}`,
    );
  const c = facts.conditions;
  if (c.thermalStatusCode !== 0)
    fail(
      `thermal status ${c.thermalStatus ?? "unreadable"} (code ${c.thermalStatusCode}) before the first repeat, needs none`,
    );
  if (c.batteryPct === null || c.batteryPct < 20)
    fail(
      `battery ${c.batteryPct ?? "unreadable"} % before the first repeat, needs >= 20 %`,
    );
  if (facts.page && facts.page.visibilityState !== "visible")
    fail(`the tab is ${facts.page.visibilityState}, not in front`);
  if (facts.page && facts.page.innerWidth <= facts.page.innerHeight)
    fail(
      `portrait viewport ${facts.page.innerWidth}x${facts.page.innerHeight} (${facts.page.orientation ?? "?"}): landscape is required`,
      true,
    );
  const ok = reasons.length === 0;
  return {
    ok,
    refusal: ok
      ? null
      : orientationOnly
        ? "device-orientation"
        : "device-provenance",
    reasons,
    notes,
    angle,
    renderer,
    chromeVersion: facts.chromeVersion,
    facts,
  };
}

/** One repeat's throttle evidence, sampled by the page itself (perf-harness's bake-probe rule). */
export interface WatchdogSample {
  /** Total time `document.visibilityState` was not `visible` during the repeat. */
  hiddenMs: number;
  hides: number;
  /** Every rAF interval above the limit, with the work the previous callback did. */
  longGaps: { gapMs: number; prevWorkMs: number }[];
  /** The repeat's median rAF interval. */
  tpMs: number;
}

export interface WatchdogVerdict {
  valid: boolean;
  reasons: string[];
  uncausedGapsMs: number[];
}

/**
 * The watchdog (Q13b, docs/perf-harness.md "A retraction"): a repeat with hidden time > 0, or with a
 * rAF gap > 250 ms the receiver did not cause, is `invalid` and is re-run, never read as slow. A gap
 * is receiver-caused when the callback before it worked at least `gap - 2 T_p` (its own work plus
 * up to two ticks of compositor slack explain it).
 */
export function watchdogVerdict(
  sample: WatchdogSample,
  gapLimitMs = 250,
): WatchdogVerdict {
  const reasons: string[] = [];
  if (sample.hiddenMs > 0)
    reasons.push(
      `hidden ${Math.round(sample.hiddenMs)} ms over ${sample.hides} hide(s): throttled, invalid (not slow)`,
    );
  const uncaused = sample.longGaps
    .filter((g) => g.gapMs > gapLimitMs)
    .filter((g) => g.prevWorkMs < g.gapMs - 2 * sample.tpMs)
    .map((g) => g.gapMs);
  if (uncaused.length > 0)
    reasons.push(
      `${uncaused.length} rAF gap(s) > ${gapLimitMs} ms the receiver did not cause (worst ${Math.round(Math.max(...uncaused))} ms)`,
    );
  return { valid: reasons.length === 0, reasons, uncausedGapsMs: uncaused };
}

/** D28: a session setting the harness changed, with the value it restores. */
export interface SessionSettingChange {
  name: "stay-awake-usb" | "landscape-lock";
  namespace: "global" | "system";
  key: string;
  before: string;
  applied: string;
}

export interface SessionSettingsRecord {
  device: string;
  serial: string;
  changes: SessionSettingChange[];
  applied_at: string;
  restored_at: string | null;
  restore_errors: string[];
}

async function readSetting(
  adb: Adb,
  namespace: "global" | "system",
  key: string,
): Promise<string> {
  return (await adb.shell(`settings get ${namespace} ${key}`)).trim();
}

/**
 * D28: the g31's session settings, recorded and then applied: `svc power stayon usb` (which writes
 * `global stay_on_while_plugged_in` 2) and the landscape lock (`system accelerometer_rotation` 0,
 * `system user_rotation` 1). Nothing is installed, and a device whose table lists no session
 * settings (the g86) is never touched.
 */
export async function applySessionSettings(
  adb: Adb,
  id: string,
  entry: DeviceTableEntry,
): Promise<SessionSettingsRecord> {
  const record: SessionSettingsRecord = {
    device: id,
    serial: entry.serial,
    changes: [],
    applied_at: new Date().toISOString(),
    restored_at: null,
    restore_errors: [],
  };
  if (entry.session_settings.includes("stay-awake-usb")) {
    const before = await readSetting(adb, "global", "stay_on_while_plugged_in");
    await adb.shell("svc power stayon usb");
    record.changes.push({
      name: "stay-awake-usb",
      namespace: "global",
      key: "stay_on_while_plugged_in",
      before,
      applied: await readSetting(adb, "global", "stay_on_while_plugged_in"),
    });
  }
  if (entry.session_settings.includes("landscape-lock")) {
    for (const [key, value] of [
      ["accelerometer_rotation", "0"],
      ["user_rotation", "1"],
    ] as const) {
      const before = await readSetting(adb, "system", key);
      await adb.shell(`settings put system ${key} ${value}`);
      record.changes.push({
        name: "landscape-lock",
        namespace: "system",
        key,
        before,
        applied: value,
      });
    }
  }
  return record;
}

/** Restores every recorded change, last first. Errors are recorded, never thrown. */
export async function restoreSessionSettings(
  adb: Adb,
  record: SessionSettingsRecord,
): Promise<SessionSettingsRecord> {
  for (const change of [...record.changes].reverse()) {
    const value = change.before === "null" ? null : change.before;
    try {
      if (value === null)
        await adb.shell(`settings delete ${change.namespace} ${change.key}`);
      else
        await adb.shell(
          `settings put ${change.namespace} ${change.key} ${value}`,
        );
    } catch (error) {
      record.restore_errors.push(
        `${change.namespace}/${change.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  record.restored_at = new Date().toISOString();
  return record;
}

/** A page on the phone's Chrome, attached and in front. */
export interface DevicePage {
  evaluate<T>(
    expression: string,
    options?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T>;
  facts(): Promise<DevicePageFacts>;
  close(): Promise<void>;
}

export interface DeviceHarness {
  id: DeviceId;
  entry: DeviceTableEntry;
  browser: DeviceBrowser;
  settings: SessionSettingsRecord | null;
  /** Acquires a target (perf-harness's isolation ladder), navigates and waits for `load`. */
  openPage(url: string, timeoutMs?: number): Promise<DevicePage>;
  /** Device facts for `checkDeviceProvenance`, with this page's facts. */
  facts(page: DevicePage | null): Promise<DeviceFacts>;
  /** Restores the session settings, removes the forwards, detaches. Idempotent. */
  close(): Promise<SessionSettingsRecord | null>;
}

export interface OpenDeviceOptions {
  id: DeviceId;
  entry: DeviceTableEntry;
  /** The harness server's port, reversed onto the phone. */
  serverPort: number;
  /** More ports to reverse (a live host's, G7l/G7v). */
  extraReversePorts?: number[];
  adbBin?: string;
  devtoolsPort?: number;
  foregroundTimeoutMs?: number;
  previousChromeVersion?: string | null;
  onProgress?: (message: string) => void;
}

/**
 * Opens the phone `id` (D24, D28). Every way the phone can be unusable (not in `adb devices`, not
 * authorized, offline, locked, no DevTools socket, a tab that never answers) is the harness refusal
 * `device-unavailable`. The session settings are applied after the attach and restored by `close()`.
 */
export async function openHarnessDevice(
  options: OpenDeviceOptions,
): Promise<DeviceHarness> {
  const { id, entry } = options;
  const progress = options.onProgress ?? (() => {});
  let browser: DeviceBrowser;
  try {
    browser = await openDeviceBrowser({
      serial: entry.serial,
      adbBin: options.adbBin,
      serverPort: options.serverPort,
      devtoolsPort: options.devtoolsPort,
      foregroundTimeoutMs: options.foregroundTimeoutMs,
      onProgress: progress,
    });
  } catch (error) {
    if (error instanceof AdbError)
      throw new HarnessRefusal("device-unavailable", error.message);
    throw error;
  }
  let settings: SessionSettingsRecord | null = null;
  try {
    for (const port of options.extraReversePorts ?? [])
      await reverseServerPort(browser.adb, port);
    if (entry.session_settings.length > 0) {
      settings = await applySessionSettings(browser.adb, id, entry);
      progress(
        `session settings applied: ${settings.changes.map((c) => `${c.namespace}/${c.key} ${c.before}->${c.applied}`).join(", ")}`,
      );
    }
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
  let closed = false;
  const harness: DeviceHarness = {
    id,
    entry,
    browser,
    settings,
    async openPage(url, timeoutMs = 30_000) {
      let lease: Awaited<ReturnType<typeof browser.targets.acquire>>;
      try {
        lease = await browser.targets.acquire({
          width: entry.screen_css_px[0],
          height: entry.screen_css_px[1],
        });
      } catch (error) {
        if (error instanceof AdbError)
          throw new HarnessRefusal("device-unavailable", error.message);
        throw error;
      }
      const client = browser.client;
      await client.send("Page.navigate", { url });
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await client
          .evaluate<string>("document.readyState + ' ' + location.href", {
            timeoutMs: 10_000,
          })
          .catch(() => "");
        if (
          state.startsWith("complete ") &&
          state.includes(new URL(url).pathname)
        )
          break;
        if (Date.now() > deadline) {
          await lease.release().catch(() => {});
          throw new HarnessRefusal(
            "device-unavailable",
            `the tab never finished loading ${url} (last: ${state || "no answer"})`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return {
        evaluate: (expression, opts) => client.evaluate(expression, opts),
        facts: () =>
          client.evaluate<DevicePageFacts>(DEVICE_PAGE_FACTS_EXPRESSION),
        close: () => lease.release(),
      };
    },
    async facts(page) {
      return {
        serial: browser.adb.serial ?? "unknown",
        model: browser.props.model,
        manufacturer: browser.props.manufacturer,
        androidRelease: browser.props.androidRelease,
        chromeVersion: browser.chromeVersion,
        previousChromeVersion: options.previousChromeVersion ?? null,
        conditions: await browser.conditions(),
        page: page ? await page.facts().catch(() => null) : null,
      };
    },
    async close() {
      if (closed) return settings;
      closed = true;
      if (settings) await restoreSessionSettings(browser.adb, settings);
      for (const port of options.extraReversePorts ?? [])
        await browser.adb
          .exec(["reverse", "--remove", `tcp:${port}`])
          .catch(() => "");
      await browser.close();
      return settings;
    },
  };
  return harness;
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
