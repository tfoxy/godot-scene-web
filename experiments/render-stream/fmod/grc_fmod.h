#ifndef GRC_FMOD_H
#define GRC_FMOD_H
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN32)
#define GRC_FMOD_EXPORT __declspec(dllexport)
#else
#define GRC_FMOD_EXPORT __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define GRC_FMOD_ABI_VERSION 1u

/* Immutable bytes, valid through stop and cache eviction until release(self, owner).
 * owner is non-NULL and opaque. Release exactly once, from any thread. */
typedef struct grc_fmod_buf {
  const uint8_t *data;
  size_t len;
  void *owner;
} grc_fmod_buf;

typedef struct grc_fmod_bank_source_v1 {
  uint32_t abi_version, size;
  void *self;
  uint32_t (*count)(void *self);
  int (*info)(void *self, uint32_t i, const char **path, size_t *len,
              uint8_t md5[16], uint64_t *bytes);
  int (*open)(void *self, uint32_t i, void **file);
  int (*read)(void *self, void *file, void *buf, uint32_t n, uint32_t *got);
  int (*seek)(void *self, void *file, uint64_t pos);
  void (*close)(void *self, void *file);
} grc_fmod_bank_source_v1;

/* Config and callbacks must remain valid for the session. Source callbacks return
 * 1 on success, 0 on failure; read reports partial EOF in got. They must not allocate.
 * Each open has its own cursor; reads use positional I/O. NULL banks selects PCK.
 * Callbacks execute on module threads, outside module locks. */
typedef struct grc_fmod_host_v1 {
  uint32_t abi_version, size;
  void *host;
  /* core_lib, studio_lib: names of ALREADY-LOADED libraries, never load paths.
   * pck_path; banks: comma-separated res:// paths (empty = all banks).
   * lanes: id:name:bus_path[:group],... (group defaults to name); take_cache_bytes; take_cache_dir; take_workers. */
  const char *(*config)(void *host, const char *key);
  void (*link_out)(void *host, uint32_t seat, const uint8_t *msg, size_t len);
  void (*log)(void *host, int level, const char *msg, size_t len);
} grc_fmod_host_v1;

typedef struct grc_fmod_v1 {
  uint32_t abi_version, size;
  void *self;
  /* 1 on, 0 off for this session. First failure latches until process exit. */
  int (*start)(void *self, const grc_fmod_host_v1 *host,
               const grc_fmod_bank_source_v1 *banks, char *error, size_t cap);
  int (*state)(void *self, char *reason, size_t cap);
  void (*seat_open)(void *self, uint32_t seat);
  void (*seat_close)(void *self, uint32_t seat);
  void (*link_in)(void *self, uint32_t seat, const uint8_t *msg, size_t len);
  /* 1 bank-load, 2 bank-unload, 3 event-create, 4 event-start, 5 event-stop,
   * 6 event-release, 7 event-param, 8 global-param, 9 event-paused.
   * instance is the observer's id, never an FMOD handle. Bank ops are evidence only;
   * the configured bankset stays fixed until process exit. Paused uses value 0/1;
   * stop uses FMOD stop mode (0 fadeout, 1 immediate). In v1, op 6 removes the
   * instance from lane state and rejoin replay. Send it only after the host event
   * has stopped (op 5) or ended; releasing a still-playing event means late
   * subscribers will not hear it. */
  void (*observe)(void *self, uint32_t op, uint64_t instance,
                  const char *s, size_t len, float value);
  /* 1 filled, 0 not found (take_get), -1 error. take_get returns canonical WAV;
   * take_index returns UTF-8 JSON {bankset, hashes:[...]}. */
  int (*take_get)(void *self, const uint8_t wav_sha256[32], grc_fmod_buf *out);
  int (*take_index)(void *self, grc_fmod_buf *out);
  void (*release)(void *self, void *owner);
  /* Nonblocking: requests teardown. Outstanding buffers remain valid. */
  void (*stop)(void *self);
} grc_fmod_v1;

/* Fill a complete v1 table. The module and its self remain loaded for process life. */
GRC_FMOD_EXPORT int grc_fmod_get_v1(grc_fmod_v1 *out);
#ifdef __cplusplus
}
#endif
#endif
