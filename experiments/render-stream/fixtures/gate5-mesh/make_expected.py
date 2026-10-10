#!/usr/bin/env python3
"""Write fixtures/gate5-mesh/expected.json (render-stream-gate5-mesh-expected/1) and ld_mesh.tres.

Every number below is derived from the fixture's own parameters and the engine's mesh rules as
read from the source (protocol/gate5-design.md Q1d-Q1f, Q6d), written down as code. Nothing here
runs or reads the engine: the capture's hook log, the reference's mesh oracle and the rendered
reference have to agree with it, and a disagreement is a finding to explain from the source, never
a number to copy.

    python3 experiments/render-stream/fixtures/gate5-mesh/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate5-mesh/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `rs` is servers/rendering_server.cpp,
`gles3m` drivers/gles3/storage/mesh_storage.cpp):

- Surfaces. `mesh_create_surface_data_from_arrays` (rs:1174-1388) packs a 2D surface as float32
  x, y per vertex (stride 8), an attribute buffer of RGBA8 colour, truncated `uint8(c * 255)`, then
  float32 UV (stride 12 with both, rs:706-746 and the offsets of rs:1050-1172), u16 indices while
  vertex_count <= 65536 (rs:892-916), the AABB `Rect2(v0, CMP_EPSILON)` expanded by every vertex in
  float32 (rs:426-449), uv_scale zero, and the format bits of the arrays given plus
  ARRAY_FLAG_USE_2D_VERTICES and ARRAY_FLAG_FORMAT_VERSION_2 (rs:1196, :1270-1271). GLES3 keeps
  every buffer as given, region updates overwrite bytes in place and never touch the AABB
  (gles3m:107-252, :536-594), and `mesh_get_surface` reads the buffers back (gles3m:614-669). Each
  surface's GRM1 payload (protocol/render-stream-4.md, capture/src/rs_mesh_payload.cpp) and its
  SHA-256 follow, so the oracle's readback hash and the hook's hash are both predicted here.
- Polygon2D. Per redraw `mesh_clear` then one `mesh_add_surface` of its points, one colour per
  vertex and the indices of `Geometry2D::triangulate_polygon` (scene/2d/polygon_2d.cpp:109-407),
  ported below from core/math/triangulate.cpp so its index buffer, and so its hash, are predicted.
- ArrayMesh. `add_surface_from_arrays` creates the RS mesh lazily (`mesh_create`) and adds a
  surface; `surface_update_vertex_region` and `add_surface` emit `changed`, which redraws a
  MeshInstance2D; `clear_surfaces` is a bare `mesh_clear` that emits nothing
  (scene/resources/mesh.cpp:1576-1583, :1781-1838, :1977-2023). A loaded ArrayMesh resource goes
  through `_set_surfaces` -> `mesh_create_from_surfaces` (:1585-1691).
- DF, the geoclip-like mesh, follows spine-godot's draw path (README "spine-godot's draw path"):
  built (`mesh_create` + `mesh_add_surface`, USE_DYNAMIC_UPDATE) on frame 1 and rebuilt on step 5's
  frame (`free` first); on every other frame `update_vertex_region`, `update_attribute_region` and
  `mesh_set_custom_aabb`, then the item redraws (`canvas_item_clear` + `canvas_item_add_mesh`).
- Freshness. A region is fresh at a step exactly when its modelled pixels change.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")
TRES = os.path.join(HERE, "ld_mesh.tres")

S, N, SETTLE = 1, 10, 7
LAST_STEP = 9
QUIT = S + N * LAST_STEP + SETTLE + 4
CAPTURE_QUIT = 400
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
GRID = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}
CMP_EPSILON = 0.00001

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

# Q6d's regions, [x0, y0, x1, y1).
REGIONS = {
    "MI": [24, 24, 144, 112],
    "RM": [160, 24, 256, 112],
    "M2": [272, 24, 368, 112],
    "DF": [384, 24, 544, 124],
    "P2": [24, 144, 144, 232],
    "LD": [160, 144, 256, 232],
    "FR": [272, 144, 368, 232],
    "Marker": [584, 8, 632, 56],
}
# DF's texture mapping is non-affine once deformed (D13): band, compared leg to leg only.
BAND_REGIONS = ["DF"]
# Wire item ids: canvas_item_create order in gate5_mesh.gd _ready.
CREATION_ORDER = ["MI", "RM", "M2", "DF", "P2", "LD", "FR", "Marker"]
POSITION = {
    "MI": (40, 40),
    "RM": (176, 40),
    "M2": (288, 40),
    "DF": (400, 40),
    "P2": (40, 160),
    "LD": (176, 160),
    "FR": (288, 160),
    "Marker": (592, 16),
}
# Mesh wire ids (the hook log's own counter): creation order, DF2 at step 5's frame.
MESH_ORDER = ["AM1", "RMS", "M2", "DF", "P2", "LD", "FM", "DF2"]
MESH_ITEM = {"AM1": "MI", "RMS": "RM", "M2": "M2", "DF": "DF", "P2": "P2", "LD": "LD", "FM": "FR", "DF2": "DF"}

# Q6a's TEXG: 32x16 RGBA8, a checker of 4x4-texel cells (gate5_mesh.gd TEXG_COLOURS).
TEXG_SIZE = (32, 16)
TEXG_COLOURS = [[1, 0.8, 0.4, 1], [0.4, 0.2, 0.6, 1]]

# Format bits (servers/rendering_server.h:311-352).
ARRAY_FORMAT_VERTEX = 1 << 0
ARRAY_FORMAT_COLOR = 1 << 3
ARRAY_FORMAT_TEX_UV = 1 << 4
ARRAY_FORMAT_INDEX = 1 << 12
ARRAY_FLAG_USE_2D_VERTICES = 1 << 25
ARRAY_FLAG_USE_DYNAMIC_UPDATE = 1 << 26
ARRAY_FLAG_FORMAT_VERSION_2 = 1 << 35
PRIMITIVE_TRIANGLES = 3

# The fixture's geometry (gate5_mesh.gd), local to each item.
AM1_COLOUR = [1, 0.6, 0, 1]
AM1_QUAD = [(0, 0), (64, 0), (64, 48), (0, 48)]
AM1_QUAD_STEP1 = [(8, 0), (72, 0), (72, 48), (8, 48)]
AM1_STEP8 = [(8, 0), (56, 0), (8, 47), (24, 56), (72, 56), (72, 9)]
AM1_STEP8_COLOUR = [0.2, 0.6, 1, 1]
QUAD_INDICES = [0, 1, 2, 0, 2, 3]
RMS_QUAD = [(0, 0), (64, 0), (64, 47), (0, 47)]
RMS_QUAD_STEP2 = [(8, 4), (56, 4), (56, 43), (8, 43)]
RMS_COLOUR = [0.2, 0.8, 0.4, 1]
RMS_COLOUR_STEP3 = [1, 0.2, 0.2, 1]
RMS_INDICES_STEP4 = [0, 1, 2, 0, 0, 0]
M2_SQUARE = [(0, 0), (32, 0), (32, 32), (0, 32)]
M2_SQUARE_COLOUR = [1, 1, 1, 1]
M2_TRIANGLE = [(40, 8), (64, 8), (40, 41)]
M2_TRIANGLE_COLOUR = [0.4, 0.4, 1, 1]
DF_W = [0, 1, 2, 1, 0, -1, -2, -1]
DF_SIZE = (128, 64)
DF_GRID = (9, 5)
DF2_GRID = (5, 3)
DF_COLOUR = [1, 1, 1, 1]
DF_COLOUR_STEP3 = [0.8, 0.8, 1, 1]
P2_COLOUR = [0.6, 0.2, 1, 1]
P2_POLYGON = [(0, 8), (32, 8), (32, 0), (56, 17), (32, 34), (32, 25), (0, 25)]
P2_POLYGON_STEP7 = [(0, 8), (32, 8), (32, 0), (72, 21), (32, 42), (32, 33), (0, 33)]
LD_QUAD = [(0, 0), (48, 0), (48, 40), (0, 40)]
LD_COLOUR = [0.8, 0.8, 0.2, 1]
FM_QUAD = [(0, 0), (56, 0), (56, 48), (0, 48)]
FM_COLOUR = [1, 0.4, 0.6, 1]

# Q6d's timeline, by step (gate5_mesh.gd _apply_step).
STEP_CHANGES = {
    1: "AM1.surface_update_vertex_region: quad +8 px in x (MeshInstance2D redraws on `changed`)",
    2: "raw mesh_surface_update_vertex_region(RMS): new positions (no redraw)",
    3: "raw mesh_surface_update_attribute_region(RMS): colour (1,.2,.2); DF's colours -> (.8,.8,1)",
    4: "raw mesh_surface_update_index_region(RMS): the second triangle degenerate",
    5: "DF recreated: 5x3 grid, free + mesh_create + mesh_add_surface",
    6: "raw mesh_surface_remove(M2, 0)",
    7: "free(FM) with FR not cleared; P2.polygon changed (clear + add on the same mesh)",
    8: "canvas_item_clear(FR); AM1.clear_surfaces() + add_surface_from_arrays (6 vertices)",
    9: "canvas_transform = Transform2D(0, (8, 4))",
}


# --------------------------------------------------------------------------------------------
# float32, bytes and the GRM1 payload
# --------------------------------------------------------------------------------------------


def f32(x):
    return struct.unpack("<f", struct.pack("<f", float(x)))[0]


def unorm8(c):
    """uint8(CLAMP(c * 255.0, 0, 255)) on the float32 component (rs:706-722): truncation."""
    return [int(min(255.0, max(0.0, f32(v) * 255.0))) for v in c]


def surface_aabb(points):
    """Rect2(v0, SMALL_VEC2) expanded by every vertex, in float32 (rs:426-449), as an AABB."""
    px, py = f32(points[0][0]), f32(points[0][1])
    sx, sy = f32(CMP_EPSILON), f32(CMP_EPSILON)
    for x, y in points[1:]:
        x, y = f32(x), f32(y)
        bx, by = px, py
        ex, ey = f32(px + sx), f32(py + sy)
        bx, by = min(bx, x), min(by, y)
        ex, ey = max(ex, x), max(ey, y)
        px, py = bx, by
        sx, sy = f32(ex - bx), f32(ey - by)
    return [px, py, 0.0, sx, sy, 0.0]


def build_surface(points, colours, uvs=None, indices=None, dynamic=False):
    """mesh_create_surface_data_from_arrays for a 2D triangle surface: (meta fields, buffers)."""
    n = len(points)
    fmt = ARRAY_FORMAT_VERTEX | ARRAY_FORMAT_COLOR | ARRAY_FLAG_USE_2D_VERTICES | ARRAY_FLAG_FORMAT_VERSION_2
    if uvs is not None:
        fmt |= ARRAY_FORMAT_TEX_UV
    if indices is not None:
        fmt |= ARRAY_FORMAT_INDEX
    if dynamic:
        fmt |= ARRAY_FLAG_USE_DYNAMIC_UPDATE
    assert len(colours) == n and (uvs is None or len(uvs) == n)
    return {
        "primitive": PRIMITIVE_TRIANGLES,
        "format": fmt,
        "vertex_count": n,
        "index_count": len(indices) if indices is not None else 0,
        "aabb": surface_aabb(points),
        "uv_scale": [0.0, 0.0, 0.0, 0.0],
        "vertex": vertex_bytes(points),
        "attribute": attribute_bytes(colours, uvs),
        "skin": b"",
        "index": index_bytes(indices, n) if indices is not None else b"",
    }


def vertex_bytes(points):
    return b"".join(struct.pack("<ff", f32(x), f32(y)) for x, y in points)


def attribute_bytes(colours, uvs=None):
    out = b""
    for i, c in enumerate(colours):
        out += bytes(unorm8(c))
        if uvs is not None:
            out += struct.pack("<ff", f32(uvs[i][0]), f32(uvs[i][1]))
    return out


def index_bytes(indices, vertex_count):
    assert vertex_count <= 65536
    return b"".join(struct.pack("<H", i) for i in indices)


PRIMITIVE_NAMES = ["points", "lines", "line_strip", "triangles", "triangle_strip"]


def grm1(s):
    """The render-stream-mesh/1 payload of a surface (protocol/render-stream-4.md)."""
    meta = (
        '{"type":"mesh-surface","primitive":"%s","format":%d,"vertex_count":%d,"index_count":%d,'
        '"vertex_bytes":%d,"attribute_bytes":%d,"skin_bytes":%d,"index_bytes":%d}'
        % (PRIMITIVE_NAMES[s["primitive"]], s["format"], s["vertex_count"], s["index_count"], len(s["vertex"]), len(s["attribute"]), len(s["skin"]), len(s["index"]))
    ).encode()
    geometry = struct.pack("<10f", *s["aabb"], *s["uv_scale"])
    return b"GRM1\r\n\x1a\n" + struct.pack("<I", len(meta)) + meta + geometry + s["vertex"] + s["attribute"] + s["skin"] + s["index"]


def surface_view(s):
    """What the oracle reports of a surface, the predicted hash included."""
    return {
        "primitive": PRIMITIVE_NAMES[s["primitive"]],
        "format": s["format"],
        "vertex_count": s["vertex_count"],
        "index_count": s["index_count"],
        "sha256": hashlib.sha256(grm1(s)).hexdigest(),
    }


# --------------------------------------------------------------------------------------------
# Godot's triangulation (core/math/triangulate.cpp), for Polygon2D's index buffer
# --------------------------------------------------------------------------------------------


def godot_triangulate(contour):
    """Triangulate::triangulate, line for line (real_t is float; integer inputs stay exact)."""
    n = len(contour)
    area = 0.0
    p = n - 1
    for q in range(n):
        area += contour[p][0] * contour[q][1] - contour[p][1] * contour[q][0]
        p = q
    V = list(range(n)) if 0.0 < area * 0.5 else [(n - 1) - v for v in range(n)]

    def inside(A, B, C, P, include_edges):
        ax, ay = C[0] - B[0], C[1] - B[1]
        bx, by = A[0] - C[0], A[1] - C[1]
        cx, cy = B[0] - A[0], B[1] - A[1]
        apx, apy = P[0] - A[0], P[1] - A[1]
        bpx, bpy = P[0] - B[0], P[1] - B[1]
        cpx, cpy = P[0] - C[0], P[1] - C[1]
        a = ax * bpy - ay * bpx
        c = cx * apy - cy * apx
        b = bx * cpy - by * cpx
        if include_edges:
            return a > 0 and b > 0 and c > 0
        return a >= 0 and b >= 0 and c >= 0

    def snip(u, v, w, nv, relaxed):
        A, B, C = contour[V[u]], contour[V[v]], contour[V[w]]
        threshold = -CMP_EPSILON if relaxed else CMP_EPSILON
        if threshold > (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]):
            return False
        for k in range(nv):
            if k in (u, v, w):
                continue
            if inside(A, B, C, contour[V[k]], relaxed):
                return False
        return True

    result = []
    relaxed = False
    nv = n
    count = 2 * nv
    v = nv - 1
    while nv > 2:
        if 0 >= count:
            assert not relaxed, "triangulate: bad polygon"
            count = 2 * nv
            relaxed = True
        count -= 1
        u = v
        if nv <= u:
            u = 0
        v = u + 1
        if nv <= v:
            v = 0
        w = v + 1
        if nv <= w:
            w = 0
        if snip(u, v, w, nv, relaxed):
            result += [V[u], V[v], V[w]]
            del V[v]
            nv -= 1
            count = 2 * nv
    return result


# --------------------------------------------------------------------------------------------
# The fixture's meshes, frame by frame
# --------------------------------------------------------------------------------------------


def df_displacement(frame, columns):
    return [DF_W[(frame + c) % 8] for c in range(columns)]


def df_points(frame, grid):
    cols, rows = grid
    d = df_displacement(frame, cols)
    dx, dy = DF_SIZE[0] / (cols - 1), DF_SIZE[1] / (rows - 1)
    return [(dx * i, dy * j + d[i]) for j in range(rows) for i in range(cols)]


def df_uvs(grid):
    cols, rows = grid
    return [(i / (cols - 1), j / (rows - 1)) for j in range(rows) for i in range(cols)]


def df_indices(grid):
    cols, rows = grid
    out = []
    for j in range(rows - 1):
        for i in range(cols - 1):
            a, b = j * cols + i, j * cols + i + 1
            c, d = b + cols, a + cols
            out += [a, b, c, a, c, d]
    return out


def df_custom_aabb(frame, grid):
    d = df_displacement(frame, grid[0])
    lo, hi = min(d), DF_SIZE[1] + max(d)
    return [0.0, float(lo), 0.0, float(DF_SIZE[0]), float(hi - lo), 0.0]


def df_surface(created_frame, frame, grid, colour):
    """DF's surface at `frame`: created (AABB fixed) at `created_frame`, its vertex and attribute
    buffers rewritten whole on every later frame (D8: region updates never move the AABB)."""
    n = grid[0] * grid[1]
    s = build_surface(df_points(created_frame, grid), [colour] * n, df_uvs(grid), df_indices(grid), dynamic=True)
    s["vertex"] = vertex_bytes(df_points(frame, grid))
    s["attribute"] = attribute_bytes([colour] * n, df_uvs(grid))
    return s


def mesh_state(step, frame):
    """Every fixture mesh at the end of `frame` (a settle frame of `step`): status, surfaces (the
    full byte model) and custom AABB, by Q6d's timeline."""
    st = {}
    am1 = build_surface(AM1_QUAD, [AM1_COLOUR] * 4, indices=QUAD_INDICES)
    if step >= 1:
        am1["vertex"] = vertex_bytes(AM1_QUAD_STEP1)
    if step >= 8:
        am1 = build_surface(AM1_STEP8, [AM1_STEP8_COLOUR] * 6)
    st["AM1"] = [am1]
    rms = build_surface(RMS_QUAD, [RMS_COLOUR] * 4, indices=QUAD_INDICES, dynamic=True)
    if step >= 2:
        rms["vertex"] = vertex_bytes(RMS_QUAD_STEP2)
    if step >= 3:
        rms["attribute"] = attribute_bytes([RMS_COLOUR_STEP3] * 4)
    if step >= 4:
        rms["index"] = index_bytes(RMS_INDICES_STEP4, 4)
    st["RMS"] = [rms]
    square = build_surface(M2_SQUARE, [M2_SQUARE_COLOUR] * 4, indices=QUAD_INDICES)
    triangle = build_surface(M2_TRIANGLE, [M2_TRIANGLE_COLOUR] * 3)
    st["M2"] = [triangle] if step >= 6 else [square, triangle]
    colour = DF_COLOUR_STEP3 if step >= 3 else DF_COLOUR
    if step < 5:
        st["DF"] = [df_surface(S, frame, DF_GRID, colour)]
        st["DF2"] = None
    else:
        st["DF"] = "freed"
        st["DF2"] = [df_surface(rebuild_frame(), frame, DF2_GRID, colour)]
    polygon = P2_POLYGON_STEP7 if step >= 7 else P2_POLYGON
    st["P2"] = [build_surface(polygon, [P2_COLOUR] * len(polygon), indices=godot_triangulate(polygon))]
    st["LD"] = [ld_surface()]
    st["FM"] = "freed" if step >= 7 else [build_surface(FM_QUAD, [FM_COLOUR] * 4, indices=QUAD_INDICES)]
    custom = {name: [0.0] * 6 for name in MESH_ORDER}
    custom["DF"] = df_custom_aabb(frame, DF_GRID) if frame >= S + 1 else [0.0] * 6
    custom["DF2"] = df_custom_aabb(frame, DF2_GRID) if step >= 5 and frame > rebuild_frame() else [0.0] * 6
    return st, custom


