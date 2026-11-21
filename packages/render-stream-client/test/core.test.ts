import { describe, expect, it, vi } from "vitest";
import libRs from "../../../experiments/render-stream/web/gsw-rs/src/lib.rs?raw";
import {
  ACCEPT_NEEDS_PAYLOADS,
  ACCEPT_RESOURCE_HINT,
  ACCEPT_RESOURCE_UNHINT,
  type GswRs,
  type GswRsModule,
  MOTION_FIELDS,
  STAT_FIELDS,
  statsReader,
} from "../src/abi";
import { WasmStreamCore } from "../src/core";
import type { RenderStreamProtocol } from "../src/endpoint";
import { coreStartOptions } from "../src/hello";
import type { ParticleBurstPacing } from "../src/particles";
import { flush, harness as loopHarness, msg, session, tx } from "./fakes";
import { programHost } from "./program-host";

/** `motion`: the fake core has the motion measure (a core built before it has not); `animation`:
 * its facts block holds the animation measures too (`motion_len`). */
function harness(
  motion = true,
  animation = false,
  pacing?: ParticleBurstPacing,
) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instances: FakeGswRs[] = [];
  let throws = false;
  class FakeGswRs {
    readonly options: { live_protocol: number };
    readonly ptr: number;
    readonly free = vi.fn();
    readonly live_reset = vi.fn();
    readonly set_log_removed = vi.fn();
    readonly set_async_programs = vi.fn();
    readonly set_damage_redraw = vi.fn();
    /** What `poll_programs` answers next (J1). */
    settled = 0;
    readonly poll_programs = vi.fn(() => this.settled);
    set_motion?: ReturnType<typeof vi.fn>;
    motion_ptr?: () => number;
    motion_len?: () => number;
    stats_len?: () => number = () => 4 * STAT_FIELDS.length;
    readonly live_session = vi.fn((_len: number, protocol: number) =>
      protocol === this.options.live_protocol ? 0 : -1,
    );
    constructor(_canvas: HTMLCanvasElement, options: string) {
      if (throws) throw new Error("build failed");
      this.options = JSON.parse(options);
      this.ptr = 256 + instances.length * 256;
      const stats = new Uint32Array(
        memory.buffer,
        this.ptr,
        STAT_FIELDS.length,
      );
      stats[STAT_FIELDS.indexOf("seq")] = instances.length + 1;
      if (motion) {
        this.set_motion = vi.fn();
        this.motion_ptr = () => this.ptr + 128;
        if (animation) this.motion_len = () => 4 * MOTION_FIELDS.length;
      }
      instances.push(this);
    }
    rx() {
      return 0;
    }
    rx_ptr() {
      return 0;
    }
    /** What `live_accept` answers, and the hint calls' answers. */
    code = 0;
    meta = "";
    state = 0;
    refs = "";
    live_accept() {
      return this.code;
    }
    hint_json() {
      return this.meta;
    }
    readonly hint_state = vi.fn((_hash: string) => this.state);
    hint_refs() {
      return this.refs;
    }
    stats_ptr() {
      return this.ptr;
    }
    session_meta() {
      return JSON.stringify({
        protocol: `render-stream/${this.options.live_protocol}`,
      });
    }
    error() {
      return "session: wrong protocol";
    }
  }
  const coding: { free: ReturnType<typeof vi.fn> }[] = [];
  class FakeCoding {
    readonly free = vi.fn();
    constructor() {
      coding.push(this);
    }
    decode_rx(_g: GswRs, len: number) {
      return len;
    }
  }
  const mod = {
    GswRs: FakeGswRs,
    LiveCoding: FakeCoding,
  } as unknown as GswRsModule;
  const canvas = document.createElement("canvas");
  const build = vi.fn(
    (p: RenderStreamProtocol) => new mod.GswRs(canvas, coreStartOptions(p)),
  );
  const core = new WasmStreamCore(
    mod,
    memory,
    build,
    12,
    "zstd",
    16777216,
    pacing,
  );
  return {
    core,
    memory,
    instances,
    build,
    coding,
    failBuild: (on: boolean) => {
      throws = on;
    },
  };
}

const bytes = new Uint8Array([1, 2, 3]).buffer;

