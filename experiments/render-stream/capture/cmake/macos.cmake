# Native Apple clang builds, one architecture per configure. The shell entry point combines the
# slices with lipo after building; never pass a universal architecture list to basisu's SSE file.
if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang")
  message(FATAL_ERROR "render_stream_capture: macOS requires native Apple clang and the Xcode SDK")
endif()
if(NOT CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64|x86_64)$")
  message(FATAL_ERROR "render_stream_capture: configure one macOS slice (arm64 or x86_64)")
endif()
if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
  set(GRC_MACOS_MINIMUM 11.0)
else()
  set(GRC_MACOS_MINIMUM 10.15)
endif()
if(NOT CMAKE_OSX_DEPLOYMENT_TARGET STREQUAL GRC_MACOS_MINIMUM)
  message(FATAL_ERROR "render_stream_capture: ${CMAKE_OSX_ARCHITECTURES} requires deployment target ${GRC_MACOS_MINIMUM}")
endif()
add_compile_options(-ffp-contract=off)
find_program(GRC_CODESIGN codesign REQUIRED)

function(grc_sign_macho target)
  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND ${GRC_CODESIGN} -s - --force $<TARGET_FILE:${target}>
    COMMAND ${GRC_CODESIGN} --verify --strict $<TARGET_FILE:${target}>
    VERBATIM)
endfunction()

