// Gate 2 group g2b (G2b2): render-stream/2 with textures -- the capture's texture table against its
// hook log, the store directory and inline resource records, cold/warm/patch/inline file-mode
// receivers, a live inline host, the unsupported variant, and the sabotages, each leg classified
// with gate2-design.md Q7's precedence (protocol/gate2-design.md "G2b2").
//
// Everything here reads an evidence directory written by run-gate2.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate2.ts can drive it with fabricated trees.
// Nothing launches a process, and classification never reads `session.sabotage`.
//
// Evidence layout under <out>/ for g2b (besides g2a's, see gate2-checks.ts):
//   capture/                     (g2a) 400 frames: recording.rs2, recording-patch.rs2, store/,
//                                evidence/resources.jsonl, textures.jsonl, steps.jsonl
//   capture-inline/              the same with every payload in band and no store
//   capture-unsupported/         (g2a) RS_FIXTURE_VARIANT=unsupported, with store/
//   reference-unsupported/       rendered fixture, the unsupported variant: shots/step-<k>.png
//   receiver-cold/               rendered receiver, fresh cache/, store = capture/store:
//                                applied.json, shots/seq-<n>.png, state/seq-<n>.json, cache/
//   receiver-warm/               a new receiver process on receiver-cold/cache (mode warm)
//   receiver-patch/              rendered receiver on capture/recording-patch.rs2, own cache
//   receiver-inline/             rendered receiver on capture-inline/recording.rs2, no store
//   receiver-headless-trace/     headless receiver under strace -e openat
//   live-inline/host/, live-inline/receiver/   a live host (S=300, N=60) and a headless live
//                                receiver: tap/stream-1.rs2, receiver/received.rs2
//   unsupported-textures/receiver/             rendered receiver on capture-unsupported
//   sabotage-<name>/capture/, sabotage-<name>/receiver/   (receiver-only sabotages: receiver/)

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  classifyLeg,
  diffRgba,
  joinSettleSeqs,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepJoin,
} from "./gate0-checks";
import {
  type Gate2Expected,
  type Gate2Invariant,
  gate2Regions,
  type Rect4,
  stepFrames2,
  stepOfFrame,
  synthesizeGate2,
} from "./gate2-expected";
import {
  decodeRecord,
  type ResolvedRecording,
  type ResolvedTransaction,
  resolveRecording,
  splitRecords,
  statesEqual,
  type TransactionTexture,
  validateRecording,
} from "./render-stream-2";

// ---------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------

export type G2bClass =
  | "capture-failure"
  | "unsupported"
  | "replay-failure"
  | "delivery-violation"
  | "resource-violation"
  | "pixel-mismatch"
  | "success";

export const G2B_PRECEDENCE: readonly G2bClass[] = [
  "capture-failure",
  "unsupported",
  "replay-failure",
  "delivery-violation",
  "resource-violation",
  "pixel-mismatch",
  "success",
];

export interface G2bCheck {
  id: string;
  criterion: string;
  passed: boolean;
  status: "pass" | "fail" | "not-run";
  detail: string;
  evidence: string[];
}

function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): G2bCheck {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

/** One line of a capture's evidence/resources.jsonl, as G2b2 writes it (the G2a keys, plus the
 * optional trailing `sabotage` / `omitted` and the publisher ops `store` / `inline`). */
export interface HookLine {
  frame: number;
  thread: "main" | "other";
  op: string;
  id: number | null;
  by_id: number | null;
  rid: string | null;
  version: number | null;
  kind: string | null;
  status: string | null;
  reason: string | null;
  format: string | null;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
  data_bytes: number | null;
  payload_bytes: number | null;
  hash: string | null;
  copy_ns: number | null;
  hash_ns: number | null;
  conn: number | null;
  /** G2c2 http-get lines: the status the server answered */
  http_status?: number | null;
  target: string | null;
  sabotage?: boolean;
  omitted?: boolean;
}

/** The publisher's own hook-log ops (gate2-design.md Q3 "Hook log"): not RenderingServer calls. */
export const PUBLISHER_OPS: readonly string[] = [
  "store",
  "inline",
  "publish",
  "pin",
  "retire",
  "http-get",
];

/** A hook-log line that is a RenderingServer texture call the engine made (not a publisher
 * event, not a sabotage's own line). */
export function isEngineCall(line: HookLine): boolean {
  return !PUBLISHER_OPS.includes(line.op) && line.sabotage !== true;
}

export async function loadHookLines(
  dir: string,
): Promise<{ path: string; lines: HookLine[]; problem: string | null }> {
  const path = join(dir, "evidence", "resources.jsonl");
  const text = await readTextOrUndefined(path);
  if (text === undefined) return { path, lines: [], problem: "missing" };
  const lines: HookLine[] = [];
  const raw = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < raw.length; i++) {
    try {
      lines.push(JSON.parse(raw[i]) as HookLine);
    } catch {
      return { path, lines, problem: `line ${i + 1} is not JSON` };
    }
  }
  return { path, lines, problem: null };
}

/** One line of the fixture's RS_FIXTURE_TEXTURE_LOG. */
export interface FixtureLine {
  step: number;
  frame: number;
  op: string;
  name: string;
  thread: "main" | "other";
  payload_sha256: string | null;
}

export async function loadFixtureLines(dir: string): Promise<FixtureLine[]> {
  const text = await readTextOrUndefined(join(dir, "textures.jsonl"));
  if (text === undefined) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as FixtureLine];
      } catch {
        return [];
      }
    });
}

/** A recording, validated and resolved (render-stream-2.ts), or why not. */
export interface Resolved {
  path: string;
  present: boolean;
  bytes: number;
  sha256: string | null;
  errors: string[];
  recording: ResolvedRecording | null;
  /** the wire metas of every record, in order (session, resources, transactions, end) */
  metas: Array<Record<string, unknown>>;
  /** resource records: hash -> payload bytes */
  resources: Map<string, Uint8Array>;
}

export async function loadResolved(path: string): Promise<Resolved> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(path));
  } catch {
    return {
      path,
      present: false,
      bytes: 0,
      sha256: null,
      errors: ["missing"],
      recording: null,
      metas: [],
      resources: new Map(),
    };
  }
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const errors = validateRecording(data);
  let recording: ResolvedRecording | null = null;
  try {
    recording = resolveRecording(data);
  } catch (e) {
    errors.push(`resolveRecording: ${(e as Error).message}`);
  }
  const metas: Array<Record<string, unknown>> = [];
  const resources = new Map<string, Uint8Array>();
  for (const raw of splitRecords(data).records) {
    const { record } = decodeRecord(raw);
    if (!record) break;
    const meta = record.meta as unknown as Record<string, unknown>;
    metas.push(meta);
    if (meta.type === "resource") {
      const start = raw.offset + raw.byte_length - Number(meta.bytes);
      resources.set(
        String(meta.hash),
        data.subarray(start, start + Number(meta.bytes)),
      );
    }
  }
  return {
    path,
    present: true,
    bytes: data.length,
    sha256,
    errors,
    recording,
    metas,
    resources,
  };
}

/** applied.json, render-stream-receiver-applied/3 (gate2-design.md Q5). */
export interface Applied3 {
  schema?: string;
  status?: string;
  failure?: { seq: number | null; reason: string; detail?: string } | null;
  end_seen?: boolean;
  recording?: { path?: string; sha256?: string; bytes?: number } | null;
  transactions?: Array<{
    stream?: number;
    seq?: number;
    frame?: number;
    record_sha256?: string;
    rs_calls?: number | null;
    resources?: Record<string, number> | null;
  }>;
  shots?: Array<{ seq?: number; path?: string; step?: number | null }>;
  unsupported?: Array<{
    seq?: number;
    item?: number | null;
    name?: string;
    reason?: string;
  }>;
  cache?: {
    dir?: string;
    mode?: string;
    entries_before?: number | null;
    entries_after?: number | null;
    bytes_after?: number | null;
  } | null;
  fetches?: Array<{
    stream?: number;
    seq?: number;
    hash?: string;
    source?: string;
    bytes?: number;
    verified?: boolean;
  }>;
  uploads?: Array<{
    stream?: number;
    seq?: number;
    id?: number;
    hash?: string | null;
    op?: string;
    data_bytes?: number;
  }>;
  resources_summary?: {
    distinct_fetched?: number;
    fetched_bytes?: number;
    cache_hits?: number;
    uploads?: number;
    upload_bytes?: number;
  };
}

export async function loadApplied(dir: string): Promise<Applied3 | undefined> {
  return readJson<Applied3>(join(dir, "applied.json"));
}

/** A step's frame window [applied_k, applied_{k+1} - 1], the last through `quit`. */
export function stepWindow(
  expected: Gate2Expected,
  step: number,
  quit: number,
): [number, number] {
  const from = stepFrames2(expected, step).applied;
  const to =
    step < expected.last_step
      ? stepFrames2(expected, step + 1).applied - 1
      : quit;
  return [from, to];
}

export const TRANSFORM_ONLY_STEPS: readonly number[] = [2, 10];

/** The resource counters that must stay 0 in a transform-only window. */
export const TRAFFIC_COUNTERS: readonly string[] = [
  "fetched",
  "fetched_bytes",
  "cache_hits",
  "inline_received",
  "created",
  "updated",
  "replaced",
  "freed",
  "upload_bytes",
];

// ---------------------------------------------------------------------------------------------
// The hook log as ground truth (texture-versions-current, texture-log-divergence)
// ---------------------------------------------------------------------------------------------

interface LogTexture {
  version: number | null;
  kind: string | null;
  status: string | null;
  hash: string | null;
}

/** Replays the hook log's identity lines in order and calls `visit(frame, state)` before the
 * first line of each later frame and at the end; omitted lines (omit-op) change nothing. */
function replayLog(
  lines: readonly HookLine[],
): Array<{ frame: number; state: Map<number, LogTexture> }> {
  const out: Array<{ frame: number; state: Map<number, LogTexture> }> = [];
  const state = new Map<number, LogTexture>();
  let frame = 0;
  for (const l of lines) {
    if (l.omitted === true || PUBLISHER_OPS.includes(l.op)) continue;
    if (l.frame !== frame) {
      if (frame > 0) out.push({ frame, state: new Map(state) });
      frame = l.frame;
    }
    const set = (id: number) =>
      state.set(id, {
        version: l.version,
        kind: l.kind,
        status: l.status,
        hash: l.hash,
      });
    switch (l.op) {
      case "texture_2d_create":
      case "texture_2d_placeholder_create":
      case "texture_2d_update":
        if (l.id !== null) set(l.id);
        break;
      case "canvas_texture_create":
        // G2d finding: a headless (dummy-renderer) capture's canvas_texture_create always
        // returns RID() (servers/rendering/dummy/storage/texture_storage.h:54), and the
        // mirror's own rid==0 guard then never registers it -- so the log's replica must not
        // either, or it would diverge from a table that (correctly) never has this id.
        if (l.id !== null && l.rid !== null) set(l.id);
        break;
      case "canvas_texture_set_channel":
      case "canvas_texture_set_texture_filter":
      case "canvas_texture_set_texture_repeat":
        // Only an update to an id this replica already has live (created with a real rid).
        if (l.id !== null && state.has(l.id)) set(l.id);
        break;
      case "texture_replace":
        if (l.id !== null) set(l.id);
        if (l.by_id !== null) state.delete(l.by_id);
        break;
      case "free":
        if (l.id !== null)
          state.set(l.id, {
            version: l.version,
            kind: l.kind,
            status: "freed",
            hash: null,
          });
        break;
      default:
        break;
    }
  }
  if (frame > 0) out.push({ frame, state: new Map(state) });
  return out;
}

/** Every transaction's texture table against the hook log's state at or before its frame:
 * each entry's version, kind, status (and hash when ok) equal the log's latest; every texture
 * the log holds live is in the table; a table entry the log does not know is a divergence. */
