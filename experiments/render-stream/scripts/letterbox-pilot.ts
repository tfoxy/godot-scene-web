// Inspect run-letterbox-pilot.sh evidence and replay the same recordings in GSW.
// Pixel differences are measurements, not a new acceptance tolerance.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import sharp from "../../../packages/test-harness/node_modules/sharp/lib/index.js";

import { loadRecording } from "./lib/gate0-checks";
import { runWebLegs } from "./lib/gate7-web-legs";
import { buildGswBundle } from "./lib/gsw-bundle";

const out = resolve(process.argv[2]);
const resizeOnly = process.argv.includes("--resize-only");
// --reuse-browser only recomputes metrics/crops from an already successful replay.
if (!process.argv.includes("--reuse-browser")) {
  const bundle = await buildGswBundle(join(out, "bundle"));
  const results = await runWebLegs(
    {
      out: join(out, "browser"),
      gate: "letterbox",
      sourceDir: out,
      bundleDir: bundle.dir,
      buildSha256: bundle.sha256,
      kind: "gsw",
    },
    (resizeOnly ? ["resize"] : ["wide", "downscale"]).flatMap((name) =>
      (resizeOnly ? ["observe"] : ["observe", "headless"]).map((mode) => ({
        leg: `${name}/${mode}`,
        nativeDir: join(out, name, mode, "receiver"),
        webDir: join(out, "browser", name, mode),
      })),
    ),
  );
  await writeFile(
    join(out, "browser-results.json"),
    JSON.stringify(results, null, 2),
  );
}
const results = await json(join(out, "browser-results.json"));
assert.equal(results.length, resizeOnly ? 1 : 4);
assert(
  results.every(
    (r: { exitCode: number; provenanceOk: boolean }) =>
      r.exitCode === 0 && r.provenanceOk,
  ),
);

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

type Region = { left: number; top: number; width: number; height: number };

async function pixels(path: string, region?: Region) {
  const image = sharp(path);
  if (region) image.extract(region);
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function compare(a: string, b: string, region?: Region) {
  const [left, right] = await Promise.all([
    pixels(a, region),
    pixels(b, region),
  ]);
  assert.equal(left.width, right.width, `${a} / ${b} width`);
  assert.equal(left.height, right.height, `${a} / ${b} height`);
  let changed = 0;
  let above1 = 0;
  let max = 0;
  let absoluteError = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      d = Math.max(d, Math.abs(left.data[i + c] - right.data[i + c]));
      if (c < 3)
        absoluteError += Math.abs(left.data[i + c] - right.data[i + c]);
    }
    if (d > 0) changed++;
    if (d > 1) above1++;
    max = Math.max(max, d);
  }
  return {
    a,
    b,
    region,
    pixels: left.width * left.height,
    changed,
    above1,
    max_channel_delta: max,
    mean_absolute_rgb_delta: absoluteError / (left.width * left.height * 3),
  };
}

