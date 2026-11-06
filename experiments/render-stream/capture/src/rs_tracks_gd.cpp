// rs_tracks_gd: the RenderStreamTrack engine class; see rs_tracks_gd.h (TRK2).
//
// Raw GDExtension C interface, as rs_carrier_gd.cpp (no godot-cpp). Opaque engine values are held
// in buffers of their 64-bit sizes (extension_api.json builtin_class_sizes, float_64 and float_32
// alike): Variant 24, String 8, StringName 8, Dictionary 8, PackedStringArray and
// PackedInt64Array 16 bytes.
#include "rs_tracks_gd.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "iface.h"
#include "rs_track_inject_script.h"
#include "rs_tracks.h"

namespace grc {
namespace live {
namespace {

using rs::tracks::TrackHub;
using rs::tracks::TrackInfo;

constexpr const char *kClassName = "RenderStreamTrack";
// extension_api.json (4.5.1) hashes: Object.emit_signal (vararg), the packed arrays' size() and
// resize(int).
constexpr std::int64_t kEmitSignalHash = 4047867050LL;
constexpr std::int64_t kPackedSizeHash = 3173160232LL;
constexpr std::int64_t kPackedResizeHash = 848867239LL;
constexpr std::uint32_t kUsageDefault = 6;  // PROPERTY_USAGE_DEFAULT
// A handler that closes a source queues its closed(); the flush delivers it in the same call, up
// to this many rounds per receiver (a handler loop that never settles waits for the next flush).
constexpr int kFlushRounds = 16;

struct alignas(8) GVariant {
  std::uint8_t data[24];
};
struct alignas(8) GPtr {
  void *p = nullptr;  // String, StringName, Dictionary
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
  GDExtensionInterfaceStringNewWithUtf8CharsAndLen2 string_new = nullptr;
  GDExtensionInterfaceStringToUtf8Chars string_to_utf8 = nullptr;
  GDExtensionInterfaceStringNameNewWithLatin1Chars string_name_new = nullptr;
  GDExtensionInterfaceVariantGetType variant_type = nullptr;
  GDExtensionInterfaceVariantDestroy variant_destroy = nullptr;
  GDExtensionInterfaceVariantNewCopy variant_copy = nullptr;
  GDExtensionInterfaceDictionaryOperatorIndex dict_index = nullptr;
  GDExtensionInterfacePackedStringArrayOperatorIndexConst strings_index = nullptr;
  GDExtensionInterfacePackedInt64ArrayOperatorIndex ints_index = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_int = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_bool = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_string = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_string_name = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_dict = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_strings = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_ints = nullptr;
  GDExtensionTypeFromVariantConstructorFunc int_from_var = nullptr;
  GDExtensionTypeFromVariantConstructorFunc string_from_var = nullptr;
  GDExtensionTypeFromVariantConstructorFunc strings_from_var = nullptr;
  GDExtensionPtrConstructor dict_new = nullptr;
  GDExtensionPtrConstructor strings_new = nullptr;
  GDExtensionPtrConstructor ints_new = nullptr;
  GDExtensionPtrDestructor string_destroy = nullptr;
  GDExtensionPtrDestructor string_name_destroy = nullptr;
  GDExtensionPtrDestructor dict_destroy = nullptr;
  GDExtensionPtrDestructor strings_destroy = nullptr;
  GDExtensionPtrDestructor ints_destroy = nullptr;
  GDExtensionPtrBuiltInMethod strings_size = nullptr;
  GDExtensionPtrBuiltInMethod ints_resize = nullptr;
  GDExtensionMethodBindPtr emit = nullptr;
  // TRK6 (the built-in injector drives a GDScript object through Variant calls).
  GDExtensionInterfaceVariantCall variant_call = nullptr;
  GDExtensionInterfaceObjectGetInstanceId get_instance_id = nullptr;
  GDExtensionVariantFromTypeConstructorFunc var_from_object = nullptr;
  GDExtensionTypeFromVariantConstructorFunc bool_from_var = nullptr;
  GDExtensionTypeFromVariantConstructorFunc object_from_var = nullptr;
};

Fns g_fn;
bool g_registered = false;
std::thread::id g_main;

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
  GPtr v_;
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

std::vector<std::string> strings_read(const void *packed) {
  std::int64_t n = 0;
  g_fn.strings_size(const_cast<void *>(packed), nullptr, &n, 0);
  std::vector<std::string> out;
  for (std::int64_t i = 0; i < n; ++i) out.push_back(string_read(g_fn.strings_index(packed, i)));
  return out;
}

// A script-facing value: what a method takes or returns, and a signal argument.
enum class T { Nil, Bool, Int, String, Strings, Ints, Dict };

struct Value {
  T type = T::Nil;
  bool b = false;
  std::int64_t i = 0;
  std::string s;
  std::vector<std::string> strings;
  std::vector<std::int64_t> ints;
  std::vector<std::string> keys;  // Dict, beside `values`
  std::vector<Value> values;
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
Value dict() {
  Value v;
  v.type = T::Dict;
  return v;
}
void put(Value *d, const char *key, Value v) {
  d->keys.emplace_back(key);
  d->values.push_back(std::move(v));
}

void write_variant(const Value &v, GDExtensionUninitializedVariantPtr out);

// Builds `v` (a Dict) into the uninitialized Dictionary at `uninit`.
void dict_init(void *uninit, const Value &v) {
  g_fn.dict_new(uninit, nullptr);
  for (std::size_t k = 0; k < v.keys.size(); ++k) {
    GVariant key;
    write_variant(string(v.keys[k]), &key);
    GVariant value;
    write_variant(v.values[k], &value);
    GDExtensionVariantPtr slot = g_fn.dict_index(uninit, &key);
    g_fn.variant_destroy(slot);
    g_fn.variant_copy(slot, &value);
    g_fn.variant_destroy(&value);
    g_fn.variant_destroy(&key);
  }
}

void ints_init(void *uninit, const std::vector<std::int64_t> &ints) {
  g_fn.ints_new(uninit, nullptr);
  if (ints.empty()) return;
  const std::int64_t n = static_cast<std::int64_t>(ints.size());
  const GDExtensionConstTypePtr args[1] = {&n};
  std::int64_t err = 0;
  g_fn.ints_resize(uninit, args, &err, 1);
  for (std::size_t k = 0; k < ints.size(); ++k) {
    *g_fn.ints_index(uninit, static_cast<GDExtensionInt>(k)) = ints[k];
  }
}

// Constructs `v` into the uninitialized (or Nil) Variant at `out`.
void write_variant(const Value &v, GDExtensionUninitializedVariantPtr out) {
  switch (v.type) {
    case T::Bool: {
      GDExtensionBool b = v.b ? 1 : 0;
      g_fn.var_from_bool(out, &b);
      return;
    }
    case T::Int: {
      std::int64_t i = v.i;
      g_fn.var_from_int(out, &i);
      return;
    }
    case T::String: {
      GPtr s;
      string_init(&s, v.s);
      g_fn.var_from_string(out, &s);
      g_fn.string_destroy(&s);
      return;
    }
    case T::Ints: {
      GPacked p;
      ints_init(&p, v.ints);
      g_fn.var_from_ints(out, &p);
      g_fn.ints_destroy(&p);
      return;
    }
    case T::Strings: {
      GPacked p;
      g_fn.strings_new(&p, nullptr);
      g_fn.var_from_strings(out, &p);  // only ever an empty default argument
      g_fn.strings_destroy(&p);
      return;
    }
    case T::Dict: {
      GPtr d;
      dict_init(&d, v);
      g_fn.var_from_dict(out, &d);
      g_fn.dict_destroy(&d);
      return;
    }
    case T::Nil:
      break;
  }
  std::memset(out, 0, sizeof(GVariant));  // Variant::NIL is all zero bytes
}

// Object.emit_signal(name, args...) on `object`.
void emit(GDExtensionObjectPtr object, const char *signal, const Value *args, int count) {
  SName name(signal);
  GVariant vname;
  g_fn.var_from_string_name(&vname, name.ptr());
  GVariant vargs[3];
  GDExtensionConstVariantPtr argv[4] = {&vname, nullptr, nullptr, nullptr};
  for (int i = 0; i < count && i < 3; ++i) {
    write_variant(args[i], &vargs[i]);
    argv[i + 1] = &vargs[i];
  }
  GVariant ret;
  GDExtensionCallError error;
  std::memset(&error, 0, sizeof(error));
  g_fn.bind_call(g_fn.emit, object, argv, count + 1, &ret, &error);
  g_fn.variant_destroy(&ret);
  for (int i = 0; i < count && i < 3; ++i) g_fn.variant_destroy(&vargs[i]);
  g_fn.variant_destroy(&vname);
}

Value info_value(const TrackInfo &info) {
  Value d = dict();
  put(&d, "kind", string(info.kind));
  put(&d, "format", string(info.format));
  put(&d, "down_format", info.down_format.empty() ? nil() : string(info.down_format));
  put(&d, "client", string(info.client));
  if (info.view) {
    Value view = dict();
    put(&view, "stream_id", string(info.view->stream_id));
    put(&view, "connection", integer(static_cast<std::int64_t>(info.view->connection)));
    put(&d, "view", std::move(view));
  } else {
    put(&d, "view", nil());
  }
  put(&d, "carrier", string(info.carrier));
  put(&d, "origin", string(info.origin));
  put(&d, "subject", string(info.subject));
  return d;
}

// --- the receiver state --------------------------------------------------------------------------

struct Queued {
  enum Kind { Opened, Message, Closed } kind = Message;
  std::uint32_t source = 0;
  std::string text;  // the payload, or the close reason
  std::uint16_t code = 0;
  TrackInfo info;  // Opened
};

enum class Phase { Waiting, Serving, Stopped };

// The registry (main thread only): one receiver per kind, the hub while live listens.
struct Registry;

// One RenderStreamTrack's state, the hub's TrackReceiver. It outlives the object (the registry and
// the flush list hold it), so the hub's pointer stays valid until it is unbound.
struct State final : rs::tracks::TrackReceiver {
  GDExtensionObjectPtr owner = nullptr;  // null once the object is freed
  // TRK6: the built-in injector's node is not ours to wrap, so its liveness is its ObjectID,
  // resolved at each flush (0 for a RenderStreamTrack, whose free_instance clears `owner`).
  std::uint64_t owner_id = 0;
  std::string kind;                      // "" when unbound
  std::vector<std::string> up;
  std::vector<std::string> down;
  bool on_hub = false;  // bound on the hub (live listening and the kind granted)
  std::string last_error;
  std::deque<Queued> queue;
  std::map<std::uint32_t, TrackInfo> open;  // opened, not yet closed
  std::uint64_t opened_count = 0;
  std::uint64_t closed_count = 0;
  std::uint64_t messages = 0;
  std::uint64_t bytes = 0;
  std::map<std::string, std::uint64_t> closes;  // reason -> count

