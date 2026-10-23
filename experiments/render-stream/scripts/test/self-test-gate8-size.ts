#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8h checks (lib/gate8-size-checks.ts, G8h) on the committed
// fixtures/gate8-size/expected.json and on synthetic sessions, probes and resolved recordings,
// each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-size.ts
//
// 1. expected.json is self-consistent (checkpoints after the arm, post-arm size = logical size).
// 2. sizeProblems: a matching presentation session passes; a degenerate status, a wrong
//    oversampling and a wrong policy each fail.
// 3. probeProblems: the late probe (64x64 at 0.1, then 640x360 at 1) and the born probe (post-arm
//    at both) pass; a late read that is already resized, and a born read that is degenerate, fail.
// 4. atlasProblems: created textures pass; an adopted texture, a missing one and an
//    unknown-texture report fail.
// 5. accountProblems: no unknown call passes; one unknown call fails.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { accountProblems, atlasProblems, type G8hExpected, probeProblems, sizeProblems, type SizeProbe } from "../lib/gate8-size-checks";
import type { ResolvedRecording } from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-size", "expected.json"), "utf8"),
  ) as G8hExpected;
  const K = expected.arm_frame;

  // 1. expected.json
  assert(expected.schema === "render-stream-gate8-size-expected/1", "expected.json schema");
  assert(JSON.stringify(expected.post_arm.window) === JSON.stringify(expected.logical_size), "post-arm window is the logical size");
  assert(expected.checkpoints.every((c) => c.applied >= 0 && c.settle > c.applied - 1), "checkpoints settle after they apply");
  assert(expected.checkpoints[0].settle === expected.settle_frames, "the first checkpoint settles settle_frames after the arm");
  assert(expected.adopted <= expected.items, "adopted items are at most the items");

  // 2. sizeProblems
  const vp = {
    root_size_policy: "presentation",
    presentation_size: [640, 360] as [number, number],
    host_size_status: "match",
    host_window_size: [640, 360] as [number, number],
    font_oversampling: 1,
  };
  assert(sizeProblems(vp, expected).length === 0, "a matching presentation session passes");
  assert(sizeProblems({ ...vp, host_size_status: "degenerate-visible" }, expected).length > 0, "a degenerate status fails");
  assert(sizeProblems({ ...vp, font_oversampling: 0.1 }, expected).length > 0, "a wrong oversampling fails");
  assert(sizeProblems({ ...vp, root_size_policy: "observe" }, expected).length > 0, "a wrong policy fails");
  assert(sizeProblems(undefined, expected).length > 0, "no viewport fails");

  // 3. probeProblems
  const line = (frame: number, o: G8hExpected["pre_arm"]): SizeProbe => ({
    frame,
    window: o.window,
    visible: o.visible,
    oversampling: o.oversampling,
    stretch: [o.oversampling, o.oversampling],
  });
  assert(probeProblems([line(K - 1, expected.pre_arm), line(K + 1, expected.post_arm)], expected, true).length === 0, "the late probe passes");
  assert(probeProblems([line(K - 1, expected.post_arm), line(K + 1, expected.post_arm)], expected, false).length === 0, "the born probe passes");
  assert(probeProblems([line(K - 1, expected.post_arm), line(K + 1, expected.post_arm)], expected, true).length > 0, "a late read already resized fails");
  assert(probeProblems([line(K - 1, expected.pre_arm), line(K + 1, expected.pre_arm)], expected, false).length > 0, "a born read that is degenerate fails");
  assert(probeProblems([], expected, true).length > 0, "no probe lines fail");

  // 4. atlasProblems
  const rec = (origin: string, status: string, unsupported: { op: string; reason: string }[], present = true) =>
    ({
      transactions: [
        {
          frame: K,
          state: {
            textures: present ? [{ id: 1, origin, status }] : [],
            unsupported,
            items: [{ commands: [{ tex: 1 }] }],
          },
        },
      ],
    }) as unknown as ResolvedRecording;
  assert(atlasProblems(rec("created", "ok", []), K).problems.length === 0, "a created, usable texture passes");
  assert(atlasProblems(rec("adopted", "ok", []), K).problems.length > 0, "an adopted texture fails");
  assert(atlasProblems(rec("created", "ok", [], false), K).problems.length > 0, "a missing texture fails");
  assert(atlasProblems(rec("created", "ok", [{ op: "canvas_item_add_texture_rect", reason: "unknown-texture" }]), K).problems.length > 0, "an unknown-texture report fails");
  assert(atlasProblems(rec("created", "ok", []), K + 5).problems.length > 0, "no frame from the arm fails");

  // 5. accountProblems
  const result = (calls: number) => ({
    stream: {
      status: "closed",
      unknown_items: { unknown_calls: calls, unknown_rids_named: calls, withheld_items: 0 },
      gate8: { adopt_stats: { ran: true, items: expected.adopted } },
    },
  });
  assert(accountProblems(result(0), expected).length === 0, "no unknown call passes");
  assert(accountProblems(result(2), expected).length > 0, "an unknown call fails");

  console.log(`\nself-test-gate8-size: ${assertions - failures}/${assertions} assertions passed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
