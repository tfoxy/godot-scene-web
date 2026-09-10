// Which Godot rendering backend the browser is imitating, and the ONE colour
// difference between them that godot-scene-web models.
//
// ---------------------------------------------------------------------------
// This is not a colour-management layer, and must not grow into one.
// ---------------------------------------------------------------------------
//
// godot-scene-web is deliberately sRGB end to end: `render-structure.ts` pins
// `color-interpolation-filters="sRGB"` on every emitted `<filter>`, `tint-bake.ts`
// applies its colour matrices in the sRGB BYTE domain, and both particle backends
// hand straight sRGB values to the canvas. That stance is correct and is not being
// revisited here. `srgbToLinear` below exists to reproduce ONE injected constant in
// Godot's own pipeline, on ONE property, and nothing else may use it.
//
// **What Godot actually does.** Its RendererRD backends (`forward_plus` and `mobile`)
// run `ParticleProcessMaterial.color` through `Color::srgb_to_linear()` exactly once,
// on the CPU, at UBO-upload time — and then write the result into a NON-LINEAR canvas
// with no inverse conversion anywhere downstream. RD 2D is NOT linear end to end:
// `rendering/viewport/hdr_2d` defaults to false, so the render target is
// `R8G8B8A8_UNORM` (`servers/rendering/renderer_rd/storage_rd/texture_storage.cpp`
// :4308-4314), the present blit's `convert_to_srgb` is false
// (`renderer_compositor_rd.cpp:98`), vertex colours are not linearized, and there is no
// sRGB present step. So the right mental model is "Godot linearizes this one property
// and then forgets to undo it", NOT "Godot's 2D renderer works in linear light".
// Reproducing it therefore means applying the same curve to the same property — not
// converting a colour space.
//
// **The chain, in Godot 4.5.1** (`../godot-4.5.1-stable`):
//   `scene/resources/particle_process_material.cpp:309`
//       `code += "uniform vec4 color_value : source_color;\n";`
//   `servers/rendering/renderer_rd/storage_rd/particles_storage.cpp:1768`
//       `update_parameters_uniform_set(…, 3, true, false)` — the `true` is
//       `p_use_linear_color`, passed UNCONDITIONALLY (unlike the canvas path at
//       `renderer_canvas_render_rd.cpp:670`, which keys it off `hdr_2d`).
//   `servers/rendering/renderer_rd/storage_rd/material_storage.cpp:456-459`
//       (shader-default path) and `servers/rendering/storage/variant_converters.h`
//       :208-213 (the user-set-value path a `.tscn` `color = Color(…)` takes) — both
//       converge on `Color::srgb_to_linear()`.
//
// **The scope is exactly one property, and Godot's own code proves it.** Every OTHER
// colour in the RD canvas path is converted only under `use_linear_colors`, which is
// `render_target_is_using_hdr(...)` (`renderer_canvas_render_rd.cpp:669`) — so with
// `hdr_2d` off, the canvas `modulate` (`:692`), per-rect modulation (`:2408`) and polygon
// vertex colours (`:2622`) are all left alone. `particles_storage.cpp:1768` is the one
// call site that passes `true` unconditionally. `CPUParticles2D` is not affected either:
// it computes `p.color = color_ramp * color … * base_color` on the CPU
// (`scene/2d/cpu_particles_2d.cpp:1086-1096`) and emits vertex colours, and the string
// `srgb_to_linear` does not occur in that file at all. Hence `fromProcessMaterial` below.
//
// **Compatibility/GLES3 does none of it.** Its material UBO fill
// (`drivers/gles3/storage/material_storage.cpp:765-793`) has no `p_use_linear_color`
// parameter at all, and the single `srgb_to_linear` in that whole file is the commented
// out line 1724 in the global-shader-uniform store. So a GLES3 capture and a browser
// render agree, and it is a Forward+/Mobile capture that is the outlier.
//
// **Stated limitation: `hdr_2d = true`.** With an HDR 2D viewport Godot's chain is a
// different one — the render target becomes a float format, the canvas material path
// switches to its linear uniform set (`renderer_canvas_render_rd.cpp:2272`), and the
// present blit re-encodes to sRGB (`renderer_compositor_rd.cpp:98`) — and this
// correction would then be WRONG, because the conversion it reproduces is no longer
// left un-undone. godot-scene-web models no HDR-2D concept at all: it does not parse
// `rendering/viewport/hdr_2d`, and `godotRenderer` cannot express it. Consumers running
// an HDR 2D viewport should set `godotRenderer: "gl_compatibility"` to opt out of the
// correction; that is the closest available answer, not an exact one.

