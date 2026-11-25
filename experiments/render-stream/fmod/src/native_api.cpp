#include "native_api.hpp"
#include <stdexcept>
#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif
namespace grc::fmod {
namespace {
void *loaded(const char *name) {
  if (!name || !*name) throw std::runtime_error("fmod-not-loaded");
#if defined(_WIN32)
  // The public config is UTF-8; no LoadLibrary fallback is permitted.
  wchar_t wide[32768];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide, 32768))
    throw std::runtime_error("fmod-not-loaded");
  auto handle = reinterpret_cast<void *>(GetModuleHandleW(wide));
#else
  auto handle = dlopen(name, RTLD_NOW | RTLD_NOLOAD | RTLD_LOCAL);
#endif
  if (!handle) throw std::runtime_error("fmod-not-loaded");
  return handle;
}
template<class T> void symbol(void *lib, const char *name, T &out) {
#if defined(_WIN32)
  out = reinterpret_cast<T>(GetProcAddress(static_cast<HMODULE>(lib), name));
#else
  out = reinterpret_cast<T>(dlsym(lib, name));
#endif
  if (!out) throw std::runtime_error("version");
}
}
Api::~Api() {
#if !defined(_WIN32)
  if (studio_lib_) dlclose(studio_lib_);
  if (core_lib_) dlclose(core_lib_);
#endif
}
void Api::bind(const char *core_name, const char *studio_name) {
  core_lib_ = loaded(core_name);
  studio_lib_ = loaded(studio_name);
  symbol(core_lib_, "FMOD_System_Create", core_create);
  symbol(core_lib_, "FMOD_System_Release", core_release);
  symbol(core_lib_, "FMOD_System_GetVersion", get_version);
  symbol(core_lib_, "FMOD_System_SetOutput", set_output);
  symbol(core_lib_, "FMOD_System_SetSoftwareFormat", set_format);
  symbol(studio_lib_, "FMOD_Studio_System_Create", studio_create);
  symbol(studio_lib_, "FMOD_Studio_System_Release", studio_release);
  symbol(studio_lib_, "FMOD_Studio_System_GetCoreSystem", get_core);
  symbol(studio_lib_, "FMOD_Studio_System_Initialize", initialize);
  symbol(studio_lib_, "FMOD_Studio_System_LoadBankCustom", load_bank);
}
void Api::bind_render() {
  symbol(core_lib_, "FMOD_System_SetDSPBufferSize", buffer_size);
  symbol(core_lib_, "FMOD_System_GetAdvancedSettings", get_advanced);
  symbol(core_lib_, "FMOD_System_SetAdvancedSettings", set_advanced);
  symbol(core_lib_, "FMOD_System_GetMasterChannelGroup", master_group);
  symbol(core_lib_, "FMOD_System_CreateDSP", create_dsp);
  symbol(studio_lib_, "FMOD_Studio_System_Update", update);
  symbol(studio_lib_, "FMOD_Studio_Bank_LoadSampleData", load_samples);
  symbol(studio_lib_, "FMOD_Studio_System_FlushSampleLoading", flush_samples);
  symbol(studio_lib_, "FMOD_Studio_System_GetEvent", get_event);
  symbol(studio_lib_, "FMOD_Studio_EventDescription_IsOneshot", is_oneshot);
  symbol(studio_lib_, "FMOD_Studio_EventDescription_CreateInstance", instance_create);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_SetParameterByName", parameter);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_Start", event_start);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_Stop", event_stop);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_Release", event_release);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_GetPlaybackState", playback);
  symbol(studio_lib_, "FMOD_Studio_System_GetBus", get_bus);
  symbol(studio_lib_, "FMOD_Studio_Bus_SetVolume", bus_volume);
  symbol(studio_lib_, "FMOD_Studio_Bus_LockChannelGroup", bus_lock);
  symbol(studio_lib_, "FMOD_Studio_Bus_UnlockChannelGroup", bus_unlock);
  symbol(studio_lib_, "FMOD_Studio_Bus_GetChannelGroup", bus_group);
  symbol(core_lib_, "FMOD_ChannelGroup_AddDSP", add_dsp);
  symbol(core_lib_, "FMOD_ChannelGroup_RemoveDSP", remove_dsp);
  symbol(core_lib_, "FMOD_DSP_Release", release_dsp);
}
void Api::bind_lane() {
  symbol(studio_lib_, "FMOD_Studio_System_SetParameterByName", global_parameter);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_SetParameterByNameWithLabel", parameter_label);
  symbol(studio_lib_, "FMOD_Studio_System_SetParameterByNameWithLabel", global_parameter_label);
  symbol(studio_lib_, "FMOD_Studio_EventInstance_SetPaused", event_paused);
}
Studio *Api::create() {
  Studio *studio = nullptr;
  const auto first = studio_create(&studio, header_version);
  if (first == ok) return studio;
  if (first != header_mismatch) throw std::runtime_error("create");
  unsigned actual = 0;
  for (unsigned patch = 0; patch <= 0xff; ++patch) {
    Core *probe = nullptr;
    const auto result = core_create(&probe, 0x00020300 | patch);
    if (result == header_mismatch) continue;
    if (result != ok) throw std::runtime_error("version");
    unsigned build = 0;
    const auto got = get_version(probe, &actual, &build);
    const auto released = core_release(probe);
    if (got != ok || released != ok || (actual & 0xffffff00) != 0x00020300)
      throw std::runtime_error("version");
    break;
  }
  if (!actual) throw std::runtime_error("version");
  if (studio_create(&studio, actual) != ok) throw std::runtime_error("version");
  return studio;
}
}
