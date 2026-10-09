#!/usr/bin/env python3
"""Write fixtures/gate3/expected.json (render-stream-gate3-expected/1).

The derivation of every number below models the engine's clip semantics as read from the
source (protocol/gate3-design.md Q1), written down as code over the fixture's own parameters.
Nothing here runs or reads the engine: the reference run has to agree with it
(`expected-image-reference`, `probes-reference`, `clip-call-census`), and a disagreement is a
finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate3/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate3/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable):

- RS calls. Every redraw of a CanvasItem is canvas_item_clear first (scene/main/canvas_item.cpp:140);
  a Control's NOTIFICATION_DRAW then sends canvas_item_set_custom_rect(true, Rect2(0, size)) and
  canvas_item_set_clip(clip_contents) (scene/gui/control.cpp:3898-3902) before the subclass draws
  (ColorRect: one draw_rect of Rect2(0, size)). A position change never redraws a Control
  (control.cpp:1779-1793); a size or clip_contents change does (:2868-2875, canvas_item.cpp:638-642).
  The fixture's raw RenderingServer calls are as scripted. The server-side setters only store
  (servers/rendering/renderer_canvas_cull.cpp:660-665, :674-680); clear resets clip, never the
  custom rect (servers/rendering/renderer_canvas_render.h:455). This is also the mirror's model
  (capture/src/rs_mirror.cpp, gate3-design.md D3), which the sabotage predictions reuse.
- Cull (renderer_canvas_cull.cpp:296-418): an item's rect is its custom rect, else the union of
  its command rects (servers/rendering/renderer_canvas_render.cpp:36-132); final_xform = parent *
  self from the canvas transform down; global_rect is the axis-aligned bounding box of the rect
  through it (core/math/transform_2d.h:223-234). A clipping item's scissor is (the nearest
  clipping ancestor's already rounded scissor, else the viewport rect) intersected with
  global_rect (core/math/rect2.h:147-162); below 0.5 px on either side the item and its whole
  subtree are skipped; otherwise position and size are rounded separately, half away from zero.
  A non-clipping item inherits its parent's owner. An item is drawn only when it has commands
  and its global_rect touches the viewport rect, borders included (:249) -- the custom rect is
  the visibility rect.
- Paint order: z lists ascending; inside one, the cull's pre-order (children by draw index, the
  canvas's items by draw index). Top-level scene items take their tree index; RC is 1000.
- Probes (gate3-design.md Q6c): for every non-null scissor, the quarter, half and three-quarter
  points of each edge give an inside/outside pixel pair, named after the innermost owner whose
  edge bounds the same pair; a pair is decisive when the outside pixel differs from the scene
  painted with every clip off.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")

S, N, SETTLE = 1, 10, 7
LAST_STEP = 9
QUIT = S + N * LAST_STEP + SETTLE + 4
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]

# Gate 1's first ten marker colours (fixtures/gate1/gate1.gd MARKER_COLORS).
MARKER = [
    [0, 0, 0, 255],
    [255, 255, 0, 255],
    [0, 255, 255, 255],
    [102, 0, 102, 255],
    [0, 102, 0, 255],
    [102, 0, 0, 255],
    [0, 0, 102, 255],
    [204, 102, 204, 255],
    [102, 153, 204, 255],
    [204, 153, 102, 255],
]

REGIONS = {
    "nested": [72, 64, 256, 200],
    "redraw": [328, 64, 112, 96],
    "raw": [440, 64, 120, 96],
    "cull": [0, 256, 64, 48],
    "anchored": [80, 312, 560, 44],
    "marker": [584, 8, 48, 48],
}
EMPTY_REGION = [0, 0, 72, 72]

# Every CanvasItem in canvas_item_create order (wire ids 1, 2, ...): the scene nodes in _ready's
# construction order, then the two raw items.
CREATION_ORDER = ["A", "AF", "S1", "B", "BF", "N", "NF", "C", "CF", "BZ", "D", "DF", "CU", "AN", "ANF", "Marker", "RC", "RCF"]
# Items whose clip flag is ever set true: the clip owners the probes and clip_rects cover.
OWNERS = ["A", "B", "C", "D", "RC", "AN"]
CONTROLS = ["A", "AF", "S1", "B", "BF", "N", "NF", "C", "CF", "BZ", "D", "DF", "CU", "AN", "ANF"]

# The hand-derived table of gate3-design.md Q6b ("Final scissors per step"), typed in from the
# contract, never computed: expected-self-consistent checks the derivation against it.
_A0 = [96, 88, 256, 208]
_D0 = [344, 88, 408, 136]
_RC0 = [464, 88, 528, 136]
_AN0 = [88, 320, 616, 344]
HAND_CLIP_RECTS = {
    0: {"A": _A0, "B": [196, 148, 256, 208], "C": [236, 188, 256, 208], "D": _D0, "RC": _RC0, "AN": _AN0},
    1: {"A": _A0, "B": [196, 148, 256, 208], "C": [236, 188, 256, 208], "D": _D0, "RC": _RC0, "AN": _AN0},
    2: {"A": _A0, "B": [176, 138, 256, 208], "C": [216, 178, 256, 208], "D": _D0, "RC": _RC0, "AN": _AN0},
    3: {"A": _A0, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": _RC0, "AN": _AN0},
    4: {"A": None, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": _RC0, "AN": _AN0},
    5: {"A": _A0, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": _RC0, "AN": _AN0},
    6: {"A": _A0, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": None, "AN": _AN0},
    7: {"A": _A0, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": [472, 96, 488, 112], "AN": _AN0},
    8: {"A": _A0, "B": [176, 138, 236, 188], "C": [216, 178, 236, 188], "D": _D0, "RC": "skipped", "AN": _AN0},
    9: {
        "A": [104, 92, 264, 212],
        "B": [184, 142, 244, 192],
        "C": [224, 182, 244, 192],
        "D": [352, 92, 416, 140],
        "RC": "skipped",
        "AN": [96, 324, 624, 348],
    },
}

NON_DECISIVE_EDGES = [{"owner": "D", "edge": "left", "reason": "DF starts inside D; nothing reaches past D's left edge"}]


def rgba8(r, g, b):
    return [round(r * 255), round(g * 255), round(b * 255), 255]


# --------------------------------------------------------------------------------------------
# The fixture: scene nodes and raw items, and the RS calls each step makes
# --------------------------------------------------------------------------------------------


def initial_scene():
    """Scene-side parameters at step 0 (gate3-design.md Q6b's node table)."""

    def ctl(parent, pos, size, clip=False, color=None, z=0, index=0, draw=None):
        return {
            "kind": "control",
            "parent": parent,
            "index": index,
            "pos": None if pos is None else list(pos),
            "size": None if size is None else list(size),
            "clip": clip,
            "color": color,
            "z": z,
            "draw": draw,
        }

    nodes = {
        "A": ctl(None, (96, 88), (160, 120), clip=True, index=0),
        "AF": ctl("A", (-16, -16), (192, 152), color=rgba8(1, 0.6, 0), index=0),
        "S1": ctl("A", (20, 8), (24, 24), color=rgba8(1, 1, 1), index=1),
        "B": ctl("A", (100, 60), (100, 80), clip=True, index=2),
        "BF": ctl("B", (-20, -20), (140, 120), color=rgba8(0, 0.6, 1), index=0),
        "N": ctl("B", (-60, 30), (10, 10), index=1),
        "NF": ctl("N", (0, 0), (200, 16), color=rgba8(0.6, 1, 0.2), index=0),
        "C": ctl("B", (40, 40), (40, 40), clip=True, index=2),
        "CF": ctl("C", (-8, -8), (56, 56), color=rgba8(1, 0.2, 0.6), index=0),
        "BZ": ctl("B", (40, -10), (40, 30), color=rgba8(0.2, 1, 0.8), z=1, index=3),
        "D": ctl(None, (344, 88), (64, 48), clip=True, color=rgba8(0.2, 0.6, 0.2), index=1),
        "DF": ctl("D", (32, -12), (48, 72), color=rgba8(0.8, 0.8, 0.2), index=0),
        # CullProbe: _draw() -> draw_rect(Rect2(56, 0, 32, 32), colour); custom rect Rect2(0, size).
        "CU": ctl(None, (-48, 264), (40, 40), index=2, draw=([56, 0, 32, 32], rgba8(0.6, 0.4, 1))),
        # anchors (0, 1, 1, 1), offsets (88, -40, -24, -16): laid out from the root size.
        "AN": ctl(None, None, None, clip=True, index=3),
        "ANF": ctl("AN", (-8, -4), (544, 32), color=rgba8(0.8, 0.4, 0.6), index=0),
        "Marker": {"kind": "node2d", "parent": None, "index": 4, "pos": [592, 16], "z": 0},
    }
    return nodes


def anchored_layout(root):
    """AN's position and size for a root of `root` px (control.cpp:1727-1750): anchors
    (0, 1, 1, 1) and offsets (88, -40, -24, -16); a negative extent clamps to the minimum size, 0,
    growing from the begin edge (GROW_DIRECTION_END)."""
    w, h = root
    left, top, right, bottom = 0 * w + 88, 1 * h - 40, 1 * w - 24, 1 * h - 16
    return [left, top], [max(0, right - left), max(0, bottom - top)]


# Raw item parameters (gate3.gd): RC at draw index 1000 on the root canvas, RCF its only child.
RC_ORIGIN = (464, 88)
RC_CUSTOM = [0, 0, 64, 48]
RC_RECT = ([8, 8, 16, 16], rgba8(1, 1, 0.2))
RCF_RECT = ([-16, -8, 96, 64], rgba8(0.4, 0.2, 0.8))


def scene_at(step, root=VIEWPORT):
    """Scene-side parameters after step `step`'s change, and the canvas transform."""
    nodes = initial_scene()
    pos, size = anchored_layout(root)
    nodes["AN"]["pos"], nodes["AN"]["size"] = pos, size
    if step >= 1:
        nodes["S1"]["pos"] = [148, 8]
    if step >= 2:
        nodes["B"]["pos"] = [80, 50]
        nodes["BF"]["pos"] = [0, -10]
        nodes["CU"]["pos"] = [-40, 264]
    if step >= 3:
        nodes["B"]["size"] = [60, 50]
    if step == 4:
        nodes["A"]["clip"] = False
    if step >= 5:
        nodes["D"]["color"] = rgba8(0.6, 0.2, 0.2)
    canvas = (8, 4) if step >= 9 else (0, 0)
    return nodes, canvas


def control_redraw(name, node):
    """A Control's redraw calls (canvas_item.cpp:140, control.cpp:3898-3902, then its own draw)."""
    calls = [("canvas_item_clear", name, None), ("canvas_item_set_custom_rect", name, (True, [0, 0, *node["size"]])), ("canvas_item_set_clip", name, node["clip"])]
    if node["color"] is not None:
        calls.append(("canvas_item_add_rect", name, ([0, 0, *node["size"]], node["color"])))
    if node["draw"] is not None:
        calls.append(("canvas_item_add_rect", name, node["draw"]))
    return calls


def marker_redraw(step):
    return [("canvas_item_clear", "Marker", None), ("canvas_item_add_rect", "Marker", ([0, 0, 32, 32], MARKER[step]))]


# The Controls each step redraws (a size, clip_contents or colour change), and nothing else:
# position changes and the canvas transform never redraw (gate3-design.md Q1a).
REDRAWS = {0: CONTROLS, 3: ["B"], 4: ["A"], 5: ["A", "D"]}


def calls_at(step, root=VIEWPORT):
    """Every clip-relevant RS call step `step` makes, in order (one frame per step)."""
    nodes, _ = scene_at(step, root)
    calls = []
    for name in REDRAWS.get(step, []):
        calls += control_redraw(name, nodes[name])
    if step == 0:
        calls += [
            ("canvas_item_set_custom_rect", "RC", (True, RC_CUSTOM)),
            ("canvas_item_set_clip", "RC", True),
            ("canvas_item_add_rect", "RCF", RCF_RECT),
        ]
    if step == 6:
        calls += [("canvas_item_clear", "RC", None), ("canvas_item_add_rect", "RC", RC_RECT)]
    if step == 7:
        calls += [
            ("canvas_item_clear", "RC", None),
            ("canvas_item_add_rect", "RC", RC_RECT),
            ("canvas_item_set_custom_rect", "RC", (False, [0, 0, 0, 0])),
            ("canvas_item_set_clip", "RC", True),
        ]
    if step == 8:
        calls += [("canvas_item_clear", "RC", None), ("canvas_item_set_clip", "RC", True)]
    calls += marker_redraw(step)
    return calls


# --------------------------------------------------------------------------------------------
# Mirror model: item state from the calls (clear resets clip, D3)
# --------------------------------------------------------------------------------------------


def new_item():
    return {"clip": False, "custom": False, "custom_rect": [0, 0, 0, 0], "cmds": [], "cv": 0}


def apply_calls(items, calls, omit=None):
    """Applies RS calls to mirror item states; `omit` drops every call of that op."""
    for op, name, arg in calls:
        if op == omit:
            continue
        it = items[name]
        if op == "canvas_item_clear":
            it["cmds"] = []
            it["clip"] = False
            it["cv"] += 1
        elif op == "canvas_item_set_clip":
            it["clip"] = arg
        elif op == "canvas_item_set_custom_rect":
            it["custom"], it["custom_rect"] = arg[0], list(arg[1])
        elif op == "canvas_item_add_rect":
            it["cmds"].append((list(arg[0]), list(arg[1])))
            it["cv"] += 1
        else:
            raise ValueError(op)


def wire_states(root=VIEWPORT, omit=None, omit_from_step=None):
    """The mirror's item states at every step's settle frame (list indexed by step)."""
    items = {name: new_item() for name in CREATION_ORDER}
    out = []
    for step in range(LAST_STEP + 1):
        apply_calls(items, calls_at(step, root), omit if omit_from_step is not None and step >= omit_from_step else None)
        out.append(copy.deepcopy(items))
    return out


# --------------------------------------------------------------------------------------------
# Geometry (core/math/rect2.h, transform_2d.h), rects as (x, y, w, h)
# --------------------------------------------------------------------------------------------


def mul(a, b):
    """Godot Transform2D a * b (columns x.x, x.y, y.x, y.y, o.x, o.y): b first."""
    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def translate(x, y):
    return (1.0, 0.0, 0.0, 1.0, float(x), float(y))


def xform_rect(t, r):
    """Transform2D::xform(Rect2): the bounding box of the four corners (expand_to)."""
    x, y, w, h = r
    px, py = t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]
    xs = [px, px + t[0] * w, px + t[2] * h, px + t[0] * w + t[2] * h]
    ys = [py, py + t[1] * w, py + t[3] * h, py + t[1] * w + t[3] * h]
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def intersects(a, b, borders=False):
    if borders:
        return not (a[0] > b[0] + b[2] or a[0] + a[2] < b[0] or a[1] > b[1] + b[3] or a[1] + a[3] < b[1])
    return not (a[0] >= b[0] + b[2] or a[0] + a[2] <= b[0] or a[1] >= b[1] + b[3] or a[1] + a[3] <= b[1])


