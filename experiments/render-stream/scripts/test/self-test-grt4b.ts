// GRT4b: the checker speed-ups change no verdict (results/grt.md "Part 4b"). Pure and synthetic:
//   1. jsonKeyEqual(a, b) === (JSON.stringify(a, negZero) === JSON.stringify(b, negZero)) over
//      fuzzed values (-0 and "-0", NaN, undefined, functions, holes, key order, toJSON);
//   2. node:crypto's SHA-256 (lib/node-hash.ts) equals the decoders' pure one;
//   3. inside withRecordMemo, validateRecording, resolveRecording, decodeRecording and
//      summarizeRecording return what they return outside it, on every golden recording, and the
//      memo really shares one decode;
//   4. meshActions' cell grid rasterizes fuzzed meshes (slivers, bands, scissors, textures)
//      bit-identically to the full per-pixel scan (setMeshGrid(false)).
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-grt4b.ts

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { summarizeRecording } from "../lib/gate0-checks";
import type { Gate5Item, MeshShape } from "../lib/gate5-expected";
import { rasterizeItems, setMeshGrid } from "../lib/geometry-raster";
import { jsonKeyEqual, negZeroReplacer } from "../lib/json-key-equal";
import { nodeSha256Hex } from "../lib/node-hash";
import {
  decodeRecord,
  decodeRecording,
  internItems,
  type ResolvedItem,
  resolveRecording,
  sameValueDeep,
  setHashImpl,
  splitRecords,
  statesEqual,
  validateRecording,
  wireVersionOf,
  withRecordMemo,
} from "../lib/render-stream-2";
import { sha256Hex } from "../lib/sha256";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
  if (!ok) fails++;
};

// A small deterministic PRNG (mulberry32), so a failure reproduces.
let seed = 0x4b475254;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

