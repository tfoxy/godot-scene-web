import { asNumber, type GodotVariant } from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import {
  colorCss,
  cssUrl,
  escapeAttribute,
  escapeHtml,
  round,
  safeClassSegment,
  styleAttribute,
} from "./css-values";
import { createStringLru } from "./lru";
import {
  registerFontFace,
  resolveFont,
  sourceNodeForLayout,
} from "./resources";
import { textScaleLength } from "./text-scale";
import type {
  GodotHtmlFontFace,
  GodotHtmlRenderOptions,
  GodotResolvedResource,
} from "./types";

const DEFAULT_TEXT_COLOR = "rgba(255, 255, 255, 1)";

export function assignTextStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  node: GodotSceneTreeNode,
  props: Record<string, GodotVariant>,
  options: GodotHtmlRenderOptions,
  fontFaces: GodotHtmlFontFace[],
  // When true, every text size/decoration tracks `var(--godot-text-scale, 1)`.
  scaleText: boolean,
): void {
  const len = (px: number): string => textScaleLength(px, scaleText);
  const source = sourceNodeForLayout(node);
  style["align-items"] = textAlignItems(node.textVerticalAlign);
  style["justify-content"] = textJustify(node.textAlign);
  style["text-align"] = node.textAlign === "fill" ? "justify" : node.textAlign;
  // Honor Godot's `autowrap_mode`: AUTOWRAP_OFF (0) text never reflows, so it must
  // not inherit the base `white-space: pre-wrap`. Without this, a non-wrapping label
  // in a point-anchored container (whose CSS width is `min-content`) collapses to its
  // longest word and wraps — the bottom prompt of the deck-card-selection dialog
  // ("Elige 2 cartas para quitar."). `pre` keeps explicit newlines, only dropping the
  // auto-wrap. Defaults match Godot: Label OFF (0), RichTextLabel WORD_SMART (3).
  const autowrapMode = asNumber(
    firstGodotValue(
      props.autowrap_mode,
      options.resolveTheme?.(source, "autowrap_mode"),
    ),
  );
  const wraps =
    node.type === "RichTextLabel"
      ? (autowrapMode ?? 3) !== 0
      : (autowrapMode ?? 0) !== 0;
  if (!wraps) style["white-space"] = "pre";
  const color =
    colorCss(
      firstGodotValue(
        props["theme_override_colors/font_color"],
        props["theme_override_colors/default_color"],
        options.resolveTheme?.(source, "font_color"),
        options.resolveTheme?.(source, "default_color"),
      ),
    ) ?? DEFAULT_TEXT_COLOR;
  style.color = color;
  const normalFont = resolveFont(
    firstGodotValue(
      props["theme_override_fonts/font"],
      props["theme_override_fonts/normal_font"],
      options.resolveTheme?.(source, "font"),
      options.resolveTheme?.(source, "normal_font"),
    ),
    node,
    options,
  );
  const hasExplicitFontFile =
    node.type === "RichTextLabel" && Boolean(normalFont?.fontUrl);
  const fontSize = asNumber(
    firstGodotValue(
      props["theme_override_font_sizes/font_size"],
      props["theme_override_font_sizes/normal_font_size"],
      options.resolveTheme?.(source, "font_size"),
      options.resolveTheme?.(source, "normal_font_size"),
    ),
  );
  const shouldScaleRichTextSize =
    node.type === "RichTextLabel" && !hasExplicitFontFile;
  if (node.type === "RichTextLabel") {
    attributes["data-godot-rich-text-scale-font-size"] = String(
      shouldScaleRichTextSize,
    );
  }
  const renderedFontSize = renderRichTextFontSize(
    fontSize,
    shouldScaleRichTextSize,
  );
  if (renderedFontSize !== undefined && node.type !== "RichTextLabel") {
    style["font-size"] = len(renderedFontSize);
  }
  const lineSeparation = asNumber(
    firstGodotValue(
      props["theme_override_constants/line_separation"],
      options.resolveTheme?.(source, "line_separation"),
    ),
  );
  if (lineSeparation !== undefined && renderedFontSize !== undefined) {
    style["line-height"] = len(Math.max(1, renderedFontSize + lineSeparation));
  }
  if (lineSeparation !== undefined) {
    // Surfaced for auto-fit, which recomputes line-height from the fitted size.
    attributes["data-godot-line-separation-px"] = String(lineSeparation);
  }
  const outlineColor =
    colorCss(
      firstGodotValue(
        props["theme_override_colors/font_outline_color"],
        options.resolveTheme?.(source, "font_outline_color"),
      ),
    ) ?? "rgba(0, 0, 0, 1)";
  const outlineSize =
    asNumber(
      firstGodotValue(
        props["theme_override_constants/outline_size"],
        options.resolveTheme?.(source, "outline_size"),
      ),
    ) ?? 0;
  const shadowColor =
    colorCss(
      firstGodotValue(
        props["theme_override_colors/font_shadow_color"],
        options.resolveTheme?.(source, "font_shadow_color"),
      ),
    ) ?? "rgba(0, 0, 0, 0)";
  const shadowX =
    asNumber(
      firstGodotValue(
        props["theme_override_constants/shadow_offset_x"],
        options.resolveTheme?.(source, "shadow_offset_x"),
      ),
    ) ?? 0;
  const shadowY =
    asNumber(
      firstGodotValue(
        props["theme_override_constants/shadow_offset_y"],
        options.resolveTheme?.(source, "shadow_offset_y"),
      ),
    ) ?? 0;
  const shadowOutlineSize =
    asNumber(
      firstGodotValue(
        props["theme_override_constants/shadow_outline_size"],
        options.resolveTheme?.(source, "shadow_outline_size"),
      ),
    ) ?? 1;
  const cssOutlineSize = cssOutlineSizeForFont(outlineSize, normalFont);
  const cssShadowOutlineSize = cssOutlineSizeForFont(
    shadowOutlineSize,
    normalFont,
  );
  if (node.type === "RichTextLabel") {
    style["--godot-rich-text-color"] = color ?? "currentColor";
    style["--godot-rich-outline-color"] = outlineColor;
    style["--godot-rich-outline-size"] = len(cssOutlineSize);
    style["--godot-rich-shadow-color"] = shadowColor;
    style["--godot-rich-shadow-x"] = len(round(shadowX));
    style["--godot-rich-shadow-y"] = len(round(shadowY));
    style["--godot-rich-shadow-outline-size"] = len(cssShadowOutlineSize);
    // Each rich-text role size: an inline `theme_override_font_sizes/*` wins; otherwise
    // fall back to the node's theme (resolveTheme), so a RichTextLabel sized only by its
    // theme's `default_font_size` no longer collapses to the 1em CSS fallback. The normal
    // role also accepts the generic `font_size` item the theme default lives under.
    assignRichTextFontSize(
      style,
      "--godot-rich-normal-font-size",
      firstGodotValue(
        props["theme_override_font_sizes/normal_font_size"],
        options.resolveTheme?.(source, "normal_font_size"),
        options.resolveTheme?.(source, "font_size"),
      ),
      shouldScaleRichTextSize,
      scaleText,
    );
    assignRichTextFontSize(
      style,
      "--godot-rich-bold-font-size",
      firstGodotValue(
        props["theme_override_font_sizes/bold_font_size"],
        options.resolveTheme?.(source, "bold_font_size"),
      ),
      shouldScaleRichTextSize,
      scaleText,
    );
    assignRichTextFontSize(
      style,
      "--godot-rich-italic-font-size",
      firstGodotValue(
        props["theme_override_font_sizes/italics_font_size"],
        options.resolveTheme?.(source, "italics_font_size"),
      ),
      shouldScaleRichTextSize,
      scaleText,
    );
    assignRichTextFontSize(
      style,
      "--godot-rich-bold-italic-font-size",
      firstGodotValue(
        props["theme_override_font_sizes/bold_italics_font_size"],
        options.resolveTheme?.(source, "bold_italics_font_size"),
      ),
      shouldScaleRichTextSize,
      scaleText,
    );
  } else {
    if (outlineSize > 0) {
      style["-webkit-text-stroke"] = `${len(cssOutlineSize)} ${outlineColor}`;
      style["paint-order"] = "stroke fill";
    }
    if (
      shadowColor !== "rgba(0, 0, 0, 0)" &&
      (shadowX !== 0 || shadowY !== 0)
    ) {
      style["text-shadow"] = `${len(shadowX)} ${len(shadowY)} 0 ${shadowColor}`;
    }
  }
  if (normalFont) {
    registerFontFace(fontFaces, normalFont);
    const font = normalFont;
    if (font.fontFamily) {
      style["font-family"] = font.fontFamily;
      attributes["data-godot-font-family"] = font.fontFamily;
    }
    if (font.path) {
      attributes["data-godot-font-path"] = font.path;
    }
    if (font.glyphSpacing !== undefined) {
      style["--godot-rich-letter-spacing"] = len(
        round(font.glyphSpacing * 0.75),
      );
    } else if (hasExplicitFontFile) {
      style["--godot-rich-letter-spacing"] = len(0);
    }
  }
  // Godot's embedded default DynamicFont has no glyph spacing. The historical
  // browser fallback needed 0.25px tracking, but retaining it after selecting
  // the exact Open Sans bytes widens implicit Labels (for example
  // SpriteFrames) beyond Godot's measured advance. Explicit faces continue to
  // use their own spacing path above.
  if (node.type === "Label" && !normalFont) {
    style["--godot-label-letter-spacing"] = len(0);
  }
  if (node.type === "RichTextLabel") {
    // Each rich-text role (bold/italics/bold-italics) can override the font with
    // its own FontVariation. Register the resolved face and expose its family as
    // a CSS var so `.godot-rich-bold`/`-italic` use it instead of inheriting the
    // normal font. Gate on a usable face (family + url); otherwise the run falls
    // back via `inherit` to the normal font, matching prior behavior.
    for (const [role, cssVar] of [
      ["bold_font", "--godot-rich-bold-font-family"],
      ["italics_font", "--godot-rich-italic-font-family"],
      ["bold_italics_font", "--godot-rich-bold-italic-font-family"],
    ] as const) {
      const roleFont = resolveFont(
        firstGodotValue(
          props[`theme_override_fonts/${role}`],
          options.resolveTheme?.(source, role),
        ),
        node,
        options,
      );
      registerFontFace(fontFaces, roleFont);
      if (roleFont?.fontFamily && roleFont.fontUrl) {
        style[cssVar] = roleFont.fontFamily;
      }
      if (role === "bold_font" && !roleFont?.fontUrl) {
        // Godot's default theme owns a separate synthetic bold FontVariation
        // (`variation_embolden = 1.2`), rather than inheriting a normal-role
        // FontVariation's glyph spacing. TextServerAdvanced adds
        // `embolden * (font_size * 64) / 4096` to each glyph advance (0.3px at
        // the 16px default); CSS synthetic weight only expands ink, not Range
        // advances. The 0.5px browser advance emulation includes the measured
        // cross-shaper/hinting rounding gap after that source-derived 0.3px.
        // Conversely, a normal role that supplied `spacing_glyph` must not leak
        // that spacing into this separate bold role. Explicit FontFile and
        // FontVariation bold faces remain untouched.
        style["--godot-rich-bold-letter-spacing"] = len(
          normalFont?.glyphSpacing === undefined ? 0.5 : 0,
        );
      }
    }
  }
}

