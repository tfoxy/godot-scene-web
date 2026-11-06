// Gate 8 g8id14's checks (ID3, protocol/render-stream-14.md, client-extensions-design.md "Identity
// v2"): item_meta v2 (`instance_id`, `mouse_filter`, re-stamped rows) on fixtures/tag-scene's
// RS_FIXTURE_TAG_V2 variant and the pure path on capture-scale and gate6-scene, judged on
// run-gate8.sh run_g8id14's legs (under g8id14/):
//
//   id-validate         every viewer's stream passes rs-core-check and the TS validator at its
//                       version with its hello's ask; both /14 file sinks of `file` pass them at 14,
//                       carry item_meta records and a re-stamped row, and transcode to a valid /13
//                       stream (rs-core-check transcode --to 13); golden-14 passes in rs-core
//   id-meta-oracle      live/a and one/a: every row the viewer holds (the last row each id had)
//                       equals the fixture's own dump of that item's node (class, script, scene,
//                       path, instance_id, mouse_filter, groups, meta), joined by canvas-item RID
//                       through the capture's id log; every resolved node has a row
//   id-meta-file-oracle the same on `file`'s /14 patch recording
//   id-restamp          live/a, sweep0/a: each set_mouse_filter flip (steps 40, 50) is re-stamped by
//                       the host <= 1 frame after the flip's frame, and the viewer holds the new
//                       value after the first transaction formed at or after that stamp
//   id-sweep            live/a, sweep4/a: the recursive disable (step 60) reaches every Control below
//                       it (and itself) within ceil(Controls / GRC_ITEM_META_SWEEP) frames, host and
//                       viewer
//   id-instance-stable  live (A, B, D) and reconnect (A, E, F): one instance_id per node across the
//                       fixture's dumps (Card2's and Mover's reparents included), every viewer's row
//                       for it carries that id, and a re-keyed copy keeps it
//   id-shared           live: A and B (/14, the same request) get byte-identical item_meta records,
//                       raw and coded, from the host's memo; C (/13, asks nothing) gets the same
//                       transaction bytes as A, raw and coded
//   id-late-join        live/d (joins after step 60): its first full table equals A's at that frame
//                       and carries the fixture's current filters
//   id-rearm            live, one: custom callables on property_list_changed are > 0 on every
//                       resolved Control while armed and 0 on every Control after the disarm (the
//                       fixture's own count), and item-meta.json v2_watched_after_off is 0
//   id-pure             the listener's subprotocols without a v2 grant hold no render-stream.14 and
//                       with one are render-stream.14 then that same list; a /13 viewer asking v2
//                       names is refused (bad control message) and one asking /13 fields gets them
//                       only; /13 file sinks with no grant and with the v2 grant (nobody asking) are
//                       identical (cmp-rec.ts --tree); the /13 viewer asking nothing gets the same
//                       transactions with and without the grant, and as the one asking /13 fields
//   id-cost             (informative) the v2 host cost on tag-scene and, when G8ID14_ONLY_COST ran,
//                       on capture-scale (id-cost/)
//   id-sabotage-*       each GRC_ITEM_META_SABOTAGE leg fails the check it targets
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";
import {
  createRecordingValidator,
  type ItemMetaRequest,
  type ItemMetaTable,
  splitRecords,
  validateRecording,
} from "./render-stream-2";

type Version = 13 | 14;
export const ID_REQUEST: ItemMetaRequest = {
  fields: ["class", "script", "scene", "path", "instance_id", "mouse_filter"],
  groups: ["rs_hand", "rs_text", "rs_none"],
  meta_keys: ["rs_tag", "rs_slot", "rs_missing"],
};
const REQUEST_13: ItemMetaRequest = {
  fields: ["class", "script", "scene", "path"],
  groups: [],
  meta_keys: [],
};
const REQUEST_V2_AT_13: ItemMetaRequest = {
  fields: ["class", "instance_id", "mouse_filter"],
  groups: [],
  meta_keys: [],
};
const FIELDS = [
  "class",
  "script",
  "scene",
  "path",
  "instance_id",
  "mouse_filter",
] as const;
type Field = (typeof FIELDS)[number];

export interface Identity {
  class: string | null;
  script: string | null;
  scene: string | null;
  path: string | null;
  instance_id: string | null;
  mouse_filter: number | null;
  groups: string[];
  meta: Record<string, string | null>;
}
interface OracleNode extends Partial<Identity> {
  rid: string;
  groups: string[];
  meta: Record<string, string | null>;
  plc_custom?: number | null;
}
interface Flip {
  step: number;
  node: string;
  rid: string;
  mouse_filter: number;
}
interface OracleLine {
  frame: number;
  process_frames?: number;
  flips?: Flip[];
  nodes: OracleNode[];
}
export interface IdLine {
  id: number;
  rid: string;
  stamp: number;
  node: boolean;
  copy: boolean;
  restamp?: number;
}
interface Line {
  index: number;
  kind?: string;
  sha256?: string;
  wire_sha256?: string;
  wire_bytes?: number;
  decoded_bytes?: number;
  seq?: number;
  frame?: number;
  form?: string;
  rows?: number | null;
  envelope_seq?: number;
}
type Row = Identity | null; // resolved; null: no node
interface Dump {
  grant: ItemMetaRequest | null;
  seen: Record<string, unknown>;
  rows: Record<string, unknown>;
  full_records: number;
  delta_records: number;
}

function check(
  id: string,
  criterion: string,
  passed: boolean,
  detail: string,
): G8aCheck {
  return { id, criterion, passed, status: passed ? "pass" : "fail", detail };
}

