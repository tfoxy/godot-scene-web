#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8res checks (lib/gate8-res-checks.ts, LATE-RES), against the real
// fixtures/gate8-res/expected.json.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-res.ts
//
// The /12 recordings are real rendered-host captures that cannot be synthesized here, so the
// checker's judging is split into pure exported functions (judgeResLateAdopt, judgeResLateFault,
// freedCounts / resFreeProblems) which this test drives on synthetic result.json objects and
// synthetic resolved transactions; runG8res itself is driven on a synthetic evidence tree for
// every check id it emits (res-legs, res-late-adopt, res-late-residual, res-free, res-late-fault) for the
// empty/missing-evidence behaviour (legs that did not run, a missing recording, a skipped leg).
//
// 1. judgeResLateAdopt (LAR5: the deferred capture, unknown_material_keyed exactly 0) and
//    1b. judgeResLateResidual (the late capture: emitter refused preload-particles): the honest
//    result + recording passes; each missing table, short count,
//    refusal, unknown-texture command, unknown-material particle, unknown/withheld item, empty
//    recording, missing recording and sink problem fails.
// 2. judgeResLateFault: the honest fault passes; adopting anything, no unknown-texture command,
//    fewer than 2 unknown RIDs, an empty or missing recording and a sink problem fail.
// 3. freedCounts / resFreeProblems: items, textures and emitters gone or tombstoned after the
//    free pass; nothing freed, too few, no transaction before/after the free, empty list fail.
// 4. runG8res on trees: res-legs passes when every leg ran 0 and fails on a non-zero exit, a leg
//    that did not run and an all-skipped tree; with no recordings the adopt/free/fault checks
//    fail (never pass) and name the missing recording.
//
// Exits non-zero if any assertion fails.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CaptureResult,
  freedCounts,
  type G8resExpected,
  judgeResLateAdopt,
  judgeResLateFault,
  judgeResLateResidual,
  type ResFreeTx,
  resFreeProblems,
  runG8res,
} from "../lib/gate8-res-checks";

const HERE = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  readFileSync(
    resolve(HERE, "..", "..", "fixtures", "gate8-res", "expected.json"),
    "utf8",
  ),
) as G8resExpected;

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string, detail?: unknown): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(
      `FAIL ${what}${detail === undefined ? "" : ` -- ${JSON.stringify(detail).slice(0, 600)}`}`,
    );
  }
}

// ------------------------------------------------------------------------------ synthetic data

const honestResult = (): CaptureResult => ({
  stream: {
    gate8: {
      adopt_stats: {
        // LAR6: the pre-arm texture and the loader-thread one, adopted from the off-main queue
        resources: {
          textures: expected.deferred.textures ?? expected.textures,
          textures_refused: 0,
          offmain_queued: 1,
          offmain_drained: 1,
          offmain_adopted: expected.deferred.offmain_adopted ?? 0,
        },
        material_adoption: { items_adopted: expected.items_adopted },
        residue: 0,
      },
      particles: {
        adoption: {
          emitters: expected.deferred.emitters,
          ppm_materials: expected.deferred.process_materials,
          ppm_registry: expected.deferred.ppm_registry,
          refused: 0,
          ppm_refused: 0,
          refused_preload_particles: 0,
        },
        unknown_material_keyed: expected.deferred.unknown_material_keyed,
      },
    },
  },
});
// LAR5: the late capture: texture and items adopted, the emitter refused preload-particles
const lateResult = (): CaptureResult => ({
  stream: {
    gate8: {
      adopt_stats: {
        resources: { textures: expected.textures, textures_refused: 0 },
        material_adoption: { items_adopted: expected.items_adopted },
        residue: 0,
      },
      particles: {
        adoption: {
          emitters: expected.late.emitters,
          refused: expected.late.refused_preload_particles,
          refused_preload_particles: expected.late.refused_preload_particles,
          ppm_materials: 0,
        },
        unknown_material_keyed: expected.late.unknown_material_keyed,
      },
    },
  },
});
const faultResult = (): CaptureResult => ({
  stream: {
    gate8: {
      adopt_stats: {
        resources: { textures: 0 },
        material_adoption: { items_adopted: 0 },
      },
      particles: {
        adoption: { emitters: 0, ppm_materials: 0 },
        unknown_material_keyed: 0,
      },
    },
  },
});

