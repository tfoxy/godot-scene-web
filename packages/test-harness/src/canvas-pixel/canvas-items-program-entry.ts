/**
 * The page half of `test/canvasItemsProgramPixel.test.ts`: draws one case of
 * `./canvas-items-program-cases` through the Rust `canvas-items` executor's item-space program
 * path on the real GPU. Each program's Godot code is transpiled here by `@godot-scene-web/effects`
 * (`transpileGodotItemShader`), compiled by the executor (`define_program`), and its binding set
 * on the list (`set_binding`) before one `execute`; the target is read back.
 *
 * J1 modes: `async` begins every link (`begin_program`, no status read), executes once before any
 * poll (each program pending, its draws skipped), polls once per animation frame until every link
 * settled, and executes the list again; `async-loss` loses the context while the links are pending,
 * polls (nothing settles while lost), restores it, polls (the restore recompiled them), re-sends
 * textures and list, and executes; `async-loss-poll` polls in the task that loses the context,
 * before its event (the status reads fail on the lost context), then restores the same way. Either way the final target must meet the synchronous case's
 * expectations.
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
  define_program_vertex(id: number, module: string, vertex: string): void;
  begin_program(id: number, module: string, vertex: string): void;
  poll_programs(): string;
  program_pending(id: number): boolean;
  context_state(): string;
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
  /** J1 modes: what the execute before the first poll saw, and how the links settled. */
  linking?: {
    pendingBeforePoll: number[];
    skippedBeforePoll: number;
    polls: number;
    /** `async-loss`: links settled by the poll while lost, the context state then. */
    settledWhileLost?: number;
    stateWhileLost?: string;
    /** Program id -> how many polls reported it settled. */
    reports: Record<number, number>;
  };
}

export type ProgramMode = "sync" | "async" | "async-loss" | "async-loss-poll";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitFor(canvas: HTMLCanvasElement, event: string): Promise<void> {
  return new Promise((resolve) => {
    canvas.addEventListener(event, () => resolve(), { once: true });
  });
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

/** `godot`: draw in Godot's orientation (`ExecOptions::godot_orientation`); the target is
 * read back in design rows either way, so a case's expectations hold in both. */
async function run(
  name: string,
  godot = false,
  mode: ProgramMode = "sync",
): Promise<ProgramCaseResult> {
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
      const t = p.code === null ? null : transpileGodotItemShader(p.code);
      const glsl = t === null ? "this is not GLSL;" : t.glsl;
      try {
        if (mode !== "sync")
          harness.begin_program(p.id, glsl, t?.vertexGlsl ?? "");
        // a program with its own vertex stage.
        else if (t?.vertexGlsl)
          harness.define_program_vertex(p.id, glsl, t.vertexGlsl);
        else harness.define_program(p.id, glsl);
      } catch (e) {
        defineErrors[p.id] = String(e);
      }
    }
    const bind = () => {
      for (const b of spec.bindings) {
        const { slot, ...binding } = b;
        harness.set_binding(slot, JSON.stringify(binding));
      }
    };
    bind();
    let linking: ProgramCaseResult["linking"];
    if (mode !== "sync") {
      const pendingBeforePoll = spec.programs
        .map((p) => p.id)
        .filter((id) => harness.program_pending(id));
      let settledWhileLost: number | undefined;
      let stateWhileLost: string | undefined;
      let skippedBeforePoll = -1;
      if (mode === "async") {
        const before = JSON.parse(harness.execute()) as Record<string, number>;
        skippedBeforePoll = before.drawsSkipped ?? -1;
      } else {
        const ext = canvas
          .getContext("webgl2")
          ?.getExtension("WEBGL_lose_context");
        if (!ext) throw new Error("WEBGL_lose_context unavailable");
        const lost = waitFor(canvas, "webglcontextlost");
        ext.loseContext();
        if (mode === "async-loss-poll")
          // The same task: the executor has not seen the loss event yet.
          settledWhileLost = (JSON.parse(harness.poll_programs()) as unknown[])
            .length;
        await lost;
        // A later task: Chromium records the listener's preventDefault once dispatch finishes.
        await new Promise((resolve) => setTimeout(resolve, 0));
        settledWhileLost =
          (settledWhileLost ?? 0) +
          (JSON.parse(harness.poll_programs()) as unknown[]).length;
        stateWhileLost = harness.context_state();
        const restored = waitFor(canvas, "webglcontextrestored");
        ext.restoreContext();
        await restored;
      }
      let polls = 0;
      const reports: Record<number, number> = {};
      const settle = (rows: [number, string | null][]) => {
        for (const [id, log] of rows) {
          reports[id] = (reports[id] ?? 0) + 1;
          if (log !== null) defineErrors[id] = log;
        }
      };
      while (
        spec.programs.some((p) => harness.program_pending(p.id)) &&
        polls < 600
      ) {
        await nextFrame();
        settle(
          JSON.parse(harness.poll_programs()) as [number, string | null][],
        );
        polls++;
      }
      // A restored context lost every texture and needs the whole list again; the async case
      // re-sends the list too, so its second execute draws everything.
      if (mode !== "async")
        for (const t of spec.items.textures)
          harness.upload_texture(t.id, t.width, t.height, t.rgba);
      harness.load(encodePdl1(spec.items, 0));
      bind();
      linking = {
        pendingBeforePoll,
        skippedBeforePoll,
        polls,
        settledWhileLost,
        stateWhileLost,
        reports,
      };
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
      linking,
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
      run(
        name: string,
        godot?: boolean,
        mode?: ProgramMode,
      ): Promise<ProgramCaseResult>;
    };
  }
}

window.__gswCanvasItemsPrograms = { run };
