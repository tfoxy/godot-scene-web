#include "audio_driver_log.h"
#include "iface.h"
#include "report.h"
#include "rs_file.h"
#include "rs_variant.h"
#include "vtable.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#if defined(__linux__) && defined(__x86_64__)
#include <sys/uio.h>
#include <unistd.h>

namespace grc::audio {
namespace {
// Godot 4.5.1 template-release, single-precision, x86-64. RefCounted is 312 bytes;
// audio_stream.h places stream first in AudioSample and AudioSamplePlayback.
// Preflight verifies defaults on engine-constructed objects before publication;
// every subsequent stream read also verifies its live RTTI and bound class name.
constexpr size_t kStream=312, kSampleLoop=344, kOffset=328, kPitch=332, kVolumes=336, kBus=352;
ShadowVtable shadow;
void *original[38]={};
std::mutex mutex;
rs::File output;
std::vector<Slot> slots;
std::map<uint64_t,int32_t> stream_loops;
bool logging=false;
GDExtensionMethodBindPtr get_class=nullptr, get_length=nullptr;

template<class T> bool read(uint64_t a,T *out) {
  iovec local{out,sizeof(T)}, remote{reinterpret_cast<void *>(a),sizeof(T)};
  return process_vm_readv(getpid(),&local,1,&remote,1,0)==ssize_t(sizeof(T));
}
uint64_t address(const void *p) {return reinterpret_cast<uint64_t>(p);}
uint64_t id(void *p) {return p?g_iface.object_get_instance_id(p):0;}
void write(JsonWriter &j) {
  auto s=j.object_end().take();
  s.erase(std::remove(s.begin(),s.end(),'\n'),s.end());
  if(output) {std::fprintf(output.get(),"%s\n",s.c_str());std::fflush(output.get());}
}
void begin(JsonWriter &j,const std::string &name) {
  const auto us=std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
  j.object_begin().field("monotonic_us",int64_t(us)).field("slot",name);
}
void refuse(JsonWriter &j,const char *reason) {
  j.field("refused",std::string(reason));
  bool was=false,restored=false;shadow.disarm(&was,&restored);
  j.field("restored",restored);logging=false;
}
bool class_is(void *p,const char *expected) {
  std::string name;return p && call_string_getter(get_class,p,&name) && name==expected;
}
bool stream_class(void *p,std::string *name) {
  // Validate the raw member pointer before asking the GDExtension API to dereference it.
  uint64_t vt=0,ti=0,text=0;
  if(!p || !read(address(p),&vt) || vt<16 || !read(vt-8,&ti) || !read(ti+8,&text))return false;
  std::string rtti;
  for(size_t i=0;i<64;++i) {char c=0;if(!read(text+i,&c))return false;if(!c)break;rtti+=c;}
  const char *classes[]={"AudioStreamWAV","AudioStreamMP3","AudioStreamOggVorbis"};
  bool known=false;
  for(auto *c:classes) if(rtti==std::to_string(std::strlen(c))+c)known=true;
  if(!known || !call_string_getter(get_class,p,name))return false;
  return rtti==std::to_string(name->size())+*name;
}
bool volumes(JsonWriter &j,const void *vector) {
  uint64_t data=0,n=0;
  if(!read(address(vector)+8,&data) || (data && (!read(data-8,&n) || n>4))) {j.null();return false;}
  float values[8]={};
  for(uint64_t i=0;i<n*2;++i)
    if(!read(data+i*4,&values[i]) || !std::isfinite(values[i])) {j.null();return false;}
  j.array_begin();
  for(uint64_t i=0;i<n;++i)
    j.array_begin().float32(values[i*2]).float32(values[i*2+1]).array_end();
  j.array_end();return true;
}

bool metadata(JsonWriter &j,const void *ref,int kind) {
  void *obj=nullptr;
  if(!read(address(ref),&obj) || !obj)return false;
  j.key("object_id").unsigned_integer(id(obj));
  if(kind && !class_is(obj,kind==1?"AudioSample":"AudioSamplePlayback"))return false;
  void *stream=obj;
  if(kind && !read(address(obj)+kStream,&stream))return false;
  std::string cls;
  if(!stream_class(stream,&cls))return false;
  double length=0;
  g_iface.object_method_bind_ptrcall(get_length,stream,nullptr,&length);
  if(!std::isfinite(length) || length<0)return false;
  const auto sid=id(stream);
  j.key("stream_id").unsigned_integer(sid).field("stream_class",cls).key("length_s").float64(length);
  if(kind==1) {
    int32_t loop=0;
    if(!read(address(obj)+kSampleLoop,&loop) || loop<0 || loop>3)return false;
    stream_loops[sid]=loop;j.field("loop_mode",int64_t(loop));
  } else if(kind==2) {
    auto i=stream_loops.find(sid);if(i==stream_loops.end())return false;
    float offset=0,pitch=0;
    if(!read(address(obj)+kOffset,&offset) || !read(address(obj)+kPitch,&pitch) ||
       !std::isfinite(offset) || !std::isfinite(pitch) || pitch<=0)return false;
    j.field("loop_mode",int64_t(i->second)).key("offset_s").float32(offset).key("pitch_scale").float32(pitch);
    j.key("volume_vector");if(!volumes(j,reinterpret_cast<void *>(address(obj)+kVolumes)))return false;
    j.field("bus",rs::decode_string_name(reinterpret_cast<void *>(address(obj)+kBus)));
  }
  return true;
}
struct NoExtra {void operator()(JsonWriter &) const {}};
template<class Extra=NoExtra> void event(size_t i,const void *ref=nullptr,int kind=0,Extra extra={}) {
  std::lock_guard<std::mutex> lock(mutex);
  if(!logging)return;
  JsonWriter j;begin(j,slots[i].name);
  if(ref && !metadata(j,ref,kind))refuse(j,"audio member layout or stream verification failed");
  extra(j);write(j);
}
template<size_t I,class R,class...A> R forward(void *self,A...a) {
  return reinterpret_cast<R(*)(void *,A...)>(original[I])(self,a...);
}
template<size_t I,int Kind> void sample(void *self,const void *ref) {
  event(I,ref,Kind);forward<I,void>(self,ref);
}
bool registered(void *s,const void *r) {event(18,r,0);return forward<18,bool>(s,r);}
void pause(void *s,const void *r,bool b) {event(23,r,2,[&](JsonWriter &j){j.field("paused",b);});forward<23,void>(s,r,b);}
bool active(void *s,const void *r) {event(24,r,2);return forward<24,bool>(s,r);}
double position(void *s,const void *r) {event(25,r,2);return forward<25,double>(s,r);}
void pitch(void *s,const void *r,float v) {event(26,r,2,[&](JsonWriter &j){j.key("new_pitch_scale").float32(v);});forward<26,void>(s,r,v);}
void bus_volumes(void *s,const void *r,const void *map) {
  event(27,r,2,[&](JsonWriter &j){
    uint64_t head=0;uint32_t count=0;
    j.key("bus_volumes").array_begin();
    bool ok=read(address(map)+16,&head) && read(address(map)+36,&count) && count<=6;
    for(uint32_t n=0;ok && n<count;++n) {
      uint64_t next=0;
      if(!head || !read(head,&next)) {ok=false;break;}
      j.object_begin().field("bus",rs::decode_string_name(reinterpret_cast<void *>(head+16))).key("volumes");
      ok=volumes(j,reinterpret_cast<void *>(head+24));j.object_end();head=next;
    }
    j.array_end();if(!ok || head)refuse(j,"bus-volume layout verification failed");
  });forward<27,void>(s,r,map);
}
template<size_t I> void bus_int(void *s,int v) {event(I,nullptr,0,[&](JsonWriter &j){j.field("value",int64_t(v));});forward<I,void>(s,v);}
void move_bus(void *s,int a,int b) {event(31,nullptr,0,[&](JsonWriter &j){j.field("bus_index",int64_t(a)).field("to_index",int64_t(b));});forward<31,void>(s,a,b);}
void send(void *s,int bus,const void *name) {event(32,nullptr,0,[&](JsonWriter &j){j.field("bus_index",int64_t(bus)).field("send",rs::decode_string_name(name));});forward<32,void>(s,bus,name);}
void volume(void *s,int bus,float v) {event(33,nullptr,0,[&](JsonWriter &j){j.field("bus_index",int64_t(bus)).key("volume_db").float32(v);});forward<33,void>(s,bus,v);}
template<size_t I> void bus_bool(void *s,int bus,bool b) {event(I,nullptr,0,[&](JsonWriter &j){j.field("bus_index",int64_t(bus)).field("enabled",b);});forward<I,void>(s,bus,b);}
bool preflight(std::string *error) {
  if(!g_iface.classdb_construct_object2 || !g_iface.object_destroy || !g_iface.object_get_instance_id ||
     !g_iface.get_variant_from_type_constructor || !g_iface.variant_destroy || !g_iface.ref_get_object) {
    *error="audio GDExtension interfaces unavailable";return false;
  }
  get_class=method_bind("Object","get_class",201670096);
  get_length=method_bind("AudioStream","get_length",1740695150);
  if(!get_class || !get_length) {*error="audio metadata method binds unavailable";return false;}
  StringName s("AudioSample"), p("AudioSamplePlayback");
  void *sample_obj=g_iface.classdb_construct_object2(s.ptr());
  void *play_obj=g_iface.classdb_construct_object2(p.ptr());
  uint64_t a=1,b=1;float offset=-1,pitch_scale=-1;int32_t channels=0,rate=0,loop=-1;
  bool ok=class_is(sample_obj,"AudioSample") && class_is(play_obj,"AudioSamplePlayback") &&
    read(address(sample_obj)+kStream,&a) && !a && read(address(play_obj)+kStream,&b) && !b &&
    read(address(sample_obj)+336,&channels) && channels==1 && read(address(sample_obj)+340,&rate) && rate==44100 &&
    read(address(sample_obj)+kSampleLoop,&loop) && loop==0 &&
    read(address(play_obj)+kOffset,&offset) && offset==0 && read(address(play_obj)+kPitch,&pitch_scale) && pitch_scale==1;
  if(sample_obj)g_iface.object_destroy(sample_obj);
  if(play_obj)g_iface.object_destroy(play_obj);
  if(!ok)*error="audio header member layout preflight failed";
  return ok;
}
bool set_default_sample() {
  auto call=reinterpret_cast<GDExtensionInterfaceVariantCall>(g_iface.get_proc_address("variant_call"));
  if(!call)return false;
  alignas(8) unsigned char obj[24]={},name[24]={},value[24]={},ret[24]={};
  void *settings=singleton_object("ProjectSettings"), *text=nullptr;
  if(!settings)return false;
  g_iface.string_new_with_utf8_chars(&text,"audio/general/default_playback_type");
  int64_t one=1;
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_OBJECT)(obj,&settings);
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING)(name,&text);
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_INT)(value,&one);
  StringName method("set_setting");const GDExtensionConstVariantPtr args[]={name,value};GDExtensionCallError e{};
  call(obj,method.ptr(),args,2,ret,&e);
  g_iface.variant_destroy(ret);g_iface.variant_destroy(value);g_iface.variant_destroy(name);g_iface.variant_destroy(obj);
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING)(&text);
  return e.error==GDEXTENSION_CALL_OK;
}
}  // namespace
bool start_log(const Probe &probe,const Abi &abi,const std::string &dir,std::string *error) {
  if(dir.empty()) {*error="GRC_AUDIO=log requires GRC_EVIDENCE_DIR";return false;}
  uint64_t live=0;
  if(!read(probe.object,&live) || live!=probe.vptr) {*error="audio vptr changed since probe";return false;}
  if(abi.slots.size()!=38 || !preflight(error))return false;
  output.reset(rs::open_file(path_join(dir,"audio-commands.jsonl").c_str(),"wb"));
  if(!output) {*error="cannot open audio command log";return false;}
  slots=abi.slots;
  void *hooks[]={reinterpret_cast<void *>(registered),reinterpret_cast<void *>(sample<19,1>),
    reinterpret_cast<void *>(sample<20,1>),reinterpret_cast<void *>(sample<21,2>),reinterpret_cast<void *>(sample<22,2>),
    reinterpret_cast<void *>(pause),reinterpret_cast<void *>(active),reinterpret_cast<void *>(position),
    reinterpret_cast<void *>(pitch),reinterpret_cast<void *>(bus_volumes),reinterpret_cast<void *>(bus_int<28>),
    reinterpret_cast<void *>(bus_int<29>),reinterpret_cast<void *>(bus_int<30>),reinterpret_cast<void *>(move_bus),
    reinterpret_cast<void *>(send),reinterpret_cast<void *>(volume),reinterpret_cast<void *>(bus_bool<34>),reinterpret_cast<void *>(bus_bool<35>)};
  std::vector<SlotReplacement> replacements;
  for(size_t i=0;i<18;++i)replacements.push_back({i+18,hooks[i],&original[i+18]});
  if(!shadow.arm(reinterpret_cast<void *>(probe.object),38,replacements,error))return false;
  logging=true;
  const bool setting=set_default_sample();
  JsonWriter j;begin(j,"armed");j.field("setting_updated",setting).field("cache_update",std::string("observe fixture default-player sample playback"));write(j);
  if(!setting) {stop_log();*error="ProjectSettings.set_setting failed";return false;}
  return true;
}
void stop_log() {
  std::lock_guard<std::mutex> lock(mutex);
  if(!shadow.built())return;
  bool was=false,restored=false;shadow.disarm(&was,&restored);
  JsonWriter j;begin(j,"disarm");j.field("was_shadow",was).field("restored",restored);write(j);
  logging=false;output.reset();
}
}  // namespace grc::audio
#else
namespace grc::audio {
bool start_log(const Probe &,const Abi &,const std::string &,std::string *error) {*error="audio logging supports Linux x86-64 only";return false;}
void stop_log() {}
}
#endif