def intersection(a, b):
    """Rect2::intersection: Rect2() when they do not overlap."""
    if not intersects(a, b):
        return (0.0, 0.0, 0.0, 0.0)
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    return (x0, y0, min(a[0] + a[2], b[0] + b[2]) - x0, min(a[1] + a[3], b[1] + b[3]) - y0)


def round_away(v):
    """Math::round = std::round, half away from zero."""
    return int(math.copysign(math.floor(abs(v) + 0.5), v))


def bounds(cmds):
    """The item rect without a custom rect: the union of the command rects, or Rect2()."""
    if not cmds:
        return (0.0, 0.0, 0.0, 0.0)
    boxes = [(min(r[0], r[0] + r[2]), min(r[1], r[1] + r[3]), abs(r[2]), abs(r[3])) for r, _ in cmds]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    return (x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0)


# --------------------------------------------------------------------------------------------
# Cull and paint
# --------------------------------------------------------------------------------------------


def item_tree(nodes):
    """Parent, children (draw order), local transform and z of every item."""
    tree = {}
    for name, n in nodes.items():
        tree[name] = {"parent": n["parent"], "index": n["index"], "xform": translate(*n["pos"]), "z": n["z"]}
    tree["RC"] = {"parent": None, "index": 1000, "xform": translate(*RC_ORIGIN), "z": 0}
    tree["RCF"] = {"parent": "RC", "index": 0, "xform": translate(0, 0), "z": 0}
    for name, t in tree.items():
        t["children"] = sorted((c for c, u in tree.items() if u["parent"] == name), key=lambda c: tree[c]["index"])
    return tree


