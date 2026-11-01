// REC1's live check page (scripts/client-record-check.ts): mounts
// @godot-scene-web/render-stream-client with the recorder on, and exposes the exported recording to
// the driver. No harness code: the package is all it loads.

import {
  createRenderStreamClient,
  type RenderStreamClient,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamStatus,
} from "../../../../packages/render-stream-client/src/index";

interface Mounted {
  client: RenderStreamClient;
  canvas: HTMLCanvasElement;
}

let mounted: Mounted | null = null;
const statuses: (RenderStreamStatus & { t: number })[] = [];

const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

const api = {
  ready: true,
  statuses,
  mount(o: {
    endpoint: RenderStreamEndpoint;
    core: RenderStreamCore;
    maxBytes?: number;
    maxResourceBytes?: number;
  }) {
    if (mounted) throw new Error("already mounted");
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const client = createRenderStreamClient({
      canvas,
      core: o.core,
      endpoint: o.endpoint,
      recorder:
        o.maxBytes !== undefined || o.maxResourceBytes !== undefined
          ? {
              ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
              ...(o.maxResourceBytes !== undefined
                ? { maxResourceBytes: o.maxResourceBytes }
                : {}),
            }
          : {},
      onStatus: (s) => statuses.push({ ...s, t: performance.now() }),
    });
    client.connect();
    mounted = { client, canvas };
  },
  dispose() {
    if (!mounted) return;
    mounted.client.dispose();
    mounted.canvas.remove();
    mounted = null;
  },
  stats() {
    return mounted ? { ...mounted.client.stats() } : null;
  },
  /** The recorder's export: the recording bytes and the fetched payloads, base64. */
  recording(): {
    bytes: string | null;
    records: number;
    fullSeq: number;
    overflow: boolean;
    resources: [string, string][];
  } | null {
    const r = mounted?.client.recording();
    if (!r || r.bytes === null) return null;
    return {
      bytes: toBase64(r.bytes),
      records: r.records,
      fullSeq: r.fullSeq,
      overflow: r.overflow,
      resources: [...r.resources].map(([h, b]) => [h, toBase64(b)]),
    };
  },
};

(window as unknown as { __rsc: typeof api }).__rsc = api;
