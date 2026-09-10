// Comparison table rendering. The primary artifact of this harness is a COMPARISON, not a gate, so
// the table is the product: one column per mechanism, one row per metric, with the two rows that can
// only ever be failures (`decode in-raster`, `presented sampleHits`) called out explicitly.

import type { BrowserPerfReport } from "./report";

interface Row {
  label: string;
  value: (report: BrowserPerfReport) => string;
  alarm?: (report: BrowserPerfReport) => boolean;
}

const ROWS: Row[] = [
  { label: "initialRender ms", value: (r) => fmt(r.metrics.initialRenderMs) },
  { label: "ready ms (JS)", value: (r) => fmt(r.metrics.readyMs) },
  { label: "contentUpdate Hz", value: (r) => fmt(r.metrics.contentUpdateHz) },
  {
    label: "  swapRate Hz (NOT fps)",
    value: (r) => fmt(r.metrics.swapRateHz),
  },
  {
    label: "frameCost ms p50/p95/max",
    value: (r) =>
      `${fmt(r.metrics.frameCostMs.p50)}/${fmt(r.metrics.frameCostMs.p95)}/${fmt(r.metrics.frameCostMs.max)}`,
  },
  {
    label: "activationGap ms p50/p95/max",
    value: (r) =>
      `${fmt(r.metrics.activationGapMs.p50)}/${fmt(r.metrics.activationGapMs.p95)}/${fmt(r.metrics.activationGapMs.max)}`,
  },
  {
    label: "  gaps > 100 ms",
    value: (r) => String(r.metrics.activationGapMs.over100msCount),
    alarm: (r) => r.metrics.activationGapMs.over100msCount > 0,
  },
  { label: "blocked ms (LoAF)", value: (r) => fmt(r.metrics.blockedMs) },
  { label: "  longTasks", value: (r) => String(r.metrics.longTaskCount) },
  {
    label: "mainThread busy ms",
    value: (r) => fmt(r.metrics.mainThreadBusyMs),
  },
  {
    label: "mainThread cpu ratio",
    // Printed with its SAMPLE SIZE: a ratio of 1 over 0 samples is the "nothing met the long-task
    // threshold" fallback, not a fully-busy main thread, and the two look identical without it.
    // Never prints a number when nothing was measured: "— (n=0)" cannot be misread as a busy thread.
    value: (r) =>
      `${r.metrics.mainThreadCpuRatio ?? "—"} (n=${r.metrics.mainThreadCpuSamples})`,
    alarm: (r) => r.metrics.mainThreadCpuRatio === null,
  },
  {
    label: "decode tasks",
    // "n/a (no images)" rather than "0": a scenario that paints no images has nothing to decode,
    // and printing a bare zero next to arms that DO decode invites reading it as a win.
    value: (r) =>
      r.metrics.decode.imagesExpected === false
        ? "n/a (no images)"
        : String(r.metrics.decode.count),
  },
  { label: "decode ms", value: (r) => fmt(r.metrics.decode.totalMs) },
  { label: "  decode max ms", value: (r) => fmt(r.metrics.decode.maxMs) },
  {
    label: "  distinct images",
    value: (r) => String(r.metrics.decode.distinctImages),
  },
  {
    label: "  decode cache family",
    value: (r) => r.metrics.decode.cacheFamily,
    // Only an alarm when NOTHING was decoded: "unknown" on its own is legitimate for a mechanism
    // that decodes outside cc's image-decode cache (createImageBitmap does). "unknown" WITH a zero
    // decode count is the phone-workstream trap — unmeasured, not fast.
    alarm: (r) =>
      r.metrics.decode.cacheFamily === "unknown" &&
      r.metrics.decode.count === 0 &&
      r.metrics.decode.imagesExpected !== false,
  },
  { label: "  codec runs", value: (r) => String(r.metrics.decode.codecRuns) },
  {
    label: "  REDECODES (n / ms)",
    value: (r) =>
      `${r.metrics.decode.redecodeCount} / ${fmt(r.metrics.decode.redecodeMs)}`,
    alarm: (r) => r.metrics.decode.redecodeCount > 0,
  },
  {
    label: "  DECODE IN RASTER (n / ms)",
    value: (r) =>
      `${r.metrics.decode.inRasterCount} / ${fmt(r.metrics.decode.inRasterMs)}`,
    alarm: (r) => r.metrics.decode.inRasterCount > 0,
  },
  { label: "raster ms", value: (r) => fmt(r.metrics.rasterMs) },
  { label: "paintImage records", value: (r) => String(r.metrics.paint.count) },
  {
    label: "  max source MP",
    value: (r) => fmt(r.metrics.paint.maxSourceMegapixels),
  },
  {
    label: "  max source:painted",
    value: (r) => `${fmt(r.metrics.paint.maxSourceToPaintedRatio)}x`,
  },
  { label: "layers", value: (r) => String(r.metrics.layerCount) },
  { label: "renderSurfaces", value: (r) => String(r.metrics.renderSurfaces) },
  {
    label: "cpu ALL PROCESSES ms (>=)",
    value: (r) => fmt(r.metrics.cpu.totalCpuMs),
  },
  {
    label: "  core-equivalents (>=)",
    value: (r) => `${r.metrics.cpu.totalCoreRatio}x`,
  },
  {
    label: "  cpu coverage",
    value: (r) => r.metrics.cpu.cpuCoverage.toFixed(3),
    // Below half the top-level wall time carrying a tdur, the CPU total is not a lower bound worth
    // reading — it is mostly unknown.
    alarm: (r) => r.metrics.cpu.cpuCoverage < 0.5,
  },
  ...(["renderer", "browser", "gpu"] as const).map((key) => ({
    label: `  ${key} cpu ms`,
    value: (r: BrowserPerfReport) => {
      const entry = r.metrics.cpu.byProcess[key];
      return entry ? `${fmt(entry.cpuMs)}` : "—";
    },
  })),
  {
    label: "presented sampleHits",
    value: (r) =>
      `${r.metrics.presented.sampleHits}/${r.metrics.presented.sampleCount}`,
    alarm: (r) =>
      r.metrics.presented.sampleHits < r.metrics.presented.sampleCount,
  },
  {
    label: "presented nonEmptyRatio",
    value: (r) => r.metrics.presented.nonEmptyRatio.toFixed(4),
  },
];

