#include "report.h"

#include <sys/stat.h>
#include <sys/types.h>

#include <cerrno>
#include <cstdio>
#include <cstring>

namespace grc {

JsonWriter::JsonWriter() { out_.reserve(4096); }

void JsonWriter::separator() {
  if (pending_key_) {
    pending_key_ = false;
    return;
  }
  if (!has_item_.empty()) {
    if (has_item_.back()) {
      out_ += ",";
    }
    has_item_.back() = true;
    out_ += "\n";
    indent();
  }
}

void JsonWriter::indent() { out_.append(has_item_.size() * 2, ' '); }

JsonWriter &JsonWriter::object_begin() {
  separator();
  out_ += "{";
  has_item_.push_back(false);
  return *this;
}

JsonWriter &JsonWriter::object_end() {
  const bool had = has_item_.empty() ? false : has_item_.back();
  if (!has_item_.empty()) {
    has_item_.pop_back();
  }
  if (had) {
    out_ += "\n";
    indent();
  }
  out_ += "}";
  return *this;
}

JsonWriter &JsonWriter::array_begin() {
  separator();
  out_ += "[";
  has_item_.push_back(false);
  return *this;
}

JsonWriter &JsonWriter::array_end() {
  const bool had = has_item_.empty() ? false : has_item_.back();
  if (!has_item_.empty()) {
    has_item_.pop_back();
  }
  if (had) {
    out_ += "\n";
    indent();
  }
  out_ += "]";
  return *this;
}

JsonWriter &JsonWriter::key(const std::string &name) {
  separator();
  write_string_raw(name);
  out_ += ": ";
  pending_key_ = true;
  return *this;
}

JsonWriter &JsonWriter::string(const std::string &value) {
  separator();
  write_string_raw(value);
  return *this;
}

void JsonWriter::write_string_raw(const std::string &value) {
  out_ += '"';
  for (char c : value) {
    switch (c) {
      case '"':
        out_ += "\\\"";
        break;
      case '\\':
        out_ += "\\\\";
        break;
      case '\n':
        out_ += "\\n";
        break;
      case '\r':
        out_ += "\\r";
        break;
      case '\t':
        out_ += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
          out_ += buf;
        } else {
          out_ += c;
        }
    }
  }
  out_ += '"';
}

JsonWriter &JsonWriter::integer(int64_t value) {
  separator();
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(value));
  out_ += buf;
  return *this;
}

JsonWriter &JsonWriter::unsigned_integer(uint64_t value) {
  separator();
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(value));
  out_ += buf;
  return *this;
}

JsonWriter &JsonWriter::boolean(bool value) {
  separator();
  out_ += value ? "true" : "false";
  return *this;
}

JsonWriter &JsonWriter::null() {
  separator();
  out_ += "null";
  return *this;
}

JsonWriter &JsonWriter::float32(float value) {
  separator();
  char buf[48];
  std::snprintf(buf, sizeof(buf), "%.9g", static_cast<double>(value));
  // A non-finite float has no JSON spelling; record it as a string instead of
  // emitting invalid JSON.
  if (std::strstr(buf, "inf") != nullptr || std::strstr(buf, "nan") != nullptr) {
    out_ += '"';
    out_ += buf;
    out_ += '"';
  } else {
    out_ += buf;
  }
  return *this;
}

JsonWriter &JsonWriter::float32_bits(float value) {
  uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  char buf[16];
  std::snprintf(buf, sizeof(buf), "0x%08x", bits);
  return string(buf);
}

JsonWriter &JsonWriter::hex(uint64_t value) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(value));
  return string(buf);
}

JsonWriter &JsonWriter::field(const std::string &name, const std::string &value) {
  return key(name).string(value);
}

JsonWriter &JsonWriter::field(const std::string &name, int64_t value) {
  return key(name).integer(value);
}

JsonWriter &JsonWriter::field(const std::string &name, bool value) {
  return key(name).boolean(value);
}

JsonWriter &JsonWriter::field_null(const std::string &name) { return key(name).null(); }

JsonWriter &JsonWriter::field_hex(const std::string &name, uint64_t value) {
  return key(name).hex(value);
}

JsonWriter &JsonWriter::field_or_null(const std::string &name, const std::string &value) {
  if (value.empty()) {
    return field_null(name);
  }
  return field(name, value);
}

std::string JsonWriter::take() {
  std::string text = out_;
  text += "\n";
  return text;
}

bool make_directories(const std::string &path) {
  if (path.empty()) {
    return false;
  }
  std::string partial;
  size_t index = 0;
  if (path[0] == '/') {
    partial = "/";
    index = 1;
  }
  while (index <= path.size()) {
    const size_t next = path.find('/', index);
    const std::string component = path.substr(index, next == std::string::npos ? next : next - index);
    if (!component.empty()) {
      if (partial.size() > 1 || (partial.size() == 1 && partial[0] != '/')) {
        partial += "/";
      }
      partial += component;
      if (::mkdir(partial.c_str(), 0775) != 0 && errno != EEXIST) {
        return false;
      }
    }
    if (next == std::string::npos) {
      break;
    }
    index = next + 1;
  }
  struct stat info = {};
  return ::stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}

bool write_file(const std::string &path, const std::string &text) {
  FILE *handle = std::fopen(path.c_str(), "wb");
  if (handle == nullptr) {
    return false;
  }
  const size_t written = text.empty() ? 0 : std::fwrite(text.data(), 1, text.size(), handle);
  const bool ok = (written == text.size());
  return (std::fclose(handle) == 0) && ok;
}

bool touch_file(const std::string &path) { return write_file(path, std::string()); }

std::string path_join(const std::string &dir, const std::string &name) {
  if (dir.empty()) {
    return name;
  }
  if (dir.back() == '/') {
    return dir + name;
  }
  return dir + "/" + name;
}

}  // namespace grc
