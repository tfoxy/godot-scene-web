#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tool = join(root, "experiments/render-stream/scripts/lib/w1-driver.py");
mkdirSync(join(root, ".local"), { recursive: true });
const scratch = mkdtempSync(join(root, ".local/w1-judge-"));
const expected = JSON.parse(
  readFileSync(
    join(root, "experiments/render-stream/fixtures/spike/expected.json"),
    "utf8",
  ),
);
let passed = 0;
let failed = 0;
const legs = ["control", "validate", "arm", "refuse-shift", "refuse-image"];
const suffix =
  "singleton_available concrete_vptr slot_indices_in_range anchors_implemented hooked_slots_pure_in_abstract hooked_slots_implemented_in_concrete slot_count_tail behaviour_probe";
for (const target of ["linux", "windows"]) {
  const names =
    `${target === "windows" ? "image_sha256 version_string codeview_id aslr_and_bias platform" : "exe_sha256 version_string build_id pie_and_bias platform"} ${suffix}`.split(
      " ",
    );
  const config = join(scratch, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      target,
      check_names: names,
      expected_anchors: target === "windows" ? "11/17" : null,
      expected,
    }),
  );
  function sample(leg: string) {
    return {
      stdout: `[fixture] extension load status=${leg === "control" ? "skipped" : "OK"}\n[fixture] frames=400\n`,
      exit: "0",
      result: {
        status:
          leg === "validate"
            ? "validated"
            : leg === "arm"
              ? "armed"
              : "refused",
        reason:
          leg === "refuse-shift"
            ? "slot-mask-mismatch"
            : "fingerprint-mismatch",
        vptr_written: leg === "arm",
        display_server: "headless",
      },
      calibration: {
        checks: (leg === "refuse-image"
          ? names.slice(0, 5)
          : leg === "refuse-shift"
            ? names.slice(0, 12)
            : [...names, "hook_plan"]
        ).map((name, i) => ({
          name,
          ok:
            !(leg === "refuse-image" && i === 0) &&
            !(leg === "refuse-shift" && name === "anchors_implemented"),
          detail:
            name === "anchors_implemented" ? "11/17 implemented" : "match",
        })),
      },
      counters: {
        validation_log: "on",
        frames_total: 400,
        counts: leg.startsWith("refuse")
          ? { texture_2d_create: 0 }
          : { canvas_item_add_texture_rect_region: 1, texture_2d_create: 1 },
        captured: {
          canvas_item_add_rect: [
            structuredClone(expected.colorrect_add_rect),
            structuredClone(expected.script_add_rect),
          ],
          texture_2d_update: [{ frame: 30 }],
        },
      },
      disarm: { disarmed: true, vptr_restored: true, frame: 60 },
      observation: {
        first_seen: { "disarm.json": { seconds: 1, while_running: true } },
      },
      omitCounters: false,
      omitDisarm: false,
    };
  }
  type Sample = ReturnType<typeof sample>;
  function run(
    name: string,
    leg: string,
    mutate?: (s: Sample) => void,
    want: string[] = [],
    requiredOutput = "",
  ) {
    const s = sample(leg);
    mutate?.(s);
    const dir = mkdtempSync(join(scratch, "leg-"));
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "stdout.txt"), s.stdout);
    writeFileSync(join(dir, "exit-code.txt"), s.exit);
    writeFileSync(join(dir, "observation.json"), JSON.stringify(s.observation));
    for (const [file, value] of [
      ["result", s.result],
      ["calibration-check", s.calibration],
      ["counters", s.omitCounters ? null : s.counters],
      ["disarm", s.omitDisarm ? null : s.disarm],
    ] as const) {
      if (value)
        writeFileSync(
          join(dir, "evidence", `${file}.json`),
          JSON.stringify(value),
        );
    }
    const result = spawnSync(
      "python3",
      ["-I", tool, "--config", config, "--leg", leg, "--evaluate-only", dir],
      { encoding: "utf8" },
    );
    const found = [...result.stdout.matchAll(/^FAIL ([^:]+):/gm)]
      .map((m) => m[1])
      .sort();
    const ok =
      result.status === (want.length ? 1 : 0) &&
      JSON.stringify(found) === JSON.stringify([...want].sort()) &&
      result.stdout.includes(requiredOutput);
    if (ok) passed++;
    else failed++;
    console.log(
      `${ok ? "ok" : "FAIL"} ${target} ${name}: ${found.join(", ") || "all checks pass"}`,
    );
    if (!ok) console.log(result.stdout, result.stderr);
  }
  for (const leg of legs) run(`honest ${leg}`, leg);
  const k6 = "[grc] fingerprint: image hash 12.345 ms over 123456 bytes";
  run(
    "K6 repeated as information",
    "validate",
    (s) => {
      s.stdout += `${k6}\n`;
    },
    [],
    `K6 (information; warm file cache): ${k6}`,
  );
  run("K6 absent is allowed", "validate");
  const mutations: [string, string, (s: Sample) => void, string][] = [
    [
      "wrong rect_bits",
      "arm",
      (s) => {
        s.counters.captured.canvas_item_add_rect[0].rect_bits = ["0xdeadbeef"];
      },
      "colorrect-add-rect",
    ],
    [
      "log off",
      "arm",
      (s) => {
        s.counters.validation_log = "off";
      },
      "validation-log",
    ],
    [
      "empty captured",
      "arm",
      (s) => {
        Object.keys(s.counters.captured).forEach((k) => {
          delete (s.counters.captured as Record<string, unknown>)[k];
        });
      },
      "captured-present",
    ],
    [
      "missing disarm",
      "arm",
      (s) => {
        s.omitDisarm = true;
      },
      "disarm-restored",
    ],
    [
      "disarm after exit",
      "arm",
      (s) => {
        s.observation.first_seen["disarm.json"].while_running = false;
      },
      "disarm-while-running",
    ],
    [
      "12 checks",
      "validate",
      (s) => {
        s.calibration.checks.length = 12;
      },
      "calibration-checks",
    ],
    [
      "missing hook_plan",
      "arm",
      (s) => {
        s.calibration.checks.pop();
      },
      "calibration-checks",
    ],
    [
      "failed hook_plan",
      "validate",
      (s) => {
        s.calibration.checks[13].ok = false;
      },
      "calibration-checks",
    ],
    [
      "duplicate hook_plan",
      "arm",
      (s) => {
        s.calibration.checks.push({
          name: "hook_plan",
          ok: true,
          detail: "duplicate",
        });
      },
      "calibration-checks",
    ],
    [
      "reordered hook_plan",
      "validate",
      (s) => {
        s.calibration.checks.reverse();
      },
      "calibration-checks",
    ],
    [
      "missing refusal check",
      "refuse-shift",
      (s) => {
        s.calibration.checks.pop();
      },
      "calibration-checks",
    ],
    [
      "check not ok",
      "validate",
      (s) => {
        s.calibration.checks[2].ok = false;
      },
      "calibration-checks",
    ],
    [
      "renamed check",
      "validate",
      (s) => {
        s.calibration.checks[2].name = "renamed";
      },
      "calibration-checks",
    ],
    [
      "refusal wrote vptr",
      "refuse-shift",
      (s) => {
        s.result.vptr_written = true;
      },
      "vptr-written",
    ],
    [
      "17/17 anchors",
      "refuse-shift",
      (s) => {
        const c = s.calibration.checks.find(
          (c) => c.name === "anchors_implemented",
        );
        if (c) {
          c.ok = true;
          c.detail = "17/17 implemented";
        }
      },
      "shift-anchors",
    ],
    [
      "refusal nonzero count",
      "refuse-shift",
      (s) => {
        s.counters.counts.texture_2d_create = 1;
      },
      "nothing-patched",
    ],
    [
      "missing frames",
      "control",
      (s) => {
        s.stdout = s.stdout.replace("frames=400", "frames=399");
      },
      "fixture-completed",
    ],
    [
      "exit 1",
      "control",
      (s) => {
        s.exit = "1";
      },
      "exit-code",
    ],
    [
      "x11",
      "arm",
      (s) => {
        s.result.display_server = "x11";
      },
      "headless",
    ],
    [
      "missing counters",
      "arm",
      (s) => {
        s.omitCounters = true;
      },
      "counters-present",
    ],
    [
      "cache error",
      "control",
      (s) => {
        s.stdout += "Could not load global script cache";
      },
      "script-cache",
    ],
  ];
  for (const [name, leg, mutate, want] of mutations)
    run(name, leg, mutate, [want]);
}
console.log(`w1-driver self-test: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