export function textureLogDivergence(
  lines: readonly HookLine[],
  recording: ResolvedRecording,
): string[] {
  const problems: string[] = [];
  const snaps = replayLog(lines);
  let k = -1;
  for (const t of recording.transactions) {
    while (k + 1 < snaps.length && snaps[k + 1].frame <= t.frame) k++;
    const log = k >= 0 ? snaps[k].state : new Map<number, LogTexture>();
    const table = new Map(t.state.textures.map((e) => [e.id, e]));
    for (const e of t.state.textures) {
      const l = log.get(e.id);
      if (!l) {
        problems.push(
          `seq ${t.seq} (frame ${t.frame}): texture ${e.id} is not in the hook log`,
        );
        continue;
      }
      if (e.status === "freed") {
        if (l.status !== "freed" || l.version !== e.version)
          problems.push(
            `seq ${t.seq}: tombstone ${e.id} v${e.version}, the log says ${l.status} v${l.version}`,
          );
        continue;
      }
      if (
        l.version !== e.version ||
        l.kind !== e.kind ||
        l.status !== e.status ||
        (e.status === "ok" && e.kind === "image" && l.hash !== e.hash)
      )
        problems.push(
          `seq ${t.seq} (frame ${t.frame}): texture ${e.id} is ${e.kind}/${e.status} v${e.version} ${e.hash?.slice(0, 12) ?? "-"}, the hook log says ${l.kind}/${l.status} v${l.version} ${l.hash?.slice(0, 12) ?? "-"}`,
        );
    }
    for (const [id, l] of log)
      if (l.status !== "freed" && !table.has(id))
        problems.push(
          `seq ${t.seq} (frame ${t.frame}): the hook log holds texture ${id} (v${l.version}), the table does not`,
        );
    if (problems.length > 8) break;
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Names (fixture objects and items) to wire ids
// ---------------------------------------------------------------------------------------------

/** Fixture texture names to wire ids: each fixture create/placeholder line matched, in order, to
 * the hook-log line of the same op, frame, thread (and hash for content). The first id a name
 * gets is the object's (a later create under the same name is set_image's temporary). */
export function textureIdsByName(
  hook: readonly HookLine[],
  fixture: readonly FixtureLine[],
): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const f of fixture) {
    if (
      f.op !== "texture_2d_create" &&
      f.op !== "texture_2d_placeholder_create" &&
      f.op !== "canvas_texture_create"
    )
      continue;
    const i = hook.findIndex(
      (h, j) =>
        !used.has(j) &&
        h.omitted !== true &&
        h.op === f.op &&
        h.frame === f.frame &&
        h.thread === f.thread &&
        (f.op !== "texture_2d_create" ||
          f.payload_sha256 === null ||
          h.hash === f.payload_sha256),
    );
    if (i < 0) continue;
    used.add(i);
    const id = hook[i].id;
    if (id !== null && !out.has(f.name)) out.set(f.name, id);
    // E is a raw create whose id is retired by the replace into P2: keep it under its own name.
    if (id !== null && f.name === "E") out.set("E", id);
  }
  return out;
}

/** Node items are created in tree order in _ready (expected.json items_at_ready): ids 1.. */
export function itemIdsByName(expected: Gate2Expected): Map<string, number> {
  return new Map(expected.items_at_ready.map((name, i) => [name, i + 1]));
}

// ---------------------------------------------------------------------------------------------
// Settle transactions
// ---------------------------------------------------------------------------------------------

export function settleTransactions(
  expected: Gate2Expected,
  recording: ResolvedRecording,
): Map<number, ResolvedTransaction> {
  const out = new Map<number, ResolvedTransaction>();
  for (const s of expected.steps) {
    const settle = stepFrames2(expected, s.step).settle;
    const t = recording.transactions.find((x) => x.frame === settle);
    if (t) out.set(s.step, t);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checks over captures
// ---------------------------------------------------------------------------------------------

export interface CaptureEvidence {
  leg: string;
  dir: string;
  full: Resolved;
  patch: Resolved;
  hook: Awaited<ReturnType<typeof loadHookLines>>;
  fixture: FixtureLine[];
  result: CaptureResultJson | undefined;
  quit: number;
}

export async function loadCapture(
  outDir: string,
  leg: string,
  rel: string,
  quit: number,
): Promise<CaptureEvidence> {
  const dir = join(outDir, rel);
  return {
    leg,
    dir,
    full: await loadResolved(join(dir, RECORDING_NAME)),
    patch: await loadResolved(join(dir, PATCH_RECORDING_NAME)),
    hook: await loadHookLines(dir),
    fixture: await loadFixtureLines(dir),
    result: await readJson<CaptureResultJson>(
      join(dir, "evidence", "result.json"),
    ),
    quit,
  };
}

export function checkRecordingsDecode(
  captures: readonly CaptureEvidence[],
): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const c of captures) {
    for (const r of [c.full, c.patch]) {
      if (!r.present) problems.push(`${r.path} missing`);
      else if (r.errors.length > 0)
        problems.push(`${r.path}: ${r.errors.slice(0, 2).join(" | ")}`);
      else notes.push(`${c.leg}:${r.recording?.transactions.length ?? 0}`);
    }
  }
  return check(
    "recordings-decode-2",
    "every g2b capture's full and patch recordings decode as render-stream/3 (render-stream/2 before G4e2; framing, meta schema, texture entries and references, versions, resource records, end stats: validateRecording() is [])",
    problems,
    `transactions per sink ${notes.join(", ")}`,
    captures.flatMap((c) => [c.full.path, c.patch.path]),
  );
}

export function checkPatchResolvesToFull(
  captures: readonly CaptureEvidence[],
): G2bCheck {
  const problems: string[] = [];
  let compared = 0;
  for (const c of captures) {
    const f = c.full.recording;
    const p = c.patch.recording;
    if (!f || !p) {
      problems.push(`${c.leg}: a sink did not resolve`);
      continue;
    }
    if (f.transactions.length !== p.transactions.length) {
      problems.push(
        `${c.leg}: ${f.transactions.length} full vs ${p.transactions.length} patch transactions`,
      );
      continue;
    }
    for (let i = 0; i < f.transactions.length; i++) {
      const a = f.transactions[i];
      const b = p.transactions[i];
      if (
        a.seq !== b.seq ||
        a.frame !== b.frame ||
        !statesEqual(a.state, b.state)
      ) {
        problems.push(
          `${c.leg}: seq ${a.seq} (frame ${a.frame}) resolves differently in the patch sink`,
        );
        break;
      }
      compared++;
    }
  }
  return check(
    "patch-resolves-to-full",
    "each capture's patch sink, resolved, equals its full sink at every seq and frame -- textures, removed_textures and the default filter/repeat included -- floats bit for bit",
    problems,
    `${compared} transactions equal across ${captures.length} capture(s)`,
    captures.flatMap((c) => [c.full.path, c.patch.path]),
  );
}

async function sha256File(
  path: string,
): Promise<{ sha: string; bytes: Uint8Array } | null> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    const { createHash } = await import("node:crypto");
    return { sha: createHash("sha256").update(bytes).digest("hex"), bytes };
  } catch {
    return null;
  }
}

async function listGrt(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "sha256")))
      .filter((n) => n.endsWith(".grt"))
      .map((n) => n.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

function okHashes(r: Resolved): Set<string> {
  const out = new Set<string>();
  for (const t of r.recording?.transactions ?? [])
    for (const e of t.state.textures)
      if (e.kind === "image" && e.status === "ok" && e.hash) out.add(e.hash);
  return out;
}

export interface StoreSummary {
  leg: string;
  hashes: number;
  bytes: number;
}

export async function checkStoreComplete(
  captures: readonly CaptureEvidence[],
): Promise<{ check: G2bCheck; stores: StoreSummary[] }> {
  const problems: string[] = [];
  const stores: StoreSummary[] = [];
  for (const c of captures) {
    const store = join(c.dir, "store");
    const files = await listGrt(store);
    const want = new Set([...okHashes(c.full), ...okHashes(c.patch)]);
    let bytes = 0;
    for (const h of want)
      if (!files.includes(h))
        problems.push(`${c.leg}: ok hash ${h} is not in the store`);
    for (const h of files) {
      const f = await sha256File(join(store, "sha256", `${h}.grt`));
      if (!f || f.sha !== h)
        problems.push(
          `${c.leg}: store file ${h}.grt hashes to ${f?.sha ?? "<unreadable>"}`,
        );
      if (!want.has(h))
        problems.push(
          `${c.leg}: store file ${h}.grt names no ok entry of either sink`,
        );
      bytes += f?.bytes.length ?? 0;
    }
    const index = (
      (await readTextOrUndefined(join(store, "index.jsonl"))) ?? ""
    )
      .split("\n")
      .filter((l) => l.trim() !== "");
    const indexed = new Map<string, number>();
    for (const l of index) {
      try {
        const v = JSON.parse(l) as { hash: string; bytes: number };
        indexed.set(v.hash, v.bytes);
      } catch {
        problems.push(`${c.leg}: index.jsonl line is not JSON`);
      }
    }
    if (index.length !== files.length || indexed.size !== files.length)
      problems.push(
        `${c.leg}: index.jsonl has ${index.length} lines (${indexed.size} distinct hashes), the store ${files.length} files`,
      );
    for (const h of files) {
      const f = await sha256File(join(store, "sha256", `${h}.grt`));
      if (!indexed.has(h))
        problems.push(`${c.leg}: index.jsonl does not name ${h}`);
      else if (f && indexed.get(h) !== f.bytes.length)
        problems.push(
          `${c.leg}: index.jsonl says ${h} is ${indexed.get(h)} B, the file ${f.bytes.length} B`,
        );
    }
    stores.push({ leg: c.leg, hashes: files.length, bytes });
  }
  return {
    check: check(
      "store-complete",
      "every ok image hash in either sink of each out-of-band capture is a file sha256/<hash>.grt in its store whose SHA-256 equals its name, the store holds nothing else, and index.jsonl names each stored hash once",
      problems,
      stores
        .map((s) => `${s.leg}: ${s.hashes} payloads, ${s.bytes} B`)
        .join("; "),
      captures.map((c) => join(c.dir, "store")),
    ),
    stores,
  };
}

/** capture-inline vs capture: equal resolved states at every frame (the session's resources
 * aside), every inline payload byte-identical to the store's file, and no store. */
export async function checkInlineEqualsStore(
  capture: CaptureEvidence,
  inline: CaptureEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const a = capture.full.recording;
  const b = inline.full.recording;
  if (!a || !b) problems.push("a recording did not resolve");
  else {
    if (a.transactions.length !== b.transactions.length)
      problems.push(
        `${a.transactions.length} vs ${b.transactions.length} transactions`,
      );
    const n = Math.min(a.transactions.length, b.transactions.length);
    for (let i = 0; i < n; i++) {
      const x = a.transactions[i];
      const y = b.transactions[i];
      if (x.frame !== y.frame || !statesEqual(x.state, y.state)) {
        problems.push(
          `frame ${x.frame}: the inline capture's state differs from the out-of-band one's`,
        );
        break;
      }
    }
  }
  const session = inline.full.metas[0] as
    | { resources?: { delivery?: string; fetch?: string } }
    | undefined;
  if (
    session?.resources?.delivery !== "inline" ||
    session.resources.fetch !== "none"
  )
    problems.push(
      `capture-inline declares delivery ${session?.resources?.delivery}, fetch ${session?.resources?.fetch}`,
    );
  if (await fileExists(join(inline.dir, "store", "index.jsonl")))
    problems.push("capture-inline wrote a store");
  let compared = 0;
  for (const [hash, payload] of inline.full.resources) {
    const f = await sha256File(
      join(capture.dir, "store", "sha256", `${hash}.grt`),
    );
    if (!f)
      problems.push(
        `inline payload ${hash} has no store file in capture/store`,
      );
    else if (Buffer.compare(Buffer.from(f.bytes), Buffer.from(payload)) !== 0)
      problems.push(`inline payload ${hash} differs from the store file`);
    else compared++;
  }
  if (inline.full.resources.size === 0)
    problems.push("capture-inline carries no resource record");
  return check(
    "inline-equals-store",
    "capture-inline (GRC_RESOURCE_INLINE_MAX_BYTES = GRC_RESOURCE_MAX_PAYLOAD_BYTES = 16 MiB, no store) declares delivery inline / fetch none, its resolved states equal capture's at every frame, and every inline payload is byte-identical to capture/store's file of the same hash",
    problems,
    `${b?.transactions.length ?? 0} states equal; ${compared} inline payloads identical to the store`,
    [capture.full.path, inline.full.path, join(capture.dir, "store")],
  );
}

export function checkTextureVersionsCurrent(
  captures: readonly CaptureEvidence[],
): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const c of captures) {
    if (c.hook.problem) {
      problems.push(`${c.leg}: resources.jsonl ${c.hook.problem}`);
      continue;
    }
    for (const r of [c.full, c.patch]) {
      if (!r.recording) {
        problems.push(`${c.leg}: ${r.path} did not resolve`);
        continue;
      }
      const p = textureLogDivergence(c.hook.lines, r.recording);
      problems.push(
        ...p
          .slice(0, 4)
          .map(
            (x) =>
              `${c.leg} ${r.path.endsWith(PATCH_RECORDING_NAME) ? "patch" : "full"}: ${x}`,
          ),
      );
      if (p.length === 0)
        notes.push(`${c.leg}:${r.recording.transactions.length}`);
    }
  }
  return check(
    "texture-versions-current",
    "at every transaction of each capture's sinks, every texture entry's version, kind and status (and hash when ok) equal the hook log's latest line for its id at or before the transaction's frame, every texture the log holds live is in the table, and nothing else is",
    problems,
    `agrees with the hook log at ${notes.join(", ")} transactions`,
    captures.flatMap((c) => [c.hook.path]),
  );
}

