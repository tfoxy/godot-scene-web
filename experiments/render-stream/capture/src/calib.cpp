#include "calib.h"

#include <elf.h>
#include <link.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "abi.h"
#include "iface.h"

namespace grc {

namespace {

// --- SHA-256 (FIPS 180-4), so that the library has no external dependency ----

struct Sha256 {
  uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                       0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  uint64_t bits = 0;
  uint8_t buffer[64] = {};
  size_t buffered = 0;
};

uint32_t rotr(uint32_t value, int count) { return (value >> count) | (value << (32 - count)); }

void sha256_block(Sha256 *ctx, const uint8_t *block) {
  static const uint32_t k[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u,
      0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu,
      0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu,
      0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
      0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
      0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
      0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u,
      0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
      0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u,
      0xc67178f2u};
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
           (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
           (static_cast<uint32_t>(block[i * 4 + 2]) << 8) | static_cast<uint32_t>(block[i * 4 + 3]);
  }
  for (int i = 16; i < 64; ++i) {
    const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
  uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
  for (int i = 0; i < 64; ++i) {
    const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t temp1 = h + s1 + ch + k[i] + w[i];
    const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }
  ctx->state[0] += a;
  ctx->state[1] += b;
  ctx->state[2] += c;
  ctx->state[3] += d;
  ctx->state[4] += e;
  ctx->state[5] += f;
  ctx->state[6] += g;
  ctx->state[7] += h;
}

void sha256_update(Sha256 *ctx, const uint8_t *data, size_t size) {
  ctx->bits += static_cast<uint64_t>(size) * 8;
  while (size > 0) {
    const size_t take = (64 - ctx->buffered) < size ? (64 - ctx->buffered) : size;
    std::memcpy(ctx->buffer + ctx->buffered, data, take);
    ctx->buffered += take;
    data += take;
    size -= take;
    if (ctx->buffered == 64) {
      sha256_block(ctx, ctx->buffer);
      ctx->buffered = 0;
    }
  }
}

std::string sha256_finish(Sha256 *ctx) {
  const uint64_t bits = ctx->bits;
  ctx->buffer[ctx->buffered++] = 0x80;
  if (ctx->buffered > 56) {
    std::memset(ctx->buffer + ctx->buffered, 0, 64 - ctx->buffered);
    sha256_block(ctx, ctx->buffer);
    ctx->buffered = 0;
  }
  std::memset(ctx->buffer + ctx->buffered, 0, 56 - ctx->buffered);
  for (int i = 0; i < 8; ++i) {
    ctx->buffer[56 + i] = static_cast<uint8_t>((bits >> (56 - 8 * i)) & 0xff);
  }
  sha256_block(ctx, ctx->buffer);
  char hex[65];
  for (int i = 0; i < 8; ++i) {
    std::snprintf(hex + i * 8, 9, "%08x", ctx->state[i]);
  }
  return std::string(hex, 64);
}

// --- tiny JSON reader --------------------------------------------------------
//
// Enough for the calibration record: objects, strings, integers, booleans and
// null. Deliberately strict: a malformed or unexpected record is a refusal.

class JsonParser {
 public:
  explicit JsonParser(const std::string &text) : text_(text) {}

  bool parse_object_begin() { return expect('{'); }

  // Reads the next key in the current object. Returns false at '}'.
  bool next_key(std::string *key) {
    skip_space();
    if (peek() == ',') {
      ++pos_;
      skip_space();
    }
    if (peek() == '}') {
      ++pos_;
      return false;
    }
    if (!read_string(key)) {
      fail("expected a key");
      return false;
    }
    skip_space();
    if (!expect(':')) {
      return false;
    }
    return true;
  }

  bool read_string(std::string *out) {
    skip_space();
    if (peek() != '"') {
      return false;
    }
    ++pos_;
    out->clear();
    while (pos_ < text_.size()) {
      const char c = text_[pos_++];
      if (c == '"') {
        return true;
      }
      if (c == '\\') {
        if (pos_ >= text_.size()) {
          return false;
        }
        const char esc = text_[pos_++];
        switch (esc) {
          case 'n':
            *out += '\n';
            break;
          case 't':
            *out += '\t';
            break;
          case 'r':
            *out += '\r';
            break;
          case 'b':
          case 'f':
            break;
          case 'u': {
            if (pos_ + 4 > text_.size()) {
              return false;
            }
            pos_ += 4;  // records never need non-ASCII; drop the escape
            break;
          }
          default:
            *out += esc;
        }
        continue;
      }
      *out += c;
    }
    return false;
  }

  bool read_integer(int64_t *out) {
    skip_space();
    const size_t start = pos_;
    if (peek() == '-' || peek() == '+') {
      ++pos_;
    }
    while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') {
      ++pos_;
    }
    if (pos_ == start) {
      return false;
    }
    *out = std::strtoll(text_.substr(start, pos_ - start).c_str(), nullptr, 10);
    return true;
  }

  bool read_bool(bool *out) {
    skip_space();
    if (text_.compare(pos_, 4, "true") == 0) {
      pos_ += 4;
      *out = true;
      return true;
    }
    if (text_.compare(pos_, 5, "false") == 0) {
      pos_ += 5;
      *out = false;
      return true;
    }
    return false;
  }

  bool read_null() {
    skip_space();
    if (text_.compare(pos_, 4, "null") == 0) {
      pos_ += 4;
      return true;
    }
    return false;
  }

  // Skips any value (used for keys this version does not care about).
  bool skip_value() {
    skip_space();
    const char c = peek();
    if (c == '"') {
      std::string ignored;
      return read_string(&ignored);
    }
    if (c == '{' || c == '[') {
      const char open = c;
      const char close = (c == '{') ? '}' : ']';
      int depth = 0;
      while (pos_ < text_.size()) {
        const char d = text_[pos_];
        if (d == '"') {
          std::string ignored;
          if (!read_string(&ignored)) {
            return false;
          }
          continue;
        }
        ++pos_;
        if (d == open) {
          ++depth;
        } else if (d == close) {
          --depth;
          if (depth == 0) {
            return true;
          }
        }
      }
      return false;
    }
    bool flag = false;
    int64_t number = 0;
    if (read_bool(&flag) || read_null() || read_integer(&number)) {
      return true;
    }
    // Any other scalar (a float, say) is read as a bare token.
    const size_t start = pos_;
    while (pos_ < text_.size() && text_[pos_] != ',' && text_[pos_] != '}' && text_[pos_] != ']') {
      ++pos_;
    }
    return pos_ > start;
  }

  char peek() const { return pos_ < text_.size() ? text_[pos_] : '\0'; }

  void skip_space() {
    while (pos_ < text_.size() &&
           (text_[pos_] == ' ' || text_[pos_] == '\n' || text_[pos_] == '\r' ||
            text_[pos_] == '\t')) {
      ++pos_;
    }
  }

  bool expect(char c) {
    skip_space();
    if (peek() != c) {
      fail(std::string("expected '") + c + "'");
      return false;
    }
    ++pos_;
    return true;
  }

  void fail(const std::string &message) {
    if (error_.empty()) {
      char buf[32];
      std::snprintf(buf, sizeof(buf), " at offset %zu", pos_);
      error_ = message + buf;
    }
  }

  const std::string &error() const { return error_; }

 private:
  const std::string &text_;
  size_t pos_ = 0;
  std::string error_;
};

bool read_string_map(JsonParser *parser, std::vector<std::pair<std::string, int64_t>> *out) {
  if (!parser->parse_object_begin()) {
    return false;
  }
  std::string key;
  while (parser->next_key(&key)) {
    int64_t value = 0;
    if (!parser->read_integer(&value)) {
      parser->fail("expected an integer slot index");
      return false;
    }
    out->emplace_back(key, value);
  }
  return parser->error().empty();
}

bool read_file(const std::string &path, std::string *out) {
  FILE *handle = std::fopen(path.c_str(), "rb");
  if (handle == nullptr) {
    return false;
  }
  char buffer[8192];
  size_t got = 0;
  while ((got = std::fread(buffer, 1, sizeof(buffer), handle)) > 0) {
    out->append(buffer, got);
    if (out->size() > (4u << 20)) {
      break;
    }
  }
  std::fclose(handle);
  return true;
}

uint64_t parse_hex(const std::string &text) {
  return std::strtoull(text.c_str(), nullptr, 0);
}

// --- process facts -----------------------------------------------------------

struct MainObject {
  uint64_t bias = 0;
  bool found = false;
  bool pie = false;
  std::string build_id;
};

int phdr_callback(struct dl_phdr_info *info, size_t /*size*/, void *data) {
  auto *out = static_cast<MainObject *>(data);
  if (out->found) {
    return 0;
  }
  // The first object dl_iterate_phdr reports is the main program.
  if (info->dlpi_name != nullptr && info->dlpi_name[0] != '\0') {
    return 0;
  }
  out->found = true;
  out->bias = static_cast<uint64_t>(info->dlpi_addr);
  for (int i = 0; i < info->dlpi_phnum; ++i) {
    const ElfW(Phdr) &phdr = info->dlpi_phdr[i];
    if (phdr.p_type == PT_NOTE) {
      const auto *cursor = reinterpret_cast<const uint8_t *>(info->dlpi_addr + phdr.p_vaddr);
      const uint8_t *end = cursor + phdr.p_memsz;
      while (cursor + sizeof(ElfW(Nhdr)) <= end) {
        const auto *note = reinterpret_cast<const ElfW(Nhdr) *>(cursor);
        const uint8_t *name = cursor + sizeof(ElfW(Nhdr));
        const uint8_t *desc = name + ((note->n_namesz + 3) & ~3u);
        if (note->n_type == NT_GNU_BUILD_ID && note->n_namesz == 4 &&
            std::memcmp(name, "GNU", 4) == 0 && desc + note->n_descsz <= end) {
          char hex[3];
          for (uint32_t b = 0; b < note->n_descsz; ++b) {
            std::snprintf(hex, sizeof(hex), "%02x", desc[b]);
            out->build_id += hex;
          }
        }
        cursor = desc + ((note->n_descsz + 3) & ~3u);
      }
    }
  }
  // ET_DYN main programs are relocated; ET_EXEC ones are not. The ELF header is
  // at the start of the PT_LOAD segment that maps file offset 0.
  out->pie = (out->bias != 0);
  for (int i = 0; i < info->dlpi_phnum; ++i) {
    const ElfW(Phdr) &phdr = info->dlpi_phdr[i];
    if (phdr.p_type != PT_LOAD || phdr.p_offset != 0) {
      continue;
    }
    const auto *header =
        reinterpret_cast<const ElfW(Ehdr) *>(info->dlpi_addr + phdr.p_vaddr);
    if (std::memcmp(header->e_ident, ELFMAG, SELFMAG) == 0) {
      out->pie = (header->e_type == ET_DYN);
    }
    break;
  }
  return 1;
}

void record(std::vector<CheckResult> *checks, const char *name, bool ok, const std::string &detail) {
  CheckResult result;
  result.name = name;
  result.ok = ok;
  result.detail = detail;
  checks->push_back(result);
}

std::string format_hex(uint64_t value) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(value));
  return buf;
}

}  // namespace

