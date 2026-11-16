// payload bodies compressed at rest.
//
// A GRT1 texture body (the decoded variant, and a `block` variant) is coded once, where it is
// built: on the texture worker under GRC_TEXTURE_WORKERS=<N> (every copy, small ones included),
// on the hook's own thread under `sync` (the worker's job run inline). The coding is the host's
// first HTTP coding, GRC_HTTP_ENCODING's first entry (zstd under the default `zstd,gzip`; `off`
// codes nothing), and a body is kept coded only when that makes it smaller. From then on the
// mirror, every snapshot's payload map and the served set share that one coded body (rs_captured.h
// PayloadBytes); no identity copy is held beside it. The content hash and every `payload_bytes`
// stay the identity payload's.
//
// A GET whose Accept-Encoding takes the stored coding is answered with the stored bytes. One that
// takes only the host's second coding (a plain-http LAN page's Chromium sends `gzip, deflate`) is
// answered with the sibling body once it is made ("Sibling coding" below). Every other reader of the identity
// content -- a GET or carrier request that takes neither, the store directory's file, an inline
// record, the lazy Basis encode, a sabotage's corruption -- inflates it on its own thread through
// identity_of(): a zstd (or gzip) decompress of bytes already in memory, never a texture decode,
// never kept (no TTL, no identity copy). Each is counted per site.
//
// Sibling coding. GRC_HTTP_ENCODING may name a second coding (the default `zstd,gzip` does): the
// sibling. When a coded body becomes servable on a live listener (ServedResources pins its hash),
// one encode of it in the second coding is queued on the host's sibling pool: it inflates the
// at-rest body, codes it and keeps the result on the body beside the at-rest form (two small
// coded bodies, never an identity copy). That runs off the hooks, the frame callback and the I/O
// thread, once per body, and after the stream already published it: the sibling never delays
// publication. A request that takes only the second coding is served it once it is made; one that
// arrives before (or after the encode failed, was not smaller, or was dropped at stream end) gets
// the identity at once, never waits (counted: `misses`). A host with no live listener, or with
// one coding, never makes one.
//
// Mesh and shader payloads, KTX2 bodies and anything not GRT1 are never coded. Nothing here runs
// while no stream is armed: the hooks build no body then.
//
// Engine-free and thread-safe (atomics; the config is set at arm, before any hook builds a body).
#ifndef GRC_RS_PAYLOAD_REST_H
#define GRC_RS_PAYLOAD_REST_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

#include "rs_captured.h"

