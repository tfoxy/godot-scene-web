// Gate 8 g8tag's checks (TAG1, protocol/client-extensions-design.md "As built (TAG1)"): item
// identity at /13 on fixtures/tag-scene, judged on run-gate8.sh run_g8tag's legs (under g8tag/):
//
//   tag-validate         every viewer's decoded stream passes rs-core-check and the TypeScript
//                        validator with the ask its hello made (--item-meta-asked), and both file
//                        sinks of `file` pass them too and carry item_meta records
//   tag-meta-oracle      live/a: every row the viewer holds (rs-core-check --item-meta-dump `seen`)
//                        equals the fixture's own dump of that item's node (RS_FIXTURE_TAG_LOG,
//                        by canvas-item RID), joined through the capture's id log
//                        (GRC_ITEM_META_LOG); a row with no node names a RID the fixture never
//                        dumped (the TileMapLayer's quadrant); every dumped node the capture
//                        resolved has a row
//   tag-meta-file-oracle the same on `file`'s patch recording
//   tag-meta-shared      live: A and B (the same request) get byte-identical item_meta records, raw
//                        and coded, the host counts memo hits, and C (no request) gets the same
//                        transaction bytes as A, raw and coded, at every transaction
//   tag-late-join        live/d (joins late): its first full record's table equals the table A
//                        holds after the transaction of the same frame
//   tag-reconnect        reconnect/e closes after 60 transactions, reconnect/f connects later: f's first
//                        table equals A's at that frame, and e's stream (closed early) validates
//   tag-rekey            live: a re-key (skip mode) copied an entry (the host's rekey_copies), and
//                        the copied id's row equals the original's
//   tag-resync           resync/a: drop-message forced a coding resync; a full record went before
//                        the full that answered it (the validator's item-meta-missing otherwise)
//   tag-refused          refused: a request the grant does not cover gets no record; a partial one
//                        gets the grant's columns only
//   tag-off              grant-off: the grant set and nobody asking: the host never turned on
//   tag-cost             (informative) the host's resolution cost on the fixture
//   tag-sabotage-*       each GRC_ITEM_META_SABOTAGE leg fails the check it targets
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";
import {
  createRecordingValidator,
  type ItemMetaRequest,
  type ItemMetaTable,
  splitRecords,
  validateRecording,
} from "./render-stream-2";

const REQUEST: ItemMetaRequest = {
  fields: ["class", "script", "scene", "path"],
  groups: ["rs_hand", "rs_text", "rs_none"],
  meta_keys: ["rs_tag", "rs_slot", "rs_missing"],
};

interface Identity {
  class: string | null;
  script: string | null;
  scene: string | null;
  path: string | null;
  groups: string[];
  meta: Record<string, string | null>;
}
interface OracleNode extends Identity {
  rid: string;
}
interface IdLine {
  id: number;
  rid: string;
  stamp: number;
  node: boolean;
  copy: boolean;
}
interface Line {
  index: number;
  kind?: string;
  outcome?: string;
  sha256?: string;
  wire_sha256?: string;
  seq?: number;
  frame?: number;
  encoding?: string;
  form?: string;
  envelope_seq?: number;
}

