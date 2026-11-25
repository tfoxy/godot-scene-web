/* Public, self-contained C99 cue ABI. Strings are borrowed UTF-8 pointer/length
 * pairs. All functions may be called from any game thread. */
#ifndef GRC_AUDIO_CUE_H
#define GRC_AUDIO_CUE_H
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN32) && defined(GRC_AUDIO_BUILD)
#define GRC_AUDIO_CUE_API __declspec(dllexport)
#elif defined(_WIN32)
#define GRC_AUDIO_CUE_API
#else
#define GRC_AUDIO_CUE_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define GRC_AUDIO_CUE_ABI_VERSION 1u
typedef struct grc_audio_gain { const char *group; size_t group_len; float gain; } grc_audio_gain;
typedef struct grc_audio_cue_v1 {
  uint32_t abi_version, size;
  int (*active)(void);
  uint64_t (*now_us)(void);
  /* 1 oneshot, 2 loop-start, 3 loop-stop, 4 loop-stop-all (key may be empty).
   * 1 queued, 0 dormant/muted, -1 refused. A full ring refuses and resync-closes
   * every audio connection. Never allocates. Keys are <=512 B; group keys are
   * <=64 printable ASCII bytes excluding quote and backslash. */
  int (*cue)(uint32_t kind, const uint8_t key_id[16], const char *key, size_t key_len,
             const char *group, size_t group_len, uint64_t t_us, float pitch, float volume);
  /* snapshot=1 replaces groups. Kept while dormant. Returns 1 applied, 0 when
   * no grant or a full group slab omits a new group, -1 for invalid input.
   * A full group slab is counted and never closes a connection. */
  int (*groups)(const grc_audio_gain *gains, size_t n, int snapshot);
  /* SHA-256(0x01 || key), first 16 bytes. 1 success, -1 invalid key/output. */
  int (*key_id)(const char *key, size_t key_len, uint8_t out[16]);
} grc_audio_cue_v1;
/* Fills the v1 table; returns 1, or -1 for NULL. Discover with dlsym on the
 * already-loaded capture handle, as grc_carrier_register. */
GRC_AUDIO_CUE_API int grc_audio_cue_get_v1(grc_audio_cue_v1 *out);
#ifdef __cplusplus
}
#endif
#endif
