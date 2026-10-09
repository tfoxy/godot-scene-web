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
  format?: number;
  details?: boolean;
}

interface CountersJson {
  schema?: string;
  frames_total?: number;
  frames_armed?: number;
  /** An optional hook the record did not name is `null` ("not installed", not "never called"). */
  counts?: Record<string, number | null>;
  hooks_planned?: string[];
  hooks_omitted?: string[];
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
    // The calibrator-2 paths, on the real GPU renderer as well as under --headless.
    "canvas_item_add_triangle_array",
    "canvas_item_add_nine_patch",
    "canvas_item_add_mesh",
    "canvas_item_add_multimesh",
    "mesh_surface_update_vertex_region",
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
        ? `armed under X11, add_rect=${counts.canvas_item_add_rect}, add_polygon=${counts.canvas_item_add_polygon}, texture_rect_region=${counts.canvas_item_add_texture_rect_region}, triangle_array=${counts.canvas_item_add_triangle_array}, nine_patch=${counts.canvas_item_add_nine_patch}, add_mesh=${counts.canvas_item_add_mesh}, add_multimesh=${counts.canvas_item_add_multimesh}, vertex_region=${counts.mesh_surface_update_vertex_region}, disarm.frame=${disarm?.frame}; unarmed ran with capture absent`
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

// ---------------------------------------------------------------------------------------------
// #9 calibrator-2 draw paths (toward gate -0.25): triangle arrays (scripted and the StyleBoxFlat
//    Panel's), nine-patches (scripted and NinePatchRect), primitives, lines, polylines, circles,
//    add_set_transform, the ArrayMesh path spine-godot uses (mesh_create, mesh_add_surface,
//    per-frame vertex/attribute region updates, custom AABB, canvas_item_add_mesh), multimesh,
//    material and shader calls. Counts > 0 for every optional hook, values bit-exact where they
//    are captured, and the RIDs tied together across hooks.
// ---------------------------------------------------------------------------------------------

/** One deduplicated capture of an optional hook: field names as counters.json writes them. */
type CapturedEntry = Record<string, unknown> & {
  calls?: number;
  first_frame?: number;
  last_frame?: number;
};

interface ExpectedRegion {
  surface: number;
  offset: number;
  data_size: number;
  head_hex: string;
  min_calls: number;
}

interface ExpectedDrawPaths {
  triangle_array: {
    indices: number[];
    point_bits: string[][];
    color_bits: string[][];
    uv_bits: string[][];
    bones_total: number;
    weights_total: number;
    texture: string;
    count: number;
  };
  stylebox_panel: { bg_color_bits: string[]; modulate_bits: string[] };
  nine_patch_script: {
    rect_bits: string[];
    source_bits: string[];
    topleft_bits: string[];
    bottomright_bits: string[];
    x_axis_mode: number;
    y_axis_mode: number;
    draw_center: boolean;
    modulate_bits: string[];
    texture_width: number;
    texture_height: number;
    texture_format: number;
  };
  nine_patch_native: {
    rect_bits: string[];
    topleft_bits: string[];
    bottomright_bits: string[];
    x_axis_mode: number;
    y_axis_mode: number;
    draw_center: boolean;
  };
  primitive: {
    point_bits: string[][];
    color_bits: string[][];
    uv_bits: string[][];
  };
  line: {
    from_bits: string[];
    to_bits: string[];
    color_bits: string[];
    width_bits: string[];
    antialiased: boolean;
  };
  polyline: {
    point_bits: string[][];
    color_bits: string[][];
    width_bits: string[];
  };
  set_transform: { transform_bits: string[] };
  circle: {
    position_bits: string[];
    radius_bits: string[];
    color_bits: string[];
  };
  mesh: {
    primitive: number;
    format: string;
    vertex_count: number;
    vertex_data_size: number;
    attribute_data_size: number;
    skin_data_size: number;
    index_count: number;
    index_data_size: number;
    aabb_bits: string[];
    transform_bits: string[];
    modulate_bits: string[];
    texture: string;
  };
  vertex_region: ExpectedRegion;
  attribute_region: ExpectedRegion;
  custom_aabb: { aabb_bits: string[] };
  visible_samples: { samples: Array<{ name: string; x: number; y: number }> };
}

export interface ExpectedWithDrawPaths extends ExpectedJson {
  draw_paths: ExpectedDrawPaths;
  /** The calibrator-2 hooks: optional to the library, all exercised by the fixture. */
  optional_hooks: string[];
  optional_counters_must_be_positive: string[];
}

function entries(
  counters: CountersJson | undefined,
  hook: string,
): CapturedEntry[] {
  const value = counters?.captured?.[hook];
  return Array.isArray(value) ? (value as CapturedEntry[]) : [];
}

function bitsField(
  entry: CapturedEntry,
  field: string,
  expected: readonly string[],
): boolean {
  const value = entry[field];
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "string") &&
    hexArrayEqual(value as string[], expected)
  );
}

