#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8cg checks (lib/gate8-cg-checks.ts, CG1) on the committed
// fixtures/gate8-cg/expected.json and on synthetic items, sessions, counters and images, each with
// a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-cg.ts
//
// 1. expected.json is self-consistent: every cell's region lies on the 640x360 target and no two
//    overlap; every `removes` use is a use some cell has; each leg that removes something has a
//    cell it must change at some checkpoint; the toggle is a checkpoint.
// 2. wireStateProblems: the fixture's items at step 0 and step 2 pass; a dropped canvas_group, a
//    wrong margin, a rect copy re-sent as Rect2() (full-backbuffer-copy on the wire), an extra
//    state, a group owner with commands where none are expected and a missing key each fail.
// 3. toggleProblems: one state-only entry passes; commands carried, the wrong mode, a second entry
//    and no entry each fail.
// 4. sessionProblems / itemKeyProblems / hookCountProblems: the /10 and /9 shapes pass; a hook left
//    unobserved at /10, a hook planned at /9, a /10 key below /10, a missed call and an invalid
//    mode each fail.
// 5. cellProblems / exactProblems: synthetic images built from expected.json's cells -- an exact
//    copy passes exactProblems and fails cellProblems for every comparison leg (nothing differs);
//    an image changed exactly in the cells a leg's `removes` reaches passes for that leg and fails
//    for the others (so each sabotage would be caught, and a sabotage that did nothing fails), and
//    a stray pixel outside every cell fails.
// 6. modelProblems: an image painted from the model passes; an unclipped HP row, a BBR right half
//    showing the backdrop (a whole-target copy) and an off-by-one inverted pixel each fail.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CgItem,
  type CgUse,
  cellDiff,
  cellProblems,
  exactProblems,
  type G8cgExpected,
  hookCountProblems,
  itemKeyProblems,
  modelProblems,
  type PatchTransaction,
  patternRgb,
  type Rgba,
  sessionProblems,
  toggleProblems,
  wireStateProblems,
} from "../lib/gate8-cg-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");
const W = 640;
const H = 360;

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

/** The fixture's items with /10 state at `step`, as expected.json describes them, plus plain items. */
function fixtureItems(e: G8cgExpected, step: number): CgItem[] {
  const items: CgItem[] = [];
  let id = 100;
  const cmds = (has: boolean) => (has ? [{ op: "add_rect" }] : []);
  for (const w of e.wire.canvas_group)
    if (w.from_step <= step)
      for (let i = 0; i < w.count; i++)
        items.push({
          id: id++,
          canvas_group: { ...w.state },
          copy_to_backbuffer: null,
          commands: cmds(w.commands),
        });
  for (const w of e.wire.copy_to_backbuffer)
    if (w.from_step <= step)
      for (let i = 0; i < w.count; i++)
        items.push({
          id: id++,
          canvas_group: null,
          copy_to_backbuffer: { rect: [...(w.state.rect as number[])] },
          commands: cmds(w.commands),
        });
  for (let i = 0; i < 12; i++)
    items.push({
      id: id++,
      canvas_group: null,
      copy_to_backbuffer: null,
      commands: cmds(true),
    });
  return items;
}

function blank(): Rgba {
  const data = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) data.set([51, 51, 102, 255], p * 4);
  return { width: W, height: H, data };
}

function clone(img: Rgba): Rgba {
  return {
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data),
  };
}

function poke(img: Rgba, x: number, y: number, rgb: number[]): void {
  img.data.set([rgb[0], rgb[1], rgb[2], 255], (y * img.width + x) * 4);
}

/** An image painted from the model: the pattern/invert cells, the solid rect, and an HP row whose
 * fill colour shows only on the inside row. */
