// Gate 8 g8hint checks (render-stream-15.md "Resource hints" and "Size override") on
// fixtures/hint-scene, armed late with GRC_ADOPT=arm. run-gate8.sh run_g8hint writes, under g8hint/:
//
//   honest/capture                      /15 file sinks (recording.rs15, recording-patch.rs15, the
//                                       store) and evidence/{hints.jsonl,result.json}
//   sabotage-<kind>/capture             the same with GRC_HINT_SABOTAGE=<kind>, one per kind
//   live/host, live/receiver            a live /15 host (evidence/hints.jsonl, probe.jsonl: a GET
//                                       per hint as it went out) and the native receiver at /15
//   v13/capture                         the same fixture at /13
//   reference, honest/receiver,         rendered: the unarmed fixture's shots and the native
//   v13/receiver                        receiver replaying the /15 and the /13 recording
//
// Checks: hint-validate, hint-precedes, hint-servable, hint-meta, hint-path, hint-unhint,
// hint-counters, hint-pure, s1-edge, and one sabotage-<kind> per GRC_HINT_SABOTAGE kind: its leg
// must fail exactly its target predicate (unknown-hash: hint-servable, early-unhint: hint-precedes,
// edited-path: hint-path) and pass every other file-leg predicate.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import {
  decodeRecording,
  type ResolvedTexture,
  type ResourceHintMeta,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

export interface G8hintExpected {
  arm_frame: number;
  warm: string[];
  create: string[];
  paths: Record<string, string>;
  null_path: string[];
  edited_path: string;
  fixture_size: [number, number];
  step1_drawn: string[];
  freed: string[];
  changed: string[];
  edges: {
    name: string;
    stored: [number, number];
    logical: [number, number];
    rect: [number, number, number, number];
  }[];
  s1: { steps: number[]; budget_pixels: number; control_min_pixels: number };
}

export const HINT_SABOTAGES = [
  "hint-unknown-hash",
  "hint-early-unhint",
  "hint-edited-path",
] as const;
type Sabotage = (typeof HINT_SABOTAGES)[number];
/** The predicate each sabotage must fail (and the only one). */
export const SABOTAGE_TARGET: Record<Sabotage, PredicateId> = {
  "hint-unknown-hash": "hint-servable",
  "hint-early-unhint": "hint-precedes",
  "hint-edited-path": "hint-path",
};
const FILE_PREDICATES = [
  "hint-validate",
  "hint-precedes",
  "hint-servable",
  "hint-meta",
  "hint-path",
  "hint-unhint",
  "hint-counters",
] as const;
type PredicateId = (typeof FILE_PREDICATES)[number];

interface HintLine {
  frame: number;
  sink: string;
  op: "hint" | "unhint";
  hash: string;
  cause?: string;
  priority?: number;
}

export interface HintsResult {
  on: boolean;
  budget_bytes: number;
  sabotage: string;
  sources_create: number;
  sources_warm: number;
  skipped_inline: number;
  added: number;
  removed_freed: number;
  removed_changed: number;
  budget_drops: number;
  table_peak: number;
  admitted_bytes_max: number;
  pinned_max: number;
  live_hints: number;
  live_unhints: number;
  file_hints: number;
  file_unhints: number;
  store_writes: number;
  store_failures: number;
  sibling_at_hint: number;
}

/** A hint record in record order, with what happened to its hash. */
export interface HintSeen {
  meta: ResourceHintMeta;
  record: number;
  unhinted_at: number | null; // record index of the first unhint after it
}

export interface FirstDraw {
  hash: string;
  seq: number;
  frame: number;
  record: number;
  hinted_now: boolean; // in effect (hinted, not unhinted since) at that transaction
  ever_hinted: boolean;
  entry: ResolvedTexture;
}

/** One file leg's recording, read in record order. */
export interface RecordingFacts {
  version: number;
  errors: string[];
  hints: HintSeen[];
  unhints: { hash: string; record: number }[];
  first_draws: FirstDraw[];
  /** every ok image entry ever resolved, by hash (the latest) */
  entries: Map<string, ResolvedTexture>;
  /** the hashes any transaction's state holds as an ok image */
  in_state: Set<string>;
  transactions: number;
}

