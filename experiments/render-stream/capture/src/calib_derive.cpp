#include "calib_derive.h"

#include <algorithm>
#include <charconv>
#include <cstring>
#include "rs_file.h"
#include <set>
#include <sstream>

#include "pe_image.h"
#include "rs_json_lite.h"
#include "rs_sha256.h"

namespace grc {
namespace {
using J = rs::json_lite::JValue;

bool fail(std::string *error, const std::string &message) { *error = message; return false; }
bool range(uint64_t off, uint64_t size, uint64_t end) { return off <= end && size <= end - off; }
uint64_t le(const uint8_t *p, size_t n) {
  uint64_t v = 0;
  for (size_t i = 0; i < n; ++i) v |= uint64_t(p[i]) << (8 * i);
  return v;
}
bool string_at(const CalibMemoryReader &m, uint64_t addr, std::string *out, size_t limit = 128) {
  out->clear();
  if (addr > UINT64_MAX - limit) return false;
  for (size_t i = 0; i < limit; ++i) {
    const uint64_t pos = addr + i;
    auto w = m.read_u64(pos & ~uint64_t(7));
    if (w.kind != CalibWord::value) return false;
    const unsigned char c = (w.bits >> (8 * (pos & 7))) & 255;
    if (!c) return true;
    if (c < 32 || c > 126) return false;
    out->push_back(static_cast<char>(c));
  }
  return false;
}
bool word(const CalibMemoryReader &m, uint64_t addr, uint64_t *out) {
  auto w = m.read_u64(addr);
  *out = w.bits;
  return w.kind == CalibWord::value;
}
bool name_is(const CalibMemoryReader &m, uint64_t ti, const std::string &name) {
  uint64_t ptr = 0;
  std::string text;
  return ti <= UINT64_MAX - 16 && word(m, ti + 8, &ptr) && ptr &&
         string_at(m, ptr, &text) && text == std::to_string(name.size()) + name;
}
bool looks_typeinfo(const CalibMemoryReader &m, uint64_t ti) {
  uint64_t ptr = 0;
  std::string text;
  if (ti > UINT64_MAX - 16 || !word(m, ti + 8, &ptr) || !ptr ||
      !string_at(m, ptr, &text) || text.size() < 2) return false;
  auto digit = [](char c) { return c >= '0' && c <= '9'; };
  auto alpha = [](char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); };
  size_t i = 0;
  while (i < text.size() && digit(text[i])) ++i;
  return (i && i < text.size() && (alpha(text[i]) || text[i] == '_')) ||
         (text[0] == 'N' && digit(text[1])) ||
         (text[0] == 'P' && (alpha(text[1]) || digit(text[1])));
}
std::vector<uint64_t> primary_tables(const CalibMemoryReader &m, uint64_t ti) {
  std::set<uint64_t> found;
  for (auto [lo, hi] : m.readonly_ranges()) {
    if (lo > UINT64_MAX - 7) continue;
    for (uint64_t addr = (lo + 7) & ~uint64_t(7); range(addr, 8, hi); addr += 8) {
      uint64_t v = 0, top = 1;
      if (addr >= 8 && word(m, addr, &v) && v == ti && word(m, addr - 8, &top) && !top)
        found.insert(addr + 8);
      if (addr > UINT64_MAX - 8) break;
    }
  }
  return {found.begin(), found.end()};
}
bool walk(const CalibMemoryReader &m, uint64_t ap, std::vector<CalibWord> *slots,
          std::string *error) {
  for (size_t i = 0; i <= 4096; ++i) {
    if (ap > UINT64_MAX - (i + 1) * 8) return fail(error, "vtable address overflow");
    uint64_t addr = ap + i * 8;
    auto w = m.read_u64(addr);
    if (w.kind == CalibWord::unmapped) break;
    if (w.kind == CalibWord::unresolved) {
      if (looks_typeinfo(m, addr)) break;
    } else if (!w.bits) {
      uint64_t next = 0;
      if (word(m, addr + 8, &next) && next && looks_typeinfo(m, next)) break;
    } else if (!m.is_exec(w.bits)) {
      break;
    }
    if (w.kind == CalibWord::value && !m.is_pointer_word(addr, w.bits))
      return fail(error, "slot word is not relocated: not a pointer");
    slots->push_back(w);
    if (i == 4096) return fail(error, "vtable walk did not terminate");
  }
  return !slots->empty() || fail(error, "empty vtable");
}
std::string hex(uint64_t v) { std::ostringstream s; s << "0x" << std::hex << v; return s.str(); }
std::string quote(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c < 32) {
      const char *digits = "0123456789abcdef";
      out += "\\u00"; out += digits[c >> 4]; out += digits[c & 15];
    } else out += c;
  }
  return out + '"';
}
bool unique_json(const J &j) {
  std::set<std::string> keys;
  for (const auto &[key, value] : j.fields)
    if (!keys.insert(key).second || !unique_json(value)) return false;
  for (const auto &v : j.items) if (!unique_json(v)) return false;
  return true;
}
const J *field(const J &j, const char *key, J::Kind kind) {
  const J *v = j.get(key);
  return v && v->kind == kind ? v : nullptr;
}
}  // namespace

