#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for G8kb's GSW Basis pieces (texture-delivery-design.md D14, Q6 "GSW"), pure (no wasm,
// no browser), each with a passing and a failing case:
//
// 1. webglFamilies (web/basis-transcoder/client.ts): the BC families drop out for a KTX2 whose
//    level 0 is not 4-aligned (WebGL refuses it), ETC2/ASTC stay; a 4-aligned file keeps them all.
// 2. predictGswTarget (lib/gate7-gsw-g8-checks.ts), the checks' independent D14: Godot's order per
//    component count, and the alignment rule.
// 3. The name tables agree: every transcoder target (protocol.ts TARGET_FORMAT) is a format the
//    checks know an Image.Format value for and the GSW upload path names (CompressedFormat or RGBA8).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8kb.ts
//
// Exits non-zero if any assertion fails.

import { webglFamilies } from "../../web/basis-transcoder/client";
import { TARGET_FORMAT } from "../../web/basis-transcoder/protocol";
import { predictGswTarget } from "../lib/gate7-gsw-g8-checks";

let failures = 0;
let passed = 0;
function expect(ok: boolean, what: string): void {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

function ktx2Header(w: number, h: number): Uint8Array {
  const b = new Uint8Array(80);
  const v = new DataView(b.buffer);
  v.setUint32(20, w, true);
  v.setUint32(24, h, true);
  return b;
}

const ALL = ["s3tc", "bptc", "rgtc", "etc2", "astc"];
// 1
expect(JSON.stringify(webglFamilies(ktx2Header(160, 128), ALL)) === JSON.stringify(ALL), "aligned keeps every family");
expect(JSON.stringify(webglFamilies(ktx2Header(150, 110), ALL)) === JSON.stringify(["etc2", "astc"]), "unaligned drops BC");
expect(JSON.stringify(webglFamilies(ktx2Header(152, 110), ["bptc"])) === "[]", "one unaligned side is enough");
expect(webglFamilies(new Uint8Array(10), ["bptc"]).length === 1, "a short buffer is left to the transcoder");

// 2
expect(predictGswTarget(4, ALL, 160, 128) === "ASTC_4x4", "4 components: astc first");
expect(predictGswTarget(4, ["s3tc", "bptc", "rgtc"], 160, 128) === "BPTC_RGBA", "desktop: BC7");
expect(predictGswTarget(4, ["s3tc", "bptc", "rgtc"], 150, 110) === "RGBA8", "desktop unaligned: RGBA8");
expect(predictGswTarget(4, ["etc2", "astc"], 150, 110) === "ASTC_4x4", "phone unaligned: ASTC");
expect(predictGswTarget(4, ["s3tc"], 16, 16) === "DXT5", "s3tc only: BC3");
expect(predictGswTarget(4, ["etc2"], 16, 16) === "ETC2_RGBA8", "etc2 only: ETC2 RGBA");
expect(predictGswTarget(3, ["etc2", "astc"], 16, 16) === "ETC2_RGB8", "3 components never take ASTC: ETC1");
expect(predictGswTarget(3, ["s3tc", "bptc"], 16, 16) === "BPTC_RGBA", "3 components: BC7 first");
expect(predictGswTarget(3, ["s3tc"], 16, 16) === "DXT1", "3 components: BC1");
expect(predictGswTarget(2, ["rgtc"], 16, 16) === "RGTC_RG", "2 components: BC5");
expect(predictGswTarget(1, [], 16, 16) === "RGBA8", "nothing: RGBA8");
expect(predictGswTarget(4, ["bptc"], 16, 16) !== "ASTC_4x4", "a family not stated is never taken");

// 3
const IMAGE_NAMES = ["RGBA8", "DXT1", "DXT5", "RGTC_R", "RGTC_RG", "BPTC_RGBA", "ETC2_RGB8", "ETC2_RGBA8", "ASTC_4x4"];
for (const [code, name] of Object.entries(TARGET_FORMAT))
  expect(IMAGE_NAMES.includes(name), `target ${code} (${name}) is a known upload name`);
expect(TARGET_FORMAT[13] === "RGBA8" && TARGET_FORMAT[10] === "ASTC_4x4" && TARGET_FORMAT[6] === "BPTC_RGBA", "basist codes map to their formats");

if (failures > 0) {
  console.error(`self-test-gate8kb: ${failures} assertion(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`self-test-gate8kb: ${passed}/${passed} assertions passed`);