// --- 1. jsonKeyEqual ---------------------------------------------------------------------------
const LEAVES: unknown[] = [
  0,
  -0,
  1,
  -1,
  0.1,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "-0",
  "0",
  "",
  'a"b',
  " ",
  true,
  false,
  null,
  undefined,
  () => 1,
  Symbol("s"),
];
const randValue = (depth: number): unknown => {
  const r = rand();
  if (depth <= 0 || r < 0.45) return pick(LEAVES);
  if (r < 0.7) {
    const n = Math.floor(rand() * 4);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(randValue(depth - 1));
    if (rand() < 0.1) out.length += 1; // a hole
    return out;
  }
  if (r < 0.75) return new Date(0);
  const o: Record<string, unknown> = {};
  for (const k of ["b", "a", "1", "-0", "c"])
    if (rand() < 0.5) o[k] = randValue(depth - 1);
  return o;
};
// Small edits make equal and nearly-equal pairs common.
const mutate = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    const c = [...v];
    if (c.length > 0) c[Math.floor(rand() * c.length)] = mutate(c[0]);
    return c;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const keys = Object.keys(v);
    const o: Record<string, unknown> = {};
    // Same keys, sometimes in another insertion order.
    for (const k of rand() < 0.3 ? [...keys].reverse() : keys)
      o[k] =
        rand() < 0.2
          ? mutate((v as Record<string, unknown>)[k])
          : (v as Record<string, unknown>)[k];
    return o;
  }
  return rand() < 0.5 ? v : pick(LEAVES);
};
// A deep copy that keeps -0, NaN and undefined, which JSON would not (functions, symbols and
// Dates are kept by reference).
const structuredCloneSafe = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(structuredCloneSafe);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v))
      o[k] = structuredCloneSafe((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
};
{
  let pairs = 0;
  let equal = 0;
  let wrong = 0;
  let firstWrong = "";
  for (let i = 0; i < 20000; i++) {
    const a = randValue(4);
    const b = rand() < 0.5 ? mutate(a) : randValue(4);
    const want =
      JSON.stringify(a, negZeroReplacer) === JSON.stringify(b, negZeroReplacer);
    const got = jsonKeyEqual(a, b);
    pairs++;
    if (want) equal++;
    if (got !== want) {
      wrong++;
      firstWrong ||= `${JSON.stringify(a, negZeroReplacer)} vs ${JSON.stringify(b, negZeroReplacer)}: want ${want}`;
    }
  }
  check(
    `jsonKeyEqual agrees with the stringify comparison on ${pairs} fuzzed pairs (${equal} equal)`,
    wrong === 0 && equal > 1000,
    firstWrong,
  );
  check(
    'jsonKeyEqual: -0 is not 0, -0 is the string "-0", key order counts',
    !jsonKeyEqual({ x: -0 }, { x: 0 }) &&
      jsonKeyEqual({ x: -0 }, { x: "-0" }) &&
      !jsonKeyEqual({ a: 1, b: 2 }, { b: 2, a: 1 }) &&
      jsonKeyEqual([undefined], [null]) &&
      jsonKeyEqual({ a: undefined }, {}),
  );
}

// --- 1a. statesEqual (render-stream-2.ts) against the string comparison it replaced -------------
{
  const froundDeepRef = (value: unknown): unknown => {
    if (typeof value === "number") return Math.fround(value);
    if (Array.isArray(value)) return value.map(froundDeepRef);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = froundDeepRef(v);
      return out;
    }
    return value;
  };
  const F32 = [
    0.1,
    Math.fround(0.1),
    1e39,
    -1e39,
    3.4028235e38,
    1 + 2 ** -30,
    1,
  ];
  let wrong = 0;
  let equal = 0;
  let first = "";
  for (let i = 0; i < 20000; i++) {
    const a = rand() < 0.2 ? pick(F32) : randValue(4);
    const b =
      rand() < 0.2
        ? pick(F32)
        : rand() < 0.5
          ? mutate(a)
          : rand() < 0.5
            ? structuredCloneSafe(a)
            : randValue(4);
    const want =
      JSON.stringify(froundDeepRef(a)) === JSON.stringify(froundDeepRef(b));
    const got = statesEqual(a, b);
    if (want) equal++;
    if (got !== want) {
      wrong++;
      first ||= `${String(JSON.stringify(a, negZeroReplacer))} vs ${String(JSON.stringify(b, negZeroReplacer))}: want ${want}`;
    }
  }
  check(
    `statesEqual agrees with JSON.stringify(froundDeep(.)) on 20000 fuzzed pairs (${equal} equal)`,
    wrong === 0 && equal > 1000,
    first,
  );
  check(
    "statesEqual: 0.1 is fround(0.1), -0 is 0, a Date is {}, NaN is Infinity's null",
    statesEqual([0.1], [Math.fround(0.1)]) &&
      statesEqual({ a: -0 }, { a: 0 }) &&
      statesEqual(new Date(5), {}) &&
      statesEqual([Number.NaN], [1e39]) &&
      !statesEqual([1], [1 + 2 ** -20]),
  );
}

// --- 1b. sameValueDeep / internItems -----------------------------------------------------------
{
  // The reference: node's strict deep equality plus the same key order all the way down.
  const keyOrder = (a: unknown, b: unknown): boolean => {
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return true;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.join("\u0000") === kb.join("\u0000") &&
      ka.every((k) =>
        keyOrder(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  };
  let wrong = 0;
  let equal = 0;
  let first = "";
  for (let i = 0; i < 20000; i++) {
    const a = randValue(4);
    const b =
      rand() < 0.5
        ? mutate(a)
        : rand() < 0.5
          ? structuredCloneSafe(a)
          : randValue(4);
    const want = isDeepStrictEqual(a, b) && keyOrder(a, b);
    const got = sameValueDeep(a, b);
    if (want) equal++;
    if (got !== want) {
      wrong++;
      first ||= `${String(JSON.stringify(a, negZeroReplacer))} vs ${String(JSON.stringify(b, negZeroReplacer))}: want ${want}`;
    }
  }
  check(
    `sameValueDeep agrees with isDeepStrictEqual + key order on 20000 fuzzed pairs (${equal} equal)`,
    wrong === 0 && equal > 1000,
    first,
  );
  // internItems: the same JSON, previous objects reused exactly where they are the same value.
  const item = (id: number, x: number) =>
    ({
      id,
      xform: [1, 0, 0, 1, x, -0],
      commands: [{ op: "rect", f: [x] }],
    }) as unknown as ResolvedItem;
  const prev = new Map<number, ResolvedItem>();
  const t1 = internItems([item(1, 0), item(2, 0), item(3, 0)], prev);
  const t2 = internItems([item(1, 0), item(2, 5), item(3, -0)], prev);
  check(
    "internItems reuses an unchanged item, keeps a changed one, tells -0 from 0",
    t2[0] === t1[0] &&
      t2[1] !== t1[1] &&
      t2[2] !== t1[2] &&
      JSON.stringify(t2) ===
        JSON.stringify([item(1, 0), item(2, 5), item(3, -0)]),
  );
}

// --- 2. node:crypto SHA-256 --------------------------------------------------------------------
{
  let same = true;
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 65537]) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
    same &&= sha256Hex(b) === nodeSha256Hex(b);
    same &&= nodeSha256Hex(b) === createHash("sha256").update(b).digest("hex");
  }
  check(
    "node:crypto SHA-256 equals the pure one at every block boundary",
    same,
  );
}

