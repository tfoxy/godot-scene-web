// Gate -1 pass-criteria checks, factored out of check-gate-minus1.ts so
// scripts/test/self-test-checker.ts can exercise each one directly against fabricated evidence
// (see scripts/README.md "Checker self-test"). Pure functions: every check reads files under a
// given evidence directory and returns Criterion[] (or Promise<Criterion[]> for the pixel checks,
// which decode PNGs); nothing here launches a process or mutates anything.
//
// The capture library's evidence shapes (result.json, counters.json, fingerprint.json,
// disarm.json, armed.marker) are documented in ../../README.md "Runtime contract" and read here
// field for field. "unavailable" is reserved for evidence the HOST could not produce (strace not
// installed); a missing or malformed capture-library field is a "fail".

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";

export type CriterionStatus = "pass" | "fail" | "unavailable";

export interface Criterion {
  id: string;
  description: string;
  status: CriterionStatus;
  evidence: string;
  detail?: string;
}

// ---------------------------------------------------------------------------------------------
// Small IO helpers. Every one of these is forgiving: a missing/unparseable file is `undefined`,
// never a thrown error -- a criterion function decides what that means for ITS verdict.
// ---------------------------------------------------------------------------------------------

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function readTextOrUndefined(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** "0x43554000", "43554000", "0X43554000" all normalize to "0x43554000". */
export function normalizeHex32(hex: string): string {
  const stripped = hex.replace(/^0x/i, "");
  const value = Number.parseInt(stripped, 16);
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function hexArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (value, index) => normalizeHex32(value) === normalizeHex32(b[index]),
  );
}

function hexMatrixEqual(
  a: readonly (readonly string[])[],
  b: readonly (readonly string[])[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => hexArrayEqual(row, b[index]));
}

// ---------------------------------------------------------------------------------------------
// Capture-library evidence shapes (render-stream-gate-minus1-counters/1 and friends). Fields are
// optional in the types so a missing one is reported as a failed criterion, never a crash.
// ---------------------------------------------------------------------------------------------

interface CapturedAddRect {
  item?: string;
  rect?: number[];
  rect_bits?: string[];
  color?: number[];
  color_bits?: string[];
  antialiased?: boolean;
}

interface CapturedAddPolygon {
  points?: number[][];
  point_bits?: string[][];
  colors?: number[][];
  color_bits?: string[][];
  uvs_count?: number;
}

interface CapturedTexture {
  rid?: string;
  frame?: number;
  layer?: number;
  width?: number;
  height?: number;
  details?: boolean;
}

interface CountersJson {
  schema?: string;
  frames_total?: number;
  frames_armed?: number;
  counts?: Record<string, number>;
  captured?: {
    canvas_item_add_rect?: CapturedAddRect[];
    canvas_item_add_polygon?: CapturedAddPolygon[];
    texture_2d_create?: CapturedTexture[];
    texture_2d_update?: CapturedTexture[];
    [key: string]: unknown;
  };
}

interface ResultJson {
  schema?: string;
  status?: "armed" | "validated" | "refused" | "error";
  reason?: string;
  vptr_written?: boolean;
  disarmed?: boolean;
  display_server?: string;
}

interface DisarmJson {
  disarmed?: boolean;
  vptr_was_shadow?: boolean;
  vptr_restored?: boolean;
  frame?: number;
}

interface ExpectedAddRect {
  rect: number[];
  rect_bits: string[];
  color: number[];
  color_bits: string[];
  antialiased: boolean;
}

interface ExpectedAddPolygon {
  points: number[][];
  point_bits: string[][];
  colors: number[][];
  color_bits: string[][];
  point_count: number;
  uvs_count: number;
}

export interface ExpectedJson {
  script_add_rect: ExpectedAddRect;
  script_add_polygon: ExpectedAddPolygon;
  colorrect_add_rect: ExpectedAddRect;
  label_glyphs: { relabel_frame: number };
  frames_total: number;
  screenshot_default_frame: number;
}

// ---------------------------------------------------------------------------------------------
// #1 extension initialized; frame callback ticked
// ---------------------------------------------------------------------------------------------

export async function checkFrameCallbackTicked(
  outDir: string,
): Promise<Criterion> {
  const evidencePath = join(
    outDir,
    "headless-armed",
    "evidence",
    "counters.json",
  );
  const counters = await readJson<CountersJson>(evidencePath);
  if (!counters) {
    return {
      id: "frame-callback-ticked",
      description:
        "extension initialized; frame callback ticked (counters.json frames_total >= 300)",
      status: "fail",
      evidence: evidencePath,
      detail: "counters.json missing or unparseable",
    };
  }
  const framesTotal = counters.frames_total ?? -1;
  return {
    id: "frame-callback-ticked",
    description:
      "extension initialized; frame callback ticked (counters.json frames_total >= 300)",
    status: framesTotal >= 300 ? "pass" : "fail",
    evidence: evidencePath,
    detail: `frames_total=${framesTotal}`,
  };
}

