// Pure synthesis of the gate 2 fixture's expected per-step frame, straight from
// fixtures/gate2/expected.json (render-stream-gate2-expected/1) -- no file or network I/O, no
// Godot, no capture evidence. See ../../protocol/gate2-design.md "Q6. Fixture" for the schema and
// the checks (`expected-image-reference`, later `expected-image-receiver`) that compare real
// screenshots with this synthesized image.
//
// A draw either paints a flat colour or samples a texture content. Sampling follows the GLES3
// canvas vertex shader (drivers/gles3/shaders/canvas.glsl:225-227): for the destination fraction
// f of a pixel centre, b = (flip_h ? 1 - f.x : f.x, flip_v ? 1 - f.y : f.y) and
// uv = src.xy + src.zw * (transpose ? b.yx : b.xy), in texels. The texel is floor(uv), nearest,
// wrapped by the draw's repeat: disabled clamps to the edge, enabled (and tile, which forces it)
// is modulo, mirror reflects. Every expected sample point lies strictly inside a texel, so floor
// is exact. Alpha 255 replaces, alpha 0 leaves the destination, anything else blends
// (rounded); regions with partial alpha or linear filtering are listed in `synth_exclude` and
// compared receiver <-> reference only.

export type Rect4 = [number, number, number, number];
export type Rgba8 = [number, number, number, number];

export type Gate2Repeat = "disabled" | "enabled" | "mirror";

export interface Gate2Sample {
  /** a key of `textures` (a content, not a texture object) */
  texture: string;
  /** source rect in texels */
  src_px: Rect4;
  flip_h: boolean;
  flip_v: boolean;
  transpose: boolean;
  tile: boolean;
  repeat: Gate2Repeat;
  modulate: Rgba8;
}

/** One draw in paint order, in root-canvas pixels (every transform applied). */
export interface Gate2Draw {
  name: string;
  rect_px: Rect4;
  sample?: Gate2Sample;
  rgba8?: Rgba8;
}

/** A texture content as data: a fill with rect overrides, a one-texel checker (`even` where
 * x + y is even), or one fill per frame (`frame_fill[frame % length]`). Texels are as sampled:
 * an LA8 texel (L, A) is (L, L, L, A). */
export interface Gate2TextureContent {
  format: string;
  width: number;
  height: number;
  mipmaps: boolean;
  fill?: Rgba8;
  /** [x, y, w, h, r, g, b, a] in texels, applied in order over `fill` */
  rects?: number[][];
  checker?: { even: Rgba8; odd: Rgba8 };
  frame_fill?: Rgba8[];
  engine_defined?: boolean;
}

export interface Gate2TextureObject {
  kind: "image" | "placeholder" | "canvas";
  created_step: number | null;
  thread: "main" | "other";
  /** [from step, content] */
  contents: [number, string][];
  freed_step?: number;
  replaced_into?: string;
  status?: string;
  reason?: string;
  unknown?: boolean;
}

/** Texture assertions on a step's settle transaction, evaluated from render-stream/2 on (G2b2);
 * G2a only checks that they name known textures and items. */
export type Gate2Invariant =
  | { kind: "tex_shared_hash"; textures: string[]; with_log?: Gate2LogRef }
  | { kind: "tex_kind"; texture: string; value: string }
  | { kind: "tex_same_id"; textures: string[]; step: number }
  | { kind: "tex_version_bumped"; textures: string[]; step: number }
  | { kind: "tex_hash_equals"; texture: string; log: Gate2LogRef }
  | { kind: "tex_absent"; textures: string[] }
  | { kind: "tex_freed"; texture: string }
  | { kind: "tex_new_ids"; textures: string[]; step: number }
  | { kind: "no_texture_entries"; step: number }
  | { kind: "filter"; item: string; value: string }
  | { kind: "repeat"; item: string; value: string }
  | { kind: "default_filter"; value: string };

/** A line of the fixture's own texture log (RS_FIXTURE_TEXTURE_LOG). */
export interface Gate2LogRef {
  op: string;
  name: string;
  step: number;
}

