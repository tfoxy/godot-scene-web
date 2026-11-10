// Gate 8 g8htr checks (HTR, capture/src/rs_texture_release.h): the opt-in
// headless texture release, GRC_HEADLESS_TEXTURE_RELEASE=on. run-gate8.sh run_g8htr writes every
// leg under g8htr/:
//
//   tex-default, tex-off, tex-on       gate8-tex at /8 with GRC_TEXTURE_DECODE=engine: unset, off, on
//   tex-workers-on                     on, GRC_TEXTURE_WORKERS=2 (held-back workers)
//   tex-refused-on                     on, GRC_TEXTURE_DECODE=off set explicitly since TDE (the block formats refused)
//   tex-budget-on                      on, a resource budget that ends the stream before step 1
//   invalid                            GRC_HEADLESS_TEXTURE_RELEASE=maybe
//   tex-passthrough-{off,on}           /9 GRC_TEXTURE_DELIVERY=passthrough
//   adopt-{born,late,deferred}-{off,on} gate8-adopt (G8a's born, late, LAR0's deferred arms)
//   tex-deferred-{off,on}              gate8-tex armed at frame 6 (GRC_ARM_DEFER_FRAMES=5), adopted
//   sabotage-ignore-predicate          tex-deferred-on with GRC_HEADLESS_TEXTURE_RELEASE_FAULT
//   sabotage-omit-create-on            tex-on with the omit-op sabotage on texture_2d_create
//   rendered-on                        a rendered gate8-tex capture with the switch on
//   tex-{off,on}/receiver              the rendered native receiver on tex-off's and tex-on's sinks
//   cost/{off,on}-<r>                  the htr-cost timing group (the g8t cost variant)
//
// Checks: htr-legs, htr-default-unreported, htr-stream-identical, htr-released,
// htr-replay-identical, htr-workers, htr-adopt, htr-adopt-equivalence, htr-refused, htr-budget,
// htr-census-1x1, htr-sabotage, htr-omit-op, htr-rendered-ignored, htr-invalid, htr-cost (timing) and
// htr-lever (measured, no budget).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePngRgba, skippedLegProblem } from "./gate-minus1-checks";
import {
  check,
  type EquivalenceAllow,
  equivalence,
  exitCode,
  type G8aCheck,
  type G8aExpected,
  jsonl,
  loadRecording,
  readJson,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import { compareWorkerRecordings } from "./gate8-tex-checks";
import type { ResolvedRecording, ResolvedTransaction } from "./render-stream-2";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Image::is_format_compressed's formats (4.5.1 FORMAT_DXT1..FORMAT_ASTC_8x8_HDR): the release tier. */
export const VRAM_FORMATS: ReadonlySet<string> = new Set([
  "DXT1",
  "DXT3",
  "DXT5",
  "RGTC_R",
  "RGTC_RG",
  "BPTC_RGBA",
  "BPTC_RGBF",
  "BPTC_RGBFU",
  "ETC",
  "ETC2_R11",
  "ETC2_R11S",
  "ETC2_RG11",
  "ETC2_RG11S",
  "ETC2_RGB8",
  "ETC2_RGBA8",
  "ETC2_RGB8A1",
  "ETC2_RA_AS_RG",
  "DXT5_RA_AS_RG",
  "ASTC_4x4",
  "ASTC_4x4_HDR",
  "ASTC_8x8",
  "ASTC_8x8_HDR",
]);

export interface HtrStats {
  env: string;
  state: string;
  reason: string | null;
  display_server: string;
  fault: string;
  released: number;
  released_bytes: number;
  released_then_unheld: number;
  kept_adopted: number;
  kept_adopted_bytes: number;
  skipped: {
    inactive: number;
    refused: number;
    format: number;
    omitted: number;
  };
  release_ns_total: number;
  release_ns_max: number;
  timed: {
    creates: number;
    hook_ns_total: number;
    hook_ns_max: number;
    forward_ns_total: number;
  };
}

interface CaptureResult {
  status?: string;
  reason?: string | null;
  stream?: {
    status?: string;
    reason?: string | null;
    texture_workers?: { jobs: number; completed: number };
  };
  headless_texture_release?: HtrStats;
}

interface HookLine {
  op: string;
  id?: number | null;
  status?: string;
  format?: string | null;
  source_format?: string;
  data_bytes?: number;
  released?: boolean;
  release_ns?: number;
}

interface FixtureTexture {
  step: number;
  frame: number;
  name: string;
  family: string;
  format: string | null;
  width: number | null;
  height: number | null;
}

/** The format a create was made from: a host decode's source, else the payload's own. */
const sourceFormat = (h: HookLine) => h.source_format ?? h.format ?? "";
const isOneByOne = (t: FixtureTexture) =>
  t.format === "L8" && t.width === 1 && t.height === 1;

/** The census `oneByOneLarge`: a command naming an image
 * texture of at most 1x1 drawn into a rect wider or taller than 16 px. */
export function oneByOneLarge(state: ResolvedTransaction["state"]): {
  count: number;
  examples: string[];
} {
  const textures = new Map(state.textures.map((t) => [t.id, t]));
  let count = 0;
  const examples: string[] = [];
  for (const item of state.items) {
    for (const c of item.commands) {
      const cmd = c as { op: string; tex?: number | null; rect?: number[] };
      if (cmd.tex === undefined || cmd.tex === null) continue;
      const t = textures.get(cmd.tex);
      if (
        t &&
        t.kind === "image" &&
        t.width <= 1 &&
        t.height <= 1 &&
        Array.isArray(cmd.rect)
      ) {
        const w = Math.abs(cmd.rect[2]);
        const h = Math.abs(cmd.rect[3]);
        if (w > 16 || h > 16) {
          count++;
          if (examples.length < 3)
            examples.push(
              `item ${item.id} ${cmd.op} tex ${cmd.tex} rect ${JSON.stringify(cmd.rect)}`,
            );
        }
      }
    }
  }
  return { count, examples };
}

/** oneByOneLarge over every transaction of a recording. */
export function census1x1(rec: ResolvedRecording): {
  transactions: number;
  max: number;
  first: string | null;
} {
  let transactions = 0;
  let max = 0;
  let first: string | null = null;
  for (const t of rec.transactions) {
    const c = oneByOneLarge(t.state);
    if (c.count > 0) {
      transactions++;
      max = Math.max(max, c.count);
      first ??= `seq ${t.seq} frame ${t.frame}: ${c.examples.join("; ")}`;
    }
  }
  return { transactions, max, first };
}

/** cmp-rec.ts on two recordings (its main exits, so it runs as a child, as gate6b-wide does). */
export function cmpRec(
  a: string,
  b: string,
): { identical: boolean; detail: string } {
  if (!existsSync(a) || !existsSync(b))
    return { identical: false, detail: `missing ${existsSync(a) ? b : a}` };
  const r = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions=development",
      resolve(HERE, "..", "cmp-rec.ts"),
      a,
      b,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: resolve(HERE, "..") },
  );
  const lines = (r.stdout ?? "").trim().split("\n");
  return {
    identical: r.status === 0,
    detail: lines
      .filter((l) => l.startsWith("  differs") || l.startsWith("DIFFERENT"))
      .slice(0, 3)
      .join(" | "),
  };
}

