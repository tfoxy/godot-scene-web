// Pure image metrics shared by correctness tests and measurement probes.

export function acutanceOf(
  luma: Uint8Array,
  width: number,
  height: number,
): { acutance: number; ink: number; centroidX: number; centroidY: number } {
  let gradient = 0;
  let ink = 0;
  let momentX = 0;
  let momentY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      ink += luma[i];
      momentX += luma[i] * x;
      momentY += luma[i] * y;
      const right = x + 1 < width ? luma[i + 1] : luma[i];
      const down = y + 1 < height ? luma[i + width] : luma[i];
      gradient += Math.abs(right - luma[i]) + Math.abs(down - luma[i]);
    }
  }
  return {
    acutance: ink > 0 ? gradient / ink : 0,
    ink,
    centroidX: ink > 0 ? momentX / ink : 0,
    // The other half of the centroid, and the reason the vertical-anchoring bug is now impossible
    // to ship twice: `subpixelTravel` only ever looked at x, because that is the axis the sweep
    // moves along, so a 2.35 px CONSTANT offset in y sat under every column undetected.
    centroidY: ink > 0 ? momentY / ink : 0,
  };
}

const REGISTRATION_SEARCH_PX = 6;

/**
 * The displacement, in px, that best maps an arm's still onto the reference's — by CORRELATION,
 * not by centroid.
 *
 * THE GUARD, and the half of the fix that matters. Aligning the arms once is a change anyone can
 * undo; a number that says how aligned they are makes undoing it visible. Every per-pixel
 * column — `rmsVsReference` and the viewer's diff images — is only a statement about rasterization
 * while this is near zero. At 2.35 px they were a picture of a translation.
 *
 * WHY NOT THE INK CENTROID, which is the obvious implementation and was the first one. A centroid
 * difference is not a displacement: it also moves when the ink is REDISTRIBUTED, and every arm here
 * redistributes ink relative to an 8x-downsampled reference whose per-glyph advances round
 * differently. Measured, on the aligned arms: `canvas2d`'s centroid sits 0.399 px from the
 * reference's while its correlation peak is at 0.004 px, and `hb-run` — which resamples its whole
 * run bilinearly and so blurs asymmetrically — reads 0.543 px by centroid and 0.010 px by
 * correlation. A guard that cannot tell a blurrier arm from a displaced one would have accused
 * every candidate mechanism this round exists to evaluate.
 *
 * Integer search first, then a fine scan per axis with the reference sampled at FRACTIONAL offsets.
 *
 * NOT the textbook parabola through the peak and its two integer neighbours. That is the cheap
 * refinement and it PEAK-LOCKS: a correlation surface is not a parabola, so the fit is pulled
 * towards whole and half pixels. Measured on a real still, it was exact at 0, 0.5, 1.0 and 1.5 px
 * and worst at the quarters — 0.25 px read as 0.115 and 0.75 as 0.885, an error of 0.135 px against
 * a tolerance of 0.25.
 *
 * The correlation is NORMALIZED, which is what makes the scan work at all: sampling the reference
 * between texels slightly blurs it, most of all at half-pixel offsets, and an unnormalized
 * correlation would read that as less similarity and lock straight back onto the integers.
 *
 * ACCURACY, on ground truth that shares no interpolation model with this code: the probe's eight
 * reference stills are independent 8x renders of the same runs at known offsets, giving 56 ordered
 * pairs with a known answer. Per band at 14 px: Han mean |error| 0.056 px / worst 0.106, Latin
 * 0.017 / 0.036. That is the noise floor the tolerance is set above.
 *
 * THE ONE KNOWN BIAS, stated because it is not zero. Normalized correlation slightly prefers the
 * smoothing that fractional sampling introduces, so an arm BLURRIER than the reference reads a
 * small spurious offset. Measured by softening a reference still to known distortions: 0.16 px at
 * distortion 0.246, 0.30 px at 0.431, 0.51 px at 0.627 — roughly `0.65 * distortion`. At the
 * blurriest arm in this table (`godot-default`, distortion 0.264) that is ~0.17 px, so a FLAGGED
 * arm with high distortion deserves a second look; a flagged arm with low distortion (`godot-msdf`
 * at distortion 0.016) is displaced and nothing else.
 *
 * The border is excluded so every candidate offset compares the same window of the arm.
 */
