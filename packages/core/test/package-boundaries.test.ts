// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packagesDir = join(root, "packages");
const names = readdirSync(packagesDir).filter((name) => {
  try {
    readFileSync(join(packagesDir, name, "package.json"));
    return true;
  } catch {
    return false;
  }
});
const allowed: Record<string, string[]> = {
  core: [],
  "tscn-parser": ["core"],
  "scene-graph": ["core"],
  layout: ["core", "scene-graph"],
  project: ["core", "tscn-parser", "scene-graph"],
  effects: ["core"],
  "canvas-effects": ["core", "effects"],
  html: ["core", "scene-graph", "layout", "effects", "canvas-effects"],
  canvas: ["core", "effects", "canvas-effects", "hb-gpu"],
  vue: ["core", "scene-graph", "layout", "html"],
  "hb-gpu": [],
};
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory()
      ? files(file)
      : file.endsWith(".ts")
        ? [file]
        : [];
  });
}
function imports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      result.push(node.arguments[0].text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

describe("package architecture", () => {
  it("uses declared public dependencies and preserves independent renderers", () => {
    const violations: string[] = [];
    const graph = new Map<string, Set<string>>();
    for (const name of names) {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, name, "package.json"), "utf8"),
      );
      const edges = new Set<string>();
      graph.set(name, edges);
      for (const file of files(join(packagesDir, name, "src")))
        for (const spec of imports(file)) {
          if (spec.startsWith(".")) {
            const target = relative(
              packagesDir,
              resolve(dirname(file), spec),
            ).split("/");
            if (names.includes(target[0]) && target[0] !== name)
              violations.push(
                `${relative(root, file)} imports private source ${spec}`,
              );
            continue;
          }
          const match = /^@godot-scene-web\/([^/]+)(.*)$/.exec(spec);
          if (!match || match[1] === name) continue;
          const [, dependency, suffix] = match;
          edges.add(dependency);
          const declared =
            manifest.dependencies?.[`@godot-scene-web/${dependency}`] ??
            manifest.peerDependencies?.[`@godot-scene-web/${dependency}`] ??
            (name === "tscn-parser"
              ? manifest.devDependencies?.[`@godot-scene-web/${dependency}`]
              : undefined);
          if (!declared)
            violations.push(`${name} has undeclared source dependency ${spec}`);
          if (allowed[name] && !allowed[name].includes(dependency))
            violations.push(`${name} must not depend on ${dependency}`);
          const target = JSON.parse(
            readFileSync(join(packagesDir, dependency, "package.json"), "utf8"),
          );
          const key = suffix ? `.${suffix}` : ".";
          if (
            !target.exports?.[key] &&
            !Object.keys(target.exports ?? {}).some(
              (k) => k.endsWith("*") && key.startsWith(k.slice(0, -1)),
            )
          )
            violations.push(`${name} uses unpublished ${spec}`);
        }
    }
    const visit = (name: string, ancestors: string[]) => {
      if (ancestors.includes(name)) {
        violations.push(
          `dependency cycle: ${[...ancestors, name].join(" -> ")}`,
        );
        return;
      }
      for (const next of graph.get(name) ?? [])
        visit(next, [...ancestors, name]);
    };
    for (const name of names) visit(name, []);
    expect(violations).toEqual([]);
  });

  it.each([
    "webgl",
    "webgpu",
  ])("keeps the %s backend independent at import time", async (backend) => {
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(packagesDir, `canvas-effects/src/${backend}.ts`)],
      bundle: true,
      platform: "browser",
      format: "esm",
      conditions: ["development"],
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs);
    const other = backend === "webgl" ? "webgpu" : "webgl";
    expect(
      inputs.filter((file) => /packages\/(html|canvas)\//.test(file)),
    ).toEqual([]);
    expect(
      inputs.filter(
        (file) =>
          file.startsWith("packages/canvas-effects/src/") &&
          file.includes(other),
      ),
    ).toEqual([]);
  });

  it.each([
    "core/src/index.ts",
    "effects/src/index.ts",
    "test-harness/src/index.ts",
    "test-harness/src/browser.ts",
    "perf-harness/src/index.ts",
  ])("bundles %s without browser automation, GPU backends, or Node builtins", async (entry) => {
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [join(packagesDir, entry)],
      bundle: true,
      platform: "browser",
      format: "esm",
      conditions: ["development"],
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(
      inputs.filter((file) =>
        /(?:playwright|sharp|canvas-effects|webgl\/runtime|webgpu\/device)/.test(
          file,
        ),
      ),
    ).toEqual([]);
  });
});
