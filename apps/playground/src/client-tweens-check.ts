// Real-consumer probe: sample the item texture actually uploaded to WebGL, after draw().
// No alternate tween evaluator participates in the assertions.
import { createRenderStreamClient } from "../../../packages/render-stream-client/src/client";
import { WasmStreamCore } from "../../../packages/render-stream-client/src/core";
import { createWebSocketTransport } from "../../../packages/render-stream-client/src/transport";

type Label = "enabled" | "disabled";
type Item = {
  id: number;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
};
type State = { seq: number; frame: number; t_us: number; items: Item[] };
export type Draw = {
  at: number;
  seq: number;
  rows: number[][];
  host: Item[];
  diag: Record<string, number>;
  pixel: number[];
};
export type Trace = {
  transactions: { at: number; seq: number; frame: number; t_us: number }[];
  draws: Draw[];
  holds: { start: number; end: number }[];
  shots: Record<string, string>;
};
const trace = (): Trace => ({
  transactions: [],
  draws: [],
  holds: [],
  shots: {},
});
const traces = { enabled: trace(), disabled: trace() };
const labels = new WeakMap<WasmStreamCore, Label>();
let connecting: Label = "enabled";
let started = 0;
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
const receive = WasmStreamCore.prototype.receive;
WasmStreamCore.prototype.receive = function (...args) {
  if (!labels.has(this)) labels.set(this, connecting);
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
  draw.call(this, seq);
  const label = labels.get(this)!;
  const canvas = document.getElementById(label) as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2")!;
  const state = JSON.parse(Reflect.get(this, "g").state_canonical())
    .state as State;
  const rows = (textures.get(gl) ?? []).map((r) => [...r]);
  const node = rows.find((r) => r && r[5] > 60 && r[5] < 150 && r[4] > 50);
  const pixel = new Uint8Array(4);
  if (node) {
    const x = node[4] + node[0] * 20 + node[2] * 14;
    const y = node[5] + node[1] * 20 + node[3] * 14;
    gl.readPixels(
      Math.round(x),
      359 - Math.round(y),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
  }
  const diag = this.tweenDiagnostics();
  const out = traces[label];
  out.draws.push({
    at: performance.now(),
    seq,
    rows,
    host: state.items,
    diag: { ...diag },
    pixel: [...pixel],
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
      protocol: 17,
      presentation: [640, 360],
    },
    clientTweens: label === "enabled" && params.get("sabotage") !== "disabled",
    recorder: { maxBytes: 16 * 1024 * 1024 },
    transport: (endpoint, protocol, on) => {
      deliver.set(label, (data) => on.message(data));
      return base(endpoint, protocol, {
        ...on,
        message(data) {
          if (holding) pending.push(data);
          else on.message(data);
        },
      });
    },
  });
  clients.push(client);
  client.connect();
  await new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + 30000;
    const timer = setInterval(() => {
      if (traces[label].draws.length) {
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
    recordings: () =>
      clients.map((client) => Array.from(client.recording()?.bytes ?? [])),
  },
});
