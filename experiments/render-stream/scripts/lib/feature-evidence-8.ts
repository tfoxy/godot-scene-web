// Gate 8 group G8z (protocol/gate8-design.md "Increments" G8z): the per-receiver evidence map behind
// protocol/features/render-stream-8/{native,web-export,gsw-canvas}.json. scripts/make-features.ts
// --protocol 8 is the generator; lib/gate7z-checks.ts judges the files with this file's profile
// (scripts/check-gate8z.ts).
//
// Shape. Every /8 file has gate 7's 123 entry ids plus the entries below (`SPECS_8`), and three
// of gate 7's entries change meaning at /8 (`OVERRIDES_8`): the compressed-and-float umbrella,
// late-join adoption, late-join materials. The /7 entries keep their gate 7
// evidence, carried forward from G7z's closing run (runs `carried`), so a /8 file says on its
// face that those rows describe the 6a454065 build, and the `evidence-builds` row reports it.
// Gate 7's groups that /8 touches are rerun by the closing run (G8z): g7-8 (file and live, both
// browsers), g7-2 live (G8kz's coding checks), native gate 8 (run-gate8.sh, every group).
//
// Evidence paths are relative to the evidence root `<main checkout>/artifacts` (the gate 7 file's
// root is `artifacts/render-stream/gate7`; /8 spans both gates). Receiver kinds and check ids
// follow gate 7z's rules: a browser entry cites its own kind's legs and `@<kind>` check ids
// (`manifest-no-substitution`). Native gate 8 judges some browser legs itself (g8kp's GSW legs, g8ku's
// web legs, named `...-gsw` / `...-web`); lib/gate7z-checks.ts indexes those under the browser
// kind they judge.

import {
  EVIDENCE_RUNS,
  type EvidenceRef2,
  type EvidenceRun,
  type FeatureEntry2,
  type FeatureExactness2,
  type FeatureStatus2,
  type ReceiverKind,
  receiverFeatureEntries,
  SHORT_KIND,
} from "./feature-evidence-7";
import type { ZProfile } from "./gate7z-checks";

/** The build the closing run was made from. RM8 reran the closing run on the commit the runs
 * under `render-stream/gate8/rm8/` were made on (main after CGR/WX): P3 had added g8c, g8cg and
 * gate 5.5's g55s/g55v/g55t since G8z's `ea402b95`. */
export const PRIMARY_BUILD_8 = "4b0de2f7";
export const G8_DIR = "render-stream/gate8/rm8";
/** G8z's directory: the one run RM8 did not redo, the gate 6 g6a captures behind `session@native`. */
const G8Z_DIR = "render-stream/gate8/g8z";
const G7_DIR = "render-stream/gate7";

function g8Runs(): EvidenceRun[] {
  const out: EvidenceRun[] = [];
  const note = "RM8 closing run (G8z's, redone on the P3 build)";
  out.push(
    {
      key: "gate8@native",
      path: `${G8_DIR}/native-gate8`,
      build: PRIMARY_BUILD_8,
      note: `${note}, native gate 8 (run-gate8.sh, every group)`,
    },
    {
      key: "g8l-hello@native",
      path: `${G8_DIR}/native-g8l-hello`,
      build: PRIMARY_BUILD_8,
      note: `${note}, native g8l again with RS_G8_MANIFEST_HELLO=1: its live hellos carry the /8 native manifest sha256 (the file is final only after the first native run)`,
      hello: true,
    },
    {
      key: "session@native",
      path: `${G8Z_DIR}/gate6-g6a`,
      build: "ea402b95",
      note: `G8z closing run, native gate 6 group g6a (scene, animate, refused: the host sessions manifest-matches-session reads; gate 7's gate 6 run lost its recordings to the retention policy)`,
    },
    {
      key: "gate8@gsw",
      path: `${G8_DIR}/native-gate8`,
      build: PRIMARY_BUILD_8,
      note: `${note}, native gate 8: the checks it makes of GSW legs it drives itself (g8kp)`,
    },
    {
      key: "gate8@web",
      path: `${G8_DIR}/native-gate8`,
      build: PRIMARY_BUILD_8,
      note: `${note}, native gate 8: the checks it makes of web-export legs it drives itself (g8ku)`,
    },
  );
  out.push({
    key: "gate5.5@native",
    path: `${G8_DIR}/native-gate55`,
    build: PRIMARY_BUILD_8,
    note: `${note}, native gate 5.5 (every group: P3-ST's g55s, P3-VX's g55v and P3-TM's g55t join gate 7's)`,
  });
  for (const k of ["gsw", "web"] as const) {
    out.push(
      {
        key: `g7-55@${k}`,
        path: `${G8_DIR}/g7-${k === "web" ? "web-rust" : "gsw"}-g8`,
        build: PRIMARY_BUILD_8,
        note: `${note}, g7-55 file legs ${k} (the same run as g7-8@${k})`,
      },
      {
        key: `g7-55-live@${k}`,
        path: `${G8_DIR}/live-g8`,
        build: PRIMARY_BUILD_8,
        note: `${note}, g7-55 live legs, both browsers (g55f, g55s, g55v, g55t; --manifest-hello 8)`,
        hello: true,
      },
      {
        key: `g7-8@${k}`,
        path: `${G8_DIR}/g7-${k === "web" ? "web-rust" : "gsw"}-g8`,
        build: PRIMARY_BUILD_8,
        note: `${note}, g7-8 file legs ${k} (23 recordings of gate 8's fixtures)`,
      },
      {
        key: `g7-8-live@${k}`,
        path: `${G8_DIR}/live-g8`,
        build: PRIMARY_BUILD_8,
        note: `${note}, g7-8 live legs, both browsers (--manifest-hello 8; the same run as g7-55-live)`,
        hello: true,
      },
      {
        key: `g7-2-live@${k}`,
        path: `${G8_DIR}/live-g7-2-${k}`,
        build: PRIMARY_BUILD_8,
        note: `${note}, live g7-2 ${k} (fast frames, --manifest-hello 8; G8kz's coding checks)`,
        hello: true,
      },
    );
  }
  return out;
}

