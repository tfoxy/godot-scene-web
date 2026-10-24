#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 6 group G6z (protocol/gate6-design.md "Q8. Supported-feature manifest"): generates
// protocol/features/render-stream-6.json, schema render-stream-features/1.
//
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/make-features.ts
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/make-features.ts --check
//
//   ... make-features.ts --receiver native|web-export|gsw-canvas|all [--check]   (G7z, /2)
//   ... make-features.ts --collect [--evidence-root <dir>]                     (G7z, device targets)
//
// G7z (gate7-design.md Q11): `--receiver` writes protocol/features/render-stream-7/<kind>.json,
// schema render-stream-features/2, from lib/feature-evidence-7.ts and collected.json (the g31
// device targets and the receiver blocks, which `--collect` derives from the evidence runs that
// feature-evidence-7.ts quotes). Generation never reads the evidence tree, so `--check` stays
// byte-reproducible after evidence is pruned; lib/gate7z-checks.ts re-reads the evidence.
//
// With no flag, (re)writes the committed manifest. `--check` regenerates in memory and exits
// non-zero unless the committed file is byte-identical (the G6z `manifest-check` check runs this).
//
// Two sources, per Q8: the wire-derived lists below (OPS_V6 etc., literally copied from
// capture/src/rs_publish.cpp's gate2_features(), V6, headless_host=true -- the call every gate 6
// capture makes) are cross-checked against lib/feature-evidence.ts's FEATURE_ENTRIES so neither
// can drift from the other silently; every other entry (viewport, material, text, control,
// delivery, payload kinds) comes from feature-evidence.ts alone.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEATURE_ENTRIES,
  type FeatureEntry,
  type FeatureKind,
} from "./lib/feature-evidence";
import {
  EVIDENCE_RUNS,
  type FeatureEntry2,
  MANIFEST_FILE,
  PRIMARY_BUILD,
  RECEIVER_KINDS,
  type ReceiverKind,
  receiverFeatureEntries,
  SHORT_KIND,
  validateEntries2,
} from "./lib/feature-evidence-7";
import {
  bundleShas,
  collectDeviceTargets,
  type DeviceTarget,
  defaultEvidenceRoot,
  loadRun,
} from "./lib/gate7z-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");
export const MANIFEST_PATH = join(
  EXPERIMENT_DIR,
  "protocol",
  "features",
  "render-stream-6.json",
);

// capture/src/rs_publish.cpp gate2_features(), version == ProtocolVersion::V6, headless_host =
// true (every gate 6 capture is headless): the four wire-feature lists this build's session
// record actually carries, lines ~229-377 as of G6z.
export const OPS_V6: readonly string[] = [
  "add_circle",
  "add_clip_ignore",
  "add_line",
  "add_mesh",
  "add_msdf_texture_rect_region",
  "add_multiline",
  "add_nine_patch",
  "add_polygon",
  "add_polyline",
  "add_primitive",
  "add_rect",
  "add_set_transform",
  "add_texture_rect",
  "add_texture_rect_region",
  "add_triangle_array",
];
export const ITEM_STATE_V6: readonly string[] = [
  "behind",
  "children",
  "clip",
  "custom_rect",
  "draw_index",
  "instance_params",
  "material",
  "modulate",
  "parent",
  "self_modulate",
  "texture_filter",
  "texture_repeat",
  "transform",
  "use_parent_material",
  "visibility_layer",
  "visible",
  "z_index",
  "z_relative",
];
export const CANVAS_STATE_V6: readonly string[] = [
  "layer",
  "modulate",
  "transform",
];
export const RESOURCES_V6: readonly string[] = [
  "material",
  "mesh",
  "shader",
  "texture_2d",
  "texture_2d_placeholder",
];
export const UNSUPPORTED_RESOURCES_V6: ReadonlyArray<{
  resource: string;
  reason: string;
}> = [{ resource: "canvas_texture", reason: "canvas-texture-headless" }];
export const OBSERVED_UNSUPPORTED_OPS_V6: readonly string[] = [
  "canvas_item_add_animation_slice",
  "canvas_item_add_lcd_texture_rect_region",
  "canvas_item_add_multimesh",
  "canvas_item_add_particles",
  "canvas_item_attach_skeleton",
  "canvas_light_attach_to_canvas",
  "canvas_set_item_mirroring",
  "canvas_set_item_repeat",
  "canvas_set_parent",
];
export const UNOBSERVED_V6: readonly string[] = [
  "canvas_item_set_canvas_group_mode",
  "canvas_item_set_copy_to_backbuffer",
  "canvas_item_set_light_mask",
  "canvas_item_set_sort_children_by_y",
  "canvas_item_set_visibility_notifier",
  "canvas_set_disable_scale",
  "canvas_texture_set_shading_parameters",
  "global_shader_parameter_add",
  "global_shader_parameter_remove",
  "global_shader_parameter_set",
  "global_shader_parameter_set_override",
  "material_set_next_pass",
  "material_set_render_priority",
  "shader_set_path_hint",
  "texture_set_size_override",
  "viewport_set_canvas_cull_mask",
  "viewport_set_snap_2d_transforms_to_pixel",
  "viewport_set_snap_2d_vertices_to_pixel",
];