/** GPU rows, appended only when the GPU categories were actually collected. */
const GPU_ROWS: Row[] = [
  { label: "gpu hardware", value: (r) => r.metrics.gpu.hardware },
  {
    label: "gpu process cpu ms (>=)",
    value: (r) => fmt(r.metrics.gpu.processCpuMs),
  },
  {
    label: "  op-level detail",
    value: (r) => (r.metrics.gpu.opDetail ? "yes" : "NO (RunTask only)"),
    alarm: (r) => !r.metrics.gpu.opDetail,
  },
  ...(
    [
      ["uploadDecode", "upload/decode"],
      ["rasterPlayback", "raster playback"],
      ["skiaPrepare", "skia prepare"],
      ["skiaExecute", "skia execute"],
      ["presentSwap", "present/swap"],
      ["clear", "clear/fill"],
      ["schedulerIpc", "scheduler/ipc"],
      ["other", "other (unbucketed)"],
    ] as const
  ).map(([key, label]) => ({
    label: `  ${label} ms`,
    value: (r: BrowserPerfReport) => fmt(r.metrics.gpu.byBucket[key]),
  })),
];

/** `dumpsys gfxinfo` rows, appended only on a device run. */
const GFXINFO_ROWS: Row[] = [
  {
    label: "gfxinfo jank % (HWUI)",
    value: (r) => fmtOrDash(r.metrics.gpu.device?.gfxinfo.jankPct),
  },
  {
    label: "  frame ms p50/p95/p99",
    value: (r) => {
      const info = r.metrics.gpu.device?.gfxinfo;
      return `${fmtOrDash(info?.p50Ms)}/${fmtOrDash(info?.p95Ms)}/${fmtOrDash(info?.p99Ms)}`;
    },
  },
  {
    label: "  SLOW BITMAP UPLOADS",
    value: (r) => fmtOrDash(r.metrics.gpu.device?.gfxinfo.slowBitmapUploads, 0),
    alarm: (r) => (r.metrics.gpu.device?.gfxinfo.slowBitmapUploads ?? 0) > 0,
  },
  {
    label: "  SLOW ISSUE DRAW CMDS",
    value: (r) =>
      fmtOrDash(r.metrics.gpu.device?.gfxinfo.slowIssueDrawCommands, 0),
    alarm: (r) =>
      (r.metrics.gpu.device?.gfxinfo.slowIssueDrawCommands ?? 0) > 0,
  },
];