describe("WasmStreamCore program links (J1)", () => {
  it("turns the background link on for every instance it builds", () => {
    const { core, instances } = harness();
    expect(instances[0].set_async_programs).toHaveBeenCalledWith(true);
    core.beginConnection(14);
    expect(instances[1].set_async_programs).toHaveBeenCalledWith(true);
    expect(libRs).toContain("pub fn set_async_programs(");
    expect(libRs).toContain("pub fn poll_programs(");
  });

  it("answers whether a link settled (ready or failed)", () => {
    const { core, instances } = harness();
    expect(core.pollPrograms()).toBe(false);
    instances[0].settled = 2;
    expect(core.pollPrograms()).toBe(true);
    instances[0].settled = 1 << 16;
    expect(core.pollPrograms()).toBe(true);
    instances[0].settled = 0;
    expect(core.pollPrograms()).toBe(false);
    expect(instances[0].poll_programs).toHaveBeenCalledTimes(4);
  });

  it("exposes program counters through stats and resets them with a new wasm instance", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const { core, instances } = harness();
    const h = loopHarness();
    Object.assign(h.core, { programCounts: () => core.programCounts() });
    const attach = (count: number) => {
      const host = programHost(count);
      Object.assign(instances.at(-1) as object, host, {
        particles_sync: () => "",
        particles_buffers: () => "",
        shader_time: () => Number.NaN,
        revisit: () => 0,
      });
      return host;
    };
    try {
      const host = attach(2);
      core.revisit(1);
      const snapshot = h.loop.stats().programs;
      expect(snapshot).toEqual({
        defined: 2,
        refused: 0,
        library_reads: 0,
        identical_glsl: 1,
      });
      core.beginConnection();
      expect(h.loop.stats().programs).toEqual(snapshot);
      // The same code hashes can be defined again after reset; they are not new identities.
      core.reset(true);
      host.states.fill("pending");
      core.revisit(2);
      expect(h.loop.stats().programs).toMatchObject({
        defined: 4,
        identical_glsl: 1,
      });
      expect(snapshot?.defined).toBe(2);
      core.beginConnection(14);
      attach(1);
      core.revisit(3);
      expect(h.loop.stats().programs).toEqual({
        defined: 1,
        refused: 0,
        library_reads: 0,
        identical_glsl: 0,
      });
    } finally {
      h.loop.dispose();
      core.dispose();
      clock.mockRestore();
    }
  });

  it("progresses held shaders without a transaction and clears them on reset", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { core, instances } = harness();
      const host = programHost(14);
      const g = instances[0];
      Object.assign(g, host, {
        particles_sync: () => "",
        particles_buffers: () => "",
        shader_time: () => Number.NaN,
        revisit: () => 0,
      });
      core.revisit(1);
      expect(host.states.filter((s) => s === "held")).toHaveLength(11);
      for (let i = 0; i < 5; i++) core.pollPrograms();
      expect(host.states.every((s) => s === "ready")).toBe(true);
      // A second burst starts, then reset drops every held shader.
      host.states.fill("pending");
      core.revisit(2);
      expect(host.states.filter((s) => s === "held")).toHaveLength(11);
      core.reset(true);
      expect(core.pollPrograms()).toBe(false);
      expect(host.states.every((s) => s === "reset")).toBe(true);
      expect(libRs).toContain("pub fn hold_program(");
      expect(libRs.match(/self\.held\.clear\(\);/g)).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "transpiler refusal",
    "compile failure",
    "withheld code",
    "definition",
  ])("notifies the idle loop after held shader progress (%s)", (result) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const h = loopHarness(2, { creditStage: "submitted", applyOn: "frame" });
    try {
      const { core, instances } = harness();
      const host = programHost(4);
      Object.assign(instances[0], host, {
        pending_code: () =>
          result === "withheld code"
            ? undefined
            : result === "transpiler refusal"
              ? "shader_type canvas_item; uniform uint bits; void fragment() {}"
              : host.pending_code(),
        pending_withheld: () => result === "withheld code",
        define_program: (i: number) => {
          if (result === "compile failure") {
            host.refuse_program(i);
            return 1;
          }
          return host.define_program(i);
        },
        // Isolate synchronous held progress: no GL link reports a settle.
        poll_programs: () => 0,
        particles_sync: () => "",
        particles_buffers: () => "",
        shader_time: () => Number.NaN,
        revisit: () => 1,
      });
      h.core.prepareApply = () => core.prepareApply(1);
      h.core.pollPrograms = () => core.pollPrograms();
      h.core.revisit = (seq) => {
        h.core.calls.push(`revisit ${seq}`);
        return core.revisit(seq);
      };
      h.loop.connect();
      const t = h.last();
      t.on.open();
      t.on.message(session(2));
      t.on.message(tx(1));
      h.clock.frame();
      expect(host.states[3]).toBe("held");
      const acks = t.acks().length;
      h.core.calls.length = 0;
      h.clock.frame();
      expect(host.states[3]).toBe(
        result === "definition" ? "linking" : "refused",
      );
      expect([...h.core.calls]).toEqual(["revisit 1", "draw 1"]);
      expect(t.acks()).toHaveLength(acks);
      h.core.calls.length = 0;
      h.clock.frame();
      expect(h.core.calls).toEqual([]);
    } finally {
      h.loop.dispose();
      clock.mockRestore();
    }
  });

  it.each([
    false,
    true,
  ])("waits for shader payloads before held progress (links settle: %s)", async (settleLinks) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const h = loopHarness(2, {
      creditStage: "submitted",
      applyOn: "frame",
      resourceHoldMs: 1000,
    });
    try {
      const { core, instances, memory } = harness();
      const g = instances[0];
      const host = programHost(5);
      host.states[4] = "later";
      const hash = "aa".repeat(32);
      let provided = false;
      let prepared = false;
      let acceptedSeq = 0;
      const define = vi.fn(host.define_program);
      const refuse = vi.fn(host.refuse_program);
      const poll = vi.fn(() => (settleLinks ? host.poll_programs() : 0));
      const revisit = vi.fn(() => (prepared ? 0 : 1));
      Object.assign(g, host, {
        pending_code: (i: number) =>
          host.pending_shader_id(i) === 4n && !provided
            ? undefined
            : host.pending_code(),
        define_program: define,
        refuse_program: refuse,
        poll_programs: poll,
        particles_sync: () => "",
        particles_buffers: () => "",
        shader_time: () => Number.NaN,
        revisit,
        apply: () => {
          prepared = false;
          return 0;
        },
        needed_count: () => 1,
        needed_ptr: () => 1024,
        needed_kinds_ptr: () => 1056,
      });
      new Uint8Array(memory.buffer, 1024, 32).fill(0xaa);
      new Uint8Array(memory.buffer, 1056, 1)[0] = 3;
      const receive = h.core.receive.bind(h.core);
      h.core.receive = (data, seen, copy) => {
        const m = receive(data, seen, copy);
        if (m.kind === "transaction") {
          prepared = true;
          acceptedSeq = m.seq;
          if (m.seq === 2) host.states[4] = "pending";
          g.code = m.needed.length === 0 ? 0 : ACCEPT_NEEDS_PAYLOADS;
          const stats = new Uint32Array(
            memory.buffer,
            g.ptr,
            STAT_FIELDS.length,
          );
          stats[STAT_FIELDS.indexOf("seq")] = m.seq;
          stats[STAT_FIELDS.indexOf("frame")] = m.frame;
          stats[STAT_FIELDS.indexOf("encoding")] = m.full ? 0 : 1;
          expect(core.receive(data, true)).toEqual(m);
        }
        return m;
      };
      h.core.prepareApply = () => core.prepareApply(acceptedSeq);
      const apply = h.core.apply.bind(h.core);
      h.core.apply = (seq) => {
        core.apply(seq);
        apply(seq);
      };
      h.core.pollPrograms = () => core.pollPrograms();
      h.core.revisit = (seq) => core.revisit(seq);
      const provide = h.core.provideStaged.bind(h.core);
      h.core.provideStaged = () => {
        provided = true;
        return provide();
      };
      h.loop.connect();
      const t = h.last();
      t.on.open();
      t.on.message(session(2));
      t.on.message(tx(1));
      h.clock.frame();
      expect(host.states.slice(3)).toEqual(["held", "later"]);
      expect(define).toHaveBeenCalledTimes(3);
      t.on.message(
        msg({
          kind: "transaction",
          seq: 2,
          frame: 2,
          full: false,
          needed: [{ hash, kind: 3 }],
        }),
      );
      h.core.calls.length = 0;
      poll.mockClear();
      // The hold has not expired: neither the old held shader nor the new one may compile.
      for (let i = 0; i < 3; i++) h.clock.frame();
      expect(h.statuses.filter((s) => s.kind === "failed")).toEqual([]);
      expect(t.closed).toBeNull();
      expect(t.gets).toHaveLength(1);
      expect(host.states.slice(3)).toEqual(["held", "pending"]);
      expect(define).toHaveBeenCalledTimes(3);
      expect(refuse).not.toHaveBeenCalled();
      expect(poll).toHaveBeenCalledTimes(3);
      expect(revisit).toHaveBeenCalledTimes(settleLinks ? 1 : 0);
      expect(h.core.calls).toEqual([]);
      t.gets[0].resolve(200);
      await flush();
      h.clock.frame();
      expect(host.states.slice(3)).toEqual(["linking", "linking"]);
      expect(define).toHaveBeenCalledTimes(5);
      expect(refuse).not.toHaveBeenCalled();
      expect(h.core.calls).toEqual([
        `stage ${hash}`,
        "provide",
        "apply 2",
        "draw 2",
      ]);
      expect(h.statuses.filter((s) => s.kind === "failed")).toEqual([]);
      expect(t.closed).toBeNull();
    } finally {
      h.loop.dispose();
      clock.mockRestore();
    }
  });

  it.each([
    "reset",
    "beginConnection",
  ] as const)("clears the accepted transaction guard on %s", (transition) => {
    const { core, instances } = harness();
    const host = programHost(1);
    Object.assign(instances[0], host, {
      particles_sync: () => "",
      particles_buffers: () => "",
      shader_time: () => Number.NaN,
      revisit: () => 0,
    });
    core.receive(bytes, true);
    core.revisit(1);
    expect(host.states).toEqual(["pending"]);
    if (transition === "reset") core.reset(true);
    else core.beginConnection();
    host.states[0] = "pending";
    core.revisit(1);
    expect(host.states).toEqual(["linking"]);
  });

  it("settles particles only while a burst is in progress", () => {
    const { core } = harness();
    // No emitter is settling: no reapply (the fake core has none either way).
    expect(core.settleParticles(1)).toBe(false);
    expect(libRs).toContain("pub fn reapply(");
  });
});

