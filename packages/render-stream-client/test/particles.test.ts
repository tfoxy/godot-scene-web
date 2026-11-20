// A process material keyed from shader code the client has not got is `suspended`: its emitters
// drop their simulation (never drawn from the old output) and start a fresh one when the code
// arrives; other emitters are untouched.

import {
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
  staticWarmSeconds,
} from "@godot-scene-web/effects/particles";
import { describe, expect, it, vi } from "vitest";
import {
  GswParticles,
  type ParticlesHost,
  UNPACED_PARTICLES,
} from "../src/particles";
import baseGolden from "./fixtures/particles-base.json";

const builtin = {
  emission_shape: "point",
  particle_flags: ["disable_z"],
  sub_emitter: "disabled",
  attractor: false,
  collision: "disabled",
  turbulence: false,
};

const emitter = (id: number, material: number) => ({
  id,
  version: 1,
  emitting: true,
  amount: 4,
  one_shot: false,
  fixed_fps: 0,
  interpolate: false,
  fractional_delta: false,
  local: false,
  draw_order: "index",
  trails: false,
  seed: 3,
  restarts: 0,
  emits: 0,
  process_requests: 0,
  material,
  f: {
    amount_ratio: 1,
    lifetime: 1,
    pre_process_time: 0,
    explosiveness: 0,
    randomness: 0,
    speed_scale: 1,
    interp_to_end: 0,
    request_process_time: 0,
    emission_transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    emitter_velocity: [0, 0, 0],
  },
});

const material = (id: number, version: number, suspended: boolean) => ({
  id,
  version,
  ...(suspended ? { suspended: true } : {}),
  builtin,
  uniforms: {},
  curves: {},
});

function host(messages: string[]) {
  const sets: number[] = [];
  let t = 0;
  const g: ParticlesHost = {
    particles_sync: () => messages.shift() ?? "",
    shader_time: () => (t += 1 / 60),
    particles_set: (id) => {
      sets.push(id);
    },
  };
  return { g, sets };
}

describe("GswParticles suspended process materials", () => {
  it("suspends only the affected emitter and re-creates it once the code arrives", () => {
    const p = new GswParticles();
    const { g, sets } = host([
      JSON.stringify({
        ids: [1, 2],
        emitters: [emitter(1, 20), emitter(2, 21)],
        materials: [material(20, 1, false), material(21, 1, false)],
      }),
      // The process code of material 20 is no longer held (a new shader version): suspended.
      JSON.stringify({
        ids: [1, 2],
        emitters: [],
        materials: [material(20, 2, true)],
      }),
      "",
      // It arrives: listed again, keyed.
      JSON.stringify({
        ids: [1, 2],
        emitters: [],
        materials: [material(20, 2, false)],
      }),
    ]);
    p.step(g);
    expect(p.evidence.particles_created).toBe(2);
    expect(sets.sort()).toEqual([1, 2]);
    sets.length = 0;
    p.step(g);
    expect(p.evidence.particles_freed).toBe(1);
    expect(sets).toEqual([2]); // emitter 1 uploads nothing while suspended
    sets.length = 0;
    p.step(g);
    expect(sets).toEqual([2]);
    sets.length = 0;
    p.step(g);
    expect(p.evidence.particles_created).toBe(3); // a fresh simulation
    expect(sets.sort()).toEqual([1, 2]);
  });
});

describe("GswParticles revisit sync", () => {
  it("syncOnly re-creates an arrived material's emitter without stepping or uploading", () => {
    const p = new GswParticles();
    const { g, sets } = host([
      JSON.stringify({
        ids: [1],
        emitters: [emitter(1, 20)],
        materials: [material(20, 1, true)],
      }),
      JSON.stringify({
        ids: [1],
        emitters: [],
        materials: [material(20, 1, false)],
      }),
    ]);
    p.step(g);
    expect(p.evidence.particles_created).toBe(0);
    expect(sets).toEqual([]);
    p.syncOnly(g);
    expect(p.evidence.particles_created).toBe(1);
    expect(p.evidence.sim_steps).toBe(0);
    expect(sets).toEqual([]);
    p.step(g);
    expect(sets).toEqual([1]);
  });
});

