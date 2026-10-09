#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the Gate -1 checker (lib/gate-minus1-checks.ts): proves the harness can actually
// CATCH a failure, not just report "pass" on whatever it is handed. Builds a fabricated evidence
// tree per scenario (a "good" tree that should pass everything it covers, then one perturbation
// per criterion), runs the real check functions against it, and asserts the expected verdict.
//
//   mise exec -- pnpm exec tsx --conditions=development scripts/test/self-test-checker.ts
//
// Exits non-zero if ANY scenario's actual verdict doesn't match what it was built to prove.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  type Criterion,
  checkCaptureCounts,
  checkDisarmAndCompletion,
  checkDrawPaths,
  checkFrameCallbackTicked,
  checkHeadlessNoGpu,
  checkNewDrawingsVisible,
  checkNoMprotectAfterArm,
  checkOlderRecord,
  checkPixelParity,
  checkPolygonBitExact,
  checkRenderedLegs,
  checkValidateAndRefusals,
  type ExpectedWithDrawPaths,
} from "../lib/gate-minus1-checks";

type ExpectedJson = ExpectedWithDrawPaths;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

const WIDTH = 640;
const HEIGHT = 360;
const RECT_COLOR = [223, 64, 32, 255] as const; // Color(0.875, 0.25, 0.125, 1) rounded to bytes
const CLEAR_COLOR = [25, 25, 31, 255] as const; // Color(0.1, 0.1, 0.12, 1) rounded to bytes

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** Where the fixture's calibrator-2 drawings land (expected.json draw_paths.visible_samples). */
let drawingSamples: Array<{ name: string; x: number; y: number }> = [];

async function writeScenePng(
  path: string,
  options: {
    blank?: boolean;
    perturbPixel?: [number, number];
    /** Leave this drawing's sample area at the clear colour. */
    omitDrawing?: string;
  } = {},
): Promise<void> {
  const buf = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const inRect = !options.blank && x >= 40 && x < 160 && y >= 40 && y < 120;
      const color = inRect ? RECT_COLOR : CLEAR_COLOR;
      const index = (y * WIDTH + x) * 4;
      buf[index] = color[0];
      buf[index + 1] = color[1];
      buf[index + 2] = color[2];
      buf[index + 3] = color[3];
    }
  }
  if (!options.blank) {
    // A 5x5 patch at each new drawing's sample point.
    for (const sample of drawingSamples) {
      if (sample.name === options.omitDrawing) continue;
      for (let y = sample.y - 2; y <= sample.y + 2; y++) {
        for (let x = sample.x - 2; x <= sample.x + 2; x++) {
          const index = (y * WIDTH + x) * 4;
          buf[index] = 200;
          buf[index + 1] = 180;
          buf[index + 2] = 160;
        }
      }
    }
  }
  if (options.perturbPixel) {
    const [px, py] = options.perturbPixel;
    const index = (py * WIDTH + px) * 4;
    buf[index] = (buf[index] + 37) % 255;
  }
  await mkdir(dirname(path), { recursive: true });
  await sharp(buf, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png()
    .toFile(path);
}

/** `{name: value}` for every optional hook (calibrators 2 and 3). */
function optionalCounts(
  expected: ExpectedJson,
  value: number | null,
): Record<string, number | null> {
  return Object.fromEntries(
    expected.optional_hooks.map((name) => [name, value]),
  );
}

/** counters.json `captured` entries for every calibrator-2 hook, in the library's shapes, with
 * RIDs that tie them together the way the real fixture's do. */
