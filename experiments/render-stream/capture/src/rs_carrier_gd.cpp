// rs_carrier_gd: the RenderStreamCarrier engine class; see rs_carrier_gd.h (CAR6).
//
// Raw GDExtension C interface, as the rest of the capture (no godot-cpp). Opaque engine values
// are held in buffers of their 64-bit sizes (extension_api.json builtin_class_sizes, float_64 and
// float_32 alike): Variant 24, String 8, StringName 8, PackedByteArray 16 bytes.
#include "rs_carrier_gd.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "grc_carrier.h"
#include "iface.h"
#include "rs_carrier_ext.h"

namespace grc {
namespace live {
namespace {

constexpr const char *kClassName = "RenderStreamCarrier";
// Object.emit_signal (vararg) and PackedByteArray.resize, extension_api.json (4.5.1) hashes.
constexpr std::int64_t kEmitSignalHash = 4047867050LL;
constexpr std::int64_t kPackedByteArrayResizeHash = 848867239LL;
constexpr std::uint32_t kUsageDefault = 6;  // PROPERTY_USAGE_DEFAULT

struct alignas(8) GVariant {
  std::uint8_t data[24];
};
struct alignas(8) GString {
  void *p = nullptr;
};
struct alignas(8) GStringName {
  void *p = nullptr;
};
struct alignas(8) GPacked {
  std::uint8_t data[16];
};

struct Fns {
  GDExtensionInterfaceClassdbRegisterExtensionClass4 register_class = nullptr;
  GDExtensionInterfaceClassdbRegisterExtensionClassMethod register_method = nullptr;
  GDExtensionInterfaceClassdbRegisterExtensionClassSignal register_signal = nullptr;
  GDExtensionInterfaceClassdbUnregisterExtensionClass unregister_class = nullptr;
  GDExtensionInterfaceObjectSetInstance object_set_instance = nullptr;
  GDExtensionInterfaceClassdbConstructObject2 construct_object = nullptr;
  GDExtensionInterfaceObjectMethodBindCall bind_call = nullptr;
  GDExtensionInterfacePackedByteArrayOperatorIndex pba_index = nullptr;
  GDExtensionInterfaceStringNewWithUtf8CharsAndLen2 string_new = nullptr;
  GDExtensionInterfaceStringToUtf8Chars string_to_utf8 = nullptr;
  GDExtensionInterfaceStringNameNewWithLatin1Chars string_name_new = nullptr;
  GDExtensionInterfaceGetLibraryPath get_library_path = nullptr;
  GDExtensionInterfaceVariantGetType variant_type = nullptr;
  GDExtensionInterfaceVariantDestroy variant_destroy = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_int = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_string = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_string_name = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_bytes = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_bool = nullptr;
  GDExtensionTypeFromVariantConstructorFunc int_from_var = nullptr;
  GDExtensionTypeFromVariantConstructorFunc string_from_var = nullptr;
  GDExtensionPtrConstructor bytes_new = nullptr;
  GDExtensionPtrDestructor string_destroy = nullptr;
  GDExtensionPtrDestructor string_name_destroy = nullptr;
  GDExtensionPtrDestructor bytes_destroy = nullptr;
  GDExtensionPtrBuiltInMethod bytes_resize = nullptr;
  GDExtensionMethodBindPtr emit = nullptr;
};

Fns g_fn;
bool g_registered = false;

template <typename T>
bool resolve(const char *name, T *slot, std::string *missing) {
  *slot = reinterpret_cast<T>(g_iface.get_proc_address(name));
  if (*slot == nullptr && missing->empty()) *missing = name;
  return *slot != nullptr;
}

// --- engine value helpers ----------------------------------------------------------------------

class SName {
 public:
  explicit SName(const char *latin1) { g_fn.string_name_new(&v_, latin1, false); }
  ~SName() { g_fn.string_name_destroy(&v_); }
  SName(const SName &) = delete;
  SName &operator=(const SName &) = delete;
  GDExtensionStringNamePtr ptr() { return &v_; }