// --- 3. withRecordMemo -------------------------------------------------------------------------
{
  const PROTOCOL = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "protocol",
  );
  const files = readdirSync(PROTOCOL)
    .filter((d) => /^golden-\d+$/.test(d))
    .flatMap((d) =>
      readdirSync(join(PROTOCOL, d))
        .filter((f) => /\.rs[2-7]$/.test(f))
        .map((f) => join(PROTOCOL, d, f)),
    );
  const invalid = readdirSync(PROTOCOL)
    .filter((d) => /^golden-\d+$/.test(d))
    .flatMap((d) => {
      const dir = join(PROTOCOL, d, "invalid");
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => /\.rs[2-7]$/.test(f))
            .map((f) => join(dir, f))
        : [];
    });
  const json = (f: () => unknown): string => {
    try {
      return JSON.stringify(f());
    } catch (e) {
      return `threw ${(e as Error).message}`;
    }
  };
  let compared = 0;
  const differ: string[] = [];
  for (const hashImpl of [sha256Hex, nodeSha256Hex]) {
    setHashImpl(hashImpl);
    for (const path of files) {
      const data = new Uint8Array(readFileSync(path));
      const v = wireVersionOf(data);
      const plain = [
        json(() => validateRecording(data, v)),
        json(() => resolveRecording(data, v)),
        json(() => decodeRecording(data, v)),
        json(() => summarizeRecording(path, data)),
      ];
      const memo = withRecordMemo(data, () => [
        json(() => validateRecording(data, v)),
        json(() => resolveRecording(data, v)),
        json(() => decodeRecording(data, v)),
        json(() => summarizeRecording(path, data)),
      ]);
      compared++;
      plain.forEach((p, i) => {
        if (p !== memo[i]) differ.push(`${path} #${i}`);
      });
    }
  }
  check(
    `withRecordMemo changes no result (${compared} recordings x 4 readers, both hashes)`,
    differ.length === 0 && compared >= 20,
    differ.slice(0, 3).join("; "),
  );
  const data = new Uint8Array(
    readFileSync(files.find((f) => f.endsWith("full.rs6")) ?? files[0]),
  );
  const raw = splitRecords(data, wireVersionOf(data)).records[1];
  const dec = () => decodeRecord(raw, wireVersionOf(data));
  const pair = (): [unknown, unknown] => [dec(), dec()];
  const inside = withRecordMemo(data, pair);
  const outside = pair();
  const twice = withRecordMemo(data, () => [dec(), dec(), dec()], 2);
  check(
    "the memo shares one decode inside its scope, none outside it, and drops a record after `uses` reads",
    inside[0] === inside[1] &&
      outside[0] !== outside[1] &&
      twice[0] === twice[1] &&
      twice[2] !== twice[0],
  );
  // summarizeRecording drives the validator record by record: its errors are validateRecording's.
  const bad: string[] = [];
  for (const path of [...files, ...invalid]) {
    const d = new Uint8Array(readFileSync(path));
    const v = wireVersionOf(d);
    if (
      JSON.stringify(summarizeRecording(path, d).errors) !==
      JSON.stringify(validateRecording(d, v))
    )
      bad.push(path);
  }
  check(
    `summarizeRecording's errors equal validateRecording's on ${files.length + invalid.length} recordings (${invalid.length} invalid)`,
    bad.length === 0 && invalid.length >= 20,
    bad.slice(0, 3).join("; "),
  );
}

