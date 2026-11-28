import { open } from "node:fs/promises";

export const TRACE_CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "gpu",
  "viz",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
];

export interface TraceConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onComplete(listener: (params: { stream?: string }) => void): () => void;
  dispose(): Promise<void>;
}

/** Browser-target CDP only. Stream chunks go straight to disk, including base64 IO.read chunks. */
export async function startCdpTrace(connection: TraceConnection, path: string) {
  try {
    await connection.send("Tracing.start", {
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: TRACE_CATEGORIES,
      },
      transferMode: "ReturnAsStream",
      streamFormat: "json",
    });
  } catch (error) {
    await connection.dispose();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  const save = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off = () => {};
    let handle: string | undefined;
    try {
      const complete = new Promise<{ stream?: string }>((res, rej) => {
        off = connection.onComplete(res);
        timer = setTimeout(
          () => rej(new Error("Tracing.tracingComplete timed out")),
          180_000,
        );
      });
      const [, result] = await Promise.all([
        connection.send("Tracing.end"),
        complete,
      ]);
      handle = result.stream;
      if (!handle)
        throw new Error("Tracing.tracingComplete returned no stream");
      const file = await open(path, "w");
      try {
        for (;;) {
          const chunk = (await connection.send("IO.read", {
            handle,
            size: 1 << 20,
          })) as { data: string; base64Encoded?: boolean; eof?: boolean };
          await file.writeFile(
            chunk.base64Encoded
              ? Buffer.from(chunk.data, "base64")
              : chunk.data,
          );
          if (chunk.eof) break;
        }
      } finally {
        await file.close();
      }
    } finally {
      if (timer) clearTimeout(timer);
      off();
      if (handle) await connection.send("IO.close", { handle }).catch(() => {});
      await connection.dispose();
    }
  };
  return { stop: () => (stopping ??= save()) };
}
