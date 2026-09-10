import type { ColorMatrix } from "@godot-scene-web/core";
import type { DamageRect } from "./damage";

/**
 * The draw-list IR for a Godot 2D scene: a flat, ordered recording of what one
 * frame paints, produced by walking `CanvasItem`s in draw order and consumed by
 * a GPU executor (a later wave). It is deliberately dumb — no scene concepts, no
 * nodes, no styles, just quads, indexed textured meshes, nine-patches,
 * polylines and clip pushes/pops in
 * the order they must hit the framebuffer.
 *
 * Storage is a set of pooled parallel typed arrays, not an array of command
 * objects:
 *
 * - `kinds` / `floatOffsets` / `intOffsets` are one entry per command,
 * - `floats` and `ints` are arenas that every command's numeric payload is
 *   appended into (a quad writes 16 floats + 3 ints, a polyline writes a
 *   5-float header plus 2 floats per point, …),
 * - `colorMatrices` is a side arena for the rare 3x3 color transform,
 * - `textures` is the ONLY object side-array — a texture handle cannot live in
 *   a typed array.
 *
 * That layout exists so a frame costs zero garbage: `reset()` rewinds the write
 * cursors and the same buffers are refilled next frame, and reading a command
 * back fills a caller-owned view instead of allocating one. Arrays grow on
 * demand (capacity doubling) and never shrink.
 *
 * All geometry is in DESIGN space (the scene's own coordinate system); mapping
 * design space to device pixels is the executor's job.
 */

/** A textured/solid rectangle: the workhorse command. */
export const DRAW_QUAD = 0;
/** A 9-sliced rectangle; the executor expands it to up to 9 quads. */
export const DRAW_NINE_PATCH = 1;
/** A flattened, constant-width line strip. */
export const DRAW_POLYLINE = 2;
/** Push a scissor/clip rect; every later command is clipped until the pop. */
export const DRAW_CLIP_PUSH = 3;
/** Pop the most recent clip rect. */
export const DRAW_CLIP_POP = 4;
/**
 * A run of glyphs from one face, at one size, in one colour.
 *
 * The ONLY command that is not reducible to a textured quad, which is why it
 * exists as its own kind rather than as sugar over `pushQuad`. Its glyphs are
 * outlines evaluated per fragment (see `@godot-scene-web/hb-gpu`), so they carry
 * an atlas slot id instead of a source rect and stay crisp under rotation and
 * scale — the whole reason for the kind. An executor with no glyph pass
 * installed skips it.
 */
export const DRAW_GLYPHS = 5;
/** An arbitrary triangle list with one texture and per-mesh premultiplied tint. */
export const DRAW_TEXTURED_MESH = 6;
/** A screen-dependent pass executed at this exact painter position. */
export const DRAW_SCREEN_EFFECT = 7;
/** A caller-owned GPU pass executed directly into the current framebuffer. */
export const DRAW_EXTERNAL_EFFECT = 8;

export interface ScreenEffectDrawContext {
  readonly gl: WebGL2RenderingContext;
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  readonly damage?: DamageRect;
  readonly scissor: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/**
 * The live painter target handed to an external pass. Unlike a screen effect,
 * this pass does not imply a snapshot or read from the accumulated framebuffer.
 */
export interface ExternalEffectDrawContext {
  readonly gl: WebGL2RenderingContext;
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  readonly damage?: DamageRect;
  readonly scissor: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/** A DOM-free pass that snapshots the executor's accumulated current target. */
export interface ScreenEffectDrawCommand {
  readonly screenDependent: true;
  execute(context: ScreenEffectDrawContext): boolean;
}

/** A DOM-free pass that paints directly into the executor's current target. */
export interface ExternalEffectDrawCommand {
  execute(context: ExternalEffectDrawContext): boolean;
}

export type DrawCommandKind =
  | typeof DRAW_QUAD
  | typeof DRAW_NINE_PATCH
  | typeof DRAW_POLYLINE
  | typeof DRAW_CLIP_PUSH
  | typeof DRAW_CLIP_POP
  | typeof DRAW_GLYPHS
  | typeof DRAW_TEXTURED_MESH
  | typeof DRAW_SCREEN_EFFECT
  | typeof DRAW_EXTERNAL_EFFECT;

export type DrawCommandName =
  | "quad"
  | "ninePatch"
  | "polyline"
  | "clipPush"
  | "clipPop"
  | "glyphs"
  | "texturedMesh"
  | "screenEffect"
  | "externalEffect";

/** Indexed by {@link DrawCommandKind}; for debugging and test assertions. */
export const DRAW_COMMAND_NAMES: readonly DrawCommandName[] = [
  "quad",
  "ninePatch",
  "polyline",
  "clipPush",
  "clipPop",
  "glyphs",
  "texturedMesh",
  "screenEffect",
  "externalEffect",
];

/** Godot `CanvasItemMaterial.BLEND_MODE_MIX`: normal alpha compositing. */
export const BLEND_MIX = 0;
/** Godot `BLEND_MODE_ADD`. */
export const BLEND_ADD = 1;
/** Godot `BLEND_MODE_SUB`. */
export const BLEND_SUB = 2;
/** Godot `BLEND_MODE_MUL`. */
export const BLEND_MUL = 3;

export type BlendMode =
  | typeof BLEND_MIX
  | typeof BLEND_ADD
  | typeof BLEND_SUB
  | typeof BLEND_MUL;

/** Bit in a command's packed flags int: mirror the source rect horizontally. */
export const FLIP_H = 1;
/** Bit in a command's packed flags int: mirror the source rect vertically. */
export const FLIP_V = 2;

/**
 * A quad's numeric payload. Views are caller-owned and reusable: fill one and
 * hand it to `pushQuad`, or pass one to `readQuad` to have it filled in place.
 * Nothing here is retained by the list — the push copies into the arenas.
 */
export interface QuadView {
  /**
   * The 2x3 affine that maps the unit-ish quad into design space, in Godot
   * `Transform2D` order: `[xx, xy, yx, yy, originX, originY]`, i.e.
   * `x' = xx*x + yx*y + originX`, `y' = xy*x + yy*y + originY`. Length 6.
   */
  m: Float32Array;
  /** Destination width in design units, before `m` is applied. */
  w: number;
  /** Destination height in design units, before `m` is applied. */
  h: number;
  /** Source rect on the texture page, in page pixels (not normalized). */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** PREMULTIPLIED tint, linear 0..1 per channel (`rgb` already times `a`). */
  r: number;
  g: number;
  b: number;
  a: number;
  blend: BlendMode;
  flipH: boolean;
  flipV: boolean;
  /**
   * Whether {@link QuadView.colorMatrix} is meaningful. Most quads carry no
   * color transform at all (the field is the IR's "null"), so the matrix is
   * stored in a side arena and skipped entirely when this is `false`.
   */
  hasColorMatrix: boolean;
  /**
   * Row-major 3x3 linear RGB transform (`out_rgb = m * in_rgb`, alpha
   * untouched) — an HSV-style shader tint. Length 9. Ignored unless
   * `hasColorMatrix`.
   */
  colorMatrix: Float32Array;
}

/**
 * A nine-patch's payload: a quad plus the four stretch margins. `srcX..srcH` is
 * the patch REGION on the page; the margins are insets into that region, in
 * page pixels, exactly like Godot's `NinePatchRect.patch_margin_*`.
 */
export interface NinePatchView extends QuadView {
  marginLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
}

/** A polyline's payload: a flattened `x, y, x, y, …` strip with one width. */
export interface PolylineView {
  /**
   * Flattened point coordinates in design space. Length is at least
   * `pointCount * 2`; a longer buffer is allowed (and expected, since views are
   * reused), only the first `pointCount * 2` entries are read.
   */
  points: Float32Array;
  pointCount: number;
  /** Stroke width in design units. */
  width: number;
  /** PREMULTIPLIED stroke color, linear 0..1 per channel. */
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * An indexed triangle list sampling one texture. Positions and UVs are paired
 * by vertex index; positions are local design-space coordinates and `m` maps
 * them to design space. UVs are normalized texture coordinates, intentionally
 * not a quad source rect: arbitrary mesh topology must not be forced through a
 * rectangle-shaped source contract.
 */
export interface TexturedMeshView {
  /** Godot `Transform2D` mapping local vertex positions into design space. */
  m: Float32Array;
  /** Flattened local `x, y` pairs. Only `vertexCount * 2` entries are read. */
  positions: Float32Array;
  /** Flattened normalized `u, v` pairs, one pair for every position. */
  uvs: Float32Array;
  vertexCount: number;
  /** Triangle-list vertex indices. Only `indexCount` entries are read. */
  indices: Uint32Array;
  indexCount: number;
  /** PREMULTIPLIED mesh tint, linear 0..1 per channel. */
  r: number;
  g: number;
  b: number;
  a: number;
  blend: BlendMode;
}

/**
 * A glyph run's payload: one face, one size, one colour, N positioned glyphs.
 *
 * THE SLOT IDS ARE HANDLES, NOT ADDRESSES, and that distinction is the whole
 * point of the indirection. A glyph atlas evicts — it is a fixed texture holding
 * an unbounded pool — so recording a glyph's atlas OFFSET into a list that may be
 * retained and repainted next frame is how you get a different glyph's outline
 * drawn at the right size, in the right place, perfectly antialiased. Unreadable
 * text that looks like working text. A slot id survives eviction because the
 * atlas re-resolves it (re-uploading the outline if it has to) at draw time.
 *
 * Shaping is NOT this package's job. `positions` are pen positions a shaper
 * produced; the list only records them.
 */
export interface GlyphsView {
  /**
   * The 2x3 affine that maps the run's local space into design space, in the
   * same Godot `Transform2D` order as {@link QuadView.m}. Length 6.
   *
   * ROTATION BELONGS HERE, NEVER IN `positions`. The glyph shader dilates each
   * outline by half a SCREEN pixel and works out how far that is by pushing the
   * quad's corner and its normal through this same matrix. Pen positions rotated
   * on the CPU would be dilated along the wrong axes — a rim of clipped
   * antialiasing on one side of every glyph.
   */
  m: Float32Array;
  /**
   * Design units per em: the font size in the run's local space.
   *
   * The rendered outline is resolution-independent, but its ANTIALIASING is not
   * unconditionally so: HarfBuzz's coverage shader takes a five-tap branch below
   * ppem 16, and measured against an 8x-downsampled reference that branch is
   * blurrier than a baked atlas at the same size. The ppem that matters is this
   * times the scale in {@link GlyphsView.m} times the device-pixel ratio: a
   * caller's zoom rides the matrix, and the shader sees it — see
   * `docs/text-rendering.md`.
   */
  pixelsPerEm: number;
  /** PREMULTIPLIED colour, linear 0..1 per channel, for the whole run. */
  r: number;
  g: number;
  b: number;
  a: number;
  /**
   * One atlas slot id per glyph. Length is at least {@link GlyphsView.glyphCount}
   * — a longer buffer is allowed and expected, since views are reused.
   */
  slots: Int32Array;
  /**
   * Pen positions, flattened `x, y, x, y, …`, in the run's local space and
   * BEFORE `m` is applied. Each is the glyph's em origin, i.e. a point on the
   * baseline. Length is at least `glyphCount * 2`.
   */
  positions: Float32Array;
  glyphCount: number;
  /**
   * Grow every glyph outward by this many design units before filling. `0` (the
   * default) is a plain fill.
   *
   * AN OUTLINED LABEL IS TWO RUNS, NOT ONE: the same glyphs and pens in the
   * outline colour with a spread, then again in the fill colour with none. This
   * kind carries one colour and one spread by design — merging them would need
   * two draw calls behind one command and would hide the ordering, which is the
   * part a caller has to get right (outline UNDER fill).
   *
   * A CENTRED `strokeText` OF WIDTH `W` REACHES `W / 2` OUTWARD, so a caller
   * matching one records `W / 2`. The arithmetic is the caller's: only it knows
   * whether the stroke it is reproducing is centred, inner or outer.
   *
   * THE DILATION FILLS THE INTERIOR AND A STROKE DOES NOT. Identical under an
   * opaque fill, which covers every pixel the two disagree about; visibly
   * different under a TRANSLUCENT one, where the outline colour shows through
   * the glyph's middle. Stated because it is a real limit of a coverage-max
   * dilation rather than a rounding difference — see `HbGpuRenderer.setSpread`.
   */
  spreadPx: number;
  /**
   * The exact local-space rectangle containing the run's unspread glyph ink.
   *
   * These are optional for source compatibility with older producers. Omitting
   * any one is deliberately an UNKNOWN bound, never an em-box estimate: a
   * retained surface must repaint fully rather than leave stale text behind.
   */
  localInkX?: number;
  localInkY?: number;
  localInkWidth?: number;
  localInkHeight?: number;
  /** Additional local-space reach for effects and antialiasing. The draw list
   * also adds its own `spreadPx`, so this is for reach beyond the unspread
   * outline (for example a shadow or caller-measured coverage fringe). */
  localInkOutset?: number;
}

/** A clip push's payload. */
export interface ClipRectView {
  /** Clip rect in design space. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Corner radius in design units; `0` (the common case) is a plain rect and
   * lets the executor use a cheap scissor instead of a mask.
   */
  cornerRadius: number;
  /**
   * One-axis slack: widen the rect by `outsetX` on BOTH x edges, i.e. clip to
   * `[x - outsetX, x + w + outsetX]` while `y`/`h` stay exact. `0` (the common
   * case) clips to the rect itself. This exists because a re-laid-out scene can
   * legitimately paint slightly wider than the clip that Godot recorded, and
   * only ever on x.
   */
  outsetX: number;
}

export interface DrawListOptions {
  /** Initial command capacity (entries, not bytes). Grows on demand. */
  commandCapacity?: number;
  /** Initial float-arena capacity. Grows on demand. */
  floatCapacity?: number;
  /** Initial int-arena capacity. Grows on demand. */
  intCapacity?: number;
  /** Initial color-matrix capacity, in matrices. Grows on demand. */
  colorMatrixCapacity?: number;
  /** Retained in-place patch records for compiled consumers. */
  patchJournalCapacity?: number;
}

/** Caller-owned, grow-only output for {@link DrawList.readPatchesSince}. */
export interface DrawListPatchView {
  readonly indices: readonly number[];
  readonly revision: number;
  readonly overflowed: boolean;
}

/**
 * A reusable, DOM- and GPU-ownership-free copy of a contiguous draw-list
 * range. A fragment owns its arena bytes and command references, so it remains
 * valid when the list it was captured from is reset, grows, or patched.
 *
 * Fragments deliberately retain texture and effect *references* rather than
 * attempting to clone them: those handles are executor-owned identities, not
 * draw-list data. Capturing and appending only copies the ordering and payload
 * that names them.
 */
export interface DrawListFragment<TTexture = unknown> {
  /** Number of commands in the captured half-open source range. */
  readonly count: number;
  /** Always zero for a valid standalone fragment. */
  readonly clipDepth: number;
  /** Deepest clip nesting within the captured range. */
  readonly maxClipDepth: number;
  /** Forget the captured range but retain all backing storage for reuse. */
  reset(): void;
  /**
   * Clone `[start, end)` from `source` into this fragment. The range must be
   * independently clip-balanced; an unmatched pop or push is rejected rather
   * than producing a fragment whose replay depends on hidden painter state.
   */
  capture(source: DrawList<TTexture>, start: number, end?: number): void;
}

/** One same-shaped retained-fragment replacement in a draw list. */
export interface DrawListFragmentPatch<TTexture = unknown> {
  /** First destination command index. Patches are supplied in painter order. */
  readonly start: number;
  /** Replacement command payloads, captured through createDrawListFragment. */
  readonly fragment: DrawListFragment<TTexture>;
}

export function createDrawListPatchView(capacity = 16): DrawListPatchView {
  const indices: number[] = [];
  let marks = new Int32Array(Math.max(1, capacity));
  let generation = 0;
  let revision = 0;
  let overflowed = false;
  const view: DrawListPatchView = {
    get indices() {
      return indices;
    },
    get revision() {
      return revision;
    },
    get overflowed() {
      return overflowed;
    },
  };
  Object.assign(view as object, {
    begin(nextRevision: number) {
      indices.length = 0;
      generation += 1;
      if (generation === 0x7fffffff) {
        marks.fill(0);
        generation = 1;
      }
      revision = nextRevision;
      overflowed = false;
    },
    overflow() {
      overflowed = true;
    },
    add(index: number) {
      if (index >= marks.length) {
        let length = marks.length;
        while (length <= index) length *= 2;
        const next = new Int32Array(length);
        next.set(marks);
        marks = next;
      }
      if (marks[index] === generation) return;
      marks[index] = generation;
      indices.push(index);
    },
  });
  return view;
}

interface MutableDrawListPatchView extends DrawListPatchView {
  begin(revision: number): void;
  overflow(): void;
  add(index: number): void;
}

/**
 * An ordered, poolable recording of one frame's draws.
 *
 * `TTexture` is whatever the executor's texture handle is (a `WebGLTexture`, a
 * `GPUTexture`, an atlas page id, …); the list only stores and returns it.
 */
export interface DrawList<TTexture = unknown> {
  /** Number of commands recorded since the last `reset()`. */
  readonly count: number;
  /** Clip pushes that are currently open (0 at a balanced end of frame). */
  readonly clipDepth: number;
  /** Deepest clip nesting seen since `reset()` — sizes an executor's stack. */
  readonly maxClipDepth: number;
  /** Changes when commands are appended, removed, or their layout changes. */
  readonly structuralRevision: number;
  /** Changes for every structural or in-place command patch. */
  readonly contentRevision: number;
  /** Per-command patch generation, for retained compiled consumers. */
  commandRevisionAt(index: number): number;
  /** Fill reusable `out` with patches after `revision`; overflow means rebuild. */
  readPatchesSince(revision: number, out: DrawListPatchView): DrawListPatchView;
  /**
   * The float arena. The identity of this array CHANGES when it grows, so an
   * executor must re-read it (never cache it across pushes).
   */
  readonly floats: Float32Array;
  /** The int arena. Same growth caveat as {@link DrawList.floats}. */
  readonly ints: Int32Array;
  /** The color-matrix arena, 9 floats per entry. Same growth caveat. */
  readonly colorMatrices: Float32Array;