bool load_abi_table(const std::string &path, AbiTable *out, std::string *error) {
  *out = {};
  rs::File file(rs::open_file(path, "rb"));
  std::string text;
  const bool read = rs::file_read_all(file.get(), &text);
  J root;
  if (!read || text.size() > (4u << 20) || !rs::json_lite::Reader(text).parse(&root) ||
      root.kind != J::Object || !unique_json(root)) return fail(error, "invalid ABI table JSON");
  auto schema = field(root, "schema", J::String);
  auto abstract = field(root, "abstract_class", J::String);
  auto anchors = field(root, "anchor_selection", J::String);
  auto version = field(root, "version_name", J::String);
  auto sha = field(root, "header_sha256", J::String);
  auto defines = field(root, "defines", J::Array);
  auto virtuals = field(root, "virtuals", J::Array);
  auto wanted = field(root, "wanted_slots", J::Object);
  auto aliases = field(root, "wanted_slot_aliases", J::Object);
  if (!schema || schema->text != "render-stream-abi-table/1" || !abstract ||
      abstract->text != "RenderingServer" || !anchors ||
      anchors->text != "all-non-pure-new-virtuals" || !version || version->text.empty() ||
      !sha || sha->text.size() != 64 || sha->text.find_first_not_of("0123456789abcdef") != std::string::npos ||
      !defines || !defines->items.empty() || !virtuals || virtuals->items.empty() ||
      !wanted || wanted->fields.empty() || !aliases || aliases->fields.size() != wanted->fields.size())
    return fail(error, "invalid or unsupported ABI table fields");
  AbiTable table;
  table.version_name = version->text;
  table.header_sha256 = sha->text;
  std::set<std::string> names;
  for (const auto &v : virtuals->items) {
    auto name = field(v, "name", J::String);
    auto pure = field(v, "pure", J::Bool);
    auto over = field(v, "override", J::Bool);
    auto dtor = field(v, "destructor", J::Bool);
    auto line = field(v, "line", J::Number);
    int64_t line_number = 0;
    if (!name || name->text.empty() || !pure || !over || !dtor || !line)
      return fail(error, "invalid ABI virtual declaration");
    auto parsed_line = std::from_chars(line->text.data(), line->text.data() + line->text.size(), line_number);
    if (parsed_line.ec != std::errc{} || parsed_line.ptr != line->text.data() + line->text.size() || line_number < 1)
      return fail(error, "invalid ABI virtual line number");
    if (!over->b && !dtor->b) {
      if (!names.insert(name->text).second) return fail(error, "overloaded ABI virtual declaration");
      table.new_virtuals.push_back({name->text, pure->b});
    }
  }
  if (table.new_virtuals.empty() || table.new_virtuals.size() > 4096)
    return fail(error, "implausible ABI virtual count");
  for (const auto &[key, value] : wanted->fields) {
    int64_t index = -1;
    auto result = std::from_chars(value.text.data(), value.text.data() + value.text.size(), index);
    if (key.empty() || value.kind != J::Number || result.ec != std::errc{} ||
        result.ptr != value.text.data() + value.text.size() || index < 0 ||
        static_cast<size_t>(index) >= table.new_virtuals.size() || !table.new_virtuals[index].pure)
      return fail(error, "invalid ABI wanted slot");
    const auto *accepted = field(*aliases, key.c_str(), J::Array);
    std::set<std::string> accepted_names;
    if (!accepted || accepted->items.empty())
      return fail(error, "invalid ABI wanted slot aliases: " + key);
    for (const auto &name : accepted->items) {
      if (name.kind != J::String || name.text.empty() || !accepted_names.insert(name.text).second)
        return fail(error, "invalid ABI wanted slot aliases: " + key);
    }
    const std::string &declaration = table.new_virtuals[index].name;
    if (!accepted_names.count(declaration))
      return fail(error, "ABI wanted slot " + key + " at index " + std::to_string(index) +
                         " names declaration " + declaration + ", outside accepted aliases");
    table.wanted_slots.emplace_back(key, index);
  }
  *out = std::move(table);
  return true;
}

