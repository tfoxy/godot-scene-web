import type { ParticleRenderConfig } from "./config";
import type { InstanceBuffer } from "./instance-buffer";
import type { ParticleSystemState } from "./state";

export interface ParticleInstanceTransform {
  readonly xx: number;
  readonly xy: number;
  readonly yx: number;
  readonly yy: number;
  readonly originX: number;
  readonly originY: number;
  readonly scale?: number;
  readonly rotation?: number;
}

export interface ParticleInstancePackInput {
  readonly state: ParticleSystemState;
  readonly config: Pick<
    ParticleRenderConfig,
    "hframes" | "vframes" | "flipbookCropOnly"
  >;
  readonly instances: InstanceBuffer;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly origin?: readonly [number, number];
  readonly transform?: ParticleInstanceTransform;
  readonly modulate?: readonly [number, number, number, number];
}

/** The sprite-sheet grid used for a texture; untextured particles always have one frame. */
export function frameGridFor(
  textured: boolean,
  hframes: number,
  vframes: number,
): [number, number] {
  return textured ? [Math.max(1, hframes), Math.max(1, vframes)] : [1, 1];
}

/** Pack live particle state into a caller-owned, reusable GPU instance buffer. */
export function packParticleInstances(
  input: ParticleInstancePackInput,
): number {
  const { state, config, instances } = input;
  const originX = input.origin?.[0] ?? 0;
  const originY = input.origin?.[1] ?? 0;
  const frameW = config.flipbookCropOnly
    ? input.textureWidth
    : input.textureWidth / Math.max(1, config.hframes);
  const frameH = config.flipbookCropOnly
    ? input.textureHeight
    : input.textureHeight / Math.max(1, config.vframes);
  const transform = input.transform;
  const modulate = input.modulate;
  const xx = transform?.xx ?? 1,
    xy = transform?.xy ?? 0,
    yx = transform?.yx ?? 0,
    yy = transform?.yy ?? 1;
  const tx = transform?.originX ?? 0,
    ty = transform?.originY ?? 0;
  const scale = transform?.scale ?? 1,
    rotation = transform?.rotation ?? 0;
  const mr = modulate?.[0] ?? 1,
    mg = modulate?.[1] ?? 1,
    mb = modulate?.[2] ?? 1,
    ma = modulate?.[3] ?? 1;
  instances.reset();
  for (let i = 0; i < state.particles.length; i += 1) {
    const p = state.particles[i];
    if (!(p.active && p.a > 0)) continue;
    const localX = originX + p.x,
      localY = originY + p.y;
    instances.push(
      xx * localX + yx * localY + tx,
      xy * localX + yy * localY + ty,
      Math.max(0, frameW * p.scaleX * scale),
      Math.max(0, frameH * p.scaleY * scale),
      p.rotation + rotation,
      p.r * mr,
      p.g * mg,
      p.b * mb,
      p.a * ma,
      p.frame,
    );
  }
  return instances.count;
}
