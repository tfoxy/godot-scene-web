export { INSTANCE_STRIDE } from "@godot-scene-web/effects";

import {
  createWebgpuParticleRenderer,
  peekWebgpuParticleRenderer,
  type WebgpuParticleRenderer,
  type WebgpuParticleRendererOptions,
  type WebgpuParticleSurfaceState,
} from "@godot-scene-web/canvas-effects/webgpu";

export {
  __resetWebgpuParticleProgramForTest,
  ADDITIVE_BLEND,
  ADDITIVE_RESOLVE_WGSL,
  INSTANCE_STRIDE_BYTES,
  PARTICLE_FS_ADDITIVE_ENTRY,
  PARTICLE_FS_ENTRY,
  PARTICLE_VERTEX_BUFFERS,
  PARTICLE_VS_ENTRY,
  PARTICLE_WGSL,
  PREMULTIPLIED_BLEND,
  RESOLVE_FS_ENTRY,
  RESOLVE_VS_ENTRY,
} from "@godot-scene-web/canvas-effects/webgpu";

import { bakeGradient } from "../webgl/bake-texture";
import { onTextureLoaded, performanceNow } from "../webgl/shared-gl";
import {
  configureCanvas,
  latchWebgpuFallbackReason,
  type WebgpuShared,
} from "../webgpu/device";
import {
  type GpuTextureEntry,
  getBakedTextureGpu,
  getImageTextureGpu,
} from "../webgpu/textures";
import {
  type ParticleRenderBackend,
  type ParticleSurface,
  type ParticleTextureSet,
  particleLutBake,
} from "./render-backend";
import type { ParticleSpecConfig } from "./spec";

type HostSurface = ParticleSurface & { gpu: WebgpuParticleSurfaceState };
function textures(shared: WebgpuShared, config: ParticleSpecConfig) {
  const bake = particleLutBake(config);
  return {
    sprite: config.textureUrl
      ? getImageTextureGpu(shared, config.textureUrl, { repeat: false })
      : null,
    lut: bake
      ? getBakedTextureGpu(shared, bake.key, () => bakeGradient(bake.spec), {
          repeat: false,
          nearest: bake.nearest,
        })
      : null,
    mask: config.maskUrl
      ? getImageTextureGpu(shared, config.maskUrl, { repeat: false })
      : null,
  };
}
function state(surface: ParticleSurface): HostSurface {
  return surface as HostSurface;
}
function options(shared: WebgpuShared): WebgpuParticleRendererOptions {
  return {
    device: shared.device,
    format: shared.format,
    onPipelineError: () => latchWebgpuFallbackReason("pipeline-error"),
  };
}
export async function createWebgpuParticleBackend(
  shared: WebgpuShared,
): Promise<ParticleRenderBackend | null> {
  const renderer = await createWebgpuParticleRenderer(options(shared));
  return renderer ? backend(shared, renderer) : null;
}
export function peekWebgpuParticleBackend(
  shared: WebgpuShared,
): ParticleRenderBackend | null | undefined {
  const renderer = peekWebgpuParticleRenderer(options(shared));
  return renderer === undefined
    ? undefined
    : renderer === null
      ? null
      : backend(shared, renderer);
}
function backend(
  shared: WebgpuShared,
  renderer: WebgpuParticleRenderer,
): ParticleRenderBackend {
  return {
    kind: "webgpu",
    createSurface(canvas, config) {
      const context = configureCanvas(canvas, shared);
      if (!context) return null;
      canvas.setAttribute("data-godot-effects-backend", "webgpu");
      const ts = textures(shared, config);
      let listeners: Array<() => void> = [];
      const gpu = renderer.createSurface({
        context,
        textures: ts,
        onTexturesChanged(callback) {
          listeners = [ts.sprite, ts.lut, ts.mask]
            .filter((x): x is GpuTextureEntry => x !== null)
            .map((x) => onTextureLoaded(x, callback));
          return () => {
            for (const dispose of listeners) dispose();
            listeners = [];
          };
        },
      });
      return { canvas, ctx2d: null, gpu } as HostSurface;
    },
    resolveTextures(config): ParticleTextureSet {
      const ts = textures(shared, config);
      return { texture: ts.sprite, lut: ts.lut, mask: ts.mask };
    },
    disposeSurface(surface, _buffer) {
      const s = state(surface);
      renderer.disposeSurface(s.gpu);
      try {
        s.gpu.context.unconfigure();
      } catch {}
    },
    maxBackingDim: () => shared.limits.maxTextureDimension2D,
    beginFrame: () => renderer.beginFrame(),
    endFrame: () => renderer.endFrame(),
    clear(surface, _w, _h, prof) {
      const start = prof ? performanceNow() : 0;
      renderer.clear(state(surface).gpu);
      if (prof) prof.glMs += performanceNow() - start;
    },
    draw(surface, buffer, opts, prof) {
      const start = prof ? performanceNow() : 0;
      renderer.draw(state(surface).gpu, buffer, opts);
      if (prof) prof.glMs += performanceNow() - start;
    },
    submits: () => renderer.submits(),
    captureSurface: (surface, buffer, opts) =>
      renderer.captureSurface(state(surface).gpu, buffer, opts),
  };
}
