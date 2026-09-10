// HOW BIG THE OVERLAY CANVAS HAS TO BE — the whole sizing law for a particle system, in one pure
// module (no DOM, no GL, no clock), so `./runtime` can size a canvas without re-deriving it and a
// unit test can pin it.
//
// A particle system's node box says almost nothing about where its pixels land: a `GPUParticles2D`
// is a POINT (a zero-size box), and the spray happens entirely outside it. So the canvas is the box
// grown by a MARGIN on each side, and the margin is this module's subject.
//
// THE MARGIN USED TO BE ONE SYMMETRIC NUMBER: `spriteExtentPad + emissionExtentPad`, i.e. how big
// one sprite is plus how far apart they are BORN. That is the whole of it — it models no movement
// at all, so every system got a square canvas centred on its node origin, and anything that
// TRAVELS was cropped at the square's edge. The visible symptom this was written for: a chest's
// gold-coin burst (a ~700px square canvas over particles that fly ~1200px sideways and fall ~2500px)
// looked as if a rectangle had been cut out of the screen.
//
// SO THE MARGIN IS NOW FOUR NUMBERS, one per side, and it includes a BALLISTIC TRAVEL term derived
// from the same fields `./simulate` integrates: initial velocity over the direction/spread arc,
// gravity, linear/radial/tangential acceleration, damping, orbit, and the lifetime the whole thing
// runs for. Two rules keep it honest:
//
//   * CONSERVATIVE, NOT EXACT. Every term is an upper bound of the real integral — the arc maxima
//     are per-axis, the position-dependent forces (radial/tangential) are treated as isotropic, and
//     an orbit is treated as "any reach on one axis can appear on any other" (it rotates the whole
//     position vector about the origin, so it genuinely can). Being generous costs canvas pixels;
//     being tight costs a visible crop, which is the bug.
//   * IT CAN ONLY GROW. The final margin is floored at the symmetric pad it replaces, so no system
//     ever gets a SMALLER canvas than it had before this existed, whatever the travel math or the
//     visible-rect clamp say. That is what makes the change safe to default on: the failure mode of
//     a wrong number here is "wasted pixels", never "cropped pixels".
//
// AND THE PIXELS ARE CAPPED BY WHAT CAN BE SEEN. Travel bounds alone are unbounded in principle (a
// 2.5s fall under gravity 800 is 2500px), so a host that knows which part of the element's own local
// space is actually on screen passes it in (`ParticleLocalRect` → `visibleAllowance`) and the margin
// is clamped to that. Without one the margin is capped at `PAD_CAP` per side, exactly as before.

import type { ParticleTextureHandle } from "./render-backend";
import type { ParticleSpecConfig } from "./spec";

// Sprite size (px) for an untextured system (soft round dot), pre-scale.
const DEFAULT_DOT = 16;

/** Upper bound on the per-side canvas margin, so a pathological scale/texture/travel can't allocate
 *  an enormous canvas. Applies to every side independently, so the worst-case canvas is the node box
 *  plus `2 * PAD_CAP` on each axis — the same worst case the symmetric pad always had. */
export const PAD_CAP = 1024;

const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** Per-side canvas margin in CSS px, measured OUTWARD from the node box's corresponding edge. All
 *  four are >= 0. `left`/`top` are also the draw's origin offset (see `./runtime`'s `packBinding`). */
export interface ParticleExtents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A rect in the element's OWN local CSS px space — the space the node box lives in, so `{x: 0, y: 0}`
 *  is the box's top-left corner and the axes are the node's local axes (pre-transform: an ancestor
 *  scale/rotation does not enter here, because the canvas is drawn inside that transform). */
export interface ParticleLocalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ZERO_EXTENTS: ParticleExtents = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

