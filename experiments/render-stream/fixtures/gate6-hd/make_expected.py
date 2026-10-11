#!/usr/bin/env python3
"""Write fixtures/gate6-hd/expected.json (render-stream-gate6-hd-expected/1).

The HD fixture is nine copies of the gate 6 scene in a 3x3 GridContainer at logical 1920x1080
under `canvas_items` stretch (protocol/gate6-design.md "Q6e", G6h). Its model is gate6-scene's
(../gate6-scene/make_expected.py, imported, never copied): every cell is that model's scene at
the cell's phase, translated by the cell's origin, and the `half` presentation is the same scene
under the stretch transform scale(0.5) with StyleBoxFlat's antialiasing feather widened to
aa_size / 0.5 in canvas units (style_box_flat.cpp:497-511), which is the only scale-dependent
lowering the scene has (Q1b; text is undecided either way). Nothing here runs or reads the engine.

    python3 experiments/render-stream/fixtures/gate6-hd/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate6-hd/make_expected.py --check   # diff only
    python3 experiments/render-stream/fixtures/gate6-hd/make_expected.py --sync    # copy shared files

`--sync` copies the files the HD project shares with gate6-scene (the builder, its oracle, the
loader and SM's shader) so the project stays `res://`-independent; `--check` also fails when a
copy differs from its source.

The model, per cell c (row-major, origin (640 (c mod 3), 360 floor(c / 3)), phase 7c):
- State: gate6-scene's state at the same fixture frame (every cell applies step k at the same
  frame), with the continuous values read at frame + 7c (MS's pose, SM's phase, AN's x, PB's
  value; D6's quarter-frame clocks start at the phase), TEXA's content offset by 100c (TEXA(100c),
  TEXA(1 + 100c), TEXB = TEXA(1000 + 100c)), and the HUD at layer 1 + c (-1 - c at step 9).
- Focus: one viewport has one focus owner; the builder grabs LE's focus in every cell, so only
  the last cell built (8) keeps it. The other LineEdits draw neither the focus box nor a caret
  (G6a's probe: an unfocused LineEdit draws its selection but no focus box and no caret); every
  cell keeps its selection (gate6_hd.gd sets deselect_on_focus_loss_enabled = false).
- Paint order: the root canvas holds Grid (draw index 0) and the nine top_level TLs; within the
  grid, cell order; every ZH (z 100) after every z-0 item; the HUD canvases above at layers
  1..9. No two cells' shapes overlap, so the order decides no pixel; the model keeps it anyway.
- Regions: gate6-scene's per cell, named `c<c>.<region>`, translated by the origin (and by (8, 4)
  at steps 10 and 11, clamped to the viewport only); `BG` is everything else.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import difflib
import filecmp
import importlib.util
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")
FIXTURES = os.path.dirname(HERE)
SCENE = os.path.join(FIXTURES, "gate6-scene")
SYNCED = ["scene_builder.gd", "scene_oracle.gd", "loader.gd", os.path.join("shaders", "phase_tint.gdshader")]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


g6 = _load("gate6_scene_model", os.path.join(SCENE, "make_expected.py"))
g5 = g6.g5
f32 = g6.f32

VIEWPORT = (1920, 1080)
CELLS = 9
COLUMNS = 3
CELL_SIZE = (640, 360)
PHASE_PER_CELL = 7
TEXA_CELL_OFFSET = 100
FOCUS_CELL = CELLS - 1
PRESENTATIONS = {
    "native": {"size": [1920, 1080], "scale": 1.0, "oversampling": 1.0},
    "half": {"size": [960, 540], "scale": 0.5, "oversampling": 0.5},
}
SHIFT = g6.SHIFT


def origin(c):
    return (CELL_SIZE[0] * (c % COLUMNS), CELL_SIZE[1] * (c // COLUMNS))


def phase(c):
    return PHASE_PER_CELL * c


def hud_layer(c, step):
    return -1 - c if step == 9 else 1 + c


# --------------------------------------------------------------------------------------------
# State per cell
# --------------------------------------------------------------------------------------------


def cell_state(frame, c):
    """gate6-scene's state at `frame`, with the continuous values at frame + phase (D6: the
    builder starts each clock at (phi + 1/4)/60 s) and the cell's TEXA content offset."""
    st = g6.state(frame)
    if not st["frozen"]:
        f = frame + phase(c)
        st["pose"] = f
        st["phase"] = (f % 24) // 4
        st["an_x"] = 512.0 + ((f + g6.TIME_OFFSET) % 88)
        st["pb_value"] = g6.pb_value(f)
    if st["texa"] is not None:
        st["texa"] += TEXA_CELL_OFFSET * c
    st["hud_layer"] = hud_layer(c, st["step"])
    return st


