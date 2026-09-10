// Chrome trace capture (CDP `Tracing.*`) plus the parsing / name-histogram side of the pipeline.
//
// Capture uses `transferMode: "ReturnAsStream"` + `streamCompression: "gzip"` + `streamFormat: "json"`
// and drains the handle with `IO.read`. Returning the trace inline (`ReportEvents`) floods the
// websocket with one CDP message per event and reliably drops data on a busy page; the stream is the
// only shape that survives a 100k-event capture.
//
// Parsing is a streaming brace-scanner (borrowed technique, not code, from couch-coop's
// analyze-gpu-trace.mjs): it hands out one array-element object at a time, so a 200 MB capture never
// has to be materialised as one JSON string.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import type { CdpClient } from "./cdp";

/** Categories the metric contract needs. `cc` carries ActivateLayerTree + RasterTask + render surfaces. */
export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "cc",
  "benchmark",
  "toplevel",
  "blink.user_timing",
] as const;

/**
 * The extra categories that give the GPU process OP-LEVEL detail. Without them its threads carry
 * nothing but `RunTask`, so the cost is knowable in bulk (`cpu.byProcess.gpu`, from `tdur`) and not at
 * all per op.
 *
 * They are OPT-OUT (`--no-gpu`) rather than always-on because they are the noisiest categories Chrome
 * has: `disabled-by-default-skia.gpu` alone emits one event per draw op. A sibling repo has already
 * had a capture silently truncated by trace-buffer overflow into something that read as an idle page,
 * which is why `stopTracing` now surfaces `dataLossOccurred` instead of trusting the buffer.
 */
export const GPU_TRACE_CATEGORIES = [
  "gpu",
  "viz",
  "disabled-by-default-gpu.service",
  "disabled-by-default-skia.gpu",
] as const;

/**
 * The category that carries `Tracing.requestMemoryDump` results. Requested dumps are written into the
 * trace as `ph: "v"` events; without this category the CDP call succeeds and the dump lands nowhere.
 *
 * Added only by `--memory-dump`. It is not periodic — the trace config declares no
 * `memory_dump_config` — so the only dumps in a capture are the two this harness asks for, at the
 * measurement bracket.
 */
export const MEMORY_DUMP_CATEGORY = "disabled-by-default-memory-infra";

/** The category set for a run, with the GPU categories added only when GPU collection is on. */
export function traceCategoriesFor(
  gpu: boolean,
  memoryDump = false,
): readonly string[] {
  return [
    ...TRACE_CATEGORIES,
    ...(gpu ? GPU_TRACE_CATEGORIES : []),
    ...(memoryDump ? [MEMORY_DUMP_CATEGORY] : []),
  ];
}

