// Kept self-contained: source consumers need no worker entry point or bundler URL rewriting.
import type { ResourceResponse } from "./fetcher";
import { FETCH_PARALLEL } from "./resource-limits";
import { SHA256_WORKER_SOURCE } from "./sha256";

export const RESOURCE_WORKER_SOURCE = `
${SHA256_WORKER_SOURCE}
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
    // In insecure contexts, overlap the JS fallback with the network reads.
    let t = performance.now();
    const incremental = res.status === 200 && !globalThis.crypto?.subtle ? new Sha256() : null;
    let hashMs = incremental ? performance.now() - t : 0;
    let bytes = 0;
    self.postMessage({ type: "progress", id: m.id, bytes });
    let body;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) return;
          if (done) break;
          if (incremental) {
            t = performance.now();
            incremental.update(value);
            hashMs += performance.now() - t;
          }
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
      chunks.length = 0;
      body = out.buffer;
    } else {
      body = await res.arrayBuffer();
      if (!controller.signal.aborted && incremental) {
        t = performance.now();
        incremental.update(body);
        hashMs += performance.now() - t;
      }
    }
    let digest, digestPath;
    if (res.status === 200 && !controller.signal.aborted) {
      let hash;
      if (incremental) {
        t = performance.now();
        hash = incremental.digest();
        hashMs += performance.now() - t;
      }
      if (hash) digestPath = "js-incremental";
      try {
        if (!hash && globalThis.crypto?.subtle) {
          t = performance.now();
          try {
            hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
            digestPath = "native";
          } finally {
            hashMs += performance.now() - t;
          }
        }
      } catch { /* The same incremental fallback also covers a rejected native digest. */ }
      if (!hash) {
        t = performance.now();
        const h = new Sha256();
        const bytes = new Uint8Array(body);
        for (let at = 0; at < bytes.length; at += 262144)
          h.update(bytes.subarray(at, at + 262144));
        hash = h.digest();
        hashMs += performance.now() - t;
        digestPath = "js-incremental";
      }
      digest = Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
    }
    // Transfer ownership of the exact hashed bytes; keep no exposed or reusable body view.
    if (!controller.signal.aborted)
      self.postMessage({ type: "body", id: m.id, status: res.status, sizeHint, body, digest, digestPath, hashMs }, [body]);
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
  worker: Worker | null;
  request: {
    type: "fetch";
    id: number;
    url: string;
    headers: Record<string, string>;
  };
  resolve: (response: ResourceResponse) => void;
  reject: (error: Error) => void;
  progress?: () => void;
  fallback: () => void;
  cleanup: () => void;
  messageMs: number;
}

/** One lazy worker per fetch slot; only capability failures disable the whole pool. */
export class ResourceWorker {
  private readonly workers: Worker[] = [];
  private disabled: boolean;
  private closed = false;
  private next = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: ResourceWorkerOptions = {}) {
    this.disabled = options.fetchInWorker === false;
  }

  private makeWorker(): Worker {
    const worker = this.options.createWorker
      ? this.options.createWorker()
      : blobWorker();
    this.workers.push(worker);
    let ready = false;
    const fail = () => {
      if (ready) this.failWorker(worker);
      else this.fail();
    };
    worker.onmessage = ({ data: m }) => {
      if (!m || !["ready", "progress", "body", "error"].includes(m.type)) {
        fail();
        return;
      }
      if (m.type === "ready") {
        ready = true;
        return;
      }
      const p = this.pending.get(m.id);
      if (!p || p.worker !== worker) return;
      const t = performance.now();
      if (m.type === "progress") {
        p.progress?.();
        p.messageMs += performance.now() - t;
        return;
      }
      this.pending.delete(m.id);
      p.cleanup();
      if (m.type === "body") {
        const response: ResourceResponse = {
          status: m.status,
          sizeHint: m.sizeHint,
          body: m.body,
          workerBody: true,
          workerHashMs:
            Number.isFinite(m.hashMs) && m.hashMs >= 0 ? m.hashMs : 0,
          workerDigest: typeof m.digest === "string" ? m.digest : undefined,
          workerDigestPath:
            m.digestPath === "native" || m.digestPath === "js-incremental"
              ? m.digestPath
              : undefined,
        };
        p.resolve(response);
        response.workerMessageMs = p.messageMs + performance.now() - t;
      } else
        p.reject(
          new ResourceWorkerError(m.error ?? "resource worker message failed"),
        );
      this.pump();
    };
    worker.onerror = worker.onmessageerror = fail;
    return worker;
  }

  private pump(): void {
    for (const p of this.pending.values()) {
      if (this.closed || this.disabled) return;
      if (p.worker) continue;
      let worker = this.workers.find(
        (w) =>
          !Array.from(this.pending.values()).some(
            (other) => other.worker === w,
          ),
      );
      if (!worker && this.workers.length >= FETCH_PARALLEL) return;
      try {
        worker ??= this.makeWorker();
        p.worker = worker;
        worker.postMessage(p.request);
      } catch {
        this.fail();
        return;
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
          p.worker?.postMessage({ type: "abort", id });
        } catch {
          this.fail();
        }
        this.pump();
        reject(
          Object.assign(new ResourceWorkerError("Resource fetch aborted"), {
            name: "AbortError",
          }),
        );
      };
      this.pending.set(id, {
        worker: null,
        request: { type: "fetch", id, url, headers },
        resolve,
        reject,
        progress,
        messageMs: 0,
        cleanup: () => signal.removeEventListener("abort", onAbort),
        fallback: () => {
          if (signal.aborted) reject(aborted());
          else fallback().then(resolve, reject);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.pump();
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
    for (const worker of this.workers) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    this.workers.length = 0;
  }

  private failWorker(worker: Worker): void {
    const index = this.workers.indexOf(worker);
    if (index === -1) return;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    this.workers.splice(index, 1);
    for (const [id, p] of this.pending) {
      if (p.worker !== worker) continue;
      this.pending.delete(id);
      p.cleanup();
      p.fallback();
      break;
    }
    this.pump();
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
