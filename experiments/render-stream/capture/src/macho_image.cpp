#include "macho_image.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>

#include "rs_file.h"
#include "rs_sha256.h"

namespace grc {
namespace {
bool range(uint64_t off, uint64_t length, uint64_t end) {
  return off <= end && length <= end - off;
}
uint64_t le(const uint8_t *p, unsigned n) {
  uint64_t v = 0;
  for (unsigned i = 0; i < n; ++i) v |= uint64_t(p[i]) << (8 * i);
  return v;
}
uint64_t be(const uint8_t *p, unsigned n) {
  uint64_t v = 0;
  for (unsigned i = 0; i < n; ++i) v = (v << 8) | p[i];
  return v;
}
std::string name16(const uint8_t *p) {
  size_t n = 0;
  while (n < 16 && p[n]) ++n;
  return {reinterpret_cast<const char *>(p), n};
}
void require(bool ok, const char *message) {
  if (!ok) throw std::runtime_error(message);
}
class View {
 public:
  const uint8_t *p;
  uint64_t size;
  uint64_t get(uint64_t off, unsigned n) const {
    require(range(off, n, size), "Mach-O range past slice EOF");
    return le(p + off, n);
  }
  std::string string(uint64_t off, uint64_t end) const {
    require(off < end && end <= size, "invalid Mach-O string range");
    const auto *stop = static_cast<const uint8_t *>(std::memchr(p + off, 0, end - off));
    require(stop != nullptr, "unterminated Mach-O string");
    return {reinterpret_cast<const char *>(p + off), static_cast<size_t>(stop - p - off)};
  }
};
}  // namespace

bool macho_parse_headers(const uint8_t *data, size_t size, uint32_t cpu,
                         MachoHeaders *out, std::string *error, bool mapped) {
  *out = {};
  try {
    require(data && size >= 32, "truncated Mach-O header");
    MachoHeaders h;
    h.slice_size = size;
    uint32_t fat_cpu = 0, fat_subtype = 0;
    const auto magic = be(data, 4);
    if (magic == 0xcafebabe || magic == 0xcafebabf) {
      require(!mapped && cpu, "universal Mach-O requires a CPU selection");
      const uint64_t count = be(data + 4, 4), stride = magic == 0xcafebabf ? 32 : 20;
      require(count && range(8, count * stride, size), "truncated Mach-O fat architecture table");
      size_t matches = 0;
      for (uint64_t i = 0; i < count; ++i) {
        const auto *a = data + 8 + i * stride;
        const uint64_t off = be(a + 8, stride == 32 ? 8 : 4);
        const uint64_t length = be(a + (stride == 32 ? 16 : 12), stride == 32 ? 8 : 4);
        require(off >= 8 + count * stride && length && range(off, length, size),
                "Mach-O slice range past EOF or inside fat header");
        if (be(a, 4) == cpu) {
          ++matches; h.slice_offset = off; h.slice_size = length;
          fat_cpu = be(a, 4); fat_subtype = be(a + 4, 4);
        }
      }
      require(matches == 1, "Mach-O CPU slice is absent or ambiguous");
    }
    const View v{data + h.slice_offset, h.slice_size};
    require(v.get(0, 4) == 0xfeedfacf, "requires a 64-bit little-endian Mach-O slice");
    h.cputype = v.get(4, 4); h.cpusubtype = v.get(8, 4);
    require((h.cputype == macho_arm64 || h.cputype == macho_x86_64) && (!cpu || cpu == h.cputype),
            "Mach-O cputype mismatch or unsupported CPU");
    require((h.cpusubtype & 0xffffff) == (h.cputype == macho_arm64 ? 0u : 3u),
            "unsupported Mach-O cpusubtype");
    require(!h.slice_offset || (h.cputype == fat_cpu && h.cpusubtype == fat_subtype),
            "fat and thin Mach-O CPU identity disagree");
    const uint64_t count = v.get(16, 4), bytes = v.get(20, 4), end = 32 + bytes;
    require(range(32, bytes, v.size) && count <= bytes / 8, "truncated Mach-O load commands");
    h.pie = v.get(24, 4) & 0x200000;
    uint64_t pos = 32;
    bool have_dyld = false, have_chained = false;
    size_t bases = 0;
    for (uint64_t i = 0; i < count; ++i) {
      require(range(pos, 8, end), "truncated Mach-O load command");
      const uint64_t cmd = v.get(pos, 4), length = v.get(pos + 4, 4);
      require(length >= 8 && length % 8 == 0 && range(pos, length, end),
              "invalid Mach-O load command size");
      if (cmd == 0x19) {
        require(length >= 72, "truncated LC_SEGMENT_64");
        MachoSegment s;
        s.name = name16(v.p + pos + 8);
        s.addr = v.get(pos + 24, 8); s.size = v.get(pos + 32, 8);
        s.offset = v.get(pos + 40, 8); s.file_size = v.get(pos + 48, 8);
        s.protection = v.get(pos + 60, 4); s.flags = v.get(pos + 68, 4);
        require(s.size <= UINT64_MAX - s.addr && s.file_size <= s.size &&
                (mapped || range(s.offset, s.file_size, v.size)), "invalid Mach-O segment extent");
        const uint64_t ns = v.get(pos + 64, 4);
        require(ns <= (length - 72) / 80, "truncated Mach-O section table");
        h.segments.push_back(s);
        if (!s.offset && s.file_size) { ++bases; h.image_base = s.addr; }
        for (uint64_t j = 0; j < ns; ++j) {
          const uint64_t at = pos + 72 + 80 * j;
          MachoSection section;
          section.name = name16(v.p + at + 16) + "," + name16(v.p + at);
          section.addr = v.get(at + 32, 8); section.size = v.get(at + 40, 8);
          section.offset = v.get(at + 48, 4); section.flags = v.get(at + 64, 4);
          const auto kind = section.flags & 255;
          if (kind == 1 || kind == 0xc || kind == 0x12) continue;
          require(section.addr >= s.addr && range(section.addr - s.addr, section.size, s.file_size) &&
                  section.offset == s.offset + section.addr - s.addr &&
                  (mapped || range(section.offset, section.size, v.size)),
                  "Mach-O section outside its file-backed segment");
          h.sections.push_back(section);
        }
      } else if (cmd == 0x1b) {
        require(length == 24 && h.uuid.empty(), "invalid or duplicate LC_UUID");
        static const char *digits = "0123456789abcdef";
        for (size_t j = 0; j < 16; ++j) {
          const auto b = v.p[pos + 8 + j]; h.uuid += digits[b >> 4]; h.uuid += digits[b & 15];
        }
      } else if (cmd == 0x22 || cmd == 0x80000022) {
        require(length == 48 && !have_dyld, "invalid or duplicate LC_DYLD_INFO");
        have_dyld = true;
        for (size_t j = 0; j < 10; ++j) h.dyld_info[j] = v.get(pos + 8 + j * 4, 4);
      } else if (cmd == 0x80000034) {
        require(length == 16 && !have_chained, "invalid or duplicate LC_DYLD_CHAINED_FIXUPS");
        have_chained = true;
        h.chained_offset = v.get(pos + 8, 4); h.chained_size = v.get(pos + 12, 4);
      }
      pos += length;
    }
    require(pos == end && !h.uuid.empty() && bases == 1,
            "Mach-O requires complete load commands, LC_UUID and one image-base segment");
    require(std::any_of(h.sections.begin(), h.sections.end(), [](const auto &s) {
      return s.size && (s.flags & 0x80000400);
    }), "Mach-O requires executable sections");
    if (!mapped) {
      for (size_t i = 0; i < 10; i += 2)
        require(range(h.dyld_info[i], h.dyld_info[i + 1], v.size), "dyld info outside slice");
      require(range(h.chained_offset, h.chained_size, v.size), "chained fixups outside slice");
    }
    *out = std::move(h); return true;
  } catch (const std::runtime_error &e) { *error = e.what(); return false; }
}

bool macho_read_fixups(const uint8_t *slice, size_t size, const MachoHeaders &h,
                       std::map<uint64_t, MachoFixup> *out, std::string *error) {
  out->clear();
  try {
    const View v{slice, size};
    std::map<uint64_t, MachoFixup> result;
    auto stream = [&](uint64_t off, uint64_t length, bool bind) {
      require(range(off, length, size), "dyld stream outside slice");
      const uint64_t end = off + length;
      uint64_t segment = UINT64_MAX, cursor = 0, addend = 0, type = 1;
      std::string symbol;
      auto leb = [&](bool sign = false) {
        uint64_t value = 0; unsigned shift = 0;
        for (;;) {
          require(off < end && shift < 70, "invalid Mach-O LEB128");
          const auto b = v.get(off++, 1);
          require(shift != 63 || (b & 0x7f) <= 1 || (sign && (b & 0x7f) == 0x7f),
                  "Mach-O LEB128 overflow");
          value |= (b & 0x7f) << shift;
          shift += 7;
          if (!(b & 0x80)) {
            if (sign && (b & 0x40) && shift < 64) value |= UINT64_MAX << shift;
            return value;
          }
        }
      };
      auto emit = [&]() {
        require(segment < h.segments.size() && type == 1, "unsupported dyld pointer type or segment");
        const auto &s = h.segments[segment];
        require(range(cursor, 8, s.file_size), "dyld pointer outside file-backed segment");
        require(!bind || !symbol.empty(), "missing dyld bind symbol");
        result[s.addr + cursor] = {bind ? 0 : v.get(s.offset + cursor, 8),
                                   bind ? symbol : "", static_cast<int64_t>(addend)};
        cursor += 8;
      };
      auto repeat = [&](uint64_t count, uint64_t skip) {
        // Every emit consumes a distinct file word unless a wrapped skip is explicitly encoded.
        require(count <= size / 8, "excessive dyld repeat count");
        for (uint64_t j = 0; j < count; ++j) { emit(); cursor += skip; }
      };
      while (off < end) {
        const auto byte = v.get(off++, 1), op = byte & 0xf0, imm = byte & 15;
        if (!op) {
          if (!bind) break;
          segment = UINT64_MAX; cursor = addend = 0; type = 1; symbol.clear();
        } else if (bind && (op == 0x10 || op == 0x30)) {
          // Dylib ordinal is irrelevant to the symbol identity.
        } else if (bind && op == 0x20) { leb();
        } else if (bind && op == 0x40) { symbol = v.string(off, end); off += symbol.size() + 1;
        } else if (bind && op == 0x60) { addend = leb(true);
        } else if (op == (bind ? 0x50u : 0x10u)) { type = imm;
        } else if (op == (bind ? 0x70u : 0x20u)) { segment = imm; cursor = leb();
        } else if (op == (bind ? 0x80u : 0x30u)) { cursor += leb();
        } else if (!bind && op == 0x40) { cursor += imm * 8;
        } else if (!bind && (op == 0x50 || op == 0x60)) { repeat(op == 0x50 ? imm : leb(), 0);
        } else if (op == (bind ? 0x90u : 0x70u)) { emit(); if (!bind) cursor += leb();
        } else if (bind && op == 0xa0) { const auto skip = leb(); emit(); cursor += skip;
        } else if (bind && op == 0xb0) { emit(); cursor += imm * 8;
        } else if (op == (bind ? 0xc0u : 0x80u)) {
          const auto count = leb(), skip = leb(); repeat(count, skip);
        } else { require(false, "unsupported dyld opcode"); }
      }
    };
    stream(h.dyld_info[0], h.dyld_info[1], false);
    for (size_t i = 2; i < 8; i += 2) stream(h.dyld_info[i], h.dyld_info[i + 1], true);
    if (h.chained_size) {
      const uint64_t off = h.chained_offset, length = h.chained_size, end = off + length;
      require(range(off, length, size), "chained fixups outside slice");
      auto get = [&](uint64_t at, unsigned n) {
        require(at >= off && range(at, n, end), "chained metadata outside command range");
        return v.get(at, n);
      };
      require(get(off, 4) == 0 && get(off + 24, 4) == 0, "unsupported chained fixups version/compression");
      const uint64_t starts = off + get(off + 4, 4), imports = off + get(off + 8, 4);
      const uint64_t symbols = off + get(off + 12, 4), count = get(off + 16, 4), fmt = get(off + 20, 4);
      require(fmt >= 1 && fmt <= 3, "unsupported chained import format");
      const uint64_t stride = fmt == 1 ? 4 : fmt == 2 ? 8 : 16;
      require(range(imports, count * stride, end), "truncated chained imports");
      std::vector<MachoFixup> names;
      for (uint64_t i = 0; i < count; ++i) {
        const auto at = imports + i * stride, packed = get(at, fmt == 3 ? 8 : 4);
        const auto nameoff = packed >> (fmt == 3 ? 32 : 9);
        require(symbols <= end && nameoff < end - symbols, "invalid chained import name offset");
        int64_t addend = 0;
        if (fmt == 2) addend = static_cast<int32_t>(get(at + 4, 4));
        if (fmt == 3) addend = static_cast<int64_t>(get(at + 8, 8));
        names.push_back({0, v.string(symbols + nameoff, end), addend});
      }
      const auto nseg = get(starts, 4);
      require(nseg <= h.segments.size(), "chained segment count exceeds load commands");
      for (uint64_t i = 0; i < nseg; ++i) {
        const auto relative = get(starts + 4 + i * 4, 4);
        if (!relative) continue;
        const auto pos = starts + relative, bytes = get(pos, 4), page_size = get(pos + 4, 2);
        const auto format = get(pos + 6, 2), segment_offset = get(pos + 8, 8), pages = get(pos + 20, 2);
        require((format == 2 || format == 6) && page_size && bytes >= 22 + pages * 2 && range(pos, bytes, end),
                "unsupported or invalid chained starts-in-segment");
        const auto &s = h.segments[i];
        require(segment_offset <= UINT64_MAX - h.image_base && h.image_base + segment_offset == s.addr,
                "chained segment offset disagrees with load command");
        for (uint64_t page = 0; page < pages; ++page) {
          const auto start = get(pos + 22 + page * 2, 2);
          if (start == 0xffff) continue;
          std::vector<uint64_t> list{start};
          if (start & 0x8000) {
            list.clear(); uint64_t index = start & 0x7fff;
            for (;;) {
              require(range(22 + index * 2, 2, bytes), "chained multi-start outside metadata");
              const auto entry = get(pos + 22 + index++ * 2, 2);
              list.push_back(entry & 0x7fff);
              if (entry & 0x8000) break;
            }
          }
          for (const auto first : list) {
            uint64_t cursor = page * page_size + first;
            for (;;) {
              require(first < page_size && range(cursor, 8, std::min((page + 1) * page_size, s.file_size)),
                      "chained pointer outside page or segment");
              const auto raw = v.get(s.offset + cursor, 8), addr = s.addr + cursor;
              require(!result.count(addr), "duplicate chained pointer");
              MachoFixup fixup;
              if (raw >> 63) {
                const auto ordinal = raw & 0xffffff;
                require(ordinal < names.size(), "invalid chained bind ordinal");
                fixup = names[ordinal];
                const int64_t extra = static_cast<int8_t>((raw >> 24) & 255);
                require((extra >= 0 && fixup.addend <= INT64_MAX - extra) ||
                        (extra < 0 && fixup.addend >= INT64_MIN - extra), "chained bind addend overflow");
                fixup.addend += extra;
              } else {
                fixup.value = (raw & ((uint64_t(1) << 36) - 1)) | (((raw >> 36) & 255) << 56);
                require(format != 6 || fixup.value <= UINT64_MAX - h.image_base, "chained rebase overflow");
                if (format == 6) fixup.value += h.image_base;
              }
              result.emplace(addr, std::move(fixup));
              const auto delta = (raw >> 51) & 0xfff;
              if (!delta) break;
              cursor += delta * 4;
            }
          }
        }
      }
    }
    *out = std::move(result); return true;
  } catch (const std::runtime_error &e) { *error = e.what(); return false; }
}

bool macho_file_identity(const std::string &path, uint32_t cpu, MachoHeaders *out,
                         std::string *sha256, std::string *error) {
  *out = {}; sha256->clear();
#ifdef _WIN32
  const auto seek = ::_fseeki64;
  const auto tell = ::_ftelli64;
#else
  const auto seek = ::fseeko;
  const auto tell = ::ftello;
#endif
  rs::File file(rs::open_file(path, "rb"));
  if (!file) { *error = "cannot open Mach-O executable"; return false; }
  // Only the header prefix is retained; the slice hash streams through the hardware-dispatched SHA256.
  std::vector<uint8_t> prefix(4096);
  prefix.resize(std::fread(prefix.data(), 1, prefix.size(), file.get()));
  if (std::ferror(file.get())) { *error = "cannot read Mach-O executable"; return false; }
  // Fat selection and file-backed ranges need the whole file size, but never its contents in memory.
  if (seek(file.get(), 0, SEEK_END)) { *error = "cannot seek Mach-O executable"; return false; }
  const auto length = tell(file.get());
  if (length < 32) { *error = "truncated Mach-O executable"; return false; }
  // Parse headers through a bounded file view. File validation is performed below against the true extent.
  uint64_t slice_off = 0, slice_size = length;
  uint32_t fat_subtype = 0;
  bool fat = false;
  if (prefix.size() >= 8 && (be(prefix.data(), 4) == 0xcafebabe || be(prefix.data(), 4) == 0xcafebabf)) {
    fat = true;
    const uint64_t count = be(prefix.data() + 4, 4), stride = be(prefix.data(), 4) == 0xcafebabf ? 32 : 20;
    if (!cpu || count > (uint64_t(length) - 8) / stride) {
      *error = "invalid Mach-O fat architecture table"; return false;
    }
    prefix.resize(8 + count * stride);
    if (seek(file.get(), 0, SEEK_SET) || std::fread(prefix.data(), 1, prefix.size(), file.get()) != prefix.size()) {
      *error = "cannot read Mach-O fat table"; return false;
    }
    size_t matches = 0;
    for (uint64_t i = 0; i < count; ++i) {
      const auto *a = prefix.data() + 8 + i * stride;
      const auto off = be(a + 8, stride == 32 ? 8 : 4);
      const auto size = be(a + (stride == 32 ? 16 : 12), stride == 32 ? 8 : 4);
      if (off < prefix.size() || !size || !range(off, size, length)) {
        *error = "invalid Mach-O fat slice extent"; return false;
      }
      if (be(a, 4) == cpu) { ++matches; slice_off = off; slice_size = size; fat_subtype = be(a + 4, 4); }
    }
    if (matches != 1) { *error = "Mach-O CPU slice is absent or ambiguous"; return false; }
  }
  prefix.resize(32);
  if (slice_size < 32 || seek(file.get(), slice_off, SEEK_SET) ||
      std::fread(prefix.data(), 1, 32, file.get()) != 32) {
    *error = "cannot read Mach-O slice header"; return false;
  }
  const uint64_t commands = le(prefix.data() + 20, 4);
  if (commands > slice_size - 32) {
    *error = "invalid Mach-O load command extent"; return false;
  }
  prefix.resize(32 + commands);
  if (std::fread(prefix.data() + 32, 1, commands, file.get()) != commands ||
      !macho_parse_headers(prefix.data(), prefix.size(), cpu, out, error, true)) return false;
  if (fat && fat_subtype != out->cpusubtype) {
    *out = {}; *error = "fat and thin Mach-O CPU identity disagree"; return false;
  }
  for (const auto &s : out->segments) if (!range(s.offset, s.file_size, slice_size)) {
    *out = {}; *error = "Mach-O segment outside slice"; return false;
  }
  out->slice_offset = slice_off; out->slice_size = slice_size;
  if (seek(file.get(), slice_off, SEEK_SET)) { *error = "cannot seek Mach-O slice"; return false; }
  Sha256 hash;
  std::vector<uint8_t> buffer(1u << 20);
  for (uint64_t remaining = slice_size; remaining;) {
    const auto count = static_cast<size_t>(std::min<uint64_t>(buffer.size(), remaining));
    if (std::fread(buffer.data(), 1, count, file.get()) != count) {
      *error = "cannot read Mach-O slice"; return false;
    }
    hash.update(buffer.data(), count); remaining -= count;
  }
  *sha256 = sha256_hex(hash.finish()); return true;
}
}  // namespace grc