interface SynthTx {
  frame: number;
  state: {
    items: { id: number; commands: { op: string; reason?: string }[] }[];
    textures: { id: number; status: string }[];
    particles: { id: number; status: string; reason?: string }[];
    unknown_items?: { unknown_rids?: number; withheld_items?: number };
  };
}
const tx = (frame: number, o: Partial<SynthTx["state"]> = {}): SynthTx => ({
  frame,
  state: { items: [], textures: [], particles: [], ...o },
});
const rec = (txs: SynthTx[]) => ({ rec: { transactions: txs as never } });
const honestRec = () =>
  rec([
    tx(16, {
      items: [{ id: 1, commands: [{ op: "draw_rect" }] }],
      unknown_items: { unknown_rids: 0, withheld_items: 0 },
    }),
  ]);
const faultRec = () =>
  rec([
    tx(16, {
      items: [
        { id: 1, commands: [{ op: "unsupported", reason: "unknown-texture" }] },
      ],
      unknown_items: { unknown_rids: 2, withheld_items: 0 },
    }),
  ]);

const adopt = (
  r: CaptureResult | undefined,
  rc: { rec?: { transactions: never }; error?: string },
  sink: string[] = [],
) => judgeResLateAdopt(r, rc, sink, expected).problems;

// ------------------------------------------------------------------------------ 1. adopt

expect(
  adopt(honestResult(), honestRec()).length === 0,
  "1: the honest late capture passes",
  adopt(honestResult(), honestRec()),
);
expect(
  adopt(undefined, honestRec()).length >= 4,
  "1: a missing result.json fails every table",
);
{
  const r = honestResult();
  delete r.stream!.gate8!.adopt_stats!.resources;
  expect(
    adopt(r, honestRec()).some((p) => p.includes("adopt_stats.resources")),
    "1: missing resources fails",
  );
}
{
  const r = honestResult();
  delete r.stream!.gate8!.adopt_stats!.material_adoption;
  expect(
    adopt(r, honestRec()).some((p) => p.includes("material_adoption")),
    "1: missing material_adoption fails",
  );
}
{
  const r = honestResult();
  delete r.stream!.gate8!.particles!.adoption;
  expect(
    adopt(r, honestRec()).some((p) => p.includes("particles.adoption")),
    "1: missing particles.adoption fails",
  );
}
{
  const r = honestResult();
  delete r.stream!.gate8!.particles;
  expect(
    adopt(r, honestRec()).some((p) => p.includes("stream.gate8.particles")),
    "1: missing particles fails",
  );
}
for (const [what, mutate] of [
  [
    "no textures adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.resources!.textures = 0;
    },
  ],
  [
    "a refused texture",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.resources!.textures_refused = 1;
    },
  ],
  [
    "too few items adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.material_adoption!.items_adopted = 1;
    },
  ],
  [
    "no emitter adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.emitters = 0;
    },
  ],
  [
    "no process material adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.ppm_materials = 0;
    },
  ],
  [
    "a refused emitter",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.refused = 1;
    },
  ],
  [
    "a refused process material",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.ppm_refused = 1;
    },
  ],
  [
    "an unknown-material keyed process material (the registered material must be adopted, not keyed)",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.unknown_material_keyed = 1;
    },
  ],
  [
    "too few registry-adopted process materials",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.ppm_registry = 1;
    },
  ],
  [
    "a preload-particles refusal",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.refused_preload_particles = 1;
    },
  ],
] as [string, (r: CaptureResult) => void][]) {
  const r = honestResult();
  mutate(r);
  expect(adopt(r, honestRec()).length > 0, `1: ${what} fails`);
}
expect(
  adopt(honestResult(), rec([])).some((p) => p.includes("no transaction")),
  "1: an empty recording fails",
);
expect(
  adopt(honestResult(), { error: "recording.rs12 missing" }).length > 0,
  "1: a missing recording fails",
);
expect(
  adopt(
    honestResult(),
    rec([
      tx(16, {
        items: [
          {
            id: 1,
            commands: [{ op: "unsupported", reason: "unknown-texture" }],
          },
        ],
      }),
    ]),
  ).length > 0,
  "1: an unknown-texture command fails",
);
expect(
  adopt(
    honestResult(),
    rec([
      tx(16, {
        particles: [
          { id: 1, status: "unsupported", reason: "unknown-material" },
        ],
      }),
    ]),
  ).length > 0,
  "1: an unknown-material particle fails",
);
expect(
  adopt(honestResult(), rec([tx(16, { unknown_items: { unknown_rids: 1 } })]))
    .length > 0,
  "1: an unknown item RID fails",
);
expect(
  adopt(honestResult(), rec([tx(16, { unknown_items: { withheld_items: 1 } })]))
    .length > 0,
  "1: a withheld item fails",
);
expect(
  adopt(honestResult(), honestRec(), ["recording.rs12: missing"]).length > 0,
  "1: a sink validation problem fails",
);

