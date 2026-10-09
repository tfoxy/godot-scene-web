#!/usr/bin/env python3
"""Write fixtures/gate3-xform/expected.json (render-stream-gate3-expected/1, fixture gate3-xform).

The derivation models the engine's clip semantics as read from the source (protocol/gate3-design.md
Q1c, Q6d), written down as code over the fixture's own parameters. Nothing here runs or reads the
engine: the reference run has to agree with it (`expected-image-reference-xform`,
`probes-reference-xform`, `semantic-probes`), and a disagreement is a finding to explain from the
source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate3-xform/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate3-xform/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable):

- Transforms. A Node2D's local transform is Transform2D(rotation, scale, 0, position)
  (core/math/transform_2d.cpp:107-113). A Control's is T(pivot) R S T(-pivot) plus its position
  (scene/gui/control.cpp:709-726); gui/common/snap_controls_to_pixels is off, so the origin is never
  rounded (:720-723).
- RS calls. A Control redraw is canvas_item_clear, then its transform, custom rect Rect2(0, size)
  and clip (control.cpp:3898-3902), then a ColorRect's one add_rect. A Node2D redraw is a clear (and
  the Marker's add_rect). A Node2D's rotation or scale and a Control's position never redraw; a
  Control's scale does (control.cpp:1557-1574). Clear resets clip, never the custom rect
  (servers/rendering/renderer_canvas_render.h:455).
- Cull (servers/rendering/renderer_canvas_cull.cpp:296-418): final_xform = parent * self from the
  canvas transform down; global_rect is the axis-aligned bounding box of the item rect through it
  (core/math/transform_2d.h:223-234). A clipping item's scissor is (the nearest clipping ancestor's
  already rounded scissor, else the viewport rect) intersected with global_rect; below 0.5 px on
  either side the item and its subtree are skipped; else position and size are rounded separately,
  half away from zero (core/math/math_funcs.h:625-630).
- Coverage. Every draw is a non-antialiased add_rect: a pixel is covered when its centre lies inside
  the transformed rect and inside its owner's integer scissor (drivers/gles3/
  rasterizer_canvas_gles3.cpp:695-704). Pixels whose centre lies within 1.0 px of a non-axis-aligned
  edge are the `band`: synthesis leaves them out and the checks compare them receiver <-> reference
  under a budget measured by a same-build reference repeat (D8).
- Alternative models (D7), evaluated over the same scene at `semantic_probes`: `rotated-exact` clips
  to the transformed rects themselves (pixel centre), `edge-round` rounds x and x + w separately,
  `pixel-centre` keeps pixels whose centre lies inside the exact, unrounded intersection.
- Probes (gate3-design.md Q6c), as fixtures/gate3: the quarter, half and three-quarter points of
  every scissor edge give an inside/outside pixel pair, named after the innermost owner whose same
  edge bounds it; a pair is decisive when the outside pixel differs from the scene painted with
  every clip off.
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
LAST_STEP = 4
QUIT = S + N * LAST_STEP + SETTLE + 4
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
BAND_PX = 1.0
MARGIN = 0.01

# Gate 1's first five marker colours (fixtures/gate1/gate1.gd MARKER_COLORS).
MARKER = [
    [0, 0, 0, 255],
    [255, 255, 0, 255],
    [0, 255, 255, 255],
    [102, 0, 102, 255],
    [0, 102, 0, 255],
]

REGIONS = {
    "rot": [64, 64, 128, 112],
    "rotnest": [224, 56, 112, 112],
    "half": [352, 32, 80, 72],
    "flip": [440, 200, 160, 64],
    "marker": [584, 8, 48, 48],
}
EMPTY_REGION = [0, 0, 72, 72]

# Every CanvasItem in canvas_item_create order (wire ids 1, 2, ...): gate3x.gd's construction order.
CREATION_ORDER = ["RP", "RQ", "RQF", "RQI", "OA", "RP2", "RQ2", "RQ2F", "SP", "SQ", "SQF", "SR", "SRF", "FP", "FQ", "FQF", "FQI", "Marker"]
OWNERS = ["RQ", "OA", "RQ2", "SQ", "SR", "FQ"]
CONTROLS = ["RQ", "RQF", "RQI", "OA", "RQ2", "RQ2F", "SQ", "SQF", "SR", "SRF", "FQ", "FQF", "FQI"]
NODE2DS = ["RP", "RP2", "SP", "FP", "Marker"]
# Deliberately exact half-pixel values (Q6d "All values are exact in float32"): exempt from the
# rounding-margin assertion.
EXACT_OWNERS = {"SQ", "SR"}

# The engine-model scissors of gate3-design.md Q6d, typed in from the contract, never computed:
# expected-self-consistent checks the derivation against it.
_RQ0 = [83, 83, 172, 158]
_RQ2S = [72, 73, 184, 166]
_OA = [232, 64, 328, 160]
_RQ2 = [232, 79, 328, 145]
_SQ0, _SR0 = [371, 51, 403, 74], [401, 54, 402, 66]
_SQ3, _SR3 = [374, 54, 416, 84], [414, 58, 415, 74]
_FQ0, _FQ4 = [448, 208, 512, 256], [528, 208, 592, 256]
HAND_CLIP_RECTS = {
    0: {"RQ": _RQ0, "OA": _OA, "RQ2": _RQ2, "SQ": _SQ0, "SR": _SR0, "FQ": _FQ0},
    1: {"RQ": [91, 75, 166, 164], "OA": _OA, "RQ2": _RQ2, "SQ": _SQ0, "SR": _SR0, "FQ": _FQ0},
    2: {"RQ": _RQ2S, "OA": _OA, "RQ2": _RQ2, "SQ": _SQ0, "SR": _SR0, "FQ": _FQ0},
    3: {"RQ": _RQ2S, "OA": _OA, "RQ2": _RQ2, "SQ": _SQ3, "SR": _SR3, "FQ": _FQ0},
    4: {"RQ": _RQ2S, "OA": _OA, "RQ2": _RQ2, "SQ": _SQ3, "SR": _SR3, "FQ": _FQ4},
}

# Q6d's semantic-probe table, typed in: per probe, the item whose colour each model predicts there
# ("clear" for the clear colour). make_expected derives every cell and asserts it equals this.
MODELS = ["engine", "rotated-exact", "edge-round", "pixel-centre"]
HAND_SEMANTIC = [
    ("rot.corner", 0, (84, 84), {"engine": "RQF", "rotated-exact": "clear", "edge-round": "RQF", "pixel-centre": "RQF"}),
    ("rot.bottom", 0, (100, 157), {"engine": "RQF", "rotated-exact": "clear", "edge-round": "clear", "pixel-centre": "clear"}),
    ("rot.bottom", 2, (100, 166), {"engine": "clear", "rotated-exact": "clear", "edge-round": "RQF", "pixel-centre": "RQF"}),
    ("half.right", 0, (402, 60), {"engine": "SQF", "rotated-exact": "clear", "edge-round": "clear", "pixel-centre": "clear"}),
    ("half.bottom", 0, (380, 73), {"engine": "SQF", "rotated-exact": "clear", "edge-round": "clear", "pixel-centre": "clear"}),
    ("half.sliver", 0, (401, 60), {"engine": "SRF", "rotated-exact": "SQF", "edge-round": "SQF", "pixel-centre": "SQF"}),
]

NON_DECISIVE_EDGES = [
    {"owner": "OA", "edge": "left", "reason": "RQ2's scissor shares OA's left edge over every quarter point, so the pairs are named RQ2"},
    {"owner": "OA", "edge": "right", "reason": "RQ2's scissor shares OA's right edge over every quarter point, so the pairs are named RQ2"},
]


def rgba8(r, g, b):
    return [round(r * 255), round(g * 255), round(b * 255), 255]


# --------------------------------------------------------------------------------------------
# The fixture
# --------------------------------------------------------------------------------------------


def initial_scene():
    """Scene-side parameters at step 0 (gate3-design.md Q6d's group table, gate3x.gd)."""

    def n2d(parent, pos, rot=0.0, scale=(1.0, 1.0), index=0):
        return {"kind": "node2d", "parent": parent, "index": index, "pos": list(pos), "rot": rot, "scale": list(scale), "z": 0}

    def ctl(parent, pos, size, clip=False, color=None, index=0, pivot=(0.0, 0.0), scale=(1.0, 1.0)):
        return {
            "kind": "control",
            "parent": parent,
            "index": index,
            "pos": list(pos),
            "size": list(size),
            "clip": clip,
            "color": color,
            "pivot": list(pivot),
            "rot": 0.0,
            "scale": list(scale),
            "z": 0,
        }

    return {
        "RP": n2d(None, (128, 120), rot=30.0, index=0),
        "RQ": ctl("RP", (-40, -20), (80, 40), clip=True, pivot=(40, 20)),
        "RQF": ctl("RQ", (-40, -40), (160, 120), color=rgba8(1, 0.6, 0), index=0),
        "RQI": ctl("RQ", (24, 8), (24, 24), color=rgba8(0, 0.6, 1), index=1),
        "OA": ctl(None, (232, 64), (96, 96), clip=True, index=1),
        "RP2": n2d("OA", (48, 48), rot=20.0),
        "RQ2": ctl("RP2", (-64, -12), (128, 24), clip=True),
        "RQ2F": ctl("RQ2", (-48, -48), (224, 120), color=rgba8(0.6, 1, 0.2)),
        "SP": n2d(None, (360, 40), scale=(1.5, 1.5), index=2),
        "SQ": ctl("SP", (7, 7), (21, 15), clip=True),
        "SQF": ctl("SQ", (-8, -8), (40, 32), color=rgba8(0.8, 0.8, 0.2), index=0),
        "SR": ctl("SQ", (20.0625, 2), (0.5, 8), clip=True, index=1),
        "SRF": ctl("SR", (-4, -4), (16, 16), color=rgba8(1, 0.2, 0.6)),
        "FP": n2d(None, (520, 200), scale=(-1.0, 1.0), index=3),
        "FQ": ctl("FP", (8, 8), (64, 48), clip=True),
        "FQF": ctl("FQ", (-8, -8), (80, 64), color=rgba8(0.4, 0.2, 0.8), index=0),
        "FQI": ctl("FQ", (0, 0), (16, 48), color=rgba8(0, 0.6, 1), index=1),
        "Marker": n2d(None, (592, 16), index=4),
    }


def scene_at(step):
    nodes = initial_scene()
    if step == 1:
        nodes["RP"]["rot"] = 60.0
    if step >= 2:
        nodes["RQ"]["scale"] = [1.25, 1.25]
    if step >= 3:
        nodes["SP"]["scale"] = [2.0, 2.0]
    if step >= 4:
        nodes["FP"]["scale"] = [1.0, 1.0]
    return nodes


# The Controls each step redraws: step 2's RQ.scale, and nothing else (Q1a).
REDRAWS = {0: CONTROLS, 2: ["RQ"]}


def calls_at(step):
    nodes = scene_at(step)
    calls = []
    if step == 0:
        calls += [("canvas_item_clear", n, None) for n in NODE2DS if n != "Marker"]
    for name in REDRAWS.get(step, []):
        node = nodes[name]
        calls += [("canvas_item_clear", name, None), ("canvas_item_set_custom_rect", name, (True, [0, 0, *node["size"]])), ("canvas_item_set_clip", name, node["clip"])]
        if node["color"] is not None:
            calls.append(("canvas_item_add_rect", name, ([0, 0, *node["size"]], node["color"])))
    calls += [("canvas_item_clear", "Marker", None), ("canvas_item_add_rect", "Marker", ([0, 0, 32, 32], MARKER[step]))]
    return calls


def new_item():
    return {"clip": False, "custom": False, "custom_rect": [0, 0, 0, 0], "cmds": [], "cv": 0}


def apply_calls(items, calls):
    for op, name, arg in calls:
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


def wire_states():
    items = {name: new_item() for name in CREATION_ORDER}
    out = []
    for step in range(LAST_STEP + 1):
        apply_calls(items, calls_at(step))
        out.append(copy.deepcopy(items))
    return out


# --------------------------------------------------------------------------------------------
# Geometry
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


def rot_scale(deg, scale, origin):
    """Transform2D(rotation, scale, 0, origin) (transform_2d.cpp:107-113)."""
    r = math.radians(deg)
    return (math.cos(r) * scale[0], math.sin(r) * scale[0], -math.sin(r) * scale[1], math.cos(r) * scale[1], float(origin[0]), float(origin[1]))


def local_xform(node, perturb=False):
    if node["kind"] == "node2d":
        t = rot_scale(node["rot"], node["scale"], node["pos"])
    else:
        # T(pivot) R S T(-pivot), then += position (control.cpp:709-718).
        px, py = node["pivot"]
        m = rot_scale(node["rot"], node["scale"], (px, py))
        m = mul(m, (1.0, 0.0, 0.0, 1.0, -px, -py))
        t = (*m[:4], m[4] + node["pos"][0], m[5] + node["pos"][1])
    if perturb:
        t = (*t[:4], t[4] + 1.0, t[5])
    return t


def apply(t, x, y):
    return (t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5])


