/**
 * DOM-free effect targets for a canvas stage.
 *
 * This module deliberately accepts an already-created WebGL2 context.  It never
 * asks for a canvas, creates an element, or schedules a frame: the caller owns
 * the stage, painter ordering, and clock.  The small raw-GLSL and procedural
 * particle subsets below are useful without claiming to be a Godot material or
 * GPUParticles interpreter.
 */

import {
  createParticleState,
  InstanceBuffer,
  normalizeParticleRenderConfig,
  type ParticleRenderConfig,
  type ParticleSystemState,
  packParticleInstances,
  preprocessParticles,
  simulateParticles,
} from "@godot-scene-web/effects/particles";
import {
  type GodotBlendMode,
  type ShaderUniform,
  type TranspiledShader,
  transpileGodotShader,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";
import {
  acquireParticleProgram,
  disposeParticleInstanceBuffer,
  drawParticles,
  invalidateParticleInstanceBuffer,
  type ParticleProgram,
  prepareParticleDraw,
  releaseParticleProgram,
} from "./particle-webgl";

export {
  blendFactorsFor,
  disposeParticleInstanceBuffer,
  drawParticles,
  getParticleProgram,
  invalidateParticleInstanceBuffer,
  prepareParticleDraw,
} from "./particle-webgl";
export {
  clearWebglSurface,
  compileProgram,
  compileProgramAsync,
  createWebglFullscreenQuad,
  createWebglPlaceholderTexture,
  createWebglTexture,
  deleteWebglTexture,
  drawGodotWebglShaderFrame,
  type PendingProgram,
  startProgram,
  uploadGodotShaderUniform,
  uploadWebglTexture,
  type WebglGodotShaderFrame,
} from "./shader-webgl";

export type HeadlessEffectDiagnosticCode =
  | "CONTEXT_LOST"
  | "DISPOSED"
  | "INVALID_DIMENSIONS"
  | "INVALID_RENDER_INPUT"
  | "RESOURCE_ALLOCATION_FAILED"
  | "FRAMEBUFFER_INCOMPLETE"
  | "SHADER_COMPILE_FAILED"
  | "UNSUPPORTED_SHADER_FEATURE"
  | "UNSUPPORTED_PARTICLE_FEATURE"
  | "SCREEN_TEXTURE_REQUIRED"
  | "FOREIGN_TARGET";

export interface HeadlessEffectDiagnostic {
  readonly code: HeadlessEffectDiagnosticCode;
  readonly message: string;
  /** The exact requested capability where a typed producer declines it. */
  readonly feature?: string;
}

export type HeadlessEffectResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: HeadlessEffectDiagnostic };

/** An RGBA8 texture/FBO pair owned by one {@link HeadlessEffectsStage}. */
export interface HeadlessEffectTarget {
  readonly texture: WebGLTexture | null;
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
}