export function checkTextureInvariants(
  expected: Gate2Expected,
  capture: CaptureEvidence,
): G2bCheck {
  const problems: string[] = [];
  const rec = capture.full.recording;
  if (!rec)
    return check(
      "texture-invariants",
      "expected.json texture invariants",
      ["capture recording did not resolve"],
      "",
      [],
    );
  const ids = textureIdsByName(capture.hook.lines, capture.fixture);
  const items = itemIdsByName(expected);
  const settle = settleTransactions(expected, rec);
  const logHash = (ref: { op: string; name: string; step: number }) =>
    capture.fixture.find(
      (f) => f.op === ref.op && f.name === ref.name && f.step === ref.step,
    )?.payload_sha256 ?? null;
  const entry = (
    t: ResolvedTransaction,
    name: string,
  ): TransactionTexture | undefined => {
    const id = ids.get(name);
    return id === undefined
      ? undefined
      : t.state.textures.find((e) => e.id === id);
  };
  let evaluated = 0;
  for (const s of expected.steps) {
    const t = settle.get(s.step);
    if (!t) {
      problems.push(`step ${s.step}: no settle transaction`);
      continue;
    }
    for (const inv of s.invariants as Gate2Invariant[]) {
      evaluated++;
      const fail = (why: string) =>
        problems.push(`step ${s.step} ${inv.kind}: ${why}`);
      switch (inv.kind) {
        case "tex_shared_hash": {
          const hashes = inv.textures.map((n) => entry(t, n)?.hash ?? null);
          if (inv.with_log) hashes.push(logHash(inv.with_log));
          if (hashes.some((h) => h === null) || new Set(hashes).size !== 1)
            fail(`hashes ${hashes.join(",")}`);
          break;
        }
        case "tex_kind":
          if (entry(t, inv.texture)?.kind !== inv.value)
            fail(`${inv.texture} is ${entry(t, inv.texture)?.kind}`);
          break;
        case "tex_same_id":
        case "tex_version_bumped": {
          const before = settle.get(inv.step);
          for (const n of inv.textures) {
            const now = entry(t, n);
            const then = before ? entry(before, n) : undefined;
            if (!now || !then)
              fail(`${n} is missing at step ${s.step} or ${inv.step}`);
            else if (
              inv.kind === "tex_version_bumped" &&
              !(now.version > then.version)
            )
              fail(`${n} v${then.version} -> v${now.version}`);
          }
          break;
        }
        case "tex_hash_equals": {
          const want = logHash(inv.log);
          const have = entry(t, inv.texture)?.hash ?? null;
          if (want === null || have !== want)
            fail(
              `${inv.texture} hash ${have}, the fixture's ${JSON.stringify(inv.log)} ${want}`,
            );
          break;
        }
        case "tex_absent":
          for (const n of inv.textures) {
            if (!ids.has(n)) fail(`${n} has no id`);
            else if (entry(t, n))
              fail(`${n} (id ${ids.get(n)}) is still in the table`);
          }
          break;
        case "tex_freed":
          if (entry(t, inv.texture)?.status !== "freed")
            fail(
              `${inv.texture} is ${entry(t, inv.texture)?.status ?? "absent"}`,
            );
          break;
        case "tex_new_ids": {
          const before = rec.transactions.filter(
            (x) => x.frame <= stepFrames2(expected, inv.step).settle,
          );
          const maxBefore = Math.max(
            0,
            ...before.flatMap((x) => x.state.textures.map((e) => e.id)),
          );
          for (const n of inv.textures) {
            const e = entry(t, n);
            if (!e || e.id <= maxBefore)
              fail(`${n} id ${e?.id} is not above ${maxBefore}`);
          }
          break;
        }
        case "no_texture_entries": {
          const before = settle.get(inv.step);
          if (!before || !statesEqual(before.state.textures, t.state.textures))
            fail(`the texture table changed since step ${inv.step}`);
          break;
        }
        case "filter":
        case "repeat": {
          const item = t.state.items.find((i) => i.id === items.get(inv.item));
          const value =
            inv.kind === "filter" ? item?.texture_filter : item?.texture_repeat;
          if (value !== inv.value) fail(`${inv.item} is ${value}`);
          break;
        }
        case "default_filter":
          if (t.state.default_texture_filter !== inv.value)
            fail(`default ${t.state.default_texture_filter}`);
          break;
      }
    }
  }
  // The temporary ids of set_image never reach the table.
  const temp = capture.hook.lines
    .filter((l) => l.op === "texture_replace" && l.by_id !== null)
    .map((l) => l.by_id as number);
  for (const id of temp)
    if (rec.transactions.some((t) => t.state.textures.some((e) => e.id === id)))
      problems.push(`the replaced-away id ${id} appears in a transaction`);
  return check(
    "texture-invariants",
    "every expected.json texture invariant holds on the capture's settle transactions: one id across update and replace, A and Atwin sharing A0's hash, versions bumping, new ids above all earlier ones, the freed P1 tombstone, P2 turning from placeholder to image, the item and root filter/repeat values, unchanged tables at the transform-only steps; and no replaced-away (temporary) id ever appears",
    problems,
    `${evaluated} invariants hold; ids ${[...ids.entries()].map(([n, i]) => `${n}=${i}`).join(" ")}`,
    [capture.full.path, capture.hook.path],
  );
}

// ---------------------------------------------------------------------------------------------
// Receivers
// ---------------------------------------------------------------------------------------------

export interface ReceiverEvidence {
  leg: string;
  dir: string;
  applied: Applied3 | undefined;
  /** the capture it replayed (for file mode) */
  capture: CaptureEvidence | null;
  settle: Map<number, number>;
  log: string;
  exit: number | null;
}

export async function loadReceiver(
  outDir: string,
  leg: string,
  rel: string,
  capture: CaptureEvidence | null,
  expected: Gate2Expected,
): Promise<ReceiverEvidence> {
  const dir = join(outDir, rel);
  const settle = new Map<number, number>();
  const rec = capture?.full.recording;
  if (rec)
    for (const [step, t] of settleTransactions(expected, rec))
      settle.set(step, t.seq);
  return {
    leg,
    dir,
    applied: await loadApplied(dir),
    capture,
    settle,
    log: (await readTextOrUndefined(join(dir, "stdout.log"))) ?? "",
    exit: await readExitCode(dir),
  };
}

/** Per step: the receiver's resource counters summed over the transactions of the step window. */
export function perStepResources(
  expected: Gate2Expected,
  r: ReceiverEvidence,
  quit: number,
): Array<Record<string, number> & { step: number }> {
  return expected.steps.map((s) => {
    const [from, to] = stepWindow(expected, s.step, quit);
    const sum: Record<string, number> = {};
    for (const t of r.applied?.transactions ?? []) {
      if (
        t.frame === undefined ||
        t.frame < from ||
        t.frame > to ||
        !t.resources
      )
        continue;
      for (const [k, v] of Object.entries(t.resources))
        sum[k] = (sum[k] ?? 0) + v;
    }
    return { step: s.step, ...sum };
  });
}

/** Resource-violation evidence on a receiver (gate2-design.md D12): a hash fetched twice in one
 * process, an upload of an id whose content did not change (redundant-upload), and a warm cache
 * receiver fetching a hash its cache held (`warmHashes`). */
export function receiverResourceViolations(
  r: ReceiverEvidence,
  warmHashes: ReadonlySet<string> | null,
): string[] {
  const out: string[] = [];
  const fetched = new Map<string, number>();
  for (const f of r.applied?.fetches ?? []) {
    if (!f.hash) continue;
    fetched.set(f.hash, (fetched.get(f.hash) ?? 0) + 1);
    if (warmHashes?.has(f.hash) && r.applied?.cache?.mode === "warm")
      out.push(
        `warm-cache-fetch: seq ${f.seq} fetched ${f.hash.slice(0, 12)} from ${f.source} although the warm cache holds it`,
      );
  }
  for (const [h, n] of fetched)
    if (n > 1)
      out.push(`redundant-fetch: ${h.slice(0, 12)} fetched ${n} times`);
  const last = new Map<string, string | null>();
  for (const u of r.applied?.uploads ?? []) {
    const key = `${u.stream ?? 1}:${u.id}`;
    if (u.op !== "placeholder" && last.has(key) && last.get(key) === u.hash)
      out.push(
        `redundant-upload: seq ${u.seq} uploads texture ${u.id} again with the same hash ${u.hash?.slice(0, 12)}`,
      );
    last.set(key, u.hash ?? null);
  }
  return out.slice(0, 6);
}

/** Transform-only windows (steps 2 and 10): no engine texture call in the capture's hook log, no
 * texture entry in its patch sink, no receiver traffic. */
export function transformOnlyTraffic(
  expected: Gate2Expected,
  capture: CaptureEvidence,
  receivers: readonly ReceiverEvidence[],
): string[] {
  const out: string[] = [];
  for (const step of TRANSFORM_ONLY_STEPS) {
    const [from, to] = stepWindow(expected, step, capture.quit);
    const calls = capture.hook.lines.filter(
      (l) => l.frame >= from && l.frame <= to && !PUBLISHER_OPS.includes(l.op),
    );
    if (calls.length > 0)
      out.push(
        `transform-only-resource-traffic: step ${step}: hook log ${calls.map((l) => `${l.op}@${l.frame}${l.sabotage ? "(sabotage)" : ""}`).join(",")}`,
      );
    for (const m of capture.patch.metas) {
      if (m.type !== "transaction") continue;
      const frame = Number(m.frame);
      if (frame < from || frame > to) continue;
      const textures = (m.textures as unknown[]) ?? [];
      const removed = (m.removed_textures as unknown[]) ?? [];
      if (textures.length > 0 || removed.length > 0)
        out.push(
          `transform-only-resource-traffic: step ${step}: patch seq ${m.seq} (frame ${frame}) carries ${textures.length} texture entries, ${removed.length} removed`,
        );
    }
    for (const r of receivers) {
      for (const t of r.applied?.transactions ?? []) {
        if (
          t.frame === undefined ||
          t.frame < from ||
          t.frame > to ||
          !t.resources
        )
          continue;
        const busy = TRAFFIC_COUNTERS.filter(
          (k) => (t.resources?.[k] ?? 0) !== 0,
        );
        if (busy.length > 0)
          out.push(
            `transform-only-resource-traffic: step ${step}: ${r.leg} seq ${t.seq} ${busy.map((k) => `${k}=${t.resources?.[k]}`).join(",")}`,
          );
      }
    }
  }
  return out.slice(0, 8);
}

export function checkTransformOnly(
  expected: Gate2Expected,
  capture: CaptureEvidence,
  receivers: readonly ReceiverEvidence[],
): G2bCheck {
  const problems = transformOnlyTraffic(expected, capture, receivers);
  return check(
    "transform-only-no-resource-traffic",
    "inside step 2's and step 10's windows (transform only) the capture's hook log has no texture call, every patch transaction has empty textures and removed_textures, and every receiver transaction (cold, warm, patch, inline) has every resource counter at 0",
    problems,
    `steps ${TRANSFORM_ONLY_STEPS.join(", ")}: no texture call, no texture entry, no fetch, hit or upload in ${receivers.map((r) => r.leg).join(", ")}`,
    [
      capture.hook.path,
      capture.patch.path,
      ...receivers.map((r) => join(r.dir, "applied.json")),
    ],
  );
}

