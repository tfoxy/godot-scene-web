// Gate 8 group g8t (G8t, protocol/gate8-design.md Q3 "Checks", "Sabotages"): the checks over the
// evidence run-gate8.sh's g8t legs write. Pure functions of the evidence tree, so
// scripts/test/self-test-gate8.ts can drive them against fabricated trees.
//
//   import/{sources,fixture,receiver}/   editor: make_sources.gd, --import (fixture, receiver)
//   oracle/                              oracle.gd: oracle.json + <name>.<family>.grt1
//   capture/                             /8, GRC_TEXTURE_DECODE=engine: recording.rs8, store,
//                                        evidence/resources.jsonl, steps.jsonl, textures.jsonl
//   decode-off/capture/                  default /6, no decode: today's refusals
//   sabotage-perturb-decode/{capture,receiver}/
//   reference/ reference-hw/             rendered: shots/step-<k>.png
//   receiver/ receiver-patch/            native receiver on capture/'s full and patch sinks
//   decode-cost/{oracle-timing,capture}/ the timing group (real time, exclusive lock)
//   workers/capture/                     G8kw: capture/ again under GRC_TEXTURE_WORKERS=2 (every
//                                        copy on a worker, a per-job delay forcing the hold-back)
//   workers/sabotage-publish-before-ready/capture/  the same with the publish-before-ready fault
//   decode-cost/capture-workers/         G8kw timing: the cost textures at GRC_TEXTURE_WORKERS=2

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  decodeRecording,
  type ResolvedRecording,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

export interface G8tCheck {
  id: string;
  criterion: string;
  passed: boolean;
  status: "pass" | "fail" | "not-run";
  detail?: string;
  gating?: boolean;
}

export interface TexFamilyExpected {
  source_format: string | null;
  format?: string;
  refused?: string;
}

export interface TexExpected {
  width: number;
  height: number;
  mipmaps: boolean;
  drawn?: boolean;
  desktop: TexFamilyExpected;
  mobile: TexFamilyExpected;
}

export interface G8tExpected {
  start_frame: number;
  step_frames: number;
  settle_offset: number;
  steps: { step: number; family: "desktop" | "mobile" }[];
  textures: Record<string, TexExpected>;
  cost: Record<string, TexExpected>;
  design_cost: Record<string, { ms: number; mpx_per_s: number } | string>;
  engine_textures: { format: string; width: number; height: number }[];
  perturb_from_step: number;
}

/** One texture line of evidence/resources.jsonl (the keys g8t reads). */
export interface HookTextureLine {
  frame: number;
  thread: string;
  op: string;
  id: number | null;
  status: string | null;
  reason: string | null;
  format: string | null;
  source_format?: string;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
  data_bytes: number | null;
  payload_bytes: number | null;
  hash: string | null;
  copy_ns: number | null;
  hash_ns: number | null;
  decode_ns: number | null;
  /** G8kw: present only on a copy a texture worker made (the *_ns above are then the worker's). */
  worker?: boolean;
  hook_ns?: number;
  dup_ns?: number;
}

/** One line of the fixture's textures.jsonl. */
export interface FixtureTextureLine {
  step: number;
  frame: number;
  name: string;
  family: "desktop" | "mobile";
  key: string;
  path: string;
  source: string;
  format: string | null;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
}

export interface OracleEntry {
  name: string;
  family: "desktop" | "mobile";
  key: string;
  path: string;
  source_format?: string;
  width?: number;
  height?: number;
  mipmaps?: boolean;
  decoded_format?: string | null;
  payload_sha256?: string | null;
  decompress_best_us?: number;
  mpx_per_s?: number;
  error?: string;
}

export interface OracleReport {
  schema: string;
  timing: boolean;
  repeats: number;
  textures: OracleEntry[];
}

export interface PairedTexture {
  fixture: FixtureTextureLine;
  hook: HookTextureLine | undefined;
}

export interface CostRow {
  name: string;
  source_format: string;
  width: number;
  height: number;
  oracle_best_ms: number | null;
  oracle_mpx_per_s: number | null;
  hook_decode_ms: number | null;
  hook_copy_ms: number | null;
  hook_hash_ms: number | null;
  hook_total_ms: number | null;
  thread: string | null;
  design_ms: number | null;
  design_mpx_per_s: number | null;
  /** G8kw: the same create at GRC_TEXTURE_WORKERS=2 (decode-cost/capture-workers): the hook's own
   * calling-thread time, the copy-on-write duplicate within it, and the worker's decode/copy/hash. */
  workers_hook_ms?: number | null;
  workers_dup_ms?: number | null;
  workers_job_ms?: number | null;
}

export interface ShotDiff {
  step: number;
  a: string;
  b: string;
  present: boolean;
  differing: number;
  max_delta: number;
}

/** G8kw: what the workers capture's result.json says about its pool and hold-back. */
export interface WorkerStats {
  workers: number;
  jobs: number;
  completed: number;
  held_callbacks: number;
  published_late: number;
  coalesced: number;
  max_lag_frames: number;
}

export interface G8tReport {
  checks: G8tCheck[];
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  decode_cost: CostRow[];
  workers?: { full: WorkerCompare | null; patch: WorkerCompare | null; stats: WorkerStats | null };
  hitch: { name: string; source_format: string; total_ms: number } | null;
  hardware_band: ShotDiff[];
}

// ------------------------------------------------------------------------------- evidence I/O

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
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

export async function hookTextureCreates(
  legDir: string,
): Promise<HookTextureLine[]> {
  return jsonl<HookTextureLine>(
    await readText(join(legDir, "evidence", "resources.jsonl")),
  ).filter((l) => l.op === "texture_2d_create");
}

