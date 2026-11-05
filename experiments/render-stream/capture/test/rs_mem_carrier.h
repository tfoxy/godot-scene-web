// rs_mem_carrier: a test-only in-memory consumer carrier (CAR6, protocol/carrier-design.md, CAR6
// row). It implements grc_carrier_v1 the way a consumer would, from outside the capture: its own
// client thread opens `connections` connections (admit, opened, the hello as text), receives what
// the hub sends (appending each message to that connection's bytes and releasing the buffer from
// the client thread), answers a hub close with closed() after the messages queued before it, and
// writes everything to `out_dir` at stop: mem-<name>.json and mem-<name>-<local>.bin.
//
// Sabotage (`fault`): "double-release" releases the third binary message's buffer twice; the
// capture's owner ledger (AbiCarrier) must count it as `release-unknown` and free nothing twice.
#ifndef GRC_RS_MEM_CARRIER_H
#define GRC_RS_MEM_CARRIER_H

#include <string>

#include "grc_carrier.h"

namespace grc {
namespace test {

struct MemCarrierOptions {
  std::string name = "mem";
  int connections = 1;
  std::string subprotocol = "render-stream.7";
  std::string hello;  // the first text message on every connection
  std::string fault;  // "" | "double-release"
  std::string out_dir;
};

// A heap carrier for grc_carrier_register; its destroy() frees it. `stats_starts` and
// `stats_destroys`, when non-null, count start() and destroy() calls.
grc_carrier_v1 make_mem_carrier(const MemCarrierOptions &options, int *stats_starts,
                                int *stats_destroys);

}  // namespace test
}  // namespace grc

#endif  // GRC_RS_MEM_CARRIER_H
