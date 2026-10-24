// Gate 8 group g8ku (G8ku, protocol/texture-delivery-design.md D1 `basis-uastc`, D6, D12, D13,
// D14, D16): the checks over the evidence run-gate8.sh's g8ku legs write. Pure functions of the
// evidence tree (fixtures/gate8-basis/expected.json names what each texture must get).
//
//   g8ku/capture/                       /9 basis-uastc, GRC_TEXTURE_ENCODE_WAIT_FRAME=12: recording.rs9,
//                                       recording-patch.rs9, store (<hash>.grt and <hash>.ktx2), evidence/
//   g8ku/workers/capture/               the same at GRC_TEXTURE_WORKERS=2
//   g8ku/sabotage-perturb-ktx2/{capture,receiver}/
//                                       one KTX2 byte flipped after hashing; the receiver must refuse
//   g8ku/pending/{capture,receiver}/    (G8kf) the workers capture at GRC_TEXTURE_PENDING=publish: a
//                                       texture whose worker is not done is published as
//                                       `delivery-pending` and returns as ok at the next version
//   g8ku/sabotage-corrupt-ktx2/{capture,receiver}/
//                                       (G8kf) level 0 of each KTX2 damaged BEFORE hashing, so every
//                                       hash and header check passes and only the transcode fails;
//                                       the receiver (upgrade) must fall back to `decoded`
//   g8ku/reference/                     the procedural fixture, rendered
//   g8ku/reference-oracle/              every stored KTX2 through Image.load_ktx_from_buffer on this
//                                       GPU (oracle/oracle.json, oracle/<hash>.rgba), drawn from step 1
//   g8ku/reference-oracle-hw/           the same, drawing the oracle's transcoded blocks (GPU-sampled)
//   g8ku/receiver/ g8ku/receiver-upgrade/
//                                       the native receiver, D6 keep and upgrade
//   g8ku/live/{host,receiver}/          a /9 basis-uastc live host (no wait knob) and the receiver;
//                                       live/host/ktx2-get.* is one KTX2 GET with Accept-Encoding: zstd
//   g8ku-web/web/                       the web export on receiver-upgrade's launch (its harness root
//                                       beside g8ku/, linking g8ku/ alone)
//   g8ku-web/web-fallback/              (G8kf) the web export on sabotage-corrupt-ktx2/receiver's
//   g8ku-web/web-pending/               (G8kf) the web export on pending/receiver's

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  check,
  diffShots,
  readJson,
  readText,
  sha256,
  shot,
  skipped,
} from "./gate8-delivery-checks";
import type { G8tCheck } from "./gate8-tex-checks";
import {
  checkKtx2Shape,
  decodeKtx2Payload,
  decodeRecording,
  decodeTexturePayload,
  type ResolvedRecording,
  type ResolvedTexture,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

export interface G8kuTextureExpected {
  name: string;
  width: number;
  height: number;
  uastc: boolean;
  mipmaps?: boolean;
  decline?: "small" | "format" | "updated";
  keep: "decoded" | "block" | "uastc";
  upgrade: "decoded" | "block" | "uastc";
}

export interface G8kuExpected {
  schema: "g8ku-expected/1";
  wait_frame: number;
  params: string;
  encoder: string;
  psnr_floor_db: number;
  steps: Array<{ step: number }>;
  textures: G8kuTextureExpected[];
}

interface OracleRow {
  hash: string;
  name?: string;
  hash_ok: boolean;
  error: number;
  format?: number;
  width?: number;
  height?: number;
  mipmaps?: boolean;
  data_bytes?: number;
  data_sha256?: string;
  transcode_us: number;
}

interface TranscodeRow {
  hash: string;
  ok: boolean;
  format: number;
  width: number;
  height: number;
  mipmaps: boolean;
  data_bytes: number;
  ktx2_bytes: number;
  transcode_us: number;
  data_sha256?: string;
  seq?: number;
}

interface Applied {
  status?: string;
  failure?: { code?: string; detail?: string; error?: string } | string | null;
  uploads?: Array<{
    id: number;
    hash: string;
    op: string;
    encoding?: string;
    seq?: number;
  }>;
  transcodes?: TranscodeRow[];
  variant_fallbacks?: Array<{ stream: number; seq: number; hash: string }>;
  receiver?: {
    texture_delivery?: { texture_encodings: string; variant_policy?: string };
  };
}

export interface G8kuReport {
  checks: G8tCheck[];
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  quality: Record<string, unknown>;
  transcodes: Record<string, unknown>;
  pixels: Record<string, unknown>;
}

/** The textures of a state, named by their fixture shape (every fixture shape is distinct). */
function named(
  textures: ResolvedTexture[],
  expected: G8kuExpected,
): Map<string, ResolvedTexture> {
  const out = new Map<string, ResolvedTexture>();
  for (const t of textures) {
    if (t.kind !== "image") continue;
    const e = expected.textures.find(
      (x) => x.width === t.width && x.height === t.height,
    );
    if (e) out.set(e.name, t);
  }
  return out;
}

const uastcOf = (t: ResolvedTexture | undefined) =>
  t?.variants?.find((v) => v.encoding === "uastc");

/** PSNR (dB) over RGBA of two equal-length RGBA8 buffers; 99 when identical. */
export function psnrRgba(a: Uint8Array, b: Uint8Array): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  if (se === 0) return 99;
  return 10 * Math.log10((255 * 255) / (se / a.length));
}

/** Level 0 of a decoded GRT1 payload (RGBA8 or RGB8) as RGBA8. */
function level0Rgba(
  format: string,
  width: number,
  height: number,
  data: Uint8Array,
): Uint8Array | undefined {
  const n = width * height;
  if (format === "RGBA8") return data.subarray(0, n * 4);
  if (format !== "RGB8") return undefined;
  const out = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    out[p * 4] = data[p * 3];
    out[p * 4 + 1] = data[p * 3 + 1];
    out[p * 4 + 2] = data[p * 3 + 2];
    out[p * 4 + 3] = 255;
  }
  return out;
}