def corners(t, r):
    x, y, w, h = r
    return [apply(t, x, y), apply(t, x + w, y), apply(t, x + w, y + h), apply(t, x, y + h)]


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def intersects(a, b, borders=False):
    if borders:
        return not (a[0] > b[0] + b[2] or a[0] + a[2] < b[0] or a[1] > b[1] + b[3] or a[1] + a[3] < b[1])
    return not (a[0] >= b[0] + b[2] or a[0] + a[2] <= b[0] or a[1] >= b[1] + b[3] or a[1] + a[3] <= b[1])


def intersection(a, b):
    if not intersects(a, b):
        return (0.0, 0.0, 0.0, 0.0)
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    return (x0, y0, min(a[0] + a[2], b[0] + b[2]) - x0, min(a[1] + a[3], b[1] + b[3]) - y0)


def round_away(v):
    return int(math.copysign(math.floor(abs(v) + 0.5), v))


def axis_aligned(t):
    return t[1] == 0.0 and t[2] == 0.0


def inside_quad(q, x, y):
    """Point strictly inside or on the convex quad q (either winding)."""
    sign = 0
    for i in range(4):
        (ax, ay), (bx, by) = q[i], q[(i + 1) % 4]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if cross != 0:
            s = 1 if cross > 0 else -1
            if sign == 0:
                sign = s
            elif s != sign:
                return False
    return True