export interface Gate2ExpectedStep {
  step: number;
  marker_rgba8: Rgba8;
  /** the root canvas transform: x.x, x.y, y.x, y.y, origin.x, origin.y */
  canvas_transform: number[];
  /** this step's named regions (they follow G and the canvas transform) */
  regions: Record<string, Rect4>;
  draws: Gate2Draw[];
  /** regions compared receiver <-> reference only, never with the synthesis */
  synth_exclude: string[];
  /** the RenderingServer texture calls the step causes: `<op>` on the main thread,
   * `<op>@other` on any other thread, counted over the step's frame window */
  census: Record<string, number>;
  invariants: Gate2Invariant[];
  /** G2b2: a fresh-cache file-mode receiver's texture traffic summed over the step's window
   * (fixtures/gate2/make_expected.py receiver_resources, derived from gate2-design.md D5) */
  receiver_resources: Gate2ReceiverResources;
}

export interface Gate2ReceiverResources {
  fetched: number;
  created: number;
  updated: number;
  replaced: number;
  freed: number;
}

export interface Gate2VariantStep {
  step: number;
  draws: Gate2Draw[];
  regions: Record<string, Rect4>;
  /** added to the step's census; null = a per-frame count the checker derives from the window */
  census_extra: Record<string, number | null>;
}

export interface Gate2Expected {
  schema: "render-stream-gate2-expected/1";
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  /** nothing is drawn here */
  empty_region: Rect4;
  root_texture_defaults: { filter: string; repeat: string };
  permitted_formats: string[];
  items_at_ready: string[];
  /** RenderingServer texture calls the engine makes on its own inside a step's window (the
   * default theme's ColorPicker hue strip, created in frame 1), counted in the census */
  engine_textures: {
    name: string;
    step: number;
    op: string;
    thread: "main" | "other";
    format: string;
    width: number;
    height: number;
    mipmaps: boolean;
    source: string;
  }[];
  textures: Record<string, Gate2TextureContent>;
  texture_objects: Record<string, Gate2TextureObject>;
  steps: Gate2ExpectedStep[];
  variants: Record<
    "animate" | "unsupported",
    {
      textures: Record<string, Gate2TextureObject>;
      steps: Gate2VariantStep[];
    }
  >;
}

export interface SynthesizedFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Step k's applied frame (step 0 is the `_ready` state, frame 1) and settle frame. */
export function stepFrames2(
  expected: Gate2Expected,
  step: number,
  start = expected.start_frame_default,
  span = expected.step_frames_default,
): { applied: number; settle: number } {
  return {
    applied: step === 0 ? 1 : start + span * step,
    settle: start + span * step + expected.settle_offset,
  };
}

/** The step whose frame window holds `frame`: [applied_k, applied_{k+1}), the last step's
 * window running through `quit`; -1 outside every window. */
export function stepOfFrame(
  expected: Gate2Expected,
  frame: number,
  quit: number,
  start = expected.start_frame_default,
  span = expected.step_frames_default,
): number {
  if (frame < 1 || frame > quit) return -1;
  for (let k = expected.last_step; k >= 0; k--) {
    if (frame >= stepFrames2(expected, k, start, span).applied) return k;
  }
  return -1;
}

/** The texel of a content at integer (x, y), as sampled RGBA8; `frame` picks a frame_fill. */
export function texel(
  content: Gate2TextureContent,
  x: number,
  y: number,
  frame?: number,
): Rgba8 {
  if (content.checker) {
    return (x + y) % 2 === 0 ? content.checker.even : content.checker.odd;
  }
  if (content.frame_fill) {
    if (frame === undefined) {
      throw new Error("gate2-expected: a frame_fill texture needs a frame");
    }
    return content.frame_fill[frame % content.frame_fill.length];
  }
  let color: Rgba8 = content.fill ?? [0, 0, 0, 0];
  for (const r of content.rects ?? []) {
    if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) {
      color = [r[4], r[5], r[6], r[7]];
    }
  }
  return color;
}

