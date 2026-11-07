// Drives every conformance/v1/codec vector through the TypeScript codec. The GDScript validator
// reads the same files and must agree on `ok`, `code`, `path` and `skipped`; `canonical`
// is the TypeScript encoder's output and is checked here only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeInputMessage,
  INPUT_MAX_MESSAGE_BYTES,
  InputEncodeError,
  type InputErrorCode,
  parseInputMessage,
} from "../src/index";

interface CodecVector {
  name: string;
  text: string;
  ok: boolean;
  code?: InputErrorCode;
  path?: string;
  skipped?: number;
  canonical?: string;
}

const dir = join(import.meta.dirname, "../conformance/v1/codec");
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort();
const suites = files.map((file) => {
  const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
    description: string;
    vectors: CodecVector[];
  };
  return { file, ...parsed };
});
const all = suites.flatMap((suite) => suite.vectors);
const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe("conformance/v1/codec", () => {
  it("covers every error code and the 4096/4097 boundary", () => {
    const codes = new Set(all.filter((v) => !v.ok).map((v) => v.code));
    expect([...codes].sort()).toEqual(
      [
        "bad-field",
        "malformed",
        "too-large",
        "too-many-events",
        "unknown-type",
        "unsupported-format",
      ].sort(),
    );
    const sizes = all.map((v) => utf8(v.text));
    expect(sizes).toContain(INPUT_MAX_MESSAGE_BYTES);
    expect(sizes).toContain(INPUT_MAX_MESSAGE_BYTES + 1);
  });

  it("keeps every vector but too-large within the byte limit", () => {
    for (const v of all)
      if (v.code !== "too-large")
        expect(utf8(v.text), v.name).toBeLessThanOrEqual(
          INPUT_MAX_MESSAGE_BYTES,
        );
  });

  for (const suite of suites)
    describe(suite.file, () => {
      it.each(
        suite.vectors.map((v) => [v.name, v] as const),
      )("%s", (_name, v) => {
        const result = parseInputMessage(v.text);
        if (!v.ok) {
          expect(result).toMatchObject({
            ok: false,
            code: v.code,
            ...(v.path === undefined ? {} : { path: v.path }),
          });
          if (v.path === undefined && !result.ok)
            expect(result.path).toBeUndefined();
          return;
        }
        if (!result.ok)
          throw new Error(`${result.code} ${result.path}: ${result.detail}`);
        expect(result.skipped).toBe(v.skipped ?? 0);
        const message = result.message;
        if (message.type === "events" && message.events.length === 0) {
          expect(() => encodeInputMessage(message)).toThrow(InputEncodeError);
          return;
        }
        const texts = encodeInputMessage(message);
        expect(texts).toHaveLength(1);
        if (v.canonical !== undefined) expect(texts[0]).toBe(v.canonical);
        // Canonical text is a fixed point: it parses cleanly and re-encodes to itself.
        // (The parsed message keeps explicit defaults; the canonical text omits them.)
        const again = parseInputMessage(texts[0]);
        expect(again).toMatchObject({ ok: true, skipped: 0 });
        if (again.ok) expect(encodeInputMessage(again.message)).toEqual(texts);
      });
    });
});
