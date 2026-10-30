// Gate 8 g8w11's native receiver checks (W11d, protocol/render-stream-11.md "As built (W11d)"),
// judged on the legs run-gate8.sh's run_g8w11_native writes under <run>/g8w11/<leg>/receiver
// (gate8-w11-tool.ts native-plan: W11c's GSW legs' captures, shot frames and sabotages):
//
//   native-w11-replays        every honest leg (the /11 legs and their /10 twins) replays its
//                             whole recording: status ok, one applied transaction per recorded one
//   native-dynamic-applied    at every applied /11 transaction the bodies the native receiver
//                             draws its dynamic meshes from (applied.json `dynamic_sha256`, GSW's
//                             digest: per mesh id and surface, the held body's SHA-256) equal the
//                             TypeScript validator's resolved state (`body_sha256`); none left
//                             undrawn (`w11.dynamic_undrawn`)
//   native-w11-equals-v10     each /11 leg's shots equal its /10 twin's at the same frames, pixel for
//                             pixel; the `off` legs too, so a returning hash draws right
//                             (resend-applied), and gate5-mesh's (`mesh`: g5c's and g5e's meshes at
//                             /11 against the /10 path gate 5 judges against Godot)
//   native-store-bounded      after every apply the receiver's memory cache (RsResourceCache) holds
//                             at most |names(S)| + |C| + 2 entries, on every /11 leg, scale-off
//                             included (every pose a new inline hash), and the rule released some
//   native-inline-fetch-zero  no honest /11 leg read an inline-sized hash from the origin (the store
//                             directory): the receiver asks Validator::check_fetch first
//   records-per-tx            on capture-scale at /11 (auto) a warm transaction travels as about one
//                             message: (records + transactions) / transactions after the first ten
//                             is at most 1.1, against the /10 twin's pose records (informative)
//   native-*-caught           the receiver sabotages, as W11c's: stale-dynamic-rx fails
//                             native-dynamic-applied and the /10 equality; no-prune fails
//                             resource-duplicate; evict-carried fails inline-fetch-zero;
//                             ignore-released fails native-store-bounded
//   native-coding-lossless    live (coding/native: a capture-scale /11 host, one native receiver
//                             offering zstd-base,zstd and one uncoded): each receiver's received.rs11
//                             (the decoded messages) is byte for byte the host's tap of its
//                             connection, and the coded one was coded (prefixed messages, no error)
//   native-coding-applies-as-off  live: at every transaction either receiver applied, the dynamic
//                             bodies it drew are the tap's resolved state's (`dynamic_sha256`), so a
//                             coded receiver applies what an uncoded one does
//   native-coding-drop-base-caught  live, drop-message under zstd-base: the receiver cannot decode
//                             the next based patch, sends resync (reason coding), skips to the full
//                             transaction, validates it (rs-core Validator::transport_skip) and ends ok
//
// Under gate 7's g7-8 GSW half the same checks judge GSW's replay of these legs (`@gsw`): the
// store evidence is then GSW's (perf.json `gsw.w11`, W11c), which has the same keys.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck } from "./gate8-adopt-checks";
import { dynamicAppliedProblems, STORE_SLACK } from "./gate8-w11-gsw-checks";
import { runG8w11cGsw13 } from "./gate8-w13-gsw-checks";
import { runG8w11cNative13 } from "./gate8-w13-native-checks";
import { decodeRecording, type ResolvedRecording, resolveRecording, splitRecords } from "./render-stream-2";

/** Native leg -> [capture, sink]; the /11 legs with their /10 twins. */
const CAPTURE: Record<string, [string, string]> = {
  "scale/receiver": ["scale/capture", "recording-patch.rs11"],
  "scale/off/receiver": ["scale/off/capture", "recording-patch.rs11"],
  "scene/receiver": ["scene/capture", "recording-patch.rs11"],
  "scene/off/receiver": ["scene/off/capture", "recording-patch.rs11"],
  "mesh/receiver": ["mesh/capture", "recording.rs11"],
  "scale/v10/receiver": ["scale/v10/capture", "recording-patch.rs10"],
  "scene/v10/receiver": ["scene/v10/capture", "recording-patch.rs10"],
  "mesh/v10/receiver": ["mesh/v10/capture", "recording.rs10"],
};
export const NATIVE_HONEST = [
  "scale/receiver",
  "scale/off/receiver",
  "scene/receiver",
  "scene/off/receiver",
  "mesh/receiver",
];
export const NATIVE_TWINS: readonly [string, string][] = [
  ["scale/receiver", "scale/v10/receiver"],
  ["scale/off/receiver", "scale/v10/receiver"],
  ["scene/receiver", "scene/v10/receiver"],
  ["scene/off/receiver", "scene/v10/receiver"],
  ["mesh/receiver", "mesh/v10/receiver"],
];
export const NATIVE_SABOTAGE_LEGS = {
  staleDynamicRx: "scene/sabotage-stale-dynamic-rx/receiver",
  noPrune: "scene/off/sabotage-no-prune/receiver",
  evictCarried: "scene/off/sabotage-evict-carried/receiver",
  ignoreReleased: "scale/off/sabotage-ignore-released/receiver",
} as const;
/** records-per-tx's ceiling on capture-scale /11 (one message a transaction, plus static churn). */
export const RECORDS_PER_TX_MAX = 1.1;

