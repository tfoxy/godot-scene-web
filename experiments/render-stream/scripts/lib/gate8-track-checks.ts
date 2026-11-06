// TRK2 (protocol/tracks-design.md, TRK2 row, "As built (TRK2)"): gate 8's g8l/trk checks. The legs
// (run-gate8.sh run_g8l_trk) run fixtures/track-input, a GDScript RenderStreamTrack receiver wired
// to the gsw-input/1 reference injector, under scripts/lib/track-input-client.ts. Each leg leaves
// events.jsonl (the fixture: signals, the class contract and every watched Input change, each with
// its process frame), client.json (what the client was sent and saw) and the host's evidence.
//
// Latency (Q4 "Timing", Q6 "Flush"): the hub drains in the capture's frame callback, after
// RenderingServer::draw, and the class emits there, so an input event parsed in a signal handler
// of iteration N is applied at iteration N+1's flush_buffered_events(). The checks pin that: every
// Input change the fixture's _process sees is exactly one process frame after the signal that
// caused it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  check,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import {
  TRK_CAP_SUBJECT,
  TRK_CLICK,
  TRK_CLIENT,
  TRK_KEYS,
  TRK_TARGET,
  TRK_VIEW,
  type TrkClient,
  type TrkEvent,
  type TrkPhase,
} from "./track-input-client";

/** run-gate8.sh G8L_TRK_KEEPALIVE_MS. */
export const TRK_KEEPALIVE_MS = 250;

/** run-gate8.sh G8L_TRK_SABOTAGES, each with the one check that must catch it. */
export const TRK_SABOTAGES = {
  "no-release": "release-on-kill",
  "drop-messages": "delivered",
  "keep-held": "release-on-idle",
  "stay-bound": "no-receiver",
} as const;
export type TrkCheck = (typeof TRK_SABOTAGES)[keyof typeof TRK_SABOTAGES];

export interface TrkLeg {
  events: TrkEvent[];
  client?: TrkClient;
  tracks?: {
    tracks?: Record<
      string,
      {
        bound?: boolean;
        opened?: number;
        closed?: number;
        refused?: Record<string, number>;
        closes?: Record<string, number>;
      }
    >;
  };
  exit?: string;
}

export async function loadTrkLeg(dir: string): Promise<TrkLeg> {
  return {
    events: jsonl<TrkEvent>(await readText(join(dir, "events.jsonl"))),
    client: await readJson<TrkClient>(join(dir, "client.json")),
    tracks: await readJson<TrkLeg["tracks"]>(
      join(dir, "evidence", "live-tracks.json"),
    ),
    exit: (await readText(join(dir, "exit-code.txt")))?.trim(),
  };
}

