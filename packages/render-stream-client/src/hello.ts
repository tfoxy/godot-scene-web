import type { RenderStreamProtocol } from "./endpoint";

// The GSW receiver's texture-delivery hello keys (render-stream-9.md "Live transport"), pure so
// scripts/test/self-test-gate8kp.ts can pin them, and the client's whole hello.

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

/** The client's texture_encodings offer for a context's gpu_formats (render-stream-9.md D3):
 * `block,decoded` when the context states any block family, so a host that holds the game's own
 * block bytes in a matching format sends those (a quarter to a half of the GPU memory, no CPU
 * decode); `decoded` when it states none (`none`). `decoded` is always the fallback. Never
 * `uastc`: the client carries no KTX2 transcoder (it never stages a KTX2), and GSW states only
 * encodings it can transcode. The core's `texture_encodings` start option is `block,decoded`
 * (the hello's superset; with no family stated the core selects nothing but `decoded`). */
export function clientTextureEncodings(gpuFormats: string): string {
  return gpuFormats !== "" && gpuFormats !== "none"
    ? "block,decoded"
    : "decoded";
}

/** The /9 hello: the /7 hello's keys in their order under protocol render-stream/9, then
 * texture_encodings and gpu_formats. CG1: `protocol` "render-stream/10" is /10's hello
 * (render-stream-10.md "Live transport"); W11c: "render-stream/11" is /10's again
 * (render-stream-11.md, golden-11's control hello); PM5: "render-stream/12" is /11's (golden-12's
 * control hello); W13c: "render-stream/13" is /12's (render-stream-13.md "As built (W13a)");
 * /14 adds the v2 identity fields; /15's and /16's are /14's under their own protocol string. */
