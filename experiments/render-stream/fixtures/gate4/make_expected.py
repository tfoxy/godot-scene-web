#!/usr/bin/env python3
"""Write fixtures/gate4/expected.json (render-stream-gate4-expected/1).

Every number below is derived from the fixture's strings and the engine's text rules as read
from the source (protocol/gate4-design.md Q1), written down as code over the fixture's own
parameters. Nothing here runs or reads the engine: the glyph oracle and the capture have to agree
with it (`oracle-agrees`, `atlas-census`), and a disagreement is a finding to explain from the
source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate4/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate4/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `ts_adv` is
modules/text_server_adv/text_server_adv.cpp):

- Redraws. `Label.set_text` returns early on unchanged text, otherwise queues a redraw and a
  deferred minimum-size update (scene/gui/label.cpp:1085-1099); a theme colour override queues a
  redraw; `visible = true` redraws; a position change never redraws a Control. Deferred calls
  flush in the order the script made them, so the Labels a step touches draw in that order. At
  step 0 every Label draws in tree order. The redraw of a hidden Label stops before
  NOTIFICATION_DRAW (scene/main/canvas_item.cpp:142), and update_minimum_size returns early for
  it (scene/gui/control.cpp:1666-1668): a hidden Label never shapes.
- Rasterize-then-upload (gate4-design.md Q1c). With subpixel positioning disabled, shaping
  rasterizes every glyph the text needs (ts_adv:6870-6872) into the first page of its cache
  `(font, size)` (one page here: 256x256 LA8 up to 32 px, ts_adv:856-871). The first draw of a
  glyph on a dirty page uploads that page (ts_adv:4001-4019): `texture_2d_create` the first time,
  `texture_2d_update` of the whole page afterwards. So each Label draw that introduced new glyphs
  into a page uploads it exactly once. A space and U+200B (Label appends one to every paragraph,
  label.cpp:160-163) have empty bitmaps: no texels, no upload, no command (ts_adv:1104-1109).
- Commands. Each glyph with ink is one add_texture_rect_region (ts_adv:4057-4061). The strings
  avoid fi/fl/ff and combining marks, so ink glyphs equal non-space codepoints.
- Wire versions. Every hook call bumps a page's version; a transaction publishes the latest, so
  two uploads in one frame publish one version (render-stream-2.md "Texture").
- Pixels. Outside the text regions the frame is the clear colour, the panel P and the marker:
  exact (D8). A text region shows ink exactly when its node is visible with text, and it differs
  from the previous step exactly when the node's text, colour, position or visibility changed.
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
EARLY_SHOT_STEPS = [1, 4, 7]

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

PANEL = {"rect": [320, 24, 248, 240], "colour": [1, 1, 0.8, 1]}


def rgba8(c):
    return [round(v * 255) for v in c]


BACKGROUNDS = {"dark": CLEAR, "panel": rgba8(PANEL["colour"])}

# Wire id order: every CanvasItem in canvas_item_create order (gate4.gd _ready).
CREATION_ORDER = ["P", "L1", "L3", "LD", "LT", "L2", "LA", "LH", "Marker"]
# Text nodes in tree order. Fonts: F is the runtime FontFile on the pinned bytes, DF the default
# theme font (the same bytes, its own FontFile and so its own caches). Theme Label colour (1,1,1).
TEXT_NODES = {
    "L1": {"font": "F", "size": 16, "pos": [24, 32], "colour": [1, 1, 1, 1], "region": [16, 24, 312, 64], "background": "dark"},
    "L3": {"font": "F", "size": 24, "pos": [24, 88], "colour": [1, 0.8, 0.2, 1], "region": [16, 80, 312, 128], "background": "dark"},
    "LD": {"font": "DF", "size": 16, "pos": [24, 152], "colour": [1, 1, 1, 1], "region": [16, 144, 312, 184], "background": "dark"},
    "LT": {"font": "F", "size": 16, "pos": [24, 208], "colour": [1, 1, 1, 0.6], "region": [16, 200, 312, 240], "background": "dark"},
    "L2": {"font": "F", "size": 16, "pos": [344, 32], "colour": [0, 0, 0.2, 1], "region": [336, 24, 568, 64], "background": "panel"},
    "LA": {"font": "F", "size": 16, "pos": [344, 88], "colour": [0, 0, 0, 0.6], "region": [336, 80, 568, 120], "background": "panel"},
    "LH": {"font": "F", "size": 16, "pos": [344, 152], "colour": [0, 0, 0.2, 1], "region": [336, 144, 568, 184], "background": "panel"},
}
TREE_ORDER = list(TEXT_NODES)
INITIAL_TEXT = {"L1": "Hello", "L2": "Hello", "L3": "Sphinx", "LD": "Default", "LT": "Hole", "LA": "Hole", "LH": ""}
INITIAL_VISIBLE = {name: name != "LH" for name in TEXT_NODES}

# The timeline (gate4-design.md Q6b): per step, the changes in the order gate4.gd makes them.
# ("text", node, value) | ("move", node, dx) | ("show", node) | ("colour", node, rgba)
TIMELINE = {
    1: [("text", "L1", "Hello Quartz")],
    2: [("move", "L3", 8)],
    3: [("text", "LH", "Wyvern")],
    4: [("show", "LH")],
    5: [("text", "L1", "")],
    6: [("text", "L1", "Quartz Hello")],
    7: [("text", "L2", "Jump!"), ("text", "L1", "Fjord")],
    8: [("colour", "L3", [0.4, 1, 0.6, 1])],
    9: [("text", "LD", "Default 2")],
}

# The contract's hand table (gate4-design.md Q6b), typed in, never computed:
# step -> (ink glyphs L1/L2/L3/LD/LT/LA/LH, new F16 glyphs, F16 uploads, other pages).
HAND_TABLE = {
    0: ([5, 5, 6, 7, 4, 4, 0], "Helo", "create", {"F@24": "create", "DF@16": "create"}),
    1: ([11, 5, 6, 7, 4, 4, 0], "Quartz", 1, {}),
    2: ([11, 5, 6, 7, 4, 4, 0], "", 0, {}),
    3: ([11, 5, 6, 7, 4, 4, 0], "", 0, {}),
    4: ([11, 5, 6, 7, 4, 4, 6], "Wyvn", 1, {}),
    5: ([0, 5, 6, 7, 4, 4, 6], "", 0, {}),
    6: ([11, 5, 6, 7, 4, 4, 6], "", 0, {}),
    7: ([5, 5, 6, 7, 4, 4, 6], "JmpFjd!", 2, {}),
    8: ([5, 5, 6, 7, 4, 4, 6], "", 0, {}),
    9: ([5, 5, 6, 8, 4, 4, 6], "", 0, {"DF@16": 1}),
}
HAND_ORDER = ["L1", "L2", "L3", "LD", "LT", "LA", "LH"]
# Q6b: "Expected hook versions are F16 1, 2, 3, 4+5, then DF 1->2 and F24 1. Wire versions are
# F16 1, 2, 3, 5."
HAND_WIRE_VERSIONS = {"F@16": [1, 2, 2, 2, 3, 3, 3, 5, 5, 5], "F@24": [1] * 10, "DF@16": [1] * 9 + [2]}
HAND_F16_GLYPHS = 21

# The one texture the engine makes itself (memory rs-g2a-texture-census-facts): the default
# theme's ColorPicker hue strip, a GradientTexture2D whose deferred update runs in frame 1.
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]

# Steps whose frames must carry no texture call at all.
QUIET_STEPS = [2, 3, 5, 6, 8]


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def cache_key(node):
    t = TEXT_NODES[node]
    return f"{t['font']}@{t['size']}"


def ink(text):
    """Ink glyphs of a single-line Latin string: its non-space codepoints (no ligatures)."""
    return [c for c in text if not c.isspace()]


# --------------------------------------------------------------------------------------------
# The scene per step
# --------------------------------------------------------------------------------------------


def scene_states():
    """Per step: each text node's (text, visible, position, colour) and the ordered draws."""
    state = {
        n: {"text": INITIAL_TEXT[n], "visible": INITIAL_VISIBLE[n], "pos": list(TEXT_NODES[n]["pos"]), "colour": list(TEXT_NODES[n]["colour"])}
        for n in TEXT_NODES
    }
    out = []
    for step in range(LAST_STEP + 1):
        if step == 0:
            draws = [n for n in TREE_ORDER if state[n]["visible"]]
        else:
            draws = []
            for change in TIMELINE.get(step, []):
                kind, node = change[0], change[1]
                if kind == "text":
                    if state[node]["text"] != change[2]:
                        state[node]["text"] = change[2]
                        draws.append(node)
                elif kind == "move":
                    state[node]["pos"][0] += change[2]
                elif kind == "show":
                    state[node]["visible"] = True
                    draws.append(node)
                elif kind == "colour":
                    state[node]["colour"] = list(change[2])
                    draws.append(node)
            draws = [n for n in draws if state[n]["visible"]]
        out.append({"nodes": copy.deepcopy(state), "draws": draws})
    return out


