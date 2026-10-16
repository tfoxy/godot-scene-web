// G7s (gate7-design.md Q5 "Materials", Q14c): custom ShaderMaterial code to item-space programs.
//
// After a transaction is accepted and its payloads provided, every custom shader its named
// materials name that has no program yet is transpiled to an item-space module by
// `@godot-scene-web/effects` (`transpileGodotItemShader`) and handed to wasm once per code hash,
// which compiles it in the `canvas-items` executor and registers it with the applier. A `withheld`
// shader's code comes from RS_RECEIVER_SHADER_LIBRARY (`<library>/sha256/<hash>.grp`, verified in
// wasm against its name; a library read is not a fetch). A transpiler refusal is typed
// `gsw-shader-transpile` with its message, a GL compile failure the same with GL's log, and missing
// library code `shader-withheld`: each draws its items without their material, as the native
// receiver draws a shaderless one. Shared by the receiver page and the bench page.

// `@godot-scene-web/effects`' development entry (its source), by path: the experiment is not a
// workspace package.
import {
  transpileGodotItemShader,
  UnsupportedShaderError,
} from "../../../../packages/effects/src/shaders";

/** The part of `rs-gsw-wasm`'s `GswRs` this module drives (web/gsw-rs/src/lib.rs). */
export interface ProgramHost {
  pending_shaders(): number;
  pending_hash(i: number): string;
  pending_shader_id(i: number): bigint;
  pending_withheld(i: number): boolean;
  pending_code(i: number): string | undefined;
  alloc_payload(len: number): number;
  provide_library(i: number, len: number): number;
  define_program(i: number, glsl: string, meta: string): number;
  refuse_program(i: number, reason: string, detail: string): number;
  error(): string;
}

export interface ProgramCounts {
  defined: number;
  refused: number;
  library_reads: number;
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
  const out: ProgramCounts = { defined: 0, refused: 0, library_reads: 0 };
  const n = g.pending_shaders();
  for (let i = 0; i < n; i++) {
    const label = `shader ${g.pending_shader_id(i)} (${g.pending_hash(i)})`;
    let code = g.pending_code(i);
    if (code === undefined && g.pending_withheld(i)) {
      if (library === null) {
        g.refuse_program(
          i,
          "shader-withheld",
          "RS_RECEIVER_SHADER_LIBRARY is unset",
        );
        out.refused++;
        continue;
      }
      const url = `${library}/sha256/${g.pending_hash(i)}.grp`;
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) {
        g.refuse_program(i, "shader-withheld", `the library has no ${url}`);
        out.refused++;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      out.library_reads++;
      const p = g.alloc_payload(bytes.length);
      new Uint8Array(mem.buffer, p, bytes.length).set(bytes);
      if (g.provide_library(i, bytes.length) < 0) {
        g.refuse_program(i, "shader-withheld", g.error());
        out.refused++;
        continue;
      }
      code = g.pending_code(i);
    }
    if (code === undefined)
      throw new ProgramError(
        "resource-unavailable",
        `${label}: its code is not held`,
      );
    let transpiled: ReturnType<typeof transpileGodotItemShader>;
    try {
      transpiled = transpileGodotItemShader(code);
    } catch (e) {
      if (!(e instanceof UnsupportedShaderError)) throw e;
      g.refuse_program(i, "gsw-shader-transpile", e.message);
      log(`${label} not transpiled: ${e.message}`);
      out.refused++;
      continue;
    }
    const { glsl, ...meta } = transpiled;
    const r = g.define_program(i, glsl, JSON.stringify(meta));
    if (r < 0) throw new ProgramError("receiver-error", g.error());
    if (r === 1) {
      log(`${label} did not compile`);
      out.refused++;
    } else out.defined++;
  }
  return out;
}
