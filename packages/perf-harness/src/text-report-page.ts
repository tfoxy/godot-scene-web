// The text report's page: markup, CSS and the ~200 lines of browser JS that drive it.
//
// Split out of `text-report.ts` so the reader — which is the part with the honesty rules in it, and
// the part under test — stays readable next to a wall of template literal. Nothing here reads the
// filesystem, and nothing here computes a metric: every number arrives pre-formatted in `data`, so
// a cell can never say something the node side did not already decide it was entitled to say.
//
// THREE VIEWS, ONE PAGE:
//
//   grid  every arm side by side, plus the full metric tables
//   flip  ONE arm at a time in a fixed box, switched instantly, so the eye compares in place
//   diff  |arm - reference| at the same offset, amplified live
//
// WHY THE FLIP VIEW IS BUILT THE WAY IT IS. Swapping `img.src` to change arms flashes: the browser
// tears down the old frame before the new one is decoded and painted, and that blink is precisely
// the thing that destroys an A/B comparison of two nearly-identical images. So the six arms are
// six STACKED `<img>` elements and switching is an opacity toggle — no decode, no reflow, no
// repaint of anything but the compositor's blend.
//
// The offset axis IS a `src` swap, deliberately: 6 arms x 8 offsets stacked at 16x zoom would be
// ~700 MB of rasterised layers. It is safe here only because every still is also painted at 1:1 in
// the hidden preload pool, so the bytes are already decoded and the swap is synchronous. That is
// the whole reason the pool exists — it is not a caching nicety, it is what makes the cheap
// structure behave like the expensive one.
//
// FLIP AND DIFF CARRY THE SELECTED ARM'S NUMBERS BESIDE THE IMAGE. They show one arm at a time with
// no table in view, which is how a 2.35 px vertical offset in the dom arm once read as a rasterizer
// difference for a whole round. The panel is rendered from the same pre-formatted cells the grid
// tables use, so it can never disagree with them, and an arm whose alignment disqualifies its
// per-pixel views says so where those views are.

import type { TextReportData } from "./text-report";

