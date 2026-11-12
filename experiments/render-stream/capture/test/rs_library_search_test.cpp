// PE loader search order, full-path conversion and UTF-8 paths, without a Godot host.
#include "rs_net_module.h"
#include "test_paths.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>

namespace rs = grc::rs;
namespace fs = std::filesystem;
using grc::test::path_utf8;
using grc::live::load_net_module_at;

namespace {
void win_check(bool ok, const std::string &operation) {
  if (!ok) throw std::system_error(static_cast<int>(::GetLastError()), std::system_category(), operation);
}

struct ProcessState {
  fs::path cwd = fs::current_path();
  std::wstring path;
  bool path_present = false;
  ProcessState() {
    ::SetLastError(ERROR_SUCCESS);
    const DWORD n = ::GetEnvironmentVariableW(L"PATH", nullptr, 0);
    if (!n) {
      const DWORD error = ::GetLastError();
      if (error != ERROR_ENVVAR_NOT_FOUND && error != ERROR_SUCCESS)
        throw std::system_error(static_cast<int>(error), std::system_category(), "read PATH");
      path_present = error != ERROR_ENVVAR_NOT_FOUND;
    } else {
      path.resize(n);
      const DWORD written = ::GetEnvironmentVariableW(L"PATH", path.data(), n);
      win_check(written > 0 && written < n, "read PATH");
      path.resize(written);
      path_present = true;
    }
  }
  void restore() const {
    win_check(::SetCurrentDirectoryW(cwd.c_str()), "restore cwd " + path_utf8(cwd));
    win_check(::SetEnvironmentVariableW(L"PATH", path_present ? path.c_str() : nullptr), "restore PATH");
  }
  ~ProcessState() {
    ::SetCurrentDirectoryW(cwd.c_str());
    ::SetEnvironmentVariableW(L"PATH", path_present ? path.c_str() : nullptr);
  }
};

struct Module {
  void *handle = nullptr;
  ~Module() { if (handle) ::FreeLibrary(static_cast<HMODULE>(handle)); }
};

void set_cwd(const fs::path &path) {
  win_check(::SetCurrentDirectoryW(path.c_str()), "SetCurrentDirectoryW " + path_utf8(path));
}

bool equivalent(const std::string &a, const std::string &b) {
  std::error_code error;
  const bool same = fs::equivalent(rs::fs_path(a), rs::fs_path(b), error);
  if (error) std::printf("equivalent %s / %s: %s (error %d)\n", a.c_str(), b.c_str(),
                         error.message().c_str(), error.value());
  return same && !error;
}

// Reject accidental ambient copies before proving that only DLL_LOAD_DIR finds the dependency.
void require_isolated_dependency(const fs::path &dependency, const ProcessState &state) {
  const auto name = path_utf8(dependency.filename());
  if (rs::library_loaded(name)) throw std::runtime_error("dependency already loaded: " + name);
  std::set<fs::path> directories{state.cwd, rs::fs_path(rs::executable_path()).parent_path()};
  wchar_t system[MAX_PATH], windows[MAX_PATH];
  const UINT sn = ::GetSystemDirectoryW(system, MAX_PATH);
  win_check(sn > 0 && sn < MAX_PATH, "GetSystemDirectoryW");
  const UINT wn = ::GetWindowsDirectoryW(windows, MAX_PATH);
  win_check(wn > 0 && wn < MAX_PATH, "GetWindowsDirectoryW");
  directories.insert(fs::path(system));
  directories.insert(fs::path(windows));
  directories.insert(fs::path(windows) / L"System");
  std::size_t start = 0;
  do {
    const auto end = state.path.find(L';', start);
    auto part = state.path.substr(start, end == std::wstring::npos ? end : end - start);
    if (part.size() >= 2 && part.front() == L'"' && part.back() == L'"')
      part = part.substr(1, part.size() - 2);
    directories.insert(part.empty() ? state.cwd : fs::path(part));
    if (end == std::wstring::npos) break;
    start = end + 1;
  } while (true);
  for (const auto &directory : directories) {
    const auto candidate = directory / dependency.filename();
    std::error_code error;
    const bool present = fs::exists(candidate, error);
    // PATH can contain stale entries; those cannot supply this dependency.
    if (error && error != std::errc::no_such_file_or_directory && error != std::errc::not_a_directory)
      throw fs::filesystem_error("check dependency isolation", candidate, error);
    if (present) throw std::runtime_error("ambient dependency copy: " + path_utf8(candidate));
  }
  std::printf("info dependency isolated: %s; absent from loaded modules, app/cwd/system/PATH (%zu dirs)\n",
              path_utf8(dependency).c_str(), directories.size());
}
}  // namespace