describe("WasmStreamCore damage redraw", () => {
  it("forwards toggles to wasm and retains the option after a protocol rebuild", () => {
    const { core, instances } = harness();
    core.setDamageRedraw(true);
    expect(instances[0].set_damage_redraw).toHaveBeenLastCalledWith(true);
    core.beginConnection(14);
    expect(instances[1].set_damage_redraw).toHaveBeenLastCalledWith(true);
    core.setDamageRedraw(false);
    expect(instances[1].set_damage_redraw).toHaveBeenLastCalledWith(false);
    core.dispose();
  });
});

describe("WasmStreamCore motion facts", () => {
  it("reads the facts block only while measuring, and keeps the measure across instances", () => {
    const { core, memory, instances } = harness();
    core.beginConnection(12);
    expect(core.motion()).toBeNull();
    expect(core.setMotion(true)).toBe(true);
    expect(instances[0].set_motion).toHaveBeenCalledWith(true);
    const at = instances[0].ptr + 128;
    new Uint32Array(memory.buffer, at, 2).set([41, 2]);
    new Float32Array(memory.buffer, at + 8, 2).set([0.25, 0.5]);
    expect(core.motion()).toEqual({
      seq: 41,
      changes: 2,
      maxPx: 0.25,
      colorStep: 0.5,
    });
    // A rebuilt instance (another protocol) measures from the start.
    core.beginConnection(14);
    expect(instances[1].set_motion).toHaveBeenCalledWith(true);
    expect(core.setMotion(false)).toBe(true);
    expect(instances[1].set_motion).toHaveBeenLastCalledWith(false);
    expect(core.motion()).toBeNull();
    // MOTION_FIELDS is lib.rs `MotionFacts`, field for field (`#[repr(C)]`).
    const block = /pub struct MotionFacts \{([^}]*)\}/.exec(libRs)?.[1] ?? "";
    const fields = [...block.matchAll(/^\s*pub (\w+): (u32|f32),$/gm)];
    expect(fields.map((m) => m[1])).toEqual([...MOTION_FIELDS]);
    expect(fields.map((m) => m[2])).toEqual([
      "u32",
      "u32",
      "f32",
      "f32",
      "f32",
      "f32",
    ]);
    expect(libRs).toContain("pub fn set_motion(");
    expect(libRs).toContain("pub fn motion_ptr(");
    expect(libRs).toContain("pub fn motion_len(");
    core.dispose();
  });

  it("reads the animation measures when the block holds them, and only then", () => {
    const { core, memory, instances } = harness(true, true);
    core.beginConnection(12);
    core.setMotion(true);
    const at = instances[0].ptr + 128;
    new Uint32Array(memory.buffer, at, 2).set([7, 0]);
    new Float32Array(memory.buffer, at + 8, 4).set([0.5, 0.25, 40, 0.75]);
    expect(core.motion()).toEqual({
      seq: 7,
      changes: 0,
      maxPx: 0.5,
      colorStep: 0.25,
      animPx: 40,
      animColorStep: 0.75,
    });
    core.dispose();
    // A core whose block ends after `color_step` reports no animation measures.
    const old = harness(true, false);
    old.core.beginConnection(12);
    old.core.setMotion(true);
    const o = old.instances[0].ptr + 128;
    new Float32Array(old.memory.buffer, o + 16, 2).set([40, 0.75]);
    expect(old.core.motion()?.animPx).toBeUndefined();
    old.core.dispose();
  });

  it("answers that a core built without the measure cannot measure", () => {
    const { core } = harness(false);
    core.beginConnection(12);
    expect(core.setMotion(true)).toBe(false);
    expect(core.motion()).toBeNull();
    core.dispose();
  });
});

