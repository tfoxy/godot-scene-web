#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7l's pure pieces (never a browser, a host or a Godot run):
//
//  1. mapBrowserLeg (lib/gate7-live-legs.ts) maps a native live leg's words for a browser:
//     absolute paths become URL paths under the static root, RS_RECEIVER_CACHE_DIR and
//     RS_RECEIVER_TOKEN_FILE are dropped (the token is returned for the fragment only, never put in
//     the env), RS_RECEIVER_PROTOCOL=7 is added on a live leg and anything else refused, a native
//     --headless leg keeps credit stage `applied`, a warm leg names its cold leg, --resolution
//     becomes the canvas, and a path outside the static root is refused.
//  2. wireVersionOf (lib/render-stream-2.ts) reads 7 only from a GRS7 magic, and summarizeRecording
//     validates golden-7's rate.rs7 as /7 while golden-6's inline.rs6 still reads as /6.
//  3. receivedFileName (lib/gate1-live-checks.ts) finds received(-n).rs7 when present, else .rs2.
//  4. getsVsFetches (lib/gate2c-checks.ts): an `http-cache` receiver's repeated fetch of a hash is
//     the browser's HTTP cache (the host's GETs equal its first fetch per hash) and ETag must be
//     absent; any other mode keeps /6's rules exactly (a repeat is "fetched n times").
//  5. warmCacheProblems (lib/gate2c-checks.ts): native warm needs 0 fetches and one cache hit per
//     cold fetch; http-cache needs exactly the cold leg's fetches, all 200.
//  6. pacedLoopProblems (lib/gate7-live.ts, Q9 credit-from-paced-loop): web passes only when the
//     submitted ack's process frame is the apply's; gsw only when applied and drawn in one rAF and
//     acked from that rAF after the draw (an ack from onmessage, the ack-on-receipt sabotage, fails).
//  7. knownFailure (lib/gate7-live.ts): web g5f's mesh pixel checks name the known
//     web-index-region-update cause only when every region they name is RM or DF, and never on
//     the rust web core.
//  8. G7xwl: webCoreOf/coreEnv (lib/gate7-live-legs.ts) add RS_RECEIVER_CORE=rust to a web leg
//     only on a rust run with a `--core rust` bundle (refused otherwise; drop-env omits it), and
//     receiverCoreProblems (lib/gate7-live.ts, receiver-core@web) passes an honest leg, a killed
//     one, and fails the drop-env sabotage, a missing module fetch and a core mismatch.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeRecording } from "../lib/gate0-checks";
import { receivedFileName } from "../lib/gate1-live-checks";
import type { HookLine } from "../lib/gate2b-checks";
import {
  type G2cFetch,
  getsVsFetches,
  warmCacheProblems,
} from "../lib/gate2c-checks";
import {
  knownFailure,
  pacedLoopProblems,
  RS_CORE_SIDE_MODULE,
  receiverCoreProblems,
} from "../lib/gate7-live";
import { coreEnv, mapBrowserLeg, webCoreOf } from "../lib/gate7-live-legs";
import { wireVersionOf } from "../lib/render-stream-2";

