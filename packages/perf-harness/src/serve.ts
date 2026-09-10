// Static server + browser bundling.
//
// The page is served over real `http://127.0.0.1:<port>`, never `data:` or `about:blank`: image
// decode, the discardable decode cache and HTTP caching all behave differently for non-http
// documents, and those behaviours are exactly what is being measured.
//
// The browser bundle is built by esbuild with `conditions: ["development"]` so
// `@godot-scene-web/html` resolves to its TypeScript SOURCE. That matters: the arm under test must
// call the shipped `regionBackgroundStyle`, not a stale `dist/` copy that may not even be built.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { HB_GPU_GLUE_FILE, HB_GPU_WASM_FILE } from "./hb-gpu-build";
import { HB_GPU_GLUE_URL, HB_GPU_WASM_URL } from "./scenarios/text-gpu";

const here = dirname(fileURLToPath(import.meta.url));

export interface PerfServer {
  origin: string;
  port: number;
  close(): Promise<void>;
  scenarioUrl(params: Record<string, string | number | boolean>): string;
}

export interface ServeOptions {
  atlasPngPath: string;
  atlasJsonPath: string;
  /** Optional second fixture: one large opaque image served at `/fixture/background.png`. */
  backgroundPngPath?: string;
  backgroundSize?: { width: number; height: number };
  /**
   * Optional third fixture: the benchmark font, served at `/fixture/font.ttf`.
   *
   * Over real `http://` like everything else here, and deliberately NOT inlined as a `data:` URL or
   * a base64 string in the bundle. A scenario that measures glyph rasterisation must let the
   * browser fetch, parse and install the face the way a page really does — and the arms that hand
   * the same bytes to a wasm heap need an `ArrayBuffer` from the network, not one reconstructed
   * from base64 on the main thread inside the measured window.
   */
  fontPath?: string;
  /**
   * The LATIN benchmark font, served at `/fixture/latin.ttf`.
   *
   * A second file rather than a second family inside one: the two faces are subset from different
   * upstreams and instanced at different axes, and every arm — CSS, canvas, two wasm heaps and
   * Godot — has to be handed byte-identical data for its script or the comparison is between fonts
   * rather than between mechanisms.
   */
  latinFontPath?: string;
  host?: string;
  port?: number;
}

/**
 * Where harfbuzzjs's wasm has to be, and why the path is not negotiable.
 *
 * The emscripten glue resolves its payload as `new URL("harfbuzz.wasm", import.meta.url)`. After
 * esbuild inlines the module into one bundle, `import.meta.url` IS the bundle's url — so the fetch
 * lands next to `/bundle.js`, at the root, and no `locateFile` hook can move it: the package's
 * entry point calls the emscripten factory with no arguments at module scope, so there is nowhere
 * to pass one. Exported rather than inlined so the fidelity probe's own server (which serves a
 * different page from a different module) states the same rule by referencing it.
 */
export const HARFBUZZ_WASM_PATH = "/harfbuzz.wasm";

/**
 * The wasm bytes, from the INSTALLED package — never a checked-in copy that could drift from the
 * glue code bundled beside it.
 *
 * Resolved off the package entry point rather than as a subpath, because harfbuzzjs's `exports` map
 * publishes `"."` and nothing else: `import.meta.resolve("harfbuzzjs/dist/harfbuzz.wasm")` is a
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, not a path.
 */
export async function readHarfBuzzWasm(): Promise<Buffer> {
  const entry = fileURLToPath(import.meta.resolve("harfbuzzjs"));
  return readFile(resolve(dirname(entry), "harfbuzz.wasm"));
}

/**
 * hb-gpu's two build outputs, read off disk when `build.sh` has been run and `null` when it has not.
 *
 * NEVER BUNDLED, AND NEVER FATAL. `dist/` is gitignored, so on a fresh checkout these do not exist —
 * and a static (or literal-dynamic) `import` of the glue would make esbuild fail to build the ONE
 * page bundle all nine scenarios share. Serving them instead means the absence costs the hb-gpu arm
 * and nothing else, and `hb-gpu-build.ts` has already dropped that arm from the sweep by the time
 * this runs. Both files or neither: an interrupted emscripten build can leave the glue without the
 * binary, and half a module served is a 404 inside `WebAssembly.instantiate`.
 */
export async function readHbGpuBuild(): Promise<{
  glue: Buffer;
  wasm: Buffer;
} | null> {
  try {
    const [glue, wasm] = await Promise.all([
      readFile(HB_GPU_GLUE_FILE),
      readFile(HB_GPU_WASM_FILE),
    ]);
    return { glue, wasm };
  } catch {
    return null;
  }
}

export async function bundleBrowserEntry(): Promise<string> {
  return bundleBrowserModule(resolve(here, "browser/entry.ts"));
}

/**
 * Bundle one browser-side module to ESM, resolving workspace packages to their TypeScript SOURCE.
 *
 * Shared with the fidelity probe, whose `hb-` arms are a second entry point into the same
 * `src/scenarios/text-hb.ts` the perf bundle uses. Built on demand rather than checked in, so the
 * arm the probe grades for alignment cannot lag the arm the table times.
 */
