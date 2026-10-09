#!/usr/bin/env node
// Produces a TAMPERED copy of a render-stream-calibration/1 record JSON, for the Gate -1 negative
// legs (run-gate-minus1.sh's refuse-sha / refuse-prefix). Never touches the original file.
//
//   node tamper-calibration.mjs sha <in.json> <out.json>     # altered engine.sha256
//   node tamper-calibration.mjs prefix <in.json> <out.json>  # object_prefix, every slots/anchors
//                                                             # value, all +1
//
// The calibration record's exact shape is owned by the sibling capture/calibration work (see
// experiments/render-stream CLAUDE.md); this only assumes the four documented keys
// (engine.sha256, rendering_server.object_prefix, slots{name:index}, anchors{name:index}) and
// otherwise copies the record through unchanged.

import { readFileSync, writeFileSync } from "node:fs";

const [, , mode, inPath, outPath] = process.argv;
if (!mode || !inPath || !outPath) {
  console.error(
    "usage: tamper-calibration.mjs <sha|prefix> <in.json> <out.json>",
  );
  process.exit(2);
}

const record = JSON.parse(readFileSync(inPath, "utf8"));

function bumpIntegerValues(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && Number.isInteger(value)) {
      out[key] = value + 1;
    } else if (value !== null && typeof value === "object") {
      out[key] = bumpIntegerValues(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

if (mode === "sha") {
  const current = record?.engine?.sha256;
  if (typeof current !== "string" || current.length === 0) {
    console.error(
      `tamper-calibration.mjs: record has no string engine.sha256 (got ${JSON.stringify(current)})`,
    );
    process.exit(1);
  }
  // Flip the first hex character to an adjacent one (wrapping 'f' back to '0'), so the result is
  // still a plausible-looking hex digest -- a WRONG one, not a malformed one.
  const first = current[0];
  const digits = "0123456789abcdef";
  const index = digits.indexOf(first.toLowerCase());
  const replacement = digits[(index + 1) % digits.length];
  record.engine.sha256 = replacement + current.slice(1);
} else if (mode === "prefix") {
  if (typeof record?.rendering_server?.object_prefix !== "number") {
    console.error(
      "tamper-calibration.mjs: record has no numeric rendering_server.object_prefix",
    );
    process.exit(1);
  }
  record.rendering_server.object_prefix += 1;
  if (record.slots && typeof record.slots === "object") {
    record.slots = bumpIntegerValues(record.slots);
  }
  if (record.anchors && typeof record.anchors === "object") {
    record.anchors = bumpIntegerValues(record.anchors);
  }
} else {
  console.error(
    `tamper-calibration.mjs: unknown mode "${mode}" (expected sha|prefix)`,
  );
  process.exit(2);
}

writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`tamper-calibration.mjs: wrote ${outPath} (mode=${mode})`);