export function helloV9(
  v7: Record<string, unknown>,
  textureEncodings: string,
  gpuFormats: string,
  protocol:
    | "render-stream/9"
    | "render-stream/10"
    | "render-stream/11"
    | "render-stream/12"
    | "render-stream/13"
    | "render-stream/14"
    | "render-stream/15"
    | "render-stream/16"
    | "render-stream/17"
    | "render-stream/18"
    | "render-stream/19" = "render-stream/9",
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

/** This client's `receiver` name in the hello (a free string at the host, rs_live.cpp). */
export const CLIENT_RECEIVER_NAME = "gsw-render-stream-client";
/** The client's live coding offer (W11t), the harness's default. */
export const CLIENT_LIVE_CODING = "zstd-base,zstd";
/** The inbound buffer the client announces (the harness's default, 16 MiB). */
export const CLIENT_INBOUND_BYTES = 16777216;

/**
 * The core's start options (rs-gsw-wasm `parse_options`). `digest: "none"`, since the client
 * never reads a record's SHA-256 (`last_digest_ptr`, `digest()`); every check that reads no record
 * digest stays (resource payload hashes, mesh body digests, W11t's checksum, /13 `predict-check`,
 * the seq and base rules). The harness receiver keeps `inline`: its checks read the digests.
 */
export function coreStartOptions(
  protocol: number,
  viewports = true,
  transparentClear = false,
  damageRedraw = false,
  clientTweens = false,
  coverTiles = true,
): string {
  return JSON.stringify({
    digest: "none",
    sabotage: [],
    format: transparentClear ? "rgba8" : "rgb10a2",
    texture_encodings: "block,decoded",
    live_protocol: protocol,
    log: "summary",
    // render-stream/16 (viewport-surfaces-design.md D3): the key is there only when off, so every
    // other option string is byte for byte what it was.
    ...(viewports ? {} : { viewports: false }),
    ...(transparentClear ? { transparent_clear: true } : {}),
    ...(damageRedraw ? { damage_redraw: true } : {}),
    ...(clientTweens ? { client_tweens: true } : {}),
    ...(coverTiles ? {} : { coverTiles: false }),
  });
}

/** What the client's hello states about itself. */
export interface ClientHelloFacts {
  clientTweens?: boolean;
  protocol: RenderStreamProtocol;
  creditWindow: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** The credit stage; default `submitted`. */
  creditStage?: "submitted" | "applied";
  token: string | null;
  /** The canvas's backing store and CSS box, and the device pixel ratio in thousandths. */
  backing: [number, number];
  css: [number, number];
  dprMilli: number;
  /** gpuFormatsOf the canvas's own context (`none` when empty). */
  gpuFormats: string;
  /** The extensions' merged `item_meta` request (/13 or /14); absent or null: no key, the pure
   * hello byte for byte. */
  itemMeta?: {
    fields: readonly string[];
    groups: readonly string[];
    meta_keys: readonly string[];
  } | null;
}

/** The one version offered on the transport and in the hello. At 16 it is 16, exactly what the
 * endpoint names: a /16 host lists only `render-stream.16`, so nothing is upgraded or tried
 * instead, and `resourceHints` keeps its /15 meaning (the client keeps the host's hints in a
 * table; the host's `GRC_RESOURCE_HINTS` decides whether it sends any). Below 16, a v2 request
 * relies on /14 picking semantics, so it never falls back to an older protocol. `resourceHints` offers /15
 * (render-stream-15.md "Who speaks /15": only a client that asks for hints), which keeps /14's
 * item_meta v2; without it a /15 endpoint is spoken to as /13, or /14 for v2 wants, which a /15
 * host also lists. One subprotocol only: the transport seam carries one, the core is built for
 * it and the hello names it, so a `resourceHints` client needs a host under
 * `GRC_STREAM_VERSION=15`. */
export function clientProtocol(
  protocol: RenderStreamProtocol,
  itemMeta: ClientHelloFacts["itemMeta"],
  resourceHints = false,
  clientTweens = false,
): RenderStreamProtocol {
  if (clientTweens && protocol < 17)
    throw new TypeError(
      "render-stream client: clientTweens needs protocol 17 or later",
    );
  if (protocol >= 17) return protocol;
  if (itemMeta && protocol < 13)
    throw new TypeError(
      "render-stream client: item_meta (an extension's wants) needs protocol 13 or later",
    );
  if (protocol >= 16) return protocol;
  if (resourceHints) {
    if (protocol < 13)
      throw new TypeError(
        "render-stream client: resourceHints needs protocol 13 or later",
      );
    return 15;
  }
  if (protocol === 15) protocol = 13;
  return protocol === 13 && hasV2(itemMeta) ? 14 : protocol;
}

function hasV2(itemMeta: ClientHelloFacts["itemMeta"]): boolean {
  return (
    itemMeta?.fields.some((f) => f === "instance_id" || f === "mouse_filter") ??
    false
  );
}

/** The client's /11 through /15 hello (/15's is /14's): the GSW receiver's keys in their order (golden-11/12's control
 * hello), `receiver_kind` `gsw-canvas` (the same executor), credit stage `submitted`, texture
 * encodings `block,decoded` or `decoded` (clientTextureEncodings; no `uastc` until the client
 * carries the KTX2 transcoder), no manifest, and the
 * `zstd-base,zstd` live coding offer last. */
export function clientHello(f: ClientHelloFacts): Record<string, unknown> {
  const maxWindow = f.protocol >= 18 ? 8 : 2;
  if (
    !Number.isInteger(f.creditWindow) ||
    f.creditWindow < 1 ||
    f.creditWindow > maxWindow
  )
    throw new TypeError(
      `render-stream client: creditWindow must be in 1..${maxWindow}`,
    );
  const hello = helloV9(
    {
      type: "hello",
      protocol: `render-stream/${f.protocol}`,
      receiver: CLIENT_RECEIVER_NAME,
      receiver_kind: "gsw-canvas",
      credit_stage: f.creditStage ?? "submitted",
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
    clientTextureEncodings(f.gpuFormats),
    f.gpuFormats,
    `render-stream/${f.protocol}` as const,
    CLIENT_LIVE_CODING,
  );
  // The item_meta key last, only when asked (at /13; the
  // key is a hello error below it).
  if (f.itemMeta) {
    if (f.protocol < 13)
      throw new TypeError(
        "render-stream client: item_meta (an extension's wants) needs protocol 13",
      );
    if (f.protocol < 14 && hasV2(f.itemMeta))
      throw new TypeError(
        "render-stream client: item_meta v2 fields need protocol 14",
      );
    hello.item_meta = {
      fields: [...f.itemMeta.fields],
      groups: [...f.itemMeta.groups],
      meta_keys: [...f.itemMeta.meta_keys],
    };
  }
  if (f.clientTweens) {
    if (f.protocol < 17)
      throw new TypeError(
        "render-stream client: clientTweens needs protocol 17 or later",
      );
    hello.client_tweens = true;
  }
  return hello;
}
