/* Fake net modules for rs_net_module_test (carrier-design.md CAR3, `net-module-abi`): with
 * GRC_FAKE_NO_ENTRY it exports no grc_net_module_v1 at all; without it, an entry whose table
 * claims a future module ABI. */
#ifdef GRC_FAKE_NO_ENTRY
int grc_net_fake_unrelated(void) { return 1; }
#else
#include "grc_net_module.h"
static const grc_net_module_table_v1 kTable = {99u, sizeof(grc_net_module_table_v1), 1u, 0u, "fake 0", 0, 0};
const grc_net_module_table_v1 *grc_net_module_v1(void) { return &kTable; }
#endif
