// Adapted from sts2-couch-coop audioSinkProtocol.ts; copyright 2026 Tomás Fox, MIT.
import type { AudioStage } from "./mainEngine";
import type { Take } from "./takeStore";
import type { AudioCue, Block, LinkLane } from "./wire";
export type SinkCommand =
  | { kind: "load"; take: Take }
  | { kind: "play"; key: string; cue: AudioCue; handledMs: number }
  | { kind: "take-start"; stream: number; cues: AudioCue[] }
  | { kind: "take-abort"; stream: number }
  | { kind: "take-block"; block: Block; pcm: Float32Array[] }
  | { kind: "lane-block"; block: Block; lane: LinkLane; due: number }
  | { kind: "lane-stop"; lane: number }
  | { kind: "groups"; gains: Record<string, number>; snapshot: boolean }
  | { kind: "gate"; cue: AudioCue }
  | { kind: "sample-active"; count: number }
  | { kind: "reset" };
export interface SinkEnvelope {
  epoch: number;
  command: SinkCommand;
}
export interface MixerStage extends Omit<AudioStage, "handledMs"> {
  handledMs?: number;
}
