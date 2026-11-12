/* A CAR3-shaped module whose entry calls a separately imported DLL. */
#include "grc_net_module.h"
#include <stddef.h>

__declspec(dllimport) int grc_search_dep_value(void);
static int fake_create(grc_carrier_v1 *out, char *error, size_t cap) {
  (void)out; (void)error; (void)cap;
  return 0;
}
static int fake_info(void *self, grc_net_wt_info_v1 *out) {
  (void)self; (void)out;
  return 0;
}
static const grc_net_module_table_v1 kTable = {
    GRC_NET_MODULE_ABI_VERSION, offsetof(grc_net_module_table_v1, features), 1u, 0u, "fake search car3 0",
    fake_create, fake_info, 0, 0};
__declspec(dllexport) const grc_net_module_table_v1 *grc_net_module_v1(void) {
  return grc_search_dep_value() == 7 ? &kTable : NULL;
}
