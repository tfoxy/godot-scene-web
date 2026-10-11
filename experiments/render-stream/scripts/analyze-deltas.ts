#!/usr/bin/env -S pnpm exec tsx --conditions=development
// D15, Q7g of ../protocol/gate6-design.md: reads gate 6's resource hook log (`evidence/
// resources.jsonl`, `render-stream-resource-log/1`, capture/src/rs_resource_log.h) and reports
// what hash-at-publish and delta encoding would have saved against the whole-version costs gate 6
// actually measures. Measured offline, never implemented here (D15): nothing this file computes
// changes what the capture or receiver do.
//
// Two numbers it computes without guessing:
//
// 1. **Hash-at-publish savings** ("versions superseded within a frame"): a resource (one
//    `kind`+`id`) that bumps `version` twice in the SAME engine frame had its earlier bump's
//    hashing and copying thrown away -- only the version current when a transaction next
//    publishes is ever sent. Grouping by frame (rather than by an actual publish schedule) is the
//    conservative version of this: a transaction publishes at most once per frame today (D8), so
//    same-frame version bumps are supersede candidates under every publish rate, uncapped or not.
// 2. **Mesh region-update deltas**: `mesh_surface_update_region` lines carry the delta's own
//    `bytes` directly (capture/src/rs_resource_log.h); summing it is exact, no estimation.
//
// What it deliberately does NOT compute: a texture or mesh "whole version" byte baseline when the
// hook log never logged one. A `MeshSurfaceCopy` line carries `vertex_count`/`index_count`
// (counts, not bytes); reconstructing a byte size needs `rs_mesh_payload.h`'s ArrayFormat-to-
// stride mapping, which is out of this file's scope. Where no `payload_bytes` was ever logged for
// a kind's version-creating ops, `whole_version_bytes_total` is `null` and `whole_version_bytes_
// available` is `false`, rather than a fabricated number. Texture updates have no partial-update
// path in this hook log at all, so their delta always equals the whole (`savings_bytes: 0`).
//
// CLI:
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/analyze-deltas.ts \
//     <resources.jsonl> [--out <file.json>]
// Prints the `render-stream-deltas/1` document to stdout (or `--out`) when run directly.

import { readFile, writeFile } from "node:fs/promises";
import type { ReportOptimizations } from "./lib/render-stream-report";

// ------------------------------------------------------------------------------------------- types

/** The subset of a resources.jsonl line (capture/src/rs_resource_log.h "Line keys") this
 * analysis reads. Every field is optional because a line's kind decides which ones are set --
 * this is a reader, not a schema owner; `render-stream-resource-log/1` owns the real shape. */
export interface DeltaHookLine {
  frame: number;
  op: string;
  kind?: string | null;
  id?: number | null;
  version?: number | null;
  payload_bytes?: number | null;
  bytes?: number | null; // mesh_surface_update_region's own delta size
  buffer?: string | null; // "vertex" | "attribute" | "skin" | "index" on a region update
  hash_ns?: number | null;
  copy_ns?: number | null;
  n?: number | null; // material/shader param: decoded element count
  sabotage?: boolean;
  omitted?: boolean;
  [key: string]: unknown;
}

export interface ParseResult {
  lines: DeltaHookLine[];
  skipped: number;
}

/** Parses `resources.jsonl`: one JSON object per non-blank line, as every other reader of this
 * log does. A line that fails to parse is skipped and counted, never fatal -- this is an offline
 * analysis over evidence that may span a long soak run, not a decoder whose correctness the gate
 * depends on. */
