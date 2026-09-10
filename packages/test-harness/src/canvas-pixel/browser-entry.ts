/**
 * The page half of `test/canvasPixelXvfb.test.ts`: it builds small draw lists,
 * runs `@godot-scene-web/canvas`'s WebGL2 executor over them on a REAL GPU, and
 * reads the drawing buffer back.
 *
 * WHY A BROWSER AT ALL, when the executor already has a full unit suite. Those
 * tests run against a recording stand-in for the context; they can prove how many
 * draws a frame took and in what order the state around them was set, and they
 * are blind to everything that happens after the call — whether the blend factors
 * compose to the arithmetic they were chosen for, whether the scissor's Y really
 * is flipped, whether the colour matrix reaches the fragment transposed the right
 * way, whether a nine-patch's bands land where the algebra says. Each of those is
 * a single number in a shader or a single boolean in a GL call, and each of them
 * is silent: nothing errors, the picture is merely wrong.
 *
 * WHAT IS READ. `gl.readPixels` on the stage's own drawing buffer, which holds
 * PREMULTIPLIED bytes by the package's contract — so an expectation here is the
 * premultiplied number, not what a compositor would show over a page. (The
 * canvas->page composite is a different question, already covered for the shared
 * WebGL path by `webglCompositeXvfb.test.ts`.) Rows come back bottom-up; `sample`
 * flips them so every coordinate below is stated in DESIGN space, top-left origin,
 * like the draw lists themselves.
 *
 * EXACT SAMPLES, NOT FUZZY ONES. Every texture is built so that a sampled point
 * lands on a TEXEL CENTRE: the nine-patch page is 9x9 with 3x3 blocks against
 * 3-pixel margins, so its corner bands map 1:1 and its centre band's midpoint is
 * the middle texel's own centre. That keeps LINEAR filtering out of the
 * assertions without turning filtering off — the executor really does filter, and
 * a test that pinned NEAREST would be testing a renderer nobody ships.
 */

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  type BlendMode,
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
  type CanvasTextureHandle,
  createCanvasExecutor,
  createCanvasStage,
  createClipRectView,
  createDrawList,
  createHeadlessGodotParticleDirectEffect,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTextureCache,
  type DrawList,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";
import { createHeadlessEffectsStage } from "@godot-scene-web/canvas-effects/webgl";
import {
  FX_SOURCE_DECOY,
  FX_SOURCE_SIZE,
  FX_SOURCE_STRAIGHT,
} from "./fx-source";

/** Design AND framebuffer size: 1:1, so a sample coordinate is a design
 *  coordinate is a pixel. */
export const STAGE_SIZE = 64;

/** The 9x9 nine-patch page, as 3x3 blocks of nine distinct opaque colours. */
export const PATCH_COLOURS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [128, 0, 0],
  [0, 128, 0],
  [0, 0, 128],
];

export interface PixelCaseResult {
  /** Sampled pixels, PREMULTIPLIED bytes straight out of the drawing buffer. */
  samples: Record<string, [number, number, number, number]>;
  /** `drawArraysInstanced` calls the executor issued. */
  draws: number;
  /** Quad instances it pushed. */
  quads: number;
  /** Pixel uploads the texture cache made, and how many of those re-specified
   *  the texture's storage. The difference is how many went through `update`'s
   *  `texSubImage2D` re-upload path — which no fake-context test can see, since
   *  its whole effect is on pixels. */
  textureUploads: number;
  textureRespecs: number;
  /** The unmasked GL renderer, for the log. */
  renderer: string;
}

interface CaseContext {
  effects: ReturnType<typeof createHeadlessEffectsStage>;
  list: DrawList<ExecutorTexture | null>;
  textures: CanvasTextureCache;
  /**
   * Run the executor over the list AS IT STANDS, exactly as the final pass at
   * the end of `runPixelCase` does (same executor, same projection, same clear).
   *
   * Only one kind of case needs this: one that proves an edit to an
   * ALREADY-EXECUTED list reaches the GPU. Without a first execute there is
   * nothing for a stale cache to serve, and the case would pass against an
   * executor that memoised every command.
   */
  executeNow(): void;
  /** A 1x1 opaque white texel. */
  white: CanvasTextureHandle;
  /** The 9x9 block page described above. */
  patch: CanvasTextureHandle;
  /** A 1x1 texel of HALF-ALPHA red, uploaded from straight bytes. Translucent on
   *  purpose: a colour matrix applied to premultiplied channels instead of
   *  straight ones is indistinguishable on an OPAQUE texel, so the case that
   *  tests the difference needs a texel whose alpha is not 1. */
  halfRed: CanvasTextureHandle;
}