/** gate 7's quoted runs, carried forward (paths re-rooted), except the keys G8z reruns. */
function carriedRuns(): EvidenceRun[] {
  const rerun = new Set(g8Runs().map((r) => r.key));
  return EVIDENCE_RUNS.filter((r) => !rerun.has(r.key)).map((r) => ({
    ...r,
    path: `${G7_DIR}/${r.path}`,
    note: `carried from gate 7: ${r.note}`,
  }));
}

export const EVIDENCE_RUNS_8: readonly EvidenceRun[] = [
  ...carriedRuns(),
  ...g8Runs(),
];

export const PROFILE_8: ZProfile = {
  label: "gate 8",
  runs: EVIDENCE_RUNS_8,
  deviceRuns: [],
  primaryBuild: PRIMARY_BUILD_8,
  helloFlaggedOnly: true,
  sessionRunKey: "session@native",
};

export const MANIFEST8_FILES: Record<ReceiverKind, string> = {
  native: "native.json",
  "web-export": "web-export.json",
  "gsw-canvas": "gsw-canvas.json",
};

// -------------------------------------------------------------------------------------------
// Entries
// -------------------------------------------------------------------------------------------

interface Part {
  status: FeatureStatus2;
  exactness?: FeatureExactness2;
  reason?: string | null;
  owner?: string | null;
  notes?: string | null;
  /** [gate, fixture, leg, check]; browsers get `@<short>` appended unless the check is
   * `raw` (a gate8 check already named for its kind). */
  refs?: [string, string, string, string][];
  raw?: boolean;
}

function evidence(kind: ReceiverKind, part: Part): EvidenceRef2[] {
  const short = SHORT_KIND[kind];
  return (part.refs ?? []).map(([gate, fixture, leg, check]) => ({
    gate,
    fixture,
    leg,
    check: kind === "native" || part.raw ? check : `${check}@${short}`,
    receiver_kind: kind,
  }));
}

interface Spec8 {
  id: string;
  kind: FeatureEntry2["kind"];
  name: string;
  native: Part;
  web: Part;
  gsw: Part;
}

const NATIVE = "gate8";
const TEX = "gate8-tex";

