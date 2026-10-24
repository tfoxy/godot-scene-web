// G8kb's Basis bench page logic (protocol/texture-delivery-design.md Q6 "GSW"), bundled by
// scripts/gate7-bench.ts --arm gsw-basis. Inputs: inputs/basis/manifest.json, the KTX2 (uastc)
// files of a gate 8 basis-uastc store (names are their hashes).
//
// ?mode=transcode&warmup=1&repeats=5
//   For each target family set (astc, etc2, bptc, none), every KTX2 is transcoded by GSW's worker
//   (BasisTranscoder: transfer in, bt_transcode, transfer out) once as a warmup and `repeats`
//   times; per transcode the worker's own time (zstd inflate + every level) and the main thread's
//   round trip. D14 picks the target from the family set and the file's components exactly as the
//   receiver does (client.ts webglFamilies included), so `astc` is ASTC 4x4 for RGBA and RGB files (G8kb2)
//   alike, `etc2` ETC2 RGBA8 or ETC1 (RGB), `none` RGBA8.
// ?mode=gpu&delivery=decoded|uastc|none&copies=K
//   GSW's upload calls (gl.rs: texImage2D RGBA8 for a decoded payload, compressedTexImage2D level 0
//   for a transcoded one) for `copies` copies of every file, then one draw of each so the driver
//   holds the textures resident; `decoded` uploads the RGBA8 the decoded payload would (the
//   transcoder's RGBA8 output, w*h*4 bytes, level 0), `uastc` the transcode to this context's own
//   D14 target, `none` nothing (the baseline). State `holding` once uploaded: the driver samples
//   the GPU process's graphics memory, then closes the page.

import { BasisTranscoder, webglFamilies } from "../basis-transcoder/client";

interface Entry {
  name: string;
  file: string;
  bytes: number;
  source?: { file: string; channels: number } | null;
}
interface State {
  state: "running" | "baseline" | "holding" | "done" | "error";
  detail: string;
  result?: unknown;
}

const params = new URLSearchParams(location.search);
const set = (s: State) => {
  (window as unknown as { __bench?: State }).__bench = s;
};

const GL_FORMAT: Record<string, number> = {
  DXT1: 0x83f1,
  DXT5: 0x83f3,
  RGTC_R: 0x8dbb,
  RGTC_RG: 0x8dbd,
  BPTC_RGBA: 0x8e8c,
  ETC2_RGB8: 0x9274,
  ETC2_RGBA8: 0x9278,
  ASTC_4x4: 0x93b0,
};
const EXTENSIONS: [string, string][] = [
  ["s3tc", "WEBGL_compressed_texture_s3tc"],
  ["bptc", "EXT_texture_compression_bptc"],
  ["rgtc", "EXT_texture_compression_rgtc"],
  ["etc2", "WEBGL_compressed_texture_etc"],
  ["astc", "WEBGL_compressed_texture_astc"],
];

async function inputs(): Promise<{ entry: Entry; bytes: Uint8Array }[]> {
  const manifest = (await (await fetch("inputs/basis/manifest.json")).json()) as Entry[];
  const out: { entry: Entry; bytes: Uint8Array }[] = [];
  for (const entry of manifest)
    out.push({ entry, bytes: new Uint8Array(await (await fetch(`inputs/basis/${entry.file}`)).arrayBuffer()) });
  return out;
}

function transcoder(): BasisTranscoder {
  return new BasisTranscoder(new URL("basis-worker.js", location.href).href, new URL("basis/basis_transcoder.wasm", location.href).href);
}

/** Texels of every level (the work a transcode does). */
function texels(w: number, h: number, levels: number): number {
  let n = 0;
  for (let l = 0; l < levels; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l);
  return n;
}