function wrap(t: number, size: number, repeat: Gate2Repeat): number {
  if (repeat === "enabled") return ((t % size) + size) % size;
  if (repeat === "mirror") {
    const period = 2 * size;
    const m = ((t % period) + period) % period;
    return m < size ? m : period - 1 - m;
  }
  return Math.min(size - 1, Math.max(0, t));
}

/** The sampled colour of a texture draw at a pixel centre (px + .5, py + .5). */
export function sampleAt(
  expected: Gate2Expected,
  draw: Gate2Draw & { sample: Gate2Sample },
  px: number,
  py: number,
  frame?: number,
): Rgba8 {
  const s = draw.sample;
  const content = expected.textures[s.texture];
  if (!content) {
    throw new Error(`gate2-expected: unknown texture content ${s.texture}`);
  }
  const [x, y, w, h] = draw.rect_px;
  const fx = (px + 0.5 - x) / w;
  const fy = (py + 0.5 - y) / h;
  const bx = s.flip_h ? 1 - fx : fx;
  const by = s.flip_v ? 1 - fy : fy;
  const [sx, sy, sw, sh] = s.src_px;
  const u = sx + sw * (s.transpose ? by : bx);
  const v = sy + sh * (s.transpose ? bx : by);
  const repeat: Gate2Repeat = s.tile ? "enabled" : s.repeat;
  const tu = wrap(Math.floor(u), content.width, repeat);
  const tv = wrap(Math.floor(v), content.height, repeat);
  const t = texel(content, tu, tv, frame);
  const m = s.modulate;
  return [
    Math.round((t[0] * m[0]) / 255),
    Math.round((t[1] * m[1]) / 255),
    Math.round((t[2] * m[2]) / 255),
    Math.round((t[3] * m[3]) / 255),
  ];
}

export interface SynthesizeOptions {
  /** add this variant's draws */
  variant?: "animate" | "unsupported";
  /** the frame the shot shows (needed for frame_fill contents) */
  frame?: number;
}

/** The step's draws, the variant's appended (they paint over nothing the main draws cover). */
export function gate2Draws(
  expected: Gate2Expected,
  step: number,
  options: SynthesizeOptions = {},
): Gate2Draw[] {
  const found = expected.steps.find((entry) => entry.step === step);
  if (!found)
    throw new Error(`gate2-expected: no step ${step} in expected.json`);
  const extra = options.variant
    ? (expected.variants[options.variant].steps.find((s) => s.step === step)
        ?.draws ?? [])
    : [];
  return [...found.draws, ...extra];
}

/**
 * The expected 640x360 RGBA frame for one step: the clear colour, then every draw in paint
 * order, each clipped to the viewport.
 */
export function synthesizeGate2(
  expected: Gate2Expected,
  step: number,
  options: SynthesizeOptions = {},
): SynthesizedFrame {
  const [width, height] = expected.viewport;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    rgba.set(expected.clear_rgba8, i * 4);
  for (const draw of gate2Draws(expected, step, options)) {
    const [x, y, w, h] = draw.rect_px;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const src = draw.sample
          ? sampleAt(
              expected,
              draw as Gate2Draw & { sample: Gate2Sample },
              px,
              py,
              options.frame,
            )
          : (draw.rgba8 as Rgba8);
        const i = (py * width + px) * 4;
        const a = src[3];
        if (a === 255) {
          rgba.set(src, i);
        } else if (a > 0) {
          for (let c = 0; c < 3; c++) {
            rgba[i + c] = Math.round(
              (src[c] * a + rgba[i + c] * (255 - a)) / 255,
            );
          }
          rgba[i + 3] = Math.round(a + (rgba[i + 3] * (255 - a)) / 255);
        }
      }
    }
  }
  return { width, height, rgba };
}

/** The step's regions, the variant's added. */
export function gate2Regions(
  expected: Gate2Expected,
  step: number,
  variant?: "animate" | "unsupported",
): Record<string, Rect4> {
  const found = expected.steps.find((entry) => entry.step === step);
  if (!found)
    throw new Error(`gate2-expected: no step ${step} in expected.json`);
  const extra = variant
    ? (expected.variants[variant].steps.find((s) => s.step === step)?.regions ??
      {})
    : {};
  return { ...found.regions, ...extra };
}
