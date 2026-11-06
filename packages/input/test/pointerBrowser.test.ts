// @vitest-environment node
//
// One real-browser check of the pointer capture (docs/input.md "Pointer"): real touch emulation
// through CDP `Input.dispatchTouchEvent` in native and mouse mode (a tap, a two-finger scroll), and the browser traps jsdom cannot show: X1/X2 history
// navigation (Chromium navigates on an unprevented mouseup of the back/forward buttons; the
// load-bearing prevent is `pointerup`, `auxclick` alone does not stop it), the middle press, the
// right-button context menu, and a chord's second button arriving as a `pointermove`.
// Headless only (playwright's default headless shell): never a window on the desktop.

import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type CDPSession,
  chromium,
  type Page,
} from "@playwright/test";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let server: Server;
let origin = "";

const PAGE = `<!doctype html><html><head><style>
html,body{margin:0;height:3000px}#stage{width:400px;height:300px;background:#888}
</style></head><body><div id="stage"></div><script src="/pointer.js"></script><script>
const stage = document.getElementById("stage");
window.records = [];
window.seen = [];
for (const type of ["pointerdown", "contextmenu", "mousedown"])
  window.addEventListener(type, (e) => window.seen.push([type, e.button, e.defaultPrevented]));
window.gestures = [];
window.capture = GswPointer.createPointerCapture({
  stage,
  // 400x300 CSS px showing an 800x600 host window.
  map: GswPointer.objectFitMapper(() => stage.getBoundingClientRect(), { width: 800, height: 600 }),
  sink: { push: (r) => window.records.push(r) },
  mode: location.search.includes("mouse") ? "mouse" : "native",
  gestures: { onGesture: (g) => window.gestures.push(g.kind) },
});
</script></body></html>`;

