// The two WGSL programs S7 `effects-webgpu` renders with, as SOURCE STRINGS and nothing else.
//
// WHY THIS FILE HAS NO DOM AND NO WEBGPU OBJECT IN IT. Everything here is a string or a plain
// descriptor, so `test/effects-webgpu.test.ts` can import it in plain node and assert the things
// that can silently go wrong — the entry-point names the pipeline descriptors reference, the
// premultiply/blend pairing, and every float literal of the Godot shader this ports — WITHOUT a
// browser and WITHOUT a WebGPU mock. A mock would test the mock.
//
// THE TWO PORTS, and what "port" is allowed to mean here.
//
//   PARTICLES — a WGSL transcription of `packages/html/src/particles/render-webgl.ts`'s vertex +
//     untextured-fragment path. The instance layout is NOT re-invented: it is the shipped
//     `INSTANCE_STRIDE` (10 floats = center.xy, scale.xy, rotation, rgba, frame), so the bytes
//     `pack.ts` writes are byte-identical to the bytes the GL renderer already consumes. `frame` is
//     unused by an untextured draw and is KEPT anyway — dropping it would shrink the stride and the
//     probe would stop packing the shipped layout.
//   SHADER — a WGSL port of S6's `EFFECTS_SHADER_SOURCE` (the Godot `canvas_item` fragment the
//     `shaders-live` arm transpiles and runs). Same constants, same expression order.
//
// PREMULTIPLIED ALPHA, which is not a detail. A `GPUCanvasContext` offers only
// `alphaMode: "opaque" | "premultiplied"` — there is no straight-alpha canvas — so both fragments
// RETURN premultiplied (`rgb * a, a`) and the pipeline blends `ONE / ONE_MINUS_SRC_ALPHA` on both
// color and alpha. The shipped GL path states the SAME contract (`webgl/shared-gl.ts` declares
// `premultipliedAlpha: true`, its fragments premultiply, its MIX blend is this one in GL enum
// names), so the arms are comparable at equal pixels. The pairing is load-bearing on BOTH sides at
// once (a premultiplied fragment under a src-alpha blend double-multiplies; a straight fragment
// under a one/one-minus-src-alpha blend halos), which is why `PREMULTIPLIED_BLEND` lives next to the
// sources and a test asserts the two together.

/** Vertex entry point of `PARTICLE_WGSL`. Referenced by the pipeline descriptor, never spelled twice. */
export const PARTICLE_VS_ENTRY = "vs_particles";
/** Fragment entry point of `PARTICLE_WGSL`. */
export const PARTICLE_FS_ENTRY = "fs_particles";
/** Vertex entry point of `SHADER_WGSL`. */
export const SHADER_VS_ENTRY = "vs_shader";
/** Fragment entry point of `SHADER_WGSL`. */
export const SHADER_FS_ENTRY = "fs_shader";

/**
 * Bytes per instance record: the shipped `INSTANCE_STRIDE` (10 floats) × 4. Stated here because it
 * is what the vertex-buffer layout below declares as its `arrayStride`; `pack.ts` asserts the two
 * against the imported constant so this cannot drift from the packer.
 */
export const INSTANCE_STRIDE_BYTES = 40;

/**
 * The blend state BOTH pipelines use, and the other half of the premultiply contract above.
 *
 * `one / one-minus-src-alpha` on color AND alpha: the fragment already carries `rgb * a`, so the
 * source contributes its light unscaled and the destination is attenuated by the coverage the
 * source claims — `dst' = src.rgb*src.a + dst*(1-src.a)`, which is what
 * `SRC_ALPHA / ONE_MINUS_SRC_ALPHA` computes over a straight-alpha source. The alpha channel gets
 * the same pair so the canvas's own alpha accumulates the same way (a "keep dst alpha" pair would
 * make an overlapping particle punch a hole in the composite).
 */
export const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
  alpha: {
    operation: "add",
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
  },
};

/**
 * The per-cell vertex buffer layout: slot 0 is the static unit-quad corner (stepped per VERTEX),
 * slot 1 is the packed instance record (stepped per INSTANCE).
 *
 * The attribute offsets are the shipped float offsets × 4 — center@0, scale@8, rotation@16,
 * color@20, frame@36 — i.e. exactly `INSTANCE_ATTRS` in `render-webgl.ts`, in bytes. Exported so a
 * test can read the stride back without building a device.
 */