export async function fixtureTextures(
  legDir: string,
): Promise<FixtureTextureLine[]> {
  return jsonl<FixtureTextureLine>(
    await readText(join(legDir, "textures.jsonl")),
  );
}

async function exitCode(dir: string): Promise<string | null> {
  const t = await readText(join(dir, "exit-code.txt"));
  return t === undefined ? null : t.trim();
}

function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

// ------------------------------------------------------------------------------- pure helpers

/** G8kw: how an async (texture worker) recording compares with the synchronous one. */
export interface WorkerCompare {
  sync_transactions: number;
  async_transactions: number;
  /** frames the synchronous recording published and the async one held back */
  held_frames: number[];
  problems: string[];
}

/**
 * G8kw (texture-delivery-design.md Q7): the hold-back's contract against the synchronous
 * recording of the same run. Every async transaction is the synchronous transaction of the same
 * frame, state for state (seq aside: a held frame takes none); the last frames and states agree;
 * and both resolve. Pure, for the self-test.
 */
export function compareWorkerRecordings(sync: ResolvedRecording, workers: ResolvedRecording): WorkerCompare {
  const problems: string[] = [];
  const byFrame = new Map(sync.transactions.map((t) => [t.frame, t]));
  const asyncFrames = new Set(workers.transactions.map((t) => t.frame));
  let previous = -1;
  for (const t of workers.transactions) {
    if (t.frame <= previous) problems.push(`async frame ${t.frame} after ${previous}`);
    previous = t.frame;
    const s = byFrame.get(t.frame);
    if (!s) {
      problems.push(`async seq ${t.seq} is frame ${t.frame}, which the synchronous recording never published`);
      continue;
    }
    if (JSON.stringify(s.state) !== JSON.stringify(t.state)) {
      const parts = Object.keys(s.state).filter(
        (k) =>
          JSON.stringify((s.state as Record<string, unknown>)[k]) !==
          JSON.stringify((t.state as Record<string, unknown>)[k]),
      );
      problems.push(`frame ${t.frame}: the async state differs from the synchronous one in ${parts.join(", ")}`);
    }
  }
  const lastSync = sync.transactions.at(-1);
  const lastAsync = workers.transactions.at(-1);
  if (!lastAsync) problems.push("the async recording has no transaction");
  else if (lastSync && lastSync.frame !== lastAsync.frame)
    problems.push(`the async recording ends at frame ${lastAsync.frame}, the synchronous one at ${lastSync.frame}`);
  return {
    sync_transactions: sync.transactions.length,
    async_transactions: workers.transactions.length,
    held_frames: sync.transactions.map((t) => t.frame).filter((f) => !asyncFrames.has(f)),
    problems,
  };
}

/** G8kw: a hook log's texture lines with the cost columns and the worker keys dropped (their
 * order and every fact must match the synchronous log); store/inline/serve lines are listed apart,
 * as a hold-back moves them to the frame that published. */
export function maskedHookLog(text: string | undefined): { texture: string[]; stores: string[] } {
  const texture: string[] = [];
  const stores: string[] = [];
  for (const l of jsonl<Record<string, unknown>>(text)) {
    const op = String(l.op);
    if (op === "store" || op === "inline" || op.startsWith("http") || op.startsWith("serve")) {
      stores.push(`${op} ${l.hash}`);
      continue;
    }
    const m = { ...l };
    for (const k of ["t_us", "copy_ns", "hash_ns", "decode_ns", "worker", "hook_ns", "dup_ns"]) delete m[k];
    texture.push(JSON.stringify(m));
  }
  stores.sort();
  return { texture, stores };
}

/** The format the hook saw at texture_2d_create: a decode's source_format, else its format. */
export function hookSourceFormat(l: HookTextureLine): string | null {
  return l.source_format ?? l.format;
}

/** Pairs every fixture create with the hook's create of the same frame and shape. */
export function pairTextures(
  fixture: readonly FixtureTextureLine[],
  hook: readonly HookTextureLine[],
): PairedTexture[] {
  const used = new Set<number>();
  return fixture.map((f) => {
    const i = hook.findIndex(
      (h, j) =>
        !used.has(j) &&
        h.frame === f.frame &&
        hookSourceFormat(h) === f.format &&
        h.width === f.width &&
        h.height === f.height &&
        h.mipmaps === f.mipmaps,
    );
    if (i >= 0) used.add(i);
    return { fixture: f, hook: i >= 0 ? hook[i] : undefined };
  });
}

/** The import variant a family's texture used: a lossless import has one, the desktop one. */
export function usedFamily(f: { key: string; family: string }): string {
  return f.key === "" ? "desktop" : f.family;
}

export function oracleEntry(
  oracle: OracleReport | undefined,
  name: string,
  family: string,
): OracleEntry | undefined {
  return oracle?.textures.find((e) => e.name === name && e.family === family);
}

function expectedFor(
  expected: G8tExpected,
  name: string,
  family: "desktop" | "mobile",
): { tex: TexExpected; fam: TexFamilyExpected } | undefined {
  const tex = expected.textures[name] ?? expected.cost[name];
  if (!tex) return undefined;
  return { tex, fam: tex[family] };
}