def ld_surface():
    return build_surface(LD_QUAD, [LD_COLOUR] * 4, indices=QUAD_INDICES)


def rebuild_frame():
    return S + N * 5


def oracle_view(step, frame):
    st, custom = mesh_state(step, frame)
    out = []
    for name in MESH_ORDER:
        surfaces = st[name]
        if surfaces is None:
            out.append({"name": name, "status": "absent"})
        elif surfaces == "freed":
            out.append({"name": name, "status": "freed"})
        else:
            out.append({"name": name, "status": "live", "surface_count": len(surfaces), "custom_aabb": custom[name], "surfaces": [surface_view(s) for s in surfaces]})
    return out


# --------------------------------------------------------------------------------------------
# The hook census (Q6d): every mesh call, per frame, from the fixture script
# --------------------------------------------------------------------------------------------


def census():
    """Every mesh line the hook log must hold, frame by frame, except DF's per-frame updates, which
    are the rule in `df_rule`. Versions are the hook log's (gate5-design.md Q3b/Q3d: +1 per accepted
    mutating call). Lines are [mesh, op, version, surface|null, buffer|null]."""
    v = {name: 0 for name in MESH_ORDER}
    frames = {}

    def line(frame, mesh, op, surface=None, buffer=None):
        if op != "free":
            v[mesh] += 1
        frames.setdefault(str(frame), []).append([mesh, op, v[mesh], surface, buffer])

    f1 = 1
    # _ready, in gate5_mesh.gd order: AM1 (ArrayMesh: lazy mesh_create, then the surface), RMS, M2,
    # DF, P2 (Polygon2D's constructor), LD (the loaded resource), FM.
    line(f1, "AM1", "mesh_create")
    line(f1, "AM1", "mesh_add_surface", 0)
    line(f1, "RMS", "mesh_create")
    line(f1, "RMS", "mesh_add_surface", 0)
    line(f1, "M2", "mesh_create")
    line(f1, "M2", "mesh_add_surface", 0)
    line(f1, "M2", "mesh_add_surface", 1)
    line(f1, "DF", "mesh_create")
    line(f1, "DF", "mesh_add_surface", 0)
    line(f1, "P2", "mesh_create")
    line(f1, "LD", "mesh_create_from_surfaces", 0)
    line(f1, "FM", "mesh_create")
    line(f1, "FM", "mesh_add_surface", 0)
    # P2's first draw, at frame 1's flush.
    line(f1, "P2", "mesh_clear")
    line(f1, "P2", "mesh_add_surface", 0)

    def at(step):
        return S + N * step

    line(at(1), "AM1", "mesh_surface_update_vertex_region", 0, "vertex")
    line(at(2), "RMS", "mesh_surface_update_vertex_region", 0, "vertex")
    line(at(3), "RMS", "mesh_surface_update_attribute_region", 0, "attribute")
    line(at(4), "RMS", "mesh_surface_update_index_region", 0, "index")
    # Step 5: DF's per-frame updates up to frame 50 (3 per frame from frame 2) gave it version
    # 2 + 3 * 49; the rebuild frees it (its line carries that last version) and builds DF2.
    v["DF"] = 2 + 3 * (at(5) - 1 - S)
    line(at(5), "DF", "free")
    line(at(5), "DF2", "mesh_create")
    line(at(5), "DF2", "mesh_add_surface", 0)
    line(at(6), "M2", "mesh_surface_remove", 0)
    line(at(7), "FM", "free")
    line(at(7), "P2", "mesh_clear")
    line(at(7), "P2", "mesh_add_surface", 0)
    line(at(8), "AM1", "mesh_clear")
    line(at(8), "AM1", "mesh_add_surface", 0)
    df_rule = [
        {"mesh": "DF", "from_frame": S + 1, "to_frame": at(5) - 1, "base_version": 2},
        {"mesh": "DF2", "from_frame": at(5) + 1, "to_frame": None, "base_version": 2},
    ]
    return frames, df_rule