const KIND_ORDER: readonly FeatureKind[] = [
  "op",
  "item_state",
  "canvas_state",
  "resource",
  "payload",
  "material",
  "viewport",
  "delivery",
  "text",
  "control",
];

export interface FeatureManifest {
  schema: "render-stream-features/1";
  protocol: "render-stream/6";
  engine: { version: string; template: string; platform: string };
  capture: { calibrator_version: number; hooks: number };
  receiver: string;
  entries: FeatureEntry[];
  limits: {
    max_payload_bytes: number;
    permitted_formats: string[];
    live_item_cap: number;
    max_connections: number;
    publish_fps: { min: number; max: number; uncapped: boolean };
    shader_policies: string[];
  };
}

/** Cross-checks lib/feature-evidence.ts's op/item_state/canvas_state/resource entries against the
 * wire-derived lists above: every wire id must have exactly one matching, consistently-statused
 * entry, and every entry of those four kinds must name a real wire id. Throws on the first
 * mismatch (make-features.ts has no partial-success mode: a drift here must fail loudly). */
export function crossCheckWireLists(entries: readonly FeatureEntry[]): void {
  const byKindId = new Map<string, FeatureEntry>();
  for (const e of entries) byKindId.set(`${e.kind}:${e.id}`, e);

  const expectSupported = (
    kind: FeatureKind,
    ids: readonly string[],
    prefix = "",
  ): void => {
    for (const id of ids) {
      const key = `${kind}:${prefix}${id}`;
      const e = byKindId.get(key);
      if (!e)
        throw new Error(
          `make-features: missing feature-evidence.ts entry for ${key} (present in rs_publish.cpp's V6 list)`,
        );
      if (e.status !== "supported")
        throw new Error(
          `make-features: ${key} is wired as supported by rs_publish.cpp but feature-evidence.ts has status ${e.status}`,
        );
    }
  };
  expectSupported("op", OPS_V6);
  expectSupported("item_state", ITEM_STATE_V6, "item_state.");
  expectSupported("canvas_state", CANVAS_STATE_V6, "canvas_state.");
  expectSupported("resource", RESOURCES_V6, "resource.");

  for (const { resource, reason } of UNSUPPORTED_RESOURCES_V6) {
    const key = `resource:resource.${resource}`;
    const e = byKindId.get(key);
    if (!e || e.status !== "typed-unsupported" || e.reason !== reason)
      throw new Error(
        `make-features: ${key} must be typed-unsupported with reason ${reason} (rs_publish.cpp unsupported_resources)`,
      );
  }
  for (const id of OBSERVED_UNSUPPORTED_OPS_V6) {
    const key = `op:${id}`;
    const e = byKindId.get(key);
    if (!e || e.status !== "typed-unsupported")
      throw new Error(
        `make-features: ${key} must be typed-unsupported (rs_publish.cpp observed_unsupported_ops)`,
      );
  }
  for (const id of UNOBSERVED_V6) {
    const key = `op:${id}`;
    const e = byKindId.get(key);
    if (!e || e.status !== "unobserved")
      throw new Error(
        `make-features: ${key} must be unobserved (rs_publish.cpp unobserved)`,
      );
  }

  // The reverse direction: every op/item_state/canvas_state/resource entry must name a real id.
  const known = new Set<string>([
    ...OPS_V6.map((id) => `op:${id}`),
    ...OBSERVED_UNSUPPORTED_OPS_V6.map((id) => `op:${id}`),
    ...UNOBSERVED_V6.map((id) => `op:${id}`),
    ...ITEM_STATE_V6.map((id) => `item_state:item_state.${id}`),
    ...CANVAS_STATE_V6.map((id) => `canvas_state:canvas_state.${id}`),
    ...RESOURCES_V6.map((id) => `resource:resource.${id}`),
    ...UNSUPPORTED_RESOURCES_V6.map((r) => `resource:resource.${r.resource}`),
  ]);
  for (const e of entries) {
    if (
      (e.kind === "op" ||
        e.kind === "item_state" ||
        e.kind === "canvas_state" ||
        e.kind === "resource") &&
      !known.has(`${e.kind}:${e.id}`)
    )
      throw new Error(
        `make-features: feature-evidence.ts entry ${e.kind}:${e.id} names no id in rs_publish.cpp's V6 lists`,
      );
  }
}