/**
 * The DRIVER's GPU-memory figure, on whichever rung produced it. Printed whenever a run has one — a
 * device run (`dumpsys gfxinfo`) or a desktop NVIDIA one (`nvidia-smi`, per process).
 *
 * The source is a ROW, not a footnote, because the two numbers mean different things: one is a whole
 * Android package's HWUI total, the other is one desktop process's VRAM.
 */
const DEVICE_MEMORY_ROWS: Row[] = [
  {
    label: "gpu memory MB (driver)",
    value: (r) => mbOrDash(r.metrics.gpu.device?.gpuMemoryBytes),
  },
  {
    label: "  window delta MB",
    // The driver reports whole MiB, so a delta under ~1.05 MB is BELOW THE INSTRUMENT rather than
    // small. `—` here means the rung took no before-reading at all (Android resets its counters
    // instead), which is not the same thing and must not print as 0.00.
    value: (r) => mbOrDash(r.metrics.gpu.device?.gpuMemoryDeltaBytes, true),
  },
  {
    label: "  source",
    value: (r) => r.metrics.gpu.device?.source ?? "—",
  },
];

/**
 * `--memory-dump` only: Chrome's OWN allocator totals over the same bracket. A CROSS-CHECK — where it
 * disagrees with the driver row above, the driver is the truth.
 */
const MEMORY_DUMP_ROWS: Row[] = [
  {
    label: "memory-dump delta MB (self-counted)",
    value: () => "",
  },
  ...(
    [
      ["glTextures", "gpu/gl/textures"],
      ["sharedImages", "gpu/shared_images"],
      ["skiaGpuResources", "skia/gpu_resources/*"],
    ] as const
  ).map(([key, label]) => ({
    label: `  ${label}`,
    value: (r: BrowserPerfReport) =>
      mbOrDash(r.metrics.gpu.device?.memoryDump?.delta[key], true),
  })),
];

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