  /** Rewind to an empty list, keeping (and reusing) the buffers. */
  reset(): void;

  /**
   * Append a previously captured fragment in painter order and return the
   * first destination command index. Empty fragments return `count` and do
   * not change revisions.
   */
  appendFragment(fragment: DrawListFragment<TTexture>): number;

  /**
   * Atomically overwrite a same-shaped recorded range from a retained
   * fragment. The fragment must fit at `start` and every command must retain
   * its kind, numeric payload lengths, object-side payload shape, clip
   * sequence, and colour-matrix presence. A mismatch leaves this list wholly
   * unchanged and returns `false`; successful overwrites preserve command
   * indices and structural revision while publishing ordinary content patches.
   *
   * An empty fragment is a successful no-op at any insertion index from `0`
   * through `count`.
   */
  patchFragment(start: number, fragment: DrawListFragment<TTexture>): boolean;

  /**
   * Atomically apply non-overlapping same-shaped fragments in painter order.
   * Every range is validated before any payload, reference, revision, or patch
   * journal entry changes. Starts must be nondecreasing and non-empty ranges
   * must not overlap.
   */
  patchFragments(patches: readonly DrawListFragmentPatch<TTexture>[]): boolean;

  kindAt(index: number): DrawCommandKind;
  kindNameAt(index: number): DrawCommandName;
  /** The command's texture handle, or `null` for untextured/geometry commands. */
  textureAt(index: number): TTexture | null;
  /** Screen-dependent pass recorded at index, if this is one. */
  screenEffectAt(index: number): ScreenEffectDrawCommand | null;
  /** Direct framebuffer pass recorded at index, if this is one. */
  externalEffectAt(index: number): ExternalEffectDrawCommand | null;
  /** Start of the command's payload in {@link DrawList.floats}. */
  floatOffsetAt(index: number): number;
  /** Start of the command's payload in {@link DrawList.ints}. */
  intOffsetAt(index: number): number;
  /**
   * Index of the command's color matrix in {@link DrawList.colorMatrices}
   * (multiply by 9 for the float offset), or `-1` when it has none.
   */
  colorMatrixIndexAt(index: number): number;

  /** Record a quad. Returns the command index. */
  pushQuad(quad: QuadView, texture?: TTexture | null): number;
  /** Record a nine-patch. Returns the command index. */
  pushNinePatch(patch: NinePatchView, texture?: TTexture | null): number;
  /** Record a polyline. Returns the command index. */
  pushPolyline(line: PolylineView): number;
  /** Record an indexed textured triangle mesh. Returns the command index. */
  pushTexturedMesh(mesh: TexturedMeshView, texture?: TTexture | null): number;
  /** Record a glyph run. Returns the command index. */
  pushGlyphs(run: GlyphsView): number;
  /** Record a pass that samples the accumulated framebuffer at this painter index. */
  pushScreenEffect(command: ScreenEffectDrawCommand): number;
  /** Record a direct framebuffer pass at this painter position. */
  pushExternalEffect(command: ExternalEffectDrawCommand): number;
  /** Open a clip rect. Returns the command index. */
  pushClipRect(clip: ClipRectView): number;
  /** Close the innermost clip rect. Returns the command index. */
  popClip(): number;

  /** Fill `out` from a `quad` command and return it. */
  readQuad(index: number, out: QuadView): QuadView;
  /** Fill `out` from a `ninePatch` command and return it. */
  readNinePatch(index: number, out: NinePatchView): NinePatchView;
  /**
   * Fill `out` from a `polyline` command and return it. `out.points` is
   * REPLACED by a larger buffer if it cannot hold the recorded points.
   */
  readPolyline(index: number, out: PolylineView): PolylineView;
  /** Fill `out` from a textured mesh, growing its caller-owned arrays if needed. */
  readTexturedMesh(index: number, out: TexturedMeshView): TexturedMeshView;
  /**
   * Fill `out` from a `glyphs` command and return it. `out.slots` and
   * `out.positions` are REPLACED by larger buffers if they cannot hold the run.
   */
  readGlyphs(index: number, out: GlyphsView): GlyphsView;
  /** Fill `out` from a `clipPush` command and return it. */
  readClipRect(index: number, out: ClipRectView): ClipRectView;

