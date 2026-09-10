export type { ParticleConfig, ParticleRenderConfig } from "./config";
export type { GodotRendererBackend } from "./godot-renderer";
export {
  DEFAULT_GODOT_RENDERER,
  linearizeParticleBaseColor,
  linearizesParticleColor,
  normalizeGodotRenderer,
  srgbToLinear,
} from "./godot-renderer";
export { INSTANCE_STRIDE, InstanceBuffer } from "./instance-buffer";
export type {
  ParticleInstancePackInput,
  ParticleInstanceTransform,
} from "./pack-instances";
export { frameGridFor, packParticleInstances } from "./pack-instances";
export type { ParticleCurvePoint, ParticleGradientStop } from "./sampling";
export {
  normalizeParticleCurve,
  sampleParticleCurve,
  sampleParticleGradient,
  sampleParticleGradientInto,
} from "./sampling";
export {
  activeParticleCount,
  oneShotBurstSeconds,
  preprocessParticles,
  simulateParticles,
  staticOneShotExpired,
  warmStaticParticles,
} from "./simulate";
export type { Particle, ParticleSystemState } from "./state";
export {
  createParticleState,
  normalizeParticleConfig,
  normalizeParticleRenderConfig,
  particlesAreLive,
} from "./state";