def texb(c):
    return g6.TEXB_CONTENT + TEXA_CELL_OFFSET * c


def texa_contents():
    out = set()
    for c in range(CELLS):
        out.update([TEXA_CELL_OFFSET * c, 1 + TEXA_CELL_OFFSET * c, texb(c)])
    return sorted(out)


# --------------------------------------------------------------------------------------------
# One cell's items (gate6-scene's build_scene, then the cell's own textures and focus)
# --------------------------------------------------------------------------------------------


@contextlib.contextmanager
def presentation(scale):
    """StyleBoxFlat at a root stretch `scale`: the lowering widens the feather to aa_size / scale
    canvas units (sbf:497-511); the band stays aa_size / 2 + 1 pixels on screen."""
    original = g6.box_shapes
    if scale == 1.0:
        yield
        return

    def scaled(name, rect, sb):
        widened = dict(sb, aa_size=f32(sb["aa_size"] / scale))
        shapes = original(name, rect, widened)
        for shape in shapes:
            if "band_px" in shape:
                shape["band_px"] = sb["aa_size"] / 2 + 1
        return shapes

    g6.box_shapes = scaled
    try:
        yield
    finally:
        g6.box_shapes = original


def intern(name, ops, op_lists):
    return g6.Scene(op_lists).ops_key(name, ops)


def cell_items(st, c, op_lists, scale):
    """gate6-scene's paint-ordered items of one cell at `st` (cell-local coordinates, names and
    regions unprefixed), with TEXB renamed to the cell's content and, outside the focus cell, the
    LineEdit's focus box and caret removed."""
    with presentation(scale):
        items, _ = g6.build_scene(st, op_lists, "")
    out = []
    for item in items:
        ops = op_lists[item["ops"]]
        new = copy.deepcopy(ops)
        for op in new:
            if op.get("texture") == "TEXB":
                op["texture"] = f"TEXA{texb(c)}"
            elif isinstance(op.get("texture"), str) and op["texture"].startswith("TEXA"):
                pass  # build_scene names TEXA by st["texa"], already offset
        if item["name"] == "LE":
            focused = c == FOCUS_CELL
            new = [op for op in new if focused or not op.get("name", "").startswith("LE.focus")]
            for op in new:
                if op.get("kind") == "undecided" and op["name"] == "LE.content":
                    op["content"] = dict(op["content"], focus=focused)
        if item["name"] == "PB":
            # One model item drawn as two op lists (same transform, same paint order): the
            # background box never changes, so 2 x 135 per-value lists shrink to the fill and
            # text alone (expected.json size; the raster is the same).
            bg = [op for op in new if op.get("name", "").startswith("PB.bg")]
            out.append(dict(item, ops=intern("PB", bg, op_lists)))
            out.append(dict(item, name="PB.bar", ops=intern("PB.bar", [op for op in new if op not in bg], op_lists)))
            continue
        key = item["ops"] if new == ops else intern(item["name"], new, op_lists)
        out.append(dict(item, ops=key))
    return out


