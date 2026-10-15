/**
 * The page half of `test/canvasItemsRustPixel.test.ts`: draws one case of `./canvas-items-cases`
 * through BOTH executors on the real GPU and hands back every frame's bytes:
 *
 * - TypeScript: G7c's `@godot-scene-web/canvas` executor into a `StageTarget` (RGB10_A2 or RGBA8),
 *   `readPixels` of the target, then `StageTarget.blit()` and a read of the canvas;
 * - Rust: the `canvas-items` executor through `CanvasItemsTestHarness` (the `canvas-items-test`
 *   wasm module, served by the test at `/rust/`), `read_target` and `read_canvas`.
 *
 * Each executor gets its own canvas and context per case; both are released (WEBGL_lose_context)
 * afterwards so a long run never hits the browser's live-context limit.
 */

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  type BlendMode,
  type CanvasTextureHandle,
  createCanvasExecutor,
  createCanvasStage,
  createClipRectView,
  createDrawList,
  createStageTarget,
  createTextureBinding,
  createTextureCache,
  createTexturedMeshView,
  type DrawList,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";
import {
  type Blend,
  caseByName,
  encodePdl1,
  type ItemsCase,
  tintOf,
} from "./canvas-items-cases";

/** The `canvas-items-test` module's surface (its generated `.d.ts` lives in ignored artifacts). */
interface RustHarness {
  load(pdl: Uint8Array): void;
  update(pdl: Uint8Array): void;
  mark_all(): void;
  upload_texture(
    id: number,
    width: number,
    height: number,
    rgba: Uint8Array,
  ): void;
  context_state(): string;
  execute(): string;
  merged_draw_count(): number;
  read_target(): Uint8Array;
  read_canvas(): Uint8Array;
  poll_fence(): number;
  gl_error(): number;
  free(): void;
}
interface RustModule {
  default(options: { module_or_path: string }): Promise<unknown>;
  CanvasItemsTestHarness: new (
    canvas: HTMLCanvasElement,
    sabotage: string,
  ) => RustHarness;
}

export interface ItemsFrame {
  tsTarget: number[];
  tsCanvas: number[];
  rustTarget: number[];
  rustCanvas: number[];
  /** The Rust executor's `ExecStats` for this frame. */
  stats: Record<string, number>;
  /** `gsw_canvas_draw_list::DrawList::merged_draw_count` of the held list. */
  mergedDrawCount: number;
}

export interface ItemsCaseResult {
  width: number;
  height: number;
  frames: ItemsFrame[];
  tsGlError: number;
  rustGlError: number;
  renderer: string;
  /** Context-loss case only: what the harness reported along the way. */
  loss?: {
    stateAfterLoss: string;
    executeWhileLost: string;
    stateAfterRestore: string;
    executeWithoutResend: string;
  };
}

let rust: RustModule | null = null;

async function rustModule(): Promise<RustModule> {
  if (rust) return rust;
  // A runtime URL: the test serves the generated glue and wasm; esbuild must not bundle it.
  const url = "/rust/canvas_items.js";
  const loaded = (await import(/* @vite-ignore */ url)) as RustModule;
  await loaded.default({ module_or_path: "/rust/canvas_items_bg.wasm" });
  rust = loaded;
  return loaded;
}

function blendMode(blend: Blend): BlendMode {
  if (blend === "add") return BLEND_ADD;
  if (blend === "sub") return BLEND_SUB;
  if (blend === "mul") return BLEND_MUL;
  // premul_alpha is MIX over premultiplied data (G7c); disabled is only ever used opaque.
  return BLEND_MIX;
}

function releaseContext(gl: WebGL2RenderingContext | null): void {
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

function rendererString(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
}

/** Rows top-down of the bound default framebuffer. */
function readDefault(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): number[] {
  const buffer = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  const out = new Array<number>(buffer.length);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    const from = (height - 1 - row) * stride;
    for (let i = 0; i < stride; i += 1)
      out[row * stride + i] = buffer[from + i];
  }
  return out;
}