// --- 4. meshActions' grid ----------------------------------------------------------------------
{
  const W = 48;
  const H = 40;
  const fingerprint = (r: ReturnType<typeof rasterizeItems>): string =>
    createHash("sha256")
      .update(r.rgba)
      .update(r.exact)
      .update(r.delta)
      .update(r.band)
      .update(r.thin)
      .update(
        JSON.stringify(
          r.shapes.map((s) => ({ ...s, underlay: Array.from(s.underlay) })),
        ),
      )
      .digest("hex");
  let scenes = 0;
  let painted = 0;
  const differ: number[] = [];
  for (let n = 0; n < 300; n++) {
    const shapes: MeshShape[] = [];
    for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) {
      const nv = 3 + Math.floor(rand() * 8);
      const vertices: [number, number][] = [];
      for (let i = 0; i < nv; i++) {
        // Slivers and shared edges: some vertices land on a coarse grid, some nearly collinear.
        const coarse = rand() < 0.4;
        vertices.push([
          coarse ? Math.round(rand() * 12) * 4 : rand() * (W + 8) - 4,
          coarse ? Math.round(rand() * 10) * 4 : rand() * (H + 8) - 4,
        ]);
      }
      if (rand() < 0.2)
        vertices.push([vertices[0][0] + 1e-4, vertices[0][1] + 30]);
      if (rand() < 0.2) vertices.push([vertices[1][0], vertices[1][1]]); // a welded duplicate
      const triangles: number[][] = [];
      for (let t = 0; t < 1 + Math.floor(rand() * 8); t++)
        triangles.push(
          [0, 1, 2].map(() => Math.floor(rand() * vertices.length)),
        );
      const perVertex = rand() < 0.5;
      shapes.push({
        name: `m${k}`,
        kind: "mesh",
        vertices,
        triangles,
        colors: perVertex
          ? vertices.map(() => [
              rand(),
              rand(),
              rand(),
              rand() < 0.5 ? 1 : rand(),
            ])
          : [[rand(), rand(), rand(), 1]],
        ...(rand() < 0.3 ? { band_px: pick([0.5, 1, 2.5]) } : {}),
        ...(rand() < 0.3
          ? {
              texture: "t",
              uvs: vertices.map(() => [rand(), rand()] as [number, number]),
            }
          : {}),
      });
    }
    const items: Gate5Item[] = [
      {
        name: "i",
        region: "r",
        xform:
          rand() < 0.5
            ? [1, 0, 0, 1, 0, 0]
            : [
                Math.cos(n),
                Math.sin(n),
                -Math.sin(n),
                Math.cos(n),
                W / 2,
                H / 4,
              ],
        clip_px: rand() < 0.3 ? [4, 3, 40, 33] : null,
        ops: "o",
      },
    ];
    const scene = {
      viewport: [W, H],
      clear: [10, 20, 30, 255] as [number, number, number, number],
      textures: {
        t: {
          width: 2,
          height: 2,
          rgba8_hex: "ff0000ff00ff00ff0000ffffffffff80",
        },
      },
      opLists: { o: shapes },
      items,
      exactEdgePx: pick([1 / 16, 0.25]),
    } as unknown as Parameters<typeof rasterizeItems>[0];
    let a: string;
    let b: string;
    try {
      setMeshGrid(true);
      const r = rasterizeItems(scene);
      painted += r.exact.reduce((s, v) => s + v, 0);
      a = fingerprint(r);
    } catch (e) {
      a = `threw ${(e as Error).message}`;
    }
    try {
      setMeshGrid(false);
      b = fingerprint(rasterizeItems(scene));
    } catch (e) {
      b = `threw ${(e as Error).message}`;
    } finally {
      setMeshGrid(true);
    }
    scenes++;
    if (a !== b) differ.push(n);
  }
  check(
    `the mesh cell grid rasterizes ${scenes} fuzzed scenes exactly as the full scan (${painted} exact px)`,
    differ.length === 0 && painted > 0,
    `scenes ${differ.slice(0, 5).join(",")}`,
  );
}

console.log(
  fails === 0 ? "self-test-grt4b: PASS" : `self-test-grt4b: FAIL (${fails})`,
);
process.exit(fails === 0 ? 0 : 1);
