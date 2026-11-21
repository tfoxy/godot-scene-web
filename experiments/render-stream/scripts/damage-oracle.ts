#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import type { OracleReport } from "../web/bench/oracle";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  HarnessServer,
  launchHarnessBrowser,
  linkTo,
} from "./lib/browser-harness";
import { DEFAULT_RS_BUILD } from "./lib/gsw-bundle";
import { quietAcquire } from "./lib/quiet-lock";

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      recording: { type: "string" },
      store: { type: "string" },
      out: { type: "string" },
      "apply-every": { type: "string", default: "3" },
      "from-seq": { type: "string" },
      "to-seq": { type: "string" },
      "static-shaders": { type: "boolean", default: false },
      sabotage: { type: "string" },
      batching: { type: "string", default: "0" },
      damage: { type: "string", default: "on" },
      "rs-build": { type: "string", default: DEFAULT_RS_BUILD },
      "allow-no-partial": { type: "boolean", default: false },
    },
  });
  if (!a.recording || !a.store || !a.out)
    throw new Error(
      "required: --recording <patch.rs> --store <dir> --out <dir>",
    );
  for (const key of ["apply-every", "from-seq", "to-seq"] as const) {
    const value = a[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(Number(value)) ||
        Number(value) < (key === "apply-every" ? 1 : 0))
    )
      throw new Error(`invalid --${key}: ${value}`);
  }
  if (
    Number(a["from-seq"] ?? 0) > Number(a["to-seq"] ?? Number.MAX_SAFE_INTEGER)
  )
    throw new Error("from-seq exceeds to-seq");
  if (
    !Number.isInteger(Number(a.batching)) ||
    Number(a.batching) < 0 ||
    Number(a.batching) > 0xffff_ffff
  )
    throw new Error(`invalid --batching: ${a.batching}`);
  if (!["on", "off"].includes(a.damage))
    throw new Error(`invalid --damage: ${a.damage}`);
  if (
    a.sabotage &&
    ![
      "damage-no-scissor-clear",
      "damage-skip-back-producers",
      "slot-swap",
    ].includes(a.sabotage)
  )
    throw new Error(`unknown sabotage ${a.sabotage}`);
  const out = resolve(a.out);
  const site = join(out, "site");
  const bench = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../web/bench",
  );
  await mkdir(site, { recursive: true });
  await copyFile(join(bench, "rs.html"), join(site, "rs.html"));
  await build({
    entryPoints: [join(bench, "bench-rs.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outfile: join(site, "bench-rs.js"),
    logLevel: "warning",
  });
  for (const [target, name] of [
    [resolve(a.recording), "patch.rs"],
    [resolve(a.store), "store"],
    [join(resolve(a["rs-build"]), "gsw-rs"), "gsw-rs"],
  ]) {
    const error = linkTo(target, join(site, name));
    if (error) throw new Error(error);
  }
  const nonce = randomBytes(8).toString("hex");
  const server = new HarnessServer({
    staticRoot: site,
    evidenceRoot: out,
    evidenceDirs: { [nonce]: out },
    allowedLegNonces: [nonce],
    crossOriginIsolated: true,
  });
  const started = Date.now();
  const hold = await quietAcquire("shared", "damage-oracle", {
    log: join(out, "quiet.jsonl"),
  });
  let closeBrowser = async () => {};
  try {
    const { origin } = await server.start();
    const launched = await launchHarnessBrowser();
    closeBrowser = () => launched.browser.close();
    const context = await launched.browser.newContext({
      viewport: { width: 640, height: 360 },
    });
    const page = await context.newPage();
    // Check the same real-GPU/headless provenance as the browser bench before starting replay.
    await page.goto(`${origin}/rs.html?mode=idle`);
    const provenance = await checkBrowserProvenance(
      page,
      launched,
      [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS],
      { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    );
    await writeFile(
      join(out, "provenance.json"),
      JSON.stringify(provenance, null, 2),
    );
    if (!provenance.ok)
      throw new Error(`browser-provenance: ${provenance.reasons.join("; ")}`);
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    const query = new URLSearchParams({
      mode: "oracle",
      input: "/patch.rs",
      store: "/store",
      nonce,
      "apply-every": a["apply-every"],
      batching: a.batching,
      damage: a.damage,
    });
    for (const key of ["from-seq", "to-seq", "sabotage"] as const)
      if (a[key] !== undefined) query.set(key, a[key]);
    if (a["static-shaders"]) query.set("static-shaders", "1");
    await page.goto(`${origin}/rs.html?${query}`);
    const pulse = setInterval(() => {
      void page
        .evaluate(() => window.__bench)
        .then((state) => {
          if (state) console.error(state.detail);
        })
        .catch(() => {});
    }, 30_000);
    try {
      await page.waitForFunction(
        () =>
          window.__bench?.state === "done" || window.__bench?.state === "error",
        undefined,
        { timeout: 1_800_000 },
      );
    } finally {
      clearInterval(pulse);
    }
    const state = await page.evaluate(() => window.__bench);
    if (state?.state !== "done")
      throw new Error(state?.error ?? state?.detail ?? "oracle page failed");
    const report = JSON.parse(
      await readFile(join(out, "oracle.json"), "utf8"),
    ) as OracleReport;
    console.log(
      JSON.stringify({
        ...report,
        damage_modes: undefined,
        path: join(out, "oracle.json"),
      }),
    );
    if (report.mismatched || (!a["allow-no-partial"] && report.partial === 0))
      process.exitCode = 1;
  } finally {
    await closeBrowser();
    await server.stop();
    await hold.release();
    await writeFile(
      join(out, "validate-summary.json"),
      JSON.stringify(
        {
          wall_s: (Date.now() - started) / 1000,
          lock_wait_s: hold.waitS,
          command: process.argv,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 2;
});
