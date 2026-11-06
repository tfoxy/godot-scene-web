// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Key, KeyLocation } from "../src/index";
import {
  keyLocationFromCode,
  keyRecordFromDom,
  physicalKeycodeFromCode,
  releaseKeyRecord,
} from "../src/keymap";

// The port is checked against the engine file itself when the sibling checkout is present.
const domKeys = join(
  import.meta.dirname,
  "../../../../godot-4.5.1-stable/platform/web/dom_keys.inc",
);
const godotName = (name: string) => (name === "KEY_DELETE" ? "DELETE" : name);

describe.skipIf(!existsSync(domKeys))("dom_keys.inc port", () => {
  const source = existsSync(domKeys) ? readFileSync(domKeys, "utf8") : "";
  const [scancodeFn, locationFn] = source.split("KeyLocation dom_code2godot");
  const entries = (text: string, commented: boolean) =>
    [
      ...text.matchAll(
        /^\s*(\/\/)?DOM2GODOT\("([A-Za-z0-9]+)", ([A-Z0-9_]+)\);/gm,
      ),
    ]
      .filter((m) => (m[1] !== undefined) === commented)
      .map((m) => [m[2], m[3]] as const);

  it("maps every Godot code to the same Key", () => {
    const mapped = entries(scancodeFn, false);
    expect(mapped.length).toBe(139);
    for (const [code, name] of mapped)
      expect(physicalKeycodeFromCode(code), code).toBe(
        Key[godotName(name) as keyof typeof Key],
      );
  });

  it("leaves Godot's commented-out (UNKNOWN) codes unmapped", () => {
    const unknown = entries(scancodeFn, true);
    expect(unknown.map(([code]) => code)).toContain("IntlRo");
    for (const [code] of unknown)
      expect(physicalKeycodeFromCode(code), code).toBe(0);
  });

  it("ports the location table", () => {
    const located = entries(locationFn, false);
    expect(located).toHaveLength(10);
    for (const [code, name] of located)
      expect(keyLocationFromCode(code), code).toBe(
        KeyLocation[name as keyof typeof KeyLocation],
      );
    expect(keyLocationFromCode("Numpad1")).toBe(KeyLocation.UNSPECIFIED);
  });
});

describe("keyRecordFromDom", () => {
  it("counts code points, not UTF-16 units", () => {
    const record = keyRecordFromDom({
      type: "keydown",
      code: "KeyA",
      key: "\u{1F600}",
    });
    expect(record).toMatchObject({
      keycode: Key.A,
      key_label: 0x1f600,
      unicode: 0x1f600,
    });
    // Two code points is a name-like string, not a character.
    expect(
      keyRecordFromDom({ type: "keydown", code: "KeyA", key: "ab" }),
    ).toMatchObject({ keycode: Key.A, key_label: Key.A });
  });

  it("keeps a single code point whose uppercase is two (ß)", () => {
    expect(
      keyRecordFromDom({ type: "keydown", code: "Minus", key: "ß" }),
    ).toMatchObject({ keycode: Key.MINUS, key_label: 0xdf, unicode: 0xdf });
  });

  it("never sets unicode for control characters", () => {
    expect(
      keyRecordFromDom({ type: "keydown", code: "KeyA", key: "\u007f" }),
    ).not.toHaveProperty("unicode");
  });

  it("does not take an IME flag on a keyup as a reason to drop it", () => {
    expect(
      keyRecordFromDom({
        type: "keyup",
        code: "KeyA",
        key: "Process",
        keyCode: 229,
      }),
    ).toMatchObject({
      physical_keycode: Key.A,
      keycode: Key.A,
      pressed: false,
    });
  });
});

describe("releaseKeyRecord", () => {
  it("replays the press without echo and leaves the press untouched", () => {
    const press = keyRecordFromDom({
      type: "keydown",
      code: "Digit1",
      key: "!",
      shiftKey: true,
      repeat: true,
    });
    expect(press).not.toBeNull();
    if (!press) return;
    const release = releaseKeyRecord(press);
    expect(release).toEqual({
      event: "key",
      physical_keycode: Key.KEY_1,
      keycode: Key.KEY_1,
      key_label: 0x21,
      unicode: 0x21,
      pressed: false,
      shift_pressed: true,
      code: "Digit1",
    });
    expect(press.pressed).toBe(true);
    expect(press.echo).toBe(true);
  });
});