// ---------------------------------------------------------------------------------------------
// #1 (continued) the capture host really is headless: identified by display server NAME (the
// rendering driver/method a headless process reports are the configured ones and prove nothing),
// plus process evidence that no graphics device or GPU driver library was ever touched.
// ---------------------------------------------------------------------------------------------

/** Graphics-device paths and GPU driver/loader libraries a truly headless host never opens. */
const GPU_PATH_RE =
  /\/dev\/dri\/|\/dev\/nvidia|libvulkan|libGL|libEGL|libnvidia|libdrm|libgbm/;

/** Every openat in an `strace -f` log that returned a descriptor, as its (re-joined) call line.
 * A call split by another thread into "<unfinished ...>" and "<... openat resumed>" lines is
 * joined back up per pid, so its path and its result are judged together. */
export function successfulOpenats(straceText: string): string[] {
  const pending = new Map<string, string>();
  const opened: string[] = [];
  for (const line of straceText.split("\n")) {
    const pid = /^(?:\[pid\s+)?(\d+)\]?\s/.exec(line)?.[1] ?? "";
    if (/\bopenat\(.*<unfinished \.\.\.>$/.test(line)) {
      pending.set(pid, line);
      continue;
    }
    let call = line;
    const resumed = /<\.\.\. openat resumed>(.*)$/.exec(line);
    if (resumed) {
      call = `${pending.get(pid) ?? ""} ${resumed[1]}`;
      pending.delete(pid);
    } else if (!/\bopenat\(/.test(line)) {
      continue;
    }
    if (/\)\s*=\s*\d+(\s|$)/.test(call)) opened.push(call);
  }
  return opened;
}

export async function checkHeadlessNoGpu(outDir: string): Promise<Criterion> {
  const id = "headless-no-gpu";
  const description =
    "headless-armed host reports display server 'headless' and never opens a GPU device or driver library (whole-run strace openat + /proc maps/fd sampled after arming)";
  const legDir = join(outDir, "headless-armed");
  const resultPath = join(legDir, "evidence", "result.json");
  const mapsPath = join(legDir, "maps.txt");
  const fdPath = join(legDir, "fd.txt");
  const stracePath = join(legDir, "strace.txt");
  const evidence = [resultPath, mapsPath, fdPath, stracePath].join(", ");

  if (await fileExists(join(legDir, "strace-status.txt"))) {
    return {
      id,
      description,
      status: "unavailable",
      evidence,
      detail: "strace was not installed when this leg ran",
    };
  }

  const problems: string[] = [];
  const result = await readJson<ResultJson>(resultPath);
  if (result?.display_server !== "headless") {
    problems.push(
      `display_server=${JSON.stringify(result?.display_server)}, expected "headless"`,
    );
  }

  const maps = await readTextOrUndefined(mapsPath);
  const fd = await readTextOrUndefined(fdPath);
  const strace = await readTextOrUndefined(stracePath);
  if (!maps) problems.push("maps.txt missing or empty");
  if (!fd) problems.push("fd.txt missing or empty");
  if (!strace) problems.push("strace.txt missing or empty");

  const gpuMaps = (maps ?? "")
    .split("\n")
    .filter((line) => GPU_PATH_RE.test(line));
  const gpuFds = (fd ?? "")
    .split("\n")
    .filter((line) => GPU_PATH_RE.test(line));
  // Successful opens only: a failed probe (= -1 ENOENT) touched nothing.
  const gpuOpens = successfulOpenats(strace ?? "").filter((line) =>
    GPU_PATH_RE.test(line),
  );
  if (gpuMaps.length > 0)
    problems.push(
      `maps.txt maps GPU libraries: ${gpuMaps.slice(0, 3).join(" | ")}`,
    );
  if (gpuFds.length > 0)
    problems.push(`fd.txt holds GPU fds: ${gpuFds.slice(0, 3).join(" | ")}`);
  if (gpuOpens.length > 0)
    problems.push(`strace shows ${gpuOpens.length} GPU openat: ${gpuOpens[0]}`);

  const mapsLines = (maps ?? "").split("\n").filter(Boolean).length;
  const fdLines = (fd ?? "").split("\n").filter((l) => l.includes("->")).length;
  return {
    id,
    description,
    status: problems.length === 0 ? "pass" : "fail",
    evidence,
    detail:
      problems.length === 0
        ? `display_server=headless; ${mapsLines} maps lines, ${fdLines} fds, 0 GPU paths; 0 GPU openat in strace`
        : problems.join("; "),
  };
}

// ---------------------------------------------------------------------------------------------
// #2 validate leg validated without a write; every refusal leg refused for the expected reason
// ---------------------------------------------------------------------------------------------

async function checkResultStatus(
  outDir: string,
  legName: string,
  id: string,
  description: string,
  expectedStatus: ResultJson["status"],
  expectedReason: string | undefined,
): Promise<Criterion> {
  const evidencePath = join(outDir, legName, "evidence", "result.json");
  const result = await readJson<ResultJson>(evidencePath);
  if (!result) {
    return {
      id,
      description,
      status: "fail",
      evidence: evidencePath,
      detail: "result.json missing or unparseable",
    };
  }
  const problems: string[] = [];
  if (result.status !== expectedStatus) {
    problems.push(
      `status=${JSON.stringify(result.status)}, expected ${JSON.stringify(expectedStatus)}`,
    );
  }
  if (expectedReason !== undefined && result.reason !== expectedReason) {
    problems.push(
      `reason=${JSON.stringify(result.reason)}, expected ${JSON.stringify(expectedReason)}`,
    );
  }
  if (result.vptr_written !== false) {
    problems.push(
      `vptr_written=${JSON.stringify(result.vptr_written)}, expected false`,
    );
  }
  return {
    id,
    description,
    status: problems.length === 0 ? "pass" : "fail",
    evidence: evidencePath,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
  };
}

export async function checkValidateAndRefusals(
  outDir: string,
): Promise<Criterion[]> {
  return Promise.all([
    checkResultStatus(
      outDir,
      "headless-validate",
      "validate-no-write",
      "validate leg validated without writing the vptr",
      "validated",
      undefined,
    ),
    checkResultStatus(
      outDir,
      "refuse-sha",
      "refuse-sha",
      "tampered engine.sha256 is refused as fingerprint-mismatch, vptr never written",
      "refused",
      "fingerprint-mismatch",
    ),
    checkResultStatus(
      outDir,
      "refuse-prefix",
      "refuse-prefix",
      "tampered slots/anchors/object_prefix is refused as slot-mask-mismatch, vptr never written",
      "refused",
      "slot-mask-mismatch",
    ),
    checkResultStatus(
      outDir,
      "refuse-nocal",
      "refuse-nocal",
      "missing GRC_CALIBRATION is refused as no-calibration, vptr never written",
      "refused",
      "no-calibration",
    ),
    checkResultStatus(
      outDir,
      "refuse-binary-byte",
      "refuse-binary-byte",
      "one tampered byte in a non-code section is refused as fingerprint-mismatch, vptr never written",
      "refused",
      "fingerprint-mismatch",
    ),
  ]);
}

// ---------------------------------------------------------------------------------------------
// #3 counts > 0 for the ColorRect add_rect, the script add_rect, and the Label glyph path
// #4 script rect/color captured bit-exact vs expected.json  (folded into the script-add-rect
//    check below: "matching" in #3 and "bit-exact" in #4 are the same comparison against the
//    same captured entry, so this reports one criterion rather than testing the same bits twice)
// ---------------------------------------------------------------------------------------------

function findMatchingAddRect(
  captured: CapturedAddRect[],
  expected: ExpectedAddRect,
): CapturedAddRect | undefined {
  return captured.find(
    (entry) =>
      entry.rect_bits &&
      entry.color_bits &&
      hexArrayEqual(entry.rect_bits, expected.rect_bits) &&
      hexArrayEqual(entry.color_bits, expected.color_bits),
  );
}

export async function checkCaptureCounts(
  outDir: string,
  expected: ExpectedJson,
): Promise<Criterion[]> {
  const evidencePath = join(
    outDir,
    "headless-armed",
    "evidence",
    "counters.json",
  );
  const counters = await readJson<CountersJson>(evidencePath);

  if (!counters) {
    const missing = (id: string, description: string): Criterion => ({
      id,
      description,
      status: "fail",
      evidence: evidencePath,
      detail: "counters.json missing or unparseable",
    });
    return [
      missing(
        "colorrect-add-rect",
        "ColorRect's engine-internal draw is captured as canvas_item_add_rect",
      ),
      missing(
        "script-add-rect",
        "the script's direct add_rect call is captured bit-exact vs expected.json",
      ),
      missing(
        "label-glyph-path",
        "the Label's glyph draws are captured as a texture_rect_region call",
      ),
    ];
  }

  const capturedRects = counters.captured?.canvas_item_add_rect ?? [];
  const colorrectMatch = findMatchingAddRect(
    capturedRects,
    expected.colorrect_add_rect,
  );
  const scriptMatch = findMatchingAddRect(
    capturedRects,
    expected.script_add_rect,
  );

  const counts = counters.counts ?? {};
  const textureRectRegionCount =
    (counts.canvas_item_add_texture_rect_region ?? 0) +
    (counts.canvas_item_add_msdf_texture_rect_region ?? 0);
  // The relabel at expected.label_glyphs.relabel_frame introduces new glyphs, so the font atlas
  // must be created and then updated no earlier than that frame (texture captures carry the
  // 1-based iteration they arrived in, the same numbering as the fixture's frame counter).
  const relabelFrame = expected.label_glyphs.relabel_frame;
  const atlasCreates = counts.texture_2d_create ?? 0;
  const lateUpdates = (counters.captured?.texture_2d_update ?? []).filter(
    (entry) => (entry.frame ?? -1) >= relabelFrame,
  );
  const glyphOk =
    textureRectRegionCount > 0 && atlasCreates > 0 && lateUpdates.length > 0;

  return [
    {
      id: "colorrect-add-rect",
      description:
        "ColorRect's engine-internal draw is captured as canvas_item_add_rect, matching expected.json's colorrect_add_rect bit-exact",
      status: colorrectMatch ? "pass" : "fail",
      evidence: evidencePath,
      detail: colorrectMatch
        ? `matched captured item=${colorrectMatch.item ?? "?"}`
        : `no entry in captured.canvas_item_add_rect (${capturedRects.length} captured) matched rect_bits=${JSON.stringify(expected.colorrect_add_rect.rect_bits)} color_bits=${JSON.stringify(expected.colorrect_add_rect.color_bits)}`,
    },
    {
      id: "script-add-rect",
      description:
        "the script's direct add_rect call is captured, matching expected.json's script_add_rect bit-exact (covers spec items 3 and 4)",
      status: scriptMatch ? "pass" : "fail",
      evidence: evidencePath,
      detail: scriptMatch
        ? `matched captured item=${scriptMatch.item ?? "?"}`
        : `no entry in captured.canvas_item_add_rect (${capturedRects.length} captured) matched rect_bits=${JSON.stringify(expected.script_add_rect.rect_bits)} color_bits=${JSON.stringify(expected.script_add_rect.color_bits)}`,
    },
    {
      id: "label-glyph-path",
      description:
        "the Label's glyph draws are captured via canvas_item_add_texture_rect_region or canvas_item_add_msdf_texture_rect_region (either counts), its atlas via texture_2d_create, and the relabel's new glyphs via a texture_2d_update at or after the relabel frame",
      status: glyphOk ? "pass" : "fail",
      evidence: evidencePath,
      detail: `canvas_item_add_texture_rect_region=${counts.canvas_item_add_texture_rect_region ?? 0}, canvas_item_add_msdf_texture_rect_region=${counts.canvas_item_add_msdf_texture_rect_region ?? 0}, texture_2d_create=${atlasCreates}, texture_2d_update=${counts.texture_2d_update ?? 0} (frames ${JSON.stringify((counters.captured?.texture_2d_update ?? []).map((entry) => entry.frame ?? null))}; ${lateUpdates.length} at/after relabel frame ${relabelFrame})`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// #5 polygon points/colors decode exactly with count 3
// ---------------------------------------------------------------------------------------------

export async function checkPolygonBitExact(
  outDir: string,
  expected: ExpectedJson,
): Promise<Criterion> {
  const evidencePath = join(
    outDir,
    "headless-armed",
    "evidence",
    "counters.json",
  );
  const id = "polygon-bit-exact";
  const description =
    "the script's add_polygon call decodes exactly (3 points/colors, uvs_count 0) vs expected.json";
  const counters = await readJson<CountersJson>(evidencePath);
  if (!counters) {
    return {
      id,
      description,
      status: "fail",
      evidence: evidencePath,
      detail: "counters.json missing or unparseable",
    };
  }
  const captured = counters.captured?.canvas_item_add_polygon ?? [];
  const expectedPoly = expected.script_add_polygon;
  const match = captured.find(
    (entry) =>
      entry.point_bits &&
      entry.color_bits &&
      entry.points?.length === expectedPoly.point_count &&
      (entry.uvs_count ?? -1) === expectedPoly.uvs_count &&
      hexMatrixEqual(entry.point_bits, expectedPoly.point_bits) &&
      hexMatrixEqual(entry.color_bits, expectedPoly.color_bits),
  );
  return {
    id,
    description,
    status: match ? "pass" : "fail",
    evidence: evidencePath,
    detail: match
      ? `matched, point_count=${match.points?.length}, uvs_count=${match.uvs_count}`
      : `no entry in captured.canvas_item_add_polygon (${captured.length} captured) matched point_bits/color_bits/uvs_count=${expectedPoly.uvs_count}`,
  };
}

// ---------------------------------------------------------------------------------------------
// #6 disarm restored; fixture printed frames=400 and exit 0; frames after disarm >= 300
// ---------------------------------------------------------------------------------------------

export async function checkDisarmAndCompletion(
  outDir: string,
): Promise<Criterion[]> {
  const legDir = join(outDir, "headless-armed");
  const disarmPath = join(legDir, "evidence", "disarm.json");
  const stdoutPath = join(legDir, "stdout.txt");
  const exitCodePath = join(legDir, "exit-code.txt");
  const countersPath = join(legDir, "evidence", "counters.json");

  const disarm = await readJson<DisarmJson>(disarmPath);
  const stdout = (await readTextOrUndefined(stdoutPath)) ?? "";
  const exitCodeText = (await readTextOrUndefined(exitCodePath))?.trim();
  const counters = await readJson<CountersJson>(countersPath);

  const disarmOk = disarm?.disarmed === true && disarm?.vptr_restored === true;
  const completionOk = /\bframes=400\b/.test(stdout) && exitCodeText === "0";

  const framesTotal = counters?.frames_total ?? -1;
  const disarmFrame = disarm?.frame ?? -1;
  const framesAfterDisarm =
    framesTotal >= 0 && disarmFrame >= 0 ? framesTotal - disarmFrame : -1;

  return [
    {
      id: "disarm-restored",
      description:
        "disarm.json shows the shadow vtable was removed and the original vptr restored",
      status: disarmOk ? "pass" : "fail",
      evidence: disarmPath,
      detail: `disarmed=${disarm?.disarmed}, vptr_restored=${disarm?.vptr_restored}`,
    },
    {
      id: "fixture-completed",
      description: "the armed fixture process printed frames=400 and exited 0",
      status: completionOk ? "pass" : "fail",
      evidence: `${stdoutPath}, ${exitCodePath}`,
      detail: `exit_code=${exitCodeText ?? "<missing>"}, stdout ${/\bframes=400\b/.test(stdout) ? "contains" : "does not contain"} "frames=400"`,
    },
    {
      id: "frames-after-disarm",
      description:
        "the fixture ran at least 300 more frames after disarm, unobserved by the capture library",
      status: framesAfterDisarm >= 300 ? "pass" : "fail",
      evidence: `${countersPath}, ${disarmPath}`,
      detail: `frames_total=${framesTotal}, disarm.frame=${disarmFrame}, framesAfterDisarm=${framesAfterDisarm}`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// #7 armed.png vs unarmed.png byte-identical RGBA; sanity-check the images are not blank
// ---------------------------------------------------------------------------------------------

async function decodePngRgba(
  path: string,
): Promise<{ data: Uint8Array; width: number; height: number } | undefined> {
  try {
    const { data, info } = await sharp(path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  } catch {
    return undefined;
  }
}

function pixelAt(
  image: { data: Uint8Array; width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3],
  ];
}

function approxEqual(
  actual: readonly number[],
  expectedFloat: readonly number[],
  tolerance: number,
): boolean {
  return actual.every(
    (value, index) =>
      Math.abs(value - Math.round(expectedFloat[index] * 255)) <= tolerance,
  );
}

export async function checkPixelParity(
  outDir: string,
  expected: ExpectedJson,
): Promise<Criterion[]> {
  const unarmedPath = join(outDir, "rendered-unarmed", "unarmed.png");
  const armedPath = join(outDir, "rendered-armed", "armed.png");
  const diffPath = join(outDir, "diff.png");

  const unarmed = await decodePngRgba(unarmedPath);
  const armed = await decodePngRgba(armedPath);

  const parityResults: Criterion[] = [];

  if (!unarmed || !armed) {
    parityResults.push({
      id: "armed-vs-unarmed-pixels",
      description:
        "armed.png and unarmed.png are byte-identical RGBA (interposition must be invisible)",
      status: "fail",
      evidence: `${unarmedPath}, ${armedPath}`,
      detail: `could not decode: unarmed=${unarmed ? "ok" : "missing/unreadable"}, armed=${armed ? "ok" : "missing/unreadable"}`,
    });
  } else {
    const diff = await compareRgbaBuffers(unarmed.data, armed.data, {
      width: unarmed.width,
      height: unarmed.height,
      maxChannelDelta: 0,
      maxDiffRatio: 0,
      diffPath,
    });
    parityResults.push({
      id: "armed-vs-unarmed-pixels",
      description:
        "armed.png and unarmed.png are byte-identical RGBA (interposition must be invisible)",
      status: diff.ok ? "pass" : "fail",
      evidence: `${unarmedPath}, ${armedPath}, ${diffPath}`,
      detail: diff.ok
        ? "byte-identical"
        : `reason=${diff.reason}, diffPixels=${diff.diffPixels ?? "?"}/${diff.totalPixels ?? "?"}, channelDelta=${diff.channelDelta ? diff.channelDelta.max : "?"}`,
    });
  }

  if (!unarmed) {
    parityResults.push({
      id: "unarmed-not-blank",
      description:
        "unarmed.png is not blank: ColorRect region and background clear color both check out",
      status: "fail",
      evidence: unarmedPath,
      detail: "could not decode unarmed.png",
    });
    return parityResults;
  }

  if (unarmed.width !== 640 || unarmed.height !== 360) {
    parityResults.push({
      id: "unarmed-not-blank",
      description:
        "unarmed.png is not blank: ColorRect region and background clear color both check out",
      status: "fail",
      evidence: unarmedPath,
      detail: `unexpected size ${unarmed.width}x${unarmed.height}, expected 640x360`,
    });
    return parityResults;
  }

  const expectedRectColor = expected.colorrect_add_rect.color; // [0.875, 0.25, 0.125, 1]
  const clearColor = [0.1, 0.1, 0.12, 1];
  const rectSamplePoints: Array<[number, number]> = [
    [40, 40],
    [90, 70],
    [159, 119],
  ];
  const backgroundSamplePoints: Array<[number, number]> = [
    [0, 0],
    [500, 300],
    [39, 70],
    [160, 70],
  ];
  const problems: string[] = [];
  for (const [x, y] of rectSamplePoints) {
    const pixel = pixelAt(unarmed, x, y);
    if (!approxEqual(pixel, expectedRectColor, 2)) {
      problems.push(
        `(${x},${y})=${JSON.stringify(pixel)} is not within tolerance of ColorRect color ${JSON.stringify(expectedRectColor)}`,
      );
    }
  }
  for (const [x, y] of backgroundSamplePoints) {
    const pixel = pixelAt(unarmed, x, y);
    if (!approxEqual(pixel, clearColor, 2)) {
      problems.push(
        `(${x},${y})=${JSON.stringify(pixel)} is not within tolerance of the clear color ${JSON.stringify(clearColor)}`,
      );
    }
  }
  parityResults.push({
    id: "unarmed-not-blank",
    description:
      "unarmed.png is not blank: ColorRect region (40..160, 40..120) and background clear color both check out",
    status: problems.length === 0 ? "pass" : "fail",
    evidence: unarmedPath,
    detail: problems.length === 0 ? "ok" : problems.join("; "),
  });

  return parityResults;
}

// ---------------------------------------------------------------------------------------------
// #7 (continued) the two rendered legs are what they claim: "armed" really armed in the rendered
// process (display server X11, vptr written, hooks hit, still armed when the screenshot was taken)
// and "unarmed" really ran with the capture extension absent. Without this, a rendered-armed leg
// that silently refused would make the pixel-parity criterion pass trivially.
// ---------------------------------------------------------------------------------------------

export async function checkRenderedLegs(
  outDir: string,
  expected: ExpectedJson,
): Promise<Criterion> {
  const id = "rendered-legs-armed-and-absent";
  const description =
    "rendered-armed armed under X11 with hooks hit and stayed armed through the screenshot; rendered-unarmed ran with the capture extension absent; both saved their screenshot";
  const armedDir = join(outDir, "rendered-armed");
  const unarmedDir = join(outDir, "rendered-unarmed");
  const resultPath = join(armedDir, "evidence", "result.json");
  const countersPath = join(armedDir, "evidence", "counters.json");
  const disarmPath = join(armedDir, "evidence", "disarm.json");
  const armedLogPath = join(armedDir, "godot.log");
  const unarmedLogPath = join(unarmedDir, "godot.log");
  const evidence = [
    resultPath,
    countersPath,
    disarmPath,
    armedLogPath,
    unarmedLogPath,
  ].join(", ");

  const result = await readJson<ResultJson>(resultPath);
  const counters = await readJson<CountersJson>(countersPath);
  const disarm = await readJson<DisarmJson>(disarmPath);
  const armedLog = (await readTextOrUndefined(armedLogPath)) ?? "";
  const unarmedLog = (await readTextOrUndefined(unarmedLogPath)) ?? "";
  const screenshotFrame = expected.screenshot_default_frame;

  const problems: string[] = [];
  if (result?.status !== "armed" || result.vptr_written !== true) {
    problems.push(
      `rendered-armed status=${JSON.stringify(result?.status)} vptr_written=${JSON.stringify(result?.vptr_written)}, expected armed/true`,
    );
  }
  if (result?.display_server !== "X11") {
    problems.push(
      `rendered-armed display_server=${JSON.stringify(result?.display_server)}, expected "X11"`,
    );
  }
  const counts = counters?.counts ?? {};
  for (const name of [
    "canvas_item_add_rect",
    "canvas_item_add_polygon",
    "canvas_item_add_texture_rect_region",
  ]) {
    if (!((counts[name] ?? 0) > 0)) {
      problems.push(`rendered-armed counts.${name}=${counts[name] ?? 0}`);
    }
  }
  // Disarm happens only at shutdown in this leg, so the screenshot frame was taken armed.
  if ((disarm?.frame ?? -1) <= screenshotFrame) {
    problems.push(
      `rendered-armed disarm.frame=${disarm?.frame ?? "<missing>"}, expected > screenshot frame ${screenshotFrame}`,
    );
  }
  if (!/extension load status=skipped/.test(unarmedLog)) {
    problems.push(
      "rendered-unarmed godot.log lacks 'extension load status=skipped' (capture was not absent)",
    );
  }
  if (/\[grc\]/.test(unarmedLog)) {
    problems.push("rendered-unarmed godot.log contains [grc] lines");
  }
  for (const [leg, log] of [
    ["rendered-armed", armedLog],
    ["rendered-unarmed", unarmedLog],
  ] as const) {
    if (!/screenshot saved=\S+ err=0\b/.test(log)) {
      problems.push(`${leg} godot.log has no 'screenshot saved=... err=0'`);
    }
  }

  return {
    id,
    description,
    status: problems.length === 0 ? "pass" : "fail",
    evidence,
    detail:
      problems.length === 0
        ? `armed under X11, add_rect=${counts.canvas_item_add_rect}, add_polygon=${counts.canvas_item_add_polygon}, texture_rect_region=${counts.canvas_item_add_texture_rect_region}, disarm.frame=${disarm?.frame}; unarmed ran with capture absent`
        : problems.join("; "),
  };
}

// ---------------------------------------------------------------------------------------------
// #8 no mprotect in strace after the openat of armed.marker whose range intersects the exe's
//    mapped ranges (fingerprint.json); report the total count of any mprotect after arm regardless
// ---------------------------------------------------------------------------------------------

interface FingerprintJson {
  pid?: number;
  /** The main binary's own `/proc/self/maps` lines, as the capture library read them. */
  exe_maps?: string[];
}

/** Address ranges of every mapping of the main executable, parsed from fingerprint.json's
 * `exe_maps` (verbatim `/proc/self/maps` lines: "00400000-00407000 r--p ..."). */
export function extractExeRanges(
  fingerprint: FingerprintJson,
): Array<{ start: number; end: number }> | undefined {
  if (!Array.isArray(fingerprint.exe_maps)) return undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of fingerprint.exe_maps) {
    const match = /^([0-9a-fA-F]+)-([0-9a-fA-F]+)\s/.exec(line);
    if (!match) return undefined;
    ranges.push({
      start: Number.parseInt(match[1], 16),
      end: Number.parseInt(match[2], 16),
    });
  }
  return ranges.length > 0 ? ranges : undefined;
}

interface StraceEvent {
  timestamp: number; // seconds within the day, for ordering within one run
  kind: "openat" | "mprotect";
  raw: string;
  armedMarkerOpenat?: boolean;
  mprotectAddr?: number;
  mprotectLen?: number;
}

// strace -f -o<file> (more than one tracee, output to a file rather than a terminal) prefixes
// EVERY line -- including the first/main tracee's own -- with its bare numeric pid, e.g.
// "335197 22:35:47.811032 openat(...) = 3" (measured directly against the real template binary;
// this is NOT the bracketed "[pid NNNN] " form some strace docs show, which this also accepts
// defensively in case of a different strace build/config).
//
// With -f, a syscall that yields mid-call (common for mprotect under heavy thread contention, also
// measured directly) is split across two lines instead of one:
//   "<pid> <time> mprotect(0x.., 135168, PROT_READ|PROT_WRITE <unfinished ...>"
//   "<pid> <time> <... mprotect resumed>) = 0"
// The full address/length are already present on the "unfinished" line, which is all this needs
// (the eventual return value doesn't matter for "did an mprotect touch this range"), so the regex
// accepts EITHER a normal "...) = result" tail or an "<unfinished ...>" tail, and the later
// "<... NAME resumed>...)" line is simply never matched by "(\w+)\(" -- it starts with "<", not a
// syscall name -- so it is naturally skipped rather than double-counted.
const STRACE_LINE_RE =
  /^(?:\[pid\s+\d+\]\s+|\d+\s+)?(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+(\w+)\((.*?)(?:\)\s*=\s*.*|\s*<unfinished \.\.\.>)$/;

function parseStraceTimestamp(
  h: string,
  m: string,
  s: string,
  frac: string,
): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
}

export function parseStraceEvents(
  straceText: string,
  armedMarkerBasename: string,
): StraceEvent[] {
  const events: StraceEvent[] = [];
  for (const line of straceText.split("\n")) {
    const match = STRACE_LINE_RE.exec(line);
    if (!match) continue;
    const [, h, m, s, frac, syscall, args] = match;
    const timestamp = parseStraceTimestamp(h, m, s, frac);
    if (syscall === "openat" && args.includes(armedMarkerBasename)) {
      events.push({
        timestamp,
        kind: "openat",
        raw: line,
        armedMarkerOpenat: true,
      });
    } else if (syscall === "mprotect") {
      const addrMatch = /mprotect\((0x[0-9a-fA-F]+),\s*(\d+)/.exec(
        `mprotect(${args}`,
      );
      if (addrMatch) {
        events.push({
          timestamp,
          kind: "mprotect",
          raw: line,
          mprotectAddr: Number.parseInt(addrMatch[1], 16),
          mprotectLen: Number(addrMatch[2]),
        });
      }
    }
  }
  return events;
}

export async function checkNoMprotectAfterArm(
  outDir: string,
): Promise<Criterion> {
  const id = "no-mprotect-after-arm";
  const description =
    "no mprotect syscall touching the exe's mapped code after the openat of armed.marker (report total mprotect-after-arm count regardless)";
  const legDir = join(outDir, "headless-armed");
  const stracePath = join(legDir, "strace.txt");
  const straceUnavailablePath = join(legDir, "strace-status.txt");
  const fingerprintPath = join(legDir, "evidence", "fingerprint.json");

  if (await fileExists(straceUnavailablePath)) {
    return {
      id,
      description,
      status: "unavailable",
      evidence: straceUnavailablePath,
      detail: "strace was not installed when this leg ran",
    };
  }

  const straceText = await readTextOrUndefined(stracePath);
  if (!straceText) {
    return {
      id,
      description,
      status: "fail",
      evidence: stracePath,
      detail: "strace.txt missing or unreadable",
    };
  }

  const fingerprint = await readJson<FingerprintJson>(fingerprintPath);
  if (!fingerprint) {
    return {
      id,
      description,
      status: "fail",
      evidence: fingerprintPath,
      detail: "fingerprint.json missing or unparseable",
    };
  }
  const exeRanges = extractExeRanges(fingerprint);
  if (!exeRanges) {
    return {
      id,
      description,
      status: "fail",
      evidence: fingerprintPath,
      detail:
        "fingerprint.json has no parseable exe_maps (the main binary's /proc/self/maps lines)",
    };
  }

  const events = parseStraceEvents(straceText, "armed.marker");
  const armedMarkerOpenat = events.find((e) => e.armedMarkerOpenat);
  if (!armedMarkerOpenat) {
    return {
      id,
      description,
      status: "fail",
      evidence: stracePath,
      detail: "no openat(...armed.marker...) found in strace.txt",
    };
  }

  const mprotectsAfterArm = events.filter(
    (e) => e.kind === "mprotect" && e.timestamp > armedMarkerOpenat.timestamp,
  );
  const intersecting = mprotectsAfterArm.filter((e) => {
    const addr = e.mprotectAddr ?? 0;
    const end = addr + (e.mprotectLen ?? 0);
    return exeRanges.some((range) => addr < range.end && end > range.start);
  });

  return {
    id,
    description,
    status: intersecting.length === 0 ? "pass" : "fail",
    evidence: `${stracePath}, ${fingerprintPath}`,
    detail: `mprotect-after-arm total=${mprotectsAfterArm.length}, intersecting exe mappings=${intersecting.length} (${exeRanges.length} exe ranges ${exeRanges.map((r) => `0x${r.start.toString(16)}-0x${r.end.toString(16)}`).join(",")})${intersecting.length > 0 ? `; first: ${intersecting[0].raw}` : ""}`,
  };
}