/** Key-order-free JSON (Godot's JSON.stringify sorts Dictionary keys). */
function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x !== null && typeof x === "object")
    return `{${Object.keys(x)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(x);
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/** The index of the first event matching `pred` after `from`, or -1. */
function find(
  events: TrkEvent[],
  pred: (e: TrkEvent) => boolean,
  from = 0,
): number {
  for (let i = from; i < events.length; i++) if (pred(events[i])) return i;
  return -1;
}

const isKey = (code: number, pressed: boolean) => (e: TrkEvent) =>
  e.ev === "key" && e.key === code && e.pressed === pressed;
const isClosed = (source: number) => (e: TrkEvent) =>
  e.ev === "closed" && e.source === source;

/** The last signal event (message or closed) of `source` logged before index `at`. */
function causeOf(
  events: TrkEvent[],
  at: number,
  source: number,
): TrkEvent | undefined {
  for (let i = at - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.ev === "message" || e.ev === "closed") && e.source === source)
      return e;
  }
  return undefined;
}

/** `what` changed exactly one process frame after the signal that caused it (Q4 "Timing"). */
function nextFrame(
  events: TrkEvent[],
  at: number,
  source: number,
  what: string,
  problems: string[],
): void {
  if (at < 0) return;
  const cause = causeOf(events, at, source);
  if (!cause) {
    problems.push(`${what}: no signal of source ${source} before it`);
    return;
  }
  const d = events[at].frame - cause.frame;
  if (d !== 1)
    problems.push(
      `${what} at frame ${events[at].frame}, ${d} frame(s) after its ${cause.ev} (frame ${cause.frame}), expected 1`,
    );
}

function phaseOf(
  leg: TrkLeg,
  name: keyof TrkClient["phases"],
  problems: string[],
): TrkPhase | undefined {
  if (!leg.client) {
    problems.push("client.json missing");
    return undefined;
  }
  for (const p of leg.client.problems ?? []) problems.push(p);
  const phase = leg.client.phases?.[name];
  if (!phase) problems.push(`client.json has no ${name} phase`);
  return phase;
}

function readyOk(phase: TrkPhase, source: number, problems: string[]): void {
  const r = phase.ready;
  if (!r) {
    problems.push(`no track-ready (${JSON.stringify(phase.error)})`);
    return;
  }
  if (
    r.source !== source ||
    r.kind !== "input" ||
    r.format !== "gsw-input/1" ||
    r.down_format !== null
  )
    problems.push(`track-ready ${JSON.stringify(r)}`);
  if (r.keepalive_ms !== TRK_KEEPALIVE_MS)
    problems.push(`keepalive_ms ${r.keepalive_ms}`);
}

/** The receiver's `closed` for `source`: exactly once, with `code` (and `reason` when given). */
function closedOnce(
  events: TrkEvent[],
  source: number,
  code: number,
  reason: string | null,
  problems: string[],
): number {
  const all = events.filter(isClosed(source));
  if (all.length !== 1)
    problems.push(
      `${all.length} closed signal(s) for source ${source}, expected 1`,
    );
  const at = find(events, isClosed(source));
  if (at >= 0) {
    const e = events[at];
    if (e.code !== code || (reason !== null && e.reason !== reason))
      problems.push(
        `source ${source} closed ${e.code} ${JSON.stringify(e.reason)}, expected ${code} ${reason ?? ""}`,
      );
  }
  return at;
}

/** A key held by `source`, then a `closed`, then the key up exactly one frame later. */
function releasedAfterClose(
  events: TrkEvent[],
  source: number,
  code: number,
  closedAt: number,
  problems: string[],
): void {
  const down = find(events, isKey(code, true));
  if (down < 0) {
    problems.push(`key ${code} never went down`);
    return;
  }
  const up = find(events, isKey(code, false), down);
  if (up < 0) {
    problems.push(`key ${code} still held at the end of the run (no release)`);
    return;
  }
  if (closedAt < 0 || up < closedAt) {
    problems.push(`key ${code} went up before the track's closed signal`);
    return;
  }
  nextFrame(events, up, source, `key ${code} up`, problems);
}

/** TRK6: the facts the observer fixture logs about the built-in injector (delivered). */
function injectContract(leg: TrkLeg, inject: TrkInject): string[] {
  const problems: string[] = [];
  const ev = leg.events;
  const contract: Record<string, unknown> =
    ev.find((e) => e.ev === "contract") ?? {};
  const want: Record<string, unknown> = {
    mode: "builtin",
    project_addon: inject.addon,
    project_injector: inject.addon,
  };
  for (const [k, v] of Object.entries(want))
    if (!same(contract[k], v))
      problems.push(
        `contract.${k} ${JSON.stringify(contract[k])}, expected ${JSON.stringify(v)}`,
      );
  const builtin = ev.find((e) => e.ev === "builtin");
  if (!builtin) {
    problems.push(
      "no RsTrackInputInjector node under the root (the capture did not bind a built-in injector)",
    );
  } else {
    const node: Record<string, unknown> = {
      name: "RsTrackInputInjector",
      in_tree: true,
      parent: "/root",
      sha256: inject.sha256,
    };
    for (const [k, v] of Object.entries(node))
      if (!same(builtin[k], v))
        problems.push(
          `builtin.${k} ${JSON.stringify(builtin[k])}, expected ${JSON.stringify(v)}`,
        );
  }
  const probe = ev.find((e) => e.ev === "bind_probe");
  if (
    builtin &&
    !same(probe && { ok: probe.ok, error: probe.error }, {
      ok: false,
      error: "track-kind-bound",
    })
  )
    problems.push(
      `a script bind of input gave ${JSON.stringify(probe ?? null)}, expected track-kind-bound`,
    );
  return problems;
}