function notRun(
  id: string,
  criterion: string,
  why = "leg skipped by tier",
): G8aCheck {
  return {
    id,
    criterion,
    passed: true,
    status: "not-run",
    detail: `${id}: ${why}`,
    gating: false,
  };
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

/** rs-core-check validate at `version` (with the ask); "ok" or the error. Writes the dump when asked. */
function rsValidate(
  path: string,
  version: Version,
  request: ItemMetaRequest | null | undefined,
  dump?: string,
): string {
  const args = ["validate", path, "--version", String(version)];
  if (request !== undefined) args.push("--item-meta-asked", ask(request));
  if (dump !== undefined) args.push("--item-meta-dump", dump);
  const r = spawnSync(RS_CORE_CHECK, args, { encoding: "utf8" });
  const cols = ((r.stdout ?? "").trim().split("\n").at(-1) ?? "").split("\t");
  return cols[1] === "ok"
    ? "ok"
    : `${cols[1] ?? "?"}: ${(cols[2] ?? r.stderr ?? "").slice(0, 200)}`;
}

function tsValidate(
  path: string,
  version: Version,
  request: ItemMetaRequest | null | undefined,
): string {
  try {
    const errors = validateRecording(
      new Uint8Array(readFileSync(path)),
      version,
      { itemMeta: request },
    );
    return errors.length === 0 ? "ok" : errors[0].slice(0, 200);
  } catch (e) {
    return `throws: ${String(e).slice(0, 200)}`;
  }
}

/** rs-core-check's dump row form -> Identity (groups as names, every meta key present). */
function fromDump(row: unknown, grant: ItemMetaRequest): Row {
  if (row === null || row === undefined) return null;
  const r = row as Record<string, unknown>;
  const mask = typeof r.groups === "number" ? r.groups : 0;
  const meta: Record<string, string | null> = {};
  const m = (r.meta ?? {}) as Record<string, string | null>;
  for (const k of grant.meta_keys) meta[k] = m[k] ?? null;
  const f = (k: Field): unknown =>
    grant.fields.includes(k) ? (r[k] ?? null) : null;
  return {
    class: f("class") as string | null,
    script: f("script") as string | null,
    scene: f("scene") as string | null,
    path: f("path") as string | null,
    instance_id: f("instance_id") as string | null,
    mouse_filter: f("mouse_filter") as number | null,
    groups: grant.groups.filter((_, i) => (mask & (1 << i)) !== 0),
    meta,
  };
}

/** The fixture's dump of a node, cut to what `grant` carries. */
function oracleIdentity(n: OracleNode, grant: ItemMetaRequest): Identity {
  const meta: Record<string, string | null> = {};
  for (const k of grant.meta_keys) meta[k] = n.meta[k] ?? null;
  const f = (k: Field): unknown =>
    grant.fields.includes(k) ? (n[k] ?? null) : null;
  return {
    class: f("class") as string | null,
    script: f("script") as string | null,
    scene: f("scene") as string | null,
    path: f("path") as string | null,
    instance_id: f("instance_id") as string | null,
    mouse_filter: f("mouse_filter") as number | null,
    groups: grant.groups.filter((g) => n.groups.includes(g)),
    meta,
  };
}

function same(a: unknown, b: unknown): boolean {
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
    const s = (v: unknown): string | null =>
      typeof v === "number" ? (t.strings[v] ?? null) : null;
    const f: Partial<Record<Field, unknown>> = {};
    for (const name of g.fields as Field[]) {
      const v = cols[c++];
      f[name] =
        name === "instance_id" || name === "mouse_filter" ? (v ?? null) : s(v);
    }
    let mask = 0;
    if (g.groups.length > 0) mask = (cols[c++] as number) ?? 0;
    const meta: Record<string, string | null> = {};
    for (const k of g.meta_keys) meta[k] = s(cols[c++]);
    out.set(id, {
      class: (f.class as string | null) ?? null,
      script: (f.script as string | null) ?? null,
      scene: (f.scene as string | null) ?? null,
      path: (f.path as string | null) ?? null,
      instance_id: (f.instance_id as string | null) ?? null,
      mouse_filter: (f.mouse_filter as number | null) ?? null,
      groups: g.groups.filter((_, i) => (mask & (1 << i)) !== 0),
      meta,
    });
  }
  return out;
}

function metaOf(bytes: Uint8Array): { text: string; len: number } | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(4, true);
  return {
    text: new TextDecoder().decode(bytes.subarray(8, 8 + len)),
    len,
  };
}

/** Walks a decoded stream with the TS validator; after each accepted transaction, the table by
 * that transaction's frame (in order). Stops at the first error. */
function tablesByFrame(
  path: string,
  version: Version,
  request: ItemMetaRequest,
): {
  frames: Map<number, Map<number, Row>>;
  order: number[];
  error: string | null;
} {
  const frames = new Map<number, Map<number, Row>>();
  const order: number[] = [];
  if (!existsSync(path)) return { frames, order, error: `${path} missing` };
  const split = splitRecords(new Uint8Array(readFileSync(path)), version);
  if (split.errors.length > 0) return { frames, order, error: split.errors[0] };
  const v = createRecordingValidator(split.records, version, {
    itemMeta: request,
  });
  if (v.errors) return { frames, order, error: v.errors[0] };
  for (let i = 1; i < split.records.length; i++) {
    const errors = v.accept(i);
    if (errors) return { frames, order, error: errors[0] };
    const m = metaOf(split.records[i].bytes);
    if (m === null || !m.text.startsWith('{"type":"transaction"')) continue;
    const frame = (JSON.parse(m.text) as { frame: number }).frame;
    if (v.itemMeta) {
      frames.set(frame, resolveTable(v.itemMeta()));
      order.push(frame);
    }
  }
  return { frames, order, error: null };
}

const legSkipped = (g: string, leg: string): boolean =>
  skipped(join(g, leg)) !== null || skipped(join(g, leg, "host")) !== null;

const viewerReport = (dir: string): Record<string, unknown> | null =>
  readJson<Record<string, unknown>>(join(dir, "coding-receiver.json"));

const lines = (dir: string): Line[] =>
  jsonlOf<Line>(join(dir, "messages.jsonl"));

const oracleOf = (leg: string): OracleLine[] =>
  jsonlOf<OracleLine>(join(leg, "host", "oracle.jsonl"));

const idsOf = (leg: string): IdLine[] =>
  jsonlOf<IdLine>(join(leg, "host", "ids.jsonl"));

const decodedOf = (leg: string, v: string, version: Version): string =>
  join(leg, v, `decoded.rs${version}`);

/** The rs-core-check dump of a viewer's stream (written beside the leg). */
function dumpOf(
  leg: string,
  stream: string,
  version: Version,
  request: ItemMetaRequest | undefined,
): { dump: Dump | null; validate: string } {
  const dumpPath = join(
    leg,
    `${stream.replace(/\//g, "-")}.item-meta-dump.json`,
  );
  const validate = rsValidate(join(leg, stream), version, request, dumpPath);
  return { dump: readJson<Dump>(dumpPath), validate };
}

// ------------------------------------------------------------------------------- id-meta-oracle

/** meta-oracle: the rows a stream's dump `seen` holds against the fixture's last dump of each
 * node, through the capture's id log (re-stamp lines included: they name the same id and RID). */
export function oracleProblems(
  dump: Dump | null,
  oracle: OracleLine[],
  ids: IdLine[],
  grant: ItemMetaRequest,
): {
  problems: string[];
  rows: number;
  noNode: number;
  matched: number;
  hasPoint: number;
} {
  const problems: string[] = [];
  if (dump === null)
    return {
      problems: ["no item_meta dump"],
      rows: 0,
      noNode: 0,
      matched: 0,
      hasPoint: 0,
    };
  const last = new Map<string, OracleNode>();
  for (const line of oracle) for (const n of line.nodes) last.set(n.rid, n);
  const ridOf = new Map<number, string>();
  for (const l of ids) ridOf.set(l.id, l.rid);
  let noNode = 0;
  let matched = 0;
  let hasPoint = 0;
  const rows = Object.entries(dump.seen);
  for (const [idText, raw] of rows) {
    const id = Number(idText);
    const rid = ridOf.get(id);
    const row = fromDump(raw, grant);
    if (rid === undefined) {
      problems.push(`row ${id}: the capture never resolved that id`);
      continue;
    }
    const node = last.get(rid);
    if (row === null) {
      noNode += 1;
      if (node !== undefined)
        problems.push(
          `row ${id} (rid ${rid}): no node, but the fixture dumped ${node.class} ${node.path}`,
        );
      continue;
    }
    if (node === undefined) {
      problems.push(
        `row ${id} (rid ${rid}): a node row for a RID the fixture never dumped`,
      );
      continue;
    }
    const want = oracleIdentity(node, grant);
    if (!same(row, want)) {
      const keys = (Object.keys(want) as Array<keyof Identity>).filter(
        (k) => !same(row[k], want[k]),
      );
      problems.push(
        `row ${id} (rid ${rid}, ${node.class} ${node.path}): differs in ${keys.join(",")}: ` +
          keys
            .map(
              (k) =>
                `${JSON.stringify(row[k])} != fixture ${JSON.stringify(want[k])}`,
            )
            .join(", "),
      );
      continue;
    }
    if (typeof row.mouse_filter === "number" && (row.mouse_filter & 4) !== 0)
      hasPoint += 1;
    matched += 1;
  }
  const seenIds = new Set(rows.map(([k]) => Number(k)));
  for (const l of ids) {
    if (last.has(l.rid) && !seenIds.has(l.id))
      problems.push(
        `id ${l.id} (rid ${l.rid}, ${last.get(l.rid)?.path}) has no row`,
      );
  }
  return { problems, rows: rows.length, noNode, matched, hasPoint };
}

