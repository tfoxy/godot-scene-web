import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const defaultPage = new URL(
  "../../../.local/rtc-page/index.html",
  import.meta.url,
);

// Build once before serving. The artifact is also a single-file page for manual secure-origin legs.
export async function buildPage(output = defaultPage) {
  const { outputFiles, metafile } = await build({
    entryPoints: [fileURLToPath(new URL("./page/main.js", import.meta.url))],
    alias: {
      "@godot-scene-web/direct-peer": fileURLToPath(
        new URL("../../../packages/direct-peer/src/index.ts", import.meta.url),
      ),
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    charset: "utf8",
  });
  const template = await readFile(
    new URL("./page/index.html", import.meta.url),
    "utf8",
  );
  const script = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const page = template.replace(
    "<!-- RTC_SCRIPT -->",
    () => `<script>\n${script}</script>`,
  );
  const path = output instanceof URL ? fileURLToPath(output) : output;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, page);
  return { path, inputs: Object.keys(metafile.inputs) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw Error("build-page.mjs [output.html]");
  console.log((await buildPage(process.argv[2])).path);
}