/** The TypeScript executor: one context, every frame of `spec`. */
function runTypeScript(spec: ItemsCase): {
  frames: { target: number[]; canvas: number[] }[];
  glError: number;
  renderer: string;
} {
  const canvas = document.createElement("canvas");
  const stage = createCanvasStage({
    canvas,
    designWidth: spec.width,
    designHeight: spec.height,
  });
  if (!stage) throw new Error("no WebGL2 context for the canvas stage");
  stage.setStageSize(spec.width, spec.height);
  const gl = stage.gl;
  const textures = createTextureCache(gl);
  const executor = createCanvasExecutor({ gl, white: textures.white() });
  const target = createStageTarget(gl, {
    format: spec.format === "rgb10a2" ? "rgb10_a2" : "rgba8",
    width: spec.width,
    height: spec.height,
  });
  if (!target.allocated) throw new Error("the stage target is not renderable");
  const handles = new Map<number, CanvasTextureHandle>();
  for (const t of spec.textures) {
    handles.set(
      t.id,
      textures.acquireBytes(`t${t.id}`, t.rgba, t.width, t.height, {
        straightAlpha: true,
      }),
    );
  }
  const clear = tintOf(spec.clear, "mix");
  const frames: { target: number[]; canvas: number[] }[] = [];
  for (const items of spec.frames) {
    const list: DrawList<ExecutorTexture | null> =
      createDrawList<ExecutorTexture | null>();
    for (const mesh of spec.meshes) {
      const item = items[mesh.item];
      if (mesh.scissor) {
        const clip = createClipRectView();
        [clip.x, clip.y, clip.w, clip.h] = mesh.scissor;
        list.pushClipRect(clip);
      }
      const view = createTexturedMeshView(
        mesh.vertices.length,
        mesh.indices.length,
      );
      view.m.set(item.xform);
      mesh.vertices.forEach((v, i) => {
        view.positions.set(v.pos, i * 2);
        view.uvs.set(v.uv, i * 2);
        view.vertexColors?.set(v.color, i * 4);
      });
      view.vertexCount = mesh.vertices.length;
      view.indices.set(mesh.indices);
      view.indexCount = mesh.indices.length;
      view.hasVertexColors = true;
      const premul = mesh.blend === "premul_alpha";
      view.premultipliedVertexColors = premul;
      [view.r, view.g, view.b, view.a] = tintOf(item.modulate, mesh.blend);
      view.blend = blendMode(mesh.blend);
      let texture: ExecutorTexture | null = null;
      if (mesh.texture !== 0) {
        const handle = handles.get(mesh.texture);
        if (!handle) throw new Error(`texture ${mesh.texture} missing`);
        texture = createTextureBinding(handle, {
          wrap: mesh.wrap,
          filter: mesh.filter,
          straightAlpha: !premul,
        });
      }
      list.pushTexturedMesh(view, texture);
      if (mesh.scissor) list.popClip();
    }
    target.bind();
    if (!executor.execute(list, stage.projection(), { clearColor: clear })) {
      throw new Error("the canvas executor could not build its program");
    }
    const bytes = target.readPixels();
    if (!bytes) throw new Error("target readback failed");
    if (!target.blit()) throw new Error("the stage target could not present");
    frames.push({
      target: Array.from(bytes),
      canvas: readDefault(gl, spec.width, spec.height),
    });
  }
  const glError = gl.getError();
  const renderer = rendererString(gl);
  executor.dispose();
  textures.dispose();
  target.dispose();
  stage.dispose();
  releaseContext(gl);
  return { frames, glError, renderer };
}

function uploadTextures(harness: RustHarness, spec: ItemsCase): void {
  for (const t of spec.textures)
    harness.upload_texture(t.id, t.width, t.height, t.rgba);
}

function rustFrame(harness: RustHarness): {
  target: number[];
  canvas: number[];
  stats: Record<string, number>;
  merged: number;
} {
  const merged = harness.merged_draw_count();
  const stats = JSON.parse(harness.execute()) as Record<string, number>;
  return {
    target: Array.from(harness.read_target()),
    canvas: Array.from(harness.read_canvas()),
    stats,
    merged,
  };
}