bool derive_calibration(const CalibMemoryReader &m, uint64_t cv, const AbiTable &table,
                        Calibration *out, std::vector<CheckResult> *checks, std::string *error) {
  Calibration result = *out;
  *out = {};
  auto check = [&](const char *name, bool ok, const std::string &detail) {
    checks->push_back({name, ok, detail});
    if (!ok) *error = detail;
    return ok;
  };
  uint64_t cti = 0, ati = 0, top = 1;
  if (!check("derive_typeinfo", cv >= 16 && cv % 8 == 0 && word(m, cv - 16, &top) && !top &&
             word(m, cv - 8, &cti) && name_is(m, cti, "RenderingServerDefault") &&
             word(m, cti + 16, &ati) && name_is(m, ati, "RenderingServer"),
             "Itanium RenderingServerDefault -> RenderingServer typeinfo")) return false;
  auto abstract = primary_tables(m, ati);
  if (!check("derive_abstract_vtable_unique", abstract.size() == 1,
             "primary abstract vtables: " + std::to_string(abstract.size()))) return false;
  const uint64_t av = abstract[0];
  std::vector<CalibWord> a, c;
  if (!walk(m, av, &a, error) || !walk(m, cv, &c, error)) {
    check("derive_slot_pattern", false, *error); return false;
  }
  auto refuse = [&](const std::string &detail) { return check("derive_slot_pattern", false, detail); };
  if (a.size() != c.size()) return refuse("concrete and abstract slot counts differ");
  if (table.new_virtuals.empty() || table.new_virtuals.size() > a.size())
    return refuse("header declares more new virtuals than vtable slots");
  auto executable = [&](CalibWord w) { return w.kind == CalibWord::value && m.is_exec(w.bits); };
  for (auto w : c) if (!executable(w)) return refuse("concrete vtable contains a non-code slot");
  std::set<std::pair<int, uint64_t>> nulls;
  for (auto w : a) if (!executable(w)) nulls.insert({w.kind, w.bits});
  std::string kind = "null";
  uint64_t placeholder = 0;
  if (nulls.size() > 1) return refuse("pure-virtual slots are not uniform");
  if (nulls.empty()) {
    kind = "code";
    std::set<uint64_t> concrete;
    for (auto w : c) concrete.insert(w.bits);
    std::map<uint64_t, size_t> counts;
    for (auto w : a) if (!concrete.count(w.bits)) ++counts[w.bits];
    size_t best = 0, ties = 0;
    for (auto [v, n] : counts) {
      if (n > best) { best = n; placeholder = v; ties = 1; }
      else if (n == best) ++ties;
    }
    if (!best || ties != 1) return refuse("pure-virtual placeholder absent or ambiguous");
  }
  std::vector<bool> implemented;
  for (auto w : a) implemented.push_back(kind == "code" ? w.bits != placeholder : executable(w));
  const size_t prefix = a.size() - table.new_virtuals.size();
  size_t matched = 0;
  for (size_t i = 0; i < table.new_virtuals.size(); ++i)
    if (implemented[prefix + i] == !table.new_virtuals[i].pure) ++matched;
  if (matched != table.new_virtuals.size())
    return refuse("header/binary mask mismatch at prefix " + std::to_string(prefix) + ": " +
                  std::to_string(matched) + "/" + std::to_string(table.new_virtuals.size()) + " matched");
  for (size_t p = 0; p < prefix; ++p) {
    bool match = true;
    for (size_t i = 0; i < table.new_virtuals.size(); ++i)
      if (implemented[p + i] != !table.new_virtuals[i].pure) { match = false; break; }
    if (match) return refuse("prefix is ambiguous");
  }
  if (av < 16 || av - 16 < m.load_bias() || cv - 16 < m.load_bias())
    return refuse("vtable precedes load bias");
  result.schema = "render-stream-calibration/1";
  result.abstract_vtable_vaddr = av - 16 - m.load_bias();
  result.concrete_vtable_vaddr = cv - 16 - m.load_bias();
  result.concrete_class = "RenderingServerDefault";
  result.object_prefix = prefix;
  result.slot_count = a.size();
  result.placeholder_kind = kind;
  if (placeholder && placeholder < m.load_bias()) return refuse("placeholder precedes load bias");
  result.pure_placeholder = placeholder ? placeholder - m.load_bias() : 0;
  result.slots.clear(); result.anchors.clear();
  result.dropped_families.clear(); result.devirtualized_slots.clear();
  for (const auto &[key, index] : table.wanted_slots) {
    if (index < 0 || static_cast<size_t>(index) >= table.new_virtuals.size() ||
        implemented[prefix + index] || (kind == "code" && c[prefix + index].bits == placeholder))
      return refuse("wanted slot is not pure in abstract and implemented in concrete: " + key);
    result.slots.emplace_back(key, prefix + index);
  }
  for (size_t i = 0; i < table.new_virtuals.size(); ++i) if (!table.new_virtuals[i].pure)
    result.anchors.emplace_back(table.new_virtuals[i].name, prefix + i);
  result.anchors_total = result.anchors_matched = result.anchors.size();
  result.calibrator_version = "9";
  check("derive_slot_pattern", true, std::to_string(matched) + "/" + std::to_string(matched) + " matched");
  *out = std::move(result);
  return true;
}

