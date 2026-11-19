import { afterEach, expect, it, vi } from "vitest";
import { programHost } from "./program-host";

// Each test gets a fresh page-level warm-up state.
async function programs() {
  vi.resetModules();
  const shaders = await import("@godot-scene-web/effects/shaders");
  const transpile = vi.spyOn(shaders, "transpileGodotItemShader");
  return { ...(await import("../src/programs")), transpile };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("warms once at idle, without a host, and ignores repeated idle callbacks", async () => {
  let idle: (() => void) | undefined;
  const requestIdle = vi.fn((cb: () => void) => {
    idle = cb;
    return 1;
  });
  vi.stubGlobal("requestIdleCallback", requestIdle);
  const { scheduleTranspilerWarmup, transpile } = await programs();
  scheduleTranspilerWarmup();
  scheduleTranspilerWarmup();
  expect(requestIdle).toHaveBeenCalledTimes(1);
  expect(transpile).not.toHaveBeenCalled();
  idle?.();
  idle?.();
  scheduleTranspilerWarmup();
  expect(transpile).toHaveBeenCalledTimes(1);
  expect(requestIdle).toHaveBeenCalledTimes(1);
  expect(transpile.mock.results[0]?.type).toBe("return");
});

it("skips idle work if real definitions ran, including file mode", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  const { scheduleTranspilerWarmup, resolvePrograms, transpile } =
    await programs();
  scheduleTranspilerWarmup();
  const g = programHost(1);
  const define = vi.spyOn(g, "define_program");
  await resolvePrograms(g, new WebAssembly.Memory({ initial: 1 }), null);
  expect(define).toHaveBeenCalledTimes(1);
  expect(transpile).toHaveBeenCalledTimes(1);
  vi.runAllTimers();
  expect(transpile).toHaveBeenCalledTimes(1);
  expect(define).toHaveBeenCalledTimes(1);
});

it("does not schedule after a real transpile already ran", async () => {
  const requestIdle = vi.fn();
  vi.stubGlobal("requestIdleCallback", requestIdle);
  const { scheduleTranspilerWarmup, definePrograms } = await programs();
  definePrograms(programHost(1), { defined: 0, refused: 0, library_reads: 0 });
  scheduleTranspilerWarmup();
  expect(requestIdle).not.toHaveBeenCalled();
});

it("still warms after definePrograms calls with nothing pending (every apply makes one)", async () => {
  let idle: (() => void) | undefined;
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    idle = cb;
    return 1;
  });
  const { scheduleTranspilerWarmup, definePrograms, transpile } =
    await programs();
  scheduleTranspilerWarmup();
  definePrograms(programHost(0), { defined: 0, refused: 0, library_reads: 0 });
  definePrograms(programHost(0), { defined: 0, refused: 0, library_reads: 0 });
  expect(transpile).not.toHaveBeenCalled();
  idle?.();
  expect(transpile).toHaveBeenCalledTimes(1);
});

it("falls back to a zero-delay timer and swallows transpiler errors", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  const { scheduleTranspilerWarmup, transpile } = await programs();
  transpile.mockImplementation(() => {
    throw new Error("warm-up failed");
  });
  scheduleTranspilerWarmup();
  expect(transpile).not.toHaveBeenCalled();
  expect(() => vi.runAllTimers()).not.toThrow();
  expect(transpile).toHaveBeenCalledTimes(1);
  scheduleTranspilerWarmup();
  vi.runAllTimers();
  expect(transpile).toHaveBeenCalledTimes(1);
});
