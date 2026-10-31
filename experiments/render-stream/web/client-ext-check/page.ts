// TAG2's live check page (scripts/client-ext-check.ts): mounts @godot-scene-web/render-stream-client
// with one of the test extensions below -- each makes, by tag, the change fixtures/tag-scene's
// variant makes in the game (client-extensions-design.md §6) -- counts what the transport carried,
// and reads the drawn canvas back. The package is all it loads.

import {
  createRenderStreamClient,
  type ItemMeta,
  type ItemQuery,
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

const CSS_LEFT = 20;
const CSS_TOP = 30;
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
const isCardSlot = (m: ItemMeta | null, slot: number) =>
  m?.scene === CARD && m.path === "." && m.meta.rs_slot === String(slot);

/** INP1's `inp` extension: Card1 lifted (as `moved`), Card2 scaled 1.24 about the centre of its
 * subtree, Card4 untouched. The probe runs during a frame (the core's state is reset when the
 * stream ends, so `probe()` after the end only reads what `beforeDraw` stored). */
const inp: {
  query: ItemQuery | null;
  tagged: Map<number, ItemMeta> | null;
  client: RenderStreamClient | null;
  canvas: HTMLCanvasElement | null;
  css: [number, number] | null;
  result: unknown;
} = {
  query: null,
  tagged: null,
  client: null,
  canvas: null,
  css: null,
  result: null,
};

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
          case "inp": {
            inp.query = f.query;
            inp.tagged = tagged;
            for (const id of find(isCard1)) f.overrides.translate(id, 0, LIFT);
            for (const id of find((m) => isCardSlot(m, 2))) {
              const r = f.query.subtreeRect(id);
              if (r === null) continue;
              f.overrides.scaleAbout(
                id,
                SCALE,
                SCALE,
                r.x + r.w / 2,
                r.y + r.h / 2,
              );
            }
            // The probe runs during a frame: `probe()` after the end reads this stored result
            // (the core's state is reset at stream end).
            if (inp.client && inp.canvas && inp.css)
              inp.result = computeProbe(
                inp.client,
                inp.canvas,
                f.query,
                tagged,
                inp.css,
              );
            break;
          }
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

/**
 * INP1: the pointer mapping against the scene the `inp` extension drew. Computed during a frame
 * (`beforeDraw`), while the core's state is still live: the tap expectations come from the game's
 * own state (query.rect, never the override) and the page's CSS box, not from the client's layout
 * code; the results come from the client's `clientToGame`/`cssToPresentation`/`presentationToCss`.
 */
function computeProbe(
  client: RenderStreamClient,
  canvas: HTMLCanvasElement,
  q: ItemQuery,
  tagged: Map<number, ItemMeta>,
  css: [number, number],
): unknown {
  const W = canvas.width;
  const H = canvas.height;
  const s = Math.min(css[0] / W, css[1] / H);
  const ox = CSS_LEFT + (css[0] - W * s) / 2;
  const oy = CSS_TOP + (css[1] - H * s) / 2;
  const toClient = (x: number, y: number): [number, number] => [
    ox + x * s,
    oy + y * s,
  ];
  const slotOf = (id: number): string | null => {
    for (let c: number | null = id, g = 0; c !== null && g < 32; g++) {
      const m = q.meta(c);
      if (m?.scene === CARD && m.path === ".") return m.meta.rs_slot ?? null;
      c = q.parent(c);
    }
    return null;
  };
  const find = (slot: number, path: string) =>
    [...tagged.values()].find(
      (m) =>
        m.scene === CARD && m.path === path && slotOf(m.id) === String(slot),
    )?.id ?? null;
  // E for the two overridden cards, as the extension wrote them.
  const lift = (x: number, y: number): [number, number] => [x, y + LIFT];
  const pivot2 = (() => {
    const card = [...tagged.values()].find((m) => isCardSlot(m, 2));
    const r = card ? q.subtreeRect(card.id) : null;
    return r ? ([r.x + r.w / 2, r.y + r.h / 2] as const) : null;
  })();
  const scale = (x: number, y: number): [number, number] =>
    pivot2
      ? [
          pivot2[0] + SCALE * (x - pivot2[0]),
          pivot2[1] + SCALE * (y - pivot2[1]),
        ]
      : [x, y];
  interface Spec {
    name: string;
    slot: number;
    path: string;
    local: [number, number] | null;
    draw: (x: number, y: number) => [number, number];
    overridden: boolean;
  }
  const specs: Spec[] = [
    {
      name: "raised-art-centre",
      slot: 1,
      path: "Art",
      local: null,
      draw: lift,
      overridden: true,
    },
    {
      name: "raised-panel-bottom",
      slot: 1,
      path: "CardContainer",
      local: [40, 100],
      draw: lift,
      overridden: true,
    },
    {
      name: "scaled-art-corner",
      slot: 2,
      path: "Art",
      local: [10, 10],
      draw: scale,
      overridden: true,
    },
    {
      name: "plain-art-centre",
      slot: 4,
      path: "Art",
      local: null,
      draw: (x, y) => [x, y],
      overridden: false,
    },
  ];
  const cases = specs.map((sp) => {
    const id = find(sp.slot, sp.path);
    const r = id === null ? null : q.rect(id);
    if (id === null || r === null) return { name: sp.name, missing: true };
    const game: [number, number] = sp.local
      ? [r.x + sp.local[0], r.y + sp.local[1]]
      : [r.x + r.w / 2, r.y + r.h / 2];
    const drawn = sp.draw(game[0], game[1]);
    const [cx, cy] = toClient(drawn[0], drawn[1]);
    const got = client.clientToGame(cx, cy);
    const viaTwo = client.cssToPresentation(cx, cy);
    return {
      name: sp.name,
      slot: sp.slot,
      item: id,
      overridden: sp.overridden,
      game,
      drawn,
      client: [cx, cy],
      got: got && {
        item: got.item,
        itemSlot: got.item === null ? null : slotOf(got.item),
        itemPath: got.item === null ? null : (q.meta(got.item)?.path ?? null),
        point: [got.point.x, got.point.y],
        drawn: [got.drawn.x, got.drawn.y],
      },
      cssToPresentation: viaTwo && [viaTwo.x, viaTwo.y],
      hitTest: q.hitTest(drawn[0], drawn[1]),
    };
  });
  // Where Card1 was, before the lift: nothing of it is drawn.
  const art1 = find(1, "Art");
  const r1 = art1 === null ? null : q.rect(art1);
  let vacated: unknown = { missing: true };
  if (r1) {
    const g: [number, number] = [r1.x + r1.w / 2, r1.y + r1.h / 2];
    const [cx, cy] = toClient(g[0], g[1]);
    const got = client.clientToGame(cx, cy);
    vacated = {
      game: g,
      got: got && {
        item: got.item,
        itemSlot: got.item === null ? null : slotOf(got.item),
        point: [got.point.x, got.point.y],
      },
    };
  }
  // The bars (top, bottom, left, right of the picture) and outside the CSS box.
  const bars: [string, number, number][] = [
    ["top-bar", ox + (W * s) / 2, oy - 1],
    ["bottom-bar", ox + (W * s) / 2, oy + H * s + 1],
    ["left-bar", ox - 1, oy + (H * s) / 2],
    ["right-bar", ox + W * s + 1, oy + (H * s) / 2],
    ["outside-box", CSS_LEFT - 5, CSS_TOP - 5],
  ];
  const letterbox = bars.map(([name, x, y]) => ({
    name,
    client: [x, y],
    inBox:
      x >= CSS_LEFT &&
      x < CSS_LEFT + css[0] &&
      y >= CSS_TOP &&
      y < CSS_TOP + css[1],
    cssToPresentation: client.cssToPresentation(x, y),
    clientToGame: client.clientToGame(x, y),
  }));
  // The picture's corners map to the presentation's.
  const [ax, ay] = toClient(0.5, 0.5);
  const [bx, by] = toClient(W - 0.5, H - 0.5);
  const a = client.cssToPresentation(ax, ay);
  const b = client.cssToPresentation(bx, by);
  // presentationToCss round-trips an item's rect.
  const rr = r1 ? client.presentationToCss(r1) : null;
  const want = r1
    ? { x: ox + r1.x * s, y: oy + r1.y * s, w: r1.w * s, h: r1.h * s }
    : null;
  const diag = {
    tagged: tagged.size,
    cardArts: [...tagged.values()]
      .filter((m) => m.scene === CARD && m.path === "Art")
      .map((m) => ({ id: m.id, slot: slotOf(m.id), rect: q.rect(m.id) })),
  };
  return {
    diag,
    presentation: [W, H],
    css,
    scale: s,
    cases,
    vacated,
    letterbox,
    corners: { a, b },
    overlay: { got: rr, want },
  };
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
    /** INP1: the canvas's CSS box (px), object-fit contain at (CSS_LEFT, CSS_TOP): a letterbox. */
    css?: [number, number];
  }) {
    if (mounted) throw new Error("already mounted");
    const canvas = document.createElement("canvas");
    canvas.width = o.width;
    canvas.height = o.height;
    if (o.css)
      canvas.style.cssText = `position:absolute;left:${CSS_LEFT}px;top:${CSS_TOP}px;width:${o.css[0]}px;height:${o.css[1]}px;object-fit:contain`;
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
    inp.client = client;
    inp.canvas = canvas;
    inp.css = o.css ?? null;
  },
  stats() {
    return mounted ? { ...mounted.client.stats() } : null;
  },
  /**
   * INP1: the pointer mapping the `inp` extension computed during a frame (`beforeDraw`).
   * `probe()` after the stream ended only returns it: the core state is reset at end.
   */
  probe() {
    return inp.result;
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
