import assert from "node:assert/strict";
import fs from "node:fs";
import { listPck, pckEntryBytes } from "../scripts/lib/godot-pck.ts";

const bytes = fs.readFileSync(process.argv[2]);
const listing = listPck(bytes);
for (const entry of listing.files) {
  assert(!/\.(so|dll|dylib|wasm|gdextension)$/i.test(entry.path), entry.path);
  const magic = Buffer.from(
    pckEntryBytes(bytes, listing, entry).subarray(0, 4),
  );
  assert(!["7f454c46", "0061736d"].includes(magic.toString("hex")), entry.path);
  assert(!magic.subarray(0, 2).equals(Buffer.from("MZ")), entry.path);
}
assert(listing.files.some((entry) => entry.path === "demo/entry.tscn.remap"));
assert(listing.files.some((entry) => entry.path === "demo/recording.rs8"));
assert(
  listing.files.some((entry) => entry.path === "demo/receiver/receiver.gd"),
);
console.log(JSON.stringify(listing, null, 2));
