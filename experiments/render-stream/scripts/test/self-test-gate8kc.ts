#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8kc checks (lib/gate8-cache-checks.ts, G8kc): a fabricated evidence tree
// (no recordings) on which the cache checks pass, then one mutation per check that must fail it:
//
// 1. foldIndex: the last row per key wins and a `del` row removes it.
// 2. cache-cold / cache-warm / prepare-key-match / cache-corrupt / cache-lru / cache-paths pass on
//    the honest tree.
// 3. A warm session that derives, a warm hash that differs from the oracle's, a prepared session
//    that misses, a corrupt file that is not counted (or a damaged hash that is served), an
//    unbounded cache and a texture the hook never named each fail their check.
// 4. cache-off-identical fails when the uncached capture shows the hook, and (here, with no
//    recordings) names the missing recording.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8kc.ts

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DECODE_PARAMS_ID,
  foldIndex,
  runG8kc,
} from "../lib/gate8-cache-checks";

let failures = 0;
function expect(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const H = (c: string) => c.repeat(64);
const NAMES = ["opaque", "alpha", "hq"];
const FAMILIES = ["desktop", "mobile"];
const path = (name: string, family: string) =>
  `res://.godot/imported/${name}.png-x.${family === "desktop" ? "s3tc" : "etc2"}.ctex`;
const lines: { name: string; family: string }[] = [];
for (const f of FAMILIES)
  for (const n of NAMES) lines.push({ name: n, family: f });
const srcKey = (i: number) =>
  (0x10 + i).toString(16).padStart(2, "0").repeat(32);
const decKey = (i: number) =>
  (0x40 + i).toString(16).padStart(2, "0").repeat(32);

function write(root: string, rel: string, content: unknown): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    typeof content === "string"
      ? content
      : `${JSON.stringify(content, null, 1)}\n`,
  );
}

const stats = (o: Partial<Record<string, number>>) => ({
  max_bytes: 0,
  hits: 0,
  misses: 0,
  corrupt: 0,
  puts: 0,
  evicted: 0,
  bytes_hit: 0,
  bytes_put: 0,
  entries: lines.length,
  files: lines.length,
  bytes: 600,
  derivations: 0,
  encodes: 0,
  ...o,
});

function textures(outcome: (i: number) => string) {
  return lines.map((l, i) => ({
    id: String(100 + i),
    path: path(l.name, l.family),
    source_key: srcKey(i),
    outcome: outcome(i),
    status: "ok",
    hash: decKey(i),
  }));
}

function indexText(skip: number[] = []): string {
  return (
    lines
      .map((_, i) => ({
        v: 1,
        source: srcKey(i),
        encoding: "decoded",
        params: DECODE_PARAMS_ID,
        hash: decKey(i),
        bytes: 100,
        ext: "grt",
        use: i + 1,
      }))
      .filter((_, i) => !skip.includes(i))
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );
}

function capture(
  root: string,
  leg: string,
  o: {
    cache?: boolean;
    stats?: Partial<Record<string, number>>;
    outcome?: (i: number) => string;
    hash?: (i: number) => string;
    planned?: number;
  },
) {
  write(root, `g8kc/${leg}/exit-code.txt`, "0\n");
  write(
    root,
    `g8kc/${leg}/textures.jsonl`,
    lines
      .map((l) => JSON.stringify({ ...l, path: path(l.name, l.family) }))
      .join("\n") + "\n",
  );
  const planned = Array.from(
    { length: o.planned ?? (o.cache ? 80 : 79) },
    (_, i) => `hook${i}`,
  );
  if (o.cache) planned[planned.length - 1] = "texture_set_path";
  const counts: Record<string, number> = {};
  for (const p of planned) counts[p] = 1;
  const captured = o.cache
    ? {
        texture_set_path: lines.map((l, i) => ({
          texture: String(100 + i),
          path: path(l.name, l.family),
        })),
      }
    : {};
  write(root, `g8kc/${leg}/evidence/counters.json`, {
    hooks_planned: planned,
    counts,
    captured,
  });
  write(
    root,
    `g8kc/${leg}/evidence/result.json`,
    o.cache ? { texture_cache: stats(o.stats ?? {}) } : {},
  );
  if (o.cache) {
    const tx = textures(o.outcome ?? (() => "hit")).map((t, i) => ({
      ...t,
      hash: o.hash ? o.hash(i) : t.hash,
    }));
    write(root, `g8kc/${leg}/evidence/texture-cache.json`, {
      schema: "render-stream-texture-cache/1",
      path_hook: true,
      textures: tx,
    });
  }
}