// A `flipbookCropOnly` sheet keeps the FULL texture size: its grid comes from a SHADER that
// only crops UV, so Godot draws the quad undivided and magnifies one cell over it (config.ts).
export function frameSize(
  cfg: ParticleSpecConfig,
  texture: ParticleTextureHandle | null,
): { frameW: number; frameH: number } {
  const texW =
    cfg.textureWidth > 0 ? cfg.textureWidth : (texture?.width ?? DEFAULT_DOT);
  const texH =
    cfg.textureHeight > 0
      ? cfg.textureHeight
      : (texture?.height ?? DEFAULT_DOT);
  if (cfg.flipbookCropOnly) {
    return { frameW: texW, frameH: texH };
  }
  return { frameW: texW / cfg.hframes, frameH: texH / cfg.vframes };
}

// The largest value a scale curve reaches (default 1 when there is no curve), so the
// canvas margin accounts for scale-over-life that grows the sprite past its base size.
function curveMax(points: { y: number }[] | undefined): number {
  if (!points || points.length === 0) return 1;
  let max = 0;
  for (const point of points) if (point.y > max) max = point.y;
  return max > 0 ? max : 1;
}

// Half-extent (px) a particle sprite can reach beyond the emitter box, so the overlay
// canvas can be grown to contain it instead of clipping it to the (often tiny) node
// box. Uses the diagonal so it's correct under any rotation, and the max base scale ×
// the scale-curve peak. Pure (no DOM/GL) — unit-tested.
export function spriteExtentPad(
  cfg: ParticleSpecConfig,
  texture: ParticleTextureHandle | null,
): number {
  const { frameW, frameH } = frameSize(cfg, texture);
  const scaleMax = Math.max(cfg.scaleMin, cfg.scaleMax);
  const curvePeak = Math.max(
    curveMax(cfg.scaleCurveX ?? cfg.scaleCurve),
    curveMax(cfg.scaleCurveY ?? cfg.scaleCurve),
  );
  const half = (scaleMax * curvePeak * Math.hypot(frameW, frameH)) / 2;
  return Math.min(PAD_CAP, Math.max(0, Math.ceil(half)));
}

// The emission shape's reach from the shape's own centre, per axis, BEFORE the shape offset.
// Mirrors `sampleEmission` in `./simulate` (extents x scale; ring treated as its outer radius).
function emissionReach(cfg: ParticleSpecConfig): { x: number; y: number } {
  switch (cfg.emissionShape) {
    case 3: // box
      return {
        x: Math.abs(cfg.emissionBoxExtents[0] * cfg.emissionScale[0]),
        y: Math.abs(cfg.emissionBoxExtents[1] * cfg.emissionScale[1]),
      };
    case 1: // sphere (disk)
    case 2: // sphere surface (ring)
    case 6: {
      // ring
      const r = Math.max(cfg.emissionSphereRadius, cfg.emissionRingRadius);
      return {
        x: r * Math.abs(cfg.emissionScale[0]),
        y: r * Math.abs(cfg.emissionScale[1]),
      };
    }
    default: // 0 point / 4 points -> no spread
      return { x: 0, y: 0 };
  }
}

// Half-extent (px) the EMISSION SHAPE reaches from the node origin, so the overlay canvas
// is grown to contain particles spawned ACROSS a box/sphere/ring (not just at a point).
// Added to `spriteExtentPad` in `syncCanvasSize`: without it a tiny sprite with a large
// emission area (e.g. the card-sparkles box ~120x170) would be clipped to a small canvas.
// Mirrors `sampleEmission` in `./simulate` (extents x scale, plus the shape offset). Pure
// (no DOM/GL) — unit-tested.
//
// SYMMETRIC, and kept exactly as it was: it is the FLOOR the directional law can never go below
// (see `particleCanvasExtents`), so the old number has to stay computable.
export function emissionExtentPad(cfg: ParticleSpecConfig): number {
  const reach = emissionReach(cfg);
  const half = Math.max(
    Math.abs(cfg.emissionOffset[0]) + reach.x,
    Math.abs(cfg.emissionOffset[1]) + reach.y,
  );
  return Math.min(PAD_CAP, Math.max(0, Math.ceil(half)));
}

