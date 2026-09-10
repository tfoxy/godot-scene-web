import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebgpuForTest,
  acquireWebgpuDevice,
  configureCanvas,
  onWebgpuDeviceLost,
  peekWebgpuDevice,
  webgpuContext,
  webgpuFallbackReason,
} from "../src/webgpu/device";
import {
  installWebgpuStub,
  type WebgpuStubHandle,
} from "./support/webgpu-stub";

let stub: WebgpuStubHandle | null = null;

// The device-lost notification rides a promise chain, so a macrotask turn is what makes it
// observable — the same wait a runtime's next frame would give it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __resetWebgpuForTest();
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  __resetWebgpuForTest();
  delete (globalThis as Record<string, unknown>).__gswForceWebgpuEffects;
  vi.useRealTimers();
});

describe("acquireWebgpuDevice: the no-WebGPU platform", () => {
  it("declines with no-navigator-gpu when nothing installed navigator.gpu (plain jsdom)", async () => {
    expect(await acquireWebgpuDevice()).toBeNull();
    expect(webgpuFallbackReason()).toBe("no-navigator-gpu");
    // Settled-and-unavailable, so a factory can sync-adopt WebGL without awaiting anything.
    expect(peekWebgpuDevice()).toBeNull();
  });
});

describe("acquireWebgpuDevice: memoization and the sync peek", () => {
  it("probes the adapter ONCE however many callers ask (N bindings, one acquire)", async () => {
    stub = installWebgpuStub();
    const [first, second, third] = await Promise.all([
      acquireWebgpuDevice(),
      acquireWebgpuDevice(),
      acquireWebgpuDevice(),
    ]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(stub.requestAdapterCalls).toBe(1);
    expect(stub.requestDeviceCalls).toBe(1);
    // A later caller after settlement still gets the same object without re-probing.
    expect(await acquireWebgpuDevice()).toBe(first);
    expect(stub.requestAdapterCalls).toBe(1);
  });

  it("peeks undefined before AND during acquisition, then the shared device", async () => {
    stub = installWebgpuStub();
    expect(peekWebgpuDevice()).toBeUndefined();
    const pending = acquireWebgpuDevice();
    expect(peekWebgpuDevice()).toBeUndefined();
    const shared = await pending;
    expect(peekWebgpuDevice()).toBe(shared);
    expect(webgpuFallbackReason()).toBeNull();
  });

  it("carries the device, the preferred format, the limits and zeroed counters", async () => {
    stub = installWebgpuStub({
      format: "rgba8unorm",
      limits: { minUniformBufferOffsetAlignment: 64 },
    });
    const shared = await acquireWebgpuDevice();
    expect(shared?.device).toBe(stub.device);
    expect(shared?.format).toBe("rgba8unorm");
    expect(shared?.limits.minUniformBufferOffsetAlignment).toBe(64);
    expect(shared?.counters).toEqual({ gpuErrors: 0, deviceLosses: 0 });
  });
});

describe("acquireWebgpuDevice: failure classification", () => {
  it("classifies a null adapter as no-adapter", async () => {
    stub = installWebgpuStub({ adapter: "null" });
    expect(await acquireWebgpuDevice()).toBeNull();
    expect(webgpuFallbackReason()).toBe("no-adapter");
    expect(peekWebgpuDevice()).toBeNull();
  });

  it("classifies a REJECTED requestAdapter as no-adapter (never throws out)", async () => {
    stub = installWebgpuStub({ adapter: "throw" });
    expect(await acquireWebgpuDevice()).toBeNull();
    expect(webgpuFallbackReason()).toBe("no-adapter");
  });

  it("classifies a rejected requestDevice as device-lost (a device we never got)", async () => {
    stub = installWebgpuStub({ device: "throw" });
    expect(await acquireWebgpuDevice()).toBeNull();
    expect(webgpuFallbackReason()).toBe("device-lost");
  });

  it("declines a fallback (software) adapter — the WebGL path is the better renderer AND the parity reference", async () => {
    stub = installWebgpuStub({ adapter: "fallback" });
    expect(await acquireWebgpuDevice()).toBeNull();
    expect(webgpuFallbackReason()).toBe("fallback-adapter");
    // The device was never requested: the decline happens before it costs anything.
    expect(stub.requestDeviceCalls).toBe(0);
  });

  it("honours __gswForceWebgpuEffects on a fallback adapter (the CI/headless escape hatch)", async () => {
    (globalThis as Record<string, unknown>).__gswForceWebgpuEffects = true;
    stub = installWebgpuStub({ adapter: "fallback" });
    const shared = await acquireWebgpuDevice();
    expect(shared).not.toBeNull();
    expect(webgpuFallbackReason()).toBeNull();
    expect(stub.requestDeviceCalls).toBe(1);
  });

  it("times out an adapter request that never settles", async () => {
    vi.useFakeTimers();
    stub = installWebgpuStub({ adapter: "hang" });
    const pending = acquireWebgpuDevice();
    // Still pending just under the deadline; a runtime would keep its surfaces on hold.
    await vi.advanceTimersByTimeAsync(7999);
    expect(peekWebgpuDevice()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(webgpuFallbackReason()).toBe("acquire-timeout");
    expect(peekWebgpuDevice()).toBeNull();
  });

  it("times out a device request that never settles", async () => {
    vi.useFakeTimers();
    stub = installWebgpuStub({ device: "hang" });
    const pending = acquireWebgpuDevice();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    expect(webgpuFallbackReason()).toBe("acquire-timeout");
  });

  it("latches only the FIRST reason", async () => {
    stub = installWebgpuStub({ adapter: "null", contextRefused: true });
    await acquireWebgpuDevice();
    expect(webgpuFallbackReason()).toBe("no-adapter");
    // A later context refusal must not rewrite the story of why WebGPU was declined.
    expect(webgpuContext(document.createElement("canvas"))).toBeNull();
    expect(webgpuFallbackReason()).toBe("no-adapter");
  });
});

describe("device loss", () => {
  it("counts the loss, latches device-lost and POISONS the memo (no re-probe)", async () => {
    stub = installWebgpuStub();
    const shared = await acquireWebgpuDevice();
    expect(shared).not.toBeNull();
    stub.loseDevice();
    await flush();

    expect(shared?.counters.deviceLosses).toBe(1);
    expect(webgpuFallbackReason()).toBe("device-lost");
    expect(peekWebgpuDevice()).toBeNull();
    expect(await acquireWebgpuDevice()).toBeNull();
    // The whole point of poisoning: a dead device is not re-requested per binding.
    expect(stub.requestAdapterCalls).toBe(1);
    expect(stub.requestDeviceCalls).toBe(1);
  });

  it("notifies subscribers once, and an unsubscribed one not at all", async () => {
    stub = installWebgpuStub();
    await acquireWebgpuDevice();
    const seen: string[] = [];
    onWebgpuDeviceLost(() => seen.push("kept"));
    const off = onWebgpuDeviceLost(() => seen.push("dropped"));
    off();
    stub.loseDevice();
    await flush();
    expect(seen).toEqual(["kept"]);
  });

  it("counts uncaptured errors on the shared counters", async () => {
    stub = installWebgpuStub();
    const shared = await acquireWebgpuDevice();
    stub.emitUncapturedError();
    stub.emitUncapturedError();
    expect(shared?.counters.gpuErrors).toBe(2);
    // An uncaptured error is a wrong frame, not a dead device: nothing is poisoned.
    expect(peekWebgpuDevice()).toBe(shared);
  });
});

describe("canvas configuration", () => {
  it("configures premultiplied presentation from the shared device + format", async () => {
    stub = installWebgpuStub({ format: "rgba8unorm" });
    const shared = await acquireWebgpuDevice();
    if (!shared) throw new Error("expected a device");
    const context = configureCanvas(document.createElement("canvas"), shared);
    expect(context).not.toBeNull();
    expect(stub.contexts).toHaveLength(1);
    expect(stub.contexts[0].configured).toMatchObject({
      device: shared.device,
      format: "rgba8unorm",
      // "opaque" would flatten the effect onto black; this is the only mode that composites.
      alphaMode: "premultiplied",
    });
  });

  it("returns null and latches context-refused when the canvas refuses a webgpu context", async () => {
    stub = installWebgpuStub({ contextRefused: true });
    const shared = await acquireWebgpuDevice();
    if (!shared) throw new Error("expected a device");
    expect(
      configureCanvas(document.createElement("canvas"), shared),
    ).toBeNull();
    expect(webgpuFallbackReason()).toBe("context-refused");
  });
});