function goodDrawPathCaptures(expected: ExpectedJson): Record<string, unknown> {
  const dp = expected.draw_paths;
  const seen = { calls: 60, first_frame: 1, last_frame: 60 };
  return {
    canvas_item_add_triangle_array: [
      {
        item: "script",
        indices: dp.triangle_array.indices,
        indices_total: dp.triangle_array.indices.length,
        point_bits: dp.triangle_array.point_bits,
        points_total: dp.triangle_array.point_bits.length,
        color_bits: dp.triangle_array.color_bits,
        colors_total: dp.triangle_array.color_bits.length,
        uv_bits: dp.triangle_array.uv_bits,
        uvs_total: dp.triangle_array.uv_bits.length,
        bones_total: 0,
        weights_total: 0,
        texture: dp.triangle_array.texture,
        count: dp.triangle_array.count,
        ...seen,
      },
      {
        item: "panel",
        indices_total: 3,
        points_total: 2,
        // The fill, then the anti-aliasing feather: bg_color at alpha 0.
        color_bits: [
          dp.stylebox_panel.bg_color_bits,
          [...dp.stylebox_panel.bg_color_bits.slice(0, 3), "0x00000000"],
        ],
        colors_total: 2,
        calls: 1,
      },
    ],
    canvas_item_set_modulate: [
      { item: "panel", color_bits: dp.stylebox_panel.modulate_bits },
    ],
    canvas_item_set_material: [{ item: "panel", material: "material" }],
    material_set_param: [{ material: "material" }],
    shader_create_from_code: [{ rid: "shader" }],
    shader_set_code: [{ shader: "shader" }],
    canvas_item_add_nine_patch: [
      {
        item: "script",
        rect_bits: dp.nine_patch_script.rect_bits,
        source_bits: dp.nine_patch_script.source_bits,
        texture: "texture4",
        topleft_bits: dp.nine_patch_script.topleft_bits,
        bottomright_bits: dp.nine_patch_script.bottomright_bits,
        x_axis_mode: dp.nine_patch_script.x_axis_mode,
        y_axis_mode: dp.nine_patch_script.y_axis_mode,
        draw_center: dp.nine_patch_script.draw_center,
        modulate_bits: dp.nine_patch_script.modulate_bits,
        ...seen,
      },
      {
        item: "ninepatchrect",
        rect_bits: dp.nine_patch_native.rect_bits,
        texture: "texture4",
        topleft_bits: dp.nine_patch_native.topleft_bits,
        bottomright_bits: dp.nine_patch_native.bottomright_bits,
        x_axis_mode: dp.nine_patch_native.x_axis_mode,
        y_axis_mode: dp.nine_patch_native.y_axis_mode,
        draw_center: dp.nine_patch_native.draw_center,
      },
    ],
    canvas_item_add_primitive: [
      {
        item: "script",
        point_bits: dp.primitive.point_bits,
        color_bits: dp.primitive.color_bits,
        uv_bits: dp.primitive.uv_bits,
      },
    ],
    canvas_item_add_line: [
      {
        item: "script",
        from_bits: dp.line.from_bits,
        to_bits: dp.line.to_bits,
        color_bits: dp.line.color_bits,
        width_bits: dp.line.width_bits,
        antialiased: dp.line.antialiased,
      },
    ],
    canvas_item_add_polyline: [
      {
        item: "script",
        point_bits: dp.polyline.point_bits,
        color_bits: dp.polyline.color_bits,
        width_bits: dp.polyline.width_bits,
      },
    ],
    canvas_item_add_set_transform: [
      { item: "script", transform_bits: dp.set_transform.transform_bits },
    ],
    canvas_item_add_circle: [
      {
        item: "script",
        position_bits: dp.circle.position_bits,
        radius_bits: dp.circle.radius_bits,
        color_bits: dp.circle.color_bits,
      },
    ],
    mesh_create: [{ rid: "mesh" }, { rid: "scratch" }],
    mesh_add_surface: [
      {
        mesh: "mesh",
        primitive: dp.mesh.primitive,
        format: dp.mesh.format,
        vertex_count: dp.mesh.vertex_count,
        vertex_data_size: dp.mesh.vertex_data_size,
        attribute_data_size: dp.mesh.attribute_data_size,
        skin_data_size: dp.mesh.skin_data_size,
        index_count: dp.mesh.index_count,
        index_data_size: dp.mesh.index_data_size,
        aabb_bits: dp.mesh.aabb_bits,
      },
    ],
    canvas_item_add_mesh: [
      {
        item: "script",
        mesh: "mesh",
        transform_bits: dp.mesh.transform_bits,
        modulate_bits: dp.mesh.modulate_bits,
        texture: dp.mesh.texture,
        ...seen,
      },
    ],
    canvas_item_add_multimesh: [
      { item: "script", mesh: "multimesh", texture: "0" },
    ],
    mesh_clear: [{ mesh: "scratch" }],
    mesh_surface_update_vertex_region: [
      {
        mesh: "mesh",
        surface: dp.vertex_region.surface,
        offset: dp.vertex_region.offset,
        data_size: dp.vertex_region.data_size,
        head_hex: dp.vertex_region.head_hex,
        ...seen,
      },
    ],
    mesh_surface_update_attribute_region: [
      {
        mesh: "mesh",
        surface: dp.attribute_region.surface,
        offset: dp.attribute_region.offset,
        data_size: dp.attribute_region.data_size,
        head_hex: dp.attribute_region.head_hex,
        ...seen,
      },
    ],
    mesh_set_custom_aabb: [
      { mesh: "mesh", aabb_bits: dp.custom_aabb.aabb_bits, ...seen },
    ],
  };
}

