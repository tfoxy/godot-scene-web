import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../../../..');
const wasmOut = process.env.GSW_RUST_PROTOTYPE_OUT ?? resolve(root, '.sts2/rust-prototype-web');
const faultInjection = process.env.GSW_RUST_FAULT_INJECTION === '1';
const evidenceDir = resolve(root, faultInjection ? '.sts2/rust-webgl-fault' : '.sts2/rust-webgl-integration');
const glue = await readFile(resolve(wasmOut, 'rust_prototype.js'));
const wasm = await readFile(resolve(wasmOut, 'rust_prototype_bg.wasm'));
const bundled = await build({ entryPoints: [resolve(import.meta.dirname, 'integration-browser-entry.ts')],
  bundle: true, platform: 'browser', format: 'esm', write: false, external: ['/rust_prototype.js'], logLevel: 'silent' });
const script = Buffer.from(bundled.outputFiles[0].contents);
const browser = await chromium.launch({ headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const results = {};
try {
  const page = await browser.newPage({ viewport: { width: 384, height: 128 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error));
  await page.route('http://rust-proof.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/rust_prototype.js') await route.fulfill({ status: 200, contentType: 'text/javascript', body: glue });
    else if (path === '/rust_prototype_bg.wasm') await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
    else if (path === '/proof.js') await route.fulfill({ status: 200, contentType: 'text/javascript', body: script });
    else await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><style>html,body{margin:0;background:#000}canvas{display:inline-block;vertical-align:top}</style><canvas id="rust" width="64" height="64"></canvas><canvas id="retained" width="64" height="64"></canvas><canvas id="pixi" width="64" height="64"></canvas><script type="module" src="/proof.js"></script>` });
  });
  await page.goto('http://rust-proof.test/', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.proof !== undefined, null, { timeout: 15000 });
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
  const receipt = { evidenceDir, faultInjection,
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
      cached: v.result?.cached, path: v.path }])) };
  await writeFile(resolve(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
