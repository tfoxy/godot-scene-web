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
    expect(core.queryItem(7)).toEqual([]);
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
