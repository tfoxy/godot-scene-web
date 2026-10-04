import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../../..');
const out = process.env.GSW_RUST_PROTOTYPE_OUT ?? resolve(root, '.sts2/rust-prototype-web');
// GSW_RUST_PRESENT_MODE=<mode> creates the renderer through `createWithPresent(canvas, mode)`.
// GSW_RUST_BACKEND=gl creates it through `createWithGl(canvas, mode)` (mode defaults to `direct`).
const glBackend = process.env.GSW_RUST_BACKEND === 'gl';
const presentMode = process.env.GSW_RUST_PRESENT_MODE || (glBackend ? 'direct' : '');
const suffix = `${glBackend ? '-gl' : ''}${presentMode ? `-${presentMode}` : ''}`;
const evidence = resolve(root, `.sts2/rust-webgl-proof/transparent-red-alpha${suffix}.png`);
const layeredEvidence = resolve(root, `.sts2/rust-webgl-proof/layered-gamma${suffix}.png`);
// Godot 2D and the DOM tint and blend in gamma (sRGB-encoded) space, so must the renderer: a white texture
// tinted #A78A67 is #A78A67, and black at 0.85 over grey 128 is 128 * 0.15 = 19.2. Blending in linear light
// instead reads about (212, 194, 171) and 69.
const layeredChecks = [
  // [label, x, y, expected rgb, tolerance]
  ['uploaded white texture tinted #A78A67', 16, 16, [167, 138, 103], 1],
  ['built-in white tinted #877256', 48, 16, [135, 114, 86], 1],
  ['black at alpha 0.85 over grey 128', 32, 48, [19, 19, 19], 2],
];
const glue = await readFile(resolve(out, 'rust_prototype.js'));
const wasm = await readFile(resolve(out, 'rust_prototype_bg.wasm'));
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
});
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 160 }, deviceScaleFactor: 1 });
  await page.route('http://rust-proof.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/rust_prototype.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: glue });
    } else if (path === '/rust_prototype_bg.wasm') {
      await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><canvas width="64" height="64"></canvas><canvas id="layered" width="64" height="64"></canvas><script type="module">
        const create = (module, canvas) => ${glBackend ? `module.RustRenderer.createWithGl(canvas, ${JSON.stringify(presentMode)})` : presentMode ? `module.RustRenderer.createWithPresent(canvas, ${JSON.stringify(presentMode)})` : `module.RustRenderer.create(canvas)`};
        const quad = (id, resource, rect, src, color) => ({id, kind:'quad', resource, m:[1,0,0,1,rect[0],rect[1]], w:rect[2], h:rect[3],
          src, color, blend:'mix', flipH:false, flipV:false, colorMatrix:null});
        try {
          const module = await import('/rust_prototype.js');
          await module.default();
          const layered = await create(module, document.getElementById('layered'));
          // RSR1: one 2x2 opaque white resource, uploaded as sRGB bytes.
          const key = new TextEncoder().encode('white');
          const pixels = new Uint8Array(2 * 2 * 4).fill(255);
          const upload = new Uint8Array(8 + 16 + key.length + pixels.length);
          const view = new DataView(upload.buffer);
          upload.set([82, 83, 82, 49]); view.setUint32(4, 1, true);
          [key.length, 2, 2, pixels.length].forEach((value, index) => view.setUint32(8 + index * 4, value, true));
          upload.set(key, 24); upload.set(pixels, 24 + key.length);
          layered.upload_rgba_batch(upload);
          const grey = 128 / 255;
          const layeredScene = {version:2,revision:1,width:64,height:64,designWidth:64,designHeight:64,
            resources:[{key:'white',width:2,height:2}],commands:[
              quad('grey', null, [0,0,64,64], [0,0,1,1], [grey,grey,grey,1]),
              quad('tinted', 'white', [0,0,32,32], [0,0,2,2], [167/255,138/255,103/255,1]),
              quad('builtin', null, [32,0,32,32], [0,0,1,1], [135/255,114/255,86/255,1]),
              quad('backstop', null, [0,32,64,32], [0,0,1,1], [0,0,0,0.85])]};
          const layeredAdmission = JSON.parse(layered.admit_scene(new TextEncoder().encode(JSON.stringify(layeredScene))));
          const layeredResult = JSON.parse(await layered.present());
          window.layered = {admission: layeredAdmission, result: layeredResult, gammaBlend: layered.gamma_blend};
          const renderer = await create(module, document.querySelector('canvas'));
          const scene = {version:2,revision:1,width:64,height:64,designWidth:64,designHeight:64,resources:[],commands:[{id:'semi',kind:'quad',resource:null,m:[1,0,0,1,0,0],w:64,h:64,src:[0,0,1,1],color:[0.5,0,0,0.5],blend:'mix',flipH:false,flipV:false,colorMatrix:null}]};
          const admission = JSON.parse(renderer.admit_scene(new TextEncoder().encode(JSON.stringify(scene))));
          const result = JSON.parse(await renderer.present());
          window.proof = {admission,result};
        } catch (error) { window.proof = {error:String(error)}; }
      </script>` });
    }
  });
  await page.goto('http://rust-proof.test/');
  await page.waitForFunction(() => window.proof !== undefined);
  const proof = await page.evaluate(() => window.proof);
  assert.equal(proof.error, undefined, JSON.stringify(proof));
  assert.equal(proof.admission.accepted, true);
  assert.equal(proof.result.presented, true);
  assert.equal(proof.result.backend, glBackend ? 'webgl2-gl' : 'webgl2');
  assert.equal(proof.result.present, presentMode || 'surface');
  assert.equal(proof.result.blitPixels, 64 * 64);
  const screenshot = await page.screenshot({ omitBackground: true });
  const encoded = screenshot.toString('base64');
  const pixel = await page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(32, 32, 1, 1).data];
  }, encoded);
  assert.ok(pixel[0] >= 250 && pixel[1] <= 2 && pixel[2] <= 2 && Math.abs(pixel[3] - 128) <= 2,
    `premultiplied copy changed transparent red: ${pixel}`);
  await mkdir(resolve(root, '.sts2/rust-webgl-proof'), { recursive: true });
  await writeFile(evidence, screenshot);

  const layered = await page.evaluate(() => window.layered);
  assert.equal(layered.admission.accepted, true, JSON.stringify(layered));
  assert.equal(layered.result.presented, true, JSON.stringify(layered));
  assert.equal(layered.gammaBlend, true, 'the renderer advertises gamma-space blending');
  const layeredShot = await page.locator('#layered').screenshot({ omitBackground: true });
  await writeFile(layeredEvidence, layeredShot);
  const layeredPixels = await page.evaluate(async ({ data, points }) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  }, { data: layeredShot.toString('base64'), points: layeredChecks.map(([, x, y]) => [x, y]) });
  for (const [index, [label, , , expected, tolerance]] of layeredChecks.entries()) {
    const actual = layeredPixels[index];
    assert.ok(expected.every((value, channel) => Math.abs(actual[channel] - value) <= tolerance) && actual[3] === 255,
      `${label}: expected ${expected} (+-${tolerance}), read ${actual} (${layeredEvidence})`);
  }
  console.log(JSON.stringify({ pixel, evidence, revision: proof.result.revision, present: proof.result.present,
    backend: proof.result.backend, layered: layeredPixels, layeredEvidence }));
} finally {
  await browser.close();
}
