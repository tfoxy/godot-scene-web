import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../../..");
const out =
  process.env.GSW_RUST_PROTOTYPE_OUT ??
  resolve(root, ".sts2/rust-prototype-web");
const evidence = resolve(root, ".sts2/rust-webgl-proof");
const glue = await readFile(resolve(out, "rust_prototype.js"));
const wasm = await readFile(resolve(out, "rust_prototype_bg.wasm"));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 64, height: 64 },
    deviceScaleFactor: 1,
  });
  await page.route("http://atlas-proof.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/rust_prototype.js")
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: glue,
      });
    if (path === "/rust_prototype_bg.wasm")
      return route.fulfill({
        status: 200,
        contentType: "application/wasm",
        body: wasm,
      });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><canvas width="64" height="64"></canvas><script type="module">
      try {
        const module=await import('/rust_prototype.js');await module.default();
        const canvas=document.querySelector('canvas');let renderer=await module.RustRenderer.create(canvas);
        const encode=(operation,key,pixels=new Uint8Array(0))=>{
          const name=new TextEncoder().encode(key), bytes=new Uint8Array(8+36+name.length+pixels.length), view=new DataView(bytes.buffer);
          bytes.set([82,83,82,50]);view.setUint32(4,1,true);
          const op=operation==='allocate'?3:operation==='subrect'?1:2;
          bytes[8]=op;bytes[9]=operation==='release'?0:1;
          const fields=[name.length,operation==='release'?0:8,operation==='release'?0:8,
            operation==='subrect'?2:0,operation==='subrect'?2:0,
            operation==='subrect'?4:0,operation==='subrect'?4:0,pixels.length];
          fields.forEach((value,i)=>view.setUint32(12+4*i,value,true));bytes.set(name,44);bytes.set(pixels,44+name.length);
          return bytes;
        };
        const scene=(key,revision)=>({version:2,revision,width:64,height:64,designWidth:64,designHeight:64,
          resources:[{key,width:8,height:8}],commands:[{id:'glyph',kind:'glyphRun',atlas:key,
          m:[1,0,0,1,0,0],glyphs:[{src:[0,0,8,8],dst:[0,0,64,64]}],method:'msdf',
          fill:[1,1,1,1],outline:null,shadow:null,pxRange:8,alpha:1}]});
        const admit=(value)=>JSON.parse(renderer.admit_scene(new TextEncoder().encode(JSON.stringify(value))));
        const present=async()=>JSON.parse(await renderer.present());
        const allocate=renderer.upload_rgba_batch(encode('allocate','atlas:g1'));
        const duplicate=(()=>{try{renderer.upload_rgba_batch(encode('allocate','atlas:g1'));return false}catch{return true}})();
        const firstAdmission=admit(scene('atlas:g1',1));const fresh=await present();
        window.first={allocate,duplicate,firstAdmission,fresh};
        await new Promise(resolve=>window.resumeFirst=resolve);
        const filled=new Uint8Array(4*4*4).fill(255);
        const subrect=renderer.upload_rgba_batch(encode('subrect','atlas:g1',filled));
        const secondAdmission=admit(scene('atlas:g1',2));
        const updated=await present();window.second={subrect,secondAdmission,updated};
        await new Promise(resolve=>window.resumeSecond=resolve);
        renderer.upload_rgba_batch(encode('release','atlas:g1'));
        renderer.dispose();canvas.remove();
        const newCanvas=document.createElement('canvas');newCanvas.width=newCanvas.height=64;document.body.append(newCanvas);
        renderer=await module.RustRenderer.create(newCanvas);
        const recreatedAllocation=renderer.upload_rgba_batch(encode('allocate','atlas:g2'));
        const recreatedAdmission=admit(scene('atlas:g2',1));const recreated=await present();
        window.third={recreatedAllocation,recreatedAdmission,recreated};
        renderer.dispose();
      }catch(error){window.failure=String(error)}
    </script>`,
    });
  });
  await page.goto("http://atlas-proof.test/");
  const pixelsOf = (png) =>
    page.evaluate(async (data) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const image = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return {
        center: [...context.getImageData(32, 32, 1, 1).data],
        corner: [...context.getImageData(4, 4, 1, 1).data],
      };
    }, png.toString("base64"));
  await page.waitForFunction(() => window.first || window.failure);
  const first = await page.evaluate(() => window.first ?? window.failure);
  assert.equal(typeof first, "object", String(first));
  assert.equal(first.allocate, 1);
  assert.equal(first.duplicate, true);
  assert.equal(first.firstAdmission.accepted, true);
  assert.equal(first.fresh.presented, true);
  const freshImage = resolve(evidence, "atlas-allocate-transparent.png");
  const freshPng = await page.screenshot({ omitBackground: true });
  await writeFile(freshImage, freshPng);
  const freshPixels = await pixelsOf(freshPng);
  assert.ok(
    freshPixels.center[3] <= 1 && freshPixels.corner[3] <= 1,
    JSON.stringify(freshPixels),
  );
  await page.evaluate(() => window.resumeFirst());
  await page.waitForFunction(() => window.second || window.failure);
  const second = await page.evaluate(() => window.second ?? window.failure);
  assert.equal(second.subrect, 1);
  assert.equal(second.secondAdmission.accepted, true);
  assert.equal(second.updated.presented, true);
  const subrectImage = resolve(evidence, "atlas-allocate-subrect.png");
  const subrectPng = await page.screenshot({ omitBackground: true });
  await writeFile(subrectImage, subrectPng);
  const subrectPixels = await pixelsOf(subrectPng);
  assert.ok(
    subrectPixels.center[3] >= 200 && subrectPixels.corner[3] <= 1,
    JSON.stringify(subrectPixels),
  );
  await page.evaluate(() => window.resumeSecond());
  await page.waitForFunction(() => window.third || window.failure);
  const third = await page.evaluate(() => window.third ?? window.failure);
  assert.equal(third.recreatedAllocation, 1);
  assert.equal(third.recreatedAdmission.accepted, true);
  assert.equal(third.recreated.presented, true);
  const recreatedImage = resolve(evidence, "atlas-allocate-recreated.png");
  const recreatedPng = await page.screenshot({ omitBackground: true });
  await writeFile(recreatedImage, recreatedPng);
  const recreatedPixels = await pixelsOf(recreatedPng);
  assert.ok(
    recreatedPixels.center[3] <= 1 && recreatedPixels.corner[3] <= 1,
    JSON.stringify(recreatedPixels),
  );
  console.log(
    JSON.stringify({
      first,
      second,
      third,
      pixels: [freshPixels, subrectPixels, recreatedPixels],
      images: [freshImage, subrectImage, recreatedImage],
    }),
  );
} finally {
  await browser.close();
}
