import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Run `node experiments/render-stream/rtc/build-page.mjs` first; runtime uses only Node builtins.
export async function serve(
  port = 0,
  pagePath = new URL("../../../.local/rtc-page/index.html", import.meta.url),
) {
  const page = await readFile(pagePath);
  const serviceWorker = await readFile(
    new URL("./page/worker-sw.js", import.meta.url),
  );
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/rtc-worker-sw.js") {
      res
        .writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(serviceWorker);
      return;
    }
    if (path !== "/") {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(page);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--port"))
    throw Error("serve.mjs [--port P]");
  const { url } = await serve(Number(args[1] ?? 8080));
  console.log(url);
}
