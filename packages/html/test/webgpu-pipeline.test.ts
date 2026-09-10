import {
  __resetPipelineErrorForTest,
  compileModule,
  createPipeline,
  createUniformRing,
  lastPipelineError,
  uniformBindGroupLayout,
} from "@godot-scene-web/canvas-effects/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebgpuForTest,
  acquireWebgpuDevice,
  type WebgpuShared,
} from "../src/webgpu/device";
import {
  installWebgpuStub,
  type StubCall,
  type WebgpuStubHandle,
} from "./support/webgpu-stub";

let stub: WebgpuStubHandle | null = null;

async function withDevice(
  options?: Parameters<typeof installWebgpuStub>[0],
): Promise<WebgpuShared> {
  stub = installWebgpuStub(options);
  const shared = await acquireWebgpuDevice();
  if (!shared) throw new Error("expected the stub device");
  return shared;
}

const find = (calls: StubCall[], name: string): StubCall | undefined =>
  calls.find((call) => call.name === name);

beforeEach(() => {
  __resetWebgpuForTest();
  __resetPipelineErrorForTest();
  // The compile/validation failure paths warn once, like `compileProgram` does on the GL side.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  __resetWebgpuForTest();
  __resetPipelineErrorForTest();
  vi.restoreAllMocks();
});

describe("createUniformRing: slot pitch", () => {
  it("uses a 256-byte pitch on a device whose alignment is the conformant 256", async () => {
    const shared = await withDevice();
    const ring = createUniformRing(shared.device, 4, 4);
    expect(ring.pitch).toBe(256);
    expect(ring.stride).toBe(64);
    expect(ring.slotBytes).toBe(16);
    expect(ring.staging).toHaveLength(64 * 4);
    expect(find(stub?.calls ?? [], "createBuffer")?.args[1]).toBe(256 * 4);
  });

  it("honours a LARGER minUniformBufferOffsetAlignment (rounded up to a 256 multiple)", async () => {
    const shared = await withDevice({
      limits: { minUniformBufferOffsetAlignment: 512 },
    });
    expect(createUniformRing(shared.device, 3, 4).pitch).toBe(512);
  });

  it("never goes BELOW 256 even when the device reports a smaller alignment", async () => {
    const shared = await withDevice({
      limits: { minUniformBufferOffsetAlignment: 64 },
    });
    expect(createUniformRing(shared.device, 3, 4).pitch).toBe(256);
  });

  it("widens the pitch when the SLOT itself is bigger than the alignment", async () => {
    const shared = await withDevice();
    // 80 floats = 320 bytes: a slot must fit inside its own cell, so the pitch grows to 512.
    const ring = createUniformRing(shared.device, 2, 80);
    expect(ring.slotBytes).toBe(320);
    expect(ring.pitch).toBe(512);
  });

  it("defaults a slot to the full 256-byte cell when no size is given", async () => {
    const shared = await withDevice();
    const ring = createUniformRing(shared.device, 2);
    expect(ring.slotBytes).toBe(256);
    expect(ring.pitch).toBe(256);
  });
});

