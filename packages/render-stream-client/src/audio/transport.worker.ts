// Adapted from sts2-couch-coop audioTransportCore.ts; copyright 2026 Tomás Fox, MIT.
// Sockets, wire decoding, clocks, take assembly and have/lanes bookkeeping stay in this Worker.

import type { TrackCredentialContext } from "../track";
import type { AudioContextLike } from "./mainEngine";
import {
  type AudioTrack,
  type OpenAudioTrackOptions,
  openAudioTrack,
} from "./session";
import { type Take, TakeStore } from "./takeStore";
import { WorkletAudioEngine } from "./workletEngine";

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
let track: AudioTrack | undefined;
let anchor = {
  currentTime: 0,
  now: 0,
  running: false,
  stamp: {} as AudioTimestamp,
};
let engine: WorkletAudioEngine;
let credentialId = 0;
const credentials = new Map<
  number,
  { resolve(value: string): void; reject(error: Error): void }
>();
const now = () => performance.timeOrigin + performance.now();
const post = (kind: string, data?: unknown) =>
  scope.postMessage({ kind, data });
scope.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.kind === "anchor") {
    anchor = m.data;
    return;
  }
  if (m.kind === "credential") {
    const pending = credentials.get(m.id);
    credentials.delete(m.id);
    if (m.error) pending?.reject(new Error(m.error));
    else pending?.resolve(m.value);
    return;
  }
  if (m.kind === "close") {
    track?.close();
    return;
  }
  if (m.kind !== "init") return;
  anchor = m.anchor;
  engine = new WorkletAudioEngine(m.port);
  const store = new TakeStore();
  for (const take of m.takes as Take[]) store.put(take);
  const put = store.put.bind(store);
  store.put = (take) => {
    put(take);
    post("take", take);
  };
  const context = {
    get currentTime() {
      return (
        anchor.currentTime + (anchor.running ? (now() - anchor.now) / 1000 : 0)
      );
    },
    getOutputTimestamp: () => anchor.stamp,
  } as AudioContextLike;
  const options = m.options as OpenAudioTrackOptions;
  try {
    track = openAudioTrack(
      {
        ...options,
        context,
        store,
        clock: { now },
        credential: m.provider
          ? (ctx: TrackCredentialContext) =>
              new Promise<string>((resolve, reject) => {
                const id = ++credentialId;
                credentials.set(id, { resolve, reject });
                scope.postMessage({ kind: "credential", id, data: ctx });
              })
          : options.credential,
        onState: (state) => post("state", state),
        onOpen: (ready) => post("open", ready),
        onClose: (info) => {
          post("reset");
          post("close", info);
        },
        onEvent: (event) => {
          if (event.type === "clock") post("anchor-request");
          post("event", event);
        },
        onStage: m.diag ? (row) => post("stage", row) : undefined,
      },
      {
        engine,
        sampleEngine: (mapTime) => ({
          snapshot: (snapshot) =>
            post("sample-snapshot", { snapshot, mapped: mapTime(snapshot.t) }),
          handle: (event) =>
            post("sample", {
              event,
              mapped: "t" in event ? mapTime(event.t) : 0,
            }),
          reset: () => post("reset"),
          dispose: () => post("reset"),
        }),
      },
    );
    void track.finished.then((info) => {
      credentials.clear();
      post("finished", info);
    });
  } catch (error) {
    post("error", String(error));
  }
};
