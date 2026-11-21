// @vitest-environment node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

let browser: Browser;
let page: Page;
const wasmRoot = resolve(
  process.env.GSW_CANVAS_ITEMS_WASM ?? "artifacts/canvas-items-pixel/wasm",
);
beforeAll(async () => {
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  browser = await chromium.launch({
    headless: false,
    args: ["--headless=new", "--enable-gpu", "--use-angle=vulkan"],
    env,
  });
});
afterAll(async () => browser?.close());
beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".js") || path.endsWith(".wasm")) {
      await route.fulfill({
        body: await readFile(resolve(wasmRoot, path.slice(1))),
        contentType: path.endsWith(".js")
          ? "text/javascript"
          : "application/wasm",
      });
    } else await route.fulfill({ body: "<!doctype html><canvas></canvas>" });
  });
  await page.goto("http://localhost/prepare");
  await page.addScriptTag({
    type: "module",
    content:
      'import init, * as mod from "/canvas_items.js"; await init(); window.wasmModule = mod;',
  });
  await page.waitForFunction(() => Reflect.has(window, "wasmModule"));
});

// These tests instrument actual GL calls, including LINK_STATUS, rather than duplicating the
// preparation state machine in a fake. Each page starts with a fresh context and wasm instance.
async function probe(mode: "step" | "new" | "dispose" | "draw") {
  return page.evaluate(async (mode) => {
    const { CanvasItemsTestHarness: Harness } = Reflect.get(
      window,
      "wasmModule",
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const events: string[] = [];
    const proto = WebGL2RenderingContext.prototype;
    for (const key of [
      "createProgram",
      "linkProgram",
      "getProgramParameter",
      "deleteProgram",
      "createBuffer",
      "deleteBuffer",
      "createVertexArray",
      "deleteVertexArray",
      "createTexture",
      "deleteTexture",
      "createSampler",
      "deleteSampler",
      "drawArrays",
      "drawElements",
    ] as const) {
      const original = proto[key];
      Object.defineProperty(proto, key, {
        value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
          if (key !== "getProgramParameter" || args[1] === this.LINK_STATUS)
            events.push(key);
          return Reflect.apply(original, this, args);
        },
      });
    }
    const h = mode === "new" ? new Harness(canvas, "") : Harness.begin(canvas);
    const initial = { prepared: h.is_prepared(), events: [...events] };
    const steps: { done: boolean; events: string[] }[] = [];
    if (mode === "step" || mode === "dispose") {
      for (let i = 0; i < (mode === "dispose" ? 2 : 4); i++) {
        const at = events.length;
        steps.push({ done: h.prepare_step(), events: events.slice(at) });
      }
    } else if (mode === "draw") {
      try {
        h.execute();
      } catch {
        /* An empty target may refuse, but preparation must finish. */
      }
    }
    const prepared = h.is_prepared();
    h.free();
    return { initial, steps, prepared, events };
  }, mode);
}

it("begins without programs and settles one builtin per step in constructor order", async () => {
  const staged = await probe("step");
  expect(staged.initial).toEqual({ prepared: false, events: [] });
  expect(staged.steps.map((s) => s.done)).toEqual([false, false, true, true]);
  expect(
    staged.steps.map(
      (s) => s.events.filter((e) => e === "getProgramParameter").length,
    ),
  ).toEqual([1, 1, 1, 0]);
  expect(staged.steps[0].events).toEqual([
    "createProgram",
    "linkProgram",
    "getProgramParameter",
  ]);
  expect(staged.steps[1].events).toEqual(staged.steps[0].events);
  expect(staged.steps[2].events.slice(0, 3)).toEqual(staged.steps[0].events);
  expect(staged.events).not.toContain("drawElements");
  // The depth link stays asynchronous: four links, only three status reads.
  expect(staged.events.filter((e) => e === "linkProgram")).toHaveLength(4);
  await page.reload();
  await page.addScriptTag({
    type: "module",
    content:
      'import init, * as mod from "/canvas_items.js"; await init(); window.wasmModule = mod;',
  });
  await page.waitForFunction(() => Reflect.has(window, "wasmModule"));
  const eager = await probe("new");
  expect(eager.initial.prepared).toBe(true);
  expect(eager.events).toEqual(staged.events);
});

