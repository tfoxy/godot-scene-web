// Static-frame cache for FROZEN particle surfaces — the particle sibling of the shader runtime's
// `staticFrameCache` (`../webgl/runtime.ts`), and it exists for the same reason: in frozen
// (`staticParticles`) mode a system is warmed to a representative state, drawn ONCE, and then never
// touched again, so two systems whose frozen frame is the same bitmap can share ONE render — one
// warm + one instanced GL draw + N cheap 2D blits — instead of paying both per node.
//
// WHY THIS IS SOUND: the CPU simulation in this directory is fully DETERMINISTIC. Every random it
// consumes comes from the seeded MINSTD/Park-Miller LCG in `./simulate` (`randFromSeed` /
// `hash01(i, cfg.seed)`); there is no `Math.random()`, no `Date.now()` and no `performance.now()`
// anywhere under `src/particles/`. `warmStaticParticles` is therefore a pure function of the
// (config, particle-count) pair, and two frozen systems built from the same spec are already
// pixel-identical twins on screen today — deduping them changes nothing visible.
//
// The caller (`./runtime`) is responsible for only consulting this on the path where that purity
// actually holds: a binding whose simulation state is still the deterministic post-create state.
// A system frozen mid-flight (the runtime was LIVE and `setStaticParticles(true)` flipped it) warms
// from whatever phase it happened to be in, which is NOT a function of the config, so the runtime
// marks those bindings non-pristine and never keys them. See `staticFrameKeyFor` there.
//
// Module-scoped and LRU-bounded, like `programCache`/`textureCache`/the shader frame cache: it
// SURVIVES a runtime `dispose()` (a remount/re-render re-uses the frames it already rendered) and
// is never cleared except by eviction (or the test-only reset below).

// Entry-count ceiling, matching the shader runtime's `STATIC_FRAME_CACHE_LIMIT`.
const STATIC_FRAME_CACHE_LIMIT = 64;
// TOTAL backing-store ceiling, in pixels, across all live entries — a DELIBERATE divergence from the
// shader cache, which bounds entry COUNT only. Particle canvases are grown by `pad` on every side and
// a screen-filling ambient emitter is routinely 1500–2048px per edge, so 64 large entries would be
// ~1GB of RGBA on exactly the low-end phones frozen mode exists for. 16M px ≈ 64MB of canvas backing.
const STATIC_FRAME_CACHE_PIXEL_LIMIT = 16 * 1024 * 1024;

// Insertion-ordered (JS `Map`) = LRU order: a read re-inserts (see `getStaticParticleFrame`), so
// `keys().next()` is always the least-recently-used entry.
const staticFrameCache = new Map<string, HTMLCanvasElement>();
// Running sum of `width * height` over `staticFrameCache`, so the pixel ceiling costs no iteration.
let cachedPixels = 0;

/** The BINDING-LIFETIME-CONSTANT half of a frozen frame's identity (see `particleStaticFrameKeyBase`). */
export interface ParticleStaticFrameKeyBase {
  /** The RAW `data-godot-particle-specs` attribute string — never a re-serialization of the parsed
   *  config. A round-trip through `JSON.parse`/`JSON.stringify` would reorder keys and reformat
   *  floats, so two nodes carrying byte-identical attributes could produce different keys. */
  specJson: string;
  /** The EFFECTIVE particle count — `amount` after the runtime's `particleMaxInstances` clamp. NOT
   *  derivable from `specJson`: the clamp is a per-runtime option, and this cache is module-scoped,
   *  so two runtimes configured with different caps share it. */
  count: number;
  /** `CanvasItemMaterial` blend mode (0 mix, 1 add). Part of the key because it changes the CACHED
   *  BITMAP, not merely how that bitmap composites: additive is a whole second pass in
   *  `./render-webgl.ts` (sum raw light into an FBO, then resolve the total to
   *  `(light, peak-coverage)`), so the two modes put different pixels in the canvas for the same
   *  spec. (The node ALSO carries `mix-blend-mode: plus-lighter` under an additive material — see
   *  `../material.ts` — which is a page-level fact this cache never sees.) */
  blendMode: number;
  /** `cfg.seed`. A constant today, and included anyway: if per-node seeds are ever introduced they
   *  must SPLIT the cache instead of silently aliasing one node's spray onto another's. */
  seed: number;
  /** Sprite texture identity. */
  textureUrl: string | null;
  /** Coverage-mask identity (`maskUrl`). Multiplies coverage, so it changes the pixels. */
  maskUrl: string | null;
}

/** The half that MOVES over a binding's life: canvas geometry and the (async) texture dimensions. */
export interface ParticleStaticFrameGeometry {
  /** Canvas backing-store size. EXACT (never quantized): it is geometry — which pixels the frame
   *  covers — and the shader cache carries a precedent comment about a widened-background band bug
   *  caused by quantizing exactly this kind of term. */
  width: number;
  height: number;
  /** The ratio `drawBinding` scales its particle geometry by. EXACT for the same reason: it
   *  multiplies every position and sprite size, so a 1%-different ratio is a different picture.
   *  (It is also not a jittery streamed value — it is `devicePixelRatio × renderScale`, or a pin.) */
  drawRatio: number;
  /** The LEFT and TOP canvas margins, in css px. EXACT: together they ARE the draw's origin offset
   *  inside the canvas (`./runtime`'s `packBinding`), so two frames that differ in either are
   *  different pictures. Both, not one symmetric `pad`, because the margin is directional — see
   *  `./extents`; with `particleTravelExtents` off they are always equal and this key reduces to the
   *  one it replaced with the number repeated. */
  padX: number;
  padY: number;
  /** Per-particle sprite size in px. EXACT (geometry). */
  frameW: number;
  frameH: number;
  /** The sprite texture's CURRENT dimensions — 1x1 while it is still the placeholder, its real size
   *  once decoded (there is no attribute change to hang that transition off, which is why it lives
   *  in the moving half). The runtime refuses to key an unloaded binding at all; this is the belt. */
  textureWidth: number;
  textureHeight: number;
}

