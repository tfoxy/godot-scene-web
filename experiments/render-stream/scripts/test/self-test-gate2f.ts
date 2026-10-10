#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 2 group g2f (lib/gate2f-checks.ts, the opt-in headless CanvasTexture shim;
// protocol/canvas-texture-headless.md "Experiment (a) result"). Proves every g2f check can fail
// as well as pass, on small fabricated evidence (JSON files, stdout logs and PNGs synthesized from
// fixtures/gate2/expected.json; object-literal captures where a check reads no files).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate2f.ts
//
// Exits non-zero if any assertion fails.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Gate2Expected,
  gate2Regions,
  stepFrames2,
} from "../lib/gate2-expected";
import type {
  CaptureEvidence,
  G2bCheck,
  G2bCheckpoint,
  HookLine,
  ReceiverEvidence,
} from "../lib/gate2b-checks";
import {
  checkShimOffIsDefault,
  checkShimPrivateRids,
  checkShimReceiverVsReference,
  checkShimRefusesOffHeadless,
  checkShimStdoutClean,
  checkShimWire,
  engineErrorLines,
  isCreatorOp,
  isSyntheticRid,
  ridIndex,
  SHIM_INDEX_BASE,
  SHIM_TAG,
} from "../lib/gate2f-checks";
import { shotPng, writeBytes, writeJson, writeText } from "./gate2b-fixture";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, "../../fixtures/gate2/expected.json");

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function passesCheck(name: string, c: G2bCheck): void {
  assert(`${name} passes`, c.passed && c.status === "pass", c.detail);
}
function failsCheck(name: string, c: G2bCheck): void {
  assert(`${name} fails`, !c.passed && c.status === "fail", "it passed");
}

const SYNTH = (SHIM_TAG << 32n) | SHIM_INDEX_BASE;
const ENGINE = 90194313218n;
const LEAK = [
  'WARNING: 2 RIDs of type "CanvasItem" were leaked.',
  "     at: _free_rids (servers/rendering/renderer_canvas_cull.cpp:2678)",
  "ERROR: 1 RID allocations of type 'PN13RendererDummy14TextureStorage12DummyTextureE' were leaked at exit.",
].join("\n");

function pure(): void {
  assert("synthetic RID recognised", isSyntheticRid(SYNTH));
  assert("index is 2^31", ridIndex(SYNTH) === SHIM_INDEX_BASE);
  assert("engine RID is not synthetic", !isSyntheticRid(ENGINE));
  assert(
    "tag validator with a small index is not synthetic",
    !isSyntheticRid((SHIM_TAG << 32n) | 7n),
  );
  assert("RID() is not synthetic", !isSyntheticRid(0n));
  assert(
    "engine lines",
    JSON.stringify(engineErrorLines(`[grc] x\n${LEAK}\nSCRIPT ERROR: y`)) ===
      JSON.stringify([
        'WARNING: 2 RIDs of type "CanvasItem" were leaked.',
        "ERROR: 1 RID allocations of type 'PN13RendererDummy14TextureStorage12DummyTextureE' were leaked at exit.",
        "SCRIPT ERROR: y",
      ]),
  );
  assert(
    "creator ops",
    isCreatorOp("texture_2d_create") &&
      isCreatorOp("mesh_create_from_surfaces") &&
      isCreatorOp("canvas_texture_create") &&
      !isCreatorOp("free") &&
      !isCreatorOp("canvas_item_set_parent"),
  );
}

function shimJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "render-stream-canvas-texture-shim/1",
    mode: "synthesize",
    state: "armed",
    reason: null,
    display_server: "headless",
    engine_allocated: 0,
    foreign_frees: 0,
    synthesized: [
      {
        rid: String(SYNTH),
        index: Number(SHIM_INDEX_BASE),
        created_frame: 111,
        freed_frame: 401,
        frees: 1,
      },
    ],
    ...over,
  };
}

function counters(
  over: { creates?: string; free?: string[]; dropped?: number } = {},
): Record<string, unknown> {
  return {
    captured: {
      canvas_texture_create: [{ rid: String(SYNTH) }],
      texture_2d_create: [{ rid: over.creates ?? String(ENGINE) }],
      canvas_item_create: [{ rid: "115964116992" }],
      free: (over.free ?? [String(SYNTH), "94489280515"]).map((rid) => ({
        rid,
      })),
    },
    captured_dropped: {
      canvas_texture_create: 0,
      texture_2d_create: over.dropped ?? 0,
      canvas_item_create: 0,
      free: 0,
    },
  };
}