function bitsMatrixField(
  entry: CapturedEntry,
  field: string,
  expected: readonly (readonly string[])[],
): boolean {
  const value = entry[field];
  return (
    Array.isArray(value) &&
    value.every(
      (row) => Array.isArray(row) && row.every((v) => typeof v === "string"),
    ) &&
    hexMatrixEqual(value as string[][], expected)
  );
}

function sameNumbers(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((v, index) => v === expected[index])
  );
}

/** The scene root's canvas item: the one the scripted (script_add_rect) rect was drawn on. */
function scriptItem(
  counters: CountersJson | undefined,
  expected: ExpectedJson,
): string | undefined {
  return findMatchingAddRect(
    counters?.captured?.canvas_item_add_rect ?? [],
    expected.script_add_rect,
  )?.item;
}

function verdict(
  id: string,
  description: string,
  evidence: string,
  problems: string[],
  okDetail: string,
): Criterion {
  return {
    id,
    description,
    status: problems.length === 0 ? "pass" : "fail",
    evidence,
    detail: problems.length === 0 ? okDetail : problems.join("; "),
  };
}

function checkOptionalCounts(
  counters: CountersJson | undefined,
  expected: ExpectedWithDrawPaths,
  evidence: string,
): Criterion {
  const counts = counters?.counts ?? {};
  const names = expected.optional_counters_must_be_positive;
  const problems = names
    .filter((name) => !((counts[name] ?? 0) > 0))
    .map((name) => `${name}=${JSON.stringify(counts[name] ?? "<missing>")}`);
  if (!counters) problems.unshift("counters.json missing or unparseable");
  const omitted = counters?.hooks_omitted ?? [];
  if (omitted.length > 0)
    problems.push(`hooks_omitted=${JSON.stringify(omitted)}`);
  return verdict(
    "optional-hook-counts",
    "every calibrator-2 hook is installed and its count is > 0 in the headless-armed leg",
    evidence,
    problems,
    names.map((name) => `${name}=${counts[name]}`).join(", "),
  );
}

