export type GpuLoadMode = "always" | "coupled";

interface FrameClock {
  request(cb: FrameRequestCallback): number;
  cancel(id: number): void;
}

/** Keep the calibrated per-draw cost; coupled empty frames submit no GPU work. */
export function gpuLoadLoop(
  mode: GpuLoadMode,
  draw: (t: number) => void,
  draws: () => number,
  clock: FrameClock = {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  },
) {
  let raf = 0;
  let previous = 0;
  let stopped = false;
  const frame = (t: number) => {
    if (stopped) return;
    const current = mode === "coupled" ? draws() : 0;
    if (mode === "always" || current > previous) draw(t);
    previous = current;
    raf = clock.request(frame);
  };
  if (mode === "always") raf = clock.request(frame);
  return {
    streaming() {
      if (stopped || mode === "always") return;
      clock.cancel(raf);
      previous = draws();
      // The session's streaming status is delivered by onmessage after the client
      // has registered its frame callback. Our first rAF thus runs after its draw
      // and next-frame registration. Re-register here each frame to retain that
      // order. Re-seed on reconnect as well, in case the client restarted its loop.
      raf = clock.request(frame);
    },
    stop() {
      stopped = true;
      clock.cancel(raf);
    },
  };
}
