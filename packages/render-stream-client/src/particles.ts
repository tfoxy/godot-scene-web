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
//
// J1: with a burst pacing (the client's, `CLIENT_PARTICLE_PACING`), an emitter's burst (its
// `pre_process_time` passes when it starts, a process request) is spread over frames: each `step`
// gives the bursts in progress `sliceMs` between them, after at least one pass each. A settling emitter is drawn as nothing (its instances zeros) until its burst is done,
// and every setter and step it got meanwhile is replayed in order then (`GodotGpuEmitter`'s
// `settling`), so it ends in exactly the state the frames would have left it in. A 400 s preprocess
// (12000 passes) uses both frame slices and off-frame macrotasks. Skip-ahead reduces work;
// every burst, including its clock-only planning, still observes the slice deadline.
//
// Opt-in static particles replace the initial preprocess with the shared representative warm
// time, using the same settling slices. Once uploaded they neither step nor schedule redraws;
// restarts and reconfiguration warm a fresh simulation. One-shots expire on an existing apply
// or present, with no timer (so an otherwise idle canvas can show the tail late).
//
// A material whose key comes from process shader code the client has not got is `suspended`:
// each emitter it drives drops its simulation (its old output is never drawn again) until the code
// arrives, and then starts a fresh one, as a new emitter would. Other emitters are untouched.

import {
  GODOT_GPU_INSTANCE_FLOATS,
  type GodotCurveTexture,
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
  type GodotProcessMaterial,
  godotGpuApproximateFeatures,
  staticOneShotExpired,
  staticWarmSeconds,
} from "@godot-scene-web/effects/particles";

/** The wasm module's particles surface (`GswRs`). */
export interface ParticlesHost {
  particles_sync(): string;
  /** Output curve arena from the last sync; offsets and lengths are in floats. */
  particles_curves_ptr?(): number;
  shader_time(): number;
  particles_set(id: number, data: Float32Array): void;
  /** The core's scratch buffer for `floats` floats (a pointer into wasm memory), which
   * `particles_set_scratch` then takes: no copy through the glue's allocator. Optional: a core
   * built before them has neither, and `particles_set` copies. */
  particles_scratch?(floats: number): number;
  particles_set_scratch?(id: number, floats: number): void;
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
  /** Its key comes from process shader code not held yet (still loading, or unavailable): its
   * emitters are suspended (the wasm dropped their buffers and ignores their uploads) and are
   * re-created, a fresh simulation, once the code arrives and the material is listed again. */
  suspended?: boolean;
  builtin: {
    emission_shape: GodotProcessMaterial["emissionShape"];
    particle_flags: string[];
    sub_emitter: string;
    attractor: boolean;
    collision: string;
    turbulence: boolean;
  } | null;
  uniforms: Record<string, number | number[]>;
  curves: Record<
    string,
    { width: number; height: number } & (
      | { data: number[] | Float32Array }
      | { offset: number; length: number }
    )
  >;
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
  warmPending: boolean;
  frozen: boolean;
  expired: boolean;
  firstEmitting: number | null;
}

/** applied.json `w11.particles`, the shell's half (the wasm adds the draw and emit counters). */
export interface ParticlesEvidence {
  particles_created: number;
  particles_freed: number;
  restarts: number;
  seed_sets: number;
  process_requests: number;
  sim_steps: number;
  /** J1: steps that left an emitter settling (mid-burst, drawn as nothing). */
  settling_steps: number;
  /** Emitters with no keyed process material (nothing GSW can simulate): not drawn. */
  unsimulated: number;
  approximate_features: string[];
}

const DEFAULT_FRAME = 1 / 60;

/** How `step` spreads bursts: the slice (Infinity: a burst runs to its end in one step) and the
 * clock it is measured on. */
export interface ParticleBurstPacing {
  sliceMs: number;
  now: () => number;
  /** Optional off-frame work. The scheduler must enqueue a macrotask, never call inline.
   * Its return value cancels a pending callback. Omitted for deterministic harness runs. */
  idle?: { sliceMs: number; schedule: (run: () => void) => () => void };
}

