// Pure helpers over the gate 4 fixture's expected.json (render-stream-gate4-expected/1) and the
// glyph oracle's lines (render-stream-gate4-glyphs/1) -- no file or network I/O, no Godot, no
// capture evidence. See ../../protocol/gate4-design.md "Q6c" and "Q6d".
//
// Outside the text regions every gate 4 pixel is an opaque add_rect on the 0.2 grid (the clear
// colour, the panel P and the marker), so synthesizeGate4 is exact there; a text region is
// whatever the glyphs paint and is masked out (G4b adds synthesizeText for D8's ink).

/** [x, y, w, h] in root-canvas pixels. */
export type Rect4 = [number, number, number, number];
/** [x0, y0, x1, y1): half-open, integer. */
export type Box4 = [number, number, number, number];
export type Rgba8 = [number, number, number, number];

export interface Gate4TextState {
  text: string;
  font_key: string;
  size: number;
  /** font colour, floats */
  colour: [number, number, number, number];
  visible: boolean;
  position: [number, number];
}

export interface Gate4ExpectedStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  marker_rgba8: Rgba8;
  texts: Record<string, Gate4TextState>;
  /** the visible text nodes this step redraws, in draw order */
  draws: string[];
  ink_glyphs: Record<string, number>;
  /** per cache key "<font>@<size>": the codepoints first rasterized at this step, in order */
  new_glyphs: Record<string, string>;
  page_uploads: Record<string, number>;
  page_creates: Record<string, number>;
  /** per cache key: the page's hook version after this step (the version the wire publishes) */
  hook_versions: Record<string, number>;
  wire_versions: Record<string, number>;
  /** per cache key: distinct glyphs rasterized so far */
  page_glyphs: Record<string, number>;
  page_counts: Record<string, number>;
  text_regions: Record<string, Box4>;
  background: Record<string, Rgba8>;
  /** whether the node's region must differ from the previous step's */
  fresh: Record<string, boolean>;
}

export interface Gate4Prediction {
  frame: number;
  op?: string;
  steps: number[];
  /** per cache key, the steps at which atlas-hash-parity must fail */
  atlas_hash_parity_fails?: Record<string, number[]>;
}

export interface Gate4Expected {
  schema: "render-stream-gate4-expected/1";
  fixture: string;
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  last_step: number;
  early_shot_steps: number[];
  creation_order: string[];
  created_later: { name: string; step: number }[];
  text_nodes: string[];
  fonts: Record<string, { file: string; kind: string; sizes: number[] }>;
  cache_keys: string[];
  page: {
    format: string;
    width: number;
    height: number;
    mipmaps: boolean;
    data_bytes: number;
    empty_texel: number[];
  };
  panel: { rect: Rect4; rgba8: Rgba8 };
  marker_rect: Rect4;
  regions: Record<string, Rect4>;
  backgrounds: Record<string, Rgba8>;
  engine_textures: {
    frame: number;
    op: string;
    format: string;
    width: number;
    height: number;
  }[];
  quiet_steps: number[];
  hook_versions_total: Record<string, number>;
  hand_table: Record<
    string,
    {
      ink_glyphs: Record<string, number>;
      new_f16: string;
      f16_uploads: number | "create";
      other_pages: Record<string, number | "create">;
    }
  >;
  steps: Gate4ExpectedStep[];
  predictions: Record<string, Gate4Prediction>;
}

/** One glyph command as the oracle computes it (item space). */
export interface OracleGlyph {
  index: number;
  font_key: string;
  size: number;
  /** pen + offset before the floor */
  x: number;
  y: number;
  quad: Rect4;
  uv: Rect4;
  page: number;
}

export interface OracleNode {
  name: string;
  text: string;
  font_key: string;
  size: number;
  colour: [number, number, number, number];
  global_xform: number[];
  font_height: number;
  ascent: number;
  lines: number;
  shaped_glyphs: number;
  glyphs: OracleGlyph[];
}

export interface OraclePage {
  font_key: string;
  size: number;
  outline: number;
  index: number;
  width: number;
  height: number;
  format: string;
  mipmaps: boolean;
  data_bytes: number;
  sha256: string;
}

export interface OracleLine {
  schema: "render-stream-gate4-glyphs/1";
  step: number;
  frame: number;
  nodes: OracleNode[];
  pages: OraclePage[];
}

/** "<font>@<size>" for a cache, "<font>@<size>/<outline>#<index>" for one of its pages. */
export function cacheKeyOf(p: { font_key: string; size: number }): string {
  return `${p.font_key}@${p.size}`;
}

export function pageKeyOf(p: OraclePage): string {
  return `${p.font_key}@${p.size}/${p.outline}#${p.index}`;
}

export interface SynthesizedFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Step k's applied frame (step 0 is the `_ready` state, frame 1) and settle frame. */
export function stepFrames4(
  expected: Pick<
    Gate4Expected,
    "start_frame_default" | "step_frames_default" | "settle_offset"
  >,
  step: number,
): { applied: number; settle: number; early: number } {
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  return {
    applied: step === 0 ? 1 : S + N * step,
    settle: S + N * step + expected.settle_offset,
    early: S + N * step + 1,
  };
}

/** The step whose window [applied_k, applied_{k+1}) holds `frame` (the last step runs through
 * `quit`), or -1 outside every window. */
export function stepOfFrame4(
  expected: Gate4Expected,
  frame: number,
  quit: number,
): number {
  if (frame < 1 || frame > quit) return -1;
  let found = -1;
  for (const s of expected.steps)
    if (stepFrames4(expected, s.step).applied <= frame) found = s.step;
  return found;
}