DF_FRAME_OPS = [["mesh_surface_update_vertex_region", "vertex"], ["mesh_surface_update_attribute_region", "attribute"], ["mesh_set_custom_aabb", None]]


def expand_census(frames, df_rule, quit_frame):
    """The full per-frame census up to `quit_frame` (the checker expands the same rule)."""
    out = {int(k): list(v) for k, v in frames.items()}
    for r in df_rule:
        last = r["to_frame"] if r["to_frame"] is not None else quit_frame
        for f in range(r["from_frame"], min(last, quit_frame) + 1):
            base = r["base_version"] + 3 * (f - r["from_frame"])
            for k, (op, buf) in enumerate(DF_FRAME_OPS):
                out.setdefault(f, []).append([r["mesh"], op, base + k + 1, 0 if buf else None, buf])
    return {f: out[f] for f in sorted(out) if f <= quit_frame}


# --------------------------------------------------------------------------------------------
# Coverage model (geometry-raster.ts), redraws, commands and freshness
# --------------------------------------------------------------------------------------------


def unpack_floats(b):
    return [list(struct.unpack_from("<ff", b, k)) for k in range(0, len(b), 8)]


def surface_shape(name, s, texture=None):
    """A mesh surface as a geometry-raster MeshShape: its own vertices and index buffer (or
    consecutive triples), its RGBA8 colours, its UVs."""
    pts = unpack_floats(s["vertex"])
    n = len(pts)
    stride = 12 if s["format"] & ARRAY_FORMAT_TEX_UV else 4
    cols, uvs = [], []
    for i in range(n):
        raw = s["attribute"][i * stride : i * stride + 4]
        cols.append([c / 255 for c in raw])
        if stride == 12:
            uvs.append(list(struct.unpack_from("<ff", s["attribute"], i * stride + 4)))
    if s["index_count"]:
        idx = [struct.unpack_from("<H", s["index"], k)[0] for k in range(0, len(s["index"]), 2)]
    else:
        idx = list(range(n))
    shape = {"name": name, "kind": "mesh", "vertices": pts, "triangles": [idx[k : k + 3] for k in range(0, len(idx), 3)]}
    shape["colors"] = [cols[0]] if all(c == cols[0] for c in cols) else cols
    if texture:
        shape["uvs"] = uvs
        shape["texture"] = texture
    return shape


