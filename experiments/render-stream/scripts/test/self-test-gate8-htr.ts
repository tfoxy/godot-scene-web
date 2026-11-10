#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's headless texture eviction judges on fabricated evidence.
// Each judge accepts an honest shape and rejects mutations of its assertions.
// Run: mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate8-htr.ts
import {
  alwaysSupersetProblems,
  costStandbyProblems,
  EVICT_SKIP_KEYS,
  type EvictEvidence,
  evictArmedProblems,
  evictFixtureProblems,
  faultAlwaysIgnorePredicateProblems,
  type HtrStats,
  noImageTextureReleaseProblems,
  type StandbyCostRound,
  standbyHotZeroEvictProblems,
  type TextureEvent,
} from "../lib/gate8-htr-checks";
import { STANDBY_HOOKS } from "../lib/registry-checks";

let assertions = 0;
let failures = 0;
function assert(ok: boolean, name: string) {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}`);
  }
}
function rejects<T>(
  name: string,
  honest: T,
  judge: (v: T) => string[],
  changes: ((v: T) => void)[],
) {
  assert(judge(honest).length === 0, `${name}: honest`);
  for (const [i, change] of changes.entries()) {
    const bad = structuredClone(honest);
    change(bad);
    assert(judge(bad).length > 0, `${name}: mutation ${i}`);
  }
}
function evidence(armed = false, cost = false): EvictEvidence {
  return {
    schema: "render-stream-evict/1",
    final: true,
    state: "active",
    reason: null,
    min_bytes: 4096,
    per_frame: 32,
    noted: cost ? 6 : 16,
    queued: cost ? 6 : 16,
    examined: cost ? 6 : 16,
    queue_dropped: 0,
    requeued: 0,
    pending: 0,
    parked: 0,
    released: cost ? 6 : 8,
    released_bytes: cost ? 20971520 : 32768,
    released_armed: armed ? 8 : 0,
    evict_balanced: true,
    lifetime_frames_max: 1,
    drain_us_max: 5000,
    releases_dropped: 0,
    skipped: Object.fromEntries(
      EVICT_SKIP_KEYS.map((k) => [
        k,
        cost ? 0 : k === "below_min" ? 6 : k === "format" ? 2 : 0,
      ]),
    ) as EvictEvidence["skipped"],
    releases: Array.from({ length: cost ? 6 : 8 }, (_, i) => ({
      path: `res://${i}.ctex`,
      data_bytes: cost ? (i < 2 ? 2097152 : 4194304) : 4096,
      format: 17,
      armed,
    })),
    rss_test: cost
      ? { batches: 6, measured_bytes: 20971520, freed_bytes: 20971520 }
      : null,
  };
}
const htr = {
  released: 0,
  released_bytes: 0,
  released_then_unheld: 0,
  kept_adopted: 0,
  skipped: { inactive: 0, refused: 0, format: 0, omitted: 0 },
  fault: "off",
} as HtrStats;
const shape = {
  width: 64,
  height: 64,
  format: 17,
  mipmaps: false,
  sha256: "a".repeat(64),
};
const probe: TextureEvent = {
  event: "imagetexture-probe",
  frame: 40,
  expected: shape,
  got: { ...shape },
};
const evictChanges: ((v: EvictEvidence) => void)[] = [
  ...["schema", "state", "reason"].map((k) => (v: EvictEvidence) => {
    Object.assign(v, { [k]: "wrong" });
  }),
  ...["final", "evict_balanced"].map((k) => (v: EvictEvidence) => {
    Object.assign(v, { [k]: false });
  }),
  ...[
    "min_bytes",
    "per_frame",
    "noted",
    "queued",
    "examined",
    "queue_dropped",
    "requeued",
    "pending",
    "parked",
    "released",
    "released_armed",
    "releases_dropped",
    "released_bytes",
  ].map((k) => (v: EvictEvidence) => {
    Object.assign(v, { [k]: Number(v[k as keyof EvictEvidence]) + 1 });
  }),
  ...EVICT_SKIP_KEYS.map((k) => (v: EvictEvidence) => {
    v.skipped[k]++;
  }),
  (v) => {
    v.lifetime_frames_max = 2;
  },
  (v) => {
    v.drain_us_max = 5001;
  },
  (v) => {
    v.releases.pop();
  },
  (v) => {
    v.releases[0].path = "res://a.png";
  },
  (v) => {
    v.releases[0].data_bytes = 4095;
  },
  (v) => {
    v.releases[0].format = 16;
  },
  (v) => {
    v.releases[0].format = 39;
  },
  (v) => {
    v.releases[0].armed = !v.releases[0].armed;
  },
];
rejects(
  "standby eviction",
  evidence(),
  (e) => evictFixtureProblems(e, false),
  evictChanges,
);
rejects(
  "armed eviction",
  evidence(true),
  (e) => evictArmedProblems(e, true),
  evictChanges,
);
assert(evictFixtureProblems(null, false).length > 0, "missing evidence");
assert(
  evictArmedProblems(evidence(true), false).length > 0,
  "armed recording differs",
);
rejects(
  "no ImageTexture release",
  { probe, htr, evict: evidence() },
  (v) => noImageTextureReleaseProblems(v.probe, v.htr, v.evict, true),
  [
    (v) => {
      v.probe.got = null;
    },
    (v) => {
      v.probe.got!.sha256 = "b".repeat(64);
    },
    (v) => {
      v.htr.released = 1;
    },
    (v) => {
      v.evict.releases[0].path = "res://image.png";
    },
  ],
);
assert(
  noImageTextureReleaseProblems(probe, null, null, true).length > 0,
  "missing probe evidence",
);
const fault = {
  probe: { ...probe, got: { ...shape, width: 1, height: 1, format: 0 } },
  htr: { ...htr, fault: "ignore-predicate", released: 1 },
  evict: evidence(),
};
let missingProbeProblems: string[] = [];
try {
  missingProbeProblems = faultAlwaysIgnorePredicateProblems(
    null,
    fault.htr,
    fault.evict,
  );
  assert(true, "fault judge does not throw for a missing probe");
} catch {
  assert(false, "fault judge does not throw for a missing probe");
}
assert(missingProbeProblems.length > 0, "fault judge rejects a missing probe");
assert(
  faultAlwaysIgnorePredicateProblems(fault.probe, fault.htr, null).length > 0,
  "fault judge rejects missing evict evidence",
);
assert(
  noImageTextureReleaseProblems(
    fault.probe,
    fault.htr,
    fault.evict,
    true,
  ).includes("ImageTexture probe differs"),
  "standby fault evidence fails the probe",
);
rejects(
  "fault caught",
  fault,
  (v) => faultAlwaysIgnorePredicateProblems(v.probe, v.htr, v.evict),
  [
    (v) => {
      v.probe.got = { ...shape };
    },
    ...["width", "height", "format"].map((k) => (v: typeof fault) => {
      Object.assign(v.probe.got, { [k]: 99 });
    }),
    (v) => {
      v.probe.got.mipmaps = true;
    },
    (v) => {
      v.htr.fault = "off";
    },
    (v) => {
      v.htr.released = 0;
    },
  ],
);
const superset = {
  always: htr,
  on: structuredClone(htr),
  evict: { ...evidence(), state: "ignored", reason: "registry-off", noted: 0 },
  identical: true,
};
rejects(
  "always superset",
  superset,
  (v) => alwaysSupersetProblems(v.always, v.on, v.evict, v.identical),
  [
    (v) => {
      v.identical = false;
    },
    ...[
      "released",
      "released_bytes",
      "released_then_unheld",
      "kept_adopted",
    ].map((k) => (v: typeof superset) => {
      Object.assign(v.always, { [k]: 1 });
    }),
    ...["inactive", "refused", "format", "omitted"].map(
      (k) => (v: typeof superset) => {
        Object.assign(v.always.skipped, { [k]: 1 });
      },
    ),
    (v) => {
      v.evict.state = "active";
    },
    (v) => {
      v.evict.reason = "not-headless";
    },
    (v) => {
      v.evict.noted = 1;
    },
  ],
);
assert(
  alwaysSupersetProblems(null, null, null, true).length > 0,
  "superset missing evidence",
);
const cost: StandbyCostRound[] = [
  {
    round: 1,
    evict: evidence(false, true),
    off: htr,
    off_exit: "0",
    always_exit: "0",
    off_rss: 40000000,
    always_rss: 19028480,
  },
];
rejects("standby cost", cost, costStandbyProblems, [
  ...evictChanges.map(
    (change) => (v: StandbyCostRound[]) => change(v[0].evict!),
  ),
  (v) => {
    v[0].off_exit = "1";
  },
  (v) => {
    v[0].always_exit = "1";
  },
  (v) => {
    v[0].off = null;
  },
  (v) => {
    v[0].off!.released = 1;
  },
  (v) => {
    v[0].off!.evict = evidence();
  },
  (v) => {
    v[0].evict!.rss_test = null;
  },
  (v) => {
    v[0].evict!.rss_test!.batches = 0;
  },
  (v) => {
    v[0].evict!.rss_test!.measured_bytes--;
  },
  (v) => {
    v[0].evict!.rss_test!.freed_bytes--;
  },
  (v) => {
    v[0].off_rss = null;
  },
  (v) => {
    v[0].always_rss = null;
  },
  (v) => {
    v[0].off_rss = -1;
  },
  (v) => {
    v[0].always_rss = -1;
  },
  (v) => {
    v[0].always_rss = v[0].off_rss! - 10485759;
  },
]);
assert(costStandbyProblems([]).length > 0, "cost missing rounds");
const median = [
  structuredClone(cost[0]),
  structuredClone(cost[0]),
  structuredClone(cost[0]),
];
median[0].always_rss = median[0].off_rss;
assert(
  costStandbyProblems(median).length === 0,
  "RSS judges median across rounds",
);
const hot = [
  {
    name: "standby",
    result: {
      status: "standby",
      vtable: { standby_hooks: [STANDBY_HOOKS[0]] },
    },
    counters: { hooks_planned: [STANDBY_HOOKS[0], "hot"], counts: { hot: 0 } },
  },
];
rejects("standby hot zero", hot, standbyHotZeroEvictProblems, [
  (v) => {
    v[0].result.status = "armed";
  },
  (v) => {
    v[0].counters.counts.hot = 1;
  },
  (v) => {
    v[0].result.vtable.standby_hooks.push("hot");
  },
  (v) => {
    v[0].result.vtable.standby_hooks = [];
  },
  (v) => {
    v[0].counters.hooks_planned = [STANDBY_HOOKS[0]];
  },
]);
console.log(
  `gate8-htr self-test: ${assertions - failures}/${assertions} passed, ${failures} failed`,
);
process.exitCode = failures ? 1 : 0;