const PROTOCOL = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "protocol",
);

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// 1. mapBrowserLeg
const root = "/runs/gate2";
const token = "ab".repeat(32);
const live = mapBrowserLeg(
  root,
  [
    ["RS_RECEIVER_MODE", "live"],
    ["RS_RECEIVER_URL", "ws://127.0.0.1:4000/render-stream"],
    ["RS_RECEIVER_OUT", `${root}/live-auth/receiver/applied.json`],
    ["RS_RECEIVER_CACHE_DIR", `${root}/live-auth/receiver/cache`],
    ["RS_RECEIVER_TOKEN_FILE", `${root}/live-auth/host/evidence/live-token`],
    ["RS_RECEIVER_SHOT_WINDOWS", "0:307-359"],
    ["GRC_SOMETHING", "x"],
  ],
  ["/bin/godot", "--path", "/receiver", "--max-fps", "60"],
  () => token,
);
expect(
  "live: OUT becomes a URL path under the static root",
  live.env.RS_RECEIVER_OUT === "/live-auth/receiver/applied.json",
  live.env.RS_RECEIVER_OUT,
);
expect(
  "live: cache dir and token file dropped, the token kept for the fragment only",
  live.env.RS_RECEIVER_CACHE_DIR === undefined &&
    live.env.RS_RECEIVER_TOKEN_FILE === undefined &&
    live.token === token &&
    !JSON.stringify(live.env).includes(token),
);
expect(
  "live: RS_RECEIVER_PROTOCOL=7, windows verbatim, non-RS words dropped",
  live.env.RS_RECEIVER_PROTOCOL === "7" &&
    live.env.RS_RECEIVER_SHOT_WINDOWS === "0:307-359" &&
    live.dropped.includes("GRC_SOMETHING"),
);
expect(
  "live: engine args after --path, default canvas, not headless, not warm",
  JSON.stringify(live.engineArgs) === '["--max-fps","60"]' &&
    live.canvas[0] === 640 &&
    live.canvas[1] === 360 &&
    !live.headless &&
    live.warmFrom === null &&
    live.env.RS_RECEIVER_CREDIT_STAGE === undefined,
);
const headless = mapBrowserLeg(
  root,
  [
    ["RS_RECEIVER_MODE", "live"],
    ["RS_RECEIVER_OUT", `${root}/live-headless/receiver/applied.json`],
  ],
  ["/bin/godot", "--headless", "--max-fps", "60", "--path", "/receiver"],
);
expect(
  "headless native leg: rendered in the browser with credit stage applied",
  headless.headless && headless.env.RS_RECEIVER_CREDIT_STAGE === "applied",
  JSON.stringify(headless.env),
);
const named = mapBrowserLeg(
  root,
  [
    ["RS_RECEIVER_MODE", "live"],
    ["RS_RECEIVER_OUT", `${root}/x/receiver/applied.json`],
    ["RS_RECEIVER_CREDIT_STAGE", "submitted"],
  ],
  [
    "/bin/godot",
    "--headless",
    "--path",
    "/receiver",
    "--resolution",
    "960x540",
  ],
);
expect(
  "a named credit stage is kept; --resolution becomes the canvas",
  named.env.RS_RECEIVER_CREDIT_STAGE === "submitted" &&
    named.canvas[0] === 960 &&
    named.canvas[1] === 540,
);
const warm = mapBrowserLeg(
  root,
  [
    ["RS_RECEIVER_MODE", "live"],
    ["RS_RECEIVER_OUT", `${root}/live-warm/receiver/applied.json`],
    ["RS_RECEIVER_CACHE_DIR", `${root}/live/receiver/cache`],
    ["RS_RECEIVER_CACHE_MODE", "warm"],
  ],
  ["/bin/godot", "--path", "/receiver"],
);
expect(
  "warm leg names its cold leg's receiver directory",
  warm.warmFrom === `${root}/live/receiver`,
  String(warm.warmFrom),
);
const replay = mapBrowserLeg(
  root,
  [
    ["RS_RECEIVER_RECORDING", `${root}/live-replay/recording.rs2`],
    ["RS_RECEIVER_OUT", `${root}/live-replay/applied.json`],
    ["RS_RECEIVER_STORE_DIR", `${root}/live/host/store`],
    ["RS_RECEIVER_SHOT_SEQS", "3,5"],
  ],
  ["/bin/godot", "--path", "/receiver"],
);
expect(
  "file-mode replay: recording and store are URL paths, no protocol added",
  replay.env.RS_RECEIVER_RECORDING === "/live-replay/recording.rs2" &&
    replay.env.RS_RECEIVER_STORE_DIR === "/live/host/store" &&
    replay.env.RS_RECEIVER_PROTOCOL === undefined &&
    !replay.live,
);
expect(
  "a path outside the static root is refused",
  throws(() =>
    mapBrowserLeg(
      root,
      [["RS_RECEIVER_OUT", "/elsewhere/applied.json"]],
      ["/bin/godot"],
    ),
  ),
);
expect(
  "a live leg asking for /6 is refused",
  throws(() =>
    mapBrowserLeg(
      root,
      [
        ["RS_RECEIVER_MODE", "live"],
        ["RS_RECEIVER_OUT", `${root}/a/applied.json`],
        ["RS_RECEIVER_PROTOCOL", "6"],
      ],
      ["/bin/godot"],
    ),
  ),
);

