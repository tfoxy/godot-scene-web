// CAR5's live check page (scripts/client-carrier-check.ts): mounts @godot-scene-web/render-stream-
// client with the recorder on and a chosen `carrier`, and exposes statuses and the recording to the
// driver. No harness code: the package is all it loads.

import {
  createRenderStreamClient,
  type RenderStreamCarrier,
  type RenderStreamClient,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamStatus,
} from "../../../../packages/render-stream-client/src/index";

let client: RenderStreamClient | null = null;
let canvas: HTMLCanvasElement | null = null;
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
    carrier?: RenderStreamCarrier;
  }) {
    if (client) throw new Error("already mounted");
    canvas = document.createElement("canvas");
    document.body.append(canvas);
    client = createRenderStreamClient({
      canvas,
      core: o.core,
      endpoint: o.endpoint,
      ...(o.carrier ? { carrier: o.carrier } : {}),
      recorder: {},
      onStatus: (s) => statuses.push({ ...s, t: performance.now() }),
    });
    client.connect();
  },
  dispose() {
    client?.dispose();
    canvas?.remove();
    client = null;
    canvas = null;
  },
  stats() {
    return client ? { ...client.stats() } : null;
  },
  /** The recorder's export (base64) of the decoded messages since the last full. */
  recording(): { bytes: string; records: number; fullSeq: number } | null {
    const r = client?.recording();
    if (!r || r.bytes === null) return null;
    return {
      bytes: toBase64(r.bytes),
      records: r.records,
      fullSeq: r.fullSeq,
    };
  },
};

(window as unknown as { __rsc: typeof api }).__rsc = api;
