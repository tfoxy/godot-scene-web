import { describe, expect, it, vi } from "vitest";
import { type GswRs, type GswRsModule, STAT_FIELDS } from "../src/abi";
import { WasmStreamCore } from "../src/core";
import type { RenderStreamProtocol } from "../src/endpoint";
import { coreStartOptions } from "../src/hello";

function harness() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instances: FakeGswRs[] = [];
  let throws = false;
  class FakeGswRs {
    readonly options: { live_protocol: number };
    readonly ptr: number;
    readonly free = vi.fn();
    readonly live_reset = vi.fn();
    readonly set_log_removed = vi.fn();
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
      instances.push(this);
    }
    rx() {
      return 0;
    }
    rx_ptr() {
      return 0;
    }
    live_accept() {
      return 0;
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
    instances,
    build,
    coding,
    failBuild: (on: boolean) => {
      throws = on;
    },
  };
}

const bytes = new Uint8Array([1, 2, 3]).buffer;

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
