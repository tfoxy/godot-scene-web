// `tsc` is TypeScript 7 (the Go compiler), which ships no JS compiler API. tsdown's `.d.ts`
// emitter, rolldown-plugin-dts, still drives the TypeScript 6 API, so give it the official
// side-by-side TS 6 package as a real dependency instead of the `typescript` peer. pnpm will
// not override a peer through `overrides` or `packageExtensions`, hence this hook. Drop it
// once TS 7.1 and a rolldown-plugin-dts that supports it are both stable.
const TS6 = "npm:@typescript/typescript6@6.0.2";

function readPackage(pkg) {
  if (pkg.name === "rolldown-plugin-dts") {
    if (pkg.peerDependencies) delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