def cull(tree, items, canvas, clips=True, effective_clip=None, perturb=False):
    """The engine's cull over one state. `effective_clip` (name -> bool) overrides the item clip
    flags (a receiver model); `perturb` adds +1 to every item's origin x (perturb-transform).
    Returns the draws in paint order, every owner's scissor and the culled items."""
    vp = (0.0, 0.0, float(VIEWPORT[0]), float(VIEWPORT[1]))
    attached = []
    clip_rects = {}
    culled = []

    def visit(name, parent_xf, owner, z, skipped):
        t, it = tree[name], items[name]
        if skipped:
            clip_rects[name] = "skipped"
            for c in t["children"]:
                visit(c, parent_xf, owner, z, True)
            return
        rect = tuple(float(v) for v in it["custom_rect"]) if it["custom"] else bounds(it["cmds"])
        local = t["xform"]
        if perturb:
            local = (*local[:4], local[4] + 1.0, local[5])
        xf = mul(parent_xf, local)
        grect = xform_rect(xf, rect)
        clip = effective_clip[name] if effective_clip is not None else it["clip"]
        own = owner
        if clips and clip:
            fc = intersection(owner[1] if owner else vp, grect)
            if fc[2] < 0.5 or fc[3] < 0.5:
                visit(name, parent_xf, owner, z, True)
                return
            own = (name, (round_away(fc[0]), round_away(fc[1]), round_away(fc[2]), round_away(fc[3])))
            clip_rects[name] = own[1]
        else:
            clip_rects[name] = None
        z2 = z + t["z"]
        if it["cmds"]:
            if intersects(vp, grect, borders=True):
                for r, color in it["cmds"]:
                    attached.append((z2, len(attached), name, xform_rect(xf, r), color, own[1] if own else None))
            else:
                culled.append(name)
        for c in t["children"]:
            visit(c, xf, own, z2, False)

    roots = sorted((n for n, t in tree.items() if t["parent"] is None), key=lambda n: tree[n]["index"])
    for name in roots:
        visit(name, translate(*canvas), None, 0, False)
    attached.sort(key=lambda d: (d[0], d[1]))
    draws = []
    for _z, _i, name, box, color, clip in attached:
        draws.append(
            {
                "name": name,
                "rect_px": [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                "rgba8": color,
                "clip_px": None if clip is None else [clip[0], clip[1], clip[0] + clip[2], clip[1] + clip[3]],
            }
        )
        assert all(float(v).is_integer() for v in box), (name, box)
    owners = {}
    for o in OWNERS:
        v = clip_rects.get(o)
        owners[o] = v if v is None or v == "skipped" else [v[0], v[1], v[0] + v[2], v[1] + v[3]]
    return draws, owners, culled


def paint(draws):
    w, h = VIEWPORT
    fb = [bytearray(bytes(CLEAR) * w) for _ in range(h)]
    for d in draws:
        x, y, rw, rh = d["rect_px"]
        x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + rw), min(h, y + rh)
        if d["clip_px"] is not None:
            cx0, cy0, cx1, cy1 = d["clip_px"]
            x0, y0, x1, y1 = max(x0, cx0), max(y0, cy0), min(x1, cx1), min(y1, cy1)
        if x1 <= x0 or y1 <= y0:
            continue
        row = bytes(d["rgba8"]) * (x1 - x0)
        for py in range(y0, y1):
            fb[py][x0 * 4 : x1 * 4] = row
    return fb