describe("GswParticles scratch upload", () => {
  it("packs into the core's scratch view and hands it over by length, the same floats as a copy", () => {
    const msg = () =>
      JSON.stringify({
        ids: [1],
        emitters: [emitter(1, 20)],
        materials: [material(20, 1, false)],
      });
    // The copying path.
    const copied: Float32Array[] = [];
    let t0 = 0;
    const plain: ParticlesHost = {
      particles_sync: (() => {
        const m = [msg()];
        return () => m.shift() ?? "";
      })(),
      shader_time: () => (t0 += 1 / 60),
      particles_set: (_id, data) => {
        copied.push(data.slice());
      },
    };
    // The scratch path: a view on "wasm memory" at the pointer the core returns.
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ptr = 256;
    const taken: { id: number; floats: Float32Array }[] = [];
    let copies = 0;
    let t1 = 0;
    const scratch: ParticlesHost = {
      particles_sync: (() => {
        const m = [msg()];
        return () => m.shift() ?? "";
      })(),
      shader_time: () => (t1 += 1 / 60),
      particles_set: () => {
        copies++;
      },
      particles_scratch: () => ptr,
      particles_set_scratch: (id, floats) => {
        taken.push({
          id,
          floats: new Float32Array(memory.buffer, ptr, floats).slice(),
        });
      },
    };
    const a = new GswParticles();
    const b = new GswParticles();
    for (let i = 0; i < 3; i++) {
      a.step(plain);
      b.step(scratch, memory);
    }
    expect(copies).toBe(0);
    expect(taken.map((x) => x.id)).toEqual([1, 1, 1]);
    expect(taken.map((x) => Array.from(x.floats))).toEqual(
      copied.map((x) => Array.from(x)),
    );
    // Without the memory, the scratch-capable core is fed by copy.
    b.step(scratch);
    expect(copies).toBe(1);
  });
});

