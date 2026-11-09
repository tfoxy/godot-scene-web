#include "rs_reload.h"

#include <algorithm>
#include <charconv>
#include <cstring>
#include <string_view>

#include "report.h"
#include "rs_json_lite.h"
#include "rs_texture_delivery.h"
#include "rs_texture_payload.h"

namespace grc {
namespace rs {
namespace {

std::uint32_t u32le(const std::uint8_t *p) {
  return std::uint32_t(p[0]) | (std::uint32_t(p[1]) << 8) |
         (std::uint32_t(p[2]) << 16) | (std::uint32_t(p[3]) << 24);
}
bool nonnegative_int(const json_lite::JValue *v, std::int64_t *out) {
  if (!v || v->kind != json_lite::JValue::Number || v->text.empty() || v->text[0] == '-')
    return false;
  const auto result = std::from_chars(v->text.data(), v->text.data() + v->text.size(), *out);
  return result.ec == std::errc{} && result.ptr == v->text.data() + v->text.size();
}
void count(JsonWriter &j, const char *key, std::uint64_t value) {
  j.key(key).unsigned_integer(value);
}
void shape_json(JsonWriter &j, const Shape &shape) {
  j.object_begin();
  const char *format = image_format_name(shape.format);
  j.field_or_null("format", format ? format : "");
  j.field("width", shape.width).field("height", shape.height).field("mipmaps", shape.mipmaps);
  j.object_end();
}
}  // namespace

const char *reload_refusal_name(ReloadRefusal refusal) {
  switch (refusal) {
    case ReloadRefusal::UnsafeEdited: return "reload-unsafe";
    case ReloadRefusal::NoPath: return "released-no-path";
    case ReloadRefusal::Mismatch: return "reload-mismatch";
    case ReloadRefusal::Failed: return "reload-failed";
    case ReloadRefusal::EvictedUnverifiable: return "evicted-unverifiable";
    case ReloadRefusal::EvictedMidArm: return "evicted-mid-arm";
  }
  return "reload-failed";
}
const char *reload_cause_name(ReloadCause cause) {
  switch (cause) {
    case ReloadCause::Released: return "released";
    case ReloadCause::Evicted: return "evicted";
    case ReloadCause::Residual: return "residual";
  }
  return "released";
}
bool reload_path_valid(const std::string &utf8) {
  return !utf8.empty() && utf8.find("::") == std::string::npos;
}
bool evicted_signature(const Shape &dummy, const RegistryTextureFacts &record) {
  return dummy.width == 1 && dummy.height == 1 && dummy.format == 0 && !dummy.mipmaps &&
         record.known && (record.width != 1 || record.height != 1 || record.format != 0 ||
                          record.mipmaps);
}
bool reload_verify(const Shape &loaded, const Shape &expected, bool check_mipmaps, bool check_format) {
  return loaded.width == expected.width && loaded.height == expected.height &&
         (!check_format || loaded.format == expected.format) && (!check_mipmaps || loaded.mipmaps == expected.mipmaps);
}
bool parse_grt1(const std::uint8_t *p, std::size_t n, Grt1View *out) {
  if (!out) return false;
  *out = {};
  if (!p || n < 16 || std::memcmp(p, kPayloadMagic, sizeof(kPayloadMagic)) != 0) return false;
  const std::size_t meta_len = u32le(p + 8);
  if (meta_len > n - 16) return false;
  const std::size_t data_offset = 16 + meta_len;
  const std::size_t data_len = u32le(p + 12 + meta_len);
  if (data_len != n - data_offset) return false;
  json_lite::JValue meta;
  if (!json_lite::Reader(std::string_view(reinterpret_cast<const char *>(p + 12), meta_len))
           .parse(&meta) || meta.kind != json_lite::JValue::Object || meta.fields.size() != 6)
    return false;
  // Each required member must occur once: a duplicate must not hide contradictory metadata.
  for (const char *key : {"type", "format", "width", "height", "mipmaps", "data_bytes"}) {
    if (std::count_if(meta.fields.begin(), meta.fields.end(), [key](const auto &field) {
          return field.first == key;
        }) != 1) return false;
  }
  const auto *type = meta.get("type"), *format = meta.get("format"), *mips = meta.get("mipmaps");
  if (type->kind != json_lite::JValue::String || type->text != "texture-2d" ||
      format->kind != json_lite::JValue::String || mips->kind != json_lite::JValue::Bool)
    return false;
  Grt1View view;
  std::int64_t data_bytes = 0;
  view.shape.format = image_format_from_name(format->text);
  if (view.shape.format < 0 || !nonnegative_int(meta.get("width"), &view.shape.width) ||
      !nonnegative_int(meta.get("height"), &view.shape.height) ||
      view.shape.width == 0 || view.shape.height == 0 ||
      !nonnegative_int(meta.get("data_bytes"), &data_bytes) ||
      static_cast<std::uint64_t>(data_bytes) != data_len) return false;
  view.shape.mipmaps = mips->b;
  view.data_bytes = static_cast<std::uint64_t>(data_bytes);
  view.data_offset = data_offset;
  view.data_length = data_len;
  *out = view;
  return true;
}
std::int64_t vram_data_bytes(int format, int w, int h, bool mipmaps) {
  const char *name = image_format_name(format);
  return name ? block_data_bytes(name, w, h, mipmaps) : -1;
}
std::string reload_json(const ReloadStats &s, const std::vector<ReloadEntry> &entries,
                         std::size_t dropped_entries) {
  JsonWriter j;
  j.object_begin().field("schema", std::string("render-stream-reload/1")).field("final", s.final);
  count(j, "arm_index", s.arm_index);
  count(j, "frame", s.frame);
  j.field("fault", s.fault).field_or_null("skipped", s.skipped);
  j.key("scanned").object_begin();
  count(j, "registered_vram", s.scanned.registered_vram);
  count(j, "census_compressed", s.scanned.census_compressed);
  j.object_end().key("candidates").object_begin();
  count(j, "released", s.candidates.released);
  count(j, "evicted", s.candidates.evicted);
  count(j, "residual", s.candidates.residual);
  count(j, "total", s.candidates.total());
  j.key("residual_formats").object_begin();
  for (const auto &format : s.candidates.residual_formats) count(j, format.first.c_str(), format.second);
  j.object_end();
  j.object_end();
  count(j, "reloaded", s.reloaded);
  count(j, "verify_skipped", s.verify_skipped);
  count(j, "adopted_from_reload", s.adopted_from_reload);
  count(j, "dropped_unreferenced", s.dropped_unreferenced);
  count(j, "dropped_freed", s.dropped_freed);
  if (s.final) j.field("sources_balanced", s.sources_balanced);
  count(j, "held_bytes", s.held_bytes);
  j.key("refused").object_begin();
  count(j, "reload_unsafe", s.refused.reload_unsafe);
  count(j, "released_no_path", s.refused.released_no_path);
  count(j, "reload_mismatch", s.refused.reload_mismatch);
  count(j, "reload_failed", s.refused.reload_failed);
  count(j, "evicted_unverifiable", s.refused.evicted_unverifiable);
  count(j, "evicted_mid_arm", s.refused.evicted_mid_arm);
  count(j, "total", s.refused.total());
  j.object_end();
  count(j, "released_no_path", s.refused.released_no_path);
  count(j, "temp_outlived", s.temp_outlived);
  count(j, "scope_anomalies", s.scope_anomalies);
  count(j, "reload_us", s.reload_us);
  count(j, "census_us", s.census_us);
  j.key("entries").array_begin();
  const auto kept = std::min(entries.size(), kReloadEntryCap);
  for (std::size_t i = 0; i < kept; ++i) {
    const auto &e = entries[i];
    j.object_begin().field("rid", std::to_string(e.rid));
    j.field("cause", std::string(reload_cause_name(e.cause)));
    j.field("outcome", std::string(e.code ? "refused" : "reloaded"));
    j.field_or_null("code", e.code ? reload_refusal_name(*e.code) : "");
    j.field_or_null("why", e.why).field_or_null("path", e.path);
    j.key("record");
    shape_json(j, e.record);
    j.key("loaded");
    if (e.loaded) shape_json(j, *e.loaded);
    else j.null();
    j.field("adopted", e.adopted).object_end();
  }
  j.array_end();
  count(j, "entries_dropped", dropped_entries + entries.size() - kept);
  j.object_end();
  return j.take();
}
std::string htr_restore_json(const HtrRestoreStats &s) {
  JsonWriter j;
  j.object_begin();
  count(j, "candidates", s.candidates);
  count(j, "restored", s.restored);
  count(j, "unavailable", s.unavailable);
  count(j, "mismatch", s.mismatch);
  count(j, "not_placeholder", s.not_placeholder);
  count(j, "skipped_fault", s.skipped_fault);
  count(j, "skipped_shutdown", s.skipped_shutdown);
  j.field_or_null("skipped", s.skipped).object_end();
  return j.take();
}
}  // namespace rs
}  // namespace grc
