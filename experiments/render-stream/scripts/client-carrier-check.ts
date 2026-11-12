// CAR5 live leg: drives web/client-carrier-check/ (the
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
// Opt-in: --legs late --late-join N adds ws-late after ws applied N transactions; its recording's first
// transaction must be full and every recorded transaction must have applied. --legs wss runs
// one websocket page at --wss, trusting only --wss-spki, and checks the host's TLS leaf evidence.
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
  EXPECTED_CHROMIUM_VERSION,
  HarnessServer,
  launchHarnessBrowser,
} from "./lib/browser-harness";

import { decodeRecording } from "./lib/render-stream-2";

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
  if (out.legs !== undefined && !["wss", "late"].includes(out.legs))
    throw new Error(
      "client-carrier-check: --legs must be wss or late when supplied",
    );
  if (
    out["late-join"] !== undefined &&
    (!/^\d+$/.test(out["late-join"]) ||
      Number(out["late-join"]) < 1 ||
      out.legs !== "late")
  )
    throw new Error(
      "client-carrier-check: --late-join needs a positive transaction count and --legs late",
    );
  if (
    out.legs === "wss" &&
    (!out.wss?.startsWith("wss://") ||
      !/^[A-Za-z0-9+/]{43}=$/.test(out["wss-spki"] ?? ""))
  )
    throw new Error(
      "client-carrier-check: wss needs --wss wss://... and --wss-spki <base64 sha256>",
    );
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
  const wss = a.legs === "wss";
  if (a.legs === "late" && !a["late-join"])
    throw new Error("--legs late requires --late-join");
  const defaultLegs = a.legs === undefined;
  const lateJoin = Number(a["late-join"] ?? 0);
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
  const launchArgs = [
    ...BROWSER_LAUNCH_ARGS,
    ...(wss ? [`--ignore-certificate-errors-spki-list=${a["wss-spki"]}`] : []),
  ];
  const launched = await launchHarnessBrowser(wss ? { args: launchArgs } : {});
  const token = readFileSync(join(a.evidence, "live-token"), "utf8").trim();
  const certHash = wss
    ? ""
    : readFileSync(join(a.evidence, "live-cert-sha256"), "utf8").trim();
  const WRONG_HASH = "0".repeat(64);
  const WRONG_TOKEN = "a".repeat(64);
  const core = {
    glueUrl: "/core/rs_gsw_wasm_client.js",
    wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
    expectedTree,
  };
  const endpoint = (hash: string, tok: string) => ({
    url: wss ? a.wss : a.ws,
    resourceBase: a.http,
    token: tok,
    protocol: 13,
    presentation: [640, 360] as [number, number],
    ...(wss ? {} : { webTransport: { url: a.wt, certificateHashes: [hash] } }),
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
    const prov = await checkBrowserProvenance(probe, launched, launchArgs, {
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
    });
    report.provenance = {
      ok: prov.ok,
      reasons: prov.reasons,
      renderer: prov.renderer,
    };
    const browserFacts = await probe.evaluate(async () => {
      const gpu = (
        navigator as Navigator & {
          gpu?: {
            requestAdapter(): Promise<{
              info?: {
                vendor?: string;
                architecture?: string;
                device?: string;
                description?: string;
              };
            } | null>;
          };
        }
      ).gpu;
      const info = gpu ? (await gpu.requestAdapter())?.info : null;
      return {
        userAgent: navigator.userAgent,
        webgpu: info
          ? {
              vendor: info.vendor,
              architecture: info.architecture,
              device: info.device,
              description: info.description,
            }
          : null,
      };
    });
    report.browser = {
      variant: process.platform === "win32" ? "cdp-swiftshader" : "linux-d9",
      product_version: launched.browser.version(),
      webgl_renderer: prov.renderer,
      ...browserFacts,
    };
    if (process.platform === "win32")
      check(
        "browser-version",
        launched.browser.version() === EXPECTED_CHROMIUM_VERSION &&
          /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(
            browserFacts.userAgent,
          )?.[1] === EXPECTED_CHROMIUM_VERSION.split(".")[0],
        `product ${launched.browser.version()}, UA ${browserFacts.userAgent}`,
      );
    await probe.close();

    // The sabotages first: they hold a connection only for a moment.
    if (defaultLegs) {
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
      const f1 = fails["wt-wrong-hash"].statuses.find(
        (s) => s.kind === "failed",
      );
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
    }

    // The default streaming legs, or the explicitly requested TLS leg.
    const legs = wss
      ? [
          {
            name: "wss",
            carrier: "websocket",
            hash: "",
            noWt: false,
            expect: "ws",
          },
        ]
      : [
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
        ];
    if (lateJoin) legs.splice(1);
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
    let lateOpenedAfter = 0;
    const done = new Set<string>();
    const timeoutMs = Number(a["timeout-s"] ?? 150) * 1000;
    while (done.size < legs.length && Date.now() - t0 < timeoutMs) {
      await sleep(250);
      if (lateJoin && !legs.some((l) => l.name === "ws-late")) {
        const stats = await call<{ applied: number } | null>(pages[0], "stats");
        if (
          (stats?.applied ?? 0) >= lateJoin &&
          !(await statuses(pages[0])).some(
            (s) => s.kind === "ended" || s.kind === "failed",
          )
        ) {
          lateOpenedAfter = stats?.applied ?? 0;
          const page = await open(false);
          legs.push({
            name: "ws-late",
            carrier: "websocket",
            hash: certHash,
            noWt: false,
            expect: "ws",
          });
          pages.push(page);
          await page.evaluate(
            ([k, o]) => (window as unknown as Record<string, Api>)[k].mount(o),
            [
              rsc,
              {
                endpoint: endpoint(certHash, token),
                core,
                carrier: "websocket",
              },
            ] as const,
          );
        }
      }
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
    for (const l of legs)
      console.log(
        `client-carrier-check: leg ${l.name}: ${JSON.stringify(results[l.name])}`,
      );
    if (lateJoin) {
      const rec = recs["ws-late"];
      const txs = rec
        ? decodeRecording(rec, 13).records.filter(
            (r) => r.meta.type === "transaction",
          )
        : [];
      const first = txs[0]?.meta as
        | { encoding?: string; seq?: number }
        | undefined;
      const applied =
        (results["ws-late"] as { applied?: number } | undefined)?.applied ?? 0;
      check(
        "late-join",
        lateOpenedAfter >= lateJoin &&
          applied > 0 &&
          txs.length === applied &&
          first?.encoding === "full",
        `ws-late opened after ws applied ${lateOpenedAfter} (requested ${lateJoin}); first transaction ${JSON.stringify(first ? { seq: first.seq, encoding: first.encoding } : null)}; ${applied}/${txs.length} transactions applied`,
      );
    }
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
    if (defaultLegs) {
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
    }
    if (wss) {
      const carriers = JSON.parse(
        readFileSync(join(a.evidence, "live-carriers.json"), "utf8"),
      ) as {
        carriers?: { name: string; tls: string; cert_sha256: string | null }[];
      };
      const ws = carriers.carriers?.find((c) => c.name === "ws");
      const leaf = readFileSync(
        join(a.evidence, "wss-cert-sha256"),
        "utf8",
      ).trim();
      check(
        "wss-tls",
        !!ws &&
          ws.tls !== "none" &&
          !!ws.tls &&
          /^[a-f0-9]{64}$/.test(leaf) &&
          ws.cert_sha256 === leaf,
        `ws TLS ${JSON.stringify(ws)}; expected leaf ${leaf}`,
      );
    }
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
    writeFileSync(
      join(dir, "client-carrier-summary.json"),
      `${JSON.stringify(
        {
          schema: "render-stream-client-carrier-summary/1",
          browser: report.browser,
          legs: report.legs,
          checks,
        },
        null,
        1,
      )}\n`,
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
