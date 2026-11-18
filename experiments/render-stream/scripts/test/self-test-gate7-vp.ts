// VS5b self-test: lib/gate7-vp.ts (arm order, the frame-interval distribution, the per-arm
// measure over synthetic sweep directories, void arms, A-vs-A / B-vs-B agreement, the build and
// surface checks), the foreground parser in lib/device-sampler.ts, the `vp` harness word in
// lib/gate7-live-legs.ts, and the runner's wiring (lib/gate6c-legs.sh "VS5b", run-gate7.sh). No
// phone, no browser, no Godot.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseMeminfoPss,
  parseTopResumedActivity,
} from "../lib/device-sampler";
import { mapBrowserLeg } from "../lib/gate7-live-legs";
import {
  AGREEMENT_MAX,
  abbaArms,
  distribution,
  findSweeps,
  graphicsKb,
  parseArms,
  pssTotals,
  summarizeSweep,
} from "../lib/gate7-vp";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}
const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// --- order -------------------------------------------------------------------------------------
expect("abbaArms(1) is A1,B1,B2,A2", abbaArms(1).join(",") === "A1,B1,B2,A2");
expect(
  "abbaArms(2) continues A3,B3,B4,A4",
  abbaArms(2).join(",") === "A1,B1,B2,A2,A3,B3,B4,A4",
);
expect(
  "parseArms keeps the given order",
  parseArms("A1,B1,B2,A2").join(",") === "A1,B1,B2,A2",
);
expect(
  "parseArms refuses H, duplicates, a missing kind",
  ["A1,H", "A1,B1,A1", "A1,A2", "B1,B2", "A1,,B1"].every((s) =>
    throws(() => parseArms(s)),
  ),
);

// --- distribution ------------------------------------------------------------------------------
const d = distribution([...Array(90).fill(16.7), ...Array(9).fill(33.4), 60]);
expect(
  "distribution: quantiles, tail fractions and 2-ms bins",
  d.count === 100 &&
    d.p50 === 16.7 &&
    d.p95 === 33.4 &&
    d.max === 60 &&
    Math.abs((d.over_17_fraction ?? 0) - 0.1) < 1e-9 &&
    Math.abs((d.over_34_fraction ?? 0) - 0.01) < 1e-9 &&
    d.hist_ms["16"] === 90 &&
    d.hist_ms["32"] === 9 &&
    d.hist_ms["60"] === 1,
  JSON.stringify(d),
);
expect(
  "distribution: empty is all null",
  distribution([]).p50 === null && distribution([]).over_34_fraction === null,
);

// --- foreground: the three formats seen on phones -------------------------------------------
const chrome = parseTopResumedActivity(
  "  topResumedActivity=ActivityRecord{a1b2c3 u0 com.android.chrome/com.google.android.apps.chrome.Main t42}\n",
);
// The moto g31 (Android 12): no topResumedActivity line; mResumedActivity: and ResumedActivity:.
const g31Dump =
  "    ResumedActivity: ActivityRecord{474f113 u0 com.motorola.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher t34564}\n" +
  "  mResumedActivity: ActivityRecord{474f113 u0 com.motorola.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher t34564}\n";
const g31 = parseTopResumedActivity(g31Dump);
const g31Res = parseTopResumedActivity(
  "    ResumedActivity: ActivityRecord{8c1d2e0 u0 com.android.chrome/com.google.android.apps.chrome.Main t34570}\n",
);
const both = parseTopResumedActivity(
  `${g31Dump}  topResumedActivity=ActivityRecord{1 u0 com.android.chrome/com.google.android.apps.chrome.Main t2}\n`,
);
expect(
  "parseTopResumedActivity: topResumedActivity= (Chrome)",
  chrome.package === "com.android.chrome" &&
    chrome.format === "topResumedActivity",
  JSON.stringify(chrome),
);
expect(
  "parseTopResumedActivity: the g31's mResumedActivity: wins over ResumedActivity: (launcher), the raw line kept",
  g31.package === "com.motorola.launcher3" &&
    g31.format === "mResumedActivity" &&
    g31.line?.startsWith("mResumedActivity: ActivityRecord{474f113") === true,
  JSON.stringify(g31),
);
expect(
  "parseTopResumedActivity: ResumedActivity: alone (Chrome)",
  g31Res.package === "com.android.chrome" &&
    g31Res.format === "ResumedActivity",
  JSON.stringify(g31Res),
);
expect(
  "parseTopResumedActivity: topResumedActivity= wins when present",
  both.format === "topResumedActivity" && both.package === "com.android.chrome",
  JSON.stringify(both),
);
expect(
  "parseTopResumedActivity: no line is unknown",
  parseTopResumedActivity("").package === null &&
    parseTopResumedActivity("").format === null,
);

