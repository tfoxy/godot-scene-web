// Godot Tween easing → CSS timing-function. A Godot `Tween` step carries a TransitionType (`trans`) and an
// EaseType (`ease`); to replay that tween as a CSS `transition`/animation a consumer needs the matching CSS
// timing function. This is the generic (any-Godot-streamer) form of the mapping, ported from
// @spirectl/presentation's `render/interactivity.ts:godotEasingToCss` (gsw cannot import upward from presentation).
//
// Difference from the presentation copy: this accepts the RAW Godot enum names as they arrive over a live wire
// (`EaseType` = "In"/"Out"/"InOut"/"OutIn", `TransitionType` = "Expo"/"Back"/"Elastic"/"Linear"/…), so it
// lowercases BOTH `ease` and `trans` (the presentation copy assumed catalog-normalized lowercase input).

// CSS `linear()` approximation of Godot ElasticOut: 2^(-10t)·sin((10t − 0.75)·2π/3) + 1, sampled at 17 evenly
// spaced points (cubic-bezier cannot oscillate). Browsers without `linear()` ignore it and snap.
export const ELASTIC_OUT_LINEAR =
  "linear(0, 0.832, 1.364, 1.193, 0.912, 0.889, 1, 1.047, 1.016, 0.986, 0.989, 1.002, 1.006, 1.001, 0.998, 0.999, 1)";

// The POLYNOMIAL / trigonometric Godot transition families (`scene/animation/easing_equations.h`) are the classic
// Penner equations, and each one has a cubic-bezier fit that is accurate to ~1-2% of the travel distance. They used
// to fall through to the generic `ease-in`/`ease-out`/`ease-in-out` curves, which is NOT a small error: Godot's
// QuintOut has covered 97% of the distance at the half-way point where CSS `ease-out` has covered 68% — a max
// deviation of 0.388 (measured), i.e. the browser visibly lags the game through the whole second half of every such
// tween. STS2's shop-inventory open slide (`SlotsContainer`, position:y, 700ms, Quint/Out — captured live in
// couch-coop's `.sts2/bench/audit-shop-open.ndjson`) is the reported case: the panel looked ~2× slower to arrive in
// the mirror than in the game. Max |error| against the exact Godot curve, sampled at 201 points:
//   sine   in/out 0.0076  inout 0.0020        quad  in/out 0.0019  inout 0.0053
//   cubic  in/out 0.0028  inout 0.0095        quart in/out 0.0056  inout 0.0217
//   quint  in/out 0.0113  inout 0.0322        circ  in/out 0.0018  inout 0.0387
// (`bounce` and `spring` are NOT expressible as a cubic-bezier — they keep the `ease-*` fallback, like elastic-in.)
const POLY_BEZIERS: Record<string, readonly [string, string, string]> = {
  // [in, out, in-out]
  sine: ["cubic-bezier(0.12, 0, 0.39, 0)", "cubic-bezier(0.61, 1, 0.88, 1)", "cubic-bezier(0.37, 0, 0.63, 1)"],
  quad: ["cubic-bezier(0.11, 0, 0.5, 0)", "cubic-bezier(0.5, 1, 0.89, 1)", "cubic-bezier(0.45, 0, 0.55, 1)"],
  cubic: ["cubic-bezier(0.32, 0, 0.67, 0)", "cubic-bezier(0.33, 1, 0.68, 1)", "cubic-bezier(0.65, 0, 0.35, 1)"],
  quart: ["cubic-bezier(0.5, 0, 0.75, 0)", "cubic-bezier(0.25, 1, 0.5, 1)", "cubic-bezier(0.76, 0, 0.24, 1)"],
  quint: ["cubic-bezier(0.64, 0, 0.78, 0)", "cubic-bezier(0.22, 1, 0.36, 1)", "cubic-bezier(0.83, 0, 0.17, 1)"],
  circ: ["cubic-bezier(0.55, 0, 1, 0.45)", "cubic-bezier(0, 0.55, 0.45, 1)", "cubic-bezier(0.85, 0, 0.15, 1)"],
};

// Godot easing (`ease` In/Out/InOut + `trans` Expo/Linear/Back/Elastic/Sine/Quad/Cubic/Quart/Quint/Circ/…) → a CSS
// timing-function string. Case-insensitive in both arguments.
//
// A MISSING `trans` maps to `linear`, not to a curve: Godot's `Tween::default_transition` is `TRANS_LINEAR` (4.5.1,
// `scene/animation/tween.h`), so a step that never called `set_trans()` really does play linearly — the old
// `ease-in-out` fallback deviated from it by up to 0.121. (`default_ease` IS `EASE_IN_OUT`, which is why a missing
// `ease` still selects the in-out column.) Only an UNRECOGNISED family name keeps the generic `ease-*` guess.
export function godotEasingToCss(ease?: string, trans?: string): string {
  const e = typeof ease === "string" ? ease.toLowerCase() : "";
  const dir = e === "out" ? "out" : e === "in" ? "in" : "in-out";
  const t = typeof trans === "string" ? trans.toLowerCase() : "";
  if (t === "expo") {
    return dir === "out"
      ? "cubic-bezier(0.19, 1, 0.22, 1)"
      : dir === "in"
        ? "cubic-bezier(0.95, 0.05, 0.795, 0.035)"
        : "cubic-bezier(1, 0, 0, 1)";
  }
  // A step with no `trans` at all: Godot's Tween default is TRANS_LINEAR (see the note above).
  if (t === "linear" || t === "") return "linear";
  const poly = POLY_BEZIERS[t];
  if (poly) {
    return dir === "out" ? poly[1] : dir === "in" ? poly[0] : poly[2];
  }
  if (t === "back") {
    // Godot Back easing: a single overshoot, expressible as a cubic-bezier.
    return dir === "out"
      ? "cubic-bezier(0.34, 1.56, 0.64, 1)"
      : dir === "in"
        ? "cubic-bezier(0.36, 0, 0.66, -0.56)"
        : "cubic-bezier(0.68, -0.6, 0.32, 1.6)";
  }
  if (t === "elastic") {
    // Only `out` has an oscillating approximation (via linear()); in/in-out fall back to a single-overshoot bezier.
    return dir === "out" ? ELASTIC_OUT_LINEAR : "cubic-bezier(0.68, -0.6, 0.32, 1.6)";
  }
  return dir === "out" ? "ease-out" : dir === "in" ? "ease-in" : "ease-in-out";
}