export interface TraceEvent {
  name: string;
  cat?: string;
  ph?: string;
  ts: number;
  dur?: number;
  tdur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

/**
 * Recovery message for a tracing controller nobody released. Printed instead of the bare CDP error,
 * because that error ("Tracing has already been started (possibly in another tab)") sends the reader
 * looking for a tab, and there is no tab: the controller is browser-global.
 */
export const STALE_TRACING_HELP = [
  "Chrome's tracing controller is BROWSER-GLOBAL. Measured on the phone (Chrome 151), it has three states:",
  "  1. THIS connection left tracing started (a run wedged between repeats) — a browser-level",
  "     `Tracing.end` clears it, which is what just failed to help, so it is not this.",
  "  2. the connection that started it is GONE — Chrome releases the controller by itself when the",
  "     websocket closes, so a Ctrl-C'd run does NOT wedge anything.",
  "  3. ANOTHER LIVE CONNECTION holds it — and that cannot be taken over: `Tracing.end` from any other",
  '     connection answers "Tracing is not started" and `Tracing.start` keeps failing. This is the one',
  "     that bricks device mode, and the fix is to stop the holder, not to retry.",
  "So: find the other client. A second harness process, a `--dump-trace-names` run, chrome-devtools-mcp,",
  "or an open DevTools frontend attached to the same browser will all hold it.",
  "  * desktop: close the Chrome the harness launched (`artifacts/perf/chrome-profile`) and re-run",
  "  * device:  stop the other process; if none can be found, `adb shell am force-stop com.android.chrome`,",
  "             then reopen Chrome on the phone (it restores its tabs)",
].join("\n  ");

function isNotStarted(error: unknown): boolean {
  return /not started|has not been started/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * End a tracing session left running by an earlier capture — at BROWSER level (`{ flat: true }`, no
 * sessionId), because that is the only level the controller lives at.
 *
 * MEASURED ON THE PHONE (moto g86 5G, Chrome 151), rather than assumed, because "Tracing has already
 * been started (possibly in another tab)" is one message covering three different situations:
 *
 *   1. THIS connection started tracing and never ended it (a run wedged or errored between repeats).
 *      This call clears it, and `startTracing` retries — verified end to end on the device.
 *   2. The connection that started it is gone. Chrome releases the controller ITSELF when the
 *      websocket closes: a Ctrl-C'd run leaves nothing behind. Verified by starting a trace and
 *      dropping the socket — the next connection started tracing normally.
 *   3. ANOTHER LIVE CONNECTION holds it (a second harness process, chrome-devtools-mcp, an open
 *      DevTools frontend). This is NOT recoverable from the outside: `Tracing.end` on the other
 *      connection answers "Tracing is not started" — the agent is per-connection even though the
 *      controller is global — and `Tracing.start` keeps failing. The holder has to stop.
 *
 * Sending `Tracing.end` per attached PAGE session is not a fourth option; it answers "not started"
 * in every case above and clears nothing.
 *
 * Any stream a stale session produces is drained and closed rather than left to leak in the browser,
 * and "not started" — the overwhelmingly common answer — is not an error here.
 */
export async function endStaleTracing(client: CdpClient): Promise<boolean> {
  let handle: string | undefined;
  const completed = new Promise<void>((res) => {
    const timer = setTimeout(res, 5_000);
    client.on("Tracing.tracingComplete", (params) => {
      clearTimeout(timer);
      handle = (params as { stream?: string }).stream;
      res();
    });
  });
  try {
    await client.send("Tracing.end", {}, { flat: true, timeoutMs: 15_000 });
  } catch (error) {
    client.off("Tracing.tracingComplete");
    if (isNotStarted(error)) {
      return false;
    }
    // Anything else (a closed socket, a timeout) is not this function's problem to report: the
    // caller is about to start tracing and will fail with a far more specific message.
    return false;
  }
  await completed;
  client.off("Tracing.tracingComplete");
  if (handle) {
    await client
      .send("IO.close", { handle }, { flat: true })
      .catch(() => undefined);
  }
  return true;
}

export async function startTracing(
  client: CdpClient,
  categories: readonly string[] = TRACE_CATEGORIES,
): Promise<void> {
  const params = {
    transferMode: "ReturnAsStream",
    streamCompression: "gzip",
    streamFormat: "json",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      includedCategories: [...categories],
    },
  };
  try {
    await client.send("Tracing.start", params, { flat: true });
    return;
  } catch (error) {
    if (!/already been started/i.test(String((error as Error)?.message))) {
      throw error;
    }
    // Second chance: a stale controller from an interrupted run. Attach-time cleanup normally gets
    // this, but a run that is interrupted BETWEEN repeats leaves one behind mid-session.
    await endStaleTracing(client);
  }
  try {
    await client.send("Tracing.start", params, { flat: true });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n  ${STALE_TRACING_HELP}`,
    );
  }
}

export interface StoppedTrace {
  bytes: Buffer;
  /**
   * Chrome's own `Tracing.tracingComplete.dataLossOccurred`: the ring buffer wrapped and events were
   * DROPPED. A truncated capture does not look broken — it looks like a page that did less work,
   * which is the most dangerous shape a perf measurement can take. The caller discards the repeat.
   */
  dataLoss: boolean;
}

/** Stop tracing and return the raw gzip bytes of the trace stream, plus whether events were lost. */
export async function stopTracing(client: CdpClient): Promise<StoppedTrace> {
  let dataLoss = false;
  const completed = new Promise<string>((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error("Tracing.tracingComplete never arrived")),
      120_000,
    );
    client.on("Tracing.tracingComplete", (params) => {
      clearTimeout(timer);
      const message = params as { stream?: string; dataLossOccurred?: boolean };
      dataLoss = message.dataLossOccurred === true;
      const handle = message.stream;
      if (!handle) {
        rej(new Error("Tracing.tracingComplete carried no stream handle"));
        return;
      }
      res(handle);
    });
  });
  await client.send("Tracing.end", {}, { flat: true });
  const handle = await completed;
  client.off("Tracing.tracingComplete");

  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await client.send<{
      data: string;
      base64Encoded?: boolean;
      eof: boolean;
    }>("IO.read", { handle, size: 1 << 20 }, { flat: true });
    if (chunk.data) {
      chunks.push(
        Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"),
      );
    }
    if (chunk.eof) {
      break;
    }
  }
  await client.send("IO.close", { handle }, { flat: true });
  return { bytes: Buffer.concat(chunks), dataLoss };
}

/**
 * Stream one array-element JSON object at a time out of a trace file. Tracks container nesting and
 * string state rather than trusting newlines, so it handles both shapes Chrome writes:
 * a bare `[{...},{...}]` array and a `{"traceEvents":[...],"metadata":{...}}` wrapper (the metadata
 * block is not an array element, so it is skipped for free).
 */
export async function streamTraceObjects(
  path: string,
  onObject: (text: string) => void,
): Promise<void> {
  await new Promise<void>((res, rej) => {
    let stream: NodeJS.ReadableStream = createReadStream(path, {
      highWaterMark: 1 << 22,
    });
    if (path.endsWith(".gz")) {
      stream = stream.pipe(createGunzip());
    }
    let buf = "";
    let pos = 0;
    let nest = 0;
    const inArray: boolean[] = [];
    let start = -1;
    let captureNest = -1;
    let inStr = false;
    let esc = false;
    stream.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const len = buf.length;
      for (; pos < len; pos++) {
        const c = buf.charCodeAt(pos);
        if (inStr) {
          if (esc) {
            esc = false;
          } else if (c === 92) {
            esc = true;
          } else if (c === 34) {
            inStr = false;
          }
          continue;
        }
        if (c === 34) {
          inStr = true;
          continue;
        }
        if (c === 123) {
          if (start < 0 && nest > 0 && inArray[nest - 1]) {
            start = pos;
            captureNest = nest;
          }
          inArray[nest++] = false;
          continue;
        }
        if (c === 91) {
          inArray[nest++] = true;
          continue;
        }
        if (c === 125 || c === 93) {
          nest--;
          if (c === 125 && start >= 0 && nest === captureNest) {
            onObject(buf.slice(start, pos + 1));
            start = -1;
            captureNest = -1;
          }
        }
      }
      const keepFrom = start >= 0 ? start : buf.length;
      if (keepFrom > 0) {
        buf = buf.slice(keepFrom);
        pos -= keepFrom;
        if (start >= 0) {
          start -= keepFrom;
        }
      }
    });
    stream.on("error", rej);
    stream.on("end", () => res());
  });
}

export async function readTraceEvents(path: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  await streamTraceObjects(path, (text) => {
    let event: TraceEvent;
    try {
      event = JSON.parse(text) as TraceEvent;
    } catch {
      return;
    }
    if (typeof event.name !== "string" || typeof event.ts !== "number") {
      return;
    }
    events.push(event);
  });
  return events;
}

export interface TraceNameRow {
  name: string;
  cat: string;
  ph: string;
  count: number;
  totalMs: number;
  threads: string[];
}

export interface TraceNameHistogram {
  totalEvents: number;
  threads: { key: string; label: string; count: number }[];
  rows: TraceNameRow[];
}

/**
 * Name+category+phase+thread histogram over a trace. This exists because Chrome trace event names
 * drift between versions: the analyzer must be written against the names a REAL capture on the
 * target Chrome shows, never against remembered ones.
 */
export function traceNameHistogram(events: TraceEvent[]): TraceNameHistogram {
  const threadName = new Map<string, string>();
  const processName = new Map<number, string>();
  for (const event of events) {
    if (event.cat === "__metadata" && event.name === "thread_name") {
      threadName.set(
        `${event.pid}:${event.tid}`,
        String((event.args as { name?: string } | undefined)?.name ?? ""),
      );
    } else if (event.cat === "__metadata" && event.name === "process_name") {
      processName.set(
        event.pid,
        String((event.args as { name?: string } | undefined)?.name ?? ""),
      );
    }
  }
  const label = (pid: number, tid: number): string => {
    const key = `${pid}:${tid}`;
    return `${processName.get(pid) ?? "?"}/${threadName.get(key) || tid}`;
  };

  const rows = new Map<
    string,
    {
      name: string;
      cat: string;
      ph: string;
      count: number;
      totalUs: number;
      threads: Set<string>;
    }
  >();
  const threadCounts = new Map<string, { label: string; count: number }>();
  for (const event of events) {
    if (event.cat === "__metadata") {
      continue;
    }
    const key = `${event.name} ${event.cat ?? ""} ${event.ph ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        name: event.name,
        cat: event.cat ?? "",
        ph: event.ph ?? "",
        count: 0,
        totalUs: 0,
        threads: new Set(),
      };
      rows.set(key, row);
    }
    row.count++;
    row.totalUs += event.dur ?? 0;
    const threadKey = `${event.pid}:${event.tid}`;
    row.threads.add(label(event.pid, event.tid));
    const existing = threadCounts.get(threadKey);
    if (existing) {
      existing.count++;
    } else {
      threadCounts.set(threadKey, {
        label: label(event.pid, event.tid),
        count: 1,
      });
    }
  }