const SPECS_8: readonly Spec8[] = [
  {
    id: "payload.canvas_texture_diffuse",
    kind: "payload",
    name: "CanvasTexture whose diffuse no command names (spine-godot atlas pages): the diffuse is fetched and drawn",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-ct", "g8c", "ct-reference"],
        [NATIVE, "gate8-ct", "g8c", "ct-diffuse-uploaded"],
        [NATIVE, "gate8-ct", "g8c", "ct-channel-refused"],
      ],
      notes:
        "P3-CT: residency follows a named canvas texture to its diffuse. Normal and specular maps stay a typed refusal (canvas-texture-channel).",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-ct", "g8c/receiver", "ct-reference"],
        ["g7-8", "gate8-ct", "g8c/receiver", "ct-diffuse-uploaded"],
      ],
    },
    gsw: {
      status: "supported",
      exactness: "exact",
      refs: [
        ["g7-8", "gate8-ct", "g8c/receiver", "ct-reference"],
        ["g7-8", "gate8-ct", "g8c/receiver", "ct-diffuse-uploaded"],
      ],
      notes: "Pixel-identical to the native receiver on both sinks (p3-ct.md).",
    },
  },
  {
    id: "delivery.canvas_group_state_10",
    kind: "delivery",
    name: "clip_children, CanvasGroup and BackBufferCopy carried as the render-stream/10 item keys canvas_group and copy_to_backbuffer",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-cg", "g8cg", "cg-native-exact"],
        [NATIVE, "gate8-cg", "g8cg", "cg-wire"],
        [NATIVE, "gate8-cg", "g8cg", "cg-toggle-patch"],
        [NATIVE, "gate8-cg", "g8cg", "cg-adopt"],
      ],
      notes:
        "CG1: opt-in /10 (RS_RECEIVER_PROTOCOL=10); the receiver re-issues the state to Godot and reproduces its picture exactly on fixtures/gate8-cg.",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-cg", "g8cg/receiver", "cg-native-exact"],
        ["g7-8", "gate8-cg", "g8cg/receiver", "cg-adopt"],
      ],
      notes: "The web export re-issues the state to its own Godot (CG1).",
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-cg", "g8cg/receiver", "cg-native-exact"],
        ["g7-8", "gate8-cg", "g8cg/receiver", "cg-gsw-untyped"],
        ["g7-8", "gate8-cg", "g8cg/receiver", "cg-adopt"],
      ],
      notes:
        "CG3: GSW composites canvas groups and back-buffer copies itself; every shot equals the native shot within channel 1.",
    },
  },
  {
    id: "delivery.stream_protocol_8",
    kind: "delivery",
    name: "render-stream/8 file stream (GRS8) and live subprotocol render-stream.8 (RS_RECEIVER_PROTOCOL=8)",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, TEX, "g8l/tex", "g8l-tex-live"],
        [NATIVE, TEX, "g8l/tex", "g8l-tex-states"],
        [NATIVE, TEX, "g8l/tex", "g8l-tex-replay-equals-file"],
      ],
      notes:
        "A product receiver behind a gate 8 policy host must set RS_RECEIVER_PROTOCOL=8 (7 and 9 are its other words; unset keeps /6 native, /7 browsers).",
    },
    web: {
      status: "supported",
      exactness: "exact",
      refs: [
        ["g7-8-live", TEX, "g8l-tex", "g8l-tex-live"],
        ["g7-8-live", TEX, "g8l-tex", "g8l-tex-states"],
        ["g7-8-live", TEX, "g8l-tex", "live-replay-equals-live-g8l-tex"],
      ],
      notes:
        "Live transactions equal the host's /8 file-sink state at their frame; the final image equals the same receiver's replay.",
    },
    gsw: {
      status: "supported",
      exactness: "exact",
      refs: [
        ["g7-8-live", TEX, "g8l-tex", "g8l-tex-live"],
        ["g7-8-live", TEX, "g8l-tex", "g8l-tex-states"],
        ["g7-8-live", TEX, "g8l-tex", "live-replay-equals-live-g8l-tex"],
      ],
      notes:
        "Live transactions equal the host's /8 file-sink state at their frame; the final image equals the same receiver's replay.",
    },
  },
  {
    id: "delivery.http_content_coding",
    kind: "delivery",
    name: "HTTP content coding of payload GETs (GRC_HTTP_ENCODING zstd default, gzip, off)",
    native: {
      status: "declared-unverified",
      notes:
        "The native receiver sends Accept-Encoding and verifies the hash on the decoded bytes (RS_RECEIVER_ACCEPT_ENCODING=off opts out); its legs are native gate 2's g2e (coding-gzip, coding-off, coding-receiver-off), which no gate 7 manifest run indexes. The browsers' are cited.",
    },
    web: {
      status: "supported",
      refs: [
        ["g7-2-live", "gate6-scene", "live-auth", "http-content-coding"],
        [
          "g7-2-live",
          "gate6-scene",
          "sabotage-corrupt-coded-body",
          "corrupt-coded-body",
        ],
      ],
      notes:
        "The browser's own fetch decodes zstd and gzip transparently; a coded body with a flipped byte is refused.",
    },
    gsw: {
      status: "supported",
      refs: [
        ["g7-2-live", "gate6-scene", "live-auth", "http-content-coding"],
        [
          "g7-2-live",
          "gate6-scene",
          "sabotage-corrupt-coded-body",
          "corrupt-coded-body",
        ],
      ],
      notes:
        "The browser's own fetch decodes zstd and gzip transparently; a coded body with a flipped byte is refused.",
    },
  },
  {
    id: "delivery.reverse_proxy_fronting",
    kind: "delivery",
    name: "Live listener fronted by an HTTP/1.1 reverse proxy (D14: Host rewritten, X-Forwarded-*, WebSocket upgrade forwarded)",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, TEX, "g8l/proxy", "g8l-proxy-fronted"],
        [NATIVE, TEX, "g8l/proxy", "g8l-proxy-states"],
      ],
      notes:
        "No wire change; the proxy is scripts/lib/reverse-proxy.ts, not a production proxy. TLS and non-loopback serving stay unobserved.",
    },
    web: {
      status: "supported",
      exactness: "exact",
      refs: [
        ["g7-8-live", TEX, "g8l-proxy", "g8l-proxy-fronted"],
        ["g7-8-live", TEX, "g8l-proxy", "g8l-proxy-states"],
      ],
    },
    gsw: {
      status: "supported",
      exactness: "exact",
      refs: [
        ["g7-8-live", TEX, "g8l-proxy", "g8l-proxy-fronted"],
        ["g7-8-live", TEX, "g8l-proxy", "g8l-proxy-states"],
      ],
    },
  },
  {
    id: "payload.host_decoded_block_textures",
    kind: "payload",
    name: "Block-compressed textures (BC1-BC7, RGTC, ETC2, ASTC) delivered as host-decoded RGBA8/R8/RG8 (GRC_TEXTURE_DECODE=engine)",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, TEX, "g8t", "decode-reference"],
        [NATIVE, TEX, "g8t", "decode-oracle"],
      ],
      notes:
        "Equal to the engine's CPU decoder; a GPU's own BC decode differs by up to 5 levels on 23,827 px of the fixture (decode-hardware-band, informative).",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [["g7-8", TEX, "receiver", "decode-reference"]],
      notes: "Within G7b's readback/delta1 band of the native leg.",
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [["g7-8", TEX, "receiver", "decode-reference"]],
      notes:
        "Judged against the native leg of the same recording: channel 1, or inside a region the fixture declares undecided (its filtered and nearest-stretched rows).",
    },
  },
  {
    id: "payload.float_texture_formats",
    kind: "payload",
    name: "Float texture payloads (RF, RGF, RGBF, RGBAF, RH, RGH, RGBH, RGBAH) quantized to RGBA8 by the receiver (rs-core texture_rgba8)",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, TEX, "g8f", "float-exact"],
        [NATIVE, TEX, "g8f", "float-wire"],
      ],
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [["g7-8", TEX, "g8f/receiver", "float-exact"]],
      notes: "Floats are sampled natively by the engine (no caveat).",
    },
    gsw: {
      status: "supported",
      exactness: "quantized",
      refs: [
        ["g7-8", TEX, "g8f/receiver", "float-exact"],
        ["g7-8", TEX, "g8f/receiver", "float-texture-quantized"],
      ],
      notes:
        "Caveat float-texture-quantized (applied.json receiver.caveats, receiver.float_quantized): GSW takes every float as RGBA8, so a shader that scales an HDR value past 1 differs; the fixture's two gain-scaled strips are excluded from the pixel comparison.",
    },
  },
  {
    id: "control.adopted_pre_arm_resources",
    kind: "control",
    name: "Lazy adoption of pre-arm textures, meshes and glyph atlases at a late arm (GRC_ADOPT=arm)",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-adopt", "g8a", "adopt-resources-account"],
        [NATIVE, "gate8-adopt", "g8a", "fault-no-resources"],
        [NATIVE, "gate8-adopt", "g8a", "fault-atlas-from-dummy"],
      ],
      notes:
        "Limits kept: an in-place-updated ImageTexture is adopted only for its declared creation region (adopted_content creation); RS-only objects with no node are counted, not adopted.",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        [
          "g7-8",
          "gate8-adopt",
          "g8a/fault-no-resources/receiver",
          "fault-no-resources",
        ],
        [
          "g7-8",
          "gate8-adopt",
          "g8a/fault-atlas-from-dummy/receiver",
          "fault-atlas-from-dummy",
        ],
      ],
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [
        [
          "g7-8",
          "gate8-adopt",
          "g8a/fault-no-resources/receiver",
          "fault-no-resources",
        ],
        [
          "g7-8",
          "gate8-adopt",
          "g8a/fault-atlas-from-dummy/receiver",
          "fault-atlas-from-dummy",
        ],
      ],
    },
  },
  {
    id: "viewport.late-presentation-size",
    kind: "viewport",
    name: "presentation:WxH applied at a late arm (D10), the engine recomputing stretch, oversampling and StyleBox AA",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-size", "g8h", "late-size-reference"],
        [NATIVE, "gate8-size", "g8h", "late-size-equivalence"],
      ],
      notes:
        "One presentation size per session; several or negotiated sizes stay unobserved.",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-size", "g8h/late/receiver", "late-size-reference"],
        ["g7-8", "gate8-size", "g8h/late/receiver", "late-size-needed"],
      ],
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-size", "g8h/late/receiver", "late-size-reference"],
        ["g7-8", "gate8-size", "g8h/late/receiver", "late-size-needed"],
      ],
    },
  },
  {
    id: "delivery.texture_variant_block",
    kind: "delivery",
    name: "render-stream/9 `block` variant: the game's own BC/ETC2/ASTC bytes uploaded as blocks (GRC_TEXTURE_DELIVERY=passthrough)",
    native: {
      status: "supported",
      exactness: "exact",
      raw: true,
      refs: [
        [NATIVE, "gate8-tex", "g8kp", "delivery-select"],
        [NATIVE, "gate8-tex", "g8kp", "block-exact"],
        [NATIVE, "gate8-tex", "g8kp", "delivery-pixels-native"],
        [NATIVE, "gate8-tex", "g8kp", "delivery-live"],
      ],
      notes:
        "Equal to a fixture sampling the same .ctex on the same GPU (0 px). The receiver picks by D3: first of its texture_encodings the entry lists, block only when its format family is in gpu_formats, decoded last.",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      raw: true,
      refs: [
        [NATIVE, "gate8-tex", "g8kp", "delivery-select-web"],
        [NATIVE, "gate8-tex", "g8kp", "delivery-pixels-web"],
      ],
      notes:
        "G8kwh: the web export states only the families its WebGL 2 context lists an extension for (desktop s3tc,bptc,rgtc; never etc2, which Godot claims on every web build) and applies WebGL's BC alignment rule (a level 0 that is not 4-aligned is sent decoded). Only BC ran: 6 block uploads, 212,483 decided px, 206,487 exact and 5,996 at delta 1 against the GPU-sampled reference, no WebGL console error; native gate 8's sabotage-advertise-etc2 shows the pre-G8kwh hello failing the same predicate. ETC2/ASTC on a phone-class web export are unobserved.",
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      raw: true,
      refs: [[NATIVE, "gate8-tex", "g8kp", "delivery-pixels-gsw"]],
      notes:
        "On the desktop only the BC formats ran (its GPU exposes no ETC2/ASTC to WebGL): on the pixels GSW's decoded draw already equals the native reference, 203,702 equal the GPU-sampled reference and 5,903 differ by exactly 1. On the g31 (ETC2 + ASTC only, no BC) G8kb uploaded the uastc transcodes through the same compressedTexImage2D calls without a GL error (see texture_variant_uastc); a g31 leg on a block-source recording was not run. GSW states bc_aligned_only (G8kwh), which no fixture exercises.",
    },
  },
  {
    id: "delivery.texture_variant_uastc",
    kind: "delivery",
    name: "render-stream/9 `uastc` variant: KTX2 UASTC LDR 4x4 + zstd transcoded by the receiver to its GPU's block format (GRC_TEXTURE_DELIVERY=basis-uastc)",
    native: {
      status: "supported",
      exactness: "exact",
      raw: true,
      refs: [
        [NATIVE, "gate8-basis", "g8ku", "ktx2-wire"],
        [NATIVE, "gate8-basis", "g8ku", "transcode-oracle"],
        [NATIVE, "gate8-basis", "g8ku", "delivery-reference"],
        [NATIVE, "gate8-basis", "g8ku", "delivery-live"],
      ],
      notes:
        "Lossy tiers are judged against their own oracle (Image.load_ktx_from_buffer of the same payload), never the source: uploaded blocks equal the oracle bit for bit (BC7 on this GPU); the quality band is recorded (quality-band). A transcode the loader refuses (delivery-transcode-failed) falls back to the decoded variant (G8kf: delivery-fallback, sabotage corrupt-ktx2); a prepared cache warms uastc entries (prepare-uastc-warm); a decoded hash that is still being computed arrives as delivery-pending (opt-in GRC_TEXTURE_PENDING=publish) and is recovered.",
    },
    web: {
      status: "supported",
      exactness: "exact",
      raw: true,
      refs: [
        [NATIVE, "gate8-basis", "g8ku-web/web", "delivery-web"],
        [NATIVE, "gate8-basis", "g8ku-web/web", "delivery-pixels-web"],
        [NATIVE, "gate8-basis", "g8ku-web/web-masked", "delivery-web-masked"],
      ],
      notes:
        "Transcodes through the same engine call in wasm, on the main thread (about 3.8x the native cost). Since G8kwh the transcode must land on a family the export states: a target that is not stated, or BC at an unaligned size, is refused and falls back to decoded (masked leg: 6 refusals, 10 decoded uploads), and an unaligned texture (npot, 150x110) is sent decoded where native uploads BC7; the aligned ones equal the native upgrade within channel 1. Fallback and pending recovery as on the native receiver (G8kf).",
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [
        [
          "g7-8",
          "gate8-basis",
          "g8ku/sabotage-perturb-ktx2/receiver",
          "gsw-transcode-oracle",
        ],
        [
          "g7-8",
          "gate8-basis",
          "g8ku/sabotage-perturb-ktx2/receiver",
          "gsw-delivery-policy",
        ],
        [
          "g7-8",
          "gate8-basis",
          "g8ku/sabotage-perturb-ktx2/receiver",
          "gsw-delivery-pixels",
        ],
        [
          "g7-8",
          "gate8-basis",
          "g8ku/sabotage-perturb-ktx2/receiver",
          "gsw-transcode-fallback",
        ],
        [
          "g7-8",
          "gate8-basis",
          "g8ku/sabotage-perturb-ktx2/receiver",
          "sabotage-perturb-ktx2",
        ],
      ],
      notes:
        "G8kb: a basisu transcoder wasm in a Web Worker verifies the KTX2 in rs-core, transcodes it to D14's target for the context (BC7 on the desktop, ASTC 4x4 on the g31 for RGBA and, since G8kb2, RGB; ETC1/ETC2/BC1/BC3 where ASTC is absent; RGBA8 when none) and uploads the blocks. Blocks equal the native oracle's bit for bit on the oracle's target; pixels are within channel 1 of the native upgrade leg except the half-size mip draw (GSW uploads level 0 only) and the npot texture (RGBA8 by WebGL's alignment rule, 46.2 dB). A failed transcode refetches the decoded variant (gsw-transcode-fallback; final image equals keep's). g31 (real time): ASTC transcode about 57-77 ms/Mpx in the worker, GPU memory a quarter or less of decoded's (36 vs 150 MiB over 64 copies); ETC1 for RGB was lossy on noise (18.8 dB), which G8kb2's ASTC for RGB closed (59.0 dB). Upgrade on a phone-class context, keep on a desktop (D6).",
    },
  },
];

