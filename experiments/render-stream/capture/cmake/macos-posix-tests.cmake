# The POSIX transport and file suites use the Darwin backend, with no engine or net module.
# Keep this separate from the Windows bundle's grc_linux_only exclusions: those reasons are
# reviewed per target in the render-stream README and are not macOS capability checks.
grc_macos_test(rs_ws test/rs_ws_test.cpp src/rs_ws.cpp src/rs_sha1.cpp src/rs_net_module.cpp
  src/rs_carrier_set.cpp src/rs_resource_store.cpp src/report.cpp src/rs_sha256.cpp)
target_link_libraries(rs_ws_test PRIVATE grc_codecs grc_platform)
# Do not discover Homebrew OpenSSL: TLS belongs to the separate native net-module validation.

grc_macos_test(rs_carrier_set test/rs_carrier_set_test.cpp src/rs_carrier_set.cpp src/rs_ws.cpp
  src/rs_sha1.cpp)
target_link_libraries(rs_carrier_set_test PRIVATE grc_codecs grc_platform)

grc_macos_test(rs_texture_cache test/rs_texture_cache_test.cpp src/rs_texture_cache.cpp
  src/rs_sha256.cpp)
target_link_libraries(rs_texture_cache_test PRIVATE grc_platform)

grc_macos_test(rs_publish test/rs_publish_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
  src/rs_publish.cpp src/rs_item_meta.cpp src/rs13_predict.cpp src/rs_mirror.cpp
  src/rs_texture_delivery.cpp src/rs_shader_payload.cpp src/rs_resource_store.cpp
  src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp src/report.cpp)
target_link_libraries(rs_publish_test PRIVATE grc_codecs grc_platform)
target_compile_definitions(rs_publish_test PRIVATE
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_publish_test_tmp")
set_tests_properties(rs_ws rs_carrier_set rs_texture_cache rs_publish PROPERTIES TIMEOUT 120)

# Same peer-reset cases and default signal disposition, changing only socket preparation.
grc_macos_test(rs_sigpipe test/rs_sigpipe_test.cpp)
target_link_libraries(rs_sigpipe_test PRIVATE grc_platform)
add_executable(rs_sigpipe_no_nosigpipe_test test/rs_sigpipe_test.cpp src/rs_platform_darwin.cpp)
target_include_directories(rs_sigpipe_no_nosigpipe_test PRIVATE src)
target_compile_definitions(rs_sigpipe_no_nosigpipe_test PRIVATE GRC_TEST_NO_NOSIGPIPE=1)
target_link_libraries(rs_sigpipe_no_nosigpipe_test PRIVATE grc_warnings Threads::Threads
  ${GRC_PROC_LIBRARY} ${CMAKE_DL_LIBS})
set_target_properties(rs_sigpipe_no_nosigpipe_test PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
grc_sign_macho(rs_sigpipe_no_nosigpipe_test)
grc_add_test(NAME rs_sigpipe_no_nosigpipe COMMAND rs_sigpipe_no_nosigpipe_test --expect-sigpipe)
set_tests_properties(rs_sigpipe rs_sigpipe_no_nosigpipe PROPERTIES TIMEOUT 30)