def item_shapes(name, step, st):
    """The pixels each item's commands draw at a settle frame (Q1d: a command naming a freed mesh
    draws nothing; FR's commands are cleared at step 8)."""
    mesh = {"MI": "AM1", "RM": "RMS", "M2": "M2", "P2": "P2", "LD": "LD", "FR": "FM"}.get(name)
    if name == "DF":
        mesh = "DF2" if step >= 5 else "DF"
    if name == "Marker":
        x, y, w, h = 0, 0, 32, 32
        c = MARKER_COLOURS[step]
        return [{"name": "M", "kind": "mesh", "vertices": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], "triangles": [[0, 1, 2], [0, 2, 3]], "colors": [c]}]
    if name == "FR" and step >= 8:
        return []
    surfaces = st[mesh]
    if surfaces == "freed" or surfaces is None:
        return []
    texture = "TEXG" if name == "DF" else None
    return [surface_shape(f"{mesh}.s{k}", s, texture) for k, s in enumerate(surfaces)]


def item_commands(name, step):
    """Each item's recorded commands at a settle frame, as the RS calls that made them."""
    if name == "Marker":
        return [{"op": "canvas_item_add_rect", "rect": [0.0, 0.0, 32.0, 32.0], "color": [f32(v) for v in MARKER_COLOURS[step]], "antialiased": False}]
    if name == "FR" and step >= 8:
        return []
    return [{"op": "canvas_item_add_mesh"}]