async function readCounters(path: string): Promise<{
  counts: Record<string, number | null>;
  captured: Record<string, Array<Record<string, unknown>>>;
  [key: string]: unknown;
}> {
  return JSON.parse(
    await (await import("node:fs/promises")).readFile(path, "utf8"),
  );
}

/** A fully-passing evidence tree for the groups the self-test exercises. Each scenario starts
 * from a copy of this and perturbs exactly one thing. */
async function buildGoodEvidence(
  dir: string,
  expected: ExpectedJson,
): Promise<void> {
  drawingSamples = expected.draw_paths.visible_samples.samples;
  const armedDir = join(dir, "headless-armed");
  await writeJson(join(armedDir, "evidence", "counters.json"), {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: 400,
    frames_armed: 340,
    hooks_planned: [],
    hooks_omitted: [],
    counts: {
      canvas_item_add_rect: 2,
      canvas_item_add_polygon: 1,
      canvas_item_add_texture_rect_region: 5,
      canvas_item_add_msdf_texture_rect_region: 0,
      texture_2d_create: 2,
      texture_2d_update: 1,
      free: 0,
      ...optionalCounts(expected, 60),
    },
    captured: {
      ...goodDrawPathCaptures(expected),
      canvas_item_add_rect: [
        {
          item: "colorrect",
          rect: expected.colorrect_add_rect.rect,
          rect_bits: expected.colorrect_add_rect.rect_bits,
          color: expected.colorrect_add_rect.color,
          color_bits: expected.colorrect_add_rect.color_bits,
          antialiased: false,
        },
        {
          item: "script",
          rect: expected.script_add_rect.rect,
          rect_bits: expected.script_add_rect.rect_bits,
          color: expected.script_add_rect.color,
          color_bits: expected.script_add_rect.color_bits,
          antialiased: false,
        },
      ],
      canvas_item_add_polygon: [
        {
          points: expected.script_add_polygon.points,
          point_bits: expected.script_add_polygon.point_bits,
          colors: expected.script_add_polygon.colors,
          color_bits: expected.script_add_polygon.color_bits,
          uvs_count: expected.script_add_polygon.uvs_count,
        },
      ],
      texture_2d_create: [
        { rid: "1", frame: 1, width: 256, height: 256 },
        { rid: "texture4", frame: 1, width: 4, height: 4, format: 5 },
      ],
      texture_2d_update: [
        { rid: "1", frame: expected.label_glyphs.relabel_frame, layer: 0 },
      ],
    },
  });
  await writeJson(join(armedDir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
  });
  await writeText(
    join(armedDir, "maps.txt"),
    "00400000-00407000 r--p 00000000 103:09 1 /opt/linux_release.x86_64\n7f0000000000-7f0000001000 r-xp 00000000 103:09 2 /usr/lib/x86_64-linux-gnu/libc.so.6\n",
  );
  await writeText(
    join(armedDir, "fd.txt"),
    "lr-x------ 1 u u 64 Oct  8 22:45 0 -> /dev/null\n",
  );
  await writeJson(join(armedDir, "evidence", "disarm.json"), {
    disarmed: true,
    vptr_was_shadow: true,
    vptr_restored: true,
    frame: 60,
  });
  await writeJson(join(armedDir, "evidence", "fingerprint.json"), {
    pid: 12345,
    exe_maps: [
      "555500000000-555500100000 r-xp 00000000 103:09 1 /opt/linux_release.x86_64",
    ],
  });
  await writeText(
    join(armedDir, "stdout.txt"),
    "[fixture] draws=400 frames=400\n",
  );
  await writeText(join(armedDir, "exit-code.txt"), "0\n");
  await writeText(
    join(armedDir, "strace.txt"),
    [
      "10:00:00.000000 mprotect(0x7fdead000000, 4096, PROT_READ) = 0",
      '10:00:01.000000 openat(AT_FDCWD, "/tmp/evidence/armed.marker", O_WRONLY|O_CREAT, 0666) = 7',
      "10:00:02.000000 mprotect(0x7fdead001000, 4096, PROT_READ) = 0",
      "",
    ].join("\n"),
  );

  for (const [leg, status, reason] of [
    ["headless-validate", "validated", undefined],
    ["refuse-sha", "refused", "fingerprint-mismatch"],
    ["refuse-prefix", "refused", "slot-mask-mismatch"],
    ["refuse-nocal", "refused", "no-calibration"],
    ["refuse-binary-byte", "refused", "fingerprint-mismatch"],
  ] as const) {
    await writeJson(join(dir, leg, "evidence", "result.json"), {
      schema: "render-stream-capture-result/1",
      status,
      reason: reason ?? null,
      vptr_written: false,
      disarmed: false,
      display_server: "headless",
    });
  }

  await writeScenePng(join(dir, "rendered-unarmed", "unarmed.png"));
  await writeScenePng(join(dir, "rendered-armed", "armed.png"));
  await writeText(
    join(dir, "rendered-unarmed", "godot.log"),
    "[fixture] extension load status=skipped (GRC_EXTENSION not set)\n[fixture] screenshot saved=/x/unarmed.png err=0\n",
  );
  await writeText(
    join(dir, "rendered-armed", "godot.log"),
    "[grc] decision: armed vptr_written=true\n[fixture] screenshot saved=/x/armed.png err=0\n",
  );
  await writeJson(join(dir, "rendered-armed", "evidence", "result.json"), {
    status: "armed",
    vptr_written: true,
    disarmed: true,
    display_server: "X11",
  });
  await writeJson(join(dir, "rendered-armed", "evidence", "counters.json"), {
    frames_total: 400,
    frames_armed: 400,
    counts: {
      canvas_item_add_rect: 800,
      canvas_item_add_polygon: 400,
      canvas_item_add_texture_rect_region: 17,
      ...optionalCounts(expected, 400),
    },
  });
  await writeJson(join(dir, "rendered-armed", "evidence", "disarm.json"), {
    disarmed: true,
    vptr_was_shadow: true,
    vptr_restored: true,
    frame: 400,
  });

  // old-record: a calibrator-1 record armed with every optional hook left out.
  const oldDir = join(dir, "old-record", "evidence");
  await writeJson(join(oldDir, "result.json"), {
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
  });
  await writeJson(join(oldDir, "disarm.json"), {
    disarmed: true,
    vptr_was_shadow: true,
    vptr_restored: true,
    frame: 60,
  });
  await writeJson(join(oldDir, "counters.json"), {
    frames_total: 400,
    frames_armed: 60,
    hooks_planned: [
      "canvas_item_add_rect",
      "canvas_item_add_texture_rect",
      "canvas_item_add_texture_rect_region",
      "canvas_item_add_msdf_texture_rect_region",
      "canvas_item_add_polygon",
      "texture_2d_create",
      "texture_2d_update",
      "free",
    ],
    hooks_omitted: expected.optional_hooks,
    counts: {
      canvas_item_add_rect: 62,
      canvas_item_add_polygon: 61,
      ...optionalCounts(expected, null),
    },
    captured: {},
  });
  await writeJson(join(oldDir, "calibration-check.json"), {
    checks: [
      {
        name: "hook_plan",
        ok: true,
        detail: `8 of 42 hooks named by the record; omitted (record predates them): ${expected.optional_hooks.join(",")}`,
      },
    ],
  });
}