export function readRecordingFacts(bytes: Uint8Array): RecordingFacts {
  const version = wireVersionOf(bytes);
  const facts: RecordingFacts = {
    version,
    errors: [],
    hints: [],
    unhints: [],
    first_draws: [],
    entries: new Map(),
    in_state: new Set(),
    transactions: 0,
  };
  facts.errors = validateRecording(bytes, version);
  if (facts.errors.length > 0) return facts;
  const decoded = decodeRecording(bytes, version);
  const resolved = resolveRecording(bytes, version);
  const active = new Map<string, HintSeen>();
  const ever = new Set<string>();
  const drawn = new Set<string>();
  let tx = 0;
  decoded.records.forEach((record, i) => {
    const meta = record.meta;
    if (meta.type === "resource_hint") {
      const seen: HintSeen = { meta, record: i, unhinted_at: null };
      facts.hints.push(seen);
      active.set(meta.hash, seen);
      ever.add(meta.hash);
    } else if (meta.type === "resource_unhint") {
      facts.unhints.push({ hash: meta.hash, record: i });
      const seen = active.get(meta.hash);
      if (seen && seen.unhinted_at === null) seen.unhinted_at = i;
      active.delete(meta.hash);
    } else if (meta.type === "transaction") {
      const rt = resolved.transactions[tx++];
      const byId = new Map(rt.state.textures.map((t) => [t.id, t]));
      for (const t of rt.state.textures) {
        if (t.kind === "image" && t.status === "ok" && t.hash) {
          facts.entries.set(t.hash, t);
          facts.in_state.add(t.hash);
        }
      }
      for (const item of rt.state.items) {
        for (const c of item.commands) {
          if (c.tex === undefined || c.tex === null) continue;
          const t = byId.get(c.tex);
          if (t?.status !== "ok" || !t.hash || drawn.has(t.hash)) continue;
          drawn.add(t.hash);
          facts.first_draws.push({
            hash: t.hash,
            seq: rt.seq,
            frame: rt.frame,
            record: i,
            hinted_now: active.has(t.hash),
            ever_hinted: ever.has(t.hash),
            entry: t,
          });
        }
      }
    }
  });
  facts.transactions = tx;
  return facts;
}

/** One file leg's evidence. */
export interface FileLeg {
  dir: string;
  facts: RecordingFacts | null;
  patch_facts: RecordingFacts | null;
  hints_log: HintLine[];
  result: HintsResult | undefined;
  store: Map<string, string>; // hash -> sha256 of the stored file
  store_first_frame: Map<string, number>;
  steps: { step: number; applied_frame: number; settle_frame: number }[];
}

export function storeIndex(dir: string): {
  files: Map<string, string>;
  first: Map<string, number>;
} {
  const files = new Map<string, string>();
  const first = new Map<string, number>();
  const sub = join(dir, "sha256");
  if (existsSync(sub)) {
    for (const f of readdirSync(sub)) {
      const m = /^([0-9a-f]{64})\.[a-z]+$/.exec(f);
      if (!m) continue;
      files.set(
        m[1],
        createHash("sha256")
          .update(readFileSync(join(sub, f)))
          .digest("hex"),
      );
    }
  }
  const index = existsSync(join(dir, "index.jsonl"))
    ? readFileSync(join(dir, "index.jsonl"), "utf8")
    : "";
  for (const line of jsonl<{ hash: string; first_frame: number }>(index))
    if (!first.has(line.hash)) first.set(line.hash, line.first_frame);
  return { files, first };
}

async function readFileLeg(dir: string, rs: string): Promise<FileLeg> {
  const read = (name: string): RecordingFacts | null => {
    const p = join(dir, name);
    return existsSync(p)
      ? readRecordingFacts(new Uint8Array(readFileSync(p)))
      : null;
  };
  const store = storeIndex(join(dir, "store"));
  const result = await readJson<{
    stream?: { gate8?: { hints?: HintsResult } };
  }>(join(dir, "evidence", "result.json"));
  return {
    dir,
    facts: read(`recording.${rs}`),
    patch_facts: read(`recording-patch.${rs}`),
    hints_log: jsonl<HintLine>(
      await readText(join(dir, "evidence", "hints.jsonl")),
    ),
    result: result?.stream?.gate8?.hints,
    store: store.files,
    store_first_frame: store.first,
    steps: jsonl(await readText(join(dir, "steps.jsonl"))),
  };
}

/** Whether the host holds a hint's payload (stored, or in some transaction's state): not the
 * unknown-hash sabotage's hint. */
function held(leg: FileLeg, h: ResourceHintMeta): boolean {
  return leg.store.has(h.hash) || (leg.facts?.in_state.has(h.hash) ?? false);
}

