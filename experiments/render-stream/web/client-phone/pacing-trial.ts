/** Split recorded draws at the first observed balanced -> fidelity fallback.
 * All timestamps use the page clock. Durations cover only the measured window,
 * including time spent reconnecting. A missing or zero-duration rate stays null.
 */
export function pacingTrial(
  preset: "fidelity" | "balanced" | undefined,
  drawTimes: readonly number[],
  start: number,
  end: number,
  fallbackAt: number | null,
) {
  if (preset !== "balanced") return { trial: null, after_fallback: null };
  const split = Math.max(start, Math.min(end, fallbackAt ?? end));
  const segment = (a: number, b: number, draws: number) => ({
    draws,
    window_s: (b - a) / 1000,
    draws_per_s: b > a ? (draws * 1000) / (b - a) : null,
  });
  const measured = drawTimes.filter((t) => t >= start && t <= end);
  // The draw observed on the fallback frame belongs to the after phase. When
  // fallback has not happened, even a draw at the window end is still trial.
  const before = measured.filter((t) => fallbackAt === null || t < fallbackAt);
  return {
    trial: segment(start, split, before.length),
    after_fallback:
      fallbackAt === null || fallbackAt > end
        ? null
        : segment(split, end, measured.length - before.length),
  };
}