function stepOf(expected: Gate4Expected, step: number): Gate4ExpectedStep {
  const found = expected.steps.find((s) => s.step === step);
  if (!found)
    throw new Error(`gate4-expected: no step ${step} in expected.json`);
  return found;
}

/**
 * The expected RGBA frame for one step outside the text regions: the clear colour, the panel and
 * the marker in its step colour. `mask` is 1 for every pixel inside a text region (whose content
 * the glyphs decide and this synthesis does not).
 */
export function synthesizeGate4(
  expected: Gate4Expected,
  step: number,
): SynthesizedFrame & { mask: Uint8Array } {
  const [width, height] = expected.viewport;
  const rgba = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++)
    rgba.set(expected.clear_rgba8, i * 4);
  const fill = (r: Rect4, c: Rgba8) => {
    for (let y = Math.max(0, r[1]); y < Math.min(height, r[1] + r[3]); y++)
      for (let x = Math.max(0, r[0]); x < Math.min(width, r[0] + r[2]); x++)
        rgba.set(c, (y * width + x) * 4);
  };
  const s = stepOf(expected, step);
  fill(expected.panel.rect, expected.panel.rgba8);
  fill(expected.marker_rect, s.marker_rgba8);
  for (const box of Object.values(s.text_regions))
    for (let y = box[1]; y < box[3]; y++)
      for (let x = box[0]; x < box[2]; x++) mask[y * width + x] = 1;
  return { width, height, rgba, mask };
}

/** Pixels differing from `background` inside `box` of an RGBA frame. */
export function inkPixels(
  frame: { width: number; rgba: Uint8Array },
  box: Box4,
  background: Rgba8,
): number {
  let n = 0;
  for (let y = box[1]; y < box[3]; y++)
    for (let x = box[0]; x < box[2]; x++) {
      const i = (y * frame.width + x) * 4;
      if (
        frame.rgba[i] !== background[0] ||
        frame.rgba[i + 1] !== background[1] ||
        frame.rgba[i + 2] !== background[2] ||
        frame.rgba[i + 3] !== background[3]
      )
        n++;
    }
  return n;
}

/** Whether two frames agree everywhere inside `box`. */
export function boxEqual(
  a: { width: number; rgba: Uint8Array },
  b: { width: number; rgba: Uint8Array },
  box: Box4,
): boolean {
  for (let y = box[1]; y < box[3]; y++) {
    const i0 = (y * a.width + box[0]) * 4;
    const i1 = (y * a.width + box[2]) * 4;
    for (let i = i0; i < i1; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  }
  return true;
}

/** Non-space codepoints of a single-line Latin string: its ink glyphs (Q6b). */
export function inkCodepoints(text: string): string[] {
  return [...text].filter((c) => !/\s/u.test(c));
}

/**
 * gate4-design.md Q1c's rules over expected.json's own texts and draws, independently of
 * make_expected.py: a draw of a visible Label that introduces codepoints into its cache uploads
 * that page once (the first upload creates it). Returns per step the new glyphs, uploads,
 * creates and hook versions per cache key, and each node's ink glyph count.
 */
export function deriveCensus(expected: Gate4Expected): {
  new_glyphs: Record<string, string>;
  page_uploads: Record<string, number>;
  page_creates: Record<string, number>;
  hook_versions: Record<string, number>;
  ink_glyphs: Record<string, number>;
}[] {
  const have = new Map<string, Set<string>>();
  const versions: Record<string, number> = {};
  const out = [];
  for (const s of expected.steps) {
    const new_glyphs: Record<string, string> = {};
    const page_uploads: Record<string, number> = {};
    const page_creates: Record<string, number> = {};
    for (const node of s.draws) {
      const t = s.texts[node];
      if (!t.visible) continue;
      const key = cacheKeyOf(t);
      const set = have.get(key) ?? new Set<string>();
      const fresh = inkCodepoints(t.text).filter(
        (c, i, all) => !set.has(c) && all.indexOf(c) === i,
      );
      if (fresh.length === 0) continue;
      const created = have.has(key);
      for (const c of fresh) set.add(c);
      have.set(key, set);
      new_glyphs[key] = (new_glyphs[key] ?? "") + fresh.join("");
      versions[key] = (versions[key] ?? 0) + 1;
      if (created) page_uploads[key] = (page_uploads[key] ?? 0) + 1;
      else page_creates[key] = 1;
    }
    const ink_glyphs: Record<string, number> = {};
    for (const [name, t] of Object.entries(s.texts))
      ink_glyphs[name] = t.visible ? inkCodepoints(t.text).length : 0;
    out.push({
      new_glyphs,
      page_uploads,
      page_creates,
      hook_versions: { ...versions },
      ink_glyphs,
    });
  }
  return out;
}

/** Texel indices where `next` differs from `prev`, each with whether `prev` was empty there
 * (`empty` the format's empty texel, e.g. LA8 [255, 0]). Both are raw image data of one shape. */
export function appendOnlyViolations(
  prev: Uint8Array,
  next: Uint8Array,
  empty: readonly number[],
): { changed: number; violations: number[] } {
  const px = empty.length;
  const violations: number[] = [];
  let changed = 0;
  if (prev.length !== next.length) return { changed: -1, violations: [-1] };
  for (let t = 0; t * px < prev.length; t++) {
    let differs = false;
    let wasEmpty = true;
    for (let c = 0; c < px; c++) {
      if (prev[t * px + c] !== next[t * px + c]) differs = true;
      if (prev[t * px + c] !== empty[c]) wasEmpty = false;
    }
    if (!differs) continue;
    changed++;
    if (!wasEmpty) violations.push(t);
  }
  return { changed, violations };
}
