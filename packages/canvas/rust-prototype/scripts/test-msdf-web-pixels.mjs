import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../../..');
const out = process.env.GSW_RUST_PROTOTYPE_OUT ?? resolve(root, '.sts2/rust-prototype-web');
const evidenceDir = resolve(root, '.sts2/msdf-phase2-web');
const glue = await readFile(resolve(out, 'rust_prototype.js'));
const wasm = await readFile(resolve(out, 'rust_prototype_bg.wasm'));
const browser = await chromium.launch({ headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
try {
  await mkdir(evidenceDir, { recursive: true });
  for (const scale of [0.5, 1, 3]) {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    await page.route('http://rust-msdf-proof.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/rust_prototype.js') await route.fulfill({ status: 200, contentType: 'text/javascript', body: glue });
      else if (path === '/rust_prototype_bg.wasm') await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
      else await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><style>html,body{margin:0}canvas{display:block;width:256px;height:256px}</style><canvas width="256" height="256"></canvas><script type="module">
        try {
          const module = await import('/rust_prototype.js');
          await module.default();
          const rust = await module.RustRenderer.create(document.querySelector('canvas'));
          window.rust = rust;
          const pixels = new Uint8Array(48*48*4);
          for (let y=0; y<48; y++) for (let x=0; x<48; x++) {
            const px=x+0.5, py=y+0.5;
            const inside=px>=12&&px<=36&&py>=12&&py<=36;
            const dx=Math.max(12-px,0,px-36), dy=Math.max(12-py,0,py-36);
            const distance=inside?Math.min(px-12,36-px,py-12,36-py):-Math.hypot(dx,dy);
            const value=Math.round(Math.max(0,Math.min(1,0.5+distance/4))*255);
            const alphaValue=Math.round(Math.max(0,Math.min(1,0.5+(distance+3)/4))*255);
            // RGB median controls fill; the deliberately wider alpha field controls MTSDF outline.
            const i=(y*48+x)*4; pixels[i]=0; pixels[i+1]=value; pixels[i+2]=value; pixels[i+3]=alphaValue;
          }
          window.atlasProbe=[...pixels.slice((24*48+9)*4,(24*48+9)*4+4)];
          const key=new TextEncoder().encode('atlas');
          const bytes=new Uint8Array(8+36+key.length+pixels.length);
          const view=new DataView(bytes.buffer);bytes.set([82,83,82,50]);view.setUint32(4,1,true);
          bytes[8]=0;bytes[9]=1;
          for (const [index,value] of [key.length,48,48,0,0,48,48,pixels.length].entries()) view.setUint32(12+index*4,value,true);
          bytes.set(key,44);bytes.set(pixels,44+key.length);
          rust.upload_rgba_batch(bytes);
          const scale=${scale};
          const scene={version:2,revision:1,width:256,height:256,designWidth:256,designHeight:256,
            resources:[{key:'atlas',width:48,height:48}],commands:[{id:'g',kind:'glyphRun',atlas:'atlas',
            m:[1,0,0,1,0,0],glyphs:[{src:[0,0,48,48],dst:[50,50,48*scale,48*scale]}],
            method:'msdf',fill:[1,0,0,1],outline:{color:[0,0,1,1],width:2},
            shadow:{color:[0,0,0,1],offset:[24*scale,24*scale]},pxRange:4,alpha:1}]};
          window.scene = scene;
          const admission=JSON.parse(rust.admit_scene(new TextEncoder().encode(JSON.stringify(scene))));
          const presented=JSON.parse(await rust.present());
          window.proof={admission,presented};
        } catch(error){window.proof={error:String(error)}}
      </script>` });
    });
    await page.goto('http://rust-msdf-proof.test/');
    await page.waitForFunction(() => window.proof !== undefined);
    const proof = await page.evaluate(() => window.proof);
    assert.equal(proof.error, undefined, JSON.stringify(proof));
    assert.equal(proof.admission.accepted, true, JSON.stringify(proof));
    assert.equal(proof.presented.presented, true, JSON.stringify(proof));
    const atlasProbe = await page.evaluate(() => window.atlasProbe);
    assert.deepEqual(atlasProbe.slice(0, 3), [0, 0, 0]);
    assert.ok(atlasProbe[3] >= 128, `alpha channel is not distinct: ${atlasProbe}`);
    const png = await page.screenshot({ omitBackground: true });
    const file = resolve(evidenceDir, `msdf-${String(scale).replace('.', '_')}x.png`);
    await writeFile(file, png);
    const sample = await page.evaluate(async ({ base64, scale }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const at=(x,y)=>[...ctx.getImageData(Math.floor(x),Math.floor(y),1,1).data];
      return { fill:at(50+24*scale,50+24*scale), outline:at(50+12*scale-1,50+24*scale),
        differential:at(50+9*scale,50+24*scale),
        shadow:at(50+54*scale,50+48*scale), outside:at(50,50) };
    }, { base64: png.toString('base64'), scale });
    assert.ok(sample.fill[0] > 220 && sample.fill[2] < 40 && sample.fill[3] > 220,
      `fill ${scale}x: ${JSON.stringify(sample)}`);
    assert.ok(sample.outline[2] > 100 && sample.outline[0] < 100 && sample.outline[3] > 80,
      `outline ${scale}x: ${JSON.stringify(sample)}`);
    assert.ok(sample.differential[2] > 100 && sample.differential[0] < 40 && sample.differential[3] > 80,
      `MTSDF alpha outline ${scale}x: ${JSON.stringify(sample)}`);
    assert.ok(sample.shadow[0] < 40 && sample.shadow[2] < 40 && sample.shadow[3] > 80,
      `shadow ${scale}x: ${JSON.stringify(sample)}`);
    assert.ok(sample.outside[3] < 20, `outside ${scale}x: ${JSON.stringify(sample)}`);
    console.log(JSON.stringify({ scale, sample, atlasProbe, image: file, backend: proof.presented.backend }));
    if (scale === 1) {
      const update = await page.evaluate(async () => {
        const key = new TextEncoder().encode('atlas');
        const region = new Uint8Array(8*8*4);
        const bytes = new Uint8Array(8+36+key.length+region.length);
        const view = new DataView(bytes.buffer); bytes.set([82,83,82,50]); view.setUint32(4,1,true);
        bytes[8]=1; bytes[9]=1;
        for (const [index,value] of [key.length,48,48,20,20,8,8,region.length].entries())
          view.setUint32(12+index*4,value,true);
        bytes.set(key,44); bytes.set(region,44+key.length);
        window.rust.upload_rgba_batch(bytes);
        window.scene.revision=2;
        const admission=JSON.parse(window.rust.admit_scene(new TextEncoder().encode(JSON.stringify(window.scene))));
        if (!admission.accepted) throw new Error(JSON.stringify(admission));
        return JSON.parse(await window.rust.present());
      });
      assert.equal(update.presented, true, JSON.stringify(update));
      const updatedPng = await page.screenshot({ omitBackground: true });
      const updatedFile = resolve(evidenceDir, 'msdf-1x-subrect.png');
      await writeFile(updatedFile, updatedPng);
      const centerAlpha = await page.evaluate(async (base64) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        return ctx.getImageData(74,74,1,1).data[3];
      }, updatedPng.toString('base64'));
      assert.ok(centerAlpha < 20, `subrect did not clear glyph center: ${centerAlpha}`);
      const released = await page.evaluate(async () => {
        const key=new TextEncoder().encode('atlas');
        const bytes=new Uint8Array(8+36+key.length);
        const view=new DataView(bytes.buffer);bytes.set([82,83,82,50]);view.setUint32(4,1,true);
        bytes[8]=2;view.setUint32(12,key.length,true);bytes.set(key,44);
        window.rust.upload_rgba_batch(bytes);
        window.scene.revision=3;
        const admission=JSON.parse(window.rust.admit_scene(new TextEncoder().encode(JSON.stringify(window.scene))));
        if (admission.accepted) throw new Error('released atlas admitted');
        return admission;
      });
      assert.ok(released.resourcePending > 0 || released.resource_pending > 0, JSON.stringify(released));
      console.log(JSON.stringify({ subrectCenterAlpha: centerAlpha, updatedImage: updatedFile,
        releasedAdmission: released }));
    }
    await page.close();
  }
} finally { await browser.close(); }
