#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Synthetic g8sw evidence: the honest legs pass every check, each fault fails the check it must,
// missing and skipped evidence fails or is excused as the runner's markers say, and each sabotage
// check is not vacuous (a sabotage leg the rule does not fail is itself a failure).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountingProblems,
  CPU_BOUND_FRACTION,
  HEAP_IN_USE_BOUND_MIB,
  judgeWarmCaptureScale,
  RSS_SLOPE_MB,
  runG8sw,
  slope,
  type WarmCaptureEvidence,
} from "../lib/gate8-swap-checks";

const scratch = join(import.meta.dirname, "../../../../.local");
mkdirSync(scratch, { recursive: true });
const out = mkdtempSync(join(scratch, "self-test-gate8-swap-"));
let assertions = 0;
const ok = (cond: unknown, msg: string) => {
  assertions++;
  assert.ok(cond, msg);
};

const MB = 1024 * 1024;
const PHASE = 300; // frames a phase (the real legs use 240 and 1800)
const SECTION_BASE = [30, 2, 180, 14, 1]; // movers, redraws, mesh_updates, params, churn (us)

interface Opts {
  kind: "swap" | "control";
  n: number;
  /** RssAnon MB at the idle phase of cycle k (control: the constant). */
  rssAnon?: (k: number) => number;
  rssFile?: (k: number) => number;
  rssShmem?: (k: number) => number;
  inUse?: (k: number) => number;
  freeHeap?: (k: number) => number;
  mmapHeap?: (k: number) => number;
  /** keep-* faults applied to every idle row and teardown. */
  fault?: "keep-served" | "keep-listener" | "keep-hub" | "skip-mirror-reset";
  /** Extra tracked-block cost (us) in the swap's idle phases. */
  extraTracked?: number;
  /** Extra callback ns a frame in the swap's idle rows. */
  extraCallbackNs?: number;
  /** Omit these arms' teardown.json (1-based). */
  dropTeardown?: number[];
  exit?: string;
}

const clean = () => ({
  mirror: {
    items: 0,
    canvases: 1,
    textures: 0,
    meshes: 0,
    texture_payload_bytes: 0,
    mesh_payload_bytes: 0,
    held_bytes: 0,
  },
  served_sets: 0,
  served_bytes: 0,
  warm_cache_bytes: 0,
  warm_entries: 0,
  texture_workers_running: false,
  encode_workers_running: false,
  hubs: 0,
  carrier_sets: 0,
  track_hub: false,
  writer_joined: true,
  publisher: false,
  resource_log_held: 0,
  mesh_buffers: 0,
  adopt_held: 0,
  reload_sources_held: 0,
  item_meta: { host_held: 0, filter_watches: 0, calls_while_off: 0 },
  capture_threads: {} as Record<string, number>,
  capture_thread_count: 0,
  threads_total: 16,
  fds_total: 10,
  sockets: 3,
  inet_sockets: 0,
});

const warm = (arm: number): WarmCaptureEvidence => ({
  final: true,
  warm_balanced: true,
  decode_at_reference: 0,
  discarded_stale: 0,
  mispredicts: 0,
  queued: arm === 1 ? 0 : 120,
  warm_complete: true,
  arm_to_warm_complete_ms: 12,
  arm_to_warm_queued_ms: 3,
  reload_us: 1000,
  census_us: 500,
  warm_queue_us: 2000,
  warm_work_us: 9000,
  jobs: arm === 1 ? 0 : 120,
  promoted: 4,
  served_in_flight: 2,
  warm_cache_bytes: 1024,
});

ok(
  accountingProblems("clean", clean()).length === 0,
  "clean reload accounting passes",
);
for (const warm_entries of [1, undefined])
  ok(
    accountingProblems("warm", { ...clean(), warm_entries }).some((p) =>
      p.includes("warm_entries"),
    ),
    "held or missing warm entry count fails accounting",
  );
