import { afterEach, describe, expect, it, vi } from "vitest";
import { createGamepadCapture, type GamepadSnapshot } from "../src/gamepad";
import {
  createInputSession,
  type InputHeldState,
  type InputMessage,
  type InputRecord,
  type InputSessionOptions,
  type InputSyncSource,
  JoyButton,
  Key,
  type KeyRecord,
  parseInputMessage,
} from "../src/index";

const key = (keycode: number, pressed = true): KeyRecord => ({
  event: "key",
  physical_keycode: keycode,
  keycode,
  pressed,
});
// Device 0 is the default, which the canonical encoding (and so a parse) omits.
const button = (button_index: number, pressed = true, device = 0) =>
  ({
    event: "joypad_button",
    ...(device === 0 ? {} : { device }),
    button_index,
    pressed,
  }) as const;

function decode(text: string): InputMessage {
  const result = parseInputMessage(text);
  if (!result.ok) throw new Error(`invalid ${text}: ${result.detail}`);
  return result.message;
}

function harness(options: Partial<InputSessionOptions> = {}) {
  const texts: string[] = [];
  const session = createInputSession({
    send: (text) => texts.push(text),
    heartbeatMs: 0,
    ...options,
  });
  const messages = () => texts.map(decode);
  const take = () => {
    const out = messages();
    texts.length = 0;
    return out;
  };
  return { session, texts, messages, take };
}

/** A capture stand-in: pushes through the sink and reports what it holds. */
function fakeKeyboard(sink: { push(record: InputRecord): void }) {
  const held = new Map<number, KeyRecord>();
  return {
    press(code: number) {
      const record = key(code);
      held.set(code, record);
      sink.push(record);
    },
    release(code: number) {
      held.delete(code);
      sink.push(key(code, false));
    },
    heldState: (): InputHeldState[] => [
      { scope: "keyboard", held: [...held.values()] },
    ],
  } satisfies InputSyncSource & Record<string, unknown>;
}

function fakeGamepad(sink: { push(record: InputRecord): void }, pads = 2) {
  const held = Array.from({ length: pads }, () => new Set<number>());
  return {
    press(device: number, index: number) {
      held[device]?.add(index);
      sink.push(button(index, true, device));
    },
    release(device: number, index: number) {
      held[device]?.delete(index);
      sink.push(button(index, false, device));
    },
    heldState: (): InputHeldState[] =>
      held.map((set, device) => ({
        scope: "joypad",
        device,
        held: [...set].map((index) => button(index, true, device)),
      })),
  } satisfies InputSyncSource & Record<string, unknown>;
}

