// Desktop Node benchmark of full metadata parsing and TS filter-table packing.
// Run from the repo root through tsx --conditions=development; optional argv[2] writes JSON.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  type ExtensionCore,
  ExtensionHost,
  type ItemMetaBatch,
  type ItemMetaField,
} from "../src/extensions";

const rows = 4202,
  iterations = 100,
  repeats = 6;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function setup(v2: boolean) {
  const fields: ItemMetaField[] = [
    "class",
    "script",
    "scene",
    "path",
    ...(v2 ? (["instance_id", "mouse_filter"] as const) : []),
  ];
  const strings = [
    "Control",
    "res://script.gd",
    "res://scene.tscn",
    ...Array.from({ length: rows }, (_, i) => `Root/Control${i}`),
  ];
  const record = {
    type: "item_meta",
    form: "full",
    grant: { fields, groups: ["controls"], meta_keys: ["tag"] },
    strings_from: 0,
    strings,
    items: Array.from({ length: rows }, (_, i) => [
      i,
      0,
      1,
      2,
      i + 3,
      ...(v2 ? [String(9007199254740993n + BigInt(i)), 0] : []),
      1,
      0,
    ]),
  };
  let json = JSON.stringify(record),
    copies = 0,
    count = 0,
    last: ItemMetaBatch | undefined;
  const core = {
    itemMetaJson: () => json,
    setLogRemoved: () => {},
    setPickOrder: () => {},
    setHitFilters: (ids: Uint32Array, filters: Uint8Array) => {
      count = ids.length;
      assert.equal(filters.length, count);
      copies++;
    },
  } as unknown as ExtensionCore;
  const host = new ExtensionHost([
    {
      id: "bench",
      wants: { fields, groups: ["controls"], metaKeys: ["tag"] },
      onItemMeta: (b) => {
        last = b;
      },
    },
  ]);
  host.bind(core);
  host.beginSession("bench", "bench");
  host.itemMeta();
  assert.equal(last?.items.length, rows);
  if (v2)
    assert.equal(
      last?.items[rows - 1].instanceId,
      String(9007199254740993n + BigInt(rows - 1)),
    );
  return {
    host,
    change: (i: number) => {
      record.items[0][6] = i % 2 === 0 ? 2 : 0;
      json = JSON.stringify(record);
    },
    verify: () => {
      assert.equal(count, rows);
      return copies;
    },
  };
}
const tag = setup(false),
  v2 = setup(true);
const tagSamples: number[] = [],
  v2Samples: number[] = [],
  rebuildSamples: number[] = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const measure = (s: ReturnType<typeof setup>) => {
    const t = performance.now();
    for (let i = 0; i < iterations; i++) {
      s.host.beginFrame();
      s.host.itemMeta();
    }
    return ((performance.now() - t) * 1000) / iterations;
  };
  // Alternate arm order to avoid consistently charging one arm for earlier GC/JIT state.
  let t: number, v: number;
  if (repeat % 2 === 0) {
    t = measure(tag);
    v = measure(v2);
  } else {
    v = measure(v2);
    t = measure(tag);
  }
  let rebuild = 0;
  for (let i = 0; i < iterations; i++) {
    v2.change(i);
    v2.host.beginFrame();
    v2.host.itemMeta();
    const t0 = performance.now();
    v2.host.flushHitFilters();
    rebuild += performance.now() - t0;
  }
  if (repeat > 0) {
    tagSamples.push(t);
    v2Samples.push(v);
    rebuildSamples.push((rebuild * 1000) / iterations);
  }
}
assert.equal(v2.verify(), repeats * iterations);
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  rows,
  iterations_per_repeat: iterations,
  warmup_repeats: 1,
  measured_repeats: 5,
  units: "microseconds per full item_meta record / whole filter table",
  tag1_apply_us: median(tagSamples),
  v2_apply_us: median(v2Samples),
  apply_ratio: median(v2Samples) / median(tagSamples),
  filter_rebuild_us: median(rebuildSamples),
  tag1_samples_us: tagSamples,
  v2_samples_us: v2Samples,
  filter_rebuild_samples_us: rebuildSamples,
  notes:
    "Node desktop, ExtensionHost.itemMeta including JSON.parse and callbacks; setHitFilters sink validates lengths but omits wasm transfer. Filter restamps parsed outside rebuild timing.",
};
const out = process.argv[2];
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.apply_ratio > 1.5 || report.filter_rebuild_us > 200)
  process.exitCode = 1;
