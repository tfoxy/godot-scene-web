import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPublishablePackages,
  validateReleaseTag,
} from "../../../scripts/validate-release-tag.ts";

const temporaryDirectories: string[] = [];

async function packageDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "godot-scene-web-release-tag-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeManifest(
  directory: string,
  packageName: string,
  manifest: object,
): Promise<void> {
  const packagePath = join(directory, packageName);
  await mkdir(packagePath);
  await writeFile(join(packagePath, "package.json"), JSON.stringify(manifest));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true });
    }),
  );
});

describe("release tag validation", () => {
  it("discovers public packages and accepts their matching v-prefixed tag", async () => {
    const packagesDirectory = await packageDirectory();
    await writeManifest(packagesDirectory, "core", {
      name: "@godot-scene-web/core",
      version: "0.1.0",
    });
    await writeManifest(packagesDirectory, "private-tool", {
      name: "@godot-scene-web/private-tool",
      version: "0.1.0",
      private: true,
    });

    const packages = await findPublishablePackages(packagesDirectory);
    expect(packages.map((pkg) => pkg.name)).toEqual(["@godot-scene-web/core"]);
    expect(() => validateReleaseTag("v0.1.0", packages)).not.toThrow();
  });

  it("rejects non-v tags, missing packages, and divergent versions", () => {
    const packages = [
      {
        name: "@godot-scene-web/core",
        version: "0.1.0",
        manifestPath: "core/package.json",
      },
      {
        name: "@godot-scene-web/html",
        version: "0.2.0",
        manifestPath: "html/package.json",
      },
    ];

    expect(() => validateReleaseTag("0.1.0", packages)).toThrow(
      "must start with v",
    );
    expect(() => validateReleaseTag("v0.1.0", [])).toThrow(
      "No publishable package",
    );
    expect(() => validateReleaseTag("v0.1.0", packages)).toThrow(
      "@godot-scene-web/html is 0.2.0",
    );
  });
});