def census(states):
    """Q1c over the draws: per step, new glyphs, uploads and creates per cache, hook versions."""
    rasterized = {}
    created = set()
    version = {}
    steps = []
    for st in states:
        new_glyphs, uploads, creates = {}, {}, {}
        for node in st["draws"]:
            key = cache_key(node)
            have = rasterized.setdefault(key, [])
            fresh = []
            for c in ink(st["nodes"][node]["text"]):
                if c not in have and c not in fresh:
                    fresh.append(c)
            if not fresh:
                continue
            have.extend(fresh)
            new_glyphs.setdefault(key, []).extend(fresh)
            version[key] = version.get(key, 0) + 1
            if key in created:
                uploads[key] = uploads.get(key, 0) + 1
            else:
                created.add(key)
                creates[key] = 1
        steps.append(
            {
                "new_glyphs": new_glyphs,
                "page_uploads": uploads,
                "page_creates": creates,
                "hook_versions": dict(version),
                "page_glyphs": {k: len(v) for k, v in rasterized.items()},
            }
        )
    return steps


def appearance(node_state):
    """What a text region shows: nothing, or the node's text, colour and position."""
    if not node_state["visible"] or not ink(node_state["text"]):
        return None
    return (node_state["text"], tuple(node_state["colour"]), tuple(node_state["pos"]))