// 2. wireVersionOf / summarizeRecording
const rs7 = new Uint8Array(
  readFileSync(join(PROTOCOL, "golden-7", "rate.rs7")),
);
const rs6 = new Uint8Array(
  readFileSync(join(PROTOCOL, "golden-6", "inline.rs6")),
);
expect(
  "wireVersionOf: GRS7 -> 7, GRS6 -> 6, short -> 6",
  wireVersionOf(rs7) === 7 &&
    wireVersionOf(rs6) === 6 &&
    wireVersionOf(rs7.subarray(0, 4)) === 6,
);
const s7 = summarizeRecording("rate.rs7", rs7);
const s6 = summarizeRecording("inline.rs6", rs6);
expect(
  "summarizeRecording validates golden-7 rate.rs7 as /7 and golden-6 inline.rs6 as /6",
  s7.errors.length === 0 &&
    s7.transactions.length > 0 &&
    s7.session?.protocol === "render-stream/7" &&
    s6.errors.length === 0 &&
    s6.session?.protocol === "render-stream/6",
  `${s7.errors[0] ?? ""} ${s6.errors[0] ?? ""}`,
);
const grs5 = new Uint8Array(rs6);
grs5[3] = 0x35;
expect(
  "a GRS5 magic still meets the /6 decoder's refusal",
  summarizeRecording("x", grs5).errors.length > 0,
);

