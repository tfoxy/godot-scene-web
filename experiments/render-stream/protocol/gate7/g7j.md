### G7j — browser-loadable decoder (sonnet)

- **Files**: `scripts/lib/sha256.ts` (FIPS 180-4, synchronous); an injected hash in
  `render-stream-2.ts`, `render-stream-mesh.ts` and `render-stream-shader.ts` (Node callers pass
  `node:crypto`, and their behaviour is unchanged); `scripts/test/self-test-browser-decoder.ts`.
- **Checks**: the pure hash equals `node:crypto` on every golden payload and 10 000 random lengths
  (0–70 000 B); every golden (2–7) decodes and resolves identically with either hash; an esbuild
  `platform: "browser"` bundle of the three modules has no `node:` import (metafile check).
- **Sabotage**: a hash that skips the length padding must fail the golden resource-hash checks.

