#!/usr/bin/env python3
"""Write fixtures/gate55-cim/expected.json (render-stream-gate55-expected/1).

Every number below is derived from the fixture's own parameters and the engine's material rules as
read from the source (protocol/gate5_5-design.md Q1), written down as code. Nothing here runs or
reads the engine: the capture's hook counts and the rendered reference have to agree with it, and a
disagreement is a finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate55-cim/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate55-cim/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `cim` is
scene/resources/canvas_item_material.cpp, `gles3c` drivers/gles3/rasterizer_canvas_gles3.cpp,
`canvas.glsl` drivers/gles3/shaders/canvas.glsl, `rcc` servers/rendering/renderer_canvas_cull.cpp,
`ts` drivers/gles3/storage/texture_storage.cpp):

- Calls. Every region item draws filled, axis-aligned, integer rects with `draw_rect`
  (`canvas_item_add_rect`, colours as written). Only the marker redraws after step 0: material,
  light-mode, inheritance, transform and canvas-modulate changes record nothing (Q1a, D9).
- Materials. A `CimSim` replays cim.cpp: the constructor's `material_create` and three
  `material_set_param` (:279-290), the per-key shader cache with its user counts (`shader_create` +
  `shader_set_code` for a new key, `material_set_shader` for a known one, `free` when the last user
  leaves, :55-148), the destructor (:292-307), the LIFO dirty list (core/templates/self_list.h:45,
  `add` pushes to the front) and `CanvasItem.material`'s order (the old Ref goes first, then
  `canvas_item_set_material`, ci.cpp:1169-1177). Its per-step call counts must equal the hand census
  of Q6b typed in below.
- Effective material (rcc:309-313): an item with `use_parent_material` draws its parent's material.
- Fragment colour (canvas.glsl:713-717, :865-866, lighting disabled without lights): `light_only`
  gives alpha 0; `unshaded` keeps the colour; anything else multiplies by the canvas modulate.
- Blend (gles3c:741-799, a non-transparent target: the alpha factors are ZERO, ONE): mix
  `src*a + dst*(1-a)`, add `src*a + dst`, sub `dst - src*a`, mul `src*dst`, premul_alpha
  `src + dst*(1-a)`; disabled writes the fragment, alpha included (:733-739).
- The target. The root viewport is not transparent, so its render target is GL_RGB10_A2 (ts:2144-2149):
  colours on the 0.2 grid survive the 10-bit store and the 8-bit readback exactly, but alpha has 2
  bits, so `disabled`'s alpha .6 reads back as round(.6 * 3) / 3 = 170, not 153 (Q6b's prediction).
- Exactness (D13): opaque mix, add, sub, premul_alpha and disabled on grid colours with a 0/1
  modulate are exact; mul and every alpha .6 blend except disabled allow delta 1.
- Probes. `composite` paints every rect in paint order at one pixel centre with the blends above
  (8-bit destination, round-half-up as UNORM8). Each region is cut into the cells its rect edges
  make, and one probe per cell is stored; scripts/lib/geometry-raster.ts must reproduce every probe.
- Freshness. A region is fresh at a step exactly when one of its cells changes colour.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")

S, N, SETTLE = 1, 10, 7
LAST_STEP = 9
QUIT = S + N * LAST_STEP + SETTLE + 4
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
GRID = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}
# ts:2144-2149: the root viewport's RGB10_A2 render target.
TARGET_ALPHA_BITS = 2

# gate55_cim.gd MARKER_COLORS (gate 3's rect, G55b's own colours: see check_markers).
MARKER_COLOURS = [
    [0, 0, 0.6, 1],
    [1, 1, 0.6, 1],
    [0.6, 1, 1, 1],
    [0.4, 0, 0.4, 1],
    [0.6, 0.4, 0, 1],
    [0.4, 0.8, 0, 1],
    [0.2, 0.2, 0.6, 1],
    [0.8, 0.4, 0.8, 1],
    [0.4, 0.6, 0.8, 1],
    [0.8, 0.6, 0.4, 1],
]

BLEND_REGIONS = [("BM", "mix"), ("BA", "add"), ("BS", "sub"), ("BU", "mul"), ("BP", "premul_alpha"), ("BD", "disabled")]
UNDERLAY = [0.4, 0.6, 0.2, 1]
OVERLAY = [0.4, 0.2, 0.6, 1]
STRIP = [0.4, 0.2, 0.6, 0.6]
LIGHT = [0.6, 0.4, 1, 1]
GREY40 = [0.4, 0.4, 0.4, 1]
GREY20 = [0.2, 0.2, 0.2, 1]
WHITE = [1, 1, 1, 1]
MODULATE = {0: [1, 1, 0, 1], 2: [0, 1, 1, 1], 8: WHITE}

# Q6b's regions, [x0, y0, x1) x [y0, y1).
REGIONS = {}
for _k, (_r, _mode) in enumerate(BLEND_REGIONS):
    REGIONS[_r] = [16 + 88 * _k, 16, 104 + 88 * _k, 96]
for _k, _r in enumerate(["LN", "LM", "LU", "LO"]):
    REGIONS[_r] = [16 + 88 * _k, 112, 104 + 88 * _k, 192]
REGIONS["UP"] = [16, 208, 152, 288]
REGIONS["RC"] = [168, 208, 256, 288]
REGIONS["Marker"] = [584, 8, 632, 56]

# Items: region, parent, position (local to the parent), rects (name, [x, y, w, h], colour).
ITEMS = {}
for _k, (_r, _mode) in enumerate(BLEND_REGIONS):
    _origin = (16 + 88 * _k, 16)
    ITEMS[f"U_{_r}"] = {"region": _r, "parent": None, "pos": _origin, "rects": [("U", [8, 8, 56, 48], UNDERLAY)]}
    ITEMS[f"O_{_r}"] = {"region": _r, "parent": None, "pos": _origin, "rects": [("O", [24, 16, 48, 24], OVERLAY), ("S", [24, 44, 48, 16], STRIP)]}
for _k, _r in enumerate(["LN", "LM", "LU", "LO"]):
    ITEMS[_r] = {"region": _r, "parent": None, "pos": (16 + 88 * _k, 112), "rects": [("L", [16, 16, 56, 48], LIGHT)]}
ITEMS["UB"] = {"region": "UP", "parent": None, "pos": (16, 208), "rects": [("B", [8, 8, 120, 48], GREY40)]}
ITEMS["UP"] = {"region": "UP", "parent": None, "pos": (16, 208), "rects": [("P", [8, 24, 60, 48], GREY20)]}
ITEMS["UC"] = {"region": "UP", "parent": "UP", "pos": (0, 0), "rects": [("C", [68, 24, 60, 48], GREY20)]}
ITEMS["RB"] = {"region": "RC", "parent": None, "pos": (168, 208), "rects": [("B", [8, 8, 56, 48], GREY40)]}
ITEMS["RI"] = {"region": "RC", "parent": None, "pos": (168, 208), "rects": [("I", [24, 24, 56, 40], GREY20)]}
ITEMS["Marker"] = {"region": "Marker", "parent": None, "pos": (592, 16), "rects": [("M", [0, 0, 32, 32], None)]}

# Wire id order (gate55_cim.gd _ready): every CanvasItem in canvas_item_create order; paint order
# is the same (UC is UP's only child). Variant `modulate` adds the CanvasModulate's own (empty)
# canvas item last.
CREATION_ORDER = [n for n in ITEMS]
VARIANTS = {"base": CREATION_ORDER, "modulate": CREATION_ORDER + ["CM"]}

# The materials _ready makes, in construction order (gate55_cim.gd): (blend, light).
MATERIALS0 = {f"O_{r}": (mode, "normal") for r, mode in BLEND_REGIONS}
MATERIALS0.update({"LM": ("mix", "normal"), "LU": ("mix", "unshaded"), "LO": ("mix", "light_only"), "UP": ("add", "normal"), "RI": ("sub", "normal")})

# Q6b's timeline: (node, property, value) in gate55_cim.gd's order; variant-only rows are tagged.
TIMELINE = {
    1: [("O_BD", "blend_mode", "mix")],
    2: [("LO", "light_mode", "normal"), ("CM", "color", [0, 1, 1, 1], "modulate")],
    3: [("LU", "light_mode", "light_only")],
    4: [("RI", "material", None)],
    5: [("RI", "material", {"blend_mode": "add", "light_mode": "normal"})],
    6: [("UC", "use_parent_material", True)],
    7: [("O_BA", "position", [4, 0])],
    8: [("UP", "blend_mode", "sub"), ("CM", "visible", False, "modulate")],
    9: [(None, "canvas_transform", [8, 4])],
}

# The material RenderingServer calls per step, typed in by hand from Q6b's table (never computed);
# CimSim's must equal them. `free:shader` / `free:material` split RenderingServer.free by kind.
HAND_STEP_CENSUS = {
    0: {"material_create": 11, "material_set_param": 33, "shader_create": 8, "shader_set_code": 8, "material_set_shader": 11, "canvas_item_set_material": 11},
    1: {"material_set_shader": 1, "free:shader": 1},
    2: {"material_set_shader": 1, "free:shader": 1},
    3: {"free:shader": 1, "shader_create": 1, "shader_set_code": 1, "material_set_shader": 1},
    4: {"material_set_shader": 1, "free:material": 1, "canvas_item_set_material": 1},
    5: {"material_create": 1, "material_set_param": 3, "canvas_item_set_material": 1, "material_set_shader": 1},
    6: {"canvas_item_set_use_parent_material": 1},
    7: {},
    8: {"material_set_shader": 1},
    9: {},
}
# Variant `modulate` adds the CanvasModulate's calls (scene/2d/canvas_modulate.cpp:43, :108, :53-55).
HAND_MODULATE_CENSUS = {0: {"canvas_set_modulate": 1}, 2: {"canvas_set_modulate": 1}, 8: {"canvas_set_modulate": 1}}

# Ops the release record hooks before calibrator 8 (counts only, gate5_5-design.md Q2) and the
# ones only calibrator 8 hooks (G55a). Engine textures: the hue strip (memory rs-g2a-texture-census-facts).
HOOKED_BEFORE_8 = ["canvas_item_set_material", "material_set_param", "shader_set_code", "shader_create_from_code"]
CALIBRATOR8_OPS = [
    "canvas_item_set_use_parent_material",
    "canvas_set_modulate",
    "material_create",
    "material_create_from_shader",
    "material_set_shader",
    "shader_create",
]
ENGINE_TEXTURES = 1
# What the pre-/5 capture types: an item naming any material is item-level
# {"op":"canvas_item_set_material","reason":"unsupported-state"} (render-stream-2.md); nothing else.
TYPED_OPS = ["canvas_item_set_material"]


# --------------------------------------------------------------------------------------------
# float32 and UNORM8
# --------------------------------------------------------------------------------------------


def f32(x):
    return struct.unpack("<f", struct.pack("<f", float(x)))[0]


def colour(c):
    return [f32(v) for v in c]


def to8(v):
    """UNORM8 as the raster does it: clamp, then round half up (JS Math.round)."""
    return int(math.floor(max(0.0, min(1.0, v)) * 255 + 0.5))


def rgba8(c):
    return [to8(v) for v in c]


# --------------------------------------------------------------------------------------------
# CanvasItemMaterial: the RenderingServer calls (cim.cpp), with ids
# --------------------------------------------------------------------------------------------


class Material:
    def __init__(self, mid, blend, light):
        self.id = mid
        self.blend = blend
        self.light = light
        self.current = None  # cim.cpp:287 current_key.invalid_key


class CimSim:
    """cim.cpp's shader cache and dirty list, emitting (call, args) per RenderingServer call."""

    def __init__(self):
        self.shader_map = {}  # key -> {"id", "users"}
        self.next_shader = 1
        self.next_material = 1
        self.dirty = []  # front first (SelfList::add pushes to the front)
        self.calls = []

    def emit(self, call, **args):
        self.calls.append({"call": call, **args})

    def new(self, blend, light):
        m = Material(self.next_material, "mix", "normal")
        self.next_material += 1
        self.emit("material_create", material=m.id)
        for name, value in (("particles_anim_h_frames", 1), ("particles_anim_v_frames", 1), ("particles_anim_loop", False)):
            self.emit("material_set_param", material=m.id, name=name, value=value)
        self.queue(m)
        self.set_mode(m, blend, light)
        return m

    def queue(self, m):
        if m not in self.dirty:
            self.dirty.insert(0, m)

    def set_mode(self, m, blend, light):
        m.blend, m.light = blend, light
        self.queue(m)

    def flush(self):
        while self.dirty:
            self.update(self.dirty.pop(0))

    def update(self, m):
        key = (m.blend, m.light)
        if key == m.current:
            return
        self.release(m)
        m.current = key
        if key in self.shader_map:
            self.emit("material_set_shader", material=m.id, shader=self.shader_map[key]["id"])
            self.shader_map[key]["users"] += 1
            return
        sid = self.next_shader
        self.next_shader += 1
        self.emit("shader_create", shader=sid)
        self.emit("shader_set_code", shader=sid, builtin={"blend_mode": key[0], "light_mode": key[1], "particles_animation": False})
        self.shader_map[key] = {"id": sid, "users": 1}
        self.emit("material_set_shader", material=m.id, shader=sid)

    def release(self, m):
        if m.current in self.shader_map:
            entry = self.shader_map[m.current]
            entry["users"] -= 1
            if entry["users"] == 0:
                self.emit("free", kind="shader", shader=entry["id"])
                del self.shader_map[m.current]

    def destroy(self, m):
        had = m.current in self.shader_map
        self.release(m)
        if had:
            self.emit("material_set_shader", material=m.id, shader=None)
        self.emit("free", kind="material", material=m.id)
        if m in self.dirty:
            self.dirty.remove(m)


