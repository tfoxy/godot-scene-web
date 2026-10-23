// The CI-only software-renderer allowance for gate 7's browser legs (docs/remote-compute.md R3,
// Decision 10). Dependency-free: browser-harness.ts uses it to pick the launch flags and to judge
// the renderer string, and the checkers' browser-provenance echoes (gate7-adapters.ts,
// gate7b-adapters.ts, gate7-gsw.ts) use it to re-judge each leg's provenance.json.
//
// The default is the D9 refusal: a browser leg must render on ANGLE + NVIDIA + Vulkan (this box's
// RTX 2060). GitHub-hosted runners have no GPU, so there, and only there, an explicit
// RS_BROWSER_PROVENANCE names the software renderer a run declares:
//
//   lavapipe     ANGLE's Vulkan backend on Mesa's lavapipe (`--use-angle=vulkan`, mesa-vulkan-drivers)
//
// lavapipe is the only one (R3): it rasterizes on the same llvmpipe as the runner's native sources,
// so every NVIDIA checker model held unchanged on it. Chromium's bundled SwiftShader was tried and
// dropped (run 39801064520: delta1 bands up to 204 levels against the llvmpipe sources).
// The allowance needs all three of GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted and
// RS_BROWSER_PROVENANCE. RS_BROWSER_PROVENANCE anywhere else is a hard error, never a silent
// fallback, and the renderer string must then name the DECLARED renderer: a run that declares
// lavapipe and lands on SwiftShader (Chromium's fallback) is refused like any other mismatch.
// Device legs (checkDeviceProvenance) never consult this: they stay refused remotely.

export const SOFTWARE_RENDERERS = ["lavapipe"] as const;
export type SoftwareRenderer = (typeof SOFTWARE_RENDERERS)[number];

export interface RendererAllowance {
  renderer: SoftwareRenderer;
  /** What made it apply, recorded in every leg's provenance.json. */
  github_actions: "true";
  runner_environment: "github-hosted";
}

type Env = Readonly<Record<string, string | undefined>>;

/** The allowance in force for `env`, or null (the NVIDIA default). Throws when
 * RS_BROWSER_PROVENANCE is set off a GitHub-hosted runner, or names an unknown renderer. */
export function ciRendererAllowance(
  env: Env = process.env,
): RendererAllowance | null {
  const want = env.RS_BROWSER_PROVENANCE;
  if (want === undefined || want === "") return null;
  if (!(SOFTWARE_RENDERERS as readonly string[]).includes(want))
    throw new Error(
      `RS_BROWSER_PROVENANCE=${want}: not a known software renderer (${SOFTWARE_RENDERERS.join(", ")})`,
    );
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    throw new Error(
      `RS_BROWSER_PROVENANCE=${want} is a CI-only switch (docs/remote-compute.md, Decision 10): it applies ` +
        "only on a GitHub-hosted runner (GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted). " +
        "Locally every browser leg must render on ANGLE + NVIDIA + Vulkan; unset RS_BROWSER_PROVENANCE.",
    );
  return {
    renderer: want as SoftwareRenderer,
    github_actions: "true",
    runner_environment: "github-hosted",
  };
}

/** D9's NVIDIA rule, unchanged. */
export function isNvidiaRenderer(renderer: string): boolean {
  return (
    /ANGLE/i.test(renderer) &&
    /NVIDIA/i.test(renderer) &&
    /Vulkan/i.test(renderer)
  );
}

/** Whether `renderer` (WEBGL_debug_renderer_info's unmasked string) is the declared software one.
 * lavapipe: "ANGLE (Mesa, Vulkan 1.4.318 (llvmpipe (LLVM 20.1.2 256 bits) (0x00000000)), llvmpipe)"
 * (R3 run 39797635413) -- never SwiftShader. */
export function isDeclaredRenderer(
  renderer: string,
  _allowance: RendererAllowance,
): boolean {
  if (!/ANGLE/i.test(renderer) || !/Vulkan/i.test(renderer)) return false;
  if (/NVIDIA/i.test(renderer)) return false;
  return /llvmpipe|lavapipe/i.test(renderer) && !/SwiftShader/i.test(renderer);
}