namespace grc {
namespace rs {

struct RestConfig {
  RestCoding coding = RestCoding::Identity;  // what entry.cpp sets from GRC_HTTP_ENCODING
  // GRC_AT_REST_FAULT=keep-identity (a sabotage, never on the wire): the coded body is made, and
  // the identity body is kept beside it, so served-at-rest must fail.
  bool keep_identity = false;
  // GRC_HTTP_ENCODING's second entry: the coding a served body's sibling is made in (Identity:
  // none, e.g. a single coding or `off`).
  RestCoding sibling = RestCoding::Identity;
};

void set_rest_config(const RestConfig &config);
RestConfig rest_config();
const char *rest_coding_token(RestCoding coding);  // "identity", "zstd" or "gzip"

// GRC_AT_REST_FAULT: unset/empty, or `keep-identity`. False with `error` set otherwise.
bool parse_rest_fault(const char *value, bool *keep_identity, std::string *error);

// Whether `bytes` (a whole payload) is a GRT1 payload long enough to code (render-stream-2.md
// "HTTP (live)": a mesh or shader payload, and any short body, stays as it is).
bool rest_codable(const std::uint8_t *data, std::size_t size);

// Codes `*bytes` (an identity body, just built and hashed, not yet shared with another thread) at
// rest under the configured coding. Replaces it with the coded body when that is smaller; marks it
// tried either way. A null, already coded or non-GRT1 body is left as it is (non-GRT1: tried).
void code_at_rest(PayloadPtr *bytes);

// Who inflated a coded body (the counters' index).
enum class InflateSite : std::uint8_t {
  Get,       // an HTTP GET or carrier request that does not take the stored coding
  Store,     // the store directory's file (the file writer thread)
  Inline,    // an inline resource record (file recording, live transaction)
  Basis,     // the lazy Basis encode's source (the encode pool)
  Sabotage,  // a sabotage's corrupted copy
  Restore,   // a released path-less texture restored to the dummy at disarm
  Sibling,   // the source of a sibling coding's encode (the sibling pool)
  kCount,
};
const char *inflate_site_name(InflateSite site);

// The identity payload of `body`: `body` itself when it is not coded, otherwise a fresh inflated
// copy (counted under `site`; the keep-identity sabotage's kept body instead, uncounted). Null for
// a null body, or when the inflate fails (counted as `inflate_failed`).
std::shared_ptr<const std::vector<std::uint8_t>> identity_of(const PayloadPtr &body,
                                                             InflateSite site);

struct RestStats {
  std::uint64_t coded = 0;        // bodies kept coded
  std::uint64_t not_smaller = 0;  // GRT1 bodies tried whose coding did not shrink them
  std::uint64_t in_bytes = 0;     // the identity bytes of the coded bodies
  std::uint64_t out_bytes = 0;    // their coded bytes
  std::uint64_t code_ns = 0;      // time spent coding (tried bodies)
  std::uint64_t code_main_thread = 0;  // of the tried bodies, those coded on the main thread
  struct Inflate {
    std::uint64_t count = 0;
    std::uint64_t coded_bytes = 0;
    std::uint64_t identity_bytes = 0;
    std::uint64_t ns = 0;
  };
  Inflate inflate[static_cast<std::size_t>(InflateSite::kCount)];
  std::uint64_t inflate_failed = 0;
  struct Sibling {
    std::uint64_t made = 0;         // sibling bodies kept
    std::uint64_t not_smaller = 0;  // encodes whose result did not shrink the identity (failed)
    std::uint64_t failed = 0;       // encodes that failed outright (inflate or coder)
    std::uint64_t dropped = 0;      // encodes queued but never run (the pool stopped first)
    std::uint64_t in_bytes = 0;     // identity bytes of the bodies kept
    std::uint64_t out_bytes = 0;    // their sibling bytes
    std::uint64_t ns = 0;           // time spent coding (inflate excluded: inflate.sibling)
    std::uint64_t misses = 0;       // requests for the second coding served identity (not made)
  } sibling;
};
RestStats rest_stats();
void reset_rest_stats();
// Marks the calling thread as the engine's main thread for code_main_thread (entry.cpp, at arm).
void set_rest_main_thread();

// The sibling coding's body (rs_captured.h PayloadBytes::sibling). Guarded by the module's mutex.
struct RestSibling {
  enum class State : std::uint8_t { Pending, Ready, Failed } state = State::Pending;
  RestCoding coding = RestCoding::Identity;
  std::shared_ptr<const std::vector<std::uint8_t>> bytes;  // Ready: the coded body
};

// Queues `work` on the host's sibling pool; false when it cannot (the work is then dropped, never
// run on the caller's thread).
using SiblingSubmit = std::function<bool(std::function<void()>)>;

// Queues `body`'s one sibling encode through `submit` when the host has a second coding and
// `body` is coded at rest in another one. Cheap: no coding on the caller's thread. False when
// nothing was queued (not applicable, already started for this body, or refused: a refused encode
// counts as dropped and the body is served identity to second-coding readers).
bool start_sibling(const PayloadPtr &body, const SiblingSubmit &submit);

// `body` in `coding` when that is its sibling and made; null otherwise (serve the identity). Never
// waits, never codes. A null answer for the host's second coding counts as a miss.
std::shared_ptr<const std::vector<std::uint8_t>> sibling_bytes(const PayloadPtr &body, RestCoding coding);

// served-at-rest's census of what a holder keeps: each distinct GRT1 body once.
struct RestCensus {
  std::uint64_t bodies = 0;
  std::uint64_t coded = 0;
  std::uint64_t not_smaller = 0;  // tried, identity (did not shrink)
  std::uint64_t untried = 0;      // identity, never tried while a coding was on (a missed path)
  // Identity bytes held for bodies that are (or should have been) coded: a coded body's kept
  // identity copy, and an untried body's own bytes. The check wants 0.
  std::uint64_t identity_bytes_held = 0;
  std::uint64_t held_bytes = 0;      // what the bodies hold in memory
  std::uint64_t identity_bytes = 0;  // what they would hold as identity
  // Allocated beyond their sizes (vector capacity): memory held that held_bytes does not show.
  std::uint64_t capacity_slack_bytes = 0;
  // Sibling bodies made, and their bytes (held beside the at-rest body, outside held_bytes).
  std::uint64_t siblings = 0;
  std::uint64_t sibling_bytes = 0;
  // Counts `body` once per distinct pointer (`seen` is the caller's dedup set).
  void add(const PayloadPtr &body, std::unordered_set<const void *> *seen);
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_PAYLOAD_REST_H