const ACCOUNTED: ReadonlyArray<
  keyof Gate2Expected["steps"][number]["receiver_resources"]
> = ["fetched", "created", "updated", "replaced", "freed"];

export function checkUploadAccounting(
  expected: Gate2Expected,
  quit: number,
  cold: ReceiverEvidence,
  patch: ReceiverEvidence,
  inline: ReceiverEvidence,
): G2bCheck {
  const problems: string[] = [];
  const rows: string[] = [];
  for (const r of [cold, patch, inline]) {
    const per = perStepResources(expected, r, quit);
    for (const s of expected.steps) {
      const have = per.find((p) => p.step === s.step) ?? { step: s.step };
      for (const k of ACCOUNTED) {
        const want =
          r === inline && k === "fetched" ? 0 : s.receiver_resources[k];
        if ((have[k] ?? 0) !== want)
          problems.push(
            `${r.leg} step ${s.step}: ${k} ${have[k] ?? 0}, expected ${want}`,
          );
      }
      if ((have.cache_hits ?? 0) !== 0)
        problems.push(
          `${r.leg} step ${s.step}: ${have.cache_hits} cache hits on a fresh cache`,
        );
      if (
        r === cold &&
        Object.values(s.receiver_resources).some((v) => v !== 0)
      )
        rows.push(
          `${s.step}: ${ACCOUNTED.map((k) => `${k} ${have[k] ?? 0}`).join(" ")}`,
        );
    }
    const inlineReceived = per.reduce(
      (n, p) => n + (p.inline_received ?? 0),
      0,
    );
    if (r === inline && inlineReceived === 0)
      problems.push("receiver-inline received no inline resource record");
    if (r !== inline && inlineReceived !== 0)
      problems.push(
        `${r.leg} received ${inlineReceived} inline records from an out-of-band recording`,
      );
  }
  return check(
    "upload-accounting",
    "per step, the fresh-cache receivers' fetched/created/updated/replaced/freed sums equal expected.json receiver_resources exactly (step 0: A0 once for A and Atwin plus B fetched, A, Atwin, B, P1, P2 created, M neither; 6: 1/1 updated; 7: 2/2 replaced; 8: 2 fetched, 2 created, 2 freed; 9: E and M fetched, P2 replaced, M created), in receiver-cold and receiver-patch; receiver-inline the same uploads with 0 fetches",
    problems,
    rows.join("; "),
    [cold, patch, inline].map((r) => join(r.dir, "applied.json")),
  );
}

async function stateDumps(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const n of (await readdir(join(dir, "state"))).sort())
      out.set(n, await readFile(join(dir, "state", n), "utf8"));
  } catch {
    // none
  }
  return out;
}

async function shotBytes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { createHash } = await import("node:crypto");
  try {
    for (const n of (await readdir(join(dir, "shots"))).sort())
      out.set(
        n,
        createHash("sha256")
          .update(await readFile(join(dir, "shots", n)))
          .digest("hex"),
      );
  } catch {
    // none
  }
  return out;
}

export async function checkWarmCache(
  cold: ReceiverEvidence,
  warm: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const cs = cold.applied?.resources_summary;
  const ws = warm.applied?.resources_summary;
  if (
    (ws?.distinct_fetched ?? -1) !== 0 ||
    (warm.applied?.fetches ?? []).length !== 0
  )
    problems.push(
      `receiver-warm fetched ${ws?.distinct_fetched} hashes (${(warm.applied?.fetches ?? []).length} fetches)`,
    );
  if ((ws?.cache_hits ?? -1) !== (cs?.distinct_fetched ?? -2))
    problems.push(
      `receiver-warm cache hits ${ws?.cache_hits}, receiver-cold fetched ${cs?.distinct_fetched}`,
    );
  if (warm.applied?.cache?.mode !== "warm")
    problems.push(`receiver-warm cache mode ${warm.applied?.cache?.mode}`);
  // The same directory receiver-cold filled (compared by its place in the run directory, so a
  // moved evidence tree still checks).
  const warmDir = (warm.applied?.cache?.dir ?? "").replace(/\/+$/, "");
  const coldDir = (cold.applied?.cache?.dir ?? "").replace(/\/+$/, "");
  if (
    !warmDir.endsWith("/receiver-cold/cache") ||
    !coldDir.endsWith("/receiver-cold/cache") ||
    warmDir !== coldDir
  )
    problems.push(
      `receiver-warm used cache ${warmDir}, not receiver-cold's ${coldDir}`,
    );
  const strip = (a: Applied3 | undefined) =>
    (a?.uploads ?? []).map((u) => [u.seq, u.id, u.hash, u.op, u.data_bytes]);
  if (
    JSON.stringify(strip(cold.applied)) !== JSON.stringify(strip(warm.applied))
  )
    problems.push("the uploads differ");
  const calls = (a: Applied3 | undefined) =>
    (a?.transactions ?? []).map((t) => t.rs_calls);
  if (
    JSON.stringify(calls(cold.applied)) !== JSON.stringify(calls(warm.applied))
  )
    problems.push("rs_calls per transaction differ");
  const [cShots, wShots] = [
    await shotBytes(cold.dir),
    await shotBytes(warm.dir),
  ];
  if (
    cShots.size === 0 ||
    JSON.stringify([...cShots]) !== JSON.stringify([...wShots])
  )
    problems.push(`shots differ (${cShots.size} vs ${wShots.size})`);
  const [cState, wState] = [
    await stateDumps(cold.dir),
    await stateDumps(warm.dir),
  ];
  if (
    cState.size === 0 ||
    JSON.stringify([...cState]) !== JSON.stringify([...wState])
  )
    problems.push(`state dumps differ (${cState.size} vs ${wState.size})`);
  return check(
    "warm-cache",
    "receiver-warm (a new process on receiver-cold's cache, mode warm) fetches nothing, its cache hits equal receiver-cold's fetched hashes, and its uploads, rs_calls per transaction, shots and state dumps are identical to receiver-cold's",
    problems,
    `warm: 0 fetched, ${ws?.cache_hits} cache hits = cold's ${cs?.distinct_fetched} fetched (${cs?.fetched_bytes} B); ${cShots.size} shots, ${cState.size} state dumps identical`,
    [join(cold.dir, "applied.json"), join(warm.dir, "applied.json")],
  );
}

export async function checkFreshCache(
  cold: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const cache = cold.applied?.cache;
  if (cache?.mode !== "fresh" || cache.entries_before !== 0)
    problems.push(`receiver-cold cache ${JSON.stringify(cache)}`);
  const files = await listGrt(join(cold.dir, "cache"));
  const fetched = [
    ...new Set((cold.applied?.fetches ?? []).map((f) => f.hash ?? "")),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(fetched))
    problems.push(
      `cache holds ${files.length} payloads, receiver-cold fetched ${fetched.length}`,
    );
  for (const h of files) {
    const f = await sha256File(join(cold.dir, "cache", "sha256", `${h}.grt`));
    if (f?.sha !== h) problems.push(`cache file ${h} hashes to ${f?.sha}`);
  }
  if (cache?.entries_after !== files.length)
    problems.push(`entries_after ${cache?.entries_after} != ${files.length}`);
  const unverified = (cold.applied?.fetches ?? []).filter(
    (f) => f.verified !== true || f.source !== "directory",
  );
  if (unverified.length > 0)
    problems.push(
      `${unverified.length} fetches not verified / not from the store directory`,
    );
  return check(
    "fresh-cache",
    "receiver-cold's cache was empty at start, and at the end it holds exactly the hashes it fetched (each from the store directory, verified), each file hashing to its name",
    problems,
    `${files.length} payloads, ${cache?.bytes_after} B`,
    [join(cold.dir, "cache"), join(cold.dir, "applied.json")],
  );
}

// ---------------------------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------------------------

export interface G2bCheckpoint {
  leg: string;
  step: number;
  seq: number | null;
  shot: string;
  reference: string;
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  /** mismatching pixels per expected.json region */
  regions: Record<string, number>;
}

/** Receiver shots at the settle seqs against a reference's step shots (full frame, exact), with
 * the per-region mismatch counts. */
export async function receiverCheckpoints(
  expected: Gate2Expected,
  r: ReceiverEvidence,
  referenceDir: string,
  variant?: "unsupported",
): Promise<G2bCheckpoint[]> {
  const out: G2bCheckpoint[] = [];
  for (const s of expected.steps) {
    const seq = r.settle.get(s.step) ?? null;
    const shot = join(r.dir, "shots", `seq-${seq}.png`);
    const reference = join(referenceDir, "shots", `step-${s.step}.png`);
    const cp: G2bCheckpoint = {
      leg: r.leg,
      step: s.step,
      seq,
      shot,
      reference,
      mismatched_pixels: null,
      max_channel_delta: null,
      regions: {},
    };
    out.push(cp);
    if (seq === null) continue;
    const a = await decodePngRgba(reference);
    const b = await decodePngRgba(shot);
    if (!a || !b || a.width !== b.width || a.height !== b.height) continue;
    const d = diffRgba(a.data, b.data, a.width, a.height);
    cp.mismatched_pixels = d.mismatched_pixels;
    cp.max_channel_delta = d.max_channel_delta;
    for (const [name, rect] of Object.entries(
      gate2Regions(expected, s.step, variant),
    ))
      cp.regions[name] = diffRgba(
        a.data,
        b.data,
        a.width,
        a.height,
        rect,
      ).mismatched_pixels;
  }
  return out;
}

/** The session record's meta of a recording (render-stream-2.md "Session record"). */
function sessionMeta(r: Resolved): Record<string, unknown> | null {
  const m = r.metas[0];
  return m && m.type === "session" ? m : null;
}

const HEADLESS_REFUSAL = "canvas-texture-headless";

/** protocol/canvas-texture-headless.md: a headless host cannot allocate a CanvasTexture (the dummy
 * storage's canvas_texture_allocate returns RID(), servers/rendering/dummy/storage/
 * texture_storage.h:54), so it refuses them, typed. On canvas-headless (the `canvas` variant on a
 * headless capture host): the session declares canvas_texture in `unsupported_resources`
 * (canvas-texture-headless) and not in `resources`; every canvas_texture_* hook line is logged
 * `unsupported`/canvas-texture-headless with no id; no transaction carries a canvas texture entry;
 * from step 11 on exactly one item draws an `unsupported` command with reason
 * canvas-texture-headless (and the matching item-level entry), before step 11 none does; the
 * receiver skips it and reports it. The rendered canvas-host declares canvas_texture supported and
 * refuses nothing. */
