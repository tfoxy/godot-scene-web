#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for R3's CI-only software-renderer allowance (lib/browser-renderer.ts; docs/remote-compute.md,
// Decision 10). Pure: no browser, every environment injected. The real launch-time proof is the
// browser self-test (self-test-browser-harness.ts), whose sabotage case still refuses SwiftShader
// locally; this one pins the rule that decides when the allowance applies.

import {
  allowanceProblems,
  ciRendererAllowance,
  isDeclaredRenderer,
  launchArgsFor,
  legProvenanceProblems,
  provenanceCriterion,
  rendererRefusal,
} from "../lib/browser-renderer";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}
function throws(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const CI = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
const NVIDIA =
  "ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA NVIDIA GeForce RTX 2060 (0x00001F03)), NVIDIA)";
const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
// recorded on a GitHub-hosted runner (R3 run 39797635413, Mesa 25.2.8, --ignore-gpu-blocklist)
const LAVAPIPE =
  "ANGLE (Mesa, Vulkan 1.4.318 (llvmpipe (LLVM 20.1.2 256 bits) (0x00000000)), llvmpipe)";
const ANGLE_GL = "ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL 4.5)";

// 1. When the allowance applies.
check("default: no allowance", ciRendererAllowance({}) === null);
check(
  "CI without RS_BROWSER_PROVENANCE: no allowance",
  ciRendererAllowance(CI) === null,
);
check(
  "empty RS_BROWSER_PROVENANCE: no allowance",
  ciRendererAllowance({ ...CI, RS_BROWSER_PROVENANCE: "" }) === null,
);
const local = throws(() =>
  ciRendererAllowance({ RS_BROWSER_PROVENANCE: "lavapipe" }),
);
check(
  "local RS_BROWSER_PROVENANCE: a hard error naming the rule",
  local !== null && /CI-only/.test(local) && /github-hosted/.test(local),
  local ?? "",
);
check(
  "GITHUB_ACTIONS alone (self-hosted runner): a hard error",
  throws(() =>
    ciRendererAllowance({
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "self-hosted",
      RS_BROWSER_PROVENANCE: "lavapipe",
    }),
  ) !== null,
);
check(
  "RUNNER_ENVIRONMENT alone: a hard error",
  throws(() =>
    ciRendererAllowance({
      RUNNER_ENVIRONMENT: "github-hosted",
      RS_BROWSER_PROVENANCE: "lavapipe",
    }),
  ) !== null,
);
for (const r of ["llvmpipe-gl", "swiftshader"])
  check(
    `unknown renderer ${r}: a hard error, even on CI`,
    throws(() => ciRendererAllowance({ ...CI, RS_BROWSER_PROVENANCE: r })) !==
      null,
  );
const lp = ciRendererAllowance({ ...CI, RS_BROWSER_PROVENANCE: "lavapipe" });
check(
  "CI + lavapipe: the allowance",
  lp?.renderer === "lavapipe" && lp.runner_environment === "github-hosted",
);
if (!lp) process.exit(1);

// 2. The renderer rule.
check(
  "NVIDIA default accepts the RTX 2060",
  rendererRefusal(NVIDIA, null) === null,
);
for (const r of [SWIFTSHADER, LAVAPIPE, ANGLE_GL])
  check(
    `NVIDIA default refuses ${r.slice(0, 40)}...`,
    rendererRefusal(r, null) !== null,
  );
check(
  "the NVIDIA refusal text is D9's",
  rendererRefusal(SWIFTSHADER, null) ===
    `renderer "${SWIFTSHADER}" does not name ANGLE, NVIDIA and Vulkan together (SwiftShader or another backend may have been selected)`,
);
check("lavapipe accepts lavapipe", isDeclaredRenderer(LAVAPIPE, lp));
check("lavapipe refuses SwiftShader", !isDeclaredRenderer(SWIFTSHADER, lp));
check("lavapipe refuses NVIDIA", !isDeclaredRenderer(NVIDIA, lp));
check("lavapipe refuses ANGLE on GL", !isDeclaredRenderer(ANGLE_GL, lp));

// 3. Launch flags.
const d9 = [
  "--headless=new",
  "--enable-gpu",
  "--use-angle=vulkan",
  "--force-device-scale-factor=1",
  "--force-color-profile=srgb",
];
check("default flags are D9's, the same array", launchArgsFor(d9, null) === d9);
check(
  "lavapipe keeps D9's flags and adds --ignore-gpu-blocklist",
  JSON.stringify(launchArgsFor(d9, lp)) ===
    JSON.stringify([...d9, "--ignore-gpu-blocklist"]),
);
check(
  "the self-test's SwiftShader sabotage is refused locally and under lavapipe",
  [null, lp].every((j) => rendererRefusal(SWIFTSHADER, j) !== null),
);

// 4. The checkers' re-judgement of a leg's provenance.json.
const nvLeg = { ok: true, reasons: [], renderer: NVIDIA };
const lpLeg = {
  ok: true,
  reasons: [],
  renderer: LAVAPIPE,
  ci_renderer_allowance: lp,
};
check(
  "NVIDIA leg, NVIDIA checker: passes",
  legProvenanceProblems(nvLeg, null).length === 0,
);
check(
  "NVIDIA path adds no allowance problem",
  allowanceProblems(nvLeg, null).length === 0 &&
    allowanceProblems({ ok: false, reasons: ["x"] }, null).length === 0,
);
check(
  "a refused NVIDIA leg keeps its reasons",
  legProvenanceProblems({ ok: false, reasons: ["a", "b"] }, null).join("|") ===
    "a, b",
);
check(
  "missing provenance.json is a problem",
  legProvenanceProblems(null, null)[0] === "no provenance.json",
);
check(
  "CI leg, same CI checker: passes",
  legProvenanceProblems(lpLeg, lp).length === 0,
);
check(
  "CI leg judged locally: refused",
  legProvenanceProblems(lpLeg, null).some((x) => /NVIDIA default/.test(x)),
);
check(
  "NVIDIA leg judged under an allowance: refused",
  legProvenanceProblems(nvLeg, lp).length > 0,
);
check(
  "a leg claiming lavapipe that rendered on SwiftShader: refused",
  legProvenanceProblems({ ...lpLeg, renderer: SWIFTSHADER }, lp).length > 0,
);

// 5. Criterion text: the NVIDIA wording is byte-for-byte D9's.
check(
  "web criterion unchanged by default",
  provenanceCriterion("web", null) ===
    "Q6/D9: every web leg's browser names ANGLE, NVIDIA and Vulkan, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary",
);
check(
  "gsw criterion unchanged by default",
  provenanceCriterion("gsw", null) ===
    "Q6/D9: every gsw leg's browser names ANGLE, NVIDIA and Vulkan, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary",
);
check(
  "CI criterion names the declared renderer",
  /lavapipe/.test(provenanceCriterion("gsw", lp)) &&
    !/NVIDIA/.test(provenanceCriterion("gsw", lp)),
);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
