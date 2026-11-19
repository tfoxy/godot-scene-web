import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export async function serve(port = 0) {
  const page = await readFile(new URL("./page/index.html", import.meta.url));
  const server = createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname !== "/") {
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
  return { server, url: `http://localhost:${server.address().port}/` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--port"))
    throw Error("serve.mjs [--port P]");
  const { url } = await serve(Number(args[1] ?? 8080));
  console.log(url);
}