function pathMatches(want: string, got: string | null): boolean {
  if (got === null) return false;
  return want.startsWith("prefix:")
    ? got.startsWith(want.slice("prefix:".length))
    : got === want;
}

/** A hint's fixture name: by its path, else (a null path on a fixture-sized texture) by cause;
 * undefined for the engine's own textures. */
function nameOf(ex: G8hintExpected, h: ResourceHintMeta): string | undefined {
  for (const [name, want] of Object.entries(ex.paths))
    if (pathMatches(want, h.path)) return name;
  if (
    h.path === null &&
    h.width === ex.fixture_size[0] &&
    h.height === ex.fixture_size[1]
  ) {
    const pool = h.cause === "warm" ? ex.warm : ex.create;
    return ex.null_path.find((n) => pool.includes(n));
  }
  return undefined;
}

// ------------------------------------------------------------------------------- predicates

export function predValidate(leg: FileLeg): string[] {
  const p: string[] = [];
  for (const [label, f] of [
    ["recording", leg.facts],
    ["patch recording", leg.patch_facts],
  ] as const) {
    if (!f) {
      p.push(`no ${label}`);
      continue;
    }
    if (f.version !== 15) p.push(`${label} is /${f.version}, want /15`);
    if (f.errors.length > 0) p.push(`${label}: ${f.errors[0]}`);
    else if (f.hints.length === 0) p.push(`${label} holds no resource_hint`);
  }
  if (leg.facts && leg.patch_facts && leg.facts.errors.length === 0) {
    const a = leg.facts.hints.map((h) => h.meta.hash).join();
    const b = leg.patch_facts.hints.map((h) => h.meta.hash).join();
    if (a !== b) p.push("the full and patch sinks hint different hashes");
  }
  return p;
}

export function predPrecedes(leg: FileLeg, ex: G8hintExpected): string[] {
  const f = leg.facts;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  const s1 = leg.steps.find((s) => s.step === 1);
  const s2 = leg.steps.find((s) => s.step === 2);
  if (!s1 || !s2) return ["steps.jsonl lacks step 1 or 2"];
  const drawnAtStep1 = f.first_draws.filter(
    (d) => d.frame >= s1.applied_frame && d.frame < s2.applied_frame,
  );
  const p: string[] = [];
  if (drawnAtStep1.length !== ex.step1_drawn.length)
    p.push(
      `${drawnAtStep1.length} textures first drawn at step 1, want ${ex.step1_drawn.length}`,
    );
  for (const d of drawnAtStep1) {
    if (!d.ever_hinted)
      p.push(
        `${d.hash.slice(0, 12)} (seq ${d.seq}) was never hinted before it was drawn`,
      );
    else if (!d.hinted_now)
      p.push(
        `${d.hash.slice(0, 12)} (seq ${d.seq}) was unhinted before the first transaction drawing it`,
      );
  }
  return p;
}

export function predServable(
  leg: FileLeg,
  live?: { lines: HintLine[]; probe: ProbeLine[] } | null,
): string[] {
  const f = leg.facts;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  const p: string[] = [];
  const fileFrame = new Map<string, number>();
  for (const l of leg.hints_log)
    if (l.sink === "file" && l.op === "hint" && !fileFrame.has(l.hash))
      fileFrame.set(l.hash, l.frame);
  for (const h of f.hints) {
    for (const hash of [h.meta.hash, ...h.meta.variants.map((v) => v.hash)]) {
      const sha = leg.store.get(hash);
      if (sha === undefined) {
        p.push(`${hash.slice(0, 12)} hinted but not in the store`);
        continue;
      }
      if (sha !== hash)
        p.push(
          `${hash.slice(0, 12)}: the stored file hashes to ${sha.slice(0, 12)}`,
        );
      const first = leg.store_first_frame.get(hash);
      const at = fileFrame.get(h.meta.hash);
      if (first !== undefined && at !== undefined && first > at)
        p.push(
          `${hash.slice(0, 12)} stored at frame ${first}, after its hint (frame ${at})`,
        );
    }
  }
  if (live !== undefined) {
    if (!live) p.push("no live leg evidence");
    else {
      const hinted = [
        ...new Set(
          live.lines
            .filter((l) => l.op === "hint" && l.sink.startsWith("live:"))
            .map((l) => l.hash),
        ),
      ];
      if (hinted.length === 0) p.push("the live host logged no live hint");
      const byHash = new Map(live.probe.map((l) => [l.hash, l]));
      for (const hash of hinted) {
        const g = byHash.get(hash);
        if (!g) p.push(`live: no GET of ${hash.slice(0, 12)}`);
        else if (g.status === 200) {
          if (g.sha256 !== hash)
            p.push(
              `live: GET ${hash.slice(0, 12)} returned bytes hashing to ${g.sha256.slice(0, 12)}`,
            );
        } else if (!g.unhinted_before)
          p.push(
            `live: GET ${hash.slice(0, 12)} answered ${g.status} while hinted`,
          );
      }
    }
  }
  return p;
}

