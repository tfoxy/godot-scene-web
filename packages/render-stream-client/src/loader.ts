// Loading the core.
//
// A fresh wasm instance per client, so that `dispose()` gives its `WebAssembly.Memory` back.
// wasm-bindgen's `--target web` glue keeps its instance in a module-level variable, and a page's
// module map keeps every module record it ever loaded, `?client=<n>` variants included, so each mount
// of a `?client=<n>` glue import would keep its instance alive after dispose and GC. So `build-web.sh` wraps the glue's module body in a factory function
// (`rs_gsw_wasm_client.js`, `export default function createGlue()`), the client imports that module
// ONCE, and every client calls the factory: a fresh closure holding its own instance, collectable
// once the client drops it. The `.wasm` is compiled once per page into a cached
// `WebAssembly.Module` (compiling is the expensive part and holds no heap), after its SHA-256 is
// checked against the `build.json` beside it.
//
// ABI check. `build.json` (build-web.sh) names the source tree the wasm was built from
// (`rs_core_tree`). A consumer that knows which tree its TS sources match (couch's Vite plugin runs
// `scripts/core-tree.sh` on the GSW checkout it aliases) passes it as `expectedTree`; a mismatch is
// `core-load-failed` (`stale core`). Independently, the glue must export every GswRs method the
// client calls (abi.ts `CLIENT_CORE_METHODS`).
//
// Deadline. The whole load, build.json to the glue's init, runs under one deadline
// (`coreLoadTimeoutMs`, default `CORE_LOAD_TIMEOUT_MS`): a step that stalls is `core-load-failed`
// `timeout after <ms> ms in <steps>`, not a client stuck in `connecting`. 30 s leaves a wide
// margin over a slow device's cold load (the pure-JS hash is its slowest step) and still covers a
// slow link's 2.5 MB fetch. Every await is raced against the load's abort (the deadline or the client's
// dispose), so a compile or import that resolves late never reaches `createGlue` or init. The
// per-page caches count their waiters: when the last one gives up on an entry still in flight,
// its fetch is aborted, its hash stops at the next chunk and the entry is dropped (the next load
// starts afresh); a compile or import already started cannot be cancelled, and its late result is
// dropped with the entry.
//
// Hash. With `crypto.subtle` (a secure page) the body is read whole (`arrayBuffer()`) and digested
// in one call: step `wasm hash`. Without it (a plain-http LAN page) the body is read with a reader
// and each chunk goes into one incremental `Sha256` as it arrives, copied into the output buffer
// (`readHashed`), so the hash overlaps the download. The buffer is sized from build.json's
// `wasm_bytes`, not Content-Length (the compressed size under gzip): a body that overruns it, or
// ends short of it, is `stale core` at once, naming both sizes, and its reader is cancelled. A chunk
// is hashed in pieces of at most 256 KiB with a task between them (a fast link or a cached response
// can deliver a large one), checking the abort between pieces. While streaming, the hash is part of
// `wasm fetch`: a timeout there names `wasm fetch`, never `wasm hash`. A response with no body, or
// a build.json with no usable `wasm_bytes`, takes the whole-body path.

import { CLIENT_CORE_METHODS, type GswRsModule } from "./abi";
import { Sha256 } from "./sha256";

/** Where the core is served: build-web.sh's three files, at two (or three) static URLs. */
export interface RenderStreamCore {
  /** `rs_gsw_wasm_client.js`, the factory-wrapped wasm-bindgen glue (never bundled: the client
   * imports it by URL). */
  glueUrl: string;
  /** `rs_gsw_wasm_bg.wasm`. */
  wasmUrl: string;
  /** `build.json`; default: `build.json` beside `wasmUrl`. */
  buildUrl?: string;
  /** The `rs_core_tree` the consumer's TS sources were taken with (`scripts/core-tree.sh`); when
   * set, a core built from another tree is refused as stale. */
  expectedTree?: string;
}

