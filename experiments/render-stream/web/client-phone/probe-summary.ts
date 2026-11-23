// Pure reduction of the phone page's probe records; shared by the runner and tests.
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function pct(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
export function dist(xs: readonly number[]) {
  const mean = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  const f = (v: number | null) => (v === null ? null : r2(v));
  return {
    n: xs.length,
    mean: f(mean),
    p50: f(pct(xs, 50)),
    p95: f(pct(xs, 95)),
    p99: f(pct(xs, 99)),
    max: f(xs.length ? xs.reduce((m, x) => (x > m ? x : m), -Infinity) : null),
  };
}

export interface Taken {
  frames: { a: number[]; b: number[]; dropped: number };
  frameGl: { a: number[]; b: number[]; dropped: number };
  messages: { a: number[]; b: number[]; dropped: number };
  fetches: { a: number[]; b: number[]; dropped: number };
  longTasks: { a: number[]; b: number[]; dropped: number };
}

/** Frame cadence and synchronous callback cost across every instrumented page rAF loop. */
export function summarize(t: Taken, seconds: number) {
  // The client, GPU load and recorder can register callbacks for the same frame.
  // Browser rAF timestamps identify frames; callback count does not.
  const frames = new Map<number, number>();
  for (let i = 0; i < t.frames.a.length; i++) {
    const ts = t.frames.a[i];
    frames.set(ts, (frames.get(ts) ?? 0) + t.frames.b[i]);
  }
  const ts = [...frames.keys()];
  const callbackMs = [...frames.values()];
  const intervals: number[] = [];
  for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
  const tp = pct(intervals, 50) ?? 16.7;
  const bytes = t.messages.a.reduce((s, x) => s + x, 0);
  return {
    seconds,
    raf_per_s: r1(ts.length / seconds),
    frame_interval_ms: dist(intervals),
    frames_over_1_5_tp: intervals.filter((x) => x > 1.5 * tp).length,
    raf_callback_scope:
      "all page rAF callbacks summed per frame: stream client (apply/lower/GL submission), GPU load and recorder; synchronous wall time",
    raf_callback_ms: dist(callbackMs),
    raf_callback_busy_ms_per_s: r1(
      t.frames.b.reduce((s, x) => s + x, 0) / seconds,
    ),
    messages_per_s: r1(t.messages.a.length / seconds),
    message_kb_per_s: r1(bytes / 1024 / seconds),
    message_bytes: dist(t.messages.a),
    onmessage_ms: dist(t.messages.b),
    onmessage_busy_ms_per_s: r1(
      t.messages.b.reduce((s, x) => s + x, 0) / seconds,
    ),
    fetches: t.fetches.a.length,
    fetch_ms: dist(t.fetches.b),
    long_tasks: t.longTasks.a.length,
    long_task_ms: dist(t.longTasks.b),
    gl_ms_in_raf: t.frameGl.a.length ? dist(t.frameGl.a) : null,
    gl_calls_in_raf: t.frameGl.b.length ? dist(t.frameGl.b) : null,
    dropped: t.frames.dropped + t.messages.dropped,
  };
}
