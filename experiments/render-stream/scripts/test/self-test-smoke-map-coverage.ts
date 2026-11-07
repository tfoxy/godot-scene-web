#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Every tracked path must match a smoke-map rule. The planner still escalates an
// unmatched diff to every target; this pure check prevents gaps from accumulating.
// --paths-from FILE appends synthetic paths to exercise the failure without git add.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const scripts = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--paths-from")) {
  throw new Error("usage: self-test-smoke-map-coverage.ts [--paths-from FILE]");
}

const tracked = execFileSync("git", ["-C", repo, "ls-files"], {
  encoding: "utf8",
});
const extra = args.length === 2 ? readFileSync(args[1], "utf8") : "";
const scratch = mkdtempSync(join(tmpdir(), "smoke-map-coverage-"));
try {
  const paths = join(scratch, "paths.txt");
  writeFileSync(paths, `${tracked}\n${extra}`);
  const plan = JSON.parse(
    execFileSync(
      "python3",
      [
        join(scripts, "lib/smoke-plan.py"),
        "--map",
        join(scripts, "smoke-map.json"),
        "--repo",
        repo,
        "--paths-from",
        paths,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  ) as { paths: unknown[]; unmatched: string[] };
  if (plan.unmatched.length > 0) {
    console.error(
      `FAIL self-test-smoke-map-coverage: ${plan.unmatched.length} path(s) match no smoke-map rule:\n${plan.unmatched.map((path) => `  ${path}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `PASS self-test-smoke-map-coverage: all ${plan.paths.length} paths match a rule`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
