#include "audio_driver_probe.h"
#include "rs_json_lite.h"
#include <set>

namespace grc::audio {
namespace {
using J = rs::json_lite::JValue;
bool fail(std::string *e, const std::string &s) { *e = s; return false; }
bool unique(const J &j) {
  std::set<std::string> keys;
  for (const auto &[k, v] : j.fields) if (!keys.insert(k).second || !unique(v)) return false;
  for (const auto &v : j.items) if (!unique(v)) return false;
  return true;
}
const J *field(const J &j, const char *name, J::Kind kind) {
  auto *v = j.get(name); return v && v->kind == kind ? v : nullptr;
}
bool word(const CalibMemoryReader &m, uint64_t a, uint64_t *v) {
  auto w = m.read_u64(a); *v = w.bits; return w.kind == CalibWord::value;
}
bool name_is(const CalibMemoryReader &m, uint64_t ti, const std::string &name) {
  uint64_t p = 0;
  if (!word(m, ti + 8, &p) || !p) return false;
  const std::string text = std::to_string(name.size()) + name + char(0);
  for (size_t i = 0; i < text.size(); ++i) {
    uint64_t w = 0;
    if (!word(m, (p + i) & ~uint64_t(7), &w) ||
        ((w >> (8 * ((p + i) & 7))) & 255) != static_cast<unsigned char>(text[i])) return false;
  }
  return true;
}
std::set<uint64_t> tables(const CalibMemoryReader &m, const std::string &name, uint64_t parent) {
  std::set<uint64_t> tis, result;
  const auto ranges = m.readonly_ranges();
  for (auto [lo, hi] : ranges) for (uint64_t a = (lo + 7) & ~uint64_t(7); a < hi && hi-a >= 24; a += 8) {
    uint64_t base = 0;
    if (name_is(m, a, name) && (!parent || (word(m, a+16, &base) && base == parent))) tis.insert(a);
  }
  for (auto [lo, hi] : ranges) for (uint64_t a = (lo + 7) & ~uint64_t(7); a < hi && hi-a >= 16; a += 8) {
    uint64_t top = 1, ti = 0;
    if (word(m,a,&top) && !top && word(m,a+8,&ti) && tis.count(ti)) result.insert(a+16);
  }
  return result;
}
}  // namespace
bool dummy_name(const std::string &name, std::string *error) {
  return name == "Dummy" || fail(error, "active audio driver is not Dummy: " + name);
}
bool parse_abi(const std::string &json, Abi *out, std::string *error) {
  *out = {};
  J j;
  if (json.size() > 65536 || !rs::json_lite::Reader(json).parse(&j) || !unique(j))
    return fail(error, "invalid audio ABI JSON");
  auto schema = field(j,"schema",J::String), version = field(j,"version",J::String);
  auto sha = field(j,"header_sha256",J::String), slots = field(j,"slots",J::Array);
  if (!schema || schema->text != "render-stream-audio-driver-abi/1" || !version ||
      version->text != "4.5.1.stable.official" || !sha || sha->text.size()!=64 ||
      sha->text.find_first_not_of("0123456789abcdef") != std::string::npos || !slots ||
      slots->items.empty() || slots->items.size()>128) return fail(error,"unsupported audio ABI fields");
  Abi result; result.version=version->text; result.header_sha256=sha->text;
  std::set<std::string> names;
  for (const auto &v : slots->items) {
    auto n=field(v,"name",J::String), p=field(v,"pure",J::Bool), o=field(v,"override",J::Bool);
    auto placeholder=field(v,"abstract_placeholder",J::Bool);
    if (!n || n->text.empty() || !names.insert(n->text).second || !p || !o || !placeholder)
      return fail(error,"invalid audio ABI slot");
    if (placeholder->b != (p->b || n->text=="destructor" || n->text=="deleting_destructor"))
      return fail(error,"invalid abstract placeholder mask");
    result.slots.push_back({n->text,p->b,o->b,placeholder->b});
  }
  if (result.slots.front().name!="get_name" || !result.slots.front().pure ||
      !result.slots.front().override || result.slots.size()<3 ||
      result.slots[result.slots.size()-2].name!="destructor" ||
      result.slots.back().name!="deleting_destructor") return fail(error,"invalid audio ABI boundaries");
  *out=std::move(result); return true;
}
bool derive(const CalibMemoryReader &m, const std::vector<std::pair<uint64_t,uint64_t>> &writable,
            const Abi &abi, Probe *out, std::string *error) {
  *out = {};
  auto bases=tables(m,"AudioDriver",0);
  if (bases.size()!=1) return fail(error,"AudioDriver base vtable matches="+std::to_string(bases.size()));
  out->base=*bases.begin();
  uint64_t base_ti=0; word(m,out->base-8,&base_ti);
  auto concrete=tables(m,"AudioDriverDummy",base_ti);
  if (concrete.size()!=1) return fail(error,"AudioDriverDummy vtable matches="+std::to_string(concrete.size()));
  out->vptr=*concrete.begin();
  uint64_t pure=0;
  if (!word(m,out->base,&pure) || (pure && !m.is_exec(pure))) return fail(error,"invalid pure-virtual anchor");
  for (size_t i=0;i<abi.slots.size();++i) {
    uint64_t b=0,c=0;
    const auto &s=abi.slots[i];
    if (!word(m,out->base+i*8,&b) || !word(m,out->vptr+i*8,&c) || !m.is_exec(c) ||
        (s.abstract_placeholder ? b!=pure : (!m.is_exec(b) || b==pure)) ||
        (!s.override && b!=c) || (s.override && b==c))
      return fail(error,"audio slot pattern mismatch: "+s.name+" at "+std::to_string(i));
  }
  uint64_t b=0,c=0;
  if ((word(m,out->base+abi.slots.size()*8,&b) && m.is_exec(b)) ||
      (word(m,out->vptr+abi.slots.size()*8,&c) && m.is_exec(c)))
    return fail(error,"audio vtable has unexpected trailing slots");
  std::set<uint64_t> objects;
  for (auto [lo,hi] : writable) for (uint64_t a=(lo+7)&~uint64_t(7); a<hi && hi-a>=8; a+=8) {
    uint64_t v=0; if (word(m,a,&v) && v==out->vptr) objects.insert(a);
  }
  out->object_matches=objects.size();
  if (objects.size()!=1) return fail(error,"AudioDriverDummy object matches="+std::to_string(objects.size()));
  out->object=*objects.begin(); return true;
}
}  // namespace grc::audio
