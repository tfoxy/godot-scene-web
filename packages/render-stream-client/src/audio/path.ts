// Adapted from sts2-couch-coop audioPath.ts/workletSink.ts; copyright 2026 Tomás Fox, MIT.

import { webSocketUrl } from "../endpoint";
import type { TrackCloseInfo, TrackState } from "../track";
import type { AudioStage } from "./mainEngine";
import { GodotSampleEngine } from "./sampleEngine";
import {
  type AudioTrack,
  type OpenAudioTrackOptions as MainOptions,
  openAudioTrack as openMainTrack,
} from "./session";
import { TakeStore } from "./takeStore";
import { playAudioPrelude } from "./unlock";
import type { AudioEvent, AudioReady, AudioSnapshot } from "./wire";

export type { AudioTrack } from "./session";
export interface OpenAudioTrackOptions extends MainOptions {
  /** Default: Worker + AudioWorklet on secure pages, main-thread nodes otherwise. */
  path?: "auto" | "main" | "worklet";
  /** Standalone bundled modules; override when the product's bundler relocates them. */
  workerUrl?: string | URL;
  workletUrl?: string | URL;
}
export function supportsAudioWorklet(context: MainOptions["context"]): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof Worker === "function" &&
    typeof AudioWorkletNode === "function" &&
    "audioWorklet" in context
  );
}
/** Open inside a user gesture. The caller owns the context, including visibility/resume policy. */
export function openAudioTrack(options: OpenAudioTrackOptions): AudioTrack {
  const disposePrelude = playAudioPrelude();
  void options.context.resume().catch(() => {});
  if (
    options.path === "main" ||
    !supportsAudioWorklet(options.context) ||
    options.transport ||
    options.clock
  ) {
    const track = openMainTrack(options);
    void track.finished.then(disposePrelude);
    return track;
  }
  const url =
    typeof location === "undefined"
      ? options.url
      : webSocketUrl(options.url, location.href);
  const context = options.context as AudioContext;
  const store = options.store ?? new TakeStore();
  let state: TrackState = "connecting",
    ready: AudioReady | null = null,
    snapshot: AudioSnapshot | null = null;
  const samples = new Map<number, AudioEvent>();
  let fallback: AudioTrack | undefined,
    worker: Worker | undefined,
    node: AudioWorkletNode | undefined;
  let sampleEngine: GodotSampleEngine | undefined,
    channel: MessageChannel | undefined;
  let closed = false,
    settled = false,
    connected = false,
    mapped = 0,
    mappedT = 0;
  let abortSetup: (() => void) | undefined;
  let fallingBack = false;
  let finish!: (info: TrackCloseInfo) => void;
  const finished = new Promise<TrackCloseInfo>((resolve) => {
    finish = resolve;
  });
  const emit = <T>(fn: ((data: T) => void) | undefined, data: T) => {
    try {
      fn?.(data);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const anchor = () => ({
    currentTime: context.currentTime,
    now: performance.timeOrigin + performance.now(),
    running: context.state === "running",
    stamp: (() => {
      const s = context.getOutputTimestamp();
      if (!s.contextTime && !s.performanceTime) return {};
      return {
        contextTime: s.contextTime,
        performanceTime:
          s.performanceTime === undefined
            ? undefined
            : performance.timeOrigin + s.performanceTime,
      };
    })(),
  });
  const sync = () => worker?.postMessage({ kind: "anchor", data: anchor() });
  const cleanup = () => {
    abortSetup?.();
    abortSetup = undefined;
    worker?.terminate();
    worker = undefined;
    sampleEngine?.dispose();
    sampleEngine = undefined;
    if (node) {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
      node = undefined;
    }
    channel?.port1.close();
    channel?.port2.close();
    context.removeEventListener("statechange", sync);
    disposePrelude();
  };
  const complete = (info: TrackCloseInfo) => {
    if (settled) return;
    settled = true;
    state = "closed";
    cleanup();
    finish(info);
  };
  const localClose = (): TrackCloseInfo => ({
    code: 1000,
    reason: "client-close",
    detail: null,
    by: "client",
    opened: connected,
    willReconnect: false,
    reconnectInMs: null,
  });
  const fail = () => {
    if (closed || settled || fallingBack) return;
    if (connected) {
      const info = { ...localClose(), code: 1002, reason: "audio-protocol" };
      emit(options.onState, "closed");
      emit(options.onClose, info);
      complete(info);
      return;
    }
    fallingBack = true;
    cleanup();
    try {
      fallback = openMainTrack({ ...options, store });
      void fallback.finished.then(complete);
    } catch (error) {
      const info = {
        ...localClose(),
        code: 1002,
        reason: "audio-options-invalid",
        detail: String(error),
      };
      emit(options.onState, "closed");
      emit(options.onClose, info);
      complete(info);
    }
  };
  const stage = (row: AudioStage) => emit(options.onStage, row);
  void (async () => {
    await context.audioWorklet.addModule(
      options.workletUrl ??
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./mixer.worklet.ts"
            : "./audio/mixer.worklet.js",
          import.meta.url,
        ),
    );
    if (closed) return;
    node = new AudioWorkletNode(context, "gsw-track-mixer", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { diag: !!options.onStage },
    });
    node.connect(context.destination);
    node.onprocessorerror = fail;
    channel = new MessageChannel();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("audio-worklet-timeout")),
        10000,
      );
      abortSetup = () => {
        clearTimeout(timer);
        reject(new Error("audio-worklet-cancelled"));
      };
      node!.port.onmessage = (e) => {
        if (e.data.kind === "ready") {
          clearTimeout(timer);
          abortSetup = undefined;
          resolve();
        } else if (e.data.kind === "stage") {
          const row = e.data.row;
          // Worklet render time -> page clock. Receipt is stamped in the Worker before posting.
          stage({
            ...row,
            handledMs:
              row.handledMs === undefined
                ? performance.now() -
                  (context.currentTime -
                    (row.contextTime ?? context.currentTime)) *
                    1000
                : row.handledMs - performance.timeOrigin,
          });
        }
      };
      node!.port.postMessage({ kind: "port", port: channel!.port2 }, [
        channel!.port2,
      ]);
    });
    if (closed) return;
    worker = new Worker(
      options.workerUrl ??
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./transport.worker.ts"
            : "./audio/transport.worker.js",
          import.meta.url,
        ),
      { type: "module" },
    );
    worker.onerror = fail;
    sampleEngine = new GodotSampleEngine(
      {
        // Preserve native AudioContext method receivers while routing samples into the mixer input.
        get currentTime() {
          return context.currentTime;
        },
        destination: node as unknown as AudioDestinationNode,
        createGain: context.createGain.bind(context),
        createBuffer: context.createBuffer.bind(context),
        createBufferSource: context.createBufferSource.bind(context),
        createConstantSource: context.createConstantSource.bind(context),
        createChannelMerger: context.createChannelMerger.bind(context),
        createChannelSplitter: context.createChannelSplitter.bind(context),
        decodeAudioData: context.decodeAudioData.bind(context),
        resume: context.resume.bind(context),
        getOutputTimestamp: context.getOutputTimestamp.bind(context),
      },
      options.codecs ?? ["wav"],
      options.fetchAsset,
      (t) => mapped + (t - mappedT) / 1e6,
      (count) => node?.port.postMessage({ kind: "sample-active", count }),
      fail,
      options.onStage
        ? (row) => stage({ ...row, handledMs: performance.now() })
        : undefined,
    );
    worker.onmessage = async (e) => {
      try {
        const { kind, data } = e.data;
        switch (kind) {
          case "credential":
            try {
              const value =
                typeof options.credential === "function"
                  ? await options.credential(data)
                  : options.credential;
              worker?.postMessage({ kind, id: e.data.id, value });
            } catch (error) {
              worker?.postMessage({
                kind,
                id: e.data.id,
                error: String(error),
              });
            }
            break;
          case "state":
            state = data;
            emit(options.onState, state);
            break;
          case "open":
            connected = true;
            ready = data;
            emit(options.onOpen, data);
            break;
          case "close":
            ready = null;
            snapshot = null;
            samples.clear();
            emit(options.onClose, data);
            break;
          case "finished":
            complete(data);
            break;
          case "event":
            if (data.type === "audio-state") snapshot = data;
            if (data.type === "sample") samples.set(data.id, data);
            if (data.type === "sample-drop") samples.delete(data.id);
            if (data.type === "sample-variant") {
              const prior = samples.get(data.id);
              if (prior?.type === "sample")
                samples.set(data.id, {
                  ...prior,
                  variants: [
                    ...prior.variants,
                    { codec: data.codec, hash: data.hash, bytes: data.bytes },
                  ],
                });
            }
            emit(options.onEvent, data);
            break;
          case "sample-snapshot":
            mapped = data.mapped;
            mappedT = data.snapshot.t;
            sampleEngine?.snapshot(data.snapshot);
            break;
          case "sample":
            mapped = data.mapped;
            mappedT = data.event.t ?? 0;
            sampleEngine?.handle(data.event);
            break;
          case "reset":
            sampleEngine?.reset();
            break;
          case "take":
            store.put(data);
            break;
          case "stage":
            stage({
              ...data,
              handledMs: data.handledMs - performance.timeOrigin,
            });
            break;
          case "anchor-request":
            sync();
            break;
          case "error":
            fail();
            break;
        }
      } catch {
        fail();
      }
    };
    // Snapshot banks are not yet known: pass all resident takes through the store's public iterator.
    worker.postMessage(
      {
        kind: "init",
        options: {
          url,
          webTransport: options.webTransport,
          carrier: options.carrier,
          credential:
            typeof options.credential === "string" ? options.credential : "",
          client: options.client,
          codecs: options.codecs,
          reconnect: options.reconnect,
          readyTimeoutMs: options.readyTimeoutMs,
          credentialTimeoutMs: options.credentialTimeoutMs,
        },
        provider: typeof options.credential === "function",
        port: channel.port1,
        anchor: anchor(),
        takes: store.entries(),
        diag: !!options.onStage,
      },
      [channel.port1],
    );
    context.addEventListener("statechange", sync);
  })().catch(fail);
  return {
    get state() {
      return fallback?.state ?? state;
    },
    get ready() {
      return fallback?.ready ?? ready;
    },
    get snapshot() {
      return fallback?.snapshot ?? snapshot;
    },
    get samples() {
      return fallback?.samples ?? samples;
    },
    store,
    finished,
    close() {
      if (closed || settled) return;
      closed = true;
      if (fallback) fallback.close();
      else {
        const info = localClose();
        emit(options.onState, "closed");
        emit(options.onClose, info);
        complete(info);
      }
    },
  };
}
