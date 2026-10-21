// GRT2b: lib/gate7-web-legs.ts's sharding helpers -- RS_LEG_SHARDS parsing and the warm-cache
// ordering rule -- with no browser.
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-web-legs-shards.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependsOnEarlier, legShards } from "../lib/gate7-web-legs";

let fails = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fails++;
};

check("unset is serial", legShards({}) === 1);
check("off is serial", legShards({ RS_LEG_SHARDS: "off" }) === 1);
check("0 is serial", legShards({ RS_LEG_SHARDS: "0" }) === 1);
check("on is 2", legShards({ RS_LEG_SHARDS: "on" }) === 2);
check("3 is 3", legShards({ RS_LEG_SHARDS: "3" }) === 3);
let threw = false;
try {
  legShards({ RS_LEG_SHARDS: "two" });
} catch {
  threw = true;
}
check("a bad value is refused", threw);

const root = mkdtempSync(join(tmpdir(), "grt2b-web-legs-"));
try {
  const leg = (name: string, env: string[]) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "env.txt"), `# unset: ...\n${env.join("\n")}\n`);
    return { nativeDir: dir };
  };
  check(
    "a cold leg with its own cache is independent",
    !dependsOnEarlier(
      leg("receiver-cold", [
        `RS_RECEIVER_CACHE_DIR=${join(root, "receiver-cold", "cache")}`,
      ]),
    ),
  );
  check(
    "a warm leg waits for earlier legs",
    dependsOnEarlier(
      leg("receiver-warm", [
        `RS_RECEIVER_CACHE_DIR=${join(root, "receiver-cold", "cache")}`,
        "RS_RECEIVER_CACHE_MODE=warm",
      ]),
    ),
  );
  check(
    "another leg's cache dir alone is a dependency",
    dependsOnEarlier(
      leg("reuse", [
        `RS_RECEIVER_CACHE_DIR=${join(root, "receiver-cold", "cache")}`,
      ]),
    ),
  );
  check(
    "a leg with no env.txt is independent",
    !dependsOnEarlier({ nativeDir: join(root, "none") }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  fails === 0
    ? "self-test-web-legs-shards: PASS"
    : `self-test-web-legs-shards: FAIL (${fails})`,
);
process.exit(fails === 0 ? 0 : 1);
