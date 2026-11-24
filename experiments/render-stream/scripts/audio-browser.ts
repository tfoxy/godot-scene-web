// Run through run-audio-browser.sh. Uses the worktree's built audio entry and rs_live_host --audio.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type AudioBrowserEvidence,
  checkAudioBrowser,
} from "./check-audio-browser";
import { launchHarnessBrowser } from "./lib/browser-harness";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[process.argv.indexOf("--out") + 1]);
mkdirSync(out, { recursive: true });
const dist = join(root, "packages/render-stream-client/dist");
const server = createServer((req, res) => {
  if (req.url?.split("?")[0] === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<button id="open">Open audio</button><script type="module" src="/probe.js"></script>',
    );
    return;
  }
  if (req.url === "/probe.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(`
import {openAudioTrack} from '/dist/audio.js';
window.rows=[]; window.events=[]; window.delays=[];
document.querySelector('#open').onclick=()=>{
 const ctx=window.ctx=new AudioContext({latencyHint:'interactive'});
 const p=new URL(location.href).searchParams;
 window.track=openAudioTrack({url:p.get('url'),credential:p.get('credential'),context:ctx,path:p.get('path')==='main'?'main':undefined,reconnect:false,
 fetchAsset:async(hash,{cache})=>{const r=await fetch(p.get('base')+'/resources/sha256/'+hash,{cache,headers:{Authorization:'Bearer '+p.get('token')}});if(!r.ok)throw Error(r.status);return r.arrayBuffer();},
 onEvent:e=>window.events.push(e),onStage:r=>{ window.rows.push(r); if(r.type==='cached-start'){ const handle=window.rows.filter(x=>x.type==='cue'&&x.t===r.t).at(-1); const start=performance.now()-(ctx.currentTime-r.contextTime)*1000; window.delays.push(start-handle.handledMs); } }
 });
};`);
    return;
  }
  const file = req.url?.startsWith("/dist/") ? req.url.slice(6) : "";
  if (!file || file.includes("..")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/javascript");
    res.end(readFileSync(join(dist, file)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let passed = 0;
const results: AudioBrowserEvidence[] = [];
let browser:
  | Awaited<ReturnType<typeof launchHarnessBrowser>>["browser"]
  | undefined;
try {
  browser = (await launchHarnessBrowser()).browser;
  for (const path of ["main", "worklet"] as const) {
    const dir = join(out, path);
    mkdirSync(dir, { recursive: true });
    const commands = join(dir, "commands.txt");
    writeFileSync(commands, "");
    const token = "ef".repeat(32);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("GRC_")) delete env[k];
    const host = spawn(
      join(root, "experiments/render-stream/capture/build/rs_live_host"),
      [
        "--audio",
        "--audio-demo",
        `--token=${token}`,
        `--audio-commands=${commands}`,
        `--evidence-dir=${dir}`,
        "--track-keepalive-ms=30000",
      ],
      {
        env: { ...env, GRC_LIVE_ALLOWED_ORIGINS: origin },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    host.stderr.on("data", (d) => {
      stderr += d;
    });
    const exited = new Promise((resolve) => host.once("exit", resolve));
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      const port = await new Promise<number>((yes, no) => {
        const timer = setTimeout(
          () => no(new Error(`host timeout: ${stderr}`)),
          10000,
        );
        createInterface({ input: host.stdout }).on("line", (line) => {
          const m = /^RS_LIVE_HOST_PORT (\d+)$/.exec(line);
          if (m) {
            clearTimeout(timer);
            yes(Number(m[1]));
          }
        });
        host.once("exit", (code) => {
          clearTimeout(timer);
          no(new Error(`host exit ${code}: ${stderr}`));
        });
      });
      const credential = readFileSync(
        join(dir, "live-track-audio-token"),
        "utf8",
      ).trim();
      const base = `http://127.0.0.1:${port}`;
      await page.goto(
        `${origin}/?${new URLSearchParams({ path, url: `ws://127.0.0.1:${port}/render-stream`, credential, base, token })}`,
      );
      await page.click("#open");
      const wait = (expression: string) =>
        page.waitForFunction(expression, undefined, { timeout: 12000 });
      await wait(
        "window.track?.state==='open' && window.rows.some(r=>r.type==='take-source-start') && window.rows.some(r=>r.type==='sample-stop') && window.rows.some(r=>r.type==='lane-start')",
      );
      await delay(100);
      appendFileSync(commands, "cue\npair\nstart\n");
      await wait(
        "window.events.filter(e=>e.type==='start').length===3 && window.rows.some(r=>r.type==='cached-start')",
      );
      await delay(80);
      appendFileSync(commands, "stop\n");
      await wait("window.rows.filter(r=>r.type==='sample-stop').length===3");
      const stall = () => {
        const end = performance.now() + 250;
        while (performance.now() < end) {
          /* intentional receiver stall */
        }
      };
      if (path === "worklet") {
        const worker = page
          .workers()
          .find((w) => w.url().includes("transport.worker"));
        assert.ok(worker, "worklet has Worker-owned socket");
        await worker.evaluate(stall);
      } else await page.evaluate(stall);
      await wait("window.rows.some(r=>r.type==='lane-drop')");
      await delay(120);
      const evidence = await page.evaluate((path) => {
        const w = window as unknown as {
          events: { type: string; voice: number }[];
          rows: AudioBrowserEvidence["stages"];
          delays: number[];
        };
        return {
          path,
          starts: w.events
            .filter((e) => e.type === "start")
            .map((e) => e.voice),
          stops: w.events.filter((e) => e.type === "stop").map((e) => e.voice),
          stages: w.rows,
          cachedHandleToStartMs: w.delays,
        };
      }, path);
      const row: AudioBrowserEvidence = {
        ...evidence,
        worker: page
          .workers()
          .some((w) => w.url().includes("transport.worker")),
      };
      writeFileSync(join(dir, "client.json"), JSON.stringify(row, null, 2));
      const failures = checkAudioBrowser(row);
      assert.deepEqual(errors, [], "browser errors");
      assert.deepEqual(failures, [], `${path} acceptance`);
      results.push(row);
      passed++;
      await page.evaluate(async () => {
        const w = window as unknown as {
          track: { close(): void; finished: Promise<unknown> };
          ctx: AudioContext;
        };
        w.track.close();
        await w.track.finished;
        await w.ctx.close();
      });
    } finally {
      writeFileSync(join(dir, "browser-errors.json"), JSON.stringify(errors));
      await page
        .evaluate(() => {
          const w = window as unknown as {
            rows: unknown;
            events: unknown;
            track?: { state: string };
          };
          return { rows: w.rows, events: w.events, state: w.track?.state };
        })
        .then((data) =>
          writeFileSync(join(dir, "debug.json"), JSON.stringify(data, null, 2)),
        )
        .catch(() => {});
      await page.close();
      host.kill("SIGTERM");
      await exited;
      writeFileSync(join(dir, "host-stderr.log"), stderr);
    }
  }
} finally {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
}
writeFileSync(
  join(out, "summary.json"),
  JSON.stringify(
    {
      passed,
      failed: 0,
      skipped: 0,
      legs: results.map((r) => ({
        path: r.path,
        cachedHandleToStartMs: r.cachedHandleToStartMs,
      })),
    },
    null,
    2,
  ),
);
console.log(`${passed} passed, 0 failed, 0 skipped; evidence ${out}`);
