#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8f checks (lib/gate8-float-checks.ts, G8f) on the committed
// fixtures/gate8-tex/expected-float.json, protocol/golden-8/float-quantize.json and synthetic
// hook and fixture lines, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8f.ts
//
// 1. The quantization rule: spot values, the half-float widening, every shared vector byte for
//    byte (rs-core's tests assert the same file).
// 2. expected-float.json is self-consistent: all eight float formats are named, every hdr entry
//    names a source_format, sizes agree with Godot's float pixel sizes.
// 3. oracleProblems: matching hashes pass; a wrong hash, a wrong format and a missing
//    source_format each fail. carriedFloatFormats lists only ok float payloads.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  carriedFloatFormats,
  FLOAT_FORMATS,
  type FloatExpected,
  type FloatLine,
  halfToNumber,
  oracleProblems,
  quantizeRgba8,
  quantizeUnorm8,
} from "../lib/gate8-float-checks";
import type { HookTextureLine } from "../lib/gate8-tex-checks";

const EXPERIMENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
function expect(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

// 1. the rule
expect(quantizeUnorm8(Number.NaN) === 0, "NaN -> 0");
expect(quantizeUnorm8(-0) === 0 && quantizeUnorm8(-3.5) === 0, "negatives -> 0");
expect(quantizeUnorm8(Number.POSITIVE_INFINITY) === 255 && quantizeUnorm8(65504) === 255, "above one -> 255");
expect(quantizeUnorm8(0.5) === 128, "0.5 rounds half up to 128");
expect(quantizeUnorm8(0.5 / 255) === 1, "half a step rounds up");
expect(quantizeUnorm8(0.2) === 51, "0.2 -> 51");
expect(halfToNumber(0x3c00) === 1 && halfToNumber(0xc000) === -2 && halfToNumber(0x7bff) === 65504, "half widening");
expect(halfToNumber(0x0001) === 2 ** -24 && Number.isNaN(halfToNumber(0x7e00)), "half subnormal and NaN");
expect(quantizeRgba8("RGBE9995", 1, 1, new Uint8Array(4)) === null, "no conversion for an unsized format");
{
  const vectors = JSON.parse(
    await readFile(join(EXPERIMENT_DIR, "protocol", "golden-8", "float-quantize.json"), "utf8"),
  ) as { vectors: { name: string; format: string; width: number; height: number; data_hex: string; rgba_hex: string }[] };
  expect(vectors.vectors.length === 8, "one shared vector per float format");
  const seen = new Set<string>();
  for (const v of vectors.vectors) {
    seen.add(v.format);
    const got = quantizeRgba8(v.format, v.width, v.height, new Uint8Array(Buffer.from(v.data_hex, "hex")));
    expect(got !== null && Buffer.from(got).toString("hex") === v.rgba_hex, `vector ${v.name}`);
  }
  expect(seen.size === 8, "the vectors cover all eight formats");
}

// 2. expected-float.json
const expected = JSON.parse(
  await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-tex", "expected-float.json"), "utf8"),
) as FloatExpected;
{
  const carried = new Set(Object.values(expected.textures).map((t) => t.format));
  for (const f of expected.formats) expect(carried.has(f), `a fixture texture carries ${f}`);
  expect(expected.formats.length === 8 && expected.formats.every((f) => f in FLOAT_FORMATS), "eight float formats");
  for (const [name, t] of Object.entries(expected.textures)) {
    expect(t.format in FLOAT_FORMATS, `${name}: ${t.format} is a float format`);
    if (t.kind === "hdr") expect(typeof t.source_format === "string", `${name}: names its source_format`);
    expect(t.width <= 256, `${name}: at most 256 px wide (STS2's curve textures)`);
  }
  for (const n of expected.perturbed) expect(expected.textures[n]?.kind === "hdr", `${n}: perturbed entries are host decodes`);
}

// 3. the oracle
const fx = (over: Partial<FloatLine> = {}): FloatLine => ({
  step: 0, frame: 1, name: "curve_rf", kind: "curve", source: "ctex", source_format: null, format: "RF",
  width: 256, height: 1, mipmaps: false, data_bytes: 1024, payload_sha256: "a".repeat(64), ...over,
});
const hk = (over: Partial<HookTextureLine> = {}): HookTextureLine => ({
  frame: 1, thread: "main", op: "texture_2d_create", id: 1, status: "ok", reason: null, format: "RF",
  width: 256, height: 1, mipmaps: false, data_bytes: 1024, payload_bytes: 1100, hash: "a".repeat(64),
  copy_ns: 1, hash_ns: 1, decode_ns: null, ...over,
});
expect(oracleProblems([fx()], [hk()]).problems.length === 0, "equal hashes agree");
expect(oracleProblems([fx()], [hk({ hash: "b".repeat(64) })]).problems.length === 1, "a different hash fails");
expect(oracleProblems([fx()], [hk({ format: "RGBF" })]).problems.length === 1, "a different format fails");
expect(oracleProblems([fx({ source_format: "BPTC_RGBFU" })], [hk()]).problems.length === 1, "a missing source_format fails");
expect(oracleProblems([fx({ source_format: "BPTC_RGBFU" })], [hk({ source_format: "BPTC_RGBFU" })]).problems.length === 0, "a matching source_format passes");
expect(oracleProblems([fx()], [hk({ status: "unsupported" })]).problems.length === 1, "a refused hook line is no payload");
expect(
  carriedFloatFormats([hk(), hk({ format: "RGBAH" }), hk({ format: "RGBA8" }), hk({ format: "RH", status: "unsupported" })]).join() === "RF,RGBAH",
  "carriedFloatFormats lists ok float payloads only",
);

if (failures > 0) {
  console.error(`self-test-gate8f: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate8f: PASS");