function firstGodotValue(
  ...values: Array<GodotVariant | undefined>
): GodotVariant | undefined {
  return values.find((value) => value !== undefined);
}

function assignRichTextFontSize(
  style: Record<string, string>,
  property: string,
  value: GodotVariant | undefined,
  shouldScale: boolean,
  scaleText: boolean,
): void {
  const fontSize = renderRichTextFontSize(asNumber(value), shouldScale);
  if (fontSize !== undefined) {
    style[property] = textScaleLength(fontSize, scaleText);
  }
}

export function renderRichTextFontSize(
  fontSize: number | undefined,
  shouldScale: boolean,
): number | undefined {
  if (fontSize === undefined) {
    return undefined;
  }
  return shouldScale ? round(fontSize * 0.8) : fontSize;
}

// `outline_size` is a Godot theme constant, not a CSS stroke width, and the two halves of this
// ternary convert it under two different engine mechanisms.
//
// NON-MSDF — the `* 0.5`, and it is exact. Godot strokes the glyph with FreeType's stroker at a
// RADIUS of `outline_size / 4` (`FT_Stroker_Set(stroker, outline_size * 16, …)`, whose argument is
// 26.6 fixed point, so `16 / 64` px), which reaches `outline_size / 4` px OUTSIDE the silhouette
// and does not move with `font_size`. `-webkit-text-stroke` is CENTRED on the glyph's contour, so a
// width `W` reaches `W / 2` outward: `W = outline_size * 0.5` lands the browser's outer edge on
// Godot's. `round` here is `css-values.ts`'s 3-decimal quantizer, NOT an integer snap — an odd
// `outline_size` keeps its half pixel, and `outline_size` 3 emits `1.5px`. See
// `docs/text-rendering.md` ("What `-webkit-text-stroke` has to be…") for the reach measured in a
// browser against that arithmetic.
//
// MSDF — the passthrough, and it rests on an ASSUMPTION NOTHING HERE CHECKS. An MSDF face is
// rasterised once at `msdf_size` and its outline is a threshold shift in the canvas shader
// (`cr = outline_size / msdf_pixel_range`), which moves the contour `outline_size` px outward in
// SOURCE-SIZE units and is then scaled to the screen by `font_size / msdf_size`. So Godot reaches
// `outline_size * font_size / msdf_size` while this branch's `W = outline_size` reaches
// `outline_size / 2` — equal only when `font_size == msdf_size / 2`.
//
// That equality is PER LABEL, and UNVERIFIED IN ANY REAL CONSUMER — there is no pixel-parity
// coverage of this branch anywhere. sts2 imports its faces at `msdf_size = 48`, so it would need
// `font_size` 24 exactly; a census of its own recordings finds outlined labels at 15 through 96,
// with 24 real but a minority — 1565 of 10 046 samples, against 2208 at 26 and 1716 at 96. So the
// branch would be right for about one outlined label in six and wrong for the rest, if it ran at
// all. It does not: that consumer's live path never sets `fontMsdf` (the flag is absent from the
// scene-state wire protocol), so what ships there is the non-MSDF arm above. Treat this one as
// unexercised rather than confirmed, and measure before trusting it.
function cssOutlineSizeForFont(
  outlineSize: number,
  font: GodotResolvedResource | undefined,
): number {
  return font?.fontMsdf === true ? outlineSize : round(outlineSize * 0.5);
}