describe("WasmStreamCore session protocol", () => {
  it("keeps the instance and its payloads on the same protocol", () => {
    const { core, instances, build, coding } = harness();
    core.beginConnection(12);
    core.beginConnection(12);
    expect(build).toHaveBeenCalledTimes(1);
    expect(instances[0].free).not.toHaveBeenCalled();
    expect(coding[0].free).toHaveBeenCalledTimes(1);
    core.dispose();
  });

  it("frees once and builds once for a different protocol, validating the new session", () => {
    const { core, instances, build, coding } = harness();
    core.beginConnection(12);
    core.setLogRemoved(true);
    core.beginConnection(14);
    expect(build.mock.calls).toEqual([[12], [14]]);
    expect(instances.map((g) => g.options.live_protocol)).toEqual([12, 14]);
    expect(instances[0].free).toHaveBeenCalledTimes(1);
    expect(coding[0].free).toHaveBeenCalledTimes(1);
    expect(instances[1].set_log_removed).toHaveBeenCalledWith(true);
    expect(core.receive(bytes, false)).toEqual({
      kind: "session",
      meta: { protocol: "render-stream/14" },
    });
    expect(instances[1].live_session).toHaveBeenCalledWith(3, 14);
    core.dispose();
    expect(instances.map((g) => g.free.mock.calls.length)).toEqual([1, 1]);
  });

  it("reads the last apply's walk facts from the stats block", () => {
    const { core, memory, instances } = harness();
    core.beginConnection(12);
    const stats = new Uint32Array(
      memory.buffer,
      instances[0].ptr,
      STAT_FIELDS.length,
    );
    stats[STAT_FIELDS.indexOf("structural")] = 1;
    stats[STAT_FIELDS.indexOf("why")] = 1 << 14;
    stats[STAT_FIELDS.indexOf("back_buffer_items")] = 3;
    stats[STAT_FIELDS.indexOf("surfaces_rendered")] = 5;
    stats[STAT_FIELDS.indexOf("surfaces_skipped")] = 6;
    stats[STAT_FIELDS.indexOf("surfaces_unchanged")] = 7;
    stats[STAT_FIELDS.indexOf("surfaces_allocated")] = 8;
    stats[STAT_FIELDS.indexOf("surface_pixels")] = 9;
    expect(core.applyStats()).toEqual({
      structural: true,
      why: 1 << 14,
      backBufferItems: 3,
      surfacesRendered: 5,
      surfacesSkipped: 6,
      surfacesUnchanged: 7,
      surfacesAllocated: 8,
      surfacePixels: 9,
    });
    // STAT_FIELDS is lib.rs `Stats`, field for field (`#[repr(C)]`, all u32).
    const block = /pub struct Stats \{([^}]*)\}/.exec(libRs)?.[1] ?? "";
    const fields = [...block.matchAll(/^\s*pub (\w+): u32,$/gm)].map(
      (m) => m[1],
    );
    expect(libRs).toContain("pub fn stats_len(");
    expect(fields).toEqual([...STAT_FIELDS]);
    expect(block.match(/^\s*pub /gm)).toHaveLength(STAT_FIELDS.length);
    core.dispose();
  });

  it("drops the old stats view and decoded bytes when rebuilding", () => {
    const { core } = harness();
    core.beginConnection(12);
    expect(core.receive(bytes, true, true)).toMatchObject({ seq: 1 });
    expect(core.takeDecoded()).toEqual(new Uint8Array(bytes));
    core.beginConnection(13);
    expect(core.takeDecoded()).toBeNull();
    expect(core.receive(bytes, true)).toMatchObject({ seq: 2 });
    core.dispose();
  });

  it("leaves a throwing build rebuildable without using or freeing the old instance again", () => {
    const { core, instances, build, coding, failBuild } = harness();
    core.beginConnection(12);
    failBuild(true);
    expect(() => core.beginConnection(13)).toThrow("build failed");
    expect(instances[0].free).toHaveBeenCalledTimes(1);
    expect(coding[0].free).toHaveBeenCalledTimes(1);
    core.reset(true);
    expect(instances[0].live_reset).not.toHaveBeenCalled();
    expect(core.queryItem(7)).toHaveLength(0);
    expect(core.itemVisible(7)).toBe(false);
    expect(core.querySubtreeRect(7)).toEqual([]);
    expect(core.queryChildren(7)).toEqual(new Uint32Array(0));
    expect(core.hitTest(1, 1)).toBeNull();
    expect(core.toGame(1, 1)).toEqual([]);
    expect(() =>
      core.setHitFilters(new Uint32Array([7]), new Uint8Array([1])),
    ).not.toThrow();
    expect(() => core.setPickOrder("tree")).not.toThrow();
    expect(() => core.receive(bytes, false)).toThrow();
    failBuild(false);
    core.beginConnection(13);
    expect(build.mock.calls).toEqual([[12], [13], [13]]);
    expect(core.receive(bytes, false)).toMatchObject({
      meta: { protocol: "render-stream/13" },
    });
    core.dispose();
    core.dispose();
    expect(instances.map((g) => g.free.mock.calls.length)).toEqual([1, 1]);
  });
});

