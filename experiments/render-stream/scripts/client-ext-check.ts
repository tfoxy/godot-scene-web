// TAG2 live leg driver (client-extensions-design.md §6, results/p3/tag2.md): drives
// web/client-ext-check/ -- the render-stream client package with one test extension -- in the
// pinned headless Chromium against a live fixtures/tag-scene host, and writes what it saw.
//
//   tsx --conditions=development experiments/render-stream/scripts/client-ext-check.ts \
//     --dir <leg out> --port <page port> --ws ws://127.0.0.1:<p>/render-stream --http http://127.0.0.1:<p> \
//     --core <build-web.sh out> --extension none|identity|moved|scaled|hidden|tinted|redraw \
//     [--sabotage override-no-inherit|override-no-damage|override-fast-path-miss] \
//     [--mode shot|dispose] [--timeout-s 60] [--pres 640x360] [--css 700x500]
//
// `shot` mounts once, waits for the stream to end (the host quits) and reads the drawing buffer
// back: <dir>/shot.png plus <dir>/client-ext.json (statuses, the page's counters, the transport's
// binary messages and acks, the animation window of `redraw`). `dispose` (the RSS check) mounts
// three times against one host -- no extension, then the extension twice -- disposing each after
// 6 s, and records the renderer RSS after each dispose, two GCs and a pressure purge.
// --sabotage serves a wrapper of the core's glue that adds the sabotage to the core's start options
// (the package's options stay the pure client's).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sharp from "../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  collectChromiumProcesses,
  HarnessServer,
  launchHarnessBrowser,
} from "./lib/browser-harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const PAGE_DIR = join(HERE, "..", "web", "client-ext-check");
// INP1: the presentation (the canvas's backing store, 1:1) and, with --css, a CSS box of another
// aspect that letterboxes it (object-fit: contain); `inp` reads the pointer mapping back.
const PRES = (
  process.argv.includes("--pres")
    ? process.argv[process.argv.indexOf("--pres") + 1]
    : "640x360"
)
  .split("x")
  .map(Number);