export function predMeta(leg: FileLeg): string[] {
  const f = leg.facts;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  const p: string[] = [];
  let compared = 0;
  for (const h of f.hints) {
    const e = f.entries.get(h.meta.hash);
    if (!e) continue;
    compared++;
    const m = h.meta;
    const want = JSON.stringify([
      m.format,
      m.source_format,
      m.width,
      m.height,
      m.mipmaps,
      m.payload_bytes,
      m.variants,
    ]);
    const got = JSON.stringify([
      e.format,
      e.source_format ?? null,
      e.width,
      e.height,
      e.mipmaps,
      e.payload_bytes,
      e.variants ?? [],
    ]);
    if (want !== got)
      p.push(`${m.hash.slice(0, 12)}: hint ${want} != entry ${got}`);
  }
  if (compared === 0) p.push("no hinted hash ever reached a transaction");
  return p;
}

export function predPath(leg: FileLeg, ex: G8hintExpected): string[] {
  const f = leg.facts;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  const p: string[] = [];
  const count = new Map<string, number>();
  const nulls: string[] = [];
  for (const h of f.hints) {
    if (!held(leg, h.meta)) continue; // a payload the host does not hold: hint-servable's
    if (h.meta.path === ex.edited_path)
      p.push(
        `${h.meta.hash.slice(0, 12)} carries the edited texture's path ${h.meta.path}`,
      );
    if (h.meta.path === null) {
      // the engine's own pre-arm textures are warmed too; only the fixture's shape is judged
      if (
        h.meta.width === ex.fixture_size[0] &&
        h.meta.height === ex.fixture_size[1]
      )
        nulls.push(h.meta.cause);
      continue;
    }
    const name = Object.entries(ex.paths).find(([, want]) =>
      pathMatches(want, h.meta.path),
    )?.[0];
    if (!name) {
      if (h.meta.path !== ex.edited_path)
        p.push(`${h.meta.hash.slice(0, 12)}: unexpected path ${h.meta.path}`);
      continue;
    }
    if (!h.meta.path.startsWith("res://"))
      p.push(`${name}: path ${h.meta.path} is not a res:// path`);
    count.set(name, (count.get(name) ?? 0) + 1);
    const pool = ex.warm.includes(name) ? "warm" : "create";
    if (h.meta.cause !== pool)
      p.push(`${name}: cause ${h.meta.cause}, want ${pool}`);
  }
  for (const name of Object.keys(ex.paths))
    if ((count.get(name) ?? 0) !== 1)
      p.push(`${name}: ${count.get(name) ?? 0} hints with its path, want 1`);
  const wantNulls = ex.null_path
    .map((n) => (ex.warm.includes(n) ? "warm" : "create"))
    .sort();
  if (nulls.sort().join() !== wantNulls.join())
    p.push(
      `null-path hints of causes [${nulls.join(",")}], want [${wantNulls.join(",")}]`,
    );
  return p;
}

export function predUnhint(leg: FileLeg, ex: G8hintExpected): string[] {
  const f = leg.facts;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  const p: string[] = [];
  for (const name of [...ex.freed, ...ex.changed]) {
    const h = f.hints.find((x) => nameOf(ex, x.meta) === name);
    if (!h) p.push(`${name}: never hinted`);
    else if (h.unhinted_at === null) p.push(`${name}: never unhinted`);
  }
  const r = leg.result;
  if (!r) p.push("no result.json hints");
  else {
    if (r.removed_freed !== ex.freed.length)
      p.push(`removed_freed ${r.removed_freed}, want ${ex.freed.length}`);
    if (r.removed_changed !== ex.changed.length)
      p.push(`removed_changed ${r.removed_changed}, want ${ex.changed.length}`);
  }
  return p;
}

