// Capture singleton lifecycle checks read only the headless fixture's evidence.
import { existsSync, readFileSync } from "node:fs";
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
  R13: [3, "not-armed", "standby"],
  R14: [31, "disarm-config-invalid", "armed"],
  R15: [31, "disarm-config-invalid", "armed"],
};

// Calls the capture accepts: [code, state before, state after]. last_refusal is not judged (the
// call is not refused, so it still names the previous refusal). R12 is arm() after `disarmed` or
// `arm_failed` (re-arm); R12c is the disarm() that cancels that arm while it is still arming.
const API_TRANSITIONS: Record<string, [number, string, string]> = {
  R12: [0, "standby", "arming"],
  R12c: [0, "arming", "standby"],
};

const HOST_REFUSALS = [...Object.keys(API_REFUSALS), "R12"];

export function apiRefusalProblems(
  driver: Json,
  ids: string[] = HOST_REFUSALS,
): string[] {
  const problems: string[] = [];
  const refusals = rows(driver.refusals);
  if (refusals.length !== ids.length) problems.push("unexpected refusal count");
  for (const id of ids) {
    const matching = refusals.filter((r) => r.id === id);
    const r = matching[0];
    const transition = API_TRANSITIONS[id];
    if (transition) {
      const [code, before, after] = transition;
      if (
        matching.length !== 1 ||
        r?.code !== code ||
        r?.state_before !== before ||
        r?.state_after !== after ||
        r?.signals_during !== 0
      )
        problems.push(
          `${id}: expected accepted ${code}, ${before} -> ${after}, no signals`,
        );
      continue;
    }
    const [code, reason, state] = API_REFUSALS[id];
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

const LISTEN = /^127\.0\.0\.1:[1-9]\d*$/;

// One lifecycle round's armed session info and disarmed result. `armIndex` is 1 or 2.
function sessionProblems(
  armed: Json,
  armIndex: number,
  armFrame: unknown,
  callFrame: unknown,
): string[] {
  const session = info(armed);
  const problems: string[] = [];
  if (armed.state_at !== "armed") problems.push("armed state_at must be armed");
  if (
    typeof callFrame !== "number" ||
    armFrame !== callFrame + 1 ||
    session.arm_frame !== armFrame
  )
    problems.push("arm point must be the next capture frame");
  if (
    session.root_size !== "640x360" ||
    session.stream_version !== 8 ||
    session.arm_index !== armIndex ||
    typeof session.session_id !== "string" ||
    !session.session_id ||
    typeof session.listen !== "string" ||
    !LISTEN.test(session.listen) ||
    Number(session.listen.split(":")[1]) > 65535 ||
    session.token !== "" ||
    session.wt_cert_hash !== ""
  )
    problems.push("armed session info failed");
  return problems;
}

// Each connection id appears once as connected and once as left within its round.
function connectionIdProblems(events: Json[], expected: number): string[] {
  const connected = events.filter((e) => e.event === "client_connected");
  const left = events.filter((e) => e.event === "client_left");
  const ids = connected.map((e) => args(e)[0]);
  return new Set(ids).size !== expected ||
    ids.some(
      (id) =>
        typeof id !== "number" ||
        id <= 0 ||
        left.filter((e) => args(e)[0] === id).length !== 1,
    )
    ? ["view connection ids must match exactly once"]
    : [];
}

function inOrder(positions: number[]): boolean {
  return !positions.some((p, i) => p < 0 || (i > 0 && p <= positions[i - 1]));
}

// `evidence` is the capture-api.json taken at round 1's `disarmed` (the file is rewritten by every
// disarm); `finalEvidence` is the file as the run left it, which belongs to round 2.
export function apiOrderProblems(
  driver: Json,
  evidence: Json,
  finalEvidence?: Json,
): string[] {
  const problems = driverProblems(driver);
  const all = rows(driver.events);
  const cut = all.findIndex((e) => e.event === "disarmed");
  const events = cut < 0 ? all : all.slice(0, cut + 1);
  const round2 = cut < 0 ? [] : all.slice(cut + 1);
  const armed = events.find((e) => e.event === "armed") ?? {};
  const disarmed = events.find((e) => e.event === "disarmed") ?? {};
  const connected = events.filter((e) => e.event === "client_connected");
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
  if (!inOrder(positions))
    problems.push("scheduled arm/client/disarm signal order failed");
  for (const [name, expected] of Object.entries({
    armed: 2,
    arm_failed: 0,
    stream_ended: 0,
    client_connected: 3,
    client_left: 3,
    disarmed: 2,
    "arm-returned": 1,
    "disarm-returned": 1,
    "arm2-returned": 1,
    "disarm2-returned": 1,
  }))
    if (count(all, name) !== expected)
      problems.push(`${name}: expected exactly ${expected}`);
  if (
    driver.arm_code !== 0 ||
    args(all.find((e) => e.event === "arm-returned") ?? {})[0] !== 0 ||
    args(all.find((e) => e.event === "disarm-returned") ?? {})[0] !== 0
  )
    problems.push("arm/disarm call did not return OK");
  problems.push(
    ...sessionProblems(armed, 1, evidence.arm_frame, driver.arm_call_frame),
  );
  problems.push(...connectionIdProblems(events, 2));
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
  // Round 2: arm() after `disarmed`, a new carrier, one viewer, disarm.
  const armed2 = round2.find((e) => e.event === "armed") ?? {};
  const disarmed2 = round2.find((e) => e.event === "disarmed") ?? {};
  const ws2 = round2.find(
    (e) => e.event === "client_connected" && carrier(e) === "ws",
  );
  const positions2 = [
    round2.findIndex((e) => e.event === "arm2-returned"),
    round2.indexOf(armed2),
    ws2 ? round2.indexOf(ws2) : -1,
    round2.findIndex((e) => e.event === "disarm2-returned"),
    round2.findIndex(
      (e) => e.event === "client_left" && args(e)[0] === args(ws2 ?? {})[0],
    ),
    round2.indexOf(disarmed2),
  ];
  if (!inOrder(positions2))
    problems.push("round 2 arm/client/disarm signal order failed");
  if (
    args(round2.find((e) => e.event === "arm2-returned") ?? {})[0] !== 0 ||
    args(round2.find((e) => e.event === "disarm2-returned") ?? {})[0] !== 0
  )
    problems.push("round 2 arm/disarm call did not return OK");
  const rounds = rows(driver.rounds);
  problems.push(
    ...sessionProblems(
      armed2,
      2,
      finalEvidence?.arm_frame,
      object(rounds[1]).arm_call_frame,
    ).map((problem) => `round 2: ${problem}`),
  );
  if (
    info(armed2).session_id === info(armed).session_id ||
    object(rounds[1]).viewer_listen !== info(armed2).listen
  )
    problems.push("round 2: new session and its own listener expected");
  problems.push(
    ...connectionIdProblems(round2, 1).map((problem) => `round 2: ${problem}`),
  );
  const result2 = info(disarmed2);
  if (
    result2.arm_index !== 2 ||
    result2.reason !== "fixture2" ||
    typeof result2.published !== "number" ||
    result2.published < 1 ||
    result2.clients_served !== 1 ||
    disarmed2.state_at !== "standby"
  )
    problems.push("round 2: disarmed info failed");
  const c2 = object(driver.carrier2);
  if (c2.index !== 2 || c2.started !== 1 || c2.stopped !== 1)
    problems.push(
      "round 2: the new gdswap carrier must register, start and stop once",
    );
  const final = object(driver.final);
  if (
    final.state !== "standby" ||
    final.can_arm !== true ||
    final.arm_count !== 2 ||
    final.clients !== 0 ||
    final.last_reason !== "fixture2" ||
    disarmed.state_at !== "standby"
  )
    problems.push("final state must be re-armable standby without clients");
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
  const cancelled = events.filter((e) => e.event === "disarmed");
  if (
    failed.length !== 1 ||
    args(failed[0])[0] !== "listen-bind" ||
    failed[0].state_at !== "standby" ||
    count(events, "armed") !== 0 ||
    count(events, "stream_ended") !== 0
  )
    problems.push("expected only arm_failed(listen-bind) in standby");
  // The re-arm cancelled at once (R12c) queues one `disarmed` that consumed no arm.
  if (
    cancelled.length !== 1 ||
    info(cancelled[0]).arm_index !== 0 ||
    info(cancelled[0]).published !== 0 ||
    cancelled[0].state_at !== "standby" ||
    events.indexOf(cancelled[0]) < events.indexOf(failed[0])
  )
    problems.push("cancelled re-arm must queue one disarmed with arm_index 0");
  const final = object(driver.final);
  if (
    final.state !== "standby" ||
    final.can_arm !== true ||
    final.arm_count !== 1 ||
    final.last_reason !== "listen-bind" ||
    evidence.state !== "standby" ||
    evidence.can_arm !== true ||
    evidence.last_reason !== "listen-bind"
  )
    problems.push(
      "failed arm must return to re-armable standby with listen-bind reason",
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
      "R12c",
      "R13",
    ]),
  );
  return problems;
}

