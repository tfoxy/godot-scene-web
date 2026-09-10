import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PublishablePackage {
  name: string;
  version: string;
  manifestPath: string;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
}

export async function findPublishablePackages(
  packagesDirectory: string,
): Promise<PublishablePackage[]> {
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = join(
          packagesDirectory,
          entry.name,
          "package.json",
        );
        let manifest: PackageManifest;
        try {
          manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as PackageManifest;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }

        if (manifest.private === true) return undefined;
        if (
          typeof manifest.name !== "string" ||
          typeof manifest.version !== "string"
        ) {
          throw new Error(
            `Publishable package manifest ${manifestPath} needs string name and version fields.`,
          );
        }

        return { name: manifest.name, version: manifest.version, manifestPath };
      }),
  );

  return packages.filter((pkg): pkg is PublishablePackage => pkg !== undefined);
}

export function validateReleaseTag(
  tag: string,
  packages: readonly PublishablePackage[],
): void {
  if (!tag.startsWith("v") || tag.length === 1) {
    throw new Error(
      `Release tag must start with v, received ${JSON.stringify(tag)}.`,
    );
  }
  if (packages.length === 0) {
    throw new Error("No publishable package manifests were found.");
  }

  const version = tag.slice(1);
  const mismatches = packages.filter((pkg) => pkg.version !== version);
  if (mismatches.length > 0) {
    const details = mismatches
      .map((pkg) => `${pkg.name} is ${pkg.version}`)
      .join(", ");
    throw new Error(
      `Release tag ${tag} requires every publishable package to be ${version}; ${details}.`,
    );
  }
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (tag === undefined) {
    throw new Error(
      "Pass the release tag as the first argument or set GITHUB_REF_NAME.",
    );
  }

  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const packages = await findPublishablePackages(
    join(repositoryRoot, "packages"),
  );
  validateReleaseTag(tag, packages);
  console.log(
    `Release tag ${tag} matches ${packages.length} publishable package(s).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
