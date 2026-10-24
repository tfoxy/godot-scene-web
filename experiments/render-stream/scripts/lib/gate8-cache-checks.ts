// Gate 8 group g8kc (G8kc, protocol/texture-delivery-design.md D7-D10: the persisted host texture
// cache, the prepare step and the texture_set_path hook): the checks over the evidence
// run-gate8.sh's g8kc legs write. Pure functions of the evidence tree, so
// scripts/test/self-test-gate8kc.ts can drive them against fabricated trees.
//
//   import/, oracle/                    shared with g8t (oracle.json holds each .ctex's decoded
//                                       payload hash and, since G8kp, its block payload hash)
//   g8kc/off/capture/                   /9 passthrough, GRC_TEXTURE_DECODE=engine, NO cache directory
//   g8kc/cold/capture/                  the same on an empty GRC_TEXTURE_CACHE_DIR; cold/cache/ is
//                                       the index and file listing afterwards
//   g8kc/warm/capture/                  a second session on that directory
//   g8kc/warm-workers/capture/          the same at GRC_TEXTURE_WORKERS=2
//   g8kc/prepare/                       scripts/prepare-textures.sh --list into a second, empty
//                                       directory; prepare/out/evidence/texture-cache.json is the
//                                       prepare run's own view, prepare/cache/ its index
//   g8kc/prepared/capture/              a session on the prepared directory
//   g8kc/bounded/capture/               a session with GRC_TEXTURE_CACHE_MAX_BYTES
//   g8kc/adopt-cold/capture/, adopt-warm/capture/
//                                       gate8-adopt armed late with GRC_ADOPT=arm at /8 (recording.rs8)
//                                       on one cache directory, twice (D9a: adopted pre-arm textures)
//   g8kc/sabotage-corrupt/              damaged.json, index-before.jsonl, capture/ (the damaged
//                                       copy of the warm cache), after/capture/ (the repaired one)
//
// Every capture leg writes evidence/result.json (`texture_cache` only when a directory was set),
// evidence/counters.json (`captured.texture_set_path` only when the path hook was installed) and
// evidence/texture-cache.json (the same condition).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  compareWorkerRecordings,
  type FixtureTextureLine,
  type G8tCheck,
  maskedHookLog,
  type OracleEntry,
  type OracleReport,
} from "./gate8-tex-checks";
import {
  type ResolvedRecording,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

/** The cache's params id for the host decode (hooks.cpp kDecodeParamsId). */
export const DECODE_PARAMS_ID = "engine-decompress/4.5.1";
/** G8ku: the default UASTC encoder's params id (rs_basis_encode.h params_id()). */
export const UASTC_PARAMS_ID = "basisu-1.60/uastc-l1/zstd6/linear";

/** G8ku: the uastc variants a /9 basis-uastc capture published, from its store's index (one
 * `texture-ktx2` line per KTX2 stored), keyed by size (fixtures/gate8-basis gives every texture its
 * own size). */
async function uastcBySize(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of jsonl<{
    type?: string;
    encoding?: string;
    hash: string;
    width: number;
    height: number;
  }>(await readText(join(dir, "store", "index.jsonl"))))
    if (r.type === "texture-ktx2" && r.encoding === "uastc")
      out.set(`${r.width}x${r.height}`, r.hash);
  return out;
}

interface BasisDeliveryStats {
  uastc_built?: number;
  encodes_run?: number;
  cache_hits?: number;
}

interface CacheStatsJson {
  max_bytes: number;
  hits: number;
  misses: number;
  corrupt: number;
  puts: number;
  evicted: number;
  bytes_hit: number;
  bytes_put: number;
  entries: number;
  files: number;
  bytes: number;
  derivations: number;
  encodes: number;
}

interface CacheTexture {
  id: string;
  path: string | null;
  source_key: string | null;
  outcome: string;
  status: string;
  hash: string;
}

interface CacheEvidence {
  schema: string;
  path_hook: boolean;
  textures: CacheTexture[];
}

interface IndexRow {
  v?: number;
  del?: number;
  source: string;
  encoding: string;
  params: string;
  hash?: string;
  bytes?: number;
  ext?: string;
  use?: number;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function jsonl<T>(text: string | undefined): T[] {
  if (text === undefined) return [];
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // a torn line is no row
    }
  }
  return rows;
}

function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

function check(
  id: string,
  criterion: string,
  problems: string[] | null,
  detailOk?: string,
  missing = "a leg did not run",
): G8tCheck {
  if (problems === null)
    return {
      id,
      criterion,
      passed: false,
      status: "fail",
      detail: `evidence missing (${missing})`,
    };
  const passed = problems.length === 0;
  return {
    id,
    criterion,
    passed,
    status: passed ? "pass" : "fail",
    detail: passed ? detailOk : problems.slice(0, 12).join("; "),
  };
}

