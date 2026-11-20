/* Socket-free ICE-lite / DTLS / SCTP host interface. No capture dependency.
 * grc_net_rtc_v1() returns an immutable process-lifetime table (abi == 1).
 * All functions use the platform C calling convention, including callbacks.
 *
 * Ownership and threading:
 * create copies config, credentials, certificate, key and callbacks before returning.
 * Config strings are NUL-terminated UTF-8; all strings with a length are UTF-8 bytes,
 * without a terminating NUL. Text messages must be valid UTF-8; binary is 0 or 1.
 * Input buffers/addresses need remain valid only until their function returns.
 * Callback buffers/addresses/labels are borrowed only for that callback's duration;
 * copy them to retain them. user is borrowed until destroy completes (or until the
 * current callback returns when it calls destroy). No callback may unwind into C.
 *
 * The module owns no socket. The host supplies received UDP datagrams to input
 * (first byte 0..3 STUN or 20..63 DTLS); transmit asks the host to send a complete
 * datagram from local_candidate to dst. input's dst must equal local_candidate exactly
 * (family, address octets and port; an IPv4-mapped IPv6 dst is NOT the IPv4 candidate):
 * a dual-stack host passes the IPv4 form. Mismatched and other datagrams and
 * unauthenticated checks are silently dropped. Source loopback, unspecified and multicast IPs are dropped.
 * Peers are allocated only after STUN USERNAME and MESSAGE-INTEGRITY validation.
 * No SDP is consumed and channel labels are not filtered.
 *
 * Calls may run on multiple host threads. Callbacks are serialized per module,
 * collected under its lock and invoked WITHOUT that lock. They run on a calling
 * host thread or the one internal protocol-timer thread. The timer waits on a
 * condition variable for the next protocol deadline; it does not poll. A callback
 * may reenter any entry, including send and destroy. Reentrant calls queue their
 * callbacks behind the current callback. Callbacks must not wait for callbacks
 * from the same module. Keep callbacks short so protocol timers can progress.
 *
 * The host must serialize destroy against all other host entry calls and must
 * call destroy exactly once. destroy stops the timer, discards pending callbacks
 * and waits for any callback on another thread to finish. No new callback starts
 * after destroy returns. When called inside a callback, that callback may return
 * normally; queued callbacks are cancelled. A timer-thread callback cannot join
 * itself: its timer exits as the callback unwinds. The handle is invalid as soon
 * as destroy is called; do not use it again, including from the current callback.
 * Null handles are harmless (input/send return -1, buffered returns 0, close/destroy
 * do nothing). All non-null pointers must be valid and suitably aligned; a byte
 * pointer may be NULL only for length zero. Every callback is optional (NULL).
 *
 * Return codes: create/input: 0 success, -1 invalid argument/config/handle,
 * -4 internal/protocol error. create always clears *out first; failure writes a
 * truncated, NUL-terminated UTF-8 error if err != NULL and err_cap > 0. Success
 * clears err. send: 0 accepted (copied), 1 association budget full (nothing queued,
 * retry after dc_low or another drain), -1 invalid argument/handle, empty message, or text UTF-8,
 * -2 unknown/closed peer or channel, -3 message above 65536 bytes, -4 internal error.
 * buffered reports bytes queued or in flight on that channel; unknown => 0.
 * close entries ignore unknown IDs. Closing a peer closes its channels first.
 * IDs are nonzero module-local peer IDs and peer-local channel IDs, not SCTP stream
 * IDs; neither is reused during its owner's lifetime. peer(state=1) reports DTLS
 * connected; peer(state=0) reports removal (possibly before state=1 on failure).
 * remote is the real authenticated source address, supplied for both states.
 * dc_closed reports channel removal; dc_low reports a downward crossing of the
 * configured per-channel buffered threshold, not delivery of any specific message.
 * The send budget is shared by every channel of a peer while dc_low is per channel:
 * after send returns 1, a channel already below its threshold gets no dc_low when
 * the association drains. A host that waits on dc_low should use dc_low_threshold 0
 * and treat any dc_low on a peer as a retry signal for all of that peer's channels.
 * log receives UTF-8 JSON with a monotonic tMs since create and an event name.
 * log levels: 0 error, 1 warning, 2 info. destroy emits no close callbacks.
 */
#ifndef GRC_NET_RTC_H
#define GRC_NET_RTC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GRC_NET_RTC_ABI_VERSION 1u
#define GRC_NET_RTC_ENTRY "grc_net_rtc_v1"

typedef struct grc_rtc_addr {
  uint8_t family; /* 4 or 6. IPv6 scope IDs are not represented. */
  uint8_t _r;     /* Reserved: initialize to zero. */
  uint16_t port;  /* Host byte order, nonzero. */
  uint8_t addr[16]; /* Network-order octets: first 4 for IPv4 (rest zero), all 16 for IPv6. */
} grc_rtc_addr;

typedef struct grc_rtc_callbacks_v1 {
  uint32_t abi; /* GRC_NET_RTC_ABI_VERSION */
  void *user;
  void (*transmit)(void *, const grc_rtc_addr *dst, const uint8_t *, size_t);
  void (*peer)(void *, uint32_t peer, int state, const grc_rtc_addr *remote);
  void (*dc_open)(void *, uint32_t peer, uint32_t dc, const char *label, size_t);
  void (*dc_message)(void *, uint32_t peer, uint32_t dc, int binary, const uint8_t *, size_t);
  void (*dc_low)(void *, uint32_t peer, uint32_t dc);
  void (*dc_closed)(void *, uint32_t peer, uint32_t dc);
  void (*log)(void *, int level, const char *, size_t);
} grc_rtc_callbacks_v1;

typedef struct grc_rtc_config_v1 {
  const uint8_t *cert_der; /* Matching ECDSA P-256 certificate and PKCS#8 key. */
  size_t cert_len;
  const uint8_t *key_pkcs8;
  size_t key_len;
  const char *ice_ufrag; /* Host-supplied local ICE credentials; nonempty, no colon. */
  const char *ice_pwd;   /* Nonempty local ICE password. */
  grc_rtc_addr local_candidate; /* Specified non-loopback unicast IP, nonzero port. */
  uint32_t max_peers;           /* 0 => 16. */
  uint32_t recv_max_message;    /* 0 => 262144 bytes. */
  uint32_t dc_low_threshold;    /* Bytes per channel; zero is a valid threshold. */
  uint32_t sctp_send_budget;    /* Queued/in-flight bytes per association; 0 => 262144. */
} grc_rtc_config_v1;

typedef struct grc_rtc_v1 {
  uint32_t abi;
  int (*create)(const grc_rtc_config_v1 *, const grc_rtc_callbacks_v1 *, void **out, char *err, size_t err_cap);
  int (*input)(void *, const grc_rtc_addr *src, const grc_rtc_addr *dst, const uint8_t *, size_t);
  int (*send)(void *, uint32_t peer, uint32_t dc, int binary, const uint8_t *, size_t);
  uint64_t (*buffered)(void *, uint32_t peer, uint32_t dc);
  void (*close_dc)(void *, uint32_t, uint32_t);
  void (*close_peer)(void *, uint32_t);
  void (*destroy)(void *);
} grc_rtc_v1;

const grc_rtc_v1 *grc_net_rtc_v1(void);

#ifdef __cplusplus
}
#endif
#endif
