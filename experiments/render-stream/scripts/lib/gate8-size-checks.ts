// Gate 8 g8h checks (G8h, protocol/gate8-design.md D10 and "Q4. Host size at a late arm"): the
// declared presentation size applied after adoption, judged on fixtures/gate8-size. The group
// reuses g8a's born-armed equivalence (lib/gate8-adopt-checks.ts) and adds the size reads. The
// pure helpers (sizeProblems, probeProblems, atlasProblems) are exported so
// scripts/test/self-test-gate8-size.ts can drive them on synthetic input.

import { join } from "node:path";

import {
  check,
  equivalence,
  exitCode,
  type G8aCheck,
  jsonl,
  loadRecording,
  readJson,
  readText,
  shotDiff,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import { decodeRecording, type ResolvedRecording } from "./render-stream-2";

export interface G8hExpected {
  schema: "render-stream-gate8-size-expected/1";
  doc: string;
  arm_frame: number;
  logical_size: [number, number];
  /** what the headless host reports before a late presentation arm (the 64x64 SceneTree minimum). */
  pre_arm: { window: [number, number]; visible: [number, number]; oversampling: number };
  /** what the engine reports after the arm. */
  post_arm: { window: [number, number]; visible: [number, number]; oversampling: number };
  /** frames after the arm that the receivers' first checkpoint settles (late-size-reference). */
  settle_frames: number;
  checkpoints: { step: number; applied: number; settle: number }[];
  items: number;
  /** the items the walk adopted (adopt_stats.items). */
  adopted: number;
  strict: { reason: string };
}

export interface G8hReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  sizes: Record<string, unknown>;
  equivalence: { frames_compared: number; first_problems: string[] } | null;
  pixels: Record<string, { step: number; differing: number; max_delta: number }[]>;
  atlas: { textures_drawn: number; frames: number } | null;
  sabotages: Record<string, Record<string, number | string>>;
}

interface SessionViewport {
  root_size_policy?: string;
  presentation_size?: [number, number];
  host_size_status?: string;
  host_window_size?: [number, number];
  font_oversampling?: number;
  logical_size?: [number, number];
}