def seg_dist2(px, py, a, b):
    """The squared distance from (px, py) to the segment a-b (scripts/lib/gate3x-expected.ts
    segDist2 is the same arithmetic, so both sides draw the band's boundary identically)."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    ex, ey = px - (ax + t * dx), py - (ay + t * dy)
    return ex * ex + ey * ey


# --------------------------------------------------------------------------------------------
# Cull: the engine's scissors, and the scene's draws with their owner chains
# --------------------------------------------------------------------------------------------


def item_tree(nodes):
    tree = {name: {"parent": n["parent"], "index": n["index"], "node": n} for name, n in nodes.items()}
    for name, t in tree.items():
        t["children"] = sorted((c for c, u in tree.items() if u["parent"] == name), key=lambda c: tree[c]["index"])
    return tree


def item_rect(it):
    if it["custom"]:
        return tuple(float(v) for v in it["custom_rect"])
    if not it["cmds"]:
        return (0.0, 0.0, 0.0, 0.0)
    boxes = [r for r, _ in it["cmds"]]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    return (x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0)


def cull(nodes, items, clips=True, perturb=False, effective_clip=None):
    """The engine's cull over one state. Returns the draws in paint order (each with its global
    quad, its axis-alignment, its owner chain and its integer scissor), every owner's scissor, the
    culled items, and per owner its exact global box and quad (for the alternative models)."""
    tree = item_tree(nodes)
    vp = (0.0, 0.0, float(VIEWPORT[0]), float(VIEWPORT[1]))
    draws, culled, rects, geom = [], [], {}, {}

    def visit(name, parent_xf, owner, chain, skipped):
        t, it = tree[name], items[name]
        if skipped:
            rects[name] = "skipped"
            for c in t["children"]:
                visit(c, parent_xf, owner, chain, True)
            return
        xf = mul(parent_xf, local_xform(t["node"], perturb))
        rect = item_rect(it)
        quad = corners(xf, rect)
        grect = bbox(quad)
        clip = effective_clip[name] if effective_clip is not None else it["clip"]
        own, own_chain = owner, chain
        if clips and clip:
            exact = intersection(owner[2] if owner else vp, grect)
            geom[name] = {"box": grect, "quad": quad, "exact": exact}
            if exact[2] < 0.5 or exact[3] < 0.5:
                visit(name, parent_xf, owner, chain, True)
                return
            r = (round_away(exact[0]), round_away(exact[1]), round_away(exact[2]), round_away(exact[3]))
            own = (name, (r[0], r[1], r[0] + r[2], r[1] + r[3]), (float(r[0]), float(r[1]), float(r[2]), float(r[3])))
            own_chain = chain + [name]
            rects[name] = list(own[1])
        else:
            rects[name] = None
        if it["cmds"]:
            if intersects(vp, grect, borders=True):
                for r, color in it["cmds"]:
                    dq = corners(xf, r)
                    draws.append({"name": name, "quad": dq, "aligned": axis_aligned(xf), "rgba8": color, "clip_px": list(own[1]) if own else None, "chain": list(own_chain)})
            else:
                culled.append(name)
        for c in t["children"]:
            visit(c, xf, own, own_chain, False)

    roots = sorted((n for n, t in tree.items() if t["parent"] is None), key=lambda n: tree[n]["index"])
    for name in roots:
        visit(name, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), None, [], False)
    owners = {o: rects.get(o) for o in OWNERS}
    return draws, owners, culled, geom


# --------------------------------------------------------------------------------------------
# Paint: pixel-centre coverage, the band, and the four clip models at a pixel
# --------------------------------------------------------------------------------------------


def covers(d, x, y):
    cx, cy = x + 0.5, y + 0.5
    if d["aligned"]:
        x0, y0, w, h = bbox(d["quad"])
        return x0 <= cx < x0 + w and y0 <= cy < y0 + h
    return inside_quad(d["quad"], cx, cy)


def in_scissor(clip, x, y):
    return clip is None or (clip[0] <= x < clip[2] and clip[1] <= y < clip[3])


def paint(draws):
    """The engine model's frame and its band (a set of (x, y))."""
    w, h = VIEWPORT
    fb = [bytearray(bytes(CLEAR) * w) for _ in range(h)]
    band = set()
    for d in draws:
        x0, y0, bw, bh = bbox(d["quad"])
        xa, ya = max(0, math.floor(x0) - 2), max(0, math.floor(y0) - 2)
        xb, yb = min(w, math.ceil(x0 + bw) + 2), min(h, math.ceil(y0 + bh) + 2)
        if d["clip_px"] is not None:
            c = d["clip_px"]
            xa, ya, xb, yb = max(xa, c[0]), max(ya, c[1]), min(xb, c[2]), min(yb, c[3])
        row = bytes(d["rgba8"])
        for py in range(ya, yb):
            for px in range(xa, xb):
                if not d["aligned"]:
                    q = d["quad"]
                    if any(seg_dist2(px + 0.5, py + 0.5, q[i], q[(i + 1) % 4]) <= BAND_PX * BAND_PX for i in range(4)):
                        band.add((px, py))
                if covers(d, px, py):
                    fb[py][px * 4 : px * 4 + 4] = row
    return fb, band


