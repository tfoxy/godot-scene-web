import {
  createParticleRuntime,
  type ParticleRuntime,
} from "./particles/runtime";
import {
  type GodotHtmlRuntimeOptions,
  RUNTIME_OPTION_KEYS,
} from "./runtime-options";
import {
  createWebglShaderRuntime,
  type WebglShaderRuntime,
} from "./webgl/runtime";

export type {
  ParticleProfile,
  ParticleRuntime,
  ParticleRuntimeStats,
} from "./particles/runtime";
export { createParticleRuntime } from "./particles/runtime";
export type {
  GodotHtmlMountOptions,
  GodotHtmlRuntimeOptions,
} from "./runtime-options";
export type { GodotEffectRenderInfo } from "./types";
export type {
  WebglShaderRuntime,
  WebglShaderRuntimeStats,
  WebglWarmSpec,
} from "./webgl/runtime";
export { createWebglShaderRuntime } from "./webgl/runtime";

/** Per-family overrides let an external host tune one binding without restarting the other. */
export interface HtmlEffectsHostOptions extends GodotHtmlRuntimeOptions {
  shaderOptions?: GodotHtmlRuntimeOptions;
  particleOptions?: GodotHtmlRuntimeOptions;
}

/** One DOM binding owner; the canvas renderer has its own stage/frame lifecycle. */
export interface HtmlEffectsHost {
  readonly shaders: WebglShaderRuntime | null;
  readonly particles: ParticleRuntime | null;
  reconcile(): void;
  updateOptions(options: HtmlEffectsHostOptions): void;
  dispose(): void;
}

export function createHtmlEffectsHost(
  stage: HTMLElement,
  initialOptions: HtmlEffectsHostOptions = {},
): HtmlEffectsHost {
  let shaders: WebglShaderRuntime | null = null;
  let particles: ParticleRuntime | null = null;
  let shaderOptions: GodotHtmlRuntimeOptions | null = null;
  let particleOptions: GodotHtmlRuntimeOptions | null = null;
  let disposed = false;
  const release = () => {
    shaders?.dispose();
    particles?.dispose();
    shaders = null;
    particles = null;
  };
  const host: HtmlEffectsHost = {
    get shaders() {
      return shaders;
    },
    get particles() {
      return particles;
    },
    reconcile() {
      if (disposed) return;
      shaders?.reconcile();
      particles?.reconcile();
    },
    updateOptions(next) {
      if (disposed) return;
      const nextShader = { ...next, ...next.shaderOptions };
      const nextParticle = { ...next, ...next.particleOptions };
      const shaderKeys = RUNTIME_OPTION_KEYS.filter(
        (key) =>
          !/^(particle|staticParticle|parkStaticParticle)/.test(key) &&
          key !== "enableParticles",
      );
      const particleKeys = RUNTIME_OPTION_KEYS.filter(
        (key) =>
          !/^(shader|staticShader)/.test(key) &&
          ![
            "enableWebglShaders",
            "resolveShaderSource",
            "enableScreenTextureCapture",
            "maxScreenCaptureDim",
          ].includes(key),
      );
      if (
        !shaderOptions ||
        shaderKeys.some((key) => shaderOptions?.[key] !== nextShader[key])
      ) {
        shaders?.dispose();
        shaders = null;
        shaderOptions = nextShader;
        if (!nextShader.externalRuntimes && nextShader.enableWebglShaders)
          shaders = createWebglShaderRuntime(stage, nextShader);
      }
      if (
        !particleOptions ||
        particleKeys.some((key) => particleOptions?.[key] !== nextParticle[key])
      ) {
        particles?.dispose();
        particles = null;
        particleOptions = nextParticle;
        if (!nextParticle.externalRuntimes && nextParticle.enableParticles)
          particles = createParticleRuntime(stage, nextParticle);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  };
  host.updateOptions(initialOptions);
  return host;
}

export {
  normalizeParticleSpecConfig,
  type ParticleSpecConfig,
  parseParticleSpecConfig,
} from "./particles/spec";