export function checkCanvasTextureHeadlessRefusal(
  expected: Gate2Expected,
  headless: CaptureEvidence,
  headlessRx: ReceiverEvidence,
  host: CaptureEvidence,
): G2bCheck {
  const problems: string[] = [];
  const feat = (r: Resolved) =>
    (sessionMeta(r)?.features ?? {}) as {
      resources?: string[];
      unsupported_resources?: Array<{ resource: string; reason: string }>;
    };
  const display = (r: Resolved) =>
    ((sessionMeta(r)?.engine ?? {}) as { display_server?: string })
      .display_server;
  const hf = feat(headless.full);
  if (display(headless.full) !== "headless")
    problems.push(
      `canvas-headless: display_server ${display(headless.full)}, expected headless`,
    );
  if (
    (hf.resources ?? []).includes("canvas_texture") ||
    JSON.stringify(hf.unsupported_resources ?? null) !==
      JSON.stringify([{ resource: "canvas_texture", reason: HEADLESS_REFUSAL }])
  )
    problems.push(
      `canvas-headless: features resources ${JSON.stringify(hf.resources)} unsupported_resources ${JSON.stringify(hf.unsupported_resources)}`,
    );
  const of = feat(host.full);
  if (
    display(host.full) === "headless" ||
    !(of.resources ?? []).includes("canvas_texture") ||
    (of.unsupported_resources ?? []).length !== 0
  )
    problems.push(
      `canvas-host: display_server ${display(host.full)}, features resources ${JSON.stringify(of.resources)} unsupported_resources ${JSON.stringify(of.unsupported_resources)}`,
    );
  const ctLines = headless.hook.lines.filter((l) =>
    l.op.startsWith("canvas_texture_"),
  );
  if (!ctLines.some((l) => l.op === "canvas_texture_create"))
    problems.push("canvas-headless: no canvas_texture_create hook line");
  for (const l of ctLines)
    if (
      l.status !== "unsupported" ||
      l.reason !== HEADLESS_REFUSAL ||
      l.id !== null
    )
      problems.push(
        `canvas-headless: hook line ${l.op} @${l.frame} is ${l.status}/${l.reason} id ${l.id}`,
      );
  const f11 = stepFrames2(expected, 11).applied;
  const rec = headless.full.recording;
  if (!rec) problems.push("canvas-headless: recording did not resolve");
  else {
    for (const t of rec.transactions) {
      if (t.state.textures.some((x) => x.kind === "canvas")) {
        problems.push(`canvas-headless seq ${t.seq}: a canvas texture entry`);
        break;
      }
      const refusing = t.state.items.filter((it) =>
        it.commands.some(
          (c) => c.op === "unsupported" && c.reason === HEADLESS_REFUSAL,
        ),
      );
      const entries = t.state.unsupported.filter(
        (u) => u.reason === HEADLESS_REFUSAL,
      );
      const want = t.frame >= f11 ? 1 : 0;
      if (refusing.length !== want || entries.length !== want) {
        problems.push(
          `canvas-headless seq ${t.seq} (frame ${t.frame}): ${refusing.length} items refuse, ${entries.length} entries, expected ${want}`,
        );
        break;
      }
    }
  }
  const a = headlessRx.applied;
  if (a?.status !== "ok")
    problems.push(`canvas-headless receiver status ${a?.status}`);
  if (
    !(a?.unsupported ?? []).some(
      (u: { reason?: string }) => u.reason === HEADLESS_REFUSAL,
    )
  )
    problems.push(
      "canvas-headless receiver reports no canvas-texture-headless entry",
    );
  return check(
    "canvas-texture-headless-refused",
    "a headless capture host refuses CanvasTexture, typed (protocol/canvas-texture-headless.md): canvas-headless's session lists canvas_texture under unsupported_resources (canvas-texture-headless) and not under resources, every canvas_texture_* hook line is unsupported/canvas-texture-headless with no id, no transaction has a canvas entry, from step 11 on exactly one item draws an unsupported canvas-texture-headless command (with its item-level entry) and none before, and the headless receiver skips and reports it; the rendered canvas-host declares canvas_texture supported",
    problems,
    `canvas-headless refuses ${ctLines.length} canvas_texture_* calls and SC's draw; canvas-host supports it`,
    [headless.hook.path, headless.full.path, host.full.path],
  );
}

/** render-stream-2.md: a CanvasTexture's own non-default filter/repeat override the item's
 * (gate2-design.md Q1d). At step 11 the `canvas` variant's SC asks for linear/disabled on the item
 * and nearest/enabled on its CanvasTexture; region sc of canvas-host's own rendered frame (a
 * GPU-backed host: host-renderer evidence, not headless support) equals synthesizeGate2's
 * nearest/enabled. */
export async function checkCanvasTextureOverride(
  expected: Gate2Expected,
  hostDir: string,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const want = synthesizeGate2(expected, 11);
  const region = gate2Regions(expected, 11).sc;
  const path = join(hostDir, "shots", "step-11.png");
  const got = await decodePngRgba(path);
  let bad = 0;
  if (!got || !region) {
    problems.push(`${path} or region sc unreadable`);
  } else {
    for (let y = region[1]; y < region[1] + region[3]; y++)
      for (let x = region[0]; x < region[0] + region[2]; x++) {
        const i = (y * want.width + x) * 4;
        if ([0, 1, 2, 3].some((c) => want.rgba[i + c] !== got.data[i + c]))
          bad++;
      }
    if (bad > 0)
      problems.push(
        `${bad} px of region sc differ from synthesizeGate2 (nearest, repeat enabled)`,
      );
  }
  return check(
    "canvas-texture-override",
    "at step 11, region sc of canvas-host's own rendered frame (SC's CanvasTexture CT: diffuse A, texture_filter nearest, texture_repeat enabled; SC's own item filter linear, repeat disabled) equals synthesizeGate2 (nearest, enabled) exactly: the canvas texture's own filter and repeat override the item's (host-renderer evidence)",
    problems,
    `region sc exact (${bad} px differ)`,
    [path],
  );
}

/** render-stream-2.md "Texture" (kind canvas), on canvas-host (the rendered capture host of the
 * `canvas` variant, the only kind of host that allocates a CanvasTexture): CT's wire entry at
 * step 11 is kind canvas, status ok, diffuse A's id, filter nearest, repeat enabled, and its
 * version is above 1 (each setter bumped it once from the create's 1). */
export function checkCanvasTextureWire(
  expected: Gate2Expected,
  host: CaptureEvidence,
): G2bCheck {
  const problems: string[] = [];
  const rec = host.full.recording;
  if (!rec) {
    return check(
      "canvas-texture-wire",
      "canvas-host's recording resolves, and at step 11 CT is kind canvas, status ok, diffuse A's id, filter nearest, repeat enabled, version > 1",
      ["canvas-host recording did not resolve"],
      "",
      [host.full.path],
    );
  }
  const ids = textureIdsByName(host.hook.lines, host.fixture);
  const settle = settleTransactions(expected, rec);
  const t11 = settle.get(11);
  const ctId = ids.get("CT");
  const aId = ids.get("A");
  if (!t11 || ctId === undefined || aId === undefined) {
    problems.push(
      `missing settle transaction or ids (ct=${ctId}, a=${aId}, t11=${!!t11})`,
    );
  } else {
    const ct = t11.state.textures.find((e) => e.id === ctId);
    if (ct?.kind !== "canvas") {
      problems.push(`CT is ${ct?.kind ?? "absent"}, expected canvas`);
    } else if (ct.status !== "ok") {
      problems.push(`CT status ${ct.status}`);
    } else if (!ct.canvas || ct.canvas.diffuse !== aId) {
      problems.push(`CT diffuse ${ct.canvas?.diffuse}, expected A's id ${aId}`);
    } else if (
      ct.canvas.filter !== "nearest" ||
      ct.canvas.repeat !== "enabled"
    ) {
      problems.push(
        `CT filter/repeat ${ct.canvas.filter}/${ct.canvas.repeat}, expected nearest/enabled`,
      );
    } else if (!(ct.version > 1)) {
      problems.push(
        `CT version ${ct.version}, expected > 1 (each setter bumps it)`,
      );
    }
  }
  return check(
    "canvas-texture-wire",
    "on canvas-host (a rendered, GPU-backed capture host; host-renderer evidence): CT's wire entry at step 11 is kind canvas, status ok, diffuse A's id, filter nearest, repeat enabled, with version above 1",
    problems,
    problems.length === 0 ? "CT correct on the rendered host" : "",
    [host.hook.path, host.full.path],
  );
}

export function mismatchingSteps(cps: readonly G2bCheckpoint[]): number[] {
  return cps
    .filter((c) => c.mismatched_pixels === null || c.mismatched_pixels > 0)
    .map((c) => c.step);
}

export function checkReceiverVsReference(
  cps: readonly G2bCheckpoint[],
): G2bCheck {
  const problems = cps
    .filter((c) => c.mismatched_pixels === null || c.mismatched_pixels > 0)
    .map(
      (c) =>
        `${c.leg} step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "unreadable"} px differ (max ${c.max_channel_delta ?? "?"})`,
    );
  const legs = [...new Set(cps.map((c) => c.leg))];
  return check(
    "receiver-vs-reference",
    "every successful receiver's shot at each step's settle seq (receiver-cold, -warm, -patch, -inline) equals the reference's step shot exactly, full frame, synth_exclude regions included (the G2a repeat budget is 0)",
    problems.slice(0, 8),
    `${cps.length} shots across ${legs.join(", ")} byte-exact`,
    cps.map((c) => c.shot),
  );
}

export async function checkExpectedImageReceiver(
  expected: Gate2Expected,
  r: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  let n = 0;
  for (const s of expected.steps) {
    const seq = r.settle.get(s.step);
    const shot = join(r.dir, "shots", `seq-${seq}.png`);
    const got = await decodePngRgba(shot);
    const want = synthesizeGate2(expected, s.step);
    if (!got || got.width !== want.width) {
      problems.push(`step ${s.step}: ${shot} unreadable`);
      continue;
    }
    const regions = gate2Regions(expected, s.step);
    const excluded = s.synth_exclude.map((name) => regions[name]);
    let bad = 0;
    for (let y = 0; y < want.height; y++)
      for (let x = 0; x < want.width; x++) {
        if (
          excluded.some(
            ([rx, ry, rw, rh]) =>
              x >= rx && x < rx + rw && y >= ry && y < ry + rh,
          )
        )
          continue;
        const i = (y * want.width + x) * 4;
        for (let c = 0; c < 4; c++)
          if (want.rgba[i + c] !== got.data[i + c]) {
            bad++;
            break;
          }
      }
    if (bad > 0)
      problems.push(
        `step ${s.step}: ${bad} px differ from synthesizeGate2 outside synth_exclude`,
      );
    n++;
  }
  return check(
    "expected-image-receiver",
    "receiver-cold's shot at each step's settle seq equals synthesizeGate2(step) exactly outside the step's synth_exclude regions (inside them receiver-vs-reference holds it to the reference)",
    problems,
    `${n} receiver shots match the synthesis exactly`,
    [join(r.dir, "shots")],
  );
}

/** A rect of a shot is one colour. */
async function rectIs(
  path: string,
  rect: Rect4,
  rgba: number[],
): Promise<string | null> {
  const img = await decodePngRgba(path);
  if (!img) return `${path} unreadable`;
  for (let y = rect[1]; y < rect[1] + rect[3]; y++)
    for (let x = rect[0]; x < rect[0] + rect[2]; x++) {
      const i = (y * img.width + x) * 4;
      if ([0, 1, 2, 3].some((c) => img.data[i + c] !== rgba[c]))
        return `${path} (${x},${y}) is ${[...img.data.subarray(i, i + 4)].join(",")}`;
    }
  return null;
}

export async function checkFreedDrawsDefault(
  expected: Gate2Expected,
  referenceDir: string,
  cold: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  // RAW1 draws its 32x32 rect at (432, 40) on the root canvas; step 8 has no canvas offset.
  const raw1: Rect4 = [432, 40, 32, 32];
  const ref = await rectIs(
    join(referenceDir, "shots", "step-8.png"),
    raw1,
    [255, 255, 255, 255],
  );
  const rec = await rectIs(
    join(cold.dir, "shots", `seq-${cold.settle.get(8)}.png`),
    raw1,
    [255, 255, 255, 255],
  );
  if (ref) problems.push(`reference: ${ref}`);
  if (rec) problems.push(`receiver-cold: ${rec}`);
  void expected;
  return check(
    "freed-draws-default",
    "at step 8 RAW1's 32x32 rect is white (255,255,255) in the reference and in receiver-cold: the freed P1 tombstone draws the engine's default texture on both sides (D11)",
    problems,
    "RAW1 white in both",
    [join(referenceDir, "shots", "step-8.png"), join(cold.dir, "shots")],
  );
}

export async function checkCopyAtHook(
  expected: Gate2Expected,
  referenceDir: string,
  cold: ReceiverEvidence,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const want = synthesizeGate2(expected, 8);
  const region = gate2Regions(expected, 8).s3;
  let pink = 0;
  for (const [leg, path] of [
    ["reference", join(referenceDir, "shots", "step-8.png")],
    ["receiver-cold", join(cold.dir, "shots", `seq-${cold.settle.get(8)}.png`)],
  ] as const) {
    const got = await decodePngRgba(path);
    if (!got || !region) {
      problems.push(`${leg}: ${path} unreadable`);
      continue;
    }
    let bad = 0;
    let found = 0;
    for (let y = region[1]; y < region[1] + region[3]; y++)
      for (let x = region[0]; x < region[0] + region[2]; x++) {
        const i = (y * want.width + x) * 4;
        if ([0, 1, 2, 3].some((c) => want.rgba[i + c] !== got.data[i + c]))
          bad++;
        if (
          got.data[i] === 255 &&
          got.data[i + 1] === 51 &&
          got.data[i + 2] === 153
        )
          found++;
      }
    if (bad > 0)
      problems.push(
        `${leg}: ${bad} px of region s3 differ from the synthesis of C's pre-fill content`,
      );
    if (found === 0)
      problems.push(`${leg}: no pixel of C's (1,.2,.6) corner in region s3`);
    pink = Math.max(pink, found);
  }
  return check(
    "copy-at-hook",
    "S3 at step 8 shows C's pre-fill colours (its image was filled black right after the create) in the reference and in receiver-cold: region s3 equals the synthesis and contains C's (1,.2,.6) top-left",
    problems,
    `region s3 exact in both; ${pink} px of C's top-left colour`,
    [join(referenceDir, "shots", "step-8.png"), join(cold.dir, "shots")],
  );
}