export interface G8htrReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  stats: Record<string, HtrStats | null>;
  census: Record<
    string,
    { transactions: number; max: number; first: string | null }
  >;
  cost: {
    rounds: {
      round: number;
      off: { hook_ns_per_create: number; rss_bytes: number | null } | null;
      on: {
        hook_ns_per_create: number;
        release_ns_per_create: number;
        release_ns_max: number;
        rss_bytes: number | null;
        released: number;
        released_bytes: number;
      } | null;
    }[];
  } | null;
  lever: {
    textures: number;
    rgba_bytes: number;
    passthrough_decoded_bytes: number;
    passthrough_block_bytes: number;
  } | null;
}

const TEX_LEGS = [
  "tex-default",
  "tex-off",
  "tex-on",
  "tex-workers-on",
  "tex-refused-on",
  "tex-budget-on",
  "invalid",
  "tex-passthrough-off",
  "tex-passthrough-on",
  "tex-deferred-off",
  "tex-deferred-on",
  "sabotage-ignore-predicate",
  "sabotage-omit-create-on",
  "rendered-on",
];
const ADOPT_LEGS = ["born", "late", "deferred"].flatMap((a) => [
  `adopt-${a}-off`,
  `adopt-${a}-on`,
]);

/** RSS at the last perf-timeline.jsonl sample. */
async function lastRss(dir: string): Promise<number | null> {
  const lines = jsonl<{ rss_bytes?: number }>(
    await readText(join(dir, "evidence", "perf-timeline.jsonl")),
  );
  const last = lines.at(-1);
  return typeof last?.rss_bytes === "number" ? last.rss_bytes : null;
}