  std::vector<std::string> formats() const override { return up; }
  std::vector<std::string> down_formats() const override { return down; }
  void opened(const TrackInfo &info) override {
    open[info.source] = info;
    ++opened_count;
    Queued q;
    q.kind = Queued::Opened;
    q.source = info.source;
    q.info = info;
    queue.push_back(std::move(q));
  }
  void message(std::uint32_t source, const std::string &text) override {
    ++messages;
    bytes += text.size();
    Queued q;
    q.kind = Queued::Message;
    q.source = source;
    q.text = text;
    queue.push_back(std::move(q));
  }
  void closed(std::uint32_t source, std::uint16_t code, const std::string &reason) override {
    open.erase(source);
    ++closed_count;
    ++closes[reason];
    Queued q;
    q.kind = Queued::Closed;
    q.source = source;
    q.code = code;
    q.text = reason;
    queue.push_back(std::move(q));
  }
};

struct Registry {
  Phase phase = Phase::Waiting;
  TrackHub *hub = nullptr;  // Serving only, and only when tracks are on
  std::map<std::string, std::shared_ptr<State>> bound;  // kind -> receiver
  std::vector<std::shared_ptr<State>> list;             // every state with work for the flush
  std::shared_ptr<State> builtin;  // TRK6: the built-in injector's receiver (bound on the hub, not in `bound`)
};

Registry g_reg;
std::atomic<bool> g_any{false};

bool granted(const std::string &kind) {
  return g_reg.hub != nullptr && g_reg.hub->kind_stats(kind) != nullptr;
}

// Binds `s` on the hub when live serves its kind. False with s->last_error when the hub refuses
// (another receiver, such as TRK6's built-in injector, holds the kind).
bool hub_bind(State &s) {
  if (g_reg.phase != Phase::Serving || !granted(s.kind)) return true;
  std::string why;
  if (!g_reg.hub->bind(s.kind, &s, &why)) {
    s.last_error = why;
    return false;
  }
  s.on_hub = true;
  return true;
}

// Unbinds `s` from the hub (its open sources close track-receiver-gone, their closed() queued)
// and from the registry.
void unbind_state(const std::shared_ptr<State> &sp) {
  State &s = *sp;
  if (s.on_hub && g_reg.hub != nullptr) g_reg.hub->unbind(&s);
  s.on_hub = false;
  const auto it = g_reg.bound.find(s.kind);
  if (it != g_reg.bound.end() && it->second == sp) g_reg.bound.erase(it);
  s.kind.clear();
}

void track_list(const std::shared_ptr<State> &sp) {
  for (const auto &p : g_reg.list) {
    if (p == sp) return;
  }
  g_reg.list.push_back(sp);
  g_any.store(true, std::memory_order_relaxed);
}

struct Instance {
  GDExtensionObjectPtr object = nullptr;
  std::shared_ptr<State> state;
};

// --- script methods ------------------------------------------------------------------------------

using Args = std::vector<Value>;
using Impl = Value (*)(Instance *self, const Args &a);

bool main_thread(State &s) {
  if (std::this_thread::get_id() == g_main) return true;
  s.last_error = "track-wrong-thread";
  return false;
}

// bind(kind: String, formats: PackedStringArray, down_formats := PackedStringArray()) -> bool
Value m_bind(Instance *self, const Args &a) {
  const std::shared_ptr<State> &sp = self->state;
  State &s = *sp;
  if (!main_thread(s)) return boolean(false);
  const std::string &kind = a[0].s;
  if (!s.kind.empty()) {
    s.last_error = "track-already-bound";
    return boolean(false);
  }
  if (!rs::tracks::kind_name_ok(kind)) {
    s.last_error = "track-kind-invalid";
    return boolean(false);
  }
  if (!rs::tracks::format_list_ok(a[1].strings, false) ||
      !rs::tracks::format_list_ok(a[2].strings, true)) {
    s.last_error = "track-formats-invalid";
    return boolean(false);
  }
  if (g_reg.bound.count(kind) != 0 || (g_reg.hub != nullptr && g_reg.hub->bound(kind))) {
    s.last_error = "track-kind-bound";
    return boolean(false);
  }
  s.kind = kind;
  s.up = a[1].strings;
  s.down = a[2].strings;
  if (!hub_bind(s)) {
    s.kind.clear();
    return boolean(false);
  }
  g_reg.bound[kind] = sp;
  track_list(sp);
  s.last_error.clear();
  return boolean(true);
}

// unbind() -> void: open sources close track-receiver-gone; their closed signals follow.
Value m_unbind(Instance *self, const Args &) {
  State &s = *self->state;
  if (!main_thread(s) || s.kind.empty()) return nil();
  unbind_state(self->state);
  return nil();
}

// send(source: int, text: String) -> bool: a down payload.
Value m_send(Instance *self, const Args &a) {
  State &s = *self->state;
  if (!main_thread(s)) return boolean(false);
  if (!s.on_hub || g_reg.hub == nullptr || a[0].i < 1 || a[0].i > UINT32_MAX ||
      s.open.count(static_cast<std::uint32_t>(a[0].i)) == 0) {
    s.last_error = "track-source-unknown";
    return boolean(false);
  }
  if (!g_reg.hub->send(static_cast<std::uint32_t>(a[0].i), a[1].s)) {
    s.last_error = "track-send-refused";
    return boolean(false);
  }
  return boolean(true);
}

// close(source: int, code := 1000, reason := "track-closed") -> bool
Value m_close(Instance *self, const Args &a) {
  State &s = *self->state;
  if (!main_thread(s)) return boolean(false);
  const std::int64_t code = a[1].i;
  // /1 has one receiver close reason (tracks-design.md Q1.4); the code tells the client whether
  // to reconnect (1000) or not (4000-4999).
  if (a[2].s != "track-closed" || (code != 1000 && (code < 4000 || code > 4999))) {
    s.last_error = "track-close-invalid";
    return boolean(false);
  }
  if (!s.on_hub || g_reg.hub == nullptr || a[0].i < 1 || a[0].i > UINT32_MAX ||
      s.open.count(static_cast<std::uint32_t>(a[0].i)) == 0) {
    s.last_error = "track-source-unknown";
    return boolean(false);
  }
  return boolean(g_reg.hub->close(static_cast<std::uint32_t>(a[0].i), static_cast<std::uint16_t>(code)));
}

Value m_sources(Instance *self, const Args &) {
  Value v;
  v.type = T::Ints;
  for (const auto &entry : self->state->open) v.ints.push_back(entry.first);
  return v;
}

Value m_info(Instance *self, const Args &a) {
  const State &s = *self->state;
  if (a[0].i < 1 || a[0].i > UINT32_MAX) return dict();
  const auto it = s.open.find(static_cast<std::uint32_t>(a[0].i));
  return it == s.open.end() ? dict() : info_value(it->second);
}

Value m_status(Instance *self, const Args &) {
  const State &s = *self->state;
  if (s.kind.empty()) return string("unbound");
  switch (g_reg.phase) {
    case Phase::Waiting:
      return string("waiting");
    case Phase::Stopped:
      return string("stopped");
    case Phase::Serving:
      break;
  }
  return string(s.on_hub ? "serving" : "not-granted");
}

Value m_stats(Instance *self, const Args &) {
  const State &s = *self->state;
  Value d = dict();
  put(&d, "opened", integer(static_cast<std::int64_t>(s.opened_count)));
  put(&d, "closed", integer(static_cast<std::int64_t>(s.closed_count)));
  put(&d, "messages", integer(static_cast<std::int64_t>(s.messages)));
  put(&d, "bytes", integer(static_cast<std::int64_t>(s.bytes)));
  Value closes = dict();
  for (const auto &entry : s.closes) {
    put(&closes, entry.first.c_str(), integer(static_cast<std::int64_t>(entry.second)));
  }
  put(&d, "closes", std::move(closes));
  return d;
}

Value m_last_error(Instance *self, const Args &) { return string(self->state->last_error); }

struct Arg {
  T type;
  const char *name;
  bool has_default = false;
  Value fallback;
};

struct Method {
  const char *name;
  Impl impl;
  T ret;
  std::vector<Arg> args;
};

Arg arg(T t, const char *n) { return Arg{t, n, false, Value()}; }
Arg arg_or(T t, const char *n, Value v) { return Arg{t, n, true, std::move(v)}; }

Value empty_strings() {
  Value v;
  v.type = T::Strings;
  return v;
}

const std::vector<Method> &methods() {
  static const std::vector<Method> list = {
      {"bind", &m_bind, T::Bool,
       {arg(T::String, "kind"), arg(T::Strings, "formats"),
        arg_or(T::Strings, "down_formats", empty_strings())}},
      {"unbind", &m_unbind, T::Nil, {}},
      {"send", &m_send, T::Bool, {arg(T::Int, "source"), arg(T::String, "text")}},
      {"close", &m_close, T::Bool,
       {arg(T::Int, "source"), arg_or(T::Int, "code", integer(1000)),
        arg_or(T::String, "reason", string("track-closed"))}},
      {"sources", &m_sources, T::Ints, {}},
      {"info", &m_info, T::Dict, {arg(T::Int, "source")}},
      {"status", &m_status, T::String, {}},
      {"stats", &m_stats, T::Dict, {}},
      {"last_error", &m_last_error, T::String, {}},
  };
  return list;
}

GDExtensionVariantType vtype(T t) {
  switch (t) {
    case T::Bool:
      return GDEXTENSION_VARIANT_TYPE_BOOL;
    case T::Int:
      return GDEXTENSION_VARIANT_TYPE_INT;
    case T::String:
      return GDEXTENSION_VARIANT_TYPE_STRING;
    case T::Strings:
      return GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY;
    case T::Ints:
      return GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY;
    case T::Dict:
      return GDEXTENSION_VARIANT_TYPE_DICTIONARY;
    case T::Nil:
      break;
  }
  return GDEXTENSION_VARIANT_TYPE_NIL;
}

std::size_t required(const Method &m) {
  std::size_t n = 0;
  for (const Arg &x : m.args) n += x.has_default ? 0 : 1;
  return n;
}

void call_dispatch(void *userdata, GDExtensionClassInstancePtr instance,
                   const GDExtensionConstVariantPtr *args, GDExtensionInt argc,
                   GDExtensionVariantPtr r_return, GDExtensionCallError *r_error) {
  const Method &m = *static_cast<const Method *>(userdata);
  const auto most = static_cast<GDExtensionInt>(m.args.size());
  const auto least = static_cast<GDExtensionInt>(required(m));
  if (argc < least || argc > most) {
    r_error->error = argc < least ? GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS
                                  : GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS;
    r_error->expected = static_cast<int32_t>(argc < least ? least : most);
    return;
  }
  Args values(m.args.size());
  for (std::size_t i = 0; i < m.args.size(); ++i) {
    const T t = m.args[i].type;
    if (static_cast<GDExtensionInt>(i) >= argc) {
      values[i] = m.args[i].fallback;  // the call left a defaulted argument out
      continue;
    }
    if (g_fn.variant_type(args[i]) != vtype(t)) {
      r_error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
      r_error->argument = static_cast<int32_t>(i);
      r_error->expected = vtype(t);
      return;
    }
    values[i].type = t;
    auto *var = const_cast<GDExtensionVariantPtr>(args[i]);
    if (t == T::Int) {
      g_fn.int_from_var(&values[i].i, var);
    } else if (t == T::String) {
      GPtr s;
      g_fn.string_from_var(&s, var);
      values[i].s = string_read(&s);
      g_fn.string_destroy(&s);
    } else if (t == T::Strings) {
      GPacked p;
      g_fn.strings_from_var(&p, var);
      values[i].strings = strings_read(&p);
      g_fn.strings_destroy(&p);
    }
  }
  r_error->error = GDEXTENSION_CALL_OK;
  const Value v = m.impl(static_cast<Instance *>(instance), values);
  if (m.ret != T::Nil) {
    g_fn.variant_destroy(r_return);
    write_variant(v, r_return);
  }
}

void ptrcall_dispatch(void *userdata, GDExtensionClassInstancePtr instance,
                      const GDExtensionConstTypePtr *args, GDExtensionTypePtr r_ret) {
  const Method &m = *static_cast<const Method *>(userdata);
  Args values(m.args.size());
  for (std::size_t i = 0; i < m.args.size(); ++i) {
    values[i].type = m.args[i].type;
    if (values[i].type == T::Int) {
      values[i].i = *static_cast<const std::int64_t *>(args[i]);
    } else if (values[i].type == T::String) {
      values[i].s = string_read(args[i]);
    } else if (values[i].type == T::Strings) {
      values[i].strings = strings_read(args[i]);
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
    case T::Ints:
      g_fn.ints_destroy(r_ret);
      ints_init(r_ret, v.ints);
      break;
    case T::Dict:
      g_fn.dict_destroy(r_ret);
      dict_init(r_ret, v);
      break;
    case T::Strings:
    case T::Nil:
      break;
  }
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
  // The next flush ends its sources (track-receiver-gone) and drops its queue undelivered.
  instance->state->owner = nullptr;
  delete instance;
}

// Property info with owned names, kept alive across one registration call.
struct Prop {
  SName name;
  SName class_name;
  GPtr hint;
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
  std::vector<GVariant> defaults;
  defaults.reserve(m.args.size());
  for (const Arg &x : m.args) {
    props.push_back(std::make_unique<Prop>(x.type, x.name));
    infos.push_back(props.back()->info);
    meta.push_back(x.type == T::Int ? GDEXTENSION_METHOD_ARGUMENT_METADATA_INT_IS_INT64
                                    : GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE);
    if (x.has_default) {
      defaults.emplace_back();
      write_variant(x.fallback, &defaults.back());
    }
  }
  std::vector<GDExtensionVariantPtr> default_ptrs;
  for (GVariant &d : defaults) default_ptrs.push_back(&d);
  GDExtensionClassMethodInfo info;
  std::memset(&info, 0, sizeof(info));
  info.name = name.ptr();
  info.method_userdata = const_cast<Method *>(&m);
  info.call_func = &call_dispatch;
  info.ptrcall_func = &ptrcall_dispatch;
  info.method_flags = GDEXTENSION_METHOD_FLAGS_DEFAULT;
  info.has_return_value = m.ret != T::Nil ? 1 : 0;
  info.return_value_info = &ret.info;
  info.return_value_metadata = m.ret == T::Int ? GDEXTENSION_METHOD_ARGUMENT_METADATA_INT_IS_INT64
                                               : GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
  info.argument_count = static_cast<uint32_t>(infos.size());
  info.arguments_info = infos.empty() ? nullptr : infos.data();
  info.arguments_metadata = meta.empty() ? nullptr : meta.data();
  info.default_argument_count = static_cast<uint32_t>(default_ptrs.size());
  info.default_arguments = default_ptrs.empty() ? nullptr : default_ptrs.data();
  g_fn.register_method(g_iface.library, cls, &info);  // copies the defaults
  for (GVariant &d : defaults) g_fn.variant_destroy(&d);
}

void register_signal(GDExtensionStringNamePtr cls, const char *signal,
                     const std::vector<std::pair<T, const char *>> &args) {
  SName name(signal);
  std::vector<std::unique_ptr<Prop>> props;
  std::vector<GDExtensionPropertyInfo> infos;
  for (const auto &x : args) {
    props.push_back(std::make_unique<Prop>(x.first, x.second));
    infos.push_back(props.back()->info);
  }
  g_fn.register_signal(g_iface.library, cls, name.ptr(), infos.empty() ? nullptr : infos.data(),
                       static_cast<GDExtensionInt>(infos.size()));
}

// Delivers one receiver's queue. A freed object's sources end here and its queue is dropped.
void flush_one(const std::shared_ptr<State> &sp) {
  State &s = *sp;
  if (s.owner_id != 0) {
    s.owner = g_iface.object_get_instance_from_id != nullptr
                  ? g_iface.object_get_instance_from_id(s.owner_id)
                  : nullptr;
  }
  if (s.owner == nullptr && !s.kind.empty()) unbind_state(sp);
  for (int round = 0; round < kFlushRounds && !s.queue.empty(); ++round) {
    std::deque<Queued> q;
    q.swap(s.queue);
    for (Queued &e : q) {
      if (s.owner == nullptr) break;  // a handler dropped the last reference
      Value args[3];
      args[0] = integer(e.source);
      if (e.kind == Queued::Opened) {
        args[1] = info_value(e.info);
        emit(s.owner, "opened", args, 2);
      } else if (e.kind == Queued::Message) {
        args[1] = string(std::move(e.text));
        emit(s.owner, "message", args, 2);
      } else {
        args[1] = integer(e.code);
        args[2] = string(std::move(e.text));
        emit(s.owner, "closed", args, 3);
      }
    }
    if (s.owner == nullptr) {
      if (!s.kind.empty()) unbind_state(sp);
      s.queue.clear();
    }
  }
}

}  // namespace

bool gd_track_class_register(std::string *why) {
  if (g_registered) return true;
  if (g_iface.get_proc_address == nullptr || g_iface.library == nullptr) {
    *why = "track-class-unavailable: no GDExtension interface";
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
  resolve("string_new_with_utf8_chars_and_len2", &f.string_new, &missing);
  resolve("string_to_utf8_chars", &f.string_to_utf8, &missing);
  resolve("string_name_new_with_latin1_chars", &f.string_name_new, &missing);
  resolve("variant_get_type", &f.variant_type, &missing);
  resolve("variant_destroy", &f.variant_destroy, &missing);
  resolve("variant_new_copy", &f.variant_copy, &missing);
  resolve("dictionary_operator_index", &f.dict_index, &missing);
  resolve("packed_string_array_operator_index_const", &f.strings_index, &missing);
  resolve("packed_int64_array_operator_index", &f.ints_index, &missing);
  resolve("variant_call", &f.variant_call, &missing);
  resolve("object_get_instance_id", &f.get_instance_id, &missing);
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
    *why = "track-class-unavailable: missing " + missing;
    return false;
  }
  f.var_from_int = from_type(GDEXTENSION_VARIANT_TYPE_INT);
  f.var_from_bool = from_type(GDEXTENSION_VARIANT_TYPE_BOOL);
  f.var_from_string = from_type(GDEXTENSION_VARIANT_TYPE_STRING);
  f.var_from_string_name = from_type(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
  f.var_from_dict = from_type(GDEXTENSION_VARIANT_TYPE_DICTIONARY);
  f.var_from_strings = from_type(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY);
  f.var_from_ints = from_type(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY);
  f.var_from_object = from_type(GDEXTENSION_VARIANT_TYPE_OBJECT);
  f.bool_from_var = to_type(GDEXTENSION_VARIANT_TYPE_BOOL);
  f.object_from_var = to_type(GDEXTENSION_VARIANT_TYPE_OBJECT);
  f.int_from_var = to_type(GDEXTENSION_VARIANT_TYPE_INT);
  f.string_from_var = to_type(GDEXTENSION_VARIANT_TYPE_STRING);
  f.strings_from_var = to_type(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY);
  f.dict_new = ptr_ctor(GDEXTENSION_VARIANT_TYPE_DICTIONARY, 0);
  f.strings_new = ptr_ctor(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY, 0);
  f.ints_new = ptr_ctor(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY, 0);
  f.string_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_STRING);
  f.string_name_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
  f.dict_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_DICTIONARY);
  f.strings_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY);
  f.ints_destroy = ptr_dtor(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY);
  {
    SName size("size");
    SName resize("resize");
    f.strings_size = builtin(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY, size.ptr(), kPackedSizeHash);
    f.ints_resize = builtin(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY, resize.ptr(), kPackedResizeHash);
  }
  {
    SName object("Object");
    SName emit_name("emit_signal");
    f.emit = get_bind(object.ptr(), emit_name.ptr(), kEmitSignalHash);
  }
  if (f.var_from_int == nullptr || f.var_from_bool == nullptr || f.var_from_string == nullptr ||
      f.var_from_string_name == nullptr || f.var_from_dict == nullptr ||
      f.var_from_strings == nullptr || f.var_from_ints == nullptr || f.int_from_var == nullptr ||
      f.string_from_var == nullptr || f.strings_from_var == nullptr || f.dict_new == nullptr ||
      f.strings_new == nullptr || f.ints_new == nullptr || f.string_destroy == nullptr ||
      f.string_name_destroy == nullptr || f.dict_destroy == nullptr ||
      f.strings_destroy == nullptr || f.ints_destroy == nullptr || f.strings_size == nullptr ||
      f.ints_resize == nullptr || f.emit == nullptr || f.var_from_object == nullptr ||
      f.bool_from_var == nullptr || f.object_from_var == nullptr) {
    *why = "track-class-unavailable: a builtin constructor, a packed array's size/resize or "
           "Object.emit_signal is missing at the expected hash";
    return false;
  }
  g_main = std::this_thread::get_id();

