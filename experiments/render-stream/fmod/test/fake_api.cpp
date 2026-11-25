#include "native_api.hpp"
#include <atomic>
#include <cstdlib>
#include <cstring>
#if !defined(_WIN32)
#include <dlfcn.h>
#endif
using namespace grc::fmod;
#if defined(_WIN32)
#define TEST_API extern "C" __declspec(dllexport)
#else
#define TEST_API extern "C" __attribute__((visibility("default")))
#endif
namespace {
std::atomic<unsigned> creates{0}, probes{0}, releases{0}, bank_loads{0};
BankInfo saved_info{};
unsigned actual() { const auto *v = std::getenv("GRC_FAKE_VERSION"); return v ? std::strtoul(v, nullptr, 16) : header_version; }
bool mode(const char *value) { const auto *v = std::getenv("GRC_FAKE_MODE"); return v && !std::strcmp(v, value); }
}
TEST_API unsigned fake_creates() { return creates; }
TEST_API unsigned fake_probes() { return probes; }
TEST_API unsigned fake_releases() { return releases; }
TEST_API unsigned fake_bank_loads() { return bank_loads; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_Create(Core **out, unsigned version) {
  ++probes;
  if (version != (mode("outside") ? 0x00020301u : actual())) return header_mismatch;
  *out = reinterpret_cast<Core *>(1); return ok;
}
TEST_API Result GRC_NATIVE_CALL FMOD_System_Release(Core *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_GetVersion(Core *, unsigned *version, unsigned *build) {
  *version = actual(); *build = 0; return ok;
}
TEST_API Result GRC_NATIVE_CALL FMOD_System_SetOutput(Core *, int output) { return output == 4 ? ok : 1; }
TEST_API Result GRC_NATIVE_CALL FMOD_System_SetSoftwareFormat(Core *, int rate, int mode, int) {
  return rate == 48000 && mode == 3 ? ok : 1;
}
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_Create(Studio **out, unsigned version) {
  ++creates;
  if (mode("create")) return 1;
  if (mode("outside") || version != actual() || (mode("retry") && creates == 2)) return header_mismatch;
  *out = reinterpret_cast<Studio *>(1); return ok;
}
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_Release(Studio *) { ++releases; return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_GetCoreSystem(Studio *, Core **out) {
  *out = reinterpret_cast<Core *>(1); return ok;
}
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_Initialize(Studio *, int, unsigned, unsigned, void *) { return ok; }
TEST_API Result GRC_NATIVE_CALL FMOD_Studio_System_LoadBankCustom(Studio *, const BankInfo *info, unsigned, Bank **out) {
  if (mode("bank")) return 1;
  if (info->size != sizeof(BankInfo)) return 1;
  struct Scope {
    void (*phase)(int) = nullptr;
    Scope() {
#if !defined(_WIN32)
      phase = reinterpret_cast<void (*)(int)>(dlsym(RTLD_DEFAULT, "grc_test_callback_phase"));
#endif
      if (phase) phase(1);
    }
    ~Scope() { if (phase) phase(0); }
  } scope;
  void *file = nullptr;
  unsigned size = 0, got = 0;
  char bytes[16]{};
  if (info->opencallback(nullptr, &size, &file, info->userdata) != ok || size != 8) return 1;
  if (info->readcallback(file, bytes, 3, &got, info->userdata) != ok || got != 3 || std::memcmp(bytes, "abc", 3)) return 1;
  if (info->seekcallback(file, 6, info->userdata) != ok) return 1;
  if (info->readcallback(file, bytes, 16, &got, info->userdata) != file_eof || got != 2 || std::memcmp(bytes, "gh", 2)) return 1;
  if (info->seekcallback(file, 9, info->userdata) == ok) return 1;
  if (info->closecallback(file, info->userdata) != ok) return 1;
  if (info->closecallback(file, info->userdata) == ok) return 1;
  // Exercise every preallocated open slot and independent cursor.
  void *files[16]{};
  for (auto &f : files) if (info->opencallback(nullptr, &size, &f, info->userdata) != ok) return 1;
  if (info->opencallback(nullptr, &size, &file, info->userdata) == ok) return 1;
  for (auto f : files) if (info->closecallback(f, info->userdata) != ok) return 1;
  saved_info = *info;
  ++bank_loads; *out = reinterpret_cast<Bank *>(1); return ok;
}

TEST_API void fake_late_read() {
  void *file = nullptr; unsigned size = 0, got = 0; char byte = 0;
  if (saved_info.opencallback(nullptr, &size, &file, saved_info.userdata) != ok) return;
  saved_info.readcallback(file, &byte, 1, &got, saved_info.userdata);
  saved_info.closecallback(file, saved_info.userdata);
}
