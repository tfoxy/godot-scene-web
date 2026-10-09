// Minimal JSON writer and evidence-file helpers.
//
// The evidence files are the deliverable of gate -1, so writing them must never
// be the thing that fails: every helper here is allocation-light, has no
// dependencies, and reports errors instead of throwing.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace grc {

class JsonWriter {
 public:
  JsonWriter();

  JsonWriter &object_begin();
  JsonWriter &object_end();
  JsonWriter &array_begin();
  JsonWriter &array_end();
  JsonWriter &key(const std::string &name);

  JsonWriter &string(const std::string &value);
  JsonWriter &integer(int64_t value);
  JsonWriter &unsigned_integer(uint64_t value);
  JsonWriter &boolean(bool value);
  JsonWriter &null();
  // Prints with %.9g, which round-trips a float32 exactly.
  JsonWriter &float32(float value);
  // The IEEE-754 bit pattern of a float32, as "0x........".
  JsonWriter &float32_bits(float value);
  JsonWriter &hex(uint64_t value);

  // Convenience: "key": value pairs.
  JsonWriter &field(const std::string &name, const std::string &value);
  JsonWriter &field(const std::string &name, int64_t value);
  JsonWriter &field(const std::string &name, bool value);
  JsonWriter &field_null(const std::string &name);
  JsonWriter &field_hex(const std::string &name, uint64_t value);
  // Writes `value` as a string, or null when it is empty.
  JsonWriter &field_or_null(const std::string &name, const std::string &value);

  std::string take();

 private:
  void separator();
  void indent();
  void write_string_raw(const std::string &value);

  std::string out_;
  std::vector<bool> has_item_;
  bool pending_key_ = false;
};

// Creates `path` and every missing parent. Returns false on failure.
bool make_directories(const std::string &path);

// Writes `text` to `path` (truncating). Returns false on failure.
bool write_file(const std::string &path, const std::string &text);

// Writes an empty file at `path`. Returns false on failure.
bool touch_file(const std::string &path);

// `dir` + "/" + `name`.
std::string path_join(const std::string &dir, const std::string &name);

}  // namespace grc