def census_of(calls):
    out = {}
    for c in calls:
        key = f"free:{c['kind']}" if c["call"] == "free" else c["call"]
        out[key] = out.get(key, 0) + 1
    return out


# --------------------------------------------------------------------------------------------
# The scene per step: fixture state, RS calls, materials, items
# --------------------------------------------------------------------------------------------


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def run_fixture(variant):
    """Per step: the fixture state after it and the RenderingServer material calls it made."""
    sim = CimSim()
    state = {"material": {}, "use_parent": {"UC": False}, "offset": {"O_BA": [0, 0]}, "canvas": [0, 0], "modulate": WHITE}
    objects = {}
    steps = []
    for step in range(LAST_STEP + 1):
        start = len(sim.calls)
        fixture_calls = []
        if step == 0:
            # gate55_cim.gd _ready: every material made and assigned, then one idle flush.
            for name, (blend, light) in MATERIALS0.items():
                objects[name] = sim.new(blend, light)
                sim.emit("canvas_item_set_material", item=name, material=objects[name].id)
                fixture_calls.append({"node": name, "property": "material", "value": {"blend_mode": blend, "light_mode": light}})
            if variant == "modulate":
                state["modulate"] = MODULATE[0]
                sim.emit("canvas_set_modulate", color=MODULATE[0])
                fixture_calls.append({"node": "CM", "property": "color", "value": MODULATE[0]})
        for row in TIMELINE.get(step, []):
            node, prop, value = row[:3]
            if len(row) > 3 and row[3] != variant:
                continue
            fixture_calls.append({"node": node, "property": prop, "value": value})
            if prop == "blend_mode":
                sim.set_mode(objects[node], value, objects[node].light)
            elif prop == "light_mode":
                sim.set_mode(objects[node], objects[node].blend, value)
            elif prop == "material" and value is None:
                sim.destroy(objects.pop(node))
                sim.emit("canvas_item_set_material", item=node, material=None)
            elif prop == "material":
                objects[node] = sim.new(value["blend_mode"], value["light_mode"])
                sim.emit("canvas_item_set_material", item=node, material=objects[node].id)
            elif prop == "use_parent_material":
                state["use_parent"][node] = value
                sim.emit("canvas_item_set_use_parent_material", item=node, value=value)
            elif prop == "position":
                state["offset"][node] = value
            elif prop == "canvas_transform":
                state["canvas"] = value
            elif prop == "color":
                state["modulate"] = value
                sim.emit("canvas_set_modulate", color=value)
            elif prop == "visible":
                state["modulate"] = WHITE
                sim.emit("canvas_set_modulate", color=WHITE)
            else:
                raise AssertionError(prop)
        sim.flush()
        state["material"] = {name: (m.blend, m.light) for name, m in objects.items()}
        steps.append({"state": copy.deepcopy(state), "calls": sim.calls[start:], "fixture_calls": fixture_calls})
    return steps