export function registrationPx(
  arm: { data: Uint8Array; width: number; height: number },
  reference: { data: Uint8Array; width: number; height: number },
): { dx: number; dy: number; distance: number } {
  const width = Math.min(arm.width, reference.width);
  const height = Math.min(arm.height, reference.height);
  const margin = REGISTRATION_SEARCH_PX + 2;

  // `lumaOf` has already removed the page background, which this needs even more than the ink
  // metrics do: correlating raw luma would correlate two mostly-#101014 frames, and the background
  // term — nearly identical at every candidate shift — would swamp the peak being searched for.
  const correlate = (dx: number, dy: number): number => {
    const x0 = Math.floor(dx);
    const y0 = Math.floor(dy);
    const fx = dx - x0;
    const fy = dy - y0;
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let y = margin; y < height - margin; y += 1) {
      for (let x = margin; x < width - margin; x += 1) {
        const at = (y + y0) * reference.width + x + x0;
        const b =
          (1 - fx) * (1 - fy) * reference.data[at] +
          fx * (1 - fy) * reference.data[at + 1] +
          (1 - fx) * fy * reference.data[at + reference.width] +
          fx * fy * reference.data[at + reference.width + 1];
        const a = arm.data[y * arm.width + x];
        ab += a * b;
        aa += a * a;
        bb += b * b;
      }
    }
    return ab / Math.sqrt(aa * bb || 1);
  };

  let best = { dx: 0, dy: 0, value: Number.NEGATIVE_INFINITY };
  for (
    let dy = -REGISTRATION_SEARCH_PX;
    dy <= REGISTRATION_SEARCH_PX;
    dy += 1
  ) {
    for (
      let dx = -REGISTRATION_SEARCH_PX;
      dx <= REGISTRATION_SEARCH_PX;
      dx += 1
    ) {
      const value = correlate(dx, dy);
      if (value > best.value) best = { dx, dy, value };
    }
  }

  // Coarse then fine, alternating axes: a full 2-D fine grid would be 30x the work for a surface
  // whose axes are very nearly separable at this scale.
  let dx = best.dx;
  let dy = best.dy;
  for (const [span, step] of [
    [0.75, 0.05],
    [0.06, 0.01],
  ]) {
    dx = scanAxis((t) => correlate(t, dy), dx, span, step);
    dy = scanAxis((t) => correlate(dx, t), dy, span, step);
  }
  // Negated: the search shifts the REFERENCE onto the arm, so the arm's own displacement is the
  // other way round. The distance is what the guard reads, but both axes are published because
  // "2.35 px, all of it vertical" is a diagnosis and "2.35 px" is only an alarm.
  return { dx: -dx, dy: -dy, distance: Math.hypot(dx, dy) };
}

/** The offset near `centre` that maximises `score`, sampled on a fixed grid. */
function scanAxis(
  score: (at: number) => number,
  centre: number,
  span: number,
  step: number,
): number {
  let bestAt = centre;
  let bestValue = Number.NEGATIVE_INFINITY;
  // `1e-9` so the last step is not lost to floating-point accumulation, which would make the scan
  // silently one-sided.
  for (let offset = -span; offset <= span + 1e-9; offset += step) {
    const value = score(centre + offset);
    if (value > bestValue) {
      bestValue = value;
      bestAt = centre + offset;
    }
  }
  return bestAt;
}

export function rms(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] - b[i]) ** 2;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * Exact NxN box average, done by hand rather than through `sharp.resize`.
 *
 * sharp 0.34 has no `box` kernel — its choices are nearest (which picks one sub-pixel and would
 * make the reference ALIASED, i.e. the opposite of what a supersampled reference is for) and the
 * lanczos/cubic family (which ring, inflating the very gradient `acutance` measures). For an
 * integer factor the correct filter is the unweighted mean over each block, which is four lines.
 */
export function boxDownsample(
  rgba: Uint8Array,
  width: number,
  height: number,
  factor: number,
): { data: Uint8Array; width: number; height: number } {
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const out = new Uint8Array(outWidth * outHeight * 4);
  const area = factor * factor;
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * width + (x * factor + dx)) * 4;
          sums[0] += rgba[i];
          sums[1] += rgba[i + 1];
          sums[2] += rgba[i + 2];
          sums[3] += rgba[i + 3];
        }
      }
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(sums[0] / area);
      out[o + 1] = Math.round(sums[1] / area);
      out[o + 2] = Math.round(sums[2] / area);
      out[o + 3] = Math.round(sums[3] / area);
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}
