// @vitest-environment node
//
// NODE, not the repo-default jsdom: esbuild refuses to run under jsdom's globals, and the DOM under
// test is a real Chromium's anyway. Same reason `canvasPixelXvfb.test.ts` states.
//
// THE GUARD ON THE FIDDLIEST PART OF THIS PACKAGE: blob -> RGBA16I upload -> draw.
//
// Everything else here has a cheap failure mode. If the encoder is wrong the blob is empty; if the
// program does not link it throws; if the atlas is too small the allocator says so. The upload is
// the one step that fails QUIETLY and PLAUSIBLY, because it is four independent pieces of
// arithmetic over the same bytes:
//
//   byte order    `gl.SHORT` reads the encoder's little-endian int16s verbatim; a hand-built
//                 Int16Array would be one endianness assumption away from swapping every coordinate
//   stride        8 bytes per RGBA16I texel, and `srcOffset` counts ELEMENTS, not texels or bytes
//   row wrap      a 1-D stream into a 4096-wide texture: a blob generally starts mid-row and spans
//                 several, and `texSubImage2D` can only write rectangles
//   texel offset  `glyphLoc` is an absolute index and every other offset in the format is relative
//                 to it
//
// Get any of them wrong and the shader still runs, still finds numbers where curves should be, and
// still produces smooth antialiased ink. NOTHING ELSE IN THIS ROUND WOULD CATCH THAT — the perf
// table would report a cheap arm and the fidelity probe would report a crisp one.
//
// WHAT IS SAMPLED. `gl.readPixels` on the stage's own drawing buffer, which holds PREMULTIPLIED
// bytes by the package's contract, in the same task as the draw (the stage is
// `preserveDrawingBuffer: false`). Never `getImageData` on a 2D canvas — alpha 0 on this rung.
//
// WINDOWLESS, ON THE REAL ADAPTER. Every case here is a claim about a GPU evaluating outlines per
// fragment, so the surface has to be a GPU — and it used to cost a window to get one. Measured on
// this box with `WEBGL_debug_renderer_info`, everything else held constant:
//
//   launch                                     unmasked renderer              window
//   ----------------------------------------   ----------------------------   ------
//   headed, default ozone                      ANGLE NVIDIA RTX 2060 (GL)     YES
//   headed, --ozone-platform=x11               SwiftShader                    no
//   --headless=new --enable-gpu
//     --use-angle=vulkan                       ANGLE NVIDIA RTX 2060 Vulkan   no
//
// The middle row is why this file was headed: OLD headless fell back to software here, and the arm's
// whole premise is a GPU. `--headless=new` with ANGLE pointed at Vulkan keeps the adapter and drops
// the window. That matters because Xvfb does NOT contain a headed Chromium on this Wayland box — its
// Ozone layer reaches the session compositor — so "headed" means a window on whoever's desktop is
// running the suite, not a window in a virtual display.
//
// PLAYWRIGHT'S `headless` STAYS `false` while `--headless=new` does the work. `headless: true` makes
// Playwright inject its own old-headless switches, which is the SwiftShader row.
//
// `GSW_PIXEL_HEADED=1` restores the headed launch, for cross-checking one surface against the other.
// IT OPENS A REAL WINDOW ON THE USER'S DESKTOP — use it only with their consent.
//
// AND THE ADAPTER IS ASSERTED RATHER THAN MERELY LOGGED (`assertHardwareRenderer`). A silent fall
// back to SwiftShader fails nothing here — the software column used to agree with the hardware one
// to 0.03 RMS — it just recalibrates every budget in this file to a software rasteriser.
//
// WHICH SURFACE EACH NUMBER BELOW CAME FROM, because a suite that changes its own surface owes a
// reader that. Everything in this file was re-read on headless ANGLE/Vulkan when that became the
// default, and every row still current with the shader came back BYTE-IDENTICAL to the headed
// ANGLE/GL reading it replaced: the RMS/registration table, the low-ppem rim table, the Godot reach,
// ramp and scallop tables, and the contrast block's ink and deep-end ratios. The three paragraphs
// that DID move (`SPREAD_TOLERANCE_PX`, the thin case's rim, `LOWPPEM_MSAA_DIFF_RMS_BUDGET`) each
// carry a row measured before a shader change that nobody re-read afterwards; each says so, and
// none of them is attributed to the surface. The headed ANGLE/GL arm was NOT re-run for a live A/B
// — it opens a window on the user's desktop — and `--use-angle=gl` under `--headless=new` is not a
// substitute: it yields no WebGL2 context at all on this box.
//
// AND EVERY ROW LABELLED `6/13/19/26` IS ON THAT SAME HEADLESS ANGLE/VULKAN SURFACE, measured
// against the `4 x 16` row beside it in the same session, one shader change apart — the dilation's
// 64-tap budget split in proportion to ring radius rather than equally. Those pairs are a SHADER
// A/B and nothing else moved between them; both readings reproduce to the digit across runs.
//
// FLAGS: `--use-angle=vulkan` IS NOT `--enable-features=Vulkan`, which is still not passed.
// `webglCompositeXvfb.test.ts` measures that one moving Chrome's whole GPU stack and blanking
// `drawImage(glCanvas)` on this driver; the same table records `gl.readPixels` returning the right
// bytes underneath it, and readPixels is the only thing this file samples. `--use-angle=vulkan`
// picks ANGLE's backing API and nothing else.
//
// NOT PART OF ANY DEFAULT RUN, and it used to be. `DISPLAY` alone was the gate, and it only stayed
// out of `pnpm test` by accident: the encoder lived in gitignored `dist/`, so the file-exists check
// below skipped the suite before it could launch anything. Vendoring the wasm removed that accident
// — on any box with a display, `pnpm test` would now launch a Chromium and sit on 120-180 s
// timeouts. So it is gated on `GSW_HB_GPU_PIXEL` too, the way `canvasUploadBenchXvfb.test.ts` is
// gated on `GSW_CANVAS_UPLOAD_BENCH`. `pnpm test:glyph-pixel` sets it; the script's `xvfb-run -a` is
// no longer containment — the default launch needs no display at all — it is there to keep `DISPLAY`
// set for that gate and to give the headed escape hatch somewhere to go.
// `vendor.test.ts` is the part of this package's guard that a default run still gets.
//
// SKIPPED, NOT FAILED, when `vendor/hb-gpu.mjs` is absent. It should never be — `vendor/` is
// committed — but a red suite that means "your checkout is incomplete" trains people to ignore a
// red suite.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acutanceOf,
  registrationPx,
  rms,
} from "../../../scripts/test-support/text-image-metrics";
import { subtractBackground } from "../../perf-harness/probes/text-fidelity";
// TYPE-ONLY: the entry writes to `window` at module scope, so a value import would run the page
// half inside vitest's node process.
import type {
  ContrastProbeResult,
  GlyphCaseResult,
  GodotOutlineProbeResult,
  SpreadProbeResult,
} from "./browser-entry";
// A VALUE import, and allowed to be: `./geometry` is the shared case list with nothing else in
// it, precisely so both halves can read the same numbers without dragging the page module in.
import {
  GLYPH_CASES,
  type GlyphCase,
  GODOT_OUTLINE_CASES,
  type GodotOutlineCase,
  modelFor,
  SPREAD_LOWPPEM_CASE,
  SPREAD_THIN_CASE,
} from "./geometry";
// Also a value import, and also pure: `./outline-metrics` has no imports at all, precisely so the
// Godot generator and this file compute the columns of one table the same way.
import {
  displacementVsWidth,
  measureOutline,
  type OutlineMetrics,
  RADIAL_RECONSTRUCTION_1090_PX,
  type RadialOutlineMetrics,
} from "./outline-metrics";
import { rasterizeReference } from "./reference";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const glueFile = join(here, "..", "vendor", "hb-gpu.mjs");
const wasmFile = join(here, "..", "vendor", "hb-gpu.wasm");
const fontFile = join(
  repoRoot,
  "fixtures",
  "assets",
  "fonts",
  "noto-sans-sc",
  "NotoSansSC-bench.ttf",
);
/** The committed Godot reference. Absent is a FAILURE — see the `godot outline` block. */
const goldenFile = join(here, "goldens", "godot-outline-metrics.json");

/**
 * Per-pixel RMS budget, in byte levels over the whole 96x96 frame.
 *
 * CALIBRATED BY BREAKING THE UPLOAD ON PURPOSE, four ways, and reading all three columns off each
 * run. Every number below is measured on this box; the correct row is quoted from BOTH drivers,
 * which agree to 0.03:
 *
 * | upload                        | ink (upright28) | registration px | rms 14 / 28 / rot |
 * | ----------------------------- | --------------- | --------------- | ----------------- |
 * | correct, NVIDIA ANGLE         | 18892           | 0.036           | 1.62 / 2.22 / 2.42 |
 * | correct, SwiftShader          | 18547           | 0.010           | 1.63 / 2.21 / 2.45 |
 * | int16 byte pair swapped       | **0**           | 9.631 (limit)   | 6.74 / 17.18 / 17.77 |
 * | `srcOffset` in bytes          | **0**           | 9.631 (limit)   | 6.74 / 17.18 / 17.77 |
 * | row wrap dropped (`x = 0`)    | **0**           | 9.631 (limit)   | 6.74 / 17.18 / 17.77 |
 * | `glyphLoc` off by one texel   | 1210            | 1.646           | 6.70 / 17.08 / 17.73 |
 *
 * (the reference reads 18443, so the correct row is within 2.4%.)
 *
 * THE `correct, NVIDIA ANGLE` ROW WAS FIRST READ HEADED ON ANGLE/GL AND IS REPRODUCED HERE DIGIT FOR
 * DIGIT ON HEADLESS ANGLE/VULKAN, this file's surface since. Two drivers and two ANGLE backends now
 * agree on it, which is more than this budget needs. The four fault rows have not been re-read and do
 * not need to be: they are a blank frame and a one-texel offset, not a rounding mode.
 *
 * 6 sits 2.4x above the worst correct reading and just under the cheapest failure.
 *
 * AND RMS IS THE WEAKEST OF THE THREE COLUMNS, which the table says plainly and which is worth
 * knowing before anyone leans on it. At 14 px a COMPLETELY destroyed glyph reads 6.74 — because a
 * blank 96x96 frame differs from a mostly-blank reference by very little. What actually catches
 * these faults is the ink guard (4482 against 0) and then registration. RMS is here for the
 * corruption that keeps the ink and moves it, not as the primary signal.
 */
const RMS_BUDGET = 6;

/**
 * How far the drawn glyph may sit from where the reference puts it.
 *
 * The fidelity probe's own `ALIGNMENT_TOLERANCE_PX`, and the same number for the same reason: the
 * correlation estimator's measured noise floor is ~0.1 px worst case, and the smallest real
 * placement bug the round has found was 0.51 px. Restated as a literal rather than imported so
 * that a change to the probe's allowance — calibrated for arms compared over a whole text band —
 * cannot silently loosen a single-glyph geometry check.
 *
 * MEASURED HERE: 0.010-0.036 px at 28 px on both drivers, 0.120-0.122 at 14 px. The 14 px reading
 * is systematic rather than noisy (the two drivers agree to 0.002), and it is the size at which
 * `_hb_gpu_slug` averages five taps a third of a pixel apart — so a small bias against an
 * exact-area reference is expected there and is still inside half the budget. A one-texel
 * `glyphLoc` error reads 1.646.
 */
const REGISTRATION_BUDGET_PX = 0.25;

/**
 * Slack, in px, on either side of the spread when asking where the dilation reaches.
 *
 * TWO SEPARATE THINGS LIVE IN THIS ONE NUMBER, and both are sub-pixel. The disk is sampled as
 * concentric rings, so the reachable set falls short of a true disk by the outermost ring's sagitta
 * — `r * (1 - cos(pi / steps))`, which is 0.029 px at r = 4, where that ring now runs 26 steps
 * (`SPREAD_OUTER_RING_STEPS`). It was 0.077 px when every ring was clamped to 16 and this paragraph
 * quoted 0.08. And the coverage a tap reports is antialiased, so the boundary between "reached" and
 * "not reached" is a ramp about a pixel wide rather than a step.
 *
 * MEASURED at spread 4 (glyph "L", 96 px/em, 128 px buffer), and the box row has moved by one pixel
 * on one edge since it was first read:
 *
 * | reading                                     | box growth L/T/R/B | short of solid | smear peak |
 * | ------------------------------------------- | ------------------ | -------------- | ---------- |
 * | headed ANGLE/GL, coverage-max dilation      | 4 / 4 / 4 / 4      | 0 of 730       | alpha 0    |
 * | headless ANGLE/Vulkan, INSIDE taps, 4x16    | **5** / 4 / 4 / 4  | 0 of 730       | alpha 0    |
 * | headless ANGLE/Vulkan, INSIDE taps, radial  | **5** / 4 / 4 / 4  | 0 of 730       | alpha 0    |
 *
 * THE THIRD ROW IS THE TAP REDISTRIBUTION AND IT DID NOT MOVE ANY OF THE THREE COLUMNS, which is the
 * claim that matters most about it: giving the outermost ring 26 steps instead of 16 changes where
 * the boundary is BETWEEN the taps and must not change where it is at them. This case draws an "L"
 * at spread 4, so at that radius the outer ring's arc goes 1.57 px to 0.97 px — and the ink box is
 * identical to the byte.
 *
 * NOT ATTRIBUTED TO THE SURFACE. The old row was written with the original coverage-max dilation and
 * was never re-read when `HB_GPU_SPREAD_INSIDE_LOW` made each tap an INSIDE test — which is exactly
 * the change that makes the dilated boundary very nearly binary, and `boxOf(atLeast(…, 128))` is a
 * threshold at the middle of that boundary. One pixel of a one-pixel-wide ramp crossing 128 is what
 * this constant's second paragraph already budgets for. The two columns that would show a DRIVER
 * disagreement — the reachable set and the smear peak — are still exact on both surfaces.
 *
 * 1.5 px therefore stays where it is, and it is still not a fitted threshold: the sagitta is 0.029 px,
 * the antialiased boundary is about a pixel wide, the worst reading is 1.0, and the failure it
 * guards (a clamped band smeared over the whole quad) is many pixels wide, not one.
 */
const SPREAD_TOLERANCE_PX = 1.5;

/**
 * Per-channel byte slack for the spread cases, and `canvasGlyphPixelXvfb.test.ts`'s number for its
 * reason: blending happens in the framebuffer's 8-bit UNORM and the fragment quantises once on the
 * way in, so an exact equality would be asserting a rounding mode rather than the arithmetic.
 *
 * Every failure these cases exist for is tens to hundreds of levels wide — a missing outline is
 * 255, a smear is 255, a doubly composited half-alpha is 64 — so nothing is being tuned here.
 */
const TOLERANCE_LEVELS = 3;

/**
 * RMS budget for the low-ppem outline's RIM, against an 8x reference grown by the same radius.
 *
 * THE ONLY ASSERTION IN THIS FILE THAT ENTERS `_hb_gpu_slug`'s `ppem < 16` BRANCH ON THE OUTLINE
 * PATH. Measured on this box, RTX 2060 / ANGLE, 中 at 14 px per em rotated 10 degrees, spread 3,
 * over the 62 pixels the grown reference reports as partially covered:
 *
 * | dilation taps                       | rim rms | worst rim | interior short | ink vs ideal |
 * | ----------------------------------- | ------- | --------- | -------------- | ------------ |
 * | raw taps, MSAA dropped (WAS)        | 77.89   | 162       | 38.5%          | 0.622        |
 * | raw taps, MSAA mirrored in the tap  | 85.12   | 168       | ~40%           | 0.520        |
 * | sharpened taps, 4 rings x 16 steps  | 75.66   | 156       | 6.1%           | 0.988        |
 * | **sharpened taps, 6/13/19/26**      | 71.67   | 158       | **7.1%**       | **0.966**    |
 *
 * THE LAST ROW IS THE TAP REDISTRIBUTION SEEN FROM THE OTHER REGIME, and it is a wash rather than a
 * win — which is what the mechanism predicts. The radius here is under 3 device px, so the outer
 * ring was never the binding constraint: it gains three steps (16 -> 19) and every ring moves to a
 * golden-angle phase, so the tap set is DIFFERENT rather than denser. Ink and interior move a point
 * in one direction, the rim four levels in the other, and none of it is the shallow-coverage defect
 * this fixture exists for. Both remain inside budgets set an order of magnitude away from them.
 *
 * THE ROW THAT MATTERED IS THE INTERIOR'S THIRD ONE, and it is what this fixture existed to record.
 * A `max` over RAW coverage taps cannot return more than the peak coverage near the fragment, and
 * at ppem 14 a Han stroke peaks at 0.42 — so the dilation came out a translucent mottle at 62% of
 * the ideal grown shape's ink, with the pixels the reference calls solid 38.5% short of it.
 * Sharpening each tap before the max (`HB_GPU_SPREAD_INSIDE_LOW`) makes the taps an INSIDE test
 * rather than a coverage sample, which is what the union of disks they approximate actually is.
 *
 * 110 IS STILL A LOOSE BUDGET AND STAYS ONE. The rim is the half the sharpening did NOT set out to
 * move, and it moved 3% — the discriminating assertions at this size are the ink ratio and the
 * interior shortfall beside it, which went from "the shape is barely there" to within 3.4% and
 * 7.1% of ground truth. A rim budget tight enough to be interesting here would be a budget on a
 * driver's coverage estimator.
 */
const LOWPPEM_RIM_RMS_BUDGET = 110;

/**
 * How much of the grown reference's SOLID interior the low-ppem outline may be missing.
 *
 * THE NUMBER THE MOTTLE LIVED IN, AND THE ONE THAT NOW PINS IT SHUT. Raw coverage taps read 38.5%;
 * sharpened taps read 6.1%, and 7.1% once the tap budget was redistributed across the rings. 15%
 * sits between those and the defect with room on both sides: far enough above 7.1 to survive a
 * driver's coverage estimator and a reshuffle of which taps run, and less than half of what the
 * defect measured, so a revert to a max of raw taps cannot pass.
 *
 * NOT A WORST-PIXEL BUDGET, deliberately. The worst interior pixel is 100 levels short even now,
 * because a 14 px glyph's own antialiasing puts a couple of near-boundary pixels inside what the
 * grown reference calls solid. Asserting on the worst one would be asserting about those two.
 */
const LOWPPEM_INTERIOR_SHORTFALL_BUDGET = 0.15;

