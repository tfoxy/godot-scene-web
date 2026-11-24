import type { AudioStage } from "../../../packages/render-stream-client/src/audio/mainEngine";
export interface AudioBrowserEvidence {
  path: string;
  worker: boolean;
  starts: number[];
  stops: number[];
  stages: AudioStage[];
  cachedHandleToStartMs: number[];
}
export function checkAudioBrowser(row: AudioBrowserEvidence): string[] {
  const failures: string[] = [];
  if (
    row.starts.length !== 3 ||
    new Set(row.starts).size !== 3 ||
    row.stops.length !== 3 ||
    row.starts.some((v) => row.stops.filter((x) => x === v).length !== 1)
  )
    failures.push("every scripted voice starts and stops once");
  for (const type of [
    "sample-start",
    "sample-stop",
    "take-source-start",
    "cached-start",
    "lane-start",
    "lane-drop",
  ])
    if (!row.stages.some((s) => s.type === type))
      failures.push(`missing ${type}`);
  for (const v of row.starts)
    for (const type of ["sample-start", "sample-stop"])
      if (
        row.stages.filter((s) => s.type === type && s.voice === v).length !== 1
      )
        failures.push(`${type} voice ${v} count`);
  if (
    !row.cachedHandleToStartMs.length ||
    row.cachedHandleToStartMs.some((x) => !Number.isFinite(x))
  )
    failures.push("missing cached handle-to-start measurement (ms)");
  if (row.worker !== (row.path === "worklet"))
    failures.push("selected path differs from observed Worker");
  return failures;
}
