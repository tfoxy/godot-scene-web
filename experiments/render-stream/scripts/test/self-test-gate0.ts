#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 0 checker (lib/gate0-checks.ts). Proves that every check can fail as
// well as pass, and that classifyLeg yields all five classes with the specified precedence.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate0.ts
//
// 1. classifyLeg unit cases (pure): every class alone, every pair of classes (the earlier one in
//    the precedence wins and both reasons are listed), each sub-rule of rules 1 and 3, rules 3-4
//    skipped without a receiver, and session.sabotage ignored.
// 2. Evidence-tree scenarios: a fabricated passing tree for the whole runner layout (recordings
//    encoded here in render-stream/0 bytes, PNGs synthesized from the timeline), then one
//    perturbation per failure mode. Each scenario runs the real runGate0 and asserts the verdict
//    of the checks and leg classes it targets.
// 3. Helpers the runner uses: corruptTransactionMeta reproduces golden/corrupt-meta.bin from
//    golden/minimal.bin byte for byte; joinSettleSeqs fails on a missing frame.
//
// Exits non-zero if any assertion fails.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  CLASS_PRECEDENCE,
  CLASSIFIED_LEGS,
  type ClassifiedLeg,
  type ClassifyInput,
  classifyLeg,
  corruptTransactionMeta,
  GATE0_FEATURES,
  GATE0_HOOKS,
  type Gate0Context,
  type Gate0Expected,
  type Gate0Report,
  joinSettleSeqs,
  LEG_EXPECTATIONS,
  type LegClass,
  runGate0,
  SUPPORT_LEGS,
  summarizeRecording,
  type Transaction,
} from "../lib/gate0-checks";
import { synthesizeExpected } from "../lib/gate0-expected";
import { validateRecording } from "../lib/render-stream-0";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");
const GOLDEN_DIR = join(EXPERIMENT_DIR, "protocol", "golden");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) {
    console.log(`[SELF-TEST OK] ${name}`);
  } else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The gate 0 timeline (gate0-design.md "Timeline"), in the render-stream-gate0-expected/1 shape.
// ---------------------------------------------------------------------------------------------

const to8 = (c: number): number => Math.round(c * 255);
function shape(
  pos: [number, number],
  size: [number, number],
  color: [number, number, number],
) {
  return {
    rect_px: [pos[0], pos[1], size[0], size[1]] as [
      number,
      number,
      number,
      number,
    ],
    color: [...color, 1] as [number, number, number, number],
    rgba8: [to8(color[0]), to8(color[1]), to8(color[2]), 255] as [
      number,
      number,
      number,
      number,
    ],
  };
}
const SUBJECT_SIZE: [number, number] = [96, 64];
const MARKER_SIZE: [number, number] = [32, 32];
const TIMELINE: Array<{
  pos: [number, number];
  subject: [number, number, number];
  marker: [number, number, number];
}> = [
  { pos: [160, 96], subject: [1, 0.4, 0], marker: [1, 1, 1] },
  { pos: [288, 96], subject: [1, 0.4, 0], marker: [1, 1, 0] },
  { pos: [288, 96], subject: [0, 0.6, 1], marker: [0, 1, 1] },
  { pos: [416, 224], subject: [0.8, 0.2, 0.6], marker: [1, 0, 1] },
  { pos: [416, 224], subject: [0.8, 0.2, 0.6], marker: [0, 1, 0] },
];
const EXPECTED = {
  schema: "render-stream-gate0-expected/1",
  viewport: [640, 360],
  clear_rgba8: [51, 51, 102, 255],
  quit_frame_default: 52,
  steps: TIMELINE.map((t, k) => ({
    step: k,
    applied_frame: k === 0 ? 1 : 10 * k + 1,
    settle_frame: 10 * k + 8,
    subject: shape(t.pos, SUBJECT_SIZE, t.subject),
    marker: shape([16, 16], MARKER_SIZE, t.marker),
  })),
  unsupported_variant: { from_step: 2, op: "canvas_item_add_circle" },
} as unknown as Gate0Expected;

// ---------------------------------------------------------------------------------------------
// A test-side render-stream/0 encoder (canonical meta: objects built in key order, blocks last).
// ---------------------------------------------------------------------------------------------

const MAGIC = Buffer.from([0x47, 0x52, 0x53, 0x30, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodeRecord(
  meta: Record<string, unknown>,
  blocks: number[][],
): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), "ascii");
  const recordLen =
    8 + metaBytes.length + blocks.reduce((n, b) => n + 4 + 4 * b.length, 0);
  const out = Buffer.alloc(4 + recordLen);
  let p = out.writeUInt32LE(recordLen, 0);
  p = out.writeUInt32LE(metaBytes.length, p);
  p += metaBytes.copy(out, p);
  p = out.writeUInt32LE(blocks.length, p);
  for (const block of blocks) {
    p = out.writeUInt32LE(4 * block.length, p);
    for (const v of block) p = out.writeFloatLE(v, p);
  }
  return out;
}

const blockSpecs = (names: string[], blocks: number[][]) =>
  names.map((name, i) => ({ name, type: "f32", count: blocks[i].length }));

interface RecordingOptions {
  quit: number;
  variant?: "unsupported";
  preexisting?: boolean;
  sabotage?: { kind: string; frame: number } | null;
  hooksPlanned?: string[];
  /** publish step `step`'s change `frames` frames late */
  delay?: { step: number; frames: number };
  /** drop the end record */
  noEnd?: boolean;
}