def pixel(fb, x, y):
    return list(fb[y][x * 4 : x * 4 + 4])


# --------------------------------------------------------------------------------------------
# Steps, probes and predictions
# --------------------------------------------------------------------------------------------


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def model(step, states, **kw):
    nodes, canvas = scene_at(step, kw.pop("root", VIEWPORT))
    return cull(item_tree(nodes), states[step], canvas, **kw)


def depths(tree, rects):
    """Clip depth of every owner with a scissor: the number of clipping ancestors."""
    out = {}
    for o, r in rects.items():
        if not isinstance(r, list):
            continue
        d, p = 0, tree[o]["parent"]
        while p is not None:
            if isinstance(rects.get(p), list):
                d += 1
            p = tree[p]["parent"]
        out[o] = d
    return out


EDGES = ("left", "right", "top", "bottom")


def edge_pairs(r):
    """(edge, boundary, along, inside xy, outside xy) at the quarter points of each edge."""
    x0, y0, x1, y1 = r
    out = []
    for k in (1, 2, 3):
        y = y0 + (y1 - y0) * k // 4
        x = x0 + (x1 - x0) * k // 4
        out.append(("left", x0, y, (x0, y), (x0 - 1, y)))
        out.append(("right", x1, y, (x1 - 1, y), (x1, y)))
        out.append(("top", y0, x, (x, y0), (x, y0 - 1)))
        out.append(("bottom", y1, x, (x, y1 - 1), (x, y1)))
    return out