async function transcodeMode(): Promise<void> {
  const warmup = Number(params.get("warmup") ?? "1");
  const repeats = Number(params.get("repeats") ?? "5");
  const files = await inputs();
  const t = transcoder();
  const initMs = await t.ready;
  // `phone` is the g31's own gpu_formats (etc2, astc: G8kb2: ASTC 4x4 for RGBA and RGB).
  const sets: [string, string[]][] = [
    ["phone", ["etc2", "astc"]],
    ["etc2", ["etc2"]],
    ["bptc", ["bptc"]],
    ["none", []],
  ];
  const byFormat: Record<string, { ms: number; mpx: number; n: number }> = {};
  const rows: unknown[] = [];
  const totals: Record<string, { ms: number; rtt: number; mpx: number; n: number; formats: string[] }> = {};
  for (const [label, fams] of sets) {
    const tot = { ms: 0, rtt: 0, mpx: 0, n: 0, formats: [] as string[] };
    for (let r = 0; r < warmup + repeats; r++)
      for (const f of files) {
        set({ state: "running", detail: `${label} ${r < warmup ? "warmup" : `repeat ${r - warmup + 1}`} ${f.entry.name.slice(0, 12)}` });
        const x = await t.transcode(f.bytes, fams);
        if (r < warmup) continue;
        const mpx = texels(x.width, x.height, x.levels) / 1e6;
        rows.push({ set: label, file: f.entry.name, format: x.format, width: x.width, height: x.height, levels: x.levels, components: x.components, ms: x.ms, round_trip_ms: x.roundTripMs, mpx, repeat: r - warmup + 1 });
        tot.ms += x.ms;
        tot.rtt += x.roundTripMs;
        tot.mpx += mpx;
        tot.n++;
        if (!tot.formats.includes(x.format)) tot.formats.push(x.format);
        const b = (byFormat[x.format] ??= { ms: 0, mpx: 0, n: 0 });
        b.ms += x.ms;
        b.mpx += mpx;
        b.n++;
      }
    totals[label] = tot;
  }
  t.terminate();
  const summary = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, { formats: v.formats, transcodes: v.n, mpx: v.mpx, ms: v.ms, ms_per_mpx: v.ms / v.mpx, round_trip_ms_per_mpx: v.rtt / v.mpx }]),
  );
  const formats = Object.fromEntries(
    Object.entries(byFormat).map(([k, v]) => [k, { transcodes: v.n, mpx: v.mpx, ms: v.ms, ms_per_mpx: v.ms / v.mpx }]),
  );
  set({ state: "done", detail: "transcode done", result: { init_ms: initMs, summary, formats, rows, user_agent: navigator.userAgent, cross_origin_isolated: crossOriginIsolated } });
}

async function gpuMode(): Promise<void> {
  const delivery = params.get("delivery") ?? "none";
  const copies = Number(params.get("copies") ?? "16");
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("no webgl2");
  const supported = gl.getSupportedExtensions() ?? [];
  const families: string[] = [];
  for (const [f, ext] of EXTENSIONS)
    if (supported.includes(ext) && gl.getExtension(ext)) families.push(f);
  const files = delivery === "none" ? [] : await inputs();
  const t = transcoder();
  await t.ready;
  const textures: WebGLTexture[] = [];
  let bytes = 0;
  let texelsUploaded = 0;
  const formats: Record<string, number> = {};
  // Every transcode first, then `baseline` (the driver samples the GPU memory with nothing
  // uploaded on this page), then the uploads once the driver calls window.__go().
  const transcoded = [];
  for (const f of files) {
    const fams = delivery === "decoded" ? [] : webglFamilies(f.bytes, families);
    transcoded.push({ f, x: await t.transcode(f.bytes, fams) });
  }
  t.terminate();
  if (delivery !== "none")
    await new Promise<void>((resolve) => {
      (window as unknown as { __go: () => void }).__go = resolve;
      set({ state: "baseline", detail: "transcoded; nothing uploaded" });
    });
  for (const { f, x } of transcoded) {
    const level0 = x.data.subarray(0, x.level0Bytes);
    for (let c = 0; c < copies; c++) {
      set({ state: "running", detail: `upload ${f.entry.name.slice(0, 12)} copy ${c + 1}/${copies}` });
      const tex = gl.createTexture();
      if (!tex) throw new Error("createTexture failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (x.format === "RGBA8")
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, x.width, x.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, level0);
      else gl.compressedTexImage2D(gl.TEXTURE_2D, 0, GL_FORMAT[x.format], x.width, x.height, 0, level0);
      const err = gl.getError();
      if (err !== 0) throw new Error(`upload ${x.format} ${x.width}x${x.height}: GL error ${err}`);
      textures.push(tex);
      bytes += level0.length;
      texelsUploaded += x.width * x.height;
      formats[x.format] = (formats[x.format] ?? 0) + 1;
    }
  }
  // One draw per texture so the driver makes it resident (a 1x1 point sampling it).
  const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
  gl.shaderSource(vs, "#version 300 es\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);gl_PointSize=1.0;}");
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
  gl.shaderSource(fs, "#version 300 es\nprecision mediump float;uniform sampler2D t;out vec4 o;void main(){o=texture(t,vec2(0.5));}");
  gl.compileShader(fs);
  const prog = gl.createProgram() as WebGLProgram;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  for (const tex of textures) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.POINTS, 0, 1);
  }
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  set({
    state: "holding",
    detail: `${textures.length} textures resident`,
    result: { delivery, copies, families, textures: textures.length, level0_bytes: bytes, texels: texelsUploaded, formats, renderer: gl.getParameter(gl.RENDERER) },
  });
  (window as unknown as { __keep: unknown }).__keep = textures;
}

