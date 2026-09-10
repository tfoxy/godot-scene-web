// @vitest-environment node
//
// Recovering from a tracing session an INTERRUPTED run left behind.
//
// Chrome's tracing controller is BROWSER-GLOBAL, not per-tab. Ctrl-C in the middle of a capture
// leaves it started, and every later run — in any tab, in any process — then dies on `Tracing.start`
// with "Tracing has already been started (possibly in another tab)". There is no such tab, which is
// what makes the message so misleading: the controller outlives the session that started it.
//
// The lever is a BROWSER-LEVEL `Tracing.end` (`{ flat: true }`, no sessionId). Sending `Tracing.end`
// on each attached page session answers "Tracing is not started" and clears nothing — that was
// measured on the phone during this round, on Chrome 151, across all 6 page targets plus an iframe.
// These tests pin exactly that, because a "defensive cleanup" that quietly sends the wrong thing
// looks identical in the code and fixes nothing.

import { describe, expect, it, vi } from "vitest";
import type { CdpClient } from "../src/cdp";
import {
  endStaleTracing,
  STALE_TRACING_HELP,
  startTracing,
} from "../src/trace";

type Handler = (params: Record<string, unknown>) => void;

interface Call {
  method: string;
  flat: boolean;
}

/** A CDP double that records HOW each message was addressed (session vs browser level). */
function fakeClient(
  respond: (method: string, call: number) => unknown,
): CdpClient & {
  calls: Call[];
  emit: (method: string, params: Record<string, unknown>) => void;
} {
  const calls: Call[] = [];
  const handlers = new Map<string, Handler[]>();
  const counts = new Map<string, number>();
  const client = {
    calls,
    emit(method: string, params: Record<string, unknown>) {
      for (const handler of handlers.get(method) ?? []) {
        handler(params);
      }
    },
    on(method: string, fn: Handler) {
      const list = handlers.get(method);
      if (list) {
        list.push(fn);
      } else {
        handlers.set(method, [fn]);
      }
    },
    off(method: string) {
      handlers.delete(method);
    },
    send(method: string, _params?: unknown, options?: { flat?: boolean }) {
      calls.push({ method, flat: options?.flat === true });
      const index = (counts.get(method) ?? 0) + 1;
      counts.set(method, index);
      const result = respond(method, index);
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result ?? {});
    },
  };
  return client as unknown as CdpClient & {
    calls: Call[];
    emit: (method: string, params: Record<string, unknown>) => void;
  };
}

describe("endStaleTracing", () => {
  it("ends tracing at BROWSER level, not on the page session", async () => {
    const client = fakeClient((method) =>
      method === "Tracing.end" ? new Error("Tracing is not started") : {},
    );
    await endStaleTracing(client);
    const end = client.calls.find((call) => call.method === "Tracing.end");
    expect(end).toBeDefined();
    // `flat: true` is the whole fix: no sessionId, so the message reaches the browser-global
    // tracing agent rather than a page's own (which is never the one holding the controller).
    expect(end?.flat).toBe(true);
  });

  it('treats "not started" as the normal case, not an error', async () => {
    const client = fakeClient((method) =>
      method === "Tracing.end" ? new Error("Tracing is not started") : {},
    );
    await expect(endStaleTracing(client)).resolves.toBe(false);
  });

  it("drains and closes the stream a stale session hands back", async () => {
    const client = fakeClient(() => ({}));
    const promise = endStaleTracing(client);
    // The stale controller really was running: Chrome answers with a trace stream nobody wants.
    await vi.waitFor(() =>
      expect(client.calls.some((call) => call.method === "Tracing.end")).toBe(
        true,
      ),
    );
    client.emit("Tracing.tracingComplete", { stream: "stale-handle" });
    await expect(promise).resolves.toBe(true);
    // Left open, that handle leaks a whole trace inside the browser.
    expect(client.calls.map((call) => call.method)).toContain("IO.close");
  });
});

describe("startTracing", () => {
  it("starts normally when nothing is holding the controller", async () => {
    const client = fakeClient(() => ({}));
    await startTracing(client, ["cc"]);
    expect(
      client.calls.filter((call) => call.method === "Tracing.start"),
    ).toHaveLength(1);
  });

  it("clears a stale controller and RETRIES once", async () => {
    // The exact failure that bit this workstream twice in one session.
    const client = fakeClient((method, call) => {
      if (method === "Tracing.start" && call === 1) {
        return new Error(
          "CDP error: Tracing has already been started (possibly in another tab)",
        );
      }
      if (method === "Tracing.end") {
        return new Error("Tracing is not started");
      }
      return {};
    });
    await startTracing(client, ["cc"]);
    const methods = client.calls.map((call) => call.method);
    expect(methods).toEqual(["Tracing.start", "Tracing.end", "Tracing.start"]);
  });

  it("explains the RECOVERY when even that does not clear it", async () => {
    // A controller held by a session no live target owns: attaching, detaching and per-page
    // `Tracing.end` all fail to release it, and the only remaining lever is restarting the browser.
    // The error has to say that, or device mode stays bricked for whoever hits it next.
    const client = fakeClient((method) =>
      method === "Tracing.start"
        ? new Error(
            "Tracing has already been started (possibly in another tab)",
          )
        : new Error("Tracing is not started"),
    );
    await expect(startTracing(client, ["cc"])).rejects.toThrow(
      /force-stop com.android.chrome/,
    );
    expect(STALE_TRACING_HELP).toContain("ANOTHER LIVE CONNECTION");
  });

  it("does not swallow an unrelated Tracing.start failure", async () => {
    const client = fakeClient((method) =>
      method === "Tracing.start" ? new Error("Target closed") : {},
    );
    await expect(startTracing(client, ["cc"])).rejects.toThrow(/Target closed/);
    // No retry: retrying a genuine protocol failure just doubles the wait before the real message.
    expect(
      client.calls.filter((call) => call.method === "Tracing.start"),
    ).toHaveLength(1);
  });
});