async function privateRids(root: string): Promise<void> {
  const dir = join(root, "rids");
  const cap = { dir } as CaptureEvidence;
  const write = async (
    shim: Record<string, unknown>,
    c: Record<string, unknown>,
  ) => {
    await writeJson(join(dir, "evidence", "canvas-texture-shim.json"), shim);
    await writeJson(join(dir, "evidence", "counters.json"), c);
  };
  await write(shimJson(), counters());
  passesCheck("shim-private-rids", await checkShimPrivateRids(cap));
  await write(shimJson(), counters({ creates: String(SYNTH) }));
  failsCheck(
    "shim-private-rids (engine RID equals a private one)",
    await checkShimPrivateRids(cap),
  );
  const low = (SHIM_TAG << 32n) | 5n;
  await write(
    shimJson({
      synthesized: [
        {
          rid: String(low),
          index: 5,
          created_frame: 1,
          freed_frame: 2,
          frees: 1,
        },
      ],
    }),
    counters(),
  );
  failsCheck(
    "shim-private-rids (index below 2^31)",
    await checkShimPrivateRids(cap),
  );
  await write(shimJson(), counters({ free: ["94489280515"] }));
  failsCheck(
    "shim-private-rids (never freed)",
    await checkShimPrivateRids(cap),
  );
  await write(shimJson(), counters({ dropped: 1 }));
  failsCheck(
    "shim-private-rids (dropped log)",
    await checkShimPrivateRids(cap),
  );
  await write(shimJson({ engine_allocated: 1 }), counters());
  failsCheck(
    "shim-private-rids (engine allocated)",
    await checkShimPrivateRids(cap),
  );
  await write(shimJson({ synthesized: [] }), counters());
  failsCheck(
    "shim-private-rids (nothing synthesized)",
    await checkShimPrivateRids(cap),
  );
}

async function stdoutClean(root: string): Promise<void> {
  const out = join(root, "stdout");
  const dir = join(out, "shim-headless", "capture");
  const cap = { dir } as CaptureEvidence;
  await writeJson(
    join(dir, "evidence", "canvas-texture-shim.json"),
    shimJson(),
  );
  await writeText(
    join(out, "shim-off", "capture", "stdout.log"),
    `[grc] off\n${LEAK}\n`,
  );
  await writeText(join(dir, "stdout.log"), `[grc] on\n${LEAK}\n`);
  passesCheck("shim-stdout-clean", await checkShimStdoutClean(out, cap));
  await writeText(
    join(dir, "stdout.log"),
    `${LEAK}\nERROR: Parameter "canvas_texture" is null.\n`,
  );
  failsCheck(
    "shim-stdout-clean (extra engine error)",
    await checkShimStdoutClean(out, cap),
  );
  await writeText(join(dir, "stdout.log"), "[grc] on\n");
  failsCheck(
    "shim-stdout-clean (missing leak lines)",
    await checkShimStdoutClean(out, cap),
  );
}

