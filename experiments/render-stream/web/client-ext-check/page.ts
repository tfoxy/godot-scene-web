// TAG2's live check page (scripts/client-ext-check.ts): mounts @godot-scene-web/render-stream-client
// with one of the test extensions below -- each makes, by tag, the change fixtures/tag-scene's
// variant makes in the game (client-extensions-design.md §6) -- counts what the transport carried,
// and reads the drawn canvas back. The package is all it loads.

import {
  createRenderStreamClient,
  type ItemMeta,
  type RenderStreamClient,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamExtension,
  type RenderStreamStatus,
  webSocketTransport,
} from "../../../../packages/render-stream-client/src/index";

// The shot reads the canvas's drawing buffer after the stream ended, so the page keeps it
// (preserveDrawingBuffer changes when the browser may clear it, not what is drawn).
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  type: string,
  attrs?: Record<string, unknown>,
) {
  return (
    getContext as (t: string, a?: unknown) => RenderingContext | null
  ).call(
    this,
    type,
    type === "webgl2"
      ? { ...(attrs ?? {}), preserveDrawingBuffer: true }
      : attrs,
  );
} as typeof HTMLCanvasElement.prototype.getContext;

const CARD = "res://card.tscn";
const MAIN = "res://tag.tscn";
const LIFT = -119;
const SCALE = 1.24;
const TINT = [1, 0.5, 0.5, 0.75] as const;
/** The DescriptionLabel's bottom centre in its own space (card.tscn: 72x24). */
const LABEL_PIVOT = [36, 24] as const;

interface Counters {
  overridesSet: number;
  beforeDraws: number;
  nullFrames: number;
  sessions: (string | null)[];
  itemMetaRows: number;
  removed: number;
  /** override-redraw: the animation's window. */
  anim: {
    startedAt: number | null;
    steps: number;
    endedAt: number | null;
    binaryDuring: number;
    acksDuring: number;
  };
}

const counters: Counters = {
  overridesSet: 0,
  beforeDraws: 0,
  nullFrames: 0,
  sessions: [],
  itemMetaRows: 0,
  removed: 0,
  anim: {
    startedAt: null,
    steps: 0,
    endedAt: null,
    binaryDuring: 0,
    acksDuring: 0,
  },
};
const transport = { binary: 0, acks: 0, lastBinaryAt: 0 };

const isCard1 = (m: ItemMeta | null) =>
  m?.scene === CARD && m.path === "." && m.meta.rs_slot === "1";

/** The test extensions, by name. Each selects its item by tag in onItemMeta and writes the
 * override in beforeDraw (recomputed every frame: the table keeps only real changes). */
