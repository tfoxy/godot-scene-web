#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 runner helpers (G7e), called by run-gate7.sh:
//
//   gate7-tool.ts source-provenance --extension E --out <source run>/gate7-source.json
//     writes the current build's D21 provenance next to a source run it just made
//   gate7-tool.ts discover --source <gate N run>
//     lists the source run's file receiver legs and which are replayed (lib/gate7b-adapters.ts)
//   gate7-tool.ts web-legs --group g7-<N> --source <gate N run> --bundle <bundle dir> --out <gate 7 run>
//     [--only a,b] [--repeat-differing] [--core gdscript|rust]
//     replays the group's native receiver legs in the web-export receiver (lib/gate7-web-legs.ts);
//     --core rust (G7xw) runs them on the shared Rust core (RS_RECEIVER_CORE=rust) and needs a
//     build-web-receiver.sh --core rust bundle
//   gate7-tool.ts source-inputs --source gate0=<run>,gate1=<run>,... --out <inputs.json>
//     (G7a) every capture recording of the source runs (`*/capture*/recording*.rs2` and the live
//     receivers' `received.rs2`), each once by sha256, as render-stream-gate7-bench-inputs/1 for
//     self-test-rs-core.ts (Q14d "Real recordings")
//   gate7-tool.ts gsw-bundle --out <dir> [--rs-build <artifacts/render-stream/rs-core/<sha>>]
//     (G7a) bundles the GSW canvas receiver (lib/gsw-bundle.ts); prints the directory
//   gate7-tool.ts gsw-legs --group g7-<0..5> --source <gate run> --bundle <gsw bundle> --out <gate 7 run>
//     (G7a) replays the group's native receiver legs, and its GSW-only sabotages, in the GSW canvas
//     receiver into <out>/<gate>/gsw/ (lib/gate7-gsw.ts)
//   gate7-tool.ts browser-receiver --dir <leg dir> [--kind web|gsw] [--port N] [--bundle <dir>]
//     [--static-root <dir>] [--timeout-s S]
//     (G7l) one browser receiver leg of a gate's own runner, in one process (lib/gate7-live-legs.ts).
//     Options default to the runner's GATE7_* environment; exits with the receiver's exit code
//     (124 timeout, 143 SIGTERM)
//   gate7-tool.ts browser-daemon --ready-file <json> --parent <pid> [--kind …] [--bundle …]
//     [--static-root …] [--core gdscript|rust]
//     (G7l) what lib/legs.sh uses under GATE7_LIVE_KIND: serves browser receiver legs (GET
//     /run?dir=…&port=…&timeout_s=…) with the next leg's fresh browser already launched and
//     checked; exits when <pid> is gone. `--core` (default GATE7_WEB_CORE, else gdscript; G7xwl)
//     is the web export's core, and GATE7_WEB_CORE_SABOTAGE=drop-env is its harness sabotage

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentBuildProvenance, gate0WebLegSpecs } from "./lib/gate7-adapters";
import { type GswGate, gswLegSpecs } from "./lib/gate7-gsw";
import {
  bundleBuildSha256,
  runBrowserReceiver,
  serveBrowserDaemon,
  webCoreOf,
} from "./lib/gate7-live-legs";
import { runWebLegs } from "./lib/gate7-web-legs";
import {
  classifyLegShots,
  discoverFileReceiverLegs,
  gateDefForGroup,
  webLegSpecs,
} from "./lib/gate7b-adapters";
import { buildGswBundle, DEFAULT_RS_BUILD } from "./lib/gsw-bundle";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
export const PINNED_LINUX_TEMPLATE = join(
  homedir(),
  ".cache",
  "godot-render-stream",
  "templates",
  "4.5.1-stable",
  "linux_release.x86_64",
);

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`gate7-tool: ${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2).filter((a) => a !== "--");
  if (command === "source-provenance") {
    const doc = currentBuildProvenance(
      REPO_ROOT,
      resolve(flag(argv, "--extension")),
      PINNED_LINUX_TEMPLATE,
    );
    writeFileSync(
      resolve(flag(argv, "--out")),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
    return;
  }
  if (command === "discover") {
    for (const d of discoverFileReceiverLegs(resolve(flag(argv, "--source"))))
      console.log(
        `${d.excluded ? `[${d.excluded}]` : "[replay]"} ${d.leg}${d.headless ? " headless" : ""}${d.resolution ? ` ${d.resolution}` : ""}${d.sabotage ? ` sabotage=${d.sabotage}` : ""}`,
      );
    return;
  }
  if (command === "web-legs") {
    const group = flag(argv, "--group");
    const def = gateDefForGroup(group);
    if (group !== "g7-0" && !def)
      throw new Error(`gate7-tool: no web legs for ${group}`);
    const out = resolve(flag(argv, "--out"));
    const source = resolve(flag(argv, "--source"));
    const bundle = resolve(flag(argv, "--bundle"));
    // --only <substring,...> (development): replay only the legs whose id contains one of them.
    const onlyAt = argv.indexOf("--only");
    const only = onlyAt >= 0 ? (argv[onlyAt + 1] ?? "").split(",") : [];
    const build = JSON.parse(
      readFileSync(join(bundle, "build.json"), "utf8"),
    ) as { pck: { sha256: string }; core?: string };
    const coreAt = argv.indexOf("--core");
    const core = coreAt >= 0 ? argv[coreAt + 1] : "gdscript";
    if (core !== "gdscript" && core !== "rust")
      throw new Error(`gate7-tool: --core is gdscript or rust, not ${core}`);
    if (core === "rust" && build.core !== "rust")
      throw new Error(
        `gate7-tool: --core rust needs a build-web-receiver.sh --core rust bundle; ${bundle} is ${build.core ?? "gdscript"}`,
      );
    const gate = def ? def.gate : "gate0";
    let specs = def
      ? webLegSpecs(source, join(out, gate, "web")).specs
      : gate0WebLegSpecs(source, join(out, "gate0", "web"));
    if (only.length > 0)
      specs = specs.filter((s) => only.some((o) => s.leg.includes(o)));
    const results = await runWebLegs(
      {
        out,
        gate,
        sourceDir: source,
        bundleDir: bundle,
        buildSha256: build.pck.sha256,
        core,
      },
      specs,
    );
    const refused = results.filter((r) => !r.provenanceOk);
    if (refused.length > 0) {
      console.error(
        `gate7-tool: harness-refused (browser-provenance) on ${refused.map((r) => r.leg).join(", ")}`,
      );
    }
    // Q7 (G7b): a band needs a same-build repeat. --repeat-differing replays every leg with a shot
    // that differs from its native shot once more, into <out>/<gate>/web-repeat/<leg>.
    if (def && argv.includes("--repeat-differing")) {
      const again: typeof specs = [];
      for (const s of specs) {
        const shots = await classifyLegShots(s.leg, s.nativeDir, s.webDir);
        if (
          shots.some(
            (x) => !x.classes || x.classes.identical !== x.classes.pixels,
          )
        )
          again.push({
            ...s,
            webDir: join(out, gate, "web-repeat", s.leg),
            compositor: false,
          });
      }
      console.log(
        `gate7-tool: repeating ${again.length} legs whose shots differ from native`,
      );
      if (again.length > 0)
        await runWebLegs(
          {
            out,
            gate,
            sourceDir: source,
            bundleDir: bundle,
            buildSha256: build.pck.sha256,
            core,
          },
          again,
        );
    }
    return;
  }
  if (command === "source-inputs") {
    const inputs: {
      name: string;
      recording: string;
      store?: string;
      source: string;
    }[] = [];
    const seen = new Set<string>();
    for (const pair of flag(argv, "--source").split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      const gate = pair.slice(0, eq);
      const root = resolve(pair.slice(eq + 1));
      const found: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        for (const e of readdirSync(dir).sort()) {
          const p = join(dir, e);
          if (statSync(p).isDirectory()) walk(p, depth + 1);
          else if (
            /\/capture[^/]*\/recording[^/]*\.rs2$/.test(p) ||
            /\/live\/receiver\/received\.rs2$/.test(p)
          )
            found.push(p);
        }
      };
      walk(root, 0);
      for (const p of found) {
        const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
        if (seen.has(sha)) continue;
        seen.add(sha);
        const store = join(p, "..", "store");
        inputs.push({
          name: `${gate}-${p
            .slice(root.length + 1)
            .replace(/\//g, "-")
            .replace(/\.rs2$/, "")}`,
          recording: p,
          ...(existsSync(store) ? { store } : {}),
          source: `${gate} source run`,
        });
      }
    }
    writeFileSync(
      resolve(flag(argv, "--out")),
      `${JSON.stringify({ schema: "render-stream-gate7-bench-inputs/1", inputs }, null, 2)}\n`,
    );
    console.log(`gate7-tool: ${inputs.length} source recordings`);
    return;
  }
  if (command === "gsw-bundle") {
    const i = argv.indexOf("--rs-build");
    const rsBuild =
      i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : DEFAULT_RS_BUILD;
    const bundle = await buildGswBundle(resolve(flag(argv, "--out")), rsBuild);
    console.log(bundle.dir);
    return;
  }
  if (command === "gsw-legs") {
    const group = flag(argv, "--group");
    const gate = (
      {
        "g7-0": "gate0",
        "g7-1": "gate1",
        "g7-2": "gate2",
        "g7-3": "gate3",
        "g7-55": "gate55",
        "g7-4": "gate4",
        "g7-5": "gate5",
      } as Record<string, GswGate>
    )[group];
    if (!gate)
      throw new Error(
        `gate7-tool: no gsw legs for ${group} (G7a lands g7-0..g7-3, G7t g7-4 and g7-5, G7s g7-55)`,
      );
    const out = resolve(flag(argv, "--out"));
    const source = resolve(flag(argv, "--source"));
    const bundle = resolve(flag(argv, "--bundle"));
    const build = JSON.parse(
      readFileSync(join(bundle, "build.json"), "utf8"),
    ) as {
      sha256: string;
    };
    const results = await runWebLegs(
      {
        out,
        gate,
        sourceDir: source,
        bundleDir: bundle,
        buildSha256: build.sha256,
        kind: "gsw",
      },
      gswLegSpecs(gate, source, join(out, gate, "gsw")),
    );
    const refused = results.filter((r) => !r.provenanceOk);
    if (refused.length > 0)
      console.error(
        `gate7-tool: harness-refused (browser-provenance) on ${refused.map((r) => r.leg).join(", ")}`,
      );
    return;
  }
  if (command === "browser-receiver" || command === "browser-daemon") {
    // G7l: one browser receiver leg inside a gate's own runner (lib/legs.sh, GATE7_LIVE_KIND).
    // Every option defaults to the runner's GATE7_* environment.
    const opt = (name: string, envName: string): string | undefined => {
      const i = argv.indexOf(name);
      return (i >= 0 ? argv[i + 1] : undefined) ?? process.env[envName];
    };
    const kind = opt("--kind", "GATE7_LIVE_KIND");
    if (kind !== "web" && kind !== "gsw")
      throw new Error(
        `gate7-tool: browser-receiver needs --kind or GATE7_LIVE_KIND web|gsw (got ${kind})`,
      );
    const bundle = opt("--bundle", "GATE7_BUNDLE_DIR");
    const staticRoot = opt("--static-root", "GATE7_STATIC_ROOT");
    if (!bundle || !staticRoot)
      throw new Error(
        "gate7-tool: browser-receiver needs --bundle/GATE7_BUNDLE_DIR and --static-root/GATE7_STATIC_ROOT",
      );
    const ctx = {
      kind,
      bundleDir: resolve(bundle),
      staticRoot: resolve(staticRoot),
      buildSha256:
        process.env.GATE7_BUILD_SHA256 ||
        bundleBuildSha256(resolve(bundle), kind),
      manifestSha256: process.env.GATE7_MANIFEST_SHA256 || undefined,
      // G7xwl: --core / GATE7_WEB_CORE (run-gate7.sh --live --web-core).
      ...webCoreOf(
        kind,
        resolve(bundle),
        opt("--core", "GATE7_WEB_CORE"),
        process.env.GATE7_WEB_CORE_SABOTAGE,
      ),
    } as const;
    if (command === "browser-daemon") {
      await serveBrowserDaemon(
        ctx,
        resolve(flag(argv, "--ready-file")),
        Number(flag(argv, "--parent")),
      );
      return;
    }
    const port = Number(opt("--port", "GATE7_HARNESS_PORT"));
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      throw new Error(
        "gate7-tool: browser-receiver needs --port or GATE7_HARNESS_PORT",
      );
    const timeoutS = Number(opt("--timeout-s", "GATE7_TIMEOUT_S") ?? "180");
    const code = await runBrowserReceiver(ctx, {
      dir: resolve(flag(argv, "--dir")),
      port,
      timeoutMs: timeoutS * 1000,
    });
    process.exit(code);
  }
  throw new Error(`gate7-tool: unknown command ${command ?? "<none>"}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