bool CalibFileReader::open(const std::string &path, std::string *error) {
  *this = {};
  path_ = path;
  rs::File file(rs::open_file(path, "rb"));
#ifdef _WIN32
  const auto seek = ::_fseeki64;
  const auto tell = ::_ftelli64;
#else
  const auto seek = ::fseeko;
  const auto tell = ::ftello;
#endif
  if (!file || seek(file.get(), 0, SEEK_END) != 0)
    return fail(error, "cannot read image: " + path);
  const auto size = tell(file.get());
  if (size < 0) return fail(error, "cannot read image: " + path);
  bytes_.resize(static_cast<size_t>(size));
  if (seek(file.get(), 0, SEEK_SET) != 0 ||
      std::fread(bytes_.data(), 1, bytes_.size(), file.get()) != bytes_.size())
    return fail(error, "cannot read image");
  const auto *d = bytes_.data();
  const uint64_t n = bytes_.size();
  if (n < 64) return fail(error, "truncated image");
  pe_ = d[0] == 'M' && d[1] == 'Z';
  auto add = [&](uint64_t addr, uint64_t off, uint64_t size, bool exec, bool ro) {
    if (!range(off, size, n) || addr > UINT64_MAX - size) return false;
    sections_.push_back({addr, off, size, exec, ro}); return true;
  };
  if (pe_) {
    PeHeaders h;
    if (!pe_parse_headers(d, n, &h, error)) return false;
    for (const auto &s : h.sections)
      if (h.image_base > UINT64_MAX - s.va || !range(s.raw_off, s.raw_size, n) ||
          !add(h.image_base + s.va, s.raw_off, std::min(s.vsize, s.raw_size),
               s.characteristics & 0x20000000u,
               !(s.characteristics & (0x80000000u | 0x20000000u))))
        return fail(error, "invalid PE section range");
    const uint64_t opt = le(d + 0x3c, 4) + 24;
    if (!range(opt, 160, n)) return fail(error, "truncated PE directories");
    uint64_t rva = le(d + opt + 152, 4), size = le(d + opt + 156, 4);
    if (h.image_base > UINT64_MAX - rva) return fail(error, "PE relocation address overflow");
    uint64_t cursor = h.image_base + rva;
    if (cursor > UINT64_MAX - size) return fail(error, "PE relocation overflow");
    const uint64_t end = cursor + size;
    auto read32 = [&](uint64_t addr, uint64_t *v) {
      for (const auto &s : sections_) if (addr >= s.addr && range(addr - s.addr, 4, s.size)) {
        *v = le(d + s.offset + addr - s.addr, 4); return true;
      }
      return false;
    };
    while (cursor < end) {
      uint64_t page = 0, block = 0;
      if (!range(cursor, 8, end) || !read32(cursor, &page) || !read32(cursor + 4, &block) ||
          block < 8 || block % 2 || !range(cursor, block, end)) return fail(error, "invalid PE relocation block");
      for (uint64_t j = 8; j < block; j += 2) {
        uint64_t packed = 0;
        bool found = false;
        for (const auto &s : sections_) if (cursor + j >= s.addr && range(cursor + j - s.addr, 2, s.size)) {
          packed = le(d + s.offset + cursor + j - s.addr, 2); found = true; break;
        }
        if (!found) return fail(error, "unmapped PE relocation entry");
        if ((packed >> 12) == 10) {
          if (h.image_base > UINT64_MAX - page - (packed & 4095))
            return fail(error, "PE relocation target overflow");
          dir64_.insert(h.image_base + page + (packed & 4095));
        }
        else if (packed >> 12) return fail(error, "unsupported PE relocation type");
      }
      cursor += block;
    }
    return true;
  }
  if (std::memcmp(d, "\177ELF", 4) || d[4] != 2 || d[5] != 1 || le(d + 18, 2) != 62)
    return fail(error, "not a little-endian x86-64 ELF or PE image");
  const uint64_t type = le(d + 16, 2);
  if (type != 2 && type != 3) return fail(error, "not an ELF executable");
  pie_ = type == 3;
  const uint64_t shoff = le(d + 40, 8), entsize = le(d + 58, 2), count = le(d + 60, 2);
  const uint64_t strings = le(d + 62, 2);
  if (entsize < 64 || !count || strings >= count || !range(shoff, count * entsize, n))
    return fail(error, "invalid ELF sections");
  const uint8_t *str = d + shoff + strings * entsize;
  const uint64_t stroff = le(str + 24, 8), strsize = le(str + 32, 8);
  if (!range(stroff, strsize, n)) return fail(error, "invalid ELF section names");
  for (uint64_t i = 0; i < count; ++i) {
    const uint8_t *s = d + shoff + i * entsize;
    const uint64_t kind = le(s + 4, 4), flags = le(s + 8, 8), addr = le(s + 16, 8);
    const uint64_t off = le(s + 24, 8), size = le(s + 32, 8), nameoff = le(s, 4);
    if (nameoff >= strsize) return fail(error, "invalid ELF section name");
    const char *name = reinterpret_cast<const char *>(d + stroff + nameoff);
    if (!std::memchr(name, 0, strsize - nameoff)) return fail(error, "unterminated ELF section name");
    if (kind != 8 && !range(off, size, n)) return fail(error, "invalid ELF section range");
    if ((flags & 2) && kind != 8) {
      const bool ro = !(flags & 4) && kind != 4 && (!(flags & 1) || std::string(name) == ".data.rel.ro");
      if (!add(addr, off, size, flags & 4, ro)) return fail(error, "invalid ELF address range");
    }
    if (kind == 4) {
      const uint64_t step = le(s + 56, 8);
      if (step < 24 || size % step) return fail(error, "invalid ELF RELA section");
      for (uint64_t j = 0; j < size; j += step) {
        const uint8_t *r = d + off + j;
        const uint64_t target = le(r, 8), rt = le(r + 8, 8) & 0xffffffff;
        if (rt == 8) relocations_[target] = {CalibWord::value, le(r + 16, 8)};
        else if (rt == 1) relocations_[target] = {CalibWord::unresolved, 0};
      }
    }
    if (kind == 7) {
      uint64_t j = 0;
      while (range(j, 12, size)) {
        uint64_t namesz = le(d + off + j, 4), descsz = le(d + off + j + 4, 4);
        uint64_t desc = j + 12 + ((namesz + 3) & ~uint64_t(3));
        if (!range(j + 12, namesz, size) || !range(desc, descsz, size)) return fail(error, "invalid ELF note");
        if (le(d + off + j + 8, 4) == 3 && namesz == 4 && !std::memcmp(d + off + j + 12, "GNU\0", 4)) {
          static const char *digits = "0123456789abcdef";
          build_id_.clear();
          for (uint64_t k = 0; k < descsz; ++k) {
            auto c = d[off + desc + k]; build_id_ += digits[c >> 4]; build_id_ += digits[c & 15];
          }
        }
        j = desc + ((descsz + 3) & ~uint64_t(3));
      }
    }
  }
  return true;
}