export function predCounters(
  leg: FileLeg,
  ex: G8hintExpected,
  sabotage: string,
): string[] {
  const f = leg.facts;
  const r = leg.result;
  if (!f || f.errors.length > 0) return ["no valid recording"];
  if (!r) return ["no result.json stream.gate8.hints"];
  const p: string[] = [];
  if (!r.on) p.push("hints off");
  if (r.sabotage !== sabotage)
    p.push(`sabotage ${r.sabotage}, want ${sabotage}`);
  if (r.file_hints !== f.hints.length)
    p.push(
      `file_hints ${r.file_hints} != ${f.hints.length} resource_hint records`,
    );
  if (r.file_unhints !== f.unhints.length)
    p.push(
      `file_unhints ${r.file_unhints} != ${f.unhints.length} resource_unhint records`,
    );
  const fileLines = leg.hints_log.filter((l) => l.sink === "file");
  const logHints = fileLines.filter((l) => l.op === "hint").map((l) => l.hash);
  const logUnhints = fileLines
    .filter((l) => l.op === "unhint")
    .map((l) => l.hash);
  if (logHints.join() !== f.hints.map((h) => h.meta.hash).join())
    p.push("hints.jsonl's file hints differ from the recording's");
  if (logUnhints.join() !== f.unhints.map((h) => h.hash).join())
    p.push("hints.jsonl's file unhints differ from the recording's");
  // The engine's own pre-arm textures (none drawn) are warmed beside the fixture's.
  if (r.sources_warm < ex.warm.length)
    p.push(`sources_warm ${r.sources_warm}, want >= ${ex.warm.length}`);
  if (r.sources_create !== ex.create.length)
    p.push(`sources_create ${r.sources_create}, want ${ex.create.length}`);
  if (r.added !== r.sources_warm + r.sources_create)
    p.push(
      `added ${r.added}, want sources_warm + sources_create ${r.sources_warm + r.sources_create}`,
    );
  const extra = sabotage === "hint-unknown-hash" ? 1 : 0;
  if (r.file_hints !== r.added + extra)
    p.push(
      `file_hints ${r.file_hints}, want added ${r.added}${extra ? " + 1" : ""}`,
    );
  if (r.budget_drops !== 0) p.push(`budget_drops ${r.budget_drops}`);
  if (r.store_failures !== 0) p.push(`store_failures ${r.store_failures}`);
  if (r.skipped_inline !== 0) p.push(`skipped_inline ${r.skipped_inline}`);
  // Priorities number the hints in the order their textures were seen, oldest first.
  const pri = f.hints.map((h) => h.meta.priority);
  if (pri.some((x, i) => i > 0 && x <= pri[i - 1]))
    p.push(`priorities not ascending in record order: ${pri.join(",")}`);
  return p;
}

// ------------------------------------------------------------------------------- live, pure, s1

export interface ProbeLine {
  hash: string;
  status: number;
  sha256: string;
  unhinted_before: boolean;
}

interface ShotDiff {
  present: boolean;
  differing: number; // in the edge rectangles
  differing_frame: number;
  max_delta: number;
}

function shotFile(dir: string, step: number): string {
  const seqsPath = join(dir, "shot-seqs.txt");
  if (!existsSync(seqsPath)) return join(dir, "shots", `step-${step}.png`);
  const seq = readFileSync(seqsPath, "utf8").trim().split(",")[step];
  return join(dir, "shots", `seq-${seq}.png`);
}

