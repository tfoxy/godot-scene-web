/**
 * The page half of `test/canvasModesPixel.test.ts`: it draws the opt-in Godot
 * CanvasItem modes of `@godot-scene-web/canvas` — per-vertex colours,
 * premultiplied sources (Godot's PREMULT_ALPHA), per-binding wrap/filter,
 * straight-alpha storage and the
 * RGB10_A2 stage target — on a REAL GPU and hands back every pixel of every
 * frame, top-down, as bytes (plus the raw 10-bit words for the RGB10_A2 cases).
 *
 * WHOLE FRAMES, NOT SAMPLES. The test compares a complete predicted image with a
 * channel budget, so a stray pixel anywhere fails, not only at the points a
 * sampler would have picked.
 *
 * NO PREDICTION HERE. The inputs come from `./modes-cases` and the expected
 * pixels are computed in the test, in Node, from the GL and Godot rules it cites.
 */

import {
  BLEND_MIX,
  type BlendMode,
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
  type CanvasTextureHandle,
  createCanvasExecutor,
  createCanvasStage,
  createDrawList,
  createQuadView,
  createStageTarget,
  createTextureBinding,
  createTextureCache,
  createTexturedMeshView,
  type DrawList,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";
import {
  FILTER_QUAD_HEIGHT,
  FILTER_QUAD_WIDTH,
  FILTER_TEXELS,
  GRADIENT_LEFT,
  GRADIENT_RIGHT,
  MODES_STAGE,
  PREMUL_BACKGROUND,
  PREMUL_MODULATE,
  PREMUL_TEXEL,
  PREMUL_VERTEX,
  RAMP_HEIGHT,
  RAMP_WIDTH,
  type Rgba,
  rampLevels,
  STACK_BASE,
  STACK_LAYER_ALPHA,
  STACK_LAYER_COLOUR,
  STACK_LAYERS,
  STACK_TRANSLUCENT,
  TEXTURED_MODULATE,
  TEXTURED_TEXEL,
  TEXTURED_VERTEX,
  WRAP_BAND_ROWS,
  WRAP_BANDS,
  WRAP_QUAD_WIDTH,
  WRAP_SRC_W,
  WRAP_SRC_X,
  WRAP_TEXELS,
} from "./modes-cases";

export interface ModesFrame {
  width: number;
  height: number;
  /** Top-down RGBA bytes. */
  data: number[];
}

export interface ModesCaseResult {
  /** `canvas` (the stage's default framebuffer), or for RGB10_A2 cases `target`
   *  (8-bit readback of the RGB10_A2 target), `canvasAfterBlit` (the canvas
   *  after `StageTarget.blit`), `canvasRawBlit` (after a plain
   *  `blitFramebuffer`, for the record) and, where the scene was also drawn
   *  straight into the 8-bit canvas, `rgba8`. */
  frames: Record<string, ModesFrame>;
  /** Raw `UNSIGNED_INT_2_10_10_10_REV` words of the target, top-down, when offered. */
  packed: number[] | null;
  /** `gl.getError()` after the case; 0 is `NO_ERROR`. */
  glError: number;
  renderer: string;
}

interface CaseContext {
  stage: CanvasStage;
  gl: WebGL2RenderingContext;
  list: DrawList<ExecutorTexture | null>;
  textures: CanvasTextureCache;
  executor: CanvasExecutor;
  white: CanvasTextureHandle;
}

function bytesOf(texels: readonly Rgba[]): Uint8Array {
  const out = new Uint8Array(texels.length * 4);
  texels.forEach((texel, i) => {
    out.set(texel, i * 4);
  });
  return out;
}

function premultiplied(colour: Rgba): Rgba {
  return [
    colour[0] * colour[3],
    colour[1] * colour[3],
    colour[2] * colour[3],
    colour[3],
  ];
}

/** An axis-aligned quad at (x, y) of w x h sampling `src` of `texture`. */
function pushRect(
  context: CaseContext,
  texture: ExecutorTexture,
  rect: { x: number; y: number; w: number; h: number },
  src: { x: number; y: number; w: number; h: number },
  tint: Rgba,
  blend: BlendMode = BLEND_MIX,
): void {
  const quad = createQuadView();
  quad.m.set([1, 0, 0, 1, rect.x, rect.y]);
  quad.w = rect.w;
  quad.h = rect.h;
  quad.srcX = src.x;
  quad.srcY = src.y;
  quad.srcW = src.w;
  quad.srcH = src.h;
  [quad.r, quad.g, quad.b, quad.a] = tint;
  quad.blend = blend;
  context.list.pushQuad(quad, texture);
}

/** A solid premultiplied fill on the white texel. */
function pushFill(
  context: CaseContext,
  rect: { x: number; y: number; w: number; h: number },
  tint: Rgba,
): void {
  pushRect(context, context.white, rect, { x: 0, y: 0, w: 1, h: 1 }, tint);
}

/** A rect as a two-triangle mesh, corner colours top-left, top-right,
 *  bottom-right, bottom-left (STRAIGHT unless `premultipliedColours`), all
 *  UVs at the texture's centre. */
function pushColouredRect(
  context: CaseContext,
  texture: ExecutorTexture | null,
  rect: { x: number; y: number; w: number; h: number },
  corners: readonly [Rgba, Rgba, Rgba, Rgba],
  tint: Rgba,
  premultipliedColours = false,
): void {
  const mesh = createTexturedMeshView(4, 6);
  mesh.positions.set([
    rect.x,
    rect.y,
    rect.x + rect.w,
    rect.y,
    rect.x + rect.w,
    rect.y + rect.h,
    rect.x,
    rect.y + rect.h,
  ]);
  mesh.uvs.fill(0.5);
  mesh.indices.set([0, 1, 2, 0, 2, 3]);
  mesh.vertexCount = 4;
  mesh.indexCount = 6;
  mesh.hasVertexColors = true;
  corners.forEach((colour, i) => {
    mesh.vertexColors?.set(colour, i * 4);
  });
  mesh.premultipliedVertexColors = premultipliedColours;
  [mesh.r, mesh.g, mesh.b, mesh.a] = tint;
  context.list.pushTexturedMesh(mesh, texture);
}

const OPAQUE_WHITE: Rgba = [1, 1, 1, 1];

type CaseRun = (context: CaseContext) => ModesCaseResult | null;

interface CaseSpec {
  width: number;
  height: number;
  build(context: CaseContext): void;
  /** Override how the frame is produced and read; default executes into the
   *  canvas and reads it as `canvas`. */
  run?: CaseRun;
}

function readDefault(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): ModesFrame {
  const buffer = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  const data = new Array<number>(buffer.length);
  for (let row = 0; row < height; row += 1) {
    const from = (height - 1 - row) * width * 4;
    for (let i = 0; i < width * 4; i += 1)
      data[row * width * 4 + i] = buffer[from + i];
  }
  return { width, height, data };
}

function executeOrThrow(context: CaseContext): void {
  if (!context.executor.execute(context.list, context.stage.projection())) {
    throw new Error("the canvas executor could not build its program");
  }
}

/** Draw into an RGB10_A2 target, read it both ways, blit it, read the canvas. */
function runInTarget(
  context: CaseContext,
  alsoRgba8: boolean,
): ModesCaseResult {
  const { gl, stage } = context;
  const target = createStageTarget(gl, {
    width: stage.stageWidth,
    height: stage.stageHeight,
  });
  if (!target.allocated)
    throw new Error("the RGB10_A2 target is not renderable");
  target.bind();
  executeOrThrow(context);
  const bytes = target.readPixels();
  const packed = target.readPacked();
  // For the record only: what a plain blitFramebuffer would have presented.
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST);
  const { width, height } = target;
  gl.blitFramebuffer(
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  const canvasRawBlit = readDefault(gl, stage.stageWidth, stage.stageHeight);
  if (!target.blit()) throw new Error("the RGB10_A2 target could not present");
  const frames: Record<string, ModesFrame> = {
    target: { width, height, data: Array.from(bytes ?? []) },
    canvasAfterBlit: readDefault(gl, stage.stageWidth, stage.stageHeight),
    canvasRawBlit,
  };
  if (alsoRgba8) {
    // The same list straight into the 8-bit canvas: what the target buys.
    executeOrThrow(context);
    frames.rgba8 = readDefault(gl, stage.stageWidth, stage.stageHeight);
  }
  target.dispose();
  return {
    frames,
    packed: packed ? Array.from(packed) : null,
    glError: gl.getError(),
    renderer: "",
  };
}

const CASES: Record<string, CaseSpec> = {
  vertexGradient: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const size = MODES_STAGE;
      pushColouredRect(
        context,
        null,
        { x: 0, y: 0, w: size, h: size },
        [GRADIENT_LEFT, GRADIENT_RIGHT, GRADIENT_RIGHT, GRADIENT_LEFT],
        OPAQUE_WHITE,
      );
    },
  },

  vertexTextured: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const texel = context.textures.acquireBytes(
        "textured",
        bytesOf([TEXTURED_TEXEL]),
        1,
        1,
        { straightAlpha: true },
      );
      pushColouredRect(
        context,
        texel,
        { x: 0, y: 0, w: MODES_STAGE, h: MODES_STAGE },
        [TEXTURED_VERTEX, TEXTURED_VERTEX, TEXTURED_VERTEX, TEXTURED_VERTEX],
        premultiplied(TEXTURED_MODULATE),
      );
    },
  },

  // Godot's BLEND_MODE_PREMULT_ALPHA recipe (see BlendMode's note): MIX, the
  // straight-stored texel read AS GIVEN through a binding, vertex colours used
  // as given, the straight modulate as the tint. Band 1 is the same texel read
  // straight under MIX, for contrast.
  premultipliedSource: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const size = MODES_STAGE;
      const band = size / 4;
      pushFill(
        context,
        { x: 0, y: 0, w: size, h: size },
        premultiplied(PREMUL_BACKGROUND),
      );
      const texel = context.textures.acquireBytes(
        "premultiplied-content",
        bytesOf([PREMUL_TEXEL]),
        1,
        1,
        { straightAlpha: true },
      );
      const asGiven = createTextureBinding(texel, { straightAlpha: false });
      const src = { x: 0, y: 0, w: 1, h: 1 };
      pushRect(
        context,
        asGiven,
        { x: 0, y: 0, w: size, h: band },
        src,
        OPAQUE_WHITE,
      );
      pushRect(
        context,
        texel,
        { x: 0, y: band, w: size, h: band },
        src,
        OPAQUE_WHITE,
      );
      pushColouredRect(
        context,
        asGiven,
        { x: 0, y: band * 2, w: size, h: band },
        [PREMUL_VERTEX, PREMUL_VERTEX, PREMUL_VERTEX, PREMUL_VERTEX],
        OPAQUE_WHITE,
        true,
      );
      pushRect(
        context,
        asGiven,
        { x: 0, y: band * 3, w: size, h: band },
        src,
        PREMUL_MODULATE,
      );
    },
  },

  wrap: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const page = context.textures.acquireBytes(
        "wrap-page",
        bytesOf(WRAP_TEXELS),
        WRAP_TEXELS.length,
        1,
      );
      WRAP_BANDS.forEach((sampling, i) => {
        pushRect(
          context,
          createTextureBinding(page, sampling),
          {
            x: 0,
            y: i * WRAP_BAND_ROWS,
            w: WRAP_QUAD_WIDTH,
            h: WRAP_BAND_ROWS,
          },
          { x: WRAP_SRC_X, y: 0, w: WRAP_SRC_W, h: 1 },
          OPAQUE_WHITE,
        );
      });
    },
  },

  straightFilter: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const page = context.textures.acquireBytes(
        "filter-straight",
        bytesOf(FILTER_TEXELS),
        2,
        1,
        {
          straightAlpha: true,
        },
      );
      pushRect(
        context,
        page,
        { x: 0, y: 0, w: FILTER_QUAD_WIDTH, h: FILTER_QUAD_HEIGHT },
        { x: 0, y: 0, w: 2, h: 1 },
        OPAQUE_WHITE,
      );
    },
  },

  // THE SABOTAGE VARIANT: the same page premultiplied ON UPLOAD (the cache's
  // default), so filtering blends premultiplied texels. The test requires this to
  // MISS the straight-filter prediction by more than one level.
  straightFilterPremultipliedUpload: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const page = context.textures.acquireBytes(
        "filter-premultiplied",
        bytesOf(FILTER_TEXELS),
        2,
        1,
      );
      pushRect(
        context,
        page,
        { x: 0, y: 0, w: FILTER_QUAD_WIDTH, h: FILTER_QUAD_HEIGHT },
        { x: 0, y: 0, w: 2, h: 1 },
        OPAQUE_WHITE,
      );
    },
  },

  rgb10a2Ramp: {
    width: RAMP_WIDTH,
    height: RAMP_HEIGHT,
    build(context) {
      for (let i = 0; i < RAMP_WIDTH; i += 1) {
        const [r, g, b] = rampLevels(i);
        pushFill(context, { x: i, y: 0, w: 1, h: 1 }, [
          r / 1023,
          g / 1023,
          b / 1023,
          1,
        ]);
        pushFill(context, { x: i, y: 1, w: 1, h: 1 }, [0, 0, 0, i / 1023]);
      }
    },
    run: (context) => runInTarget(context, false),
  },

  rgb10a2Stack: {
    width: MODES_STAGE,
    height: MODES_STAGE,
    build(context) {
      const half = MODES_STAGE / 2;
      pushFill(context, { x: 0, y: 0, w: half, h: MODES_STAGE }, [
        STACK_BASE,
        STACK_BASE,
        STACK_BASE,
        1,
      ]);
      const layer = premultiplied([
        STACK_LAYER_COLOUR,
        STACK_LAYER_COLOUR,
        STACK_LAYER_COLOUR,
        STACK_LAYER_ALPHA,
      ]);
      for (let i = 0; i < STACK_LAYERS; i += 1) {
        pushFill(context, { x: 0, y: 0, w: half, h: MODES_STAGE }, layer);
      }
      pushFill(
        context,
        { x: half, y: 0, w: half, h: MODES_STAGE },
        premultiplied(STACK_TRANSLUCENT),
      );
    },
    run: (context) => runInTarget(context, true),
  },
};

function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return "";
    return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return "";
  }
}

export function runModesCase(name: string): ModesCaseResult {
  const spec = CASES[name];
  if (!spec) throw new Error(`unknown canvas modes case "${name}"`);
  // A canvas per case: no state leaks between cases.
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
  const context: CaseContext = {
    stage,
    gl,
    list: createDrawList<ExecutorTexture | null>(),
    textures,
    executor,
    white: textures.white(),
  };
  spec.build(context);
  let result: ModesCaseResult | null = spec.run ? spec.run(context) : null;
  if (!result) {
    executeOrThrow(context);
    result = {
      frames: { canvas: readDefault(gl, spec.width, spec.height) },
      packed: null,
      glError: gl.getError(),
      renderer: "",
    };
  }
  result.renderer = rendererString(gl);
  executor.dispose();
  textures.dispose();
  stage.dispose();
  return result;
}

export function listModesCases(): string[] {
  return Object.keys(CASES);
}

declare global {
  interface Window {
    __gswCanvasModes: {
      run(name: string): ModesCaseResult;
      cases(): string[];
    };
  }
}

window.__gswCanvasModes = { run: runModesCase, cases: listModesCases };