/** The host half of docs/input.md "Session", for keys and joypad buttons only. */
function hostModel() {
  let epoch: number | undefined;
  let last = -1;
  const keys = new Set<number>();
  const pads = new Map<number, Set<number>>();
  const dropped: string[] = [];
  const pad = (device: number) => {
    let set = pads.get(device);
    if (set === undefined) {
      set = new Set();
      pads.set(device, set);
    }
    return set;
  };
  const apply = (record: InputRecord) => {
    if (record.event === "key") {
      const code = record.physical_keycode ?? 0;
      if (record.pressed) keys.add(code);
      else keys.delete(code);
    } else if (record.event === "joypad_button") {
      const set = pad(record.device ?? 0);
      if (record.pressed) set.add(record.button_index ?? 0);
      else set.delete(record.button_index ?? 0);
    }
  };
  const releaseAll = () => {
    keys.clear();
    pads.clear();
  };
  return {
    keys,
    pads,
    dropped,
    receive(text: string) {
      const message = decode(text);
      if (message.type === "hello") {
        if (message.epoch === epoch) return void dropped.push("duplicate");
        releaseAll();
        epoch = message.epoch;
        last = message.seq ?? 0;
        return;
      }
      if (epoch === undefined) return void dropped.push("no-hello");
      if (message.epoch !== epoch) return void dropped.push("stale-epoch");
      if (message.seq <= last) return void dropped.push("duplicate");
      if (message.seq > last + 1) dropped.push("gap");
      last = message.seq;
      if (message.type === "events") message.events.forEach(apply);
      else if (message.type === "sync") {
        if (message.scope === "keyboard") keys.clear();
        else if (message.scope === "joypad") pad(message.device ?? 0).clear();
        message.held.forEach(apply);
      } else if (message.type === "reset") releaseAll();
      else if (message.type === "bye") {
        releaseAll();
        epoch = undefined;
      }
    },
    close() {
      releaseAll();
      epoch = undefined;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("createInputSession: open, hello and sync", () => {
  it("sends hello (seq 0) then one sync per attached scope, in attach order", () => {
    const { session, take } = harness({ source: "seat-1", kinds: ["key"] });
    const keyboard = fakeKeyboard(session);
    const gamepad = fakeGamepad(session);
    session.attach(keyboard);
    session.attach(gamepad);
    session.open();
    const out = take();
    expect(out.map((m) => m.type)).toEqual(["hello", "sync", "sync", "sync"]);
    const [hello, kb, pad0, pad1] = out;
    expect(hello).toEqual({
      type: "hello",
      format: "gsw-input/1",
      source: "seat-1",
      epoch: session.epoch,
      kinds: ["key"],
    });
    expect(kb).toMatchObject({ scope: "keyboard", seq: 1, held: [] });
    expect(pad0).toMatchObject({ scope: "joypad", device: 0, seq: 2 });
    expect(pad1).toMatchObject({ scope: "joypad", device: 1, seq: 3 });
    expect(session.state).toBe("open");
  });

  it("generates a valid stable source and a u32 epoch", () => {
    const { session, take } = harness();
    expect(session.source).toMatch(/^[A-Za-z0-9]{12}$/);
    session.open();
    const hello = take()[0];
    expect(hello).toMatchObject({ type: "hello", source: session.source });
    expect(Number.isInteger(session.epoch)).toBe(true);
    expect(session.epoch).toBeGreaterThanOrEqual(0);
    expect(session.epoch).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("refuses a bad source, kinds, maxBytes or heartbeatMs at creation", () => {
    const send = () => {};
    expect(() => createInputSession({ send, source: "has space" })).toThrow();
    expect(() => createInputSession({ send, kinds: ["Bad"] })).toThrow();
    expect(() => createInputSession({ send, maxBytes: 10 })).toThrow(
      RangeError,
    );
    expect(() => createInputSession({ send, heartbeatMs: -1 })).toThrow(
      RangeError,
    );
  });

  it("syncs a capture attached while open at once, after pending records", () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.A));
    const keyboard = fakeKeyboard(session);
    keyboard.press(Key.W);
    session.attach(keyboard);
    const out = take();
    expect(out.map((m) => m.type)).toEqual(["events", "sync"]);
    expect(out[1]).toMatchObject({ seq: 2, held: [key(Key.W)] });
  });

  it("stops syncing a detached capture", () => {
    const { session, take } = harness();
    const detach = session.attach(fakeKeyboard(session));
    detach();
    detach();
    session.open();
    expect(take().map((m) => m.type)).toEqual(["hello"]);
  });
});

describe("createInputSession: batching", () => {
  it("batches pushes of one task into one events message at the microtask", async () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W));
    session.push(button(JoyButton.B));
    session.push(key(Key.W, false));
    expect(take()).toEqual([]);
    await Promise.resolve();
    const out = take();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "events",
      seq: 1,
      events: [key(Key.W), button(JoyButton.B), key(Key.W, false)],
    });
  });

  it("sends pushes of separate tasks as separate messages", async () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W));
    await tick();
    session.push(key(Key.W, false));
    await tick();
    expect(take().map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
  });

  it("flush() sends pending records synchronously and the microtask then sends nothing", async () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W));
    session.flush();
    expect(take()).toHaveLength(1);
    await Promise.resolve();
    expect(take()).toEqual([]);
  });
});