interface Applied {
  status: string;
  failure: { seq: number | null; reason: string; detail: string } | null;
  transactions: { seq: number; frame: number; dynamic_sha256?: string }[];
  w11?: W11Evidence;
}
interface W11Evidence {
  store_max_entries: number;
  store_max_excess: number;
  released_total: number;
  dynamic_bodies_total: number;
  dynamic_mismatched: number;
  dynamic_undrawn: number;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Differing pixels between two shots (any RGBA channel), or null when one is missing. */
async function shotDiff(a: string, b: string): Promise<number | null> {
  const x = await decodePngRgba(a);
  const y = await decodePngRgba(b);
  if (!x || !y) return null;
  if (x.width !== y.width || x.height !== y.height) return x.width * x.height;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4)
    if (
      x.data[i] !== y.data[i] ||
      x.data[i + 1] !== y.data[i + 1] ||
      x.data[i + 2] !== y.data[i + 2] ||
      x.data[i + 3] !== y.data[i + 3]
    )
      n++;
  return n;
}

/** (records + transactions) / transactions over a recording's transactions after the first
 * `warm`, and the record count: how many live messages a warm transaction costs. */
export function messagesPerTransaction(
  records: readonly { meta: unknown }[],
  warm = 10,
): { perTx: number; records: number; transactions: number } {
  let tx = 0;
  let rec = 0;
  let pending = 0;
  for (const r of records) {
    const type = (r.meta as { type?: string }).type;
    if (type === "resource") pending++;
    else if (type === "transaction") {
      tx++;
      if (tx > warm) rec += pending;
      pending = 0;
    }
  }
  const counted = Math.max(0, tx - warm);
  return { perTx: counted === 0 ? 0 : (counted + rec) / counted, records: rec, transactions: counted };
}