/** A same-context read-only source. Borrowed cache textures are never deleted by this stage. */
/** A live texture from this WebGL context. Resource decoding stays with the host. */
export interface WebglTextureInput {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

export type HeadlessTextureInput = HeadlessEffectTarget | WebglTextureInput;

/**
 * The framebuffer supplied by a host at a precise painter position. This is a
 * GPU contract, deliberately free of DrawList and HTML binding objects.
 */
export interface WebglEffectTargetContext {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
  readonly damage?: unknown;
  readonly scissor: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export type HeadlessShaderFeature =
  | "screen-texture"
  | "time"
  | "delta"
  | "seed"
  | "external-textures"
  | "multiple-render-targets"
  | "transform-feedback"
  | "godot-source";

export type HeadlessUniformValue =
  | number
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number];

/**
 * A complete GLSL ES 3 fragment pass.  It receives `v_uv`; optional uniforms
 * are `u_time`, `u_delta`, `u_seed`, `u_resolution`, and (when declared in
 * `features`) `u_screenTexture`.  Application uniforms are numeric scalars or
 * vec2/3/4 values.  Other textures and Godot shader-language translation are
 * intentionally refused rather than guessed.
 */
export interface HeadlessShaderPass {
  /** Fragment output MUST be premultiplied RGBA, matching the canvas stage contract. */
  readonly fragmentSource: string;
  readonly features?: readonly HeadlessShaderFeature[];
  readonly uniforms?: Readonly<Record<string, HeadlessUniformValue>>;
}

export interface HeadlessShaderRenderInput {
  readonly time: number;
  readonly delta: number;
  readonly seed?: number;
  /** Snapshot of the accumulated painter target at this exact caller-selected position. */
  readonly screenTexture?: HeadlessEffectTarget;
}

export interface HeadlessShaderProducer {
  readonly target: HeadlessEffectTarget;
  /** Compile and cache the GPU pass before the caller’s frame-critical path. */
  warmUp(): HeadlessEffectResult<void>;
  resize(width: number, height: number): HeadlessEffectResult<void>;
  render(
    input: HeadlessShaderRenderInput,
  ): HeadlessEffectResult<HeadlessEffectTarget>;
  /** Execute by snapshotting an executor's current framebuffer, then replace it. */
  renderScreen(
    input: HeadlessShaderRenderInput,
    context: WebglEffectTargetContext,
  ): HeadlessEffectResult<void>;
  /** Delete ordinary live-context resources; the producer remains reusable. */
  invalidate(): void;
  /** Context-loss only: discard names without issuing GL calls. */
  invalidateContextLoss(): void;
  dispose(): void;
}

/** Numeric values accepted by the existing Godot shader compiler. */
export type HeadlessGodotShaderValue = number | readonly number[];

/**
 * DOM-free inputs for the same canvas_item compiler used by the HTML runtime.
 * Textures deliberately name stage targets, never URLs: loading/decoding is an
 * HTML concern and an unresolved source is a typed refusal instead of a blank
 * approximation.
 */
export interface HeadlessGodotShaderPass {
  readonly source: string;
  readonly texture?: HeadlessTextureInput;
  readonly samplers?: Readonly<Record<string, HeadlessTextureInput>>;
  readonly uniforms?: Readonly<Record<string, HeadlessGodotShaderValue>>;
  readonly modulate?: readonly [number, number, number, number];
  readonly uvFit?: readonly [number, number];
  readonly uvWindow?: readonly [number, number, number, number];
}

export interface HeadlessGodotShaderRenderInput
  extends HeadlessShaderRenderInput {
  /** Node rect in normalized stage coordinates, for SCREEN_UV. */
  readonly screenRect?: readonly [number, number, number, number];
}

export interface HeadlessGodotShaderProducer {
  readonly target: HeadlessEffectTarget;
  /** The source render_mode blend, for the caller's surrounding canvas draw. */
  readonly blend: GodotBlendMode;
  warmUp(): HeadlessEffectResult<void>;
  resize(width: number, height: number): HeadlessEffectResult<void>;
  render(
    input: HeadlessGodotShaderRenderInput,
  ): HeadlessEffectResult<HeadlessEffectTarget>;
  renderScreen(
    input: HeadlessGodotShaderRenderInput,
    context: WebglEffectTargetContext,
  ): HeadlessEffectResult<void>;
  invalidate(): void;
  invalidateContextLoss(): void;
  dispose(): void;
}

export interface HeadlessParticleFeatures {
  /** Only a point emitter is implemented in this first reusable GPU path. */
  readonly emissionShape?: "point" | "box" | "circle";
  readonly collision?: boolean;
  readonly attractors?: boolean;
  readonly textureAtlas?: boolean;
}

/** Deterministic, stateless procedural point-particle subset. */
export interface HeadlessParticleParameters {
  readonly maxParticles: number;
  readonly emissionRate: number;
  readonly lifetimeSeconds: number;
  readonly position: readonly [number, number];
  readonly directionRadians: number;
  readonly spreadRadians: number;
  readonly speedMin: number;
  readonly speedMax: number;
  readonly gravity: readonly [number, number];
  /** Straight RGBA 0..1; the GPU pass premultiplies before writing to its target. */
  readonly startColor: readonly [number, number, number, number];
  /** Straight RGBA 0..1; the GPU pass premultiplies before writing to its target. */
  readonly endColor: readonly [number, number, number, number];
  readonly startSizePx: number;
  readonly endSizePx: number;
  readonly features?: HeadlessParticleFeatures;
}

export interface HeadlessParticleRenderInput {
  readonly time: number;
  readonly delta: number;
  readonly seed: number;
}

export interface HeadlessParticleProducer {
  readonly target: HeadlessEffectTarget;
  /** Compile and cache the GPU pass before the caller’s frame-critical path. */
  warmUp(): HeadlessEffectResult<void>;
  resize(width: number, height: number): HeadlessEffectResult<void>;
  /** Re-evaluates from explicit inputs; it owns neither stateful simulation nor a timer. */
  render(
    input: HeadlessParticleRenderInput,
  ): HeadlessEffectResult<HeadlessEffectTarget>;
  invalidate(): void;
  invalidateContextLoss(): void;
  dispose(): void;
}

/** Caller-owned semantic storage. Supplying this keeps particle state and bytes reusable across producers. */
export interface GodotParticleScratch {
  /** Render-only fields intentionally live beside the portable simulation state. */
  readonly config: ParticleRenderConfig;
  readonly state: ParticleSystemState;
  readonly instances: InstanceBuffer;
}

/** Allocate reusable, DOM-free simulation and instance storage for a normalized Godot particle spec. */
export function createGodotParticleScratch(
  config: ParticleRenderConfig | Partial<ParticleRenderConfig>,
  maxInstances?: number,
): GodotParticleScratch {
  const normalized = normalizeParticleRenderConfig(config);
  return {
    config: normalized,
    state: createParticleState(normalized, maxInstances),
    instances: new InstanceBuffer(
      Math.max(1, maxInstances ?? normalized.amount),
    ),
  };
}

/** Explicit live stage textures; no URL decoding, loading, or foreign GL texture ownership is accepted. */
export interface HeadlessGodotParticlePass {
  /** Omit when scratch is supplied: then scratch owns the normalized config. */
  readonly config?: ParticleRenderConfig | Partial<ParticleRenderConfig>;
  readonly spriteTexture?: HeadlessTextureInput;
  readonly lutTexture?: HeadlessTextureInput;
  readonly maskTexture?: HeadlessTextureInput;
  /** Declared material capabilities are refused rather than silently approximated. */
  readonly features?: Readonly<{
    collision?: boolean;
    attractors?: boolean;
    trails?: boolean;
    customMaterial?: boolean;
  }>;
  readonly scratch?: GodotParticleScratch;
}

export interface HeadlessGodotParticleRenderInput {
  /** Renderer-selected local emitter placement; never part of simulation state. */
  readonly origin?: readonly [number, number];
  readonly time: number;
  readonly delta: number;
  readonly emitting: boolean;
  /** Reset state at this exact caller-selected frame; no producer clock is consulted. */
  readonly restart?: boolean;
}

/**
 * Per-draw local-to-framebuffer similarity transform in Godot Transform2D
 * order `[xx, xy, yx, yy, originX, originY]`. Omit for identity. A direct
 * particle pass refuses skew and non-uniform scale rather than deforming a
 * sprite whose renderer only has scalar rotation and independent local size.
 */
export interface HeadlessGodotParticleDirectRenderInput
  extends HeadlessGodotParticleRenderInput {
  readonly transform?: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  /**
   * Straight inherited CanvasItem RGBA. Each component multiplies the matching
   * particle instance component before the shared renderer premultiplies it.
   */
  readonly modulate?: readonly [number, number, number, number];
}

export interface HeadlessGodotParticleProducer {
  readonly target: HeadlessEffectTarget;
  readonly scratch: GodotParticleScratch;
  warmUp(): HeadlessEffectResult<void>;
  resize(width: number, height: number): HeadlessEffectResult<void>;
  render(
    input: HeadlessGodotParticleRenderInput,
  ): HeadlessEffectResult<HeadlessEffectTarget>;
  invalidate(): void;
  invalidateContextLoss(): void;
  dispose(): void;
}

/**
 * A Godot-particle producer that paints into the canvas executor's live target.
 * It allocates no per-system target texture or compositor FBO.
 */
export interface HeadlessGodotParticleDirectPass {
  readonly scratch: GodotParticleScratch;
  warmUp(): HeadlessEffectResult<void>;
  draw(
    input: HeadlessGodotParticleDirectRenderInput,
    context: WebglEffectTargetContext,
  ): HeadlessEffectResult<void>;
  invalidate(): void;
  invalidateContextLoss(): void;
  dispose(): void;
}

/** Explicit painter-position copy of an accumulated target. */
export interface HeadlessScreenSampleCommand {
  readonly source: HeadlessEffectTarget;
  readonly destination: HeadlessEffectTarget;
  readonly filter?: "nearest" | "linear";
}

export interface HeadlessEffectsStage {
  readonly gl: WebGL2RenderingContext;
  createShaderProducer(
    pass: HeadlessShaderPass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessShaderProducer>;
  /** Compile the shared Godot canvas_item semantic engine without DOM ownership. */
  createGodotShaderProducer(
    pass: HeadlessGodotShaderPass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessGodotShaderProducer>;
  createParticleProducer(
    parameters: HeadlessParticleParameters,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessParticleProducer>;
  createGodotParticleProducer(
    pass: HeadlessGodotParticlePass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessGodotParticleProducer>;
  /** Create a direct painter pass; it never creates a system target or copy surface. */
  createGodotParticleDirectPass(
    pass: HeadlessGodotParticlePass,
  ): HeadlessEffectResult<HeadlessGodotParticleDirectPass>;
  /**
   * Execute a copy at the call site’s draw-list position.  A same-target copy is
   * routed through a stage-owned snapshot, never a read/write feedback loop.
   */
  executeScreenSample(
    command: HeadlessScreenSampleCommand,
  ): HeadlessEffectResult<void>;
  /** Delete ordinary live-context resources; producers remain reusable. */
  invalidate(): void;
  /** Drop dead GL handles after context loss without issuing delete calls. */
  invalidateContextLoss(): void;
  /** Delete every stage-owned GL handle while the context is live. */
  dispose(): void;
}

interface MutableTarget extends HeadlessEffectTarget {
  texture: WebGLTexture | null;
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
}

interface ProgramState {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  locations: Map<string, WebGLUniformLocation | null>;
}

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
const vec2 POSITIONS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  vec2 position = POSITIONS[gl_VertexID];
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const GODOT_DEFAULT_FIT: readonly [number, number] = [1, 1];
const GODOT_DEFAULT_WINDOW: readonly [number, number, number, number] = [
  0, 0, 1, 1,
];
const GODOT_DEFAULT_MODULATE: readonly [number, number, number, number] = [
  1, 1, 1, 1,
];
const GODOT_DEFAULT_SCREEN_RECT: readonly [number, number, number, number] = [
  0, 0, 1, 1,
];

const PARTICLE_VERTEX = `#version 300 es
uniform float u_time;
uniform float u_delta;
uniform float u_seed;
uniform float u_lifetime;
uniform float u_emission_rate;
uniform float u_max_particles;
uniform vec2 u_position;
uniform float u_direction;
uniform float u_spread;
uniform vec2 u_speed;
uniform vec2 u_gravity;
uniform vec2 u_resolution;
uniform vec2 u_size;
out float v_progress;
out float v_alive;
float hash(float value) { return fract(sin(value) * 43758.5453123); }
void main() {
  float id = float(gl_VertexID);
  float emission = max(u_emission_rate, 0.0001);
  float active = min(u_max_particles, ceil(emission * u_lifetime));
  float period = active / emission;
  float now = max(0.0, u_time + u_delta);
  float birth = floor((now * emission - id) / active) * period + id / emission;
  float age = now - birth;
  float effectiveLifetime = min(u_lifetime, period);
  float progress = clamp(age / effectiveLifetime, 0.0, 1.0);
  float angle = u_direction + (hash(id + u_seed) - 0.5) * u_spread;
  float speed = mix(u_speed.x, u_speed.y, hash(id * 7.0 + u_seed));
  vec2 velocity = vec2(cos(angle), sin(angle)) * speed;
  vec2 pixel = u_position + velocity * age + 0.5 * u_gravity * age * age;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  gl_PointSize = mix(u_size.x, u_size.y, progress);
  v_progress = progress;
  v_alive = step(0.0, birth) * step(0.0, age) * step(age, effectiveLifetime);
}`;

/** Safe ceiling for the stateless point-particle subset. Larger systems are refused. */
export const MAX_HEADLESS_PARTICLES = 16_384;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_start_color;
uniform vec4 u_end_color;
in float v_progress;
in float v_alive;
out vec4 fragColor;
void main() {
  if (v_alive < 0.5) discard;
  vec2 centered = gl_PointCoord * 2.0 - 1.0;
  float coverage = smoothstep(1.0, 0.7, dot(centered, centered));
  vec4 color = mix(u_start_color, u_end_color, v_progress);
  fragColor = vec4(color.rgb * color.a, color.a) * coverage;
}`;

function ok<T>(value: T): HeadlessEffectResult<T> {
  return { ok: true, value };
}

function fail<T>(
  code: HeadlessEffectDiagnosticCode,
  message: string,
  feature?: string,
): HeadlessEffectResult<T> {
  return { ok: false, diagnostic: { code, message, feature } };
}

function targetDimensions(
  width: number,
  height: number,
): [number, number] | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
}

interface DirectParticleTransform {
  readonly xx: number;
  readonly xy: number;
  readonly yx: number;
  readonly yy: number;
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
  readonly rotation: number;
}

function directParticleTransform(
  transform: HeadlessGodotParticleDirectRenderInput["transform"],
): DirectParticleTransform | null {
  const values = transform ?? [1, 0, 0, 1, 0, 0];
  if (!values.every(Number.isFinite)) return null;
  const [xx, xy, yx, yy, originX, originY] = values;
  const xLength = Math.hypot(xx, xy);
  const yLength = Math.hypot(yx, yy);
  const tolerance = Math.max(1, xLength * yLength) * 1e-6;
  if (
    xLength <= 1e-9 ||
    Math.abs(xLength - yLength) > tolerance ||
    Math.abs(xx * yx + xy * yy) > tolerance ||
    xx * yy - xy * yx <= 0
  )
    return null;
  return {
    xx,
    xy,
    yx,
    yy,
    originX,
    originY,
    scale: xLength,
    rotation: Math.atan2(xy, xx),
  };
}

function directParticleModulate(
  modulate: HeadlessGodotParticleDirectRenderInput["modulate"],
): readonly [number, number, number, number] | null {
  const value = modulate ?? [1, 1, 1, 1];
  return value.every(Number.isFinite)
    ? [value[0], value[1], value[2], value[3]]
    : null;
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): HeadlessEffectResult<ProgramState> {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return fail(
      "RESOURCE_ALLOCATION_FAILED",
      "WebGL could not allocate an effect shader.",
    );
  }
  gl.shaderSource(vertex, vertexSource);
  gl.shaderSource(fragment, fragmentSource);
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  if (
    !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
  ) {
    const log =
      gl.getShaderInfoLog(vertex) ||
      gl.getShaderInfoLog(fragment) ||
      "unknown compiler error";
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return fail("SHADER_COMPILE_FAILED", log);
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return fail(
      "RESOURCE_ALLOCATION_FAILED",
      "WebGL could not allocate an effect program.",
    );
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "unknown linker error";
    gl.deleteProgram(program);
    return fail("SHADER_COMPILE_FAILED", log);
  }
  const vao = gl.createVertexArray();
  if (!vao) {
    gl.deleteProgram(program);
    return fail(
      "RESOURCE_ALLOCATION_FAILED",
      "WebGL could not allocate an effect vertex array.",
    );
  }
  return ok({ program, vao, locations: new Map() });
}

function destroyProgram(
  gl: WebGL2RenderingContext,
  program: ProgramState | null,
): void {
  if (!program) return;
  gl.deleteVertexArray(program.vao);
  gl.deleteProgram(program.program);
}

function shaderDiagnostic(
  pass: HeadlessShaderPass,
): HeadlessEffectDiagnostic | null {
  const known = new Set<string>([
    "screen-texture",
    "time",
    "delta",
    "seed",
    "external-textures",
    "multiple-render-targets",
    "transform-feedback",
    "godot-source",
  ]);
  const seen = new Set<string>();
  for (const feature of pass.features ?? []) {
    if (!known.has(feature))
      return {
        code: "UNSUPPORTED_SHADER_FEATURE",
        message: `Unknown headless shader capability ${feature}.`,
        feature,
      };
    if (seen.has(feature))
      return {
        code: "UNSUPPORTED_SHADER_FEATURE",
        message: `Duplicate headless shader capability ${feature}.`,
        feature,
      };
    seen.add(feature);
  }
  for (const [name, value] of Object.entries(pass.uniforms ?? {})) {
    const components = typeof value === "number" ? [value] : value;
    if (
      !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) ||
      (typeof value !== "number" && (value.length < 2 || value.length > 4)) ||
      !Array.from(components).every(Number.isFinite)
    ) {
      return {
        code: "UNSUPPORTED_SHADER_FEATURE",
        message:
          "Shader uniform names and values must be finite GLSL scalar/vector values.",
        feature: `uniform:${name}`,
      };
    }
  }
  const unsupported = new Set<HeadlessShaderFeature>([
    "external-textures",
    "multiple-render-targets",
    "transform-feedback",
    "godot-source",
  ]);
  const requested = pass.features?.find((feature) => unsupported.has(feature));
  if (requested) {
    return {
      code: "UNSUPPORTED_SHADER_FEATURE",
      message: `Headless shader passes do not support ${requested}.`,
      feature: requested,
    };
  }
  if (
    !/^\s*#version\s+300\s+es\b/m.test(pass.fragmentSource) ||
    !/\bvoid\s+main\s*\(/.test(pass.fragmentSource)
  ) {
    return {
      code: "UNSUPPORTED_SHADER_FEATURE",
      message:
        "A headless shader pass must be a complete GLSL ES 3 fragment shader.",
      feature: "raw-glsl300es",
    };
  }
  const samplers = [
    ...pass.fragmentSource.matchAll(/uniform\s+sampler\w+\s+(\w+)/g),
  ].map((match) => match[1]);
  if (samplers.some((name) => name !== "u_screenTexture")) {
    return {
      code: "UNSUPPORTED_SHADER_FEATURE",
      message:
        "Only the explicit u_screenTexture sampler is supported by this headless pass.",
      feature: "external-textures",
    };
  }
  if (
    samplers.includes("u_screenTexture") &&
    !pass.features?.includes("screen-texture")
  ) {
    return {
      code: "UNSUPPORTED_SHADER_FEATURE",
      message:
        "u_screenTexture requires the explicit screen-texture capability declaration.",
      feature: "screen-texture",
    };
  }
  return null;
}

function particleDiagnostic(
  parameters: HeadlessParticleParameters,
): HeadlessEffectDiagnostic | null {
  const features = parameters.features;
  if (features?.emissionShape && features.emissionShape !== "point") {
    return {
      code: "UNSUPPORTED_PARTICLE_FEATURE",
      message: "Only point particle emission is supported.",
      feature: `emissionShape:${features.emissionShape}`,
    };
  }
  for (const feature of ["collision", "attractors", "textureAtlas"] as const) {
    if (features?.[feature]) {
      return {
        code: "UNSUPPORTED_PARTICLE_FEATURE",
        message: `Particle ${feature} is not supported by the stateless headless path.`,
        feature,
      };
    }
  }
  const numbers = [
    parameters.maxParticles,
    parameters.emissionRate,
    parameters.lifetimeSeconds,
    parameters.position[0],
    parameters.position[1],
    parameters.directionRadians,
    parameters.spreadRadians,
    parameters.speedMin,
    parameters.speedMax,
    parameters.gravity[0],
    parameters.gravity[1],
    parameters.startSizePx,
    parameters.endSizePx,
    ...parameters.startColor,
    ...parameters.endColor,
  ];
  if (!numbers.every(Number.isFinite)) {
    return {
      code: "UNSUPPORTED_PARTICLE_FEATURE",
      message: "Particle parameters must all be finite numbers.",
      feature: "parameters",
    };
  }
  if (
    !Number.isInteger(parameters.maxParticles) ||
    parameters.maxParticles <= 0 ||
    parameters.maxParticles > MAX_HEADLESS_PARTICLES ||
    parameters.emissionRate <= 0 ||
    parameters.lifetimeSeconds <= 0 ||
    parameters.speedMin < 0 ||
    parameters.speedMax < parameters.speedMin ||
    parameters.startSizePx < 0 ||
    parameters.endSizePx < 0 ||
    parameters.startColor.some((value) => value < 0 || value > 1) ||
    parameters.endColor.some((value) => value < 0 || value > 1)
  ) {
    return {
      code: "UNSUPPORTED_PARTICLE_FEATURE",
      message: "Particle counts, emission rate, and lifetime must be positive.",
      feature: "parameters",
    };
  }
  return null;
}

function renderInputDiagnostic(
  input: HeadlessShaderRenderInput | HeadlessParticleRenderInput,
): HeadlessEffectDiagnostic | null {
  if (
    !Number.isFinite(input.time) ||
    !Number.isFinite(input.delta) ||
    input.time < 0 ||
    input.delta < 0 ||
    ("seed" in input &&
      input.seed !== undefined &&
      !Number.isFinite(input.seed))
  ) {
    return {
      code: "INVALID_RENDER_INPUT",
      message:
        "Effect time, delta, and seed must be finite; time and delta must be non-negative.",
      feature: "render-input",
    };
  }
  return null;
}

function applyGodotBlend(
  gl: WebGL2RenderingContext,
  blend: GodotBlendMode,
): void {
  gl.enable(gl.BLEND);
  if (blend === "sub") {
    gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    return;
  }
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
  if (blend === "add") {
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    return;
  }
  if (blend === "mul") {
    gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.DST_ALPHA, gl.ZERO);
    return;
  }
  gl.blendFuncSeparate(
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );
}

/** Create a DOM-free owner for effect FBOs and their ordered GPU passes. */
export function createHeadlessEffectsStage(
  gl: WebGL2RenderingContext,
): HeadlessEffectsStage {
  const targets = new Set<MutableTarget>();
  const invalidatables = new Set<{
    invalidate(): void;
    invalidateContextLoss(): void;
    dispose(): void;
  }>();
  let disposed = false;
  let snapshot: MutableTarget | null = null;
  let opaqueWhite: MutableTarget | null = null;
  let opaqueWhiteFilled = false;
  let opaqueWhiteResult: HeadlessEffectResult<MutableTarget> | null = null;

  function state<T>(): HeadlessEffectResult<T> | null {
    if (disposed)
      return fail("DISPOSED", "The headless effects stage has been disposed.");
    if (gl.isContextLost())
      return fail(
        "CONTEXT_LOST",
        "The WebGL context is lost; invalidate and wait for restoration.",
      );
    return null;
  }

  function makeTarget(): MutableTarget {
    const target: MutableTarget = {
      texture: null,
      framebuffer: null,
      width: 0,
      height: 0,
    };
    targets.add(target);
    return target;
  }

  function discardTarget(target: MutableTarget, callGl: boolean): void {
    if (callGl) {
      if (target.framebuffer) gl.deleteFramebuffer(target.framebuffer);
      if (target.texture) gl.deleteTexture(target.texture);
    }
    target.texture = null;
    target.framebuffer = null;
    target.width = 0;
    target.height = 0;
  }

  function resizeTarget(
    target: MutableTarget,
    width: number,
    height: number,
  ): HeadlessEffectResult<void> {
    const current = state<void>();
    if (current) return current;
    const dimensions = targetDimensions(width, height);
    if (!dimensions)
      return fail(
        "INVALID_DIMENSIONS",
        "Effect targets need finite dimensions greater than zero.",
      );
    const [nextWidth, nextHeight] = dimensions;
    if (
      target.texture &&
      target.framebuffer &&
      target.width === nextWidth &&
      target.height === nextHeight
    )
      return ok(undefined);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      return fail(
        "RESOURCE_ALLOCATION_FAILED",
        "WebGL could not allocate an RGBA8 effect target.",
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      nextWidth,
      nextHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    const complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return fail(
        "FRAMEBUFFER_INCOMPLETE",
        "WebGL rejected the RGBA8 effect framebuffer.",
      );
    }
    discardTarget(target, true);
    target.texture = texture;
    target.framebuffer = framebuffer;
    target.width = nextWidth;
    target.height = nextHeight;
    return ok(undefined);
  }

  function copy(
    source: MutableTarget,
    destination: MutableTarget,
    filter: "nearest" | "linear",
  ): void {
    const previousRead = gl.getParameter(
      gl.READ_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const previousDraw = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    try {
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination.framebuffer);
      gl.blitFramebuffer(
        0,
        0,
        source.width,
        source.height,
        0,
        0,
        destination.width,
        destination.height,
        gl.COLOR_BUFFER_BIT,
        filter === "linear" ? gl.LINEAR : gl.NEAREST,
      );
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
    }
  }

  function snapshotFor(
    target: MutableTarget,
  ): HeadlessEffectResult<MutableTarget> {
    if (!snapshot) snapshot = makeTarget();
    const resized = resizeTarget(snapshot, target.width, target.height);
    if (!resized.ok) return resized;
    copy(target, snapshot, "nearest");
    return ok(snapshot);
  }

  /** A stage-owned, opaque TEXTURE fallback for ColorRect/pure-fill shaders. */
  function whiteTarget(): HeadlessEffectResult<MutableTarget> {
    if (!opaqueWhite) opaqueWhite = makeTarget();
    if (!opaqueWhite.texture || !opaqueWhite.framebuffer) {
      const resized = resizeTarget(opaqueWhite, 1, 1);
      if (!resized.ok) return resized;
      opaqueWhiteFilled = false;
    }
    if (opaqueWhiteFilled && opaqueWhiteResult) return opaqueWhiteResult;
    const previous = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, opaqueWhite.framebuffer);
      gl.viewport(0, 0, 1, 1);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      opaqueWhiteFilled = true;
      opaqueWhiteResult = ok(opaqueWhite);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    }
    return ok(opaqueWhite);
  }

  function snapshotFramebuffer(
    framebuffer: WebGLFramebuffer | null,
    width: number,
    height: number,
  ): HeadlessEffectResult<MutableTarget> {
    if (!snapshot) snapshot = makeTarget();
    const resized = resizeTarget(snapshot, width, height);
    if (!resized.ok) return resized;
    const previousRead = gl.getParameter(
      gl.READ_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const previousDraw = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    try {
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, snapshot.framebuffer);
      gl.blitFramebuffer(
        0,
        0,
        width,
        height,
        0,
        0,
        width,
        height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
    }
    return ok(snapshot);
  }

  function targetFor(value: HeadlessEffectTarget): MutableTarget | null {
    return targets.has(value as MutableTarget)
      ? (value as MutableTarget)
      : null;
  }

  interface TextureBinding {
    readonly texture: WebGLTexture;
    readonly width: number;
    readonly height: number;
    readonly owned: MutableTarget | null;
  }

  function textureInputFor(value: HeadlessTextureInput): TextureBinding | null {
    const owned = targetFor(value as HeadlessEffectTarget);
    if (owned?.texture && owned.width > 0 && owned.height > 0)
      return {
        texture: owned.texture,
        width: owned.width,
        height: owned.height,
        owned,
      };
    const borrowed = value as WebglTextureInput;
    if (
      !borrowed.texture ||
      !Number.isFinite(borrowed.width) ||
      !Number.isFinite(borrowed.height) ||
      borrowed.width <= 0 ||
      borrowed.height <= 0
    )
      return null;
    return {
      texture: borrowed.texture,
      width: borrowed.width,
      height: borrowed.height,
      owned: null,
    };
  }

  function uniformLocation(
    program: ProgramState,
    name: string,
  ): WebGLUniformLocation | null {
    const known = program.locations.get(name);
    if (known !== undefined) return known;
    if (program.locations.has(name)) return null;
    const location = gl.getUniformLocation(program.program, name);
    program.locations.set(name, location);
    return location;
  }

  function applyUniform(
    program: ProgramState,
    name: string,
    value: HeadlessUniformValue,
  ): void {
    const location = uniformLocation(program, name);
    if (location === null) return;
    if (typeof value === "number") gl.uniform1f(location, value);
    else if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
    else if (value.length === 3)
      gl.uniform3f(location, value[0], value[1], value[2]);
    else gl.uniform4f(location, value[0], value[1], value[2], value[3]);
  }

  function createShaderProducer(
    pass: HeadlessShaderPass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessShaderProducer> {
    const invalid = state<HeadlessShaderProducer>();
    if (invalid) return invalid;
    const diagnostic = shaderDiagnostic(pass);
    if (diagnostic) return { ok: false, diagnostic };
    const target = makeTarget();
    const allocated = resizeTarget(target, width, height);
    if (!allocated.ok) {
      targets.delete(target);
      return allocated;
    }
    let requestedWidth = target.width;
    let requestedHeight = target.height;
    const resolution: [number, number] = [target.width, target.height];
    const uniformEntries = Object.entries(pass.uniforms ?? {});
    const rendered = ok<HeadlessEffectTarget>(target);
    let program: ProgramState | null = null;
    let producerDisposed = false;
    const needsScreen = pass.features?.includes("screen-texture") === true;
    function ensureProgram(): HeadlessEffectResult<ProgramState> {
      if (program) return ok(program);
      const compiled = compileProgram(
        gl,
        FULLSCREEN_VERTEX,
        pass.fragmentSource,
      );
      if (compiled.ok) program = compiled.value;
      return compiled;
    }
    const producer: HeadlessShaderProducer = {
      target,
      warmUp() {
        const current = state<void>();
        if (current) return current;
        if (producerDisposed)
          return fail("DISPOSED", "The shader producer has been disposed.");
        const ready = ensureProgram();
        return ready.ok ? ok(undefined) : ready;
      },
      resize(nextWidth, nextHeight) {
        if (producerDisposed)
          return fail("DISPOSED", "The shader producer has been disposed.");
        const resized = resizeTarget(target, nextWidth, nextHeight);
        if (resized.ok) {
          requestedWidth = target.width;
          requestedHeight = target.height;
          resolution[0] = target.width;
          resolution[1] = target.height;
        }
        return resized;
      },
      render(input) {
        const inputDiagnostic = renderInputDiagnostic(input);
        if (inputDiagnostic) return { ok: false, diagnostic: inputDiagnostic };
        const current = state<HeadlessEffectTarget>();
        if (current) return current;
        if (producerDisposed)
          return fail("DISPOSED", "The shader producer has been disposed.");
        if (!target.texture || !target.framebuffer) {
          const reallocated = resizeTarget(
            target,
            requestedWidth,
            requestedHeight,
          );
          if (!reallocated.ok) return reallocated;
        }
        let screen: MutableTarget | null = null;
        if (needsScreen) {
          if (!input.screenTexture)
            return fail(
              "SCREEN_TEXTURE_REQUIRED",
              "This shader pass declared screen-texture but no accumulated target was supplied.",
            );
          screen = targetFor(input.screenTexture);
          if (!screen?.texture || !screen.framebuffer)
            return fail(
              "FOREIGN_TARGET",
              "screenTexture must be a live target owned by this headless effects stage.",
            );
          if (screen === target) {
            const captured = snapshotFor(screen);
            if (!captured.ok) return captured;
            screen = captured.value;
          }
        }
        const ready = ensureProgram();
        if (!ready.ok) return ready;
        const previousFramebuffer = gl.getParameter(
          gl.FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.viewport(0, 0, target.width, target.height);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(ready.value.program);
          gl.bindVertexArray(ready.value.vao);
          applyUniform(ready.value, "u_time", input.time);
          applyUniform(ready.value, "u_delta", input.delta);
          applyUniform(ready.value, "u_seed", input.seed ?? 0);
          applyUniform(ready.value, "u_resolution", resolution);
          for (const [name, value] of uniformEntries)
            applyUniform(ready.value, name, value);
          if (screen) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, screen.texture);
            const location = uniformLocation(ready.value, "u_screenTexture");
            if (location) gl.uniform1i(location, 0);
          }
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindVertexArray(null);
          return rendered;
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        }
      },
      renderScreen(input, context) {
        const inputDiagnostic = renderInputDiagnostic(input);
        if (inputDiagnostic) return { ok: false, diagnostic: inputDiagnostic };
        if (!needsScreen)
          return fail(
            "UNSUPPORTED_SHADER_FEATURE",
            "Only a screen-texture pass can be recorded as a screen effect.",
            "screen-texture",
          );
        if (context.damage)
          return fail(
            "UNSUPPORTED_SHADER_FEATURE",
            "Screen-dependent effects decline partial damage execution.",
            "partial-damage",
          );
        const resized = producer.resize(context.width, context.height);
        if (!resized.ok) return resized;
        const captured = snapshotFramebuffer(
          context.framebuffer,
          context.width,
          context.height,
        );
        if (!captured.ok) return captured;
        const renderedScreen = producer.render({
          time: input.time,
          delta: input.delta,
          seed: input.seed,
          screenTexture: captured.value,
        });
        if (!renderedScreen.ok) return renderedScreen;
        const previousRead = gl.getParameter(
          gl.READ_FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        const previousDraw = gl.getParameter(
          gl.DRAW_FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, context.framebuffer);
          // A screen pass is a full-target replacement, but its active canvas
          // clip still bounds where that replacement may write.
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(
            context.scissor.x,
            context.scissor.y,
            context.scissor.width,
            context.scissor.height,
          );
          gl.blitFramebuffer(
            0,
            0,
            target.width,
            target.height,
            0,
            0,
            context.width,
            context.height,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
          );
        } finally {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
        }
        return ok(undefined);
      },
      invalidate() {
        destroyProgram(gl, program);
        program = null;
        discardTarget(target, true);
      },
      invalidateContextLoss() {
        program = null;
        discardTarget(target, false);
      },
      dispose() {
        if (!producerDisposed) {
          producerDisposed = true;
          destroyProgram(gl, program);
          program = null;
          discardTarget(target, true);
          targets.delete(target);
          invalidatables.delete(producer);
        }
      },
    };
    invalidatables.add(producer);
    return ok(producer);
  }

  function createGodotShaderProducer(
    pass: HeadlessGodotShaderPass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessGodotShaderProducer> {
    const invalid = state<HeadlessGodotShaderProducer>();
    if (invalid) return invalid;
    let transpiled: TranspiledShader;
    try {
      transpiled = transpileGodotShader(pass.source);
    } catch (error) {
      return fail(
        "UNSUPPORTED_SHADER_FEATURE",
        error instanceof UnsupportedShaderError
          ? error.message
          : `Godot shader transpilation failed: ${error instanceof Error ? error.message : String(error)}`,
        "godot-source",
      );
    }
    const suppliedSamplers = { ...(pass.samplers ?? {}) };
    for (const sampler of transpiled.samplers) {
      if (!suppliedSamplers[sampler.name])
        return fail(
          "UNSUPPORTED_SHADER_FEATURE",
          `Godot sampler ${sampler.name} needs an explicit stage-owned target.`,
          `sampler:${sampler.name}`,
        );
      if (sampler.repeat)
        return fail(
          "UNSUPPORTED_SHADER_FEATURE",
          `Godot sampler ${sampler.name} requests repeat sampling, which stage targets cannot mutate.`,
          `sampler:${sampler.name}:repeat`,
        );
    }
    for (const uniform of transpiled.uniforms) {
      if (
        uniform.arrayLength ||
        !["float", "int", "bool", "vec2", "vec3", "vec4"].includes(uniform.type)
      )
        return fail(
          "UNSUPPORTED_SHADER_FEATURE",
          `Godot uniform ${uniform.name} (${uniform.type}) is not supported headlessly.`,
          `uniform:${uniform.name}`,
        );
    }
    const componentCount = (type: string): number =>
      type === "vec2" ? 2 : type === "vec3" ? 3 : type === "vec4" ? 4 : 1;
    const uniformValues: Record<string, HeadlessGodotShaderValue> = {};
    for (const uniform of transpiled.uniforms) {
      const raw = pass.uniforms?.[uniform.name] ?? uniform.default;
      if (raw === undefined) continue;
      const expected = componentCount(uniform.type);
      const values = typeof raw === "number" ? null : raw;
      if (
        (expected === 1 && typeof raw !== "number") ||
        (expected !== 1 && (!values || values.length !== expected)) ||
        (typeof raw === "number" && !Number.isFinite(raw)) ||
        (values && !values.every(Number.isFinite))
      )
        return fail(
          "UNSUPPORTED_SHADER_FEATURE",
          `Godot uniform ${uniform.name} must be ${expected} finite numeric component${expected === 1 ? "" : "s"}.`,
          `uniform:${uniform.name}`,
        );
      uniformValues[uniform.name] = typeof raw === "number" ? raw : [...raw];
    }
    const fit: [number, number] = [...(pass.uvFit ?? GODOT_DEFAULT_FIT)];
    const window: [number, number, number, number] = [
      ...(pass.uvWindow ?? GODOT_DEFAULT_WINDOW),
    ];
    const modulate: [number, number, number, number] = [
      ...(pass.modulate ?? GODOT_DEFAULT_MODULATE),
    ];
    if (
      !fit.every(Number.isFinite) ||
      !window.every(Number.isFinite) ||
      !modulate.every(Number.isFinite)
    )
      return fail(
        "UNSUPPORTED_SHADER_FEATURE",
        "Godot shader fit, window, and modulate values must be finite.",
        "render-parameters",
      );
    const target = makeTarget();
    const allocated = resizeTarget(target, width, height);
    if (!allocated.ok) {
      targets.delete(target);
      return allocated;
    }
    let requestedWidth = target.width;
    let requestedHeight = target.height;
    let program: ProgramState | null = null;
    let producerDisposed = false;
    const rendered = ok<HeadlessEffectTarget>(target);
    const noScreen = ok<MutableTarget | null>(null);
    const texturePixelSize: [number, number] = [1, 1];
    const screenPixelSize: [number, number] = [1, 1];
    const screenOrigin: [number, number] = [0, 0];
    const screenSize: [number, number] = [1, 1];
    const ensureProgram = (): HeadlessEffectResult<ProgramState> => {
      if (program) return ok(program);
      const compiled = compileProgram(
        gl,
        FULLSCREEN_VERTEX,
        transpiled.fragmentGlsl,
      );
      if (compiled.ok) program = compiled.value;
      return compiled;
    };
    const stageTarget = (
      value: HeadlessTextureInput | undefined,
      label: string,
    ): HeadlessEffectResult<TextureBinding | null> => {
      if (!value) return ok(null);
      const texture = textureInputFor(value);
      return texture
        ? ok(texture)
        : fail(
            "FOREIGN_TARGET",
            `${label} must be a live same-context stage target or texture handle.`,
          );
    };
    const suppliedTexture = stageTarget(pass.texture, "TEXTURE");
    if (!suppliedTexture.ok) {
      discardTarget(target, true);
      targets.delete(target);
      return suppliedTexture;
    }
    const baseTexture = suppliedTexture.value;
    const samplerTargets: TextureBinding[] = [];
    for (const sampler of transpiled.samplers) {
      const supplied = stageTarget(
        suppliedSamplers[sampler.name],
        `sampler:${sampler.name}`,
      );
      if (!supplied.ok || !supplied.value) {
        discardTarget(target, true);
        targets.delete(target);
        return supplied.ok
          ? fail(
              "UNSUPPORTED_SHADER_FEATURE",
              `Godot sampler ${sampler.name} needs an explicit target.`,
              `sampler:${sampler.name}`,
            )
          : supplied;
      }
      samplerTargets.push(supplied.value);
    }
    const applyGodotUniform = (
      p: ProgramState,
      uniform: ShaderUniform,
    ): void => {
      const raw = uniformValues[uniform.name];
      const loc = uniformLocation(p, uniform.name);
      if (!loc) return;
      if (typeof raw === "number") {
        if (uniform.type === "float") gl.uniform1f(loc, raw);
        else if (uniform.type === "int" || uniform.type === "bool")
          gl.uniform1i(loc, Math.round(raw));
        return;
      }
      const values = raw ?? [];
      if (uniform.type === "float") gl.uniform1f(loc, 0);
      else if (uniform.type === "int" || uniform.type === "bool")
        gl.uniform1i(loc, 0);
      else if (uniform.type === "vec2")
        gl.uniform2f(loc, values[0] ?? 0, values[1] ?? 0);
      else if (uniform.type === "vec3")
        gl.uniform3f(loc, values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
      else
        gl.uniform4f(
          loc,
          values[0] ?? 0,
          values[1] ?? 0,
          values[2] ?? 0,
          values[3] ?? 0,
        );
    };
    const liveDependencies = ok(undefined);
    const dependenciesLive = (): HeadlessEffectResult<void> => {
      if (
        baseTexture &&
        (baseTexture.owned
          ? !targets.has(baseTexture.owned) ||
            !baseTexture.owned.texture ||
            !baseTexture.owned.framebuffer
          : typeof gl.isTexture === "function" &&
            !gl.isTexture(baseTexture.texture))
      )
        return fail(
          "FOREIGN_TARGET",
          "A Godot shader dependency is no longer a live stage-owned target.",
          "dependency",
        );
      for (let i = 0; i < samplerTargets.length; i += 1) {
        const dependency = samplerTargets[i];
        if (
          dependency.owned
            ? !targets.has(dependency.owned) ||
              !dependency.owned.texture ||
              !dependency.owned.framebuffer
            : typeof gl.isTexture === "function" &&
              !gl.isTexture(dependency.texture)
        )
          return fail(
            "FOREIGN_TARGET",
            "A Godot shader dependency is no longer a live stage-owned target.",
            "dependency",
          );
      }
      return liveDependencies;
    };
    const producer: HeadlessGodotShaderProducer = {
      target,
      blend: transpiled.blend,
      warmUp() {
        const current = state<void>();
        if (current) return current;
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot shader producer has been disposed.",
          );
        const ready = ensureProgram();
        return ready.ok ? ok(undefined) : ready;
      },
      resize(nextWidth, nextHeight) {
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot shader producer has been disposed.",
          );
        const resized = resizeTarget(target, nextWidth, nextHeight);
        if (resized.ok) {
          requestedWidth = target.width;
          requestedHeight = target.height;
        }
        return resized;
      },
      render(input) {
        const inputDiagnostic = renderInputDiagnostic(input);
        if (inputDiagnostic) return { ok: false, diagnostic: inputDiagnostic };
        if (input.screenRect && !input.screenRect.every(Number.isFinite))
          return fail(
            "INVALID_RENDER_INPUT",
            "Godot screenRect values must be finite.",
            "screen-rect",
          );
        const current = state<HeadlessEffectTarget>();
        if (current) return current;
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot shader producer has been disposed.",
          );
        if (!target.texture || !target.framebuffer) {
          const resized = resizeTarget(target, requestedWidth, requestedHeight);
          if (!resized.ok) return resized;
        }
        const dependencies = dependenciesLive();
        if (!dependencies.ok) return dependencies;
        const white = baseTexture ? null : whiteTarget();
        if (white && !white.ok) return white;
        const texture = baseTexture ?? white?.value;
        const screen = transpiled.usesScreenTexture
          ? stageTarget(input.screenTexture, "SCREEN_TEXTURE")
          : noScreen;
        if (!screen.ok) return screen;
        if (transpiled.usesScreenTexture && !screen.value)
          return fail(
            "SCREEN_TEXTURE_REQUIRED",
            "This Godot shader samples SCREEN_TEXTURE but no accumulated target was supplied.",
          );
        const screenTarget =
          screen.value === target ? snapshotFor(target) : screen;
        if (!screenTarget.ok) return screenTarget;
        const ready = ensureProgram();
        if (!ready.ok) return ready;
        const previous = gl.getParameter(
          gl.FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.viewport(0, 0, target.width, target.height);
          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(ready.value.program);
          gl.bindVertexArray(ready.value.vao);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture?.texture ?? null);
          const textureLoc = uniformLocation(ready.value, "TEXTURE");
          if (textureLoc) gl.uniform1i(textureLoc, 0);
          if (transpiled.usesTime)
            applyUniform(ready.value, "TIME", input.time);
          if (transpiled.usesTexturePixelSize) {
            texturePixelSize[0] = 1 / Math.max(1, texture?.width ?? 1);
            texturePixelSize[1] = 1 / Math.max(1, texture?.height ?? 1);
            applyUniform(ready.value, "TEXTURE_PIXEL_SIZE", texturePixelSize);
          }
          applyUniform(ready.value, "MODULATE", modulate);
          applyUniform(ready.value, "_godot_uv_fit", fit);
          applyUniform(ready.value, "_godot_uv_window", window);
          const rect = input.screenRect ?? GODOT_DEFAULT_SCREEN_RECT;
          if (transpiled.usesScreenUv) {
            screenOrigin[0] = rect[0];
            screenOrigin[1] = rect[1];
            screenSize[0] = rect[2];
            screenSize[1] = rect[3];
            applyUniform(ready.value, "_godot_screen_origin", screenOrigin);
            applyUniform(ready.value, "_godot_screen_size", screenSize);
          }
          if (screenTarget.value) {
            gl.activeTexture(gl.TEXTURE0 + 1);
            gl.bindTexture(gl.TEXTURE_2D, screenTarget.value.texture);
            const loc = uniformLocation(ready.value, "SCREEN_TEXTURE");
            if (loc) gl.uniform1i(loc, 1);
          }
          if (transpiled.usesScreenPixelSize) {
            screenPixelSize[0] =
              1 / Math.max(1, screenTarget.value?.width ?? target.width);
            screenPixelSize[1] =
              1 / Math.max(1, screenTarget.value?.height ?? target.height);
            applyUniform(ready.value, "SCREEN_PIXEL_SIZE", screenPixelSize);
          }
          let unit = 2;
          for (let i = 0; i < transpiled.samplers.length; i += 1) {
            const sampler = transpiled.samplers[i];
            const value = samplerTargets[i];
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, value.texture);
            const loc = uniformLocation(ready.value, sampler.name);
            if (loc) gl.uniform1i(loc, unit++);
          }
          for (const uniform of transpiled.uniforms)
            applyGodotUniform(ready.value, uniform);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindVertexArray(null);
          return rendered;
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        }
      },
      renderScreen(input, context) {
        if (!transpiled.usesScreenTexture)
          return fail(
            "UNSUPPORTED_SHADER_FEATURE",
            "Only a Godot SCREEN_TEXTURE shader can be recorded as a screen effect.",
            "screen-texture",
          );
        if (context.damage)
          return fail(
            "UNSUPPORTED_SHADER_FEATURE",
            "Screen-dependent effects decline partial damage execution.",
            "partial-damage",
          );
        const dependencies = dependenciesLive();
        if (!dependencies.ok) return dependencies;
        const rect = input.screenRect;
        if (
          !rect?.every(Number.isFinite) ||
          rect[0] < 0 ||
          rect[1] < 0 ||
          rect[2] <= 0 ||
          rect[3] <= 0 ||
          rect[0] + rect[2] > 1 ||
          rect[1] + rect[3] > 1
        )
          return fail(
            "UNSUPPORTED_SHADER_FEATURE",
            "Screen shaders need a finite, normalized axis-aligned screenRect.",
            "screen-rect",
          );
        const resized = producer.resize(context.width, context.height);
        if (!resized.ok) return resized;
        const captured = snapshotFramebuffer(
          context.framebuffer,
          context.width,
          context.height,
        );
        if (!captured.ok) return captured;
        // Reconstruct the whole target first; the node draw below only changes its
        // own painter rectangle and blends over these accumulated pixels.
        copy(captured.value, target, "nearest");
        const x = Math.round(rect[0] * context.width);
        const x1 = Math.round((rect[0] + rect[2]) * context.width);
        const topY = Math.round(rect[1] * context.height);
        const bottomY = Math.round((rect[1] + rect[3]) * context.height);
        const y = context.height - bottomY;
        const width = x1 - x;
        const height = bottomY - topY;
        const left = Math.max(x, context.scissor.x);
        const bottom = Math.max(y, context.scissor.y);
        const right = Math.min(x1, context.scissor.x + context.scissor.width);
        const top = Math.min(
          context.height - topY,
          context.scissor.y + context.scissor.height,
        );
        if (right <= left || top <= bottom) return ok(undefined);
        const ready = ensureProgram();
        if (!ready.ok) return ready;
        const white = baseTexture ? null : whiteTarget();
        if (white && !white.ok) return white;
        const texture = baseTexture ?? white?.value;
        const previous = gl.getParameter(
          gl.FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.viewport(x, y, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(left, bottom, right - left, top - bottom);
          applyGodotBlend(gl, transpiled.blend);
          gl.useProgram(ready.value.program);
          gl.bindVertexArray(ready.value.vao);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture?.texture ?? null);
          const textureLoc = uniformLocation(ready.value, "TEXTURE");
          if (textureLoc) gl.uniform1i(textureLoc, 0);
          if (transpiled.usesTime)
            applyUniform(ready.value, "TIME", input.time);
          if (transpiled.usesTexturePixelSize) {
            texturePixelSize[0] = 1 / Math.max(1, texture?.width ?? 1);
            texturePixelSize[1] = 1 / Math.max(1, texture?.height ?? 1);
            applyUniform(ready.value, "TEXTURE_PIXEL_SIZE", texturePixelSize);
          }
          applyUniform(ready.value, "MODULATE", modulate);
          applyUniform(ready.value, "_godot_uv_fit", fit);
          applyUniform(ready.value, "_godot_uv_window", window);
          screenOrigin[0] = rect[0];
          screenOrigin[1] = rect[1];
          screenSize[0] = rect[2];
          screenSize[1] = rect[3];
          if (transpiled.usesScreenUv) {
            applyUniform(ready.value, "_godot_screen_origin", screenOrigin);
            applyUniform(ready.value, "_godot_screen_size", screenSize);
          }
          gl.activeTexture(gl.TEXTURE0 + 1);
          gl.bindTexture(gl.TEXTURE_2D, captured.value.texture);
          const screenLoc = uniformLocation(ready.value, "SCREEN_TEXTURE");
          if (screenLoc) gl.uniform1i(screenLoc, 1);
          if (transpiled.usesScreenPixelSize) {
            screenPixelSize[0] = 1 / context.width;
            screenPixelSize[1] = 1 / context.height;
            applyUniform(ready.value, "SCREEN_PIXEL_SIZE", screenPixelSize);
          }
          let unit = 2;
          for (let i = 0; i < transpiled.samplers.length; i += 1) {
            const sampler = transpiled.samplers[i];
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, samplerTargets[i].texture);
            const loc = uniformLocation(ready.value, sampler.name);
            if (loc) gl.uniform1i(loc, unit++);
          }
          for (const uniform of transpiled.uniforms)
            applyGodotUniform(ready.value, uniform);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindVertexArray(null);
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        }
        const previousRead = gl.getParameter(
          gl.READ_FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        const previousDraw = gl.getParameter(
          gl.DRAW_FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, context.framebuffer);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(
            context.scissor.x,
            context.scissor.y,
            context.scissor.width,
            context.scissor.height,
          );
          gl.blitFramebuffer(
            0,
            0,
            target.width,
            target.height,
            0,
            0,
            context.width,
            context.height,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
          );
        } finally {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
        }
        return ok(undefined);
      },
      invalidate() {
        destroyProgram(gl, program);
        program = null;
        discardTarget(target, true);
      },
      invalidateContextLoss() {
        program = null;
        discardTarget(target, false);
      },
      dispose() {
        if (!producerDisposed) {
          producerDisposed = true;
          destroyProgram(gl, program);
          program = null;
          discardTarget(target, true);
          targets.delete(target);
          invalidatables.delete(producer);
        }
      },
    };
    invalidatables.add(producer);
    return ok(producer);
  }

  function createParticleProducer(
    parameters: HeadlessParticleParameters,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessParticleProducer> {
    const invalid = state<HeadlessParticleProducer>();
    if (invalid) return invalid;
    const diagnostic = particleDiagnostic(parameters);
    if (diagnostic) return { ok: false, diagnostic };
    const target = makeTarget();
    const allocated = resizeTarget(target, width, height);
    if (!allocated.ok) {
      targets.delete(target);
      return allocated;
    }
    let requestedWidth = target.width;
    let requestedHeight = target.height;
    const resolution: [number, number] = [target.width, target.height];
    const speed: [number, number] = [parameters.speedMin, parameters.speedMax];
    const size: [number, number] = [
      parameters.startSizePx,
      parameters.endSizePx,
    ];
    const rendered = ok<HeadlessEffectTarget>(target);
    let program: ProgramState | null = null;
    let producerDisposed = false;
    const count = Math.min(
      Math.floor(parameters.maxParticles),
      Math.max(
        1,
        Math.ceil(parameters.emissionRate * parameters.lifetimeSeconds),
      ),
    );
    function ensureProgram(): HeadlessEffectResult<ProgramState> {
      if (program) return ok(program);
      const compiled = compileProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
      if (compiled.ok) program = compiled.value;
      return compiled;
    }
    const producer: HeadlessParticleProducer = {
      target,
      warmUp() {
        const current = state<void>();
        if (current) return current;
        if (producerDisposed)
          return fail("DISPOSED", "The particle producer has been disposed.");
        const ready = ensureProgram();
        return ready.ok ? ok(undefined) : ready;
      },
      resize(nextWidth, nextHeight) {
        if (producerDisposed)
          return fail("DISPOSED", "The particle producer has been disposed.");
        const resized = resizeTarget(target, nextWidth, nextHeight);
        if (resized.ok) {
          requestedWidth = target.width;
          requestedHeight = target.height;
          resolution[0] = target.width;
          resolution[1] = target.height;
        }
        return resized;
      },
      render(input) {
        const inputDiagnostic = renderInputDiagnostic(input);
        if (inputDiagnostic) return { ok: false, diagnostic: inputDiagnostic };
        const current = state<HeadlessEffectTarget>();
        if (current) return current;
        if (producerDisposed)
          return fail("DISPOSED", "The particle producer has been disposed.");
        if (!target.framebuffer) {
          const reallocated = resizeTarget(
            target,
            requestedWidth,
            requestedHeight,
          );
          if (!reallocated.ok) return reallocated;
        }
        const ready = ensureProgram();
        if (!ready.ok) return ready;
        const previousFramebuffer = gl.getParameter(
          gl.FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.viewport(0, 0, target.width, target.height);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(ready.value.program);
          gl.bindVertexArray(ready.value.vao);
          applyUniform(ready.value, "u_time", input.time);
          applyUniform(ready.value, "u_delta", input.delta);
          applyUniform(ready.value, "u_seed", input.seed);
          applyUniform(ready.value, "u_lifetime", parameters.lifetimeSeconds);
          applyUniform(ready.value, "u_emission_rate", parameters.emissionRate);
          applyUniform(ready.value, "u_max_particles", parameters.maxParticles);
          applyUniform(ready.value, "u_position", parameters.position);
          applyUniform(ready.value, "u_direction", parameters.directionRadians);
          applyUniform(ready.value, "u_spread", parameters.spreadRadians);
          applyUniform(ready.value, "u_speed", speed);
          applyUniform(ready.value, "u_gravity", parameters.gravity);
          applyUniform(ready.value, "u_resolution", resolution);
          applyUniform(ready.value, "u_size", size);
          applyUniform(ready.value, "u_start_color", parameters.startColor);
          applyUniform(ready.value, "u_end_color", parameters.endColor);
          gl.drawArrays(gl.POINTS, 0, count);
          gl.bindVertexArray(null);
          return rendered;
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        }
      },
      invalidate() {
        destroyProgram(gl, program);
        program = null;
        discardTarget(target, true);
      },
      invalidateContextLoss() {
        program = null;
        discardTarget(target, false);
      },
      dispose() {
        if (!producerDisposed) {
          producerDisposed = true;
          destroyProgram(gl, program);
          program = null;
          discardTarget(target, true);
          targets.delete(target);
          invalidatables.delete(producer);
        }
      },
    };
    invalidatables.add(producer);
    return ok(producer);
  }

  function createGodotParticleProducer(
    pass: HeadlessGodotParticlePass,
    width: number,
    height: number,
  ): HeadlessEffectResult<HeadlessGodotParticleProducer> {
    const invalid = state<HeadlessGodotParticleProducer>();
    if (invalid) return invalid;
    if (!pass.config && !pass.scratch)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "A particle pass needs config or caller-owned scratch.",
        "config",
      );
    if (pass.scratch && pass.config)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "When scratch is supplied, omit config: scratch is the semantic owner.",
        "scratch-config",
      );
    const config = pass.scratch
      ? pass.scratch.config
      : normalizeParticleRenderConfig(pass.config!);
    const sprite = pass.spriteTexture
      ? textureInputFor(pass.spriteTexture)
      : null;
    const lut = pass.lutTexture ? textureInputFor(pass.lutTexture) : null;
    const mask = pass.maskTexture ? textureInputFor(pass.maskTexture) : null;
    if (pass.spriteTexture && !sprite)
      return fail(
        "FOREIGN_TARGET",
        "A textured particle system needs a live sprite target owned by this stage.",
        "sprite-texture",
      );
    if ((pass.lutTexture && !lut) || (pass.maskTexture && !mask))
      return fail(
        "FOREIGN_TARGET",
        "Particle auxiliary textures must be live targets owned by this stage.",
        "auxiliary-texture",
      );
    const unsupported = (
      ["collision", "attractors", "trails", "customMaterial"] as const
    ).find((feature) => pass.features?.[feature]);
    if (unsupported)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        `Headless Godot particles do not support ${unsupported}.`,
        unsupported,
      );
    // Material/collision effects cannot be reconstructed from a flat particle spec.
    if (config.emissionShape === 4 || config.emissionShape === 5)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "Point-list and directed-point emission require their authored point data.",
        "emission-shape",
      );
    const scratch = pass.scratch ?? createGodotParticleScratch(config);
    const ownsScratch = !pass.scratch;
    if (scratch.instances.data.length / 10 < scratch.state.count)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "Scratch cannot hold the configured particle count.",
        "scratch-capacity",
      );
    const target = makeTarget();
    const allocated = resizeTarget(target, width, height);
    if (!allocated.ok) {
      targets.delete(target);
      return allocated;
    }
    const semanticConfig = scratch.config;
    const packing = {
      state: scratch.state,
      config: semanticConfig,
      instances: scratch.instances,
      textureWidth: 0,
      textureHeight: 0,
      origin: undefined as readonly [number, number] | undefined,
      transform: undefined as DirectParticleTransform | undefined,
      modulate: undefined as
        | readonly [number, number, number, number]
        | undefined,
    };
    let requestedWidth = target.width,
      requestedHeight = target.height;
    let program: ParticleProgram | null = null;
    let quad: WebGLBuffer | null = null;
    let producerDisposed = false;
    let lastTime: number | null = null;
    let preprocessed = false;
    const rendered = ok<HeadlessEffectTarget>(target);
    const warmed = ok(undefined);
    const particleGl: { gl: WebGL2RenderingContext; quad: WebGLBuffer | null } =
      { gl, quad: null };
    const drawOptions = {
      texture: sprite?.texture ?? null,
      textured: Boolean(sprite),
      lutTexture: lut?.texture ?? null,
      maskTexture: mask?.texture ?? null,
      hframes: semanticConfig.hframes,
      vframes: semanticConfig.vframes,
      blendMode: semanticConfig.blendMode,
      viewportW: target.width,
      viewportH: target.height,
      alphaFromRed: semanticConfig.alphaFromRed,
      erode: semanticConfig.alphaErode,
      uvPolar: semanticConfig.uvPolar,
      targetFramebuffer: target.framebuffer,
    };
    const ensure = (): HeadlessEffectResult<ParticleProgram> => {
      if (program) return readyResult!;
      const compiled = acquireParticleProgram(gl);
      if (!compiled)
        return fail(
          "SHADER_COMPILE_FAILED",
          "WebGL could not compile the shared Godot particle renderer.",
        );
      quad = gl.createBuffer();
      if (!quad) {
        releaseParticleProgram(gl);
        return fail(
          "RESOURCE_ALLOCATION_FAILED",
          "WebGL could not allocate the particle resolve quad.",
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      program = compiled;
      particleGl.quad = quad;
      readyResult = ok(compiled);
      return readyResult;
    };
    let readyResult: HeadlessEffectResult<ParticleProgram> | null = null;
    const dependencyLive = (value: TextureBinding | null): boolean =>
      !(
        value &&
        (value.owned
          ? !targets.has(value.owned) ||
            !value.owned.texture ||
            !value.owned.framebuffer
          : typeof gl.isTexture === "function" && !gl.isTexture(value.texture))
      );
    const reset = (): void => {
      const s = scratch.state;
      s.time = 0;
      s.cycle = 0;
      s.remainder = 0;
      s.emitting = true;
      for (let index = 0; index < s.particles.length; index += 1)
        s.particles[index].active = false;
    };
    // This is authored particle state, not a DOM-runtime convenience. Match
    // the direct painter path so target-backed ambient/flipbook effects begin
    // at Godot's pre-simulated phase instead of an empty fresh emitter.
    const preprocess = (): void => {
      if (preprocessed) return;
      preprocessParticles(scratch.state);
      preprocessed = true;
    };
    const producer: HeadlessGodotParticleProducer = {
      target,
      scratch,
      warmUp() {
        const current = state<void>();
        if (current) return current;
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot particle producer has been disposed.",
          );
        const ready = ensure();
        if (!ready.ok) return ready;
        if (!prepareParticleDraw(gl, ready.value, drawOptions) || false)
          return fail(
            "RESOURCE_ALLOCATION_FAILED",
            "WebGL could not prepare particle draw resources.",
          );
        return warmed;
      },
      resize(nextWidth, nextHeight) {
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot particle producer has been disposed.",
          );
        const resized = resizeTarget(target, nextWidth, nextHeight);
        if (resized.ok) {
          requestedWidth = target.width;
          requestedHeight = target.height;
          drawOptions.viewportW = target.width;
          drawOptions.viewportH = target.height;
          drawOptions.targetFramebuffer = target.framebuffer;
        }
        return resized;
      },
      render(input) {
        if (
          (input.origin !== undefined &&
            (input.origin.length !== 2 ||
              !input.origin.every(Number.isFinite))) ||
          !Number.isFinite(input.time) ||
          !Number.isFinite(input.delta) ||
          input.time < 0 ||
          input.delta < 0
        )
          return fail(
            "INVALID_RENDER_INPUT",
            "Particle time and delta must be finite and non-negative.",
            "render-input",
          );
        if (!input.restart && lastTime !== null) {
          if (input.time < lastTime)
            return fail(
              "INVALID_RENDER_INPUT",
              "Particle time must be monotonic unless restart is set.",
              "time",
            );
          if (Math.abs(input.delta - (input.time - lastTime)) > 1e-6)
            return fail(
              "INVALID_RENDER_INPUT",
              "Particle delta must reconcile with caller time.",
              "time-delta",
            );
        }
        const current = state<HeadlessEffectTarget>();
        if (current) return current;
        if (producerDisposed)
          return fail(
            "DISPOSED",
            "The Godot particle producer has been disposed.",
          );
        if (!target.texture || !target.framebuffer) {
          const resized = resizeTarget(target, requestedWidth, requestedHeight);
          if (!resized.ok) return resized;
        }
        if (!dependencyLive(sprite))
          return fail(
            "FOREIGN_TARGET",
            "Particle sprite texture is no longer live.",
            "sprite-texture",
          );
        if (!dependencyLive(lut))
          return fail(
            "FOREIGN_TARGET",
            "Particle LUT texture is no longer live.",
            "lut-texture",
          );
        if (!dependencyLive(mask))
          return fail(
            "FOREIGN_TARGET",
            "Particle mask texture is no longer live.",
            "mask-texture",
          );
        const ready = ensure();
        if (!ready.ok) return ready;
        drawOptions.viewportW = target.width;
        drawOptions.viewportH = target.height;
        drawOptions.targetFramebuffer = target.framebuffer;
        if (!prepareParticleDraw(gl, ready.value, drawOptions))
          return fail(
            "RESOURCE_ALLOCATION_FAILED",
            "WebGL could not allocate the additive particle target.",
          );
        if (input.restart) {
          reset();
          preprocessed = false;
        }
        preprocess();
        scratch.state.emitting = input.emitting;
        simulateParticles(scratch.state, input.delta);
        lastTime = input.time;
        const buffer = scratch.instances;
        packing.textureWidth =
          semanticConfig.textureWidth > 0
            ? semanticConfig.textureWidth
            : (sprite?.width ?? 16);
        packing.textureHeight =
          semanticConfig.textureHeight > 0
            ? semanticConfig.textureHeight
            : (sprite?.height ?? 16);
        packing.origin = input.origin;
        packParticleInstances(packing);
        const previous = gl.getParameter(
          gl.FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.viewport(0, 0, target.width, target.height);
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (buffer.count === 0) return rendered;
          const drawn = drawParticles(
            particleGl as { gl: WebGL2RenderingContext; quad: WebGLBuffer },
            ready.value,
            buffer,
            drawOptions,
          );
          if (!drawn)
            return fail(
              "RESOURCE_ALLOCATION_FAILED",
              "WebGL could not allocate the additive particle target.",
            );
          return rendered;
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        }
      },
      // Program and caller scratch are shared/borrowed; this producer only owns its target and resolve quad.
      invalidate() {
        if (program) releaseParticleProgram(gl);
        program = null;
        if (quad) gl.deleteBuffer(quad);
        quad = null;
        if (ownsScratch) disposeParticleInstanceBuffer(gl, scratch.instances);
        discardTarget(target, true);
      },
      invalidateContextLoss() {
        if (program) releaseParticleProgram(gl, true);
        program = null;
        quad = null;
        invalidateParticleInstanceBuffer(gl, scratch.instances);
        discardTarget(target, false);
      },
      dispose() {
        if (!producerDisposed) {
          producerDisposed = true;
          producer.invalidate();
          targets.delete(target);
          invalidatables.delete(producer);
        }
      },
    };
    invalidatables.add(producer);
    return ok(producer);
  }

  function createGodotParticleDirectPass(
    pass: HeadlessGodotParticlePass,
  ): HeadlessEffectResult<HeadlessGodotParticleDirectPass> {
    const invalid = state<HeadlessGodotParticleDirectPass>();
    if (invalid) return invalid;
    if (!pass.config && !pass.scratch)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "A particle pass needs config or caller-owned scratch.",
        "config",
      );
    if (pass.scratch && pass.config)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "When scratch is supplied, omit config: scratch is the semantic owner.",
        "scratch-config",
      );
    const config = pass.scratch
      ? pass.scratch.config
      : normalizeParticleRenderConfig(pass.config!);
    const sprite = pass.spriteTexture
      ? textureInputFor(pass.spriteTexture)
      : null;
    const lut = pass.lutTexture ? textureInputFor(pass.lutTexture) : null;
    const mask = pass.maskTexture ? textureInputFor(pass.maskTexture) : null;
    if (pass.spriteTexture && !sprite)
      return fail(
        "FOREIGN_TARGET",
        "A textured particle system needs a live sprite target owned by this stage.",
        "sprite-texture",
      );
    if ((pass.lutTexture && !lut) || (pass.maskTexture && !mask))
      return fail(
        "FOREIGN_TARGET",
        "Particle auxiliary textures must be live targets owned by this stage.",
        "auxiliary-texture",
      );
    const unsupported = (
      ["collision", "attractors", "trails", "customMaterial"] as const
    ).find((feature) => pass.features?.[feature]);
    if (unsupported)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        `Headless Godot particles do not support ${unsupported}.`,
        unsupported,
      );
    if (config.emissionShape === 4 || config.emissionShape === 5)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "Point-list and directed-point emission require their authored point data.",
        "emission-shape",
      );
    const scratch = pass.scratch ?? createGodotParticleScratch(config);
    const ownsScratch = !pass.scratch;
    if (scratch.instances.data.length / 10 < scratch.state.count)
      return fail(
        "UNSUPPORTED_PARTICLE_FEATURE",
        "Scratch cannot hold the configured particle count.",
        "scratch-capacity",
      );

    const semanticConfig = scratch.config;
    const packing = {
      state: scratch.state,
      config: semanticConfig,
      instances: scratch.instances,
      textureWidth: 0,
      textureHeight: 0,
      origin: undefined as readonly [number, number] | undefined,
      transform: undefined as DirectParticleTransform | undefined,
      modulate: undefined as
        | readonly [number, number, number, number]
        | undefined,
    };
    let program: ParticleProgram | null = null;
    let quad: WebGLBuffer | null = null;
    let disposedProducer = false;
    let preprocessed = false;
    let lastTime: number | null = null;
    const particleGl: { gl: WebGL2RenderingContext; quad: WebGLBuffer | null } =
      { gl, quad: null };
    const drawOptions = {
      texture: sprite?.texture ?? null,
      textured: Boolean(sprite),
      lutTexture: lut?.texture ?? null,
      maskTexture: mask?.texture ?? null,
      hframes: semanticConfig.hframes,
      vframes: semanticConfig.vframes,
      blendMode: semanticConfig.blendMode,
      viewportW: 1,
      viewportH: 1,
      alphaFromRed: semanticConfig.alphaFromRed,
      erode: semanticConfig.alphaErode,
      uvPolar: semanticConfig.uvPolar,
      targetFramebuffer: null as WebGLFramebuffer | null,
      additiveResolveIntoExisting: true,
    };
    let readyResult: HeadlessEffectResult<ParticleProgram> | null = null;
    const ensure = (): HeadlessEffectResult<ParticleProgram> => {
      if (program) return readyResult!;
      const compiled = acquireParticleProgram(gl);
      if (!compiled)
        return fail(
          "SHADER_COMPILE_FAILED",
          "WebGL could not compile the shared Godot particle renderer.",
        );
      quad = gl.createBuffer();
      if (!quad) {
        releaseParticleProgram(gl);
        return fail(
          "RESOURCE_ALLOCATION_FAILED",
          "WebGL could not allocate the particle resolve quad.",
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      program = compiled;
      particleGl.quad = quad;
      readyResult = ok(compiled);
      return readyResult;
    };
    const dependencyLive = (value: TextureBinding | null): boolean =>
      !(
        value &&
        (value.owned
          ? !targets.has(value.owned) ||
            !value.owned.texture ||
            !value.owned.framebuffer
          : typeof gl.isTexture === "function" && !gl.isTexture(value.texture))
      );
    const reset = (): void => {
      const state = scratch.state;
      state.time = 0;
      state.cycle = 0;
      state.remainder = 0;
      state.emitting = true;
      for (const particle of state.particles) particle.active = false;
    };
    const preprocess = (): void => {
      if (preprocessed) return;
      preprocessParticles(scratch.state);
      preprocessed = true;
    };
    const producer: HeadlessGodotParticleDirectPass = {
      scratch,
      warmUp() {
        const current = state<void>();
        if (current) return current;
        if (disposedProducer)
          return fail("DISPOSED", "The Godot particle pass has been disposed.");
        const ready = ensure();
        if (!ready.ok) return ready;
        if (!prepareParticleDraw(gl, ready.value, drawOptions) || false)
          return fail(
            "RESOURCE_ALLOCATION_FAILED",
            "WebGL could not prepare particle draw resources.",
          );
        preprocess();
        return ok(undefined);
      },
      draw(input, context) {
        if (
          (input.origin !== undefined &&
            (input.origin.length !== 2 ||
              !input.origin.every(Number.isFinite))) ||
          !Number.isFinite(input.time) ||
          !Number.isFinite(input.delta) ||
          input.time < 0 ||
          input.delta < 0 ||
          !Number.isFinite(context.width) ||
          !Number.isFinite(context.height) ||
          context.width <= 0 ||
          context.height <= 0
        )
          return fail(
            "INVALID_RENDER_INPUT",
            "Particle time, delta, and target dimensions must be finite and positive.",
            "render-input",
          );
        const transform = directParticleTransform(input.transform);
        if (!transform)
          return fail(
            "UNSUPPORTED_PARTICLE_FEATURE",
            "Direct particles require a finite uniform-scale rotation and translation transform.",
            "transform",
          );
        const modulate = directParticleModulate(input.modulate);
        if (!modulate)
          return fail(
            "INVALID_RENDER_INPUT",
            "Direct particle modulation components must be finite.",
            "modulate",
          );
        if (!input.restart && lastTime !== null) {
          if (input.time < lastTime)
            return fail(
              "INVALID_RENDER_INPUT",
              "Particle time must be monotonic unless restart is set.",
              "time",
            );
          if (Math.abs(input.delta - (input.time - lastTime)) > 1e-6)
            return fail(
              "INVALID_RENDER_INPUT",
              "Particle delta must reconcile with caller time.",
              "time-delta",
            );
        }
        const current = state<void>();
        if (current) return current;
        if (disposedProducer)
          return fail("DISPOSED", "The Godot particle pass has been disposed.");
        if (!dependencyLive(sprite))
          return fail(
            "FOREIGN_TARGET",
            "Particle sprite texture is no longer live.",
            "sprite-texture",
          );
        if (!dependencyLive(lut))
          return fail(
            "FOREIGN_TARGET",
            "Particle LUT texture is no longer live.",
            "lut-texture",
          );
        if (!dependencyLive(mask))
          return fail(
            "FOREIGN_TARGET",
            "Particle mask texture is no longer live.",
            "mask-texture",
          );
        const ready = ensure();
        if (!ready.ok) return ready;
        drawOptions.viewportW = Math.floor(context.width);
        drawOptions.viewportH = Math.floor(context.height);
        drawOptions.targetFramebuffer = context.framebuffer;
        if (!prepareParticleDraw(gl, ready.value, drawOptions))
          return fail(
            "RESOURCE_ALLOCATION_FAILED",
            "WebGL could not allocate the shared additive particle target.",
          );
        if (input.restart) {
          reset();
          preprocessed = false;
        }
        preprocess();
        scratch.state.emitting = input.emitting;
        simulateParticles(scratch.state, input.delta);
        lastTime = input.time;
        const buffer = scratch.instances;
        packing.textureWidth =
          semanticConfig.textureWidth > 0
            ? semanticConfig.textureWidth
            : (sprite?.width ?? 16);
        packing.textureHeight =
          semanticConfig.textureHeight > 0
            ? semanticConfig.textureHeight
            : (sprite?.height ?? 16);
        packing.origin = input.origin;
        packing.transform = transform;
        packing.modulate = modulate;
        packParticleInstances(packing);
        if (buffer.count === 0) return ok(undefined);
        gl.bindFramebuffer(gl.FRAMEBUFFER, context.framebuffer);
        gl.viewport(0, 0, drawOptions.viewportW, drawOptions.viewportH);
        const drawn = drawParticles(
          particleGl as { gl: WebGL2RenderingContext; quad: WebGLBuffer },
          ready.value,
          buffer,
          drawOptions,
        );
        return drawn
          ? ok(undefined)
          : fail(
              "RESOURCE_ALLOCATION_FAILED",
              "WebGL could not draw the shared particle pass.",
            );
      },
      invalidate() {
        if (program) releaseParticleProgram(gl);
        program = null;
        readyResult = null;
        if (quad) gl.deleteBuffer(quad);
        quad = null;
        particleGl.quad = null;
        if (ownsScratch) disposeParticleInstanceBuffer(gl, scratch.instances);
      },
      invalidateContextLoss() {
        if (program) releaseParticleProgram(gl, true);
        program = null;
        readyResult = null;
        quad = null;
        particleGl.quad = null;
        invalidateParticleInstanceBuffer(gl, scratch.instances);
      },
      dispose() {
        if (disposedProducer) return;
        disposedProducer = true;
        producer.invalidate();
        invalidatables.delete(producer);
      },
    };
    invalidatables.add(producer);
    return ok(producer);
  }

  return {
    gl,
    createShaderProducer,
    createGodotShaderProducer,
    createParticleProducer,
    createGodotParticleProducer,
    createGodotParticleDirectPass,
    executeScreenSample(command) {
      const current = state<void>();
      if (current) return current;
      const source = targetFor(command.source);
      const destination = targetFor(command.destination);
      if (
        !source?.texture ||
        !source.framebuffer ||
        !destination?.texture ||
        !destination.framebuffer
      ) {
        return fail(
          "FOREIGN_TARGET",
          "Screen sample commands require live targets owned by this headless effects stage.",
        );
      }
      if (source === destination) {
        const captured = snapshotFor(source);
        if (!captured.ok) return captured;
        copy(captured.value, destination, command.filter ?? "nearest");
      } else copy(source, destination, command.filter ?? "nearest");
      return ok(undefined);
    },
    invalidate() {
      for (const item of [...invalidatables]) item.invalidate();
      if (snapshot) discardTarget(snapshot, true);
      if (opaqueWhite) discardTarget(opaqueWhite, true);
      opaqueWhiteFilled = false;
      opaqueWhiteResult = null;
    },
    invalidateContextLoss() {
      for (const item of [...invalidatables]) item.invalidateContextLoss();
      if (snapshot) discardTarget(snapshot, false);
      if (opaqueWhite) discardTarget(opaqueWhite, false);
      opaqueWhiteFilled = false;
      opaqueWhiteResult = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const item of [...invalidatables]) item.dispose();
      if (snapshot) discardTarget(snapshot, true);
      if (opaqueWhite) discardTarget(opaqueWhite, true);
      snapshot = null;
      opaqueWhite = null;
      opaqueWhiteFilled = false;
      opaqueWhiteResult = null;
      targets.clear();
    },
  };
}