def effective_mode(name, materials, use_parent):
    """rcc:309-313: use_parent_material takes the parent's material (its own otherwise)."""
    if use_parent.get(name):
        return effective_mode(ITEMS[name]["parent"], materials, {})
    return materials.get(name)


def shade(col, light, modulate):
    """canvas.glsl:713-717, :865-866 with lighting disabled."""
    c = colour(col)
    if light == "light_only":
        return [c[0], c[1], c[2], 0.0]
    if light == "unshaded":
        return c
    return [f32(v * m) for v, m in zip(c, colour(modulate))]


def scene_items(view, step, op_lists, keys):
    """Every item in paint order for one rendered state `view` = (materials, use_parent, offset,
    canvas, modulate, marker step); shapes carry their fragment colour and blend."""
    materials, use_parent, offset, canvas, modulate, marker_step = view
    items = []
    for name in CREATION_ORDER:
        d = ITEMS[name]
        mode = effective_mode(name, materials, use_parent)
        blend, light = mode if mode else ("mix", "normal")
        shapes = []
        for sname, rect, col in d["rects"]:
            c = shade(MARKER_COLOURS[marker_step] if name == "Marker" else col, light, modulate)
            x, y, w, h = rect
            shape = {"name": sname, "kind": "mesh", "vertices": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], "triangles": [[0, 1, 2], [0, 2, 3]], "colors": [c]}
            if blend != "mix":
                shape["blend"] = blend
            shapes.append(shape)
        content = json.dumps(shapes, sort_keys=True)
        if content not in keys:
            key = f"{name}@{step}"
            while key in op_lists:
                key += "'"
            keys[content] = key
            op_lists[key] = shapes
        px, py = d["pos"]
        if d["parent"]:
            px, py = px + ITEMS[d["parent"]]["pos"][0], py + ITEMS[d["parent"]]["pos"][1]
        dx, dy = offset.get(name, [0, 0])
        items.append({"name": name, "region": d["region"], "xform": [1, 0, 0, 1, px + dx + canvas[0], py + dy + canvas[1]], "clip_px": None, "ops": keys[content]})
    return items