def edge_of(r, edge):
    x0, y0, x1, y1 = r
    return {"left": (x0, y0, y1), "right": (x1, y0, y1), "top": (y0, x0, x1), "bottom": (y1, x0, x1)}[edge]


def probes_for(step, rects, tree, fb, fb_unclipped):
    w, h = VIEWPORT
    depth = depths(tree, rects)
    area = {o: (r[2] - r[0]) * (r[3] - r[1]) for o, r in rects.items() if isinstance(r, list)}
    pairs = {}
    for owner in OWNERS:
        r = rects.get(owner)
        if not isinstance(r, list):
            continue
        for edge, boundary, along, inside, outside in edge_pairs(r):
            if not all(0 <= p[0] < w and 0 <= p[1] < h for p in (inside, outside)):
                continue
            # The innermost owner whose same edge bounds this pair names it.
            cands = []
            for o, ro in rects.items():
                if not isinstance(ro, list) or o not in OWNERS:
                    continue
                b, a0, a1 = edge_of(ro, edge)
                if b == boundary and a0 <= along < a1:
                    cands.append((-depth[o], area[o], o))
            name = sorted(cands)[0][2]
            pairs[(name, edge, along)] = (inside, outside)
    probes = []
    for name in OWNERS:
        for edge in EDGES:
            keys = sorted(k for k in pairs if k[0] == name and k[1] == edge)
            for i, key in enumerate(keys):
                inside, outside = pairs[key]
                decisive = pixel(fb_unclipped, *outside) != pixel(fb, *outside)
                for side, xy in (("inside", inside), ("outside", outside)):
                    probes.append(
                        {
                            "name": f"{name}.{edge}.{side}.{i}",
                            "owner": name,
                            "edge": edge,
                            "side": side,
                            "xy": list(xy),
                            "rgba8": pixel(fb, *xy),
                            "unclipped_rgba8": pixel(fb_unclipped, *xy),
                            "decisive": decisive,
                        }
                    )
    return probes


