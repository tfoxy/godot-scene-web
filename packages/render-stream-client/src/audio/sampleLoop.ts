import type { AudioSample } from "./wire";

// Loop units belong to the original variant, even when playback uses a lazy WAV.
export function sampleLoopFrames(
  info: AudioSample,
  codec: string,
  decodedRate: number,
): { begin: number; end: number } {
  const frames = (point: number) => {
    if (info.variants[0].codec === "wav")
      return Math.round((point * decodedRate) / info.rate);
    if (codec === "wav")
      return Math.round(
        (Math.round(point * info.rate) * decodedRate) / info.rate,
      );
    return Math.round(point * decodedRate);
  };
  return { begin: frames(info.loop.begin), end: frames(info.loop.end) };
}
