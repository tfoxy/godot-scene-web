#!/usr/bin/env python3
"""Write fixtures/gate5-style/expected.json (render-stream-gate5-expected/1).

Every number below is derived from the fixture's own parameters and the engine's drawing code as
read from the source (protocol/gate5-design.md Q1h), written down as code. Nothing here runs or
reads the engine: the capture's hook census and the rendered reference have to agree with it, and
a disagreement is a finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate5-style/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate5-style/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `sbf` is scene/resources/style_box_flat.cpp):

- NinePatchRect (scene/gui/nine_patch_rect.cpp:35-48) and StyleBoxTexture
  (scene/resources/style_box_texture.cpp:163-182) each make one `canvas_item_add_nine_patch` with
  a `Rect2()` source (an ImageTexture's get_rect_region passes it through); the shader's axis
  mapping (drivers/gles3/shaders/canvas.glsl:521-588) is scripts/lib/geometry-raster.ts's.
- StyleBoxFlat::draw (sbf:456-647) makes one `canvas_item_add_triangle_array` with per-vertex
  colours and UVs. `stylebox_flat` below ports it and `draw_rounded_rectangle` (sbf:313-434),
  `set_inner_corner_radius`/`set_corner_scale` (sbf:228-311) and `adapt_values` (sbf:436-443) in
  float32 (cos/sin rounded from double, so the call is flagged `ulp: 2`, D12). Each
  `draw_rounded_rectangle` call becomes one coverage shape: flat ones are exact (or delta 1 when
  translucent), and those whose vertex alphas differ (the antialiasing rings and the shadow ring)
  are band (D13), `band_px` past their edges.
- The flipped box is TabBar's pattern (scene/gui/tab_bar.cpp:634-638): two
  `canvas_item_add_set_transform` (Transform2D(0, (0, h)).scale_basis((1, -1)) and identity,
  scene/main/canvas_item.cpp:906-913) around the box; D9's replace rule.
- The RichTextLabel (scene/gui/rich_text_label.cpp:2466-2476) draws its empty `normal` box (no
  call) and, while it has focus, the default theme's `focus` box between `add_clip_ignore(true)`
  and `(false)` (D10); with no text it draws no glyph and no transform.
- The default theme (scene/theme/default_theme.cpp:55-71, :111-144, :1156): Panel's box is
  make_flat_stylebox((0.1, 0.1, 0.1, 0.6), radius 3, corner_detail min(ceil(4.5), 6) = 5,
  antialiased); RichTextLabel's focus box is the same helper with (1, 1, 1, 0.75), no centre,
  border 2 in the default border colour (0.8, 0.8, 0.8), expand margin 2.
- Redraws. A step that changes a box queues its own node's redraw; a NinePatchRect resize redraws
  it; release_focus redraws the RichTextLabel; a Control's move and the canvas transform redraw
  nothing.
- Freshness. A region is fresh at a step exactly when its modelled content (the transforms,
  scissors and commands of its items that draw anything) differs from the previous step's: the
  unfocused RichTextLabel draws nothing, so step 9's canvas shift leaves its region unchanged.
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
sys.path.insert(0, os.path.join(HERE, "..", "gate5"))
import make_expected as g5  # noqa: E402  (the gate 5 helpers: float32, transforms, welding, render)

f32 = g5.f32
S, N, SETTLE = g5.S, g5.N, g5.SETTLE
LAST_STEP = g5.LAST_STEP
QUIT = g5.QUIT
VIEWPORT = g5.VIEWPORT
CLEAR = g5.CLEAR
MARKER = g5.MARKER
MARKER_COLOURS = g5.MARKER_COLOURS
GRID = g5.GRID

SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM = 0, 1, 2, 3
CORNER_TOP_LEFT, CORNER_TOP_RIGHT, CORNER_BOTTOM_RIGHT, CORNER_BOTTOM_LEFT = 0, 1, 2, 3
FLT_EPSILON = 1.1920928955078125e-07
# StyleBoxFlat's antialiasing ring is aa_size (1) wide; a ring is band within half its width plus
# 1 px of its edges, the shadow ring likewise (D13: compared leg to leg, presence only).
AA_SIZE = 1.0

# Regions, [x0, y0, x1) x [y0, y1); each leaves room for step 9's (8, 4) canvas shift.
REGIONS = {
    "NS": [8, 8, 104, 100],
    "NT": [104, 8, 200, 100],
    "NF": [200, 8, 296, 100],
    "NH": [296, 8, 392, 100],
    "TX": [392, 8, 488, 100],
    "SF": [8, 104, 104, 196],
    "SB": [104, 104, 200, 196],
    "SR": [200, 104, 296, 196],
    "SS": [296, 104, 392, 196],
    "SK": [392, 104, 488, 196],
    "DP": [488, 104, 584, 196],
    "FL": [8, 200, 104, 292],
    "RT": [104, 200, 200, 292],
    "Marker": [584, 8, 632, 56],
}
# Wire id order: canvas_item_create order (gate5_style.gd _ready). RichTextLabel's constructor makes
# its internal VScrollBar right after itself (rich_text_label.cpp:8060-8069), hidden, drawing
# nothing.
CREATION_ORDER = ["NS", "NT", "NF", "NH", "TX", "SF", "SB", "SR", "SS", "SK", "DP", "FL", "RT", "RT_VScrollBar", "Marker"]
REGION_OF = {name: ("RT" if name == "RT_VScrollBar" else name) for name in CREATION_ORDER}
POSITION = {
    "NS": (16, 16),
    "NT": (112, 16),
    "NF": (208, 16),
    "NH": (304, 16),
    "TX": (404, 20),
    "SF": (16, 116),
    "SB": (112, 116),
    "SR": (208, 116),
    "SS": (312, 116),
    "SK": (408, 116),
    "DP": (504, 116),
    "FL": (16, 212),
    "RT": (124, 220),
    # anchored to RT's right edge with zero width (rich_text_label.cpp:8064-8066); never drawn
    "RT_VScrollBar": (124 + 56, 220),
    "Marker": (592, 16),
}
SIZE = {"TX": (56, 40), "SF": (64, 48), "SB": (64, 48), "SR": (64, 48), "SS": (56, 40), "SK": (56, 40), "DP": (56, 40), "FL": (64, 48), "RT": (56, 40)}
CLIPS = {"RT"}  # RichTextLabel's constructor sets clip_contents (rich_text_label.cpp:8078)
NINE_PATCH_MODE = {"NS": ("stretch", True), "NT": ("tile", True), "NF": ("tile_fit", True), "NH": ("stretch", False)}

# `TEXN` (gate5_style.gd): a 4-texel border around an 8x8 centre of 2x2 cells.
TEXN_BORDER = [1, 1, 0.6, 1]
TEXN_MARK = [1, 0.4, 0.4, 1]
TEXN_A = [0.4, 0.2, 0.8, 1]
TEXN_B = [0.2, 0.8, 0.6, 1]


def box(**kw):
    """A StyleBoxFlat with the engine's defaults (style_box_flat.h:38-54)."""
    b = {
        "bg": [0.6, 0.6, 0.6, 1],
        "border_color": [0.8, 0.8, 0.8, 1],
        "border": [0, 0, 0, 0],
        "expand": [0, 0, 0, 0],
        "corner": [0, 0, 0, 0],
        "draw_center": True,
        "skew": (0.0, 0.0),
        "anti_aliased": True,
        "corner_detail": 8,
        "shadow_size": 0,
        "shadow_offset": (0.0, 0.0),
        "shadow_color": [0, 0, 0, 0.6],
        "aa_size": AA_SIZE,
    }
    b.update(kw)
    return b


