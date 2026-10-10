#!/usr/bin/env python3
"""Write fixtures/gate4-msdf/expected.json (render-stream-gate4-expected/1, the MSDF fixture).

Every number below is derived from the fixture's strings and the engine's MSDF text rules as read
from the source (protocol/gate4-design.md Q1, D5, Q6e "fixtures/gate4-msdf/", G4e2), written down
as code over the fixture's own parameters. Nothing here runs or reads the engine: the glyph oracle
and the capture have to agree with it (`oracle-agrees-msdf`, `atlas-census-msdf`), and a
disagreement is a finding to explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate4-msdf/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate4-msdf/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `ts_adv` is
modules/text_server_adv/text_server_adv.cpp):

- One cache. An MSDF font keys its cache on msdf_size alone (`_get_size` / `_get_size_outline`,
  ts_adv.h:408-419): every Label of FM, at every draw size and with or without an outline, draws
  from the one cache FM@48 and its pages. A page side is next_power_of_2(max(48 * 64 * 0.125,
  256)) = 512, RGBA8, all zero (ts_adv:856-899). The fixture's 24 glyphs fit one page.
- Rasterize-then-upload (Q1c), with G4c's refinement: Labels added in `_ready` shape when they
  enter the tree (their minimum size shapes them, scene/gui/control.cpp:3803-3807), so every step
  0 glyph is rasterized before the first draw and the page is created once at step 0. From step 1
  on a text change shapes in its draw, and a Label draw that introduced glyphs uploads the page
  once (ts_adv:4001-4019); two such Labels in one frame upload twice, one wire version.
- No upload on a size change (the cache does not depend on the draw size, D5), nor on the outline
  toggle (the outline pass draws the same glyphs from the same cache, ts_adv:4167-4171), nor on a
  colour change or a parent rotation (a Node2D transform redraws nothing).
- Commands. Each ink glyph is one add_msdf_texture_rect_region per pass: the outline pass (when
  outline_size > 0 and the outline colour is visible, scene/gui/label.cpp:725-886) with `outline`
  = outline_size, then the text pass with `outline` 0 (ts_adv:4021-4025). Every command carries
  px_range = msdf_pixel_range (24) and scale = size / msdf_size. The strings avoid ligatures, so
  ink glyphs equal non-space codepoints.
- Pixels. Outside the text regions the frame is the clear colour, the panel P and the marker:
  exact (D8). A region differs from the previous step exactly when its node's text, size, colour,
  outline or transform changed.
- Sabotages. perturb-glyph (from step 1's frame) moves the commands the mirror records from then
  on, so a region mismatches from the first step at which its Label redrew; MR never redraws.
  drop-msdf skips every msdf command, so every region with ink mismatches at every step.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "expected.json")

S, N, SETTLE = 1, 10, 7
LAST_STEP = 9
QUIT = S + N * LAST_STEP + SETTLE + 4
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
EARLY_SHOT_STEPS = [1, 7]
MSDF_SIZE = 48
MSDF_PIXEL_RANGE = 24
CACHE = f"FM@{MSDF_SIZE}"
PAGE_SIDE = 512

# Gate 3's marker colours (fixtures/gate3/gate3.gd MARKER_COLORS).
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
MARKER_RECT = [592, 16, 32, 32]
MARKER_REGION = [584, 8, 48, 48]

PANEL = {"rect": [344, 24, 232, 312], "colour": [1, 1, 0.8, 1]}


def rgba8(c):
    return [round(v * 255) for v in c]


BACKGROUNDS = {"dark": CLEAR, "panel": rgba8(PANEL["colour"])}

# Wire id order: every CanvasItem in canvas_item_create order (gate4_msdf.gd _ready): R (a
# Node2D) is created before its child MR.
CREATION_ORDER = ["P", "M16", "M24", "M40", "MT", "R", "MR", "Marker"]
# Text nodes in tree order (MR is R's child). `xform` is the Label's global transform as
# (rotation degrees, scale, origin): MR's is R's.
TEXT_NODES = {
    "M16": {"size": 16, "pos": [24, 24], "colour": [1, 1, 1, 1], "region": [16, 16, 240, 52], "background": "dark"},
    "M24": {"size": 24, "pos": [24, 64], "colour": [1, 0.8, 0.2, 1], "region": [16, 56, 336, 148], "background": "dark"},
    "M40": {"size": 40, "pos": [24, 160], "colour": [0.4, 1, 0.6, 1], "region": [16, 152, 336, 232], "background": "dark"},
    "MT": {"size": 24, "pos": [360, 40], "colour": [0, 0, 0, 0.6], "region": [352, 32, 568, 80], "background": "panel"},
    "MR": {"size": 16, "pos": [0, 0], "colour": [0.2, 0, 0.4, 1], "region": [352, 96, 568, 200], "background": "panel"},
}
TREE_ORDER = list(TEXT_NODES)
INITIAL_TEXT = {"M16": "Hello", "M24": "Sphinx", "M40": "Quartz", "MT": "Jump", "MR": "Turn"}
ROTOR = {"position": [400, 120], "rotation_degrees": 20, "scale": 1.5}

# The timeline (gate4-design.md Q6e "fixtures/gate4-msdf/"): per step, the changes in the order
# gate4_msdf.gd makes them. ("text", node, value) | ("size", node, px) | ("outline", node, size,
# rgba) | ("colour", node, rgba) | ("outline_colour", node, rgba) | ("rotate", degrees)
TIMELINE = {
    1: [("text", "M16", "Hello Wyvern")],
    2: [("size", "M24", 56)],
    3: [("outline", "M40", 4, [1, 0.4, 0, 1])],
    4: [("colour", "M16", [1, 0.6, 0.6, 1])],
    5: [("rotate", 35)],
    6: [("outline_colour", "M40", [0.4, 1, 1, 1])],
    7: [("text", "MT", "Jump!"), ("text", "M16", "Wizard")],
    8: [("text", "M24", "Ship")],
    9: [("text", "M40", "Quartz Quiz")],
}

# The contract's predictions (gate4-design.md Q6e, G4e2), typed in, never computed:
# step -> (FM@48 uploads: "create" | n, what it proves).
HAND_TABLE = {
    0: ("create", "every step-0 glyph in one 512x512 RGBA8 page, created once"),
    1: (1, "new glyphs: one upload of the page"),
    2: (0, "a size change 24 -> 56: no upload, the cache key is msdf_size"),
    3: (0, "an outline toggle: no upload, the same page"),
    4: (0, "a colour change"),
    5: (0, "a parent rotation: transform only"),
    6: (0, "an outline colour change"),
    7: (2, "two Labels, one page, one frame: two hook versions, one on the wire"),
    8: (0, "new placement, no new glyphs"),
    9: (0, "new text with the outline on, no new glyphs"),
}
HAND_WIRE_VERSIONS = [1, 2, 2, 2, 2, 2, 2, 4, 4, 4]
HAND_GLYPHS = 24

# The one texture the engine makes itself (memory rs-g2a-texture-census-facts).
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]
QUIET_STEPS = [2, 3, 4, 5, 6, 8, 9]


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def ink(text):
    """Ink glyphs of a single-line Latin string: its non-space codepoints (no ligatures)."""
    return [c for c in text if not c.isspace()]


def scene_states():
    """Per step: each text node's state, R's rotation, and the ordered draws."""
    state = {
        n: {
            "text": INITIAL_TEXT[n],
            "size": TEXT_NODES[n]["size"],
            "colour": list(TEXT_NODES[n]["colour"]),
            "outline_size": 0,
            "outline_colour": None,
            "rotation": ROTOR["rotation_degrees"] if n == "MR" else 0,
        }
        for n in TEXT_NODES
    }
    out = []
    for step in range(LAST_STEP + 1):
        draws = list(TREE_ORDER) if step == 0 else []
        for change in TIMELINE.get(step, []):
            kind = change[0]
            if kind == "rotate":
                state["MR"]["rotation"] = change[1]
                continue
            node = change[1]
            if kind == "text":
                if state[node]["text"] == change[2]:
                    continue
                state[node]["text"] = change[2]
            elif kind == "size":
                state[node]["size"] = change[2]
            elif kind == "outline":
                state[node]["outline_size"] = change[2]
                state[node]["outline_colour"] = list(change[3])
            elif kind == "colour":
                state[node]["colour"] = list(change[2])
            elif kind == "outline_colour":
                state[node]["outline_colour"] = list(change[2])
            if node not in draws:
                draws.append(node)
        out.append({"nodes": copy.deepcopy(state), "draws": draws})
    return out


def census(states):
    """Q1c over the draws, one cache: new glyphs, uploads and creates, hook versions."""
    have = []
    version = 0
    created = False
    steps = []
    for k, st in enumerate(states):
        fresh = []
        uploads = 0
        creates = 0
        if k == 0:
            # Shaped on entering the tree, before any draw: one create at the first draw.
            for node in st["draws"]:
                for c in ink(st["nodes"][node]["text"]):
                    if c not in have and c not in fresh:
                        fresh.append(c)
            have.extend(fresh)
            version += 1
            creates = 1
            created = True
        else:
            for node in st["draws"]:
                added = []
                for c in ink(st["nodes"][node]["text"]):
                    if c not in have and c not in added:
                        added.append(c)
                if not added:
                    continue
                have.extend(added)
                fresh.extend(added)
                version += 1
                assert created
                uploads += 1
        steps.append(
            {
                "new_glyphs": {CACHE: "".join(fresh)} if fresh else {},
                "page_uploads": {CACHE: uploads} if uploads else {},
                "page_creates": {CACHE: creates} if creates else {},
                "hook_versions": {CACHE: version},
                "page_glyphs": {CACHE: len(have)},
            }
        )
    return steps


def passes(node_state):
    """The draw passes of a Label: outline (when on) then text."""
    out = []
    if node_state["outline_size"] > 0 and node_state["outline_colour"] and node_state["outline_colour"][3] != 0:
        out.append("outline")
    out.append("text")
    return out


def appearance(node_state):
    if not ink(node_state["text"]):
        return None
    return json.dumps(node_state, sort_keys=True)


def predictions(states):
    pred = {}
    # perturb-glyph from step 1's frame: a node's commands carry the shift once it redrew.
    redrawn = set()
    steps, regions = [], {}
    for k, st in enumerate(states):
        if k >= 1:
            redrawn.update(st["draws"])
        bad = [n for n in TREE_ORDER if n in redrawn and ink(st["nodes"][n]["text"])]
        if bad:
            steps.append(k)
            regions[str(k)] = bad
    pred["sabotage-msdf-perturb-glyph"] = {"frame": frame_of(1), "steps": steps, "regions": regions}
    # drop-msdf: every msdf command skipped, so every region with ink mismatches at every step.
    steps, regions = [], {}
    for k, st in enumerate(states):
        bad = [n for n in TREE_ORDER if ink(st["nodes"][n]["text"])]
        if bad:
            steps.append(k)
            regions[str(k)] = bad
    pred["sabotage-msdf-receiver-drop"] = {"frame": 0, "steps": steps, "regions": regions}
    return pred


def region_wh(r):
    return [r[0], r[1], r[2] - r[0], r[3] - r[1]]


def inside(r, outer):
    return r[0] >= outer[0] and r[1] >= outer[1] and r[2] <= outer[0] + outer[2] and r[3] <= outer[1] + outer[3]


def build():
    states = scene_states()
    cen = census(states)
    steps = []
    for k, st in enumerate(states):
        nodes = st["nodes"]
        c = cen[k]
        texts = {}
        for n in TREE_ORDER:
            t = nodes[n]
            entry = {
                "text": t["text"],
                "font_key": "FM",
                "size": t["size"],
                "colour": t["colour"],
                "visible": True,
                "position": TEXT_NODES[n]["pos"],
                "outline_size": t["outline_size"],
            }
            if t["outline_colour"] is not None:
                entry["outline_colour"] = t["outline_colour"]
            if n == "MR":
                entry["rotation_degrees"] = t["rotation"]
            texts[n] = entry
        ink_glyphs = {n: len(ink(nodes[n]["text"])) for n in TREE_ORDER}
        commands = {n: ink_glyphs[n] * len(passes(nodes[n])) for n in TREE_ORDER}
        fresh = {n: (k > 0 and appearance(nodes[n]) != appearance(states[k - 1]["nodes"][n])) for n in TREE_ORDER}
        steps.append(
            {
                "step": k,
                "applied_frame": frame_of(k),
                "settle_frame": frame_of(k, True),
                "marker_rgba8": MARKER[k],
                "texts": texts,
                "draws": st["draws"],
                "ink_glyphs": ink_glyphs,
                "commands": commands,
                "passes": {n: passes(nodes[n]) for n in TREE_ORDER},
                "new_glyphs": c["new_glyphs"],
                "page_uploads": c["page_uploads"],
                "page_creates": c["page_creates"],
                "hook_versions": {f"{CACHE}/0#0": c["hook_versions"][CACHE]},
                "wire_versions": {f"{CACHE}/0#0": c["hook_versions"][CACHE]},
                "page_glyphs": c["page_glyphs"],
                "page_counts": {CACHE: 1},
                "text_regions": {n: TEXT_NODES[n]["region"] for n in TREE_ORDER},
                "background": {n: BACKGROUNDS[TEXT_NODES[n]["background"]] for n in TREE_ORDER},
                "fresh": fresh,
                "frees": [],
                "subpixel_bounded": [],
            }
        )

    # The contract's hand table equals the derivation.
    for k, (uploads, _why) in HAND_TABLE.items():
        s = steps[k]
        got = "create" if s["page_creates"].get(CACHE) else s["page_uploads"].get(CACHE, 0)
        assert got == uploads, f"step {k}: FM@48 {got} != hand {uploads}"
    got_versions = [s["wire_versions"][f"{CACHE}/0#0"] for s in steps]
    assert got_versions == HAND_WIRE_VERSIONS, f"wire versions {got_versions} != hand {HAND_WIRE_VERSIONS}"
    assert steps[-1]["page_glyphs"][CACHE] == HAND_GLYPHS
    for k in QUIET_STEPS:
        assert not steps[k]["page_uploads"] and not steps[k]["page_creates"], k

    # Layout sanity: text regions disjoint, each inside its background, none touching the marker.
    regions = {n: TEXT_NODES[n]["region"] for n in TREE_ORDER}
    names = list(regions)
    for i, a in enumerate(names):
        ra = regions[a]
        for b in names[i + 1 :]:
            rb = regions[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
        in_panel = inside(region_wh(ra), PANEL["rect"])
        assert in_panel == (TEXT_NODES[a]["background"] == "panel"), a
        if not in_panel:
            x0, y0, w, h = PANEL["rect"]
            assert ra[2] <= x0 or ra[0] >= x0 + w or ra[3] <= y0 or ra[1] >= y0 + h, a
        m = MARKER_REGION
        assert ra[2] <= m[0] or ra[0] >= m[0] + m[2] or ra[3] <= m[1] or ra[1] >= m[1] + m[3], a

    return {
        "schema": "render-stream-gate4-expected/1",
        "fixture": "gate4-msdf",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "early_shot_steps": EARLY_SHOT_STEPS,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        "text_nodes": TREE_ORDER,
        "fonts": {"FM": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile (MSDF)", "sizes": [16, 24, 40, 56]}},
        "msdf": {"font_key": "FM", "msdf_size": MSDF_SIZE, "msdf_pixel_range": MSDF_PIXEL_RANGE, "cache": CACHE},
        "rotor": ROTOR,
        "cache_keys": [CACHE],
        "caches": {CACHE: {"format": "RGBA8", "width": PAGE_SIDE, "height": PAGE_SIDE, "mipmaps": False, "data_bytes": PAGE_SIDE * PAGE_SIDE * 4, "outline": 0, "subpixel": False}},
        "subpixel_caches": [],
        "page": {"format": "RGBA8", "width": PAGE_SIDE, "height": PAGE_SIDE, "mipmaps": False, "data_bytes": PAGE_SIDE * PAGE_SIDE * 4, "empty_texel": [0, 0, 0, 0]},
        "panel": {"rect": PANEL["rect"], "rgba8": rgba8(PANEL["colour"])},
        "marker_rect": MARKER_RECT,
        "regions": {"marker": MARKER_REGION, "panel": PANEL["rect"]},
        "backgrounds": BACKGROUNDS,
        "engine_textures": ENGINE_TEXTURES,
        "quiet_steps": QUIET_STEPS,
        "hook_versions_total": {CACHE: cen[-1]["hook_versions"][CACHE]},
        "hand_table": {str(k): {"uploads": v[0], "proves": v[1]} for k, v in HAND_TABLE.items()},
        "steps": steps,
        "predictions": predictions(states),
    }


def render(data):
    """Indented JSON with each step's small tables on one line."""

    def emit(value, indent, key=None):
        pad = "  " * indent
        if isinstance(value, dict) and indent < 3:
            items = [f"{pad}  {json.dumps(k)}: {emit(v, indent + 1, k)}" for k, v in value.items()]
            return "{\n" + ",\n".join(items) + "\n" + pad + "}" if items else "{}"
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value) and indent < 2:
            items = [f"{pad}  {emit(v, indent + 1)}" for v in value]
            return "[\n" + ",\n".join(items) + "\n" + pad + "]"
        return json.dumps(value, separators=(", ", ": "), ensure_ascii=False)

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