describe("WasmStreamCore item queries (I1/I2)", () => {
  const ROW = 14;
  const rows: Record<number, number[]> = {
    5: [-1, 1, 1, 1, 0, 0, 1, 7, 8, 1, 7, 8, 2, 3],
    6: [5, 0, 1, 2, 0, 0, 2, 1, 1, 0, 0, 0, 0, 0],
  };
  const unknown = [-1, ...new Array(ROW - 1).fill(0)];

  function queryHarness() {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
    const instances: FakeQueryCore[] = [];
    class FakeQueryCore {
      readonly free = vi.fn();
      readonly set_log_removed = vi.fn();
      epoch = 0;
      itemCalls = 0;
      constructor() {
        instances.push(this);
      }
      stats_ptr() {
        return 256;
      }
      query_item(id: number) {
        this.itemCalls++;
        const r = rows[id];
        if (!r) return 0;
        new Float64Array(memory.buffer, 1024, ROW).set(r);
        return 1;
      }
      query_item_ptr() {
        return 1024;
      }
      item_visible(id: number) {
        return rows[id] ? rows[id][1] : 2;
      }
      query_ids() {
        return 2048;
      }
      query_items(n: number) {
        const ids = new Uint32Array(memory.buffer, 2048, n);
        const out = new Float64Array(memory.buffer, 4096, n * ROW);
        for (let k = 0; k < n; k++) out.set(rows[ids[k]] ?? unknown, k * ROW);
        return 4096;
      }
      items_visible(n: number) {
        const ids = new Uint32Array(memory.buffer, 2048, n);
        const out = new Uint8Array(memory.buffer, 4096, n);
        for (let k = 0; k < n; k++) out[k] = rows[ids[k]] ? rows[ids[k]][1] : 2;
        return 4096;
      }
      query_epoch() {
        return this.epoch;
      }
    }
    const mod = { GswRs: FakeQueryCore } as unknown as GswRsModule;
    const build = vi.fn(() => new FakeQueryCore() as unknown as GswRs);
    const core = new WasmStreamCore(mod, memory, build, 12, "", 0);
    return { core, memory, instances };
  }

  it("reads one item through one reused view of the scratch row, re-derived after growth", () => {
    const { core, memory } = queryHarness();
    const a = core.queryItem(5);
    expect([...a]).toEqual(rows[5]);
    const b = core.queryItem(6);
    expect(b).toBe(a); // the same view: no allocation per call
    expect([...b]).toEqual(rows[6]);
    expect(core.queryItem(99)).toHaveLength(0);
    memory.grow(1);
    expect(a.length).toBe(0); // detached by the growth
    const c = core.queryItem(5);
    expect(c === a).toBe(false);
    expect([...c]).toEqual(rows[5]);
    core.dispose();
  });

  it("answers visibility and batches without the per-item query", () => {
    const { core, instances, memory } = queryHarness();
    expect(core.itemVisible(5)).toBe(true);
    expect(core.itemVisible(6)).toBe(false);
    expect(core.itemVisible(99)).toBe(false);
    const ids = Uint32Array.from([6, 99, 5]);
    const vis = new Uint8Array(3);
    core.itemsVisible(ids, vis);
    expect([...vis]).toEqual([0, 0, 1]);
    memory.grow(1); // a batch reads fresh views every call
    const out = new Float64Array(3 * ROW);
    core.queryItems([6, 99, 5], out);
    expect([...out]).toEqual([...rows[6], ...unknown, ...rows[5]]);
    expect(instances[0].itemCalls).toBe(0);
    core.dispose();
    // No instance: unknown rows, nothing visible.
    out.fill(7);
    core.queryItems([5], out);
    expect([...out.subarray(0, ROW)]).toEqual(unknown);
    expect(core.itemVisible(5)).toBe(false);
  });

  it("moves the epoch with the instance's and past it on a new instance", () => {
    const { core, instances } = queryHarness();
    const e0 = core.queryEpoch();
    expect(core.queryEpoch()).toBe(e0);
    instances[0].epoch = 3;
    const e1 = core.queryEpoch();
    expect(e1).toBe(e0 + 3);
    core.beginConnection(13); // a new instance, its epoch 0 again
    expect(instances).toHaveLength(2);
    const e2 = core.queryEpoch();
    expect(e2).toBeGreaterThan(e1);
    instances[1].epoch = 1;
    expect(core.queryEpoch()).toBe(e2 + 1);
    core.dispose();
    expect(core.queryEpoch()).toBeGreaterThan(e2 + 1);
  });
});

