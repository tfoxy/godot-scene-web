#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Run-to-run determinism of a gate's evidence (docs/remote-compute.md R1): given N run directories
// of the same gate (a runner's --out, e.g. validate-increment's <out>/native-rust-gate0/run), it
// reports, per shot PNG, whether every run's bytes are identical (sha256), and per dump JSON,
// whether every run's value is equal under canonicalEqual (lib/gate1-checks.ts: keys sorted,
// numbers rounded to float32) once the run-volatile fields are masked.
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/lib/remote-determinism.ts \
//     [--out determinism.json] RUN_DIR RUN_DIR [RUN_DIR...]
//
// Shots: every *.png under a run dir (reference and receiver shots, and the checker's diff images).
// Dumps: every receiver applied.json and state/*.json, and the fixture's steps.jsonl (one JSON
// value per line). A path present in some runs and absent from others disagrees. The provenance of
// each run (the GL renderer string Godot printed, gamescope's Vulkan device) must agree too: runs on
// different rasterizers are not a determinism sample.
//
// Masked (VOLATILE_KEYS): identity and wall-clock fields that differ between two runs by design --
// the random session/stream ids, the recording file's size and digest (it embeds those ids and the
// capture's encode timings), absolute evidence paths, and the receiver's microsecond timestamps.
// The per-transaction record digests are compared (two local NVIDIA runs agree on every one). A disagreeing shot gets a
// pixel report: mismatched pixel count, bounding box, the first few locations and the per-channel
// delta histogram. Exits 0 when everything agrees, 1 on any disagreement, 2 on bad usage.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { canonicalEqual } from "./gate1-checks";

/** Keys whose values differ between two runs of identical rendering by design. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "session_id",
  "stream_id",
  // applied.json's {path, sha256, bytes} of the recording file: the recording carries the random ids
  // and the capture's own encode/snapshot nanosecond totals (its `end` record), so its size and
  // digest differ run to run. Each transaction's record_sha256 stays compared: it does not.
  "recording",
  "received_sha256",
  "received_bytes",
  "path",
  "received_path",
  "state_path",
  "dir",
  "received_us",
  "applied_us",
  "submitted_us",
  "fetch_us",
]);

export function isDump(rel: string): boolean {
  return (
    /(^|\/)applied\.json$/.test(rel) ||
    /(^|\/)state\/[^/]+\.json$/.test(rel) ||
    /(^|\/)steps\.jsonl$/.test(rel)
  );
}

/** The value with every VOLATILE_KEYS member (at any depth) replaced by a fixed marker. */
export function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] =
        VOLATILE_KEYS.has(k) || k.endsWith("_us") ? "<volatile>" : mask(v);
    return out;
  }
  return value;
}

export function parseDump(rel: string, text: string): unknown {
  if (rel.endsWith(".jsonl"))
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  return JSON.parse(text);
}

async function walk(
  root: string,
  dir = root,
  out: string[] = [],
): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.push(relative(root, p));
  }
  return out;
}

export interface PixelDiff {
  width: number;
  height: number;
  mismatched_pixels: number;
  bbox: [number, number, number, number] | null; // x0 y0 x1 y1, inclusive
  first: Array<{ x: number; y: number; a: number[]; b: number[] }>;
  max_channel_delta: number[]; // r g b a
  delta_histogram: Record<string, number>; // max |delta| over channels -> pixel count
  size_mismatch?: string;
}

export async function pixelDiff(a: Buffer, b: Buffer): Promise<PixelDiff> {
  const ra = await sharp(a)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rb = await sharp(b)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = ra.info.width;
  const h = ra.info.height;
  const d: PixelDiff = {
    width: w,
    height: h,
    mismatched_pixels: 0,
    bbox: null,
    first: [],
    max_channel_delta: [0, 0, 0, 0],
    delta_histogram: {},
  };
  if (w !== rb.info.width || h !== rb.info.height) {
    d.size_mismatch = `${w}x${h} vs ${rb.info.width}x${rb.info.height}`;
    return d;
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let m = 0;
      for (let c = 0; c < 4; c++) {
        const dc = Math.abs(ra.data[i + c] - rb.data[i + c]);
        if (dc > d.max_channel_delta[c]) d.max_channel_delta[c] = dc;
        if (dc > m) m = dc;
      }
      if (m === 0) continue;
      d.mismatched_pixels++;
      d.delta_histogram[String(m)] = (d.delta_histogram[String(m)] ?? 0) + 1;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if (d.first.length < 8)
        d.first.push({
          x,
          y,
          a: [...ra.data.subarray(i, i + 4)],
          b: [...rb.data.subarray(i, i + 4)],
        });
    }
  if (x1 >= 0) d.bbox = [x0, y0, x1, y1];
  return d;
}

/** Godot's "OpenGL API ... Using Device: ..." line and gamescope's Vulkan device, per run. */
export async function provenanceOf(run: string, files: string[]) {
  let gl: string | null = null;
  for (const f of files.filter((x) => x.endsWith("stdout.log")).sort()) {
    const m = /^OpenGL API .*$/m.exec(await readFile(join(run, f), "utf8"));
    if (m) {
      gl = m[0];
      break;
    }
  }
  let vulkan: string | null = null;
  for (const f of files
    .filter((x) => /(^|\/)gamescope[^/]*\/gamescope\.json$/.test(x))
    .sort()) {
    try {
      const j = JSON.parse(await readFile(join(run, f), "utf8")) as {
        vulkanDevice?: string | null;
      };
      vulkan = j.vulkanDevice ?? null;
      break;
    } catch {
      // a half-written bring-up file: no provenance from it
    }
  }
  return { gl_renderer: gl, vulkan_device: vulkan };
}