# --------------------------------------------------------------------------------------------
# The compositor (one pixel centre) and the region cells
# --------------------------------------------------------------------------------------------


def blend_pixel(shape, dst, delta):
    c = shape["colors"][0]
    a = c[3]
    d = [v / 255 for v in dst]
    mode = shape.get("blend", "mix")
    if mode == "mix":
        if a <= 0:
            return dst, delta
        if a >= 1:
            return rgba8(c[:3]) + [255], 0
        return [to8(c[k] * a + d[k] * (1 - a)) for k in range(3)] + [to8(a + d[3] * (1 - a))], max(delta, 1)
    if mode == "disabled":
        levels = (1 << TARGET_ALPHA_BITS) - 1
        return rgba8(c[:3]) + [to8(math.floor(a * levels + 0.5) / levels)], 0
    if mode == "add":
        rgb = [c[k] * a + d[k] for k in range(3)]
    elif mode == "sub":
        rgb = [d[k] - c[k] * a for k in range(3)]
    elif mode == "mul":
        rgb = [c[k] * d[k] for k in range(3)]
    elif mode == "premul_alpha":
        rgb = [c[k] + d[k] * (1 - a) for k in range(3)]
    else:
        raise AssertionError(mode)
    tol = 1 if mode == "mul" or a < 1 else 0
    return [to8(v) for v in rgb] + [dst[3]], max(delta, tol)