/** The unsupported variant's receiver against the variant's own reference: it differs in u1 and
 * u2 (both skipped, typed refusal) at every step and nowhere else. */
export function checkUnsupportedRegions(
  cps: readonly G2bCheckpoint[],
  expected: Gate2Expected,
): G2bCheck {
  const problems: string[] = [];
  for (const c of cps) {
    if (c.mismatched_pixels === null) {
      problems.push(`step ${c.step}: shot unreadable`);
      continue;
    }
    const inU = (c.regions.u1 ?? 0) + (c.regions.u2 ?? 0);
    if ((c.regions.u1 ?? 0) === 0 || (c.regions.u2 ?? 0) === 0)
      problems.push(
        `step ${c.step}: u1 ${c.regions.u1} / u2 ${c.regions.u2} px differ, expected both > 0`,
      );
    if (c.mismatched_pixels !== inU)
      problems.push(
        `step ${c.step}: ${c.mismatched_pixels - inU} px differ outside u1/u2`,
      );
  }
  if (cps.length !== expected.steps.length)
    problems.push(`${cps.length} checkpoints`);
  return check(
    "unsupported-regions",
    "unsupported-textures: the receiver on the unsupported variant's recording differs from that variant's rendered reference in regions u1 (RGBAF, unsupported-format) and u2 (PRE, unknown-texture) at every step, and nowhere else",
    problems,
    cps.map((c) => `${c.step}:${c.regions.u1}/${c.regions.u2}`).join(" "),
    cps.map((c) => c.shot),
  );
}

/** G2d: canvas-normal variant. CT.normal_texture = B makes the canvas texture unsupported
 * (canvas-texture-channel), so SC's command is skipped and recorded, never drawn with a
 * substitute (D10). SC draws nothing in either the variant or the plain reference before step
 * 11, so this leg differs from the plain reference only in region sc, and only from step 11 on. */
export function checkCanvasNormalRegion(
  cps: readonly G2bCheckpoint[],
): G2bCheck {
  const problems: string[] = [];
  for (const c of cps) {
    if (c.mismatched_pixels === null) {
      problems.push(`step ${c.step}: shot unreadable`);
      continue;
    }
    const sc = c.regions.sc ?? 0;
    if (c.step < 11) {
      if (c.mismatched_pixels !== 0)
        problems.push(
          `step ${c.step}: ${c.mismatched_pixels} px differ before step 11`,
        );
    } else {
      if (sc === 0)
        problems.push(`step ${c.step}: 0 px differ in region sc, expected > 0`);
      if (c.mismatched_pixels !== sc)
        problems.push(
          `step ${c.step}: ${c.mismatched_pixels - sc} px differ outside region sc`,
        );
    }
  }
  return check(
    "canvas-normal-region",
    "canvas-normal: the receiver on the canvas-normal variant's recording differs from the plain reference only in region sc, and only from step 11 on (CT.normal_texture = B makes the canvas texture unsupported, canvas-texture-channel)",
    problems,
    cps.map((c) => `${c.step}:${c.regions.sc ?? 0}`).join(" "),
    cps.map((c) => c.shot),
  );
}

// ---------------------------------------------------------------------------------------------
// Receiver hygiene
// ---------------------------------------------------------------------------------------------

export function checkReceiverTypedClean(
  receivers: readonly ReceiverEvidence[],
): G2bCheck {
  const problems: string[] = [];
  for (const r of receivers)
    for (const marker of [
      "SCRIPT ERROR",
      "SCRIPT WARNING",
      "Parse Error",
      "Failed to load script",
    ])
      if (r.log.includes(marker))
        problems.push(`${r.leg}: stdout.log contains ${marker}`);
  return check(
    "receiver-typed-clean",
    "no g2b receiver log has a SCRIPT ERROR, SCRIPT WARNING, Parse Error or Failed to load script line",
    problems,
    `${receivers.length} receiver logs clean`,
    receivers.map((r) => join(r.dir, "stdout.log")),
  );
}

export async function checkReceiverConsumedStream(
  receivers: readonly ReceiverEvidence[],
): Promise<G2bCheck> {
  const problems: string[] = [];
  for (const r of receivers) {
    if (!r.capture) continue;
    const copy = await sha256File(join(r.dir, RECORDING_NAME));
    const src = r.applied?.recording?.sha256;
    if (!copy || src !== copy.sha)
      problems.push(
        `${r.leg}: applied.json recording sha ${src} != its copy ${copy?.sha}`,
      );
  }
  return check(
    "receiver-consumed-stream",
    "every file-mode g2b receiver read exactly its own copy of a capture recording (applied.json recording.sha256 equals the copy's)",
    problems,
    `${receivers.filter((r) => r.capture).length} receivers`,
    receivers.map((r) => join(r.dir, "applied.json")),
  );
}

export async function checkReceiverNeverLoadedFixture(
  outDir: string,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const dir = join(outDir, "receiver-headless-trace");
  const strace = await readTextOrUndefined(join(dir, "strace.txt"));
  const argv = (await readTextOrUndefined(join(dir, "argv.txt"))) ?? "";
  if (strace === undefined) problems.push("strace.txt missing");
  else {
    const opens = strace
      .split("\n")
      .filter((l) => /openat\(/.test(l) && !/= -1/.test(l));
    const fixture = opens.filter((l) => l.includes("/fixtures/"));
    if (fixture.length > 0)
      problems.push(
        `opened ${fixture.length} fixture path(s): ${fixture[0].trim()}`,
      );
    if (!opens.some((l) => l.includes(`${RECORDING_NAME}"`)))
      problems.push(`never opened its ${RECORDING_NAME}`);
    if (!opens.some((l) => l.includes("/store/sha256/")))
      problems.push("never read the capture's store");
  }
  if (!argv.includes("/receiver"))
    problems.push("argv does not run the receiver project");
  return check(
    "receiver-never-loaded-fixture",
    "the headless receiver under strace -e openat opens nothing under fixtures/, opens its recording and reads payloads from the capture's store",
    problems,
    "receiver-headless-trace clean",
    [join(dir, "strace.txt")],
  );
}

// ---------------------------------------------------------------------------------------------
// Live inline (G2b2 "Live before HTTP")
// ---------------------------------------------------------------------------------------------

export interface LiveEvidence {
  host: CaptureEvidence;
  received: Resolved;
  tap: Resolved;
  receiver: ReceiverEvidence;
  summary:
    | {
        connections?: Array<{
          resource_records?: number;
          resource_bytes?: number;
          sent?: number;
        }>;
      }
    | undefined;
}

export async function loadLive(
  outDir: string,
  expected: Gate2Expected,
): Promise<LiveEvidence> {
  const host = await loadCapture(
    outDir,
    "live-inline/host",
    "live-inline/host",
    971, // the live timeline's quit, S + N*11 + 11 (run-gate2.sh LIVE_QUIT_FRAME)
  );
  return {
    host,
    received: await loadResolved(
      join(outDir, "live-inline", "receiver", "received.rs2"),
    ),
    tap: await loadResolved(
      join(outDir, "live-inline", "host", "tap", "stream-1.rs2"),
    ),
    receiver: await loadReceiver(
      outDir,
      "live-inline",
      "live-inline/receiver",
      null,
      expected,
    ),
    summary: await readJson(
      join(outDir, "live-inline", "host", "evidence", "live-summary.json"),
    ),
  };
}

export function checkLiveInline(live: LiveEvidence): G2bCheck {
  const problems: string[] = [];
  const session = live.received.metas[0] as
    | {
        resources?: {
          delivery?: string;
          fetch?: string;
          http_path?: string | null;
        };
      }
    | undefined;
  if (
    session?.resources?.delivery !== "inline" ||
    session.resources.fetch !== "none" ||
    session.resources.http_path !== null
  )
    problems.push(
      `the live session declares ${JSON.stringify(session?.resources)}`,
    );
  if (live.received.errors.length > 0)
    problems.push(`received.rs2: ${live.received.errors[0]}`);
  if (!live.received.present || live.received.sha256 !== live.tap.sha256)
    problems.push("received.rs2 differs from the host's tap");
  if (live.received.resources.size === 0)
    problems.push("no resource record on the live stream");
  const okHashesLive = okHashes(live.received);
  for (const h of okHashesLive)
    if (!live.received.resources.has(h))
      problems.push(`hash ${h} never arrived as a resource record`);
  if ((live.receiver.applied?.fetches ?? []).length > 0)
    problems.push(
      `the live receiver fetched ${(live.receiver.applied?.fetches ?? []).length} payloads`,
    );
  const rr = live.summary?.connections?.[0]?.resource_records ?? 0;
  if (rr !== live.received.resources.size)
    problems.push(
      `live-summary resource_records ${rr} != ${live.received.resources.size} records received`,
    );
  // The live stream resolves to the host's own recording at the same frames.
  const host = live.host.full.recording;
  let matched = 0;
  for (const t of live.received.recording?.transactions ?? []) {
    const h = host?.transactions.find((x) => x.frame === t.frame);
    if (!h || !statesEqual(h.state, t.state)) {
      problems.push(
        `live seq ${t.seq} (frame ${t.frame}) does not equal the host recording's state at that frame`,
      );
      break;
    }
    matched++;
  }
  return check(
    "live-inline",
    "the live connection declares delivery inline / fetch none / no http path (its host asks for inline delivery under the 1 MiB live cap), every ok hash it names arrives as a resource record before the transaction that needs it (validateRecording of received.rs2 is []), received.rs2 equals the host's tap byte for byte, the receiver fetches nothing, the host's summary counts the same resource records, and every live transaction resolves to the host recording's state at its frame",
    problems,
    `${live.received.resources.size} resource records (${[...live.received.resources.values()].reduce((n, b) => n + b.length, 0)} B), ${matched} transactions equal to the host recording`,
    [
      live.received.path,
      live.tap.path,
      join(live.receiver.dir, "applied.json"),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Classification (gate2-design.md Q7)
// ---------------------------------------------------------------------------------------------

export interface G2bLegInput {
  capture: CaptureEvidence;
  receiver: ReceiverEvidence | null;
  /** receiver shots vs the reference (empty for headless receivers) */
  checkpoints: G2bCheckpoint[];
  /** extra resource-violation evidence (e.g. a warm cache's hashes) */
  warmHashes?: ReadonlySet<string> | null;
  expected: Gate2Expected;
  /** the capture recording the receiver replayed (default the full sink) */
  source?: string;
}

export interface G2bClassification {
  result_class: G2bClass;
  reasons: string[];
  mismatching_steps: number[];
}

function recordingSummaryFor(
  c: CaptureEvidence,
  source = RECORDING_NAME,
): Promise<RecordingSummary> {
  return loadRecording(join(c.dir, source));
}

export async function classifyG2bLeg(
  input: G2bLegInput,
): Promise<G2bClassification> {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);
  const recording = await recordingSummaryFor(input.capture, input.source);
  let stepJoin: StepJoin | undefined;
  if (input.receiver?.capture) {
    stepJoin = joinSettleSeqs(
      parseStepLog(
        await readTextOrUndefined(join(input.capture.dir, "steps.jsonl")),
      ),
      recording.transactions,
    );
  }
  const r = input.receiver;
  const shotSeqs = r ? [...r.settle.values()] : [];
  const shotFiles: number[] = [];
  if (r)
    for (const s of shotSeqs)
      if (await fileExists(join(r.dir, "shots", `seq-${s}.png`)))
        shotFiles.push(s);
  const base = classifyLeg({
    captureResult: input.capture.result,
    recording,
    stepJoin,
    receiver: r
      ? {
          applied: r.applied as never,
          requestedShotSeqs: input.checkpoints.length > 0 ? shotSeqs : [],
          shotFiles,
        }
      : undefined,
    checkpoints: [],
  });
  for (const reason of base.reasons) {
    const cls = reason.slice(0, reason.indexOf(":")) as G2bClass;
    fired.set(cls, [...(fired.get(cls) ?? []), reason]);
  }
  // capture-failure: the stream's own failures beyond gate 1's (G2b2: a store failure or the
  // budget closes the stream with a reason), and texture-log-divergence.
  const streamReason = input.capture.result?.stream?.reason;
  if (streamReason) fire("capture-failure", `stream.reason ${streamReason}`);
  if (input.capture.full.recording && !input.capture.hook.problem) {
    const d = textureLogDivergence(
      input.capture.hook.lines,
      input.capture.full.recording,
    );
    if (d.length > 0)
      fire("capture-failure", `texture-log-divergence: ${d[0]}`);
  } else if (input.capture.hook.problem)
    fire("capture-failure", `resources.jsonl ${input.capture.hook.problem}`);
  // resource-violation
  for (const v of transformOnlyTraffic(
    input.expected,
    input.capture,
    r ? [r] : [],
  ))
    fire("resource-violation", v);
  if (r)
    for (const v of receiverResourceViolations(r, input.warmHashes ?? null))
      fire("resource-violation", v);
  // pixel-mismatch
  const mismatching = mismatchingSteps(input.checkpoints);
  for (const step of mismatching) {
    const c = input.checkpoints.find((x) => x.step === step);
    fire(
      "pixel-mismatch",
      `step ${step} (seq ${c?.seq}): ${c?.mismatched_pixels ?? "unreadable"} px differ`,
    );
  }
  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    result_class,
    reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
    mismatching_steps: mismatching,
  };
}

/** Classification of the live inline leg: the host capture, the receiver's status, delivery
 * (received equals the tap), and resource traffic (a live receiver must fetch nothing before
 * G2c2). */
export function classifyLive(live: LiveEvidence): G2bClassification {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);
  const res = live.host.result;
  if (
    res?.status !== "armed" ||
    res?.stream?.status !== "closed" ||
    res?.stream?.reason
  )
    fire(
      "capture-failure",
      `host status ${res?.status} stream ${res?.stream?.status} ${res?.stream?.reason ?? ""}`,
    );
  for (const r of [live.host.full, live.host.patch])
    if (r.errors.length > 0)
      fire("capture-failure", `${r.path}: ${r.errors[0]}`);
  if (live.host.full.recording && !live.host.hook.problem) {
    const d = textureLogDivergence(
      live.host.hook.lines,
      live.host.full.recording,
    );
    if (d.length > 0)
      fire("capture-failure", `texture-log-divergence: ${d[0]}`);
  }
  for (const t of live.received.recording?.transactions ?? [])
    if (t.state.unsupported.length > 0) {
      fire(
        "unsupported",
        `seq ${t.seq}: ${t.state.unsupported.map((u) => `${u.op}/${u.reason}`).join(",")}`,
      );
      break;
    }
  const a = live.receiver.applied;
  if (a?.status !== "ok" || a.end_seen !== true)
    fire(
      "replay-failure",
      `applied status ${a?.status} ${JSON.stringify(a?.failure ?? null)}`,
    );
  if (live.received.errors.length > 0)
    fire("replay-failure", `received.rs2: ${live.received.errors[0]}`);
  if (live.received.sha256 !== live.tap.sha256)
    fire("delivery-violation", "received.rs2 differs from the host tap");
  if ((a?.fetches ?? []).length > 0)
    fire(
      "resource-violation",
      `the inline live receiver fetched ${(a?.fetches ?? []).length} payloads`,
    );
  for (const v of receiverResourceViolations(live.receiver, null))
    fire("resource-violation", v);
  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    result_class,
    reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
    mismatching_steps: [],
  };
}

