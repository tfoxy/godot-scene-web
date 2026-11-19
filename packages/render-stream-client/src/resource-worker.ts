// Kept self-contained: source consumers need no worker entry point or bundler URL rewriting.
import type { ResourceResponse } from "./fetcher";

export const RESOURCE_WORKER_SOURCE = `
const requests = new Map();
self.onmessage = async ({ data: m }) => {
  if (m.type === "abort") {
    requests.get(m.id)?.abort();
    requests.delete(m.id);
    return;
  }
  if (m.type !== "fetch") return;
  const controller = new AbortController();
  requests.set(m.id, controller);
  try {
    const res = await fetch(m.url, {
      headers: m.headers, cache: "default", credentials: "omit", signal: controller.signal,
    });
    const length = Number(res.headers.get("content-length") ?? "");
    const sizeHint = Number.isSafeInteger(length) && length > 0 ? length : 0;
    let bytes = 0;
    self.postMessage({ type: "progress", id: m.id, bytes });
    let body;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          self.postMessage({ type: "progress", id: m.id, bytes });
        }
      } finally {
        reader.releaseLock();
      }
      const out = new Uint8Array(bytes);
      let at = 0;
      for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
      body = out.buffer;
    } else body = await res.arrayBuffer();
    if (!controller.signal.aborted)
      self.postMessage({ type: "body", id: m.id, status: res.status, sizeHint, body }, [body]);
  } catch (error) {
    if (!controller.signal.aborted)
      self.postMessage({ type: "error", id: m.id, error: String(error) });
  } finally {
    requests.delete(m.id);
  }
};
self.postMessage({ type: "ready" });
`;

export interface ResourceWorkerOptions {
  fetchInWorker?: boolean;
  /** Internal test seam; production uses a Blob URL with no imported code. */
  createWorker?: () => Worker;
}

/** A worker request failed before delivering a body (including an abort). */
export class ResourceWorkerError extends Error {}

interface Pending {
  resolve: (response: ResourceResponse) => void;
  reject: (error: Error) => void;
  progress?: () => void;
  fallback: () => void;
  cleanup: () => void;
}

/** One worker for a transport. A failed startup sticks to the original request path. */
export class ResourceWorker {
  private worker: Worker | null = null;
  private disabled: boolean;
  private closed = false;
  private next = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: ResourceWorkerOptions = {}) {
    this.disabled = options.fetchInWorker === false;
  }

  /** Start at socket open so worker initialization precedes resource demand. */
  start(): void {
    if (!this.closed && !this.disabled && !this.worker) {
      try {
        this.worker = this.options.createWorker
          ? this.options.createWorker()
          : blobWorker();
        this.worker.onmessage = ({ data: m }) => {
          if (!m || !["ready", "progress", "body", "error"].includes(m.type)) {
            this.fail();
            return;
          }
          if (m.type === "ready") return;
          const p = this.pending.get(m.id);
          if (!p) return;
          if (m.type === "progress") {
            p.progress?.();
            return;
          }
          this.pending.delete(m.id);
          p.cleanup();
          if (m.type === "body")
            p.resolve({
              status: m.status,
              sizeHint: m.sizeHint,
              body: m.body,
              workerBody: true,
            });
          else
            p.reject(
              new ResourceWorkerError(
                m.error ?? "resource worker message failed",
              ),
            );
        };
        this.worker.onerror = this.worker.onmessageerror = () => this.fail();
      } catch {
        this.fail();
      }
    }
  }

  fetch(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    progress: (() => void) | undefined,
    fallback: () => Promise<ResourceResponse>,
  ): Promise<ResourceResponse> {
    if (this.closed || signal.aborted) return Promise.reject(aborted());
    this.start();
    if (this.disabled) return fallback();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        // Abort is terminal locally even if the worker has already transferred its reply.
        try {
          this.worker?.postMessage({ type: "abort", id });
        } catch {
          this.fail();
        }
        reject(
          Object.assign(new ResourceWorkerError("Resource fetch aborted"), {
            name: "AbortError",
          }),
        );
      };
      this.pending.set(id, {
        resolve,
        reject,
        progress,
        cleanup: () => signal.removeEventListener("abort", onAbort),
        fallback: () => {
          if (signal.aborted) reject(aborted());
          else fallback().then(resolve, reject);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.worker?.postMessage({ type: "fetch", id, url, headers });
      } catch {
        this.fail();
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(aborted());
    }
    this.pending.clear();
  }

  private stop(): void {
    if (!this.worker) return;
    this.worker.onmessage =
      this.worker.onerror =
      this.worker.onmessageerror =
        null;
    this.worker.terminate();
    this.worker = null;
  }

  private fail(): void {
    this.stop();
    if (!this.disabled) {
      this.disabled = true;
      console.warn(
        "render-stream: resource worker unavailable; using main-thread fetch",
      );
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      p.cleanup();
      p.fallback();
    }
  }
}

function aborted(): Error {
  return new DOMException("Resource fetch aborted", "AbortError");
}

function blobWorker(): Worker {
  if (
    typeof Worker !== "function" ||
    typeof Blob !== "function" ||
    typeof URL.createObjectURL !== "function"
  )
    throw new Error("worker API unavailable");
  const url = URL.createObjectURL(
    new Blob([RESOURCE_WORKER_SOURCE], { type: "text/javascript" }),
  );
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