/** SHA-256 of packages/input/godot/addons/gsw_input/*.gd in name order (the embed's inputs). */
export function expectedAddonSha256(): string {
  const dir = fileURLToPath(
    new URL(
      "../../../../packages/input/godot/addons/gsw_input/",
      import.meta.url,
    ),
  );
  const h = createHash("sha256");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".gd"))
    .sort())
    h.update(readFileSync(join(dir, f)));
  return h.digest("hex");
}

/** TRK6: the leg ran fixtures/track-inject (or -addon) against the built-in injector. */
export interface TrkInject {
  /** The project ships the gsw_input addon (fixtures/track-inject-addon). */
  addon: boolean;
  /** The SHA-256 of the addon sources (expectedAddonSha256). */
  sha256: string;
}

export function judgeTrk(
  leg: TrkLeg,
  which: TrkCheck,
  subject = "",
  inject?: TrkInject,
): string[] {
  const problems: string[] = [];
  const ev = leg.events;
  if (ev.length === 0) return ["events.jsonl missing or empty"];
  if (leg.exit !== "0") problems.push(`host exit ${leg.exit ?? "missing"}`);
  const contract = ev.find((e) => e.ev === "contract");
  if (!contract?.exists)
    return [...problems, "RenderStreamTrack is not registered"];
  if (which === "delivered") {
    if (inject) problems.push(...injectContract(leg, inject));
    // The class contract before the arm (tracks-design.md Q6 table, "As built (TRK2)").
    const want: Record<string, unknown> = inject
      ? {}
      : {
          status_unbound: "unbound",
          bad_kind: { error: "track-kind-invalid", ok: false },
          bad_formats: { error: "track-formats-invalid", ok: false },
          no_formats: { error: "track-formats-invalid", ok: false },
          bound: { error: "", ok: true },
          again: { error: "track-already-bound", ok: false },
          other: { error: "track-kind-bound", ok: false },
          status_bound: "waiting",
          close_reason_refused: true,
          send_unknown_refused: true,
          sources_empty: true,
        };
    for (const [k, v] of Object.entries(want))
      if (!same(contract[k], v))
        problems.push(
          `contract.${k} ${JSON.stringify(contract[k])}, expected ${JSON.stringify(v)}`,
        );
    const statuses = ev.filter((e) => e.ev === "status").map((e) => e.status);
    if (!inject && !same(statuses.slice(0, 2), ["waiting", "serving"]))
      problems.push(
        `status ${JSON.stringify(statuses)} does not start waiting, serving`,
      );
    const phase = phaseOf(leg, "delivered", problems);
    if (!phase) return problems;
    readyOk(phase, 1, problems);
    for (const [k, v] of Object.entries(phase.waits))
      if (!v) problems.push(`client wait ${k} timed out`);
    const opened = find(ev, (e) => e.ev === "opened" && e.source === 1);
    if (opened < 0) return [...problems, "no opened signal for source 1"];
    const info = {
      carrier: "ws",
      client: TRK_CLIENT,
      down_format: null,
      format: "gsw-input/1",
      kind: "input",
      origin: "",
      subject,
      view: TRK_VIEW,
    };
    const o = ev[opened];
    const got = (o.info ?? {}) as Record<string, unknown>;
    const keys = Object.keys(info) as (keyof typeof info)[];
    if (
      Object.keys(got).length !== keys.length ||
      keys.some((k) => !same(got[k], info[k]))
    )
      problems.push(`opened info ${JSON.stringify(o.info)}`);
    // The built-in receiver's sources are not reachable from script: no info() / sources().
    if (!inject && !same(o.info_call, o.info))
      problems.push(
        `info(1) ${JSON.stringify(o.info_call)} differs from the signal's`,
      );
    if (!inject && !same(o.sources, [1]))
      problems.push(
        `sources() ${JSON.stringify(o.sources)} in opened, expected [1]`,
      );
    const messages = ev.filter((e) => e.ev === "message" && e.source === 1);
    if (messages.length !== phase.sent)
      problems.push(
        `${messages.length} message signals for source 1, the client sent ${phase.sent} payloads`,
      );
    const bad = messages.filter((m) => m.result !== "");
    if (bad.length > 0)
      problems.push(
        `injector refused ${bad.length} message(s): ${bad.map((m) => m.result).join(",")}`,
      );
    const firstMessage = find(ev, (e) => e.ev === "message" && e.source === 1);
    const closedAt = closedOnce(ev, 1, 1000, null, problems);
    if (firstMessage >= 0 && firstMessage < opened)
      problems.push("a message before opened");
    if (
      closedAt >= 0 &&
      ev.slice(closedAt).some((e) => e.ev === "message" && e.source === 1)
    )
      problems.push("a message after closed");
    // A key press and release reach Input, one frame after their messages.
    const down = find(ev, isKey(TRK_KEYS.W, true));
    const up = find(ev, isKey(TRK_KEYS.W, false), Math.max(down, 0));
    if (down < 0 || up < 0) problems.push(`key W down at ${down}, up at ${up}`);
    nextFrame(ev, down, 1, "key W down", problems);
    nextFrame(ev, up, 1, "key W up", problems);
    // A left click reaches Input's button mask and the test Control's gui_input at its local point.
    const local = [
      TRK_CLICK[0] - TRK_TARGET.left,
      TRK_CLICK[1] - TRK_TARGET.top,
    ];
    for (const pressed of [true, false]) {
      const g = find(ev, (e) => e.ev === "gui" && e.pressed === pressed);
      const m = find(ev, (e) => e.ev === "mouse" && e.pressed === pressed);
      if (g < 0)
        problems.push(
          `no gui_input ${pressed ? "press" : "release"} on the test Control`,
        );
      else {
        const e = ev[g];
        if (
          e.button !== 1 ||
          !same(e.position, local) ||
          !same(e.global, [...TRK_CLICK])
        )
          problems.push(
            `gui_input ${JSON.stringify(e)}, expected button 1 at ${JSON.stringify(local)}`,
          );
        nextFrame(
          ev,
          g,
          1,
          `gui_input ${pressed ? "press" : "release"}`,
          problems,
        );
      }
      if (m < 0)
        problems.push(
          `Input left button never ${pressed ? "pressed" : "released"}`,
        );
    }
    const t = leg.tracks?.tracks?.input;
    if (!t) problems.push("evidence/live-tracks.json has no tracks.input");
    else if (t.opened !== t.closed)
      problems.push(
        `live-tracks.json opened ${t.opened} != closed ${t.closed}`,
      );
    if (inject) {
      const live = (leg.tracks as Record<string, unknown> | undefined)?.inject;
      if (!same(live, { addon_sha256: inject.sha256, mode: "reference" }))
        problems.push(
          `live-tracks.json inject ${JSON.stringify(live ?? null)}, expected reference ${inject.sha256}`,
        );
    }
    return problems;
  }
  if (which === "release-on-kill") {
    const phase = phaseOf(leg, "kill", problems);
    if (!phase) return problems;
    readyOk(phase, 2, problems);
    const closedAt = closedOnce(ev, 2, 1006, "peer closed", problems);
    releasedAfterClose(ev, 2, TRK_KEYS.A, closedAt, problems);
    return problems;
  }
  if (which === "release-on-idle") {
    const phase = phaseOf(leg, "idle", problems);
    if (!phase) return problems;
    readyOk(phase, 3, problems);
    if (phase.close?.code !== 1001 || phase.close.reason !== "track-idle")
      problems.push(
        `the client's close ${JSON.stringify(phase.close)}, expected 1001 track-idle`,
      );
    if (
      !phase.controls.some(
        (c) => c.type === "track-error" && c.reason === "track-idle",
      )
    )
      problems.push("no track-error track-idle before the close");
    const closedAt = closedOnce(ev, 3, 1001, "track-idle", problems);
    if (closedAt >= 0) {
      const last = [...ev.slice(0, closedAt)]
        .reverse()
        .find((e) => e.ev === "message" && e.source === 3);
      const silent = last ? ev[closedAt].ms - last.ms : -1;
      // 3 x keepalive_ms of silence, give or take the frame the hub's tick and the flush ran in.
      if (
        silent < 3 * TRK_KEEPALIVE_MS - 50 ||
        silent > 3 * TRK_KEEPALIVE_MS + 1000
      )
        problems.push(
          `idle close ${silent} ms after the last message, expected about ${3 * TRK_KEEPALIVE_MS}`,
        );
    }
    releasedAfterClose(ev, 3, TRK_KEYS.S, closedAt, problems);
    return problems;
  }
  // no-receiver
  const phase = phaseOf(leg, "no-receiver", problems);
  if (!phase) return problems;
  const unbound = find(ev, (e) => e.ev === "unbound");
  // The built-in receiver goes away by freeing its node (the capture reads the freed object as
  // track-receiver-gone and unbinds it); a script receiver calls unbind().
  const wantStatus = inject ? "freed" : "unbound";
  if (unbound < 0 || ev[unbound].status !== wantStatus)
    problems.push(
      `the fixture did not unbind (${JSON.stringify(ev[unbound] ?? null)}), expected ${wantStatus}`,
    );
  if (phase.ready)
    problems.push(`track-ready after unbind: ${JSON.stringify(phase.ready)}`);
  if (phase.error?.reason !== "track-no-receiver")
    problems.push(`track-error ${JSON.stringify(phase.error)}`);
  if (phase.close?.code !== 1013 || phase.close.reason !== "track-no-receiver")
    problems.push(
      `the client's close ${JSON.stringify(phase.close)}, expected 1013 track-no-receiver`,
    );
  if (unbound >= 0 && ev.slice(unbound).some((e) => e.ev === "opened"))
    problems.push("an opened signal after unbind");
  const t = leg.tracks?.tracks?.input;
  if (t?.refused?.["track-no-receiver"] !== 1)
    problems.push(
      `live-tracks.json refused ${JSON.stringify(t?.refused)}, expected track-no-receiver 1`,
    );
  if (t?.bound !== false)
    problems.push(`live-tracks.json bound ${t?.bound} at stop, expected false`);
  return problems;
}