describe("GswParticles burst pacing (J1)", () => {
  it("keeps eligible long preprocess paced until its planned work completes", () => {
    const pre = {
      ...emitter(1, 20),
      amount: 40,
      fixed_fps: 30,
      f: { ...emitter(1, 20).f, pre_process_time: 400, lifetime: 2 },
    };
    const start = JSON.stringify({
      ids: [1],
      emitters: [pre],
      materials: [material(20, 1, false)],
    });
    let clock = 0;
    const now = () => clock++;
    const paced = new GswParticles({ sliceMs: 3, now });
    const { g, sets } = host([start]);
    paced.step(g);
    expect(paced.settling).toBe(true);
    expect(paced.evidence.settling_steps).toBe(1);
    expect(sets).toEqual([1]);
    while (paced.settling) paced.settle(g);
    expect(paced.burstParticlePassesRemaining).toBe(0);
    expect(sets).toEqual([1, 1]);
    expect(paced.evidence.sim_steps).toBe(12000);
  });

  it("draws a preprocessing emitter as nothing until its burst is done, then as the unpaced one", () => {
    const pre = {
      ...emitter(1, 20),
      amount: 6,
      // Out-of-range restart randomness selects the conservative pacing fallback.
      f: {
        ...emitter(1, 20).f,
        pre_process_time: 2,
        lifetime: 1.5,
        randomness: 1.1,
      },
    };
    const start = JSON.stringify({
      ids: [1],
      emitters: [pre],
      materials: [material(20, 1, false)],
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const scratchHost = () => {
      const taken: Float32Array[] = [];
      let t = 0;
      const msgs = [start];
      const g: ParticlesHost = {
        particles_sync: () => msgs.shift() ?? "",
        shader_time: () => (t += 1 / 60),
        particles_set: () => {
          throw new Error("copied");
        },
        particles_scratch: () => 1024,
        particles_set_scratch: (_id, floats) => {
          taken.push(new Float32Array(memory.buffer, 1024, floats).slice());
        },
      };
      return { g, taken };
    };
    // Every clock read is a millisecond later: a 3 ms slice is about three passes per step.
    let clock = 0;
    const paced = new GswParticles({ sliceMs: 3, now: () => clock++ });
    const plain = new GswParticles();
    const a = scratchHost();
    const b = scratchHost();
    let steps = 0;
    do {
      paced.step(a.g, memory);
      plain.step(b.g, memory);
      steps++;
    } while (paced.evidence.settling_steps === steps && steps < 500);
    // 2 s at 30 passes/s: 61 passes, a few per step.
    expect(steps).toBeGreaterThan(10);
    // One upload of zeros when it started settling, none while it settled, then its instances.
    expect(a.taken).toHaveLength(2);
    expect(a.taken[0].every((v) => v === 0)).toBe(true);
    expect(Array.from(a.taken[1])).toEqual(Array.from(b.taken.at(-1) ?? []));
    expect(paced.evidence.sim_steps).toBe(plain.evidence.sim_steps);
  });
});

describe("GswParticles idle settle (J1)", () => {
  it("finishes a burst with no step after the first and uploads the unpaced instances", () => {
    const pre = {
      ...emitter(1, 20),
      amount: 6,
      f: {
        ...emitter(1, 20).f,
        pre_process_time: 2,
        lifetime: 1.5,
        randomness: 1.1,
      },
    };
    const start = JSON.stringify({
      ids: [1],
      emitters: [pre],
      materials: [material(20, 1, false)],
    });
    const host = () => {
      const taken: Float32Array[] = [];
      const msgs = [start];
      const g: ParticlesHost = {
        particles_sync: () => msgs.shift() ?? "",
        shader_time: () => 5,
        particles_set: (_id, data) => {
          taken.push(data.slice());
        },
      };
      return { g, taken };
    };
    let clock = 0;
    const paced = new GswParticles({ sliceMs: 3, now: () => clock++ });
    const plain = new GswParticles();
    const a = host();
    const b = host();
    paced.step(a.g);
    plain.step(b.g);
    expect(paced.settling).toBe(true);
    expect(a.taken).toHaveLength(1); // zeros
    let settles = 0;
    while (!paced.settle(a.g) && settles < 500) settles++;
    expect(settles).toBeGreaterThan(5);
    expect(paced.settling).toBe(false);
    expect(a.taken).toHaveLength(2);
    expect(Array.from(a.taken[1])).toEqual(Array.from(b.taken[0]));
    expect(paced.settle(a.g)).toBe(false);
  });
});

describe("GswParticles off-frame chunks", () => {
  function idleHarness() {
    const pre = {
      ...emitter(1, 20),
      amount: 40,
      fixed_fps: 30,
      f: { ...emitter(1, 20).f, pre_process_time: 2, lifetime: 2 },
    };
    const start = JSON.stringify({
      ids: [1],
      emitters: [pre],
      materials: [material(20, 1, false)],
    });
    const a = host([start]);
    const b = host([start]);
    const plain = new GswParticles();
    const pending = new Set<() => void>();
    let clock = 0;
    const uploaded = vi.fn();
    const paced = new GswParticles(
      {
        sliceMs: 6,
        now: () => clock,
        idle: {
          sliceMs: 8,
          schedule: (run) => {
            pending.add(run);
            return () => pending.delete(run);
          },
        },
      },
      uploaded,
    );
    // Load the simulation before stepping so each clock/shader unit has a deterministic cost.
    paced.syncOnly(a.g);
    const held = Reflect.get(paced, "held") as Map<number, { sim: object }>;
    const sim = held.get(1)!.sim;
    const methods = sim as {
      processClock(delta: number): number;
      shade(...args: unknown[]): void;
    };
    const clockStep = methods.processClock.bind(sim);
    vi.spyOn(methods, "processClock").mockImplementation((dt) => {
      clock++;
      return clockStep(dt);
    });
    const shade = methods.shade.bind(sim);
    vi.spyOn(methods, "shade").mockImplementation((...args) => {
      // Burst shaders cost one unit; ordinary frame passes are charged by processClock.
      if (Reflect.get(sim, "burst") !== null) clock++;
      shade(...args);
    });
    const update = vi.spyOn(
      Reflect.get(sim, "constructor").prototype,
      "update",
    );
    const run = () => {
      expect(pending.size).toBe(1);
      const task = [...pending][0];
      pending.delete(task);
      const before = clock;
      task();
      expect(clock - before).toBeLessThanOrEqual(8);
    };
    return {
      paced,
      plain,
      a,
      b,
      pending,
      run,
      uploaded,
      update,
      sim,
      clock: () => clock,
    };
  }

  it("converges a paused stream using bounded macrotasks and stops when settled", () => {
    const h = idleHarness();
    h.paced.step(h.a.g);
    h.plain.step(h.b.g);
    expect(h.clock()).toBeLessThanOrEqual(6);
    expect(h.paced.settling).toBe(true);
    expect(h.uploaded).not.toHaveBeenCalled(); // Scheduling never advances inside step.
    const updates = h.update.mock.calls.length;
    let chunks = 0;
    while (h.pending.size) {
      h.run();
      chunks++;
      expect(chunks).toBeLessThan(1000);
    }
    expect(h.paced.settling).toBe(false);
    expect(h.uploaded).toHaveBeenCalledOnce();
    expect(h.update.mock.calls.length).toBe(updates);
    expect(h.paced.evidence.sim_steps).toBe(h.plain.evidence.sim_steps);
    expect(h.paced.burstParticlePassesRemaining).toBe(0);
    expect(h.a.sets).toEqual([1, 1]);
    h.update.mockRestore();
  });

  it("interleaves frame updates and idle advances without double-stepping", () => {
    const h = idleHarness();
    for (let frame = 0; frame < 3; frame++) {
      h.paced.step(h.a.g);
      h.plain.step(h.b.g);
      if (h.pending.size) h.run();
    }
    // Three updates each for paced and plain, irrespective of how many idle chunks ran.
    expect(h.update).toHaveBeenCalledTimes(6);
    while (h.pending.size) h.run();
    expect(h.update).toHaveBeenCalledTimes(6);
    expect(h.paced.evidence.sim_steps).toBe(h.plain.evidence.sim_steps);
    h.update.mockRestore();
  });

  it("cancels on dispose, even if a cancelled callback is delivered", () => {
    const h = idleHarness();
    h.paced.step(h.a.g);
    const late = [...h.pending][0];
    const before = h.clock();
    h.paced.dispose();
    expect(h.pending.size).toBe(0);
    late();
    expect(h.clock()).toBe(before);
    expect(h.uploaded).not.toHaveBeenCalled();
    h.update.mockRestore();
  });

  it("cancels on context loss and resumes after restore", () => {
    const h = idleHarness();
    h.paced.step(h.a.g);
    h.paced.pauseIdle(true);
    expect(h.pending.size).toBe(0);
    const before = h.clock();
    h.paced.pauseIdle(false);
    expect(h.clock()).toBe(before);
    h.paced.settle(h.a.g);
    while (h.pending.size) h.run();
    expect(h.paced.settling).toBe(false);
    h.update.mockRestore();
  });

  it("does no idle work while hidden and resumes from a visible frame", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const h = idleHarness();
    try {
      h.paced.step(h.a.g);
      h.plain.step(h.b.g);
      const late = [...h.pending][0];
      const before = h.clock();
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h.pending.size).toBe(0);
      // Context restoration must not resume work on a hidden page.
      h.paced.pauseIdle(true);
      h.paced.pauseIdle(false);
      for (let dispatch = 0; dispatch < 100; dispatch++) late();
      expect(h.clock()).toBe(before);
      expect(h.pending.size).toBe(0);
      expect(h.uploaded).not.toHaveBeenCalled();
      expect(h.paced.settling).toBe(true);

      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h.clock()).toBe(before);
      expect(h.pending.size).toBe(0); // Wait until the client presents another frame.
      h.paced.settle(h.a.g);
      expect(h.pending.size).toBe(1);
      const resumed = [...h.pending];
      late();
      expect([...h.pending]).toEqual(resumed);
      while (h.pending.size) h.run();
      expect(h.paced.settling).toBe(false);
      expect(h.paced.evidence.sim_steps).toBe(h.plain.evidence.sim_steps);
      expect(h.update).toHaveBeenCalledTimes(2); // Idle chunks never add frame updates.
    } finally {
      h.paced.dispose();
      h.update.mockRestore();
      hidden.mockRestore();
    }
  });

  it("never schedules idle work when a burst starts on a hidden page", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const h = idleHarness();
    try {
      h.paced.step(h.a.g);
      expect(h.paced.settling).toBe(true);
      expect(h.pending.size).toBe(0);
      h.paced.pauseIdle(true);
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      h.paced.settle(h.a.g);
      expect(h.pending.size).toBe(0); // Visibility cannot clear the context-loss pause.
      h.paced.pauseIdle(false);
      h.paced.settle(h.a.g);
      expect(h.pending.size).toBe(1);
    } finally {
      h.paced.dispose();
      h.update.mockRestore();
      hidden.mockRestore();
    }
  });
});