if (resizeOnly) {
  const dir = join(out, "resize/observe");
  const recording = await loadRecording(join(dir, "recording.rs2"));
  assert.deepEqual(recording.errors, []);
  assert.equal(recording.end?.reason, "shutdown");
  assert(recording.transactions.every((tx) => tx.meta.failures.length === 0));
  const probes = (await readFile(join(dir, "sizes.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const before = probes[0];
  const resized = probes.find((probe) => probe.window[0] === 1600);
  const final = probes.at(-1);
  assert(resized, "the OS window must actually resize");
  assert.deepEqual(before.window, [1920, 1080]);
  assert.deepEqual(final.window, [1600, 900]);
  assert.deepEqual(final.visible, [2520, 1080]);
  assert(final.ticks_usec - resized.ticks_usec >= 2_000_000);
  const after = recording.transactions.filter(
    (tx) => tx.meta.frame > resized.frame,
  );
  assert(after.length > 0, "transactions must continue after the resize");
  for (const tx of after) {
    assert.deepEqual(
      tx.meta.canvases.find((c) => c.role === "root")?.xform,
      [1, 0, 0, 1, 0, 0],
    );
  }
  const root = await json(join(dir, "evidence/root.json"));
  assert.equal(root.enforce.called, false);
  assert.equal(
    recording.session?.viewport?.host_size_status,
    "degenerate-window",
  );
  assert.deepEqual(
    recording.session?.viewport?.presentation_size,
    [2520, 1080],
  );
  const browser = join(out, "browser/resize/observe");
  const applied = await json(join(browser, "applied.json"));
  assert.equal(applied.status, "ok");
  assert.equal(applied.end_seen, true);
  assert.deepEqual(applied.viewport.size, [2520, 1080]);
  const shot = applied.shots.at(-1);
  const shotTx = recording.transactions.find((tx) => tx.meta.seq === shot.seq);
  assert(shotTx && shotTx.meta.frame >= final.frame);
  const shotPath = join(browser, "shots", `seq-${shot.seq}.png`);
  const image = await pixels(shotPath);
  assert.deepEqual([image.width, image.height], [2520, 1080]);
  await writeFile(
    join(out, "resize.json"),
    JSON.stringify(
      {
        session: recording.session,
        session_blocks: recording.session_blocks,
        before,
        resized,
        final,
        end: recording.end,
        transactions: recording.transactions.length,
        frames_after_resize: after.length,
        first_frame_after_resize: after[0].meta.frame,
        final_frame: recording.transactions.at(-1)?.meta.frame,
        post_resize_duration_s:
          (final.ticks_usec - resized.ticks_usec) / 1_000_000,
        receiver: {
          status: applied.status,
          failure: applied.failure,
          viewport: applied.viewport,
          unsupported: applied.unsupported,
        },
        browser_screenshot: shotPath,
        native_screenshot: join(dir, "window-resized.png"),
      },
      null,
      2,
    ),
  );
  console.log(`letterbox-pilot: resize passed at ${out}/resize.json`);
  process.exit(0);
}

const cases = [];
for (const [name, window, presentation] of [
  ["wide", [1920, 1080], [2520, 1080]],
  ["downscale", [2560, 1440], [1920, 1080]],
] as const) {
  const dir = join(out, name);
  const observed = await loadRecording(join(dir, "observe/recording.rs2"));
  const baseline = await loadRecording(join(dir, "headless/recording.rs2"));
  assert.deepEqual(observed.errors, []);
  assert.deepEqual(baseline.errors, []);
  assert.deepEqual(observed.session?.viewport?.presentation_size, presentation);
  assert.deepEqual(observed.session?.viewport?.logical_size, presentation);
  assert.deepEqual(observed.session?.viewport?.host_window_size, window);
  assert.equal(observed.session?.viewport?.root_size_policy, "observe");
  assert.equal(observed.session?.viewport?.stretch.mode, "canvas_items");
  assert.equal(observed.session?.viewport?.stretch.aspect, "keep");
  assert.equal(
    observed.session?.viewport?.host_size_status,
    "degenerate-window",
  );
  const observedRoot = await json(join(dir, "observe/evidence/root.json"));
  assert.equal(observedRoot.enforce.called, false);
  assert.deepEqual(observedRoot.before.window_size, window);
  assert.deepEqual(observedRoot.after.window_size, window);
  assert.deepEqual(observedRoot.before.visible_rect, [0, 0, ...presentation]);
  assert.deepEqual(observedRoot.after.visible_rect, [0, 0, ...presentation]);
  assert(observed.transactions.length > 0);
  assert(observed.transactions.every((tx) => tx.meta.failures.length === 0));
  await writeFile(
    join(dir, "session.json"),
    JSON.stringify(
      {
        observed: observed.session,
        observed_blocks: observed.session_blocks,
        baseline: baseline.session,
        baseline_blocks: baseline.session_blocks,
      },
      null,
      2,
    ),
  );
  const finalState = (recording: typeof observed) => {
    const meta = recording.transactions.at(-1)?.meta;
    assert(meta);
    return {
      canvases: meta.canvases,
      items: meta.items.map(({ id, parent, xform }) => ({ id, parent, xform })),
    };
  };
  const transforms = {
    observed: finalState(observed),
    baseline: finalState(baseline),
  };
  await writeFile(
    join(dir, "transforms.json"),
    JSON.stringify(transforms, null, 2),
  );

  // Godot floors the keep-aspect content dimensions, then rounds the centred margins.
  const scale = Math.min(
    window[0] / presentation[0],
    window[1] / presentation[1],
  );
  const width = Math.floor(presentation[0] * scale);
  const height = Math.floor(presentation[1] * scale);
  const crop = {
    left: Math.round((window[0] - width) / 2),
    top: Math.round((window[1] - height) / 2),
    width,
    height,
  };
  const nativeContent = join(dir, "native-content.png");
  const nativeLogical = join(dir, "native-content-logical.png");
  const host = await pixels(join(dir, "observe/window.png"));
  assert.deepEqual([host.width, host.height], window);
  await sharp(join(dir, "observe/window.png"))
    .extract(crop)
    .png()
    .toFile(nativeContent);
  await sharp(nativeContent)
    .resize(presentation[0], presentation[1], { kernel: "nearest" })
    .png()
    .toFile(nativeLogical);

  const gsw = join(out, "browser", name, "observe");
  const gswBaseline = join(out, "browser", name, "headless");
  const applied = await json(join(gsw, "applied.json"));
  assert.equal(applied.status, "ok");
  const seq = applied.shots.at(-1).seq;
  const baselineApplied = await json(join(gswBaseline, "applied.json"));
  const baselineSeq = baselineApplied.shots.at(-1).seq;
  const nativeApplied = await json(join(dir, "observe/receiver/applied.json"));
  assert.equal(nativeApplied.status, "ok");
  const nativeSeq = nativeApplied.shots.at(-1).seq;
  const gswShot = join(gsw, "shots", `seq-${seq}.png`);
  const baselineShot = join(gswBaseline, "shots", `seq-${baselineSeq}.png`);
  const regions: Record<string, Region> = {
    title: { left: 36, top: 32, width: 600, height: 60 },
    note: {
      left: presentation[0] - 215,
      top: presentation[1] - 105,
      width: 180,
      height: 80,
    },
    // Keep edge crops clear of the labels so AA geometry is measured separately.
    back_edge: { left: 14, top: 14, width: 32, height: 32 },
    corner_edge: {
      left: presentation[0] - 225,
      top: presentation[1] - 115,
      width: 35,
      height: 15,
    },
  };
  const regionComparisons = [];
  await mkdir(join(dir, "crops"), { recursive: true });
  for (const [label, region] of Object.entries(regions)) {
    const crops: Record<string, string> = {};
    for (const [mode, shot] of [
      ["observe", gswShot],
      ["headless", baselineShot],
    ]) {
      const path = join(dir, "crops", `${label}-${mode}.png`);
      await sharp(shot).extract(region).png().toFile(path);
      crops[mode] = path;
    }
    regionComparisons.push({
      label,
      crops,
      ...(await compare(gswShot, baselineShot, region)),
    });
  }
  const gswAtHost = join(dir, "gsw-at-host-size.png");
  await sharp(gswShot)
    .resize(width, height, { kernel: "nearest" })
    .png()
    .toFile(gswAtHost);
  cases.push({
    name,
    window,
    presentation,
    content_rect: crop,
    scale,
    effective_scale: [width / presentation[0], height / presentation[1]],
    root: observedRoot,
    receiver_viewport: {
      gsw: applied.viewport,
      native: nativeApplied.viewport,
    },
    logical_transforms_equal:
      JSON.stringify(transforms.observed) ===
      JSON.stringify(transforms.baseline),
    regions: regionComparisons,
    comparisons: {
      capture_vs_unarmed: await compare(
        join(dir, "observe/window.png"),
        join(dir, "reference/window.png"),
      ),
      viewport_vs_native_content: await compare(
        join(dir, "observe/shots/step-2.png"),
        nativeContent,
      ),
      gsw_vs_native_logical: await compare(gswShot, nativeLogical),
      gsw_vs_native_content: await compare(gswAtHost, nativeContent),
      gsw_vs_native_receiver: await compare(
        gswShot,
        join(dir, "observe/receiver/shots", `seq-${nativeSeq}.png`),
      ),
      gsw_vs_headless: await compare(gswShot, baselineShot),
    },
  });
}
await writeFile(join(out, "pilot.json"), JSON.stringify({ cases }, null, 2));
console.log(
  `letterbox-pilot: ${cases.length} cases recorded at ${out}/pilot.json`,
);