CalibWord CalibFileReader::read_u64(uint64_t addr) const {
  for (const auto &s : sections_) if (addr >= s.addr && range(addr - s.addr, 8, s.size)) {
    auto r = relocations_.find(addr);
    if (r != relocations_.end()) return r->second;
    return {CalibWord::value, le(bytes_.data() + s.offset + addr - s.addr, 8)};
  }
  return {};
}
bool CalibFileReader::is_exec(uint64_t addr) const {
  for (const auto &s : sections_) if (s.exec && addr >= s.addr && addr - s.addr < s.size) return true;
  return false;
}
std::vector<std::pair<uint64_t, uint64_t>> CalibFileReader::readonly_ranges() const {
  std::vector<std::pair<uint64_t, uint64_t>> out;
  for (const auto &s : sections_) if (s.readonly) out.emplace_back(s.addr, s.addr + s.size);
  return out;
}
bool CalibFileReader::is_pointer_word(uint64_t addr, uint64_t bits) const {
  return !pe_ || !bits || dir64_.count(addr);
}
bool CalibFileReader::concrete_vptr(uint64_t *out, std::string *error) const {
  std::set<uint64_t> typeinfos;
  // Bootstrap without any recorded addresses: scan name pointers, then RTTI references.
  for (auto [lo, hi] : readonly_ranges()) {
    for (uint64_t addr = (lo + 7) & ~uint64_t(7); range(addr, 16, hi); addr += 8)
      if (name_is(*this, addr, "RenderingServerDefault")) typeinfos.insert(addr);
  }
  if (typeinfos.size() != 1) return fail(error, "concrete typeinfo is not unique (or MSVC RTTI)");
  auto tables = primary_tables(*this, *typeinfos.begin());
  if (tables.size() != 1) return fail(error, "concrete primary vtable is not unique");
  *out = tables[0]; return true;
}
bool CalibFileReader::engine_identity(const std::string &version_name, const std::string &flavor,
                                     Calibration *out, std::string *error) const {
  Calibration c;
  std::set<std::string> versions;
  const std::string prefix = version_name + " v";
  for (const auto &s : sections_) {
    const char *start = reinterpret_cast<const char *>(bytes_.data() + s.offset);
    std::string_view data(start, s.size);
    size_t pos = 0;
    while ((pos = data.find(prefix, pos)) != std::string_view::npos) {
      size_t end = data.find('\0', pos);
      if (end != std::string_view::npos && end > pos + prefix.size() && end <= pos + prefix.size() + 81 &&
          data[pos + prefix.size()] >= '0' && data[pos + prefix.size()] <= '9') {
        bool ascii = true;
        for (size_t j = pos; j < end; ++j) if (data[j] < 32 || data[j] > 126) ascii = false;
        if (ascii) versions.emplace(data.substr(pos, end - pos));
      }
      ++pos;
    }
  }
  if (versions.size() != 1) return fail(error, "expected exactly one engine version string");
  c.version_string = *versions.begin();
  c.flavor = flavor;
  c.sha256 = sha256_hex(bytes_.data(), bytes_.size());
  c.build_id = build_id_; c.build_id_present = !build_id_.empty(); c.pie = pie_;
  c.platform = pe_ ? "windows-x86_64" : "linux-x86_64";
  if (pe_) {
    PeHeaders h;
    if (!pe_parse_headers(bytes_.data(), bytes_.size(), &h, error)) return false;
    c.time_date_stamp = h.time_date_stamp; c.size_of_image = h.size_of_image;
    c.image_base = h.image_base; c.dynamic_base = h.dll_characteristics & 0x40;
    if (!pe_read_codeview_id(bytes_.data(), bytes_.size(), h, false, &c.codeview_id, error)) return false;
    c.codeview_id_present = !c.codeview_id.empty();
    uint64_t bytes = 0, base = 0;
    if (!pe_image_sha256(path_, &c.image_sha256, &bytes, &base, error)) return false;
  }
  *out = std::move(c); return true;
}