describe("createInputSession: S1 press before connect / reconnect", () => {
  it("drops pushes while closed and heals held state through open()", async () => {
    const host = hostModel();
    const { session, texts } = harness();
    const deliver = () => {
      for (const text of texts.splice(0)) host.receive(text);
    };
    const keyboard = fakeKeyboard(session);
    const gamepad = fakeGamepad(session);
    session.attach(keyboard);
    session.attach(gamepad);

    // Pressed before the carrier opened: dropped, then healed by the sync.
    keyboard.press(Key.W);
    gamepad.press(1, JoyButton.A);
    expect(session.stats().dropped).toBe(2);
    await Promise.resolve();
    expect(texts).toEqual([]);
    session.open();
    deliver();
    expect([...host.keys]).toEqual([Key.W]);
    expect([...(host.pads.get(1) ?? [])]).toEqual([JoyButton.A]);

    // Carrier drops; W is released and Shift pressed while it is down; neither is replayed.
    session.close();
    host.close();
    keyboard.release(Key.W);
    keyboard.press(Key.SHIFT);
    await Promise.resolve();
    expect(texts).toEqual([]);
    session.open();
    deliver();
    expect([...host.keys]).toEqual([Key.SHIFT]);
    expect([...(host.pads.get(1) ?? [])]).toEqual([JoyButton.A]);

    keyboard.release(Key.SHIFT);
    gamepad.release(1, JoyButton.A);
    await Promise.resolve();
    deliver();
    expect(host.keys.size).toBe(0);
    expect(host.pads.get(1)?.size).toBe(0);
    expect(host.dropped).toEqual([]);
  });

  it("drops records pending when the carrier closes, never sending them later", async () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W));
    session.close();
    await Promise.resolve();
    session.open();
    await Promise.resolve();
    expect(take().map((m) => m.type)).toEqual(["hello"]);
    expect(session.stats().dropped).toBe(1);
  });
});

describe("createInputSession: S2 new epoch", () => {
  it("picks a fresh epoch on every open, restarts seq at 0 and keeps the source", () => {
    const { session, take } = harness({ source: "s" });
    const epochs = new Set<number>();
    for (let i = 0; i < 20; i++) {
      session.open();
      const [hello] = take();
      expect(hello).toMatchObject({ type: "hello", source: "s" });
      expect(hello).not.toHaveProperty("seq"); // 0, the default
      epochs.add((hello as { epoch: number }).epoch);
      if (i % 2 === 0) session.close();
    }
    expect(epochs.size).toBe(20);
  });

  it("never repeats the previous epoch, even from a colliding random source", () => {
    const values = [7, 7, 7, 9];
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint32Array)[0] = values.shift() ?? 11;
        return array;
      });
    try {
      const { session } = harness({ source: "s" });
      session.open();
      expect(session.epoch).toBe(7);
      session.open();
      expect(session.epoch).toBe(9);
    } finally {
      spy.mockRestore();
    }
  });

  it("reopening while open drops the old epoch's pending records", async () => {
    const { session, take } = harness();
    session.open();
    const old = session.epoch;
    take();
    session.push(key(Key.W));
    session.open();
    await Promise.resolve();
    const out = take();
    expect(out.map((m) => m.type)).toEqual(["hello"]);
    expect(out.every((m) => m.epoch !== old)).toBe(true);
    expect(session.stats().dropped).toBe(1);
  });
});

describe("createInputSession: S3 sequencing", () => {
  it("numbers every message of an epoch +1 from the hello, all carrying the epoch", async () => {
    vi.useFakeTimers();
    const { session, take } = harness({ heartbeatMs: 1000, maxBytes: 128 });
    session.attach(fakeKeyboard(session));
    session.open();
    for (let i = 0; i < 6; i++) session.push(key(Key.A + i));
    session.flush();
    session.sync();
    session.reset("blur");
    vi.advanceTimersByTime(1000);
    session.close("done");
    const out = take();
    expect(out.map((m) => m.type)).toEqual([
      "hello",
      "sync",
      ...out.slice(2, -4).map(() => "events"),
      "sync",
      "reset",
      "heartbeat",
      "bye",
    ]);
    expect(out.length).toBeGreaterThan(6); // the events batch split
    expect(out.map((m) => m.seq ?? 0)).toEqual(out.map((_, i) => i));
    expect(new Set(out.map((m) => m.epoch)).size).toBe(1);
  });
});