describe("GswParticles static mode", () => {
  function setup(
    oneShot = false,
    preprocess = 0,
    paced = false,
    on = true,
    sabotage: "static-steps-anyway" | "static-never-expires" | null = null,
    initiallyEmitting = true,
  ) {
    const e = emitter(1, 20);
    e.one_shot = oneShot;
    e.emitting = initiallyEmitting;
    e.fixed_fps = 30;
    e.f.pre_process_time = preprocess;
    const m = material(20, 1, false);
    m.uniforms = {
      gravity: [0, 20, 0],
      initial_linear_velocity_min: 30,
    } as typeof m.uniforms;
    const messages = [
      JSON.stringify({ ids: [1], emitters: [e], materials: [m] }),
    ];
    const taken: Float32Array[] = [];
    let time = 0;
    let clock = 0;
    const pending = new Set<() => void>();
    const pacing = paced
      ? {
          sliceMs: 3,
          now: () => clock++,
          idle: {
            sliceMs: 3,
            schedule: (run: () => void) => {
              pending.add(run);
              return () => {
                pending.delete(run);
              };
            },
          },
        }
      : UNPACED_PARTICLES;
    const p = new GswParticles(
      pacing,
      () => {},
      on,
      () => time,
      sabotage,
    );
    const g: ParticlesHost = {
      particles_sync: () => messages.shift() ?? "",
      shader_time: () => time,
      particles_set: (_id, data) => taken.push(data.slice()),
    };
    const config: GodotGpuEmitterConfig = {
      emitting: true,
      amount: e.amount,
      amountRatio: 1,
      lifetime: 1,
      oneShot,
      preProcessTime: preprocess,
      explosiveness: 0,
      randomness: 0,
      speedScale: 1,
      fixedFps: 30,
      interpolate: false,
      fractionalDelta: false,
      localCoords: false,
      drawOrder: "index",
      interpToEnd: 0,
      emissionTransform: e.f.emission_transform,
      emitterVelocity: e.f.emitter_velocity,
      seed: e.seed,
      material: {
        emissionShape: "point",
        flags: ["disable_z"],
        uniforms: m.uniforms,
        curves: {},
      },
    };
    return {
      p,
      g,
      taken,
      pending,
      config,
      send: (emitters: unknown[], materials: unknown[]) => {
        messages.push(JSON.stringify({ ids: [1], emitters, materials }));
      },
      time: (t: number) => {
        time = t;
      },
      change: (over: Partial<typeof e>) => {
        Object.assign(e, over);
        e.version++;
        messages.push(
          JSON.stringify({ ids: [1], emitters: [e], materials: [] }),
        );
      },
    };
  }

  function assertHeld(h: ReturnType<typeof setup>) {
    h.p.step(h.g);
    const steps = h.p.evidence.sim_steps;
    expect(h.taken[0].some((v) => v !== 0)).toBe(true);
    for (const t of [0.1, 1, 10]) {
      h.time(t);
      h.p.step(h.g);
      expect(h.p.settle(h.g)).toBe(false);
    }
    expect(h.taken).toHaveLength(1);
    expect(h.p.evidence.sim_steps).toBe(steps);
    expect(h.p.settling).toBe(false);
  }

  it("holds a constant uploaded buffer and does no further simulation or uploads", () => {
    assertHeld(setup());
  });

  it("the static-steps-anyway sabotage fails the held-buffer acceptance", () => {
    expect(() =>
      assertHeld(setup(false, 0, false, true, "static-steps-anyway")),
    ).toThrow();
  });

  function assertExpired(h: ReturnType<typeof setup>) {
    h.p.step(h.g);
    h.time(2);
    h.p.step(h.g);
    expect(h.taken.at(-1)!.every((v) => v === 0)).toBe(true);
    expect(h.taken).toHaveLength(2);
  }

  it("the static-never-expires sabotage fails the expiry acceptance", () => {
    assertExpired(setup(true));
    expect(() =>
      assertExpired(setup(true, 0, false, true, "static-never-expires")),
    ).toThrow();
  });

  it.each([
    [false, 0],
    [true, 0],
    [false, 100],
    [true, 0.2],
  ] as const)("matches the GPU emitter warmed by the shared time (oneShot=%s, preprocess=%s)", (oneShot, preprocess) => {
    const h = setup(oneShot, preprocess);
    h.p.step(h.g);
    const sim = new GodotGpuEmitter({
      ...h.config,
      preProcessTime: staticWarmSeconds({
        preprocess,
        lifetime: h.config.lifetime,
        oneShot,
      }),
    });
    sim.update(0, 0);
    const expected = new Float32Array(h.config.amount * 16);
    sim.pack(expected);
    expect(h.taken).toEqual([expected]);
  });

  it.each([
    0, 1,
  ])("retires a one-shot after its burst window (explosiveness=%s)", (explosiveness) => {
    const h = setup(true);
    h.change({ f: { ...emitter(1, 20).f, explosiveness } });
    h.p.step(h.g);
    h.p.step(h.g);
    const count = h.taken.length;
    h.time(2 - explosiveness - 0.001);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(count);
    h.time(2 - explosiveness);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(count + 1);
    expect(h.taken.at(-1)!.every((v) => v === 0)).toBe(true);
    h.time(10);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(count + 1);
  });

  it("observes expiry on a present without a new transaction, with no expiry task", () => {
    const h = setup(true);
    h.p.step(h.g);
    h.time(5);
    expect(h.pending.size).toBe(0);
    expect(h.taken).toHaveLength(1);
    expect(h.p.expire(h.g)).toBe(true);
    expect(h.taken[1].every((v) => v === 0)).toBe(true);
    expect(h.p.expire(h.g)).toBe(false);
  });

  it("re-warms a restarted one-shot and gives it a fresh expiry window", () => {
    const h = setup(true);
    h.p.step(h.g);
    const warm = h.taken[0];
    h.time(3);
    h.p.step(h.g);
    h.change({ restarts: 1 });
    h.p.step(h.g);
    expect(h.taken).toHaveLength(3);
    expect(h.taken[2]).toEqual(warm);
    h.time(4.99);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(3);
    h.time(5);
    h.p.step(h.g);
    expect(h.taken[3].every((v) => v === 0)).toBe(true);
  });

  it.each([
    "start",
    "restart",
  ])("expires after a %s while the material is suspended", (edge) => {
    const h = setup(true, 0, false, true, null, edge === "restart");
    h.p.step(h.g);
    h.send([], [material(20, 2, true)]);
    h.p.step(h.g);
    h.time(1);
    h.change({ emitting: true, restarts: edge === "restart" ? 1 : 0 });
    h.p.step(h.g);
    h.time(1.1);
    h.send([], [material(20, 2, false)]);
    h.p.step(h.g);
    expect(h.taken.at(-1)!.some((v) => v !== 0)).toBe(true);
    const count = h.taken.length;
    h.time(2.999);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(count);
    h.time(3);
    h.p.step(h.g);
    expect(h.taken).toHaveLength(count + 1);
    expect(h.taken.at(-1)!.every((v) => v === 0)).toBe(true);
  });

  it("holds across per-frame emission transforms and velocities, then restarts with current inputs", () => {
    const h = setup();
    h.p.step(h.g);
    const steps = h.p.evidence.sim_steps;
    const f = emitter(1, 20).f;
    for (let frame = 1; frame <= 30; frame++) {
      f.emission_transform[9] = frame * 2;
      h.change({ f: structuredClone(f) });
      h.time(frame / 60);
      h.p.step(h.g);
      f.emitter_velocity[0] = frame;
      h.change({ f: structuredClone(f) });
      h.p.step(h.g);
      expect(h.p.evidence.sim_steps).toBe(steps);
      expect(h.taken).toHaveLength(1);
      expect(h.p.settling).toBe(false);
    }
    h.change({ restarts: 1 });
    h.p.step(h.g);
    const expected = setup();
    expected.change({ f });
    expected.p.step(expected.g);
    expected.p.step(expected.g);
    expect(h.taken.at(-1)).toEqual(expected.taken.at(-1));
  });

  it.each([
    false,
    true,
  ])("holds across operation-only updates and still re-warms on restart (paced=%s)", (paced) => {
    const h = setup(false, 0, paced);
    const finishWarm = () => {
      let chunks = 0;
      while (h.pending.size) {
        const task = [...h.pending][0];
        h.pending.delete(task);
        task();
        expect(++chunks).toBeLessThan(1000);
      }
      expect(h.p.settling).toBe(false);
    };
    h.p.step(h.g);
    finishWarm();
    const steps = h.p.evidence.sim_steps;
    const uploads = h.taken.length;
    const warm = h.taken.at(-1);
    const assertUnchanged = () => {
      expect(h.p.evidence.sim_steps).toBe(steps);
      expect(h.taken).toHaveLength(uploads);
      expect(h.p.settling).toBe(false);
      expect(h.pending.size).toBe(0);
    };
    for (let counter = 1; counter <= 30; counter++) {
      h.change({ emits: counter });
      h.time(counter / 60);
      h.p.step(h.g);
      assertUnchanged();
    }
    for (let counter = 1; counter <= 30; counter++) {
      h.change({
        process_requests: counter,
        f: { ...emitter(1, 20).f, request_process_time: counter / 10 },
      });
      h.time((30 + counter) / 60);
      h.p.step(h.g);
      assertUnchanged();
      expect(h.p.evidence.process_requests).toBe(counter);
    }
    // Repeated counter values are adopted, so they are not counted again on a version bump.
    h.change({});
    h.p.step(h.g);
    assertUnchanged();
    expect(h.p.evidence.process_requests).toBe(30);
    h.change({ restarts: 1 });
    h.p.step(h.g);
    finishWarm();
    expect(h.p.evidence.restarts).toBe(1);
    expect(h.p.evidence.sim_steps).toBeGreaterThan(steps);
    expect(h.taken.length).toBeGreaterThan(uploads);
    expect(h.taken.at(-1)).toEqual(warm);
    h.p.dispose();
  });

  it("still replays process requests in live mode", () => {
    const h = setup(false, 0, false, false);
    const request = vi.spyOn(GodotGpuEmitter.prototype, "requestProcess");
    try {
      h.p.step(h.g);
      h.change({
        process_requests: 1,
        f: { ...emitter(1, 20).f, request_process_time: 0.75 },
      });
      h.p.step(h.g);
      expect(request).toHaveBeenCalledExactlyOnceWith(0.75);
      expect(h.p.evidence.process_requests).toBe(1);
    } finally {
      request.mockRestore();
      h.p.dispose();
    }
  });

  it("turns on for current emitters and resumes live simulation from a fresh start", () => {
    const h = setup(false, 0, false, false);
    h.p.step(h.g);
    h.time(0.5);
    h.p.step(h.g);
    h.p.setStaticParticles(true);
    expect(h.p.settle(h.g)).toBe(true);
    const warm = setup();
    warm.p.step(warm.g);
    expect(h.taken.at(-1)).toEqual(warm.taken[0]);
    h.p.setStaticParticles(false);
    expect(h.p.settle(h.g)).toBe(true);
    const fresh = setup(false, 0, false, false);
    fresh.p.step(fresh.g);
    expect(h.taken.at(-1)).toEqual(fresh.taken[0]);
    h.time(0.6);
    h.p.step(h.g);
    h.time(0.7);
    h.p.step(h.g);
    expect(h.taken.at(-1)).not.toEqual(fresh.taken[0]);
  });

  it("paces a long static warm and finishes it off-frame, then parks", () => {
    const h = setup(false, 400, true);
    h.change({
      f: { ...emitter(1, 20).f, lifetime: 400, pre_process_time: 400 },
    });
    h.p.step(h.g);
    h.p.step(h.g);
    expect(h.p.settling).toBe(true);
    expect(h.taken[0].every((v) => v === 0)).toBe(true);
    let chunks = 0;
    while (h.pending.size) {
      const task = [...h.pending][0];
      h.pending.delete(task);
      task();
      expect(++chunks).toBeLessThan(50000);
    }
    expect(chunks).toBeGreaterThan(10);
    expect(h.p.settling).toBe(false);
    expect(h.taken.at(-1)!.some((v) => v !== 0)).toBe(true);
    const steps = h.p.evidence.sim_steps;
    h.time(10);
    h.p.step(h.g);
    expect(h.p.evidence.sim_steps).toBe(steps);
    expect(h.pending.size).toBe(0);
  });

  it("re-warms on reconfiguration and clears an emitter stopped by the host", () => {
    const h = setup();
    h.p.step(h.g);
    const first = h.taken[0];
    h.change({ seed: 100 });
    h.p.step(h.g);
    expect(h.taken).toHaveLength(2);
    expect(h.taken[1]).not.toEqual(first);
    h.change({ emitting: false });
    h.p.step(h.g);
    expect(h.taken[2].every((v) => v === 0)).toBe(true);
    h.change({ emitting: true });
    h.p.step(h.g);
    expect(h.taken[3]).toEqual(h.taken[1]);
  });

  it("does not renew the first-sight expiry window when static mode turns on", () => {
    const h = setup(true, 0, false, false);
    h.p.step(h.g);
    h.time(3);
    h.p.setStaticParticles(true);
    h.p.step(h.g);
    expect(h.taken.at(-1)!.every((v) => v === 0)).toBe(true);
    expect(h.p.settling).toBe(false);
  });

  // Recorded gate8-pt inputs and FNV-1a of each upload from the pre-option implementation.
  // The recording digest and source commit pin the golden's provenance independently of this class.
  // Changes overlay the initial emitter (including its float fields), never the preceding step.
  // drawCalls retains the per-step executor observations; this unit test covers the upload boundary.
  it.each([
    undefined,
    false,
  ])("matches recorded PM6b instance bytes from the base (staticParticles=%s)", (on) => {
    const p = new GswParticles(undefined, undefined, on);
    let uploadCount = 0;
    for (const frame of baseGolden.frames) {
      const uploads: number[][] = [];
      const message =
        frame === baseGolden.frames[0]
          ? baseGolden.initial
          : {
              ids: baseGolden.initial.ids,
              materials: [],
              emitters: frame.changes.map((change) => {
                const initial = baseGolden.initial.emitters.find(
                  (e) => e.id === change.id,
                )!;
                return {
                  ...initial,
                  ...change,
                  f: { ...initial.f, ...change.f },
                };
              }),
            };
      p.step({
        particles_sync: () => JSON.stringify(message),
        shader_time: () => frame.time,
        particles_set: (id, data) => {
          let hash = 0x811c9dc5;
          const bytes = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
          for (const byte of bytes)
            hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
          uploads.push([id, data.length, hash]);
        },
      });
      expect(uploads).toEqual(frame.uploads);
      uploadCount += uploads.length;
    }
    expect(baseGolden.base).toBe("b456d2b366174bcda053cf5f29e770bbfdafdd9a");
    expect(baseGolden.frames).toHaveLength(120);
    expect(uploadCount).toBe(1063);
    p.dispose();
  });
});