function modelImage(e: G8cgExpected): Rgba {
  const img = blank();
  for (const r of e.model.invert)
    for (let y = 0; y < r.size[1]; y++)
      for (let x = 0; x < r.size[0]; x++)
        poke(
          img,
          r.origin[0] + x,
          r.origin[1] + y,
          patternRgb(r.seed, x >> 2, y >> 2).map((v) => 255 - v),
        );
  for (const r of e.model.pattern)
    for (let y = 0; y < r.size[1]; y++)
      for (let x = 0; x < r.size[0]; x++)
        poke(
          img,
          r.origin[0] + x,
          r.origin[1] + y,
          patternRgb(r.seed, x >> 2, y >> 2),
        );
  for (const s of e.model.solid)
    for (let y = s.rect[1]; y <= s.rect[3]; y++)
      for (let x = s.rect[0]; x <= s.rect[2]; x++) poke(img, x, y, s.rgb);
  const c = e.model.clipped_rows;
  for (let x = c.x[0]; x <= c.x[1]; x++)
    poke(img, x, c.inside_y, [166, 41, 29]);
  return img;
}

async function main(): Promise<void> {
  const e = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate8-cg", "expected.json"),
      "utf8",
    ),
  ) as G8cgExpected;
  const steps = e.checkpoints.map((c) => c.step);

  // 1. self-consistency
  {
    const cells = Object.entries(e.cells);
    for (const [n, c] of cells) {
      const [x0, y0, x1, y1] = c.region;
      assert(
        x0 >= 0 && y0 >= 0 && x1 < W && y1 < H && x0 <= x1 && y0 <= y1,
        `${n}: region on the target`,
      );
      assert(
        c.steps.every((s) => steps.includes(s)),
        `${n}: steps are checkpoints`,
      );
    }
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i][1].region;
        const b = cells[j][1].region;
        const overlap =
          a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
        assert(!overlap, `${cells[i][0]} and ${cells[j][0]} do not overlap`);
      }
    const used = new Set(cells.flatMap(([, c]) => c.uses));
    for (const [leg, uses] of Object.entries(e.removes)) {
      assert(
        uses.length > 0 && uses.every((u) => used.has(u)),
        `${leg}: removes only uses some cell has`,
      );
      assert(
        cells.some(
          ([, c]) => c.uses.some((u) => uses.includes(u)) && c.steps.length > 0,
        ),
        `${leg}: some cell must change`,
      );
    }
    assert(
      steps.includes(e.toggle.step) &&
        e.late_steps.every((s) => steps.includes(s)),
      "toggle and late steps are checkpoints",
    );
    assert(
      e.late_steps.every(
        (s) =>
          (e.checkpoints.find((c) => c.step === s)?.applied ?? 0) > e.arm_frame,
      ),
      "late steps are applied after the arm frame",
    );
  }

  // 2. wireStateProblems
  {
    for (const step of steps)
      assert(
        wireStateProblems(fixtureItems(e, step), e, step).problems.length === 0,
        `the fixture's items pass at step ${step}`,
      );
    const s2 = fixtureItems(e, 2);
    assert(
      wireStateProblems(s2, e, 0).problems.length > 0,
      "step 2's items (the toggle applied) fail at step 0",
    );
    const dropped = fixtureItems(e, 0);
    dropped[0].canvas_group = null;
    assert(
      wireStateProblems(dropped, e, 0).problems.length > 0,
      "a dropped canvas_group fails",
    );
    const margin = fixtureItems(e, 0);
    const t = margin.find((i) => i.canvas_group?.mode === "transparent");
    if (t?.canvas_group) t.canvas_group.fit_margin = 7;
    assert(
      wireStateProblems(margin, e, 0).problems.length > 0,
      "a wrong fit_margin fails",
    );
    const full = fixtureItems(e, 0);
    const rc = full.find((i) =>
      i.copy_to_backbuffer?.rect.some((v) => v !== 0),
    );
    if (rc?.copy_to_backbuffer) rc.copy_to_backbuffer.rect = [0, 0, 0, 0];
    assert(
      wireStateProblems(full, e, 0).problems.length > 0,
      "a rect copy sent as Rect2() fails",
    );
    const extra = fixtureItems(e, 0);
    extra.push({
      id: 9999,
      canvas_group: { ...e.wire.canvas_group[0].state },
      copy_to_backbuffer: null,
      commands: [],
    });
    assert(
      wireStateProblems(extra, e, 0).problems.length > 0,
      "an extra state fails",
    );
    const cmds = fixtureItems(e, 0);
    const owner = cmds.find((i) => i.canvas_group?.mode === "transparent");
    if (owner) owner.commands = [{ op: "add_rect" }];
    assert(
      wireStateProblems(cmds, e, 0).problems.length > 0,
      "a group owner with unexpected commands fails",
    );
    const nokey = fixtureItems(e, 0);
    delete (nokey[nokey.length - 1] as { canvas_group?: unknown }).canvas_group;
    assert(
      wireStateProblems(nokey, e, 0).problems.length > 0,
      "an item lacking the /10 key fails",
    );
  }

  // 3. toggleProblems
  {
    const ok: PatchTransaction[] = [
      { frame: 18, items: [] },
      {
        frame: e.toggle.frame,
        items: [
          { id: 7, canvas_group: { mode: e.toggle.mode }, commands: null },
        ],
      },
      { frame: 26, items: [] },
    ];
    assert(toggleProblems(ok, e).length === 0, "one state-only entry passes");
    const withCmds = structuredClone(ok);
    withCmds[1].items[0].commands = [{ op: "add_rect" }];
    assert(
      toggleProblems(withCmds, e).length > 0,
      "the toggle carrying commands fails",
    );
    const wrongMode = structuredClone(ok);
    wrongMode[1].items[0].canvas_group = { mode: "clip_and_draw" };
    assert(toggleProblems(wrongMode, e).length > 0, "the wrong mode fails");
    const two = structuredClone(ok);
    two[2].items.push({ id: 8, commands: null });
    assert(toggleProblems(two, e).length > 0, "a second entry fails");
    assert(
      toggleProblems([{ frame: 20, items: [] }], e).length > 0,
      "no entry fails",
    );
  }

  // 4. sessions, item keys, counters
  {
    const m = [e.hooks.canvas_group_mode, e.hooks.copy_to_backbuffer];
    const v10 = {
      protocol: "render-stream/10",
      capture: { hooks_planned: [...m, "x"], hooks_omitted: [] },
      features: { unobserved: ["y"] },
    };
    const v9 = {
      protocol: "render-stream/9",
      capture: { hooks_planned: ["x"], hooks_omitted: [] },
      features: { unobserved: ["y", ...m] },
    };
    assert(sessionProblems(v10, 10, m).length === 0, "a /10 session passes");
    assert(sessionProblems(v9, 9, m).length === 0, "a /9 session passes");
    assert(sessionProblems(v9, 10, m).length > 0, "a /9 session fails as /10");
    assert(
      sessionProblems({ ...v10, features: { unobserved: [m[0]] } }, 10, m)
        .length > 0,
      "a hooked method left unobserved at /10 fails",
    );
    assert(
      sessionProblems(
        { ...v9, capture: { hooks_planned: [m[1]], hooks_omitted: [] } },
        9,
        m,
      ).length > 0,
      "a hook planned below /10 fails",
    );
    assert(
      itemKeyProblems([{ frame: 3, items: [{ id: 1 }] }]).length === 0,
      "/9 items without keys pass",
    );
    assert(
      itemKeyProblems([{ frame: 3, items: [{ id: 1, canvas_group: null }] }])
        .length > 0,
      "a /10 key below /10 fails",
    );
    const counts = {
      [m[0]]: e.hooks.canvas_group_mode_calls,
      [m[1]]: e.hooks.copy_to_backbuffer_calls,
    };
    assert(
      hookCountProblems({ counts, captured: {} }, e.hooks).length === 0,
      "the expected call counts pass",
    );
    assert(
      hookCountProblems(
        {
          counts: { ...counts, [m[0]]: counts[m[0]] + e.hooks.teardown_slack },
          captured: {},
        },
        e.hooks,
      ).length === 0,
      "teardown's disabling calls pass",
    );
    assert(
      hookCountProblems(
        { counts: { ...counts, [m[0]]: counts[m[0]] - 1 } },
        e.hooks,
      ).length > 0,
      "a missed call fails",
    );
    assert(
      hookCountProblems(
        { counts: { ...counts, [m[1]]: counts[m[1]] + 1 } },
        e.hooks,
      ).length > 0,
      "an extra copy call fails",
    );
    assert(
      hookCountProblems(
        { counts, captured: { canvas_group_mode_invalid: 1 } },
        e.hooks,
      ).length > 0,
      "an invalid mode fails",
    );
    assert(
      hookCountProblems(undefined, e.hooks).length > 0,
      "no counters fails",
    );
  }

  // 5. cellProblems / exactProblems
  {
    const ref = modelImage(e);
    const same = cellDiff(clone(ref), ref, e.cells);
    assert(
      same !== null && exactProblems(same).length === 0,
      "an exact copy passes exactProblems",
    );
    const changedIn = (uses: CgUse[], step: number): Rgba => {
      const img = clone(ref);
      for (const c of Object.values(e.cells))
        if (c.steps.includes(step) && c.uses.some((u) => uses.includes(u)))
          poke(img, c.region[0] + 2, c.region[1] + 2, [1, 2, 3]);
      return img;
    };
    for (const [leg, uses] of Object.entries(e.removes))
      for (const step of steps) {
        const d = cellDiff(changedIn(uses, step), ref, e.cells);
        assert(
          d !== null && cellProblems(d, e.cells, uses, step).length === 0,
          `${leg} step ${step}: the modelled difference passes`,
        );
        assert(
          d !== null && exactProblems(d).length > 0,
          `${leg} step ${step}: exactProblems catches it`,
        );
        assert(
          cellProblems(same as NonNullable<typeof same>, e.cells, uses, step)
            .length > 0,
          `${leg} step ${step}: a sabotage that changed nothing fails`,
        );
        for (const [other, otherUses] of Object.entries(e.removes)) {
          if (other === leg) continue;
          const differ = steps.some((s) => {
            const a = cellDiff(changedIn(uses, s), ref, e.cells);
            return (
              a !== null && cellProblems(a, e.cells, otherUses, s).length > 0
            );
          });
          assert(differ, `${leg}'s picture is not mistaken for ${other}'s`);
        }
        const stray = changedIn(uses, step);
        poke(stray, 5, 355, [9, 9, 9]);
        const ds = cellDiff(stray, ref, e.cells);
        assert(
          ds !== null && cellProblems(ds, e.cells, uses, step).length > 0,
          `${leg} step ${step}: a stray pixel fails`,
        );
      }
  }

  // 6. modelProblems
  {
    const img = modelImage(e);
    assert(modelProblems(img, e.model).length === 0, "the model image passes");
    const unclipped = clone(img);
    const c = e.model.clipped_rows;
    poke(unclipped, c.x[0] + 3, c.outside_y[0], [166, 41, 29]);
    assert(
      modelProblems(unclipped, e.model).length > 0,
      "an unclipped HP row fails",
    );
    const wholeCopy = clone(img);
    const s = e.model.solid[0];
    for (let y = s.rect[1]; y <= s.rect[3]; y++)
      for (let x = s.rect[0]; x <= s.rect[2]; x++)
        poke(
          wholeCopy,
          x,
          y,
          patternRgb(4, (x - 136) >> 2, (y - 136) >> 2).map((v) => 255 - v),
        );
    assert(
      modelProblems(wholeCopy, e.model).length > 0,
      "BBR's right half showing its backdrop (a whole-target copy) fails",
    );
    const off = clone(img);
    const inv = e.model.invert[0];
    const p = patternRgb(inv.seed, 0, 0).map((v) => 254 - v);
    poke(off, inv.origin[0], inv.origin[1], p);
    assert(
      modelProblems(off, e.model).length > 0,
      "an off-by-one inverted pixel fails",
    );
  }

  console.log(
    `\nself-test-gate8-cg: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
