include(CheckCXXSourceCompiles)
check_cxx_source_compiles("#include <cstddef>
#if !defined(__clang__) || !defined(__linux__) || !defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 200000 || defined(__GLIBCXX__)
#error not Linux clang with libc++ 20 or newer
#endif
int main() { return 0; }" GRC_IS_LINUX_LIBCXX)
if(NOT GRC_IS_LINUX_LIBCXX)
  message(FATAL_ERROR "render_stream_capture: requires Linux clang and libc++ >= 20")
endif()
# The adoption test includes hooks.h, whose guard bookkeeping field is unused in that build.
target_compile_options(grc_warnings INTERFACE -Wno-unused-private-field)
# The WebSocket echo fixture keeps a protocol constant unused by this test build.
target_compile_options(grc_warnings INTERFACE -Wno-unused-const-variable)
# Clang diagnoses the unused is_word_stream helper in the predictive codec.
set_property(SOURCE src/rs13_predict.cpp APPEND PROPERTY COMPILE_OPTIONS -Wno-unused-function)