export async function runG8w11Native(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => existsSync(join(dir(leg), "applied.json"));
  const tierSkipped = (leg: string) => existsSync(join(dir(leg), "skipped-by-tier.txt"));
  const applied = (leg: string) => readJson<Applied>(join(dir(leg), "applied.json"));
  /** The leg's /11 store evidence: native applied.json `w11`, else GSW's perf.json `gsw.w11`
   * (gate 7's GSW half replays these legs). */
  const w11 = async (leg: string): Promise<W11Evidence | null> =>
    (await applied(leg))?.w11 ??
    (await readJson<{ gsw?: { w11?: W11Evidence } }>(join(dir(leg), "perf.json")))?.gsw?.w11 ??
    null;
  const frames =
    (await readJson<Record<string, Record<string, number>>>(join(g, "native-frames.json"))) ?? {};
  const recs = new Map<string, ResolvedRecording>();
  const recOf = async (leg: string) => {
    if (!recs.has(leg)) {
      const [cap, sink] = CAPTURE[leg];
      const path = join(g, cap, sink);
      if (!existsSync(path)) return null;
      recs.set(leg, resolveRecording(new Uint8Array(await readFile(path)), sink.endsWith(".rs11") ? 11 : 10));
    }
    return recs.get(leg) ?? null;
  };
  const notRun = (id: string, criterion: string, leg: string): G8aCheck => ({
    id,
    criterion,
    passed: true,
    status: "not-run",
    detail: `skipped-by-tier: ${leg}`,
    gating: false,
  });
  if (!existsSync(join(g, "native-plan.tsv"))) {
    checks.push(check("native-w11-replays", "W11d: the native g8w11 legs ran", null));
    return checks;
  }

  // native-w11-replays
  {
    const legs = [...NATIVE_HONEST, "scale/v10/receiver", "scene/v10/receiver", "mesh/v10/receiver"];
    const problems: string[] = [];
    for (const leg of legs) {
      const a = await applied(leg);
      const rec = await recOf(leg);
      if (!a || !rec) {
        problems.push(`${leg}: ${a ? "no capture" : "no applied.json"}`);
        continue;
      }
      if (a.status !== "ok")
        problems.push(`${leg}: ${a.failure?.reason}: ${a.failure?.detail?.slice(0, 160)}`);
      else if (a.transactions.length !== rec.transactions.length)
        problems.push(`${leg}: ${a.transactions.length} applied of ${rec.transactions.length}`);
    }
    checks.push(
      check(
        "native-w11-replays",
        "W11d: the native receiver replays every g8w11 capture (/11 and the /10 twins) whole: status ok, every transaction applied",
        problems,
        `${legs.length} legs`,
      ),
    );
  }

  // native-dynamic-applied
  {
    const problems: string[] = [];
    const notes: string[] = [];
    let dynamic = 0;
    for (const leg of NATIVE_HONEST) {
      const a = await applied(leg);
      const rec = await recOf(leg);
      const e = await w11(leg);
      if (!a || !rec || !e) {
        problems.push(`${leg}: evidence missing`);
        continue;
      }
      const r = dynamicAppliedProblems(rec, a.transactions);
      dynamic += r.dynamicTxs;
      problems.push(...r.problems.slice(0, 4).map((p) => `${leg}: ${p}`));
      if (e.dynamic_mismatched > 0)
        problems.push(`${leg}: ${e.dynamic_mismatched} surface(s) held a body other than the resolved one`);
      if (e.dynamic_undrawn > 0) problems.push(`${leg}: ${e.dynamic_undrawn} dynamic mesh(es) left undrawn`);
      notes.push(`${leg} ${r.compared} txs (${r.dynamicTxs} dynamic), ${e.dynamic_bodies_total} bodies`);
    }
    if (dynamic === 0) problems.push("no transaction held a dynamic mesh (vacuous)");
    checks.push(
      check(
        "native-dynamic-applied",
        "W11d: at every applied /11 transaction the native receiver draws each dynamic mesh from the body the TypeScript resolved state names (body_sha256), none left undrawn",
        problems,
        notes.join("; "),
      ),
    );
  }

  // native-w11-equals-v10 (and its use by stale-dynamic-rx)
  const twinDiff = async (leg: string, twin: string) => {
    const out: { frame: string; px: number | null }[] = [];
    const fl = frames[leg] ?? {};
    const ft = frames[twin] ?? {};
    for (const [frame, seq] of Object.entries(fl)) {
      const tseq = ft[frame];
      if (tseq === undefined) continue;
      out.push({
        frame,
        px: await shotDiff(
          join(dir(leg), "shots", `seq-${seq}.png`),
          join(dir(twin), "shots", `seq-${tseq}.png`),
        ),
      });
    }
    return out;
  };
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of NATIVE_TWINS) {
      const d = await twinDiff(leg, twin);
      if (d.length === 0) problems.push(`${leg}: no shared shot frames with ${twin}`);
      for (const { frame, px } of d)
        if (px === null) problems.push(`${leg}: frame ${frame}: shot missing`);
        else if (px > 0) problems.push(`${leg}: frame ${frame}: ${px} px differ from ${twin}`);
      notes.push(`${leg} ${d.length} frames`);
    }
    checks.push(
      check(
        "native-w11-equals-v10",
        "W11d: each native /11 leg's shots equal its /10 twin's at the same frames, pixel for pixel (resend-applied: the off legs' returning hashes; gate5-mesh's meshes at /11)",
        problems,
        notes.join("; "),
      ),
    );
  }

  // native-store-bounded
  {
    const problems: string[] = [];
    const notes: string[] = [];
    let released = 0;
    for (const leg of NATIVE_HONEST) {
      const e = await w11(leg);
      if (!e) {
        problems.push(`${leg}: no w11 evidence`);
        continue;
      }
      released += e.released_total;
      if (e.store_max_excess > STORE_SLACK)
        problems.push(`${leg}: ${e.store_max_excess} entries beyond |names| + |C|`);
      notes.push(`${leg} max ${e.store_max_entries} (excess ${e.store_max_excess}, released ${e.released_total})`);
    }
    if (released === 0) problems.push("the retention rule released nothing on any leg (vacuous)");
    checks.push(
      check(
        "native-store-bounded",
        `W11d: after every apply the native receiver's memory cache holds at most |names(S)| + |C| + ${STORE_SLACK} entries`,
        problems,
        notes.join("; "),
      ),
    );
  }

  // native-inline-fetch-zero (honest)
  {
    const problems: string[] = [];
    for (const leg of NATIVE_HONEST) {
      const a = await applied(leg);
      if (a?.failure?.reason === "inline-fetch-zero") problems.push(`${leg}: ${a.failure.detail.slice(0, 160)}`);
      else if (!a) problems.push(`${leg}: no applied.json`);
    }
    checks.push(
      check(
        "native-inline-fetch-zero",
        "W11d: no honest native /11 leg read an inline-sized hash from the origin (the receiver asks Validator::check_fetch first)",
        problems,
      ),
    );
  }

  // records-per-tx (capture-scale's recording; the twin's for contrast)
  {
    const read = async (cap: string, sink: string, v: 10 | 11) => {
      const path = join(g, cap, sink);
      if (!existsSync(path)) return null;
      return messagesPerTransaction(decodeRecording(new Uint8Array(await readFile(path)), v).records);
    };
    const v11 = await read("scale/capture", "recording-patch.rs11", 11);
    const v10 = await read("scale/v10/capture", "recording-patch.rs10", 10);
    const problems: string[] | null = v11 === null ? null : [];
    if (v11 && problems) {
      if (v11.transactions === 0) problems.push("no warm transaction (vacuous)");
      else if (v11.perTx > RECORDS_PER_TX_MAX)
        problems.push(`${v11.perTx.toFixed(3)} messages a warm transaction (${v11.records} records)`);
    }
    checks.push(
      check(
        "records-per-tx",
        `W11d: on capture-scale /11 a warm transaction is about one message: (records + transactions) / transactions <= ${RECORDS_PER_TX_MAX}`,
        problems,
        v11
          ? `/11 ${v11.perTx.toFixed(3)} (${v11.records} records over ${v11.transactions} warm txs)${v10 ? `; /10 twin ${v10.perTx.toFixed(2)}` : ""}`
          : undefined,
      ),
    );
  }

  // the receiver sabotages
  const sabotage = async (id: string, leg: string, criterion: string, judge: () => Promise<string[]>) => {
    if (tierSkipped(leg)) {
      checks.push(notRun(id, criterion, leg));
      return;
    }
    if (!ran(leg)) {
      checks.push(check(id, criterion, null));
      return;
    }
    checks.push(check(id, criterion, await judge()));
  };
  const S = NATIVE_SABOTAGE_LEGS;
  await sabotage(
    "native-stale-dynamic-rx-caught",
    S.staleDynamicRx,
    "W11d: a native receiver that ignores dynamic bodies fails native-dynamic-applied and the /10 equality",
    async () => {
      const a = await applied(S.staleDynamicRx);
      const rec = await recOf("scene/receiver");
      const d = await twinDiff(S.staleDynamicRx, "scene/v10/receiver");
      const out: string[] = [];
      if (!a || !rec || dynamicAppliedProblems(rec, a.transactions).problems.length === 0)
        out.push("native-dynamic-applied passed: the ignored bodies went unseen");
      if (!d.some((x) => (x.px ?? 0) > 0)) out.push("every shot equals the /10 twin's");
      return out;
    },
  );
  const failsWith = (leg: string, reason: RegExp) => async () => {
    const a = await applied(leg);
    const why = `${a?.failure?.reason ?? ""} ${a?.failure?.detail ?? ""}`;
    return a && a.status !== "ok" && reason.test(why) ? [] : [`status ${a?.status}: ${why.slice(0, 160)}`];
  };
  await sabotage(
    "native-no-prune-caught",
    S.noPrune,
    "W11d: a native receiver that keeps C lifelong refuses the first returning hash, typed resource-duplicate",
    failsWith(S.noPrune, /resource-duplicate/),
  );
  await sabotage(
    "native-evict-carried-caught",
    S.evictCarried,
    "W11d: a native receiver that drops a hash still in C must read it from the origin, and the read is refused inline-fetch-zero",
    failsWith(S.evictCarried, /^inline-fetch-zero/),
  );
  await sabotage(
    "native-ignore-released-caught",
    S.ignoreReleased,
    "W11d: a native receiver whose cache ignores the released hashes fails native-store-bounded",
    async () => {
      const e = await w11(S.ignoreReleased);
      return e && e.store_max_excess > STORE_SLACK ? [] : [`store excess ${e?.store_max_excess}: store-bounded passed`];
    },
  );
  return checks;
}

