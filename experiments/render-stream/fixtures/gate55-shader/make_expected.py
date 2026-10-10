#!/usr/bin/env python3
"""Write fixtures/gate55-shader/expected.json (render-stream-gate55-expected/1).

Every number below is derived from the fixture's own parameters and the engine's shader and
material rules as read from the source (protocol/gate5_5-design.md Q1, Q6c-Q6e), written down as
code. Nothing here runs or reads the engine: the capture's hook log, the reference's material
oracle and the rendered reference have to agree with it, and a disagreement is a finding to explain
from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate55-shader/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate55-shader/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable):

- Code. `Shader.set_code` runs the preprocessor in the scene layer (scene/resources/shader.cpp:85-135)
  and the server receives its output. `preprocess()` below ports what this fixture's shaders touch
  of servers/rendering/shader_preprocessor.cpp: comments removed (none here), every run of spaces
  and tabs collapsed to one space (Tokenizer::get_token, :192-210), and an `#include` replaced by
  `@@>path\\n`, the include's own output and `\\n@@<path\\n` (:766-768), with the directive line's
  newline re-emitted before the next token (Tokenizer::advance, :102-121). The GRP1 payload
  (protocol/gate5_5-design.md Q4) and its SHA-256 follow, so the oracle's `shader_get_code` hash
  is predicted here.
- Laziness. A shader's RID is made by its first `get_rid()` (shader.cpp:54-60, :207-212):
  `set_default_texture_parameter` or the assignment to a material. A ShaderMaterial's RID is made
  by its first `get_rid()` (material.cpp:494-517, :561-563), the item assignment, followed by one
  `material_set_param` per cached parameter in insertion order.
- Parameters (GLES3, D6): a per-material map; `NIL` erases (material.cpp:448-454, GLES3
  material_storage.cpp:2456-2472); `material_get_param` returns the stored Variant or NIL
  (:2475-2483). A texture parameter is stored as its RID (material.cpp:466-474).
- Instance parameters (servers/rendering/instance_uniforms.cpp:103-170): the item's value as set;
  an unset one takes the uniform's default once the item's material dependencies are processed,
  as the Variant `constant_value_to_variant` makes, a `Vector4` for a `vec4` without a colour hint
  (servers/rendering/shader_language.cpp:4440-4463).
- Pixels. Each synthetic shader's `fragment()` has a Python twin below, evaluated in float32 and
  rounded to UNORM8 by geometry-raster.ts. Every output is opaque (blend `mix` at alpha 1 is a
  replace), so every region is exact (D13). A `shader_type spatial` material draws as no material
  on a canvas item (drivers/gles3/storage/material_storage.h:651-658).
- Freshness. A region is fresh at a step exactly when its modelled pixels change. No item redraws
  after `_ready` but the marker (a material, parameter or shader change is not content, D9).
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

S, N, SETTLE = 1, 10, 7
LAST_STEP = 9
QUIT = S + N * LAST_STEP + SETTLE + 4
CAPTURE_QUIT = 400
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
CLEAR_COLOUR = [0.2, 0.2, 0.4, 1]
GRID = {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}

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

# Q6c's regions, [x0, y0, x1, y1).
REGIONS = {
    "TI": [16, 16, 104, 96],
    "PA": [104, 16, 192, 96],
    "IN": [192, 16, 328, 96],
    "TY": [328, 16, 416, 96],
    "PH": [416, 16, 504, 96],
    "RM": [16, 112, 104, 192],
    "SH": [104, 112, 192, 192],
    "Marker": [584, 8, 632, 56],
}
# Variant `refused` (Q6c): four refused shaders and a spatial one, each on its own item.
REFUSED_REGIONS = {
    "TM": [192, 112, 280, 192],
    "SC": [280, 112, 368, 192],
    "SD": [368, 112, 456, 192],
    "GU": [456, 112, 544, 192],
    "SP": [16, 208, 104, 288],
}
REFUSED_SHADERS = {"TM": "time", "SC": "screen", "SD": "sdf", "GU": "global", "SP": "spatial"}

# Wire item ids: canvas_item_create order in gate55_shader.gd _ready.
CREATION_ORDER = ["TI", "PA", "I1", "I2", "TY", "PH", "RM", "SH", "Marker"]
REFUSED_CREATION_ORDER = CREATION_ORDER[:-1] + list(REFUSED_REGIONS) + ["Marker"]
ITEM_REGION = {"TI": "TI", "PA": "PA", "I1": "IN", "I2": "IN", "TY": "TY", "PH": "PH", "RM": "RM", "SH": "SH", "Marker": "Marker"}
ITEM_REGION.update({k: k for k in REFUSED_REGIONS})
POSITION = {
    "TI": (32, 32),
    "PA": (120, 24),
    "I1": (208, 32),
    "I2": (264, 32),
    "TY": (344, 32),
    "PH": (432, 32),
    "RM": (32, 128),
    "SH": (120, 128),
    "TM": (208, 128),
    "SC": (296, 128),
    "SD": (384, 128),
    "GU": (472, 128),
    "SP": (32, 224),
    "Marker": (592, 16),
}
RECT = (0, 0, 56, 48)
SQUARE = (0, 0, 48, 48)
PA_RECT = (8, 8, 32, 32)
ITEM_RECT = {"I1": SQUARE, "I2": SQUARE, "PA": PA_RECT, "Marker": (0, 0, 32, 32)}
REFUSED_DRAW = [0.4, 0.6, 0.2, 1]
G_TINT = [0.6, 0.2, 0.4, 1]

# Q6a's textures: 16x16 RGBA8, quadrants top-left, top-right, bottom-left, bottom-right.
TEX16 = [[1, 0.4, 0.2, 1], [0.2, 0.8, 0.4, 1], [0.4, 0.2, 1, 1], [1, 1, 0.2, 1]]
TEX16B = [[0.2, 0.6, 0.8, 1], [0.8, 0.2, 0.2, 1], [0.6, 1, 0.6, 1], [0, 0.4, 0.4, 1]]

# Shaders in RID creation order (gate55_shader.gd: pal's default texture first, then by material),
# the material each fixture material starts with, and the materials in creation order.
SHADER_ORDER = ["pal", "tint", "inst", "types", "phase", "sh_a", "sh_b"]
REFUSED_SHADER_ORDER = ["pal", "tint", "inst", "types", "phase", "sh_a", "time", "screen", "sdf", "global", "spatial", "sh_b"]
SHADER_FILE = {name: f"shaders/{name}.gdshader" for name in ["tint", "pal", "inst", "types", "phase", "sh_a", "sh_b"]}
SHADER_FILE.update({name: f"shaders/refused/{name}.gdshader" for name in REFUSED_SHADERS.values()})
TINT_B_FILE = "shaders/tint_b.gdshader"
MATERIAL_ORDER = ["MT", "MP", "MI", "MY", "MPh", "MR", "MS", "MR2"]
REFUSED_MATERIAL_ORDER = ["MT", "MP", "MI", "MY", "MPh", "MR", "MS"] + [f"M_{s}" for s in REFUSED_SHADERS.values()] + ["MR2"]
DECLARED = {
    "MT": ["gain", "tint"],
    "MP": ["mul", "pal"],
    "MI": [],
    "MY": ["f", "iv", "k", "lv", "on", "v2", "v3"],
    "MPh": ["phase"],
    "MR": ["gain", "tint"],
    "MS": [],
    "MR2": ["gain", "tint"],
}
DECLARED.update({f"M_{s}": [] for s in REFUSED_SHADERS.values()})
INSTANCE_ITEMS = {"I1": ["inst_color"], "I2": ["inst_color"]}

# D11 (Q3a): what the token scan must report per shader (`uses`, sorted) and the refusal reason.
SHADER_SCAN = {
    "tint": {"mode": "canvas_item", "uses": [], "reason": None},
    "pal": {"mode": "canvas_item", "uses": [], "reason": None},
    "inst": {"mode": "canvas_item", "uses": ["instance_uniform"], "reason": None},
    "types": {"mode": "canvas_item", "uses": [], "reason": None},
    "phase": {"mode": "canvas_item", "uses": [], "reason": None},
    "sh_a": {"mode": "canvas_item", "uses": [], "reason": None},
    "sh_b": {"mode": "canvas_item", "uses": [], "reason": None},
    "time": {"mode": "canvas_item", "uses": ["time"], "reason": "shader-time"},
    "screen": {"mode": "canvas_item", "uses": ["screen_texture"], "reason": "shader-screen-texture"},
    "sdf": {"mode": "canvas_item", "uses": ["sdf"], "reason": "shader-sdf"},
    "global": {"mode": "canvas_item", "uses": ["global_uniform"], "reason": "shader-global-uniform"},
    "spatial": {"mode": "spatial", "uses": [], "reason": "shader-mode"},
}


# --------------------------------------------------------------------------------------------
# float32, Variant views, code and GRP1
# --------------------------------------------------------------------------------------------


def f32(x):
    return struct.unpack("<f", struct.pack("<f", float(x)))[0]


def colour(c):
    return ["color", [f32(v) for v in c]]


def view(v):
    """The oracle's {type, value} of a model value ["type", value]."""
    if v is None:
        return {"type": "nil", "value": None}
    return {"type": v[0], "value": v[1]}


