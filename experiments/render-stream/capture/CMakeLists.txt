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
  src/rs0_codec.cpp
  src/rs0_mirror.cpp
  src/rs0_publish.cpp
  src/rs0_root_query.cpp
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

# Gate 0 (WP1): the retained canvas mirror, driven through its public API with
# no engine.
add_executable(rs0_mirror_test test/rs0_mirror_test.cpp src/rs0_mirror.cpp)
target_include_directories(rs0_mirror_test PRIVATE src)
target_link_libraries(rs0_mirror_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs0_mirror COMMAND rs0_mirror_test)

# Gate 0 (WP2): the codec is byte-identical to protocol/golden/minimal.bin.
add_executable(rs0_codec_test
  test/rs0_codec_test.cpp
  src/rs0_codec.cpp
  src/rs0_publish.cpp
  src/report.cpp
)
target_include_directories(rs0_codec_test PRIVATE src)
target_link_libraries(rs0_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs0_codec_test PRIVATE
  GRC_GOLDEN_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden")
add_test(NAME rs0_codec COMMAND rs0_codec_test)

# G1c1: rs_ws, a dependency-free RFC 6455 server on its own I/O thread
# (protocol/gate1-design.md D3, Q3, Q4). Pure transport: no mirror, no engine,
# not yet wired into render_stream_capture (G1c2 does that).
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