function metaOracle(
  leg: string,
  stream: string,
  version: Version,
  request: ItemMetaRequest | undefined,
): ReturnType<typeof oracleProblems> {
  const { dump, validate } = dumpOf(leg, stream, version, request);
  const r = oracleProblems(dump, oracleOf(leg), idsOf(leg), ID_REQUEST);
  if (validate !== "ok") r.problems.unshift(`validate: ${validate}`);
  return r;
}

function metaOracleVerdict(r: ReturnType<typeof oracleProblems>): {
  ok: boolean;
  detail: string;
} {
  const enough = r.matched >= 20 && r.noNode >= 1 && r.hasPoint >= 1;
  return {
    ok: r.problems.length === 0 && enough,
    detail:
      r.problems.length === 0
        ? `${r.rows} rows: ${r.matched} equal the fixture's dump (${r.hasPoint} with the _has_point bit), ${r.noNode} with no node${enough ? "" : " (expected >= 20 node rows, >= 1 no-node row, >= 1 _has_point row)"}`
        : r.problems.slice(0, 6).join("; "),
  };
}

// ------------------------------------------------------------------------- id-restamp, id-sweep

interface Change {
  step: number;
  node: string;
  rid: string;
  value: number;
  frame: number; // the capture frame of the change (process_frames + 1)
}

/** The fixture's filter changes at `steps` that actually changed the value (the previous dump's
 * value differs), each at its capture frame. */
function changesOf(oracle: OracleLine[], steps: number[]): Change[] {
  const out: Change[] = [];
  const prev = new Map<string, number | null>();
  for (const line of oracle) {
    for (const f of line.flips ?? []) {
      if (!steps.includes(f.step) || line.process_frames === undefined)
        continue;
      if (prev.get(f.rid) === f.mouse_filter) continue;
      out.push({
        step: f.step,
        node: f.node,
        rid: f.rid,
        value: f.mouse_filter,
        frame: line.process_frames + 1,
      });
    }
    for (const n of line.nodes) prev.set(n.rid, n.mouse_filter ?? null);
  }
  return out;
}

/** For each change: the host's first re-stamp of that RID to that value at or after the change
 * (lag = stamp - frame), and the first transaction (at or after the stamp) after which the viewer
 * holds the value. */
function restampLags(
  leg: string,
  viewer: string,
  changes: Change[],
): {
  problems: string[];
  host: Array<{ c: Change; lag: number | null; viewer: number | null }>;
} {
  const problems: string[] = [];
  const ids = idsOf(leg);
  const t = tablesByFrame(decodedOf(leg, viewer, 14), 14, ID_REQUEST);
  if (t.error !== null) problems.push(`${viewer}: ${t.error}`);
  const host: Array<{ c: Change; lag: number | null; viewer: number | null }> =
    [];
  for (const c of changes) {
    const stamp = ids.find(
      (l) => l.rid === c.rid && l.restamp === c.value && l.stamp >= c.frame,
    )?.stamp;
    const idsOfRid = new Set(
      ids.filter((l) => l.rid === c.rid).map((l) => l.id),
    );
    let seen: number | null = null;
    if (stamp !== undefined) {
      const at = t.order.find((f) => f >= stamp);
      const table = at === undefined ? undefined : t.frames.get(at);
      if (
        at !== undefined &&
        table !== undefined &&
        [...idsOfRid].some((id) => table.get(id)?.mouse_filter === c.value)
      )
        seen = at - c.frame;
      else
        problems.push(
          `${c.node} -> ${c.value} (step ${c.step}, frame ${c.frame}): re-stamped at ${stamp}, but ${viewer} does not hold it after the transaction of frame ${at ?? "none"}`,
        );
    }
    host.push({
      c,
      lag: stamp === undefined ? null : stamp - c.frame,
      viewer: seen,
    });
  }
  return { problems, host };
}

function restampProblems(leg: string): { problems: string[]; detail: string } {
  const changes = changesOf(oracleOf(leg), [40, 50]);
  const r = restampLags(leg, "a", changes);
  const problems = [...r.problems];
  if (changes.length !== 4)
    problems.push(
      `expected 4 flips (Card1, Flipper at steps 40 and 50), the fixture logged ${changes.length}`,
    );
  for (const h of r.host) {
    if (h.lag === null)
      problems.push(
        `${h.c.node} -> ${h.c.value} (step ${h.c.step}): never re-stamped`,
      );
    else if (h.lag > 1)
      problems.push(
        `${h.c.node} -> ${h.c.value} (step ${h.c.step}): re-stamped ${h.lag} frames late`,
      );
  }
  return {
    problems: problems.slice(0, 6),
    detail: r.host
      .map(
        (h) =>
          `${h.c.node}@${h.c.step}: host +${h.lag ?? "never"}, viewer +${h.viewer ?? "never"}`,
      )
      .join("; "),
  };
}

function sweepProblems(leg: string): { problems: string[]; detail: string } {
  const oracle = oracleOf(leg);
  const changes = changesOf(oracle, [60]);
  const stats = readJson<{
    v2_sweep_per_frame?: number;
    v2_watched_max?: number;
  }>(join(leg, "host", "evidence", "item-meta.json"));
  const sweep = stats?.v2_sweep_per_frame ?? 0;
  const watched = stats?.v2_watched_max ?? 0;
  const problems: string[] = [];
  if (changes.length < 4)
    problems.push(
      `expected >= 4 Controls changed by the recursive disable, the fixture logged ${changes.length}`,
    );
  if (sweep === 0) problems.push("the sweep was off (v2_sweep_per_frame 0)");
  const bound = sweep > 0 ? Math.ceil(watched / sweep) : 0;
  const r = restampLags(leg, "a", changes);
  problems.push(...r.problems);
  let max = 0;
  for (const h of r.host) {
    if (h.lag === null)
      problems.push(`${h.c.node} never re-stamped to ${h.c.value}`);
    else {
      max = Math.max(max, h.lag);
      if (h.lag >= bound)
        problems.push(
          `${h.c.node}: re-stamped ${h.lag} frames after the disable, the bound is ${bound}`,
        );
    }
  }
  return {
    problems: problems.slice(0, 6),
    detail: `${changes.length} Controls, sweep ${sweep} of ${watched} watched: bound ${bound} frame(s), host lag max ${max}; ${r.host.map((h) => `${h.c.node} host +${h.lag ?? "never"} viewer +${h.viewer ?? "never"}`).join(", ")}`,
  };
}

// ------------------------------------------------------------------------- id-instance-stable