/** The emission shape's reach from the NODE ORIGIN, per side: the shape's own half-extents about
 *  its (possibly offset) centre. An offset shape reaches further on one side than the other, which
 *  the symmetric `emissionExtentPad` had to round up to the larger of the two. Pure. */
export function emissionExtents(cfg: ParticleSpecConfig): ParticleExtents {
  const reach = emissionReach(cfg);
  const ox = cfg.emissionOffset[0];
  const oy = cfg.emissionOffset[1];
  return {
    left: Math.max(0, reach.x - ox),
    right: Math.max(0, reach.x + ox),
    top: Math.max(0, reach.y - oy),
    bottom: Math.max(0, reach.y + oy),
  };
}

// The maximum of cos(theta - phi) over theta in [a, b] — i.e. how far a unit vector confined to
// that arc can reach along the +phi axis. 1 when the arc CONTAINS phi (the peak is inside), else
// whichever endpoint is closer to it. The workhorse behind the four per-axis maxima below.
function maxCosOverArc(a: number, b: number, phi: number): number {
  if (b - a >= TAU) return 1;
  // Where phi sits inside the arc, measured from `a` and wrapped into [0, TAU).
  let offset = (phi - a) % TAU;
  if (offset < 0) offset += TAU;
  if (offset <= b - a) return 1;
  return Math.max(Math.cos(a - phi), Math.cos(b - phi));
}

// A projection factor below this is TAKEN AS ZERO. `Math.cos(Math.PI / 2)` is 6.1e-17, not 0, so an
// axis-aligned emitter — much the commonest kind — reaches its two PERPENDICULAR sides by ~1e-14px,
// which `resolveSide`'s `Math.ceil` then rounds up to a whole wasted pixel of canvas per side (and
// splits `padX` from `padY` in the frozen-frame key for no reason). The threshold is ~13 orders of
// magnitude above that noise and ~10 below any projection a real spread produces, so it can only
// ever discard the noise: at this factor even a 1,000,000 px/s·s travel term contributes 1e-6 px.
const AXIS_EPSILON = 1e-12;

// Per-side maxima of a UNIT vector whose angle is confined to [a, b], in screen axes (+x right,
// +y DOWN — Godot 2D's convention, which is also CSS's). Each is clamped at 0: an arc that cannot
// reach a side at all contributes nothing to it rather than a negative margin.
function arcAxisMaxima(a: number, b: number): ParticleExtents {
  return {
    right: axisMax(maxCosOverArc(a, b, 0)),
    left: axisMax(maxCosOverArc(a, b, Math.PI)),
    bottom: axisMax(maxCosOverArc(a, b, Math.PI / 2)),
    top: axisMax(maxCosOverArc(a, b, -Math.PI / 2)),
  };
}

function axisMax(value: number): number {
  return value > AXIS_EPSILON ? value : 0;
}

function maxAbs(a: number, b: number): number {
  return Math.max(Math.abs(a), Math.abs(b));
}

// How far an initial speed `v0` can travel in `t` seconds under Godot's damping (`./simulate`'s
// `integrate`), using the SMALLEST damping any particle in the system can draw — the one that
// travels furthest. Damping only ever REMOVES speed, so ignoring it would also be a valid bound;
// folding it in just makes the bound tighter (and the canvas smaller) for the systems that use it.
function dampedDistance(
  v0: number,
  t: number,
  damping: number,
  asFriction: boolean,
): number {
  if (v0 <= 0 || t <= 0) return 0;
  if (damping <= 0) return v0 * t;
  if (asFriction) {
    // dec = cur * damping * 0.05 * dt  ⇒  exponential decay at rate k.
    const k = damping * 0.05;
    return (v0 / k) * (1 - Math.exp(-k * t));
  }
  // dec = damping * dt ⇒ linear decay to a full stop at v0/damping.
  const stop = v0 / damping;
  const te = Math.min(t, stop);
  return v0 * te - 0.5 * damping * te * te;
}