// ------------------------------------------------------------------------------ 1b. residual

const residual = (
  r: CaptureResult | undefined,
  rc: { rec?: { transactions: never }; error?: string },
  sink: string[] = [],
) => judgeResLateResidual(r, rc, sink, expected);
expect(
  residual(lateResult(), honestRec()).problems.length === 0,
  "1b: the honest late capture passes",
  residual(lateResult(), honestRec()).problems,
);
expect(
  residual(lateResult(), honestRec()).detail.includes(
    "refused_preload_particles",
  ),
  "1b: the detail names the refusal count",
);
expect(
  residual(undefined, honestRec()).problems.length >= 4,
  "1b: a missing result.json fails every table",
);
for (const [what, mutate] of [
  [
    "an adopted emitter",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.emitters = 1;
    },
  ],
  [
    "no preload refusal",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.refused_preload_particles = 0;
    },
  ],
  [
    "an extra refusal beyond preload",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.adoption!.refused = 2;
    },
  ],
  [
    "no unknown-material keyed",
    (r: CaptureResult) => {
      r.stream!.gate8!.particles!.unknown_material_keyed = 0;
    },
  ],
  [
    "no texture adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.resources!.textures = 0;
    },
  ],
  [
    "a refused texture",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.resources!.textures_refused = 1;
    },
  ],
  [
    "too few items adopted",
    (r: CaptureResult) => {
      r.stream!.gate8!.adopt_stats!.material_adoption!.items_adopted = 1;
    },
  ],
] as [string, (r: CaptureResult) => void][]) {
  const r = lateResult();
  mutate(r);
  expect(residual(r, honestRec()).problems.length > 0, `1b: ${what} fails`);
}
expect(
  residual(lateResult(), rec([tx(16, { unknown_items: { unknown_rids: 1 } })]))
    .problems.length > 0,
  "1b: an unknown item RID fails",
);
expect(
  residual(
    lateResult(),
    rec([tx(16, { unknown_items: { withheld_items: 1 } })]),
  ).problems.length > 0,
  "1b: a withheld item fails",
);
expect(
  residual(lateResult(), { error: "recording.rs12 missing" }).problems.length >
    0,
  "1b: a missing recording fails",
);
expect(
  residual(lateResult(), honestRec(), ["recording.rs12: missing"]).problems
    .length > 0,
  "1b: a sink validation problem fails",
);
// the late result is not a deferred result and vice versa
expect(
  adopt(lateResult(), honestRec()).length > 0,
  "1b: the late result fails the deferred judgement",
);
expect(
  residual(honestResult(), honestRec()).problems.length > 0,
  "1b: the deferred result fails the late judgement",
);

// ------------------------------------------------------------------------------ 2. fault