  return {
    totalEvents: events.length,
    threads: [...threadCounts.entries()]
      .map(([key, value]) => ({ key, label: value.label, count: value.count }))
      .sort((a, b) => b.count - a.count),
    rows: [...rows.values()]
      .map((row) => ({
        name: row.name,
        cat: row.cat,
        ph: row.ph,
        count: row.count,
        totalMs: Math.round((row.totalUs / 1000) * 100) / 100,
        threads: [...row.threads].sort(),
      }))
      .sort((a, b) => b.count - a.count),
  };
}

export function formatTraceNameHistogram(
  histogram: TraceNameHistogram,
  limit = 120,
): string {
  const lines: string[] = [];
  lines.push(`events: ${histogram.totalEvents}`);
  lines.push("");
  lines.push("threads (by event count):");
  for (const thread of histogram.threads.slice(0, 20)) {
    lines.push(
      `  ${String(thread.count).padStart(8)}  ${thread.label} (${thread.key})`,
    );
  }
  lines.push("");
  lines.push(
    `${"count".padStart(8)}  ${"totalMs".padStart(10)}  ph  name  [cat]  threads`,
  );
  for (const row of histogram.rows.slice(0, limit)) {
    lines.push(
      `${String(row.count).padStart(8)}  ${row.totalMs.toFixed(2).padStart(10)}  ${row.ph.padEnd(2)}  ${row.name}  [${row.cat}]  ${row.threads.slice(0, 4).join(", ")}`,
    );
  }
  if (histogram.rows.length > limit) {
    lines.push(`… ${histogram.rows.length - limit} more distinct names`);
  }
  return lines.join("\n");
}
