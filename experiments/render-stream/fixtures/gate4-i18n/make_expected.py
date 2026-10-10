#!/usr/bin/env python3
"""Write fixtures/gate4-i18n/expected.json (render-stream-gate4-expected/1, fixture gate4-i18n).

Every number below is derived from the fixture's strings, positions and the engine's text rules
as read from the source (protocol/gate4-design.md Q1, Q6e, G4f), written down as code over the
fixture's own parameters. Nothing here runs or reads the engine: the glyph oracle and the capture
have to agree with it (`oracle-agrees-i18n`, `atlas-census-i18n`, `script-predictions`), and a
disagreement is a finding to explain from the source, never a number to copy. For complex scripts
the oracle is the only source of glyph counts (G4f): this model predicts which caches gain
glyphs, never how many glyphs a complex string shapes to.

    python3 experiments/render-stream/fixtures/gate4-i18n/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate4-i18n/make_expected.py --check   # diff only

The model (source lines are in ../godot-4.5.1-stable; `ts_adv` is
modules/text_server_adv/text_server_adv.cpp), G4a's and G4c's plus:

- Fallback. Every Label's font is OS with fallbacks VZ, DV, HE (Font::get_rids,
  scene/resources/font.cpp:103-122). `_shape_run` shapes a run with OS first and re-shapes every
  sub-run of invalid (notdef) clusters with the next font (ts_adv:6642-6960), so each codepoint
  is drawn from the first font of the chain that maps it. The fixture asserts that font per
  string at startup (COVERAGE, the same table as here); ASCII is always OS.
- Glyph identity, for the census only. A cache gains glyphs when a Label draws a unit no earlier
  draw put in it. A unit is a codepoint, except: whitespace and ZWNJ draw nothing (an empty
  bitmap, ts_adv:1104-1109; a zero-width index-0 glyph, ts_adv:6782-6786); the NFD sequence
  e + U+0302 + U+0301 is one unit, U+1EBF, because HarfBuzz composes it when the font maps the
  composition (OS does; the fixture asserts it); and Devanagari is segmented by hand
  (DEVANAGARI_UNITS): the KSSA conjunct is one ligature unit, so standalone KA (U+0915) in
  DEVANAGARI_2 is a unit the first Devanagari Label never drew.
- Uploads (Q1c with G4c's step 0). Labels added in `_ready` shape before anything draws, so OS's
  page is created once at step 0. Later a text change shapes in the Label's own draw; each draw
  that put new units into a cache uploads that cache's page once (a create the first time). The
  two Devanagari Labels change in one frame: LD1's draw creates DV's page, LD2's updates it
  (G4a's step 7 rule, two Labels in one frame).
- Pages (Q1b): every cache is 16 px, so one 256 x 256 LA8 page each. Caches with no glyphs exist
  from step 0 for every font (Font::get_height asks every fallback's ascent and descent at the
  Label's size), but a fallback's page exists only once its script is drawn (`fallback-pages`).
- Hex box (servers/text_server.cpp:757-799). U+2603 is mapped by no pinned font, so `_shape_run`
  falls through the chain to a glyph with no font whose index is the codepoint, and Label's
  `draw_glyph` (scene/gui/label.cpp:419-425) draws `draw_hex_code_box`: the frame's 4 add_rects
  plus one per lit seven-segment bar of each hex digit, and no texture command.
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
SIZE = 16
# Every step that uploads is also shot one frame after it applies (Q6b "Intermediate shots").
EARLY_SHOT_STEPS = [1, 2, 3, 4, 5]
# The sabotage leg: omit-op texture_2d_update from the step that first shows Devanagari (G4f).
OMIT_STEP = 5

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
PANEL = {"rect": [400, 8, 176, 240], "colour": [1, 1, 0.8, 1]}


def rgba8(c):
    return [round(v * 255) for v in c]


BACKGROUNDS = {"dark": CLEAR, "panel": rgba8(PANEL["colour"])}

FALLBACK_ORDER = ["OS", "VZ", "DV", "HE"]
FONTS = {
    "OS": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "fallbacks": ["VZ", "DV", "HE"]},
    "VZ": {"file": "Vazirmatn_Regular.woff2", "kind": "FontFile (OS fallback 1)", "fallbacks": []},
    "DV": {"file": "NotoSansDevanagariUI_Regular.woff2", "kind": "FontFile (OS fallback 2)", "fallbacks": []},
    "HE": {"file": "NotoSansHebrew_Regular.woff2", "kind": "FontFile (OS fallback 3)", "fallbacks": []},
}

GREEK = "\u039A\u03B1\u03BB\u03B7\u03BC\u03AD\u03C1\u03B1"  # Καλημέρα
CYRILLIC = "\u041F\u0440\u0438\u0432\u0435\u0442"  # Привет
VIETNAMESE_NFD = "Tie\u0302\u0301ng"  # Tiếng, the ế as e + U+0302 + U+0301 (NFD)
ARABIC = "\u0645\u0631\u062D\u0628\u0627 \u0644\u0627"  # مرحبا لا
PERSIAN = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"  # می‌خواهم, with ZWNJ
HEBREW = "\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD"  # שָׁלוֹם, with niqqud
BIDI = "abc \u05D0\u05D1\u05D2 123"  # abc אבג 123
DEVANAGARI_1 = "\u0915\u094D\u0937\u0924\u094D\u0930\u093F\u092F"  # क्षत्रिय
DEVANAGARI_2 = "\u0915\u093F"  # कि
SNOWMAN = "\u2603"  # ☃: no pinned font maps it

# The font the fallback order picks for each string's non-ASCII codepoints (gate4_i18n.gd's
# COVERAGE; ASCII is OS).
COVERAGE = {GREEK: "OS", CYRILLIC: "OS", VIETNAMESE_NFD: "OS", ARABIC: "VZ", PERSIAN: "VZ", HEBREW: "HE", BIDI: "HE", DEVANAGARI_1: "DV", DEVANAGARI_2: "DV"}
NFD_SEQUENCE = "e\u0302\u0301"  # e + U+0302 + U+0301
NFD_COMPOSED = "\u1EBF"  # ế
ZWNJ = "\u200C"  # ZERO WIDTH NON-JOINER
# Hand segmentation of the Devanagari strings into glyph-identity units (the module docstring):
# KSSA is a conjunct ligature; the i-matra precedes the TRA conjunct in "त्रि".
DEVANAGARI_UNITS = {
    DEVANAGARI_1: ["\u0915\u094D\u0937", "\u0924\u094D\u0930", "\u093F", "\u092F"],
    DEVANAGARI_2: ["\u0915", "\u093F"],
}

CREATION_ORDER = ["P", "LG", "LCy", "LV", "LAr", "LBi", "LX", "LD1", "LD2", "LHe", "LFa", "Marker"]

# Text nodes in tree order: position, font colour, region [x0,y0,x1,y1), background. Every Label
# uses OS at 16 px.
TEXT_NODES = {
    "LG": {"pos": [16, 16], "colour": [1, 1, 1, 1], "region": [8, 8, 200, 56], "background": "dark"},
    "LCy": {"pos": [208, 16], "colour": [1, 0.8, 0.2, 1], "region": [200, 8, 392, 56], "background": "dark"},
    "LV": {"pos": [16, 72], "colour": [0.8, 0.8, 1, 1], "region": [8, 64, 200, 112], "background": "dark"},
    "LAr": {"pos": [208, 72], "colour": [1, 1, 1, 1], "region": [200, 64, 392, 112], "background": "dark"},
    "LBi": {"pos": [16, 128], "colour": [1, 1, 1, 0.6], "region": [8, 120, 200, 168], "background": "dark"},
    "LX": {"pos": [208, 128], "colour": [1, 0.6, 0.6, 1], "region": [200, 120, 392, 168], "background": "dark"},
    "LD1": {"pos": [416, 24], "colour": [0, 0, 0.2, 1], "region": [408, 16, 576, 64], "background": "panel"},
    "LD2": {"pos": [416, 72], "colour": [0.2, 0, 0, 1], "region": [408, 64, 576, 112], "background": "panel"},
    "LHe": {"pos": [416, 120], "colour": [0, 0, 0, 0.6], "region": [408, 112, 576, 160], "background": "panel"},
    "LFa": {"pos": [416, 168], "colour": [0, 0.2, 0, 1], "region": [408, 160, 576, 208], "background": "panel"},
}
TREE_ORDER = list(TEXT_NODES)
INITIAL_TEXT = {"LG": GREEK, "LCy": CYRILLIC, "LV": VIETNAMESE_NFD, "LAr": "", "LBi": "", "LX": "", "LD1": "", "LD2": "", "LHe": "", "LFa": ""}

# The timeline (gate4_i18n.gd `_apply_step`), in its order per step.
# ("text", node, value) | ("colour", node, rgba) | ("move", node, dx)
TIMELINE = {
    1: [("text", "LAr", ARABIC)],
    2: [("text", "LFa", PERSIAN)],
    3: [("text", "LHe", HEBREW)],
    4: [("text", "LBi", BIDI)],
    5: [("text", "LD1", DEVANAGARI_1), ("text", "LD2", DEVANAGARI_2)],
    6: [("colour", "LAr", [0.4, 1, 0.6, 1])],
    7: [("text", "LX", SNOWMAN)],
    8: [("move", "LBi", 8)],
    9: [("text", "LCy", CYRILLIC + " " + GREEK)],
}

# The contract's G4f expectations, typed in, never computed: per step, the uploads per cache
# (create = "c", "c+1" a create and an update in one frame, an update count otherwise).
HAND_TABLE = {
    0: {"OS@16": "c"},
    1: {"VZ@16": "c"},
    2: {"VZ@16": 1},
    3: {"HE@16": "c"},
    4: {"OS@16": 1, "HE@16": 1},
    5: {"DV@16": "c+1"},
    6: {},
    7: {},
    8: {},
    9: {},
}
QUIET_STEPS = [6, 7, 8, 9]
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]

# The ink each string must at least show, in spacing clusters (a lower bound for
# ink-presence: 6 differing pixels each), and the exact glyph counts this model can predict --
# only where every codepoint is one glyph or the composition is known (OS strings, bidi); the
# oracle is the only source for the complex scripts.
INK_MIN = {GREEK: 8, CYRILLIC: 6, VIETNAMESE_NFD: 5, ARABIC: 6, PERSIAN: 7, HEBREW: 4, BIDI: 9, DEVANAGARI_1: 3, DEVANAGARI_2: 1, SNOWMAN: 1, CYRILLIC + " " + GREEK: 14}


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def font_of(text, ch):
    if text == SNOWMAN:
        return None
    if ord(ch) < 0x80:
        return "OS"
    if text in COVERAGE:
        return COVERAGE[text]
    # A concatenation of covered strings (step 9): the codepoint's own string's font.
    for t, f in COVERAGE.items():
        if ch in t:
            return f
    raise AssertionError(f"no coverage for U+{ord(ch):04X}")


def units(text):
    """The text's glyph-identity units with their fonts (module docstring), in logical order."""
    if text in DEVANAGARI_UNITS:
        return [("DV", u) for u in DEVANAGARI_UNITS[text]]
    out = []
    t = text.replace(NFD_SEQUENCE, NFD_COMPOSED)
    for ch in t:
        if ch.isspace() or ch == ZWNJ or text == SNOWMAN:
            continue
        out.append((font_of(text, ch if ch != NFD_COMPOSED else "e"), ch))
    return out