function instanceProblems(
  leg: string,
  viewers: string[],
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const oracle = oracleOf(leg);
  const ids = idsOf(leg);
  const iid = new Map<string, Set<string>>();
  for (const line of oracle)
    for (const n of line.nodes) {
      if (typeof n.instance_id !== "string") continue;
      const s = iid.get(n.rid) ?? new Set<string>();
      s.add(n.instance_id);
      iid.set(n.rid, s);
    }
  for (const [rid, s] of iid)
    if (s.size !== 1)
      problems.push(`rid ${rid}: the fixture dumped ${s.size} instance ids`);
  const ridOf = new Map<number, string>();
  for (const l of ids) ridOf.set(l.id, l.rid);
  let rows = 0;
  for (const v of viewers) {
    const { dump, validate } = dumpOf(leg, `${v}/decoded.rs14`, 14, ID_REQUEST);
    if (dump === null) {
      problems.push(`${v}: no dump (${validate})`);
      continue;
    }
    for (const [idText, raw] of Object.entries(dump.seen)) {
      const row = fromDump(raw, ID_REQUEST);
      if (row === null) continue;
      const rid = ridOf.get(Number(idText));
      const want = rid === undefined ? undefined : [...(iid.get(rid) ?? [])][0];
      rows += 1;
      if (want === undefined || row.instance_id !== want)
        problems.push(
          `${v} row ${idText}: instance_id ${row.instance_id}, the fixture ${want}`,
        );
    }
  }
  // The reparented instance (Card2, step 20) and the re-keyed copy (Mover, step 60).
  const card2 = oracle
    .at(-1)
    ?.nodes.find((n) => n.path === "." && n.meta.rs_slot === "2");
  if (card2 === undefined) problems.push("the fixture dumped no Card2");
  const copies = ids.filter((l) => l.copy);
  if (copies.length === 0) problems.push("no re-keyed copy");
  return {
    problems: problems.slice(0, 6),
    detail: `${iid.size} nodes, one instance id each; ${rows} rows over ${viewers.join(",")}; Card2 (reparented) rid ${card2?.rid}; ${copies.length} re-keyed copies (ids ${copies.map((c) => c.id).join(",")})`,
  };
}

// ---------------------------------------------------------------------------------- id-shared

/** item_meta records keyed by the range a delta covers ("<previous tx frame>-><next tx frame>"). */
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
  baseFrame: number | null;
  norm: string; // sha256 of the record with its seq and base_seq zeroed
}

/** A decoded stream's transactions by frame, un-predicted (rs-core-check transcode --to 12: a /13
 * transaction's predicted blocks depend on the connection's own history, so two connections'
 * records of one frame and base differ byte for byte; their /12 forms do not), with a
 * seq-independent digest each. */
function txsOf(path: string): Map<number, Tx> {
  const out = new Map<number, Tx>();
  if (!existsSync(path)) return out;
  const plain = `${path}.unpredicted.rs12`;
  if (!existsSync(plain)) {
    const t = spawnSync(
      RS_CORE_CHECK,
      ["transcode", "--to", "12", path, plain],
      { encoding: "utf8" },
    );
    if (t.status !== 0) return out;
  }
  const split = splitRecords(new Uint8Array(readFileSync(plain)), 12);
  const frameOfSeq = new Map<number, number>();
  for (const rec of split.records) {
    const m = metaOf(rec.bytes);
    if (m === null || !m.text.startsWith('{"type":"transaction"')) continue;
    const meta = JSON.parse(m.text) as {
      seq: number;
      frame: number;
      base_seq?: number | null;
    };
    frameOfSeq.set(meta.seq, meta.frame);
    const h = createHash("sha256");
    h.update(
      m.text
        .replace(/"seq":\d+/, '"seq":0')
        .replace(/"base_seq":\d+/, '"base_seq":0'),
    );
    h.update(rec.bytes.subarray(8 + m.len));
    out.set(meta.frame, {
      seq: meta.seq,
      baseFrame:
        meta.base_seq === null || meta.base_seq === undefined
          ? null
          : (frameOfSeq.get(meta.base_seq) ?? -1),
      norm: h.digest("hex"),
    });
  }
  return out;
}

/** Transactions of x and y equal (un-predicted, seq aside) wherever they share a frame and base
 * frame, and (`strict`: two connections of one host) byte for byte, raw and coded, where their
 * seqs agree too. Across two hosts the predicted bytes follow each connection's whole history
 * (its pacing), so only the un-predicted comparison applies. */
export function sameTransactions(
  xDir: string,
  xVersion: Version,
  yDir: string,
  yVersion: Version,
  name: string,
  strictBytes = true,
  minCompared = 10,
): { problems: string[]; normalized: number; strict: number } {
  const problems: string[] = [];
  const xt = txsOf(join(xDir, `decoded.rs${xVersion}`));
  const yt = txsOf(join(yDir, `decoded.rs${yVersion}`));
  let normalized = 0;
  for (const [frame, x] of xt) {
    const y = yt.get(frame);
    if (y === undefined || y.baseFrame !== x.baseFrame) continue;
    normalized += 1;
    if (x.norm !== y.norm)
      problems.push(
        `frame ${frame}: ${name} transactions differ (un-predicted, seq aside)`,
      );
  }
  const yl = new Map<number, Line>();
  for (const l of lines(yDir))
    if (l.kind === "transaction" && l.frame !== undefined) yl.set(l.frame, l);
  let strict = 0;
  for (const lx of strictBytes ? lines(xDir) : []) {
    if (lx.kind !== "transaction" || lx.frame === undefined) continue;
    const ly = yl.get(lx.frame);
    const xb = xt.get(lx.frame);
    const yb = yt.get(lx.frame);
    if (
      ly === undefined ||
      ly.seq !== lx.seq ||
      ly.envelope_seq !== lx.envelope_seq ||
      xb === undefined ||
      yb === undefined ||
      xb.baseFrame !== yb.baseFrame
    )
      continue;
    strict += 1;
    if (lx.sha256 !== ly.sha256)
      problems.push(`frame ${lx.frame}: ${name} raw bytes differ`);
    if (lx.wire_sha256 !== ly.wire_sha256)
      problems.push(`frame ${lx.frame}: ${name} coded bytes differ`);
  }
  if (normalized < minCompared)
    problems.push(
      `only ${normalized} transactions of ${name} share a frame and base`,
    );
  return { problems, normalized, strict };
}

function sharedProblems(leg: string): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const am = metaByRange(lines(join(leg, "a")));
  const bm = metaByRange(lines(join(leg, "b")));
  let compared = 0;
  let deltas = 0;
  for (const [range, la] of am) {
    const lb = bm.get(range);
    if (lb === undefined) continue;
    compared += 1;
    if (la.form === "delta") deltas += 1;
    if (la.sha256 !== lb.sha256)
      problems.push(`${range}: A and B item_meta records differ (raw)`);
    if (la.wire_sha256 !== lb.wire_sha256)
      problems.push(`${range}: A and B item_meta records differ (coded)`);
  }
  if (compared === 0)
    problems.push("A and B have no item_meta record over the same range");
  // A and B against C: a viewer whose hello missed the held frame starts one seq later, and
  // byte for byte needs equal seqs, so the strict count is over both.
  const ac = sameTransactions(join(leg, "a"), 14, join(leg, "c"), 13, "A/C");
  const bc = sameTransactions(join(leg, "b"), 14, join(leg, "c"), 13, "B/C");
  problems.push(...ac.problems, ...bc.problems);
  if (ac.strict + bc.strict < 10)
    problems.push(
      `only ${ac.strict + bc.strict} /14 transactions share a seq with C's (byte for byte)`,
    );
  const summary = readJson<{
    connections?: Array<{ item_meta?: { shared: number } }>;
  }>(join(leg, "host", "evidence", "live-summary.json"));
  const shared = (summary?.connections ?? []).reduce(
    (n, s) => n + (s.item_meta?.shared ?? 0),
    0,
  );
  if (shared === 0)
    problems.push("the host shared no item_meta record (memo hits 0)");
  return {
    problems: problems.slice(0, 8),
    detail: `${compared} A/B records compared (${deltas} deltas, the re-stamps among them); /14 against C (/13): A ${ac.normalized} and B ${bc.normalized} transactions equal un-predicted, ${ac.strict + bc.strict} byte for byte raw and coded; ${shared} memo hits`,
  };
}