const dims = (value: unknown): string =>
  Array.isArray(value) ? value.join("x") : "unreadable";

// The root Window's min_size: the arm's GRC_ROOT_SIZE=presentation writes 640x360 while armed and
// the disarm puts back what the Window held before that arm (teardown.json says so as well).
export function rootMinSizeProblems(
  driver: Json,
  teardown1: Json,
  teardown2: Json,
): string[] {
  const problems: string[] = [];
  const rounds = rows(driver.rounds);
  if (rounds.length !== 2) return ["driver.json rounds must hold two rounds"];
  const original = dims(rounds[0].min_size_before);
  if (original === "unreadable" || original === "640x360")
    problems.push(`round 1: min_size before the arm is ${original}`);
  rounds.forEach((round, i) => {
    const n = i + 1;
    if (dims(round.min_size_armed) !== "640x360")
      problems.push(
        `round ${n}: min_size while armed is ${dims(round.min_size_armed)}, expected 640x360`,
      );
    if (dims(round.min_size_before) !== original)
      problems.push(
        `round ${n}: min_size before the arm is ${dims(round.min_size_before)}, expected ${original}`,
      );
    if (dims(round.min_size_after) !== original)
      problems.push(
        `round ${n}: min_size after the disarm is ${dims(round.min_size_after)}, expected ${original}`,
      );
  });
  for (const [n, td] of [
    [1, teardown1],
    [2, teardown2],
  ] as const) {
    const root = object(td.root_min_size);
    if (root.restore !== "restored" || root.written !== true)
      problems.push(
        `arm ${n} teardown.json root_min_size.restore is ${String(root.restore)}, expected restored`,
      );
  }
  return problems;
}