function(grc_macos_test name)
  add_executable(${name}_test ${ARGN})
  target_include_directories(${name}_test PRIVATE src test vendor)
  target_link_libraries(${name}_test PRIVATE grc_warnings)
  set_target_properties(${name}_test PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
  # Several codec tests include older codec tests and need their golden directories too.
  foreach(version RANGE 2 13)
    target_compile_definitions(${name}_test PRIVATE
      GRC_GOLDEN${version}_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-${version}")
  endforeach()
  grc_sign_macho(${name}_test)
  grc_add_test(NAME ${name} COMMAND ${name}_test)
endfunction()

function(grc_macos_engine_free_tests)
  # Keep the engine-free tests explicit; the remaining POSIX suite is enabled separately.
  find_package(Threads REQUIRED)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  grc_add_test(NAME m_checks COMMAND ${Python3_EXECUTABLE} -I
    ${CMAKE_CURRENT_SOURCE_DIR}/test/m_checks_test.py)
  set_property(SOURCE src/rs13_predict.cpp APPEND PROPERTY COMPILE_OPTIONS -Wno-unused-function)
  grc_macos_test(abi_decode test/abi_decode.cpp)
  grc_macos_test(rs_parse_double test/rs_parse_double_test.cpp)
  grc_macos_test(rs_sha256 test/rs_sha256_test.cpp src/rs_sha256.cpp)
  grc_macos_test(rs2_diff test/rs2_diff_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
  foreach(version RANGE 2 13)
    set(sources test/rs${version}_codec_test.cpp src/rs2_codec.cpp)
    if(NOT version EQUAL 2 AND NOT version EQUAL 7)
      list(APPEND sources src/rs2_diff.cpp)
    endif()
    if(version EQUAL 13)
      list(APPEND sources src/rs13_predict.cpp)
    endif()
    grc_macos_test(rs${version}_codec ${sources})
    if(version EQUAL 13)
      target_link_libraries(rs${version}_codec_test PRIVATE grc_codecs)
    endif()
  endforeach()
  grc_macos_test(rs15 test/rs15_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
    src/rs13_predict.cpp src/rs_hints.cpp)
  grc_macos_test(rs16 test/rs16_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
    src/rs13_predict.cpp)
  target_link_libraries(rs15_test PRIVATE grc_codecs)
  target_link_libraries(rs16_test PRIVATE grc_codecs)
  grc_macos_test(rs_live_coding test/rs_live_coding_test.cpp)
  target_link_libraries(rs_live_coding_test PRIVATE grc_codecs)
  grc_macos_test(rs_rid_map test/rs_rid_map_test.cpp)
  grc_macos_test(rs_mesh_payload test/rs_mesh_payload_test.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp)
  grc_macos_test(rs_shader_payload test/rs_shader_payload_test.cpp src/rs_shader_payload.cpp src/rs_sha256.cpp)
  grc_macos_test(rs_variant test/rs_variant_test.cpp src/rs_variant.cpp src/iface.cpp)
  grc_macos_test(rs_particles_shim test/rs_particles_shim_test.cpp src/rs_particles_shim.cpp)
  target_link_libraries(rs_particles_shim_test PRIVATE Threads::Threads)
  grc_macos_test(rs_setting test/rs_setting_test.cpp src/rs_setting.cpp)

  foreach(probe IN ITEMS abi_convention_probe abi_convention_probe_stack_width)
    add_executable(${probe} test/abi_convention_probe.cpp)
    target_include_directories(${probe} PRIVATE src)
    target_compile_options(${probe} PRIVATE -O2)
    target_link_libraries(${probe} PRIVATE grc_warnings)
    set_target_properties(${probe} PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
    grc_sign_macho(${probe})
  endforeach()
  target_compile_definitions(abi_convention_probe_stack_width PRIVATE GRC_PROBE_STACK_WIDTH=1)
  grc_add_test(NAME abi_convention_probe COMMAND abi_convention_probe)
  if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
    grc_add_test(NAME abi_convention_probe_stack_width_sabotage
      COMMAND abi_convention_probe_stack_width --expect-fail hook-nine-patch)
  else()
    grc_add_test(NAME abi_convention_probe_stack_width_control COMMAND abi_convention_probe_stack_width)
  endif()
  include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/capture-deps.cmake)
  grc_macos_test(rs_basis_encode test/rs_basis_encode_test.cpp src/rs_basis_encode.cpp)
  target_link_libraries(rs_basis_encode_test PRIVATE grc_basisu)

  # The Darwin platform has its own translation unit; Linux and Windows retain theirs.
  find_library(GRC_PROC_LIBRARY proc REQUIRED)
  add_library(grc_platform STATIC src/rs_platform_darwin.cpp)
  target_include_directories(grc_platform PUBLIC src)
  target_link_libraries(grc_platform PRIVATE grc_warnings
    PUBLIC Threads::Threads ${GRC_PROC_LIBRARY} ${CMAKE_DL_LIBS})
  set_target_properties(grc_platform PROPERTIES
    POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
  grc_macos_test(rs_platform_darwin test/rs_platform_darwin_test.cpp)
  target_link_libraries(rs_platform_darwin_test PRIVATE grc_platform)
  target_compile_definitions(rs_platform_darwin_test PRIVATE
    GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_platform_darwin_test_tmp")
  set_tests_properties(rs_platform_darwin PROPERTIES TIMEOUT 30)

  include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/macos-posix-tests.cmake)

  grc_macos_test(calib_fingerprint_darwin test/calib_fingerprint_darwin_test.cpp
    src/calib.cpp src/calib_fingerprint_darwin.cpp src/iface.cpp src/rs_sha256.cpp)
  target_link_libraries(calib_fingerprint_darwin_test PRIVATE grc_platform)

  include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/capture-sources.cmake)
  list(REMOVE_ITEM GRC_CAPTURE_SOURCES src/rs_platform_posix.cpp src/calib_fingerprint_posix.cpp)
  list(APPEND GRC_CAPTURE_SOURCES src/calib_fingerprint_darwin.cpp src/calib_live.cpp
    src/calib_derive.cpp src/pe_image.cpp)
  add_library(render_stream_capture SHARED ${GRC_CAPTURE_SOURCES})
  target_include_directories(render_stream_capture PRIVATE src vendor ${GRC_INJECT_GEN})
  add_dependencies(render_stream_capture grc_inject_script)
  target_link_libraries(render_stream_capture PRIVATE grc_warnings grc_codecs grc_basisu grc_platform)
  target_compile_options(render_stream_capture PRIVATE -fno-omit-frame-pointer)
  set_target_properties(render_stream_capture PROPERTIES
    CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON PREFIX "lib")
  grc_sign_macho(render_stream_capture)

  set(GRC_LIBRARY_PATH_DESCRIPTION "a relative universal library path")
  set(GRC_LIBRARY_OS macos)
  set(GRC_LIBRARY_PATH "librender_stream_capture.dylib")
  set(GRC_LIBRARY_EXTRA "macos.arm64 = \"${GRC_LIBRARY_PATH}\"\n")
  configure_file(render_stream_capture.gdextension.in render_stream_capture.gdextension @ONLY)
  message(STATUS "macOS: capture dylib and native tests; arming refuses until Mach-O fingerprinting is available")
endfunction()
