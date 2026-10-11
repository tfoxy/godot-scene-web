#!/usr/bin/env python3
"""Write fixtures/gate6-scene/expected.json (render-stream-gate6-expected/1).

Every number below is derived from the fixture's own parameters (scene_builder.gd, gate6_scene.gd)
and the engine's drawing code as read from the source (protocol/gate6-design.md Q1, Q6), written
down as code. Nothing here runs or reads the engine: the rendered reference, the scene oracle and
the capture's hook log have to agree with it, and a disagreement is a finding to explain from the
source, never a number to copy. The three measured font metrics it needs (MEASURED_*) are named as
such and checked against the reference by the gate.

    python3 experiments/render-stream/fixtures/gate6-scene/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate6-scene/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `sbf` is scene/resources/style_box_flat.cpp,
`sc.cpp` scene/gui/scroll_container.cpp, `sb.cpp` scene/gui/scroll_bar.cpp, `le.cpp`
scene/gui/line_edit.cpp, `pb.cpp` scene/gui/progress_bar.cpp, `dt.cpp` scene/theme/default_theme.cpp):

- Time (D6, as built): every animation reads its value at (f + 1/4)/60 s at fixture frame f (the
  builder starts each clock a quarter frame in): SM's phase = floor((f mod 24)/4), AN's x =
  512 + ((f + 1/4) mod 88), PB's value = ((f + 1/4) mod 300)/3 snapped to ProgressBar's step 0.01
  (so PB redraws on every frame); MS's pose is f itself. Step 11 freezes them at phase 0, x 512,
  value 40 and pose 0.
- Layout. SC (sc.cpp:345-401, :596-623): the content VBox at (0, -v_scroll) floored; eight rows of
  24x20 rects + a 14 px Label (row height 20: the rect's minimum, MEASURED_ROW_LABEL_H <= 20),
  separation 4, so content 188 and max scroll 76; the VScrollBar at (160, 0) 8x112 (its minimum
  width is the scroll style's 4 + 4 margins, sb.cpp:484-505), drawing the scroll box over (0, 0,
  8, 112) and the grabber at y = 104 v/188 (sb.cpp:444-482: area 112 - 8, ratio v/max), height
  float(112/188) 104 + 8. HB's three expand-fill panels at 0, 136, 272 (128 + 8), then 0, 168, 336
  (160 + 8). PB's fill (pb.cpp:111-128): p = round(float(value/100) (168 - 4)), drawn 0..p+4 when
  p > 0.
- Draws. StyleBoxFlat through gate 5g's float32 port (fixtures/gate5-style/make_expected.py), the
  theme boxes from dt.cpp (make_flat_stylebox: Button and LineEdit normal (0.1,0.1,0.1,0.6) radius
  3 margins 4, LineEdit's 2 px bottom border (0,0,0,0.6), the focus box (1,1,1,0.75) border 2 expand
  2 no centre, ProgressBar background (0.1,0.1,0.1,0.3) and fill (1,1,1,0.4) radius 6, the
  VScrollBar's scroll (0.1,0.1,0.1,0.6) and grabber (1,1,1,0.4) radius 10); CD's line, polyline,
  circle and polygon through gate 5's lowering (fixtures/gate5/make_expected.py); textures sampled
  nearest; MS's strip from its vertex formula with per-vertex colours; SM's colour from its
  shader's Python twin; CM's blend from G55b's equations (geometry-raster.ts).
- Undecided (D7): every text run (labels, button and progress text, the LineEdit's content box,
  the HUD label), the RichTextLabel's whole rect and the refused variant's RF region. Their
  `content` fields describe what is drawn there for freshness and the sabotage predictions.
- Paint order: tree order in the root canvas, `TL` (top_level, draw index 1) after `Scene` (0),
  `ZH` (z 100) last; the HUD canvas after the root canvas at layer 1. At layer -1 (step 9) it is
  behind the root canvas and wholly under BG's opaque panel, so the model omits it.
- Regions: Q6b's table; at steps 10 and 11 the root canvas moves by (8, 4) and so do the regions
  (HU becomes the union of the moved ZH and the unmoved HUD panel).
"""

from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import importlib.util
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")
FIXTURES = os.path.dirname(HERE)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


g5 = _load("gate5_model", os.path.join(FIXTURES, "gate5", "make_expected.py"))
sty = _load("gate5_style_model", os.path.join(FIXTURES, "gate5-style", "make_expected.py"))
shd = _load("gate55_shader_model", os.path.join(FIXTURES, "gate55-shader", "make_expected.py"))

f32 = g5.f32
S, N, SETTLE = 1, 10, 7
LAST_STEP = 11
QUIT = S + N * LAST_STEP + SETTLE + 4
CAPTURE_QUIT = 400
MID_STEPS = [1, 5, 9]
MID_OFFSET = 2
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
GRID = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}
SHIFT = (8, 4)
TIME_OFFSET = 0.25

# Measured font metrics of the redistributable default theme font (OpenSans SemiBold, the engine's
# embedded default) at the sizes the scene uses; the gate's checks compare them with the reference.
MEASURED_RT_LINE_H = 23  # RichTextLabel line height at 16 px, regular and bold
MEASURED_ROW_LABEL_H = 20  # a 14 px Label's minimum height is at most the rect's 20
# An upper bound on a 16 px glyph advance of this font (for text boxes only).
TEXT_ADVANCE_BOUND = 14.4

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
    [51, 153, 51, 255],
    [255, 51, 255, 255],
]
MARKER_COLOURS = [[c / 255 for c in m[:3]] + [1] for m in MARKER]

# Q6b's regions, [x0, y0, x1, y1), for steps 0..9 (RF only in `refused`).
REGIONS = {
    "SC": [8, 8, 176, 120],
    "RT": [184, 8, 384, 120],
    "TR": [392, 8, 456, 72],
    "NP": [464, 8, 560, 72],
    "Marker": [592, 16, 624, 48],
    "HU": [400, 84, 624, 116],
    "PB": [8, 128, 176, 152],
    "BT": [8, 160, 128, 192],
    "LE": [4, 196, 180, 236],
    "CD": [184, 128, 304, 232],
    "MS": [312, 128, 416, 184],
    "SM": [424, 128, 488, 176],
    "CM": [496, 128, 560, 176],
    "HB": [8, 248, 504, 296],
    "AN": [512, 256, 632, 288],
    "LB": [8, 304, 328, 336],
    "TL": [600, 344, 616, 360],
}
RF_REGION = [344, 300, 632, 340]
# At steps 10 and 11 the root canvas moves; HU spans the moved ZH and the unmoved HUD panel.
HU_SHIFTED = [408, 88, 624, 120]
CLASS = {name: "exact" for name in REGIONS}
CLASS.update({"RT": "undecided", "LB": "undecided", "RF": "undecided"})

