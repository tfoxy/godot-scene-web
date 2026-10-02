import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../../..");
const wasmOut = resolve(root, ".sts2/msdf-generator-web");
const evidenceDir = resolve(root, ".sts2/msdf-generator-proof");
const fontPath =
  process.env.GSW_MSDF_PROBE_FONT ??
  resolve(
    root,
    "packages/canvas/msdf-generator/test/fixtures/LiberationSansNarrow-Regular.ttf",
  );
const glyphIds = (process.env.GSW_MSDF_PROBE_IDS ?? "37,50,35,3")
  .split(",")
  .map(Number);
const labels = (process.env.GSW_MSDF_PROBE_LABELS ?? "B,O,@,space").split(",");
const tag = process.env.GSW_MSDF_PROBE_TAG ?? "licensed-font";
const fontSha256 = createHash("sha256")
  .update(await readFile(fontPath))
  .digest("hex");
const wasmSha256 = createHash("sha256")
  .update(await readFile(resolve(wasmOut, "msdf_generator_bg.wasm")))
  .digest("hex");
const generatorCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(glyphIds.length, 4);
assert.equal(labels.length, 4);
await mkdir(evidenceDir, { recursive: true });
const files = new Map([
  [
    "/msdf-generator.js",
    [
      resolve(root, "packages/canvas/dist/msdf-generator.js"),
      "text/javascript",
    ],
  ],
  [
    "/msdf-generator-worker.js",
    [
      resolve(root, "packages/canvas/dist/msdf-generator-worker.js"),
      "text/javascript",
    ],
  ],
  [
    "/msdf_generator.js",
    [resolve(wasmOut, "msdf_generator.js"), "text/javascript"],
  ],
  [
    "/msdf_generator_bg.wasm",
    [resolve(wasmOut, "msdf_generator_bg.wasm"), "application/wasm"],
  ],
  ["/font.ttf", [fontPath, "font/ttf"]],
]);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 400 },
  });
  await context.route("http://msdf-proof.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const found = files.get(path);
    if (found)
      return route.fulfill({
        status: 200,
        contentType: found[1],
        body: await readFile(found[0]),
      });
    if (path !== "/") return route.fulfill({ status: 404, body: path });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><style>body{margin:0;background:#202020;color:white;font:14px sans-serif}canvas{display:block}</style><canvas width="1200" height="400"></canvas><script type="module">
      import { MsdfGenerator } from '/msdf-generator.js';
      try {
        const generator = new MsdfGenerator({wasmModuleUrl:'/msdf_generator.js'});
        const font = await (await fetch('/font.ttf')).arrayBuffer();
        const glyphIds=${JSON.stringify(glyphIds)}, labels=${JSON.stringify(labels)};
        const firstPromise = generator.generate(font.slice(0), glyphIds, 16);
        const rejectedFont = font.slice(0);
        let concurrentError='';
        try { await generator.generate(rejectedFont,glyphIds,16); }
        catch(error) { concurrentError=String(error); }
        const rejectedFontBytes=rejectedFont.byteLength;
        const first = await firstPromise;
        first.release();
        const second = await generator.generate(font.slice(0), glyphIds, 16);
        second.release();
        const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
        let x=12;
        for(let i=0;i<first.tiles.length;i++){
          const tile=first.tiles[i];ctx.fillStyle='white';ctx.fillText(labels[i],x,18);
          if(tile.width){
            const image=new ImageData(tile.width,tile.height);
            for(let n=0;n<tile.width*tile.height;n++){
              const k=n*4, r=tile.pixels[k],g=tile.pixels[k+1],b=tile.pixels[k+2];
              const median=Math.max(Math.min(r,g),Math.min(Math.max(r,g),b));
              image.data[k]=255;image.data[k+1]=255;image.data[k+2]=255;image.data[k+3]=median>=128?255:0;
            }
            const off=document.createElement('canvas');off.width=tile.width;off.height=tile.height;
            off.getContext('2d').putImageData(image,0,0);
            ctx.imageSmoothingEnabled=false;ctx.drawImage(off,x,24,tile.width*3,tile.height*3);
          }
          x+=Math.max(120,tile.width*3+12);
        }
        const hashes=tiles=>tiles.map(tile=>{let hash=2166136261;
          for(const byte of tile.pixels) hash=Math.imul(hash^byte,16777619);
          return hash>>>0;});
        const firstHashes=hashes(first.tiles), secondHashes=hashes(second.tiles);
        const thresholdMismatches=first.tiles.map(tile=>{let count=0, deep=0, farthest=0, sample=null;
          for(let n=0;n<tile.width*tile.height;n++){
            const k=n*4, r=tile.pixels[k],g=tile.pixels[k+1],b=tile.pixels[k+2],a=tile.pixels[k+3];
            const median=Math.max(Math.min(r,g),Math.min(Math.max(r,g),b));
            if((median>=128)!==(a>=128)){
              count++;
              const distance=Math.max(Math.abs(median-128),Math.abs(a-128));
              if(distance>16) deep++;
              if(distance>farthest){farthest=distance;sample={x:n%tile.width,y:Math.floor(n/tile.width),median,alpha:a};}
            }
          }
          return {count,deep,farthest,sample};});
        let invalidFontError='';
        try { await generator.generate(new Uint8Array([1,2,3,4]).buffer,[37],16); }
        catch(error) { invalidFontError=String(error); }
        const afterFailure=await generator.generate(font.slice(0),[glyphIds[0]],16);
        afterFailure.release();
        const broken=new MsdfGenerator({wasmModuleUrl:'/missing-module.js'});
        let loadError='';
        try { await broken.generate(font.slice(0),[glyphIds[0]],16); }
        catch(error) { loadError=String(error); }
        broken.dispose();
        window.proof={firstHashes,secondHashes,thresholdMismatches,concurrentError,rejectedFontBytes,
          generationMs:first.generationMs,
          warmGenerationMs:second.generationMs,wasmMemoryBytes:first.wasmMemoryBytes,
          warmWasmMemoryBytes:second.wasmMemoryBytes,invalidFontError,loadError,
          recovered:afterFailure.tiles.length===1,tiles:first.tiles.map(tile=>({glyphId:tile.glyphId,
          width:tile.width,height:tile.height,left:tile.left,top:tile.top,advance:tile.advance,
          bytes:tile.pixels.byteLength}))};
        generator.dispose();
      }catch(error){window.proof={error:String(error),stack:String(error?.stack)}}
    </script>`,
    });
  });
  const page = await context.newPage();
  await page.goto("http://msdf-proof.test/");
  await page.waitForFunction(() => window.proof !== undefined, undefined, {
    timeout: 60000,
  });
  const proof = await page.evaluate(() => window.proof);
  assert.equal(proof.error, undefined, JSON.stringify(proof));
  assert.deepEqual(proof.firstHashes, proof.secondHashes);
  assert.match(proof.concurrentError, /credit in use/);
  assert.equal(proof.rejectedFontBytes, (await readFile(fontPath)).byteLength);
  assert.equal(proof.tiles.length, 4);
  assert.ok(
    proof.tiles
      .slice(0, 3)
      .every(
        (tile) => tile.bytes === tile.width * tile.height * 4 && tile.bytes > 0,
      ),
  );
  assert.equal(proof.tiles[3].bytes, 0);
  assert.ok(proof.tiles[3].advance > 0);
  assert.match(proof.invalidFontError, /invalid font bytes/);
  assert.match(proof.loadError, /missing-module/);
  assert.equal(proof.recovered, true);
  assert.ok(proof.wasmMemoryBytes > 0);
  const image = resolve(evidenceDir, `${tag}-contours.png`);
  await writeFile(image, await page.screenshot());
  const summary = {
    ...proof,
    secondHashes: undefined,
    fontSha256,
    fontBytes: (await readFile(fontPath)).byteLength,
    faceIndex: 0,
    glyphIds,
    fullRange: 16,
    generatorCommit,
    wasmSha256,
    shapingProof: false,
    image,
  };
  await writeFile(
    resolve(evidenceDir, `${tag}-operation.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  await context.close();
} finally {
  await browser.close();
}