/**
 * RMS budget for the SPARSE-COVERING case's rim: the full stop at a spread of 12 px, 96 px per em.
 *
 * A DIFFERENT FAILURE FROM THE ONE ABOVE, and the reason it has its own number rather than reusing
 * that one. At 96 px per em every tap can return coverage 1, so nothing here is limited by shallow
 * coverage; what IS limited is the tap SET — and specifically its ARRANGEMENT, since the ceiling of
 * 65 taps a fragment may spend has not moved through any of the readings below.
 *
 * MEASURED HERE FIRST, THEN BUDGETED. On this box, RTX 2060, over the 112 pixels the grown reference
 * calls partially covered:
 *
 * | reading                                       | rim rms | worst rim | ink ratio |
 * | --------------------------------------------- | ------- | --------- | --------- |
 * | headed ANGLE/GL, when this budget was set      | 80.90   | 203       | 0.965     |
 * | headless ANGLE/Vulkan, 4 rings x 16 steps      | 79.10   | 199       | 0.987     |
 * | **headless ANGLE/Vulkan, 6/13/19/26 (current)**| **52.26** | **137** | 1.012     |
 *
 * THE FIRST ROW WAS ALREADY SUPERSEDED BEFORE THE SURFACE MOVED, and the file said so in two places:
 * 79.10 was quoted in the case body below, measured on the headed surface a commit later, and it is
 * what the headless surface reproduced to the digit. So that 1.8-level delta was a shader change
 * nobody carried back into this paragraph, not a driver.
 *
 * THE THIRD ROW IS THE ONE THIS FIXTURE EXISTED TO PRODUCE. Every ring used to be clamped to the
 * same 16 steps, so at radius 12 the OUTERMOST ring — the only one that decides where the boundary
 * lands — had 4.71 px of arc between its taps while ring 1 sampled a 4.7 px circle with the same 16.
 * The budget is now split in proportion to ring radius (6/13/19/26 at four rings, the same 64), the
 * outer arc is 2.90 px, and the rim falls a third. The other two columns moved with it: the interior
 * shortfall this scallop used to cut is now exactly 0 (see THIN_INTERIOR_SHORTFALL_BUDGET) and the
 * ink ratio crossed 1.0 from below.
 *
 * 65 IS THE MEASURED VALUE PLUS A QUARTER, the same headroom `GODOT_SCALLOP_BUDGET_PX` carries, and
 * it is chosen to be a budget the OLD ALLOCATION FAILS: 79.10 is 22% above it. That is the point of
 * tightening it here rather than leaving 110 — a tap set that goes back to spending its budget
 * equally across rings now fails this line, and that failure was reproduced by reverting the shader
 * before this budget was written down.
 */
const THIN_RIM_RMS_BUDGET = 65;

/**
 * How much of the grown reference's SOLID interior the arm may be missing, as a fraction of its ink.
 *
 * | reading                                        | shortfall / 752 interior px | as a fraction |
 * | ---------------------------------------------- | --------------------------- | ------------- |
 * | headed ANGLE/GL, when this budget was set       | 1506 levels                 | 0.0078        |
 * | headless ANGLE/Vulkan, 4 rings x 16 steps       | 213 levels                  | 0.0011        |
 * | **headless ANGLE/Vulkan, 6/13/19/26 (current)** | **0 levels**                | **0**         |
 *
 * The first two readings say the same thing about the shape — a scalloped boundary cutting one pixel
 * into the reference's interior here and there, not a translucent middle — and the second is the
 * same re-read as `THIN_RIM_RMS_BUDGET`'s, whose rim column reproduced the headed value to the
 * digit. That move is therefore a superseded paragraph, not a driver.
 *
 * THE THIRD IS EXACTLY ZERO, AND IT IS THE SAME FINDING AS THE RIM'S. There is nothing left for the
 * boundary to cut into the interior with once the outermost ring's arc gaps close from 4.71 px to
 * 2.90; the worst interior pixel goes 162 levels short to 0.
 *
 * 0.03 STAYS ANYWAY, and stays chosen against the FAILURE rather than against the reading: it is
 * small enough that a tap set which genuinely lost the interior — the low-ppem case's failure, which
 * reads 0.30 on its own geometry — could not pass it. Tightening it onto an exact zero would be a
 * budget on which pixel a driver's coverage estimator rounds up, and the rim RMS beside it is where
 * this fixture's scallop claim is actually pinned.
 */
const THIN_INTERIOR_SHORTFALL_BUDGET = 0.03;

/**
 * How far dropping the dilation tap's MSAA may move the outline, RMS over the pixels that move.
 *
 * MEASURED on the same case, and this paragraph's first row is from BEFORE the taps became an
 * INSIDE test — its ink columns are the giveaway, being the mottle's own 0.62 of the ideal:
 *
 * | reading                                          | differing px | rms  | worst | ink without / with |
 * | ------------------------------------------------ | ------------ | ---- | ----- | ------------------ |
 * | headed ANGLE/GL, raw coverage taps               | 267          | 33.4 | 85    | 30192 / 36102      |
 * | headless ANGLE/Vulkan, INSIDE-test taps, 4x16    | 166          | 31.2 | 83    | 57370 / 54619      |
 * | **headless ANGLE/Vulkan, 6/13/19/26 (current)**  | 172          | 29.8 | 78    | 56134 / 53831      |
 *
 * (the ideal grown shape is 58081 in all three.) NOT A SURFACE EFFECT: the sharpening moved both
 * variants from a translucent mottle to a solid silhouette, which is most of what changed between
 * the first two. The difference is still spread across the blob's interior rather than confined to
 * its rim, and the MSAA variant is still the dimmer of the two.
 *
 * THE THIRD ROW IS THE TAP REDISTRIBUTION, and it is the reading this budget was always going to
 * have to survive: the statistic is a difference between two tap SETS, so any change to which taps
 * run moves it by construction. It moved 1.4 levels, toward zero, on 6 more pixels.
 *
 * 45 is the OLDEST measured value plus a third, and it stays there rather than being re-derived onto
 * 29.8. Re-deriving would ratchet a budget downward on every reading that happened to come in low,
 * and this one landed 34% below the budget rather than near it. It is not there to bless the trade —
 * 30 levels of 255 is a real difference and the images are in `docs/perf-harness.md` — it is there
 * so that a future change which makes the two variants diverge WILDLY (a tap set that stops sampling
 * the disk, a ppem that starts being computed differently) fails here rather than in a consumer's
 * screenshot.
 */
const LOWPPEM_MSAA_DIFF_RMS_BUDGET = 45;

/**
 * How far this package's dilation may reach from where GODOT's outline reaches, px.
 *
 * MEASURED ON THE THREE ROUND CASES, RTX 2060 / ANGLE, against the committed 4.5.1 golden:
 *
 * | case                | ppem | radius | godot r50 | ours, 4x16 | ours, 6/13/19/26 | delta  |
 * | ------------------- | ---- | ------ | --------- | ---------- | ---------------- | ------ |
 * | dot-radial          | 49   | 4      | 6.041     | 6.254      | 6.282            | +0.241 |
 * | dot-radial-wide     | 96   | 12     | 16.059    | 15.935     | 16.143           | +0.084 |
 * | dot-radial-live-max | 96   | 14     | 18.066    | ---        | 18.140           | +0.074 |
 *
 * THE r = 14 ROW IS THE LIVE WORST CASE (see `GODOT_OUTLINE_CASES`) and it is the tightest
 * agreement of the three: +0.074 px, a seventh of this budget. It has no `4 x 16` column because
 * the fixture postdates that allocation — no shader was reverted to produce it.
 *
 * BOTH MOVED OUTWARD WHEN THE TAP BUDGET WAS REDISTRIBUTED, AND THE SIGN IS THE EXPECTED ONE. `r50`
 * is a MEAN over 256 rays, and the defect the redistribution removed was a boundary that dipped
 * INWARD between the outermost ring's taps — closing those dips raises the mean without moving the
 * reach in the tap directions, which is why `dot-radial-wide` gains 0.21 px of mean while its wobble
 * halves. It also crosses Godot's own reach from below rather than overshooting it: the disagreement
 * is now +0.084 px where it was -0.124.
 *
 * 0.5 IS TWICE THE WORST OF THOSE AND A FIFTH OF THE CHEAPEST REAL FAULT. The thing this guards is
 * the identity `u_spreadPx = outline_size / 4`, and the failure modes are whole steps: reading the
 * divisor as 3 or 5 moves `dot-radial-wide` by 4 px and 2.4 px. Anything between 0.5 and 2 px is
 * not a wrong divisor, it is a rim, and the rim has its own budgets below.
 *
 * IT ALSO RE-DERIVES THE DIVISOR FROM PIXELS ON BOTH SIDES. The dot's own radius is 1.98 px at ppem
 * 49 and 3.89 at ppem 96, so the reaches predicted by `radius + outline_size / 4` are 5.98, 15.89
 * and 17.89 — and Godot came back 6.041, 16.059 and 18.066, this package 6.282, 16.143 and 18.140.
 * Two engines and an arithmetic prediction inside a third of a pixel of each other, now at three
 * radii spanning the whole range the product asks for.
 */
const GODOT_REACH_BUDGET_PX = 0.5;

/**
 * How much SOFTER than Godot's rim this package's may be, px of equivalent linear ramp.
 *
 * THE MEASURED SIGN IS THE OPPOSITE OF THE ONE THIS ROUND WENT LOOKING FOR, and that is the most
 * useful thing this fixture has said. On the graded column — `HB_GPU_CONTRAST_NONE`, the only one
 * that was ever comparable with Godot, which applies no curve to its outline — every case is
 * SHARPER than Godot, and the two shipping columns now ARE that column, byte for byte:
 *
 * | case                | ppem | godot | ours, 4x16 | ours, 6/13/19/26 | delta  | default white | default black |
 * | ------------------- | ---- | ----- | ---------- | ---------------- | ------ | ------------- | ------------- |
 * | han-desktop         | 14   | 0.851 | 0.662      | 0.390            | -0.461 | 0.390         | 0.390         |
 * | han-phone           | 49   | 1.077 | 0.851      | 0.678            | -0.399 | 0.678         | 0.678         |
 * | latin-desktop       | 20   | 1.043 | 0.216      | 0.156            | -0.887 | 0.156         | 0.156         |
 * | dot-radial          | 49   | 1.091 | 0.518      | 0.430            | -0.661 | 0.430         | 0.430         |
 * | dot-radial-wide     | 96   | 0.938 | 0.475      | **0.000**        | -0.938 | 0.000         | 0.000         |
 * | dot-radial-live-max | 96   | 0.933 | ---        | **0.000**        | -0.933 | 0.000         | 0.000         |
 *
 * The r = 14 row lands on the same metric floor as r = 12 and for the same reason — its raw 10-90
 * width is 1.288 px against the sampler's own 1.05, so the quadrature subtraction clamps. The
 * gradient form on that frame, which shares none of that arithmetic, reads **0.248** px against
 * Godot's 0.994, so the rim is sharper still than the r = 12 row's 0.304 rather than merely
 * unresolvable. Both are now printed by the block's own table (`gradient ramp`) rather than taken
 * from a one-off probe.
 *
 * The dilation's taps have been an INSIDE test since `HB_GPU_SPREAD_INSIDE_LOW` — `smoothstep(0,
 * 0.5, cov)` before the max — so the dilated boundary is very nearly binary, which is a HARDER
 * edge than Godot's area coverage rather than a softer one. Whatever the consumer is seeing as
 * blur, this column says it is not the uncorrected dilation.
 *
 * REDISTRIBUTING THE TAP BUDGET MADE EVERY ROW SHARPER STILL, and the last one hit this metric's
 * floor. Part of what the old column read as "rim" was a boundary in a slightly different place on
 * each ray, which a 10-90 width taken along rays cannot tell from a soft one; closing the outermost
 * ring's arc gaps takes that out. `dot-radial-wide`'s raw 10-90 width is 1.035 px against the
 * radial form's own sampler contribution of `RADIAL_RECONSTRUCTION_1090_PX` = 1.05, so the
 * quadrature subtraction clamps at 0: the boundary is now measured as sharper than the rays can
 * resolve, which is a statement about the METRIC's floor and not about a zero-width rim. The
 * gradient form on the same frame, which shares none of that arithmetic, reads 0.304 px.
 *
 * WHAT CHANGED THE RIGHT-HAND COLUMNS: the fragment shader now gates stem darkening on the FILL
 * pass, so a dilated draw emits raw coverage. Before that, this is what the consumer's own frame
 * measured — the same rows, and the reason this table used to have five different numbers in it:
 *
 * | case            | ppem | ours (none) | default white | default black | white vs none | black vs none |
 * | --------------- | ---- | ----------- | ------------- | ------------- | ------------- | ------------- |
 * | han-desktop     | 14   | 0.662       | **1.965**     | 0.518         | 31 lv / 144px | 30 lv / 146px |
 * | han-phone       | 49   | 0.851       | 0.851         | 0.851         | 0             | 0             |
 * | latin-desktop   | 20   | 0.216       | 0.216         | 0.196         | 26 lv / 14 px | 25 lv / 12 px |
 * | dot-radial      | 49   | 0.518       | 0.518         | 0.518         | 0             | 0             |
 * | dot-radial-wide | 96   | 0.475       | 0.475         | 0.475         | 0             | 0             |
 *
 * It localised precisely: the columns were already identical at ppem 49 and 96 because
 * `smoothstep(8, 48, ppem)` had taken the correction to exactly 1 there, and differed only at ppem
 * 14 and 20 — the desktop cases, i.e. the sizes the consumer's own labels are drawn at. At
 * han-desktop, white read 1.965 px against the uncorrected 0.662: the shipped curve TRIPLED the rim
 * of a dilated frame while the graded column said the dilation was sharper than the engine's.
 *
 * 0.5 IS AN UPPER BOUND ONLY, AND STAYS ONE. The worst measured delta is now -0.399, so this carries
 * 0.9 px of headroom and fails any change that makes the rim half a pixel softer than the engine
 * being mirrored. The lower side is deliberately unbounded: the sign is the finding, not the target,
 * and there is nothing to tighten onto now that one case reads exactly 0 against a metric floor. The
 * number that pins this direction on `dot-radial-wide` is the scallop pair below, which is measured
 * on the same rays and has not run out of resolution.
 */
const GODOT_RAMP_BUDGET_PX = 0.5;

/**
 * How much the dilated boundary may wobble with angle, px, against Godot's own at the same radius.
 *
 * MEASURED ON BOTH ALLOCATIONS OF THE SAME 64-TAP BUDGET, headless ANGLE/Vulkan, RTX 2060:
 *
 * | case                | radius | godot  | 4 x 16 | 6/13/19/26 |
 * | ------------------- | ------ | ------ | ------ | ---------- |
 * | dot-radial          | 4      | 0.0833 | 0.1628 | **0.1587** | r50 stdev
 * | dot-radial-wide     | 12     | 0.1068 | 0.2813 | **0.1679** | r50 stdev
 * | dot-radial-live-max | 14     | 0.1092 | ---    | **0.1910** | r50 stdev
 * | dot-radial          | 4      | 0.0012 | 0.0057 | **0.0406** | h16
 * | dot-radial-wide     | 12     | 0.0164 | 0.3099 | **0.0512** | h16
 * | dot-radial-live-max | 14     | 0.0115 | ---    | **0.0426** | h16
 * | dot-radial          | 4      | ---    | ---    | **0.0059** | h26
 * | dot-radial-wide     | 12     | ---    | ---    | **0.0934** | h26
 * | dot-radial-live-max | 14     | ---    | ---    | **0.1506** | h26
 *
 * THE r = 14 ROWS ARE THE LIVE WORST CASE and they are the reason that fixture exists — the phone
 * asks for device radii of 10.5, 13.1 and 14.0 and this table stopped at 12. The `4 x 16` column is
 * empty there because the fixture postdates that allocation; no shader was reverted to fill it.
 *
 * THIS CONSTANT SURVIVED THAT ROW AND `GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS` DID NOT. 0.1910 is
 * under 0.21 with 9% to spare and is still 1.75x Godot's own wobble at the same radius, which is
 * the same multiple the r = 12 row carries (1.57x). Note what the middle column of the stdev rows
 * says once it is divided by the radius: 0.01399 at r = 12 against 0.01364 at r = 14 — the total
 * wobble is very nearly LINEAR in the radius, so a flat budget on it gets relatively tighter as the
 * radius grows. It is not restated here because it did not trip and 14 is the largest radius the
 * product asks for; a fixture past 14 would need the per-radius form the h26 budget now has.
 *
 * WHAT THE OLD COLUMN SAID, and it is why the fixture was built. At radius 4 the tap set still tiled
 * its own disk and the boundary was 2.0x Godot's wobble with essentially no periodic component. At
 * radius 12 it was 2.6x Godot's wobble and carried **19x** Godot's power at exactly 16 cycles per
 * revolution — the number every ring's step count was clamped to. A rough boundary can come from
 * noise, from a shallow-coverage mottle or from a driver's estimator; a boundary rough at exactly
 * the tap count can come from one place.
 *
 * WHAT THE NEW COLUMN SAYS. Splitting the same 64 taps in proportion to ring radius takes the
 * outermost ring at radius 12 from 16 steps to 26: the wobble falls 40% to 1.6x Godot's, and the
 * 16-cycle amplitude falls by a factor of SIX to 3.1x Godot's, from 19x. The residue moved where
 * the mechanism says it must — h26, the new outermost ring's own count, is now the larger of the two
 * bins on that case (0.0934 against 0.0512), which is a scallop at a 2.90 px pitch instead of a
 * 4.71 px one.
 *
 * AND ONE NUMBER WENT THE OTHER WAY: `dot-radial`'s h16 rose from 0.0057 to 0.0406 while its total
 * wobble fell. Nothing in the new tap set is 16-fold at radius 4 (the rings run 6/13/19/26 there
 * too), so this is one DFT bin of a boundary whose total roughness went DOWN by 0.004 px picking up
 * a twenty-fifth of a pixel of a non-periodic profile's leakage. It is reported rather than
 * explained away, and it is why the two harmonic budgets carry more headroom than the stdev one.
 *
 * 0.21 IS THE MEASURED WORST PLUS A QUARTER, and it is set where the OLD allocation fails it:
 * `dot-radial-wide` read 0.2813, 34% above this line. The harmonics take the measured worst plus a
 * HALF instead — a single DFT bin has just been observed moving 7x under a change that lowered the
 * quantity it is a component of, so it is the less stable statistic of the two and is budgeted as
 * one. All three were proven able to fail by reverting the shader to the clamped 16-step loop; the
 * h26 one has since been restated per px of radius and its exclusion of that allocation is now an
 * arithmetic comparison of coefficients rather than a re-run — see
 * {@link GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS}, which keeps the same 0.2813 and 0.3099 outside it.
 */