/** Per-status shape rules (Q8): "supported" needs evidence; "typed-unsupported" needs a reason
 * and an owner; "unobserved" needs an owner and notes; "declared-unverified" needs notes. Pure,
 * self-test only -- not one of the four G6z checks, which run against a real wire/run directory. */
export function validateManifestShape(
  entries: readonly FeatureEntry[],
): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    const key = `${e.kind}:${e.id}`;
    if (e.status === "supported" && e.evidence.length === 0)
      problems.push(`${key}: supported needs at least one evidence entry`);
    if (e.status === "typed-unsupported" && (!e.reason || !e.owner))
      problems.push(`${key}: typed-unsupported needs reason and owner`);
    if (e.status === "unobserved" && (!e.owner || !e.notes))
      problems.push(`${key}: unobserved needs owner and notes`);
    if (e.status === "declared-unverified" && !e.notes)
      problems.push(`${key}: declared-unverified needs notes`);
  }
  return problems;
}

function sortedEntries(entries: readonly FeatureEntry[]): FeatureEntry[] {
  return [...entries].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function buildManifest(): FeatureManifest {
  crossCheckWireLists(FEATURE_ENTRIES);
  return {
    schema: "render-stream-features/1",
    protocol: "render-stream/6",
    engine: {
      version: "4.5.1-stable",
      template: "linux_release",
      platform: "linux-x86_64",
    },
    capture: { calibrator_version: 9, hooks: 79 },
    receiver: "native-godot-4.5.1-gl_compatibility",
    entries: sortedEntries(FEATURE_ENTRIES),
    limits: {
      // capture/src/entry.cpp: GRC_RESOURCE_MAX_PAYLOAD_BYTES default (64 MiB) and
      // GRC_RESOURCE_FORMATS default (L8,LA8,R8,RG8,RGB8,RGBA8); rs2_snapshot.h kMaxLiveItems;
      // GRC_LIVE_MAX_CONNECTIONS (1..4, D13); GRC_PUBLISH_FPS (1..240 or uncapped, D8);
      // render-stream-2.ts SHADER_POLICIES (gate5_5-design.md D11).
      max_payload_bytes: 67108864,
      permitted_formats: ["L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"],
      live_item_cap: 4096,
      max_connections: 4,
      publish_fps: { min: 1, max: 240, uncapped: true },
      shader_policies: ["exclude", "params", "source"],
    },
  };
}

export function serializeManifest(manifest: FeatureManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// -------------------------------------------------------------------------------------------
// G7z: render-stream-features/2, one file per receiver kind (Q11).
// -------------------------------------------------------------------------------------------

export const MANIFEST7_DIR = join(
  EXPERIMENT_DIR,
  "protocol",
  "features",
  "render-stream-7",
);
export const COLLECTED_PATH = join(MANIFEST7_DIR, "collected.json");
export function manifest7Path(kind: ReceiverKind): string {
  return join(MANIFEST7_DIR, MANIFEST_FILE[kind]);
}

interface ReceiverBlock {
  id: string;
  kind: ReceiverKind;
  build: {
    sha256: string | null;
    godot_editor: string;
    web_template_sha256: string | null;
    bundle_bytes: number | null;
    commit: string;
  };
  platform: {
    runtime: string;
    graphics: string | null;
    angle_backend: "vulkan" | null;
  };
}

export interface Collected {
  schema: "render-stream-features-collected/1";
  primary_build: string;
  receivers: Record<
    ReceiverKind,
    {
      receiver: ReceiverBlock;
      webgl_compression_extensions: string[] | null;
      device_targets: DeviceTarget[];
    }
  >;
}

export interface FeatureManifest2 {
  schema: "render-stream-features/2";
  protocol: "render-stream/7";
  stream_protocols: string[];
  engine: { version: string; template: string; platform: string };
  capture: { calibrator_version: number; hooks: number };
  receiver: ReceiverBlock;
  /** G7z: the run each evidence group@kind is quoted from (lib/feature-evidence-7.ts). */
  evidence_runs: { key: string; path: string; build: string; note: string }[];
  entries: FeatureEntry2[];
  limits: FeatureManifest["limits"] & {
    receiver: {
      max_texture_size: number | null;
      max_message_bytes: number;
      credit_windows: number[];
      default_credit_window: number;
      fetch_concurrency: number;
      cache: "memory+disk" | "memory+http-cache";
      shader_policies: string[];
      texture_formats: string[];
      webgl_compression_extensions: string[] | null;
      device_targets: DeviceTarget[];
    };
  };
}

const RECEIVER_LIMITS: Record<
  ReceiverKind,
  { cache: "memory+disk" | "memory+http-cache"; fetch_concurrency: number }
> = {
  // receiver.gd's store fetcher and GSW's StoreFetcher are one GET at a time (G7p: "GSW's fetcher
  // is one fetch at a time"); native has the disk cache, browsers the HTTP cache (D16).
  native: { cache: "memory+disk", fetch_concurrency: 1 },
  "web-export": { cache: "memory+http-cache", fetch_concurrency: 1 },
  "gsw-canvas": { cache: "memory+http-cache", fetch_concurrency: 1 },
};

export function readCollected(): Collected {
  const text = readFileSyncOrNull(COLLECTED_PATH);
  if (text === null)
    throw new Error(
      `make-features: ${COLLECTED_PATH} missing; run make-features.ts --collect first`,
    );
  return JSON.parse(text) as Collected;
}

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function sortedEntries2(entries: readonly FeatureEntry2[]): FeatureEntry2[] {
  return [...entries].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function buildManifest2(
  kind: ReceiverKind,
  collected: Collected = readCollected(),
): FeatureManifest2 {
  const v1 = buildManifest();
  const entries = sortedEntries2(receiverFeatureEntries(kind));
  const problems = validateEntries2(entries);
  if (problems.length > 0)
    throw new Error(`make-features --receiver ${kind}: ${problems.join("; ")}`);
  const ids1 = v1.entries.map((e) => `${e.kind}:${e.id}`);
  const ids2 = new Set(entries.map((e) => `${e.kind}:${e.id}`));
  for (const id of ids1)
    if (!ids2.has(id))
      throw new Error(
        `make-features --receiver ${kind}: /1 entry ${id} missing`,
      );
  const c = collected.receivers[kind];
  const short = SHORT_KIND[kind];
  return {
    schema: "render-stream-features/2",
    protocol: "render-stream/7",
    stream_protocols: ["render-stream/6", "render-stream/7"],
    engine: v1.engine,
    capture: v1.capture,
    receiver: c.receiver,
    evidence_runs: EVIDENCE_RUNS.filter((r) => r.key.endsWith(`@${short}`)).map(
      (r) => ({ key: r.key, path: r.path, build: r.build, note: r.note }),
    ),
    entries,
    limits: {
      ...v1.limits,
      receiver: {
        // Null by design: no gate 7 evidence file records it (provenance.json lists extensions,
        // not GL limits), and no leg uploads a texture near it. G7z names the gap rather than
        // quoting a number nothing measured.
        max_texture_size: null,
        // rs_live's per-message ceiling equals the payload ceiling (GRC_RESOURCE_MAX_PAYLOAD_BYTES).
        max_message_bytes: v1.limits.max_payload_bytes,
        credit_windows: [1, 2],
        default_credit_window: 2,
        fetch_concurrency: RECEIVER_LIMITS[kind].fetch_concurrency,
        cache: RECEIVER_LIMITS[kind].cache,
        shader_policies: v1.limits.shader_policies,
        texture_formats: v1.limits.permitted_formats.map((f) =>
          f.toLowerCase(),
        ),
        webgl_compression_extensions: c.webgl_compression_extensions,
        device_targets: c.device_targets,
      },
    },
  };
}

export function serializeManifest2(manifest: FeatureManifest2): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function provenanceOf(dir: string): {
  renderer: string | null;
  version: string | null;
  args: string[];
  extensions: string[];
} | null {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    if (names.includes("provenance.json")) {
      try {
        const p = JSON.parse(
          readFileSync(join(d, "provenance.json"), "utf8"),
        ) as {
          renderer?: string;
          version?: string;
          args?: string[];
          extensions?: string[];
        };
        if (p.renderer)
          return {
            renderer: p.renderer,
            version: p.version ?? null,
            args: p.args ?? [],
            extensions: p.extensions ?? [],
          };
      } catch {
        // keep looking
      }
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) stack.push(p);
      } catch {
        // skip
      }
    }
  }
  return null;
}

