// What the GSW receiver's file mode (main.ts) and live mode (live.ts, G7l) share: the wasm-bindgen
// surface of `rs-gsw-wasm`, its stats block, the harness's `window.__rsShell` contract, the log,
// the failure type, the module loader and the session's viewport report (receiver.gd
// `_begin_session`/`_adopt_presentation` as GSW draws them).

import type { ReceiverConfig } from "./config";

/** The wasm-bindgen surface of `rs-gsw-wasm` (web/gsw-rs/src/lib.rs). */
export interface GswRs {
  alloc_recording(len: number): number;
  load(len: number): number;
  start(): number;
  accept(index: number): number;
  needed_count(): number;
  needed_ptr(): number;
  needed_kinds_ptr(): number;
  alloc_payload(len: number): number;
  provide(len: number): number;
  /** G7o2: verify and decode a payload on arrival / provide the next needed one from there. */
  stage_payload(len: number, hash: string): number;
  provide_staged(): number;
  payload_verify_json(): string;
  apply(): number;
  draw(): number;
  stats_ptr(): number;
  digest(): number;
  poll_fence(): number;
  shot(): number;
  target_width(): number;
  target_height(): number;
  error(): string;
  session_meta(): string;
  // G7g: the window this receiver presents into, and how it adopted the session's presentation.
  set_window(width: number, height: number): void;
  presentation_json(): string;
  state_dump(): string;
  applied_json_parts(): string;
  evidence_json(): string;
  shader_params_jsonl(): string;
  pending_shaders(): number;
  pending_hash(i: number): string;
  pending_shader_id(i: number): bigint;
  pending_withheld(i: number): boolean;
  pending_code(i: number): string | undefined;
  provide_library(i: number, len: number): number;
  define_program(i: number, glsl: string, meta: string): number;
  refuse_program(i: number, reason: string, detail: string): number;
  // G7l live mode.
  rx(len: number): number;
  live_session(len: number): number;
  live_accept(len: number): number;
  last_digest_ptr(): number;
  live_rebuild(): number;
  dispose_json(): string;
  live_reset(keepPayloads: boolean): number;
  memory_hashes(): string;
  // G7u: the in-place context restore (D14, D29).
  restore_missing(): string;
  restore_take(hash: string): number;
  /** Whether a payload is staged (verified on arrival, not yet in the store). */
  is_staged(hash: string): boolean;
  restore_json(): string;
  // G7k (Q10 soak): live mode's residency and budget (D29 amendment).
  residency_json(): string;
  free(): void;
}

export interface GswRsModule {
  default(init: {
    module_or_path: BufferSource;
  }): Promise<{ memory: WebAssembly.Memory }>;
  GswRs: { new (canvas: HTMLCanvasElement, options: string): GswRs };
}

export const ACCEPT_TRANSACTION = 0;
export const ACCEPT_RESOURCE = 1;
export const ACCEPT_END = 2;
export const ACCEPT_NEEDS_PAYLOADS = 3;

/** lib.rs `Stats`, `#[repr(C)]`, all u32, in this order. */
export const STAT_FIELDS = [
  "status",
  "seq",
  "frame",
  "needed",
  "structural",
  "relowered",
  "rows_written",
  "lowered_draws",
  "assembly_skips",
  "emitted_draws",
  "expected_calls",
  "executed_calls",
  "merged_draws",
  "texture_uploads",
  "texture_upload_bytes",
  "item_bytes",
  "vertex_bytes",
  "index_bytes",
  "parity_violations",
  "accepted_records",
  "digests_pending",
  "vertices",
  "indices",
  "draws",
  "encoding",
  "stream",
] as const;
export type StatName = (typeof STAT_FIELDS)[number];

/** A reader of the stats block, its view re-derived whenever memory grew (Q14c step 5). */
export function statsReader(
  g: GswRs,
  mem: WebAssembly.Memory,
): () => Record<StatName, number> {
  let view: Uint32Array | null = null;
  let buffer: ArrayBuffer | null = null;
  return () => {
    if (buffer !== mem.buffer || !view) {
      buffer = mem.buffer;
      view = new Uint32Array(mem.buffer, g.stats_ptr(), STAT_FIELDS.length);
    }
    const out = {} as Record<StatName, number>;
    STAT_FIELDS.forEach((k, i) => {
      out[k] = (view as Uint32Array)[i];
    });
    return out;
  };
}

export interface ShellState {
  exit: { code: number; t: number } | null;
  error: string | null;
  contextLost: boolean;
  lines: { t: number; stream: string; line: string }[];
}

declare global {
  interface Window {
    __rsShell?: ShellState;
    __rsWasmHeap?: () => number | null;
  }
}

export const shell: ShellState = {
  exit: null,
  error: null,
  contextLost: false,
  lines: [],
};
window.__rsShell = shell;

export function log(text: string): void {
  const line = `[receiver] ${text}`;
  shell.lines.push({ t: performance.now(), stream: "out", line });
  console.log(line);
}

export const nextFrame = (): Promise<number> =>
  new Promise((res) => requestAnimationFrame(res));