/** Problems with one hook create against its expectation (decode on). */
export function censusProblems(
  p: PairedTexture,
  fam: TexFamilyExpected,
): string[] {
  const name = `${p.fixture.name}/${p.fixture.family}`;
  const h = p.hook;
  if (!h) return [`${name}: no texture_2d_create at frame ${p.fixture.frame}`];
  const out: string[] = [];
  if (fam.refused !== undefined) {
    if (h.status !== "unsupported" || h.reason !== fam.refused)
      out.push(`${name}: ${h.status}/${h.reason}, expected unsupported/${fam.refused}`);
    if (h.source_format !== undefined)
      out.push(`${name}: a refusal carries source_format ${h.source_format}`);
    if (h.format !== fam.source_format)
      out.push(`${name}: refused format ${h.format}, expected ${fam.source_format}`);
    return out;
  }
  if (h.status !== "ok") out.push(`${name}: ${h.status}/${h.reason}, expected ok`);
  if (h.format !== fam.format)
    out.push(`${name}: payload format ${h.format}, expected ${fam.format}`);
  if ((h.source_format ?? null) !== fam.source_format)
    out.push(
      `${name}: source_format ${h.source_format ?? null}, expected ${fam.source_format}`,
    );
  if (fam.source_format !== null && !(typeof h.decode_ns === "number" && h.decode_ns >= 0))
    out.push(`${name}: no decode_ns on a decoded texture`);
  return out;
}

/** Problems with one hook create against the oracle's decode of the same .ctex. */
export function oracleProblems(
  p: PairedTexture,
  oracle: OracleReport | undefined,
): string[] {
  const name = `${p.fixture.name}/${p.fixture.family}`;
  const e = oracleEntry(oracle, p.fixture.name, usedFamily(p.fixture));
  if (!e) return [`${name}: no oracle entry`];
  if (e.error) return [`${name}: oracle error ${e.error}`];
  const h = p.hook;
  if (!h) return [`${name}: no hook create`];
  if (e.source_format !== hookSourceFormat(h))
    return [`${name}: oracle source ${e.source_format}, hook ${hookSourceFormat(h)}`];
  if (e.payload_sha256 === null || e.payload_sha256 === undefined)
    return h.status === "ok"
      ? [`${name}: the oracle cannot carry ${e.source_format} but the hook published it`]
      : [];
  if (h.status !== "ok") return [`${name}: the oracle decodes it, the hook refused (${h.reason})`];
  if (h.hash !== e.payload_sha256)
    return [`${name}: hook payload ${h.hash?.slice(0, 12)} != oracle ${e.payload_sha256.slice(0, 12)}`];
  return [];
}

function check(
  id: string,
  criterion: string,
  problems: string[] | null,
  detailOk?: string,
  missing = "a leg did not run",
): G8tCheck {
  if (problems === null)
    // A failure, not "not-run": a leg skipped by tier or on a remote runner (skipped-by-tier.txt,
    // skipped-remote.txt) leaves no evidence, and lib/tier-verdict.py excuses exactly the checks
    // whose id or detail names such a leg; anything else missing stays a failure.
    return { id, criterion, passed: false, status: "fail", detail: `evidence missing (${missing})` };
  const passed = problems.length === 0;
  return {
    id,
    criterion,
    passed,
    status: passed ? "pass" : "fail",
    detail: passed ? detailOk : problems.slice(0, 12).join("; "),
  };
}

/** A leg's shot of `step`: a fixture run's shots/step-<k>.png, or a receiver's shots/seq-<n>.png
 * where n is the k-th entry of its shot-seqs.txt (the settle seqs in step order, lib/legs.sh). */
async function shotPath(dir: string, step: number): Promise<string> {
  const fixtureShot = join(dir, "shots", `step-${step}.png`);
  const seqs = await readText(join(dir, "shot-seqs.txt"));
  if (seqs === undefined) return fixtureShot;
  const seq = seqs.trim().split(",")[step];
  return join(dir, "shots", `seq-${seq}.png`);
}