def theme_flat(colour, corner_radius=3, draw_center=True, border_width=0):
    """make_flat_stylebox (default_theme.cpp:55-71) at scale 1."""
    return box(bg=colour, corner=[corner_radius] * 4, anti_aliased=True, corner_detail=min(math.ceil(1.5 * corner_radius), 6), draw_center=draw_center, border=[border_width] * 4)


THEME_PANEL = theme_flat([0.1, 0.1, 0.1, 0.6])
THEME_FOCUS = dict(theme_flat([1, 1, 1, 0.75], draw_center=False, border_width=2), expand=[2, 2, 2, 2])

# The initial state and the step table: (step, property, value) in gate5_style.gd's order.
INITIAL = {
    "sf_bg": [0.4, 0.8, 0.4, 1],
    "np_size": (52, 40),
    "sb_border_left": 2,
    "rt_focus": True,
    "dp_offset": (0, 0),
    "sr_radius": 8,
    "ss_offset": (2, 2),
    "tx_modulate": [0.6, 0.6, 1, 1],
    "canvas": (0, 0),
}
TIMELINE = {
    1: [("sf_bg", [1, 0.6, 0.2, 1])],
    2: [("np_size", (68, 56))],
    3: [("sb_border_left", 6)],
    4: [("rt_focus", False)],
    5: [("dp_offset", (8, 4))],
    6: [("sr_radius", 12)],
    7: [("ss_offset", (-2, 2))],
    8: [("tx_modulate", [1, 0.6, 0.6, 1])],
    9: [("canvas", (8, 4))],
}
# Which items each property redraws.
REDRAWN_BY = {
    "sf_bg": ["SF"],
    "np_size": ["NS", "NT", "NF", "NH"],
    "sb_border_left": ["SB"],
    "rt_focus": ["RT"],
    "sr_radius": ["SR"],
    "ss_offset": ["SS"],
    "tx_modulate": ["TX"],
}

