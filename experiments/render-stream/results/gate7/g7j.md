## Gate 7j result (2026-10-14)

G7j ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7j") passes: the render-stream
TypeScript decoder/validator/resolver (`render-stream-2.ts`, `render-stream-mesh.ts`,
`render-stream-shader.ts`) no longer hard-imports `node:crypto`, so it is loadable in a browser
(gate7-design.md Q5, the GSW canvas receiver's decode step). Per D23 ("G7w, G7j, G7h, G7c and G7f
may be written and landed now: they are disjoint from gate 6's open files"), this landed directly
from `main` with no gate-6 dependency.

**What changed.**
- `scripts/lib/sha256.ts` -- a pure, synchronous, dependency-free SHA-256 (FIPS 180-4):
  `sha256Hex()`, plus a deliberately wrong `brokenSha256NoLengthPadding()` (writes zero instead of
  the true bit length into the length field) kept only for the sabotage self-test.
- `render-stream-2.ts`, `render-stream-mesh.ts` and `render-stream-shader.ts` each keep a local,
  injectable `hashImpl` (defaulting to `sha256Hex`) behind a new exported `setHashImpl()`,
  replacing their `createHash("sha256")` one-liner. Nothing else changed: `hashBytes`/
  `payloadSha256`/`recordSha256` (render-stream-2.ts), `meshPayloadSha256` and
  `shaderPayloadSha256` keep their exact signatures, so every existing caller (self-test-rs2.ts,
  every gate4/gate55-family checker, ...) is unaffected and untouched.
- `scripts/test/self-test-browser-decoder.ts` -- 357 assertions, all green.

**How it was tested**:
- `self-test-browser-decoder.ts` (357 assertions). Section A: `sha256Hex` vs `node:crypto`
  directly, at the FIPS 180-4 block-boundary lengths (0, 54-57, 63-65, 119-121, ...) and over
  10 000 random lengths 0-70 000 B -- 0 mismatches. Section B: the three modules' own
  `payloadSha256`/`meshPayloadSha256`/`shaderPayloadSha256`/`recordSha256` wrappers agree with each
  other and with the golden's committed hash, swapping the injected implementation, over every
  golden-2..golden-6 payload and record. Section C: every golden-2..golden-6 valid vector's
  `decodeRecording`/`validateRecording`/`resolveRecording` is identical whether the pure default
  or an injected `node:crypto` wrapper is in use. Section D (sabotage): injecting
  `brokenSha256NoLengthPadding` turns a clean golden-2 `inline.rs2` vector's `validateRecording`
  into a `resource-hash` failure, proving the harness would actually catch a broken
  implementation. Section E: an esbuild `platform: "browser"` bundle of the three modules has zero
  `node:` entries in its metafile.
- Existing self-tests pass unchanged: `self-test-rs2.ts` (all golden-2..golden-6 suites green,
  same coverage as before this change), spot-checked against two callers that invoke
  `decodeTexturePayload`/`payloadSha256`/`decodeShaderPayload` directly --
  `self-test-gate4.ts` (152/152) and `self-test-gate55e.ts` (38/38). `make_golden.py --check` for
  golden-2 through golden-6 is unaffected (Python side, untouched by this increment).
- An ad hoc headless-Chromium verification (not committed -- G7h owns the permanent browser
  harness, Q6; this was a one-off proof): bundled the three modules with esbuild
  `platform: "browser"`, served the bundle over a loopback `http://127.0.0.1` page, launched
  Playwright's pinned `chromium-1223` with `--headless=new --enable-gpu --use-angle=vulkan`
  (memory xvfb-does-not-isolate-on-wayland), and ran `decodeRecording`/`validateRecording`/
  `resolveRecording`/`payloadSha256`/`meshPayloadSha256`/`shaderPayloadSha256` against every
  golden-2..golden-6 vector and payload inside the page, comparing each result back in Node.
  `WEBGL_debug_renderer_info` confirmed real hardware: "ANGLE (NVIDIA, Vulkan 1.4.329 ... NVIDIA
  GeForce RTX 2060 ..., NVIDIA)", no SwiftShader fallback. All 59 browser-vs-Node comparisons were
  identical.
- `mise exec -- pnpm exec biome check` and `mise exec -- pnpm exec tsc --noEmit -p
  experiments/render-stream/tsconfig.json` clean on every file this increment touched.

### Decisions
- The hash is injected per-module (each of the three files keeps its own `hashImpl`/
  `setHashImpl()`, rather than one shared singleton living in `sha256.ts`), matching these three
  files' existing style of small local duplication (`bytesEqual`, `isPlainObject`, etc. are already
  copied the same way across all three).
- No existing Node-side caller changed: `self-test-rs2.ts`, every `gate4*-checks.ts`/
  `gate55*-checks.ts`, and friends all keep using the default (pure) hash, which this increment
  proves is byte-identical to `node:crypto`, so their behaviour and output are unaffected.
- golden-7 does not exist on this branch (G7w, in progress on a parallel branch, owns it; memory
  g4e1-rs3-version-switch-pattern). `self-test-browser-decoder.ts`'s golden list covers 2..6 only;
  extending it to 7 once G7w lands is the same one-line addition /3 through /6 each were.

### What G7j does not prove
- That the GSW canvas receiver itself runs in a browser (G7a, Q5's applier/draw-list lowering) --
  this is the decoder's portability only.
- Hash throughput: the self-tests measure correctness, not speed. Node callers keep the pure
  default too (none were changed to inject `node:crypto`), and nothing here forces a slower hash
  onto any existing Node path, but nothing measures whether it would matter if one did.
- Anything about render-stream/7's wire format, hello, credit window, or CORS/origin handling
  (G7w's and G7n's scope) -- this touches no protocol version.