// 3. receivedFileName
const tmp = mkdtempSync(join(tmpdir(), "g7l-selftest-"));
try {
  mkdirSync(join(tmp, "a"));
  mkdirSync(join(tmp, "b"));
  writeFileSync(join(tmp, "a", "received.rs7"), "");
  writeFileSync(join(tmp, "a", "received-2.rs7"), "");
  writeFileSync(join(tmp, "b", "received.rs2"), "");
  expect(
    "receivedFileName: .rs7 when present, else .rs2",
    receivedFileName(join(tmp, "a")) === "received.rs7" &&
      receivedFileName(join(tmp, "a"), 2) === "received-2.rs7" &&
      receivedFileName(join(tmp, "b")) === "received.rs2" &&
      receivedFileName(join(tmp, "b"), 2) === "received-2.rs2",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 4. getsVsFetches
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const get = (hash: string, bytes: number): HookLine =>
  ({
    op: "http-get",
    hash,
    http_status: 200,
    payload_bytes: bytes,
  }) as unknown as HookLine;
const fetch = (hash: string, bytes: number, etag: boolean): G2cFetch =>
  ({
    source: "http",
    hash,
    status: 200,
    bytes,
    verified: true,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(bytes),
      ...(etag ? { ETag: `"${hash}"` } : {}),
    },
  }) as unknown as G2cFetch;
const gets = [get(H1, 10), get(H2, 20)];
const webFetches = [
  fetch(H1, 10, false),
  fetch(H2, 20, false),
  fetch(H1, 10, false),
];
expect(
  "http-cache: a repeat is the browser cache's; GETs equal first fetches; ETag absent is right",
  getsVsFetches(gets, webFetches, "http-cache").length === 0,
  getsVsFetches(gets, webFetches, "http-cache").join("; "),
);
expect(
  "http-cache: an exposed ETag or a second GET is still caught",
  getsVsFetches(gets, [fetch(H1, 10, true), fetch(H2, 20, false)], "http-cache")
    .length > 0 &&
    getsVsFetches([...gets, get(H1, 10)], webFetches, "http-cache").length > 0,
);
const nativeFetches = [fetch(H1, 10, true), fetch(H2, 20, true)];
expect(
  "native: /6 rules unchanged (exact list, ETag required, a repeat flagged)",
  getsVsFetches(gets, nativeFetches, "fresh").length === 0 &&
    getsVsFetches(gets, [...nativeFetches, fetch(H1, 10, true)], "fresh").some(
      (p) => p.includes("fetched 2 times"),
    ) &&
    getsVsFetches(gets, [fetch(H1, 10, false), fetch(H2, 20, true)], undefined)
      .length > 0,
);

// 5. warmCacheProblems
expect(
  "warm (native): 0 fetched, cache hits = cold fetches, mode warm",
  warmCacheProblems(
    {
      cache: { mode: "warm" },
      resources_summary: { distinct_fetched: 0, cache_hits: 9 },
    },
    9,
  ).length === 0 &&
    warmCacheProblems(
      {
        cache: { mode: "warm" },
        resources_summary: { distinct_fetched: 1, cache_hits: 9 },
      },
      9,
    ).length > 0,
);
expect(
  "warm (http-cache): exactly the cold leg's fetches, all 200",
  warmCacheProblems(
    {
      cache: { mode: "http-cache" },
      resources_summary: { distinct_fetched: 2 },
      fetches: [{ status: 200 }, { status: 200 }],
    },
    2,
  ).length === 0 &&
    warmCacheProblems(
      {
        cache: { mode: "http-cache" },
        resources_summary: { distinct_fetched: 2 },
        fetches: [{ status: 200 }, { status: 404 }],
      },
      2,
    ).length > 0 &&
    warmCacheProblems(
      {
        cache: { mode: "http-cache" },
        resources_summary: { distinct_fetched: 1 },
        fetches: [],
      },
      2,
    ).length > 0,
);

// 6. credit-from-paced-loop.
const web = (submitted: number | undefined) => ({
  receiver: { kind: "web-export" },
  transactions: [
    { seq: 1, process_frame: 10, submitted_us: 5, submitted_process_frame: 10 },
    {
      seq: 2,
      process_frame: 11,
      submitted_us: 6,
      submitted_process_frame: submitted,
    },
    { seq: 3, process_frame: 12, submitted_us: null },
  ],
});
expect(
  "paced: web, same process frame",
  pacedLoopProblems("l", web(11)).length === 0,
);
expect(
  "paced: web, ack a frame later fails",
  pacedLoopProblems("l", web(12)).length === 1,
);
const gsw = (paced: Record<string, unknown>) => ({
  receiver: { kind: "gsw-canvas" },
  transactions: [{ seq: 4, submitted_us: 9, paced }],
});
const good = {
  applied_raf: 14,
  drawn_raf: 14,
  drawn_ms: 315.1,
  submitted_ack_ms: 315.1,
  submitted_from: "raf",
};
expect(
  "paced: gsw, applied+drawn+acked in one rAF",
  pacedLoopProblems("l", gsw(good)).length === 0,
);
expect(
  "paced: gsw, ack-on-receipt (from onmessage) fails",
  pacedLoopProblems("l", gsw({ ...good, submitted_from: "onmessage" }))
    .length === 1,
);
expect(
  "paced: gsw, drawn in a later rAF fails",
  pacedLoopProblems("l", gsw({ ...good, drawn_raf: 15 })).length === 1,
);
expect(
  "paced: gsw, ack before the draw fails",
  pacedLoopProblems("l", gsw({ ...good, submitted_ack_ms: 314 })).length === 1,
);

// 7. known failures.
const mesh = (detail: string) => ({
  id: "receiver-vs-reference",
  passed: false,
  detail,
});
expect(
  "known: web g5f RM/DF only is named",
  knownFailure(
    "web",
    "gate5",
    mesh(
      "live-mesh step 4 (seq 340): 936 px differ in RM; step 5: 2216 px differ in DF,RM",
    ),
  ) !== undefined,
);
expect(
  "known: another region is not",
  knownFailure(
    "web",
    "gate5",
    mesh("step 4: 936 px differ in RM; step 6: 12 px differ in TX"),
  ) === undefined,
);
expect(
  "known: gsw never",
  knownFailure("gsw", "gate5", mesh("step 4: 936 px differ in RM")) ===
    undefined,
);
expect(
  "known: never on the rust web core (G7xwl: it issues the update)",
  knownFailure("web", "gate5", mesh("step 4: 936 px differ in RM"), "rust") ===
    undefined,
);

// 8. G7xwl: the web core on a live run.
const coreRoot = mkdtempSync(join(tmpdir(), "self-test-gate7xwl-"));
const bundleOf = (core: string | undefined): string => {
  const dir = join(coreRoot, `bundle-${core ?? "none"}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "build.json"),
    JSON.stringify({
      pck: { sha256: "0".repeat(64) },
      ...(core ? { core } : {}),
    }),
  );
  return dir;
};
expect(
  "core: default gdscript, no env word",
  JSON.stringify(
    coreEnv({
      kind: "web",
      ...webCoreOf("web", bundleOf(undefined), undefined, undefined),
    }),
  ) === "{}",
);
expect(
  "core: rust on a rust bundle adds RS_RECEIVER_CORE=rust",
  coreEnv({
    kind: "web",
    ...webCoreOf("web", bundleOf("rust"), "rust", undefined),
  }).RS_RECEIVER_CORE === "rust",
);
expect(
  "core: rust on a gdscript bundle is refused",
  throws(() => webCoreOf("web", bundleOf("gdscript"), "rust", undefined)) &&
    throws(() => webCoreOf("web", bundleOf(undefined), "rust", undefined)),
);
expect(
  "core: an unknown core or sabotage is refused",
  throws(() => webCoreOf("web", bundleOf("rust"), "wasm", undefined)) &&
    throws(() => webCoreOf("web", bundleOf("rust"), "rust", "skip")),
);
expect(
  "core: drop-env keeps core rust but adds no env word",
  (() => {
    const c = webCoreOf("web", bundleOf("rust"), "rust", "drop-env");
    return (
      c.core === "rust" &&
      c.coreSabotage === "drop-env" &&
      coreEnv({ kind: "web", ...c }).RS_RECEIVER_CORE === undefined
    );
  })(),
);
expect(
  "core: gsw never gets the word",
  JSON.stringify(coreEnv({ kind: "gsw", core: "rust" })) === "{}",
);
const legOf = (
  name: string,
  stdout: string | null,
  appliedCore: string | null | undefined,
  resources: string[],
  /** A SIGKILLed leg (gate 1's `killed`): its engine lines only in console.jsonl, its page state
   * never read (timings.json `aborted`, no resources). */
  killedConsole?: string,
): string => {
  const dir = join(coreRoot, name);
  mkdirSync(dir, { recursive: true });
  if (stdout !== null) writeFileSync(join(dir, "stdout.log"), stdout);
  if (appliedCore !== null)
    writeFileSync(
      join(dir, "applied.json"),
      JSON.stringify({
        receiver: appliedCore === undefined ? {} : { core: appliedCore },
      }),
    );
  if (killedConsole !== undefined)
    writeFileSync(
      join(dir, "console.jsonl"),
      `${JSON.stringify({ t: 1, type: "log", text: "Godot Engine v4.5.1" })}\n${JSON.stringify({ t: 2, type: "log", text: killedConsole })}\n`,
    );
  writeFileSync(
    join(dir, "timings.json"),
    JSON.stringify({
      ...(killedConsole !== undefined ? { aborted: true } : {}),
      resources: resources.map((n) => ({ name: n })),
    }),
  );
  return dir;
};
const MODULE = `http://127.0.0.1:1/web-bundle/${RS_CORE_SIDE_MODULE}`;
const rustLine = "[rs] core rust (res://ext/rs_core.gdextension)\n";
expect(
  "receiver-core: an honest rust leg passes",
  (
    await receiverCoreProblems(
      legOf("r-ok", `x\n${rustLine}`, "rust", [MODULE]),
      "r-ok",
      "rust",
    )
  ).length === 0,
);
expect(
  "receiver-core: a killed rust leg (empty stdout, no applied.json, page unread) passes on console.jsonl",
  (
    await receiverCoreProblems(
      legOf("r-killed", "\n", null, [], rustLine.trim()),
      "r-killed",
      "rust",
    )
  ).length === 0,
);
expect(
  "receiver-core: a killed drop-env leg fails on console.jsonl",
  (
    await receiverCoreProblems(
      legOf("r-killed-drop", "\n", null, [], "[receiver] mode live"),
      "r-killed-drop",
      "rust",
    )
  ).length === 1,
);
expect(
  "receiver-core: drop-env (rust bundle, GDScript ran) fails twice",
  (
    await receiverCoreProblems(
      legOf("r-drop", "x\n", "gdscript", [MODULE]),
      "r-drop",
      "rust",
    )
  ).length === 2,
);
expect(
  "receiver-core: a rust leg whose page never fetched the module fails",
  (
    await receiverCoreProblems(
      legOf("r-nomod", rustLine, "rust", []),
      "r-nomod",
      "rust",
    )
  ).length === 1,
);
expect(
  "receiver-core: a gdscript leg passes (pre-G7xn applied.json: no core key)",
  (
    await receiverCoreProblems(
      legOf("g-ok", "x\n", undefined, []),
      "g-ok",
      "gdscript",
    )
  ).length === 0,
);
expect(
  "receiver-core: a rust leg on a gdscript run fails",
  (
    await receiverCoreProblems(
      legOf("g-rust", rustLine, "rust", [MODULE]),
      "g-rust",
      "gdscript",
    )
  ).length === 2,
);
rmSync(coreRoot, { recursive: true, force: true });

console.log(
  failures === 0
    ? "self-test-gate7l: all checks correct"
    : `self-test-gate7l: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
