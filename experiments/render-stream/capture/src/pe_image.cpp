#define _FILE_OFFSET_BITS 64
#include "pe_image.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <memory>

#include "rs_platform.h"
#include "rs_sha256.h"

namespace grc {
namespace {
bool range(uint64_t off, uint64_t size, size_t n) { return off <= n && size <= n - off; }
uint16_t u16(const uint8_t *p) { return p[0] | (uint16_t(p[1]) << 8); }
uint32_t u32(const uint8_t *p) { return u16(p) | (uint32_t(u16(p + 2)) << 16); }
uint64_t u64(const uint8_t *p) { return u32(p) | (uint64_t(u32(p + 4)) << 32); }
size_t rva_offset(uint32_t va, uint32_t size, const PeHeaders &h, bool mapped, size_t n) {
  if (mapped || (va < h.size_of_headers && uint64_t(va) + size <= h.size_of_headers)) {
    return range(va, size, n) ? va : n;
  }
  for (const auto &s : h.sections) {
    if (va >= s.va && uint64_t(va - s.va) + size <= s.raw_size) {
      const uint64_t off = uint64_t(s.raw_off) + va - s.va;
      if (range(off, size, n)) return static_cast<size_t>(off);
    }
  }
  return n;
}
}  // namespace

bool pe_parse_headers(const uint8_t *p, size_t n, PeHeaders *out, std::string *error) {
  *out = PeHeaders{};
  auto fail = [&](const char *message) { *error = message; return false; };
  if (!range(0, 64, n) || std::memcmp(p, "MZ", 2)) return fail("not an MZ file");
  const uint64_t pe = u32(p + 0x3c);
  if (!range(pe, 24, n) || std::memcmp(p + pe, "PE\0\0", 4)) return fail("invalid PE signature or e_lfanew");
  if (u16(p + pe + 4) != 0x8664) return fail("PE Machine is not x86-64");
  const uint16_t count = u16(p + pe + 6), opt_size = u16(p + pe + 20);
  const uint64_t opt = pe + 24;
  if (!range(opt, opt_size, n) || opt_size < 112 || u16(p + opt) != 0x20b)
    return fail("PE optional-header Magic is not PE32+ (0x20b)");
  if (opt_size < 168 || u32(p + opt + 108) < 7) return fail("PE NumberOfRvaAndSizes must be at least 7");
  if (!range(opt + opt_size, uint64_t(count) * 40, n)) return fail("truncated PE section table");
  PeHeaders h;
  h.image_base = u64(p + opt + 24);
  h.time_date_stamp = u32(p + pe + 8);
  h.size_of_image = u32(p + opt + 56);
  h.size_of_headers = u32(p + opt + 60);
  h.dll_characteristics = u16(p + opt + 70);
  h.debug_rva = u32(p + opt + 160);
  h.debug_size = u32(p + opt + 164);
  for (uint16_t i = 0; i < count; ++i) {
    const auto *s = p + opt + opt_size + uint64_t(i) * 40;
    size_t length = 8;
    while (length && s[length - 1] == 0) --length;
    // COFF long names cannot name .rdata; preserve their table spelling.
    h.sections.push_back({std::string(reinterpret_cast<const char *>(s), length),
      u32(s + 12), u32(s + 8), u32(s + 20), u32(s + 16), u32(s + 36)});
  }
  *out = std::move(h);
  return true;
}

bool pe_read_codeview_id(const uint8_t *p, size_t n, const PeHeaders &h, bool mapped,
                         std::string *id, std::string *error) {
  id->clear();
  auto fail = [&](const char *message) { *error = message; return false; };
  if (!h.debug_rva || !h.debug_size) return true;
  if (h.debug_size % 28) return fail("invalid PE debug directory size");
  const size_t off = rva_offset(h.debug_rva, h.debug_size, h, mapped, n);
  if (!range(off, h.debug_size, n)) return fail("unmapped PE debug directory");
  std::string found;
  std::vector<uint8_t> payload;
  for (size_t i = 0; i < h.debug_size; i += 28) {
    const auto *entry = p + off + i;
    if (u32(entry + 12) != 2) continue;
    const uint32_t size = u32(entry + 16);
    const size_t raw = mapped ? rva_offset(u32(entry + 20), size, h, true, n) : u32(entry + 24);
    if (!range(raw, size, n)) return fail("PE CodeView range past image");
    if (size < 4 || std::memcmp(p + raw, "RSDS", 4)) continue;
    if (size < 24) return fail("truncated RSDS entry");
    std::vector<uint8_t> current(p + raw, p + raw + size);
    if (!payload.empty() && payload != current) return fail("conflicting RSDS entries");
    payload = std::move(current);
    static constexpr char hex[] = "0123456789abcdef";
    found.clear();
    for (size_t b = 4; b < 20; ++b) {
      found += hex[p[raw + b] >> 4];
      found += hex[p[raw + b] & 15];
    }
    found += ":" + std::to_string(u32(p + raw + 20));
  }
  *id = std::move(found);
  return true;
}

std::string pe_codeview_id(const uint8_t *p, size_t n, const PeHeaders &h, bool mapped) {
  std::string id, error;
  pe_read_codeview_id(p, n, h, mapped, &id, &error);
  return id;
}

bool pe_image_sha256(const std::string &path, std::string *hex, uint64_t *bytes,
                     uint64_t *preferred_image_base, std::string *error) {
  hex->clear(); *bytes = 0; *preferred_image_base = 0;
  struct Close { void operator()(FILE *p) const { std::fclose(p); } };
  std::unique_ptr<FILE, Close> file(rs::open_file(path, "rb"));
  auto fail = [&](const char *message) { *error = message; return false; };
  if (!file) return fail("cannot open PE file");
  // DOS and COFF fields bound the header read, independently of file length.
  uint8_t dos[64], coff[24];
  if (std::fread(dos, 1, sizeof(dos), file.get()) != sizeof(dos) || std::memcmp(dos, "MZ", 2))
    return fail("not an MZ file");
  const uint32_t pe = u32(dos + 0x3c);
  if (::fseeko(file.get(), pe, SEEK_SET) || std::fread(coff, 1, sizeof(coff), file.get()) != sizeof(coff))
    return fail("truncated PE header");
  const uint64_t length = uint64_t(pe) + 24 + u16(coff + 20) + uint64_t(u16(coff + 6)) * 40;
  if (length > (16u << 20)) return fail("implausible PE header size");
  std::vector<uint8_t> header(static_cast<size_t>(length));
  std::rewind(file.get());
  if (std::fread(header.data(), 1, header.size(), file.get()) != header.size()) return fail("truncated PE headers");
  PeHeaders h;
  if (!pe_parse_headers(header.data(), header.size(), &h, error)) return false;
  // Long COFF section names live in the file's string table, outside mapped headers.
  for (auto &section : h.sections) {
    if (section.name.empty() || section.name[0] != '/') continue;
    const uint64_t table = uint64_t(u32(coff + 12)) + uint64_t(u32(coff + 16)) * 18;
    if (!u32(coff + 12) || section.name.size() == 1 ||
        section.name.find_first_not_of("0123456789", 1) != std::string::npos ||
        table > uint64_t(std::numeric_limits<int64_t>::max()) ||
        ::fseeko(file.get(), static_cast<int64_t>(table), SEEK_SET)) return fail("invalid COFF long section name");
    uint8_t size_bytes[4];
    if (std::fread(size_bytes, 1, 4, file.get()) != 4) return fail("truncated COFF string table");
    const uint32_t size = u32(size_bytes);
    const uint64_t index = std::strtoull(section.name.c_str() + 1, nullptr, 10);
    if (index < 4 || index >= size || table + index > uint64_t(std::numeric_limits<int64_t>::max()) ||
        ::fseeko(file.get(), static_cast<int64_t>(table + index), SEEK_SET)) return fail("invalid COFF string table offset");
    section.name.clear();
    bool terminated = false;
    for (uint64_t i = index; i < size; ++i) {
      const int c = std::fgetc(file.get());
      if (c == EOF) return fail("truncated COFF string table");
      if (!c) { terminated = true; break; }
      section.name += static_cast<char>(c);
    }
    if (!terminated) return fail("invalid COFF string table offset");
  }
  bool executable = false, rdata = false;
  for (const auto &s : h.sections) {
    executable |= bool(s.characteristics & 0x20000000);
    rdata |= s.name == ".rdata";
  }
  if (!executable || !rdata) return fail("PE image hash requires executable sections and .rdata");
  // Validate every raw range as the offline reader does, including excluded sections.
  if (::fseeko(file.get(), 0, SEEK_END)) return fail("cannot seek PE file");
  const auto end = ::ftello(file.get());
  if (end < 0 || h.size_of_headers > uint64_t(end)) return fail("PE range past EOF");
  for (const auto &s : h.sections)
    if (s.raw_size && !range(s.raw_off, s.raw_size, static_cast<size_t>(end))) return fail("PE range past EOF");
  Sha256 digest;
  uint64_t total = 0;
  std::vector<uint8_t> buffer(1u << 20);
  auto hash = [&](uint32_t off, uint32_t size) {
    if (::fseeko(file.get(), off, SEEK_SET)) return false;
    uint64_t remaining = size;
    while (remaining) {
      const size_t chunk = std::min<uint64_t>(remaining, buffer.size());
      if (std::fread(buffer.data(), 1, chunk, file.get()) != chunk) return false;
      digest.update(buffer.data(), chunk);
      remaining -= chunk;
    }
    total += size;
    return true;
  };
  if (!hash(0, h.size_of_headers)) return fail("cannot read PE headers");
  for (const auto &s : h.sections)
    if ((s.characteristics & 0x20000000 || s.name == ".rdata") && !hash(s.raw_off, s.raw_size))
      return fail("cannot read PE section");
  *hex = sha256_hex(digest.finish()); *bytes = total; *preferred_image_base = h.image_base;
  return true;
}
}  // namespace grc
