// REC1 live check driver (client-extensions-design.md §6, the REC1 row; results/p3/rec1.md):
// drives web/client-record-check/ -- the render-stream client package with the recorder on -- in
// the pinned headless Chromium against a live host that also writes a tap, then exports the
// recording and replays it through rs-core-check. The byte-for-byte comparison to the host's tap
// is the runner's job after the host quits; this driver writes the recording and its rs-core-check
// verdict.
//
//   tsx --conditions=development experiments/render-stream/scripts/client-record-check.ts \
//     --dir <out> --port <page port> --ws ws://127.0.0.1:<p>/render-stream --http http://127.0.0.1:<p> \
//     --core <build-web.sh out> --rs-core-check <path to rs-core-check> \
//     [--pres 640x360] [--timeout-s 120] [--max-bytes N]

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  HarnessServer,
  launchHarnessBrowser,
} from "./lib/browser-harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const PAGE_DIR = join(HERE, "..", "web", "client-record-check");

const PRES = (
  process.argv.includes("--pres")
    ? process.argv[process.argv.indexOf("--pres") + 1]
    : "640x360"
)
  .split("x")
  .map(Number);

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-record-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of ["dir", "port", "ws", "http", "core", "rs-core-check"])
    if (!out[k]) throw new Error(`client-record-check: --${k} is required`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Api = {
  mount(o: unknown): void;
  dispose(): void;
  stats(): { applied: number; heapBytes: number } | null;
  statuses: { kind: string; reason?: string; detail?: string; t: number }[];
  recording(): {
    bytes: string | null;
    records: number;
    fullSeq: number;
    overflow: boolean;
    resources: [string, string][];
  } | null;
};

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const timeoutS = Number(a["timeout-s"] ?? 120);
  const staticDir = join(dir, "static");
  mkdirSync(join(staticDir, "core"), { recursive: true });

  const coreDir = resolve(a.core);
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
  const launchArgs = [...BROWSER_LAUNCH_ARGS];
  const launched = await launchHarnessBrowser();
  const report: Record<string, unknown> = {
    schema: "render-stream-client-record-check/1",
    origin,
    ws: a.ws,
    core_build: coreBuild,
    expected_tree: expectedTree,
    page_inputs: inputs.length,
    page_harness_inputs: harnessInputs,
    max_bytes: a["max-bytes"] ? Number(a["max-bytes"]) : null,
  };
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
    const endpoint = {
      url: a.ws,
      resourceBase: a.http,
      token: null,
      protocol: 13,
      presentation: [PRES[0], PRES[1]] as [number, number],
    };
    const core = {
      glueUrl: "/core/rs_gsw_wasm_client.js",
      wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
      expectedTree,
    };
    const mount: Record<string, unknown> = { endpoint, core };
    if (a["max-bytes"]) mount.maxBytes = Number(a["max-bytes"]);
    await page.evaluate(
      (o) =>
        (window as unknown as { __rsc: { mount(o: unknown): void } }).__rsc.mount(
          o,
        ),
      mount,
    );
    // Wait for the stream to end (the host sends the end record at its quit frame).
    const until = Date.now() + timeoutS * 1000;
    let ended = false;
    let lastApplied = 0;
    while (Date.now() < until) {
      await sleep(200);
      const s = (await page.evaluate(() =>
        (window as unknown as { __rsc: { stats(): unknown } }).__rsc.stats(),
      )) as { applied: number; heapBytes: number } | null;
      if (s && s.applied > 0) lastApplied = s.applied;
      const statuses = (await page.evaluate(() =>
        (window as unknown as { __rsc: { statuses: unknown[] } }).__rsc
          .statuses,
      )) as { kind: string }[];
      if (statuses.some((s) => s.kind === "ended")) {
        ended = true;
        break;
      }
      if (statuses.some((s) => s.kind === "failed")) break;
    }
    const rec = (await page.evaluate(() =>
      (window as unknown as { __rsc: { recording(): unknown } }).__rsc.recording(),
    )) as {
      bytes: string | null;
      records: number;
      fullSeq: number;
      overflow: boolean;
      resources: [string, string][];
    } | null;
    const statuses = (await page.evaluate(() =>
      (window as unknown as { __rsc: { statuses: unknown[] } }).__rsc.statuses,
    )) as { kind: string; reason?: string; detail?: string }[];
    await page.evaluate(() =>
      (window as unknown as { __rsc: { dispose(): void } }).__rsc.dispose(),
    );
    report.ended = ended;
    report.last_applied = lastApplied;
    report.statuses = statuses.map(({ kind, reason, detail }) => ({
      kind,
      ...(reason ? { reason, detail } : {}),
    }));
    report.recording = rec
      ? { records: rec.records, fullSeq: rec.fullSeq, overflow: rec.overflow, resources: rec.resources.length }
      : null;

    const checks: { id: string; passed: boolean; detail: string }[] = [];
    checks.push({
      id: "stream-ended",
      passed: ended,
      detail: ended ? `ended after ${lastApplied} applies` : "the stream did not end",
    });
    let validate: { ok: boolean; detail: string } = { ok: false, detail: "no recording" };
    if (rec?.bytes !== null && rec?.bytes !== undefined) {
      const bytes = Buffer.from(rec.bytes, "base64");
      const recPath = join(dir, "recording.rs13");
      writeFileSync(recPath, bytes);
      report.recording_bytes = bytes.length;
      report.recording_sha256 = execFileSync("sha256sum", [recPath], {
        encoding: "utf8",
      }).split(/\s+/)[0];
      // Replay it through rs-core-check.
      try {
        const out = execFileSync(a["rs-core-check"], ["validate", recPath], {
          encoding: "utf8",
        });
        validate = { ok: out.includes("\tok\t"), detail: out.trim() };
      } catch (e) {
        validate = {
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }
    checks.push({
      id: "recording-validates",
      passed: validate.ok,
      detail: validate.detail,
    });
    checks.push({
      id: "page-is-package-only",
      passed: harnessInputs.length === 0,
      detail: `${inputs.length} bundle inputs, ${harnessInputs.length} from web/gsw-receiver/`,
    });
    report.checks = checks;
    for (const c of checks)
      console.log(`client-record-check: ${c.passed ? "pass" : "FAIL"} ${c.id}: ${c.detail}`);
    code = checks.every((c) => c.passed) ? 0 : 1;
  } finally {
    writeFileSync(join(dir, "client-record.json"), `${JSON.stringify(report, null, 1)}\n`);
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`client-record-check: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(2);
  },
);
