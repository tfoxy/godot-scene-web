import {
  type OpenTrackOptions,
  openTrack,
  type TrackCloseInfo,
  type TrackSink,
} from "../track";
import {
  carrierTransport,
  type RenderStreamCarrier,
  type RenderStreamTransportFactory,
} from "../transport";
import { AudioClockEstimator } from "./clock";
import {
  type AudioContextLike,
  type AudioStage,
  MainAudioEngine,
} from "./mainEngine";
import { type FetchAudioAsset, GodotSampleEngine } from "./sampleEngine";
import { TakeStore } from "./takeStore";
import { createWebTransportTransport } from "./webtransport";
import {
  AUDIO_SUBPROTOCOL,
  type AudioClientMessage,
  type AudioCue,
  type AudioEvent,
  type AudioReady,
  type AudioSnapshot,
  audioHello,
  audioReadyEnvelope,
  decodeAudioError,
  decodeAudioText,
  decodeBlock,
  encodeAudioText,
} from "./wire";

// Match the track client: report consumer callback failures outside the protocol handler.
function call<A extends unknown[]>(
  fn: ((...args: A) => void) | undefined,
  ...args: A
): void {
  try {
    fn?.(...args);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

export interface OpenAudioTrackOptions
  extends Pick<
    OpenTrackOptions,
    | "credential"
    | "client"
    | "reconnect"
    | "clock"
    | "readyTimeoutMs"
    | "credentialTimeoutMs"
    | "onClose"
    | "onState"
  > {
  url: string;
  /** WT descriptor and the loaded net module's features; bit 1 grants audio carriage. */
  webTransport?: {
    url: string;
    certificateHashes?: string[];
    features: number;
  };
  carrier?: RenderStreamCarrier;
  context: AudioContextLike;
  /** Sample asset codecs in preference order; PCM16 blocks and WAV assets are always accepted. */
  codecs?: readonly ("ogg-vorbis" | "mp3" | "wav")[];
  transport?: RenderStreamTransportFactory;
  /** Fetch a hash-addressed sample asset; honor cache:no-store when store is false. */
  fetchAsset?: FetchAudioAsset;
  store?: TakeStore;
  onOpen?(ready: AudioReady): void;
  onEvent?(event: AudioEvent): void;
  onStage?(row: AudioStage): void;
}
export interface AudioTrack {
  readonly state: TrackSink["state"];
  readonly ready: AudioReady | null;
  readonly snapshot: AudioSnapshot | null;
  readonly samples: ReadonlyMap<number, AudioEvent>;
  readonly store: TakeStore;
  readonly finished: Promise<TrackCloseInfo>;
  close(): void;
}

/** An independent audio session. The context belongs to the caller and is never closed by the track. */
export interface AudioSessionRuntime {
  engine: Omit<
    Pick<
      MainAudioEngine,
      | "stopLane"
      | "gate"
      | "play"
      | "setGroups"
      | "loadTake"
      | "beginTake"
      | "abortTake"
      | "takeBlock"
      | "laneBlock"
      | "reset"
      | "dispose"
      | "setSampleActive"
    >,
    "loadTake"
  > & { loadTake(take: import("./takeStore").Take): void };
  sampleEngine(
    mapTime: (t: number) => number,
  ): Pick<GodotSampleEngine, "snapshot" | "handle" | "reset" | "dispose">;
}
export function openAudioTrack(
  options: OpenAudioTrackOptions,
  runtime?: AudioSessionRuntime,
): AudioTrack {
  const codecs = options.codecs ?? ["wav"];
  if (
    codecs.length > 8 ||
    new Set(codecs).size !== codecs.length ||
    codecs.some((c) => !["mp3", "ogg-vorbis", "wav"].includes(c))
  )
    throw new Error("audio-options-invalid");
  const now = options.clock?.now ?? (() => performance.now());
  const stage = options.onStage
    ? (row: AudioStage) => call(options.onStage, row)
    : undefined;
  const schedule =
    options.clock?.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel =
    options.clock?.clearTimeout ??
    ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const store = options.store ?? new TakeStore();
  const clock = new AudioClockEstimator();
  let engine: AudioSessionRuntime["engine"];
  let sampleEngine: ReturnType<AudioSessionRuntime["sampleEngine"]>;
  let failAudio = (): void => {};
  const samples = new Map<number, AudioEvent>();
  let ready: AudioReady | null = null;
  let snapshot: AudioSnapshot | null = null;
  let bankset: string | null = null;
  let groups: Record<string, number> = {};
  const pendingCues = new Map<string, AudioCue[]>();
  const advertised = new Set<string>();
  const takeStreams = new Map<number, string>();
  const abortedStreams = new Set<number>();
  const takeLast = new Set<number>();
  const pendingReady = new Map<
    number,
    Extract<AudioEvent, { type: "take-ready" }>
  >();
  const earlyTakes = new Map<string, ArrayBuffer[]>();
  let earlyLanes: ArrayBuffer[] = [];
  let receiveBlock: (data: ArrayBuffer, key?: string) => void;
  let timers: unknown[] = [];
  let outbox: AudioClientMessage[] = [];
  let flushTimer: unknown = null;
  let requestedLanes: number[] = [];
  let sink: TrackSink;
  let overflowClose = false;
  const originalClose = (info: TrackCloseInfo): TrackCloseInfo =>
    overflowClose && info.reason === "track-rate"
      ? { ...info, reason: "audio-overflow" }
      : info;
  const later = (cb: () => void, ms: number): void => {
    const id = schedule(() => {
      timers = timers.filter((t) => t !== id);
      cb();
    }, ms);
    timers.push(id);
  };
  const clearSession = (): void => {
    for (const id of timers) cancel(id);
    timers = [];
    if (flushTimer !== null) cancel(flushTimer);
    flushTimer = null;
    outbox = [];
    ready = null;
    snapshot = null;
    samples.clear();
    bankset = null;
    groups = {};
    pendingCues.clear();
    advertised.clear();
    takeStreams.clear();
    abortedStreams.clear();
    takeLast.clear();
    pendingReady.clear();
    earlyTakes.clear();
    earlyLanes = [];
    requestedLanes = [];
    store.resetStreams();
    sampleEngine.reset();
    engine.reset();
  };
  const flush = (): void => {
    if (sink.state !== "open") return;
    while (outbox.length) {
      const message = outbox[0];
      if (message.type === "clock") message.c = now();
      if (!sink.send(encodeAudioText(message))) {
        if (flushTimer === null)
          flushTimer = schedule(
            () => {
              flushTimer = null;
              flush();
            },
            1000 / (sink.ready?.rate.messagesPerSecond ?? 1),
          );
        return;
      }
      if (message.type === "clock") clock.request(message.c);
      outbox.shift();
    }
  };
  const send = (m: AudioClientMessage): void => {
    outbox.push(m);
    flush();
  };
  const advertise = (reset: boolean, ids: string[]): void => {
    if (bankset === null) return;
    if (reset) advertised.clear();
    const added: string[] = [];
    for (const id of ids) {
      if (advertised.size === 4096) break;
      if (advertised.has(id)) continue;
      advertised.add(id);
      added.push(id);
    }
    if (!reset && added.length === 0) return;
    for (let at = 0; at < Math.max(1, added.length); at += 100)
      send({
        type: "have",
        bankset,
        key_ids: added.slice(at, at + 100),
        reset: reset && at === 0,
      });
  };
  const subscribe = (): void => {
    const ids = (ready?.lanes ?? [])
      .filter((l) => (Object.hasOwn(groups, l.group) ? groups[l.group] : 1) > 0)
      .map((l) => l.id);
    if (ids.join(",") === requestedLanes.join(",")) return;
    for (const id of requestedLanes) if (!ids.includes(id)) engine.stopLane(id);
    requestedLanes = ids;
    send({ type: "lanes", ids });
  };
  const cue = (event: AudioCue): void => {
    if (event.kind !== "oneshot") {
      engine.gate(event);
      return;
    }
    if (bankset === null) throw new Error("audio-protocol");
    const cached = store.peek(bankset, event.key_id);
    if (cached) engine.play(cached, event);
    else {
      const pending = pendingCues.get(event.key_id) ?? [];
      pending.push(event);
      pendingCues.set(event.key_id, pending);
    }
  };
  const abandonTake = (keyId: string): void => {
    earlyTakes.delete(keyId);
    pendingCues.delete(keyId);
    for (const [stream, key] of takeStreams) {
      if (key !== keyId) continue;
      pendingReady.delete(stream);
      takeLast.delete(stream);
      store.abort(stream);
      engine.abortTake(stream);
      takeStreams.delete(stream);
      abortedStreams.add(stream);
    }
  };
  const event = (m: AudioEvent): void => {
    switch (m.type) {
      case "audio-state":
        if (snapshot !== null) throw new Error("audio-protocol");
        snapshot = m;
        sampleEngine.snapshot(m);
        bankset = m.fmod?.bankset ?? null;
        groups = { ...m.fmod?.groups };
        engine.setGroups(groups, true);
        if (bankset)
          for (const id of store.ids(bankset)) {
            const take = store.peek(bankset, id);
            if (take) engine.loadTake(take);
          }
        advertise(true, bankset ? store.ids(bankset) : []);
        subscribe();
        for (const block of earlyLanes) receiveBlock(block);
        earlyLanes = [];
        break;
      case "sample":
        samples.set(m.id, m);
        sampleEngine.handle(m);
        break;
      case "sample-drop":
        samples.delete(m.id);
        sampleEngine.handle(m);
        break;
      case "sample-variant": {
        sampleEngine.handle(m);
        const prior = samples.get(m.id as number);
        if (prior?.type === "sample")
          samples.set(m.id as number, {
            ...prior,
            variants: [
              ...prior.variants,
              { codec: m.codec, hash: m.hash, bytes: m.bytes },
            ],
          });
        break;
      }
      case "start":
      case "stop":
      case "pause":
      case "pitch":
      case "voice-volumes":
      case "bus":
        sampleEngine.handle(m);
        break;
      case "groups":
        groups = m.snapshot ? { ...m.gains } : { ...groups, ...m.gains };
        engine.setGroups(m.gains, m.snapshot);
        subscribe();
        break;
      case "cue":
        cue(m);
        break;
      case "take-start":
        if (m.bankset !== bankset) throw new Error("audio-protocol");
        store.begin(m.stream, m.key_id, m.frames, m.bankset);
        takeStreams.set(m.stream, m.key_id);
        abortedStreams.delete(m.stream);
        engine.beginTake(m.stream, pendingCues.get(m.key_id) ?? []);
        pendingCues.delete(m.key_id);
        {
          const blocks = earlyTakes.get(m.key_id) ?? [];
          earlyTakes.delete(m.key_id);
          for (const block of blocks) receiveBlock(block, m.key_id);
        }
        break;
      case "take-ready": {
        if (options.webTransport && !takeLast.has(m.stream)) {
          pendingReady.set(m.stream, m);
          return;
        }
        takeLast.delete(m.stream);
        const take = store.finish(m.stream, m.key_id, m.hash);
        takeStreams.delete(m.stream);
        engine.loadTake(take);
        advertise(false, [m.key_id]);
        for (const pending of pendingCues.get(m.key_id) ?? [])
          engine.play(take, pending);
        pendingCues.delete(m.key_id);
        break;
      }
      case "take-unavailable":
        abandonTake(m.key_id);
        break;
      case "lanes":
        for (const lane of m.lanes)
          if (lane.state !== "on") engine.stopLane(lane.id);
        break;
      case "clock":
        clock.reply(m.c, m.h, now());
        break;
    }
    call(options.onEvent, m);
  };
  let mediaSession = 0;
  let sinkActivity = (): void => {};
  receiveBlock = (data, key) => {
    if (!snapshot || !ready) {
      if (key) {
        const pending = earlyTakes.get(key) ?? [];
        pending.push(data);
        earlyTakes.set(key, pending);
      } else earlyLanes.push(data);
      return;
    }
    const block = decodeBlock(new Uint8Array(data), {
      lanes: ready.lanes.map((l) => l.id),
      lane_block_frames: ready.lane_block_frames,
    });
    sinkActivity();
    stage?.({
      type: block.header.kind === 1 ? "take-block" : "lane-block",
      handledMs: now(),
      stream: block.header.stream,
      block: block.header.block,
      lane: block.header.lane,
      made_us: Number(block.header.made_us),
      due_us: Number(block.header.due_us),
      sent_us: Number(block.header.sent_us),
    });
    if (block.header.kind === 1) {
      if (abortedStreams.has(block.header.stream)) return;
      if (key && !takeStreams.has(block.header.stream)) {
        const pending = earlyTakes.get(key) ?? [];
        pending.push(data);
        earlyTakes.set(key, pending);
        return;
      }
      if (key && takeStreams.get(block.header.stream) !== key)
        throw new Error("audio-protocol");
      engine.takeBlock(block, store.append(block));
      if (block.header.flags & 2) {
        takeLast.add(block.header.stream);
        const waiting = pendingReady.get(block.header.stream);
        if (waiting) {
          pendingReady.delete(block.header.stream);
          event(waiting);
        }
      }
    } else {
      const lane = ready.lanes.find((l) => l.id === block.header.lane);
      if (!lane) throw new Error("audio-protocol");
      if (requestedLanes.includes(lane.id))
        engine.laneBlock(
          block,
          lane,
          clock.contextTime(
            Number(block.header.due_us),
            options.context,
            now(),
          ),
        );
    }
  };
  const mediaBlock = (data: ArrayBuffer, key?: string): void => {
    try {
      receiveBlock(data, key);
    } catch {
      failAudio();
    }
  };
  const factory =
    options.transport ??
    carrierTransport(
      options.webTransport && (options.webTransport.features & 2) !== 0
        ? (options.carrier ?? "auto")
        : "websocket",
      {
        webtransport: async () => (endpoint, protocol, on) => {
          const generation = mediaSession;
          return createWebTransportTransport({
            cacheBytes: 0,
            onTake: (key, block) => {
              if (mediaSession === generation) mediaBlock(block, key);
            },
            onTakeAbandoned: (key) => {
              if (mediaSession === generation) abandonTake(key);
            },
            onLane: (block) => {
              if (mediaSession === generation) mediaBlock(block);
            },
          })(endpoint, protocol, on);
        },
      },
    );
  const transport: RenderStreamTransportFactory = (endpoint, _protocol, on) => {
    const generation = ++mediaSession;
    overflowClose = false;
    sinkActivity = () => on.message("");
    let opened = false;
    let ended = false;
    let hello = true;
    let pendingError: { reason: string; detail?: string } | null = null;
    const fail = (): void => {
      if (!ended) {
        ended = true;
        if (mediaSession === generation) mediaSession++;
        link.close(1000, "audio-protocol");
        on.close(1002, "audio-protocol");
      }
    };
    failAudio = fail;
    const link = factory(endpoint, AUDIO_SUBPROTOCOL, {
      open: () => on.open(),
      message(data) {
        if (ended) return;
        try {
          if (typeof data === "string") {
            if (data === "") {
              on.message(data);
              return;
            }
            if (!opened) {
              const envelope = audioReadyEnvelope(data);
              ready = envelope.audio;
              on.message(envelope.text);
              opened = sink.state === "open";
            } else {
              // Keep track's inbound watchdog current for texts AND binary blocks.
              on.message("");
              if (data.startsWith('{"type":"track-error"')) {
                pendingError = decodeAudioError(data);
                on.message(data);
                return;
              }
              const m = decodeAudioText(data);
              if (
                snapshot === null &&
                m.type !== "audio-state" &&
                m.type !== "clock"
              )
                throw new Error("audio-protocol");
              stage?.({
                type: m.type,
                handledMs: now(),
                ...("t" in m ? { t: m.t, s: m.s } : {}),
              });
              event(m);
            }
          } else {
            if (!opened || !snapshot || !ready)
              throw new Error("audio-protocol");
            receiveBlock(data);
          }
        } catch {
          fail();
        }
      },
      close(code, reason) {
        if (ended) return;
        ended = true;
        if (mediaSession === generation) mediaSession++;
        // Audio overflow inherits track-rate's >=1s retry floor without changing track.ts.
        if ((reason || pendingError?.reason) === "audio-overflow") {
          overflowClose = true;
          on.close(code, "track-rate");
        } else on.close(code, reason);
      },
    });
    return {
      ...link,
      send(text) {
        if (hello) {
          hello = false;
          link.send(audioHello(text, codecs));
        } else link.send(text);
      },
      close(code, reason) {
        ended = true;
        if (mediaSession === generation) mediaSession++;
        link.close(code, reason);
      },
      fetchResource: (path, init) => link.fetchResource(path, init),
    };
  };
  sink = openTrack(
    {
      url: options.url,
      ...(options.webTransport
        ? {
            webTransport: {
              url: options.webTransport.url,
              certificateHashes: options.webTransport.certificateHashes,
            },
          }
        : {}),
    },
    {
      ...options,
      credential:
        typeof options.credential === "function"
          ? (context) =>
              (
                options.credential as Exclude<
                  OpenTrackOptions["credential"],
                  string
                >
              )({
                ...context,
                lastClose: context.lastClose
                  ? originalClose(context.lastClose)
                  : null,
              })
          : options.credential,
      kind: "audio",
      formats: ["gsw-audio/1"],
      transport,
      onOpen() {
        if (!ready) throw new Error("audio-protocol");
        clock.reset(ready.clock_us, now());
        const probe = (index: number): void => {
          const c = now();
          send({ type: "clock", c });
          later(() => probe(index + 1), index < 7 ? 50 : 5000);
        };
        probe(0);
        options.onOpen?.(ready);
      },
      onMessage() {},
      onClose(info) {
        clearSession();
        if (!info.willReconnect) {
          sampleEngine.dispose();
          engine.dispose();
        }
        options.onClose?.(originalClose(info));
      },
    },
  );
  engine =
    runtime?.engine ??
    new MainAudioEngine(
      options.context,
      stage ? (row) => stage({ ...row, handledMs: now() }) : undefined,
    );
  sampleEngine =
    runtime?.sampleEngine((t) =>
      clock.contextTime(t, options.context, now()),
    ) ??
    new GodotSampleEngine(
      options.context,
      codecs,
      options.fetchAsset,
      (t) => clock.contextTime(t, options.context, now()),
      (count) => engine.setSampleActive(count),
      () => failAudio(),
      stage ? (row) => stage({ ...row, handledMs: now() }) : undefined,
    );
  return {
    get state() {
      return sink.state;
    },
    get ready() {
      return ready;
    },
    get snapshot() {
      return snapshot;
    },
    get samples() {
      return samples;
    },
    store,
    finished: sink.finished.then(originalClose),
    close() {
      sink.close();
      clearSession();
      sampleEngine.dispose();
      engine.dispose();
    },
  };
}