/** build-web.sh's `build.json`. */
export interface CoreBuild {
  schema: "render-stream-client-core/1";
  rs_core_build: string;
  rs_core_tree: string;
  wasm_sha256: string;
  wasm_bytes: number;
  wasm_bindgen: string;
  glue: string;
  wasm: string;
}

export class CoreLoadError extends Error {
  override name = "CoreLoadError";
}

/** The default deadline of a whole core load (see the header). */
export const CORE_LOAD_TIMEOUT_MS = 30000;

/** A load's steps, as a timeout's detail names them. */
export type CoreLoadStep =
  | "build fetch"
  | "wasm fetch"
  | "wasm hash"
  | "wasm compile"
  | "glue import"
  | "core init";

/** What the loader calls on the page (tests substitute it). */
export interface LoaderEnv {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Whether the page has `crypto.subtle`; when it has not, the wasm is hashed while it downloads. */
  hasSubtle(): boolean;
  digest(
    bytes: ArrayBuffer,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | Uint8Array>;
  compile(bytes: ArrayBuffer): Promise<WebAssembly.Module>;
  importGlue(url: string): Promise<unknown>;
}

export interface LoadCoreOptions {
  timeoutMs: number;
  /** Aborts the load (the client's dispose): it rejects, and nothing of it runs on. */
  signal?: AbortSignal;
  env?: Partial<LoaderEnv>;
}

/** The pure-JS hash's chunk, small enough that a slow device yields between chunks. */
const HASH_CHUNK = 256 * 1024;

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** The fallback hash, a chunk per task, stopping at the first chunk after `signal` aborts. */
export async function sha256Chunked(
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const src = new Uint8Array(bytes);
  const h = new Sha256();
  for (let off = 0; off < src.length; off += HASH_CHUNK) {
    if (off > 0) await nextTask();
    signal.throwIfAborted();
    h.update(src.subarray(off, off + HASH_CHUNK));
  }
  return h.digest();
}

/**
 * Reads `body` into a buffer of `expected` bytes (build.json's `wasm_bytes`; Content-Length is the
 * compressed size under gzip) and hashes each chunk as it arrives, so the hash overlaps the download.
 * A body longer or shorter than `expected` is `stale core` as soon as it is known. Anything over
 * `HASH_CHUNK` hashed since the last task is split, and a task passes between the pieces, so the
 * main thread stays free and an abort is seen. Whatever ends the read cancels the reader.
 */
export async function readHashed(
  body: ReadableStream<Uint8Array>,
  expected: number,
  signal: AbortSignal,
  url: string,
): Promise<{ bytes: ArrayBuffer; sha: Uint8Array }> {
  const out = new Uint8Array(expected);
  const h = new Sha256();
  const reader = body.getReader();
  let off = 0;
  let sinceTask = 0;
  try {
    for (;;) {
      const { done, value } = await raced(reader.read(), signal);
      if (done) break;
      if (off + value.length > expected)
        throw new CoreLoadError(
          `stale core: ${url} sent more than the ${expected} bytes its build.json names (wasm_bytes), at least ${off + value.length}`,
        );
      out.set(value, off);
      for (let p = 0; p < value.length; ) {
        const n = Math.min(value.length - p, HASH_CHUNK - sinceTask);
        h.update(out.subarray(off + p, off + p + n));
        p += n;
        sinceTask += n;
        if (sinceTask >= HASH_CHUNK) {
          sinceTask = 0;
          await nextTask();
          signal.throwIfAborted();
        }
      }
      off += value.length;
    }
    if (off < expected)
      throw new CoreLoadError(
        `stale core: ${url} ended after ${off} of the ${expected} bytes its build.json names (wasm_bytes)`,
      );
    return { bytes: out.buffer, sha: h.digest() };
  } catch (e) {
    // The fetch's signal cancels the body on a timeout or abandon; a size mismatch has no signal.
    reader.cancel().catch(() => {});
    throw e;
  }
}

const pageEnv: LoaderEnv = {
  fetch: (url, init) => fetch(url, init),
  // `crypto.subtle` exists only in secure contexts; a plain-http LAN page hashes in JS.
  hasSubtle: () => globalThis.crypto?.subtle !== undefined,
  digest: (bytes, signal) =>
    globalThis.crypto?.subtle
      ? crypto.subtle.digest("SHA-256", bytes)
      : sha256Chunked(bytes, signal),
  compile: (bytes) => WebAssembly.compile(bytes),
  importGlue: (url) => import(/* @vite-ignore */ url),
};

/** The marker build-web.sh's factory module exports beside its default. */
interface GlueFactoryModule {
  RENDER_STREAM_CLIENT_GLUE?: number;
  default?: () => GswRsModule;
}

/** A per-page cache entry and the loads waiting on it. */
interface Shared<T> {
  promise: Promise<T>;
  /** Aborted when the last waiter gives up before it settles. */
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
  step: CoreLoadStep;
}

const compiled = new Map<string, Shared<WebAssembly.Module>>();
const factories = new Map<string, Shared<() => GswRsModule>>();

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** `p`, or `signal`'s reason as soon as it aborts. */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Waits on `map`'s entry for `key` (started by `start` when there is none) until `signal`. */
function acquire<T>(
  map: Map<string, Shared<T>>,
  key: string,
  step: CoreLoadStep,
  start: (entry: Shared<T>) => Promise<T>,
  signal: AbortSignal,
): { entry: Shared<T>; promise: Promise<T> } {
  let entry = map.get(key);
  if (entry === undefined) {
    const e: Shared<T> = {
      promise: undefined as unknown as Promise<T>,
      controller: new AbortController(),
      waiters: 0,
      settled: false,
      step,
    };
    e.promise = start(e);
    e.promise.then(
      () => {
        e.settled = true;
      },
      () => {
        e.settled = true;
        // A failed load is retried by the next client.
        if (map.get(key) === e) map.delete(key);
      },
    );
    map.set(key, e);
    entry = e;
  }
  const e = entry;
  e.waiters++;
  const promise = raced(e.promise, signal).finally(() => {
    if (--e.waiters > 0 || e.settled) return;
    e.controller.abort(new CoreLoadError("abandoned"));
    if (map.get(key) === e) map.delete(key);
  });
  return { entry: e, promise };
}

async function readBuild(
  core: RenderStreamCore,
  wasmUrl: string,
  env: LoaderEnv,
  signal: AbortSignal,
): Promise<CoreBuild> {
  const url = core.buildUrl
    ? new URL(core.buildUrl, location.href).href
    : new URL("build.json", wasmUrl).href;
  let b: CoreBuild;
  try {
    const res = await env.fetch(url, { cache: "no-cache", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    b = (await res.json()) as CoreBuild;
  } catch (e) {
    throw new CoreLoadError(`no build.json at ${url} (${String(e)})`);
  }
  if (b?.schema !== "render-stream-client-core/1")
    throw new CoreLoadError(
      `${url} is not a render-stream-client core build.json`,
    );
  if (core.expectedTree !== undefined && b.rs_core_tree !== core.expectedTree)
    throw new CoreLoadError(
      `stale core: built from tree ${b.rs_core_tree}, the client expects ${core.expectedTree}`,
    );
  return b;
}

/** Fetches, checks and compiles the `.wasm`, once per page. */
async function compileWasm(
  e: Shared<WebAssembly.Module>,
  wasmUrl: string,
  build: CoreBuild,
  env: LoaderEnv,
): Promise<WebAssembly.Module> {
  const signal = e.controller.signal;
  const res = await env.fetch(wasmUrl, { signal });
  if (!res.ok) throw new CoreLoadError(`GET ${wasmUrl}: HTTP ${res.status}`);
  let bytes: ArrayBuffer;
  let sha: string;
  const expected = build.wasm_bytes;
  if (
    !env.hasSubtle() &&
    res.body &&
    Number.isSafeInteger(expected) &&
    expected > 0
  ) {
    // No `crypto.subtle`: the hash is part of the fetch, and stays `wasm fetch` in a timeout.
    const r = await readHashed(res.body, expected, signal, wasmUrl);
    bytes = r.bytes;
    sha = hex(r.sha);
  } else {
    bytes = await res.arrayBuffer();
    e.step = "wasm hash";
    sha = hex(await env.digest(bytes, signal));
  }
  if (sha !== build.wasm_sha256)
    throw new CoreLoadError(
      `stale core: ${wasmUrl} has sha256 ${sha}, its build.json names ${build.wasm_sha256}`,
    );
  signal.throwIfAborted();
  e.step = "wasm compile";
  return env.compile(bytes);
}

/** Imports the factory glue, once per page. */
async function importFactory(
  glueUrl: string,
  env: LoaderEnv,
): Promise<() => GswRsModule> {
  const m = (await env.importGlue(glueUrl)) as GlueFactoryModule;
  if (m?.RENDER_STREAM_CLIENT_GLUE !== 1 || typeof m.default !== "function")
    throw new CoreLoadError(
      `${glueUrl} is not build-web.sh's factory glue (rs_gsw_wasm_client.js)`,
    );
  return m.default;
}

/** One fresh core instance: its glue (a new closure) and its memory. */
export async function loadCore(
  core: RenderStreamCore,
  options: LoadCoreOptions,
): Promise<{ mod: GswRsModule; memory: WebAssembly.Memory; build: CoreBuild }> {
  const env = options.env ? { ...pageEnv, ...options.env } : pageEnv;
  const wasmUrl = new URL(core.wasmUrl, location.href).href;
  const glueUrl = new URL(core.glueUrl, location.href).href;
  const ctl = new AbortController();
  const signal = ctl.signal;
  let pending: () => CoreLoadStep[] = () => ["build fetch"];
  const timer = setTimeout(
    () =>
      ctl.abort(
        new CoreLoadError(
          `timeout after ${options.timeoutMs} ms in ${pending().join(" + ")}`,
        ),
      ),
    options.timeoutMs,
  );
  const outer = options.signal;
  const onAbort = () => ctl.abort(new CoreLoadError("aborted"));
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  try {
    const build = await raced(readBuild(core, wasmUrl, env, signal), signal);
    const wasm = acquire(
      compiled,
      wasmUrl,
      "wasm fetch",
      (e) => compileWasm(e, wasmUrl, build, env),
      signal,
    );
    const glue = acquire(
      factories,
      glueUrl,
      "glue import",
      () => importFactory(glueUrl, env),
      signal,
    );
    pending = () =>
      [wasm.entry, glue.entry].filter((e) => !e.settled).map((e) => e.step);
    const [module, createGlue] = await Promise.all([
      wasm.promise,
      glue.promise,
    ]);
    pending = () => ["core init"];
    const mod = createGlue();
    const proto = (
      mod.GswRs as unknown as { prototype?: Record<string, unknown> }
    )?.prototype;
    const missing: string[] = CLIENT_CORE_METHODS.filter(
      (k) => typeof proto?.[k] !== "function",
    );
    if (typeof mod.LiveCoding !== "function") missing.push("LiveCoding");
    if (missing.length > 0)
      throw new CoreLoadError(
        `stale core: the glue has no ${missing.join(", ")}`,
      );
    const { memory } = await raced(
      mod.default({ module_or_path: module }),
      signal,
    );
    return { mod, memory, build };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
    // A failure on one side leaves no waiter on the other (a stalled import, say).
    if (!signal.aborted) ctl.abort(new CoreLoadError("settled"));
  }
}
