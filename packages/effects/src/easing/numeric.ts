// Godot Tween easing → an EXACT numeric sample. The companion to `easing.ts`: that module maps a Godot
// TransitionType×EaseType onto a CSS timing-function (a fit, and for some families only a fallback), which is what a
// consumer wants when the browser animates the property itself. This module is for the other half of the problem —
// when the consumer has to compute the value at time `t` itself (a canvas/WebGL frame, a sampled bake, a parity
// check against the game) and an approximation is not good enough.
//
// The equations are ported 1:1 from the Godot Engine 4.5.1 source file `scene/animation/easing_equations.h`
// (MIT-licensed; Copyright (c) 2014-present Godot Engine contributors, Copyright (c) 2007-2014 Juan Linietsky,
// Ariel Manzur — itself derived from Robert Penner's easing equations, Copyright (c) 2001 Robert Penner).
// `scene/animation/tween.cpp` supplies the dispatch: `Tween::interpolaters[TRANS][EASE]` picks the family/mode
// function and `run_equation()` calls it as `func(time, 0.0, 1.0, duration)`, i.e. b=0, c=1 — so normalizing to
// b=0, c=1, d=1 (what this module does) loses nothing: every equation is affine in b and c.

/** One `t → value` curve, normalized to b=0, c=1, d=1. */
type EaseSampler = (t: number) => number;

// Live effect renderers sample an easing once for every animated channel on every frame. Raw names
// come from the wire and are often repeated verbatim, so retain their normalized forms. This is
// deliberately a simple bounded memo rather than an LRU: names beyond the cap still compute
// correctly, they simply do not turn untrusted input into unbounded retained memory.
const NORMALIZED_NAME_CACHE_LIMIT = 64;
const normalizedNames = new Map<string, string>();

/** The four Godot EaseType columns for one TransitionType. */
interface EaseFamily {
  in: EaseSampler;
  out: EaseSampler;
  inOut: EaseSampler;
  outIn: EaseSampler;
}

// Godot's `out_in` is not an equation of its own: it runs `out` over the first half and `in` over the second, each
// with c/2 (`easing_equations.h`, every family's `out_in`).
function outInOf(halves: { in: EaseSampler; out: EaseSampler }): EaseSampler {
  return (t) =>
    t < 0.5 ? 0.5 * halves.out(t * 2) : 0.5 + 0.5 * halves.in(t * 2 - 1);
}

// The mirror of the above, used by Bounce and Spring, whose `in_out` is `in` then `out` over the halves rather than
// a dedicated equation.
function inOutOf(halves: { in: EaseSampler; out: EaseSampler }): EaseSampler {
  return (t) =>
    t < 0.5 ? 0.5 * halves.in(t * 2) : 0.5 + 0.5 * halves.out(t * 2 - 1);
}

function family(f: {
  in: EaseSampler;
  out: EaseSampler;
  inOut: EaseSampler;
}): EaseFamily {
  return { in: f.in, out: f.out, inOut: f.inOut, outIn: outInOf(f) };
}

// Linear::in is bound to all four ease columns ("Linear is the same for each easing", tween.cpp).
const LINEAR: EaseFamily = (() => {
  const identity: EaseSampler = (t) => t;
  return { in: identity, out: identity, inOut: identity, outIn: identity };
})();

const HALF_PI = Math.PI / 2;

const SINE = family({
  in: (t) => 1 - Math.cos(t * HALF_PI),
  out: (t) => Math.sin(t * HALF_PI),
  inOut: (t) => -0.5 * (Math.cos(Math.PI * t) - 1),
});

const QUINT = family({
  in: (t) => t ** 5,
  out: (t) => (t - 1) ** 5 + 1,
  inOut: (t) => {
    const u = t * 2;
    return u < 1 ? 0.5 * u ** 5 : 0.5 * ((u - 2) ** 5 + 2);
  },
});

const QUART = family({
  in: (t) => t ** 4,
  out: (t) => -((t - 1) ** 4 - 1),
  inOut: (t) => {
    const u = t * 2;
    return u < 1 ? 0.5 * u ** 4 : -0.5 * ((u - 2) ** 4 - 2);
  },
});

const QUAD = family({
  in: (t) => t ** 2,
  out: (t) => -t * (t - 2),
  inOut: (t) => {
    const u = t * 2;
    return u < 1 ? 0.5 * u ** 2 : -0.5 * ((u - 1) * (u - 3) - 1);
  },
});