def exact_glyphs(text):
    """Glyph commands, where this model can predict them: OS-only strings (one glyph per unit) and
    the bidi string; None for the complex scripts and the hex box (no texture command)."""
    if text == "":
        return 0
    if text == SNOWMAN:
        return 0
    if all(font_of(text, ch) == "OS" or ch.isspace() for ch in text.replace(NFD_SEQUENCE, "e")) or text == BIDI:
        return len(units(text))
    return None


def hex_rects(cp):
    """draw_hex_code_box's add_rect count for codepoint `cp`: the frame's 4 sides plus each hex
    digit's lit seven-segment bars (servers/text_server.cpp:731-799)."""
    segments = [0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B, 0x77, 0x1F, 0x4E, 0x3D, 0x4F, 0x47]
    digits = 2 if cp <= 0xFF else (4 if cp <= 0xFFFF else 6)
    nibbles = [(cp >> (4 * i)) & 0xF for i in range(digits)]
    return 4 + sum(bin(segments[n]).count("1") for n in nibbles)


def cache_key(font):
    return f"{font}@{SIZE}"


def page_key(cache, index=0):
    return f"{cache}/0#{index}"


# --------------------------------------------------------------------------------------------
# The scene per step
# --------------------------------------------------------------------------------------------


def scene_states():
    state = {n: {"text": INITIAL_TEXT[n], "visible": True, "pos": list(t["pos"]), "colour": list(t["colour"])} for n, t in TEXT_NODES.items()}
    out = []
    for step in range(LAST_STEP + 1):
        changes = TIMELINE.get(step, [])
        draws = []
        for kind, node, value in changes:
            if kind == "text":
                state[node]["text"] = value
            elif kind == "colour":
                state[node]["colour"] = list(value)
            elif kind == "move":
                state[node]["pos"][0] += value
            draws.append(node)
        out.append({"nodes": copy.deepcopy(state), "draws": draws if step > 0 else list(TREE_ORDER), "changes": changes})
    return out


