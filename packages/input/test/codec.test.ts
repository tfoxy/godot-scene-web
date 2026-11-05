import { describe, expect, it } from "vitest";
import {
  encodeInputMessage,
  INPUT_MAX_EVENTS,
  INPUT_MAX_MESSAGE_BYTES,
  InputEncodeError,
  type InputEventsMessage,
  type InputRecord,
  type KeyRecord,
  parseInputMessage,
  validateInputMessage,
} from "../src/index";

const utf8 = (text: string) => new TextEncoder().encode(text).length;
const key = (keycode: number, pressed = true): KeyRecord => ({
  event: "key",
  physical_keycode: keycode,
  keycode,
  key_label: keycode,
  pressed,
  code: "KeyW",
});
const events = (records: InputRecord[], seq = 5): InputEventsMessage => ({
  type: "events",
  epoch: 99,
  seq,
  events: records,
});

function decodeAll(texts: string[]) {
  return texts.map((text) => {
    const result = parseInputMessage(text);
    if (!result.ok || result.message.type !== "events")
      throw new Error(`not an events message: ${text}`);
    return result.message;
  });
}

describe("encodeInputMessage", () => {
  it("writes canonical field order regardless of input order and omits defaults", () => {
    const [text] = encodeInputMessage(
      events([
        {
          shift_pressed: false,
          position: [1, 2],
          pressed: true,
          button_index: 1,
          event: "mouse_button",
          factor: 1,
          button_mask: 1,
        } as InputRecord,
      ]),
    );
    expect(text).toBe(
      '{"type":"events","epoch":99,"seq":5,"events":[{"event":"mouse_button","button_index":1,"pressed":true,"position":[1,2],"button_mask":1}]}',
    );
  });

  it("drops members the format does not define", () => {
    const record = { ...key(87), extra: 1 } as InputRecord;
    const [text] = encodeInputMessage(events([record]));
    expect(text).not.toContain("extra");
  });

  it("returns one text for a batch that fits", () => {
    const texts = encodeInputMessage(events([key(87), key(87, false)]));
    expect(texts).toHaveLength(1);
  });

  it("splits a batch by byte budget into consecutive seqs, in order, every piece valid", () => {
    const records = Array.from({ length: 200 }, (_, i) =>
      key(65 + (i % 26), i % 2 === 0),
    );
    const texts = encodeInputMessage(events(records, 40));
    expect(texts.length).toBeGreaterThan(1);
    const decoded = decodeAll(texts);
    expect(decoded.map((m) => m.seq)).toEqual(texts.map((_, i) => 40 + i));
    expect(decoded.flatMap((m) => m.events)).toEqual(records);
    for (const text of texts)
      expect(utf8(text)).toBeLessThanOrEqual(INPUT_MAX_MESSAGE_BYTES);
    for (const m of decoded)
      expect(m.events.length).toBeLessThanOrEqual(INPUT_MAX_EVENTS);
  });

  it("splits at INPUT_MAX_EVENTS even when bytes would allow more", () => {
    const tiny: InputRecord = { event: "joypad_button", pressed: true };
    const texts = encodeInputMessage(events(Array(130).fill(tiny)));
    expect(decodeAll(texts).map((m) => m.events.length)).toEqual([64, 64, 2]);
  });

  it("honours a smaller maxBytes", () => {
    const texts = encodeInputMessage(events([key(87), key(88), key(89)]), {
      maxBytes: 256,
    });
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(utf8(text)).toBeLessThanOrEqual(256);
  });

  it("counts UTF-8 bytes, not UTF-16 units, when packing", () => {
    const record: InputRecord = {
      event: "action",
      action: "ジ".repeat(42), // 126 bytes, 42 units
      pressed: true,
    };
    const texts = encodeInputMessage(events(Array(40).fill(record)));
    for (const text of texts)
      expect(utf8(text)).toBeLessThanOrEqual(INPUT_MAX_MESSAGE_BYTES);
    expect(texts.length).toBeGreaterThan(1);
  });

  it("throws too-large when one record cannot fit the budget", () => {
    const record: InputRecord = {
      event: "target",
      handle: 1,
      path: "a".repeat(1024),
    };
    expect(() =>
      encodeInputMessage(events([record]), { maxBytes: 512 }),
    ).toThrow(
      expect.objectContaining({ code: "too-large", path: "events[0]" }),
    );
  });

  it("throws too-large for a sync that does not fit, and never splits it", () => {
    const held: InputRecord[] = Array.from({ length: 64 }, (_, i) => ({
      event: "target",
      handle: i + 1,
      path: "p".repeat(100),
    }));
    expect(() =>
      encodeInputMessage({
        type: "sync",
        epoch: 1,
        seq: 1,
        scope: "pointer",
        held,
      }),
    ).toThrow(expect.objectContaining({ code: "too-large" }));
  });

  it("throws invalid with the validator's path", () => {
    const error = (() => {
      try {
        encodeInputMessage(events([key(87), { ...key(88), location: 5 }]));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(InputEncodeError);
    expect(error).toMatchObject({
      code: "invalid",
      path: "events[1].location",
    });
  });

  it("throws invalid for an invalid record past the first 64", () => {
    const records: InputRecord[] = Array(70).fill({
      event: "joypad_button",
      pressed: true,
    });
    records[68] = { event: "joypad_button", device: 40, pressed: true };
    expect(() => encodeInputMessage(events(records))).toThrow(
      expect.objectContaining({ code: "invalid", path: "events[68].device" }),
    );
  });

  it("throws invalid for an unknown record kind", () => {
    const record = { event: "midi" } as unknown as InputRecord;
    expect(() => encodeInputMessage(events([record]))).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
  });

  it("refuses a maxBytes outside 64..4096", () => {
    expect(() =>
      encodeInputMessage(events([key(87)]), { maxBytes: 5000 }),
    ).toThrow(RangeError);
    expect(() =>
      encodeInputMessage(events([key(87)]), { maxBytes: 10 }),
    ).toThrow(RangeError);
  });

  it("encodes hello, sync, reset, bye and heartbeat canonically", () => {
    expect(
      encodeInputMessage({
        type: "hello",
        format: "gsw-input/1",
        source: "s1",
        epoch: 3,
        seq: 0,
        kinds: ["key"],
      }),
    ).toEqual([
      '{"type":"hello","format":"gsw-input/1","source":"s1","epoch":3,"kinds":["key"]}',
    ]);
    expect(
      encodeInputMessage({
        type: "sync",
        epoch: 3,
        seq: 1,
        scope: "joypad",
        device: 2,
        held: [
          { event: "joypad_button", device: 2, button_index: 0, pressed: true },
        ],
      }),
    ).toEqual([
      '{"type":"sync","epoch":3,"seq":1,"scope":"joypad","device":2,"held":[{"event":"joypad_button","device":2,"pressed":true}]}',
    ]);
    expect(
      encodeInputMessage({ type: "reset", epoch: 3, seq: 2, reason: "hidden" }),
    ).toEqual(['{"type":"reset","epoch":3,"seq":2,"reason":"hidden"}']);
    expect(encodeInputMessage({ type: "bye", epoch: 3, seq: 3 })).toEqual([
      '{"type":"bye","epoch":3,"seq":3}',
    ]);
    expect(encodeInputMessage({ type: "heartbeat", epoch: 3, seq: 4 })).toEqual(
      ['{"type":"heartbeat","epoch":3,"seq":4}'],
    );
  });
});

describe("parseInputMessage / validateInputMessage", () => {
  it("returns a fresh object holding only known members", () => {
    const text =
      '{"type":"events","epoch":1,"seq":1,"__proto__":{"polluted":true},"events":[{"event":"key","keycode":87,"pressed":true,"constructor":1}]}';
    const result = parseInputMessage(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.message)).toEqual([
      "type",
      "epoch",
      "seq",
      "events",
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (result.message.type === "events")
      expect(Object.keys(result.message.events[0])).toEqual([
        "event",
        "keycode",
        "pressed",
      ]);
  });

  it("validates a parsed value without a byte check", () => {
    expect(
      validateInputMessage({ type: "heartbeat", epoch: 1, seq: 2 }),
    ).toEqual({
      ok: true,
      message: { type: "heartbeat", epoch: 1, seq: 2 },
      skipped: 0,
    });
    expect(validateInputMessage([])).toMatchObject({
      ok: false,
      code: "malformed",
    });
  });

  it("copies vectors so the result does not alias the input", () => {
    const position: [number, number] = [1, 2];
    const result = validateInputMessage(
      events([{ event: "mouse_motion", position }]),
    );
    if (!result.ok || result.message.type !== "events")
      throw new Error("expected ok");
    const record = result.message.events[0];
    if (record.event !== "mouse_motion") throw new Error("expected motion");
    expect(record.position).toEqual([1, 2]);
    expect(record.position).not.toBe(position);
  });
});