export function parseHookLog(text: string): ParseResult {
  const lines: DeltaHookLine[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as DeltaHookLine);
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

const RESOURCE_OPS_EXCLUDED = new Set([
  "store",
  "inline",
  "pin",
  "retire",
  "unpin",
  "http-get",
]);

/** A line that bumps (or sets, at creation) a resource's `version` -- the unit "whole-version
 * cost" and "superseded within a frame" are both counted over. Publisher/serving lines
 * (`store`/`inline`/`pin`/...) are not resource versions and are excluded; a sabotage's
 * `omitted:true` line changed nothing in the registry (rs_resource_log.h) and is excluded too. */
function isVersionCreatingLine(line: DeltaHookLine): boolean {
  return (
    typeof line.id === "number" &&
    typeof line.version === "number" &&
    !line.omitted &&
    !RESOURCE_OPS_EXCLUDED.has(line.op)
  );
}

function kindOf(line: DeltaHookLine): string {
  return line.kind ?? "unknown";
}

// --------------------------------------------------------------------------- hash-at-publish

export interface SupersededEntry {
  superseded_versions: number;
  superseded_payload_bytes: number;
  superseded_hash_ns: number;
  superseded_copy_ns: number;
}

/** Per kind, sums what every version bump that shared an engine frame with a LATER bump of the
 * same resource cost in bytes/hash time/copy time -- the hash-at-publish saving, since only the
 * last bump in a frame is ever visible to a publish. Grouped by (kind, id), ordered by the line's
 * position in the log (resources.jsonl is written in call order within a frame, D6). */
export function analyzeSupersededVersions(
  lines: DeltaHookLine[],
): Record<string, SupersededEntry> {
  const byResource = new Map<string, DeltaHookLine[]>();
  for (const line of lines) {
    if (!isVersionCreatingLine(line)) continue;
    const key = `${kindOf(line)}:${line.id}`;
    const list = byResource.get(key) ?? [];
    list.push(line);
    byResource.set(key, list);
  }

  const out: Record<string, SupersededEntry> = {};
  for (const [key, list] of byResource) {
    const kind = key.split(":")[0];
    if (!out[kind]) {
      out[kind] = {
        superseded_versions: 0,
        superseded_payload_bytes: 0,
        superseded_hash_ns: 0,
        superseded_copy_ns: 0,
      };
    }
    const entry = out[kind];
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].frame !== list[i + 1].frame) continue;
      entry.superseded_versions++;
      entry.superseded_payload_bytes += list[i].payload_bytes ?? 0;
      entry.superseded_hash_ns += list[i].hash_ns ?? 0;
      entry.superseded_copy_ns += list[i].copy_ns ?? 0;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ resource deltas

export interface ResourceDeltaEntry {
  resources: number;
  version_creating_ops: number;
  whole_version_bytes_total: number | null;
  whole_version_bytes_available: boolean;
  delta_bytes_total: number;
  delta_bytes_available: boolean;
  savings_bytes: number | null;
}

/** Per kind: how many bytes a whole-version resend would cost (when the log says, D15 header
 * note), against how many bytes an update actually needed to carry, using ONLY fields a hook-log
 * line already provides -- see the file header for exactly what "available" means per kind. */
export function analyzeResourceDeltas(
  lines: DeltaHookLine[],
): Record<string, ResourceDeltaEntry> {
  const byKind = new Map<
    string,
    { ids: Set<number>; versionOps: DeltaHookLine[] }
  >();
  for (const line of lines) {
    if (!isVersionCreatingLine(line)) continue;
    const kind = kindOf(line);
    const bucket = byKind.get(kind) ?? {
      ids: new Set<number>(),
      versionOps: [],
    };
    bucket.ids.add(line.id as number);
    bucket.versionOps.push(line);
    byKind.set(kind, bucket);
  }

  const out: Record<string, ResourceDeltaEntry> = {};
  for (const [kind, { ids, versionOps }] of byKind) {
    let wholeTotal = 0;
    let wholeAvailable = true;
    let deltaTotal = 0;
    let anyPartialDelta = false;
    for (const op of versionOps) {
      const hasWhole = typeof op.payload_bytes === "number";
      if (!hasWhole) wholeAvailable = false;
      else wholeTotal += op.payload_bytes as number;

      const isPartial = typeof op.bytes === "number" && op.buffer != null;
      if (isPartial) {
        anyPartialDelta = true;
        deltaTotal += op.bytes as number;
      } else if (hasWhole) {
        // No partial path for this op: sending it at all costs its whole payload.
        deltaTotal += op.payload_bytes as number;
      }
    }
    const deltaAvailable = anyPartialDelta;
    out[kind] = {
      resources: ids.size,
      version_creating_ops: versionOps.length,
      whole_version_bytes_total: wholeAvailable ? wholeTotal : null,
      whole_version_bytes_available: wholeAvailable,
      delta_bytes_total: deltaTotal,
      delta_bytes_available: deltaAvailable,
      savings_bytes: wholeAvailable ? wholeTotal - deltaTotal : null,
    };
  }
  return out;
}

// -------------------------------------------------------------------------- param bytes per frame

const PARAM_OPS = new Set([
  "material_set_param",
  "canvas_item_set_instance_shader_parameter",
  "shader_set_default_texture_parameter",
]);

export interface ParamBytesPerFrame {
  unit: "bytes" | "elements" | "mixed";
  frames: number;
  total: number;
  mean_per_frame: number;
}

/** Sums a size proxy for every parameter-setting line, bucketed by frame. Prefers `payload_bytes`
 * when a line has one; falls back to `n` (the decoded element count, `MaterialParamCopy::n`,
 * rs_resource_log.h) when it does not, since most param lines carry no byte size at all. `unit`
 * reports honestly which one ended up contributing: `"bytes"` only when every contributing line
 * had a real byte size, `"elements"` when none did, `"mixed"` when the log has both. */
export function analyzeParamBytesPerFrame(
  lines: DeltaHookLine[],
): ParamBytesPerFrame {
  const byFrame = new Map<number, number>();
  let sawBytes = false;
  let sawElements = false;
  for (const line of lines) {
    if (!PARAM_OPS.has(line.op) || line.omitted) continue;
    let value: number | undefined;
    if (typeof line.payload_bytes === "number") {
      value = line.payload_bytes;
      sawBytes = true;
    } else if (typeof line.n === "number") {
      value = line.n;
      sawElements = true;
    }
    if (value === undefined) continue;
    byFrame.set(line.frame, (byFrame.get(line.frame) ?? 0) + value);
  }
  const total = [...byFrame.values()].reduce((a, b) => a + b, 0);
  const unit: ParamBytesPerFrame["unit"] =
    sawBytes && sawElements ? "mixed" : sawBytes ? "bytes" : "elements";
  return {
    unit,
    frames: byFrame.size,
    total,
    mean_per_frame: byFrame.size > 0 ? total / byFrame.size : 0,
  };
}

// ------------------------------------------------------------------------------------- combined

/** Combines the three analyses into `render-stream-report/1`'s `optimizations` shape
 * (`render-stream-deltas/1`). */
export function computeOptimizations(
  lines: DeltaHookLine[],
): ReportOptimizations {
  const superseded = analyzeSupersededVersions(lines);
  const deltas = analyzeResourceDeltas(lines);
  const kinds = new Set([...Object.keys(superseded), ...Object.keys(deltas)]);
  const byKind: ReportOptimizations["by_kind"] = {};
  for (const kind of kinds) {
    const s = superseded[kind] ?? {
      superseded_versions: 0,
      superseded_payload_bytes: 0,
      superseded_hash_ns: 0,
      superseded_copy_ns: 0,
    };
    const d = deltas[kind] ?? {
      resources: 0,
      version_creating_ops: 0,
      whole_version_bytes_total: null,
      whole_version_bytes_available: false,
      delta_bytes_total: 0,
      delta_bytes_available: false,
      savings_bytes: null,
    };
    byKind[kind] = { ...s, ...d };
  }
  return {
    schema: "render-stream-deltas/1",
    by_kind: byKind,
    param_bytes_per_frame: analyzeParamBytesPerFrame(lines),
  };
}

// ------------------------------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputPath = argv.find((a) => !a.startsWith("--"));
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (!inputPath) {
    throw new Error(
      "analyze-deltas: usage: analyze-deltas.ts <resources.jsonl> [--out <file.json>]",
    );
  }
  const { lines, skipped } = parseHookLog(await readFile(inputPath, "utf8"));
  if (skipped > 0)
    console.error(
      `analyze-deltas: skipped ${skipped} unparsable line(s) in ${inputPath}`,
    );
  const optimizations = computeOptimizations(lines);
  const text = JSON.stringify(optimizations, null, 2);
  if (outPath) await writeFile(outPath, text);
  else console.log(text);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
