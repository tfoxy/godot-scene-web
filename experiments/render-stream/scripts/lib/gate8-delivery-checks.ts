// Gate 8 group g8kp (G8kp, protocol/texture-delivery-design.md D1 `passthrough`, D3, Q3, Q6): the
// checks over the evidence run-gate8.sh's g8kp legs write. Pure functions of the evidence tree, so
// scripts/test/self-test-gate8.ts can drive them against fabricated trees.
//
//   import/, oracle/                    shared with g8t; oracle/ also holds each .ctex's block
//                                       bytes as <name>.<family>.block.grt1 (G8kp)
//   g8kp/capture/                       /9, GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=passthrough:
//                                       recording.rs9, recording-patch.rs9, store, evidence/
//   g8kp/workers/capture/               the same at GRC_TEXTURE_WORKERS=2
//   g8kp/refused-basis/capture/         GRC_TEXTURE_DELIVERY=basis-etc1s at /9: refused (G8ku)
//   g8kp/reference/ g8kp/reference-hw/  rendered fixture: the oracle's decoded payloads / the .ctex
//   g8kp/receiver{,-patch,-masked}/     the native receiver (masked: s3tc,bptc,rgtc)
//   g8kp/gsw-run/{gsw,gsw-masked,sabotage-ignore-format-mask/gsw}/
//                                       the GSW receiver on g8kp/receiver's own launch
//   g8kp/live/{host,receiver}/          a /9 passthrough live host and the rendered native
//                                       receiver at RS_RECEIVER_PROTOCOL=9 (received.rs9)

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  fixtureTextures,
  type G8tCheck,
  type G8tExpected,
  hookTextureCreates,
  type OracleEntry,
  type OracleReport,
  pairTextures,
  usedFamily,
} from "./gate8-tex-checks";
import {
  decodeRecording,
  type ResolvedRecording,
  resolveRecording,
  type TextureVariant,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

/** The families D3 needs in gpu_formats for a block variant (Godot's feature names, Q3). */
export const BLOCK_FAMILY: Readonly<Record<string, string>> = {
  DXT1: "s3tc",
  DXT3: "s3tc",
  DXT5: "s3tc",
  BPTC_RGBA: "bptc",
  RGTC_R: "rgtc",
  RGTC_RG: "rgtc",
  ETC: "etc2",
  ETC2_R11: "etc2",
  ETC2_R11S: "etc2",
  ETC2_RG11: "etc2",
  ETC2_RG11S: "etc2",
  ETC2_RGB8: "etc2",
  ETC2_RGBA8: "etc2",
  ETC2_RGB8A1: "etc2",
  ASTC_4x4: "astc",
  ASTC_8x8: "astc",
};

/** The texture-entry fields D3 reads. */
export interface DeliveryEntry {
  id: number;
  kind: string;
  status: string;
  hash: string | null;
  format: string | null;
  source_format?: string | null;
  variants?: TextureVariant[];
}

/**
 * texture-delivery-design.md D3, written independently of the receivers' Rust (rs-core
 * `delivery.rs`): the first encoding of `encodings` that the entry lists, `block` only when its
 * format's family is in `gpuFormats`, `uastc` whenever listed (G8ku), `decoded` (the base entry)
 * always last. Null for anything
 * but an ok image with a hash.
 */
export function predictD3(
  entry: DeliveryEntry,
  encodings: readonly string[],
  gpuFormats: readonly string[],
): { hash: string; encoding: "decoded" | "block" | "uastc" } | null {
  if (entry.kind !== "image" || entry.status !== "ok" || entry.hash === null)
    return null;
  for (const e of encodings) {
    if (e === "decoded") break;
    // G8ku: a receiver lists uastc only when it can transcode it, so a listed variant wins.
    if (e === "uastc") {
      const v = (entry.variants ?? []).find((x) => x.encoding === "uastc");
      if (v) return { hash: v.hash, encoding: "uastc" };
    }
    if (e === "block") {
      const v = (entry.variants ?? []).find(
        (x) =>
          x.encoding === "block" &&
          x.format !== null &&
          gpuFormats.includes(BLOCK_FAMILY[x.format] ?? ""),
      );
      if (v) return { hash: v.hash, encoding: "block" };
    }
  }
  return { hash: entry.hash, encoding: "decoded" };
}

/** What a receiver states (applied.json receiver.texture_delivery). */
export interface StatedDelivery {
  texture_encodings: string;
  gpu_formats: string;
  gpu_formats_detected?: string;
  gpu_format_mask?: string;
}

export interface UploadRow {
  id: number;
  hash: string | null;
  op: string;
  data_bytes: number;
  encoding?: string;
  stream?: number;
  seq?: number;
}

const list = (text: string | undefined): string[] =>
  text === undefined || text === "" || text === "none" ? [] : text.split(",");

/**
 * delivery-select over one receiver leg: every image upload is D3's choice for the entry at its
 * seq, under what the receiver STATES (its hello's keys); every ok image entry the recording names
 * was uploaded at least once; a masked leg states no masked family. Pure.
 */
export function deliverySelectProblems(
  leg: string,
  stated: StatedDelivery | undefined,
  uploads: readonly UploadRow[],
  rec: ResolvedRecording,
  mask: readonly string[],
): {
  problems: string[];
  block: number;
  decoded: number;
  blockFamilies: Record<string, number>;
} {
  const problems: string[] = [];
  let block = 0;
  let decoded = 0;
  const blockFamilies: Record<string, number> = {};
  if (!stated)
    return {
      problems: [`${leg}: applied.json states no receiver.texture_delivery`],
      block,
      decoded,
      blockFamilies,
    };
  const encodings = list(stated.texture_encodings);
  const gpu = list(stated.gpu_formats);
  for (const m of mask)
    if (gpu.includes(m))
      problems.push(
        `${leg}: states gpu_formats ${stated.gpu_formats} with ${m} masked`,
      );
  const bySeq = new Map(rec.transactions.map((t) => [t.seq, t]));
  const uploaded = new Set<number>();
  for (const u of uploads) {
    if (u.op !== "create" && u.op !== "update" && u.op !== "replace") continue;
    const tx = u.seq === undefined ? undefined : bySeq.get(u.seq);
    const entry = tx?.state.textures.find((t) => t.id === u.id) as
      | DeliveryEntry
      | undefined;
    if (!entry) {
      problems.push(
        `${leg}: upload of texture ${u.id} at seq ${u.seq} names no entry`,
      );
      continue;
    }
    uploaded.add(u.id);
    const want = predictD3(entry, encodings, gpu);
    const got = u.encoding ?? "decoded";
    if (got === "block") {
      block++;
      const v = (entry.variants ?? []).find((x) => x.hash === u.hash);
      const fam = (v?.format ? BLOCK_FAMILY[v.format] : undefined) ?? "unknown";
      blockFamilies[fam] = (blockFamilies[fam] ?? 0) + 1;
      if (mask.includes(fam))
        problems.push(
          `${leg}: texture ${u.id} uploaded a ${v?.format} block with ${fam} masked`,
        );
    } else decoded++;
    if (!want)
      problems.push(
        `${leg}: texture ${u.id} uploaded at seq ${u.seq} but is not an ok image`,
      );
    else if (want.hash !== u.hash || want.encoding !== got)
      problems.push(
        `${leg}: texture ${u.id} (seq ${u.seq}) uploaded ${got} ${u.hash?.slice(0, 12)}, D3 picks ${want.encoding} ${want.hash.slice(0, 12)}`,
      );
  }
  // Every entry offering a variant (the fixture's drawn block-source textures) was uploaded: a
  // receiver that never fetched one cannot pass by uploading nothing.
  for (const t of rec.transactions)
    for (const e of t.state.textures as DeliveryEntry[])
      if (
        e.status === "ok" &&
        (e.variants ?? []).length > 0 &&
        !uploaded.has(e.id)
      )
        problems.push(
          `${leg}: texture ${e.id} offering a variant (seq ${t.seq}) was never uploaded`,
        );
  return { problems: [...new Set(problems)], block, decoded, blockFamilies };
}

// ------------------------------------------------------------------------------- evidence I/O

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function check(
  id: string,
  criterion: string,
  problems: string[] | null,
  detailOk?: string,
  missing = "a leg did not run",
): G8tCheck {
  if (problems === null)
    // A failure naming the missing leg (lib/tier-verdict.py excuses exactly those of skipped legs).
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

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A leg's shot of `step`: shots/step-<k>.png (a fixture run) or shots/seq-<n>.png, n the k-th of
 * `seqs` (the settle seqs, the native receiver leg's shot-seqs.txt). */
export async function shot(
  dir: string,
  step: number,
  seqs: string[] | null,
): Promise<Rgba | undefined> {
  const path =
    seqs === null
      ? join(dir, "shots", `step-${step}.png`)
      : join(dir, "shots", `seq-${seqs[step]}.png`);
  if (!existsSync(path)) return undefined;
  const img = await decodePngRgba(path);
  if (!img) return undefined;
  return {
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data),
  };
}

function delta(a: Rgba, b: Rgba, i: number): number {
  let d = 0;
  for (let c = 0; c < 4; c++)
    d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
  return d;
}

/** Pixels differing, and the largest channel delta. */
export function diffShots(
  a: Rgba,
  b: Rgba,
): { differing: number; max: number } {
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = delta(a, b, i);
    if (d > 0) {
      differing++;
      max = Math.max(max, d);
    }
  }
  return { differing, max };
}

/**
 * The GSW side of D16's pixel claim for `block`: on the pixels where the GSW receiver's decoded
 * draw equals the native decoded reference (`decided`: where GSW rasterizes like Godot), the GSW
 * block draw against the native GPU-sampled reference-hw. Pure.
 */
export function gswBlockAgainstHw(
  gswBlock: Rgba,
  gswDecoded: Rgba,
  reference: Rgba,
  referenceHw: Rgba,
): {
  decided: number;
  exact: number;
  delta1: number;
  beyond: number;
  max: number;
} {
  const out = { decided: 0, exact: 0, delta1: 0, beyond: 0, max: 0 };
  for (let i = 0; i < gswBlock.data.length; i += 4) {
    if (delta(gswDecoded, reference, i) !== 0) continue;
    out.decided++;
    const d = delta(gswBlock, referenceHw, i);
    out.max = Math.max(out.max, d);
    if (d === 0) out.exact++;
    else if (d === 1) out.delta1++;
    else out.beyond++;
  }
  return out;
}

// ------------------------------------------------------------------------------- the group

export interface G8kpReport {
  checks: G8tCheck[];
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  select: Record<
    string,
    { block: number; decoded: number; stated: StatedDelivery | null }
  >;
  pixels: Record<string, unknown>;
}

const MASK = ["s3tc", "bptc", "rgtc"];

export async function runG8kp(
  out: string,
  expected: G8tExpected,
): Promise<G8kpReport> {
  const checks: G8tCheck[] = [];
  const g = (l: string) => join(out, "g8kp", l);
  const legDirs: Record<string, string> = {
    "import/fixture": join(out, "import", "fixture"),
    oracle: join(out, "oracle"),
    capture: g("capture"),
    "workers/capture": g("workers/capture"),
    "refused-basis/capture": g("refused-basis/capture"),
    reference: g("reference"),
    "reference-hw": g("reference-hw"),
    receiver: g("receiver"),
    "receiver-patch": g("receiver-patch"),
    "receiver-masked": g("receiver-masked"),
    gsw: g("gsw-run/gsw"),
    "gsw-masked": g("gsw-run/gsw-masked"),
    "sabotage-ignore-format-mask/gsw": g(
      "gsw-run/sabotage-ignore-format-mask/gsw",
    ),
    "live/host": g("live/host"),
    "live/receiver": g("live/receiver"),
  };
  const legs: G8kpReport["legs"] = {};
  for (const [l, dir] of Object.entries(legDirs)) {
    const code = await readText(join(dir, "exit-code.txt"));
    legs[l] = {
      exit_code: code === undefined ? null : code.trim(),
      skipped: skipped(dir),
    };
  }
  const ran = (l: string) =>
    legs[l].exit_code !== null && legs[l].skipped === null;
  const okExit = (l: string, problems: string[]) => {
    if (legs[l].exit_code !== "0")
      problems.push(`g8kp/${l} exit ${legs[l].exit_code}`);
  };
  const cap = legDirs.capture;
  const oracle = await readJson<OracleReport>(
    join(out, "oracle", "oracle.json"),
  );
  const oracleOf = (name: string, family: string) =>
    oracle?.textures.find((e) => e.name === name && e.family === family) as
      | (OracleEntry & {
          block_payload_sha256?: string | null;
          block_payload_bytes?: number | null;
        })
      | undefined;

  const recordings: Record<string, ResolvedRecording | undefined> = {};
  const readRec = async (
    dir: string,
    name: string,
    problems: string[],
  ): Promise<ResolvedRecording | undefined> => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name} missing`);
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(path));
    if (wireVersionOf(bytes) !== 9)
      problems.push(`${name} does not start with GRS9`);
    const errors = validateRecording(bytes, 9);
    if (errors.length > 0) {
      problems.push(`${name} invalid at /9: ${errors[0]}`);
      return undefined;
    }
    const session = decodeRecording(bytes, 9).records[0].meta as unknown as {
      resources: {
        texture_delivery?: { mode: string; encoder: string | null };
      };
    };
    const d = session.resources.texture_delivery;
    if (d?.mode !== "passthrough" || d.encoder !== null)
      problems.push(
        `${name} declares ${JSON.stringify(d)}, not {"mode":"passthrough","encoder":null}`,
      );
    return resolveRecording(bytes, 9);
  };

  // --- delivery-capture: the /9 passthrough wire --------------------------------------------
  {
    const problems: string[] = [];
    okExit("capture", problems);
    recordings.full = await readRec(cap, "recording.rs9", problems);
    recordings.patch = await readRec(cap, "recording-patch.rs9", problems);
    const r = await readJson<{
      stream?: {
        status?: string;
        gate8?: {
          texture_delivery?: string;
          delivery_stats?: Record<string, number>;
        };
      };
    }>(join(cap, "evidence", "result.json"));
    const stats = r?.stream?.gate8?.delivery_stats;
    if (r?.stream?.gate8?.texture_delivery !== "passthrough")
      problems.push(
        `result.json texture_delivery ${r?.stream?.gate8?.texture_delivery}`,
      );
    if (!stats || !(stats.block_built > 0))
      problems.push(
        `result.json delivery_stats ${JSON.stringify(stats)}: no block built`,
      );
    else if (stats.block_declined !== 0)
      problems.push(`delivery_stats.block_declined ${stats.block_declined}`);
    checks.push(
      check(
        "delivery-capture",
        "G8kp: a /9 capture under GRC_TEXTURE_DELIVERY=passthrough writes full and patch recordings that start GRS9, validate at /9 with the independent TypeScript validator (delivery-entry included), declare resources.texture_delivery {passthrough, encoder null}, and count the block payloads it built (stream.gate8.delivery_stats, none declined)",
        ran("capture") ? problems : null,
        `delivery_stats ${JSON.stringify(stats)}`,
        "g8kp/capture",
      ),
    );
  }

  // --- block-exact: each block variant is the .ctex's own block bytes -----------------------
  const blockByBase = new Map<string, TextureVariant[]>();
  {
    const problems: string[] = [];
    let blocks = 0;
    let plain = 0;
    const hook = await hookTextureCreates(cap);
    const fixture = await fixtureTextures(cap);
    const pairs = pairTextures(fixture, hook);
    const rec = recordings.full;
    const firstOk = (id: number): DeliveryEntry | undefined => {
      for (const t of rec?.transactions ?? []) {
        const e = t.state.textures.find((x) => x.id === id) as
          | DeliveryEntry
          | undefined;
        if (e && e.status === "ok") return e;
      }
      return undefined;
    };
    for (const t of rec?.transactions ?? [])
      for (const e of t.state.textures as DeliveryEntry[])
        if (e.hash !== null) blockByBase.set(e.hash, e.variants ?? []);
    if (!oracle) problems.push("oracle/oracle.json missing");
    if (pairs.length === 0)
      problems.push("no fixture texture was paired with a hook create");
    const covered = new Set<number>();
    for (const p of pairs) {
      const f = p.fixture;
      const name = `${f.name}/${f.family}`;
      const tex = expected.textures[f.name];
      if (!tex) continue;
      const fam = tex[f.family];
      if (fam.refused !== undefined) continue;
      if (!p.hook || p.hook.id === null) {
        problems.push(`${name}: no hook create paired`);
        continue;
      }
      const entry = firstOk(p.hook.id);
      if (!entry) {
        problems.push(
          `${name}: texture ${p.hook.id} never ok in the recording`,
        );
        continue;
      }
      covered.add(entry.id);
      const o = oracleOf(f.name, usedFamily(f));
      if (!o) {
        problems.push(`${name}: no oracle entry`);
        continue;
      }
      if (entry.hash !== o.payload_sha256)
        problems.push(
          `${name}: base hash ${entry.hash?.slice(0, 12)} is not the oracle's decoded ${o.payload_sha256?.slice(0, 12)}`,
        );
      const variants = entry.variants ?? [];
      if (!o.block_payload_sha256) {
        plain++;
        if (variants.length !== 0)
          problems.push(
            `${name}: ${variants.length} variants for a non-block source`,
          );
        continue;
      }
      blocks++;
      const v = variants.length === 1 ? variants[0] : undefined;
      if (!v || v.encoding !== "block") {
        problems.push(
          `${name}: variants ${JSON.stringify(variants)}, expected one block variant`,
        );
        continue;
      }
      if (v.hash !== o.block_payload_sha256)
        problems.push(
          `${name}: block hash ${v.hash.slice(0, 12)} is not the .ctex's ${o.block_payload_sha256.slice(0, 12)}`,
        );
      if (v.format !== o.source_format)
        problems.push(
          `${name}: block format ${v.format}, the .ctex is ${o.source_format}`,
        );
      if (v.payload_bytes !== o.block_payload_bytes)
        problems.push(
          `${name}: block payload_bytes ${v.payload_bytes} vs ${o.block_payload_bytes}`,
        );
      if (v.params !== null) problems.push(`${name}: block params ${v.params}`);
      const stored = join(cap, "store", "sha256", `${v.hash}.grt`);
      const ctex = join(out, "oracle", `${f.name}.${usedFamily(f)}.block.grt1`);
      if (!existsSync(stored))
        problems.push(`${name}: store has no ${v.hash.slice(0, 12)}.grt`);
      else if (!existsSync(ctex))
        problems.push(`${name}: oracle wrote no block payload`);
      else {
        const a = new Uint8Array(await readFile(stored));
        const b = new Uint8Array(await readFile(ctex));
        if (sha256(a) !== v.hash)
          problems.push(
            `${name}: the stored block payload does not hash to its name`,
          );
        if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0)
          problems.push(
            `${name}: the stored block payload is not the .ctex's bytes`,
          );
      }
    }
    for (const t of rec?.transactions ?? [])
      for (const e of t.state.textures as DeliveryEntry[])
        if (!covered.has(e.id) && (e.variants ?? []).length > 0)
          problems.push(
            `texture ${e.id} (not a fixture texture) carries variants`,
          );
    if (blocks === 0) problems.push("no block-source texture was checked");
    checks.push(
      check(
        "block-exact",
        "G8kp (D1 passthrough, render-stream-9.md \"Texture payload\"): every fixture texture whose .ctex holds a block format the host decodes (DXT1/5, BPTC, RGTC, ETC2, ASTC) carries exactly one `block` variant whose payload is that .ctex's own block bytes as GRT1 (hash, format, size and the store file equal the oracle's <name>.<family>.block.grt1), beside an unchanged `decoded` base (the oracle's decoded hash); the lossless control and engine textures carry none",
        ran("capture") && ran("oracle") ? [...new Set(problems)] : null,
        `${blocks} block variants exact, ${plain} non-block textures without variants`,
        "g8kp/capture",
      ),
    );
  }

  // --- delivery-workers: the worker path builds the same variants ----------------------------
  {
    const problems: string[] = [];
    okExit("workers/capture", problems);
    const rec = await readRec(
      legDirs["workers/capture"],
      "recording.rs9",
      problems,
    );
    let compared = 0;
    for (const t of rec?.transactions ?? [])
      for (const e of t.state.textures as DeliveryEntry[]) {
        if (e.hash === null) continue;
        const want = blockByBase.get(e.hash);
        if (want === undefined) continue;
        compared++;
        if (JSON.stringify(want) !== JSON.stringify(e.variants ?? []))
          problems.push(
            `texture ${e.id} (seq ${t.seq}): variants ${JSON.stringify(e.variants)} vs the synchronous ${JSON.stringify(want)}`,
          );
        for (const v of e.variants ?? [])
          if (
            !existsSync(
              join(
                legDirs["workers/capture"],
                "store",
                "sha256",
                `${v.hash}.grt`,
              ),
            )
          )
            problems.push(
              `texture ${e.id}: the workers store has no ${v.hash.slice(0, 12)}.grt`,
            );
      }
    if (compared === 0)
      problems.push("no workers texture matched a synchronous one");
    checks.push(
      check(
        "delivery-workers",
        "G8kp with G8kw's workers (GRC_TEXTURE_WORKERS=2, every copy delayed on a worker): every texture entry carries exactly the variants the synchronous capture gave the same decoded payload (the block bytes copied and hashed on the worker, published after it), and the store holds each",
        ran("workers/capture") && ran("capture")
          ? [...new Set(problems)]
          : null,
        `${compared} entries compared`,
        "g8kp/workers/capture",
      ),
    );
  }

  // --- delivery-refused: basis-etc1s is a typed refusal until G8ke (basis-uastc landed, G8ku) --
  {
    const problems: string[] = [];
    const r = await readJson<{ stream?: { status?: string; reason?: string } }>(
      join(legDirs["refused-basis/capture"], "evidence", "result.json"),
    );
    if (r?.stream?.status !== "refused")
      problems.push(`stream status ${r?.stream?.status}`);
    if (
      !(r?.stream?.reason ?? "").startsWith(
        "texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=basis-etc1s",
      )
    )
      problems.push(`stream reason ${JSON.stringify(r?.stream?.reason)}`);
    if (existsSync(join(legDirs["refused-basis/capture"], "recording.rs9"))) {
      const bytes = await readFile(
        join(legDirs["refused-basis/capture"], "recording.rs9"),
      );
      if (bytes.length > 8)
        problems.push(`a refused stream wrote ${bytes.length} recording bytes`);
    }
    checks.push(
      check(
        "delivery-refused",
        "G8kp: GRC_TEXTURE_DELIVERY=basis-etc1s at /9 refuses the stream with the typed reason texture-delivery-unimplemented (its encoder is G8ke's; basis-uastc is G8ku's, group g8ku), and writes no stream",
        ran("refused-basis/capture") ? problems : null,
        r?.stream?.reason,
        "g8kp/refused-basis/capture",
      ),
    );
  }

  // --- delivery-select: each receiver chose what D3 predicts --------------------------------
  const select: G8kpReport["select"] = {};
  const selectOf = async (l: string, mask: readonly string[]) => {
    const applied = await readJson<{
      receiver?: { texture_delivery?: StatedDelivery };
      uploads?: UploadRow[];
    }>(join(legDirs[l], "applied.json"));
    const rec = l === "receiver-patch" ? recordings.patch : recordings.full;
    if (!applied || !rec)
      return {
        problems: [`${l}: applied.json or the recording missing`],
        block: 0,
        decoded: 0,
        blockFamilies: {},
        stated: null,
      };
    const r = deliverySelectProblems(
      l,
      applied.receiver?.texture_delivery,
      applied.uploads ?? [],
      rec,
      mask,
    );
    return { ...r, stated: applied.receiver?.texture_delivery ?? null };
  };
  {
    const problems: string[] = [];
    const legsChecked = [
      "receiver",
      "receiver-patch",
      "receiver-masked",
      "gsw",
      "gsw-masked",
    ];
    for (const l of legsChecked) {
      okExit(l, problems);
      const masked = l.endsWith("-masked");
      const r = await selectOf(l, masked ? MASK : []);
      select[l] = { block: r.block, decoded: r.decoded, stated: r.stated };
      problems.push(...r.problems);
      // A masked leg may still upload a family it did not mask (ASTC on llvmpipe's GL, which has
      // it); a BC block there is refused per upload (deliverySelectProblems' mask).
      const bc = MASK.reduce((n, f) => n + (r.blockFamilies[f] ?? 0), 0);
      if (!masked && bc === 0)
        problems.push(
          `${l}: no BC block upload (gpu_formats ${r.stated?.gpu_formats})`,
        );
    }
    checks.push(
      check(
        "delivery-select",
        "G8kp (D3): on the native receiver (full and patch sinks, and with s3tc,bptc,rgtc masked) and the GSW receiver (as is, and masked), every texture upload is the payload D3 picks from the entry's variants under the receiver's own stated texture_encodings and gpu_formats (decoded last; block only for a family stated), every entry offering a variant is uploaded, an unmasked desktop receiver uploads `block` for the BC sources, and a masked one states no masked family and uploads no block of one (a family it did not mask, such as ASTC on a GL that has it, may still be `block`)",
        legsChecked.every(ran) && recordings.full
          ? [...new Set(problems)]
          : null,
        legsChecked
          .map(
            (l) =>
              `${l}: ${select[l].block} block, ${select[l].decoded} decoded (gpu_formats ${select[l].stated?.gpu_formats})`,
          )
          .join("; "),
        legsChecked
          .filter((l) => !ran(l))
          .map((l) => `g8kp/${l}`)
          .join(", ") || "the recording",
      ),
    );
  }
  {
    const l = "sabotage-ignore-format-mask/gsw";
    const r = ran(l) && recordings.full ? await selectOf(l, MASK) : null;
    if (r) select[l] = { block: r.block, decoded: r.decoded, stated: r.stated };
    checks.push(
      check(
        "sabotage-ignore-format-mask",
        "G8kp sabotage: a GSW receiver that states the masked gpu_formats but picks variants as if nothing were masked (ignore-format-mask) fails delivery-select's predicate (block uploads where D3 under its own hello picks decoded)",
        r === null
          ? null
          : r.problems.length > 0 && r.block > 0
            ? []
            : [
                `the sabotage went unnoticed (${r.block} block uploads, ${r.problems.length} problems)`,
              ],
        r
          ? `caught: ${r.problems.length} wrong choices, e.g. ${r.problems[0]}`
          : undefined,
        `g8kp/${l}`,
      ),
    );
  }

  // --- delivery-live: the /9 hello and HTTP delivery of the chosen variants ----------------
  {
    const problems: string[] = [];
    okExit("live/host", problems);
    okExit("live/receiver", problems);
    const summary = await readJson<{
      connections?: Array<Record<string, unknown>>;
    }>(join(legDirs["live/host"], "evidence", "live-summary.json"));
    const applied = await readJson<{
      receiver?: { protocol?: string; texture_delivery?: StatedDelivery };
      uploads?: UploadRow[];
      fetches?: Array<{ hash?: string }>;
    }>(join(legDirs["live/receiver"], "applied.json"));
    const conn = summary?.connections?.[0];
    const stated = applied?.receiver?.texture_delivery;
    let blocks = 0;
    if (!conn) problems.push("live-summary.json names no connection");
    else {
      if (conn.version !== 9)
        problems.push(`the connection speaks /${conn.version}, not /9`);
      if (
        conn.texture_encodings !== stated?.texture_encodings ||
        conn.gpu_formats !== stated?.gpu_formats
      )
        problems.push(
          `the host recorded texture_encodings ${conn.texture_encodings} / gpu_formats ${conn.gpu_formats}, the receiver states ${stated?.texture_encodings} / ${stated?.gpu_formats}`,
        );
    }
    if (applied?.receiver?.protocol !== "render-stream/9")
      problems.push(`receiver protocol ${applied?.receiver?.protocol}`);
    const received = join(legDirs["live/receiver"], "received.rs9");
    if (!existsSync(received)) problems.push("received.rs9 missing");
    else if (applied) {
      const bytes = new Uint8Array(await readFile(received));
      const errors = validateRecording(bytes, 9);
      if (errors.length > 0)
        problems.push(`received.rs9 invalid at /9: ${errors[0]}`);
      else {
        const r = deliverySelectProblems(
          "live/receiver",
          stated,
          applied.uploads ?? [],
          resolveRecording(bytes, 9),
          [],
        );
        problems.push(...r.problems);
        blocks = r.block;
        if (r.block === 0)
          problems.push(
            `no block upload over the live connection (gpu_formats ${stated?.gpu_formats})`,
          );
        const fetched = new Set((applied.fetches ?? []).map((f) => f.hash));
        for (const u of applied.uploads ?? [])
          if (u.encoding === "block" && !fetched.has(u.hash ?? ""))
            problems.push(
              `block ${u.hash?.slice(0, 12)} was not fetched over HTTP`,
            );
      }
    }
    checks.push(
      check(
        "delivery-live",
        "G8kp: a native receiver at RS_RECEIVER_PROTOCOL=9 offers render-stream.9 and its hello carries texture_encodings and gpu_formats (the host's live summary records exactly what the receiver states); over that connection it uploads D3's choice for every texture (received.rs9 validates at /9), fetching each `block` variant over HTTP like any payload",
        ran("live/host") && ran("live/receiver")
          ? [...new Set(problems)]
          : null,
        `hello ${stated?.texture_encodings} / ${stated?.gpu_formats}; ${blocks} block uploads fetched over HTTP`,
        "g8kp/live",
      ),
    );
  }

  // --- pixels: block against the GPU-sampled .ctex reference ------------------------------
  const pixels: Record<string, unknown> = {};
  {
    const problems: string[] = [];
    const seqsText = await readText(join(legDirs.receiver, "shot-seqs.txt"));
    const seqs = seqsText ? seqsText.trim().split(",") : null;
    const patchSeqsText = await readText(
      join(legDirs["receiver-patch"], "shot-seqs.txt"),
    );
    const patchSeqs = patchSeqsText ? patchSeqsText.trim().split(",") : null;
    for (const s of expected.steps) {
      const ref = await shot(legDirs.reference, s.step, null);
      const hw = await shot(legDirs["reference-hw"], s.step, null);
      if (!ref || !hw) {
        problems.push(`step ${s.step}: a reference shot is missing`);
        continue;
      }
      const band = diffShots(ref, hw);
      pixels[`hw-band/step-${s.step}`] = band;
      for (const [l, against, ss] of [
        ["receiver", hw, seqs],
        ["receiver-patch", hw, patchSeqs],
        ["receiver-masked", ref, seqs],
      ] as const) {
        const got = ss ? await shot(legDirs[l], s.step, ss) : undefined;
        if (!got) {
          problems.push(`${l} step ${s.step}: shot missing`);
          continue;
        }
        const d = diffShots(against, got);
        pixels[`${l}/step-${s.step}`] = d;
        if (d.differing > 0)
          problems.push(
            `${l} step ${s.step}: ${d.differing} px differ from ${against === hw ? "reference-hw" : "reference"} (max ${d.max})`,
          );
      }
    }
    checks.push(
      check(
        "delivery-pixels-native",
        "G8kp: the native receiver drawing D3's `block` variants (full and patch sinks) equals reference-hw, the fixture drawing the .ctex itself on the same GPU, exactly at every step (0 px); with BC masked it draws `decoded` and equals the CPU-decoded reference exactly",
        [
          "receiver",
          "receiver-patch",
          "receiver-masked",
          "reference",
          "reference-hw",
        ].every(ran)
          ? problems
          : null,
        Object.entries(pixels)
          .map(([k, v]) => `${k}: ${(v as { differing: number }).differing} px`)
          .join(", "),
        "g8kp/receiver or a reference",
      ),
    );
  }
  {
    const problems: string[] = [];
    const seqsText = await readText(join(legDirs.receiver, "shot-seqs.txt"));
    const seqs = seqsText ? seqsText.trim().split(",") : null;
    const rows: string[] = [];
    for (const s of expected.steps) {
      const ref = await shot(legDirs.reference, s.step, null);
      const hw = await shot(legDirs["reference-hw"], s.step, null);
      const gb = seqs ? await shot(legDirs.gsw, s.step, seqs) : undefined;
      const gd = seqs
        ? await shot(legDirs["gsw-masked"], s.step, seqs)
        : undefined;
      if (!ref || !hw || !gb || !gd) {
        problems.push(`step ${s.step}: a shot is missing`);
        continue;
      }
      const r = gswBlockAgainstHw(gb, gd, ref, hw);
      const own = diffShots(gd, gb);
      pixels[`gsw/step-${s.step}`] = { ...r, against_gsw_decoded: own };
      rows.push(
        `step ${s.step}: ${r.decided} decided px, ${r.exact} exact, ${r.delta1} at delta 1, ${r.beyond} beyond; gsw block vs gsw decoded ${own.differing} px (max ${own.max})`,
      );
      if (r.decided < (gb.width * gb.height) / 2)
        problems.push(`step ${s.step}: only ${r.decided} decided pixels`);
      if (r.beyond > 0)
        problems.push(
          `step ${s.step}: ${r.beyond} decided px differ from reference-hw by more than 1 (max ${r.max})`,
        );
      const blockStep = (select.gsw?.block ?? 0) > 0 && s.family === "desktop";
      if (!blockStep && own.differing > 0)
        problems.push(
          `step ${s.step}: no block drawn, yet gsw differs from gsw-masked by ${own.differing} px`,
        );
    }
    checks.push(
      check(
        "delivery-pixels-gsw",
        "G8kp: the GSW receiver drawing D3's `block` variants matches reference-hw (the .ctex sampled by the same GPU through Godot's GLES3) on every pixel where GSW's decoded draw equals the CPU-decoded reference, within channel delta 1 (hardware-decoded texels are not 8-bit values; the two pipelines round them once each), and a step that draws no block equals the masked (decoded) GSW leg exactly",
        ["gsw", "gsw-masked", "reference", "reference-hw", "receiver"].every(
          ran,
        )
          ? problems
          : null,
        rows.join("; "),
        "g8kp/gsw-run/gsw or gsw-masked",
      ),
    );
  }
  return { checks, legs, select, pixels };
}