def redraws(step):
    """The items whose `_draw` (or engine draw) runs on the step's applied frame, besides DF, which
    redraws every frame."""
    if step == 0:
        return list(CREATION_ORDER)
    out = {1: ["MI"], 7: ["P2"], 8: ["MI"]}.get(step, [])
    return out + ["Marker"]


def build_steps(op_lists):
    steps = []
    for step in range(LAST_STEP + 1):
        settle = S + N * step + SETTLE
        applied = 1 if step == 0 else S + N * step
        st, _ = mesh_state(step, settle)
        cx, cy = (8, 4) if step >= 9 else (0, 0)
        items = []
        commands = {}
        for name in CREATION_ORDER:
            key = f"{name}@{step}"
            op_lists[key] = item_shapes(name, step, st)
            px, py = POSITION[name]
            items.append({"name": name, "region": name, "xform": [1, 0, 0, 1, px + cx, py + cy], "clip_px": None, "ops": key})
            commands[name] = item_commands(name, step)
        steps.append(
            {
                "step": step,
                "applied_frame": applied,
                "settle_frame": settle,
                "change": STEP_CHANGES.get(step, "initial"),
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, cx, cy],
                "redraws": redraws(step),
                "commands": commands,
                "items": items,
                "meshes": oracle_view(step, settle),
            }
        )
    return steps