/** The renderer reason checkBrowserProvenance records, or null when the renderer is acceptable. */
export function rendererRefusal(
  renderer: string,
  allowance: RendererAllowance | null,
): string | null {
  if (!allowance)
    return isNvidiaRenderer(renderer)
      ? null
      : `renderer "${renderer}" does not name ANGLE, NVIDIA and Vulkan together (SwiftShader or another backend may have been selected)`;
  return isDeclaredRenderer(renderer, allowance)
    ? null
    : `renderer "${renderer}" is not ANGLE on Vulkan on the declared CI software renderer ${allowance.renderer} (RS_BROWSER_PROVENANCE)`;
}

/** D9's launch flags with the ANGLE backend the allowance needs. lavapipe keeps
 * `--use-angle=vulkan` (the Vulkan loader's only device on a GPU-less runner) and adds
 * `--ignore-gpu-blocklist`: Chromium blocklists llvmpipe, and without the flag the page got no WebGL2
 * context at all (R3 run 39791880071). */
export function launchArgsFor(
  nvidia: readonly string[],
  allowance: RendererAllowance | null,
): readonly string[] {
  if (!allowance) return nvidia;
  return [...nvidia, "--ignore-gpu-blocklist"];
}

export interface LegProvenance {
  ok?: boolean;
  reasons?: string[];
  renderer?: string | null;
  ci_renderer_allowance?: RendererAllowance;
}

/** The allowance half of a checker's re-judgement of one leg's provenance.json: a leg that ran
 * under the allowance must be judged by a checker under the SAME allowance (a provenance.json carried
 * off a runner and judged locally is refused, and so is an NVIDIA-default leg judged under an
 * allowance), and its renderer must be the declared one. Empty when neither side has an allowance:
 * the NVIDIA path adds nothing. */
export function allowanceProblems(
  p: LegProvenance | null | undefined,
  checker: RendererAllowance | null,
): string[] {
  const leg = p?.ci_renderer_allowance;
  if (!p || (!leg && !checker)) return [];
  if (leg?.renderer !== checker?.renderer)
    return [
      `the leg ran under ${leg ? `the CI ${leg.renderer} allowance` : "the NVIDIA default"} but this checker runs under ${checker ? `the CI ${checker.renderer} allowance` : "the NVIDIA default"}`,
    ];
  const r = checker ? rendererRefusal(p.renderer ?? "", checker) : null;
  return p.ok && r ? [r] : [];
}

/** A checker's re-judgement of one leg's provenance.json: the leg's own verdict, plus
 * allowanceProblems. Returns the problems (empty: the leg passes). */
export function legProvenanceProblems(
  p: LegProvenance | null | undefined,
  checker: RendererAllowance | null,
): string[] {
  if (!p) return ["no provenance.json"];
  const out: string[] = [];
  if (!p.ok) out.push(p.reasons?.join(", ") || "provenance not ok");
  return [...out, ...allowanceProblems(p, checker)];
}

/** The browser-provenance echo's criterion text. The NVIDIA wording is byte-for-byte the D9 one. */
export function provenanceCriterion(
  kind: "web" | "gsw",
  allowance: RendererAllowance | null,
): string {
  const who = kind === "web" ? "every web leg's" : "every gsw leg's";
  const renderer = allowance
    ? `ANGLE on Vulkan on the CI-declared software renderer ${allowance.renderer} (GitHub-hosted runner, RS_BROWSER_PROVENANCE)`
    : "ANGLE, NVIDIA and Vulkan";
  return `Q6/D9: ${who} browser names ${renderer}, holds no Wayland fd, had DISPLAY/WAYLAND_DISPLAY unset and is the recorded chromium-1223 binary`;
}

/** The echo's pass detail. */
export function provenancePassDetail(
  legs: number,
  allowance: RendererAllowance | null,
): string {
  return allowance
    ? `${legs} legs on the pinned Chromium, CI software renderer ${allowance.renderer}`
    : `${legs} legs on the pinned hardware Chromium`;
}
