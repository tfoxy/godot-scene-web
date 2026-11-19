// A process material keyed from shader code the client has not got is `suspended`: its emitters
// drop their simulation (never drawn from the old output) and start a fresh one when the code
// arrives; other emitters are untouched.

import { describe, expect, it, vi } from "vitest";
import { GswParticles, type ParticlesHost } from "../src/particles";

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