// Every honest-disarm accounting rule of the teardown contract, for one teardown.json.
export function teardownProblems(td: Json, armIndex: number): string[] {
  const problems: string[] = [];
  const mirror = object(td.mirror);
  const meta = object(td.item_meta);
  const zero: [string, unknown][] = [
    ["mirror.items", mirror.items],
    ["mirror.textures", mirror.textures],
    ["mirror.meshes", mirror.meshes],
    ["mirror.texture_payload_bytes", mirror.texture_payload_bytes],
    ["mirror.mesh_payload_bytes", mirror.mesh_payload_bytes],
    ["mirror.held_bytes", mirror.held_bytes],
    ["served_sets", td.served_sets],
    ["served_bytes", td.served_bytes],
    ["warm_cache_bytes", td.warm_cache_bytes],
    ["hubs", td.hubs],
    ["carrier_sets", td.carrier_sets],
    ["resource_log_held", td.resource_log_held],
    ["mesh_buffers", td.mesh_buffers],
    ["adopt_held", td.adopt_held],
    ["item_meta.host_held", meta.host_held],
    ["item_meta.filter_watches", meta.filter_watches],
  ];
  for (const [name, value] of zero)
    if (value !== 0) problems.push(`${name}=${String(value)}, expected 0`);
  if (
    typeof mirror.canvases !== "number" ||
    mirror.canvases < 0 ||
    mirror.canvases > 1
  )
    problems.push(`mirror.canvases=${String(mirror.canvases)}, expected <= 1`);
  for (const [name, expected] of [
    ["writer_joined", true],
    ["texture_workers_running", false],
    ["encode_workers_running", false],
    ["track_hub", false],
    ["publisher", false],
  ] as const)
    if (td[name] !== expected)
      problems.push(`${name}=${String(td[name])}, expected ${expected}`);
  if (td.arm_index !== armIndex)
    problems.push(`arm_index=${String(td.arm_index)}, expected ${armIndex}`);
  if (td.fault !== "")
    problems.push(`fault=${String(td.fault)}, expected none`);
  return problems.map((problem) => `arm ${armIndex} teardown.json ${problem}`);
}

