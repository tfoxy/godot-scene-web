// jsdom (gsw default env).
//
// The compile/link STATUS QUERY is where a driver's asynchronous shader compile becomes synchronous:
// the answer does not exist until the compile has finished, so asking blocks the main thread until
// it has. On a moto g86 5G that was the worst task of a combat trace — 267 ms, 166 ms of it in
// `getProgramParameter` and 71 ms in `getShaderParameter`, inside a microtask, almost all of it
// WAIT rather than CPU.
//
// These tests pin the three things the split into `startProgram` / `ready()` / `finish()` has to
// keep true: nothing blocking is asked before `KHR_parallel_shader_compile` says it will not block;
// the success path stops asking each shader a question the link already answered; and every failure
// is still reported exactly the way it was, because a shader that will not compile is the one case
// where all this machinery has to hand a developer the same string it always did.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compileProgram,
  compileProgramAsync,
  startProgram,
} from "../../canvas-effects/src/shader-webgl";

// Real GL enum values, so a fake that keys off them is keyed off the same numbers the browser uses.
const COMPILE_STATUS = 0x8b81;
const LINK_STATUS = 0x8b82;
const COMPLETION_STATUS_KHR = 0x91b1;
const VERTEX_SHADER = 0x8b31;
const FRAGMENT_SHADER = 0x8b30;

interface FakeOptions {
  /** Expose `KHR_parallel_shader_compile`? */
  parallel?: boolean;
  /** How many `COMPLETION_STATUS_KHR` polls report "not done" before one reports done. */
  completeAfterPolls?: number;
  /** Never complete — the deadline backstop's case. */
  neverComplete?: boolean;
  linkStatus?: boolean;
  /** Per-stage compile status; only consulted on the failure path. */
  compileStatus?: { vertex?: boolean; fragment?: boolean };
}

function fakeGl(options: FakeOptions = {}) {
  const {
    parallel = false,
    completeAfterPolls = 0,
    neverComplete = false,
    linkStatus = true,
    compileStatus = {},
  } = options;
  const calls = {
    completion: 0,
    linkStatus: 0,
    shaderStatus: 0,
    createProgram: 0,
    deletedShaders: 0,
    deletedPrograms: 0,
    /** `calls.linkStatus` as it stood when the LAST completion poll ran. */
    linkStatusAtLastPoll: -1,
  };
  const shaders = new Map<object, number>();
  const program = { tag: "program" };
  const gl = {
    VERTEX_SHADER,
    FRAGMENT_SHADER,
    COMPILE_STATUS,
    LINK_STATUS,
    getExtension: (name: string) =>
      name === "KHR_parallel_shader_compile" && parallel
        ? { COMPLETION_STATUS_KHR }
        : null,
    createShader: (type: number) => {
      const shader = { type };
      shaders.set(shader, type);
      return shader;
    },
    shaderSource: () => {},
    compileShader: () => {},
    createProgram: () => {
      calls.createProgram++;
      return program;
    },
    attachShader: () => {},
    linkProgram: () => {},
    deleteShader: () => {
      calls.deletedShaders++;
    },
    deleteProgram: () => {
      calls.deletedPrograms++;
    },
    bindAttribLocation: () => {},
    getProgramParameter: (_program: unknown, pname: number) => {
      if (pname === COMPLETION_STATUS_KHR) {
        calls.completion++;
        calls.linkStatusAtLastPoll = calls.linkStatus;
        if (neverComplete) return false;
        return calls.completion > completeAfterPolls;
      }
      calls.linkStatus++;
      return linkStatus;
    },
    getShaderParameter: (shader: object, _pname: number) => {
      calls.shaderStatus++;
      const type = shaders.get(shader);
      return type === VERTEX_SHADER
        ? (compileStatus.vertex ?? true)
        : (compileStatus.fragment ?? true);
    },
    getShaderInfoLog: (shader: object) =>
      shaders.get(shader) === VERTEX_SHADER ? "vertex log" : "fragment log",
    getProgramInfoLog: () => "link log",
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, program };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startProgram — the status query is separable from the compile", () => {
  it("asks nothing blocking until KHR_parallel_shader_compile reports completion", async () => {
    const { gl, calls, program } = fakeGl({
      parallel: true,
      completeAfterPolls: 3,
    });

    const result = await compileProgramAsync(gl, "vs", "fs");

    expect(result).toBe(program);
    // It really polled (rather than falling straight through to the blocking query)…
    expect(calls.completion).toBeGreaterThan(3);
    // …and NOT ONE of those polls happened after a LINK_STATUS read: the blocking question is asked
    // once, at the end, when the driver has already said it can answer it.
    expect(calls.linkStatusAtLastPoll).toBe(0);
    expect(calls.linkStatus).toBe(1);
  });

  it("does not ask a shader for COMPILE_STATUS when the program linked", async () => {
    const { gl, calls } = fakeGl({ parallel: true });
    await compileProgramAsync(gl, "vs", "fs");
    // A link cannot succeed over a shader that failed to compile, so the two per-stage queries the
    // pre-split code always paid said nothing the link status had not already said.
    expect(calls.shaderStatus).toBe(0);
    expect(calls.deletedShaders).toBe(2); // both stages released
    expect(calls.deletedPrograms).toBe(0);
  });

  it("falls straight through to the blocking query where the extension is absent", async () => {
    const { gl, calls, program } = fakeGl({ parallel: false });
    const result = await compileProgramAsync(gl, "vs", "fs");
    expect(result).toBe(program);
    expect(calls.completion).toBe(0); // nothing to poll
    expect(calls.linkStatus).toBe(1); // exactly the pre-split behaviour
  });

  it("stops waiting at the deadline and asks anyway (worst case = the old behaviour)", async () => {
    vi.useFakeTimers();
    try {
      const { gl, calls, program } = fakeGl({
        parallel: true,
        neverComplete: true,
      });
      const pending = compileProgramAsync(gl, "vs", "fs");
      // Past the 3 s cap. A driver that has not finished by then is not helped by more polling, and
      // the fallback is precisely the query this whole mechanism defers.
      await vi.advanceTimersByTimeAsync(4000);
      await expect(pending).resolves.toBe(program);
      expect(calls.linkStatus).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a batch of compiles in ONE task, on ONE timer", async () => {
    // Per-program timers fire at independent moments, so N programs kicked together settle in N
    // different tasks — and a caller that batches DOM work per settle (the shader runtime's create
    // burst, which exists to cost ONE layout flush for the run) is handed N batches of one. Measured
    // against a real GPU before this was shared: 13 forced layouts in the create window, vs 2 after.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const order: string[] = [];
    const contexts = [0, 1, 2].map(() =>
      fakeGl({ parallel: true, completeAfterPolls: 2 }),
    );

    const compiles = contexts.map((ctx, index) =>
      compileProgramAsync(ctx.gl, "vs", "fs").then(() => {
        order.push(`program-${index}`);
        // Scheduled by the FIRST settle: anything that lands after it settled in a later task.
        if (index === 0) setTimeout(() => order.push("task-boundary"), 0);
      }),
    );
    await Promise.all(compiles);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(order).toEqual([
      "program-0",
      "program-1",
      "program-2",
      "task-boundary",
    ]);
    // Three programs, one poll chain: a handful of timers, not three chains of them. (The count
    // includes this test's own two.)
    expect(timers.mock.calls.length).toBeLessThan(8);
  });

  it("reports a still-pending program as not ready, and a completed one as ready", () => {
    const { gl } = fakeGl({ parallel: true, completeAfterPolls: 1 });
    const pending = startProgram(gl, "vs", "fs");
    expect(pending.ready()).toBe(false);
    expect(pending.ready()).toBe(true);
    // Latched: once the driver has said "done" it is not asked again.
    expect(pending.ready()).toBe(true);
  });
});

