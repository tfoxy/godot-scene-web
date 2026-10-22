// RS_SELF_TEST_SHARD=i/n (1 <= i <= n): a heavy self-test (gate 1, gate 2) runs only every n-th of its
// independent scenarios, round-robin by call order, so the remote workflow can spread one 10-minute
// test over several jobs (run-pure-self-tests.sh RS_PURE_SHARD, pure-shard-weights.json "parts").
// Unset or empty means every scenario, exactly as before. The fixed, one-off assertions run in shard 1.
const spec = (process.env.RS_SELF_TEST_SHARD ?? "").trim();
let index = 1;
let count = 1;
if (spec !== "") {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    throw new Error(
      `RS_SELF_TEST_SHARD=${spec}: expected i/n with 1 <= i <= n`,
    );
  }
  index = Number(m[1]);
  count = Number(m[2]);
}

/** Does this shard run the scenario at position `position` (0-based, in call order)? */
export function inShard(position: number): boolean {
  return position % count === index - 1;
}

/** Fixed assertions outside the scenario list run once across the shards, in shard 1. */
export const isFirstShard = index === 1;
export const shardCount = count;