const CRITERIA: Record<TrkCheck, string> = {
  delivered:
    "TRK2: a GDScript RenderStreamTrack receiver wired to the reference injector gets every payload of a track as one message signal between one opened and one closed (info: kind, format, client, view, carrier), and a key press/release and a left click reach Input and the test Control's gui_input at its local point, each exactly one process frame after its signal; the class contract before the arm (bind refusals kind-invalid, formats-invalid, kind-bound, already-bound; close and send refusals; status unbound, waiting, serving)",
  "release-on-kill":
    "TRK2: a client socket destroyed while it holds a key gives the receiver closed 1006 `peer closed`, and the key is up one frame later (the injector's close_channel)",
  "release-on-idle":
    "TRK2: a client that goes silent while it holds a key is closed 1001 track-idle (track-error first) after 3 x keepalive_ms, the receiver gets closed, and the key is up one frame later",
  "no-receiver":
    "TRK2: after the fixture's unbind(), a track hello is refused track-error track-no-receiver with close 1013, no opened signal follows, and live-tracks.json counts the refusal with the kind unbound",
};

/** Every g8l-trk check (TRK2, TRK5) and g8l-trk-inject check (TRK6). */
export async function runTrkChecks(out: string): Promise<G8aCheck[]> {
  return [...(await runScriptChecks(out)), ...(await runInjectChecks(out))];
}

