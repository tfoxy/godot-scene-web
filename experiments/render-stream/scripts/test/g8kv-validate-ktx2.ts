// G8kv: the render-stream/9 TS KTX2 validator (decodeKtx2Payload + checkKtx2Shape) over the files
// rs_basis_encode_test --emit wrote. Not a pure self-test (it needs that directory), so it is not
// named self-test-*.ts; scripts/test/g8kv-roundtrip.sh runs it.
//
//   tsx --conditions=development g8kv-validate-ktx2.ts <emit-dir>
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { checkKtx2Shape, decodeKtx2Payload } from "../lib/render-stream-2.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: g8kv-validate-ktx2.ts <emit-dir>");
const manifest = (await readFile(join(dir, "manifest.tsv"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => l.split("\t"));
let bad = 0;
for (const [name, w, h, levels] of manifest) {
  const bytes = new Uint8Array(await readFile(join(dir, `${name}.ktx2`)));
  try {
    const d = decodeKtx2Payload(bytes);
    // A mip chain is the full chain, or one level: the same two shapes the wire entry can name.
    const full = Number(levels) > 1;
    const shape = checkKtx2Shape(d, "uastc", Number(w), Number(h), full);
    if (shape !== null) throw new Error(shape);
    console.log(`ok   ${name}: ${d.width}x${d.height} ${d.levels} levels ${d.model} sc=${d.supercompression}`);
  } catch (e) {
    bad++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}
process.exit(bad === 0 ? 0 : 1);