# --------------------------------------------------------------------------------------------
# Sabotage predictions (G4b's legs), from the same model
# --------------------------------------------------------------------------------------------


def predictions(states, cen):
    def mismatch(views):
        return [k for k in range(LAST_STEP + 1) if views[k] != reference_views[k]]

    def views_of(state_at, marker_at, pages_at):
        out = []
        for k in range(LAST_STEP + 1):
            nodes = state_at(k)
            text = {}
            for n in TEXT_NODES:
                a = appearance(nodes[n])
                if a is not None:
                    have = pages_at(k)[cache_key(n)]
                    a = (*a, tuple(c in have for c in ink(nodes[n]["text"])))
                text[n] = a
            out.append((marker_at(k), text))
        return out

    full_pages = lambda k: {key: set(states_glyphs(cen, k, key)) for key in cache_keys()}  # noqa: E731
    reference_views = views_of(lambda k: states[k]["nodes"], lambda k: k, full_pages)
    pred = {}
    # freeze-frame at step 1's frame: every later transaction republishes step 0's.
    pred["sabotage-freeze"] = {"frame": frame_of(1), "steps": mismatch(views_of(lambda k: states[min(k, 0)]["nodes"], lambda k: 0, lambda k: full_pages(0)))}
    # perturb-transform at step 2's frame: +1 px on every item's origin from then on.
    perturbed = []
    for k, v in enumerate(reference_views):
        perturbed.append(v if k < 2 else ("perturbed", v))
    pred["sabotage-perturb"] = {"frame": frame_of(2), "steps": mismatch(perturbed)}
    # omit-op texture_2d_update from step 4's frame: every page keeps its content as of step 3.
    omit_from = 4
    frozen_pages = lambda k: full_pages(k) if k < omit_from else {key: (full_pages(k)[key] if versions_at(cen, k, key) == versions_at(cen, omit_from - 1, key) else set(states_glyphs(cen, omit_from - 1, key))) for key in cache_keys()}  # noqa: E731
    omit_views = views_of(lambda k: states[k]["nodes"], lambda k: k, frozen_pages)
    parity = {}
    for key in cache_keys():
        bad = [k for k in range(omit_from, LAST_STEP + 1) if versions_at(cen, k, key) != versions_at(cen, omit_from - 1, key)]
        if bad:
            parity[key] = bad
    pred["sabotage-omit-atlas"] = {"frame": frame_of(omit_from), "op": "texture_2d_update", "steps": mismatch(omit_views), "atlas_hash_parity_fails": parity}
    return pred


def cache_keys():
    return sorted({cache_key(n) for n in TEXT_NODES})


def states_glyphs(cen, k, key):
    out = []
    for step in range(k + 1):
        out.extend(cen[step]["new_glyphs"].get(key, []))
    return out