def census(states):
    """Q1c and the model above, draw by draw: per step, per cache the new units, creates,
    updates and hook versions, and per upload the units it carried (for the sabotage)."""
    drawn = {}  # cache -> units rasterized so far
    pages = {}  # page key -> {"created", "dirty", "version", "content": set of units}
    uploads_log = []  # (step, cache, kind, content after the upload)
    steps = []
    for k, st in enumerate(states):
        new_units, creates, updates = {}, {}, {}
        nodes = st["nodes"]

        def shape(node):
            for font, u in units(nodes[node]["text"]):
                cache = cache_key(font)
                have = drawn.setdefault(cache, [])
                if u in have:
                    continue
                have.append(u)
                new_units[cache] = new_units.get(cache, "") + u
                p = pages.setdefault(page_key(cache), {"created": False, "dirty": False, "version": 0, "content": set()})
                p["dirty"] = True
                p["content"].add(u)

        def draw(node):
            for font, _u in units(nodes[node]["text"]):
                cache = cache_key(font)
                p = pages[page_key(cache)]
                if not p["dirty"]:
                    continue
                p["dirty"] = False
                p["version"] += 1
                if p["created"]:
                    updates[cache] = updates.get(cache, 0) + 1
                    kind = "update"
                else:
                    p["created"] = True
                    creates[cache] = creates.get(cache, 0) + 1
                    kind = "create"
                uploads_log.append((k, cache, kind, set(p["content"])))

        if k == 0:
            for node in TREE_ORDER:
                shape(node)
            for node in TREE_ORDER:
                draw(node)
        else:
            for kind, node, _value in st["changes"]:
                if kind == "text":
                    shape(node)
                draw(node)
        steps.append(
            {
                "new_glyphs": new_units,
                "page_creates": creates,
                "page_uploads": updates,
                "hook_versions": {pk: p["version"] for pk, p in pages.items() if p["created"]},
            }
        )
    return steps, uploads_log