export const PARTICLE_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    stepMode: "vertex",
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
  },
  {
    arrayStride: INSTANCE_STRIDE_BYTES,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 1, offset: 0, format: "float32x2" }, // center, device px
      { shaderLocation: 2, offset: 8, format: "float32x2" }, // scale, device px
      { shaderLocation: 3, offset: 16, format: "float32" }, // rotation, rad
      { shaderLocation: 4, offset: 20, format: "float32x4" }, // rgba, straight
      { shaderLocation: 5, offset: 36, format: "float32" }, // flipbook frame (unused, kept)
    ],
  },
];

/**
 * Instanced particle quads.
 *
 * The vertex stage is `render-webgl.ts`'s `VERTEX_SRC` line for line: rotate the unit-quad corner by
 * the instance rotation, scale it, add the center, then map device px into clip space with
 * `clip.y = -clip.y` because a canvas is Y-down and clip space is Y-up. The fragment is that file's
 * UNTEXTURED branch — `1 - smoothstep(0.7, 1.0, r)` over a quad-local radius — times the instance
 * colour, returned premultiplied (see the module note).
 *
 * `Vp` is padded to 16 bytes because a uniform struct's size must be a multiple of its alignment and
 * `vec2f`'s is 8 while the buffer is bound at a 256-byte-class dynamic offset — an unpadded struct
 * is a validation error on some backends and silently reads the next cell's viewport on others.
 */
export const PARTICLE_WGSL = `struct Vp {
  size: vec2f,
  _pad: vec2f,
};

@group(0) @binding(0) var<uniform> vp: Vp;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) quad: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn ${PARTICLE_VS_ENTRY}(
  @location(0) corner: vec2f,
  @location(1) center: vec2f,
  @location(2) scale: vec2f,
  @location(3) rotation: f32,
  @location(4) color: vec4f,
  @location(5) frame: f32,
) -> VsOut {
  let c = cos(rotation);
  let s = sin(rotation);
  let rotated = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let px = center + rotated * scale;
  var clip = (px / vp.size) * 2.0 - 1.0;
  clip.y = -clip.y;
  var out: VsOut;
  out.pos = vec4f(clip, 0.0, 1.0);
  out.quad = corner + 0.5;
  out.color = color;
  // The flipbook frame is part of the SHIPPED instance record and is packed byte-identically; an
  // untextured draw has no sheet to index, so it is consumed here rather than dropped.
  _ = frame;
  return out;
}

@fragment
fn ${PARTICLE_FS_ENTRY}(in: VsOut) -> @location(0) vec4f {
  let r = length(in.quad - vec2f(0.5)) * 2.0;
  let sprite = vec4f(1.0, 1.0, 1.0, 1.0 - smoothstep(0.7, 1.0, r));
  let col = sprite * in.color;
  return vec4f(col.rgb * col.a, col.a);
}
`;

/**
 * The WGSL port of S6's `EFFECTS_SHADER_SOURCE`.
 *
 * Godot's `UV` on a `canvas_item` fragment is node-local with a TOP-LEFT origin, so the vertex stage
 * derives it from the strip corner as `(x*0.5+0.5, 0.5-y*0.5)` — the `0.5 - y*0.5` is the flip, and
 * getting it wrong mirrors the wave pattern without changing its cost, which is the kind of bug a
 * frame-time table cannot see. Every numeric constant of the Godot source is reproduced verbatim;
 * `test/effects-webgpu.test.ts` extracts them from `EFFECTS_SHADER_SOURCE` by regex and requires
 * each one to appear here, so editing the Godot shader without editing this port fails the suite.
 *
 * `U` is padded to 16 bytes for the same reason `Vp` is.
 */
export const SHADER_WGSL = `struct U {
  time: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: U;

struct ShaderOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn ${SHADER_VS_ENTRY}(@builtin(vertex_index) index: u32) -> ShaderOut {
  // TRIANGLE_STRIP corner order, matching the particle quad's: (-1,-1) (1,-1) (-1,1) (1,1).
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, 1.0)
  );
  let xy = corners[index];
  var out: ShaderOut;
  out.pos = vec4f(xy, 0.0, 1.0);
  // Godot UV: node-local, TOP-LEFT origin. Clip Y is up, UV Y is down.
  out.uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
  return out;
}

@fragment
fn ${SHADER_FS_ENTRY}(in: ShaderOut) -> @location(0) vec4f {
  let p = in.uv - vec2f(0.5);
  let r = length(p) * 2.0;
  let wave = 0.5 + 0.5 * sin(r * 12.0 - u.time * 2.5);
  let tint = vec3f(0.45 + 0.4 * wave, 0.30 + 0.25 * wave, 0.85 - 0.3 * wave);
  let col = vec4f(tint, clamp(1.0 - 0.5 * r, 0.35, 1.0));
  return vec4f(col.rgb * col.a, col.a);
}
`;