/** The script receiver's checks, when g8l/trk exists (native only; run-gate8.sh run_g8l_trk). */
async function runScriptChecks(out: string): Promise<G8aCheck[]> {
  const root = join(out, "g8l", "trk");
  if (!existsSync(root)) return [];
  const checks: G8aCheck[] = [];
  const absent = (dir: string) => {
    const s = skipped(dir);
    if (s) return `${s}: ${dir}`;
    return existsSync(join(dir, "events.jsonl")) ? null : `missing: ${dir}`;
  };
  const host = join(root, "host");
  const honest = absent(host) ? null : await loadTrkLeg(host);
  for (const which of Object.values(TRK_SABOTAGES)) {
    const problems = honest ? judgeTrk(honest, which) : null;
    checks.push(
      check(
        `g8l-trk-${which}`,
        CRITERIA[which],
        problems,
        "held on g8l/trk/host",
      ),
    );
  }
  // TRK5: the same four phases with GRC_LIVE_TRACK_CAPS=hmac and a minted capability.
  const capsDir = join(root, "caps");
  if (existsSync(capsDir)) {
    let problems: string[] | null = null;
    if (!absent(capsDir)) {
      const leg = await loadTrkLeg(capsDir);
      problems = judgeTrk(leg, "delivered", TRK_CAP_SUBJECT);
      const ev = join(capsDir, "evidence");
      const keyFile = join(ev, "live-track-cap-key");
      const key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
      const mode = existsSync(keyFile) ? statSync(keyFile).mode & 0o777 : 0;
      if (!/^[0-9a-f]{64}$/.test(key) || mode !== 0o600)
        problems.push(
          `live-track-cap-key: ${key.length} chars, mode ${mode.toString(8)}`,
        );
      if (existsSync(join(ev, "live-track-input-token")))
        problems.push(
          "a shared live-track-input-token beside the capability key",
        );
      const caps = (leg.tracks as Record<string, unknown> | null)?.caps;
      if (caps !== "hmac")
        problems.push(`live-tracks.json caps ${JSON.stringify(caps)}`);
    }
    checks.push(
      check(
        "g8l-trk-caps",
        "TRK5: with GRC_LIVE_TRACK_CAPS=hmac the capture writes live-track-cap-key (64 hex, mode 0600) and no shared token, a capability minted by scripts/lib/track-cap.ts opens the track, and the GDScript receiver's opened info (signal and info()) carries its `sub` as `subject`, with every g8l-trk-delivered criterion holding",
        problems,
        `held on g8l/trk/caps, subject ${TRK_CAP_SUBJECT}`,
      ),
    );
  }
  for (const [sabotage, which] of Object.entries(TRK_SABOTAGES)) {
    const dir = join(root, `sabotage-${sabotage}`);
    let problems: string[] | null = null;
    let caught = "";
    if (!absent(dir)) {
      const leg = await loadTrkLeg(dir);
      // Only the predicate's own findings count: a client that gave up is not a catch.
      const found = judgeTrk(leg, which as TrkCheck).filter(
        (p) => !p.startsWith("client: "),
      );
      caught = found[0] ?? "";
      problems =
        found.length === 0
          ? [
              `g8l-trk-${which} passed on the ${sabotage} sabotage (the check is blind)`,
            ]
          : found.some((p) => /missing|not registered/.test(p))
            ? found
            : [];
    }
    checks.push(
      check(
        `g8l-trk-sabotage-${sabotage}`,
        `TRK2 sabotage: g8l-trk-${which} fails when ${sabotage === "no-release" ? "the capture's GRC_SABOTAGE=track-no-release drops the closed() of a killed track" : `the fixture's RS_TRACK_INPUT_SABOTAGE=${sabotage} is on`}`,
        problems,
        `g8l-trk-${which} failed as it must: ${caught}`,
      ),
    );
  }
  return checks;
}