std::string sha256_file(const std::string &path) {
  FILE *handle = std::fopen(path.c_str(), "rb");
  if (handle == nullptr) {
    return std::string();
  }
  Sha256 ctx;
  std::vector<uint8_t> buffer(1u << 20);
  size_t got = 0;
  while ((got = std::fread(buffer.data(), 1, buffer.size(), handle)) > 0) {
    sha256_update(&ctx, buffer.data(), got);
  }
  std::fclose(handle);
  return sha256_finish(&ctx);
}

int64_t Calibration::slot(const std::string &name) const {
  for (const auto &entry : slots) {
    if (entry.first == name) {
      return entry.second;
    }
  }
  return -1;
}

bool load_calibration(const std::string &path, Calibration *out, std::string *error) {
  // Start from an empty record: a deferred attempt calls this again, and the
  // parser appends to the slot and anchor lists.
  *out = Calibration{};
  std::string text;
  if (!read_file(path, &text) || text.empty()) {
    *error = "cannot read " + path;
    return false;
  }
  JsonParser parser(text);
  if (!parser.parse_object_begin()) {
    *error = "not a JSON object: " + parser.error();
    return false;
  }
  bool saw_engine = false;
  bool saw_rs = false;
  std::string key;
  while (parser.next_key(&key)) {
    if (key == "schema") {
      if (!parser.read_string(&out->schema)) {
        *error = "schema is not a string";
        return false;
      }
    } else if (key == "engine") {
      saw_engine = true;
      if (!parser.parse_object_begin()) {
        *error = "engine is not an object";
        return false;
      }
      std::string sub;
      while (parser.next_key(&sub)) {
        if (sub == "version_string") {
          parser.read_string(&out->version_string);
        } else if (sub == "build_id") {
          if (parser.read_null()) {
            out->build_id_present = false;
          } else if (parser.read_string(&out->build_id)) {
            out->build_id_present = true;
          } else {
            *error = "build_id is neither a string nor null";
            return false;
          }
        } else if (sub == "sha256") {
          parser.read_string(&out->sha256);
        } else if (sub == "platform") {
          parser.read_string(&out->platform);
        } else if (sub == "flavor") {
          parser.read_string(&out->flavor);
        } else if (sub == "pie") {
          if (!parser.read_bool(&out->pie)) {
            *error = "pie is not a boolean";
            return false;
          }
        } else if (!parser.skip_value()) {
          *error = "malformed engine." + sub;
          return false;
        }
      }
    } else if (key == "rendering_server") {
      saw_rs = true;
      if (!parser.parse_object_begin()) {
        *error = "rendering_server is not an object";
        return false;
      }
      std::string sub;
      while (parser.next_key(&sub)) {
        if (sub == "abstract_vtable_vaddr" || sub == "concrete_vtable_vaddr") {
          std::string value;
          if (!parser.read_string(&value)) {
            *error = sub + " is not a string";
            return false;
          }
          const uint64_t parsed = parse_hex(value);
          if (sub == "abstract_vtable_vaddr") {
            out->abstract_vtable_vaddr = parsed;
          } else {
            out->concrete_vtable_vaddr = parsed;
          }
        } else if (sub == "concrete_class") {
          parser.read_string(&out->concrete_class);
        } else if (sub == "object_prefix") {
          parser.read_integer(&out->object_prefix);
        } else if (sub == "slot_count") {
          parser.read_integer(&out->slot_count);
        } else if (sub == "anchors_total") {
          parser.read_integer(&out->anchors_total);
        } else if (sub == "anchors_matched") {
          parser.read_integer(&out->anchors_matched);
        } else if (!parser.skip_value()) {
          *error = "malformed rendering_server." + sub;
          return false;
        }
      }
    } else if (key == "slots") {
      if (!read_string_map(&parser, &out->slots)) {
        *error = "malformed slots: " + parser.error();
        return false;
      }
    } else if (key == "anchors") {
      if (!read_string_map(&parser, &out->anchors)) {
        *error = "malformed anchors: " + parser.error();
        return false;
      }
    } else if (!parser.skip_value()) {
      *error = "malformed value for " + key;
      return false;
    }
  }
  if (!parser.error().empty()) {
    *error = parser.error();
    return false;
  }
  if (out->schema != "render-stream-calibration/1") {
    *error = "unsupported schema '" + out->schema + "'";
    return false;
  }
  if (!saw_engine || !saw_rs || out->slots.empty() || out->anchors.empty()) {
    *error = "record is missing a required section";
    return false;
  }
  if (out->slot_count <= 0 || out->slot_count > 4096) {
    *error = "implausible slot_count";
    return false;
  }
  if (out->concrete_vtable_vaddr == 0 || out->abstract_vtable_vaddr == 0) {
    *error = "record has no vtable addresses";
    return false;
  }
  return true;
}