function checkTriangleArrays(
  counters: CountersJson | undefined,
  expected: ExpectedWithDrawPaths,
  item: string | undefined,
  evidence: string,
): Criterion[] {
  const dp = expected.draw_paths;
  const e = dp.triangle_array;
  const all = entries(counters, "canvas_item_add_triangle_array");
  const scripted = all.find(
    (entry) =>
      entry.item === item &&
      sameNumbers(entry.indices, e.indices) &&
      entry.indices_total === e.indices.length &&
      entry.points_total === e.point_bits.length &&
      bitsMatrixField(entry, "point_bits", e.point_bits) &&
      bitsMatrixField(entry, "color_bits", e.color_bits) &&
      bitsMatrixField(entry, "uv_bits", e.uv_bits) &&
      entry.bones_total === e.bones_total &&
      entry.weights_total === e.weights_total &&
      entry.texture === e.texture &&
      entry.count === e.count,
  );

  // The Panel's StyleBoxFlat: a triangle array on another item whose every colour is bg_color,
  // either opaque (the fill) or at alpha 0 (the anti-aliasing feather ring, style_box_flat.cpp
  // draw_ring with a transparent outer colour); at least one opaque.
  const bg = dp.stylebox_panel.bg_color_bits;
  const feather = [...bg.slice(0, 3), "0x00000000"];
  const panel = all.find((entry) => {
    const colors = entry.color_bits;
    if (
      entry.item === item ||
      !Array.isArray(colors) ||
      colors.length === 0 ||
      !colors.every((row) => Array.isArray(row))
    ) {
      return false;
    }
    const rows = colors as string[][];
    return (
      rows.every(
        (row) => hexArrayEqual(row, bg) || hexArrayEqual(row, feather),
      ) && rows.some((row) => hexArrayEqual(row, bg))
    );
  });
  const modulate = entries(counters, "canvas_item_set_modulate").find(
    (entry) =>
      panel !== undefined &&
      entry.item === panel.item &&
      bitsField(entry, "color_bits", dp.stylebox_panel.modulate_bits),
  );
  const panelProblems: string[] = [];
  if (!panel)
    panelProblems.push(
      "no native triangle array (on an item other than the script's) whose every colour is the StyleBoxFlat bg_color, opaque or as the alpha-0 feather",
    );
  if (!modulate)
    panelProblems.push(
      "no canvas_item_set_modulate on the Panel's item with its modulate",
    );

  // Material and shader: set_material on the Panel's item with the material that
  // material_set_param targets; shader_set_code on a shader shader_create_from_code returned.
  const setMaterial = entries(counters, "canvas_item_set_material").find(
    (entry) => panel !== undefined && entry.item === panel.item,
  );
  const param = entries(counters, "material_set_param").find(
    (entry) =>
      setMaterial !== undefined && entry.material === setMaterial.material,
  );
  const created = entries(counters, "shader_create_from_code").map(
    (entry) => entry.rid,
  );
  const recoded = entries(counters, "shader_set_code").find((entry) =>
    created.includes(entry.shader),
  );
  const shaderProblems: string[] = [];
  if (!setMaterial)
    shaderProblems.push("no canvas_item_set_material on the Panel's item");
  if (!param)
    shaderProblems.push(
      "no material_set_param on the material assigned to the Panel",
    );
  if (!recoded)
    shaderProblems.push(
      "no shader_set_code on a shader RID returned by shader_create_from_code",
    );

  return [
    verdict(
      "triangle-array-bit-exact",
      "the script's canvas_item_add_triangle_array decodes exactly: indices, points, colours, UVs, empty bones/weights, texture and count",
      evidence,
      scripted
        ? []
        : [
            `no captured.canvas_item_add_triangle_array entry (${all.length} captured) on the script item ${item ?? "<unknown>"} matched expected.json draw_paths.triangle_array`,
          ],
      `matched, calls=${scripted?.calls}, frames ${scripted?.first_frame}..${scripted?.last_frame}`,
    ),
    verdict(
      "stylebox-panel-native",
      "the Panel's StyleBoxFlat is captured as a native canvas_item_add_triangle_array in bg_color, and its modulate as canvas_item_set_modulate on the same item",
      evidence,
      panelProblems,
      `item=${panel?.item}, points_total=${panel?.points_total}, indices_total=${panel?.indices_total}`,
    ),
    verdict(
      "shader-material-path",
      "canvas_item_set_material, material_set_param, shader_create_from_code and shader_set_code are captured with consistent RIDs",
      evidence,
      shaderProblems,
      `material=${setMaterial?.material}, shader=${recoded?.shader}`,
    ),
  ];
}

