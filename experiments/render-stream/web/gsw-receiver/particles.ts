// PM6b (render-stream-12.md "As built (PM6b)"): GSW simulates /12 GPU particles itself, the
// approximate tier. The wasm side (`rs-core` apply/particles.rs) describes every `ok` 2D emitter
// with its process material's builtin key, uniforms and curve textures; this file keeps one
// `GodotGpuEmitter` (packages/effects: gl_compatibility's particle storage and the generated
// ParticleProcessMaterial shader, with Godot's RNG) per emitter, applies the wire's setters,
// seed, restarts and process requests in PM6a's order (rule 4), steps each by the host's shader
// time delta, and hands the packed instances back for the next `apply`, which draws them as an
// instanced draw of the emitter's draw pass mesh (PM3's path).
//
// Called once per apply (`step`), after the transactions are accepted and before `apply`: a
// window-2 fold steps once, by the fold's whole time delta.

import {
  GODOT_GPU_INSTANCE_FLOATS,
  type GodotCurveTexture,
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
  type GodotProcessMaterial,
  godotGpuApproximateFeatures,
} from "../../../../packages/effects/src/particles";

/** The wasm module's particles surface (`GswRs`). */
export interface ParticlesHost {
  particles_sync(): string;
  shader_time(): number;
  particles_set(id: number, data: Float32Array): void;
}

interface WireFloats {
  amount_ratio: number;
  lifetime: number;
  pre_process_time: number;
  explosiveness: number;
  randomness: number;
  speed_scale: number;
  interp_to_end: number;
  request_process_time: number;
  emission_transform: number[];
  emitter_velocity: number[];
}

interface WireEmitter {
  id: number;
  version: number;
  emitting: boolean;
  amount: number;
  one_shot: boolean;
  fixed_fps: number;
  interpolate: boolean;
  fractional_delta: boolean;
  local: boolean;
  draw_order: GodotGpuEmitterConfig["drawOrder"];
  trails: boolean;
  seed: number;
  restarts: number;
  emits: number;
  process_requests: number;
  material: number | null;
  f?: WireFloats;
}

interface WireMaterial {
  id: number;
  version: number;
  builtin: {
    emission_shape: GodotProcessMaterial["emissionShape"];
    particle_flags: string[];
    sub_emitter: string;
    attractor: boolean;
    collision: string;
    turbulence: boolean;
  } | null;
  uniforms: Record<string, number | number[]>;
  curves: Record<string, { width: number; height: number; data: number[] }>;
}

interface Held {
  sim: GodotGpuEmitter | null;
  wire: WireEmitter;
  restarts: number;
  processRequests: number;
  emitting: boolean;
  seed: number;
  /** The last upload was the inactive emitter's zeros (nothing to re-send). */
  zeros: boolean;
}

/** applied.json `w11.particles`, the shell's half (the wasm adds the draw and emit counters). */
export interface ParticlesEvidence {
  particles_created: number;
  particles_freed: number;
  restarts: number;
  seed_sets: number;
  process_requests: number;
  sim_steps: number;
  /** Emitters with no keyed process material (nothing GSW can simulate): not drawn. */
  unsimulated: number;
  approximate_features: string[];
}

const DEFAULT_FRAME = 1 / 60;

export class GswParticles {
  private readonly held = new Map<number, Held>();
  private readonly materials = new Map<
    number,
    { wire: WireMaterial; material: GodotProcessMaterial | null }
  >();
  private lastTime = Number.NaN;
  private buf = new Float32Array(0);
  private readonly features = new Set<string>();
  readonly evidence: ParticlesEvidence = {
    particles_created: 0,
    particles_freed: 0,
    restarts: 0,
    seed_sets: 0,
    process_requests: 0,
    sim_steps: 0,
    unsimulated: 0,
    approximate_features: [],
  };

  /** Sync with the accepted state, step every emitter by the host's time and upload. */
  step(g: ParticlesHost): void {
    const msg = g.particles_sync();
    if (msg !== "")
      this.sync(
        JSON.parse(msg) as {
          ids: number[];
          emitters: WireEmitter[];
          materials: WireMaterial[];
        },
      );
    const t = g.shader_time();
    let dt = DEFAULT_FRAME;
    if (Number.isFinite(t)) {
      if (Number.isFinite(this.lastTime)) {
        dt = t - this.lastTime;
        // The host's TIME wraps at its rollover; a wrap or a reset steps one nominal frame.
        if (!(dt >= 0)) dt = DEFAULT_FRAME;
      } else dt = 0;
      this.lastTime = t;
    }
    for (const [id, h] of this.held) {
      const sim = h.sim;
      if (!sim) continue;
      const before = sim.stats.steps;
      // The shader's TIME is the host's (turbulence reads it); without one, the sim's own sum.
      if (Number.isFinite(t)) sim.update(dt, t);
      else sim.update(dt);
      this.evidence.sim_steps += sim.stats.steps - before;
      if (sim.isInactive && h.zeros) continue;
      const floats = sim.config.amount * GODOT_GPU_INSTANCE_FLOATS;
      if (this.buf.length < floats) this.buf = new Float32Array(floats);
      const out = this.buf.subarray(0, floats);
      sim.pack(out);
      g.particles_set(id, out);
      h.zeros = sim.isInactive;
    }
  }