def pixel(fb, x, y):
    return list(fb[y][x * 4 : x * 4 + 4])


def model_scissors(nodes, items, model):
    """Each owner's clip region under an alternative model: an exact box (pixel-centre), an integer
    rect from rounding each edge (edge-round), the rounded rect (engine), or "skipped"."""
    _, _, _, geom = cull(nodes, items)
    tree = item_tree(nodes)
    vp = (0.0, 0.0, float(VIEWPORT[0]), float(VIEWPORT[1]))
    out = {}

    def parent_owner(name):
        p = tree[name]["parent"]
        while p is not None and p not in geom:
            p = tree[p]["parent"]
        return p

    for name in CREATION_ORDER:  # creation order is parent-first
        if name not in geom:
            continue
        p = parent_owner(name)
        if p is not None and out.get(p) == "skipped":
            out[name] = "skipped"
            continue
        if model == "edge-round":
            outer = vp if p is None else out[p]
            exact = intersection(outer, geom[name]["box"])
            if exact[2] < 0.5 or exact[3] < 0.5:
                out[name] = "skipped"
                continue
            x0, y0 = round_away(exact[0]), round_away(exact[1])
            x1, y1 = round_away(exact[0] + exact[2]), round_away(exact[1] + exact[3])
            out[name] = (float(x0), float(y0), float(x1 - x0), float(y1 - y0))
        elif model == "pixel-centre":
            outer = vp if p is None else out[p]
            exact = intersection(outer, geom[name]["box"])
            out[name] = "skipped" if exact[2] < 0.5 or exact[3] < 0.5 else exact
    return out