describe("WasmStreamCore unavailable payloads", () => {
  it("revisit compiles arrived shader code and syncs particles (no step) before the wasm revisit", () => {
    const h = harness();
    const g = h.instances[0] as unknown as Record<string, unknown>;
    const order: string[] = [];
    let pending = 1;
    Object.assign(g, {
      pending_shaders: () => pending,
      pending_hash: () => "c0de",
      pending_shader_id: () => 7n,
      pending_withheld: () => false,
      pending_code: () => "shader_type canvas_item;\nvoid fragment() {}\n",
      define_program: () => {
        order.push("define");
        pending = 0;
        return 0;
      },
      particles_sync: () => {
        order.push("particles");
        return "";
      },
      shader_time: () => {
        order.push("step");
        return Number.NaN;
      },
      revisit: () => {
        order.push("revisit");
        return 1;
      },
    });
    expect(h.core.revisit(3)).toBe(true);
    expect(order).toEqual(["define", "particles", "revisit"]);
  });

  it("named asks the names of every hash in one call; none for an empty list", () => {
    const h = harness();
    const g = h.instances[0] as unknown as Record<string, unknown>;
    const asked: string[] = [];
    g.names_mask = (hex: string) => {
      asked.push(hex);
      return Uint8Array.from([1, 0]);
    };
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect([...h.core.named([a, b])]).toEqual([1, 0]);
    expect(h.core.named([])).toHaveLength(0);
    expect(asked).toEqual([a + b]);
  });

  it("the adapter exports every new core method", () => {
    for (const m of ["names_mask", "drop_staged", "restore_unavailable"])
      expect(libRs).toContain(`pub fn ${m}(`);
  });
});

describe("WasmStreamCore resource hints (render-stream/15)", () => {
  const h1 = "a".repeat(64);
  const h2 = "b".repeat(64);
  const vh = "c".repeat(64);
  const hintMeta = {
    type: "resource_hint",
    hash: h1,
    kind: "texture",
    format: "RGBA8",
    source_format: null,
    width: 16,
    height: 8,
    mipmaps: false,
    payload_bytes: 512,
    variants: [
      { encoding: "block", hash: vh, payload_bytes: 64, format: "BPTC_RGBA" },
    ],
    path: "res://icon.png",
    cause: "warm",
    priority: 3,
    blocks: [],
  };

  it("maps ACCEPT_RESOURCE_HINT to a hint message with the core's held/named bits", () => {
    const { core, instances } = harness();
    core.beginConnection(15);
    const g = instances[1];
    g.code = 6;
    g.meta = JSON.stringify(hintMeta);
    g.state = 2;
    expect(core.receive(bytes, true)).toEqual({
      kind: "hint",
      hint: {
        hash: h1,
        format: "RGBA8",
        sourceFormat: null,
        width: 16,
        height: 8,
        mipmaps: false,
        payloadBytes: 512,
        variants: [
          {
            encoding: "block",
            hash: vh,
            payloadBytes: 64,
            format: "BPTC_RGBA",
          },
        ],
        path: "res://icon.png",
        cause: "warm",
        priority: 3,
      },
      held: false,
      named: true,
    });
    expect(g.hint_state).toHaveBeenCalledWith(h1);
    core.dispose();
  });

  it("maps ACCEPT_RESOURCE_UNHINT to an unhint without asking the hint state", () => {
    const { core, instances } = harness();
    core.beginConnection(15);
    const g = instances[1];
    g.code = 7;
    g.meta = JSON.stringify({ type: "resource_unhint", hash: h2, blocks: [] });
    expect(core.receive(bytes, true)).toEqual({ kind: "unhint", hash: h2 });
    expect(g.hint_state).not.toHaveBeenCalled();
    core.dispose();
  });

  it("selects through the optional wasm export and tolerates an older core", () => {
    const { core, instances } = harness();
    core.beginConnection(15);
    expect(core.hintSelect).toBeUndefined();
    const g = instances[1] as (typeof instances)[number] & {
      hint_select?: (hash: string) => string;
    };
    g.hint_select = vi.fn(() =>
      JSON.stringify({ hash: vh, encoding: "block", bytes: 64 }),
    );
    expect(core.hintSelect?.(h1)).toEqual({
      hash: vh,
      encoding: "block",
      bytes: 64,
    });
    expect(g.hint_select).toHaveBeenCalledWith(h1);
    g.hint_select = () => "";
    expect(core.hintSelect?.(h2)).toBeNull();
    core.dispose();
  });

  it("splits hint_refs into hashes", () => {
    const { core, instances } = harness();
    core.beginConnection(15);
    expect(core.hintRefs()).toEqual([]);
    instances[1].refs = h1 + h2;
    expect(core.hintRefs()).toEqual([h1, h2]);
    core.dispose();
  });

  it("keeps the ACCEPT codes and live_protocol 15 in step with lib.rs", () => {
    const code = (name: string) =>
      Number(new RegExp(`pub const ${name}: i32 = (\\d+);`).exec(libRs)?.[1]);
    expect(code("ACCEPT_RESOURCE_HINT")).toBe(ACCEPT_RESOURCE_HINT);
    expect(code("ACCEPT_RESOURCE_UNHINT")).toBe(ACCEPT_RESOURCE_UNHINT);
    expect(libRs).toContain('json.contains("\\"live_protocol\\":15")');
  });
});

