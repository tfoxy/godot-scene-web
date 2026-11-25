/* Public C99 seat endpoint. The product transports whole ordered, reliable messages. */
#ifndef GRC_AUDIO_LINK_H
#define GRC_AUDIO_LINK_H
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN32) && defined(GRC_AUDIO_BUILD)
#define GRC_AUDIO_LINK_API __declspec(dllexport)
#elif defined(_WIN32)
#define GRC_AUDIO_LINK_API
#else
#define GRC_AUDIO_LINK_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define GRC_AUDIO_LINK_ABI_VERSION 1u
typedef struct grc_audio_link_v1 {
  uint32_t abi_version, size;
  void *self;
  /* Called from rs-audio. Copy and return without blocking or calling back into
   * grc_audio_link_*. Return 1 accepted, 0 link-down. */
  int (*link_out)(void *self, const uint8_t *msg, size_t len);
} grc_audio_link_v1;
/* Copies the table. self remains valid until detach returns. NULL detaches;
 * after return no old callback is in flight. Re-attach replaces the old link.
 * Returns 1 attached/detached, 0 audio not granted, -1 invalid ABI/size/callback. */
GRC_AUDIO_LINK_API int grc_audio_link_attach_v1(const grc_audio_link_v1 *link);
/* Copies one complete message. 1 accepted, 0 no attached link, -1 malformed or
 * hello mismatch (down until attach). Both exports are callable from any thread. */
GRC_AUDIO_LINK_API int grc_audio_link_in(const uint8_t *msg, size_t len);
#ifdef __cplusplus
}
#endif
#endif