// The loader thread (RS_SWAP_LOADER_THREAD=1) creates and frees textures from the first `armed`
// to the end, across both disarms; every create is held in flight while armed.
export function rearmInflightProblems(
  driver: Json,
  teardown1: Json,
  teardown2: Json,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(driver.timeouts) || driver.timeouts.length)
    problems.push("driver timed out");
  const loader = object(driver.loader);
  const samples = object(loader.samples);
  const inflight = object(loader.inflight);
  if (loader.enabled !== true) problems.push("loader thread was not enabled");
  if (loader.errors !== 0) problems.push("loader creates returned no RID");
  // A create may begin after `armed` or already be in flight when `armed` is sampled.
  for (const [n, from, to, held] of [
    [1, samples.armed1, samples.disarm_call1, inflight.armed1],
    [2, samples.armed2, samples.disarm_call2, inflight.armed2],
  ] as const)
    if (
      !(typeof from === "number" && typeof to === "number" && to > from) &&
      !(typeof held === "number" && held > 0)
    )
      problems.push(
        `round ${n}: no loader texture create was begun or in flight while armed`,
      );
  if (typeof loader.creates !== "number" || loader.creates <= 0)
    problems.push("loader created no texture");
  const final = object(driver.final);
  if (final.state !== "standby" || final.arm_count !== 2)
    problems.push("both rounds must complete");
  problems.push(
    ...teardownProblems(teardown1, 1),
    ...teardownProblems(teardown2, 2),
  );
  // Non-vacuity: a write was in flight at each release and the release waited it out (the hold
  // is 4 s, an arm lasts about 2 s).
  for (const [n, td] of [
    [1, teardown1],
    [2, teardown2],
  ] as const) {
    if (
      typeof td.inflight_wait_frames !== "number" ||
      td.inflight_wait_frames <= 0
    )
      problems.push(
        `arm ${n} waited ${String(td.inflight_wait_frames)} frames: no write was in flight to wait for`,
      );
    if (td.inflight_wait_timeout !== false)
      problems.push(
        `arm ${n}: in-flight wait timed out or timeout evidence missing`,
      );
  }
  return problems;
}

export function quitPendingProblems(
  driver: Json,
  teardown: Json,
  exit: string,
  log: string,
): string[] {
  const problems: string[] = [];
  if (exit !== "0") problems.push("quit-pending host did not exit 0");
  if (object(driver.quit_pending).state !== "disarming")
    problems.push("quit did not hold teardown pending");
  if (
    object(teardown.root_min_size).written !== true ||
    object(teardown.root_min_size).restore !== "root-gone"
  )
    problems.push(
      "shutdown did not report root-gone after a root min_size write",
    );
  if (teardown.root_finalized !== true)
    problems.push("teardown did not run after root finalization");
  const marker = log.indexOf("shutdown: root-finalized");
  if (marker < 0 || log.slice(marker).includes("root-call:"))
    problems.push("missing shutdown marker or root call after shutdown");
  return problems;
}

