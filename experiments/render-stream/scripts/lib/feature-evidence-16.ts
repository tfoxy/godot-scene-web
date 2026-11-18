// VS4: the evidence map behind protocol/features/render-stream-16/gsw-canvas.json.
// scripts/make-features.ts --protocol 16 is the generator.
//
// Only the GSW canvas receiver speaks render-stream/16 (render-stream-16.md "Who speaks /16": the
// native receiver and the web export do not offer it), so /16 has one manifest, not three. It is
// the /8 GSW manifest's entries (lib/feature-evidence-8.ts) with the changes below: the rows /16
// moves are overridden, the rows it adds are new, and every other row is /8's, unchanged.
//
//   viewport.non-root-viewport   typed-unsupported in /8 ("never given a dedicated increment")
//                                becomes supported for 2D: the viewport table, the `viewport` and
//                                `proxy` texture kinds and one draw list per surface (VS3), judged
//                                by gate 8's g8vp vp-reference (GSW against the rendered Godot
//                                reference, file legs) and g8vl vp-live (the same live)
//   viewport.viewport-3d         a viewport that renders 3D world content stays typed: the surface's
//                                2D canvases still draw, the 3D picture does not
//   viewport.viewport-hdr-2d     typed: HDR 2D targets
//   viewport.viewport-msaa-2d    typed: 2D MSAA
//   control.viewports_client_option  the client's `viewports: false` (D3): no surface pass, viewport
//                                textures transparent, `surfacesSkipped` counted; vp-client-off
//   delivery.stream_protocol_16  the live subprotocol render-stream.16 (offered alone, no fallback)
//
// Evidence is named by group, fixture, leg and check, as in /8. The closing runs are VS5's
// (EVIDENCE_RUNS_16): the g7-8 GSW file receivers and the g7-vp live matrix on main 5e5f08d0, and the
// moto g31 viewports on/off sweep. Paths are relative to artifacts/.

import type {
  EvidenceRef2,
  EvidenceRun,
  FeatureEntry2,
  ReceiverKind,
} from "./feature-evidence-7";
import { receiverFeatureEntries8 } from "./feature-evidence-8";

export const MANIFEST16_FILES: Partial<Record<ReceiverKind, string>> = {
  "gsw-canvas": "gsw-canvas.json",
};

const KIND: ReceiverKind = "gsw-canvas";
const FIXTURE = "viewport-scene";

const ref = (gate: string, leg: string, check: string): EvidenceRef2 => ({
  gate,
  fixture: FIXTURE,
  leg,
  check,
  receiver_kind: KIND,
});

const NON_ROOT: FeatureEntry2 = {
  id: "viewport.non-root-viewport",
  kind: "viewport",
  name: "non-root Viewport / SubViewport (2D): each reached viewport drawn into its own surface, shown through viewport and proxy textures",
  status: "supported",
  reason: null,
  exactness: "delta1",
  tolerance: null,
  evidence: [
    ref("g7-8", "g8vp/born/receiver", "vp-reference@gsw"),
    ref("g7-8", "g8vp/born-rendered/receiver", "vp-reference@gsw"),
    ref("g7-8", "g8vp/late/receiver", "vp-reference@gsw"),
    ref("g7-8", "g8vp/late-rendered/receiver", "vp-reference@gsw"),
    ref("g7-vp", "g8vl/on/receiver", "vp-live@gsw"),
    ref("g7-vp", "g8vl/late/receiver", "vp-live-late@gsw"),
    ref("g7-vp", "g8vl/rendered/receiver", "vp-live-rendered@gsw"),
    ref("g7-vp", "g8vl/late-rendered/receiver", "vp-live-late-rendered@gsw"),
  ],
  owner: null,
  notes:
    "VS3/VS4: every pixel outside the typed regions is within one channel step of the rendered Godot host (fixtures/viewport-scene/expected.json reference). Receiver caveats typed, not hidden: viewport-accumulation (a clear-never surface accumulates per received frame, Godot per host frame), viewport-feedback (a surface sampling itself binds transparent), viewport-too-large, viewport-order. 3D content stays viewport-3d. pick_tree stays root-only (items inside a surface are not pickable on the client).",
};

