// Live-DOM browser-zoom detector: reports the page-zoom factor relative to the
// zoom level at install time (1 = unchanged). Desktop browser zoom (ctrl +/-,
// desktop-touchpad pinch) multiplies `devicePixelRatio` by the zoom step and
// shrinks the layout viewport by it; hosts that want zoom to *apply* to a
// scale-to-fit surface (instead of being neutralized by a refit) can hold the
// surface at `layoutViewport · zoom` CSS px and let the page scroll.
//
// What this deliberately does NOT react to:
// - Mobile pinch-zoom: that scales the VISUAL viewport only — `devicePixelRatio`
//   and the layout viewport are untouched, the browser magnifies and pans
//   natively. All reads here are layout-viewport reads (`documentElement
//   .clientWidth`, never `innerWidth`, which tracks the visual viewport on
//   mobile), so a pinch leaves the detector inert.
// - Plain window resizes: `devicePixelRatio` is unchanged, so the zoom stays 1.
//
// Known limits (no web API separates browser zoom from system DPI): a page
// loaded pre-zoomed treats that level as 100%, and a `devicePixelRatio` change
// is classified by heuristic — zoom keeps the window's *physical* pixel size
// ~constant while monitor/OS-scale moves do not, so a simultaneous physical-size
// change rebases the baseline instead of reporting zoom. A misclassification
// degrades to reporting 1 (the legacy fit behavior) until the next zoom event.

export type BrowserZoomWindow = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "devicePixelRatio" | "matchMedia"
> & {
  document: { documentElement: Pick<HTMLElement, "clientWidth"> };
};

// `devicePixelRatio` deltas below this are floating-point noise (real zoom
// steps are >= 10%); physical-size drift below the tolerance is rounding from
// the integer `clientWidth`.
export const BROWSER_ZOOM_EPSILON = 0.005;
export const BROWSER_ZOOM_REBASE_TOLERANCE = 0.02;

export function observeBrowserZoom(
  onChange: (zoom: number) => void,
  targetWindow: BrowserZoomWindow = window,
): () => void {
  const readDpr = (): number => {
    const dpr = targetWindow.devicePixelRatio;
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  };
  const physicalWidth = (dpr: number): number =>
    targetWindow.document.documentElement.clientWidth * dpr;

  let baselineDpr = readDpr();
  let lastDpr = baselineDpr;
  let lastPhysicalWidth = physicalWidth(lastDpr);
  let lastReported = 1;
  let disposed = false;

  // A `(resolution: …dppx)` query stops matching the moment the effective DPR
  // changes, catching DPR-only transitions (e.g. dragging the window onto a
  // different-DPI monitor) that fire no `resize`. Re-armed for the new DPR
  // after every change.
  let mediaQuery: MediaQueryList | null = null;
  const disarmMediaQuery = (): void => {
    mediaQuery?.removeEventListener("change", update);
    mediaQuery = null;
  };
  const armMediaQuery = (dpr: number): void => {
    disarmMediaQuery();
    if (typeof targetWindow.matchMedia !== "function") {
      return;
    }
    mediaQuery = targetWindow.matchMedia(`(resolution: ${dpr}dppx)`);
    mediaQuery.addEventListener("change", update);
  };

  function update(): void {
    if (disposed) {
      return;
    }
    const dpr = readDpr();
    if (Math.abs(dpr - lastDpr) > BROWSER_ZOOM_EPSILON) {
      const physical = physicalWidth(dpr);
      const physRatio = physical / lastPhysicalWidth;
      if (
        !Number.isFinite(physRatio) ||
        Math.abs(physRatio - 1) > BROWSER_ZOOM_REBASE_TOLERANCE
      ) {
        // Physical size moved with the DPR: monitor/OS-scale change, not zoom.
        // Shift the baseline so the currently-reported zoom is preserved.
        baselineDpr *= dpr / lastDpr;
      }
      armMediaQuery(dpr);
    }
    lastDpr = dpr;
    lastPhysicalWidth = physicalWidth(dpr);
    let zoom = dpr / baselineDpr;
    if (!Number.isFinite(zoom) || zoom <= 0) {
      zoom = 1;
    }
    if (Math.abs(zoom - lastReported) > BROWSER_ZOOM_EPSILON) {
      lastReported = zoom;
      onChange(zoom);
    }
  }

  onChange(1);
  targetWindow.addEventListener("resize", update);
  armMediaQuery(lastDpr);

  return () => {
    disposed = true;
    targetWindow.removeEventListener("resize", update);
    disarmMediaQuery();
  };
}