// --- meminfo graphics rows ---------------------------------------------------------------------
const MEMINFO = `** MEMINFO in pid 11102 [com.android.chrome:privileged_process0] **
                   Pss  Private  Private  SwapPss      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap     9876     9800        0     1200    11000    20480    15000     5480
        Gfx dev     2048     2048        0        0     2048
      EGL mtrack    12345    12345        0        0    12345
       GL mtrack    23456    23456        0        0    23456
          TOTAL    57170    50000     1000     3000    60000    20480    15000     5480

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:        0                              0
            Graphics:    37849                          37849
           TOTAL PSS:    57170            TOTAL RSS:    60000       TOTAL SWAP PSS:     3000
`;
const mi = parseMeminfoPss(MEMINFO, 11102);
expect(
  "parseMeminfoPss: TOTAL PSS plus Graphics, GL mtrack, EGL mtrack and Gfx dev, raw lines kept",
  mi.pss_kb === 57170 &&
    mi.graphics?.graphics_kb === 37849 &&
    mi.graphics.gl_mtrack_kb === 23456 &&
    mi.graphics.egl_mtrack_kb === 12345 &&
    mi.graphics.gfx_dev_kb === 2048 &&
    mi.graphics.lines.length === 4,
  JSON.stringify(mi),
);
expect(
  "parseMeminfoPss: a dump without graphics rows adds no graphics key",
  parseMeminfoPss("** MEMINFO in pid 1 [x] **\n TOTAL PSS: 5\n", 1).graphics ===
    undefined,
);
const noRows = {
  graphics_kb: null,
  gl_mtrack_kb: null,
  egl_mtrack_kb: null,
  gfx_dev_kb: null,
  lines: [],
};
expect(
  "graphicsKb: Graphics: when present, else the mtrack/Gfx dev sum, else null",
  graphicsKb(mi.graphics) === 37849 &&
    graphicsKb({ ...noRows, gl_mtrack_kb: 10, egl_mtrack_kb: 5 }) === 15 &&
    graphicsKb(noRows) === null,
);

// --- the harness word --------------------------------------------------------------------------
const mapped = mapBrowserLeg(
  "/static",
  [
    ["RS_RECEIVER_MODE", "live"],
    ["RS_RECEIVER_OUT", "/static/x/applied.json"],
    ["RS_RECEIVER_DEV_PROBE", "fit"],
    ["RS_RECEIVER_DEV_SAMPLE", "vp"],
    ["RS_RECEIVER_PROTOCOL", "16"],
    ["RS_RECEIVER_VIEWPORTS", "off"],
    ["RS_RECEIVER_LIVE_STOP_S", "32"],
  ],
  ["godot"],
);
expect(
  "mapBrowserLeg: RS_RECEIVER_DEV_SAMPLE=vp is a harness word; VIEWPORTS and LIVE_STOP_S reach the page",
  mapped.devSample === "vp" &&
    mapped.env.RS_RECEIVER_DEV_SAMPLE === undefined &&
    mapped.env.RS_RECEIVER_VIEWPORTS === "off" &&
    mapped.env.RS_RECEIVER_LIVE_STOP_S === "32",
  JSON.stringify({ devSample: mapped.devSample, env: mapped.env }),
);