function waitFor(canvas: HTMLCanvasElement, event: string): Promise<void> {
  return new Promise((resolve) => {
    canvas.addEventListener(event, () => resolve(), { once: true });
  });
}

function errorText(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    return String(error);
  }
}

export async function runItemsCase(
  name: string,
  sabotage: string,
  contextLoss = false,
): Promise<ItemsCaseResult> {
  const spec = caseByName(name);
  const module = await rustModule();
  const ts = runTypeScript(spec);

  const canvas = document.createElement("canvas");
  const harness = new module.CanvasItemsTestHarness(canvas, sabotage);
  const frames: ItemsFrame[] = [];
  let loss: ItemsCaseResult["loss"];
  spec.frames.forEach((_, frame) => {
    const pdl = encodePdl1(spec, frame);
    if (frame === 0) {
      uploadTextures(harness, spec);
      harness.load(pdl);
    } else {
      harness.update(pdl);
    }
    const out = rustFrame(harness);
    frames.push({
      tsTarget: ts.frames[frame].target,
      tsCanvas: ts.frames[frame].canvas,
      rustTarget: out.target,
      rustCanvas: out.canvas,
      stats: out.stats,
      mergedDrawCount: out.merged,
    });
  });
  const gl = canvas.getContext("webgl2");
  if (contextLoss) {
    // Lose and restore the Rust context, then re-send frame 0 in full: it must draw the same.
    const ext = gl?.getExtension("WEBGL_lose_context");
    if (!ext) throw new Error("WEBGL_lose_context unavailable");
    const lost = waitFor(canvas, "webglcontextlost");
    ext.loseContext();
    await lost;
    // Resume on a later task: this await returns inside the event's dispatch, and Chromium records
    // the listener's preventDefault (which is what allows a restore) only once dispatch finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stateAfterLoss = harness.context_state();
    const executeWhileLost = errorText(() => harness.execute());
    const restored = waitFor(canvas, "webglcontextrestored");
    ext.restoreContext();
    await restored;
    const stateAfterRestore = harness.context_state();
    harness.update(encodePdl1(spec, 0));
    const executeWithoutResend = errorText(() => harness.execute());
    uploadTextures(harness, spec);
    harness.load(encodePdl1(spec, 0));
    const out = rustFrame(harness);
    frames.push({
      tsTarget: ts.frames[0].target,
      tsCanvas: ts.frames[0].canvas,
      rustTarget: out.target,
      rustCanvas: out.canvas,
      stats: out.stats,
      mergedDrawCount: out.merged,
    });
    loss = {
      stateAfterLoss,
      executeWhileLost,
      stateAfterRestore,
      executeWithoutResend,
    };
  }
  const rustGlError = harness.gl_error();
  harness.free();
  releaseContext(gl);
  return {
    width: spec.width,
    height: spec.height,
    frames,
    tsGlError: ts.glError,
    rustGlError,
    renderer: ts.renderer,
    loss,
  };
}

/** Fence polling across tasks: execute one frame, then poll on later macrotasks. */
export async function fenceProbe(name: string): Promise<number[]> {
  const spec = caseByName(name);
  const module = await rustModule();
  const canvas = document.createElement("canvas");
  const harness = new module.CanvasItemsTestHarness(canvas, "");
  uploadTextures(harness, spec);
  harness.load(encodePdl1(spec, 0));
  harness.execute();
  const polls = [harness.poll_fence()];
  for (let i = 0; i < 20 && polls[polls.length - 1] === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    polls.push(harness.poll_fence());
  }
  polls.push(harness.poll_fence());
  const gl = canvas.getContext("webgl2");
  harness.free();
  releaseContext(gl);
  return polls;
}

declare global {
  interface Window {
    __gswCanvasItems: {
      run(
        name: string,
        sabotage: string,
        contextLoss?: boolean,
      ): Promise<ItemsCaseResult>;
      fence(name: string): Promise<number[]>;
    };
  }
}

window.__gswCanvasItems = { run: runItemsCase, fence: fenceProbe };