def appearance(s):
    if not s["visible"] or not s["text"]:
        return None
    return json.dumps([s["text"], s["colour"], s["pos"]])


# --------------------------------------------------------------------------------------------
# Predictions
# --------------------------------------------------------------------------------------------


def sabotage(states, uploads_log):
    """omit-op texture_2d_update from OMIT_STEP's frame: every page update from then on is dropped
    and creates still travel, so a page's wire content is the content of its last travelled upload.
    A node's region mismatches when it draws a unit its page's wire content lacks. Every dropped
    update's cache fails atlas-hash-parity from its step on."""
    steps, regions, parity = [], {}, {}
    for k in range(OMIT_STEP, LAST_STEP + 1):
        wire = {}
        dropped = set()
        for step, cache, kind, content in uploads_log:
            if step > k:
                break
            if kind == "update" and step >= OMIT_STEP:
                dropped.add(cache)
                continue
            wire[cache] = content
        bad = []
        for n in TREE_ORDER:
            s = states[k]["nodes"][n]
            if not s["visible"]:
                continue
            if any(u not in wire.get(cache_key(font), set()) for font, u in units(s["text"])):
                bad.append(n)
        for cache in sorted(dropped):
            parity.setdefault(cache, []).append(k)
        if bad:
            steps.append(k)
            regions[str(k)] = bad
    return {
        "sabotage-i18n-omit-atlas": {
            "frame": frame_of(OMIT_STEP),
            "op": "texture_2d_update",
            "steps": steps,
            "regions": regions,
            "atlas_hash_parity_fails": parity,
        }
    }


