// CAR5 live leg (protocol/carrier-design.md Q5, the CAR5 row): drives web/client-carrier-check/ (the
// render-stream client package with the recorder on and a `carrier` option) in the pinned headless
// Chromium against ONE live capture started with GRC_LIVE_CARRIERS=ws,wt and a token. In that one
// run:
//   wt-wrong-hash     carrier webtransport, a wrong certificate hash       -> failed live-connect-failed
//   wt-wrong-token    carrier webtransport, a wrong token                  -> failed (unauthorized)
// then four pages stream to the host's end at once:
//   ws                carrier websocket                                    -> tap carrier ws
//   auto              carrier auto (the default), honest descriptor        -> tap carrier wt
//   auto-wrong-hash   carrier auto, wrong hash: WebTransport fails before open, same attempt on ws -> tap carrier ws
//   auto-no-wt        carrier auto, `WebTransport` deleted from the page   -> tap carrier ws
// Checks (written to <dir>/client-carrier.json; exit 1 when one fails):
//   sabotage-wrong-hash / sabotage-wrong-token   the failure legs failed as named, and never applied
//   streams-ended         every streaming leg reached `ended` having applied
//   recording-equals-tap  each streaming leg's recorder export is byte-identical to the host's tap
//                         of ITS connection (one tap file matches, and the carrier is the expected one)
//   ws-wt-same-pixels     the final canvas of the ws leg and the wt leg are pixel-identical
//   auto-fallbacks        the two fallback legs streamed over ws
// The runner (run-client-carrier-check.sh) starts the host and passes its ports and evidence.
//
//   tsx --conditions=development experiments/render-stream/scripts/client-carrier-check.ts \
//     --dir <out> --port <page port> --ws ws://127.0.0.1:<p>/render-stream --http http://127.0.0.1:<p> \
//     --wt https://127.0.0.1:<p>/render-stream --evidence <host evidence> --tap <host tap dir> --core <build-web.sh out>

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
const PAGE_DIR = join(HERE, "..", "web", "client-carrier-check");

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-carrier-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of [
    "dir",
    "port",
    "ws",
    "http",
    "wt",
    "evidence",
    "tap",
    "core",
  ])
    if (!out[k]) throw new Error(`client-carrier-check: --${k} is required`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Status {
  kind: string;
  reason?: string;
  detail?: string;
}
interface Rec {
  bytes: string;
  records: number;
  fullSeq: number;
}
type Api = {
  mount(o: unknown): void;
  dispose(): void;
  stats(): { applied: number } | null;
  statuses: Status[];
  recording(): Rec | null;
};
const rsc = "__rsc";

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const staticDir = join(dir, "static");
  mkdirSync(join(staticDir, "core"), { recursive: true });
  const coreDir = resolve(a.core);
  for (const f of [
    "build.json",
    "rs_gsw_wasm_bg.wasm",
    "rs_gsw_wasm_client.js",
  ])
    copyFileSync(join(coreDir, f), join(staticDir, "core", f));
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
    splitting: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outdir: staticDir,
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
  const launched = await launchHarnessBrowser();
  const token = readFileSync(join(a.evidence, "live-token"), "utf8").trim();
  const certHash = readFileSync(
    join(a.evidence, "live-cert-sha256"),
    "utf8",
  ).trim();
  const WRONG_HASH = "0".repeat(64);
  const WRONG_TOKEN = "a".repeat(64);
  const core = {
    glueUrl: "/core/rs_gsw_wasm_client.js",
    wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
    expectedTree,
  };
  const endpoint = (hash: string, tok: string) => ({
    url: a.ws,
    resourceBase: a.http,
    token: tok,
    protocol: 13,
    presentation: [640, 360] as [number, number],
    webTransport: { url: a.wt, certificateHashes: [hash] },
  });
  const report: Record<string, unknown> = {
    schema: "render-stream-client-carrier-check/1",
    origin,
    chromium: launched.browser.version(),
    core_build: JSON.parse(readFileSync(join(coreDir, "build.json"), "utf8")),
    page_inputs: inputs.length,
    page_harness_inputs: harnessInputs,
  };
  const checks: { id: string; passed: boolean; detail: string }[] = [];
  const check = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
    console.log(
      `client-carrier-check: ${passed ? "pass" : "FAIL"} ${id}: ${detail}`,
    );
  };

  const open = async (noWt: boolean) => {
    const page = await launched.browser.newPage({
      viewport: { width: 640, height: 360 },
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page] ${m.text()}`);
    });
    if (noWt)
      await page.addInitScript(
        () => delete (globalThis as { WebTransport?: unknown }).WebTransport,
      );
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      (k) => (window as unknown as Record<string, unknown>)[k] !== undefined,
      rsc,
    );
    return page;
  };
  const call = <T>(
    page: import("playwright-core").Page,
    fn: string,
  ): Promise<T> =>
    page.evaluate(
      ([k, f]) =>
        (window as unknown as Record<string, Record<string, () => unknown>>)[k][
          f
        ](),
      [rsc, fn],
    ) as Promise<T>;
  const statuses = (page: import("playwright-core").Page) =>
    page.evaluate(
      (k) => (window as unknown as Record<string, Api>)[k].statuses,
      rsc,
    );

  try {
    const probe = await open(false);
    const prov = await checkBrowserProvenance(
      probe,
      launched,
      [...BROWSER_LAUNCH_ARGS],
      {
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
      },
    );
    report.provenance = {
      ok: prov.ok,
      reasons: prov.reasons,
      renderer: prov.renderer,
    };
    await probe.close();

    // The sabotages first: they hold a connection only for a moment.
    const fails: Record<string, { statuses: Status[]; applied: number }> = {};
    for (const [name, hash, tok] of [
      ["wt-wrong-hash", WRONG_HASH, token],
      ["wt-wrong-token", certHash, WRONG_TOKEN],
    ] as const) {
      const page = await open(false);
      await page.evaluate(
        ([k, o]) => (window as unknown as Record<string, Api>)[k].mount(o),
        [
          rsc,
          { endpoint: endpoint(hash, tok), core, carrier: "webtransport" },
        ] as const,
      );
      const until = Date.now() + 20000;
      let st: Status[] = [];
      while (Date.now() < until) {
        await sleep(200);
        st = await statuses(page);
        if (st.some((s) => s.kind === "failed")) break;
      }
      const stats = await call<{ applied: number } | null>(page, "stats");
      fails[name] = { statuses: st, applied: stats?.applied ?? 0 };
      await page.evaluate(
        (k) => (window as unknown as Record<string, Api>)[k].dispose(),
        rsc,
      );
      await page.close();
    }
    report.sabotages = fails;
    const f1 = fails["wt-wrong-hash"].statuses.find((s) => s.kind === "failed");
    check(
      "sabotage-wrong-hash",
      f1?.reason === "live-connect-failed" &&
        fails["wt-wrong-hash"].applied === 0,
      `carrier webtransport, wrong certificate hash: ${JSON.stringify(f1)}`,
    );
    const f2 = fails["wt-wrong-token"].statuses.find(
      (s) => s.kind === "failed",
    );
    check(
      "sabotage-wrong-token",
      f2?.reason === "live-connect-failed" &&
        (f2.detail ?? "").includes("unauthorized") &&
        fails["wt-wrong-token"].applied === 0,
      `carrier webtransport, wrong token: ${JSON.stringify(f2)}`,
    );

    // The four streaming legs, together.
    const legs = [
      {
        name: "ws",
        carrier: "websocket",
        hash: certHash,
        noWt: false,
        expect: "ws",
      },
      {
        name: "auto",
        carrier: "auto",
        hash: certHash,
        noWt: false,
        expect: "wt",
      },
      {
        name: "auto-wrong-hash",
        carrier: "auto",
        hash: WRONG_HASH,
        noWt: false,
        expect: "ws",
      },
      {
        name: "auto-no-wt",
        carrier: "auto",
        hash: certHash,
        noWt: true,
        expect: "ws",
      },
    ] as const;
    const pages = await Promise.all(legs.map((l) => open(l.noWt)));
    const t0 = Date.now();
    for (let i = 0; i < legs.length; i++)
      await pages[i].evaluate(
        ([k, o]) => (window as unknown as Record<string, Api>)[k].mount(o),
        [
          rsc,
          {
            endpoint: endpoint(legs[i].hash, token),
            core,
            carrier: legs[i].carrier,
          },
        ] as const,
      );
    const done = new Set<string>();
    const timeoutMs = Number(a["timeout-s"] ?? 150) * 1000;
    while (done.size < legs.length && Date.now() - t0 < timeoutMs) {
      await sleep(250);
      for (let i = 0; i < legs.length; i++) {
        if (done.has(legs[i].name)) continue;
        const st = await statuses(pages[i]);
        if (st.some((s) => s.kind === "ended" || s.kind === "failed"))
          done.add(legs[i].name);
      }
    }
    const results: Record<string, unknown> = {};
    const recs: Record<string, Buffer | null> = {};
    const pngs: Record<string, Buffer> = {};
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const st = await statuses(pages[i]);
      const stats = await call<{ applied: number } | null>(pages[i], "stats");
      const rec = await call<Rec | null>(pages[i], "recording");
      recs[l.name] = rec ? Buffer.from(rec.bytes, "base64") : null;
      if (recs[l.name])
        writeFileSync(
          join(dir, `recording-${l.name}.rs13`),
          recs[l.name] as Buffer,
        );
      pngs[l.name] = await pages[i].locator("canvas").screenshot();
      writeFileSync(join(dir, `final-${l.name}.png`), pngs[l.name]);
      results[l.name] = {
        carrier: l.carrier,
        ended: st.some((s) => s.kind === "ended"),
        failed: st.find((s) => s.kind === "failed") ?? null,
        applied: stats?.applied ?? 0,
        records: rec?.records ?? 0,
        recording_bytes: recs[l.name]?.length ?? 0,
      };
    }
    report.legs = results;
    const bad = legs.filter((l) => {
      const r = results[l.name] as { ended: boolean; applied: number };
      return !r.ended || r.applied === 0;
    });
    check(
      "streams-ended",
      bad.length === 0,
      legs
        .map((l) => `${l.name}: ${JSON.stringify(results[l.name])}`)
        .join("; "),
    );

    // The host's tap: wait for the stream files to settle, then match each recording.
    await sleep(1500);
    const taps = readdirSync(a.tap)
      .filter((f) => /^stream-\d+\.rs2$/.test(f))
      .map((f) => {
        const n = /\d+/.exec(f)?.[0] as string;
        const log = join(a.tap, `live-${n}.jsonl`);
        const text = existsSync(log) ? readFileSync(log, "utf8") : "";
        const carrier = /"carrier":"(\w+)"/.exec(text)?.[1] ?? "?";
        return { n, carrier, bytes: readFileSync(join(a.tap, f)) };
      });
    report.taps = taps.map((t) => ({
      n: t.n,
      carrier: t.carrier,
      bytes: t.bytes.length,
    }));
    const matches: string[] = [];
    let allEqual = true;
    for (const l of legs) {
      const r = recs[l.name];
      const m = r ? taps.filter((t) => t.bytes.equals(r)) : [];
      const carriers = m.map((t) => t.carrier);
      const good = m.length >= 1 && carriers.includes(l.expect);
      if (!good) allEqual = false;
      matches.push(
        `${l.name} == tap ${m.map((t) => `${t.n}(${t.carrier})`).join(",") || "none"} (want ${l.expect})`,
      );
    }
    check("recording-equals-tap", allEqual, matches.join("; "));
    const fbOk = ["auto-wrong-hash", "auto-no-wt"].every((n) => {
      const r = results[n] as { ended: boolean; applied: number };
      return r.ended && r.applied > 0;
    });
    check(
      "auto-fallbacks",
      fbOk && allEqual,
      "auto-wrong-hash and auto-no-wt streamed over ws (their taps carry carrier ws)",
    );
    const same = pngs.ws.equals(pngs.auto) && pngs.ws.length > 1500;
    check(
      "ws-wt-same-pixels",
      same,
      `final canvas ws ${pngs.ws.length} B vs wt ${pngs.auto.length} B ${same ? "identical" : "DIFFER"}`,
    );
    for (const p of pages) await p.close().catch(() => {});
    check(
      "page-is-package-only",
      harnessInputs.length === 0,
      `${inputs.length} bundle inputs, ${harnessInputs.length} from web/gsw-receiver/`,
    );
  } finally {
    report.checks = checks;
    writeFileSync(
      join(dir, "client-carrier.json"),
      `${JSON.stringify(report, null, 1)}\n`,
    );
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
  }
  return checks.length > 0 && checks.every((c) => c.passed) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(
      `client-carrier-check: ${e instanceof Error ? e.stack : String(e)}`,
    );
    process.exit(2);
  },
);
