#include "native_api.hpp"
#include <map>
#include <mutex>
#include <string>
using namespace grc::fmod;
#define TEST_API extern "C" __attribute__((visibility("default")))
namespace {
std::mutex mutex;
std::map<std::string, unsigned> calls;
std::map<std::string, unsigned> order;
unsigned sequence = 0;
Result record(const std::string &s) { std::lock_guard lock(mutex); ++calls[s]; order[s]=++sequence; return ok; }
Result label(const char *kind, const char *name, const char *value, int seek) {
  record(std::string(kind)+":"+name+":"+value);
  if (seek) return 31;
  if (std::string(name)=="fatal") return 30;
  return std::string(name)=="unknown" || std::string(value)=="unknown" ? event_notfound : ok;
}
}
TEST_API unsigned fake_call_count(const char *s) { std::lock_guard lock(mutex); return calls[s]; }
TEST_API unsigned fake_call_order(const char *s) { std::lock_guard lock(mutex); return order[s]; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_SetDSPBufferSize(Core *, unsigned, int) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_GetAdvancedSettings(Core *, AdvancedSettings *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_SetAdvancedSettings(Core *, AdvancedSettings *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_GetMasterChannelGroup(Core *, Group **out) { *out=reinterpret_cast<Group *>(1); return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_CreateDSP(Core *, const DspDescription *, Dsp **out) { *out=reinterpret_cast<Dsp *>(1); return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_Update(Studio *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_Bank_LoadSampleData(Bank *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_FlushSampleLoading(Studio *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_GetEvent(Studio *, const char *, Description **out) { *out=reinterpret_cast<Description *>(1); return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventDescription_IsOneshot(Description *, int *out) { *out=0; return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventDescription_CreateInstance(Description *, Instance **out) { *out=reinterpret_cast<Instance *>(1); return record("create"); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_SetParameterByName(Instance *, const char *name, float, int) { return record(std::string("event-numeric:")+name); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_SetParameterByName(Studio *, const char *name, float, int) { return record(std::string("global-numeric:")+name); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_SetParameterByNameWithLabel(Instance *, const char *name, const char *value, int seek) { return label("event-label",name,value,seek); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_SetParameterByNameWithLabel(Studio *, const char *name, const char *value, int seek) { return label("global-label",name,value,seek); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_Start(Instance *) { return record("start"); }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_Stop(Instance *, int) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_Release(Instance *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_SetPaused(Instance *, int) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_EventInstance_GetPlaybackState(Instance *, int *out) { *out=2; return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_GetBus(Studio *, const char *, Bus **out) { *out=reinterpret_cast<Bus *>(1); return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_Bus_SetVolume(Bus *, float) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_Bus_LockChannelGroup(Bus *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_Bus_UnlockChannelGroup(Bus *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_Bus_GetChannelGroup(Bus *, Group **out) { *out=reinterpret_cast<Group *>(1); return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_ChannelGroup_AddDSP(Group *, int, Dsp *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_ChannelGroup_RemoveDSP(Group *, Dsp *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_DSP_Release(Dsp *) { return ok; }