// --- synthetic sweeps --------------------------------------------------------------------------
// One host at 60 Hz for 300 s; arm k (1-based, in order) is connection k, connected 60 s at
// [60 (k - 1) + 2, 60 k - 2) s. A receiver draws each transaction on the next 17-ms tick
// (`every` > 1: only every `every`-th transaction, the rest folded).
const H = 1e6 / 60;
interface ArmSpec {
  arm: string;
  every?: number;
  build?: string;
  allocated?: number;
  foreground?: string[];
  exit?: string;
}
function writeSweep(
  root: string,
  run: string,
  specs: ArmSpec[],
  device: boolean,
): string {
  const dir = join(
    root,
    "gate6",
    run,
    "rates",
    `dev-vp-${run.replace(/^.*-vp-/, "")}`,
  );
  const host = join(dir, "host");
  mkdirSync(join(host, "evidence"), { recursive: true });
  const conns: { connection: number; stream_id: string }[] = [];
  const timeline: unknown[] = [];
  const span = (k: number) => [(60 * (k - 1) + 2) * 1e6, (60 * k - 2) * 1e6];
  const sent = specs.map(() => 0);
  for (let f = 0; f < 60 * 60 * specs.length; f++) {
    const t = f * H;
    const open: unknown[] = [];
    specs.forEach((_, i) => {
      const [a, b] = span(i + 1);
      if (t >= a && t < b) {
        sent[i]++;
        open.push({
          connection: i + 1,
          sent: sent[i],
          credits: sent[i],
          coalesced: 0,
          ticks_credit_blocked: 0,
          max_pending_age_us: 0,
          bytes_sent: sent[i] * 100,
          acks: [sent[i], sent[i], sent[i]],
          credit_rtt_count: sent[i],
          credit_rtt_sum_us: sent[i] * 12000,
          credit_rtt_frames_sum: sent[i],
        });
      }
    });
    if (f % 60 === 0) timeline.push({ t_us: t, frame: f, connections: open });
  }
  writeFileSync(
    join(host, "evidence", "perf-timeline.jsonl"),
    timeline.map((l) => JSON.stringify(l)).join("\n"),
  );
  writeFileSync(join(host, "steps.jsonl"), "");
  specs.forEach((s, i) => {
    const k = i + 1;
    conns.push({ connection: k, stream_id: `s${k}` });
    const A = join(dir, s.arm);
    const R = join(A, "receiver");
    mkdirSync(R, { recursive: true });
    symlinkSync("../host", join(A, "host"));
    const off = s.arm.startsWith("B");
    writeFileSync(
      join(A, "dev-leg.json"),
      JSON.stringify({
        leg: `dev-vp-x-${s.arm}`,
        base: "vp-x",
        run: k,
        workload: "vp-x",
        arm: s.arm,
        order: k,
        viewports_client: !off,
        viewports_host: "on",
        time_offset_s: 0,
        soak: false,
        soak_s: 0,
        receiver_max_fps: 0,
        env: device ? "device" : "desktop",
        receiver_words: "",
      }),
    );
    const [a, b] = span(k);
    const offset = 5e6; // receiver clock - host clock (us)
    const tx: unknown[] = [];
    const samples: string[] = [];
    let seq = 0;
    for (let f = Math.ceil(a / H); f * H < b; f++) {
      seq++;
      const recv = f * H + offset + 3000;
      const drawMs = Math.ceil(recv / 1000 / 17) * 17;
      const fold = (s.every ?? 1) > 1 && seq % (s.every ?? 1) !== 0;
      tx.push({
        seq,
        frame: f,
        received_us: recv,
        submitted_us: drawMs * 1000 + 500,
        ...(fold ? { coalesced_into: seq + 1 } : {}),
      });
      if (!fold)
        samples.push(
          JSON.stringify({
            seq,
            raf_ts_ms: drawMs,
            total_us: 2000,
            t_ms: drawMs + 2,
          }),
        );
    }
    const pageFirst = 1000;
    const raf: number[] = [];
    for (let ts = 0; ts < 56_000; ts += 17) raf.push(ts, ts + 0.2, 2);
    writeFileSync(
      join(R, "applied.json"),
      JSON.stringify({
        streams: [{ stream_id: `s${k}` }],
        transactions: tx,
        live: {
          gsw: {
            surfaces: off
              ? {
                  viewports: false,
                  surfaces_rendered: 0,
                  surfaces_skipped: 6,
                  surfaces_unchanged: 0,
                  surfaces_allocated: 0,
                  surface_pixels: 0,
                }
              : {
                  viewports: true,
                  surfaces_rendered: 6,
                  surfaces_skipped: 0,
                  surfaces_unchanged: 0,
                  surfaces_allocated: s.allocated ?? 6,
                  surface_pixels: 700000,
                },
          },
          harness_stop: { after_s: 32, last_accepted_seq: seq },
        },
      }),
    );
    writeFileSync(join(R, "perf-timeline.jsonl"), samples.join("\n"));
    writeFileSync(join(R, "perf.json"), JSON.stringify({ histograms: {} }));
    writeFileSync(
      join(R, "dev-probe.json"),
      JSON.stringify({
        schema: "render-stream-gate7-dev-probe/1",
        raf,
        ws: [],
        first_ws_ms: pageFirst,
        hidden_ms: 0,
      }),
    );
    writeFileSync(join(R, "exit-code.txt"), `${s.exit ?? "0"}\n`);
    if (device) {
      const fg = (
        s.foreground ?? [
          "com.android.chrome",
          "com.android.chrome",
          "com.android.chrome",
        ]
      ).map((p, j) => ({
        t_ms: j * 10_000,
        package: p === "" ? null : p,
        browser: p === "com.android.chrome",
        line:
          p === "" ? null : `mResumedActivity: ActivityRecord{x u0 ${p}/.M t1}`,
      }));
      writeFileSync(join(R, "provenance.json"), JSON.stringify({ ok: true }));
      writeFileSync(
        join(R, "device.json"),
        JSON.stringify({
          conditions_before: { thermalStatus: "none", batteryPct: 80 },
          conditions_after: { thermalStatus: "light", batteryPct: 79 },
          samples: {
            device: {
              gpu_memory: [
                { t_ms: 0, bytes: 50e6 },
                { t_ms: 40_000, bytes: off ? 52e6 : 60e6 },
              ],
              meminfo: [
                {
                  t_ms: 0,
                  samples: [
                    {
                      pid: 1,
                      process: "com.android.chrome:sandboxed_process0:x:0",
                      pss_kb: 100_000,
                      error: null,
                      graphics: {
                        graphics_kb: 1_000,
                        gl_mtrack_kb: null,
                        egl_mtrack_kb: null,
                        gfx_dev_kb: null,
                        lines: [],
                      },
                    },
                    {
                      pid: 2,
                      process: "com.android.chrome:privileged_process0",
                      pss_kb: 50_000,
                      error: null,
                      graphics: {
                        graphics_kb: 30_000,
                        gl_mtrack_kb: null,
                        egl_mtrack_kb: null,
                        gfx_dev_kb: null,
                        lines: [],
                      },
                    },
                  ],
                },
                {
                  t_ms: 40_000,
                  samples: [
                    {
                      pid: 1,
                      process: "com.android.chrome:sandboxed_process0:x:0",
                      pss_kb: 110_000,
                      error: null,
                      graphics: {
                        graphics_kb: 1_200,
                        gl_mtrack_kb: null,
                        egl_mtrack_kb: null,
                        gfx_dev_kb: null,
                        lines: [],
                      },
                    },
                    {
                      pid: 2,
                      process: "com.android.chrome:privileged_process0",
                      pss_kb: off ? 52_000 : 60_000,
                      error: null,
                      graphics: {
                        graphics_kb: off ? 32_000 : 38_000,
                        gl_mtrack_kb: null,
                        egl_mtrack_kb: null,
                        gfx_dev_kb: null,
                        lines: [],
                      },
                    },
                  ],
                },
              ],
              foreground: fg,
              derated: false,
            },
            js_heap: [],
          },
        }),
      );
      writeFileSync(
        join(A, "chrome-stop.json"),
        JSON.stringify({ chrome_pids: "", top_resumed_activity: "launcher" }),
      );
    }
    writeFileSync(
      join(A, "identity.json"),
      JSON.stringify({
        build_id: s.build ?? "b".repeat(64),
        bundle_matches_declared: true,
        rs_core_tree_at_arm: "abc123",
      }),
    );
  });
  writeFileSync(
    join(host, "evidence", "live-summary.json"),
    JSON.stringify({ connections: conns }),
  );
  if (device) {
    const wrap = join(root, "gate6", `${run}.sweep`);
    mkdirSync(wrap, { recursive: true });
    writeFileSync(join(wrap, "phone-lock.json"), JSON.stringify({ wait_s: 0 }));
  }
  writeFileSync(
    join(dir, "sweep.json"),
    JSON.stringify({
      arms: specs.map((s) => s.arm).join(","),
      host_off: false,
    }),
  );
  return dir;
}

