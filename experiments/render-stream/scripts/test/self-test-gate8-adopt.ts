#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8a checks (lib/gate8-adopt-checks.ts, G8a) on the committed
// fixtures/gate8-adopt/expected.json and on synthetic resolved states, each with a passing and a
// failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-adopt.ts
//
// 1. expected.json is self-consistent (census and checkpoints).
// 2. compareStates: a born state and its late twin (other ids, other list order, other draw-index
//    values, adopted origins) are equal; the born-only commandless trailing item is the residue;
//    a changed transform, a changed command on a visible item and a missing item each fail; a
//    hidden item's commands, custom rect and clip are exempt, its effective visibility is not.
// 3. censusProblems: the census passes; a wrong count, a missing adoption time and the
//    skip-layers account each behave as specified.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalState,
  censusProblems,
  compareStates,
  type G8aExpected,
} from "../lib/gate8-adopt-checks";
import type { ResolvedItem, ResolvedTransaction } from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

type State = ResolvedTransaction["state"];

function item(id: number, parent: { kind: "canvas" | "item"; id: number }, over: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id,
    origin: "created",
    parent,
    children: [],
    visible: true,
    draw_index: 0,
    z_index: 0,
    z_relative: true,
    behind: false,
    clip: false,
    custom_rect: false,
    visibility_layer: 1,
    texture_filter: "default",
    texture_repeat: "default",
    material: null,
    use_parent_material: false,
    instance_params: [],
    content_version: 1,
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    custom_rect_rect: [0, 0, 0, 0],
    commands: [{ op: "add_rect", aa: false, rect: [0, 0, 10, 10], color: [1, 0, 0, 1] }],
    ...over,
  } as ResolvedItem;
}

function state(items: ResolvedItem[], rootItems: number[]): State {
  return {
    status: "ok",
    failures: [],
    unsupported: [],
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    canvases: [
      { id: 1, origin: "root-query", role: "root", attached: true, layer: 0, sublayer: 0, items: rootItems, xform: [1, 0, 0, 1, 0, 0], modulate: [1, 1, 1, 1] },
    ],
    items,
    textures: [],
  } as unknown as State;
}

// born: A(draw 0) > [B(0), C(1, hidden, drew before hiding)], D(1), residue R(1000, no commands)
function born(): State {
  return state(
    [
      item(1, { kind: "canvas", id: 1 }, { children: [2, 3], draw_index: 0, xform: [1, 0, 0, 1, 5, 5] }),
      item(2, { kind: "item", id: 1 }, { draw_index: 0 }),
      item(3, { kind: "item", id: 1 }, { draw_index: 1, visible: false, custom_rect: true, custom_rect_rect: [0, 0, 4, 4] }),
      item(4, { kind: "canvas", id: 1 }, { draw_index: 1, commands: [{ op: "add_rect", aa: false, rect: [1, 1, 2, 2], color: [0, 1, 0, 1] }] }),
      item(5, { kind: "canvas", id: 1 }, { draw_index: 1000, commands: [] }),
    ],
    [1, 4, 5],
  );
}

// late: the same scene adopted: other ids, D listed first, raised to 7/8, C hidden at arm (no
// commands, no custom rect), no residue.
function late(mut: (items: ResolvedItem[]) => void = () => {}): State {
  const items = [
    item(10, { kind: "canvas", id: 1 }, { origin: "adopted", draw_index: 8, commands: [{ op: "add_rect", aa: false, rect: [1, 1, 2, 2], color: [0, 1, 0, 1] }] }),
    item(11, { kind: "canvas", id: 1 }, { origin: "adopted", children: [13, 12], draw_index: 7, xform: [1, 0, 0, 1, 5, 5] }),
    item(12, { kind: "item", id: 11 }, { origin: "adopted", draw_index: 1, visible: false, commands: [] }),
    item(13, { kind: "item", id: 11 }, { origin: "adopted", draw_index: 0 }),
  ];
  mut(items);
  return state(items, [10, 11]);
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-adopt", "expected.json"), "utf8"),
  ) as G8aExpected;

  // 1. expected.json
  assert(expected.schema === "render-stream-gate8-adopt-expected/1", "expected.json schema");
  assert(expected.census.redraws === expected.census.items, "one redraw per adopted item");
  assert(expected.visible_at_arm === expected.census.items - expected.census.hidden, "draws = visible items");
  assert(expected.census.canvases === expected.census.layers, "one canvas per adopted layer");
  assert(
    expected.checkpoints.every((c, i) => c.step === i && c.settle > c.applied) &&
      expected.checkpoints[0].applied === 0,
    "checkpoints start at the arm and settle after they apply",
  );

  // 2. compareStates
  const b = canonicalState(born());
  {
    const r = compareStates(b, canonicalState(late()));
    assert(r.problems.length === 0, `the adopted twin equals born (${r.problems.join("; ")})`);
    assert(r.residue === 1, "the born-only commandless trailing item is the residue");
  }
  {
    const r = compareStates(b, canonicalState(late((i) => { i[1].xform = [1, 0, 0, 1, 0, 0]; })));
    assert(r.problems.some((p) => p.includes("xform")), "a missing transform fails");
  }
  {
    const r = compareStates(b, canonicalState(late((i) => { i[3].commands = []; })));
    assert(r.problems.some((p) => p.includes("commands")), "a visible item without its commands fails");
  }
  {
    const r = compareStates(b, canonicalState(late((i) => { i[2].visible = true; })));
    assert(r.problems.some((p) => p.includes("effective visibility")), "effective visibility is compared");
  }
  {
    const r = compareStates(b, canonicalState(state(late().items.filter((i) => i.id !== 10), [11])));
    assert(r.problems.some((p) => p.includes("only in born")), "a missing drawing item fails");
  }
  {
    // order: swapping the raised draw indices of the two root items changes the draw order
    const r = compareStates(b, canonicalState(late((i) => { i[0].draw_index = 6; })));
    assert(r.problems.length > 0, "a changed draw order fails");
  }

  // 3. censusProblems
  const ok = { ran: true, error: null, ...expected.census, total_ns: 1000 } as Record<string, number | string | boolean | null>;
  assert(censusProblems(ok, expected.census).length === 0, "the census passes");
  assert(censusProblems({ ...ok, items: 19 }, expected.census).length === 1, "a wrong count fails");
  assert(censusProblems({ ...ok, total_ns: 0 }, expected.census).length === 1, "no adoption time fails");
  assert(
    censusProblems({ ...ok, layers: 0, canvases: 0 }, expected.census, "adopt-skip-layers").length === 0,
    "the skip-layers account adopts no layer",
  );
  assert(censusProblems(undefined, expected.census).length === 1, "no stats fails");

  console.log(`\nself-test-gate8-adopt: ${assertions - failures}/${assertions} assertions passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
