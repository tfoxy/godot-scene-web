// Custom ShaderMaterial code to item-space programs.
//
// After a transaction is accepted and its payloads provided, every custom shader its named
// materials name that has no program yet is transpiled to an item-space module by
// `@godot-scene-web/effects` (`transpileGodotItemShader`) and handed to wasm once per code hash,
// which compiles it in the `canvas-items` executor and registers it with the applier. A `withheld`
// shader's code comes from RS_RECEIVER_SHADER_LIBRARY (`<library>/sha256/<hash>.grp`, verified in
// wasm against its name; a library read is not a fetch). A transpiler refusal is typed
// `gsw-shader-transpile` with its message, a GL compile failure the same with GL's log, and missing
// library code `shader-withheld`: each draws its items without their material, as the native
// receiver draws a shaderless one. Shared by the client (client.ts), the harness receiver page
// (experiments/render-stream/web/gsw-receiver) and the bench page.

import {
  transpileGodotItemShader,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";

// One warm-up per loaded client module. A real transpile makes it unnecessary, even if its
// shader is refused; a definePrograms call with nothing pending (every apply) does not. No host or wasm instance is passed to the idle callback.
let warmupScheduled = false;
let transpilerUsed = false;

export function scheduleTranspilerWarmup(): void {
  if (warmupScheduled || transpilerUsed) return;
  warmupScheduled = true;
  const warm = () => {
    if (transpilerUsed) return;
    transpilerUsed = true;
    try {
      transpileGodotItemShader(`shader_type canvas_item;
        uniform float strength = 0.5;
        uniform vec4 tint : source_color = vec4(1.0);
        void fragment() {
          vec4 texel = texture(TEXTURE, UV);
          COLOR = mix(texel, texel * tint, strength + sin(TIME) * 0.1);
        }`);
    } catch {
      // Opportunistic JIT warm-up must never affect client startup or error reporting.
    }
  };
  if (typeof globalThis.requestIdleCallback === "function")
    globalThis.requestIdleCallback(warm);
  else globalThis.setTimeout(warm, 0);
}

/** The part of `rs-gsw-wasm`'s `GswRs` this module drives (web/gsw-rs/src/lib.rs). */
export interface ProgramHost {
  pending_shaders(): number;
  pending_hash(i: number): string;
  pending_shader_id(i: number): bigint;
  pending_withheld(i: number): boolean;
  pending_code(i: number): string | undefined;
  alloc_payload(len: number): number;
  provide_library(i: number, len: number): number;
  define_program(
    i: number,
    glsl: string,
    meta: string,
    vertexGlsl: string,
  ): number;
  refuse_program(i: number, reason: string, detail: string): number;
  hold_program?(i: number): number;
  error(): string;
}

export interface ProgramCounts {
  defined: number;
  refused: number;
  library_reads: number;
  /** Distinct code hashes defined with the same fragment and vertex GLSL as an earlier one.
   * Measurement only; metadata (including uniform defaults) is not compared. Optional for
   * callers supplying the older counter shape; definitions initialize it to zero. */
  identical_glsl?: number;
}

// The host owns the program lifetime. Tracking survives slices and reconnects that retain it,
// and is collected with the host when the wasm instance is replaced.
const glslDefinitions = new WeakMap<
  ProgramHost,
  { codes: Set<string>; sources: Map<number, Set<string>> }
>();

function countIdenticalGlsl(
  g: ProgramHost,
  out: ProgramCounts,
  codeHash: string,
  glsl: string,
  vertexGlsl: string,
): void {
  let seen = glslDefinitions.get(g);
  if (seen === undefined) {
    seen = { codes: new Set(), sources: new Map() };
    glslDefinitions.set(g, seen);
  }
  if (seen.codes.has(codeHash)) return;
  seen.codes.add(codeHash);
  // Hash both stages once. Check the complete strings inside each bucket so a hash collision
  // cannot count different GLSL as identical. The length keeps the stage boundary unambiguous.
  const source = `${vertexGlsl.length}:${vertexGlsl}${glsl}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++)
    hash = Math.imul(hash ^ source.charCodeAt(i), 0x01000193);
  const bucket = seen.sources.get(hash);
  if (bucket === undefined) seen.sources.set(hash, new Set([source]));
  else if (bucket.has(source))
    out.identical_glsl = (out.identical_glsl ?? 0) + 1;
  else bucket.add(source);
}

export class ProgramError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** Resolve every pending shader of the accepted transaction (see the file note). Throws
 * `ProgramError` only for a usage error or payload code that is not held. */
export async function resolvePrograms(
  g: ProgramHost,
  mem: WebAssembly.Memory,
  library: string | null,
  log: (line: string) => void = () => {},
): Promise<ProgramCounts> {
  const out: ProgramCounts = {
    defined: 0,
    refused: 0,
    library_reads: 0,
    identical_glsl: 0,
  };
  await provideLibrary(g, mem, library, out);
  definePrograms(g, out, log);
  return out;
}

/** Whether any pending shader still needs its code from the library (an async read): live mode
 * does those reads before the rAF callback that applies the transaction. */
export function needsLibrary(g: ProgramHost, library: string | null): boolean {
  if (library === null) return false;
  const n = g.pending_shaders();
  for (let i = 0; i < n; i++)
    if (g.pending_code(i) === undefined && g.pending_withheld(i)) return true;
  return false;
}

/** Step 1: every pending `withheld` shader's code from RS_RECEIVER_SHADER_LIBRARY (verified in
 * wasm against its name), or its refusal `shader-withheld`. */
export async function provideLibrary(
  g: ProgramHost,
  mem: WebAssembly.Memory,
  library: string | null,
  out: ProgramCounts,
): Promise<void> {
  const n = g.pending_shaders();
  const reads: { hash: string; bytes: Uint8Array | null; why: string }[] = [];
  for (let i = 0; i < n; i++) {
    if (g.pending_code(i) !== undefined || !g.pending_withheld(i)) continue;
    const hash = g.pending_hash(i);
    if (library === null) {
      reads.push({
        hash,
        bytes: null,
        why: "RS_RECEIVER_SHADER_LIBRARY is unset",
      });
      continue;
    }
    const url = `${library}/sha256/${hash}.grp`;
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) {
      reads.push({ hash, bytes: null, why: `the library has no ${url}` });
      continue;
    }
    reads.push({
      hash,
      bytes: new Uint8Array(await res.arrayBuffer()),
      why: "",
    });
    out.library_reads++;
  }
  // Pending indices change as shaders are refused, so each read is matched by hash.
  for (const r of reads) {
    const i = pendingIndex(g, r.hash);
    if (i < 0) continue;
    if (r.bytes === null) {
      g.refuse_program(i, "shader-withheld", r.why);
      out.refused++;
      continue;
    }
    const p = g.alloc_payload(r.bytes.length);
    new Uint8Array(mem.buffer, p, r.bytes.length).set(r.bytes);
    if (g.provide_library(i, r.bytes.length) < 0) {
      g.refuse_program(i, "shader-withheld", g.error());
      out.refused++;
    }
  }
}

function pendingIndex(g: ProgramHost, hash: string): number {
  const n = g.pending_shaders();
  for (let i = 0; i < n; i++) if (g.pending_hash(i) === hash) return i;
  return -1;
}

export const LIVE_PROGRAM_BUDGET = { ms: 4, max: 3 } as const;

/** Step 2: transpile and define pending shaders, holding the rest when the optional budget is
 * spent. At least one is attempted. Older wasm without `hold_program` defines them all.
 * Returns whether shaders were held for a later call. */
export function definePrograms(
  g: ProgramHost,
  out: ProgramCounts,
  log: (line: string) => void = () => {},
  budget?: { ms: number; max: number },
): boolean {
  out.identical_glsl ??= 0;
  const limit = g.hold_program === undefined ? undefined : budget;
  const start = limit === undefined ? 0 : performance.now();
  let attempted = 0;
  for (let guard = 2 * g.pending_shaders() + 1; guard > 0; guard--) {
    const n = g.pending_shaders();
    if (n === 0) return false;
    if (
      limit !== undefined &&
      attempted > 0 &&
      (attempted >= limit.max || performance.now() - start >= limit.ms)
    ) {
      for (let i = 0; i < n; i++) {
        if (g.hold_program?.(i) === -1)
          throw new ProgramError("receiver-error", g.error());
      }
      return true;
    }
    attempted++;
    const i = 0;
    const codeHash = g.pending_hash(i);
    const label = `shader ${g.pending_shader_id(i)} (${codeHash})`;
    const code = g.pending_code(i);
    if (code === undefined) {
      if (g.pending_withheld(i)) {
        g.refuse_program(
          i,
          "shader-withheld",
          "RS_RECEIVER_SHADER_LIBRARY is unset",
        );
        out.refused++;
        continue;
      }
      throw new ProgramError(
        "resource-unavailable",
        `${label}: its code is not held`,
      );
    }
    let transpiled: ReturnType<typeof transpileGodotItemShader>;
    try {
      transpilerUsed = true;
      transpiled = transpileGodotItemShader(code);
    } catch (e) {
      if (!(e instanceof UnsupportedShaderError)) throw e;
      g.refuse_program(i, "gsw-shader-transpile", e.message);
      log(`${label} not transpiled: ${e.message}`);
      out.refused++;
      continue;
    }
    // The vertex module (null: the plain vertex stage) travels beside the fragment one.
    const { glsl, vertexGlsl, ...meta } = transpiled;
    const r = g.define_program(i, glsl, JSON.stringify(meta), vertexGlsl ?? "");
    if (r < 0) throw new ProgramError("receiver-error", g.error());
    if (r === 1) {
      log(`${label} did not compile`);
      out.refused++;
    } else {
      out.defined++;
      countIdenticalGlsl(g, out, codeHash, glsl, vertexGlsl ?? "");
    }
  }
  return false;
}