const root = mkdtempSync(join(tmpdir(), "self-test-gate7-vp-"));
try {
  const abba = (o: Partial<Record<string, Partial<ArmSpec>>> = {}): ArmSpec[] =>
    ["A1", "B1", "B2", "A2"].map((arm) => ({ arm, ...(o[arm] ?? {}) }));

  writeSweep(root, "ctl-gsw-w2-vp-vfx6", abba(), false);
  const good = summarizeSweep(
    "ctl-gsw-w2-vp-vfx6",
    join(root, "gate6/ctl-gsw-w2-vp-vfx6/rates/dev-vp-vfx6"),
  );
  expect(
    "findSweeps finds the sweep",
    findSweeps(root).length === 1 &&
      findSweeps(root)[0].run === "ctl-gsw-w2-vp-vfx6",
  );
  expect(
    "desktop ABBA: four arms in order, each measured at its own connection (~60 fps, p50 17 ms)",
    good !== undefined &&
      good.arms.map((a) => a.arm).join(",") === "A1,B1,B2,A2" &&
      good.arms.every(
        (a) =>
          !a.void &&
          Math.abs((a.metrics.drawn_fps ?? 0) - 60) < 0.5 &&
          a.frame_interval_ms.p50 === 17,
      ),
    JSON.stringify(
      good?.arms.map((a) => [
        a.arm,
        a.metrics.drawn_fps,
        a.frame_interval_ms.p50,
        a.void_reasons,
      ]),
    ),
  );
  expect(
    "desktop ABBA: admissible (A-vs-A and B-vs-B agree, builds equal, A allocated / B skipped); foreground unavailable",
    good?.admissible === true &&
      good.a_vs_a.arms?.join(",") === "A1,A2" &&
      good.b_vs_b.arms?.join(",") === "B1,B2" &&
      good.build_check.ok &&
      good.surface_check.ok &&
      good.arms[0].foreground === "unavailable",
    JSON.stringify(good?.admissible_reasons),
  );

  writeSweep(
    root,
    "dev-g31-gsw-w2-vp-draw-active",
    abba({
      B2: {
        foreground: [
          "com.android.chrome",
          "com.motorola.launcher3",
          "com.android.chrome",
        ],
      },
    }),
    true,
  );
  const fg = summarizeSweep(
    "dev-g31-gsw-w2-vp-draw-active",
    join(root, "gate6/dev-g31-gsw-w2-vp-draw-active/rates/dev-vp-draw-active"),
  );
  const b2 = fg?.arms.find((a) => a.arm === "B2");
  expect(
    "device: an arm whose browser was not in front is void and the sweep not admissible",
    fg?.env === "device" &&
      b2?.void === true &&
      /not in front/.test(b2.void_reasons.join()) &&
      fg.admissible === false &&
      fg.void_arms.join() === "B2" &&
      fg.b_vs_b.arms === null,
    JSON.stringify(b2?.void_reasons),
  );
  const a1 = fg?.arms.find((a) => a.arm === "A1");
  expect(
    "device: PSS and gfxinfo before/after, thermal and battery recorded",
    a1?.pss_kb.before === 150_000 &&
      a1.pss_kb.after === 170_000 &&
      a1.gpu_memory_bytes.after === 60e6 &&
      a1.thermal.after === "light" &&
      a1.battery.before === 80,
    JSON.stringify(
      a1 && { pss: a1.pss_kb, gpu: a1.gpu_memory_bytes, t: a1.thermal },
    ),
  );
  expect(
    "device: B against A means (gfxinfo after 52 vs 60 MB)",
    fg?.a_vs_b.gpu_memory_after_bytes.a === 60e6 &&
      fg.a_vs_b.gpu_memory_after_bytes.b === 52e6,
    JSON.stringify(fg?.a_vs_b.gpu_memory_after_bytes),
  );

  expect(
    "device: A-minus-B of the GPU process's graphics memory (38 - 32 MB) and the analytic surface bytes (700000 px x 4)",
    fg?.a_vs_b.gpu_proc_graphics_after_kb.a_minus_b === 6_000 &&
      fg.a_vs_b.renderer_graphics_after_kb.a_minus_b === 0 &&
      fg.a_vs_b.surface_bytes.a === 2_800_000 &&
      fg.a_vs_b.surface_bytes.b === 0 &&
      fg.a_vs_b.surface_bytes.a_minus_b === 2_800_000 &&
      a1?.graphics_kb !== "unavailable" &&
      a1?.graphics_kb.before.gpu_process_kb === 30_000,
    JSON.stringify(fg?.a_vs_b.gpu_proc_graphics_after_kb),
  );
  expect(
    "device: the summary's memory number is surface_bytes, the observed figures are labelled not surface cost",
    fg?.memory.surface_bytes.a_minus_b === 2_800_000 &&
      /allocation accounting/.test(fg.memory.note) &&
      /not surface cost/.test(fg.memory.note),
  );
  writeSweep(
    root,
    "dev-g31-gsw-w1-vp-vfx6",
    abba({ A1: { foreground: ["", "", ""] } }),
    true,
  );
  const unk = summarizeSweep(
    "dev-g31-gsw-w1-vp-vfx6",
    join(root, "gate6/dev-g31-gsw-w1-vp-vfx6/rates/dev-vp-vfx6"),
  );
  const ua1 = unk?.arms.find((a) => a.arm === "A1");
  expect(
    "device: no resumed-activity line is unknown, not a void (the g31 case)",
    ua1?.void === false &&
      ua1.foreground_unknown === 3 &&
      unk?.admissible === true,
    JSON.stringify({
      reasons: ua1?.void_reasons,
      adm: unk?.admissible_reasons,
    }),
  );

  writeSweep(
    root,
    "ctl-gsw-w2-vp-draw-idle",
    abba({ A2: { build: "c".repeat(64) } }),
    false,
  );
  const bm = summarizeSweep(
    "ctl-gsw-w2-vp-draw-idle",
    join(root, "gate6/ctl-gsw-w2-vp-draw-idle/rates/dev-vp-draw-idle"),
  );
  expect(
    "a build id that differs in one arm fails the build check",
    bm?.build_check.ok === false &&
      bm.admissible === false &&
      /build ids differ/.test(bm.build_check.problems.join()),
  );

  writeSweep(root, "ctl-gsw-w1-vp-vfx6", abba({ A1: { allocated: 0 } }), false);
  const sm = summarizeSweep(
    "ctl-gsw-w1-vp-vfx6",
    join(root, "gate6/ctl-gsw-w1-vp-vfx6/rates/dev-vp-vfx6"),
  );
  expect(
    "an A arm that allocated no surface fails the surface check",
    sm?.surface_check.ok === false && sm.admissible === false,
  );

  writeSweep(
    root,
    "ctl-gsw-w1-vp-draw-active",
    abba({ A2: { every: 2 } }),
    false,
  );
  const dr = summarizeSweep(
    "ctl-gsw-w1-vp-draw-active",
    join(root, "gate6/ctl-gsw-w1-vp-draw-active/rates/dev-vp-draw-active"),
  );
  expect(
    `A2 at half the rate: A-vs-A fps spread above ${AGREEMENT_MAX * 100}% and not admissible; B-vs-B still agrees`,
    dr?.a_vs_a.within === false &&
      (dr.a_vs_a.spread.drawn_fps ?? 0) > 0.5 &&
      dr.b_vs_b.within === true &&
      dr.admissible === false,
    JSON.stringify(dr?.a_vs_a),
  );

  writeSweep(
    root,
    "ctl-gsw-w1-vp-draw-idle",
    abba({ B1: { exit: "3" } }),
    false,
  );
  const ex = summarizeSweep(
    "ctl-gsw-w1-vp-draw-idle",
    join(root, "gate6/ctl-gsw-w1-vp-draw-idle/rates/dev-vp-draw-idle"),
  );
  expect(
    "a receiver that exited non-zero is void",
    ex?.arms.find((a) => a.arm === "B1")?.void === true &&
      ex.admissible === false,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- PSS totals (F2: a missing renderer is never summed away) ---------------------------------
const R = (process: string, pss_kb: number | null) => ({ process, pss_kb });
const before = [
  R("com.android.chrome", 90_000),
  R("com.android.chrome:sandboxed_process0", 120_000),
  R("com.android.chrome:privileged_process0", 60_000),
];
const full = pssTotals(before, [
  R("com.android.chrome", 91_000),
  R("com.android.chrome:sandboxed_process0", 150_000),
  R("com.android.chrome:privileged_process0", 70_000),
]);
expect(
  "pssTotals: complete samples sum",
  full.before === 270_000 &&
    full.after === 311_000 &&
    full.partial.length === 0,
  JSON.stringify(full),
);
const noRenderer = pssTotals(before, [
  R("com.android.chrome", 91_000),
  R("com.android.chrome:privileged_process0", 70_000),
  R("com.android.chrome:privileged_process1", 1),
]);
expect(
  "pssTotals: an after sample without the renderer is null, marked partial",
  noRenderer.after === null &&
    /renderer is missing/.test(noRenderer.partial.join()),
  JSON.stringify(noRenderer),
);
const nullPss = pssTotals(before, [
  R("com.android.chrome", 91_000),
  R("com.android.chrome:sandboxed_process0", null),
  R("com.android.chrome:privileged_process0", 70_000),
]);
expect(
  "pssTotals: a process without PSS makes the total null",
  nullPss.after === null && /no PSS for/.test(nullPss.partial.join()),
  JSON.stringify(nullPss),
);
const fewer = pssTotals(before, [
  R("com.android.chrome:sandboxed_process0", 150_000),
  R("com.android.chrome", 1),
]);
expect(
  "pssTotals: fewer processes at the end is null",
  fewer.after === null && /2 processes against 3/.test(fewer.partial.join()),
  JSON.stringify(fewer),
);

// --- the device sweep wrapper's directory layout and order (F1), with adb stubbed ---------------
// lib/gate7-vp-phone.sh vp_sweep_run with vp_adb replaced by a fake phone. The child mirrors
// run-gate6.sh's fresh-output guard (asserted below to still be the real one), so a wrapper that
// writes into the child's --out fails here as it failed on the phone.
const GUARD = 'if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then';
function sweepWrapper(opts: { childRc?: number; socket?: boolean | "stetho" }) {
  const tmp = mkdtempSync(join(tmpdir(), "self-test-gate7-vp-wrap-"));
  const runDir = join(tmp, "gate6", "dev-g31-gsw-w2-vp-vfx6");
  const script = `
set -u
REPO_ROOT=${JSON.stringify(join(SCRIPTS, "..", "..", ".."))}
source ${JSON.stringify(join(SCRIPTS, "lib", "gate7-vp-phone.sh"))}
export G7V_PHONE_LOCK=${JSON.stringify(join(tmp, "phone.lock"))}
VP_CHROME_WAIT_TRIES=2
vp_adb() {
  echo "$*" >>${JSON.stringify(join(tmp, "adb.log"))}
  case "$*" in
  *"/proc/net/unix"*) ${opts.socket === false ? "true" : opts.socket === "stetho" ? 'echo "0000: 00000002 00000000 00010000 0001 01 1234 @stetho_com.google.android.apps.messaging_devtools_remote"' : 'echo "0000: 00000002 00000000 00010000 0001 01 1234 @chrome_devtools_remote"'} ;;
  *topResumedActivity*|*activities*) echo "  topResumedActivity=ActivityRecord{x u0 com.motorola.launcher3/.Launcher t1}" ;;
  esac
}
sleep() { :; }
vp_sweep_run ${JSON.stringify(runDir)} 1 ${JSON.stringify(`${runDir}.log`)} -- bash -c '
OUT="$1"
${GUARD}
  echo "child: $OUT already holds files" >&2; exit 1
fi
mkdir -p "$OUT/rates"
if flock -n "$2" true; then echo LOCK_FREE; else echo LOCK_HELD; fi
: >"$OUT/rates/ok"
exit ${opts.childRc ?? 0}' _ ${JSON.stringify(runDir)} ${JSON.stringify(join(tmp, "phone.lock"))}
echo "rc=$?"
if flock -n ${JSON.stringify(join(tmp, "phone.lock"))} true; then echo AFTER_FREE; else echo AFTER_HELD; fi
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const out = {
    stdout: r.stdout,
    stderr: r.stderr,
    rc: Number(/rc=(\d+)/.exec(r.stdout)?.[1] ?? -1),
    afterFree: r.stdout.includes("AFTER_FREE"),
    childLog: read(`${runDir}.log`),
    runFiles: existsSync(runDir) ? readdirSync(runDir).sort() : [],
    sweepFiles: existsSync(`${runDir}.sweep`)
      ? readdirSync(`${runDir}.sweep`).sort()
      : [],
    events: read(join(`${runDir}.sweep`, "events.log"))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\S+ /, "")),
    adb: read(join(tmp, "adb.log")).split("\n").filter(Boolean),
  };
  rmSync(tmp, { recursive: true, force: true });
  return out;
}
const ok = sweepWrapper({});
expect(
  "wrapper: the child's --out stays fresh (its guard passes) and holds only the child's files",
  ok.rc === 0 &&
    ok.runFiles.join(",") === "rates" &&
    !/already holds files/.test(ok.childLog),
  JSON.stringify(ok),
);
expect(
  "wrapper: lock and Chrome evidence go to <run>.sweep/",
  [
    "chrome-start.log",
    "chrome-stop-final.json",
    "events.log",
    "phone-lock.json",
  ].every((f) => ok.sweepFiles.includes(f)),
  ok.sweepFiles.join(","),
);
expect(
  "wrapper: the lock is held while the child runs and released after",
  ok.childLog.includes("LOCK_HELD") && ok.afterFree,
  JSON.stringify({ log: ok.childLog, free: ok.afterFree }),
);
expect(
  "wrapper: lock, then Chrome, then the child; the child stopped, then Chrome force-stopped, then the lock released",
  ok.events.join("|") ===
    "lock taken|chrome socket up after 1x0.5 s (sweep)|chrome started|child started|child exit 0|child stopped|chrome force-stopped|lock released",
  ok.events.join("|"),
);
const amStart = ok.adb.findIndex((l) => l.includes("am start"));
const forceStop = ok.adb.findIndex((l) => l.includes("am force-stop"));
expect(
  "wrapper: adb opens Chrome before the child and force-stops it after",
  amStart >= 0 && forceStop > amStart,
  ok.adb.join(" / "),
);
const failed = sweepWrapper({ childRc: 3 });
expect(
  "wrapper: a failing child's code is returned, and Chrome is still force-stopped and the lock released",
  failed.rc === 3 &&
    failed.events.includes("chrome force-stopped") &&
    failed.afterFree,
  JSON.stringify(failed.events),
);
const stetho = sweepWrapper({ socket: "stetho" });
expect(
  "wrapper: only an app's Stetho socket (Google Messages) is not Chrome's: exit 1, no child, Chrome force-stopped, lock released",
  stetho.rc === 1 &&
    !stetho.events.includes("child started") &&
    stetho.events.some((e) => e.startsWith("no chrome socket")) &&
    stetho.events.includes("chrome force-stopped") &&
    stetho.afterFree,
  JSON.stringify(stetho.events),
);
const noSocket = sweepWrapper({ socket: false });
expect(
  "wrapper: no DevTools socket: exit 1, no child, Chrome force-stopped, lock released",
  noSocket.rc === 1 &&
    !noSocket.events.includes("child started") &&
    noSocket.events.includes("chrome force-stopped") &&
    noSocket.afterFree &&
    noSocket.runFiles.length === 0,
  JSON.stringify(noSocket),
);
expect(
  "gate6c-legs.sh: every device arm waits for Chrome's socket before the daemon restart, and stops the sweep when it never comes",
  /if ! vp_chrome_start "\$A\/chrome-start.log" "\$arm"; then[\s\S]*?exit 1\n\t\t\tfi\n\t\t\tvp_event "daemon restart \(\$arm\)"\n\t\t\tgate7_daemon_restart/.test(
    readFileSync(join(SCRIPTS, "lib", "gate6c-legs.sh"), "utf8"),
  ),
);
// D1: a device sweep interrupted while it WAITS for the phone lock (another session holds it) must
// not touch the phone: no force-stop of the other session's Chrome, no "lock released" for a lock
// it never took. A holder keeps G7V_PHONE_LOCK; the sweep is started in its own process group,
// TERMed once it waits, and the fake adb log and events.log are read.
{
  const tmp = mkdtempSync(join(tmpdir(), "self-test-gate7-vp-lockwait-"));
  const lock = join(tmp, "phone.lock");
  const runDir = join(tmp, "gate6", "dev-g31-gsw-w2-vp-vfx6");
  const sweep = join(tmp, "sweep.sh");
  writeFileSync(
    sweep,
    `set -u
REPO_ROOT=${JSON.stringify(join(SCRIPTS, "..", "..", ".."))}
source ${JSON.stringify(join(SCRIPTS, "lib", "gate7-vp-phone.sh"))}
export G7V_PHONE_LOCK=${JSON.stringify(lock)}
vp_adb() {
  echo "$*" >>${JSON.stringify(join(tmp, "adb.log"))}
  case "$*" in *"/proc/net/unix"*) echo "0000: 00000002 0 0 0001 01 1 @chrome_devtools_remote" ;; esac
}
vp_sweep_run ${JSON.stringify(runDir)} 1 ${JSON.stringify(`${runDir}.log`)} -- true
`,
  );
  const driver = `
set -u
: >${JSON.stringify(join(tmp, "adb.log"))}
flock ${JSON.stringify(lock)} sh -c 'echo held >"$1"; sleep 30' _ ${JSON.stringify(join(tmp, "holder"))} &
holder=$!
for _ in $(seq 1 100); do [ -s ${JSON.stringify(join(tmp, "holder"))} ] && break; sleep 0.05; done
setsid bash ${JSON.stringify(sweep)} 2>${JSON.stringify(join(tmp, "sweep.err"))} &
pg=$!
for _ in $(seq 1 100); do grep -q 'waiting for the phone lock' ${JSON.stringify(join(tmp, "sweep.err"))} 2>/dev/null && break; sleep 0.05; done
sleep 0.3
kill -TERM -- "-$pg" 2>/dev/null
for _ in $(seq 1 100); do kill -0 "$pg" 2>/dev/null || break; sleep 0.05; done
kill "$holder" 2>/dev/null; pkill -P "$holder" 2>/dev/null; wait 2>/dev/null
echo done
`;
  spawnSync("bash", ["-c", driver], { encoding: "utf8", timeout: 30_000 });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const adbLog = read(join(tmp, "adb.log"));
  const events = read(join(`${runDir}.sweep`, "events.log"));
  const waited = read(join(tmp, "sweep.err")).includes(
    "waiting for the phone lock",
  );
  rmSync(tmp, { recursive: true, force: true });
  expect(
    "wrapper (D1): TERM while waiting for a held phone lock: no Chrome force-stop, no adb at all, no lock taken or released",
    waited &&
      !adbLog.includes("force-stop") &&
      adbLog.trim() === "" &&
      !events.includes("lock released") &&
      !events.includes("lock taken"),
    JSON.stringify({ waited, adbLog, events }),
  );
}
const run6 = readFileSync(join(SCRIPTS, "run-gate6.sh"), "utf8");
expect(
  "run-gate6.sh still has the fresh-output guard the stub mirrors",
  run6.includes(GUARD),
);

// --- runner wiring -----------------------------------------------------------------------------
const legs = readFileSync(join(SCRIPTS, "lib", "gate6c-legs.sh"), "utf8");
const run7 = readFileSync(join(SCRIPTS, "run-gate7.sh"), "utf8");
const phone = readFileSync(join(SCRIPTS, "lib", "gate7-vp-phone.sh"), "utf8");
expect(
  "gate6c-legs.sh: default arms A1,B1,B2,A2",
  legs.includes(`G7V_VP_ARMS="$\{G7V_VP_ARMS:-A1,B1,B2,A2}"`),
);
expect(
  "gate6c-legs.sh: B arms set RS_RECEIVER_VIEWPORTS=off; every arm speaks /16 and stops itself",
  /B\*\) client=off/.test(legs) &&
    legs.includes("RS_RECEIVER_VIEWPORTS=off") &&
    legs.includes("RS_RECEIVER_PROTOCOL=16 RS_RECEIVER_LIVE_STOP_S="),
);
expect(
  "gate6c-legs.sh: after a device arm the daemon stops before Chrome is force-stopped",
  /gate7_daemon_stop\n\t\tvp_chrome_stop/.test(legs),
);
expect(
  "gate6c-legs.sh: the host-off arm runs on GRC_VIEWPORTS=off",
  legs.includes('g6c_dev_vp_host "$S/H/host" off'),
);
expect(
  "run-gate7.sh: the sweep runs through vp_sweep_run with run-gate6.sh's --out the run dir, never created beforehand",
  run7.includes('vp_sweep_run "$run_dir"') &&
    run7.includes('--out "$run_dir" --legs g6c') &&
    !/g7v_vp_sweep\(\) \{[\s\S]*?mkdir -p "\$run_dir"[\s\S]*?\n\t\t\}/.test(
      run7,
    ),
);
expect(
  "gate7-vp-phone.sh: the lock is the main checkout's artifacts/perf/g31-phone.lock",
  phone.includes("artifacts/perf/g31-phone.lock") &&
    phone.includes("--git-common-dir"),
);
expect(
  "gate7-vp-phone.sh: adb runs on ANDROID_SERIAL",
  phone.includes(`adb $\{ANDROID_SERIAL:+-s "$ANDROID_SERIAL"}`),
);

console.log(
  failures === 0
    ? "self-test-gate7-vp: all checks correct"
    : `self-test-gate7-vp: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