def script_predictions():
    """Q6e's hand predictions, each checked on the oracle and on the capture at every step whose
    node shows the predicted text. Clusters are [start, end) codepoint offsets in the Label's text."""
    nfd_at = VIETNAMESE_NFD.index(NFD_SEQUENCE)
    lam = ARABIC.index("\u0644")
    zwnj = PERSIAN.index(ZWNJ)
    return [
        {"id": "nfd-composition", "node": "LV", "text": VIETNAMESE_NFD, "cluster": [nfd_at, nfd_at + 3], "glyphs": 1, "cmap": "OS:1EBF",
         "claim": "the NFD e + U+0302 + U+0301 shapes to one glyph, OS's glyph for U+1EBF (HarfBuzz composes when the font maps the composition)"},
        {"id": "lam-alef", "node": "LAr", "text": ARABIC, "cluster": [lam, lam + 2], "glyphs": 1, "font": "VZ",
         "claim": "lam + alef is one Vazirmatn ligature glyph"},
        {"id": "zwnj-invisible", "node": "LFa", "text": PERSIAN, "cluster": [zwnj, zwnj + 1], "glyphs": 1, "commands": 0, "advance": 0,
         "claim": "the ZWNJ is one zero-width index-0 glyph that draws nothing"},
        {"id": "niqqud-marks", "node": "LHe", "text": HEBREW, "cluster": [0, 3], "glyphs": 3, "spacing": 1, "font": "HE",
         "claim": "shin + qamats + shin dot is one cluster of three glyphs, only the base advancing (marks positioned over it)"},
        {"id": "devanagari-conjuncts", "node": "LD1", "text": DEVANAGARI_1, "fewer_glyphs_than": len(DEVANAGARI_1), "font": "DV",
         "claim": f"the conjuncts make fewer glyphs than the {len(DEVANAGARI_1)} codepoints"},
        {"id": "i-matra-reorder", "node": "LD2", "text": DEVANAGARI_2, "consonant": "DV:0915", "matra": [1, 2],
         "claim": "the i-matra's quad lies left of its consonant KA's although it follows KA in logical order"},
        {"id": "rtl-run", "node": "LBi", "text": BIDI, "logical": [BIDI.index("\u05D0") + i for i in range(3)], "font": "HE",
         "claim": "the RTL run's letters have quads whose x decreases in logical order"},
        {"id": "hex-box", "node": "LX", "text": SNOWMAN, "codepoint": ord(SNOWMAN), "add_rects": hex_rects(ord(SNOWMAN)), "texture_commands": 0,
         "claim": "U+2603, which no pinned font maps, draws a hex box of add_rects only and no texture command"},
    ]


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------


def inside(r, outer):
    return r[0] >= outer[0] and r[1] >= outer[1] and r[2] <= outer[0] + outer[2] and r[3] <= outer[1] + outer[3]