function textJustify(value: GodotSceneTreeNode["textAlign"]): string {
  switch (value) {
    case "center":
      return "center";
    case "right":
      return "flex-end";
    default:
      return "flex-start";
  }
}

function textAlignItems(
  value: GodotSceneTreeNode["textVerticalAlign"],
): string {
  switch (value) {
    case "center":
      return "center";
    case "bottom":
      return "flex-end";
    default:
      return "flex-start";
  }
}

export function textProp(value: GodotVariant | undefined): string | null {
  return typeof value === "string" ? value : null;
}

interface RichTextEffect {
  name: string;
  perChar: boolean;
  perWord: boolean;
  className?: string;
}

interface RichTextTag {
  type:
    | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "code"
    | "align"
    | "indent"
    | "color"
    | "bgcolor"
    | "url"
    | "font_size"
    | "style"
    | "effect"
    | "structural";
  // Identity used to match an opening tag with its closing tag (the bbcode name).
  id: string;
  value?: string;
  css?: Record<string, string>;
  effect?: RichTextEffect;
}

/** Public tag kinds produced by Godot's built-in BBCode grammar. */
export type GodotBbcodeTagKind = RichTextTag["type"] | "image" | "void";

// Official Godot effect tags with the visible animation we model. `perChar`
// nodes are split into word/char spans so external CSS can stagger them.
export const GODOT_BBCODE_BUILT_IN_EFFECTS: Readonly<
  Record<string, Readonly<{ perChar: boolean; perWord: boolean }>>
> = Object.freeze({
  rainbow: Object.freeze({ perChar: true, perWord: false }),
  wave: Object.freeze({ perChar: true, perWord: false }),
  shake: Object.freeze({ perChar: true, perWord: false }),
  tornado: Object.freeze({ perChar: true, perWord: false }),
  pulse: Object.freeze({ perChar: false, perWord: false }),
  fade: Object.freeze({ perChar: true, perWord: false }),
});

const SIMPLE_RICH_TEXT_TAGS: Record<string, RichTextTag["type"]> = {
  b: "bold",
  i: "italic",
  u: "underline",
  s: "strike",
  code: "code",
  indent: "indent",
};

