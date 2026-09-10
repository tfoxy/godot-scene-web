import { round } from "./css-values";
import { renderRichTextFontSize } from "./text";
import { textScaleLength } from "./text-scale";
import type {
  GodotTextAutoFitDirective,
  GodotTextAutoFitNominalMetrics,
} from "./types";

const EPSILON_PX = 0.5;

const RICH_TEXT_FONT_SIZE_VARS = [
  "--godot-rich-normal-font-size",
  "--godot-rich-bold-font-size",
  "--godot-rich-italic-font-size",
  "--godot-rich-bold-italic-font-size",
] as const;

export function resolveTextAutoFitFontSize(
  directive: GodotTextAutoFitDirective,
  fits: (fontSizePx: number) => boolean,
): number {
  const min = Math.ceil(directive.minFontSizePx);
  const max = Math.floor(directive.maxFontSizePx);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return min;
  }

  let low = min;
  let high = max;
  let best: number | undefined;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (fits(candidate)) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best ?? min;
}

export function applyTextAutoFit(stage: ParentNode): number {
  let applied = 0;
  for (const element of stage.querySelectorAll<HTMLElement>(
    "[data-godot-text-auto-fit='true']",
  )) {
    if (applyElementTextAutoFit(element)) {
      applied++;
    }
  }
  return applied;
}

function applyElementTextAutoFit(element: HTMLElement): boolean {
  const directive = directiveFromElement(element);
  if (!directive || (!directive.fitWidth && !directive.fitHeight)) {
    return false;
  }
  const selfLayer = element.querySelector<HTMLElement>(
    ':scope > [data-godot-self-layer="true"]',
  );
  if (!selfLayer) {
    return false;
  }
  const measureTarget =
    element.dataset.godotType === "RichTextLabel"
      ? (selfLayer.querySelector<HTMLElement>(
          '[data-godot-rich-layer="fill"]',
        ) ?? selfLayer)
      : selfLayer;
  const box = elementBox(element, selfLayer);
  if (
    (directive.fitWidth && !(box.width > 0)) ||
    (directive.fitHeight && !(box.height > 0))
  ) {
    return false;
  }

  // Prefer fitting from host-engine metrics; fall back to DOM measurement only when
  // metrics are unavailable (the DOM path mutates the font size while probing).
  const metricFits = metricFitPredicate(directive, box);
  const fits =
    metricFits ??
    ((candidate: number) => {
      assignAutoFitFontSize(element, selfLayer, candidate);
      const content = contentBox(measureTarget);
      return (
        (!directive.fitWidth || content.width <= box.width + EPSILON_PX) &&
        (!directive.fitHeight || content.height <= box.height + EPSILON_PX)
      );
    });
  const size = resolveTextAutoFitFontSize(directive, fits);
  assignAutoFitFontSize(element, selfLayer, size);
  return true;
}

/**
 * Build a pure `fits(candidate)` predicate from host-engine paragraph metrics
 * (measured at `nominalFontSizePx`): each candidate scales the nominal content box
 * by `candidate / nominalFontSizePx`, so width/height fits match the engine without
 * DOM measurement. Returns `null` when metrics or a positive nominal size are
 * unavailable, so the caller falls back to measuring the live DOM.
 */
export function metricFitPredicate(
  directive: GodotTextAutoFitDirective,
  box: { width: number; height: number },
): ((candidate: number) => boolean) | null {
  const metrics: GodotTextAutoFitNominalMetrics | undefined =
    directive.nominalMetrics;
  const nominal = directive.nominalFontSizePx;
  if (!metrics || nominal === undefined || !(nominal > 0)) {
    return null;
  }
  const { contentWidthPx, contentHeightPx } = metrics;
  if (!(contentWidthPx > 0) || !(contentHeightPx > 0)) {
    return null;
  }
  return (candidate: number) => {
    const ratio = candidate / nominal;
    return (
      (!directive.fitWidth ||
        contentWidthPx * ratio <= box.width + EPSILON_PX) &&
      (!directive.fitHeight ||
        contentHeightPx * ratio <= box.height + EPSILON_PX)
    );
  };
}