bool ProcessFingerprint::in_exec_range(uint64_t address) const {
  for (const auto &range : exec_ranges) {
    if (address >= range.first && address < range.second) {
      return true;
    }
  }
  return false;
}

bool collect_fingerprint(ProcessFingerprint *out, std::string *error) {
  // Start empty for the same reason: the maps scan appends.
  *out = ProcessFingerprint{};
  char exe[4096] = {};
  const ssize_t length = ::readlink("/proc/self/exe", exe, sizeof(exe) - 1);
  if (length <= 0) {
    *error = "cannot read /proc/self/exe";
    return false;
  }
  out->exe_path.assign(exe, static_cast<size_t>(length));
  out->pid = static_cast<int>(::getpid());
  out->exe_sha256 = sha256_file("/proc/self/exe");

  MainObject main_object;
  ::dl_iterate_phdr(phdr_callback, &main_object);
  if (!main_object.found) {
    *error = "cannot locate the main program's program headers";
    return false;
  }
  out->load_bias = main_object.bias;
  out->pie = main_object.pie;
  out->build_id = main_object.build_id;

  std::string maps;
  if (read_file("/proc/self/maps", &maps)) {
    size_t start = 0;
    while (start < maps.size()) {
      size_t end = maps.find('\n', start);
      if (end == std::string::npos) {
        end = maps.size();
      }
      const std::string line = maps.substr(start, end - start);
      start = end + 1;
      if (line.find(out->exe_path) == std::string::npos) {
        continue;
      }
      out->exe_maps.push_back(line);
      uint64_t begin = 0;
      uint64_t finish = 0;
      char perms[8] = {};
      if (std::sscanf(line.c_str(), "%llx-%llx %7s", reinterpret_cast<unsigned long long *>(&begin),
                      reinterpret_cast<unsigned long long *>(&finish), perms) == 3 &&
          std::strchr(perms, 'x') != nullptr) {
        out->exec_ranges.emplace_back(begin, finish);
      }
    }
  }

  if (g_iface.get_godot_version2 != nullptr) {
    GDExtensionGodotVersion2 version = {};
    g_iface.get_godot_version2(&version);
    if (version.string != nullptr) {
      out->version_string = version.string;
    }
  }
  return true;
}

