// Offline first-reference probe: the production StreamLoop with its package's scripted
// core/transport and manual clock. This measures deferral, not GPU pixels or network latency.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  flush,
  harness,
  session,
  tx,
} from "../../../../packages/render-stream-client/test/fakes";

const root = process.argv[2];
assert(root, "usage: probe-client-payloads.ts <resident probe directory>");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const arms = read(join(root, "rearm-report.json"));
const reports = [];
let checks = 0;
for (const arm of arms) {
  const evidence =
    arm.round === 0 ? "evidence" : `evidence/arm-${arm.round + 1}`;
  const rows = readFileSync(join(root, evidence, "resources.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const adopted = rows.find(
    (row) =>
      row.op === "adopt" &&
      row.kind === "image" &&
      String(row.rid) === String(arm.post_publish.rid),
  );
  assert(adopted, "fixture's post-publish texture must be adopted");
  const browser = read(join(root, `browser-${arm.round}`, "applied.json"));
  const upload = browser.uploads.find(
    (row: { id: number; op: string }) =>
      row.id === adopted.id && row.op === "create",
  );
  assert(upload, "fixture's post-publish texture must have a wire payload");
  for (const hold of [0, 150, Number.POSITIVE_INFINITY]) {
    const h = harness(2, {
      creditStage: "submitted",
      applyOn: "frame",
      resourceHoldMs: hold,
    });
    h.core.enforceProvided = true;
    h.loop.connect();
    const transport = h.last();
    transport.on.open();
    transport.on.message(session(2));
    transport.on.message(tx(1));
    h.clock.frame();
    assert(
      h.core.calls.includes("draw 1"),
      "initial state must be drawn complete",
    );
    transport.on.message(tx(2, [upload.hash], false));
    const referencedAt = h.clock.t;
    let deferredAt: number | null = null;
    for (let frame = 0; frame < 90; frame++) {
      h.clock.frame();
      if (deferredAt === null && h.core.calls.includes(`defer ${upload.hash}`))
        deferredAt = h.clock.t;
    }
    assert.equal(
      transport.gets.length,
      1,
      "one fetch while payload is pending",
    );
    assert.equal(h.core.calls.includes("draw 2"), Number.isFinite(hold));
    assert.equal(
      h.loop.stats().deferredPayloads,
      Number.isFinite(hold) ? 1 : 0,
    );
    const deliveredAt = h.clock.t;
    transport.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    assert(
      h.core.calls.includes("draw 2"),
      "payload arrival must draw the texture",
    );
    assert.equal(h.loop.stats().deferredPayloads, 0);
    if (Number.isFinite(hold)) {
      assert(h.core.calls.includes(`take ${upload.hash}`));
      assert(
        h.core.calls.includes("revisit 2"),
        "arrival must repair without another transaction",
      );
    }
    reports.push({
      round: arm.round,
      hash: upload.hash,
      hold_ms: Number.isFinite(hold) ? hold : "Infinity",
      referenced_at_ms: referencedAt,
      deferred_at_ms: deferredAt,
      delivered_at_ms: deliveredAt,
      drawn_at_ms: h.clock.t,
      omission_ms: deferredAt === null ? 0 : h.clock.t - deferredAt,
      cold: h.loop.stats().coldPayloadLog,
      calls: h.core.calls,
    });
    checks++;
    h.loop.dispose();
  }
}
writeFileSync(
  join(root, "production-client-report.json"),
  `${JSON.stringify({ clock: "manual, 16.7 ms/frame", reports }, null, 2)}\n`,
);
console.log(`probe-client-payloads: ${checks} cases passed, 0 failed`);
