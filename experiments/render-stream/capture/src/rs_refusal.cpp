#include "rs_refusal.h"

#include "report.h"
#include "rs_hold.h"

namespace grc::rs {
namespace {
void skip_json(JsonWriter &j, const HoldSkipRecord &r) {
  j.object_begin().key("seq").unsigned_integer(r.seq);
  j.key("rid").unsigned_integer(r.rid).key("frame").unsigned_integer(r.frame);
  j.field("source", std::string(hold_source_name(r.source)));
  j.field("reason", std::string(hold_skip_name(r.reason)));
  if (r.thread < 0) j.field_null("thread");
  else j.field("thread", std::string(r.thread == 0 ? "main" : "offmain"));
  j.field("width", r.width).field("height", r.height).field("format", r.format).field("bytes", r.bytes);
  j.key("by");
  if (!r.has_by) j.null();
  else {
    j.object_begin().key("rid").unsigned_integer(r.by_rid);
    if (r.by_kind) j.field("kind", std::string(r.by_kind));
    else j.field_null("kind");
    j.field("width", r.by_width).field("height", r.by_height).field("format", r.by_format);
    std::string pending = by_pending_name(r.by_pending);
    if (r.by_pending == ByPending::Skipped) pending += std::string(":") + hold_skip_name(r.by_pending_reason);
    j.field("pending", pending).object_end();
  }
  j.object_end();
}
// Writes members into either a dependents object or an unresolved RID object.
void dependents_json(JsonWriter &j, const RefusalDependents &deps) {
  j.key("materials").array_begin();
  for (const auto &m : deps.materials) {
    j.object_begin().key("id").unsigned_integer(m.id).key("params").array_begin();
    for (const auto &name : m.params) j.string(name);
    j.array_end().object_end();
  }
  j.array_end().key("items").array_begin();
  for (const auto &item : deps.items)
    j.object_begin().key("id").unsigned_integer(item.id).field("op", item.op).object_end();
  j.array_end().key("more").unsigned_integer(deps.more);
}
}  // namespace

std::string refusals_json(const std::vector<RefusalRecord> &records, std::uint64_t records_dropped,
                          const RefusalCounts &counts, const RecoverIndexReport &index,
                          std::uint64_t arm, std::uint64_t frame) {
  JsonWriter j;
  const auto u = [&j](const char *key, std::uint64_t v) { j.key(key).unsigned_integer(v); };
  j.object_begin().field("schema", std::string("render-stream-refusals/1")).field("final", true);
  u("arm", arm); u("frame", frame);
  j.key("counts").object_begin();
  u("refused", counts.refused); u("refused_no_image", counts.refused_no_image);
  j.key("recovered").object_begin();
  u("total", counts.recovered); u("replace", counts.recovered_replace); u("update", counts.recovered_update);
  j.object_end(); u("records", records.size()); u("records_dropped", records_dropped);
  j.object_end().key("records").array_begin();
  for (const auto &r : records) {
    j.object_begin(); u("rid", r.rid); u("frame", r.frame);
    j.field("family", std::string("texture")).field("reason", r.reason).key("registry");
    if (!r.registered) j.null();
    else {
      j.object_begin().field("kind", r.kind).field("width", r.width).field("height", r.height);
      j.field("format", r.format).field("mipmaps", r.mipmaps).field("facts_known", r.facts_known);
      j.field("updated", r.updated).field("released", r.released).field("edited", r.edited).field("held", r.held);
      j.field("has_path", r.has_path).field("path", r.path).object_end();
    }
    if (r.offmain_seen) j.field("created_offmain", true);
    else j.field_null("created_offmain");
    j.key("last_skip");
    if (r.has_skip) skip_json(j, r.last_skip);
    else j.null();
    j.key("recovered");
    if (!r.recovered) j.null();
    else {
      j.object_begin().field("path", r.recovered_path); u("frame", r.recovered_frame);
      u("published_id", r.recover.published_id); u("materials", r.recover.materials); u("params", r.recover.params);
      j.object_end();
    }
    j.key("dependents").object_begin(); dependents_json(j, r.deps); j.object_end().object_end();
  }
  j.array_end().key("index").object_begin();
  u("entries", index.entries); u("peak", index.peak); u("dropped", index.dropped);
  j.key("resolved").object_begin();
  u("by_replace", index.resolved_by_replace); u("by_adopt", index.resolved_by_adopt); j.object_end();
  u("materials", index.materials); u("params", index.params);
  u("republish_skipped_fault", index.republish_skipped_fault);
  j.key("unresolved").array_begin();
  for (const auto &r : index.unresolved) {
    j.object_begin(); u("rid", r.rid); j.field("refused", r.refused);
    dependents_json(j, r.deps); j.object_end();
  }
  j.array_end(); u("unresolved_more", index.unresolved_more);
  j.object_end().object_end();
  return j.take();
}
}  // namespace grc::rs
