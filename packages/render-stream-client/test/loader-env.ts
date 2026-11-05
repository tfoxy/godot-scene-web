// A scripted loader env: every step answers at once unless a test replaces it (a stall, a delay).

import { CLIENT_CORE_METHODS } from "../src/abi";
import type { CoreBuild, LoaderEnv } from "../src/loader";
import { sha256 } from "../src/sha256";

export const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const BUILD: CoreBuild = {
  schema: "render-stream-client-core/1",
  rs_core_build: "sha=test",
  rs_core_tree: "tree",
  wasm_sha256: hex(sha256(WASM)),
  wasm_bytes: WASM.byteLength,
  wasm_bindgen: "0.2.129",
  glue: "rs_gsw_wasm_client.js",
  wasm: "rs_gsw_wasm_bg.wasm",
};

/** Never settles. */
export const stall = <T>(): Promise<T> => new Promise<T>(() => {});
/** Settles with `v` after `ms` of (fake) time. */
export const after = <T>(ms: number, v: T): Promise<T> =>
  new Promise<T>((r) => setTimeout(() => r(v), ms));

export interface Steps {
  build: () => Promise<CoreBuild>;
  wasm: () => Promise<ArrayBuffer>;
  digest: (
    bytes: ArrayBuffer,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer | Uint8Array>;
  compile: () => Promise<WebAssembly.Module>;
  glue: () => Promise<unknown>;
  init: () => Promise<{ memory: WebAssembly.Memory }>;
}

/** Each URL a load fetched, with its signal. */
export interface FetchCall {
  url: string;
  signal: AbortSignal | null | undefined;
}

export function scriptedEnv(over: Partial<Steps> = {}) {
  const steps: Steps = {
    build: async () => BUILD,
    wasm: async () => WASM,
    digest: async (bytes) => sha256(bytes),
    compile: async () => ({}) as WebAssembly.Module,
    glue: async () => glueModule,
    init: async () => ({ memory: new WebAssembly.Memory({ initial: 1 }) }),
    ...over,
  };
  const fetches: FetchCall[] = [];
  const counts = { glues: 0, cores: 0 };
  class GswRs {
    constructor() {
      counts.cores++;
    }
  }
  for (const k of CLIENT_CORE_METHODS)
    (GswRs.prototype as unknown as Record<string, unknown>)[k] = () => 0;
  class LiveCoding {
    free() {}
  }
  const glueModule = {
    RENDER_STREAM_CLIENT_GLUE: 1,
    default: () => {
      counts.glues++;
      return { GswRs, LiveCoding, default: () => steps.init() };
    },
  };
  const env: LoaderEnv = {
    fetch: async (url, init) => {
      fetches.push({ url, signal: init.signal });
      if (url.endsWith("build.json")) {
        const b = await steps.build();
        return { ok: true, json: async () => b } as Response;
      }
      const bytes = await steps.wasm();
      return { ok: true, arrayBuffer: async () => bytes } as Response;
    },
    digest: (bytes, signal) => steps.digest(bytes, signal),
    compile: () => steps.compile(),
    importGlue: () => steps.glue(),
  };
  return { env, fetches, counts, glueModule };
}

let next = 0;
/** Core URLs no other test used: the loader's caches are per page. */
export function freshCore() {
  next++;
  return {
    glueUrl: `/core${next}/rs_gsw_wasm_client.js`,
    wasmUrl: `/core${next}/rs_gsw_wasm_bg.wasm`,
  };
}