/**
 * The BALLISTIC TRAVEL bound: how far, per side, a particle's POSITION can get from where it was
 * born, over one full lifetime. Pure, closed-form (this runs once per system, not per frame) and
 * deliberately an over-estimate — see the module header.
 *
 * The terms, each mapped onto the sides it can actually push toward:
 *   * INITIAL VELOCITY over the `direction` ± `spread` arc, damped (`dampedDistance`).
 *   * GRAVITY — a fixed vector, so `0.5 * g * t^2` lands on exactly one side per axis.
 *   * LINEAR ACCEL — along the velocity, i.e. inside the same arc (a NEGATIVE one along the
 *     REVERSED arc, since it can flip the particle around).
 *   * RADIAL + TANGENTIAL ACCEL — both point along/across the particle's own position vector, which
 *     can be anywhere, so they are added ISOTROPICALLY to all four sides.
 *
 * `lifetimeRandomness` is not folded in: Godot draws `lifetime * (1 - rand * randomness)`, so it
 * only ever SHORTENS a particle's life. Nor is `speedScale`, which scales the sim's clock and not
 * its distances — a particle still dies after `lifetime` seconds of its OWN time, having covered
 * the same ground faster or slower.
 */
export function travelExtents(cfg: ParticleSpecConfig): ParticleExtents {
  const t = Math.max(0, cfg.lifetime);
  if (!(t > 0)) return { ...ZERO_EXTENTS };
  const halfTT = 0.5 * t * t;

  // The spawn arc. `atan2(0, 0)` is 0, i.e. a zero `direction` reads as +x — which is what
  // `./simulate`'s `restartParticle` does with it too.
  const dir = Math.atan2(cfg.direction[1], cfg.direction[0]);
  const spread = Math.min(180, Math.abs(cfg.spread)) * DEG2RAD;
  const arc = arcAxisMaxima(dir - spread, dir + spread);
  const back = arcAxisMaxima(dir - spread + Math.PI, dir + spread + Math.PI);

  const v0 = maxAbs(cfg.initialVelocityMin, cfg.initialVelocityMax);
  const damping = Math.max(0, Math.min(cfg.dampingMin, cfg.dampingMax));
  const speedDist = dampedDistance(v0, t, damping, cfg.dampingAsFriction);

  const accelFwd = Math.max(0, cfg.linearAccelMax) * halfTT;
  const accelBack = Math.max(0, -cfg.linearAccelMin) * halfTT;

  const isotropic =
    (maxAbs(cfg.radialAccelMin, cfg.radialAccelMax) +
      maxAbs(cfg.tangentialAccelMin, cfg.tangentialAccelMax)) *
    halfTT;

  const gx = cfg.gravity[0] * halfTT;
  const gy = cfg.gravity[1] * halfTT;

  return {
    left:
      arc.left * speedDist +
      arc.left * accelFwd +
      back.left * accelBack +
      Math.max(0, -gx) +
      isotropic,
    right:
      arc.right * speedDist +
      arc.right * accelFwd +
      back.right * accelBack +
      Math.max(0, gx) +
      isotropic,
    top:
      arc.top * speedDist +
      arc.top * accelFwd +
      back.top * accelBack +
      Math.max(0, -gy) +
      isotropic,
    bottom:
      arc.bottom * speedDist +
      arc.bottom * accelFwd +
      back.bottom * accelBack +
      Math.max(0, gy) +
      isotropic,
  };
}

/**
 * Turn a host-supplied VISIBLE RECT (in the element's own local px space) into the per-side margin
 * it allows, given where the node box sits inside that space. Pure.
 *
 * The canvas spans `[boxOffsetX - left, boxOffsetX + boxW + right]` horizontally (see
 * `measureCanvasGeometry`), so "stay inside the visible rect" is one subtraction per side. A
 * negative result (the box is entirely off the visible rect on that side) clamps to 0.
 */
