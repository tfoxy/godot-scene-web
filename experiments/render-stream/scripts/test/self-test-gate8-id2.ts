// Fabricated evidence verifies fail-closed checks; live legs exercise the public client separately.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PICKED } from "../lib/gate8-id-checks";
import {
  PURE_HELLO,
  restampProblems,
  runG8id2,
  TAG1_HELLO,
} from "../lib/gate8-id2-checks";

const points = Array.from({ length: 384 }, (_, i) => PICKED[i % PICKED.length]);
const oracle = [
  {
    process_frames: 139,
    flips: [{ step: 40, node: "Flipper", mouse_filter: 2 }],
  },
  {
    process_frames: 149,
    flips: [{ step: 50, node: "Flipper", mouse_filter: 1 }],
  },
];
const samples = [
  { seq: 1, frame: 139, target: "Flipper", instanceId: "9007199254740993" },
  { seq: 2, frame: 142, target: null },
  { seq: 3, frame: 149, target: null },
  { seq: 4, frame: 152, target: "Flipper", instanceId: "9007199254740993" },
];
function report(mode: string) {
  const pure = mode === "pure" || mode === "tag1";
  return {
    mode,
    sabotage: mode === "sabotage" ? "ignore-host-filter" : null,
    gpuFormats: "none",
    provenance: { ok: true },
    statuses: [{ kind: "streaming", firstFrame: true }, { kind: "ended" }],
    offers: [pure ? "render-stream.13" : "render-stream.14"],
    hellos: [mode === "tag1" ? TAG1_HELLO : PURE_HELLO],
    grant: pure ? null : { fields: ["mouse_filter", "instance_id"] },
    statements: mode === "restamp" || mode === "sabotage" ? 1 : 0,
    pick: { size: [640, 360], grid: [24, 16], points: [...points] },
    samples:
      mode === "sabotage"
        ? samples.map((s) => ({ ...s, target: "Flipper" }))
        : structuredClone(samples),
  };
}
let assertions = 0;
async function run(
  edit?: (data: Record<string, ReturnType<typeof report>>) => void,
  skip = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "self-test-gate8-id2-"));
  try {
    const data = Object.fromEntries(
      ["pick", "restamp", "pure", "tag1", "sabotage-ignore-host-filter"].map(
        (leg) => [leg, report(leg.startsWith("sabotage") ? "sabotage" : leg)],
      ),
    );
    edit?.(data);
    for (const [leg, r] of Object.entries(data)) {
      const d = join(dir, leg);
      mkdirSync(join(d, "page"), { recursive: true });
      mkdirSync(join(d, "host"));
      writeFileSync(join(d, "page/client-id2.json"), JSON.stringify(r));
      writeFileSync(
        join(d, "host/pick-oracle.json"),
        JSON.stringify({ frame: 80, size: [640, 360], grid: [24, 16], points }),
      );
      writeFileSync(
        join(d, "host/oracle.jsonl"),
        oracle.map((o) => JSON.stringify(o)).join("\n"),
      );
      if (skip && leg.startsWith("sabotage"))
        writeFileSync(join(d, "skipped-by-tier.txt"), "smoke");
    }
    return await runG8id2(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const good = await run();
for (const c of good) {
  assert.equal(c.status, "pass", `${c.id}: ${c.detail}`);
  assertions++;
}
async function fails(id: string, edit: Parameters<typeof run>[0]) {
  const c = (await run(edit)).find((c) => c.id === id);
  assert.equal(c?.status, "fail", `${id} should fail`);
  assertions++;
}
await fails("pick-oracle-host", (d) => {
  d.pick.pick.points[0] = "wrong" as (typeof PICKED)[number];
});
await fails("pick-oracle-host", (d) => {
  d.pick.statements = 1;
});
await fails("pick-oracle-host", (d) => {
  d.pick.grant = null;
});
await fails("pick-oracle-host", (d) => {
  d.pick.provenance.ok = false;
});
await fails("pick-oracle-host", (d) => {
  d.pick.statuses.pop();
});
await fails("restamp-reaches-pick", (d) => {
  d.restamp.samples = d.restamp.samples.map((s) => ({
    ...s,
    target: "Flipper",
  }));
});
await fails("restamp-reaches-pick", (d) => {
  d.restamp.samples[1].frame = 143;
});
await fails("restamp-reaches-pick", (d) => {
  d.restamp.samples = [];
});
await fails("restamp-reaches-pick", (d) => {
  d.restamp.samples[3].instanceId = undefined;
});
await fails("hello-pure", (d) => {
  d.pure.hellos[0] += " ";
});
await fails("hello-pure", (d) => {
  d.pure.offers[0] = "render-stream.14";
});
await fails("hello-tag1", (d) => {
  d.tag1.hellos[0] = PURE_HELLO;
});
await fails("sabotage-ignore-host-filter-caught", (d) => {
  d["sabotage-ignore-host-filter"].samples = samples;
});
assert.equal((await run(undefined, true)).at(-1)?.status, "not-run");
assertions++;
assert.notEqual(restampProblems(samples, []).length, 0);
assertions++;
console.log(`self-test-gate8-id2: ${assertions} passed, 0 failed`);