export interface SizeProbe {
  frame: number;
  window: [number, number];
  visible: [number, number];
  oversampling: number;
  stretch: [number, number];
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** late-size-match, the session half: the declared viewport of a presentation capture. */
export function sizeProblems(vp: SessionViewport | undefined, expected: G8hExpected): string[] {
  if (!vp) return ["no session viewport"];
  const problems: string[] = [];
  if (vp.root_size_policy !== "presentation") problems.push(`policy ${vp.root_size_policy}`);
  if (vp.host_size_status !== "match") problems.push(`host_size_status ${vp.host_size_status}, expected match`);
  if (!eq(vp.presentation_size, expected.logical_size))
    problems.push(`presentation_size ${JSON.stringify(vp.presentation_size)}`);
  if (!eq(vp.host_window_size, expected.post_arm.window))
    problems.push(`host_window_size ${JSON.stringify(vp.host_window_size)}`);
  if (typeof vp.font_oversampling !== "number" || !near(vp.font_oversampling, expected.post_arm.oversampling))
    problems.push(`font_oversampling ${vp.font_oversampling}, expected ${expected.post_arm.oversampling}`);
  return problems;
}

/** late-size-match, the engine half: the fixture's own read at K-1 and K+1. `late` is true for the
 * captures armed after the scene existed; a born capture reads the post-arm state at both. */
export function probeProblems(lines: SizeProbe[], expected: G8hExpected, late: boolean): string[] {
  const K = expected.arm_frame;
  const before = lines.find((l) => l.frame === K - 1);
  const after = lines.find((l) => l.frame === K + 1);
  if (!before || !after) return [`size probe lines at ${K - 1} and ${K + 1} missing`];
  const problems: string[] = [];
  const want = (l: SizeProbe, w: G8hExpected["pre_arm"], name: string) => {
    if (!eq(l.window, w.window)) problems.push(`${name}: window ${JSON.stringify(l.window)}, expected ${JSON.stringify(w.window)}`);
    if (!eq(l.visible, w.visible)) problems.push(`${name}: visible ${JSON.stringify(l.visible)}, expected ${JSON.stringify(w.visible)}`);
    if (Math.abs(l.oversampling - w.oversampling) > 1e-6)
      problems.push(`${name}: oversampling ${l.oversampling}, expected ${w.oversampling}`);
  };
  want(before, late ? expected.pre_arm : expected.post_arm, `K-1`);
  want(after, expected.post_arm, `K+1`);
  return problems;
}

/** late-size-atlas: from the arm on, every texture a drawn command names is a post-arm create
 * (origin "created", never "adopted"), usable, and no unknown-texture is reported. */
export function atlasProblems(
  rec: ResolvedRecording,
  fromFrame: number,
): { problems: string[]; textures: number; frames: number } {
  const problems: string[] = [];
  const drawn = new Set<number>();
  let frames = 0;
  for (const t of rec.transactions) {
    if (t.frame < fromFrame) continue;
    frames++;
    const textures = new Map(t.state.textures.map((x) => [x.id, x]));
    for (const u of t.state.unsupported)
      if (/texture/.test(u.reason)) problems.push(`frame ${t.frame}: unsupported ${u.op}|${u.reason}`);
    for (const it of t.state.items)
      for (const c of it.commands) {
        if (typeof c.tex !== "number") continue;
        const tex = textures.get(c.tex);
        if (!tex) {
          problems.push(`frame ${t.frame}: command names texture ${c.tex} missing from the table`);
          continue;
        }
        drawn.add(c.tex);
        if (tex.origin !== "created") problems.push(`frame ${t.frame}: texture ${c.tex} origin ${tex.origin}`);
        if (tex.status !== "ok") problems.push(`frame ${t.frame}: texture ${c.tex} status ${tex.status}`);
      }
  }
  if (frames === 0) problems.push("no frame from the arm");
  if (drawn.size === 0) problems.push("no texture drawn after the arm (the fixture's Labels draw glyphs)");
  return { problems: [...new Set(problems)], textures: drawn.size, frames };
}

/** late-size-account: the adoption walk adopted every item and the size's relayout named no
 * unadopted RID (D3: read the nodes, then size). */
export function accountProblems(r: CaptureResult, expected: G8hExpected): string[] {
  const problems: string[] = [];
  const st = r.stream?.gate8?.adopt_stats;
  if (!st || st.ran !== true || st.items !== expected.adopted) problems.push(`adopt_stats ${JSON.stringify(st)}`);
  if (r.stream?.status === "refused") problems.push(`stream refused: ${r.stream.reason}`);
  const ui = r.stream?.unknown_items;
  if (!ui || ui.unknown_calls !== 0 || ui.unknown_rids_named !== 0 || ui.withheld_items !== 0)
    problems.push(`unknown_items ${JSON.stringify(ui)}`);
  return problems;
}

function sessionViewport(rec: { bytes?: Uint8Array } | undefined): SessionViewport | undefined {
  if (!rec?.bytes) return undefined;
  const decoded = decodeRecording(rec.bytes, 8) as unknown as { records: { meta: { viewport?: SessionViewport } }[] };
  return decoded.records[0]?.meta.viewport;
}

export interface CaptureResult {
  stream?: { status?: string; reason?: string | null; unknown_items?: { unknown_calls: number; unknown_rids_named: number; withheld_items: number } | null; gate8?: { adopt?: string; adopt_stats?: Record<string, number | string | boolean | null> } };
}

const SABOTAGES = ["size-before-adopt", "size-before-adopt-strict"] as const;

export async function runG8h(out: string, expected: G8hExpected): Promise<{ checks: G8aCheck[]; report: G8hReport }> {
  const root = join(out, "g8h");
  const checks: G8aCheck[] = [];
  const K = expected.arm_frame;
  const legDirs = [
    "import/fixture",
    "import/receiver",
    "born/capture",
    "late/capture",
    "late-observe/capture",
    ...SABOTAGES.map((s) => `sabotage-${s}/capture`),
    "reference",
    "born/receiver",
    "late/receiver",
    "late/receiver-patch",
    "sabotage-size-before-adopt/receiver",
    "late-observe/receiver",
  ];
  const legs: G8hReport["legs"] = {};
  for (const l of legDirs) legs[l] = { exit_code: await exitCode(join(root, l)), skipped: skipped(join(root, l)) };
  const ran = (l: string) => legs[l].exit_code !== null && legs[l].skipped === null;
  const report: G8hReport = { legs, sizes: {}, equivalence: null, pixels: {}, atlas: null, sabotages: {} };

  {
    const problems: string[] = [];
    for (const l of legDirs) {
      if (legs[l].skipped !== null) continue;
      if (legs[l].exit_code !== "0") problems.push(`${l} exit ${legs[l].exit_code}`);
    }
    checks.push(
      check(
        "g8h-legs",
        "every g8h leg that ran (import, the born, late, late-observe and sabotage captures, the rendered reference and every receiver) exits 0",
        problems,
        `${legDirs.filter(ran).length} legs`,
      ),
    );
  }

  const born = await loadRecording(join(root, "born/capture"));
  const late = await loadRecording(join(root, "late/capture"));
  const observe = await loadRecording(join(root, "late-observe/capture"));

  // --- late-size-match -------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (late.bytes && born.bytes) {
      problems = [];
      const lateVp = sessionViewport(late);
      problems.push(...sizeProblems(lateVp, expected).map((p) => `late: ${p}`));
      problems.push(...sizeProblems(sessionViewport(born), expected).map((p) => `born: ${p}`));
      const lateProbe = jsonl<SizeProbe>(await readText(join(root, "late/capture/size.jsonl")));
      const bornProbe = jsonl<SizeProbe>(await readText(join(root, "born/capture/size.jsonl")));
      problems.push(...probeProblems(lateProbe, expected, true).map((p) => `late probe: ${p}`));
      problems.push(...probeProblems(bornProbe, expected, false).map((p) => `born probe: ${p}`));
      // the control: the same late arm without the policy stays degenerate and says so.
      const ovp = sessionViewport(observe);
      if (!observe.bytes) problems.push("late-observe: no recording");
      else if (ovp?.host_size_status !== "degenerate-visible" || !near(ovp.font_oversampling ?? 0, expected.pre_arm.oversampling))
        problems.push(`late-observe: ${JSON.stringify(ovp)}`);
      report.sizes = { late: lateVp ?? null, observe: ovp ?? null, late_probe: lateProbe, born_probe: bornProbe };
    }
    checks.push(
      check(
        "late-size-match",
        `after a late presentation arm the session declares host_size_status match, presentation_size ${expected.logical_size.join("x")} and font_oversampling ${expected.post_arm.oversampling}, and the fixture's own read of the engine agrees (the host was ${expected.pre_arm.window.join("x")} at oversampling ${expected.pre_arm.oversampling} until the arm); the same late arm without the policy stays degenerate-visible`,
        problems,
      ),
    );
  }

  // --- late-size-reference ---------------------------------------------------------------
  {
    let problems: string[] | null = [];
    const pairs: [string, string][] = [
      ["late/receiver", "reference"],
      ["late/receiver-patch", "reference"],
      ["born/receiver", "reference"],
    ];
    let any = false;
    for (const [a, b] of pairs) {
      if (!ran(a) || !ran(b)) {
        problems?.push(`${a} vs ${b}: a leg did not run`);
        continue;
      }
      any = true;
      const rows = [];
      for (const c of expected.checkpoints) {
        const d = await shotDiff(join(root, a), join(root, b), c.step);
        rows.push({ step: c.step, differing: d.differing, max_delta: d.max_delta });
        if (!d.present) problems?.push(`${a} vs ${b} step ${c.step}: shot missing`);
        else if (d.differing > 0) problems?.push(`${a} vs ${b} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`);
      }
      report.pixels[`${a} vs ${b}`] = rows;
    }
    if (!any) problems = null;
    checks.push(
      check(
        "late-size-reference",
        `the native receiver's shots of the late capture (full and patch sinks) and of the born capture equal the 640x360 rendered reference exactly at every checkpoint, the first of them ${expected.settle_frames} frames after the arm`,
        problems,
      ),
    );
  }

  // --- late-size-needed: the control shows the policy is what makes the pixels right -------
  {
    let problems: string[] | null = null;
    if (ran("late-observe/receiver") && ran("reference")) {
      problems = [];
      let differing = 0;
      for (const c of expected.checkpoints)
        differing += (await shotDiff(join(root, "late-observe/receiver"), join(root, "reference"), c.step)).differing;
      report.sabotages["late-observe"] = { differing_px: differing };
      if (differing === 0) problems.push("the unpresented late arm already equals the reference: the fixture cannot tell the policy");
    }
    checks.push(
      check(
        "late-size-needed",
        "the same late arm without presentation: (the 64x64 host's scale-0.1, square-visible-rect evaluation) differs from the 640x360 reference at some checkpoint, so late-size-reference has teeth",
        problems,
        report.sabotages["late-observe"] ? `${report.sabotages["late-observe"].differing_px} px differ` : undefined,
      ),
    );
  }

  // --- late-size-equivalence -------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (born.rec && late.rec) {
      const e = equivalence(born.rec, late.rec, K, 0);
      problems = e.problems;
      report.equivalence = { frames_compared: e.frames, first_problems: e.problems.slice(0, 20) };
    }
    checks.push(
      check(
        "late-size-equivalence",
        `at every frame from the arm (${K}) on, the late capture's resolved state equals the born capture's (presentation: armed at birth) under g8a's id bijection and Q2's exceptions`,
        problems,
        `${report.equivalence?.frames_compared} frames equal`,
      ),
    );
  }

  // --- late-size-atlas -------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (late.rec) {
      const a = atlasProblems(late.rec, K);
      problems = a.problems;
      report.atlas = { textures_drawn: a.textures, frames: a.frames };
    }
    checks.push(
      check(
        "late-size-atlas",
        "every texture a command draws from the arm on (the Labels' glyph atlas pages) is a post-arm create, usable, and no unknown-texture is reported",
        problems,
        report.atlas ? `${report.atlas.textures_drawn} textures drawn over ${report.atlas.frames} frames` : undefined,
      ),
    );
  }

  // --- late-size-account -----------------------------------------------------------------
  {
    const r = await readJson<CaptureResult>(join(root, "late/capture/evidence/result.json"));
    let problems: string[] | null = null;
    if (r) {
      problems = accountProblems(r, expected);
      if (late.rec) {
        const first = late.rec.transactions[0];
        if (!first || first.frame !== K) problems.push(`first transaction at frame ${first?.frame}, expected ${K}`);
        const f = stateAt(late.rec, K);
        if (f && f.state.failures.length > 0) problems.push(`failures ${f.state.failures.map((x) => x.reason)}`);
      }
    }
    checks.push(
      check(
        "late-size-account",
        `the late capture adopts the fixture's ${expected.adopted} items, publishes its first transaction at the arm frame ${K} and fails nothing: the size applied after adoption names no unadopted RID (0 unknown calls under skip) and raises no sticky failure`,
        problems,
      ),
    );
  }

  // --- size-before-adopt -----------------------------------------------------------------
  {
    const dir = join(root, "sabotage-size-before-adopt");
    let problems: string[] | null = null;
    const cap = await loadRecording(join(dir, "capture"));
    if (cap.rec && born.rec && ran("sabotage-size-before-adopt/receiver") && ran("reference")) {
      problems = [];
      const e = equivalence(born.rec, cap.rec, K, 0);
      let differing = 0;
      for (const c of expected.checkpoints)
        differing += (await shotDiff(join(dir, "receiver"), join(root, "reference"), c.step)).differing;
      const failures = new Set<string>();
      for (const t of cap.rec.transactions) for (const f of t.state.failures) failures.add(f.reason);
      const r = await readJson<CaptureResult>(join(dir, "capture/evidence/result.json"));
      const unknownCalls = r?.stream?.unknown_items?.unknown_calls ?? 0;
      report.sabotages["size-before-adopt"] = {
        equivalence_problems: e.problems.length,
        differing_px: differing,
        failures: [...failures].join(","),
        unknown_calls: unknownCalls,
      };
      if (r && accountProblems(r, expected).length === 0)
        problems.push("the account did not change: late-size-account would pass the sabotaged capture");
    }
    checks.push(
      check(
        "sabotage-size-before-adopt",
        "applying the presentation size before the walk (skip) is detected by the account: the relayout names RIDs nothing has adopted, so unknown calls are counted (late-size-account fails). Its state and pixels are recorded: adoption reads the nodes after the resize, so they may still equal born",
        problems,
        report.sabotages["size-before-adopt"]
          ? `${report.sabotages["size-before-adopt"].equivalence_problems} state problems, ${report.sabotages["size-before-adopt"].differing_px} px, ${report.sabotages["size-before-adopt"].unknown_calls} unknown calls, failures [${report.sabotages["size-before-adopt"].failures}]`
          : undefined,
      ),
    );
    const strict = await loadRecording(join(root, "sabotage-size-before-adopt-strict/capture"));
    let sp: string[] | null = null;
    if (strict.rec) {
      sp = [];
      const reasons = new Set<string>();
      for (const t of strict.rec.transactions) for (const f of t.state.failures) reasons.add(f.reason);
      report.sabotages["size-before-adopt-strict"] = { failures: [...reasons].join(",") };
      if (!reasons.has(expected.strict.reason))
        sp.push(`strict failures [${[...reasons]}], expected ${expected.strict.reason}`);
    }
    checks.push(
      check(
        "sabotage-size-before-adopt-strict",
        `under strict unknown-item policy, applying the size before the walk is the sticky ${expected.strict.reason}`,
        sp,
      ),
    );
  }

  return { checks, report };
}
