import { strict as assert } from "node:assert";
import {
  type AudioBrowserEvidence,
  checkAudioBrowser,
} from "../check-audio-browser";

const evidence: AudioBrowserEvidence = {
  path: "worklet",
  worker: true,
  starts: [1, 2, 3],
  stops: [3, 2, 1],
  cachedHandleToStartMs: [2],
  stages: [1, 2, 3]
    .flatMap((voice) =>
      ["sample-start", "sample-stop"].map((type) => ({
        type,
        voice,
        handledMs: 0,
      })),
    )
    .concat(
      ["take-source-start", "cached-start", "lane-start", "lane-drop"].map(
        (type) => ({ type, handledMs: 0, voice: 0 }),
      ),
    ),
};
let passed = 0;
function check(ok: boolean) {
  assert.ok(ok);
  passed++;
}
check(checkAudioBrowser(evidence).length === 0);
check(
  checkAudioBrowser({ ...evidence, stops: [1, 1, 2] }).some((x) =>
    x.includes("once"),
  ),
);
check(
  checkAudioBrowser({
    ...evidence,
    stages: evidence.stages.filter((s) => s.type !== "lane-drop"),
  }).includes("missing lane-drop"),
);
check(
  checkAudioBrowser({ ...evidence, worker: false }).some((x) =>
    x.includes("Worker"),
  ),
);
check(
  checkAudioBrowser({ ...evidence, cachedHandleToStartMs: [Number.NaN] }).some(
    (x) => x.includes("measurement"),
  ),
);
check(
  checkAudioBrowser({
    ...evidence,
    stages: [
      ...evidence.stages,
      { type: "sample-start", voice: 1, handledMs: 0 },
    ],
  }).some((x) => x.includes("voice 1 count")),
);
console.log(`${passed} passed, 0 failed, 0 skipped`);