BG_COLOUR = [0.2, 0.2, 0.2, 1]
ROW_COLOURS = [[1, 0.4, 0.4, 1], [1, 0.8, 0.2, 1], [0.6, 1, 0.4, 1], [0.2, 0.8, 0.8, 1], [0.4, 0.6, 1, 1], [0.8, 0.4, 1, 1], [1, 0.6, 0.8, 1], [0.8, 0.8, 0.8, 1], [1, 1, 1, 1]]
ZH_COLOUR = [0.8, 0.2, 0.2, 1]
HUD_COLOUR = [0.2, 0.8, 0.8, 1]
TL_COLOUR = [1, 1, 0.6, 1]
SM_TINT = [1, 1, 0, 1]
SM_TINT_STEP4 = [1, 0, 1, 1]
CM_UNDER = [0.4, 0.6, 0.2, 1]
CM_OVER = [0.4, 0.2, 0.6, 1]
MS_TOP = [1, 0.8, 0.2, 1]
MS_BOTTOM = [0.2, 0.4, 1, 1]

TEXN_BORDER = [1, 1, 0.6, 1]
TEXN_MARK = [1, 0.4, 0.4, 1]
TEXN_A = [0.4, 0.2, 0.8, 1]
TEXN_B = [0.2, 0.8, 0.6, 1]
TEXA_PALETTE = [
    [1, 0.4, 0.2, 1], [0.2, 0.6, 1, 1], [0.8, 1, 0.2, 1], [0.6, 0.2, 0.8, 1],
    [1, 0.8, 0.6, 1], [0.2, 0.8, 0.4, 1], [0.4, 0.4, 0.8, 1], [1, 0.2, 0.6, 1],
    [0.6, 0.6, 0.2, 1], [0.2, 0.4, 0.4, 1], [0.8, 0.6, 1, 1], [0.4, 1, 0.8, 1],
    [1, 1, 0.4, 1], [0.6, 0.2, 0.2, 1], [0.2, 1, 1, 1], [0.8, 0.4, 0.6, 1],
]
TEXB_CONTENT = 1000

RT_LINES = ["RichText line 0", "bold line 1", None, "line 3", "line 4 plain", "line 5 bold", "line 6 plain", "line 7", "line 8 end"]
RT_LINES_STEP9 = ["RichText line 0", "bold line 1", "image removed", "line 3", "line 4 plain", "line 5 bold", "line 6 plain", "line 7", "line 8 end"]
RT_IMAGE_H = 64
RT_SIZE = (200, 112)
RT_SCROLL_LINE = 4

# The default theme boxes (dt.cpp), in gate 5g's StyleBoxFlat dictionary form.
THEME_NORMAL = sty.theme_flat([0.1, 0.1, 0.1, 0.6])
THEME_LINE_EDIT = dict(sty.theme_flat([0.1, 0.1, 0.1, 0.6]), border=[0, 0, 0, 2], border_color=[0, 0, 0, 0.6])
THEME_FOCUS = sty.THEME_FOCUS
THEME_PB_BG = sty.theme_flat([0.1, 0.1, 0.1, 0.3], corner_radius=6)
THEME_PB_FILL = sty.theme_flat([1, 1, 1, 0.4], corner_radius=6)
THEME_SCROLL = sty.theme_flat([0.1, 0.1, 0.1, 0.6], corner_radius=10)
THEME_GRABBER = sty.theme_flat([1, 1, 1, 0.4], corner_radius=10)
HB_BOXES = [
    sty.box(bg=[0.4, 0.8, 0.4, 1]),
    sty.box(bg=[0.2, 0.4, 0.8, 1], border_color=[1, 1, 0.6, 1], border=[4, 4, 4, 4]),
    sty.box(bg=[1, 0.4, 0.4, 1], corner=[8, 8, 8, 8]),
]
THEME_SHAPE_PREFIXES = ("SCROLLBAR", "PB.", "BT.", "LE.")

# Wire id order (canvas_item_create order, scene_builder.gd build()): a ScrollContainer's
# constructor makes its HScrollBar, VScrollBar and focus PanelContainer right after itself
# (sc.cpp:821-846), a RichTextLabel its VScrollBar (rich_text_label.cpp:8060-8061); TL is made
# while row 3 is.
CREATION_ORDER = ["Scene", "BG", "SC", "SC_HScroll", "SC_VScroll", "SC_Focus", "Rows"]
for _r in range(8):
    CREATION_ORDER += [f"Row{_r}", f"R{_r}", f"L{_r}"]
    if _r == 3:
        CREATION_ORDER.append("TL")
CREATION_ORDER += ["RT", "RT_VScroll", "TR", "NP", "Marker", "ZH", "PB", "BT", "LE", "CD", "MS", "SM", "CMU", "CMO", "HB", "HB0", "HB1", "HB2", "AN", "LB"]
REFUSED_ITEMS = ["RFParticles", "RFLight", "RFTime", "RFLcd"]
HUD_ITEMS = ["HUDPanel", "HUDLabel"]
CREATED_LATER = [{"name": "Row8", "step": 9}, {"name": "R8", "step": 9}, {"name": "L8", "step": 9}]
FREED = [{"name": "Row2", "step": 9}, {"name": "R2", "step": 9}, {"name": "L2", "step": 9}]


def creation_order(variant):
    if variant == "refused":
        return CREATION_ORDER + REFUSED_ITEMS + HUD_ITEMS
    return CREATION_ORDER + HUD_ITEMS


# --------------------------------------------------------------------------------------------
# Frames and the state at a frame
# --------------------------------------------------------------------------------------------


def applied(step):
    return 1 if step == 0 else S + N * step


def settle(step):
    return S + N * step + SETTLE


SHOTS = [{"id": f"step-{k}", "kind": "settle", "frame": settle(k), "step": k} for k in range(LAST_STEP + 1)]
SHOTS += [{"id": f"frame-{S + N * k + MID_OFFSET}", "kind": "mid", "frame": S + N * k + MID_OFFSET, "step": k} for k in MID_STEPS]


def step_at(frame):
    k = 0
    for step in range(1, LAST_STEP + 1):
        if applied(step) <= frame:
            k = step
    return k


def texa_content(n):
    return n  # cell 0: no 100c offset