  /**
   * Overwrite a recorded quad's transform IN PLACE, leaving the rest of its
   * payload — size, source rect, colour, blend, flip flags, colour matrix —
   * exactly as it was pushed.
   *
   * This exists for consumers that rebuild a whole frame today only because one
   * node moved: they can keep last frame's list and repaint it, which is the
   * point of a list that owns its storage. `m` is read in the same
   * `Transform2D` order as {@link QuadView.m} and only its first 6 entries are
   * used.
   *
   * PATCH THROUGH THIS METHOD, NEVER THROUGH A CACHED `floats`. The arenas are
   * reallocated when they grow (see {@link DrawList.floats}), so a Float32Array
   * captured before a `push` may be a DEAD copy — writing into it changes
   * nothing that will be drawn, silently. The method re-reads the live arena on
   * every call.
   *
   * Accepts `quad` and `ninePatch` commands (a nine-patch's payload IS a quad
   * payload plus margins); anything else throws.
   */
  patchQuadTransform(index: number, m: ArrayLike<number>): void;
  /**
   * Overwrite a recorded quad's PREMULTIPLIED tint in place, leaving geometry,
   * source rect, blend, flip flags and colour matrix alone.
   *
   * `rgb` must already be multiplied by `a`, exactly as {@link QuadView} states
   * — this is a raw write into the arena, not a colour operation, so nothing
   * here will premultiply on the caller's behalf.
   *
   * The same cached-arena hazard as {@link DrawList.patchQuadTransform}
   * applies, and the same two kinds are accepted.
   */
  patchQuadColor(
    index: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void;

  /**
   * Replace a quad-like command's texture and source rectangle without touching
   * its destination geometry, tint, blend state, flags or colour matrix.
   *
   * Like the other patch methods this re-reads the current arenas. In
   * particular, callers must not write source coordinates through a cached
   * `floats` view: a later push may have grown that arena and made the cached
   * view a detached copy.
   */
  patchQuadSource(
    index: number,
    texture: TTexture | null,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
  ): void;

  /** Replace the local positions of a mesh without changing its topology. */
  patchTexturedMeshPositions(index: number, positions: Float32Array): void;
  /** Replace the normalized UV pairs of a mesh without changing its topology. */
  patchTexturedMeshUvs(index: number, uvs: Float32Array): void;
  /** Replace a mesh's texture handle without changing geometry or UVs. */
  patchTexturedMeshSource(index: number, texture: TTexture | null): void;
  /** Replace a mesh's local-to-design transform. */
  patchTexturedMeshTransform(index: number, m: ArrayLike<number>): void;
  /** Replace a mesh's premultiplied tint. */
  patchTexturedMeshColor(
    index: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void;

  /**
   * Overwrite a recorded glyph run's transform in place, leaving its glyphs,
   * size and colour alone.
   *
   * The counterpart of {@link DrawList.patchQuadTransform}, and the reason the
   * glyph kind stores a transform at all instead of pre-transformed pen
   * positions: a label that translates every frame re-records nothing, and the
   * shader still sees the whole transform (which is what keeps its half-pixel
   * dilation on the right axes). The same cached-arena hazard applies — patch
   * through this method, never through a captured `floats`.
   */
  patchGlyphsTransform(index: number, m: ArrayLike<number>): void;
  /**
   * Overwrite a recorded glyph run's PREMULTIPLIED colour in place. `rgb` must
   * already be multiplied by `a`, exactly as {@link GlyphsView} states.
   */
  patchGlyphsColor(
    index: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void;
}

// Payload strides. A quad writes: m[6], w, h, src[4], rgba[4] = 16 floats and
// blend, flags, colorMatrixIndex = 3 ints. A nine-patch adds 4 margins.
const QUAD_FLOATS = 16;
const QUAD_INTS = 3;
const NINE_PATCH_FLOATS = QUAD_FLOATS + 4;
const NINE_PATCH_INTS = QUAD_INTS;
// A polyline writes width + rgba, then the flattened points; the point count is
// the one int.
const POLYLINE_HEADER_FLOATS = 5;
const POLYLINE_INTS = 1;
// A mesh writes m[6], rgba, then local positions and normalized UV pairs. Its
// int payload starts with vertex/index counts and blend, followed by indices.
const TEXTURED_MESH_HEADER_FLOATS = 10;
const TEXTURED_MESH_HEADER_INTS = 3;
// A glyph run writes m[6], pixelsPerEm, rgba, spreadPx and optional local ink
// bounds, then two pen floats per glyph; the glyph count is the first int and
// the atlas slot ids follow it.
// `spreadPx` remains at its original offset: `patchGlyphsTransform` writes
// 0..5 and `patchGlyphsColor` 7..10, so appending the bound tuple leaves both
// patchers' offsets exactly where they were.
const GLYPHS_SPREAD_OFFSET = 11;
const GLYPHS_INK_X_OFFSET = 12;
const GLYPHS_INK_Y_OFFSET = 13;
const GLYPHS_INK_WIDTH_OFFSET = 14;
const GLYPHS_INK_HEIGHT_OFFSET = 15;
const GLYPHS_INK_OUTSET_OFFSET = 16;
const GLYPHS_HEADER_FLOATS = 17;
const GLYPHS_HEADER_INTS = 1;
const CLIP_FLOATS = 6;
const COLOR_MATRIX_FLOATS = 9;

const DEFAULT_COMMAND_CAPACITY = 256;
const DEFAULT_FLOAT_CAPACITY = 256 * QUAD_FLOATS;
const DEFAULT_INT_CAPACITY = 256 * QUAD_INTS;
const DEFAULT_COLOR_MATRIX_CAPACITY = 8;

const IDENTITY_MATRIX_2D = [1, 0, 0, 1, 0, 0];
const IDENTITY_COLOR_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A fresh quad view: identity transform, opaque white, mix blend, no matrix. */
export function createQuadView(): QuadView {
  return {
    m: Float32Array.from(IDENTITY_MATRIX_2D),
    w: 0,
    h: 0,
    srcX: 0,
    srcY: 0,
    srcW: 0,
    srcH: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    blend: BLEND_MIX,
    flipH: false,
    flipV: false,
    hasColorMatrix: false,
    colorMatrix: Float32Array.from(IDENTITY_COLOR_MATRIX),
  };
}

/** A fresh nine-patch view: a quad view with zero margins. */
export function createNinePatchView(): NinePatchView {
  return {
    ...createQuadView(),
    marginLeft: 0,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
  };
}

/** A fresh polyline view with room for `pointCapacity` points. */
export function createPolylineView(pointCapacity = 8): PolylineView {
  return {
    points: new Float32Array(Math.max(1, pointCapacity) * 2),
    pointCount: 0,
    width: 1,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
  };
}

/** A reusable textured mesh view with room for the requested topology. */
export function createTexturedMeshView(
  vertexCapacity = 4,
  indexCapacity = 6,
): TexturedMeshView {
  const vertices = Math.max(1, Math.floor(vertexCapacity));
  return {
    m: Float32Array.from(IDENTITY_MATRIX_2D),
    positions: new Float32Array(vertices * 2),
    uvs: new Float32Array(vertices * 2),
    vertexCount: 0,
    indices: new Uint32Array(Math.max(1, Math.floor(indexCapacity))),
    indexCount: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    blend: BLEND_MIX,
  };
}

/** A fresh glyph-run view with room for `glyphCapacity` glyphs. */
export function createGlyphsView(glyphCapacity = 32): GlyphsView {
  const capacity = Math.max(1, glyphCapacity);
  return {
    m: Float32Array.from(IDENTITY_MATRIX_2D),
    pixelsPerEm: 16,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    slots: new Int32Array(capacity),
    positions: new Float32Array(capacity * 2),
    glyphCount: 0,
    spreadPx: 0,
    // Unknown is the safe default. A zero box would falsely tell retained
    // replay that a legacy producer's text paints nowhere.
    localInkX: Number.NaN,
    localInkY: Number.NaN,
    localInkWidth: Number.NaN,
    localInkHeight: Number.NaN,
    localInkOutset: Number.NaN,
  };
}

/** A fresh clip-rect view: empty rect, square corners, no outset. */
export function createClipRectView(): ClipRectView {
  return { x: 0, y: 0, w: 0, h: 0, cornerRadius: 0, outsetX: 0 };
}

/**
 * Copy an `html` {@link ColorMatrix} into a quad/nine-patch view and arm it.
 * Passing `null` disarms the view's matrix (leaving its contents alone), which
 * is the shape most callers have: a computed transform that is usually absent.
 */
export function setViewColorMatrix(
  view: QuadView,
  matrix: ColorMatrix | null | undefined,
): void {
  if (!matrix) {
    view.hasColorMatrix = false;
    return;
  }
  const rows = matrix.rows;
  const out = view.colorMatrix;
  out[0] = rows[0][0];
  out[1] = rows[0][1];
  out[2] = rows[0][2];
  out[3] = rows[1][0];
  out[4] = rows[1][1];
  out[5] = rows[1][2];
  out[6] = rows[2][0];
  out[7] = rows[2][1];
  out[8] = rows[2][2];
  view.hasColorMatrix = true;
}

function grownFloats(current: Float32Array, needed: number): Float32Array {
  let capacity = Math.max(1, current.length);
  while (capacity < needed) capacity *= 2;
  const next = new Float32Array(capacity);
  next.set(current);
  return next;
}

/** Preserve an omitted optional producer field as an unknown IR value. */
function finiteOrNaN(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NaN;
}

function grownInts(current: Int32Array, needed: number): Int32Array {
  let capacity = Math.max(1, current.length);
  while (capacity < needed) capacity *= 2;
  const next = new Int32Array(capacity);
  next.set(current);
  return next;
}

function grownObjects<T>(current: (T | null)[], needed: number): (T | null)[] {
  let capacity = Math.max(1, current.length);
  while (capacity < needed) capacity *= 2;
  const next: (T | null)[] = new Array(capacity).fill(null);
  for (let index = 0; index < current.length; index += 1) {
    next[index] = current[index];
  }
  return next;
}

interface FragmentStorage<TTexture> {
  kinds: Int32Array;
  floatOffsets: Int32Array;
  intOffsets: Int32Array;
  textures: (TTexture | null)[];
  screenEffects: (ScreenEffectDrawCommand | null)[];
  externalEffects: (ExternalEffectDrawCommand | null)[];
  floats: Float32Array;
  ints: Int32Array;
  colorMatrices: Float32Array;
  /** Source matrix index for each locally stored matrix; reused as a tiny map. */
  sourceMatrixIndexes: Int32Array;
  count: number;
  floatLength: number;
  intLength: number;
  colorMatrixCount: number;
  maxClipDepth: number;
}

const fragmentStorage = new WeakMap<object, FragmentStorage<unknown>>();

function requireFragmentStorage<TTexture>(
  fragment: DrawListFragment<TTexture>,
): FragmentStorage<TTexture> {
  const storage = fragmentStorage.get(fragment as object);
  if (!storage) {
    throw new TypeError(
      "draw-list appendFragment() needs a fragment created by createDrawListFragment()",
    );
  }
  return storage as FragmentStorage<TTexture>;
}

interface PayloadLengths {
  floats: number;
  ints: number;
}

function fillFragmentPayloadLengths<TTexture>(
  list: DrawList<TTexture>,
  index: number,
  out: PayloadLengths,
): void {
  const kind = list.kindAt(index);
  const intAt = list.intOffsetAt(index);
  const requireInt = (offset: number, label: string): number => {
    const value = list.ints[intAt + offset];
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(
        `draw-list ${label} at command ${index} is malformed`,
      );
    }
    return value;
  };
  switch (kind) {
    case DRAW_QUAD:
      out.floats = QUAD_FLOATS;
      out.ints = QUAD_INTS;
      return;
    case DRAW_NINE_PATCH:
      out.floats = NINE_PATCH_FLOATS;
      out.ints = NINE_PATCH_INTS;
      return;
    case DRAW_POLYLINE: {
      const points = requireInt(0, "polyline point count");
      out.floats = POLYLINE_HEADER_FLOATS + points * 2;
      out.ints = POLYLINE_INTS;
      return;
    }
    case DRAW_CLIP_PUSH:
      out.floats = CLIP_FLOATS;
      out.ints = 0;
      return;
    case DRAW_CLIP_POP:
    case DRAW_SCREEN_EFFECT:
    case DRAW_EXTERNAL_EFFECT:
      out.floats = 0;
      out.ints = 0;
      return;
    case DRAW_GLYPHS: {
      const glyphs = requireInt(0, "glyph count");
      out.floats = GLYPHS_HEADER_FLOATS + glyphs * 2;
      out.ints = GLYPHS_HEADER_INTS + glyphs;
      return;
    }
    case DRAW_TEXTURED_MESH: {
      const vertices = requireInt(0, "textured mesh vertex count");
      const indexes = requireInt(1, "textured mesh index count");
      out.floats = TEXTURED_MESH_HEADER_FLOATS + vertices * 4;
      out.ints = TEXTURED_MESH_HEADER_INTS + indexes;
      return;
    }
    default:
      throw new RangeError(
        `draw-list command ${index} has an unknown kind ${kind}`,
      );
  }
}

function fillFragmentStoragePayloadLengths<TTexture>(
  storage: FragmentStorage<TTexture>,
  index: number,
  out: PayloadLengths,
): void {
  if (!Number.isInteger(index) || index < 0 || index >= storage.count) {
    throw new RangeError(
      `draw-list fragment index ${index} out of range (count ${storage.count})`,
    );
  }
  const kind = storage.kinds[index] as DrawCommandKind;
  const intAt = storage.intOffsets[index];
  switch (kind) {
    case DRAW_QUAD:
      out.floats = QUAD_FLOATS;
      out.ints = QUAD_INTS;
      return;
    case DRAW_NINE_PATCH:
      out.floats = NINE_PATCH_FLOATS;
      out.ints = NINE_PATCH_INTS;
      return;
    case DRAW_POLYLINE: {
      const points = storage.ints[intAt];
      if (!Number.isInteger(points) || points < 0) {
        throw new RangeError(
          `draw-list fragment polyline point count at command ${index} is malformed`,
        );
      }
      out.floats = POLYLINE_HEADER_FLOATS + points * 2;
      out.ints = POLYLINE_INTS;
      return;
    }
    case DRAW_CLIP_PUSH:
      out.floats = CLIP_FLOATS;
      out.ints = 0;
      return;
    case DRAW_CLIP_POP:
    case DRAW_SCREEN_EFFECT:
    case DRAW_EXTERNAL_EFFECT:
      out.floats = 0;
      out.ints = 0;
      return;
    case DRAW_GLYPHS: {
      const glyphs = storage.ints[intAt];
      if (!Number.isInteger(glyphs) || glyphs < 0) {
        throw new RangeError(
          `draw-list fragment glyph count at command ${index} is malformed`,
        );
      }
      out.floats = GLYPHS_HEADER_FLOATS + glyphs * 2;
      out.ints = GLYPHS_HEADER_INTS + glyphs;
      return;
    }
    case DRAW_TEXTURED_MESH: {
      const vertices = storage.ints[intAt];
      const indexes = storage.ints[intAt + 1];
      if (!Number.isInteger(vertices) || vertices < 0) {
        throw new RangeError(
          `draw-list fragment textured mesh vertex count at command ${index} is malformed`,
        );
      }
      if (!Number.isInteger(indexes) || indexes < 0) {
        throw new RangeError(
          `draw-list fragment textured mesh index count at command ${index} is malformed`,
        );
      }
      out.floats = TEXTURED_MESH_HEADER_FLOATS + vertices * 4;
      out.ints = TEXTURED_MESH_HEADER_INTS + indexes;
      return;
    }
    default:
      throw new RangeError(
        `draw-list fragment command ${index} has an unknown kind ${kind}`,
      );
  }
}

/**
 * Create reusable storage for a retained command fragment. The fragment holds
 * only draw-list data and opaque caller references; it never creates or owns a
 * DOM node, a WebGL object, or an executor.
 */
export function createDrawListFragment<TTexture = unknown>(
  options: DrawListOptions = {},
): DrawListFragment<TTexture> {
  const commandCapacity = Math.max(
    1,
    options.commandCapacity ?? DEFAULT_COMMAND_CAPACITY,
  );
  const storage: FragmentStorage<TTexture> = {
    kinds: new Int32Array(commandCapacity),
    floatOffsets: new Int32Array(commandCapacity),
    intOffsets: new Int32Array(commandCapacity),
    textures: new Array<TTexture | null>(commandCapacity).fill(null),
    screenEffects: new Array<ScreenEffectDrawCommand | null>(
      commandCapacity,
    ).fill(null),
    externalEffects: new Array<ExternalEffectDrawCommand | null>(
      commandCapacity,
    ).fill(null),
    floats: new Float32Array(
      Math.max(1, options.floatCapacity ?? DEFAULT_FLOAT_CAPACITY),
    ),
    ints: new Int32Array(
      Math.max(1, options.intCapacity ?? DEFAULT_INT_CAPACITY),
    ),
    colorMatrices: new Float32Array(
      Math.max(
        1,
        options.colorMatrixCapacity ?? DEFAULT_COLOR_MATRIX_CAPACITY,
      ) * COLOR_MATRIX_FLOATS,
    ),
    sourceMatrixIndexes: new Int32Array(
      Math.max(1, options.colorMatrixCapacity ?? DEFAULT_COLOR_MATRIX_CAPACITY),
    ),
    count: 0,
    floatLength: 0,
    intLength: 0,
    colorMatrixCount: 0,
    maxClipDepth: 0,
  };

  function reset(): void {
    for (let index = 0; index < storage.count; index += 1) {
      storage.textures[index] = null;
      storage.screenEffects[index] = null;
      storage.externalEffects[index] = null;
    }
    storage.count = 0;
    storage.floatLength = 0;
    storage.intLength = 0;
    storage.colorMatrixCount = 0;
    storage.maxClipDepth = 0;
  }

  function ensureCommand(needed: number): void {
    if (needed <= storage.kinds.length) return;
    const capacity = storage.kinds.length * 2;
    const nextKinds = new Int32Array(capacity);
    nextKinds.set(storage.kinds);
    storage.kinds = nextKinds;
    const nextFloatOffsets = new Int32Array(capacity);
    nextFloatOffsets.set(storage.floatOffsets);
    storage.floatOffsets = nextFloatOffsets;
    const nextIntOffsets = new Int32Array(capacity);
    nextIntOffsets.set(storage.intOffsets);
    storage.intOffsets = nextIntOffsets;
    storage.textures = grownObjects(storage.textures, needed);
    storage.screenEffects = grownObjects(storage.screenEffects, needed);
    storage.externalEffects = grownObjects(storage.externalEffects, needed);
  }

  function matrixIndexFor(
    source: DrawList<TTexture>,
    sourceIndex: number,
  ): number {
    for (let index = 0; index < storage.colorMatrixCount; index += 1) {
      if (storage.sourceMatrixIndexes[index] === sourceIndex) return index;
    }
    const sourceAt = sourceIndex * COLOR_MATRIX_FLOATS;
    if (
      sourceIndex < 0 ||
      sourceAt + COLOR_MATRIX_FLOATS > source.colorMatrices.length
    ) {
      throw new RangeError(
        `draw-list color matrix ${sourceIndex} is malformed`,
      );
    }
    const nextCount = storage.colorMatrixCount + 1;
    if (nextCount * COLOR_MATRIX_FLOATS > storage.colorMatrices.length) {
      storage.colorMatrices = grownFloats(
        storage.colorMatrices,
        nextCount * COLOR_MATRIX_FLOATS,
      );
    }
    if (nextCount > storage.sourceMatrixIndexes.length) {
      storage.sourceMatrixIndexes = grownInts(
        storage.sourceMatrixIndexes,
        nextCount,
      );
    }
    const target = storage.colorMatrixCount;
    const targetAt = target * COLOR_MATRIX_FLOATS;
    for (let offset = 0; offset < COLOR_MATRIX_FLOATS; offset += 1) {
      storage.colorMatrices[targetAt + offset] =
        source.colorMatrices[sourceAt + offset];
    }
    storage.sourceMatrixIndexes[target] = sourceIndex;
    storage.colorMatrixCount = nextCount;
    return target;
  }

  function capture(
    source: DrawList<TTexture>,
    start: number,
    end = source.count,
  ): void {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.count
    ) {
      throw new RangeError(
        `draw-list fragment range [${start}, ${end}) is outside count ${source.count}`,
      );
    }

    // Validate the whole range before dropping a useful cached fragment.
    const lengths: PayloadLengths = { floats: 0, ints: 0 };
    let depth = 0;
    let maxDepth = 0;
    for (let index = start; index < end; index += 1) {
      fillFragmentPayloadLengths(source, index, lengths);
      const floatAt = source.floatOffsetAt(index);
      const intAt = source.intOffsetAt(index);
      if (
        floatAt < 0 ||
        intAt < 0 ||
        floatAt + lengths.floats > source.floats.length ||
        intAt + lengths.ints > source.ints.length
      ) {
        throw new RangeError(
          `draw-list command ${index} has an invalid arena range`,
        );
      }
      const kind = source.kindAt(index);
      if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
        const matrix = source.ints[intAt + 2];
        if (
          !Number.isInteger(matrix) ||
          matrix < -1 ||
          (matrix >= 0 &&
            (matrix + 1) * COLOR_MATRIX_FLOATS > source.colorMatrices.length)
        ) {
          throw new RangeError(
            `draw-list color matrix ${matrix} at command ${index} is malformed`,
          );
        }
      }
      if (kind === DRAW_CLIP_PUSH) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      } else if (kind === DRAW_CLIP_POP) {
        depth -= 1;
        if (depth < 0) {
          throw new RangeError(
            `draw-list fragment range [${start}, ${end}) pops a clip it did not push`,
          );
        }
      }
    }
    if (depth !== 0) {
      throw new RangeError(
        `draw-list fragment range [${start}, ${end}) leaves ${depth} clip(s) open`,
      );
    }