def regions_local(step):
    """gate6-scene's regions of one cell, shifted at steps 10 and 11 but not yet clamped."""
    out = {}
    for name, box in g6.REGIONS.items():
        if step >= 10:
            out[name] = list(g6.HU_SHIFTED) if name == "HU" else [box[0] + SHIFT[0], box[1] + SHIFT[1], box[2] + SHIFT[0], box[3] + SHIFT[1]]
        else:
            out[name] = list(box)
    return out


def regions_at(step):
    out = {}
    for c in range(CELLS):
        ox, oy = origin(c)
        for name, b in regions_local(step).items():
            out[f"c{c}.{name}"] = [b[0] + ox, b[1] + oy, min(b[2] + ox, VIEWPORT[0]), min(b[3] + oy, VIEWPORT[1])]
    return out


TOP_LEVEL = ("TL",)
Z100 = ("ZH",)
HUD = ("HUDPanel", "HUDLabel")


def scene_items(frame, op_lists):
    """Every cell's items at `frame`, in the grid's paint order, in logical coordinates; each
    item carries `ops` (native) and, where the half presentation lowers it differently,
    `ops_half`."""
    groups = {"grid": [], "top": [], "z": [], "hud": []}
    for c in range(CELLS):
        st = cell_state(frame, c)
        native = cell_items(st, c, op_lists, 1.0)
        half = cell_items(st, c, op_lists, PRESENTATIONS["half"]["scale"])
        assert [i["name"] for i in native] == [i["name"] for i in half], c
        ox, oy = origin(c)
        hud_items = []
        for a, b in zip(native, half):
            assert a["xform"] == b["xform"] and a["clip_px"] == b["clip_px"], (c, a["name"])
            x = list(a["xform"])
            x[4] += ox
            x[5] += oy
            clip = None if a["clip_px"] is None else [a["clip_px"][0] + ox, a["clip_px"][1] + oy, a["clip_px"][2] + ox, a["clip_px"][3] + oy]
            item = {
                "name": f"c{c}.{a['name']}",
                "region": "BG" if a["region"] == "BG" else f"c{c}.{a['region']}",
                "xform": x,
                "clip_px": clip,
                "ops": a["ops"],
            }
            if b["ops"] != a["ops"]:
                item["ops_half"] = b["ops"]
            if a["name"] in TOP_LEVEL:
                groups["top"].append(item)
            elif a["name"] in Z100:
                groups["z"].append(item)
            elif a["name"] in HUD:
                hud_items.append(item)
            else:
                groups["grid"].append(item)
        groups["hud"].append((st["hud_layer"], hud_items))
    hud = [i for _layer, items in sorted(groups["hud"], key=lambda t: t[0]) for i in items]
    return groups["grid"] + groups["top"] + groups["z"] + hud


def cell_signatures(frame, op_lists):
    """Per cell, gate6-scene's region signatures (native lowering), for freshness."""
    out = []
    for c in range(CELLS):
        items = cell_items(cell_state(frame, c), c, op_lists, 1.0)
        out.append(g6.region_signatures(items, op_lists))
    return out


# --------------------------------------------------------------------------------------------
# Steps, shots, oracle
# --------------------------------------------------------------------------------------------


def cell_oracle(st, c):
    view = g6.oracle_view(st)
    del view["oversampling"]
    view["hud"] = {"layer": st["hud_layer"], "visible": st["hud_visible"]}
    view["le_focus"] = c == FOCUS_CELL
    ox, oy = origin(c)
    view["cell_position"] = [float(ox), float(oy)]
    return view


def build_shots(op_lists):
    shots = []
    for shot in g6.SHOTS:
        shots.append({**shot, "regions": regions_at(shot["step"]), "items": scene_items(shot["frame"], op_lists)})
    return shots


def build_steps(op_lists):
    steps = []
    prev = None
    for k in range(g6.LAST_STEP + 1):
        frame = g6.settle(k)
        sigs = cell_signatures(frame, op_lists)
        fresh = {}
        for c in range(CELLS):
            for region in g6.REGIONS:
                fresh[f"c{c}.{region}"] = True if prev is None else sigs[c].get(region) != prev[c].get(region)
        prev = sigs
        st0 = g6.state(frame)
        steps.append({
            "step": k,
            "applied_frame": g6.applied(k),
            "settle_frame": frame,
            "marker_rgba8": g6.MARKER[k],
            "canvas_transform": [1, 0, 0, 1, st0["canvas"][0], st0["canvas"][1]],
            "fresh": fresh,
            "cells": [cell_oracle(cell_state(frame, c), c) for c in range(CELLS)],
        })
    return steps


