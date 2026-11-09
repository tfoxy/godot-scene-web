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
  cmake_parse_arguments(PARSE_ARGV 1 W "" "TARGET" "SOURCES;LIBS;DEFINES;ARGS;ENV;INCLUDES")
  if(W_UNPARSED_ARGUMENTS OR W_KEYWORDS_MISSING_VALUES OR NOT W_TARGET)
    message(FATAL_ERROR "Invalid grc_w_test arguments for ${name}")
  endif()
  if(NOT TARGET ${W_TARGET})
    add_executable(${W_TARGET} ${W_SOURCES})
    target_link_libraries(${W_TARGET} PRIVATE grc_warnings grc_static_runtime ${W_LIBS})
    target_include_directories(${W_TARGET} PRIVATE src ${W_INCLUDES})
    target_compile_definitions(${W_TARGET} PRIVATE ${W_DEFINES})
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
endfunction()

grc_w_test(abi_decode TARGET abi_decode_test SOURCES test/abi_decode.cpp)
grc_w_test(rs_mirror TARGET rs_mirror_test
  SOURCES test/rs_mirror_test.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp src/rs_shader_payload.cpp
    src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_diff.cpp src/rs2_codec.cpp
  LIBS grc_codecs Threads::Threads)
grc_w_test(rs_mirror_shadow TARGET rs_mirror_test ENV RS_MIRROR_TEST_SHADOW=1)

grc_w_test(rs2_codec TARGET rs2_codec_test SOURCES test/rs2_codec_test.cpp src/rs2_codec.cpp
  INCLUDES test DEFINES GRC_GOLDEN2_DIR="protocol/golden-2")
grc_w_test(rs2_diff TARGET rs2_diff_test
  SOURCES test/rs2_diff_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
  INCLUDES test DEFINES GRC_GOLDEN2_DIR="protocol/golden-2")
foreach(version RANGE 3 13)
  set(sources test/rs${version}_codec_test.cpp src/rs2_codec.cpp)
  if(NOT version EQUAL 7)
    list(APPEND sources src/rs2_diff.cpp)
  endif()
  set(defines GRC_GOLDEN${version}_DIR="protocol/golden-${version}")
  if(version GREATER_EQUAL 11)
    list(APPEND defines GRC_GOLDEN6_DIR="protocol/golden-6" GRC_GOLDEN10_DIR="protocol/golden-10")
    foreach(prior RANGE 11 ${version})
      list(APPEND defines GRC_GOLDEN${prior}_DIR="protocol/golden-${prior}")
    endforeach()
    list(REMOVE_DUPLICATES defines)
  endif()
  set(libs "")
  if(version EQUAL 13)
    list(APPEND sources src/rs13_predict.cpp)
    list(APPEND libs grc_codecs)
  endif()
  grc_w_test(rs${version}_codec TARGET rs${version}_codec_test SOURCES ${sources}
    INCLUDES test DEFINES ${defines})
  if(libs)
    target_link_libraries(rs${version}_codec_test PRIVATE ${libs})
  endif()
endforeach()
# Clang diagnoses the unused is_word_stream helper; put its suppression after -Wall.
target_compile_options(rs13_codec_test PRIVATE -Wall -Wextra -Werror -Wno-unused-function)

grc_w_test(rs_gate8_policy TARGET rs_gate8_policy_test
  SOURCES test/rs_gate8_policy_test.cpp src/rs_gate8_policy.cpp
    src/rs_texture_decode.cpp src/rs_texture_delivery.cpp src/iface.cpp
  INCLUDES vendor)
grc_w_test(rs_item_meta TARGET rs_item_meta_test
  SOURCES test/rs_item_meta_test.cpp test/rs_item_meta_host_test.cpp
    src/rs_item_meta.cpp src/rs_item_meta_host.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp
    src/rs_shader_payload.cpp src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp
    src/rs2_diff.cpp src/rs2_codec.cpp
  LIBS grc_codecs)
grc_w_test(rs_texture_decode TARGET rs_texture_decode_test
  SOURCES test/rs_texture_decode_test.cpp src/rs_texture_decode.cpp src/iface.cpp INCLUDES vendor)
grc_w_test(rs_sha256 TARGET rs_sha256_test SOURCES test/rs_sha256_test.cpp src/rs_sha256.cpp)
grc_w_test(rs_rid_map TARGET rs_rid_map_test SOURCES test/rs_rid_map_test.cpp)
grc_w_test(rs_texture_payload TARGET rs_texture_payload_test
  SOURCES test/rs_texture_payload_test.cpp src/rs_texture_payload.cpp src/rs_sha256.cpp
  DEFINES GRC_GOLDEN2_DIR="protocol/golden-2")
grc_w_test(rs_mesh_payload TARGET rs_mesh_payload_test
  SOURCES test/rs_mesh_payload_test.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp)
grc_w_test(rs_shader_payload TARGET rs_shader_payload_test
  SOURCES test/rs_shader_payload_test.cpp src/rs_shader_payload.cpp src/rs_sha256.cpp)
grc_w_test(rs_resource_log TARGET rs_resource_log_test
  SOURCES test/rs_resource_log_test.cpp src/rs_resource_log.cpp src/rs_texture_payload.cpp
    src/rs_mesh_payload.cpp src/rs_sha256.cpp LIBS Threads::Threads)
grc_w_test(rs_variant TARGET rs_variant_test
  SOURCES test/rs_variant_test.cpp src/rs_variant.cpp src/iface.cpp INCLUDES vendor)
grc_w_test(rs_live_coding TARGET rs_live_coding_test
  SOURCES test/rs_live_coding_test.cpp LIBS grc_codecs)
grc_w_test(rs_particles_shim TARGET rs_particles_shim_test
  SOURCES test/rs_particles_shim_test.cpp src/rs_particles_shim.cpp LIBS Threads::Threads)
grc_w_test(rs_capture_api TARGET rs_capture_api_test
  SOURCES test/rs_capture_api_test.cpp src/rs_capture_api.cpp LIBS grc_platform Threads::Threads)

# Excluded until the capture library is ported:
# rs_publish, rs_ws, rs_carrier_set, rs_track, rs_carrier_ext, rs_net_module,
# rs_live(_thread), rs_live_window(_thread), rs_ws_echo, rs_live_host: POSIX sockets, getrandom, dl*.
# rs_expose: POSIX inet_pton headers. rs_texture_worker: setpriority.
# rs_histogram, rs_registry, rs_canvas_texture_shim, rs_adopt: report.cpp's mkdir(path, 0775).
# rs_texture_cache: getpid. rs_setting: setenv.
# rs_vtable: GCC anti-devirtualization flags. rs_standby: reads a source path.
# rs_texture_release: wall-clock assertion on a shared VM.
# rs_basis_*: basisu, bash + godot. rs_live_coding_golden*: sh -c + cmp.

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