// Expo carries Godot's (Penner's) small corrections — `- c * 0.001` on the way in, `* 1.001` on the way out — which
// exist to pull the curve's start/end onto the endpoints. They are kept EXACTLY: `godotEaseSample` is meant to
// reproduce the game's numbers, including that `Expo::in` really does reach only 0.999 as t approaches d.
const EXPO = family({
  in: (t) => (t === 0 ? 0 : 2 ** (10 * (t - 1)) - 0.001),
  out: (t) => (t === 1 ? 1 : 1.001 * (1 - 2 ** (-10 * t))),
  inOut: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    const u = t * 2;
    return u < 1
      ? 0.5 * 2 ** (10 * (u - 1)) - 0.0005
      : 0.5 * 1.0005 * (2 - 2 ** (-10 * (u - 1)));
  },
});

// Elastic with d=1: p = 0.3 (period), s = p/4 = 0.075 (phase shift); the in-out variant stretches the period to
// 0.3*1.5 = 0.45, so s = 0.1125.
const ELASTIC_PERIOD = 0.3;
const ELASTIC_SHIFT = ELASTIC_PERIOD / 4;
const ELASTIC_INOUT_PERIOD = 0.3 * 1.5;
const ELASTIC_INOUT_SHIFT = ELASTIC_INOUT_PERIOD / 4;

const ELASTIC = family({
  in: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    const u = t - 1;
    const a = 2 ** (10 * u);
    return -(
      a * Math.sin(((u - ELASTIC_SHIFT) * (2 * Math.PI)) / ELASTIC_PERIOD)
    );
  },
  out: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return (
      2 ** (-10 * t) *
        Math.sin(((t - ELASTIC_SHIFT) * (2 * Math.PI)) / ELASTIC_PERIOD) +
      1
    );
  },
  inOut: (t) => {
    if (t === 0) return 0;
    const u = t * 2;
    if (u === 2) return 1;
    const v = u - 1;
    const phase = Math.sin(
      ((v - ELASTIC_INOUT_SHIFT) * (2 * Math.PI)) / ELASTIC_INOUT_PERIOD,
    );
    return u < 1
      ? -0.5 * (2 ** (10 * v) * phase)
      : 2 ** (-10 * v) * phase * 0.5 + 1;
  },
});

const CUBIC = family({
  in: (t) => t * t * t,
  out: (t) => {
    const u = t - 1;
    return u * u * u + 1;
  },
  inOut: (t) => {
    const u = t * 2;
    if (u < 1) return 0.5 * u * u * u;
    const v = u - 2;
    return 0.5 * (v * v * v + 2);
  },
});

const CIRC = family({
  in: (t) => -(Math.sqrt(1 - t * t) - 1),
  out: (t) => {
    const u = t - 1;
    return Math.sqrt(1 - u * u);
  },
  inOut: (t) => {
    const u = t * 2;
    if (u < 1) return -0.5 * (Math.sqrt(1 - u * u) - 1);
    const v = u - 2;
    return 0.5 * (Math.sqrt(1 - v * v) + 1);
  },
});

const BOUNCE_OUT: EaseSampler = (t) => {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) {
    const u = t - 1.5 / 2.75;
    return 7.5625 * u * u + 0.75;
  }
  if (t < 2.5 / 2.75) {
    const u = t - 2.25 / 2.75;
    return 7.5625 * u * u + 0.9375;
  }
  const u = t - 2.625 / 2.75;
  return 7.5625 * u * u + 0.984375;
};

// Bounce::in is defined as `c - out(d - t)`, and Bounce::in_out as in-then-out over the halves (NOT the usual
// dedicated equation) — same for Spring.
const BOUNCE_HALVES = {
  in: (t: number) => 1 - BOUNCE_OUT(1 - t),
  out: BOUNCE_OUT,
};
const BOUNCE: EaseFamily = {
  ...BOUNCE_HALVES,
  inOut: inOutOf(BOUNCE_HALVES),
  outIn: outInOf(BOUNCE_HALVES),
};

const BACK_OVERSHOOT = 1.70158;
const BACK_INOUT_OVERSHOOT = 1.70158 * 1.525;

const BACK = family({
  in: (t) => t * t * ((BACK_OVERSHOOT + 1) * t - BACK_OVERSHOOT),
  out: (t) => {
    const u = t - 1;
    return u * u * ((BACK_OVERSHOOT + 1) * u + BACK_OVERSHOOT) + 1;
  },
  inOut: (t) => {
    const s = BACK_INOUT_OVERSHOOT;
    const u = t * 2;
    if (u < 1) return 0.5 * (u * u * ((s + 1) * u - s));
    const v = u - 2;
    return 0.5 * (v * v * ((s + 1) * v + s) + 2);
  },
});

