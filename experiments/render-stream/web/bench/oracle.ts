import { resolvePrograms } from "../../../../packages/render-stream-client/src/programs";
import type { GswRs, GswRsModule } from "./bench-rs";

interface OracleHost extends GswRs {
  rx(len: number): number;
  live_session(len: number, version: number): number;
  live_accept(len: number): number;
  needed_kinds_ptr(): number;
  set_static_shaders(on: boolean): void;
  enable_damage_oracle(canvas: HTMLCanvasElement): void;
  damage_oracle_compare(on: boolean): void;
  damage_oracle_json(): string;
  damage_oracle_shot(shadow: boolean): number;
}

export interface OracleReport {
  frames: number;
  partial: number;
  full: number;
  skipped: number;
  mismatched: number;
  first_mismatch: null | {
    frame: number;
    seq: number;
    pixels: number;
    bbox: number[];
    width: number;
    height: number;
  };
  damage_history_reads: number;
  damage_modes: [number, number, number][];
}

/** Consume bounded records from the response; the recording never occupies a JS or wasm buffer. */
export async function* records(url: string): AsyncGenerator<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`recording: HTTP ${response.status}`);
  const reader = response.body.getReader();
  let chunk = new Uint8Array();
  let offset = 0;
  const take = async (
    size: number,
    eof = false,
  ): Promise<Uint8Array | null> => {
    const out = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (eof && written === 0) return null;
          throw new Error("truncated recording");
        }
        chunk = next.value;
        offset = 0;
      }
      const count = Math.min(size - written, chunk.length - offset);
      out.set(chunk.subarray(offset, offset + count), written);
      offset += count;
      written += count;
    }
    return out;
  };
  try {
    const magic = await take(8);
    if (!magic) throw new Error("missing magic");
    yield magic;
    while (true) {
      const prefix = await take(4, true);
      if (!prefix) return;
      const size = new DataView(prefix.buffer).getUint32(0, true);
      const body = await take(size);
      if (!body) throw new Error("missing record body");
      const record = new Uint8Array(size + 4);
      record.set(prefix);
      record.set(body, 4);
      yield record;
    }
  } finally {
    await reader.cancel();
  }
}