def colour_at(nodes, items, model, x, y):
    """The colour of pixel (x, y) under one clip model: the last draw in paint order that covers
    it and passes the model's clip test."""
    draws, _, _, geom = cull(nodes, items)
    alt = model_scissors(nodes, items, model) if model in ("edge-round", "pixel-centre") else None
    cx, cy = x + 0.5, y + 0.5
    colour = CLEAR
    for d in draws:
        if not covers(d, x, y):
            continue
        ok = True
        if model == "engine":
            ok = in_scissor(d["clip_px"], x, y)
        elif model == "rotated-exact":
            ok = all(inside_quad(geom[o]["quad"], cx, cy) for o in d["chain"])
        else:
            for o in d["chain"]:
                r = alt[o]
                if r == "skipped" or not (r[0] <= cx < r[0] + r[2] and r[1] <= cy < r[1] + r[3]):
                    ok = False
        if ok:
            colour = d["rgba8"]
    return colour


# --------------------------------------------------------------------------------------------
# Steps, probes and predictions
# --------------------------------------------------------------------------------------------


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def depths(nodes, rects):
    tree = item_tree(nodes)
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


def probes_for(nodes, rects, fb, fb_unclipped, band):
    w, h = VIEWPORT
    depth = depths(nodes, rects)
    area = {o: (r[2] - r[0]) * (r[3] - r[1]) for o, r in rects.items() if isinstance(r, list)}
    pairs = {}
    for owner in OWNERS:
        r = rects.get(owner)
        if not isinstance(r, list):
            continue
        for edge, boundary, along, inside, outside in edge_pairs(r):
            if not all(0 <= p[0] < w and 0 <= p[1] < h for p in (inside, outside)):
                continue
            cands = []
            for o, ro in rects.items():
                if not isinstance(ro, list):
                    continue
                b, a0, a1 = edge_of(ro, edge)
                if b == boundary and a0 <= along < a1:
                    cands.append((-depth[o], area[o], o))
            pairs[(sorted(cands)[0][2], edge, along)] = (inside, outside)
    probes = []
    for name in OWNERS:
        for edge in EDGES:
            keys = sorted(k for k in pairs if k[0] == name and k[1] == edge)
            for i, key in enumerate(keys):
                inside, outside = pairs[key]
                assert inside not in band and outside not in band, (key, "probe in the band")
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
    for name in CONTROLS:
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
    inv.append({"kind": "canvas_xform", "canvas": 1, "value": [1, 0, 0, 1, 0, 0]})
    return inv