/**
 * Which Godot rendering backend a browser render should imitate.
 *
 * Named after the CAUSE rather than after the correction: the two RendererRD backends
 * behave one way and Compatibility the other, and the option says which engine produced
 * the pixels the browser is being asked to match.
 *
 * Defaults to `"forward_plus"` — Godot's own default `rendering/renderer/rendering_method`
 * for a new project, and what a capture is overwhelmingly likely to have come from.
 */
export type GodotRendererBackend =
  | "forward_plus"
  | "mobile"
  | "gl_compatibility";

/** The default backend: Godot's own default for a new project. */
export const DEFAULT_GODOT_RENDERER: GodotRendererBackend = "forward_plus";

/** Coerce an untrusted value (a hand-authored spec blob, a consumer option) to a backend. */
export function normalizeGodotRenderer(value: unknown): GodotRendererBackend {
  return value === "mobile" ||
    value === "gl_compatibility" ||
    value === "forward_plus"
    ? value
    : DEFAULT_GODOT_RENDERER;
}

/**
 * True when the backend runs `ParticleProcessMaterial.color` through
 * `Color::srgb_to_linear()` at UBO-upload time. Both RendererRD backends do;
 * Compatibility/GLES3 does not.
 */
export function linearizesParticleColor(
  renderer: GodotRendererBackend,
): boolean {
  return renderer !== "gl_compatibility";
}

/**
 * Godot's `Color::srgb_to_linear()`, one channel — `core/math/color.h:191-197`:
 *
 * ```cpp
 * r < 0.04045f ? r * (1.0f / 12.92f)
 *              : Math::pow(float((r + 0.055) * (1.0 / (1.0 + 0.055))), 2.4f)
 * ```
 *
 * The piecewise IEC 61966-2-1 curve with exponent **2.4**, not a `pow(x, 2.2)`
 * approximation, and the threshold comparison is strict `<`. Written here the way Godot
 * writes it — reciprocal multiplies rather than divides — so the two read the same;
 * Godot evaluates the inner expression in double and then narrows to float before
 * `pow`, while JS stays in double throughout, a difference orders of magnitude below
 * the 1/255 the comparison is made at.
 *
 * Note the fixed point at both ends: `srgbToLinear(0) === 0` and `srgbToLinear(1) === 1`.
 * A fully saturated channel is where this curve is the identity, which is why it is the
 * per-channel regression check on the parity fixture (see `docs/parity.md`).
 */
export function srgbToLinear(value: number): number {
  return value < 0.04045
    ? value * (1 / 12.92)
    : ((value + 0.055) * (1 / 1.055)) ** 2.4;
}

/**
 * A particle system's base colour as the given backend uploads it: RGB through
 * {@link srgbToLinear} on the RendererRD backends, returned unchanged on
 * Compatibility/GLES3.
 *
 * `fromProcessMaterial` is the scope gate. Only `ParticleProcessMaterial.color` — a
 * `GPUParticles2D` with a process material — rides the UBO path that linearizes. When the
 * base colour instead came from `CPUParticles2D.color` or the node's `modulate`, it reaches
 * the canvas by a route Godot leaves in sRGB whatever the backend, and this returns it
 * untouched.
 *
 * **ALPHA IS NEVER TOUCHED.** `Color::srgb_to_linear()` passes `a` straight through
 * (`color.h:196`), so the coverage the blend algebra runs on is the authored value on
 * every backend and every path.
 *
 * Always returns a fresh tuple, so callers never alias the raw colour they passed in.
 */
export function linearizeParticleBaseColor(
  color: readonly [number, number, number, number],
  renderer: GodotRendererBackend,
  fromProcessMaterial: boolean,
): [number, number, number, number] {
  return fromProcessMaterial && linearizesParticleColor(renderer)
    ? [
        srgbToLinear(color[0]),
        srgbToLinear(color[1]),
        srgbToLinear(color[2]),
        color[3],
      ]
    : [color[0], color[1], color[2], color[3]];
}