const PAGE_CSS = `
:root {
  --bg: #101014;
  --panel: #17171d;
  --line: #2b2b36;
  --ink: #d7d7e0;
  --dim: #8b8b9c;
  --accent: #7dd3fc;
  --good: #86efac;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
}
h1 { font-size: 14px; margin: 0 10px 0 0; font-weight: 600; }
.tabs { display: flex; gap: 4px; }
button, select {
  background: #21212a;
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 9px;
  font: inherit;
  cursor: pointer;
}
button:hover, select:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent); color: #08080c; border-color: var(--accent); }
label { color: var(--dim); display: inline-flex; gap: 6px; align-items: center; }
input[type="range"] { width: 120px; vertical-align: middle; }
.spacer { flex: 1; }
main { padding: 14px; }
.view[hidden] { display: none; }

/* Panes: the scroll container is never rebuilt, which is what keeps the view IN PLACE across
   every arm, offset and zoom change. */
.pane {
  overflow: auto;
  background:
    linear-gradient(45deg, #0b0b0e 25%, transparent 25%, transparent 75%, #0b0b0e 75%),
    linear-gradient(45deg, #0b0b0e 25%, #131318 25%, #131318 75%, #0b0b0e 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  max-height: calc(100vh - 190px);
  padding: 12px;
}
img { image-rendering: pixelated; display: block; }
.stack { position: relative; }
.stack img { position: absolute; left: 0; top: 0; opacity: 0; transition: none; }
.stack img.on { opacity: 1; }
.pool { position: absolute; left: -10000px; top: 0; width: 1px; height: 1px; overflow: hidden; }

.cards { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
.card { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 8px; }
.card h2 { font-size: 12px; margin: 0 0 6px; font-weight: 600; }
.card .kind { color: var(--dim); font-weight: 400; }
.card figure { margin: 0; overflow: auto; max-width: 90vw; }
.card dl { display: grid; grid-template-columns: auto auto; gap: 1px 10px; margin: 8px 0 0; font-size: 11px; }
.card dt { color: var(--dim); }
.card dd { margin: 0; text-align: right; }
.blurb { color: var(--dim); font-size: 11px; max-width: 46ch; margin: 6px 0 0; }

section.group { margin-top: 22px; }
section.group h2 { font-size: 13px; margin: 0 0 2px; }
.env { color: var(--accent); font-size: 11px; margin: 0 0 6px; }
.note { color: var(--dim); font-size: 11px; margin: 2px 0; max-width: 110ch; }
table { border-collapse: collapse; font-size: 12px; margin-top: 6px; }
th, td { border: 1px solid var(--line); padding: 3px 9px; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { background: var(--panel); position: sticky; top: 0; }
td.best { color: var(--good); font-weight: 600; }
tbody tr:hover { background: #1b1b23; }
.hint { color: var(--dim); font-weight: 400; font-size: 11px; }

/* Numbers beside the pixels. The grid has the full tables; flip and diff show ONE arm, and a
   reader who has to scroll back to a table to find out what they are looking at will not. */
.split { display: flex; gap: 14px; align-items: flex-start; }
.split .pane { flex: 1; min-width: 0; }
.readout {
  flex: 0 0 320px;
  width: 320px;
  position: sticky;
  top: 60px;
  max-height: calc(100vh - 190px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  padding: 10px 12px;
}
.readout h3 { font-size: 12px; margin: 0 0 4px; font-weight: 600; }
.readout h3 .kind { color: var(--dim); font-weight: 400; }
.readout h4 { font-size: 11px; margin: 14px 0 0; font-weight: 600; }
.readout dl { display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; margin: 4px 0 0; font-size: 11px; }
.readout dt { color: var(--dim); }
.readout dd { margin: 0; text-align: right; white-space: nowrap; }
.readout dd.best { color: var(--good); font-weight: 600; }
.readout .ref { color: var(--dim); }

.missing { border: 1px solid #7f5a20; background: #241c0e; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; }
.missing h2 { font-size: 12px; margin: 0 0 6px; color: #f5c451; }
.missing code { color: var(--accent); }
.missing li { margin-bottom: 4px; }
.warn {
  border: 1px solid #7f5a20;
  background: #241c0e;
  color: #f5c451;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  margin: 0 0 10px;
}
.warn[hidden] { display: none; }
.caption { color: var(--dim); font-size: 11px; margin: 8px 0 0; }
kbd {
  background: #21212a; border: 1px solid var(--line); border-bottom-width: 2px;
  border-radius: 3px; padding: 0 4px; font-size: 11px;
}
`;

