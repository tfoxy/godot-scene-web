#include "ct_ledger.h"

#include <cassert>
#include <cstdio>

int main() {
  CtLedger ledger;
  ledger.apply = 3;
  ledger.write(0, 101, 7, true);
  ledger.write(0, 102, 8, true);
  ledger.free(102);  // Deliberately omit h7's free: the actual diagnostic must name it.
  assert(ledger.summary() == "[receiver] ct-ledger: created=2 freed=1 live=1 overwritten=0 replaced=0 [h7@apply3:rid101]");
  ledger.write(101, 103, 7, false);
  ledger.replace(101);
  assert(ledger.summary().find("overwritten=1 replaced=1 [h7@apply3:rid101]") != std::string::npos);
  ledger.free(103);  // An image free cannot erase the overwritten CanvasTexture.
  assert(ledger.live.size() == 1);
  ledger.free(101);
  assert(ledger.summary() == "[receiver] ct-ledger: created=2 freed=2 live=0 overwritten=1 replaced=1 []");
  for (uint32_t h = 1; h <= 33; ++h) ledger.write(0, h, h, true);
  assert(ledger.summary().find("h32@apply3:rid32 ...]") != std::string::npos);
  assert(ledger.summary().find("h33@") == std::string::npos);
  std::puts("ct-ledger-test: 6 checks passed");
}