// ------------------------------------------------------------------------------- id-late-join

function lateJoinProblems(leg: string): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const a = tablesByFrame(decodedOf(leg, "a", 14), 14, ID_REQUEST);
  const d = tablesByFrame(decodedOf(leg, "d", 14), 14, ID_REQUEST);
  if (a.error !== null) problems.push(`A: ${a.error}`);
  if (d.error !== null) problems.push(`D: ${d.error}`);
  const f = d.order[0];
  if (f === undefined)
    return { problems: [...problems, "D got no transaction"], detail: "" };
  const oracle = oracleOf(leg);
  const disable = changesOf(oracle, [60])[0]?.frame;
  if (disable === undefined || f <= disable)
    problems.push(
      `D's first frame ${f} is not after the recursive disable (frame ${disable})`,
    );
  const mine = d.frames.get(f) ?? new Map<number, Row>();
  const theirs = a.frames.get(f);
  if (theirs === undefined) problems.push(`A has no transaction at frame ${f}`);
  else {
    for (const [id, row] of theirs) {
      if (!mine.has(id))
        problems.push(`frame ${f}: A holds row ${id}, D's full lacks it`);
      else if (!same(mine.get(id) ?? null, row))
        problems.push(`frame ${f}: row ${id} differs`);
    }
    for (const id of mine.keys())
      if (!theirs.has(id))
        problems.push(`frame ${f}: D's full has row ${id}, A does not`);
  }
  // The current filters: the fixture's last dump at or before D's first frame.
  const ridOf = new Map<number, string>();
  for (const l of idsOf(leg)) ridOf.set(l.id, l.rid);
  const at = [...oracle]
    .reverse()
    .find((l) => (l.process_frames ?? -1) + 1 <= f);
  const now = new Map<string, number | null>();
  for (const n of at?.nodes ?? []) now.set(n.rid, n.mouse_filter ?? null);
  let filters = 0;
  let disabled = 0;
  for (const [id, row] of mine) {
    if (row === null || row.mouse_filter === null) continue;
    const rid = ridOf.get(id);
    if (rid === undefined || !now.has(rid)) continue;
    filters += 1;
    if (row.mouse_filter !== now.get(rid))
      problems.push(
        `D's row ${id}: mouse_filter ${row.mouse_filter}, the fixture ${now.get(rid)}`,
      );
    else if (row.path?.startsWith("Nest")) disabled += 1;
  }
  if (disabled < 4)
    problems.push(
      `D's full carries ${disabled} disabled Nest rows (expected >= 4)`,
    );
  return {
    problems: problems.slice(0, 8),
    detail: `D's first frame ${f} (the disable at ${disable}): ${mine.size} rows equal A's, ${filters} filters equal the fixture's dump of frame ${at?.frame} (${disabled} Nest rows disabled)`,
  };
}

// ---------------------------------------------------------------------------------- id-rearm

function rearmProblems(leg: string): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const oracle = oracleOf(leg);
  const ids = idsOf(leg);
  const resolved = new Set(ids.map((l) => l.rid));
  const stats = readJson<Record<string, number>>(
    join(leg, "host", "evidence", "item-meta.json"),
  );
  const disarm = /disarmed from frame callback at frame (\d+)/.exec(
    existsSync(join(leg, "host", "stdout.log"))
      ? readFileSync(join(leg, "host", "stdout.log"), "utf8")
      : "",
  );
  const disarmFrame = disarm === null ? null : Number(disarm[1]);
  if (disarmFrame === null) problems.push("the host never disarmed");
  const armed = oracle
    .filter(
      (l) =>
        l.process_frames !== undefined &&
        disarmFrame !== null &&
        l.process_frames + 1 < disarmFrame &&
        l.frame > 150,
    )
    .at(-1);
  const after = oracle
    .filter(
      (l) =>
        l.process_frames !== undefined &&
        disarmFrame !== null &&
        l.process_frames + 1 > disarmFrame,
    )
    .at(-1);
  let armedControls = 0;
  let armedCallables = 0;
  if (armed === undefined) problems.push("no armed dump after the steps");
  else
    for (const n of armed.nodes) {
      if (typeof n.plc_custom !== "number" || !resolved.has(n.rid)) continue;
      armedControls += 1;
      armedCallables += n.plc_custom;
      if (n.plc_custom < 1)
        problems.push(
          `armed (frame ${armed.frame}): ${n.class} ${n.path} has no custom callable on property_list_changed`,
        );
    }
  let afterControls = 0;
  let left = 0;
  if (after === undefined) problems.push("no dump after the disarm");
  else
    for (const n of after.nodes) {
      if (typeof n.plc_custom !== "number") continue;
      afterControls += 1;
      left += n.plc_custom;
      if (n.plc_custom !== 0)
        problems.push(
          `after the disarm (frame ${after.frame}): ${n.class} ${n.path} keeps ${n.plc_custom} custom callables`,
        );
    }
  if (armedControls === 0) problems.push("no resolved Control while armed");
  if (stats === null) problems.push("no item-meta.json");
  else if ((stats.v2_watched_after_off ?? -1) !== 0)
    problems.push(`v2_watched_after_off ${stats.v2_watched_after_off}`);
  return {
    problems: problems.slice(0, 6),
    detail: `armed (frame ${armed?.frame}): ${armedCallables} custom callables on ${armedControls} resolved Controls; disarm at frame ${disarmFrame}; after (frame ${after?.frame}): ${left} on ${afterControls} Controls; v2_unwatched ${stats?.v2_unwatched}, v2_watched_after_off ${stats?.v2_watched_after_off}; the standby round (LS1's standby-hot-zero) is not run: no standby exists yet`,
  };
}

// ------------------------------------------------------------------------------------ id-pure

function subprotocolsOf(hostDir: string): string[] | null {
  const path = join(hostDir, "stdout.log");
  if (!existsSync(path)) return null;
  const m = /live: subprotocols (\S+)/.exec(readFileSync(path, "utf8"));
  return m === null ? null : m[1].split(",");
}

/** Every recording file (recording*.rsN) under `dir`, relative. */
function recordingsUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^recording.*\.rs\d+$/.test(e)) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const SCRIPTS = resolve(import.meta.dirname, "..");
const REPO = resolve(SCRIPTS, "..", "..", "..");
const CMP_REC = join(SCRIPTS, "cmp-rec.ts");