def invariants(step, states):
    st = states[step]
    inv = []
    for name in CONTROLS + ["RC"]:
        inv.append({"kind": "clip", "item": name, "value": st[name]["clip"]})
        inv.append({"kind": "custom_rect", "item": name, "enabled": st[name]["custom"], "rect": st[name]["custom_rect"]})
    for name in CREATION_ORDER:
        inv.append({"kind": "commands", "item": name, "count": len(st[name]["cmds"])})
    if step >= 1:
        prev = states[step - 1]
        same = [n for n in CREATION_ORDER if n != "Marker" and st[n]["cv"] == prev[n]["cv"]]
        bumped = [n for n in CREATION_ORDER if n != "Marker" and st[n]["cv"] != prev[n]["cv"]]
        inv.append({"kind": "content_unchanged", "items": same, "step": step - 1})
        if bumped:
            inv.append({"kind": "version", "items": bumped, "cmp": "gt", "step": step - 1})
    _, canvas = scene_at(step)
    inv.append({"kind": "canvas_xform", "canvas": 1, "value": [1, 0, 0, 1, *canvas]})
    return inv


def census(root=VIEWPORT):
    clip = {"false": 0, "true": 0}
    custom = {"false": 0, "true": 0}
    clears = 0
    for step in range(LAST_STEP + 1):
        for op, _name, arg in calls_at(step, root):
            if op == "canvas_item_set_clip":
                clip["true" if arg else "false"] += 1
            elif op == "canvas_item_set_custom_rect":
                custom["true" if arg[0] else "false"] += 1
            elif op == "canvas_item_clear":
                clears += 1
    return {"canvas_item_set_clip": clip, "canvas_item_set_custom_rect": custom, "canvas_item_clear": clears}


