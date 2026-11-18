import { describe, expect, it, vi } from "vitest";
import libRs from "../../../experiments/render-stream/web/gsw-rs/src/lib.rs?raw";
import {
  ACCEPT_RESOURCE_HINT,
  ACCEPT_RESOURCE_UNHINT,
  type GswRs,
  type GswRsModule,
  MOTION_FIELDS,
  STAT_FIELDS,
} from "../src/abi";
import { WasmStreamCore } from "../src/core";
import type { RenderStreamProtocol } from "../src/endpoint";
import { coreStartOptions } from "../src/hello";

/** `motion`: the fake core has the motion measure (a core built before it has not); `animation`:
 * its facts block holds the animation measures too (`motion_len`). */
function harness(motion = true, animation = false) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instances: FakeGswRs[] = [];
  let throws = false;
  class FakeGswRs {
    readonly options: { live_protocol: number };
    readonly ptr: number;
    readonly free = vi.fn();
    readonly live_reset = vi.fn();
    readonly set_log_removed = vi.fn();
    set_motion?: ReturnType<typeof vi.fn>;
    motion_ptr?: () => number;
    motion_len?: () => number;
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
  const core = new WasmStreamCore(mod, memory, build, 12, "zstd", 16777216);
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
    expect(core.applyStats()).toEqual({
      structural: true,
      why: 1 << 14,
      backBufferItems: 3,
    });
    // STAT_FIELDS is lib.rs `Stats`, field for field (`#[repr(C)]`, all u32).
    const block = /pub struct Stats \{([^}]*)\}/.exec(libRs)?.[1] ?? "";
    const fields = [...block.matchAll(/^\s*pub (\w+): u32,$/gm)].map(
      (m) => m[1],
    );
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
