// Raw Chrome DevTools Protocol client + local Chrome launcher.
//
// Deliberately NOT Playwright: this repo's `@playwright/test` resolves to a version whose pinned
// chromium revision is not on disk, and a perf harness must never be blocked on a browser download.
// A ~200-line CDP client over Node's built-in WebSocket is also strictly more capable here, because
// the metrics this harness needs (`Tracing.*`, `Target.createBrowserContext`, `LayerTree.*`) are all
// protocol-level anyway.
//
// ALWAYS ATTACH FLATTENED. The legacy per-page endpoint (`ws://host/devtools/page/<targetId>`)
// stopped responding in Chrome 151. The portable path — verified on 150 and 151 — is:
//   GET <endpoint>/json/version  ->  webSocketDebuggerUrl (the BROWSER endpoint)
//   connect, then Target.attachToTarget({ targetId, flatten: true })  ->  sessionId
//   put that sessionId on every page-level message.
// Browser-level domains (`Target.*`, `Tracing.*`, `IO.*`) must be sent WITHOUT a sessionId; that is
// what `{ flat: true }` means below.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CdpParams = Record<string, unknown>;

export interface SendOptions {
  timeoutMs?: number;
  /** Send WITHOUT a sessionId — browser-level domains (Target.*, Tracing.*, IO.*). */
  flat?: boolean;
}

interface PendingCall {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: CdpParams;
  sessionId?: string;
  error?: { message?: string; code?: number };
  result?: unknown;
}