function partOf(spec: Spec8, kind: ReceiverKind): Part {
  return kind === "native"
    ? spec.native
    : kind === "web-export"
      ? spec.web
      : spec.gsw;
}

function toEntry(spec: Spec8, kind: ReceiverKind): FeatureEntry2 {
  const p = partOf(spec, kind);
  return {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    status: p.status,
    reason: p.reason ?? null,
    exactness: p.status === "supported" ? (p.exactness ?? null) : null,
    tolerance: null,
    evidence: evidence(kind, p),
    owner: p.owner ?? null,
    notes: p.notes ?? null,
  };
}

/** Gate 7 entries whose meaning changes at /8: the entry keeps its id and name, takes the
 * gate 8 evidence and says what stays out. */
interface Override8 {
  id: string;
  native: Part;
  web: Part;
  gsw: Part;
}

const FORMATS_NOTE =
  "Resolved at /8 by host decode (payload.host_decoded_block_textures), float payloads (payload.float_texture_formats) and the /9 block variant (delivery.texture_variant_block). Not proven at STS2 scale: wire and memory acceptability are the product leg's (P3).";

/** P3-ST (gate5_5-design.md "Screen texture (P3-ST)"), then CG1/CG3 (render-stream-10.md): screen-reading
 * shaders are supported with GLES3's automatic copy points, and /10 carries `BackBufferCopy`. */
