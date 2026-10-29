// G8kp (render-stream-9.md "Live transport", texture-delivery-design.md Q3): the GSW receiver's
// texture-delivery hello keys, pure so scripts/test/self-test-gate8kp.ts can pin them, and (MIR-1)
// the client's whole hello.

/** Godot's feature names (the hello's gpu_formats) and the WebGL extension each needs. */
export const GPU_EXTENSIONS: readonly (readonly [string, string])[] = [
  ["s3tc", "WEBGL_compressed_texture_s3tc"],
  ["bptc", "EXT_texture_compression_bptc"],
  ["rgtc", "EXT_texture_compression_rgtc"],
  ["etc2", "WEBGL_compressed_texture_etc"],
  ["astc", "WEBGL_compressed_texture_astc"],
];

/** gpu_formats from a context's extension list minus RS_RECEIVER_GPU_FORMAT_MASK: the families
 * in GPU_EXTENSIONS order, `none` when empty (the hello grammar forbids an empty list). */
export function gpuFormatsOf(
  extensions: Iterable<string>,
  mask: string | null,
): string {
  const have = new Set(extensions);
  const masked = new Set((mask ?? "").split(",").filter(Boolean));
  const out = GPU_EXTENSIONS.filter(
    ([f, ext]) => have.has(ext) && !masked.has(f),
  ).map(([f]) => f);
  return out.length > 0 ? out.join(",") : "none";
}

/** The /9 hello: the /7 hello's keys in their order under protocol render-stream/9, then
 * texture_encodings and gpu_formats. CG1: `protocol` "render-stream/10" is /10's hello
 * (render-stream-10.md "Live transport"); W11c: "render-stream/11" is /10's again
 * (render-stream-11.md, golden-11's control hello); PM5: "render-stream/12" is /11's (golden-12's
 * control hello); W13c: "render-stream/13" is /12's (render-stream-13.md "As built (W13a)"). */
export function helloV9(
  v7: Record<string, unknown>,
  textureEncodings: string,
  gpuFormats: string,
  protocol:
    | "render-stream/9"
    | "render-stream/10"
    | "render-stream/11"
    | "render-stream/12"
    | "render-stream/13" = "render-stream/9",
  liveCoding = "",
): Record<string, unknown> {
  return {
    ...v7,
    protocol,
    texture_encodings: textureEncodings,
    gpu_formats: gpuFormats,
    // W11c: W11t's /11 `live_coding` offer, absent when empty (the host keeps the stream uncoded).
    ...(liveCoding !== "" ? { live_coding: liveCoding } : {}),
  };
}

/** MIR-1: this client's `receiver` name in the hello (a free string at the host, rs_live.cpp). */
export const CLIENT_RECEIVER_NAME = "gsw-render-stream-client";
/** MIR-1: the client's live coding offer (W11t), the harness's default. */
export const CLIENT_LIVE_CODING = "zstd-base,zstd";
/** The inbound buffer the client announces (the harness's default, 16 MiB). */
export const CLIENT_INBOUND_BYTES = 16777216;

/** What the client's hello states about itself (mirror-client-design.md "The loop", "Hello"). */
export interface ClientHelloFacts {
  protocol: 11 | 12 | 13;
  creditWindow: 1 | 2;
  token: string | null;
  /** The canvas's backing store and CSS box, and the device pixel ratio in thousandths. */
  backing: [number, number];
  css: [number, number];
  dprMilli: number;
  /** gpuFormatsOf the canvas's own context (`none` when empty). */
  gpuFormats: string;
}

/** The client's /11, /12 or (W13c) /13 hello: the GSW receiver's keys in their order (golden-11/12's control
 * hello), `receiver_kind` `gsw-canvas` (the same executor), credit stage `submitted`, texture
 * encodings `decoded` (until the client carries the KTX2 transcoder), no manifest, and the
 * `zstd-base,zstd` live coding offer last. */
export function clientHello(f: ClientHelloFacts): Record<string, unknown> {
  return helloV9(
    {
      type: "hello",
      protocol: `render-stream/${f.protocol}`,
      receiver: CLIENT_RECEIVER_NAME,
      receiver_kind: "gsw-canvas",
      credit_stage: "submitted",
      credit_window: f.creditWindow,
      inbound_buffer_bytes: CLIENT_INBOUND_BYTES,
      token: f.token,
      manifest_sha256: null,
      presentation_backing_w: f.backing[0],
      presentation_backing_h: f.backing[1],
      presentation_css_w: f.css[0],
      presentation_css_h: f.css[1],
      dpr_milli: f.dprMilli,
    },
    "decoded",
    f.gpuFormats,
    `render-stream/${f.protocol}` as const,
    CLIENT_LIVE_CODING,
  );
}