int main(int argc, char **argv) {
  std::set<std::string> expected, failed;
  if (argc == 5 && std::strcmp(argv[3], "--expect-fail") == 0 &&
      std::strcmp(argv[4], "dll-load-dir,cwd-not-searched") == 0) {
    expected = {"dll-load-dir", "cwd-not-searched"};
  } else if (argc != 3) {
    std::fprintf(stderr, "usage: rs_library_search_test <fixture-dir> <real-dll> "
                         "[--expect-fail dll-load-dir,cwd-not-searched]\n");
    return 2;
  }
  auto check = [&](bool ok, const char *name, const std::string &detail) {
    std::printf("%s %s: %s\n", ok ? "ok  " : "FAIL", name, detail.c_str());
    if (!ok) failed.insert(name);
  };
  std::string temp;
  try {
    ProcessState state;
    const auto dir = fs::absolute(rs::fs_path(argv[1]));
    const auto real = fs::absolute(rs::fs_path(argv[2]));
    const auto module = dir / rs::fs_path(GRC_SEARCH_MODULE_NAME);
    const auto dependency = dir / rs::fs_path(GRC_SEARCH_DEP_NAME);
    if (!fs::is_regular_file(module) || !fs::is_regular_file(dependency) || !fs::is_regular_file(real))
      throw std::runtime_error("missing test inputs: " + path_utf8(module) + ", " +
                               path_utf8(dependency) + ", " + path_utf8(real));
    require_isolated_dependency(dependency, state);
    {
      Module loaded;
      std::string error;
      const auto path = path_utf8(module);
      const auto *table = load_net_module_at(path, &error, &loaded.handle);
      check(table != nullptr, "dll-load-dir", path + " (" + error + ")");
    }
    if (rs::library_loaded(GRC_SEARCH_DEP_NAME))
      throw std::runtime_error("dependency stayed loaded after dll-load-dir: " GRC_SEARCH_DEP_NAME);

    temp = grc::test::temp_directory("rs-library-search");
    const auto root = rs::fs_path(temp);
    const auto a = root / L"A", b = root / L"B";
    fs::create_directory(a);
    fs::create_directory(b);
    fs::copy_file(module, a / module.filename());
    fs::copy_file(dependency, b / dependency.filename());
    {
      Module loaded;
      set_cwd(b);
      const auto path_env = b.native() + L";" + state.path;
      win_check(::SetEnvironmentVariableW(L"PATH", path_env.c_str()), "prepend PATH " + path_utf8(b));
      std::string error;
      const auto path = path_utf8(a / module.filename());
      const auto *table = load_net_module_at(path, &error, &loaded.handle);
      check(table == nullptr && error.starts_with("net-module-missing: ") &&
                error.find("(error 126)") != std::string::npos,
            "cwd-not-searched", path + " cwd/PATH=" + path_utf8(b) + " (" + error + ")");
      state.restore();
    }
    if (rs::library_loaded(GRC_SEARCH_DEP_NAME))
      throw std::runtime_error("dependency stayed loaded after cwd-not-searched: " GRC_SEARCH_DEP_NAME);
    {
      // Isolate full-path conversion from dependency search: this check also passes plain-load.
      Module dep, loaded;
      std::string error;
      dep.handle = rs::library_open(path_utf8(dependency), &error);
      if (!dep.handle) throw std::runtime_error("preload " + path_utf8(dependency) + ": " + error);
      set_cwd(dir.parent_path());
      const auto path = path_utf8(dir.filename() / module.filename());
      const auto *table = load_net_module_at(path, &error, &loaded.handle);
      check(table != nullptr, "relative-path", path + " cwd=" + path_utf8(dir.parent_path()) + " (" + error + ")");
      state.restore();
    }
    {
      const std::string component = "rs-net-é-Ω-日本";
      const bool multibyte = std::any_of(component.begin(), component.end(),
                                         [](unsigned char c) { return c >= 0x80; });
      const auto unicode = root / rs::fs_path(component);
      fs::create_directory(unicode);
      const bool exists = fs::is_directory(unicode);
      std::printf("info non-ascii: utf8-high-bytes=%d directory-exists=%d path=%s\n",
                  multibyte, exists, path_utf8(unicode).c_str());
      if (!multibyte || !exists) throw std::runtime_error("non-ASCII directory precondition failed");
      const auto path = path_utf8(unicode / real.filename());
      fs::copy_file(real, rs::fs_path(path));
      Module loaded;
      std::string error;
      const auto *table = load_net_module_at(path, &error, &loaded.handle);
      const auto *tls = table ? grc::live::net_tls_table(loaded.handle, path, &error) : nullptr;
      void *entry = loaded.handle ? rs::library_symbol(loaded.handle, GRC_NET_MODULE_ENTRY) : nullptr;
      const DWORD symbol_error = entry ? ERROR_SUCCESS : ::GetLastError();
      const auto found = entry ? rs::module_path_of(entry) : std::string();
      const DWORD path_error = found.empty() ? ::GetLastError() : ERROR_SUCCESS;
      check(table && tls && entry && equivalent(found, path) &&
                found.ends_with("/" + component + "/" + path_utf8(real.filename())),
            "non-ascii", path + " module_path_of=" + found + " symbol error=" +
                std::to_string(symbol_error) + " path error=" + std::to_string(path_error) + " (" + error + ")");
    }
    {
      std::string error;
      const auto path = temp + "/missing/render_stream_net.dll";
      const auto *table = load_net_module_at(path, &error);
      check(table == nullptr && error.find("LoadLibraryExW:") != std::string::npos &&
                error.find("(error 126)") != std::string::npos,
            "missing-text", path + " (" + error + ")");
    }
    state.restore();
    if (!grc::test::remove_tree(temp)) throw std::runtime_error("remove temp directory " + temp);
  } catch (const std::exception &error) {
    std::fprintf(stderr, "FAIL setup/cleanup: %s\n", error.what());
    if (!temp.empty()) grc::test::remove_tree(temp);
    return 1;
  }
  std::printf("rs_library_search_test: %zu/5 passed, %zu expected failures\n", 5 - failed.size(), expected.size());
  if (failed != expected) {
    std::fprintf(stderr, "FAIL observed failures do not match --expect-fail; observed:");
    for (const auto &name : failed) std::fprintf(stderr, " %s", name.c_str());
    std::fprintf(stderr, "\n");
    return 1;
  }
  return 0;
}