/** G8kb2: PSNR (RGB, plus alpha when the reference has it) of `got` (RGBA8, row 0 first) against a reference. */
function psnr(got: Uint8Array, ref: Uint8Array, refChannels: number, n: number): number {
  const ch = refChannels === 4 ? 4 : 3;
  let se = 0;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const d = got[i * 4 + c] - ref[i * refChannels + c];
      se += d * d;
    }
  const mse = se / (n * ch);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** G8kb2: every KTX2, for the phone's family set and for etc2 alone (before G8kb2's target for RGB),
 * transcoded, uploaded through GSW's compressedTexImage2D call, decoded by THIS context's GL (a
 * 1:1 texelFetch draw read back), and compared with the UASTC decode (cTFRGBA32) and the source. */
async function qualityMode(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("no webgl2");
  const supported = gl.getSupportedExtensions() ?? [];
  const families: string[] = [];
  for (const [f, ext] of EXTENSIONS) if (supported.includes(ext) && gl.getExtension(ext)) families.push(f);
  const files = await inputs();
  const t = transcoder();
  await t.ready;
  const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
  gl.shaderSource(vs, "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}");
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
  gl.shaderSource(fs, "#version 300 es\nprecision highp float;uniform highp sampler2D t;out vec4 o;void main(){o=texelFetch(t,ivec2(gl_FragCoord.xy),0);}");
  gl.compileShader(fs);
  const prog = gl.createProgram() as WebGLProgram;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const rows: unknown[] = [];
  for (const f of files) {
    set({ state: "running", detail: `quality ${f.entry.name.slice(0, 12)}` });
    const ref = await t.transcode(f.bytes, []);
    if (ref.format !== "RGBA8") throw new Error(`reference transcode is ${ref.format}`);
    const w = ref.width;
    const h = ref.height;
    const refPx = ref.data.subarray(0, w * h * 4);
    const src = f.entry.source
      ? new Uint8Array(await (await fetch(`inputs/basis/${f.entry.source.file}`)).arrayBuffer())
      : null;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    for (const [label, fams] of [["etc2", ["etc2"]], ["phone", ["etc2", "astc"]]] as [string, string[]][]) {
      const x = await t.transcode(f.bytes, webglFamilies(f.bytes, fams.filter((q) => families.includes(q))));
      if (x.format === "RGBA8") continue; // the context has neither family
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, GL_FORMAT[x.format], w, h, 0, x.data.subarray(0, x.level0Bytes));
      const err = gl.getError();
      if (err !== 0) throw new Error(`upload ${x.format} ${w}x${h}: GL error ${err}`);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.deleteTexture(tex);
      rows.push({
        file: f.entry.name,
        set: label,
        format: x.format,
        components: x.components,
        width: w,
        height: h,
        bytes_per_px: x.level0Bytes / (w * h),
        psnr_vs_uastc: psnr(px, refPx, 4, w * h),
        psnr_vs_source: src && f.entry.source ? psnr(px, src, f.entry.source.channels, w * h) : null,
        uastc_psnr_vs_source: src && f.entry.source ? psnr(refPx, src, f.entry.source.channels, w * h) : null,
      });
    }
  }
  t.terminate();
  set({ state: "done", detail: "quality done", result: { families, rows, user_agent: navigator.userAgent } });
}

const mode = params.get("mode") ?? "transcode";
(mode === "gpu" ? gpuMode() : mode === "quality" ? qualityMode() : transcodeMode()).catch((e: unknown) => {
  set({ state: "error", detail: e instanceof Error ? e.message : String(e) });
});
