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
  src/rs1_codec.cpp
  src/rs1_diff.cpp
  src/rs1_live.cpp
  src/rs1_publish.cpp
  src/rs_mirror.cpp
  src/rs_root_query.cpp
  src/rs_sha1.cpp
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

# Gate 0 (WP1) / gate 1 (G1b2): the retained canvas mirror, driven through its
# public API with no engine, including draw-index ties, root geometry and the
# omit-op sabotage.
add_executable(rs_mirror_test test/rs_mirror_test.cpp src/rs_mirror.cpp)
target_include_directories(rs_mirror_test PRIVATE src)
target_link_libraries(rs_mirror_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_mirror COMMAND rs_mirror_test)

# Gate 1 (G1b2): the render-stream/1 publisher -- full and patch sinks from one
# snapshot per frame, patch/full equivalence, sabotages, per-sink stats --
# against memory sinks, fed by a real mirror.
add_executable(rs1_publish_test
  test/rs1_publish_test.cpp
  src/rs1_codec.cpp
  src/rs1_diff.cpp
  src/rs1_publish.cpp
  src/rs_mirror.cpp
  src/report.cpp
)
target_include_directories(rs1_publish_test PRIVATE src test)
target_link_libraries(rs1_publish_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs1_publish COMMAND rs1_publish_test)

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

# Gate 1 (G1b1): the /1 codec is byte-identical to protocol/golden-1/{full,patch}.rs1.
add_executable(rs1_codec_test test/rs1_codec_test.cpp src/rs1_codec.cpp)
target_include_directories(rs1_codec_test PRIVATE src test)
target_link_libraries(rs1_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs1_codec_test PRIVATE
  GRC_GOLDEN1_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-1")
add_test(NAME rs1_codec COMMAND rs1_codec_test)

# Gate 1 (G1b1): the /1 patch diff derives the same golden bytes, and resolves a patch chain back
# to the states it was built from (golden and randomized).
add_executable(rs1_diff_test test/rs1_diff_test.cpp src/rs1_codec.cpp src/rs1_diff.cpp)
target_include_directories(rs1_diff_test PRIVATE src test)
target_link_libraries(rs1_diff_test PRIVATE grc_warnings)
target_compile_definitions(rs1_diff_test PRIVATE
  GRC_GOLDEN1_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-1")
add_test(NAME rs1_diff COMMAND rs1_diff_test)

# Gate 1 (G1c2): the live hub -- credit, resync, message-too-large, hello timeout, drop-message,
# finish, the live log and tap, and the control-message parser against golden-1/control/ --
# driven through a fake transport.
add_executable(rs1_live_test
  test/rs1_live_test.cpp
  src/rs1_codec.cpp
  src/rs1_diff.cpp
  src/rs1_live.cpp
  src/rs1_publish.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
)
target_include_directories(rs1_live_test PRIVATE src test)
target_link_libraries(rs1_live_test PRIVATE grc_warnings Threads::Threads)
target_compile_definitions(rs1_live_test PRIVATE
  GRC_GOLDEN1_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-1"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs1_live_test_tmp")
add_test(NAME rs1_live COMMAND rs1_live_test)
