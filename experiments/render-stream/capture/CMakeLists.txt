cmake_minimum_required(VERSION 3.22)
project(render_stream_capture LANGUAGES C CXX)

# A RenderingServer capture
# seam for an unmodified official Godot x86-64 template, using the vendored
# GDExtension C interface and the platform C/C++ runtime.

if(MSVC OR CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC" OR CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
  message(FATAL_ERROR "render_stream_capture: the MSVC C++ ABI (cl.exe, clang-cl) is not supported; build for Windows with cmake/llvm-mingw-x86_64.cmake")
endif()
set(GRC_WINDOWS OFF)
if(CMAKE_SYSTEM_NAME STREQUAL "Windows" AND MINGW AND CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  set(GRC_WINDOWS ON)
elseif(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "render_stream_capture builds for Linux x86-64, or Windows x86-64 with llvm-mingw (cmake/llvm-mingw-x86_64.cmake); got ${CMAKE_SYSTEM_NAME} ${CMAKE_CXX_COMPILER_ID}")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "render_stream_capture is 64-bit only")
endif()
if(NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
  message(FATAL_ERROR "render_stream_capture is x86-64 only (got ${CMAKE_SYSTEM_PROCESSOR})")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()
# GRT: path-independent bytes (debug info, __FILE__), so the same sources build the same library in
# every worktree and gate 7's input-keyed source cache (scripts/lib/source-key.ts, which keys on
# this library's sha256) can reuse a source made in another worktree.
get_filename_component(GRC_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
add_compile_options("-ffile-prefix-map=${GRC_REPO_ROOT}/=")

add_library(grc_warnings INTERFACE)
target_compile_options(grc_warnings INTERFACE -Wall -Wextra -Werror)

# G8kz: HTTP content coding (render-stream-2.md "HTTP (live)"). zstd 1.5.7 and zlib 1.3.1, the
# copies Godot 4.5.1 vendors (vendor/PROVENANCE.md), built as one hidden-visibility static library
# so the host engine's own copies are never interposed.
file(GLOB GRC_ZSTD_SOURCES CONFIGURE_DEPENDS
  vendor/zstd/common/*.c vendor/zstd/compress/*.c vendor/zstd/decompress/*.c)
add_library(grc_codecs STATIC
  ${GRC_ZSTD_SOURCES}
  vendor/zlib/adler32.c vendor/zlib/crc32.c vendor/zlib/deflate.c vendor/zlib/inffast.c
  vendor/zlib/inflate.c vendor/zlib/inftrees.c vendor/zlib/trees.c vendor/zlib/zutil.c
  src/rs_http_coding.cpp src/rs_live_coding.cpp src/rs_payload_rest.cpp)
target_include_directories(grc_codecs PUBLIC vendor/zstd vendor/zlib src)
target_compile_definitions(grc_codecs PRIVATE ZSTD_DISABLE_ASM=1 ZSTD_LEGACY_SUPPORT=0)
target_compile_options(grc_codecs PRIVATE -w -O2)
set_source_files_properties(src/rs_http_coding.cpp src/rs_live_coding.cpp src/rs_payload_rest.cpp PROPERTIES
  COMPILE_OPTIONS "-Wall;-Wextra;-Werror")
set_target_properties(grc_codecs PROPERTIES
  POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)

# Platform setup; all targets below share their declarations across operating systems.
if(GRC_WINDOWS)
  include(cmake/windows.cmake)
endif()
include(cmake/tests.cmake)
if(GRC_LINUX_LIBCXX)
  include(cmake/linux-libcxx.cmake)
endif()
include(cmake/platform-tests.cmake)

if(GRC_WINDOWS)
  set(GRC_FINGERPRINT_SOURCES src/calib_fingerprint_win32.cpp src/pe_image.cpp)
  set(GRC_DATA_PREFIX "")
else()
  set(GRC_FINGERPRINT_SOURCES src/calib_fingerprint_posix.cpp)
  set(GRC_DATA_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/../")
endif()
include(cmake/capture-deps.cmake)

# Linux-only: Python PE fixture generation runs on the build host.
if(NOT GRC_WINDOWS)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_executable(pe_image_test test/pe_image_test.cpp src/pe_image.cpp src/rs_sha256.cpp)
target_include_directories(pe_image_test PRIVATE src)
target_link_libraries(pe_image_test PRIVATE grc_warnings grc_platform)
grc_add_test(NAME pe_image_test COMMAND ${Python3_EXECUTABLE} -I
  ${CMAKE_CURRENT_SOURCE_DIR}/test/pe_image_test.py $<TARGET_FILE:pe_image_test>
  ${CMAKE_CURRENT_SOURCE_DIR}/tools)

add_executable(calib_pe_checks_test test/calib_pe_checks_test.cpp src/pe_image.cpp src/calib.cpp
  ${GRC_FINGERPRINT_SOURCES} src/iface.cpp src/rs_sha256.cpp)
target_include_directories(calib_pe_checks_test PRIVATE src vendor)
target_link_libraries(calib_pe_checks_test PRIVATE grc_warnings grc_platform)
grc_add_test(NAME calib_pe_checks COMMAND ${Python3_EXECUTABLE} -I
  ${CMAKE_CURRENT_SOURCE_DIR}/test/calib_pe_checks_test.py $<TARGET_FILE:calib_pe_checks_test>
  ${CMAKE_CURRENT_SOURCE_DIR}/tools)

else()
  grc_linux_only("pe_image_test;calib_pe_checks_test" "Python PE fixture generation runs on the build host.")
endif()

file(GLOB GRC_CALIBRATION_RECORDS "${CMAKE_CURRENT_SOURCE_DIR}/../calibration/*.json")
add_executable(calib_slot_mask_test test/calib_slot_mask_test.cpp src/calib.cpp
  ${GRC_FINGERPRINT_SOURCES} src/iface.cpp src/rs_sha256.cpp)
target_include_directories(calib_slot_mask_test PRIVATE src vendor)
target_link_libraries(calib_slot_mask_test PRIVATE grc_warnings grc_platform)
if(GRC_WINDOWS)
  grc_add_test(NAME calib_slot_mask COMMAND calib_slot_mask_test)
else()
  grc_add_test(NAME calib_slot_mask COMMAND calib_slot_mask_test ${GRC_CALIBRATION_RECORDS})
endif()

# Linux-only: ELF/proc fault injection uses Linux link wrapping.
if(NOT GRC_WINDOWS)
# Engine-free checks for process identity collection and calibration refusals.
add_executable(calib_fingerprint_test test/calib_fingerprint_test.cpp src/calib.cpp
  ${GRC_FINGERPRINT_SOURCES} src/iface.cpp src/rs_sha256.cpp)
target_include_directories(calib_fingerprint_test PRIVATE src vendor)
target_link_libraries(calib_fingerprint_test PRIVATE grc_warnings grc_platform)
target_link_options(calib_fingerprint_test PRIVATE
  -Wl,--wrap=readlink -Wl,--wrap=dl_iterate_phdr -Wl,--wrap=fopen)
grc_add_test(NAME calib_fingerprint COMMAND calib_fingerprint_test)

else()
  grc_linux_only("calib_fingerprint_test" "ELF/proc fault injection uses Linux link wrapping.")
endif()

include(cmake/capture-sources.cmake)
if(GRC_WINDOWS)
  list(REMOVE_ITEM GRC_CAPTURE_SOURCES src/rs_platform_posix.cpp src/calib_fingerprint_posix.cpp)
  list(APPEND GRC_CAPTURE_SOURCES src/rs_platform_win32.cpp ${GRC_FINGERPRINT_SOURCES})
endif()
add_library(render_stream_capture SHARED ${GRC_CAPTURE_SOURCES})
target_include_directories(render_stream_capture PRIVATE src vendor ${GRC_INJECT_GEN})
add_dependencies(render_stream_capture grc_inject_script)
target_link_libraries(render_stream_capture PRIVATE grc_warnings grc_codecs grc_basisu grc_platform)
set_target_properties(render_stream_capture PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON
  PREFIX "lib"
)
# The hooks are reached only through the shadow vtable, and the engine owns the
# frame pointer discipline on the calling side; keep frame pointers so a crash
# inside a hook has a readable stack.
target_compile_options(render_stream_capture PRIVATE -fno-omit-frame-pointer)
if(GRC_WINDOWS)
  set_target_properties(render_stream_capture PROPERTIES PREFIX "")
  target_link_libraries(render_stream_capture PRIVATE grc_static_runtime)
  target_compile_definitions(render_stream_capture PRIVATE
    WIN32_LEAN_AND_MEAN= NOMINMAX= _WIN32_WINNT=0x0A00 PSAPI_VERSION=2)
endif()
find_package(Threads REQUIRED)
target_link_libraries(render_stream_capture PRIVATE Threads::Threads)
# dlopen of the net module, only when GRC_LIVE_CARRIERS lists wt.
target_link_libraries(render_stream_capture PRIVATE ${CMAKE_DL_LIBS})

# Fixtures load this descriptor by absolute path; Windows also relocates it with the bundle.
if(GRC_WINDOWS)
  set(GRC_LIBRARY_OS windows)
  set(GRC_LIBRARY_PATH "bin/$<TARGET_FILE_NAME:render_stream_capture>")
  set(GRC_LIBRARY_PATH_DESCRIPTION "a relative library path")
else()
  set(GRC_LIBRARY_OS linux)
  set(GRC_LIBRARY_PATH "$<TARGET_FILE:render_stream_capture>")
  set(GRC_LIBRARY_PATH_DESCRIPTION "the absolute library path")
endif()
configure_file(render_stream_capture.gdextension.in render_stream_capture.gdextension.gen @ONLY)
file(GENERATE
  OUTPUT "${CMAKE_BINARY_DIR}/render_stream_capture.gdextension"
  INPUT "${CMAKE_CURRENT_BINARY_DIR}/render_stream_capture.gdextension.gen"
)

# Loading the capture without an engine must only resolve its entry points, with no live work.
add_executable(rs_capture_load_test test/rs_capture_load_test.cpp)
target_link_libraries(rs_capture_load_test PRIVATE grc_warnings grc_platform)
add_dependencies(rs_capture_load_test render_stream_capture)
grc_add_test(NAME rs_capture_load COMMAND rs_capture_load_test)
if(GRC_WINDOWS)
  # Probe Winsock directly: the test must not initialize it through the platform layer.
  target_link_libraries(rs_capture_load_test PRIVATE ws2_32)
  grc_add_test(NAME rs_capture_load_wsastartup_sabotage COMMAND rs_capture_load_test
    --sabotage-wsastartup --expect-fail winsock-uninitialized)
endif()

enable_testing()
add_executable(abi_decode_test test/abi_decode.cpp)
target_include_directories(abi_decode_test PRIVATE src)
target_link_libraries(abi_decode_test PRIVATE grc_warnings)
grc_add_test(NAME abi_decode COMMAND abi_decode_test)

# Gate 0 (WP1) / gate 1 (G1b2) / gate 2 (G2b2) / gate 3 (G3a): the retained canvas mirror, driven
# through its public API with no engine, including draw-index ties, root geometry, the omit-op
# sabotage, the texture table (ids, versions, tombstones, replace, derived unsupported entries)
# and the clip reset of canvas_item_clear (diffed against the previous snapshot).
add_executable(rs_mirror_test test/rs_mirror_test.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp src/rs_shader_payload.cpp
  src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_diff.cpp src/rs2_codec.cpp)
target_include_directories(rs_mirror_test PRIVATE src)
target_link_libraries(rs_mirror_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_mirror COMMAND rs_mirror_test)
# HC4a: the same cases with the shadow oracle on (every snapshot compared with the full walk).
grc_add_test(NAME rs_mirror_shadow COMMAND rs_mirror_test)
set_tests_properties(rs_mirror_shadow PROPERTIES ENVIRONMENT "RS_MIRROR_TEST_SHADOW=1")

# Gate 1 (G1b2) / gate 2 (G2b2): the render-stream/2 publisher -- full and patch sinks from one
# snapshot per frame, patch/full equivalence, sabotages, per-sink stats, the store directory and
# inline resource records -- against memory sinks, fed by a real mirror.
# Linux-only: Not in the established Windows bundle; file tests remain a follow-up.
if(NOT GRC_WINDOWS)
add_executable(rs_publish_test
  test/rs_publish_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_publish.cpp
  src/rs_item_meta.cpp
  src/rs13_predict.cpp
  src/rs_mirror.cpp
  src/rs_texture_delivery.cpp
  src/rs_shader_payload.cpp
  src/rs_resource_store.cpp
  src/rs_texture_payload.cpp
  src/rs_mesh_payload.cpp
  src/rs_sha256.cpp
  src/report.cpp
)
target_include_directories(rs_publish_test PRIVATE src test)
target_link_libraries(rs_publish_test PRIVATE grc_warnings grc_codecs grc_platform Threads::Threads)
target_compile_definitions(rs_publish_test PRIVATE
  GRC_GOLDEN2_DIR="${GRC_DATA_PREFIX}protocol/golden-2"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_publish_test_tmp")
grc_add_test(NAME rs_publish COMMAND rs_publish_test)

else()
  grc_linux_only("rs_publish_test" "Not in the established Windows bundle; file tests remain a follow-up.")
endif()

# rs_ws, a dependency-free RFC 6455 server on its own I/O thread
# Pure transport: no mirror, no engine.
# Linked into render_stream_capture since G1c2 (GRC_LIVE_LISTEN, src/rs1_live.*).
# rs_ws_test's wss cases drive the real net module's TLS session
# (librender_stream_net.so beside the test, from build-rs-net.sh) with an OpenSSL client and a
# certificate generated at test time. OpenSSL is a test-only dependency (the capture never links
# it); without it, or without the module, those cases print `skip` (scripts/test/self-test-wss.ts
# runs them with --require-tls).
add_executable(rs_ws_test test/rs_ws_test.cpp src/rs_ws.cpp src/rs_sha1.cpp src/rs_net_module.cpp
  src/rs_carrier_set.cpp)
target_include_directories(rs_ws_test PRIVATE src)
target_link_libraries(rs_ws_test PRIVATE grc_warnings grc_codecs Threads::Threads ${CMAKE_DL_LIBS})
if(NOT GRC_WINDOWS)
find_package(OpenSSL QUIET)
if(OPENSSL_FOUND)
  target_compile_definitions(rs_ws_test PRIVATE GRC_TEST_OPENSSL=1)
  target_link_libraries(rs_ws_test PRIVATE OpenSSL::SSL OpenSSL::Crypto)
endif()
endif()
grc_add_test(NAME rs_ws COMMAND rs_ws_test)

# the CarrierSet and the grc_carrier_v1 adapter with two
# fake C ABI carriers and the real rs_ws server as `ws`; also runs the test-only sabotages
# (route-by-local, per-carrier admission), which must fail their checks.
add_executable(rs_carrier_set_test test/rs_carrier_set_test.cpp src/rs_carrier_set.cpp src/rs_ws.cpp
  src/rs_sha1.cpp)
target_include_directories(rs_carrier_set_test PRIVATE src)
target_link_libraries(rs_carrier_set_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_carrier_set COMMAND rs_carrier_set_test)

add_executable(rs_ws_platform_test test/rs_ws_platform_test.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_platform_test PRIVATE src)
target_link_libraries(rs_ws_platform_test PRIVATE grc_warnings grc_platform grc_codecs Threads::Threads)
grc_add_test(NAME rs_ws_platform COMMAND rs_ws_platform_test)
if(GRC_WINDOWS)
  grc_add_test(NAME rs_ws_platform_reuseaddr_sabotage
    COMMAND rs_ws_platform_test --expect-fail port-steal)
  set_tests_properties(rs_ws_platform_reuseaddr_sabotage PROPERTIES ENVIRONMENT GRC_PLATFORM_FAULT=reuseaddr)
  grc_add_test(NAME rs_ws_platform_no_wake_sabotage
    COMMAND rs_ws_platform_test --expect-fail wake-latency)
  set_tests_properties(rs_ws_platform_no_wake_sabotage PROPERTIES ENVIRONMENT GRC_PLATFORM_FAULT=no-wake)
endif()

# TrackHub over a recording fake transport -- the hello grammar,
# every check in its order, every close reason, pairing, keepalive and idle, rate, UTF-8,
# close_all -- plus the four test-only sabotages, each of which must fail its check.
# Linux-only: POSIX socket helpers and source-tree golden data.
if(NOT GRC_WINDOWS)
add_executable(rs_track_test test/rs_track_test.cpp src/rs_tracks.cpp src/rs_track_caps.cpp src/rs_ws.cpp
  src/rs_sha1.cpp src/rs_sha256.cpp src/report.cpp)
target_include_directories(rs_track_test PRIVATE src)
# TRK5: the capability golden vectors, shared with scripts/test/self-test-track-caps.ts.
target_compile_definitions(rs_track_test PRIVATE
  GRC_TRACK_CAP_VECTORS="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/track-cap-vectors.json")
target_link_libraries(rs_track_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_track COMMAND rs_track_test)

else()
  grc_linux_only("rs_track_test" "POSIX socket helpers and source-tree golden data.")
endif()

# the consumer-carrier registry's rules, the owner
# ledger's double-release fault, and grc_carrier_register as the built capture library exports it
# (dlopen as Godot does, then RTLD_NOLOAD + dlsym).
# Linux-only: Uses dlopen and RTLD_NOLOAD.
if(NOT GRC_WINDOWS)
add_executable(rs_carrier_ext_test test/rs_carrier_ext_test.cpp src/rs_carrier_ext.cpp
  src/rs_carrier_set.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_carrier_ext_test PRIVATE src)
target_link_libraries(rs_carrier_ext_test PRIVATE grc_warnings grc_codecs Threads::Threads ${CMAKE_DL_LIBS})
add_dependencies(rs_carrier_ext_test render_stream_capture)
grc_add_test(NAME rs_carrier_ext COMMAND rs_carrier_ext_test $<TARGET_FILE:render_stream_capture>)

else()
  grc_linux_only("rs_carrier_ext_test" "Uses dlopen and RTLD_NOLOAD.")
endif()

# The documented consumer lookup and registration through the capture's exported C ABI.
add_executable(rs_carrier_lookup_test test/rs_carrier_lookup_test.cpp)
target_link_libraries(rs_carrier_lookup_test PRIVATE grc_warnings grc_platform)
add_dependencies(rs_carrier_lookup_test render_stream_capture)
if(GRC_WINDOWS)
  set(GRC_CARRIER_LOOKUP_LIBRARY bin/$<TARGET_FILE_NAME:render_stream_capture>)
else()
  set(GRC_CARRIER_LOOKUP_LIBRARY $<TARGET_FILE:render_stream_capture>)
endif()
grc_add_test(NAME rs_carrier_lookup COMMAND rs_carrier_lookup_test ${GRC_CARRIER_LOOKUP_LIBRARY})

# the LAN exposure policy's refusal matrix.
add_executable(rs_expose_test test/rs_expose_test.cpp src/rs_expose.cpp)
target_include_directories(rs_expose_test PRIVATE src)
target_link_libraries(rs_expose_test PRIVATE grc_warnings)
grc_add_test(NAME rs_expose COMMAND rs_expose_test)

# the net module loader's refusals (net-module-missing,
# net-module-abi) against two fake modules, and -- when scripts/build-rs-net.sh has put the real
# librender_stream_net.so beside the tests -- its table and a wt carrier's start/stop through the
# CarrierSet. The wire itself is the crate's (rs-net/tests) and the interop leg's
# (scripts/test/self-test-wt-interop.ts).
add_library(rs_net_fake_noentry MODULE test/rs_net_fake_module.c)
target_compile_definitions(rs_net_fake_noentry PRIVATE GRC_FAKE_NO_ENTRY=1)
add_library(rs_net_fake_badabi MODULE test/rs_net_fake_module.c)
target_include_directories(rs_net_fake_badabi PRIVATE src)
add_library(rs_net_fake_car3 MODULE test/rs_net_fake_module.c)
target_compile_definitions(rs_net_fake_car3 PRIVATE GRC_FAKE_CAR3=1)
target_include_directories(rs_net_fake_car3 PRIVATE src)
add_executable(rs_net_module_test test/rs_net_module_test.cpp src/rs_net_module.cpp
  src/rs_carrier_set.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_net_module_test PRIVATE src)
target_link_libraries(rs_net_module_test PRIVATE grc_warnings grc_codecs Threads::Threads ${CMAKE_DL_LIBS})
add_dependencies(rs_net_module_test rs_net_fake_noentry rs_net_fake_badabi rs_net_fake_car3)
if(GRC_WINDOWS)
  foreach(fake IN ITEMS rs_net_fake_noentry rs_net_fake_badabi rs_net_fake_car3)
    grc_w_test_file(${fake} test-data/netmod "Net module loader refusal input.")
  endforeach()
  set(GRC_NET_MODULE_TEST_ARGS
    test-data/netmod/$<TARGET_FILE_NAME:rs_net_fake_noentry>
    test-data/netmod/$<TARGET_FILE_NAME:rs_net_fake_badabi>
    test-data/netmod/$<TARGET_FILE_NAME:rs_net_fake_car3> --require-real-module)
else()
  set(GRC_NET_MODULE_TEST_ARGS
    $<TARGET_FILE:rs_net_fake_noentry> $<TARGET_FILE:rs_net_fake_badabi> $<TARGET_FILE:rs_net_fake_car3>)
endif()
grc_add_test(NAME rs_net_module COMMAND rs_net_module_test ${GRC_NET_MODULE_TEST_ARGS})

# Windows-only: PE loader search order.
message(STATUS "Windows-only: rs_library_search_test: PE loader search order.")
if(GRC_WINDOWS)
  add_library(rs_library_search_dep SHARED test/rs_library_search_dep.c)
  add_library(rs_library_search_module MODULE test/rs_library_search_module.c)
  target_include_directories(rs_library_search_module PRIVATE src)
  target_link_libraries(rs_library_search_module PRIVATE rs_library_search_dep)
  grc_w_test_file(rs_library_search_dep test-data/library-search "PE loader dependency input.")
  grc_w_test_file(rs_library_search_module test-data/library-search "PE loader module input.")
  add_executable(rs_library_search_test test/rs_library_search_test.cpp src/rs_net_module.cpp
    src/rs_carrier_set.cpp src/rs_ws.cpp src/rs_sha1.cpp)
  target_include_directories(rs_library_search_test PRIVATE src)
  target_link_libraries(rs_library_search_test PRIVATE grc_warnings grc_codecs Threads::Threads)
  target_compile_definitions(rs_library_search_test PRIVATE
    GRC_SEARCH_MODULE_NAME="$<TARGET_FILE_NAME:rs_library_search_module>"
    GRC_SEARCH_DEP_NAME="$<TARGET_FILE_NAME:rs_library_search_dep>")
  add_dependencies(rs_library_search_test rs_library_search_module)
  grc_add_test(NAME rs_library_search COMMAND rs_library_search_test
    test-data/library-search bin/render_stream_net.dll)
  grc_add_test(NAME rs_library_search_plain_load_sabotage COMMAND rs_library_search_test
    test-data/library-search bin/render_stream_net.dll
    --expect-fail dll-load-dir,cwd-not-searched)
  set_tests_properties(rs_library_search_plain_load_sabotage PROPERTIES ENVIRONMENT GRC_PLATFORM_FAULT=plain-load)
endif()

# Test-only echo server for the Node and Godot interop self-tests
# (scripts/test/self-test-rs-ws.ts, receiver/tests/ws_selftest.gd). Not linked
# into render_stream_capture.
# Linux-only: POSIX interop server helper.
if(NOT GRC_WINDOWS)
add_executable(rs_ws_echo test/rs_ws_echo.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_echo PRIVATE src)
target_link_libraries(rs_ws_echo PRIVATE grc_warnings Threads::Threads)

else()
  grc_linux_only("rs_ws_echo" "POSIX interop server helper.")
endif()

# Gate 1 (G1c2) / gate 2 (G2b2): the live hub -- credit, resync, message-too-large, hello
# timeout, drop-message, finish, the live log and tap, inline resource records per connection,
# (G2c2) the served set: pins, retirement, unpin, drop-resource, wrong-hash, GET attribution,
# and the control-message parser against golden-2/control/ and (G4e2) golden-3/control/ -- driven
# through a fake transport.
# Linux-only: POSIX live-host test helpers.
if(NOT GRC_WINDOWS)
add_executable(rs_live_test
  test/rs_live_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_item_meta.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_test PRIVATE src test)
target_link_libraries(rs_live_test PRIVATE grc_warnings grc_codecs grc_platform Threads::Threads)
target_compile_definitions(rs_live_test PRIVATE
  GRC_GOLDEN2_DIR="${GRC_DATA_PREFIX}protocol/golden-2"
  GRC_GOLDEN3_DIR="${GRC_DATA_PREFIX}protocol/golden-3"
  GRC_GOLDEN4_DIR="${GRC_DATA_PREFIX}protocol/golden-4"
  GRC_GOLDEN7_DIR="${GRC_DATA_PREFIX}protocol/golden-7"
  GRC_GOLDEN9_DIR="${GRC_DATA_PREFIX}protocol/golden-9"
  GRC_GOLDEN10_DIR="${GRC_DATA_PREFIX}protocol/golden-10"
  GRC_GOLDEN11_DIR="${GRC_DATA_PREFIX}protocol/golden-11"
  GRC_GOLDEN12_DIR="${GRC_DATA_PREFIX}protocol/golden-12"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_live_test_tmp")
grc_add_test(NAME rs_live COMMAND rs_live_test)
# HC5: the same tests with every hub's formation jobs on the encode thread.
grc_add_test(NAME rs_live_thread COMMAND rs_live_test --formation=thread)
set_tests_properties(rs_live rs_live_thread PROPERTIES RESOURCE_LOCK rs_live_tmp)

else()
  grc_linux_only("rs_live_test" "POSIX live-host test helpers.")
endif()

# credit window tests: window 1 pinned by
# transcript digests recorded before G7q (test/golden/live-window1-transcripts.txt), and window 2.
# Linux-only: POSIX live-window test helpers.
if(NOT GRC_WINDOWS)
add_executable(rs_live_window_test
  test/rs_live_window_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_item_meta.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_sha256.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_window_test PRIVATE src test)
target_link_libraries(rs_live_window_test PRIVATE grc_warnings grc_codecs grc_platform Threads::Threads)
target_compile_definitions(rs_live_window_test PRIVATE
  GRC_WINDOW1_TRANSCRIPTS="${CMAKE_CURRENT_SOURCE_DIR}/test/golden/live-window1-transcripts.txt"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_live_window_test_tmp")
grc_add_test(NAME rs_live_window COMMAND rs_live_window_test)
grc_add_test(NAME rs_live_window_thread COMMAND rs_live_window_test --formation=thread)
set_tests_properties(rs_live_window rs_live_window_thread PROPERTIES RESOURCE_LOCK rs_live_window_tmp)

else()
  grc_linux_only("rs_live_window_test" "POSIX live-window test helpers.")
endif()

# G7n: test-only live host (rs_ws + the hub around a fixed scene) for the Node interop
# self-test's /6 + /7, hello token, Origin and CORS checks (scripts/test/self-test-rs-ws.ts).
# Not linked into render_stream_capture.
# Linux-only: POSIX interop host helper.
if(NOT GRC_WINDOWS)
add_executable(rs_live_host
  test/rs_live_host.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_item_meta.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
  src/rs_carrier_set.cpp
  src/rs_carrier_ext.cpp
  src/rs_expose.cpp
  src/rs_net_module.cpp
  test/rs_mem_carrier.cpp
  src/rs_tracks.cpp
  src/rs_track_caps.cpp
  src/rs_sha256.cpp
)
target_include_directories(rs_live_host PRIVATE src test)
target_link_libraries(rs_live_host PRIVATE grc_warnings grc_codecs grc_platform Threads::Threads ${CMAKE_DL_LIBS})
# CAR6: export grc_carrier_register from the executable, so the host registers its in-memory
# carriers through dlsym(RTLD_DEFAULT) exactly as a consumer reaches the capture library's.
set_target_properties(rs_live_host PROPERTIES ENABLE_EXPORTS ON)

else()
  grc_linux_only("rs_live_host" "POSIX interop host helper.")
endif()

# W11t: the /11 live coding (rs_live_coding.h): unit checks, and the coding tool whose output for
# golden-11's recordings is pinned byte for byte (protocol/golden-11/coding/).
add_executable(rs_live_coding_test test/rs_live_coding_test.cpp)
target_link_libraries(rs_live_coding_test PRIVATE grc_warnings grc_codecs)
grc_add_test(NAME rs_live_coding COMMAND rs_live_coding_test)
# Linux-only: Golden comparisons require sh and cmp.
if(NOT GRC_WINDOWS)
add_executable(rs_live_coding_tool test/rs_live_coding_tool.cpp)
target_link_libraries(rs_live_coding_tool PRIVATE grc_warnings grc_codecs)
foreach(name full patch inline)
  grc_add_test(NAME rs_live_coding_golden_${name}
    COMMAND sh -c "\"$1\" encode \"$2/$3.rs11\" \"$4/$3.coded\" >/dev/null && cmp \"$4/$3.coded\" \"$2/coding/$3.coded\""
      sh $<TARGET_FILE:rs_live_coding_tool> ${GRC_DATA_PREFIX}protocol/golden-11
      ${name} ${CMAKE_CURRENT_BINARY_DIR})
endforeach()
# PM5: golden-12/coding/ is the same tool's output for golden-12's recordings (render-stream-12.md:
# /12's live transport is /11's, W11t's coding included).
foreach(name full patch inline)
  grc_add_test(NAME rs_live_coding_golden12_${name}
    COMMAND sh -c "\"$1\" encode \"$2/$3.rs12\" \"$4/$3.12.coded\" >/dev/null && cmp \"$4/$3.12.coded\" \"$2/coding/$3.coded\""
      sh $<TARGET_FILE:rs_live_coding_tool> ${GRC_DATA_PREFIX}protocol/golden-12
      ${name} ${CMAKE_CURRENT_BINARY_DIR})
endforeach()

else()
  grc_linux_only("rs_live_coding_tool" "Golden comparisons require sh and cmp.")
endif()

# Gate 2 (G2b1): the /2 codec is byte-identical to protocol/golden-2/{full,patch,inline}.rs2.
# Linked into render_stream_capture since G2b2 (rs_publish, rs_live).
add_executable(rs2_codec_test test/rs2_codec_test.cpp src/rs2_codec.cpp)
target_include_directories(rs2_codec_test PRIVATE src test)
target_link_libraries(rs2_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs2_codec_test PRIVATE
  GRC_GOLDEN2_DIR="${GRC_DATA_PREFIX}protocol/golden-2")
grc_add_test(NAME rs2_codec COMMAND rs2_codec_test)

# Gate 2 (G2b1): the /2 patch diff derives the same golden bytes, and resolves a patch chain
# (items AND textures) back to the states it was built from (golden and randomized).
add_executable(rs2_diff_test test/rs2_diff_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs2_diff_test PRIVATE src test)
target_link_libraries(rs2_diff_test PRIVATE grc_warnings)
target_compile_definitions(rs2_diff_test PRIVATE
  GRC_GOLDEN2_DIR="${GRC_DATA_PREFIX}protocol/golden-2")
grc_add_test(NAME rs2_diff COMMAND rs2_diff_test)

# Gate 4 (G4e1): render-stream/3 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version), proven byte-identical to protocol/golden-3/{full,patch,inline}.rs3.
add_executable(rs3_codec_test test/rs3_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs3_codec_test PRIVATE src test)
target_link_libraries(rs3_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs3_codec_test PRIVATE
  GRC_GOLDEN3_DIR="${GRC_DATA_PREFIX}protocol/golden-3")
grc_add_test(NAME rs3_codec COMMAND rs3_codec_test)

# Gate 5 (G5w): render-stream/4 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-4/{full,patch,inline}.rs4 -- the eleven new commands, the mesh table, cmd_i32
# and mesh_f32.
add_executable(rs4_codec_test test/rs4_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs4_codec_test PRIVATE src test)
target_link_libraries(rs4_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs4_codec_test PRIVATE
  GRC_GOLDEN4_DIR="${GRC_DATA_PREFIX}protocol/golden-4")
grc_add_test(NAME rs4_codec COMMAND rs4_codec_test)

# Gate 5.5 (G55w): render-stream/5 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-5/{full,patch,inline}.rs5 -- the shader and material tables, canvas modulate,
# item material/use_parent_material/instance_params and the param_f64 block.
add_executable(rs5_codec_test test/rs5_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs5_codec_test PRIVATE src test)
target_link_libraries(rs5_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs5_codec_test PRIVATE
  GRC_GOLDEN5_DIR="${GRC_DATA_PREFIX}protocol/golden-5")
grc_add_test(NAME rs5_codec COMMAND rs5_codec_test)

# Gate 6 (G6w): render-stream/6 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-6/{full,patch,inline}.rs6 -- presentation stretch declarations, the top-level
# publication key and canvas layer/sublayer.
add_executable(rs6_codec_test test/rs6_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs6_codec_test PRIVATE src test)
target_link_libraries(rs6_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs6_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${GRC_DATA_PREFIX}protocol/golden-6")
grc_add_test(NAME rs6_codec COMMAND rs6_codec_test)

# Gate 7 (G7w): render-stream/7 is a live-transport-only protocol-version switch on the SAME /2
# codec module (Session::version), proven byte-identical to protocol/golden-7/{rate,window2}.rs7
# -- the publication.credit_window delta. No rs2_diff.cpp linkage needed:
# both golden-7 legs are hand-built Transactions, never make_full()/make_patch().
add_executable(rs7_codec_test test/rs7_codec_test.cpp src/rs2_codec.cpp)
target_include_directories(rs7_codec_test PRIVATE src test)
target_link_libraries(rs7_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs7_codec_test PRIVATE
  GRC_GOLDEN7_DIR="${GRC_DATA_PREFIX}protocol/golden-7")
grc_add_test(NAME rs7_codec COMMAND rs7_codec_test)

# Gate 8 (G8w): render-stream/8 is a protocol-version switch on the SAME /2 codec modules, proven
# byte-identical to protocol/golden-8/{full,patch,inline,off}.rs8 (the session's adoption and
# resources.decode keys, adopted resource-table origins, adopted_content, source_format).
add_executable(rs8_codec_test test/rs8_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs8_codec_test PRIVATE src test)
target_link_libraries(rs8_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs8_codec_test PRIVATE
  GRC_GOLDEN8_DIR="${GRC_DATA_PREFIX}protocol/golden-8")
grc_add_test(NAME rs8_codec COMMAND rs8_codec_test)

# Gate 8: render-stream/9 is /8 plus the texture-delivery wire,
# proven byte-identical to protocol/golden-9/{full,patch,inline,off}.rs9.
add_executable(rs9_codec_test test/rs9_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs9_codec_test PRIVATE src test)
target_link_libraries(rs9_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs9_codec_test PRIVATE
  GRC_GOLDEN9_DIR="${GRC_DATA_PREFIX}protocol/golden-9")
grc_add_test(NAME rs9_codec COMMAND rs9_codec_test)

# CG1: render-stream/10 is /9 plus the back-buffer item state (canvas_group, copy_to_backbuffer,
# the backbuffer_f32 block; render-stream-10.md), proven byte-identical to
# protocol/golden-10/{full,patch,inline}.rs10.
add_executable(rs10_codec_test test/rs10_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs10_codec_test PRIVATE src test)
target_link_libraries(rs10_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs10_codec_test PRIVATE
  GRC_GOLDEN10_DIR="${GRC_DATA_PREFIX}protocol/golden-10")
grc_add_test(NAME rs10_codec COMMAND rs10_codec_test)

# W11a: render-stream/11 is /10 plus the carried-set rules (records from (B, T)), dynamic mesh
# surfaces (`u8`, the mesh_u8 block), the empty mm_f32 block, resources.mesh_dynamic and a patched
# `unsupported` (render-stream-11.md), proven byte-identical to
# protocol/golden-11/{full,patch,inline}.rs11 and, with keep-carried, invalid/resource-missing.rs11.
add_executable(rs11_codec_test test/rs11_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs11_codec_test PRIVATE src test)
target_link_libraries(rs11_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs11_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${GRC_DATA_PREFIX}protocol/golden-6"
  GRC_GOLDEN10_DIR="${GRC_DATA_PREFIX}protocol/golden-10"
  GRC_GOLDEN11_DIR="${GRC_DATA_PREFIX}protocol/golden-11")
grc_add_test(NAME rs11_codec COMMAND rs11_codec_test)

# PM5: render-stream/12 is /11 plus the particles table, particle_emits, add_particles, the
# optional pt_f32 block and the particle_process_material builtin (render-stream-12.md), proven
# byte-identical to protocol/golden-12/{full,patch,inline}.rs12, with the /11 lowering checked.
add_executable(rs12_codec_test test/rs12_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs12_codec_test PRIVATE src test)
target_link_libraries(rs12_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs12_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${GRC_DATA_PREFIX}protocol/golden-6"
  GRC_GOLDEN10_DIR="${GRC_DATA_PREFIX}protocol/golden-10"
  GRC_GOLDEN11_DIR="${GRC_DATA_PREFIX}protocol/golden-11"
  GRC_GOLDEN12_DIR="${GRC_DATA_PREFIX}protocol/golden-12")
grc_add_test(NAME rs12_codec COMMAND rs12_codec_test)

# W13a: render-stream/13 is /12 plus the GRSD magic, `predict_check` and the predicted blocks
# mesh_u8/mesh_f32/mm_f32 (render-stream-13.md "As built (W13a)", src/rs13_predict.{h,cpp}), proven
# byte-identical to protocol/golden-13 (golden-12's lanes and the prediction lane) both ways.
add_executable(rs13_codec_test test/rs13_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
  src/rs13_predict.cpp)
target_include_directories(rs13_codec_test PRIVATE src test)
target_link_libraries(rs13_codec_test PRIVATE grc_warnings grc_codecs)
target_compile_definitions(rs13_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${GRC_DATA_PREFIX}protocol/golden-6"
  GRC_GOLDEN10_DIR="${GRC_DATA_PREFIX}protocol/golden-10"
  GRC_GOLDEN11_DIR="${GRC_DATA_PREFIX}protocol/golden-11"
  GRC_GOLDEN12_DIR="${GRC_DATA_PREFIX}protocol/golden-12"
  GRC_GOLDEN13_DIR="${GRC_DATA_PREFIX}protocol/golden-13")
grc_add_test(NAME rs13_codec COMMAND rs13_codec_test)

# Gate 8 (G8w): the GRC_STREAM_VERSION / GRC_ADOPT / GRC_TEXTURE_DECODE parsing, the D2 refusal and
# the live listener's subprotocol offer, plus the two empty seams.
add_executable(rs_gate8_policy_test
  test/rs_gate8_policy_test.cpp src/rs_gate8_policy.cpp
  src/rs_texture_decode.cpp src/rs_texture_delivery.cpp src/iface.cpp)
target_include_directories(rs_gate8_policy_test PRIVATE src vendor)
target_link_libraries(rs_gate8_policy_test PRIVATE grc_warnings)
grc_add_test(NAME rs_gate8_policy COMMAND rs_gate8_policy_test)

# ID3 (render-stream-14.md): item_meta v2's pure half -- the v2 names, grant bits, columns and
# re-stamped rows -- beside TAG1's /13 rows.
add_executable(rs_item_meta_test test/rs_item_meta_test.cpp test/rs_item_meta_host_test.cpp
  src/rs_item_meta.cpp src/rs_item_meta_host.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp
  src/rs_shader_payload.cpp src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp
  src/rs2_diff.cpp src/rs2_codec.cpp)
target_include_directories(rs_item_meta_test PRIVATE src)
target_link_libraries(rs_item_meta_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_item_meta COMMAND rs_item_meta_test)
# Linux-only: Python source-tree check runs on the build host.
if(NOT GRC_WINDOWS)
grc_add_test(NAME rs_item_meta_reentry_source
  COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/test/reentry-source-test.py)

else()
  grc_linux_only("rs_item_meta_reentry_source" "Python source-tree check runs on the build host.")
endif()

# G8kw: the texture worker pool, the publication hold-back and the held hook-log lines
# Async predictions plus jobs resolve to the synchronous
# snapshots (full-transaction bytes) and log lines; stop/drain/refusal, mispredict, the fault knob.
add_executable(rs_texture_worker_test
  test/rs_texture_worker_test.cpp src/rs_texture_worker.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp
  src/rs_resource_log.cpp src/rs_shader_payload.cpp src/rs_texture_payload.cpp
  src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs_texture_worker_test PRIVATE src)
target_link_libraries(rs_texture_worker_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_texture_worker COMMAND rs_texture_worker_test)

# the arm-time adoption pass: a born-armed hook sequence and the
# walk's AdoptPlan give the same mirror state but for origin; the walk sabotages; the residue under
# strict and skip; the configurable caps. The walk itself runs only inside Godot (run-gate8.sh g8a).
# G8r: adopted textures and meshes equal created ones but for origin and adopted_content, the
# refinement to current, the hook log's adopt lines, GRC_ADOPT_FAULT parsing.
add_executable(rs_adopt_test test/rs_adopt_test.cpp src/rs_adopt.cpp src/rs_reload.cpp src/rs_warm.cpp src/iface.cpp
  src/rs_mirror.cpp src/rs_texture_delivery.cpp src/rs_shader_payload.cpp src/rs_texture_payload.cpp src/rs_mesh_payload.cpp
  src/rs_sha256.cpp src/rs2_diff.cpp src/rs_resource_log.cpp src/rs_texture_worker.cpp
  src/rs2_codec.cpp src/rs_variant.cpp src/rs_registry.cpp src/rs_evict.cpp
  src/rs_texture_release.cpp src/rs_refusal.cpp src/rs_hold.cpp src/report.cpp)
target_compile_definitions(rs_adopt_test PRIVATE GRC_ADOPT_TEST)
target_include_directories(rs_adopt_test PRIVATE src vendor)
target_link_libraries(rs_adopt_test PRIVATE grc_warnings grc_codecs Threads::Threads)
grc_add_test(NAME rs_adopt COMMAND rs_adopt_test)

# the host-decode seam: the decode table, the result check that
# refuses an engine decode of the wrong format or shape, perturb-decode and the totals, against a
# fake backend (the engine backend itself runs only inside Godot: run-gate8.sh's g8t legs).
add_executable(rs_texture_decode_test
  test/rs_texture_decode_test.cpp src/rs_texture_decode.cpp src/iface.cpp)
target_include_directories(rs_texture_decode_test PRIVATE src vendor)
target_link_libraries(rs_texture_decode_test PRIVATE grc_warnings)
grc_add_test(NAME rs_texture_decode COMMAND rs_texture_decode_test)

# Gate 2 (G2a): SHA-256 on the FIPS 180-4 vectors, the GRT1 texture payload on the four shapes the
# golden-2 vectors use (literal bytes), and the texture hook log (evidence/resources.jsonl).
# G8sha: the vectors on each path forced (portable, and SHA-NI when the CPU has it), SHA-NI against
# portable on every length 0..10000 and on 16 MiB, and the dispatch choice.
add_executable(rs_sha256_test test/rs_sha256_test.cpp src/rs_sha256.cpp)
target_include_directories(rs_sha256_test PRIVATE src)
target_link_libraries(rs_sha256_test PRIVATE grc_warnings)
grc_add_test(NAME rs_sha256 COMMAND rs_sha256_test)

# G8sha: the SHA-256 throughput microbench (MB/s per path on 64 B..4 KiB and 16 MiB). Built, never
# run by ctest: it measures, it does not judge.
# Linux-only: Benchmark is outside the established Windows bundle.
if(NOT GRC_WINDOWS)
add_executable(rs_sha256_bench test/rs_sha256_bench.cpp src/rs_sha256.cpp)
target_include_directories(rs_sha256_bench PRIVATE src)
target_link_libraries(rs_sha256_bench PRIVATE grc_warnings)

else()
  grc_linux_only("rs_sha256_bench" "Benchmark is outside the established Windows bundle.")
endif()

# HC6: the mirror's flat RID map (rs_rid_map.h) against std::unordered_map.
add_executable(rs_rid_map_test test/rs_rid_map_test.cpp)
target_include_directories(rs_rid_map_test PRIVATE src)
target_link_libraries(rs_rid_map_test PRIVATE grc_warnings)
grc_add_test(NAME rs_rid_map COMMAND rs_rid_map_test)

# Gate 6 (G6r): the fixed-size log-linear histogram (bucket boundaries, the 6.25% relative-error
# bound, exact aggregates, percentile, JSON shape).
add_executable(rs_histogram_test test/rs_histogram_test.cpp src/rs_histogram.cpp src/report.cpp)
target_include_directories(rs_histogram_test PRIVATE src)
target_link_libraries(rs_histogram_test PRIVATE grc_warnings)
grc_add_test(NAME rs_histogram COMMAND rs_histogram_test)

# The opt-in headless CanvasTexture shim:
# mode parsing, the headless-only arm decision, private RIDs at index >= 2^31 only for an
# RID() engine result, pass-through when off or when the engine allocated, free bookkeeping.
add_executable(rs_canvas_texture_shim_test
  test/rs_canvas_texture_shim_test.cpp src/rs_canvas_texture_shim.cpp src/report.cpp)
target_include_directories(rs_canvas_texture_shim_test PRIVATE src)
target_link_libraries(rs_canvas_texture_shim_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_canvas_texture_shim COMMAND rs_canvas_texture_shim_test)

# HTR (rs_texture_release.h): GRC_HEADLESS_TEXTURE_RELEASE parsing, the headless-only decision,
# the VRAM tier, the predicate, the counters, and the off path's flag-check cost.
# Linux-only: Wall-clock cost assertion is unsuitable for a shared Windows VM.
if(NOT GRC_WINDOWS)
add_executable(rs_texture_release_test
  test/rs_texture_release_test.cpp src/rs_texture_release.cpp)
target_include_directories(rs_texture_release_test PRIVATE src)
target_link_libraries(rs_texture_release_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_texture_release COMMAND rs_texture_release_test)

else()
  grc_linux_only("rs_texture_release_test" "Wall-clock cost assertion is unsuitable for a shared Windows VM.")
endif()

# the resource registry -- kinds per tracked create, erase on
# free and texture_replace, the per-family cap and overflow, the accounting identity
# registry-live-bound judges, the timeline, the two fault knobs, the off gate, threads.
add_executable(rs_registry_test test/rs_registry_test.cpp src/rs_registry.cpp src/rs_hold.cpp src/report.cpp)
target_include_directories(rs_registry_test PRIVATE src)
target_link_libraries(rs_registry_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_registry COMMAND rs_registry_test)

# Engine-free texture reload rules, GRT1 framing and reload/restore evidence.
add_executable(rs_reload_test test/rs_reload_test.cpp src/rs_reload.cpp
  src/rs_texture_payload.cpp src/rs_texture_delivery.cpp src/report.cpp)
target_include_directories(rs_reload_test PRIVATE src)
target_link_libraries(rs_reload_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_reload COMMAND rs_reload_test)

# the two shadow tables. rs_vtable_test builds both over a
# polymorphic fake, checks which slots each replaces, the restore from either and the refusal of a
# foreign vptr, then flips the vptr 10^6 times under 4 caller threads (neither table freed).
# rs_standby_test is `standby-slot-census`: the standby set (rs_standby.cpp) against hooks.cpp's own
# hook bodies (a hook that reaches the registry or a shim is in it; nothing else but
# texture_set_path and draw) and against the expected list.
# Linux-only: GCC devirtualization flags and source-tree census.
if(NOT GRC_WINDOWS)
add_executable(rs_vtable_test test/rs_vtable_test.cpp src/vtable.cpp)
target_include_directories(rs_vtable_test PRIVATE src)
target_link_libraries(rs_vtable_test PRIVATE grc_warnings Threads::Threads)
# The test dispatches through the real vptr: no devirtualisation of the fake's calls.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  target_compile_options(rs_vtable_test PRIVATE -fno-devirtualize -fno-devirtualize-speculatively)
endif()
grc_add_test(NAME rs_vtable COMMAND rs_vtable_test)
add_executable(rs_standby_test test/rs_standby_test.cpp src/rs_standby.cpp)
target_include_directories(rs_standby_test PRIVATE src)
target_link_libraries(rs_standby_test PRIVATE grc_warnings)
grc_add_test(NAME rs_standby COMMAND rs_standby_test ${CMAKE_CURRENT_SOURCE_DIR}/src/hooks.cpp)

else()
  grc_linux_only("rs_vtable_test;rs_standby_test" "GCC devirtualization flags and source-tree census.")
endif()

# LAR0: the registry's per-call cost (ns per create+free pair, uncontended and with 4 threads, and
# the off gate). Built, never run by ctest: it measures, it does not judge.
# Linux-only: Benchmark is outside the established Windows bundle.
if(NOT GRC_WINDOWS)
add_executable(rs_registry_bench test/rs_registry_bench.cpp src/rs_registry.cpp src/report.cpp)
target_include_directories(rs_registry_bench PRIVATE src)
target_link_libraries(rs_registry_bench PRIVATE grc_warnings Threads::Threads)

else()
  grc_linux_only("rs_registry_bench" "Benchmark is outside the established Windows bundle.")
endif()

# PM5: the particles RID shim and the pre-draw pump's option parsing (render-stream-12.md
# "Headless shims (opt-in)").
add_executable(rs_particles_shim_test test/rs_particles_shim_test.cpp src/rs_particles_shim.cpp)
target_include_directories(rs_particles_shim_test PRIVATE src)
target_link_libraries(rs_particles_shim_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_particles_shim COMMAND rs_particles_shim_test)

add_executable(rs_texture_payload_test
  test/rs_texture_payload_test.cpp src/rs_texture_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_texture_payload_test PRIVATE src)
# G2b2: the payload encoder is byte-identical to protocol/golden-2/payloads/.
target_compile_definitions(rs_texture_payload_test PRIVATE
  GRC_GOLDEN2_DIR="${GRC_DATA_PREFIX}protocol/golden-2")
target_link_libraries(rs_texture_payload_test PRIVATE grc_warnings)
grc_add_test(NAME rs_texture_payload COMMAND rs_texture_payload_test)

add_executable(rs_resource_log_test
  test/rs_resource_log_test.cpp src/rs_resource_log.cpp src/rs_texture_payload.cpp
  src/rs_mesh_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_resource_log_test PRIVATE src)
target_link_libraries(rs_resource_log_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_resource_log COMMAND rs_resource_log_test)

# Gate 5: the GRM1 mesh payload encoder and its format classification.
add_executable(rs_mesh_payload_test
  test/rs_mesh_payload_test.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_mesh_payload_test PRIVATE src)
target_link_libraries(rs_mesh_payload_test PRIVATE grc_warnings)
grc_add_test(NAME rs_mesh_payload COMMAND rs_mesh_payload_test)

# Gate 5.5 (G55a): the GRP1 shader payload encoder, the D11 token scan and the D7
# CanvasItemMaterial template recognizer. Engine-free, as the GRM1
# test is.
add_executable(rs_shader_payload_test
  test/rs_shader_payload_test.cpp src/rs_shader_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_shader_payload_test PRIVATE src)
target_link_libraries(rs_shader_payload_test PRIVATE grc_warnings)
grc_add_test(NAME rs_shader_payload COMMAND rs_shader_payload_test)

# Gate 5.5 (G55a): D8's Variant decode -- every supported type round-trips through a fake
# GDExtension interface built for the test (gdextension_interface.h's own function-pointer
# shapes, never a live engine: iface.h's g_iface is a plain global the test fills in itself, as
# no ctest here ever runs inside Godot).
add_executable(rs_variant_test test/rs_variant_test.cpp src/rs_variant.cpp src/iface.cpp)
target_include_directories(rs_variant_test PRIVATE src vendor)
target_link_libraries(rs_variant_test PRIVATE grc_warnings)
grc_add_test(NAME rs_variant COMMAND rs_variant_test)

# G8kv: the basisu wrapper, on synthetic images: encode, validate the KTX2 against the render-stream/9
# ktx2 profile in C++, thread safety of the one-time init. The Godot-transcoder round trip and the
# TS validator run from scripts/test/g8kv-roundtrip.sh (ctest label "engine" is not used: it needs godot).
# Linux-only: Basis encoder and Godot roundtrip are outside the established Windows bundle.
if(NOT GRC_WINDOWS)
add_executable(rs_basis_encode_test test/rs_basis_encode_test.cpp src/rs_basis_encode.cpp)
target_include_directories(rs_basis_encode_test PRIVATE src)
target_link_libraries(rs_basis_encode_test PRIVATE grc_warnings grc_basisu)
grc_add_test(NAME rs_basis_encode COMMAND rs_basis_encode_test)
# G8ku: UASTC level against speed and PSNR on raw RGBA8 inputs (a bench, not a test).
add_executable(rs_basis_level_bench test/rs_basis_level_bench.cpp src/rs_basis_encode.cpp)
target_include_directories(rs_basis_level_bench PRIVATE src)
target_link_libraries(rs_basis_level_bench PRIVATE grc_warnings grc_basisu)
# The Godot-transcoder round trip and the TS validator (needs mise, godot, pnpm; SKIP when no godot).
grc_add_test(NAME rs_basis_roundtrip
  COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/test/g8kv-roundtrip.sh ${CMAKE_CURRENT_BINARY_DIR}/g8kv-roundtrip)
set_tests_properties(rs_basis_roundtrip PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 300)

else()
  grc_linux_only("rs_basis_encode_test;rs_basis_level_bench;rs_basis_roundtrip" "Basis encoder and Godot roundtrip are outside the established Windows bundle.")
endif()

# the persisted host texture cache: put/get, reopen,
# verify-against-name, corrupt delete, the LRU byte budget, key validation.
add_executable(rs_texture_cache_test test/rs_texture_cache_test.cpp src/rs_texture_cache.cpp src/rs_sha256.cpp)
target_include_directories(rs_texture_cache_test PRIVATE src)
target_link_libraries(rs_texture_cache_test PRIVATE grc_warnings Threads::Threads)
grc_add_test(NAME rs_texture_cache COMMAND rs_texture_cache_test)

# Engine-free capture control and per-arm settings.
# Linux-only: Uses setenv.
if(NOT GRC_WINDOWS)
add_executable(rs_setting_test test/rs_setting_test.cpp src/rs_setting.cpp)
target_include_directories(rs_setting_test PRIVATE src)
target_link_libraries(rs_setting_test PRIVATE grc_warnings)
grc_add_test(NAME rs_setting COMMAND rs_setting_test)
else()
  grc_linux_only("rs_setting_test" "Uses setenv.")
endif()

add_executable(rs_capture_api_test test/rs_capture_api_test.cpp src/rs_capture_api.cpp)
target_include_directories(rs_capture_api_test PRIVATE src)
target_link_libraries(rs_capture_api_test PRIVATE grc_warnings grc_platform Threads::Threads)
grc_add_test(NAME rs_capture_api COMMAND rs_capture_api_test)

# These standalone consumers share the same platform implementation as the capture.
foreach(target IN ITEMS rs_publish_test rs_ws_test rs_ws_echo rs_carrier_set_test rs_track_test
    rs_carrier_ext_test rs_expose_test rs_net_module_test rs_live_test rs_live_window_test
    rs_live_host rs_texture_worker_test rs_adopt_test rs_histogram_test
    rs_canvas_texture_shim_test rs_registry_test rs_registry_bench rs_texture_cache_test
    rs_reload_test)
  if(TARGET ${target})
    target_link_libraries(${target} PRIVATE grc_platform)
  endif()
endforeach()

# Pure arm-time warm classification, claims, accounting and evidence.
# Linux-only: Not in the established Windows bundle; newly eligible follow-up.
if(NOT GRC_WINDOWS)
add_executable(rs_warm_test test/rs_warm_test.cpp src/rs_warm.cpp src/report.cpp)
target_include_directories(rs_warm_test PRIVATE src)
target_link_libraries(rs_warm_test PRIVATE grc_warnings grc_platform Threads::Threads)
grc_add_test(NAME rs_warm COMMAND rs_warm_test)

else()
  grc_linux_only("rs_warm_test" "Not in the established Windows bundle; newly eligible follow-up.")
endif()

# Pure texture image reference policy, accounting and evidence.
add_executable(rs_hold_test test/rs_hold_test.cpp src/rs_hold.cpp src/report.cpp)
target_include_directories(rs_hold_test PRIVATE src)
target_link_libraries(rs_hold_test PRIVATE grc_warnings grc_platform Threads::Threads)
grc_add_test(NAME rs_hold COMMAND rs_hold_test)

# Pure texture refusal and dependent recovery evidence.
add_executable(rs_refusal_test test/rs_refusal_test.cpp src/rs_refusal.cpp src/rs_hold.cpp src/report.cpp)
target_include_directories(rs_refusal_test PRIVATE src)
target_link_libraries(rs_refusal_test PRIVATE grc_warnings grc_platform Threads::Threads)
grc_add_test(NAME rs_refusal COMMAND rs_refusal_test)

# Pure frame-boundary texture release predicates, queue, accounting and evidence.
# Linux-only: Not in the established Windows bundle; newly eligible follow-up.
if(NOT GRC_WINDOWS)
add_executable(rs_evict_test test/rs_evict_test.cpp src/rs_evict.cpp src/rs_texture_release.cpp src/report.cpp)
target_include_directories(rs_evict_test PRIVATE src)
target_link_libraries(rs_evict_test PRIVATE grc_warnings grc_platform Threads::Threads)
grc_add_test(NAME rs_evict COMMAND rs_evict_test)

else()
  grc_linux_only("rs_evict_test" "Not in the established Windows bundle; newly eligible follow-up.")
endif()

add_executable(rs_env_test test/rs_env_test.cpp)
target_include_directories(rs_env_test PRIVATE src)
target_link_libraries(rs_env_test PRIVATE grc_warnings grc_platform)
grc_add_test(NAME rs_env COMMAND rs_env_test)

add_executable(rs_process_test test/rs_process_test.cpp)
target_include_directories(rs_process_test PRIVATE src)
target_link_libraries(rs_process_test PRIVATE grc_warnings grc_platform)
grc_add_test(NAME rs_process COMMAND rs_process_test)


if(GRC_WINDOWS)
  include(cmake/windows-bundle.cmake)
endif()