function checkNinePatches(
  counters: CountersJson | undefined,
  expected: ExpectedWithDrawPaths,
  item: string | undefined,
  evidence: string,
): Criterion {
  const e = expected.draw_paths.nine_patch_script;
  const n = expected.draw_paths.nine_patch_native;
  const all = entries(counters, "canvas_item_add_nine_patch");
  const texture = (counters?.captured?.texture_2d_create ?? []).find(
    (entry) =>
      entry.width === e.texture_width &&
      entry.height === e.texture_height &&
      entry.format === e.texture_format,
  );
  const scripted = all.find(
    (entry) =>
      entry.item === item &&
      bitsField(entry, "rect_bits", e.rect_bits) &&
      bitsField(entry, "source_bits", e.source_bits) &&
      bitsField(entry, "topleft_bits", e.topleft_bits) &&
      bitsField(entry, "bottomright_bits", e.bottomright_bits) &&
      entry.x_axis_mode === e.x_axis_mode &&
      entry.y_axis_mode === e.y_axis_mode &&
      entry.draw_center === e.draw_center &&
      bitsField(entry, "modulate_bits", e.modulate_bits),
  );
  const native = all.find(
    (entry) =>
      entry.item !== item &&
      bitsField(entry, "rect_bits", n.rect_bits) &&
      bitsField(entry, "topleft_bits", n.topleft_bits) &&
      bitsField(entry, "bottomright_bits", n.bottomright_bits) &&
      entry.x_axis_mode === n.x_axis_mode &&
      entry.y_axis_mode === n.y_axis_mode &&
      entry.draw_center === n.draw_center,
  );
  const problems: string[] = [];
  if (!texture)
    problems.push(
      `no ${e.texture_width}x${e.texture_height} format-${e.texture_format} texture_2d_create`,
    );
  if (!scripted)
    problems.push(
      `no scripted nine-patch (${all.length} captured) matched expected.json bit-exact`,
    );
  else if (texture && scripted.texture !== texture.rid)
    problems.push(
      `scripted nine-patch texture ${scripted.texture} is not the created texture ${texture.rid}`,
    );
  if (!native) problems.push("no native NinePatchRect nine-patch matched");
  else if (texture && native.texture !== texture.rid)
    problems.push(
      `NinePatchRect texture ${native.texture} is not the created texture ${texture.rid}`,
    );
  return verdict(
    "nine-patch-bit-exact",
    "the script's canvas_item_add_nine_patch decodes exactly (including the stack-passed axis modes, draw_center and modulate) on the texture it created, and the NinePatchRect's native nine-patch uses the same texture",
    evidence,
    problems,
    `texture=${texture?.rid}, scripted calls=${scripted?.calls}, native item=${native?.item}`,
  );
}

function checkScriptedShapes(
  counters: CountersJson | undefined,
  expected: ExpectedWithDrawPaths,
  item: string | undefined,
  evidence: string,
): Criterion {
  const dp = expected.draw_paths;
  const problems: string[] = [];
  const onItem = (
    hook: string,
    test: (entry: CapturedEntry) => boolean,
  ): void => {
    const all = entries(counters, hook);
    if (!all.some((entry) => entry.item === item && test(entry))) {
      problems.push(
        `no ${hook} entry (${all.length} captured) on the script item matched`,
      );
    }
  };
  onItem(
    "canvas_item_add_primitive",
    (entry) =>
      bitsMatrixField(entry, "point_bits", dp.primitive.point_bits) &&
      bitsMatrixField(entry, "color_bits", dp.primitive.color_bits) &&
      bitsMatrixField(entry, "uv_bits", dp.primitive.uv_bits),
  );
  onItem(
    "canvas_item_add_line",
    (entry) =>
      bitsField(entry, "from_bits", dp.line.from_bits) &&
      bitsField(entry, "to_bits", dp.line.to_bits) &&
      bitsField(entry, "color_bits", dp.line.color_bits) &&
      bitsField(entry, "width_bits", dp.line.width_bits) &&
      entry.antialiased === dp.line.antialiased,
  );
  onItem(
    "canvas_item_add_polyline",
    (entry) =>
      bitsMatrixField(entry, "point_bits", dp.polyline.point_bits) &&
      bitsMatrixField(entry, "color_bits", dp.polyline.color_bits) &&
      bitsField(entry, "width_bits", dp.polyline.width_bits),
  );
  onItem("canvas_item_add_set_transform", (entry) =>
    bitsField(entry, "transform_bits", dp.set_transform.transform_bits),
  );
  onItem(
    "canvas_item_add_circle",
    (entry) =>
      bitsField(entry, "position_bits", dp.circle.position_bits) &&
      bitsField(entry, "radius_bits", dp.circle.radius_bits) &&
      bitsField(entry, "color_bits", dp.circle.color_bits),
  );
  return verdict(
    "scripted-shapes-bit-exact",
    "the script's canvas_item_add_primitive, _line, _polyline, _set_transform and _circle calls decode exactly",
    evidence,
    problems,
    "primitive, line, polyline, add_set_transform and circle matched",
  );
}