/** `null` is "the dump did not report this counter" and must not be printed as a 0. */
function fmtOrDash(value: number | null | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

/** Bytes as MB, keeping the sign on a delta: `-1.05` is memory the window GAVE BACK, not noise. */
function mbOrDash(value: number | null | undefined, signed = false): string {
  if (value == null) {
    return "—";
  }
  const mb = (value / 1e6).toFixed(2);
  return signed && value >= 0 ? `+${mb}` : mb;
}

/**
 * Rows for the optional watched-image block. Appended only when the scenario declared one: printing
 * an empty "watched image" section on every scenario would train the reader to skip it.
 */
const WATCHED_ROWS: Row[] = [
  {
    label: "watched image MP",
    value: (r) => fmt(r.metrics.watchedImage?.sourceMegapixels ?? 0),
  },
  {
    label: "  paints (total / in window)",
    value: (r) =>
      `${r.metrics.watchedImage?.paintCount ?? 0} / ${r.metrics.watchedImage?.paintCountInWindow ?? 0}`,
    // A re-paint inside the measured window means the display list was re-recorded for an image
    // nothing asked to change — the thing S4 exists to catch.
    alarm: (r) => (r.metrics.watchedImage?.paintCountInWindow ?? 0) > 0,
  },
  {
    label: "  distinct painted sizes",
    value: (r) => String(r.metrics.watchedImage?.distinctPaintedSizes ?? 0),
    alarm: (r) => (r.metrics.watchedImage?.distinctPaintedSizes ?? 0) > 1,
  },
];

/**
 * Rows for the optional scenario-counter block, one per key in the UNION across the arms.
 *
 * Built from the data rather than declared like `WATCHED_ROWS`, because the keys belong to the
 * scenario and this file must not know them. Returns nothing at all when no arm reported counters, so
 * a scenario that declares none never grows an empty section the reader learns to skip.
 *
 * A key one arm reports and another does not prints `—` on the arm that did not: absent is NOT
 * MEASURED, and printing a `0` there would put a number the harness invented next to measured ones.
 * A MEASURED zero does print as `0` — for a counter that is usually the whole finding ("the loop
 * really parked"), and it is the one thing the dash must stay distinguishable from.
 */
function scenarioRows(reports: BrowserPerfReport[]): Row[] {
  const keys = new Set<string>();
  for (const report of reports) {
    for (const key of Object.keys(report.metrics.scenario ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].sort().map((key) => ({
    label: `scenario.${key}`,
    // Printed VERBATIM, not through `fmt`: these are the scenario's own counters, already medianed
    // to 4 significant digits, and `fmt` would render a count of 0 as "0.00" and a ratio of 0.0029
    // as "0.00" — the exact annihilation the median rounding rule exists to prevent.
    value: (report: BrowserPerfReport) => {
      const counter = report.metrics.scenario?.[key];
      return counter === undefined ? "—" : String(counter);
    },
  }));
}

/**
 * A one-line signature of the geometry a report was measured at. Two reports that disagree on it are
 * two different experiments: the raster scale differs, so their decode/raster/paint numbers cannot be
 * put in adjacent columns and read as an A/B.
 */
function geometrySignature(report: BrowserPerfReport): string {
  const geometry = report.env.geometry;
  if (!geometry) {
    return "unknown";
  }
  return [
    `${geometry.viewport.width}x${geometry.viewport.height}@${geometry.devicePixelRatio}`,
    geometry.orientation,
    `fit=${geometry.fit ? geometry.fitScale : "off"}`,
    `stage=${geometry.stage.width}x${geometry.stage.height}`,
    `grid=${geometry.grid ?? "-"}`,
  ].join(" ");
}

export function formatComparison(reports: BrowserPerfReport[]): string {
  if (reports.length === 0) {
    return "no reports";
  }
  const head = reports[0];
  const gpuAvailable = reports.some((report) => report.metrics.gpu?.available);
  // The HWUI rows are ANDROID-ONLY and are gated on the instrument, not on the block's presence: a
  // desktop run carries the same `device` block for its VRAM figure, and printing "gfxinfo jank %"
  // there — as seven em dashes under a heading about Chrome's Android View hierarchy — would be a
  // row about a thing that does not exist on this machine.
  const gfxinfo = reports.some(
    (report) => report.metrics.gpu?.device?.source === "dumpsys-gfxinfo",
  );
  const driverMemory = reports.some(
    (report) => report.metrics.gpu?.device?.source != null,
  );
  const memoryDump = reports.some(
    (report) => report.metrics.gpu?.device?.memoryDump != null,
  );
  const rows = [
    ...ROWS,
    ...(gpuAvailable ? GPU_ROWS : []),
    ...(gfxinfo ? GFXINFO_ROWS : []),
    ...(driverMemory ? DEVICE_MEMORY_ROWS : []),
    ...(memoryDump ? MEMORY_DUMP_ROWS : []),
    ...(head.metrics.watchedImage ? WATCHED_ROWS : []),
    ...scenarioRows(reports),
  ];
  const columns = reports.map((report) =>
    String(report.params.mechanism ?? "default"),
  );
  const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 2;
  const colWidth = Math.max(16, ...columns.map((c) => c.length + 2));

  const lines: string[] = [];
  lines.push(
    `scenario: ${head.scenario}   env: ${head.env.kind}/${head.env.label}   cpuThrottle: ${
      head.env.cpuThrottle === null ? "none" : `${head.env.cpuThrottle}x`
    }   repeats: ${head.repeats} (+${head.warmups} warmup, medians)`,
  );
  // Every param the scenario declared EXCEPT `mechanism`, which is the column axis. Listing a fixed
  // set of names printed `animated=undefined` for scenarios that have no such knob, and — worse —
  // would silently omit the parameter a reader needs to interpret the table.
  lines.push(
    `params:   ${Object.entries(head.params)
      .filter(([key]) => key !== "mechanism")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
  );
  // GEOMETRY, on the header. Two runs measured at different fit scales are not comparable on
  // decode/raster — the raster scale IS the variable — so the reader must not have to open the JSON
  // to discover that this table was taken on a portrait phone at 0.39x.
  const geometry = head.env.geometry;
  if (geometry) {
    lines.push(
      `geometry: viewport ${geometry.viewport.width}x${geometry.viewport.height} CSS px @ DPR ${geometry.devicePixelRatio} (${geometry.orientation})` +
        `   stage ${geometry.stage.width}x${geometry.stage.height}` +
        (geometry.grid ? ` grid ${geometry.grid}` : "") +
        (geometry.fit
          ? ` fitted x${geometry.fitScale} -> ${geometry.fittedStage.width}x${geometry.fittedStage.height}`
          : " used 1:1 (no fit)") +
        (geometry.emulatedViewport
          ? `   EMULATED ${geometry.emulatedViewport}`
          : ""),
    );
    if (geometry.fitScale !== 1) {
      lines.push(
        `          note: raster scale is ${geometry.fitScale}x the stage's authored size — decode/raster/paint numbers are NOT directly comparable with a run at a different fit scale.`,
      );
    }
  }
  const device = head.env.device;
  if (device) {
    lines.push(
      `device:   ${device.manufacturer ?? ""} ${device.model} / Android ${device.androidRelease} / ${device.chrome} / isolation ${device.isolation ?? "?"} / viewport ${device.viewport ?? "?"} (phone's own ${device.naturalViewport ?? "?"})`,
    );
    // Before AND after, on one line. A thermally throttled phone silently invalidates these
    // numbers, and the reader must not have to open the JSON to find that out.
    lines.push(
      `          battery ${device.batteryPct ?? "?"}% -> ${device.after?.batteryPct ?? "?"}%,` +
        ` ${device.batteryTemperatureC ?? "?"} -> ${device.after?.batteryTemperatureC ?? "?"} °C,` +
        ` thermalStatus ${device.thermalStatus ?? "?"} -> ${device.after?.thermalStatus ?? "?"}`,
    );
    for (const warning of device.warnings ?? []) {
      lines.push(`          !! ${warning}`);
    }
  }
  // The table puts one column per mechanism and invites the reader to compare them. That is only
  // honest if every column was measured at the SAME geometry — `perf compare <dir>` will happily be
  // pointed at a directory holding a portrait phone run and a desktop run.
  const signatures = new Map<string, string[]>();
  for (const report of reports) {
    const signature = geometrySignature(report);
    const mechanisms = signatures.get(signature);
    const mechanism = String(report.params.mechanism ?? "default");
    if (mechanisms) {
      mechanisms.push(mechanism);
    } else {
      signatures.set(signature, [mechanism]);
    }
  }
  if (signatures.size > 1) {
    lines.push("");
    lines.push(
      "!! GEOMETRY MISMATCH — these columns were NOT measured at the same geometry, so their decode,",
    );
    lines.push(
      "   raster and paint numbers are not comparable with each other:",
    );
    for (const [signature, mechanisms] of signatures) {
      lines.push(`     ${mechanisms.join(", ")}: ${signature}`);
    }
  }
  // THE CPU CAVEAT, at the point of use. `tdur` is CPU inside TRACED tasks only, so the totals below
  // are a floor, not process CPU%. Printing them without this line would be the same class of
  // dishonesty as calling the compositor swap rate fps.
  lines.push("");
  lines.push(
    "cpu:      `>=` marks a LOWER BOUND. cpu/gpu ms come from trace `tdur` — CPU spent inside TRACED tasks only —",
  );
  lines.push(
    "          so work in untraced categories counts as zero. This is NOT process CPU%; read `cpu coverage` (the",
  );
  lines.push(
    "          share of top-level wall time that carried a tdur) before trusting the size of the number.",
  );
  if (gpuAvailable) {
    lines.push(
      `gpu:      ${reports.map((r) => `${String(r.params.mechanism)}=${r.metrics.gpu.hardware}`).join("  ")} — GPU numbers are comparable WITHIN AN ENVIRONMENT ONLY,`,
    );
    lines.push(
      "          exactly like layers/renderSurfaces. This box is SwiftShader (a software rasteriser, no hardware GPU);",
    );
    lines.push(
      "          a phone is a real GPU behind ANGLE. Do not read a bucket total across the two.",
    );
  } else if (head.metrics.gpu) {
    lines.push(
      "gpu:      NOT COLLECTED (--no-gpu, or no GPU process in the trace). `gpu.available: false` means unmeasured, not idle.",
    );
  }
  if (gfxinfo) {
    lines.push(
      "gfxinfo:  HWUI stats for Chrome's ANDROID VIEW hierarchy, not the web page's frames (web content is composited",
    );
    lines.push(
      "          through a SurfaceControl). The percentiles are NOT the page's frame times — contentUpdateHz is.",
    );
    lines.push(
      "          The two SLOW counters are HWUI's own texture-upload / draw-command pressure read-out and do carry.",
    );
  }
  if (driverMemory) {
    const attribution = reports.find(
      (report) => report.metrics.gpu?.device?.attribution,
    )?.metrics.gpu.device?.attribution;
    lines.push(
      "vram:     `gpu memory MB (driver)` is the DRIVER's figure, not a self-counted texture total. On nvidia-smi it is",
    );
    lines.push(
      "          the PER-PROCESS reading for the GPU process of the Chrome this run launched — never the box-wide",
    );
    lines.push(
      "          fb_memory_usage, which also carries the desktop, the editor and any other browser. The driver reports",
    );
    lines.push(
      "          whole MiB, so a window delta under ~1.05 MB is BELOW THE INSTRUMENT rather than small.",
    );
    if (attribution) {
      lines.push(`          attributed to: ${attribution}`);
    }
  }
  if (memoryDump) {
    lines.push(
      "mem-dump: Chrome's OWN allocator totals (`size`, never `effective_size` — that one deduplicates a shared texture",
    );
    lines.push(
      "          across processes and would hide it). A CROSS-CHECK: where it disagrees with the driver row, THE DRIVER",
    );
    lines.push("          NUMBER IS THE TRUTH.");
  }
  lines.push("");
  lines.push(
    "metric".padEnd(labelWidth) +
      columns.map((c) => c.padStart(colWidth)).join(""),
  );
  lines.push("-".repeat(labelWidth + colWidth * columns.length));
  for (const row of rows) {
    const cells = reports.map((report) => {
      const text = row.value(report);
      return (row.alarm?.(report) ? `!! ${text}` : text).padStart(colWidth);
    });
    lines.push(row.label.padEnd(labelWidth) + cells.join(""));
  }
  lines.push("");
  const failures = reports.flatMap((report) =>
    (report.failures ?? []).map(
      (failure) => `  ${String(report.params.mechanism)}: ${failure}`,
    ),
  );
  if (failures.length > 0) {
    lines.push("FAILURES:");
    lines.push(...failures);
    lines.push("");
  }
  const inRaster = reports.filter((r) => r.metrics.decode.inRasterCount > 0);
  if (inRaster.length > 0) {
    lines.push(
      `HARD FAILURE: decode ran inside raster on ${inRaster
        .map((r) => String(r.params.mechanism))
        .join(
          ", ",
        )} — the image exceeds the discardable decode cache, so the decode is re-paid on EVERY re-raster, forever.`,
    );
  } else {
    lines.push(
      "decode-in-raster: 0 on all arms (no image exceeded the discardable decode cache).",
    );
  }
  lines.push(
    "note: swapRate is the compositor swap cadence and is NOT a frame rate — it keeps swapping while content is frozen. contentUpdateHz (ActivateLayerTree) is the honest one.",
  );
  lines.push(...cpuByThreadBlock(reports));
  if (gpuAvailable) {
    lines.push(...unbucketedOpsBlock(reports));
  }
  return lines.join("\n");
}

const THREAD_ROWS = 8;

/**
 * Per-thread CPU, one small table per mechanism. Deliberately NOT folded into the column grid: the
 * threads that exist differ between arms (and between environments), and forcing them into shared
 * rows would either drop the ones that only one arm has or print a wall of "—".
 */
function cpuByThreadBlock(reports: BrowserPerfReport[]): string[] {
  const lines: string[] = [""];
  lines.push(
    `CPU BY THREAD — top ${THREAD_ROWS} per mechanism, ALL processes, medians. cpuMs is a LOWER BOUND (traced tasks only).`,
  );
  for (const report of reports) {
    const cpu = report.metrics.cpu;
    if (!cpu) {
      continue;
    }
    lines.push(
      `  ${String(report.params.mechanism ?? "default")}  —  total ${cpu.totalCpuMs} ms cpu over a ${cpu.windowMs} ms window (${cpu.totalCoreRatio}x one core), coverage ${cpu.cpuCoverage}`,
    );
    lines.push(
      `      ${"process/thread".padEnd(40)} ${"cpu ms".padStart(10)} ${"wall ms".padStart(10)} ${"core".padStart(8)} ${"n".padStart(4)}`,
    );
    for (const row of cpu.byThread.slice(0, THREAD_ROWS)) {
      lines.push(
        `      ${`${row.process}/${row.thread}`.slice(0, 40).padEnd(40)} ${fmt(row.cpuMs).padStart(10)} ${fmt(row.wallMs).padStart(10)} ${`${row.coreRatio}`.padStart(8)} ${String(row.instances).padStart(4)}`,
      );
    }
    if (cpu.byThread.length > THREAD_ROWS) {
      lines.push(`      … ${cpu.byThread.length - THREAD_ROWS} more threads`);
    }
  }
  return lines;
}

/** What the bucket taxonomy could not name. Printed always, so nothing hides in `other`. */
function unbucketedOpsBlock(reports: BrowserPerfReport[]): string[] {
  const lines: string[] = [""];
  lines.push(
    "GPU OPS THE BUCKETS DID NOT NAME (`other`) — printed so the taxonomy cannot hide a cost:",
  );
  for (const report of reports) {
    const ops = report.metrics.gpu?.topUnbucketedOps ?? [];
    const mechanism = String(report.params.mechanism ?? "default");
    if (ops.length === 0) {
      lines.push(`  ${mechanism}: none`);
      continue;
    }
    lines.push(`  ${mechanism}:`);
    for (const op of ops.slice(0, 6)) {
      lines.push(
        `      ${fmt(op.selfMs).padStart(9)} ms  x${String(op.count).padStart(6)}  ${op.name.slice(0, 80)}`,
      );
    }
  }
  return lines;
}
