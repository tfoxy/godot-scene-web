import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { godotEaseSample } from "../../effects/src/easing/numeric";
import { clientHello, clientProtocol, coreStartOptions } from "../src/hello";
import { createRecorder } from "../src/recorder";
import { ENDPOINT, FakeCore, flush, harness, msg, session, tx } from "./fakes";

class TweenCore extends FakeCore {
  active = false;
  ticks: { now: number; picture: boolean }[] = [];
  tweensActive(): boolean {
    return this.active;
  }
  tweenTick(now: number, picture: boolean): boolean {
    this.ticks.push({ now, picture });
    return this.active;
  }
  tweenDiagnostics() {
    return {
      live_tweens: Number(this.active),
      material_begins: 2,
      material_retired: 1,
      live_material_tweens: Number(this.active),
      held_material_components: this.active ? 3 : 0,
    };
  }
}
function streaming(protocol: 17 | 19 = 17) {
  const core = new TweenCore();
  const h = harness(
    2,
    {
      clientTweens: true,
      applyOn: "frame",
      creditStage: "submitted",
      resourceHoldMs: Infinity,
    },
    core,
    { ...ENDPOINT, protocol },
  );
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session());
  h.last().on.message(tx(1));
  h.clock.frame();
  core.active = true;
  return { ...h, core };
}

describe("client tweens", () => {
  it("surfaces material diagnostics and drives the same ACK-free loop at /19", () => {
    const h = streaming(19);
    const acks = h.last().acks().slice();
    h.clock.frame();
    expect(h.loop.stats().clientTweens).toMatchObject({
      material_begins: 2,
      material_retired: 1,
      live_material_tweens: 1,
      held_material_components: 3,
    });
    expect(h.last().acks()).toEqual(acks);
    h.core.active = false;
    const ticks = h.core.ticks.length;
    h.clock.frame();
    expect(h.core.ticks).toHaveLength(ticks);
  });
  it("keeps the Rust parity reference in sync with every Godot easing pair", () => {
    const rows = JSON.parse(
      readFileSync(
        "experiments/render-stream/rs-core/test/tween-easing.json",
        "utf8",
      ),
    ) as number[][];
    const trans = [
      "linear",
      "sine",
      "quint",
      "quart",
      "quad",
      "expo",
      "elastic",
      "cubic",
      "circ",
      "bounce",
      "back",
      "spring",
    ];
    const ease = ["in", "out", "in_out", "out_in"];
    expect(rows).toHaveLength(480);
    for (const [tr, ea, t, want] of rows)
      expect(godotEaseSample(ease[ea], trans[tr], t)).toBe(want);
  });
  it("negotiates only with the explicit option, retaining pure hello bytes", () => {
    const facts = {
      protocol: 17 as const,
      creditWindow: 2 as const,
      token: null,
      backing: [640, 360] as [number, number],
      css: [640, 360] as [number, number],
      dprMilli: 1000,
      gpuFormats: "none",
    };
    const pure = clientHello(facts);
    const on = clientHello({ ...facts, clientTweens: true });
    expect(on).toEqual({ ...pure, client_tweens: true });
    expect(Object.keys(on).at(-1)).toBe("client_tweens");
    expect(pure).not.toHaveProperty("client_tweens");
    expect(JSON.parse(coreStartOptions(17))).not.toHaveProperty(
      "client_tweens",
    );
    expect(
      JSON.parse(coreStartOptions(17, true, false, false, true)),
    ).toHaveProperty("client_tweens", true);
    expect(() => clientProtocol(16, null, false, true)).toThrow("protocol 17");
  });
  it("redraws through network stalls, stops when idle, and sends no extra acknowledgments", () => {
    const h = streaming();
    const ack = h.last().acks().slice();
    h.clock.frame();
    h.clock.frame();
    expect(h.core.ticks.filter((t) => !t.picture)).toHaveLength(2);
    expect(h.core.calls.filter((c) => c.startsWith("draw"))).toHaveLength(3);
    expect(h.last().acks()).toEqual(ack);
    h.core.active = false;
    const ticks = h.core.ticks.length;
    const draws = h.core.calls.length;
    h.clock.frame();
    h.clock.frame();
    expect(h.core.ticks).toHaveLength(ticks);
    expect(h.core.calls).toHaveLength(draws);
  });
  it("pauses during prepared payload waits, counts once per wait, then resumes on the later clock", async () => {
    const h = streaming();
    h.clock.frame();
    const before = h.core.ticks.length;
    h.last().on.message(tx(2, ["aa"]));
    h.clock.frame();
    h.clock.frame();
    h.clock.frame();
    expect(h.core.ticks).toHaveLength(before);
    expect(h.loop.stats().clientTweens).toMatchObject({
      payload_wait_pauses: 1,
    });
    h.loop.contextLost();
    h.clock.frame();
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.loop.stats().clientTweens).toMatchObject({
      payload_wait_pauses: 1,
    });
    h.last().gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.ticks.at(-1)).toEqual({ now: h.clock.t, picture: true });
    h.clock.frame();
    expect(h.core.ticks.at(-1)?.picture).toBe(false);
    h.last().on.message(tx(3, ["bb"]));
    h.clock.frame();
    h.clock.frame();
    expect(h.loop.stats().clientTweens).toMatchObject({
      payload_wait_pauses: 2,
    });
  });
  it("samples the running timeline before a context restore redraw", () => {
    const h = streaming();
    h.clock.frame();
    h.loop.contextLost();
    const before = h.core.ticks.length;
    h.clock.frame();
    h.clock.frame();
    expect(h.core.ticks).toHaveLength(before);
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.ticks.at(-1)).toEqual({ now: h.clock.t, picture: true });
  });
  it("records tween, identity and transaction records together across a full restart", () => {
    const r = createRecorder();
    const s = Uint8Array.of(1),
      begin = Uint8Array.of(2),
      identity = Uint8Array.of(3),
      full = Uint8Array.of(4);
    r.session(s);
    r.record(Uint8Array.of(99), "transaction", true, 1);
    r.record(begin, "tween", false, 0);
    r.record(identity, "item_meta", false, 0);
    r.record(full, "transaction", true, 2);
    expect([...r.export().bytes!]).toEqual([1, 2, 3, 4]);
  });
  it("exports tween prefixes atomically with their transaction, including overflow", () => {
    const r = createRecorder({ maxBytes: 5 });
    r.session(Uint8Array.of(1));
    r.record(Uint8Array.of(2), "transaction", true, 1);
    r.record(Uint8Array.of(3), "tween", false, 0);
    expect([...r.export().bytes!]).toEqual([1, 2]);
    r.record(Uint8Array.of(4), "item_meta", false, 0);
    expect([...r.export().bytes!]).toEqual([1, 2]);
    r.record(Uint8Array.of(5, 6), "transaction", false, 2);
    expect(r.export().overflow).toBe(true);
    expect([...r.export().bytes!]).toEqual([1, 2]);
  });
  it("passes tween wire bytes to an opt-in recorder", () => {
    const r = createRecorder();
    const core = new TweenCore();
    const h = harness(2, { clientTweens: true, recorder: r }, core, {
      ...ENDPOINT,
      protocol: 17,
    });
    h.loop.connect();
    h.last().on.open();
    const sess = session();
    h.last().on.message(sess);
    const tween = msg({ kind: "tween" });
    h.last().on.message(tween);
    h.last().on.message(tx(1));
    expect(new TextDecoder().decode(r.export().bytes!)).toContain(
      '"kind":"tween"',
    );
  });
});
