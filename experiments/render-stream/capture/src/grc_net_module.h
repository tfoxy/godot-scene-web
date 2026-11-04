/* grc_net_module.h -- the entry of librender_stream_net, render-stream's net module.
 *
 * protocol/carrier-design.md D8, D11, D17, Q4 (CAR3). The module is a Rust cdylib (rs-net/) that
 * holds every QUIC and TLS byte. The capture dlopen()s it (RTLD_NOW | RTLD_LOCAL) only when
 * GRC_LIVE_CARRIERS lists `wt`, from GRC_LIVE_NET_MODULE or beside the capture's own .so, and
 * never dlclose()s it. It exports exactly one symbol family, `grc_net_*`; the entry is
 *
 *     const grc_net_module_table_v1 *grc_net_module_v1(void);
 *
 * which returns a static table. The capture refuses (`net-module-abi`) a module whose entry is
 * missing, whose table's abi_version is not GRC_NET_MODULE_ABI_VERSION or whose size is short, or
 * whose carrier_abi_version is not GRC_CARRIER_ABI_VERSION.
 *
 * This header is capture-private (the carrier ABI, grc_carrier.h, is the public one); the module
 * and the capture are built from the same tree. Same conventions as grc_carrier.h: every struct
 * starts with abi_version and size, and a reader never reads past `size`.
 */
#ifndef GRC_NET_MODULE_H
#define GRC_NET_MODULE_H

#include <stddef.h>
#include <stdint.h>

#include "grc_carrier.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GRC_NET_MODULE_ABI_VERSION 1u
#define GRC_NET_MODULE_ENTRY "grc_net_module_v1"

/* What a started `wt` carrier is, for evidence/live-carriers.json (D13). Strings are
 * NUL-terminated within their arrays. */
typedef struct grc_net_wt_info_v1 {
  uint32_t abi_version; /* GRC_NET_MODULE_ABI_VERSION */
  uint32_t size;        /* sizeof(grc_net_wt_info_v1) as the caller built it */
  char address[64];     /* the bound UDP host, "" before start */
  int32_t port;         /* the bound UDP port, -1 before start */
  char tls[16];         /* "self-signed" | "consumer" */
  char cert_sha256[65]; /* the leaf certificate's SHA-256, 64 lowercase hex */
  uint8_t faulted;      /* 1 once a panic stopped the carrier (D17, `carrier-fault`) */
  uint8_t cert_expired; /* 1 once the certificate expired; new sessions are refused (Q4.6) */
  uint8_t reserved[1];
  uint64_t sessions_refused;   /* CONNECTs answered with a non-200 status */
  uint64_t streams_refused;    /* streams reset with unknown-stream-type (Q4.2) */
  uint64_t datagrams_dropped;  /* datagrams received and dropped (D16) */
} grc_net_wt_info_v1;

typedef struct grc_net_module_table_v1 {
  uint32_t abi_version;         /* GRC_NET_MODULE_ABI_VERSION */
  uint32_t size;                /* sizeof(grc_net_module_table_v1) as the module built it */
  uint32_t carrier_abi_version; /* the grc_carrier_v1 version its carriers implement */
  uint32_t reserved;
  const char *module_version;   /* NUL-terminated, e.g. "render-stream-net 0.1.0" */
  /* Fills *out with a new, unstarted `wt` carrier (render-stream-wt/1, carrier-design.md Q4):
   * 1, or 0 with a NUL-terminated reason in error[0..error_cap). The carrier is driven through
   * grc_carrier_v1 like any other; its destroy() frees it. */
  int (*wt_create)(grc_carrier_v1 *out, char *error, size_t error_cap);
  /* Fills *out (whose abi_version and size the caller sets) for a carrier wt_create made; `self`
   * is its grc_carrier_v1.self. 1 when filled. Thread-safe, memory-speed. */
  int (*wt_info)(void *self, grc_net_wt_info_v1 *out);
} grc_net_module_table_v1;

typedef const grc_net_module_table_v1 *(*grc_net_module_table_v1_fn)(void);

#ifdef __cplusplus
}
#endif

#endif /* GRC_NET_MODULE_H */