/** make-features.ts --collect: the receiver blocks and the g31 device targets, from the runs
 * feature-evidence-7.ts quotes (the primary build's g7-6 file run per browser kind, the native
 * gate 6 run for native). */
export function collect(root: string): Collected {
  const receivers = {} as Collected["receivers"];
  for (const kind of RECEIVER_KINDS) {
    const short = SHORT_KIND[kind];
    // The browsers' receiver block comes from the g7-6 FILE run, not a live one: every live run
    // sends this file's sha256 in its hello (manifest-matches-hello), so the file must be final
    // before them, and cannot be generated from them.
    const primaryKey = kind === "native" ? "gate6@native" : `g7-6@${short}`;
    const q = EVIDENCE_RUNS.find((r) => r.key === primaryKey);
    const run = q ? loadRun(root, q.path) : null;
    if (!q || !run)
      throw new Error(
        `make-features --collect: quoted run ${primaryKey} missing under ${root}`,
      );
    let sha: string | null = null;
    let graphics: string | null = null;
    let ext: string[] | null = null;
    let angle: "vulkan" | null = null;
    let runtime = "godot-4.5.1-gl_compatibility";
    if (kind === "native") {
      sha = (
        JSON.parse(readFileSync(join(run.dir, "binary.json"), "utf8")) as {
          sha256: string;
        }
      ).sha256;
      graphics = nativeRenderer(run.dir);
    } else {
      sha = [...(bundleShas(run.dir).get(short) ?? [])][0] ?? null;
      const p = provenanceOf(run.dir);
      graphics = p?.renderer ?? null;
      ext = (p?.extensions ?? []).filter((e) => /compressed/i.test(e)).sort();
      angle = p?.args.includes("--use-angle=vulkan") ? "vulkan" : null;
      runtime = "chromium-148.0.7778.96";
    }
    const receiver: ReceiverBlock = {
      id:
        kind === "native"
          ? "native-godot-4.5.1-gl_compatibility-rs-core"
          : kind === "web-export"
            ? "web-export-godot-4.5.1-web_dlink_nothreads-rs-core"
            : "gsw-canvas-rs-core-wasm",
      kind,
      build: {
        sha256: sha,
        godot_editor: "4.5.1-stable",
        web_template_sha256:
          kind === "web-export"
            ? "68162ae9249ca3b7ce53dde8cdfab59463bd6518dca9123df41e5cc8fb1bd454"
            : null,
        bundle_bytes: null,
        commit: q.build,
      },
      platform: { runtime, graphics, angle_backend: angle },
    };
    receivers[kind] = {
      receiver,
      webgl_compression_extensions: ext,
      device_targets: collectDeviceTargets(root, kind, sha),
    };
  }
  return {
    schema: "render-stream-features-collected/1",
    primary_build: PRIMARY_BUILD,
    receivers,
  };
}

