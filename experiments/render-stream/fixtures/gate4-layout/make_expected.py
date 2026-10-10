#!/usr/bin/env python3
"""Write fixtures/gate4-layout/expected.json (render-stream-gate4-expected/1, fixture gate4-layout).

Every number below is derived from the fixture's strings, boxes and the engine's text rules as
read from the source (protocol/gate4-design.md Q1, Q6e, G4c), written down as code over the
fixture's own parameters. Nothing here runs or reads the engine: the glyph oracle and the capture
have to agree with it (`oracle-agrees`, `atlas-census`), and a disagreement is a finding to
explain from the source, never a number to copy.

    python3 experiments/render-stream/fixtures/gate4-layout/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate4-layout/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `ts_adv` is
modules/text_server_adv/text_server_adv.cpp), G4a's plus:

- Shaping before drawing at step 0. A Control computes its combined minimum size synchronously
  when it enters the tree (scene/gui/control.cpp:3803-3807, `_size_changed`), and a Label's
  minimum size shapes it (label.cpp:965-968). Every Label is added in `_ready`, so all of step 0's
  shaping happens, in tree order, before the first draw: each plain cache's page is uploaded once
  at step 0, by its first draw (`texture_2d_create`). At later steps a text or font change queues
  the redraw before the minimum-size update (label.cpp:1085-1099), so the Label shapes inside its
  own draw (gate4-design.md Q1c).
- Draw passes. Per line Label draws the shadow, then the outline, then the text (label.cpp:821-875);
  a shadow glyph and a text glyph use the plain cache (size x 64, 0), an outline glyph the outline
  cache (size x 64, outline size) (ts_adv:4103-4106). A plain page made dirty by shaping is
  uploaded once, at the first draw of a glyph on it (ts_adv:4001-4019). An outline glyph is
  rasterized at draw time (`_ensure_glyph` in `_font_draw_glyph_outline`, ts_adv:4133) and
  uploads its page at once: one upload per new outline glyph.
- Subpixel positioning (FX: auto at 14 px, quarter pixel). Shaping rasterizes each glyph's
  unshifted variant (ts_adv:6870-6872); the draw rasterizes each new (glyph, x shift) variant and
  uploads at once (ts_adv:3974-3987). The shifts depend on fractional advances this model does not
  know, so FX's upload count is bounded, not predicted: at least 1 at a step that adds glyphs,
  at most the oracle's new (glyph, shift) pairs (`subpixel-census`).
- Pages (Q1b). A cache's page side is max(size x 64 x 0.125, 256) rounded up to a power of two,
  at most 1024: 256 up to 32 px, 512 at 40 px, 1024 at 320 px. Every cache here has one page,
  except F@320: 26 capitals at 320 px (each about 200 x 240 px with its margins) cannot share one
  1024 x 1024 page. At step 7 the 23 new capitals first fill page 0, which holds only Z, Y and X,
  and then open page 1: page 0 is updated once and page 1 created (Q6e: at least 2 pages; the
  oracle gives the exact assignment). A, the first new glyph, is on page 0.
- Lifetime (Q1c). FL.hinting = NONE clears FL's cache (ts_adv:2569-2577): its page's ImageTexture
  is freed (`free`), and the Label's redraw re-shapes into a new cache whose page is created with a
  new RID in the same frame. The oracle names the new cache FL2.
- Sizes and boxes. A free Label keeps the larger of its box and its minimum size: a wrapping Label
  grows to its lines' height, and LP to its one 320 px line's height, which is taller than the 213
  px between its top and the viewport's bottom. So LK clips to its box and LP to its box cut by the
  viewport (clip-rects-derived).
- Wrapping. Word wrap breaks at the last space that fits (hand predictions in LINES below, from
  the box width and the strings); arbitrary wrap breaks between graphemes, so only its line
  count is predicted.
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
# Every step that uploads is also shot one frame after it applies (Q6b "Intermediate shots").
EARLY_SHOT_STEPS = [1, 2, 3, 4, 6, 7, 8]
LIFETIME_STEP = 8
# The sabotage leg's step: omit-op texture_2d_update from the multi-page step on (G4c).
OMIT_STEP = 7

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
PANEL = {"rect": [304, 8, 272, 240], "colour": [1, 1, 0.8, 1]}


def rgba8(c):
    return [round(v * 255) for v in c]


BACKGROUNDS = {"dark": CLEAR, "panel": rgba8(PANEL["colour"])}

CREATION_ORDER = ["P", "LZ", "LS", "LW", "LR", "LK", "LO", "LSh", "LX", "AL", "AC", "AR", "AF", "LL", "LP", "Marker"]

# Text nodes in tree order: font key and size, position, font colour, region [x0,y0,x1,y1),
# background, and the properties that change the draw. F is the runtime FontFile on the pinned
# bytes (subpixel off); FX the same with subpixel positioning auto; FL F's twin whose cache step 8
# clears.
TEXT_NODES = {
    "LZ": {"font": "F", "size": 16, "pos": [16, 12], "colour": [1, 1, 1, 1], "region": [8, 8, 152, 68], "background": "dark"},
    "LS": {"font": "F", "size": 12, "pos": [160, 12], "colour": [1, 0.8, 0.2, 1], "region": [152, 8, 296, 68], "background": "dark"},
    "LW": {"font": "F", "size": 16, "pos": [16, 72], "colour": [1, 1, 1, 1], "region": [8, 68, 152, 128], "background": "dark", "box": [120, 23], "autowrap": "word"},
    "LR": {"font": "F", "size": 16, "pos": [160, 72], "colour": [0.8, 0.8, 1, 0.6], "region": [152, 68, 296, 128], "background": "dark", "box": [48, 23], "autowrap": "arbitrary"},
    "LK": {"font": "F", "size": 16, "pos": [16, 132], "colour": [0.4, 1, 0.6, 1], "region": [8, 128, 96, 188], "background": "dark", "box": [80, 28], "clip": True},
    "LO": {"font": "F", "size": 24, "pos": [160, 132], "colour": [1, 1, 1, 1], "region": [152, 128, 296, 188], "background": "dark", "outline": 4, "outline_colour": [0.8, 0.2, 0.2, 1]},
    "LSh": {"font": "F", "size": 24, "pos": [16, 192], "colour": [1, 0.8, 0.2, 1], "region": [8, 188, 152, 248], "background": "dark", "shadow_colour": [0, 0, 0, 1], "shadow_offset": [2, 2]},
    "LX": {"font": "FX", "size": 14, "pos": [160, 192], "colour": [1, 1, 1, 1], "region": [152, 188, 296, 248], "background": "dark"},
    "AL": {"font": "F", "size": 16, "pos": [312, 12], "colour": [0, 0, 0.2, 1], "region": [304, 8, 440, 88], "background": "panel", "box": [120, 64], "align": ["left", "top"]},
    "AC": {"font": "F", "size": 16, "pos": [448, 12], "colour": [0, 0.2, 0, 1], "region": [440, 8, 576, 88], "background": "panel", "box": [120, 64], "align": ["center", "center"]},
    "AR": {"font": "F", "size": 16, "pos": [312, 92], "colour": [0.2, 0, 0, 1], "region": [304, 88, 440, 168], "background": "panel", "box": [120, 64], "align": ["right", "bottom"]},
    "AF": {"font": "F", "size": 16, "pos": [448, 92], "colour": [0, 0, 0, 0.6], "region": [440, 88, 576, 168], "background": "panel", "box": [120, 64], "align": ["fill", "top"]},
    "LL": {"font": "FL", "size": 16, "pos": [312, 172], "colour": [0, 0, 0.2, 1], "region": [304, 168, 440, 248], "background": "panel"},
    "LP": {"font": "F", "size": 320, "pos": [16, 147], "colour": [0.6, 0.8, 1, 1], "region": [8, 252, 616, 360], "background": "dark", "box": [600, 120], "clip": True},
}
TREE_ORDER = list(TEXT_NODES)
INITIAL_TEXT = {
    "LZ": "Grow", "LS": "Small text", "LW": "Wrap these words", "LR": "Arbitrary", "LK": "Clipped text runs on",
    "LO": "Outline", "LSh": "Shadow", "LX": "Subpixel aqua", "AL": "Left", "AC": "Centre", "AR": "Right",
    "AF": "Fill two", "LL": "Lifetime", "LP": "ZYX",
}

# The variant's LCD Label (RS_FIXTURE_VARIANT=lcd): created after the marker, in the panel's last
# free cell; its font FC differs from F only in LCD antialiasing (Q1d: RGBA8 page,
# add_lcd_texture_rect_region, typed unsupported on /2).
LCD = {"name": "LC", "font": "FC", "size": 16, "pos": [448, 172], "colour": [0, 0, 0.2, 1], "region": [440, 168, 576, 248], "background": "panel", "text": "LCD text",
       "page": {"format": "RGBA8", "width": 256, "height": 256}, "op": "canvas_item_add_lcd_texture_rect_region", "reason": "unsupported-op"}

# The timeline (gate4-design.md G4c, Q6e), in gate4_layout.gd's order per step.
# ("text", node, value) | ("size", node, px) | ("halign", node, a) | ("valign", node, a)
# | ("hinting", font) | ("outline_colour", node, rgba)
TIMELINE = {
    1: [("size", "LZ", 40)],
    2: [("text", "LW", "Words wrap again"), ("text", "LR", "Breakable")],
    3: [("text", "LO", "Overt")],
    4: [("text", "LX", "Subpixel wave")],
    5: [("halign", "AC", "right"), ("valign", "AR", "top")],
    6: [("text", "LK", "Clip me as you can")],
    7: [("text", "LP", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")],
    8: [("hinting", "FL")],
    9: [("outline_colour", "LO", [0.2, 0.6, 1, 1])],
}

# Hand predictions of the wrapped lines (the box width against the strings): word wrap keeps the
# words that fit; arbitrary wrap's break depends on glyph widths, so only its count is predicted.
LINES = {
    ("LW", "Wrap these words"): ["Wrap these", "words"],
    ("LW", "Words wrap again"): ["Words wrap", "again"],
    ("LR", "Arbitrary"): 2,
    ("LR", "Breakable"): 2,
}

# The contract's G4c expectations, typed in, never computed: per step, the uploads per cache
# (create = "c", update count otherwise; FX bounded as "b").
HAND_TABLE = {
    0: {"F@16": "c", "F@12": "c", "F@24": "c", "F@24/4": "c+6", "FX@14": "c+b", "FL@16": "c", "F@320": "c"},
    1: {"F@40": "c"},
    2: {"F@16": 1},
    3: {"F@24": 1, "F@24/4": 2},
    4: {"FX@14": "b"},
    5: {},
    6: {"F@16": 1},
    7: {"F@320": "1+c"},
    8: {"FL2@16": "c"},
    9: {},
}
HAND_FREES = {8: ["FL@16"]}
QUIET_STEPS = [5, 9]
SUBPIXEL_CACHES = ["FX@14"]
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def ink(text):
    return [c for c in text if not c.isspace()]


def page_side(size):
    """Q1b: max(size x 64 x 0.125, 256) rounded up to a power of two, at most 1024."""
    side = max(size * 64 * 0.125, 256)
    p = 1
    while p < side:
        p *= 2
    return min(p, 1024)


def cache_key(font, size, outline=0):
    return f"{font}@{size}" + (f"/{outline}" if outline else "")


def page_key(cache, index=0):
    """'F@16' -> 'F@16/0#0', 'F@24/4' -> 'F@24/4#0' (the reports' page keys, G4a As built (6))."""
    return (cache if "/" in cache else f"{cache}/0") + f"#{index}"


# --------------------------------------------------------------------------------------------
# The scene per step
# --------------------------------------------------------------------------------------------


def scene_states():
    state = {}
    for n, t in TEXT_NODES.items():
        state[n] = {
            "text": INITIAL_TEXT[n],
            "visible": True,
            "pos": list(t["pos"]),
            "font": t["font"],
            "size": t["size"],
            "colour": list(t["colour"]),
            "outline_colour": list(t.get("outline_colour", [0, 0, 0, 1])),
            "align": list(t.get("align", ["left", "top"])),
            "generation": 0,
        }
    out = []
    for step in range(LAST_STEP + 1):
        changes = TIMELINE.get(step, [])
        draws = []
        for change in changes:
            kind = change[0]
            if kind == "text":
                state[change[1]]["text"] = change[2]
                draws.append(change[1])
            elif kind == "size":
                state[change[1]]["size"] = change[2]
                draws.append(change[1])
            elif kind == "halign":
                state[change[1]]["align"][0] = change[2]
                draws.append(change[1])
            elif kind == "valign":
                state[change[1]]["align"][1] = change[2]
                draws.append(change[1])
            elif kind == "outline_colour":
                state[change[1]]["outline_colour"] = list(change[2])
                draws.append(change[1])
            elif kind == "hinting":
                for n in TREE_ORDER:
                    if TEXT_NODES[n]["font"] == change[1]:
                        state[n]["font"] = change[1] + "2"
                        state[n]["generation"] += 1
                        draws.append(n)
        out.append({"nodes": copy.deepcopy(state), "draws": draws if step > 0 else list(TREE_ORDER), "changes": changes})
    return out


def passes(node, st):
    """The node's glyph draws in order, as (cache key, codepoint, pass)."""
    t = TEXT_NODES[node]
    plain = cache_key(st["font"], st["size"])
    glyphs = ink(st["text"])
    out = []
    # One line or several, the per-line passes keep codepoint order within each pass and the
    # cache each pass uses; uploads depend only on which glyph of a cache is drawn first.
    if "shadow_colour" in t:
        out += [(plain, c, "shadow") for c in glyphs]
    if t.get("outline"):
        out += [(cache_key(st["font"], st["size"], t["outline"]), c, "outline") for c in glyphs]
    out += [(plain, c, "text") for c in glyphs]
    return out


def census(states):
    """Q1c and the model above: per step, per cache the new glyphs, creates, updates, hook
    versions; frees; subpixel caches are marked bounded."""
    glyphs = {}  # cache -> set of rasterized glyphs
    pages = {}  # page key -> {"created": bool, "dirty": bool, "version": int}
    freed = set()
    steps = []

    def touch(pk):
        return pages.setdefault(pk, {"created": False, "dirty": False, "version": 0})

    for k, st in enumerate(states):
        new_glyphs, creates, updates, frees, bounded = {}, {}, {}, [], []
        nodes = st["nodes"]

        def shape(node):
            s = nodes[node]
            cache = cache_key(s["font"], s["size"])
            have = glyphs.setdefault(cache, [])
            fresh = [c for i, c in enumerate(ink(s["text"])) if c not in have and c not in ink(s["text"])[:i]]
            if not fresh:
                return
            have.extend(fresh)
            new_glyphs[cache] = new_glyphs.get(cache, "") + "".join(fresh)
            if cache == "F@320" and k == 7:
                # Q1b: the new capitals fill page 0 and open page 1 (module docstring).
                touch(page_key(cache, 0))["dirty"] = True
                touch(page_key(cache, 1))["dirty"] = True
            else:
                touch(page_key(cache, 0))["dirty"] = True

        def upload(cache, pk):
            p = touch(pk)
            p["version"] += 1
            p["dirty"] = False
            if p["created"]:
                updates[cache] = updates.get(cache, 0) + 1
            else:
                p["created"] = True
                creates[cache] = creates.get(cache, 0) + 1

        def draw(node):
            outline_seen = set()
            for cache, c, kind in passes(node, nodes[node]):
                if kind == "outline":
                    have = glyphs.setdefault(cache, [])
                    if c in have or c in outline_seen:
                        continue
                    outline_seen.add(c)
                    have.append(c)
                    new_glyphs[cache] = new_glyphs.get(cache, "") + c
                    upload(cache, page_key(cache, 0))
                    continue
                for pk in [p for p in pages if p.startswith(page_key(cache, 0)[:-1]) and pages[p]["dirty"]]:
                    upload(cache, pk)
            cache = cache_key(nodes[node]["font"], nodes[node]["size"])
            if cache in SUBPIXEL_CACHES and cache in new_glyphs:
                bounded.append(cache)

        for change in st["changes"]:
            if change[0] == "hinting":
                for cache in [c for c in glyphs if c.split("@")[0] == change[1]]:
                    frees.append(cache)
                    freed.add(cache)
                    for pk in [p for p in pages if p.startswith(cache + "/")]:
                        del pages[pk]
        if k == 0:
            for node in TREE_ORDER:
                shape(node)
            for node in TREE_ORDER:
                draw(node)
        else:
            for node in st["draws"]:
                if any(ch[0] in ("text", "size", "hinting") and (ch[1] == node or ch[1] == TEXT_NODES[node]["font"]) for ch in st["changes"]):
                    shape(node)
                draw(node)
        hook = {pk: p["version"] for pk, p in pages.items()}
        steps.append(
            {
                "new_glyphs": new_glyphs,
                "page_creates": creates,
                "page_uploads": {c: n for c, n in updates.items() if c not in SUBPIXEL_CACHES},
                "subpixel_bounded": sorted(set(bounded)),
                "frees": frees,
                "hook_versions": {pk: v for pk, v in hook.items() if pk.split("/")[0] not in SUBPIXEL_CACHES},
                "pages": sorted(hook),
                "page_glyphs": {c: len(v) for c, v in glyphs.items() if c not in freed},
            }
        )
    return steps


def appearance(s):
    if not s["visible"] or not ink(s["text"]):
        return None
    return json.dumps([s["text"], s["colour"], s["pos"], s["size"], s["outline_colour"], s["align"], s["generation"]])


def lines_of(node, text):
    p = LINES.get((node, text))
    if p is None:
        return [text]
    return p


# --------------------------------------------------------------------------------------------
# Predictions (the sabotage leg), from the same model
# --------------------------------------------------------------------------------------------


def predictions(states, cen):
    """omit-op texture_2d_update from OMIT_STEP's frame: every page update from then on is
    dropped (creates still travel). A node's region mismatches when it draws a glyph that reached
    its page only through a dropped update; A, LP's first new glyph at step 7, is on page 0
    (module docstring), whose step-7 update is dropped."""
    steps, regions, parity = [], {}, {}
    for k in range(OMIT_STEP, LAST_STEP + 1):
        bad_nodes = []
        for n in TREE_ORDER:
            s = states[k]["nodes"][n]
            cache = cache_key(s["font"], s["size"])
            dropped = "".join(cen[j]["new_glyphs"].get(cache, "") for j in range(OMIT_STEP, k + 1) if cen[j]["page_uploads"].get(cache))
            if any(c in dropped for c in ink(s["text"])):
                bad_nodes.append(n)
        bad_caches = sorted({cache for j in range(OMIT_STEP, k + 1) for cache in cen[j]["page_uploads"]})
        for cache in bad_caches:
            parity.setdefault(cache, []).append(k)
        if bad_nodes:
            steps.append(k)
            regions[str(k)] = bad_nodes
    return {
        "sabotage-layout-omit-atlas": {
            "frame": frame_of(OMIT_STEP),
            "op": "texture_2d_update",
            "steps": steps,
            "regions": regions,
            "atlas_hash_parity_fails": parity,
        }
    }


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------


def region_wh(r):
    return [r[0], r[1], r[2] - r[0], r[3] - r[1]]


def inside(r, outer):
    return r[0] >= outer[0] and r[1] >= outer[1] and r[2] <= outer[0] + outer[2] and r[3] <= outer[1] + outer[3]


def clip_rect(node):
    """LK clips to its box; LP to its box grown to one 320 px line (> 213 px) and cut by the
    viewport. Position and size are integers, so rounding is exact."""
    t = TEXT_NODES[node]
    x0, y0 = t["pos"]
    w, h = t["box"]
    if node == "LP":
        return [x0, y0, x0 + w, VIEWPORT[1]]
    return [x0, y0, x0 + w, y0 + h]


def build():
    states = scene_states()
    cen = census(states)
    steps = []
    for k, st in enumerate(states):
        nodes = st["nodes"]
        c = cen[k]
        texts = {}
        for n in TREE_ORDER:
            s = nodes[n]
            t = TEXT_NODES[n]
            entry = {"text": s["text"], "font_key": s["font"], "size": s["size"], "colour": s["colour"], "visible": s["visible"], "position": s["pos"]}
            if t.get("outline"):
                entry["outline_size"] = t["outline"]
                entry["outline_colour"] = s["outline_colour"]
            if "shadow_colour" in t:
                entry["shadow_colour"] = t["shadow_colour"]
                entry["shadow_offset"] = t["shadow_offset"]
            if "align" in t:
                entry["align"] = s["align"]
            if "autowrap" in t:
                entry["autowrap"] = t["autowrap"]
            if t.get("clip"):
                entry["clip"] = True
            texts[n] = entry
        ink_glyphs = {n: len(ink(nodes[n]["text"])) for n in TREE_ORDER}
        commands = {}
        for n in TREE_ORDER:
            t = TEXT_NODES[n]
            commands[n] = ink_glyphs[n] * (1 + (1 if t.get("outline") else 0) + (1 if "shadow_colour" in t else 0))
        ink_min = {}
        for n in TREE_ORDER:
            t = TEXT_NODES[n]
            if t.get("clip"):
                # One em is wider than any advance here: the clip shows at least w // size glyphs.
                ink_min[n] = max(1, min(ink_glyphs[n], (clip_rect(n)[2] - clip_rect(n)[0]) // nodes[n]["size"]))
            else:
                ink_min[n] = ink_glyphs[n]
        lines = {}
        for n in TREE_ORDER:
            p = lines_of(n, nodes[n]["text"])
            lines[n] = p
        fresh = {n: (k > 0 and appearance(nodes[n]) != appearance(states[k - 1]["nodes"][n])) for n in TREE_ORDER}
        wire_versions = dict(c["hook_versions"])
        page_counts = {}
        for pk in c["pages"]:
            cache = pk.split("#")[0]
            cache = cache[:-2] if cache.endswith("/0") else cache
            page_counts[cache] = page_counts.get(cache, 0) + 1
        steps.append(
            {
                "step": k,
                "applied_frame": frame_of(k),
                "settle_frame": frame_of(k, True),
                "marker_rgba8": MARKER[k],
                "texts": texts,
                "draws": st["draws"],
                "ink_glyphs": ink_glyphs,
                "ink_min_glyphs": ink_min,
                "commands": commands,
                "lines": lines,
                "new_glyphs": dict(sorted(c["new_glyphs"].items())),
                "page_uploads": dict(sorted(c["page_uploads"].items())),
                "page_creates": dict(sorted(c["page_creates"].items())),
                "subpixel_bounded": c["subpixel_bounded"],
                "frees": c["frees"],
                "hook_versions": dict(sorted(c["hook_versions"].items())),
                "wire_versions": dict(sorted(wire_versions.items())),
                "page_glyphs": dict(sorted(c["page_glyphs"].items())),
                "page_counts": dict(sorted(page_counts.items())),
                "text_regions": {n: TEXT_NODES[n]["region"] for n in TREE_ORDER},
                "background": {n: BACKGROUNDS[TEXT_NODES[n]["background"]] for n in TREE_ORDER},
                "clip_rects": {n: clip_rect(n) for n in TREE_ORDER if TEXT_NODES[n].get("clip")},
                "fresh": fresh,
            }
        )

    # The contract's hand table equals the derivation.
    for k, row in HAND_TABLE.items():
        s = steps[k]
        got = {}
        for cache in sorted(set(s["page_creates"]) | set(s["page_uploads"]) | set(s["subpixel_bounded"])):
            cr, up, b = s["page_creates"].get(cache, 0), s["page_uploads"].get(cache, 0), cache in s["subpixel_bounded"]
            if cr and up:
                got[cache] = f"{up}+c" if cache == "F@320" else f"c+{up}"
            elif cr:
                got[cache] = "c+b" if b else "c"
            elif b:
                got[cache] = "b"
            else:
                got[cache] = up
        assert got == row, f"step {k}: derived {got} != hand {row}"
        assert sorted(s["frees"]) == sorted(HAND_FREES.get(k, [])), (k, s["frees"])
    for k in QUIET_STEPS:
        s = steps[k]
        assert not s["page_uploads"] and not s["page_creates"] and not s["subpixel_bounded"] and not s["frees"], k
    for k, s in enumerate(steps):
        for cache, n in s["page_counts"].items():
            want = 2 if cache == "F@320" and k >= 7 else 1
            assert n == want, (k, cache, n)
    for (node, text), p in LINES.items():
        if isinstance(p, list):
            assert ink("".join(p)) == ink(text), (node, text)

    # Layout sanity: text regions disjoint, each inside one background, none touching the marker,
    # and the LCD variant's region free in the main fixture.
    marker_region = [584, 8, 48, 48]
    regions = {n: TEXT_NODES[n]["region"] for n in TREE_ORDER}
    regions[LCD["name"]] = LCD["region"]
    names = list(regions)
    for i, a in enumerate(names):
        ra = regions[a]
        for b in names[i + 1 :]:
            rb = regions[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
        bg = LCD["background"] if a == LCD["name"] else TEXT_NODES[a]["background"]
        in_panel = inside(region_wh(ra), PANEL["rect"])
        assert in_panel == (bg == "panel"), a
        if not in_panel:
            x0, y0, w, h = PANEL["rect"]
            assert ra[2] <= x0 or ra[0] >= x0 + w or ra[3] <= y0 or ra[1] >= y0 + h, a
        m = marker_region
        assert ra[2] <= m[0] or ra[0] >= m[0] + m[2] or ra[3] <= m[1] or ra[1] >= m[1] + m[3], a
    # A clipped Label's region ends at its clip's right edge, so pixels past it are checked exact.
    for n in ("LK", "LP"):
        assert TEXT_NODES[n]["region"][2] == clip_rect(n)[2], n

    caches = {}
    all_caches = sorted({cache for c in cen for cache in c["page_glyphs"]} | {cache for c in cen for cache in c["new_glyphs"]})
    for cache in all_caches:
        size = int(cache.split("@")[1].split("/")[0])
        side = page_side(size)
        caches[cache] = {"format": "LA8", "width": side, "height": side, "mipmaps": False, "data_bytes": side * side * 2, "outline": int(cache.split("/")[1]) if "/" in cache else 0, "subpixel": cache in SUBPIXEL_CACHES}

    hook_versions_total = dict(sorted(cen[-1]["hook_versions"].items()))
    return {
        "schema": "render-stream-gate4-expected/1",
        "fixture": "gate4-layout",
        "viewport": list(VIEWPORT),
        "clear_rgba8": CLEAR,
        "start_frame_default": S,
        "step_frames_default": N,
        "settle_offset": SETTLE,
        "quit_frame_default": QUIT,
        "last_step": LAST_STEP,
        "early_shot_steps": EARLY_SHOT_STEPS,
        "lifetime_step": LIFETIME_STEP,
        "creation_order": CREATION_ORDER,
        "created_later": [],
        "text_nodes": TREE_ORDER,
        "fonts": {
            "F": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "sizes": [12, 16, 24, 40, 320], "subpixel_positioning": "disabled"},
            "FX": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "sizes": [14], "subpixel_positioning": "auto"},
            "FL": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "sizes": [16], "subpixel_positioning": "disabled", "until_step": LIFETIME_STEP},
            "FL2": {"file": "OpenSans_SemiBold.woff2", "kind": "FL after hinting = NONE", "sizes": [16], "subpixel_positioning": "disabled", "from_step": LIFETIME_STEP},
        },
        "cache_keys": all_caches,
        "caches": caches,
        "subpixel_caches": SUBPIXEL_CACHES,
        "page": {"format": "LA8", "width": 256, "height": 256, "mipmaps": False, "data_bytes": 256 * 256 * 2, "empty_texel": [255, 0]},
        "panel": {"rect": PANEL["rect"], "rgba8": rgba8(PANEL["colour"])},
        "marker_rect": MARKER_RECT,
        "regions": {"marker": marker_region, "panel": PANEL["rect"]},
        "backgrounds": BACKGROUNDS,
        "engine_textures": ENGINE_TEXTURES,
        "quiet_steps": QUIET_STEPS,
        "hook_versions_total": hook_versions_total,
        "hand_table": {str(k): {"uploads": row, "frees": HAND_FREES.get(k, [])} for k, row in HAND_TABLE.items()},
        "lcd": {**{k: v for k, v in LCD.items()}, "background_rgba8": BACKGROUNDS[LCD["background"]], "ink_glyphs": len(ink(LCD["text"])), "creation_order": CREATION_ORDER + [LCD["name"]]},
        "steps": steps,
        "predictions": predictions(states, cen),
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
