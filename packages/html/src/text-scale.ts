// Player-adjustable text scaling. When enabled, every text size and font-derived
// decoration is emitted as `calc(<px> * var(--godot-text-scale, 1))`, so a host can
// set `--godot-text-scale` on the stage at runtime (e.g. an accessibility slider)
// and resize all text live, with no re-render. The fallback `1` makes it inert
// until a value is set.

export const TEXT_SCALE_VAR = "--godot-text-scale";

export interface GodotTextScale {
  // Keep auto-fit text fitted to its box and unscaled (the scale still applies to
  // all other text). Default `false`: the scale applies to auto-fit text too.
  exemptAutoFit?: boolean;
}

export type GodotTextScaleOption = boolean | GodotTextScale;

export interface ResolvedTextScale {
  exemptAutoFit: boolean;
}

export function resolveTextScale(
  option: GodotTextScaleOption | undefined,
): ResolvedTextScale | null {
  if (!option) {
    return null;
  }
  return {
    exemptAutoFit: option === true ? false : Boolean(option.exemptAutoFit),
  };
}

// Wrap a px length so it tracks `--godot-text-scale`, or pass it through unchanged
// when text scaling is off for this node.
export function textScaleLength(px: number, enabled: boolean): string {
  return enabled ? `calc(${px}px * var(${TEXT_SCALE_VAR}, 1))` : `${px}px`;
}

// Host convenience: set the live text scale on a stage/frame element (or any text
// ancestor). The value cascades to all text within.
export function setGodotTextScale(element: HTMLElement, value: number): void {
  element.style.setProperty(TEXT_SCALE_VAR, String(value));
}