def creation_order():
    out = ["Grid"]
    for c in range(CELLS):
        out.append(f"c{c}.Cell")
        out += [f"c{c}.{n}" for n in g6.creation_order("")]
    return out


def created_later():
    return [{"name": f"c{c}.{x['name']}", "step": x["step"]} for c in range(CELLS) for x in g6.CREATED_LATER]


def freed():
    return [{"name": f"c{c}.{x['name']}", "step": x["step"]} for c in range(CELLS) for x in g6.FREED]


# --------------------------------------------------------------------------------------------
# Checks (asserts; the gate's TypeScript re-derives what it can independently)
# --------------------------------------------------------------------------------------------


def check(shots, steps, op_lists):
    # Each cell on its own is gate6-scene's scene at a phase: gate6-scene's own asserts (regions,
    # shapes inside their regions, the colour rule, the bottom strip, hand freshness) hold per
    # cell, in cell-local coordinates (the native lowering; the focus box only in cell 8).
    for c in range(CELLS):
        local_shots = []
        for shot in g6.SHOTS:
            st = cell_state(shot["frame"], c)
            items = cell_items(st, c, op_lists, 1.0)
            local_shots.append({**shot, "regions": g6.regions_at(shot["step"]), "items": items})
        local_steps = [{"fresh": {r: steps[k]["fresh"][f"c{c}.{r}"] for r in g6.REGIONS}} for k in range(g6.LAST_STEP + 1)]
        g6.check("", local_shots, local_steps, op_lists)
    # The cells tile the viewport; every region of every cell lies inside it, pairwise disjoint.
    for step in range(g6.LAST_STEP + 1):
        regs = regions_at(step)
        boxes = sorted(regs.items(), key=lambda kv: kv[1][0])
        for i, (a, ra) in enumerate(boxes):
            assert 0 <= ra[0] < ra[2] <= VIEWPORT[0] and 0 <= ra[1] < ra[3] <= VIEWPORT[1], (step, a, ra)
            for b, rb in boxes[i + 1 :]:
                if rb[0] >= ra[2]:
                    break
                assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (step, a, b)
    # Q6e: every cell origin, and every region edge at native, lands on an even logical
    # coordinate, so `half` maps it to an integer pixel.
    for c in range(CELLS):
        assert all(v % 2 == 0 for v in origin(c)), c
    for name, box in regions_at(0).items():
        assert all(v % 2 == 0 for v in box), (name, box)
    # Every HUD layer key is distinct at every step (no stacking tie, Q1e).
    for step in range(g6.LAST_STEP + 1):
        layers = [hud_layer(c, step) for c in range(CELLS)]
        assert len(set(layers)) == CELLS, step
    # The half lowering differs from the native one only in items that draw an antialiased
    # StyleBoxFlat (its fill shrinks and its feather ring widens with aa_size / scale), shape for
    # shape, with the same names.
    for shot in shots:
        for item in shot["items"]:
            if "ops_half" not in item:
                continue
            a, b = op_lists[item["ops"]], op_lists[item["ops_half"]]
            assert [x.get("name") for x in a] == [y.get("name") for y in b], item["name"]
            assert any("band_px" in x for x in a), item["name"]
    return True