function checkMeshPath(
  counters: CountersJson | undefined,
  expected: ExpectedWithDrawPaths,
  item: string | undefined,
  evidence: string,
): Criterion[] {
  const dp = expected.draw_paths;
  const m = dp.mesh;
  const created = entries(counters, "mesh_create").map((entry) => entry.rid);
  const surface = entries(counters, "mesh_add_surface").find(
    (entry) =>
      created.includes(entry.mesh) &&
      entry.primitive === m.primitive &&
      entry.format === m.format &&
      entry.vertex_count === m.vertex_count &&
      entry.vertex_data_size === m.vertex_data_size &&
      entry.attribute_data_size === m.attribute_data_size &&
      entry.skin_data_size === m.skin_data_size &&
      entry.index_count === m.index_count &&
      entry.index_data_size === m.index_data_size &&
      bitsField(entry, "aabb_bits", m.aabb_bits),
  );
  const mesh = surface?.mesh;
  const addMesh = entries(counters, "canvas_item_add_mesh").find(
    (entry) =>
      mesh !== undefined &&
      entry.item === item &&
      entry.mesh === mesh &&
      bitsField(entry, "transform_bits", m.transform_bits) &&
      bitsField(entry, "modulate_bits", m.modulate_bits) &&
      entry.texture === m.texture,
  );
  const multimesh = entries(counters, "canvas_item_add_multimesh").find(
    (entry) => entry.item === item,
  );
  const cleared = entries(counters, "mesh_clear").find(
    (entry) => created.includes(entry.mesh) && entry.mesh !== mesh,
  );
  const problems: string[] = [];
  if (!surface)
    problems.push(
      `no mesh_add_surface on a mesh_create'd RID matched expected.json draw_paths.mesh (format ${m.format}, ${m.vertex_count} vertices, ${m.vertex_data_size}/${m.attribute_data_size} bytes, aabb)`,
    );
  if (!addMesh)
    problems.push(
      `no canvas_item_add_mesh of mesh ${mesh ?? "<none>"} with the expected transform/modulate on the script item`,
    );
  if (!multimesh)
    problems.push("no canvas_item_add_multimesh on the script item");
  if (!cleared) problems.push("no mesh_clear on the second (scratch) mesh");

  const regionProblems: string[] = [];
  const region = (
    hook: string,
    e: ExpectedRegion,
  ): CapturedEntry | undefined => {
    const all = entries(counters, hook);
    const match = all.find(
      (entry) =>
        mesh !== undefined &&
        entry.mesh === mesh &&
        entry.surface === e.surface &&
        entry.offset === e.offset &&
        entry.data_size === e.data_size &&
        entry.head_hex === e.head_hex,
    );
    if (!match) {
      regionProblems.push(
        `no ${hook} on mesh ${mesh ?? "<none>"} with surface ${e.surface}, offset ${e.offset}, ${e.data_size} bytes ${e.head_hex} (${all.length} captured)`,
      );
    } else if ((match.calls ?? 0) < e.min_calls) {
      regionProblems.push(
        `${hook} arrived ${match.calls} times, expected >= ${e.min_calls} (one per armed frame)`,
      );
    }
    return match;
  };
  const vertex = region("mesh_surface_update_vertex_region", dp.vertex_region);
  const attribute = region(
    "mesh_surface_update_attribute_region",
    dp.attribute_region,
  );
  const aabb = entries(counters, "mesh_set_custom_aabb").find(
    (entry) =>
      mesh !== undefined &&
      entry.mesh === mesh &&
      bitsField(entry, "aabb_bits", dp.custom_aabb.aabb_bits),
  );
  if (!aabb)
    regionProblems.push(
      `no mesh_set_custom_aabb on mesh ${mesh ?? "<none>"} with the expected AABB`,
    );

  return [
    verdict(
      "mesh-surface-and-draw",
      "the ArrayMesh's mesh_create -> mesh_add_surface (SurfaceData primitive/format/counts/sizes/aabb read in place) -> canvas_item_add_mesh chain is captured with one RID, plus add_multimesh and a mesh_clear",
      evidence,
      problems,
      `mesh=${mesh}, add_mesh calls=${addMesh?.calls}, multimesh calls=${multimesh?.calls}, cleared=${cleared?.mesh}`,
    ),
    verdict(
      "mesh-region-updates",
      "the per-frame mesh_surface_update_vertex_region / _attribute_region writes are captured with surface, byte offset, byte count and exact bytes, once per armed frame, plus mesh_set_custom_aabb",
      evidence,
      regionProblems,
      `vertex_region calls=${vertex?.calls} frames ${vertex?.first_frame}..${vertex?.last_frame}; attribute_region calls=${attribute?.calls}; custom_aabb calls=${aabb?.calls}`,
    ),
  ];
}