function encodeRecording(opts: RecordingOptions): Buffer {
  const sessionBlocks = [
    [0.2, 0.2, 0.4, 1],
    [1, 0, 0, 1, 0, 0],
    [0, 0, 0, 0],
  ];
  const session = encodeRecord(
    {
      type: "session",
      protocol: "render-stream/0",
      session_id: "0123456789abcdef0123456789abcdef",
      engine: {
        version_string: "Godot Engine v4.5.1.stable.official",
        sha256:
          "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c",
        display_server: "headless",
        rendering_driver: "opengl3",
        rendering_method: "gl_compatibility",
      },
      capture: {
        calibrator_version: 3,
        hooks_planned: opts.hooksPlanned ?? [...GATE0_HOOKS],
        hooks_omitted: [],
      },
      viewport: { canvas_cull_mask: 4294967295, root_canvas: 1 },
      features: JSON.parse(JSON.stringify(GATE0_FEATURES)),
      sabotage: opts.sabotage ?? null,
      blocks: blockSpecs(
        ["clear_color", "root_canvas_xform", "host_visible_rect"],
        sessionBlocks,
      ),
    },
    sessionBlocks,
  );
  const records: Buffer[] = [session];
  const applied = (k: number): number =>
    EXPECTED.steps[k].applied_frame +
    (opts.delay?.step === k ? opts.delay.frames : 0);
  for (let frame = 1; frame <= opts.quit; frame++) {
    let k = 0;
    for (let j = 0; j < EXPECTED.steps.length; j++)
      if (applied(j) <= frame) k = j;
    const s = EXPECTED.steps[k];
    const circle = opts.variant === "unsupported" && k >= 2;
    const item = (
      id: number,
      drawIndex: number,
      version: number,
      commands: unknown[],
    ) => ({
      id,
      origin: "created",
      parent: { kind: "canvas", id: 1 },
      children: [],
      visible: true,
      draw_index: drawIndex,
      z_index: 0,
      clip: false,
      custom_rect: false,
      visibility_layer: 1,
      content_version: version,
      commands,
    });
    const blocks = [
      [
        ...[1, 0, 0, 1, s.subject.rect_px[0], s.subject.rect_px[1]],
        ...[1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
        ...[1, 0, 0, 1, s.marker.rect_px[0], s.marker.rect_px[1]],
        ...[1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
      ],
      [1, 0, 0, 1, 0, 0],
      [
        0,
        0,
        SUBJECT_SIZE[0],
        SUBJECT_SIZE[1],
        ...s.subject.color,
        0,
        0,
        MARKER_SIZE[0],
        MARKER_SIZE[1],
        ...s.marker.color,
      ],
    ];
    records.push(
      encodeRecord(
        {
          type: "transaction",
          seq: frame,
          frame,
          status: opts.preexisting ? "capture-failure" : "ok",
          failures: opts.preexisting
            ? [
                {
                  reason: "pre-existing-object",
                  detail: "rid=4294967296123 op=canvas_item_set_parent frame=1",
                },
              ]
            : [],
          unsupported: circle
            ? [
                {
                  op: "canvas_item_add_circle",
                  item: 2,
                  reason: "unsupported-op",
                },
              ]
            : [],
          canvases: [
            {
              id: 1,
              origin: "root-query",
              role: "root",
              attached: true,
              items: [1, 2],
            },
          ],
          items: [
            item(1, 1, 1 + Math.min(k, 3), [
              { op: "add_rect", aa: false, f: 0 },
            ]),
            item(2, 2, 1 + k, [
              { op: "add_rect", aa: false, f: 8 },
              ...(circle
                ? [{ op: "unsupported", name: "canvas_item_add_circle" }]
                : []),
            ]),
          ],
          blocks: blockSpecs(["item_f32", "canvas_f32", "cmd_f32"], blocks),
        },
        blocks,
      ),
    );
  }
  const bytesTotal = MAGIC.length + records.reduce((n, r) => n + r.length, 0);
  const maxRecord = Math.max(...records.map((r) => r.length));
  if (!opts.noEnd) {
    records.push(
      encodeRecord(
        {
          type: "end",
          transactions: opts.quit,
          reason: "shutdown",
          stats: {
            bytes_total: bytesTotal,
            encode_ns_total: 1000 * opts.quit,
            snapshot_ns_total: 100 * opts.quit,
            max_record_bytes: maxRecord,
          },
          blocks: [],
        },
        [],
      ),
    );
  }
  return Buffer.concat([MAGIC, ...records]);
}

// ---------------------------------------------------------------------------------------------
// Evidence-tree writers
// ---------------------------------------------------------------------------------------------

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writePng(
  path: string,
  step: number,
  perturb?: [number, number],
): Promise<void> {
  const { width, height, rgba } = synthesizeExpected(EXPECTED, step);
  const buf = Buffer.from(rgba);
  if (perturb) buf[(perturb[1] * width + perturb[0]) * 4] ^= 0x10;
  await mkdir(dirname(path), { recursive: true });
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path);
}

async function writeProcess(
  dir: string,
  argv: string[],
  env: string[],
  stdout: string,
  exitCode: number,
): Promise<void> {
  await writeText(join(dir, "argv.txt"), `${argv.join("\n")}\n`);
  await writeText(join(dir, "env.txt"), `${env.join("\n")}\n`);
  await writeText(join(dir, "stdout.log"), stdout);
  await writeText(join(dir, "exit-code.txt"), `${exitCode}\n`);
}

function settleSeqs(transactions: readonly Transaction[]): number[] {
  return EXPECTED.steps.map(
    (s) =>
      transactions.find((t) => t.meta.frame === s.settle_frame)?.meta.seq ?? -1,
  );
}

function appliedFor(
  recordingPath: string,
  bytes: Buffer,
  shotSeqs: number[],
  shotsDir: string,
): Record<string, unknown> {
  const summary = summarizeRecording(recordingPath, new Uint8Array(bytes));
  return {
    schema: "render-stream-receiver-applied/1",
    recording: {
      path: recordingPath,
      sha256: summary.sha256,
      bytes: summary.bytes,
    },
    session_id: "0123456789abcdef0123456789abcdef",
    status: "ok",
    failure: null,
    end_seen: true,
    viewport: {
      display_server: shotSeqs.length > 0 ? "X11" : "headless",
      size: shotSeqs.length > 0 ? [640, 360] : [0, 0],
      size_check: shotSeqs.length > 0 ? "ok" : "skipped-headless",
      canvas_transform: [1, 0, 0, 1, 0, 0],
    },
    transactions: summary.transactions.map((t, i) => ({
      seq: t.meta.seq,
      frame: t.meta.frame,
      record_sha256: t.sha256,
      process_frame: i + 2,
      created: i === 0 ? 2 : 0,
      freed: 0,
      reparented: i === 0 ? 2 : 0,
      commands_replayed: 2,
      rs_calls: 4,
    })),
    shots: shotSeqs.map((seq) => ({
      seq,
      path: join(shotsDir, `seq-${seq}.png`),
      process_frame: seq + 2,
      applied_through: seq,
    })),
    unsupported: [],
  };
}

interface Projects {
  receiverProjectDir: string;
  fixtureProjectDir: string;
}

async function writeProjects(root: string): Promise<Projects> {
  const fixtureProjectDir = join(
    root,
    "experiments",
    "render-stream",
    "fixtures",
    "gate0",
  );
  const receiverProjectDir = join(
    root,
    "experiments",
    "render-stream",
    "receiver",
  );
  await writeText(
    join(fixtureProjectDir, "project.godot"),
    'config/name="gate0 fixture"\n',
  );
  await writeText(
    join(fixtureProjectDir, "gate0.gd"),
    "extends Node\n# fixture\n",
  );
  await writeText(
    join(fixtureProjectDir, ".godot", "shared.cache"),
    "identical\n",
  );
  await writeText(
    join(receiverProjectDir, "project.godot"),
    'config/name="gate0 receiver"\n',
  );
  await writeText(
    join(receiverProjectDir, "receiver.gd"),
    "extends Node\n# receiver\n",
  );
  // Byte-identical to the fixture's, but under .godot/, which the check excludes.
  await writeText(
    join(receiverProjectDir, ".godot", "shared.cache"),
    "identical\n",
  );
  return { receiverProjectDir, fixtureProjectDir };
}

async function writeCaptureLeg(
  dir: string,
  opts: RecordingOptions,
  withTrace: boolean,
): Promise<Buffer> {
  const bytes = encodeRecording(opts);
  await writeText(join(dir, "recording.rs0"), "");
  await writeFile(join(dir, "recording.rs0"), bytes);
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    rendering_driver: "opengl3",
    rendering_method: "gl_compatibility",
    stream: {
      path: join(dir, "recording.rs0"),
      status: "closed",
      reason: null,
      transactions: opts.quit,
    },
  });
  await writeJson(join(dir, "evidence", "counters.json"), {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: opts.quit,
    hooks_planned: [...GATE0_HOOKS],
    hooks_omitted: [],
  });
  await writeText(join(dir, "evidence", "armed.marker"), "");
  await writeText(
    join(dir, "steps.jsonl"),
    EXPECTED.steps
      .map((s) =>
        JSON.stringify({
          step: s.step,
          applied_frame: s.applied_frame,
          settle_frame: s.settle_frame,
        }),
      )
      .join("\n")
      .concat("\n"),
  );
  await writeProcess(
    dir,
    ["/tpl/linux_release.x86_64", "--headless", "--path", "/fixture"],
    ["GRC_MODE=arm", `GRC_STREAM_OUT=${join(dir, "recording.rs0")}`],
    "[fixture] extension load status=0\n",
    0,
  );
  if (withTrace) {
    await writeText(
      join(dir, "strace.txt"),
      [
        '42 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
        '42 10:00:00.100000 openat(AT_FDCWD, "/usr/lib/libvulkan.so.1", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
        `42 10:00:00.200000 openat(AT_FDCWD, "${join(dir, "evidence", "armed.marker")}", O_WRONLY|O_CREAT, 0666) = 7`,
        "",
      ].join("\n"),
    );
    await writeText(
      join(dir, "maps.txt"),
      "55d000000000-55d000001000 r-xp 00000000 103:09 1 /tpl/linux_release.x86_64\n",
    );
    await writeText(
      join(dir, "fd.txt"),
      "lrwx------ 1 u u 64 Oct  9 10:00 0 -> /dev/null\n",
    );
  }
  return bytes;
}