const fault = (
  r: CaptureResult | undefined,
  rc: { rec?: { transactions: never }; error?: string },
  sink: string[] = [],
) => judgeResLateFault(r, rc, sink);
expect(
  fault(faultResult(), faultRec()).length === 0,
  "2: the honest fault capture passes",
  fault(faultResult(), faultRec()),
);
expect(
  fault(undefined, faultRec()).length >= 2,
  "2: a missing result.json fails",
);
{
  const r = faultResult();
  r.stream!.gate8!.adopt_stats!.resources!.textures = 1;
  expect(
    fault(r, faultRec()).length > 0,
    "2: a texture adopted under the fault fails",
  );
}
{
  const r = faultResult();
  r.stream!.gate8!.adopt_stats!.material_adoption!.items_adopted = 1;
  expect(
    fault(r, faultRec()).length > 0,
    "2: an item adopted under the fault fails",
  );
}
expect(fault(faultResult(), rec([])).length > 0, "2: an empty recording fails");
expect(
  fault(faultResult(), { error: "recording.rs12 missing" }).length > 0,
  "2: a missing recording fails",
);
expect(
  fault(faultResult(), honestRec()).length > 0,
  "2: no unknown-texture command (an honest recording) fails",
);
expect(
  fault(
    faultResult(),
    rec([
      tx(16, {
        items: [
          {
            id: 1,
            commands: [{ op: "unsupported", reason: "unknown-texture" }],
          },
        ],
        unknown_items: { unknown_rids: 1 },
      }),
    ]),
  ).length > 0,
  "2: fewer than 2 unknown RIDs fails",
);
expect(
  fault(
    faultResult(),
    rec([
      tx(16, {
        items: [{ id: 1, commands: [{ op: "draw_rect" }] }],
        unknown_items: { unknown_rids: 2 },
      }),
    ]),
  ).length > 0,
  "2: no unknown-texture command (but 2 unknown RIDs) fails",
);
expect(
  fault(faultResult(), faultRec(), ["recording-patch.rs12: missing"]).length >
    0,
  "2: a sink validation problem fails",
);

// ------------------------------------------------------------------------------ 3. free

const F = expected.free_frame;
const before = tx(F - 2, {
  items: [
    { id: 1, commands: [] },
    { id: 2, commands: [] },
    { id: 3, commands: [] },
  ],
  textures: [
    { id: 10, status: "ok" },
    { id: 11, status: "ok" },
  ],
  particles: [
    { id: 20, status: "ok" },
    { id: 21, status: "ok" },
  ],
});
const afterGone = tx(F + 3, {
  items: [{ id: 3, commands: [] }],
  textures: [{ id: 11, status: "ok" }],
  particles: [{ id: 21, status: "ok" }],
});
const afterTomb = tx(F + 3, {
  items: [{ id: 3, commands: [] }],
  textures: [
    { id: 10, status: "freed" },
    { id: 11, status: "ok" },
  ],
  particles: [
    { id: 20, status: "freed" },
    { id: 21, status: "ok" },
  ],
});
const free = (txs: SynthTx[]) =>
  resFreeProblems(txs as unknown as ResFreeTx[], expected);
expect(
  free([before, afterGone]).length === 0,
  "3: freed ids gone from the last state pass",
  free([before, afterGone]),
);
expect(
  free([before, afterTomb]).length === 0,
  "3: freed tombstones pass",
  free([before, afterTomb]),
);
expect(
  freedCounts([before, afterGone] as unknown as ResFreeTx[], F)?.items === 2,
  "3: freedCounts counts the gone items",
);
expect(free([]).length > 0, "3: an empty recording fails");
expect(
  free([before]).length > 0,
  "3: a recording with nothing after the free fails",
);
expect(
  free([afterGone]).length > 0,
  "3: a recording with nothing before the free fails",
);
expect(
  free([before, tx(F - 1, before.state)]).length > 0,
  "3: a recording that ends before the free fails",
);
expect(
  free([before, tx(F + 3, before.state)]).length > 0,
  "3: nothing freed fails",
);
expect(
  free([
    before,
    tx(F + 3, { ...afterGone.state, particles: before.state.particles }),
  ]).length > 0,
  "3: emitter not freed fails",
);
expect(
  free([
    before,
    tx(F + 3, { ...afterGone.state, textures: before.state.textures }),
  ]).length > 0,
  "3: texture not freed fails",
);
expect(
  free([
    before,
    tx(F + 3, { ...afterGone.state, items: before.state.items.slice(0, 2) }),
  ]).length > 0,
  "3: too few items freed fails",
);
expect(
  resFreeProblems([before, afterGone] as unknown as ResFreeTx[], {
    ...expected,
    freed_items: 0,
  }).length > 0,
  "3: a zero expected count fails",
);

// ------------------------------------------------------------------------------ 4. runG8res trees

