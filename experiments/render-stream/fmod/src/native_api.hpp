#ifndef GRC_NATIVE_API_HPP
#define GRC_NATIVE_API_HPP
#include <cstddef>
#include <cstdint>

// Hand-declared subset of the public FMOD 2.03 C API. No SDK is required.
// https://www.fmod.com/docs/2.03/api/core-api-system.html
// https://www.fmod.com/docs/2.03/api/studio-api-system.html
namespace grc::fmod {
#if defined(_WIN32)
#define GRC_NATIVE_CALL __stdcall
#else
#define GRC_NATIVE_CALL
#endif
using Result = int;
struct Core;
struct Studio;
struct Bank;
constexpr Result ok = 0, file_eof = 16, header_mismatch = 20, event_notfound = 74;
constexpr std::uint32_t header_version = 0x00020306;
using Open = Result (GRC_NATIVE_CALL *)(const char *, unsigned *, void **, void *);
using Close = Result (GRC_NATIVE_CALL *)(void *, void *);
using Read = Result (GRC_NATIVE_CALL *)(void *, void *, unsigned, unsigned *, void *);
using Seek = Result (GRC_NATIVE_CALL *)(void *, unsigned, void *);
struct BankInfo {
  int size;
  void *userdata;
  int userdatalength;
  Open opencallback;
  Close closecallback;
  Read readcallback;
  Seek seekcallback;
};
static_assert(sizeof(void *) == 8, "Only 64-bit FMOD layouts are supported");
static_assert(sizeof(BankInfo) == 56);
static_assert(offsetof(BankInfo, opencallback) == 24);

struct Description;
struct Instance;
struct Bus;
struct Group;
struct Dsp;
struct DspState; // Intentionally opaque: callbacks never inspect FMOD's state.
struct AdvancedSettings {
  int cbSize, maxMPEGCodecs, maxADPCMCodecs, maxXMACodecs, maxVorbisCodecs;
  int maxAT9Codecs, maxFADPCMCodecs, maxPCMCodecs, ASIONumChannels;
  char **ASIOChannelList;
  int *ASIOSpeakerList;
  float vol0virtualvol;
  unsigned defaultDecodeBufferSize;
  unsigned short profilePort;
  unsigned geometryMaxFadeTime;
  float distanceFilterCenterFreq;
  int reverb3Dinstance, DSPBufferPoolSize, resamplerMethod;
  unsigned randomSeed;
  int maxConvolutionThreads, maxOpusCodecs, maxSpatialObjects;
};
using DspRead = Result (GRC_NATIVE_CALL *)(DspState *, float *, float *, unsigned, int, int *);
struct DspDescription {
  unsigned pluginsdkversion;
  char name[32];
  unsigned version;
  int numinputbuffers, numoutputbuffers;
  void *create, *release, *reset;
  DspRead read;
  void *process, *setposition;
  int numparameters;
  void *paramdesc, *setparameterfloat, *setparameterint, *setparameterbool, *setparameterdata;
  void *getparameterfloat, *getparameterint, *getparameterbool, *getparameterdata;
  void *shouldiprocess, *userdata, *sys_register, *sys_deregister, *sys_mix;
};
static_assert(sizeof(AdvancedSettings) == 104 && offsetof(AdvancedSettings, randomSeed) == 88);
static_assert(sizeof(DspDescription) == 216 && offsetof(DspDescription, read) == 72);

class Api {
 public:
  Api() = default;
  ~Api();
  Api(const Api &) = delete;
  Api &operator=(const Api &) = delete;
  void bind(const char *core_name, const char *studio_name);
  Studio *create();
  void bind_render();
  void bind_lane();
  Result (GRC_NATIVE_CALL *studio_create)(Studio **, unsigned) = nullptr;
  Result (GRC_NATIVE_CALL *studio_release)(Studio *) = nullptr;
  Result (GRC_NATIVE_CALL *get_core)(Studio *, Core **) = nullptr;
  Result (GRC_NATIVE_CALL *initialize)(Studio *, int, unsigned, unsigned, void *) = nullptr;
  Result (GRC_NATIVE_CALL *load_bank)(Studio *, const BankInfo *, unsigned, Bank **) = nullptr;
  Result (GRC_NATIVE_CALL *core_create)(Core **, unsigned) = nullptr;
  Result (GRC_NATIVE_CALL *core_release)(Core *) = nullptr;
  Result (GRC_NATIVE_CALL *get_version)(Core *, unsigned *, unsigned *) = nullptr;
  Result (GRC_NATIVE_CALL *set_output)(Core *, int) = nullptr;
  Result (GRC_NATIVE_CALL *set_format)(Core *, int, int, int) = nullptr;
  Result (GRC_NATIVE_CALL *buffer_size)(Core *, unsigned, int) = nullptr;
  Result (GRC_NATIVE_CALL *get_advanced)(Core *, AdvancedSettings *) = nullptr;
  Result (GRC_NATIVE_CALL *set_advanced)(Core *, AdvancedSettings *) = nullptr;
  Result (GRC_NATIVE_CALL *update)(Studio *) = nullptr;
  Result (GRC_NATIVE_CALL *load_samples)(Bank *) = nullptr;
  Result (GRC_NATIVE_CALL *flush_samples)(Studio *) = nullptr;
  Result (GRC_NATIVE_CALL *get_event)(Studio *, const char *, Description **) = nullptr;
  Result (GRC_NATIVE_CALL *is_oneshot)(Description *, int *) = nullptr;
  Result (GRC_NATIVE_CALL *instance_create)(Description *, Instance **) = nullptr;
  Result (GRC_NATIVE_CALL *parameter)(Instance *, const char *, float, int) = nullptr;
  Result (GRC_NATIVE_CALL *global_parameter)(Studio *, const char *, float, int) = nullptr;
  Result (GRC_NATIVE_CALL *parameter_label)(Instance *, const char *, const char *, int) = nullptr;
  Result (GRC_NATIVE_CALL *global_parameter_label)(Studio *, const char *, const char *, int) = nullptr;
  Result (GRC_NATIVE_CALL *event_paused)(Instance *, int) = nullptr;
  Result (GRC_NATIVE_CALL *event_start)(Instance *) = nullptr;
  Result (GRC_NATIVE_CALL *event_stop)(Instance *, int) = nullptr;
  Result (GRC_NATIVE_CALL *event_release)(Instance *) = nullptr;
  Result (GRC_NATIVE_CALL *playback)(Instance *, int *) = nullptr;
  Result (GRC_NATIVE_CALL *get_bus)(Studio *, const char *, Bus **) = nullptr;
  Result (GRC_NATIVE_CALL *bus_volume)(Bus *, float) = nullptr;
  Result (GRC_NATIVE_CALL *bus_lock)(Bus *) = nullptr;
  Result (GRC_NATIVE_CALL *bus_unlock)(Bus *) = nullptr;
  Result (GRC_NATIVE_CALL *bus_group)(Bus *, Group **) = nullptr;
  Result (GRC_NATIVE_CALL *master_group)(Core *, Group **) = nullptr;
  Result (GRC_NATIVE_CALL *create_dsp)(Core *, const DspDescription *, Dsp **) = nullptr;
  Result (GRC_NATIVE_CALL *add_dsp)(Group *, int, Dsp *) = nullptr;
  Result (GRC_NATIVE_CALL *remove_dsp)(Group *, Dsp *) = nullptr;
  Result (GRC_NATIVE_CALL *release_dsp)(Dsp *) = nullptr;
 private:
  void *core_lib_ = nullptr, *studio_lib_ = nullptr;
};
}
#endif