const GODOT_SCALLOP_BUDGET_PX = 0.21;

/**
 * See {@link GODOT_SCALLOP_BUDGET_PX} — the periodic half of the same claim, at the count the OLD
 * per-ring clamp produced. 0.08 is the measured worst (0.0512) plus a half; the old allocation's
 * 0.3099 is six times it.
 *
 * IT STAYS FLAT WHERE THE h26 BUDGET WENT PER-RADIUS, and the difference is the mechanism. 16 is no
 * longer any ring's step count, so this bin is not a sagitta of anything and has no radius to scale
 * with — it is leakage plus whatever is left of the old defect. Measured, it does not grow with the
 * radius: 0.0406 at r = 4, 0.0512 at r = 12, 0.0426 at r = 14. The worst is still the r = 12 row.
 */
const GODOT_HARMONIC_BUDGET_PX = 0.08;

/**
 * Taps on the OUTERMOST ring once the per-ring cap binds, i.e. at any radius past ~4 device px.
 *
 * `(HB_GPU_SPREAD_MAX_TAPS * 4 + 5) / 10` = 26 with four rings, which is the arithmetic
 * `spreadBudget.test.ts` mirrors and pins. Restated as a literal here rather than imported so that a
 * change to the shader's budget split cannot silently retarget this file's angular measurements onto
 * the new count and go on passing — the harmonic a fixture is measured at has to be a decision.
 */
const SPREAD_OUTER_RING_STEPS = 26;

/**
 * See {@link GODOT_SCALLOP_BUDGET_PX} — the same claim at the CURRENT tap count, PER PX OF RADIUS.
 *
 * THIS ONE PINS THE NEW SIGNATURE RATHER THAN THE OLD DEFECT, and it is the budget that stops the
 * next round of this from being circular. A redistribution that merely moved the scallop to a finer
 * pitch would leave `GODOT_HARMONIC_BUDGET_PX` green while looking exactly as ragged; only a bin at
 * the count the boundary is actually drawn by can say it did not.
 *
 * IT USED TO BE A FLAT 0.14 px AND THAT WAS A BUDGET WITH A RADIUS HIDDEN IN IT. Every case it was
 * calibrated on was r <= 12; `dot-radial-live-max` at r = 14 — the LIVE worst case, and the reason
 * that fixture exists — reads **0.1506** and trips it. The reading is not a defect: it is 1.61x the
 * r = 12 reading on a radius 1.17x larger, which is what the mechanism predicts, and it sits inside
 * 2x Godot's own `r50Stdev` at the same radius (0.2183). So the constant was restated rather than
 * loosened in place.
 *
 * THE RULE, AND WHY IT IS A MECHANISM RATHER THAN A FIT. This bin measures the sagitta of the
 * OUTERMOST RING: the boundary is the outer envelope of that ring's taps, and a ring of `N` taps at
 * radius `r` has a sagitta of `r * (1 - cos(pi / N))` — LINEAR IN THE RADIUS at a fixed tap count.
 * `N` is fixed at {@link SPREAD_OUTER_RING_STEPS} for every radius past ~4 device px, so a budget on
 * this bin belongs in px of amplitude PER PX OF RADIUS. Measured, in exactly those units:
 *
 * | case                | radius | h26    | per px of radius |
 * | ------------------- | ------ | ------ | ---------------- |
 * | dot-radial          | 4      | 0.0059 | 0.00148          |
 * | dot-radial-wide     | 12     | 0.0934 | 0.00778          |
 * | dot-radial-live-max | 14     | 0.1506 | **0.01076**      |
 *
 * (r = 4 reads an order of magnitude low because a 26-cycle wobble on a boundary of radius 6 has a
 * 1.45 px wavelength, which the pixel's own area filter and the ray sampler's tent between them
 * attenuate by ~19x. The metric cannot see that scallop, which is the safe direction.)
 *
 * 0.016 IS THE WORST OF THOSE PLUS A HALF, the same construction the flat number carried and for
 * the reason {@link GODOT_SCALLOP_BUDGET_PX} gives — a single DFT bin is the less stable of the two
 * statistics and is budgeted as one. It yields 0.064 / 0.192 / 0.224 px at r = 4 / 12 / 14.
 *
 * AND IT STILL EXCLUDES THE OLD ALLOCATION AT EVERY RADIUS, which is the property that makes it a
 * budget rather than a fitted line. The same statistic under `4 x 16` — that allocation's own
 * outermost-ring bin, which was h16 because 16 is what its outer ring ran — read **0.3099** at
 * r = 12, i.e. **0.02583 per px of radius**. Both sides are linear in `r`, so the comparison is of
 * COEFFICIENTS and is radius-independent by construction: 0.016 is 1.61x below 0.02583, and at
 * r = 12 the rule gives 0.192 against that allocation's 0.3099. A tap set that goes back to
 * spending its budget equally across rings fails this line at every radius it was ever a defect at.
 *
 * WHAT DID NOT MOVE, and it is the stronger half of the red-proof: `GODOT_SCALLOP_BUDGET_PX` (0.21)
 * and `GODOT_HARMONIC_BUDGET_PX` (0.08) are the two constants that carry the old allocation's
 * measured numbers (0.2813 and 0.3099), and BOTH stay exactly where they are and BOTH stay green at
 * r = 14 (0.1910 and 0.0426). The old defect's exclusion is not weakened by anything here.
 *
 * ONE THING WORTH KNOWING BEFORE THE NEXT RADIUS. `r50Stdev` per px of radius is very nearly flat
 * (0.01399 at r = 12, 0.01364 at r = 14), so the FLAT `GODOT_SCALLOP_BUDGET_PX` gets relatively
 * tighter as the radius grows: at r = 14 it has 9% of headroom left. It is not moved here because it
 * did not trip and r = 14 is the largest radius the product asks for — but a fixture past 14 would
 * need the same restatement this constant just had.
 */
const GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS = 0.016;

/** {@link GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS} evaluated at one case's dilation radius, px. */
function outerHarmonicBudgetPx(spreadPx: number): number {
  return GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS * spreadPx;
}

const ENABLED = Boolean(process.env.GSW_HB_GPU_PIXEL && process.env.DISPLAY);

/**
 * Chromium's launch options, windowless by default — see the header for the measured ladder.
 *
 * `GSW_PIXEL_HEADED=1` gives back the old surface (headed, default Ozone, ANGLE over desktop GL),
 * which is the only way to cross-check the two against each other. IT PUTS A WINDOW ON THE USER'S
 * DESKTOP: Xvfb does not contain a headed Chromium here, so that arm interrupts whoever is at the
 * machine and is to be run only with their consent.
 */
function launchOptions(): { headless: boolean; args: string[] } {
  // `headless: false` IN BOTH ARMS, deliberately. It is what stops Playwright adding its own
  // old-headless switches; `--headless=new` is what actually removes the window.
  if (process.env.GSW_PIXEL_HEADED) return { headless: false, args: [] };
  return {
    headless: false,
    args: ["--headless=new", "--enable-gpu", "--use-angle=vulkan"],
  };
}

/**
 * THE PROVENANCE GUARD ON THE WHOLE FILE: this ran on a GPU, and here is which one.
 *
 * Every budget below was calibrated against a discrete adapter, and a software rasteriser does not
 * fail them — the SwiftShader column of the RMS table agrees with the NVIDIA one to 0.03. So a
 * surface that quietly fell back would keep this suite green while making its numbers describe
 * llvmpipe, and the next recalibration would fit budgets to that. Fail fast instead.
 *
 * AN UNREADABLE ADAPTER IS ALSO A FAILURE. `WEBGL_debug_renderer_info` is what this guard reads; if
 * it is gone, the guard cannot do its job, and a guard that silently no-ops is worse than none.
 */
function assertHardwareRenderer(renderer: string): void {
  if (!renderer) {
    throw new Error(
      "hb-gpu glyph pixels: WEBGL_debug_renderer_info reported no adapter, so this run cannot show which renderer produced the numbers below — every budget in this file is calibrated against a discrete GPU",
    );
  }
  if (/swiftshader|llvmpipe/i.test(renderer)) {
    throw new Error(
      `hb-gpu glyph pixels: this browser is drawing on "${renderer}", a SOFTWARE rasteriser — the suite would still pass and every measurement it logs would then be calibrating this file's budgets to software. Check that --headless=new --enable-gpu --use-angle=vulkan reached Chromium, or run with GSW_PIXEL_HEADED=1 (which opens a window on the user's desktop) if this box has no usable GPU under headless`,
    );
  }
}

let browser: Browser;
let page: Page;
let skipReason: string | null = null;
const results = new Map<string, GlyphCaseResult>();
const cases: Record<string, GlyphCase> = GLYPH_CASES;

async function caseResult(name: string): Promise<GlyphCaseResult> {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await page.evaluate(
    (caseName) => window.__gswHbGpu.run(caseName),
    name,
  );
  results.set(name, result);
  return result;
}

/** The arm's own pixels as single-channel luma, background removed, top-down. */
function armLuma(result: GlyphCaseResult): {
  data: Uint8Array;
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const rgba = Buffer.from(result.rgbaBase64, "base64");
  const luma = new Uint8Array(result.width * result.height);
  // The alpha channel IS the coverage: the fragment writes `vec4(rgb*a*cov, a*cov)` and the colour
  // is opaque white, so alpha and every colour channel hold the same number. Taking alpha rather
  // than a luma-weighted mix keeps the comparison against a coverage reference exact.
  for (let i = 0; i < luma.length; i += 1) luma[i] = rgba[i * 4 + 3];
  return {
    data: subtractBackground(luma).data,
    width: result.width,
    height: result.height,
    rgba: new Uint8Array(rgba),
  };
}

/**
 * A case's reference, optionally GROWN by `dilatePx` before the downsample.
 *
 * `dilatePx: 0` is the plain fill and is what the fill guard is graded against; a positive radius is
 * the area coverage of `outline (+) disk(r)`, which is what a dilated glyph should look like. One
 * function for both so the two frames cannot end up graded against references built differently —
 * the whole argument for dropping the tap's MSAA rests on the fill being untouched, and that is only
 * checkable if both sides come off the same rasterizer with the same geometry.
 *
 * TAKES THE CASE rather than assuming the low-ppem one, because the two regimes that need a ground
 * truth are at opposite ends of the fixture list: the low-ppem case is the SHALLOW-COVERAGE regime
 * (a 14 px Han stroke whose coverage never reaches 1) and the thin case at spread 12 is the SPARSE-
 * COVERING one (radius past what 4 rings of 16 can tile). Grading only the first would leave the
 * second measured by a "must be covered" mask that says nothing about the ring gaps between.
 */
async function dilatedReference(
  item: GlyphCase,
  glyphId: number,
  dilatePx: number,
): Promise<Uint8Array> {
  const hb = await import("harfbuzzjs");
  const bytes = await readFile(fontFile);
  const blob = new hb.Blob(new Uint8Array(bytes));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  font.setScale(face.upem, face.upem);
  const raster = rasterizeReference(font.glyphToPath(glyphId), {
    size: item.size,
    pixelsPerEm: item.pixelsPerEm,
    upem: face.upem,
    originX: item.originX,
    originY: item.originY,
    model: modelFor(item),
    dilatePx,
  });
  return subtractBackground(raster.data).data;
}

/**
 * One dilated frame against its 8x grown ground truth, split into the two things that can be wrong.
 *
 * THE RIM AND THE INTERIOR ARE DIFFERENT FAILURES AND MUST NOT BE AVERAGED. Interior pixels are 255
 * in the reference whatever a coverage estimator says, and background is 0, so a whole-frame RMS
 * over a 20 px blob in a 128 px buffer is mostly a measurement of empty space — this file's header
 * records that a COMPLETELY destroyed 14 px glyph reads 6.74 that way. Restricting the RMS to the
 * reference's partially covered pixels is what makes it mean something, and reporting the interior
 * separately is what makes "the silhouette is translucent" visible at all: a `max` over coverage
 * that never saturates is an INTERIOR failure and would barely move a rim statistic.
 *
 * Shared by the two regimes because they must be graded identically to be compared: shallow
 * coverage (14 px, where no tap can return 1) and sparse covering (spread 12, where no 64-tap set
 * tiles the disk).
 */
function gradeDilation(
  arm: Uint8Array,
  reference: Uint8Array,
): {
  rimCount: number;
  rimRms: number;
  rimWorst: number;
  interiorCount: number;
  interiorWorst: number;
  /** How far the WORST interior pixel is below solid, which a max-of-worst-error cannot say. */
  interiorShortfall: number;
  armInk: number;
  referenceInk: number;
} {
  let rimCount = 0;
  let rimSquares = 0;
  let rimWorst = 0;
  let interiorCount = 0;
  let interiorWorst = 0;
  let interiorShortfall = 0;
  let armInk = 0;
  let referenceInk = 0;
  for (let i = 0; i < reference.length; i += 1) {
    armInk += arm[i];
    referenceInk += reference[i];
    const error = Math.abs(arm[i] - reference[i]);
    if (reference[i] > 0 && reference[i] < 255) {
      rimCount += 1;
      rimSquares += error * error;
      rimWorst = Math.max(rimWorst, error);
    } else if (reference[i] === 255) {
      interiorCount += 1;
      interiorWorst = Math.max(interiorWorst, error);
      interiorShortfall += 255 - arm[i];
    }
  }
  return {
    rimCount,
    rimRms: rimCount > 0 ? Math.sqrt(rimSquares / rimCount) : 0,
    rimWorst,
    interiorCount,
    interiorWorst,
    interiorShortfall,
    armInk,
    referenceInk,
  };
}

/** The same glyph, same geometry, filled at 8x in node from an independent HarfBuzz build. */
async function referenceOf(
  item: GlyphCase,
  result: GlyphCaseResult,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const hb = await import("harfbuzzjs");
  const bytes = await readFile(fontFile);
  const blob = new hb.Blob(new Uint8Array(bytes));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  font.setScale(face.upem, face.upem);
  const pathData = font.glyphToPath(result.glyphId);
  const raster = rasterizeReference(pathData, {
    size: item.size,
    pixelsPerEm: item.pixelsPerEm,
    upem: face.upem,
    originX: item.originX,
    originY: item.originY,
    model: modelFor(item),
  });
  return { ...raster, data: subtractBackground(raster.data).data };
}

/** One frame of the spread probe as RGBA bytes. */
function spreadFrame(probe: SpreadProbeResult, name: string): Uint8Array {
  const raw = probe.frames[name];
  if (!raw) {
    throw new Error(
      `the page returned no frame called "${name}" (has ${Object.keys(probe.frames).join(", ")})`,
    );
  }
  return new Uint8Array(Buffer.from(raw, "base64"));
}

/** The alpha channel alone. Every run in the probe is a flat colour, so alpha IS the coverage. */
function alphaPlane(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = rgba[i * 4 + 3];
  return out;
}

/**
 * The coverage threshold the contrast block calls "deep", in bytes, and where the number comes
 * from.
 *
 * 179/255 IS 0.70 COVERAGE, AND IT IS THE OPENING MEASUREMENT RESTATED IN THIS BUFFER'S UNITS. That
 * measurement counted pixels below luma 80 on a crop of dark text whose ink bottomed out near 50
 * and whose page sat near 200, so "below luma 80" is "coverage past `(200 - 80) / (200 - 50)`",
 * i.e. past 0.8 — of the ink's own peak, not of 1. These frames are transparent-backed and the
 * alpha plane IS the coverage, and the same fixture peaks at 223 rather than 255, so the
 * corresponding fraction of the achievable range lands at ~0.70.
 *
 * IT IS A REPORTING THRESHOLD RATHER THAN A BUDGET. Nothing asserts an absolute count over it; the
 * assertion is that the corrected frame's count is materially larger than the uncorrected one's,
 * which is a statement no choice of threshold in the ramp's upper half can manufacture.
 */
const DEEP_COVERAGE_LEVEL = 179;

/**
 * Total ink, the size of the partially covered population, and the deep end of it.
 *
 * `ramp` is reported next to `deep` for one reason: it is the set of pixels either correction can
 * move at all (both are the identity at coverage 0 and 1), so it is the denominator that says
 * whether a `deep` change is a real shift or a rounding artefact on eight pixels.
 */
function coverageStats(plane: Uint8Array): {
  ink: number;
  ramp: number;
  deep: number;
  peak: number;
} {
  let ink = 0;
  let ramp = 0;
  let deep = 0;
  let peak = 0;
  for (let i = 0; i < plane.length; i += 1) {
    ink += plane[i];
    if (plane[i] > 0 && plane[i] < 255) ramp += 1;
    if (plane[i] >= DEEP_COVERAGE_LEVEL) deep += 1;
    peak = Math.max(peak, plane[i]);
  }
  return { ink, ramp, deep, peak };
}

/**
 * The set of pixels within `radius` of any pixel of `mask`, brute force.
 *
 * A DISK, NOT A BOX, because that is the shape the shader's tap set approximates and a box would
 * be wrong by 41% along the diagonals — enough to make the "must be empty" assertion below accept
 * a genuine corner smear. 96x96 at radius <6 is under two million comparisons, which is cheaper
 * than being clever about it.
 */
function withinRadius(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const reach = Math.ceil(radius);
  const radiusSquared = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -reach; dy <= reach; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -reach; dx <= reach; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (dx * dx + dy * dy <= radiusSquared) out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** `alpha >= threshold`, as a 0/1 mask. */
function atLeast(alpha: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1)
    out[i] = alpha[i] >= threshold ? 1 : 0;
  return out;
}