const NEW: readonly FeatureEntry2[] = [
  {
    id: "viewport.viewport-3d",
    kind: "viewport",
    name: "a viewport that renders 3D world content (a camera attached, 3D not disabled, an instance in its scenario)",
    status: "typed-unsupported",
    reason: "viewport-3d",
    exactness: null,
    tolerance: null,
    evidence: [ref("g7-8", "g8vp/born/receiver", "vp-reference@gsw")],
    owner:
      "none planned: 3D world content is outside the 2D canvas renderer; the surface's 2D canvases still draw (the view3d region of the reference is excluded)",
    notes: null,
  },
  {
    id: "viewport.viewport-hdr-2d",
    kind: "viewport",
    name: "a viewport with HDR 2D rendering",
    status: "typed-unsupported",
    reason: "viewport-hdr-2d",
    exactness: null,
    tolerance: null,
    evidence: [],
    owner: "none planned: the surfaces are RGBA8 or RGB10A2",
    notes: null,
  },
  {
    id: "viewport.viewport-msaa-2d",
    kind: "viewport",
    name: "a viewport with 2D MSAA",
    status: "typed-unsupported",
    reason: "viewport-msaa-2d",
    exactness: null,
    tolerance: null,
    evidence: [],
    owner: "none planned: the surfaces are not multisampled",
    notes: null,
  },
  {
    id: "control.viewports_client_option",
    kind: "control",
    name: "the client's `viewports: false` option: the viewport table is applied, no surface pass is built, viewport textures draw transparent",
    status: "supported",
    reason: null,
    exactness: null,
    tolerance: null,
    evidence: [ref("g7-vp", "g8vl/client-off/receiver", "vp-client-off@gsw")],
    owner: null,
    notes:
      "The stream is the same /16 wire, so no host restart is needed to try either value. The core counts the surfaces it did not build (stat surfacesSkipped). The host's own switch is GRC_VIEWPORTS=off.",
  },
  {
    id: "delivery.stream_protocol_16",
    kind: "delivery",
    name: "render-stream/16 live subprotocol render-stream.16, offered alone (no fallback, no upgrade rule), under GRC_STREAM_VERSION=16",
    status: "supported",
    reason: null,
    exactness: null,
    tolerance: null,
    evidence: [ref("g7-vp", "g8vl/on/receiver", "vp-live@gsw")],
    owner: null,
    notes:
      "The render-stream client package offers exactly render-stream.<the endpoint protocol>; at 16 resourceHints keeps its /15 meaning (the host's GRC_RESOURCE_HINTS decides whether hints are sent).",
  },
];

/** The gsw-canvas receiver's /16 entries, unsorted: /8's with this file's overrides and additions. */
export function receiverFeatureEntries16(kind: ReceiverKind): FeatureEntry2[] {
  if (kind !== KIND)
    throw new Error(
      `feature-evidence-16: only ${KIND} speaks render-stream/16 (got ${kind})`,
    );
  const base = receiverFeatureEntries8(kind);
  if (!base.some((e) => e.id === NON_ROOT.id && e.kind === NON_ROOT.kind))
    throw new Error(`feature-evidence-16: /8 has no ${NON_ROOT.id} to move`);
  const out = base.map((e) => (e.id === NON_ROOT.id ? NON_ROOT : e));
  for (const n of NEW) {
    if (out.some((e) => e.id === n.id && e.kind === n.kind))
      throw new Error(`feature-evidence-16: ${n.id} is already in /8`);
    out.push(n);
  }
  return out;
}

export const NEW_ENTRY_IDS_16: readonly string[] = NEW.map((e) => e.id);

/** VS5's closing runs (2026-11-18); paths are relative to artifacts/. */
export const VS5_BUILD = "5e5f08d0";
export const EVIDENCE_RUNS_16: readonly EvidenceRun[] = [
  {
    key: "g7-8@gsw",
    path: "render-stream/gate8/vs5/g7-gsw-g8vp",
    build: VS5_BUILD,
    note: "VS5 closing run: GSW file receivers on g8vp born, born-rendered, late and late-rendered (vp-reference 4/4 steps each), sourced from native g8vp at render-stream/gate8/vs5/native-g8vp (6/6)",
  },
  {
    key: "g7-vp@gsw",
    path: "render-stream/gate8/vs5/g7live-gsw-g7-vp",
    build: VS5_BUILD,
    note: "VS5 closing run: g7-vp live matrix (vp-live, vp-live-late, vp-live-rendered, vp-live-late-rendered, vp-client-off)",
  },
  {
    key: "g7-dev-vp@gsw",
    path: "vs5b/phone-fixed-1/g7v-vp-summary.json",
    build: "29ff554c",
    note: "VS5 moto g31 ABBA of client viewports on vs viewports:false (draw active, draw idle, vfx6; host-off arm H); 15/15 arms valid; no surface budget needed",
  },
];
