/* grc_carrier.h -- grc_carrier_v1, the public C ABI of a render-stream live carrier.
 *
 * protocol/carrier-design.md Q1 (D4, D5, D6, D17). A carrier moves the live hub's messages to and
 * from its peers over some transport: the built-in "ws" (WebSocket over TCP, rs_ws), the built-in
 * "wt" (WebTransport, the net module) or a consumer's own. A carrier knows nothing about
 * render-stream records: it carries opaque binary messages out, small text messages in, and
 * answers resource fetches by content hash. The bytes it carries are the wire's
 * (render-stream/13 and earlier), byte for byte; a carrier is not a protocol version (D2).
 *
 * This header is C only (C99), self-contained, and stable: a v1 carrier built against it keeps
 * working against every later capture that speaks v1.
 *
 * Versioning. Every struct starts with `abi_version` and `size`. A reader accepts a struct when
 * `abi_version == GRC_CARRIER_ABI_VERSION && size >= sizeof(<its v1 struct>)`, so a v1 struct may
 * grow at its end without a new version; a writer sets `size = sizeof(struct)`. A reader never
 * reads past the `size` it was given.
 *
 * Strings are UTF-8 `(pointer, length)` pairs, never NUL-terminated unless the field says so. A
 * pointer handed to a callback is valid only for the duration of that call; copy what you keep.
 *
 * Connection ids (D5). A carrier names its connections with `local` ids of its own choosing, in
 * 1..GRC_CARRIER_LOCAL_MAX, unique among its connections that are admitted and not yet closed.
 * The capture namespaces them as `index << 24 | local` (index: 0 "ws", 1 "wt", 2..255 registered
 * carriers). A local id of 0 or above GRC_CARRIER_LOCAL_MAX is a carrier fault
 * (`conn-id-overflow`): the capture refuses its admission, or closes it with 1011.
 *
 * Threading and ownership.
 *  - Hot calls (`send_binary`, `send_text`, `close`, `queued_bytes`, `max_queued_bytes`) come from
 *    the capture's main thread, inside its frame callback. They must return without blocking: no
 *    I/O, and no lock held across I/O.
 *  - `send_*` takes ownership of its grc_buf whether it succeeds or not, and calls the host's
 *    `release(host, owner)` exactly once, from any thread, when the bytes are written or dropped.
 *    The capture passes its own buffer without a copy; a carrier that wants a copy makes it. A
 *    send on a closed or unknown `local` returns 0 (and still releases). A send that would push
 *    the connection's queued bytes past its limit returns 0 and closes the connection 1008.
 *  - `queued_bytes` counts bytes the carrier accepted and has not yet handed to the OS (or its
 *    QUIC stack); `max_queued_bytes` is that count's high-water mark for the connection. Both are
 *    0 for an unknown `local`.
 *  - Lifecycle calls (`start`, `stop`, `destroy`) run on the main thread, at live start and finish.
 *    `stop` may block, bounded (about 2 s), while it closes connections and joins its threads.
 *    After `stop` returns the carrier makes no host callback and holds no host grc_buf; the
 *    capture ignores any callback that still arrives and records a fault.
 *  - Host callbacks are thread-safe, never block, and may be called from any thread, including
 *    from inside a vtable call. Per connection, events are ordered as the callbacks are made.
 *
 * Event rules (per `local`):
 *  - `admit` before `opened`: an upgrade or session is accepted only once `admit` returned 1
 *    (D6: GRC_LIVE_MAX_CONNECTIONS is a total across every carrier). A refused one is answered
 *    as the carrier's transport answers "too many" (WebSocket: 503) and reported with
 *    `rejected(GRC_REJECT_CAPACITY)` or not at all.
 *  - A granted slot returns at `closed`, or at `rejected` when the connection never opened.
 *  - `closed` comes exactly once per `opened`; `text` only between them.
 *  - `rejected` is never followed by `opened` or `closed` for that `local`.
 *  - Resource fetches are not connections: `resource_served` needs no `admit` and any `local`
 *    (it is reported to the hub without its id).
 *
 * Version and subprotocol are the hub's business: the carrier passes the negotiated subprotocol
 * string (`render-stream.13`, ...) through `opened`, and the hub checks the hello's token itself
 * for render-stream/7 and later. A carrier that serves resource fetches checks their bearer token
 * with `token_ok` and their Origin with `origin_ok`.
 */
#ifndef GRC_CARRIER_H
#define GRC_CARRIER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GRC_CARRIER_ABI_VERSION 1u

/* The largest local connection id (2^24 - 1); see "Connection ids" above. */
#define GRC_CARRIER_LOCAL_MAX 0xFFFFFFu

/* An owned message. Whoever receives one calls the host's release(host, owner) exactly once,
 * from any thread, when done with `data`. */
typedef struct grc_buf {
  const uint8_t *data;
  size_t len;
  void *owner;
} grc_buf;

/* HTTP-style content codings of a resource body (texture-delivery-design.md D2). */
typedef enum grc_coding {
  GRC_CODING_IDENTITY = 0,
  GRC_CODING_GZIP = 1,
  GRC_CODING_ZSTD = 2
} grc_coding;

/* Why a connection was refused before it opened. */
typedef enum grc_reject {
  GRC_REJECT_AUTH = 1,     /* a missing or wrong bearer token (the hub logs a 401) */
  GRC_REJECT_ORIGIN = 2,   /* an Origin not allowed (403); `detail` is the refused Origin */
  GRC_REJECT_CAPACITY = 3  /* admission refused (503); counted, not forwarded to the hub */
} grc_reject;

