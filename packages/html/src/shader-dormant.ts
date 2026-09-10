// The SHADER-DORMANT contract for the live WebGL shader runtime (`./webgl/runtime`).
//
// WHY: hosts flip nodes in and out of "shader off" states constantly (a card leaves the hand, a
// glow tier is downgraded, a panel closes). Today that means the binding is DISPOSED and, when the
// node comes back, a fresh one is created — and every new binding pays a `syncCanvasSize`, whose
// `clientWidth`/`clientHeight` read is a FORCED LAYOUT. A burst of them (playing a card re-keys a
// whole hand) is a measurable main-thread spike on phones.
//
// Dormancy is the cheap middle state: the host says "this shader node is off for now, but keep it",
// and the runtime parks the binding instead of tearing it down. A wake is then free — no program
// lookup, no texture re-resolve, and (crucially) no forced layout, because the deferred
// `syncCanvasSize` runs once, at wake, rather than once per flip.
//
// CONTRACT
//   Attribute: `data-godot-shader-dormant` (see `SHADER_DORMANT_ATTR`), any value — presence alone
//   is the signal (`""`/`"1"`/`"offscreen"` are all equivalent).
//
//   Scope: the SHADER NODE'S OWN element only (unlike `../effects-suspend`, which walks ancestors).
//   Dormancy is a per-node statement about one binding, and the runtime already keys bindings by
//   that element, so no tree walk is needed or wanted.
//
//   Evaluation: ONLY during `reconcile()`, like the suspend contract — the host stamps/unstamps the
//   attribute and then renders, and a reconcile always follows.
//
//   While dormant:
//     - the binding is KEPT (same object identity across the dormant window),
//     - its canvas is hidden (`display: none`) so it neither paints nor composites,
//     - the render loop skips it and it does NOT keep the rAF loop alive,
//     - the batched screen-rect read skips it (no layout on its behalf),
//     - `syncCanvasSize` is DEFERRED — a resize, a `setRenderScale`, a UV-window change or a
//       first-ever creation all just mark the sync pending.
//
//   On wake (the reconcile that no longer finds the attribute):
//     - the deferred `syncCanvasSize` runs (ONE box read, for however many flips happened),
//     - the canvas is unhidden and the binding is re-rendered at the CURRENT `TIME`.
//
//   Expiry: a binding that stays dormant for roughly `DORMANT_DISPOSE_SECONDS` is disposed for real
//   by the runtime's single sweep, so a node parked forever doesn't leak its canvas/textures. The
//   sweep is ONE timer per runtime, never one per binding.
//
// The attribute is inert for every other part of the renderer: it changes no layout, no style, and
// no non-runtime paint.

/** The DOM attribute that parks a gsw WebGL shader binding without disposing it (see the module doc). */
export const SHADER_DORMANT_ATTR = "data-godot-shader-dormant";

/** How long a binding may stay dormant before the runtime disposes it for real. Shared with the
 *  PARTICLE runtime's park (`./particles/runtime`, driven by `../effects-suspend` rather than by the
 *  attribute above): same question, same answer, and one window means a device probe reads one
 *  number. */
export const DORMANT_DISPOSE_SECONDS = 30;

/**
 * Whether `element` is itself marked dormant with `data-godot-shader-dormant`. Own-element only
 * (see the module doc) and attribute-only — no layout is forced.
 */
export function isShaderDormant(element: Element): boolean {
  return element.hasAttribute(SHADER_DORMANT_ATTR);
}