/** The index a cache directory ends with: the last row per (source, encoding, params) wins and a
 * `del` row removes it (src/rs_texture_cache.cpp). */
export function foldIndex(text: string | undefined): Map<string, IndexRow> {
  const rows = new Map<string, IndexRow>();
  for (const r of jsonl<IndexRow>(text)) {
    const key = `${r.source} ${r.encoding} ${r.params}`;
    if (r.del) rows.delete(key);
    else rows.set(key, r);
  }
  return rows;
}

const ctexName = (p: string | null) => (p === null ? "" : basename(p));

export interface G8kcReport {
  checks: G8tCheck[];
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  stats: Record<string, CacheStatsJson | null>;
}

export async function runG8kc(out: string): Promise<G8kcReport> {
  const checks: G8tCheck[] = [];
  const k = (l: string) => join(out, "g8kc", l);
  const legDirs: Record<string, string> = {
    "import/fixture": join(out, "import", "fixture"),
    oracle: join(out, "oracle"),
    "off/capture": k("off/capture"),
    "cold/capture": k("cold/capture"),
    "warm/capture": k("warm/capture"),
    "warm-workers/capture": k("warm-workers/capture"),
    prepare: k("prepare"),
    "prepared/capture": k("prepared/capture"),
    "bounded/capture": k("bounded/capture"),
    "sabotage-corrupt/capture": k("sabotage-corrupt/capture"),
    "sabotage-corrupt/after/capture": k("sabotage-corrupt/after/capture"),
    "adopt-cold/capture": k("adopt-cold/capture"),
    "adopt-warm/capture": k("adopt-warm/capture"),
    "uastc-cold/capture": k("uastc-cold/capture"),
    "uastc-warm/capture": k("uastc-warm/capture"),
  };
  const legs: G8kcReport["legs"] = {};
  for (const [l, dir] of Object.entries(legDirs)) {
    const code = await readText(join(dir, "exit-code.txt"));
    legs[l] = {
      exit_code: code === undefined ? null : code.trim(),
      skipped: skipped(dir),
    };
  }
  const ran = (...ls: string[]) =>
    ls.every((l) => legs[l].exit_code !== null && legs[l].skipped === null);
  const okExit = (l: string, problems: string[]) => {
    if (legs[l].exit_code !== "0")
      problems.push(`g8kc/${l} exit ${legs[l].exit_code}`);
  };
  const missingOf = (...ls: string[]) =>
    ls.filter((l) => !ran(l)).join(", ") || "a leg did not run";

  const stats: Record<string, CacheStatsJson | null> = {};
  const cacheJson: Record<string, CacheEvidence | undefined> = {};
  const counters: Record<
    string,
    | {
        hooks_planned: string[];
        counts: Record<string, number | null>;
        captured: { texture_set_path?: { texture: string; path: string }[] };
      }
    | undefined
  > = {};
  const results: Record<string, Record<string, unknown> | undefined> = {};
  for (const l of Object.keys(legDirs).filter((x) => x.endsWith("capture"))) {
    const ev = join(legDirs[l], "evidence");
    results[l] = await readJson(join(ev, "result.json"));
    stats[l] =
      ((results[l] as { texture_cache?: CacheStatsJson } | undefined)
        ?.texture_cache as CacheStatsJson | undefined) ?? null;
    cacheJson[l] = await readJson<CacheEvidence>(
      join(ev, "texture-cache.json"),
    );
    counters[l] = await readJson(join(ev, "counters.json"));
  }
  // G8ku: a basis-uastc leg's stream.gate8.delivery_stats.
  const basisStats = (l: string): BasisDeliveryStats | undefined =>
    (
      results[l] as
        | { stream?: { gate8?: { delivery_stats?: BasisDeliveryStats } } }
        | undefined
    )?.stream?.gate8?.delivery_stats;
  const prepareEv = join(legDirs.prepare, "out", "evidence");
  const prepareCache = await readJson<CacheEvidence>(
    join(prepareEv, "texture-cache.json"),
  );
  const prepareResult = await readJson<{ texture_cache?: CacheStatsJson }>(
    join(prepareEv, "result.json"),
  );

  const oracle = await readJson<OracleReport>(
    join(out, "oracle", "oracle.json"),
  );
  const oracleOf = (name: string, family: string) =>
    oracle?.textures.find((e) => e.name === name && e.family === family) as
      | (OracleEntry & { block_payload_sha256?: string | null })
      | undefined;
  const fixtureLines = async (l: string) =>
    jsonl<FixtureTextureLine>(
      await readText(join(legDirs[l], "textures.jsonl")),
    );

  // The decode-eligible fixture textures: those the oracle decoded (a block source with a payload).
  const cold = "cold/capture";
  const coldFixture = await fixtureLines(cold);
  const decodable = coldFixture.filter((f) => {
    const o = oracleOf(f.name, f.family);
    return !!o?.payload_sha256 && !!o.block_payload_sha256;
  });

  const resolvedOf = async (l: string): Promise<ResolvedRecording | string> => {
    const path = join(legDirs[l], "recording.rs9");
    if (!existsSync(path)) return "recording.rs9 missing";
    const bytes = new Uint8Array(await readFile(path));
    if (wireVersionOf(bytes) !== 9) return "not a GRS9 recording";
    const errors = validateRecording(bytes, 9);
    if (errors.length > 0) return `invalid at /9: ${errors[0]}`;
    return resolveRecording(bytes, 9);
  };
  const recs: Record<string, ResolvedRecording | string> = {};
  for (const l of [
    "off/capture",
    cold,
    "warm/capture",
    "warm-workers/capture",
    "prepared/capture",
    "bounded/capture",
    "sabotage-corrupt/capture",
    "sabotage-corrupt/after/capture",
  ])
    if (ran(l)) recs[l] = await resolvedOf(l);

  // --- cache-off-identical: no directory, no trace, and the cache never changes a state --------
  {
    const problems: string[] = [];
    const off = "off/capture";
    okExit(off, problems);
    const c = counters[off];
    if (!c) problems.push("off/capture has no counters.json");
    else {
      if (c.hooks_planned.includes("texture_set_path"))
        problems.push("texture_set_path is planned with no cache directory");
      if (c.hooks_planned.length !== 79)
        problems.push(`${c.hooks_planned.length} hooks planned, expected 79`);
      if ("texture_set_path" in c.counts)
        problems.push("counters.json counts name texture_set_path");
      if (c.captured.texture_set_path !== undefined)
        problems.push("counters.json captured.texture_set_path is present");
    }
    if (results[off] && "texture_cache" in (results[off] as object))
      problems.push("result.json has a texture_cache block with no directory");
    if (cacheJson[off] !== undefined)
      problems.push("evidence/texture-cache.json exists with no directory");
    const base = recs[off];
    const offLog = maskedHookLog(
      await readText(join(legDirs[off], "evidence", "resources.jsonl")),
    );
    const compared: string[] = [];
    for (const l of [
      cold,
      "warm/capture",
      "prepared/capture",
      "bounded/capture",
      "sabotage-corrupt/capture",
      "sabotage-corrupt/after/capture",
    ]) {
      if (!ran(l)) continue;
      const r = recs[l];
      if (typeof base === "string" || base === undefined)
        problems.push(`off/capture: ${base ?? "no recording"}`);
      else if (typeof r === "string" || r === undefined)
        problems.push(`${l}: ${r ?? "no recording"}`);
      else {
        const cmp = compareWorkerRecordings(base, r);
        problems.push(...cmp.problems.map((p) => `${l}: ${p}`));
        if (cmp.held_frames.length > 0)
          problems.push(`${l}: frames ${cmp.held_frames.join(",")} missing`);
        compared.push(`${l} ${cmp.async_transactions}`);
      }
      const log = maskedHookLog(
        await readText(join(legDirs[l], "evidence", "resources.jsonl")),
      );
      if (JSON.stringify(log.texture) !== JSON.stringify(offLog.texture))
        problems.push(
          `${l}: the hook log's texture lines differ from off/capture's`,
        );
      if (JSON.stringify(log.stores) !== JSON.stringify(offLog.stores))
        problems.push(
          `${l}: the stored payload hashes differ from off/capture's`,
        );
    }
    checks.push(
      check(
        "cache-off-identical",
        "G8kc: with no GRC_TEXTURE_CACHE_DIR the capture is the one it was (79 hooks planned, no texture_set_path, no texture_cache block or texture-cache.json), and with any cache state (cold, warm, prepared, bounded, damaged, repaired) every transaction's state, the hook log's texture lines and the stored payload hashes equal the uncached capture's",
        ran("off/capture") ? problems : null,
        `compared ${compared.join(", ")} transactions; 79 hooks planned`,
        "off/capture",
      ),
    );
  }

  // --- cache-paths: the texture_set_path hook (D10) ----------------------------------------------
  {
    const problems: string[] = [];
    okExit(cold, problems);
    const c = counters[cold];
    const ev = cacheJson[cold];
    if (!c) problems.push("cold/capture has no counters.json");
    else {
      if (!c.hooks_planned.includes("texture_set_path"))
        problems.push(
          "texture_set_path is not planned under a cache directory",
        );
      if (c.hooks_planned.length !== 80)
        problems.push(`${c.hooks_planned.length} hooks planned, expected 80`);
      if (!((c.counts.texture_set_path ?? 0) > 0))
        problems.push("the hook was never called");
    }
    const calls = c?.captured.texture_set_path ?? [];
    const logged = new Set(calls.map((x) => x.path));
    const byPath = new Map(
      (ev?.textures ?? [])
        .filter((t) => t.path !== null)
        .map((t) => [t.path as string, t]),
    );
    if (!ev) problems.push("cold/capture has no texture-cache.json");
    else if (!ev.path_hook)
      problems.push("texture-cache.json path_hook is false");
    for (const f of coldFixture) {
      if (!logged.has(f.path))
        problems.push(
          `the fixture loaded ${f.path}, texture_set_path never named it`,
        );
      const t = byPath.get(f.path);
      if (!t) problems.push(`texture-cache.json has no texture for ${f.path}`);
    }
    // every call's texture id is one the cache evidence names, and its path is that texture's
    const ids = new Map((ev?.textures ?? []).map((t) => [t.id, t]));
    for (const call of calls) {
      const t = ids.get(call.texture);
      if (
        t &&
        t.path !== null &&
        !calls.some((x) => x.texture === call.texture && x.path === t.path)
      )
        problems.push(
          `texture ${call.texture}: path ${t.path} is not among its calls`,
        );
    }
    checks.push(
      check(
        "cache-paths",
        "G8kc (D10): under a cache directory the capture hooks texture_set_path (80 hooks planned), logs every call (texture id and res:// path) in counters.json, and texture-cache.json names the path of every texture the fixture loaded",
        ran(cold) ? problems : null,
        `${calls.length} calls, ${coldFixture.length} fixture textures all named`,
        cold,
      ),
    );
  }

  // --- cache-cold: every decode derived, stored, and agreeing with the oracle ---------------------
  {
    const problems: string[] = [];
    okExit(cold, problems);
    const s = stats[cold];
    const ev = cacheJson[cold];
    const idx = foldIndex(
      await readText(join(legDirs[cold], "..", "cache", "index-v1.jsonl")),
    );
    if (!s) problems.push("cold/capture result.json has no texture_cache");
    else {
      if (s.hits + s.misses + s.corrupt !== decodable.length)
        problems.push(
          `${s.hits + s.misses + s.corrupt} lookups, ${decodable.length} decodable fixture textures`,
        );
      if (s.corrupt !== 0)
        problems.push(`${s.corrupt} corrupt files in a fresh cache`);
      if (s.derivations !== s.misses + s.corrupt)
        problems.push(
          `derivations ${s.derivations} != misses+corrupt ${s.misses + s.corrupt}`,
        );
      if (s.puts !== s.derivations)
        problems.push(`puts ${s.puts} != derivations ${s.derivations}`);
      if (!(s.misses > 0)) problems.push("a fresh cache had no miss");
      if (s.encodes !== 0)
        problems.push(
          `encodes ${s.encodes}: a passthrough session runs no encoder`,
        );
    }
    for (const f of decodable) {
      const o = oracleOf(f.name, f.family);
      const t = ev?.textures.find((x) => x.path === f.path);
      if (!t) {
        problems.push(`${f.name}/${f.family}: no texture-cache entry`);
        continue;
      }
      if (t.source_key !== o?.block_payload_sha256)
        problems.push(
          `${f.name}/${f.family}: source key ${t.source_key?.slice(0, 12)} != the oracle's block payload ${o?.block_payload_sha256?.slice(0, 12)}`,
        );
      if (t.hash !== o?.payload_sha256)
        problems.push(
          `${f.name}/${f.family}: decoded hash differs from the oracle's`,
        );
      const row = idx.get(`${t.source_key} decoded ${DECODE_PARAMS_ID}`);
      if (!row || row.hash !== t.hash)
        problems.push(`${f.name}/${f.family}: the index has no matching row`);
      else if (row.ext !== "grt")
        problems.push(`${f.name}/${f.family}: row ext ${row.ext}`);
    }
    // a source that needs no derivation is filed by its own hash, with no cache row
    for (const t of ev?.textures ?? []) {
      if (t.outcome === "source" && t.source_key !== t.hash)
        problems.push(
          `texture ${t.id}: a source texture's key is not its hash`,
        );
    }
    // G8ku: the UASTC encodes go through the same cache, keyed (source key, uastc, params_id).
    const ul = "uastc-cold/capture";
    const us = stats[ul];
    const uds = basisStats(ul);
    const uvars = await uastcBySize(legDirs[ul]);
    okExit(ul, problems);
    if (!us || !uds)
      problems.push(
        `${ul}: result.json has no texture_cache or delivery_stats`,
      );
    else {
      if (!((uds.uastc_built ?? 0) > 0))
        problems.push(`${ul}: no uastc variant built`);
      // Every published variant was encoded here; an encode whose texture changed content before
      // it finished (the fixture's `updated`) is run and stored too, just never published.
      if (us.encodes < (uds.uastc_built ?? 0) || uds.cache_hits !== 0)
        problems.push(
          `${ul}: encodes ${us.encodes}, cache hits ${uds.cache_hits}, uastc_built ${uds.uastc_built}`,
        );
      if (us.puts !== us.derivations + us.encodes)
        problems.push(
          `${ul}: puts ${us.puts} != derivations ${us.derivations} + encodes ${us.encodes}`,
        );
      const uidx = [
        ...foldIndex(
          await readText(join(legDirs[ul], "..", "cache", "index-v1.jsonl")),
        ).values(),
      ].filter((r) => r.encoding === "uastc");
      if (uidx.length !== us.encodes)
        problems.push(
          `${ul}: ${uidx.length} uastc index rows, ${us.encodes} encodes`,
        );
      for (const r of uidx)
        if (r.params !== UASTC_PARAMS_ID || r.ext !== "ktx2")
          problems.push(
            `${ul}: uastc row ${r.hash.slice(0, 12)} has params ${r.params}, ext ${r.ext}`,
          );
      const rowHashes = new Set(uidx.map((r) => r.hash));
      for (const [size, h] of uvars)
        if (!rowHashes.has(h))
          problems.push(
            `${ul}: the published ${size} uastc variant has no cache row`,
          );
    }
    checks.push(
      check(
        "cache-cold",
        "G8kc (D7, D8): on an empty cache every decodable fixture texture is derived once and stored (derivations = puts = misses), its source key equals the oracle's independently built block payload hash, its stored decoded hash equals the oracle's payload hash, and the index maps (source key, decoded, params_id) to that hash; G8ku: under basis-uastc every UASTC encode is stored as (source key, uastc, basisu-1.60/uastc-l1/zstd6/linear) -> its KTX2 (puts = derivations + encodes, one row per encode) and every published uastc variant has its row",
        ran(cold, "uastc-cold/capture") ? problems : null,
        `${s?.misses} derived and stored, ${s?.bytes_put} bytes; ${us?.encodes} UASTC encodes stored`,
        missingOf(cold, "uastc-cold/capture"),
      ),
    );
  }

  // --- cache-warm: a second session derives nothing and hashes the same --------------------------
  {
    const problems: string[] = [];
    const coldEv = cacheJson[cold];
    const coldStats = stats[cold];
    const detail: string[] = [];
    for (const l of ["warm/capture", "warm-workers/capture"]) {
      okExit(l, problems);
      const s = stats[l];
      const ev = cacheJson[l];
      if (!s) {
        problems.push(`${l}: result.json has no texture_cache`);
        continue;
      }
      const total =
        (coldStats?.hits ?? 0) +
        (coldStats?.misses ?? 0) +
        (coldStats?.corrupt ?? 0);
      if (s.derivations !== 0)
        problems.push(`${l}: ${s.derivations} derivations in a warm session`);
      if (s.encodes !== 0)
        problems.push(`${l}: ${s.encodes} encodes in a warm session`);
      if (s.misses !== 0 || s.puts !== 0 || s.corrupt !== 0)
        problems.push(
          `${l}: misses ${s.misses}, puts ${s.puts}, corrupt ${s.corrupt}`,
        );
      if (s.hits !== total)
        problems.push(
          `${l}: ${s.hits} hits, the cold session looked up ${total}`,
        );
      for (const f of decodable) {
        const t = ev?.textures.find((x) => x.path === f.path);
        const c = coldEv?.textures.find((x) => x.path === f.path);
        if (!t) problems.push(`${l}: no texture-cache entry for ${f.path}`);
        else if (t.outcome !== "hit")
          problems.push(`${l}: ${f.name}/${f.family} outcome ${t.outcome}`);
        else if (t.hash !== c?.hash || t.source_key !== c?.source_key)
          problems.push(
            `${l}: ${f.name}/${f.family} hash or key differs from the cold session`,
          );
        else if (t.hash !== oracleOf(f.name, f.family)?.payload_sha256)
          problems.push(
            `${l}: ${f.name}/${f.family} hash differs from the oracle`,
          );
      }
      detail.push(`${l}: ${s.hits} hits, 0 derivations`);
    }
    // identical bytes at every hit: the cache directory's files, verified by name, are the ones the
    // cold session wrote (the warm index equals the cold index in keys and hashes)
    const a = foldIndex(
      await readText(join(legDirs[cold], "..", "cache", "index-v1.jsonl")),
    );
    const b = foldIndex(
      await readText(
        join(legDirs["warm/capture"], "..", "cache", "index-v1.jsonl"),
      ),
    );
    if (a.size === 0) problems.push("cold index is empty");
    for (const [key, row] of a)
      if (b.get(key)?.hash !== row.hash)
        problems.push(
          `index row ${key.slice(0, 20)} changed in the warm session`,
        );
    if (a.size !== b.size)
      problems.push(
        `index has ${b.size} rows after the warm session, ${a.size} before`,
      );
    // G8ku: the second basis-uastc session runs zero UASTC encodes: every variant is the cold
    // session's KTX2, served from a verified file.
    {
      const cl = "uastc-cold/capture";
      const wl = "uastc-warm/capture";
      okExit(wl, problems);
      const ws = stats[wl];
      const wds = basisStats(wl);
      const cds = basisStats(cl);
      if (!ws || !wds)
        problems.push(
          `${wl}: result.json has no texture_cache or delivery_stats`,
        );
      else {
        if (ws.encodes !== 0)
          problems.push(`${wl}: ${ws.encodes} UASTC encodes in a warm session`);
        if (
          ws.derivations !== 0 ||
          ws.misses !== 0 ||
          ws.puts !== 0 ||
          ws.corrupt !== 0
        )
          problems.push(
            `${wl}: derivations ${ws.derivations}, misses ${ws.misses}, puts ${ws.puts}, corrupt ${ws.corrupt}`,
          );
        if (
          wds.cache_hits !== cds?.uastc_built ||
          wds.uastc_built !== cds?.uastc_built
        )
          problems.push(
            `${wl}: ${wds.cache_hits} cache hits, ${wds.uastc_built} variants; the cold session built ${cds?.uastc_built}`,
          );
      }
      const cv = await uastcBySize(legDirs[cl]);
      const wv = await uastcBySize(legDirs[wl]);
      if (cv.size === 0)
        problems.push("the cold session's store lists no uastc variant");
      else
        for (const [size, hash] of cv)
          if (wv.get(size) !== hash)
            problems.push(
              `${wl}: the ${size} uastc variant differs from the cold session's`,
            );
      detail.push(
        `${wl}: ${wds?.cache_hits} UASTC variants from the cache, 0 encodes`,
      );
    }
    checks.push(
      check(
        "cache-warm",
        "G8kc (D8): a second session on the cold session's cache directory (synchronous, and at GRC_TEXTURE_WORKERS=2) does zero derivations and zero encodes, serves every decodable texture from a verified file, and every hash and source key equals the cold session's and the oracle's; G8ku: a second basis-uastc session runs zero UASTC encodes and publishes the cold session's uastc variants, every one served from the cache",
        ran(
          cold,
          "warm/capture",
          "warm-workers/capture",
          "uastc-cold/capture",
          "uastc-warm/capture",
        )
          ? problems
          : null,
        detail.join("; "),
        missingOf(
          cold,
          "warm/capture",
          "warm-workers/capture",
          "uastc-cold/capture",
          "uastc-warm/capture",
        ),
      ),
    );
  }

  // --- prepare-key-match: the prepare step fills what a session then hits -------------------------
  {
    const problems: string[] = [];
    const l = "prepared/capture";
    okExit("prepare", problems);
    okExit(l, problems);
    const ps = prepareResult?.texture_cache;
    const s = stats[l];
    const ev = cacheJson[l];
    if (!prepareCache)
      problems.push("the prepare run wrote no texture-cache.json");
    if (!ps)
      problems.push("the prepare run's result.json has no texture_cache");
    else if (
      ps.misses + ps.hits !== decodable.length * 1 &&
      ps.misses + ps.hits < decodable.length
    )
      problems.push(
        `the prepare run looked up ${ps.misses + ps.hits}, ${decodable.length} decodable textures exist`,
      );
    const prepared = new Map(
      (prepareCache?.textures ?? [])
        .filter((t) => t.path !== null)
        .map((t) => [ctexName(t.path), t]),
    );
    if (!s) problems.push("prepared/capture result.json has no texture_cache");
    else {
      if (s.derivations !== 0 || s.misses !== 0 || s.puts !== 0)
        problems.push(
          `derivations ${s.derivations}, misses ${s.misses}, puts ${s.puts}: not all hit`,
        );
      if (s.hits !== decodable.length)
        problems.push(
          `${s.hits} hits, ${decodable.length} decodable fixture textures`,
        );
    }
    const fixture = await fixtureLines(l);
    let matched = 0;
    for (const f of fixture) {
      const t = ev?.textures.find((x) => x.path === f.path);
      const p = prepared.get(ctexName(f.path));
      if (!t) {
        problems.push(`${f.name}/${f.family}: not hooked`);
        continue;
      }
      if (!p) {
        problems.push(
          `${f.name}/${f.family}: the prepare step never loaded ${ctexName(f.path)}`,
        );
        continue;
      }
      if (t.status !== "ok") continue; // hdr: refused at the hook, nothing to key
      if (t.source_key !== p.source_key)
        problems.push(
          `${f.name}/${f.family}: source key ${t.source_key?.slice(0, 12)} != prepared ${p.source_key?.slice(0, 12)}`,
        );
      else if (oracleOf(f.name, f.family)?.block_payload_sha256) {
        if (t.outcome !== "hit")
          problems.push(
            `${f.name}/${f.family}: outcome ${t.outcome}, not a hit`,
          );
        else matched++;
      } else if (t.outcome !== "source")
        problems.push(`${f.name}/${f.family}: outcome ${t.outcome}`);
      else matched++;
    }
    const idxPrepared = foldIndex(
      await readText(join(legDirs.prepare, "cache", "index-v1.jsonl")),
    );
    const idxCold = foldIndex(
      await readText(join(legDirs[cold], "..", "cache", "index-v1.jsonl")),
    );
    for (const [key, row] of idxCold)
      if (idxPrepared.get(key)?.hash !== row.hash)
        problems.push(
          `the prepared cache's row ${key.slice(0, 20)} differs from the live session's`,
        );
    checks.push(
      check(
        "prepare-key-match",
        "G8kc (D9b): scripts/prepare-textures.sh, run over the fixture's imported .ctex files with no live session, computes the same source keys the hooks compute (every hooked fixture texture finds its key in the prepare run), fills the same index rows and files a live session would, and the next session hits every one of them with zero derivations",
        ran("prepare", l) ? problems : null,
        `${matched} fixture textures matched; ${s?.hits} hits, 0 derivations`,
        missingOf("prepare", l),
      ),
    );
  }

  // --- cache-corrupt: the sabotage is detected and repaired ---------------------------------------
  {
    const problems: string[] = [];
    const l = "sabotage-corrupt/capture";
    const after = "sabotage-corrupt/after/capture";
    okExit(l, problems);
    okExit(after, problems);
    const damaged = await readJson<{
      flipped: string;
      truncated: string;
      deleted: string;
    }>(join(legDirs[l], "..", "damaged.json"));
    const before = foldIndex(
      await readText(join(legDirs[l], "..", "index-before.jsonl")),
    );
    const s = stats[l];
    const sa = stats[after];
    if (!damaged)
      problems.push("damaged.json is missing: the runner damaged nothing");
    else if (!s) problems.push(`${l}: result.json has no texture_cache`);
    else {
      const rowsOf = (h: string) =>
        [...before.values()].filter((r) => r.hash === h).length;
      const detected = [damaged.flipped, damaged.truncated];
      if (s.corrupt !== detected.length)
        problems.push(
          `${s.corrupt} corrupt files detected, ${detected.length} were damaged`,
        );
      const expectedDerived =
        rowsOf(damaged.flipped) +
        rowsOf(damaged.truncated) +
        rowsOf(damaged.deleted);
      if (s.derivations !== expectedDerived)
        problems.push(
          `${s.derivations} derivations, the three damaged files back ${expectedDerived} keys`,
        );
      if (s.puts !== s.derivations)
        problems.push(`puts ${s.puts} != derivations ${s.derivations}`);
      if (
        s.hits + s.derivations !==
        (stats[cold]?.misses ?? 0) + (stats[cold]?.hits ?? 0)
      )
        problems.push(
          `${s.hits} hits + ${s.derivations} derivations != the cold session's lookups`,
        );
      // a damaged file is never served: every texture's hash still equals the oracle's / the cold one
      const ev = cacheJson[l];
      for (const f of decodable) {
        const t = ev?.textures.find((x) => x.path === f.path);
        if (!t || t.hash !== oracleOf(f.name, f.family)?.payload_sha256)
          problems.push(
            `${f.name}/${f.family}: published hash is not the oracle's under a damaged cache`,
          );
      }
      const outcomes = new Set((ev?.textures ?? []).map((t) => t.outcome));
      if (!outcomes.has("corrupt"))
        problems.push("no texture reports outcome corrupt");
    }
    if (!sa) problems.push(`${after}: result.json has no texture_cache`);
    else if (sa.corrupt !== 0 || sa.derivations !== 0 || sa.misses !== 0)
      problems.push(
        `the session after the repair: corrupt ${sa.corrupt}, derivations ${sa.derivations}, misses ${sa.misses}`,
      );
    const idx = foldIndex(
      await readText(join(legDirs[l], "..", "cache", "index-v1.jsonl")),
    );
    if (idx.size !== before.size)
      problems.push(
        `${idx.size} index rows after the repair, ${before.size} before`,
      );
    checks.push(
      check(
        "cache-corrupt",
        "G8kc sabotage (D8): with one cached file byte-flipped, one truncated and one deleted, the session detects the two that fail verify-against-name (never serving them), derives and stores all three keys' payloads again with hashes equal to the oracle's, and the session after it finds the cache clean (zero corrupt, zero derivations)",
        ran(l, after) ? problems : null,
        `${s?.corrupt} corrupt detected, ${s?.derivations} re-derived, clean afterwards`,
        missingOf(l, after),
      ),
    );
  }

  // --- cache-lru: the byte budget ---------------------------------------------------------------
  {
    const problems: string[] = [];
    const l = "bounded/capture";
    okExit(l, problems);
    const s = stats[l];
    if (!s) problems.push("result.json has no texture_cache");
    else {
      if (!(s.max_bytes > 0)) problems.push("no budget was set");
      if (!(s.evicted > 0))
        problems.push("nothing was evicted under the budget");
      if (s.bytes > s.max_bytes)
        problems.push(`${s.bytes} bytes kept, budget ${s.max_bytes}`);
      if (s.puts !== s.misses)
        problems.push(`puts ${s.puts} != misses ${s.misses}`);
    }
    const idx = foldIndex(
      await readText(join(legDirs[l], "..", "cache", "index-v1.jsonl")),
    );
    const files = (
      (await readText(join(legDirs[l], "..", "cache", "files.txt"))) ?? ""
    )
      .split("\n")
      .filter((x) => x.trim() !== "");
    const hashes = new Set([...idx.values()].map((r) => r.hash));
    if (files.length !== hashes.size)
      problems.push(
        `${files.length} files on disk, ${hashes.size} hashes in the index`,
      );
    if (s && idx.size !== s.entries)
      problems.push(`${idx.size} index rows, stats say ${s.entries}`);
    // LRU: what is kept is the most recently stored (the fixture creates in step order)
    const ev = cacheJson[l];
    const derived = (ev?.textures ?? []).filter((t) => t.outcome === "miss");
    const keptKeys = new Set([...idx.values()].map((r) => r.source));
    const lastKept = derived
      .slice(-keptKeys.size)
      .every((t) => keptKeys.has(t.source_key ?? ""));
    if (!lastKept)
      problems.push("the kept entries are not the most recently used ones");
    checks.push(
      check(
        "cache-lru",
        "G8kc (D8): under GRC_TEXTURE_CACHE_MAX_BYTES the cache evicts least-recently-used files until it fits (bytes kept <= the budget, evictions counted, files on disk = hashes in the index), keeping the most recent entries",
        ran(l) ? problems : null,
        `${s?.evicted} evicted, ${s?.bytes}/${s?.max_bytes} bytes kept`,
        l,
      ),
    );
  }

  // --- cache-adopt: a pre-arm texture adopted late goes through the cache (D9a) -------------------
  {
    const problems: string[] = [];
    const a = "adopt-cold/capture";
    const b = "adopt-warm/capture";
    okExit(a, problems);
    okExit(b, problems);
    const sa = stats[a];
    const sb = stats[b];
    if (!sa || !sb)
      problems.push("an adopt leg's result.json has no texture_cache");
    else {
      if (!(sa.misses > 0 && sa.derivations === sa.misses))
        problems.push(
          `cold: misses ${sa.misses}, derivations ${sa.derivations}: the adopted block texture was not derived through the cache`,
        );
      if (sb.derivations !== 0 || sb.misses !== 0 || sb.puts !== 0)
        problems.push(
          `warm: derivations ${sb.derivations}, misses ${sb.misses}, puts ${sb.puts}`,
        );
      if (sb.hits !== sa.hits + sa.misses + sa.corrupt)
        problems.push(
          `warm: ${sb.hits} hits, the cold session looked up ${sa.hits + sa.misses + sa.corrupt}`,
        );
    }
    const load = async (l: string): Promise<ResolvedRecording | string> => {
      const path = join(legDirs[l], "recording.rs8");
      if (!existsSync(path)) return "recording.rs8 missing";
      const bytes = new Uint8Array(await readFile(path));
      const errors = validateRecording(bytes, 8);
      if (errors.length > 0) return `invalid at /8: ${errors[0]}`;
      return resolveRecording(bytes, 8);
    };
    if (ran(a, b)) {
      const ra = await load(a);
      const rb = await load(b);
      if (typeof ra === "string") problems.push(`${a}: ${ra}`);
      else if (typeof rb === "string") problems.push(`${b}: ${rb}`);
      else {
        const cmp = compareWorkerRecordings(ra, rb);
        problems.push(...cmp.problems);
        if (cmp.held_frames.length > 0)
          problems.push(
            `frames ${cmp.held_frames.join(",")} missing in the warm recording`,
          );
      }
    }
    checks.push(
      check(
        "cache-adopt",
        "G8kc (D9a): a pre-arm block-compressed texture adopted at a late arm (GRC_ADOPT=arm) takes the same cache path as a hooked one: the cold session derives and stores it, the warm session on the same directory derives nothing, and both recordings resolve to the same state at every frame",
        ran(a, b) ? problems : null,
        `cold ${sa?.misses} derived, warm ${sb?.hits} hits and 0 derivations, same states`,
        missingOf(a, b),
      ),
    );
  }

  return { checks, legs, stats };
}