export async function bundleBrowserModule(entry: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
    conditions: ["development"],
    write: false,
    sourcemap: "inline",
    absWorkingDir: resolve(here, ".."),
    logLevel: "silent",
    // harfbuzzjs's emscripten glue opens with `if (ENVIRONMENT_IS_NODE) { await import("module") }`
    // and `require("fs")` under the same guard. Neither runs in a browser — `ENVIRONMENT_IS_NODE`
    // is false — but esbuild resolves imports statically and refuses to bundle a node builtin for
    // the browser platform. Marking them external leaves the dead branch as an unreachable dynamic
    // import instead of failing the build for every scenario.
    external: ["module", "fs", "path", "url", "crypto"],
  });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }
  return file.text;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>gsw perf-harness</title>
    <style>
      html, body { margin: 0; padding: 0; background: #101014; overflow: hidden; }
      #root { position: absolute; inset: 0; }
      .sprite { will-change: auto; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;

export async function startPerfServer(
  options: ServeOptions,
): Promise<PerfServer> {
  const {
    atlasPngPath,
    atlasJsonPath,
    backgroundPngPath,
    backgroundSize,
    fontPath,
    latinFontPath,
    host = "127.0.0.1",
    port = 0,
  } = options;
  const [
    bundle,
    png,
    rawJson,
    backgroundPng,
    fontBytes,
    latinFontBytes,
    harfbuzzWasm,
  ] = await Promise.all([
    bundleBrowserEntry(),
    readFile(atlasPngPath),
    readFile(atlasJsonPath, "utf8"),
    backgroundPngPath
      ? readFile(backgroundPngPath)
      : Promise.resolve(undefined),
    fontPath ? readFile(fontPath) : Promise.resolve(undefined),
    latinFontPath ? readFile(latinFontPath) : Promise.resolve(undefined),
    // Served unconditionally: it is 420 KB read once at startup, and the alternative is a flag
    // that has to be threaded from a scenario's `mechanism` parameter down into the server, which
    // would make "the hb arms 404 when invoked a particular way" a live failure mode.
    readHarfBuzzWasm(),
  ]);
  // Same rule, one difference: this one may legitimately not exist. `null` here is not an error —
  // the sweep has already dropped the hb-gpu arm — it just means the two routes below are absent,
  // which is what a 404 is for.
  const hbGpu = await readHbGpuBuild();
  // The fixture document the page reads is COMPOSED here rather than served verbatim: the background
  // is a runner-side decision (a scenario declares it), so the generator's own JSON must not have to
  // know about it.
  const json = JSON.stringify({
    ...(JSON.parse(rawJson) as Record<string, unknown>),
    background:
      backgroundPng && backgroundSize
        ? { width: backgroundSize.width, height: backgroundSize.height }
        : null,
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (
      status: number,
      type: string,
      body: string | Buffer,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(200, "text/html; charset=utf-8", INDEX_HTML);
      return;
    }
    if (url.pathname === "/bundle.js") {
      send(200, "text/javascript; charset=utf-8", bundle);
      return;
    }
    if (url.pathname === "/fixture/atlas.json") {
      send(200, "application/json; charset=utf-8", json);
      return;
    }
    if (url.pathname === "/fixture/atlas.png") {
      send(200, "image/png", png);
      return;
    }
    if (url.pathname === "/fixture/background.png" && backgroundPng) {
      send(200, "image/png", backgroundPng);
      return;
    }
    if (url.pathname === "/fixture/font.ttf" && fontBytes) {
      send(200, "font/ttf", fontBytes);
      return;
    }
    if (url.pathname === "/fixture/latin.ttf" && latinFontBytes) {
      send(200, "font/ttf", latinFontBytes);
      return;
    }
    if (url.pathname === HARFBUZZ_WASM_PATH) {
      send(200, "application/wasm", harfbuzzWasm);
      return;
    }
    if (url.pathname === HB_GPU_GLUE_URL && hbGpu) {
      // `text/javascript`, because the page reaches this with a dynamic `import()` and a module
      // served as anything else is a MIME-type refusal rather than a parse error.
      send(200, "text/javascript; charset=utf-8", hbGpu.glue);
      return;
    }
    if (url.pathname === HB_GPU_WASM_URL && hbGpu) {
      send(200, "application/wasm", hbGpu.wasm);
      return;
    }
    send(404, "text/plain; charset=utf-8", "not found");
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => res());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("perf server did not bind a TCP port");
  }
  const origin = `http://${host}:${address.port}`;

  return {
    origin,
    port: address.port,
    async close() {
      const closed = new Promise<void>((res) => server.close(() => res()));
      // `server.close()` stops accepting and then waits for every OPEN connection to end — and on a
      // device run nothing ever ends them. The phone reaches this server through `adb reverse` and
      // Chrome keeps the HTTP connection alive in its socket pool; the harness only closes the TAB,
      // never the browser, so the socket outlives the run and `close()` never calls back. Measured:
      // a device run wrote its trace and screenshot and then hung indefinitely in this line, which
      // looked exactly like a stalled capture and is why two device runs had to be killed.
      // (Desktop never showed it because the launched Chrome is killed first, taking its sockets.)
      server.closeAllConnections();
      await closed;
    },
    scenarioUrl(params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        search.set(key, String(value));
      }
      return `${origin}/?${search.toString()}`;
    },
  };
}