def build():
    states = scene_states()
    cen, uploads_log = census(states)
    first_step = {}
    for k, st in enumerate(states):
        for n in TREE_ORDER:
            for font, _u in units(st["nodes"][n]["text"]):
                first_step.setdefault(font, k)
    steps = []
    for k, st in enumerate(states):
        nodes = st["nodes"]
        c = cen[k]
        texts = {n: {"text": nodes[n]["text"], "font_key": "OS", "size": SIZE, "colour": nodes[n]["colour"], "visible": nodes[n]["visible"], "position": nodes[n]["pos"]} for n in TREE_ORDER}
        ink_min = {n: (INK_MIN[nodes[n]["text"]] if nodes[n]["text"] else 0) for n in TREE_ORDER}
        glyphs = {n: exact_glyphs(nodes[n]["text"]) for n in TREE_ORDER}
        hexes = {n: hex_rects(ord(nodes[n]["text"])) for n in TREE_ORDER if nodes[n]["text"] == SNOWMAN}
        fresh = {n: (k > 0 and appearance(nodes[n]) != appearance(states[k - 1]["nodes"][n])) for n in TREE_ORDER}
        hook = dict(sorted(c["hook_versions"].items()))
        page_counts = {pk.split("/")[0]: 1 for pk in hook}
        drawn_os = {u for j in range(k + 1) for u in cen[j]["new_glyphs"].get("OS@16", "")}
        steps.append(
            {
                "step": k,
                "applied_frame": frame_of(k),
                "settle_frame": frame_of(k, True),
                "marker_rgba8": MARKER[k],
                "texts": texts,
                "draws": st["draws"],
                "ink_glyphs": ink_min,
                "ink_min_glyphs": ink_min,
                "glyph_commands": glyphs,
                "hex_rects": hexes,
                "new_glyphs": dict(sorted(c["new_glyphs"].items())),
                "page_uploads": dict(sorted(c["page_uploads"].items())),
                "page_creates": dict(sorted(c["page_creates"].items())),
                "subpixel_bounded": [],
                "frees": [],
                "hook_versions": hook,
                "wire_versions": hook,
                # Distinct glyphs drawn per cache: predicted for OS only (one glyph per unit); the
                # complex fallbacks' counts come from the oracle.
                "page_glyphs": {"OS@16": len(drawn_os)},
                "page_counts": dict(sorted(page_counts.items())),
                "text_regions": {n: TEXT_NODES[n]["region"] for n in TREE_ORDER},
                "background": {n: BACKGROUNDS[TEXT_NODES[n]["background"]] for n in TREE_ORDER},
                "clip_rects": {},
                "fresh": fresh,
            }
        )

    # The contract's hand table equals the derivation.
    for k, row in HAND_TABLE.items():
        s = steps[k]
        got = {}
        for cache in sorted(set(s["page_creates"]) | set(s["page_uploads"])):
            cr, up = s["page_creates"].get(cache, 0), s["page_uploads"].get(cache, 0)
            got[cache] = (f"c+{up}" if up else "c") if cr else up
        assert got == row, f"step {k}: derived {got} != hand {row}"
    for k in QUIET_STEPS:
        assert not steps[k]["page_uploads"] and not steps[k]["page_creates"], k
    # Each fallback's script first appears at its own step (fallback-pages), after OS's.
    assert first_step == {"OS": 0, "VZ": 1, "HE": 3, "DV": 5}, first_step
    assert hex_rects(ord(SNOWMAN)) == 26

    # Layout sanity: text regions disjoint, each inside one background, none touching the marker.
    regions = {n: TEXT_NODES[n]["region"] for n in TREE_ORDER}
    names = list(regions)
    for i, a in enumerate(names):
        ra = regions[a]
        for b in names[i + 1 :]:
            rb = regions[b]
            assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1], (a, b)
        in_panel = inside([ra[0], ra[1], ra[2] - ra[0], ra[3] - ra[1]], PANEL["rect"])
        assert in_panel == (TEXT_NODES[a]["background"] == "panel"), a
        if not in_panel:
            x0, y0, w, h = PANEL["rect"]
            assert ra[2] <= x0 or ra[0] >= x0 + w or ra[3] <= y0 or ra[1] >= y0 + h, a
        m = MARKER_REGION
        assert ra[2] <= m[0] or ra[0] >= m[0] + m[2] or ra[3] <= m[1] or ra[1] >= m[1] + m[3], a

    caches = {cache_key(f): {"format": "LA8", "width": 256, "height": 256, "mipmaps": False, "data_bytes": 256 * 256 * 2, "outline": 0, "subpixel": False} for f in FALLBACK_ORDER}
    return {
        "schema": "render-stream-gate4-expected/1",
        "fixture": "gate4-i18n",
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
        "fonts": {k: {**v, "sizes": [SIZE]} for k, v in FONTS.items()},
        "fallback_order": FALLBACK_ORDER,
        "fallback_first_steps": dict(sorted(first_step.items(), key=lambda kv: FALLBACK_ORDER.index(kv[0]))),
        # The census model's inputs, for check-gate4's independent re-derivation: the script font
        # per string (ASCII is OS), the hand-segmented strings, the NFD composition, the
        # zero-width codepoints and the strings no font maps.
        "units_model": {
            "coverage": COVERAGE,
            "unit_overrides": DEVANAGARI_UNITS,
            "nfd": {"sequence": NFD_SEQUENCE, "composed": NFD_COMPOSED},
            "zero_width": [ZWNJ],
            "unmapped": [SNOWMAN],
        },
        "cache_keys": sorted(caches),
        "caches": caches,
        "subpixel_caches": [],
        "page": {"format": "LA8", "width": 256, "height": 256, "mipmaps": False, "data_bytes": 256 * 256 * 2, "empty_texel": [255, 0]},
        "panel": {"rect": PANEL["rect"], "rgba8": rgba8(PANEL["colour"])},
        "marker_rect": MARKER_RECT,
        "regions": {"marker": MARKER_REGION, "panel": PANEL["rect"]},
        "backgrounds": BACKGROUNDS,
        "engine_textures": ENGINE_TEXTURES,
        "quiet_steps": QUIET_STEPS,
        "hook_versions_total": dict(sorted(cen[-1]["hook_versions"].items())),
        "hand_table": {str(k): {"uploads": row} for k, row in HAND_TABLE.items()},
        "script_predictions": script_predictions(),
        "steps": steps,
        "predictions": sabotage(states, uploads_log),
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