// --- TRK6: the built-in injector (GRC_LIVE_TRACK_INPUT_INJECT=reference) -------------------------

/** run-gate8.sh G8L_INJECT_SABOTAGES, each with the one check that must catch it. */
export const TRK_INJECT_SABOTAGES = {
  "no-release": "release-on-kill",
  off: "delivered",
} as const;

/** run-gate8.sh run_g8l_inject_refusal legs: the reason each must give (live.json `reason`). */
export const TRK_INJECT_REFUSALS: Record<string, string> = {
  "refuse-value": "track-inject-invalid: GRC_LIVE_TRACK_INPUT_INJECT=bogus",
  "refuse-no-grant": "track-inject-invalid: ",
  "refuse-config-key": "track-inject-config-invalid: ",
  "refuse-config-json": "track-inject-config-invalid: ",
  "refuse-config-alone": "track-inject-config-invalid: ",
  "refuse-sabotage": "sabotage track-inject-no-release needs ",
};

/** run-gate8.sh G8L_INJECT_CONFIG: accept_kinds drops everything but key records. */
const INJECT_CONFIG_ACCEPTS = "key";

/** The config leg: the injector got GRC_LIVE_TRACK_INPUT_CONFIG (clicks dropped, keys applied). */
export function judgeInjectConfig(leg: TrkLeg, inject: TrkInject): string[] {
  const problems: string[] = [];
  const ev = leg.events;
  if (ev.length === 0) return ["events.jsonl missing or empty"];
  if (leg.exit !== "0") problems.push(`host exit ${leg.exit ?? "missing"}`);
  problems.push(
    ...injectContract(leg, inject).filter((p) => !p.startsWith("contract.")),
  );
  if (ev.some((e) => e.ev === "gui" || e.ev === "mouse"))
    problems.push(
      `a pointer event reached the game under accept_kinds [${INJECT_CONFIG_ACCEPTS}]`,
    );
  const down = find(ev, isKey(TRK_KEYS.W, true));
  const up = find(ev, isKey(TRK_KEYS.W, false), Math.max(down, 0));
  if (down < 0 || up < 0)
    problems.push(`key W down at ${down}, up at ${up} (keys are accepted)`);
  nextFrame(ev, down, 1, "key W down", problems);
  closedOnce(ev, 1, 1000, null, problems);
  const live = (leg.tracks as Record<string, unknown> | undefined)?.inject;
  if (!same(live, { addon_sha256: inject.sha256, mode: "reference" }))
    problems.push(`live-tracks.json inject ${JSON.stringify(live ?? null)}`);
  return problems;
}