def frames_differ(a, b, band_a, band_b):
    """Steps compared as the checks do: every pixel outside both bands, exact."""
    w, h = VIEWPORT
    skip = band_a | band_b
    for y in range(h):
        if a[y] == b[y]:
            continue
        for x in range(w):
            if (x, y) not in skip and a[y][x * 4 : x * 4 + 4] != b[y][x * 4 : x * 4 + 4]:
                return True
    return False


def emit_draw(d):
    out = {"name": d["name"]}
    if d["aligned"]:
        x0, y0, bw, bh = bbox(d["quad"])
        out["rect_px"] = [x0, y0, bw, bh]
    else:
        out["quad"] = [[p[0], p[1]] for p in d["quad"]]
    out["rgba8"] = d["rgba8"]
    out["clip_px"] = d["clip_px"]
    return out


def check_margins(step, geom):
    """Every value the model rounds is at least MARGIN from a rounding threshold, except the
    deliberate exact half values of SQ and SR (Q6d), so float32 in the engine cannot flip one."""
    for name, g in geom.items():
        if name in EXACT_OWNERS:
            continue
        for v in g["exact"]:
            frac = v - math.floor(v)
            assert abs(frac - 0.5) >= MARGIN, f"step {step}: {name} rounds {v}, within {MARGIN} of .5"


