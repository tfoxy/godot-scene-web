#!/usr/bin/env python3
"""Write fixtures/gate4-rich/expected.json (render-stream-gate4-expected/1).

Every number below is derived from the fixture's own BBCode fragments and the engine's text rules
as read from the source (protocol/gate4-design.md Q1, Q6c, "G4d"), written down as code over the
fixture's own parameters. Nothing here runs or reads the engine: the glyph oracle
(fixtures/gate4-rich/glyph_oracle.gd) and the capture have to agree with it (`rich-oracle-agrees`,
`atlas-census`), and a disagreement is a finding to explain from the source, never a number to
copy.

    python3 experiments/render-stream/fixtures/gate4-rich/make_expected.py           # write
    python3 experiments/render-stream/fixtures/gate4-rich/make_expected.py --check   # diff only

The model:

- `RTL` (a RichTextLabel, `bbcode_enabled`/`fit_content`/`scroll_active=false`) replaces its whole
  text at steps 0-4 (`_set_text_through`) and appends a new paragraph at step 5 (`append_text`).
  Either way the *entire* control re-validates its line caches every step (`_process_line_caches`),
  which re-shapes every span, including ones whose text did not change -- but rasterize-then-upload
  (gate4-design.md Q1c) means a glyph already in its cache is never rasterized or uploaded again.
  So, exactly as for Label, a cache's new-glyph set each step is only the codepoints across that
  step's *active* spans that were never rasterized into that cache before, regardless of whether
  the span carrying them is itself new that step.
- Each span shapes into the cache `(font_key, size)` of the Font resource and size gate4-rich.gd
  gives it (`F`, `FB` -- a FontVariation with `variation_embolden 1.2`, its own TextServer RID and
  so its own cache -- or `FI` -- `variation_transform` skewed 0.2, likewise its own cache). A span
  with `outline > 0` additionally shapes into the *outline* cache `(size, outline)` on the same
  RID as its fill cache (ts_adv.h:417-425); this file and the oracle both relabel that as the
  cache key `font_key + "O"` (e.g. "FO") so it never collides with the fill cache under
  `font_key@size` grouping (gate4-rich/glyph_oracle.gd's header; gate4-checks.ts `cacheKeyOf`).
- Ink glyphs are the plain character count of the active spans' text (every word here is a single
  BBCode run with no spaces, Latin, no ligating pairs): the outline pass adds pixels around the
  same characters, not additional ink glyphs.
- `RTL`'s clip rect is its fixed `position`/`size` rectangle for every step: `fit_content` only
  grows a free Control's actual size up to its minimum size when the minimum exceeds the
  offset-derived size (scene/gui/control.cpp:1742-1786), and the chosen size (400x190) is generous
  enough that the content's natural height never needs to grow it (checked against the rendered
  reference, not assumed).
- Outside RTL's region and the marker, every pixel is the clear colour (D8).
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
LAST_STEP = 5
QUIT = S + N * LAST_STEP + SETTLE + 4
VIEWPORT = (640, 360)
CLEAR = [51, 51, 102, 255]
EARLY_SHOT_STEPS: list[int] = []

MARKER = [
    [0, 0, 0, 255],
    [255, 255, 0, 255],
    [0, 255, 255, 255],
    [102, 0, 102, 255],
    [0, 102, 0, 255],
    [102, 0, 0, 255],
]
MARKER_RECT = [592, 16, 32, 32]
MARKER_REGION = [584, 8, 632, 56]

RTL_RECT = [24, 32, 400, 190]
RTL_REGION = [RTL_RECT[0], RTL_RECT[1], RTL_RECT[0] + RTL_RECT[2], RTL_RECT[1] + RTL_RECT[3]]

# RichTextLabel's constructor always adds an internal VScrollBar child (scene/gui/
# rich_text_label.cpp:8064-8068), its own CanvasItem created right after RTL's own and before
# Marker's -- present regardless of `scroll_active`, invisible and drawing nothing here (measured
# against the rendered reference: "As built (G4d)" in ../../protocol/gate4-design.md).
CREATION_ORDER = ["RTL", "RTL_VScrollBar", "Marker"]

# gate4-rich.gd `_spans_upto`: (key, font_key, size, text, colour, bgcolor, outline), cumulative
# per step. colour/bgcolor are floats; bgcolor None means no [bgcolor] span.
WHITE = [1, 1, 1, 1]
SPANS_BY_STEP = {
    0: [
        ("color", "F", 16, "Amber", [1, 1, 0, 1], None, 0),
        ("plain", "F", 16, "plain", WHITE, None, 0),
        ("font_size", "F", 24, "Big", WHITE, None, 0),
    ],
    1: [("bold", "FB", 16, "Bold", WHITE, None, 0)],
    2: [("italic", "FI", 16, "Italic", WHITE, None, 0)],
    3: [("bgcolor", "F", 16, "Marked", WHITE, [0, 1, 1, 1], 0)],
    4: [("outline", "F", 16, "Outlined", WHITE, None, 2)],
    5: [("append", "F", 16, "More", [1, 0, 1, 1], None, 0)],
}


def spans_upto(step):
    out = []
    for k in range(step + 1):
        out.extend(SPANS_BY_STEP.get(k, []))
    return out


def cache_key(span):
    _key, font_key, size, _text, _colour, _bgcolor, _outline = span
    return f"{font_key}@{size}"


def outline_cache_key(span):
    _key, font_key, size, _text, _colour, _bgcolor, outline = span
    return f"{font_key}O@{size}" if outline > 0 else None


# The one texture the engine makes itself (memory rs-g2a-texture-census-facts).
ENGINE_TEXTURES = [{"frame": 1, "op": "texture_2d_create", "format": "RGBA8", "width": 800, "height": 6}]


def frame_of(step, settle=False):
    applied = 1 if step == 0 else S + N * step
    return S + N * step + SETTLE if settle else applied


def rgba8(c):
    return [round(v * 255) for v in c]


# --------------------------------------------------------------------------------------------
# Census: Q1c over the cumulative spans, independent of the engine.
# --------------------------------------------------------------------------------------------


def census():
    """Per step: new codepoints, uploads, creates and hook versions per cache key (fill caches
    `font_key@size` and, for an outlined span, the outline cache `font_keyO@size` too).

    As built (G4d), measured against the rendered reference and confirmed from source: a *fill*
    cache's new glyphs across every span active that step are rasterized together during RTL's
    one shaping pass (gate4-design.md Q1c: "shaping rasterizes every glyph the text needs"), so
    they are ONE hook-level event (one `texture_2d_create`/`_update`) no matter how many spans or
    distinct fresh codepoints contributed -- RichTextLabel is one CanvasItem with one redraw, not
    one Label per span. An *outline* cache does not: `_font_draw_glyph_outline`
    (`modules/text_server_adv/text_server_adv.cpp:4068-4136`) calls `_ensure_glyph` and checks its
    own texture's `dirty` flag itself, inline in the per-glyph draw loop, with no shaping-time
    pre-rasterization pass of its own. So each newly-rasterized outline glyph dirties the page and
    is immediately followed by its own upload before the next glyph's rasterization -- one
    hook-level event *per new outline glyph*, not one for the whole span (measured: 8 events, 1
    create + 7 updates, for the 8-glyph "Outlined" span's first use).
    """
    rasterized: dict[str, list[str]] = {}
    created: set[str] = set()
    version: dict[str, int] = {}
    steps = []
    for step in range(LAST_STEP + 1):
        new_glyphs: dict[str, list[str]] = {}
        uploads: dict[str, int] = {}
        creates: dict[str, int] = {}

        def bump(key, fresh_count):
            """fresh_count hook-level events on `key`, each one version higher."""
            for _ in range(fresh_count):
                version[key] = version.get(key, 0) + 1
                if key in created:
                    uploads[key] = uploads.get(key, 0) + 1
                else:
                    created.add(key)
                    creates[key] = 1

        # Fill caches: aggregate every active span's fresh codepoints first (one shaping pass),
        # then one event for the whole batch.
        fresh_by_cache: dict[str, list[str]] = {}
        for span in spans_upto(step):
            key = cache_key(span)
            have = rasterized.setdefault(key, [])
            fresh = fresh_by_cache.setdefault(key, [])
            for c in span[3]:
                if c not in have and c not in fresh:
                    fresh.append(c)
        for key, fresh in fresh_by_cache.items():
            if not fresh:
                continue
            rasterized[key].extend(fresh)
            new_glyphs.setdefault(key, []).extend(fresh)
            bump(key, 1)

        # Outline caches: one event per newly-rasterized glyph (draw-time, not shaping-time).
        for span in spans_upto(step):
            ol_key = outline_cache_key(span)
            if ol_key is None:
                continue
            have = rasterized.setdefault(ol_key, [])
            fresh = [c for c in span[3] if c not in have and c not in new_glyphs.get(ol_key, [])]
            if not fresh:
                continue
            rasterized[ol_key].extend(fresh)
            new_glyphs.setdefault(ol_key, []).extend(fresh)
            bump(ol_key, len(fresh))

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


def cache_keys():
    keys = set()
    for span in spans_upto(LAST_STEP):
        keys.add(cache_key(span))
        ol = outline_cache_key(span)
        if ol is not None:
            keys.add(ol)
    return sorted(keys)


# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------


def build():
    cen = census()
    steps = []
    for k in range(LAST_STEP + 1):
        spans = spans_upto(k)
        c = cen[k]
        ink_glyphs = sum(len(s[3]) for s in spans)
        span_records = [
            {
                "key": s[0],
                "font_key": s[1],
                "size": s[2],
                "text": s[3],
                "colour": s[4],
                "bgcolor": s[5],
                "outline": s[6],
            }
            for s in spans
        ]
        texts = {
            "RTL": {
                "text": "+".join(s[0] for s in spans),
                "font_key": "F",
                "size": 16,
                "colour": WHITE,
                "visible": True,
                "position": [RTL_RECT[0], RTL_RECT[1]],
            }
        }
        steps.append(
            {
                "step": k,
                "applied_frame": frame_of(k),
                "settle_frame": frame_of(k, True),
                "marker_rgba8": MARKER[k],
                "texts": texts,
                "draws": ["RTL"],
                "spans": span_records,
                "ink_glyphs": {"RTL": ink_glyphs},
                "new_glyphs": {key: "".join(v) for key, v in sorted(c["new_glyphs"].items())},
                "page_uploads": dict(sorted(c["page_uploads"].items())),
                "page_creates": dict(sorted(c["page_creates"].items())),
                "hook_versions": dict(sorted(c["hook_versions"].items())),
                "wire_versions": dict(sorted(c["hook_versions"].items())),
                "page_glyphs": dict(sorted(c["page_glyphs"].items())),
                "page_counts": {key: 1 for key in sorted(c["hook_versions"])},
                "text_regions": {"RTL": RTL_REGION},
                "background": {"RTL": CLEAR},
                "fresh": {"RTL": k > 0},
                "clip_rects": {"RTL": RTL_REGION},
            }
        )

    # Underline variant prediction (every step mismatches, confined to RTL's region): the
    # "Amber" span is wrapped in [u]...[/u] from step 0, so the stroke is present at every step.
    underline_steps = list(range(LAST_STEP + 1))

    hook_versions_total = {key: cen[-1]["hook_versions"].get(key, 0) for key in cache_keys()}
    return {
        "schema": "render-stream-gate4-expected/1",
        "fixture": "gate4-rich",
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
        "text_nodes": ["RTL"],
        "fonts": {
            "F": {"file": "OpenSans_SemiBold.woff2", "kind": "FontFile", "sizes": [16, 24]},
            "FB": {"file": "OpenSans_SemiBold.woff2", "kind": "FontVariation embolden 1.2", "sizes": [16]},
            "FI": {"file": "OpenSans_SemiBold.woff2", "kind": "FontVariation transform skew 0.2", "sizes": [16]},
        },
        "cache_keys": cache_keys(),
        "page": {"format": "LA8", "width": 256, "height": 256, "mipmaps": False, "data_bytes": 256 * 256 * 2, "empty_texel": [255, 0]},
        "panel": {"rect": [0, 0, 0, 0], "rgba8": [0, 0, 0, 0]},
        "marker_rect": MARKER_RECT,
        "regions": {"marker": MARKER_REGION},
        "backgrounds": {"dark": CLEAR},
        "engine_textures": ENGINE_TEXTURES,
        "quiet_steps": [],
        "hook_versions_total": hook_versions_total,
        "hand_table": {},
        "steps": steps,
        "predictions": {
            "underline": {"frame": frame_of(0), "steps": underline_steps},
        },
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
