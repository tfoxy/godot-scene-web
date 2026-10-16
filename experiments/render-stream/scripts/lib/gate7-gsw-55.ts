// Gate 5.5's gsw legs, receiver checks and Q7 plan (gate7-design.md G7s, Q7, Q8). Kept beside
// lib/gate7-gsw.ts, which merges them into its per-gate tables (`gate55`), so the gate 4/5 and
// gate 5.5 increments touch that file in one line each.
//
// The file legs are every file-mode receiver leg of g55d (CanvasItemMaterial, base and `modulate`
// scenes) and g55e (ShaderMaterial: payload, inline, refused, `params` with and without the
// library, the host and receiver sabotages), replayed from a native gate 5.5 source run (D21) and
// judged by check-gate55.ts's own g55d/g55e checks (`@gsw`). g55f's live legs are G7l's.

import type { GswLegDef, NotApplicable } from "./gate7-gsw";

export const GATE55_LEGS: GswLegDef[] = [
  { leg: "cim/receiver", replaces: true, compositor: true },
  { leg: "cim/receiver-patch", replaces: true },
  { leg: "cim/receiver-inline", replaces: true },
  { leg: "cim/sabotage-freeze/receiver", replaces: true },
  { leg: "cim/sabotage-omit-material-set-shader/receiver", replaces: true },
  { leg: "cim/sabotage-receiver-ignore-material", replaces: true },
  { leg: "cim-modulate/receiver", replaces: true, compositor: true },
  { leg: "cim-modulate/receiver-patch", replaces: true },
  { leg: "cim-modulate/receiver-inline", replaces: true },
  {
    leg: "cim-modulate/sabotage-receiver-ignore-canvas-modulate",
    replaces: true,
  },
  { leg: "shader/receiver", replaces: true, compositor: true },
  { leg: "shader/receiver-patch", replaces: true },
  { leg: "shader/receiver-inline", replaces: true },
  { leg: "shader/sabotage-freeze/receiver", replaces: true },
  { leg: "shader/sabotage-omit-param/receiver", replaces: true },
  { leg: "shader/sabotage-perturb-shader/receiver", replaces: true },
  { leg: "shader/sabotage-receiver-ignore-material", replaces: true },
  { leg: "shader/sabotage-receiver-stale-param", replaces: true },
  { leg: "shader-refused/receiver", replaces: true },
  { leg: "shader-policy-params/receiver-nolib", replaces: true },
  { leg: "shader-policy-params/receiver-lib", replaces: true },
  {
    // G7s: every effective `add` blend draws `sub` and every `sub` draws `add`.
    leg: "cim/sabotage-gsw-blend-swap",
    from: "cim/receiver",
    env: { RS_RECEIVER_SABOTAGE: "blend-swap" },
    replaces: false,
  },
];

export const GATE55_NOT_APPLICABLE: NotApplicable[] = [
  {
    leg: "cim/import/receiver",
    reason:
      "the editor --import of the native receiver project (receiver/); the GSW receiver is a bundle with nothing to import",
  },
  {
    leg: "shader/import/receiver",
    reason:
      "the editor --import of the native receiver project (receiver/); the GSW receiver is a bundle with nothing to import",
  },
];