const PAGE_JS = String.raw`
const DATA = JSON.parse(document.getElementById("report-data").textContent);
const ARMS = DATA.arms;
const OFFSETS = DATA.offsets;
const $ = (id) => document.getElementById(id);

/* Opens on the dom arm -- what gsw renders today -- so the first flip is always "the status quo
   versus the alternative", which is the question this round exists to answer. */
const state = {
  view: "grid",
  arm: (ARMS.find((a) => a.arm === "dom") || ARMS[0] || { arm: "" }).arm,
  offset: 0,
  zoom: 4,
  gain: 4,
  fps: 4,
  playing: false,
};

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  for (const part of raw.split("&")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) continue;
    if (key === "view" && ["grid", "flip", "diff"].includes(value)) state.view = value;
    if (key === "arm" && ARMS.some((a) => a.arm === value)) state.arm = value;
    if (key === "offset") state.offset = clamp(Number(value) | 0, 0, OFFSETS.length - 1);
    if (key === "zoom") state.zoom = clamp(Number(value) | 0, 1, 16);
    if (key === "gain") state.gain = clamp(Number(value) | 0, 1, 20);
    if (key === "fps") state.fps = clamp(Number(value) | 0, 1, 16);
  }
}
function writeHash() {
  const next =
    "#view=" + state.view + "&arm=" + state.arm + "&offset=" + state.offset +
    "&zoom=" + state.zoom + "&gain=" + state.gain + "&fps=" + state.fps;
  if (location.hash !== next) history.replaceState(null, "", next);
}
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/* ---- device pixels --------------------------------------------------------------------- */

/* ZOOM IS IN DEVICE PIXELS, NOT CSS PIXELS, AND THAT DISTINCTION IS THE WHOLE POINT OF THIS VIEWER.
   Every image here is image-rendering: pixelated at an integer zoom so that what is on screen ARE
   the actual pixels. That claim is only true if one source pixel covers a whole number of DEVICE
   pixels, and a CSS size does not control device pixels on its own: at devicePixelRatio 1.25 a
   width of w * 4 CSS px is rasterised to w * 5 device px, so 4x really draws each source pixel
   5 device px wide -- and 1x, 2x and 3x land on 1.25, 2.5 and 3.75, which pixelated can only
   resolve by making some source pixels 2 device px wide and their neighbours 3. That uneven blocking
   is a texture the RASTERIZER did not produce, laid over every arm, in the one tool whose entire job
   is telling two nearly-identical rasterisations apart.

   So the CSS size is DIVIDED by the ratio: w * zoom / dpr CSS px is w * zoom device px, exactly,
   and zoom means what it says on every display. The visible consequence at a fractional ratio is
   that the image is physically smaller on screen than it used to be -- 0.8x the size at dpr 1.25 --
   which is the honest rendering of "these are the pixels" rather than a bigger, resampled lie. */
const deviceRatio = () => window.devicePixelRatio || 1;

/* CSS px for sourcePx source pixels at the current zoom. Fractional by design; the browser snaps
   the painted box to a device pixel and the product above is already an integer, so the snap is a
   no-op rather than the rounding it would otherwise be hiding. */
const cssPx = (sourcePx) => (sourcePx * state.zoom) / deviceRatio();

/* devicePixelRatio is not constant: it changes when the window moves to another monitor and when
   the user zooms the BROWSER, which is exactly when someone comparing two stills would zoom in. A
   resolution media query is the only event for it, and the query has to be rebuilt each time
   because it is stated in terms of the ratio it is watching for. */
function watchDeviceRatio(onChange) {
  let query = null;
  const arm = () => {
    if (query) query.onchange = null;
    query = window.matchMedia("(resolution: " + deviceRatio() + "dppx)");
    query.onchange = () => {
      arm();
      onChange();
    };
  };
  arm();
}

/* ---- image plumbing ------------------------------------------------------------------ */

/* Every still and every diff, painted 1:1 off-screen. ~100 images at 185x81 is under 2 MB of
   raster, and it is what makes an offset step a synchronous src swap instead of a decode. */
function buildPool() {
  const pool = $("pool");
  const seen = new Set();
  for (const arm of ARMS) {
    for (const file of [...arm.stills, ...arm.diffs]) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const img = new Image();
      img.src = file;
      img.decoding = "sync";
      pool.append(img);
    }
  }
}

function makeStack(id, pick) {
  const stack = $(id);
  const box = document.createElement("div");
  box.className = "stack";
  stack.append(box);
  const layers = new Map();
  for (const arm of ARMS) {
    const img = new Image();
    img.alt = arm.arm;
    img.dataset.arm = arm.arm;
    box.append(img);
    layers.set(arm.arm, img);
  }
  return { box, layers, pick };
}

function paintStack(stack) {
  const { box, layers, pick } = stack;
  let width = 0;
  let height = 0;
  for (const arm of ARMS) {
    const img = layers.get(arm.arm);
    const file = pick(arm, state.offset);
    if (file && img.getAttribute("src") !== file) img.src = file;
    img.hidden = !file;
    /* The opacity toggle IS the flip. Nothing is added, removed or re-decoded. */
    img.classList.toggle("on", arm.arm === state.arm && Boolean(file));
    if (img.naturalWidth) {
      img.style.width = cssPx(img.naturalWidth) + "px";
      img.style.height = cssPx(img.naturalHeight) + "px";
      width = Math.max(width, cssPx(img.naturalWidth));
      height = Math.max(height, cssPx(img.naturalHeight));
    }
  }
  box.style.width = (width || cssPx(DATA.box.width)) + "px";
  box.style.height = (height || cssPx(DATA.box.height)) + "px";
}

/* Zoom around the middle of what is on screen, so zooming in does not teleport you to the corner
   of the image. Fractions, because the scrollable size changes underneath us. */
function withPreservedScroll(pane, mutate) {
  const before = {
    x: (pane.scrollLeft + pane.clientWidth / 2) / Math.max(1, pane.scrollWidth),
    y: (pane.scrollTop + pane.clientHeight / 2) / Math.max(1, pane.scrollHeight),
  };
  mutate();
  pane.scrollLeft = before.x * pane.scrollWidth - pane.clientWidth / 2;
  pane.scrollTop = before.y * pane.scrollHeight - pane.clientHeight / 2;
}

/* ---- readout -------------------------------------------------------------------------- */

const esc = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* The selected arm's own numbers, for the two views that show one arm at a time.
   Built entirely from DATA.groups[].rows[].cells -- the SAME cells the grid tables render, already
   formatted and already ranked by the node side. Nothing is recomputed here, so this panel cannot
   disagree with the table it summarises. Groups the arm is not in are skipped rather than dashed:
   the grid is where absence is enumerated, this is where one arm is described. */
function readoutHtml() {
  const arm = ARMS.find((a) => a.arm === state.arm);
  if (!arm) return "";
  let html =
    "<h3>" + esc(arm.label) + ' <span class="kind">' + esc(arm.kind) + "</span></h3>";
  if (arm.blurb) html += '<p class="blurb">' + esc(arm.blurb) + "</p>";
  if (arm.alignmentWarning) {
    html += '<p class="warn">' + esc(arm.label + " " + arm.alignmentWarning) + "</p>";
  }
  for (const group of DATA.groups) {
    if (!group.arms.includes(arm.arm)) continue;
    const withReference =
      group.id === "fidelity" && arm.arm !== "reference" && group.arms.includes("reference");
    html += "<h4>" + esc(group.title) + "</h4>";
    html += '<p class="env">' + esc(group.environment) + "</p><dl>";
    for (const row of group.rows) {
      const value = row.cells[arm.arm];
      if (value === undefined) continue;
      const best = row.best.indexOf(arm.arm) >= 0 ? ' class="best"' : "";
      const reference = withReference
        ? '<span class="ref"> / ' + esc(row.cells.reference) + "</span>"
        : "";
      html +=
        "<dt>" + esc(row.label) + "</dt><dd" + best + ">" + esc(value) + reference + "</dd>";
    }
    html += "</dl>";
    /* Directly under the group it explains, not at the end of the panel: the second column only
       appears in the fidelity group, and a legend two groups away is a legend nobody connects. */
    if (withReference) {
      html +=
        '<p class="note">Greyed second value is the reference: the same geometry at 8x, ' +
        "box-downsampled. A ceiling, not a competitor.</p>";
    }
  }
  return html;
}

/* ---- render --------------------------------------------------------------------------- */

const flip = makeStack("flip-stack", (arm, offset) => arm.stills[offset]);
const diff = makeStack("diff-stack", (arm, offset) => arm.diffs[offset]);

function render() {
  for (const view of ["grid", "flip", "diff"]) {
    $("view-" + view).hidden = state.view !== view;
    $("tab-" + view).setAttribute("aria-pressed", String(state.view === view));
  }
  $("arm-select").value = state.arm;
  $("offset-range").value = String(state.offset);
  $("offset-label").textContent =
    state.offset + " (dx " + OFFSETS[state.offset].toFixed(3) + " px)";
  /* The ratio is NAMED when it is not 1, because that is the case where the on-screen size stopped
     being "zoom x the still" and became "zoom device px per source pixel" -- the image gets smaller
     and the reason has to be visible, or it reads as a bug in the viewer. */
  const ratio = deviceRatio();
  $("zoom-label").textContent =
    state.zoom + "x" + (ratio === 1 ? "" : " device px @ dpr " + ratio);
  $("gain-range").value = String(state.gain);
  $("gain-label").textContent = state.gain + "x";
  $("fps-select").value = String(state.fps);
  $("play").setAttribute("aria-pressed", String(state.playing));
  $("play").textContent = state.playing ? "pause" : "play";

  /* Written BEFORE the panes are touched: the readout is a flex sibling with its own overflow, so
     it cannot resize a pane, and doing it first means the scroll fractions below are read against
     the layout the user will actually be looking at. */
  const readout = readoutHtml();
  $("flip-readout").innerHTML = readout;
  $("diff-readout").innerHTML = readout;
  /* The diff view's own alarm. A diff dominated by a translation looks exactly like a diff
     dominated by a rasterizer difference, and there is no table on screen here to check against. */
  const selected = ARMS.find((a) => a.arm === state.arm);
  const warning = selected && selected.alignmentWarning;
  $("diff-warn").hidden = !warning;
  $("diff-warn").textContent = warning ? selected.label + " " + warning : "";

  withPreservedScroll($("flip-pane"), () => paintStack(flip));
  withPreservedScroll($("diff-pane"), () => paintStack(diff));
  $("diff-stack").style.filter = "brightness(" + state.gain + ")";

  for (const arm of ARMS) {
    const img = $("grid-" + cssId(arm.arm));
    if (!img) continue;
    const file = arm.stills[state.offset];
    if (file && img.getAttribute("src") !== file) img.src = file;
    img.hidden = !file;
    if (img.naturalWidth) {
      img.style.width = cssPx(img.naturalWidth) + "px";
      img.style.height = cssPx(img.naturalHeight) + "px";
    }
  }
  writeHash();
}

const cssId = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/* ---- controls ------------------------------------------------------------------------- */

function stepArm(delta) {
  const index = ARMS.findIndex((a) => a.arm === state.arm);
  state.arm = ARMS[(index + delta + ARMS.length) % ARMS.length].arm;
  render();
}
function stepOffset(delta) {
  state.offset = (state.offset + delta + OFFSETS.length) % OFFSETS.length;
  render();
}
let timer = null;
function setPlaying(on) {
  state.playing = on;
  if (timer) clearInterval(timer);
  timer = on ? setInterval(() => stepOffset(1), 1000 / state.fps) : null;
  render();
}

$("tab-grid").onclick = () => { state.view = "grid"; render(); };
$("tab-flip").onclick = () => { state.view = "flip"; render(); };
$("tab-diff").onclick = () => { state.view = "diff"; render(); };
$("arm-select").onchange = (e) => { state.arm = e.target.value; render(); };
$("offset-range").oninput = (e) => { state.offset = Number(e.target.value); render(); };
$("gain-range").oninput = (e) => { state.gain = Number(e.target.value); render(); };
$("fps-select").onchange = (e) => { state.fps = Number(e.target.value); if (state.playing) setPlaying(true); else render(); };
$("play").onclick = () => setPlaying(!state.playing);
$("zoom-in").onclick = () => { state.zoom = clamp(state.zoom * 2, 1, 16); render(); };
$("zoom-out").onclick = () => { state.zoom = clamp(Math.floor(state.zoom / 2), 1, 16); render(); };

addEventListener("keydown", (event) => {
  if (event.target.matches("input, select, textarea")) return;
  const keys = {
    ArrowLeft: () => stepArm(-1),
    ArrowRight: () => stepArm(1),
    "[": () => stepOffset(-1),
    "]": () => stepOffset(1),
    "+": () => { state.zoom = clamp(state.zoom * 2, 1, 16); render(); },
    "=": () => { state.zoom = clamp(state.zoom * 2, 1, 16); render(); },
    "-": () => { state.zoom = clamp(Math.floor(state.zoom / 2), 1, 16); render(); },
    " ": () => setPlaying(!state.playing),
    g: () => { state.view = "grid"; render(); },
    f: () => { state.view = "flip"; render(); },
    d: () => { state.view = "diff"; render(); },
  };
  const digit = Number(event.key);
  if (digit >= 1 && digit <= ARMS.length) {
    state.arm = ARMS[digit - 1].arm;
    render();
    event.preventDefault();
    return;
  }
  const handler = keys[event.key];
  if (handler) {
    handler();
    event.preventDefault();
  }
});

buildPool();
readHash();
render();
/* Natural sizes are only known once the bytes land; re-lay-out when they do. */
addEventListener("load", render);
/* And again whenever the device pixel ratio moves under us -- browser zoom, or a drag to a monitor
   with a different scale factor. Every CSS size on the page is derived from it. */
watchDeviceRatio(render);
`;