function nativeRenderer(dir: string): string | null {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < 4000) {
    const d = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(d, n);
      seen++;
      try {
        if (statSync(p).isDirectory()) stack.push(p);
        else if (n === "stdout.log") {
          const m = /OpenGL API [^\n]*/.exec(readFileSync(p, "utf8"));
          if (m) return m[0].trim();
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main7(receiverArg: string, check: boolean): Promise<void> {
  const kinds =
    receiverArg === "all"
      ? RECEIVER_KINDS
      : RECEIVER_KINDS.filter((k) => k === receiverArg);
  if (kinds.length === 0)
    throw new Error(
      `make-features: --receiver must be native, web-export, gsw-canvas or all (got ${receiverArg})`,
    );
  await mkdir(MANIFEST7_DIR, { recursive: true });
  for (const kind of kinds) {
    const serialized = serializeManifest2(buildManifest2(kind));
    const path = manifest7Path(kind);
    if (check) {
      const onDisk = readFileSyncOrNull(path);
      if (onDisk !== serialized) {
        console.error(
          `make-features --receiver ${kind} --check: ${path} is stale`,
        );
        process.exitCode = 1;
      } else
        console.log(
          `make-features --receiver ${kind} --check: ${path} is up to date`,
        );
      continue;
    }
    await writeFile(path, serialized);
    console.log(`make-features: wrote ${path}`);
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  if (process.argv.includes("--collect")) {
    const root = resolve(argValue("--evidence-root") ?? defaultEvidenceRoot());
    await mkdir(MANIFEST7_DIR, { recursive: true });
    const collected = collect(root);
    await writeFile(COLLECTED_PATH, `${JSON.stringify(collected, null, 2)}\n`);
    console.log(
      `make-features --collect: wrote ${COLLECTED_PATH} from ${root}`,
    );
    return;
  }
  const receiverArg = argValue("--receiver");
  if (receiverArg !== undefined) {
    await main7(receiverArg, check);
    return;
  }
  const manifest = buildManifest();
  const serialized = serializeManifest(manifest);
  if (check) {
    const onDisk = await readFile(MANIFEST_PATH, "utf8").catch(() => null);
    if (onDisk !== serialized) {
      console.error(
        `make-features --check: ${MANIFEST_PATH} is stale (regenerated output differs byte-for-byte). Run make-features.ts with no flag to update it.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `make-features --check: ${MANIFEST_PATH} is up to date (${manifest.entries.length} entries).`,
    );
    return;
  }
  await writeFile(MANIFEST_PATH, serialized);
  console.log(
    `make-features: wrote ${MANIFEST_PATH} (${manifest.entries.length} entries).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