def check_aligned_edges(step, draws):
    """No visible axis-aligned draw edge lies on a pixel centre (k + 0.5): coverage there would
    hang on the rasterizer's fill convention."""
    w, h = VIEWPORT
    for d in draws:
        if not d["aligned"]:
            continue
        x0, y0, bw, bh = bbox(d["quad"])
        c = d["clip_px"] or [0, 0, w, h]
        for v, lo, hi in ((x0, c[0], c[2]), (x0 + bw, c[0], c[2]), (y0, c[1], c[3]), (y0 + bh, c[1], c[3])):
            if lo < v < hi:
                assert abs((v - math.floor(v)) - 0.5) >= MARGIN, f"step {step}: {d['name']} edge {v} inside its scissor sits on a pixel centre"


def build():
    states = wire_states()
    steps, frames, bands, probes_by_step = [], [], [], []
    for step in range(LAST_STEP + 1):
        nodes = scene_at(step)
        draws, rects, culled, geom = cull(nodes, states[step])
        unclipped, _, _, _ = cull(nodes, states[step], clips=False)
        fb, band = paint(draws)
        fbu, _ = paint(unclipped)
        frames.append(fb)
        bands.append(band)
        hand = HAND_CLIP_RECTS[step]
        assert rects == hand, f"step {step}: derived clip_rects {rects} != the contract's hand table {hand}"
        check_margins(step, geom)
        check_aligned_edges(step, draws)
        probes = probes_for(nodes, rects, fb, fbu, band)
        probes_by_step.append(probes)
        steps.append(
            {
                "step": step,
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, 0, 0],
                "draws": [emit_draw(d) for d in draws],
                "culled": culled,
                "clip_rects": rects,
                "band_pixels": len(band),
                "probes": probes,
                "invariants": invariants(step, states),
            }
        )
    assert all(not s["culled"] for s in steps), [s["culled"] for s in steps]

    # RQF and RQ2F cover their owner's whole bounding box at every step (Q6d), so every rot cell
    # is the colour of the scissor decision alone.
    for step in range(LAST_STEP + 1):
        nodes = scene_at(step)
        draws, _, _, geom = cull(nodes, states[step])
        for owner, filler in (("RQ", "RQF"), ("RQ2", "RQ2F")):
            box = geom[owner]["box"]
            quad = next(d["quad"] for d in draws if d["name"] == filler)
            for p in ((box[0], box[1]), (box[0] + box[2], box[1]), (box[0], box[1] + box[3]), (box[0] + box[2], box[1] + box[3])):
                assert inside_quad(quad, *p), f"step {step}: {filler} does not cover {owner}'s box corner {p}"

    # Decisive coverage (Q6c).
    listed = {(e["owner"], e["edge"]) for e in NON_DECISIVE_EDGES}
    for owner in OWNERS:
        for edge in EDGES:
            covered = {s["step"] for s in steps for p in s["probes"] if p["owner"] == owner and p["edge"] == edge and p["decisive"]}
            assert (len(covered) < 2) == ((owner, edge) in listed), f"{owner}.{edge}: decisive at steps {sorted(covered)}"

    # Semantic probes (D7): every model's colour, derived; equal to the contract's hand table.
    colour_names = {"clear": CLEAR}
    for name, n in initial_scene().items():
        if n.get("color") is not None:
            colour_names[name] = n["color"]
    semantic = []
    for name, step, (x, y), hand in HAND_SEMANTIC:
        nodes = scene_at(step)
        models = {m: colour_at(nodes, states[step], m, x, y) for m in MODELS}
        for m in MODELS:
            assert models[m] == colour_names[hand[m]], f"{name}@{step} {m}: derived {models[m]}, hand table {hand[m]}"
        assert (x, y) not in bands[step], f"{name}@{step} lies in the band"
        assert models["engine"] == pixel(frames[step], x, y), f"{name}@{step}: the engine model disagrees with the synthesized frame"
        semantic.append({"name": f"{name}@{step}", "step": step, "xy": [x, y], "models": models, "hand": hand})
    for m in MODELS[1:]:
        assert any(p["models"][m] != p["models"]["engine"] for p in semantic), f"{m} agrees with the engine at every semantic probe"

    return {
        "schema": "render-stream-gate3-expected/1",
        "fixture": "gate3-xform",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "band_px": BAND_PX,
        "regions": REGIONS,
        "empty_region": EMPTY_REGION,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        "owners": OWNERS,
        "models": MODELS,
        "hand_clip_rects": {str(k): v for k, v in HAND_CLIP_RECTS.items()},
        "non_decisive_edges": NON_DECISIVE_EDGES,
        "semantic_probes": semantic,
        "steps": steps,
        "predictions": predictions(states, frames, bands, probes_by_step),
    }