/** The whole report as one self-contained HTML string. Images are siblings; data is inlined. */
export function renderPage(data: TextReportData): string {
  const armOptions = data.arms
    .map(
      (arm, index) =>
        `<option value="${escapeAttribute(arm.arm)}">${index + 1}. ${escapeHtml(arm.label)}</option>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>text rendering — ${escapeHtml(String(data.arms.length))} arms</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <h1>text rendering</h1>
  <div class="tabs">
    <button id="tab-grid" title="g">grid</button>
    <button id="tab-flip" title="f">flip</button>
    <button id="tab-diff" title="d">diff</button>
  </div>
  <label>arm <select id="arm-select">${armOptions}</select></label>
  <label>offset
    <input id="offset-range" type="range" min="0" max="${Math.max(0, data.offsets.length - 1)}" step="1">
    <span id="offset-label"></span>
  </label>
  <button id="play">play</button>
  <label>at <select id="fps-select"><option>2</option><option>4</option><option>8</option></select> Hz</label>
  <label>zoom <button id="zoom-out">-</button><span id="zoom-label"></span><button id="zoom-in">+</button></label>
  <label>diff gain <input id="gain-range" type="range" min="1" max="20" step="1"><span id="gain-label"></span></label>
  <div class="spacer"></div>
  <span class="hint">
    <kbd>&larr;</kbd><kbd>&rarr;</kbd> arm &middot; <kbd>[</kbd><kbd>]</kbd> offset &middot;
    <kbd>1</kbd>&hellip;<kbd>${data.arms.length}</kbd> pick &middot; <kbd>space</kbd> play &middot;
    <kbd>+</kbd><kbd>-</kbd> zoom
  </span>
</header>

<main>
${renderMissing(data)}

<div class="view" id="view-grid">
  <div class="cards">${data.arms.map(renderCard).join("\n")}</div>
  <p class="caption">
    Every image is the SAME run — ${escapeHtml(data.spec)} — at sub-pixel offset
    <span class="hint">(the offset slider moves all of them together)</span>.
    Nearest-neighbour upscaled, so what you see are the actual pixels.
  </p>
  ${data.groups.map(renderGroup).join("\n")}
</div>

<div class="view" id="view-flip" hidden>
  <div class="split">
    <div class="pane" id="flip-pane"><div id="flip-stack"></div></div>
    <aside class="readout" id="flip-readout"></aside>
  </div>
  <p class="caption">
    One arm at a time, in place. Arms are stacked and toggled by opacity — nothing is re-decoded, so
    the switch is instantaneous and the pixels line up exactly. Press <kbd>space</kbd> to cycle the
    eight sub-pixel offsets: an arm whose glyph edges boil while it translates is one that will
    crawl on screen. That is what <code>edgeShimmer</code> counts.
  </p>
</div>

<div class="view" id="view-diff" hidden>
  <p class="warn" id="diff-warn" hidden></p>
  <div class="split">
    <div class="pane" id="diff-pane"><div id="diff-stack"></div></div>
    <aside class="readout" id="diff-readout"></aside>
  </div>
  <p class="caption">
    |arm &minus; reference| at the SAME offset, written unamplified and brightened live by the gain
    slider. The reference is the same geometry drawn at 8&times; and box-downsampled, i.e. correct
    area coverage — so black is agreement and every visible pixel is a departure from it.
    <strong>Check <code>alignment px</code> first:</strong> the subtraction is literal, never
    best-fit, so an arm that draws in the wrong place renders its own displacement here as glyph
    outlines. A diff that can shift an arm is a diff that can flatter one.
    <strong>Read the Godot rows as hinting, not blur:</strong> a different rasterizer disagrees about
    stem darkening long before it disagrees about sharpness, which is why their
    <code>rmsVsReference</code> is reported as &mdash; rather than as a score.
  </p>
</div>
</main>

<div class="pool" id="pool" aria-hidden="true"></div>
<script type="application/json" id="report-data">${escapeJson(data)}</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}

function renderMissing(data: TextReportData): string {
  if (data.missing.length === 0) {
    return "";
  }
  const items = data.missing
    .map(
      (entry) =>
        `<li>${escapeHtml(entry.what)}<br><code>${escapeHtml(entry.command)}</code></li>`,
    )
    .join("");
  return `<div class="missing">
  <h2>not measured — ${data.missing.length} input${data.missing.length === 1 ? "" : "s"} absent</h2>
  <ul>${items}</ul>
  <p class="note">Absent means NOT MEASURED. Those rows are omitted rather than shown as zero.</p>
</div>`;
}

function renderCard(arm: TextReportData["arms"][number]): string {
  const stats = arm.headline
    .map(
      (entry) =>
        `<dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.value)}</dd>`,
    )
    .join("");
  return `<div class="card">
  <h2>${escapeHtml(arm.label)} <span class="kind">${escapeHtml(arm.kind)}</span></h2>
  <figure><img id="grid-${cssId(arm.arm)}" alt="${escapeAttribute(arm.arm)}"></figure>
  <p class="blurb">${escapeHtml(arm.blurb)}</p>
  <dl>${stats}</dl>