const BACKBUFFER_NOTE =
  "Not carried on /8 or earlier (the gate 6 text said hooked: it never was). Since P3-ST hint_screen_texture shaders are ok on the wire and every receiver mirrors GLES3's automatic back-buffer copies (fixtures/gate55-screen, run-gate55.sh g55s). Since CG1 the opt-in render-stream/10 carries the setter as the item key `copy_to_backbuffer` and the native receiver and the web export re-issue it; since CG3 GSW composites it (delivery.canvas_group_state_10, g8cg). On a /8 stream a host's BackBufferCopy nodes are not carried, so their copy points replay as the automatic ones.";

const CANVAS_GROUP_NOTE =
  "Not carried on /8 or earlier: no /8 fixture creates a CanvasGroup or clip_children item. Since CG1 the opt-in render-stream/10 carries the setter as the item key `canvas_group` and the native receiver and the web export re-issue it; since CG3 GSW composites it (delivery.canvas_group_state_10, fixtures/gate8-cg, g8cg).";

/** P3-VX (gate5_5-design.md "vertex() (P3-VX)"): GSW's transpiler runs vertex() and varyings
 * since P3-VX, so the refusals left are narrower. */
const OUTSIDE_TRANSPILE_NOTE =
  "P3-VX: vertex() with varyings (flat and smooth), skip_vertex_transform, world_vertex_coords, MODEL/CANVAS/SCREEN_MATRIX, TEXTURE_PIXEL_SIZE, AT_LIGHT_PASS and INSTANCE_CUSTOM transpile (fixtures/gate55-vertex, run-gate55.sh g55v). P3-TM: TIME (both stages, the host's shader time carried by /10) and the hint_default_black/transparent, hint_normal, hint_roughness_normal and hint_anisotropy sampler defaults transpile too (fixtures/gate55-time, g55t). Still typed gsw-shader-transpile (programs.ts): VERTEX_ID, INSTANCE_ID, CUSTOM0/1, fragment() VERTEX, SDF and light built-ins, global and matrix uniforms, other sampler hints, uvec/bvec and non-literal defaults. Every gate 5.5 shader the wire does not refuse transpiles (shader-transpile-set@gsw), so no leg observes the refusal.";

