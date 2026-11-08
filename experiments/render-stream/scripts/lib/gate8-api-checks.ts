// Capture singleton lifecycle checks read only the headless fixture's evidence.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  check,
  exitCode,
  type G8aCheck,
  readJson,
  skipped,
} from "./gate8-adopt-checks";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const rows = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(object) : [];
const args = (event: Json): unknown[] =>
  Array.isArray(event.args) ? event.args : [];
const info = (event: Json): Json => object(args(event)[0]);
const carrier = (event: Json): unknown => object(args(event)[1]).carrier;
const count = (events: Json[], name: string): number =>
  events.filter((e) => e.event === name).length;

const API_REFUSALS: Record<string, [number, string, string]> = {
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

export function apiRefusalProblems(
  driver: Json,
  ids = Object.keys(API_REFUSALS),
): string[] {
  const problems: string[] = [];
  const refusals = rows(driver.refusals);
  if (refusals.length !== ids.length) problems.push("unexpected refusal count");
  for (const id of ids) {
    const [code, reason, state] = API_REFUSALS[id];
    const matching = refusals.filter((r) => r.id === id);
    const r = matching[0];
    if (
      matching.length !== 1 ||
      r?.code !== code ||
      r?.last_refusal !== reason ||
      r?.state_before !== state ||
      r?.state_after !== state ||
      r?.signals_during !== 0
    )
      problems.push(
        `${id}: expected ${code} ${reason}, unchanged ${state}, no signals`,
      );
  }
  return problems;
}

function driverProblems(driver: Json): string[] {
  const problems: string[] = [];
  const initial = object(driver.initial);
  if (
    initial.state !== "standby" ||
    initial.can_arm !== true ||
    initial.arm_count !== 0
  )
    problems.push("initial state is not armable standby");
  if (!Array.isArray(driver.timeouts) || driver.timeouts.length)
    problems.push("driver timed out");
  if (!Array.isArray(driver.events)) problems.push("events missing");
  if (object(driver.carrier).index !== 2)
    problems.push("standby carrier did not register at index 2");
  const probe = object(driver.ptrcall);
  if (
    object(probe.before).state !== "standby" ||
    object(probe.after).state !== "standby" ||
    probe.disarm_default !== 3 ||
    probe.disarm_explicit !== 3 ||
    probe.arm_invalid !== 31
  )
    problems.push("typed ptrcall probe failed");
  return problems;
}

export function apiOrderProblems(driver: Json, evidence: Json): string[] {
  const problems = driverProblems(driver);
  const events = rows(driver.events);
  const armed = events.find((e) => e.event === "armed") ?? {};
  const disarmed = events.find((e) => e.event === "disarmed") ?? {};
  const connected = events.filter((e) => e.event === "client_connected");
  const left = events.filter((e) => e.event === "client_left");
  const ws = connected.find((e) => carrier(e) === "ws");
  const gd = connected.find((e) => carrier(e) === "gdswap");
  const positions = [
    events.findIndex((e) => e.event === "arm-returned"),
    events.indexOf(armed),
    ws ? events.indexOf(ws) : -1,
    gd ? events.indexOf(gd) : -1,
    events.findIndex(
      (e) =>
        e.event === "client_left" &&
        e.args &&
        args(e)[1] === "hello-timeout" &&
        args(e)[0] === args(gd ?? {})[0],
    ),
    events.findIndex((e) => e.event === "disarm-returned"),
    events.findIndex(
      (e) => e.event === "client_left" && args(e)[0] === args(ws ?? {})[0],
    ),
    events.indexOf(disarmed),
  ];
  if (positions.some((p, i) => p < 0 || (i > 0 && p <= positions[i - 1])))
    problems.push("scheduled arm/client/disarm signal order failed");
  for (const [name, expected] of Object.entries({
    armed: 1,
    arm_failed: 0,
    stream_ended: 0,
    client_connected: 2,
    client_left: 2,
    disarmed: 1,
    "arm-returned": 1,
    "disarm-returned": 1,
  }))
    if (count(events, name) !== expected)
      problems.push(`${name}: expected exactly ${expected}`);
  if (
    driver.arm_code !== 0 ||
    args(events.find((e) => e.event === "arm-returned") ?? {})[0] !== 0 ||
    args(events.find((e) => e.event === "disarm-returned") ?? {})[0] !== 0
  )
    problems.push("arm/disarm call did not return OK");
  if (armed.state_at !== "armed") problems.push("armed state_at must be armed");
  const session = info(armed);
  if (
    typeof driver.arm_call_frame !== "number" ||
    evidence.arm_frame !== driver.arm_call_frame + 1 ||
    session.arm_frame !== evidence.arm_frame
  )
    problems.push("arm point must be the next capture frame");
  if (
    session.root_size !== "640x360" ||
    session.stream_version !== 8 ||
    session.arm_index !== 1 ||
    typeof session.session_id !== "string" ||
    !session.session_id ||
    typeof session.listen !== "string" ||
    !/^127\.0\.0\.1:[1-9]\d*$/.test(session.listen) ||
    Number(session.listen.split(":")[1]) > 65535 ||
    session.token !== "" ||
    session.wt_cert_hash !== ""
  )
    problems.push("armed session info failed");
  const ids = connected.map((e) => args(e)[0]);
  if (
    new Set(ids).size !== 2 ||
    ids.some(
      (id) =>
        typeof id !== "number" ||
        id <= 0 ||
        left.filter((e) => args(e)[0] === id).length !== 1,
    )
  )
    problems.push("view connection ids must match exactly once");
  const result = info(disarmed);
  if (
    result.arm_index !== 1 ||
    result.reason !== "fixture" ||
    typeof result.published !== "number" ||
    result.published < 1 ||
    result.clients_served !== 2
  )
    problems.push("disarmed info failed");
  const c = object(driver.carrier);
  if (
    c.started !== 1 ||
    c.stopped !== 1 ||
    c.opened !== true ||
    c.third_opened !== false ||
    c.late_register !== -1 ||
    typeof c.started_frame !== "number" ||
    !gd ||
    typeof gd.frame !== "number" ||
    c.started_frame >= gd.frame
  )
    problems.push("carrier start/stop/admission/order failed");
  const final = object(driver.final);
  if (
    final.state !== "standby" ||
    final.can_arm !== false ||
    final.arm_count !== 1 ||
    final.clients !== 0 ||
    disarmed.state_at !== "standby"
  )
    problems.push("final state must be spent standby without clients");
  return problems;
}

export function apiStallProblems(evidence: Json): string[] {
  const problems: string[] = [];
  if (
    typeof evidence.max_callback_us !== "number" ||
    !Number.isFinite(evidence.max_callback_us) ||
    evidence.max_callback_us < 0 ||
    evidence.max_callback_us > 50000
  )
    problems.push(
      `max_callback_us exceeds 50000 us or is missing; top_callbacks=${JSON.stringify(evidence.top_callbacks)}`,
    );
  for (const [name, minimum] of [
    ["pool_join", 200],
    ["carrier_join", 500],
  ] as const) {
    const timing = object(evidence[name]);
    if (
      timing.ran !== true ||
      timing.on_main !== false ||
      typeof timing.ms !== "number" ||
      !Number.isFinite(timing.ms) ||
      timing.ms < minimum
    )
      problems.push(`${name}: expected off-main join >= ${minimum} ms`);
  }
  if (typeof evidence.callbacks !== "number" || evidence.callbacks < 30)
    problems.push("expected >= 30 disarming callbacks");
  if (!Array.isArray(evidence.top_callbacks) || !evidence.top_callbacks.length)
    problems.push("top_callbacks missing");
  return problems;
}

export function apiArmFailedProblems(
  driver: Json,
  evidence: Json,
  result: Json,
): string[] {
  const problems = driverProblems(driver);
  const events = rows(driver.events);
  const failed = events.filter((e) => e.event === "arm_failed");
  if (
    failed.length !== 1 ||
    args(failed[0])[0] !== "listen-bind" ||
    failed[0].state_at !== "standby" ||
    count(events, "armed") !== 0 ||
    count(events, "stream_ended") !== 0 ||
    count(events, "disarmed") !== 0
  )
    problems.push("expected only arm_failed(listen-bind) in standby");
  const final = object(driver.final);
  if (
    final.state !== "standby" ||
    final.can_arm !== false ||
    final.arm_count !== 1 ||
    final.last_reason !== "listen-bind" ||
    evidence.state !== "standby" ||
    evidence.can_arm !== false ||
    evidence.last_reason !== "listen-bind"
  )
    problems.push(
      "failed arm must return to spent standby with listen-bind reason",
    );
  if (evidence.texture_workers_running !== false)
    problems.push("failed arm must stop texture workers");
  if (object(driver.arm_failed_capture).texture_workers_running !== false)
    problems.push("failed arm must stop texture workers before shutdown");
  const before = object(driver.registry_before_arm);
  const after = object(final.registry);
  const families = Object.keys(before);
  let total = 0;
  if (!families.length) problems.push("registry before arm missing");
  for (const family of families) {
    const a = object(after[family]).entries,
      b = object(before[family]).entries;
    if (typeof a !== "number" || typeof b !== "number" || a < b)
      problems.push(`${family}: registry lost entries`);
    if (typeof a === "number") total += a;
  }
  if (total <= 0) problems.push("registry must remain nonempty");
  if (result.status !== "standby")
    problems.push("result.json status must be standby");
  problems.push(
    ...apiRefusalProblems(driver, [
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R5b",
      "R6",
      "R7",
      "R12",
      "R13",
    ]),
  );
  return problems;
}

export async function runApiChecks(out: string): Promise<G8aCheck[]> {
  const dir = join(out, "g8l/api");
  if (!existsSync(dir)) return [];
  const load = async (leg: string) => {
    const path = join(dir, leg);
    return {
      driver: object(await readJson(join(path, "driver/driver.json"))),
      evidence: object(await readJson(join(path, "evidence/capture-api.json"))),
      result: object(await readJson(join(path, "evidence/result.json"))),
      exit: await exitCode(path),
    };
  };
  const host = await load("host");
  const common: string[] = [];
  if ((await exitCode(join(dir, "import/fixture"))) !== "0")
    common.push("fixture import did not exit 0");
  if (host.exit !== "0") common.push("host did not exit 0");
  const failedProblems: string[] = [];
  for (const leg of ["arm-failed", "arm-failed-ws"]) {
    const failed = await load(leg);
    if (failed.exit !== "0") failedProblems.push(`${leg} host did not exit 0`);
    failedProblems.push(
      ...apiArmFailedProblems(
        failed.driver,
        failed.evidence,
        failed.result,
      ).map((problem) => `${leg}: ${problem}`),
    );
  }
  const checks = [
    check(
      "g8l-api-order",
      "scheduled arm, view connections and disarm obey the singleton contract",
      [...common, ...apiOrderProblems(host.driver, host.evidence)],
    ),
    check(
      "g8l-api-refusals",
      "every specified refusal preserves state and emits no signals",
      [...common, ...apiRefusalProblems(host.driver)],
    ),
    check(
      "g8l-main-thread-stall",
      "disarm callbacks stay <= 50000 us while both joins run off main",
      [...common, ...apiStallProblems(host.evidence)],
      `max_callback_us=${host.evidence.max_callback_us}; top_callbacks=${JSON.stringify(host.evidence.top_callbacks)}`,
    ),
    check(
      "g8l-api-arm-failed",
      "listen-bind rolls back both carrier sets without workers or registry loss",
      [...common, ...failedProblems],
    ),
  ];
  for (const name of ["api-early-armed", "disarm-joins-on-main"] as const) {
    const leg = `sabotage-${name}`;
    const skip = skipped(join(dir, leg));
    if (skip) {
      checks.push(
        check(
          `g8l-sabotage-${name}`,
          "the matching honest check catches the injected fault",
          [skip],
        ),
      );
      continue;
    }
    const sab = await load(leg);
    const events = rows(sab.driver.events);
    const armed = events.findIndex((e) => e.event === "armed");
    const returned = events.findIndex((e) => e.event === "arm-returned");
    const detected =
      name === "api-early-armed"
        ? apiOrderProblems(sab.driver, sab.evidence).some(
            (problem) =>
              problem === "scheduled arm/client/disarm signal order failed" ||
              problem === "armed state_at must be armed",
          ) &&
          armed >= 0 &&
          returned >= 0 &&
          (armed < returned || events[armed].state_at === "arming")
        : apiStallProblems(sab.evidence).length > 0 &&
          typeof sab.evidence.max_callback_us === "number" &&
          sab.evidence.max_callback_us >= 200000;
    checks.push(
      check(
        `g8l-sabotage-${name}`,
        "the matching honest check catches the injected fault",
        [
          ...common,
          ...(sab.exit === "0" ? [] : ["sabotage host did not exit 0"]),
          ...(!Array.isArray(sab.driver.timeouts) || sab.driver.timeouts.length
            ? ["sabotage driver timed out"]
            : []),
          ...(detected ? [] : ["fault was not detected by its matching check"]),
        ],
      ),
    );
  }
  return checks;
}