/** cmp-rec.ts --tree a b: "identical (n)" or the first difference. */
export function cmpTree(a: string, b: string): { ok: boolean; detail: string } {
  const n = recordingsUnder(a).length;
  if (n === 0) return { ok: false, detail: `no recording under ${a}` };
  if (!same(recordingsUnder(a), recordingsUnder(b)))
    return { ok: false, detail: `${a} and ${b} hold different recordings` };
  const r = spawnSync(
    "pnpm",
    ["exec", "tsx", "--conditions=development", CMP_REC, "--tree", a, b],
    { cwd: REPO, encoding: "utf8" },
  );
  return r.status === 0
    ? { ok: true, detail: `${n} identical` }
    : {
        ok: false,
        detail: `${(r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`,
      };
}

/** A /13 viewer (`r` of <leg>) asking v2 names: refused with a hello error (the host's error
 * message, reason protocol; its connection log's detail "bad control message: item_meta..."), and
 * no record. */
function refusedProblem(leg: string): string | null {
  const r = viewerReport(join(leg, "r"));
  if (r === null) return `${leg}/r: no viewer output`;
  const tap = join(leg, "host", "tap");
  const details = existsSync(tap)
    ? readdirSync(tap)
        .filter((f) => /^live-\d+\.jsonl$/.test(f))
        .flatMap((f) =>
          jsonlOf<{ event?: string; detail?: string }>(join(tap, f)),
        )
        .filter((l) => l.event === "error")
        .map((l) => l.detail ?? "")
    : [];
  const refused =
    String(r.fatal ?? "") === "host error protocol" &&
    details.some((d) => d.startsWith("bad control message: item_meta"));
  if (!refused)
    return `the /13 viewer asking ${JSON.stringify(REQUEST_V2_AT_13.fields)} was not refused (fatal ${JSON.stringify(r.fatal)}, host errors ${JSON.stringify(details).slice(0, 160)}, ${String(r.item_meta_records)} records)`;
  if ((r.item_meta_records as number) !== 0)
    return "the refused viewer got records";
  return null;
}

function pureLiveProblems(g: string, leg: string): string[] {
  const problems: string[] = [];
  const dir = join(g, leg);
  const r = refusedProblem(dir);
  if (r !== null) problems.push(`${leg}: ${r}`);
  const t = join(dir, "t");
  const dumpPath = join(dir, "t.item-meta-dump.json");
  const v = rsValidate(join(t, "decoded.rs13"), 13, REQUEST_13, dumpPath);
  if (v !== "ok") problems.push(`${leg}/t: ${v}`);
  const dump = readJson<Dump>(dumpPath);
  if (!same(dump?.grant, REQUEST_13))
    problems.push(
      `${leg}/t: grant ${JSON.stringify(dump?.grant)}, expected the /13 fields only`,
    );
  for (const name of ["c"]) {
    const ts = tsValidate(join(dir, name, "decoded.rs13"), 13, null);
    if (ts !== "ok") problems.push(`${leg}/${name} TS: ${ts}`);
  }
  // c and t are not lockstep (t's grant adds records to its connection), so their /13 bytes
  // follow different histories: un-predicted only.
  const ct = sameTransactions(join(dir, "c"), 13, t, 13, `${leg} c/t`, false);
  problems.push(...ct.problems.slice(0, 2));
  return problems;
}

export function pureProblems(g: string): {
  problems: string[];
  detail: string;
} {
  const problems: string[] = [];
  const details: string[] = [];
  for (const fx of ["scale", "scene"]) {
    const off = subprotocolsOf(join(g, "pure", `${fx}-live-off`, "host"));
    const on = subprotocolsOf(join(g, "pure", `${fx}-live-grant`, "host"));
    if (off === null || on === null)
      problems.push(`${fx}: no subprotocol line`);
    else {
      if (off.includes("render-stream.14"))
        problems.push(`${fx}: render-stream.14 listed without a v2 grant`);
      if (!same(on, ["render-stream.14", ...off]))
        problems.push(
          `${fx}: with the v2 grant ${on.join(",")}, expected render-stream.14 then ${off.join(",")}`,
        );
    }
    const files = cmpTree(
      join(g, "pure", `${fx}-off`, "capture"),
      join(g, "pure", `${fx}-grant`, "capture"),
    );
    if (!files.ok)
      problems.push(`${fx} file sinks, no grant vs v2 grant: ${files.detail}`);
    // The live hosts' file sinks too: a listener, viewers asking nothing, /13 fields and v2 names.
    const live = cmpTree(
      join(g, "pure", `${fx}-live-off`, "host"),
      join(g, "pure", `${fx}-live-grant`, "host"),
    );
    if (!live.ok)
      problems.push(
        `${fx} live hosts' file sinks, no grant vs v2 grant: ${live.detail}`,
      );
    problems.push(...pureLiveProblems(g, join("pure", `${fx}-live-grant`)));
    const cc = sameTransactions(
      join(g, "pure", `${fx}-live-off`, "c"),
      13,
      join(g, "pure", `${fx}-live-grant`, "c"),
      13,
      `${fx} c (no grant / v2 grant)`,
      false,
      1, // two hosts' pacing: how many (frame, base) pairs coincide is a timing fact
    );
    problems.push(...cc.problems.slice(0, 2));
    details.push(
      `${fx}: subprotocols ${off?.join(",")} (+.14 first with the grant); file sinks no grant vs v2 grant ${files.detail} (live hosts ${live.detail}); c no grant vs grant ${cc.normalized} un-predicted transactions equal`,
    );
  }
  return { problems: problems.slice(0, 8), detail: details.join("; ") };
}

// ------------------------------------------------------------------------------------ id-cost

function costDetail(g: string): string {
  const parts: string[] = [];
  const s = readJson<Record<string, number>>(
    join(g, "live", "host", "evidence", "item-meta.json"),
  );
  if (s !== null)
    parts.push(
      `tag-scene live: ${s.resolved} resolved at ${(s.resolve_ns / 1000 / Math.max(1, s.resolved)).toFixed(2)} us, ${s.v2_watches} connects at ${(s.v2_watch_ns / 1000 / Math.max(1, s.v2_watches)).toFixed(2)} us, sweep p50/p95 ${(s.v2_sweep_p50_ns / 1000).toFixed(1)}/${(s.v2_sweep_p95_ns / 1000).toFixed(1)} us (${s.v2_watched_max} watched, ${s.v2_sweep_per_frame} a frame), ${s.v2_restamps} re-stamps, unwatch ${(s.v2_unwatch_ns / 1000).toFixed(1)} us`,
    );
  for (const c of ["fields13", "v2", "grant-off", "no-grant"]) {
    const e = join(g, "id-cost", c, "host", "evidence");
    if (!existsSync(e)) continue;
    const m = readJson<Record<string, number>>(join(e, "item-meta.json"));
    // perf.json's histogram: [bucket lower bound us, count] pairs.
    const h = readJson<{
      histograms?: {
        frame_callback_us?: { count: number; buckets: Array<[number, number]> };
      };
    }>(join(e, "perf.json"))?.histograms?.frame_callback_us;
    const q = (p: number): number | undefined => {
      let seen = 0;
      for (const [lo, k] of h?.buckets ?? []) {
        seen += k;
        if (seen >= p * (h?.count ?? 0)) return lo;
      }
      return undefined;
    };
    const fc = { p50: q(0.5), p95: q(0.95) };
    parts.push(
      `id-cost/${c}: ${m === null ? "no item-meta.json" : `${m.resolved} resolved at ${(m.resolve_ns / 1000 / Math.max(1, m.resolved)).toFixed(2)} us${m.v2_watches === undefined ? ", no v2 keys" : `, sweep p50/p95 ${(m.v2_sweep_p50_ns / 1000).toFixed(1)}/${(m.v2_sweep_p95_ns / 1000).toFixed(1)} us`}`}; frame callback p50/p95 ${fc.p50 ?? "?"}/${fc.p95 ?? "?"} us (bucket floors)`,
    );
  }
  return parts.join("; ") || "no evidence";
}