export async function runOracle(): Promise<void> {
  const p = new URLSearchParams(location.search);
  const nonce = p.get("nonce");
  const input = p.get("input");
  const store = p.get("store");
  if (!nonce || !input || !store)
    throw new Error("oracle needs input, store and nonce");
  const cadence = Number(p.get("apply-every") ?? 3);
  const from = Number(p.get("from-seq") ?? 0);
  const to = Number(p.get("to-seq") ?? Number.MAX_SAFE_INTEGER);
  const state = (detail: string) => {
    window.__bench = { state: "running", detail };
  };
  state("loading oracle");
  const mod = (await import(
    /* @vite-ignore */ `${location.origin}/gsw-rs/rs_gsw_wasm.js`
  )) as GswRsModule;
  const { memory } = await mod.default({
    module_or_path: await (
      await fetch("/gsw-rs/rs_gsw_wasm_bg.wasm")
    ).arrayBuffer(),
  });
  const stream = records(input);
  const first = await stream.next();
  if (!first.value) throw new Error("missing session");
  const magic = first.value;
  const version = magic[3] <= 57 ? magic[3] - 48 : magic[3] - 65 + 10;
  const canvas = document.getElementById("frame") as HTMLCanvasElement;
  const shadow = document.createElement("canvas");
  document.body.append(shadow);
  const gs = new mod.GswRs(
    canvas,
    JSON.stringify({
      digest: "none",
      log: "summary",
      format: "rgb10a2",
      live_protocol: version,
      damage_redraw: true,
      sabotage: p.get("sabotage") ? [p.get("sabotage")] : [],
    }),
  ) as OracleHost;
  const check = (code: number, op: string) => {
    if (code < 0) throw new Error(`${op}: ${gs.error()}`);
    return code;
  };
  const send = (bytes: Uint8Array) => {
    const ptr = gs.rx(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  };
  const put = async (name: string, body: BodyInit) => {
    const res = await fetch(`/evidence/${nonce}/${name}`, {
      method: "PUT",
      body,
    });
    if (!res.ok) throw new Error(`PUT ${name}: ${res.status}`);
  };
  gs.enable_damage_oracle(shadow);
  if (p.get("static-shaders") === "1") {
    if (typeof gs.set_static_shaders !== "function")
      throw new Error("build lacks set_static_shaders");
    gs.set_static_shaders(true);
  }
  let pending = 0;
  let seq = 0;
  let stopped = false;
  let ended = false;
  const draw = async () => {
    await new Promise(requestAnimationFrame);
    gs.damage_oracle_compare(seq >= from && seq <= to);
    check(gs.apply(), "apply");
    check(gs.draw(), "draw");
    pending = 0;
    const report = JSON.parse(gs.damage_oracle_json()) as OracleReport;
    state(`seq ${seq}: ${report.frames} compared, ${report.partial} partial`);
    if (report.mismatched) stopped = true;
  };
  try {
    const session = await stream.next();
    if (!session.value) throw new Error("missing session");
    const message = new Uint8Array(8 + session.value.length);
    message.set(magic);
    message.set(session.value, 8);
    send(message);
    check(gs.live_session(message.length, version), "session");
    for await (const record of stream) {
      send(record);
      let code = check(gs.live_accept(record.length), "accept");
      if (code === 3) {
        const n = gs.needed_count();
        const hashes = new Uint8Array(
          memory.buffer,
          gs.needed_ptr(),
          32 * n,
        ).slice();
        const kinds = new Uint8Array(
          memory.buffer,
          gs.needed_kinds_ptr(),
          n,
        ).slice();
        for (let i = 0; i < n; i++) {
          const hash = Array.from(hashes.subarray(i * 32, (i + 1) * 32), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          const res = await fetch(
            `${store}/sha256/${hash}.${["grt", "grm", "grp"][kinds[i]]}`,
          );
          if (!res.ok) throw new Error(`payload ${hash}: HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const ptr = gs.alloc_payload(bytes.length);
          new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
          check(gs.provide(bytes.length), "provide");
        }
        code = 0;
      }
      if (code === 2) ended = true;
      if (code === 0) {
        // seq is the second word of the fixed stats block.
        seq = new Uint32Array(memory.buffer, gs.stats_ptr(), 3)[1];
        await resolvePrograms(gs, memory, null);
        if (seq > to) {
          stopped = true;
          break;
        }
        pending++;
        if (pending === cadence) await draw();
        if (stopped) break;
      }
    }
    if (!ended && !stopped) throw new Error("recording-incomplete");
    if (pending && !stopped && seq <= to) await draw();
    const report = JSON.parse(gs.damage_oracle_json()) as OracleReport;
    if (report.first_mismatch) {
      const { width, height } = report.first_mismatch;
      const targets: Uint8Array[] = [];
      for (const [name, isShadow] of [
        ["partial", false],
        ["full", true],
      ] as const) {
        const ptr = gs.damage_oracle_shot(isShadow);
        if (!ptr) throw new Error("oracle missing mismatch target");
        const bytes = new Uint8Array(
          memory.buffer,
          ptr,
          width * height * 4,
        ).slice();
        targets.push(bytes);
        await put(`${name}.rgba`, bytes);
      }
      const diff = new Uint8Array(width * height * 4);
      for (let i = 0; i < diff.length; i += 4) {
        const changed = targets[0]
          .subarray(i, i + 4)
          .some((b, k) => b !== targets[1][i + k]);
        diff.set(changed ? [255, 0, 255, 255] : [0, 0, 0, 255], i);
      }
      for (const [i, bytes] of [...targets, diff].entries()) {
        const image = new OffscreenCanvas(width, height);
        const ctx = image.getContext("2d");
        if (!ctx) throw new Error("no diff canvas context");
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(bytes), width, height),
          0,
          0,
        );
        await put(
          `${["partial", "full", "diff"][i]}.png`,
          await image.convertToBlob({ type: "image/png" }),
        );
      }
    }
    await put("oracle.json", JSON.stringify(report));
    window.__bench = { state: "done", detail: "oracle complete" };
  } finally {
    await stream.return(undefined);
    gs.free();
  }
}