function check(id: string, criterion: string, passed: boolean, detail: string): G8aCheck {
  return { id, criterion, passed, status: passed ? "pass" : "fail", detail };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function jsonlOf<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function ask(request: ItemMetaRequest | null): string {
  return request === null ? "none" : JSON.stringify(request);
}

/** rs-core-check validate (with the ask); "ok" or the error. Writes the dump when asked. */
function rsValidate(path: string, request: ItemMetaRequest | null | undefined, dump?: string): string {
  const args = ["validate", path, "--version", "13"];
  if (request !== undefined) args.push("--item-meta-asked", ask(request));
  if (dump !== undefined) args.push("--item-meta-dump", dump);
  const r = spawnSync(RS_CORE_CHECK, args, { encoding: "utf8" });
  const cols = ((r.stdout ?? "").trim().split("\n").at(-1) ?? "").split("\t");
  return cols[1] === "ok"
    ? "ok"
    : `${cols[1] ?? "?"}: ${(cols[2] ?? r.stderr ?? "").slice(0, 200)}`;
}

function tsValidate(path: string, request: ItemMetaRequest | null | undefined): string {
  try {
    const errors = validateRecording(new Uint8Array(readFileSync(path)), 13, {
      itemMeta: request,
    });
    return errors.length === 0 ? "ok" : errors[0].slice(0, 200);
  } catch (e) {
    return `throws: ${String(e).slice(0, 200)}`;
  }
}

type Row = Identity | null; // resolved; null: no node
interface Dump {
  seen: Record<string, unknown>;
  rows: Record<string, unknown>;
  full_records: number;
  delta_records: number;
}

/** rs-core-check's dump row form -> Identity (groups as names, every meta key present). */
function fromDump(row: unknown, grant: ItemMetaRequest): Row {
  if (row === null || row === undefined) return null;
  const r = row as Record<string, unknown>;
  const groups: string[] = [];
  const mask = typeof r.groups === "number" ? r.groups : 0;
  grant.groups.forEach((g, i) => {
    if ((mask & (1 << i)) !== 0) groups.push(g);
  });
  const meta: Record<string, string | null> = {};
  const m = (r.meta ?? {}) as Record<string, string | null>;
  for (const k of grant.meta_keys) meta[k] = m[k] ?? null;
  const field = (f: string): string | null =>
    grant.fields.includes(f) ? ((r[f] as string | null) ?? null) : null;
  return {
    class: field("class"),
    script: field("script"),
    scene: field("scene"),
    path: field("path"),
    groups,
    meta,
  };
}

function oracleIdentity(n: OracleNode, grant: ItemMetaRequest): Identity {
  const meta: Record<string, string | null> = {};
  for (const k of grant.meta_keys) meta[k] = n.meta[k] ?? null;
  const field = (f: keyof Identity): string | null =>
    grant.fields.includes(f) ? ((n[f] as string | null) ?? null) : null;
  return {
    class: field("class"),
    script: field("script"),
    scene: field("scene"),
    path: field("path"),
    groups: grant.groups.filter((g) => n.groups.includes(g)),
    meta,
  };
}

function sameIdentity(a: Row, b: Row): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A table (TS validator form) resolved: id -> Row. */
function resolveTable(t: ItemMetaTable): Map<number, Row> {
  const out = new Map<number, Row>();
  const g = t.grant;
  if (g === null) return out;
  for (const [id, cols] of t.rows) {
    if (cols === null) {
      out.set(id, null);
      continue;
    }
    let c = 0;
    const s = (v: number | null | undefined): string | null =>
      v === null || v === undefined ? null : (t.strings[v] ?? null);
    const f: Record<string, string | null> = {};
    for (const name of g.fields) f[name] = s(cols[c++] as number | null);
    let mask = 0;
    if (g.groups.length > 0) mask = (cols[c++] as number) ?? 0;
    const meta: Record<string, string | null> = {};
    for (const k of g.meta_keys) meta[k] = s(cols[c++] as number | null);
    out.set(id, {
      class: f.class ?? null,
      script: f.script ?? null,
      scene: f.scene ?? null,
      path: f.path ?? null,
      groups: g.groups.filter((_, i) => (mask & (1 << i)) !== 0),
      meta,
    });
  }
  return out;
}

/** Walks a decoded stream with the TS validator; after each accepted transaction, the table by
 * that transaction's frame. Stops at the first error. */
function tablesByFrame(
  path: string,
  request: ItemMetaRequest,
): { frames: Map<number, Map<number, Row>>; firstFrame: number | null; error: string | null } {
  const frames = new Map<number, Map<number, Row>>();
  let firstFrame: number | null = null;
  if (!existsSync(path)) return { frames, firstFrame, error: `${path} missing` };
  const split = splitRecords(new Uint8Array(readFileSync(path)), 13);
  if (split.errors.length > 0) return { frames, firstFrame, error: split.errors[0] };
  const v = createRecordingValidator(split.records, 13, { itemMeta: request });
  if (v.errors) return { frames, firstFrame, error: v.errors[0] };
  for (let i = 1; i < split.records.length; i++) {
    const errors = v.accept(i);
    if (errors) return { frames, firstFrame, error: errors[0] };
    const rec = split.records[i];
    const view = new DataView(rec.bytes.buffer, rec.bytes.byteOffset, rec.bytes.byteLength);
    const metaLen = view.getUint32(4, true);
    const meta = JSON.parse(
      new TextDecoder().decode(rec.bytes.subarray(8, 8 + metaLen)),
    ) as { type: string; frame?: number };
    if (meta.type === "transaction" && meta.frame !== undefined && v.itemMeta) {
      frames.set(meta.frame, resolveTable(v.itemMeta()));
      if (firstFrame === null) firstFrame = meta.frame;
    }
  }
  return { frames, firstFrame, error: null };
}

/** meta-oracle: rows (dump `seen`) against the fixture's dump, through the capture's id log. */
export function oracleProblems(
  dump: Dump | null,
  oraclePath: string,
  idsPath: string,
  grant: ItemMetaRequest,
): { problems: string[]; rows: number; noNode: number; matched: number } {
  const problems: string[] = [];
  if (dump === null) return { problems: ["no item_meta dump"], rows: 0, noNode: 0, matched: 0 };
  const oracle = new Map<string, OracleNode>(); // rid -> the latest dump of its node
  for (const line of jsonlOf<{ frame: number; nodes: OracleNode[] }>(oraclePath)) {
    for (const n of line.nodes) oracle.set(n.rid, n);
  }
  const ids = jsonlOf<IdLine>(idsPath);
  const ridOf = new Map<number, string>();
  for (const l of ids) ridOf.set(l.id, l.rid);
  let noNode = 0;
  let matched = 0;
  const rows = Object.entries(dump.seen);
  for (const [idText, raw] of rows) {
    const id = Number(idText);
    const rid = ridOf.get(id);
    const row = fromDump(raw, grant);
    if (rid === undefined) {
      problems.push(`row ${id}: the capture never resolved that id`);
      continue;
    }
    const node = oracle.get(rid);
    if (row === null) {
      noNode += 1;
      if (node !== undefined)
        problems.push(`row ${id} (rid ${rid}): no node, but the fixture dumped ${node.class} ${node.path}`);
      continue;
    }
    if (node === undefined) {
      problems.push(`row ${id} (rid ${rid}): a node row for a RID the fixture never dumped`);
      continue;
    }
    const want = oracleIdentity(node, grant);
    if (!sameIdentity(row, want)) {
      const keys = (Object.keys(want) as Array<keyof Identity>).filter(
        (k) => JSON.stringify(row[k]) !== JSON.stringify(want[k]),
      );
      problems.push(
        `row ${id} (rid ${rid}, ${node.class} ${node.path}): differs in ${keys.join(",")}: ` +
          keys.map((k) => `${JSON.stringify(row[k])} != fixture ${JSON.stringify(want[k])}`).join(", "),
      );
      continue;
    }
    matched += 1;
  }
  // Every id the capture resolved for a dumped node reached the viewer.
  const seenIds = new Set(rows.map(([k]) => Number(k)));
  for (const l of ids) {
    if (oracle.has(l.rid) && !seenIds.has(l.id))
      problems.push(`id ${l.id} (rid ${l.rid}, ${oracle.get(l.rid)?.path}) has no row`);
  }
  return { problems, rows: rows.length, noNode, matched };
}

function lines(dir: string): Line[] {
  return jsonlOf<Line>(join(dir, "messages.jsonl"));
}

/** item_meta records keyed by "<previous transaction frame>-><following transaction frame>" (the
 * range a delta covers), so two viewers' records are compared only when they cover one range. */
function metaByRange(ls: Line[]): Map<string, Line> {
  const out = new Map<string, Line>();
  let held: Line | null = null;
  let prev = -1;
  for (const l of ls) {
    if (l.kind === "item_meta") held = l;
    else if (l.kind === "transaction" && l.frame !== undefined) {
      if (held !== null) out.set(`${prev}->${l.frame}`, held);
      held = null;
      prev = l.frame;
    }
  }
  return out;
}

interface Tx {
  seq: number;
  frame: number;
  baseFrame: number | null;
  norm: string; // sha256 of the record with its seq and base_seq zeroed
}

/** A decoded stream's transactions by frame, with each one's seq-independent digest. */
function txsOf(path: string): Map<number, Tx> {
  const out = new Map<number, Tx>();
  if (!existsSync(path)) return out;
  const split = splitRecords(new Uint8Array(readFileSync(path)), 13);
  const frameOfSeq = new Map<number, number>();
  for (const rec of split.records) {
    const view = new DataView(rec.bytes.buffer, rec.bytes.byteOffset, rec.bytes.byteLength);
    if (rec.bytes.byteLength < 8) continue;
    const metaLen = view.getUint32(4, true);
    const text = new TextDecoder().decode(rec.bytes.subarray(8, 8 + metaLen));
    if (!text.startsWith('{"type":"transaction"')) continue;
    const meta = JSON.parse(text) as { seq: number; frame: number; base_seq?: number | null };
    frameOfSeq.set(meta.seq, meta.frame);
    const norm = text.replace(/"seq":\d+/, '"seq":0').replace(/"base_seq":\d+/, '"base_seq":0');
    const h = createHash("sha256");
    h.update(norm);
    h.update(rec.bytes.subarray(8 + metaLen));
    out.set(meta.frame, {
      seq: meta.seq,
      frame: meta.frame,
      baseFrame:
        meta.base_seq === null || meta.base_seq === undefined
          ? null
          : (frameOfSeq.get(meta.base_seq) ?? -1),
      norm: h.digest("hex"),
    });
  }
  return out;
}

function txByFrame(ls: Line[]): Map<number, Line> {
  const out = new Map<number, Line>();
  for (const l of ls) if (l.kind === "transaction" && l.frame !== undefined) out.set(l.frame, l);
  return out;
}

/** meta-shared: A/B records equal (raw, coded) over the same range; C's transactions equal each
 * opted-in viewer's (seq and base_seq aside) at every frame both formed from the same base frame,
 * and byte for byte, raw and coded, wherever their seqs agree too. */
export function sharedProblems(leg: string): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const a = lines(join(leg, "a"));
  const b = lines(join(leg, "b"));
  const c = lines(join(leg, "c"));
  const am = metaByRange(a);
  const bm = metaByRange(b);
  let compared = 0;
  for (const [range, la] of am) {
    const lb = bm.get(range);
    if (lb === undefined) continue;
    compared += 1;
    if (la.sha256 !== lb.sha256) problems.push(`${range}: A and B item_meta records differ (raw)`);
    if (la.wire_sha256 !== lb.wire_sha256)
      problems.push(`${range}: A and B item_meta records differ (coded)`);
  }
  if (am.size === 0) problems.push("A got no item_meta record");
  if (compared === 0) problems.push("A and B have no item_meta record over the same range");
  const ct = txByFrame(c);
  const cTx = txsOf(join(leg, "c", "decoded.rs13"));
  const counts: string[] = [];
  let strictTotal = 0;
  for (const [name, ls] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const xTx = txsOf(join(leg, name.toLowerCase(), "decoded.rs13"));
    let normalized = 0;
    for (const [frame, x] of xTx) {
      const y = cTx.get(frame);
      if (y === undefined || y.baseFrame !== x.baseFrame) continue;
      normalized += 1;
      if (x.norm !== y.norm) problems.push(`frame ${frame}: ${name}'s transaction != C's (seq aside)`);
    }
    let strict = 0;
    for (const [frame, lx] of txByFrame(ls)) {
      const lc = ct.get(frame);
      if (lc === undefined || lc.seq !== lx.seq || lc.envelope_seq !== lx.envelope_seq) continue;
      const xb = xTx.get(frame);
      const yb = cTx.get(frame);
      if (xb === undefined || yb === undefined || xb.baseFrame !== yb.baseFrame) continue;
      strict += 1;
      if (lx.sha256 !== lc.sha256) problems.push(`frame ${frame}: ${name}'s transaction != C's (raw)`);
      if (lx.wire_sha256 !== lc.wire_sha256)
        problems.push(`frame ${frame}: ${name}'s transaction != C's (coded)`);
    }
    strictTotal += strict;
    if (normalized < 10) problems.push(`only ${normalized} transactions of ${name} and C share a frame and base`);
    counts.push(`${name}/C: ${normalized} compared, ${strict} byte for byte (raw and coded)`);
  }
  const summary = readJson<{ connections?: Array<{ item_meta?: { shared: number; full: number; delta: number } }> }>(
    join(leg, "host", "evidence", "live-summary.json"),
  );
  const shared = (summary?.connections ?? []).reduce((n, s) => n + (s.item_meta?.shared ?? 0), 0);
  if (shared === 0) problems.push("the host shared no item_meta record (memo hits 0)");
  return {
    problems: problems.slice(0, 8),
    detail: `${compared} A/B records compared; ${counts.join("; ")}; ${strictTotal} byte-equal in all; ${shared} memo hits`,
  };
}

