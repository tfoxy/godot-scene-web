/**
 * Read the explicit exports from a TypeScript re-export barrel.
 *
 * Type-only exports have no runtime trace, so package export-surface tests use
 * this alongside `Object.keys()` to protect consumers that mirror our source
 * package declarations by hand.
 */
export function parseBarrelExports(source: string): {
  values: string[];
  types: string[];
} {
  const values: string[] = [];
  const types: string[] = [];
  const blocks = source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g);
  for (const [, typeKeyword, body] of blocks) {
    // Export lists frequently document why a public name exists. Comments can
    // themselves contain commas, so remove them before splitting the list.
    const uncommented = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const raw of uncommented.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (!name) continue;
      if (typeKeyword) types.push(name);
      else if (name.startsWith("type ")) types.push(name.slice(5).trim());
      else values.push(name);
    }
  }
  return { values, types };
}