interface Scenario {
  name: string;
  build: (dir: string, expected: ExpectedJson) => Promise<void>;
  run: (dir: string, expected: ExpectedJson) => Promise<Criterion[]>;
  /** id -> expected status, for every criterion this scenario cares about. Criteria this scenario
   * doesn't mention are not checked (building a full tree for every group per scenario would just
   * duplicate buildGoodEvidence's coverage without adding confidence). */
  expect: Record<string, Criterion["status"]>;
}

const scenarios: Scenario[] = [
  {
    name: "good evidence passes everything it covers",
    build: buildGoodEvidence,
    run: async (dir, expected) => [
      await checkFrameCallbackTicked(dir),
      await checkHeadlessNoGpu(dir),
      ...(await checkValidateAndRefusals(dir)),
      ...(await checkCaptureCounts(dir, expected)),
      await checkPolygonBitExact(dir, expected),
      ...(await checkDisarmAndCompletion(dir)),
      ...(await checkPixelParity(dir, expected)),
      await checkRenderedLegs(dir, expected),
      await checkNoMprotectAfterArm(dir),
      ...(await checkDrawPaths(dir, expected)),
      await checkNewDrawingsVisible(dir, expected),
      await checkOlderRecord(dir, expected),
    ],
    expect: {
      "optional-hook-counts": "pass",
      "triangle-array-bit-exact": "pass",
      "stylebox-panel-native": "pass",
      "shader-material-path": "pass",
      "nine-patch-bit-exact": "pass",
      "scripted-shapes-bit-exact": "pass",
      "mesh-surface-and-draw": "pass",
      "mesh-region-updates": "pass",
      "new-drawings-visible": "pass",
      "older-record-loads": "pass",
      "frame-callback-ticked": "pass",
      "headless-no-gpu": "pass",
      "rendered-legs-armed-and-absent": "pass",
      "validate-no-write": "pass",
      "refuse-sha": "pass",
      "refuse-prefix": "pass",
      "refuse-nocal": "pass",
      "refuse-binary-byte": "pass",
      "colorrect-add-rect": "pass",
      "script-add-rect": "pass",
      "label-glyph-path": "pass",
      "polygon-bit-exact": "pass",
      "disarm-restored": "pass",
      "fixture-completed": "pass",
      "frames-after-disarm": "pass",
      "armed-vs-unarmed-pixels": "pass",
      "unarmed-not-blank": "pass",
      "no-mprotect-after-arm": "pass",
    },
  },
  {
    name: "frames_total below 300 fails the frame-callback criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(
        join(dir, "headless-armed", "evidence", "counters.json"),
        { frames_total: 42 },
      );
    },
    run: async (dir) => [await checkFrameCallbackTicked(dir)],
    expect: { "frame-callback-ticked": "fail" },
  },
  {
    name: "a perturbed bit in counters.json's captured script rect fails the script-add-rect criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const counters = {
        schema: "render-stream-gate-minus1-counters/1",
        frames_total: 400,
        counts: { canvas_item_add_rect: 2 },
        captured: {
          canvas_item_add_rect: [
            {
              item: "colorrect",
              rect_bits: expected.colorrect_add_rect.rect_bits,
              color_bits: expected.colorrect_add_rect.color_bits,
            },
            {
              item: "script",
              // Last hex digit perturbed (0 -> 1): one bit of the mantissa is now wrong.
              rect_bits: [
                expected.script_add_rect.rect_bits[0].slice(0, -1) +
                  (expected.script_add_rect.rect_bits[0].at(-1) === "0"
                    ? "1"
                    : "0"),
                ...expected.script_add_rect.rect_bits.slice(1),
              ],
              color_bits: expected.script_add_rect.color_bits,
            },
          ],
        },
      };
      await writeJson(
        join(dir, "headless-armed", "evidence", "counters.json"),
        counters,
      );
    },
    run: async (dir, expected) => checkCaptureCounts(dir, expected),
    expect: { "colorrect-add-rect": "pass", "script-add-rect": "fail" },
  },
  {
    name: "uvs_count mismatch fails the polygon criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(
        join(dir, "headless-armed", "evidence", "counters.json"),
        {
          frames_total: 400,
          captured: {
            canvas_item_add_polygon: [
              {
                points: expected.script_add_polygon.points,
                point_bits: expected.script_add_polygon.point_bits,
                colors: expected.script_add_polygon.colors,
                color_bits: expected.script_add_polygon.color_bits,
                uvs_count: 3, // expected 0
              },
            ],
          },
        },
      );
    },
    run: async (dir, expected) => [await checkPolygonBitExact(dir, expected)],
    expect: { "polygon-bit-exact": "fail" },
  },
  {
    name: "disarm.json not restored fails the disarm criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "headless-armed", "evidence", "disarm.json"), {
        disarmed: true,
        vptr_was_shadow: true,
        vptr_restored: false,
        frame: 60,
      });
    },
    run: async (dir) => checkDisarmAndCompletion(dir),
    expect: {
      "disarm-restored": "fail",
      "fixture-completed": "pass",
      "frames-after-disarm": "pass",
    },
  },
  {
    name: "fewer than 300 frames after disarm fails that criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "headless-armed", "evidence", "disarm.json"), {
        disarmed: true,
        vptr_was_shadow: true,
        vptr_restored: true,
        frame: 390,
      });
    },
    run: async (dir) => checkDisarmAndCompletion(dir),
    expect: { "disarm-restored": "pass", "frames-after-disarm": "fail" },
  },
  {
    name: "a one-pixel-different armed.png fails the pixel-parity criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeScenePng(join(dir, "rendered-armed", "armed.png"), {
        perturbPixel: [300, 300],
      });
    },
    run: async (dir, expected) => checkPixelParity(dir, expected),
    expect: { "armed-vs-unarmed-pixels": "fail", "unarmed-not-blank": "pass" },
  },
  {
    name: "a blank unarmed.png fails the not-blank sanity criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeScenePng(join(dir, "rendered-unarmed", "unarmed.png"), {
        blank: true,
      });
      await writeScenePng(join(dir, "rendered-armed", "armed.png"), {
        blank: true,
      });
    },
    run: async (dir, expected) => checkPixelParity(dir, expected),
    // Both PNGs are blank but still byte-identical to each other, so the parity check passes and
    // the dedicated blank-sanity check is the one that must catch this.
    expect: { "armed-vs-unarmed-pixels": "pass", "unarmed-not-blank": "fail" },
  },
  {
    name: "validate leg reporting armed (not validated) fails that criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(
        join(dir, "headless-validate", "evidence", "result.json"),
        {
          status: "armed",
          vptr_written: true,
        },
      );
    },
    run: async (dir) => checkValidateAndRefusals(dir),
    expect: { "validate-no-write": "fail" },
  },
  {
    name: "a refusal leg with vptr_written:true fails its criterion even with the right reason",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "refuse-sha", "evidence", "result.json"), {
        status: "refused",
        reason: "fingerprint-mismatch",
        vptr_written: true,
      });
    },
    run: async (dir) => checkValidateAndRefusals(dir),
    expect: { "refuse-sha": "fail" },
  },
  {
    name: "a wrong refusal reason fails its criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "refuse-prefix", "evidence", "result.json"), {
        status: "refused",
        reason: "fingerprint-mismatch", // expected slot-mask-mismatch
        vptr_written: false,
      });
    },
    run: async (dir) => checkValidateAndRefusals(dir),
    expect: { "refuse-prefix": "fail" },
  },
  {
    name: "an mprotect after arm intersecting the exe mapping fails the no-mprotect criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "headless-armed", "strace.txt"),
        [
          '10:00:01.000000 openat(AT_FDCWD, "/tmp/evidence/armed.marker", O_WRONLY|O_CREAT, 0666) = 7',
          // Inside the fabricated exe_maps range [0x555500000000, 0x555500100000).
          "10:00:02.000000 mprotect(0x555500001000, 4096, PROT_READ|PROT_EXEC) = 0",
          "",
        ].join("\n"),
      );
    },
    run: async (dir) => [await checkNoMprotectAfterArm(dir)],
    expect: { "no-mprotect-after-arm": "fail" },
  },
  {
    name: "strace unavailable reports the no-mprotect criterion as unavailable, not pass or fail",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "headless-armed", "strace-status.txt"),
        "unavailable\n",
      );
    },
    run: async (dir) => [await checkNoMprotectAfterArm(dir)],
    expect: { "no-mprotect-after-arm": "unavailable" },
  },
  {
    name: "a GPU library in the headless host's maps fails the headless-no-gpu criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "headless-armed", "maps.txt"),
        "7f0000000000-7f0000001000 r-xp 00000000 103:09 3 /usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0\n",
      );
    },
    run: async (dir) => [await checkHeadlessNoGpu(dir)],
    expect: { "headless-no-gpu": "fail" },
  },
  {
    name: "a split successful openat of /dev/dri fails the headless-no-gpu criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "headless-armed", "strace.txt"),
        [
          '42 10:00:00.000000 openat(AT_FDCWD, "/dev/dri/renderD128", O_RDWR <unfinished ...>',
          "43 10:00:00.000001 mprotect(0x7fdead000000, 4096, PROT_READ) = 0",
          "42 10:00:00.000002 <... openat resumed>) = 9",
          '42 10:00:01.000000 openat(AT_FDCWD, "/tmp/evidence/armed.marker", O_WRONLY|O_CREAT, 0666) = 7',
          "",
        ].join("\n"),
      );
    },
    run: async (dir) => [
      await checkHeadlessNoGpu(dir),
      await checkNoMprotectAfterArm(dir),
    ],
    expect: { "headless-no-gpu": "fail", "no-mprotect-after-arm": "pass" },
  },
  {
    name: "a failed GPU probe (= -1 ENOENT) does not fail the headless-no-gpu criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "headless-armed", "strace.txt"),
        [
          '42 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/libvulkan.so.1", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
          '42 10:00:01.000000 openat(AT_FDCWD, "/tmp/evidence/armed.marker", O_WRONLY|O_CREAT, 0666) = 7',
          "",
        ].join("\n"),
      );
    },
    run: async (dir) => [await checkHeadlessNoGpu(dir)],
    expect: { "headless-no-gpu": "pass" },
  },
  {
    name: "a headless host reporting display server X11 fails the headless-no-gpu criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "headless-armed", "evidence", "result.json"), {
        status: "armed",
        vptr_written: true,
        display_server: "X11",
      });
    },
    run: async (dir) => [await checkHeadlessNoGpu(dir)],
    expect: { "headless-no-gpu": "fail" },
  },
  {
    name: "no atlas update at or after the relabel frame fails the label-glyph-path criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const countersPath = join(
        dir,
        "headless-armed",
        "evidence",
        "counters.json",
      );
      const counters = JSON.parse(
        await (await import("node:fs/promises")).readFile(countersPath, "utf8"),
      ) as { captured: { texture_2d_update: Array<{ frame: number }> } };
      counters.captured.texture_2d_update = [
        { frame: expected.label_glyphs.relabel_frame - 1 },
      ];
      await writeJson(countersPath, counters);
    },
    run: async (dir, expected) => checkCaptureCounts(dir, expected),
    expect: { "label-glyph-path": "fail", "colorrect-add-rect": "pass" },
  },
  {
    name: "a rendered-armed leg that refused fails the rendered-legs criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "rendered-armed", "evidence", "result.json"), {
        status: "refused",
        reason: "fingerprint-mismatch",
        vptr_written: false,
        display_server: "X11",
      });
    },
    run: async (dir, expected) => [
      ...(await checkPixelParity(dir, expected)),
      await checkRenderedLegs(dir, expected),
    ],
    expect: {
      "armed-vs-unarmed-pixels": "pass",
      "rendered-legs-armed-and-absent": "fail",
    },
  },
  {
    name: "a rendered-unarmed leg that loaded the extension fails the rendered-legs criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeText(
        join(dir, "rendered-unarmed", "godot.log"),
        "[grc] decision: validated vptr_written=false\n[fixture] extension load status=OK (0) path=/x\n[fixture] screenshot saved=/x/unarmed.png err=0\n",
      );
    },
    run: async (dir, expected) => [await checkRenderedLegs(dir, expected)],
    expect: { "rendered-legs-armed-and-absent": "fail" },
  },
  {
    name: "fingerprint.json without exe_maps fails (not skips) the no-mprotect criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(
        join(dir, "headless-armed", "evidence", "fingerprint.json"),
        { pid: 12345 },
      );
    },
    run: async (dir) => [await checkNoMprotectAfterArm(dir)],
    expect: { "no-mprotect-after-arm": "fail" },
  },
  {
    name: "one perturbed triangle-array point bit fails only the triangle-array criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      const entry = counters.captured.canvas_item_add_triangle_array[0];
      const points = entry.point_bits as string[][];
      // 120.75 -> its float32 neighbour: one mantissa bit.
      points[1] = [points[1][0].replace(/0$/, "1"), points[1][1]];
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: {
      "triangle-array-bit-exact": "fail",
      "stylebox-panel-native": "pass",
      "nine-patch-bit-exact": "pass",
      "mesh-surface-and-draw": "pass",
    },
  },
  {
    name: "a vertex-region update captured at the wrong byte offset fails the mesh-region criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.captured.mesh_surface_update_vertex_region[0].offset = 0;
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: {
      "mesh-region-updates": "fail",
      "mesh-surface-and-draw": "pass",
    },
  },
  {
    name: "a vertex-region update seen once instead of once per frame fails the mesh-region criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.captured.mesh_surface_update_vertex_region[0].calls = 1;
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: { "mesh-region-updates": "fail" },
  },
  {
    name: "a nine-patch whose stack-passed draw_center decoded wrong fails the nine-patch criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.captured.canvas_item_add_nine_patch[0].draw_center = true;
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: {
      "nine-patch-bit-exact": "fail",
      "triangle-array-bit-exact": "pass",
    },
  },
  {
    name: "add_mesh of a mesh that was never mesh_create'd fails the mesh-surface criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.captured.canvas_item_add_mesh[0].mesh = "elsewhere";
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: { "mesh-surface-and-draw": "fail" },
  },
  {
    name: "an optional hook that never fired fails the optional-hook-counts criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "headless-armed", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.counts.canvas_item_add_multimesh = 0;
      await writeJson(path, counters);
    },
    run: async (dir, expected) => checkDrawPaths(dir, expected),
    expect: { "optional-hook-counts": "fail" },
  },
  {
    name: "a render missing the mesh drawn with the moved vertex fails the new-drawings criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      for (const [leg, file] of [
        ["rendered-unarmed", "unarmed.png"],
        ["rendered-armed", "armed.png"],
      ] as const) {
        await writeScenePng(join(dir, leg, file), {
          omitDrawing: "moved_mesh_vertex",
        });
      }
    },
    run: async (dir, expected) => [
      ...(await checkPixelParity(dir, expected)),
      await checkNewDrawingsVisible(dir, expected),
    ],
    // Both renders lack it alike, so parity still passes; the visibility check catches it.
    expect: {
      "armed-vs-unarmed-pixels": "pass",
      "unarmed-not-blank": "pass",
      "new-drawings-visible": "fail",
    },
  },
  {
    name: "an older record that refused instead of arming fails the older-record criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      await writeJson(join(dir, "old-record", "evidence", "result.json"), {
        status: "refused",
        reason: "slot-mask-mismatch",
        vptr_written: false,
      });
    },
    run: async (dir, expected) => [await checkOlderRecord(dir, expected)],
    expect: { "older-record-loads": "fail" },
  },
  {
    name: "an older record whose omitted hook still reports a count fails the older-record criterion",
    build: async (dir, expected) => {
      await buildGoodEvidence(dir, expected);
      const path = join(dir, "old-record", "evidence", "counters.json");
      const counters = await readCounters(path);
      counters.counts.mesh_create = 0;
      await writeJson(path, counters);
    },
    run: async (dir, expected) => [await checkOlderRecord(dir, expected)],
    expect: { "older-record-loads": "fail" },
  },
];

