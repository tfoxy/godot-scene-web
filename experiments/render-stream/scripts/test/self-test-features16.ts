#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for render-stream/16's feature manifest (VS4, lib/feature-evidence-16.ts,
// protocol/features/render-stream-16/gsw-canvas.json): the committed file is what make-features.ts
// --protocol 16 generates; it is /8's GSW manifest with exactly the declared changes
// (viewport.non-root-viewport moved from typed-unsupported to supported, five rows added);
// only the GSW receiver has a /16 manifest; every entry passes validateEntries2.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-features16.ts

import "../lib/node-hash";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateEntries2 } from "../lib/feature-evidence-7";
import { receiverFeatureEntries8 } from "../lib/feature-evidence-8";
import {
  NEW_ENTRY_IDS_16,
  receiverFeatureEntries16,
} from "../lib/feature-evidence-16";
import {
  buildManifest2,
  MANIFEST16_DIR,
  serializeManifest2,
} from "../make-features";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const eight = receiverFeatureEntries8("gsw-canvas");
const sixteen = receiverFeatureEntries16("gsw-canvas");
const key = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`;
const by8 = new Map(eight.map((e) => [key(e), e]));

expect(
  by8.get("viewport:viewport.non-root-viewport")?.status ===
    "typed-unsupported",
  "/8 still types non-root viewports",
);
const moved = sixteen.find((e) => e.id === "viewport.non-root-viewport");
expect(
  moved?.status === "supported" &&
    moved.reason === null &&
    moved.evidence.some((x) => x.check === "vp-reference@gsw") &&
    moved.evidence.some((x) => x.check === "vp-live@gsw"),
  "/16 supports non-root viewports, with the file-leg and live evidence",
);
expect(
  sixteen.find((e) => e.id === "viewport.viewport-3d")?.status ===
    "typed-unsupported",
  "/16 types 3D viewports under their own reason",
);
const changed = sixteen
  .filter((e) => JSON.stringify(by8.get(key(e))) !== JSON.stringify(e))
  .map(key)
  .sort();
expect(
  JSON.stringify(changed) ===
    JSON.stringify(
      [
        "viewport:viewport.non-root-viewport",
        ...NEW_ENTRY_IDS_16.map((id) => sixteen.find((e) => e.id === id))
          .filter((e): e is NonNullable<typeof e> => e !== undefined)
          .map(key),
      ].sort(),
    ),
  `/16 differs from /8 in exactly the moved row and the added ones (${changed.join(", ")})`,
);
expect(
  sixteen.length === eight.length + NEW_ENTRY_IDS_16.length,
  "/16 drops no /8 row",
);
expect(validateEntries2(sixteen).length === 0, "every /16 entry validates");
for (const kind of ["native", "web-export"] as const) {
  let threw = false;
  try {
    receiverFeatureEntries16(kind);
  } catch {
    threw = true;
  }
  expect(threw, `${kind} has no /16 manifest`);
}
const m = buildManifest2("gsw-canvas", null, 16);
expect(
  m.protocol === "render-stream/16" &&
    m.stream_protocols.join() === "render-stream/16" &&
    m.evidence_runs.length === 0,
  "the /16 manifest names only render-stream/16 and quotes no run",
);
expect(
  readFileSync(join(MANIFEST16_DIR, "gsw-canvas.json"), "utf8") ===
    serializeManifest2(m),
  "the committed gsw-canvas.json is what make-features.ts --protocol 16 generates",
);

if (failures > 0) {
  console.error(
    `self-test-features16: ${failures} of ${assertions} assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log(`self-test-features16: ${assertions} assertions passed`);
}
