#include "rs1_diff.h"

#include <cstring>
#include <map>
#include <set>
#include <utility>

namespace grc {
namespace rs1 {

namespace {

bool floats_equal_bits(float a, float b) {
  std::uint32_t ba = 0;
  std::uint32_t bb = 0;
  std::memcpy(&ba, &a, sizeof(ba));
  std::memcpy(&bb, &b, sizeof(bb));
  return ba == bb;
}

template <typename Arr>
bool arrays_equal_bits(const Arr &a, const Arr &b) {
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!floats_equal_bits(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

// render-stream-1.md "Patch transactions": "An entry differs when any JSON value or any of its
// block floats differs; floats compare by their 32-bit pattern. `commands` do not take part in
// the comparison; `content_version` stands for them."
bool item_state_equal(const ItemState &a, const ItemState &b) {
  if (a.parent.kind != b.parent.kind) {
    return false;
  }
  if (a.parent.kind != ParentKind::None && a.parent.id != b.parent.id) {
    return false;
  }
  if (a.children != b.children || a.visible != b.visible || a.draw_index != b.draw_index ||
      a.z_index != b.z_index || a.z_relative != b.z_relative || a.behind != b.behind ||
      a.clip != b.clip || a.custom_rect != b.custom_rect ||
      a.visibility_layer != b.visibility_layer || a.content_version != b.content_version) {
    return false;
  }
  return arrays_equal_bits(a.xform, b.xform) && arrays_equal_bits(a.modulate, b.modulate) &&
         arrays_equal_bits(a.self_modulate, b.self_modulate) &&
         arrays_equal_bits(a.custom_rect_rect, b.custom_rect_rect);
}

bool canvas_state_equal(const CanvasState &a, const CanvasState &b) {
  if (a.origin != b.origin || a.role != b.role || a.attached != b.attached || a.items != b.items) {
    return false;
  }
  return arrays_equal_bits(a.xform, b.xform);
}

ItemEntry full_entry(const ItemState &item) {
  ItemEntry entry;
  entry.state = item;
  entry.commands_null = false;
  return entry;
}

}  // namespace

Transaction make_full(const Snapshot &cur) {
  Transaction t;
  t.seq = cur.seq;
  t.frame = cur.frame;
  t.encoding = Encoding::Full;
  t.base_seq.reset();
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;
  t.canvases = cur.canvases;
  t.items.reserve(cur.items.size());
  for (const ItemState &item : cur.items) {
    t.items.push_back(full_entry(item));
  }
  return t;
}

Transaction make_patch(const Snapshot &base, const Snapshot &cur) {
  Transaction t;
  t.seq = cur.seq;
  t.frame = cur.frame;
  t.encoding = Encoding::Patch;
  t.base_seq = base.seq;
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;

  std::map<std::uint32_t, const CanvasState *> base_canvases;
  for (const CanvasState &c : base.canvases) {
    base_canvases[c.id] = &c;
  }
  std::map<std::uint32_t, const ItemState *> base_items;
  for (const ItemState &i : base.items) {
    base_items[i.id] = &i;
  }
  std::set<std::uint32_t> cur_canvas_ids;
  for (const CanvasState &c : cur.canvases) {
    cur_canvas_ids.insert(c.id);
  }
  std::set<std::uint32_t> cur_item_ids;
  for (const ItemState &i : cur.items) {
    cur_item_ids.insert(i.id);
  }

  for (const auto &[id, ptr] : base_canvases) {
    (void)ptr;
    if (cur_canvas_ids.find(id) == cur_canvas_ids.end()) {
      t.removed_canvases.push_back(id);
    }
  }
  for (const auto &[id, ptr] : base_items) {
    (void)ptr;
    if (cur_item_ids.find(id) == cur_item_ids.end()) {
      t.removed_items.push_back(id);
    }
  }
  // std::map iterates ascending by key, so removed_* are already ascending.

  for (const CanvasState &canvas : cur.canvases) {
    auto it = base_canvases.find(canvas.id);
    if (it != base_canvases.end() && canvas_state_equal(*it->second, canvas)) {
      continue;
    }
    t.canvases.push_back(canvas);
  }

  for (const ItemState &item : cur.items) {
    auto it = base_items.find(item.id);
    const bool exists_in_base = it != base_items.end();
    if (exists_in_base && item_state_equal(*it->second, item)) {
      continue;
    }
    ItemEntry entry;
    entry.state = item;
    entry.commands_null = exists_in_base && it->second->content_version == item.content_version;
    if (entry.commands_null) {
      entry.state.commands.clear();  // not encoded; keeping it empty avoids ambiguity
    }
    t.items.push_back(std::move(entry));
  }

  return t;
}

Snapshot resolve(const Snapshot &base, const Transaction &txn) {
  Snapshot out;
  out.seq = txn.seq;
  out.frame = txn.frame;
  out.failures = txn.failures;
  out.unsupported = txn.unsupported;

  if (txn.encoding == Encoding::Full) {
    out.canvases = txn.canvases;
    out.items.reserve(txn.items.size());
    for (const ItemEntry &entry : txn.items) {
      out.items.push_back(entry.state);
    }
    return out;
  }

  std::map<std::uint32_t, CanvasState> canvases;
  for (const CanvasState &c : base.canvases) {
    canvases[c.id] = c;
  }
  for (std::uint32_t id : txn.removed_canvases) {
    canvases.erase(id);
  }
  for (const CanvasState &c : txn.canvases) {
    canvases[c.id] = c;
  }

  std::map<std::uint32_t, ItemState> items;
  for (const ItemState &i : base.items) {
    items[i.id] = i;
  }
  for (std::uint32_t id : txn.removed_items) {
    items.erase(id);
  }
  for (const ItemEntry &entry : txn.items) {
    ItemState state = entry.state;
    if (entry.commands_null) {
      auto base_it = items.find(state.id);
      if (base_it != items.end()) {
        state.commands = base_it->second.commands;
      }
    }
    items[state.id] = std::move(state);
  }

  out.canvases.reserve(canvases.size());
  for (auto &[id, c] : canvases) {
    (void)id;
    out.canvases.push_back(c);
  }
  out.items.reserve(items.size());
  for (auto &[id, i] : items) {
    (void)id;
    out.items.push_back(i);
  }
  return out;
}

}  // namespace rs1
}  // namespace grc