async function main(): Promise<void> {
  const expected = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      join(EXPERIMENT_DIR, "fixtures/spike/expected.json"),
      "utf8",
    ),
  ) as ExpectedJson;

  let failures = 0;
  let checkedCriteria = 0;

  for (const scenario of scenarios) {
    const dir = await mkdtemp(join(tmpdir(), "gate-minus1-self-test-"));
    try {
      await scenario.build(dir, expected);
      const results = await scenario.run(dir, expected);
      const byId = new Map(results.map((r) => [r.id, r]));

      for (const [id, expectedStatus] of Object.entries(scenario.expect)) {
        checkedCriteria++;
        const actual = byId.get(id);
        if (!actual) {
          failures++;
          console.error(
            `[SELF-TEST FAIL] ${scenario.name}: criterion "${id}" was not produced at all`,
          );
          continue;
        }
        if (actual.status !== expectedStatus) {
          failures++;
          console.error(
            `[SELF-TEST FAIL] ${scenario.name}: criterion "${id}" was ${actual.status}, expected ${expectedStatus} (detail: ${actual.detail ?? "<none>"})`,
          );
        } else {
          console.log(
            `[SELF-TEST OK] ${scenario.name}: "${id}" is ${actual.status} as expected`,
          );
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log(
    `\nself-test-checker: ${checkedCriteria - failures}/${checkedCriteria} criterion assertions correct across ${scenarios.length} scenarios`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
