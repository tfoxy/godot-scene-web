// The instance-buffer BUILD, lifted out of the shipped GL runtime so a WebGPU renderer can be fed
// the same bytes.
//
// This is the one piece of the pipeline that has to be RESTATED rather than imported: in
// `packages/html/src/particles/runtime.ts` the loop lives inside `drawBinding`, wrapped in the
// runtime's own profiling brackets and followed immediately by a `gl.viewport` — there is no seam
// between "pack" and "draw" to import. Everything it CONSUMES is imported though: `InstanceBuffer`
// and `INSTANCE_STRIDE` are the shipped ones, so the layout cannot drift, and the push expressions
// below are the shipped ones character for character:
//
//     ((geometry.originX ?? 0) + p.x + pad) * dpr,
//     ((geometry.originY ?? 0) + p.y + pad) * dpr,
//     Math.max(0, frameW * p.scaleX) * dpr,
//     Math.max(0, frameH * p.scaleY) * dpr,
//     p.rotation, p.r, p.g, p.b, p.a, p.frame
//
// including the skip — `!p.active || p.a <= 0` — which is what makes `count` the number of
// particles really drawn rather than the slot count. `test/effects-webgpu.test.ts` runs a
// hand-built particle list (one inactive, one at alpha 0) through this and compares the resulting
// Float32Array element by element, so a transposed field or a dropped `dpr` is a failing test and
// not a subtly wrong picture at a plausible frame rate.
//
// PURE, and DOM-free: no canvas, no device, no clock. That is what lets the test above exist.

import {
  INSTANCE_STRIDE,
  type InstanceBuffer,
  type ParticleSystemState,
} from "@godot-scene-web/effects/particles";
import { INSTANCE_STRIDE_BYTES } from "./wgsl";

/**
 * The geometry `drawBinding` reads off its binding, passed explicitly because a probe has no
 * binding.
 *
 * `pad` is the runtime's canvas pad (`effectsCanvasPad`), `dpr` the ratio the canvas was really
 * sized at (`effectivePixelRatio(renderScale)`, via the imported `backingStoreSize`), and
 * `frameW`/`frameH` the sprite frame size — 16×16 for an untextured system, which is the runtime's
 * module-private `DEFAULT_DOT`. See `WEBGPU_DOT_PX` in `../effects-webgpu.ts` for the drift guard
 * that fails if that private constant ever moves.
 */
export interface PackGeometry {
  originX?: number;
  originY?: number;
  pad: number;
  dpr: number;
  frameW: number;
  frameH: number;
}

/**
 * Guard against the WGSL vertex layout and the shipped packed layout parting company.
 *
 * `PARTICLE_VERTEX_BUFFERS` declares an `arrayStride` in BYTES and the packer writes FLOATS; if
 * `INSTANCE_STRIDE` ever changes, one of the two moves and the other does not, and the symptom is a
 * garbage picture rather than an error. Checked at module load — this module is imported by the
 * scenario and by its test, so neither can run past a mismatch.
 */
if (INSTANCE_STRIDE * 4 !== INSTANCE_STRIDE_BYTES) {
  throw new Error(
    `effects-webgpu: @godot-scene-web/core packs ${INSTANCE_STRIDE} floats (${INSTANCE_STRIDE * 4} bytes) per particle but the WGSL vertex layout declares an arrayStride of ${INSTANCE_STRIDE_BYTES} bytes. Fix PARTICLE_VERTEX_BUFFERS in webgpu/wgsl.ts to match INSTANCE_STRIDE.`,
  );
}

/**
 * Pack one system's live particles into `buffer`, and return how many there are.
 *
 * Resets the buffer first (the shipped loop does), so `buffer.data.subarray(0, count *
 * INSTANCE_STRIDE)` is exactly this frame's records and everything past it is last frame's
 * leftovers — which is why the count, not the buffer length, is what gets uploaded and drawn.
 */
export function packSystem(
  buffer: InstanceBuffer,
  state: ParticleSystemState,
  geometry: PackGeometry,
): number {
  const { pad, dpr, frameW, frameH } = geometry;
  buffer.reset();
  for (const p of state.particles) {
    if (!p.active || p.a <= 0) continue;
    buffer.push(
      ((geometry.originX ?? 0) + p.x + pad) * dpr,
      ((geometry.originY ?? 0) + p.y + pad) * dpr,
      Math.max(0, frameW * p.scaleX) * dpr,
      Math.max(0, frameH * p.scaleY) * dpr,
      p.rotation,
      p.r,
      p.g,
      p.b,
      p.a,
      p.frame,
    );
  }
  return buffer.count;
}

/** The used prefix of a packed buffer: the bytes an upload must copy, and nothing after them. */
export function packedBytes(count: number): number {
  return count * INSTANCE_STRIDE_BYTES;
}