# The census over the run, typed in by hand (one call per item redraw: the eight StyleBoxFlat
# draws at 0, SF again at 1, SB at 3, SR at 6, SS at 7; five nine-patches at 0, four at 2, TX at 8;
# the flip's two transforms and the focus box's two clip-ignores at 0; the marker every step),
# never computed. `calls_by_op` must equal it.
HAND_CENSUS = {
    "canvas_item_add_rect": 10,
    "canvas_item_add_triangle_array": 8 + 4,
    "canvas_item_add_nine_patch": 5 + 4 + 1,
    "canvas_item_add_set_transform": 2,
    "canvas_item_add_clip_ignore": 2,
}
# What a /0-/3 capture types `unsupported`: every op but add_rect.
TYPED_OPS = sorted(op for op in HAND_CENSUS if op != "canvas_item_add_rect")
# Q1h's StyleBoxFlat vertex and index counts, typed in by hand: a filled pass (d + 1) * 4 vertices
# and (2(d + 1) - 1) * 6 indices, a ring (d + 1) * 8 and (d + 1) * 24, d = corner_detail when
# rounded, else 1.
HAND_LOWERING = {
    "SF": (8, 18),  # one sharp fill
    "SB": (24, 66),  # a sharp border ring and a fill
    "SR": (108, 318),  # radius 8, detail 8, antialiased: a fill (36/102) and its ring (72/216)
    "SS": (32, 84),  # sharp: the shadow ring (16/48), the shadow fill and the fill (8/18 each)
    "SK": (24, 66),  # skewed, antialiased: a fill and its ring
    "DP": (72, 210),  # the theme Panel, detail 5: a fill (24/66) and its ring (48/144)
    "FL": (24, 66),  # as SB
    "RT": (144, 432),  # the theme focus box, detail 5, no centre: the border ring and two AA rings
}
# Shapes whose colours come from the default theme, exempt from the 0.2 grid (they are the point:
# the combined scene's most common draw), and the one translucent non-band shape.
THEME_SHAPES = ["DP.fill", "DP.aa_fill"]
TRANSLUCENT_SHAPES = ["SS.shadow_fill"]
ENGINE_TEXTURES = g5.ENGINE_TEXTURES


# --------------------------------------------------------------------------------------------
# StyleBoxFlat::draw, ported (float32; real_t is float in the release template)
# --------------------------------------------------------------------------------------------


def nz(x):
    """-0.0 -> 0.0 (JSON and ulp comparisons treat the zeros alike only when written alike)."""
    return x + 0.0


def cmin(a, b):
    """The MIN macro: a < b ? a : b."""
    return a if a < b else b


def cmax(a, b):
    """The MAX macro: a > b ? a : b."""
    return a if a > b else b


def grow_individual(r, left, top, right, bottom):
    x, y, w, h = r
    return (f32(x - left), f32(y - top), f32(w + f32(left + right)), f32(h + f32(top + bottom)))


def grow(r, a):
    x, y, w, h = r
    return (f32(x - a), f32(y - a), f32(w + f32(a * 2)), f32(h + f32(a * 2)))


def grow_side(r, side, a):
    return grow_individual(r, a if side == SIDE_LEFT else 0.0, a if side == SIDE_TOP else 0.0, a if side == SIDE_RIGHT else 0.0, a if side == SIDE_BOTTOM else 0.0)


def borders_between(style, inner):
    left = f32(inner[0] - style[0])
    top = f32(inner[1] - style[1])
    right = f32(f32(style[2] - inner[2]) - left)
    bottom = f32(f32(style[3] - inner[3]) - top)
    return left, top, right, bottom


def set_inner_corner_radius(style, inner, cr):
    """sbf:228-238."""
    left, top, right, bottom = borders_between(style, inner)
    return [
        cmax(f32(cr[0] - cmin(top, left)), 0.0),
        cmax(f32(cr[1] - cmin(top, right)), 0.0),
        cmax(f32(cr[2] - cmin(bottom, right)), 0.0),
        cmax(f32(cr[3] - cmin(bottom, left)), 0.0),
    ]


def vsub(a, b):
    return (f32(a[0] - b[0]), f32(a[1] - b[1]))


def vadd(a, b):
    return (f32(a[0] + b[0]), f32(a[1] + b[1]))


def vminf(a, v):
    return (cmin(a[0], v), cmin(a[1], v))


def vmaxf(a, v):
    return (cmax(a[0], v), cmax(a[1], v))


def vneg(a):
    return (-a[0], -a[1])


def set_corner_scale(style, inner, cr):
    """sbf:240-311."""
    left, top, right, bottom = borders_between(style, inner)
    overflow = [
        -cmin(0.0, f32(f32(inner[3] - cr[CORNER_TOP_LEFT]) - cr[CORNER_BOTTOM_LEFT])),
        -cmin(0.0, f32(f32(inner[2] - cr[CORNER_TOP_LEFT]) - cr[CORNER_TOP_RIGHT])),
        -cmin(0.0, f32(f32(inner[3] - cr[CORNER_TOP_RIGHT]) - cr[CORNER_BOTTOM_RIGHT])),
        -cmin(0.0, f32(f32(inner[2] - cr[CORNER_BOTTOM_LEFT]) - cr[CORNER_BOTTOM_RIGHT])),
    ]
    hb = f32(left + right)
    vb = f32(top + bottom)
    ratios = [
        f32(left / hb) if hb > 0 else 0.0,
        f32(top / vb) if vb > 0 else 0.0,
        f32(right / hb) if hb > 0 else 0.0,
        f32(bottom / vb) if vb > 0 else 0.0,
    ]
    reduction = [
        (f32(overflow[SIDE_TOP] * ratios[SIDE_LEFT]), f32(overflow[SIDE_LEFT] * ratios[SIDE_TOP])),
        (f32(overflow[SIDE_TOP] * ratios[SIDE_RIGHT]), f32(overflow[SIDE_RIGHT] * ratios[SIDE_TOP])),
        (f32(overflow[SIDE_BOTTOM] * ratios[SIDE_RIGHT]), f32(overflow[SIDE_RIGHT] * ratios[SIDE_BOTTOM])),
        (f32(overflow[SIDE_BOTTOM] * ratios[SIDE_LEFT]), f32(overflow[SIDE_LEFT] * ratios[SIDE_BOTTOM])),
    ]
    pcr = [(f32(c), f32(c)) for c in cr]
    leftovers = [vneg(vminf(vsub(pcr[i], reduction[i]), 0.0)) for i in range(4)]
    distributed = [vmaxf(vsub(vsub(vsub(pcr[i], reduction[i]), leftovers[(i + 3) % 4]), leftovers[(i + 1) % 4]), 0.0) for i in range(4)]
    scale = []
    for i in range(4):
        unshrinkable = vmaxf(vsub(vadd(leftovers[(i + 1) % 4], leftovers[(i + 3) % 4]), distributed[i]), 0.0)
        den = vmaxf(vsub(pcr[i], unshrinkable), FLT_EPSILON)
        scale.append((f32(distributed[i][0] / den[0]), f32(distributed[i][1] / den[1])))
    return scale