export function admissionProblems(
  driver: Json,
  teardown1: Json,
  teardown2: Json,
  exit: string,
  mode: "standby" | "counted" | "sabotage" | "hot-sabotage",
  adoptedCode: string,
): string[] {
  const problems: string[] = [];
  if (exit !== "0") problems.push("admission host did not exit 0");
  if (!Array.isArray(driver.timeouts) || driver.timeouts.length)
    problems.push("admission driver timed out");
  const events = rows(driver.events);
  if (
    events.map((e) => `${e.event}:${e.arm}`).join(",") !==
    "armed:1,disarmed:1,armed:2,disarmed:2"
  )
    problems.push("both admission rounds must complete in order");
  if (
    object(driver.final).state !== "standby" ||
    object(driver.final).arm_count !== 2
  )
    problems.push(
      "admission final state is not armable standby after two arms",
    );
  if (object(driver.admission).counted !== (mode === "counted"))
    problems.push("wrong admission decision or missing marker");
  for (const [arm, td] of [
    [1, teardown1],
    [2, teardown2],
  ] as const) {
    if (td.inflight_wait_timeout !== false)
      problems.push(`arm ${arm}: in-flight wait timeout or missing evidence`);
    const accesses = td.uncounted_arm_accesses;
    if (
      typeof accesses !== "number" ||
      !Number.isInteger(accesses) ||
      accesses < 0 ||
      (mode !== "sabotage" && mode !== "hot-sabotage" && accesses !== 0)
    )
      problems.push(
        `arm ${arm}: unsafe uncounted arm accesses=${String(accesses)}`,
      );
  }
  if (
    mode === "standby" &&
    (driver.held_at_arm2 !== true || driver.held_at_release !== true)
  )
    problems.push("standby hold did not span arm 2 arm, disarm and Release");
  if (mode === "counted") {
    if (object(driver.free_admission).counted !== true)
      problems.push("registered RID free was not held counted");
    if (
      typeof teardown1.inflight_max !== "number" ||
      teardown1.inflight_max < 3 ||
      typeof teardown1.inflight_wait_frames !== "number" ||
      teardown1.inflight_wait_frames < 1
    )
      problems.push("Release did not wait for all three counted calls");
    if (
      teardown1.held_free_registered !== false ||
      teardown2.held_free_registered !== false
    )
      problems.push("freed RID remained in the registry for arm 2 adoption");
    if (
      adoptedCode !==
      "shader_type canvas_item; void fragment() { COLOR = vec4(0.75); }"
    )
      problems.push("arm 2 did not adopt shader code B");
  } else if (teardown2.inflight_max !== 0) {
    problems.push("Release counted the held standby invocation");
  }
  if (
    (mode === "sabotage" || mode === "hot-sabotage") &&
    !(
      typeof teardown2.uncounted_arm_accesses === "number" &&
      teardown2.uncounted_arm_accesses > 0
    )
  )
    problems.push("standby-view-off did not produce an unsafe access");
  if (object(driver.texture_admission).counted !== (mode === "counted"))
    problems.push("texture create admission marker missing or wrong");
  const hot = object(driver.texture_hot);
  if (mode !== "counted" && hot.raw_streaming !== true)
    problems.push("texture create did not read the armed hot line");
  if (hot.streaming !== (mode === "sabotage" || mode === "hot-sabotage"))
    problems.push("texture hot-line admission mask wrong or missing");
  return problems;
}

