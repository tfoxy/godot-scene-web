/**
 * The one description of the fx SOURCE colour, shared by the page half of the
 * canvas pixel test and the node half that asserts on it.
 *
 * ITS OWN MODULE for one reason: `./browser-entry` writes to `window` at module
 * scope, so the test file imports it TYPE-ONLY (a value import would run the page
 * half inside vitest's node process). Constants both halves need therefore cannot
 * live there — and a colour restated on both sides of a pixel assertion is a test
 * that passes when the two statements drift together.
 */

/** Edge of the 2D canvas the `fx…` cases upload. Small AND uniformly coloured, so
 *  no sample can land between two different texels however the quad is filtered. */
export const FX_SOURCE_SIZE = 4;

/** The STRAIGHT-alpha bytes that canvas is painted with. Half alpha, with one
 *  channel at zero and one in between: an opaque source would hide a missing
 *  premultiply, and a full white one would hide a doubled premultiply. */
export const FX_SOURCE_STRAIGHT: readonly [number, number, number, number] = [
  255, 0, 102, 128,
];

/** What the FIRST upload puts on the key, so the second one — the same size, so
 *  it goes in through `texSubImage2D` — has something distinguishable to
 *  overwrite. Opaque, and nothing like the colour above. */
export const FX_SOURCE_DECOY: readonly [number, number, number, number] = [
  0, 255, 0, 255,
];

/** `FX_SOURCE_STRAIGHT` as the premultiplied bytes an upload should produce. */
export function premultipliedFxSource(): [number, number, number, number] {
  const [r, g, b, a] = FX_SOURCE_STRAIGHT;
  return [
    Math.round((r * a) / 255),
    Math.round((g * a) / 255),
    Math.round((b * a) / 255),
    a,
  ];
}