describe("createInputSession: S4 size", () => {
  it("splits a large batch over consecutive seqs and continues after it", async () => {
    const { session, take, texts } = harness();
    session.open();
    take();
    const records = Array.from({ length: 150 }, (_, i) =>
      key(Key.A + (i % 26)),
    );
    for (const record of records) session.push(record);
    await Promise.resolve();
    expect(texts.every((t) => new TextEncoder().encode(t).length <= 4096)).toBe(
      true,
    );
    const out = take();
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.map((m) => m.seq)).toEqual(out.map((_, i) => i + 1));
    expect(out.flatMap((m) => (m.type === "events" ? m.events : []))).toEqual(
      records,
    );
    session.push(key(Key.Z));
    session.flush();
    expect(take()[0]?.seq).toBe(out.length + 1);
  });

  it("honours maxBytes", async () => {
    const { session, take, texts } = harness({ maxBytes: 200 });
    session.open();
    take();
    for (let i = 0; i < 10; i++) session.push(key(Key.A + i));
    await Promise.resolve();
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => t.length <= 200)).toBe(true);
  });

  it("rejects only a record that cannot fit or is invalid; the rest is sent", async () => {
    const onReject = vi.fn();
    const { session, take } = harness({ maxBytes: 160, onReject });
    session.open();
    take();
    const huge: InputRecord = {
      event: "action",
      action: "x".repeat(120),
      pressed: true,
    };
    const bad = {
      event: "joypad_button",
      pressed: "yes",
    } as unknown as InputRecord;
    session.push(key(Key.W));
    session.push(huge);
    session.push(bad);
    session.push(key(Key.W, false));
    await Promise.resolve();
    const events = take().flatMap((m) => (m.type === "events" ? m.events : []));
    expect(events).toEqual([key(Key.W), key(Key.W, false)]);
    expect(onReject).toHaveBeenCalledTimes(2);
    const codes = onReject.mock.calls.map(([error, refused]) => [
      error.code,
      refused,
    ]);
    // Validation failures surface before size failures.
    expect(codes).toEqual([
      ["invalid", bad],
      ["too-large", huge],
    ]);
    expect(session.stats().rejected).toBe(2);
  });

  it("rejects a record of a kind this version does not know", async () => {
    const onReject = vi.fn();
    const { session, take } = harness({ onReject });
    session.open();
    take();
    const future = {
      event: "future_kind",
      pressed: true,
    } as unknown as InputRecord;
    session.push(key(Key.W));
    session.push(future);
    session.push(key(Key.W, false));
    await Promise.resolve();
    const events = take().flatMap((m) => (m.type === "events" ? m.events : []));
    expect(events).toEqual([key(Key.W), key(Key.W, false)]);
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject.mock.calls[0]?.[0].code).toBe("invalid");
    expect(onReject.mock.calls[0]?.[1]).toBe(future);
  });

  it("rejects a sync that cannot fit and still sends the others", () => {
    const onReject = vi.fn();
    const { session, take } = harness({ maxBytes: 100, onReject });
    const big: InputHeldState = {
      scope: "keyboard",
      held: Array.from({ length: 10 }, (_, i) => key(Key.A + i)),
    };
    session.attach({ heldState: () => [big, { scope: "pointer", held: [] }] });
    session.open();
    const out = take();
    expect(out.map((m) => m.type)).toEqual(["hello", "sync"]);
    expect(out[1]).toMatchObject({ scope: "pointer", seq: 1 });
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject.mock.calls[0]?.[0].code).toBe("too-large");
    expect(onReject.mock.calls[0]?.[1]).toBe(big);
  });
});

describe("createInputSession: reset, bye and dispose", () => {
  it("reset flushes pending records first and keeps the session open", () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W, false));
    session.reset("hidden");
    expect(take()).toMatchObject([
      { type: "events", seq: 1 },
      { type: "reset", seq: 2, reason: "hidden" },
    ]);
    expect(session.state).toBe("open");
    session.reset();
    expect(take()).toEqual([{ type: "reset", epoch: session.epoch, seq: 3 }]);
  });

  it("an invalid reason throws before anything is sent", () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W));
    expect(() => session.reset("no spaces")).toThrow();
    expect(() => session.close("")).toThrow();
    expect(take()).toEqual([]);
    expect(session.state).toBe("open");
  });

  it("reset is a no-op while closed", () => {
    const { session, texts } = harness();
    session.reset("blur");
    session.sync();
    expect(texts).toEqual([]);
  });

  it("close(reason) sends pending records then bye; close() sends nothing", () => {
    const { session, take } = harness();
    session.open();
    take();
    session.push(key(Key.W, false));
    session.close("leave");
    expect(take()).toMatchObject([
      { type: "events" },
      { type: "bye", reason: "leave" },
    ]);
    expect(session.state).toBe("closed");
    session.open();
    take();
    session.push(key(Key.W));
    session.close();
    expect(take()).toEqual([]);
  });

  it("dispose sends bye, detaches captures and refuses to reopen", async () => {
    const { session, take } = harness();
    session.attach(fakeKeyboard(session));
    session.open();
    take();
    session.dispose();
    expect(take()).toMatchObject([{ type: "bye", reason: "dispose" }]);
    expect(session.state).toBe("disposed");
    expect(session.epoch).toBeUndefined();
    session.push(key(Key.W));
    session.dispose();
    await Promise.resolve();
    expect(take()).toEqual([]);
    expect(() => session.open()).toThrow(/disposed/);
    expect(() => session.attach(fakeKeyboard(session))).toThrow(/disposed/);
  });

  it("dispose while closed sends nothing", () => {
    const { session, texts } = harness();
    session.dispose("gone");
    expect(texts).toEqual([]);
    expect(session.state).toBe("disposed");
  });
});

