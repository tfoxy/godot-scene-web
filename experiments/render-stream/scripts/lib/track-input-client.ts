// TRK2 (protocol/tracks-design.md, TRK2 row): the Node track client of gate 8's g8l/trk legs
// (run-gate8.sh run_g8l_trk). It drives fixtures/track-input, a GDScript RenderStreamTrack
// receiver wired to the gsw-input/1 reference injector, through four phases against the real
// capture's live listener, waiting on the fixture's event log (RS_TRACK_INPUT_LOG) between steps:
//
//   1 delivered        track 1: gsw-input hello, key W down, a left click on the test Control
//                      (press, release), key W up, bye, client close 1000
//   2 release-on-kill  track 2: key A down, then the socket destroyed while A is held
//   3 release-on-idle  track 3: key S down, then nothing at all (no keepalive): the host closes
//                      1001 track-idle after 3 x keepalive_ms
//   4 no-receiver      the fixture unbinds (control file `unbind`), then track 4's hello is
//                      refused track-no-receiver with close 1013
//
// It never judges: every wait has a deadline and records what it saw in --out (client.json),
// and lib/gate8-live-checks.ts judges client.json with the fixture's log. Then it writes the
// control file `quit` so the fixture ends its run.
// Usage: tsx --conditions=development track-input-client.ts --port N --credential-file F
//          --events F --control DIR --out F [--keepalive-ms 250]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RawTrack, TRACK_SUBPROTOCOL } from "./raw-track-client";

/** The fixture's test Control (track_input.tscn `Target`) and the click point inside it. */
export const TRK_TARGET = {
  left: 100,
  top: 80,
  right: 220,
  bottom: 140,
} as const;
export const TRK_CLICK: readonly [number, number] = [160, 110];
export const TRK_KEYS = { W: 87, A: 65, S: 83 } as const;
export const TRK_CLIENT = "g8l-trk";
/** One step's deadline: about 180 frames at 60 fps (a change takes one or two). */
const WAIT_MS = 3000;
export const TRK_VIEW = {
  stream_id: "0123456789abcdef0123456789abcdef",
  connection: 1,
};

export interface TrkEvent {
  ev: string;
  frame: number;
  ms: number;
  [k: string]: unknown;
}

export interface TrkPhase {
  ready: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  close: { code: number; reason: string } | null;
  /** Every track-ready / track-error the host sent, in order. */
  controls: Record<string, unknown>[];
  /** Non-empty payload texts the client sent after track-ready. */
  sent: number;
  /** Each step: what it waited for and whether it came. */
  waits: Record<string, boolean>;
}

export interface TrkClient {
  schema: "g8l-trk-client/1";
  phases: Record<"delivered" | "kill" | "idle" | "no-receiver", TrkPhase>;
  problems: string[];
}

function argOf(argv: string[], name: string, fallback?: string): string {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`track-input-client: ${name} is required`);
}