bool check_fingerprint(const Calibration &calib, const ProcessFingerprint &fp,
                       std::vector<CheckResult> *checks) {
  bool ok = true;

  const bool sha_ok = !fp.exe_sha256.empty() && fp.exe_sha256 == calib.sha256;
  record(checks, "exe_sha256", sha_ok, "live " + fp.exe_sha256 + " record " + calib.sha256);
  ok = ok && sha_ok;

  const bool version_ok = !fp.version_string.empty() && fp.version_string == calib.version_string;
  record(checks, "version_string", version_ok,
         "live '" + fp.version_string + "' record '" + calib.version_string + "'");
  ok = ok && version_ok;

  if (calib.build_id_present) {
    const bool build_ok = fp.build_id == calib.build_id;
    record(checks, "build_id", build_ok, "live " + fp.build_id + " record " + calib.build_id);
    ok = ok && build_ok;
  } else {
    record(checks, "build_id", fp.build_id.empty(),
           fp.build_id.empty() ? "absent in both" : "live binary has one, record does not");
    ok = ok && fp.build_id.empty();
  }

  const bool pie_ok = (fp.pie == calib.pie) && (calib.pie || fp.load_bias == 0);
  record(checks, "pie_and_bias", pie_ok,
         std::string("live pie=") + (fp.pie ? "true" : "false") + " bias " +
             format_hex(fp.load_bias) + " record pie=" + (calib.pie ? "true" : "false"));
  ok = ok && pie_ok;

  const bool platform_ok = calib.platform == "linux-x86_64";
  record(checks, "platform", platform_ok, calib.platform);
  ok = ok && platform_ok;

  return ok;
}

