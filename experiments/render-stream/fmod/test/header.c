#include "grc_fmod.h"
#include <stddef.h>
_Static_assert(offsetof(grc_fmod_v1, release) == offsetof(grc_fmod_v1, take_index) + sizeof(void *), "release order");
_Static_assert(sizeof(grc_fmod_buf) == sizeof(void *) * 3, "buffer layout");
_Static_assert(sizeof(grc_fmod_v1) == 96, "64-bit v1 table");
int main(void) { return GRC_FMOD_ABI_VERSION != 1; }
