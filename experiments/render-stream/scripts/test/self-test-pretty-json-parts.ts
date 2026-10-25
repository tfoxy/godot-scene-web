#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Pure self-test for P3-HX: the GSW receiver's `prettyJsonParts` (evidence.ts) concatenates to
// exactly `JSON.stringify(value, null, 2)`, so splitting applied.json into pieces and PUTting it in
// parts leaves every byte the checkers read unchanged. Also: `put` of a string list larger than a
// part is sent as ordered `?part=k&of=n` PUTs whose concatenation is the original bytes.

import { prettyJsonParts, put } from "../../web/gsw-receiver/evidence";
import type { ReceiverConfig } from "../../web/gsw-receiver/config";

let failed = 0;
const check = (id: string, ok: boolean, detail = ""): void => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` -- ${detail}` : ""}`);
};

const tx = (i: number) => ({
  seq: i,
  note: `café "q" \\ \n\t  ${i}`,
  list: i % 3 === 0 ? [] : Array.from({ length: i % 7 }, (_, k) => k * 1.5),
  nested: { a: null, b: [1, { c: [] }], u: undefined, f: () => 1 },
  empty: {},
  resources: i % 2 ? null : { n: i, arr: [[], [1], [[2, 3]]] },
});
const doc = {
  schema: "x/7",
  empty_arr: [],
  empty_obj: {},
  transactions: Array.from({ length: 300 }, (_, i) => tx(i)),
  holes: [1, undefined, () => 2, Symbol("s"), 4],
  more: { deep: { transactions: Array.from({ length: 70 }, (_, i) => tx(i)) } },
  last: "end",
};
for (const min of [1, 2, 3, 64, 1000]) {
  const want = JSON.stringify(doc, null, 2);
  const got = prettyJsonParts(doc, min).join("");
  check(
    `pretty-json-parts-equal-min${min}`,
    got === want,
    `${got.length} chars`,
  );
}
for (const v of [null, 0, "s", [], {}, [[]], { a: [] }, [1, 2, 3]]) {
  check(
    `pretty-json-parts-scalar-${JSON.stringify(v)}`,
    prettyJsonParts(v, 1).join("") === JSON.stringify(v, null, 2),
  );
}
check("pretty-json-parts-splits", prettyJsonParts(doc).length > 300);

// put(): parts and ordering.
const calls: Array<{ url: string; bytes: Uint8Array }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: { body: Blob | string }) => {
  const b = init.body;
  const bytes =
    typeof b === "string"
      ? new TextEncoder().encode(b)
      : new Uint8Array(await (b as Blob).arrayBuffer());
  calls.push({ url: String(url), bytes });
  return { ok: true, status: 200 } as Response;
}) as typeof fetch;
const cfg = { evidenceUrl: "http://h/evidence/n" } as unknown as ReceiverConfig;
const big = "😀".repeat(5_000_000) + "tail"; // 20 MB of UTF-8, surrogate pairs
await put(cfg, "a.json", [big, "\n"]);
const joined = Buffer.concat(calls.map((c) => c.bytes));
check(
  "put-parts-bytes-equal",
  calls.length > 1 && joined.equals(Buffer.from(`${big}\n`)),
  `${calls.length} parts`,
);
check(
  "put-parts-urls",
  calls.every(
    (c, k) =>
      c.url === `http://h/evidence/n/a.json?part=${k}&of=${calls.length}`,
  ),
);
calls.length = 0;
await put(cfg, "small.json", "{}");
check(
  "put-small-is-one-plain-put",
  calls.length === 1 && calls[0].url === "http://h/evidence/n/small.json",
);
globalThis.fetch = realFetch;
process.exit(failed === 0 ? 0 : 1);