def mark_fresh(steps, op_lists):
    """A region is fresh when its modelled content (the transform and shapes of every item that draws
    anything) differs from the previous step's: an item that draws nothing does not move. Then
    deduplicate op lists that equal an earlier one of the same item."""
    for k, s in enumerate(steps):
        fresh = {}
        for region in REGIONS:
            if k == 0:
                fresh[region] = True
                continue

            def content(step):
                return [{"xform": i["xform"], "ops": op_lists[i["ops"]]} for i in step["items"] if i["region"] == region and op_lists[i["ops"]]]

            fresh[region] = content(s) != content(steps[k - 1])
        s["fresh"] = fresh
    # One op list per distinct content (items name the first step that recorded it).
    canon = {}
    for s in steps:
        for item in s["items"]:
            text = json.dumps(op_lists[item["ops"]], sort_keys=True)
            first = canon.setdefault((item["name"], text), item["ops"])
            if first != item["ops"]:
                del op_lists[item["ops"]]
                item["ops"] = first


# --------------------------------------------------------------------------------------------
# Self-consistency
# --------------------------------------------------------------------------------------------


def apply(m, p):
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def boundary_edges(vertices, triangles):
    count = {}
    for tri in triangles:
        if len(set(tri)) < 3:
            continue
        a, b, c = (vertices[i] for i in tri)
        if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) == 0:
            continue
        for e in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (min(e), max(e))
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
            region = REGIONS[item["region"]]
            for shape in op_lists[item["ops"]]:
                for c in shape["colors"]:
                    assert all(on_grid(round(v, 4)) for v in c), (shape["name"], c)
                    assert abs(c[3] - 1) < 1e-6, (shape["name"], c)
                verts = [apply(item["xform"], v) for v in shape["vertices"]]
                for x, y in verts:
                    assert region[0] <= x <= region[2] and region[1] <= y <= region[3], (s["step"], item["name"], shape["name"], (x, y), region)
                if item["region"] in BAND_REGIONS:
                    continue
                for a, b in boundary_edges(verts, shape["triangles"]):
                    (x0, y0), (x1, y1) = verts[a], verts[b]
                    if x0 == x1 or y0 == y1:
                        continue
                    assert all(v == int(v) for v in (x0, y0, x1, y1)), (shape["name"], verts[a], verts[b])
                    tie_checked += 1
                    assert (abs(x1 - x0) + abs(y1 - y0)) % 2 == 1, f"step {s['step']} {shape['name']}: edge {verts[a]}-{verts[b]} is not tie-free"
    # Q6d's freshness rows: RM at 2, 3, 4 (no redraw), M2 at 6, FR and P2 at 7, MI at 1 and 8, DF at
    # every step, everything that still draws at 9; FR's clear at 8 changes no pixel (its freed mesh
    # already draws nothing), and the canvas shift at 9 moves nothing in FR.
    fresh_hand = {1: {"MI"}, 2: {"RM"}, 3: {"RM"}, 4: {"RM"}, 5: set(), 6: {"M2"}, 7: {"FR", "P2"}, 8: {"MI"}, 9: set(REGIONS) - {"FR"}}
    for k, want in fresh_hand.items():
        got = {r for r, f in steps[k]["fresh"].items() if f}
        assert got == want | {"Marker", "DF"}, f"step {k}: fresh {sorted(got)} != hand {sorted(want)}"
    # Fresh without a redraw: RM's commands are recorded once.
    for k in (2, 3, 4):
        assert "RM" not in steps[k]["redraws"], k
    return tie_checked