interface LiveApplied extends Applied {
  streams?: { stream_id: string | null }[];
  live?: {
    gsw?: { first_apply?: FirstApply | null };
    coding?: {
      connections?: Record<string, unknown>[];
      resyncs?: number;
      heap_at_resync?: number | null;
      heap_end?: number | null;
      rebuild_applies?: RebuildApply[];
    };
  };
}

async function codingLegsOf(root: string, leg: string) {
  const dir = join(root, leg);
  const host = join(dir, "host");
  const summary = await readJson<{ connections?: { connection: number; stream_id: string | null }[] }>(
    join(host, "evidence", "live-summary.json"),
  );
  if (!summary) return null;
  const out: { name: string; applied: LiveApplied | null; received: Uint8Array | null; tap: Uint8Array | null }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "host") continue;
    const applied = await readJson<LiveApplied>(join(dir, e.name, "applied.json"));
    const sid = applied?.streams?.[0]?.stream_id ?? null;
    const c = (summary.connections ?? []).find((x) => x.stream_id === sid);
    const bytes = async (p: string) => (existsSync(p) ? new Uint8Array(await readFile(p)) : null);
    out.push({
      name: e.name,
      applied,
      received: await bytes(join(dir, e.name, "received.rs11")),
      tap: c ? await bytes(join(host, "tap", `stream-${c.connection}.rs2`)) : null,
    });
  }
  return out;
}