function lateJoinProblems(leg: string, joiner: string): { problems: string[]; detail: string } {
  const a = tablesByFrame(join(leg, "a", "decoded.rs13"), REQUEST);
  const d = tablesByFrame(join(leg, joiner, "decoded.rs13"), REQUEST);
  const problems: string[] = [];
  if (a.error !== null) problems.push(`A: ${a.error}`);
  if (d.error !== null) problems.push(`${joiner}: ${d.error}`);
  const f = d.firstFrame;
  if (f === null) return { problems: [...problems, `${joiner} got no transaction`], detail: "" };
  const mine = d.frames.get(f) ?? new Map<number, Row>();
  const theirs = a.frames.get(f);
  if (theirs === undefined)
    return { problems: [...problems, `A has no transaction at frame ${f}`], detail: "" };
  for (const [id, row] of theirs) {
    if (!mine.has(id)) problems.push(`frame ${f}: A holds row ${id}, ${joiner}'s full lacks it`);
    else if (!sameIdentity(mine.get(id) ?? null, row)) problems.push(`frame ${f}: row ${id} differs`);
  }
  for (const id of mine.keys())
    if (!theirs.has(id)) problems.push(`frame ${f}: ${joiner}'s full has row ${id}, A does not`);
  if (mine.size === 0) problems.push(`${joiner}'s first table is empty`);
  return { problems: problems.slice(0, 8), detail: `frame ${f}: ${mine.size} rows` };
}