async function writeReceiverProcess(
  dir: string,
  projects: Projects,
  bytes: Buffer,
  shotSeqs: number[],
  rendered: boolean,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "recording.rs0"), bytes);
  await writeJson(
    join(dir, "applied.json"),
    appliedFor(join(dir, "recording.rs0"), bytes, shotSeqs, join(dir, "shots")),
  );
  await writeProcess(
    dir,
    rendered
      ? [
          "/tpl/linux_release.x86_64",
          "--path",
          projects.receiverProjectDir,
          "--rendering-driver",
          "opengl3",
          "--display-driver",
          "x11",
        ]
      : [
          "/tpl/linux_release.x86_64",
          "--headless",
          "--path",
          projects.receiverProjectDir,
        ],
    [
      `RS_RECEIVER_RECORDING=${join(dir, "recording.rs0")}`,
      `RS_RECEIVER_OUT=${join(dir, "applied.json")}`,
    ],
    "[receiver] ok\n",
    0,
  );
}

/** The receiver-headless-trace strace embeds its own leg path, so it is (re)written per tree. */
async function writeTraceStrace(
  out: string,
  projects: Projects,
): Promise<void> {
  const leg = join(out, "receiver-headless-trace");
  await writeText(
    join(leg, "strace.txt"),
    [
      `42 10:00:00.000000 openat(AT_FDCWD, "${projects.receiverProjectDir}/project.godot", O_RDONLY|O_CLOEXEC) = 3`,
      `42 10:00:00.100000 openat(AT_FDCWD, "${projects.fixtureProjectDir}/gate0.tscn", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)`,
      `42 10:00:00.200000 openat(AT_FDCWD, "${join(leg, "recording.rs0")}", O_RDONLY|O_CLOEXEC) = 4`,
      "",
    ].join("\n"),
  );
}

