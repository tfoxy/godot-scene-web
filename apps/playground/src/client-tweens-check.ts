// Real-consumer probe: sample the item texture actually uploaded to WebGL, after draw().
// No alternate tween evaluator participates in the assertions.
import { createRenderStreamClient } from "../../../packages/render-stream-client/src/client";
import { WasmStreamCore } from "../../../packages/render-stream-client/src/core";
import { createWebSocketTransport } from "../../../packages/render-stream-client/src/transport";

type Label = "enabled" | "disabled";
type Item = {
  id: number;
  parent: { kind: "item" | "canvas"; id: number } | null;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
  commands: { op: string }[];
};
type Material = {
  id: number;
  params: { name: string; value: number | number[] }[];
};
type State = {
  seq: number;
  frame: number;
  t_us: number;
  items: Item[];
  materials: Material[];
};
type Uniforms = { threshold: number; shift: number[] };
export type Draw = {
  at: number;
  seq: number;
  rows: number[][];
  host: Item[];
  diag: Record<string, number>;
  pixel: number[];
  creationNode: number[] | null;
  uniforms: Uniforms[];
  tiles: number[][];
  materials: Material[];
  active: boolean;
};
export type Trace = {
  startedAt: number;
  acks: { at: number; seq: number; stage: string }[];
  itemIds: number[];
  motionId: number | null;
  controlId: number | null;
  transactions: { at: number; seq: number; frame: number; t_us: number }[];
  draws: Draw[];
  holds: { start: number; end: number }[];
  shots: Record<string, string>;
};
const trace = (): Trace => ({
  startedAt: 0,
  acks: [],
  itemIds: [],
  motionId: null,
  controlId: null,
  transactions: [],
  draws: [],
  holds: [],
  shots: {},
});
const traces = { enabled: trace(), disabled: trace() };
const labels = new WeakMap<WasmStreamCore, Label>();
let connecting: Label = "enabled";
let started = 0;
const refusals: {
  label: Label;
  shader: number;
  reason: string;
  detail: string;
}[] = [];
const observed = new WeakSet<object>();
const textures = new WeakMap<WebGL2RenderingContext, number[][]>();
const upload = WebGL2RenderingContext.prototype.texSubImage2D;
WebGL2RenderingContext.prototype.texSubImage2D = new Proxy(upload, {
  apply(fn, gl: WebGL2RenderingContext, args: unknown[]) {
    // The executor's unit-1 RGBA32F item table: three RGBA texels per item.
    if (
      gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE1 &&
      args[7] === gl.FLOAT &&
      ArrayBuffer.isView(args[8])
    ) {
      const src = args[8] as Float32Array;
      const offset = Number(args[9] ?? 0);
      const x = Number(args[2]);
      const y = Number(args[3]);
      const count = (Number(args[4]) * Number(args[5])) / 3;
      const rows = textures.get(gl) ?? [];
      for (let n = 0; n < count; n++)
        rows[y * 512 + x / 3 + n] = Array.from(
          src.subarray(offset + n * 12, offset + (n + 1) * 12),
        );
      textures.set(gl, rows);
    }
    return Reflect.apply(fn, gl, args);
  },
});
// Observe values submitted to the real GL draw calls, including tween-only redraws.
const locations = new WeakMap<
  WebGLProgram,
  Map<string, WebGLUniformLocation>