async function refusals(root: string, expected: Gate2Expected): Promise<void> {
  const out = join(root, "refuse");
  const leg = (name: string, reason: string, display: string) => ({
    result: {
      status: "refused",
      reason,
      vptr_written: false,
      display_server: display,
      canvas_texture_shim: {
        env: "x",
        state: "refused",
        reason,
        synthesized: 0,
      },
    },
    shim: shimJson({ mode: "off", state: "refused", reason, synthesized: [] }),
    dir: join(out, name, "capture"),
  });
  const rendered = leg(
    "shim-refused-rendered",
    "canvas-texture-shim-not-headless",
    "X11",
  );
  const invalid = leg(
    "shim-invalid",
    "canvas-texture-shim-invalid",
    "headless",
  );
  const write = async (l: ReturnType<typeof leg>) => {
    await writeJson(join(l.dir, "evidence", "result.json"), l.result);
    await writeJson(
      join(l.dir, "evidence", "canvas-texture-shim.json"),
      l.shim,
    );
    await writeText(join(l.dir, "exit-code.txt"), "0\n");
  };
  await write(rendered);
  await write(invalid);
  const shot = join(rendered.dir, "shots", "step-11.png");
  await writeBytes(shot, await shotPng(expected, 11));
  passesCheck(
    "shim-refuses-off-headless",
    await checkShimRefusesOffHeadless(expected, out),
  );

  await write({
    ...rendered,
    result: { ...rendered.result, status: "armed", vptr_written: true },
  });
  failsCheck(
    "shim-refuses-off-headless (rendered host armed)",
    await checkShimRefusesOffHeadless(expected, out),
  );
  await write(rendered);
  await write({
    ...invalid,
    shim: { ...invalid.shim, synthesized: [{ rid: String(SYNTH) }] },
  });
  failsCheck(
    "shim-refuses-off-headless (a private RID on a refused host)",
    await checkShimRefusesOffHeadless(expected, out),
  );
  await write(invalid);
  await writeText(join(invalid.dir, "recording.rs2"), "x");
  failsCheck(
    "shim-refuses-off-headless (a recording on a refused host)",
    await checkShimRefusesOffHeadless(expected, out),
  );
  await rm(join(invalid.dir, "recording.rs2"));
  await writeBytes(shot, await shotPng(expected, 11, { blankRegion: "sc" }));
  failsCheck(
    "shim-refuses-off-headless (rendered host draws SC wrong)",
    await checkShimRefusesOffHeadless(expected, out),
  );
}

function hook(over: Partial<HookLine>): HookLine {
  return {
    frame: 111,
    thread: "main",
    op: "canvas_texture_create",
    id: null,
    by_id: null,
    rid: null,
    version: null,
    kind: "canvas",
    status: "unsupported",
    reason: "canvas-texture-headless",
    format: null,
    width: null,
    height: null,
    mipmaps: null,
    data_bytes: null,
    payload_bytes: null,
    hash: null,
    copy_ns: null,
    hash_ns: null,
    conn: null,
    target: null,
    ...over,
  };
}

async function offIsDefault(root: string): Promise<void> {
  const dir = join(root, "off");
  const session = (unsupported: unknown[]) => ({
    type: "session",
    engine: { display_server: "headless" },
    features: { resources: ["texture_2d"], unsupported_resources: unsupported },
  });
  const refusal = [
    { resource: "canvas_texture", reason: "canvas-texture-headless" },
  ];
  const lines = [hook({}), hook({ op: "canvas_texture_set_texture_filter" })];
  const cap = (metas: unknown[], hl: HookLine[]) =>
    ({
      dir,
      full: { metas },
      hook: {
        path: join(dir, "evidence", "resources.jsonl"),
        lines: hl,
        problem: null,
      },
    }) as unknown as CaptureEvidence;
  await writeJson(join(dir, "evidence", "result.json"), {
    status: "armed",
    canvas_texture_shim: {
      env: "off",
      state: "off",
      reason: null,
      synthesized: 0,
    },
  });
  await writeJson(
    join(dir, "evidence", "canvas-texture-shim.json"),
    shimJson({ mode: "off", state: "off", synthesized: [] }),
  );
  passesCheck(
    "shim-off-is-default",
    await checkShimOffIsDefault(cap([session(refusal)], lines)),
  );
  failsCheck(
    "shim-off-is-default (no refusal declared)",
    await checkShimOffIsDefault(cap([session([])], lines)),
  );
  failsCheck(
    "shim-off-is-default (a canvas texture got an id)",
    await checkShimOffIsDefault(
      cap([session(refusal)], [hook({ id: 13, status: "ok", reason: null })]),
    ),
  );
  await writeJson(
    join(dir, "evidence", "canvas-texture-shim.json"),
    shimJson({ mode: "off", state: "off" }),
  );
  failsCheck(
    "shim-off-is-default (a private RID with the shim off)",
    await checkShimOffIsDefault(cap([session(refusal)], lines)),
  );
}