</div>`;
}

function renderGroup(group: TextReportData["groups"][number]): string {
  const arms = group.arms;
  const head = arms.map((arm) => `<th>${escapeHtml(arm)}</th>`).join("");
  const body = group.rows
    .map((row) => {
      const cells = arms
        .map((arm) => {
          const value = row.cells[arm] ?? "—";
          const best = row.best.includes(arm) ? ' class="best"' : "";
          return `<td${best}>${escapeHtml(value)}</td>`;
        })
        .join("");
      const hint = row.hint
        ? ` <span class="hint">${escapeHtml(row.hint)}</span>`
        : "";
      return `<tr><th>${escapeHtml(row.label)}${hint}</th>${cells}</tr>`;
    })
    .join("\n");
  const notes = group.notes
    .map((note) => `<p class="note">${escapeHtml(note)}</p>`)
    .join("");
  return `<section class="group">
  <h2>${escapeHtml(group.title)}</h2>
  <p class="env">${escapeHtml(group.environment)}</p>
  <table><thead><tr><th>metric</th>${head}</tr></thead><tbody>${body}</tbody></table>
  ${notes}
</section>`;
}

const cssId = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Inline the data rather than `fetch("data.json")`.
 *
 * The report is meant to be opened straight off disk, and a `file://` page cannot fetch its own
 * siblings — the request is treated as cross-origin and fails. `<img src>` is not, which is why the
 * PNGs stay siblings while the numbers come inline. `<` is escaped so a string in the data can
 * never close the script element.
 */
function escapeJson(data: TextReportData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