/**
 * W11d/GTS: under a coding sabotage (`drop-message` drops a base, `coding-wrong-prefix` breaks a
 * prefix) a coded receiver resyncs (reason coding), skips to the full transaction, validates it
 * (rs-core Validator::transport_skip: no seq-gap) and ends ok. Judged on the native receiver
 * (g8w11/coding) and on GSW's browser receiver (the same legs under g8w11c, run-gate7.sh --live).
 */
async function resyncCheck(root: string, leg: string, id: string, sabotage: string): Promise<G8aCheck> {
  const criterion = `W11d: under ${sabotage} a coded receiver resyncs (reason coding), skips to the full transaction, validates it (rs-core Validator::transport_skip) and ends ok`;
  const dir = join(root, leg);
  if (existsSync(join(dir, "host", "skipped-by-tier.txt"))) {
    return { id, criterion, passed: true, status: "not-run", detail: `skipped-by-tier: ${dir}`, gating: false };
  }
  const legs = await codingLegsOf(root, leg);
  const v = legs?.[0];
  const problems: string[] | null = v ? [] : null;
  if (v && problems) {
    if (v.applied?.status !== "ok") problems.push(`status ${v.applied?.status}: ${v.applied?.failure?.reason} ${v.applied?.failure?.detail?.slice(0, 120)}`);
    if ((v.applied?.live?.coding?.resyncs ?? 0) < 1) problems.push("no coding resync");
    if (v.received && v.tap) {
      const tap = splitRecords(v.tap, 11).records.map((r) => Buffer.from(r.bytes).toString("latin1"));
      let at = 0;
      for (const r of splitRecords(v.received, 11).records) {
        const b = Buffer.from(r.bytes).toString("latin1");
        while (at < tap.length && tap[at] !== b) at++;
        if (at === tap.length) {
          problems.push("a received message is not in the host's tap (in order)");
          break;
        }
      }
    } else problems.push("no received.rs11 or tap");
  }
  return check(id, criterion, problems, `resyncs ${v?.applied?.live?.coding?.resyncs ?? 0}`);
}

/**
 * GRH: a GSW coding resync's fresh applier inherits the resident textures (render-stream-11.md "As
 * built (GRH)"). Before, the resync's full transaction uploaded every texture again into the draw
 * list's byte arena at once: the wasm heap, which never shrinks, stepped by the whole texture set
 * (+408 MB, +73%, on STS2 combat; W11z). Two checks on the browser receiver's `rebuild_applies[0]`
 * (the first transaction drawn after the rebuild, the resync's full):
 * - `resync-uploads` (`coding-resync-uploads-*`): the full's texture upload bytes are at most half
 *   of what the viewer had uploaded before it (the defect re-uploads all of it, so equal);
 * - `resync-heap` (`coding-resync-heap-*`): the heap right after the full is within HEAP_SLACK of the
 *   heap when the rebuild began (not the leg's end heap, which creeps ~0.2 MB per 12 transactions).
 *   The slack is the full's own accept (24 MiB measured on STS2, 6 MiB on this fixture) with room;
 *   the defect adds the whole texture set, so the bound is the one that catches it at game scale,
 *   and the uploads check is the one that catches it on this small fixture.
 * A native receiver has no wasm heap: both are not-run there.
 */
const HEAP_SLACK = 32 * 1024 * 1024;

interface RebuildApply {
  seq: number;
  heap: number | null;
  heap_before_rebuild: number | null;
  texture_upload_bytes: number;
  texture_upload_bytes_before: number;
}

