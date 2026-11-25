// Correctness only: real audio client over impaired UDP against rs_live_host --audio.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { launchHarnessBrowser } from "./lib/browser-harness";
import { startImpairProxy } from "./lib/udp-impair-proxy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[process.argv.indexOf("--out") + 1]);
mkdirSync(out, { recursive: true });
const dist = join(root, "packages/render-stream-client/dist");
const server = createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "";
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(`<button id="open">Audio</button><script type="module">
import {openAudioTrack} from '/dist/audio.js';
const p=new URL(location.href).searchParams;
window.rows=[];window.events=[];window.audioClosed=null;
document.querySelector('#open').onclick=()=>{
 const context=window.context=new AudioContext();
 window.track=openAudioTrack({url:p.get('ws'),webTransport:{url:p.get('wt'),certificateHashes:[p.get('cert')],features:3},
 carrier:'webtransport',credential:p.get('credential'),context,path:p.get('path'),reconnect:false,
 fetchAsset:async(hash,{cache})=>{const r=await fetch(p.get('http')+'/resources/sha256/'+hash,{cache,headers:{Authorization:'Bearer '+p.get('token')}});if(!r.ok)throw Error(r.status);return r.arrayBuffer();},
 onEvent:e=>window.events.push(e),onStage:r=>window.rows.push(r),onClose:i=>window.audioClosed=i});
};</script>`);
    return;
  }
  if (!path.startsWith("/dist/") || path.includes("..")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/javascript");
    res.end(readFileSync(join(dist, path.slice(6))));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = (await launchHarnessBrowser()).browser;
let passed = 0;
const results: unknown[] = [];
try {
  for (const path of ["main", "worklet"]) {
    const dir = join(out, path);
    mkdirSync(dir, { recursive: true });
    const token = "ef".repeat(32);
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GRC_")) delete env[key];
    const host = spawn(
      join(root, "experiments/render-stream/capture/build/rs_live_host"),
      [
        "--audio",
        "--audio-demo",
        "--carriers=ws,wt",
        `--net-module=${join(root, "experiments/render-stream/capture/build/librender_stream_net.so")}`,
        `--token=${token}`,
        `--evidence-dir=${dir}`,
        "--track-keepalive-ms=30000",
      ],
      {
        env: { ...env, GRC_LIVE_ALLOWED_ORIGINS: origin },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    host.stderr.on("data", (b) => {
      log += b;
    });
    const exited = new Promise<number | null>((r) => host.once("exit", r));
    const values = new Map<string, string>();
    createInterface({ input: host.stdout }).on("line", (line) => {
      log += `${line}\n`;
      const m = /^RS_LIVE_HOST_(PORT|WT_PORT|CERT_SHA256) (.+)$/.exec(line);
      if (m) values.set(m[1], m[2]);
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    let proxy: Awaited<ReturnType<typeof startImpairProxy>> | undefined;
    try {
      const end = Date.now() + 15000;
      while (values.size < 3) {
        assert.ok(Date.now() < end, `host timeout: ${log}`);
        await delay(10);
      }
      // Both directions exceed the lane expiry window together; FIN'd streams wait for ACK.
      // Packet loss and jitter exercise retransmission of the reliable take independently.
      proxy = await startImpairProxy(
        { host: "127.0.0.1", port: Number(values.get("WT_PORT")) },
        { loss: 0.02, delayMs: 45, jitterMs: 10, seed: 37 },
      );
      const url = new URL(origin);
      url.searchParams.set(
        "ws",
        `ws://127.0.0.1:${values.get("PORT")}/render-stream`,
      );
      url.searchParams.set(
        "wt",
        `https://127.0.0.1:${proxy.port}/render-stream`,
      );
      url.searchParams.set("cert", values.get("CERT_SHA256")!);
      url.searchParams.set(
        "credential",
        readFileSync(join(dir, "live-track-audio-token"), "utf8").trim(),
      );
      url.searchParams.set("token", token);
      url.searchParams.set("http", `http://127.0.0.1:${values.get("PORT")}`);
      url.searchParams.set("path", path);
      await page.goto(url.href);
      await page.click("#open");
      await page.waitForFunction(
        () => {
          const w = window as unknown as {
            events: { type: string }[];
            rows: { type: string }[];
            audioClosed: unknown;
          };
          return (
            w.audioClosed ||
            (w.events.some((e) => e.type === "take-ready") &&
              w.rows.filter((r) => r.type === "lane-block").length >= 16)
          );
        },
        undefined,
        { timeout: 30000 },
      );
      const state = await page.evaluate(() => {
        const w = window as unknown as {
          track: { state: string; store: { entries(): { frames: number }[] } };
          events: { type: string }[];
          rows: { type: string }[];
          audioClosed: unknown;
        };
        return {
          state: w.track.state,
          takes: w.track.store.entries().map((t) => t.frames),
          types: w.events.map((e) => e.type),
          rows: w.rows,
          closed: w.audioClosed,
        };
      });
      assert.equal(state.state, "open", JSON.stringify({ state, errors }));
      passed++;
      assert.deepEqual(state.takes, [1024]);
      passed++;
      assert.equal(errors.length, 0, JSON.stringify(errors));
      passed++;
      await page.evaluate(() => {
        const w = window as unknown as {
          track: { close(): void };
          context: AudioContext;
        };
        w.track.close();
        void w.context.close();
      });
      await delay(200);
      host.kill("SIGTERM");
      assert.equal(await exited, 0);
      passed++;
      const audio = JSON.parse(
        readFileSync(join(dir, "wt-audio.json"), "utf8"),
      );
      assert.ok(
        audio.reset_open + audio.reset_unacked > 0,
        JSON.stringify(audio),
      );
      passed++;
      assert.ok(audio.reset_unacked > 0, "impaired FIN'd segments must reset");
      passed++;
      const report = {
        path,
        profile: { loss: 0.02, delay_ms: 45, jitter_ms: 10, seed: 37 },
        state,
        errors,
        audio,
        udp: proxy.counts,
      };
      results.push(report);
      writeFileSync(
        join(dir, "result.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch (error) {
      const state = await page
        .evaluate(() => {
          const w = window as unknown as {
            track?: { state: string };
            events?: unknown[];
            rows?: unknown[];
            audioClosed?: unknown;
          };
          return {
            state: w.track?.state,
            events: w.events,
            rows: w.rows,
            closed: w.audioClosed,
          };
        })
        .catch(() => null);
      writeFileSync(
        join(dir, "failure.json"),
        JSON.stringify({ error: String(error), errors, state }, null, 2),
      );
      throw error;
    } finally {
      await page.close();
      if (host.exitCode === null) {
        host.kill("SIGTERM");
        await exited;
      }
      await proxy?.close();
      writeFileSync(join(dir, "host.log"), log);
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify({ passed, failed: 0, legs: results }, null, 2)}\n`,
);
console.log(`${passed} passed, 0 failed, 0 skipped; 2 impaired UDP legs`);
