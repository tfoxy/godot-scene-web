// Loading the core (mirror-client-design.md "The wasm: build, serve, load", as built in MIR-1).
//
// A fresh wasm instance per client, so that `dispose()` gives its `WebAssembly.Memory` back.
// wasm-bindgen's `--target web` glue keeps its instance in a module-level variable, and a page's
// module map keeps every module record it ever loaded, `?client=<n>` variants included: measured in
// the pinned Chromium, each mount of a `?client=<n>` glue import kept its ~287 MB instance after
// dispose and a forced GC. So `build-web.sh` wraps the glue's module body in a factory function
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

import { CLIENT_CORE_METHODS, type GswRsModule } from "./abi";

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

/** The marker build-web.sh's factory module exports beside its default. */
interface GlueFactoryModule {
  RENDER_STREAM_CLIENT_GLUE?: number;
  default?: () => GswRsModule;
}

const compiled = new Map<string, Promise<WebAssembly.Module>>();
const factories = new Map<string, Promise<() => GswRsModule>>();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

async function readBuild(
  core: RenderStreamCore,
  wasmUrl: string,
): Promise<CoreBuild> {
  const url = core.buildUrl
    ? new URL(core.buildUrl, location.href).href
    : new URL("build.json", wasmUrl).href;
  let b: CoreBuild;
  try {
    const res = await fetch(url, { cache: "no-cache" });
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

function compileOnce(
  wasmUrl: string,
  build: CoreBuild,
): Promise<WebAssembly.Module> {
  let p = compiled.get(wasmUrl);
  if (p === undefined) {
    p = (async () => {
      const res = await fetch(wasmUrl);
      if (!res.ok)
        throw new CoreLoadError(`GET ${wasmUrl}: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
      if (sha !== build.wasm_sha256)
        throw new CoreLoadError(
          `stale core: ${wasmUrl} has sha256 ${sha}, its build.json names ${build.wasm_sha256}`,
        );
      return WebAssembly.compile(bytes);
    })();
    compiled.set(wasmUrl, p);
    // A failed compile is retried by the next client.
    p.catch(() => compiled.delete(wasmUrl));
  }
  return p;
}

function factoryOnce(glueUrl: string): Promise<() => GswRsModule> {
  let p = factories.get(glueUrl);
  if (p === undefined) {
    p = (async () => {
      const m = (await import(/* @vite-ignore */ glueUrl)) as GlueFactoryModule;
      if (m.RENDER_STREAM_CLIENT_GLUE !== 1 || typeof m.default !== "function")
        throw new CoreLoadError(
          `${glueUrl} is not build-web.sh's factory glue (rs_gsw_wasm_client.js)`,
        );
      return m.default;
    })();
    factories.set(glueUrl, p);
    p.catch(() => factories.delete(glueUrl));
  }
  return p;
}

/** One fresh core instance: its glue (a new closure) and its memory. */
export async function loadCore(
  core: RenderStreamCore,
): Promise<{ mod: GswRsModule; memory: WebAssembly.Memory; build: CoreBuild }> {
  const wasmUrl = new URL(core.wasmUrl, location.href).href;
  const glueUrl = new URL(core.glueUrl, location.href).href;
  const build = await readBuild(core, wasmUrl);
  const [module, createGlue] = await Promise.all([
    compileOnce(wasmUrl, build),
    factoryOnce(glueUrl),
  ]);
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
  const { memory } = await mod.default({ module_or_path: module });
  return { mod, memory, build };
}