export function readEvents(file: string): TrkEvent[] {
  if (!existsSync(file)) return [];
  const out: TrkEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as TrkEvent);
    } catch {
      // a line the fixture is still writing
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const port = Number(argOf(argv, "--port"));
  const credential = readFileSync(
    argOf(argv, "--credential-file"),
    "utf8",
  ).trim();
  const eventsFile = argOf(argv, "--events");
  const control = argOf(argv, "--control");
  const outFile = argOf(argv, "--out");
  const keepaliveMs = Number(argOf(argv, "--keepalive-ms", "250"));
  mkdirSync(control, { recursive: true });
  const problems: string[] = [];

  /** Waits until the fixture's log holds an event matching `pred`. */
  const until = async (
    pred: (e: TrkEvent) => boolean,
    ms: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (readEvents(eventsFile).some(pred)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(20);
    }
  };
  const key = (code: number, pressed: boolean) => (e: TrkEvent) =>
    e.ev === "key" && e.key === code && e.pressed === pressed;
  const closedOf = (source: number) => (e: TrkEvent) =>
    e.ev === "closed" && e.source === source;

  const epoch = 1000 + Math.floor(Math.random() * 1000);
  const open = async (
    source: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ track: RawTrack; phase: TrkPhase; seq: () => number }> => {
    const phase: TrkPhase = {
      ready: null,
      error: null,
      close: null,
      controls: [],
      sent: 0,
      waits: {},
    };
    const { status, track } = await RawTrack.open(port, TRACK_SUBPROTOCOL);
    if (!status.includes(" 101 ")) throw new Error(`track upgrade: ${status}`);
    track.send(
      JSON.stringify({
        type: "track-hello",
        protocol: "render-stream-track/1",
        kind: "input",
        formats: ["gsw-input/1"],
        down_formats: [],
        credential,
        client: TRK_CLIENT,
        view: null,
        ...extra,
      }),
    );
    await track.until(
      () => track.controls().length > 0 || track.ended,
      WAIT_MS,
    );
    const c = track.controls()[0] ?? null;
    phase.ready = c && c.type === "track-ready" ? c : null;
    phase.error = c && c.type === "track-error" ? c : null;
    let n = 0;
    if (phase.ready) {
      track.send(
        JSON.stringify({
          type: "hello",
          format: "gsw-input/1",
          source,
          epoch,
          seq: 0,
        }),
      );
      phase.sent++;
    }
    return { track, phase, seq: () => ++n };
  };
  const events = (
    t: { track: RawTrack; phase: TrkPhase; seq: () => number },
    records: Record<string, unknown>[],
  ) => {
    t.track.send(
      JSON.stringify({ type: "events", epoch, seq: t.seq(), events: records }),
    );
    t.phase.sent++;
  };
  const keyRecord = (code: number, pressed: boolean, name: string) => ({
    event: "key",
    physical_keycode: code,
    keycode: code,
    key_label: code,
    unicode: pressed ? code + 32 : 0,
    pressed,
    code: name,
  });
  const ending = (t: { track: RawTrack; phase: TrkPhase }) => {
    t.phase.close = t.track.closed;
    t.phase.controls = t.track.controls();
  };

  const phases = {} as TrkClient["phases"];
  try {
    // 1 delivered: the class turns each payload into one message signal, the injector applies it.
    const d = await open("trk-delivered", { view: TRK_VIEW });
    phases.delivered = d.phase;
    d.track.startKeepalive(Math.max(50, Math.floor(keepaliveMs / 3)));
    events(d, [keyRecord(TRK_KEYS.W, true, "KeyW")]);
    d.phase.waits.key_down = await until(key(TRK_KEYS.W, true), WAIT_MS);
    events(d, [
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [...TRK_CLICK],
        button_mask: 1,
      },
    ]);
    d.phase.waits.gui_press = await until(
      (e) => e.ev === "gui" && e.pressed === true,
      WAIT_MS,
    );
    events(d, [
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [...TRK_CLICK],
      },
    ]);
    d.phase.waits.gui_release = await until(
      (e) => e.ev === "gui" && e.pressed === false,
      WAIT_MS,
    );
    events(d, [keyRecord(TRK_KEYS.W, false, "KeyW")]);
    d.phase.waits.key_up = await until(key(TRK_KEYS.W, false), WAIT_MS);
    d.track.send(JSON.stringify({ type: "bye", epoch, seq: d.seq() }));
    d.phase.sent++;
    d.phase.waits.messages = await until(
      () =>
        readEvents(eventsFile).filter(
          (e) => e.ev === "message" && e.source === 1,
        ).length >= d.phase.sent,
      5000,
    );
    d.track.close(1000);
    d.phase.waits.closed = await until(closedOf(1), WAIT_MS);
    await d.track.until(() => d.track.ended, 2000);
    ending(d);
    d.track.destroy();

    // 2 release-on-kill: a held key and a socket that dies without a close frame.
    const k = await open("trk-kill");
    phases.kill = k.phase;
    k.track.startKeepalive(Math.max(50, Math.floor(keepaliveMs / 3)));
    events(k, [keyRecord(TRK_KEYS.A, true, "KeyA")]);
    k.phase.waits.key_down = await until(key(TRK_KEYS.A, true), WAIT_MS);
    ending(k);
    k.track.destroy();
    k.phase.waits.closed = await until(closedOf(2), WAIT_MS);
    k.phase.waits.key_up = await until(key(TRK_KEYS.A, false), 2000);

    // 3 release-on-idle: a held key, then silence; the host's idle close must release it.
    const i = await open("trk-idle");
    phases.idle = i.phase;
    events(i, [keyRecord(TRK_KEYS.S, true, "KeyS")]);
    i.phase.waits.key_down = await until(key(TRK_KEYS.S, true), WAIT_MS);
    i.phase.waits.host_close = await i.track.until(
      () => i.track.closed !== null || i.track.ended,
      3 * keepaliveMs + 5000,
    );
    ending(i);
    i.phase.waits.closed = await until(closedOf(3), WAIT_MS);
    i.phase.waits.key_up = await until(key(TRK_KEYS.S, false), 2000);
    i.track.destroy();

    // 4 no-receiver: the fixture unbinds; the next hello is refused 1013.
    writeFileSync(join(control, "unbind"), "");
    const unbound = await until((e) => e.ev === "unbound", WAIT_MS);
    const n = await open("trk-no-receiver");
    phases["no-receiver"] = n.phase;
    n.phase.waits.unbound = unbound;
    n.phase.waits.host_close = await n.track.until(
      () => n.track.closed !== null || n.track.ended,
      5000,
    );
    ending(n);
    n.track.destroy();
  } catch (e) {
    problems.push(`client: ${(e as Error).message}`);
  }
  writeFileSync(join(control, "quit"), "");
  const out: TrkClient = { schema: "g8l-trk-client/1", phases, problems };
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `track-input-client: wrote ${outFile}${problems.length ? ` (${problems.join("; ")})` : ""}`,
  );
  return 0;
}

const invoked = process.argv[1] ?? "";
if (/track-input-client\.ts$/.test(invoked)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