/** gate2-design.md G2b2 "Legs (group g2b)": expected class and the reason or step set each leg
 * must show. */
export interface G2bLegExpectation {
  leg: string;
  expected_class: G2bClass;
  /** the classification must give exactly these mismatching steps */
  steps?: number[];
  /** some reason of the expected class must contain this text */
  reason?: string;
}

/** G2d's legs (group g2d): evaluated by runG2b, since they reuse its captures, reference and
 * receiver checks, but only when g2d ran. */
export const G2D_LEG_NAMES: readonly string[] = [
  "canvas-headless",
  "canvas-host",
  "canvas-normal",
  "sabotage-omit-canvas-filter",
];

export const G2B_LEGS: readonly G2bLegExpectation[] = [
  { leg: "receiver-cold", expected_class: "success" },
  { leg: "receiver-warm", expected_class: "success" },
  { leg: "receiver-patch", expected_class: "success" },
  { leg: "receiver-inline", expected_class: "success" },
  { leg: "live-inline", expected_class: "success" },
  {
    leg: "unsupported-textures",
    expected_class: "unsupported",
    reason: "unknown-texture",
  },
  { leg: "sabotage-omit-update", expected_class: "pixel-mismatch", steps: [6] },
  {
    leg: "sabotage-omit-replace",
    expected_class: "pixel-mismatch",
    // G2d: A stays stuck at A1's shape and P2 stuck as a placeholder forever (the dropped
    // texture_replace is never retried), so step 11's SC, which also samples A, inherits the
    // same mismatch the other A-drawing items already show from step 7 on.
    steps: [7, 8, 9, 10, 11],
  },
  {
    leg: "sabotage-stale-texture",
    expected_class: "capture-failure",
    reason: "texture-log-divergence",
  },
  {
    leg: "sabotage-wrong-hash",
    expected_class: "replay-failure",
    reason: "resource-hash-mismatch",
  },
  {
    leg: "sabotage-spurious-update",
    expected_class: "resource-violation",
    reason: "transform-only-resource-traffic",
  },
  {
    leg: "sabotage-receiver-reupload",
    expected_class: "resource-violation",
    reason: "redundant-upload",
  },
  {
    leg: "sabotage-receiver-ignore-cache",
    expected_class: "resource-violation",
    reason: "warm-cache-fetch",
  },
  // G2d. canvas-headless: the `canvas` variant on a headless host, refused typed
  // (protocol/canvas-texture-headless.md). canvas-host, canvas-normal and the sabotage run on a
  // rendered host: host-renderer evidence, not headless support.
  {
    leg: "canvas-headless",
    expected_class: "unsupported",
    reason: "canvas-texture-headless",
  },
  { leg: "canvas-host", expected_class: "success" },
  {
    leg: "canvas-normal",
    expected_class: "unsupported",
    reason: "unsupported-texture",
  },
  {
    leg: "sabotage-omit-canvas-filter",
    expected_class: "pixel-mismatch",
    steps: [11],
  },
];

export function checkLegClass(
  e: G2bLegExpectation,
  c: G2bClassification,
  extra: string[] = [],
  evidence: string[] = [],
): G2bCheck {
  const problems: string[] = [...extra];
  if (c.result_class !== e.expected_class)
    problems.push(
      `class ${c.result_class}, expected ${e.expected_class}: ${c.reasons.slice(0, 3).join(" | ")}`,
    );
  if (
    e.steps &&
    JSON.stringify(c.mismatching_steps) !== JSON.stringify(e.steps)
  )
    problems.push(
      `mismatching steps {${c.mismatching_steps.join(",")}}, predicted {${e.steps.join(",")}}`,
    );
  if (
    e.reason &&
    !c.reasons.some(
      (r) =>
        r.startsWith(`${e.expected_class}:`) && r.includes(e.reason as string),
    )
  )
    problems.push(`no ${e.expected_class} reason mentions ${e.reason}`);
  return check(
    `leg-class-${e.leg}`,
    `${e.leg} classifies as ${e.expected_class}${e.reason ? ` (${e.reason})` : ""}${e.steps ? `, steps {${e.steps.join(",")}}` : ""}`,
    problems,
    `${c.result_class}${c.mismatching_steps.length > 0 ? ` steps {${c.mismatching_steps.join(",")}}` : ""}: ${c.reasons[0] ?? "no reason fired"}`,
    evidence,
  );
}

// ---------------------------------------------------------------------------------------------
// The g2b group
// ---------------------------------------------------------------------------------------------