async function shotDiff(
  a: string,
  b: string,
  step: number,
): Promise<ShotDiff> {
  const pa = await shotPath(a, step);
  const pb = await shotPath(b, step);
  const ia = existsSync(pa) ? await decodePngRgba(pa) : undefined;
  const ib = existsSync(pb) ? await decodePngRgba(pb) : undefined;
  const out: ShotDiff = { step, a: pa, b: pb, present: false, differing: 0, max_delta: 0 };
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) return out;
  out.present = true;
  for (let i = 0; i < ia.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ia.data[i + c] - ib.data[i + c]));
    if (d > 0) {
      out.differing++;
      out.max_delta = Math.max(out.max_delta, d);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- the group

export async function runG8t(
  out: string,
  expected: G8tExpected,
): Promise<G8tReport> {
  const checks: G8tCheck[] = [];
  const legDirs = [
    "import/sources",
    "import/fixture",
    "import/receiver",
    "oracle",
    "capture",
    "decode-off/capture",
    "sabotage-perturb-decode/capture",
    "reference",
    "reference-hw",
    "receiver",
    "receiver-patch",
    "sabotage-perturb-decode/receiver",
    "decode-cost/oracle-timing",
    "decode-cost/capture",
    "workers/capture",
    "workers/sabotage-publish-before-ready/capture",
    "delivery9/capture",
    "decode-cost/capture-workers",
  ];
  const legs: G8tReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = { exit_code: await exitCode(join(out, l)), skipped: skipped(join(out, l)) };
  const ran = (l: string) => legs[l].exit_code !== null && legs[l].skipped === null;
  const steps = expected.steps;

  // --- import and the oracle: the editor produced the formats the design names --------------
  const oracle = await readJson<OracleReport>(join(out, "oracle", "oracle.json"));
  {
    const problems: string[] = [];
    for (const l of ["import/sources", "import/fixture", "import/receiver", "oracle"])
      if (legs[l].exit_code !== "0") problems.push(`${l} exit ${legs[l].exit_code}`);
    if (!oracle) problems.push("oracle/oracle.json missing");
    for (const [name, tex] of Object.entries({ ...expected.textures, ...expected.cost }))
      for (const family of ["desktop", "mobile"] as const) {
        const fam = tex[family];
        const e = oracleEntry(oracle, name, fam.source_format === null ? "desktop" : family);
        if (!e) problems.push(`${name}/${family}: not imported`);
        else if ((e.source_format ?? null) !== (fam.source_format ?? "RGBA8"))
          problems.push(`${name}/${family}: imported as ${e.source_format}, expected ${fam.source_format ?? "RGBA8"}`);
        else if (e.width !== tex.width || e.height !== tex.height || e.mipmaps !== tex.mipmaps)
          problems.push(`${name}/${family}: imported ${e.width}x${e.height} mipmaps ${e.mipmaps}`);
      }
    checks.push(
      check(
        "g8t-import",
        "the pinned editor imports every fixture source to the block-compressed format expected.json derives from the importer (S3TC/BPTC desktop, ETC2/ASTC mobile), and the decode oracle loads every .ctex on the release template",
        problems,
        `${oracle?.textures.length ?? 0} oracle entries`,
      ),
    );
  }

  // --- the decode capture ------------------------------------------------------------------
  const capDir = join(out, "capture");
  const capHook = await hookTextureCreates(capDir);
  const capFixture = await fixtureTextures(capDir);
  const capPairs = pairTextures(capFixture, capHook);
  const capRan = ran("capture");
  {
    // decode-census
    const problems: string[] = [];
    if (legs.capture.exit_code !== "0") problems.push(`capture exit ${legs.capture.exit_code}`);
    for (const s of steps)
      for (const [name, tex] of Object.entries(expected.textures)) {
        const p = capPairs.find((x) => x.fixture.name === name && x.fixture.step === s.step);
        if (!p) {
          problems.push(`${name}: no fixture create at step ${s.step}`);
          continue;
        }
        problems.push(...censusProblems(p, tex[s.family]));
      }
    // nothing else is refused: every unsupported-format line is a declared refusal
    const declared = capPairs.filter((p) => {
      const ex = expectedFor(expected, p.fixture.name, p.fixture.family);
      return ex?.fam.refused !== undefined;
    }).length;
    const refused = capHook.filter((h) => h.reason === "unsupported-format").length;
    if (refused !== declared)
      problems.push(`${refused} unsupported-format creates, ${declared} declared`);
    for (const e of expected.engine_textures)
      if (!capHook.some((h) => h.format === e.format && h.width === e.width && h.height === e.height && h.status === "ok"))
        problems.push(`engine texture ${e.format} ${e.width}x${e.height} missing`);
    const unpaired = capHook.filter(
      (h) => h.source_format !== undefined && !capPairs.some((p) => p.hook === h),
    );
    if (unpaired.length > 0) problems.push(`${unpaired.length} decoded creates the fixture did not make`);
    const decoded = capHook.filter((h) => h.source_format !== undefined).length;
    checks.push(
      check(
        "decode-census",
        "under GRC_TEXTURE_DECODE=engine every fixture texture of both families is created with the payload format and source_format expected.json names (RGBA8/R8/RG8 from DXT1, DXT5, BPTC_RGBA, RGTC_R, RGTC_RG, ETC2_RGB8, ETC2_RGBA8, ETC2_R11, ETC2_RG11, ASTC_4x4), the lossless control and the engine's hue strip pass through undecoded, and only the declared formats (BPTC_RGBFU, ASTC_4x4_HDR) stay typed unsupported-format",
        capRan ? problems : null,
        `${decoded} decoded, ${refused} refused as declared`,
      ),
    );
  }
  {
    // decode-oracle
    const problems: string[] = [];
    for (const p of capPairs) problems.push(...oracleProblems(p, oracle));
    checks.push(
      check(
        "decode-oracle",
        "every host-decoded payload's SHA-256 equals the GRT1 payload hash a separate headless process (oracle.gd) computes from the same .ctex with Image.decompress, and every texture the oracle cannot carry is refused",
        capRan && oracle ? problems : null,
        `${capPairs.length} creates agree with the oracle`,
      ),
    );
  }
  {
    // decode-wire: the /8 recording, its session's decode policy and the table entries
    const problems: string[] = [];
    const bytes = existsSync(join(capDir, "recording.rs8"))
      ? new Uint8Array(await readFile(join(capDir, "recording.rs8")))
      : undefined;
    if (!bytes) problems.push("capture/recording.rs8 missing");
    else if (wireVersionOf(bytes) !== 8) problems.push("capture/recording.rs8 is not GRS8");
    else {
      const errors = validateRecording(bytes, 8);
      if (errors.length > 0) problems.push(`invalid /8 recording: ${errors[0]}`);
      const decoded = decodeRecording(bytes, 8) as unknown as {
        records: { meta: Record<string, unknown> }[];
      };
      const session = decoded.records[0]?.meta as
        | { resources?: { decode?: string } }
        | undefined;
      if (session?.resources?.decode !== "engine")
        problems.push(`session resources.decode ${session?.resources?.decode}`);
      const byHash = new Map<string, HookTextureLine>();
      for (const h of capHook) if (h.hash) byHash.set(h.hash, h);
      let entries = 0;
      for (const r of decoded.records) {
        const textures = r.meta.textures as
          | { status: string; hash: string | null; format: string | null; source_format: string | null }[]
          | undefined;
        for (const t of textures ?? []) {
          if (t.status !== "ok" || !t.hash) continue;
          entries++;
          const h = byHash.get(t.hash);
          if (!h) problems.push(`table entry ${t.hash.slice(0, 12)} has no hook create`);
          else if (t.format !== h.format || (t.source_format ?? undefined) !== h.source_format)
            problems.push(
              `table entry ${t.hash.slice(0, 12)}: ${t.format}/${t.source_format} vs hook ${h.format}/${h.source_format}`,
            );
        }
      }
      if (entries === 0) problems.push("no ok texture entries in the recording");
    }
    checks.push(
      check(
        "decode-wire",
        "the decode capture writes a valid render-stream/8 recording whose session declares resources.decode \"engine\" and whose texture entries carry the payload format and source_format the hook logged",
        capRan ? problems : null,
      ),
    );
  }

  // --- the decode-off control: today's refusals, exactly ----------------------------------
  {
    const dir = join(out, "decode-off", "capture");
    const hook = await hookTextureCreates(dir);
    const pairs = pairTextures(await fixtureTextures(dir), hook);
    const problems: string[] = [];
    if (legs["decode-off/capture"].exit_code !== "0")
      problems.push(`decode-off exit ${legs["decode-off/capture"].exit_code}`);
    const bytes = existsSync(join(dir, "recording.rs2"))
      ? new Uint8Array(await readFile(join(dir, "recording.rs2")))
      : undefined;
    if (!bytes || wireVersionOf(bytes) !== 6) problems.push("decode-off/capture/recording.rs2 is not GRS6");
    for (const p of pairs) {
      const ex = expectedFor(expected, p.fixture.name, p.fixture.family);
      if (!ex) continue;
      const h = p.hook;
      const name = `${p.fixture.name}/${p.fixture.family}`;
      if (!h) {
        problems.push(`${name}: no create`);
        continue;
      }
      if (ex.fam.source_format === null) {
        if (h.status !== "ok") problems.push(`${name}: the lossless control is ${h.status}`);
      } else if (
        h.status !== "unsupported" ||
        h.reason !== "unsupported-format" ||
        h.format !== ex.fam.source_format ||
        h.source_format !== undefined ||
        h.decode_ns !== null
      )
        problems.push(`${name}: ${h.status}/${h.reason} format ${h.format} source ${h.source_format} decode_ns ${h.decode_ns}`);
    }
    if (pairs.length !== capPairs.length && capRan)
      problems.push(`${pairs.length} creates with decode off, ${capPairs.length} with decode on`);
    checks.push(
      check(
        "decode-off",
        "with GRC_TEXTURE_DECODE unset (the default /6 file sink) every block-compressed fixture texture is refused unsupported-format with its own format, no source_format and no decode time, exactly as before G8t",
        ran("decode-off/capture") ? problems : null,
        `${pairs.length} creates`,
      ),
    );
  }

  // --- receivers against the CPU-decoded reference (exact) ----------------------------------
  const hardware_band: ShotDiff[] = [];
  {
    const problems: string[] = [];
    let compared = 0;
    for (const leg of ["receiver", "receiver-patch"]) {
      if (legs[leg].exit_code !== "0") problems.push(`${leg} exit ${legs[leg].exit_code}`);
      const applied = await readJson<{ result?: { class?: string }; errors?: unknown[] }>(
        join(out, leg, "applied.json"),
      );
      if (!applied) problems.push(`${leg}/applied.json missing`);
      for (const s of steps) {
        const d = await shotDiff(join(out, "reference"), join(out, leg), s.step);
        compared++;
        if (!d.present) problems.push(`${leg} step ${s.step}: shot missing`);
        else if (d.differing > 0)
          problems.push(`${leg} step ${s.step}: ${d.differing} px differ (max delta ${d.max_delta})`);
      }
    }
    for (const s of steps)
      hardware_band.push(await shotDiff(join(out, "reference"), join(out, "reference-hw"), s.step));
    checks.push(
      check(
        "decode-reference",
        "the native receiver on the decode capture's full and patch sinks draws every step exactly like the reference that draws the oracle's CPU-decoded payloads as plain textures (0 differing pixels); the hardware-sampled reference-hw is recorded beside it as an informative band",
        ran("receiver") && ran("reference") ? problems : null,
        `${compared} shots exact; reference-hw band ${hardware_band.map((d) => `step ${d.step}: ${d.differing} px, max ${d.max_delta}`).join(", ")}`,
      ),
    );
    checks.push({
      id: "decode-hardware-band",
      criterion: "informative (gate8-design.md Q3): the reference drawing the .ctex itself (GPU-sampled or GLES3's own CPU fallback) against the CPU-decoded reference",
      passed: true,
      status: "pass",
      gating: false,
      detail: hardware_band
        .map((d) => `step ${d.step}: ${d.present ? `${d.differing} px, max delta ${d.max_delta}` : "missing"}`)
        .join("; "),
    });
  }

  // --- perturb-decode: the oracle and the pixels must both catch it ------------------------
  {
    const dir = join(out, "sabotage-perturb-decode", "capture");
    const pairs = pairTextures(await fixtureTextures(dir), await hookTextureCreates(dir));
    const fromFrame =
      expected.start_frame + expected.step_frames * expected.perturb_from_step;
    const problems: string[] = [];
    let mismatched = 0;
    for (const p of pairs) {
      const decodedHere = p.hook?.source_format !== undefined;
      const bad = oracleProblems(p, oracle).length > 0;
      if (bad) mismatched++;
      if (decodedHere && p.fixture.frame >= fromFrame && !bad)
        problems.push(`${p.fixture.name}/${p.fixture.family}: perturbed payload still matches the oracle`);
      if (p.fixture.frame < fromFrame && bad)
        problems.push(`${p.fixture.name}/${p.fixture.family}: a payload before the sabotage frame mismatches`);
    }
    if (mismatched === 0) problems.push("the oracle caught nothing");
    for (const s of steps) {
      const d = await shotDiff(
        join(out, "reference"),
        join(out, "sabotage-perturb-decode", "receiver"),
        s.step,
      );
      const perturbed = s.step >= expected.perturb_from_step;
      if (!d.present) problems.push(`receiver step ${s.step}: shot missing`);
      else if (perturbed && d.differing === 0)
        problems.push(`receiver step ${s.step}: the perturbed texel is invisible`);
      else if (!perturbed && d.differing > 0)
        problems.push(`receiver step ${s.step}: ${d.differing} px differ before the sabotage`);
    }
    checks.push(
      check(
        "sabotage-perturb-decode",
        "perturb-decode (texel 0 inverted after the decode, before the hash, from step 1's frame) fails the oracle on exactly the textures decoded from that frame on and shows in the receiver's pixels from step 1, never before",
        ran("sabotage-perturb-decode/capture") ? problems : null,
        `${mismatched} payloads caught by the oracle`,
      ),
    );
  }

  // --- G8kw: texture workers (texture-delivery-design.md D11, Q7) ----------------------------
  const resolved = async (dir: string, name: string): Promise<{ rec?: ResolvedRecording; error?: string }> => {
    const path = join(dir, name);
    if (!existsSync(path)) return { error: `${name} missing` };
    const bytes = new Uint8Array(await readFile(path));
    const errors = validateRecording(bytes, 8);
    if (errors.length > 0) return { error: `invalid /8 ${name}: ${errors[0]}` };
    try {
      return { rec: resolveRecording(bytes, 8) };
    } catch (e) {
      return { error: `${name} does not resolve: ${(e as Error).message}` };
    }
  };
  const workerStats = async (dir: string): Promise<WorkerStats | null> => {
    const r = await readJson<{ stream?: { texture_workers?: WorkerStats; reason?: string | null } }>(
      join(dir, "evidence", "result.json"),
    );
    return r?.stream?.texture_workers ?? null;
  };
  const workersDir = join(out, "workers", "capture");
  let workersReport: G8tReport["workers"];
  {
    // worker-states-equal: the async recordings against the synchronous capture/ of the same run
    const problems: string[] = [];
    const cmp: { full: WorkerCompare | null; patch: WorkerCompare | null } = { full: null, patch: null };
    if (legs["workers/capture"].exit_code !== "0") problems.push(`workers/capture exit ${legs["workers/capture"].exit_code}`);
    for (const [key, name] of [["full", "recording.rs8"], ["patch", "recording-patch.rs8"]] as const) {
      const a = await resolved(capDir, name);
      const b = await resolved(workersDir, name);
      if (a.error || !a.rec) problems.push(`capture/${a.error}`);
      if (b.error || !b.rec) problems.push(`workers/capture/${b.error}`);
      if (!a.rec || !b.rec) continue;
      const c = compareWorkerRecordings(a.rec, b.rec);
      cmp[key] = c;
      problems.push(...c.problems.map((p) => `${name}: ${p}`));
    }
    const stats = await workerStats(workersDir);
    if (!stats) problems.push("workers/capture result.json has no stream.texture_workers");
    else {
      if (stats.workers !== 2) problems.push(`${stats.workers} workers, expected 2`);
      if (stats.jobs === 0 || stats.completed !== stats.jobs)
        problems.push(`${stats.completed}/${stats.jobs} jobs completed`);
      if (stats.held_callbacks === 0)
        problems.push("no callback was held back: the hold-back was never exercised");
    }
    if (cmp.full && cmp.full.held_frames.length === 0)
      problems.push("the async full recording held no frame back");
    workersReport = { ...cmp, stats };
    checks.push(
      check(
        "worker-states-equal",
        "G8kw: under GRC_TEXTURE_WORKERS=2 (every copy, decode and hash on a worker, each job delayed so publication must wait), both /8 sinks validate, every transaction equals the synchronous capture's transaction of the same frame state for state, held frames are only missing (never published early), and both end on the same frame and state",
        ran("workers/capture") && ran("capture") ? problems : null,
        `full: ${cmp.full?.async_transactions}/${cmp.full?.sync_transactions} transactions, ${cmp.full?.held_frames.length} frames held; patch: ${cmp.patch?.async_transactions}/${cmp.patch?.sync_transactions}; ${stats?.jobs} jobs, ${stats?.held_callbacks} held callbacks, lag <= ${stats?.max_lag_frames} frames`,
        "workers/capture",
      ),
    );
  }
  {
    // worker-hook-log: the hook log's texture lines are the synchronous ones, in order
    const problems: string[] = [];
    const a = maskedHookLog(await readText(join(capDir, "evidence", "resources.jsonl")));
    const b = maskedHookLog(await readText(join(workersDir, "evidence", "resources.jsonl")));
    if (a.texture.length === 0) problems.push("capture/ hook log has no lines");
    if (a.texture.length !== b.texture.length)
      problems.push(`${b.texture.length} texture lines, the synchronous log has ${a.texture.length}`);
    for (let i = 0; i < Math.min(a.texture.length, b.texture.length); i++)
      if (a.texture[i] !== b.texture[i]) {
        problems.push(`line ${i + 1} differs: ${b.texture[i].slice(0, 160)} vs ${a.texture[i].slice(0, 160)}`);
        break;
      }
    if (JSON.stringify(a.stores) !== JSON.stringify(b.stores))
      problems.push(`the stored hashes differ (${b.stores.length} vs ${a.stores.length})`);
    const creates = (await hookTextureCreates(workersDir)).filter((h) => h.status === "ok");
    const onWorker = creates.filter((h) => h.worker === true && typeof h.hook_ns === "number");
    if (onWorker.length !== creates.length)
      problems.push(`${creates.length - onWorker.length} of ${creates.length} ok creates were not worker copies`);
    checks.push(
      check(
        "worker-hook-log",
        "G8kw: the workers capture's hook log has the synchronous log's texture lines in the same order with the same facts and hashes (cost columns and the worker keys aside), the same stored payloads, and every ok create marked as a worker copy with its hook time",
        ran("workers/capture") && ran("capture") ? problems : null,
        `${b.texture.length} lines, ${onWorker.length} worker creates`,
        "workers/capture",
      ),
    );
  }
  {
    // sabotage-publish-before-ready: publishing without waiting must be caught
    const dir = join(out, "workers", "sabotage-publish-before-ready", "capture");
    const caught: string[] = [];
    const a = await resolved(capDir, "recording.rs8");
    const b = await resolved(dir, "recording.rs8");
    if (b.error) caught.push(b.error);
    if (a.rec && b.rec) caught.push(...compareWorkerRecordings(a.rec, b.rec).problems);
    const r = await readJson<{ stream?: { reason?: string | null } }>(join(dir, "evidence", "result.json"));
    if (r?.stream?.reason) caught.push(`stream: ${r.stream.reason}`);
    checks.push(
      check(
        "sabotage-publish-before-ready",
        "G8kw: the publish-before-ready fault (a snapshot naming a pending texture published at once, its hash all zeros) is caught: the recording no longer matches the synchronous one, or the publisher refuses the hash it has no payload for",
        ran("workers/sabotage-publish-before-ready/capture") && ran("capture")
          ? caught.length > 0
            ? []
            : ["the fault went unnoticed: the recording equals the synchronous one"]
          : null,
        `caught: ${caught.slice(0, 2).join("; ")}`,
        "workers/sabotage-publish-before-ready/capture",
      ),
    );
  }

  // --- G8k9: the /9 wire with an empty delivery seam (texture-delivery-design.md D4, Q5) ------
  {
    const dir = join(out, "delivery9", "capture");
    const problems: string[] = [];
    const exit = legs["delivery9/capture"].exit_code;
    if (exit !== "0") problems.push(`delivery9/capture exit ${exit}`);
    let variantsSeen = 0;
    let texturesSeen = 0;
    const strip = (state: unknown): unknown => {
      const s = state as { textures: Array<Record<string, unknown>> } & Record<string, unknown>;
      return { ...s, textures: s.textures.map(({ variants: _v, ...rest }) => rest) };
    };
    for (const [name, base] of [["recording.rs9", "recording.rs8"], ["recording-patch.rs9", "recording-patch.rs8"]] as const) {
      const path = join(dir, name);
      if (!existsSync(path)) {
        problems.push(`${name} missing`);
        continue;
      }
      const bytes = new Uint8Array(await readFile(path));
      if (wireVersionOf(bytes) !== 9) problems.push(`${name} does not start with GRS9`);
      const errors = validateRecording(bytes, 9);
      if (errors.length > 0) {
        problems.push(`${name} invalid at /9: ${errors[0]}`);
        continue;
      }
      const rec = resolveRecording(bytes, 9);
      const session = decodeRecording(bytes, 9).records[0].meta as unknown as {
        protocol: string;
        resources: { texture_delivery?: { mode: string; encoder: string | null } };
      };
      if (session.protocol !== "render-stream/9") problems.push(`${name} session protocol ${session.protocol}`);
      const declared = session.resources.texture_delivery;
      if (declared?.mode !== "rgba" || declared.encoder !== null)
        problems.push(`${name} declares ${JSON.stringify(declared)}, not {"mode":"rgba","encoder":null}`);
      for (const t of rec.transactions)
        for (const tex of t.state.textures) {
          texturesSeen++;
          variantsSeen += (tex.variants ?? []).length;
          if (!Array.isArray(tex.variants)) problems.push(`${name} seq ${t.seq}: texture ${tex.id} has no variants list`);
        }
      const reference = await resolved(capDir, base);
      if (reference.error || !reference.rec) {
        problems.push(`capture/${reference.error}`);
        continue;
      }
      const stripped: ResolvedRecording = {
        ...rec,
        transactions: rec.transactions.map((t) => ({ ...t, state: strip(t.state) as typeof t.state })),
      };
      problems.push(...compareWorkerRecordings(reference.rec, stripped).problems.map((p) => `${name}: ${p}`));
    }
    if (variantsSeen > 0) problems.push(`${variantsSeen} variants offered by an empty seam`);
    if (texturesSeen === 0) problems.push("no texture entry was seen");
    const r = await readJson<{ stream?: { gate8?: { file_stream_version?: number; texture_delivery?: string } } }>(
      join(dir, "evidence", "result.json"),
    );
    if (r?.stream?.gate8?.file_stream_version !== 9) problems.push(`result.json file_stream_version ${r?.stream?.gate8?.file_stream_version}`);
    if (r?.stream?.gate8?.texture_delivery !== "rgba")
      problems.push(`result.json texture_delivery ${r?.stream?.gate8?.texture_delivery}`);
    checks.push(
      check(
        "delivery-v9-wire",
        "G8k9: a /9 file sink (GRC_STREAM_VERSION=9, GRC_TEXTURE_DELIVERY=rgba since G8kp refuses the Basis modes) writes full and patch recordings that start GRS9, validate at /9 with the independent TypeScript decoder, declare resources.texture_delivery {rgba, encoder null}, and carry `variants: []` on every texture entry, because rgba offers none; stripped of that key every transaction equals the /8 capture of the same frame state for state",
        ran("delivery9/capture") && ran("capture") ? problems : null,
        `${texturesSeen} texture entries, none with a variant`,
        "delivery9/capture",
      ),
    );
  }

  // --- decode-cost (timing group; measured, no budget) -------------------------------------
  const decode_cost: CostRow[] = [];
  let hitch: G8tReport["hitch"] = null;
  {
    const timing = await readJson<OracleReport>(
      join(out, "decode-cost", "oracle-timing", "oracle.json"),
    );
    const dir = join(out, "decode-cost", "capture");
    const pairs = pairTextures(await fixtureTextures(dir), await hookTextureCreates(dir));
    const wdir = join(out, "decode-cost", "capture-workers");
    const workerPairs = pairTextures(await fixtureTextures(wdir), await hookTextureCreates(wdir));
    const workerProblems: string[] = [];
    const problems: string[] = [];
    for (const [name, tex] of Object.entries(expected.cost))
      for (const family of ["desktop", "mobile"] as const) {
        const fam = tex[family];
        const e = oracleEntry(timing, name, family);
        const p = pairs.find((x) => x.fixture.name === name && x.fixture.family === family);
        const h = p?.hook;
        const design = expected.design_cost[fam.source_format ?? ""];
        const ms = (ns: number | null | undefined) =>
          typeof ns === "number" && ns >= 0 ? ns / 1e6 : null;
        const row: CostRow = {
          name,
          source_format: fam.source_format ?? "",
          width: tex.width,
          height: tex.height,
          oracle_best_ms: e?.decompress_best_us !== undefined ? e.decompress_best_us / 1000 : null,
          oracle_mpx_per_s: e?.mpx_per_s ?? null,
          hook_decode_ms: ms(h?.decode_ns),
          hook_copy_ms: ms(h?.copy_ns),
          hook_hash_ms: ms(h?.hash_ns),
          hook_total_ms: null,
          thread: h?.thread ?? null,
          design_ms: typeof design === "object" ? design.ms : null,
          design_mpx_per_s: typeof design === "object" ? design.mpx_per_s : null,
        };
        if (row.hook_decode_ms !== null && row.hook_copy_ms !== null && row.hook_hash_ms !== null)
          row.hook_total_ms = row.hook_decode_ms + row.hook_copy_ms + row.hook_hash_ms;
        if (row.oracle_best_ms === null) problems.push(`${name}/${family}: no oracle timing`);
        if (row.hook_total_ms === null) problems.push(`${name}/${family}: no hook decode/copy/hash times`);
        if (h && h.status !== "ok") problems.push(`${name}/${family}: ${h.status}/${h.reason}`);
        if (p && oracleProblems(p, timing).length > 0)
          problems.push(`${name}/${family}: ${oracleProblems(p, timing)[0]}`);
        if (row.hook_total_ms !== null && row.thread === "main" && (hitch === null || row.hook_total_ms > hitch.total_ms))
          hitch = { name, source_format: row.source_format, total_ms: row.hook_total_ms };
        const w = workerPairs.find((x) => x.fixture.name === name && x.fixture.family === family)?.hook;
        row.workers_hook_ms = ms(w?.hook_ns);
        row.workers_dup_ms = ms(w?.dup_ns);
        row.workers_job_ms =
          ms(w?.copy_ns) !== null && ms(w?.hash_ns) !== null
            ? (ms(w?.copy_ns) ?? 0) + (ms(w?.hash_ns) ?? 0) + (ms(w?.decode_ns) ?? 0)
            : null;
        if (ran("decode-cost/capture-workers")) {
          if (!w) workerProblems.push(`${name}/${family}: no create in decode-cost/capture-workers`);
          else if (w.worker !== true || row.workers_hook_ms === null)
            workerProblems.push(`${name}/${family}: not a worker copy`);
          else if (w.thread !== "main") workerProblems.push(`${name}/${family}: created on ${w.thread}`);
          else if (row.workers_hook_ms > 2)
            workerProblems.push(`${name}/${family}: ${row.workers_hook_ms.toFixed(2)} ms on the calling thread (budget 2 ms)`);
          else if (w.hash !== p?.hook?.hash)
            workerProblems.push(`${name}/${family}: the worker's hash differs from the synchronous one`);
        }
        decode_cost.push(row);
      }
    checks.push(
      check(
        "decode-cost",
        "measured, no budget (gate8-design.md Q3): per cost format the best-of-3 Image.decompress time and Mpx/s on the release template, and the hook's own decode, copy and hash times with the largest calling-thread hitch",
        ran("decode-cost/capture") && ran("decode-cost/oracle-timing") ? problems : null,
        decode_cost
          .map((r) => `${r.source_format} ${r.oracle_best_ms?.toFixed(1)} ms (${r.oracle_mpx_per_s?.toFixed(0)} Mpx/s), hook ${r.hook_decode_ms?.toFixed(1)}+${r.hook_copy_ms?.toFixed(1)}+${r.hook_hash_ms?.toFixed(1)} ms`)
          .join("; "),
      ),
    );
    checks.push(
      check(
        "worker-hook-time",
        "G8kw (texture-delivery-design.md G8kw row): at GRC_TEXTURE_WORKERS=2 every 2048x2048 cost create costs the calling (main) thread at most 2 ms (facts, prediction, copy-on-write duplicate, hand-off, mirror), its decode/copy/hash run on a worker, and the worker's hash equals the synchronous capture's",
        ran("decode-cost/capture-workers") && ran("decode-cost/capture") ? workerProblems : null,
        decode_cost
          .map((r) => `${r.source_format} ${r.workers_hook_ms?.toFixed(3)} ms (dup ${r.workers_dup_ms?.toFixed(3)}; worker ${r.workers_job_ms?.toFixed(1)} ms)`)
          .join("; "),
        "decode-cost/capture-workers",
      ),
    );
  }
  return { checks, legs, decode_cost, hitch, hardware_band, workers: workersReport };
}
