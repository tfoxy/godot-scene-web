import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../../../..');
const wasmOut = process.env.GSW_RUST_PROTOTYPE_OUT ?? resolve(root, '.sts2/rust-prototype-web');
const faultInjection = process.env.GSW_RUST_FAULT_INJECTION === '1';
const damageMain = process.env.GSW_RUST_DAMAGE_PRESENT === '1';
// GSW_RUST_PRESENT_MODE=<mode>: the main Rust steps use `createWithPresent(canvas, mode)`.
const presentMode = process.env.GSW_RUST_PRESENT_MODE ?? '';
// GSW_RUST_PRESENT_PARITY=1: every present mode joins the damage sequence (plus a resize), byte-compared.
const presentParity = process.env.GSW_RUST_PRESENT_PARITY === '1';
const evidenceDir = resolve(root, (faultInjection ? '.sts2/rust-webgl-fault' : '.sts2/rust-webgl-integration')
  + (damageMain ? '-damage' : '') + (presentMode ? `-present-${presentMode}` : '') + (presentParity ? '-parity' : ''));
const query = new URLSearchParams({ ...(damageMain ? { damage: '1' } : {}), ...(presentMode ? { present: presentMode } : {}),
  ...(presentParity ? { modes: '1' } : {}) }).toString();
const glue = await readFile(resolve(wasmOut, 'rust_prototype.js'));
const wasm = await readFile(resolve(wasmOut, 'rust_prototype_bg.wasm'));
const bundled = await build({ entryPoints: [resolve(import.meta.dirname, 'integration-browser-entry.ts')],
  bundle: true, platform: 'browser', format: 'esm', write: false, external: ['/rust_prototype.js'], logLevel: 'silent' });