def shape_box(item, shape):
    ox, oy = item["xform"][4], item["xform"][5]
    (x0, y0), (x1, y1) = shape["vertices"][0], shape["vertices"][2]
    return [x0 + ox, y0 + oy, x1 + ox, y1 + oy]


def composite(items, op_lists, x, y):
    px, py = x + 0.5, y + 0.5
    rgba, delta = list(CLEAR), 0
    for item in items:
        for shape in op_lists[item["ops"]]:
            b = shape_box(item, shape)
            if b[0] <= px < b[2] and b[1] <= py < b[3]:
                rgba, delta = blend_pixel(shape, rgba, delta)
    return rgba, delta


def region_cells(region, item_sets, op_lists):
    """The probe pixel of every cell the rect edges of `item_sets` cut `region` into."""
    r = REGIONS[region]
    xs, ys = {r[0], r[2]}, {r[1], r[3]}
    for items in item_sets:
        for item in items:
            for shape in op_lists[item["ops"]]:
                b = shape_box(item, shape)
                xs.update(v for v in (b[0], b[2]) if r[0] < v < r[2])
                ys.update(v for v in (b[1], b[3]) if r[1] < v < r[3])
    xs, ys = sorted(xs), sorted(ys)
    return [(xa + (xb - xa) // 2, ya + (yb - ya) // 2) for ya, yb in zip(ys, ys[1:]) for xa, xb in zip(xs, xs[1:])]


def region_differs(region, a, b, op_lists):
    return any(composite(a, op_lists, x, y)[0] != composite(b, op_lists, x, y)[0] for x, y in region_cells(region, [a, b], op_lists))


def probes_of(items, op_lists, regions=REGIONS):
    out = []
    for region in regions:
        for x, y in region_cells(region, [items], op_lists):
            rgba, delta = composite(items, op_lists, x, y)
            out.append([x, y, *rgba, delta])
    return out


# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------


def true_view(s, step):
    st = s["state"]
    return (st["material"], st["use_parent"], st["offset"], st["canvas"], st["modulate"], step)


def build_variant(variant, op_lists, keys):
    run = run_fixture(variant)
    steps = []
    for step, s in enumerate(run):
        items = scene_items(true_view(s, step), step, op_lists, keys)
        rect_calls = {}
        redraws = list(CREATION_ORDER) if step == 0 else ["Marker"]
        for name in redraws:
            for _sname, rect, col in ITEMS[name]["rects"]:
                c = MARKER_COLOURS[step] if name == "Marker" else col
                rect_calls.setdefault(ITEMS[name]["region"], []).append({"item": name, "op": "canvas_item_add_rect", "rect": [f32(v) for v in rect], "color": colour(c), "antialiased": False})
        st = s["state"]
        steps.append(
            {
                "step": step,
                "applied_frame": frame_of(step),
                "settle_frame": frame_of(step, True),
                "marker_rgba8": rgba8(MARKER_COLOURS[step]),
                "marker_shown_rgba8": rgba8(shade(MARKER_COLOURS[step], "normal", st["modulate"])),
                "canvas_transform": [1, 0, 0, 1, st["canvas"][0], st["canvas"][1]],
                "canvas_modulate": colour(st["modulate"]),
                "redraws": redraws,
                "calls": rect_calls,
                "items": items,
                "material_calls": s["fixture_calls"],
                "rs_material_calls": s["calls"],
                "census": dict(sorted(census_of(s["calls"]).items())),
                "builtin": {name: {"blend_mode": b, "light_mode": l, "particles_animation": False} for name, (b, l) in sorted(st["material"].items())},
                "effective": {name: list(effective_mode(name, st["material"], st["use_parent"])) for name in CREATION_ORDER if effective_mode(name, st["material"], st["use_parent"])},
                "typed_entries": sorted(st["material"]),
            }
        )
    for k, s in enumerate(steps):
        s["fresh"] = {r: True for r in REGIONS} if k == 0 else {r: region_differs(r, s["items"], steps[k - 1]["items"], op_lists) for r in REGIONS}
        # One probe per cell of every region that is fresh at this step (a region that is not
        # fresh keeps its pixels, which the raster's own freshness check holds it to).
        s["probes"] = probes_of(s["items"], op_lists, [r for r in REGIONS if s["fresh"][r]])
    return run, steps


# --------------------------------------------------------------------------------------------
# Self-consistency
# --------------------------------------------------------------------------------------------


def on_grid(v):
    return any(abs(v - g) < 1e-6 for g in GRID)


def check_markers(variants):
    raw = [tuple(rgba8(c)) for c in MARKER_COLOURS]
    assert len(set(raw)) == len(raw), "marker colours are not distinct"
    scene_colours = {tuple(rgba8(r[2])) for d in ITEMS.values() for r in d["rects"] if r[2] is not None}
    assert not set(raw) & scene_colours, "a marker colour is also a scene rect colour (step alignment needs it unique)"
    for name, steps in variants.items():
        shown = [tuple(s["marker_shown_rgba8"]) for s in steps]
        assert len(set(shown)) == len(shown), f"{name}: markers not distinct as shown {shown}"
    # Variant `modulate` changes the marker at every step whose modulate is not white (0..7).
    mod = variants["modulate"]
    for s in mod:
        changed = s["marker_shown_rgba8"] != s["marker_rgba8"]
        assert changed == (s["step"] <= 7), (s["step"], s["marker_rgba8"], s["marker_shown_rgba8"])


def check(variants, op_lists, runs):
    for c in MARKER_COLOURS + [UNDERLAY, OVERLAY, STRIP, LIGHT, GREY40, GREY20] + list(MODULATE.values()):
        assert all(on_grid(v) for v in c[:3]), c
        assert c[3] in (1, 0.6), c
    for m in MODULATE.values():
        assert all(v in (0, 1) for v in m), "D13: a modulate component must be 0 or 1"
    names = list(REGIONS)
    for i, a in enumerate(names):
        ra = REGIONS[a]
        assert 0 <= ra[0] < ra[2] <= VIEWPORT[0] and 0 <= ra[1] < ra[3] <= VIEWPORT[1], a
        for b in names[i + 1 :]:
            rb = REGIONS[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
    for name, steps in variants.items():
        for s in steps:
            for item in s["items"]:
                region = REGIONS[item["region"]]
                for shape in op_lists[item["ops"]]:
                    b = shape_box(item, shape)
                    assert region[0] <= b[0] and b[2] <= region[2] and region[1] <= b[1] and b[3] <= region[3], (name, s["step"], item["name"], b, region)
            # The hand census, per step.
            want = dict(HAND_STEP_CENSUS[s["step"]])
            if name == "modulate":
                want.update(HAND_MODULATE_CENSUS.get(s["step"], {}))
            assert s["census"] == dict(sorted(want.items())), f"{name} step {s['step']}: census {s['census']} != hand {want}"
    # Q6b's shader-sharing facts: eight keys at step 0, the add shader shared by BA and UP (and RI
    # from step 5), the sub shader by BS and RI; step 3 makes a new light_only shader id.
    calls0 = variants["base"][0]["rs_material_calls"]
    sets = {c["material"]: c["shader"] for c in calls0 if c["call"] == "material_set_shader"}
    mid = {c["item"]: c["material"] for c in calls0 if c["call"] == "canvas_item_set_material"}
    assert sets[mid["O_BA"]] == sets[mid["UP"]] and sets[mid["O_BS"]] == sets[mid["RI"]] and sets[mid["O_BM"]] == sets[mid["LM"]]
    assert len(set(sets.values())) == 8
    s3 = [c for c in variants["base"][3]["rs_material_calls"] if c["call"] == "shader_create"]
    assert s3 == [{"call": "shader_create", "shader": 9}], s3
    s5 = variants["base"][5]["rs_material_calls"]
    assert [c["call"] for c in s5] == ["material_create", "material_set_param", "material_set_param", "material_set_param", "canvas_item_set_material", "material_set_shader"], s5
    assert s5[0]["material"] == 12
    s4 = variants["base"][4]["rs_material_calls"]
    assert [c["call"] for c in s4] == ["material_set_shader", "free", "canvas_item_set_material"], s4
    # Q6b's freshness: no region redraws after step 0, yet these change. LU is light_only, so
    # invisible, from step 3 on: the canvas shift at 9 does not move anything in it.
    fresh_hand = {
        "base": {1: {"BD"}, 2: {"LO"}, 3: {"LU"}, 4: {"RC"}, 5: {"RC"}, 6: {"UP"}, 7: {"BA"}, 8: {"UP"}, 9: set(REGIONS) - {"LU"}},
        # modulate: steps 2 and 8 change the canvas modulate, which repaints every region but LU
        # (unshaded at 2, light_only by 8); LO turns visible at 2 under it.
        "modulate": {
            1: {"BD"},
            2: set(REGIONS) - {"LU"},
            3: {"LU"},
            4: {"RC"},
            5: {"RC"},
            6: {"UP"},
            7: {"BA"},
            8: set(REGIONS) - {"LU"},
            9: set(REGIONS) - {"LU"},
        },
    }
    for name, steps in variants.items():
        for k, want in fresh_hand[name].items():
            got = {r for r, f in steps[k]["fresh"].items() if f}
            assert got == want | {"Marker"}, f"{name} step {k}: fresh {sorted(got)} != hand {sorted(want | {'Marker'})}"
        for s in steps[1:]:
            assert s["redraws"] == ["Marker"]
    # The light modes are pixel-proven (Q1d): LO shows only the background until step 2; LU equals
    # LN in base (white modulate) and differs from it under a non-white modulate until step 3.
    for name, steps in variants.items():
        for s in steps:
            lo = probes_of(s["items"], op_lists, ["LO"])
            shows_only_clear = all(p[2:6] == CLEAR for p in lo)
            assert shows_only_clear == (s["step"] < 2), (name, s["step"])
    bd = REGIONS["BD"]
    alphas = {p[5] for p in variants["base"][0]["probes"] if bd[0] <= p[0] < bd[2] and bd[1] <= p[1] < bd[3]}
    assert alphas == {170, 255}, f"BD at step 0: alphas {alphas}, expected the disabled strip at 170 (RGB10_A2) and 255"


# --------------------------------------------------------------------------------------------
# Sabotage predictions (G55d): a receiver state per step, compared region by region
# --------------------------------------------------------------------------------------------


def wire_modes(run, omit_op=None, omit_from=None):
    """Replays the RS material calls as the mirror would (D5: freeing a shader nulls every material
    naming it), optionally omitting one op from a frame on; returns per step the effective
    (blend, light) per item, None for no material or a material without a shader."""
    shaders, materials, item_mat = {}, {}, {}
    out = []
    for step, s in enumerate(run):
        frame = frame_of(step)
        for c in s["calls"]:
            if omit_op and c["call"] == omit_op and frame >= omit_from:
                continue
            call = c["call"]
            if call == "shader_create":
                shaders[c["shader"]] = None
            elif call == "shader_set_code":
                shaders[c["shader"]] = (c["builtin"]["blend_mode"], c["builtin"]["light_mode"])
            elif call == "material_create":
                materials[c["material"]] = None
            elif call == "material_set_shader":
                materials[c["material"]] = c["shader"]
            elif call == "free" and c["kind"] == "shader":
                shaders.pop(c["shader"], None)
                for m, sid in materials.items():
                    if sid == c["shader"]:
                        materials[m] = None
            elif call == "free" and c["kind"] == "material":
                materials.pop(c["material"], None)
                for i, m in list(item_mat.items()):
                    if m == c["material"]:
                        item_mat[i] = None
            elif call == "canvas_item_set_material":
                item_mat[c["item"]] = c["material"]
        modes = {}
        for item, mid in item_mat.items():
            sid = materials.get(mid) if mid is not None else None
            # A material without a (valid) shader draws as the default canvas material: mix, normal.
            modes[item] = shaders.get(sid) or ("mix", "normal") if mid is not None else None
        out.append({i: m for i, m in modes.items() if m is not None})
    return out


def predictions(variants, runs, op_lists, keys):
    def mismatches(variant, view_of):
        regions = {}
        run = runs[variant]
        for step, s in enumerate(run):
            true_items = variants[variant][step]["items"]
            other = scene_items(view_of(step, s), step, op_lists, keys)
            for r in REGIONS:
                if region_differs(r, true_items, other, op_lists):
                    regions.setdefault(r, []).append(step)
        return regions

    base = runs["base"]
    freeze = mismatches("base", lambda step, s: true_view(base[0], 0))
    omit = wire_modes(base, "material_set_shader", S + N * 2)
    omit_regions = mismatches("base", lambda step, s: (omit[step], s["state"]["use_parent"], s["state"]["offset"], s["state"]["canvas"], s["state"]["modulate"], step))
    ignore = mismatches("base", lambda step, s: ({}, s["state"]["use_parent"], s["state"]["offset"], s["state"]["canvas"], s["state"]["modulate"], step))
    mod = runs["modulate"]
    ignore_mod = mismatches("modulate", lambda step, s: (s["state"]["material"], s["state"]["use_parent"], s["state"]["offset"], s["state"]["canvas"], WHITE, step))
    # Q6b's sets, where the model agrees with the contract (see "As built (G55b)" for the rest).
    r = lambda a, b: list(range(a, b + 1))  # noqa: E731
    assert {k: freeze[k] for k in ("BD", "LO", "LU", "RC", "UP", "BA", "Marker")} == {"BD": r(1, 9), "LO": r(2, 9), "LU": r(3, 9), "RC": r(4, 9), "UP": r(6, 9), "BA": r(7, 9), "Marker": r(1, 9)}, freeze
    assert all(freeze[g] == [9] for g in REGIONS if g not in ("BD", "LO", "LU", "RC", "UP", "BA", "Marker")), freeze
    # omit-op material_set_shader from 21: LO does NOT mismatch (the light_only shader is freed in
    # the same flush, so the wire material loses its shader and draws normal, as the engine does).
    assert omit_regions == {"LU": r(3, 9), "RC": r(5, 9), "UP": [8, 9]}, omit_regions
    assert "BM" not in ignore and "LM" not in ignore, ignore
    assert ignore == {"BA": r(0, 9), "BS": r(0, 9), "BU": r(0, 9), "BP": r(0, 9), "BD": [0], "LO": [0, 1], "LU": r(3, 9), "UP": r(0, 9), "RC": [0, 1, 2, 3, 5, 6, 7, 8, 9]}, ignore
    want_mod = {g: r(0, 7) for g in REGIONS if g not in ("LU", "LO")}
    want_mod["LO"] = r(2, 7)
    assert ignore_mod == want_mod, ignore_mod
    return {
        "sabotage-freeze": {"frame": S + N, "regions": freeze},
        "sabotage-omit-material-set-shader": {"frame": S + N * 2, "op": "material_set_shader", "regions": omit_regions},
        "sabotage-receiver-ignore-material": {"regions": ignore},
        "sabotage-receiver-ignore-canvas-modulate": {"variant": "modulate", "regions": ignore_mod},
    }


def build():
    op_lists, keys = {}, {}
    variants, runs = {}, {}
    for name in VARIANTS:
        runs[name], variants[name] = build_variant(name, op_lists, keys)
    check_markers(variants)
    check(variants, op_lists, runs)
    preds = predictions(variants, runs, op_lists, keys)
    hook = {}
    for name, steps in variants.items():
        total = {}
        for s in steps:
            for op, n in s["census"].items():
                total[op] = total.get(op, 0) + n
        rects = sum(len(c) for s in steps for c in s["calls"].values())
        hook[name] = dict(sorted({**total, "canvas_item_add_rect": rects, "texture_2d_create": ENGINE_TEXTURES}.items()))
    return {
        "schema": "render-stream-gate55-expected/1",
        "fixture": "gate55-cim",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "target_alpha_bits": TARGET_ALPHA_BITS,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "regions": REGIONS,
        "marker_rect": [592, 16, 32, 32],
        "exact_edge_px": 1 / 16,
        "hooked_before_calibrator8": HOOKED_BEFORE_8,
        "calibrator8_ops": CALIBRATOR8_OPS,
        "typed_ops": TYPED_OPS,
        "hook_census": hook,
        "op_lists": op_lists,
        "variants": {name: {"creation_order": VARIANTS[name], "steps": steps} for name, steps in variants.items()},
        "predictions": preds,
    }


def render(data):
    """Indented JSON with each item's small tables on one line."""

    def emit(value, indent):
        pad = "  " * indent
        if isinstance(value, dict) and indent < 5:
            items = [f"{pad}  {json.dumps(k)}: {emit(v, indent + 1)}" for k, v in value.items()]
            return "{\n" + ",\n".join(items) + "\n" + pad + "}" if items else "{}"
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value) and indent < 5:
            items = [f"{pad}  {emit(v, indent + 1)}" for v in value]
            return "[\n" + ",\n".join(items) + "\n" + pad + "]"
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)

    return emit(data, 0) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed file")
    args = parser.parse_args()
    text = render(build())
    if args.check:
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        # Prettier may reflow the committed JSON; compare values, not bytes.
        if json.loads(current) != json.loads(text):
            sys.stdout.writelines(difflib.unified_diff(render(json.loads(current)).splitlines(True), text.splitlines(True), "expected.json", "generated"))
            print("make_expected.py: expected.json is stale", file=sys.stderr)
            return 1
        print("expected.json is up to date")
        return 0
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