export const GATE55_RECEIVER_CHECKS: {
  judged: string[];
  notApplicable: Record<string, string>;
} = {
  judged: [
    "leg-class-receiver-cim",
    "leg-class-receiver-cim-patch",
    "leg-class-receiver-cim-inline",
    "cim-fresh-without-redraw",
    "cim-resource-quiet",
    "cim-receiver-vs-reference",
    "cim-expected-image-receiver",
    "cim-receiver-state-dumps",
    "leg-class-sabotage-cim-freeze",
    "leg-class-sabotage-cim-omit-material-set-shader",
    "leg-class-sabotage-cim-receiver-ignore-material",
    "cim-receiver-typed-clean",
    "leg-class-receiver-cim-modulate",
    "leg-class-receiver-cim-modulate-patch",
    "leg-class-receiver-cim-modulate-inline",
    "cim-modulate-fresh-without-redraw",
    "cim-modulate-resource-quiet",
    "cim-modulate-receiver-vs-reference",
    "cim-modulate-expected-image-receiver",
    "cim-modulate-receiver-state-dumps",
    "leg-class-sabotage-cim-modulate-receiver-ignore-canvas-modulate",
    "cim-modulate-receiver-typed-clean",
    "leg-class-receiver-shader",
    "leg-class-receiver-shader-patch",
    "leg-class-receiver-shader-inline",
    "leg-class-receiver-params-lib",
    "leg-class-receiver-refused",
    "leg-class-receiver-params-nolib",
    "shader-receiver-vs-reference",
    "shader-expected-image-receiver",
    "shader-receiver-state-dumps",
    "leg-class-sabotage-shader-freeze",
    "leg-class-sabotage-shader-omit-param",
    "leg-class-sabotage-shader-perturb-shader",
    "leg-class-sabotage-shader-receiver-ignore-material",
    "leg-class-sabotage-shader-receiver-stale-param",
    "shader-receiver-typed",
  ],
  notApplicable: {
    "cim-receiver-import-exit":
      "the editor --import of the native receiver project; the GSW receiver is a bundle",
    "shader-receiver-import-exit":
      "the editor --import of the native receiver project; the GSW receiver is a bundle",
  },
};

/** check-gate55.ts's `legs` key of a gsw leg (`cim/receiver-patch` -> `receiver-cim-patch`). */
export function gate55LegKey(leg: string): string | undefined {
  const keys: Record<string, string> = {
    "cim/receiver": "receiver-cim",
    "cim/receiver-patch": "receiver-cim-patch",
    "cim/receiver-inline": "receiver-cim-inline",
    "cim/sabotage-freeze/receiver": "sabotage-cim-freeze",
    "cim/sabotage-omit-material-set-shader/receiver":
      "sabotage-cim-omit-material-set-shader",
    "cim/sabotage-receiver-ignore-material":
      "sabotage-cim-receiver-ignore-material",
    "cim-modulate/receiver": "receiver-cim-modulate",
    "cim-modulate/receiver-patch": "receiver-cim-modulate-patch",
    "cim-modulate/receiver-inline": "receiver-cim-modulate-inline",
    "cim-modulate/sabotage-receiver-ignore-canvas-modulate":
      "sabotage-cim-modulate-receiver-ignore-canvas-modulate",
    "shader/receiver": "receiver-shader",
    "shader/receiver-patch": "receiver-shader-patch",
    "shader/receiver-inline": "receiver-shader-inline",
    "shader/sabotage-freeze/receiver": "sabotage-shader-freeze",
    "shader/sabotage-omit-param/receiver": "sabotage-shader-omit-param",
    "shader/sabotage-perturb-shader/receiver": "sabotage-shader-perturb-shader",
    "shader/sabotage-receiver-ignore-material":
      "sabotage-shader-receiver-ignore-material",
    "shader/sabotage-receiver-stale-param":
      "sabotage-shader-receiver-stale-param",
    "shader-refused/receiver": "receiver-refused",
    "shader-policy-params/receiver-nolib": "receiver-params-nolib",
    "shader-policy-params/receiver-lib": "receiver-params-lib",
  };
  return keys[leg];
}

/** Q7 for gate 5.5: the CanvasItemMaterial scenes' masks (`gate55-cim`, translucent blends);
 * the ShaderMaterial fixture draws opaque fills only, so its legs are judged exactly. */
export function gate55Q7Plan(
  leg: string,
): { key: string; reference: string; live: boolean } | null {
  const scene = /^(cim|cim-modulate)\//.exec(leg)?.[1];
  if (!scene) return null;
  return {
    key: scene === "cim" ? "gate55-cim" : "gate55-cim-modulate",
    reference: `${scene}/reference`,
    live: false,
  };
}