/** Every burst in one step: the harness receiver pages' default (frame-for-frame evidence). */
export const UNPACED_PARTICLES: ParticleBurstPacing = {
  sliceMs: Number.POSITIVE_INFINITY,
  now: () => 0,
};

/** A macrotask ping, with no persistent channel after completion or cancellation. */
function scheduleParticleChunk(run: () => void): () => void {
  const channel = new MessageChannel();
  const cancel = () => {
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  };
  channel.port1.onmessage = () => {
    cancel();
    run();
  };
  channel.port2.postMessage(null);
  return cancel;
}

/** The client's: 6 ms per frame, plus 8 ms macrotasks while a burst is settling. */
export const CLIENT_PARTICLE_PACING: ParticleBurstPacing = {
  sliceMs: 6,
  now: () => performance.now(),
  idle: { sliceMs: 8, schedule: scheduleParticleChunk },
};

export class GswParticles {
  private readonly held = new Map<number, Held>();
  private readonly materials = new Map<
    number,
    { wire: WireMaterial; material: GodotProcessMaterial | null }
  >();
  private cancelIdle: (() => void) | null = null;
  private idlePaused = false;
  private idleGeneration = 0;
  private disposed = false;
  private readonly page = typeof document === "undefined" ? null : document;
  private readonly onVisibilityChange = () => {
    if (this.page?.hidden) this.stopIdle();
  };
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
    settling_steps: 0,
    unsimulated: 0,
    approximate_features: [],
  };

  constructor(
    private readonly pacing: ParticleBurstPacing = UNPACED_PARTICLES,
    private readonly onIdleUpload: () => void = () => {},
    private staticParticles = false,
    private readonly seconds: () => number = () => performance.now() / 1000,
    /** Harness-only faults: production callers leave this unset. */
    private readonly sabotage:
      | "static-steps-anyway"
      | "static-never-expires"
      | null = null,
  ) {}

  /** A mode change starts fresh simulations; pending warms use the normal settling slices. */
  setStaticParticles(on: boolean): void {
    if (on === this.staticParticles || this.disposed) return;
    this.staticParticles = on;
    this.stopIdle();
    this.lastTime = Number.NaN;
    for (const h of this.held.values()) {
      const material = this.material(h.wire.material);
      const cfg = material ? this.config(h.wire, material) : null;
      if (h.sim && cfg) {
        this.resetSimulation(h, cfg);
        h.warmPending = true;
      }
    }
  }

  private resetSimulation(
    h: Held,
    cfg: GodotGpuEmitterConfig,
  ): GodotGpuEmitter {
    // Use the GPU simulator's preprocess burst, including its yield deadlines. The authored
    // preprocess is replaced, not added: both simulators share the bounded static time policy.
    h.sim = new GodotGpuEmitter(
      this.staticParticles
        ? {
            ...cfg,
            preProcessTime: staticWarmSeconds({
              preprocess: cfg.preProcessTime,
              lifetime: cfg.lifetime,
              oneShot: cfg.oneShot,
            }),
          }
        : cfg,
    );
    h.warmPending = this.staticParticles;
    h.frozen = false;
    h.expired = false;
    h.zeros = false;
    return h.sim;
  }

  /** Expiry is observed only on an apply or a present that happens anyway. With no other
   * redraw a one-shot can remain visible late; there is deliberately no expiry timer. */
  expire(g: ParticlesHost, memory?: WebAssembly.Memory): boolean {
    if (!this.staticParticles || this.sabotage === "static-never-expires")
      return false;
    let uploaded = false;
    for (const [id, h] of this.held) {
      if (!h.sim || h.expired || h.firstEmitting === null) continue;
      if (!staticOneShotExpired(h.sim.config, this.seconds() - h.firstEmitting))
        continue;
      h.expired = true;
      h.warmPending = false;
      h.frozen = true;
      if (!h.zeros) {
        this.upload(
          g,
          id,
          h.sim.config.amount * GODOT_GPU_INSTANCE_FLOATS,
          memory,
          null,
        );
        h.zeros = true;
        uploaded = true;
      }
    }
    if (!this.settling) this.stopIdle();
    return uploaded;
  }

  /** Context loss suspends off-frame work; the next frame after restore schedules it again. */
  pauseIdle(paused: boolean): void {
    this.idlePaused = paused;
    if (paused) this.stopIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.stopIdle();
  }

  private stopIdle(): void {
    this.idleGeneration++;
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.page?.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private scheduleIdle(g: ParticlesHost, memory?: WebAssembly.Memory): void {
    const idle = this.pacing.idle;
    if (!this.settling || this.page?.hidden) this.stopIdle();
    if (
      !idle ||
      this.cancelIdle ||
      this.disposed ||
      this.idlePaused ||
      this.page?.hidden ||
      !this.settling
    )
      return;
    const generation = this.idleGeneration;
    // Hiding cancels work without clearing the independent context-loss pause. Showing does
    // not schedule anything: the next frame's step/settle starts off-frame work again.
    this.page?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.cancelIdle = idle.schedule(() => {
      if (generation !== this.idleGeneration) return;
      this.cancelIdle = null;
      if (this.disposed || this.idlePaused || this.page?.hidden) {
        this.stopIdle();
        return;
      }
      if (this.settleChunk(g, memory, idle.sliceMs)) this.onIdleUpload();
      this.scheduleIdle(g, memory);
    });
  }

  /** Sync with the accepted state only (a revisit: no host time passed, so nothing steps or
   * uploads): a suspended material's emitters drop their simulation, an arrived one's are
   * re-created, and the next `step` advances and uploads them. */
  syncOnly(g: ParticlesHost, memory?: WebAssembly.Memory): void {
    const msg = g.particles_sync();
    if (msg !== "") {
      const parsed = JSON.parse(msg) as {
        ids: number[];
        emitters: WireEmitter[];
        materials: WireMaterial[];
      };
      // Take the pointer before creating views, then copy every curve before any other wasm
      // call (including shader_time or an instance upload) can detach memory or reuse the arena.
      const ptr = g.particles_curves_ptr?.();
      for (const m of parsed.materials) {
        for (const [name, c] of Object.entries(m.curves)) {
          if ("data" in c) continue;
          if (ptr === undefined || memory === undefined)
            throw new Error(
              "Particle curve sidecar requires wasm memory and its arena pointer",
            );
          m.curves[name] = {
            width: c.width,
            height: c.height,
            data: new Float32Array(
              memory.buffer,
              ptr + c.offset * 4,
              c.length,
            ).slice(),
          };
        }
      }
      this.sync(parsed);
    }
    if (!this.settling) this.stopIdle();
  }

  /** Sync with the accepted state, step every emitter by the host's time and upload. With the
   * core's `memory`, each emitter packs straight into the core's scratch buffer. */
  step(g: ParticlesHost, memory?: WebAssembly.Memory): void {
    this.syncOnly(g, memory);
    this.expire(g, memory);
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
    const yieldNow = this.slice();
    for (const [id, h] of this.held) {
      const sim = h.sim;
      if (
        !sim ||
        (this.staticParticles &&
          (h.expired || (h.frozen && this.sabotage !== "static-steps-anyway")))
      )
        continue;
      const before = sim.stats.steps;
      // The shader's TIME is the host's (turbulence reads it); without one, the sim's own sum.
      if (this.staticParticles && this.sabotage !== "static-steps-anyway") {
        if (h.warmPending) {
          h.warmPending = false;
          sim.update(0, Number.isFinite(t) ? t : undefined, yieldNow);
        } else sim.advance(yieldNow);
      } else {
        h.warmPending = false;
        sim.update(dt, Number.isFinite(t) ? t : undefined, yieldNow);
      }
      this.evidence.sim_steps += sim.stats.steps - before;
      if (sim.settling) {
        // Mid-burst: nothing of it is drawn until the burst is done.
        if (!h.zeros) {
          this.upload(
            g,
            id,
            sim.config.amount * GODOT_GPU_INSTANCE_FLOATS,
            memory,
            null,
          );
          h.zeros = true;
        }
        this.evidence.settling_steps++;
        continue;
      }
      h.frozen = this.staticParticles;
      if (sim.isInactive && h.zeros) continue;
      this.upload(
        g,
        id,
        sim.config.amount * GODOT_GPU_INSTANCE_FLOATS,
        memory,
        sim,
      );
      h.zeros = sim.isInactive;
    }
    this.scheduleIdle(g, memory);
  }

  /** Share one deadline across all emitters, including the first work unit. */
  private slice(sliceMs = this.pacing.sliceMs): (() => boolean) | undefined {
    if (!Number.isFinite(sliceMs)) return undefined;
    const deadline = this.pacing.now() + sliceMs;
    return () => this.pacing.now() >= deadline;
  }

  /** Planned shader work remaining; null while any settling emitter is still planning or
   * using the conservative full path. No burst means zero. */
  get burstParticlePassesRemaining(): number | null {
    let remaining = 0;
    for (const h of this.held.values()) {
      if (h.expired || !h.sim?.settling) continue;
      const work = h.sim.stats.burstParticlePassesRemaining;
      if (work === null) return null;
      remaining += work;
    }
    return remaining;
  }

  /** Whether an emitter is mid-burst (drawn as nothing until `step` or `settle` finishes it). */
  get settling(): boolean {
    for (const h of this.held.values())
      if (!h.expired && (h.warmPending || h.sim?.settling)) return true;
    return false;
  }

  /** J1: a frame with no applier run (no transaction, the host idle or paused): the bursts in
   * progress continue in the same slice, with no time passing, and an emitter whose burst ends
   * uploads its instances. True when one did: the core's `reapply` then draws it. */
  settle(g: ParticlesHost, memory?: WebAssembly.Memory): boolean {
    const uploaded = this.settleChunk(g, memory, this.pacing.sliceMs);
    this.scheduleIdle(g, memory);
    return uploaded;
  }

  private settleChunk(
    g: ParticlesHost,
    memory: WebAssembly.Memory | undefined,
    sliceMs: number,
  ): boolean {
    let uploaded = false;
    const yieldNow = this.slice(sliceMs);
    for (const [id, h] of this.held) {
      const sim = h.sim;
      if (h.expired || !sim || (!h.warmPending && !sim.settling)) continue;
      if (yieldNow?.()) break;
      const before = sim.stats.steps;
      if (h.warmPending) {
        h.warmPending = false;
        sim.update(0, g.shader_time(), yieldNow);
      } else sim.advance(yieldNow);
      this.evidence.sim_steps += sim.stats.steps - before;
      if (sim.settling) {
        if (!h.zeros) {
          this.upload(
            g,
            id,
            sim.config.amount * GODOT_GPU_INSTANCE_FLOATS,
            memory,
            null,
          );
          h.zeros = true;
          uploaded = true;
        }
        continue;
      }
      this.upload(
        g,
        id,
        sim.config.amount * GODOT_GPU_INSTANCE_FLOATS,
        memory,
        sim,
      );
      h.zeros = sim.isInactive;
      h.frozen = this.staticParticles;
      uploaded = true;
    }
    return uploaded;
  }

  /** Emitter `id`'s `floats` instance floats to the core: `sim`'s packed instances, or zeros
   * (nothing drawn) for null. With the core's `memory`, straight into its scratch buffer. */
  private upload(
    g: ParticlesHost,
    id: number,
    floats: number,
    memory: WebAssembly.Memory | undefined,
    sim: GodotGpuEmitter | null,
  ): void {
    if (
      memory !== undefined &&
      g.particles_scratch !== undefined &&
      g.particles_set_scratch !== undefined
    ) {
      // No wasm call between the view and the pack: the pointer stays valid.
      const ptr = g.particles_scratch(floats);
      const out = new Float32Array(memory.buffer, ptr, floats);
      if (sim) sim.pack(out);
      else out.fill(0);
      g.particles_set_scratch(id, floats);
    } else {
      if (this.buf.length < floats) this.buf = new Float32Array(floats);
      const out = this.buf.subarray(0, floats);
      if (sim) sim.pack(out);
      else out.fill(0);
      g.particles_set(id, out);
    }
  }

  private material(id: number | null): GodotProcessMaterial | null {
    if (id === null) return null;
    return this.materials.get(id)?.material ?? null;
  }

  private suspended(id: number | null): boolean {
    return id !== null && this.materials.get(id)?.wire.suspended === true;
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
      const material: GodotProcessMaterial | null =
        m.builtin && m.suspended !== true
          ? {
              emissionShape: m.builtin.emission_shape,
              flags: m.builtin.particle_flags,
              turbulence: m.builtin.turbulence,
              uniforms: m.uniforms,
              curves: Object.fromEntries(
                Object.entries(m.curves).map(
                  ([k, c]): [string, GodotCurveTexture] => {
                    if (!("data" in c))
                      throw new Error("Uncopied particle curve sidecar");
                    return [
                      k,
                      {
                        width: c.width,
                        height: c.height,
                        data:
                          c.data instanceof Float32Array
                            ? c.data
                            : Float32Array.from(c.data),
                      },
                    ];
                  },
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
        warmPending: false,
        frozen: false,
        expired: false,
        firstEmitting: e.emitting ? this.seconds() : null,
      };
      this.held.set(e.id, h);
      if (!cfg) {
        this.evidence.unsimulated++;
        return;
      }
      this.make(h, cfg, e);
      return;
    }
    // Track wire edges even while there is no simulation (suspended/missing material or
    // floats). A material-only arrival must retain the original one-shot burst window.
    const previous = h.wire;
    if (e.restarts !== previous.restarts || (e.emitting && !previous.emitting))
      h.firstEmitting = this.seconds();
    else if (!e.emitting) h.firstEmitting = null;
    h.wire = e;
    if (this.suspended(e.material)) {
      // Its old simulated output goes (the wasm dropped the buffer); the code's arrival makes a
      // fresh simulation.
      if (h.sim) this.evidence.particles_freed++;
      h.sim = null;
      h.warmPending = false;
      h.zeros = false;
      return;
    }
    if (!cfg) return;
    if (!h.sim) {
      this.make(h, cfg, e);
      return;
    }
    if (this.staticParticles) {
      if (
        cfg.material === h.sim.config.material &&
        sameStaticShape(previous, e)
      ) {
        // Node motion changes future spawn inputs, not the held representative frame. Preserve
        // the substituted warm time, including when configure is queued during settling.
        h.sim.configure({
          ...cfg,
          preProcessTime: h.sim.config.preProcessTime,
        });
      } else this.resetSimulation(h, cfg);
    } else h.sim.configure(cfg);
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
      if (!this.staticParticles) h.sim.requestProcess(e.f.request_process_time);
      h.processRequests = e.process_requests;
      this.evidence.process_requests++;
    }
    for (const f of godotGpuApproximateFeatures(cfg)) this.features.add(f);
  }

  private make(h: Held, cfg: GodotGpuEmitterConfig, e: WireEmitter): void {
    const sim = this.resetSimulation(h, cfg);
    this.evidence.particles_created++;
    this.evidence.seed_sets++;
    // A new emitter restarts once when the host's ever did (PM6a rule 4); it adopts the request
    // counter (a joiner never replays an old request).
    if (e.restarts > 0) {
      sim.restart();
      this.evidence.restarts++;
    }
    h.restarts = e.restarts;
    h.processRequests = e.process_requests;
    h.emitting = e.emitting;
    h.seed = e.seed;
    for (const f of godotGpuApproximateFeatures(cfg)) this.features.add(f);
  }
}

/** Version, spawn motion and emission/process requests do not reconfigure a held static
 * simulation. Restart counters and all other settings still take the fresh-warm path. */
function sameStaticShape(a: WireEmitter, b: WireEmitter): boolean {
  const shape = ({
    version: _version,
    emits: _emits,
    process_requests: _requests,
    f,
    ...rest
  }: WireEmitter) => {
    if (!f) return rest;
    const {
      emission_transform: _transform,
      emitter_velocity: _velocity,
      request_process_time: _requestTime,
      ...floats
    } = f;
    return { ...rest, f: floats };
  };
  return JSON.stringify(shape(a)) === JSON.stringify(shape(b));
}
