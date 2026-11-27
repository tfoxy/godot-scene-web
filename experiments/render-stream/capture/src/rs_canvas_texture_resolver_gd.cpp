#include "rs_canvas_texture_resolver.h"
#include "rs_canvas_texture_derive.h"
#include "rs_platform.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if defined(__linux__)
#include <link.h>
#include <sys/uio.h>
#include <unistd.h>
#endif

#include "calib.h"
#include "iface.h"
#include "rs_registry.h"

namespace grc::rs {
namespace {
CanvasTextureResolver resolver;
bool attachment_initialized = false;
void *server = nullptr, *device = nullptr;
GDExtensionMethodBindPtr render_call = nullptr, sync_call = nullptr;
GDExtensionMethodBindPtr format_call = nullptr, native_call = nullptr;
GDExtensionMethodBindPtr rd_texture_call = nullptr, rd_valid_call = nullptr;
GDExtensionMethodBindPtr rd_format_call = nullptr, rd_type_call = nullptr;
std::uint64_t type_checks = 0;
const char *storage_source = "none";
std::uint64_t image_reads = 0, storage_reads = 0, owner_reads = 0;

void call(GDExtensionMethodBindPtr bind, const GDExtensionConstTypePtr *args, void *out) {
  g_iface.object_method_bind_ptrcall(bind, server, args, out);
}

bool safe_copy(std::uint64_t address, void *out, std::size_t bytes) {
#if defined(__linux__)
  iovec local{out, bytes};
  iovec remote{reinterpret_cast<void *>(address), bytes};
  return process_vm_readv(getpid(), &local, 1, &remote, 1, 0) == static_cast<ssize_t>(bytes);
#else
  (void)address; (void)out; (void)bytes;
  return false;
#endif
}
class LiveReader final : public CanvasTextureReader {
 public:
  bool copy(std::uint64_t address, void *out, std::size_t bytes) override {
    ++owner_reads;
    return safe_copy(address, out, bytes);
  }
  bool live_texture(std::uint64_t rid) override {
    const std::uint8_t srgb = 0;
    const GDExtensionConstTypePtr args[] = {&rid, &srgb};
    std::uint64_t native = 0;
    std::int64_t format = -1;
    call(native_call, args, &native);
    if (!native) return false;
    call(format_call, args, &format);
    // Image::FORMAT_MAX is 39 in the calibrated 4.5.1 ABI. This establishes liveness;
    // resolution separately proves dimensionality before exposing any channel to adoption.
    return format >= 0 && format < 39;
  }
  std::int64_t texture_type(std::uint64_t rid) override {
    ++type_checks;
    if (!device || !rd_texture_call || !rd_valid_call || !rd_format_call || !rd_type_call)
      return -1;
    const std::uint8_t srgb = 0;
    const GDExtensionConstTypePtr args[] = {&rid, &srgb};
    std::uint64_t rd_rid = 0;
    call(rd_texture_call, args, &rd_rid);
    if (!rd_rid) return -1;
    const GDExtensionConstTypePtr rd_args[] = {&rd_rid};
    std::uint8_t valid = 0;
    g_iface.object_method_bind_ptrcall(rd_valid_call, device, rd_args, &valid);
    if (!valid) return -1;
    // Invalid RD RIDs return a default format whose type is 2D. Validate ownership first.
    RefHolder format;
    if (!format.call_args(rd_format_call, device, rd_args) || !format.object()) return -1;
    std::int64_t type = -1;
    return call_int_getter(rd_type_call, format.object(), &type) ? type : -1;
  }
};

struct Work {
  std::uint64_t rid = 0;
  CanvasTextureChannels channels;
  const std::vector<std::pair<std::uint64_t, CanvasTextureChannels>> *known = nullptr;
  std::atomic<bool> called{false};
  bool ok = false;
};

void render_callback(void *userdata, const GDExtensionConstVariantPtr *, GDExtensionInt,
                     GDExtensionVariantPtr, GDExtensionCallError *error) {
  if (error) error->error = GDEXTENSION_CALL_OK;
  auto &work = *static_cast<Work *>(userdata);
  LiveReader reader;
  work.ok = work.known ? resolver.selfcheck(reader, *work.known) :
                        resolver.resolve(reader, work.rid, &work.channels);
  work.called.store(true, std::memory_order_release);
}

bool dispatch(Work *work) {
  alignas(8) unsigned char callable[16] = {};
  GDExtensionCallableCustomInfo2 info{};
  info.callable_userdata = work;
  info.token = g_iface.library;
  info.call_func = render_callback;
  g_iface.callable_custom_create2(callable, &info);
  const GDExtensionConstTypePtr args[] = {callable};
  call(render_call, args, nullptr);
  call(sync_call, nullptr, nullptr);
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)(callable);
  return work->called.load(std::memory_order_acquire) && work->ok;
}

bool main_image_word(const ProcessFingerprint &fp, std::uint64_t address, bool readonly) {
  for (const auto &line : fp.exe_maps) {
    unsigned long long begin = 0, end = 0;
    char perms[5] = {};
    if (std::sscanf(line.c_str(), "%llx-%llx %4s", &begin, &end, perms) == 3 &&
        perms[0] == 'r' && (!readonly || perms[1] == '-') && address >= begin &&
        address < end && end - address >= 8) return true;
  }
#if defined(__linux__)
  // The loader maps the zero-filled tail of a PT_LOAD segment anonymously. /proc/maps lines
  // carrying the executable path omit that .bss tail, although it belongs to the main image.
  // Only the calibrated writable global may use this route; vtables still require a read-only
  // file mapping above. Heap reads remain fault-tolerant process_vm_readv calls.
  if (!readonly) {
    struct Check { std::uint64_t address, bias; bool found = false; } check{address, fp.load_bias};
    dl_iterate_phdr([](dl_phdr_info *image, std::size_t, void *opaque) {
      auto &c = *static_cast<Check *>(opaque);
      if ((image->dlpi_name && *image->dlpi_name) || image->dlpi_addr != c.bias) return 0;
      for (std::size_t i = 0; i < image->dlpi_phnum; ++i) {
        const auto &p = image->dlpi_phdr[i];
        if (p.p_type != PT_LOAD || !(p.p_flags & PF_R) || !(p.p_flags & PF_W) ||
            p.p_vaddr > UINT64_MAX - c.bias) continue;
        const auto begin = c.bias + p.p_vaddr;
        if (c.address >= begin && c.address - begin <= p.p_memsz &&
            p.p_memsz - (c.address - begin) >= 8) { c.found = true; return 1; }
      }
      return 0;
    }, &check);
    return check.found;
  }
#endif
  return false;
}
// Image/code provenance is validated before every fault-tolerant copy. The loader's BSS
// tail may be anonymous; only main-image writable, non-executable PT_LOAD data is eligible.
class DeriveReader final : public CanvasTextureDeriveReader {
 public:
  explicit DeriveReader(const ProcessFingerprint &fp) : fp_(fp) {}
  bool image(std::uint64_t address, void *out, std::size_t bytes,
             CanvasTextureImageRange kind) override {
    using Range = CanvasTextureImageRange;
    if (!address || bytes > UINT64_MAX-address) return false;
    bool valid = false;
    if (kind == Range::code) {
      for (const auto &[lo, hi] : fp_.exec_ranges)
        if (address >= lo && address < hi && bytes <= hi-address) valid = true;
    } else if (kind == Range::readonly) {
      for (const auto &line : fp_.exe_maps) {
        unsigned long long lo = 0, hi = 0; char perms[5] = {};
        if (std::sscanf(line.c_str(), "%llx-%llx %4s", &lo, &hi, perms) == 3 &&
            perms[0] == 'r' && perms[1] == '-' && address >= lo && address < hi &&
            bytes <= hi-address) valid = true;
      }
    } else {
#if defined(__linux__)
      struct Check { std::uint64_t address, bias; std::size_t bytes; bool found = false; };
      Check check{address, fp_.load_bias, bytes};
      dl_iterate_phdr([](dl_phdr_info *image, std::size_t, void *opaque) {
        auto &c = *static_cast<Check *>(opaque);
        if ((image->dlpi_name && *image->dlpi_name) || image->dlpi_addr != c.bias) return 0;
        for (std::size_t i = 0; i < image->dlpi_phnum; ++i) {
          const auto &p = image->dlpi_phdr[i];
          if (p.p_type != PT_LOAD || !(p.p_flags & PF_R) || !(p.p_flags & PF_W) ||
              (p.p_flags & PF_X) || p.p_vaddr > UINT64_MAX-c.bias) continue;
          const auto begin = c.bias+p.p_vaddr;
          if (c.address >= begin && c.address-begin < p.p_memsz &&
              c.bytes <= p.p_memsz-(c.address-begin)) { c.found = true; return 1; }
        }
        return 0;
      }, &check);
      valid = check.found;
#endif
    }
    if (!valid) return false;
    ++image_reads;
    if (!safe_copy(address, out, bytes)) return false;
    // Probe-only sabotage changes a local copy, never engine memory. It must refuse before
    // the global/storage pointer is read, and exercises the ordinary decoder refusal path.
    const char *sabotage = rs::env("GRC_CTRES_SABOTAGE");
    if (kind == Range::code && bytes == 29 && sabotage &&
        std::strcmp(sabotage, "derive-create-opcode") == 0)
      static_cast<unsigned char *>(out)[0] ^= 1;
    return true;
  }
  bool storage_vptr(std::uint64_t address, std::uint64_t *out) override {
    ++storage_reads;
    return safe_copy(address, out, sizeof(*out));
  }
 private:
  const ProcessFingerprint &fp_;
};
}  // namespace

