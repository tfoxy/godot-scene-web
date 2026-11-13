#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Judge an explicit subset of swap checks and require the recorded platform.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runG8sw } from "./lib/gate8-swap-checks";

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      checks: { type: "string" },
      "expect-platform": { type: "string" },
      json: { type: "string" },
    },
  });
  const expected = values["expect-platform"];
  const ids = [
    ...new Set(
      values.checks
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !values.out ||
    ids.length === 0 ||
    (expected !== "linux" && expected !== "windows")
  )
    throw new Error(
      "usage: check-g8sw.ts --out <root> --checks <id,...> --expect-platform linux|windows [--json <file>]",
    );
  const root = resolve(values.out);
  const result = await runG8sw(root);
  const problems: string[] = [];
  let rows = 0;
  const inspect = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (
        entry.name === "swap-cycle.jsonl" ||
        entry.name === "teardown.json"
      ) {
        const text = await readFile(path, "utf8");
        const records: unknown[] = entry.name.endsWith(".jsonl")
          ? text
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
          : [JSON.parse(text)];
        for (const [i, record] of records.entries()) {
          if (entry.name === "swap-cycle.jsonl") rows++;
          const platform = (record as { platform?: unknown } | null)?.platform;
          if (platform !== expected)
            problems.push(
              `${path} row ${i + 1}: platform ${platform ?? "missing"}, expected ${expected}`,
            );
        }
      }
    }
  };
  try {
    await inspect(join(root, "g8sw"));
  } catch (e) {
    problems.push(`platform evidence: ${(e as Error).message}`);
  }
  if (rows === 0) problems.push("platform evidence: no swap-cycle rows");
  const checks = ids.map(
    (id) =>
      result.checks.find((c) => c.id === id) ?? {
        id,
        passed: false,
        status: "fail" as const,
        criterion: "named check exists",
        detail: "check absent",
      },
  );
  const passed = problems.length === 0 && checks.every((c) => c.passed);
  for (const c of checks)
    console.log(
      `${c.passed ? "PASS" : c.status === "not-run" ? "NOT-JUDGED" : "FAIL"} ${c.id}: ${c.detail ?? ""}`,
    );
  for (const problem of problems) console.error(`FAIL platform: ${problem}`);
  if (values.json)
    await writeFile(
      resolve(values.json),
      `${JSON.stringify({ ...result, checks, platform: { expected, rows, problems }, passed }, null, 2)}\n`,
    );
  process.exitCode = passed ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(`check-g8sw: ${(e as Error).message}`);
  process.exitCode = 1;
});
