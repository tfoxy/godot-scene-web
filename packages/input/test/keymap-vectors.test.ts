// @vitest-environment node
//
// Drives every conformance/v1/keymap vector through the DOM-free key map (docs/input.md
// "Keyboard"). Runs in Node: the key map must not touch `window`/`document`.
//
// A vector is `{name, dom, layout?, press?, expect}`. `dom` is the DOM KeyboardEvent's fields
// (`altGraph` = `getModifierState("AltGraph")`), `layout` a `navigator.keyboard.getLayoutMap()`
// snapshot, `expect` the key record or `null` (not forwarded). With `press`, `dom` is the keyup of
// a key whose keydown `press` latched, and `expect` is the release a capture sends: the press
// record replayed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeInputMessage,
  type KeyRecord,
  parseInputMessage,
} from "../src/index";
import {
  type DomKeyEvent,
  keyRecordFromDom,
  releaseKeyRecord,
} from "../src/keymap";

interface KeymapVector {
  name: string;
  dom: DomKeyEvent;
  layout?: Record<string, string>;
  press?: DomKeyEvent;
  expect: KeyRecord | null;
}

const dir = join(import.meta.dirname, "../conformance/v1/keymap");
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort();
const suites = files.map((file) => {
  const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
    description: string;
    vectors: KeymapVector[];
  };
  return { file, ...parsed };
});

describe("conformance/v1/keymap", () => {
  it("covers the layouts and cases the plan names", () => {
    expect(files).toEqual(
      [
        "altgr.json",
        "azerty.json",
        "dead.json",
        "ime.json",
        "modifiers.json",
        "numpad.json",
        "ru.json",
        "shift-digit.json",
        "us.json",
      ].sort(),
    );
    const all = suites.flatMap((suite) => suite.vectors);
    expect(new Set(all.map((v) => v.name)).size).toBe(all.length);
    expect(all.some((v) => v.expect === null)).toBe(true);
    expect(all.some((v) => v.press !== undefined)).toBe(true);
    expect(all.some((v) => v.layout !== undefined)).toBe(true);
  });

  for (const suite of suites)
    describe(suite.file, () => {
      for (const v of suite.vectors)
        it(v.name, () => {
          const layout = v.layout ? new Map(Object.entries(v.layout)) : null;
          let actual: KeyRecord | null;
          if (v.press) {
            expect(v.dom.type).toBe("keyup");
            expect(v.dom.code).toBe(v.press.code);
            const press = keyRecordFromDom(v.press, { layout });
            expect(press?.pressed).toBe(true);
            actual = press && releaseKeyRecord(press);
          } else actual = keyRecordFromDom(v.dom, { layout });
          expect(actual).toEqual(v.expect);
          if (v.expect === null) return;
          // The expected record is valid gsw-input/1 and already canonical: defaults are omitted,
          // so it survives encode -> parse unchanged.
          const [text] = encodeInputMessage({
            type: "events",
            epoch: 1,
            seq: 1,
            events: [v.expect],
          });
          const parsed = parseInputMessage(text);
          expect(parsed.ok).toBe(true);
          if (parsed.ok && parsed.message.type === "events")
            expect(parsed.message.events[0]).toEqual(v.expect);
        });
    });
});