async function buildGoodTree(out: string, projects: Projects): Promise<void> {
  await writeJson(join(out, "binary.json"), {
    path: "/tpl/linux_release.x86_64",
    sha256: "54cc",
  });
  for (const p of ["fixture", "receiver"]) {
    await writeProcess(
      join(out, "import", p),
      ["mise", "exec", "--", "godot", "--import"],
      [],
      "import ok\n",
      0,
    );
  }
  await writeProcess(
    join(out, "receiver-typecheck", "selftest"),
    [
      "mise",
      "exec",
      "--",
      "godot",
      "--headless",
      "--path",
      projects.receiverProjectDir,
      "--script",
      "res://tests/codec_selftest.gd",
    ],
    [],
    "[rs0-selftest] ok\n",
    0,
  );
  const minimalDir = join(out, "receiver-typecheck", "minimal");
  const minimal = await readFile(join(GOLDEN_DIR, "minimal.bin"));
  await writeReceiverProcess(minimalDir, projects, minimal, [], false);
  const minimalApplied = await readJsonFile<Record<string, unknown>>(
    join(minimalDir, "applied.json"),
  );
  minimalApplied.unsupported = [
    {
      seq: 1,
      item: 2,
      name: "canvas_item_add_circle",
      reason: "unsupported-op",
    },
  ];
  await writeJson(join(minimalDir, "applied.json"), minimalApplied);

  // capture + its receivers
  const capture = await writeCaptureLeg(
    join(out, "capture"),
    { quit: 400 },
    true,
  );
  const captureTx = summarizeRecording(
    "capture",
    new Uint8Array(capture),
  ).transactions;
  const seqs = settleSeqs(captureTx);
  await writeReceiverProcess(
    join(out, "receiver"),
    projects,
    capture,
    seqs,
    true,
  );
  for (const [k, seq] of seqs.entries()) {
    await writePng(join(out, "receiver", "shots", `seq-${seq}.png`), k);
  }
  await writeReceiverProcess(
    join(out, "receiver-headless-trace"),
    projects,
    capture,
    [],
    false,
  );
  await writeTraceStrace(out, projects);

  // reference
  const ref = join(out, "reference");
  for (const s of EXPECTED.steps)
    await writePng(join(ref, "shots", `step-${s.step}.png`), s.step);
  await writeText(
    join(ref, "steps.jsonl"),
    `${EXPECTED.steps.map((s) => JSON.stringify({ step: s.step, applied_frame: s.applied_frame, settle_frame: s.settle_frame })).join("\n")}\n`,
  );
  await writeProcess(
    ref,
    ["/tpl/linux_release.x86_64", "--path", projects.fixtureProjectDir],
    ["RS_FIXTURE_SHOT_DIR=shots"],
    "[fixture] shot step=0\n",
    0,
  );

  // sabotage legs: steps 0-1 right, the sabotaged steps show a stale (step 1) frame
  const sabotage: Array<[string, string, number[]]> = [
    ["sabotage-freeze", "freeze-frame", [2, 3, 4]],
    ["sabotage-omit", "omit-update", [2]],
    ["sabotage-perturb", "perturb-transform", [2, 3, 4]],
  ];
  for (const [leg, kind, bad] of sabotage) {
    const bytes = await writeCaptureLeg(
      join(out, leg, "capture"),
      { quit: 52, sabotage: { kind, frame: 21 } },
      false,
    );
    const tx = summarizeRecording(leg, new Uint8Array(bytes)).transactions;
    const legSeqs = settleSeqs(tx);
    await writeReceiverProcess(
      join(out, leg, "receiver"),
      projects,
      bytes,
      legSeqs,
      true,
    );
    for (const [k, seq] of legSeqs.entries()) {
      await writePng(
        join(out, leg, "receiver", "shots", `seq-${seq}.png`),
        bad.includes(k) ? 1 : k,
      );
    }
  }

  // unsupported: the circle from step 2, reported by the receiver
  const unsupportedBytes = await writeCaptureLeg(
    join(out, "unsupported", "capture"),
    { quit: 52, variant: "unsupported" },
    false,
  );
  await writeReceiverProcess(
    join(out, "unsupported", "receiver"),
    projects,
    unsupportedBytes,
    [],
    false,
  );
  const ua = await readJsonFile<Record<string, unknown>>(
    join(out, "unsupported", "receiver", "applied.json"),
  );
  ua.unsupported = [
    {
      seq: 21,
      item: 2,
      name: "canvas_item_add_circle",
      reason: "unsupported-op",
    },
  ];
  await writeJson(join(out, "unsupported", "receiver", "applied.json"), ua);

  // preexisting
  await writeCaptureLeg(
    join(out, "preexisting"),
    { quit: 52, preexisting: true },
    false,
  );

  // corrupt: seq 3's meta broken; the receiver stops there
  const corruptDir = join(out, "corrupt");
  await writeReceiverProcess(
    corruptDir,
    projects,
    Buffer.from(corruptTransactionMeta(new Uint8Array(capture), 3)),
    [],
    false,
  );
  const ca = await readJsonFile<Record<string, unknown>>(
    join(corruptDir, "applied.json"),
  );
  ca.status = "replay-failure";
  ca.failure = {
    seq: 3,
    reason: "meta-json",
    detail: "record 3: meta is not JSON",
  };
  ca.end_seen = false;
  ca.transactions = (ca.transactions as unknown[]).slice(0, 2);
  await writeJson(join(corruptDir, "applied.json"), ca);
  await writeText(join(corruptDir, "exit-code.txt"), "3\n");
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

interface Scenario {
  name: string;
  mutate?: (out: string, projects: Projects) => Promise<void>;
  checks?: Record<string, boolean>;
  classes?: Partial<Record<ClassifiedLeg, LegClass>>;
  report?: (report: Gate0Report) => void;
}

async function editJson<T>(
  path: string,
  edit: (value: T) => void,
): Promise<void> {
  const value = await readJsonFile<T>(path);
  edit(value);
  await writeJson(path, value);
}

type Applied = {
  status: string;
  end_seen: boolean;
  failure: unknown;
  recording: { sha256: string };
  transactions: { seq: number; record_sha256: string }[];
  shots: { seq: number; applied_through: number }[];
  unsupported: unknown[];
};

const ALL_CHECK_IDS = [
  "capture-armed",
  "headless-no-gpu",
  "recording-decodes",
  "manifest-present",
  "step-alignment",
  "expected-image-reference",
  "expected-image-receiver",
  "receiver-vs-reference",
  "receiver-consumed-stream",
  "receiver-never-loaded-fixture",
  "receiver-typed-clean",
  ...CLASSIFIED_LEGS.map((leg) => `leg-class-${leg}`),
];

const scenarios: Scenario[] = [
  {
    name: "the good tree passes every check, every leg at its expected class",
    checks: Object.fromEntries(ALL_CHECK_IDS.map((id) => [id, true])),
    classes: Object.fromEntries(
      CLASSIFIED_LEGS.map((leg) => [leg, LEG_EXPECTATIONS[leg].class]),
    ),
    report: (r) => {
      assert("report: schema", r.schema === "render-stream-gate0-report/1");
      assert("report: gate_passed", r.gate_passed === true);
      assert(
        "report: every leg present, support legs have null classes",
        [...CLASSIFIED_LEGS, ...SUPPORT_LEGS].every((leg) => leg in r.legs) &&
          SUPPORT_LEGS.every(
            (leg) =>
              r.legs[leg].expected_class === null &&
              r.legs[leg].result_class === null,
          ),
      );
      assert("report: corrupt exit_code 3", r.legs.corrupt.exit_code === 3);
      assert(
        "report: 5 checkpoints from the receiver leg with diff images and regions",
        r.checkpoints.length === 5 &&
          r.checkpoints.every(
            (c) =>
              c.diff_png !== null &&
              c.regions.length === 2 &&
              c.mismatched_pixels === 0,
          ),
      );
      assert(
        "report: stream from the capture end record",
        r.stream.transactions === 400 && r.stream.encode_ns_total === 400000,
      );
      assert("report: binary", r.binary.sha256 === "54cc");
      assert(
        "report: preexisting reasons name pre-existing-object",
        r.legs.preexisting.reasons.some((x) =>
          x.includes("pre-existing-object"),
        ),
      );
    },
  },
  {
    name: "counters.json omitting a hook fails capture-armed",
    mutate: (out) =>
      editJson<{ hooks_omitted: string[] }>(
        join(out, "capture", "evidence", "counters.json"),
        (c) => {
          c.hooks_omitted = ["canvas_item_set_z_index"];
        },
      ),
    checks: { "capture-armed": false },
  },
  {
    name: "a session planning 41 hooks fails capture-armed",
    mutate: async (out) => {
      await writeFile(
        join(out, "capture", "recording.rs0"),
        encodeRecording({
          quit: 400,
          hooksPlanned: GATE0_HOOKS.filter((h) => h !== "canvas_create"),
        }),
      );
    },
    checks: { "capture-armed": false, "recording-decodes": true },
  },
  {
    name: "stream.status open fails capture-armed and makes the capture leg capture-failure",
    mutate: (out) =>
      editJson<{ stream: { status: string } }>(
        join(out, "capture", "evidence", "result.json"),
        (r) => {
          r.stream.status = "open";
        },
      ),
    checks: {
      "capture-armed": false,
      "leg-class-capture": false,
      "leg-class-receiver": false,
    },
    classes: {
      capture: "capture-failure",
      receiver: "capture-failure",
      corrupt: "capture-failure",
    },
  },
  {
    name: "a GPU library in the capture host's maps fails headless-no-gpu",
    mutate: (out) =>
      writeText(
        join(out, "capture", "maps.txt"),
        "7f0000000000-7f0000001000 r-xp 00000000 103:09 3 /usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0\n",
      ),
    checks: { "headless-no-gpu": false },
  },
  {
    name: "a missing strace (strace-status.txt) fails headless-no-gpu",
    mutate: (out) =>
      writeText(join(out, "capture", "strace-status.txt"), "unavailable\n"),
    checks: { "headless-no-gpu": false },
  },
  {
    name: "a recording without its end record fails recording-decodes and classifies capture-failure",
    mutate: (out) =>
      writeFile(
        join(out, "capture", "recording.rs0"),
        encodeRecording({ quit: 400, noEnd: true }),
      ),
    checks: { "recording-decodes": false, "leg-class-capture": false },
    classes: { capture: "capture-failure" },
  },
  {
    name: "a 52-transaction capture fails recording-decodes",
    mutate: (out) =>
      writeFile(
        join(out, "capture", "recording.rs0"),
        encodeRecording({ quit: 52 }),
      ),
    checks: { "recording-decodes": false },
  },
  {
    name: "a capture session with sabotage set fails manifest-present (the classifier ignores it)",
    mutate: (out) =>
      writeFile(
        join(out, "capture", "recording.rs0"),
        encodeRecording({
          quit: 400,
          sabotage: { kind: "omit-update", frame: 21 },
        }),
      ),
    checks: { "manifest-present": false, "leg-class-capture": true },
    classes: { capture: "success" },
  },
  {
    name: "a wrong settle frame in capture steps.jsonl fails step-alignment",
    mutate: (out) =>
      writeText(
        join(out, "capture", "steps.jsonl"),
        `${EXPECTED.steps.map((s) => JSON.stringify({ step: s.step, applied_frame: s.applied_frame, settle_frame: s.settle_frame + (s.step === 3 ? 1 : 0) })).join("\n")}\n`,
      ),
    checks: { "step-alignment": false },
  },
  {
    name: "a marker colour published one frame late fails step-alignment",
    mutate: (out) =>
      writeFile(
        join(out, "capture", "recording.rs0"),
        encodeRecording({ quit: 400, delay: { step: 2, frames: 1 } }),
      ),
    checks: { "step-alignment": false, "recording-decodes": true },
  },
  {
    name: "a missing reference steps.jsonl fails step-alignment",
    mutate: (out) => rm(join(out, "reference", "steps.jsonl")),
    checks: { "step-alignment": false },
  },
  {
    name: "one changed reference pixel fails expected-image-reference and receiver-vs-reference",
    mutate: (out) =>
      writePng(join(out, "reference", "shots", "step-3.png"), 3, [5, 5]),
    checks: {
      "expected-image-reference": false,
      "receiver-vs-reference": false,
      "expected-image-receiver": true,
      "leg-class-receiver": false,
    },
    classes: { receiver: "pixel-mismatch" },
  },
  {
    name: "a missing reference shot fails expected-image-reference",
    mutate: (out) => rm(join(out, "reference", "shots", "step-0.png")),
    checks: {
      "expected-image-reference": false,
      "receiver-vs-reference": false,
    },
  },
  {
    name: "one changed receiver pixel inside the marker fails expected-image-receiver and receiver-vs-reference",
    mutate: async (out) => {
      const seq = settleSeqs(
        summarizeRecording(
          "c",
          new Uint8Array(await readFile(join(out, "capture", "recording.rs0"))),
        ).transactions,
      )[4];
      await writePng(
        join(out, "receiver", "shots", `seq-${seq}.png`),
        4,
        [20, 20],
      );
    },
    checks: {
      "expected-image-receiver": false,
      "receiver-vs-reference": false,
      "leg-class-receiver": false,
    },
    report: (r) =>
      assert(
        "report: the marker region of step 4 shows the 1-pixel mismatch",
        r.checkpoints[4].regions.find((x) => x.name === "marker")
          ?.mismatched_pixels === 1 &&
          r.checkpoints[4].regions.find((x) => x.name === "subject")
            ?.mismatched_pixels === 0,
      ),
  },
  {
    name: "reference and receiver wrong in the same pixel: receiver-vs-reference passes, both expected-image checks fail",
    mutate: async (out) => {
      const seq = settleSeqs(
        summarizeRecording(
          "c",
          new Uint8Array(await readFile(join(out, "capture", "recording.rs0"))),
        ).transactions,
      )[1];
      await writePng(
        join(out, "reference", "shots", "step-1.png"),
        1,
        [600, 300],
      );
      await writePng(
        join(out, "receiver", "shots", `seq-${seq}.png`),
        1,
        [600, 300],
      );
    },
    checks: {
      "receiver-vs-reference": true,
      "expected-image-reference": false,
      "expected-image-receiver": false,
    },
  },
  {
    name: "a changed record_sha256 fails receiver-consumed-stream and classifies replay-failure",
    mutate: (out) =>
      editJson<Applied>(join(out, "receiver", "applied.json"), (a) => {
        a.transactions[7].record_sha256 = "0".repeat(64);
      }),
    checks: { "receiver-consumed-stream": false, "leg-class-receiver": false },
    classes: { receiver: "replay-failure" },
  },
  {
    name: "a skipped seq fails receiver-consumed-stream",
    mutate: (out) =>
      editJson<Applied>(join(out, "receiver", "applied.json"), (a) => {
        a.transactions.splice(10, 1);
      }),
    checks: { "receiver-consumed-stream": false },
    classes: { receiver: "replay-failure" },
  },
  {
    name: "a shot taken before its transaction was applied fails receiver-consumed-stream",
    mutate: (out) =>
      editJson<Applied>(join(out, "receiver", "applied.json"), (a) => {
        a.shots[2].applied_through = a.shots[2].seq - 1;
      }),
    checks: { "receiver-consumed-stream": false },
  },
  {
    name: "a recording.sha256 that is not the capture file's fails receiver-consumed-stream",
    mutate: (out) =>
      editJson<Applied>(join(out, "receiver", "applied.json"), (a) => {
        a.recording.sha256 = "f".repeat(64);
      }),
    checks: { "receiver-consumed-stream": false },
  },
  {
    name: "a missing requested shot classifies the receiver replay-failure",
    mutate: async (out) => {
      const seq = settleSeqs(
        summarizeRecording(
          "c",
          new Uint8Array(await readFile(join(out, "capture", "recording.rs0"))),
        ).transactions,
      )[2];
      await rm(join(out, "receiver", "shots", `seq-${seq}.png`));
    },
    checks: { "leg-class-receiver": false, "expected-image-receiver": false },
    classes: { receiver: "replay-failure" },
  },
  {
    name: "a successful openat under fixtures/ fails receiver-never-loaded-fixture",
    mutate: async (out, projects) => {
      await writeTraceStrace(out, projects);
      const path = join(out, "receiver-headless-trace", "strace.txt");
      const text = await readFile(path, "utf8");
      await writeText(
        path,
        `${text}43 10:00:01.000000 openat(AT_FDCWD, "${projects.fixtureProjectDir}/gate0.gd", O_RDONLY|O_CLOEXEC <unfinished ...>\n44 10:00:01.000001 openat(AT_FDCWD, "/dev/null", O_RDONLY) = 9\n43 10:00:01.000002 <... openat resumed>) = 5\n`,
      );
    },
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a trace that never opens the recording fails receiver-never-loaded-fixture",
    mutate: (out) =>
      writeText(
        join(out, "receiver-headless-trace", "strace.txt"),
        '42 10:00:00.000000 openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3\n',
      ),
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a receiver file byte-identical to a fixture file fails receiver-never-loaded-fixture",
    mutate: (_out, projects) =>
      writeText(
        join(projects.receiverProjectDir, "copied.gd"),
        "extends Node\n# fixture\n",
      ),
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a [fixture] line in a sabotage receiver log fails receiver-never-loaded-fixture",
    mutate: (out) =>
      writeText(
        join(out, "sabotage-omit", "receiver", "stdout.log"),
        "[fixture] extension load status=0\n",
      ),
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "argv without --path <abs receiver> fails receiver-never-loaded-fixture",
    mutate: (out) =>
      writeText(
        join(out, "receiver-headless-trace", "argv.txt"),
        "/tpl/linux_release.x86_64\n--headless\n--path\nreceiver\n",
      ),
    checks: { "receiver-never-loaded-fixture": false },
  },
  {
    name: "a SCRIPT WARNING in the selftest log fails receiver-typed-clean",
    mutate: (out) =>
      writeText(
        join(out, "receiver-typecheck", "selftest", "stdout.log"),
        "SCRIPT WARNING: UNTYPED_DECLARATION\n[rs0-selftest] ok\n",
      ),
    checks: { "receiver-typed-clean": false },
  },
  {
    name: "a selftest exiting 1 fails receiver-typed-clean",
    mutate: (out) =>
      writeText(
        join(out, "receiver-typecheck", "selftest", "exit-code.txt"),
        "1\n",
      ),
    checks: { "receiver-typed-clean": false },
  },
  {
    name: "a minimal replay with 2 unsupported fails receiver-typed-clean",
    mutate: (out) =>
      editJson<Applied>(
        join(out, "receiver-typecheck", "minimal", "applied.json"),
        (a) => {
          a.unsupported = [a.unsupported[0], a.unsupported[0]];
        },
      ),
    checks: { "receiver-typed-clean": false },
  },
  {
    name: "sabotage-freeze whose receiver matches every step fails its leg class (success)",
    mutate: async (out) => {
      const tx = summarizeRecording(
        "f",
        new Uint8Array(
          await readFile(
            join(out, "sabotage-freeze", "capture", "recording.rs0"),
          ),
        ),
      ).transactions;
      for (const [k, seq] of settleSeqs(tx).entries()) {
        await writePng(
          join(out, "sabotage-freeze", "receiver", "shots", `seq-${seq}.png`),
          k,
        );
      }
    },
    checks: { "leg-class-sabotage-freeze": false },
    classes: { "sabotage-freeze": "success" },
  },
  {
    name: "sabotage-omit mismatching steps {2,3} fails its leg class",
    mutate: async (out) => {
      const tx = summarizeRecording(
        "o",
        new Uint8Array(
          await readFile(
            join(out, "sabotage-omit", "capture", "recording.rs0"),
          ),
        ),
      ).transactions;
      await writePng(
        join(
          out,
          "sabotage-omit",
          "receiver",
          "shots",
          `seq-${settleSeqs(tx)[3]}.png`,
        ),
        1,
      );
    },
    checks: { "leg-class-sabotage-omit": false },
    classes: { "sabotage-omit": "pixel-mismatch" },
  },
  {
    name: "sabotage-perturb mismatching at step 1 too fails its leg class",
    mutate: async (out) => {
      const tx = summarizeRecording(
        "p",
        new Uint8Array(
          await readFile(
            join(out, "sabotage-perturb", "capture", "recording.rs0"),
          ),
        ),
      ).transactions;
      await writePng(
        join(
          out,
          "sabotage-perturb",
          "receiver",
          "shots",
          `seq-${settleSeqs(tx)[1]}.png`,
        ),
        0,
      );
    },
    checks: { "leg-class-sabotage-perturb": false },
    classes: { "sabotage-perturb": "pixel-mismatch" },
  },
  {
    name: "a sabotage capture whose steps.jsonl misses a settle frame is capture-failure (step-join-failed)",
    mutate: (out) =>
      writeText(
        join(out, "sabotage-omit", "capture", "steps.jsonl"),
        `${EXPECTED.steps.map((s) => JSON.stringify({ step: s.step, applied_frame: s.applied_frame, settle_frame: s.step === 4 ? 999 : s.settle_frame })).join("\n")}\n`,
      ),
    checks: { "leg-class-sabotage-omit": false },
    classes: { "sabotage-omit": "capture-failure" },
  },
  {
    name: "an unsupported leg with nothing unsupported fails its leg class",
    mutate: async (out, projects) => {
      const bytes = encodeRecording({ quit: 52 });
      await writeFile(
        join(out, "unsupported", "capture", "recording.rs0"),
        bytes,
      );
      await writeReceiverProcess(
        join(out, "unsupported", "receiver"),
        projects,
        bytes,
        [],
        false,
      );
    },
    checks: { "leg-class-unsupported": false },
    classes: { unsupported: "success" },
  },
  {
    name: "a preexisting capture without failures fails its leg class",
    mutate: (out) =>
      writeFile(
        join(out, "preexisting", "recording.rs0"),
        encodeRecording({ quit: 52 }),
      ),
    checks: { "leg-class-preexisting": false },
    classes: { preexisting: "success" },
  },
  {
    name: "a corrupt leg failing at seq 2 fails its leg class while still replay-failure",
    mutate: (out) =>
      editJson<Applied>(join(out, "corrupt", "applied.json"), (a) => {
        a.failure = { seq: 2, reason: "meta-json", detail: "x" };
      }),
    checks: { "leg-class-corrupt": false },
    classes: { corrupt: "replay-failure" },
  },
  {
    name: "a corrupt leg without applied.json is still replay-failure but fails its leg class",
    mutate: (out) => rm(join(out, "corrupt", "applied.json")),
    checks: { "leg-class-corrupt": false },
    classes: { corrupt: "replay-failure" },
  },
];

async function runScenarios(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gate0-self-test-"));
  try {
    const templateProjects = await writeProjects(join(root, "template"));
    const template = join(root, "template", "out");
    await buildGoodTree(template, templateProjects);
    for (const [index, scenario] of scenarios.entries()) {
      const caseRoot = join(root, `case-${index}`);
      await cp(join(root, "template"), caseRoot, { recursive: true });
      const projects: Projects = {
        receiverProjectDir: join(
          caseRoot,
          "experiments",
          "render-stream",
          "receiver",
        ),
        fixtureProjectDir: join(
          caseRoot,
          "experiments",
          "render-stream",
          "fixtures",
          "gate0",
        ),
      };
      const out = join(caseRoot, "out");
      // Paths embedded in the copied evidence point at the template; re-point them.
      await writeTraceStrace(out, projects);
      for (const dir of [
        "receiver",
        "receiver-headless-trace",
        "unsupported/receiver",
        "corrupt",
        "receiver-typecheck/minimal",
        "sabotage-freeze/receiver",
        "sabotage-omit/receiver",
        "sabotage-perturb/receiver",
      ]) {
        const argvPath = join(out, dir, "argv.txt");
        const argv = await readFile(argvPath, "utf8");
        await writeText(
          argvPath,
          argv
            .split(templateProjects.receiverProjectDir)
            .join(projects.receiverProjectDir),
        );
      }
      if (scenario.mutate) await scenario.mutate(out, projects);
      const ctx: Gate0Context = {
        expected: EXPECTED,
        ...projects,
        now: new Date(0),
      };
      const report = await runGate0(out, ctx);
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      for (const [id, want] of Object.entries(scenario.checks ?? {})) {
        const got = byId.get(id);
        assert(
          `${scenario.name}: ${id} ${want ? "passes" : "fails"}`,
          got?.passed === want,
          got ? got.detail : "check not produced",
        );
      }
      for (const [leg, want] of Object.entries(scenario.classes ?? {})) {
        const got = report.legs[leg]?.result_class;
        assert(
          `${scenario.name}: ${leg} is ${want}`,
          got === want,
          `got ${got} (${report.legs[leg]?.reasons.join(" | ")})`,
        );
      }
      scenario.report?.(report);
      if (scenario.checks && Object.values(scenario.checks).some((v) => !v)) {
        assert(
          `${scenario.name}: gate_passed false`,
          report.gate_passed === false,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// classifyLeg unit cases
// ---------------------------------------------------------------------------------------------

function tx(
  seq: number,
  extra: Partial<Transaction["meta"]> = {},
): Transaction {
  return {
    meta: {
      type: "transaction",
      seq,
      frame: seq,
      status: "ok",
      failures: [],
      unsupported: [],
      items: [{ id: 1, commands: [{ op: "add_rect", aa: false, f: 0 }] }],
      blocks: [],
      ...extra,
    },
    blocks: [[], [], [0, 0, 1, 1, 1, 1, 1, 1]],
    sha256: `sha-${seq}`,
  };
}

function baseInput(): ClassifyInput {
  return {
    captureResult: { status: "armed", stream: { status: "closed" } },
    recording: {
      present: true,
      errors: [],
      transactions: [tx(1), tx(2)],
      session: { type: "session", sabotage: null },
    },
    stepJoin: {
      ok: true,
      entries: [{ step: 0, settle_frame: 2, seq: 2 }],
      problems: [],
    },
    receiver: {
      applied: {
        status: "ok",
        end_seen: true,
        transactions: [
          { seq: 1, record_sha256: "sha-1" },
          { seq: 2, record_sha256: "sha-2" },
        ],
        shots: [{ seq: 2, applied_through: 2 }],
        unsupported: [],
      },
      requestedShotSeqs: [2],
      shotFiles: [2],
    },
    checkpoints: [
      {
        step: 0,
        settle_frame: 2,
        seq: 2,
        reference_png: "r",
        receiver_png: "p",
        diff_png: null,
        mismatched_pixels: 0,
        max_channel_delta: 0,
        regions: [
          {
            name: "marker",
            rect_px: [0, 0, 1, 1],
            mismatched_pixels: 0,
            max_channel_delta: 0,
          },
        ],
      },
    ],
  };
}

type Toggle = (input: ClassifyInput) => void;
const TOGGLES: Record<Exclude<LegClass, "success">, Toggle> = {
  "capture-failure": (i) => {
    i.captureResult = { status: "refused", stream: { status: "closed" } };
  },
  unsupported: (i) => {
    i.recording.transactions[1] = tx(2, {
      unsupported: [
        { op: "canvas_item_add_circle", item: 1, reason: "unsupported-op" },
      ],
    });
    i.recording.transactions[1].sha256 = "sha-2";
  },
  "replay-failure": (i) => {
    if (i.receiver?.applied) i.receiver.applied.status = "replay-failure";
  },
  "pixel-mismatch": (i) => {
    i.checkpoints[0].mismatched_pixels = 12;
    i.checkpoints[0].max_channel_delta = 255;
  },
};

function classifyUnitCases(): void {
  const base = classifyLeg(baseInput());
  assert(
    "classifyLeg: nothing fired is success",
    base.result_class === "success" && base.reasons.length === 0,
  );

  const classes = Object.keys(TOGGLES) as Exclude<LegClass, "success">[];
  for (const cls of classes) {
    const input = baseInput();
    TOGGLES[cls](input);
    const r = classifyLeg(input);
    assert(
      `classifyLeg: ${cls} alone`,
      r.result_class === cls,
      JSON.stringify(r),
    );
  }
  for (let a = 0; a < classes.length; a++) {
    for (let b = a + 1; b < classes.length; b++) {
      const input = baseInput();
      TOGGLES[classes[b]](input);
      TOGGLES[classes[a]](input);
      const r = classifyLeg(input);
      assert(
        `classifyLeg precedence: ${classes[a]} over ${classes[b]}, both listed in reasons`,
        r.result_class === classes[a] &&
          r.reasons.some((x) => x.startsWith(`${classes[a]}:`)) &&
          r.reasons.some((x) => x.startsWith(`${classes[b]}:`)),
        JSON.stringify(r),
      );
    }
  }
  assert(
    "classifyLeg: CLASS_PRECEDENCE is the documented order",
    CLASS_PRECEDENCE.join(",") ===
      "capture-failure,unsupported,replay-failure,pixel-mismatch,success",
  );

  const single = (name: string, edit: Toggle, want: LegClass): void => {
    const input = baseInput();
    edit(input);
    const r = classifyLeg(input);
    assert(
      `classifyLeg: ${name} -> ${want}`,
      r.result_class === want,
      JSON.stringify(r.reasons),
    );
  };
  single(
    "stream.status refused",
    (i) => {
      i.captureResult = {
        status: "armed",
        stream: { status: "refused", reason: "sabotage" },
      };
    },
    "capture-failure",
  );
  single(
    "recording missing",
    (i) => {
      i.recording = { present: false, errors: ["missing"], transactions: [] };
    },
    "capture-failure",
  );
  single(
    "validateRecording errors",
    (i) => {
      i.recording.errors = ["recording-incomplete: no end record"];
    },
    "capture-failure",
  );
  single(
    "a capture-failure transaction",
    (i) => {
      i.recording.transactions[0] = tx(1, {
        status: "capture-failure",
        failures: [{ reason: "mirror-capacity", detail: "items" }],
      });
      i.recording.transactions[0].sha256 = "sha-1";
    },
    "capture-failure",
  );
  single(
    "step-join-failed",
    (i) => {
      i.stepJoin = {
        ok: false,
        entries: [],
        problems: ["step 4: no transaction has frame 48"],
      };
    },
    "capture-failure",
  );
  single(
    "an unsupported command",
    (i) => {
      i.recording.transactions[0] = tx(1, {
        items: [
          {
            id: 1,
            commands: [{ op: "unsupported", name: "canvas_item_add_line" }],
          },
        ],
      });
      i.recording.transactions[0].sha256 = "sha-1";
    },
    "unsupported",
  );
  single(
    "applied.json unsupported",
    (i) => {
      if (i.receiver?.applied)
        i.receiver.applied.unsupported = [
          { seq: 1, item: 1, name: "canvas_item_add_line" },
        ];
    },
    "unsupported",
  );
  single(
    "applied.json missing",
    (i) => {
      if (i.receiver) i.receiver.applied = undefined;
    },
    "replay-failure",
  );
  single(
    "end_seen false",
    (i) => {
      if (i.receiver?.applied) i.receiver.applied.end_seen = false;
    },
    "replay-failure",
  );
  single(
    "applied seqs 1,3",
    (i) => {
      if (i.receiver?.applied)
        i.receiver.applied.transactions = [
          { seq: 1, record_sha256: "sha-1" },
          { seq: 3, record_sha256: "sha-2" },
        ];
    },
    "replay-failure",
  );
  single(
    "a record_sha256 mismatch",
    (i) => {
      if (i.receiver?.applied)
        i.receiver.applied.transactions = [
          { seq: 1, record_sha256: "sha-1" },
          { seq: 2, record_sha256: "nope" },
        ];
    },
    "replay-failure",
  );
  single(
    "a requested shot file missing",
    (i) => {
      if (i.receiver) i.receiver.shotFiles = [];
    },
    "replay-failure",
  );
  single(
    "a region-only mismatch",
    (i) => {
      i.checkpoints[0].regions[0].max_channel_delta = 1;
    },
    "pixel-mismatch",
  );
  single(
    "an unreadable checkpoint",
    (i) => {
      i.checkpoints[0].mismatched_pixels = null;
    },
    "pixel-mismatch",
  );

  // Legs without a receiver stop after rule 2.
  {
    const input = baseInput();
    input.receiver = undefined;
    TOGGLES["pixel-mismatch"](input);
    const r = classifyLeg(input);
    assert(
      "classifyLeg: without a receiver, rules 3-4 are skipped",
      r.result_class === "success" && r.reasons.length === 0,
    );
  }

  // session.sabotage is never read.
  for (const cls of ["success", "pixel-mismatch"] as const) {
    const plain = baseInput();
    const sabotaged = baseInput();
    sabotaged.recording.session = {
      type: "session",
      sabotage: { kind: "freeze-frame", frame: 21 },
    };
    if (cls !== "success") {
      TOGGLES[cls](plain);
      TOGGLES[cls](sabotaged);
    }
    assert(
      `classifyLeg: session.sabotage is ignored (${cls})`,
      JSON.stringify(classifyLeg(plain)) ===
        JSON.stringify(classifyLeg(sabotaged)),
    );
  }
  {
    // A getter that throws proves the classifier never even reads the field.
    const input = baseInput();
    const session = { type: "session" as const };
    Object.defineProperty(session, "sabotage", {
      enumerable: true,
      get() {
        throw new Error("classifyLeg read session.sabotage");
      },
    });
    input.recording.session = session;
    let threw = false;
    try {
      classifyLeg(input);
    } catch {
      threw = true;
    }
    assert(
      "classifyLeg: never touches session.sabotage (throwing getter)",
      !threw,
    );
  }
}

async function helperCases(): Promise<void> {
  const minimal = new Uint8Array(
    await readFile(join(GOLDEN_DIR, "minimal.bin")),
  );
  const corrupt = new Uint8Array(
    await readFile(join(GOLDEN_DIR, "corrupt-meta.bin")),
  );
  const made = corruptTransactionMeta(minimal, 2);
  assert(
    "corruptTransactionMeta(minimal.bin, 2) is golden/corrupt-meta.bin byte for byte",
    made.length === corrupt.length && made.every((b, i) => b === corrupt[i]),
  );
  const rec = new Uint8Array(encodeRecording({ quit: 52 }));
  assert(
    "a fabricated 52-frame recording validates",
    validateRecording(rec).length === 0,
    validateRecording(rec).join(" | "),
  );
  const broken = corruptTransactionMeta(rec, 3);
  assert(
    "corruptTransactionMeta(seq 3) yields meta-json",
    validateRecording(broken).some((e) => e.startsWith("meta-json")),
  );
  let threw = false;
  try {
    corruptTransactionMeta(rec, 999);
  } catch {
    threw = true;
  }
  assert("corruptTransactionMeta refuses a seq that does not exist", threw);
  const summary = summarizeRecording("r", rec);
  const steps = EXPECTED.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  const ok = joinSettleSeqs(steps, summary.transactions);
  assert(
    "joinSettleSeqs joins every settle frame",
    ok.ok && ok.entries.map((e) => e.seq).join(",") === "8,18,28,38,48",
  );
  const bad = joinSettleSeqs(
    [...steps, { step: 5, applied_frame: 51, settle_frame: 58 }],
    summary.transactions,
  );
  assert(
    "joinSettleSeqs fails on a settle frame with no transaction",
    !bad.ok && bad.problems.length === 1,
  );
  assert(
    "joinSettleSeqs fails without a step log",
    !joinSettleSeqs(undefined, summary.transactions).ok,
  );
}

async function main(): Promise<void> {
  classifyUnitCases();
  await helperCases();
  await runScenarios();
  console.log(
    `\nself-test-gate0: ${assertions - failures}/${assertions} assertions correct (${scenarios.length} evidence scenarios)`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