async function resyncReuploadChecks(root: string, leg: string, suffix: string): Promise<G8aCheck[]> {
  const dir = join(root, leg);
  const ids = [`coding-resync-uploads-${suffix}`, `coding-resync-heap-${suffix}`];
  const criteria = [
    `GRH: a GSW coding resync (${leg}) does not upload again what the GPU holds: the resync's full uploads at most half of the texture bytes uploaded before it`,
    `GRH: a GSW coding resync (${leg}) leaves the wasm heap within ${HEAP_SLACK / 1048576} MiB of its size when the rebuild began, measured right after the resync's full is applied`,
  ];
  if (existsSync(join(dir, "host", "skipped-by-tier.txt"))) {
    return ids.map((id, i) => ({ id, criterion: criteria[i], passed: true, status: "not-run" as const, detail: `skipped-by-tier: ${dir}`, gating: false }));
  }
  const legs = await codingLegsOf(root, leg);
  const c = legs?.[0]?.applied?.live?.coding;
  if (c && c.heap_at_resync === undefined) {
    return ids.map((id, i) => ({ id, criterion: criteria[i], passed: true, status: "not-run" as const, detail: "a native receiver has no wasm heap", gating: false }));
  }
  const r: RebuildApply | undefined = c?.rebuild_applies?.[0];
  const up: string[] | null = legs ? [] : null;
  const hp: string[] | null = legs ? [] : null;
  if (up && hp && !r) {
    up.push("no rebuild_applies in applied.json (the resync's full was never drawn)");
    hp.push("no rebuild_applies in applied.json (the resync's full was never drawn)");
  } else if (up && hp && r) {
    if (r.texture_upload_bytes_before <= 0) up.push("the viewer uploaded no texture before the resync: nothing to re-upload (the fixture has lost its textures?)");
    else if (r.texture_upload_bytes * 2 > r.texture_upload_bytes_before) up.push(`the resync's full uploaded ${r.texture_upload_bytes} B, over half of the ${r.texture_upload_bytes_before} B uploaded before it`);
    if (r.heap === null || r.heap_before_rebuild === null) hp.push("no heap sample");
    else if (r.heap > r.heap_before_rebuild + HEAP_SLACK) hp.push(`wasm heap ${r.heap_before_rebuild} -> ${r.heap} B (+${((r.heap - r.heap_before_rebuild) / 1048576).toFixed(1)} MiB) across the resync's full`);
  }
  const detail = r ? `uploads ${r.texture_upload_bytes}/${r.texture_upload_bytes_before} B, heap ${r.heap_before_rebuild} -> ${r.heap} B` : "no rebuild apply";
  return [check(ids[0], criteria[0], up, detail), check(ids[1], criteria[1], hp, detail)];
}

/**
 * GRH sabotage: a GSW receiver run with `rebuild-reupload` (the fresh applier inherits nothing, as
 * before GRH) must fail `coding-resync-uploads`: its resync full uploads (at least) half of what the
 * viewer had uploaded. A browser receiver only: the leg is not run for the native one.
 */
async function reuploadCaught(root: string): Promise<G8aCheck> {
  const id = "coding-resync-reupload-caught";
  const criterion = "GRH: a GSW receiver whose resync applier inherits no residency (rebuild-reupload) uploads the textures again at the resync's full, which coding-resync-uploads refuses";
  const dir = join(root, "native-sabotage-drop-base-reupload");
  if (!existsSync(dir)) return { id, criterion, passed: true, status: "not-run", detail: "no browser receiver leg", gating: false };
  if (existsSync(join(dir, "host", "skipped-by-tier.txt"))) {
    return { id, criterion, passed: true, status: "not-run", detail: `skipped-by-tier: ${dir}`, gating: false };
  }
  const legs = await codingLegsOf(root, "native-sabotage-drop-base-reupload");
  const r = legs?.[0]?.applied?.live?.coding?.rebuild_applies?.[0];
  const problems: string[] | null = legs ? [] : null;
  if (problems && !r) problems.push("no rebuild_applies in applied.json");
  else if (problems && r) {
    if (r.texture_upload_bytes_before <= 0) problems.push("no texture uploaded before the resync");
    else if (r.texture_upload_bytes * 2 <= r.texture_upload_bytes_before) problems.push(`the sabotaged resync full uploaded only ${r.texture_upload_bytes} of ${r.texture_upload_bytes_before} B: coding-resync-uploads would pass`);
  }
  return check(id, criterion, problems, r ? `uploads ${r.texture_upload_bytes}/${r.texture_upload_bytes_before} B` : "no rebuild apply");
}

/**
 * GLJ: a GSW viewer's first apply (a join: every texture the state names uploaded at once) shares
 * the payload store's pixels with the draw list instead of copying them into its byte arena
 * (render-stream-11.md "As built (GLJ)"). Before, the arena held a second copy of the whole texture
 * set at once, and the wasm heap, which never shrinks, kept it for the viewer's lifetime (+496 MiB
 * for a viewer joining STS2 combat; GRH). Two checks on the browser receiver's
 * `live.gsw.first_apply`:
 * - `first-apply-arena` (`first-apply-arena-*`): the first draw took at most half of its texture
 *   bytes from the arena (the defect copies all of them, so equal; at any scale);
 * - `first-apply-heap` (`first-apply-heap-*`): the heap after the first draw is within
 *   FIRST_APPLY_HEAP_SLACK of the heap before the first apply, with every payload already provided
 *   and resident. The defect adds the texture set (and the arena's doubling), so this is the bound
 *   that catches it at game scale; the arena check catches it on this small fixture.
 * A native receiver or the web export has no `live.gsw`: both are not-run there.
 */