void canvas_texture_resolver_attach(const Calibration &calib, const ProcessFingerprint &fp) {
  if (attachment_initialized) return;
  attachment_initialized = true;
  const char *flag = rs::env("GRC_CANVAS_TEXTURE_RESOLVE");
  if (!flag || std::strcmp(flag, "1") != 0) { resolver.attach(false, nullptr, "flag-off"); return; }
  if (!resolver.permanent_failure().empty()) {
    resolver.attach(true, nullptr, resolver.permanent_failure()); return;
  }
  // Other platforms need independently validated records and platform heap readers. Never
  // reinterpret a Linux record as a Windows or Mach-O layout just because versions agree.
  if (fp.platform != "linux-x86_64") {
    resolver.attach(true, nullptr, "platform-unrecorded"); return;
  }
  CanvasTextureRecord record;
  std::string why;
  if (!calib.canvas_texture_storage.empty()) {
    storage_source = "record";
    if (!CanvasTextureRecord::parse(calib.canvas_texture_storage, fp.load_bias, &record, &why)) {
      resolver.attach(true, nullptr, why); return;
    }
    if (!main_image_word(fp, record.global, false) || !main_image_word(fp, record.rd.vptr, true) ||
        !main_image_word(fp, record.gles3.vptr, true)) {
      resolver.attach(true, nullptr, "record-outside-image"); return;
    }
  } else {
    storage_source = "derived";
    std::int64_t slot = -1;
    for (const auto &[name, index] : calib.slots)
      if (name == "canvas_texture_create") { slot = index; break; }
    const auto table = calib.concrete_vtable_vaddr;
    if (slot < 0 || slot >= calib.slot_count || table > UINT64_MAX-fp.load_bias ||
        table+fp.load_bias > UINT64_MAX-16 ||
        std::uint64_t(slot) > (UINT64_MAX-table-fp.load_bias-16)/8) {
      resolver.attach(true, nullptr, "derive-create-slot"); return;
    }
    DeriveReader reader(fp);
    if (!derive_canvas_texture_record(reader, fp.platform, fp.version_string,
                                     table+fp.load_bias+16+8*std::uint64_t(slot), &record, &why)) {
      resolver.attach(true, nullptr, why); return;
    }
  }
  server = singleton_object("RenderingServer");
  render_call = method_bind("RenderingServer", "call_on_render_thread", 1611583062LL);
  sync_call = method_bind("RenderingServer", "force_sync", 3218959716LL);
  format_call = method_bind("RenderingServer", "texture_get_format", 1932918979LL);
  native_call = method_bind("RenderingServer", "texture_get_native_handle", 1834114100LL);
  auto create = method_bind("RenderingServer", "canvas_texture_create", 529393457LL);
  auto placeholder = method_bind("RenderingServer", "texture_2d_placeholder_create", 529393457LL);
  auto channel = method_bind("RenderingServer", "canvas_texture_set_channel", 3822119138LL);
  auto filter = method_bind("RenderingServer", "canvas_texture_set_texture_filter", 1155129294LL);
  auto repeat = method_bind("RenderingServer", "canvas_texture_set_texture_repeat", 1652956681LL);
  auto free = method_bind("RenderingServer", "free_rid", 2722037293LL);
  if (!server || !render_call || !sync_call || !format_call || !native_call || !create ||
      !placeholder || !channel || !filter || !repeat || !free ||
      !g_iface.callable_custom_create2 || !g_iface.variant_get_ptr_destructor ||
      !g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)) {
    resolver.attach(true, nullptr, "selfcheck-bind-unavailable"); return;
  }
  // Optional type-query bindings: unavailability must refuse only resolved channels with
  // type-unknown, while the independent owner-layout sentinel check still runs.
  auto device_call = method_bind("RenderingServer", "get_rendering_device", 1405107940LL);
  call_object_getter(device_call, server, &device);
  rd_texture_call = method_bind("RenderingServer", "texture_get_rd_texture", 2790148051LL);
  rd_valid_call = method_bind("RenderingDevice", "texture_is_valid", 3521089500LL);
  rd_format_call = method_bind("RenderingDevice", "texture_get_format", 1374471690LL);
  rd_type_call = method_bind("RDTextureFormat", "get_texture_type", 4036357416LL);
  resolver.attach(true, &record, "");
  // Two fresh CanvasTextures, with three distinct channels and different sampling state. These
  // calls pass through the existing standby hooks, so expected values come from the registry.
  // No sentinels are retained and no resolver work happens before attachment.
  std::uint64_t textures[3] = {}, canvases[2] = {};
  for (auto &rid : textures) call(placeholder, nullptr, &rid);
  std::vector<std::pair<std::uint64_t, CanvasTextureChannels>> known;
  for (int i = 0; i < 2; ++i) {
    call(create, nullptr, &canvases[i]);
    for (std::int64_t c = 0; c < 3; ++c) {
      const GDExtensionConstTypePtr args[] = {&canvases[i], &c, &textures[(c + i) % 3]};
      call(channel, args, nullptr);
    }
    const std::int64_t f = i + 1, r = 2 - i;
    const GDExtensionConstTypePtr fa[] = {&canvases[i], &f};
    const GDExtensionConstTypePtr ra[] = {&canvases[i], &r};
    call(filter, fa, nullptr); call(repeat, ra, nullptr);
    RegistryCanvasTexture expected;
    if (canvases[i] && registry_canvas_texture(canvases[i], &expected) &&
        expected.diffuse == textures[i] && expected.normal == textures[(i + 1) % 3] &&
        expected.specular == textures[(i + 2) % 3] && expected.diffuse && expected.normal &&
        expected.specular && expected.filter == f && expected.repeat == r) {
      known.push_back({canvases[i], {expected.diffuse, expected.normal, expected.specular,
                                   expected.filter, expected.repeat}});
    }
  }
  if (known.size() != 2) known.clear();
  Work work;
  work.known = &known;
  if (!dispatch(&work) && !work.called.load(std::memory_order_acquire)) {
    // A failed rendezvous cannot count as a self-check pass.
    LiveReader reader;
    resolver.selfcheck(reader, {});
  }
  for (auto rid : canvases) if (rid) { const GDExtensionConstTypePtr args[] = {&rid}; call(free, args, nullptr); }
  for (auto rid : textures) if (rid) { const GDExtensionConstTypePtr args[] = {&rid}; call(free, args, nullptr); }
  call(sync_call, nullptr, nullptr);
}

