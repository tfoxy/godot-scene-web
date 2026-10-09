#!/usr/bin/env python3
"""Write fixtures/gate2/expected.json (render-stream-gate2-expected/1).

The derivation of every number below is by hand from the engine source
(gate2-design.md Q1), written down as code so the eleven steps stay consistent
with each other. Nothing here runs or reads the engine: the reference run has to
agree with it (`expected-image-reference`, `census`), and a disagreement is a
finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate2/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate2/make_expected.py --check   # diff only

Derivation notes (source lines are in ../godot-4.5.1-stable):

- Sprite2D draws texture->draw_rect_region(dst, src) with dst = (offset, frame size) and a
  negative width/height for flip_h/flip_v (scene/2d/sprite_2d.cpp:95-130, :158-170). Every
  sprite here is centered = false, so dst starts at (0, 0) in the sprite's space and a flip
  mirrors it in place: the canvas cull makes the size positive and sets FLIP_H/FLIP_V
  without moving the rect (servers/rendering/renderer_canvas_cull.cpp:1610-1648).
- TextureRect STRETCH_SCALE/TILE draws draw_texture_rect(Rect2(0, size), tile) with a negative
  width for flip_h (scene/gui/texture_rect.cpp:35-99). TILE sets TILE|REGION with source =
  |rect size| in texels (renderer_canvas_cull.cpp:1513-1542) and GLES3 forces repeat ENABLED
  for it (drivers/gles3/rasterizer_canvas_gles3.cpp:936-939).
- GLES3 samples a rect as uv = src.xy + |src.zw| * (transpose ? b.yx : b.xy) with b the
  vertex's base position mirrored per flipped axis (drivers/gles3/shaders/canvas.glsl:225-227):
  for a destination fraction f, b = (flip_h ? 1 - f.x : f.x, flip_v ? 1 - f.y : f.y). That is
  what synthesizeGate2 (scripts/lib/gate2-expected.ts) does, at pixel centres, nearest.
- S3's step-2 transform x = (0, 2), y = (-2, 0), origin (352, 40) maps local (lx, ly) to
  (352 - 2 ly, 40 + 2 lx): over its 32x32 destination at (320, 40) the texel is
  (16 f.y, 16 (1 - f.x)), i.e. transpose with flip_h in the sampling above.
- A freed texture RID a command still names binds the default white texture
  (rasterizer_canvas_gles3.cpp:2340-2342, :2360-2378): RAW1 is white from step 8 (D11's
  prediction).
- A placeholder is the 4x4 RGBA8 magenta/black checker, magenta where x + y is even
  (drivers/gles3/storage/texture_storage.cpp:235-242).
- Census: every CanvasItem entering the tree calls canvas_item_set_default_texture_filter and
  _repeat once (scene/main/canvas_item.cpp:358-360, :1602-1605, :1656-1659); set_texture_filter
  / _repeat call it once more for the item itself (no inheriting children here); the root
  viewport's setter calls viewport_set_default_canvas_item_texture_filter once per change
  (scene/main/viewport.cpp:3903-3925); ImageTexture.create_from_image is one texture_2d_create,
  set_image on a texture with a RID is texture_2d_create + texture_replace, update is one
  texture_2d_update, and dropping the last reference is one free
  (scene/resources/image_texture.cpp:75-131, :243-248).
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")

S, N, SETTLE = 1, 10, 7
LAST_STEP = 10
QUIT = S + N * LAST_STEP + SETTLE + 4

WHITE = [255, 255, 255, 255]

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
]


def rgba(fill, rects=(), width=16, height=16, mipmaps=False, fmt="RGBA8"):
    return {
        "format": fmt,
        "width": width,
        "height": height,
        "mipmaps": mipmaps,
        "fill": fill,
        "rects": [list(r) for r in rects],
    }


def checker(even, odd, width, height, fmt, mipmaps=False):
    return {
        "format": fmt,
        "width": width,
        "height": height,
        "mipmaps": mipmaps,
        "checker": {"even": even, "odd": odd},
    }


# Contents, sampled as RGBA8 (an LA8 texel L, A samples as (L, L, L, A)).
TEXTURES = {
    "A0": rgba(
        [0, 0, 0, 255],
        [
            (0, 0, 8, 8, 255, 0, 0, 255),
            (8, 0, 8, 8, 0, 255, 0, 255),
            (0, 8, 8, 8, 0, 0, 255, 255),
            (8, 8, 8, 8, 255, 255, 255, 255),
        ],
    ),
    "A1": rgba(
        [0, 0, 0, 255],
        [
            (0, 0, 8, 8, 51, 102, 153, 255),
            (8, 0, 8, 8, 204, 153, 102, 255),
            (0, 8, 8, 8, 102, 204, 51, 255),
            (8, 8, 8, 8, 0, 0, 0, 255),
        ],
    ),
    "A2": rgba(
        [0, 0, 0, 255],
        [
            (0, 0, 16, 16, 255, 153, 0, 255),
            (16, 0, 16, 16, 153, 0, 255, 255),
            (0, 16, 16, 16, 0, 153, 153, 255),
            (16, 16, 16, 16, 153, 153, 153, 255),
        ],
        32,
        32,
    ),
    "B0": checker([255, 255, 255, 255], [0, 0, 0, 0], 4, 4, "LA8"),
    "B1": checker([255, 255, 255, 102], [0, 0, 0, 0], 4, 4, "RGBA8"),
    "M": checker([255, 255, 255, 255], [0, 0, 0, 255], 64, 64, "RGBA8", mipmaps=True),
    "PH": dict(checker([255, 0, 255, 255], [0, 0, 0, 255], 4, 4, "RGBA8"), engine_defined=True),
    "C": rgba([102, 204, 255, 255], [(0, 0, 8, 8, 255, 51, 153, 255)]),
    "C_after_fill": rgba([0, 0, 0, 255]),
    "D": rgba([153, 102, 51, 255], [(8, 8, 8, 8, 0, 255, 102, 255)]),
    "E": rgba([51, 255, 204, 255], [(0, 0, 4, 1, 255, 102, 0, 255)], 4, 4),
    "ANIM": {
        "format": "RGBA8",
        "width": 8,
        "height": 8,
        "mipmaps": False,
        "frame_fill": [[k * 51, 255 - k * 51, 102, 255] for k in range(6)],
    },
    "U1": {"format": "RGBAF", "width": 4, "height": 4, "mipmaps": False, "fill": [51, 153, 255, 255], "rects": []},
    "PRE": rgba([204, 51, 204, 255], [], 4, 4),
}

# The texture objects the fixture makes, and the content each shows from a step on.
TEXTURE_OBJECTS = {
    "A": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "A0"], [6, "A1"], [7, "A2"]]},
    "Atwin": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "A0"]], "freed_step": 8},
    "B": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "B0"], [7, "B1"]]},
    "M": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "M"]]},
    "P1": {"kind": "placeholder", "created_step": 0, "thread": "main", "contents": [[0, "PH"]], "freed_step": 8},
    "P2": {"kind": "placeholder", "created_step": 0, "thread": "main", "contents": [[0, "PH"], [9, "E"]]},
    "C": {"kind": "image", "created_step": 8, "thread": "main", "contents": [[8, "C"]]},
    "D": {"kind": "image", "created_step": 8, "thread": "other", "contents": [[8, "D"]]},
    "E": {"kind": "image", "created_step": 9, "thread": "main", "contents": [[9, "E"]], "replaced_into": "P2"},
}

VARIANT_TEXTURE_OBJECTS = {
    "animate": {"ANIM": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "ANIM"]]}},
    "unsupported": {
        "U1": {"kind": "image", "created_step": 0, "thread": "main", "contents": [[0, "U1"]], "status": "unsupported", "reason": "unsupported-format"},
        "PRE": {"kind": "image", "created_step": None, "thread": "main", "contents": [[0, "PRE"]], "unknown": True},
    },
}


def a_content(step):
    return "A0" if step < 6 else ("A1" if step < 7 else "A2")


def size_of(content):
    return TEXTURES[content]["width"]


def g_offset(step):
    return (0, 0) if step < 2 else ((0, 200) if step < 10 else (0, 224))


def canvas_offset(step):
    return (8, 4) if step == 10 else (0, 0)


def sample(texture, src, flip_h=False, flip_v=False, transpose=False, tile=False, repeat="disabled"):
    return {
        "texture": texture,
        "src_px": list(src),
        "flip_h": flip_h,
        "flip_v": flip_v,
        "transpose": transpose,
        "tile": tile,
        "repeat": repeat,
        "modulate": WHITE,
    }


def shift(rect, dx, dy):
    return [rect[0] + dx, rect[1] + dy, rect[2], rect[3]]


def regions(step):
    gx, gy = g_offset(step)
    base = {
        "s1": [32 + gx, 32 + gy, 80, 80],
        "s2": [112 + gx, 32 + gy, 80, 80],
        "tr": [192, 32, 64, 48],
        "dr": [256, 32, 48, 48],
        "s3": [312, 32, 48, 48],
        "bg": [360, 24, 64, 64],
        "sb": [376, 40, 32, 32],
        "raw1": [424, 32, 48, 48],
        "raw2": [472, 32, 48, 48],
        "sd": [32, 112, 48, 48],
        "mm": [112, 112, 32, 32],
        "marker": [584, 8, 48, 48],
    }
    cx, cy = canvas_offset(step)
    return {name: shift(rect, cx, cy) for name, rect in base.items()}


def draws(step):
    gx, gy = g_offset(step)
    a = a_content(step)
    aw = size_of(a)
    out = []
    # S1: A at 2x, flip_h from step 1.
    out.append({"name": "S1", "rect_px": [40 + gx, 40 + gy, 2 * aw, 2 * aw], "sample": sample(a, (0, 0, aw, aw), flip_h=step >= 1)})
    # S2: A at 2x, flip_v from step 1; from step 3 a 16x16 region (clip_uv, linear filter).
    if step < 3:
        out.append({"name": "S2", "rect_px": [120 + gx, 40 + gy, 2 * aw, 2 * aw], "sample": sample(a, (0, 0, aw, aw), flip_v=step >= 1)})
    else:
        out.append({"name": "S2", "rect_px": [120 + gx, 40 + gy, 32, 32], "sample": sample(a, (0, 0, 16, 16), flip_v=True)})
    # TR: TextureRect, STRETCH_SCALE 32x32 (whole texture), flip_h from step 1; from step 5 TILE
    # 48x32 (source = the rect's size in texels, repeat forced on).
    if step < 5:
        out.append({"name": "TR", "rect_px": [200, 40, 32, 32], "sample": sample(a, (0, 0, aw, aw), flip_h=step >= 1)})
    else:
        out.append({"name": "TR", "rect_px": [200, 40, 48, 32], "sample": sample(a, (0, 0, 48, 32), flip_h=True, tile=True, repeat="enabled")})
    # DR: step 0 source (4,4,8,8); steps 1-4 source (4,0,8,8) transposed; from step 5 source
    # (0,0,32,32) under the item's MIRROR repeat.
    if step == 0:
        out.append({"name": "DR", "rect_px": [264, 40, 32, 32], "sample": sample(a, (4, 4, 8, 8))})
    elif step < 5:
        out.append({"name": "DR", "rect_px": [264, 40, 32, 32], "sample": sample(a, (4, 0, 8, 8), transpose=True)})
    else:
        out.append({"name": "DR", "rect_px": [264, 40, 32, 32], "sample": sample(a, (0, 0, 32, 32), repeat="mirror")})
    # S3: Atwin at 2x; from step 2 rotated by its transform (transpose + flip_h in sampling);
    # from step 8 C, which shows its content at the create, not the black fill after it.
    s3_texture = "A0" if step < 8 else "C"
    out.append({"name": "S3", "rect_px": [320, 40, 32, 32], "sample": sample(s3_texture, (0, 0, 16, 16), transpose=step >= 2, flip_h=step >= 2)})
    # BG: two add_rects; SB: B at 8x over them (binary alpha until step 7).
    out.append({"name": "BG", "rect_px": [368, 32, 24, 48], "rgba8": [204, 51, 51, 255]})
    out.append({"name": "BG", "rect_px": [392, 32, 24, 48], "rgba8": [51, 204, 51, 255]})
    out.append({"name": "SB", "rect_px": [376, 40, 32, 32], "sample": sample("B0" if step < 7 else "B1", (0, 0, 4, 4))})
    # SD: D at 2x from step 8; MM: M at a quarter from step 9 (linear, mipmaps).
    if step >= 8:
        out.append({"name": "SD", "rect_px": [40, 120, 32, 32], "sample": sample("D", (0, 0, 16, 16))})
    if step >= 9:
        out.append({"name": "MM", "rect_px": [120, 120, 16, 16], "sample": sample("M", (0, 0, 64, 64))})
    out.append({"name": "Marker", "rect_px": [592, 16, 32, 32], "rgba8": MARKER[step]})
    # RAW1/RAW2 (draw indices 1000/1001, painted last): placeholders at 8x; P1 freed at step 8
    # draws white; P2 replaced by E at step 9.
    if step < 8:
        out.append({"name": "RAW1", "rect_px": [432, 40, 32, 32], "sample": sample("PH", (0, 0, 4, 4))})
    else:
        out.append({"name": "RAW1", "rect_px": [432, 40, 32, 32], "rgba8": WHITE})
    out.append({"name": "RAW2", "rect_px": [480, 40, 32, 32], "sample": sample("PH" if step < 9 else "E", (0, 0, 4, 4))})
    cx, cy = canvas_offset(step)
    for d in out:
        d["rect_px"] = shift(d["rect_px"], cx, cy)
    return out


def synth_exclude(step):
    out = []
    if step == 4:
        # The root default is LINEAR: every texture drawer whose item filter is DEFAULT.
        out += ["s1", "tr", "dr", "s3", "sb", "raw1", "raw2"]
    if step >= 3:
        out.append("s2")  # S2's own LINEAR filter
    if step >= 7 and "sb" not in out:
        out.append("sb")  # B1's alpha .4
    if step >= 9:
        out.append("mm")  # LINEAR_WITH_MIPMAPS
    return sorted(out)


# RenderingServer texture calls the engine makes on its own inside a step's window. The default
# theme (built at startup, before the extension arms) gives ColorPicker an 800x6 GradientTexture2D
# hue strip (scene/theme/default_theme.cpp:1093-1097); setting its gradient queues a deferred
# update_now (scene/resources/gradient_texture.cpp:220-225), which the first MessageQueue flush
# after arming runs in frame 1. Nothing has asked for its RID yet, so it is a plain
# texture_2d_create (:273-278), not a placeholder + replace. Measured in every gate 2 leg, headless
# and rendered, and already in gate -1's spike counts (README "Gate -1 result").
ENGINE_TEXTURES = [
    {
        "name": "theme_color_hue",
        "step": 0,
        "op": "texture_2d_create",
        "thread": "main",
        "format": "RGBA8",
        "width": 800,
        "height": 6,
        "mipmaps": False,
        "source": "scene/theme/default_theme.cpp:1093-1097; scene/resources/gradient_texture.cpp:220-225, :273-278",
    }
]

ITEMS_AT_READY = ["G", "S1", "S2", "TR", "DR", "S3", "BG", "SB", "SD", "MM", "Marker"]


def census(step):
    c = {}
    if step == 0:
        # A, Atwin, B, M, and the default theme's ColorPicker hue texture (ENGINE_TEXTURES)
        c["texture_2d_create"] = 4 + len(ENGINE_TEXTURES)
        c["texture_2d_placeholder_create"] = 2  # P1, P2
        c["canvas_item_set_default_texture_filter"] = len(ITEMS_AT_READY)
        c["canvas_item_set_default_texture_repeat"] = len(ITEMS_AT_READY)
    elif step == 3:
        c["canvas_item_set_default_texture_filter"] = 1  # S2
    elif step == 4:
        c["viewport_set_default_canvas_item_texture_filter"] = 1  # LINEAR
    elif step == 5:
        c["viewport_set_default_canvas_item_texture_filter"] = 1  # NEAREST
        c["canvas_item_set_default_texture_repeat"] = 1  # DR MIRROR
    elif step == 6:
        c["texture_2d_update"] = 1  # A
    elif step == 7:
        c["texture_2d_create"] = 2  # A2, B1 (set_image)
        c["texture_replace"] = 2
    elif step == 8:
        c["texture_2d_create"] = 1  # C, main thread
        c["texture_2d_create@other"] = 1  # D, worker thread
        c["free"] = 2  # Atwin, P1
    elif step == 9:
        c["texture_2d_create"] = 1  # E
        c["texture_replace"] = 1  # P2 <- E
        c["canvas_item_set_default_texture_filter"] = 1  # MM
    return dict(sorted(c.items()))


def invariants(step):
    inv = []
    if step == 0:
        inv += [
            {"kind": "tex_shared_hash", "textures": ["A", "Atwin"]},
            {"kind": "tex_kind", "texture": "P1", "value": "placeholder"},
            {"kind": "tex_kind", "texture": "P2", "value": "placeholder"},
            {"kind": "tex_kind", "texture": "M", "value": "image"},
            {"kind": "default_filter", "value": "nearest"},
            {"kind": "repeat", "item": "DR", "value": "default"},
        ]
    if step in (2, 10):
        inv.append({"kind": "no_texture_entries", "step": step - 1})
    if step == 3:
        inv.append({"kind": "filter", "item": "S2", "value": "linear"})
    if step == 4:
        inv.append({"kind": "default_filter", "value": "linear"})
    if step == 5:
        inv += [{"kind": "default_filter", "value": "nearest"}, {"kind": "repeat", "item": "DR", "value": "mirror"}]
    if step == 6:
        inv += [
            {"kind": "tex_same_id", "textures": ["A"], "step": 5},
            {"kind": "tex_version_bumped", "textures": ["A"], "step": 5},
            {"kind": "tex_hash_equals", "texture": "A", "log": {"op": "texture_2d_update", "name": "A", "step": 6}},
            {"kind": "tex_shared_hash", "textures": ["Atwin"], "with_log": {"op": "texture_2d_create", "name": "Atwin", "step": 0}},
        ]
    if step == 7:
        inv += [
            {"kind": "tex_same_id", "textures": ["A", "B"], "step": 6},
            {"kind": "tex_version_bumped", "textures": ["A", "B"], "step": 6},
            {"kind": "tex_hash_equals", "texture": "A", "log": {"op": "texture_2d_create", "name": "A", "step": 7}},
            {"kind": "tex_hash_equals", "texture": "B", "log": {"op": "texture_2d_create", "name": "B", "step": 7}},
        ]
    if step == 8:
        inv += [
            {"kind": "tex_absent", "textures": ["Atwin"]},
            {"kind": "tex_freed", "texture": "P1"},
            {"kind": "tex_new_ids", "textures": ["C", "D"], "step": 7},
            {"kind": "tex_hash_equals", "texture": "C", "log": {"op": "texture_2d_create", "name": "C", "step": 8}},
            {"kind": "tex_hash_equals", "texture": "D", "log": {"op": "texture_2d_create", "name": "D", "step": 8}},
        ]
    if step == 9:
        inv += [
            {"kind": "tex_same_id", "textures": ["P2"], "step": 8},
            {"kind": "tex_kind", "texture": "P2", "value": "image"},
            {"kind": "tex_hash_equals", "texture": "P2", "log": {"op": "texture_2d_create", "name": "E", "step": 9}},
            {"kind": "tex_absent", "textures": ["E"]},
            {"kind": "filter", "item": "MM", "value": "linear_mipmaps"},
        ]
    return inv


def variant(name):
    steps = []
    for step in range(LAST_STEP + 1):
        cx, cy = canvas_offset(step)
        if name == "animate":
            d = [{"name": "ANIM", "rect_px": shift([280, 120, 32, 32], cx, cy), "sample": sample("ANIM", (0, 0, 8, 8))}]
            r = {"anim": shift([272, 112, 48, 48], cx, cy)}
            # ANIM is update()d at every frame of the step's window (the step's frames from its
            # applied frame up to the next one's); step 0 adds its create and item calls.
            c = {"texture_2d_update": N if step < LAST_STEP else None}
            if step == 0:
                c.update({"texture_2d_create": 1, "canvas_item_set_default_texture_filter": 1, "canvas_item_set_default_texture_repeat": 1})
        else:
            d = [
                {"name": "U1", "rect_px": shift([336, 120, 32, 32], cx, cy), "sample": sample("U1", (0, 0, 4, 4))},
                {"name": "U2", "rect_px": shift([392, 120, 32, 32], cx, cy), "sample": sample("PRE", (0, 0, 4, 4))},
            ]
            r = {"u1": shift([328, 112, 48, 48], cx, cy), "u2": shift([384, 112, 48, 48], cx, cy)}
            c = {}
            if step == 0:
                c.update({"texture_2d_create": 1, "canvas_item_set_default_texture_filter": 2, "canvas_item_set_default_texture_repeat": 2})
        steps.append({"step": step, "draws": d, "regions": r, "census_extra": {k: v for k, v in sorted(c.items())}})
    return {"textures": VARIANT_TEXTURE_OBJECTS[name], "steps": steps}


def build():
    steps = []
    for step in range(LAST_STEP + 1):
        steps.append(
            {
                "step": step,
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, *canvas_offset(step)],
                "regions": regions(step),
                "draws": draws(step),
                "synth_exclude": synth_exclude(step),
                "census": census(step),
                "invariants": invariants(step),
            }
        )
    return {
        "schema": "render-stream-gate2-expected/1",
        "viewport": [640, 360],
        "clear_rgba8": [51, 51, 102, 255],
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "empty_region": [0, 0, 24, 24],
        "root_texture_defaults": {"filter": "nearest", "repeat": "disabled"},
        "permitted_formats": ["L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"],
        "items_at_ready": ITEMS_AT_READY,
        "engine_textures": ENGINE_TEXTURES,
        "textures": TEXTURES,
        "texture_objects": TEXTURE_OBJECTS,
        "steps": steps,
        "variants": {"animate": variant("animate"), "unsupported": variant("unsupported")},
    }


def render(data):
    return json.dumps(data, indent=2) + "\n"


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
