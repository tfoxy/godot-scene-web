// TRK4's live check page (scripts/client-track-check.ts): opens tracks through the package's
// `./tracks` subpath only and exposes what each one saw to the driver. It loads no view client,
// no wasm and no harness code.
//
// CRED1: `open`'s `provider: true` makes the credential a provider that asks the driver (the
// Node side, which holds the capability key) through `window.__mintCap(name)`, the way an app's
// page asks its own server; every value it returned is kept in `mints`. `drop()` closes the last
// transport the page constructed with a client close, the forced drop of the refresh leg.

import {
  type OpenTrackOptions,
  openTrack,
  RenderStreamTrackError,
  type TrackCloseInfo,
  type TrackEndpoint,
  type TrackReady,
  type TrackSink,
  type TrackStats,
} from "../../../../packages/render-stream-client/src/tracks";

interface Entry {
  sink: TrackSink;
  opens: TrackReady[];
  messages: string[];
  closes: TrackCloseInfo[];
  states: string[];
  /** Every credential the provider returned (CRED1), in order. */
  mints: string[];
  /** Provider calls, answered or not. */
  mintCalls: number;
}
const entries = new Map<string, Entry>();

// Which transport class carried the tracks, as the page saw it: the driver reads these counts
// to assert a wt run opened WebTransport sessions and a ws run only WebSockets.
const constructed = { websocket: 0, webtransport: 0 };
const made: { kind: "websocket" | "webtransport"; instance: unknown }[] = [];
{
  const w = window as unknown as Record<string, unknown>;
  for (const [key, global] of [
    ["websocket", "WebSocket"],
    ["webtransport", "WebTransport"],
  ] as const) {
    const Native = w[global] as (new (...a: unknown[]) => unknown) | undefined;
    if (!Native) continue;
    w[global] = new Proxy(Native, {
      construct(target, a, newTarget) {
        constructed[key]++;
        const instance = Reflect.construct(target, a, newTarget);
        made.push({ kind: key, instance });
        return instance;
      },
    });
  }
}

const api = {
  ready: true,
  /** Opens a track under `name`; returns a thrown option error's code instead of throwing. */
  open(
    name: string,
    endpoint: TrackEndpoint,
    options: Pick<
      OpenTrackOptions,
      | "kind"
      | "formats"
      | "downFormats"
      | "reconnect"
      | "client"
      | "carrier"
      | "credentialTimeoutMs"
    > & { credential?: string; provider?: boolean },
  ): string | null {
    const e: Entry = {
      sink: null as never,
      opens: [],
      messages: [],
      closes: [],
      states: ["connecting"],
      mints: [],
      mintCalls: 0,
    };
    const { provider, credential, ...rest } = options;
    try {
      e.sink = openTrack(endpoint, {
        carrier: "websocket",
        ...rest,
        credential: provider
          ? async () => {
              e.mintCalls++;
              const mint = (
                window as unknown as {
                  __mintCap(name: string): Promise<string>;
                }
              ).__mintCap;
              const v = await mint(name);
              e.mints.push(v);
              return v;
            }
          : (credential as string),
        onOpen: (r) => e.opens.push(r),
        onMessage: (t) => e.messages.push(t),
        onClose: (c) => e.closes.push(c),
        onState: (s) => e.states.push(s),
      });
    } catch (err) {
      if (err instanceof RenderStreamTrackError) return err.code;
      throw err;
    }
    entries.set(name, e);
    return null;
  },
  get(name: string): {
    state: string;
    ready: TrackReady | null;
    opens: TrackReady[];
    messages: string[];
    closes: TrackCloseInfo[];
    states: string[];
    stats: TrackStats;
    mints: string[];
    mintCalls: number;
  } {
    const e = entries.get(name);
    if (!e) throw new Error(`no track ${name}`);
    return {
      state: e.sink.state,
      ready: e.sink.ready,
      opens: e.opens,
      messages: e.messages,
      closes: e.closes,
      states: e.states,
      stats: e.sink.stats(),
      mints: e.mints,
      mintCalls: e.mintCalls,
    };
  },
  transports(): { websocket: number; webtransport: number } {
    return { ...constructed };
  },
  /** Closes the transport constructed last (a client close, code 3000); its kind, or "none". */
  drop(): string {
    const last = made.at(-1);
    if (!last) return "none";
    if (last.kind === "websocket")
      (last.instance as WebSocket).close(3000, "forced-drop");
    else
      (
        last.instance as {
          close(i: { closeCode: number; reason: string }): void;
        }
      ).close({ closeCode: 3000, reason: "forced-drop" });
    return last.kind;
  },
  send(name: string, texts: string[]): boolean[] {
    const e = entries.get(name);
    if (!e) throw new Error(`no track ${name}`);
    return texts.map((t) => e.sink.send(t));
  },
  close(name: string): void {
    entries.get(name)?.sink.close();
  },
};

(window as unknown as Record<string, unknown>).__trk = api;