void canvas_texture_resolver_detach() {
  resolver.detach(); server = device = nullptr; attachment_initialized = false;
  rd_texture_call = rd_valid_call = rd_format_call = rd_type_call = nullptr;
  type_checks = 0;
  storage_source = "none"; image_reads = storage_reads = owner_reads = 0;
}

void canvas_texture_resolver_arm_begin() {
  resolver.arm_begin();
}

void canvas_texture_resolver_forget(std::uint64_t rid) {
  resolver.forget(rid);
}

bool canvas_texture_resolve(std::uint64_t rid, CanvasTextureChannels *out) {
  if (!resolver.enabled()) return false;
  bool ok = false;
  if (resolver.cached(rid, out, &ok)) return ok;
  const auto start = std::chrono::steady_clock::now();
  if (!resolver.ready()) {
    LiveReader reader;
    ok = resolver.resolve(reader, rid, out);  // disabled path never calls the reader
  } else {
    Work work;
    work.rid = rid;
    ok = dispatch(&work);
    *out = work.channels;
  }
  const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now() - start).count();
  resolver.elapsed(static_cast<std::uint64_t>(ns));
  return ok;
}

std::string canvas_texture_resolver_json() {
  auto json = resolver.json();
  json.insert(1, std::string("\"storage_source\":\"") + storage_source + "\",\"derivation_image_reads\":" +
      std::to_string(image_reads) + ",\"derivation_storage_reads\":" + std::to_string(storage_reads) +
      ",\"owner_reads\":" + std::to_string(owner_reads) +
      ",\"channel_type_checks\":" + std::to_string(type_checks) + ",");
  return json;
}
}  // namespace grc::rs