function directiveFromElement(
  element: HTMLElement,
): GodotTextAutoFitDirective | undefined {
  const minFontSizePx = numberData(element, "godotTextAutoFitMinFontSizePx");
  const maxFontSizePx = numberData(element, "godotTextAutoFitMaxFontSizePx");
  if (
    minFontSizePx === undefined ||
    maxFontSizePx === undefined ||
    minFontSizePx <= 0 ||
    maxFontSizePx <= 0 ||
    maxFontSizePx < minFontSizePx
  ) {
    return undefined;
  }
  return {
    minFontSizePx,
    maxFontSizePx,
    nominalFontSizePx: numberData(element, "godotTextAutoFitNominalFontSizePx"),
    nominalMetrics: nominalMetricsFromElement(element),
    fitWidth: element.dataset.godotTextAutoFitWidth === "true",
    fitHeight: element.dataset.godotTextAutoFitHeight === "true",
    wrapMode: element.dataset.godotTextAutoFitWrapMode,
    textOverrunBehavior: element.dataset.godotTextAutoFitOverrunBehavior,
  };
}

function nominalMetricsFromElement(
  element: HTMLElement,
): GodotTextAutoFitNominalMetrics | undefined {
  const raw = element.dataset.godotTextAutoFitNominalMetrics;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as GodotTextAutoFitNominalMetrics)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberData(
  element: HTMLElement,
  key: keyof HTMLElement["dataset"],
): number | undefined {
  const raw = element.dataset[key];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function assignAutoFitFontSize(
  element: HTMLElement,
  selfLayer: HTMLElement,
  fontSizePx: number,
): void {
  // When the node opted into text scaling, the fitted size must still track
  // `var(--godot-text-scale, 1)` so the player's slider keeps affecting it post-fit.
  const scaleText = element.dataset.godotTextScale === "true";
  if (element.dataset.godotType === "RichTextLabel") {
    // Godot scales every rich-text font role together; resizing only the normal
    // role would leave bold/italic runs at the authored size.
    const shouldScale = element.dataset.godotRichTextScaleFontSize !== "false";
    const renderedPx =
      renderRichTextFontSize(fontSizePx, shouldScale) ?? fontSizePx;
    for (const property of RICH_TEXT_FONT_SIZE_VARS) {
      selfLayer.style.setProperty(
        property,
        textScaleLength(renderedPx, scaleText),
      );
    }
  } else {
    selfLayer.style.fontSize = textScaleLength(fontSizePx, scaleText);
  }
  // Mirror assignTextStyles: line-height tracks the fitted logical size plus
  // line_separation, but only when the engine specified a separation (otherwise
  // leave it to the cascade rather than tightening Godot's font-metric spacing).
  const lineSeparation = numberData(element, "godotLineSeparationPx");
  if (lineSeparation !== undefined) {
    selfLayer.style.lineHeight = textScaleLength(
      Math.max(1, fontSizePx + lineSeparation),
      scaleText,
    );
  }
}

function elementBox(
  element: HTMLElement,
  selfLayer: HTMLElement,
): { width: number; height: number } {
  // Prefer the engine-assigned logical size (style width/height) over
  // getBoundingClientRect: the stage is commonly wrapped in a `transform: scale()`
  // to fit the viewport, and getBoundingClientRect reports the *scaled* size, while
  // the fit inputs (nominalMetrics and scrollWidth/Height) are logical/unscaled.
  // Mixing them shrinks text on scaled pages. Fall back to measured rects only when
  // no logical size is set.
  const rect = element.getBoundingClientRect();
  const selfRect = selfLayer.getBoundingClientRect();
  return {
    width:
      cssSize(element.style.width) ??
      cssSize(selfLayer.style.width) ??
      positive(rect.width) ??
      positive(selfRect.width) ??
      0,
    height:
      cssSize(element.style.height) ??
      cssSize(selfLayer.style.height) ??
      positive(rect.height) ??
      positive(selfRect.height) ??
      0,
  };
}

// Caveat: the RichTextLabel content layer is now full-width (`.godot-rich-stack`
// is `width: 100%`), so `scrollWidth` reports the box width rather than the text
// width. That is harmless for the height-fit path used by every captured fixture
// (those carry nominalMetrics, so metricFitPredicate runs and this is never
// read), but a hypothetical width-fit-by-DOM RichTextLabel would mis-measure —
// measure the widest line (getClientRects) instead if that case ever appears.
function contentBox(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width:
      positive(element.scrollWidth) ??
      positive(rect.width) ??
      cssSize(element.style.width) ??
      0,
    height:
      positive(element.scrollHeight) ??
      positive(rect.height) ??
      cssSize(element.style.height) ??
      0,
  };
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function cssSize(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? round(parsed) : undefined;
}