function tree(mutate?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "self-test-gate8kc-"));
  write(root, "import/fixture/exit-code.txt", "0\n");
  write(root, "oracle/exit-code.txt", "0\n");
  write(root, "oracle/oracle.json", {
    schema: "x",
    timing: false,
    repeats: 1,
    textures: lines.map((l, i) => ({
      ...l,
      key: "k",
      path: path(l.name, l.family),
      payload_sha256: decKey(i),
      block_payload_sha256: srcKey(i),
    })),
  });
  const n = lines.length;
  capture(root, "off/capture", {});
  capture(root, "cold/capture", {
    cache: true,
    outcome: () => "miss",
    stats: { misses: n, puts: n, derivations: n, bytes_put: 600 },
  });
  write(root, "g8kc/cold/cache/index-v1.jsonl", indexText());
  capture(root, "warm/capture", { cache: true, stats: { hits: n } });
  write(root, "g8kc/warm/cache/index-v1.jsonl", indexText());
  capture(root, "warm-workers/capture", { cache: true, stats: { hits: n } });
  // prepare
  write(root, "g8kc/prepare/exit-code.txt", "0\n");
  write(root, "g8kc/prepare/out/evidence/texture-cache.json", {
    schema: "x",
    path_hook: true,
    textures: textures(() => "miss").map((t) => ({
      ...t,
      path: `/abs/.godot/imported/${t.path?.split("/").pop()}`,
    })),
  });
  write(root, "g8kc/prepare/out/evidence/result.json", {
    texture_cache: stats({ misses: n, puts: n, derivations: n }),
  });
  write(root, "g8kc/prepare/cache/index-v1.jsonl", indexText());
  capture(root, "prepared/capture", { cache: true, stats: { hits: n } });
  // bounded
  capture(root, "bounded/capture", {
    cache: true,
    outcome: () => "miss",
    stats: {
      max_bytes: 300,
      misses: n,
      puts: n,
      derivations: n,
      evicted: 3,
      entries: 3,
      files: 3,
      bytes: 300,
    },
  });
  write(root, "g8kc/bounded/cache/index-v1.jsonl", indexText([0, 1, 2]));
  write(root, "g8kc/bounded/cache/files.txt", "a\nb\nc\n");
  // corrupt: files for keys 0 (flipped), 1 (truncated), 2 (deleted); one key per file
  write(root, "g8kc/sabotage-corrupt/damaged.json", {
    flipped: decKey(0),
    truncated: decKey(1),
    deleted: decKey(2),
  });
  write(root, "g8kc/sabotage-corrupt/index-before.jsonl", indexText());
  capture(root, "sabotage-corrupt/capture", {
    cache: true,
    outcome: (i) => (i < 2 ? "corrupt" : i === 2 ? "miss" : "hit"),
    stats: { hits: n - 3, misses: 1, corrupt: 2, puts: 3, derivations: 3 },
  });
  write(root, "g8kc/sabotage-corrupt/cache/index-v1.jsonl", indexText());
  capture(root, "sabotage-corrupt/after/capture", {
    cache: true,
    stats: { hits: n },
  });
  mutate?.(root);
  return root;
}

async function verdicts(
  root: string,
): Promise<Record<string, { passed: boolean; detail?: string }>> {
  const r = await runG8kc(root);
  return Object.fromEntries(r.checks.map((c) => [c.id, c]));
}

// 1. foldIndex
{
  const m = foldIndex(
    [
      JSON.stringify({
        source: "a",
        encoding: "decoded",
        params: "p",
        hash: "h1",
      }),
      JSON.stringify({
        source: "a",
        encoding: "decoded",
        params: "p",
        hash: "h2",
      }),
      JSON.stringify({
        source: "b",
        encoding: "decoded",
        params: "p",
        hash: "h3",
      }),
      JSON.stringify({ source: "b", encoding: "decoded", params: "p", del: 1 }),
      "not json",
    ].join("\n"),
  );
  expect(
    m.size === 1 && m.get("a decoded p")?.hash === "h2",
    "foldIndex: last row wins, del removes, junk is skipped",
  );
}