def read(path):
    with open(os.path.join(HERE, path), encoding="utf-8") as handle:
        return handle.read()


def collapse(text):
    """Tokenizer::get_token: a run of spaces and tabs is one space token."""
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c in " \t":
            while i < len(text) and text[i] in " \t":
                i += 1
            out.append(" ")
            continue
        out.append(c)
        i += 1
    return "".join(out)


def preprocess(text):
    """The preprocessed code of a fixture shader, as ShaderPreprocessor writes it (see the module
    docstring). Only what these shaders use: no comments, no defines, `#include "<res path>"`."""
    unquoted = "".join(part for k, part in enumerate(text.split('"')) if k % 2 == 0)
    assert "//" not in unquoted and "/*" not in unquoted, "the model has no comment remover"
    out = []
    pending_newline = False
    lines = text.split("\n")
    for k, line in enumerate(lines):
        last = k == len(lines) - 1
        if line.lstrip(" \t").startswith("#"):
            directive = line.strip()
            assert directive.startswith('#include "') and directive.endswith('"'), directive
            path = directive[len('#include "') : -1]
            assert path.startswith("res://"), path
            included = preprocess(read(path[len("res://") :]))
            out.append(f"@@>{path}\n{included}\n@@<{path}\n")
            pending_newline = True
            continue
        body = collapse(line) + ("" if last else "\n")
        if body and pending_newline:
            out.append("\n")
            pending_newline = False
        out.append(body)
    return "".join(out)