describe("WasmStreamCore idle particle lifecycle", () => {
  function settling() {
    const tasks = new Set<() => void>();
    let clock = 0;
    const h = harness(true, false, {
      sliceMs: 6,
      now: () => clock++,
      idle: {
        sliceMs: 8,
        schedule: (run) => {
          tasks.add(run);
          return () => tasks.delete(run);
        },
      },
    });
    const reapply = vi.fn(() => 1);
    const uploads = vi.fn();
    let first = true;
    Object.assign(h.instances[0], {
      pending_shaders: () => 0,
      shader_time: () => 1,
      particles_set: uploads,
      reapply,
      particles_sync: () => {
        if (!first) return "";
        first = false;
        return JSON.stringify({
          ids: [1],
          emitters: [
            {
              id: 1,
              version: 1,
              material: 20,
              amount: 40,
              emitting: true,
              one_shot: false,
              fixed_fps: 30,
              fractional_delta: true,
              local: true,
              draw_order: "index",
              seed: 7,
              restarts: 0,
              process_requests: 0,
              f: {
                amount_ratio: 1,
                lifetime: 2,
                pre_process_time: 2,
                explosiveness: 0,
                randomness: 0,
                speed_scale: 1,
                interp_to_end: 0,
                request_process_time: 0,
                emission_transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
                emitter_velocity: [0, 0, 0],
              },
            },
          ],
          materials: [
            {
              id: 20,
              version: 1,
              builtin: {
                emission_shape: "point",
                particle_flags: ["disable_z"],
                sub_emitter: "disabled",
                attractor: false,
                collision: "disabled",
                turbulence: false,
              },
              uniforms: {},
              curves: {},
            },
          ],
        });
      },
    });
    h.core.prepareApply(1);
    expect(tasks.size).toBe(1);
    return { ...h, tasks, reapply, uploads };
  }

  it("static warms settle once and then stop causing idle reapply or upload", () => {
    const h = settling();
    h.core.setStaticParticles(true);
    expect(h.tasks.size).toBe(0); // cancels the old live warm
    h.core.settleParticles(1);
    let chunks = 0;
    while (h.tasks.size) {
      const run = [...h.tasks][0];
      h.tasks.delete(run);
      run();
      expect(++chunks).toBeLessThan(2000);
    }
    expect(h.core.settleParticles(1)).toBe(true);
    const uploads = h.uploads.mock.calls.length;
    const applies = h.reapply.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      h.core.prepareApply(1);
      expect(h.core.settleParticles(1)).toBe(false);
    }
    expect(h.uploads).toHaveBeenCalledTimes(uploads);
    expect(h.reapply).toHaveBeenCalledTimes(applies);
    expect(h.tasks.size).toBe(0);
    h.core.dispose();
  });

  it("leaves idle uploads for reapply in the next frame, with no GL work in the task", () => {
    const h = settling();
    let chunks = 0;
    while (h.tasks.size) {
      const run = [...h.tasks][0];
      h.tasks.delete(run);
      run();
      expect(++chunks).toBeLessThan(2000);
    }
    expect(h.uploads).toHaveBeenCalledTimes(2); // zeros, then finished instances
    expect(h.reapply).not.toHaveBeenCalled();
    expect(h.core.settleParticles(1)).toBe(true);
    expect(h.reapply).toHaveBeenCalledOnce();
    expect(h.core.settleParticles(1)).toBe(false);
    h.core.dispose();
  });

  it("draws held-program progress before an idle particle upload without stepping time twice", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const h = settling();
    const loop = loopHarness(2, {
      creditStage: "submitted",
      applyOn: "frame",
    });
    try {
      loop.loop.connect();
      const t = loop.last();
      t.on.open();
      t.on.message(session(2));
      t.on.message(tx(1));
      loop.clock.frame();
      const acks = t.acks().length;
      const prepares = loop.core.prepareApplies;
      const host = programHost(14);
      const g = h.instances[0];
      Object.assign(g, host, { revisit: () => 1 });
      h.core.revisit(1);
      expect(host.states.filter((state) => state === "held")).toHaveLength(11);
      const time = vi.spyOn(g as unknown as GswRs, "shader_time");
      loop.core.pollPrograms = () => h.core.pollPrograms();
      loop.core.revisit = (seq) => h.core.revisit(seq);
      const settle = vi.fn((seq: number) => h.core.settleParticles(seq));
      loop.core.settleParticles = settle;

      let chunks = 0;
      while (h.tasks.size) {
        const run = [...h.tasks][0];
        h.tasks.delete(run);
        run();
        expect(++chunks).toBeLessThan(2000);
      }
      expect(h.uploads).toHaveBeenCalledTimes(2);
      expect(h.reapply).not.toHaveBeenCalled();
      for (let i = 0; i < 5; i++) {
        loop.core.calls.length = 0;
        loop.clock.frame();
        expect(loop.core.calls).toEqual(["draw 1"]);
        expect(settle).not.toHaveBeenCalled();
        expect(h.reapply).not.toHaveBeenCalled();
      }
      expect(host.states.every((state) => state === "ready")).toBe(true);
      // The upload remains ready across shader revisits; the next idle frame consumes it once.
      loop.core.calls.length = 0;
      loop.clock.frame();
      expect(loop.core.calls).toEqual(["draw 1"]);
      expect(h.reapply).toHaveBeenCalledOnce();
      loop.core.calls.length = 0;
      loop.clock.frame();
      expect(loop.core.calls).toEqual([]);
      expect(h.reapply).toHaveBeenCalledOnce();
      expect(time).not.toHaveBeenCalled();
      expect(loop.core.prepareApplies).toBe(prepares);
      expect(t.acks()).toHaveLength(acks);
    } finally {
      loop.loop.dispose();
      h.core.dispose();
      clock.mockRestore();
    }
  });

  it.each([
    "dispose",
    "reset",
    "session",
    "rebuild",
  ])("cancels before %s releases the simulation", (action) => {
    const h = settling();
    const late = [...h.tasks][0];
    if (action === "dispose") h.core.dispose();
    else if (action === "reset") h.core.reset(true);
    else if (action === "session") h.core.receive(bytes, false);
    else h.core.beginConnection(14);
    expect(h.tasks.size).toBe(0);
    late();
    expect(h.uploads).toHaveBeenCalledOnce();
    expect(h.reapply).not.toHaveBeenCalled();
    h.core.dispose();
  });

  it("cancels on context loss and restarts off-frame work after the restored frame", () => {
    const h = settling();
    const late = [...h.tasks][0];
    h.core.pauseParticles(true);
    expect(h.tasks.size).toBe(0);
    h.core.pauseParticles(false);
    expect(h.core.settleParticles(1)).toBe(false);
    expect(h.tasks.size).toBe(1);
    const current = [...h.tasks][0];
    late();
    expect([...h.tasks]).toEqual([current]);
    h.core.dispose();
    expect(h.tasks.size).toBe(0);
  });
});

