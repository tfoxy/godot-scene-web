// Opt-in executor diagnostics. Kept independent of Godot so missing frees can be tested directly.
#pragma once

#include <cstdint>
#include <map>
#include <sstream>
#include <string>

struct CtLedger {
  struct Creation {
    uint32_t handle;
    uint64_t apply;
  };
  std::map<uint64_t, Creation> live;
  uint64_t apply = 0;
  uint64_t created = 0;
  uint64_t freed = 0;
  uint64_t overwritten = 0;
  uint64_t replaced = 0;

  void write(uint64_t previous, uint64_t rid, uint32_t handle, bool canvas) {
    if (live.contains(previous)) ++overwritten;
    if (canvas && rid != 0) {
      live.emplace(rid, Creation{handle, apply});
      ++created;
    }
  }
  void free(uint64_t rid) { freed += live.erase(rid); }
  void replace(uint64_t rid) {
    if (live.contains(rid)) ++replaced;
  }
  std::string summary() const {
    std::ostringstream out;
    out << "[receiver] ct-ledger: created=" << created << " freed=" << freed
        << " live=" << live.size() << " overwritten=" << overwritten << " replaced=" << replaced
        << " [";
    size_t count = 0;
    for (const auto &[rid, creation] : live) {
      if (count == 32) {
        out << " ...";
        break;
      }
      if (count++) out << ' ';
      out << 'h' << creation.handle << "@apply" << creation.apply << ":rid" << rid;
    }
    out << ']';
    return out.str();
  }
};