describe("createUniformRing: the bind group binds a SLOT, not the buffer", () => {
  it("sizes the bind-group entry at the slot (binding the buffer would make every cell read cell 0)", async () => {
    const shared = await withDevice();
    const ring = createUniformRing(shared.device, 8, 4);
    const entries = find(stub?.calls ?? [], "createBindGroup")
      ?.args[1] as Array<{
      binding: number;
      resource: { offset: number; size: number };
    }>;
    expect(entries[0].binding).toBe(0);
    expect(entries[0].resource.offset).toBe(0);
    expect(entries[0].resource.size).toBe(ring.slotBytes);
    expect(entries[0].resource.size).not.toBe(ring.pitch * 8);
  });

  it("declares hasDynamicOffset with a minBindingSize matching the slot", async () => {
    const shared = await withDevice();
    const ring = createUniformRing(shared.device, 8, 4);
    const entries = find(stub?.calls ?? [], "createBindGroupLayout")
      ?.args[1] as Array<{
      visibility: number;
      buffer: { hasDynamicOffset: boolean; minBindingSize: number };
    }>;
    expect(entries[0].buffer.hasDynamicOffset).toBe(true);
    expect(entries[0].buffer.minBindingSize).toBe(ring.slotBytes);
    // Default visibility is VERTEX | FRAGMENT (0x1 | 0x2) — geometry and colour read one slot.
    expect(entries[0].visibility).toBe(0x3);
  });

  it("reuses a caller-supplied layout instead of making a second one", async () => {
    const shared = await withDevice();
    const layout = uniformBindGroupLayout(shared.device, 0x1, 16, "mine");
    const before = (stub?.calls ?? []).filter(
      (call) => call.name === "createBindGroupLayout",
    ).length;
    const ring = createUniformRing(shared.device, 2, 4, { layout });
    expect(ring.layout).toBe(layout);
    expect(
      (stub?.calls ?? []).filter(
        (call) => call.name === "createBindGroupLayout",
      ),
    ).toHaveLength(before);
  });
});

describe("compileModule", () => {
  it("returns the module when compilation reports nothing", async () => {
    const shared = await withDevice();
    const module = await compileModule(
      shared.device,
      "@fragment fn f() {}",
      "particle",
    );
    expect(module).not.toBeNull();
    expect(lastPipelineError()).toBeNull();
  });

  it("tolerates warning/info messages (only error severity is fatal)", async () => {
    const shared = await withDevice();
    stub?.setCompilationMessages([
      { type: "warning", message: "unused binding", lineNum: 2, linePos: 1 },
      { type: "info", message: "note", lineNum: 0, linePos: 0 },
    ]);
    expect(
      await compileModule(shared.device, "src", "particle"),
    ).not.toBeNull();
  });

  it("returns null, keeps the first error with line/col, and reports it through its callback", async () => {
    const shared = await withDevice();
    const onError = vi.fn();
    stub?.setCompilationMessages([
      {
        type: "error",
        message: "unresolved value 'foo'",
        lineNum: 12,
        linePos: 7,
      },
      { type: "error", message: "second", lineNum: 20, linePos: 1 },
    ]);
    expect(
      await compileModule(shared.device, "src", "particle", onError),
    ).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    const reported = lastPipelineError() ?? "";
    expect(reported).toContain("unresolved value 'foo'");
    expect(reported).toContain("line 12");
    expect(reported).toContain("col 7");
    expect(reported).toContain("2 error(s)");
    expect(reported).toContain("particle");
  });
});

describe("createPipeline", () => {
  const descriptor = () =>
    ({
      label: "particle",
      layout: "auto",
      vertex: { module: {}, entryPoint: "vs_main" },
    }) as unknown as GPURenderPipelineDescriptor;

  it("wraps creation in a validation error scope and returns the pipeline when it is clean", async () => {
    const shared = await withDevice();
    const pipeline = await createPipeline(
      shared.device,
      descriptor(),
      "particle",
    );
    expect(pipeline).not.toBeNull();
    const names = (stub?.calls ?? []).map((call) => call.name);
    expect(names.indexOf("pushErrorScope")).toBeLessThan(
      names.indexOf("createRenderPipeline"),
    );
    expect(names.indexOf("createRenderPipeline")).toBeLessThan(
      names.indexOf("popErrorScope"),
    );
    expect(find(stub?.calls ?? [], "pushErrorScope")?.args[0]).toBe(
      "validation",
    );
  });

  it("returns null and reports through its callback when the scope reports a validation error", async () => {
    const shared = await withDevice();
    const onError = vi.fn();
    stub?.setPipelineError("blend state mismatch");
    expect(
      await createPipeline(shared.device, descriptor(), "particle", onError),
    ).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(lastPipelineError()).toContain("blend state mismatch");
  });
});