const SHADER_P3_REFS_NATIVE: [string, string, string, string][] = [
  ["gate5.5", "gate55-shader", "receiver", "shader-expected-image-reference"],
  ["gate5.5", "gate55-screen", "g55s", "g55s-receiver-equals-reference"],
  ["gate5.5", "gate55-vertex", "g55v", "g55v-receiver-equals-reference"],
  ["gate5.5", "gate55-time", "g55t", "g55t-receiver-equals-reference"],
];
const SHADER_P3_REFS_BROWSER: [string, string, string, string][] = [
  ["g7-55-live", "gate55-screen", "g55s", "g55s-receiver-equals-reference"],
  ["g7-55-live", "gate55-vertex", "g55v", "g55v-receiver-equals-reference"],
  ["g7-55-live", "gate55-time", "g55t", "g55t-receiver-equals-reference"],
];

const OVERRIDES_8: readonly Override8[] = [
  {
    id: "material.shader-transpile-subset",
    native: {
      status: "supported",
      exactness: "exact",
      refs: SHADER_P3_REFS_NATIVE,
      notes:
        "Gate 7's evidence plus P3-ST (screen texture), P3-VX (vertex() and varyings) and P3-TM (TIME and sampler defaults): each group's receiver equals the rendered reference.",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        [
          "g7-55",
          "gate6-scene",
          "shader/receiver",
          "shader-receiver-vs-reference",
        ],
        ...SHADER_P3_REFS_BROWSER,
      ],
    },
    gsw: {
      status: "supported",
      exactness: "exact",
      refs: [
        [
          "g7-55",
          "gate6-scene",
          "shader/receiver",
          "shader-receiver-vs-reference",
        ],
        ["g7-55", "gate6-scene", "shader/receiver", "shader-transpile-set"],
        ...SHADER_P3_REFS_BROWSER,
      ],
    },
  },
  {
    id: "canvas_item_set_canvas_group_mode",
    native: {
      status: "unobserved",
      owner: "CG1: carried on /10",
      notes: CANVAS_GROUP_NOTE,
    },
    web: {
      status: "unobserved",
      owner: "CG1: carried on /10",
      notes: CANVAS_GROUP_NOTE,
    },
    gsw: {
      status: "unobserved",
      owner: "CG1: carried on /10",
      notes: CANVAS_GROUP_NOTE,
    },
  },
  {
    id: "material.shader-outside-transpile-subset",
    native: {
      status: "declared-unverified",
      notes:
        "The engine compiles every shader the wire carries; no gate leg carries one outside GSW's subset (TIME is wire-typed unsupported-material).",
    },
    web: {
      status: "declared-unverified",
      notes:
        "The web export compiles shaders in the engine, as native; no gate leg carries a shader outside GSW's subset.",
    },
    gsw: {
      status: "declared-unverified",
      reason: "gsw-shader-transpile",
      notes: OUTSIDE_TRANSPILE_NOTE,
    },
  },
  {
    id: "canvas_item_set_copy_to_backbuffer",
    native: {
      status: "unobserved",
      owner:
        "CG1: carried on the opt-in render-stream/10 (results/p3/cg1.md); a /8 stream does not carry it",
      notes: BACKBUFFER_NOTE,
    },
    web: {
      status: "unobserved",
      owner:
        "CG1: carried on the opt-in render-stream/10 (results/p3/cg1.md); a /8 stream does not carry it",
      notes: BACKBUFFER_NOTE,
    },
    gsw: {
      status: "unobserved",
      owner:
        "CG1: carried on the opt-in render-stream/10 (results/p3/cg1.md); a /8 stream does not carry it",
      notes: BACKBUFFER_NOTE,
    },
  },
  {
    id: "payload.compressed_and_float_texture_formats",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, TEX, "g8t", "decode-reference"],
        [NATIVE, TEX, "g8f", "float-exact"],
      ],
      notes: FORMATS_NOTE,
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", TEX, "receiver", "decode-reference"],
        ["g7-8", TEX, "g8f/receiver", "float-exact"],
      ],
      notes: FORMATS_NOTE,
    },
    gsw: {
      status: "supported",
      exactness: "quantized",
      refs: [
        ["g7-8", TEX, "receiver", "decode-reference"],
        ["g7-8", TEX, "g8f/receiver", "float-texture-quantized"],
      ],
      notes: `${FORMATS_NOTE} GSW quantizes floats (caveat float-texture-quantized).`,
    },
  },
  {
    id: "control.late-join-adoption",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-adopt", "g8a", "adopt-reference"],
        [NATIVE, "gate8-adopt", "g8a", "adopt-equivalence"],
        [NATIVE, "gate8-adopt", "g8a", "adopt-noop-at-birth"],
      ],
      notes:
        "GRC_ADOPT=arm adopts pre-arm canvases, layers and items so a late arm equals a born one. Arm on first subscriber and disarm on last stay unobserved (control.arm-on-first-subscriber).",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-adopt", "g8a/late/receiver", "adopt-reference"],
        ["g7-8", "gate8-adopt", "g8a/late/receiver", "g8a-legs"],
      ],
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [
        ["g7-8", "gate8-adopt", "g8a/late/receiver", "adopt-reference"],
        ["g7-8", "gate8-adopt", "g8a/late/receiver", "g8a-legs"],
      ],
    },
  },
  {
    id: "material.late-join-materials",
    native: {
      status: "supported",
      exactness: "exact",
      refs: [
        [NATIVE, "gate8-mat", "g8m", "mat-adopt-reference"],
        [NATIVE, "gate8-mat", "g8m", "adopt-material-account"],
      ],
      notes:
        "Pre-arm ShaderMaterials, CanvasItemMaterials and their shaders adopted at GRC_ADOPT=arm; an include the host cannot resolve is refused (adopt-include-refused).",
    },
    web: {
      status: "supported",
      exactness: "delta1",
      refs: [["g7-8", "gate8-mat", "g8m/late/receiver", "mat-adopt-reference"]],
    },
    gsw: {
      status: "supported",
      exactness: "delta1",
      refs: [["g7-8", "gate8-mat", "g8m/late/receiver", "mat-adopt-reference"]],
    },
  },
];

