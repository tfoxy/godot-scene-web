import assert from "node:assert/strict";
import fs from "node:fs";
import { listPck, pckEntryBytes } from "../scripts/lib/godot-pck.ts";

const bytes = fs.readFileSync(process.argv[2]);
const listing = listPck(bytes);
const files = new Map(listing.files.map((entry) => [entry.path, entry]));
for (const path of [
  "project.binary",
  "shell.gd",
  "ext/rs_core.gdextension",
  ".godot/extension_list.cfg",
]) {
  assert(files.has(path), `missing shell resource: ${path}`);
}
const descriptor = Buffer.from(
  pckEntryBytes(bytes, listing, files.get("ext/rs_core.gdextension")),
).toString("utf8");
assert.match(
  descriptor,
  /^windows\.x86_64\s*=\s*"build\/windows\/x86_64\/rs_core_ext\.dll"$/m,
);
assert(!/^(linux|android|web)\./m.test(descriptor), descriptor);
const extensionList = Buffer.from(
  pckEntryBytes(bytes, listing, files.get(".godot/extension_list.cfg")),
).toString("utf8");
assert(extensionList.includes("res://ext/rs_core.gdextension"), extensionList);
assert(!listing.files.some((entry) => /\.(dll|so|wasm)$/i.test(entry.path)));
assert(!listing.files.some((entry) => entry.path.startsWith("demo/")));
console.log(JSON.stringify(listing, null, 2));