describe("damage diagnostics", () => {
  it.each([
    undefined,
    33 * 4,
    36 * 4,
  ])("omits incomplete damage samples with a stats byte length of %s", (len) => {
    const { core, memory, instances } = harness();
    core.beginConnection(12);
    const g = instances[0];
    g.stats_len = len === undefined ? undefined : () => len;
    // An older core owns only the 33-word prefix. The adjacent allocation is nonzero.
    const st = new Uint32Array(memory.buffer, g.ptr, STAT_FIELDS.length);
    st[STAT_FIELDS.indexOf("surface_pixels")] = 1234;
    st.set([3, 123456789, 4000, 99], 33);
    expect(core.damageStats()).toBeUndefined();
    expect(core.applyStats().surfacePixels).toBe(1234);
    const read = statsReader(g as unknown as GswRs, memory);
    expect(read().surface_pixels).toBe(1234);
    expect(read()).not.toHaveProperty("damage_regions");
    if (len === undefined || len === 33 * 4)
      expect(read()).not.toHaveProperty("damage_mode");
    memory.grow(1);
    expect(core.damageStats()).toBeUndefined();
    expect(read()).not.toHaveProperty("damage_regions");
  });

  it("reads the successful draw's fields without allocating another result", () => {
    const { core, memory, instances } = harness();
    core.beginConnection(12);
    const write = (us: number) => {
      const st = new Uint32Array(
        memory.buffer,
        instances[0].ptr,
        STAT_FIELDS.length,
      );
      st[STAT_FIELDS.indexOf("damage_mode")] = 2;
      st[STAT_FIELDS.indexOf("damage_us")] = us;
      st[STAT_FIELDS.indexOf("damage_permille")] = 256;
      st[STAT_FIELDS.indexOf("damage_regions")] = 8;
    };
    write(120);
    const first = core.damageStats();
    expect(first).toEqual({ mode: 2, us: 120, permille: 256, regions: 8 });
    memory.grow(1);
    write(80);
    expect(core.damageStats()).toBe(first);
    expect(first?.us).toBe(80);
  });
});