/** One receiver kind's /8 entries, unsorted: gate 7's, with gate 8's overrides, plus gate 8's. */
export function receiverFeatureEntries8(kind: ReceiverKind): FeatureEntry2[] {
  const base = receiverFeatureEntries(kind);
  const over = new Map(OVERRIDES_8.map((o) => [o.id, o]));
  const out = base.map((e) => {
    const o = over.get(e.id);
    if (!o) return e;
    const p = partOf({ ...o, kind: e.kind, name: e.name }, kind);
    return {
      ...e,
      status: p.status,
      reason: p.reason ?? null,
      exactness: p.status === "supported" ? (p.exactness ?? null) : null,
      tolerance: null,
      evidence: evidence(kind, p),
      owner: p.owner ?? null,
      notes: p.notes ?? null,
    };
  });
  for (const o of over.keys())
    if (!base.some((e) => e.id === o))
      throw new Error(`feature-evidence-8: override ${o} matches no /7 entry`);
  for (const s of SPECS_8) out.push(toEntry(s, kind));
  return out;
}

export const NEW_ENTRY_IDS_8: readonly string[] = SPECS_8.map((s) => s.id);
export const OVERRIDDEN_IDS_8: readonly string[] = OVERRIDES_8.map((o) => o.id);

/** RM8: every group a gate 8 or gate 5.5 runner has landed (`LANDED_GROUPS` in run-gate8.sh and
 * run-gate55.sh) says here what its manifest entries are, or why it has none. The G8z self-test
 * fails on a landed group missing from this map, so a new group cannot skip the manifests. Entry
 * ids must exist in the /8 file; `none:` is a reason, not an entry. */
