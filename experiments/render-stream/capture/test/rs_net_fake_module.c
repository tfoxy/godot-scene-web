/* Fake net modules for rs_net_module_test (`net-module-abi`): with
 * GRC_FAKE_NO_ENTRY it exports no grc_net_module_v1 at all; without it, an entry whose table
 * claims a future module ABI. */
#ifdef GRC_FAKE_NO_ENTRY
int grc_net_fake_unrelated(void) { return 1; }
#elif defined(GRC_FAKE_CAR3)
/* TRK3: a CAR3-era module -- a valid table of 40 bytes (no `features` field). The loader must
 * still accept it, and it serves no tracks. */
#include "grc_net_module.h"
#include <stddef.h>
static int fake_create(grc_carrier_v1 *out, char *error, size_t cap) {
  (void)out; (void)error; (void)cap;
  return 0;
}
static int fake_info(void *self, grc_net_wt_info_v1 *out) {
  (void)self; (void)out;
  return 0;
}
static const grc_net_module_table_v1 kTable = {
    GRC_NET_MODULE_ABI_VERSION, offsetof(grc_net_module_table_v1, features), 1u, 0u, "fake car3 0",
    fake_create, fake_info, 0, 0};
const grc_net_module_table_v1 *grc_net_module_v1(void) { return &kTable; }
#else
#include "grc_net_module.h"
static const grc_net_module_table_v1 kTable = {99u, sizeof(grc_net_module_table_v1), 1u, 0u, "fake 0", 0, 0};
const grc_net_module_table_v1 *grc_net_module_v1(void) { return &kTable; }
#endif