def predictions(states, frames, bands, probes_by_step):
    pred = {}
    # perturb-transform at step 1's frame: +1 on every item's local origin x from then on.
    diff = []
    for k in range(LAST_STEP + 1):
        draws, _, _, _ = cull(scene_at(k), states[k], perturb=k >= 1)
        fb, band = paint(draws)
        if frames_differ(frames[k], fb, bands[k], band):
            diff.append(k)
    pred["sabotage-xform-perturb"] = {"steps": diff}
    # The receiver's ignore-clip: every set_clip passes false.
    diff, failed, in_band = [], [], []
    for k in range(LAST_STEP + 1):
        draws, _, _, _ = cull(scene_at(k), states[k], clips=False)
        fb, band = paint(draws)
        if frames_differ(frames[k], fb, bands[k], band):
            diff.append(k)
        # Unclipped, RQF's and RQ2F's rotated edges cross some probes: the rasterizer decides those
        # pixels, so they are listed apart and the check leaves them out.
        in_band += [f"{k}:{p['name']}" for p in probes_by_step[k] if tuple(p["xy"]) in band]
        failed += [f"{k}:{p['name']}" for p in probes_by_step[k] if tuple(p["xy"]) not in band and pixel(fb, *p["xy"]) != p["rgba8"]]
    pred["sabotage-xform-receiver-ignore-clip"] = {"steps": diff, "probes": sorted(failed), "probes_in_band": sorted(in_band)}
    return pred


def render(data):
    """Indented JSON, with every draw, probe, invariant and clip table entry on one line."""

    def emit(value, indent, key=None):
        pad = "  " * indent
        if isinstance(value, dict) and key not in ("clip_rects", "models", "hand") and not (key and key.isdigit()):
            items = [f"{pad}  {json.dumps(k)}: {emit(v, indent + 1, k)}" for k, v in value.items()]
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
