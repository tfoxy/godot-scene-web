#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Synthetic evidence exercises each API assertion, including sabotage non-vacuity.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runApiChecks } from "../lib/gate8-api-checks";

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
  R12: [2, "rearm-unsupported", "standby"],
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
  can_arm: false,
  arm_count: 1,
  clients: 0,
  last_reason: "fixture",
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
  ],
  final: state,
  refusals: Object.entries(expectedRefusals).map(
    ([id, [code, last_refusal, current]]) => ({
      id,
      code,
      last_refusal,
      state_before: current,
      state_after: current,
      signals_during: 0,
    }),
  ),
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
];
failed.final.last_reason = "listen-bind";
failed.refusals = failed.refusals.filter((r) =>
  ["R1", "R2", "R3", "R4", "R5", "R5b", "R6", "R7", "R12", "R13"].includes(
    r.id,
  ),
);
const early = structuredClone(driver);
[early.events[0], early.events[1]] = [early.events[1], early.events[0]];
early.events[0].state_at = "arming";
const inline = {
  ...structuredClone(evidence),
  max_callback_us: 1000000,
  pool_join: { ran: true, on_main: true, ms: 250 },
  carrier_join: { ran: true, on_main: true, ms: 1001 },
};
const baseline = {
  host: { driver, evidence, result: { status: "standby" } },
  "arm-failed": {
    driver: failed,
    evidence: { ...evidence, last_reason: "listen-bind" },
    result: { status: "standby" },
  },
  "arm-failed-ws": structuredClone({
    driver: failed,
    evidence: { ...evidence, last_reason: "listen-bind" },
    result: { status: "standby" },
  }),
  "sabotage-api-early-armed": {
    driver: early,
    evidence,
    result: { status: "standby" },
  },
  "sabotage-disarm-joins-on-main": {
    driver,
    evidence: inline,
    result: { status: "standby" },
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
  json(join(root, "import/fixture/exit-code.txt"), 0);
  for (const [name, leg] of Object.entries(tree)) {
    const dir = join(root, name);
    json(join(dir, "driver/driver.json"), leg.driver);
    json(join(dir, "evidence/capture-api.json"), leg.evidence);
    json(join(dir, "evidence/result.json"), leg.result);
    json(join(dir, "exit-code.txt"), 0);
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
  assert.equal(checks.length, 6);
  assert.ok(
    checks.every((c) => c.passed),
    JSON.stringify(checks),
  );
  assertions += 2;
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
    ["final.can_arm", true],
    ["final.arm_count", 0],
    ["final.clients", 1],
    ["events.7.state_at", "disarming"],
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
  ])
    await rejected(
      "host.driver.events",
      [...driver.events, signal(name, 200, "standby", [])],
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
  await rejected("host.evidence.arm_frame", 11, order);
  for (let i = 0; i < driver.refusals.length; i++) {
    for (const [field, value] of [
      ["code", -1],
      ["last_refusal", "wrong"],
      ["state_before", "wrong"],
      ["state_after", "wrong"],
      ["signals_during", 1],
    ] as const)
      await rejected(
        `host.driver.refusals.${i}.${field}`,
        value,
        "g8l-api-refusals",
      );
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
  const stall = "g8l-main-thread-stall";
  for (const [path, value] of [
    ["max_callback_us", 50001],
    ["max_callback_us", null],
    ["callbacks", 29],
    ["top_callbacks", []],
  ] as [string, unknown][])
    await rejected(`host.evidence.${path}`, value, stall);
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
      await rejected(`host.evidence.${name}.${field}`, value, stall);
  const failure = "g8l-api-arm-failed";
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
    ["driver.final.state", "refused"],
    ["driver.final.can_arm", true],
    ["driver.final.arm_count", 0],
    ["driver.final.last_reason", "other"],
    ["evidence.state", "refused"],
    ["evidence.can_arm", true],
    ["evidence.last_reason", "other"],
    ["evidence.texture_workers_running", true],
    ["driver.arm_failed_capture.texture_workers_running", true],
    ["driver.arm_failed_capture", {}],
    ["driver.registry_before_arm", {}],
    ["driver.final.registry.texture.entries", 0],
    ["driver.final.registry", {}],
    ["result.status", "refused"],
    ["driver.refusals", []],
  ] as [string, unknown][])
    for (const leg of ["arm-failed", "arm-failed-ws"])
      await rejected(`${leg}.${path}`, value, failure);
  for (const name of ["api-early-armed", "disarm-joins-on-main"]) {
    const id = `g8l-sabotage-${name}`;
    await rejected(`sabotage-${name}`, baseline.host, id);
    await rejected(`sabotage-${name}.driver.timeouts`, ["deadline"], id);
  }
  await rejected(
    "sabotage-disarm-joins-on-main.evidence.max_callback_us",
    199999,
    "g8l-sabotage-disarm-joins-on-main",
  );
  write(baseline);
  for (const [leg, id] of [
    ["host", order],
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
  assert.ok((await runApiChecks(out)).every((c) => !c.passed));
  assertions++;
  write(baseline);
  writeFileSync(join(out, "g8l/api/host/driver/driver.json"), "{");
  assert.equal(
    (await runApiChecks(out)).find((c) => c.id === order)?.passed,
    false,
  );
  assertions++;
  write(baseline);
  for (const name of ["api-early-armed", "disarm-joins-on-main"]) {
    const dir = join(out, "g8l/api", `sabotage-${name}`);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(dir, "skipped-by-tier.txt"), "skip");
  }
  const skipped = await runApiChecks(out);
  assert.ok(
    skipped
      .filter((c) => c.id.startsWith("g8l-sabotage-"))
      .every((c) => !c.passed && c.detail?.includes("skipped-by-tier")),
  );
  assertions++;
  console.log(`self-test-gate8-api: ${assertions} passed, 0 failed`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
