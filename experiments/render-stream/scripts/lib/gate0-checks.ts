// Gate 0 checks and leg classification (protocol/gate0-design.md "Q6. Runner, legs and checker"),
// on render-stream/1 since G1b2 (protocol/gate1-design.md "G1b2"). The resolved-state recording
// summary and the draw-index-tie analysis here are shared with gate1-checks.ts.
//
// Everything here reads an evidence directory written by run-gate0.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate0.ts can drive it with fabricated trees.
// Nothing launches a process. `classifyLeg` is pure and never reads `session.sabotage`.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 0"):
//   capture/                   the 400-frame capture host: evidence/, recording.rs1, steps.jsonl,
//                              strace.txt, maps.txt, fd.txt
//   reference/                 rendered fixture, extension absent: shots/step-<k>.png, steps.jsonl
//   receiver/                  rendered receiver on a copy of capture/recording.rs1:
//                              recording.rs1, applied.json, shots/seq-<n>.png, diff/step-<k>.png
//   receiver-headless-trace/   headless receiver under strace: recording.rs1, applied.json, strace.txt
//   sabotage-{freeze,omit,perturb}/{capture,receiver}/
//   unsupported/{capture,receiver}/
//   preexisting/               a capture-shaped leg (no receiver)
//   corrupt/                   headless receiver on capture/recording.rs1 with seq 3's meta broken
//   import/{fixture,receiver}/, receiver-typecheck/{selftest,minimal}/
// Every process directory holds argv.txt (one argument per line), env.txt, stdout.log (stdout and
// stderr) and exit-code.txt.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";
import {
  checkHeadlessNoGpu,
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
  successfulOpenats,
} from "./gate-minus1-checks";
import { synthesizeExpected } from "./gate0-expected";
import {
  applyTransaction,
  decodeRecord,
  emptyResolvedState,
  type ResolvedCanvas,
  type ResolvedCommand,
  type ResolvedItem,
  type ResolvedState,
  type EndMeta as Rs1EndMeta,
  type SessionMeta as Rs1SessionMeta,
  type TransactionMeta as Rs1TransactionMeta,
  sortedResolvedCanvases,
  sortedResolvedItems,
  splitRecords,
  validateRecording,
} from "./render-stream-1";

/** WP3's `render-stream-gate0-expected/1` type, whatever it is named there. */
export type Gate0Expected = Parameters<typeof synthesizeExpected>[0];

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's `RS_FIXTURE_QUIT_FRAME`: one transaction per frame, so 400 transactions. */
export const CAPTURE_QUIT_FRAME = 400;

/** The full-sink recording every capture writes (GRC_STREAM_OUT) and every receiver copy uses. */
export const RECORDING_NAME = "recording.rs1";
/** The patch-sink recording (GRC_STREAM_PATCH_OUT), written by the gate 1 capture legs. */
export const PATCH_RECORDING_NAME = "recording-patch.rs1";

/** Every hook the committed calibration record installs, sorted by byte value
 * (render-stream-0.md, golden session): calibrator 3's 42, plus calibrator 4's
 * `canvas_item_set_draw_behind_parent` / `canvas_item_set_z_as_relative_to_parent` (gate1-design.md
 * G1e) and calibrator 5's eleven texture hooks (gate2-design.md Q2) -- the record is shared by
 * gate -1, gate 0, gate 1 and gate 2, so every one of them plans all 55. */
export const GATE0_HOOKS: readonly string[] = [
  "canvas_create",
  "canvas_item_add_circle",
  "canvas_item_add_lcd_texture_rect_region",
  "canvas_item_add_line",
  "canvas_item_add_mesh",
  "canvas_item_add_msdf_texture_rect_region",
  "canvas_item_add_multimesh",
  "canvas_item_add_nine_patch",
  "canvas_item_add_polygon",
  "canvas_item_add_polyline",
  "canvas_item_add_primitive",
  "canvas_item_add_rect",
  "canvas_item_add_set_transform",
  "canvas_item_add_texture_rect",
  "canvas_item_add_texture_rect_region",
  "canvas_item_add_triangle_array",
  "canvas_item_clear",
  "canvas_item_create",
  "canvas_item_set_clip",
  "canvas_item_set_custom_rect",
  "canvas_item_set_default_texture_filter",
  "canvas_item_set_default_texture_repeat",
  "canvas_item_set_draw_behind_parent",
  "canvas_item_set_draw_index",
  "canvas_item_set_material",
  "canvas_item_set_modulate",
  "canvas_item_set_parent",
  "canvas_item_set_self_modulate",
  "canvas_item_set_transform",
  "canvas_item_set_visibility_layer",
  "canvas_item_set_visible",
  "canvas_item_set_z_as_relative_to_parent",
  "canvas_item_set_z_index",
  "canvas_texture_create",
  "canvas_texture_set_channel",
  "canvas_texture_set_texture_filter",
  "canvas_texture_set_texture_repeat",
  "free",
  "material_set_param",
  "mesh_add_surface",
  "mesh_clear",
  "mesh_create",
  "mesh_set_custom_aabb",
  "mesh_surface_update_attribute_region",
  "mesh_surface_update_vertex_region",
  "shader_create_from_code",
  "shader_set_code",
  "texture_2d_create",
  "texture_2d_placeholder_create",
  "texture_2d_update",
  "texture_replace",
  "viewport_attach_canvas",
  "viewport_set_canvas_transform",
  "viewport_set_default_canvas_item_texture_filter",
  "viewport_set_default_canvas_item_texture_repeat",
];

/** Session `features` at gate 1 / render-stream/1, exactly (render-stream-1.md "Session record"):
 * gate 0's lists plus `behind`/`z_relative` and `viewport_set_global_canvas_transform`, minus
 * `canvas_item_set_draw_behind_parent`/`canvas_item_set_z_as_relative_to_parent` (G1e hooks both,
 * so they leave `unobserved`). */
export const RS1_FEATURES = {
  ops: ["add_rect"],
  item_state: [
    "behind",
    "children",
    "clip",
    "custom_rect",
    "draw_index",
    "modulate",
    "parent",
    "self_modulate",
    "transform",
    "visibility_layer",
    "visible",
    "z_index",
    "z_relative",
  ],
  observed_unsupported_ops: [
    "canvas_item_add_circle",
    "canvas_item_add_line",
    "canvas_item_add_mesh",
    "canvas_item_add_msdf_texture_rect_region",
    "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch",
    "canvas_item_add_polygon",
    "canvas_item_add_polyline",
    "canvas_item_add_primitive",
    "canvas_item_add_set_transform",
    "canvas_item_add_texture_rect",
    "canvas_item_add_texture_rect_region",
    "canvas_item_add_triangle_array",
    "canvas_item_set_material",
  ],
  // G1e hooks canvas_item_set_draw_behind_parent and canvas_item_set_z_as_relative_to_parent,
  // so both leave this list.
  unobserved: [
    "canvas_item_set_canvas_group_mode",
    "canvas_item_set_default_texture_filter",
    "canvas_item_set_default_texture_repeat",
    "canvas_item_set_instance_shader_parameter",
    "canvas_item_set_light_mask",
    "canvas_item_set_sort_children_by_y",
    "canvas_set_modulate",
    "viewport_remove_canvas",
    "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform",
  ],
  publication: "snapshot-or-patch",
} as const;

export type LegClass =
  | "capture-failure"
  | "unsupported"
  | "replay-failure"
  | "pixel-mismatch"
  | "success";

/** First match wins. */
export const CLASS_PRECEDENCE: readonly LegClass[] = [
  "capture-failure",
  "unsupported",
  "replay-failure",
  "pixel-mismatch",
  "success",
];

export const CLASSIFIED_LEGS = [
  "capture",
  "receiver",
  "sabotage-freeze",
  "sabotage-omit",
  "sabotage-perturb",
  "unsupported",
  "preexisting",
  "corrupt",
] as const;
export type ClassifiedLeg = (typeof CLASSIFIED_LEGS)[number];

export const SUPPORT_LEGS = [
  "import",
  "receiver-typecheck",
  "reference",
  "receiver-headless-trace",
] as const;

export interface LegExpectation {
  class: LegClass;
  /** pixel-mismatch legs: exactly these steps mismatch (steps 0 and 1 always match). */
  mismatchSteps?: number[];
  /** a substring one of the reasons must contain */
  reasonIncludes?: string;
  /** the receiver's applied.json failure */
  failure?: { seq: number; reason: string };
}

