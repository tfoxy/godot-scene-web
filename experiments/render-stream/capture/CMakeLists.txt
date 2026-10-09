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
