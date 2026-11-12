#include "rs_refusal.h"

#include <cstdio>
#include <initializer_list>
#include <limits>

#include "rs_json_lite.h"

namespace {
using namespace grc::rs;
using json_lite::JValue;
int checks = 0, failures = 0;
void expect(bool ok, int line) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL rs_refusal_test.cpp:%d\n", line); ++failures; }
}
#define EXPECT(ok) expect((ok), __LINE__)
const JValue &field(const JValue &v, const char *key) {
  static const JValue missing;
  const auto *p = v.get(key);
  EXPECT(p != nullptr);
  return p ? *p : missing;
}
const JValue &at(const JValue &v, std::size_t i) {
  static const JValue missing;
  EXPECT(v.kind == JValue::Array && i < v.items.size());
  return i < v.items.size() ? v.items[i] : missing;
}
void keys(const JValue &v, std::initializer_list<const char *> names) {
  EXPECT(v.kind == JValue::Object && v.fields.size() == names.size());
  for (const auto *name : names) EXPECT(v.get(name) != nullptr);
}
void number(const JValue &v, const char *key, const std::string &want) {
  const auto &n = field(v, key);
  EXPECT(n.kind == JValue::Number && n.text == want);
}
void boolean(const JValue &v, const char *key, bool want) {
  const auto &b = field(v, key);
  EXPECT(b.kind == JValue::Bool && b.b == want);
}
bool same(const JValue &a, const JValue &b) {
  if (a.kind != b.kind || a.b != b.b || a.text != b.text || a.items.size() != b.items.size() ||
      a.fields.size() != b.fields.size()) return false;
  for (std::size_t i = 0; i < a.items.size(); ++i) if (!same(a.items[i], b.items[i])) return false;
  for (const auto &f : a.fields) {
    const auto *other = b.get(f.first.c_str());
    if (!other || !same(f.second, *other)) return false;
  }
  return true;
}
JValue parse(const std::string &text) {
  JValue v;
  EXPECT(json_lite::Reader(text).parse(&v));
  return v;
}
JValue json(const std::vector<RefusalRecord> &records = {}, std::uint64_t dropped = 0,
            const RefusalCounts &counts = {}, const RecoverIndexReport &index = {}) {
  return parse(refusals_json(records, dropped, counts, index, 3, 151));
}
void empty() {
  EXPECT(kRefusalRecordCap == 64 && kRefusalDependentsCap == 16);
  EXPECT(kRecoverIndexMaxEntries == 4096 && kRecoverUnresolvedCap == 32);
  const RecoverInfo info;
  EXPECT(info.published_id == 0 && info.materials == 0 && info.params == 0 && !info.republish_skipped);
  const auto v = json();
  keys(v, {"schema", "final", "arm", "frame", "counts", "records", "index"});
  EXPECT(field(v, "schema").text == "render-stream-refusals/1");
  boolean(v, "final", true); number(v, "arm", "3"); number(v, "frame", "151");
  const auto &c = field(v, "counts");
  keys(c, {"refused", "refused_no_image", "recovered", "records", "records_dropped"});
  for (const auto *name : {"refused", "refused_no_image", "records", "records_dropped"}) number(c, name, "0");
  const auto &recovered = field(c, "recovered");
  keys(recovered, {"total", "replace", "update"});
  for (const auto *name : {"total", "replace", "update"}) number(recovered, name, "0");
  EXPECT(field(v, "records").kind == JValue::Array && field(v, "records").items.empty());
  const auto &index = field(v, "index");
  keys(index, {"entries", "peak", "dropped", "resolved", "materials", "params", "republish_skipped_fault",
               "unresolved", "unresolved_more"});
  for (const auto *name : {"entries", "peak", "dropped", "materials", "params", "republish_skipped_fault", "unresolved_more"})
    number(index, name, "0");
  keys(field(index, "resolved"), {"by_replace", "by_adopt"});
  number(field(index, "resolved"), "by_replace", "0"); number(field(index, "resolved"), "by_adopt", "0");
  EXPECT(field(index, "unresolved").kind == JValue::Array && field(index, "unresolved").items.empty());
}
void records() {
  RefusalRecord refused, recovered;
  refused.rid = std::numeric_limits<std::uint64_t>::max(); refused.frame = 31;
  refused.reason = "no-image";
  refused.deps.materials = {{10, {"src", "quote\"\\\n"}}, {11, {}}};
  refused.deps.items = {{12, "add_texture_rect"}, {13, "op\"\\\n"}};
  refused.deps.more = 17;
  recovered.rid = 42; recovered.frame = 32; recovered.reason = "canvas-empty";
  recovered.registered = true; recovered.kind = "texture_2d";
  recovered.width = 64; recovered.height = 8; recovered.format = 11;
  recovered.mipmaps = recovered.facts_known = recovered.updated = true;
  recovered.released = recovered.edited = recovered.held = recovered.has_path = true;
  recovered.path = "res://a\"\\\n.tres";
  recovered.offmain_seen = true;
  recovered.recovered = true; recovered.recovered_path = "replace"; recovered.recovered_frame = 41;
  recovered.recover = {23, 2, 4, true};
  RecoverIndexReport index;
  index.entries = 1; index.peak = 2; index.dropped = 3;
  index.resolved_by_replace = 4; index.resolved_by_adopt = 5;
  index.materials = 6; index.params = 7; index.republish_skipped_fault = 8;
  index.unresolved = {{refused.rid, true, refused.deps}, {55, false, {}}};
  index.unresolved_more = 9;
  const auto v = json({refused, recovered}, 21, {30, 29, 27, 25, 2}, index);
  const auto &c = field(v, "counts");
  number(c, "refused", "30"); number(c, "refused_no_image", "29");
  number(c, "records", "2"); number(c, "records_dropped", "21");
  const auto &rc = field(c, "recovered");
  number(rc, "total", "27"); number(rc, "replace", "25"); number(rc, "update", "2");
  const auto &r0 = at(field(v, "records"), 0);
  const auto &r1 = at(field(v, "records"), 1);
  for (const auto *r : {&r0, &r1}) {
    keys(*r, {"rid", "frame", "family", "reason", "registry", "created_offmain", "last_skip", "recovered", "dependents"});
    EXPECT(field(*r, "family").text == "texture");
    EXPECT(field(*r, "last_skip").kind == JValue::Null);
  }
  number(r0, "rid", "18446744073709551615"); number(r0, "frame", "31");
  EXPECT(field(r0, "reason").text == "no-image");
  for (const auto *name : {"registry", "created_offmain", "recovered"}) EXPECT(field(r0, name).kind == JValue::Null);
  const auto &deps = field(r0, "dependents");
  keys(deps, {"materials", "items", "more"}); number(deps, "more", "17");
  EXPECT(field(deps, "materials").items.size() == 2 && field(deps, "items").items.size() == 2);
  const auto &m = at(field(deps, "materials"), 0);
  keys(m, {"id", "params"}); number(m, "id", "10");
  EXPECT(at(field(m, "params"), 0).text == "src");
  EXPECT(at(field(m, "params"), 1).text == refused.deps.materials[0].params[1]);
  number(at(field(deps, "materials"), 1), "id", "11");
  EXPECT(field(at(field(deps, "materials"), 1), "params").items.empty());
  const auto &item = at(field(deps, "items"), 0);
  keys(item, {"id", "op"}); number(item, "id", "12");
  EXPECT(field(item, "op").text == "add_texture_rect");
  EXPECT(field(at(field(deps, "items"), 1), "op").text == refused.deps.items[1].op);
  number(r1, "rid", "42"); number(r1, "frame", "32");
  EXPECT(field(r1, "reason").text == "canvas-empty"); boolean(r1, "created_offmain", true);
  const auto &reg = field(r1, "registry");
  keys(reg, {"kind", "width", "height", "format", "mipmaps", "facts_known", "updated", "released", "edited", "held", "has_path", "path"});
  EXPECT(field(reg, "kind").text == "texture_2d");
  number(reg, "width", "64"); number(reg, "height", "8"); number(reg, "format", "11");
  for (const auto *name : {"mipmaps", "facts_known", "updated", "released", "edited", "held", "has_path"}) boolean(reg, name, true);
  EXPECT(field(reg, "path").text == recovered.path);
  const auto &recovery = field(r1, "recovered");
  keys(recovery, {"path", "frame", "published_id", "materials", "params"});
  EXPECT(field(recovery, "path").text == "replace"); number(recovery, "frame", "41");
  number(recovery, "published_id", "23"); number(recovery, "materials", "2"); number(recovery, "params", "4");
  const auto &ix = field(v, "index");
  number(ix, "entries", "1"); number(ix, "peak", "2"); number(ix, "dropped", "3");
  number(field(ix, "resolved"), "by_replace", "4"); number(field(ix, "resolved"), "by_adopt", "5");
  number(ix, "materials", "6"); number(ix, "params", "7");
  number(ix, "republish_skipped_fault", "8"); number(ix, "unresolved_more", "9");
  const auto &u0 = at(field(ix, "unresolved"), 0);
  const auto &u1 = at(field(ix, "unresolved"), 1);
  keys(u0, {"rid", "refused", "materials", "items", "more"});
  number(u0, "rid", "18446744073709551615"); boolean(u0, "refused", true);
  for (const auto *name : {"materials", "items", "more"}) EXPECT(same(field(u0, name), field(deps, name)));
  number(u1, "rid", "55"); boolean(u1, "refused", false);
  const auto &empty_deps = field(r1, "dependents");
  keys(empty_deps, {"materials", "items", "more"});
  EXPECT(field(empty_deps, "materials").kind == JValue::Array && field(empty_deps, "materials").items.empty());
  EXPECT(field(empty_deps, "items").kind == JValue::Array && field(empty_deps, "items").items.empty());
  number(empty_deps, "more", "0");

  // Registered but unknown facts stay distinct from an unregistered texture.
  RefusalRecord unknown;
  unknown.registered = true; unknown.reason = "reload-code";
  unknown.recovered = true; unknown.recovered_path = "update";
  const auto defaults = json({unknown});
  const auto &r = at(field(defaults, "records"), 0);
  const auto &facts = field(r, "registry");
  for (const auto *name : {"width", "height", "format"}) number(facts, name, "-1");
  for (const auto *name : {"mipmaps", "facts_known", "updated", "released", "edited", "held", "has_path"}) boolean(facts, name, false);
  EXPECT(field(facts, "path").kind == JValue::String && field(facts, "path").text.empty());
  EXPECT(field(r, "reason").text == "reload-code" && field(field(r, "recovered"), "path").text == "update");
}
void skips() {
  // The refusal's last_skip is the same evidence entry the hold writer publishes.
  for (const auto pending : {ByPending::None, ByPending::Present, ByPending::Evicted, ByPending::Skipped, ByPending::Unregistered}) {
    for (int thread : {-1, 0, 1}) {
      for (bool has_by : {false, true}) {
        RefusalRecord r;
        r.has_skip = true;
        auto &s = r.last_skip;
        s.seq = 13; s.rid = 14; s.frame = 15;
        s.width = 64; s.height = 32; s.format = 11; s.bytes = 32768;
        s.source = has_by ? HoldSource::Replace : HoldSource::Update;
        s.reason = HoldSkip::OffmainReplace; s.thread = static_cast<std::int8_t>(thread);
        s.has_by = has_by; s.by_rid = 16;
        s.by_kind = thread < 0 ? nullptr : "texture_2d";
        s.by_width = 128; s.by_height = 16; s.by_format = 8;
        s.by_pending = pending; s.by_pending_reason = HoldSkip::OverTextureCap;
        HoldRings rings; rings.skips.push_back(s);
        const auto hold = parse(hold_json({}, {}, 0, true, 151, "active", "", "none", rings));
        const auto refusal = json({r});
        const auto &skip = field(at(field(refusal, "records"), 0), "last_skip");
        EXPECT(same(skip, at(field(hold, "skip_records"), 0)));
        number(skip, "seq", "13");
        if (has_by && pending == ByPending::Skipped)
          EXPECT(field(field(skip, "by"), "pending").text == "skipped:over_texture_cap");
      }
    }
  }
}
void caller_bounds() {
  // The caller caps storage and reports losses; the writer must not silently truncate again.
  std::vector<RefusalRecord> records(kRefusalRecordCap);
  for (std::size_t i = 0; i < records.size(); ++i) records[i].rid = i + 1;
  auto v = json(records, 6);
  number(field(v, "counts"), "records", "64"); number(field(v, "counts"), "records_dropped", "6");
  EXPECT(field(v, "records").items.size() == 64);
  number(at(field(v, "records"), 0), "rid", "1"); number(at(field(v, "records"), 63), "rid", "64");
  records.push_back(RefusalRecord{}); records.back().rid = 65;
  v = json(records, 0);
  number(field(v, "counts"), "records", "65"); number(field(v, "counts"), "records_dropped", "0");
  EXPECT(field(v, "records").items.size() == 65); number(at(field(v, "records"), 64), "rid", "65");
}
}  // namespace
int main() {
  empty(); records(); skips(); caller_bounds();
  std::printf("rs_refusal_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