def grp1(code):
    data = code.encode("utf-8")
    meta = json.dumps({"type": "shader-code", "code_bytes": len(data)}, separators=(",", ":")).encode("utf-8")
    return b"GRP1\r\n\x1a\n" + struct.pack("<I", len(meta)) + meta + data


def code_view(code):
    payload = grp1(code)
    return {
        "code_bytes": len(code.encode("utf-8")),
        "payload_bytes": len(payload),
        "include_markers": "@@>" in code,
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


# --------------------------------------------------------------------------------------------
# The scene as a timeline of RenderingServer-visible events
# --------------------------------------------------------------------------------------------


def applied_frame(step):
    return 1 if step == 0 else S + N * step


def settle_frame(step):
    return S + N * step + SETTLE


def timeline(variant):
    """Every event the fixture causes, in call order per frame, as (frame, kind, args). Kinds are
    the RenderingServer calls the material census counts; `xform` is the canvas transform."""
    ev = []

    def at(frame, kind, **args):
        ev.append((frame, kind, args))

    # _ready (frame 1): pal's default texture, then materials and items in creation order.
    at(1, "shader_create_from_code", shader="pal", code=SHADER_FILE["pal"])
    at(1, "shader_set_default_texture_parameter", shader="pal", name="pal", tex="TEX16")

    def material(name, shader, params, items):
        # Assigning the shader to the material makes the shader's RID once; assigning the material
        # to its first item makes the material's, then sends the cached parameters.
        if shader not in created_shaders:
            at(frame, "shader_create_from_code", shader=shader, code=SHADER_FILE[shader])
            created_shaders.add(shader)
        at(frame, "material_create_from_shader", material=name, shader=shader)
        for p, v in params:
            at(frame, "material_set_param", material=name, param=p, value=v)
        for item in items:
            at(frame, "canvas_item_set_material", item=item, material=name)

    created_shaders = {"pal"}
    frame = 1
    material("MT", "tint", [("tint", colour([0.4, 0.8, 0.4, 1])), ("gain", ["float", 0.5])], ["TI"])
    material("MP", "pal", [("mul", colour([1, 1, 1, 1]))], ["PA"])
    material("MI", "inst", [], ["I1", "I2"])
    at(1, "canvas_item_set_instance_shader_parameter", item="I1", param="inst_color", value=colour([0.2, 0.8, 0.4, 1]))
    material(
        "MY",
        "types",
        [
            ("on", ["bool", False]),
            ("k", ["int", 1]),
            ("f", ["float", 0.6]),
            ("v2", ["vector2", [f32(0.4), 0.0]]),
            ("v3", ["vector3", [0.0, f32(0.8), 0.0]]),
            ("iv", ["vector2i", [0, 3]]),
            ("lv", ["packed_float32_array", [f32(v) for v in (0.2, 0.4, 0.6, 0.8)]]),
        ],
        ["TY"],
    )
    material("MPh", "phase", [], ["PH"])
    material("MR", "tint", [("tint", colour([0.8, 0.8, 0.2, 1]))], ["RM"])
    material("MS", "sh_a", [], ["SH"])
    if variant == "refused":
        for item, shader in REFUSED_SHADERS.items():
            material(f"M_{shader}", shader, [], [item])
    # _process: PH's phase on every frame (the per-frame rule), then the step changes.
    at(11, "material_set_param", material="MT", param="tint", value=colour([0.8, 0.4, 0, 1]))
    at(21, "canvas_item_set_instance_shader_parameter", item="I2", param="inst_color", value=colour([0.8, 0.2, 0.6, 1]))
    at(31, "shader_set_code", shader="tint", code=TINT_B_FILE)
    at(41, "material_set_param", material="MT", param="gain", value=None)
    # Step 5: RM's item held MR's last reference, so MR is freed before MR2's RID is made.
    at(51, "free", material="MR")
    frame = 51
    material("MR2", "tint", [("tint", colour([0.2, 0.8, 0.8, 1]))], ["RM"])
    at(61, "material_set_param", material="MP", param="pal", value=["rid", {"tex": "TEX16B"}])
    at(71, "material_set_param", material="MY", param="on", value=["bool", True])
    at(71, "material_set_param", material="MY", param="k", value=["int", 3])
    at(81, "shader_create_from_code", shader="sh_b", code=SHADER_FILE["sh_b"])
    at(81, "material_set_shader", material="MS", shader="sh_b")
    at(81, "free", shader="sh_a")
    at(91, "xform", offset=[8, 4])
    return ev


PHASE_RULE = {"material": "MPh", "param": "phase", "from_frame": 1, "to_frame": None, "value": "frame"}


class State:
    """The GLES3 view of shaders, materials, items and the canvas at the end of one frame."""

    def __init__(self):
        self.code = {}
        self.default_tex = {}
        self.shader_live = {}
        self.mat_shader = {}
        self.params = {}
        self.mat_live = {}
        self.item_mat = {}
        self.inst = {}
        self.offset = [0, 0]
        self.created_frame = {}


def state_at(variant, frame, *, omit_param_from=None, perturb_from=None, stale_param=False):
    """The model after every event up to the end of `frame`. Sabotage views (G55e): params set at
    or after `omit_param_from` are dropped (creation parameters included); code recorded at or
    after `perturb_from` is marked perturbed; `stale_param` keeps each material's parameters as of
    the end of its creation frame."""
    st = State()
    for f, kind, a in timeline(variant):
        if f > frame:
            break
        if kind in ("shader_create_from_code", "shader_set_code"):
            perturbed = perturb_from is not None and f >= perturb_from
            st.code[a["shader"]] = (a["code"], perturbed)
            st.shader_live[a["shader"]] = True
        elif kind == "shader_set_default_texture_parameter":
            st.default_tex[(a["shader"], a["name"])] = a["tex"]
        elif kind == "material_create_from_shader":
            st.mat_shader[a["material"]] = a["shader"]
            st.params[a["material"]] = {}
            st.mat_live[a["material"]] = True
            st.created_frame[a["material"]] = f
        elif kind == "material_set_param":
            if omit_param_from is not None and f >= omit_param_from:
                continue
            if stale_param and f != st.created_frame[a["material"]]:
                continue
            if a["value"] is None:
                st.params[a["material"]].pop(a["param"], None)
            else:
                st.params[a["material"]][a["param"]] = a["value"]
        elif kind == "material_set_shader":
            st.mat_shader[a["material"]] = a["shader"]
        elif kind == "canvas_item_set_material":
            st.item_mat[a["item"]] = a["material"]
        elif kind == "canvas_item_set_instance_shader_parameter":
            st.inst[(a["item"], a["param"])] = a["value"]
        elif kind == "free":
            if "shader" in a:
                st.shader_live[a["shader"]] = False
            else:
                st.mat_live[a["material"]] = False
        elif kind == "xform":
            st.offset = a["offset"]
    # PH's per-frame phase: written on every frame from 1 (the last one up to `frame` is live).
    last = frame
    if omit_param_from is not None and last >= omit_param_from:
        last = omit_param_from - 1
    if stale_param:
        last = st.created_frame["MPh"]
    if last >= PHASE_RULE["from_frame"]:
        st.params["MPh"]["phase"] = ["int", last]
    return st


# --------------------------------------------------------------------------------------------
# The shader twins: each fragment() in Python, float32
# --------------------------------------------------------------------------------------------


def num(v):
    return v[1]


def twin(shader, code, params, inst):
    """(rgba, texture or None) a fragment writes for one material state; `code` names the file."""
    p = params
    if shader == "tint":
        tint = num(p["tint"]) if "tint" in p else [1.0, 1.0, 1.0, 1.0]
        gain = f32(num(p["gain"])) if "gain" in p else 1.0
        if code == TINT_B_FILE:
            rgb = [f32(tint[2] * gain), f32(tint[1] * gain), f32(tint[0] * gain)]
        else:
            rgb = [f32(tint[0] * gain), f32(tint[1] * gain), f32(tint[2] * gain)]
        return rgb + [1.0], None
    if shader == "pal":
        mul = num(p["mul"]) if "mul" in p else [1.0, 1.0, 1.0, 1.0]
        return list(mul), None  # the texture is chosen by pal_texture()
    if shader == "inst":
        c = num(inst) if inst is not None else [1.0, 1.0, 1.0, 1.0]
        return [f32(c[0]), f32(c[1]), f32(c[2]), 1.0], None
    if shader == "types":
        if num(p["on"]):
            lv = num(p["lv"])
            return [num(p["v2"])[0], num(p["v3"])[1], lv[num(p["k"])], 1.0], None
        return [f32(num(p["f"])), f32(f32(num(p["iv"])[1]) * f32(0.2)), 0.0, 1.0], None
    if shader == "phase":
        ph = num(p["phase"]) if "phase" in p else 0
        k = ph % 6
        return [f32(f32(k) * f32(0.2)), f32(f32(5 - k) * f32(0.2)), f32(0.4), 1.0], None
    if shader == "sh_a":
        return [f32(0.2), f32(0.8), f32(0.4), 1.0], None
    if shader == "sh_b":
        return [f32(0.8), f32(0.2), f32(0.6), 1.0], None
    if shader == "time":
        return [f32(0.2), f32(0.4), f32(0.6), 1.0], None
    if shader == "screen":
        # 1 - the back buffer under the item: only the clear colour lies there.
        return [f32(1.0 - c) for c in CLEAR_COLOUR[:3]] + [1.0], None
    if shader == "sdf":
        return [f32(0.4), f32(0.2), f32(0.8), 1.0], None
    if shader == "global":
        return [f32(v) for v in G_TINT[:3]] + [1.0], None
    raise AssertionError(shader)


def rect_shape(name, rect, colours, texture=None):
    x, y, w, h = rect
    shape = {
        "name": name,
        "kind": "mesh",
        "vertices": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        "triangles": [[0, 1, 2], [0, 2, 3]],
        "colors": [colours],
    }
    if texture:
        shape["uvs"] = [[0, 0], [1, 0], [1, 1], [0, 1]]
        shape["texture"] = texture
    return shape


def item_shape(name, step, st, marker_step=None, ignore_material=False):
    """What one item draws at a settle frame under the model state `st`."""
    rect = ITEM_RECT.get(name, RECT)
    if name == "Marker":
        return rect_shape("rect", rect, MARKER_COLOURS[marker_step if marker_step is not None else step])
    draw = REFUSED_DRAW if name in REFUSED_REGIONS else [1, 1, 1, 1]
    material = None if ignore_material else st.item_mat.get(name)
    if material is None or not st.mat_live.get(material, False):
        if name == "PA":
            return rect_shape("texture_rect", rect, draw, "TEX16")
        return rect_shape("rect", rect, draw)
    shader = st.mat_shader[material]
    code, perturbed = st.code[shader]
    if shader == "spatial":
        return rect_shape("rect", rect, draw)
    c, _ = twin(shader, code, st.params[material], st.inst.get((name, "inst_color")))
    if perturbed:
        c = [f32(1.0 - c[0]), f32(1.0 - c[1]), f32(1.0 - c[2]), c[3]]
    if shader == "pal":
        tex = st.params[material]["pal"][1]["tex"] if "pal" in st.params[material] else st.default_tex[("pal", "pal")]
        assert not perturbed
        return rect_shape("texture_rect", rect, c, tex)
    return rect_shape("rect", rect, c)


def content(variant, st, step, **kw):
    """Per region: the item transforms and shapes it paints (what freshness and sabotage compare)."""
    order = REFUSED_CREATION_ORDER if variant == "refused" else CREATION_ORDER
    out = {}
    for name in order:
        px, py = POSITION[name]
        shape = item_shape(name, step, st, **kw)
        out.setdefault(ITEM_REGION[name], []).append([[1, 0, 0, 1, px + st.offset[0], py + st.offset[1]], shape])
    return out


# --------------------------------------------------------------------------------------------
# Steps, oracle views, census
# --------------------------------------------------------------------------------------------


def oracle_view(variant, step):
    """What the material oracle must write at a settle frame (Q6e)."""
    st = state_at(variant, settle_frame(step))
    shader_order = REFUSED_SHADER_ORDER if variant == "refused" else SHADER_ORDER
    material_order = REFUSED_MATERIAL_ORDER if variant == "refused" else MATERIAL_ORDER
    shaders = []
    for name in shader_order:
        if name not in st.shader_live:
            shaders.append({"name": name, "status": "absent"})
        elif not st.shader_live[name]:
            shaders.append({"name": name, "status": "freed"})
        else:
            shaders.append({"name": name, "status": "live", **code_view(preprocess(read(st.code[name][0])))})
    materials = []
    for name in material_order:
        if name not in st.mat_live:
            materials.append({"name": name, "status": "absent"})
        elif not st.mat_live[name]:
            materials.append({"name": name, "status": "freed"})
        else:
            params = [{**view(st.params[name].get(p)), "name": p} for p in DECLARED[name]]
            materials.append({"name": name, "status": "live", "params": params})
    items = []
    for item, names in INSTANCE_ITEMS.items():
        params = []
        for p in names:
            v = st.inst.get((item, p))
            # Unset: the uniform's default once the item's materials are processed (Vector4).
            params.append({**view(v if v is not None else ["vector4", [1.0, 1.0, 1.0, 1.0]]), "name": p})
        items.append({"name": item, "instance_params": params})
    return {"shaders": shaders, "materials": materials, "items": items}


def build_variant(variant, op_lists):
    order = REFUSED_CREATION_ORDER if variant == "refused" else CREATION_ORDER
    regions = dict(REGIONS)
    if variant == "refused":
        regions = {**{k: v for k, v in REGIONS.items() if k != "Marker"}, **REFUSED_REGIONS, "Marker": REGIONS["Marker"]}
    steps = []
    prefix = "refused/" if variant == "refused" else ""
    previous = None
    for step in range(LAST_STEP + 1):
        st = state_at(variant, settle_frame(step))
        now = content(variant, st, step)
        items = []
        for name in order:
            key = f"{prefix}{name}@{step}"
            px, py = POSITION[name]
            op_lists[key] = [item_shape(name, step, st)]
            items.append({"name": name, "region": ITEM_REGION[name], "xform": [1, 0, 0, 1, px + st.offset[0], py + st.offset[1]], "clip_px": None, "ops": key})
        fresh = {r: True for r in regions} if previous is None else {r: now[r] != previous[r] for r in regions}
        previous = now
        steps.append(
            {
                "step": step,
                "applied_frame": applied_frame(step),
                "settle_frame": settle_frame(step),
                "change": STEP_CHANGES.get(step, "initial"),
                "marker_rgba8": MARKER[step],
                "canvas_transform": [1, 0, 0, 1, st.offset[0], st.offset[1]],
                "redraws": list(order) if step == 0 else ["Marker"],
                "phase": settle_frame(step),
                "material_calls": material_calls(variant, step),
                "items": items,
                "fresh": fresh,
                "oracle": oracle_view(variant, step),
            }
        )
    # One op list per distinct content (items name the first step that recorded it).
    canon = {}
    for s in steps:
        for item in s["items"]:
            text = json.dumps(op_lists[item["ops"]], sort_keys=True)
            first = canon.setdefault((item["name"], text), item["ops"])
            if first != item["ops"]:
                del op_lists[item["ops"]]
                item["ops"] = first
    return regions, order, steps


STEP_CHANGES = {
    1: "MT.tint -> (.8,.4,0,1) (one material_set_param; no redraw)",
    2: "I2.inst_color -> (.8,.2,.6,1) (one instance parameter on the shared MI)",
    3: "the tint Shader's code -> tint_b (one shader_set_code; TI and RM change)",
    4: "MT.gain -> null (material_set_param NIL: the code's default 1.0)",
    5: "RM.material = MR2, a new ShaderMaterial on tint, tint (.2,.8,.8,1) (MR freed first)",
    6: "MP.pal = TEX16B (a texture parameter over the shader's default texture)",
    7: "MY.on -> true, MY.k -> 3 (bool and int; array indexing)",
    8: "MS.shader = sh_b (shader_create_from_code, material_set_shader, free(sh_a))",
    9: "canvas_transform = Transform2D(0, (8, 4))",
}


def material_calls(variant, step):
    """The fixture's calls on the step's applied frame with their exact Variant values (D12 (1)),
    PH's per-frame phase excluded (it is `phase`)."""
    out = []
    for f, kind, a in timeline(variant):
        if f != applied_frame(step) or kind == "xform":
            continue
        call = {"op": kind}
        for key, value in a.items():
            if key == "code":
                call["code_file"] = value
            elif key == "value":
                call["value"] = view(value)
            else:
                call[key] = value
        out.append(call)
    return out


def census(variant):
    """Every material-related RenderingServer call per frame (D12 (4)), PH's per-frame
    material_set_param excluded (`phase_rule`): [kind, entity, version, detail]. Versions follow D5:
    1 at creation, +1 per accepted mutating call; a free carries the entity's last version."""
    version = {}
    frames = {}
    for f, kind, a in timeline(variant):
        if kind == "xform":
            continue
        if kind in ("shader_create_from_code",):
            entity = ("shader", a["shader"])
            version[entity] = 1
            line = [kind, a["shader"], 1, None]
        elif kind in ("shader_set_code", "shader_set_default_texture_parameter"):
            entity = ("shader", a["shader"])
            version[entity] += 1
            line = [kind, a["shader"], version[entity], a.get("name")]
        elif kind == "material_create_from_shader":
            entity = ("material", a["material"])
            version[entity] = 1
            line = [kind, a["material"], 1, a["shader"]]
        elif kind in ("material_set_param", "material_set_shader"):
            entity = ("material", a["material"])
            version[entity] += 1
            line = [kind, a["material"], version[entity], a.get("param", a.get("shader"))]
        elif kind == "free":
            entity = ("shader", a["shader"]) if "shader" in a else ("material", a["material"])
            line = [kind, entity[1], version[entity], entity[0]]
        elif kind == "canvas_item_set_material":
            line = [kind, a["item"], None, a["material"]]
        elif kind == "canvas_item_set_instance_shader_parameter":
            line = [kind, a["item"], None, a["param"]]
        else:
            raise AssertionError(kind)
        frames.setdefault(str(f), []).append(line)
    return {"frames": frames, "phase_rule": PHASE_RULE}


def counters(variant):
    """counters.json over a capture that quits at CAPTURE_QUIT, for the material ops the record
    hooks before calibrator 8 (count only): every timeline call plus PH's phase on every frame."""
    counts = {"shader_create_from_code": 0, "shader_set_code": 0, "material_set_param": CAPTURE_QUIT, "canvas_item_set_material": 0}
    for _, kind, _ in timeline(variant):
        if kind in counts:
            counts[kind] += 1
    counts["texture_2d_create"] = 3  # the engine's hue strip, TEX16, TEX16B
    counts["canvas_item_add_rect"] = 7 + (5 if variant == "refused" else 0) + LAST_STEP + 1
    counts["canvas_item_add_texture_rect"] = 1
    return {"quit_frame": CAPTURE_QUIT, "counts": counts}


def predictions():
    """G55e's sabotage sets (Q6c), recomputed from the model: per region, the steps whose settle
    shot differs from the reference under each sabotage view."""

    def diff_sets(view_at):
        out = {}
        for step in range(LAST_STEP + 1):
            ref = content("", state_at("", settle_frame(step)), step)
            got = view_at(step)
            for region in REGIONS:
                if region != "Marker" and ref[region] != got[region]:
                    out.setdefault(region, []).append(step)
        return out

    freeze_at = S + N

    def frozen(step):
        if settle_frame(step) < freeze_at:
            return content("", state_at("", settle_frame(step)), step)
        return content("", state_at("", freeze_at - 1), step, marker_step=0)

    omit_at = S + N * 2
    return {
        "sabotage-shader-freeze": {"frame": freeze_at, "steps": list(range(1, LAST_STEP + 1)), "regions": diff_sets(frozen)},
        "sabotage-shader-omit-param": {"frame": omit_at, "op": "material_set_param", "regions": diff_sets(lambda k: content("", state_at("", settle_frame(k), omit_param_from=omit_at), k))},
        "sabotage-shader-perturb-shader": {"frame": omit_at, "regions": diff_sets(lambda k: content("", state_at("", settle_frame(k), perturb_from=omit_at), k))},
        "sabotage-shader-receiver-ignore-material": {"regions": diff_sets(lambda k: content("", state_at("", settle_frame(k)), k, ignore_material=True))},
        "sabotage-shader-receiver-stale-param": {"regions": diff_sets(lambda k: content("", state_at("", settle_frame(k), stale_param=True), k))},
    }


# --------------------------------------------------------------------------------------------
# Self-consistency
# --------------------------------------------------------------------------------------------


def check(steps, op_lists, regions):
    on_grid = lambda v: any(abs(v - g) < 1e-6 for g in GRID)  # noqa: E731
    names = list(regions)
    for i, a in enumerate(names):
        ra = regions[a]
        assert 0 <= ra[0] < ra[2] <= VIEWPORT[0] and 0 <= ra[1] < ra[3] <= VIEWPORT[1], a
        for b in names[i + 1 :]:
            rb = regions[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
    for s in steps:
        for item in s["items"]:
            region = regions[item["region"]]
            for shape in op_lists[item["ops"]]:
                for c in shape["colors"]:
                    assert all(on_grid(round(v, 4)) for v in c), (s["step"], item["name"], c)
                    assert abs(c[3] - 1) < 1e-6, (s["step"], item["name"], c)
                for x, y in shape["vertices"]:
                    gx, gy = x + item["xform"][4], y + item["xform"][5]
                    assert region[0] <= gx <= region[2] and region[1] <= gy <= region[3], (s["step"], item["name"], (gx, gy), region)
    assert len({tuple(s["marker_rgba8"]) for s in steps}) == len(steps)


def hand_checks(steps, op_lists):
    """Q6c's step rows, typed in by hand, against the model."""
    fresh_hand = {1: {"TI"}, 2: {"IN"}, 3: {"TI", "RM"}, 4: {"TI"}, 5: {"RM"}, 6: {"PA"}, 7: {"TY"}, 8: {"SH"}, 9: set(REGIONS)}
    for k, want in fresh_hand.items():
        got = {r for r, f in steps[k]["fresh"].items() if f}
        assert got == want | {"Marker", "PH"}, f"step {k}: fresh {sorted(got)} != hand {sorted(want)}"
    # PH: phase mod 6 at the settle frames 8 + 10k (2, 0, 4, 2, ...): it changes at every step.
    assert [settle_frame(k) % 6 for k in range(LAST_STEP + 1)] == [2, 0, 4, 2, 0, 4, 2, 0, 4, 2]
    frame1 = census("")["frames"]["1"]
    kinds = [ln[0] for ln in frame1]
    assert kinds.count("shader_create_from_code") == 6, kinds
    assert kinds.count("shader_set_default_texture_parameter") == 1, kinds
    assert kinds.count("material_create_from_shader") == 7, kinds
    assert kinds.count("material_set_param") == 11, kinds
    assert kinds.count("canvas_item_set_material") == 8, kinds
    assert kinds.count("canvas_item_set_instance_shader_parameter") == 1, kinds
    later = {int(f): [ln[0] for ln in v] for f, v in census("")["frames"].items() if f != "1"}
    assert later == {
        11: ["material_set_param"],
        21: ["canvas_item_set_instance_shader_parameter"],
        31: ["shader_set_code"],
        41: ["material_set_param"],
        51: ["free", "material_create_from_shader", "material_set_param", "canvas_item_set_material"],
        61: ["material_set_param"],
        71: ["material_set_param", "material_set_param"],
        81: ["shader_create_from_code", "material_set_shader", "free"],
    }, later
    # Region colours by hand (RGBA8), per step where they change.
    hand = {
        ("TI", 0): [51, 102, 51],
        ("TI", 1): [102, 51, 0],
        ("TI", 3): [0, 51, 102],
        ("TI", 4): [0, 102, 204],
        ("RM", 0): [204, 204, 51],
        ("RM", 3): [51, 204, 204],
        ("RM", 5): [204, 204, 51],
        ("I1", 0): [51, 204, 102],
        ("I2", 0): [255, 255, 255],
        ("I2", 2): [204, 51, 153],
        ("TY", 0): [153, 153, 0],
        ("TY", 7): [102, 204, 204],
        ("PH", 0): [102, 153, 102],
        ("PH", 1): [0, 255, 102],
        ("PH", 2): [204, 51, 102],
        ("SH", 0): [51, 204, 102],
        ("SH", 8): [204, 51, 153],
    }
    for (name, step), rgb in hand.items():
        item = next(i for i in steps[step]["items"] if i["name"] == name)
        got = [round(v * 255) for v in op_lists[item["ops"]][0]["colors"][0][:3]]
        assert got == rgb, (name, step, got, rgb)
    pa = [next(i for i in s["items"] if i["name"] == "PA") for s in steps]
    assert [op_lists[i["ops"]][0]["texture"] for i in pa] == ["TEX16"] * 6 + ["TEX16B"] * 4


def texture_table():
    out = {}
    for name, quads in (("TEX16", TEX16), ("TEX16B", TEX16B)):
        texels = []
        for y in range(16):
            for x in range(16):
                texels.append([round(v * 255) for v in quads[(x // 8) + 2 * (y // 8)]])
        out[name] = {"width": 16, "height": 16, "rgba8_hex": "".join(f"{v:02x}" for t in texels for v in t)}
    return out


def build():
    op_lists = {}
    regions, order, steps = build_variant("", op_lists)
    check(steps, op_lists, regions)
    hand_checks(steps, op_lists)
    r_regions, r_order, r_steps = build_variant("refused", op_lists)
    check(r_steps, op_lists, r_regions)
    codes = {name: code_view(preprocess(read(path))) for name, path in SHADER_FILE.items()}
    codes["tint_b"] = code_view(preprocess(read(TINT_B_FILE)))
    return {
        "schema": "render-stream-gate55-expected/1",
        "fixture": "gate55-shader",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "capture_quit_frame": CAPTURE_QUIT,
        "last_step": LAST_STEP,
        "creation_order": order,
        "regions": regions,
        "marker_rect": [592, 16, 32, 32],
        "exact_edge_px": 1 / 16,
        "textures": texture_table(),
        "engine_textures": [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}],
        "shader_order": SHADER_ORDER,
        "material_order": MATERIAL_ORDER,
        "declared_params": DECLARED,
        "instance_params": INSTANCE_ITEMS,
        "shader_files": SHADER_FILE,
        "shader_codes": codes,
        "shader_scan": SHADER_SCAN,
        "typed": {"ops": ["canvas_item_set_material"], "reason": "unsupported-state", "items": [n for n in order if n != "Marker"]},
        "counters": counters(""),
        "census": census(""),
        "op_lists": op_lists,
        "steps": steps,
        "variants": {
            "refused": {
                "creation_order": r_order,
                "regions": r_regions,
                "shader_order": REFUSED_SHADER_ORDER,
                "material_order": REFUSED_MATERIAL_ORDER,
                "refused_items": REFUSED_SHADERS,
                "typed": {"ops": ["canvas_item_set_material"], "reason": "unsupported-state", "items": [n for n in r_order if n != "Marker"]},
                "counters": counters("refused"),
                "census": census("refused"),
                "steps": r_steps,
            }
        },
        "predictions": predictions(),
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
