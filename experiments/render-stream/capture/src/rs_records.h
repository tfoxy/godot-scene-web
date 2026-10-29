// HC4b (host-cost-design.md D1 "The diff, record planning, serving and budget"): the /11 record
// plan of a transaction from base B to target T -- rs2_diff.h records_before(B, T), the names of
// inline(T) not in inline(B) in table order, and |inline(T)| -- over the entries B and T do not
// share.
//
// A name only T's shared entries hold is in inline(B) too, so the candidates are the names of T's
// entries that are not B's very entries (diff_tables' changed side), in table order. A candidate
// is held by B when one of B's own differing entries names it, or when one of the entries both
// share names it: T's name index (Captured::names, NameIndex) counts the entries of T naming each
// hash, so a hash named more often in T than by T's differing entries is named by a shared one.
//
// Exact whenever T carries a valid name index (a snapshot the mirror built, untouched); otherwise
// (a resolved hold-back snapshot, a sabotaged table, a hand-built state) it is records_before()
// itself, the full walk. Engine-free, header-only.
#ifndef GRC_RS_RECORDS_H
#define GRC_RS_RECORDS_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "rs2_diff.h"
#include "rs_captured.h"

namespace grc {
namespace rs {

struct RecordPlan {
  std::vector<rs2::PayloadName> records;  // inline(T) minus inline(B), table order
  std::uint64_t inline_count = 0;         // |inline(T)|
  bool indexed = false;                   // planned over the differing entries (not the full walk)
};

namespace records_detail {

// diff_tables (rs2_diff.cpp) for one table: `base_entry(e)` for each of B's entries T does not
// share, `target_entry(e)` for each of T's, both ascending by id.
template <typename T, typename OnBase, typename OnTarget>
void differing_entries(const rs2::SharedTable<T> &base, const rs2::SharedTable<T> &target,
                       OnBase base_entry, OnTarget target_entry) {
  const auto &bc = base.chunks();
  const auto &tc = target.chunks();
  std::size_t i = 0;
  std::size_t j = 0;
  while (i < bc.size() || j < tc.size()) {
    if (j == tc.size() || (i < bc.size() && bc[i]->key < tc[j]->key)) {
      for (const auto &p : bc[i]->entries) {
        base_entry(*p);
      }
      ++i;
      continue;
    }
    if (i == bc.size() || tc[j]->key < bc[i]->key) {
      for (const auto &p : tc[j]->entries) {
        target_entry(*p);
      }
      ++j;
      continue;
    }
    if (bc[i] != tc[j]) {
      const auto &be = bc[i]->entries;
      const auto &te = tc[j]->entries;
      std::size_t a = 0;
      std::size_t b = 0;
      while (a < be.size() || b < te.size()) {
        if (b == te.size() || (a < be.size() && be[a]->id < te[b]->id)) {
          base_entry(*be[a++]);
        } else if (a == be.size() || te[b]->id < be[a]->id) {
          target_entry(*te[b++]);
        } else {
          if (be[a] != te[b]) {
            base_entry(*be[a]);
            target_entry(*te[b]);
          }
          ++a;
          ++b;
        }
      }
    }
    ++i;
    ++j;
  }
}

}  // namespace records_detail

inline RecordPlan plan_v11_records(const Captured *base, const Captured &target,
                                   const rs2::InlinePolicy &policy) {
  RecordPlan plan;
  const bool indexed = target.names_valid && target.names_inline_max == policy.inline_max_bytes;
  if (!indexed || base == nullptr) {
    plan.records = rs2::records_before(base != nullptr ? &base->state : nullptr, target.state, policy);
    plan.inline_count = indexed ? (policy.inline_variants ? target.inline_count_variants
                                                          : target.inline_count)
                                : rs2::inline_names(target.state, policy).size();
    return plan;
  }
  plan.indexed = true;
  plan.inline_count =
      policy.inline_variants ? target.inline_count_variants : target.inline_count;
  if (&base->state == &target.state) {
    return plan;
  }
  // Candidates: the names of T's differing entries, in table order, with their count there;
  // and every name B's differing entries hold.
  std::vector<rs2::PayloadName> candidates;
  std::unordered_map<std::string, std::uint32_t> target_counts;
  std::unordered_set<std::string> base_names;
  const auto on_target = [&](const std::string &hash, std::uint64_t bytes, bool variant) {
    if (variant && !policy.inline_variants) {
      return;
    }
    if (++target_counts[hash] == 1) {
      candidates.push_back(rs2::PayloadName{hash, bytes});
    }
  };
  const auto on_base = [&](const std::string &hash, std::uint64_t, bool variant) {
    if (variant && !policy.inline_variants) {
      return;
    }
    base_names.insert(hash);
  };
  records_detail::differing_entries(
      base->state.textures, target.state.textures,
      [&](const rs2::TextureEntry &e) { texture_entry_names(e, on_base); },
      [&](const rs2::TextureEntry &e) { texture_entry_names(e, on_target); });
  records_detail::differing_entries(
      base->state.meshes, target.state.meshes,
      [&](const rs2::MeshEntry &e) { mesh_entry_names(e, on_base); },
      [&](const rs2::MeshEntry &e) { mesh_entry_names(e, on_target); });
  records_detail::differing_entries(
      base->state.shaders, target.state.shaders,
      [&](const rs2::ShaderEntry &e) { shader_entry_names(e, on_base); },
      [&](const rs2::ShaderEntry &e) { shader_entry_names(e, on_target); });
  for (rs2::PayloadName &name : candidates) {
    if (name.payload_bytes > policy.inline_max_bytes || base_names.count(name.hash) != 0) {
      continue;
    }
    const NameIndex::value_type *count = target.names.find_entry(name.hash);
    const std::uint32_t in_target =
        count == nullptr ? 0
                         : count->second.main + (policy.inline_variants ? count->second.variant : 0);
    if (in_target > target_counts[name.hash]) {
      continue;  // a shared entry names it, so B holds it
    }
    plan.records.push_back(std::move(name));
  }
  return plan;
}

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RECORDS_H