beforeAll(async () => {
  const bundle = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("../src/pointer.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "GswPointer",
    platform: "browser",
    conditions: ["development"],
    write: false,
  });
  const script = bundle.outputFiles[0]?.text ?? "";
  server = createServer((req, res) => {
    if (req.url === "/pointer.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(script);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(req.url?.startsWith("/first") ? "<p>first</p>" : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function open(
  touch = false,
  mode: "native" | "mouse" = "native",
): Promise<{ page: Page; cdp: CDPSession }> {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    hasTouch: touch,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/first`);
  await page.goto(`${origin}/stage?${mode}`);
  const cdp = await context.newCDPSession(page);
  return { page, cdp };
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

type Rec = Record<string, unknown>;
const records = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { records: Rec[] }).records.splice(0),
  );

async function mouse(
  cdp: CDPSession,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  button: "none" | "left" | "middle" | "right" | "back" | "forward",
  buttons: number,
  x = 100,
  y = 100,
) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

describe("pointer capture in headless Chromium", () => {
  it("turns real emulated touches into screen_touch / screen_drag with lowest-free indices", async () => {
    const { page, cdp } = await open(true);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { x: number; y: number; id: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    await touch("touchStart", [{ x: 50, y: 50, id: 1 }]);
    await touch("touchStart", [
      { x: 50, y: 50, id: 1 },
      { x: 150, y: 100, id: 2 },
    ]);
    await touch("touchMove", [
      { x: 60, y: 50, id: 1 },
      { x: 150, y: 120, id: 2 },
    ]);
    await frames(page);
    await touch("touchEnd", [{ x: 150, y: 120, id: 2 }]);
    await touch("touchEnd", []);
    await frames(page);
    const got = await records(page);
    expect(got.filter((r) => r.event === "screen_touch")).toEqual([
      { event: "screen_touch", pressed: true, position: [100, 100] },
      { event: "screen_touch", index: 1, pressed: true, position: [300, 200] },
      { event: "screen_touch", index: 1, pressed: false, position: [300, 240] },
      { event: "screen_touch", pressed: false, position: [120, 100] },
    ]);
    const drags = got.filter((r) => r.event === "screen_drag");
    expect(drags).toContainEqual({
      event: "screen_drag",
      position: [120, 100],
      relative: [20, 0],
    });
    expect(drags).toContainEqual({
      event: "screen_drag",
      index: 1,
      position: [300, 240],
      relative: [0, 40],
    });
    expect(got.some((r) => String(r.event).startsWith("mouse_"))).toBe(false);
    expect(
      await page.evaluate(
        () => document.getElementById("stage")?.style.touchAction,
      ),
    ).toBe("none");
    await page.context().close();
  });

  it("mouse mode: a real tap is a motion and a LEFT click, with no touch records", async () => {
    const { page, cdp } = await open(true, "mouse");
    const touch = (type: "touchStart" | "touchEnd", points: Rec[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    await touch("touchStart", [{ x: 50, y: 60, id: 1 }]);
    await touch("touchEnd", []);
    await frames(page);
    expect(await records(page)).toEqual([
      { event: "mouse_motion", position: [100, 120] },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [100, 120],
        button_mask: 1,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [100, 120],
      },
    ]);
    expect(
      await page.evaluate(
        () => (window as unknown as { gestures: string[] }).gestures,
      ),
    ).toEqual(["touch-down", "tap", "touch-end"]);
    await page.context().close();
  });

  it("mouse mode: a real two-finger scroll becomes natural-direction wheel ticks", async () => {
    const { page, cdp } = await open(true, "mouse");
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: Rec[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    await touch("touchStart", [{ x: 100, y: 100, id: 1 }]);
    await touch("touchStart", [
      { x: 100, y: 100, id: 1 },
      { x: 200, y: 100, id: 2 },
    ]);
    // Fingers DOWN 60 CSS px = 120 host px of centroid drift: two WHEEL_UP ticks (56 px each).
    for (const y of [120, 140, 160])
      await touch("touchMove", [
        { x: 100, y, id: 1 },
        { x: 200, y, id: 2 },
      ]);
    await touch("touchEnd", []);
    await frames(page);
    const got = await records(page);
    // Latch: the centroid (150, 100) CSS -> host (300, 200).
    const tick = {
      event: "mouse_button",
      button_index: 4,
      position: [300, 200],
    };
    expect(got).toEqual([
      { ...tick, pressed: true, button_mask: 8 },
      { ...tick, pressed: false },
      { ...tick, pressed: true, button_mask: 8 },
      { ...tick, pressed: false },
    ]);
    await page.context().close();
  });

  it("keeps X1/X2 from navigating history and still sends their edges", async () => {
    const { page, cdp } = await open();
    await mouse(cdp, "mouseMoved", "none", 0);
    await mouse(cdp, "mousePressed", "back", 8);
    await mouse(cdp, "mouseReleased", "back", 0);
    await mouse(cdp, "mousePressed", "forward", 16);
    await mouse(cdp, "mouseReleased", "forward", 0);
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/stage");
    const edges = (await records(page))
      .filter((r) => r.event === "mouse_button")
      .map((r) => [r.button_index, r.pressed, r.button_mask ?? 0]);
    expect(edges).toEqual([
      [8, true, 128],
      [8, false, 0],
      [9, true, 256],
      [9, false, 0],
    ]);
    // Control: the same back press off the stage navigates.
    await mouse(cdp, "mouseMoved", "none", 0, 600, 500);
    await mouse(cdp, "mousePressed", "back", 8, 600, 500);
    await mouse(cdp, "mouseReleased", "back", 0, 600, 500);
    await page.waitForURL(`${origin}/first`);
    await page.context().close();
  });

  it("prevents the middle press and the right-button menu, and diffs a chord's second button", async () => {
    const { page, cdp } = await open();
    await mouse(cdp, "mouseMoved", "none", 0);
    await mouse(cdp, "mousePressed", "middle", 4);
    await mouse(cdp, "mouseMoved", "middle", 4, 100, 250);
    await mouse(cdp, "mouseReleased", "middle", 0, 100, 250);
    await mouse(cdp, "mousePressed", "left", 1);
    await mouse(cdp, "mousePressed", "right", 3); // a pointermove in DOM
    await mouse(cdp, "mouseReleased", "right", 1);
    await mouse(cdp, "mouseReleased", "left", 0);
    await frames(page);
    const seen = await page.evaluate(
      () => (window as unknown as { seen: unknown[] }).seen,
    );
    // pointerdown prevented: no compat mousedown, so no autoscroll and no focus steal.
    expect(seen).toContainEqual(["pointerdown", 1, true]);
    expect(seen.filter((s) => (s as unknown[])[0] === "mousedown")).toEqual([]);
    expect(seen).toContainEqual(["contextmenu", 2, true]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("stage");
    const edges = (await records(page))
      .filter((r) => r.event === "mouse_button")
      .map((r) => [r.button_index, r.pressed, r.button_mask ?? 0]);
    expect(edges).toEqual([
      [3, true, 4],
      [3, false, 0],
      [1, true, 1],
      [2, true, 3],
      [2, false, 1],
      [1, false, 0],
    ]);
    await page.context().close();
  });
});