it("deletes settled programs when disposed halfway through preparation", async () => {
  const result = await probe("dispose");
  expect(result.prepared).toBe(false);
  expect(result.events.filter((e) => e === "createProgram")).toHaveLength(2);
  expect(result.events.filter((e) => e === "deleteProgram")).toHaveLength(2);
  expect(result.events).not.toContain("createBuffer");
});

it("finishes every remaining stage synchronously before an early draw", async () => {
  const result = await probe("draw");
  expect(result.prepared).toBe(true);
  expect(result.events.filter((e) => e === "getProgramParameter")).toHaveLength(
    3,
  );
  const draw = result.events.findIndex(
    (e) => e === "drawElements" || e === "drawArrays",
  );
  if (draw >= 0)
    expect(
      result.events.slice(0, draw).filter((e) => e === "getProgramParameter"),
    ).toHaveLength(3);
});

it("forgets partial handles on loss and starts from the ordinary program on restore", async () => {
  await page.evaluate(async () => {
    const mod = Reflect.get(window, "wasmModule");
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const h = mod.CanvasItemsTestHarness.begin(canvas);
    h.prepare_step();
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
    const ext = gl.getExtension("WEBGL_lose_context");
    Object.assign(window, { h, ext, lost: false, restored: false, deleted: 0 });
    const original = gl.deleteProgram.bind(gl);
    gl.deleteProgram = (p) => {
      Object.assign(window, { deleted: Reflect.get(window, "deleted") + 1 });
      original(p);
    };
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      Reflect.set(window, "lost", true);
    });
    canvas.addEventListener("webglcontextrestored", () =>
      Reflect.set(window, "restored", true),
    );
    ext?.loseContext();
  });
  await page.waitForFunction(() => Reflect.get(window, "lost"));
  expect(
    await page.evaluate(() => {
      const h = Reflect.get(window, "h");
      try {
        h.prepare_step();
        return "unexpected success";
      } catch (e) {
        return String(e);
      }
    }),
  ).toContain("WebGL2 context lost");
  await page.evaluate(() => Reflect.get(window, "ext").restoreContext());
  await page.waitForFunction(() => Reflect.get(window, "restored"));
  expect(
    await page.evaluate(() => {
      const h = Reflect.get(window, "h");
      const steps = [h.prepare_step(), h.prepare_step(), h.prepare_step()];
      const deleted = Reflect.get(window, "deleted");
      h.free();
      return { steps, deleted };
    }),
  ).toEqual({ steps: [false, false, true], deleted: 0 });
});

it.each([
  "link",
  "buffer",
] as const)("reports canonical loss during %s preparation and recovers before a session", async (fault) => {
  const result = await page.evaluate((fault) => {
    const mod = Reflect.get(window, "wasmModule");
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const h = mod.CanvasItemsTestHarness.begin(canvas);
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    Object.assign(window, { h, ext, lost: false, restored: false });
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      Reflect.set(window, "lost", true);
    });
    canvas.addEventListener("webglcontextrestored", () =>
      Reflect.set(window, "restored", true),
    );
    if (fault === "link") {
      const original = gl.getProgramParameter.bind(gl);
      gl.getProgramParameter = (program, parameter) => {
        if (parameter === gl.LINK_STATUS) {
          gl.getProgramParameter = original;
          ext.loseContext();
          return null;
        }
        return original(program, parameter);
      };
    } else {
      h.prepare_step();
      h.prepare_step();
      const original = gl.createBuffer.bind(gl);
      gl.createBuffer = () => {
        gl.createBuffer = original;
        ext.loseContext();
        return null;
      };
    }
    try {
      h.prepare_step();
      return "unexpected success";
    } catch (e) {
      return String(e);
    }
  }, fault);
  expect(result).toBe("WebGL2 context lost");
  await page.waitForFunction(() => Reflect.get(window, "lost"));
  await page.evaluate(() => Reflect.get(window, "ext").restoreContext());
  await page.waitForFunction(() => Reflect.get(window, "restored"));
  expect(
    await page.evaluate(() => {
      const h = Reflect.get(window, "h");
      const steps = [h.prepare_step(), h.prepare_step(), h.prepare_step()];
      const prepared = h.is_prepared();
      h.free();
      return { steps, prepared };
    }),
  ).toEqual({ steps: [false, false, true], prepared: true });
});