export const nowUs = (): number => performance.now() * 1000;
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class ReplayFailure extends Error {
  constructor(
    readonly seq: number | null,
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** A wasm error string `code: detail` as a failure (receiver.gd `_fail_with_error`). */
export function failWith(seq: number | null, error: string): ReplayFailure {
  const at = error.indexOf(": ");
  return at < 0
    ? new ReplayFailure(seq, error, "")
    : new ReplayFailure(seq, error.slice(0, at), error.slice(at + 2));
}

export function finish(code: number): void {
  shell.exit = { code, t: performance.now() };
}

/** The canvas, with Q5 "Context loss" kept restorable and the shell's `css-opacity` sabotage. */
export function setUpCanvas(cfg: ReceiverConfig): HTMLCanvasElement {
  const canvas = document.getElementById("frame") as HTMLCanvasElement;
  if (cfg.shellSabotage === "css-opacity") canvas.style.opacity = "0.99";
  canvas.addEventListener("webglcontextlost", (e) => {
    // Q5 "Context loss": keep the context restorable. After the restore, draw() re-creates
    // every GL object and re-uploads every resident texture (the live receiver holds credit
    // while lost and redraws in place, live.ts `stepContext`).
    e.preventDefault();
    shell.contextLost = true;
    log("webgl context lost");
  });
  canvas.addEventListener("webglcontextrestored", () =>
    log("webgl context restored"),
  );
  return canvas;
}

/** Step 1 (Q14c): the module (outside every timer). */
export async function loadModule(): Promise<{
  mod: GswRsModule;
  memory: WebAssembly.Memory;
}> {
  const base = new URL(".", location.href).href;
  const mod = (await import(
    /* @vite-ignore */ `${base}gsw-rs/rs_gsw_wasm.js`
  )) as GswRsModule;
  const wasmBytes = await (
    await fetch(`${base}gsw-rs/rs_gsw_wasm_bg.wasm`)
  ).arrayBuffer();
  const memory = (await mod.default({ module_or_path: wasmBytes })).memory;
  window.__rsWasmHeap = () => memory.buffer.byteLength;
  performance.mark("rs-gsw-wasm-ready");
  return { mod, memory };
}

export interface SessionMeta {
  session_id?: string;
  stream?: { stream_id?: string; connection?: unknown; transport?: string };
  viewport?: {
    logical_size?: [number, number];
    presentation_size?: [number, number] | null;
    stretch?: { mode?: string } | null;
  };
  resources?: {
    delivery?: string;
    fetch?: string;
    http_path?: string | null;
    auth?: string;
  };
  publication?: { mode?: string; credit_window?: number } | null;
}

/** The session's viewport report (receiver.gd `_begin_session`, `_adopt_presentation`) and its
 * session-level typed entries, for a session GSW drew at `canvas`'s size. */
export function viewportReport(
  cfg: ReceiverConfig,
  canvas: HTMLCanvasElement,
  session: SessionMeta,
  presentationJson = "",
): {
  viewport: Record<string, unknown>;
  unsupported: { seq: null; item: null; name: string; reason: string }[];
  logical: [number, number];
} {
  const vp = session.viewport ?? {};
  const logical = vp.logical_size ?? [canvas.width, canvas.height];
  const presentation = vp.presentation_size ?? null;
  const ignorePresentation = cfg.sabotage.includes("ignore-presentation");
  const stretchMode = vp.stretch?.mode ?? "disabled";
  const unsupported: { seq: null; item: null; name: string; reason: string }[] =
    [];
  if (stretchMode === "viewport")
    unsupported.push({
      seq: null,
      item: null,
      name: "viewport",
      reason: "stretch-mode",
    });
  // G7g: the presentation as the wasm module adopted it (`set_window`, `presentation_json`): the
  // window it draws into, the stretch's own oversampling, and the receiver-typed mismatches.
  const adopted = (
    presentationJson ? JSON.parse(presentationJson) : null
  ) as PresentationAdopted | null;
  for (const reason of adopted?.typed ?? [])
    unsupported.push({ seq: null, item: null, name: "viewport", reason });
  return {
    viewport: {
      display_server: "web",
      size: [canvas.width, canvas.height],
      size_check: ignorePresentation ? "ignored" : "ok",
      logical_size: logical,
      canvas_transform: [],
      presentation_size: presentation,
      window_size: adopted?.window ?? [canvas.width, canvas.height],
      oversampling: adopted?.oversampling ?? 1.0,
      presentation_check: adopted
        ? adopted.presentation_check
        : presentation === null
          ? null
          : "ok",
      stretch_applied:
        adopted?.stretch_applied ??
        (!ignorePresentation && stretchMode === "canvas_items"),
    },
    unsupported,
    logical,
  };
}

/** G7g: `GswRs.presentation_json()`. */
export interface PresentationAdopted {
  window: [number, number];
  target: [number, number];
  oversampling: number;
  stretch_applied: boolean;
  presentation_check: "ok" | "mismatch" | null;
  typed: string[];
}
