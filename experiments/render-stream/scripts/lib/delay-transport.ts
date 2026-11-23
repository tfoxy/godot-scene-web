import type { RenderStreamTransportFactory } from "../../../../packages/render-stream-client/src/transport";

export interface DelayClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const realClock: DelayClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Delay stream traffic only. HTTP GETs and open/close pass through undelayed.
 * Each direction has its own timestamped FIFO and one timer chain: bursts keep
 * their spacing, even when the event loop wakes late. Closing discards both queues. */
export function delayTransport(
  factory: RenderStreamTransportFactory,
  oneWayMs: number,
  clock: DelayClock = realClock,
): RenderStreamTransportFactory {
  if (!Number.isFinite(oneWayMs) || oneWayMs < 0)
    throw new Error("delay-transport: oneWayMs must be finite and nonnegative");
  return (endpoint, subprotocol, on) => {
    let closed = false;
    function queue<T>(deliver: (value: T) => void) {
      const pending: { at: number; value: T }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      function schedule() {
        if (closed || timer !== null || pending.length === 0) return;
        timer = clock.setTimeout(
          () => {
            timer = null;
            while (!closed && pending.length && pending[0].at <= clock.now()) {
              const item = pending.shift();
              if (item) deliver(item.value);
            }
            schedule();
          },
          Math.max(0, pending[0].at - clock.now()),
        );
      }
      return {
        push(value: T) {
          if (closed) return;
          pending.push({ at: clock.now() + oneWayMs, value });
          schedule();
        },
        stop() {
          if (timer !== null) clock.clearTimeout(timer);
          timer = null;
          pending.length = 0;
        },
      };
    }
    const inbound = queue<ArrayBuffer | string>((data) => on.message(data));
    const outbound = queue<string>((text) => carrier.send(text));
    const stop = () => {
      closed = true;
      inbound.stop();
      outbound.stop();
    };
    const carrier = factory(endpoint, subprotocol, {
      open: () => {
        if (!closed) on.open();
      },
      message: (data) => inbound.push(data),
      close(code, reason) {
        stop();
        on.close(code, reason);
      },
    });
    return {
      get carrier() {
        return carrier.carrier;
      },
      send: (text) => outbound.push(text),
      close(code, reason) {
        stop();
        carrier.close(code, reason);
      },
      fetchResource: (path, init) => carrier.fetchResource(path, init),
    };
  };
}
