// G8kp (render-stream-9.md "Live transport", texture-delivery-design.md Q3): the GSW receiver's
// texture-delivery hello keys, pure so scripts/test/self-test-gate8kp.ts can pin them.

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
 * control hello). */
export function helloV9(
  v7: Record<string, unknown>,
  textureEncodings: string,
  gpuFormats: string,
  protocol:
    | "render-stream/9"
    | "render-stream/10"
    | "render-stream/11"
    | "render-stream/12" = "render-stream/9",
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
