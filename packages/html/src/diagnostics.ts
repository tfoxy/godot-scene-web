// Fail-loud diagnostics for the live shader + particle runtimes. When a node can't be rendered by the runtime
// — an unsupported shader construct, a compile failure, an unresolved `.gdshader` source, or a malformed
// particle spec — the node silently falls back to its CSS/SVG/preview paint. That silent degrade is fine for
// end users, but it used to HIDE real gaps behind hand-curated allow-lists ("only these shaders/particles are
// known to work"). With the runtimes now driven generically (every shader/particle attempted), the failure of
// any one must be VISIBLE instead of gated away — so the runtime reports it here.
//
// Reports are deduped by (kind, id, reason): a node that fails every reconcile warns once, not every frame.
// The default sink is `console.warn`; a consumer (e.g. a CI corpus gate) can pass an `onUnsupported` reporter
// to collect the failures programmatically instead.

export type UnsupportedRenderKind = "shader" | "particle";

export interface UnsupportedRenderInfo {
  kind: UnsupportedRenderKind;
  /** Shader identity (uid/path) or particle node path — enough to locate the offending node. */
  id: string;
  /** Short reason, e.g. "unsupported shader construct", "shader failed to compile", "shader source
   *  unresolved", "malformed particle spec". */
  reason: string;
  /** The underlying error, when the failure threw. */
  error?: unknown;
}

export type UnsupportedRenderReporter = (info: UnsupportedRenderInfo) => void;

const reported = new Set<string>();

// Report an unrenderable shader/particle exactly once per (kind, id, reason). Routes to `onUnsupported` when
// supplied, else a deduped `console.warn` — so a generic run surfaces exactly which shaders/particles gsw
// could not render, in place of the old silent allow-list gate.
export function reportUnsupportedRender(
  info: UnsupportedRenderInfo,
  onUnsupported?: UnsupportedRenderReporter,
): void {
  const key = `${info.kind}:${info.id}:${info.reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (onUnsupported) {
    onUnsupported(info);
    return;
  }
  if (typeof console !== "undefined") {
    const suffix = info.error === undefined ? "" : ` (${describeError(info.error)})`;
    console.warn(`[gsw] unsupported ${info.kind} "${info.id}": ${info.reason}${suffix}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** TEST-ONLY: clear the dedup set so a test observes reports from a clean slate. */
export function __resetUnsupportedRenderReportsForTest(): void {
  reported.clear();
}