def corner_centres(r, radius, scale):
    x, y, w, h = r
    return [
        (f32(x + f32(radius[0] * scale[0][0])), f32(y + f32(radius[0] * scale[0][1]))),
        (f32(f32(x + w) - f32(radius[1] * scale[1][0])), f32(y + f32(radius[1] * scale[1][1]))),
        (f32(f32(x + w) - f32(radius[2] * scale[2][0])), f32(f32(y + h) - f32(radius[2] * scale[2][1]))),
        (f32(x + f32(radius[3] * scale[3][0])), f32(f32(y + h) - f32(radius[3] * scale[3][1]))),
    ]


def draw_rounded_rectangle(acc, role, style_rect, corner_radius, ring_rect, inner_rect, inner_color, outer_color, corner_detail, skew, is_filled=False):
    """sbf:313-434; appends to acc and records the call as one part (a coverage shape)."""
    verts, colours, indices = acc["verts"], acc["colors"], acc["indices"]
    vert_offset = len(verts)
    index_offset = len(indices)
    detail = corner_detail if any(r > 0 for r in corner_radius) else 1
    draw_border = not is_filled
    ring_radius = set_inner_corner_radius(style_rect, ring_rect, corner_radius)
    ring_scale = set_corner_scale(style_rect, ring_rect, ring_radius)
    outer_points = corner_centres(ring_rect, ring_radius, ring_scale)
    inner_radius = set_inner_corner_radius(style_rect, inner_rect, corner_radius)
    inner_scale = set_corner_scale(style_rect, inner_rect, inner_radius)
    inner_points = corner_centres(inner_rect, inner_radius, inner_scale)
    quarter_arc = f32(math.pi / 2.0)
    centre = (f32(style_rect[0] + f32(style_rect[2] * 0.5)), f32(style_rect[1] + f32(style_rect[3] * 0.5)))
    count = (detail + 1) * (8 if draw_border else 4)
    new_verts = [None] * count
    new_colours = [None] * count

    def vertex(radius, scale, point, cosine, sine):
        x = f32(f32(f32(radius * cosine) * scale[0]) + point[0])
        y = f32(f32(f32(radius * sine) * scale[1]) + point[1])
        x_skew = f32(-skew[0] * f32(y - centre[1]))
        y_skew = f32(-skew[1] * f32(x - centre[0]))
        return (nz(f32(x + x_skew)), nz(f32(y + y_skew)))

    for corner in range(4):
        for d in range(detail + 1):
            k = (detail + 1) * corner + d
            if draw_border:
                k *= 2
            angle = f32((corner + d / detail) * quarter_arc + math.pi)
            cosine = f32(math.cos(angle))
            sine = f32(math.sin(angle))
            new_verts[k] = vertex(inner_radius[corner], inner_scale[corner], inner_points[corner], cosine, sine)
            new_colours[k] = inner_color
            if draw_border:
                new_verts[k + 1] = vertex(ring_radius[corner], ring_scale[corner], outer_points[corner], cosine, sine)
                new_colours[k + 1] = outer_color
    verts.extend(new_verts)
    colours.extend(new_colours)
    if draw_border:
        for i in range(count):
            indices.extend([vert_offset + i % count, vert_offset + (i + 2) % count, vert_offset + (i + 1) % count])
    if is_filled:
        last = count - 1
        for i in range(count // 2 - 1):
            indices.extend([vert_offset + i, vert_offset + last - i - 1, vert_offset + i + 1, vert_offset + i, vert_offset + last - i, vert_offset + last - i - 1])
    acc["parts"].append({"role": role, "v": (vert_offset, len(verts)), "i": (index_offset, len(indices))})


def adapt_values(a, b, adapted, values, width, max_a, max_b):
    """sbf:436-443."""
    va, vb = values[a], values[b]
    total = f32(va + vb)
    factor = cmin(1.0, f32(width / total) if total != 0 else math.inf)
    adapted[a] = cmin(cmin(f32(va * factor), max_a), adapted[a])
    adapted[b] = cmin(cmin(f32(vb * factor), max_b), adapted[b])


def stylebox_flat(rect, sb):
    """StyleBoxFlat::draw (sbf:456-647): (indices, verts, colours, uvs, parts), or None."""
    border = [f32(v) for v in sb["border"]]
    draw_border = any(v > 0 for v in border)
    draw_shadow = sb["shadow_size"] > 0
    draw_center = sb["draw_center"]
    if not draw_border and not draw_center and not draw_shadow:
        return None
    e = [f32(v) for v in sb["expand"]]
    style_rect = grow_individual(rect, e[0], e[1], e[2], e[3])
    corner = [f32(v) for v in sb["corner"]]
    skew = (f32(sb["skew"][0]), f32(sb["skew"][1]))
    rounded = any(v > 0 for v in corner)
    aa_on = (rounded or not (abs(skew[0]) < 1e-5 and abs(skew[1]) < 1e-5)) and sb["anti_aliased"]
    bg = [f32(v) for v in sb["bg"]]
    border_color = [f32(v) for v in sb["border_color"]]
    border_alpha = border_color[:3] + [0.0]
    border_blend = bg if draw_center else border_alpha
    border_inner = border_color  # blend_border is off

    width = cmax(style_rect[2], 0.0)
    height = cmax(style_rect[3], 0.0)
    ab = [1000000.0] * 4
    adapt_values(SIDE_TOP, SIDE_BOTTOM, ab, border, height, height, height)
    adapt_values(SIDE_LEFT, SIDE_RIGHT, ab, border, width, width, width)
    ac = [1000000.0] * 4
    adapt_values(CORNER_TOP_RIGHT, CORNER_BOTTOM_RIGHT, ac, corner, height, f32(height - ab[SIDE_BOTTOM]), f32(height - ab[SIDE_TOP]))
    adapt_values(CORNER_TOP_LEFT, CORNER_BOTTOM_LEFT, ac, corner, height, f32(height - ab[SIDE_BOTTOM]), f32(height - ab[SIDE_TOP]))
    adapt_values(CORNER_TOP_LEFT, CORNER_TOP_RIGHT, ac, corner, width, f32(width - ab[SIDE_RIGHT]), f32(width - ab[SIDE_LEFT]))
    adapt_values(CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT, ac, corner, width, f32(width - ab[SIDE_RIGHT]), f32(width - ab[SIDE_LEFT]))

    infill = grow_individual(style_rect, -ab[0], -ab[1], -ab[2], -ab[3])
    border_style_rect = style_rect
    aa = f32(sb["aa_size"])  # / the root's stretch scale, 1 here (sbf:497-512)
    if aa_on:
        for side in range(4):
            if border[side] > 0:
                border_style_rect = grow_side(border_style_rect, side, -aa)

    acc = {"verts": [], "colors": [], "indices": [], "parts": []}
    detail = sb["corner_detail"]
    if draw_shadow:
        off = (f32(sb["shadow_offset"][0]), f32(sb["shadow_offset"][1]))
        shadow_inner = (f32(style_rect[0] + off[0]), f32(style_rect[1] + off[1]), style_rect[2], style_rect[3])
        shadow_rect = grow(style_rect, f32(sb["shadow_size"]))
        shadow_rect = (f32(shadow_rect[0] + off[0]), f32(shadow_rect[1] + off[1]), shadow_rect[2], shadow_rect[3])
        sc = [f32(v) for v in sb["shadow_color"]]
        draw_rounded_rectangle(acc, "shadow", shadow_inner, ac, shadow_rect, shadow_inner, sc, sc[:3] + [0.0], detail, skew)
        if draw_center:
            draw_rounded_rectangle(acc, "shadow_fill", shadow_inner, ac, shadow_inner, shadow_inner, sc, sc, detail, skew, True)
    if draw_border and not aa_on:
        draw_rounded_rectangle(acc, "border", border_style_rect, ac, border_style_rect, infill, border_inner, border_color, detail, skew)
    if draw_center and not aa_on:
        draw_rounded_rectangle(acc, "fill", border_style_rect, ac, infill, infill, bg, bg, detail, skew, True)
    if aa_on:
        half = f32(aa * 0.5)
        if draw_border:
            border_w = [aa if border[i] > 0 else 0.0 for i in range(4)]
            border_h = [half if border[i] > 0 else 0.0 for i in range(4)]
            fill_w = [0.0 if border[i] > 0 else aa for i in range(4)]
            fill_h = [0.0 if border[i] > 0 else half for i in range(4)]
        else:
            border_w = border_h = [0.0] * 4
            fill_w = [aa] * 4
            fill_h = [half] * 4
        if draw_center:
            transparent = grow_individual(infill, *fill_h)
            coloured = grow_individual(transparent, *[-v for v in fill_w])
            draw_rounded_rectangle(acc, "fill", border_style_rect, ac, coloured, coloured, bg, bg, detail, skew, True)
            draw_rounded_rectangle(acc, "aa_fill", border_style_rect, ac, transparent, coloured, bg, bg[:3] + [0.0], detail, skew)
        if draw_border:
            inner_coloured = grow_individual(infill, *border_h)
            inner_transparent = grow_individual(inner_coloured, *[-v for v in border_w])
            outer_transparent = grow_individual(style_rect, *border_h)
            outer_coloured = grow_individual(border_style_rect, *border_h)
            draw_rounded_rectangle(acc, "border", border_style_rect, ac, outer_coloured, inner_coloured, border_inner, border_color, detail, skew)
            draw_rounded_rectangle(acc, "aa_inner", border_style_rect, ac, inner_coloured, inner_transparent, border_blend, border_color, detail, skew)
            draw_rounded_rectangle(acc, "aa_outer", border_style_rect, ac, outer_transparent, outer_coloured, border_color, border_alpha, detail, skew)

    uv_rect = grow(style_rect, aa if aa_on else 0.0)
    uvs = [(nz(f32(f32(v[0] - uv_rect[0]) / uv_rect[2])), nz(f32(f32(v[1] - uv_rect[1]) / uv_rect[3]))) for v in acc["verts"]]
    return acc["indices"], acc["verts"], acc["colors"], uvs, acc["parts"]


# --------------------------------------------------------------------------------------------
# The scene: per item, the RS calls its draw makes and their coverage
# --------------------------------------------------------------------------------------------


def colour(c):
    return [f32(v) for v in c]


def flat_box_draw(name, rect, sb):
    """(calls, coverage shapes) of StyleBox::draw for a StyleBoxFlat."""
    lowered = stylebox_flat(rect, sb)
    if lowered is None:
        return [], []
    indices, verts, colours, uvs, parts = lowered
    call = g5.call(
        "canvas_item_add_triangle_array",
        ulp=2,
        indices=indices,
        points=[list(v) for v in verts],
        colors=[colour(c) for c in colours],
        uvs=[list(u) for u in uvs],
        bones=[],
        weights=[],
        texture=None,
        count=-1,
    )
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
            # Only alpha gradients occur (antialiasing and shadow rings): band, D13.
            assert all(c[:3] == cols[0][:3] for c in cols), (name, part["role"])
            width = sb["shadow_size"] if part["role"] == "shadow" else sb["aa_size"]
            shape["band_px"] = width / 2 + 1
        shapes.append(shape)
    return [call], shapes


def nine_patch_draw(name, rect, axis, centre, modulate):
    args = {
        "rect": [f32(v) for v in rect],
        "source": [0.0, 0.0, 0.0, 0.0],
        "texture": "TEXN",
        "topleft": [4.0, 4.0],
        "bottomright": [4.0, 4.0],
        "x_axis": axis,
        "y_axis": axis,
        "draw_center": centre,
        "modulate": colour(modulate),
    }
    shape = {"name": name, "kind": "nine_patch", "rect": args["rect"], "texture": "TEXN", "margins": [4.0, 4.0, 4.0, 4.0], "x_axis": axis, "y_axis": axis, "draw_center": centre, "modulate": args["modulate"]}
    return [g5.call("canvas_item_add_nine_patch", **args)], [shape]


def item_nine_patch(name):
    def draw(state):
        w, h = state["np_size"]
        axis, centre = NINE_PATCH_MODE[name]
        return nine_patch_draw(name, [0, 0, w, h], axis, centre, [1, 1, 1, 1])

    return draw


def item_texture_box(state):
    """StyleBoxTexture::draw: the rect grown by the expand margins (4), texture margins 4."""
    w, h = SIZE["TX"]
    return nine_patch_draw("TX", [-4, -4, w + 8, h + 8], "stretch", True, state["tx_modulate"])


def item_flat(name, make):
    def draw(state):
        w, h = SIZE[name]
        return flat_box_draw(name, (0.0, 0.0, f32(w), f32(h)), make(state))

    return draw


FLAT_BOXES = {
    "SF": lambda s: box(bg=s["sf_bg"]),
    "SB": lambda s: box(bg=[0.2, 0.4, 0.8, 1], border_color=[1, 1, 0.6, 1], border=[s["sb_border_left"], 4, 6, 8]),
    "SR": lambda s: box(bg=[1, 0.4, 0.4, 1], corner=[s["sr_radius"]] * 4),
    "SS": lambda s: box(bg=[0.8, 0.8, 0.2, 1], shadow_size=4, shadow_offset=s["ss_offset"]),
    "SK": lambda s: box(bg=[0.6, 0.4, 1, 1], skew=(0.2, 0.0)),
    "DP": lambda s: THEME_PANEL,
}
FL_BOX = box(bg=[0.2, 0.6, 0.6, 1], border_color=[1, 0.8, 0.4, 1], border=[2, 2, 2, 6])


def item_flip(state):
    """TabBar's flip: set_transform((0, h), 0, (1, -1)), the box, set_transform(identity)."""
    w, h = SIZE["FL"]
    flip = [1.0, 0.0, 0.0, -1.0, 0.0, f32(h)]
    identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    calls, shapes = flat_box_draw("FL", (0.0, 0.0, f32(w), f32(h)), FL_BOX)
    calls = [g5.call("canvas_item_add_set_transform", ulp=2, transform=flip), *calls, g5.call("canvas_item_add_set_transform", ulp=2, transform=identity)]
    ops = [{"op": "set_transform", "transform": flip}, *shapes, {"op": "set_transform", "transform": identity}]
    return calls, ops


def item_rich_text(state):
    """The empty normal box draws nothing; the focus box only while focused, between clip-ignores."""
    if not state["rt_focus"]:
        return [], []
    w, h = SIZE["RT"]
    calls, shapes = flat_box_draw("RT", (0.0, 0.0, f32(w), f32(h)), THEME_FOCUS)
    calls = [g5.call("canvas_item_add_clip_ignore", ignore=True), *calls, g5.call("canvas_item_add_clip_ignore", ignore=False)]
    ops = [{"op": "clip_ignore", "ignore": True}, *shapes, {"op": "clip_ignore", "ignore": False}]
    return calls, ops


def item_nothing(_state):
    return [], []


def item_marker(step):
    def draw(_state):
        rect, col = [0, 0, 32, 32], MARKER_COLOURS[step]
        return [g5.draw_rect_call(rect, col)], [g5.rect_shape("M", rect, col)]

    return draw


DRAWERS = {
    "NS": item_nine_patch("NS"),
    "NT": item_nine_patch("NT"),
    "NF": item_nine_patch("NF"),
    "NH": item_nine_patch("NH"),
    "TX": item_texture_box,
    **{name: item_flat(name, make) for name, make in FLAT_BOXES.items()},
    "FL": item_flip,
    "RT": item_rich_text,
    "RT_VScrollBar": item_nothing,
}


def texture_table():
    def rgba8(c):
        return [round(v * 255) for v in c]

    texels = []
    for y in range(16):
        for x in range(16):
            if 4 <= x < 12 and 4 <= y < 12:
                cx, cy = (x - 4) // 2, (y - 4) // 2
                c = TEXN_MARK if cx == 0 and cy == 0 else (TEXN_A if (cx + cy) % 2 == 0 else TEXN_B)
            else:
                c = TEXN_BORDER
            texels.append(rgba8(c))
    return {"TEXN": {"width": 16, "height": 16, "rgba8_hex": "".join(f"{v:02x}" for t in texels for v in t)}}


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def build_steps(op_lists):
    state = copy.deepcopy(INITIAL)
    recorded = {}
    steps = []
    for step in range(LAST_STEP + 1):
        if step == 0:
            redraws = list(CREATION_ORDER)
        else:
            redraws = []
            for prop, value in TIMELINE.get(step, []):
                state[prop] = value
                for item in REDRAWN_BY.get(prop, []):
                    if item not in redraws:
                        redraws.append(item)
            redraws.append("Marker")
        calls = {}
        for name in redraws:
            drawer = item_marker(step) if name == "Marker" else DRAWERS[name]
            item_calls, item_ops = drawer(state)
            recorded[name] = f"{name}@{step}"
            op_lists[recorded[name]] = item_ops
            calls.setdefault(REGION_OF[name], []).extend({"item": name, **c} for c in item_calls)
        cx, cy = state["canvas"]
        items = []
        for name in CREATION_ORDER:
            px, py = POSITION[name]
            if name == "DP":
                px, py = px + state["dp_offset"][0], py + state["dp_offset"][1]
            ox, oy = px + cx, py + cy
            clip = [ox, oy, ox + SIZE[name][0], oy + SIZE[name][1]] if name in CLIPS else None
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
    for k, s in enumerate(steps):
        fresh = {}
        for region in REGIONS:
            if k == 0:
                fresh[region] = True
                continue

            def content(items, region=region):
                # An item that draws nothing contributes no pixels wherever it is.
                return [{**i, "ops": op_lists[i["ops"]]} for i in items if i["region"] == region and op_lists[i["ops"]]]

            fresh[region] = content(s["items"]) != content(steps[k - 1]["items"])
        s["fresh"] = fresh
    return steps


# --------------------------------------------------------------------------------------------
# Self-consistency (the colour rule, regions, tie-freeness, the census, freshness)
# --------------------------------------------------------------------------------------------


def check(steps, op_lists):
    def on_grid(v):
        return any(abs(v - g) < 1e-6 for g in GRID)

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
            if item["clip_px"] is not None:
                c = item["clip_px"]
                assert region[0] <= c[0] < c[2] <= region[2] and region[1] <= c[1] < c[3] <= region[3], (s["step"], item["name"], c)
            for shape, m, clip in g5.walk_shapes(item, op_lists):
                band = "band_px" in shape
                if shape["name"] not in THEME_SHAPES:
                    cols = shape.get("colors", []) + ([shape["modulate"]] if "modulate" in shape else [])
                    for c in cols:
                        assert all(on_grid(f32(v)) for v in c[:3]), (shape["name"], c)
                        a = c[3]
                        alpha_ok = abs(a - 1) < 1e-6 or (shape["name"] in TRANSLUCENT_SHAPES and abs(a - 0.6) < 1e-6) or (band and (abs(a) < 1e-6 or abs(a - 0.6) < 1e-6))
                        assert alpha_ok, (shape["name"], c)
                pad = shape.get("band_px", 0)
                for p in [] if clip is not None else g5.shape_points(shape):
                    x, y = g5.apply(m, p)
                    assert region[0] <= x - pad and x + pad <= region[2] and region[1] <= y - pad and y + pad <= region[3], (s["step"], item["name"], shape["name"], (x, y), region)
                if shape["kind"] != "mesh" or band:
                    continue
                verts = [g5.apply(m, v) for v in shape["vertices"]]
                for a, b in g5.boundary_edges(shape):
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
    fresh_hand = {1: {"SF"}, 2: {"NS", "NT", "NF", "NH"}, 3: {"SB"}, 4: {"RT"}, 5: {"DP"}, 6: {"SR"}, 7: {"SS"}, 8: {"TX"}, 9: set(REGIONS) - {"RT"}}
    for k, want in fresh_hand.items():
        got = {r for r, f in steps[k]["fresh"].items() if f}
        assert got == want | {"Marker"}, f"step {k}: fresh {sorted(got)} != hand {sorted(want)}"
    return calls_by_op, tie_checked


# --------------------------------------------------------------------------------------------
# Lowering predictions (Q1h) and the receiver sabotage's prediction
# --------------------------------------------------------------------------------------------


def lowering_predictions(steps):
    """Per StyleBoxFlat item, the triangle array's vertex and index counts at every redraw: the
    port's must equal Q1h's hand counts (HAND_LOWERING), and they never change with a step."""
    out = {}
    for s in steps:
        for region_calls in s["calls"].values():
            for c in region_calls:
                if c["op"] != "canvas_item_add_triangle_array":
                    continue
                got = {"op": c["op"], "vertices": len(c["points"]), "indices": len(c["indices"]), "colors": len(c["colors"]), "uvs": len(c["uvs"])}
                if c["item"] in out:
                    assert out[c["item"]] == got, (s["step"], c["item"], got, out[c["item"]])
                out[c["item"]] = got
    for item, (v, i) in HAND_LOWERING.items():
        assert (out[item]["vertices"], out[item]["indices"]) == (v, i), f"{item}: lowered {out[item]} != Q1h's {v}/{i}"
        assert out[item]["colors"] == v and out[item]["uvs"] == v, out[item]
    assert set(out) == set(HAND_LOWERING), sorted(out)
    return dict(sorted(out.items()))


def predictions(steps):
    """sabotage-style-receiver-ignore-axis: the receiver draws every nine-patch axis as stretch, so
    a region mismatches at a step exactly when one of its nine-patches has a tile or tile_fit axis
    (TEXN's centre is not uniform and no size makes tile equal stretch here)."""
    ignore_axis = {}
    for s in steps:
        for item in s["items"]:
            # The op list in force is the one recorded last; every nine-patch shape carries its axes.
            for op in OP_LISTS[item["ops"]]:
                if op.get("kind") == "nine_patch" and (op["x_axis"] != "stretch" or op["y_axis"] != "stretch"):
                    ignore_axis.setdefault(item["region"], [])
                    if s["step"] not in ignore_axis[item["region"]]:
                        ignore_axis[item["region"]].append(s["step"])
    assert ignore_axis == {"NT": list(range(LAST_STEP + 1)), "NF": list(range(LAST_STEP + 1))}, ignore_axis
    # The focus box and its clip_ignore pair: in RT's command list exactly while it has focus.
    focus = [s["step"] for s in steps if any(op.get("op") == "clip_ignore" for i in s["items"] if i["name"] == "RT" for op in OP_LISTS[i["ops"]])]
    assert focus == [0, 1, 2, 3], focus
    return {"sabotage-style-receiver-ignore-axis": {"regions": ignore_axis}, "focus-clip-ignore": {"steps": focus}}


OP_LISTS = {}


def build():
    OP_LISTS.clear()
    steps = build_steps(OP_LISTS)
    calls_by_op, tie_checked = check(steps, OP_LISTS)
    return {
        "schema": "render-stream-gate5-expected/1",
        "fixture": "gate5-style",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        # invisible (vscroll->hide(), rich_text_label.cpp:8069): no draw, no derived scissor
        "hidden_items": ["RT_VScrollBar"],
        "regions": REGIONS,
        "marker_rect": [592, 16, 32, 32],
        "exact_edge_px": 1 / 16,
        "aa_band_px": AA_SIZE / 2 + 1,
        "thin_band_px": g5.THIN_BAND_PX,
        "translucent_shapes": TRANSLUCENT_SHAPES,
        "theme_shapes": THEME_SHAPES,
        "textures": texture_table(),
        "engine_textures": ENGINE_TEXTURES,
        "hook_census": dict(sorted(calls_by_op.items())),
        "typed_ops": TYPED_OPS,
        "calibrator7_ops": [],
        "tie_free_edges_checked": tie_checked,
        "lowering_predictions": lowering_predictions(steps),
        "op_lists": dict(OP_LISTS),
        "steps": steps,
        "predictions": predictions(steps),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed file")
    args = parser.parse_args()
    text = g5.render(build())
    if args.check:
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        # Prettier may reflow the committed JSON; compare values, not bytes.
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
