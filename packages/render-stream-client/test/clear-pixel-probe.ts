import { createRenderStreamClient } from "../src/client";

declare global {
  interface Window {
    productionClearProbe: typeof replay;
  }
}

async function replay(input: {
  recording: string;
  transparentClear?: boolean;
  clipOutset?: readonly [number, number, number, number];
}) {
  const bytes = Uint8Array.from(atob(input.recording), (c) => c.charCodeAt(0));
  const sessionEnd = 12 + new DataView(bytes.buffer).getUint32(8, true);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  let client: ReturnType<typeof createRenderStreamClient> | undefined;
  const presented = new Promise<{
    pixels: Uint8Array<ArrayBuffer>;
    glError: number;
    samples: number;
    attributes: WebGLContextAttributes | null;
  }>((resolve, reject) => {
    client = createRenderStreamClient({
      canvas,
      core: {
        glueUrl: "/rust/rs_gsw_wasm_client.js",
        wasmUrl: "/rust/rs_gsw_wasm_bg.wasm",
      },
      endpoint: {
        url: "ws://127.0.0.1:19762/stream",
        resourceBase: "",
        token: null,
        protocol: 12,
      },
      transparentClear: input.transparentClear,
      extensions: input.clipOutset
        ? [
            {
              id: "clip",
              beforeDraw: (f) =>
                f.overrides.set(1, { clipOutset: input.clipOutset! }),
            },
          ]
        : [],
      creditStage: "submitted",
      onStatus: (status) => {
        if (status.kind === "failed") reject(new Error(status.detail));
      },
      transport: (_endpoint, _protocol, events) => {
        queueMicrotask(() => {
          events.open();
          events.message(bytes.slice(0, sessionEnd).buffer);
          events.message(bytes.slice(sessionEnd).buffer);
        });
        return {
          send(text) {
            const ack = JSON.parse(text);
            if (ack.type !== "ack" || ack.stage !== "submitted") return;
            // The submitted ack follows the draw synchronously, before the browser can
            // discard this preserveDrawingBuffer:false canvas at the end of the frame.
            const gl = canvas.getContext("webgl2");
            if (!gl) return reject(new Error("No WebGL2 context"));
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(
              0,
              0,
              canvas.width,
              canvas.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            resolve({
              pixels,
              glError: gl.getError(),
              samples: gl.getParameter(gl.SAMPLES),
              attributes: gl.getContextAttributes(),
            });
          },
          close() {},
          async fetchResource() {
            throw new Error("The clear-pixel scene needs no resources");
          },
        };
      },
    });
    client.connect();
  });
  try {
    const { pixels, ...facts } = await presented;
    const pixel = (x: number, y: number) => {
      const start = 4 * ((canvas.height - 1 - y) * canvas.width + x);
      return Array.from(pixels.slice(start, start + 4));
    };
    const hash = await crypto.subtle.digest("SHA-256", pixels);
    return {
      ...facts,
      pixelsSha256: Array.from(new Uint8Array(hash), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join(""),
      clear: pixel(8, 8),
      half: pixel(1, 1),
      horizontalBand: pixel(3, 1),
      verticalBand: pixel(1, 3),
    };
  } finally {
    client?.dispose();
    canvas.remove();
  }
}

window.productionClearProbe = replay;