def hand_census_check(frames, df_rule):
    """Q6d's step-0 row and per-step rows, typed in by hand, against census()."""
    f1 = frames["1"]
    ops = [ln[1] for ln in f1]
    assert ops.count("mesh_create") == 6 and ops.count("mesh_create_from_surfaces") == 1, ops
    assert ops.count("mesh_add_surface") == 7 and ops.count("mesh_clear") == 1, ops
    hand = {
        11: ["mesh_surface_update_vertex_region"],
        21: ["mesh_surface_update_vertex_region"],
        31: ["mesh_surface_update_attribute_region"],
        41: ["mesh_surface_update_index_region"],
        51: ["free", "mesh_create", "mesh_add_surface"],
        61: ["mesh_surface_remove"],
        71: ["free", "mesh_clear", "mesh_add_surface"],
        81: ["mesh_clear", "mesh_add_surface"],
    }
    got = {int(k): [ln[1] for ln in v] for k, v in frames.items() if k != "1"}
    assert got == hand, got
    full = expand_census(frames, df_rule, CAPTURE_QUIT)
    per_frame = {f: sum(1 for ln in lines if ln[0] in ("DF", "DF2")) for f, lines in full.items()}
    # Three DF lines on every frame from 2: its updates, or on the rebuild frame free, create, add.
    for f in range(2, CAPTURE_QUIT + 1):
        assert per_frame.get(f) == 3, (f, per_frame.get(f))
    # DF's versions: the free line carries its last per-frame version.
    last_df = [ln for ln in full[rebuild_frame() - 1] if ln[0] == "DF"][-1][2]
    free_df = [ln for ln in full[rebuild_frame()] if ln[0] == "DF" and ln[1] == "free"][0][2]
    assert last_df == free_df == 149, (last_df, free_df)


# --------------------------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------------------------


