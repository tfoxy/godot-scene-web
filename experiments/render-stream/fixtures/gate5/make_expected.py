#!/usr/bin/env python3
"""Write fixtures/gate5/expected.json (render-stream-gate5-expected/1).

Every number below is derived from the fixture's own parameters and the engine's geometry rules as
read from the source (protocol/gate5-design.md Q1), written down as code. Nothing here runs or
reads the engine: the capture's hook census and the rendered reference have to agree with it, and
a disagreement is a finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate5/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate5/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `rcc` is
servers/rendering/renderer_canvas_cull.cpp, `ci` scene/main/canvas_item.cpp, `gles3c`
drivers/gles3/rasterizer_canvas_gles3.cpp):

- Calls. Each region's `_draw` issues the RenderingServer calls of Q1a: passthroughs keep the
  script's arguments (float32), computed ones (`draw_dashed_line`'s multiline points, an unfilled
  `draw_rect`'s 5-point loop, an unfilled `draw_circle`'s 65-point loop, `draw_set_transform`'s
  matrix, Line2D's LineBuilder arrays) are recomputed here and flagged `ulp: 2` (D12).
- Coverage (`items`). The server lowering of Q1b/Q1c, recomputed in float32 from the calls: a wide
  line is the quad `from +- t`, `to +- t` (rcc:717-743); a multiline of width >= 0 one such quad per
  pair (rcc:1238-1255); a polyline the triangle strip of rcc:1166-1205 with its clamped bisector
  offsets and hold-last colours; a circle the 64-segment fan of rcc:1422-1465; a polygon any
  triangulation of its outline (ear clipping tiles the same interior, Q1c); a primitive one or two
  triangles with binary16 colours (gles3c:1123-1176); a triangle array the first `count * 3`
  indices; a nine-patch the shader's axis mapping (drivers/gles3/shaders/canvas.glsl:521-588);
  Line2D the LineBuilder strip of scene/2d/line_builder.cpp (sharp joints, no caps, no texture).
  Draw transforms are commands, replaced, never composed (D9); clip-ignore commands toggle the
  item's scissor (D10). Antialiased shapes carry `band_px` (FEATHER_SIZE 1.25 + 1, rcc:45) and a
  thin line (width < 0, GL_LINES) is band within 1 px (D13). scripts/lib/geometry-raster.ts
  rasterizes this model.
- Redraws. A property set by a step queues a redraw of its own node only; a Control's position, a
  canvas transform and the marker never redraw a region (Q6b's table). Line2D's `antialiased`
  queues a redraw that records the same bytes (line_2d.cpp:264-312 never reads it).
- Freshness. A region is fresh at a step exactly when its modelled content (item transforms,
  scissors and commands) differs from the previous step's.
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
FEATHER_SIZE = 1.25
AA_BAND_PX = FEATHER_SIZE + 1
THIN_BAND_PX = 1.0
GRID = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}

# Gate 3's marker colours (gate5.gd MARKER_COLORS).
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
MARKER_COLOURS = [[c / 255 for c in m[:3]] + [1] for m in MARKER]

# Q6b's regions, [x0, y0, x1) x [y0, y1).
REGIONS = {
    "LN": [16, 16, 168, 100],
    "PL": [168, 16, 320, 100],
    "PG": [320, 16, 472, 100],
    "PR": [472, 16, 576, 100],
    "CI": [16, 112, 168, 196],
    "ST": [168, 112, 320, 196],
    "CG": [320, 112, 472, 196],
    "NP": [472, 112, 608, 196],
    "RA": [16, 208, 168, 292],
    "BL": [168, 208, 320, 292],
    "L2": [320, 208, 472, 292],
    "Marker": [584, 8, 632, 56],
}
# Wire id order: every CanvasItem in canvas_item_create order (gate5.gd _ready); tree order is the
# same (STC is ST's only child).
CREATION_ORDER = ["LN", "PL", "PG", "PR", "CI", "ST", "STC", "CG", "NP", "RA", "BL", "L2", "Marker"]
PARENT = {"STC": "ST"}
REGION_OF = {name: (PARENT.get(name, name)) for name in CREATION_ORDER}
POSITION = {
    "LN": (16, 16),
    "PL": (176, 16),
    "PG": (336, 16),
    "PR": (472, 16),
    "CI": (16, 112),
    "ST": (176, 112),
    "STC": (96, 44),
    "CG": (344, 120),
    "NP": (472, 112),
    "RA": (16, 208),
    "BL": (176, 208),
    "L2": (328, 216),
    "Marker": (592, 16),
}
CG_SIZE = (64, 48)

# Q6a's textures (gate5.gd TEX16_QUADRANTS, TEX9_*).
TEX16_QUADRANTS = [[1, 0.2, 0.2, 1], [0.2, 1, 0.2, 1], [0.2, 0.2, 1, 1], [1, 1, 0.2, 1]]
TEX9_BORDER = [1, 1, 0.6, 1]
TEX9_CENTRE = [0.4, 0.2, 0.8, 1]

# The initial state and Q6b's timeline: (step, item, property, value), in gate5.gd's order.
INITIAL = {
    "l2_width": 2.0,
    "l6_antialiased": True,
    "p1_color": [0.4, 0.8, 1, 1],
    "g1_offset": (0, 0),
    "r3_count": 2,
    "b_scale": 2.0,
    "c1_radius": 24.0,
    "cg_offset": (0, 0),
    "line2d_antialiased": False,
    "canvas": (0, 0),
}
TIMELINE = {
    1: [("LN", "l2_width", 4.0)],
    2: [("PG", "g1_offset", (0, 8))],
    3: [("PL", "p1_color", [1, 0.8, 0.2, 1]), ("L2", "line2d_antialiased", True)],
    4: [("PR", "r3_count", 4)],
    5: [("ST", "b_scale", 3.0)],
    6: [("CI", "c1_radius", 20.0)],
    7: [(None, "cg_offset", (16, 8))],
    8: [("LN", "l6_antialiased", False)],
    9: [(None, "canvas", (8, 4))],
}

# The census the fixture makes over the whole run, typed in by hand from Q6b (one call per item
# redraw: LN at 0, 1, 8; PL 0, 3; PG 0, 2; PR 0, 4; CI 0, 6; ST 0, 5; L2 0, 3; the marker every
# step; everything else at 0), never computed. `calls_by_op` must equal it.
HAND_CENSUS = {
    "canvas_item_add_rect": 10 + 3 + 2 * 4 + 1 + 1 + 1,
    "canvas_item_add_line": 3 * 5,
    "canvas_item_add_multiline": 3,
    "canvas_item_add_polyline": 2 * 3 + 2,
    "canvas_item_add_circle": 2 * 2,
    "canvas_item_add_polygon": 2 * 3 + 1,
    "canvas_item_add_primitive": 2 * 2,
    "canvas_item_add_triangle_array": 2 + 2,
    "canvas_item_add_nine_patch": 2,
    "canvas_item_add_set_transform": 2 * 3,
    "canvas_item_add_clip_ignore": 2,
}
# The ops a /0-/3 capture types `unsupported` (calibrators 2 and 6): every gate 5 op but add_rect.
# add_multiline is unhooked until calibrator 7 (G5a); the checker adds it when the hook is planned.
TYPED_OPS = sorted(op for op in HAND_CENSUS if op not in ("canvas_item_add_rect", "canvas_item_add_multiline"))
CALIBRATOR7_OPS = ["canvas_item_add_multiline"]

# The one texture the engine makes itself (memory rs-g2a-texture-census-facts), then TEX16, TEX9.
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]


# --------------------------------------------------------------------------------------------
# float32 arithmetic (real_t is float in the release template)
# --------------------------------------------------------------------------------------------


def f32(x):
    return struct.unpack("<f", struct.pack("<f", float(x)))[0]


def f16(x):
    return struct.unpack("<e", struct.pack("<e", float(x)))[0]


def vadd(a, b):
    return (f32(a[0] + b[0]), f32(a[1] + b[1]))


def vsub(a, b):
    return (f32(a[0] - b[0]), f32(a[1] - b[1]))


def vmul(a, s):
    return (f32(a[0] * s), f32(a[1] * s))


def vlen(a):
    return f32(math.sqrt(f32(f32(a[0] * a[0]) + f32(a[1] * a[1]))))


def normalized(a):
    length = vlen(a)
    return (0.0, 0.0) if length == 0 else (f32(a[0] / length), f32(a[1] / length))


def orthogonal(a):
    """Vector2::orthogonal: (y, -x)."""
    return (a[1], -a[0])


def cross(a, b):
    return f32(f32(a[0] * b[1]) - f32(a[1] * b[0]))


def dot(a, b):
    return f32(f32(a[0] * b[0]) + f32(a[1] * b[1]))


def zero_approx(a):
    return abs(a[0]) < 1e-5 and abs(a[1]) < 1e-5


def equal_approx(a, b):
    def eq(x, y):
        return x == y or abs(x - y) < max(1e-5, 1e-5 * abs(x))

    return eq(a[0], b[0]) and eq(a[1], b[1])


def colour(c):
    return [f32(v) for v in c]


def p32(p):
    return [f32(p[0]), f32(p[1])]


# --------------------------------------------------------------------------------------------
# Server lowering (D3: the receiver's engine repeats it; this is the hand model of it)
# --------------------------------------------------------------------------------------------


def quad_mesh(name, pts, col, band_px=None):
    shape = {"name": name, "kind": "mesh", "vertices": [p32(p) for p in pts], "triangles": [[0, 1, 2], [0, 2, 3]], "colors": [colour(col)]}
    if band_px is not None:
        shape["band_px"] = band_px
    return shape


def lower_line(name, frm, to, col, width, aa):
    """canvas_item_add_line (rcc:717-900)."""
    if width < 0:
        return [{"name": name, "kind": "thin_line", "from": p32(frm), "to": p32(to), "colors": [colour(col)], "band_px": THIN_BAND_PX}]
    diff = vsub(frm, to)
    t = vmul(vmul(normalized(orthogonal(diff)), f32(width)), 0.5)
    pts = [vadd(frm, t), vsub(frm, t), vsub(to, t), vadd(to, t)]
    return [quad_mesh(name, pts, col, AA_BAND_PX if aa else None)]


def polyline_offset(seg, prev):
    """compute_polyline_edge_offset_clamped (rcc:922-943)."""
    bis = normalized(vsub(vmul(prev, vlen(seg)), vmul(seg, vlen(prev))))
    angle = math.atan2(cross(bis, prev), dot(bis, prev))
    sin_a = f32(math.sin(f32(angle)))
    length = 1.0
    if abs(sin_a) >= 1e-5 and not equal_approx(seg, prev):
        length = max(-3.0, min(3.0, f32(1.0 / sin_a)))
    else:
        bis = orthogonal(seg)
    if zero_approx(bis):
        bis = orthogonal(seg)
    return vmul(bis, f32(length))


def lower_polyline(name, points, cols, width):
    """canvas_item_add_polyline, width >= 0, not antialiased (rcc:945-1206): one triangle strip."""
    n = len(points)
    assert width >= 0 and n >= 2
    loop = equal_approx(points[0], points[n - 1])
    first = last = (0.0, 0.0)
    for i in range(1, n):
        first = normalized(vsub(points[i], points[i - 1]))
        if not zero_approx(first):
            break
    for i in range(n - 1, 0, -1):
        last = normalized(vsub(points[i], points[i - 1]))
        if not zero_approx(last):
            break
    verts, vcols = [], []
    colour_now = [1, 1, 1, 1]
    prev = (0.0, 0.0)
    for i in range(n):
        if i == n - 1:
            seg = prev
        else:
            seg = normalized(vsub(points[i + 1], points[i]))
            if zero_approx(seg):
                seg = prev
        if i == 0 and loop:
            prev = last
        elif i == n - 1 and loop:
            prev = first
        if i == 0 and not loop:
            base = orthogonal(first)
        elif i == n - 1 and not loop:
            base = orthogonal(last)
        else:
            base = polyline_offset(seg, prev)
        off = vmul(base, f32(f32(width) * 0.5))
        verts += [vadd(points[i], off), vsub(points[i], off)]
        if i < len(cols):
            colour_now = cols[i]
        vcols += [colour(colour_now), colour(colour_now)]
        prev = seg
    tris = [[i, i + 1, i + 2] for i in range(len(verts) - 2)]
    shape = {"name": name, "kind": "mesh", "vertices": [p32(v) for v in verts], "triangles": tris}
    shape["colors"] = vcols if any(c != vcols[0] for c in vcols) else [vcols[0]]
    return [shape]


def lower_circle(name, pos, radius, col, aa):
    """canvas_item_add_circle (rcc:1422-1465): a 64-segment fan around the centre (index 65)."""
    step = f32(math.tau / 64)
    pts = []
    for i in range(65):
        angle = f32(i * step)
        pts.append(vadd((f32(f32(math.cos(angle)) * f32(radius)), f32(f32(math.sin(angle)) * f32(radius))), pos))
    pts.append(p32(pos))
    shape = {"name": name, "kind": "mesh", "vertices": [p32(p) for p in pts], "triangles": [[65, i, i + 1] for i in range(64)], "colors": [colour(col)]}
    if aa:
        shape["band_px"] = AA_BAND_PX
    return [shape]


def circle_polyline_points(pos, radius):
    """draw_circle unfilled with width < 2r (ci:815-849): 64 points and the first again."""
    step = f32(math.tau / 64)
    pts = []
    for i in range(64):
        angle = f32(i * step)
        pts.append(vadd((f32(f32(math.cos(angle)) * f32(radius)), f32(f32(math.sin(angle)) * f32(radius))), pos))
    pts.append(pts[0])
    return pts


def dashed_points(frm, to, dash):
    """draw_dashed_line, aligned (ci:697-731): the multiline's dash endpoints."""
    length = vlen(vsub(to, frm))
    step = vmul(normalized(vsub(to, frm)), dash)
    steps = math.ceil(length / dash)
    if steps % 2 == 0:
        steps -= 1
    off = vadd(frm, vmul(normalized(vsub(to, frm)), f32(f32(length - f32(steps * dash)) / 2.0)))
    pts = [None] * (steps + 1)
    for i in range(0, steps, 2):
        pts[i] = frm if i == 0 else off
        pts[i + 1] = to if i == steps - 1 else vadd(off, step)
        off = vadd(off, vmul(step, 2))
    return pts