function extensionOf(name: string): RenderStreamExtension[] {
  if (name === "none") return [];
  const wants = {
    fields: ["scene", "path"] as const,
    metaKeys: ["rs_slot"],
  };
  const tagged = new Map<number, ItemMeta>();
  const base: RenderStreamExtension = {
    id: `tag2.${name}`,
    wants: { fields: [...wants.fields], metaKeys: wants.metaKeys },
    onSession: (s) => {
      counters.sessions.push(
        s.itemMeta === null ? null : JSON.stringify(s.itemMeta),
      );
      tagged.clear();
      // override-redraw: nothing draws while the host is quiet, so the animation is started from
      // outside a frame, as an input or a timer would (ExtensionSession.requestRedraw).
      if (name === "redraw") {
        const poll = () => {
          if (
            transport.binary > 0 &&
            performance.now() - transport.lastBinaryAt > 400 &&
            tagged.size > 0
          )
            s.requestRedraw();
          else setTimeout(poll, 100);
        };
        setTimeout(poll, 100);
      }
    },
    onItemMeta: (b) => {
      if (b.form === "full") tagged.clear();
      for (const m of b.items) if (m.node) tagged.set(m.id, m);
      counters.itemMetaRows += b.items.length;
    },
    onItemsRemoved: (ids) => {
      for (const id of ids) tagged.delete(id);
      counters.removed += ids.length;
    },
  };
  const find = (pred: (m: ItemMeta) => boolean) =>
    [...tagged.values()].filter(pred).map((m) => m.id);
  let anim: { from: number; step: number } | null = null;
  return [
    {
      ...base,
      beforeDraw: (f) => {
        counters.beforeDraws++;
        if (f.seq === null) counters.nullFrames++;
        const before = f.overrides.size;
        switch (name) {
          case "identity":
            for (const id of tagged.keys()) f.overrides.set(id, {});
            break;
          case "moved":
            for (const id of find(isCard1)) f.overrides.translate(id, 0, LIFT);
            break;
          case "scaled":
            for (const id of find(
              (m) =>
                m.scene === CARD && m.path === "CardContainer/DescriptionLabel",
            )) {
              const panel = f.query.parent(id);
              const card = panel === null ? null : f.query.parent(panel);
              if (card === null || !isCard1(f.query.meta(card))) continue;
              const t = f.query.transform(id);
              if (t === null) continue;
              const [x, y] = LABEL_PIVOT;
              f.overrides.scaleAbout(
                id,
                SCALE,
                SCALE,
                t[0] * x + t[2] * y + t[4],
                t[1] * x + t[3] * y + t[5],
              );
            }
            break;
          case "hidden":
            for (const id of find(
              (m) => m.scene === MAIN && m.path === "Table",
            ))
              f.overrides.set(id, { visible: false });
            break;
          case "tinted":
            for (const id of find((m) => m.scene === MAIN && m.path === "Hand"))
              f.overrides.set(id, { modulate: TINT });
            break;
          case "redraw": {
            // override-redraw: the host sleeps (RS_FIXTURE_TAG_PAUSE_MS); the session's
            // requestRedraw (below) starts the lift with no transaction: 20 frames, one
            // requestRedraw per step.
            const a = counters.anim;
            if (anim === null && a.startedAt === null && f.seq === null) {
              anim = { from: 0, step: 0 };
              a.startedAt = performance.now();
              a.binaryDuring = transport.binary;
              a.acksDuring = transport.acks;
            }
            if (anim !== null) {
              anim.step++;
              a.steps = anim.step;
              for (const id of find(isCard1))
                f.overrides.translate(id, 0, (LIFT * anim.step) / 20);
              if (anim.step < 20) f.requestRedraw();
              else {
                anim = null;
                a.endedAt = performance.now();
                a.binaryDuring = transport.binary - a.binaryDuring;
                a.acksDuring = transport.acks - a.acksDuring;
              }
            }
            break;
          }
          default:
            throw new Error(`client-ext-check: unknown extension ${name}`);
        }
        counters.overridesSet = Math.max(
          counters.overridesSet,
          f.overrides.size,
          before,
        );
      },
    },
  ];
}

let mounted: { client: RenderStreamClient; canvas: HTMLCanvasElement } | null =
  null;
const statuses: (RenderStreamStatus & { t: number })[] = [];

const api = {
  ready: true,
  statuses,
  counters,
  transport,
  mount(o: {
    endpoint: RenderStreamEndpoint;
    core: RenderStreamCore;
    extension: string;
    width: number;
    height: number;
  }) {
    if (mounted) throw new Error("already mounted");
    const canvas = document.createElement("canvas");
    canvas.width = o.width;
    canvas.height = o.height;
    document.body.append(canvas);
    const client = createRenderStreamClient({
      canvas,
      core: o.core,
      endpoint: o.endpoint,
      extensions: extensionOf(o.extension),
      transport: (e, sub, on) => {
        const t = webSocketTransport(e, sub, {
          ...on,
          message: (d) => {
            if (typeof d !== "string") {
              transport.binary++;
              transport.lastBinaryAt = performance.now();
            }
            on.message(d);
          },
        });
        return {
          send: (text: string) => {
            if (text.startsWith('{"type":"ack"')) transport.acks++;
            t.send(text);
          },
          close: (code: number, reason: string) => t.close(code, reason),
          fetchResource: (p, i) => t.fetchResource(p, i),
        };
      },
      onStatus: (s) => statuses.push({ ...s, t: performance.now() }),
    });
    client.connect();
    mounted = { client, canvas };
  },
  stats() {
    return mounted ? { ...mounted.client.stats() } : null;
  },
  /** The drawing buffer, RGBA rows top first, as base64. */
  shot(): { width: number; height: number; rgba: string } | null {
    const gl = mounted?.canvas.getContext(
      "webgl2",
    ) as WebGL2RenderingContext | null;
    if (!gl || !mounted) return null;
    const w = mounted.canvas.width;
    const h = mounted.canvas.height;
    const prev = gl.getParameter(
      gl.READ_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const align = gl.getParameter(gl.PACK_ALIGNMENT) as number;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.pixelStorei(gl.PACK_ALIGNMENT, align);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    // GL rows are bottom first.
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    let s = "";
    for (let i = 0; i < out.length; i += 0x8000)
      s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return { width: w, height: h, rgba: btoa(s) };
  },
  dispose() {
    if (!mounted) return;
    mounted.client.dispose();
    mounted.canvas.remove();
    mounted = null;
  },
};

(window as unknown as { __rse: typeof api }).__rse = api;