def receiver_clip(states, rule):
    """Per step, the clip each receiver item actually has under `rule`: "ignore-clip" (every
    set_clip passes false) or "clip-before-clear" (the pre-gate-3 order: set_clip only when the
    wire value changed, then a content rebuild's clear resets it). Items are new at step 0."""
    out = []
    shadow = {}
    effective = {}
    for step, st in enumerate(states):
        for name in CREATION_ORDER:
            wire = st[name]["clip"]
            if rule == "ignore-clip":
                effective[name] = False
                continue
            if step == 0:
                shadow[name] = effective[name] = wire
                continue
            if wire != shadow[name]:
                shadow[name] = effective[name] = wire
            if st[name]["cv"] != states[step - 1][name]["cv"]:
                effective[name] = False
        out.append(dict(effective))
    return out


def frame_diff_steps(frames, other):
    return [k for k in range(LAST_STEP + 1) if frames[k] != other[k]]


def region_diffs(frames, other):
    out = set()
    for k in range(LAST_STEP + 1):
        for name, (x, y, w, h) in REGIONS.items():
            if any(frames[k][py][x * 4 : (x + w) * 4] != other[k][py][x * 4 : (x + w) * 4] for py in range(y, y + h)):
                out.add(name)
    return sorted(out)


def predictions(states, frames, probes_by_step):
    def render(states_, **kw):
        out = []
        for k in range(LAST_STEP + 1):
            draws, _, _ = model(k, states_, **kw)
            out.append(paint(draws))
        return out

    pred = {}
    # freeze-frame at step 2's frame: every later transaction republishes step 1's.
    frozen = [paint(model(min(k, 1), states)[0]) for k in range(LAST_STEP + 1)]
    pred["sabotage-freeze"] = {"steps": frame_diff_steps(frames, frozen)}
    # perturb-transform at step 1's frame: +1 on every item's origin x from then on.
    perturbed = [paint(model(k, states, perturb=k >= 1)[0]) for k in range(LAST_STEP + 1)]
    pred["sabotage-perturb"] = {"steps": frame_diff_steps(frames, perturbed)}
    # omit-op canvas_item_set_clip at step 3's frame; omit-op canvas_item_set_custom_rect at 7's.
    pred["sabotage-omit-clip"] = {"steps": frame_diff_steps(frames, render(wire_states(omit="canvas_item_set_clip", omit_from_step=3)))}
    pred["sabotage-omit-custom-rect"] = {"steps": frame_diff_steps(frames, render(wire_states(omit="canvas_item_set_custom_rect", omit_from_step=7)))}
    # Receiver rules.
    for rule in ("ignore-clip", "clip-before-clear"):
        eff = receiver_clip(states, rule)
        shot = [paint(model(k, states, effective_clip=eff[k])[0]) for k in range(LAST_STEP + 1)]
        entry = {"steps": frame_diff_steps(frames, shot)}
        if rule == "ignore-clip":
            entry["probes"] = sorted(
                f"{k}:{p['name']}" for k in range(LAST_STEP + 1) for p in probes_by_step[k] if pixel(shot[k], *p["xy"]) != p["rgba8"]
            )
        pred[f"sabotage-receiver-{rule}"] = entry
    # root-size-observe: the capture on a 64x64 root; the receiver draws at 640x360.
    small = wire_states(root=(64, 64))
    observe = [paint(model(k, small, root=(64, 64))[0]) for k in range(LAST_STEP + 1)]
    pred["root-size-observe"] = {"steps": frame_diff_steps(frames, observe), "regions": region_diffs(frames, observe)}
    return pred