async function main(): Promise<void> {
  const legs = [
    "late/capture",
    "deferred/capture",
    "fault-no-resources/capture",
    "sabotage-registry-queue-drop/capture",
  ];
  // LAR6: the sabotaged deferred capture: the loader-thread reference queued, then dropped.
  const queueDropResult = () => {
    const r = honestResult() as {
      stream: { gate8: { adopt_stats: { resources: Record<string, number> } } };
    };
    r.stream.gate8.adopt_stats.resources.textures = expected.textures;
    r.stream.gate8.adopt_stats.resources.offmain_adopted = 0;
    r.stream.gate8.adopt_stats.resources.offmain_drained = 0;
    r.stream.gate8.adopt_stats.resources.offmain_dropped = 1;
    return r;
  };
  const mk = (setup: (root: string) => void): string => {
    const root = mkdtempSync(join(tmpdir(), "self-test-gate8-res-"));
    setup(root);
    return root;
  };
  const leg = (
    root: string,
    name: string,
    rc: string | null,
    result?: unknown,
  ) => {
    const d = join(root, "g8res", name);
    mkdirSync(join(d, "evidence"), { recursive: true });
    if (rc !== null) writeFileSync(join(d, "exit-code.txt"), `${rc}\n`);
    if (result !== undefined)
      writeFileSync(join(d, "evidence", "result.json"), JSON.stringify(result));
  };
  const run = async (root: string) => {
    try {
      const { checks } = await runG8res(root, expected);
      return (id: string) => checks.find((c) => c.id === id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // every leg ran, result.json present, no recordings: legs pass; the recording-reading checks fail
  const ok = await run(
    mk((r) => {
      leg(r, "import/fixture", "0");
      leg(r, legs[0], "0", lateResult());
      leg(r, legs[1], "0", honestResult());
      leg(r, legs[2], "0", faultResult());
      leg(r, legs[3], "0", queueDropResult());
    }),
  );
  expect(
    ok("res-legs")?.passed === true,
    "4: res-legs passes when every leg exited 0",
    ok("res-legs"),
  );
  expect(
    ok("res-late-adopt-catches-registry-queue-drop")?.passed === true,
    "4: LAR6: the queue-drop sabotage fails res-late-adopt and counts the dropped reference",
    ok("res-late-adopt-catches-registry-queue-drop"),
  );
  for (const id of [
    "res-late-adopt",
    "res-late-residual",
    "res-free",
    "res-late-fault",
  ]) {
    expect(
      ok(id)?.passed === false,
      `4: ${id} fails without a recording`,
      ok(id),
    );
    expect(
      ok(id)?.detail?.includes("missing") === true,
      `4: ${id} names the missing recording`,
      ok(id),
    );
  }

  const bad = await run(
    mk((r) => {
      leg(r, "import/fixture", "0");
      leg(r, legs[0], "1", lateResult());
      leg(r, legs[1], "0", honestResult());
      leg(r, legs[2], "0", faultResult());
    }),
  );
  expect(
    bad("res-legs")?.passed === false,
    "4: res-legs fails on a non-zero exit",
    bad("res-legs"),
  );

  const missing = await run(
    mk((r) => {
      leg(r, "import/fixture", "0");
      leg(r, legs[0], "0", lateResult());
      leg(r, legs[1], "0", honestResult());
      leg(r, legs[2], null);
    }),
  );
  expect(
    missing("res-legs")?.passed === false,
    "4: res-legs fails on a leg that did not run",
    missing("res-legs"),
  );
  expect(
    missing("res-late-fault")?.passed === false,
    "4: res-late-fault fails when its leg did not run",
    missing("res-late-fault"),
  );

  const none = await run(mk((r) => leg(r, "import/fixture", "0")));
  for (const id of [
    "res-legs",
    "res-late-adopt",
    "res-late-residual",
    "res-free",
    "res-late-fault",
  ])
    expect(
      none(id)?.passed === false,
      `4: ${id} fails on an empty tree`,
      none(id),
    );

  const skipped = await run(
    mk((r) => {
      for (const l of ["import/fixture", ...legs]) {
        leg(r, l, null);
        writeFileSync(join(r, "g8res", l, "skipped-by-tier.txt"), "x\n");
      }
    }),
  );
  expect(
    skipped("res-legs")?.passed === false &&
      skipped("res-legs")?.status === "fail",
    "4: res-legs on an all-skipped tree is the explicit evidence-missing verdict",
    skipped("res-legs"),
  );

  console.log(
    `\nself-test-gate8-res: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
