// What the GSW receiver's live mode (live.ts) does with each record `live_accept` accepted, by its
// `ACCEPT_*` code. Only a transaction gets a log entry, a `received` ack, a needed set and, at
// credit window 2, a fold into the pending transaction. Every other record is answered here, and a
// code this table does not know is an error rather than a transaction: a record that falls
// through to the transaction path replaces the pending transaction's needed set with its own empty
// one, so the transaction applies without the payloads it named. Kept apart from common.ts, which
// touches `window` at load, so a Node self-test can import it
// (scripts/test/self-test-gsw-live-records.ts).

import {
  ACCEPT_END,
  ACCEPT_HELD,
  ACCEPT_ITEM_META,
  ACCEPT_NEEDS_PAYLOADS,
  ACCEPT_RESOURCE,
  ACCEPT_RESOURCE_HINT,
  ACCEPT_RESOURCE_UNHINT,
  ACCEPT_TRANSACTION,
} from "../../../../packages/render-stream-client/src/abi";

export type LiveRecordKind =
  /** Applied, acked and folded like any transaction (`ACCEPT_TRANSACTION`, `ACCEPT_NEEDS_PAYLOADS`). */
  | "transaction"
  /** An inline resource record: counted toward the next applied transaction. */
  | "resource"
  | "end"
  /** Nothing to apply and nothing to ack: a /13 patch held for a resync's full, an `item_meta`
   * record (this receiver never asks for one), and a /15 `resource_hint` or `resource_unhint`
   * (advisory; this receiver keeps no hint table). */
  | "skip";

/** The kind of a non-negative `live_accept` code, or null for a code this receiver does not know. */
export function liveRecordKind(code: number): LiveRecordKind | null {
  switch (code) {
    case ACCEPT_TRANSACTION:
    case ACCEPT_NEEDS_PAYLOADS:
      return "transaction";
    case ACCEPT_RESOURCE:
      return "resource";
    case ACCEPT_END:
      return "end";
    case ACCEPT_HELD:
    case ACCEPT_ITEM_META:
    case ACCEPT_RESOURCE_HINT:
    case ACCEPT_RESOURCE_UNHINT:
      return "skip";
    default:
      return null;
  }
}