// LENGTH-PREFIXED free-form strings. `specJson`, `textureUrl` and `maskUrl` are host-supplied and
// may contain the `|`/`@`/`:` separators, so a plain join could let one field's content impersonate
// the next field's — and an aliased key serves the WRONG bitmap, the one failure mode this cache
// must not have. A length prefix makes each string self-delimiting.
function tagged(value: string | null): string {
  return value === null ? "-1:" : `${value.length}:${value}`;
}

/**
 * The constant prefix of a frozen frame's key, computed ONCE per binding (the shader runtime's
 * `paramsKey` memo, same trick — see `ParticleBinding.staticKeyBase` in `./runtime`). Verbatim:
 *
 *   `${len}:${specJson}|n${count}|b${blendMode}|s${seed}|t${len}:${textureUrl}|k${len}:${maskUrl}`
 */
export function particleStaticFrameKeyBase(
  base: ParticleStaticFrameKeyBase,
): string {
  return (
    `${tagged(base.specJson)}|n${base.count}|b${base.blendMode}|s${base.seed}` +
    `|t${tagged(base.textureUrl)}|k${tagged(base.maskUrl)}`
  );
}

/**
 * The full identity of one frozen particle frame: the memoized base plus the geometry that moves.
 * Verbatim (the whole key, base expanded):
 *
 *   `${len}:${specJson}|n${count}|b${blendMode}|s${seed}|t${len}:${textureUrl}|k${len}:${maskUrl}` +
 *   `|${width}x${height}|r${drawRatio}|p${padX}x${padY}|f${frameW}x${frameH}|@${texW}x${texH}`
 *
 * NOTHING here is quantized. The shader key quantizes its params/modulate because those are
 * per-delta streamed floats that jitter; a particle system has no such term — its only free-form
 * input is the spec ATTRIBUTE STRING (already a stable string, and a change to it re-creates the
 * binding anyway), and everything else in this key is geometry, which the shader key keeps exact too.
 */
export function particleStaticFrameKey(
  base: string,
  geometry: ParticleStaticFrameGeometry,
): string {
  return (
    `${base}|${geometry.width}x${geometry.height}|r${geometry.drawRatio}` +
    `|p${geometry.padX}x${geometry.padY}|f${geometry.frameW}x${geometry.frameH}` +
    `|@${geometry.textureWidth}x${geometry.textureHeight}`
  );
}

/** The cached frame for `key`, or undefined. A hit is bumped to the most-recently-used end. */
export function getStaticParticleFrame(
  key: string,
): HTMLCanvasElement | undefined {
  const hit = staticFrameCache.get(key);
  if (!hit) return undefined;
  staticFrameCache.delete(key);
  staticFrameCache.set(key, hit); // LRU bump
  return hit;
}

/**
 * Snapshot a just-drawn particle canvas into the cache under `key`. The copy is a FRESH canvas, not
 * a reference to the node's own: the node redraws into its canvas on any later resize, which would
 * otherwise mutate the cached frame under every other node reading it.
 *
 * A no-op without a DOM, without a 2D context, or when one frame alone would blow the pixel budget
 * (never evict the whole cache to seat a single giant ambient emitter).
 */
export function storeStaticParticleFrame(
  key: string,
  source: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  if (typeof document === "undefined") return;
  if (width < 1 || height < 1) return;
  const pixels = width * height;
  if (pixels > STATIC_FRAME_CACHE_PIXEL_LIMIT) return;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  const replaced = staticFrameCache.get(key);
  if (replaced) {
    cachedPixels -= replaced.width * replaced.height;
    // `Map.set` on an EXISTING key keeps its original insertion slot, so a re-store would leave the
    // freshest frame sitting at the LRU front — where the eviction loop below could drop it on the
    // very next store. Delete first so it is re-inserted as most-recently-used.
    staticFrameCache.delete(key);
  }
  staticFrameCache.set(key, canvas);
  cachedPixels += pixels;
  while (
    staticFrameCache.size > STATIC_FRAME_CACHE_LIMIT ||
    (cachedPixels > STATIC_FRAME_CACHE_PIXEL_LIMIT && staticFrameCache.size > 1)
  ) {
    const oldest = staticFrameCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = staticFrameCache.get(oldest);
    staticFrameCache.delete(oldest);
    if (evicted) cachedPixels -= evicted.width * evicted.height;
  }
}

/** TEST-ONLY: empty the cache so a test starts cold. */
export function __resetStaticParticleFrameCacheForTest(): void {
  staticFrameCache.clear();
  cachedPixels = 0;
}

/** TEST-ONLY: live entry count + total cached pixels, for the eviction tests. */
export function __staticParticleFrameCacheStatsForTest(): {
  entries: number;
  pixels: number;
} {
  return { entries: staticFrameCache.size, pixels: cachedPixels };
}