    reset();
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      fillFragmentPayloadLengths(source, sourceIndex, lengths);
      const index = storage.count;
      ensureCommand(index + 1);
      if (storage.floatLength + lengths.floats > storage.floats.length) {
        storage.floats = grownFloats(
          storage.floats,
          storage.floatLength + lengths.floats,
        );
      }
      if (storage.intLength + lengths.ints > storage.ints.length) {
        storage.ints = grownInts(
          storage.ints,
          storage.intLength + lengths.ints,
        );
      }
      storage.kinds[index] = source.kindAt(sourceIndex);
      storage.floatOffsets[index] = storage.floatLength;
      storage.intOffsets[index] = storage.intLength;
      storage.textures[index] = source.textureAt(sourceIndex);
      storage.screenEffects[index] = source.screenEffectAt(sourceIndex);
      storage.externalEffects[index] = source.externalEffectAt(sourceIndex);
      const sourceFloatAt = source.floatOffsetAt(sourceIndex);
      const sourceIntAt = source.intOffsetAt(sourceIndex);
      for (let offset = 0; offset < lengths.floats; offset += 1) {
        storage.floats[storage.floatLength + offset] =
          source.floats[sourceFloatAt + offset];
      }
      for (let offset = 0; offset < lengths.ints; offset += 1) {
        storage.ints[storage.intLength + offset] =
          source.ints[sourceIntAt + offset];
      }
      const kind = storage.kinds[index] as DrawCommandKind;
      if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
        const matrix = storage.ints[storage.intLength + 2];
        if (matrix >= 0)
          storage.ints[storage.intLength + 2] = matrixIndexFor(source, matrix);
      }
      storage.count += 1;
      storage.floatLength += lengths.floats;
      storage.intLength += lengths.ints;
    }
    storage.maxClipDepth = maxDepth;
  }

