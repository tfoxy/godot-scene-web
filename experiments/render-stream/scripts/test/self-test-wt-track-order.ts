import assert from "node:assert/strict";
import { trackPayloadsMatch } from "../lib/wt-track-order";

const matches = (actual: string[]) =>
  trackPayloadsMatch(actual, ["l0", "l1"], [["u0", "u1"], ["u2"]]);
assert(matches(["u0", "l0", "u1", "l1", "u2"]), "cross-stream interleaving");
assert(!matches(["l1", "l0", "u0", "u1", "u2"]), "live reordering");
assert(!matches(["l0", "u1", "l1", "u0", "u2"]), "within-batch reordering");
assert(!matches(["l0", "u2", "l1", "u0", "u1"]), "batch reordering");
assert(!matches(["l0", "u0", "l1", "u1"]), "missing payload");
assert(!matches(["l0", "u0", "l1", "u1", "u1"]), "duplicate payload");
assert(!matches(["l0", "u0", "l1", "u1", "other"]), "unexpected payload");
console.log("self-test-wt-track-order: 7 passed, 0 failed");