export async function checkDrawPaths(
  outDir: string,
  expected: ExpectedWithDrawPaths,
): Promise<Criterion[]> {
  const evidence = join(outDir, "headless-armed", "evidence", "counters.json");
  const counters = await readJson<CountersJson>(evidence);
  const item = scriptItem(counters, expected);
  return [
    checkOptionalCounts(counters, expected, evidence),
    ...checkTriangleArrays(counters, expected, item, evidence),
    checkNinePatches(counters, expected, item, evidence),
    checkScriptedShapes(counters, expected, item, evidence),
    ...checkMeshPath(counters, expected, item, evidence),
  ];
}

// ---------------------------------------------------------------------------------------------
// #7 (continued) the new drawings are really on screen. armed.png is byte-identical to
//    unarmed.png (armed-vs-unarmed-pixels), so checking the unarmed render covers both.
// ---------------------------------------------------------------------------------------------

export async function checkNewDrawingsVisible(
  outDir: string,
  expected: ExpectedWithDrawPaths,
): Promise<Criterion> {
  const id = "new-drawings-visible";
  const description =
    "every calibrator-2 drawing covers its sample pixel in unarmed.png (and so in the byte-identical armed.png), including the vertex the per-frame region update moved";
  const unarmedPath = join(outDir, "rendered-unarmed", "unarmed.png");
  const unarmed = await decodePngRgba(unarmedPath);
  if (!unarmed) {
    return {
      id,
      description,
      status: "fail",
      evidence: unarmedPath,
      detail: "could not decode unarmed.png",
    };
  }
  const clear = [25, 25, 31];
  const problems: string[] = [];
  const seen: string[] = [];
  for (const sample of expected.draw_paths.visible_samples.samples) {
    let hit: [number, number, number, number] | undefined;
    for (let dy = -1; dy <= 1 && !hit; dy++) {
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        const x = sample.x + dx;
        const y = sample.y + dy;
        if (x < 0 || y < 0 || x >= unarmed.width || y >= unarmed.height)
          continue;
        const pixel = pixelAt(unarmed, x, y);
        if (
          pixel
            .slice(0, 3)
            .some((value, index) => Math.abs(value - clear[index]) > 16)
        ) {
          hit = pixel;
        }
      }
    }
    if (hit) seen.push(`${sample.name}=${JSON.stringify(hit)}`);
    else
      problems.push(
        `${sample.name} (${sample.x},${sample.y}) is the clear colour`,
      );
  }
  return verdict(id, description, unarmedPath, problems, seen.join(", "));
}