def state(frame, variant=""):
    """The fixture's modelled state after fixture frame `frame`'s _process."""
    k = step_at(frame)
    frozen = k >= 11
    st = {
        "frame": frame,
        "step": k,
        "v_scroll": 76 if k >= 5 else (40 if k >= 1 else 0),
        "lb_text": "Score 12345 ÆØ" if k >= 2 else "Frame 0000",
        "texa": None if k >= 9 else (1 if k >= 3 else 0),
        "sm_tint": SM_TINT_STEP4 if k >= 4 else SM_TINT,
        "cm_blend": "sub" if k >= 4 else "add",
        "cd_k": 1 if k >= 6 else 0,
        "bt_text": "Pause" if k >= 6 else "Play",
        "hb_width": 496 if k >= 7 else 400,
        "le_select": [2, 7] if k >= 7 else [0, 4],
        "tr_tex": "TEXB" if k >= 8 else "TEXA",
        "hud_visible": not (k == 8),
        "hud_layer": -1 if k == 9 else 1,
        "rows": [0, 1, 3, 4, 5, 6, 7, 8] if k >= 9 else list(range(8)),
        "rt_text": 2 if k >= 9 else 1,
        "canvas": SHIFT if k >= 10 else (0, 0),
        "frozen": frozen,
        "pose": 0 if frozen else frame,
        "phase": 0 if frozen else (frame % 24) // 4,
        "an_x": 512.0 if frozen else 512.0 + ((frame + TIME_OFFSET) % 88),
        "pb_value": 40.0 if frozen else pb_value(frame),
    }
    st["rt_scroll"] = rt_scroll(st)
    return st


def pb_value(frame):
    """The tween's value 100 (t mod 5 s)/5 s at t = (f + 1/4)/60, snapped by Range::set_value to
    ProgressBar's step 0.01 (scene/gui/progress_bar.cpp's constructor; range.cpp: round(v/step)*step).
    (100 f + 25)/3 is never a half, so the rounding is never a tie."""
    v = ((frame + TIME_OFFSET) % 300) / 3.0
    return math.floor(v / 0.01 + 0.5) * 0.01


def rt_layout(text_version):
    """(top, height, kind) per RichTextLabel line: text lines MEASURED_RT_LINE_H, the image line 64."""
    out = []
    y = 0
    lines = RT_LINES if text_version == 1 else RT_LINES_STEP9
    for text in lines:
        h = RT_IMAGE_H if text is None else MEASURED_RT_LINE_H
        out.append((y, h, "image" if text is None else text))
        y += h
    return out, y


def rt_scroll(st):
    """scroll_to_line(4) sets the scrollbar to line 4's top; replacing the text keeps the value,
    clamped to the new maximum (content - 112)."""
    if st["step"] < 5:
        return 0
    layout, _ = rt_layout(1)
    y = layout[RT_SCROLL_LINE][0]
    if st["rt_text"] == 2:
        _, total = rt_layout(2)
        y = min(y, total - RT_SIZE[1])
    return y


def rt_visible(st):
    """The RichTextLabel's drawn lines (rich_text_label.cpp's draw loop: from the first line whose
    bottom is below the scroll to the first that starts below the box), with their y in the box."""
    layout, _ = rt_layout(st["rt_text"])
    out = []
    for top, h, kind in layout:
        y = top - st["rt_scroll"]
        if y + h <= 0 or y >= RT_SIZE[1]:
            continue
        out.append((y, h, kind))
    return out


# --------------------------------------------------------------------------------------------
# Textures
# --------------------------------------------------------------------------------------------


def rgba8(c):
    return [int(min(max(f32(v) * 255.0, 0), 255)) for v in c]


def texn_texels():
    out = []
    for y in range(16):
        for x in range(16):
            if 4 <= x < 12 and 4 <= y < 12:
                cx, cy = (x - 4) // 2, (y - 4) // 2
                c = TEXN_MARK if cx == 0 and cy == 0 else (TEXN_A if (cx + cy) % 2 == 0 else TEXN_B)
            else:
                c = TEXN_BORDER
            out.append(rgba8(c))
    return out