  private material(id: number | null): GodotProcessMaterial | null {
    if (id === null) return null;
    return this.materials.get(id)?.material ?? null;
  }

  private config(
    e: WireEmitter,
    material: GodotProcessMaterial,
  ): GodotGpuEmitterConfig | null {
    const f = e.f;
    if (!f) return null;
    return {
      emitting: e.emitting,
      amount: e.amount,
      amountRatio: f.amount_ratio,
      lifetime: f.lifetime,
      oneShot: e.one_shot,
      preProcessTime: f.pre_process_time,
      explosiveness: f.explosiveness,
      randomness: f.randomness,
      speedScale: f.speed_scale,
      fixedFps: e.fixed_fps,
      interpolate: e.interpolate,
      fractionalDelta: e.fractional_delta,
      localCoords: e.local,
      drawOrder: e.draw_order,
      interpToEnd: f.interp_to_end,
      emissionTransform: f.emission_transform,
      emitterVelocity: f.emitter_velocity,
      seed: e.seed,
      material,
    };
  }

  private sync(msg: {
    ids: number[];
    emitters: WireEmitter[];
    materials: WireMaterial[];
  }): void {
    const live = new Set(msg.ids);
    for (const id of [...this.held.keys()]) {
      if (live.has(id)) continue;
      const h = this.held.get(id);
      if (h?.sim) this.evidence.particles_freed++;
      this.held.delete(id);
    }
    const touched = new Set<number>();
    for (const m of msg.materials) {
      const material: GodotProcessMaterial | null = m.builtin
        ? {
            emissionShape: m.builtin.emission_shape,
            flags: m.builtin.particle_flags,
            turbulence: m.builtin.turbulence,
            uniforms: m.uniforms,
            curves: Object.fromEntries(
              Object.entries(m.curves).map(
                ([k, c]): [string, GodotCurveTexture] => [
                  k,
                  {
                    width: c.width,
                    height: c.height,
                    data: Float32Array.from(c.data),
                  },
                ],
              ),
            ),
          }
        : null;
      // Attractors are 3D nodes (a 2D emitter has none to interact with); collision is not modelled.
      if (m.builtin && m.builtin.collision !== "disabled")
        this.features.add("collision");
      this.materials.set(m.id, { wire: m, material });
      touched.add(m.id);
    }
    // Emitters whose material changed are re-configured too.
    const changed = new Map<number, WireEmitter>();
    for (const e of msg.emitters) changed.set(e.id, e);
    for (const [id, h] of this.held)
      if (
        !changed.has(id) &&
        h.wire.material !== null &&
        touched.has(h.wire.material)
      )
        changed.set(id, h.wire);
    for (const e of changed.values()) this.apply(e);
    this.evidence.approximate_features = [...this.features].sort();
  }

  /** One emitter's wire entry, in PM6a's order: setters, seed, restart, process request. */
  private apply(e: WireEmitter): void {
    let h = this.held.get(e.id);
    const material = this.material(e.material);
    const cfg = material ? this.config(e, material) : null;
    if (!h) {
      h = {
        sim: null,
        wire: e,
        restarts: e.restarts,
        processRequests: e.process_requests,
        emitting: e.emitting,
        seed: e.seed,
        zeros: false,
      };
      this.held.set(e.id, h);
      if (!cfg) {
        this.evidence.unsimulated++;
        return;
      }
      this.make(h, cfg, e);
      return;
    }
    h.wire = e;
    if (!cfg) return;
    if (!h.sim) {
      this.make(h, cfg, e);
      return;
    }
    h.sim.configure(cfg);
    if (e.emitting !== h.emitting) {
      h.sim.setEmitting(e.emitting);
      h.emitting = e.emitting;
    }
    if (e.seed !== h.seed) {
      h.seed = e.seed;
      this.evidence.seed_sets++;
    }
    if (e.restarts !== h.restarts) {
      // GPUParticles2D::restart() is particles_restart then particles_set_emitting(true): the
      // emitter's storage emits again even if the wire's `emitting` never moved.
      h.sim.restart();
      h.sim.setEmitting(e.emitting);
      h.restarts = e.restarts;
      this.evidence.restarts++;
    }
    if (e.process_requests !== h.processRequests && e.f) {
      h.sim.requestProcess(e.f.request_process_time);
      h.processRequests = e.process_requests;
      this.evidence.process_requests++;
    }
    for (const f of godotGpuApproximateFeatures(cfg)) this.features.add(f);
  }

  private make(h: Held, cfg: GodotGpuEmitterConfig, e: WireEmitter): void {
    h.sim = new GodotGpuEmitter(cfg);
    h.zeros = false;
    this.evidence.particles_created++;
    this.evidence.seed_sets++;
    // A new emitter restarts once when the host's ever did (PM6a rule 4); it adopts the request
    // counter (a joiner never replays an old request).
    if (e.restarts > 0) {
      h.sim.restart();
      this.evidence.restarts++;
    }
    h.restarts = e.restarts;
    h.processRequests = e.process_requests;
    h.emitting = e.emitting;
    h.seed = e.seed;
    for (const f of godotGpuApproximateFeatures(cfg)) this.features.add(f);
  }
}
