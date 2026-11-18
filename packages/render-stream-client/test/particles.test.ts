// A process material keyed from shader code the client has not got is `suspended`: its emitters
// drop their simulation (never drawn from the old output) and start a fresh one when the code
// arrives; other emitters are untouched.

import { describe, expect, it } from "vitest";
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