def build():
    states = wire_states()
    steps = []
    frames = []
    probes_by_step = []
    for step in range(LAST_STEP + 1):
        nodes, canvas = scene_at(step)
        tree = item_tree(nodes)
        draws, rects, culled = cull(tree, states[step], canvas)
        unclipped, _, _ = cull(tree, states[step], canvas, clips=False)
        fb, fbu = paint(draws), paint(unclipped)
        frames.append(fb)
        hand = HAND_CLIP_RECTS[step]
        assert rects == hand, f"step {step}: derived clip_rects {rects} != the contract's hand table {hand}"
        probes = probes_for(step, rects, tree, fb, fbu)
        probes_by_step.append(probes)
        steps.append(
            {
                "step": step,
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, *canvas],
                "draws": draws,
                "culled": culled,
                "clip_rects": rects,
                "probes": probes,
                "invariants": invariants(step, states),
            }
        )
    # The contract's culling table (Q6b): CU culled at steps 0-1, drawn from step 2.
    assert [s["culled"] for s in steps] == [["CU"], ["CU"]] + [[]] * (LAST_STEP - 1), [s["culled"] for s in steps]
    # The decisive-coverage rule (Q6c): every owner edge decisive at two or more steps, or listed.
    listed = {(e["owner"], e["edge"]) for e in NON_DECISIVE_EDGES}
    for owner in OWNERS:
        for edge in EDGES:
            covered = {s["step"] for s in steps for p in s["probes"] if p["owner"] == owner and p["edge"] == edge and p["decisive"]}
            assert (len(covered) < 2) == ((owner, edge) in listed), f"{owner}.{edge}: decisive at steps {sorted(covered)}"
    return {
        "schema": "render-stream-gate3-expected/1",
        "fixture": "gate3",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "regions": REGIONS,
        "empty_region": EMPTY_REGION,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        "owners": OWNERS,
        "hand_clip_rects": {str(k): v for k, v in HAND_CLIP_RECTS.items()},
        "non_decisive_edges": NON_DECISIVE_EDGES,
        "census_totals": census(),
        "steps": steps,
        "predictions": predictions(states, frames, probes_by_step),
    }


def render(data):
    """Indented JSON, with every draw, probe, invariant and clip table entry on one line (the
    1300-odd probes would otherwise run to tens of thousands of lines)."""

    def emit(value, indent, key=None):
        pad = "  " * indent
        if isinstance(value, dict) and key not in ("clip_rects", "census_totals") and not (key and key.isdigit()):
            items = [f'{pad}  {json.dumps(k)}: {emit(v, indent + 1, k)}' for k, v in value.items()]
            return "{\n" + ",\n".join(items) + "\n" + pad + "}" if items else "{}"
        if key == "steps":
            items = [f"{pad}  {emit(v, indent + 1)}" for v in value]
            return "[\n" + ",\n".join(items) + "\n" + pad + "]"
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
            items = [f"{pad}  {json.dumps(v, separators=(', ', ': '))}" for v in value]
            return "[\n" + ",\n".join(items) + "\n" + pad + "]"
        return json.dumps(value, separators=(", ", ": "))

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