def texa_texels(n):
    out = []
    for y in range(64):
        for x in range(64):
            if y < 4 and x < 48:
                on = ((n >> (x // 4)) & 1) == 1
                out.append([255, 255, 255, 255] if on else [0, 0, 0, 255])
                continue
            j = (x // 8 + 2 * (y // 8)) % 4
            out.append(rgba8(TEXA_PALETTE[(5 * n + 3 * j) % 16]))
    return out


def texture_entry(texels, size):
    return {"width": size, "height": size, "rgba8_hex": "".join(f"{v:02x}" for t in texels for v in t)}


def grt1_sha256(texels, size):
    """render-stream-2.md "Texture payload" of an RGBA8 image."""
    data = bytes(v for t in texels for v in t)
    meta = json.dumps({"type": "texture-2d", "format": "RGBA8", "width": size, "height": size, "mipmaps": False, "data_bytes": len(data)}, separators=(",", ":")).encode()
    payload = b"GRT1\r\n\x1a\n" + struct.pack("<I", len(meta)) + meta + struct.pack("<I", len(data)) + data
    return hashlib.sha256(payload).hexdigest()


TEXTURES = {
    "TEXN": texture_entry(texn_texels(), 16),
    "TEXA0": texture_entry(texa_texels(0), 64),
    "TEXA1": texture_entry(texa_texels(1), 64),
    "TEXB": texture_entry(texa_texels(TEXB_CONTENT), 64),
}
TEXTURE_HASHES = {
    "TEXN": grt1_sha256(texn_texels(), 16),
    "TEXA0": grt1_sha256(texa_texels(0), 64),
    "TEXA1": grt1_sha256(texa_texels(1), 64),
    "TEXB": grt1_sha256(texa_texels(TEXB_CONTENT), 64),
}


# --------------------------------------------------------------------------------------------
# Shapes
# --------------------------------------------------------------------------------------------


def colour(c):
    return [f32(v) for v in c]


def rect_shape(name, rect, col, blend=None):
    shape = g5.rect_shape(name, rect, col)
    if blend and blend != "mix":
        shape["blend"] = blend
    return shape


def texture_rect_shape(name, rect, texture):
    x, y, w, h = rect
    return {
        "name": name,
        "kind": "mesh",
        "vertices": [g5.p32(p) for p in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]],
        "triangles": [[0, 1, 2], [0, 2, 3]],
        "colors": [[1.0, 1.0, 1.0, 1.0]],
        "uvs": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
        "texture": texture,
    }


def box_shapes(name, rect, sb):
    """StyleBoxFlat::draw through gate 5g's port: one coverage shape per draw_rounded_rectangle
    part. A part whose vertex colours differ (antialiasing rings, where the LineEdit's border ring
    also blends the border into the fill colour) is band within half the feather plus 1 px."""
    lowered = sty.stylebox_flat(tuple(f32(v) for v in rect), sb)
    if lowered is None:
        return []
    indices, verts, colours, _uvs, parts = lowered
    shapes = []
    for part in parts:
        v0, v1 = part["v"]
        i0, i1 = part["i"]
        cols = [colour(c) for c in colours[v0:v1]]
        shape = {
            "name": f"{name}.{part['role']}",
            "kind": "mesh",
            "vertices": [list(v) for v in verts[v0:v1]],
            "triangles": [[indices[k] - v0, indices[k + 1] - v0, indices[k + 2] - v0] for k in range(i0, i1, 3)],
            "colors": cols if any(c != cols[0] for c in cols) else [cols[0]],
        }
        if len(shape["colors"]) > 1:
            shape["band_px"] = sb["aa_size"] / 2 + 1
        shapes.append(shape)
    return shapes


def undecided(name, rect, content):
    return {"name": name, "kind": "undecided", "rect": [float(v) for v in rect], "content": content}


def text_box(name, x, y, text, size, h):
    """An undecided box over a text run at (x, y): its width bounded by TEXT_ADVANCE_BOUND."""
    w = math.ceil(len(text) * TEXT_ADVANCE_BOUND * size / 16)
    return undecided(name, [x, y, w, h], text)


def scrollbar_shapes(v):
    """sb.cpp:234-309 for SC's VScrollBar (8x112, max 188, page 112, value v)."""
    area = 112.0 - 0.0 - 0.0 - 0.0 - 8.0
    grabber = f32(f32(112.0) / f32(188.0)) * area + 8.0
    offset = area * (v / 188.0)
    return box_shapes("SCROLLBAR.scroll", (0, 0, 8, 112), THEME_SCROLL) + box_shapes("SCROLLBAR.grabber", (0, f32(offset), 8, f32(grabber)), THEME_GRABBER)


def pb_fill(value):
    """pb.cpp:111-128: r = float(get_as_ratio()), p = round(r * (width - fill min width))."""
    r = f32(value / 100.0)
    prod = f32(r * f32(168 - 4))
    assert abs(prod - math.floor(prod) - 0.5) > 1e-3, (value, prod)
    return int(math.floor(prod + 0.5))


def pb_shapes(value):
    p = pb_fill(value)
    shapes = box_shapes("PB.bg", (0, 0, 168, 24), THEME_PB_BG)
    if p > 0:
        shapes += box_shapes("PB.fill", (0, 0, p + 4, 24), THEME_PB_FILL)
    text = f"{int((value / 100.0) * 100)}%"
    shapes.append(undecided("PB.text", [44, 0, 80, 24], text))
    return shapes


def ms_shape(pose):
    verts, cols = [], []
    for i in range(8):
        dy = float(round(8.0 * math.sin(math.tau * (pose + 6 * i) / 90.0)))
        verts += [g5.p32((12.0 * i, 12.0 + dy)), g5.p32((12.0 * i, 40.0 + dy))]
        cols += [colour(MS_TOP), colour(MS_BOTTOM)]
    tris = []
    for i in range(7):
        a = 2 * i
        tris += [[a, a + 2, a + 1], [a + 1, a + 2, a + 3]]
    return {"name": "MS", "kind": "mesh", "vertices": verts, "triangles": tris, "colors": cols}


def cd_shapes(k):
    shapes = [rect_shape("CD.rect", (8, 8, 48, 32), [0.8, 0.4, 0.2, 1])]
    shapes += g5.lower_line("CD.line", (64.0, 8.0), (112.0, 40.0), [1, 1, 0.6, 1], 2.0, False)
    shapes += g5.lower_polyline("CD.polyline", [(8.0, 44.0), (24.0, 52.0), (40.0, 44.0), (56.0, 52.0)], [[0.4, 1, 0.4, 1]], 2.0)
    shapes += g5.lower_circle("CD.circle", (32.0, 72.0), 16.0, [0.2, 0.6, 1, 1], False)
    pts = [(x + 8.0 * k, y) for x, y in [(60, 90), (76, 88), (84, 96), (72, 102), (62, 100)]]
    shapes.append(g5.polygon_shape("CD.polygon", pts, [[1, 0.6, 0.8, 1]]))
    shapes.append(texture_rect_shape("CD.texture", (72, 56, 32, 32), "TEXN"))
    return shapes


def sm_colour(st):
    # The shader twin: COLOR = vec4(tint.rgb * (float(phase % 6) * 0.2), 1.0).
    g = f32(f32(st["phase"] % 6) * f32(0.2))
    return [f32(f32(c) * g) for c in st["sm_tint"][:3]] + [1.0]


# --------------------------------------------------------------------------------------------
# The scene at a frame: items in paint order
# --------------------------------------------------------------------------------------------


def translate(x, y):
    return [1.0, 0.0, 0.0, 1.0, float(x), float(y)]


class Scene:
    """Collects paint-ordered items for one frame; op lists are interned by content."""

    def __init__(self, op_lists, freeze_transforms=None):
        self.op_lists = op_lists
        self.items = []
        self.freeze = freeze_transforms

    def ops_key(self, name, ops):
        text = json.dumps(ops, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(text.encode()).hexdigest()[:12]
        key = f"{name}@{digest}"
        self.op_lists[key] = ops
        return key

    def add(self, name, region, xform, clip, ops):
        if self.freeze is not None and name in self.freeze:
            xform = self.freeze[name]
        self.items.append({"name": name, "region": region, "xform": xform, "clip_px": clip, "ops": self.ops_key(name, ops)})


def build_scene(st, op_lists, variant="", local_xforms=None):
    """The items of one frame. `local_xforms`, when given, maps an item name to the local transform
    the receiver holds for it (omit-op canvas_item_set_transform): the item's position comes from
    there instead of the model."""
    sc = Scene(op_lists)
    cx, cy = st["canvas"]
    local = {}

    def pos(name, x, y):
        local[name] = translate(x, y)
        if local_xforms is not None and name in local_xforms:
            return local_xforms[name][4], local_xforms[name][5]
        return x, y

    def clip_of(box):
        return [box[0] + cx, box[1] + cy, box[2] + cx, box[3] + cy]

    sc.add("BG", "BG", translate(cx, cy), None, box_shapes("BG", (0, 0, 640, 344), sty.box(bg=BG_COLOUR)))

    # SC: rows, then its VScrollBar (internal back child).
    clip = clip_of([8, 8, 176, 120])
    vx, vy = pos("Rows", 0, -st["v_scroll"])
    for index, r in enumerate(st["rows"]):
        rx, ry = pos(f"Row{r}", 0, 24 * index)
        ox, oy = 8 + vx + rx, 8 + vy + ry
        x0, y0 = pos(f"R{r}", 0, 0)
        sc.add(f"R{r}", "SC", translate(ox + x0 + cx, oy + y0 + cy), clip, [rect_shape(f"R{r}", (0, 0, 24, 20), ROW_COLOURS[r])])
        lx, ly = pos(f"L{r}", 28, 0)
        sc.add(f"L{r}", "SC", translate(ox + lx + cx, oy + ly + cy), clip, [text_box(f"L{r}", 0, 0, f"row {r}", 14, 20)])
    sc.add("SC_VScroll", "SC", translate(8 + 160 + cx, 8 + cy), clip, scrollbar_shapes(st["v_scroll"]))

    # RT: undecided over its whole rect (text, the inline image, its own scrollbar).
    visible = rt_visible(st)
    image = None
    if st["rt_text"] == 1 and any(kind == "image" for _y, _h, kind in visible):
        image = st["texa"]
    rt_content = {"text": st["rt_text"], "scroll": st["rt_scroll"], "image_texa": image}
    sc.add("RT", "RT", translate(184 + cx, 8 + cy), clip_of([184, 8, 384, 120]), [undecided("RT", [0, 0, 200, 112], rt_content)])

    tr_tex = "TEXB" if st["tr_tex"] == "TEXB" else f"TEXA{st['texa']}"
    sc.add("TR", "TR", translate(392 + cx, 8 + cy), None, [texture_rect_shape("TR", (0, 0, 64, 64), tr_tex)])
    sc.add("NP", "NP", translate(464 + cx, 8 + cy), None, sty.nine_patch_draw("NP", [0, 0, 96, 64], "stretch", True, [1, 1, 1, 1])[1])
    sc.add("Marker", "Marker", translate(592 + cx, 16 + cy), None, [rect_shape("M", (0, 0, 32, 32), MARKER_COLOURS[st["step"]])])
    sc.add("PB", "PB", translate(8 + cx, 128 + cy), None, pb_shapes(st["pb_value"]))
    sc.add("BT", "BT", translate(8 + cx, 160 + cy), None, box_shapes("BT.normal", (0, 0, 120, 32), THEME_NORMAL) + [undecided("BT.text", [16, 4, 88, 24], st["bt_text"])])
    le_ops = box_shapes("LE.normal", (0, 0, 168, 32), THEME_LINE_EDIT) + box_shapes("LE.focus", (0, 0, 168, 32), THEME_FOCUS)
    le_ops.append(undecided("LE.content", [4, 4, 160, 24], {"text": "edit me", "select": st["le_select"], "caret": 0}))
    sc.add("LE", "LE", translate(8 + cx, 200 + cy), None, le_ops)
    sc.add("CD", "CD", translate(184 + cx, 128 + cy), None, cd_shapes(st["cd_k"]))
    sc.add("MS", "MS", translate(312 + cx, 128 + cy), None, [ms_shape(st["pose"])])
    sc.add("SM", "SM", translate(424 + cx, 128 + cy), None, [rect_shape("SM", (0, 0, 64, 48), sm_colour(st))])
    sc.add("CMU", "CM", translate(496 + cx, 128 + cy), None, [rect_shape("CMU", (0, 0, 48, 40), CM_UNDER)])
    sc.add("CMO", "CM", translate(512 + cx, 144 + cy), None, [rect_shape("CMO", (0, 0, 48, 32), CM_OVER, st["cm_blend"])])
    panel_w = (st["hb_width"] - 16) // 3
    for i in range(3):
        px, py = pos(f"HB{i}", (panel_w + 8) * i, 0)
        sc.add(f"HB{i}", "HB", translate(8 + px + cx, 248 + py + cy), None, box_shapes(f"HB{i}", (0, 0, panel_w, 48), HB_BOXES[i]))
    ax, ay = pos("AN", st["an_x"], 256)
    sc.add("AN", "AN", [2.0, 0.0, 0.0, 2.0, float(ax + cx), float(ay + cy)], None, [texture_rect_shape("AN", (0, 0, 16, 16), "TEXN")])
    sc.add("LB", "LB", translate(8 + cx, 304 + cy), None, [undecided("LB", [0, 0, 320, 32], st["lb_text"])])
    if variant == "refused":
        x0, y0, x1, y1 = RF_REGION
        sc.add("RF", "RF", translate(cx, cy), None, [undecided("RF", [x0, y0, x1 - x0, y1 - y0], "refused")])
    sc.add("TL", "TL", translate(600 + cx, 344 + cy), None, [rect_shape("TL", (0, 0, 16, 16), TL_COLOUR)])
    sc.add("ZH", "HU", translate(400 + cx, 84 + cy), None, [rect_shape("ZH", (0, 0, 112, 32), ZH_COLOUR)])
    if st["hud_visible"] and st["hud_layer"] > 0:
        sc.add("HUDPanel", "HU", translate(456, 88), None, box_shapes("HUD", (0, 0, 168, 28), sty.box(bg=HUD_COLOUR)))
        sc.add("HUDLabel", "HU", translate(464, 90), None, [text_box("HUDLabel", 0, 0, "HUD", 16, 24)])
    return sc.items, local


def regions_at(step, variant=""):
    out = {}
    for name, box in REGIONS.items():
        if step >= 10:
            out[name] = HU_SHIFTED if name == "HU" else [box[0] + SHIFT[0], box[1] + SHIFT[1], min(box[2] + SHIFT[0], VIEWPORT[0]), min(box[3] + SHIFT[1], VIEWPORT[1])]
        else:
            out[name] = list(box)
    if variant == "refused":
        b = RF_REGION
        out["RF"] = [b[0] + SHIFT[0], b[1] + SHIFT[1], b[2] + SHIFT[0], b[3] + SHIFT[1]] if step >= 10 else list(b)
    return out


def region_signatures(items, op_lists):
    """Per region, everything that decides its pixels (transforms, scissors, shapes and the
    undecided boxes' content), for freshness and the sabotage predictions."""
    sig = {}
    for item in items:
        sig.setdefault(item["region"], []).append([item["name"], item["xform"], item["clip_px"], op_lists[item["ops"]]])
    return {k: json.dumps(v, sort_keys=True) for k, v in sig.items()}


# --------------------------------------------------------------------------------------------
# Census, oracle views and predictions
# --------------------------------------------------------------------------------------------

SM_CODE = shd.preprocess(shd.read(os.path.join("..", "gate6-scene", "shaders", "phase_tint.gdshader")))


def hook_census():
    """The scene's own resource calls as the capture's hook log must show them (resources.jsonl;
    font atlas pages are not hand-predicted, atlas-parity covers them)."""
    phase_frames = [f for f in range(4, applied(11)) if f % 4 == 0]
    return {
        "textures": [
            {"frame": 1, "op": "texture_2d_create", "texture": "TEXN", "hash": TEXTURE_HASHES["TEXN"]},
            {"frame": 1, "op": "texture_2d_create", "texture": "TEXA", "hash": TEXTURE_HASHES["TEXA0"]},
            {"frame": 1, "op": "texture_2d_create", "texture": "TEXB", "hash": TEXTURE_HASHES["TEXB"]},
            {"frame": applied(3), "op": "texture_2d_update", "texture": "TEXA", "hash": TEXTURE_HASHES["TEXA1"]},
            {"frame": applied(9), "op": "free", "texture": "TEXA", "hash": None},
        ],
        # the default theme's ColorPicker hue strip (memory rs-g2a-texture-census-facts), and font
        # atlas pages: LA8 (grayscale antialiasing), any number, any frame
        "engine_textures": [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}],
        "atlas_format": "LA8",
        "mesh": {
            "create_frame": 1,
            "vertex_count": 16,
            "index_count": 42,
            # one vertex region update per frame from frame 1 (pose 1) to step 11's frame (pose 0)
            "region_update_frames": [1, applied(11)],
        },
        "sm": {
            "shader_sha256": shd.code_view(SM_CODE)["sha256"],
            "code_bytes": shd.code_view(SM_CODE)["code_bytes"],
            # the builder's initial phase and tint, then AnimationPlayer.play + seek(update) at
            # _ready (frame 1); a discrete key every 4 frames; step 4's tint; step 11's seek(0) and
            # the explicit phase 0
            "param_sets": [[1, "phase"], [1, "tint"], [1, "phase"], [1, "phase"]] + [[f, "phase"] for f in phase_frames if f < applied(4)] + [[applied(4), "tint"]] + [[f, "phase"] for f in phase_frames if f > applied(4)] + [[applied(11), "phase"], [applied(11), "phase"]],
        },
        "cm": {"shaders": [[1, "add"], [applied(4), "sub"]]},
        "canvas": {"canvas_create": 1, "viewport_attach_canvas": 1, "viewport_set_canvas_transform": 2, "hud_hidden_frames": [applied(8), applied(9) - 1]},
        # `animate` (Q6d): TEXA(floor(f/30) + 2) every 30 frames, step 3's TEXA(1) the frame after
        # frame 30, TEXA freed at step 9
        "animate_texa": [[f, f"TEXA{f // 30 + 2}" if f % 30 == 0 else "TEXA1", grt1_sha256(texa_texels(f // 30 + 2 if f % 30 == 0 else 1), 64)] for f in sorted([30, 60, 90, applied(3)])],
    }


def oracle_view(st):
    return {
        "oversampling": 1.0,
        "v_scroll": st["v_scroll"],
        "content_position": [0.0, float(-st["v_scroll"])],
        "hud": {"layer": st["hud_layer"], "visible": st["hud_visible"]},
        "pb_value": st["pb_value"],
        "sm": {"phase": st["phase"], "tint": colour(st["sm_tint"]), "shader_sha256": shd.code_view(SM_CODE)["sha256"]},
        "cm_blend_mode": {"add": 1, "sub": 2}[st["cm_blend"]],
        "rich_text": {
            "line_offsets": [float(top) for top, _h, _k in rt_layout(st["rt_text"])[0]],
            "content_height": rt_layout(st["rt_text"])[1],
            "v_scroll": float(st["rt_scroll"]),
        },
    }


def scroll_table():
    out = []
    for k in range(LAST_STEP + 1):
        st = state(settle(k))
        shift = st["canvas"]
        out.append({
            "step": k,
            "v_scroll": st["v_scroll"],
            # sc.cpp:398: the content's position is floored
            "content_offset": [0, -st["v_scroll"]],
            "scissor": [8 + shift[0], 8 + shift[1], 176 + shift[0], 120 + shift[1]],
            "rt_scroll": st["rt_scroll"],
        })
    return out


# The items each step's change re-records (their `_draw` runs again), for perturb-vertex: a redraw
# from frame 21 on carries a perturbed first point in each line, polyline, primitive and triangle
# array (rs_mirror.cpp:1177-1306). PB redraws whenever its value changes: every frame until step 11.
REDRAWS = {
    1: ["SC_VScroll"],
    5: ["SC_VScroll", "RT_VScroll"],
    6: ["CD", "BT"],
    7: ["HB0", "HB1", "HB2", "LE"],
    9: ["RT_VScroll"],
}
PERTURBABLE = {"SC_VScroll": "SC", "RT_VScroll": "RT", "CD": "CD", "BT": "BT", "HB0": "HB", "HB1": "HB", "HB2": "HB", "LE": "LE", "PB": "PB"}


def pb_redraw_frames():
    out = []
    prev = state(0)["pb_value"]
    for f in range(1, CAPTURE_QUIT + 1):
        v = state(f)["pb_value"]
        if v != prev:
            out.append(f)
        prev = v
    return out


def predictions(variant=""):
    """Per sabotage leg, the (shot, region) pairs where a receiver of that leg differs from the
    reference, recomputed from the model. HU is excluded before G6b (the receiver draws no HUD)."""
    op_lists = {}

    def sigs(frame, **kw):
        st = state(frame, variant)
        items, local = build_scene(st, op_lists, variant, **kw)
        return region_signatures(items, op_lists), local

    names = list(REGIONS) + ["BG"]
    out = {}

    # freeze-frame @11: every shot from frame 11 on shows frame 10's state.
    frozen, _ = sigs(10)
    cells = {}
    for shot in SHOTS:
        if shot["frame"] < 11:
            continue
        now, _ = sigs(shot["frame"])
        cells[shot["id"]] = sorted(r for r in names if r != "HU" and now.get(r) != frozen.get(r))
    out["sabotage-freeze"] = {"frame": 11, "shots": cells}

    # omit-op canvas_item_set_transform @21: every item keeps the local transform it had at frame 20
    # (an item created later keeps the identity).
    _, before = sigs(20)
    cells = {}
    for shot in SHOTS:
        if shot["frame"] < 21:
            cells[shot["id"]] = []
            continue
        st = state(shot["frame"], variant)
        _, local_true = build_scene(st, {}, variant)
        held = {name: before.get(name, translate(0, 0)) for name in local_true}
        now, _ = sigs(shot["frame"])
        held_sig, _ = sigs(shot["frame"], local_xforms=held)
        cells[shot["id"]] = sorted(r for r in names if r != "HU" and now.get(r) != held_sig.get(r))
    out["sabotage-omit-transform"] = {"frame": 21, "op": "canvas_item_set_transform", "shots": cells}

    # perturb-vertex @21: an item re-recorded from frame 21 on with a perturbable command, and MS's
    # surface payloads (every region update from frame 21).
    pb_frames = pb_redraw_frames()
    cells = {}
    for shot in SHOTS:
        f = shot["frame"]
        hit = set()
        for step, items in REDRAWS.items():
            if 21 <= applied(step) <= f:
                hit.update(PERTURBABLE[i] for i in items)
        if any(21 <= g <= f for g in pb_frames) or (f >= applied(11) >= 21):
            hit.add("PB")
        if f >= 21:
            hit.add("MS")
        cells[shot["id"]] = sorted(hit)
    out["sabotage-perturb-vertex"] = {"frame": 21, "shots": cells}

    # perturb-shader @21: SM's shader is created at frame 1 and never re-coded, and CM's are
    # builtin (never perturbed), so nothing differs.
    out["sabotage-perturb-shader"] = {"frame": 21, "shots": {s["id"]: [] for s in SHOTS}}

    # receiver ignore-clip: every clipped item's parts outside its scissor paint: SC's rows (their
    # rects and label boxes) and RT's last drawn line where it leaves the box.
    cells = {}
    for shot in SHOTS:
        st = state(shot["frame"], variant)
        regs = regions_at(shot["step"], variant)
        boxes = []
        cx, cy = st["canvas"]
        clip = [8 + cx, 8 + cy, 176 + cx, 120 + cy]
        for index, r in enumerate(st["rows"]):
            y = 8 + 24 * index - st["v_scroll"] + cy
            boxes.append([8 + cx, y, 32 + cx, y + 20])
            boxes.append([36 + cx, y, 36 + cx + math.ceil(len(f"row {r}") * TEXT_ADVANCE_BOUND * 14 / 16), y + 20])
        rt_clip = [184 + cx, 8 + cy, 384 + cx, 120 + cy]
        outside_boxes = []
        for b in boxes:
            outside_boxes += box_minus(b, clip)
        for y, h, kind in rt_visible(st):
            if kind == "image" or y + h <= RT_SIZE[1]:
                continue
            w = math.ceil(len(kind) * TEXT_ADVANCE_BOUND)
            outside_boxes += box_minus([184 + cx, 8 + y + cy, 184 + cx + w, 8 + y + h + cy], rt_clip)
        hit = set()
        for b in outside_boxes:
            b = [max(b[0], 0), max(b[1], 0), min(b[2], VIEWPORT[0]), min(b[3], VIEWPORT[1])]
            if b[0] >= b[2] or b[1] >= b[3]:
                continue
            for name, rb in regs.items():
                if rb[0] < b[2] and b[0] < rb[2] and rb[1] < b[3] and b[1] < rb[3]:
                    hit.add(name)
            if not covered_by(b, regs.values()):
                hit.add("BG")
        cells[shot["id"]] = sorted(h for h in hit if h != "HU")
    out["sabotage-receiver-ignore-clip"] = {"shots": cells}

    # receiver stale-texture: RGBA8 images keep their first payload; TEXA's step-3 update never
    # reaches TR (TEXA until step 8) or RT's inline image (while it is drawn).
    cells = {}
    for shot in SHOTS:
        st = state(shot["frame"], variant)
        hit = []
        if st["texa"] == 1 and st["tr_tex"] == "TEXA":
            hit.append("TR")
        if st["texa"] == 1 and st["rt_text"] == 1 and any(kind == "image" for _y, _h, kind in rt_visible(st)):
            hit.append("RT")
        cells[shot["id"]] = sorted(hit)
    out["sabotage-receiver-stale-texture"] = {"shots": cells}
    return out


def box_minus(b, clip):
    """The parts of box b outside the clip box, as boxes."""
    out = []
    x0, y0, x1, y1 = b
    cx0, cy0, cx1, cy1 = clip
    if y0 < cy0:
        out.append([x0, y0, x1, min(y1, cy0)])
    if y1 > cy1:
        out.append([x0, max(y0, cy1), x1, y1])
    my0, my1 = max(y0, cy0), min(y1, cy1)
    if my0 < my1:
        if x0 < cx0:
            out.append([x0, my0, min(x1, cx0), my1])
        if x1 > cx1:
            out.append([max(x0, cx1), my0, x1, my1])
    return [o for o in out if o[0] < o[2] and o[1] < o[3]]


def covered_by(b, boxes):
    for y in range(b[1], b[3]):
        for x in range(b[0], b[2]):
            if not any(r[0] <= x < r[2] and r[1] <= y < r[3] for r in boxes):
                return False
    return True


# --------------------------------------------------------------------------------------------
# Steps and shots
# --------------------------------------------------------------------------------------------


def build_shots(variant, op_lists):
    shots = []
    for shot in SHOTS:
        st = state(shot["frame"], variant)
        items, _ = build_scene(st, op_lists, variant)
        shots.append({**shot, "regions": regions_at(shot["step"], variant), "items": items, "sig": region_signatures(items, op_lists)})
    return shots


def build_steps(variant, shots):
    steps = []
    settle_shots = [s for s in shots if s["kind"] == "settle"]
    for k, shot in enumerate(settle_shots):
        st = state(shot["frame"], variant)
        fresh = {}
        for region in list(REGIONS) + (["RF"] if variant == "refused" else []):
            if k == 0:
                fresh[region] = True
                continue
            fresh[region] = shot["sig"].get(region) != settle_shots[k - 1]["sig"].get(region)
        steps.append({
            "step": k,
            "applied_frame": applied(k),
            "settle_frame": settle(k),
            "marker_rgba8": MARKER[k],
            "canvas_transform": [1, 0, 0, 1, st["canvas"][0], st["canvas"][1]],
            "fresh": fresh,
            "oracle": oracle_view(st),
        })
    return steps


def check(variant, shots, steps, op_lists):
    names = list(REGIONS)
    for step in range(LAST_STEP + 1):
        regs = regions_at(step, variant)
        keys = list(regs)
        for i, a in enumerate(keys):
            ra = regs[a]
            assert 0 <= ra[0] < ra[2] <= VIEWPORT[0] and 0 <= ra[1] < ra[3] <= VIEWPORT[1], (step, a, ra)
            for b in keys[i + 1 :]:
                rb = regs[b]
                assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (step, a, b)
    # Every shape of an item lies inside its region (scissor-clipped ones inside the scissor).
    for shot in shots:
        regs = shot["regions"]
        for item in shot["items"]:
            region = regs.get(item["region"])
            if region is None:
                assert item["region"] == "BG", item["name"]
                continue
            for shape, m, clip in g5.walk_shapes(item, op_lists):
                if shape["kind"] == "undecided":
                    x, y, w, h = shape["rect"]
                    pts = [(x, y), (x + w, y + h)]
                else:
                    pts = g5.shape_points(shape)
                # an antialiasing ring's outer vertices lie half a pixel out, at alpha 0
                pad = 0.5 if "band_px" in shape else 0.0
                for p in pts:
                    x, y = g5.apply(m, p)
                    if clip is not None:
                        x, y = min(max(x, clip[0]), clip[2]), min(max(y, clip[1]), clip[3])
                    x, y = min(max(x, 0), VIEWPORT[0]), min(max(y, 0), VIEWPORT[1])
                    inside = region[0] - pad - 1e-6 <= x <= region[2] + pad + 1e-6 and region[1] - pad - 1e-6 <= y <= region[3] + pad + 1e-6
                    assert inside, (shot["id"], item["name"], shape["name"], (x, y), region)
    # Colour rule: every scene colour on the 0.2 grid at alpha 1, theme boxes exempt.
    for key, ops in op_lists.items():
        for op in ops:
            if op.get("kind") != "mesh" or op["name"].startswith(THEME_SHAPE_PREFIXES):
                continue
            for c in op["colors"]:
                assert all(any(abs(f32(v) - g) < 1e-6 for g in GRID) for v in c[:3]), (key, op["name"], c)
                assert abs(c[3] - 1) < 1e-6 or (op.get("band_px") is not None and abs(c[3]) < 1e-6), (key, op["name"], c)
    assert len({tuple(m) for m in MARKER}) == len(MARKER) == LAST_STEP + 1
    # Q6b: nothing under Scene paints in the bottom strip y in [344, 360) but TL (steps 0..9).
    for shot in shots:
        if shot["step"] >= 10:
            continue
        for item in shot["items"]:
            if item["name"] in ("TL",):
                continue
            for shape, m, _clip in g5.walk_shapes(item, op_lists):
                pts = [(shape["rect"][0], shape["rect"][1] + shape["rect"][3])] if shape["kind"] == "undecided" else g5.shape_points(shape)
                for p in pts:
                    assert g5.apply(m, p)[1] <= 344 + 1e-6, (shot["id"], item["name"], shape["name"])
    # Hand freshness (Q6c's "proves" column; HU's HUD part fresh at 8 and 10 only: at step 9 the
    # layer behind the root canvas is wholly under BG's opaque panel).
    continuous = {"MS", "SM", "AN", "PB"}
    hand = {1: {"SC"}, 2: {"LB"}, 3: {"TR", "RT"}, 4: {"SM", "CM"}, 5: {"SC", "RT"}, 6: {"CD", "BT"}, 7: {"HB", "LE"}, 8: {"TR", "HU"}, 9: {"SC", "RT"}, 10: set(names), 11: set()}
    for k, want in hand.items():
        got = {r for r, f in steps[k]["fresh"].items() if f}
        assert got - continuous - {"Marker", "RF"} == want - continuous - {"Marker"}, f"step {k}: fresh {sorted(got)} vs hand {sorted(want)}"
        assert steps[k]["fresh"]["Marker"], k
        assert not steps[k]["fresh"]["TL"] or k == 10, k
    return True


def build_variant(variant, op_lists):
    shots = build_shots(variant, op_lists)
    steps = build_steps(variant, shots)
    check(variant, shots, steps, op_lists)
    for s in shots:
        del s["sig"]
    return {
        "creation_order": creation_order(variant),
        "regions": regions_at(0, variant),
        "class": {**CLASS, **({"RF": "undecided"} if variant == "refused" else {})},
        "shots": shots,
        "steps": steps,
    }


def build():
    op_lists = {}
    base = build_variant("", op_lists)
    refused = build_variant("refused", op_lists)
    used = {i["ops"] for v in (base, refused) for s in v["shots"] for i in s["items"]}
    op_lists = {k: v for k, v in sorted(op_lists.items()) if k in used}
    return {
        "schema": "render-stream-gate6-expected/1",
        "fixture": "gate6-scene",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "capture_quit_frame": CAPTURE_QUIT,
        "last_step": LAST_STEP,
        "mid_frames": [S + N * k + MID_OFFSET for k in MID_STEPS],
        "time_offset_frames": TIME_OFFSET,
        "measured": {"rt_line_h": MEASURED_RT_LINE_H, "row_label_h_max": MEASURED_ROW_LABEL_H, "text_advance_bound": TEXT_ADVANCE_BOUND},
        "exact_edge_px": 1 / 16,
        "creation_order": base["creation_order"],
        "created_later": CREATED_LATER,
        "freed": FREED,
        "hidden_items": ["SC_HScroll", "SC_Focus"],
        "regions": base["regions"],
        "class": base["class"],
        "marker_rect": [592, 16, 32, 32],
        "textures": TEXTURES,
        "texture_hashes": TEXTURE_HASHES,
        "hook_census": hook_census(),
        # As built (G6a): Scene and TL both enter before the first iteration, so their deferred
        # top-level raises land inside frame 1 (scene_tree.cpp:644): no draw-index tie at all.
        "draw_index_ties": [],
        "scroll": scroll_table(),
        "pb_redraw_frames": pb_redraw_frames(),
        "op_lists": op_lists,
        "shots": base["shots"],
        "steps": base["steps"],
        "variants": {
            "refused": {
                "creation_order": refused["creation_order"],
                "regions": refused["regions"],
                "class": refused["class"],
                "shots": refused["shots"],
                "steps": refused["steps"],
                # what /5 types for the refused variant before G6b (Q6d), op/reason pairs
                "unsupported": sorted([
                    ["canvas_item_add_lcd_texture_rect_region", "unsupported-op"],
                    ["canvas_item_add_multimesh", "unsupported-op"],
                    ["canvas_item_set_material", "unsupported-material"],
                    ["canvas_light_attach_to_canvas", "canvas-light"],
                    ["viewport_attach_canvas", "extra-canvas"],
                ]),
            }
        },
        # what /5 types for the default scene before G6b: the HUD layer's canvas, session-level
        "unsupported": [["viewport_attach_canvas", "extra-canvas"]],
        "predictions": predictions(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed file")
    args = parser.parse_args()
    text = g5.render(build())
    if args.check:
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        if json.loads(current) != json.loads(text):
            sys.stdout.writelines(difflib.unified_diff(g5.render(json.loads(current)).splitlines(True), text.splitlines(True), "expected.json", "generated"))
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