def texture_table():
    w, h = TEXG_SIZE
    texels = []
    for y in range(h):
        for x in range(w):
            texels.append([round(v * 255) for v in TEXG_COLOURS[((x // 4) + (y // 4)) % 2]])
    return {"TEXG": {"width": w, "height": h, "rgba8_hex": "".join(f"{v:02x}" for t in texels for v in t)}}


def tres_text():
    """ld_mesh.tres: the ArrayMesh resource LD loads (one quad, its surface dictionary written out
    as `_surfaces`, which `ArrayMesh::_set_surfaces` hands to mesh_create_from_surfaces)."""
    s = ld_surface()

    def pba(b):
        return "PackedByteArray(" + ", ".join(str(x) for x in b) + ")"

    a = s["aabb"]
    aabb = "AABB(" + ", ".join(f"{v:g}" for v in a) + ")"
    return (
        "; Generated by make_expected.py (gate5-design.md Q6d, LD): do not edit.\n"
        '[gd_resource type="ArrayMesh" format=3]\n\n'
        "[resource]\n"
        "_surfaces = [{\n"
        f'"aabb": {aabb},\n'
        f'"attribute_data": {pba(s["attribute"])},\n'
        f'"format": {s["format"]},\n'
        f'"index_count": {s["index_count"]},\n'
        f'"index_data": {pba(s["index"])},\n'
        f'"primitive": {s["primitive"]},\n'
        '"uv_scale": Vector4(0, 0, 0, 0),\n'
        f'"vertex_count": {s["vertex_count"]},\n'
        f'"vertex_data": {pba(s["vertex"])}\n'
        "}]\n"
    )


def build():
    op_lists = {}
    steps = build_steps(op_lists)
    mark_fresh(steps, op_lists)
    tie_checked = check(steps, op_lists)
    frames, df_rule = census()
    hand_census_check(frames, df_rule)
    return {
        "schema": "render-stream-gate5-mesh-expected/1",
        "fixture": "gate5-mesh",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "capture_quit_frame": CAPTURE_QUIT,
        "last_step": LAST_STEP,
        "creation_order": CREATION_ORDER,
        "regions": REGIONS,
        "band_regions": BAND_REGIONS,
        "marker_rect": [592, 16, 32, 32],
        "exact_edge_px": 1 / 16,
        "textures": texture_table(),
        "engine_textures": [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}],
        "mesh_order": MESH_ORDER,
        "mesh_items": MESH_ITEM,
        "typed_ops": ["canvas_item_add_mesh"],
        "draw_census": draw_census(),
        "tie_free_edges_checked": tie_checked,
        "census": {"frames": frames, "df_rule": df_rule, "df_frame_ops": DF_FRAME_OPS},
        "op_lists": op_lists,
        "steps": steps,
        "predictions": predictions(),
    }


def draw_census():
    """counters.json over a capture run that quits at CAPTURE_QUIT: one add_mesh per item draw (MI
    at 1, 11, 81; RM, M2, LD, FR once; P2 at 1 and 71; DF on every frame 1..quit), one
    attach_skeleton(RID()) per Polygon2D draw and one more from its destructor at teardown
    (scene/2d/polygon_2d.cpp:729-734; counters.json counts the whole armed session), one add_rect
    per marker draw."""
    return {
        "quit_frame": CAPTURE_QUIT,
        "counts": {
            "canvas_item_add_mesh": 3 + 1 + 1 + CAPTURE_QUIT + 2 + 1 + 1,
            "canvas_item_attach_skeleton": 2 + 1,
            "canvas_item_add_rect": LAST_STEP + 1,
            "mesh_create": 7,
            "mesh_create_from_surfaces": 1,
            "mesh_add_surface": 7 + 1 + 1 + 1,
            "mesh_clear": 3,
            "mesh_surface_remove": 1,
            "mesh_surface_update_index_region": 1,
            "mesh_surface_update_vertex_region": 2 + (CAPTURE_QUIT - 2),
            "mesh_surface_update_attribute_region": 1 + (CAPTURE_QUIT - 2),
            "mesh_set_custom_aabb": CAPTURE_QUIT - 2,
            "texture_2d_create": 2,
        },
    }


def predictions():
    """G5e's sabotage sets (Q6d), kept here so G5e inherits them from the same model."""
    return {
        "sabotage-mesh-freeze": {"frame": S + N, "steps": list(range(1, LAST_STEP + 1))},
        "sabotage-mesh-omit-vertex-region": {"frame": S + N * 2, "regions": {"RM": list(range(2, 10)), "DF": list(range(2, 10))}},
        "sabotage-mesh-perturb-vertex": {"frame": S + N * 2, "regions": {"RM": list(range(2, 10)), "DF": list(range(2, 10)), "P2": list(range(7, 10)), "MI": [8, 9]}},
        "sabotage-mesh-receiver-drop-surface": {"regions": {"M2": list(range(0, 6))}},
        "sabotage-mesh-receiver-stale": {"regions": {"MI": list(range(1, 8)), "RM": list(range(2, 10)), "DF": list(range(0, 10))}},
    }


def render(data):
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
    parser.add_argument("--check", action="store_true", help="compare with the committed files")
    args = parser.parse_args()
    text = render(build())
    tres = tres_text()
    if args.check:
        stale = False
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        if json.loads(current) != json.loads(text):
            sys.stdout.writelines(difflib.unified_diff(render(json.loads(current)).splitlines(True), text.splitlines(True), "expected.json", "generated"))
            print("make_expected.py: expected.json is stale", file=sys.stderr)
            stale = True
        with open(TRES, encoding="utf-8") as handle:
            if handle.read() != tres:
                print("make_expected.py: ld_mesh.tres is stale", file=sys.stderr)
                stale = True
        if stale:
            return 1
        print("expected.json and ld_mesh.tres are up to date")
        return 0
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    with open(TRES, "w", encoding="utf-8") as handle:
        handle.write(tres)
    print(f"wrote {OUT} and {TRES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
