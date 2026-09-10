import { readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { parityArtifactRelativePath, runParityFixtures } from "./parity";

const args = process.argv.slice(2);
const positionalArgs = args.filter(
  (arg) => arg !== "--" && !arg.startsWith("--"),
);
const fixturePath = positionalArgs[0] ?? "fixtures/offsets/basic.tscn";
const toleranceIndex = args.indexOf("--tolerance");
const artifactsIndex = args.indexOf("--artifacts");
const runAll = args.includes("--all");
const noScreenshot = args.includes("--no-screenshot");
const godotScreenshot = args.includes("--godot-screenshot");
const noGodotScreenshot = args.includes("--no-godot-screenshot");

const tolerancePx =
  toleranceIndex >= 0 ? Number(args[toleranceIndex + 1]) : undefined;
const artifactsDir = artifactsIndex >= 0 ? args[artifactsIndex + 1] : undefined;

try {
  const fixturePaths = runAll
    ? await collectFixturePaths(resolve("fixtures"))
    : [fixturePath];
  const results = await runParityFixtures(
    fixturePaths.map((path) => ({
      fixturePath: path,
      artifactsDir:
        runAll && artifactsDir
          ? join(artifactsDir, fixtureArtifactName(path))
          : artifactsDir,
      tolerancePx,
      screenshot: !noScreenshot,
      godotScreenshot,
      noGodotScreenshot,
    })),
  );

  const summary = results.map((result) => ({
    ok: result.ok,
    fixturePath: parityArtifactRelativePath(result.fixturePath),
    artifactsDir: parityArtifactRelativePath(result.artifactsDir),
    mismatches: result.comparison.mismatches.length,
    imageDiff: result.comparison.imageDiff
      ? {
          ok: result.comparison.imageDiff.ok,
          diffRatio: result.comparison.imageDiff.diffRatio,
        }
      : undefined,
  }));
  process.stdout.write(
    `${JSON.stringify(runAll ? summary : summary[0], null, 2)}\n`,
  );

  const failedResults = results.filter((result) => !result.ok);
  if (failedResults.length > 0) {
    process.stderr.write(
      `${JSON.stringify(
        failedResults.map((result) => ({
          fixturePath: parityArtifactRelativePath(result.fixturePath),
          mismatches: result.comparison.mismatches,
        })),
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}

async function collectFixturePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFixturePaths(path);
      }
      if (entry.isFile() && entry.name.endsWith(".tscn")) {
        return [path];
      }
      return [];
    }),
  );
  return paths.flat().sort();
}

function fixtureArtifactName(fixturePath: string): string {
  const fixtureRelativePath = relative(
    resolve("fixtures"),
    resolve(fixturePath),
  );
  const withoutExtension = fixtureRelativePath.slice(
    0,
    -extname(fixtureRelativePath).length,
  );
  return withoutExtension
    .split(sep)
    .map((part) => part.replace(/[^A-Za-z0-9_.-]/g, "-"))
    .join(sep);
}