const ONLY = [
  "cache-paths",
  "cache-cold",
  "cache-warm",
  "prepare-key-match",
  "cache-corrupt",
  "cache-lru",
];
const roots: string[] = [];
async function run(
  label: string,
  mutate: ((root: string) => void) | undefined,
  failing: string[],
) {
  const root = tree(mutate);
  roots.push(root);
  const v = await verdicts(root);
  for (const id of ONLY) {
    const want = !failing.includes(id);
    expect(
      v[id]?.passed === want,
      `${label}: ${id} ${want ? "passes" : "fails"} (${v[id]?.detail})`,
    );
  }
  return v;
}

await run("honest", undefined, []);
await run(
  "warm session derived",
  (r) =>
    capture(r, "warm/capture", {
      cache: true,
      stats: { hits: lines.length - 1, misses: 1, puts: 1, derivations: 1 },
      outcome: (i) => (i === 0 ? "miss" : "hit"),
    }),
  ["cache-warm"],
);
await run(
  "warm hash differs from the oracle",
  (r) =>
    capture(r, "warm-workers/capture", {
      cache: true,
      stats: { hits: lines.length },
      hash: (i) => (i === 3 ? H("9") : decKey(i)),
    }),
  ["cache-warm"],
);
await run(
  "prepared session missed",
  (r) =>
    capture(r, "prepared/capture", {
      cache: true,
      stats: { hits: lines.length - 2, misses: 2, puts: 2, derivations: 2 },
      outcome: (i) => (i < 2 ? "miss" : "hit"),
    }),
  ["prepare-key-match"],
);
await run(
  "corrupt not counted",
  (r) =>
    capture(r, "sabotage-corrupt/capture", {
      cache: true,
      outcome: (i) => (i === 2 ? "miss" : "hit"),
      stats: {
        hits: lines.length - 3,
        misses: 1,
        corrupt: 0,
        puts: 3,
        derivations: 3,
      },
    }),
  ["cache-corrupt"],
);
await run(
  "a damaged payload served",
  (r) =>
    capture(r, "sabotage-corrupt/capture", {
      cache: true,
      outcome: (i) => (i < 2 ? "corrupt" : i === 2 ? "miss" : "hit"),
      stats: {
        hits: lines.length - 3,
        misses: 1,
        corrupt: 2,
        puts: 3,
        derivations: 3,
      },
      hash: (i) => (i === 0 ? H("e") : decKey(i)),
    }),
  ["cache-corrupt"],
);
await run(
  "the repair left damage",
  (r) =>
    capture(r, "sabotage-corrupt/after/capture", {
      cache: true,
      stats: { hits: lines.length - 1, corrupt: 1 },
    }),
  ["cache-corrupt"],
);
await run(
  "unbounded",
  (r) =>
    capture(r, "bounded/capture", {
      cache: true,
      outcome: () => "miss",
      stats: {
        max_bytes: 300,
        misses: lines.length,
        puts: lines.length,
        derivations: lines.length,
        evicted: 0,
        bytes: 600,
      },
    }),
  ["cache-lru"],
);
await run(
  "a derivation went into the cold index under another hash",
  (r) =>
    write(
      r,
      "g8kc/cold/cache/index-v1.jsonl",
      indexText().replace(decKey(0), H("f")),
    ),
  ["cache-cold", "cache-warm", "prepare-key-match"],
);
await run(
  "the hook never named a texture",
  (r) => {
    capture(r, "cold/capture", {
      cache: true,
      outcome: () => "miss",
      stats: {
        misses: lines.length,
        puts: lines.length,
        derivations: lines.length,
      },
    });
    write(r, "g8kc/cold/evidence-unused.txt", "x");
    const c = JSON.parse(
      readFileSync(join(r, "g8kc/cold/capture/evidence/counters.json"), "utf8"),
    );
    c.captured.texture_set_path = c.captured.texture_set_path.slice(1);
    write(r, "g8kc/cold/capture/evidence/counters.json", c);
  },
  ["cache-paths"],
);
{
  const root = tree((r) => capture(r, "off/capture", { planned: 80 }));
  roots.push(root);
  const v = await verdicts(root);
  expect(
    v["cache-off-identical"]?.passed === false &&
      /80 hooks planned|79/.test(v["cache-off-identical"]?.detail ?? ""),
    `cache-off-identical fails when the uncached capture plans 80 hooks (${v["cache-off-identical"]?.detail})`,
  );
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
if (failures > 0) {
  console.error(`self-test-gate8kc: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate8kc: ok");
