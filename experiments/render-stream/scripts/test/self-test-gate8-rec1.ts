#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8rec1 checks (lib/gate8-rec1-checks.ts, runG8rec1): a fabricated g8rec1 tree
// (live/page/client-record.json, live/page/recording.rs13, live/host/tap/stream-1.rs2) on which all four
// checks pass, then mutations that must fail each (recorder-streamed, recording-replays,
// recording-equals-tap, page-is-package-only), the missing-report case (must fail, not throw), the
// runner's `skipped.txt` ("host not listening", a gating failure) against the tier/remote markers
// (non-gating skips).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-rec1.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runG8rec1 } from "../lib/gate8-rec1-checks";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

interface Tree {
  report: Record<string, any> | null;
  recording: Buffer | null;
  tap: Buffer | null;
  markers: string[];
}
const good = (): Tree => ({
  report: {
    ended: true,
    last_applied: 12,
    recording: { records: 40, fullSeq: 1, overflow: false, resources: 3 },
    recording_bytes: 5,
    page_inputs: 30,
    page_harness_inputs: [],
    checks: [{ id: "recording-validates", passed: true, detail: "validate: ok" }],
  },
  recording: Buffer.from([1, 2, 3, 4, 5]),
  tap: Buffer.from([1, 2, 3, 4, 5]),
  markers: [],
});

function run(t: Tree) {
  const root = mkdtempSync(join(tmpdir(), "self-test-gate8-rec1-"));
  const put = (rel: string, c: string | Buffer) => {
    const p = join(root, "live", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  };
  if (t.report !== null) put("page/client-record.json", JSON.stringify(t.report));
  if (t.recording !== null) put("page/recording.rs13", t.recording);
  if (t.tap !== null) put("host/tap/stream-1.rs2", t.tap);
  for (const m of t.markers) put(m, "host not listening\n");
  return runG8rec1(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const IDS = ["recorder-streamed", "recording-replays", "recording-equals-tap", "page-is-package-only"];

async function main() {
  const ok = await run(good());
  expect(ok.length === 4, `good tree: four checks (${ok.length})`);
  for (const id of IDS) {
    const c = ok.find((x) => x.id === id);
    expect(c?.passed === true && c.gating === true, `good tree: ${id} passes (${c?.detail})`);
  }

  const bad = async (what: string, id: string, mutate: (t: Tree) => void, match?: RegExp) => {
    const t = good();
    mutate(t);
    let cs: Awaited<ReturnType<typeof run>> = [];
    try {
      cs = await run(t);
    } catch (e) {
      expect(false, `${what}: threw ${(e as Error).message}`);
      return;
    }
    const c = cs.find((x) => x.id === id);
    expect(c !== undefined && !c.passed && c.gating === true, `${what}: ${id} fails (${c?.detail})`);
    if (match) expect(match.test(c?.detail ?? ""), `${what}: detail names ${match} (${c?.detail})`);
  };

  // recorder-streamed
  const rs = "recorder-streamed";
  await bad("stream did not end", rs, (t) => (t.report!.ended = false), /did not end/);
  await bad("nothing applied", rs, (t) => (t.report!.last_applied = 0), /nothing applied/);
  await bad("last_applied absent", rs, (t) => delete t.report!.last_applied, /nothing applied/);
  await bad("recording null", rs, (t) => (t.report!.recording = null), /no recording/);
  await bad("recording absent", rs, (t) => delete t.report!.recording, /no recording/);
  await bad("report missing", rs, (t) => (t.report = null), /no client-record/);
  await bad("runner's skipped.txt (host not listening)", rs, (t) => t.markers.push("skipped.txt"), /did not run/);

  // recording-replays
  const rp = "recording-replays";
  await bad("driver ran no validate", rp, (t) => (t.report!.checks = []), /did not run/);
  await bad("no checks field", rp, (t) => delete t.report!.checks, /did not run/);
  await bad("validate failed", rp, (t) => (t.report!.checks[0].passed = false), /rs-core-check/);
  await bad("report missing", rp, (t) => (t.report = null), /did not run/);

  // recording-equals-tap
  const eq = "recording-equals-tap";
  await bad("bytes differ", eq, (t) => (t.recording = Buffer.from([1, 2, 9, 4, 5])), /differ first at 2/);
  await bad("recording shorter", eq, (t) => (t.recording = Buffer.from([1, 2, 3])), /differ/);
  await bad("recording missing", eq, (t) => (t.recording = null), /recording.rs13 is missing/);
  await bad("tap missing", eq, (t) => (t.tap = null), /tap .* missing/);
  await bad("both empty", eq, (t) => {
    t.recording = Buffer.alloc(0);
    t.tap = Buffer.alloc(0);
  }, /empty/);
  await bad("both missing", eq, (t) => {
    t.recording = null;
    t.tap = null;
  });

  // page-is-package-only
  const pk = "page-is-package-only";
  await bad("harness inputs present", pk, (t) => (t.report!.page_harness_inputs = ["web/gsw-receiver/x.ts"]), /1 inputs/);
  await bad("harness field absent", pk, (t) => delete t.report!.page_harness_inputs, /no page_harness_inputs/);
  await bad("harness field not an array", pk, (t) => (t.report!.page_harness_inputs = "none"), /no page_harness_inputs/);
  await bad("zero bundle inputs", pk, (t) => (t.report!.page_inputs = 0), /no bundle inputs/);
  await bad("page_inputs absent", pk, (t) => delete t.report!.page_inputs, /no bundle inputs/);
  await bad("report missing", pk, (t) => (t.report = null), /no client-record/);

  // Missing report: fails every report-driven check without throwing.
  {
    const t = good();
    t.report = null;
    let cs: Awaited<ReturnType<typeof run>> | null = null;
    try {
      cs = await run(t);
    } catch (e) {
      expect(false, `missing report threw ${(e as Error).message}`);
    }
    for (const id of ["recorder-streamed", "recording-replays", "page-is-package-only"])
      expect(cs?.find((x) => x.id === id)?.passed === false, `missing report: ${id} fails`);
  }

  // Empty leg directory: no evidence at all fails everything.
  {
    const cs = await run({ report: null, recording: null, tap: null, markers: [] });
    for (const id of IDS)
      expect(cs.find((x) => x.id === id)?.passed === false, `empty tree: ${id} fails`);
  }

  // Tier and remote markers skip without gating; skipped.txt does not.
  for (const m of ["skipped-by-tier.txt", "skipped-remote.txt"]) {
    const t = good();
    t.report = null;
    t.markers.push(m);
    const cs = await run(t);
    expect(cs.length === 1, `${m}: one placeholder check (${cs.length})`);
    expect(cs[0]?.gating === false && cs[0].passed === false && /skipped/.test(cs[0].detail), `${m}: non-gating skip (${cs[0]?.detail})`);
  }
  {
    const t = good();
    t.markers.push("skipped.txt");
    const cs = await run(t);
    expect(cs.every((c) => c.gating === true), "skipped.txt alone: gating");
    expect(cs.some((c) => c.id === "recorder-streamed" && !c.passed), "skipped.txt alone: recorder-streamed fails");
  }

  if (failures > 0) {
    console.error(`self-test-gate8-rec1: ${failures} of ${assertions} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`self-test-gate8-rec1: ${assertions}/${assertions} assertions passed`);
}

await main();