  const fragment: DrawListFragment<TTexture> = {
    get count() {
      return storage.count;
    },
    get clipDepth() {
      return 0;
    },
    get maxClipDepth() {
      return storage.maxClipDepth;
    },
    reset,
    capture,
  };
  fragmentStorage.set(fragment as object, storage as FragmentStorage<unknown>);
  // The mutable arenas are closure-private and the public handle cannot be
  // forged or replaced. appendFragment therefore only receives storage that a
  // successful capture fully validated, before it touches destination state.
  return Object.freeze(fragment);
}

/**
 * Create an empty draw list. Capacities are only a starting point; every arena
 * grows on demand, so a list settles at the high-water mark of the frames it
 * has recorded and then allocates nothing.
 */
export function createDrawList<TTexture = unknown>(
  options: DrawListOptions = {},
): DrawList<TTexture> {
  let kinds: Int32Array = new Int32Array(
    Math.max(1, options.commandCapacity ?? DEFAULT_COMMAND_CAPACITY),
  );
  let floatOffsets: Int32Array = new Int32Array(kinds.length);
  let intOffsets: Int32Array = new Int32Array(kinds.length);
  let textures: (TTexture | null)[] = new Array(kinds.length).fill(null);
  let screenEffects: (ScreenEffectDrawCommand | null)[] = new Array(
    kinds.length,
  ).fill(null);
  let externalEffects: (ExternalEffectDrawCommand | null)[] = new Array(
    kinds.length,
  ).fill(null);

  let floats: Float32Array = new Float32Array(
    Math.max(1, options.floatCapacity ?? DEFAULT_FLOAT_CAPACITY),
  );
  let ints: Int32Array = new Int32Array(
    Math.max(1, options.intCapacity ?? DEFAULT_INT_CAPACITY),
  );
  let colorMatrices: Float32Array = new Float32Array(
    Math.max(1, options.colorMatrixCapacity ?? DEFAULT_COLOR_MATRIX_CAPACITY) *
      COLOR_MATRIX_FLOATS,
  );

  let count = 0;
  let floatLength = 0;
  let intLength = 0;
  let colorMatrixCount = 0;
  let clipDepth = 0;
  let maxClipDepth = 0;
  let structuralRevision = 0;
  let contentRevision = 0;
  let commandRevisions = new Int32Array(kinds.length);
  const patchJournalCapacity = Math.max(1, options.patchJournalCapacity ?? 256);
  const patchJournalRevisions = new Int32Array(patchJournalCapacity);
  const patchJournalIndexes = new Int32Array(patchJournalCapacity);
  let patchJournalStart = 0;
  let patchJournalCount = 0;
  // Reused by appendFragment(): retained subtree flattening is a hot path and
  // must not allocate a tuple or scratch object per command or per append.
  const fragmentAppendLengths: PayloadLengths = { floats: 0, ints: 0 };
  // `fillFragmentPayloadLengths` intentionally consumes the public read
  // surface. Keep this tiny live adapter reusable so patch validation does not
  // allocate a façade for every command it examines.
  const fragmentPatchDestinationView = {
    kindAt(index: number) {
      return kinds[index] as DrawCommandKind;
    },
    intOffsetAt(index: number) {
      return intOffsets[index];
    },
    get ints() {
      return ints;
    },
  } as DrawList<TTexture>;

  function ensureCommandSlot(): void {
    if (count < kinds.length) return;
    const capacity = kinds.length * 2;
    const nextKinds = new Int32Array(capacity);
    nextKinds.set(kinds);
    kinds = nextKinds;
    const nextFloatOffsets = new Int32Array(capacity);
    nextFloatOffsets.set(floatOffsets);
    floatOffsets = nextFloatOffsets;
    const nextIntOffsets = new Int32Array(capacity);
    nextIntOffsets.set(intOffsets);
    intOffsets = nextIntOffsets;
    const nextRevisions = new Int32Array(capacity);
    nextRevisions.set(commandRevisions);
    commandRevisions = nextRevisions;
    const nextTextures: (TTexture | null)[] = new Array(capacity).fill(null);
    for (let i = 0; i < textures.length; i += 1) nextTextures[i] = textures[i];
    textures = nextTextures;
    const nextEffects: (ScreenEffectDrawCommand | null)[] = new Array(
      capacity,
    ).fill(null);
    for (let i = 0; i < screenEffects.length; i += 1)
      nextEffects[i] = screenEffects[i];
    screenEffects = nextEffects;
    const nextExternalEffects: (ExternalEffectDrawCommand | null)[] = new Array(
      capacity,
    ).fill(null);
    for (let i = 0; i < externalEffects.length; i += 1)
      nextExternalEffects[i] = externalEffects[i];
    externalEffects = nextExternalEffects;
  }

  function beginCommand(
    kind: DrawCommandKind,
    floatCount: number,
    intCount: number,
    texture: TTexture | null,
  ): number {
    ensureCommandSlot();
    if (floatLength + floatCount > floats.length) {
      floats = grownFloats(floats, floatLength + floatCount);
    }
    if (intLength + intCount > ints.length) {
      ints = grownInts(ints, intLength + intCount);
    }
    const index = count;
    kinds[index] = kind;
    floatOffsets[index] = floatLength;
    intOffsets[index] = intLength;
    textures[index] = texture;
    count += 1;
    contentRevision += 1;
    structuralRevision += 1;
    commandRevisions[index] = contentRevision;
    floatLength += floatCount;
    intLength += intCount;
    return index;
  }

  function storeColorMatrix(view: QuadView): number {
    if (!view.hasColorMatrix) return -1;
    const needed = (colorMatrixCount + 1) * COLOR_MATRIX_FLOATS;
    if (needed > colorMatrices.length) {
      colorMatrices = grownFloats(colorMatrices, needed);
    }
    const at = colorMatrixCount * COLOR_MATRIX_FLOATS;
    colorMatrices.set(view.colorMatrix.subarray(0, COLOR_MATRIX_FLOATS), at);
    colorMatrixCount += 1;
    return colorMatrixCount - 1;
  }

  function storeFragmentColorMatrix(
    matrices: Float32Array,
    matrixIndex: number,
  ): number {
    const from = matrixIndex * COLOR_MATRIX_FLOATS;
    if (matrixIndex < 0 || from + COLOR_MATRIX_FLOATS > matrices.length) {
      throw new RangeError(
        `draw-list fragment color matrix ${matrixIndex} is malformed`,
      );
    }
    const needed = (colorMatrixCount + 1) * COLOR_MATRIX_FLOATS;
    if (needed > colorMatrices.length) {
      colorMatrices = grownFloats(colorMatrices, needed);
    }
    const target = colorMatrixCount * COLOR_MATRIX_FLOATS;
    for (let offset = 0; offset < COLOR_MATRIX_FLOATS; offset += 1) {
      colorMatrices[target + offset] = matrices[from + offset];
    }
    colorMatrixCount += 1;
    return colorMatrixCount - 1;
  }

  function requireIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(
        `draw-list index ${index} out of range (count ${count})`,
      );
    }
  }

  function requireKind(index: number, kind: DrawCommandKind): number {
    requireIndex(index);
    if (kinds[index] !== kind) {
      throw new TypeError(
        `draw-list command ${index} is "${DRAW_COMMAND_NAMES[kinds[index]]}", not "${DRAW_COMMAND_NAMES[kind]}"`,
      );
    }
    return index;
  }

  /**
   * The guard for the patch methods: both quad kinds are accepted because a
   * nine-patch stores a quad payload first and its margins after, so the
   * transform and colour slots are at the same offsets in both. Refusing
   * nine-patches would drop the feature exactly where a consumer needs it most
   * (a dialog fading out is nine-patch frames plus quads).
   */
  function requireQuadLike(index: number): number {
    requireIndex(index);
    const kind = kinds[index];
    if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH) {
      throw new TypeError(
        `draw-list command ${index} is "${DRAW_COMMAND_NAMES[kind]}", not a quad-like command ("quad" or "ninePatch")`,
      );
    }
    return index;
  }

  function requireTexturedMesh(index: number): number {
    return requireKind(index, DRAW_TEXTURED_MESH);
  }

  function markPatched(index: number): void {
    contentRevision += 1;
    commandRevisions[index] = contentRevision;
    const slot = (patchJournalStart + patchJournalCount) % patchJournalCapacity;
    patchJournalRevisions[slot] = contentRevision;
    patchJournalIndexes[slot] = index;
    if (patchJournalCount < patchJournalCapacity) patchJournalCount += 1;
    else patchJournalStart = (patchJournalStart + 1) % patchJournalCapacity;
  }

  function hasExpectedObjectPayload(
    kind: DrawCommandKind,
    texture: TTexture | null,
    screenEffect: ScreenEffectDrawCommand | null,
    externalEffect: ExternalEffectDrawCommand | null,
  ): boolean {
    switch (kind) {
      case DRAW_QUAD:
      case DRAW_NINE_PATCH:
      case DRAW_TEXTURED_MESH:
        return screenEffect === null && externalEffect === null;
      case DRAW_SCREEN_EFFECT:
        return (
          texture === null &&
          externalEffect === null &&
          screenEffect !== null &&
          screenEffect.screenDependent === true &&
          typeof screenEffect.execute === "function"
        );
      case DRAW_EXTERNAL_EFFECT:
        return (
          texture === null &&
          screenEffect === null &&
          externalEffect !== null &&
          typeof externalEffect.execute === "function"
        );
      default:
        return (
          texture === null && screenEffect === null && externalEffect === null
        );
    }
  }

  /**
   * Validate whether a captured range can overwrite the existing slots without
   * changing any command layout. This runs to completion before a byte or
   * reference is touched, which is the atomicity boundary for patchFragment.
   */
  function canPatchFragment(
    start: number,
    captured: FragmentStorage<TTexture>,
  ): boolean {
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      start > count ||
      captured.count > count - start
    ) {
      return false;
    }
    if (captured.count === 0) return true;

    const destinationMatrices = new Map<number, number>();
    let sourceClipDepth = 0;
    let destinationClipDepth = 0;
    try {
      for (
        let sourceIndex = 0;
        sourceIndex < captured.count;
        sourceIndex += 1
      ) {
        const destinationIndex = start + sourceIndex;
        const sourceKind = captured.kinds[sourceIndex] as DrawCommandKind;
        if (kinds[destinationIndex] !== sourceKind) return false;

        const sourceFloatAt = captured.floatOffsets[sourceIndex];
        const sourceIntAt = captured.intOffsets[sourceIndex];
        const destinationFloatAt = floatOffsets[destinationIndex];
        const destinationIntAt = intOffsets[destinationIndex];
        fillFragmentStoragePayloadLengths(
          captured,
          sourceIndex,
          fragmentAppendLengths,
        );
        const sourceFloats = fragmentAppendLengths.floats;
        const sourceInts = fragmentAppendLengths.ints;
        if (
          sourceFloatAt < 0 ||
          sourceIntAt < 0 ||
          sourceFloatAt + sourceFloats > captured.floatLength ||
          sourceIntAt + sourceInts > captured.intLength ||
          destinationFloatAt < 0 ||
          destinationIntAt < 0 ||
          destinationFloatAt + sourceFloats > floatLength ||
          destinationIntAt + sourceInts > intLength
        ) {
          return false;
        }

        fillFragmentPayloadLengths(
          fragmentPatchDestinationView,
          destinationIndex,
          fragmentAppendLengths,
        );
        if (
          fragmentAppendLengths.floats !== sourceFloats ||
          fragmentAppendLengths.ints !== sourceInts
        ) {
          return false;
        }

        if (
          !hasExpectedObjectPayload(
            sourceKind,
            captured.textures[sourceIndex],
            captured.screenEffects[sourceIndex],
            captured.externalEffects[sourceIndex],
          ) ||
          !hasExpectedObjectPayload(
            sourceKind,
            textures[destinationIndex],
            screenEffects[destinationIndex],
            externalEffects[destinationIndex],
          )
        ) {
          return false;
        }

        if (sourceKind === DRAW_QUAD || sourceKind === DRAW_NINE_PATCH) {
          const sourceMatrix = captured.ints[sourceIntAt + 2];
          const destinationMatrix = ints[destinationIntAt + 2];
          const sourceHasMatrix = sourceMatrix >= 0;
          const destinationHasMatrix = destinationMatrix >= 0;
          if (sourceHasMatrix !== destinationHasMatrix) return false;
          if (sourceHasMatrix) {
            if (
              !Number.isInteger(sourceMatrix) ||
              !Number.isInteger(destinationMatrix) ||
              sourceMatrix >= captured.colorMatrixCount ||
              destinationMatrix >= colorMatrixCount ||
              (sourceMatrix + 1) * COLOR_MATRIX_FLOATS >
                captured.colorMatrices.length ||
              (destinationMatrix + 1) * COLOR_MATRIX_FLOATS >
                colorMatrices.length
            ) {
              return false;
            }
            const previousSource = destinationMatrices.get(destinationMatrix);
            if (
              previousSource !== undefined &&
              previousSource !== sourceMatrix
            ) {
              return false;
            }
            destinationMatrices.set(destinationMatrix, sourceMatrix);
          } else if (sourceMatrix !== -1 || destinationMatrix !== -1) {
            return false;
          }
        }

        if (sourceKind === DRAW_CLIP_PUSH) {
          sourceClipDepth += 1;
          destinationClipDepth += 1;
        } else if (sourceKind === DRAW_CLIP_POP) {
          sourceClipDepth -= 1;
          destinationClipDepth -= 1;
          if (sourceClipDepth < 0 || destinationClipDepth < 0) return false;
        }
      }
    } catch {
      // Public numeric arenas can be malformed. A retained patch must decline
      // rather than partly repairing a list it did not build.
      return false;
    }
    if (sourceClipDepth !== 0 || destinationClipDepth !== 0) return false;

    // Normal DrawList writes allocate a distinct matrix for each command. If a
    // caller has manually made one slot shared, changing it could alter an
    // unpatched command, so fail closed instead of breaking atomic locality.
    if (destinationMatrices.size > 0) {
      for (let index = 0; index < count; index += 1) {
        if (index >= start && index < start + captured.count) continue;
        const kind = kinds[index];
        if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH) continue;
        if (destinationMatrices.has(ints[intOffsets[index] + 2])) return false;
      }
    }
    return true;
  }

  function applyFragmentPatch(
    start: number,
    captured: FragmentStorage<TTexture>,
  ): void {
    // canPatchFragment() proved every span, matrix slot and object-side
    // payload valid before this loop starts. Nothing below can resize storage
    // or reject, preserving all-or-nothing mutation at the public boundary.
    for (let sourceIndex = 0; sourceIndex < captured.count; sourceIndex += 1) {
      const destinationIndex = start + sourceIndex;
      const kind = captured.kinds[sourceIndex] as DrawCommandKind;
      const sourceFloatAt = captured.floatOffsets[sourceIndex];
      const sourceIntAt = captured.intOffsets[sourceIndex];
      const destinationFloatAt = floatOffsets[destinationIndex];
      const destinationIntAt = intOffsets[destinationIndex];
      const destinationMatrix =
        kind === DRAW_QUAD || kind === DRAW_NINE_PATCH
          ? ints[destinationIntAt + 2]
          : -1;
      fillFragmentStoragePayloadLengths(
        captured,
        sourceIndex,
        fragmentAppendLengths,
      );
      floats.set(
        captured.floats.subarray(
          sourceFloatAt,
          sourceFloatAt + fragmentAppendLengths.floats,
        ),
        destinationFloatAt,
      );
      ints.set(
        captured.ints.subarray(
          sourceIntAt,
          sourceIntAt + fragmentAppendLengths.ints,
        ),
        destinationIntAt,
      );
      textures[destinationIndex] = captured.textures[sourceIndex];
      screenEffects[destinationIndex] = captured.screenEffects[sourceIndex];
      externalEffects[destinationIndex] = captured.externalEffects[sourceIndex];
      if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
        const sourceMatrix = captured.ints[sourceIntAt + 2];
        if (sourceMatrix >= 0) {
          const sourceMatrixAt = sourceMatrix * COLOR_MATRIX_FLOATS;
          const destinationMatrixAt = destinationMatrix * COLOR_MATRIX_FLOATS;
          colorMatrices.set(
            captured.colorMatrices.subarray(
              sourceMatrixAt,
              sourceMatrixAt + COLOR_MATRIX_FLOATS,
            ),
            destinationMatrixAt,
          );
          // The copied fragment owns a compact matrix arena; the destination
          // keeps its existing slot so references outside its fragment stay
          // meaningful and compiled consumers see an in-place content delta.
          ints[destinationIntAt + 2] = destinationMatrix;
        }
      }
    }
    for (let index = start; index < start + captured.count; index += 1) {
      markPatched(index);
    }
  }

  function applyFragmentPatches(
    patches: readonly DrawListFragmentPatch<TTexture>[],
  ): boolean {
    if (!Array.isArray(patches)) return false;
    const validated: Array<{
      start: number;
      captured: FragmentStorage<TTexture>;
    }> = [];
    let previousStart = -1;
    let previousEnd = 0;
    for (const patch of patches) {
      if (!patch || !Number.isInteger(patch.start)) return false;
      const start = patch.start;
      if (start < previousStart) return false;
      let captured: FragmentStorage<TTexture>;
      try {
        captured = requireFragmentStorage(patch.fragment);
      } catch {
        return false;
      }
      if (start < previousEnd || !canPatchFragment(start, captured)) {
        return false;
      }
      validated.push({ start, captured });
      previousStart = start;
      previousEnd = Math.max(previousEnd, start + captured.count);
    }
    for (const patch of validated)
      applyFragmentPatch(patch.start, patch.captured);
    return true;
  }

  function writeQuadPayload(view: QuadView, at: number): void {
    floats[at] = view.m[0];
    floats[at + 1] = view.m[1];
    floats[at + 2] = view.m[2];
    floats[at + 3] = view.m[3];
    floats[at + 4] = view.m[4];
    floats[at + 5] = view.m[5];
    floats[at + 6] = view.w;
    floats[at + 7] = view.h;
    floats[at + 8] = view.srcX;
    floats[at + 9] = view.srcY;
    floats[at + 10] = view.srcW;
    floats[at + 11] = view.srcH;
    floats[at + 12] = view.r;
    floats[at + 13] = view.g;
    floats[at + 14] = view.b;
    floats[at + 15] = view.a;
  }

  function readQuadPayload(view: QuadView, at: number): void {
    view.m[0] = floats[at];
    view.m[1] = floats[at + 1];
    view.m[2] = floats[at + 2];
    view.m[3] = floats[at + 3];
    view.m[4] = floats[at + 4];
    view.m[5] = floats[at + 5];
    view.w = floats[at + 6];
    view.h = floats[at + 7];
    view.srcX = floats[at + 8];
    view.srcY = floats[at + 9];
    view.srcW = floats[at + 10];
    view.srcH = floats[at + 11];
    view.r = floats[at + 12];
    view.g = floats[at + 13];
    view.b = floats[at + 14];
    view.a = floats[at + 15];
  }

  function writeQuadInts(
    view: QuadView,
    at: number,
    matrixIndex: number,
  ): void {
    ints[at] = view.blend;
    ints[at + 1] = (view.flipH ? FLIP_H : 0) | (view.flipV ? FLIP_V : 0);
    ints[at + 2] = matrixIndex;
  }

  function readQuadInts(view: QuadView, at: number): void {
    view.blend = ints[at] as BlendMode;
    const flags = ints[at + 1];
    view.flipH = (flags & FLIP_H) !== 0;
    view.flipV = (flags & FLIP_V) !== 0;
    const matrixIndex = ints[at + 2];
    view.hasColorMatrix = matrixIndex >= 0;
    if (matrixIndex >= 0) {
      const from = matrixIndex * COLOR_MATRIX_FLOATS;
      for (let i = 0; i < COLOR_MATRIX_FLOATS; i += 1) {
        view.colorMatrix[i] = colorMatrices[from + i];
      }
    }
  }

  return {
    get count() {
      return count;
    },
    get clipDepth() {
      return clipDepth;
    },
    get maxClipDepth() {
      return maxClipDepth;
    },
    get structuralRevision() {
      return structuralRevision;
    },
    get contentRevision() {
      return contentRevision;
    },
    get floats() {
      return floats;
    },
    get ints() {
      return ints;
    },
    get colorMatrices() {
      return colorMatrices;
    },

    reset() {
      for (let i = 0; i < count; i += 1) {
        textures[i] = null;
        screenEffects[i] = null;
        externalEffects[i] = null;
      }
      count = 0;
      floatLength = 0;
      intLength = 0;
      colorMatrixCount = 0;
      clipDepth = 0;
      maxClipDepth = 0;
      contentRevision += 1;
      structuralRevision += 1;
    },

    appendFragment(fragment) {
      const captured = requireFragmentStorage(fragment);
      const start = count;
      for (
        let sourceIndex = 0;
        sourceIndex < captured.count;
        sourceIndex += 1
      ) {
        const kind = captured.kinds[sourceIndex] as DrawCommandKind;
        const floatAt = captured.floatOffsets[sourceIndex];
        const intAt = captured.intOffsets[sourceIndex];
        fillFragmentStoragePayloadLengths(
          captured,
          sourceIndex,
          fragmentAppendLengths,
        );
        if (
          floatAt < 0 ||
          intAt < 0 ||
          floatAt + fragmentAppendLengths.floats > captured.floatLength ||
          intAt + fragmentAppendLengths.ints > captured.intLength
        ) {
          throw new RangeError(
            `draw-list fragment command ${sourceIndex} has an invalid arena range`,
          );
        }
        const index = beginCommand(
          kind,
          fragmentAppendLengths.floats,
          fragmentAppendLengths.ints,
          captured.textures[sourceIndex],
        );
        const targetFloatAt = floatOffsets[index];
        const targetIntAt = intOffsets[index];
        for (
          let offset = 0;
          offset < fragmentAppendLengths.floats;
          offset += 1
        ) {
          floats[targetFloatAt + offset] = captured.floats[floatAt + offset];
        }
        for (let offset = 0; offset < fragmentAppendLengths.ints; offset += 1) {
          ints[targetIntAt + offset] = captured.ints[intAt + offset];
        }
        screenEffects[index] = captured.screenEffects[sourceIndex];
        externalEffects[index] = captured.externalEffects[sourceIndex];
        if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
          const matrix = captured.ints[intAt + 2];
          if (matrix >= 0) {
            ints[targetIntAt + 2] = storeFragmentColorMatrix(
              captured.colorMatrices,
              matrix,
            );
          }
        }
        if (kind === DRAW_CLIP_PUSH) {
          clipDepth += 1;
          maxClipDepth = Math.max(maxClipDepth, clipDepth);
        } else if (kind === DRAW_CLIP_POP) {
          if (clipDepth <= 0) {
            throw new RangeError(
              "draw-list fragment popClip() with no clip rect pushed",
            );
          }
          clipDepth -= 1;
        }
      }
      return start;
    },

    patchFragment(start, fragment) {
      return applyFragmentPatches([{ start, fragment }]);
    },

    patchFragments(patches) {
      return applyFragmentPatches(patches);
    },

    kindAt(index) {
      requireIndex(index);
      return kinds[index] as DrawCommandKind;
    },

    commandRevisionAt(index) {
      requireIndex(index);
      return commandRevisions[index];
    },

    readPatchesSince(revision, out) {
      const mutable = out as MutableDrawListPatchView;
      mutable.begin(contentRevision);
      if (revision === contentRevision) return out;
      if (patchJournalCount === 0) {
        mutable.overflow();
        return out;
      }
      const oldest = patchJournalRevisions[patchJournalStart];
      if (revision < oldest - 1) {
        mutable.overflow();
        return out;
      }
      for (let offset = 0; offset < patchJournalCount; offset += 1) {
        const slot = (patchJournalStart + offset) % patchJournalCapacity;
        if (patchJournalRevisions[slot] > revision)
          mutable.add(patchJournalIndexes[slot]);
      }
      return out;
    },

    kindNameAt(index) {
      requireIndex(index);
      return DRAW_COMMAND_NAMES[kinds[index]];
    },

    textureAt(index) {
      requireIndex(index);
      return textures[index];
    },
    screenEffectAt(index) {
      requireIndex(index);
      return screenEffects[index];
    },
    externalEffectAt(index) {
      requireIndex(index);
      return externalEffects[index];
    },

    floatOffsetAt(index) {
      requireIndex(index);
      return floatOffsets[index];
    },

    intOffsetAt(index) {
      requireIndex(index);
      return intOffsets[index];
    },

    colorMatrixIndexAt(index) {
      requireIndex(index);
      const kind = kinds[index];
      if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH) return -1;
      return ints[intOffsets[index] + 2];
    },

    pushQuad(quad, texture = null) {
      const matrixIndex = storeColorMatrix(quad);
      const index = beginCommand(DRAW_QUAD, QUAD_FLOATS, QUAD_INTS, texture);
      writeQuadPayload(quad, floatOffsets[index]);
      writeQuadInts(quad, intOffsets[index], matrixIndex);
      return index;
    },

    pushNinePatch(patch, texture = null) {
      const matrixIndex = storeColorMatrix(patch);
      const index = beginCommand(
        DRAW_NINE_PATCH,
        NINE_PATCH_FLOATS,
        NINE_PATCH_INTS,
        texture,
      );
      const at = floatOffsets[index];
      writeQuadPayload(patch, at);
      floats[at + QUAD_FLOATS] = patch.marginLeft;
      floats[at + QUAD_FLOATS + 1] = patch.marginTop;
      floats[at + QUAD_FLOATS + 2] = patch.marginRight;
      floats[at + QUAD_FLOATS + 3] = patch.marginBottom;
      writeQuadInts(patch, intOffsets[index], matrixIndex);
      return index;
    },

    pushPolyline(line) {
      const pointCount = Math.max(0, Math.floor(line.pointCount));
      if (pointCount * 2 > line.points.length) {
        throw new RangeError(
          `polyline claims ${pointCount} points but its buffer holds ${Math.floor(line.points.length / 2)}`,
        );
      }
      const index = beginCommand(
        DRAW_POLYLINE,
        POLYLINE_HEADER_FLOATS + pointCount * 2,
        POLYLINE_INTS,
        null,
      );
      const at = floatOffsets[index];
      floats[at] = line.width;
      floats[at + 1] = line.r;
      floats[at + 2] = line.g;
      floats[at + 3] = line.b;
      floats[at + 4] = line.a;
      floats.set(
        line.points.subarray(0, pointCount * 2),
        at + POLYLINE_HEADER_FLOATS,
      );
      ints[intOffsets[index]] = pointCount;
      return index;
    },

    pushTexturedMesh(mesh, texture = null) {
      const vertexCount = Math.max(0, Math.floor(mesh.vertexCount));
      const indexCount = Math.max(0, Math.floor(mesh.indexCount));
      if (mesh.m.length < 6) {
        throw new RangeError(
          `textured mesh transform needs 6 entries, got ${mesh.m.length}`,
        );
      }
      if (vertexCount * 2 > mesh.positions.length) {
        throw new RangeError(
          `textured mesh claims ${vertexCount} vertices but its position buffer holds ${Math.floor(mesh.positions.length / 2)}`,
        );
      }
      if (vertexCount * 2 > mesh.uvs.length) {
        throw new RangeError(
          `textured mesh claims ${vertexCount} vertices but its UV buffer holds ${Math.floor(mesh.uvs.length / 2)}`,
        );
      }
      if (indexCount > mesh.indices.length) {
        throw new RangeError(
          `textured mesh claims ${indexCount} indices but its index buffer holds ${mesh.indices.length}`,
        );
      }
      if (indexCount % 3 !== 0) {
        throw new RangeError(
          `textured mesh index count ${indexCount} is not a triangle list`,
        );
      }
      for (let i = 0; i < indexCount; i += 1) {
        if (mesh.indices[i] >= vertexCount) {
          throw new RangeError(
            `textured mesh index ${mesh.indices[i]} at ${i} is outside ${vertexCount} vertices`,
          );
        }
      }
      const index = beginCommand(
        DRAW_TEXTURED_MESH,
        TEXTURED_MESH_HEADER_FLOATS + vertexCount * 4,
        TEXTURED_MESH_HEADER_INTS + indexCount,
        texture,
      );
      const at = floatOffsets[index];
      for (let i = 0; i < 6; i += 1) floats[at + i] = mesh.m[i];
      floats[at + 6] = mesh.r;
      floats[at + 7] = mesh.g;
      floats[at + 8] = mesh.b;
      floats[at + 9] = mesh.a;
      const positionsAt = at + TEXTURED_MESH_HEADER_FLOATS;
      for (let i = 0; i < vertexCount * 2; i += 1) {
        floats[positionsAt + i] = mesh.positions[i];
        floats[positionsAt + vertexCount * 2 + i] = mesh.uvs[i];
      }
      const intAt = intOffsets[index];
      ints[intAt] = vertexCount;
      ints[intAt + 1] = indexCount;
      ints[intAt + 2] = mesh.blend;
      for (let i = 0; i < indexCount; i += 1) {
        ints[intAt + TEXTURED_MESH_HEADER_INTS + i] = mesh.indices[i];
      }
      return index;
    },

    pushGlyphs(run) {
      const glyphCount = Math.max(0, Math.floor(run.glyphCount));
      if (glyphCount * 2 > run.positions.length) {
        throw new RangeError(
          `glyph run claims ${glyphCount} glyphs but its position buffer holds ${Math.floor(run.positions.length / 2)}`,
        );
      }
      if (glyphCount > run.slots.length) {
        throw new RangeError(
          `glyph run claims ${glyphCount} glyphs but its slot buffer holds ${run.slots.length}`,
        );
      }
      const index = beginCommand(
        DRAW_GLYPHS,
        GLYPHS_HEADER_FLOATS + glyphCount * 2,
        GLYPHS_HEADER_INTS + glyphCount,
        null,
      );
      const at = floatOffsets[index];
      floats[at] = run.m[0];
      floats[at + 1] = run.m[1];
      floats[at + 2] = run.m[2];
      floats[at + 3] = run.m[3];
      floats[at + 4] = run.m[4];
      floats[at + 5] = run.m[5];
      floats[at + 6] = run.pixelsPerEm;
      floats[at + 7] = run.r;
      floats[at + 8] = run.g;
      floats[at + 9] = run.b;
      floats[at + 10] = run.a;
      // NORMALISED, NOT COPIED, AND THAT IS ABOUT THE CONSUMERS RATHER THAN ABOUT TASTE. This
      // field is newer than the hand-maintained ambient `.d.ts` files that `../sts2-couch-coop`
      // and `../spirectl` resolve this package through (see `AGENTS.md`), and at least one of them
      // builds a `GlyphsView` field-for-field rather than through `createGlyphsView`. Such a caller
      // still TYPE-CHECKS — its own declaration has no `spreadPx` — and hands us `undefined`, which
      // a Float32Array stores as NaN. `HbGpuRenderer.setSpread` clamps that back to 0, so the
      // shipped path survives it; the IR would not, and `readGlyphs` would hand every other
      // `GlyphPass` implementation a NaN to multiply a quad corner by. Zero is what those callers
      // meant.
      floats[at + GLYPHS_SPREAD_OFFSET] = Number.isFinite(run.spreadPx)
        ? run.spreadPx
        : 0;
      // Preserve unknown rather than normalising it to an empty box. The
      // damage planner checks the whole tuple before accepting glyph bounds.
      floats[at + GLYPHS_INK_X_OFFSET] = finiteOrNaN(run.localInkX);
      floats[at + GLYPHS_INK_Y_OFFSET] = finiteOrNaN(run.localInkY);
      floats[at + GLYPHS_INK_WIDTH_OFFSET] = finiteOrNaN(run.localInkWidth);
      floats[at + GLYPHS_INK_HEIGHT_OFFSET] = finiteOrNaN(run.localInkHeight);
      floats[at + GLYPHS_INK_OUTSET_OFFSET] = finiteOrNaN(run.localInkOutset);
      floats.set(
        run.positions.subarray(0, glyphCount * 2),
        at + GLYPHS_HEADER_FLOATS,
      );
      const intAt = intOffsets[index];
      ints[intAt] = glyphCount;
      ints.set(run.slots.subarray(0, glyphCount), intAt + GLYPHS_HEADER_INTS);
      return index;
    },

    pushScreenEffect(command) {
      const index = beginCommand(DRAW_SCREEN_EFFECT, 0, 0, null);
      screenEffects[index] = command;
      return index;
    },

    pushExternalEffect(command) {
      const index = beginCommand(DRAW_EXTERNAL_EFFECT, 0, 0, null);
      externalEffects[index] = command;
      return index;
    },

    pushClipRect(clip) {
      const index = beginCommand(DRAW_CLIP_PUSH, CLIP_FLOATS, 0, null);
      const at = floatOffsets[index];
      floats[at] = clip.x;
      floats[at + 1] = clip.y;
      floats[at + 2] = clip.w;
      floats[at + 3] = clip.h;
      floats[at + 4] = clip.cornerRadius;
      floats[at + 5] = clip.outsetX;
      clipDepth += 1;
      if (clipDepth > maxClipDepth) maxClipDepth = clipDepth;
      return index;
    },

    popClip() {
      if (clipDepth === 0) {
        throw new RangeError("draw-list popClip() with no clip rect pushed");
      }
      const index = beginCommand(DRAW_CLIP_POP, 0, 0, null);
      clipDepth -= 1;
      return index;
    },

    readQuad(index, out) {
      requireKind(index, DRAW_QUAD);
      readQuadPayload(out, floatOffsets[index]);
      readQuadInts(out, intOffsets[index]);
      return out;
    },

    readNinePatch(index, out) {
      requireKind(index, DRAW_NINE_PATCH);
      const at = floatOffsets[index];
      readQuadPayload(out, at);
      out.marginLeft = floats[at + QUAD_FLOATS];
      out.marginTop = floats[at + QUAD_FLOATS + 1];
      out.marginRight = floats[at + QUAD_FLOATS + 2];
      out.marginBottom = floats[at + QUAD_FLOATS + 3];
      readQuadInts(out, intOffsets[index]);
      return out;
    },

    readPolyline(index, out) {
      requireKind(index, DRAW_POLYLINE);
      const at = floatOffsets[index];
      out.width = floats[at];
      out.r = floats[at + 1];
      out.g = floats[at + 2];
      out.b = floats[at + 3];
      out.a = floats[at + 4];
      const pointCount = ints[intOffsets[index]];
      out.pointCount = pointCount;
      if (out.points.length < pointCount * 2) {
        out.points = new Float32Array(pointCount * 2);
      }
      const from = at + POLYLINE_HEADER_FLOATS;
      out.points.set(floats.subarray(from, from + pointCount * 2));
      return out;
    },

    readTexturedMesh(index, out) {
      requireTexturedMesh(index);
      const at = floatOffsets[index];
      const intAt = intOffsets[index];
      const vertexCount = ints[intAt];
      const indexCount = ints[intAt + 1];
      for (let i = 0; i < 6; i += 1) out.m[i] = floats[at + i];
      out.r = floats[at + 6];
      out.g = floats[at + 7];
      out.b = floats[at + 8];
      out.a = floats[at + 9];
      out.vertexCount = vertexCount;
      out.indexCount = indexCount;
      out.blend = ints[intAt + 2] as BlendMode;
      if (out.positions.length < vertexCount * 2) {
        out.positions = new Float32Array(vertexCount * 2);
      }
      if (out.uvs.length < vertexCount * 2) {
        out.uvs = new Float32Array(vertexCount * 2);
      }
      if (out.indices.length < indexCount) {
        out.indices = new Uint32Array(indexCount);
      }
      const positionsAt = at + TEXTURED_MESH_HEADER_FLOATS;
      for (let i = 0; i < vertexCount * 2; i += 1) {
        out.positions[i] = floats[positionsAt + i];
        out.uvs[i] = floats[positionsAt + vertexCount * 2 + i];
      }
      for (let i = 0; i < indexCount; i += 1) {
        out.indices[i] = ints[intAt + TEXTURED_MESH_HEADER_INTS + i];
      }
      return out;
    },

    readGlyphs(index, out) {
      requireKind(index, DRAW_GLYPHS);
      const at = floatOffsets[index];
      out.m[0] = floats[at];
      out.m[1] = floats[at + 1];
      out.m[2] = floats[at + 2];
      out.m[3] = floats[at + 3];
      out.m[4] = floats[at + 4];
      out.m[5] = floats[at + 5];
      out.pixelsPerEm = floats[at + 6];
      out.r = floats[at + 7];
      out.g = floats[at + 8];
      out.b = floats[at + 9];
      out.a = floats[at + 10];
      out.spreadPx = floats[at + GLYPHS_SPREAD_OFFSET];
      out.localInkX = floats[at + GLYPHS_INK_X_OFFSET];
      out.localInkY = floats[at + GLYPHS_INK_Y_OFFSET];
      out.localInkWidth = floats[at + GLYPHS_INK_WIDTH_OFFSET];
      out.localInkHeight = floats[at + GLYPHS_INK_HEIGHT_OFFSET];
      out.localInkOutset = floats[at + GLYPHS_INK_OUTSET_OFFSET];
      const intAt = intOffsets[index];
      const glyphCount = ints[intAt];
      out.glyphCount = glyphCount;
      if (out.slots.length < glyphCount) out.slots = new Int32Array(glyphCount);
      if (out.positions.length < glyphCount * 2) {
        out.positions = new Float32Array(glyphCount * 2);
      }
      out.slots.set(
        ints.subarray(intAt + GLYPHS_HEADER_INTS, intAt + 1 + glyphCount),
      );
      const from = at + GLYPHS_HEADER_FLOATS;
      out.positions.set(floats.subarray(from, from + glyphCount * 2));
      return out;
    },

    readClipRect(index, out) {
      requireKind(index, DRAW_CLIP_PUSH);
      const at = floatOffsets[index];
      out.x = floats[at];
      out.y = floats[at + 1];
      out.w = floats[at + 2];
      out.h = floats[at + 3];
      out.cornerRadius = floats[at + 4];
      out.outsetX = floats[at + 5];
      return out;
    },

    // The patch pair writes the same float slots `writeQuadPayload` does, and
    // touches nothing else: the ints (blend, flags, the colour-matrix INDEX) are
    // structural — a batch breaks on them — and `colorMatrices` is append-only,
    // so a patched command keeps whatever matrix it was pushed with.

    patchQuadTransform(index, m) {
      requireQuadLike(index);
      if (m.length < 6) {
        throw new RangeError(
          `draw-list patchQuadTransform needs 6 transform entries, got ${m.length}`,
        );
      }
      const at = floatOffsets[index];
      floats[at] = m[0];
      floats[at + 1] = m[1];
      floats[at + 2] = m[2];
      floats[at + 3] = m[3];
      floats[at + 4] = m[4];
      floats[at + 5] = m[5];
      markPatched(index);
    },

    patchQuadColor(index, r, g, b, a) {
      requireQuadLike(index);
      const at = floatOffsets[index];
      floats[at + 12] = r;
      floats[at + 13] = g;
      floats[at + 14] = b;
      floats[at + 15] = a;
      markPatched(index);
    },

    patchQuadSource(index, texture, srcX, srcY, srcW, srcH) {
      requireQuadLike(index);
      const at = floatOffsets[index];
      textures[index] = texture;
      floats[at + 8] = srcX;
      floats[at + 9] = srcY;
      floats[at + 10] = srcW;
      floats[at + 11] = srcH;
      markPatched(index);
    },

    patchTexturedMeshPositions(index, positions) {
      requireTexturedMesh(index);
      const intAt = intOffsets[index];
      const vertexCount = ints[intAt];
      if (positions.length < vertexCount * 2) {
        throw new RangeError(
          `textured mesh position patch needs ${vertexCount * 2} entries, got ${positions.length}`,
        );
      }
      const at = floatOffsets[index] + TEXTURED_MESH_HEADER_FLOATS;
      for (let i = 0; i < vertexCount * 2; i += 1) {
        floats[at + i] = positions[i];
      }
      markPatched(index);
    },

    patchTexturedMeshUvs(index, uvs) {
      requireTexturedMesh(index);
      const intAt = intOffsets[index];
      const vertexCount = ints[intAt];
      if (uvs.length < vertexCount * 2) {
        throw new RangeError(
          `textured mesh UV patch needs ${vertexCount * 2} entries, got ${uvs.length}`,
        );
      }
      const at =
        floatOffsets[index] + TEXTURED_MESH_HEADER_FLOATS + vertexCount * 2;
      for (let i = 0; i < vertexCount * 2; i += 1) {
        floats[at + i] = uvs[i];
      }
      markPatched(index);
    },

    patchTexturedMeshSource(index, texture) {
      requireTexturedMesh(index);
      textures[index] = texture;
      markPatched(index);
    },

    patchTexturedMeshTransform(index, m) {
      requireTexturedMesh(index);
      if (m.length < 6) {
        throw new RangeError(
          `draw-list patchTexturedMeshTransform needs 6 transform entries, got ${m.length}`,
        );
      }
      const at = floatOffsets[index];
      for (let i = 0; i < 6; i += 1) floats[at + i] = m[i];
      markPatched(index);
    },

    patchTexturedMeshColor(index, r, g, b, a) {
      requireTexturedMesh(index);
      const at = floatOffsets[index];
      floats[at + 6] = r;
      floats[at + 7] = g;
      floats[at + 8] = b;
      floats[at + 9] = a;
      markPatched(index);
    },

    patchGlyphsTransform(index, m) {
      requireKind(index, DRAW_GLYPHS);
      if (m.length < 6) {
        throw new RangeError(
          `draw-list patchGlyphsTransform needs 6 transform entries, got ${m.length}`,
        );
      }
      const at = floatOffsets[index];
      floats[at] = m[0];
      floats[at + 1] = m[1];
      floats[at + 2] = m[2];
      floats[at + 3] = m[3];
      floats[at + 4] = m[4];
      floats[at + 5] = m[5];
      markPatched(index);
    },

    patchGlyphsColor(index, r, g, b, a) {
      requireKind(index, DRAW_GLYPHS);
      const at = floatOffsets[index];
      floats[at + 7] = r;
      floats[at + 8] = g;
      floats[at + 9] = b;
      floats[at + 10] = a;
      markPatched(index);
    },
  };
}
