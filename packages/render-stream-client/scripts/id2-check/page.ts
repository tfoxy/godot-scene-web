// Live ID4 probe. All picks use the public client and pointer resolver over the real wasm core.

import { gpuFormatsOf } from "../../src/hello";
import {
  createRenderStreamClient,
  type ExtensionSession,
  type ItemMeta,
  pointerTargetResolver,
  type RenderStreamExtension,
  webSocketTransport,
} from "../../src/index";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "pick";
const metas = new Map<number, ItemMeta>();
const report = {
  gpuFormats: "none",
  offers: [] as string[],
  hellos: [] as string[],
  statuses: [] as { kind: string; reason?: string; detail?: string }[],
  grant: null as ExtensionSession["itemMeta"],
  statements: 0,
  pick: null as {
    points: (string | null)[];
    size: [number, number];
    grid: [number, number];
  } | null,
  samples: [] as {
    seq: number;
    frame: number;
    target: string | null;
    instanceId?: string;
  }[],
};
const ext: RenderStreamExtension = {
  id: "id4-live",
  wants:
    mode === "tag1"
      ? { fields: ["class", "scene", "path"] }
      : {
          fields: ["path", "instance_id", "mouse_filter"],
          metaKeys: ["rs_pick"],
        },
  onSession(s) {
    report.grant = s.itemMeta;
    metas.clear();
  },
  onItemMeta(b) {
    if (b.form === "full") metas.clear();
    for (const m of b.items) metas.set(m.id, m);
  },
  onItemsRemoved(ids) {
    for (const id of ids) metas.delete(id);
  },
  beforeDraw(f) {
    if (f.seq === null) return;
    const name = (id: number | null) =>
      id === null ? null : (metas.get(id)?.meta.rs_pick ?? `#${id}`);
    if (mode === "pick") {
      const points: (string | null)[] = [];
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 24; x++)
          points.push(
            name(
              f.query.hitTest(((x + 0.5) * 640) / 24, ((y + 0.5) * 360) / 16),
            ),
          );
      report.pick = { points, size: [640, 360], grid: [24, 16] };
    }
    if (mode === "restamp") {
      const target = resolve(212, 72);
      report.samples.push({
        seq: f.seq,
        frame: -1,
        target: target
          ? (metas.get(target.key)?.path ?? `#${target.key}`)
          : null,
        ...(target?.identity.instanceId
          ? { instanceId: target.identity.instanceId }
          : {}),
      });
    }
  },
};
// This deliberately stale statement must lose to the host on both honest and sabotaged legs.
if (mode === "restamp") {
  const onMeta = ext.onItemMeta;
  let session: ExtensionSession | null = null;
  const onSession = ext.onSession;
  ext.onSession = (s) => {
    session = s;
    onSession?.(s);
  };
  ext.onItemMeta = (b) => {
    onMeta?.(b);
    for (const m of b.items)
      if (m.path === "Flipper" && m.mouseFilter === "stop") {
        session?.mouseFilter(m.id, "stop");
        report.statements++;
      }
  };
}
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 360;
canvas.style.cssText =
  "position:absolute;left:0;top:0;width:640px;height:360px";
document.body.style.margin = "0";
document.body.append(canvas);
const client = createRenderStreamClient({
  canvas,
  endpoint: {
    url: params.get("ws") ?? "",
    resourceBase: params.get("http") ?? "",
    token: null,
    protocol: 13,
    presentation: [640, 360],
  },
  core: {
    glueUrl: "/core/rs_gsw_wasm_client.js",
    wasmUrl: "/core/rs_gsw_wasm_bg.wasm",
    expectedTree: params.get("tree") ?? "",
  },
  extensions: mode === "pure" ? [] : [ext],
  recorder: {},
  creditStage: "submitted",
  transport: (endpoint, offer, events) => {
    report.offers.push(offer);
    const t = webSocketTransport(endpoint, offer, events);
    return {
      ...t,
      send(text) {
        if (text.startsWith('{"type":"hello"')) report.hellos.push(text);
        t.send(text);
      },
    };
  },
  onStatus: (s) => report.statuses.push(s),
});
report.gpuFormats = gpuFormatsOf(
  canvas.getContext("webgl2")?.getSupportedExtensions() ?? [],
  null,
);
const resolve = pointerTargetResolver(client);
Object.assign(window, {
  __id4: report,
  __recording: () => Array.from(client.recording()?.bytes ?? []),
});
client.connect();
