// Headless browser driver for run-gate8.sh's g8id2 group; no alternate client implementation.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  HarnessServer,
  launchHarnessBrowser,
} from "../../../../experiments/render-stream/scripts/lib/browser-harness";

import { splitRecords } from "../../../../experiments/render-stream/scripts/lib/render-stream-2";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const a = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((xs, v, i, all) => {
    if (i % 2 === 0) xs.push([v.replace(/^--/, ""), all[i + 1]]);
    return xs;
  }, []),
);
for (const k of ["dir", "core", "port", "ws", "http", "mode"])
  if (!a[k]) throw new Error(`missing --${k}`);
const staticDir = join(a.dir, "static");
mkdirSync(join(staticDir, "core"), { recursive: true });
for (const f of ["build.json", "rs_gsw_wasm_bg.wasm", "rs_gsw_wasm_client.js"])
  copyFileSync(join(a.core, f), join(staticDir, "core", f));
writeFileSync(
  join(staticDir, "index.html"),
  '<!doctype html><script type="module" src="/page.js"></script>',
);
if (a.sabotage && a.sabotage !== "ignore-host-filter")
  throw new Error(`unknown sabotage ${a.sabotage}`);
await build({
  entryPoints: [join(here, "page.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  conditions: ["development"],
  outfile: join(staticDir, "page.js"),
  logLevel: "warning",
  plugins: a.sabotage
    ? [
        {
          name: "ignore-host-filter",
          setup(b) {
            b.onLoad({ filter: /\/src\/extensions\.ts$/ }, ({ path }) => {
              const source = readFileSync(path, "utf8");
              const marker = "filters[k++] = f;\n    }\n    this.call(() =>";
              if (!source.includes(marker))
                throw new Error("host-filter sabotage splice missing");
              return {
                contents: source.replace(
                  marker,
                  "filters[k++] = this.hitFilters.get(id) ?? f;\n    }\n    this.call(() =>",
                ),
                loader: "ts",
              };
            });
          },
        },
      ]
    : [],
});
const tree = execFileSync(
  "bash",
  [join(root, "packages/render-stream-client/scripts/core-tree.sh"), root],
  { encoding: "utf8" },
).trim();
const server = new HarnessServer({
  staticRoot: staticDir,
  evidenceRoot: join(a.dir, "evidence"),
  allowedLegNonces: [],
});
const { origin } = await server.start(Number(a.port));
const launched = await launchHarnessBrowser();
try {
  const page = await launched.browser.newPage({
    viewport: { width: 640, height: 360 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error(e));
  await page.goto(
    `${origin}/index.html?${new URLSearchParams({ mode: a.mode, ws: a.ws, http: a.http, tree })}`,
  );
  await page.waitForFunction(
    () => (window as unknown as { __id4?: unknown }).__id4 !== undefined,
  );
  const provenance = await checkBrowserProvenance(
    page,
    launched,
    BROWSER_LAUNCH_ARGS,
    { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
  );
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __id4: { statuses: { kind: string }[] } }
      ).__id4.statuses.some((s) => s.kind === "ended" || s.kind === "failed"),
    undefined,
    { timeout: 90000 },
  );
  const report = await page.evaluate(
    () =>
      (
        window as unknown as {
          __id4: { samples: { seq: number; frame: number }[] };
        }
      ).__id4,
  );
  const bytes = new Uint8Array(
    await page.evaluate(() =>
      (window as unknown as { __recording(): number[] }).__recording(),
    ),
  );
  writeFileSync(join(a.dir, "decoded.rs"), bytes);
  const frameBySeq = new Map<number, number>();
  for (const r of splitRecords(
    bytes,
    a.mode === "pure" || a.mode === "tag1" ? 13 : 14,
  ).records) {
    const n = new DataView(r.bytes.buffer, r.bytes.byteOffset).getUint32(
      4,
      true,
    );
    const m = JSON.parse(new TextDecoder().decode(r.bytes.subarray(8, 8 + n)));
    if (m.type === "transaction") frameBySeq.set(m.seq, m.frame);
  }
  for (const s of report.samples) s.frame = frameBySeq.get(s.seq) ?? -1;
  writeFileSync(
    join(a.dir, "client-id2.json"),
    JSON.stringify(
      {
        ...report,
        provenance: { ok: provenance.ok, reasons: provenance.reasons },
        mode: a.mode,
        sabotage: a.sabotage ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await launched.browser.close();
  await server.stop();
}