describe("startProgram — failure reporting is unchanged", () => {
  it("names a COMPILE failure as one, with that stage's info log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl, calls } = fakeGl({
      parallel: true,
      linkStatus: false,
      compileStatus: { fragment: false },
    });

    await expect(compileProgramAsync(gl, "vs", "fs")).resolves.toBeNull();

    // The link failure is a SYMPTOM of the compile failure; naming it would send a reader looking
    // for a cross-stage mismatch that isn't there.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[gsw webgl] shader compile failed:",
      "fragment log",
    );
    expect(calls.deletedPrograms).toBe(1);
    expect(calls.deletedShaders).toBe(2);
  });

  it("reports BOTH stages when both fail, in vertex-then-fragment order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl({
      parallel: true,
      linkStatus: false,
      compileStatus: { vertex: false, fragment: false },
    });

    await compileProgramAsync(gl, "vs", "fs");

    expect(warn.mock.calls).toEqual([
      ["[gsw webgl] shader compile failed:", "vertex log"],
      ["[gsw webgl] shader compile failed:", "fragment log"],
    ]);
  });

  it("names a genuine LINK failure (both stages compiled) as a link failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl({ parallel: true, linkStatus: false });

    await expect(compileProgramAsync(gl, "vs", "fs")).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[gsw webgl] program link failed:",
      "link log",
    );
  });

  it("returns null without reporting when the context yields no GL objects", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl();
    const noShaders = {
      ...(gl as unknown as Record<string, unknown>),
      createShader: () => null,
    } as unknown as WebGL2RenderingContext;
    expect(compileProgram(noShaders, "vs", "fs")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("compileProgram (synchronous) still exists for callers that cannot yield", () => {
  it("agrees with the async form on success", () => {
    const { gl, calls, program } = fakeGl({ parallel: true });
    // The sync form ignores the completion query by construction — it has nowhere to wait.
    expect(compileProgram(gl, "vs", "fs")).toBe(program);
    expect(calls.linkStatus).toBe(1);
    expect(calls.shaderStatus).toBe(0);
  });

  it("agrees with the async form on a compile failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl({
      linkStatus: false,
      compileStatus: { vertex: false },
    });
    expect(compileProgram(gl, "vs", "fs")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[gsw webgl] shader compile failed:",
      "vertex log",
    );
  });

  it("runs beforeLink between attach and link, so attribute bindings still take", () => {
    const { gl } = fakeGl();
    const order: string[] = [];
    const spied = {
      ...(gl as unknown as Record<string, unknown>),
      attachShader: () => order.push("attach"),
      linkProgram: () => order.push("link"),
    } as unknown as WebGL2RenderingContext;
    compileProgram(spied, "vs", "fs", () => order.push("beforeLink"));
    expect(order).toEqual(["attach", "attach", "beforeLink", "link"]);
  });
});