function failureText(a: Applied | undefined): string {
  if (!a?.failure) return "";
  return typeof a.failure === "string" ? a.failure : JSON.stringify(a.failure);
}

export async function runG8ku(
  out: string,
  expected: G8kuExpected,
): Promise<G8kuReport> {
  const checks: G8tCheck[] = [];
  const g = (l: string) => join(out, "g8ku", l);
  const legDirs: Record<string, string> = {
    capture: g("capture"),
    "workers/capture": g("workers/capture"),
    "sabotage-perturb-ktx2/capture": g("sabotage-perturb-ktx2/capture"),
    "sabotage-perturb-ktx2/receiver": g("sabotage-perturb-ktx2/receiver"),
    "pending/capture": g("pending/capture"),
    "pending/receiver": g("pending/receiver"),
    "sabotage-corrupt-ktx2/capture": g("sabotage-corrupt-ktx2/capture"),
    "sabotage-corrupt-ktx2/receiver": g("sabotage-corrupt-ktx2/receiver"),
    reference: g("reference"),
    "reference-oracle": g("reference-oracle"),
    "reference-oracle-hw": g("reference-oracle-hw"),
    receiver: g("receiver"),
    "receiver-upgrade": g("receiver-upgrade"),
    "live/host": g("live/host"),
    "live/receiver": g("live/receiver"),
    web: join(out, "g8ku-web", "web"),
    "web-fallback": join(out, "g8ku-web", "web-fallback"),
    "web-pending": join(out, "g8ku-web", "web-pending"),
  };
  const legs: G8kuReport["legs"] = {};
  for (const [l, dir] of Object.entries(legDirs)) {
    const code = await readText(join(dir, "exit-code.txt"));
    legs[l] = {
      exit_code: code === undefined ? null : code.trim(),
      skipped: skipped(dir),
    };
  }
  const ran = (l: string) =>
    legs[l].exit_code !== null && legs[l].skipped === null;
  const quality: Record<string, unknown> = {};
  const transcodes: Record<string, unknown> = {};
  const pixels: Record<string, unknown> = {};

  const readRec = async (
    dir: string,
    name: string,
    problems: string[],
  ): Promise<ResolvedRecording | undefined> => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name} missing in ${dir}`);
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
    if (d?.mode !== "basis-uastc" || d.encoder !== expected.encoder)
      problems.push(
        `${name} declares ${JSON.stringify(d)}, not {"mode":"basis-uastc","encoder":"${expected.encoder}"}`,
      );
    return resolveRecording(bytes, 9);
  };
  const lastState = (rec: ResolvedRecording) =>
    rec.transactions[rec.transactions.length - 1].state;
  const idNames = new Map<number, string>();

  // --- basis-capture: the /9 basis-uastc session and its counters ----------------------------
  let rec: ResolvedRecording | undefined;
  {
    const problems: string[] = [];
    if (legs.capture.exit_code !== "0")
      problems.push(`capture exit ${legs.capture.exit_code}`);
    rec = await readRec(legDirs.capture, "recording.rs9", problems);
    await readRec(legDirs.capture, "recording-patch.rs9", problems);
    const result = await readJson<{
      stream?: {
        gate8?: {
          texture_delivery?: string;
          delivery_stats?: Record<string, number>;
        };
      };
    }>(join(legDirs.capture, "evidence", "result.json"));
    const stats = result?.stream?.gate8?.delivery_stats;
    const wantUastc = expected.textures.filter((t) => t.uastc).length;
    if (result?.stream?.gate8?.texture_delivery !== "basis-uastc")
      problems.push(
        `result.json texture_delivery ${result?.stream?.gate8?.texture_delivery}`,
      );
    if (!stats) problems.push("result.json has no delivery_stats");
    else {
      if (stats.uastc_built !== wantUastc)
        problems.push(
          `uastc_built ${stats.uastc_built}, expected ${wantUastc}`,
        );
      if (stats.uastc_failed !== 0)
        problems.push(`uastc_failed ${stats.uastc_failed}`);
      for (const r of ["updated", "format", "small"] as const)
        if (
          (stats[`uastc_declined_${r}`] ?? 0) <
          expected.textures.filter((t) => t.decline === r).length
        )
          problems.push(`uastc_declined_${r} ${stats[`uastc_declined_${r}`]}`);
    }
    if (rec)
      for (const [n, t] of named(lastState(rec).textures, expected))
        idNames.set(t.id, n);
    checks.push(
      check(
        "basis-capture",
        "G8ku: a /9 capture under GRC_TEXTURE_DELIVERY=basis-uastc validates (full and patch sinks), declares {mode basis-uastc, encoder basisu-1.60}, and counts one uastc variant per D12-eligible texture and the typed declines (updated, format, small) in stream.gate8.delivery_stats",
        ran("capture") ? problems : null,
        stats
          ? `uastc_built ${stats.uastc_built}, ${stats.uastc_bytes} B, encode ${stats.encode_us_total} us total (max ${stats.encode_us_max} us) over ${stats.encode_px_total} px`
          : undefined,
        "g8ku/capture",
      ),
    );
  }

  // --- ktx2-wire: the variant entries, the stored KTX2 files and one HTTP GET -----------------
  {
    const problems: string[] = [];
    if (rec) {
      const byName = named(lastState(rec).textures, expected);
      for (const e of expected.textures) {
        const t = byName.get(e.name);
        if (!t) {
          problems.push(`${e.name}: no texture entry`);
          continue;
        }
        const v = uastcOf(t);
        if (!e.uastc) {
          if (v)
            problems.push(
              `${e.name}: a uastc variant D12 refuses (${e.decline})`,
            );
          continue;
        }
        if (!v) {
          problems.push(`${e.name}: no uastc variant`);
          continue;
        }
        if (v.params !== expected.params)
          problems.push(`${e.name}: params ${v.params}`);
        if (v.format !== null)
          problems.push(`${e.name}: uastc format ${v.format}`);
        const path = join(legDirs.capture, "store", "sha256", `${v.hash}.ktx2`);
        if (!existsSync(path)) {
          problems.push(`${e.name}: the store has no ${v.hash}.ktx2`);
          continue;
        }
        const bytes = new Uint8Array(await readFile(path));
        if (sha256(bytes) !== v.hash)
          problems.push(`${e.name}: ${v.hash}.ktx2 does not hash to its name`);
        if (bytes.length !== v.payload_bytes)
          problems.push(
            `${e.name}: ${bytes.length} B stored, payload_bytes ${v.payload_bytes}`,
          );
        try {
          const k = decodeKtx2Payload(bytes);
          const shape = checkKtx2Shape(
            k,
            "uastc",
            t.width,
            t.height,
            t.mipmaps,
          );
          if (shape) problems.push(`${e.name}: ${shape}`);
          if (k.supercompression !== 2)
            problems.push(`${e.name}: supercompression ${k.supercompression}`);
          if (Boolean(e.mipmaps) !== t.mipmaps || (e.mipmaps && k.levels < 2))
            problems.push(
              `${e.name}: mipmaps ${t.mipmaps}, ${k.levels} levels`,
            );
        } catch (err) {
          problems.push(`${e.name}: ${(err as Error).message}`);
        }
      }
      const index =
        (await readText(join(legDirs.capture, "store", "index.jsonl"))) ?? "";
      const ktxLines = index
        .split("\n")
        .filter((l) => l.includes('"type":"texture-ktx2"'));
      if (ktxLines.length !== expected.textures.filter((t) => t.uastc).length)
        problems.push(
          `the store index has ${ktxLines.length} texture-ktx2 lines`,
        );
    }
    // One GET of a stored KTX2 from the live host, asking for zstd: image/ktx2, identity.
    let http = "no live GET";
    const headers = await readText(
      join(legDirs["live/host"], "ktx2-get.headers"),
    );
    const getHash = (
      await readText(join(legDirs["live/host"], "ktx2-get.hash"))
    )?.trim();
    if (ran("live/host")) {
      if (!headers || !getHash)
        problems.push(
          `live KTX2 GET missing (${(await readText(join(legDirs["live/host"], "ktx2-get.error")))?.trim() ?? "no evidence"})`,
        );
      else {
        const lower = headers.toLowerCase();
        if (!/^http\/1\.1 200/m.test(lower))
          problems.push(`live KTX2 GET: ${headers.split("\n")[0]}`);
        if (!lower.includes("content-type: image/ktx2"))
          problems.push("live KTX2 GET: Content-Type is not image/ktx2");
        if (lower.includes("content-encoding:"))
          problems.push("live KTX2 GET: the body is content-coded");
        const body = new Uint8Array(
          await readFile(join(legDirs["live/host"], "ktx2-get.body")),
        );
        if (sha256(body) !== getHash)
          problems.push("live KTX2 GET: the body does not hash to its name");
        http = `GET ${getHash.slice(0, 12)}…: 200, image/ktx2, identity, ${body.length} B`;
      }
    }
    checks.push(
      check(
        "ktx2-wire",
        'G8ku (render-stream-9.md "KTX2 payload"): every D12-eligible texture lists one uastc variant (format null, params basisu-1.60/uastc-l1/zstd6/linear) whose store file <hash>.ktx2 hashes to its name, has its payload_bytes and parses as the profile (UASTC + Zstandard, linear, the entry\'s size and mip chain); no other texture lists one; a live GET with Accept-Encoding: zstd returns image/ktx2, never content-coded',
        ran("capture") ? problems : null,
        http,
        "g8ku/capture",
      ),
    );
  }

  // --- delivery-lazy: D6, the variant at an equal version (exact under the wait knob) ---------
  const variantSeq = new Map<string, number>();
  {
    const problems: string[] = [];
    const lazy = async (
      dir: string,
      name: string,
      exact: boolean,
      label: string,
    ) => {
      const r = await readRec(dir, name, problems);
      if (!r) return;
      const prev = new Map<number, ResolvedTexture>();
      const seen = new Set<string>();
      for (const tx of r.transactions) {
        const byName = named(tx.state.textures, expected);
        for (const e of expected.textures) {
          const t = byName.get(e.name);
          if (!t) continue;
          const v = uastcOf(t);
          const before = prev.get(t.id);
          // D12(a): an updated texture never lists one after its update (before it, at version 1,
          // the live host may already have published one: it was not updated yet).
          if (v && !e.uastc && (e.decline !== "updated" || t.version > 1))
            problems.push(
              `${label} ${e.name}: a uastc variant at seq ${tx.seq} (version ${t.version})`,
            );
          if (v && e.uastc && !seen.has(e.name)) {
            seen.add(e.name);
            if (label === "capture") variantSeq.set(e.name, tx.seq);
            if (exact && tx.frame !== expected.wait_frame)
              problems.push(
                `${label} ${e.name}: the uastc variant first at frame ${tx.frame}, not ${expected.wait_frame}`,
              );
            if (!before)
              problems.push(
                `${label} ${e.name}: the uastc variant arrived with the entry (not lazily)`,
              );
            else {
              if (before.version !== t.version)
                problems.push(
                  `${label} ${e.name}: version ${before.version} -> ${t.version} when the variant appeared`,
                );
              const rest = (t.variants ?? []).filter(
                (x) => x.encoding !== "uastc",
              );
              if (
                JSON.stringify(rest) !== JSON.stringify(before.variants ?? [])
              )
                problems.push(
                  `${label} ${e.name}: the earlier variants changed when uastc appeared`,
                );
              if (before.hash !== t.hash)
                problems.push(`${label} ${e.name}: the base hash changed`);
            }
          }
          prev.set(t.id, t);
        }
      }
      for (const e of expected.textures)
        if (e.uastc && !seen.has(e.name))
          problems.push(`${label} ${e.name}: never a uastc variant`);
      const fin = named(lastState(r).textures, expected).get("updated");
      if (fin && fin.version < 2)
        problems.push(`${label} updated: final version ${fin.version}`);
    };
    await lazy(legDirs.capture, "recording.rs9", true, "capture");
    await lazy(legDirs.capture, "recording-patch.rs9", true, "capture-patch");
    if (ran("workers/capture"))
      await lazy(legDirs["workers/capture"], "recording.rs9", true, "workers");
    if (ran("live/host"))
      await lazy(legDirs["live/host"], "recording.rs9", false, "live");
    // The workers capture's encodes are the synchronous capture's (the encoder is deterministic).
    if (rec && ran("workers/capture")) {
      const w = await readRec(
        legDirs["workers/capture"],
        "recording.rs9",
        problems,
      );
      if (w) {
        const a = named(lastState(rec).textures, expected);
        const b = named(lastState(w).textures, expected);
        for (const e of expected.textures)
          if (uastcOf(a.get(e.name))?.hash !== uastcOf(b.get(e.name))?.hash)
            problems.push(`workers ${e.name}: a different uastc hash`);
      }
    }
    checks.push(
      check(
        "delivery-lazy",
        "G8ku (D6): every uastc variant arrives lazily as a patch entry at an equal version, the base hash and earlier variants unchanged (full and patch sinks, the workers capture and the live host); under GRC_TEXTURE_ENCODE_WAIT_FRAME exactly at that frame; the in-place-updated texture never gets one (D12(a)); the workers capture's uastc hashes equal the synchronous capture's",
        ran("capture") ? problems : null,
        `variants at seq ${[...variantSeq.entries()].map(([n, s]) => `${n}:${s}`).join(", ")}`,
        "g8ku/capture",
      ),
    );
  }

  // --- delivery-keep: D6 keep against upgrade --------------------------------------------------
  const applied: Record<string, Applied | undefined> = {};
  for (const l of [
    "receiver",
    "receiver-upgrade",
    "sabotage-perturb-ktx2/receiver",
    "pending/receiver",
    "sabotage-corrupt-ktx2/receiver",
    "live/receiver",
    "web",
    "web-fallback",
    "web-pending",
  ])
    applied[l] = await readJson<Applied>(join(legDirs[l], "applied.json"));
  {
    const problems: string[] = [];
    for (const [l, policy] of [
      ["receiver", "keep"],
      ["receiver-upgrade", "upgrade"],
    ] as const) {
      const a = applied[l];
      if (legs[l].exit_code !== "0" || a?.status !== "ok") {
        problems.push(
          `${l}: exit ${legs[l].exit_code}, status ${a?.status} ${failureText(a)}`,
        );
        continue;
      }
      if (a.receiver?.texture_delivery?.variant_policy !== policy)
        problems.push(
          `${l}: states variant_policy ${a.receiver?.texture_delivery?.variant_policy}`,
        );
      const ups = a.uploads ?? [];
      for (const e of expected.textures) {
        const id = [...idNames.entries()].find(([, n]) => n === e.name)?.[0];
        if (id === undefined) continue;
        const mine = ups.filter((u) => u.id === id);
        const first = mine[0];
        const firstWant = e.keep;
        if (!first || first.encoding !== firstWant)
          problems.push(
            `${l} ${e.name}: first upload ${first?.encoding}, expected ${firstWant}`,
          );
        const vs = variantSeq.get(e.name);
        const atVariant =
          vs === undefined ? [] : mine.filter((u) => u.seq === vs);
        const want = policy === "keep" ? e.keep : e.upgrade;
        if (e.name === "updated") continue; // its step-1 upload is the content change, not D6
        if (want === firstWant) {
          if (atVariant.length > 0)
            problems.push(
              `${l} ${e.name}: re-uploaded at the variant's seq ${vs} (${policy})`,
            );
        } else if (atVariant.length !== 1 || atVariant[0].encoding !== want)
          problems.push(
            `${l} ${e.name}: expected one ${want} upload at seq ${vs}, got ${JSON.stringify(atVariant.map((u) => u.encoding))}`,
          );
      }
    }
    checks.push(
      check(
        "delivery-keep",
        "G8ku (D6): the native receiver under `keep` uploads each texture once (decoded, or block for the DXT1 source) and does not refetch when a uastc variant appears at the same version; under `upgrade` it re-uploads exactly the D3-preferred uastc variants at the seq they appear",
        ran("receiver") && ran("receiver-upgrade") && ran("capture")
          ? problems
          : null,
        undefined,
        "g8ku/receiver or receiver-upgrade",
      ),
    );
  }

  // --- transcode-oracle: the receivers' uploaded blocks = an independent load_ktx_from_buffer ----
  const oracle = await readJson<{
    features: string[];
    adapter: string;
    ktx2: OracleRow[];
  }>(join(legDirs["reference-oracle"], "oracle", "oracle.json"));
  {
    const problems: string[] = [];
    const rows = new Map((oracle?.ktx2 ?? []).map((r) => [r.hash, r]));
    if (!oracle) problems.push("reference-oracle/oracle/oracle.json missing");
    for (const r of oracle?.ktx2 ?? [])
      if (!r.hash_ok || r.error !== 0)
        problems.push(
          `oracle ${r.hash.slice(0, 12)}: hash_ok ${r.hash_ok}, error ${r.error}`,
        );
    const compare = (l: string, need: number) => {
      const got = applied[l]?.transcodes ?? [];
      let matched = 0;
      for (const t of got) {
        const o = rows.get(t.hash);
        if (!t.ok)
          problems.push(`${l} ${t.hash.slice(0, 12)}: transcode failed`);
        if (!o) continue;
        for (const k of [
          "format",
          "width",
          "height",
          "mipmaps",
          "data_bytes",
          "data_sha256",
        ] as const)
          if (t[k] !== o[k])
            problems.push(
              `${l} ${t.hash.slice(0, 12)}: ${k} ${t[k]} != oracle ${o[k]}`,
            );
        matched++;
      }
      transcodes[l] = got.map((t) => ({
        hash: t.hash.slice(0, 12),
        format: t.format,
        us: t.transcode_us,
        data_bytes: t.data_bytes,
      }));
      if (matched < need)
        problems.push(
          `${l}: ${matched} transcodes matched an oracle row, expected >= ${need}`,
        );
    };
    const upgraded = expected.textures.filter(
      (t) => t.upgrade === "uastc",
    ).length;
    compare("receiver-upgrade", upgraded);
    if (ran("live/receiver")) compare("live/receiver", 1);
    transcodes.oracle = {
      adapter: oracle?.adapter,
      features: oracle?.features,
      formats: [...new Set((oracle?.ktx2 ?? []).map((r) => r.format))],
    };
    checks.push(
      check(
        "transcode-oracle",
        "G8ku (D14, D16): every KTX2 the native receiver transcoded (file replay under upgrade, and live) uploaded the same blocks -- Image format, size, mip chain, data size and SHA-256 -- as an independent Image.load_ktx_from_buffer of the same payload in another process on the same GPU (reference-oracle), so the D14 target is the GPU's either way",
        ran("reference-oracle") && ran("receiver-upgrade") ? problems : null,
        `oracle target formats ${JSON.stringify(transcodes.oracle)}`,
        "g8ku/reference-oracle or receiver-upgrade",
      ),
    );
  }

  // --- delivery-reference: receiver pixels = the reference drawing the oracle's transcode ----------
  {
    const problems: string[] = [];
    const seqs =
      (await readText(join(legDirs.receiver, "shot-seqs.txt")))
        ?.trim()
        .split(",") ?? null;
    const upSeqs =
      (await readText(join(legDirs["receiver-upgrade"], "shot-seqs.txt")))
        ?.trim()
        .split(",") ?? null;
    for (const s of expected.steps) {
      const ref = await shot(legDirs.reference, s.step, null);
      const cpu = await shot(legDirs["reference-oracle"], s.step, null);
      const hw = await shot(legDirs["reference-oracle-hw"], s.step, null);
      if (!ref || !cpu || !hw) {
        problems.push(`step ${s.step}: a reference shot is missing`);
        continue;
      }
      pixels[`lossy/step-${s.step}`] = diffShots(ref, cpu);
      pixels[`hw-band/step-${s.step}`] = diffShots(cpu, hw);
      for (const [l, against, ss, label] of [
        ["receiver", ref, seqs, "reference"],
        [
          "receiver-upgrade",
          s.step === 0 ? ref : hw,
          upSeqs,
          s.step === 0 ? "reference" : "reference-oracle-hw",
        ],
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
            `${l} step ${s.step}: ${d.differing} px differ from ${label} (max ${d.max})`,
          );
        if (l === "receiver-upgrade" && s.step > 0)
          pixels[`${l}/step-${s.step}-vs-cpu`] = diffShots(cpu, got);
      }
    }
    checks.push(
      check(
        "delivery-reference",
        "G8ku (D16): the native receiver drawing the transcoded uastc blocks (upgrade, step 1) equals the fixture drawing the oracle's transcoded blocks on the same GPU exactly (0 px), and under keep (and at step 0) equals the procedural reference exactly; against the oracle's CPU decode it is recorded as the informative hardware-decode band (hw-band, as G8kp's BC band)",
        [
          "receiver",
          "receiver-upgrade",
          "reference",
          "reference-oracle",
          "reference-oracle-hw",
        ].every(ran)
          ? problems
          : null,
        Object.entries(pixels)
          .map(
            ([k, v]) =>
              `${k}: ${(v as { differing: number; max: number }).differing} px (max ${(v as { max: number }).max})`,
          )
          .join(", "),
        "g8ku/receiver or a reference",
      ),
    );
  }

  // --- quality-band: PSNR of every uastc texture against its decoded source ----------------------
  {
    const problems: string[] = [];
    if (rec && oracle) {
      const byName = named(lastState(rec).textures, expected);
      for (const e of expected.textures.filter((x) => x.uastc)) {
        const t = byName.get(e.name);
        const v = uastcOf(t);
        if (!t?.hash || !v) continue;
        const grt = join(legDirs.capture, "store", "sha256", `${t.hash}.grt`);
        const dec = join(
          legDirs["reference-oracle"],
          "oracle",
          `${v.hash}.rgba`,
        );
        if (!existsSync(grt) || !existsSync(dec)) {
          problems.push(
            `${e.name}: ${existsSync(grt) ? "the oracle decode" : "the decoded payload"} is missing`,
          );
          continue;
        }
        const p = decodeTexturePayload(new Uint8Array(await readFile(grt)), 9);
        const src = level0Rgba(p.format, p.width, p.height, p.data);
        const got = new Uint8Array(await readFile(dec)).subarray(
          0,
          p.width * p.height * 4,
        );
        if (!src || got.length !== src.length) {
          problems.push(
            `${e.name}: cannot compare ${p.format} ${p.width}x${p.height}`,
          );
          continue;
        }
        const db = psnrRgba(src, got);
        quality[e.name] = {
          psnr_db: Number(db.toFixed(2)),
          ktx2_bytes: v.payload_bytes,
          decoded_bytes: t.payload_bytes,
        };
        if (db < expected.psnr_floor_db)
          problems.push(
            `${e.name}: ${db.toFixed(2)} dB < ${expected.psnr_floor_db}`,
          );
      }
    }
    checks.push(
      check(
        "quality-band",
        `G8ku (D16): the PSNR of every uastc texture's oracle CPU decode against its decoded source (level 0, RGBA) is recorded and at least ${expected.psnr_floor_db} dB`,
        ran("capture") && ran("reference-oracle") ? problems : null,
        Object.entries(quality)
          .map(([n, q]) => `${n} ${(q as { psnr_db: number }).psnr_db} dB`)
          .join(", "),
        "g8ku/capture or reference-oracle",
      ),
    );
  }

  // --- sabotage-perturb-ktx2: a flipped KTX2 byte must be refused -------------------------------
  {
    const problems: string[] = [];
    const sab = legDirs["sabotage-perturb-ktx2/capture"];
    const result = await readJson<{
      stream?: { gate8?: { delivery_stats?: { fault?: string } } };
    }>(join(sab, "evidence", "result.json"));
    if (result?.stream?.gate8?.delivery_stats?.fault !== "perturb-ktx2")
      problems.push("the capture did not run the fault");
    let flipped = 0;
    const dir = join(sab, "store", "sha256");
    if (existsSync(dir))
      for (const f of (await readdir(dir)).filter((x) => x.endsWith(".ktx2")))
        if (
          sha256(new Uint8Array(await readFile(join(dir, f)))) !==
          f.replace(".ktx2", "")
        )
          flipped++;
    if (flipped === 0) problems.push("no stored KTX2 differs from its hash");
    const a = applied["sabotage-perturb-ktx2/receiver"];
    const text = failureText(a);
    if (a?.status === "ok" || !text.includes("resource-hash-mismatch"))
      problems.push(
        `the receiver did not refuse it (status ${a?.status}, ${text || "no failure"})`,
      );
    checks.push(
      check(
        "sabotage-perturb-ktx2",
        "G8ku sabotage perturb-ktx2: with one byte of each KTX2 flipped after hashing, the native receiver (upgrade, so it fetches the uastc variants) refuses the payload with resource-hash-mismatch",
        ran("sabotage-perturb-ktx2/capture") &&
          ran("sabotage-perturb-ktx2/receiver")
          ? problems
          : null,
        `${flipped} stored KTX2 files perturbed; receiver: ${text.slice(0, 120)}`,
        "g8ku/sabotage-perturb-ktx2",
      ),
    );
  }

  // --- delivery-live: the /9 hello with uastc, natural-timing variants, uastc uploads ----------------
  {
    const problems: string[] = [];
    const summary = await readJson<{
      connections?: Array<{
        version?: number;
        texture_encodings?: string | null;
        gpu_formats?: string | null;
      }>;
    }>(join(legDirs["live/host"], "evidence", "live-summary.json"));
    const c = summary?.connections?.[0];
    if (!c) problems.push("live-summary.json has no connection");
    else {
      if (c.version !== 9) problems.push(`the connection is /${c.version}`);
      if (!(c.texture_encodings ?? "").split(",").includes("uastc"))
        problems.push(
          `the hello states texture_encodings ${c.texture_encodings}`,
        );
    }
    const a = applied["live/receiver"];
    if (a?.status !== "ok")
      problems.push(`live receiver status ${a?.status} ${failureText(a)}`);
    const uastcUploads = (a?.uploads ?? []).filter(
      (u) => u.encoding === "uastc",
    ).length;
    if (uastcUploads === 0)
      problems.push("the live receiver uploaded no uastc variant");
    checks.push(
      check(
        "delivery-live",
        "G8ku: a /9 basis-uastc live host (encodes on its pool, no wait knob) and the native receiver at RS_RECEIVER_PROTOCOL=9: the hello states uastc, the receiver fetches uastc variants over HTTP and transcodes them",
        ran("live/host") && ran("live/receiver") ? problems : null,
        `${uastcUploads} uastc uploads; transcode us ${JSON.stringify((a?.transcodes ?? []).map((t) => t.transcode_us))}`,
        "g8ku/live",
      ),
    );
  }

  // --- delivery-web: the web export transcodes through the same engine call ---------------------
  {
    const problems: string[] = [];
    const a = applied.web;
    if (a?.status !== "ok")
      problems.push(`web status ${a?.status} ${failureText(a)}`);
    const rows = new Map((oracle?.ktx2 ?? []).map((r) => [r.hash, r]));
    const got = a?.transcodes ?? [];
    const upgraded = expected.textures.filter(
      (t) => t.upgrade === "uastc",
    ).length;
    if (got.length < upgraded)
      problems.push(
        `the web export transcoded ${got.length} KTX2, expected ${upgraded}`,
      );
    let sameTarget = 0;
    let otherTarget = 0;
    for (const t of got) {
      const o = rows.get(t.hash);
      if (!t.ok) problems.push(`web ${t.hash.slice(0, 12)}: transcode failed`);
      if (!o) {
        problems.push(
          `web ${t.hash.slice(0, 12)}: no oracle row for this KTX2`,
        );
        continue;
      }
      if (
        t.width !== o.width ||
        t.height !== o.height ||
        t.mipmaps !== o.mipmaps
      )
        problems.push(
          `web ${t.hash.slice(0, 12)}: ${t.width}x${t.height} mipmaps ${t.mipmaps}, oracle ${o.width}x${o.height} ${o.mipmaps}`,
        );
      // D14 follows each renderer's own features: the web export's WebGL context may offer another
      // target than the native GL context (a hosted runner's llvmpipe GL reports astc). Same
      // target: the same blocks, bit for bit; another target is recorded, not judged here.
      if (t.format === o.format) {
        sameTarget++;
        if (t.data_sha256 !== o.data_sha256)
          problems.push(
            `web ${t.hash.slice(0, 12)}: format ${t.format}, blocks differ from the native oracle`,
          );
      } else otherTarget++;
    }
    transcodes.web = got.map((t) => ({
      hash: t.hash.slice(0, 12),
      format: t.format,
      us: t.transcode_us,
      data_bytes: t.data_bytes,
    }));
    checks.push(
      check(
        "delivery-web",
        `G8ku (Q6 "Web export"): the web export replaying the upgrade leg takes the uastc variants, transcodes each through Image.load_ktx_from_buffer in wasm (time recorded) at the entry's size, and where its WebGL context's D14 target is the native oracle's, uploads the same blocks bit for bit`,
        ran("web") ? problems : null,
        `transcode us ${JSON.stringify(got.map((t) => t.transcode_us))}; ${sameTarget} on the oracle's target, ${otherTarget} on another`,
        "g8ku-web/web",
      ),
    );
  }

  // --- delivery-pending (G8kf): publishing `delivery-pending` instead of holding back ----------------
  {
    const problems: string[] = [];
    const l = "pending/capture";
    if (legs[l].exit_code !== "0")
      problems.push(`${l} exit ${legs[l].exit_code}`);
    const pr = await readRec(legDirs[l], "recording.rs9", problems);
    await readRec(legDirs[l], "recording-patch.rs9", problems);
    const result = await readJson<{
      stream?: {
        gate8?: {
          texture_workers?: {
            publish_pending?: boolean;
            pending_published?: number;
          };
        };
        texture_workers?: {
          publish_pending?: boolean;
          pending_published?: number;
        };
      };
    }>(join(legDirs[l], "evidence", "result.json"));
    const tw =
      result?.stream?.texture_workers ?? result?.stream?.gate8?.texture_workers;
    const firstPending = new Map<number, number>(); // id -> version published as pending
    const okAt = new Map<number, { version: number; seq: number }>();
    if (pr) {
      for (const tx of pr.transactions)
        for (const t of tx.state.textures) {
          if (t.kind !== "image") continue;
          if (t.status === "unsupported" && t.reason === "delivery-pending") {
            if (t.hash !== null || t.payload_bytes !== 0)
              problems.push(
                `texture ${t.id}: a delivery-pending entry carries a hash or payload`,
              );
            if (!firstPending.has(t.id)) firstPending.set(t.id, t.version);
            if (okAt.has(t.id))
              problems.push(`texture ${t.id}: pending again after it was ok`);
          } else if (t.status === "ok" && firstPending.has(t.id)) {
            const was = firstPending.get(t.id) as number;
            if (!okAt.has(t.id)) {
              okAt.set(t.id, { version: t.version, seq: tx.seq });
              if (t.version !== was + 1)
                problems.push(
                  `texture ${t.id}: pending at version ${was}, ok at ${t.version}, not ${was + 1}`,
                );
            }
          }
        }
      if (firstPending.size === 0)
        problems.push("no delivery-pending entry in the recording");
      const first = pr.transactions[0]?.state.textures.filter(
        (t) => t.status === "unsupported" && t.reason === "delivery-pending",
      );
      if (!first || first.length === 0)
        problems.push(
          "the first transaction carries no delivery-pending entry",
        );
      for (const id of firstPending.keys())
        if (!okAt.has(id)) problems.push(`texture ${id}: never became ok`);
      // The same textures as the synchronous capture's, but for the raised version.
      if (rec) {
        const strip = (t: ResolvedTexture) => ({ ...t, version: 0 });
        const mine = lastState(pr).textures.map(strip);
        const sync = lastState(rec).textures.map(strip);
        if (JSON.stringify(mine) !== JSON.stringify(sync))
          problems.push(
            "the final texture table differs from the synchronous capture's beyond the version",
          );
      }
    }
    if (tw?.publish_pending !== true)
      problems.push("result.json does not state publish_pending");
    if (tw?.pending_published !== firstPending.size)
      problems.push(
        `result.json pending_published ${tw?.pending_published}, the recording has ${firstPending.size} pending textures`,
      );
    // The receiver: nothing is uploaded for a texture while it is pending, and each is uploaded
    // once it is ok; an apply never fails on the unsupported entry.
    for (const l of ["pending/receiver", "web-pending"] as const) {
      const a = applied[l];
      if (legs[l].exit_code !== "0" || a?.status !== "ok") {
        problems.push(
          `${l}: exit ${legs[l].exit_code}, status ${a?.status} ${failureText(a)}`,
        );
        continue;
      }
      for (const [id, ok] of okAt) {
        const mine = (a.uploads ?? []).filter((u) => u.id === id);
        if (mine.length === 0)
          problems.push(`${l}: texture ${id} never uploaded`);
        else if ((mine[0].seq ?? 0) < ok.seq)
          problems.push(
            `${l}: texture ${id} uploaded at seq ${mine[0].seq}, before it was ok at ${ok.seq}`,
          );
      }
    }
    if (applied["pending/receiver"]?.status === "ok" && pr) {
      // A shot whose transaction has no pending entry left equals the reference.
      const seqs =
        (await readText(join(legDirs["pending/receiver"], "shot-seqs.txt")))
          ?.trim()
          .split(",") ?? null;
      let compared = 0;
      for (const s of expected.steps) {
        const tx = seqs
          ? pr.transactions.find((x) => String(x.seq) === seqs[s.step])
          : undefined;
        if (!tx) {
          problems.push(`step ${s.step}: no transaction for its shot seq`);
          continue;
        }
        const pendingLeft = tx.state.textures.some(
          (t) => t.reason === "delivery-pending",
        );
        if (pendingLeft) continue;
        // From step 1 the entries arrive with their uastc variants (they attach at the wait
        // frame, which also resolves every pending texture), so the first upload is the
        // transcoded block, as an upgrade receiver's: the oracle's blocks are the reference.
        const ref = await shot(
          s.step === 0 ? legDirs.reference : legDirs["reference-oracle-hw"],
          s.step,
          null,
        );
        const got = await shot(legDirs["pending/receiver"], s.step, seqs);
        if (!ref || !got) {
          problems.push(`step ${s.step}: a shot is missing`);
          continue;
        }
        const d = diffShots(ref, got);
        pixels[`pending/receiver/step-${s.step}`] = d;
        compared++;
        if (d.differing > 0)
          problems.push(
            `pending/receiver step ${s.step}: ${d.differing} px differ from the ${s.step === 0 ? "reference" : "oracle's blocks"} (max ${d.max})`,
          );
      }
      if (compared === 0)
        problems.push("no step's shot was taken with every texture resolved");
    }
    checks.push(
      check(
        "delivery-pending",
        "G8kf (render-stream-9.md \"Texture reasons\"): under GRC_TEXTURE_WORKERS=2 and GRC_TEXTURE_PENDING=publish a texture whose worker is not done is published as `unsupported`/`delivery-pending` (no hash, no payload) in the first transaction instead of holding the snapshot back, and returns as `ok` at the next version with the synchronous capture's hash, variants and shape (full and patch sinks validate); the native receiver and the web export upload nothing for it while pending and upload it once ok, and the native receiver's shot with every texture resolved equals the reference (step 0) or the oracle's transcoded blocks (step 1; the receiver runs under upgrade) exactly",
        ran(l) &&
          ran("pending/receiver") &&
          ran("web-pending") &&
          ran("reference") &&
          ran("reference-oracle-hw")
          ? problems
          : null,
        `${firstPending.size} pending textures, ok at seq ${[...okAt.values()].map((v) => v.seq).join(",")}`,
        "g8ku/pending",
      ),
    );
  }

  // --- delivery-fallback (G8kf): a KTX2 the transcoder refuses falls back to `decoded` -----------
  {
    const problems: string[] = [];
    const cap = legDirs["sabotage-corrupt-ktx2/capture"];
    const result = await readJson<{
      stream?: { gate8?: { delivery_stats?: { fault?: string } } };
    }>(join(cap, "evidence", "result.json"));
    if (result?.stream?.gate8?.delivery_stats?.fault !== "corrupt-ktx2")
      problems.push("the capture did not run the corrupt-ktx2 fault");
    // Unlike perturb-ktx2, every stored KTX2 hashes to its name: only the transcode can refuse it.
    let files = 0;
    const dir = join(cap, "store", "sha256");
    if (existsSync(dir))
      for (const f of (await readdir(dir)).filter((x) => x.endsWith(".ktx2"))) {
        files++;
        if (
          sha256(new Uint8Array(await readFile(join(dir, f)))) !==
          f.replace(".ktx2", "")
        )
          problems.push(`${f}: does not hash to its name`);
      }
    if (files === 0) problems.push("no stored KTX2");
    const wantFallbacks = expected.textures.filter(
      (t) => t.upgrade === "uastc",
    ).length;
    for (const l of [
      "sabotage-corrupt-ktx2/receiver",
      "web-fallback",
    ] as const) {
      const a = applied[l];
      if (legs[l].exit_code !== "0" || a?.status !== "ok") {
        problems.push(
          `${l}: exit ${legs[l].exit_code}, status ${a?.status} ${failureText(a)}`,
        );
        continue;
      }
      const fb = a.variant_fallbacks ?? [];
      if (fb.length !== wantFallbacks)
        problems.push(
          `${l}: ${fb.length} variant fallbacks, expected ${wantFallbacks}`,
        );
      const failedRows = (a.transcodes ?? []).filter((t) => !t.ok).length;
      if (failedRows !== wantFallbacks)
        problems.push(
          `${l}: ${failedRows} failed transcodes, expected ${wantFallbacks}`,
        );
      const ups = a.uploads ?? [];
      if (ups.some((u) => u.encoding === "uastc"))
        problems.push(`${l}: a uastc payload was uploaded`);
      for (const e of expected.textures) {
        const id = [...idNames.entries()].find(([, n]) => n === e.name)?.[0];
        if (id === undefined) continue;
        const mine = ups.filter((u) => u.id === id);
        if (e.name === "updated") continue; // its step-1 upload is the content change
        const want = e.keep;
        if (mine.length !== 1 || mine[0].encoding !== want)
          problems.push(
            `${l} ${e.name}: uploads ${JSON.stringify(mine.map((u) => u.encoding))}, expected one ${want}`,
          );
      }
    }
    // Pixels (native): the fallback receiver draws what the keep receiver does, the reference.
    const seqs =
      (
        await readText(
          join(legDirs["sabotage-corrupt-ktx2/receiver"], "shot-seqs.txt"),
        )
      )
        ?.trim()
        .split(",") ?? null;
    for (const s of expected.steps) {
      const ref = await shot(legDirs.reference, s.step, null);
      const got = seqs
        ? await shot(legDirs["sabotage-corrupt-ktx2/receiver"], s.step, seqs)
        : undefined;
      if (!ref || !got) {
        problems.push(`step ${s.step}: a shot is missing`);
        continue;
      }
      const d = diffShots(ref, got);
      pixels[`sabotage-corrupt-ktx2/receiver/step-${s.step}`] = d;
      if (d.differing > 0)
        problems.push(
          `sabotage-corrupt-ktx2/receiver step ${s.step}: ${d.differing} px differ from the reference (max ${d.max})`,
        );
    }
    checks.push(
      check(
        "delivery-fallback",
        'G8kf sabotage corrupt-ktx2 (Q3 "Transcode or upload failure on the receiver"): with level 0 of every KTX2 damaged before hashing (each file hashes to its name and passes the header checks), the native receiver (upgrade) and the web export both fail the transcode ahead of the apply, count a variant fallback and a failed transcode per uastc texture, upload only decoded (block for the DXT1 source) and finish the replay ok; the native receiver\'s shots equal the reference exactly',
        ran("sabotage-corrupt-ktx2/capture") &&
          ran("sabotage-corrupt-ktx2/receiver") &&
          ran("web-fallback") &&
          ran("reference")
          ? problems
          : null,
        `${files} KTX2 stored; native fallbacks ${applied["sabotage-corrupt-ktx2/receiver"]?.variant_fallbacks?.length}, web ${applied["web-fallback"]?.variant_fallbacks?.length}`,
        "g8ku/sabotage-corrupt-ktx2 or g8ku-web/web-fallback",
      ),
    );
  }

  return { checks, legs, quality, transcodes, pixels };
}