const W = PRES[0];
const H = PRES[1];

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-ext-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of ["dir", "port", "ws", "http", "core", "extension"])
    if (!out[k]) throw new Error(`client-ext-check: --${k} is required`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rssMiB(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

type Api = {
  mount(o: unknown): void;
  dispose(): void;
  stats(): unknown;
  probe(): unknown;
  shot(): { width: number; height: number; rgba: string } | null;
  statuses: { kind: string; reason?: string; detail?: string }[];
  counters: unknown;
  transport: unknown;
};

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  const mode = a.mode ?? "shot";
  const timeoutS = Number(a["timeout-s"] ?? 60);
  const staticDir = join(dir, "static");
  mkdirSync(join(staticDir, "core"), { recursive: true });
  const coreDir = resolve(a.core);
  for (const f of [
    "build.json",
    "rs_gsw_wasm_bg.wasm",
    "rs_gsw_wasm_client.js",
  ])
    copyFileSync(join(coreDir, f), join(staticDir, "core", f));
  let glue = "/core/rs_gsw_wasm_client.js";
  if (a.sabotage) {
    if (
      !/^(override-(no-inherit|no-damage|fast-path-miss)|inverse-skip)$/.test(
        a.sabotage,
      )
    )
      throw new Error(`client-ext-check: unknown sabotage ${a.sabotage}`);
    writeFileSync(
      join(staticDir, "core", "sabotage.js"),
      `// TAG2 sabotage ${a.sabotage}: the core's glue with the sabotage in its start options.
import factory from "./rs_gsw_wasm_client.js";
export const RENDER_STREAM_CLIENT_GLUE = 1;
export default function () {
  const m = factory();
  const G = m.GswRs;
  const W = function (canvas, options) {
    return new G(canvas, options.replace('"sabotage":[]', '"sabotage":["${a.sabotage}"]'));
  };
  W.prototype = G.prototype;
  m.GswRs = W;
  return m;
}
`,
    );
    glue = "/core/sabotage.js";
  }
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
  const server = new HarnessServer({
    staticRoot: staticDir,
    evidenceRoot: join(dir, "evidence"),
    allowedLegNonces: [],
  });
  const { origin } = await server.start(Number(a.port));
  const launched = await launchHarnessBrowser();
  const report: Record<string, unknown> = {
    schema: "render-stream-client-ext-check/1",
    mode,
    presentation: [W, H],
    extension: a.extension,
    sabotage: a.sabotage ?? null,
    origin,
    ws: a.ws,
    core_build: JSON.parse(readFileSync(join(coreDir, "build.json"), "utf8")),
    expected_tree: expectedTree,
    page_harness_inputs: inputs.filter((p) => p.includes("gsw-receiver/")),
  };
  let code = 1;
  try {
    const page = await launched.browser.newPage({
      viewport: { width: 800, height: 450 },
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page] ${m.text()}`);
    });
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      () => (window as unknown as { __rse?: unknown }).__rse !== undefined,
    );
    const prov = await checkBrowserProvenance(
      page,
      launched,
      BROWSER_LAUNCH_ARGS,
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
    const cssBox = a.css
      ? (a.css.split("x").map(Number) as [number, number])
      : undefined;
    const mount = (extension: string) =>
      page.evaluate(
        (o) => (window as unknown as { __rse: Api }).__rse.mount(o),
        {
          endpoint: {
            url: a.ws,
            resourceBase: a.http,
            token: null,
            protocol: 13,
            presentation: [W, H],
          },
          core: {
            glueUrl: glue,
            wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
            expectedTree,
          },
          extension,
          width: W,
          height: H,
          css: cssBox,
        },
      );
    const read = () =>
      page.evaluate(() => {
        const r = (window as unknown as { __rse: Api }).__rse;
        return {
          statuses: r.statuses,
          counters: r.counters,
          transport: r.transport,
          stats: r.stats(),
        };
      });
    if (mode === "shot") {
      await mount(a.extension);
      const until = Date.now() + timeoutS * 1000;
      let last = await read();
      while (Date.now() < until) {
        last = await read();
        if (
          last.statuses.some((s) => s.kind === "ended" || s.kind === "failed")
        )
          break;
        await sleep(100);
      }
      Object.assign(report, last);
      const shot = await page.evaluate(() =>
        (window as unknown as { __rse: Api }).__rse.shot(),
      );
      const ended = last.statuses.some((s) => s.kind === "ended");
      const firstFrame = last.statuses.some(
        (s) =>
          s.kind === "streaming" && (s as { firstFrame?: boolean }).firstFrame,
      );
      if (a.extension === "inp" && cssBox)
        report.probe = await page.evaluate(() =>
          (window as unknown as { __rse: Api }).__rse.probe(),
        );
      report.ended = ended;
      report.first_frame = firstFrame;
      if (shot) {
        const raw = Buffer.from(shot.rgba, "base64");
        await sharp(raw, {
          raw: { width: shot.width, height: shot.height, channels: 4 },
        })
          .png()
          .toFile(join(dir, "shot.png"));
        report.shot = {
          width: shot.width,
          height: shot.height,
          bytes: raw.length,
        };
      }
      code = ended && firstFrame && shot ? 0 : 1;
    } else if (mode === "dispose") {
      const cdp = await page.context().newCDPSession(page);
      const settle = async () => {
        for (let k = 0; k < 2; k++) {
          await cdp.send("HeapProfiler.collectGarbage");
          await sleep(500);
        }
        await cdp.send("Memory.simulatePressureNotification", {
          level: "critical",
        });
        await sleep(500);
        const ps = await collectChromiumProcesses(launched.browser);
        return (
          Math.round(
            ps
              .filter((p) => p.type === "renderer")
              .reduce((s, p) => s + (rssMiB(p.pid) ?? 0), 0) * 10,
          ) / 10
        );
      };
      const mounts: Record<string, unknown>[] = [];
      for (const ext of ["none", a.extension, a.extension]) {
        await mount(ext);
        await sleep(6000);
        const before = await read();
        await page.evaluate(() =>
          (window as unknown as { __rse: Api }).__rse.dispose(),
        );
        const rss = await settle();
        mounts.push({
          extension: ext,
          renderer_rss_mib: rss,
          heap_bytes:
            (before.stats as { heapBytes?: number } | null)?.heapBytes ?? null,
          applied:
            (before.stats as { applied?: number } | null)?.applied ?? null,
          overrides: (before.counters as { overridesSet?: number })
            .overridesSet,
        });
        console.log(
          `client-ext-check: dispose ${JSON.stringify(mounts.at(-1))}`,
        );
      }
      report.mounts = mounts;
      Object.assign(report, await read());
      code = 0;
    }
  } finally {
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
    writeFileSync(
      join(dir, "client-ext.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return code;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