// ----------------------------------------------------------------------------------------- run

export async function runG8id14(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const push = (
    id: string,
    criterion: string,
    legs: string[],
    judge: () => { problems: string[]; detail: string },
  ): void => {
    const missing = legs.filter(
      (l) => legSkipped(g, l) || !existsSync(join(g, l)),
    );
    if (missing.length > 0) {
      checks.push(notRun(id, criterion, `legs not run: ${missing.join(",")}`));
      return;
    }
    const r = judge();
    checks.push(
      check(
        id,
        criterion,
        r.problems.length === 0,
        r.problems.length === 0
          ? r.detail
          : `${r.problems.join("; ")} (${r.detail})`,
      ),
    );
  };
  const asks: Record<
    string,
    Record<string, [Version, ItemMetaRequest | null]>
  > = {
    live: {
      a: [14, ID_REQUEST],
      b: [14, ID_REQUEST],
      c: [13, null],
      d: [14, ID_REQUEST],
    },
    reconnect: {
      a: [14, ID_REQUEST],
      e: [14, ID_REQUEST],
      f: [14, ID_REQUEST],
    },
    one: { a: [14, ID_REQUEST] },
    sweep0: { a: [14, ID_REQUEST] },
    sweep4: { a: [14, ID_REQUEST] },
  };

  // id-validate
  push(
    "id-validate",
    "ID3: every g8id14 viewer's stream passes rs-core-check and the TS validator at its version with its hello's ask; both /14 file sinks pass them at 14, carry item_meta records and a re-stamped row, and transcode to a valid /13 stream; golden-14 passes in rs-core",
    ["live", "reconnect", "one", "sweep0", "sweep4", "file"],
    () => {
      const problems: string[] = [];
      let n = 0;
      for (const [leg, viewers] of Object.entries(asks)) {
        for (const [v, [version, request]] of Object.entries(viewers)) {
          const path = decodedOf(join(g, leg), v, version);
          const report = viewerReport(join(g, leg, v));
          if (report === null || !existsSync(path)) {
            problems.push(`${leg}/${v}: no viewer output`);
            continue;
          }
          if (report.fatal !== null)
            problems.push(`${leg}/${v}: ${String(report.fatal)}`);
          const rs = rsValidate(path, version, request);
          if (
            rs !== "ok" &&
            !(
              report.closed_early === true &&
              rs.startsWith("recording-incomplete")
            )
          )
            problems.push(`${leg}/${v} rs-core-check: ${rs}`);
          if (report.closed_early !== true) {
            const ts = tsValidate(path, version, request);
            if (ts !== "ok") problems.push(`${leg}/${v} TS: ${ts}`);
          }
          n += 1;
        }
      }
      let restamped = 0;
      for (const sink of ["recording.rs14", "recording-patch.rs14"]) {
        const path = join(g, "file", "host", sink);
        if (!existsSync(path)) {
          problems.push(`file/${sink} missing`);
          continue;
        }
        const rs = rsValidate(path, 14, undefined);
        const ts = tsValidate(path, 14, undefined);
        if (rs !== "ok") problems.push(`file/${sink} rs-core-check: ${rs}`);
        if (ts !== "ok") problems.push(`file/${sink} TS: ${ts}`);
        // The item_meta records; the rows whose mouse_filter column (the grant's 6th field)
        // changed from the id's previous row (a full sink re-sends a full with each full
        // transaction); the delta rows naming an id already held (re-stamps, the patch sink).
        const held = new Set<number>();
        const filter = new Map<number, unknown>();
        let metas = 0;
        let re = 0;
        let changed = 0;
        for (const rec of splitRecords(new Uint8Array(readFileSync(path)), 14)
          .records) {
          const m = metaOf(rec.bytes);
          if (m === null || !m.text.startsWith('{"type":"item_meta"')) continue;
          metas += 1;
          const meta = JSON.parse(m.text) as {
            form: string;
            items: Array<Array<unknown>>;
          };
          if (meta.form === "full") held.clear();
          for (const row of meta.items) {
            const id = row[0] as number;
            if (meta.form === "delta" && held.has(id)) re += 1;
            held.add(id);
            if (row.length > 6) {
              if (filter.has(id) && filter.get(id) !== row[6]) changed += 1;
              filter.set(id, row[6]);
            }
          }
        }
        if (metas === 0)
          problems.push(`file/${sink} carries no item_meta record`);
        if (changed < 8)
          problems.push(
            `file/${sink}: ${changed} rows changed mouse_filter (expected >= 8: 4 flips, 4 disabled)`,
          );
        if (sink.includes("patch") && re < 8)
          problems.push(`file/${sink}: ${re} re-stamped rows (expected >= 8)`);
        restamped += re;
        const to13 = join(g, "file", `${sink}.to13.rs13`);
        const tr = spawnSync(
          RS_CORE_CHECK,
          ["transcode", "--to", "13", path, to13],
          { encoding: "utf8" },
        );
        if (tr.status !== 0)
          problems.push(
            `file/${sink} transcode --to 13: ${(tr.stderr || tr.stdout).trim().slice(0, 200)}`,
          );
        else {
          const v13 = rsValidate(to13, 13, undefined);
          const t13 = tsValidate(to13, 13, undefined);
          if (v13 !== "ok")
            problems.push(`file/${sink} as /13 rs-core-check: ${v13}`);
          if (t13 !== "ok") problems.push(`file/${sink} as /13 TS: ${t13}`);
        }
        n += 1;
      }
      const gold = spawnSync(RS_CORE_CHECK, ["goldens", "--only", "14"], {
        encoding: "utf8",
      });
      if (gold.status !== 0)
        problems.push(
          `rs-core-check goldens --only 14: ${(gold.stdout + gold.stderr).trim().split("\n").at(-1)}`,
        );
      return {
        problems: problems.slice(0, 8),
        detail: `${n} streams valid (${restamped} re-stamped rows in the patch sink, both transcode to valid /13); golden-14 ok in rs-core (TS: self-test-rs2)`,
      };
    },
  );

  // id-meta-oracle (live/a, one/a), id-meta-file-oracle
  for (const [id, leg, stream, version, request, what] of [
    ["id-meta-oracle", "live", "a/decoded.rs14", 14, ID_REQUEST, "live/a"],
    [
      "id-meta-oracle-one",
      "one",
      "a/decoded.rs14",
      14,
      ID_REQUEST,
      "one/a (the twin of instance-of-root)",
    ],
    [
      "id-meta-file-oracle",
      "file",
      "host/recording-patch.rs14",
      14,
      undefined,
      "file's /14 patch recording",
    ],
  ] as const) {
    push(
      id,
      `ID3 meta-oracle (${what}): every row equals the fixture's own dump of that item's node, the v2 columns included (instance_id = get_instance_id(); mouse_filter = get_mouse_filter_with_override() + 4 for a script _has_point), joined by canvas-item RID through the capture's id log; every resolved node has a row`,
      [leg],
      () => {
        const r = metaOracle(join(g, leg), stream, version, request);
        const v = metaOracleVerdict(r);
        return { problems: v.ok ? [] : [v.detail], detail: v.detail };
      },
    );
  }

  // id-restamp
  for (const leg of ["live", "sweep0"]) {
    push(
      leg === "live" ? "id-restamp" : "id-restamp-sweep0",
      `ID3 restamp (${leg}/a${leg === "sweep0" ? ", GRC_ITEM_META_SWEEP=0: the signal alone; restamp-skip's twin" : ""}): each set_mouse_filter flip (Card1 and Flipper, steps 40 and 50) is re-stamped by the host <= 1 frame after the flip's frame, and the viewer holds the new value after the first transaction formed at or after the re-stamp`,
      [leg],
      () => restampProblems(join(g, leg)),
    );
  }

  // id-sweep
  for (const leg of ["live", "sweep4"]) {
    push(
      leg === "live" ? "id-sweep" : "id-sweep-sweep4",
      `ID3 sweep (${leg}/a${leg === "sweep4" ? ", GRC_ITEM_META_SWEEP=4; raw-filter's twin" : ""}): the recursive disable (Nest, step 60; it emits no signal) reaches Nest and every Control below it within ceil(watched Controls / GRC_ITEM_META_SWEEP) frames, host and viewer`,
      [leg],
      () => sweepProblems(join(g, leg)),
    );
  }

  // id-instance-stable
  push(
    "id-instance-stable",
    "ID3 instance-stable: the fixture dumps one instance_id per node across the run (Card2's reparent at step 20 and Mover's at 50/60 included); every row of live's A, B, D and reconnect's A, E (closed early) and F (a fresh session) carries it; a re-keyed copy keeps it. The disarm/re-arm round is not run (no re-arm exists before LS2/LS3)",
    ["live", "reconnect"],
    () => {
      const l = instanceProblems(join(g, "live"), ["a", "b", "d"]);
      const r = instanceProblems(join(g, "reconnect"), ["a", "e", "f"]);
      if (viewerReport(join(g, "reconnect", "e"))?.closed_early !== true)
        r.problems.push("reconnect/e did not close early");
      return {
        problems: [...l.problems, ...r.problems].slice(0, 8),
        detail: `live: ${l.detail}; reconnect: ${r.detail}`,
      };
    },
  );

  // id-shared
  push(
    "id-shared",
    "ID3 shared: two lockstep /14 viewers with the same v2 request get byte-identical item_meta records (raw and coded, the re-stamp deltas included) from the host's memo, and a /13 viewer asking nothing gets the same transaction bytes as a /14 one, raw and coded",
    ["live"],
    () => sharedProblems(join(g, "live")),
  );

  // id-late-join
  push(
    "id-late-join",
    "ID3 late-join: a /14 viewer joining after the recursive disable (live/d) gets a full whose table equals the frame-0 viewer's at its first frame and carries the fixture's current filters (Nest's subtree disabled)",
    ["live"],
    () => lateJoinProblems(join(g, "live")),
  );

  // id-rearm
  for (const leg of ["live", "one"]) {
    push(
      leg === "live" ? "id-rearm" : "id-rearm-one",
      `ID3 rearm (${leg}${leg === "one" ? ": leak-connections' twin" : ""}): while armed every resolved Control has a custom callable on property_list_changed, after the disarm none has any (the fixture's own get_signal_connection_list count), and item-meta.json v2_watched_after_off is 0`,
      [leg],
      () => rearmProblems(join(g, leg)),
    );
  }

  // id-pure
  push(
    "id-pure",
    "ID3 pure: without a v2 grant the listener lists no render-stream.14 and with one lists render-stream.14 then that same list; a /13 viewer asking v2 names is refused (bad control message) and one asking /13 fields gets those only; at /13 on capture-scale and gate6-scene the file sinks with no grant and with the v2 grant (nobody asking) are identical (cmp-rec.ts --tree), and the /13 viewer asking nothing gets the same transactions with and without the grant and as the viewer asking /13 fields",
    [
      "pure/scale-off",
      "pure/scale-grant",
      "pure/scale-live-off",
      "pure/scale-live-grant",
      "pure/scene-off",
      "pure/scene-grant",
      "pure/scene-live-off",
      "pure/scene-live-grant",
    ],
    () => pureProblems(g),
  );

  // id-cost (informative)
  checks.push({
    id: "id-cost",
    criterion:
      "ID3 (informative): the v2 host cost (tag-scene live; capture-scale id-cost/ when G8ID14_ONLY_COST ran)",
    passed: true,
    status: "pass",
    gating: false,
    detail: costDetail(g),
  });

  // id-sabotage-*
  const sabotage = (
    id: string,
    leg: string,
    what: string,
    caught: () => string | null,
  ): void => {
    if (legSkipped(g, leg) || !existsSync(join(g, leg))) {
      checks.push(notRun(id, what));
      return;
    }
    const why = caught();
    checks.push(check(id, what, why !== null, why ?? "not caught"));
  };
  sabotage(
    "id-sabotage-restamp-skip-caught",
    "sabotage-restamp-skip",
    "ID3 sabotage restamp-skip (GRC_ITEM_META_SWEEP=0; queued changes drained, never re-stamped) fails id-restamp",
    () => {
      const r = restampProblems(join(g, "sabotage-restamp-skip"));
      return r.problems.length > 0 ? `id-restamp: ${r.problems[0]}` : null;
    },
  );
  sabotage(
    "id-sabotage-raw-filter-caught",
    "sabotage-raw-filter",
    "ID3 sabotage raw-filter (GRC_ITEM_META_SWEEP=4; get_mouse_filter, blind to mouse_behavior_recursive) fails id-sweep",
    () => {
      const r = sweepProblems(join(g, "sabotage-raw-filter"));
      return r.problems.length > 0 ? `id-sweep: ${r.problems[0]}` : null;
    },
  );
  sabotage(
    "id-sabotage-instance-of-root-caught",
    "sabotage-instance-of-root",
    "ID3 sabotage instance-of-root (a node below an instance root gets the root's ObjectID) fails id-meta-oracle on instance_id",
    () => {
      const r = metaOracle(
        join(g, "sabotage-instance-of-root"),
        "a/decoded.rs14",
        14,
        ID_REQUEST,
      );
      const p = r.problems.find((x) =>
        /differs in [a-z_,]*instance_id/.test(x),
      );
      return p !== undefined ? `id-meta-oracle: ${p.slice(0, 200)}` : null;
    },
  );
  sabotage(
    "id-sabotage-leak-connections-caught",
    "sabotage-leak-connections",
    "ID3 sabotage leak-connections (no disconnect at the disarm) fails id-rearm",
    () => {
      const r = rearmProblems(join(g, "sabotage-leak-connections"));
      return r.problems.length > 0 ? `id-rearm: ${r.problems[0]}` : null;
    },
  );
  sabotage(
    "id-sabotage-v2-at-13-caught",
    "sabotage-v2-at-13",
    "ID3 sabotage v2-at-13 (the v2 names accepted in a /13 hello) fails id-pure: the /13 viewer asking them is not refused",
    () => refusedProblem(join(g, "sabotage-v2-at-13")),
  );
  return checks;
}
