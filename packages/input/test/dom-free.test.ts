// @vitest-environment node
//
// The root entry is DOM-free (docs/architecture.md): a Godot host's tooling, a Node relay or a
// worker can import the codec. Node has no `document`/`window`, so an import or a codec call that
// touched either would throw here.
import { describe, expect, it } from "vitest";

describe("@godot-scene-web/input root entry", () => {
  it("imports and round-trips a message without DOM globals", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe(
      "undefined",
    );
    expect(typeof (globalThis as { window?: unknown }).window).toBe(
      "undefined",
    );
    const input = await import("../src/index");
    const [text] = input.encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: [{ event: "key", keycode: input.Key.ESCAPE, pressed: true }],
    });
    expect(input.parseInputMessage(text).ok).toBe(true);
  });

  it("runs a session (timers, microtasks, randomness) without DOM globals", async () => {
    const input = await import("../src/index");
    const texts: string[] = [];
    const session = input.createInputSession({
      send: (t) => texts.push(t),
      heartbeatMs: 5,
    });
    session.open();
    session.push({ event: "key", keycode: input.Key.ESCAPE, pressed: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.dispose();
    const types = texts.map((t) => {
      const result = input.parseInputMessage(t);
      return result.ok ? result.message.type : result.code;
    });
    expect(types.slice(0, 2)).toEqual(["hello", "events"]);
    expect(types).toContain("heartbeat");
    expect(types.at(-1)).toBe("bye");
  });
});
