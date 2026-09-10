// The EFFECT-SUSPEND contract shared by the two live effect runtimes (`./webgl/runtime`'s
// WebGL shader runtime and `./particles/runtime`'s particle runtime).
//
// WHY: both runtimes keep a rAF loop alive for as long as ANY of their bindings is animated
// (a `TIME`-reading shader, a looping ambient emitter). That cost is paid even when the
// nodes are not visible to the user — e.g. a combat scene fully covered by a full-screen
// dialog, or a subtree the host knows is occluded/off-screen. Neither runtime can decide
// that on its own: occlusion is a host/layout question. So the host publishes it in the DOM
// and the runtimes obey.
//
// CONTRACT
//   Attribute: `data-godot-effects-suspended` (see `EFFECTS_SUSPENDED_ATTR`), any value —
//   presence alone is the signal (`""`/`"1"`/`"occluded"` are all equivalent).
//
//   Scope: a binding is suspended when the attribute is on its own node OR on ANY ancestor
//   (`Element.closest`), so a host suspends a whole subtree by stamping ONE container. The
//   walk is not limited to the scene root, so a wrapper above the root works too.
//
//   Evaluation: ONLY during each runtime's `reconcile()` — never polled per frame. Occlusion
//   changes are host-driven, and the host calls `reconcile()` whenever it renders a frame, so
//   a reconcile always follows the DOM change that adds/removes the attribute.
//
//   While suspended:
//     - shader bindings skip their per-frame render and do NOT keep the rAF loop alive; the
//       node canvas keeps its last rendered frame (it's covered, so nothing to see).
//     - particle bindings skip simulate + draw: the simulation state is FROZEN, never reset,
//       and they do NOT count as "live" for keeping the loop alive. Their canvas is also
//       PARKED — hidden, so it stops costing a compositor layer and a backing store, with its
//       owed re-sizes deferred to the wake and the binding disposed outright if it stays parked
//       for ~`DORMANT_DISPOSE_SECONDS` (the same park `./shader-dormant` defines, driven here by
//       this attribute instead of a per-node one; see `particleDormant` in `./types` for the
//       kill switch that restores "the canvas keeps its last drawn frame").
//     - a runtime whose bindings are ALL suspended parks its rAF loop entirely (zero
//       per-frame cost).
//
//   On resume (the reconcile that no longer finds the attribute):
//     - shader bindings are re-rendered at the CURRENT `TIME` (marked dirty + the loop kicked).
//     - particle systems un-hide, pay the ONE `sizeCanvas` their park owed, and CONTINUE from
//       their frozen state (no reset, no dt catch-up spike — the loop's clock is reset on wake
//       and dt is clamped). A binding the park already expired is re-created instead, which does
//       reset that one system's simulation.
//
// The attribute is deliberately inert for every other part of the renderer: it changes no
// layout, no style, and no non-runtime paint.

/** The DOM attribute that suspends gsw's live effect runtimes for a subtree (see the module doc). */
export const EFFECTS_SUSPENDED_ATTR = "data-godot-effects-suspended";

const EFFECTS_SUSPENDED_SELECTOR = `[${EFFECTS_SUSPENDED_ATTR}]`;

/**
 * Whether `element` sits inside (or is) a subtree the host marked suspended with
 * `data-godot-effects-suspended`. Attribute-only — no layout is forced.
 */
export function isEffectsSuspended(element: Element): boolean {
  return element.closest(EFFECTS_SUSPENDED_SELECTOR) !== null;
}
