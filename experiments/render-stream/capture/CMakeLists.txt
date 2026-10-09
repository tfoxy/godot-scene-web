cmake_minimum_required(VERSION 3.22)
project(render_stream_capture LANGUAGES CXX)

# Gate -1 of docs/handoff-headless-render-stream.md: a RenderingServer capture
# seam for an unmodified official Godot Linux x86-64 template. The library
# depends on nothing but libc/libstdc++ and the vendored GDExtension header.

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "render_stream_capture is Linux-only (got ${CMAKE_SYSTEM_NAME})")
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

add_library(grc_warnings INTERFACE)
target_compile_options(grc_warnings INTERFACE -Wall -Wextra -Werror)

add_library(render_stream_capture SHARED
  src/calib.cpp
  src/entry.cpp
  src/hooks.cpp
  src/iface.cpp
  src/report.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_live.cpp
  src/rs_mirror.cpp
  src/rs_publish.cpp
  src/rs_resource_log.cpp
  src/rs_resource_store.cpp
  src/rs_root_query.cpp
  src/rs_sha1.cpp
  src/rs_sha256.cpp
  src/rs_texture_payload.cpp
  src/rs_ws.cpp
  src/vtable.cpp
)
target_include_directories(render_stream_capture PRIVATE src vendor)
target_link_libraries(render_stream_capture PRIVATE grc_warnings)
set_target_properties(render_stream_capture PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON
  PREFIX "lib"
)
# The hooks are reached only through the shadow vtable, and the engine owns the
# frame pointer discipline on the calling side; keep frame pointers so a crash
# inside a hook has a readable stack.
target_compile_options(render_stream_capture PRIVATE -fno-omit-frame-pointer)
find_package(Threads REQUIRED)
target_link_libraries(render_stream_capture PRIVATE Threads::Threads)

# `.gdextension` file with the absolute path of the library just built, so a
# fixture can load it with GDExtensionManager.load_extension() from anywhere.
set(GRC_LIBRARY_PATH "$<TARGET_FILE:render_stream_capture>")
file(GENERATE
  OUTPUT "${CMAKE_BINARY_DIR}/render_stream_capture.gdextension"
  INPUT "${CMAKE_CURRENT_SOURCE_DIR}/render_stream_capture.gdextension.in"
)

enable_testing()
add_executable(abi_decode_test test/abi_decode.cpp)
target_include_directories(abi_decode_test PRIVATE src)
target_link_libraries(abi_decode_test PRIVATE grc_warnings)
add_test(NAME abi_decode COMMAND abi_decode_test)

# Gate 0 (WP1) / gate 1 (G1b2) / gate 2 (G2b2): the retained canvas mirror, driven through its
# public API with no engine, including draw-index ties, root geometry, the omit-op sabotage and
# the texture table (ids, versions, tombstones, replace, derived unsupported entries).
add_executable(rs_mirror_test test/rs_mirror_test.cpp src/rs_mirror.cpp
  src/rs_texture_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_mirror_test PRIVATE src)
target_link_libraries(rs_mirror_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_mirror COMMAND rs_mirror_test)

# Gate 1 (G1b2) / gate 2 (G2b2): the render-stream/2 publisher -- full and patch sinks from one
# snapshot per frame, patch/full equivalence, sabotages, per-sink stats, the store directory and
# inline resource records -- against memory sinks, fed by a real mirror.
add_executable(rs_publish_test
  test/rs_publish_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_publish.cpp
  src/rs_mirror.cpp
  src/rs_resource_store.cpp
  src/rs_texture_payload.cpp
  src/rs_sha256.cpp
  src/report.cpp
)
target_include_directories(rs_publish_test PRIVATE src test)
target_link_libraries(rs_publish_test PRIVATE grc_warnings Threads::Threads)
target_compile_definitions(rs_publish_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_publish_test_tmp")
add_test(NAME rs_publish COMMAND rs_publish_test)

# G1c1: rs_ws, a dependency-free RFC 6455 server on its own I/O thread
# (protocol/gate1-design.md D3, Q3, Q4). Pure transport: no mirror, no engine.
# Linked into render_stream_capture since G1c2 (GRC_LIVE_LISTEN, src/rs1_live.*).
add_executable(rs_ws_test test/rs_ws_test.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_test PRIVATE src)
target_link_libraries(rs_ws_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_ws COMMAND rs_ws_test)

# Test-only echo server for the Node and Godot interop self-tests
# (scripts/test/self-test-rs-ws.ts, receiver/tests/ws_selftest.gd). Not linked
# into render_stream_capture.
add_executable(rs_ws_echo test/rs_ws_echo.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_echo PRIVATE src)
target_link_libraries(rs_ws_echo PRIVATE grc_warnings Threads::Threads)

# Gate 1 (G1c2) / gate 2 (G2b2): the live hub -- credit, resync, message-too-large, hello
# timeout, drop-message, finish, the live log and tap, inline resource records per connection,
# and the control-message parser against golden-2/control/ -- driven through a fake transport.
add_executable(rs_live_test
  test/rs_live_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_live.cpp
  src/rs_publish.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_test PRIVATE src test)
target_link_libraries(rs_live_test PRIVATE grc_warnings Threads::Threads)
target_compile_definitions(rs_live_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_live_test_tmp")
add_test(NAME rs_live COMMAND rs_live_test)

# Gate 2 (G2b1): the /2 codec is byte-identical to protocol/golden-2/{full,patch,inline}.rs2.
# Linked into render_stream_capture since G2b2 (rs_publish, rs_live).
add_executable(rs2_codec_test test/rs2_codec_test.cpp src/rs2_codec.cpp)
target_include_directories(rs2_codec_test PRIVATE src test)
target_link_libraries(rs2_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs2_codec_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2")
add_test(NAME rs2_codec COMMAND rs2_codec_test)

# Gate 2 (G2b1): the /2 patch diff derives the same golden bytes, and resolves a patch chain
# (items AND textures) back to the states it was built from (golden and randomized).
add_executable(rs2_diff_test test/rs2_diff_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs2_diff_test PRIVATE src test)
target_link_libraries(rs2_diff_test PRIVATE grc_warnings)
target_compile_definitions(rs2_diff_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2")
add_test(NAME rs2_diff COMMAND rs2_diff_test)

# Gate 2 (G2a): SHA-256 on the FIPS 180-4 vectors, the GRT1 texture payload on the four shapes the
# golden-2 vectors use (literal bytes), and the texture hook log (evidence/resources.jsonl).
add_executable(rs_sha256_test test/rs_sha256_test.cpp src/rs_sha256.cpp)
target_include_directories(rs_sha256_test PRIVATE src)
target_link_libraries(rs_sha256_test PRIVATE grc_warnings)
add_test(NAME rs_sha256 COMMAND rs_sha256_test)

add_executable(rs_texture_payload_test
  test/rs_texture_payload_test.cpp src/rs_texture_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_texture_payload_test PRIVATE src)
# G2b2: the payload encoder is byte-identical to protocol/golden-2/payloads/.
target_compile_definitions(rs_texture_payload_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2")
target_link_libraries(rs_texture_payload_test PRIVATE grc_warnings)
add_test(NAME rs_texture_payload COMMAND rs_texture_payload_test)

add_executable(rs_resource_log_test
  test/rs_resource_log_test.cpp src/rs_resource_log.cpp src/rs_texture_payload.cpp)
target_include_directories(rs_resource_log_test PRIVATE src)
target_link_libraries(rs_resource_log_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_resource_log COMMAND rs_resource_log_test)