def build():
    op_lists = {}
    shots = build_shots(op_lists)
    steps = build_steps(op_lists)
    check(shots, steps, op_lists)
    used = {k for s in shots for i in s["items"] for k in (i["ops"], i.get("ops_half")) if k}
    op_lists = {k: v for k, v in sorted(op_lists.items()) if k in used}
    contents = texa_contents()
    textures = {"TEXN": g6.TEXTURES["TEXN"]}
    hashes = {"TEXN": g6.TEXTURE_HASHES["TEXN"]}
    for n in contents:
        texels = g6.texa_texels(n)
        textures[f"TEXA{n}"] = g6.texture_entry(texels, 64)
        hashes[f"TEXA{n}"] = g6.grt1_sha256(texels, 64)
    used_textures = {op["texture"] for ops in op_lists.values() for op in ops if isinstance(op.get("texture"), str)}
    assert used_textures <= set(textures), used_textures - set(textures)
    cls = {}
    for c in range(CELLS):
        for name, k in g6.CLASS.items():
            if name != "RF":
                cls[f"c{c}.{name}"] = k
    return {
        "schema": "render-stream-gate6-hd-expected/1",
        "fixture": "gate6-hd",
        "viewport": list(VIEWPORT),
        "presentations": PRESENTATIONS,
        "cells": [
            {"cell": c, "origin": list(origin(c)), "phase": phase(c), "texa_offset": TEXA_CELL_OFFSET * c, "hud_layer": hud_layer(c, 0), "hud_layer_step9": hud_layer(c, 9), "texb": f"TEXA{texb(c)}"}
            for c in range(CELLS)
        ],
        "focus_cell": FOCUS_CELL,
        "clear_rgba8": g6.CLEAR,
        "start_frame_default": g6.S,
        "step_frames_default": g6.N,
        "settle_offset": g6.SETTLE,
        "quit_frame_default": g6.QUIT,
        "last_step": g6.LAST_STEP,
        "mid_frames": [g6.S + g6.N * k + g6.MID_OFFSET for k in g6.MID_STEPS],
        "time_offset_frames": g6.TIME_OFFSET,
        "exact_edge_px": 1 / 16,
        "shift": list(SHIFT),
        "bg_panel": [0, 0, 640, 344],
        "creation_order": creation_order(),
        "created_later": created_later(),
        "freed": freed(),
        "regions": regions_at(0),
        "class": cls,
        "marker_rect": [592, 16, 32, 32],
        "textures": textures,
        "texture_hashes": hashes,
        # As built (G6a): items made in _ready never tie; the HD root's top-level items (Grid and
        # the nine TLs) are all made in _ready too.
        "draw_index_ties": [],
        "hud_panel_px": 168 * 28,
        "op_lists": op_lists,
        "shots": shots,
        "steps": steps,
        # what /6 types (G6b): nothing; the nine HUD layers are supported (distinct keys 1 + c)
        "unsupported": [],
        "synced": [p.replace(os.sep, "/") for p in SYNCED],
    }


def sync_problems():
    out = []
    for rel in SYNCED:
        src, dst = os.path.join(SCENE, rel), os.path.join(HERE, rel)
        if not os.path.exists(dst) or not filecmp.cmp(src, dst, shallow=False):
            out.append(rel)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed file and the synced copies")
    parser.add_argument("--sync", action="store_true", help="copy the files shared with gate6-scene")
    args = parser.parse_args()
    if args.sync:
        for rel in SYNCED:
            os.makedirs(os.path.dirname(os.path.join(HERE, rel)), exist_ok=True)
            shutil.copyfile(os.path.join(SCENE, rel), os.path.join(HERE, rel))
        print(f"synced {', '.join(SYNCED)}")
    text = g5.render(build())
    if args.check:
        status = 0
        stale = sync_problems()
        if stale:
            print(f"make_expected.py: synced copies differ from ../gate6-scene: {', '.join(stale)} (run --sync)", file=sys.stderr)
            status = 1
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        if json.loads(current) != json.loads(text):
            sys.stdout.writelines(difflib.unified_diff(g5.render(json.loads(current)).splitlines(True), text.splitlines(True), "expected.json", "generated"))
            print("make_expected.py: expected.json is stale", file=sys.stderr)
            status = 1
        if status == 0:
            print("expected.json and the synced copies are up to date")
        return status
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