  SName cls(kClassName);
  SName parent("RefCounted");
  GDExtensionClassCreationInfo4 info;
  std::memset(&info, 0, sizeof(info));
  info.is_exposed = 1;
  info.create_instance_func = &create_instance;
  info.free_instance_func = &free_instance;
  f.register_class(g_iface.library, cls.ptr(), parent.ptr(), &info);
  for (const Method &m : methods()) register_method(cls.ptr(), m);
  register_signal(cls.ptr(), "opened", {{T::Int, "source"}, {T::Dict, "info"}});
  register_signal(cls.ptr(), "message", {{T::Int, "source"}, {T::String, "text"}});
  register_signal(cls.ptr(), "closed", {{T::Int, "source"}, {T::Int, "code"}, {T::String, "reason"}});
  g_registered = true;
  return true;
}

// --- the built-in injector (TRK6) ----------------------------------------------------------------

namespace {

// A compiled, configured injector node that is not bound yet.
struct Pending {
  GDExtensionObjectPtr node = nullptr;
  std::uint64_t id = 0;
};
Pending g_pending;
bool g_builtin_attached = false;  // attach() reached a SceneTree

// Calls `method` on the Variant at `self` with `args`; `ret` is always initialized. True when the
// engine accepted the call (a script error inside it still returns true; read the result).
bool vcall(GDExtensionVariantPtr self, const char *method, const std::vector<Value> &args,
           GVariant *ret) {
  SName name(method);
  std::vector<GVariant> vs(args.size());
  std::vector<GDExtensionConstVariantPtr> ptrs;
  for (std::size_t i = 0; i < args.size(); ++i) {
    write_variant(args[i], &vs[i]);
    ptrs.push_back(&vs[i]);
  }
  GDExtensionCallError error;
  std::memset(&error, 0, sizeof(error));
  g_fn.variant_call(self, name.ptr(), ptrs.empty() ? nullptr : ptrs.data(),
                    static_cast<GDExtensionInt>(args.size()), ret, &error);
  for (GVariant &v : vs) g_fn.variant_destroy(&v);
  return error.error == GDEXTENSION_CALL_OK;
}

bool variant_is(GVariant *v, GDExtensionVariantType type) { return g_fn.variant_type(v) == type; }

// The Object a Variant holds, or null.
GDExtensionObjectPtr variant_object(GVariant *v) {
  GDExtensionObjectPtr o = nullptr;
  if (variant_is(v, GDEXTENSION_VARIANT_TYPE_OBJECT)) g_fn.object_from_var(&o, v);
  return o;
}

// Calls `method` on the live node `id` (queue_free, attach); the result is discarded.
bool node_call(std::uint64_t id, const char *method, bool *result) {
  GDExtensionObjectPtr node = g_iface.object_get_instance_from_id(id);
  if (node == nullptr) return false;
  GVariant self;
  g_fn.var_from_object(&self, &node);
  GVariant ret;
  const bool ok = vcall(&self, method, {}, &ret);
  if (result != nullptr) {
    std::uint8_t b = 0;
    if (variant_is(&ret, GDEXTENSION_VARIANT_TYPE_BOOL)) g_fn.bool_from_var(&b, &ret);
    *result = b != 0;
  }
  g_fn.variant_destroy(&ret);
  g_fn.variant_destroy(&self);
  return ok;
}

void pending_discard() {
  if (g_pending.node != nullptr && g_iface.object_get_instance_from_id != nullptr &&
      g_iface.object_get_instance_from_id(g_pending.id) != nullptr) {
    g_iface.object_destroy(g_pending.node);  // not in a tree yet: freed at once
  }
  g_pending = Pending();
}

// Lets go of the bound injector: off the hub, its queue dropped, its node freed (when the engine
// may still be called).
void builtin_release(bool call_engine) {
  const std::shared_ptr<State> sp = std::move(g_reg.builtin);
  g_reg.builtin.reset();
  if (sp == nullptr) return;
  if (sp->on_hub && g_reg.hub != nullptr) g_reg.hub->unbind(sp.get());
  sp->on_hub = false;
  sp->kind.clear();
  sp->queue.clear();
  if (call_engine && sp->owner_id != 0 && g_iface.object_get_instance_from_id != nullptr) {
    node_call(sp->owner_id, "queue_free", nullptr);
  }
  g_builtin_attached = false;
}

}  // namespace

bool gd_tracks_builtin_prepare(const std::string &config_json, bool sabotage_no_release,
                               std::string *why) {
  gd_tracks_builtin_discard();
  if (!g_registered || g_iface.object_get_instance_from_id == nullptr ||
      g_iface.object_destroy == nullptr) {
    *why = "track-inject-unavailable: the engine interface lacks what the embedded injector needs";
    return false;
  }
  if (std::this_thread::get_id() != g_main) {
    *why = "track-inject-unavailable: not the main thread";
    return false;
  }
  SName gdscript("GDScript");
  GDExtensionObjectPtr script = g_fn.construct_object(gdscript.ptr());
  if (script == nullptr) {
    *why = "track-inject-unavailable: GDScript cannot be instantiated";
    return false;
  }
  GVariant script_var;
  g_fn.var_from_object(&script_var, &script);  // takes the new script's reference
  const std::string source(reinterpret_cast<const char *>(kBuiltinInjectScript),
                           sizeof(kBuiltinInjectScript));
  GVariant ret;
  bool ok = vcall(&script_var, "set_source_code", {string(source)}, &ret);
  g_fn.variant_destroy(&ret);
  std::int64_t reload_error = -1;
  if (ok) {
    ok = vcall(&script_var, "reload", {boolean(false)}, &ret);
    if (variant_is(&ret, GDEXTENSION_VARIANT_TYPE_INT)) g_fn.int_from_var(&reload_error, &ret);
    g_fn.variant_destroy(&ret);
  }
  if (!ok || reload_error != 0) {
    g_fn.variant_destroy(&script_var);
    *why = "track-inject-unavailable: the embedded injector did not compile (reload error " +
           std::to_string(reload_error) + ", see the engine log)";
    return false;
  }
  GDExtensionObjectPtr node = nullptr;
  if (vcall(&script_var, "new", {}, &ret)) node = variant_object(&ret);
  g_fn.variant_destroy(&ret);
  g_fn.variant_destroy(&script_var);  // the node's script reference keeps the script alive
  if (node == nullptr) {
    *why = "track-inject-unavailable: the embedded injector could not be instantiated";
    return false;
  }
  g_pending.node = node;
  g_pending.id = static_cast<std::uint64_t>(g_fn.get_instance_id(node));
  bool configured = false;
  GVariant node_var;
  g_fn.var_from_object(&node_var, &node);
  ok = vcall(&node_var, "setup", {string(config_json), string(sabotage_no_release ? "no-release" : "")}, &ret);
  if (ok && variant_is(&ret, GDEXTENSION_VARIANT_TYPE_BOOL)) {
    std::uint8_t b = 0;
    g_fn.bool_from_var(&b, &ret);
    configured = b != 0;
  }
  g_fn.variant_destroy(&ret);
  g_fn.variant_destroy(&node_var);
  if (!ok) {
    pending_discard();
    *why = "track-inject-unavailable: the embedded injector has no setup() (see the engine log)";
    return false;
  }
  if (!configured) {
    pending_discard();
    *why = "track-inject-config-invalid: GRC_LIVE_TRACK_INPUT_CONFIG is not a JSON object the "
           "injector's configure() accepts";
    return false;
  }
  return true;
}

void gd_tracks_builtin_discard() {
  pending_discard();
  builtin_release(true);
}

bool gd_tracks_builtin_bind(TrackHub *hub, std::string *why) {
  if (g_pending.node == nullptr || hub == nullptr) {
    *why = "track-inject-unavailable: no prepared injector";
    return false;
  }
  auto sp = std::make_shared<State>();
  sp->owner = g_pending.node;
  sp->owner_id = g_pending.id;
  sp->kind = rs::tracks::kKindInput;
  sp->up = {"gsw-input/1"};
  std::string error;
  if (!hub->bind(sp->kind, sp.get(), &error)) {
    sp->kind.clear();
    pending_discard();
    *why = "track-inject-invalid: " + error;
    return false;
  }
  sp->on_hub = true;
  g_reg.builtin = sp;
  track_list(sp);
  g_pending = Pending();
  // In the tree from the next message flush; with no tree yet, the next gd_tracks_flush retries.
  g_builtin_attached = false;
  node_call(sp->owner_id, "attach", &g_builtin_attached);
  return true;
}

const char *gd_tracks_builtin_addon_sha256() { return kBuiltinInjectAddonSha256; }

void gd_track_class_unregister() {
  if (!g_registered) return;
  g_pending = Pending();  // the engine is finalizing: nothing may call into it
  builtin_release(false);
  SName cls(kClassName);
  g_fn.unregister_class(g_iface.library, cls.ptr());
  g_registered = false;
}

void gd_tracks_attach(TrackHub *hub) {
  g_reg.phase = Phase::Serving;
  g_reg.hub = hub;
  for (auto it = g_reg.bound.begin(); it != g_reg.bound.end();) {
    State &s = *it->second;
    if (!hub_bind(s)) {
      s.kind.clear();  // the hub's own receiver holds the kind: this one is unbound
      it = g_reg.bound.erase(it);
    } else {
      ++it;
    }
  }
}

void gd_tracks_detach() {
  if (g_reg.hub != nullptr) {
    for (const auto &entry : g_reg.bound) {
      if (entry.second->on_hub) g_reg.hub->unbind(entry.second.get());  // nothing is open now
      entry.second->on_hub = false;
    }
    if (g_reg.builtin != nullptr && g_reg.builtin->on_hub) {
      g_reg.hub->unbind(g_reg.builtin.get());
      g_reg.builtin->on_hub = false;
      g_reg.builtin->kind.clear();  // its queued closed() calls still flush; then it is released
    }
  }
  g_reg.hub = nullptr;
  g_reg.phase = Phase::Stopped;
}

void gd_tracks_flush() {
  if (!g_any.load(std::memory_order_relaxed)) return;
  const std::vector<std::shared_ptr<State>> list = g_reg.list;
  for (const std::shared_ptr<State> &sp : list) flush_one(sp);
  if (g_reg.builtin != nullptr && !g_builtin_attached && g_reg.phase == Phase::Serving) {
    node_call(g_reg.builtin->owner_id, "attach", &g_builtin_attached);
  }
  // TRK6: once live stopped and its last closed() reached the injector (which released what the
  // source held), the injector node has nothing left to do.
  if (g_reg.builtin != nullptr && g_reg.phase == Phase::Stopped && g_reg.builtin->queue.empty()) {
    builtin_release(true);
  }
  // A state with nothing bound and nothing queued has no more work.
  for (auto it = g_reg.list.begin(); it != g_reg.list.end();) {
    it = (*it)->kind.empty() && (*it)->queue.empty() ? g_reg.list.erase(it) : it + 1;
  }
  if (g_reg.list.empty()) g_any.store(false, std::memory_order_relaxed);
}

}  // namespace live
}  // namespace grc