/** A flattened-session CDP connection. One socket to the browser endpoint, many sessions on it. */
export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<
    string,
    ((params: CdpParams, sessionId?: string) => void)[]
  >();
  private socket: WebSocket | undefined;
  private closed = false;
  sessionId: string | undefined;
  targetId: string | undefined;

  static async connect(browserWsUrl: string): Promise<CdpClient> {
    const client = new CdpClient();
    await client.open(browserWsUrl);
    return client;
  }

  private open(wsUrl: string): Promise<void> {
    return new Promise((res, rej) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => res());
      socket.addEventListener("error", () => {
        if (this.closed) {
          return;
        }
        rej(new Error(`CDP websocket error for ${wsUrl}`));
      });
      socket.addEventListener("close", () => {
        for (const [, call] of this.pending) {
          call.reject(new Error("CDP websocket closed"));
        }
        this.pending.clear();
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        let message: CdpMessage;
        try {
          message = JSON.parse(String(event.data)) as CdpMessage;
        } catch {
          return;
        }
        if (message.id != null && this.pending.has(message.id)) {
          const call = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (!call) {
            return;
          }
          if (message.error) {
            call.reject(
              new Error(
                `CDP error: ${message.error.message ?? "unknown"} ${JSON.stringify(message.error).slice(0, 300)}`,
              ),
            );
          } else {
            call.resolve(message.result as never);
          }
          return;
        }
        if (message.method) {
          for (const handler of this.handlers.get(message.method) ?? []) {
            handler(message.params ?? {}, message.sessionId);
          }
        }
      });
    });
  }

  on(
    method: string,
    fn: (params: CdpParams, sessionId?: string) => void,
  ): void {
    const list = this.handlers.get(method);
    if (list) {
      list.push(fn);
    } else {
      this.handlers.set(method, [fn]);
    }
  }

  off(method: string): void {
    this.handlers.delete(method);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: CdpParams = {},
    options: SendOptions = {},
  ): Promise<T> {
    const { timeoutMs = 60_000, flat = false } = options;
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("CDP client is not connected"));
    }
    const id = ++this.nextId;
    const message: CdpMessage = { id, method, params };
    if (!flat && this.sessionId) {
      message.sessionId = this.sessionId;
    }
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: ((value: T) => {
          clearTimeout(timer);
          res(value);
        }) as (value: never) => void,
        reject: (error: Error) => {
          clearTimeout(timer);
          rej(error);
        },
      });
      socket.send(JSON.stringify(message));
    });
  }

  /** Attach to a target as a flattened session and route subsequent page-level sends to it. */
  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
      { flat: true },
    );
    this.sessionId = sessionId;
    this.targetId = targetId;
    return sessionId;
  }

  async evaluate<T>(
    expression: string,
    options: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const { awaitPromise = false, timeoutMs = 60_000 } = options;
    const result = await this.send<{
      result?: { value?: T };
      exceptionDetails?: unknown;
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
        allowUnsafeEvalBlockedByCSP: true,
      },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`,
      );
    }
    return result.result?.value as T;
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // already gone
    }
  }
}

export interface LaunchedChrome {
  client: CdpClient;
  browserWsUrl: string;
  process: ChildProcess;
  executable: string;
  version: string;
  userDataDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Repo-relative or absolute directory for the profile. MUST NOT be under /tmp (snap confinement). */
  userDataDir: string;
  headless?: boolean;
  windowSize?: { width: number; height: number };
  deviceScaleFactor?: number;
  /** Extra launch flags, appended after the defaults — the CLI's repeatable `--chrome-arg`. */
  extraArgs?: string[];
  timeoutMs?: number;
}

/**
 * Chrome binary resolution:
 *   1. `GSW_PERF_CHROME`
 *   2. the newest `~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome` on disk
 *   3. `/snap/bin/chromium`
 *
 * (2) is resolved by PATH, not by `require("playwright-core")`: playwright-core is not resolvable
 * from this repo's root (it only exists under packages/test-harness), and the version the root
 * `@playwright/test` wants pins a chromium revision that is not downloaded. The browsers that ARE on
 * disk are perfectly good — they just have to be found directly. Note the directory is
 * `chrome-linux64` (Chrome for Testing), not the older `chrome-linux`.
 *
 * (3) is a last resort: snap chromium is confined, so its profile directory must live inside the
 * repo and must NOT be a dot-directory (snap's `home` interface refuses hidden paths).
 */
export function resolveChromeExecutable(): string {
  const fromEnv = process.env.GSW_PERF_CHROME;
  if (fromEnv) {
    return fromEnv;
  }
  const fromPlaywright = newestPlaywrightChrome();
  if (fromPlaywright) {
    return fromPlaywright;
  }
  return "/snap/bin/chromium";
}

function newestPlaywrightChrome(): string | undefined {
  const root = join(homedir(), ".cache", "ms-playwright");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      revision: Number(match[1]),
      path: join(root, match[0], "chrome-linux64", "chrome"),
    }))
    .filter((candidate) => existsSync(candidate.path))
    .sort((a, b) => b.revision - a.revision);
  return candidates[0]?.path;
}

export interface ChromeArgsOptions
  extends Omit<LaunchOptions, "userDataDir" | "timeoutMs"> {
  /** The RESOLVED profile directory — `launchChrome` resolves and recreates it before spawning. */
  profileDir: string;
}

/**
 * The whole launch line, as a pure function.
 *
 * Split out of `launchChrome` so the args a measured run is taken with can be asserted WITHOUT
 * spawning a browser: this list is measurement configuration (throttling off, occlusion off, fixed
 * colour profile), so a silent change to it changes every number the harness reports.
 *
 * `extraArgs` lands AFTER the defaults and BEFORE `about:blank`: Chrome takes the last spelling of a
 * repeated switch, so a caller can override a default here, and the positional URL must stay last.
 */
export function chromeArgs(options: ChromeArgsOptions): string[] {
  const {
    profileDir,
    headless = true,
    windowSize = { width: 1280, height: 800 },
    deviceScaleFactor = 1,
    extraArgs = [],
  } = options;
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    // Extensions get their own renderer processes that emit compositor + task events into the same
    // trace. Left on, they both add noise and cost CPU on the machine doing the measuring.
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,BackForwardCache",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "--mute-audio",
    `--force-device-scale-factor=${deviceScaleFactor}`,
    `--window-size=${windowSize.width},${windowSize.height}`,
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    "about:blank",
  ];
}

/**
 * Launch Chrome with `--remote-debugging-port=0` and read the real port back from the
 * `DevTools listening on ws://...` stderr line. A fixed port collides with any other Chrome the
 * developer has open; port 0 never does.
 */
export async function launchChrome(
  options: LaunchOptions,
): Promise<LaunchedChrome> {
  const {
    userDataDir,
    headless,
    windowSize,
    deviceScaleFactor,
    extraArgs,
    timeoutMs = 45_000,
  } = options;
  const executable = resolveChromeExecutable();
  const profileDir = resolve(userDataDir);
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const args = chromeArgs({
    profileDir,
    headless,
    windowSize,
    deviceScaleFactor,
    extraArgs,
  });

  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const browserWsUrl = await readDevToolsUrl(child, executable, timeoutMs);
  const endpoint = browserWsUrl.replace(/^ws/, "http");
  const origin = new URL(endpoint).origin;
  const version = await fetchJson<{
    Browser?: string;
    webSocketDebuggerUrl?: string;
  }>(`${origin}/json/version`);
  // The stderr URL and /json/version agree, but /json/version is the documented discovery path and
  // the only one available when attaching to a browser we did not spawn (the device workstream).
  const wsUrl = version.webSocketDebuggerUrl ?? browserWsUrl;
  const client = await CdpClient.connect(wsUrl);

  let closed = false;
  return {
    client,
    browserWsUrl: wsUrl,
    process: child,
    executable,
    version: version.Browser ?? "unknown",
    userDataDir: profileDir,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      client.close();
      await new Promise<void>((res) => {
        const done = () => res();
        child.once("exit", done);
        try {
          child.kill("SIGTERM");
        } catch {
          done();
          return;
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          res();
        }, 4000).unref?.();
      });
    },
  };
}

function readDevToolsUrl(
  child: ChildProcess,
  executable: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((res, rej) => {
    let stderr = "";
    const timer = setTimeout(() => {
      rej(
        new Error(
          `Chrome (${executable}) did not print a DevTools endpoint within ${timeoutMs}ms.\n${stderr.slice(-2000)}`,
        ),
      );
    }, timeoutMs);
    const finish = (value: string) => {
      clearTimeout(timer);
      res(value);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        finish(match[1]);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rej(
        new Error(`failed to spawn Chrome (${executable}): ${error.message}`),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rej(
        new Error(
          `Chrome (${executable}) exited with code ${code} before printing a DevTools endpoint.\n${stderr.slice(-2000)}`,
        ),
      );
    });
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  return (await response.json()) as T;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));
