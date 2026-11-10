# Keep these declarations free of target commands so they can be evaluated without targets.
grc_w_test(calib_pe_self TARGET calib_pe_self_test
  SOURCES test/calib_pe_self_test.cpp src/calib.cpp src/calib_fingerprint_win32.cpp
    src/pe_image.cpp src/iface.cpp src/rs_sha256.cpp
  INCLUDES vendor LIBS grc_platform ARGS calib_pe_self_test.identity.json)
grc_w_test(calib_slot_mask TARGET calib_slot_mask_test
  SOURCES test/calib_slot_mask_test.cpp src/calib.cpp src/calib_fingerprint_win32.cpp
    src/pe_image.cpp src/iface.cpp src/rs_sha256.cpp
  INCLUDES vendor LIBS grc_platform)

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
  set(extras "")
  if(version EQUAL 13)
    list(APPEND sources src/rs13_predict.cpp)
    list(APPEND extras LIBS grc_codecs)
    # Clang diagnoses the unused is_word_stream helper; put its suppression after -Wall.
    list(APPEND extras OPTIONS -Wall -Wextra -Werror -Wno-unused-function)
  endif()
  grc_w_test(rs${version}_codec TARGET rs${version}_codec_test SOURCES ${sources}
    INCLUDES test DEFINES ${defines} ${extras})
endforeach()

grc_w_test(rs_gate8_policy TARGET rs_gate8_policy_test
  SOURCES test/rs_gate8_policy_test.cpp src/rs_gate8_policy.cpp
    src/rs_texture_decode.cpp src/rs_texture_delivery.cpp src/iface.cpp
  INCLUDES vendor)
grc_w_test(rs_item_meta TARGET rs_item_meta_test
  SOURCES test/rs_item_meta_test.cpp test/rs_item_meta_host_test.cpp
    src/rs_item_meta.cpp src/rs_item_meta_host.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp
    src/rs_shader_payload.cpp src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp
    src/rs2_diff.cpp src/rs2_codec.cpp
  LIBS grc_codecs Threads::Threads)
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

grc_w_test(rs_expose TARGET rs_expose_test
  SOURCES test/rs_expose_test.cpp src/rs_expose.cpp LIBS grc_platform)
grc_w_test(rs_histogram TARGET rs_histogram_test
  SOURCES test/rs_histogram_test.cpp src/rs_histogram.cpp src/report.cpp LIBS grc_platform)
grc_w_test(rs_registry TARGET rs_registry_test
  SOURCES test/rs_registry_test.cpp src/rs_registry.cpp src/report.cpp
  LIBS grc_platform Threads::Threads)
grc_w_test(rs_canvas_texture_shim TARGET rs_canvas_texture_shim_test
  SOURCES test/rs_canvas_texture_shim_test.cpp src/rs_canvas_texture_shim.cpp src/report.cpp
  LIBS grc_platform Threads::Threads)
grc_w_test(rs_texture_worker TARGET rs_texture_worker_test
  SOURCES test/rs_texture_worker_test.cpp src/rs_texture_worker.cpp src/rs_mirror.cpp
    src/rs_texture_delivery.cpp src/rs_resource_log.cpp src/rs_shader_payload.cpp
    src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_codec.cpp
    src/rs2_diff.cpp LIBS grc_platform grc_codecs Threads::Threads)
grc_w_test(rs_texture_cache TARGET rs_texture_cache_test
  SOURCES test/rs_texture_cache_test.cpp src/rs_texture_cache.cpp src/rs_sha256.cpp
  LIBS grc_platform Threads::Threads)
grc_w_test(rs_adopt TARGET rs_adopt_test
  SOURCES test/rs_adopt_test.cpp src/rs_adopt.cpp src/rs_reload.cpp src/rs_warm.cpp src/iface.cpp
    src/rs_mirror.cpp src/rs_evict.cpp src/rs_texture_release.cpp
    src/rs_texture_delivery.cpp src/rs_shader_payload.cpp src/rs_texture_payload.cpp
    src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_diff.cpp src/rs_resource_log.cpp
    src/rs_texture_worker.cpp src/rs2_codec.cpp src/rs_variant.cpp src/rs_registry.cpp src/report.cpp
  INCLUDES vendor LIBS grc_platform grc_codecs Threads::Threads DEFINES GRC_ADOPT_TEST
  # The adopt test stubs the hook implementation, leaving its private state unused.
  OPTIONS -Wall -Wextra -Werror -Wno-unused-private-field)
grc_w_test(rs_reload TARGET rs_reload_test
  SOURCES test/rs_reload_test.cpp src/rs_reload.cpp src/rs_texture_payload.cpp
    src/rs_texture_delivery.cpp src/report.cpp
  LIBS grc_platform Threads::Threads)

# Excluded until the capture library and remaining test helpers are ported:
# rs_publish: unchanged rs_resource_store.cpp's POSIX file operations.
# rs_ws, rs_carrier_set, rs_track, rs_carrier_ext, rs_net_module,
# rs_live(_thread), rs_live_window(_thread), rs_ws_echo, rs_live_host: POSIX sockets or dl*.
# rs_setting: setenv.
# rs_vtable: GCC anti-devirtualization flags. rs_standby: reads a source path.
# rs_texture_release: wall-clock assertion on a shared VM.
# rs_basis_*: basisu, bash + godot. rs_live_coding_golden*: sh -c + cmp.
# rs_platform_clock: POSIX clock_gettime linker-wrap regression test.
# calib_fingerprint: POSIX ELF/proc fault injection; calib_pe_self covers Windows identity.
# rs_net_module also needs unchanged rs_ws/rs_carrier_set socket sources ported.
