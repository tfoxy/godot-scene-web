/**
 * The page half of `test/canvasItemsProgramPixel.test.ts` (G7s): draws one case of
 * `./canvas-items-program-cases` through the Rust `canvas-items` executor's item-space program
 * path on the real GPU. Each program's Godot code is transpiled here by `@godot-scene-web/effects`
 * (`transpileGodotItemShader`), compiled by the executor (`define_program`), and its binding set
 * on the list (`set_binding`) before one `execute`; the target is read back.
 */

import { transpileGodotItemShader } from "@godot-scene-web/effects/shaders";
import { encodePdl1 } from "./canvas-items-cases";
import { programCaseByName } from "./canvas-items-program-cases";

interface RustHarness {
  load(pdl: Uint8Array): void;
  upload_texture(
    id: number,
    width: number,
    height: number,
    rgba: Uint8Array,
  ): void;
  define_program(id: number, module: string): void;
  set_binding(slot: number, json: string): void;
  execute(): string;
  read_target(): Uint8Array;
  gl_error(): number;
  free(): void;
}
interface RustModule {
  default(options: { module_or_path: string }): Promise<unknown>;
  CanvasItemsTestHarness: {
    with_options(
      canvas: HTMLCanvasElement,
      sabotage: string,
      godotOrientation: boolean,
    ): RustHarness;
  };
}

export interface ProgramCaseResult {
  width: number;
  height: number;
  target: number[];
  stats: Record<string, number>;
  /** Program id -> the definition's error (compile log), for those that failed. */
  defineErrors: Record<number, string>;
  glError: number;
  renderer: string;
}

let rust: RustModule | null = null;

async function rustModule(): Promise<RustModule> {
  if (rust) return rust;
  const url = "/rust/canvas_items.js";
  const loaded = (await import(/* @vite-ignore */ url)) as RustModule;
  await loaded.default({ module_or_path: "/rust/canvas_items_bg.wasm" });
  rust = loaded;
  return loaded;
}

/** `godot`: draw in Godot's orientation (`ExecOptions::godot_orientation`, G7t); the target is
 * read back in design rows either way, so a case's expectations hold in both. */
async function run(name: string, godot = false): Promise<ProgramCaseResult> {
  const spec = programCaseByName(name);
  const module = await rustModule();
  const canvas = document.createElement("canvas");
  canvas.width = spec.items.width;
  canvas.height = spec.items.height;
  document.body.append(canvas);
  const harness = module.CanvasItemsTestHarness.with_options(
    canvas,
    spec.sabotage ?? "",
    godot,
  );
  try {
    for (const t of spec.items.textures)
      harness.upload_texture(t.id, t.width, t.height, t.rgba);
    harness.load(encodePdl1(spec.items, 0));
    const defineErrors: Record<number, string> = {};
    for (const p of spec.programs) {
      const glsl =
        p.code === null
          ? "this is not GLSL;"
          : transpileGodotItemShader(p.code).glsl;
      try {
        harness.define_program(p.id, glsl);
      } catch (e) {
        defineErrors[p.id] = String(e);
      }
    }
    for (const b of spec.bindings) {
      const { slot, ...binding } = b;
      harness.set_binding(slot, JSON.stringify(binding));
    }
    const stats = JSON.parse(harness.execute()) as Record<string, number>;
    const target = Array.from(harness.read_target());
    const gl = canvas.getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      width: spec.items.width,
      height: spec.items.height,
      target,
      stats,
      defineErrors,
      glError: harness.gl_error(),
      renderer:
        info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "",
    };
  } finally {
    harness.free();
    canvas.remove();
  }
}

declare global {
  interface Window {
    __gswCanvasItemsPrograms: {
      run(name: string, godot?: boolean): Promise<ProgramCaseResult>;
    };
  }
}

window.__gswCanvasItemsPrograms = { run };