const script = Buffer.from(bundled.outputFiles[0].contents);
const browser = await chromium.launch({ headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const results = {};
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: presentParity ? 700 : 220 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error));
  await page.route('http://rust-proof.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/rust_prototype.js') await route.fulfill({ status: 200, contentType: 'text/javascript', body: glue });
    else if (path === '/rust_prototype_bg.wasm') await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
    else if (path === '/proof.js') await route.fulfill({ status: 200, contentType: 'text/javascript', body: script });
    else await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><style>html,body{margin:0;background:#000}canvas{display:inline-block;vertical-align:top}</style><canvas id="rust" width="64" height="64"></canvas><canvas id="retained" width="64" height="64"></canvas><canvas id="pixi" width="64" height="64"></canvas><canvas id="damageOn" width="349" height="209"></canvas><canvas id="damageOff" width="349" height="209"></canvas><div id="modes"></div><script type="module" src="/proof.js"></script>` });
  });
  await page.goto(`http://rust-proof.test/${query ? `?${query}` : ''}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.proof !== undefined, null, { timeout: 15000 });
  const { presentModes, presentMode: createdMode, unknownModeError } = await page.evaluate(() => ({
    presentModes: window.proof.presentModes, presentMode: window.proof.presentMode, unknownModeError: window.proof.unknownModeError }));
  assert.equal(createdMode, presentMode || 'surface');
  assert.match(unknownModeError, /unknown present mode/);
  await mkdir(evidenceDir, { recursive: true });
  async function capture(id, name, points) {
    const image = await page.locator(`#${id}`).screenshot();
    const path = resolve(evidenceDir, `${name}.png`);
    await writeFile(path, image);
    const pixels = await page.evaluate(async ({ bytes, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${bytes}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    }, { bytes: image.toString('base64'), points });
    return { path, pixels };
  }
  const rustChecks = [
    ['initial', [[32, 32]], (p) => assert.ok(p[0][0] > 245 && p[0][1] < 10)],
    ['retainedPatch', [[32, 32]], (p) => assert.ok(p[0][1] > 245 && p[0][0] < 10)],
    ['resize', [[32, 32], [96, 32]], (p) => p.forEach((c) => assert.ok(c[2] > 245 && c[0] < 10))],
    ['text', [[32, 32]], () => {}],
    ['clipNinePatch', [[16, 32], [96, 32]], (p) => { assert.ok(p[0][0] > 245 && p[0][1] > 245); assert.ok(p[1][0] < 10 && p[1][1] < 10); }],
    ['rollback', [[16, 32], [96, 32]], (p) => { assert.ok(p[0][0] > 245 && p[0][1] > 245); assert.ok(p[1][0] < 10); }],
  ];
  for (const [name, points, check] of rustChecks) {
    const result = await page.evaluate(async (name) => await window.proof.rustSteps[name](), name);
    const captureResult = await capture('rust', `rust-${name}`, points);
    if (name === 'rollback') { assert.equal(result.admission.accepted, false); assert.equal(result.result.revision, 5); }
    else { assert.equal(result.admission.accepted, true, JSON.stringify(result)); assert.equal(result.result.presented, true); }
    check(captureResult.pixels);
    results[`rust-${name}`] = { result, ...captureResult };
  }
  const textImage = await readFile(results['rust-text'].path);
  const textCount = await page.evaluate(async (bytes) => {
    const blob = await (await fetch(`data:image/png;base64,${bytes}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 100 && data[i + 1] > 100 && data[i + 2] > 100) count++;
    return count;
  }, textImage.toString('base64'));
  assert.ok(textCount > 20, `raster text had only ${textCount} visible pixels`);
  results['rust-text'].visiblePixels = textCount;
  assert.deepEqual(await readFile(results['rust-rollback'].path), await readFile(results['rust-clipNinePatch'].path));
  if (faultInjection) {
    const failed = await page.evaluate(() => window.proof.rustSteps.faultRollback());
    const unchanged = await capture('rust', 'rust-faultRollback', [[16, 32], [96, 32]]);
    assert.equal(failed.admission.accepted, true);
    assert.equal(failed.result.presented, false);
    assert.equal(failed.result.revision, 5);
    assert.ok(failed.result.error, JSON.stringify(failed));
    assert.deepEqual(await readFile(unchanged.path), await readFile(results['rust-clipNinePatch'].path));
    results['rust-faultRollback'] = { result: failed, ...unchanged };

    const recovered = await page.evaluate(() => window.proof.rustSteps.faultRecovery());
    const changed = await capture('rust', 'rust-faultRecovery', [[16, 32], [96, 32]]);
    assert.equal(recovered.admission.accepted, true);
    assert.equal(recovered.result.presented, true);
    assert.equal(recovered.result.revision, 6);
    assert.ok(recovered.result.incrementalPatches >= 1, JSON.stringify(recovered));
    // The yellow source has no blue channel, so the cyan tint produces green.
    assert.ok(changed.pixels[0][0] < 10 && changed.pixels[0][1] > 245 && changed.pixels[0][2] < 10,
      JSON.stringify(changed));
    assert.ok(changed.pixels[1][0] < 10 && changed.pixels[1][1] < 10 && changed.pixels[1][2] < 10,
      JSON.stringify(changed));
    results['rust-faultRecovery'] = { result: recovered, ...changed };
  }
  if (!faultInjection) {
    // A clip translation patch: applied as clip-slot spans on the committed draw table, no geometry rebuild.
    const before = results['rust-clipNinePatch'].result.result;
    const moved = await page.evaluate(() => window.proof.rustSteps.clipTranslate());
    const shifted = await capture('rust', 'rust-clipTranslate', [[16, 32], [96, 32]]);
    assert.equal(moved.admission.accepted, true, JSON.stringify(moved));
    assert.equal(moved.result.presented, true, JSON.stringify(moved));
    assert.equal(moved.result.geometryRebuilds, before.geometryRebuilds, JSON.stringify(moved));
    assert.equal(moved.result.incrementalPatches, before.incrementalPatches + 1, JSON.stringify(moved));
    assert.ok(shifted.pixels[0][0] < 10 && shifted.pixels[0][1] < 10, JSON.stringify(shifted));
    assert.ok(shifted.pixels[1][0] > 245 && shifted.pixels[1][1] > 245, JSON.stringify(shifted));
    results['rust-clipTranslate'] = { result: moved, ...shifted };

    // A text change as a retained patch: one slot renamed on the committed draw table, no geometry rebuild,
    // and the same pixels as admitting the changed scene from scratch, before and after the old raster's release.
    const swapped = await page.evaluate(() => window.proof.rustSteps.textSwap());
    const swapPicture = await capture('rust', 'rust-textSwap', [[64, 32]]);
    assert.equal(swapped.admitted.admission.accepted, true, JSON.stringify(swapped));
    assert.equal(swapped.admission.accepted, true, JSON.stringify(swapped));
    assert.equal(swapped.result.presented, true, JSON.stringify(swapped));
    assert.equal(swapped.resourcesChanged, true);
    assert.equal(swapped.sameScene, true);
    assert.equal(swapped.result.geometryRebuilds, swapped.admitted.result.geometryRebuilds, JSON.stringify(swapped));
    assert.equal(swapped.result.incrementalPatches, swapped.admitted.result.incrementalPatches + 1, JSON.stringify(swapped));
    results['rust-textSwap'] = { result: swapped, ...swapPicture };
    const rebuilt = await page.evaluate(() => window.proof.rustSteps.textSwapFull());
    const rebuiltPicture = await capture('rust', 'rust-textSwapFull', [[64, 32]]);
    assert.equal(rebuilt.admission.accepted, true, JSON.stringify(rebuilt));
    assert.deepEqual(await readFile(swapPicture.path), await readFile(rebuiltPicture.path));
    results['rust-textSwapFull'] = { result: rebuilt, ...rebuiltPicture };
    const released = await page.evaluate(() => window.proof.rustSteps.textSwapRelease());
    const releasedPicture = await capture('rust', 'rust-textSwapRelease', [[64, 32]]);
    assert.equal(released.admission.accepted, true, JSON.stringify(released));
    assert.equal(released.result.presented, true, JSON.stringify(released));
    assert.deepEqual(await readFile(releasedPicture.path), await readFile(rebuiltPicture.path));
    results['rust-textSwapRelease'] = { result: released, ...releasedPicture };
  }
  if (!faultInjection) {
    // Damage present: byte-identical to a full redraw after every step of a seeded random
    // sequence of patches, re-admissions, texture rewrites and no-op presents.
    const plan = await page.evaluate((withResize) => window.proof.damagePlan(60, withResize), presentParity);
    const steps = ['initial', ...plan];
    const kinds = {};
    let identical = 0;
    const sequence = [];
    let lastOn;
    const modeStats = Object.fromEntries(presentModes.map((id) => [id, { full: 0, partial: 0, skip: 0, blitPixels: 0, surfacePixels: 0 }]));
    const lastPartialPixels = {};
    const savedKinds = new Set();
    for (const [index, name] of steps.entries()) {
      const [on, off, ...modes] = await page.evaluate((name) => window.proof.damageStep(name), name);
      for (const side of [on, off, ...modes]) {
        assert.notEqual(side.admission.accepted, false, `${name}: ${JSON.stringify(side)}`);
        assert.equal(side.result.presented, true, `${name}: ${JSON.stringify(side)}`);
      }
      if (name === 'idleReadmit') for (const side of [on, ...modes])
        assert.equal(side.admission.staleIdle, 0, `a set for a replaced revision is refused: ${JSON.stringify(side)}`);
      if (name.startsWith('idle') && name !== 'idleReadmit') for (const side of [on, ...modes])
        assert.equal(side.admission.stats.lastError, null, `${name}: ${JSON.stringify(side.admission)}`);
      const surfacePixels = (await page.locator('#damageOff').evaluate((c) => c.width * c.height));
      assert.equal(off.result.present, 'surface');
      assert.equal(off.result.blitPixels, surfacePixels, `${name}: the surface present copies the whole surface`);
      for (const [modeIndex, id] of presentModes.entries()) {
        const { result } = modes[modeIndex];
        const kind = result.damage ?? 'full';
        const stats = modeStats[id];
        stats[kind]++; stats.blitPixels += result.blitPixels; stats.surfacePixels += surfacePixels;
        const partialPixels = result.damageStats?.partialPixels ?? 0;
        const partialDelta = partialPixels - (lastPartialPixels[id] ?? 0);
        lastPartialPixels[id] = partialPixels;
        const preserved = result.present.startsWith('preserved');
        // A skip writes nothing; a preserved partial after a full blit writes exactly its damage
        // rectangles (the picture rectangles it redrew); everything else writes the whole surface.
        const expected = kind === 'skip' ? 0 : kind === 'partial' && preserved && name !== 'resize' ? partialDelta : surfacePixels;
        assert.equal(result.blitPixels, expected, `${id} ${name}: blitPixels ${JSON.stringify(result)}`);
        if (kind === 'partial' && preserved) assert.ok(result.blitPixels < surfacePixels, `${id} ${name}`);
      }
      assert.equal(off.result.damage, undefined, 'the default renderer reports no damage mode');
      kinds[on.result.damage] = (kinds[on.result.damage] ?? 0) + 1;
      sequence.push(`${name}:${on.result.damage}`);
      const [imageOn, imageOff] = [await page.locator('#damageOn').screenshot(), await page.locator('#damageOff').screenshot()];
      if (!imageOn.equals(imageOff)) {
        await writeFile(resolve(evidenceDir, `damage-mismatch-${index}-${name}-on.png`), imageOn);
        await writeFile(resolve(evidenceDir, `damage-mismatch-${index}-${name}-off.png`), imageOff);
        assert.fail(`damage present differs from a full redraw after step ${index} (${name}): ${JSON.stringify(on.result)}`);
      }
      // Evidence: the first full, partial and skipped step, the resize and the step after it, and the last step.
      const save = presentParity && (!savedKinds.has(on.result.damage) || name === 'resize'
        || steps[index - 1] === 'resize' || index === steps.length - 1);
      savedKinds.add(on.result.damage);
      for (const [modeIndex, id] of presentModes.entries()) {
        const image = await page.locator(`#${id}`).screenshot();
        if (save)
          await writeFile(resolve(evidenceDir, `parity-${String(index).padStart(2, '0')}-${name}-${on.result.damage}-${id}.png`), image);
        if (!image.equals(imageOff)) {
          await writeFile(resolve(evidenceDir, `parity-mismatch-${index}-${name}-${id}.png`), image);
          await writeFile(resolve(evidenceDir, `parity-mismatch-${index}-${name}-reference.png`), imageOff);
          assert.fail(`${id} differs from the surface full redraw after step ${index} (${name}): ${JSON.stringify(modes[modeIndex].result)}`);
        }
      }
      if (save)
        await writeFile(resolve(evidenceDir, `parity-${String(index).padStart(2, '0')}-${name}-${on.result.damage}-reference.png`), imageOff);
      identical++;
      lastOn = on;
      if (index === steps.length - 1) {
        await writeFile(resolve(evidenceDir, 'damage-final-on.png'), imageOn);
        await writeFile(resolve(evidenceDir, 'damage-final-off.png'), imageOff);
      }
    }
    const stats = lastOn.result.damageStats;
    assert.equal(stats.verifyMismatches, 0, JSON.stringify(stats));
    assert.ok(stats.partialPresents >= 10, JSON.stringify(stats));
    assert.ok(stats.fullPresents >= 2, JSON.stringify(stats));
    assert.ok(stats.skippedPresents >= 1, JSON.stringify(stats));
    results['rust-damage'] = { result: lastOn, steps: steps.length, identical, kinds, sequence, stats,
      path: resolve(evidenceDir, 'damage-final-on.png') };
    if (presentModes.length) {
      for (const [id, stats] of Object.entries(modeStats)) {
        assert.ok(stats.full >= 2, `${id}: ${JSON.stringify(stats)}`);
        if (!id.endsWith('Full')) assert.ok(stats.partial >= 10 && stats.skip >= 1, `${id}: ${JSON.stringify(stats)}`);
      }
      results['present-parity'] = { steps: steps.length, identical, modes: modeStats, sequence };
    }
  }
  for (const [name, change] of [['cold', false], ['warm', false], ['changed', true]]) {
    const result = await page.evaluate((change) => window.proof.retainedStep(change), change);
    const captureResult = await capture('retained', `retained-${name}`, [[32, 32]]);
    assert.equal(result.ok, true);
    if (change) assert.ok(result.pixel[2] > 245 && result.pixel[0] < 10, JSON.stringify(result));
    else assert.ok(result.pixel[0] > 245 && result.pixel[2] < 10, JSON.stringify(result));
    assert.equal(result.stats.retainedComposites, 1);
    results[`retained-${name}`] = { result, ...captureResult };
  }
  assert.equal(results['retained-warm'].result.stats.retainedRasterizations, 0);
  assert.equal(results['retained-changed'].result.stats.retainedRasterizations, 1);
  assert.ok(results['retained-changed'].result.textureRevision > results['retained-warm'].result.textureRevision);
  for (const name of ['initial', 'warm', 'patch']) {
    const result = await page.evaluate((name) => window.proof.pixiStep(name), name);
    const captureResult = await capture('pixi', `pixi-${name}`, [[16, 32], [48, 32]]);
    assert.equal(result.result.presented, true, JSON.stringify(result));
    const [left, right] = captureResult.pixels;
    if (name === 'patch') assert.ok(left[2] > 245 && left[0] < 10, JSON.stringify(captureResult));
    else assert.ok(left[0] > 245 && left[2] < 10, JSON.stringify(captureResult));
    assert.ok(right[1] > 245 && right[0] < 10, JSON.stringify(captureResult));
    results[`pixi-${name}`] = { result, ...captureResult };
  }
  assert.equal(results['pixi-initial'].result.cached, true);
  assert.equal(results['pixi-warm'].result.cached, true);
  assert.equal(results['pixi-patch'].result.cached, false);
  const receipt = { evidenceDir, faultInjection, damageMain, presentMode: presentMode || 'surface', presentParity,
    presentModes: results['present-parity'],
    source: 'packages/canvas/rust-prototype/scripts/integration-browser-entry.ts',
    glueSha256: createHash('sha256').update(glue).digest('hex'),
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { pixels: v.pixels,
      admissionAccepted: v.result?.admission?.accepted,
      presented: v.result?.result?.presented,
      revision: v.result?.result?.revision,
      error: v.result?.result?.error,
      incrementalPatches: v.result?.result?.incrementalPatches,
      geometryRebuilds: v.result?.result?.geometryRebuilds,
      instanceUploadBytes: v.result?.result?.instanceUploadBytes,
      retainedRasterizations: v.result?.stats?.retainedRasterizations,
      cached: v.result?.cached, path: v.path,
      ...(v.identical !== undefined ? { steps: v.steps, identical: v.identical, kinds: v.kinds, sequence: v.sequence, stats: v.stats } : {}) }])) };
  await writeFile(resolve(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