// ---------------------------------------------------------------------------------------------
// #10 a record written by calibrator version 1 (no calibrator-2 slots) still loads and arms: the
//     missing hooks are left out and reported, never refused and never guessed.
// ---------------------------------------------------------------------------------------------

interface CalibrationCheckJson {
  checks?: Array<{ name?: string; ok?: boolean; detail?: string }>;
}

export async function checkOlderRecord(
  outDir: string,
  expected: ExpectedWithDrawPaths,
): Promise<Criterion> {
  const id = "older-record-loads";
  const description =
    "a calibrator-1 record (gate -1 slots only) arms: required hooks counted, every calibrator-2 hook in hooks_omitted with a null count and named by calibration-check.json's hook_plan, clean disarm";
  const legDir = join(outDir, "old-record");
  const resultPath = join(legDir, "evidence", "result.json");
  const countersPath = join(legDir, "evidence", "counters.json");
  const checkPath = join(legDir, "evidence", "calibration-check.json");
  const disarmPath = join(legDir, "evidence", "disarm.json");
  const evidence = [resultPath, countersPath, checkPath, disarmPath].join(", ");

  const result = await readJson<ResultJson>(resultPath);
  const counters = await readJson<CountersJson>(countersPath);
  const check = await readJson<CalibrationCheckJson>(checkPath);
  const disarm = await readJson<DisarmJson>(disarmPath);

  const problems: string[] = [];
  if (result?.status !== "armed" || result.vptr_written !== true) {
    problems.push(
      `status=${JSON.stringify(result?.status)} reason=${JSON.stringify(result?.reason)} vptr_written=${JSON.stringify(result?.vptr_written)}, expected armed/true`,
    );
  }
  if (disarm?.disarmed !== true || disarm.vptr_restored !== true) {
    problems.push(
      `disarmed=${disarm?.disarmed}, vptr_restored=${disarm?.vptr_restored}`,
    );
  }
  const omitted = [...(counters?.hooks_omitted ?? [])].sort();
  const wanted = [...expected.optional_hooks].sort();
  if (JSON.stringify(omitted) !== JSON.stringify(wanted)) {
    problems.push(
      `hooks_omitted=${JSON.stringify(omitted)}, expected every optional hook`,
    );
  }
  const counts = counters?.counts ?? {};
  const notNull = expected.optional_hooks.filter(
    (name) => counts[name] !== null,
  );
  if (notNull.length > 0)
    problems.push(`omitted hooks with a non-null count: ${notNull.join(",")}`);
  for (const name of ["canvas_item_add_rect", "canvas_item_add_polygon"]) {
    if (!((counts[name] ?? 0) > 0))
      problems.push(`required ${name}=${counts[name] ?? "<missing>"}`);
  }
  const plan = check?.checks?.find((entry) => entry.name === "hook_plan");
  if (
    plan?.ok !== true ||
    !expected.optional_hooks.every((name) => plan.detail?.includes(name))
  ) {
    problems.push(
      `calibration-check.json hook_plan=${JSON.stringify(plan)}, expected ok with every omitted hook named`,
    );
  }
  return verdict(
    id,
    description,
    evidence,
    problems,
    `armed with ${counters?.hooks_planned?.length} hooks planned, ${omitted.length} omitted with null counts; add_rect=${counts.canvas_item_add_rect}, add_polygon=${counts.canvas_item_add_polygon}; disarm restored`,
  );
}