const SPRING_OUT: EaseSampler = (t) => {
  const s = 1 - t;
  return (
    (Math.sin(t * Math.PI * (0.2 + 2.5 * t * t * t)) * s ** 2.2 + t) *
    (1 + 1.2 * s)
  );
};

const SPRING_HALVES = {
  in: (t: number) => 1 - SPRING_OUT(1 - t),
  out: SPRING_OUT,
};
const SPRING: EaseFamily = {
  ...SPRING_HALVES,
  inOut: inOutOf(SPRING_HALVES),
  outIn: outInOf(SPRING_HALVES),
};

// Keyed by the lowercased Godot TransitionType name, in the enum's own order (tween.cpp `interpolaters`).
const FAMILIES = new Map<string, EaseFamily>([
  ["linear", LINEAR],
  ["sine", SINE],
  ["quint", QUINT],
  ["quart", QUART],
  ["quad", QUAD],
  ["expo", EXPO],
  ["elastic", ELASTIC],
  ["cubic", CUBIC],
  ["circ", CIRC],
  ["bounce", BOUNCE],
  ["back", BACK],
  ["spring", SPRING],
]);

function normalizeName(name: string | undefined): string {
  if (typeof name !== "string") return "";
  const cached = normalizedNames.get(name);
  if (cached !== undefined) return cached;
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  if (normalizedNames.size < NORMALIZED_NAME_CACHE_LIMIT)
    normalizedNames.set(name, normalized);
  return normalized;
}

/** Select Godot's family/mode column, with the engine's missing/unknown-name defaults. */
function resolveEaseSampler(
  ease: string | undefined,
  trans: string | undefined,
): EaseSampler {
  const family = FAMILIES.get(normalizeName(trans)) ?? LINEAR;
  const mode = normalizeName(ease);
  return mode === "in"
    ? family.in
    : mode === "out"
      ? family.out
      : mode === "outin"
        ? family.outIn
        : family.inOut;
}

function sampleResolvedEase(sample: EaseSampler, t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return sample(t);
}

/**
 * Resolve a Godot easing family and mode once, returning a sampler for normalized time `t`.
 *
 * The returned function has the same endpoint behavior as `godotEaseSample`: values at or below
 * zero (including NaN) are zero and values at or above one are one. Missing and unknown names use
 * Godot's defaults (linear transition and in-out ease mode).
 */
export function createEaseSampler(
  ease: string | undefined,
  trans: string | undefined,
): (t: number) => number {
  const sample = resolveEaseSampler(ease, trans);
  return (t) => sampleResolvedEase(sample, t);
}

/**
 * Sample Godot's easing curve at normalized time `t`, returning the normalized progress (0 at the start, 1 at the
 * end, and freely outside that range in between for the overshooting families).
 *
 * `ease` and `trans` are the RAW Godot enum names as they arrive over a live wire, exactly like
 * `godotEasingToCss`: `ease` is "In"/"Out"/"InOut"/"OutIn" and `trans` is "Linear"/"Sine"/"Quint"/"Quart"/"Quad"/
 * "Expo"/"Elastic"/"Cubic"/"Circ"/"Bounce"/"Back"/"Spring". Both are case-insensitive and tolerate separators
 * ("in_out" reads as "InOut"). Unlike the CSS mapping — which has to collapse "OutIn" into the in-out column
 * because CSS cannot express it — every one of Godot's four ease modes is available here.
 *
 * Defaults match Godot's `Tween`: a missing `trans` is TRANS_LINEAR and a missing `ease` is EASE_IN_OUT
 * (`scene/animation/tween.h`). An UNRECOGNISED family also falls back to linear, so an unknown name degrades to
 * "plays at the right speed on average" rather than to a guess with the wrong shape.
 *
 * `t` is clamped to [0, 1] (NaN reads as 0). Returning exactly 1 at t >= 1 is what the engine does, not a
 * convenience: `PropertyTweener::step` assigns `final_val` outright once the elapsed time reaches the duration and
 * never evaluates the equation there (`tween.cpp`). It matters for Expo, whose raw equation would end at 0.999.
 */
export function godotEaseSample(
  ease: string | undefined,
  trans: string | undefined,
  t: number,
): number {
  return sampleResolvedEase(resolveEaseSampler(ease, trans), t);
}