/** Bounding box of a mask, inclusive, or `null` when it is empty. */
function boxOf(
  mask: Uint8Array,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

describe.skipIf(!ENABLED)("hb-gpu glyph pixels", () => {
  beforeAll(async () => {
    if (!existsSync(glueFile) || !existsSync(wasmFile)) {
      skipReason = `packages/hb-gpu/vendor/hb-gpu.mjs is missing from this checkout — it is committed (see vendor/VENDOR.md); packages/hb-gpu/build.sh rebuilds it with docker + emscripten`;
      return;
    }
    if (!existsSync(fontFile)) {
      skipReason = `the CJK fixture font is missing — run \`mise exec -- pnpm -w run text:fidelity\` once, or any command that calls scripts/ensure-cjk-font.ts, to download and subset it`;
      return;
    }

    const bundleText = await bundleBrowserEntry();
    const wasmBinary = await readFile(wasmFile);
    const fontBytes = await readFile(fontFile);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    page.on("pageerror", (error) => {
      console.error(`hb-gpu page error: ${error.stack ?? error.message}`);
    });
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/hb-gpu.wasm") {
        return route.fulfill({
          status: 200,
          contentType: "application/wasm",
          body: wasmBinary,
        });
      }
      if (path === "/font.ttf") {
        return route.fulfill({
          status: 200,
          contentType: "font/ttf",
          body: fontBytes,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto("http://localhost/gsw-hb-gpu");
    await page.addScriptTag({ content: bundleText, type: "module" });
    await page.waitForFunction(() => "__gswHbGpu" in window, undefined, {
      timeout: 30000,
    });

    // THE CANARY: no WebGL2 means every case below fails with an error about a null stage rather
    // than one about the renderer. It reports the adapter in the same round trip, so the guard on
    // WHICH renderer runs before a single case is measured.
    const probe = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return { webgl2: false, renderer: "" };
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl2: true,
        renderer: info
          ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
          : "",
      };
    });
    if (!probe.webgl2) {
      skipReason =
        "this browser has no WebGL2 — the hb-gpu stage cannot be created";
      return;
    }
    // NO WEBGL2 IS A SKIP AND SOFTWARE IS A FAILURE, and the asymmetry is the point: the first says
    // this box cannot run the suite, the second says it ran it on the wrong thing.
    assertHardwareRenderer(probe.renderer);
    const first = await caseResult("upright28");
    console.log(
      `hb-gpu renderer: ${first.renderer || probe.renderer} — glyph ${first.glyphId}, blob ${first.blobBytes} B, heap ${(first.heapBytes / 1024 / 1024).toFixed(2)} MiB`,
    );
  }, 180000);

  afterAll(async () => {
    await browser?.close();
  });

  for (const name of ["upright14", "upright28", "rotated28"]) {
    it(`draws ${name} where an 8x reference of the same outline puts it`, async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const result = await caseResult(name);
      const item = cases[name];
      const arm = armLuma(result);
      const reference = await referenceOf(item, result);

      const armInk = acutanceOf(arm.data, arm.width, arm.height);
      const referenceInk = acutanceOf(
        reference.data,
        reference.width,
        reference.height,
      );
      const registration = registrationPx(arm, reference);
      const error = rms(arm.data, reference.data);
      // EVERY NUMBER MEASURED AND LOGGED BEFORE ANYTHING IS ASSERTED. A guard that throws on the
      // first failed column prints nothing about the others, and this file's thresholds were
      // calibrated by breaking the upload on purpose and reading all four columns off a run that
      // was always going to fail. Assert-then-measure would have made that calibration impossible.
      console.log(
        `hb-gpu ${name}: rms ${error.toFixed(2)}, registration ${registration.distance.toFixed(3)} px (dx ${registration.dx.toFixed(3)}, dy ${registration.dy.toFixed(3)}), ink ${armInk.ink} vs reference ${referenceInk.ink}, acutance ${armInk.acutance.toFixed(3)} vs ${referenceInk.acutance.toFixed(3)}`,
      );

      // INK FIRST. A blank frame's RMS against a mostly-blank reference is SMALL and its
      // registration is meaningless rather than large — so both columns below would PASS on a
      // pipeline that drew nothing at all.
      expect(
        armInk.ink,
        `${name}: the frame has no ink — the pipeline drew nothing, which every other column below would score as a pass`,
      ).toBeGreaterThan(0.5 * referenceInk.ink);
      expect(
        armInk.ink,
        `${name}: the frame has far MORE ink than the reference — a corrupted blob whose bands cover the whole quad looks exactly like this`,
      ).toBeLessThan(1.6 * referenceInk.ink);

      expect(
        registration.distance,
        `${name}: the glyph is ${registration.distance.toFixed(3)} px from where the reference draws it (dx ${registration.dx.toFixed(3)}, dy ${registration.dy.toFixed(3)}) — an atlas offset or a quad corner is out`,
      ).toBeLessThan(REGISTRATION_BUDGET_PX);
      expect(
        error,
        `${name}: RMS ${error.toFixed(2)} against the 8x reference — above ${RMS_BUDGET} the blob did not reach the shader intact`,
      ).toBeLessThan(RMS_BUDGET);
    }, 120000);
  }

  it("writes PREMULTIPLIED coverage, not straight", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("upright28");
    const { rgba } = armLuma(result);
    // White text: premultiplied, every partially covered pixel must have `rgb == a`. A fragment
    // that wrote straight colour would hold `rgb = 255` at every covered pixel whatever its
    // coverage — which composites correctly over black and blows out over anything else, and is
    // invisible in a screenshot of a dark page.
    let partial = 0;
    let worst = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a === 0 || a === 255) continue;
      partial += 1;
      worst = Math.max(worst, Math.abs(rgba[i] - a));
    }
    expect(
      partial,
      "no partially covered pixel in the frame — an antialiased glyph must have edge pixels, so this case cannot tell premultiplied from straight",
    ).toBeGreaterThan(20);
    expect(
      worst,
      `a partially covered pixel has red ${worst} levels away from its alpha: the fragment is writing STRAIGHT colour under a premultiplied blend`,
    ).toBeLessThanOrEqual(2);
  }, 60000);

  it("reserves the whole texture and reports both VRAM numbers", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("upright28");
    // Live bytes are the blob; the reservation is what the driver actually holds. Quoting only the
    // first is how a renderer appears to cost less than it does.
    expect(result.atlasLiveBytes).toBe(result.blobBytes + result.padBytes);
    expect(result.atlasReservationBytes).toBe(4096 * 2 * 8);
    expect(result.atlasEntries).toBe(2);
    // The glyph must start mid-row, or the upload never wraps and two of the four failure modes
    // this file exists for are untested. The page throws if it does not, but the expectation is
    // restated here so the reason is visible from the suite.
    expect(result.glyphLoc % 4096).toBeGreaterThan(0);
    expect((result.glyphLoc % 4096) + result.blobBytes / 8).toBeGreaterThan(
      4096,
    );
    expect(result.instances).toBe(1);
    expect(result.drawCalls).toBe(1);
  }, 60000);

  it("measures Slug blob bytes per Han glyph", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    // The prediction under test, on the round's own fixture pool: `docs/text-rendering.md` expects
    // "~5.4 KB per Han glyph against ~1.4 KB for a 38x38 R8 atlas cell". Measured, not asserted at
    // 5.4 — the point is to publish the real number, and a test that pinned it to the prediction
    // would be asserting the guess.
    const measured = await page.evaluate(
      () => window.__gswHbGpu.blobBytes(0x4e00, 300),
      undefined,
    );
    console.log(
      `hb-gpu blob bytes: ${measured.glyphs} distinct Han glyphs, ${measured.totalBytes} B total, ${(measured.bytesPerGlyph / 1024).toFixed(2)} KiB/glyph (min ${measured.minBytes} B, max ${measured.maxBytes} B)`,
    );
    expect(measured.glyphs).toBeGreaterThan(200);
    // A loose sanity band, three-and-a-bit octaves wide. It catches an encoder emitting nothing and
    // an encoder emitting the whole font per glyph; it deliberately does not encode the prediction.
    expect(measured.bytesPerGlyph).toBeGreaterThan(256);
    expect(measured.bytesPerGlyph).toBeLessThan(64 * 1024);
  }, 180000);
  it("wraps the atlas cursor, evicts, and refuses to overwrite a glyph drawn this frame", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const probe = await page.evaluate(
      () => window.__gswHbGpu.evictionProbe(40),
      undefined,
    );
    console.log(
      `hb-gpu eviction: ${probe.offered} glyphs offered to ${probe.capacityTexels} texels — ${probe.entries} resident, ${probe.evictions} evicted, ${probe.liveTexels} texels live; first glyph moved ${probe.firstOffsetBefore} -> ${probe.firstOffsetAfter}`,
    );

    // The working set does not fit, which is the whole point: upstream would have called
    // `die ("Ran out of atlas memory")` here.
    expect(probe.liveTexels).toBeLessThanOrEqual(probe.capacityTexels);
    expect(probe.entries).toBeLessThan(probe.offered);
    expect(probe.evictions).toBeGreaterThan(0);
    // Re-uploading an evicted key must allocate afresh. Handing back the old offset would point the
    // shader at whatever glyph now owns those texels — right size, right place, wrong outline.
    expect(probe.firstOffsetAfter).not.toBe(probe.firstOffsetBefore);
    expect(probe.firstOffsetAfter).toBeGreaterThanOrEqual(0);
    // And the guard fires rather than corrupting a frame in flight.
    expect(
      probe.inUseGuard,
      "the allocator overwrote a glyph that had already been drawn this frame without complaining — that renders as a different glyph in the right place, which no other check in this round would catch",
    ).toMatch(/already drawn this frame/);

    // THE OTHER HALF OF THE SAME FAILURE, and the one the in-use guard cannot see: slots HELD
    // across the eviction. A live app caches slots between frames while the ring wraps underneath
    // them; the perf harness never does, because it pre-sizes the atlas to the whole working set,
    // which is exactly why this went a whole round undetected.
    expect(
      probe.staleSkips,
      "no held slot went stale — this probe is not exercising the generation guard at all",
    ).toBeGreaterThan(0);
    expect(probe.staleFrameInstances + probe.staleSkips).toBe(probe.heldSlots);
    expect(
      probe.staleFrameInstances,
      `the frame drew ${probe.staleFrameInstances} quads from ${probe.heldSlots} held slots but only ${probe.residentAtStaleFrame} of them are still resident — the extra ones are OTHER glyphs' outlines, correctly sized and correctly placed`,
    ).toBe(probe.residentAtStaleFrame);
  }, 120000);

  // ---- the outline path ------------------------------------------------------------------------
  //
  // FOUR PROPERTIES, AND EVERY ONE OF THEM IS SILENT WHEN WRONG. A dilation that never left the ink
  // box draws a perfect fill and no outline; a dilation that smeared the clamped band draws a
  // rectangle that looks like a drop shadow; an outline over an opaque fill that bled through looks
  // like a font weight; and a translucent outline built the only way a caller could build one
  // WITHOUT this — N offset copies — is a picture, just the wrong one. None of them throws.

  describe("spread", () => {
    let probe: SpreadProbeResult;

    beforeAll(async () => {
      if (skipReason) return;
      probe = await page.evaluate(() => window.__gswHbGpu.spreadProbe());
      const alpha = alphaPlane(spreadFrame(probe, "spread"));
      const fill = alphaPlane(spreadFrame(probe, "fill"));
      console.log(
        `hb-gpu spread: glyph ${probe.glyphId} at ${probe.pixelsPerEm} px/em, spread ${probe.spreadPx} px, quad [${probe.spreadQuad.map((v) => v.toFixed(1)).join(", ")}], instances ${JSON.stringify(probe.instances)}, ink ${fill.reduce((a, b) => a + b, 0)} -> ${alpha.reduce((a, b) => a + b, 0)}`,
      );
    }, 120000);

    it("draws a spread run as a strict superset of the same run at spread 0", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const fill = alphaPlane(spreadFrame(probe, "fill"));
      const spread = alphaPlane(spreadFrame(probe, "spread"));

      let worstLoss = 0;
      let grew = 0;
      let fillInk = 0;
      for (let i = 0; i < fill.length; i += 1) {
        if (fill[i] > 0) fillInk += 1;
        worstLoss = Math.max(worstLoss, fill[i] - spread[i]);
        if (spread[i] > fill[i] + 8) grew += 1;
      }
      console.log(
        `hb-gpu spread superset: ${fillInk} inked pixels at spread 0, ${grew} pixels gained coverage, worst loss ${worstLoss} levels`,
      );

      // NOT VACUOUS, FIRST. A blank pair of frames is a superset of itself.
      expect(
        fillInk,
        "the spread-0 frame has no ink at all, so every comparison below is between two blank images",
      ).toBeGreaterThan(200);
      expect(
        grew,
        "no pixel gained coverage at a spread of several px — the outline is simply absent, which is exactly what a missing vertex expansion looks like",
      ).toBeGreaterThan(200);
      // A MAX OVER TAPS INCLUDING THE CENTRE ONE CANNOT LOSE COVERAGE. Anything here means the
      // dilation replaced the fill rather than growing it — a shifted glyph, not a fat one.
      expect(
        worstLoss,
        `a pixel lost ${worstLoss} levels of coverage under a dilation that includes its own centre tap — the outline is displacing the glyph, not growing it`,
      ).toBeLessThanOrEqual(TOLERANCE_LEVELS);
    }, 120000);

    it("reaches exactly the spread and no further, so sampling outside the ink box reads 0", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { width, height, spreadPx } = probe;
      const fill = alphaPlane(spreadFrame(probe, "fill"));
      const spread = alphaPlane(spreadFrame(probe, "spread"));

      // THE BOX, AS THE LEGIBLE SUMMARY. Every side must move outward by the spread: a dilation
      // clipped to the ink box does not move it at all.
      const fillBox = boxOf(atLeast(fill, 128), width, height);
      const spreadBox = boxOf(atLeast(spread, 128), width, height);
      if (!fillBox || !spreadBox) throw new Error("a probe frame has no ink");
      const growth = {
        left: fillBox.x0 - spreadBox.x0,
        top: fillBox.y0 - spreadBox.y0,
        right: spreadBox.x1 - fillBox.x1,
        bottom: spreadBox.y1 - fillBox.y1,
      };

      // THE SHAPE, WHICH IS THE PART THE BOX CANNOT SEE. The dilated quad IS the ink box grown by
      // the spread, so "the box grew by the spread" is equally true of an honest dilation and of a
      // clamped band smeared over the whole quad. These two masks tell them apart:
      //   reachable — within (spread - tol) of ink, must be covered
      //   unreachable — beyond (spread + tol) of ANY ink, must be empty
      const anyInk = atLeast(fill, 1);
      const solidInk = atLeast(fill, 250);
      const reachable = withinRadius(
        solidInk,
        width,
        height,
        Math.max(0, spreadPx - SPREAD_TOLERANCE_PX),
      );
      const unreachable = withinRadius(
        anyInk,
        width,
        height,
        spreadPx + SPREAD_TOLERANCE_PX,
      );

      let uncovered = 0;
      let reachableCount = 0;
      let smearPeak = 0;
      let smearCount = 0;
      let insideQuad = 0;
      const [qx0, qy0, qx1, qy1] = probe.spreadQuad;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = y * width + x;
          if (reachable[i]) {
            reachableCount += 1;
            if (spread[i] < 250) uncovered += 1;
          }
          if (!unreachable[i]) {
            if (spread[i] > smearPeak) smearPeak = spread[i];
            if (spread[i] > TOLERANCE_LEVELS) smearCount += 1;
            // The subset of "must be empty" that the smear hypothesis predicts would light up:
            // inside the dilated quad, so a fragment really is rasterised there.
            if (
              x + 0.5 >= qx0 &&
              x + 0.5 <= qx1 &&
              y + 0.5 >= qy0 &&
              y + 0.5 <= qy1
            ) {
              insideQuad += 1;
            }
          }
        }
      }
      console.log(
        `hb-gpu spread reach: box grew L${growth.left} T${growth.top} R${growth.right} B${growth.bottom} px; ${uncovered}/${reachableCount} reachable pixels short of solid; ${smearCount} pixels beyond reach carry ink (peak ${smearPeak}), ${insideQuad} of the beyond-reach set lie inside the dilated quad`,
      );

      for (const [side, moved] of Object.entries(growth)) {
        expect(
          Math.abs(moved - spreadPx),
          `the ink box's ${side} edge moved ${moved} px for a spread of ${spreadPx} px — 0 is an outline clipped to the ink box (no vertex expansion), and much more than the spread is the clamped band smearing`,
        ).toBeLessThanOrEqual(SPREAD_TOLERANCE_PX);
      }

      // NON-VACUITY, BOTH WAYS, BEFORE THE TWO ASSERTIONS THEY GUARD. An "L" is used here rather
      // than the Han the rest of the file draws precisely so the second of these is large: its
      // empty corner is most of its own ink box, and it stays empty under an honest dilation.
      expect(
        reachableCount,
        "nothing is within reach of solid ink, so the coverage assertion below is empty",
      ).toBeGreaterThan(500);
      expect(
        insideQuad,
        "no pixel is both inside the dilated quad and beyond the dilation's reach — this case cannot see a smear at all, so the assertion below is vacuous",
      ).toBeGreaterThan(300);

      expect(
        uncovered,
        `${uncovered} of ${reachableCount} pixels within ${spreadPx - SPREAD_TOLERANCE_PX} px of SOLID ink are not solid in the dilated frame — the tap disk has holes in it, which is what a single ring gives you`,
      ).toBe(0);
      // THE FINDING THIS WHOLE DESIGN RESTS ON. `_hb_gpu_decode_glyph` clamps its band index, so a
      // fragment past the glyph's extent still decodes a real band; if that band's curves were
      // smeared outwards instead of ray-cast to nothing, this is where it would show, as ink in the
      // dilated quad that no tap could legitimately have found.
      expect(
        smearPeak,
        `a pixel more than ${spreadPx + SPREAD_TOLERANCE_PX} px from any ink carries ${smearPeak} levels of coverage — sampling outside the glyph's encoded ink box is NOT returning 0, and the whole multi-tap dilation is unsound`,
      ).toBeLessThanOrEqual(TOLERANCE_LEVELS);
    }, 120000);

    it("fills the gap around a feature smaller than the tap radius, which one ring cannot", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE ONLY CASE IN THIS FILE THAT CAN SEE A SINGLE-RING TAP SET, and it exists because
      // replacing the shader's concentric rings with one ring at the full radius leaves every other
      // case here green — measured, not assumed. An "L" stem is nine device pixels wide and a ring
      // of radius 4 always crosses it; a full stop at a spread of 12 is the shape that a single
      // ring of radius 12 sails straight past.
      const { width, height } = probe;
      const spreadPx = probe.thin.spreadPx;
      const fill = alphaPlane(
        new Uint8Array(Buffer.from(probe.thin.frames.fill, "base64")),
      );
      const spread = alphaPlane(
        new Uint8Array(Buffer.from(probe.thin.frames.spread, "base64")),
      );

      const reachable = withinRadius(
        atLeast(fill, 250),
        width,
        height,
        Math.max(0, spreadPx - SPREAD_TOLERANCE_PX),
      );
      let uncovered = 0;
      let reachableCount = 0;
      let worstHole = 255;
      for (let i = 0; i < reachable.length; i += 1) {
        if (!reachable[i]) continue;
        reachableCount += 1;
        if (spread[i] < 250) uncovered += 1;
        worstHole = Math.min(worstHole, spread[i]);
      }
      const dotInk = atLeast(fill, 1).reduce((a: number, b) => a + b, 0);
      console.log(
        `hb-gpu spread thin: glyph ${probe.thin.glyphId}, ${dotInk} inked pixels at spread 0, spread ${spreadPx} px; ${uncovered}/${reachableCount} reachable pixels short of solid (darkest ${worstHole})`,
      );

      expect(
        dotInk,
        "the full stop drew no ink, so there is no small feature here to sail past",
      ).toBeGreaterThan(40);
      // The dot must really be SMALLER than the tap radius, or a single ring would cross it too and
      // this case would be as blind as the "L" one.
      expect(
        Math.sqrt(dotInk / Math.PI),
        `the full stop's radius is ${Math.sqrt(dotInk / Math.PI).toFixed(1)} px against a spread of ${spreadPx} — it has to be the SMALLER of the two or a single ring would still hit it`,
      ).toBeLessThan(spreadPx);
      expect(
        reachableCount,
        "nothing is within reach of the dot, so the assertion below is empty",
      ).toBeGreaterThan(200);
      expect(
        uncovered,
        `${uncovered} of ${reachableCount} pixels within ${spreadPx - SPREAD_TOLERANCE_PX} px of the dot are not solid (darkest ${worstHole}) — the tap disk has an annular hole in it, which is exactly what taps on a single ring of the full radius give you`,
      ).toBe(0);
    }, 120000);

    it("tracks an 8x DILATED reference at a radius past what the clamped tap set tiles", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE SPARSE-COVERING REGIME, WHICH THE "reachable" MASK ABOVE IS BLIND TO. That mask asks
      // only whether pixels comfortably INSIDE the dilated shape are solid. It says nothing about
      // the shape's boundary, and the boundary is where a tap set that no longer tiles its own disk
      // shows up — as a scalloped edge that follows the outermost ring's taps instead of a circle.
      //
      // THIS IS THE FIXTURE THAT REACHES IT. `rings` clamps at HB_GPU_SPREAD_MAX_RINGS and the whole
      // tap set at HB_GPU_SPREAD_MAX_TAPS, so past a radius of ~2.7 px the ring spacing grows and
      // past ~4 px the angular step does. At the thin case's spread of 12 the rings sit 3 px apart
      // and the outermost ring's taps are 2.9 px of arc apart — still a sparse covering, and the
      // same regime a phone reaches at `outlinePx` 10 and DPR 3.49 (radius 17.4 device px), where
      // the outline was reported as a ragged fringed slab. Under the previous allocation, which
      // clamped EVERY ring to 16 steps, that outermost arc was 4.7 px and this case's rim read
      // 79.10 against today's 52.26.
      //
      // GRADED THE SAME WAY AS THE LOW-PPEM CASE, against `outline (+) disk(r)` at 8x, so the two
      // regimes' numbers can sit in one table. The budget is deliberately loose; see
      // THIN_RIM_RMS_BUDGET.
      const thin = probe.thin;
      const spreadPx = thin.spreadPx;
      const arm = subtractBackground(
        alphaPlane(new Uint8Array(Buffer.from(thin.frames.spread, "base64"))),
      ).data;
      const reference = await dilatedReference(
        SPREAD_THIN_CASE,
        thin.glyphId,
        spreadPx,
      );
      const graded = gradeDilation(arm, reference);
      console.log(
        `hb-gpu spread thin fidelity: glyph ${thin.glyphId} at ${SPREAD_THIN_CASE.pixelsPerEm} px/em, spread ${spreadPx} px; rim ${graded.rimCount} px, rim rms ${graded.rimRms.toFixed(2)}, worst rim ${graded.rimWorst}; interior ${graded.interiorCount} px, worst ${graded.interiorWorst}, shortfall ${graded.interiorShortfall}; ink ${graded.armInk} vs reference ${graded.referenceInk} (${(graded.armInk / graded.referenceInk).toFixed(3)})`,
      );

      // THE SAME RIM, SPLIT INTO THE THREE THINGS THAT CAN BE WRONG WITH IT — see
      // `outline-metrics.ts`. The rim RMS above is one number for "smeared", "notched" and
      // "blurred" at once, and Stages 1 and 2 of this round are expected to move different ones of
      // those. Reported here so the before/after can be attributed rather than merely observed.
      const [inner, outer] = await Promise.all([
        dilatedReference(SPREAD_THIN_CASE, thin.glyphId, spreadPx - 1),
        dilatedReference(SPREAD_THIN_CASE, thin.glyphId, spreadPx + 1),
      ]);
      const placed = displacementVsWidth(arm, {
        inner,
        target: reference,
        outer,
      });
      // A DOT IS THE ONE SHAPE THE RADIAL FORM WORKS ON, and this is the fixture whose boundary
      // the clamped tap set was known to scallop — 4 rings of at most 16 steps at radius 12 left
      // 4.7 px of arc between the outermost taps. `harmonicAmplitudePx` at 16 cycles was the
      // unambiguous signature of a boundary following that tap count rather than a circle: 0.3099 px
      // then, 0.0512 now that the budget is split by ring radius. Logged in both bins here and
      // asserted, against the Godot golden, in the `godot outline` block.
      const shape = measureOutline(
        { data: arm, width: probe.width, height: probe.height },
        { radial: true },
      );
      const radial = shape.radial;
      // AND AT THE CURRENT OUTERMOST RING'S OWN TAP COUNT, which is where a residual scallop would
      // now sit. Both are reductions of the same 256 rays; see the godot-outline block, where the
      // pair carries budgets.
      const outerRadial = measureOutline(
        { data: arm, width: probe.width, height: probe.height },
        { radial: true, harmonic: SPREAD_OUTER_RING_STEPS },
      ).radial;
      console.log(
        `hb-gpu spread thin placement: ink beyond r+1 ${placed.outsideInk.toFixed(2)} px over ${placed.outsideCount} px (${(100 * placed.outsideFraction).toFixed(3)}% of reference ink); shortfall inside r-1 ${placed.insideShortfall.toFixed(2)} px over ${placed.insideCount} px (${(100 * placed.insideFraction).toFixed(3)}%); band ${placed.bandCount} px`,
      );
      console.log(
        `hb-gpu spread thin shape: ramp ${radial?.rampWidthPx?.toFixed(3)} px (raw 10-90 ${radial?.rampWidth1090Px?.toFixed(3)}, sampler floor ${RADIAL_RECONSTRUCTION_1090_PX}; gradient ${shape.gradientRampWidthPx?.toFixed(3)}), r50 ${radial?.r50Mean?.toFixed(3)} +- ${radial?.r50Stdev?.toFixed(4)}, h${radial?.harmonic} ${radial?.harmonicAmplitudePx?.toFixed(4)} px, h${outerRadial?.harmonic} ${outerRadial?.harmonicAmplitudePx?.toFixed(4)} px, rays ${radial?.raysMeasured}/${radial?.rays}, ink/disk ${radial?.r50Mean ? (shape.ink / (Math.PI * radial.r50Mean ** 2)).toFixed(3) : "n/a"}`,
      );

      expect(
        graded.rimCount,
        "the grown reference has no partially covered pixel, so the rim assertion below is empty",
      ).toBeGreaterThan(40);
      expect(
        graded.armInk,
        "the dilated thin frame has no ink — every column here would score that as a pass",
      ).toBeGreaterThan(0.5 * graded.referenceInk);

      // WHAT THE RIM RMS ACTUALLY IS, and this pair is what says it. The rim is neither smeared nor
      // notched: not one byte of ink lands beyond a reference already a whole pixel fatter, and not
      // one byte is missing from inside one a whole pixel thinner. Both come back EXACTLY 0, over
      // 15410 and 660 pixels. So the entire disagreement at radius 12 is ANGULAR — the boundary is
      // in the right place on average and in the wrong place as a function of theta.
      //
      // BOTH READ ZERO UNDER BOTH TAP ALLOCATIONS, which is what makes the rim column attributable.
      // The old clamped set scored 0 / 0 here with `r50Stdev` 0.2813 and 0.3099 px at 16 cycles and
      // a rim of 79.10; the redistributed one scores 0 / 0 with 0.1679, 0.0512 and 52.26. The
      // dilation did not move outward or inward on average — it stopped wobbling.
      //
      // The zones are cut a whole pixel outside and inside on purpose (see `displacementVsWidth`),
      // so a correct antialiased rim scores zero on both and only a real displacement moves them.
      // A driver would have to shift the boundary a pixel and a half to break either.
      expect(
        placed.outsideCount,
        "nothing lies beyond the r+1 reference, so the smear assertion below is empty",
      ).toBeGreaterThan(1000);
      expect(
        placed.insideCount,
        "the r-1 reference has no solid core, so the notch assertion below is empty",
      ).toBeGreaterThan(200);
      expect(
        placed.outsideInk,
        `${placed.outsideInk.toFixed(2)} px of ink lands more than a pixel beyond the true grown shape — the dilation is reaching past its own radius, which a rim RMS alone reports identically to a scallop`,
      ).toBe(0);
      expect(
        placed.insideShortfall,
        `${placed.insideShortfall.toFixed(2)} px of coverage is missing from inside the r-1 reference's solid core — the dilation is falling short of its own radius`,
      ).toBe(0);
      // THE INTERIOR, AS A FRACTION AND NOT AS A WORST PIXEL. Coverage saturates at 96 px per em,
      // so unlike the low-ppem case there is no shallow-coverage excuse for a translucent middle —
      // but a scalloped BOUNDARY still lands inside the reference's interior wherever the arm's
      // edge cuts in between two taps, and that is one pixel deep, not a field of them. Measured on
      // headless ANGLE/Vulkan it is now EXACTLY ZERO over the 752 interior pixels, where the
      // clamped 16-step allocation left 213 levels with a worst pixel 162 short (see
      // THIN_INTERIOR_SHORTFALL_BUDGET for the whole table). A worst-pixel assertion would be an
      // assertion about which pixel the scallop happened to notch; the fraction is the size of the
      // defect, and this is the fixture where it went away.
      const interiorShortfallFraction =
        graded.interiorShortfall / (255 * Math.max(1, graded.interiorCount));
      expect(
        interiorShortfallFraction,
        `${(100 * interiorShortfallFraction).toFixed(2)}% of the grown reference's solid interior is missing (worst pixel ${graded.interiorWorst} levels short) at ${SPREAD_THIN_CASE.pixelsPerEm} px per em, where every tap CAN return 1 — past ${THIN_INTERIOR_SHORTFALL_BUDGET} the tap set is losing the interior and not merely scalloping its edge`,
      ).toBeLessThan(THIN_INTERIOR_SHORTFALL_BUDGET);
      expect(
        graded.rimRms,
        `the outline's rim is ${graded.rimRms.toFixed(2)} levels RMS from the true grown shape at a radius no 64-tap set tiles densely (worst ${graded.rimWorst}) — above ${THIN_RIM_RMS_BUDGET} the boundary is following the taps rather than a circle, which is what an EQUAL split of the budget across the rings reads here (79.10)`,
      ).toBeLessThan(THIN_RIM_RMS_BUDGET);
      // AND IT MUST NOT HAVE GROWN OR SHRUNK. A rim RMS alone cannot tell a scalloped boundary from
      // one that is simply in the wrong place; the ink ratio can.
      const inkRatio = graded.armInk / graded.referenceInk;
      expect(
        inkRatio,
        `the dilated dot carries ${(100 * inkRatio).toFixed(1)}% of the true grown shape's ink at spread ${spreadPx}`,
      ).toBeGreaterThan(0.85);
      expect(
        inkRatio,
        `the dilated dot carries ${(100 * inkRatio).toFixed(1)}% of the true grown shape's ink at spread ${spreadPx}`,
      ).toBeLessThan(1.15);
    }, 180000);

    it("leaves an opaque fill's own pixels untouched under an outline", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const fillRgba = spreadFrame(probe, "fill");
      const overlay = spreadFrame(probe, "overlay");
      const fill = alphaPlane(fillRgba);

      let solid = 0;
      let worst = 0;
      let worstAt = -1;
      let outlineBand = 0;
      for (let i = 0; i < fill.length; i += 1) {
        if (fill[i] >= 250) {
          solid += 1;
          for (let c = 0; c < 4; c += 1) {
            const error = Math.abs(overlay[i * 4 + c] - fillRgba[i * 4 + c]);
            if (error > worst) {
              worst = error;
              worstAt = i;
            }
          }
        } else if (fill[i] === 0 && overlay[i * 4] > 8) {
          // Red where the plain fill has nothing: the outline band itself.
          outlineBand += 1;
        }
      }
      console.log(
        `hb-gpu spread overlay: ${solid} solid fill pixels, worst channel error ${worst} at index ${worstAt}; ${outlineBand} pixels of red outline outside the fill`,
      );

      expect(
        solid,
        "the plain fill has no fully covered pixels, so there is nothing for the outline to fail to show through",
      ).toBeGreaterThan(300);
      // NOT VACUOUS: the red run really did draw, outside the fill, or the equality above is just
      // two identical white glyphs.
      expect(
        outlineBand,
        "no red pixel anywhere outside the fill — the outline run drew nothing, so 'the fill is untouched' is trivially true",
      ).toBeGreaterThan(200);
      expect(
        worst,
        `a fully covered fill pixel is ${worst} levels away from what the fill alone puts there — the dilated run underneath is showing through an opaque fill`,
      ).toBeLessThanOrEqual(TOLERANCE_LEVELS);
    }, 120000);

    it("composites a translucent outline exactly once, where N offset copies composite N times", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const once = alphaPlane(spreadFrame(probe, "translucentSpread"));
      const copies = alphaPlane(spreadFrame(probe, "translucentCopies"));

      const peak = (plane: Uint8Array): number => {
        let out = 0;
        for (const value of plane) out = Math.max(out, value);
        return out;
      };
      const oncePeak = peak(once);
      const copiesPeak = peak(copies);
      // Half alpha, blended once: 0.5 * 255.
      const expected = 128;
      console.log(
        `hb-gpu spread translucency: one dilated run peaks at alpha ${oncePeak}, ${probe.copies} offset copies of the same run peak at ${copiesPeak} (one composite would be ${expected})`,
      );

      expect(
        oncePeak,
        "the translucent dilated run drew nothing at all",
      ).toBeGreaterThan(expected - 8);
      // THE ASSERTION THE WHOLE SHADER-SIDE MAX EXISTS FOR. A caller cannot build this from the
      // outside: N offset draws blend N times and pile up towards opaque, which is why the max is
      // inside one fragment rather than in a loop over runs.
      expect(
        oncePeak,
        `a half-alpha outline reached alpha ${oncePeak} where one composite is ${expected} — the dilation is blending more than once per fragment`,
      ).toBeLessThanOrEqual(expected + TOLERANCE_LEVELS);
      // And the contrast is real rather than asserted: the emulation this replaces really does
      // stack. 1 - 0.5^n for the n copies that overlap a given pixel.
      expect(
        copiesPeak,
        `${probe.copies} offset copies of a half-alpha run peaked at ${copiesPeak}, barely above one composite — they are not overlapping, so this case is not demonstrating the difference it claims to`,
      ).toBeGreaterThan(expected + 60);
    }, 120000);

    it("leaves the FILL path untouched at the same low ppem, spread 0", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE PROPERTY THE OUTLINE'S TAP BUDGET IS ALLOWED TO TRADE AGAINST, AND THE ONE IT IS NOT.
      // `hb_gpu_spread_tap` is called only from inside the ring loops, so at spread 0 it is never
      // reached and the fragment's coverage is `hb_gpu_draw` alone — HarfBuzz's own function, five
      // taps and all. Anything done to the dilation's taps must leave this frame exactly where the
      // reference puts it; a change that improved the outline's cost by degrading the FILL would be
      // a different and much worse trade, and nothing else in this file draws the fill at 14 px
      // ROTATED (`upright14` is upright, `rotated28` is twice the size).
      const low = probe.lowPpem;
      const arm = subtractBackground(
        alphaPlane(new Uint8Array(Buffer.from(low.frames.fill, "base64"))),
      ).data;
      const reference = await dilatedReference(
        SPREAD_LOWPPEM_CASE,
        low.glyphId,
        0,
      );
      const armInk = acutanceOf(arm, probe.width, probe.height);
      const referenceInk = acutanceOf(reference, probe.width, probe.height);
      const registration = registrationPx(
        { data: arm, width: probe.width, height: probe.height },
        { data: reference, width: probe.width, height: probe.height },
      );
      const error = rms(arm, reference);
      console.log(
        `hb-gpu low-ppem fill: rms ${error.toFixed(2)}, registration ${registration.distance.toFixed(3)} px, ink ${armInk.ink} vs reference ${referenceInk.ink}`,
      );

      expect(
        armInk.ink,
        "the low-ppem fill frame has no ink — the pipeline drew nothing, which the RMS below would score as a pass",
      ).toBeGreaterThan(0.5 * referenceInk.ink);
      expect(
        registration.distance,
        `the low-ppem fill sits ${registration.distance.toFixed(3)} px from the reference`,
      ).toBeLessThan(REGISTRATION_BUDGET_PX);
      expect(
        error,
        `the FILL at ${low.pixelsPerEm} px/em reads RMS ${error.toFixed(2)} against its 8x reference — the dilation's taps are not supposed to be able to move this number at all`,
      ).toBeLessThan(RMS_BUDGET);
    }, 180000);

    it("matches an 8x DILATED reference on the rim, below ppem 16 where the tap averages five samples", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE CASE THIS SUITE WAS BLIND TO. Every other spread frame draws at 96 px per em, so none of
      // them takes `_hb_gpu_slug`'s `ppem < 16` branch — and `hb_gpu_spread_tap` mirrors that
      // branch, so below ppem 16 every ring tap is FIVE `_hb_gpu_slug_single` evaluations. Deleting
      // it left all thirteen assertions here byte-identical while changing S9's frame rate 5.7x.
      const low = probe.lowPpem;
      const spreadPx = low.spreadPx;
      const arm = subtractBackground(
        alphaPlane(new Uint8Array(Buffer.from(low.frames.spread, "base64"))),
      ).data;

      // GROUND TRUTH, NOT A PREVIOUS RENDER. The reference is the same outline filled at 8x, grown
      // by a disk of exactly `spreadPx`, and box-downsampled — so it is the area coverage of the
      // grown SHAPE. That is a statement about what a dilated glyph should look like, which a
      // golden image of the current shader would not be: a golden would go on passing after a
      // change that made both sides wrong together.
      const reference = await dilatedReference(
        SPREAD_LOWPPEM_CASE,
        low.glyphId,
        spreadPx,
      );

      const {
        rimCount,
        rimRms,
        rimWorst,
        interiorCount,
        interiorWorst,
        interiorShortfall,
        armInk,
        referenceInk,
      } = gradeDilation(arm, reference);
      // MEASURED AND LOGGED BEFORE ANYTHING IS ASSERTED, this file's rule — the budgets below were
      // calibrated by reading these columns off runs that were going to fail.
      console.log(
        `hb-gpu spread low-ppem: glyph ${low.glyphId} at ${low.pixelsPerEm} px/em, ${SPREAD_LOWPPEM_CASE.degrees} deg, spread ${spreadPx} px; rim ${rimCount} px, rim rms ${rimRms.toFixed(2)}, worst rim ${rimWorst}; interior ${interiorCount} px, worst ${interiorWorst}, shortfall ${interiorShortfall} (${((100 * interiorShortfall) / (255 * interiorCount)).toFixed(1)}%); ink ${armInk} vs reference ${referenceInk} (${(armInk / referenceInk).toFixed(3)})`,
      );

      // SMEARED / NOTCHED / BLURRED, as three numbers rather than one — the same split the thin
      // case now reports, and here it is the OTHER regime: 中 at 14 px per em, where no tap can
      // return coverage 1 and the interior is the half that has historically been wrong. No radial
      // form: rays out of a Han glyph's centroid leave through whichever stroke they meet.
      const [lowInner, lowOuter] = await Promise.all([
        dilatedReference(SPREAD_LOWPPEM_CASE, low.glyphId, spreadPx - 1),
        dilatedReference(SPREAD_LOWPPEM_CASE, low.glyphId, spreadPx + 1),
      ]);
      const placed = displacementVsWidth(arm, {
        inner: lowInner,
        target: reference,
        outer: lowOuter,
      });
      const shape = measureOutline({
        data: arm,
        width: probe.width,
        height: probe.height,
      });
      console.log(
        `hb-gpu spread low-ppem placement: ink beyond r+1 ${placed.outsideInk.toFixed(2)} px over ${placed.outsideCount} px (${(100 * placed.outsideFraction).toFixed(3)}% of reference ink); shortfall inside r-1 ${placed.insideShortfall.toFixed(2)} px over ${placed.insideCount} px (${(100 * placed.insideFraction).toFixed(3)}%); ramp ${shape.gradientRampWidthPx?.toFixed(3)} px, ink ${shape.ink.toFixed(1)}, peak ${shape.peak.toFixed(3)}`,
      );

      // AND THE OTHER REGIME'S ATTRIBUTION. This case is NOTCHED and not smeared: 0 bytes beyond
      // the r+1 reference over 16056 pixels, against 5.43 px of coverage missing from the r-1
      // core (4.1% of it). That is the residue of the shallow-coverage problem the interior budget
      // above pins — 中's strokes peak at 0.42 coverage at this size — and it is the opposite
      // failure from the thin case's, which is angular and reads 0 on both.
      //
      // ONLY THE SMEAR HALF IS ASSERTED. The notch already has a budget twenty lines down
      // (LOWPPEM_INTERIOR_SHORTFALL_BUDGET, on the whole solid interior rather than on the r-1
      // core), and two budgets on one defect is one that gets tightened and one that gets
      // forgotten. "No ink past the radius" is a claim nothing else in this file makes at 14 px.
      expect(
        placed.outsideCount,
        "nothing lies beyond the r+1 reference, so the smear assertion below is empty",
      ).toBeGreaterThan(1000);
      expect(
        placed.outsideInk,
        `${placed.outsideInk.toFixed(2)} px of ink lands more than a pixel beyond the true grown shape at ${low.pixelsPerEm} px/em — the sharpened tap is an INSIDE test and cannot legitimately put coverage there`,
      ).toBe(0);

      // NON-VACUITY FIRST, THREE WAYS. A blank frame has no ink and would sail through a rim RMS
      // computed over a reference rim it never touched.
      expect(
        armInk,
        "the dilated low-ppem frame has no ink — the pipeline drew nothing, which every column below would score as a pass",
      ).toBeGreaterThan(0.5 * referenceInk);
      expect(
        armInk,
        "the dilated low-ppem frame has far MORE ink than the grown reference — the band is smearing rather than dilating",
      ).toBeLessThan(1.6 * referenceInk);
      expect(
        rimCount,
        "the grown reference has no partially covered pixel, so the rim assertion below is empty",
      ).toBeGreaterThan(40);

      // THE DEFECT THIS CASE WAS BUILT TO RECORD, NOW PINNED SHUT.
      //
      // A dilated glyph OUGHT to be solid inside — the reference is — and with a max over RAW
      // coverage taps this one was not: a translucent mottle at 0.622 of the true grown shape's
      // ink, its interior 38.5% short of solid. That was not a bug in the tap SET but in what a tap
      // MEANT. A max cannot return more than the peak coverage near the fragment, and at ppem 14
      // 中's strokes peak at 0.42 — so no arrangement of taps could have produced a solid
      // silhouette, and the same fact kept the `cov >= 0.999` early-out from ever firing.
      //
      // Sharpening each tap before the max (`HB_GPU_SPREAD_INSIDE_LOW` in `webgl.ts`) makes it an
      // INSIDE test instead: 0.988 of the reference's ink, interior 6.1% short. The band below is
      // therefore no longer "a mottle, but not a vanished one" — it is the real thing, and a revert
      // to raw taps fails both halves of it.
      const inkRatio = armInk / referenceInk;
      expect(
        inkRatio,
        `the dilated outline carries ${(inkRatio * 100).toFixed(1)}% of the true grown shape's ink at ${low.pixelsPerEm} px/em — below 85% the taps have gone back to reporting coverage instead of testing inclusion, which is the translucent mottle this case exists for (it read 62.2%)`,
      ).toBeGreaterThan(0.85);
      expect(
        inkRatio,
        `the dilated outline carries ${(inkRatio * 100).toFixed(1)}% of the true grown shape's ink — above 115% it is smearing past the shape rather than tracking it`,
      ).toBeLessThan(1.15);

      // THE INTERIOR, WHICH THE INK RATIO ALONE CANNOT PIN. Ink is a sum, so a silhouette that was
      // translucent in the middle and correspondingly fat at the edges could hit 1.0 while looking
      // nothing like the reference. This is the half that says the middle is solid.
      const interiorShortfallFraction =
        interiorShortfall / (255 * Math.max(1, interiorCount));
      expect(
        interiorShortfallFraction,
        `${(100 * interiorShortfallFraction).toFixed(1)}% of the grown reference's solid interior is missing at ${low.pixelsPerEm} px/em (worst pixel ${interiorWorst} levels short) — a max over raw coverage taps reads 38.5% here, so anything past ${LOWPPEM_INTERIOR_SHORTFALL_BUDGET} is the mottle coming back`,
      ).toBeLessThan(LOWPPEM_INTERIOR_SHORTFALL_BUDGET);

      // THE RIM BUDGET. Calibrated on this box against the 8x dilated reference — see the constant.
      expect(
        rimRms,
        `the outline's rim is ${rimRms.toFixed(2)} levels RMS from the true grown shape (worst ${rimWorst}, interior worst ${interiorWorst}) — above ${LOWPPEM_RIM_RMS_BUDGET} the dilation is no longer tracking the outline at this size`,
      ).toBeLessThan(LOWPPEM_RIM_RMS_BUDGET);
    }, 180000);

    it("takes the ppem<16 branch at 14 px and NOT at 96, and costs little when it is dropped", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE ASSERTION THAT THE BRANCH FIRES, rather than the assumption that it does. Two programs
      // on one GPU differing in one `#define`, drawn in one frame at one sub-pixel phase, so every
      // other variable is held fixed by construction rather than by argument:
      //
      //   at 14 px per em  the two MUST differ   — the five-sample average is weighted in
      //   at 96 px per em  the two MUST be EQUAL — the define can change nothing there
      //
      // Fail either way round and this fixture is not measuring what it says. Before it existed the
      // whole suite was byte-identical with the branch deleted, which is how a 5.7x shader change
      // reached a perf table before it reached a test.
      //
      // WHAT THE HIGH-PPEM HALF ACTUALLY PINS, stated precisely because the obvious reading is
      // wrong and was checked: it is NOT the `if (ppem < 16.0)` constant. The blend is
      // `mix (c, msaa, smoothstep (16.0, 8.0, ppem))`, and that weight is already exactly 0 above
      // ppem 16 — widening the `if` to `ppem < 200.0` leaves this frame byte-identical, measured.
      // The `if` is a COST gate on top of a weight that had already vanished. So what this half
      // pins is the thing that actually matters to a consumer: dropping the tap's MSAA cannot
      // change a single pixel of text at or above ppem 16, whatever the gate is written as.
      const low = probe.lowPpem;
      const shipped = alphaPlane(
        new Uint8Array(Buffer.from(low.frames.spread, "base64")),
      );
      const withMsaa = alphaPlane(
        new Uint8Array(Buffer.from(low.msaaFrames.spread, "base64")),
      );
      const shippedFill = alphaPlane(
        new Uint8Array(Buffer.from(low.frames.fill, "base64")),
      );
      const withMsaaFill = alphaPlane(
        new Uint8Array(Buffer.from(low.msaaFrames.fill, "base64")),
      );
      const highShipped = alphaPlane(spreadFrame(probe, "spread"));
      const highWithMsaa = alphaPlane(
        new Uint8Array(Buffer.from(low.msaaHighPpemFrames.spread, "base64")),
      );

      const compare = (
        a: Uint8Array,
        b: Uint8Array,
      ): {
        differing: number;
        worst: number;
        /** RMS of the difference over the pixels that differ — the stable statistic. */
        rms: number;
        totalA: number;
        totalB: number;
      } => {
        let differing = 0;
        let worst = 0;
        let squares = 0;
        let totalA = 0;
        let totalB = 0;
        for (let i = 0; i < a.length; i += 1) {
          totalA += a[i];
          totalB += b[i];
          const error = Math.abs(a[i] - b[i]);
          if (error > 0) {
            differing += 1;
            squares += error * error;
          }
          worst = Math.max(worst, error);
        }
        return {
          differing,
          worst,
          rms: differing > 0 ? Math.sqrt(squares / differing) : 0,
          totalA,
          totalB,
        };
      };

      const outline = compare(shipped, withMsaa);
      const fillPair = compare(shippedFill, withMsaaFill);
      const high = compare(highShipped, highWithMsaa);
      console.log(
        `hb-gpu spread tap msaa: at ${low.pixelsPerEm} px/em the outline differs on ${outline.differing} px, rms ${outline.rms.toFixed(1)}, worst ${outline.worst} levels; ink without ${outline.totalA} vs with ${outline.totalB}; the FILL differs on ${fillPair.differing} px (worst ${fillPair.worst}); at ${probe.pixelsPerEm} px/em the outline differs on ${high.differing} px (worst ${high.worst})`,
      );

      if (process.env.GSW_HB_GPU_DUMP) {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const dir = join(repoRoot, "artifacts", "perf", "outline-study");
        await mkdir(dir, { recursive: true });
        const ppm = (plane: Uint8Array): Buffer =>
          Buffer.concat([
            Buffer.from(`P5\n${probe.width} ${probe.height}\n255\n`),
            Buffer.from(plane),
          ]);
        await writeFile(join(dir, "lowppem-msaa-off.pgm"), ppm(shipped));
        await writeFile(join(dir, "lowppem-msaa-on.pgm"), ppm(withMsaa));
        const diff = new Uint8Array(shipped.length);
        for (let i = 0; i < diff.length; i += 1) {
          diff[i] = Math.min(255, Math.abs(shipped[i] - withMsaa[i]) * 3);
        }
        await writeFile(join(dir, "lowppem-msaa-diff3x.pgm"), ppm(diff));
      }

      // NOT VACUOUS: both frames drew something.
      expect(
        outline.totalA,
        "the shipped low-ppem outline frame is blank, so every comparison here is between two empty images",
      ).toBeGreaterThan(1000);

      // 1. THE BRANCH FIRES AT 14 px. If these were identical, the define would be doing nothing
      //    here and the budget below would be guarding a comparison of a frame with itself.
      expect(
        outline.differing,
        `the two tap variants produce byte-identical outlines at ${low.pixelsPerEm} px/em — the \`ppem < 16\` branch is NOT being taken, so this case does not exercise the thing it exists for and no budget here means anything`,
      ).toBeGreaterThan(20);

      // 2. AND NOT AT 96 px, which is the other half of the same claim and the reason every spread
      //    case that came before this one was blind to the change.
      expect(
        high.differing,
        `the two tap variants differ on ${high.differing} px (worst ${high.worst}) at ${probe.pixelsPerEm} px/em, where \`ppem < 16\` is false — the define is changing something other than the MSAA branch`,
      ).toBe(0);

      // 3. THE FILL IS UNTOUCHED, and this is the assertion the whole trade rests on. The macro is
      //    HB_GPU_SPREAD_TAP_NO_MSAA and the fill's is the library's own HB_GPU_NO_MSAA, so this
      //    cannot fail without somebody having merged the two names.
      expect(
        fillPair.differing,
        `the spread-0 FILL differs on ${fillPair.differing} px between the two tap variants — \`hb_gpu_spread_tap\` is not supposed to be reachable at spread 0 at all, so the define has leaked into \`hb_gpu_draw\``,
      ).toBe(0);

      // 4. AND THE COST OF DROPPING IT IS SMALL. The budget is the measured worst channel plus
      //    headroom; see LOWPPEM_MSAA_WORST_BUDGET for what it is calibrated against.
      // RMS OVER THE DIFFERING PIXELS, not the worst one. A single pixel's worst case is where a
      // coverage estimator is least stable and moves several levels between driver versions; the
      // RMS over the ~270 pixels that differ is the number that describes the rim.
      expect(
        outline.rms,
        `dropping the tap's MSAA moves the outline by RMS ${outline.rms.toFixed(1)} levels of 255 over ${outline.differing} pixels at ${low.pixelsPerEm} px/em (worst ${outline.worst}) — past ${LOWPPEM_MSAA_DIFF_RMS_BUDGET} the rim is a different shape rather than a slightly firmer one, and the 5.74x stops being a cheap trade`,
      ).toBeLessThanOrEqual(LOWPPEM_MSAA_DIFF_RMS_BUDGET);
    }, 180000);

    it("goes back to a plain fill when the spread is set to 0 again", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE STICKY-UNIFORM CHECK. `begin` does not reset the spread, exactly as it does not reset
      // the colour or the model — so `setSpread(0)` has to really undo it. Drawn LAST in the page,
      // through the SAME renderer that drew every dilated frame above.
      const fill = spreadFrame(probe, "fill");
      const after = spreadFrame(probe, "fillAfterSpread");
      let differing = 0;
      let worst = 0;
      // OVER PIXELS, NOT OVER BYTES. `fill` is RGBA here, so `fill.length / 4` is the pixel count;
      // running the loop to `fill.length` indexes four times past the end and every comparison
      // silently becomes NaN — which `Math.max` then propagates into a "worst error" of NaN.
      for (let i = 0; i < fill.length / 4; i += 1) {
        let error = 0;
        for (let c = 0; c < 4; c += 1) {
          error = Math.max(error, Math.abs(after[i * 4 + c] - fill[i * 4 + c]));
        }
        if (error > 0) differing += 1;
        worst = Math.max(worst, error);
      }
      console.log(
        `hb-gpu spread reset: ${differing} pixels differ from the first plain fill, worst channel error ${worst}`,
      );
      expect(
        worst,
        `a plain fill drawn after a dilated one differs by ${worst} levels — setSpread(0) does not undo the spread, so one outlined run makes every later run fat`,
      ).toBe(0);
    }, 120000);
  });

  // THE SHIPPED CONTRAST CURVE, which every other case in this file turns OFF.
  //
  // WHY IT NEEDS ITS OWN BLOCK. The rest of the suite grades frames against an 8x area-coverage
  // reference, and a contrast correction is by construction a departure from area coverage — so
  // there is no reference here at all. The claims are RELATIONS between frames that differ in
  // exactly one renderer option, on one GPU, in one sub-pixel phase, which is the only way a
  // "makes text look better" change is falsifiable at all.
  //
  // WHAT WOULD BE WRONG AND SILENT WITHOUT IT: a brightness read from the premultiplied colour
  // (black text would then get white text's exponent, i.e. the correction backwards); a ppem taken
  // as `1/fwidth(v_texcoord)` instead of `hb_gpu_ppem` (a factor of `upem` — the ramp would be
  // saturated everywhere and the correction would never fire); the uniforms not restated per frame;
  // and the default silently flipping to off. Every one of those still draws perfectly good text.
  describe("contrast", () => {
    let probe: ContrastProbeResult;
    /** Alpha planes by frame name. The fragment writes `u_color.a * cov` and every colour here is
     *  opaque, so an alpha plane IS the corrected coverage, for black and white alike. */
    let plane: Record<string, Uint8Array>;

    beforeAll(async () => {
      if (skipReason) return;
      probe = await page.evaluate(() => window.__gswHbGpu.contrastProbe());
      plane = {};
      for (const [name, base64] of Object.entries(probe.frames)) {
        plane[name] = alphaPlane(new Uint8Array(Buffer.from(base64, "base64")));
      }
      const columns = (name: string): string => {
        const stats = coverageStats(plane[name]);
        // ACUTANCE IS A CONTROL AND IS REPORTED FOR THAT REASON. The opening measurement's whole
        // shape was "DOM and this path agree on sharpness and on ink, and disagree only about the
        // middle of the ramp", so a correction that moved acutance a long way would be a different
        // change from the one being made.
        const sharp = acutanceOf(plane[name], probe.width, probe.height);
        return `${name} ink ${stats.ink} ramp ${stats.ramp} deep ${stats.deep} peak ${stats.peak} acutance ${sharp.acutance.toFixed(3)}`;
      };
      console.log(
        `hb-gpu contrast: ${probe.lowGlyphs} glyphs at ${probe.lowPixelsPerEm} px/em, gamma probe ${probe.gamma}; ${[
          "plainLowWhite",
          "shippedLowWhite",
          "plainLowBlack",
          "shippedLowBlack",
          "gammaLowWhite",
        ]
          .map(columns)
          .join("; ")}`,
      );
      console.log(
        `hb-gpu contrast (ppem ${probe.highPixelsPerEm}): ${["plainHighWhite", "shippedHighWhite", "gammaHighWhite"].map(columns).join("; ")}`,
      );
      console.log(
        `hb-gpu contrast (dilated by ${probe.outlinePx} px at ${probe.lowPixelsPerEm} px/em): ${[
          "plainOutlineLowWhite",
          "shippedOutlineLowWhite",
          "plainOutlineLowBlack",
          "shippedOutlineLowBlack",
        ]
          .map(columns)
          .join("; ")}`,
      );
    }, 180000);

    it("leaves coverage colour-blind when the correction is OFF", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE CONTROL THAT MAKES EVERY POLARITY CLAIM BELOW MEAN SOMETHING. `hb_gpu_draw` knows
      // nothing about `u_color`, so with no correction the alpha plane of a black run and a white
      // run must be byte-identical. If this ever fails, "black gained ink and white lost it" is not
      // evidence of stem darkening — it is evidence that something else reads the colour.
      const white = plane.plainLowWhite;
      const black = plane.plainLowBlack;
      expect(
        coverageStats(white).ink,
        "the uncorrected white frame is blank, so every comparison in this block is between empty images",
      ).toBeGreaterThan(10000);
      let differing = 0;
      let worst = 0;
      for (let i = 0; i < white.length; i += 1) {
        const error = Math.abs(white[i] - black[i]);
        if (error > 0) differing += 1;
        worst = Math.max(worst, error);
      }
      expect(
        worst,
        `with contrast off, a black run and a white run differ in coverage on ${differing} px (worst ${worst}) — something other than hb_gpu_draw is reading u_color`,
      ).toBe(0);
    }, 120000);

    it("is ON by default, and darkens dark text while thinning light text", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE HEADLINE. `contrastProbe` builds the `shipped` renderer with NO `contrast` key, so
      // these frames are what a consumer gets — this fails if somebody flips the default off.
      const plainBlack = coverageStats(plane.plainLowBlack);
      const shippedBlack = coverageStats(plane.shippedLowBlack);
      const plainWhite = coverageStats(plane.plainLowWhite);
      const shippedWhite = coverageStats(plane.shippedLowWhite);

      // 1. IT FIRES AT ALL. Without this the two directional checks below could both hold on a pair
      //    of identical frames read as "0 more and 0 less".
      let differing = 0;
      for (let i = 0; i < plane.plainLowBlack.length; i += 1) {
        if (plane.plainLowBlack[i] !== plane.shippedLowBlack[i]) differing += 1;
      }
      expect(
        differing,
        `the default renderer and HB_GPU_CONTRAST_NONE produce identical frames at ${probe.lowPixelsPerEm} px/em — the shipped default is not applying any correction`,
      ).toBeGreaterThan(200);

      // 2. THE DIRECTION, AND THAT IT IS KEYED ON THE FOREGROUND. `hb_gpu_stem_darken`'s exponent
      //    is `pow (2, brightness - 0.5)` before the size ramp: 0.707 for black, 1.414 for white.
      //    Reading the brightness off the PREMULTIPLIED colour, or dropping the `- 0.5`, or losing
      //    the sign somewhere, all show up here and nowhere else.
      expect(
        shippedBlack.ink,
        `dark text lost ink under the correction (${shippedBlack.ink} against ${plainBlack.ink}) — the stem-darkening exponent is the wrong side of 1 for brightness 0`,
      ).toBeGreaterThan(plainBlack.ink);
      expect(
        shippedWhite.ink,
        `light text GAINED ink under the correction (${shippedWhite.ink} against ${plainWhite.ink}) — light-on-dark is supposed to be thinned, not fattened`,
      ).toBeLessThan(plainWhite.ink);

      // 3. THE DEEP END IS THE POINT. This is the in-repo analogue of the measurement that started
      //    the round: on a fixed crop of "Breakthrough" at DPR 1.25 the DOM path put 66% more
      //    pixels below luma 80 than this one did, at the same peak darkness and the same total
      //    ink. `deep` counts the top of the coverage ramp, which for dark text on a light page IS
      //    the dark end. Asserted as "moved a real amount", not as a target: the exponent is
      //    HarfBuzz's, the page is not this fixture, and a number tuned to hit 66% here would be a
      //    number tuned to a 128 px transparent buffer.
      expect(
        shippedBlack.deep,
        `dark text gained ${(100 * (shippedBlack.deep / plainBlack.deep - 1)).toFixed(1)}% deep-coverage pixels (${plainBlack.deep} -> ${shippedBlack.deep}) — under 10% the correction is present but too weak to be the thing that closes the gap to DOM`,
      ).toBeGreaterThan(plainBlack.deep * 1.1);

      // 4. AND IT IS A RESHAPE, NOT A BRIGHTNESS KNOB. This is the assertion that says the change
      //    has the same SHAPE as the difference it exists to close: DOM put 66% more pixels in the
      //    deep end at the same total ink, so the deep count has to move a great deal further than
      //    the ink does. Multiplying every coverage by a constant — the thing a careless "make it
      //    darker" would be — moves the two together and fails here while passing everything above.
      //    Measured on this box: ink +14.1%, deep +76.5%, a ratio of 5.4.
      const inkGain = shippedBlack.ink / plainBlack.ink - 1;
      const deepGain = shippedBlack.deep / plainBlack.deep - 1;
      expect(
        deepGain,
        `the deep end gained ${(100 * deepGain).toFixed(1)}% against ${(100 * inkGain).toFixed(1)}% more ink — a correction that moves those together is scaling the coverage rather than pushing the middle of the ramp toward the ink colour`,
      ).toBeGreaterThan(3 * inkGain);
    }, 120000);

    it("ramps itself off by ppem 48, so large text is untouched", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE OTHER HALF OF THE CLAIM, and the reason the low pair means what it says. The library's
      // exponent is `mix (pow (2, brightness - 0.5), 1, smoothstep (8, 48, ppem))`, which is
      // EXACTLY 1 at and above ppem 48 — so a 96 px/em frame must be indistinguishable from the
      // uncorrected one. Without this, "the shipped frames differ at 14 px" would be equally
      // consistent with a correction that reshapes every size, including headings.
      //
      // NOT `toBe(0)`, and the reason is arithmetic rather than slack: the exponent is exactly 1
      // but `pow (x, 1.0)` is `exp2 (log2 (x))` on a GPU, and that round trip is accurate to about
      // an ulp — which can move a byte that sits on a rounding boundary. TOLERANCE_LEVELS is this
      // file's standing allowance for exactly that, and a correction that had NOT ramped off would
      // miss it by two orders of magnitude (the low pair below moves whole frames by tens).
      for (const colour of ["White", "Black"] as const) {
        const plain = plane[`plainHigh${colour}`];
        const shipped = plane[`shippedHigh${colour}`];
        let worst = 0;
        let differing = 0;
        for (let i = 0; i < plain.length; i += 1) {
          const error = Math.abs(plain[i] - shipped[i]);
          if (error > 0) differing += 1;
          worst = Math.max(worst, error);
        }
        expect(
          worst,
          `at ${probe.highPixelsPerEm} px/em the shipped correction moves ${colour.toLowerCase()} text by ${worst} levels on ${differing} px — smoothstep (8, 48, ppem) is supposed to be 1 there, so nothing may move`,
        ).toBeLessThanOrEqual(TOLERANCE_LEVELS);
      }

      // AND IT IS NOT VACUOUS: the same comparison at 14 px is enormous. Stated here rather than
      // trusted, because a probe whose HIGH frames were accidentally drawn at 14 px too would pass
      // the loop above by drawing the same picture twice.
      let lowWorst = 0;
      for (let i = 0; i < plane.plainLowBlack.length; i += 1) {
        lowWorst = Math.max(
          lowWorst,
          Math.abs(plane.plainLowBlack[i] - plane.shippedLowBlack[i]),
        );
      }
      expect(
        lowWorst,
        `the correction moves nothing at ${probe.lowPixelsPerEm} px/em either, so the ppem-96 check above is not testing a ramp`,
      ).toBeGreaterThan(20);
    }, 120000);

    it("leaves a DILATED run's coverage alone, where it corrects a fill's", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE ASYMMETRY IS THE CLAIM, AND IT IS ONE TEST BECAUSE BOTH HALVES ARE MEASURED ON THE SAME
      // GLYPHS. Stem darkening is calibrated for a FILL: HarfBuzz's exponent fattens a dark stem
      // whose sub-pixel coverage would otherwise sit at mid-grey. A dilated frame is not that. Its
      // rim is the boundary of a union of disks — the taps have been an INSIDE test since
      // `HB_GPU_SPREAD_INSIDE_LOW`, so the coverage there is very nearly binary already — and the
      // engine being mirrored applies NO curve to its outline (plain FreeType raster, recorded in
      // the committed golden). Lifting rim coverage 0.30 -> 0.43 on that frame is a halo: fatter
      // for dark ink, thinner for light, in both cases a ramp Godot does not have.
      //
      // The shader gates stem darkening on the fill pass, so the two renderers below execute the
      // same empty contrast block on a dilated draw.
      const fillBlack = coverageStats(plane.plainLowBlack);
      const outlineBlack = coverageStats(plane.plainOutlineLowBlack);

      // 1. NON-VACUITY: THE DILATION ACTUALLY RAN. `setSpread` is sticky, and an outline frame that
      //    silently inherited spread 0 would be byte-identical to the fill frame — which would make
      //    the `toBe(0)` below true for the wrong reason and would hide exactly the bug this test
      //    exists to catch.
      expect(
        outlineBlack.ink,
        `the ${probe.outlinePx} px dilated frame carries ${outlineBlack.ink} ink against the fill's ${fillBlack.ink} (${(outlineBlack.ink / fillBlack.ink).toFixed(3)}x) — the spread did not reach the shader, so this test is comparing two fills`,
      ).toBeGreaterThan(1.6 * fillBlack.ink);

      // 2. NON-VACUITY: IT HAS PIXELS A CURVE COULD MOVE. `hb_gpu_stem_darken` is the identity at
      //    coverage 0 and 1 and the shader skips both, so a frame that were entirely saturated core
      //    and empty background would be unmovable whatever the gate did.
      expect(
        outlineBlack.ramp,
        `the dilated frame has only ${outlineBlack.ramp} partially covered pixels — a correction has almost nothing to move there, so "it moved nothing" is not evidence of a gate`,
      ).toBeGreaterThan(200);

      // 3. NON-VACUITY: THE CURVE IS ON AT THIS PPEM. Reuses the FILL frames, which are the same
      //    glyphs at the same size. This is what fails if somebody flips the shipped default off or
      //    moves `smoothstep (8, 48, ppem)`'s knee below 20 — without it, the claim below would pass
      //    on a renderer that applies no correction anywhere.
      let fillWorst = 0;
      for (let i = 0; i < plane.plainLowBlack.length; i += 1) {
        fillWorst = Math.max(
          fillWorst,
          Math.abs(plane.plainLowBlack[i] - plane.shippedLowBlack[i]),
        );
      }
      expect(
        fillWorst,
        `the shipped default moves the FILL by at most ${fillWorst} levels at ${probe.lowPixelsPerEm} px/em — the correction is not active here, so the dilated claim below has nothing to be an exception to`,
      ).toBeGreaterThan(20);

      // 4. THE CLAIM, AND IT IS EXACTLY ZERO RATHER THAN A TOLERANCE. Both polarities, because "no
      //    curve at all" and "the dark exponent happened to cancel" are different statements and
      //    only the pair distinguishes them.
      //
      //    ZERO IS PROVABLE HERE AND IS NOT ELSEWHERE. The ppem-48 test above allows
      //    TOLERANCE_LEVELS because its exponent is 1 but still an exponent, and `pow (x, 1.0)` is
      //    `exp2 (log2 (x))` on a GPU — a round trip accurate to about an ulp. On a dilated draw
      //    there is no round trip to be accurate to: stem darkening is skipped on both renderers
      //    (by uniform on `plain`, by the fill-pass gate on `shipped`) and `u_gamma` is 1 on both,
      //    so the contrast block writes back the coverage it was given, unread. Anything other than
      //    0 means a curve is still being evaluated on the rim.
      for (const colour of ["Black", "White"] as const) {
        const uncorrected = plane[`plainOutlineLow${colour}`];
        const shipped = plane[`shippedOutlineLow${colour}`];
        let worst = 0;
        let differing = 0;
        for (let i = 0; i < uncorrected.length; i += 1) {
          const error = Math.abs(uncorrected[i] - shipped[i]);
          if (error > 0) differing += 1;
          worst = Math.max(worst, error);
        }
        expect(
          worst,
          `the shipped default moves a ${probe.outlinePx} px OUTLINE by ${worst} levels on ${differing} px of ${colour.toLowerCase()} ink, where it moves the same glyphs' fill by ${fillWorst} — a dilated run must emit raw coverage, because Godot's outline is a plain FreeType raster and a curve on a dilated rim is a halo, not a crisper stem. No tolerance is allowed: with stem darkening gated off and gamma at 1 the contrast block is empty on both renderers, so there is not even a pow (x, 1.0) round trip between them`,
        ).toBe(0);
      }
    }, 120000);

    it("takes gamma as a separate, polarity-blind lever", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // GAMMA IS THE HALF THAT DOES **NOT** READ THE FOREGROUND AND DOES **NOT** RAMP WITH SIZE,
      // which is exactly why the default is 1 and why it is a separate field rather than a number
      // folded into the stem-darkening switch. Both facts are asserted, because a consumer reading
      // `HbGpuContrast` is being told them.
      const white = plane.gammaLowWhite;
      const black = plane.gammaLowBlack;
      let worst = 0;
      for (let i = 0; i < white.length; i += 1) {
        worst = Math.max(worst, Math.abs(white[i] - black[i]));
      }
      expect(
        worst,
        `gamma moved black and white differently (worst ${worst}) — it is supposed to be a plain exponent on coverage with no view of u_color`,
      ).toBe(0);

      // IT REACHED THE SHADER AT ALL, in the direction a gamma below 1 means: more coverage.
      const plainWhite = coverageStats(plane.plainLowWhite);
      const gammaWhite = coverageStats(white);
      expect(
        gammaWhite.ink,
        `contrast.gamma ${probe.gamma} did not raise coverage (${gammaWhite.ink} against ${plainWhite.ink}) — the uniform is not reaching the fragment stage`,
      ).toBeGreaterThan(plainWhite.ink * 1.05);

      // AND IT DOES NOT RAMP OFF WITH SIZE, unlike stem darkening. This is the one assertion that
      // tells the two levers apart at ppem 96: the shipped default must not move a pixel there and
      // gamma must.
      let highWorst = 0;
      for (let i = 0; i < plane.plainHighWhite.length; i += 1) {
        highWorst = Math.max(
          highWorst,
          Math.abs(plane.plainHighWhite[i] - plane.gammaHighWhite[i]),
        );
      }
      expect(
        highWorst,
        `contrast.gamma changes nothing at ${probe.highPixelsPerEm} px/em — it has picked up stem darkening's size ramp, which it must not have`,
      ).toBeGreaterThan(TOLERANCE_LEVELS);
    }, 120000);
  });

  // THE GODOT REFERENCE GOLDEN — the only claims in this file graded against another ENGINE.
  //
  // WHY IT HAD TO EXIST. Everything above grades a frame against an 8x rasterisation of the same
  // outline, which answers "did the blob reach the shader intact" and "is the dilation the union of
  // disks it claims to be" — and answers neither of the two questions this round is actually about.
  // "Is the rim as sharp as Godot's" has no answer inside this repo, because the reference is a
  // different engine's rasteriser and no amount of supersampling here reproduces it. So Godot draws
  // the same five cases once, `scripts/godot-outline-ref.ts` measures them with the same pure
  // module this file uses, and the numbers are committed.
  //
  // A MISSING GOLDEN IS A FAILURE, NOT A SKIP. It is committed, like `vendor/`, and a suite that
  // quietly skipped when it went missing would be a suite that stopped grading the thing it exists
  // to grade at exactly the moment somebody deleted its reference.
  describe("godot outline", () => {
    let golden: GodotGolden;
    let probe: GodotOutlineProbeResult;
    /** `<case>` -> `<column>` -> metrics. Columns are `none`, `defaultWhite`, `defaultBlack`. */
    const ours = new Map<string, Record<string, OutlineMetrics>>();
    /** The same keys, unreduced. A metric can agree while the pixels behind it do not. */
    const planes = new Map<string, Record<string, Uint8Array>>();
    /**
     * The `none` column again at {@link SPREAD_OUTER_RING_STEPS} cycles — the rate the CURRENT tap
     * set could scallop at, where the map above holds the rate the OLD one did.
     */
    const outerHarmonics = new Map<string, RadialOutlineMetrics>();

    const godotCase = (name: string): GodotGoldenCase => {
      const found = golden.cases.find((item) => item.name === name);
      if (!found) {
        throw new Error(
          `the committed golden has no case "${name}" (has ${golden.cases.map((c) => c.name).join(", ")})`,
        );
      }
      return found;
    };

    beforeAll(async () => {
      if (skipReason) return;
      golden = JSON.parse(await readFile(goldenFile, "utf8")) as GodotGolden;
      probe = await page.evaluate(() => window.__gswHbGpu.godotOutlineProbe());
      for (const item of GODOT_OUTLINE_CASES) {
        const columns: Record<string, OutlineMetrics> = {};
        const raw: Record<string, Uint8Array> = {};
        for (const column of ["none", "defaultWhite", "defaultBlack"]) {
          const plane = alphaPlane(
            new Uint8Array(
              Buffer.from(probe.frames[`${item.name}.${column}`], "base64"),
            ),
          );
          raw[column] = plane;
          columns[column] = measureOutline(
            { data: plane, width: probe.width, height: probe.height },
            { radial: item.radial },
          );
        }
        ours.set(item.name, columns);
        planes.set(item.name, raw);
        // THE SECOND HARMONIC READ, AND ONLY ON THE GRADED COLUMN. Nothing else about the profile
        // changes with `harmonic` — it is one DFT coefficient of the same 256 rays — so this is a
        // second reduction of one measurement, not a second measurement.
        if (item.radial) {
          const outer = measureOutline(
            { data: raw.none, width: probe.width, height: probe.height },
            { radial: true, harmonic: SPREAD_OUTER_RING_STEPS },
          ).radial;
          if (outer) outerHarmonics.set(item.name, outer);
        }
      }

      // ONE TABLE, MEASURED AND PRINTED BEFORE ANYTHING IS ASSERTED — this file's rule, and the
      // reason the budgets below could be calibrated at all.
      console.log(
        `hb-gpu godot outline: golden from ${golden.godot} on ${golden.adapter}, oversampling ${golden.oversampling}, font ${golden.fontSha256.slice(0, 12)}`,
      );
      for (const item of GODOT_OUTLINE_CASES) {
        const reference = godotCase(item.name);
        const columns = ours.get(item.name);
        if (!columns) continue;
        const ramp = (metrics: OutlineMetrics): string =>
          (metrics.radial?.rampWidthPx ?? metrics.gradientRampWidthPx)?.toFixed(
            3,
          ) ?? "n/a";
        const godotRamp =
          (
            reference.metrics.radial?.rampWidthPx ??
            reference.metrics.gradientRampWidthPx
          )?.toFixed(3) ?? "n/a";
        console.log(
          `  ${item.name.padEnd(16)} ppem ${String(item.pixelsPerEm).padStart(3)} r ${String(item.spreadPx).padStart(5)} | ramp godot ${godotRamp} ours ${ramp(columns.none)} (default white ${ramp(columns.defaultWhite)}, black ${ramp(columns.defaultBlack)}) | ink godot ${reference.metrics.ink.toFixed(1)} ours ${columns.none.ink.toFixed(1)} (${(columns.none.ink / reference.metrics.ink).toFixed(3)}x), black ${columns.defaultBlack.ink.toFixed(1)} (${(columns.defaultBlack.ink / reference.metrics.ink).toFixed(3)}x)`,
        );
        // WHAT THE SHIPPING DEFAULT DOES TO THE GRADED FRAME, in bytes rather than in a reduced
        // metric — the number the test below asserts to zero. Printed for every case whatever it
        // reads, because "the curve is off here" and "the curve is on but this case's rim happens
        // not to move" are different findings and only the byte count tells them apart.
        const raw = planes.get(item.name);
        if (raw) {
          const against = (column: string): string => {
            let worst = 0;
            let differing = 0;
            for (let i = 0; i < raw.none.length; i += 1) {
              const error = Math.abs(raw.none[i] - raw[column][i]);
              if (error > 0) differing += 1;
              worst = Math.max(worst, error);
            }
            return `${column} ${worst} lv on ${differing} px`;
          };
          console.log(
            `  ${"".padEnd(16)} vs none | ${against("defaultWhite")} | ${against("defaultBlack")}`,
          );
        }
        if (item.radial) {
          const gr = reference.metrics.radial;
          const nr = columns.none.radial;
          const dr = columns.defaultBlack.radial;
          const outer = outerHarmonics.get(item.name);
          console.log(
            `  ${"".padEnd(16)} radial | r50 godot ${gr?.r50Mean?.toFixed(3)} ours ${nr?.r50Mean?.toFixed(3)} (black ${dr?.r50Mean?.toFixed(3)}) | stdev godot ${gr?.r50Stdev?.toFixed(4)} ours ${nr?.r50Stdev?.toFixed(4)} | h${nr?.harmonic} godot ${gr?.harmonicAmplitudePx?.toFixed(4)} ours ${nr?.harmonicAmplitudePx?.toFixed(4)} | h${SPREAD_OUTER_RING_STEPS} ours ${outer?.harmonicAmplitudePx?.toFixed(4)} | ink/disk godot ${reference.inkVsDiskOfR50?.toFixed(3)} ours ${nr?.r50Mean ? (columns.none.ink / (Math.PI * nr.r50Mean ** 2)).toFixed(3) : "n/a"}`,
          );
          // THE GRADIENT FORM BESIDE THE RADIAL ONE, on the radial cases only. It shares none of
          // the ray sampler's arithmetic, so where `rampWidthPx` clamps at its own floor (see
          // GODOT_RAMP_BUDGET_PX) this is the column that still has resolution — and the constants
          // above quote it, so it has to be printed rather than obtained from a one-off probe.
          console.log(
            `  ${"".padEnd(16)} gradient ramp | godot ${reference.metrics.gradientRampWidthPx?.toFixed(3)} ours ${columns.none.gradientRampWidthPx?.toFixed(3)}`,
          );
        }
      }
    }, 180000);

    it("was built from THIS font and THIS case list", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE PROVENANCE GUARD, AND IT IS THE ASSERTION THE REST OF THE BLOCK RESTS ON. A golden of
      // NUMBERS carries no picture, so nothing about it fails visibly when the thing it describes
      // changes underneath: regenerate the fixture font, or edit a pen in `GODOT_OUTLINE_CASES`,
      // and every comparison below silently becomes a comparison between two different fixtures
      // that still produces plausible-looking numbers.
      const fontBytes = await readFile(fontFile);
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(fontBytes).digest("hex");
      expect(
        sha256,
        `the fixture font on disk is not the one the golden was rendered from — regenerate it with \`pnpm -w run godot:outline-ref\` rather than comparing this checkout's glyphs against another one's`,
      ).toBe(golden.fontSha256);

      // AND THE CASE LIST, FIELD BY FIELD. `GODOT_OUTLINE_CASES` is the single source both engines
      // read, so a change to it that is not reflected in the golden means Godot drew one geometry
      // and this page drew another.
      const graded = golden.cases.filter((item) => item.graded);
      expect(
        graded.map((item) => item.case),
        "the golden's graded case list is not GODOT_OUTLINE_CASES",
      ).toEqual(GODOT_OUTLINE_CASES.map((item) => item.name));
      for (const item of GODOT_OUTLINE_CASES) {
        const reference = godotCase(item.name);
        expect(
          {
            text: reference.text,
            pixelsPerEm: reference.pixelsPerEm,
            spreadPx: reference.spreadPx,
            outlineSize: reference.outlineSize,
            originX: reference.originX,
            originY: reference.originY,
            cellSize: reference.cellSize,
          } satisfies Partial<GodotOutlineCase> & { cellSize: number },
          `case "${item.name}" differs between GODOT_OUTLINE_CASES and the committed golden`,
        ).toEqual({
          text: item.text,
          pixelsPerEm: item.pixelsPerEm,
          spreadPx: item.spreadPx,
          outlineSize: item.outlineSize,
          originX: item.originX,
          originY: item.originY,
          cellSize: item.size,
        });
      }

      // AND `outline_size / 4` IS THE RADIUS, restated from the committed table rather than
      // trusted. This is the one geometric fact both engines' fixtures are built on.
      for (const item of GODOT_OUTLINE_CASES) {
        expect(item.outlineSize / 4).toBe(item.spreadPx);
      }
    }, 120000);

    it("reaches where Godot's outline reaches", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // THE ONE ABSOLUTE GEOMETRIC CLAIM AGAINST ANOTHER ENGINE, and the only one this stage
      // grades tightly. Reach is where `u_spreadPx = outline_size / 4` is either right or wrong;
      // softness is the thing Stages 1 and 2 are going to change, so its budgets stay provisional.
      //
      // ONLY THE ROUND CASES CARRY IT. `r50Mean` is the mean radius of the 50% contour measured
      // from the coverage centroid, which is a reach on a dot and a description of the glyph's
      // silhouette on a 中.
      for (const item of GODOT_OUTLINE_CASES.filter((c) => c.radial)) {
        const reference = godotCase(item.name).metrics.radial;
        const mine = ours.get(item.name)?.none?.radial;
        const godotR50 = reference?.r50Mean;
        const ourR50 = mine?.r50Mean;
        if (godotR50 == null || ourR50 == null) {
          throw new Error(`no radial profile for ${item.name}`);
        }
        // NON-VACUITY: both sides drew something round enough to profile.
        expect(mine?.raysMeasured).toBe(mine?.rays);
        expect(
          Math.abs(ourR50 - godotR50),
          `${item.name}: this package's dilation reaches ${ourR50.toFixed(3)} px where Godot's outline reaches ${godotR50.toFixed(3)} (${(ourR50 - godotR50 >= 0 ? "+" : "") + (ourR50 - godotR50).toFixed(3)}) — at spread ${item.spreadPx} that is a disagreement about what \`outline_size / 4\` means, not about how sharp a rim is`,
        ).toBeLessThan(GODOT_REACH_BUDGET_PX);
      }
    }, 180000);

    it("draws its SHIPPING outline with no contrast curve, exactly as Godot does", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // WHAT MAKES THE BUDGET BELOW A CLAIM ABOUT THE PRODUCT. Every other column in this block is
      // `HB_GPU_CONTRAST_NONE`, for the reason `GRADED_AGAINST_COVERAGE` gives — but a consumer
      // does not pass that, and for a while the frame it did get was a different picture: the
      // shipped stem-darkening curve ran on the FINAL coverage, after the dilation, so the outline
      // carried a correction the engine being mirrored has no analogue for. Godot's outline is a
      // plain FreeType raster; `outline_ref.gd` sets no gamma and no darkening and there is nothing
      // to set. The shader now gates stem darkening on the fill pass, and the assertion is that the
      // three columns are ONE frame.
      //
      // EXACTLY ZERO, FOR THE SAME REASON THE CONTRAST BLOCK'S DILATED TEST IS. With darkening
      // skipped and `u_gamma` at 1 the contrast block is empty on both renderers — no `pow` is
      // evaluated at all, so there is not even an `exp2 (log2 (x))` round trip to allow a level
      // for. A tolerance here would accept a curve that had merely been weakened.
      for (const item of GODOT_OUTLINE_CASES) {
        const columns = planes.get(item.name);
        if (!columns) throw new Error(`no frames for ${item.name}`);
        // NON-VACUITY: three blank frames are also byte-identical. The reach and rim tests grade
        // `none` against Godot's own ink, so it is the DEFAULT columns that could be empty here
        // without anything else in the file noticing.
        for (const column of ["defaultWhite", "defaultBlack"] as const) {
          expect(
            ours.get(item.name)?.[column]?.ink,
            `${item.name}: the ${column} frame is blank, so "identical to the uncorrected column" is a comparison between empty images`,
          ).toBeGreaterThan(0.4 * godotCase(item.name).metrics.ink);
          let worst = 0;
          let differing = 0;
          for (let i = 0; i < columns.none.length; i += 1) {
            const error = Math.abs(columns.none[i] - columns[column][i]);
            if (error > 0) differing += 1;
            worst = Math.max(worst, error);
          }
          expect(
            worst,
            `${item.name}: the shipping default moves the dilated frame by ${worst} levels on ${differing} px of ${column === "defaultBlack" ? "dark" : "light"} ink against HB_GPU_CONTRAST_NONE — a contrast curve is running on an outline, where Godot has none, and every budget in this block is then grading a frame the consumer does not get`,
          ).toBe(0);
        }
      }
    }, 180000);

    it("carries a rim within a provisional distance of Godot's", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // PROVISIONAL, AND SAID SO IN THE NAME. Two of the three mechanisms behind this gap are
      // being fixed in the next two stages of this round — the contrast curve running on the
      // DILATED coverage, and the tap budget that stops tiling its own disk past ~2.7 px. So the
      // budgets here are the measured values plus headroom, chosen so that today's shader passes
      // and a REGRESSION fails, and they get tightened by the commits that earn it.
      //
      // The graded column is `none`, and it is now the SAME PIXELS as the two shipping columns —
      // the test above asserts that byte for byte, which is what makes this budget a claim about
      // what a consumer sees rather than about a measurement arm. Before stem darkening was gated
      // off the dilated pass they were three different frames, and `defaultWhite` at han-desktop
      // read 1.965 px against this column's 0.662.
      for (const item of GODOT_OUTLINE_CASES) {
        const reference = godotCase(item.name);
        const columns = ours.get(item.name);
        if (!columns) throw new Error(`no frames for ${item.name}`);
        const godotRamp =
          reference.metrics.radial?.rampWidthPx ??
          reference.metrics.gradientRampWidthPx;
        const ourRamp =
          columns.none.radial?.rampWidthPx ?? columns.none.gradientRampWidthPx;
        if (godotRamp == null || ourRamp == null) {
          throw new Error(`no ramp width for ${item.name}`);
        }

        // NON-VACUITY FIRST: a blank frame has no ramp and no ink, and would sail through a
        // "within N px of Godot" budget by having no boundary at all.
        expect(
          columns.none.ink,
          `${item.name}: the frame has no ink — every column here would score that as a pass`,
        ).toBeGreaterThan(0.4 * reference.metrics.ink);

        expect(
          ourRamp - godotRamp,
          `${item.name}: this package's rim is ${ourRamp.toFixed(3)} px wide against Godot's ${godotRamp.toFixed(3)} (+${(ourRamp - godotRamp).toFixed(3)}) — past ${GODOT_RAMP_BUDGET_PX} px softer than the engine being mirrored is a regression on the number this round exists to move`,
        ).toBeLessThan(GODOT_RAMP_BUDGET_PX);
      }
    }, 180000);

    it("keeps the dilated boundary round, and reports the tap-count signature", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // SCALLOP, SEPARATED FROM SOFTNESS. `r50Stdev` says the boundary wobbles; an amplitude at a
      // TAP COUNT says it wobbles at exactly the rate the tap set would produce, which noise and a
      // shallow-coverage mottle do not. `dot-radial-wide` is the fixture in the sparse-covering
      // regime, and it is the one the tap redistribution had to move.
      //
      // TWO HARMONICS, AND BOTH ARE ASSERTED. 16 is what the OLD nested loop's per-ring clamp
      // produced and is the number the defect was found at; 26 is what the outermost ring runs now
      // (see SPREAD_OUTER_RING_STEPS), so it is where a residual scallop would move to. Pinning
      // only the old one would pass a shader that had merely relabelled its own defect.
      for (const item of GODOT_OUTLINE_CASES.filter((c) => c.radial)) {
        const reference = godotCase(item.name).metrics.radial;
        const mine = ours.get(item.name)?.none?.radial;
        if (!reference || !mine) throw new Error(`no radial for ${item.name}`);
        const outer = outerHarmonics.get(item.name);
        if (!outer) throw new Error(`no outer harmonic for ${item.name}`);
        const godotStdev = reference.r50Stdev ?? 0;
        const ourStdev = mine.r50Stdev ?? 0;
        const ourHarmonic = mine.harmonicAmplitudePx;
        const ourOuterHarmonic = outer.harmonicAmplitudePx;
        // NON-VACUITY: a partial profile makes the harmonic `null` by design, and `null` must not
        // slide through a numeric budget as a zero.
        expect(
          ourHarmonic,
          `${item.name}: no ${mine.harmonic}-cycle amplitude was measured — some ray found no crossing, so the scallop claim below has no profile behind it`,
        ).not.toBeNull();
        expect(
          ourOuterHarmonic,
          `${item.name}: no ${outer.harmonic}-cycle amplitude was measured, so the current tap set's own signature has no profile behind it`,
        ).not.toBeNull();
        expect(
          ourStdev,
          `${item.name}: the dilated boundary wobbles by ${ourStdev.toFixed(4)} px against Godot's ${godotStdev.toFixed(4)} at the same radius — past ${GODOT_SCALLOP_BUDGET_PX} px the tap set has stopped approximating a disk`,
        ).toBeLessThan(GODOT_SCALLOP_BUDGET_PX);
        expect(
          ourHarmonic ?? 0,
          `${item.name}: the boundary carries ${ourHarmonic?.toFixed(4)} px at ${mine.harmonic} cycles per revolution against Godot's ${reference.harmonicAmplitudePx?.toFixed(4)} — that is the rate the OLD per-ring step clamp caps taps at, so past ${GODOT_HARMONIC_BUDGET_PX} px the boundary is following that tap count rather than a circle`,
        ).toBeLessThan(GODOT_HARMONIC_BUDGET_PX);
        // PER PX OF RADIUS, not a flat px. The outermost ring's step count is fixed, so its sagitta
        // grows with the radius and a flat budget on this bin is a budget with a radius hidden in
        // it — see GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS.
        const outerBudget = outerHarmonicBudgetPx(item.spreadPx);
        expect(
          ourOuterHarmonic ?? 0,
          `${item.name}: the boundary carries ${ourOuterHarmonic?.toFixed(4)} px at ${outer.harmonic} cycles per revolution — that is the outermost ring's OWN tap count under the current budget split, so past ${outerBudget.toFixed(4)} px (${GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS} per px of the radius ${item.spreadPx}) the redistribution has only moved the scallop to a finer pitch`,
        ).toBeLessThan(outerBudget);
      }
    }, 180000);
  });
});