ok(
  accountingProblems("held", { ...clean(), reload_sources_held: 1 }).some((p) =>
    p.includes("reload_sources_held"),
  ),
  "held reload source fails accounting",
);
ok(
  accountingProblems("missing", {
    ...clean(),
    reload_sources_held: undefined,
  }).some((p) => p.includes("reload_sources_held")),
  "missing reload source count fails accounting",
);

function applyFault(a: ReturnType<typeof clean>, f: Opts["fault"], k: number) {
  if (f === "keep-served") {
    a.served_sets = 1;
    a.served_bytes = 157 * MB;
  } else if (f === "keep-listener") a.inet_sockets = k;
  else if (f === "keep-hub") {
    a.capture_threads = { "grc-former": k };
    a.capture_thread_count = k;
  } else if (f === "skip-mirror-reset") {
    a.mirror.items = 4096;
    a.mirror.textures = 921;
    a.mirror.held_bytes = 157 * MB;
  }
  return a;
}

function writeLeg(dir: string, o: Opts) {
  const ev = join(dir, "evidence");
  mkdirSync(ev, { recursive: true });
  writeFileSync(join(dir, "exit-code.txt"), `${o.exit ?? "0"}\n`);
  const rows: string[] = [];
  const phases: { phase: "idle" | "armed"; cycle: number; arm: number }[] = [];
  if (o.kind === "control") phases.push({ phase: "idle", cycle: 0, arm: 0 });
  for (let k = 0; k < o.n; k++) {
    phases.push({
      phase: "armed",
      cycle: k,
      arm: o.kind === "swap" ? k + 1 : 0,
    });
    phases.push({
      phase: "idle",
      cycle: k + 1,
      arm: o.kind === "swap" ? k + 1 : 0,
    });
  }
  const frames: string[] = [];
  phases.forEach((p, i) => {
    const pf = (i + 1) * PHASE - 1;
    const a = clean();
    if (p.phase === "armed" && o.kind === "swap") {
      a.mirror = {
        ...a.mirror,
        items: 601,
        textures: 921,
        held_bytes: 157 * MB,
        texture_payload_bytes: 157 * MB,
      };
      a.served_sets = 1;
      a.served_bytes = 157 * MB;
      a.hubs = 1;
      a.carrier_sets = 1;
      a.writer_joined = false;
      a.publisher = true;
      a.capture_threads = { "rs-ws-io": 1, "grc-former": 1, "grc-writer": 1 };
      a.capture_thread_count = 3;
      a.threads_total = 19;
      a.inet_sockets = 3;
    } else if (p.phase === "idle" && o.kind === "swap") {
      applyFault(a, o.fault, p.cycle);
    }
    const idle = p.phase === "idle";
    const anon =
      idle && o.kind === "swap"
        ? (o.rssAnon?.(p.cycle) ?? 184)
        : o.kind === "control"
          ? 180
          : 372;
    const file = o.rssFile?.(p.cycle) ?? (o.kind === "control" ? 63 : 78);
    const shmem = o.rssShmem?.(p.cycle) ?? 0;
    rows.push(
      JSON.stringify({
        cycle: p.cycle,
        phase: p.phase,
        control: o.kind === "control",
        arm_index: p.arm,
        start_frame: i * PHASE,
        end_frame: (i + 1) * PHASE,
        process_frame: pf,
        frames: PHASE,
        main_cpu_ns_per_frame: 800000,
        callback_ns_per_frame:
          1500 + (idle && o.kind === "swap" ? (o.extraCallbackNs ?? 0) : 0),
        rss_bytes: Math.round((anon + file + shmem) * MB),
        rss_anon_bytes: Math.round(anon * MB),
        rss_file_bytes: Math.round(file * MB),
        rss_shmem_bytes: Math.round(shmem * MB),
        malloc: {
          uordblks: Math.round((o.inUse?.(p.cycle) ?? 120) * MB),
          fordblks: Math.round((o.freeHeap?.(p.cycle) ?? 20) * MB),
          hblkhd: Math.round((o.mmapHeap?.(p.cycle) ?? 40) * MB),
        },
        ...a,
      }),
    );
    for (let f = pf - PHASE + 1; f <= pf; f++) {
      const sec = [...SECTION_BASE];
      // a little deterministic jitter so the medians are not degenerate
      sec[3] += f % 3;
      if (idle && o.kind === "swap") sec[3] += o.extraTracked ?? 0;
      frames.push(`${f},${800000 + (f % 5) * 1000},${sec.join(",")}`);
    }
  });
  writeFileSync(join(ev, "swap-cycle.jsonl"), `${rows.join("\n")}\n`);
  writeFileSync(join(dir, "frames.csv"), `${frames.join("\n")}\n`);
  if (o.kind === "swap") {
    for (let k = 1; k <= o.n; k++) {
      if (o.dropTeardown?.includes(k)) continue;
      const d = k === 1 ? ev : join(ev, `arm-${k}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "warm.json"), JSON.stringify(warm(k)));
      writeFileSync(
        join(d, "teardown.json"),
        JSON.stringify({
          schema: "render-stream-teardown/1",
          arm_index: k,
          ...applyFault(clean(), o.fault, k),
        }),
      );
    }
  }
}

const SHORT = 3;
const CYCLE = 10;
const SABS = [
  "keep-served",
  "keep-listener",
  "keep-hub",
  "skip-mirror-reset",
] as const;

/** Build a fresh run directory: honest short legs, the four sabotages and (optionally) the cycle legs. */
function build(
  name: string,
  tweak: {
    short?: Partial<Opts>;
    cycle?: Partial<Opts> | false;
    sabotage?: Partial<Record<(typeof SABS)[number], Partial<Opts> | "honest">>;
  } = {},
) {
  const root = join(out, name);
  const g = join(root, "g8sw");
  const sabRss: Record<string, (k: number) => number> = {
    "keep-served": (k) => 180 + 160 * k,
    "skip-mirror-reset": () => 180 + 180,
    "keep-listener": () => 184,
    "keep-hub": () => 184 + 100,
  };
  writeLeg(join(g, "short/swap"), { kind: "swap", n: SHORT, ...tweak.short });
  writeLeg(join(g, "short/control"), { kind: "control", n: SHORT });
  writeLeg(join(g, "short/warm-workers"), { kind: "swap", n: SHORT });
  for (const s of SABS) {
    const t = tweak.sabotage?.[s];
    writeLeg(
      join(g, `short/sabotage-${s}`),
      t === "honest"
        ? { kind: "swap", n: SHORT }
        : { kind: "swap", n: SHORT, fault: s, rssAnon: sabRss[s], ...t },
    );
  }
  if (tweak.cycle !== false) {
    writeLeg(join(g, "cycle/control"), { kind: "control", n: CYCLE });
    writeLeg(join(g, "cycle/swap"), { kind: "swap", n: CYCLE, ...tweak.cycle });
  }
  return { root, g };
}

const verdict = async (root: string) => {
  const r = await runG8sw(root);
  const m = new Map(r.checks.map((c) => [c.id, c]));
  return { m, r };
};
const passes = (m: Map<string, { passed: boolean }>, id: string) => {
  const c = m.get(id);
  ok(c !== undefined, `${id} is reported`);
  return c?.passed === true;
};
const IDS = [
  "swap-accounting",
  "warm-capture-scale",
  "swap-cycle-threads",
  "swap-cycle-fds",
  "swap-cycle-rss",
  "swap-cycle-standby-cpu",
  "sabotage-keep-served-caught",
  "sabotage-keep-listener-caught",
  "sabotage-keep-hub-caught",
  "sabotage-skip-mirror-reset-caught",
];

try {
  ok(Math.abs(slope([1, 2, 3], [1, 3, 5]) - 2) < 1e-9, "slope of a line");

  const arms = [warm(1), warm(2), warm(3)];
  const judgeWarm = (a = arms, t = [clean(), clean(), clean()]) =>
    judgeWarmCaptureScale("workers", a, t);
  const honest = judgeWarm();
  ok(
    honest.rule.length === 0 && honest.evidence.length === 0,
    "warm scale passes",
  );
  for (const field of [
    "arm_to_warm_complete_ms",
    "arm_to_warm_queued_ms",
    "reload_us",
    "census_us",
    "warm_queue_us",
    "warm_work_us",
    "queued",
    "jobs",
    "promoted",
    "served_in_flight",
    "warm_cache_bytes",
  ])
    ok(honest.detail.includes(`"${field}":`), `warm reports ${field}`);
  for (let k = 0; k < 3; k++) {
    for (const patch of [
      { final: false },
      { warm_balanced: false },
      { decode_at_reference: 1 },
      { discarded_stale: 1 },
      { mispredicts: 1 },
      ...(k > 0
        ? [{ queued: 99 }, { queued: Number.NaN }, { warm_complete: false }]
        : []),
    ]) {
      const bad = arms.map((w, i) => (i === k ? { ...w, ...patch } : w));
      ok(
        judgeWarm(bad).rule.length > 0,
        `arm ${k + 1} rejects ${JSON.stringify(patch)}`,
      );
    }
    const missing = [...arms];
    delete missing[k];
    ok(judgeWarm(missing).evidence.length > 0, `missing arm ${k + 1} fails`);
    const missingTeardown = [clean(), clean(), clean()];
    delete missingTeardown[k];
    ok(
      judgeWarm(arms, missingTeardown).evidence.length > 0,
      `missing teardown ${k + 1} fails`,
    );
    const held = [clean(), clean(), clean()];
    held[k].warm_entries = 1;
    ok(
      judgeWarm(arms, held).rule.length > 0,
      `held warm in teardown ${k + 1} fails`,
    );
  }
  const unbounded = arms.map((w) => ({
    ...w,
    arm_to_warm_complete_ms: 1e9,
    warm_cache_bytes: 1e12,
  }));
  ok(
    judgeWarm(unbounded).rule.length === 0,
    "timing and bytes are reported without bounds",
  );

  for (const leg of ["short/swap", "short/warm-workers"]) {
    const { root, g } = build(`warm-missing-${leg.replaceAll("/", "-")}`);
    rmSync(join(g, leg, "evidence/arm-2/warm.json"));
    ok(
      !passes((await verdict(root)).m, "warm-capture-scale"),
      `${leg} missing warm fails`,
    );
  }

  // --- honest: everything passes, the ids are exactly the contract's -------------------------
  {
    const { root } = build("honest");
    const { m, r } = await verdict(root);
    ok(
      JSON.stringify(r.checks.map((c) => c.id)) === JSON.stringify(IDS),
      `check ids ${r.checks.map((c) => c.id)}`,
    );
    for (const id of IDS)
      ok(passes(m, id), `honest passes ${id}: ${m.get(id)?.detail}`);
  }

  // --- swap-accounting: each field of the rule, in a teardown and in an idle row ---------------
  for (const [label, fault] of [
    ["served set kept", "keep-served"],
    ["mirror kept", "skip-mirror-reset"],
  ] as const) {
    const { root } = build(`acct-${fault}`, { short: { fault } });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-accounting"), `${label} fails swap-accounting`);
    ok(
      m.get("swap-accounting")?.detail?.includes("arm 1 teardown"),
      "names the teardown",
    );
  }
  {
    // a missing arm's teardown.json is missing evidence, not a pass
    const { root } = build("acct-missing", { short: { dropTeardown: [2] } });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-accounting"), "a missing teardown.json fails");
    ok(
      m.get("swap-accounting")?.detail?.includes("arm 2: no teardown.json"),
      "names arm 2",
    );
  }
  {
    const { root } = build("acct-exit", { short: { exit: "1" } });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-accounting"), "a nonzero exit fails swap-accounting");
  }

  // --- threads / fds -----------------------------------------------------------------------------
  {
    const { root } = build("threads", { short: { fault: "keep-hub" } });
    const { m } = await verdict(root);
    ok(
      !passes(m, "swap-cycle-threads"),
      "a thread left in an idle row fails swap-cycle-threads",
    );
    ok(passes(m, "swap-cycle-fds"), "...and not the fds check");
  }
  {
    const { root } = build("fds", { short: { fault: "keep-listener" } });
    const { m } = await verdict(root);
    ok(
      !passes(m, "swap-cycle-fds"),
      "a socket left in an idle row fails swap-cycle-fds",
    );
    ok(passes(m, "swap-cycle-threads"), "...and not the threads check");
  }

  // --- RSS: the level, the slope, and the control ---------------------------------------------
  {
    const { root } = build("rss-level", { short: { inUse: () => 120 + 1.01 } });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-cycle-rss"), "an in-use heap offset over 1 MiB fails");
    const { root: r2 } = build("rss-in", {
      short: { rssAnon: () => 180 + 17, inUse: () => 120 + 0.1 },
    });
    ok(
      passes((await verdict(r2)).m, "swap-cycle-rss"),
      "a constant 17 MiB anon offset with near-zero in-use delta passes",
    );
  }
  {
    const { root } = build("rss-first-cycle", {
      short: { rssAnon: (k) => 180 + (k === 1 ? 0 : 17) },
      cycle: { rssAnon: (k) => 180 + (k === 1 ? 0 : 17) },
    });
    ok(
      passes((await verdict(root)).m, "swap-cycle-rss"),
      "one-time anon residency is excluded from both slope windows",
    );
  }
  {
    const s = 0.75;
    const { root } = build("rss-slope", {
      short: { rssAnon: (k) => 180 + s * k },
    });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-cycle-rss"), "a drift over the slope bound fails");
    ok(
      m.get("swap-cycle-rss")?.detail?.includes("slope over cycles 2-3"),
      "names the slope",
    );
  }
  {
    // the cycle legs are judged with the same rule
    const { root } = build("rss-cycle", {
      cycle: { rssAnon: (k) => 180 + 0.6 * k },
    });
    const { m } = await verdict(root);
    ok(!passes(m, "swap-cycle-rss"), "a cycle-leg drift fails swap-cycle-rss");
    ok(
      m.get("swap-cycle-rss")?.detail?.includes("cycle/swap"),
      "names cycle/swap",
    );
  }

  {
    const { root } = build("rss-file-shmem", {
      short: {
        rssFile: (k) => 200 + 20 * k,
        rssShmem: (k) => 100 + 10 * k,
        freeHeap: (k) => 100 + 20 * k,
        mmapHeap: (k) => 100 + 30 * k,
      },
    });
    const { m, r } = await verdict(root);
    ok(
      passes(m, "swap-cycle-rss"),
      "file and shared RSS are reported without bounds",
    );
    const report = JSON.stringify(r.report.rss);
    ok(
      report.includes("rss_file") &&
        report.includes("rss_shmem") &&
        report.includes("malloc_fordblks") &&
        report.includes("malloc_hblkhd"),
      "reports all unbounded residency components",
    );
  }
  ok(
    HEAP_IN_USE_BOUND_MIB.short === 1 && HEAP_IN_USE_BOUND_MIB.cycle === 1,
    "in-use heap offset bound stays 1 MiB",
  );
  ok(
    RSS_SLOPE_MB.short === 0.5 && RSS_SLOPE_MB.cycle === 0.5,
    "anon slope bound stays 0.5 MB/cycle",
  );

  // --- standby CPU: judged on the cycle legs only ---------------------------------------------
  {
    const bound = 800 * CPU_BOUND_FRACTION; // us; the control's median is ~802 us
    const { root } = build("cpu-in", { cycle: { extraTracked: bound / 2 } });
    ok(
      passes((await verdict(root)).m, "swap-cycle-standby-cpu"),
      "a cost inside 1% passes",
    );
    const { root: r2 } = build("cpu-out", {
      cycle: { extraTracked: bound * 2 },
    });
    const v = await verdict(r2);
    ok(!passes(v.m, "swap-cycle-standby-cpu"), "a tracked cost over 1% fails");
    const { root: r3 } = build("cpu-cb", {
      cycle: { extraCallbackNs: bound * 2000 },
    });
    ok(
      !passes((await verdict(r3)).m, "swap-cycle-standby-cpu"),
      "a callback cost over 1% fails",
    );
    // short legs only report: the same cost on short/swap passes everything
    const { root: r4 } = build("cpu-short", {
      short: { extraTracked: bound * 4 },
    });
    const v4 = await verdict(r4);
    ok(
      passes(v4.m, "swap-cycle-standby-cpu"),
      "a short-leg cost is reported, not judged",
    );
    const report = v4.r.report.cpu as Record<
      string,
      { deltas: { delta_us: number }[] }
    >;
    ok(
      report["short/swap"].deltas.length === SHORT,
      "the short deltas are in the report",
    );
  }

  // --- skipped timing group: cycle-only evidence missing, named so tier-verdict excuses it -------
  {
    const { root, g } = build("skipped", { cycle: false });
    for (const l of ["cycle/control", "cycle/swap"]) {
      mkdirSync(join(g, l), { recursive: true });
      writeFileSync(
        join(g, l, "skipped-remote.txt"),
        "skipped-remote: timing group swap-cycle\n",
      );
    }
    const { m } = await verdict(root);
    for (const id of IDS.filter((x) => x !== "swap-cycle-standby-cpu"))
      ok(
        passes(m, id),
        `skipped cycle legs: ${id} still passes on the short legs`,
      );
    const c = m.get("swap-cycle-standby-cpu");
    ok(c?.passed === false, "the cycle-only check fails without its legs");
    ok(
      c?.detail?.includes("skipped-remote") && c.detail.includes("swap-cycle"),
      "and names the skipped group",
    );
  }
  {
    // never launched at all: the same failure
    const { m } = await verdict(build("nocycle", { cycle: false }).root);
    ok(
      !passes(m, "swap-cycle-standby-cpu"),
      "no cycle legs fails the cycle-only check",
    );
  }

  // --- the sabotage checks: each needs its own rule to fail, and is not vacuous -------------------
  for (const [sab, id] of [
    ["keep-served", "sabotage-keep-served-caught"],
    ["keep-listener", "sabotage-keep-listener-caught"],
    ["keep-hub", "sabotage-keep-hub-caught"],
    ["skip-mirror-reset", "sabotage-skip-mirror-reset-caught"],
  ] as const) {
    const { root } = build(`sab-${sab}-honest`, {
      sabotage: { [sab]: "honest" },
    });
    const { m } = await verdict(root);
    ok(!passes(m, id), `${id} fails when the sabotage leg obeys the rule`);
    ok(
      m.get(id)?.detail?.includes("did not fail"),
      `${id} says the rule did not fail`,
    );
    for (const other of SABS.filter((s) => s !== sab))
      ok(
        passes(m, `sabotage-${other}-caught`),
        `...and leaves sabotage-${other}-caught alone`,
      );
  }
  {
    // keep-served must fail BOTH rules: the accounting alone is not enough
    const { root } = build("sab-served-no-rss", {
      sabotage: { "keep-served": { fault: "keep-served", rssAnon: () => 184 } },
    });
    const { m } = await verdict(root);
    ok(
      !passes(m, "sabotage-keep-served-caught"),
      "keep-served needs swap-cycle-rss to fail too",
    );
  }
  {
    // a tier-skipped sabotage leg is missing evidence, never a catch
    const { root: r2, g } = build("sab-skipped");
    rmSync(join(g, "short/sabotage-keep-hub"), {
      recursive: true,
      force: true,
    });
    mkdirSync(join(g, "short/sabotage-keep-hub"), { recursive: true });
    writeFileSync(
      join(g, "short/sabotage-keep-hub/skipped-by-tier.txt"),
      "skipped-by-tier: RS_SABOTAGE_TIER=skip\n",
    );
    const v = await verdict(r2);
    ok(
      !passes(v.m, "sabotage-keep-hub-caught"),
      "a tier-skipped sabotage leg is missing evidence",
    );
    ok(
      v.m.get("sabotage-keep-hub-caught")?.detail?.includes("skipped-by-tier"),
      "and says so",
    );
  }

  console.log(`self-test-gate8-swap: ${assertions} assertions passed`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
