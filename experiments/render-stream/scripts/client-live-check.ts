// MIR-1 live check (mirror-client-design.md "MIR-1 checks", results/p3/mir-1.md): drives
// web/client-check/ -- a minimal page that mounts @godot-scene-web/render-stream-client and nothing
// else -- in the pinned headless Chromium against a live host, then disposes and mounts it again,
// measuring what each mount gives back.
//
//   tsx --conditions=development experiments/render-stream/scripts/client-live-check.ts \
//     --dir <out> --port <page port> --ws ws://127.0.0.1:<p>/render-stream --http http://127.0.0.1:<p> \
//     [--token-file <evidence>/live-token] [--protocol 11|12] [--window 1|2] [--core <build-web.sh out>] \
//     [--mounts 5] [--first-s 20] [--cycle-s 8] [--rss-tolerance 0.15]
//
// Run it as bench-live-scale.sh's host-only receiver (`--receiver host-only --rx-cmd ...`), which
// judges connection 1 from the host's own tap (update-rate, credit-rtt). Mount 1 streams for
// --first-s, with a WebGL context loss and restore halfway; mounts 2..N stream for --cycle-s each.
// After every dispose: two CDP `HeapProfiler.collectGarbage` passes and the renderer (and GPU)
// process RSS, then a CDP `Memory.simulatePressureNotification` critical and the RSS again. Writes
// <dir>/client-check.json with these checks, and exits 1 when a gating one fails:
//   mounts-streamed    every mount drew its first frame and never reported `failed`
//   context-restore    mount 1's context loss and restore recovered in place (applies resumed)
//   instance-released  each dispose dropped the renderer by >= 80% of that instance's wasm heap
//   remount-no-growth  the renderer RSS after each dispose + GC is within --rss-tolerance of the
//                      first dispose's
//   heap-baseline      every mount's wasm heap starts at the first mount's (a fresh instance)
//   page-is-package-only  the page bundle has no web/gsw-receiver/ input
//   cold-rss (reported, not gating)  the renderer RSS after each dispose (and the purge) within
//                      --rss-tolerance of the level before the first mount. It fails by a one-time
//                      ~220 MiB of [anon:partition_alloc] that the first stream leaves in the
//                      renderer and that never grows (results/p3/mir-1.md "Remount")
// --core: build-web.sh's output; built into <dir>/core when absent.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  collectChromiumProcesses,
  HarnessServer,
  launchHarnessBrowser,
} from "./lib/browser-harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const PAGE_DIR = join(HERE, "..", "web", "client-check");

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-live-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of ["dir", "port", "ws", "http"])
    if (!out[k]) throw new Error(`client-live-check: --${k} is required`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rssMiB(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+)/.exec(s);
    return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** /proc/<pid>/smaps_rollup's Anonymous and file-backed (Rss - Anonymous) MiB. */
function smaps(pid: number): { anon_mib: number; file_mib: number } | null {
  try {
    const s = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (k: string) =>
      Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0);
    return {
      anon_mib: Math.round(kb("Anonymous") / 1024),
      file_mib: Math.round((kb("Rss") - kb("Anonymous")) / 1024),
    };
  } catch {
    return null;
  }
}

/** The page renderer's largest mappings by RSS (/proc/<pid>/smaps), for the residue's anatomy. */
function topMappings(pid: number, n = 12): { name: string; rss_mib: number }[] {
  try {
    const by = new Map<string, number>();
    let name = "";
    for (const line of readFileSync(`/proc/${pid}/smaps`, "utf8").split("\n")) {
      const head = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line);
      if (head) name = head[1] || "[anon]";
      const rss = /^Rss:\s+(\d+) kB/.exec(line);
      if (rss) by.set(name, (by.get(name) ?? 0) + Number(rss[1]));
    }
    return [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ name: k, rss_mib: Math.round(v / 102.4) / 10 }));
  } catch {
    return [];
  }
}