const FIRST_APPLY_HEAP_SLACK = 32 * 1024 * 1024;

interface FirstApply {
  seq: number;
  heap_before_apply: number | null;
  heap_after_apply: number | null;
  heap_after_draw: number | null;
  texture_upload_bytes: number;
  arena_bytes: number;
  shared_bytes: number;
  apply_ms: number;
  draw_ms: number;
}

function firstApplyProblems(f: FirstApply | null | undefined): { arena: string[]; heap: string[] } {
  const arena: string[] = [];
  const heap: string[] = [];
  if (!f) {
    arena.push("no live.gsw.first_apply in applied.json (no transaction was drawn)");
    heap.push("no live.gsw.first_apply in applied.json (no transaction was drawn)");
    return { arena, heap };
  }
  if (f.texture_upload_bytes <= 0) arena.push("the first draw uploaded no texture: nothing to judge (the fixture has lost its textures?)");
  else if (f.arena_bytes * 2 > f.texture_upload_bytes) arena.push(`the first apply copied ${f.arena_bytes} B into the draw list's arena, over half of the ${f.texture_upload_bytes} B its draw uploaded`);
  if (f.heap_before_apply === null || f.heap_after_draw === null) heap.push("no heap sample");
  else if (f.heap_after_draw > f.heap_before_apply + FIRST_APPLY_HEAP_SLACK) heap.push(`wasm heap ${f.heap_before_apply} -> ${f.heap_after_draw} B (+${((f.heap_after_draw - f.heap_before_apply) / 1048576).toFixed(1)} MiB) across the first apply and draw`);
  return { arena, heap };
}

function firstApplyDetail(f: FirstApply | null | undefined): string {
  return f
    ? `seq ${f.seq}: uploads ${f.texture_upload_bytes} B (arena ${f.arena_bytes}, shared ${f.shared_bytes}), heap ${f.heap_before_apply} -> ${f.heap_after_apply} -> ${f.heap_after_draw} B, apply ${f.apply_ms.toFixed(1)} ms, draw ${f.draw_ms.toFixed(1)} ms`
    : "no first apply";
}

async function firstApplyChecks(root: string, leg: string, suffix: string): Promise<G8aCheck[]> {
  const dir = join(root, leg);
  const ids = [`first-apply-arena-${suffix}`, `first-apply-heap-${suffix}`];
  const criteria = [
    `GLJ: a GSW viewer's first apply (${leg}) shares the payload store's pixels with the draw list: at most half of the first draw's texture bytes come from the draw list's byte arena`,
    `GLJ: a GSW viewer's first apply and draw (${leg}) leave the wasm heap within ${FIRST_APPLY_HEAP_SLACK / 1048576} MiB of its size before the apply, every payload already resident`,
  ];
  if (existsSync(join(dir, "host", "skipped-by-tier.txt"))) {
    return ids.map((id, i) => ({ id, criterion: criteria[i], passed: true, status: "not-run" as const, detail: `skipped-by-tier: ${dir}`, gating: false }));
  }
  const legs = await codingLegsOf(root, leg);
  const live = legs?.[0]?.applied?.live;
  if (live && live.gsw?.first_apply === undefined) {
    return ids.map((id, i) => ({ id, criterion: criteria[i], passed: true, status: "not-run" as const, detail: "not a GSW receiver (no live.gsw.first_apply)", gating: false }));
  }
  const f = live?.gsw?.first_apply;
  const p = legs ? firstApplyProblems(f) : null;
  return [check(ids[0], criteria[0], p ? p.arena : null, firstApplyDetail(f)), check(ids[1], criteria[1], p ? p.heap : null, firstApplyDetail(f))];
}

/**
 * GLJ sabotage: the GSW sabotage leg also runs `arena-upload` (every upload copied into the arena,
 * as before GLJ; independent of `rebuild-reupload`, which acts only at the resync), and its first
 * apply must fail `first-apply-arena`.
 */
async function arenaCaught(root: string): Promise<G8aCheck> {
  const id = "first-apply-arena-caught";
  const criterion = "GLJ: a GSW receiver that copies every upload into the draw list's arena (arena-upload) fails first-apply-arena at its first apply";
  const leg = "native-sabotage-drop-base-reupload";
  const dir = join(root, leg);
  if (!existsSync(dir)) return { id, criterion, passed: true, status: "not-run", detail: "no browser receiver leg", gating: false };
  if (existsSync(join(dir, "host", "skipped-by-tier.txt"))) {
    return { id, criterion, passed: true, status: "not-run", detail: `skipped-by-tier: ${dir}`, gating: false };
  }
  const legs = await codingLegsOf(root, leg);
  const f = legs?.[0]?.applied?.live?.gsw?.first_apply;
  const problems: string[] | null = legs ? [] : null;
  if (problems) {
    if (!f) problems.push("no live.gsw.first_apply in applied.json");
    else if (f.texture_upload_bytes <= 0) problems.push("the first draw uploaded no texture");
    else if (firstApplyProblems(f).arena.length === 0) problems.push(`the sabotaged first apply copied only ${f.arena_bytes} of ${f.texture_upload_bytes} B: first-apply-arena would pass`);
  }
  return check(id, criterion, problems, firstApplyDetail(f));
}

