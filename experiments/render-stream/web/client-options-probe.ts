// Browser half of the opt-in client option integration checks. Uses the production executor's
// readback, so target format, clear, blend coverage and premultiplication are all observable.
import type { GswRsModule } from "../../../packages/render-stream-client/src/abi";
import { statsReader } from "../../../packages/render-stream-client/src/abi";
import { coreStartOptions } from "../../../packages/render-stream-client/src/hello";
import { GswParticles } from "../../../packages/render-stream-client/src/particles";
import { resolvePrograms } from "../../../packages/render-stream-client/src/programs";

declare global {
  interface Window {
    clientOptionsProbe: typeof replay;
  }
}

async function replay(input: {
  recording: string;
  payloads?: Record<string, string>;
  staticParticles?: boolean;
  transparentClear?: boolean;
}) {
  const moduleUrl = "/rust/rs_gsw_wasm.js";
  const mod = (await import(/* @vite-ignore */ moduleUrl)) as GswRsModule;
  const { memory } = await mod.default({
    module_or_path: await (
      await fetch("/rust/rs_gsw_wasm_bg.wasm")
    ).arrayBuffer(),
  });
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const g = new mod.GswRs(
    canvas,
    coreStartOptions(12, true, input.transparentClear),
  );
  const check = (code: number) => {
    if (code < 0) throw new Error(g.error());
    return code;
  };
  const decode = (base64: string) =>
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const data = decode(input.recording);
  const ptr = g.alloc_recording(data.length);
  new Uint8Array(memory.buffer, ptr, data.length).set(data);
  const count = check(g.load(data.length));
  check(g.start());
  const particles = new GswParticles(
    undefined,
    undefined,
    input.staticParticles,
  );
  const uploads: { id: number; buffer: Uint8Array<ArrayBuffer> }[] = [];
  const frames: { message: string; time: number; calls: number }[] = [];
  const host = {
    particles_sync: () => g.particles_sync(),
    shader_time: () => g.shader_time(),
    particles_set: (id: number, buffer: Float32Array) => {
      uploads.push({
        id,
        buffer: new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        ).slice(),
      });
      g.particles_set(id, buffer);
    },
  };
  const stats = statsReader(g, memory);
  for (let i = 1; i < count; i++) {
    const code = check(g.accept(i));
    if (code !== 0 && code !== 3) continue;
    for (let needed = 0; needed < g.needed_count(); needed++) {
      const hash = Array.from(
        new Uint8Array(memory.buffer, g.needed_ptr() + 32 * needed, 32),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      const payload = decode(input.payloads?.[hash] ?? "");
      if (!payload.length) throw new Error(`Missing payload ${hash}`);
      const pp = g.alloc_payload(payload.length);
      new Uint8Array(memory.buffer, pp, payload.length).set(payload);
      check(g.provide(payload.length));
    }
    await resolvePrograms(g, memory, null, () => {});
    const message = g.particles_sync();
    particles.step({ ...host, particles_sync: () => message });
    check(g.apply());
    check(g.draw());
    frames.push({
      message,
      time: g.shader_time(),
      calls: stats().executed_calls,
    });
  }
  const shot = check(g.shot());
  if (!shot) throw new Error(`No executor readback: ${g.error()}`);
  const pixels = new Uint8Array(
    memory.buffer,
    shot,
    4 * g.target_width() * g.target_height(),
  ).slice();
  const width = g.target_width();
  const gl = canvas.getContext("webgl2");
  const glError = gl?.getError();
  const attributes = gl?.getContextAttributes();
  particles.dispose();
  g.free();
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  canvas.remove();
  const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
  const pixel = (x: number, y: number) =>
    Array.from(pixels.slice(4 * (y * width + x), 4 * (y * width + x) + 4));
  return {
    pixelsSha256: await hash(pixels),
    clear: pixel(8, 8),
    half: pixel(1, 1),
    uploads: await Promise.all(
      uploads.map(async (upload) => ({
        id: upload.id,
        sha256: await hash(upload.buffer),
      })),
    ),
    frames,
    glError,
    attributes,
  };
}
window.clientOptionsProbe = replay;