interface Stats {
  applied: number;
  appliesPerSec: number;
  creditRttMsP50: number | null;
  heapBytes: number;
}

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const mountsN = Number(a.mounts ?? 5);
  const firstS = Number(a["first-s"] ?? 20);
  const cycleS = Number(a["cycle-s"] ?? 8);
  const tolerance = Number(a["rss-tolerance"] ?? 0.15);
  const protocol = Number(a.protocol ?? 12) as 11 | 12;
  const creditWindow = Number(a.window ?? 2) as 1 | 2;
  const staticDir = join(dir, "static");
  mkdirSync(join(staticDir, "core"), { recursive: true });

  // The core: build-web.sh's three files.
  let coreDir = a.core ? resolve(a.core) : join(dir, "core");
  if (!existsSync(join(coreDir, "build.json"))) {
    coreDir = join(dir, "core");
    execFileSync(
      "bash",
      [
        join(
          ROOT,
          "packages",
          "render-stream-client",
          "scripts",
          "build-web.sh",
        ),
        coreDir,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  }
  for (const f of [
    "build.json",
    "rs_gsw_wasm_bg.wasm",
    "rs_gsw_wasm_client.js",
  ])
    copyFileSync(join(coreDir, f), join(staticDir, "core", f));
  const coreBuild = JSON.parse(
    readFileSync(join(coreDir, "build.json"), "utf8"),
  );
  const expectedTree = execFileSync(
    "bash",
    [
      join(ROOT, "packages", "render-stream-client", "scripts", "core-tree.sh"),
      ROOT,
    ],
    { encoding: "utf8" },
  ).trim();

  // The page: the package and nothing else.
  copyFileSync(join(PAGE_DIR, "index.html"), join(staticDir, "index.html"));
  const bundle = await build({
    entryPoints: [join(PAGE_DIR, "page.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outfile: join(staticDir, "page.js"),
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(bundle.metafile?.inputs ?? {});
  const harnessInputs = inputs.filter((p) => p.includes("gsw-receiver/"));

  const server = new HarnessServer({
    staticRoot: staticDir,
    evidenceRoot: join(dir, "evidence"),
    allowedLegNonces: [],
  });
  const { origin } = await server.start(Number(a.port));
  const launchArgs = [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS];
  const launched = await launchHarnessBrowser();
  const report: Record<string, unknown> = {
    schema: "render-stream-client-check/1",
    origin,
    ws: a.ws,
    protocol,
    credit_window: creditWindow,
    core_build: coreBuild,
    expected_tree: expectedTree,
    page_inputs: inputs.length,
    page_harness_inputs: harnessInputs,
  };
  const mounts: Record<string, unknown>[] = [];
  report.mounts = mounts;
  let code = 1;
  try {
    const page = await launched.browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page] ${m.text()}`);
    });
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      () => (window as unknown as { __rsc?: unknown }).__rsc !== undefined,
    );
    const prov = await checkBrowserProvenance(page, launched, launchArgs, {
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
    });
    report.provenance = {
      ok: prov.ok,
      reasons: prov.reasons,
      renderer: prov.renderer,
    };
    const cdp = await page.context().newCDPSession(page);
    const gc = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      await sleep(500);
      await cdp.send("HeapProfiler.collectGarbage");
      await sleep(500);
    };
    const procs = async () => {
      const ps = await collectChromiumProcesses(launched.browser);
      const sum = (match: RegExp) =>
        Math.round(
          ps
            .filter((p) => match.test(p.type))
            .reduce((s, p) => s + (rssMiB(p.pid) ?? 0), 0) * 10,
        ) / 10;
      const heap = (await cdp.send("Runtime.getHeapUsage")) as {
        usedSize: number;
        totalSize: number;
      };
      const renderers = ps.filter((p) => p.type === "renderer");
      return {
        js_heap_used_mib: Math.round(heap.usedSize / 2 ** 20),
        js_heap_total_mib: Math.round(heap.totalSize / 2 ** 20),
        renderers: renderers.map((p) => ({
          pid: p.pid,
          mib: rssMiB(p.pid),
          ...smaps(p.pid),
        })),
        renderer_mib: sum(/^renderer$/),
        gpu_mib: sum(/gpu/i),
        types: [...new Set(ps.map((p) => p.type))].sort().join(","),
      };
    };
    // What the browser does under memory pressure: PartitionAlloc decommits its free pages (it
    // keeps them committed otherwise, so a freed instance's ArrayBuffer pages stay in RSS).
    const purge = async () => {
      await cdp.send("Memory.simulatePressureNotification", {
        level: "critical",
      });
      await sleep(500);
    };
    await gc();
    const preHeld = await procs();
    await purge();
    const pre = await procs();
    report.pre_mount_before_purge = preHeld;
    report.pre_mount = pre;
    {
      const ps = await collectChromiumProcesses(launched.browser);
      const pr = ps
        .filter((p) => p.type === "renderer")
        .sort((a, b) => (rssMiB(b.pid) ?? 0) - (rssMiB(a.pid) ?? 0))[0];
      report.pre_mount_top_mappings = pr ? topMappings(pr.pid) : [];
    }
    console.log(`client-live-check: pre-mount ${JSON.stringify(pre)}`);

    let token: string | null = null;
    if (a["token-file"]) {
      for (let i = 0; i < 300 && !existsSync(a["token-file"]); i++)
        await sleep(100);
      token = readFileSync(a["token-file"], "utf8").trim();
    }
    const endpoint = {
      url: a.ws,
      resourceBase: a.http,
      token,
      protocol,
      presentation: [1920, 1080] as [number, number],
    };
    const core = {
      glueUrl: "/core/rs_gsw_wasm_client.js",
      wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
      expectedTree,
    };
    for (let m = 1; m <= mountsN; m++) {
      const t0 = Date.now();
      await page.evaluate(
        (o) =>
          (
            window as unknown as { __rsc: { mount(o: unknown): void } }
          ).__rsc.mount(o),
        { endpoint, core, creditWindow },
      );
      const until = t0 + (m === 1 ? firstS : cycleS) * 1000;
      let heapStart: number | null = null;
      let heapMax = 0;
      let last: Stats | null = null;
      let firstFrameMs: number | null = null;
      let lossAt: number | null = null;
      let appliedAtLoss = 0;
      let appliedAfterRestore: number | null = null;
      while (Date.now() < until) {
        await sleep(100);
        // Mount 1, halfway: a context loss and restore through the package (G7u in place).
        if (
          m === 1 &&
          lossAt === null &&
          firstFrameMs !== null &&
          Date.now() > t0 + (firstS * 1000) / 2
        ) {
          lossAt = Date.now();
          appliedAtLoss = last?.applied ?? 0;
          await page.evaluate(() =>
            (
              window as unknown as {
                __rsc: { loseAndRestore(ms: number): boolean };
              }
            ).__rsc.loseAndRestore(300),
          );
        }
        const s = (await page.evaluate(() =>
          (
            window as unknown as { __rsc: { stats(): Stats | null } }
          ).__rsc.stats(),
        )) as Stats | null;
        if (s && s.heapBytes > 0) {
          heapMax = Math.max(heapMax, s.heapBytes);
          if (s.applied > 0) firstFrameMs ??= Date.now() - t0;
          last = s;
          if (
            lossAt !== null &&
            appliedAfterRestore === null &&
            Date.now() > lossAt + 1500
          )
            appliedAfterRestore = s.applied;
        }
      }
      heapStart =
        ((await page.evaluate(
          (mm) =>
            (
              window as unknown as {
                __rsc: { heapAtStart: Record<number, number> };
              }
            ).__rsc.heapAtStart[mm],
          m,
        )) as number | undefined) ?? null;
      const live = await procs();
      await page.evaluate(() =>
        (window as unknown as { __rsc: { dispose(): void } }).__rsc.dispose(),
      );
      await gc();
      const held = await procs();
      await purge();
      const after = await procs();
      const statuses = (
        (await page.evaluate(
          () =>
            (window as unknown as { __rsc: { statuses: unknown[] } }).__rsc
              .statuses,
        )) as {
          mount: number;
          kind: string;
          reason?: string;
          detail?: string;
          firstFrame?: boolean;
        }[]
      ).filter((s) => s.mount === m);
      const row = {
        mount: m,
        seconds: m === 1 ? firstS : cycleS,
        first_frame_ms: firstFrameMs,
        heap_start_bytes: heapStart,
        heap_max_bytes: heapMax,
        applied: last?.applied ?? 0,
        applies_per_s_last: last?.appliesPerSec ?? 0,
        credit_rtt_ms_p50: last?.creditRttMsP50 ?? null,
        context_loss:
          m === 1
            ? {
                applied_at_loss: appliedAtLoss,
                applied_1500ms_later: appliedAfterRestore,
                applied_end: last?.applied ?? 0,
              }
            : null,
        streaming_rss: live,
        after_dispose_gc_rss: held,
        after_dispose_rss: after,
        statuses: statuses.map(({ kind, reason, detail, firstFrame }) => ({
          kind,
          ...(reason ? { reason, detail } : {}),
          ...(firstFrame !== undefined ? { firstFrame } : {}),
        })),
      };
      mounts.push(row);
      console.log(
        `client-live-check: mount ${m} ${JSON.stringify({ ...row, statuses: row.statuses.length })}`,
      );
    }
    {
      const ps = await collectChromiumProcesses(launched.browser);
      const pr = ps
        .filter((p) => p.type === "renderer")
        .sort((a, b) => (rssMiB(b.pid) ?? 0) - (rssMiB(a.pid) ?? 0))[0];
      report.after_last_dispose_top_mappings = pr ? topMappings(pr.pid) : [];
    }
    const checks: {
      id: string;
      passed: boolean;
      detail: string;
      /** false: reported, never the exit code (cold-rss, see the header). */
      gating?: boolean;
    }[] = [];
    const rows = mounts as {
      mount: number;
      heap_start_bytes: number | null;
      after_dispose_rss: { renderer_mib: number };
      statuses: { kind: string; firstFrame?: boolean }[];
    }[];
    const failed = rows.filter(
      (r) =>
        r.statuses.some((s) => s.kind === "failed") ||
        !r.statuses.some(
          (s) => s.kind === "streaming" && s.firstFrame === true,
        ),
    );
    checks.push({
      id: "mounts-streamed",
      passed: failed.length === 0 && rows.length === mountsN,
      detail: `${rows.length - failed.length}/${mountsN} mounts drew a first frame with no failure`,
    });
    const loss = (
      mounts[0] as {
        context_loss?: { applied_at_loss: number; applied_end: number };
      }
    )?.context_loss;
    checks.push({
      id: "context-restore",
      passed: !!loss && loss.applied_end > loss.applied_at_loss + 30,
      detail: loss
        ? `mount 1 applied ${loss.applied_at_loss} at the loss, ${loss.applied_end} at its end`
        : "no loss injected",
    });
    const limit = pre.renderer_mib * (1 + tolerance);
    const over = rows.filter((r) => r.after_dispose_rss.renderer_mib > limit);
    checks.push({
      id: "cold-rss",
      gating: false,
      passed: over.length === 0,
      detail: `renderer RSS after each dispose + GC + a memory-pressure purge ${rows.map((r) => r.after_dispose_rss.renderer_mib).join(", ")} MiB vs before the first mount ${pre.renderer_mib} MiB (limit ${Math.round(limit * 10) / 10})`,
    });
    const releaseRows = mounts as {
      mount: number;
      heap_max_bytes: number;
      streaming_rss: { renderer_mib: number };
      after_dispose_gc_rss: { renderer_mib: number };
    }[];
    const kept = releaseRows.filter(
      (r) =>
        r.streaming_rss.renderer_mib - r.after_dispose_gc_rss.renderer_mib <
        (0.8 * r.heap_max_bytes) / 2 ** 20,
    );
    checks.push({
      id: "instance-released",
      passed: releaseRows.length > 0 && kept.length === 0,
      detail: `renderer RSS drop at each dispose ${releaseRows.map((r) => Math.round(r.streaming_rss.renderer_mib - r.after_dispose_gc_rss.renderer_mib)).join(", ")} MiB vs 80% of each instance's heap ${releaseRows.map((r) => Math.round((0.8 * r.heap_max_bytes) / 2 ** 20)).join(", ")} MiB`,
    });
    const heldRows = mounts as {
      after_dispose_gc_rss: { renderer_mib: number };
    }[];
    const held0 = heldRows[0]?.after_dispose_gc_rss.renderer_mib ?? 0;
    const grew = heldRows.filter(
      (r) => r.after_dispose_gc_rss.renderer_mib > held0 * (1 + tolerance),
    );
    checks.push({
      id: "remount-no-growth",
      passed: heldRows.length > 0 && grew.length === 0,
      detail: `renderer RSS after each dispose + GC (no purge) ${heldRows.map((r) => r.after_dispose_gc_rss.renderer_mib).join(", ")} MiB, each within ${tolerance * 100}% of the first`,
    });
    const base = rows[0]?.heap_start_bytes ?? null;
    checks.push({
      id: "heap-baseline",
      passed: base !== null && rows.every((r) => r.heap_start_bytes === base),
      detail: `wasm heap at each mount's start: ${rows.map((r) => r.heap_start_bytes).join(", ")}`,
    });
    checks.push({
      id: "page-is-package-only",
      passed: harnessInputs.length === 0,
      detail: `${inputs.length} bundle inputs, ${harnessInputs.length} from web/gsw-receiver/`,
    });
    report.checks = checks;
    for (const c of checks)
      console.log(
        `client-live-check: ${c.passed ? "pass" : c.gating === false ? "fail (reported)" : "FAIL"} ${c.id}: ${c.detail}`,
      );
    code = checks.every((c) => c.passed || c.gating === false) ? 0 : 1;
  } finally {
    writeFileSync(
      join(dir, "client-check.json"),
      `${JSON.stringify(report, null, 1)}\n`,
    );
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(
      `client-live-check: ${e instanceof Error ? e.stack : String(e)}`,
    );
    process.exit(2);
  },
);
