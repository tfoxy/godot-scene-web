// render-stream/15 resource hints, the host side (render-stream-15.md "Resource hints").
//
// The table holds the payloads the host already keeps at rest and expects a later transaction to
// name: a texture created while armed once its decoded payload is coded at rest (cause `create`),
// and a pre-arm texture the late-arm warm pass prepared (cause `warm`). Each entry keeps the
// bodies it hints (the decoded payload and every variant body) alive while it is hinted, so the
// HTTP server can answer a GET for them before any transaction names them.
//
// Budget. GRC_RESOURCE_HINT_BUDGET_BYTES bounds the at-rest bytes (the held body, its sibling
// coding once made, the variant bodies) of the entries that are NOT in the current captured state.
// The walk goes in ascending priority and admits entries while they fit; from the first entry that
// does not fit on, every entry outside the state is dropped (a strict priority prefix). An entry in
// the state costs nothing and is always admitted. A dropped entry is unhinted wherever it was sent.
//
// Sinks. Each live /15 connection and the /15 file sinks keep a Sent set; diff() turns the table
// into that sink's records for one frame: first the unhints (sent hashes that left the table or the
// budget), then the hints of admitted entries not yet sent and not in the captured state (its
// transactions name those), in priority order, at most `max` in all.
// A hash stays servable from its hint until its unhint has been sent on every sink that hinted it
// (pinned()).
//
// Engine-free and single-threaded: the frame callback owns the table and every Sent set.

#ifndef GRC_RS_HINTS_H
#define GRC_RS_HINTS_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"

namespace grc {
namespace rs {
namespace hints {

// Hints plus unhints a sink gets per frame callback (render-stream-15.md "Placement and ordering":
// the host bounds how many it sends per frame).
inline constexpr std::size_t kPerFrame = 64;
// GRC_RESOURCE_HINT_BUDGET_BYTES' default: 256 MiB.
inline constexpr std::uint64_t kDefaultBudgetBytes = 268435456ull;

// Gate sabotages (GRC_HINT_SABOTAGE): `hint-unknown-hash` adds one hint of a random hash the host
// cannot serve; `hint-early-unhint` unhints every hint on the frame after it was sent while the
// texture stays; `hint-edited-path` sends the registry path even when the texture was edited.
enum class Sabotage : std::uint8_t { None, UnknownHash, EarlyUnhint, EditedPath };
bool parse_sabotage(const char *value, Sabotage *out, std::string *why);
const char *sabotage_name(Sabotage sabotage);

// render-stream-15.md "path": sent only while the texture is pristine (the registry's `edited` bit
// clear), unless the hint-edited-path sabotage is on.
inline bool keep_path(bool edited, Sabotage sabotage) {
  return !edited || sabotage == Sabotage::EditedPath;
}

// One candidate. `hint.priority` is ignored (the table numbers entries in add order).
struct Source {
  rs2::ResourceHint hint;
  std::uint64_t rid = 0;
  PayloadPtr body;  // the decoded payload (null only for the unknown-hash sabotage's entry)
  std::vector<std::pair<std::string, PayloadPtr>> variant_bodies;  // (variant hash, body)
};

struct Entry {
  rs2::ResourceHint hint;  // priority assigned
  std::uint64_t rid = 0;
  PayloadPtr body;
  std::vector<std::pair<std::string, PayloadPtr>> variant_bodies;
  std::shared_ptr<const std::vector<std::uint8_t>> record;  // the encoded resource_hint
  bool in_state = false;  // the current captured state names `hint.hash`
  bool admitted = false;  // within the budget: hinted
  bool removed = false;   // freed, changed or disarmed: unhinted wherever it was sent
};

// The bytes an entry holds at rest: body, its sibling once made (in `sibling` coding), variants.
using SiblingBytes = std::function<std::uint64_t(const PayloadPtr &)>;
std::uint64_t at_rest_bytes(const Entry &entry, const SiblingBytes &sibling);

class Table {
 public:
  void configure(std::uint64_t budget_bytes) { budget_ = budget_bytes; }
  std::uint64_t budget() const { return budget_; }

  // Adds a candidate with the next priority. False when its hash is in the table already.
  bool add(Source source, Sabotage sabotage = Sabotage::None);
  // Removes a hash from the table (unhinted on every sink that hinted it). False when absent.
  bool remove(const std::string &hash);
  // Removes every entry (disarm).
  void clear();
  // Marks which entries the current captured state names.
  void set_in_state(const std::function<bool(const std::string &)> &in_state);
  // The budget walk. Returns how many admitted entries it dropped.
  std::uint64_t walk(const SiblingBytes &sibling = nullptr);
  // Drops removed entries no sink still references (and no live entry shares the hash of).
  void collect(const std::function<bool(const std::string &)> &referenced);

  // Live entries (not removed), ascending priority.
  std::vector<const Entry *> live() const;
  const Entry *find(const std::string &hash) const;  // live only
  // A live or removed entry still held for `hash` (the pin source).
  const Entry *held(const std::string &hash) const;
  std::size_t size() const { return by_hash_.size(); }
  // The admitted, not-in-state at-rest bytes after the last walk.
  std::uint64_t admitted_bytes() const { return admitted_bytes_; }
  std::uint64_t next_priority() const { return next_priority_; }

 private:
  std::uint64_t budget_ = kDefaultBudgetBytes;
  std::uint64_t next_priority_ = 0;
  std::uint64_t admitted_bytes_ = 0;
  std::vector<std::shared_ptr<Entry>> order_;  // ascending priority, removed ones included
  std::unordered_map<std::string, std::shared_ptr<Entry>> by_hash_;  // live
  std::unordered_map<std::string, std::shared_ptr<Entry>> removed_;  // removed, still held
};

// One sink's hinted hashes.
struct Sent {
  struct Hinted {
    std::uint64_t frame = 0;  // the frame callback the hint went out in
    bool spent = false;       // hint-early-unhint: unhinted already, never hinted again
  };
  std::map<std::string, Hinted> hinted;
  bool contains(const std::string &hash) const {
    const auto it = hinted.find(hash);
    return it != hinted.end() && !it->second.spent;
  }
};

struct Diff {
  std::vector<std::shared_ptr<const std::vector<std::uint8_t>>> records;  // in send order
  std::vector<const Entry *> hinted;   // the entries hinted by this diff, in order
  std::vector<std::string> unhinted;   // the hashes unhinted by this diff, in order
};

// One sink's records for frame callback `frame`: unhints first, then hints in priority order, at
// most `max` records in all; `sent` is updated as if they were all delivered.
void diff(const Table &table, Sent *sent, std::uint64_t frame, Sabotage sabotage, std::size_t max,
          Diff *out);

// Every hash a GET must find now: each admitted live entry's hash and variant hashes, and each
// hash still hinted on one of `sinks` (removed or dropped entries until their unhint goes out),
// with the body to serve. Entries with no body (the unknown-hash sabotage) are left out.
void pinned(const Table &table, const std::vector<const Sent *> &sinks,
            std::map<std::string, PayloadPtr> *out);

}  // namespace hints
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_HINTS_H