 private:
  GStringName v_;
};

void string_init(void *uninit, const std::string &text) {
  g_fn.string_new(uninit, text.data(), static_cast<GDExtensionInt>(text.size()));
}

std::string string_read(const void *godot_string) {
  const GDExtensionInt n = g_fn.string_to_utf8(godot_string, nullptr, 0);
  std::string out(static_cast<std::size_t>(n > 0 ? n : 0), '\0');
  if (n > 0) g_fn.string_to_utf8(godot_string, out.data(), n);
  return out;
}

// One copy: `len` bytes into a new PackedByteArray at `uninit`.
void bytes_init(void *uninit, const std::uint8_t *data, std::size_t len) {
  g_fn.bytes_new(uninit, nullptr);
  if (len == 0) return;
  const std::int64_t n = static_cast<std::int64_t>(len);
  const GDExtensionConstTypePtr args[1] = {&n};
  std::int64_t err = 0;
  g_fn.bytes_resize(uninit, args, &err, 1);
  std::memcpy(g_fn.pba_index(uninit, 0), data, len);
}

// A Variant built from a typed value, destroyed with the holder.
struct Var {
  GVariant v;
  bool live = false;
  ~Var() {
    if (live) g_fn.variant_destroy(&v);
  }
  GDExtensionConstVariantPtr ptr() const { return &v; }
};

void var_int(Var *out, std::int64_t value) {
  g_fn.var_from_int(&out->v, &value);
  out->live = true;
}

void var_string(Var *out, const std::string &text) {
  GString s;
  string_init(&s, text);
  g_fn.var_from_string(&out->v, &s);
  g_fn.string_destroy(&s);
  out->live = true;
}

void var_bytes(Var *out, const std::uint8_t *data, std::size_t len) {
  GPacked b;
  bytes_init(&b, data, len);
  g_fn.var_from_bytes(&out->v, &b);  // shares the array (copy-on-write), no byte copy
  g_fn.bytes_destroy(&b);
  out->live = true;
}

// Object.emit_signal(name, args...) on `object`.
void emit(GDExtensionObjectPtr object, const char *signal, const Var *const *args, int count) {
  SName name(signal);
  Var vname;
  g_fn.var_from_string_name(&vname.v, name.ptr());
  vname.live = true;
  GDExtensionConstVariantPtr argv[4] = {vname.ptr(), nullptr, nullptr, nullptr};
  for (int i = 0; i < count && i < 3; ++i) argv[i + 1] = args[i]->ptr();
  GVariant ret;
  GDExtensionCallError error;
  std::memset(&error, 0, sizeof(error));
  g_fn.bind_call(g_fn.emit, object, argv, count + 1, &ret, &error);
  g_fn.variant_destroy(&ret);
}

// --- the carrier state ---------------------------------------------------------------------------

struct Outbound {
  enum Kind { Binary, Text, Close } kind = Binary;
  std::uint32_t local = 0;
  grc_buf buf{nullptr, 0, nullptr};
  std::uint16_t code = 0;
  std::string reason;
};

struct Conn {
  std::uint64_t queued = 0;  // accepted from the hub, not yet delivered to script code
  std::uint64_t max = 0;
  bool closing = false;  // close() delivered or queued; sends are refused
};

enum class Phase { Unregistered, Registered, Started, Stopped, Destroyed };

const char *phase_name(Phase p) {
  switch (p) {
    case Phase::Unregistered:
      return "unregistered";
    case Phase::Registered:
      return "registered";
    case Phase::Started:
      return "started";
    case Phase::Stopped:
      return "stopped";
    case Phase::Destroyed:
      return "destroyed";
  }
  return "unknown";
}

// Everything here runs on the main thread (the hub's calls, the lifecycle, script methods and the
// flush); the mutex only makes that an invariant rather than an assumption. It is never held while
// the host is called or a signal is emitted.
struct State {
  std::mutex mu;
  GDExtensionObjectPtr owner = nullptr;  // null once the object is freed
  std::string name;
  int index = -1;
  std::string last_error;
  Phase phase = Phase::Unregistered;
  const grc_carrier_host_v1 *host = nullptr;  // set at start, kept (for release) after stop
  bool host_live = false;                     // start() .. stop()
  std::uint64_t limit = 16u << 20;            // the host's max_queued_bytes
  std::deque<Outbound> out;
  std::map<std::uint32_t, Conn> conns;
  bool started_pending = false;
};

std::mutex g_list_mu;
std::vector<std::shared_ptr<State>> g_list;
std::atomic<bool> g_any{false};

struct Instance {
  GDExtensionObjectPtr object = nullptr;
  std::shared_ptr<State> state;
};

void release(const grc_carrier_host_v1 *host, const grc_buf &buf) {
  if (host != nullptr && buf.owner != nullptr) host->release(host->host, buf.owner);
}

// Delivers `s`'s queue. Called by the flush and by stop().
void flush_one(const std::shared_ptr<State> &sp) {
  State &s = *sp;
  std::deque<Outbound> out;
  bool started = false;
  const grc_carrier_host_v1 *host = nullptr;
  GDExtensionObjectPtr owner = nullptr;
  bool live = false;
  {
    std::lock_guard<std::mutex> lock(s.mu);
    out.swap(s.out);
    started = s.started_pending;
    s.started_pending = false;
    host = s.host;
    owner = s.owner;
    live = s.host_live;
  }
  if (started && owner != nullptr) emit(owner, "started", nullptr, 0);
  for (Outbound &o : out) {
    bool deliver = false;
    {
      std::lock_guard<std::mutex> lock(s.mu);
      owner = s.owner;  // a handler may have dropped the last reference
      const auto it = s.conns.find(o.local);
      deliver = owner != nullptr && it != s.conns.end();
      if (it != s.conns.end() && o.kind != Outbound::Close) it->second.queued -= o.buf.len;
    }
    if (!deliver) {
      release(host, o.buf);
      continue;
    }
    Var local;
    var_int(&local, o.local);
    if (o.kind == Outbound::Binary) {
      Var data;
      var_bytes(&data, o.buf.data, o.buf.len);  // the one copy
      release(host, o.buf);
      const Var *args[2] = {&local, &data};
      emit(owner, "send_binary", args, 2);
    } else if (o.kind == Outbound::Text) {
      Var text;
      var_string(&text, std::string(reinterpret_cast<const char *>(o.buf.data), o.buf.len));
      release(host, o.buf);
      const Var *args[2] = {&local, &text};
      emit(owner, "send_text", args, 2);
    } else {
      Var code;
      var_int(&code, o.code);
      Var reason;
      var_string(&reason, o.reason);
      const Var *args[3] = {&local, &code, &reason};
      emit(owner, "close", args, 3);
    }
  }
  // The object is gone: its open connections can never finish, so they end here (1001).
  std::vector<std::uint32_t> orphaned;
  {
    std::lock_guard<std::mutex> lock(s.mu);
    if (s.owner == nullptr && live) {
      for (const auto &c : s.conns) orphaned.push_back(c.first);
      s.conns.clear();
    }
  }
  static const char kGone[] = "carrier object freed";
  for (std::uint32_t local : orphaned) {
    host->closed(host->host, local, 1001, kGone, sizeof(kGone) - 1);
  }
}

// --- grc_carrier_v1 ------------------------------------------------------------------------------

State &state_of(void *self) { return **static_cast<std::shared_ptr<State> *>(self); }

int v_start(void *self, const grc_carrier_host_v1 *host, char *error, std::size_t error_cap) {
  State &s = state_of(self);
  std::lock_guard<std::mutex> lock(s.mu);
  if (s.owner == nullptr) {
    std::snprintf(error, error_cap, "the RenderStreamCarrier object was freed before live start");
    return 0;
  }
  s.host = host;
  s.host_live = true;
  s.phase = Phase::Started;
  s.started_pending = true;
  if (const char *q = host->config(host->host, "max_queued_bytes")) {
    const unsigned long long v = std::strtoull(q, nullptr, 10);
    if (v > 0) s.limit = v;
  }
  return 1;
}

void v_stop(void *self) {
  const std::shared_ptr<State> sp = *static_cast<std::shared_ptr<State> *>(self);
  flush_one(sp);  // the hub's last sends and closes reach script code before the stop
  std::deque<Outbound> left;
  const grc_carrier_host_v1 *host = nullptr;
  GDExtensionObjectPtr owner = nullptr;
  {
    std::lock_guard<std::mutex> lock(sp->mu);
    left.swap(sp->out);  // only what a handler of the flush above queued
    host = sp->host;
    owner = sp->owner;
    sp->conns.clear();
    sp->host_live = false;
    sp->phase = Phase::Stopped;
  }
  for (const Outbound &o : left) release(host, o.buf);
  if (owner != nullptr) emit(owner, "stopped", nullptr, 0);
}

int queue_send(void *self, std::uint32_t local, grc_buf message, Outbound::Kind kind) {
  State &s = state_of(self);
  const grc_carrier_host_v1 *host = nullptr;
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(s.mu);
    host = s.host;
    const auto it = s.conns.find(local);
    if (s.host_live && it != s.conns.end() && !it->second.closing) {
      Conn &c = it->second;
      if (c.queued + message.len > s.limit) {
        // rs_ws's rule: a send that would pass the limit fails and closes the connection 1008.
        c.closing = true;
        Outbound close;
        close.kind = Outbound::Close;
        close.local = local;
        close.code = 1008;
        close.reason = "send queue limit";
        s.out.push_back(std::move(close));
      } else {
        Outbound o;
        o.kind = kind;
        o.local = local;
        o.buf = message;
        s.out.push_back(o);
        c.queued += message.len;
        if (c.queued > c.max) c.max = c.queued;
        ok = true;
      }
    }
  }
  if (!ok) release(host, message);
  return ok ? 1 : 0;
}

int v_send_binary(void *self, std::uint32_t local, grc_buf message) {
  return queue_send(self, local, message, Outbound::Binary);
}

int v_send_text(void *self, std::uint32_t local, grc_buf message) {
  return queue_send(self, local, message, Outbound::Text);
}

void v_close(void *self, std::uint32_t local, std::uint16_t code, const char *reason,
             std::size_t len) {
  State &s = state_of(self);
  std::lock_guard<std::mutex> lock(s.mu);
  const auto it = s.conns.find(local);
  if (it == s.conns.end() || it->second.closing) return;
  it->second.closing = true;
  Outbound o;
  o.kind = Outbound::Close;
  o.local = local;
  o.code = code;
  o.reason.assign(reason != nullptr ? reason : "", reason != nullptr ? len : 0);
  s.out.push_back(std::move(o));
}

std::uint64_t v_queued_bytes(void *self, std::uint32_t local) {
  State &s = state_of(self);
  std::lock_guard<std::mutex> lock(s.mu);
  const auto it = s.conns.find(local);
  return it != s.conns.end() ? it->second.queued : 0;
}

std::uint64_t v_max_queued_bytes(void *self, std::uint32_t local) {
  State &s = state_of(self);
  std::lock_guard<std::mutex> lock(s.mu);
  const auto it = s.conns.find(local);
  return it != s.conns.end() ? it->second.max : 0;
}

void v_destroy(void *self) {
  auto *holder = static_cast<std::shared_ptr<State> *>(self);
  {
    std::lock_guard<std::mutex> lock((*holder)->mu);
    (*holder)->phase = Phase::Destroyed;
    (*holder)->host = nullptr;
  }
  delete holder;
}

// --- script methods ------------------------------------------------------------------------------

enum class T { Nil, Bool, Int, String, Bytes };

struct Value {
  T type = T::Nil;
  bool b = false;
  std::int64_t i = 0;
  std::string s;
  std::vector<std::uint8_t> bytes;
};

Value nil() { return Value(); }
Value boolean(bool b) {
  Value v;
  v.type = T::Bool;
  v.b = b;
  return v;
}
Value integer(std::int64_t i) {
  Value v;
  v.type = T::Int;
  v.i = i;
  return v;
}
Value string(std::string s) {
  Value v;
  v.type = T::String;
  v.s = std::move(s);
  return v;
}

using Args = std::vector<Value>;
using Impl = Value (*)(Instance *self, const Args &a);

bool local_ok(std::int64_t local) { return local >= 1 && local <= GRC_CARRIER_LOCAL_MAX; }

// The host while the carrier runs (start .. stop), else null.
const grc_carrier_host_v1 *live_host(State &s) {
  std::lock_guard<std::mutex> lock(s.mu);
  return s.host_live ? s.host : nullptr;
}

// register(name: String) -> int: grc_carrier_register with this object's carrier.
Value m_register(Instance *self, const Args &a) {
  State &s = *self->state;
  {
    std::lock_guard<std::mutex> lock(s.mu);
    if (s.phase != Phase::Unregistered) {
      s.last_error = "carrier-taken: this object is registered already";
      return integer(-1);
    }
    s.name = a[0].s;
  }
  grc_carrier_v1 vt;
  std::memset(&vt, 0, sizeof(vt));
  vt.abi_version = GRC_CARRIER_ABI_VERSION;
  vt.size = sizeof(grc_carrier_v1);
  vt.name = s.name.c_str();  // lives as long as the State, which the carrier's `self` holds
  auto *holder = new std::shared_ptr<State>(self->state);
  vt.self = holder;
  vt.start = &v_start;
  vt.stop = &v_stop;
  vt.send_binary = &v_send_binary;
  vt.send_text = &v_send_text;
  vt.close = &v_close;
  vt.queued_bytes = &v_queued_bytes;
  vt.max_queued_bytes = &v_max_queued_bytes;
  vt.destroy = &v_destroy;
  std::string why;
  const int index = carrier_registry().add(&vt, &why);
  std::lock_guard<std::mutex> lock(s.mu);
  if (index < 0) {
    delete holder;  // refused: the registry kept nothing
    s.last_error = why;
    return integer(-1);
  }
  s.index = index;
  s.phase = Phase::Registered;
  s.last_error.clear();
  {
    std::lock_guard<std::mutex> list_lock(g_list_mu);
    g_list.push_back(self->state);
  }
  g_any.store(true, std::memory_order_release);
  return integer(index);
}

// TRK1: whether `sp` is one of config("track_subprotocols") (a comma list; NULL with tracks off).
bool is_track_subprotocol(const grc_carrier_host_v1 *host, const std::string &sp) {
  if (host->size < offsetof(grc_carrier_host_v1, admit_subprotocol) + sizeof(void *) ||
      host->admit_subprotocol == nullptr || sp.empty()) {
    return false;
  }
  const char *list = host->config(host->host, "track_subprotocols");
  if (list == nullptr) return false;
  const std::string text(list);
  std::size_t start = 0;
  while (start <= text.size()) {
    std::size_t comma = text.find(',', start);
    if (comma == std::string::npos) comma = text.size();
    if (text.compare(start, comma - start, sp) == 0 && comma - start == sp.size()) return true;
    start = comma + 1;
  }
  return false;
}

// opened(local: int, subprotocol: String, origin: String) -> bool: admit, then opened.
Value m_opened(Instance *self, const Args &a) {
  State &s = *self->state;
  const grc_carrier_host_v1 *host = live_host(s);
  if (host == nullptr || !local_ok(a[0].i)) return boolean(false);
  const auto local = static_cast<std::uint32_t>(a[0].i);
  {
    std::lock_guard<std::mutex> lock(s.mu);
    if (s.conns.count(local) != 0) return boolean(false);
  }
  // admits by subprotocol, so a track subprotocol takes a track slot.
  // A subprotocol outside the track list keeps admit()'s behaviour exactly.
  const bool track = is_track_subprotocol(host, a[1].s);
  if ((track ? host->admit_subprotocol(host->host, local, a[1].s.data(), a[1].s.size())
             : host->admit(host->host, local)) == 0) {
    return boolean(false);  // the pool is full
  }
  {
    std::lock_guard<std::mutex> lock(s.mu);
    s.conns[local] = Conn();
  }
  host->opened(host->host, local, a[1].s.data(), a[1].s.size(), a[2].s.data(), a[2].s.size());
  return boolean(true);
}

// text(local: int, text: String) -> void
Value m_text(Instance *self, const Args &a) {
  State &s = *self->state;
  const grc_carrier_host_v1 *host = live_host(s);
  if (host == nullptr || !local_ok(a[0].i)) return nil();
  const auto local = static_cast<std::uint32_t>(a[0].i);
  {
    std::lock_guard<std::mutex> lock(s.mu);
    if (s.conns.count(local) == 0) return nil();
  }
  host->text(host->host, local, a[1].s.data(), a[1].s.size());
  return nil();
}

// closed(local: int, code: int, reason: String) -> void: the peer is gone (or a close finished).
Value m_closed(Instance *self, const Args &a) {
  State &s = *self->state;
  const grc_carrier_host_v1 *host = live_host(s);
  if (host == nullptr || !local_ok(a[0].i)) return nil();
  const auto local = static_cast<std::uint32_t>(a[0].i);
  std::vector<grc_buf> dropped;
  {
    std::lock_guard<std::mutex> lock(s.mu);
    if (s.conns.erase(local) == 0) return nil();
    for (auto it = s.out.begin(); it != s.out.end();) {
      if (it->local == local) {
        if (it->kind != Outbound::Close) dropped.push_back(it->buf);
        it = s.out.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (const grc_buf &b : dropped) release(host, b);
  const std::int64_t code = a[1].i < 0 || a[1].i > 65535 ? 1002 : a[1].i;
  host->closed(host->host, local, static_cast<std::uint16_t>(code), a[2].s.data(), a[2].s.size());
  return nil();
}

// config(key: String) -> String ("" when unset or not started)
Value m_config(Instance *self, const Args &a) {
  const grc_carrier_host_v1 *host = live_host(*self->state);
  if (host == nullptr) return string("");
  const char *v = host->config(host->host, a[0].s.c_str());
  return string(v != nullptr ? v : "");
}

// token_ok(token: String) -> bool
Value m_token_ok(Instance *self, const Args &a) {
  const grc_carrier_host_v1 *host = live_host(*self->state);
  return boolean(host != nullptr && host->token_ok(host->host, a[0].s.data(), a[0].s.size()) != 0);
}

// origin_ok(origin: String) -> bool
Value m_origin_ok(Instance *self, const Args &a) {
  const grc_carrier_host_v1 *host = live_host(*self->state);
  return boolean(host != nullptr && host->origin_ok(host->host, a[0].s.data(), a[0].s.size()) != 0);
}

bool hex64(const std::string &h) {
  if (h.size() != 64) return false;
  for (char c : h) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// lookup_resource(hash: String) -> PackedByteArray: the identity body of a resource the hub
// serves (64 lowercase hex), empty when unknown; reported to the hub as a served fetch (200 or
// 404), as an HTTP GET on `ws` is.
Value m_lookup_resource(Instance *self, const Args &a) {
  Value out;
  out.type = T::Bytes;
  const grc_carrier_host_v1 *host = live_host(*self->state);
  if (host == nullptr || !hex64(a[0].s)) return out;
  grc_buf buf{nullptr, 0, nullptr};
  if (host->lookup(host->host, a[0].s.data(), GRC_CODING_IDENTITY, &buf) == 0) {
    host->resource_served(host->host, 0, a[0].s.data(), 404, GRC_CODING_IDENTITY, 0, 0);
    return out;
  }
  out.bytes.assign(buf.data, buf.data + buf.len);
  host->release(host->host, buf.owner);
  host->resource_served(host->host, 0, a[0].s.data(), 200, GRC_CODING_IDENTITY, out.bytes.size(),
                        out.bytes.size());
  return out;
}

Value m_status(Instance *self, const Args &) {
  std::lock_guard<std::mutex> lock(self->state->mu);
  return string(phase_name(self->state->phase));
}

Value m_carrier_index(Instance *self, const Args &) {
  std::lock_guard<std::mutex> lock(self->state->mu);
  return integer(self->state->index);
}

Value m_carrier_name(Instance *self, const Args &) {
  std::lock_guard<std::mutex> lock(self->state->mu);
  return string(self->state->name);
}

Value m_last_error(Instance *self, const Args &) {
  std::lock_guard<std::mutex> lock(self->state->mu);
  return string(self->state->last_error);
}

// static library_path() -> String: the capture library, for dlopen(RTLD_NOLOAD) + dlsym.
Value m_library_path(Instance *, const Args &) {
  GString path;
  g_fn.get_library_path(g_iface.library, &path);
  std::string out = string_read(&path);
  g_fn.string_destroy(&path);
  return string(out);
}

struct Method {
  const char *name;
  Impl impl;
  T ret;
  std::vector<std::pair<T, const char *>> args;
  bool is_static = false;
};

GDExtensionVariantType vtype(T t) {
  switch (t) {
    case T::Bool:
      return GDEXTENSION_VARIANT_TYPE_BOOL;
    case T::Int:
      return GDEXTENSION_VARIANT_TYPE_INT;
    case T::String:
      return GDEXTENSION_VARIANT_TYPE_STRING;
    case T::Bytes:
      return GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY;
    case T::Nil:
      break;
  }
  return GDEXTENSION_VARIANT_TYPE_NIL;
}

void write_variant(const Value &v, GDExtensionVariantPtr r_return) {
  // r_return is the engine's Nil Variant: constructing over it leaks nothing.
  switch (v.type) {
    case T::Bool: {
      GDExtensionBool b = v.b ? 1 : 0;
      g_fn.var_from_bool(r_return, &b);
      break;
    }
    case T::Int: {
      std::int64_t i = v.i;
      g_fn.var_from_int(r_return, &i);
      break;
    }
    case T::String: {
      GString s;
      string_init(&s, v.s);
      g_fn.var_from_string(r_return, &s);
      g_fn.string_destroy(&s);
      break;
    }
    case T::Bytes: {
      GPacked b;
      bytes_init(&b, v.bytes.data(), v.bytes.size());
      g_fn.var_from_bytes(r_return, &b);
      g_fn.bytes_destroy(&b);
      break;
    }
    case T::Nil:
      break;
  }
}

void call_dispatch(void *userdata, GDExtensionClassInstancePtr instance,
                   const GDExtensionConstVariantPtr *args, GDExtensionInt argc,
                   GDExtensionVariantPtr r_return, GDExtensionCallError *r_error) {
  const Method &m = *static_cast<const Method *>(userdata);
  const auto want = static_cast<GDExtensionInt>(m.args.size());
  if (argc != want) {
    r_error->error = argc < want ? GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS
                                 : GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS;
    r_error->expected = static_cast<int32_t>(want);
    return;
  }
  Args values(m.args.size());
  for (std::size_t i = 0; i < m.args.size(); ++i) {
    const T t = m.args[i].first;
    if (g_fn.variant_type(args[i]) != vtype(t)) {
      r_error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
      r_error->argument = static_cast<int32_t>(i);
      r_error->expected = vtype(t);
      return;
    }
    values[i].type = t;
    if (t == T::Int) {
      g_fn.int_from_var(&values[i].i, const_cast<GDExtensionVariantPtr>(args[i]));
    } else if (t == T::String) {
      GString s;
      g_fn.string_from_var(&s, const_cast<GDExtensionVariantPtr>(args[i]));
      values[i].s = string_read(&s);
      g_fn.string_destroy(&s);
    }
  }
  r_error->error = GDEXTENSION_CALL_OK;
  const Value v = m.impl(static_cast<Instance *>(instance), values);
  if (m.ret != T::Nil) write_variant(v, r_return);
}

void ptrcall_dispatch(void *userdata, GDExtensionClassInstancePtr instance,
                      const GDExtensionConstTypePtr *args, GDExtensionTypePtr r_ret) {
  const Method &m = *static_cast<const Method *>(userdata);
  Args values(m.args.size());
  for (std::size_t i = 0; i < m.args.size(); ++i) {
    values[i].type = m.args[i].first;
    if (values[i].type == T::Int) {
      values[i].i = *static_cast<const std::int64_t *>(args[i]);
    } else if (values[i].type == T::String) {
      values[i].s = string_read(args[i]);
    }
  }
  const Value v = m.impl(static_cast<Instance *>(instance), values);
  // ptrcall's return slot holds a constructed value of the return type.
  switch (m.ret) {
    case T::Bool:
      *static_cast<GDExtensionBool *>(r_ret) = v.b ? 1 : 0;
      break;
    case T::Int:
      *static_cast<std::int64_t *>(r_ret) = v.i;
      break;
    case T::String:
      g_fn.string_destroy(r_ret);
      string_init(r_ret, v.s);
      break;
    case T::Bytes:
      g_fn.bytes_destroy(r_ret);
      bytes_init(r_ret, v.bytes.data(), v.bytes.size());
      break;
    case T::Nil:
      break;
  }
}

const std::vector<Method> &methods() {
  static const std::vector<Method> list = {
      {"register", &m_register, T::Int, {{T::String, "name"}}},
      {"opened", &m_opened, T::Bool, {{T::Int, "local"}, {T::String, "subprotocol"}, {T::String, "origin"}}},
      {"text", &m_text, T::Nil, {{T::Int, "local"}, {T::String, "text"}}},
      {"closed", &m_closed, T::Nil, {{T::Int, "local"}, {T::Int, "code"}, {T::String, "reason"}}},
      {"config", &m_config, T::String, {{T::String, "key"}}},
      {"token_ok", &m_token_ok, T::Bool, {{T::String, "token"}}},
      {"origin_ok", &m_origin_ok, T::Bool, {{T::String, "origin"}}},
      {"lookup_resource", &m_lookup_resource, T::Bytes, {{T::String, "sha256"}}},
      {"status", &m_status, T::String, {}},
      {"carrier_index", &m_carrier_index, T::Int, {}},
      {"carrier_name", &m_carrier_name, T::String, {}},
      {"last_error", &m_last_error, T::String, {}},
      {"library_path", &m_library_path, T::String, {}, true},
  };
  return list;
}

// --- class registration --------------------------------------------------------------------------

GDExtensionObjectPtr create_instance(void *, GDExtensionBool) {
  SName parent("RefCounted");
  GDExtensionObjectPtr object = g_fn.construct_object(parent.ptr());
  auto *instance = new Instance();
  instance->object = object;
  instance->state = std::make_shared<State>();
  instance->state->owner = object;
  SName cls(kClassName);
  g_fn.object_set_instance(object, cls.ptr(), instance);
  return object;
}

void free_instance(void *, GDExtensionClassInstancePtr p) {
  auto *instance = static_cast<Instance *>(p);
  if (instance == nullptr) return;
  {
    std::lock_guard<std::mutex> lock(instance->state->mu);
    instance->state->owner = nullptr;  // the next flush ends its connections (1001)
  }
  delete instance;
}

// Property info with owned names, kept alive across one registration call.
struct Prop {
  SName name;
  SName class_name;
  GString hint;
  GDExtensionPropertyInfo info;
  Prop(T t, const char *n) : name(n), class_name("") {
    string_init(&hint, "");
    info.type = vtype(t);
    info.name = name.ptr();
    info.class_name = class_name.ptr();
    info.hint = 0;
    info.hint_string = &hint;
    info.usage = kUsageDefault;
  }
  ~Prop() { g_fn.string_destroy(&hint); }
};

void register_method(GDExtensionStringNamePtr cls, const Method &m) {
  SName name(m.name);
  Prop ret(m.ret, "");
  std::vector<std::unique_ptr<Prop>> props;
  std::vector<GDExtensionPropertyInfo> infos;
  std::vector<GDExtensionClassMethodArgumentMetadata> meta;
  for (const auto &arg : m.args) {
    props.push_back(std::make_unique<Prop>(arg.first, arg.second));
    infos.push_back(props.back()->info);
    meta.push_back(arg.first == T::Int ? GDEXTENSION_METHOD_ARGUMENT_METADATA_INT_IS_INT64
                                       : GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE);
  }
  GDExtensionClassMethodInfo info;
  std::memset(&info, 0, sizeof(info));
  info.name = name.ptr();
  info.method_userdata = const_cast<Method *>(&m);
  info.call_func = &call_dispatch;
  info.ptrcall_func = &ptrcall_dispatch;
  info.method_flags = m.is_static ? GDEXTENSION_METHOD_FLAG_STATIC : GDEXTENSION_METHOD_FLAGS_DEFAULT;
  info.has_return_value = m.ret != T::Nil ? 1 : 0;
  info.return_value_info = &ret.info;
  info.return_value_metadata = m.ret == T::Int ? GDEXTENSION_METHOD_ARGUMENT_METADATA_INT_IS_INT64
                                               : GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
  info.argument_count = static_cast<uint32_t>(infos.size());
  info.arguments_info = infos.empty() ? nullptr : infos.data();
  info.arguments_metadata = meta.empty() ? nullptr : meta.data();
  g_fn.register_method(g_iface.library, cls, &info);
}

void register_signal(GDExtensionStringNamePtr cls, const char *signal,
                     const std::vector<std::pair<T, const char *>> &args) {
  SName name(signal);
  std::vector<std::unique_ptr<Prop>> props;
  std::vector<GDExtensionPropertyInfo> infos;
  for (const auto &arg : args) {
    props.push_back(std::make_unique<Prop>(arg.first, arg.second));
    infos.push_back(props.back()->info);
  }
  g_fn.register_signal(g_iface.library, cls, name.ptr(), infos.empty() ? nullptr : infos.data(),
                       static_cast<GDExtensionInt>(infos.size()));
}

}  // namespace

bool gd_carrier_class_register(std::string *why) {
  if (g_registered) return true;
  if (g_iface.get_proc_address == nullptr || g_iface.library == nullptr) {
    *why = "carrier-class-unavailable: no GDExtension interface";
    return false;
  }
  std::string missing;
  Fns &f = g_fn;
  resolve("classdb_register_extension_class4", &f.register_class, &missing);
  resolve("classdb_register_extension_class_method", &f.register_method, &missing);
  resolve("classdb_register_extension_class_signal", &f.register_signal, &missing);
  resolve("classdb_unregister_extension_class", &f.unregister_class, &missing);
  resolve("object_set_instance", &f.object_set_instance, &missing);
  resolve("classdb_construct_object2", &f.construct_object, &missing);
  resolve("object_method_bind_call", &f.bind_call, &missing);
  resolve("packed_byte_array_operator_index", &f.pba_index, &missing);
  resolve("string_new_with_utf8_chars_and_len2", &f.string_new, &missing);
  resolve("string_to_utf8_chars", &f.string_to_utf8, &missing);
  resolve("string_name_new_with_latin1_chars", &f.string_name_new, &missing);
  resolve("get_library_path", &f.get_library_path, &missing);
  resolve("variant_get_type", &f.variant_type, &missing);
  resolve("variant_destroy", &f.variant_destroy, &missing);
  GDExtensionInterfaceGetVariantFromTypeConstructor from_type = nullptr;
  GDExtensionInterfaceGetVariantToTypeConstructor to_type = nullptr;
  GDExtensionInterfaceVariantGetPtrConstructor ptr_ctor = nullptr;
  GDExtensionInterfaceVariantGetPtrDestructor ptr_dtor = nullptr;
  GDExtensionInterfaceVariantGetPtrBuiltinMethod builtin = nullptr;
  GDExtensionInterfaceClassdbGetMethodBind get_bind = nullptr;
  resolve("get_variant_from_type_constructor", &from_type, &missing);
  resolve("get_variant_to_type_constructor", &to_type, &missing);
  resolve("variant_get_ptr_constructor", &ptr_ctor, &missing);
  resolve("variant_get_ptr_destructor", &ptr_dtor, &missing);
  resolve("variant_get_ptr_builtin_method", &builtin, &missing);
  resolve("classdb_get_method_bind", &get_bind, &missing);
  if (!missing.empty()) {
    *why = "carrier-class-unavailable: missing " + missing;
    return false;
  }
  f.var_from_int = from_type(GDEXTENSION_VARIANT_TYPE_INT);
  f.var_from_bool = from_type(GDEXTENSION_VARIANT_TYPE_BOOL);
  f.var_from_string = from_type(GDEXTENSION_VARIANT_TYPE_STRING);
  f.var_from_string_name = from_type(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
  f.var_from_bytes = from_type(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  f.int_from_var = to_type(GDEXTENSION_VARIANT_TYPE_INT);
  f.string_from_var = to_type(GDEXTENSION_VARIANT_TYPE_STRING);
  f.bytes_new = ptr_ctor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, 0);
  f.string_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_STRING);
  f.string_name_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
  f.bytes_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  {
    SName resize("resize");
    f.bytes_resize = builtin(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, resize.ptr(),
                             kPackedByteArrayResizeHash);
  }
  {
    SName object("Object");
    SName emit_name("emit_signal");
    f.emit = get_bind(object.ptr(), emit_name.ptr(), kEmitSignalHash);
  }
  if (f.var_from_int == nullptr || f.var_from_bool == nullptr || f.var_from_string == nullptr ||
      f.var_from_string_name == nullptr || f.var_from_bytes == nullptr || f.int_from_var == nullptr ||
      f.string_from_var == nullptr || f.bytes_new == nullptr || f.string_destroy == nullptr ||
      f.string_name_destroy == nullptr || f.bytes_destroy == nullptr || f.bytes_resize == nullptr ||
      f.emit == nullptr) {
    *why = "carrier-class-unavailable: a builtin constructor, PackedByteArray.resize or "
           "Object.emit_signal is missing at the expected hash";
    return false;
  }

  SName cls(kClassName);
  SName parent("RefCounted");
  GDExtensionClassCreationInfo4 info;
  std::memset(&info, 0, sizeof(info));
  info.is_exposed = 1;
  info.create_instance_func = &create_instance;
  info.free_instance_func = &free_instance;
  f.register_class(g_iface.library, cls.ptr(), parent.ptr(), &info);
  for (const Method &m : methods()) register_method(cls.ptr(), m);
  register_signal(cls.ptr(), "started", {});
  register_signal(cls.ptr(), "stopped", {});
  register_signal(cls.ptr(), "send_binary", {{T::Int, "local"}, {T::Bytes, "data"}});
  register_signal(cls.ptr(), "send_text", {{T::Int, "local"}, {T::String, "text"}});
  register_signal(cls.ptr(), "close", {{T::Int, "local"}, {T::Int, "code"}, {T::String, "reason"}});
  g_registered = true;
  return true;
}

void gd_carrier_class_unregister() {
  if (!g_registered) return;
  SName cls(kClassName);
  g_fn.unregister_class(g_iface.library, cls.ptr());
  g_registered = false;
}

void gd_carriers_flush() {
  if (!g_any.load(std::memory_order_acquire)) return;
  std::vector<std::shared_ptr<State>> list;
  {
    std::lock_guard<std::mutex> lock(g_list_mu);
    // A destroyed carrier whose object is gone has nothing left to deliver.
    for (auto it = g_list.begin(); it != g_list.end();) {
      bool done = false;
      {
        std::lock_guard<std::mutex> state_lock((*it)->mu);
        done = (*it)->phase == Phase::Destroyed && (*it)->out.empty();
      }
      it = done ? g_list.erase(it) : it + 1;
    }
    list = g_list;
  }
  for (const std::shared_ptr<State> &sp : list) flush_one(sp);
}

}  // namespace live
}  // namespace grc