export const LEG_EXPECTATIONS: Record<ClassifiedLeg, LegExpectation> = {
  capture: { class: "success" },
  receiver: { class: "success" },
  "sabotage-freeze": { class: "pixel-mismatch", mismatchSteps: [2, 3, 4] },
  "sabotage-omit": { class: "pixel-mismatch", mismatchSteps: [2] },
  "sabotage-perturb": { class: "pixel-mismatch", mismatchSteps: [2, 3, 4] },
  unsupported: { class: "unsupported" },
  preexisting: {
    class: "capture-failure",
    reasonIncludes: "pre-existing-object",
  },
  corrupt: {
    class: "replay-failure",
    failure: { seq: 3, reason: "meta-json" },
  },
};

/** The transaction whose meta the `corrupt` leg breaks. */
export const CORRUPT_SEQ = 3;

export interface LegLayout {
  legDir: string;
  /** the capture host whose recording and result.json feed the classifier */
  captureDir: string;
  /** the receiver process directory, when the leg has one */
  receiverDir?: string;
  /** whether the receiver takes the settle-step shots */
  shots: boolean;
}

export function legLayout(outDir: string, leg: ClassifiedLeg): LegLayout {
  const legDir = join(outDir, leg);
  switch (leg) {
    case "capture":
    case "preexisting":
      return { legDir, captureDir: legDir, shots: false };
    case "receiver":
      return {
        legDir,
        captureDir: join(outDir, "capture"),
        receiverDir: legDir,
        shots: true,
      };
    case "corrupt":
      // The host-side inputs come from the uncorrupted capture recording (design change 11).
      return {
        legDir,
        captureDir: join(outDir, "capture"),
        receiverDir: legDir,
        shots: false,
      };
    case "unsupported":
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: false,
      };
    default:
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: true,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Evidence shapes. Every field is optional so a missing one is a failed check, never a crash.
// ---------------------------------------------------------------------------------------------

export interface CaptureResultJson {
  schema?: string;
  status?: string;
  reason?: string;
  vptr_written?: boolean;
  display_server?: string;
  stream?: {
    path?: string | null;
    patch_path?: string | null;
    status?: string;
    reason?: string | null;
    transactions?: number;
  };
}

interface CountersJson {
  hooks_planned?: string[];
  hooks_omitted?: string[];
}

export interface WireFailure {
  reason: string;
  detail: string;
}
export interface WireUnsupported {
  op: string;
  item: number | null;
  reason: string;
}
export type { ResolvedCanvas, ResolvedCommand, ResolvedItem };

/** One transaction of a recording, RESOLVED (render-stream-1.md "Resolution"): `items` and
 * `canvases` are the complete state after it, whatever its encoding. */
export interface TransactionMeta {
  type: "transaction";
  seq: number;
  frame: number;
  encoding: "full" | "patch";
  base_seq: number | null;
  status: string;
  failures: WireFailure[];
  unsupported: WireUnsupported[];
  /** resolved items, ascending id */
  items: ResolvedItem[];
  /** resolved canvases, ascending id */
  canvases: ResolvedCanvas[];
}
export type SessionMeta = Partial<Omit<Rs1SessionMeta, "type">> & {
  type: "session";
};
export type EndMeta = Partial<Omit<Rs1EndMeta, "type" | "stats">> & {
  type: "end";
  stats?: Partial<Rs1EndMeta["stats"]>;
};

export interface Transaction {
  meta: TransactionMeta;
  /** the record's own wire form (a patch's partial lists, nullable commands); absent in
   * hand-built test values */
  wire?: Rs1TransactionMeta;
  /** the record's byte length, length prefix included */
  bytes?: number;
  sha256: string;
}

export interface RecordingSummary {
  path: string;
  present: boolean;
  sha256: string | null;
  bytes: number;
  /** validateRecording() */
  errors: string[];
  session?: SessionMeta;
  /** the session record's blocks: clear_color, root_canvas_xform, host_visible_rect,
   * host_final_xform, content_scale_factor */
  session_blocks?: number[][];
  transactions: Transaction[];
  end?: EndMeta;
}

export interface AppliedJson {
  schema?: string;
  recording?: { path?: string; sha256?: string; bytes?: number };
  session_id?: string | null;
  status?: string;
  failure?: { seq: number | null; reason: string; detail?: string } | null;
  end_seen?: boolean;
  /** render-stream-receiver-applied/2 (gate1-design.md Q5) */
  mode?: string;
  viewport?: {
    display_server?: string;
    size?: number[];
    size_check?: string | null;
    logical_size?: number[] | null;
  };
  transactions?: {
    seq?: number;
    frame?: number;
    encoding?: string;
    record_sha256?: string;
    rs_calls?: number;
  }[];
  shots?: {
    seq?: number;
    path?: string;
    applied_through?: number;
    state_path?: string | null;
  }[];
  unsupported?: {
    seq?: number;
    item?: number | null;
    name?: string;
    reason?: string;
  }[];
}

export interface StepLine {
  step: number;
  applied_frame: number;
  settle_frame: number;
}

export interface StepJoin {
  ok: boolean;
  entries: { step: number; settle_frame: number; seq: number | null }[];
  problems: string[];
}

export interface RegionDiff {
  /** gate 0: "subject" | "marker"; gate 1: the expected.json region names */
  name: string;
  rect_px: number[];
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
}

export interface Checkpoint {
  step: number;
  settle_frame: number;
  seq: number | null;
  reference_png: string;
  receiver_png: string | null;
  diff_png: string | null;
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  regions: RegionDiff[];
}

export interface Gate0Check {
  id: string;
  criterion: string;
  passed: boolean;
  detail: string;
  evidence: string[];
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function sameStrings(
  a: readonly unknown[] | undefined,
  b: readonly string[],
): boolean {
  return (
    Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Decode, validate and resolve one recording file's bytes (undefined = the file is missing).
 * Resolution stops at the first record that fails to decode; `errors` (validateRecording) says
 * why. */
export function summarizeRecording(
  path: string,
  data: Uint8Array | undefined,
): RecordingSummary {
  if (!data) {
    return {
      path,
      present: false,
      sha256: null,
      bytes: 0,
      errors: ["missing: no recording file"],
      transactions: [],
    };
  }
  const summary: RecordingSummary = {
    path,
    present: true,
    sha256: sha256Hex(data),
    bytes: data.length,
    errors: validateRecording(data),
    transactions: [],
  };
  const split = splitRecords(data);
  let state: ResolvedState = emptyResolvedState();
  for (const raw of split.records) {
    const { record } = decodeRecord(raw);
    if (!record) break;
    const meta = record.meta;
    if (meta.type === "session" && !summary.session) {
      summary.session = meta as SessionMeta;
      summary.session_blocks = record.blocks;
    } else if (meta.type === "transaction") {
      state = applyTransaction(state, meta, record.blocks);
      summary.transactions.push({
        meta: {
          type: "transaction",
          seq: meta.seq,
          frame: meta.frame,
          encoding: meta.encoding,
          base_seq: meta.base_seq,
          status: meta.status,
          failures: arr<WireFailure>(meta.failures),
          unsupported: arr<WireUnsupported>(meta.unsupported),
          items: sortedResolvedItems(state),
          canvases: sortedResolvedCanvases(state),
        },
        wire: meta,
        bytes: record.byte_length,
        sha256: record.sha256,
      });
    } else if (meta.type === "end") {
      summary.end = meta as EndMeta;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Draw-index ties (render-stream-1.md "Invariant 9") and whether one can change a pixel
// ---------------------------------------------------------------------------------------------

/** One tie group: siblings of one container sharing a draw_index, at least two of them drawing
 * (non-empty `commands` or non-empty `children`, exactly as invariant 9 defines it). */
export interface DrawIndexTie {
  seq: number;
  frame: number;
  /** "canvas:<id>" or "item:<id>" */
  container: string;
  draw_index: number;
  /** the drawing members, ascending id; the wire entry names members[0] */
  members: number[];
  /** each member's conservative paint footprint [x0, y0, x1, y1] in its container's space
   * ([0,0,0,0] when it draws nothing), or null when unbounded (an unsupported command in its
   * subtree) */
  footprints: ([number, number, number, number] | null)[];
  /** every pair of footprints is disjoint: every order of the group paints the same pixels */
  harmless: boolean;
}

type Affine = [number, number, number, number, number, number];

function mulAffine(a: readonly number[], b: readonly number[]): Affine {
  // Godot Transform2D columns (x.x, x.y, y.x, y.y, o.x, o.y); a * b applies b first.
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * The pixels member `id`'s subtree can touch, in its container's space: the axis-aligned bounds
 * of every add_rect of every item in the subtree the engine would draw (an invisible item, or one
 * outside the cull mask, is skipped with its subtree: renderer_canvas_cull.cpp:296-302), each
 * rect's four corners mapped through the transforms from the member down, grown by one pixel for
 * antialiasing and rounding. Clip only ever shrinks what is drawn, so it is ignored, and the
 * members share every transform above their container. "empty" when nothing is drawn; null
 * (unbounded) when the subtree holds an unsupported command.
 */
function subtreeFootprint(
  items: ReadonlyMap<number, ResolvedItem>,
  id: number,
  cullMask: number,
): [number, number, number, number] | null | "empty" {
  let box: [number, number, number, number] | undefined;
  let unbounded = false;
  const visit = (itemId: number, parent: Affine, depth: number): void => {
    const it = items.get(itemId);
    if (!it || depth > 4096) return;
    if (!it.visible || (it.visibility_layer & cullMask) >>> 0 === 0) return;
    const xform = mulAffine(parent, it.xform);
    for (const c of it.commands) {
      if (c.op !== "add_rect" || !c.rect) {
        unbounded = true;
        continue;
      }
      const [x, y, w, h] = c.rect;
      const corners: [number, number][] = [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ];
      for (const [px, py] of corners) {
        const qx = xform[0] * px + xform[2] * py + xform[4];
        const qy = xform[1] * px + xform[3] * py + xform[5];
        box = box
          ? [
              Math.min(box[0], qx),
              Math.min(box[1], qy),
              Math.max(box[2], qx),
              Math.max(box[3], qy),
            ]
          : [qx, qy, qx, qy];
      }
    }
    for (const child of it.children) visit(child, xform, depth + 1);
  };
  visit(id, [1, 0, 0, 1, 0, 0], 0);
  if (unbounded) return null;
  if (!box) return "empty";
  return [
    Math.floor(box[0]) - 1,
    Math.floor(box[1]) - 1,
    Math.ceil(box[2]) + 1,
    Math.ceil(box[3]) + 1,
  ];
}

/** Every invariant-9 tie group of one resolved transaction, with its footprint analysis. */
export function drawIndexTies(
  t: Pick<TransactionMeta, "seq" | "frame" | "items" | "canvases">,
  cullMask = 0xffffffff,
): DrawIndexTie[] {
  const items = new Map(t.items.map((i) => [i.id, i] as const));
  const containers: [string, number[]][] = [
    ...t.canvases.map((c) => [`canvas:${c.id}`, c.items] as [string, number[]]),
    ...t.items.map((i) => [`item:${i.id}`, i.children] as [string, number[]]),
  ];
  const out: DrawIndexTie[] = [];
  for (const [container, children] of containers) {
    const groups = new Map<number, number[]>();
    for (const child of children) {
      const it = items.get(child);
      if (!it || (it.commands.length === 0 && it.children.length === 0))
        continue;
      const list = groups.get(it.draw_index) ?? [];
      list.push(child);
      groups.set(it.draw_index, list);
    }
    for (const [drawIndex, group] of groups) {
      if (group.length < 2) continue;
      const members = [...group].sort((a, b) => a - b);
      const raw = members.map((m) => subtreeFootprint(items, m, cullMask));
      const boxes = raw.filter((f) => f !== "empty");
      let harmless = !boxes.includes(null);
      for (let i = 0; harmless && i < boxes.length; i++) {
        for (let j = i + 1; harmless && j < boxes.length; j++) {
          const a = boxes[i] as number[];
          const b = boxes[j] as number[];
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3])
            harmless = false;
        }
      }
      out.push({
        seq: t.seq,
        frame: t.frame,
        container,
        draw_index: drawIndex,
        members,
        footprints: raw.map((f) => (f === "empty" ? [0, 0, 0, 0] : f)),
        harmless,
      });
    }
  }
  return out;
}

/** "<seq>:<item>" keys of the draw-index-tie entries whose tie is harmless (every member's paint
 * footprint disjoint from every other's). Classification ignores exactly these entries: the entry
 * stays on the wire and in applied.json, but no order of the group can change a pixel, so the
 * receiver cannot draw that frame differently from the engine. Every other tie is `unsupported`
 * (gate1-design.md D7, as amended by G1b2). */
export function harmlessTieKeys(
  transactions: readonly Pick<Transaction, "meta">[],
  cullMask = 0xffffffff,
): Set<string> {
  const keys = new Set<string>();
  for (const t of transactions) {
    for (const tie of drawIndexTies(t.meta, cullMask)) {
      if (tie.harmless) keys.add(`${tie.seq}:${tie.members[0]}`);
    }
  }
  return keys;
}

/** `RS_FIXTURE_STEP_LOG` JSONL; undefined when missing, empty or not one object per line. */
export function parseStepLog(text: string | undefined): StepLine[] | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return undefined;
  try {
    return lines.map((line) => {
      const value = JSON.parse(line) as Partial<StepLine>;
      if (
        !Number.isInteger(value.step) ||
        !Number.isInteger(value.applied_frame) ||
        !Number.isInteger(value.settle_frame)
      ) {
        throw new Error(`bad step line: ${line}`);
      }
      return value as StepLine;
    });
  } catch {
    return undefined;
  }
}

/** Each step's settle frame joined to the transaction published at that frame. */
export function joinSettleSeqs(
  steps: StepLine[] | undefined,
  transactions: readonly Transaction[],
): StepJoin {
  if (!steps) {
    return {
      ok: false,
      entries: [],
      problems: ["steps.jsonl missing or unparseable"],
    };
  }
  const byFrame = new Map(transactions.map((t) => [t.meta.frame, t.meta.seq]));
  const entries = steps.map((s) => ({
    step: s.step,
    settle_frame: s.settle_frame,
    seq: byFrame.get(s.settle_frame) ?? null,
  }));
  const problems = entries
    .filter((e) => e.seq === null)
    .map((e) => `step ${e.step}: no transaction has frame ${e.settle_frame}`);
  return { ok: problems.length === 0, entries, problems };
}

/** The first transaction holding an add_rect whose colour equals `color` as float32. */
export function firstTransactionWithRectColor(
  transactions: readonly Transaction[],
  color: readonly number[],
): Transaction | undefined {
  const want = color.map((c) => Math.fround(c));
  return transactions.find((t) =>
    t.meta.items.some((item) =>
      item.commands.some(
        (c) => c.op === "add_rect" && want.every((v, i) => c.color?.[i] === v),
      ),
    ),
  );
}

/** Exact per-pixel comparison of two RGBA8 buffers, optionally inside rect [x, y, w, h]. */
export function diffRgba(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  rect?: readonly number[],
): { mismatched_pixels: number; max_channel_delta: number } {
  const [x0, y0, w, h] = rect ?? [0, 0, width, height];
  let mismatched = 0;
  let maxDelta = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4;
      let differs = false;
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(a[i + c] - b[i + c]);
        if (d > 0) differs = true;
        if (d > maxDelta) maxDelta = d;
      }
      if (differs) mismatched++;
    }
  }
  return { mismatched_pixels: mismatched, max_channel_delta: maxDelta };
}

/** A copy of `data` with the first meta byte of transaction `seq` set to 0x00 (the `corrupt`
 * leg). Throws if the recording has no such transaction. */
export function corruptTransactionMeta(
  data: Uint8Array,
  seq: number,
): Uint8Array {
  const split = splitRecords(data);
  if (split.errors.length > 0) {
    throw new Error(
      `cannot corrupt a recording that does not frame: ${split.errors.join("; ")}`,
    );
  }
  for (const raw of split.records) {
    const { record } = decodeRecord(raw);
    const meta = record?.meta as unknown as
      | { type?: string; seq?: number }
      | undefined;
    if (meta?.type === "transaction" && meta.seq === seq) {
      const out = new Uint8Array(data);
      out[raw.offset + 8] = 0x00;
      return out;
    }
  }
  throw new Error(`recording has no transaction seq ${seq}`);
}

function checkpointMismatch(c: Checkpoint): boolean {
  const bad = (n: number | null): boolean => n === null || n > 0;
  return (
    bad(c.mismatched_pixels) ||
    bad(c.max_channel_delta) ||
    c.regions.some((r) => bad(r.mismatched_pixels) || bad(r.max_channel_delta))
  );
}

// ---------------------------------------------------------------------------------------------
// classifyLeg (pure)
// ---------------------------------------------------------------------------------------------

export interface ClassifyInput {
  /** the capture host's evidence/result.json */
  captureResult: CaptureResultJson | undefined;
  /** the host-side recording (for `corrupt`, the uncorrupted capture recording) */
  recording: Pick<RecordingSummary, "present" | "errors" | "transactions"> & {
    session?: SessionMeta;
  };
  /** present for legs whose receiver takes settle-step shots */
  stepJoin?: StepJoin;
  /** absent for legs without a receiver (`capture`, `preexisting`): rules 3 and 4 are skipped */
  receiver?: {
    /** undefined when applied.json is missing or does not parse */
    applied: AppliedJson | undefined;
    requestedShotSeqs: number[];
    /** seqs whose shots/seq-<n>.png exists */
    shotFiles: number[];
  };
  checkpoints: Checkpoint[];
}

export interface Classification {
  result_class: LegClass;
  reasons: string[];
  mismatching_steps: number[];
  /** "<seq>:<item>" of every declared draw-index tie judged harmless (not a reason) */
  harmless_ties: string[];
}

export function classifyLeg(input: ClassifyInput): Classification {
  const fired = new Map<LegClass, string[]>();
  const fire = (cls: LegClass, reason: string): void => {
    const list = fired.get(cls) ?? [];
    list.push(`${cls}: ${reason}`);
    fired.set(cls, list);
  };

  // 1. capture-failure
  const result = input.captureResult;
  if (result?.status !== "armed") {
    fire(
      "capture-failure",
      `capture result.json status=${JSON.stringify(result?.status)}, expected "armed"`,
    );
  }
  if (result?.stream?.status !== "closed") {
    fire(
      "capture-failure",
      `stream.status=${JSON.stringify(result?.stream?.status)}${result?.stream?.reason ? ` (${result.stream.reason})` : ""}, expected "closed"`,
    );
  }
  const rec = input.recording;
  if (!rec.present) {
    fire("capture-failure", "recording missing");
  } else if (rec.errors.length > 0) {
    fire(
      "capture-failure",
      `validateRecording: ${rec.errors.slice(0, 3).join(" | ")}${rec.errors.length > 3 ? ` (+${rec.errors.length - 3} more)` : ""}`,
    );
  }
  const failures = new Map<string, { first: number; count: number }>();
  for (const t of rec.transactions) {
    if (t.meta.status === "capture-failure" || t.meta.failures.length > 0) {
      const list =
        t.meta.failures.length > 0
          ? t.meta.failures
          : [{ reason: "status", detail: "capture-failure without failures" }];
      for (const f of list) {
        const key = `${f.reason}: ${f.detail}`;
        const seen = failures.get(key);
        if (seen) seen.count++;
        else failures.set(key, { first: t.meta.seq, count: 1 });
      }
    }
  }
  for (const [key, { first, count }] of failures) {
    fire(
      "capture-failure",
      `transaction failure ${key} (first seq ${first}, ${count} transactions)`,
    );
  }
  if (input.stepJoin && !input.stepJoin.ok) {
    fire(
      "capture-failure",
      `step-join-failed: ${input.stepJoin.problems.join("; ")}`,
    );
  }

  // 2. unsupported. A draw-index-tie entry whose tied members paint disjoint pixels is declared
  // but harmless (harmlessTieKeys): it never makes the leg unsupported. Every other entry does.
  const cullMask = Number(
    rec.session?.viewport?.canvas_cull_mask ?? 0xffffffff,
  );
  const harmless = harmlessTieKeys(rec.transactions, cullMask);
  const isHarmlessTie = (
    seq: unknown,
    u: { item?: unknown; reason?: unknown },
  ) => u.reason === "draw-index-tie" && harmless.has(`${seq}:${u.item}`);
  const unsupportedOps = new Set<string>();
  const harmlessTies = new Set<string>();
  for (const t of rec.transactions) {
    for (const u of t.meta.unsupported) {
      if (isHarmlessTie(t.meta.seq, u))
        harmlessTies.add(`${t.meta.seq}:${u.item}`);
      else unsupportedOps.add(`${u.op}/${u.reason}`);
    }
    for (const item of t.meta.items) {
      for (const c of item.commands) {
        if (c.op === "unsupported") unsupportedOps.add(`${c.name}/command`);
      }
    }
  }
  if (unsupportedOps.size > 0) {
    fire(
      "unsupported",
      `recording carries unsupported ${[...unsupportedOps].sort().join(", ")}`,
    );
  }
  const receiver = input.receiver;
  const applied = receiver?.applied;
  const appliedUnsupported = arr<{
    seq?: number;
    item?: number | null;
    name?: string;
    reason?: string;
  }>(applied?.unsupported).filter((u) => !isHarmlessTie(u.seq, u));
  if (applied && appliedUnsupported.length > 0) {
    fire(
      "unsupported",
      `applied.json unsupported: ${appliedUnsupported.map((u) => u.name).join(", ")}`,
    );
  }

  const mismatchingSteps: number[] = [];
  if (receiver) {
    // 3. replay-failure
    if (!applied) {
      fire("replay-failure", "applied.json missing or unparseable");
    } else {
      if (applied.status !== "ok") {
        fire(
          "replay-failure",
          `status=${JSON.stringify(applied.status)} failure=${JSON.stringify(applied.failure ?? null)}`,
        );
      }
      if (applied.end_seen !== true)
        fire("replay-failure", "end_seen is not true");
      const host = rec.transactions;
      const appliedTx = arr<{ seq?: number; record_sha256?: string }>(
        applied.transactions,
      );
      const seqsOk =
        appliedTx.length === host.length &&
        appliedTx.every((t, i) => t.seq === i + 1);
      if (!seqsOk) {
        fire(
          "replay-failure",
          `applied seqs are not exactly 1..${host.length} (got ${appliedTx.length} entries${appliedTx.length > 0 ? `, ${appliedTx[0].seq}..${appliedTx[appliedTx.length - 1].seq}` : ""})`,
        );
      }
      const shaMismatch = appliedTx.findIndex(
        (t, i) => host[i] !== undefined && t.record_sha256 !== host[i].sha256,
      );
      if (shaMismatch >= 0) {
        fire(
          "replay-failure",
          `record_sha256 differs from the host's at applied index ${shaMismatch} (seq ${appliedTx[shaMismatch].seq})`,
        );
      }
      const shotEntries = new Set(
        arr<{ seq?: number }>(applied.shots).map((s) => s.seq),
      );
      const files = new Set(receiver.shotFiles);
      const missing = receiver.requestedShotSeqs.filter(
        (s) => !shotEntries.has(s) || !files.has(s),
      );
      if (missing.length > 0)
        fire(
          "replay-failure",
          `requested shot(s) missing: seq ${missing.join(", ")}`,
        );
    }

    // 4. pixel-mismatch
    for (const c of input.checkpoints) {
      if (checkpointMismatch(c)) {
        mismatchingSteps.push(c.step);
        fire(
          "pixel-mismatch",
          `step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "unreadable"} mismatched pixels, max channel delta ${c.max_channel_delta ?? "?"}; ${c.regions
            .map((r) => `${r.name} ${r.mismatched_pixels ?? "?"}`)
            .join(", ")}`,
        );
      }
    }
  }

  const resultClass =
    CLASS_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  const reasons = CLASS_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []);
  return {
    result_class: resultClass,
    reasons,
    mismatching_steps: mismatchingSteps,
    harmless_ties: [...harmlessTies],
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence loading
// ---------------------------------------------------------------------------------------------

async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

export async function loadRecording(path: string): Promise<RecordingSummary> {
  return summarizeRecording(path, await readBytes(path));
}

export async function readExitCode(dir: string): Promise<number | null> {
  const text = (await readTextOrUndefined(join(dir, "exit-code.txt")))?.trim();
  if (text === undefined || text === "" || !/^-?\d+$/.test(text)) return null;
  return Number(text);
}

/** First non-zero exit code among the process directories, else 0; null when none recorded. */
async function combinedExitCode(dirs: string[]): Promise<number | null> {
  const codes = await Promise.all(dirs.map(readExitCode));
  const known = codes.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.find((c) => c !== 0) ?? 0;
}

async function existing(paths: string[]): Promise<string[]> {
  const flags = await Promise.all(paths.map(fileExists));
  return paths.filter((_, i) => flags[i]);
}

async function shotSeqsPresent(receiverDir: string): Promise<number[]> {
  try {
    const names = await readdir(join(receiverDir, "shots"));
    return names
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** Receiver shot vs the reference shot of the same step: full frame and the two rect regions.
 * The full-frame diff image goes to diffDir/step-<k>.png (compareRgbaBuffers, exact budgets). */
export async function computeCheckpoints(
  join_: StepJoin,
  referenceShotsDir: string,
  receiverShotsDir: string,
  diffDir: string,
  expected: Gate0Expected,
): Promise<{ checkpoints: Checkpoint[]; compareOk: boolean }> {
  const checkpoints: Checkpoint[] = [];
  let compareOk = true;
  for (const entry of join_.entries) {
    const exp = expected.steps.find((s) => s.step === entry.step);
    const referencePng = join(referenceShotsDir, `step-${entry.step}.png`);
    const receiverPng =
      entry.seq === null
        ? null
        : join(receiverShotsDir, `seq-${entry.seq}.png`);
    const regionsSpec: { name: "subject" | "marker"; rect_px: number[] }[] = exp
      ? [
          { name: "subject", rect_px: [...exp.subject.rect_px] },
          { name: "marker", rect_px: [...exp.marker.rect_px] },
        ]
      : [];
    const ref = await decodePngRgba(referencePng);
    const got = receiverPng ? await decodePngRgba(receiverPng) : undefined;
    const comparable =
      ref !== undefined &&
      got !== undefined &&
      ref.width === got.width &&
      ref.height === got.height;
    if (!comparable) {
      compareOk = false;
      checkpoints.push({
        step: entry.step,
        settle_frame: entry.settle_frame,
        seq: entry.seq,
        reference_png: referencePng,
        receiver_png: receiverPng,
        diff_png: null,
        mismatched_pixels: null,
        max_channel_delta: null,
        regions: regionsSpec.map((r) => ({
          ...r,
          mismatched_pixels: null,
          max_channel_delta: null,
        })),
      });
      continue;
    }
    const full = diffRgba(ref.data, got.data, ref.width, ref.height);
    const diffPng = join(diffDir, `step-${entry.step}.png`);
    await mkdir(diffDir, { recursive: true });
    const verdict = await compareRgbaBuffers(ref.data, got.data, {
      width: ref.width,
      height: ref.height,
      threshold: 0,
      maxDiffRatio: 0,
      maxChannelDelta: 0,
      diffPath: diffPng,
    });
    if (!verdict.ok) compareOk = false;
    checkpoints.push({
      step: entry.step,
      settle_frame: entry.settle_frame,
      seq: entry.seq,
      reference_png: referencePng,
      receiver_png: receiverPng,
      diff_png: diffPng,
      ...full,
      regions: regionsSpec.map((r) => ({
        ...r,
        ...diffRgba(ref.data, got.data, ref.width, ref.height, r.rect_px),
      })),
    });
  }
  return { checkpoints, compareOk };
}

export interface LegEvaluation {
  leg: ClassifiedLeg;
  layout: LegLayout;
  expected_class: LegClass;
  classification: Classification;
  exit_code: number | null;
  artifacts: string[];
  recording: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
  stepJoin?: StepJoin;
  applied?: AppliedJson;
  checkpoints: Checkpoint[];
  compareOk: boolean;
}

export async function evaluateLeg(
  outDir: string,
  leg: ClassifiedLeg,
  expected: Gate0Expected,
): Promise<LegEvaluation> {
  const layout = legLayout(outDir, leg);
  const captureResult = await readJson<CaptureResultJson>(
    join(layout.captureDir, "evidence", "result.json"),
  );
  const recording = await loadRecording(
    join(layout.captureDir, RECORDING_NAME),
  );
  let stepJoin: StepJoin | undefined;
  if (layout.shots) {
    stepJoin = joinSettleSeqs(
      parseStepLog(
        await readTextOrUndefined(join(layout.captureDir, "steps.jsonl")),
      ),
      recording.transactions,
    );
  }
  let applied: AppliedJson | undefined;
  let receiverInput: ClassifyInput["receiver"];
  let checkpoints: Checkpoint[] = [];
  let compareOk = true;
  if (layout.receiverDir) {
    applied = await readJson<AppliedJson>(
      join(layout.receiverDir, "applied.json"),
    );
    if (
      applied !== undefined &&
      (applied === null || typeof applied !== "object")
    ) {
      applied = undefined;
    }
    const requested =
      stepJoin?.entries
        .map((e) => e.seq)
        .filter((s): s is number => s !== null) ?? [];
    receiverInput = {
      applied,
      requestedShotSeqs: requested,
      shotFiles: await shotSeqsPresent(layout.receiverDir),
    };
    if (stepJoin?.ok) {
      ({ checkpoints, compareOk } = await computeCheckpoints(
        stepJoin,
        join(outDir, "reference", "shots"),
        join(layout.receiverDir, "shots"),
        join(layout.receiverDir, "diff"),
        expected,
      ));
    }
  }
  const classification = classifyLeg({
    captureResult,
    recording,
    stepJoin,
    receiver: receiverInput,
    checkpoints,
  });
  const processDirs = [
    layout.captureDir,
    ...(layout.receiverDir ? [layout.receiverDir] : []),
  ];
  const exitCode = layout.receiverDir
    ? await readExitCode(layout.receiverDir)
    : await readExitCode(layout.captureDir);
  const artifacts = await existing(
    processDirs.flatMap((dir) => [
      join(dir, "argv.txt"),
      join(dir, "env.txt"),
      join(dir, "stdout.log"),
      join(dir, "exit-code.txt"),
      join(dir, "evidence", "result.json"),
      join(dir, RECORDING_NAME),
      join(dir, "steps.jsonl"),
      join(dir, "applied.json"),
      join(dir, "strace.txt"),
    ]),
  );
  return {
    leg,
    layout,
    expected_class: LEG_EXPECTATIONS[leg].class,
    classification,
    exit_code: exitCode,
    artifacts: [...new Set(artifacts)],
    recording,
    captureResult,
    stepJoin,
    applied,
    checkpoints,
    compareOk,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate0Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

export async function checkCaptureArmed(
  outDir: string,
  capture: Pick<LegEvaluation, "captureResult" | "recording">,
): Promise<Gate0Check> {
  const resultPath = join(outDir, "capture", "evidence", "result.json");
  const countersPath = join(outDir, "capture", "evidence", "counters.json");
  const counters = await readJson<CountersJson>(countersPath);
  const result = capture.captureResult;
  const session = capture.recording.session;
  const problems: string[] = [];
  if (result?.status !== "armed")
    problems.push(`result.json status=${JSON.stringify(result?.status)}`);
  if (result?.stream?.status !== "closed") {
    problems.push(`stream.status=${JSON.stringify(result?.stream?.status)}`);
  }
  if (!counters) {
    problems.push("counters.json missing or unparseable");
  } else {
    if (
      !Array.isArray(counters.hooks_omitted) ||
      counters.hooks_omitted.length > 0
    ) {
      problems.push(
        `counters.json hooks_omitted=${JSON.stringify(counters.hooks_omitted)}`,
      );
    }
    if (
      !sameStrings([...arr<string>(counters.hooks_planned)].sort(), GATE0_HOOKS)
    ) {
      problems.push(
        `counters.json hooks_planned is not the ${GATE0_HOOKS.length} gate 0 hooks`,
      );
    }
  }
  if (!session) {
    problems.push("recording has no session record");
  } else {
    const omitted = session.capture?.hooks_omitted;
    if (!Array.isArray(omitted) || omitted.length > 0) {
      problems.push(`session capture.hooks_omitted=${JSON.stringify(omitted)}`);
    }
    if (!sameStrings(session.capture?.hooks_planned, GATE0_HOOKS)) {
      const planned = arr<string>(session.capture?.hooks_planned);
      const missing = GATE0_HOOKS.filter((h) => !planned.includes(h));
      const extra = planned.filter((h) => !GATE0_HOOKS.includes(h));
      problems.push(
        `session capture.hooks_planned is not exactly the ${GATE0_HOOKS.length} names (missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)})`,
      );
    }
  }
  return check(
    "capture-armed",
    `the capture leg armed with stream.status closed, no hook omitted (counters.json and session), and hooks_planned is exactly the ${GATE0_HOOKS.length} hooks named by the committed record`,
    problems,
    `armed, stream closed, ${GATE0_HOOKS.length} hooks planned, none omitted`,
    [resultPath, countersPath, capture.recording.path],
  );
}

export async function checkHeadlessNoGpuGate0(
  outDir: string,
): Promise<Gate0Check> {
  const c = await checkHeadlessNoGpu(outDir, "capture");
  return {
    id: "headless-no-gpu",
    criterion: c.description,
    passed: c.status === "pass",
    detail:
      c.status === "unavailable"
        ? `unavailable: ${c.detail ?? ""}`
        : (c.detail ?? ""),
    evidence: c.evidence.split(", "),
  };
}

export function checkRecordingDecodes(recording: RecordingSummary): Gate0Check {
  const problems: string[] = [];
  if (!recording.present) problems.push(`capture/${RECORDING_NAME} missing`);
  if (recording.errors.length > 0 && recording.present) {
    problems.push(
      `validateRecording: ${recording.errors.slice(0, 5).join(" | ")}`,
    );
  }
  const first = recording.transactions[0];
  if (first?.meta.frame !== 1)
    problems.push(
      `first transaction frame=${first?.meta.frame ?? "<none>"}, expected 1`,
    );
  if (recording.end?.transactions !== CAPTURE_QUIT_FRAME) {
    problems.push(
      `end.transactions=${recording.end?.transactions ?? "<none>"}, expected ${CAPTURE_QUIT_FRAME}`,
    );
  }
  if (recording.transactions.length !== CAPTURE_QUIT_FRAME) {
    problems.push(
      `decoded ${recording.transactions.length} transactions, expected ${CAPTURE_QUIT_FRAME}`,
    );
  }
  return check(
    "recording-decodes",
    `validateRecording(capture recording) is [] (seqs, frames, ids, parents, block lengths); the first transaction has frame 1 and there are ${CAPTURE_QUIT_FRAME} transactions`,
    problems,
    `${recording.transactions.length} transactions, ${recording.bytes} bytes, valid`,
    [recording.path],
  );
}

export function checkManifestPresent(recording: RecordingSummary): Gate0Check {
  const s = recording.session;
  const problems: string[] = [];
  if (!s) {
    problems.push("no session record");
  } else {
    if (s.protocol !== "render-stream/1")
      problems.push(`protocol=${JSON.stringify(s.protocol)}`);
    const features = (s.features ?? {}) as Record<string, unknown>;
    for (const [key, want] of Object.entries(RS1_FEATURES)) {
      const got = features[key];
      const ok =
        typeof want === "string"
          ? got === want
          : sameStrings(got as unknown[] | undefined, want);
      if (!ok) problems.push(`features.${key}=${JSON.stringify(got)}`);
    }
    const extraKeys = Object.keys(features).filter((k) => !(k in RS1_FEATURES));
    if (extraKeys.length > 0)
      problems.push(`features has extra keys ${JSON.stringify(extraKeys)}`);
    if (s.engine?.display_server !== "headless") {
      problems.push(
        `engine.display_server=${JSON.stringify(s.engine?.display_server)}`,
      );
    }
    if (s.stream?.transport !== "file" || s.stream?.encoding !== "full")
      problems.push(
        `stream=${JSON.stringify(s.stream ?? null)}, expected a file stream with encoding full`,
      );
    const vp = s.viewport;
    if (vp?.root_canvas !== 1)
      problems.push(`viewport.root_canvas=${JSON.stringify(vp?.root_canvas)}`);
    if (vp?.host_size_status !== "match")
      problems.push(
        `viewport.host_size_status=${JSON.stringify(vp?.host_size_status)}, expected "match"`,
      );
    if (vp?.root_size_policy !== "enforce-min-size")
      problems.push(
        `viewport.root_size_policy=${JSON.stringify(vp?.root_size_policy)}, expected "enforce-min-size"`,
      );
    if (
      JSON.stringify(vp?.logical_size) !== "[640,360]" ||
      JSON.stringify(vp?.host_window_size) !== "[640,360]"
    )
      problems.push(
        `viewport.logical_size=${JSON.stringify(vp?.logical_size)} host_window_size=${JSON.stringify(vp?.host_window_size)}, expected 640x360 both`,
      );
    if (vp?.stretch_applied_by !== "receiver")
      problems.push(
        `viewport.stretch_applied_by=${JSON.stringify(vp?.stretch_applied_by)}`,
      );
    if (s.sabotage !== null)
      problems.push(`sabotage=${JSON.stringify(s.sabotage)}, expected null`);
  }
  return check(
    "manifest-present",
    "the capture session carries protocol render-stream/1, a full file stream, the exact /1 features, engine.display_server headless, viewport.root_canvas 1, root_size_policy enforce-min-size with host_size_status match and a 640x360 logical and host window size, stretch applied by the receiver, and sabotage null",
    problems,
    "session manifest as specified",
    [recording.path],
  );
}

export async function checkStepAlignment(
  outDir: string,
  expected: Gate0Expected,
  recording: RecordingSummary,
): Promise<Gate0Check> {
  const capturePath = join(outDir, "capture", "steps.jsonl");
  const referencePath = join(outDir, "reference", "steps.jsonl");
  const captureSteps = parseStepLog(await readTextOrUndefined(capturePath));
  const referenceSteps = parseStepLog(await readTextOrUndefined(referencePath));
  const want = expected.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  const problems: string[] = [];
  const same = (got: StepLine[] | undefined): boolean =>
    got !== undefined &&
    got.length === want.length &&
    got.every(
      (g, i) =>
        g.step === want[i].step &&
        g.applied_frame === want[i].applied_frame &&
        g.settle_frame === want[i].settle_frame,
    );
  if (!same(captureSteps))
    problems.push(
      `capture steps.jsonl ${JSON.stringify(captureSteps)} != expected ${JSON.stringify(want)}`,
    );
  if (!same(referenceSteps))
    problems.push(
      `reference steps.jsonl ${JSON.stringify(referenceSteps)} != expected`,
    );
  const firsts: string[] = [];
  for (const s of expected.steps) {
    const t = firstTransactionWithRectColor(
      recording.transactions,
      s.marker.color,
    );
    firsts.push(`${s.step}@${t?.meta.frame ?? "none"}`);
    if (t?.meta.frame !== s.applied_frame) {
      problems.push(
        `step ${s.step}: first transaction with the marker colour has frame ${t?.meta.frame ?? "<none>"}, expected ${s.applied_frame}`,
      );
    }
  }
  return check(
    "step-alignment",
    "capture and reference steps.jsonl list steps 0..4 at the expected.json frames, and each step's marker colour first appears in the transaction of its applied frame",
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [capturePath, referencePath, recording.path],
  );
}

async function compareWithExpected(
  pngPath: string | null,
  expected: Gate0Expected,
  step: number,
): Promise<string | undefined> {
  if (!pngPath) return `step ${step}: no shot`;
  const got = await decodePngRgba(pngPath);
  if (!got) return `step ${step}: ${pngPath} missing or unreadable`;
  const want = synthesizeExpected(expected, step);
  if (got.width !== want.width || got.height !== want.height) {
    return `step ${step}: ${got.width}x${got.height}, expected ${want.width}x${want.height}`;
  }
  const d = diffRgba(want.rgba, got.data, want.width, want.height);
  if (d.mismatched_pixels > 0) {
    return `step ${step}: ${d.mismatched_pixels} pixels differ from synthesizeExpected (max channel delta ${d.max_channel_delta})`;
  }
  return undefined;
}

export async function checkExpectedImageReference(
  outDir: string,
  expected: Gate0Expected,
): Promise<Gate0Check> {
  const paths = expected.steps.map((s) =>
    join(outDir, "reference", "shots", `step-${s.step}.png`),
  );
  const problems = (
    await Promise.all(
      expected.steps.map((s, i) =>
        compareWithExpected(paths[i], expected, s.step),
      ),
    )
  ).filter((p): p is string => p !== undefined);
  return check(
    "expected-image-reference",
    "each reference/shots/step-<k>.png equals synthesizeExpected(k) exactly (640x360 RGBA, alpha 255)",
    problems,
    `${paths.length} reference shots match exactly`,
    paths,
  );
}

export async function checkExpectedImageReceiver(
  receiver: LegEvaluation,
  expected: Gate0Expected,
): Promise<Gate0Check> {
  const shotsDir = join(
    receiver.layout.receiverDir ?? receiver.layout.legDir,
    "shots",
  );
  const join_ = receiver.stepJoin;
  const problems: string[] = [];
  const paths: string[] = [];
  if (!join_?.ok)
    problems.push(
      `step join failed: ${join_?.problems.join("; ") ?? "no join"}`,
    );
  for (const s of expected.steps) {
    const seq = join_?.entries.find((e) => e.step === s.step)?.seq ?? null;
    const path = seq === null ? null : join(shotsDir, `seq-${seq}.png`);
    if (path) paths.push(path);
    const problem = await compareWithExpected(path, expected, s.step);
    if (problem) problems.push(problem);
  }
  return check(
    "expected-image-receiver",
    "each receiver shot for step k (the transaction at its settle frame) equals synthesizeExpected(k) exactly",
    problems,
    `${paths.length} receiver shots match exactly`,
    paths,
  );
}

export function checkReceiverVsReference(
  receiver: LegEvaluation,
  expected: Gate0Expected,
): Gate0Check {
  const problems: string[] = [];
  if (!receiver.stepJoin?.ok) problems.push("step join failed: no checkpoints");
  if (receiver.checkpoints.length !== expected.steps.length) {
    problems.push(
      `${receiver.checkpoints.length} checkpoints, expected ${expected.steps.length}`,
    );
  }
  for (const c of receiver.checkpoints) {
    if (checkpointMismatch(c)) {
      problems.push(
        `step ${c.step}: full ${c.mismatched_pixels ?? "unreadable"} px (max delta ${c.max_channel_delta ?? "?"}), ${c.regions.map((r) => `${r.name} ${r.mismatched_pixels ?? "?"} px`).join(", ")}`,
      );
    }
  }
  if (!receiver.compareOk && problems.length === 0)
    problems.push("compareRgbaBuffers reported a difference");
  return check(
    "receiver-vs-reference",
    "receiver shots equal the reference shots at every step: full frame and the subject and marker regions, 0 mismatched pixels and max channel delta 0",
    problems,
    `${receiver.checkpoints.length} checkpoints identical`,
    receiver.checkpoints.flatMap((c) => [
      c.reference_png,
      ...(c.receiver_png ? [c.receiver_png] : []),
    ]),
  );
}

export function checkReceiverConsumedStream(
  receiver: LegEvaluation,
): Gate0Check {
  const dir = receiver.layout.receiverDir ?? receiver.layout.legDir;
  const appliedPath = join(dir, "applied.json");
  const applied = receiver.applied;
  const host = receiver.recording;
  const problems: string[] = [];
  if (!applied) {
    problems.push("applied.json missing or unparseable");
  } else {
    if (applied.status !== "ok")
      problems.push(`status=${JSON.stringify(applied.status)}`);
    if (applied.end_seen !== true) problems.push("end_seen is not true");
    const tx = arr<{ seq?: number; record_sha256?: string }>(
      applied.transactions,
    );
    if (host.transactions.length === 0)
      problems.push("host recording has no transactions");
    if (tx.length !== host.transactions.length) {
      problems.push(
        `applied ${tx.length} transactions, host published ${host.transactions.length}`,
      );
    }
    const badSeq = tx.findIndex((t, i) => t.seq !== i + 1);
    if (badSeq >= 0)
      problems.push(
        `applied index ${badSeq} has seq ${tx[badSeq].seq}, expected ${badSeq + 1}`,
      );
    const badSha = tx.findIndex(
      (t, i) => t.record_sha256 !== host.transactions[i]?.sha256,
    );
    if (badSha >= 0)
      problems.push(
        `applied seq ${tx[badSha].seq} record_sha256 differs from the host-computed hash`,
      );
    const shots = arr<{ seq?: number; applied_through?: number }>(
      applied.shots,
    );
    if (shots.length === 0) problems.push("no shots recorded");
    for (const s of shots) {
      if (s.applied_through !== s.seq)
        problems.push(`shot seq ${s.seq} applied_through=${s.applied_through}`);
    }
    if (applied.recording?.sha256 !== host.sha256) {
      problems.push(
        `recording.sha256=${applied.recording?.sha256 ?? "<none>"} != capture file ${host.sha256 ?? "<missing>"}`,
      );
    }
  }
  return check(
    "receiver-consumed-stream",
    "the receiver applied seqs 1..N with each record_sha256 equal to the host-computed hash, every shot has applied_through == seq, and recording.sha256 is the capture file's",
    problems,
    `${host.transactions.length} transactions consumed in order, hashes match`,
    [appliedPath, host.path],
  );
}

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".godot") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await walk(root);
  return out;
}

async function fileSha(path: string): Promise<string | undefined> {
  const bytes = await readBytes(path);
  return bytes ? sha256Hex(bytes) : undefined;
}

/** Every receiver-side process log the runner writes (missing ones are skipped). */
export function receiverLogPaths(outDir: string): string[] {
  return [
    join(outDir, "receiver", "stdout.log"),
    join(outDir, "receiver-headless-trace", "stdout.log"),
    join(outDir, "sabotage-freeze", "receiver", "stdout.log"),
    join(outDir, "sabotage-omit", "receiver", "stdout.log"),
    join(outDir, "sabotage-perturb", "receiver", "stdout.log"),
    join(outDir, "unsupported", "receiver", "stdout.log"),
    join(outDir, "corrupt", "stdout.log"),
    join(outDir, "receiver-typecheck", "selftest", "stdout.log"),
    join(outDir, "receiver-typecheck", "minimal", "stdout.log"),
  ];
}

export async function checkReceiverNeverLoadedFixture(
  outDir: string,
  paths: {
    receiverProjectDir: string;
    fixtureProjectDir: string;
    /** receiver-side logs to scan for [fixture] lines; default receiverLogPaths(outDir) */
    receiverLogs?: string[];
  },
): Promise<Gate0Check> {
  const legDir = join(outDir, "receiver-headless-trace");
  const stracePath = join(legDir, "strace.txt");
  const argvPath = join(legDir, "argv.txt");
  const appliedPath = join(legDir, "applied.json");
  const recordingPath = join(legDir, RECORDING_NAME);
  const fixturesRoot = join(paths.fixtureProjectDir, "..");
  const problems: string[] = [];

  if (await fileExists(join(legDir, "strace-status.txt"))) {
    problems.push("strace was not installed when this leg ran");
  }
  const strace = await readTextOrUndefined(stracePath);
  if (!strace) {
    problems.push("strace.txt missing or empty");
  } else {
    const opened = successfulOpenats(strace);
    const fixtureOpens = opened.filter(
      (line) =>
        line.includes(`${fixturesRoot}/`) ||
        line.includes("/experiments/render-stream/fixtures/"),
    );
    if (fixtureOpens.length > 0) {
      problems.push(
        `${fixtureOpens.length} successful openat under fixtures/: ${fixtureOpens[0]}`,
      );
    }
    // Positive control: the trace really covers the replay.
    if (!opened.some((line) => line.includes(recordingPath))) {
      problems.push(`no successful openat of ${recordingPath} in the trace`);
    }
  }
  const applied = await readJson<AppliedJson>(appliedPath);
  if (applied?.status !== "ok" || applied.end_seen !== true) {
    problems.push(
      `receiver-headless-trace applied.json status=${JSON.stringify(applied?.status)} end_seen=${JSON.stringify(applied?.end_seen)}`,
    );
  }

  const fixtureShas = new Map<string, string>();
  for (const path of await filesUnder(paths.fixtureProjectDir)) {
    const sha = await fileSha(path);
    if (sha) fixtureShas.set(sha, path);
  }
  const receiverFiles = await filesUnder(paths.receiverProjectDir);
  if (receiverFiles.length === 0)
    problems.push(`no files under ${paths.receiverProjectDir}`);
  for (const path of receiverFiles) {
    const sha = await fileSha(path);
    const twin = sha ? fixtureShas.get(sha) : undefined;
    if (twin) problems.push(`${path} is byte-identical to ${twin}`);
  }

  const logs = paths.receiverLogs ?? receiverLogPaths(outDir);
  for (const required of [
    join(outDir, "receiver", "stdout.log"),
    join(legDir, "stdout.log"),
  ]) {
    if (!(await fileExists(required))) problems.push(`${required} missing`);
  }
  for (const log of logs) {
    const text = await readTextOrUndefined(log);
    const line = text?.split("\n").find((l) => l.includes("[fixture]"));
    if (line) problems.push(`${log} has a [fixture] line: ${line}`);
  }

  const argv =
    (await readTextOrUndefined(argvPath))?.split("\n").map((l) => l.trim()) ??
    [];
  const pathIndex = argv.indexOf("--path");
  if (pathIndex < 0 || argv[pathIndex + 1] !== paths.receiverProjectDir) {
    problems.push(
      `argv.txt does not pass --path ${paths.receiverProjectDir} (got ${JSON.stringify(argv[pathIndex + 1] ?? null)})`,
    );
  }
  if (argv.some((a) => a.includes(`${fixturesRoot}/`)))
    problems.push("argv.txt names a fixture path");

  return check(
    "receiver-never-loaded-fixture",
    "the headless receiver trace opens its recording and nothing under fixtures/; no receiver file is byte-identical to a fixtures/gate0 file; no receiver log has a [fixture] line; argv passes --path <abs receiver>",
    problems,
    `0 fixture opens; ${receiverFiles.length} receiver files, none shared with the fixture; ${logs.length} logs clean`,
    [stracePath, argvPath, appliedPath, ...logs],
  );
}

/** The receiver reports each unsupported entry the transaction it first appears in (new since the
 * previous transaction): the entries a correct receiver lists for `recording`. */
export function expectedReceiverUnsupported(
  recording: Pick<RecordingSummary, "transactions">,
): { seq: number; item: number | null; name: string; reason: string }[] {
  const out: {
    seq: number;
    item: number | null;
    name: string;
    reason: string;
  }[] = [];
  let previous = new Set<string>();
  for (const t of recording.transactions) {
    const current = new Set<string>();
    for (const u of t.meta.unsupported) {
      const key = JSON.stringify([u.op, u.item, u.reason]);
      current.add(key);
      if (!previous.has(key))
        out.push({
          seq: t.meta.seq,
          item: u.item,
          name: u.op,
          reason: u.reason,
        });
    }
    previous = current;
  }
  return out;
}

export async function checkReceiverTypedClean(
  outDir: string,
): Promise<Gate0Check> {
  const selftestDir = join(outDir, "receiver-typecheck", "selftest");
  const minimalDir = join(outDir, "receiver-typecheck", "minimal");
  const selftestLog = join(selftestDir, "stdout.log");
  const minimalLog = join(minimalDir, "stdout.log");
  const minimalApplied = join(minimalDir, "applied.json");
  const minimalRecording = join(minimalDir, RECORDING_NAME);
  const bad = /SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  const problems: string[] = [];
  for (const log of [selftestLog, minimalLog]) {
    const text = await readTextOrUndefined(log);
    if (text === undefined) {
      problems.push(`${log} missing`);
      continue;
    }
    const line = text.split("\n").find((l) => bad.test(l));
    if (line) problems.push(`${log}: ${line.trim()}`);
  }
  const selftest = (await readTextOrUndefined(selftestLog)) ?? "";
  if (!selftest.includes("[rs1-selftest] ok"))
    problems.push("selftest did not print [rs1-selftest] ok");
  const selftestExit = await readExitCode(selftestDir);
  if (selftestExit !== 0) problems.push(`selftest exit=${selftestExit}`);
  const applied = await readJson<AppliedJson>(minimalApplied);
  if (applied?.status !== "ok")
    problems.push(
      `minimal applied.json status=${JSON.stringify(applied?.status)}`,
    );
  const golden = await loadRecording(minimalRecording);
  const want = expectedReceiverUnsupported(golden);
  const got = arr<{
    seq?: number;
    item?: number | null;
    name?: string;
    reason?: string;
  }>(applied?.unsupported).map((u) => ({
    seq: u.seq,
    item: u.item,
    name: u.name,
    reason: u.reason,
  }));
  if (!golden.present) problems.push(`${minimalRecording} missing`);
  if (want.length === 0)
    problems.push("the golden recording declares no unsupported entry");
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push(
      `minimal applied.json unsupported ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
    );
  return check(
    "receiver-typed-clean",
    "receiver-typecheck logs have no SCRIPT ERROR / SCRIPT WARNING / Parse Error / Failed to load script; the selftest printed [rs1-selftest] ok and exited 0; the replay of golden-1/full.rs1 is ok and reports exactly the golden's unsupported entries, each at the seq it first appears",
    problems,
    `selftest ok, golden replay ok with ${want.length} unsupported entries, no script diagnostics`,
    [selftestLog, minimalLog, minimalApplied],
  );
}

export function checkLegClass(evaluation: LegEvaluation): Gate0Check {
  const exp = LEG_EXPECTATIONS[evaluation.leg];
  const c = evaluation.classification;
  const problems: string[] = [];
  if (c.result_class !== exp.class)
    problems.push(`class ${c.result_class}, expected ${exp.class}`);
  if (exp.mismatchSteps) {
    const got = [...c.mismatching_steps].sort((a, b) => a - b);
    if (got.join(",") !== exp.mismatchSteps.join(",")) {
      problems.push(
        `mismatching steps {${got.join(",")}}, expected {${exp.mismatchSteps.join(",")}}`,
      );
    }
    for (const step of [0, 1]) {
      const cp = evaluation.checkpoints.find((k) => k.step === step);
      if (!cp) problems.push(`no checkpoint for step ${step}`);
      else if (checkpointMismatch(cp))
        problems.push(`step ${step} does not match`);
    }
  }
  if (
    exp.reasonIncludes &&
    !c.reasons.some((r) => r.includes(exp.reasonIncludes as string))
  ) {
    problems.push(`no reason mentions ${exp.reasonIncludes}`);
  }
  if (exp.failure) {
    const f = evaluation.applied?.failure;
    if (f?.seq !== exp.failure.seq || f?.reason !== exp.failure.reason) {
      problems.push(
        `applied.json failure=${JSON.stringify(f ?? null)}, expected ${JSON.stringify(exp.failure)}`,
      );
    }
  }
  return check(
    `leg-class-${evaluation.leg}`,
    `the ${evaluation.leg} leg classifies as ${exp.class}${exp.mismatchSteps ? ` with mismatching steps {${exp.mismatchSteps.join(",")}} and steps 0-1 matching` : ""}${exp.reasonIncludes ? ` with a ${exp.reasonIncludes} reason` : ""}${exp.failure ? ` with failure ${JSON.stringify(exp.failure)}` : ""}`,
    problems,
    `${c.result_class}${c.reasons.length > 0 ? ` (${c.reasons.slice(0, 2).join(" | ")})` : ""}`,
    evaluation.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface Gate0Report {
  schema: "render-stream-gate0-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  legs: Record<
    string,
    {
      expected_class: LegClass | null;
      result_class: LegClass | null;
      reasons: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate0Check[];
  checkpoints: Checkpoint[];
  stream: {
    transactions: number | null;
    bytes_total: number | null;
    encode_ns_total: number | null;
    snapshot_ns_total: number | null;
    max_record_bytes: number | null;
  };
}

export interface Gate0Context {
  expected: Gate0Expected;
  receiverProjectDir: string;
  fixtureProjectDir: string;
  now?: Date;
}

async function supportLeg(outDir: string, leg: (typeof SUPPORT_LEGS)[number]) {
  const legDir = join(outDir, leg);
  const dirs =
    leg === "import"
      ? [join(legDir, "fixture"), join(legDir, "receiver")]
      : leg === "receiver-typecheck"
        ? [join(legDir, "selftest"), join(legDir, "minimal")]
        : [legDir];
  const artifacts = await existing(
    dirs.flatMap((dir) => [
      join(dir, "argv.txt"),
      join(dir, "env.txt"),
      join(dir, "stdout.log"),
      join(dir, "exit-code.txt"),
      join(dir, "applied.json"),
      join(dir, "steps.jsonl"),
      join(dir, "strace.txt"),
    ]),
  );
  return {
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: await combinedExitCode(dirs),
    artifacts,
  };
}

export async function runGate0(
  outDir: string,
  ctx: Gate0Context,
): Promise<Gate0Report> {
  const evaluations = new Map<ClassifiedLeg, LegEvaluation>();
  for (const leg of CLASSIFIED_LEGS) {
    evaluations.set(leg, await evaluateLeg(outDir, leg, ctx.expected));
  }
  const capture = evaluations.get("capture") as LegEvaluation;
  const receiver = evaluations.get("receiver") as LegEvaluation;

  const checks: Gate0Check[] = [
    await checkCaptureArmed(outDir, capture),
    await checkHeadlessNoGpuGate0(outDir),
    checkRecordingDecodes(capture.recording),
    checkManifestPresent(capture.recording),
    await checkStepAlignment(outDir, ctx.expected, capture.recording),
    await checkExpectedImageReference(outDir, ctx.expected),
    await checkExpectedImageReceiver(receiver, ctx.expected),
    checkReceiverVsReference(receiver, ctx.expected),
    checkReceiverConsumedStream(receiver),
    await checkReceiverNeverLoadedFixture(outDir, ctx),
    await checkReceiverTypedClean(outDir),
    ...CLASSIFIED_LEGS.map((leg) =>
      checkLegClass(evaluations.get(leg) as LegEvaluation),
    ),
  ];

  const legs: Gate0Report["legs"] = {};
  for (const leg of SUPPORT_LEGS) legs[leg] = await supportLeg(outDir, leg);
  for (const leg of CLASSIFIED_LEGS) {
    const e = evaluations.get(leg) as LegEvaluation;
    legs[leg] = {
      expected_class: e.expected_class,
      result_class: e.classification.result_class,
      reasons: e.classification.reasons,
      exit_code: e.exit_code,
      artifacts: e.artifacts,
    };
  }

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  const stats = capture.recording.end?.stats;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    schema: "render-stream-gate0-report/1",
    generated_at: (ctx.now ?? new Date()).toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed: checks.every((c) => c.passed),
    legs,
    checks,
    checkpoints: receiver.checkpoints,
    stream: {
      transactions: num(capture.recording.end?.transactions),
      bytes_total: num(stats?.bytes_total),
      encode_ns_total: num(stats?.encode_ns_total),
      snapshot_ns_total: num(stats?.snapshot_ns_total),
      max_record_bytes: num(stats?.max_record_bytes),
    },
  };
}
