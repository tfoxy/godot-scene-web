#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Synthetic evidence exercises each API assertion, including sabotage non-vacuity.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  admissionProblems,
  quitPendingProblems,
  runApiChecks,
} from "../lib/gate8-api-checks";

// R12 and R12c are accepted calls (re-arm after disarmed or arm_failed, and its cancel).
const expectedRefusals: Record<string, [number, string, string]> = {
  R1: [3, "not-armed", "standby"],
  R2: [31, "arm-config-invalid", "standby"],
  R3: [31, "arm-config-invalid", "standby"],
  R4: [31, "arm-config-invalid", "standby"],
  R5: [31, "arm-config-invalid", "standby"],
  R5b: [31, "arm-config-invalid", "standby"],
  R6: [2, "not-main-thread", "standby"],
  R7: [44, "busy", "arming"],
  R8: [44, "busy", "armed"],
  R6b: [2, "not-main-thread", "armed"],
  R10: [44, "busy", "disarming"],
  R11: [44, "busy", "disarming"],
  R13: [3, "not-armed", "standby"],
  R14: [31, "disarm-config-invalid", "armed"],
  R15: [31, "disarm-config-invalid", "armed"],
};

const scratch = join(import.meta.dirname, "../../../../.local");
mkdirSync(scratch, { recursive: true });
const out = mkdtempSync(join(scratch, "self-test-gate8-api-"));
let assertions = 0;
const state = {
  state: "standby",
  can_arm: true,
  arm_count: 2,
  clients: 0,
  last_reason: "fixture2",
  registry: { texture: { entries: 2 } },
};
const signal = (
  event: string,
  frame: number,
  state_at: string,
  args: unknown[],
) => ({ event, frame, state_at, args });
const driver = {
  initial: { state: "standby", can_arm: true, arm_count: 0 },
  ptrcall: {
    before: { state: "standby" },
    after: { state: "standby" },
    disarm_default: 3,
    disarm_explicit: 3,
    arm_invalid: 31,
  },
  arm_call_frame: 9,
  arm_code: 0,
  timeouts: [],
  registry_before_arm: { texture: { entries: 1 } },
  arm_failed_capture: { texture_workers_running: false },
  carrier: {
    index: 2,
    started: 1,
    stopped: 1,
    opened: true,
    third_opened: false,
    late_register: -1,
    started_frame: 10,
  },
  events: [
    signal("arm-returned", 10, "arming", [0]),
    signal("armed", 10, "armed", [
      {
        arm_frame: 10,
        root_size: "640x360",
        stream_version: 8,
        arm_index: 1,
        session_id: "session",
        listen: "127.0.0.1:1234",
        token: "",
        wt_cert_hash: "",
      },
    ]),
    signal("client_connected", 11, "armed", [
      1,
      { carrier: "ws", version: 8, origin: "" },
    ]),
    signal("client_connected", 12, "armed", [
      2,
      { carrier: "gdswap", version: 8, origin: "" },
    ]),
    signal("client_left", 42, "armed", [2, "hello-timeout"]),
    signal("disarm-returned", 75, "disarming", [0]),
    signal("client_left", 110, "disarming", [1, "disarm"]),
    signal("disarmed", 171, "standby", [
      { arm_index: 1, reason: "fixture", published: 65, clients_served: 2 },
    ]),
    signal("arm2-returned", 171, "arming", [0]),
    signal("armed", 172, "armed", [
      {
        arm_frame: 172,
        root_size: "640x360",
        stream_version: 8,
        arm_index: 2,
        session_id: "session2",
        listen: "127.0.0.1:5678",
        token: "",
        wt_cert_hash: "",
      },
    ]),
    signal("client_connected", 173, "armed", [
      1,
      { carrier: "ws", version: 8, origin: "" },
    ]),
    signal("disarm2-returned", 193, "disarming", [0]),
    signal("client_left", 212, "disarming", [1, "disarm"]),
    signal("disarmed", 273, "standby", [
      { arm_index: 2, reason: "fixture2", published: 21, clients_served: 1 },
    ]),
  ],
  carrier2: { index: 2, started: 1, stopped: 1 },
  final: state,
  refusals: [
    ...Object.entries(expectedRefusals).map(
      ([id, [code, last_refusal, current]]) => ({
        id,
        code,
        last_refusal,
        state_before: current,
        state_after: current,
        signals_during: 0,
      }),
    ),
    {
      id: "R12",
      code: 0,
      last_refusal: "busy",
      state_before: "standby",
      state_after: "arming",
      signals_during: 0,
    },
  ],
  rounds: [] as Record<string, unknown>[],
  loader: { enabled: false, creates: 0, errors: 0, samples: {} },
};
const evidence = {
  ...state,
  arm_frame: 10,
  texture_workers_running: false,
  max_callback_us: 640,
  callbacks: 97,
  pool_join: { ran: true, on_main: false, ms: 250 },
  carrier_join: { ran: true, on_main: false, ms: 1001 },
  top_callbacks: [{ frame: 91, phase: "stream-finish", us: 640 }],
};
const failed = structuredClone(driver);
failed.events = [
  signal("arm-returned", 10, "arming", [0]),
  signal("arm_failed", 10, "standby", ["listen-bind"]),
  signal("disarmed", 11, "standby", [
    { arm_index: 0, reason: "disarm", published: 0, clients_served: 0 },
  ]),
];
failed.final = { ...state, arm_count: 1, last_reason: "listen-bind" };
failed.rounds = [];
failed.refusals = [
  ...failed.refusals.filter((r) =>
    ["R1", "R2", "R3", "R4", "R5", "R5b", "R6", "R7", "R12", "R13"].includes(
      r.id,
    ),
  ),
  {
    id: "R12c",
    code: 0,
    last_refusal: "busy",
    state_before: "arming",
    state_after: "standby",
    signals_during: 0,
  },
];
const early = structuredClone(driver);
[early.events[0], early.events[1]] = [early.events[1], early.events[0]];
early.events[0].state_at = "arming";
const inline = {
  ...structuredClone(evidence),
  max_callback_us: 1000000,
  pool_join: { ran: true, on_main: true, ms: 250 },
  carrier_join: { ran: true, on_main: true, ms: 1001 },
};
// Round 1's capture-api.json is the driver's copy taken at `disarmed`; the file is round 2's.
const rounds = (size: number[]) => [
  {
    armed_info: { arm_index: 1, listen: "127.0.0.1:1234" },
    arm_call_frame: 9,
    viewer_listen: "127.0.0.1:1234",
    min_size_before: [64, 64],
    min_size_armed: [640, 360],
    min_size_after: size,
    capture_api: evidence,
  },
  {
    armed_info: { arm_index: 2, listen: "127.0.0.1:5678" },
    arm_call_frame: 171,
    viewer_listen: "127.0.0.1:5678",
    min_size_before: size,
    min_size_armed: [640, 360],
    min_size_after: size,
  },
];
driver.rounds = rounds([64, 64]);
const finalEvidence = { ...evidence, arm_frame: 172 };
const inlineDriver = structuredClone(driver);
inlineDriver.rounds[0].capture_api = inline;
const teardown = (
  arm_index: number,
  restore = "restored",
  skippedWait = false,
) => ({
  schema: "render-stream-teardown/1",
  arm_index,
  fault: skippedWait ? "skip-inflight-wait" : "",
  release_us: 1500000,
  inflight_wait_frames: skippedWait ? 0 : 100,
  inflight_max: 1,
  inflight_wait_timeout: false,
  root_min_size: {
    written: true,
    before: [64, 64],
    set: [640, 360],
    restore,
  },
  mirror: {
    items: 0,
    canvases: 1,
    textures: 0,
    meshes: 0,
    texture_payload_bytes: 0,
    mesh_payload_bytes: 0,
    held_bytes: 0,
  },
  served_sets: 0,
  served_bytes: 0,
  warm_cache_bytes: 0,
  texture_workers_running: false,
  encode_workers_running: false,
  hubs: 0,
  carrier_sets: 0,
  track_hub: false,
  writer_joined: true,
  publisher: false,
  resource_log_held: 0,
  mesh_buffers: 0,
  adopt_held: 0,
  item_meta: { host_held: 0, filter_watches: 0, calls_while_off: 0 },
});
const inflightDriver = structuredClone(driver);
inflightDriver.loader = {
  enabled: true,
  creates: 625,
  errors: 0,
  samples: {
    armed1: 0,
    disarm_call1: 11,
    disarmed1: 263,
    armed2: 265,
    disarm_call2: 268,
    disarmed2: 530,
    final: 625,
  },
};
const sabotageRoot = structuredClone(driver);
sabotageRoot.rounds = rounds([640, 360]);
sabotageRoot.rounds[1].min_size_before = [640, 360];
sabotageRoot.rounds[0].capture_api = evidence;
const admissionLeg = (
  mode: "standby" | "counted" | "sabotage" | "hot-sabotage",
) => ({
  driver: {
    timeouts: [],
    events: [
      { event: "armed", arm: 1 },
      { event: "disarmed", arm: 1 },
      { event: "armed", arm: 2 },
      { event: "disarmed", arm: 2 },
    ],
    final: state,
    admission: { counted: mode === "counted" },
    free_admission: { counted: mode === "counted" },
    texture_admission: { counted: mode === "counted" },
    texture_hot: {
      raw_streaming: mode !== "counted",
      streaming: mode === "sabotage" || mode === "hot-sabotage",
    },
    held_at_arm2: mode !== "counted",
    held_at_release: mode === "standby",
  },
  evidence: finalEvidence,
  result: { status: "standby" },
  teardown1: {
    ...teardown(1),
    uncounted_arm_accesses: 0,
    held_free_registered: false,
    inflight_max: mode === "counted" ? 3 : 0,
  },
  teardown2: {
    ...teardown(2),
    uncounted_arm_accesses:
      mode === "sabotage" || mode === "hot-sabotage" ? 1 : 0,
    held_free_registered: false,
    inflight_max: 0,
  },
});
const baseline = {
  "rearm-admission-standby": admissionLeg("standby"),
  "rearm-admission-counted": admissionLeg("counted"),
  "sabotage-standby-view-off": admissionLeg("sabotage"),
  "sabotage-hot-view-off": admissionLeg("hot-sabotage"),
  "evidence-dir": {
    driver: {
      ...driver,
      evidence_dir_failure: {
        reason: "evidence-dir",
        before: {
          "resources.jsonl": "resources",
          "teardown.json": "teardown",
          "live.json": "live",
        },
        after: {
          "resources.jsonl": "resources",
          "teardown.json": "teardown",
          "live.json": "live",
        },
      },
    },
    evidence: finalEvidence,
    result: { status: "standby" },
  },
  "rearm-quit-pending": {
    driver: { ...driver, quit_pending: { state: "disarming" } },
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: { ...teardown(1, "root-gone"), root_finalized: true },
    teardown2: teardown(2),
  },
  host: {
    driver,
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: teardown(1),
    teardown2: teardown(2),
  },
  "arm-failed": {
    driver: failed,
    evidence: { ...evidence, last_reason: "listen-bind" },
    result: { status: "standby" },
  },
  "arm-failed-ws": structuredClone({
    driver: {
      ...failed,
      arm_failed_capture: {
        ...failed.arm_failed_capture,
        track_inject_prepared: true,
        track_inject_pending: false,
      },
    },
    evidence: {
      ...evidence,
      last_reason: "listen-bind",
      track_inject_prepared: true,
      track_inject_pending: false,
    },
    result: { status: "standby" },
  }),
  "sabotage-api-early-armed": {
    driver: early,
    evidence: finalEvidence,
    result: { status: "standby" },
  },
  "sabotage-disarm-joins-on-main": {
    driver: inlineDriver,
    evidence: finalEvidence,
    result: { status: "standby" },
  },
  "rearm-inflight": {
    driver: inflightDriver,
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: teardown(1),
    teardown2: teardown(2),
  },
  "rearm-materialize": {
    driver: inflightDriver,
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: teardown(1),
    teardown2: teardown(2),
  },
  "sabotage-skip-inflight-wait": {
    driver: inflightDriver,
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: teardown(1, "restored", true),
    teardown2: teardown(2, "restored", true),
  },
  "sabotage-skip-root-restore": {
    driver: sabotageRoot,
    evidence: finalEvidence,
    result: { status: "standby" },
    teardown1: teardown(1, "skipped"),
    teardown2: teardown(2, "skipped"),
  },
};
type Tree = typeof baseline;
const json = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
function write(tree: Tree): void {
  rmSync(join(out, "g8l"), { recursive: true, force: true });
  const root = join(out, "g8l/api");
  for (const tap of ["tap", "tap/arm-2"])
    for (const name of ["stream-1.rs2", "live-1.jsonl"])
      json(join(root, "host", tap, name), "tap bytes");
  json(join(root, "import/fixture/exit-code.txt"), 0);
  for (const [name, leg] of Object.entries(tree)) {
    const dir = join(root, name);
    json(join(dir, "driver/driver.json"), leg.driver);
    json(join(dir, "evidence/capture-api.json"), leg.evidence);
    json(join(dir, "evidence/result.json"), leg.result);
    if ("teardown1" in leg) {
      json(join(dir, "evidence/reader-after-release.json"), {
        reader_after_release: name === "sabotage-skip-inflight-wait" ? 2 : 0,
        arms: [1, 2].map((arm_index) => ({
          arm_index,
          reader_after_release: name === "sabotage-skip-inflight-wait" ? 1 : 0,
        })),
      });
      json(join(dir, "evidence/teardown.json"), leg.teardown1);
      json(join(dir, "evidence/arm-2/teardown.json"), leg.teardown2);
    }
    writeFileSync(
      join(dir, "evidence/admission-adopted-code.txt"),
      "shader_type canvas_item; void fragment() { COLOR = vec4(0.75); }",
    );
    json(join(dir, "exit-code.txt"), 0);
    writeFileSync(
      join(dir, "stdout.log"),
      "[grc] root-call: get-min-size\n[grc] shutdown: root-finalized\n",
    );
  }
}
function set(root: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = root as Record<string, unknown>;
  for (const key of parts.slice(0, -1))
    current = current[key] as Record<string, unknown>;
  current[parts.at(-1) as string] = value;
}
async function rejected(
  path: string,
  value: unknown,
  id: string,
): Promise<void> {
  const tree = structuredClone(baseline);
  set(tree, path, value);
  write(tree);
  const checks = await runApiChecks(out);
  assert.equal(
    checks.find((c) => c.id === id)?.passed,
    false,
    `${path}=${JSON.stringify(value)} must fail ${id}`,
  );
  assertions++;
}
try {
  assert.deepEqual(await runApiChecks(out), []);
  assertions++;
  write(baseline);
  const checks = await runApiChecks(out);
  assert.equal(checks.length, 18);
  assert.ok(
    checks.every((c) => c.passed),
    JSON.stringify(checks),
  );
  assertions += 2;
  for (const [path, value] of [
    ["driver.evidence_dir_failure.reason", "listen-bind"],
    ["driver.evidence_dir_failure.after", { "resources.jsonl": "overwritten" }],
    ["driver.evidence_dir_failure.before", {}],
    ["driver.final.state", "armed"],
  ] as [string, unknown][])
    await rejected(`evidence-dir.${path}`, value, "g8l-rearm-evidence-dir");
  for (const tap of ["tap", "tap/arm-2"]) {
    for (const name of ["stream-1.rs2", "live-1.jsonl"]) {
      write(baseline);
      writeFileSync(join(out, "g8l/api/host", tap, name), "");
      assert.equal(
        (await runApiChecks(out)).find((c) => c.id === "g8l-rearm-taps")
          ?.passed,
        false,
      );
      assertions++;
    }
  }
  const order = "g8l-api-order";
  for (const [path, value] of [
    ["initial.state", "armed"],
    ["initial.can_arm", false],
    ["initial.arm_count", 1],
    ["timeouts", ["deadline"]],
    ["events", null],
    ["carrier.index", 1],
    ["ptrcall.before.state", "armed"],
    ["ptrcall.after.state", "armed"],
    ["ptrcall.disarm_default", 0],
    ["ptrcall.disarm_explicit", 0],
    ["ptrcall.arm_invalid", 0],
    ["arm_code", 44],
    ["arm_call_frame", 10],
    ["events.0.args.0", 44],
    ["events.5.args.0", 44],
    ["events.1.state_at", "arming"],
    ["events.1.args.0.arm_frame", 11],
    ["events.1.args.0.root_size", "64x64"],
    ["events.1.args.0.stream_version", 9],
    ["events.1.args.0.arm_index", 0],
    ["events.1.args.0.session_id", ""],
    ["events.1.args.0.listen", "127.0.0.1:0"],
    ["events.1.args.0.listen", "127.0.0.1:65536"],
    ["events.1.args.0.token", "unexpected"],
    ["events.1.args.0.wt_cert_hash", "unexpected"],
    ["events.3.args.0", 1],
    ["events.6.args.0", 3],
    ["events.4.args.1", "other"],
    ["events.2.args.1.carrier", "other"],
    ["events.3.args.1.carrier", "other"],
    ["events.7.args.0.arm_index", 0],
    ["events.7.args.0.reason", "other"],
    ["events.7.args.0.published", 0],
    ["events.7.args.0.clients_served", 1],
    ["carrier.started", 0],
    ["carrier.stopped", 0],
    ["carrier.opened", false],
    ["carrier.third_opened", true],
    ["carrier.late_register", 3],
    ["carrier.started_frame", 12],
    ["final.state", "disarming"],
    ["final.can_arm", false],
    ["final.arm_count", 0],
    ["final.clients", 1],
    ["events.7.state_at", "disarming"],
    ["final.arm_count", 1],
    ["final.last_reason", "fixture"],
    ["events.8.args.0", 44],
    ["events.11.args.0", 44],
    ["events.9.state_at", "arming"],
    ["events.9.args.0.arm_frame", 173],
    ["events.9.args.0.arm_index", 1],
    ["events.9.args.0.root_size", "64x64"],
    ["events.9.args.0.session_id", "session"],
    ["events.9.args.0.listen", "127.0.0.1:9999"],
    ["events.10.args.1.carrier", "other"],
    ["events.12.args.0", 9],
    ["events.13.args.0.arm_index", 1],
    ["events.13.args.0.reason", "fixture"],
    ["events.13.args.0.published", 0],
    ["events.13.args.0.clients_served", 2],
    ["events.13.state_at", "disarming"],
    ["carrier2.index", 1],
    ["carrier2.started", 0],
    ["carrier2.stopped", 0],
    ["rounds.1.arm_call_frame", 170],
  ] as [string, unknown][])
    await rejected(`host.driver.${path}`, value, order);
  for (const name of [
    "armed",
    "arm_failed",
    "stream_ended",
    "client_connected",
    "client_left",
    "disarmed",
    "arm-returned",
    "disarm-returned",
    "arm2-returned",
    "disarm2-returned",
  ])
    await rejected(
      "host.driver.events",
      [...driver.events, signal(name, 300, "standby", [])],
      order,
    );
  for (let i = 0; i < driver.events.length; i++)
    await rejected(
      "host.driver.events",
      driver.events.filter((_, n) => n !== i),
      order,
    );
  for (let i = 0; i < driver.events.length - 1; i++) {
    const reordered = structuredClone(driver.events);
    [reordered[i], reordered[i + 1]] = [reordered[i + 1], reordered[i]];
    await rejected("host.driver.events", reordered, order);
  }
  await rejected("host.driver.rounds.0.capture_api.arm_frame", 11, order);
  await rejected("host.evidence.arm_frame", 173, order);
  for (let i = 0; i < driver.refusals.length; i++) {
    for (const [field, value] of [
      ["code", -1],
      ["last_refusal", "wrong"],
      ["state_before", "wrong"],
      ["state_after", "wrong"],
      ["signals_during", 1],
    ] as const) {
      // An accepted call (R12) has no refusal reason to judge.
      if (driver.refusals[i].id === "R12" && field === "last_refusal") continue;
      await rejected(
        `host.driver.refusals.${i}.${field}`,
        value,
        "g8l-api-refusals",
      );
    }
    await rejected(
      "host.driver.refusals",
      driver.refusals.filter((_, n) => n !== i),
      "g8l-api-refusals",
    );
  }
  await rejected(
    "host.driver.refusals",
    [...driver.refusals, driver.refusals[0]],
    "g8l-api-refusals",
  );
  const quitId = "g8l-rearm-quit-pending";
  await rejected(
    "rearm-quit-pending.driver.quit_pending.state",
    "standby",
    quitId,
  );
  await rejected(
    "rearm-quit-pending.teardown1.root_min_size.restore",
    "restored",
    quitId,
  );
  await rejected(
    "rearm-quit-pending.teardown1.root_min_size.written",
    false,
    quitId,
  );
  await rejected("rearm-quit-pending.teardown1.root_finalized", false, quitId);
  assert.ok(
    quitPendingProblems(
      baseline["rearm-quit-pending"].driver,
      baseline["rearm-quit-pending"].teardown1,
      "139",
      "shutdown: root-finalized",
    ).length,
  );
  assert.ok(
    quitPendingProblems(
      baseline["rearm-quit-pending"].driver,
      baseline["rearm-quit-pending"].teardown1,
      "0",
      "shutdown: root-finalized\nroot-call: write-min-size",
    ).length,
  );
  assertions += 2;
  const stall = "g8l-main-thread-stall";
  for (const [path, value] of [
    ["max_callback_us", 50001],
    ["max_callback_us", null],
    ["callbacks", 29],
    ["top_callbacks", []],
  ] as [string, unknown][])
    await rejected(`host.driver.rounds.0.capture_api.${path}`, value, stall);
  for (const [name, minimum] of [
    ["pool_join", 200],
    ["carrier_join", 500],
  ] as const)
    for (const [field, value] of [
      ["ran", false],
      ["on_main", true],
      ["ms", minimum - 1],
      ["ms", null],
    ] as [string, unknown][])
      await rejected(
        `host.driver.rounds.0.capture_api.${name}.${field}`,
        value,
        stall,
      );
  const failure = "g8l-api-arm-failed";
  for (const [path, value] of [
    ["evidence.track_inject_prepared", false],
    ["evidence.track_inject_pending", true],
    ["driver.arm_failed_capture.track_inject_prepared", null],
    ["driver.arm_failed_capture.track_inject_pending", true],
  ] as [string, unknown][])
    await rejected(`arm-failed-ws.${path}`, value, failure);
  for (const [path, value] of [
    ["driver.events.1.args.0", "stream-refused"],
    ["driver.events.1.state_at", "arming"],
    ["driver.events", []],
    ["driver.events", [...failed.events, signal("armed", 10, "armed", [])]],
    [
      "driver.events",
      [...failed.events, signal("stream_ended", 10, "ended", [])],
    ],
    [
      "driver.events",
      [...failed.events, signal("disarmed", 10, "standby", [])],
    ],
    ["driver.events", failed.events.slice(0, 2)],
    ["driver.events.2.args.0.arm_index", 1],
    ["driver.events.2.args.0.published", 3],
    ["driver.events.2.state_at", "arming"],
    ["driver.final.state", "refused"],
    ["driver.final.can_arm", false],
    ["driver.final.arm_count", 0],
    ["driver.final.last_reason", "other"],
    ["evidence.state", "refused"],
    ["evidence.can_arm", false],
    ["evidence.last_reason", "other"],
    ["evidence.texture_workers_running", true],
    ["driver.arm_failed_capture.texture_workers_running", true],
    ["driver.arm_failed_capture", {}],
    ["driver.registry_before_arm", {}],
    ["driver.final.registry.texture.entries", 0],
    ["driver.final.registry", {}],
    ["result.status", "refused"],
    ["driver.refusals", []],
    ["driver.refusals", failed.refusals.filter((r) => r.id !== "R12c")],
    [
      "driver.refusals",
      failed.refusals.map((r) =>
        r.id === "R12c" ? { ...r, code: 3, state_after: "arming" } : r,
      ),
    ],
    [
      "driver.refusals",
      failed.refusals.map((r) =>
        r.id === "R12" ? { ...r, state_after: "standby" } : r,
      ),
    ],
  ] as [string, unknown][])
    for (const leg of ["arm-failed", "arm-failed-ws"])
      await rejected(`${leg}.${path}`, value, failure);
  for (const name of ["api-early-armed", "disarm-joins-on-main"]) {
    const id = `g8l-sabotage-${name}`;
    await rejected(`sabotage-${name}`, baseline.host, id);
    await rejected(`sabotage-${name}.driver.timeouts`, ["deadline"], id);
  }
  await rejected(
    "sabotage-disarm-joins-on-main.driver.rounds.0.capture_api.max_callback_us",
    199999,
    "g8l-sabotage-disarm-joins-on-main",
  );
  // The accepted-call rows: a re-arm that was refused or left the state alone fails.
  for (const [field, value] of [
    ["code", 3],
    ["state_before", "armed"],
    ["state_after", "standby"],
    ["signals_during", 1],
  ] as const)
    await rejected(
      `host.driver.refusals.${driver.refusals.findIndex((r) => r.id === "R12")}.${field}`,
      value,
      "g8l-api-refusals",
    );
  // g8l-root-min-size-restored: armed 640x360, restored after each disarm, as teardown.json says.
  const root = "g8l-root-min-size-restored";
  for (const [path, value] of [
    ["host.driver.rounds.0.min_size_armed", [64, 64]],
    ["host.driver.rounds.1.min_size_armed", [64, 64]],
    ["host.driver.rounds.0.min_size_after", [640, 360]],
    ["host.driver.rounds.1.min_size_after", [640, 360]],
    ["host.driver.rounds.1.min_size_before", [640, 360]],
    ["host.driver.rounds.0.min_size_before", [640, 360]],
    ["host.driver.rounds.0.min_size_before", null],
    ["host.driver.rounds", []],
    ["host.teardown1.root_min_size.restore", "skipped"],
    ["host.teardown2.root_min_size.restore", "changed"],
    ["host.teardown1.root_min_size.written", false],
    ["host.teardown2", {}],
  ] as [string, unknown][])
    await rejected(path, value, root);
  const caught = "g8l-sabotage-skip-root-restore-caught";
  await rejected("sabotage-skip-root-restore", baseline.host, caught);
  for (const [path, value] of [
    ["driver.timeouts", ["deadline"]],
    ["driver.rounds.0.min_size_after", [64, 64]],
    ["teardown1.root_min_size.restore", "restored"],
  ] as [string, unknown][])
    await rejected(`sabotage-skip-root-restore.${path}`, value, caught);
  for (const [path, value, id] of [
    [
      "rearm-admission-standby.teardown2.uncounted_arm_accesses",
      1,
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-standby.teardown2.inflight_max",
      1,
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-standby.driver.admission.counted",
      true,
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-counted.teardown1.held_free_registered",
      true,
      "g8l-rearm-admission-counted",
    ],
    [
      "rearm-admission-counted.teardown2.held_free_registered",
      true,
      "g8l-rearm-admission-counted",
    ],
    [
      "rearm-admission-counted.teardown1.inflight_max",
      2,
      "g8l-rearm-admission-counted",
    ],
    [
      "rearm-admission-counted.teardown1.inflight_wait_frames",
      0,
      "g8l-rearm-admission-counted",
    ],
    [
      "rearm-admission-counted.teardown1.inflight_wait_timeout",
      true,
      "g8l-rearm-admission-counted",
    ],
    [
      "rearm-admission-counted.driver.free_admission.counted",
      false,
      "g8l-rearm-admission-counted",
    ],
    [
      "sabotage-standby-view-off.teardown2.uncounted_arm_accesses",
      0,
      "g8l-sabotage-standby-view-off-caught",
    ],
    [
      "rearm-admission-standby.driver.events",
      [],
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-standby.teardown2.uncounted_arm_accesses",
      null,
      "g8l-rearm-admission-standby",
    ],
  ] as const)
    await rejected(path, value, id);
  for (const [path, value, id] of [
    [
      "rearm-admission-standby.driver.texture_hot.streaming",
      true,
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-standby.driver.texture_hot.raw_streaming",
      false,
      "g8l-rearm-admission-standby",
    ],
    [
      "rearm-admission-counted.driver.texture_admission.counted",
      false,
      "g8l-rearm-admission-counted",
    ],
    [
      "sabotage-hot-view-off.driver.texture_hot.streaming",
      false,
      "g8l-sabotage-hot-view-off-caught",
    ],
    [
      "sabotage-hot-view-off.teardown2.uncounted_arm_accesses",
      0,
      "g8l-sabotage-hot-view-off-caught",
    ],
  ] as const)
    await rejected(path, value, id);
  const admitted = admissionLeg("counted");
  assert.ok(
    admissionProblems(
      admitted.driver,
      admitted.teardown1,
      admitted.teardown2,
      "0",
      "counted",
      "A",
    ).length,
  );
  assert.ok(
    admissionProblems(
      admitted.driver,
      admitted.teardown1,
      admitted.teardown2,
      "139",
      "counted",
      "B",
    ).length,
  );
  assertions += 2;
  // g8l-rearm-inflight: a loader thread across both disarms, every teardown clean.
  const inflight = "g8l-rearm-inflight";
  for (const [path, value] of [
    ["driver.timeouts", ["deadline"]],
    ["driver.loader.enabled", false],
    ["driver.loader.creates", 0],
    ["driver.loader.errors", 1],
    ["driver.loader.samples.disarm_call1", 0],
    ["driver.loader.samples.disarm_call2", 263],
    ["driver.loader.samples.disarm_call2", 265],
    ["driver.final.arm_count", 1],
    ["driver.final.state", "armed"],
    ["teardown1.mirror.textures", 1],
    ["teardown2.mirror.textures", 1],
    ["teardown2.mirror.items", 1],
    ["teardown1.mirror.meshes", 1],
    ["teardown1.mirror.held_bytes", 1],
    ["teardown1.mirror.canvases", 2],
    ["teardown2.served_sets", 1],
    ["teardown1.served_bytes", 1],
    ["teardown1.hubs", 1],
    ["teardown2.carrier_sets", 1],
    ["teardown1.writer_joined", false],
    ["teardown1.texture_workers_running", true],
    ["teardown2.encode_workers_running", true],
    ["teardown1.resource_log_held", 1],
    ["teardown2.mesh_buffers", 1],
    ["teardown2.adopt_held", 1],
    ["teardown1.item_meta.host_held", 1],
    ["teardown2.fault", "skip-inflight-wait"],
    ["teardown2.arm_index", 1],
    ["teardown1.inflight_wait_frames", 0],
    ["teardown2.inflight_wait_frames", -1],
    ["teardown2.inflight_wait_frames", null],
    ["teardown1.inflight_wait_timeout", true],
    ["teardown2.inflight_wait_timeout", null],
    ["teardown2", {}],
  ] as [string, unknown][])
    await rejected(`rearm-inflight.${path}`, value, inflight);
  // The negative leg reports the prevented reads instead of executing them.
  const waited = "g8l-sabotage-skip-inflight-wait-caught";
  await rejected(
    "sabotage-skip-inflight-wait",
    baseline["rearm-inflight"],
    waited,
  );
  for (const [path, value] of [
    ["driver.timeouts", ["deadline"]],
    ["driver.loader.enabled", false],
    ["teardown1.inflight_wait_frames", 1],
    ["teardown2.inflight_wait_frames", 1],
    ["teardown2.fault", ""],
    ["teardown1", {}],
  ] as [string, unknown][])
    await rejected(`sabotage-skip-inflight-wait.${path}`, value, waited);
  for (const [leg, id, field, value] of [
    ["rearm-inflight", inflight, "reader_after_release", 1],
    ["rearm-materialize", "g8l-rearm-materialize", "reader_after_release", 1],
    ["sabotage-skip-inflight-wait", waited, "reader_after_release", 0],
    ["sabotage-skip-inflight-wait", waited, "reader_after_release", null],
    [
      "sabotage-skip-inflight-wait",
      waited,
      "arms",
      [
        { arm_index: 1, reader_after_release: 0 },
        { arm_index: 2, reader_after_release: 1 },
      ],
    ],
    ["sabotage-skip-inflight-wait", waited, "arms", []],
  ] as const) {
    write(baseline);
    const proof = {
      reader_after_release: leg === "sabotage-skip-inflight-wait" ? 2 : 0,
      arms: [1, 2].map((arm_index) => ({ arm_index, reader_after_release: 1 })),
    };
    json(join(out, `g8l/api/${leg}/evidence/reader-after-release.json`), {
      ...proof,
      [field]: value,
    });
    assert.equal(
      (await runApiChecks(out)).find((c) => c.id === id)?.passed,
      false,
      `${leg}: reject ${field}=${JSON.stringify(value)}`,
    );
    assertions++;
  }
  write(baseline);
  json(join(out, "g8l/api/sabotage-skip-inflight-wait/exit-code.txt"), 139);
  assert.equal(
    (await runApiChecks(out)).find((c) => c.id === waited)?.passed,
    false,
  );
  assertions++;
  write(baseline);
  json(join(out, "g8l/api/rearm-inflight/exit-code.txt"), 139);
  assert.equal(
    (await runApiChecks(out)).find((c) => c.id === inflight)?.passed,
    false,
  );
  assertions++;
  write(baseline);
  for (const [leg, id] of [
    ["host", order],
    ["host", root],
    ["rearm-inflight", inflight],
    ["sabotage-skip-inflight-wait", waited],
    ["sabotage-skip-root-restore", caught],
    ["arm-failed", failure],
    ["arm-failed-ws", failure],
    ["sabotage-api-early-armed", "g8l-sabotage-api-early-armed"],
    ["sabotage-disarm-joins-on-main", "g8l-sabotage-disarm-joins-on-main"],
  ]) {
    write(baseline);
    rmSync(join(out, "g8l/api", leg), { recursive: true });
    assert.equal(
      (await runApiChecks(out)).find((c) => c.id === id)?.passed,
      false,
    );
    assertions++;
  }
  write(baseline);
  json(join(out, "g8l/api/host/exit-code.txt"), 1);
  assert.ok(
    (await runApiChecks(out))
      .filter(
        (c) =>
          ![
            "g8l-rearm-quit-pending",
            "g8l-rearm-evidence-dir",
            "g8l-rearm-admission-standby",
            "g8l-rearm-admission-counted",
            "g8l-sabotage-standby-view-off-caught",
            "g8l-sabotage-hot-view-off-caught",
          ].includes(c.id),
      )
      .every((c) => !c.passed),
  );
  assertions++;
  write(baseline);
  writeFileSync(join(out, "g8l/api/host/driver/driver.json"), "{");
  assert.equal(
    (await runApiChecks(out)).find((c) => c.id === order)?.passed,
    false,
  );
  assertions++;
  write(baseline);
  for (const name of [
    "sabotage-api-early-armed",
    "sabotage-disarm-joins-on-main",
    "sabotage-skip-inflight-wait",
    "sabotage-skip-root-restore",
    "sabotage-standby-view-off",
    "sabotage-hot-view-off",
  ]) {
    const dir = join(out, "g8l/api", name);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(dir, "skipped-by-tier.txt"), "skip");
  }
  const skipped = await runApiChecks(out);
  const sabotaged = skipped.filter((c) => c.id.startsWith("g8l-sabotage-"));
  assert.equal(sabotaged.length, 6);
  assert.ok(
    sabotaged.every((c) => !c.passed && c.detail?.includes("skipped-by-tier")),
  );
  assertions++;
  console.log(`self-test-gate8-api: ${assertions} passed, 0 failed`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
