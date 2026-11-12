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

# Clang-only diagnostics already suppressed in the Windows declarations and Linux libc++ control.
set_property(SOURCE src/rs13_predict.cpp APPEND PROPERTY COMPILE_OPTIONS -Wno-unused-function)