export async function edgeDiff(
  a: string,
  b: string,
  step: number,
  rects: [number, number, number, number][],
): Promise<ShotDiff> {
  const pa = shotFile(a, step);
  const pb = shotFile(b, step);
  const ia = existsSync(pa) ? await decodePngRgba(pa) : undefined;
  const ib = existsSync(pb) ? await decodePngRgba(pb) : undefined;
  const out: ShotDiff = {
    present: false,
    differing: 0,
    differing_frame: 0,
    max_delta: 0,
  };
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height)
    return out;
  out.present = true;
  for (let y = 0; y < ia.height; y++) {
    for (let x = 0; x < ia.width; x++) {
      const i = (y * ia.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++)
        d = Math.max(d, Math.abs(ia.data[i + c] - ib.data[i + c]));
      if (d === 0) continue;
      out.differing_frame++;
      out.max_delta = Math.max(out.max_delta, d);
      if (
        rects.some(
          ([rx, ry, rw, rh]) =>
            x >= rx && x < rx + rw && y >= ry && y < ry + rh,
        )
      )
        out.differing++;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- the group

export async function runG8hint(
  out: string,
  ex: G8hintExpected,
): Promise<{ checks: G8aCheck[]; report: Record<string, unknown> }> {
  const g = join(out, "g8hint");
  const checks: G8aCheck[] = [];
  const report: Record<string, unknown> = {};
  const ran = (rel: string) =>
    existsSync(join(g, rel, "exit-code.txt")) && skipped(join(g, rel)) === null;

  const honest = ran("honest/capture")
    ? await readFileLeg(join(g, "honest/capture"), "rs15")
    : null;
  const liveLines = ran("live/host")
    ? jsonl<HintLine>(await readText(join(g, "live/host/evidence/hints.jsonl")))
    : null;
  const probe = ran("live/host")
    ? jsonl<ProbeLine>(await readText(join(g, "live/host/probe.jsonl")))
    : [];
  const live = liveLines ? { lines: liveLines, probe } : null;

  const predicates = (leg: FileLeg, sabotage: string, withLive: boolean) => ({
    "hint-validate": predValidate(leg),
    "hint-precedes": predPrecedes(leg, ex),
    "hint-servable": predServable(leg, withLive ? live : undefined),
    "hint-meta": predMeta(leg),
    "hint-path": predPath(leg, ex),
    "hint-unhint": predUnhint(leg, ex),
    "hint-counters": predCounters(leg, ex, sabotage),
  });
  const honestP = honest ? predicates(honest, "none", true) : null;
  const f = honest?.facts;
  const criteria: Record<PredicateId, string> = {
    "hint-validate":
      "the honest /15 recordings (full and patch sinks) validate with the TS oracle (scripts/lib/render-stream-2.ts at /15) and hold resource_hint records, the same hashes on both sinks",
    "hint-precedes":
      "every texture step 1 draws first (pre-arm textures prepared by the late-arm warm pass and armed creates) was hinted before, and still hinted at, the first transaction whose commands draw it, in record order",
    "hint-servable":
      "every hinted hash (and variant hash) was servable while hinted: the file sinks' store holds it, hashing to its name, stored no later than its hint's frame; on the live /15 host a GET at the moment its hint was logged answered 200 with bytes hashing to the name (a miss is allowed only after the host logged its unhint)",
    "hint-meta":
      "each hint's format, source_format, width, height, mipmaps, payload_bytes and variants equal the ok image entry the transactions later carry for its hash",
    "hint-path":
      "pristine textures' hints carry their resource path (res://hint/<name>.tres, the imported .ctex for the edges), each once, with cause warm before the arm and create after it; of the fixture's 96x96 textures, the one updated before the arm (warm) and the one created without a path (create) carry null, and no hint carries the edited texture's path",
    "hint-unhint":
      "the textures freed and those whose content changed while undrawn got a resource_unhint of their hinted hash (result.json removed_freed and removed_changed match)",
    "hint-counters":
      "result.json stream.gate8.hints is consistent with the recording and hints.jsonl: on, file_hints/file_unhints equal the records, sources_warm covers the fixture's pre-arm textures (the engine's own are warmed too), sources_create equals the fixture's, added = sources_warm + sources_create = file_hints (+1 for the unknown-hash sabotage), no budget drops, store failures or inline skips, priorities ascending",
  };
  for (const id of FILE_PREDICATES) {
    const problems = honestP ? honestP[id] : null;
    let detail = "";
    if (f && problems && problems.length === 0) {
      if (id === "hint-validate")
        detail = `${f.transactions} transactions, ${f.hints.length} hints, ${f.unhints.length} unhints, valid at /15`;
      if (id === "hint-precedes")
        detail = f.first_draws
          .filter((d) => d.ever_hinted)
          .map((d) => `${d.hash.slice(0, 8)}@seq${d.seq}`)
          .join(", ");
      if (id === "hint-servable")
        detail = `${honest?.store.size} store files; live: ${probe.filter((l) => l.status === 200).length}/${probe.length} GETs 200 (${probe.filter((l) => l.unhinted_before).length} after the unhint)`;
      if (id === "hint-meta")
        detail = `${f.hints.filter((h) => f.entries.has(h.meta.hash)).length} of ${f.hints.length} hinted hashes reached a transaction, each entry equal to its hint`;
      if (id === "hint-unhint")
        detail = [...ex.freed, ...ex.changed]
          .map((n) => {
            const h = f.hints.find((x) => nameOf(ex, x.meta) === n);
            return `${n} unhinted at record ${h?.unhinted_at}`;
          })
          .join(", ");
      if (id === "hint-path")
        detail = f.hints
          .map(
            (h) =>
              `${nameOf(ex, h.meta) ?? "?"}:${h.meta.cause}:${h.meta.path === null ? "null" : "path"}`,
          )
          .join(", ");
      if (id === "hint-counters" && honest?.result) {
        const r = honest.result;
        detail = `warm ${r.sources_warm}, create ${r.sources_create}, added ${r.added}, file ${r.file_hints}/${r.file_unhints}, freed ${r.removed_freed}, changed ${r.removed_changed}, store_writes ${r.store_writes}, admitted_bytes_max ${r.admitted_bytes_max}`;
      }
    }
    checks.push(check(id, criteria[id], problems, detail));
  }
  report.honest = honestP
    ? Object.fromEntries(Object.entries(honestP).map(([k, v]) => [k, v.length]))
    : null;

  // --- hint-live: the live host's own counters and the native /15 receiver ---------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("live/host") && liveLines) {
      problems = [];
      const r = (
        await readJson<{ stream?: { gate8?: { hints?: HintsResult } } }>(
          join(g, "live/host/evidence/result.json"),
        )
      )?.stream?.gate8?.hints;
      const lh = liveLines.filter(
        (l) => l.sink.startsWith("live:") && l.op === "hint",
      ).length;
      const lu = liveLines.filter(
        (l) => l.sink.startsWith("live:") && l.op === "unhint",
      ).length;
      if (!r) problems.push("no result.json hints");
      else {
        if (r.live_hints !== lh)
          problems.push(`live_hints ${r.live_hints} != ${lh} logged`);
        if (r.live_unhints !== lu)
          problems.push(`live_unhints ${r.live_unhints} != ${lu} logged`);
        if (!(r.pinned_max > 0)) problems.push(`pinned_max ${r.pinned_max}`);
        if (r.added !== r.sources_warm + r.sources_create)
          problems.push(
            `added ${r.added} != sources ${r.sources_warm + r.sources_create}`,
          );
      }
      if (lh < ex.warm.length + ex.create.length)
        problems.push(
          `${lh} live hints, want >= ${ex.warm.length + ex.create.length}`,
        );
      const exit = (
        await readText(join(g, "live/receiver/exit-code.txt"))
      )?.trim();
      if (exit !== "0") problems.push(`live/receiver exit ${exit}`);
      const applied = await readJson<{
        receiver?: { protocol?: string };
        status?: string;
        failures?: unknown[];
      }>(join(g, "live/receiver/applied.json"));
      if (!applied) problems.push("no live/receiver/applied.json");
      else if (applied.receiver?.protocol !== "render-stream/15")
        problems.push(`live/receiver protocol ${applied.receiver?.protocol}`);
      detail = `${lh} live hints, ${lu} unhints, pinned_max ${r?.pinned_max}, sibling_at_hint ${r?.sibling_at_hint}; native receiver at ${applied?.receiver?.protocol} exit ${exit}`;
    }
    checks.push(
      check(
        "hint-live",
        "the live /15 host hinted every warm and created texture on the native receiver's /15 connection (result.json live_hints/live_unhints equal its hints.jsonl, pinned_max > 0) and the native receiver at RS_RECEIVER_PROTOCOL=15 ran the stream to its end",
        problems,
        detail,
      ),
    );
  }

  // --- hint-pure: /13 carries none of it --------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("v13/capture")) {
      problems = [];
      const dir = join(g, "v13/capture");
      const p = join(dir, "recording.rs13");
      if (!existsSync(p)) problems.push("no recording.rs13");
      else {
        const bytes = new Uint8Array(readFileSync(p));
        if (wireVersionOf(bytes) !== 13)
          problems.push("recording.rs13 is not GRSD");
        const errors = validateRecording(bytes, 13);
        if (errors.length > 0) problems.push(`recording.rs13: ${errors[0]}`);
        else {
          const types = new Set(
            decodeRecording(bytes, 13).records.map((r) => r.meta.type),
          );
          if (types.has("resource_hint") || types.has("resource_unhint"))
            problems.push("a /13 recording holds hint records");
        }
      }
      const r = (
        await readJson<{ stream?: { gate8?: { hints?: HintsResult } } }>(
          join(dir, "evidence/result.json"),
        )
      )?.stream?.gate8;
      if (r?.hints?.on) problems.push("result.json hints on at /13");
      if (existsSync(join(dir, "evidence/hints.jsonl")))
        problems.push("a /13 capture wrote hints.jsonl");
      detail = `/13 recording valid, no hint records, hints ${r?.hints ? `off (on=${r.hints.on})` : "absent"}`;
    }
    checks.push(
      check(
        "hint-pure",
        "the same fixture at /13 (GRC_STREAM_VERSION=13) validates at /13 with no hint record and no size_override, result.json's hints off and no hints.jsonl",
        problems,
        detail,
      ),
    );
  }

  // --- s1-edge ----------------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    const legs = ["reference", "honest/receiver", "v13/receiver"];
    if (legs.every(ran) && f) {
      problems = [];
      const rects = ex.edges.map((e) => e.rect);
      // the wire: each edge's entry carries the stored size and a size_override of the logical one
      for (const e of ex.edges) {
        const entry = [...f.entries.values()].find(
          (t) =>
            t.width === e.stored[0] &&
            t.height === e.stored[1] &&
            JSON.stringify(t.size_override) === JSON.stringify(e.logical),
        );
        if (!entry)
          problems.push(
            `${e.name}: no ok image ${e.stored.join("x")} with size_override [${e.logical.join(",")}] in the /15 recording`,
          );
      }
      const rows: string[] = [];
      const numbers: Record<string, unknown> = {};
      for (const step of ex.s1.steps) {
        const d15 = await edgeDiff(
          join(g, "reference"),
          join(g, "honest/receiver"),
          step,
          rects,
        );
        const d13 = await edgeDiff(
          join(g, "reference"),
          join(g, "v13/receiver"),
          step,
          rects,
        );
        numbers[`step${step}`] = { v15: d15, v13: d13 };
        if (!d15.present)
          problems.push(`step ${step}: /15 or reference shot missing`);
        else if (
          d15.differing > ex.s1.budget_pixels ||
          d15.differing_frame > ex.s1.budget_pixels
        )
          problems.push(
            `step ${step}: /15 differs from the reference in ${d15.differing} edge pixels (${d15.differing_frame} in the frame, max delta ${d15.max_delta}), budget ${ex.s1.budget_pixels}`,
          );
        if (!d13.present) problems.push(`step ${step}: /13 shot missing`);
        else if (d13.differing < ex.s1.control_min_pixels)
          problems.push(
            `step ${step}: the /13 control differs in only ${d13.differing} edge pixels (want >= ${ex.s1.control_min_pixels}): the fixture does not exercise the size override`,
          );
        rows.push(
          `step ${step}: /15 ${d15.differing} edge px (${d15.differing_frame} frame), /13 ${d13.differing} edge px (${d13.differing_frame} frame, max delta ${d13.max_delta})`,
        );
      }
      report.s1 = numbers;
      detail = rows.join("; ");
    }
    checks.push(
      check(
        "s1-edge",
        "the size override: the /15 recording carries each padded S3TC edge at its stored size with size_override = its logical size, and the native receiver replaying it matches the unarmed reference's shot exactly in the magnified edge rectangles (and the whole frame) at every step drawing them, while the same receiver on the /13 recording (no override: normalized by the stored size) differs there by at least control_min_pixels",
        problems,
        detail,
      ),
    );
  }

  // --- sabotages --------------------------------------------------------------------------------
  const sabReport: Record<string, unknown> = {};
  for (const kind of HINT_SABOTAGES) {
    const rel = `sabotage-${kind}/capture`;
    let problems: string[] | null = null;
    let detail = "";
    if (ran(rel)) {
      problems = [];
      const leg = await readFileLeg(join(g, rel), "rs15");
      const preds = predicates(leg, kind, false);
      const failed = FILE_PREDICATES.filter((id) => preds[id].length > 0);
      const target = SABOTAGE_TARGET[kind];
      if (!failed.includes(target))
        problems.push(`${target} passed on the sabotage leg`);
      for (const id of failed)
        if (id !== target)
          problems.push(
            `${id} failed too: ${preds[id].slice(0, 2).join("; ")}`,
          );
      sabReport[kind] = Object.fromEntries(
        failed.map((id) => [id, preds[id].slice(0, 3)]),
      );
      detail = `sabotage-detected: ${target} fails (${preds[target].slice(0, 2).join("; ")}); every other predicate passes`;
    }
    checks.push(
      check(
        `sabotage-${kind}`,
        `GRC_HINT_SABOTAGE=${kind} fails exactly ${SABOTAGE_TARGET[kind]} and passes every other hint predicate`,
        problems,
        detail,
      ),
    );
  }
  report.sabotages = sabReport;
  return { checks, report };
}