/** GTS: g8w11c, the coding resync legs alone (`$out/g8w11c/<leg>`), native or in a browser. */
export async function runG8w11cResync(out: string): Promise<G8aCheck[]> {
  const root = join(out, "g8w11c");
  return [
    await resyncCheck(root, "native-sabotage-drop-base", "native-coding-drop-base-caught", "drop-message"),
    await resyncCheck(root, "native-sabotage-wrong-prefix", "native-coding-wrong-prefix-caught", "coding-wrong-prefix"),
    ...(await resyncReuploadChecks(root, "native-sabotage-drop-base", "drop-base")),
    ...(await resyncReuploadChecks(root, "native-sabotage-wrong-prefix", "wrong-prefix")),
    await reuploadCaught(root),
    ...(await firstApplyChecks(root, "native-sabotage-drop-base", "drop-base")),
    ...(await firstApplyChecks(root, "native-sabotage-wrong-prefix", "wrong-prefix")),
    await arenaCaught(root),
    // W13c: GSW's /13 resync legs (lib/gate8-w13-gsw-checks.ts).
    ...(await runG8w11cGsw13(root)),
    // W13d: the native receiver's (and the web export's) /13 resync legs.
    ...(await runG8w11cNative13(root)),
  ];
}

/** W11d: the native live coding legs under <run>/g8w11/coding (run_g8w11_coding_native_leg). */
export async function runG8w11NativeCoding(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const root = join(g, "coding");
  const legOf = (leg: string) => codingLegsOf(root, leg);
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const native = await legOf("native");
  {
    const problems: string[] | null = native ? [] : null;
    const notes: string[] = [];
    for (const v of native ?? []) {
      if (!v.applied || !v.received || !v.tap) {
        problems?.push(`${v.name}: missing applied.json, received.rs11 or tap`);
        continue;
      }
      if (v.applied.status !== "ok") problems?.push(`${v.name}: ${v.applied.failure?.reason}: ${v.applied.failure?.detail?.slice(0, 120)}`);
      if (!eq(v.received, v.tap)) problems?.push(`${v.name}: received ${v.received.length} B differs from the tap's ${v.tap.length} B`);
      const conn = (v.applied.live?.coding?.connections ?? [])[0] as
        | { coded?: boolean | null; prefixed?: number; errors?: number; coded_bytes?: number; decoded_bytes?: number }
        | undefined;
      if (v.name === "coded") {
        if (!conn || conn.coded !== true || (conn.prefixed ?? 0) === 0 || (conn.errors ?? 0) > 0)
          problems?.push(`coded: coding stats ${JSON.stringify(conn ?? null)}`);
        else notes.push(`coded ${conn.coded_bytes} B on the wire for ${conn.decoded_bytes} B, ${conn.prefixed} prefixed`);
      } else if (conn && conn.coded === true) problems?.push(`${v.name}: coded, but it offered no coding`);
    }
    if (native && native.length < 2) problems?.push(`${native.length} receiver(s), expected coded and off`);
    checks.push(
      check(
        "native-coding-lossless",
        "W11d: a native receiver live at /11 decodes, byte for byte, the host's tap of its connection (coded under zstd-base,zstd, and uncoded)",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const problems: string[] | null = native ? [] : null;
    const notes: string[] = [];
    for (const v of native ?? []) {
      if (!v.applied || !v.tap) continue;
      const rec = resolveRecording(v.tap, 11);
      const drawn = v.applied.transactions.filter((t) => t.dynamic_sha256 !== undefined);
      const r = dynamicAppliedProblems(rec, drawn);
      if (r.compared === 0) problems?.push(`${v.name}: no applied transaction carries dynamic_sha256`);
      problems?.push(...r.problems.slice(0, 4).map((p) => `${v.name}: ${p}`));
      notes.push(`${v.name} ${r.compared} applied txs`);
    }
    checks.push(
      check(
        "native-coding-applies-as-off",
        "W11d: at every transaction a live native receiver applied, coded or not, it drew the dynamic bodies of the host's tap's resolved state",
        problems,
        notes.join("; "),
      ),
    );
  }
  checks.push(await resyncCheck(root, "native-sabotage-drop-base", "native-coding-drop-base-caught", "drop-message"));
  return checks;
}