/** The host's tap of a one-connection leg (GRC_LIVE_TAP_DIR: stream-1.rs2, whatever the version). */
function tapOf(leg: string): string {
  return join(leg, "host", "tap", "stream-1.rs2");
}

function viewerReport(dir: string): Record<string, unknown> | null {
  return readJson<Record<string, unknown>>(join(dir, "coding-receiver.json"));
}

function legSkipped(g: string, leg: string): boolean {
  return skipped(join(g, leg)) !== null || skipped(join(g, leg, "host")) !== null;
}

function notRun(id: string, criterion: string): G8aCheck {
  return { id, criterion, passed: true, status: "not-run", detail: `${id}: leg skipped by tier`, gating: false };
}

export async function runG8tag(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const asks: Record<string, Record<string, ItemMetaRequest | null>> = {
    live: { a: REQUEST, b: REQUEST, c: null, d: REQUEST },
    reconnect: { a: REQUEST, e: REQUEST, f: REQUEST },
    resync: { a: REQUEST },
    refused: { a: { fields: [], groups: ["rs_hand"], meta_keys: [] }, b: REQUEST },
    "grant-off": { c: null },
  };

  // tag-validate
  {
    const problems: string[] = [];
    let n = 0;
    for (const [leg, viewers] of Object.entries(asks)) {
      if (legSkipped(g, leg)) continue;
      for (const [v, request] of Object.entries(viewers)) {
        // A viewer that resynced skipped transactions (a seq gap in what it decoded): its
        // connection's tap, everything the host formed for it, is the stream to validate.
        const path = leg === "resync" ? tapOf(join(g, leg)) : join(g, leg, v, "decoded.rs13");
        const report = viewerReport(join(g, leg, v));
        if (report === null || !existsSync(path)) {
          problems.push(`${leg}/${v}: no viewer output`);
          continue;
        }
        if (report.fatal !== null) problems.push(`${leg}/${v}: ${String(report.fatal)}`);
        // A viewer that closed early (live/e) has no end record: TS's finish() would say so.
        const rs = rsValidate(path, request);
        if (rs !== "ok" && !(report.closed_early === true && rs.startsWith("recording-incomplete")))
          problems.push(`${leg}/${v} rs-core-check: ${rs}`);
        if (report.closed_early !== true) {
          const ts = tsValidate(path, request);
          if (ts !== "ok") problems.push(`${leg}/${v} TS: ${ts}`);
        }
        n += 1;
      }
    }
    if (!legSkipped(g, "file")) {
      for (const sink of ["recording.rs13", "recording-patch.rs13"]) {
        const path = join(g, "file", "host", sink);
        if (!existsSync(path)) {
          problems.push(`file/${sink} missing`);
          continue;
        }
        const rs = rsValidate(path, undefined);
        const ts = tsValidate(path, undefined);
        if (rs !== "ok") problems.push(`file/${sink} rs-core-check: ${rs}`);
        if (ts !== "ok") problems.push(`file/${sink} TS: ${ts}`);
        const recs = splitRecords(new Uint8Array(readFileSync(path)), 13).records;
        const metas = recs.filter((r) =>
          new TextDecoder().decode(r.bytes.subarray(8, 40)).startsWith('{"type":"item_meta"'),
        ).length;
        if (metas === 0) problems.push(`file/${sink} carries no item_meta record`);
        n += 1;
      }
    }
    checks.push(
      check(
        "tag-validate",
        "TAG1: every g8tag viewer's stream and file recording passes rs-core-check and the TS validator with its hello's ask (item-meta-unexpected, -orphan, -form, -missing, -id, -string, -schema), and the file sinks carry item_meta records",
        problems.length === 0 && n > 0,
        problems.length === 0 ? `${n} streams valid` : problems.slice(0, 8).join("; "),
      ),
    );
  }

  // tag-meta-oracle (live/a), tag-meta-file-oracle (file's patch sink)
  const oracleOf = (leg: string, stream: string): ReturnType<typeof oracleProblems> => {
    const dumpPath = join(g, leg, `${stream.replace(/\//g, "-")}.item-meta-dump.json`);
    const v = rsValidate(join(g, leg, stream), leg === "file" ? undefined : REQUEST, dumpPath);
    const r = oracleProblems(
      readJson<Dump>(dumpPath),
      join(g, leg, "host", "oracle.jsonl"),
      join(g, leg, "host", "ids.jsonl"),
      REQUEST,
    );
    if (v !== "ok") r.problems.unshift(`validate: ${v}`);
    return r;
  };
  const oracleCheck = (id: string, leg: string, stream: string, what: string): void => {
    if (legSkipped(g, leg)) {
      checks.push(notRun(id, what));
      return;
    }
    const r = oracleOf(leg, stream);
    const enough = r.matched >= 15 && r.noNode >= 1;
    checks.push(
      check(
        id,
        what,
        r.problems.length === 0 && enough,
        r.problems.length === 0
          ? `${r.rows} rows: ${r.matched} equal the fixture's dump, ${r.noNode} with no node${enough ? "" : " (expected >= 15 node rows and >= 1 no-node row)"}`
          : r.problems.slice(0, 6).join("; "),
      ),
    );
  };
  oracleCheck(
    "tag-meta-oracle",
    "live",
    "a/decoded.rs13",
    "TAG1 meta-oracle: every row live/a holds equals the fixture's own identity dump of that item's node (class, script, instance scene, scene-relative path, group bits, meta), joined by canvas-item RID through the capture's id log; a no-node row names an item the fixture never dumped (the TileMapLayer quadrant); every resolved node has a row",
  );
  oracleCheck(
    "tag-meta-file-oracle",
    "file",
    "host/recording-patch.rs13",
    "TAG1 file sinks: the patch recording's item_meta rows (GRC_ITEM_META_FILE*) equal the fixture's identity dump the same way",
  );

  // tag-meta-shared
  if (legSkipped(g, "live")) checks.push(notRun("tag-meta-shared", "meta-shared"));
  else {
    const r = sharedProblems(join(g, "live"));
    checks.push(
      check(
        "tag-meta-shared",
        "TAG1 meta-shared: two lockstep viewers with the same request get byte-identical item_meta records (raw and coded) from the host's memo, and an opted-out viewer of the same host gets the same transaction bytes as an opted-in one, raw and coded, at every transaction",
        r.problems.length === 0,
        r.problems.length === 0 ? r.detail : `${r.problems.join("; ")} (${r.detail})`,
      ),
    );
  }

  // tag-late-join, tag-reconnect
  if (legSkipped(g, "live")) checks.push(notRun("tag-late-join", "late-join-meta"));
  else {
    const d = lateJoinProblems(join(g, "live"), "d");
    checks.push(
      check(
        "tag-late-join",
        "TAG1 late-join-meta: a viewer joining late gets, before its first full, a full record whose table equals the one a frame-0 viewer holds after the transaction of the same frame",
        d.problems.length === 0,
        d.problems.length === 0 ? d.detail : d.problems.join("; "),
      ),
    );
  }
  if (legSkipped(g, "reconnect")) checks.push(notRun("tag-reconnect", "reconnect"));
  else {
    const f = lateJoinProblems(join(g, "reconnect"), "f");
    const e = viewerReport(join(g, "reconnect", "e"));
    if (e?.closed_early !== true) f.problems.push("reconnect/e did not close early");
    checks.push(
      check(
        "tag-reconnect",
        "TAG1 reconnect: a viewer that closed (reconnect/e) and one connecting after it (reconnect/f, a fresh session) gets a full record equal to the frame-0 viewer's table at its first frame",
        f.problems.length === 0,
        f.problems.length === 0 ? f.detail : f.problems.join("; "),
      ),
    );
  }

  // tag-rekey
  if (legSkipped(g, "live")) checks.push(notRun("tag-rekey", "rekey"));
  else {
    const stats = readJson<{ rekey_copies?: number }>(join(g, "live", "host", "evidence", "item-meta.json"));
    const ids = jsonlOf<IdLine>(join(g, "live", "host", "ids.jsonl"));
    const dump = readJson<Dump>(join(g, "live", "a-decoded.rs13.item-meta-dump.json"));
    const problems: string[] = [];
    const copies = ids.filter((l) => l.copy);
    if ((stats?.rekey_copies ?? 0) < 1 || copies.length === 0) problems.push("no rekey copy");
    for (const c of copies) {
      const orig = ids.find((l) => l.rid === c.rid && l.id !== c.id && !l.copy);
      const a = dump?.seen[String(c.id)];
      const b = orig !== undefined ? dump?.seen[String(orig.id)] : undefined;
      if (orig === undefined) problems.push(`copy ${c.id}: no original entry for rid ${c.rid}`);
      else if (a === undefined) problems.push(`copy ${c.id}: live/a got no row`);
      else if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b))
        problems.push(`copy ${c.id} row != original ${orig.id}'s`);
    }
    checks.push(
      check(
        "tag-rekey",
        "TAG1 rekey: under GRC_UNKNOWN_ITEM=skip a subtree re-keyed out of a withheld parent keeps its identity: the host copies the entry to the fresh id, and the viewer's row for it equals the original's",
        problems.length === 0,
        problems.length === 0 ? `${copies.length} copied: ids ${copies.map((c) => c.id).join(",")}` : problems.join("; "),
      ),
    );
  }

  // tag-resync
  if (legSkipped(g, "resync")) checks.push(notRun("tag-resync", "resync"));
  else {
    const r = viewerReport(join(g, "resync", "a"));
    const ls = lines(join(g, "resync", "a"));
    const fulls = ls.filter((l) => l.kind === "item_meta" && l.form === "full").length;
    const resyncs = ((r?.resyncs as unknown[]) ?? []).length;
    const ok = resyncs >= 1 && fulls >= 2 && rsValidate(tapOf(join(g, "resync")), REQUEST) === "ok";
    checks.push(
      check(
        "tag-resync",
        "TAG1 resync: after drop-message forces a coding resync, the full that answers it carries a full item_meta record (the stream validates, item-meta-missing never fires)",
        ok,
        `${resyncs} resyncs, ${fulls} full records`,
      ),
    );
  }

  // tag-refused
  if (legSkipped(g, "refused")) checks.push(notRun("tag-refused", "refused"));
  else {
    const a = viewerReport(join(g, "refused", "a"));
    const b = lines(join(g, "refused", "b"));
    const dumpPath = join(g, "refused", "b.item-meta-dump.json");
    const v = rsValidate(join(g, "refused", "b", "decoded.rs13"), REQUEST, dumpPath);
    const dump = readJson<{ grant: ItemMetaRequest | null }>(dumpPath);
    const problems: string[] = [];
    if ((a?.item_meta_records as number) !== 0) problems.push("the refused viewer got records");
    if (!b.some((l) => l.kind === "item_meta")) problems.push("the partial viewer got no record");
    if (v !== "ok") problems.push(`b: ${v}`);
    if (JSON.stringify(dump?.grant) !== JSON.stringify({ fields: ["class"], groups: [], meta_keys: [] }))
      problems.push(`b's grant ${JSON.stringify(dump?.grant)}, expected class only`);
    checks.push(
      check(
        "tag-refused",
        "TAG1 refused: under GRC_ITEM_META=class a viewer asking only for groups gets no record at all, and one asking for everything gets the grant {class} (one column per row)",
        problems.length === 0,
        problems.length === 0 ? "refused: 0 records; partial: grant class" : problems.join("; "),
      ),
    );
  }

  // tag-off
  if (legSkipped(g, "grant-off")) checks.push(notRun("tag-off", "off"));
  else {
    const on = existsSync(join(g, "grant-off", "host", "evidence", "item-meta.json"));
    const c = viewerReport(join(g, "grant-off", "c"));
    checks.push(
      check(
        "tag-off",
        "TAG1 off: with the grant set and no viewer asking, the host never resolves (no node map, no item-meta.json) and the viewer gets no record",
        !on && (c?.item_meta_records as number) === 0,
        `host on: ${on}, records: ${String(c?.item_meta_records)}`,
      ),
    );
  }

  // tag-cost (informative)
  {
    const s = readJson<{ resolved: number; resolve_ns: number; max_pass_ns: number; max_pass_items: number; passes: number }>(
      join(g, "live", "host", "evidence", "item-meta.json"),
    );
    checks.push({
      id: "tag-cost",
      criterion: "TAG1 (informative): the host's resolution cost on tag-scene",
      passed: true,
      status: "pass",
      gating: false,
      detail:
        s === null
          ? "no item-meta.json"
          : `${s.resolved} resolved, ${(s.resolve_ns / 1000 / Math.max(1, s.resolved)).toFixed(2)} us per item, max pass ${(s.max_pass_ns / 1000).toFixed(0)} us (${s.max_pass_items} items), ${s.passes} passes`,
    });
  }

  // tag-sabotage-*
  const sabotage = (id: string, leg: string, what: string, caught: () => string | null): void => {
    if (legSkipped(g, leg)) {
      checks.push(notRun(id, what));
      return;
    }
    const why = caught();
    checks.push(check(id, what, why !== null, why ?? "not caught"));
  };
  sabotage(
    "tag-sabotage-in-shared-caught",
    "sabotage-in-shared",
    "TAG1 sabotage meta-in-shared (the record rides inside the transaction message) fails meta-shared",
    () => {
      const r = sharedProblems(join(g, "sabotage-in-shared"));
      return r.problems.length > 0 ? `meta-shared: ${r.problems[0]}` : null;
    },
  );
  sabotage(
    "tag-sabotage-before-ready-caught",
    "sabotage-before-ready",
    "TAG1 sabotage meta-before-ready (identities read in node_added, before _ready) fails meta-oracle on the groups set in _ready",
    () => {
      const r = oracleOf("sabotage-before-ready", "a/decoded.rs13");
      const groups = r.problems.find((p) => /differs in [a-z,]*groups/.test(p));
      return groups !== undefined ? `meta-oracle: ${groups.slice(0, 200)}` : null;
    },
  );
  sabotage(
    "tag-sabotage-skip-full-caught",
    "sabotage-skip-full",
    "TAG1 sabotage meta-skip-full (no full record before the resync's full) fails the validator with item-meta-missing",
    () => {
      const v = rsValidate(tapOf(join(g, "sabotage-skip-full")), REQUEST);
      return v.startsWith("item-meta-missing") ? v : null;
    },
  );
  sabotage(
    "tag-sabotage-id-off-by-one-caught",
    "sabotage-id-off-by-one",
    "TAG1 sabotage meta-id-off-by-one (every row's id + 1) fails meta-oracle or the validator's item-meta-id",
    () => {
      const v = rsValidate(join(g, "sabotage-id-off-by-one", "a", "decoded.rs13"), REQUEST);
      if (v.startsWith("item-meta-id")) return v;
      const r = oracleOf("sabotage-id-off-by-one", "a/decoded.rs13");
      return r.problems.length > 0 ? `meta-oracle: ${r.problems[0].slice(0, 200)}` : null;
    },
  );
  return checks;
}