>();
const uniforms = new WeakMap<WebGL2RenderingContext, Uniforms[]>();
const locate = WebGL2RenderingContext.prototype.getUniformLocation;
WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
  const location = locate.call(this, program, name);
  if (location && (name === "threshold" || name === "shift")) {
    const table = locations.get(program) ?? new Map();
    table.set(name, location);
    locations.set(program, table);
  }
  return location;
};
for (const method of [
  "drawArrays",
  "drawElements",
  "drawArraysInstanced",
  "drawElementsInstanced",
] as const) {
  const original = WebGL2RenderingContext.prototype[method];
  Object.defineProperty(WebGL2RenderingContext.prototype, method, {
    value: new Proxy(original, {
      apply(fn, gl: WebGL2RenderingContext, args: unknown[]) {
        const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
        const table = locations.get(program);
        if (table?.has("threshold")) {
          const rows = uniforms.get(gl) ?? [];
          const shift = table.get("shift");
          rows.push({
            threshold: Number(gl.getUniform(program, table.get("threshold")!)),
            shift: shift
              ? Array.from(gl.getUniform(program, shift) as Float32Array)
              : [],
          });
          uniforms.set(gl, rows);
        }
        return Reflect.apply(fn, gl, args);
      },
    }),
  });
}
const receive = WasmStreamCore.prototype.receive;
WasmStreamCore.prototype.receive = function (...args) {
  if (!labels.has(this)) labels.set(this, connecting);
  const g = Reflect.get(this, "g");
  if (!observed.has(g)) {
    observed.add(g);
    const refuse = g.refuse_program.bind(g);
    g.refuse_program = (shader: number, reason: string, detail: string) => {
      refusals.push({ label: labels.get(this)!, shader, reason, detail });
      return refuse(shader, reason, detail);
    };
  }
  const result = receive.apply(this, args);
  if (result.kind === "transaction") {
    const decoded = Reflect.get(this, "decoded") as Uint8Array;
    const size = new DataView(decoded.buffer, decoded.byteOffset).getUint32(
      4,
      true,
    );
    const state = JSON.parse(
      new TextDecoder().decode(decoded.subarray(8, 8 + size)),
    ) as State;
    traces[labels.get(this)!].transactions.push({
      at: performance.now(),
      seq: result.seq,
      frame: result.frame,
      t_us: state.t_us,
    });
  }
  return result;
};
const draw = WasmStreamCore.prototype.draw;
WasmStreamCore.prototype.draw = function (seq) {
  const label = labels.get(this)!;
  const canvas = document.getElementById(label) as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2")!;
  uniforms.set(gl, []);
  draw.call(this, seq);
  const state = JSON.parse(Reflect.get(this, "g").state_canonical())
    .state as State;
  // Compare uploaded world poses with the same composition of authoritative local poses.
  const world = (item: Item): number[] => {
    const parent =
      item.parent?.kind === "item"
        ? state.items.find((p) => p.id === item.parent!.id)
        : undefined;
    if (!parent) return item.xform;
    const a = world(parent),
      b = item.xform;
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  };
  const rows = (textures.get(gl) ?? []).map((r) => [...r]);
  const out = traces[label];
  if (!out.itemIds.length) {
    // Identify the initial polygon and ColorRect by their draw commands once.
    out.itemIds = state.items.map((item) => item.id);
    out.motionId =
      state.items.find((item) =>
        item.commands.some((command) => command.op === "add_mesh"),
      )?.id ?? null;
    out.controlId =
      state.items.find((item) =>
        item.commands.some((command) => command.op === "add_rect"),
      )?.id ?? null;
    if (out.motionId === null || out.controlId === null)
      throw new Error("missing Motion or Pivoted fixture item");
  }
  out.itemIds = state.items.map((item) => item.id);
  const creationIndex = state.items.findIndex((item) => item.xform[5] === 310);
  const node = rows[out.itemIds.indexOf(out.motionId!)];
  if (!node) throw new Error(`missing uploaded Motion item ${out.motionId}`);
  const pixel = new Uint8Array(4);
  // The executor leaves its offscreen picture bound for reading after presentation; sample the
  // presented canvas (bottom-up rows) for the probe pixel and the tiles, then restore it.
  const readFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  {
    const x = node[4] + node[0] * 20 + node[2] * 14;
    const y = node[5] + node[1] * 20 + node[3] * 14;
    gl.readPixels(
      Math.round(x),
      canvas.height - 1 - Math.round(y),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
  }
  const tiles = [25, 105, 185, 265, 345, 425, 25].map((x, index) => {
    const pixels = new Uint8Array(56 * 44 * 4);
    gl.readPixels(
      x,
      360 - (index === 6 ? 70 : 10) - 44,
      56,
      44,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    const sum = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4)
      for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
    return sum.map((v) => v / (56 * 44));
  });
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer);
  const diag = this.tweenDiagnostics();
  out.draws.push({
    at: performance.now(),
    seq,
    rows,
    host: state.items.map((item) => ({ ...item, xform: world(item) })),
    diag: { ...diag },
    pixel: [...pixel],
    creationNode: creationIndex < 0 ? null : rows[creationIndex],
    uniforms: uniforms.get(gl) ?? [],
    tiles,
    materials: state.materials,
    active: this.tweensActive(),
  });
  const age = performance.now() - started;
  const phase =
    diag.cancels > 0 && diag.completed > 0
      ? "completion"
      : diag.cancels > 0
        ? "cancel"
        : started > 0 && age > 550 && age < 900
          ? "intermediate"
          : null;
  if (phase && !out.shots[phase]) out.shots[phase] = canvas.toDataURL();
};
const params = new URLSearchParams(location.search);
const port = params.get("host");
if (!port) throw new Error("Pass ?host=<capture listener port>");
const coreRoot = params.get("core") ?? "/@fs/core";
const clients: ReturnType<typeof createRenderStreamClient>[] = [];
async function connect(label: Label) {
  connecting = label;
  const base = createWebSocketTransport({ fetchInWorker: false });
  const pending: (ArrayBuffer | string)[] = [];
  let holding = false;
  let extensionItem: number | null = null;
  let failure: string | null = null;
  const client = createRenderStreamClient({
    onStatus: (s) => {
      if (s.kind === "failed") failure = JSON.stringify(s);
    },
    canvas: document.getElementById(label) as HTMLCanvasElement,
    core: {
      glueUrl: `${coreRoot}/rs_gsw_wasm_client.js`,
      wasmUrl: `${coreRoot}/rs_gsw_wasm_bg.wasm`,
    },
    endpoint: {
      url: `ws://127.0.0.1:${port}/render-stream`,
      resourceBase: `http://127.0.0.1:${port}`,
      token: null,
      protocol: 19,
      presentation: [640, 360],
    },
    clientTweens: label === "enabled" && params.get("sabotage") !== "disabled",
    // A single credit keeps the deliberate receive hold from testing adaptive draw pacing.
    creditWindow: 1,
    extensions: [
      {
        id: "material-coexistence",
        beforeDraw(frame) {
          // A fixed item override composes above node and material display playback.
          extensionItem ??= frame.query.hitTest(530, 20);
          if (extensionItem !== null)
            frame.overrides.translate(extensionItem, 8, 0);
        },
      },
    ],
    recorder: { maxBytes: 16 * 1024 * 1024 },
    transport: (endpoint, protocol, on) => {
      deliver.set(label, (data) => on.message(data));
      const transport = base(endpoint, protocol, {
        ...on,
        message(data) {
          if (holding) pending.push(data);
          else on.message(data);
        },
      });
      const send = transport.send.bind(transport);
      transport.send = (text) => {
        const control = JSON.parse(text);
        if (control.type === "ack")
          traces[label].acks.push({
            at: performance.now(),
            seq: control.seq,
            stage: control.stage,
          });
        send(text);
      };
      return transport;
    },
  });
  clients.push(client);
  client.connect();
  await new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + 30000;
    const timer = setInterval(() => {
      if ((traces[label].draws.at(-1)?.uniforms.length ?? 0) >= 4) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() > deadline || failure !== null) {
        clearInterval(timer);
        reject(new Error(failure ?? JSON.stringify(client.stats())));
      }
    }, 20);
  });
  return () => {
    holding = true;
    const hold = { start: performance.now(), end: 0 };
    traces[label].holds.push(hold);
    // Keep record ordering and transaction association: delay bytes, never discard them.
    return () => {
      holding = false;
      hold.end = performance.now();
      for (const data of pending.splice(0)) {
        // Resume ordered delivery to the real client callback.
        deliver.get(label)!(data);
      }
    };
  };
}
// The release closure retains the real transport callback.
const deliver = new Map<Label, (data: ArrayBuffer | string) => void>();

const holdEnabled = await connect("enabled");
const holdDisabled = await connect("disabled");
Object.assign(window, {
  tweenCheck: {
    traces,
    ready: true,
    start() {
      started = performance.now();
      for (const trace of Object.values(traces)) trace.startedAt = started;
      setTimeout(() => {
        const releaseEnabled = holdEnabled();
        const releaseDisabled = holdDisabled();
        setTimeout(() => {
          releaseEnabled();
          releaseDisabled();
        }, 650);
      }, 350);
    },
    stats: () => clients.map((client) => client.stats()),
    evidence: () => refusals,
    recordings: () =>
      clients.map((client) => Array.from(client.recording()?.bytes ?? [])),
  },
});