const INJECT_CRITERIA: Record<TrkCheck, string> = {
  delivered:
    "TRK6: with GRC_LIVE_TRACK_INPUT_INJECT=reference a stock project (no script receiver, no gsw_input addon) gets a key press/release and a left click from a track, each exactly one process frame after the signal the built-in receiver got; the capture added RsTrackInputInjector under the root, a script bind of `input` is refused track-kind-bound, the opened info and the injector's per-message results are TRK2's, and live-tracks.json says inject reference with the addon digest",
  "release-on-kill":
    "TRK6: a client socket destroyed while it holds a key gives the built-in receiver closed 1006 `peer closed`, and the key is up one frame later (release-on-close identical to the script path)",
  "release-on-idle":
    "TRK6: a silent client holding a key is closed 1001 track-idle after 3 x keepalive_ms, the built-in receiver gets closed, and the key is up one frame later",
  "no-receiver":
    "TRK6: after the injector node is freed, a track hello is refused track-no-receiver with close 1013 (the capture reads the freed receiver as gone and unbinds it), no opened signal follows, and live-tracks.json counts the refusal with the kind unbound",
};

/** The addon digest the legs must report: expectedAddonSha256() of the committed sources. */
export async function runInjectChecks(out: string): Promise<G8aCheck[]> {
  const root = join(out, "g8l", "inject");
  if (!existsSync(root)) return [];
  const checks: G8aCheck[] = [];
  const sha256 = expectedAddonSha256();
  const absent = (dir: string) => {
    const s = skipped(dir);
    if (s) return `${s}: ${dir}`;
    return existsSync(join(dir, "events.jsonl")) ? null : `missing: ${dir}`;
  };
  const stock: TrkInject = { addon: false, sha256 };
  const host = join(root, "host");
  const honest = absent(host) ? null : await loadTrkLeg(host);
  for (const which of Object.values(TRK_SABOTAGES)) {
    checks.push(
      check(
        `g8l-trk-inject-${which}`,
        INJECT_CRITERIA[which],
        honest ? judgeTrk(honest, which, "", stock) : null,
        "held on g8l/inject/host",
      ),
    );
  }
  // The project ships the addon: the embedded copy loads beside the global GswInput* classes, and
  // the project's own injector still runs.
  const addonDir = join(root, "addon");
  {
    let problems: string[] | null = null;
    if (!absent(addonDir)) {
      const leg = await loadTrkLeg(addonDir);
      const withAddon: TrkInject = { addon: true, sha256 };
      problems = [];
      for (const which of Object.values(TRK_SABOTAGES))
        for (const p of judgeTrk(leg, which, "", withAddon))
          problems.push(`${which}: ${p}`);
    }
    checks.push(
      check(
        "g8l-trk-inject-addon",
        "TRK6: a project that ships the gsw_input addon itself (global classes GswInputInjector and the rest, its own instance still constructible) loads the embedded injector without the class_name collision (the embedded classes are renamed RsBuiltin*) and every g8l-trk-inject criterion holds on it",
        problems,
        "held on g8l/inject/addon: the project's addon and the built-in injector side by side",
      ),
    );
  }
  {
    const dir = join(root, "config");
    let problems: string[] | null = null;
    if (!absent(dir))
      problems = judgeInjectConfig(await loadTrkLeg(dir), stock);
    checks.push(
      check(
        "g8l-trk-inject-config",
        `TRK6: GRC_LIVE_TRACK_INPUT_CONFIG reaches the injector's configure(): with accept_kinds [${INJECT_CONFIG_ACCEPTS}] a key press/release still arrives and a left click never reaches Input or the Control`,
        problems,
        "held on g8l/inject/config",
      ),
    );
  }
  {
    // addon_sha256 in live-tracks.json, the node's own constant and the committed sources agree.
    const problems: string[] = [];
    if (!honest) problems.push("g8l/inject/host did not run");
    else {
      const live = (honest.tracks as Record<string, unknown> | undefined)
        ?.inject as { mode?: string; addon_sha256?: string } | undefined;
      const node = honest.events.find((e) => e.ev === "builtin");
      if (live?.mode !== "reference" || live.addon_sha256 !== sha256)
        problems.push(
          `live-tracks.json inject ${JSON.stringify(live ?? null)}, the committed sources hash to ${sha256}`,
        );
      if (node?.sha256 !== sha256)
        problems.push(
          `the node's ADDON_SHA256 ${JSON.stringify(node?.sha256)}, expected ${sha256}`,
        );
    }
    checks.push(
      check(
        "g8l-trk-inject-sha",
        "TRK6: live-tracks.json inject.addon_sha256 and the embedded script's ADDON_SHA256 equal the SHA-256 of packages/input/godot/addons/gsw_input/*.gd (name order) as committed",
        problems,
        `addon_sha256 ${sha256}`,
      ),
    );
  }
  {
    const problems: string[] = [];
    for (const [name, prefix] of Object.entries(TRK_INJECT_REFUSALS)) {
      const dir = join(root, name);
      const s = skipped(dir);
      if (s) {
        problems.push(`${s}: ${dir}`);
        continue;
      }
      const live = await readJson<Record<string, unknown>>(
        join(dir, "evidence", "live.json"),
      );
      if (!live) {
        problems.push(`${name}: evidence/live.json missing`);
        continue;
      }
      const reason = typeof live.reason === "string" ? live.reason : "";
      if (live.status !== "refused" || !reason.startsWith(prefix))
        problems.push(
          `${name}: live ${JSON.stringify(live.status)} ${JSON.stringify(reason)}, expected refused ${JSON.stringify(prefix)}`,
        );
      if (live.port !== null)
        problems.push(`${name}: a listener came up (port ${live.port})`);
      if (existsSync(join(dir, "evidence", "live-tracks.json")))
        problems.push(`${name}: live-tracks.json written for a refused arm`);
      if (existsSync(join(dir, "evidence", "live-track-input-token")))
        problems.push(`${name}: a track credential was written`);
    }
    checks.push(
      check(
        "g8l-trk-inject-refusals",
        "TRK6: a bad injection setting refuses live as a whole (live.json refused, no listener, no credential): an unknown INJECT value, INJECT without input granted, a CONFIG that is not JSON or that configure() rejects, CONFIG without INJECT, and the track-inject-no-release sabotage without INJECT",
        problems,
        `${Object.keys(TRK_INJECT_REFUSALS).length} refusals held`,
      ),
    );
  }
  for (const [sabotage, which] of Object.entries(TRK_INJECT_SABOTAGES)) {
    const dir = join(root, `sabotage-${sabotage}`);
    let problems: string[] | null = null;
    let caught = "";
    if (!absent(dir)) {
      const leg = await loadTrkLeg(dir);
      const found = judgeTrk(leg, which as TrkCheck, "", stock).filter(
        (p) => !p.startsWith("client: "),
      );
      caught = found[0] ?? "";
      problems =
        found.length === 0
          ? [
              `g8l-trk-inject-${which} passed on the ${sabotage} sabotage (the check is blind)`,
            ]
          : found.some((p) => /missing|not registered/.test(p))
            ? found
            : [];
    }
    checks.push(
      check(
        `g8l-trk-inject-sabotage-${sabotage}`,
        `TRK6 sabotage: g8l-trk-inject-${which} fails when ${sabotage === "no-release" ? "GRC_SABOTAGE=track-inject-no-release makes the built-in injector ignore closed()" : "the same fixture runs without GRC_LIVE_TRACK_INPUT_INJECT (no receiver: track-no-receiver)"}`,
        problems,
        `g8l-trk-inject-${which} failed as it must: ${caught}`,
      ),
    );
  }
  return checks;
}