function blockPage(): Uint8Array {
  const pixels = new Uint8Array(9 * 9 * 4);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const [r, g, b] =
        PATCH_COLOURS[Math.floor(y / 3) * 3 + Math.floor(x / 3)];
      const at = (y * 9 + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/**
 * A 2D canvas painted with STRAIGHT-alpha bytes, standing in for an effect
 * runtime's per-node canvas.
 *
 * `putImageData` rather than a `fillStyle` fill, so the bytes are stated exactly
 * rather than parsed out of a CSS colour string and rounded on the way through
 * the canvas's own store. What comes back out of the upload is then the round
 * trip under test and nothing else.
 */
function straightAlphaCanvas(
  colour: readonly [number, number, number, number],
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FX_SOURCE_SIZE;
  canvas.height = FX_SOURCE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context for the fx source canvas");
  const image = ctx.createImageData(FX_SOURCE_SIZE, FX_SOURCE_SIZE);
  for (let at = 0; at < image.data.length; at += 4) {
    image.data[at] = colour[0];
    image.data[at + 1] = colour[1];
    image.data[at + 2] = colour[2];
    image.data[at + 3] = colour[3];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The fx surface as a stage texture: a decoy frame first, then the real one over
 * it at the SAME size — which is the path `update` takes with `texSubImage2D`
 * rather than a fresh `texImage2D`. Reading the decoy back at the end would mean
 * the re-upload wrote nothing.
 */
function fxSurfaceTexture(context: CaseContext): CanvasTextureHandle {
  context.textures.update("fx://surface", straightAlphaCanvas(FX_SOURCE_DECOY));
  return context.textures.update(
    "fx://surface",
    straightAlphaCanvas(FX_SOURCE_STRAIGHT),
  );
}

/** A full-stage quad in one premultiplied colour, under `blend`. */
function pushFill(
  context: CaseContext,
  colour: [number, number, number, number],
  blend: BlendMode = BLEND_MIX,
): void {
  const quad = createQuadView();
  quad.w = STAGE_SIZE;
  quad.h = STAGE_SIZE;
  quad.srcW = 1;
  quad.srcH = 1;
  [quad.r, quad.g, quad.b, quad.a] = colour;
  quad.blend = blend;
  context.list.pushQuad(quad, context.white);
}

const CASES: Record<
  string,
  (context: CaseContext) => Record<string, [number, number]>
> = {
  // An opaque tinted quad, and the untouched clear next to it. The simplest
  // thing that can be wrong: geometry, projection, viewport, clear.
  opaque(context) {
    const quad = createQuadView();
    quad.m.set([1, 0, 0, 1, 8, 8]);
    quad.w = 32;
    quad.h = 16;
    quad.srcW = 1;
    quad.srcH = 1;
    quad.r = 0.2;
    quad.g = 0.4;
    quad.b = 0.6;
    quad.a = 1;
    context.list.pushQuad(quad, context.white);
    return { inside: [20, 14], outside: [50, 50], belowQuad: [20, 40] };
  },

  // MIX over an opaque background: `src + dst * (1 - src.a)` on premultiplied
  // colour, which is the pairing the canvas is declared for.
  blendMix(context) {
    pushFill(context, [0.2, 0.4, 0.6, 1]);
    pushFill(context, [0.5, 0.5, 0.5, 0.5], BLEND_MIX);
    return { centre: [32, 32] };
  },

  blendAdd(context) {
    pushFill(context, [0.2, 0.4, 0.6, 1]);
    pushFill(context, [0.5, 0.25, 0.1, 0.5], BLEND_ADD);
    return { centre: [32, 32] };
  },

  // Reverse-subtract on COLOUR with the alpha equation left additive: the
  // destination darkens and keeps its coverage.
  blendSub(context) {
    pushFill(context, [0.8, 0.6, 0.4, 1]);
    pushFill(context, [0.25, 0.25, 0.25, 0.5], BLEND_SUB);
    return { centre: [32, 32] };
  },

  blendMul(context) {
    pushFill(context, [0.8, 0.6, 0.4, 1]);
    pushFill(context, [0.5, 0.5, 0.5, 0.5], BLEND_MUL);
    return { centre: [32, 32] };
  },

  // A HALF-ALPHA quad on an opaque texel: the tint is premultiplied, so the
  // buffer must hold `rgb*a` and an alpha of exactly a.
  tint(context) {
    pushFill(context, [0.4, 0.2, 0.1, 0.5]);
    return { centre: [32, 32] };
  },

  // The colour matrix, on a HALF-ALPHA red texel under a half-alpha tint. Both
  // halves matter: the translucent texel is what separates "matrix applied to
  // straight colour" from "matrix applied to the premultiplied channels" (on an
  // opaque texel the two agree exactly), and the asymmetric matrix is what
  // separates a row-major upload from a transposed one.
  colorMatrix(context) {
    const quad = createQuadView();
    quad.w = STAGE_SIZE;
    quad.h = STAGE_SIZE;
    quad.srcW = 1;
    quad.srcH = 1;
    quad.a = 0.5;
    quad.r = 0.5;
    quad.g = 0.5;
    quad.b = 0.5;
    // Rotate the channels: red in -> green out. Transposed, the same nine floats
    // send red to BLUE.
    quad.colorMatrix.set([0, 0, 1, 1, 0, 0, 0, 1, 0]);
    quad.hasColorMatrix = true;
    context.list.pushQuad(quad, context.halfRed);
    return { centre: [32, 32] };
  },

  // Nested clips: the intersection paints, everything else does not — including
  // the region inside each clip separately but not both.
  nestedClips(context) {
    const outer = createClipRectView();
    outer.x = 0;
    outer.y = 0;
    outer.w = 40;
    outer.h = 40;
    const inner = createClipRectView();
    inner.x = 20;
    inner.y = 20;
    inner.w = 40;
    inner.h = 40;
    context.list.pushClipRect(outer);
    context.list.pushClipRect(inner);
    pushFill(context, [1, 1, 1, 1]);
    context.list.popClip();
    context.list.popClip();
    return {
      intersection: [30, 30],
      outerOnly: [10, 10],
      innerOnly: [50, 50],
      neither: [55, 10],
    };
  },

  // The scissor's Y flip, isolated: a clip on the TOP quarter of the stage.
  topClip(context) {
    const clip = createClipRectView();
    clip.x = 0;
    clip.y = 0;
    clip.w = STAGE_SIZE;
    clip.h = 16;
    context.list.pushClipRect(clip);
    pushFill(context, [1, 1, 1, 1]);
    context.list.popClip();
    return { top: [32, 8], bottom: [32, 56] };
  },

  // Rounded corners: the centre and the four edge midpoints survive, the corners
  // are discarded.
  roundedClip(context) {
    const clip = createClipRectView();
    clip.x = 0;
    clip.y = 0;
    clip.w = STAGE_SIZE;
    clip.h = STAGE_SIZE;
    clip.cornerRadius = 20;
    context.list.pushClipRect(clip);
    pushFill(context, [1, 1, 1, 1]);
    context.list.popClip();
    return {
      centre: [32, 32],
      edge: [32, 2],
      corner: [2, 2],
      farCorner: [61, 61],
    };
  },

  // Nine-patch: corners at native size, edges stretched on one axis, centre on
  // both. Sampled at texel centres, so each band reports its own block colour.
  ninePatch(context) {
    const patch = createNinePatchView();
    patch.w = 60;
    patch.h = 60;
    patch.srcW = 9;
    patch.srcH = 9;
    patch.marginLeft = 3;
    patch.marginTop = 3;
    patch.marginRight = 3;
    patch.marginBottom = 3;
    context.list.pushNinePatch(patch, context.patch);
    return {
      topLeft: [1, 1],
      topEdge: [30, 1],
      topRight: [58, 1],
      leftEdge: [1, 30],
      centre: [30, 30],
      rightEdge: [58, 30],
      bottomLeft: [1, 58],
      bottomEdge: [30, 58],
      bottomRight: [58, 58],
    };
  },

  // A horizontally flipped sprite: the page's left column must appear on the
  // right. Uses the top row of the block page (red, green, blue).
  flipped(context) {
    const quad = createQuadView();
    quad.w = 60;
    quad.h = 20;
    quad.srcX = 0;
    quad.srcY = 0;
    quad.srcW = 9;
    quad.srcH = 3;
    quad.flipH = true;
    context.list.pushQuad(quad, context.patch);
    return { left: [10, 10], middle: [30, 10], right: [50, 10] };
  },

  // A 2D CANVAS as the texture source, which is the shape an effect surface
  // arrives in: `@godot-scene-web/html`'s shader and particle runtimes render into
  // one shared WebGL context and blit the result onto a per-node 2D canvas, and a
  // consumer compositing those effects into a stage has to get that canvas into a
  // stage texture without changing what its pixels mean.
  //
  // The round trip has a premultiply in the middle of it. A 2D canvas holds
  // STRAIGHT colour: `fillStyle = rgba(255,0,0,0.5)` is (255,0,0) at half
  // coverage, and reading it back gives 255 in the red channel. The stage's
  // textures are premultiplied (see `./textures`), so the upload multiplies —
  // `UNPACK_PREMULTIPLY_ALPHA_WEBGL` — and the texel becomes (128,0,0,128). Both
  // sides of that are silent when wrong: skip the multiply and a translucent
  // effect comes out twice as bright, do it twice and it comes out half.
  //
  // Half alpha, and a channel that is zero: a fully opaque source would make the
  // multiply invisible, and (1,1,1) would make a double multiply invisible too.
  fxCanvasSource(context) {
    const handle = fxSurfaceTexture(context);
    const quad = createQuadView();
    quad.w = STAGE_SIZE;
    quad.h = STAGE_SIZE;
    quad.srcW = handle.width;
    quad.srcH = handle.height;
    context.list.pushQuad(quad, handle);
    return { centre: [32, 32] };
  },

  // The same source under BLEND_ADD, over an opaque background. An additive
  // shader (Godot `render_mode blend_add`) is what the DOM path expresses as
  // `mix-blend-mode: plus-lighter` on the node; a consumer compositing the canvas
  // itself has to reproduce it as a blend state on the quad, and the arithmetic
  // only comes out right if the texel it is adding is premultiplied. A straight
  // texel would add the FULL colour regardless of its coverage.
  fxCanvasSourceAdd(context) {
    pushFill(context, [0.25, 0.25, 0.25, 1]);
    const handle = fxSurfaceTexture(context);
    const quad = createQuadView();
    quad.w = STAGE_SIZE;
    quad.h = STAGE_SIZE;
    quad.srcW = handle.width;
    quad.srcH = handle.height;
    quad.blend = BLEND_ADD;
    context.list.pushQuad(quad, handle);
    return { centre: [32, 32] };
  },

  // One direct particle pass in the SAME framebuffer as the canvas executor.
  // Its translated local origin is sampled at the dot's opaque centre; a
  // separate system canvas/FBO plus composite quad would be a different path.
  directParticle(context) {
    const created = context.effects.createGodotParticleDirectPass({
      config: {
        amount: 1,
        lifetime: 1,
        emitting: true,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
      },
    });
    if (!created.ok) throw new Error(created.diagnostic.message);
    context.list.pushExternalEffect(
      createHeadlessGodotParticleDirectEffect(created.value, {
        time: 1 / 30,
        delta: 1 / 30,
        emitting: true,
        origin: [8, 8],
        transform: [1, 0, 0, 1, 16, 12],
      }),
    );
    return { centre: [24, 20], outside: [4, 4] };
  },

  // Additive resolve must blend into the framebuffer already painted by the
  // executor, and retain its active clip while it resolves the shared light
  // target. This is the direct path Couch uses for comet emitters.
  directAdditiveParticle(context) {
    pushFill(context, [0.1, 0.2, 0.3, 1]);
    const clip = createClipRectView();
    clip.x = 22;
    clip.y = 16;
    clip.w = 10;
    clip.h = 10;
    context.list.pushClipRect(clip);
    const created = context.effects.createGodotParticleDirectPass({
      config: {
        kind: "CPUParticles2D",
        amount: 1,
        lifetime: 1,
        emitting: true,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
        blendMode: 1,
        baseColor: [0.2, 0.1, 0.05, 1],
        baseColorFromProcessMaterial: false,
      },
    });
    if (!created.ok) throw new Error(created.diagnostic.message);
    context.list.pushExternalEffect(
      createHeadlessGodotParticleDirectEffect(created.value, {
        time: 1 / 30,
        delta: 1 / 30,
        emitting: true,
        origin: [8, 8],
        transform: [1, 0, 0, 1, 16, 12],
      }),
    );
    context.list.popClip();
    return {
      centre: [24, 20],
      clippedOutside: [18, 20],
      background: [4, 4],
    };
  },

  // A quad whose colour was PATCHED IN PLACE after a frame had already been
  // drawn with it, then re-executed — the shape a consumer takes when the only
  // thing that changed between two frames is one node's opacity, and it repaints
  // last frame's list rather than rebuilding it.
  //
  // Two things are silent when wrong, and neither is visible to a fake context:
  // an executor that cached the instance it uploaded would repaint the ORIGINAL
  // colour (a fade that never fades), and the patched floats go into the buffer
  // as PREMULTIPLIED colour like every other tint — a patcher that wrote straight
  // colour would be twice as bright at half alpha. So the patched value here is
  // `rgb` already times `a`, and the pre-patch colour is chosen far away from it
  // in every channel.
  patchedColor(context) {
    const quad = createQuadView();
    quad.w = STAGE_SIZE;
    quad.h = STAGE_SIZE;
    quad.srcW = 1;
    quad.srcH = 1;
    quad.r = 0.8;
    quad.g = 0.1;
    quad.b = 0.1;
    quad.a = 1;
    const index = context.list.pushQuad(quad, context.white);
    context.executeNow();
    context.list.patchQuadColor(index, 0.2, 0.3, 0.4, 0.5);
    return { centre: [32, 32] };
  },

  // A stroke, drawn through the same instanced quad path as everything else.
  polyline(context) {
    const line = createPolylineView(4);
    line.points.set([8, 32, 56, 32]);
    line.pointCount = 2;
    line.width = 8;
    line.r = 0;
    line.g = 1;
    line.b = 0;
    line.a = 1;
    context.list.pushPolyline(line);
    return { onLine: [32, 32], aboveLine: [32, 20], pastEnd: [60, 32] };
  },
};

export function listPixelCases(): string[] {
  return Object.keys(CASES);
}

function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return "";
    return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return "";
  }
}

export function runPixelCase(name: string): PixelCaseResult {
  const build = CASES[name];
  if (!build) throw new Error(`unknown canvas pixel case "${name}"`);

  // A canvas per case: no state can leak between them, and a failure is about
  // the case it is reported against.
  const canvas = document.createElement("canvas");
  const created: CanvasStage | null = createCanvasStage({
    canvas,
    designWidth: STAGE_SIZE,
    designHeight: STAGE_SIZE,
  });
  if (!created) throw new Error("no WebGL2 context for the canvas stage");
  // A non-null binding, because `executeNow` closes over it: the narrowing above
  // does not reach a closure that was created before the case called it.
  const stage: CanvasStage = created;
  stage.setStageSize(STAGE_SIZE, STAGE_SIZE);

  const gl = stage.gl;
  const effects = createHeadlessEffectsStage(gl);
  const textures: CanvasTextureCache = createTextureCache(gl);
  const executor: CanvasExecutor = createCanvasExecutor({
    gl,
    white: textures.white(),
  });
  function runExecutor(): void {
    if (!executor.execute(context.list, stage.projection())) {
      throw new Error("the canvas executor could not build its program");
    }
  }

  const context: CaseContext = {
    effects,
    list: createDrawList<ExecutorTexture | null>(),
    textures,
    executeNow: runExecutor,
    white: textures.white(),
    patch: textures.acquireBytes("blocks", blockPage(), 9, 9, {
      premultiplied: true,
    }),
    // STRAIGHT bytes: the cache premultiplies them, so what lands on the GPU is
    // (128, 0, 0, 128) — and the fragment has to undo that before the matrix.
    halfRed: textures.acquireBytes(
      "half-red",
      new Uint8Array([255, 0, 0, 128]),
      1,
      1,
    ),
  };

  const points = build(context);
  runExecutor();

  const buffer = new Uint8Array(STAGE_SIZE * STAGE_SIZE * 4);
  gl.readPixels(
    0,
    0,
    STAGE_SIZE,
    STAGE_SIZE,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    buffer,
  );
  const samples: Record<string, [number, number, number, number]> = {};
  for (const [label, [x, y]] of Object.entries(points)) {
    // readPixels is bottom-up; every coordinate above is top-down design space.
    const row = STAGE_SIZE - 1 - y;
    const at = (row * STAGE_SIZE + x) * 4;
    samples[label] = [
      buffer[at],
      buffer[at + 1],
      buffer[at + 2],
      buffer[at + 3],
    ];
  }

  const result: PixelCaseResult = {
    samples,
    draws: executor.stats.batches,
    quads: executor.stats.quads,
    textureUploads: textures.stats.uploads,
    textureRespecs: textures.stats.respecs,
    renderer: rendererString(gl),
  };
  executor.dispose();
  effects.dispose();
  textures.dispose();
  stage.dispose();
  return result;
}

declare global {
  interface Window {
    __gswCanvasPixel: {
      run(name: string): PixelCaseResult;
      cases(): string[];
    };
  }
}

window.__gswCanvasPixel = { run: runPixelCase, cases: listPixelCases };