/** One case's row of the committed Godot golden. */
interface GodotGoldenCase {
  name: string;
  case: string;
  graded: boolean;
  hinting: number;
  text: string;
  pixelsPerEm: number;
  outlineSize: number;
  spreadPx: number;
  originX: number;
  originY: number;
  cellSize: number;
  metrics: OutlineMetrics;
  inkVsDiskOfR50: number | null;
}

/** `packages/hb-gpu/test/goldens/godot-outline-metrics.json`, as `godot-outline-ref.ts` writes it. */
interface GodotGolden {
  schema: string;
  godot: string;
  adapter: string;
  oversampling: number;
  fontSha256: string;
  calibration: { alpha: number; expected: number; measured: number }[];
  realism: { differingPixels: number; worstDelta: number };
  cases: GodotGoldenCase[];
}

/** esbuild on the parity suite's recipe: `conditions: ["development"]` is what makes
 *  `@godot-scene-web/canvas` resolve to its TypeScript SOURCE, so the page runs the code under
 *  review rather than a `dist/` that may not be built. */
async function bundleBrowserEntry(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(here, "browser-entry.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
    conditions: ["development"],
    write: false,
    sourcemap: "inline",
    absWorkingDir: join(here, ".."),
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error("hb-gpu: esbuild produced no output for the browser entry");
  }
  return file.text;
}