it("rejects an already-lost context before glow reads its capabilities and retries after restore", async () => {
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    Object.assign(window, {
      ext,
      lost: false,
      restored: false,
      capabilityReads: 0,
    });
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      Reflect.set(window, "lost", true);
    });
    canvas.addEventListener("webglcontextrestored", () =>
      Reflect.set(window, "restored", true),
    );
    const original = gl.getSupportedExtensions.bind(gl);
    gl.getSupportedExtensions = () => {
      Reflect.set(
        window,
        "capabilityReads",
        Reflect.get(window, "capabilityReads") + 1,
      );
      return original();
    };
    ext.loseContext();
  });
  await page.waitForFunction(() => Reflect.get(window, "lost"));
  expect(
    await page.evaluate(() => {
      const mod = Reflect.get(window, "wasmModule");
      try {
        mod.CanvasItemsTestHarness.begin(document.querySelector("canvas"));
        return "unexpected success";
      } catch (e) {
        return String(e);
      }
    }),
  ).toBe("WebGL2 context lost");
  expect(
    await page.evaluate(() => Reflect.get(window, "capabilityReads")),
  ).toBe(0);
  await page.evaluate(() => Reflect.get(window, "ext").restoreContext());
  await page.waitForFunction(() => Reflect.get(window, "restored"));
  expect(
    await page.evaluate(() => {
      const mod = Reflect.get(window, "wasmModule");
      const h = mod.CanvasItemsTestHarness.begin(
        document.querySelector("canvas"),
      );
      const steps = [h.prepare_step(), h.prepare_step(), h.prepare_step()];
      h.free();
      return steps;
    }),
  ).toEqual([false, false, true]);
});

it("keeps a prepared executor ready until the loss event and restores it afterward", async () => {
  const beforeEvent = await page.evaluate(() => {
    const mod = Reflect.get(window, "wasmModule");
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const h = new mod.CanvasItemsTestHarness(canvas, "");
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    Object.assign(window, { h, ext, lost: false, restored: false });
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      Reflect.set(window, "lost", true);
    });
    canvas.addEventListener("webglcontextrestored", () =>
      Reflect.set(window, "restored", true),
    );
    const prepared = h.is_prepared();
    ext.loseContext();
    const state = h.context_state();
    let execute = "ok";
    try {
      h.execute();
    } catch (e) {
      execute = String(e);
    }
    return { prepared, eventSeen: Reflect.get(window, "lost"), state, execute };
  });
  expect(beforeEvent.prepared).toBe(true);
  expect(beforeEvent.eventSeen).toBe(false);
  expect(beforeEvent.state).toBe("ready");
  expect(beforeEvent.execute).not.toContain("WebGL2 context lost");
  await page.waitForFunction(() => Reflect.get(window, "lost"));
  expect(
    await page.evaluate(() => Reflect.get(window, "h").context_state()),
  ).toBe("lost");
  await page.evaluate(() => Reflect.get(window, "ext").restoreContext());
  await page.waitForFunction(() => Reflect.get(window, "restored"));
  expect(
    await page.evaluate(() => {
      const h = Reflect.get(window, "h");
      const state = h.context_state();
      const prepared = h.is_prepared();
      h.free();
      return { state, prepared };
    }),
  ).toEqual({ state: "restored", prepared: true });
});