def ear_clip(points):
    """Any triangulation of a simple polygon tiles its interior (Q1c); a plain ear clipper."""
    idx = list(range(len(points)))
    area = sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in idx)
    if area < 0:
        idx.reverse()
    tris = []

    def inside(p, a, b, c):
        def s(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

        d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
        return d1 >= 0 and d2 >= 0 and d3 >= 0

    while len(idx) > 3:
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = points[i0], points[i1], points[i2]
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0:
                continue
            if any(inside(points[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append([i0, i1, i2])
            idx.pop(k)
            break
        else:
            raise AssertionError("ear_clip: no ear (not a simple polygon)")
    tris.append(idx)
    return tris


def segment_intersection(a0, a1, b0, b1):
    """Geometry2D::segment_intersects_segment for the joints LineBuilder sees (non-parallel)."""
    d1, d2 = vsub(a1, a0), vsub(b1, b0)
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if den == 0:
        return None
    t = ((b0[0] - a0[0]) * d2[1] - (b0[1] - a0[1]) * d2[0]) / den
    u = ((b0[0] - a0[0]) * d1[1] - (b0[1] - a0[1]) * d1[0]) / den
    if not (0 <= t <= 1 and 0 <= u <= 1):
        return None
    return (f32(a0[0] + t * d1[0]), f32(a0[1] + t * d1[1]))


def line2d_arrays(points, width, sharp_limit=2.0):
    """LineBuilder::build (scene/2d/line_builder.cpp:44-420) for an open line with sharp joints,
    no caps, no texture, no gradient and no curve: (indices, vertices, colours=[default], uvs=[])."""
    hw = f32(width / 2.0)
    verts, indices = [], []
    last = {}

    def strip_begin(up, down):
        last["up"], last["down"] = len(verts), len(verts) + 1
        verts.extend([up, down])

    def strip_add_quad(up, down):
        vi = len(verts)
        verts.extend([up, down])
        indices.extend([last["up"], vi + 1, last["down"], last["up"], vi, vi + 1])
        last["up"], last["down"] = vi, vi + 1

    pos0 = points[0]
    f0 = normalized(vsub(points[1], pos0))
    u0 = orthogonal(f0)
    strip_begin(vadd(pos0, vmul(u0, hw)), vsub(pos0, vmul(u0, hw)))
    for i in range(1, len(points) - 1):
        pos1, pos2 = points[i], points[i + 1]
        f1 = normalized(vsub(pos2, pos1))
        u1 = orthogonal(f1)
        up = dot(u0, f1) > 0
        n0, n1 = vmul(u0, hw), vmul(u1, hw)
        if not up:
            n0, n1 = (-n0[0], -n0[1]), (-n1[0], -n1[1])
        corner_in = segment_intersection(vadd(pos0, n0), vadd(pos1, n0), vadd(pos1, n1), vadd(pos2, n1))
        assert corner_in is not None, "line2d: joint without an inner intersection is not modelled"
        corner_out = vsub(vmul(pos1, 2.0), corner_in)
        d2 = f32((corner_out[0] - pos1[0]) ** 2 + (corner_out[1] - pos1[1]) ** 2)
        assert d2 / (hw * hw) <= sharp_limit * sharp_limit, "line2d: sharp joint would fall back to bevel"
        corner_up, corner_down = (corner_in, corner_out) if up else (corner_out, corner_in)
        strip_add_quad(corner_up, corner_down)
        pos0, u0 = pos1, u1
    pos1 = points[-1]
    strip_add_quad(vadd(pos1, vmul(u0, hw)), vsub(pos1, vmul(u0, hw)))
    return indices, [p32(v) for v in verts]


# --------------------------------------------------------------------------------------------
# The scene: per item, the RS calls its `_draw` makes and their coverage
# --------------------------------------------------------------------------------------------


def call(op, ulp=0, **args):
    entry = {"op": op}
    entry.update(args)
    if ulp:
        entry["ulp"] = ulp
    return entry


def draw_rect_call(rect, col, aa=False):
    return call("canvas_item_add_rect", rect=[f32(v) for v in rect], color=colour(col), antialiased=aa)


def rect_shape(name, rect, col, aa=False):
    x, y, w, h = rect
    return quad_mesh(name, [(x, y), (x + w, y), (x + w, y + h), (x, y + h)], col, AA_BAND_PX if aa else None)


def item_lines(state):
    calls, ops = [], []
    lines = [
        ("L1", (8, 8.5), (136, 8.5), [1, 1, 1, 1], 1.0, False),
        ("L2", (8, 20), (136, 20), [1, 0.8, 0.2, 1], state["l2_width"], False),
        ("L3", (140.5, 4), (140.5, 76), [0.4, 1, 0.4, 1], 3.0, False),
        ("L4", (8, 32.5), (136, 32.5), [0.6, 1, 0.6, 1], -1.0, False),
        ("L5", None, None, None, None, None),
        ("L6", (8, 56), (64, 72), [1, 1, 0.2, 1], 4.0, state["l6_antialiased"]),
    ]
    for name, frm, to, col, width, aa in lines:
        if name == "L5":
            pts = dashed_points((8.0, 44.0), (136.0, 44.0), 8.0)
            c5 = [1, 0.6, 0.6, 1]
            calls.append(call("canvas_item_add_multiline", ulp=2, points=[p32(p) for p in pts], colors=[colour(c5)], width=2.0, antialiased=False))
            for k in range(0, len(pts), 2):
                ops += lower_line(f"L5.{k // 2}", pts[k], pts[k + 1], c5, 2.0, False)
            continue
        calls.append(call("canvas_item_add_line", **{"from": p32(frm)}, to=p32(to), color=colour(col), width=f32(width), antialiased=aa))
        ops += lower_line(name, frm, to, col, width, aa)
    return calls, ops


def item_polylines(state):
    calls, ops = [], []
    p1 = [(8.0, 8.0), (64.0, 8.0), (64.0, 40.0)]
    calls.append(call("canvas_item_add_polyline", points=[p32(p) for p in p1], colors=[colour(state["p1_color"])], width=4.0, antialiased=False))
    ops += lower_polyline("P1", p1, [state["p1_color"]], 4.0)
    rx, ry, rw, rh = 80.0, 8.0, 48.0, 32.0
    p2 = [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh), (rx, ry)]
    c2 = [1, 0.4, 0.8, 1]
    calls.append(call("canvas_item_add_polyline", ulp=2, points=[p32(p) for p in p2], colors=[colour(c2)], width=2.0, antialiased=False))
    ops += lower_polyline("P2", p2, [c2], 2.0)
    p3 = [(8.0, 56.0), (48.0, 56.0), (48.0, 72.0), (136.0, 72.0)]
    c3 = [[1, 1, 1, 1], [0.2, 0.6, 1, 1]]
    calls.append(call("canvas_item_add_polyline", points=[p32(p) for p in p3], colors=[colour(c) for c in c3], width=4.0, antialiased=False))
    ops += lower_polyline("P3", p3, c3, 4.0)
    return calls, ops


G1 = [(8, 16), (40, 16), (40, 8), (64, 25), (40, 42), (40, 33), (8, 33)]


def polygon_shape(name, pts, cols, uvs=None, texture=None):
    shape = {"name": name, "kind": "mesh", "vertices": [p32(p) for p in pts], "triangles": ear_clip(pts), "colors": [colour(c) for c in cols]}
    if texture:
        shape["uvs"] = [p32(u) for u in uvs]
        shape["texture"] = texture
    return shape


def item_polygons(state):
    calls, ops = [], []
    dx, dy = state["g1_offset"]
    g1 = [(x + dx, y + dy) for x, y in G1]
    c1 = [0.8, 0.4, 1, 1]
    calls.append(call("canvas_item_add_polygon", points=[p32(p) for p in g1], colors=[colour(c1)], uvs=[], texture=None))
    ops.append(polygon_shape("G1", g1, [c1]))
    g2 = [(72, 8), (104, 8), (72, 41)]
    c2 = [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]
    calls.append(call("canvas_item_add_polygon", points=[p32(p) for p in g2], colors=[colour(c) for c in c2], uvs=[], texture=None))
    ops.append(polygon_shape("G2", g2, c2))
    g3 = [(112, 8), (128, 8), (128, 24), (112, 24)]
    uv3 = [(0, 0), (1, 0), (1, 1), (0, 1)]
    calls.append(call("canvas_item_add_polygon", points=[p32(p) for p in g3], colors=[colour([1, 1, 1, 1])], uvs=[p32(u) for u in uv3], texture="TEX16"))
    ops.append(polygon_shape("G3", g3, [[1, 1, 1, 1]], uv3, "TEX16"))
    return calls, ops


def primitive_shape(name, pts, col):
    # gles3c:1144-1146: each colour (times the white base colour) packed as binary16.
    half = [f16(f32(v)) for v in col]
    tris = [[0, 1, 2]] if len(pts) == 3 else [[0, 1, 2], [0, 2, 3]]
    return {"name": name, "kind": "mesh", "vertices": [p32(p) for p in pts], "triangles": tris, "colors": [half]}


def item_primitives(state):
    calls, ops = [], []
    r1 = [(8, 8), (40, 8), (8, 41)]
    c1 = [1, 0.6, 0.2, 1]
    calls.append(call("canvas_item_add_primitive", points=[p32(p) for p in r1], colors=[colour(c1)], uvs=[], texture=None))
    ops.append(primitive_shape("R1", r1, c1))
    r2 = [(48, 8), (80, 8), (80, 40), (48, 40)]
    c2 = [0.2, 1, 0.8, 1]
    calls.append(call("canvas_item_add_primitive", points=[p32(p) for p in r2], colors=[colour(c2)], uvs=[], texture=None))
    ops.append(primitive_shape("R2", r2, c2))
    indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
    pts = [(8, 48), (40, 48), (40, 72), (8, 72), (48, 48), (80, 48), (80, 72), (48, 72)]
    c3 = [1, 0.2, 0.4, 1]
    count = state["r3_count"]
    calls.append(call("canvas_item_add_triangle_array", indices=indices, points=[p32(p) for p in pts], colors=[colour(c3)], uvs=[], bones=[], weights=[], texture=None, count=count))
    drawn = indices[: count * 3] if count >= 0 else indices
    ops.append({"name": "R3", "kind": "mesh", "vertices": [p32(p) for p in pts], "triangles": [drawn[i : i + 3] for i in range(0, len(drawn), 3)], "colors": [colour(c3)]})
    return calls, ops


def item_circles(state):
    calls, ops = [], []
    c1 = [1, 0.8, 0.4, 1]
    calls.append(call("canvas_item_add_circle", position=[32.0, 40.0], radius=f32(state["c1_radius"]), color=colour(c1), antialiased=False))
    ops += lower_circle("C1", (32.0, 40.0), state["c1_radius"], c1, False)
    c2 = [0.4, 0.8, 1, 1]
    calls.append(call("canvas_item_add_circle", position=[88.0, 40.0], radius=16.0, color=colour(c2), antialiased=True))
    ops += lower_circle("C2", (88.0, 40.0), 16.0, c2, True)
    c3 = [1, 1, 1, 1]
    pts = circle_polyline_points((128.0, 40.0), 12.0)
    calls.append(call("canvas_item_add_polyline", ulp=2, points=[p32(p) for p in pts], colors=[colour(c3)], width=2.0, antialiased=False))
    ops += lower_polyline("C3", pts, [c3], 2.0)
    return calls, ops


def item_transforms(state):
    calls, ops = [], []
    s = state["b_scale"]
    entries = [
        ("A", [4, 4, 24, 16], [1, 0.4, 0.4, 1], None),
        ("B", [2, 2, 8, 8], [0.4, 1, 0.4, 1], [s, 0, 0, s, 32, 0]),
        ("C", [0, 0, 24, 8], [0.4, 0.4, 1, 1], [0, 1, -1, 0, 88, 8]),
        ("D", [4, 4, 24, 16], [1, 1, 0.4, 1], [1, 0, 0, 1, 0, 40]),
    ]
    for name, rect, col, xform in entries:
        if xform is not None:
            # draw_set_transform builds Transform2D(rot, pos).scale_basis (computed); the two
            # draw_set_transform_matrix calls pass their matrix through.
            calls.append(call("canvas_item_add_set_transform", ulp=2 if name == "B" else 0, transform=[f32(v) for v in xform]))
            ops.append({"op": "set_transform", "transform": [f32(v) for v in xform]})
        calls.append(draw_rect_call(rect, col))
        ops.append(rect_shape(name, rect, col))
    return calls, ops


def item_stc(_state):
    rect, col = [0, 0, 24, 24], [1, 0.6, 1, 1]
    return [draw_rect_call(rect, col)], [rect_shape("E", rect, col)]


def item_clip_ignore(_state):
    calls = [
        draw_rect_call([0, 0, 64, 48], [0.2, 0.6, 0.4, 1]),
        call("canvas_item_add_clip_ignore", ignore=True),
        draw_rect_call([48, 32, 32, 24], [1, 0.8, 0.6, 1]),
        call("canvas_item_add_clip_ignore", ignore=False),
        draw_rect_call([-8, -8, 24, 16], [0.6, 0.2, 0.2, 1]),
    ]
    ops = [
        rect_shape("X", [0, 0, 64, 48], [0.2, 0.6, 0.4, 1]),
        {"op": "clip_ignore", "ignore": True},
        rect_shape("Y", [48, 32, 32, 24], [1, 0.8, 0.6, 1]),
        {"op": "clip_ignore", "ignore": False},
        rect_shape("Z", [-8, -8, 24, 16], [0.6, 0.2, 0.2, 1]),
    ]
    return calls, ops


def item_nine_patch(_state):
    calls, ops = [], []
    for name, rect, axis, centre in (("N1", [8, 8, 56, 40], "stretch", True), ("N2", [72, 8, 56, 40], "tile", False)):
        args = {"rect": [f32(v) for v in rect], "source": [0.0, 0.0, 0.0, 0.0], "texture": "TEX9", "topleft": [4.0, 4.0], "bottomright": [4.0, 4.0], "x_axis": axis, "y_axis": axis, "draw_center": centre, "modulate": [1.0, 1.0, 1.0, 1.0]}
        calls.append(call("canvas_item_add_nine_patch", **args))
        ops.append({"name": name, "kind": "nine_patch", "rect": args["rect"], "texture": "TEX9", "margins": [4.0, 4.0, 4.0, 4.0], "x_axis": axis, "y_axis": axis, "draw_center": centre, "modulate": args["modulate"]})
    return calls, ops


def item_aa_rect(_state):
    rect, col = [8, 8, 48, 32], [1, 1, 1, 1]
    return [draw_rect_call(rect, col, aa=True)], [rect_shape("RA", rect, col, aa=True)]


def item_blend(_state):
    panel, white = [0, 0, 64, 48], [1, 1, 1, 1]
    poly = [(32, 16), (96, 16), (96, 64), (32, 64)]
    c = [0.2, 0.4, 1, 0.6]
    calls = [draw_rect_call(panel, white), call("canvas_item_add_polygon", points=[p32(p) for p in poly], colors=[colour(c)], uvs=[], texture=None)]
    return calls, [rect_shape("W", panel, white), polygon_shape("T", poly, [c])]


L2_POINTS = [(8.0, 8.0), (72.0, 8.0), (72.0, 56.0)]
L2_WIDTH = 6.0
L2_COLOUR = [1, 0.6, 0.2, 1]


def item_line2d(_state):
    indices, verts = line2d_arrays(L2_POINTS, L2_WIDTH)
    calls = [call("canvas_item_add_triangle_array", ulp=2, indices=indices, points=verts, colors=[colour(L2_COLOUR)], uvs=[], bones=[], weights=[], texture=None, count=-1)]
    ops = [{"name": "L2", "kind": "mesh", "vertices": verts, "triangles": [indices[i : i + 3] for i in range(0, len(indices), 3)], "colors": [colour(L2_COLOUR)]}]
    return calls, ops


def item_marker(step):
    def draw(_state):
        rect, col = [0, 0, 32, 32], MARKER_COLOURS[step]
        return [draw_rect_call(rect, col)], [rect_shape("M", rect, col)]

    return draw


DRAWERS = {
    "LN": item_lines,
    "PL": item_polylines,
    "PG": item_polygons,
    "PR": item_primitives,
    "CI": item_circles,
    "ST": item_transforms,
    "STC": item_stc,
    "CG": item_clip_ignore,
    "NP": item_nine_patch,
    "RA": item_aa_rect,
    "BL": item_blend,
    "L2": item_line2d,
}
# Which item each timeline property redraws (its setter's queue_redraw).
REDRAWN_BY = {"l2_width": "LN", "l6_antialiased": "LN", "p1_color": "PL", "g1_offset": "PG", "r3_count": "PR", "b_scale": "ST", "c1_radius": "CI", "line2d_antialiased": "L2"}


def texture_table():
    def rgba8(c):
        return [round(v * 255) for v in c]

    tex16 = []
    for y in range(16):
        for x in range(16):
            tex16.append(rgba8(TEX16_QUADRANTS[(1 if x >= 8 else 0) + (2 if y >= 8 else 0)]))
    tex9 = []
    for y in range(12):
        for x in range(12):
            tex9.append(rgba8(TEX9_CENTRE if 4 <= x < 8 and 4 <= y < 8 else TEX9_BORDER))
    return {
        "TEX16": {"width": 16, "height": 16, "rgba8_hex": "".join(f"{v:02x}" for t in tex16 for v in t)},
        "TEX9": {"width": 12, "height": 12, "rgba8_hex": "".join(f"{v:02x}" for t in tex9 for v in t)},
    }


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def build_steps(op_lists):
    state = copy.deepcopy(INITIAL)
    recorded = {}
    steps = []
    for step in range(LAST_STEP + 1):
        redraws = []
        if step == 0:
            redraws = list(CREATION_ORDER)
        else:
            for item, prop, value in TIMELINE.get(step, []):
                state[prop] = value
                if prop in REDRAWN_BY and REDRAWN_BY[prop] not in redraws:
                    redraws.append(REDRAWN_BY[prop])
            redraws.append("Marker")
        calls = {}
        for name in redraws:
            drawer = item_marker(step) if name == "Marker" else DRAWERS[name]
            item_calls, item_ops = drawer(state)
            # Ops lists live once in `op_lists`, keyed by item and the step that recorded them.
            recorded[name] = f"{name}@{step}"
            op_lists[recorded[name]] = item_ops
            calls.setdefault(REGION_OF[name], []).extend({"item": name, **c} for c in item_calls)
        cx, cy = state["canvas"]
        items = []
        for name in CREATION_ORDER:
            px, py = POSITION[name]
            if name == "STC":
                px, py = px + POSITION["ST"][0], py + POSITION["ST"][1]
            if name == "CG":
                px, py = px + state["cg_offset"][0], py + state["cg_offset"][1]
            ox, oy = px + cx, py + cy
            clip = [ox, oy, ox + CG_SIZE[0], oy + CG_SIZE[1]] if name == "CG" else None
            items.append({"name": name, "region": REGION_OF[name], "xform": [1, 0, 0, 1, ox, oy], "clip_px": clip, "ops": recorded[name]})
        steps.append(
            {
                "step": step,
                "applied_frame": frame_of(step),
                "settle_frame": frame_of(step, True),
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, cx, cy],
                "redraws": redraws,
                "calls": calls,
                "items": items,
            }
        )
    # Freshness: a region is fresh when its modelled content differs from the previous step's.
    for k, s in enumerate(steps):
        fresh = {}
        for region in REGIONS:
            if k == 0:
                fresh[region] = True
                continue
            def content(items):
                return [{**i, "ops": op_lists[i["ops"]]} for i in items if i["region"] == region]

            fresh[region] = content(s["items"]) != content(steps[k - 1]["items"])
        s["fresh"] = fresh
    return steps


# --------------------------------------------------------------------------------------------
# Self-consistency (the colour rule, regions, tie-freeness, the census)
# --------------------------------------------------------------------------------------------


def walk_shapes(item, op_lists):
    """(shape, canvas-space transform, scissor) for every shape of an item (D9: the draw transform
    is replaced; D10: clip-ignore drops the item's scissor)."""
    draw = [1, 0, 0, 1, 0, 0]
    ignore = False
    for op in op_lists[item["ops"]]:
        if op.get("op") == "set_transform":
            draw = op["transform"]
            continue
        if op.get("op") == "clip_ignore":
            ignore = op["ignore"]
            continue
        if "kind" in op:
            yield op, compose(item["xform"], draw), item["clip_px"] if not ignore else None


def compose(a, b):
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]


def apply(m, p):
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def shape_points(shape):
    if shape["kind"] == "mesh":
        return shape["vertices"]
    if shape["kind"] == "thin_line":
        return [shape["from"], shape["to"]]
    x, y, w, h = shape["rect"]
    return [(x, y), (x + w, y + h)]


def weld(vertices, tol=1e-3):
    """Each vertex index to the first index at the same position (a closed strip repeats its
    first pair through a different float path, rcc:1166-1205; the fan repeats vertex 0 as 64)."""
    out = []
    for i, v in enumerate(vertices):
        out.append(next(j for j in range(i + 1) if abs(vertices[j][0] - v[0]) <= tol and abs(vertices[j][1] - v[1]) <= tol))
    return out


def boundary_edges(shape):
    """Edges used by exactly one non-degenerate triangle, after welding (Q6c: edges between
    triangles of one shape are not boundaries)."""
    w = weld(shape["vertices"])
    count = {}
    for raw in shape["triangles"]:
        tri = [w[i] for i in raw]
        if len(set(tri)) < 3:
            continue
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (min(a, b), max(a, b))
            count[key] = count.get(key, 0) + 1
    return [k for k, n in count.items() if n == 1]


def check(steps, op_lists):
    on_grid = lambda v: any(abs(v - g) < 1e-6 for g in GRID)  # noqa: E731
    names = list(REGIONS)
    for i, a in enumerate(names):
        ra = REGIONS[a]
        assert 0 <= ra[0] < ra[2] <= VIEWPORT[0] and 0 <= ra[1] < ra[3] <= VIEWPORT[1], a
        for b in names[i + 1 :]:
            rb = REGIONS[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
    tie_checked = 0
    for s in steps:
        for item in s["items"]:
            region = REGIONS[item["region"]] if item["name"] != "Marker" else REGIONS["Marker"]
            if item["clip_px"] is not None:
                c = item["clip_px"]
                assert region[0] <= c[0] < c[2] <= region[2] and region[1] <= c[1] < c[3] <= region[3], (s["step"], item["name"], c)
            for shape, m, clip in walk_shapes(item, op_lists):
                cols = shape.get("colors", []) + ([shape["modulate"]] if "modulate" in shape else [])
                for c in cols:
                    assert all(on_grid(f32(v)) or on_grid(round(v, 3)) for v in c[:3]), (shape["name"], c)
                    alpha_ok = abs(c[3] - 1) < 1e-6 or (shape["name"] == "T" and abs(c[3] - 0.6) < 1e-3)
                    assert alpha_ok, (shape["name"], c)
                pad = shape.get("band_px", 0)
                for p in [] if clip is not None else shape_points(shape):
                    x, y = apply(m, p)
                    assert region[0] <= x - pad and x + pad <= region[2] and region[1] <= y - pad and y + pad <= region[3], (s["step"], item["name"], shape["name"], (x, y), region)
                if shape["kind"] != "mesh" or "band_px" in shape:
                    continue
                verts = [apply(m, v) for v in shape["vertices"]]
                for a, b in boundary_edges(shape):
                    (x0, y0), (x1, y1) = verts[a], verts[b]
                    if x0 == x1 or y0 == y1:
                        continue
                    if all(v == int(v) for v in (x0, y0, x1, y1)):
                        tie_checked += 1
                        assert (abs(x1 - x0) + abs(y1 - y0)) % 2 == 1, f"step {s['step']} {shape['name']}: edge {verts[a]}-{verts[b]} is not tie-free"
    calls_by_op = {}
    for s in steps:
        for region_calls in s["calls"].values():
            for c in region_calls:
                calls_by_op[c["op"]] = calls_by_op.get(c["op"], 0) + 1
    assert calls_by_op == HAND_CENSUS, f"census {calls_by_op} != hand {HAND_CENSUS}"
    # Q6b's freshness rows: the redraws that change pixels, the moves, the canvas transform.
    fresh_hand = {1: {"LN"}, 2: {"PG"}, 3: {"PL"}, 4: {"PR"}, 5: {"ST"}, 6: {"CI"}, 7: {"CG"}, 8: {"LN"}, 9: set(REGIONS)}
    for k, want in fresh_hand.items():
        got = {r for r, f in steps[k]["fresh"].items() if f}
        assert got == want | {"Marker"}, f"step {k}: fresh {sorted(got)} != hand {sorted(want)}"
    return calls_by_op, tie_checked


# --------------------------------------------------------------------------------------------
# Lowering predictions (D12 (5)) and sabotage predictions (G5d)
# --------------------------------------------------------------------------------------------


def lowering_predictions(steps):
    s0 = steps[0]
    l2 = s0["calls"]["L2"][0]
    p = {
        "L2": {"op": "canvas_item_add_triangle_array", "vertices": len(l2["points"]), "indices": len(l2["indices"]), "colors": 1, "uvs": 0, "count": -1},
        "L5": {"op": "canvas_item_add_multiline", "points": len(s0["calls"]["LN"][4]["points"]), "colors": 1},
        "P2": {"op": "canvas_item_add_polyline", "points": 5, "colors": 1},
        "C3": {"op": "canvas_item_add_polyline", "points": 65, "colors": 1},
    }
    # Hand values (Q1a, Q6b): Line2D sharp, no caps -> strip_begin + one quad per point after the
    # first = 6 vertices, 12 indices; the dashed line has 8 dashes.
    assert p["L2"]["vertices"] == 6 and p["L2"]["indices"] == 12, p["L2"]
    assert p["L5"]["points"] == 16, p["L5"]
    return p


GEOMETRY_OPS = {"canvas_item_add_line", "canvas_item_add_polyline", "canvas_item_add_multiline", "canvas_item_add_primitive", "canvas_item_add_polygon", "canvas_item_add_triangle_array"}


def predictions(steps):
    regions = [r for r in REGIONS if r != "Marker"]

    def mismatch_from(first_step):
        return list(range(first_step, LAST_STEP + 1)) if first_step is not None else []

    def first_redraw(region, from_frame, ops):
        for s in steps:
            if s["applied_frame"] < from_frame:
                continue
            if any(c["op"] in ops for c in s["calls"].get(region, [])):
                return s["step"]
        return None

    perturb = {}
    for r in regions:
        k = first_redraw(r, S + N * 2, GEOMETRY_OPS)
        if k is not None:
            perturb[r] = mismatch_from(k)
    omit = {}
    for r in regions:
        k = first_redraw(r, S + N * 2, {"canvas_item_add_polygon"})
        if k is not None:
            omit[r] = mismatch_from(k)
    out = {
        "sabotage-freeze": {"frame": S + N, "steps": list(range(1, LAST_STEP + 1))},
        "sabotage-perturb-vertex": {"frame": S + N * 2, "regions": perturb},
        "sabotage-omit-polygon": {"frame": S + N * 2, "op": "canvas_item_add_polygon", "regions": omit},
        "sabotage-receiver-ignore-set-transform": {"regions": {"ST": list(range(LAST_STEP + 1))}},
        "sabotage-receiver-ignore-clip-ignore": {"regions": {"CG": list(range(LAST_STEP + 1))}},
    }
    # Q6b's hand sets.
    assert perturb == {"LN": [8, 9], "PL": list(range(3, 10)), "PG": list(range(2, 10)), "PR": list(range(4, 10)), "CI": list(range(6, 10)), "L2": list(range(3, 10))}, perturb
    assert omit == {"PG": list(range(2, 10))}, omit
    return out


def build():
    op_lists = {}
    steps = build_steps(op_lists)
    calls_by_op, tie_checked = check(steps, op_lists)
    return {
        "schema": "render-stream-gate5-expected/1",
        "fixture": "gate5",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        "regions": REGIONS,
        "marker_rect": [592, 16, 32, 32],
        "exact_edge_px": 1 / 16,
        "aa_band_px": AA_BAND_PX,
        "thin_band_px": THIN_BAND_PX,
        "textures": texture_table(),
        "engine_textures": ENGINE_TEXTURES,
        "hook_census": dict(sorted(calls_by_op.items())),
        "typed_ops": TYPED_OPS,
        "calibrator7_ops": CALIBRATOR7_OPS,
        "tie_free_edges_checked": tie_checked,
        "lowering_predictions": lowering_predictions(steps),
        "op_lists": op_lists,
        "steps": steps,
        "predictions": predictions(steps),
    }


def render(data):
    """Indented JSON with each item's small tables on one line."""

    def emit(value, indent):
        pad = "  " * indent
        if isinstance(value, dict) and indent < 4:
            items = [f"{pad}  {json.dumps(k)}: {emit(v, indent + 1)}" for k, v in value.items()]
            return "{\n" + ",\n".join(items) + "\n" + pad + "}" if items else "{}"
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value) and indent < 4:
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
