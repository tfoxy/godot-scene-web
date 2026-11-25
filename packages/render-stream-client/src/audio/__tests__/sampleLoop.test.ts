import { expect, it } from "vitest";
import { sampleLoopFrames } from "../sampleLoop";
import type { AudioSample } from "../wire";

it.each([
  "mp3",
  "ogg-vorbis",
] as const)("keeps nonzero %s loop seconds when selecting its lazy WAV fallback", (codec) => {
  const info: AudioSample = {
    type: "sample",
    id: 1,
    variants: [
      { codec, hash: "ab".repeat(32), bytes: 100 },
      { codec: "wav", hash: "cd".repeat(32), bytes: 200 },
    ],
    channels: 1,
    rate: 22050,
    length_ms: 1000,
    loop: { mode: "forward", begin: 0.25, end: 0.75 },
    store: false,
  };
  expect(sampleLoopFrames(info, "wav", 44100)).toEqual({
    begin: 11026,
    end: 33076,
  });
  expect(sampleLoopFrames(info, codec, 44100)).toEqual({
    begin: 11025,
    end: 33075,
  });
  info.variants = [{ codec: "wav", hash: "cd".repeat(32), bytes: 200 }];
  info.loop = { mode: "forward", begin: 5513, end: 16538 };
  expect(sampleLoopFrames(info, "wav", 44100)).toEqual({
    begin: 11026,
    end: 33076,
  });
});