export interface G2bLegReport {
  group: "g2b" | "g2d";
  expected_class: G2bClass | null;
  result_class: G2bClass | null;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G2bResources {
  store: { hashes: number; bytes: number } | null;
  receiver: Applied3["resources_summary"] | null;
  per_step: Array<{
    step: number;
    fetched: number;
    fetched_bytes: number;
    uploads: number;
    upload_bytes: number;
    cache_hits: number;
  }> | null;
  host: {
    retained_bytes_max: number | null;
    resource_records: number | null;
    resource_bytes: number | null;
    full_bytes: number | null;
    patch_bytes: number | null;
    inline_bytes: number | null;
  } | null;
}

export interface G2bResult {
  checks: G2bCheck[];
  legs: Record<string, G2bLegReport>;
  checkpoints: G2bCheckpoint[];
  resources: Record<string, G2bResources>;
}

/** `stream: store ... retained_bytes_max=<n>` from a capture's stdout.log. */
async function retainedBytesMax(dir: string): Promise<number | null> {
  const m = /retained_bytes_max=(\d+)/.exec(
    (await readTextOrUndefined(join(dir, "stdout.log"))) ?? "",
  );
  return m ? Number(m[1]) : null;
}

function endStats(
  r: Resolved,
): { resource_records: number; resource_bytes: number } | null {
  const end = r.metas[r.metas.length - 1] as
    | {
        type?: string;
        stats?: { resource_records: number; resource_bytes: number };
      }
    | undefined;
  return end?.type === "end" && end.stats
    ? {
        resource_records: end.stats.resource_records,
        resource_bytes: end.stats.resource_bytes,
      }
    : null;
}

/** Groups g2b and, with `withG2d`, g2d (G2d's canvas-headless, canvas-host, canvas-normal and
 * sabotage-omit-canvas-filter legs and their four checks). Without it those legs are not loaded at
 * all, so
 * `--legs g2a,g2b` judges g2b alone and the gate reports group-g2d as not-run. */
export async function runG2b(
  outDir: string,
  expected: Gate2Expected,
  captureQuit: number,
  withG2d = true,
): Promise<G2bResult> {
  const quit = expected.quit_frame_default;
  const capture = await loadCapture(outDir, "capture", "capture", captureQuit);
  const inline = await loadCapture(
    outDir,
    "capture-inline",
    "capture-inline",
    captureQuit,
  );
  const unsupported = await loadCapture(
    outDir,
    "capture-unsupported",
    "capture-unsupported",
    quit,
  );
  const sab = async (name: string) =>
    loadCapture(outDir, `${name}/capture`, `${name}/capture`, quit);
  const omitUpdate = await sab("sabotage-omit-update");
  const omitReplace = await sab("sabotage-omit-replace");
  const stale = await sab("sabotage-stale-texture");
  const wrongHash = await sab("sabotage-wrong-hash");
  const spurious = await sab("sabotage-spurious-update");
  // G2d.
  const omitCanvasFilter = withG2d
    ? await sab("sabotage-omit-canvas-filter")
    : null;
  const canvasNormal = withG2d ? await sab("canvas-normal") : null;
  const canvasHost = withG2d ? await sab("canvas-host") : null;
  const canvasHeadless = withG2d ? await sab("canvas-headless") : null;

  const rx = (leg: string, rel: string, c: CaptureEvidence | null) =>
    loadReceiver(outDir, leg, rel, c, expected);
  const cold = await rx("receiver-cold", "receiver-cold", capture);
  const warm = await rx("receiver-warm", "receiver-warm", capture);
  const patch = await rx("receiver-patch", "receiver-patch", capture);
  const inlineRx = await rx("receiver-inline", "receiver-inline", inline);
  const trace = await rx(
    "receiver-headless-trace",
    "receiver-headless-trace",
    capture,
  );
  const unsupportedRx = await rx(
    "unsupported-textures",
    "unsupported-textures/receiver",
    unsupported,
  );
  const omitUpdateRx = await rx(
    "sabotage-omit-update",
    "sabotage-omit-update/receiver",
    omitUpdate,
  );
  const omitReplaceRx = await rx(
    "sabotage-omit-replace",
    "sabotage-omit-replace/receiver",
    omitReplace,
  );
  const staleRx = await rx(
    "sabotage-stale-texture",
    "sabotage-stale-texture/receiver",
    stale,
  );
  const wrongHashRx = await rx(
    "sabotage-wrong-hash",
    "sabotage-wrong-hash/receiver",
    wrongHash,
  );
  const spuriousRx = await rx(
    "sabotage-spurious-update",
    "sabotage-spurious-update/receiver",
    spurious,
  );
  const reuploadRx = await rx(
    "sabotage-receiver-reupload",
    "sabotage-receiver-reupload/receiver",
    capture,
  );
  const ignoreRx = await rx(
    "sabotage-receiver-ignore-cache",
    "sabotage-receiver-ignore-cache/receiver",
    capture,
  );
  // G2d.
  const omitCanvasFilterRx = omitCanvasFilter
    ? await rx(
        "sabotage-omit-canvas-filter",
        "sabotage-omit-canvas-filter/receiver",
        omitCanvasFilter,
      )
    : null;
  const canvasNormalRx = canvasNormal
    ? await rx("canvas-normal", "canvas-normal/receiver", canvasNormal)
    : null;
  const canvasHostRx = canvasHost
    ? await rx("canvas-host", "canvas-host/receiver", canvasHost)
    : null;
  const canvasHeadlessRx = canvasHeadless
    ? await rx("canvas-headless", "canvas-headless/receiver", canvasHeadless)
    : null;
  const g2dReceivers = [
    canvasHeadlessRx,
    canvasHostRx,
    omitCanvasFilterRx,
    canvasNormalRx,
  ].filter((r): r is ReceiverEvidence => r !== null);
  const live = await loadLive(outDir, expected);

  const reference = join(outDir, "reference");
  const cpCold = await receiverCheckpoints(expected, cold, reference);
  const cpWarm = await receiverCheckpoints(expected, warm, reference);
  const cpPatch = await receiverCheckpoints(expected, patch, reference);
  const cpInline = await receiverCheckpoints(expected, inlineRx, reference);
  const cpUnsupported = await receiverCheckpoints(
    expected,
    unsupportedRx,
    join(outDir, "reference-unsupported"),
    "unsupported",
  );
  const cpOmitUpdate = await receiverCheckpoints(
    expected,
    omitUpdateRx,
    reference,
  );
  const cpOmitReplace = await receiverCheckpoints(
    expected,
    omitReplaceRx,
    reference,
  );
  // G2d: the canvas variants draw the main fixture's pixels, so every receiver of them is held to
  // the plain reference (canvas-headless's is headless: no shots).
  const cpOmitCanvasFilter = omitCanvasFilterRx
    ? await receiverCheckpoints(expected, omitCanvasFilterRx, reference)
    : [];
  const cpCanvasNormal = canvasNormalRx
    ? await receiverCheckpoints(expected, canvasNormalRx, reference)
    : [];
  const cpCanvasHost = canvasHostRx
    ? await receiverCheckpoints(expected, canvasHostRx, reference)
    : [];

  const store = await checkStoreComplete([capture, unsupported]);
  const coldHashes = new Set(
    (cold.applied?.fetches ?? []).map((f) => f.hash ?? ""),
  );
  const checks: G2bCheck[] = [
    checkRecordingsDecode([capture, inline, unsupported, live.host]),
    checkPatchResolvesToFull([capture, inline, unsupported, live.host]),
    store.check,
    await checkInlineEqualsStore(capture, inline),
    checkTextureVersionsCurrent([capture, inline, unsupported, live.host]),
    checkTextureInvariants(expected, capture),
    checkReceiverVsReference([...cpCold, ...cpWarm, ...cpPatch, ...cpInline]),
    await checkExpectedImageReceiver(expected, cold),
    checkTransformOnly(expected, capture, [cold, warm, patch, inlineRx]),
    checkUploadAccounting(expected, captureQuit, cold, patch, inlineRx),
    await checkWarmCache(cold, warm),
    await checkFreshCache(cold),
    await checkFreedDrawsDefault(expected, reference, cold),
    await checkCopyAtHook(expected, reference, cold),
    checkUnsupportedRegions(cpUnsupported, expected),
    ...(canvasHeadless && canvasHeadlessRx && canvasHost
      ? [
          checkCanvasTextureHeadlessRefusal(
            expected,
            canvasHeadless,
            canvasHeadlessRx,
            canvasHost,
          ),
          await checkCanvasTextureOverride(expected, canvasHost.dir),
          checkCanvasTextureWire(expected, canvasHost),
          checkCanvasNormalRegion(cpCanvasNormal),
        ]
      : []),
    checkLiveInline(live),
    await checkReceiverConsumedStream([
      cold,
      warm,
      patch,
      inlineRx,
      trace,
      unsupportedRx,
      omitUpdateRx,
      omitReplaceRx,
      staleRx,
      wrongHashRx,
      spuriousRx,
      reuploadRx,
      ignoreRx,
      ...g2dReceivers,
    ]),
    await checkReceiverNeverLoadedFixture(outDir),
    checkReceiverTypedClean([
      cold,
      warm,
      patch,
      inlineRx,
      trace,
      unsupportedRx,
      omitUpdateRx,
      omitReplaceRx,
      staleRx,
      wrongHashRx,
      spuriousRx,
      reuploadRx,
      ignoreRx,
      ...g2dReceivers,
      live.receiver,
    ]),
  ];

  const inputs: Record<string, G2bLegInput> = {
    "receiver-cold": { capture, receiver: cold, checkpoints: cpCold, expected },
    "receiver-warm": {
      capture,
      receiver: warm,
      checkpoints: cpWarm,
      warmHashes: coldHashes,
      expected,
    },
    "receiver-patch": {
      capture,
      receiver: patch,
      checkpoints: cpPatch,
      expected,
      source: PATCH_RECORDING_NAME,
    },
    "receiver-inline": {
      capture: inline,
      receiver: inlineRx,
      checkpoints: cpInline,
      expected,
    },
    "unsupported-textures": {
      capture: unsupported,
      receiver: unsupportedRx,
      checkpoints: [],
      expected,
    },
    "sabotage-omit-update": {
      capture: omitUpdate,
      receiver: omitUpdateRx,
      checkpoints: cpOmitUpdate,
      expected,
    },
    "sabotage-omit-replace": {
      capture: omitReplace,
      receiver: omitReplaceRx,
      checkpoints: cpOmitReplace,
      expected,
    },
    "sabotage-stale-texture": {
      capture: stale,
      receiver: staleRx,
      checkpoints: [],
      expected,
    },
    "sabotage-wrong-hash": {
      capture: wrongHash,
      receiver: wrongHashRx,
      checkpoints: [],
      expected,
    },
    "sabotage-spurious-update": {
      capture: spurious,
      receiver: spuriousRx,
      checkpoints: [],
      expected,
    },
    "sabotage-receiver-reupload": {
      capture,
      receiver: reuploadRx,
      checkpoints: [],
      expected,
    },
    "sabotage-receiver-ignore-cache": {
      capture,
      receiver: ignoreRx,
      checkpoints: [],
      warmHashes: coldHashes,
      expected,
    },
  };
  if (canvasNormal && canvasNormalRx)
    inputs["canvas-normal"] = {
      capture: canvasNormal,
      receiver: canvasNormalRx,
      checkpoints: [],
      expected,
    };
  if (canvasHeadless && canvasHeadlessRx)
    inputs["canvas-headless"] = {
      capture: canvasHeadless,
      receiver: canvasHeadlessRx,
      checkpoints: [],
      expected,
    };
  if (canvasHost && canvasHostRx)
    inputs["canvas-host"] = {
      capture: canvasHost,
      receiver: canvasHostRx,
      checkpoints: cpCanvasHost,
      expected,
    };
  if (omitCanvasFilter && omitCanvasFilterRx)
    inputs["sabotage-omit-canvas-filter"] = {
      capture: omitCanvasFilter,
      receiver: omitCanvasFilterRx,
      checkpoints: cpOmitCanvasFilter,
      expected,
    };
  const legs: Record<string, G2bLegReport> = {};
  for (const e of G2B_LEGS) {
    if (!withG2d && G2D_LEG_NAMES.includes(e.leg)) continue;
    const c =
      e.leg === "live-inline"
        ? classifyLive(live)
        : await classifyG2bLeg(inputs[e.leg]);
    const r = e.leg === "live-inline" ? live.receiver : inputs[e.leg].receiver;
    const extra: string[] = [];
    if (e.leg === "sabotage-wrong-hash") {
      // The failure must be at step 6's seq (the first transaction naming A1).
      const want = settleSeqOfFrame(
        wrongHash,
        stepFrames2(expected, 6).applied,
      );
      const failure = wrongHashRx.applied?.failure;
      if (failure?.reason !== "resource-hash-mismatch" || failure.seq !== want)
        extra.push(
          `receiver failure ${JSON.stringify(failure)}, expected resource-hash-mismatch at seq ${want}`,
        );
    }
    if (e.leg === "unsupported-textures") {
      const reasons = new Set(
        (unsupportedRx.applied?.unsupported ?? []).map((u) => u.reason),
      );
      if (
        !reasons.has("unknown-texture") ||
        !reasons.has("unsupported-texture")
      )
        extra.push(
          `receiver unsupported reasons ${[...reasons].join(",")}, expected unknown-texture and unsupported-texture`,
        );
    }
    const artifacts = r
      ? [join(r.dir, "applied.json"), join(r.dir, "stdout.log")]
      : [];
    checks.push(checkLegClass(e, c, extra, artifacts));
    legs[e.leg] = {
      group: G2D_LEG_NAMES.includes(e.leg) ? "g2d" : "g2b",
      expected_class: e.expected_class,
      result_class: c.result_class,
      reasons: c.reasons,
      exit_code: r?.exit ?? null,
      artifacts,
    };
  }
  for (const support of [
    "capture-inline",
    "receiver-headless-trace",
    "reference-unsupported",
  ]) {
    legs[support] = {
      group: "g2b",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(join(outDir, support)),
      artifacts: [],
    };
  }

  const resources: Record<string, G2bResources> = {};
  const perStep = (r: ReceiverEvidence, q: number) =>
    perStepResources(expected, r, q).map((p) => ({
      step: p.step,
      fetched: p.fetched ?? 0,
      fetched_bytes: p.fetched_bytes ?? 0,
      uploads: (p.created ?? 0) + (p.updated ?? 0) + (p.replaced ?? 0),
      upload_bytes: p.upload_bytes ?? 0,
      cache_hits: p.cache_hits ?? 0,
    }));
  const host = async (c: CaptureEvidence) => ({
    retained_bytes_max: await retainedBytesMax(c.dir),
    resource_records: endStats(c.full)?.resource_records ?? null,
    resource_bytes: endStats(c.full)?.resource_bytes ?? null,
    full_bytes: c.full.present ? c.full.bytes : null,
    patch_bytes: c.patch.present ? c.patch.bytes : null,
    inline_bytes: null,
  });
  const storeOf = (leg: string) => {
    const s = store.stores.find((x) => x.leg === leg);
    return s ? { hashes: s.hashes, bytes: s.bytes } : null;
  };
  resources.capture = {
    store: storeOf("capture"),
    receiver: null,
    per_step: null,
    host: await host(capture),
  };
  resources["capture-inline"] = {
    store: null,
    receiver: null,
    per_step: null,
    host: {
      ...(await host(inline)),
      inline_bytes: inline.full.present ? inline.full.bytes : null,
    },
  };
  for (const [leg, r, q] of [
    ["receiver-cold", cold, captureQuit],
    ["receiver-warm", warm, captureQuit],
    ["receiver-patch", patch, captureQuit],
    ["receiver-inline", inlineRx, captureQuit],
  ] as const)
    resources[leg] = {
      store: null,
      receiver: r.applied?.resources_summary ?? null,
      per_step: perStep(r, q),
      host: null,
    };
  resources["live-inline"] = {
    store: null,
    receiver: live.receiver.applied?.resources_summary ?? null,
    per_step: null,
    host: {
      ...(await host(live.host)),
      resource_records:
        live.summary?.connections?.[0]?.resource_records ?? null,
      resource_bytes: live.summary?.connections?.[0]?.resource_bytes ?? null,
    },
  };
  return {
    checks,
    legs,
    checkpoints: [
      ...cpCold,
      ...cpWarm,
      ...cpPatch,
      ...cpInline,
      ...cpUnsupported,
      ...cpOmitUpdate,
      ...cpOmitReplace,
    ],
    resources,
  };
}

/** The seq a capture published at `frame` (file sinks publish one transaction per frame). */
function settleSeqOfFrame(c: CaptureEvidence, frame: number): number | null {
  return (
    c.full.recording?.transactions.find((t) => t.frame === frame)?.seq ?? null
  );
}

export { stepOfFrame };