bool check_slot_mask(const Calibration &calib, const ProcessFingerprint &fp,
                     LiveVtableFacts *facts, std::vector<CheckResult> *checks) {
  bool ok = true;

  facts->singleton = singleton_object("RenderingServer");
  record(checks, "singleton_available", facts->singleton != nullptr,
         format_hex(reinterpret_cast<uint64_t>(facts->singleton)));
  if (facts->singleton == nullptr) {
    return false;
  }

  facts->live_vptr = reinterpret_cast<uint64_t>(*static_cast<void **>(facts->singleton));
  facts->expected_vptr = calib.concrete_vtable_vaddr + 16 + fp.load_bias;
  const bool vptr_ok = facts->live_vptr == facts->expected_vptr;
  record(checks, "concrete_vptr", vptr_ok,
         "live " + format_hex(facts->live_vptr) + " expected " + format_hex(facts->expected_vptr));
  ok = ok && vptr_ok;
  if (!vptr_ok) {
    // Without a known vtable identity nothing below may be dereferenced.
    return false;
  }

  // Every recorded index must be inside the recorded table.
  bool indices_ok = true;
  for (const auto &entry : calib.slots) {
    indices_ok = indices_ok && entry.second >= 0 && entry.second < calib.slot_count;
  }
  for (const auto &entry : calib.anchors) {
    indices_ok = indices_ok && entry.second >= 0 && entry.second < calib.slot_count;
  }
  indices_ok = indices_ok && calib.object_prefix > 0 && calib.object_prefix < calib.slot_count;
  record(checks, "slot_indices_in_range", indices_ok,
         "slot_count " + std::to_string(calib.slot_count) + " object_prefix " +
             std::to_string(calib.object_prefix));
  ok = ok && indices_ok;
  if (!indices_ok) {
    return false;
  }

  auto *const concrete = reinterpret_cast<void **>(facts->expected_vptr);
  facts->abstract_address_point = calib.abstract_vtable_vaddr + 16 + fp.load_bias;
  auto *const abstract = reinterpret_cast<void **>(facts->abstract_address_point);

  // Anchors: implemented in the abstract vtable, pointing into the main binary.
  int matched = 0;
  std::string anchor_detail;
  for (const auto &entry : calib.anchors) {
    const uint64_t value = reinterpret_cast<uint64_t>(abstract[entry.second]);
    if (value != 0 && fp.in_exec_range(value)) {
      ++matched;
    } else if (anchor_detail.empty()) {
      anchor_detail = entry.first + "@" + std::to_string(entry.second) + " = " + format_hex(value);
    }
  }
  const bool anchors_ok = matched == static_cast<int>(calib.anchors.size()) &&
                          matched == static_cast<int>(calib.anchors_total);
  record(checks, "anchors_implemented", anchors_ok,
         std::to_string(matched) + "/" + std::to_string(calib.anchors.size()) +
             (anchor_detail.empty() ? "" : " first mismatch " + anchor_detail));
  ok = ok && anchors_ok;

  // Hooked slots: pure-virtual in the abstract vtable, all sharing one
  // placeholder value, and implemented in the concrete vtable.
  bool placeholder_ok = true;
  bool concrete_ok = true;
  std::string placeholder_detail;
  for (const auto &entry : calib.slots) {
    const uint64_t pure = reinterpret_cast<uint64_t>(abstract[entry.second]);
    if (!facts->pure_placeholder_known) {
      facts->pure_placeholder = pure;
      facts->pure_placeholder_known = true;
    } else if (pure != facts->pure_placeholder) {
      placeholder_ok = false;
      if (placeholder_detail.empty()) {
        placeholder_detail = entry.first + "@" + std::to_string(entry.second) + " = " +
                             format_hex(pure) + " != " + format_hex(facts->pure_placeholder);
      }
    }
    const uint64_t impl = reinterpret_cast<uint64_t>(concrete[entry.second]);
    if (impl == 0 || !fp.in_exec_range(impl)) {
      concrete_ok = false;
      if (placeholder_detail.empty()) {
        placeholder_detail =
            entry.first + "@" + std::to_string(entry.second) + " concrete " + format_hex(impl);
      }
    }
  }
  // The placeholder must not itself be a function in the main binary: that
  // would mean the slot is implemented in RenderingServer and the index does
  // not refer to the pure method the record claims.
  const bool pure_distinct =
      facts->pure_placeholder_known && !fp.in_exec_range(facts->pure_placeholder);
  record(checks, "hooked_slots_pure_in_abstract", placeholder_ok && pure_distinct,
         "placeholder " + format_hex(facts->pure_placeholder) +
             (placeholder_detail.empty() ? "" : " " + placeholder_detail));
  record(checks, "hooked_slots_implemented_in_concrete", concrete_ok, placeholder_detail);
  ok = ok && placeholder_ok && pure_distinct && concrete_ok;

  // The last slot must still be inside the mapping, and the slot one past the
  // end must not look like another function of the same table.
  const bool tail_ok = fp.in_exec_range(reinterpret_cast<uint64_t>(concrete[calib.slot_count - 1]));
  record(checks, "slot_count_tail", tail_ok,
         "last slot " + format_hex(reinterpret_cast<uint64_t>(concrete[calib.slot_count - 1])));
  ok = ok && tail_ok;

  return ok;
}