describe("createInputSession: heartbeat", () => {
  it("sends a heartbeat after heartbeatMs of idle time only", async () => {
    vi.useFakeTimers();
    const { session, take } = harness({ heartbeatMs: 1000 });
    session.open();
    take();
    vi.advanceTimersByTime(999);
    expect(take()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(take()).toEqual([
      { type: "heartbeat", epoch: session.epoch, seq: 1 },
    ]);
    // Activity at +600 pushes the next heartbeat to +1600.
    vi.advanceTimersByTime(600);
    session.push(key(Key.W));
    await Promise.resolve();
    take();
    vi.advanceTimersByTime(999);
    expect(take()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(take().map((m) => m.type)).toEqual(["heartbeat"]);
    vi.advanceTimersByTime(3000);
    expect(take().map((m) => m.type)).toEqual([
      "heartbeat",
      "heartbeat",
      "heartbeat",
    ]);
  });

  it("stops on close and is off with heartbeatMs 0", () => {
    vi.useFakeTimers();
    const on = harness({ heartbeatMs: 1000 });
    on.session.open();
    on.session.close();
    on.take();
    vi.advanceTimersByTime(5000);
    expect(on.texts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const off = harness({ heartbeatMs: 0 });
    off.session.open();
    off.take();
    vi.advanceTimersByTime(5000);
    expect(off.texts).toEqual([]);
  });

  it("defaults to 1000 ms", () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const session = createInputSession({ send: (t) => texts.push(t) });
    session.open();
    vi.advanceTimersByTime(1000);
    expect(texts.map(decode).map((m) => m.type)).toEqual([
      "hello",
      "heartbeat",
    ]);
    session.dispose();
  });
});

describe("createInputSession: stats", () => {
  it("counts messages and UTF-8 bytes handed to send", () => {
    const { session, texts } = harness();
    session.open();
    session.push({ event: "action", action: "é", pressed: true });
    session.flush();
    const bytes = texts.reduce(
      (sum, t) => sum + new TextEncoder().encode(t).length,
      0,
    );
    expect(session.stats()).toEqual({
      messages: 2,
      bytes,
      dropped: 0,
      rejected: 0,
    });
  });
});

describe("createInputSession: with the real gamepad capture", () => {
  it("takes the capture's records as a sink and syncs its held state on open", () => {
    let frame: ((time: number) => void) | null = null;
    const pads: GamepadSnapshot[] = [
      { mapping: "standard", buttons: [1], axes: [] } as GamepadSnapshot,
    ];
    const { session, take } = harness();
    const capture = createGamepadCapture({
      sink: session,
      getGamepads: () => pads,
      requestAnimationFrame: (callback) => {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame: () => {
        frame = null;
      },
      events: null,
      visibility: null,
    });
    session.attach(capture);
    const step = () => {
      const run = frame;
      frame = null;
      run?.(16);
    };
    step(); // A pressed while closed: dropped
    expect(session.stats().dropped).toBeGreaterThan(0);
    session.open();
    expect(take()).toMatchObject([
      { type: "hello" },
      {
        type: "sync",
        scope: "joypad",
        device: 0,
        held: [{ event: "joypad_button", pressed: true }],
      },
    ]);
    pads[0] = {
      mapping: "standard",
      buttons: [0],
      axes: [],
    } as GamepadSnapshot;
    step();
    session.flush();
    expect(take()).toMatchObject([
      { type: "events", events: [{ event: "joypad_button", pressed: false }] },
    ]);
    capture.dispose();
  });
});
