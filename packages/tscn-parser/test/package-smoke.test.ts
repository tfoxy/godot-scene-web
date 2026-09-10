import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCoreParserBuildLock } from "../../../scripts/test-build-lock";

const workspaceRoot = process.cwd();
function pnpm(args: string[], cwd = workspaceRoot): void {
  execFileSync("pnpm", args, {
    cwd,
    stdio: "pipe",
  });
}

function node(args: string[], cwd: string): void {
  execFileSync(process.execPath, args, { cwd, stdio: "pipe" });
}

function tarballEntries(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function tarballText(tarball: string, entry: string): string {
  return execFileSync("tar", ["-xOf", tarball, entry], { encoding: "utf8" });
}

async function packedTarball(
  directory: string,
  packageName: string,
): Promise<string> {
  const tarballs = await readdir(directory);
  const tarball = tarballs.find(
    (file) => file.endsWith(".tgz") && file.includes(packageName),
  );
  if (!tarball) {
    throw new Error(`No packed tarball for ${packageName}.`);
  }
  return join(directory, tarball);
}

describe("packed parser consumer smoke", () => {
  it("builds, packs, installs, runs, and typechecks without a workspace runtime dependency", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(workspaceRoot, "packages/tscn-parser/package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Every core reference in the parser is `import type`; its generated JS is
    // self-contained. Keep the AST package available to build declarations, but
    // do not turn that erased reference into a consumer runtime dependency.
    expect(manifest.dependencies?.["@godot-scene-web/core"]).toBeUndefined();
    expect(manifest.devDependencies?.["@godot-scene-web/core"]).toBe(
      "workspace:*",
    );

    await withCoreParserBuildLock(async () => {
      const scratch = await mkdtemp(join(tmpdir(), "gsw-parser-package-"));
      try {
        const tarballs = join(scratch, "tarballs");
        const consumer = join(scratch, "consumer");
        await mkdir(tarballs);
        await mkdir(consumer);
        pnpm(["--filter", "@godot-scene-web/core", "build"]);
        pnpm(["--filter", "@godot-scene-web/tscn-parser", "build"]);
        pnpm([
          "--dir",
          "packages/tscn-parser",
          "pack",
          "--pack-destination",
          tarballs,
        ]);

        const parserTarball = await packedTarball(tarballs, "tscn-parser");
        const entries = tarballEntries(parserTarball);
        const packedManifest = JSON.parse(
          tarballText(parserTarball, "package/package.json"),
        ) as {
          main: string;
          types: string;
          exports: Record<string, { import: string; types: string }>;
        };
        expect(entries).toContain("package/package.json");
        expect(
          entries.every(
            (entry) =>
              entry === "package/" ||
              entry === "package/package.json" ||
              // npm includes the repository license automatically; all package
              // code and declarations must still be declared dist output.
              entry === "package/LICENSE" ||
              entry.startsWith("package/dist/"),
          ),
        ).toBe(true);
        for (const file of [
          packedManifest.main,
          packedManifest.types,
          packedManifest.exports["."].import,
          packedManifest.exports["."].types,
        ]) {
          expect(entries).toContain(`package/${file.replace(/^\.\//, "")}`);
        }
        await writeFile(
          join(scratch, "package.json"),
          JSON.stringify({ private: true, type: "module" }),
        );
        await writeFile(
          join(consumer, "package.json"),
          JSON.stringify({ private: true, type: "module" }),
        );

        // Install only the parser first: it must execute with no transitive
        // workspace link and no core runtime package.
        pnpm(["add", "--offline", parserTarball], consumer);
        const installedManifest = await readFile(
          join(
            consumer,
            "node_modules/@godot-scene-web/tscn-parser/package.json",
          ),
          "utf8",
        );
        const runtime = await readFile(
          join(
            consumer,
            "node_modules/@godot-scene-web/tscn-parser/dist/index.js",
          ),
          "utf8",
        );
        expect(installedManifest).not.toContain("workspace:");
        expect(installedManifest).not.toContain(workspaceRoot);
        expect(runtime).not.toContain("@godot-scene-web/core");
        node(
          [
            "--input-type=module",
            "--eval",
            "import { parseGodotResource, parseGodotTextScene } from '@godot-scene-web/tscn-parser'; const scene = parseGodotTextScene('[gd_scene format=3]'); const resource = parseGodotResource('[gd_resource type=\"Resource\" format=3]'); if (scene.kind !== 'scene' || resource.type !== 'Resource') process.exit(1);",
          ],
          consumer,
        );

        // Building against core in the workspace inlines its AST declarations;
        // the packed parser must typecheck without installing core separately.
        await writeFile(
          join(consumer, "index.ts"),
          "import { parseGodotTextScene } from '@godot-scene-web/tscn-parser';\nconst scene = parseGodotTextScene('[gd_scene format=3]');\nconst kind: 'scene' = scene.kind;\nvoid kind;\n",
        );
        await writeFile(
          join(consumer, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              strict: true,
            },
          }),
        );
        node(
          [
            join(workspaceRoot, "node_modules/typescript/bin/tsc"),
            "--project",
            "tsconfig.json",
          ],
          consumer,
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }, 120000);
});