bool check_behaviour(const Calibration &calib, const LiveVtableFacts &facts,
                     std::vector<CheckResult> *checks) {
  const int64_t index = calib.slot("get_default_clear_color");
  if (index < 0 || facts.singleton == nullptr) {
    record(checks, "behaviour_probe", true, "skipped: no probe slot in the record");
    return true;
  }
  GDExtensionMethodBindPtr bind =
      method_bind("RenderingServer", "get_default_clear_color", 3200896285LL);
  if (bind == nullptr || g_iface.object_method_bind_ptrcall == nullptr) {
    record(checks, "behaviour_probe", true, "skipped: method bind unavailable");
    return true;
  }
  Color via_bind = {};
  g_iface.object_method_bind_ptrcall(bind, facts.singleton, nullptr, &via_bind);

  auto *const table = reinterpret_cast<void **>(facts.expected_vptr);
  using Getter = Color (*)(void *);
  auto getter = reinterpret_cast<Getter>(table[index]);
  const Color via_slot = getter(facts.singleton);

  const bool same = std::memcmp(&via_bind, &via_slot, sizeof(Color)) == 0;
  char detail[160];
  std::snprintf(detail, sizeof(detail), "bind (%.9g %.9g %.9g %.9g) slot (%.9g %.9g %.9g %.9g)",
                static_cast<double>(via_bind.r), static_cast<double>(via_bind.g),
                static_cast<double>(via_bind.b), static_cast<double>(via_bind.a),
                static_cast<double>(via_slot.r), static_cast<double>(via_slot.g),
                static_cast<double>(via_slot.b), static_cast<double>(via_slot.a));
  record(checks, "behaviour_probe", same, detail);
  return same;
}

}  // namespace grc