async function receiverVsReference(
  root: string,
  expected: Gate2Expected,
): Promise<void> {
  const dir = join(root, "rx");
  const cps: G2bCheckpoint[] = expected.steps.map((s) => ({
    leg: "shim-headless",
    step: s.step,
    seq: 100 + s.step,
    shot: join(dir, "shots", `seq-${100 + s.step}.png`),
    reference: "",
    mismatched_pixels: 0,
    max_channel_delta: 0,
    regions: Object.fromEntries(
      Object.keys(gate2Regions(expected, s.step)).map((k) => [k, 0]),
    ),
  }));
  const rx = {
    dir,
    settle: new Map([[11, 111]]),
  } as unknown as ReceiverEvidence;
  await writeBytes(
    join(dir, "shots", "seq-111.png"),
    await shotPng(expected, 11),
  );
  passesCheck(
    "shim-receiver-vs-reference",
    await checkShimReceiverVsReference(expected, cps, rx),
  );
  failsCheck(
    "shim-receiver-vs-reference (a step differs)",
    await checkShimReceiverVsReference(
      expected,
      cps.map((c) => (c.step === 4 ? { ...c, mismatched_pixels: 3 } : c)),
      rx,
    ),
  );
  failsCheck(
    "shim-receiver-vs-reference (a step missing)",
    await checkShimReceiverVsReference(expected, cps.slice(1), rx),
  );
  await writeBytes(
    join(dir, "shots", "seq-111.png"),
    await shotPng(expected, 11, { blankRegion: "sc" }),
  );
  failsCheck(
    "shim-receiver-vs-reference (region sc off the model)",
    await checkShimReceiverVsReference(expected, cps, rx),
  );
}

function wire(expected: Gate2Expected): void {
  const f11 = stepFrames2(expected, 11);
  const ctLines = (rid: string) => [
    hook({
      op: "canvas_texture_create",
      id: 13,
      rid,
      status: "ok",
      reason: null,
      version: 1,
    }),
    hook({
      op: "canvas_texture_set_channel",
      id: 13,
      rid,
      status: "ok",
      reason: null,
      version: 2,
    }),
  ];
  const aLine = hook({
    frame: 1,
    op: "texture_2d_create",
    id: 1,
    rid: String(ENGINE),
    kind: "texture_2d",
    status: "ok",
    reason: null,
  });
  const fixture = [
    {
      step: 0,
      frame: 1,
      op: "texture_2d_create",
      name: "A",
      thread: "main",
      payload_sha256: null,
    },
    {
      step: 11,
      frame: 111,
      op: "canvas_texture_create",
      name: "CT",
      thread: "main",
      payload_sha256: null,
    },
  ];
  const t11 = (unsupported: unknown[]) => ({
    seq: 118,
    frame: f11.settle,
    state: {
      items: [],
      unsupported,
      textures: [
        {
          id: 13,
          kind: "canvas",
          status: "ok",
          version: 4,
          canvas: { diffuse: 1, filter: "nearest", repeat: "enabled" },
        },
      ],
    },
  });
  const cap = (o: {
    lines?: HookLine[];
    unsupportedResources?: unknown[];
    tx?: unknown;
  }) =>
    ({
      dir: "/nonexistent",
      full: {
        path: "recording.rs2",
        metas: [
          {
            type: "session",
            engine: { display_server: "headless" },
            features: {
              resources: ["canvas_texture", "texture_2d"],
              unsupported_resources: o.unsupportedResources ?? [],
            },
          },
        ],
        recording: { transactions: [o.tx ?? t11([])] },
      },
      hook: {
        path: "resources.jsonl",
        lines: o.lines ?? [aLine, ...ctLines(String(SYNTH))],
        problem: null,
      },
      fixture,
    }) as unknown as CaptureEvidence;
  passesCheck("shim-wire", checkShimWire(expected, cap({})));
  failsCheck(
    "shim-wire (an engine RID on a canvas texture line)",
    checkShimWire(expected, cap({ lines: [aLine, ...ctLines("12345")] })),
  );
  failsCheck(
    "shim-wire (canvas_texture still declared unsupported)",
    checkShimWire(
      expected,
      cap({
        unsupportedResources: [
          { resource: "canvas_texture", reason: "canvas-texture-headless" },
        ],
      }),
    ),
  );
  failsCheck(
    "shim-wire (a refused entry)",
    checkShimWire(
      expected,
      cap({
        tx: t11([
          {
            op: "canvas_item_add_texture_rect_region",
            reason: "canvas-texture-headless",
          },
        ]),
      }),
    ),
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(EXPECTED_PATH, "utf8"),
  ) as Gate2Expected;
  const root = await mkdtemp(join(tmpdir(), "self-test-gate2f-"));
  try {
    pure();
    await privateRids(root);
    await stdoutClean(root);
    await refusals(root, expected);
    await offIsDefault(root);
    await receiverVsReference(root, expected);
    wire(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    `self-test-gate2f: ${passes}/${passes + failures} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
