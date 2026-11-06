/* grc_net_module.h -- the entry of librender_stream_net, render-stream's net module.
 *
 * protocol/carrier-design.md D8, D11, D17, Q4 (CAR3). The module is a Rust cdylib (rs-net/) that
 * holds every QUIC and TLS byte. The capture dlopen()s it (RTLD_NOW | RTLD_LOCAL) only when
 * GRC_LIVE_CARRIERS lists `wt` or GRC_LIVE_TLS_CERT is set (CAR4), from GRC_LIVE_NET_MODULE or
 * beside the capture's own .so, and never dlclose()s it. It exports exactly one symbol family,
 * `grc_net_*`, with two entries:
 *
 *     const grc_net_module_table_v1 *grc_net_module_v1(void);   (CAR3: the `wt` carrier)
 *     const grc_net_tls_table_v1 *grc_net_tls_v1(void);         (CAR4: the wss TLS session)
 *
 * Each returns a static table, versioned on its own. The capture refuses (`net-module-abi`) a
 * module whose entry is missing, whose table's abi_version is not the header's or whose size is
 * short, or (grc_net_module_v1) whose carrier_abi_version is not GRC_CARRIER_ABI_VERSION. It asks
 * for grc_net_tls_v1 only when a certificate pair is configured.
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
  /* TRK3: GRC_NET_FEATURE_* bits. A reader reads `features` only when `size` >=
   * offsetof(grc_net_module_table_v1, features) + 4; a CAR3-era module (size 40) has no
   * features, which reads as 0. */
  uint32_t features;
  uint32_t features_reserved; /* 0 */
} grc_net_module_table_v1;

/* Bit 0: the `wt` carrier admits track subprotocols through grc_carrier_host_v1.admit_subprotocol
 * (protocol/tracks-design.md Q7). Without it the capture does not report wt as serving tracks. */
#define GRC_NET_FEATURE_TRACKS 1u

typedef const grc_net_module_table_v1 *(*grc_net_module_table_v1_fn)(void);

/* ---- grc_net_tls_v1 (CAR4, carrier-design.md D11, D12): wss on the built-in `ws` carrier ----
 *
 * A sans-IO TLS server session. The capture's ws I/O thread owns the socket; it feeds the
 * ciphertext it read, reads the plaintext that yields, writes the plaintext it wants sent and
 * takes the ciphertext to put on the socket. No call touches a socket, a thread or a clock, so
 * none blocks: each is memory-speed, except the handshake's one key exchange and one signature
 * (bounded CPU work, well under a millisecond for a P-256 key). TLS 1.3 only (rustls, `ring`);
 * ALPN `http/1.1`.
 *
 * A config is the consumer's PEM pair (GRC_LIVE_TLS_CERT / GRC_LIVE_TLS_KEY), parsed once and
 * shared by every session made from it; config_* may be called from any thread. A session is
 * single-threaded: one thread drives it from create to destroy. Every entry catches panics (D17):
 * a panic inside a session call fails that session alone (GRC_TLS_FAILED, error "panic in ...").
 * Handles are opaque; a null handle is harmless (feed/read/write return -1, take 0). */

#define GRC_NET_TLS_ABI_VERSION 1u
#define GRC_NET_TLS_ENTRY "grc_net_tls_v1"

typedef struct grc_net_tls_config grc_net_tls_config;   /* opaque */
typedef struct grc_net_tls_session grc_net_tls_session; /* opaque */

/* grc_net_tls_table_v1::state bits. */
#define GRC_TLS_HANDSHAKING 1u /* the handshake has not completed */
#define GRC_TLS_WANTS_WRITE 2u /* ciphertext is waiting for take() */
#define GRC_TLS_PEER_CLOSED 4u /* close_notify received; once read() returns 0 no more plaintext */
#define GRC_TLS_FAILED 8u      /* fatal (bad record, failed handshake, panic): error() says why;
                                  take() may still yield the alert to send before closing */

typedef struct grc_net_tls_table_v1 {
  uint32_t abi_version;       /* GRC_NET_TLS_ABI_VERSION */
  uint32_t size;              /* sizeof(grc_net_tls_table_v1) as the module built it */
  const char *module_version; /* NUL-terminated, the same string as grc_net_module_table_v1's */
  /* Loads the PEM pair (a certificate chain, leaf first; a PKCS#8, SEC1 or PKCS#1 key): the
   * config, or null with a NUL-terminated "tls-config-invalid: ..." in error[0..error_cap) for a
   * file that cannot be read, holds no certificate or no key, or a key that is not the leaf's. */
  grc_net_tls_config *(*config_create)(const char *cert_pem_path, const char *key_pem_path,
                                       char *error, size_t error_cap);
  /* Writes the leaf certificate's SHA-256 (64 lowercase hex and a NUL) into out; 1, or 0 when
   * out_cap < 65. */
  int (*config_cert_sha256)(const grc_net_tls_config *config, char *out, size_t out_cap);
  void (*config_destroy)(grc_net_tls_config *config); /* after every session made from it */
  /* A new server session, or null with error[0..error_cap) set. */
  grc_net_tls_session *(*session_create)(const grc_net_tls_config *config, char *error,
                                         size_t error_cap);
  void (*session_destroy)(grc_net_tls_session *session);
  /* Ciphertext in: the bytes consumed. Fewer than len while the session holds as much unread
   * plaintext as it buffers (read() it, then feed the rest); -1 once the session has failed. */
  int64_t (*feed)(grc_net_tls_session *session, const uint8_t *data, size_t len);
  /* Plaintext out: bytes copied into out, 0 when there is none now, -1 on a failed session. */
  int64_t (*read)(grc_net_tls_session *session, uint8_t *out, size_t out_cap);
  /* Plaintext in, for encryption: all len bytes (held until the handshake completes), or -1 on
   * a failed session. The caller bounds what it writes; the session sets no limit. */
  int64_t (*write)(grc_net_tls_session *session, const uint8_t *data, size_t len);
  /* Ciphertext out: bytes copied into out, 0 when there is none. */
  int64_t (*take)(grc_net_tls_session *session, uint8_t *out, size_t out_cap);
  uint32_t (*state)(const grc_net_tls_session *session); /* GRC_TLS_* bits */
  /* Copies the failure reason (NUL-terminated, truncated) and returns its full length. */
  size_t (*error)(const grc_net_tls_session *session, char *out, size_t out_cap);
  /* Queues close_notify for take(); nothing can be written after it. */
  void (*close_notify)(grc_net_tls_session *session);
} grc_net_tls_table_v1;

typedef const grc_net_tls_table_v1 *(*grc_net_tls_table_v1_fn)(void);

#ifdef __cplusplus
}
#endif

#endif /* GRC_NET_MODULE_H */
