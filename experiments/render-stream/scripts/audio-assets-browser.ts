// Correctness leg for the production Godot source; run via run-audio-assets.sh.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchHarnessBrowser } from "./lib/browser-harness";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[process.argv.indexOf("--out") + 1]);
const evidence = join(out, "host/evidence");
const bundle = join(out, "bundle");
mkdirSync(bundle, { recursive: true });
await build({
  entryPoints: [join(root, "packages/render-stream-client/src/audio.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(bundle, "audio.js"),
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/audio.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/audio.js"
      ? readFileSync(join(bundle, "audio.js"))
      : '<button id="open">Open</button>',
  );
});
await new Promise<void>((r) =>
  server.listen(
    Number(process.argv[process.argv.indexOf("--port") + 1]),
    "127.0.0.1",
    r,
  ),
);
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 400; ++i) {
    if (test()) return;
    await delay(25);
  }
  throw Error(`timeout: ${label}`);
}
await until(() => existsSync(join(evidence, "live.json")), "listener");
const live = JSON.parse(readFileSync(join(evidence, "live.json"), "utf8"));
const base = `http://127.0.0.1:${live.port}`;
const token = readFileSync(join(evidence, "live-token"), "utf8").trim();
const credential = readFileSync(
  join(evidence, "live-track-audio-token"),
  "utf8",
).trim();
const { browser } = await launchHarnessBrowser();
const page = await browser.newPage();
// tsx preserves names with a helper when serializing nested browser callbacks.
await page.addInitScript("globalThis.__name = (fn) => fn");
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
try {
  await page.goto(origin);
  await page.evaluate(
    async ({ base, token, credential }) => {
      const { openAudioTrack } = await import(
        /* @vite-ignore */ `${location.origin}/audio.js`
      );
      const w = window as unknown as {
        events: Record<string, unknown>[];
        stages: Record<string, unknown>[];
        fetches: Record<string, unknown>[];
        track: { state: string };
        ctx: AudioContext;
      };
      w.events = [];
      w.stages = [];
      w.fetches = [];
      document.querySelector("#open")!.addEventListener("click", () => {
        w.ctx = new AudioContext();
        w.track = openAudioTrack({
          url: `${base.replace("http:", "ws:")}/render-stream`,
          credential,
          context: w.ctx,
          path: "main",
          codecs: ["wav"],
          reconnect: false,
          fetchAsset: async (
            hash: string,
            options: { cache: RequestCache },
          ) => {
            const response = await fetch(`${base}/resources/sha256/${hash}`, {
              cache: options.cache,
              headers: { Authorization: `Bearer ${token}` },
            });
            const bytes = await response.arrayBuffer();
            w.fetches.push({
              hash,
              status: response.status,
              cache: response.headers.get("cache-control"),
              bytes: bytes.byteLength,
            });
            if (!response.ok) throw Error(`asset ${response.status}`);
            return bytes;
          },
          onEvent: (m: Record<string, unknown>) => w.events.push(m),
          onStage: (m: Record<string, unknown>) => w.stages.push(m),
        });
      });
    },
    { base, token, credential },
  );
  await page.click("#open");
  await page.waitForFunction("window.track?.state === 'open'", undefined, {
    timeout: 10000,
  });
  writeFileSync(join(out, "control/start"), "");
  await until(
    () => existsSync(join(evidence, "audio-fixture.json")),
    "fixture completion",
  );
  await page.waitForFunction(
    "window.stages.filter(m=>m.type==='sample-stop').length===7",
    undefined,
    { timeout: 10000 },
  );
  const result = await page.evaluate(() => {
    const w = window as unknown as {
      events: {
        type: string;
        voice: number;
        variants?: { hash: string; codec: string }[];
      }[];
      stages: { type: string }[];
      fetches: { hash: string; status: number; bytes: number; cache: string }[];
    };
    return { events: w.events, stages: w.stages, fetches: w.fetches };
  });
  writeFileSync(join(out, "client.json"), JSON.stringify(result, null, 2));
  const starts = result.events
    .filter((m) => m.type === "start")
    .map((m) => m.voice)
    .sort();
  const stops = result.events
    .filter((m) => m.type === "stop")
    .map((m) => m.voice)
    .sort();
  assert.equal(starts.length, 7);
  assert.deepEqual(starts, stops);
  assert.equal(new Set(stops).size, 7);
  assert.equal(
    result.stages.filter((m) => m.type === "sample-start").length,
    7,
  );
  assert.equal(result.fetches.length, 7);
  assert.ok(result.fetches.every((m) => m.status === 200 && m.bytes > 44));
  const registrations = result.events.filter((m) => m.type === "sample");
  assert.equal(result.fetches[0].cache, "no-store", "private bus asset");
  const hash = result.fetches[0].hash;
  const url = `${base}/resources/sha256/${hash}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (
      await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "http://foreign.invalid",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(url, { headers: { Authorization: `Bearer ${credential}` } }))
      .status,
    401,
  );
  const fetched = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(fetched.status, 200);
  const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
  assert.equal(createHash("sha256").update(fetchedBytes).digest("hex"), hash);
  const loopHash = result.fetches.at(-1)!.hash;
  assert.equal(result.fetches.at(-1)!.cache, "no-store");
  const noStore = await fetch(`${base}/resources/sha256/${loopHash}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "If-None-Match": `"${loopHash}"`,
    },
  });
  assert.equal(noStore.status, 200);
  assert.equal(noStore.headers.get("cache-control"), "no-store");
  const noStoreBytes = (await noStore.arrayBuffer()).byteLength;
  const immutable = result.fetches.find((f) => f.cache.includes("immutable"));
  assert.ok(immutable, "short one-shot has an immutable variant");
  const revalidated = await fetch(
    `${base}/resources/sha256/${immutable.hash}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "If-None-Match": `"${immutable.hash}"`,
      },
    },
  );
  assert.equal(revalidated.status, 304);
  // Only successful bodies count. Authentication/origin failures and 304s above
  // must not inflate the per-asset evidence, including shared codec hashes.
  const expected = new Map<string, { hits: number; bytes: number }>();
  for (const f of [
    ...result.fetches,
    { hash, bytes: fetchedBytes.byteLength },
    { hash: loopHash, bytes: noStoreBytes },
  ]) {
    const total = expected.get(f.hash) ?? { hits: 0, bytes: 0 };
    total.hits++;
    total.bytes += f.bytes;
    expected.set(f.hash, total);
  }
  interface AudioEvidence {
    godot: {
      state: string;
      registered_samples: number;
      live_voices: number;
      variants_ready: number;
      samples_full: number;
      voices_full: number;
      pending_ends_full: number;
      pending_updates_full: number;
    };
    assets: { hash: string; codec: string; hits: number; bytes: number }[];
  }
  let accounting: AudioEvidence | undefined;
  await until(() => {
    accounting = JSON.parse(
      readFileSync(join(evidence, "live-audio.json"), "utf8"),
    ) as AudioEvidence;
    return (
      accounting.godot.live_voices === 0 &&
      accounting.assets.length === expected.size &&
      accounting.assets.every((a) => {
        const e = expected.get(a.hash);
        return (
          e !== undefined &&
          a.codec === "wav" &&
          a.hits === e.hits &&
          a.bytes === e.bytes
        );
      })
    );
  }, "exact per-asset hit and byte accounting");
  assert.deepEqual(accounting!.godot, {
    state: "sample",
    unsampled: null,
    unsampled_reason: "not-observable-at-seam",
    registered_samples: 7,
    live_voices: 0,
    variants_ready: 10,
    samples_full: 0,
    voices_full: 0,
    pending_ends_full: 0,
    pending_updates_full: 0,
  });
  writeFileSync(
    join(out, "accounting.json"),
    JSON.stringify(accounting, null, 2),
  );
  assert.ok(registrations.some((m) => m.variants?.[0].codec === "ogg-vorbis"));
  assert.deepEqual(errors, []);
  console.log(
    "audio-assets browser: 7 starts/7 stops, 7 decoded stereo assets, auth, store classes and exact asset accounting passed; 0 failed/skipped",
  );
} finally {
  await page
    .evaluate(() => {
      const w = window as unknown as {
        events: unknown;
        stages: unknown;
        fetches: unknown;
        track?: { state: string };
      };
      return {
        events: w.events,
        stages: w.stages,
        fetches: w.fetches,
        state: w.track?.state,
      };
    })
    .then((data) =>
      writeFileSync(
        join(out, "debug.json"),
        JSON.stringify({ ...data, errors }, null, 2),
      ),
    )
    .catch(() => {});
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