/* Log levels for grc_carrier_host_v1.log. */
#define GRC_LOG_ERROR 0
#define GRC_LOG_WARN 1
#define GRC_LOG_INFO 2

/* The capture's side, handed to start(). Valid, with every function pointer non-NULL, until
 * stop() returns. */
typedef struct grc_carrier_host_v1 {
  uint32_t abi_version; /* GRC_CARRIER_ABI_VERSION */
  uint32_t size;        /* sizeof(grc_carrier_host_v1) as the capture built it */
  void *host;           /* opaque; the first argument of every callback below */

  /* Resolved configuration, NUL-terminated, or NULL when unset. Keys: "listen", "expose",
   * "path", "subprotocols" and "hello_token_subprotocols" (comma lists, most preferred first),
   * "max_inbound_text", "max_queued_bytes" (decimal), "tls_cert", "tls_key", "wt_listen",
   * "wt_cert", "evidence_dir". The pointer stays valid until stop() returns. */
  const char *(*config)(void *host, const char *key);

  /* Admission (D6): 1 = a slot is granted to `local`, 0 = refused (capacity, or a bad `local`).
   * Call it once per connection, before opened(). The slot returns at closed(), or at
   * rejected() for a connection that never opened. */
  int (*admit)(void *host, uint32_t local);

  /* Events. */
  void (*opened)(void *host, uint32_t local, const char *subprotocol, size_t subprotocol_len,
                 const char *origin, size_t origin_len); /* origin_len 0: no Origin */
  void (*text)(void *host, uint32_t local, const char *data, size_t len);
  void (*closed)(void *host, uint32_t local, uint16_t code, const char *reason, size_t len);
  void (*rejected)(void *host, uint32_t local, grc_reject why, const char *detail, size_t len);
  /* One resource fetch answered: `hash` is the 64 lowercase hex characters as requested (not
   * NUL-terminated); `status` an HTTP status (200, 304, 400, 401, 404, ...); `identity_bytes`
   * the identity body size and `wire_bytes` what was sent (both 0 unless 200). */
  void (*resource_served)(void *host, uint32_t local, const char hash[64], uint16_t status,
                          grc_coding coding, uint64_t identity_bytes, uint64_t wire_bytes);

  /* Services: thread-safe, memory-speed (they never wait on anything slower than memory). */
  /* 1 when `token` is the session's bearer token (constant time), or when auth is off. */
  int (*token_ok)(void *host, const char *token, size_t len);
  /* 1 when `origin` is empty or allowed. */
  int (*origin_ok)(void *host, const char *origin, size_t len);
  /* The body of `hash` (64 lowercase hex, not NUL-terminated) in `coding`. 1 = found and *out
   * set (release it with release(host, out->owner)); 0 = not servable in that coding (for a
   * non-identity coding: serve identity instead). The first coded lookup of a hash may compress
   * on the calling thread. */
  int (*lookup)(void *host, const char hash[64], grc_coding coding, grc_buf *out);
  /* Releases any grc_buf the host handed out: lookup()'s, and every send_*()'s message. */
  void (*release)(void *host, void *owner);
  /* One log line (no trailing newline needed); `level` is a GRC_LOG_* value. */
  void (*log)(void *host, int level, const char *msg, size_t len);
} grc_carrier_host_v1;

/* The carrier's side. */
typedef struct grc_carrier_v1 {
  uint32_t abi_version; /* GRC_CARRIER_ABI_VERSION */
  uint32_t size;        /* sizeof(grc_carrier_v1) as the carrier built it */
  /* NUL-terminated, [a-z0-9-]{1,16}. "ws" and "wt" are reserved for the built-in carriers. */
  const char *name;
  void *self; /* opaque; the first argument of every call below */

  /* Binds and starts; returns 1, or 0 with a NUL-terminated reason in error[0..error_cap). The
   * host struct and its pointers stay valid until stop() returns. */
  int (*start)(void *self, const grc_carrier_host_v1 *host, char *error, size_t error_cap);
  /* Closes every connection, joins the carrier's threads, releases every host grc_buf. */
  void (*stop)(void *self);
  /* Hot calls; see "Threading and ownership". send_* return 1 when queued. */
  int (*send_binary)(void *self, uint32_t local, grc_buf message);
  int (*send_text)(void *self, uint32_t local, grc_buf message);
  /* Starts a graceful close; closed() follows once it completes. A no-op on an unknown local. */
  void (*close)(void *self, uint32_t local, uint16_t code, const char *reason, size_t len);
  uint64_t (*queued_bytes)(void *self, uint32_t local);
  uint64_t (*max_queued_bytes)(void *self, uint32_t local);
  /* Frees `self`; called once, after stop() (or instead of start() when live never started). */
  void (*destroy)(void *self);
} grc_carrier_v1;

/* CAR6 (not yet exported): registers a consumer carrier before live starts. The capture copies
 * *carrier. Returns its index (2..255), or -1 when live has already started (`carrier-late`), the
 * name is malformed, reserved or taken, or the struct's version or size is not accepted. Look it
 * up with dlsym(RTLD_DEFAULT, "grc_carrier_register"). */
typedef int (*grc_carrier_register_fn)(const grc_carrier_v1 *carrier);

#ifdef __cplusplus
}
#endif

#endif /* GRC_CARRIER_H */