export async function runApiChecks(out: string): Promise<G8aCheck[]> {
  const dir = join(out, "g8l/api");
  if (!existsSync(dir)) return [];
  const load = async (leg: string) => {
    const path = join(dir, leg);
    const driver = object(await readJson(join(path, "driver/driver.json")));
    const file = object(
      await readJson(join(path, "evidence/capture-api.json")),
    );
    // capture-api.json is rewritten by each disarm; round 1's copy is what the driver took at
    // its `disarmed`. A leg with one round (arm-failed) judges the file itself.
    const first = object(object(rows(driver.rounds)[0]).capture_api);
    return {
      driver,
      evidence: Object.keys(first).length ? first : file,
      final: file,
      result: object(await readJson(join(path, "evidence/result.json"))),
      teardown1: object(await readJson(join(path, "evidence/teardown.json"))),
      teardown2: object(
        await readJson(join(path, "evidence/arm-2/teardown.json")),
      ),
      readers: object(
        await readJson(join(path, "evidence/reader-after-release.json")),
      ),
      exit: await exitCode(path),
    };
  };
  const waitCheck = async (common: string[] = []) => {
    const sab = await load("sabotage-skip-inflight-wait");
    return check(
      "g8l-sabotage-skip-inflight-wait-caught",
      "a skipped in-flight wait records prevented reads after release and exits cleanly",
      [
        ...common,
        ...(sab.exit === "0" ? [] : ["sabotage host did not exit 0"]),
        ...(!Array.isArray(sab.driver.timeouts) || sab.driver.timeouts.length
          ? ["sabotage driver timed out"]
          : []),
        ...(object(sab.driver.loader).enabled === true
          ? []
          : ["sabotage loader thread was not enabled"]),
        ...(typeof sab.readers.reader_after_release === "number" &&
        sab.readers.reader_after_release > 0
          ? []
          : ["reader_after_release missing or not positive"]),
        ...[1, 2].flatMap((n) => {
          const td = n === 1 ? sab.teardown1 : sab.teardown2;
          const proof = rows(sab.readers.arms).find((r) => r.arm_index === n);
          return td.fault === "skip-inflight-wait" &&
            td.inflight_wait_frames === 0 &&
            typeof proof?.reader_after_release === "number" &&
            proof.reader_after_release > 0
            ? []
            : [
                `arm ${n}: skipped wait or reader_after_release evidence missing`,
              ];
        }),
      ],
      `reader_after_release=${String(sab.readers.reader_after_release)}; arms=${JSON.stringify(sab.readers.arms)}`,
    );
  };
  if (
    existsSync(join(dir, "sabotage-skip-inflight-wait")) &&
    !existsSync(join(dir, "host")) &&
    !existsSync(join(dir, "rearm-inflight"))
  )
    return [await waitCheck()];
  const admissionChecks: G8aCheck[] = [];
  for (const [leg, mode] of [
    ["rearm-admission-standby", "standby"],
    ["rearm-admission-counted", "counted"],
    ["sabotage-standby-view-off", "sabotage"],
    ["sabotage-hot-view-off", "hot-sabotage"],
  ] as const) {
    const admitted = await load(leg);
    let code = "";
    try {
      code = readFileSync(
        join(dir, leg, "evidence/admission-adopted-code.txt"),
        "utf8",
      );
    } catch {}
    const skip = skipped(join(dir, leg));
    admissionChecks.push(
      check(
        `g8l-${leg}${mode === "sabotage" || mode === "hot-sabotage" ? "-caught" : ""}`,
        mode === "counted"
          ? "counted calls preserve shader updates and RID frees across disarm"
          : mode === "standby"
            ? "standby admission stays outside per-arm state across re-arm and Release"
            : mode === "hot-sabotage"
              ? "bypassing hot-line admission exposes an unsafe texture-create decision"
              : "disabling the standby view exposes unsafe uncounted arm accesses",
        skip
          ? [skip]
          : admissionProblems(
              admitted.driver,
              admitted.teardown1,
              admitted.teardown2,
              admitted.exit,
              mode,
              code,
            ),
        `inflight_max=${admitted.teardown1.inflight_max}/${admitted.teardown2.inflight_max}; wait_frames=${admitted.teardown1.inflight_wait_frames}; uncounted=${admitted.teardown1.uncounted_arm_accesses}/${admitted.teardown2.uncounted_arm_accesses}; freed_registered=${admitted.teardown2.held_free_registered}`,
      ),
    );
  }
  if (
    existsSync(join(dir, "rearm-admission-standby")) &&
    !existsSync(join(dir, "host")) &&
    !existsSync(join(dir, "rearm-quit-pending"))
  )
    return admissionChecks;
  const injectProblems = (driver: Json, evidence: Json): string[] => {
    const problems: string[] = [];
    for (const snapshot of [evidence, object(driver.arm_failed_capture)]) {
      if (snapshot.track_inject_prepared !== true)
        problems.push("failed arm never prepared the reference injector");
      if (snapshot.track_inject_pending !== false)
        problems.push("failed arm retained its unbound injector");
    }
    return problems;
  };
  if (existsSync(join(dir, "arm-failed-inject"))) {
    const failed = await load("arm-failed-inject");
    return [
      check(
        "g8l-api-arm-failed-inject",
        "listen-bind rollback discards its prepared injector",
        [
          ...(failed.exit === "0" ? [] : ["host did not exit 0"]),
          ...apiArmFailedProblems(
            failed.driver,
            failed.evidence,
            failed.result,
          ),
          ...injectProblems(failed.driver, failed.evidence),
        ],
      ),
    ];
  }
  const evidenceDir = await load("evidence-dir");
  const failure = object(evidenceDir.driver.evidence_dir_failure);
  const before = object(failure.before);
  const after = object(failure.after);
  const evidenceDirCheck = check(
    "g8l-rearm-evidence-dir",
    "an unusable arm directory refuses re-arm without overwriting prior evidence",
    [
      ...(evidenceDir.exit === "0" ? [] : ["evidence-dir host did not exit 0"]),
      ...(failure.reason === "evidence-dir"
        ? []
        : ["missing evidence-dir refusal"]),
      ...(object(evidenceDir.driver.final).state === "standby"
        ? []
        : ["not standby"]),
      ...["resources.jsonl", "teardown.json", "live.json"].flatMap((name) =>
        typeof before[name] === "string" &&
        before[name] !== "" &&
        before[name] === after[name]
          ? []
          : [`arm 1 ${name} changed or missing`],
      ),
    ],
  );
  if (
    existsSync(join(dir, "evidence-dir")) &&
    !existsSync(join(dir, "host")) &&
    !existsSync(join(dir, "rearm-quit-pending"))
  )
    return [evidenceDirCheck];
  // The focused iteration knob writes five independent runs; the full group writes one.
  const focused = existsSync(join(dir, "rearm-quit-pending-1"));
  const quitChecks: G8aCheck[] = [];
  for (const leg of focused
    ? [1, 2, 3, 4, 5].map((n) => `rearm-quit-pending-${n}`)
    : ["rearm-quit-pending"]) {
    const pending = await load(leg);
    let log = "";
    try {
      log = readFileSync(join(dir, leg, "stdout.log"), "utf8");
    } catch {}
    quitChecks.push(
      check(
        `g8l-${leg}`,
        "quitting during teardown never calls the finalized root",
        [
          ...quitPendingProblems(
            pending.driver,
            pending.teardown1,
            pending.exit,
            log,
          ),
          ...(pending.readers.reader_after_release === 0
            ? []
            : ["reader_after_release must be 0"]),
        ],
      ),
    );
  }
  if (focused) return quitChecks;
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
    if (leg === "arm-failed-ws")
      failedProblems.push(...injectProblems(failed.driver, failed.evidence));
  }
  const checks = [
    ...admissionChecks,
    ...quitChecks,
    evidenceDirCheck,
    check(
      "g8l-rearm-taps",
      "both arms retain their viewer stream and live-event taps",
      [
        ...common,
        ...["tap", "tap/arm-2"].flatMap((tap) =>
          ["stream-1.rs2", "live-1.jsonl"].flatMap((name) => {
            const path = join(dir, "host", tap, name);
            return existsSync(path) && readFileSync(path).length > 0
              ? []
              : [`missing or empty ${tap}/${name}`];
          }),
        ),
      ],
    ),
    check(
      "g8l-api-order",
      "scheduled arm, view connections and disarm obey the singleton contract",
      [...common, ...apiOrderProblems(host.driver, host.evidence, host.final)],
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
  checks.push(
    check(
      "g8l-root-min-size-restored",
      "each disarm puts the root Window's min_size back to its value before that arm",
      [
        ...common,
        ...rootMinSizeProblems(host.driver, host.teardown1, host.teardown2),
      ],
      `min_size ${JSON.stringify(rows(host.driver.rounds).map((r) => [r.min_size_before, r.min_size_armed, r.min_size_after]))}`,
    ),
  );
  for (const inflightLeg of ["rearm-inflight", "rearm-materialize"]) {
    const inflightDir = join(dir, inflightLeg);
    const inflightSkip = skipped(inflightDir);
    if (inflightSkip) {
      checks.push(
        check(
          `g8l-${inflightLeg}`,
          "a loader thread creating textures across both disarms leaves every teardown clean",
          [inflightSkip],
        ),
      );
    } else {
      const inflight = await load(inflightLeg);
      const loader = object(inflight.driver.loader);
      checks.push(
        check(
          `g8l-${inflightLeg}`,
          "a loader thread creating textures across both disarms leaves every teardown clean",
          [
            ...common,
            ...(inflight.exit === "0"
              ? []
              : ["rearm-inflight host did not exit 0"]),
            ...(inflight.readers.reader_after_release === 0
              ? []
              : ["reader_after_release must be 0"]),
            ...rearmInflightProblems(
              inflight.driver,
              inflight.teardown1,
              inflight.teardown2,
            ),
          ],
          `loader creates=${String(loader.creates)} samples=${JSON.stringify(loader.samples)} inflight=${JSON.stringify(loader.inflight)}`,
        ),
      );
    }
  }
  const waitSkip = skipped(join(dir, "sabotage-skip-inflight-wait"));
  if (waitSkip) {
    checks.push(
      check(
        "g8l-sabotage-skip-inflight-wait-caught",
        "the teardown accounting catches a release that does not wait for an in-flight write",
        [waitSkip],
      ),
    );
  } else {
    checks.push(await waitCheck(common));
  }
  const rootSkip = skipped(join(dir, "sabotage-skip-root-restore"));
  if (rootSkip) {
    checks.push(
      check(
        "g8l-sabotage-skip-root-restore-caught",
        "the root min_size check catches a disarm that does not restore it",
        [rootSkip],
      ),
    );
  } else {
    const sab = await load("sabotage-skip-root-restore");
    const rounds = rows(sab.driver.rounds);
    const caught =
      rootMinSizeProblems(sab.driver, sab.teardown1, sab.teardown2).length >
        0 &&
      dims(rounds[0]?.min_size_after) === "640x360" &&
      object(sab.teardown1.root_min_size).restore === "skipped";
    checks.push(
      check(
        "g8l-sabotage-skip-root-restore-caught",
        "the root min_size check catches a disarm that does not restore it",
        [
          ...common,
          ...(sab.exit === "0" ? [] : ["sabotage host did not exit 0"]),
          ...(!Array.isArray(sab.driver.timeouts) || sab.driver.timeouts.length
            ? ["sabotage driver timed out"]
            : []),
          ...(caught ? [] : ["fault was not detected by its matching check"]),
        ],
      ),
    );
  }
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