// Inline image (`[img]`) options parsed from the tag. The path is the tag's
// content, read separately by the main loop.
interface RichTextImgOptions {
  width?: number;
  height?: number;
  valign?: "top" | "middle" | "bottom";
  region?: { x: number; y: number; width: number; height: number };
  alt?: string;
}

type ParsedRichTextTag =
  | { close: boolean; void: true; html: string }
  | { close: boolean; img: true; options?: RichTextImgOptions }
  | ({ close: boolean; void?: false; img?: false } & RichTextTag);

// Context threaded through the rich-text renderer. `resolveImage` is a closure
// built in model.ts so this module stays free of node/resolveResource plumbing.
export interface RichTextRenderContext {
  customTags?: GodotHtmlRenderOptions["bbcodeTags"];
  resolveImage?: (path: string) => GodotResolvedResource | undefined;
  // When true, `[font_size]` runs track `var(--godot-text-scale, 1)`.
  textScale?: boolean;
}

function richTextHtml(value: string, ctx: RichTextRenderContext = {}): string {
  const out: string[] = [];
  const styleStack: RichTextTag[] = [];
  const charCounter = { value: 0 };
  let buffer = "";
  // Godot applies `[center]/[left]/[right]/[fill]` (and `[p align=…]`) per
  // PARAGRAPH: a contiguous aligned region is one `<p>` block whose `text-align`
  // centers each visual line. Inside that region a hard newline (`\n`/`\r\n`)
  // also starts a NEW paragraph in Godot (see RichTextLabel docs) — so the runs
  // between newlines become separate `.godot-rich-paragraph` BLOCKS: each block's
  // WRAPPED lines share `--godot-rich-line-height` while the gap BETWEEN blocks is
  // `--godot-rich-paragraph-spacing` (both default to `normal`/`0`, so a region
  // with no consumer overrides renders identically to the old single-line-height
  // flow). We collect the runs of the active alignment as one segment per newline
  // and emit the `<p>` (with its blocks) when the alignment changes or clears.
  // `null` = no active alignment, so runs emit inline at the top level —
  // byte-identical to the common no-`[center]` label (top-level `\n` stays inline
  // via `white-space: pre-wrap`, untouched).
  let para: { align: string; segments: string[][] } | null = null;
  const closeParagraph = (): void => {
    if (!para) {
      return;
    }
    out.push(renderAlignParagraph(para.align, para.segments));
    para = null;
  };
  // Route one finished fragment (text run, void tag, or image) into the open
  // alignment paragraph's CURRENT segment, or straight to the top level when no
  // alignment is active. The style stack is popped only AFTER a run's content is
  // flushed, so the alignment seen here is the one the fragment was styled with.
  const pushHtml = (html: string): void => {
    const align = lastRichTextTag(styleStack, "align")?.value;
    if (align === undefined) {
      closeParagraph();
      out.push(html);
      return;
    }
    if (para && para.align !== align) {
      closeParagraph();
    }
    if (!para) {
      para = { align, segments: [[]] };
    }
    para.segments[para.segments.length - 1]!.push(html);
  };
  // A hard newline inside an aligned region: end the current paragraph block and
  // start a fresh one. Ensures the para exists (a `\n` before any run opens an
  // empty leading block, matching a leading Godot newline).
  const breakSegment = (align: string): void => {
    if (para && para.align !== align) {
      closeParagraph();
    }
    if (!para) {
      para = { align, segments: [[]] };
    }
    para.segments.push([]);
  };
  const flushBuffer = (): void => {
    if (!buffer) {
      return;
    }
    const runs: string[] = [];
    flushRichText(
      runs,
      buffer,
      styleStack,
      charCounter,
      ctx.textScale ?? false,
    );
    buffer = "";
    for (const run of runs) {
      pushHtml(run);
    }
  };
  for (let index = 0; index < value.length; ) {
    if (value[index] === "[") {
      const end = value.indexOf("]", index + 1);
      const tag =
        end >= 0
          ? parseRichTextTag(value.slice(index + 1, end), ctx.customTags)
          : null;
      if (!tag) {
        buffer += value[index] ?? "";
        index += 1;
        continue;
      }
      flushBuffer();
      if ("void" in tag && tag.void) {
        if (!tag.close) {
          pushHtml(tag.html);
        }
        index = end + 1;
      } else if ("img" in tag && tag.img) {
        if (tag.close) {
          // [/img] is a no-op: the path was consumed when the open tag was seen.
          index = end + 1;
        } else {
          // The image path is the content up to the next "[" (matching Godot).
          let pathEnd = value.indexOf("[", end + 1);
          if (pathEnd === -1) {
            pathEnd = value.length;
          }
          const path = value.slice(end + 1, pathEnd).trim();
          pushHtml(richTextImageHtml(path, tag.options ?? {}, ctx));
          index = pathEnd;
        }
      } else if (tag.close) {
        popRichTextStyle(styleStack, tag.type, tag.id);
        index = end + 1;
      } else {
        styleStack.push({
          type: tag.type,
          id: tag.id,
          value: tag.value,
          css: tag.css,
          effect: tag.effect,
        });
        index = end + 1;
      }
    } else {
      const ch = value[index] ?? "";
      // Inside an aligned region a hard newline starts a new paragraph BLOCK
      // (Godot semantics), so it is consumed as a segment break rather than left
      // in the buffer. `\r\n` collapses to one break. At the top level (no active
      // alignment) newlines stay in the buffer and render via `white-space:
      // pre-wrap`, exactly as before.
      const align = lastRichTextTag(styleStack, "align")?.value;
      if (align !== undefined && (ch === "\n" || ch === "\r")) {
        flushBuffer();
        breakSegment(align);
        index += ch === "\r" && value[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      buffer += ch;
      index += 1;
    }
  }
  flushBuffer();
  closeParagraph();
  return out.join("");
}

// One `<p>` per contiguous BBCode alignment region; `text-align` centers each
// visual line. Its runs are grouped into one `.godot-rich-paragraph` BLOCK per
// hard-newline-separated segment: a block's WRAPPED lines flow at the label width
// (the `.godot-rich-stack` is full-width) under `--godot-rich-line-height`, and
// consecutive blocks are separated by `--godot-rich-paragraph-spacing`. Both
// custom properties default to `normal`/`0` (base-css), so a region with a single
// segment and no consumer override lays out exactly like a plain wrapped block.
// Keeps `data-godot-bbcode-align` for downstream inspection.
function renderAlignParagraph(align: string, segments: string[][]): string {
  const textAlign = align === "fill" ? "justify" : align;
  const blocks = segments
    .map((runs) => `<span class="godot-rich-paragraph">${runs.join("")}</span>`)
    .join("");
  return `<p class="godot-rich-align" data-godot-bbcode-align="${escapeAttribute(align)}" style="text-align: ${escapeAttribute(textAlign)}">${blocks}</p>`;
}

// Memo for the layered BBCode render (module-scoped LRU, like `atlas.ts`'s data-URL memo). WHY:
// every RichTextLabel re-parses its whole BBCode string — tag scan, style stack, per-char effect
// spans — and then stamps the result into FOUR layers, on every render, for text that almost never
// changes. Phone traces showed these re-parses inside a play-a-card burst.
//
// CORRECTNESS: the key covers every input `richTextHtml` reads — the bbcode string, `ctx.textScale`
// and `ctx.customTags` — EXCEPT `ctx.resolveImage`, which is an opaque host callback whose answer
// can change over time (a texture resolving later). So a string carrying an `[img…]` tag, the only
// path that consults it, is never memoized at all.
const RICH_TEXT_CACHE_LIMIT = 200;
const richTextLayeredCache = createStringLru<string>(RICH_TEXT_CACHE_LIMIT);

// Any BBCode that could parse as an `[img]`/`[/img]` tag (`parseRichTextTag` trims the brackets'
// content and lowercases the name, so leading space and case both count). Deliberately loose —
// over-matching only costs a memo miss.
const RICH_TEXT_IMG_TAG = /\[\s*\/?\s*img\b/i;

// Content signature for the custom-tag table, cached per table OBJECT so a host that rebuilds an
// equal table each render still hits (and one that keeps a stable table pays for it once).
// Caveat: a table mutated IN PLACE keeps its old signature — gsw's `bbcodeTags` is render options,
// treated as immutable everywhere else too.
const customTagsSignatures = new WeakMap<object, string>();

function customTagsSignature(
  customTags: RichTextRenderContext["customTags"],
): string {
  if (!customTags) {
    return "";
  }
  let signature = customTagsSignatures.get(customTags);
  if (signature === undefined) {
    signature = JSON.stringify(customTags);
    customTagsSignatures.set(customTags, signature);
  }
  return signature;
}

/** TEST-ONLY: clear the layered rich-text memo so a test starts from an empty cache. */
export function __resetRichTextLayeredCacheForTest(): void {
  richTextLayeredCache.clear();
}

export function richTextLayeredHtml(
  value: string,
  ctx?: RichTextRenderContext,
): string {
  // Fixed-arity fields first, the arbitrary-content bbcode last, so a `|` in the text can
  // never alias another key's fields.
  const key = RICH_TEXT_IMG_TAG.test(value)
    ? null
    : `${ctx?.textScale ? "1" : "0"}|${customTagsSignature(ctx?.customTags)}|${value}`;
  if (key !== null) {
    const hit = richTextLayeredCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
  }
  const html = richTextHtml(value, ctx);
  const layered = [
    '<span class="godot-rich-stack">',
    `<span class="godot-rich-layer godot-rich-shadow-outline" data-godot-rich-layer="shadow-outline" aria-hidden="true">${html}</span>`,
    `<span class="godot-rich-layer godot-rich-shadow-fill" data-godot-rich-layer="shadow-fill" aria-hidden="true">${html}</span>`,
    `<span class="godot-rich-layer godot-rich-outline" data-godot-rich-layer="outline" aria-hidden="true">${html}</span>`,
    `<span class="godot-rich-layer godot-rich-fill" data-godot-rich-layer="fill">${html}</span>`,
    "</span>",
  ].join("");
  if (key !== null) {
    richTextLayeredCache.set(key, layered);
  }
  return layered;
}

function parseRichTextTag(
  raw: string,
  customTags?: GodotHtmlRenderOptions["bbcodeTags"],
): ParsedRichTextTag | null {
  const close = raw.startsWith("/");
  const body = (close ? raw.slice(1) : raw).trim();
  const match = body.match(/^([a-zA-Z_][\w-]*)(?:[=\s]+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  const name = (match[1] ?? "").toLowerCase();
  const rest = match[2]?.trim();

  // Simple paired formatting tags. Close tags only need to match on type+id.
  if (SIMPLE_RICH_TEXT_TAGS[name]) {
    return { close, type: SIMPLE_RICH_TEXT_TAGS[name], id: name };
  }

  // Paragraph alignment, both shorthand and `[p align=...]`.
  if (
    name === "center" ||
    name === "left" ||
    name === "right" ||
    name === "fill"
  ) {
    return { close, type: "align", id: name, value: name };
  }
  if (name === "p") {
    const align = rest?.match(/align\s*=\s*([a-zA-Z]+)/)?.[1]?.toLowerCase();
    return {
      close,
      type: "align",
      id: "p",
      value: close ? undefined : (align ?? "left"),
    };
  }

  // Color family. fgcolor is an alias of color; bgcolor paints a background.
  if (name === "color" || name === "fgcolor" || name === "outline_color") {
    return { close, type: "color", id: name, value: close ? undefined : rest };
  }
  if (name === "bgcolor") {
    return {
      close,
      type: "bgcolor",
      id: name,
      value: close ? undefined : rest,
    };
  }

  if (name === "font_size") {
    return {
      close,
      type: "font_size",
      id: name,
      value: close ? undefined : rest,
    };
  }

  if (name === "url") {
    return { close, type: "url", id: name, value: close ? undefined : rest };
  }

  // Recognized-but-structural tags: consumed so the brackets never leak as
  // literal text, but not visually modeled in this pass.
  if (
    name === "font" ||
    name === "outline_size" ||
    name === "lang" ||
    name === "hint"
  ) {
    return { close, type: "structural", id: name };
  }

  // Inline images. The path is the tag content (handled by the main loop); the
  // closing tag is a no-op that just keeps the brackets from leaking as text.
  if (name === "img") {
    return close
      ? { close: true, img: true }
      : {
          close: false,
          img: true,
          options: parseImgOptions(body.slice(name.length)),
        };
  }

  // Void tags (no closing form).
  if (!close && name === "br") {
    return { close, void: true, html: "<br>" };
  }
  if (!close && name === "hr") {
    return { close, void: true, html: '<hr class="godot-rich-hr">' };
  }

  // Built-in official effects.
  if (GODOT_BBCODE_BUILT_IN_EFFECTS[name]) {
    const spec = GODOT_BBCODE_BUILT_IN_EFFECTS[name];
    return {
      close,
      type: "effect",
      id: name,
      effect: { name, perChar: spec.perChar, perWord: spec.perWord },
    };
  }

  // Externally-fed custom tags (e.g. Slay the Spire 2's `red`, `thinky_dots`).
  const descriptor = customTags?.[name] ?? customTags?.[match[1] ?? ""];
  if (descriptor) {
    switch (descriptor.kind) {
      case "color":
        return {
          close,
          type: "color",
          id: name,
          value: close ? undefined : descriptor.value,
        };
      case "style":
        return {
          close,
          type: "style",
          id: name,
          css: close ? undefined : descriptor.css,
        };
      case "effect":
        return {
          close,
          type: "effect",
          id: name,
          effect: {
            name,
            perChar: Boolean(descriptor.perChar),
            perWord: Boolean(descriptor.perWord),
            className: descriptor.className,
          },
        };
    }
  }

  return null;
}

/**
 * Classify one BBCode tag name with the same parser used by rich-text output.
 *
 * The return is `undefined` for unknown tags. Custom descriptors are accepted
 * so callers can classify the exact grammar passed to `richTextLayeredHtml`.
 */
export function godotBbcodeTagKind(
  name: string,
  customTags?: GodotHtmlRenderOptions["bbcodeTags"],
): GodotBbcodeTagKind | undefined {
  const tag = parseRichTextTag(name, customTags);
  if (!tag) return undefined;
  if ("img" in tag && tag.img) return "image";
  if ("void" in tag && tag.void) return "void";
  return tag.type;
}

// Parse the part of an `[img ...]` tag after the name: a leading `=VALUE`
// (dimensions `N`/`NxM` or vertical alignment) plus space-separated options.
function parseImgOptions(afterName: string): RichTextImgOptions {
  const options: RichTextImgOptions = {};
  let rest = afterName;
  const valueMatch = rest.match(/^=\s*([^\s]+)/);
  if (valueMatch) {
    applyImgValue(options, valueMatch[1] ?? "");
    rest = rest.slice(valueMatch[0].length);
  }
  const optionRe = /([a-zA-Z_]+)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
  for (let match = optionRe.exec(rest); match; match = optionRe.exec(rest)) {
    applyImgOption(
      options,
      (match[1] ?? "").toLowerCase(),
      unquote(match[2] ?? ""),
    );
  }
  return options;
}

function applyImgValue(options: RichTextImgOptions, value: string): void {
  const valign = imgValign((value.split(",")[0] ?? "").toLowerCase());
  if (valign) {
    options.valign = valign;
    return;
  }
  const sep = value.indexOf("x");
  if (sep === -1) {
    const width = Number.parseInt(value, 10);
    if (Number.isFinite(width) && width > 0) {
      options.width = width;
    }
    return;
  }
  const width = Number.parseInt(value.slice(0, sep), 10);
  const height = Number.parseInt(value.slice(sep + 1), 10);
  if (Number.isFinite(width) && width > 0) {
    options.width = width;
  }
  if (Number.isFinite(height) && height > 0) {
    options.height = height;
  }
}

function applyImgOption(
  options: RichTextImgOptions,
  key: string,
  value: string,
): void {
  switch (key) {
    case "width":
    case "height": {
      // Percent sizing is out of scope for this pass.
      if (value.endsWith("%")) {
        return;
      }
      const size = Number.parseInt(value, 10);
      if (Number.isFinite(size) && size > 0) {
        options[key] = size;
      }
      return;
    }
    case "region": {
      const parts = value.split(",").map((part) => Number.parseFloat(part));
      if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
        options.region = {
          x: parts[0]!,
          y: parts[1]!,
          width: parts[2]!,
          height: parts[3]!,
        };
      }
      return;
    }
    case "alt":
      options.alt = value;
      return;
  }
}

function imgValign(token: string): RichTextImgOptions["valign"] | undefined {
  if (token === "top" || token === "t") {
    return "top";
  }
  if (token === "center" || token === "c") {
    return "middle";
  }
  if (token === "bottom" || token === "b") {
    return "bottom";
  }
  return undefined;
}

function unquote(value: string): string {
  return value.length >= 2 && /^["']/.test(value) && value.endsWith(value[0]!)
    ? value.slice(1, -1)
    : value;
}

// Godot's default `[img]` alignment is InlineAlignment.Center, which centers the
// image on the text line-box midpoint — ~`(ascent - descent) / 2` above the
// baseline. CSS `vertical-align: middle` instead centers on the x-height midpoint
// (`x-height / 2` above the baseline), which sits lower, so inline icons (energy
// orbs, etc.) render below where the game draws them. For the default-centered
// case, nudge the image up by the font-metric delta so it matches Godot. Measured
// against the game UI font (kreon): ascent 0.974em, descent 0.286em, x-height
// 0.500em -> delta = (0.974 - 0.286)/2 - 0.500/2 ≈ 0.094em. Applied as a
// layout-neutral relative offset (no reflow); the `em` tracks the run's (scaled)
// font size. Explicit `[img=top]` / `[img=bottom]` keep their own alignment.
const RICH_IMG_CENTER_NUDGE_EM = 0.094;
function applyCenterValignNudge(
  style: Record<string, string>,
  valign: NonNullable<RichTextImgOptions["valign"]>,
): void {
  if (valign !== "middle") {
    return;
  }
  style.position = "relative";
  style.top = `-${RICH_IMG_CENTER_NUDGE_EM}em`;
}

function richTextImageHtml(
  path: string,
  options: RichTextImgOptions,
  ctx: RichTextRenderContext,
): string {
  const resolved = ctx.resolveImage?.(path);
  const url = resolved?.url;
  const region = options.region ?? resolved?.region;
  const valign = options.valign ?? "middle";
  const attributes = [
    `data-godot-bbcode-img="${escapeAttribute(path)}"`,
    `data-godot-bbcode-img-valign="${valign}"`,
  ];
  const resourcePath = resolved?.path ?? path;
  if (resourcePath) {
    attributes.push(
      `data-godot-resource-path="${escapeAttribute(resourcePath)}"`,
    );
  }
  if (options.width !== undefined) {
    attributes.push(`data-godot-bbcode-img-width="${options.width}"`);
  }
  if (options.height !== undefined) {
    attributes.push(`data-godot-bbcode-img-height="${options.height}"`);
  }
  if (region) {
    attributes.push(
      `data-godot-bbcode-img-region="${region.x},${region.y},${region.width},${region.height}"`,
    );
  }

  // No resolvable URL: keep a placeholder so the path is consumed (not leaked as
  // text), mirroring Godot dropping the image when the texture fails to load.
  if (!url) {
    return `<span class="godot-rich-img" ${attributes.join(" ")} style="vertical-align: ${valign}"></span>`;
  }

  if (region) {
    return richTextImageRegionHtml(
      url,
      region,
      options,
      resolved,
      valign,
      attributes,
    );
  }

  const style: Record<string, string> = { "vertical-align": valign };
  applyCenterValignNudge(style, valign);
  if (options.width !== undefined) {
    style.width = `${options.width}px`;
  }
  if (options.height !== undefined) {
    style.height = `${options.height}px`;
  }
  const altAttr = ` alt="${escapeAttribute(options.alt ?? "")}"`;
  return `<img class="godot-rich-img" ${attributes.join(" ")} src="${escapeAttribute(url)}"${altAttr} style="${escapeAttribute(styleAttribute(style))}">`;
}

// Region crops render as an inline-block span with a positioned background,
// reusing the same scale/offset math as TextureRect regions in textures.ts.
function richTextImageRegionHtml(
  url: string,
  region: { x: number; y: number; width: number; height: number },
  options: RichTextImgOptions,
  resolved: GodotResolvedResource | undefined,
  valign: NonNullable<RichTextImgOptions["valign"]>,
  attributes: string[],
): string {
  const boxWidth = options.width ?? region.width;
  const boxHeight = options.height ?? region.height;
  const textureSize = resolved?.atlas?.size ?? resolved?.size;
  const style: Record<string, string> = {
    display: "inline-block",
    "vertical-align": valign,
    width: `${round(boxWidth)}px`,
    height: `${round(boxHeight)}px`,
    "background-image": `url("${cssUrl(url)}")`,
    "background-repeat": "no-repeat",
  };
  applyCenterValignNudge(style, valign);
  if (
    textureSize &&
    textureSize.width > 0 &&
    textureSize.height > 0 &&
    region.width > 0 &&
    region.height > 0
  ) {
    const scaleX = boxWidth / region.width;
    const scaleY = boxHeight / region.height;
    style["background-position"] =
      `${round(-region.x * scaleX)}px ${round(-region.y * scaleY)}px`;
    style["background-size"] =
      `${round(textureSize.width * scaleX)}px ${round(textureSize.height * scaleY)}px`;
  } else {
    style["background-position"] =
      `${round(-region.x)}px ${round(-region.y)}px`;
    style["background-size"] = "auto";
  }
  return `<span class="godot-rich-img" ${attributes.join(" ")} style="${escapeAttribute(styleAttribute(style))}"></span>`;
}

function flushRichText(
  result: string[],
  text: string,
  styleStack: RichTextTag[],
  charCounter: { value: number },
  scaleText: boolean,
): void {
  if (!text) {
    return;
  }
  const style = currentRichTextStyle(styleStack);
  let base = style.effect?.perChar
    ? richTextCharWordHtml(text, charCounter)
    : escapeHtml(text);
  if (style.code) {
    base = `<code class="godot-rich-code">${base}</code>`;
  }
  let html: string;
  if (style.bold && style.italic) {
    html = `<strong class="godot-rich-bold"><em class="godot-rich-italic">${base}</em></strong>`;
  } else if (style.bold) {
    html = `<strong class="godot-rich-bold">${base}</strong>`;
  } else if (style.italic) {
    html = `<em class="godot-rich-italic">${base}</em>`;
  } else {
    html = `<span class="godot-rich-normal">${base}</span>`;
  }
  if (style.underline) {
    html = `<span class="godot-rich-underline" style="text-decoration: underline">${html}</span>`;
  }
  if (style.strike) {
    html = `<span class="godot-rich-strike" style="text-decoration: line-through">${html}</span>`;
  }
  if (style.fontSize) {
    const numericSize = Number.parseFloat(style.fontSize);
    const fontSizeCss =
      scaleText && Number.isFinite(numericSize)
        ? textScaleLength(numericSize, true)
        : `${escapeAttribute(style.fontSize)}px`;
    html = `<span class="godot-rich-font-size" data-godot-bbcode-font-size="${escapeAttribute(style.fontSize)}" style="font-size: ${fontSizeCss}">${html}</span>`;
  }
  if (style.styleCss) {
    html = `<span class="godot-rich-style" style="${escapeAttribute(inlineCssText(style.styleCss))}">${html}</span>`;
  }
  if (style.color) {
    html = `<span class="godot-rich-color" data-godot-bbcode-color="${escapeAttribute(style.color)}" style="color: ${escapeAttribute(style.color)}">${html}</span>`;
  }
  if (style.bgcolor) {
    html = `<span class="godot-rich-bgcolor" data-godot-bbcode-bgcolor="${escapeAttribute(style.bgcolor)}" style="background-color: ${escapeAttribute(style.bgcolor)}">${html}</span>`;
  }
  if (style.url) {
    html = `<span class="godot-rich-url" data-godot-bbcode-url="${escapeAttribute(style.url)}" style="text-decoration: underline">${html}</span>`;
  }
  if (style.effect) {
    const effect = style.effect;
    const className = [
      "godot-rich-effect",
      `godot-rich-effect-${safeClassSegment(effect.name)}`,
      effect.className,
    ]
      .filter(Boolean)
      .join(" ");
    html = `<span class="${escapeAttribute(className)}" data-godot-bbcode-effect="${escapeAttribute(effect.name)}">${html}</span>`;
  }
  // Alignment is applied at the paragraph level (richTextHtml/renderAlignParagraph),
  // not per run, so a `[center]` region wraps as one block instead of forcing each
  // styled run onto its own line.
  if (style.indent) {
    html = `<span class="godot-rich-indent" style="display: block; padding-left: 2em">${html}</span>`;
  }
  result.push(html);
}

// Split a run into per-word and per-char spans (mirroring the Godot/STS2 web
// structure) so effects can animate individual letters via the `--i` index.
function richTextCharWordHtml(
  text: string,
  charCounter: { value: number },
): string {
  const parts = text.match(/\s+|\S+/g) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      out.push(escapeHtml(part));
      continue;
    }
    const chars: string[] = [];
    for (const char of part) {
      chars.push(
        `<span class="godot-rich-char" style="--i: ${charCounter.value}">${escapeHtml(char)}</span>`,
      );
      charCounter.value += 1;
    }
    out.push(`<span class="godot-rich-word">${chars.join("")}</span>`);
  }
  return out.join("");
}

function inlineCssText(css: Record<string, string>): string {
  return Object.entries(css)
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ");
}

function currentRichTextStyle(styleStack: RichTextTag[]): {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  indent: boolean;
  align?: string;
  color?: string;
  bgcolor?: string;
  url?: string;
  fontSize?: string;
  styleCss?: Record<string, string>;
  effect?: RichTextEffect;
} {
  return {
    bold: styleStack.some((tag) => tag.type === "bold"),
    italic: styleStack.some((tag) => tag.type === "italic"),
    underline: styleStack.some((tag) => tag.type === "underline"),
    strike: styleStack.some((tag) => tag.type === "strike"),
    code: styleStack.some((tag) => tag.type === "code"),
    indent: styleStack.some((tag) => tag.type === "indent"),
    align: lastRichTextTag(styleStack, "align")?.value,
    color: lastRichTextTag(styleStack, "color")?.value,
    bgcolor: lastRichTextTag(styleStack, "bgcolor")?.value,
    url: lastRichTextTag(styleStack, "url")?.value,
    fontSize: lastRichTextTag(styleStack, "font_size")?.value,
    styleCss: lastRichTextTag(styleStack, "style")?.css,
    effect: lastRichTextTag(styleStack, "effect")?.effect,
  };
}

function lastRichTextTag(
  styleStack: RichTextTag[],
  type: RichTextTag["type"],
): RichTextTag | undefined {
  for (let index = styleStack.length - 1; index >= 0; index -= 1) {
    const tag = styleStack[index];
    if (tag?.type === type && tag.value !== undefined) {
      return tag;
    }
    if (tag?.type === type && (type === "style" || type === "effect")) {
      return tag;
    }
  }
  return undefined;
}

function popRichTextStyle(
  styleStack: RichTextTag[],
  type: RichTextTag["type"],
  id: string,
): void {
  for (let index = styleStack.length - 1; index >= 0; index -= 1) {
    const tag = styleStack[index];
    if (tag?.type === type && tag.id === id) {
      styleStack.splice(index, 1);
      return;
    }
  }
  for (let index = styleStack.length - 1; index >= 0; index -= 1) {
    if (styleStack[index]?.type === type) {
      styleStack.splice(index, 1);
      return;
    }
  }
}
