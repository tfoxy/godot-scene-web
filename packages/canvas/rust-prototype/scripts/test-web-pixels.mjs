import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../../..');
const out = process.env.GSW_RUST_PROTOTYPE_OUT ?? resolve(root, '.sts2/rust-prototype-web');
// GSW_RUST_PRESENT_MODE=<mode> creates the renderer through `createWithPresent(canvas, mode)`.
const presentMode = process.env.GSW_RUST_PRESENT_MODE ?? '';
const evidence = resolve(root, `.sts2/rust-webgl-proof/transparent-red-alpha${presentMode ? `-${presentMode}` : ''}.png`);
const glue = await readFile(resolve(out, 'rust_prototype.js'));
const wasm = await readFile(resolve(out, 'rust_prototype_bg.wasm'));
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
});
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
  await page.route('http://rust-proof.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/rust_prototype.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: glue });
    } else if (path === '/rust_prototype_bg.wasm') {
      await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><canvas width="64" height="64"></canvas><script type="module">
        try {
          const module = await import('/rust_prototype.js');
          await module.default();
          const renderer = ${presentMode ? `await module.RustRenderer.createWithPresent(document.querySelector('canvas'), ${JSON.stringify(presentMode)})` : `await module.RustRenderer.create(document.querySelector('canvas'))`};
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
  assert.equal(proof.result.backend, 'webgl2');
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
  console.log(JSON.stringify({ pixel, evidence, revision: proof.result.revision, present: proof.result.present }));
} finally {
  await browser.close();
}
