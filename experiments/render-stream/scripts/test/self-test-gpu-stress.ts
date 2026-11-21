// Evidence-only checks: no rendered or device processes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate6c } from "../lib/gate6c-checks";

const out = await mkdtemp(join(tmpdir(), "gpu-stress-"));
try {
  const dir = join(out, "rates", "gpu-heavy");
  await mkdir(dir, { recursive: true });
  const reason =
    "gpu timing unavailable: /calibration/round-1/receiver/perf.json";
  await writeFile(join(dir, "failed.txt"), reason);
  const failed = (await runGate6c(out)).checks.find(
    (c) => c.id === "leg-gpu-heavy",
  );
  assert.equal(failed?.status, "fail");
  assert.equal(failed?.detail, reason);
  await rm(join(dir, "failed.txt"));
  await writeFile(join(dir, "skipped-opt-in.txt"), "gpu stress: opt-in\n");
  const skipped = (await runGate6c(out)).checks.find(
    (c) => c.id === "leg-gpu-heavy",
  );
  assert.equal(skipped?.status, "not-run");
  assert.equal(skipped?.passed, false);
  assert.equal(skipped?.detail, "gpu stress: opt-in");
  console.log("5 passed, 0 failed, 0 skipped (evidence summary assertions)");
} finally {
  await rm(out, { recursive: true, force: true });
}