export const GROUP_COVERAGE_8: Record<string, readonly string[] | string> = {
  g8t: ["payload.host_decoded_block_textures"],
  g8a: ["control.late-join-adoption", "control.adopted_pre_arm_resources"],
  g8h: ["viewport.late-presentation-size"],
  g8f: ["payload.float_texture_formats"],
  g8m: ["material.late-join-materials"],
  g8kp: ["delivery.texture_variant_block"],
  g8ku: ["delivery.texture_variant_uastc"],
  g8kc: "none: the receivers' texture cache is internal, no feature row",
  g8l: ["delivery.stream_protocol_8", "delivery.reverse_proxy_fronting"],
  g8c: ["payload.canvas_texture_diffuse"],
  g8cg: ["delivery.canvas_group_state_10"],
  g8w11:
    "none: the capture side of render-stream/11 (W11b); no receiver applies /11 yet, so the /8 manifest has no row",
  g8w11c:
    "none: the /11 live coding resync legs (GTS), a receiver behavior of render-stream/11; no /8 manifest row",
  g8mm:
    "none: /11's multimesh (PM1's capture, PM2's native and web receivers) is render-stream/11, which the /8 manifest does not describe (as g8w11)",
  g8pt:
    "none: /12's GPU particles (PM5's capture, PM6a's native and web receivers) are render-stream/12, which the /8 manifest does not describe (as g8mm)",
  g8tag2:
    "none: TAG2's client extension API and override table are an opt-in layer of the render-stream client package over /13, which the /8 manifest does not describe",
  g8rec1:
    "none: REC1's client recorder is an opt-in layer of the render-stream client package over /13 (the recording is the wire format itself), which the /8 manifest does not describe",
  g8tag:
    "none: TAG1's item identity (the /13 hello key and item_meta record) is an opt-in client-extension layer of render-stream/13, no receiver applies it yet, and the /8 manifest does not describe it",
  g55b: "none: gate 7's carried CanvasItemMaterial entries (material.*)",
  g55c: "none: gate 7's carried shader entries (material.*)",
  g55d: "none: gate 7's carried material entries (material.*)",
  g55e: "none: gate 7's carried ShaderMaterial entries (material.*)",
  g55f: "none: gate 7's carried live shader entries (material.*)",
  g55s: [
    "material.shader-transpile-subset",
    "canvas_item_set_copy_to_backbuffer",
  ],
  g55v: ["material.shader-transpile-subset"],
  g55t: ["material.shader-transpile-subset"],
};