def versions_at(cen, k, key):
    return cen[k]["hook_versions"].get(key, 0)


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------


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
        texts = {
            n: {"text": nodes[n]["text"], "font_key": TEXT_NODES[n]["font"], "size": TEXT_NODES[n]["size"], "colour": nodes[n]["colour"], "visible": nodes[n]["visible"], "position": nodes[n]["pos"]}
            for n in TREE_ORDER
        }
        ink_glyphs = {n: (len(ink(nodes[n]["text"])) if nodes[n]["visible"] else 0) for n in TREE_ORDER}
        fresh = {n: (k > 0 and appearance(nodes[n]) != appearance(states[k - 1]["nodes"][n])) for n in TREE_ORDER}
        wire_versions = {key: v for key, v in c["hook_versions"].items()}
        steps.append(
            {
                "step": k,
                "applied_frame": frame_of(k),
                "settle_frame": frame_of(k, True),
                "marker_rgba8": MARKER[k],
                "texts": texts,
                "draws": st["draws"],
                "ink_glyphs": ink_glyphs,
                "new_glyphs": {key: "".join(v) for key, v in sorted(c["new_glyphs"].items())},
                "page_uploads": dict(sorted(c["page_uploads"].items())),
                "page_creates": dict(sorted(c["page_creates"].items())),
                "hook_versions": dict(sorted(c["hook_versions"].items())),
                "wire_versions": dict(sorted(wire_versions.items())),
                "page_glyphs": dict(sorted(c["page_glyphs"].items())),
                "page_counts": {key: 1 for key in sorted(c["hook_versions"])},
                "text_regions": {n: TEXT_NODES[n]["region"] for n in TREE_ORDER},
                "background": {n: BACKGROUNDS[TEXT_NODES[n]["background"]] for n in TREE_ORDER},
                "fresh": fresh,
            }
        )

    # The contract's hand table equals the derivation.
    for k, (ink_row, new16, up16, other) in HAND_TABLE.items():
        s = steps[k]
        got_ink = [s["ink_glyphs"][n] for n in HAND_ORDER]
        assert got_ink == ink_row, f"step {k}: ink {got_ink} != hand {ink_row}"
        assert sorted(s["new_glyphs"].get("F@16", "")) == sorted(new16), f"step {k}: new F16 {s['new_glyphs']} != hand {new16}"
        got16 = "create" if s["page_creates"].get("F@16") else s["page_uploads"].get("F@16", 0)
        assert got16 == up16, f"step {k}: F16 uploads {got16} != hand {up16}"
        got_other = {key: ("create" if key in s["page_creates"] else n) for key, n in {**s["page_uploads"], **s["page_creates"]}.items() if key != "F@16"}
        assert got_other == other, f"step {k}: other pages {got_other} != hand {other}"
    for key, versions in HAND_WIRE_VERSIONS.items():
        got = [s["wire_versions"].get(key, 0) for s in steps]
        assert got == versions, f"{key}: wire versions {got} != hand {versions}"
    assert steps[-1]["page_glyphs"]["F@16"] == HAND_F16_GLYPHS
    for k in QUIET_STEPS:
        assert not steps[k]["page_uploads"] and not steps[k]["page_creates"], k

    # Layout sanity: text regions disjoint, each inside its background, none touching the marker.
    marker_region = [584, 8, 48, 48]
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

    hook_versions_total = {key: cen[-1]["hook_versions"][key] for key in cache_keys()}
    return {
        "schema": "render-stream-gate4-expected/1",
        "fixture": "gate4",
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
        "fonts": {"F": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "sizes": [16, 24]}, "DF": {"file": "OpenSans_SemiBold.woff2", "kind": "default theme", "sizes": [16]}},
        "cache_keys": cache_keys(),
        "page": {"format": "LA8", "width": 256, "height": 256, "mipmaps": False, "data_bytes": 256 * 256 * 2, "empty_texel": [255, 0]},
        "panel": {"rect": PANEL["rect"], "rgba8": rgba8(PANEL["colour"])},
        "marker_rect": MARKER_RECT,
        "regions": {"marker": marker_region, "panel": PANEL["rect"]},
        "backgrounds": BACKGROUNDS,
        "engine_textures": ENGINE_TEXTURES,
        "quiet_steps": QUIET_STEPS,
        "hook_versions_total": hook_versions_total,
        "hand_table": {
            str(k): {"ink_glyphs": dict(zip(HAND_ORDER, row[0])), "new_f16": row[1], "f16_uploads": row[2], "other_pages": row[3]} for k, row in HAND_TABLE.items()
        },
        "steps": steps,
        "predictions": predictions(states, cen),
    }


def render(data):
    """Indented JSON with each step's small tables on one line."""

    def emit(value, indent, key=None):
        pad = "  " * indent
        if isinstance(value, dict) and key not in ("texts_entry",) and indent < 3:
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
