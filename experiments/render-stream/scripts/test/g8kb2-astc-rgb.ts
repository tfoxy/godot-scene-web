#!/usr/bin/env -S pnpm exec tsx --conditions=development

// G8kb2 check (texture-delivery-design.md "As built (G8kb2)"): for every KTX2 of a gate 8 basis-uastc
// store, GSW's transcoder wasm (family set astc|etc2, the phone's) produces ASTC 4x4, RGB files
// included, and its blocks equal basisu 1.60's own native transcode to ASTC 4x4 byte for byte
// (scripts/test/basis-astc-oracle.cpp: ktx2_transcoder called directly, no GSW wrapper), every level;
// a second set without astc (etc2 only) still gives ETC1 for RGB. The oracle decodes its blocks and
// reports PSNR against the file's UASTC decode and, where the store holds the source pixels
// (.grt payload), against the source.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/g8kb2-astc-rgb.ts --store <capture store dir> --out <json>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { familyBits, TARGET_FORMAT } from "../../web/basis-transcoder/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = resolve(HERE, "../..");
const ROOT = resolve(RS, "../..");

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return resolve(process.argv[i + 1]);
}

const store = arg("--store");
const outJson = arg("--out");
const work = join(ROOT, "artifacts/render-stream/basis-astc-oracle");
mkdirSync(work, { recursive: true });

// The native oracle: basisu's transcoder + zstd, compiled once.
const oracle = join(work, "astc-oracle");
if (!existsSync(oracle)) {
  const B = join(RS, "third_party/basis_universal");
  const Z = join(RS, "capture/vendor/zstd");
  const defs = "-DBASISD_SUPPORT_KTX2=1 -DBASISD_SUPPORT_KTX2_ZSTD=1 -DBASISD_SUPPORT_ATC=0 -DBASISD_SUPPORT_FXT1=0 -DBASISD_SUPPORT_PVRTC1=0 -DBASISD_SUPPORT_PVRTC2=0 -DBASISD_SUPPORT_UASTC_HDR=0 -DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=1 -DZSTD_DISABLE_ASM=1 -DZSTD_MULTITHREAD=0 -DDEBUGLEVEL=0".split(" ");
  const zsrc = [...readdirSync(join(Z, "common")).map((f) => join(Z, "common", f)), ...readdirSync(join(Z, "decompress")).map((f) => join(Z, "decompress", f))].filter((f) => f.endsWith(".c"));
  const objs: string[] = [];
  for (const c of zsrc) {
    const o = join(work, `z_${c.split("/").pop()}.o`);
    execFileSync("gcc", ["-O2", "-w", ...defs, "-I", Z, "-c", c, "-o", o]);
    objs.push(o);
  }
  execFileSync("g++", ["-std=c++17", "-O2", "-w", ...defs, "-I", B, "-I", Z, join(HERE, "basis-astc-oracle.cpp"), join(B, "transcoder/basisu_transcoder.cpp"), ...objs, "-o", oracle], { stdio: "inherit" });
}

// GSW's wasm, instantiated as worker.ts does.
const wasmDir = execFileSync("bash", [join(RS, "scripts/build-basis-transcoder.sh")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop() as string;
const module = new WebAssembly.Module(readFileSync(join(wasmDir, "basis_transcoder.wasm")));
const imp: Record<string, Record<string, () => number>> = {};
for (const i of WebAssembly.Module.imports(module)) (imp[i.module] ??= {})[i.name] = () => 52;
const ex = new WebAssembly.Instance(module, imp as WebAssembly.Imports).exports as unknown as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory; _initialize?: () => void };
ex._initialize?.();
ex.bt_init();
function transcode(bytes: Uint8Array, families: string[]): { format: string; data: Buffer; comps: number } {
  const p = ex.bt_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
  const rc = ex.bt_transcode(p, bytes.length, familyBits(families));
  ex.bt_free(p);
  if (rc !== 0) throw new Error(`bt_transcode failed ${ex.bt_error_code()}`);
  return { format: TARGET_FORMAT[ex.bt_info(3)] ?? String(ex.bt_info(3)), comps: ex.bt_info(4), data: Buffer.from(new Uint8Array(ex.memory.buffer, ex.bt_out_ptr(), ex.bt_out_len())) };
}

const index = readFileSync(join(store, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { hash: string; format: string; width: number; height: number });
const rows: Record<string, unknown>[] = [];
const problems: string[] = [];
for (const f of readdirSync(join(store, "sha256")).filter((n) => n.endsWith(".ktx2")).sort()) {
  const bytes = readFileSync(join(store, "sha256", f));
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const w = dv.getUint32(20, true);
  const h = dv.getUint32(24, true);
  const src = index.find((e) => e.width === w && e.height === h && (e.format === "RGBA8" || e.format === "RGB8") && existsSync(join(store, "sha256", `${e.hash}.grt`)) && (readFileSync(join(store, "sha256", `${e.hash}.grt`)).length - w * h * (e.format === "RGB8" ? 3 : 4)) < 256);
  const srcArgs = src ? [join(store, "sha256", `${src.hash}.grt`), src.format === "RGB8" ? "3" : "4", String(w), String(h)] : [];
  const blocks = join(work, `${f}.astc`);
  const o = JSON.parse(execFileSync(oracle, [join(store, "sha256", f), blocks, ...srcArgs], { encoding: "utf8" })) as Record<string, number>;
  const phone = transcode(bytes, ["etc2", "astc"]);
  const etcOnly = transcode(bytes, ["etc2"]);
  const equal = phone.format === "ASTC_4x4" && Buffer.compare(phone.data, readFileSync(blocks)) === 0;
  if (!equal) problems.push(`${f.slice(0, 12)} ${w}x${h}: wasm ${phone.format} blocks differ from basisu's native ASTC`);
  if (etcOnly.comps === 3 && etcOnly.format !== "ETC2_RGB8") problems.push(`${f.slice(0, 12)}: etc2-only RGB is ${etcOnly.format}, not ETC1`);
  rows.push({ file: f, width: w, height: h, components: phone.comps, phone_target: phone.format, etc2_only_target: etcOnly.format, astc_equals_native: equal, source: src ? `${src.format} ${src.hash.slice(0, 12)}` : null, ...o });
}
if (rows.filter((r) => r.components === 3).length < 2) problems.push("fewer than 2 RGB files in the store");
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, `${JSON.stringify({ schema: "g8kb2-astc-rgb/1", ok: problems.length === 0, problems, rows }, null, 2)}\n`);
for (const r of rows) console.log(JSON.stringify(r));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`g8kb2-astc-rgb: ${rows.length} files, ASTC blocks equal basisu native on all`);
