import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { withCoreParserBuildLock } from "../../../scripts/test-build-lock";

const workspaceRoot = process.cwd();
function pnpm(args: string[]): void {
  execFileSync("pnpm", args, {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
}

function node(args: string[], cwd = workspaceRoot): string {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
  });
}

async function outputText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? outputText(path)
        : entry.name.endsWith(".js") || entry.name.endsWith(".mjs")
          ? readFile(path, "utf8")
          : "";
    }),
  );
  return parts.join("\n");
}

describe("project package conditions", () => {
  it("selects browser, node, and development roots deliberately", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(workspaceRoot, "packages/project/package.json"),
        "utf8",
      ),
    ) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports).toMatchObject({
      ".": {
        browser: { development: "./src/fetch.ts", import: "./dist/fetch.js" },
        node: { development: "./src/node.ts", import: "./dist/node.js" },
        development: "./src/node.ts",
        import: "./dist/node.js",
      },
      "./node": { development: "./src/node.ts", import: "./dist/node.js" },
      "./fetch": { development: "./src/fetch.ts", import: "./dist/fetch.js" },
    });

    await withCoreParserBuildLock(async () => {
      pnpm(["--filter", "@godot-scene-web/core", "build"]);
      pnpm(["--filter", "@godot-scene-web/scene-graph", "build"]);
      pnpm(["--filter", "@godot-scene-web/tscn-parser", "build"]);
      pnpm(["--filter", "@godot-scene-web/project", "build"]);

      const scratch = await mkdtemp(join(tmpdir(), "gsw-project-node-"));
      try {
        const projectScope = join(scratch, "node_modules/@godot-scene-web");
        await mkdir(projectScope, { recursive: true });
        await symlink(
          join(workspaceRoot, "packages/project"),
          join(projectScope, "project"),
        );
        expect(
          node(
            [
              "--input-type=module",
              "--eval",
              "import('@godot-scene-web/project').then((module) => console.log(typeof module.createGodotProjectResolver))",
            ],
            scratch,
          ).trim(),
        ).toBe("function");
        expect(
          node(
            [
              "--input-type=module",
              "--eval",
              "import('@godot-scene-web/project/node').then((module) => console.log(typeof module.createGodotProjectResolver + ',' + typeof module.createGodotFetchProjectResolver))",
            ],
            scratch,
          ).trim(),
        ).toBe("function,undefined");
        expect(
          node(
            [
              "--input-type=module",
              "--eval",
              "import('@godot-scene-web/project/fetch').then((module) => console.log(typeof module.createGodotFetchProjectResolver + ',' + typeof module.createGodotProjectResolver))",
            ],
            scratch,
          ).trim(),
        ).toBe("function,undefined");
        expect(
          node(
            [
              "--conditions=browser",
              "--input-type=module",
              "--eval",
              "import('@godot-scene-web/project').then((module) => console.log(typeof module.createGodotFetchProjectResolver))",
            ],
            scratch,
          ).trim(),
        ).toBe("function");
        expect(
          node(
            [
              "--conditions=development",
              "--import",
              join(workspaceRoot, "node_modules/tsx/dist/loader.mjs"),
              "--input-type=module",
              "--eval",
              "import('@godot-scene-web/project').then((module) => console.log(typeof module.createGodotProjectResolver))",
            ],
            scratch,
          ).trim(),
        ).toBe("function");
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }, 120000);

  it("uses fetch in Vite client output and node resolution in SSR output", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "gsw-project-conditions-"));
    try {
      const projectScope = join(scratch, "node_modules/@godot-scene-web");
      await mkdir(projectScope, { recursive: true });
      await symlink(
        join(workspaceRoot, "packages/project"),
        join(projectScope, "project"),
      );

      const clientEntry = join(scratch, "client.ts");
      const ssrEntry = join(scratch, "server.ts");
      await writeFile(
        clientEntry,
        "import { createGodotFetchProjectResolver } from '@godot-scene-web/project';\nexport const resolver = createGodotFetchProjectResolver;\n",
      );
      await writeFile(
        ssrEntry,
        "import { createGodotProjectResolver } from '@godot-scene-web/project';\nexport const resolver = createGodotProjectResolver;\n",
      );

      const clientOutDir = join(scratch, "client-dist");
      await build({
        configFile: false,
        root: scratch,
        resolve: { conditions: ["browser", "development"] },
        build: {
          emptyOutDir: true,
          lib: { entry: clientEntry, formats: ["es"], fileName: "client" },
          outDir: clientOutDir,
        },
      });
      const clientOutput = await outputText(clientOutDir);
      expect(clientOutput).not.toContain("createGodotProjectResolver");
      expect(clientOutput).not.toContain("node:fs");
      expect(clientOutput).not.toContain("node:path");

      const ssrOutDir = join(scratch, "server-dist");
      await build({
        configFile: false,
        root: scratch,
        resolve: { conditions: ["node", "development"] },
        ssr: { noExternal: ["@godot-scene-web/project"] },
        build: {
          emptyOutDir: true,
          outDir: ssrOutDir,
          rollupOptions: { input: ssrEntry },
          ssr: ssrEntry,
        },
      });
      const ssrOutput = await outputText(ssrOutDir);
      expect(ssrOutput).toContain("createGodotProjectResolver");
      expect(ssrOutput).toContain("node:fs");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