export function visibleAllowance(
  rect: ParticleLocalRect,
  box: { width: number; height: number; offsetX: number; offsetY: number },
): ParticleExtents {
  return {
    left: Math.max(0, box.offsetX - rect.x),
    right: Math.max(0, rect.x + rect.width - box.offsetX - box.width),
    top: Math.max(0, box.offsetY - rect.y),
    bottom: Math.max(0, rect.y + rect.height - box.offsetY - box.height),
  };
}

/**
 * THE SIZING LAW: the per-side canvas margin for one system. Pure.
 *
 * `allowance` is the visible-rect budget (`visibleAllowance`) or null when the host has not said
 * what can be seen — in which case the only ceiling is `PAD_CAP`, which is what this always had.
 *
 * The floor is the SYMMETRIC pad this replaces (`spriteExtentPad + emissionExtentPad`, capped), so
 * the result is never smaller than the canvas the same system got before directional extents
 * existed — including when the allowance is tiny or zero.
 */
export function particleCanvasExtents(
  cfg: ParticleSpecConfig,
  texture: ParticleTextureHandle | null,
  allowance: ParticleExtents | null,
): ParticleExtents {
  const sprite = spriteExtentPad(cfg, texture);
  const floor = Math.min(PAD_CAP, sprite + emissionExtentPad(cfg));
  const emission = emissionExtents(cfg);
  const travel = travelExtents(cfg);

  let left = emission.left + travel.left + sprite;
  let right = emission.right + travel.right + sprite;
  let top = emission.top + travel.top + sprite;
  let bottom = emission.bottom + travel.bottom + sprite;

  // ORBIT rotates the whole position vector about the node origin at `orbit` revolutions/second
  // (`./simulate`'s `integrate`), preserving its length — so over a full turn any reach on one axis
  // shows up on every other. Bound it radially: one number, applied to all four sides. Deliberately
  // not "is a full turn reached within the lifetime": a partial turn still sweeps an arc this has
  // no cheap closed form for, and the whole point is to be safely generous.
  if (maxAbs(cfg.orbitVelocityMin, cfg.orbitVelocityMax) > 0) {
    const radial = Math.max(left, right, top, bottom);
    left = radial;
    right = radial;
    top = radial;
    bottom = radial;
  }

  return {
    left: resolveSide(left, floor, allowance?.left),
    right: resolveSide(right, floor, allowance?.right),
    top: resolveSide(top, floor, allowance?.top),
    bottom: resolveSide(bottom, floor, allowance?.bottom),
  };
}

// One side: the computed reach, capped by the visible allowance and by `PAD_CAP`, then floored at
// the symmetric pad so this can only ever GROW a canvas. Integral, because it is a css-px canvas
// coordinate and a fractional one would put the draw origin between pixels.
function resolveSide(
  reach: number,
  floor: number,
  allowance: number | undefined,
): number {
  let side = Math.min(PAD_CAP, Math.max(0, Math.ceil(reach)));
  if (allowance !== undefined) side = Math.min(side, Math.ceil(allowance));
  return Math.max(floor, side);
}

/** The symmetric margin this module replaced, still computed exactly as it was — the shape the
 *  runtime uses when `particleTravelExtents` is off (its kill switch). */
export function symmetricCanvasExtents(
  cfg: ParticleSpecConfig,
  texture: ParticleTextureHandle | null,
): ParticleExtents {
  const pad = Math.min(
    PAD_CAP,
    spriteExtentPad(cfg, texture) + emissionExtentPad(cfg),
  );
  return { left: pad, right: pad, top: pad, bottom: pad };
}

/**
 * Parse a host's `data-godot-particle-visible-rect` attribute: four comma-separated numbers
 * `x,y,width,height` in the element's own local px space. Null for absent/empty/malformed, and for
 * a degenerate (non-positive) size — "nothing is visible" is not a canvas budget any caller wants
 * to act on, and treating it as absent keeps the uncapped-but-`PAD_CAP`ed path.
 */
export function parseLocalVisibleRect(
  attr: string | null,
): ParticleLocalRect | null {
  if (!attr) return null;
  const parts = attr.split(",");
  if (parts.length !== 4) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const width = Number(parts[2]);
  const height = Number(parts[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}