std::string serialize_derived_calibration(const Calibration &c, const AbiTable &table) {
  std::ostringstream s;
  auto str = [&](const char *key, const std::string &v) { s << "    " << quote(key) << ": " << quote(v) << ",\n"; };
  auto boolean = [&](bool v) { return v ? "true" : "false"; };
  s << "{\n  \"schema\": \"render-stream-calibration/1\",\n  \"engine\": {\n";
  str("version_string", c.version_string);
  const bool pe = c.platform == "windows-x86_64";
  if (!pe) s << "    \"build_id\": " << (c.build_id_present ? quote(c.build_id) : "null") << ",\n";
  str("sha256", c.sha256);
  if (pe) {
    str("image_sha256", c.image_sha256);
    s << "    \"codeview_id\": " << (c.codeview_id_present ? quote(c.codeview_id) : "null") << ",\n"
      << "    \"time_date_stamp\": " << c.time_date_stamp << ",\n"
      << "    \"size_of_image\": " << c.size_of_image << ",\n";
    str("image_base", hex(c.image_base));
    s << "    \"dynamic_base\": " << boolean(c.dynamic_base) << ",\n";
  }
  str("platform", c.platform);
  s << "    \"flavor\": " << quote(c.flavor);
  if (!pe) s << ",\n    \"pie\": " << boolean(c.pie);
  s << "\n  },\n  \"rendering_server\": {\n";
  str("abstract_vtable_vaddr", hex(c.abstract_vtable_vaddr));
  str("concrete_class", c.concrete_class);
  str("concrete_vtable_vaddr", hex(c.concrete_vtable_vaddr));
  s << "    \"object_prefix\": " << c.object_prefix << ",\n"
    << "    \"slot_count\": " << c.slot_count << ",\n"
    << "    \"anchors_total\": " << c.anchors_total << ",\n"
    << "    \"anchors_matched\": " << c.anchors_matched;
  if (pe || c.placeholder_kind == "code")
    s << ",\n    \"placeholder_kind\": " << quote(c.placeholder_kind)
      << ",\n    \"pure_placeholder\": " << (c.pure_placeholder ? quote(hex(c.pure_placeholder)) : "null");
  s << "\n  },\n";
  auto map = [&](const char *key, const auto &entries) {
    s << "  " << quote(key) << ": {";
    for (size_t i = 0; i < entries.size(); ++i)
      s << (i ? ",\n" : "\n") << "    " << quote(entries[i].first) << ": " << entries[i].second;
    s << "\n  },\n";
  };
  map("slots", c.slots); map("anchors", c.anchors);
  if (pe) s << "  \"devirtualized_slots\": [],\n  \"dropped_families\": [],\n";
  s << "  \"calibrator\": {\n    \"version\": \"9\",\n    \"header_sha256\": " << quote(table.header_sha256) << "\n  }\n}\n";
  return s.str();
}
}  // namespace grc