export async function runG8htr(
  out: string,
  adoptExpected: G8aExpected,
): Promise<{ checks: G8aCheck[]; report: G8htrReport }> {
  const g = join(out, "g8htr");
  const checks: G8aCheck[] = [];
  const cap = (leg: string) => join(g, leg, "capture");
  const legDirs = [
    ...[...TEX_LEGS, ...ADOPT_LEGS].map((l) => `${l}/capture`),
    "tex-off/receiver",
    "tex-on/receiver",
  ];
  const report: G8htrReport = {
    legs: {},
    stats: {},
    census: {},
    cost: null,
    lever: null,
  };
  for (const l of legDirs)
    report.legs[l] = {
      exit_code: await exitCode(join(g, l)),
      skipped: skipped(join(g, l)),
    };
  const ran = (l: string) =>
    report.legs[l] !== undefined &&
    report.legs[l].exit_code !== null &&
    report.legs[l].skipped === null;
  const result = async (leg: string) =>
    readJson<CaptureResult>(join(cap(leg), "evidence", "result.json"));
  const stats = async (leg: string) => {
    const s = (await result(leg))?.headless_texture_release ?? null;
    report.stats[leg] = s;
    return s;
  };
  const hookCreates = async (leg: string) =>
    jsonl<HookLine>(
      await readText(join(cap(leg), "evidence", "resources.jsonl")),
    ).filter((h) => h.op === "texture_2d_create");
  const fixtureLog = async (leg: string) =>
    jsonl<FixtureTexture>(await readText(join(cap(leg), "textures.jsonl")));

  // --- htr-legs --------------------------------------------------------------------------
  {
    const problems: string[] = [];
    for (const l of legDirs)
      if (ran(l) && report.legs[l].exit_code !== "0")
        problems.push(`${l} exit ${report.legs[l].exit_code}`);
    checks.push(
      check(
        "htr-legs",
        "every g8htr leg that ran (the captures and the two rendered receivers) exits 0",
        problems,
        `${legDirs.filter(ran).length} legs`,
      ),
    );
  }

  // --- htr-default-unreported ------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("tex-default/capture") && ran("tex-off/capture")) {
      problems = [];
      const r = await result("tex-default");
      if (!r) problems.push("tex-default has no result.json");
      else if (r.headless_texture_release !== undefined)
        problems.push(
          "tex-default's result.json reports headless_texture_release",
        );
      if (
        existsSync(
          join(cap("tex-default"), "evidence", "headless-texture-release.json"),
        )
      )
        problems.push(
          "tex-default wrote evidence/headless-texture-release.json",
        );
      for (const f of ["recording.rs8", "recording-patch.rs8"]) {
        const c = cmpRec(join(cap("tex-default"), f), join(cap("tex-off"), f));
        if (!c.identical)
          problems.push(`tex-default/${f} differs from tex-off: ${c.detail}`);
      }
    }
    checks.push(
      check(
        "htr-default-unreported",
        "with GRC_HEADLESS_TEXTURE_RELEASE unset the capture reports nothing new (no result.json key, no evidence file) and both sinks equal the explicit `off` leg's (cmp-rec.ts)",
        problems,
        "unset == off, unreported",
      ),
    );
  }

  // --- htr-stream-identical ---------------------------------------------------------------
  const pairs: [string, string, string[]][] = [
    ["tex-off", "tex-on", ["recording.rs8", "recording-patch.rs8"]],
    [
      "tex-passthrough-off",
      "tex-passthrough-on",
      ["recording.rs9", "recording-patch.rs9"],
    ],
    [
      "tex-deferred-off",
      "tex-deferred-on",
      ["recording.rs8", "recording-patch.rs8"],
    ],
    ...["born", "late", "deferred"].map(
      (a) =>
        [
          `adopt-${a}-off`,
          `adopt-${a}-on`,
          ["recording.rs8", "recording-patch.rs8"],
        ] as [string, string, string[]],
    ),
  ];
  {
    let problems: string[] | null = [];
    let compared = 0;
    for (const [off, on, files] of pairs) {
      if (!ran(`${off}/capture`) || !ran(`${on}/capture`)) {
        problems = null;
        break;
      }
      for (const f of files) {
        const c = cmpRec(join(cap(off), f), join(cap(on), f));
        compared++;
        if (!c.identical)
          problems.push(`${on}/${f} differs from ${off}: ${c.detail}`);
      }
    }
    checks.push(
      check(
        "htr-stream-identical",
        "every on leg's sinks equal its off twin's record for record (cmp-rec.ts: session ids and end-record timings aside): tex, /9 passthrough, the gate8-tex deferred arm and gate8-adopt born, late and deferred",
        problems,
        `${compared} recordings identical`,
      ),
    );
  }

  // --- htr-released -----------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("tex-on/capture") && ran("tex-off/capture")) {
      problems = [];
      const s = await stats("tex-on");
      const creates = await hookCreates("tex-on");
      const due = creates.filter(
        (h) => h.status === "ok" && VRAM_FORMATS.has(sourceFormat(h)),
      );
      const released = creates.filter((h) => h.released === true);
      const dueIds = due.map((h) => h.id).join(",");
      const releasedIds = released.map((h) => h.id).join(",");
      if (due.length === 0)
        problems.push("no ok VRAM-tier create in tex-on's hook log");
      if (dueIds !== releasedIds)
        problems.push(
          `released ids [${releasedIds}], expected the ok VRAM creates [${dueIds}]`,
        );
      if (released.some((h) => typeof h.release_ns !== "number"))
        problems.push("a released line has no release_ns");
      if (!s) problems.push("tex-on reports no headless_texture_release");
      else {
        if (s.state !== "active") problems.push(`state ${s.state}`);
        if (s.released !== released.length)
          problems.push(
            `result.json released ${s.released}, hook log ${released.length}`,
          );
        if (s.released_then_unheld !== 0)
          problems.push(`released_then_unheld ${s.released_then_unheld}`);
        if (s.released_bytes <= 0) problems.push("released_bytes 0");
      }
      const ev = await readJson<HtrStats>(
        join(cap("tex-on"), "evidence", "headless-texture-release.json"),
      );
      if (ev?.state !== "active")
        problems.push(
          `evidence/headless-texture-release.json state ${ev?.state}`,
        );
      // The engine side: the fixture's own get_image() (the dummy's copy) is 1x1 L8 exactly for
      // the released textures, and the off twin's full image everywhere else.
      const on = await fixtureLog("tex-on");
      const off = await fixtureLog("tex-off");
      if (on.length === 0 || on.length !== off.length)
        problems.push(`fixture logs: ${on.length} lines on, ${off.length} off`);
      let ones = 0;
      for (let i = 0; i < Math.min(on.length, off.length); i++) {
        const a = off[i];
        const b = on[i];
        if (a.name !== b.name || a.family !== b.family) {
          problems.push(
            `fixture line ${i}: ${b.name}/${b.family} vs ${a.name}/${a.family}`,
          );
          continue;
        }
        if (isOneByOne(b)) {
          ones++;
          if (!VRAM_FORMATS.has(a.format ?? ""))
            problems.push(
              `${b.name}/${b.family}: 1x1 on, but off is ${a.format}`,
            );
        } else if (
          a.format !== b.format ||
          a.width !== b.width ||
          a.height !== b.height
        )
          problems.push(
            `${b.name}/${b.family}: on ${b.format} ${b.width}x${b.height}, off ${a.format} ${a.width}x${a.height}`,
          );
      }
      if (ones !== released.length)
        problems.push(
          `${ones} fixture textures read back 1x1, ${released.length} released`,
        );
      detail = `${released.length} released (${s?.released_bytes} source bytes), ${ones} read back 1x1 L8, ${on.length - ones} intact; skipped ${JSON.stringify(s?.skipped)}`;
    }
    checks.push(
      check(
        "htr-released",
        "tex-on releases exactly the ok VRAM-tier creates (hook-log `released` lines == the ok creates whose source format is VRAM-compressed, result.json agreeing, none unheld, the evidence file active), and the fixture's get_image() reads 1x1 L8 back for exactly those and the off twin's image for every other texture",
        problems,
        detail,
      ),
    );
  }

  // --- htr-replay-identical ----------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let n = 0;
    if (ran("tex-off/receiver") && ran("tex-on/receiver")) {
      problems = [];
      const dirOff = join(g, "tex-off", "receiver", "shots");
      const dirOn = join(g, "tex-on", "receiver", "shots");
      const shots = existsSync(dirOff)
        ? readdirSync(dirOff).filter((f) => f.endsWith(".png"))
        : [];
      if (shots.length === 0) problems.push("tex-off/receiver took no shot");
      for (const f of shots.sort()) {
        const a = await decodePngRgba(join(dirOff, f));
        const b = await decodePngRgba(join(dirOn, f));
        if (!a || !b) {
          problems.push(`${f}: missing or unreadable`);
          continue;
        }
        n++;
        if (a.width !== b.width || a.height !== b.height) {
          problems.push(
            `${f}: ${b.width}x${b.height} vs ${a.width}x${a.height}`,
          );
          continue;
        }
        let differing = 0;
        for (let i = 0; i < a.data.length; i++)
          if (a.data[i] !== b.data[i]) differing++;
        if (differing > 0) problems.push(`${f}: ${differing} bytes differ`);
      }
    }
    checks.push(
      check(
        "htr-replay-identical",
        "the rendered native receiver's shots of tex-on's recording equal those of tex-off's byte for byte",
        problems,
        `${n} shots identical`,
      ),
    );
  }

  // --- htr-workers ------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("tex-off/capture") && ran("tex-workers-on/capture")) {
      problems = [];
      const a = await loadRecording(cap("tex-off"));
      const b = await loadRecording(cap("tex-workers-on"));
      if (!a.rec || !b.rec) problems.push(a.error ?? b.error ?? "no recording");
      else
        problems.push(
          ...compareWorkerRecordings(a.rec, b.rec).problems.slice(0, 10),
        );
      const w = await stats("tex-workers-on");
      const s = await stats("tex-on");
      if (
        !w ||
        !s ||
        w.released !== s.released ||
        w.released_bytes !== s.released_bytes
      )
        problems.push(
          `released ${w?.released}/${w?.released_bytes} on workers, ${s?.released}/${s?.released_bytes} sync`,
        );
      const r = await result("tex-workers-on");
      const jobs = r?.stream?.texture_workers?.jobs ?? 0;
      if (jobs === 0) problems.push("no worker job ran");
      if ((w?.released_then_unheld ?? 1) !== 0)
        problems.push("released_then_unheld");
    }
    checks.push(
      check(
        "htr-workers",
        "with the switch on and every copy on a held-back worker (the job reads its own copy-on-write duplicate of the original), every published state equals the synchronous off capture's (G8kw's worker-states-equal rule) and the same textures are released",
        problems,
        "worker states equal, released equal",
      ),
    );
  }

  // --- htr-adopt --------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (
      ADOPT_LEGS.every((l) => ran(`${l}/capture`)) &&
      ran("tex-deferred-on/capture")
    ) {
      problems = [];
      const born = await hookCreates("adopt-born-on");
      const bornReleased = born.filter((h) => h.released === true);
      if (!bornReleased.some((h) => h.source_format === "DXT5"))
        problems.push("born: ChipBc (DXT5) not released");
      for (const a of ["late", "deferred"]) {
        const s = await stats(`adopt-${a}-on`);
        if (!s) {
          problems.push(`${a}: no stats`);
          continue;
        }
        if (s.kept_adopted !== 1 || s.kept_adopted_bytes <= 0)
          problems.push(
            `${a}: kept_adopted ${s.kept_adopted} (${s.kept_adopted_bytes} B), expected ChipBc`,
          );
        if (s.released !== 0) problems.push(`${a}: released ${s.released}`);
      }
      const d = await stats("tex-deferred-on");
      if (!d || d.kept_adopted === 0 || d.skipped.inactive === 0)
        problems.push(
          `tex-deferred: kept_adopted ${d?.kept_adopted}, inactive ${d?.skipped.inactive}`,
        );
      detail = `born released ${bornReleased.length}; late/deferred kept ChipBc; tex-deferred kept ${d?.kept_adopted} pre-arm textures (${d?.kept_adopted_bytes} B), released ${d?.released} created after the arm`;
    }
    checks.push(
      check(
        "htr-adopt",
        "pre-arm textures are never released (design answer 4): born releases ChipBc; late and deferred adopt it and count it kept_adopted with nothing released; the gate8-tex deferred arm keeps every pre-arm VRAM texture (inactive) and counts each adopted one",
        problems,
        detail,
      ),
    );
  }

  // --- htr-adopt-equivalence --------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let frames = 0;
    const K = adoptExpected.arm_frame;
    const allow: EquivalenceAllow = {
      creation: {
        paths: adoptExpected.exceptions.creation.paths,
        until_frame: K + adoptExpected.exceptions.creation.until_offset,
      },
      refused: { paths: adoptExpected.exceptions.refused.paths },
    };
    if (ADOPT_LEGS.every((l) => ran(`${l}/capture`))) {
      problems = [];
      const born = await loadRecording(cap("adopt-born-on"));
      for (const a of ["late", "deferred"]) {
        const late = await loadRecording(cap(`adopt-${a}-on`));
        if (!born.rec || !late.rec) {
          problems.push(born.error ?? late.error ?? "no recording");
          continue;
        }
        const e = equivalence(
          born.rec,
          late.rec,
          K,
          adoptExpected.residue,
          allow,
        );
        frames += e.frames;
        problems.push(...e.problems.slice(0, 6).map((p) => `${a}: ${p}`));
      }
    }
    checks.push(
      check(
        "htr-adopt-equivalence",
        "G8a's adopt-equivalence (and LAR0's -deferred) holds on the on legs: late and deferred equal born from the arm on under its rule and declared exceptions",
        problems,
        `${frames} frames equal`,
      ),
    );
  }

  // --- htr-refused ------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("tex-refused-on/capture")) {
      problems = [];
      const s = await stats("tex-refused-on");
      const refused = (await hookCreates("tex-refused-on")).filter(
        (h) => h.status !== "ok" && VRAM_FORMATS.has(sourceFormat(h)),
      );
      if (refused.length === 0) problems.push("no refused VRAM create");
      if (s?.released !== 0) problems.push(`released ${s?.released}`);
      if (!s || s.skipped.refused !== refused.length)
        problems.push(
          `skipped.refused ${s?.skipped.refused}, hook log ${refused.length}`,
        );
      const ones = (await fixtureLog("tex-refused-on")).filter(isOneByOne);
      if (ones.length > 0)
        problems.push(`${ones.length} fixture textures read back 1x1`);
      detail = `${refused.length} refused, none released, every dummy copy intact`;
    }
    checks.push(
      check(
        "htr-refused",
        "a texture the format policy refuses (BC with GRC_TEXTURE_DECODE=off) is not released: released 0, skipped.refused = the refused VRAM creates, the fixture reads every image back full size",
        problems,
        detail,
      ),
    );
  }

  // --- htr-budget -------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("tex-budget-on/capture")) {
      problems = [];
      const r = await result("tex-budget-on");
      const s = await stats("tex-budget-on");
      if (!r?.stream?.reason?.startsWith("resource-budget-exceeded"))
        problems.push(`stream reason ${r?.stream?.reason}`);
      const log = await fixtureLog("tex-budget-on");
      const late = log.filter((t) => t.step >= 1);
      if (late.length === 0)
        problems.push("no step-1 texture in the fixture log");
      const lateOnes = late.filter(isOneByOne);
      if (lateOnes.length > 0)
        problems.push(
          `${lateOnes.length} step-1 textures (after the end) read back 1x1`,
        );
      const lateTier = late.filter((t) => VRAM_FORMATS.has(t.format ?? ""));
      if (!s || s.skipped.inactive < lateTier.length)
        problems.push(
          `skipped.inactive ${s?.skipped.inactive} < ${lateTier.length} step-1 VRAM creates`,
        );
      if (!s || s.released === 0)
        problems.push("nothing released before the end");
      detail = `${s?.released} released before the breach, ${s?.skipped.inactive} inactive after it, ${late.length} step-1 textures intact`;
    }
    checks.push(
      check(
        "htr-budget",
        "the budget never evicts (a breach ends the stream): textures created after the end are inactive, not released, and read back full size",
        problems,
        detail,
      ),
    );
  }

  // --- htr-census-1x1 ---------------------------------------------------------------------
  const censusLegs: [string, 8 | 9][] = [
    ["tex-off", 8],
    ["tex-on", 8],
    ["tex-workers-on", 8],
    ["tex-passthrough-on", 9],
    ["tex-deferred-on", 8],
    ["adopt-born-on", 8],
    ["adopt-late-on", 8],
    ["adopt-deferred-on", 8],
  ];
  {
    let problems: string[] | null = [];
    for (const [leg, v] of censusLegs) {
      if (!ran(`${leg}/capture`)) {
        problems = null;
        break;
      }
      const r = await loadRecording(cap(leg), v);
      if (!r.rec) {
        problems.push(`${leg}: ${r.error}`);
        continue;
      }
      const c = census1x1(r.rec);
      report.census[leg] = c;
      if (c.transactions > 0)
        problems.push(
          `${leg}: ${c.transactions} transactions draw a 1x1 image > 16 px (${c.first})`,
        );
    }
    checks.push(
      check(
        "htr-census-1x1",
        "no honest leg's stream draws a <=1x1 image texture into a rect over 16 px in any transaction (C3 analyze.mts `oneByOneLarge`, ported)",
        problems,
        `${censusLegs.length} recordings, oneByOneLarge 0`,
      ),
    );
  }

  // --- htr-sabotage -----------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    const leg = "sabotage-ignore-predicate";
    if (ran(`${leg}/capture`) && ran("tex-deferred-off/capture")) {
      problems = [];
      const r = await loadRecording(cap(leg));
      const c = r.rec ? census1x1(r.rec) : null;
      if (c) report.census[leg] = c;
      if (!c || c.transactions === 0)
        problems.push("htr-census-1x1 did not fail");
      const ids = cmpRec(
        join(cap(leg), "recording.rs8"),
        join(cap("tex-deferred-off"), "recording.rs8"),
      );
      if (ids.identical) problems.push("htr-stream-identical did not fail");
      const s = await stats(leg);
      if (s?.fault !== "ignore-predicate") problems.push(`fault ${s?.fault}`);
      detail = `fails census (${c?.transactions} transactions, up to ${c?.max} draws; ${c?.first}) and stream identity (${ids.detail})`;
    }
    checks.push(
      check(
        "htr-sabotage",
        "GRC_HEADLESS_TEXTURE_RELEASE_FAULT=ignore-predicate (every VRAM texture released, pre-arm ones included) fails htr-census-1x1 (adoption reads the 1x1 back and the stream draws it at 64 px) and htr-stream-identical against the honest deferred twin",
        problems,
        detail,
      ),
    );
  }

  // --- htr-omit-op -------------------------------------------------------------------------
  // The predicate reads the omit-op state from the release hot line (rs_texture_release.h
  // kMirrorOmitArmed) and asks the mirror only when it is set. With the sabotage armed on
  // texture_2d_create, every create it drops must be decided `omitted` (its image kept), never
  // released and then dropped at the mirror tap (`released_then_unheld`).
  {
    let problems: string[] | null = null;
    let detail = "";
    const leg = "sabotage-omit-create-on";
    const skippedProblem = skippedLegProblem(cap(leg));
    if (skippedProblem && ran("tex-on/capture")) problems = [skippedProblem];
    else if (ran(`${leg}/capture`) && ran("tex-on/capture")) {
      problems = [];
      const s = await stats(leg);
      const on = await stats("tex-on");
      if (!s || !on) problems.push("no headless_texture_release stats");
      else {
        if (s.skipped.omitted < 1) problems.push("no create decided omitted");
        if (s.released_then_unheld !== 0)
          problems.push(
            `${s.released_then_unheld} released then dropped by the mirror`,
          );
        // The omit-op is asked before the tier, so every create tex-on decided past the stream
        // gate (released, format or refused) is omitted here, and none is released.
        const past =
          on.released +
          on.skipped.format +
          on.skipped.refused +
          on.skipped.omitted;
        if (s.released !== 0) problems.push(`${s.released} released`);
        if (s.skipped.omitted !== past)
          problems.push(
            `omitted ${s.skipped.omitted} != tex-on's ${past} creates past the stream gate`,
          );
        detail = `${s.skipped.omitted} omitted (tex-on: ${on.released} released, ${on.skipped.format} format, ${on.skipped.refused} refused), ${s.released} released, ${s.released_then_unheld} released then unheld`;
      }
    }
    checks.push(
      check(
        "htr-omit-op",
        "GRC_SABOTAGE=omit-op on texture_2d_create with the switch on: every create tex-on decides past the stream gate is decided omitted instead (its image kept), none is released, and none is released and then dropped by the mirror",
        problems,
        detail,
      ),
    );
  }

  // --- htr-rendered-ignored ---------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("rendered-on/capture")) {
      problems = [];
      const s = await stats("rendered-on");
      if (
        s?.state !== "ignored" ||
        s.reason !== "not-headless" ||
        s.released !== 0
      )
        problems.push(
          `state ${s?.state} reason ${s?.reason} released ${s?.released}`,
        );
      const log =
        (await readText(join(cap("rendered-on"), "stdout.log"))) ?? "";
      if (
        !/headless texture release: ignored \(not-headless, display_server=\S+\)/.test(
          log,
        )
      )
        problems.push(
          "no `headless texture release: ignored (not-headless, ...)` log line",
        );
      const ones = (await fixtureLog("rendered-on")).filter(isOneByOne);
      if (ones.length > 0)
        problems.push(`${ones.length} textures read back 1x1`);
      const r = await result("rendered-on");
      if (r?.status !== "armed")
        problems.push(`capture ${r?.status} ${r?.reason}`);
    }
    checks.push(
      check(
        "htr-rendered-ignored",
        "on a rendered host the switch is ignored, typed and logged (state ignored, reason not-headless, released 0), and the capture still arms",
        problems,
        "ignored, not-headless",
      ),
    );
  }

  // --- htr-invalid ------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("invalid/capture")) {
      problems = [];
      const r = await result("invalid");
      if (
        r?.status !== "refused" ||
        r.reason !== "headless-texture-release-invalid"
      )
        problems.push(`capture ${r?.status} ${r?.reason}`);
      if (r?.headless_texture_release?.state !== "refused")
        problems.push(`state ${r?.headless_texture_release?.state}`);
    }
    checks.push(
      check(
        "htr-invalid",
        "GRC_HEADLESS_TEXTURE_RELEASE=maybe refuses the capture, typed headless-texture-release-invalid",
        problems,
        "refused",
      ),
    );
  }

  // --- htr-cost (timing group) ------------------------------------------------------------
  {
    const rounds: NonNullable<G8htrReport["cost"]>["rounds"] = [];
    const costDir = join(g, "cost");
    let anySkipped = false;
    if (existsSync(costDir)) {
      const names = readdirSync(costDir);
      const ns = [
        ...new Set(
          names.map((n) => Number(n.split("-")[1])).filter((n) => n > 0),
        ),
      ].sort();
      for (const r of ns) {
        const row: (typeof rounds)[number] = { round: r, off: null, on: null };
        for (const c of ["off", "on"] as const) {
          const dir = join(costDir, `${c}-${r}`);
          if (skipped(dir) !== null) anySkipped = true;
          const s = (
            await readJson<CaptureResult>(join(dir, "evidence", "result.json"))
          )?.headless_texture_release;
          if (!s) continue;
          const perCreate =
            s.timed.creates > 0 ? s.timed.hook_ns_total / s.timed.creates : 0;
          const rss = await lastRss(dir);
          if (c === "off")
            row.off = { hook_ns_per_create: perCreate, rss_bytes: rss };
          else {
            const decided =
              s.released +
              s.skipped.inactive +
              s.skipped.refused +
              s.skipped.format +
              s.skipped.omitted;
            row.on = {
              hook_ns_per_create: perCreate,
              release_ns_per_create:
                decided > 0 ? s.release_ns_total / decided : 0,
              release_ns_max: s.release_ns_max,
              rss_bytes: rss,
              released: s.released,
              released_bytes: s.released_bytes,
            };
          }
        }
        rounds.push(row);
      }
    }
    report.cost = { rounds };
    let problems: string[] | null = null;
    let detail = "";
    const complete = rounds.filter((r) => r.on && r.off);
    if (!anySkipped && complete.length > 0) {
      problems = [];
      const med = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const release = med(complete.map((r) => r.on!.release_ns_per_create));
      if (release > 1000)
        problems.push(
          `median release_ns per create ${release.toFixed(0)} > 1000`,
        );
      const saved = complete
        .filter((r) => r.on!.rss_bytes !== null && r.off!.rss_bytes !== null)
        .map((r) => r.off!.rss_bytes! - r.on!.rss_bytes!);
      const bytes = complete[0].on!.released_bytes;
      if (saved.length === 0) problems.push("no RSS sample");
      else if (med(saved) < bytes / 2)
        problems.push(
          `median RSS saved ${med(saved)} B < half the ${bytes} released bytes`,
        );
      detail = `${complete.length} rounds: release ${release.toFixed(0)} ns/create (max ${Math.max(...complete.map((r) => r.on!.release_ns_max))} ns); hook ${med(complete.map((r) => r.off!.hook_ns_per_create)).toFixed(0)} ns off, ${med(complete.map((r) => r.on!.hook_ns_per_create)).toFixed(0)} ns on per create; RSS saved ${saved.length > 0 ? med(saved) : "?"} B against ${bytes} released source bytes`;
    }
    checks.push(
      check(
        "htr-cost",
        "timing group htr-cost (cost/{off,on}-<r>, real time under the exclusive quiet lock): the median predicate-plus-swap cost is at most 1 us per create, and the median RSS saving at the last sample is at least half the released source bytes",
        problems,
        detail,
      ),
    );
  }

  // --- htr-lever (measured, no budget) ------------------------------------------------------
  {
    let detail = "evidence missing";
    if (ran("tex-on/capture") && ran("tex-passthrough-on/capture")) {
      const a = await loadRecording(cap("tex-on"));
      const b = await loadRecording(cap("tex-passthrough-on"), 9);
      const vram = (t: { status: string; source_format?: string | null }) =>
        t.status === "ok" && VRAM_FORMATS.has(t.source_format ?? "");
      const last = (r?: ResolvedRecording) =>
        r?.transactions.at(-1)?.state.textures ?? [];
      const rgba = last(a.rec).filter(vram);
      const pass = last(b.rec).filter(vram);
      const block = pass.reduce(
        (n, t) =>
          n +
          (t.variants ?? [])
            .filter((v) => v.encoding === "block")
            .reduce((m, v) => m + v.payload_bytes, 0),
        0,
      );
      report.lever = {
        textures: pass.length,
        rgba_bytes: rgba.reduce((n, t) => n + t.payload_bytes, 0),
        passthrough_decoded_bytes: pass.reduce(
          (n, t) => n + t.payload_bytes,
          0,
        ),
        passthrough_block_bytes: block,
      };
      detail = `${pass.length} VRAM textures live at the end: rgba holds ${report.lever.rgba_bytes} B decoded; passthrough holds ${report.lever.passthrough_decoded_bytes} B decoded + ${block} B block`;
    }
    checks.push({
      id: "htr-lever",
      criterion:
        "measured, no budget: what the host holds per VRAM texture in the mirror under rgba (decoded) and passthrough (decoded + block), the size of the next lever (regenerate decoded on a GET)",
      passed: true,
      status: "pass",
      detail,
      gating: false,
    } as G8aCheck);
  }

  return { checks, report };
}
