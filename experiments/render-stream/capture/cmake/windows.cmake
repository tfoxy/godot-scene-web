set(GRC_WINDOWS_SCOPE tests CACHE STRING "Windows build scope")
set_property(CACHE GRC_WINDOWS_SCOPE PROPERTY STRINGS tests)
if(NOT GRC_WINDOWS_SCOPE STREQUAL "tests")
  message(FATAL_ERROR "GRC_WINDOWS_SCOPE=${GRC_WINDOWS_SCOPE}: only 'tests' builds for Windows; the capture library is not ported yet")
endif()

include(CheckCXXSourceCompiles)
check_cxx_source_compiles("#include <cstddef>
#if !defined(__MINGW64__) || !defined(__clang__) || defined(_MSC_VER) || !defined(_LIBCPP_VERSION)
#error not llvm-mingw
#endif
int main() { return 0; }" GRC_IS_LLVM_MINGW)
if(NOT GRC_IS_LLVM_MINGW)
  message(FATAL_ERROR "render_stream_capture: not llvm-mingw")
endif()

# The pinned libc++ uses Win32 threads and needs no winpthread library.
add_library(Threads::Threads INTERFACE IMPORTED)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
add_library(grc_static_runtime INTERFACE)
target_link_options(grc_static_runtime INTERFACE -static)

# Quote manifest strings independently of CMake's list syntax.
function(grc_w_quote out value)
  string(REPLACE "\\" "\\\\" value "${value}")
  string(REPLACE "\"" "\\\"" value "${value}")
  string(REPLACE "\n" "\\n" value "${value}")
  string(REPLACE "\r" "\\r" value "${value}")
  string(REPLACE "\t" "\\t" value "${value}")
  set(${out} "\"${value}\"" PARENT_SCOPE)
endfunction()

function(grc_w_test name)
  cmake_parse_arguments(PARSE_ARGV 1 W "" "TARGET" "SOURCES;LIBS;DEFINES;ARGS;ENV;INCLUDES;OPTIONS")
  if(W_UNPARSED_ARGUMENTS OR W_KEYWORDS_MISSING_VALUES OR NOT W_TARGET)
    message(FATAL_ERROR "Invalid grc_w_test arguments for ${name}")
  endif()
  if(NOT TARGET ${W_TARGET})
    add_executable(${W_TARGET} ${W_SOURCES})
    target_link_libraries(${W_TARGET} PRIVATE grc_warnings grc_static_runtime ${W_LIBS})
    target_include_directories(${W_TARGET} PRIVATE src ${W_INCLUDES})
    target_compile_definitions(${W_TARGET} PRIVATE ${W_DEFINES})
    target_compile_options(${W_TARGET} PRIVATE ${W_OPTIONS})
  endif()
  foreach(define IN LISTS W_DEFINES)
    if(define MATCHES "^GRC_GOLDEN[0-9]+_DIR=\"([^\"]+)\"$")
      set_property(GLOBAL APPEND PROPERTY GRC_W_DATA "${CMAKE_MATCH_1}")
    endif()
  endforeach()
  set(args "[]")
  foreach(arg IN LISTS W_ARGS)
    string(JSON n LENGTH "${args}")
    grc_w_quote(value "${arg}")
    string(JSON args SET "${args}" ${n} "${value}")
  endforeach()
  set(env "{}")
  foreach(pair IN LISTS W_ENV)
    if(NOT pair MATCHES "^([^=]+)=(.*)$")
      message(FATAL_ERROR "Invalid environment entry: ${pair}")
    endif()
    set(key "${CMAKE_MATCH_1}")
    grc_w_quote(value "${CMAKE_MATCH_2}")
    string(JSON env SET "${env}" "${key}" "${value}")
  endforeach()
  grc_w_quote(name_json "${name}")
  set_property(GLOBAL APPEND PROPERTY GRC_W_TESTS
    "{\"name\":${name_json},\"exe\":\"bin/$<TARGET_FILE_NAME:${W_TARGET}>\",\"args\":${args},\"env\":${env}}")
  if(name STREQUAL "calib_pe_self")
    # The bundle builder makes this copy after stripping, so identity is measured on shipped bytes.
    set_property(GLOBAL APPEND PROPERTY GRC_W_TESTS
      "{\"name\":\"calib_pe_rdata_sabotage\",\"exe\":\"bin/calib_pe_self_test-rdata-sabotage.exe\",\"args\":[\"calib_pe_self_test.identity.json\",\"--expect-image-mismatch\"],\"env\":{}}")
  endif()
endfunction()

include(${CMAKE_CURRENT_LIST_DIR}/windows-tests.cmake)
target_link_options(calib_pe_self_test PRIVATE -Wl,--build-id)

add_library(grc_platform STATIC src/rs_platform_win32.cpp)
target_include_directories(grc_platform PUBLIC src)
target_compile_definitions(grc_platform PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 PSAPI_VERSION=2)
target_link_libraries(grc_platform PRIVATE grc_warnings PUBLIC ws2_32 bcrypt advapi32)
include(${CMAKE_CURRENT_LIST_DIR}/platform-tests.cmake)

# Keep this target on the toolchain's dynamic default so the imports gate proves it rejects libc++.
add_executable(w_imports_sabotage_dynamic test/abi_convention_probe.cpp)
target_include_directories(w_imports_sabotage_dynamic PRIVATE src)
target_link_libraries(w_imports_sabotage_dynamic PRIVATE grc_warnings)
set_target_properties(w_imports_sabotage_dynamic PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/sabotage)

get_property(tests GLOBAL PROPERTY GRC_W_TESTS)
list(JOIN tests ",\n" tests_json)
get_property(data GLOBAL PROPERTY GRC_W_DATA)
list(REMOVE_DUPLICATES data)
set(data_json "[]")
foreach(path IN LISTS data)
  string(JSON n LENGTH "${data_json}")
  grc_w_quote(value "${path}")
  string(JSON data_json SET "${data_json}" ${n} "${value}")
endforeach()
file(GENERATE OUTPUT ${CMAKE_BINARY_DIR}/w-capture-manifest.json CONTENT
  "{\"schema\":\"render-stream-w-manifest/1\",\"tests\":[${tests_json}],\"imports_only\":[],\"sabotage\":[{\"exe\":\"sabotage/$<TARGET_FILE_NAME:w_imports_sabotage_dynamic>\",\"expect_disallowed\":[\"libc++.dll\"]}],\"data\":${data_json}}\n")

# Build the net module and Cargo test harnesses before the shell runner assembles the bundle.
# Start from the generated capture template on every build so entries cannot accumulate.
add_custom_target(rs_net ALL
  COMMAND bash ${CMAKE_CURRENT_LIST_DIR}/../../scripts/build-rs-net.sh --target windows
    --manifest-template ${CMAKE_BINARY_DIR}/w-capture-manifest.json
  VERBATIM)

# Compile the capture's complete source list against the Windows ABI without linking a DLL.
# The WebSocket source is ported independently; keep every other source in this probe.
include(${CMAKE_CURRENT_LIST_DIR}/capture-deps.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/capture-sources.cmake)
list(REMOVE_ITEM GRC_CAPTURE_SOURCES
  src/rs_platform_posix.cpp src/calib_fingerprint_posix.cpp src/rs_ws.cpp)
list(APPEND GRC_CAPTURE_SOURCES
  src/rs_platform_win32.cpp src/calib_fingerprint_win32.cpp src/pe_image.cpp)
add_library(grc_capture_windows_probe OBJECT ${GRC_CAPTURE_SOURCES})
# Match the Clang control build's exception for the unused predictor helper.
set_property(SOURCE src/rs13_predict.cpp APPEND PROPERTY COMPILE_OPTIONS -Wno-unused-function)
target_include_directories(grc_capture_windows_probe PRIVATE src vendor ${GRC_INJECT_GEN})
# The fingerprint source also defines these header switches with empty replacement text.
target_compile_definitions(grc_capture_windows_probe PRIVATE
  render_stream_capture_EXPORTS WIN32_LEAN_AND_MEAN= NOMINMAX= _WIN32_WINNT=0x0A00 PSAPI_VERSION=2)
target_compile_options(grc_capture_windows_probe PRIVATE -fno-omit-frame-pointer)
target_link_libraries(grc_capture_windows_probe PRIVATE
  grc_warnings grc_codecs grc_basisu grc_platform Threads::Threads)
set_target_properties(grc_capture_windows_probe PROPERTIES
  POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
add_dependencies(grc_capture_windows_probe grc_inject_script)