export interface DeterminismReport {
  schema: "render-stream-remote-determinism/1";
  runs: number;
  run_dirs: string[];
  ok: boolean;
  provenance: Array<{
    gl_renderer: string | null;
    vulkan_device: string | null;
  }>;
  provenance_agree: boolean;
  shots: { total: number; agree: number; disagree: string[] };
  dumps: { total: number; agree: number; disagree: string[] };
  shot_rows: Array<{
    path: string;
    agree: boolean;
    sha256: Array<string | null>;
    diff?: PixelDiff[];
  }>;
  dump_rows: Array<{
    path: string;
    agree: boolean;
    missing: number[];
    differs_from_run1: number[];
  }>;
}

export async function compareRuns(runs: string[]): Promise<DeterminismReport> {
  const lists = await Promise.all(runs.map((r) => walk(r)));
  const all = [...new Set(lists.flat())].sort();
  const has = lists.map((l) => new Set(l));
  const provenance = await Promise.all(
    runs.map((r, i) => provenanceOf(r, lists[i])),
  );
  const provenanceAgree = provenance.every(
    (p) =>
      p.gl_renderer === provenance[0].gl_renderer &&
      p.vulkan_device === provenance[0].vulkan_device,
  );

  const shotRows: DeterminismReport["shot_rows"] = [];
  for (const rel of all.filter((f) => f.endsWith(".png"))) {
    const bufs = await Promise.all(
      runs.map((r, i) =>
        has[i].has(rel) ? readFile(join(r, rel)) : Promise.resolve(null),
      ),
    );
    const sha = bufs.map((b) =>
      b ? createHash("sha256").update(b).digest("hex") : null,
    );
    const agree = sha.every((s) => s !== null && s === sha[0]);
    const row: DeterminismReport["shot_rows"][number] = {
      path: rel,
      agree,
      sha256: sha,
    };
    if (!agree && bufs[0]) {
      row.diff = [];
      for (let i = 1; i < bufs.length; i++) {
        const b = bufs[i];
        if (b && sha[i] !== sha[0]) row.diff.push(await pixelDiff(bufs[0], b));
      }
    }
    shotRows.push(row);
  }

  const dumpRows: DeterminismReport["dump_rows"] = [];
  for (const rel of all.filter(isDump)) {
    const missing: number[] = [];
    const vals: unknown[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (!has[i].has(rel)) {
        missing.push(i + 1);
        vals.push(undefined);
        continue;
      }
      try {
        vals.push(
          mask(parseDump(rel, await readFile(join(runs[i], rel), "utf8"))),
        );
      } catch {
        missing.push(i + 1); // unparseable counts as absent
        vals.push(undefined);
      }
    }
    const differs: number[] = [];
    for (let i = 1; i < runs.length; i++)
      if (
        vals[i] !== undefined &&
        vals[0] !== undefined &&
        !canonicalEqual(vals[0], vals[i])
      )
        differs.push(i + 1);
    dumpRows.push({
      path: rel,
      agree: missing.length === 0 && differs.length === 0,
      missing,
      differs_from_run1: differs,
    });
  }

  const shotsBad = shotRows.filter((r) => !r.agree).map((r) => r.path);
  const dumpsBad = dumpRows.filter((r) => !r.agree).map((r) => r.path);
  return {
    schema: "render-stream-remote-determinism/1",
    runs: runs.length,
    run_dirs: runs,
    ok:
      runs.length >= 2 &&
      shotRows.length > 0 &&
      provenanceAgree &&
      shotsBad.length === 0 &&
      dumpsBad.length === 0,
    provenance,
    provenance_agree: provenanceAgree,
    shots: {
      total: shotRows.length,
      agree: shotRows.length - shotsBad.length,
      disagree: shotsBad,
    },
    dumps: {
      total: dumpRows.length,
      agree: dumpRows.length - dumpsBad.length,
      disagree: dumpsBad,
    },
    shot_rows: shotRows,
    dump_rows: dumpRows,
  };
}

async function main(argv: string[]): Promise<number> {
  let out: string | null = null;
  const runs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? null;
    else if (argv[i] === "--") continue;
    else runs.push(argv[i]);
  }
  if (runs.length < 2) {
    console.error("remote-determinism: give at least two run directories");
    return 2;
  }
  const r = await compareRuns(runs);
  if (out) await writeFile(out, `${JSON.stringify(r, null, 2)}\n`);
  for (const [i, p] of r.provenance.entries())
    console.log(
      `run ${i + 1}: ${runs[i]}\n  GL: ${p.gl_renderer ?? "?"}\n  Vulkan: ${p.vulkan_device ?? "?"}`,
    );
  for (const row of r.shot_rows.filter((x) => !x.agree)) {
    console.log(
      `DIFF shot ${row.path}: ${row.sha256.map((s) => s?.slice(0, 12) ?? "missing").join(" ")}`,
    );
    for (const d of row.diff ?? [])
      console.log(
        `  ${d.mismatched_pixels} px, bbox ${JSON.stringify(d.bbox)}, max delta rgba ${d.max_channel_delta.join("/")}`,
      );
  }
  for (const row of r.dump_rows.filter((x) => !x.agree))
    console.log(
      `DIFF dump ${row.path}: missing in ${JSON.stringify(row.missing)}, differs in ${JSON.stringify(row.differs_from_run1)}`,
    );
  console.log(
    `remote-determinism: ${r.ok ? "AGREE" : "DISAGREE"} over ${r.runs} runs: shots ${r.shots.agree}/${r.shots.total}, ` +
      `dumps ${r.dumps.agree}/${r.dumps.total}, provenance ${r.provenance_agree ? "same" : "DIFFERS"}`,
  );
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
