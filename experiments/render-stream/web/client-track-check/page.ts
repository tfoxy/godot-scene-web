// TRK4's live check page (scripts/client-track-check.ts): opens tracks through the package's
// `./tracks` subpath only and exposes what each one saw to the driver. It loads no view client,
// no wasm and no harness code.

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
}
const entries = new Map<string, Entry>();

// Which transport class carried the tracks, as the page saw it: the driver reads these counts
// to assert a wt run opened WebTransport sessions and a ws run only WebSockets.
const constructed = { websocket: 0, webtransport: 0 };
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
        return Reflect.construct(target, a, newTarget);
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
      | "credential"
      | "reconnect"
      | "client"
      | "carrier"
    >,
  ): string | null {
    const e: Entry = {
      sink: null as never,
      opens: [],
      messages: [],
      closes: [],
      states: ["connecting"],
    };
    try {
      e.sink = openTrack(endpoint, {
        carrier: "websocket",
        ...options,
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
    };
  },
  transports(): { websocket: number; webtransport: number } {
    return { ...constructed };
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
