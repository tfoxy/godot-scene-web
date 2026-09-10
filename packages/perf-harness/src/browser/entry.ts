// esbuild entry for the in-page bundle. Kept trivial on purpose: everything testable lives in
// runtime.ts and the scenario modules.

import { installPerfHarness } from "./runtime";

void installPerfHarness().catch((error: unknown) => {
  const seam = window.__perfHarness;
  if (seam) {
    seam.error = error instanceof Error ? error.message : String(error);
  }
  // Surface it in the page too, so `--serve` shows the failure instead of a blank screen.
  const banner = document.createElement("pre");
  banner.style.color = "#ff6b6b";
  banner.style.font = "12px monospace";
  banner.textContent = `perf-harness failed: ${String(error)}`;
  document.body.appendChild(banner);
});
