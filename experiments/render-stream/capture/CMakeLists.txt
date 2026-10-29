cmake_minimum_required(VERSION 3.22)
project(render_stream_capture LANGUAGES C CXX)

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
  src/rs_http_coding.cpp src/rs_live_coding.cpp)
target_include_directories(grc_codecs PUBLIC vendor/zstd vendor/zlib src)
target_compile_definitions(grc_codecs PRIVATE ZSTD_DISABLE_ASM=1 ZSTD_LEGACY_SUPPORT=0)
target_compile_options(grc_codecs PRIVATE -w -O2)
set_source_files_properties(src/rs_http_coding.cpp src/rs_live_coding.cpp PROPERTIES
  COMPILE_OPTIONS "-Wall;-Wextra;-Werror")
set_target_properties(grc_codecs PROPERTIES
  POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)

# G8kv: basisu 1.60 (the copy Godot 4.5.1 vendors, third_party/basis_universal/PROVENANCE.md), the
# encoder and the transcoder, hidden-visibility static library on the zstd above. No OpenCL; the
# SSE4.1 kernels file is the only file built with -msse4.1 (upstream CMakeLists does the same) and
# basisu dispatches to it only when the CPU reports SSE4.1.
set(GRC_BASISU_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/basis_universal)
set(GRC_BASISU_ENC_SOURCES
  3rdparty/android_astc_decomp.cpp basisu_astc_hdr_6x6_enc.cpp basisu_astc_hdr_common.cpp
  basisu_backend.cpp basisu_basis_file.cpp basisu_bc7enc.cpp basisu_comp.cpp basisu_enc.cpp
  basisu_etc.cpp basisu_frontend.cpp basisu_gpu_texture.cpp basisu_kernels_sse.cpp
  basisu_opencl.cpp basisu_pvrtc1_4.cpp basisu_resample_filters.cpp basisu_resampler.cpp
  basisu_ssim.cpp basisu_uastc_enc.cpp basisu_uastc_hdr_4x4_enc.cpp jpgd.cpp pvpngreader.cpp)
list(TRANSFORM GRC_BASISU_ENC_SOURCES PREPEND ${GRC_BASISU_DIR}/encoder/)
add_library(grc_basisu STATIC ${GRC_BASISU_ENC_SOURCES}
  ${GRC_BASISU_DIR}/transcoder/basisu_transcoder.cpp)
target_include_directories(grc_basisu PUBLIC src)
target_include_directories(grc_basisu SYSTEM PUBLIC ${GRC_BASISU_DIR} vendor/zstd)
# PUBLIC: the headers' class layouts depend on these, so the wrapper must see the same ones.
target_compile_definitions(grc_basisu PUBLIC
  BASISU_SUPPORT_OPENCL=0 BASISU_NO_EXR=1 BASISU_SUPPORT_SSE=1 BASISD_SUPPORT_KTX2_ZSTD=1
  BASISD_SUPPORT_ATC=0 BASISD_SUPPORT_FXT1=0 BASISD_SUPPORT_PVRTC1=0 BASISD_SUPPORT_PVRTC2=0)
target_compile_options(grc_basisu PRIVATE -w -O2)
set_source_files_properties(${GRC_BASISU_DIR}/encoder/basisu_kernels_sse.cpp
  PROPERTIES COMPILE_OPTIONS "-msse4.1")
target_link_libraries(grc_basisu PUBLIC grc_codecs Threads::Threads)
set_target_properties(grc_basisu PROPERTIES
  POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)

add_library(render_stream_capture SHARED
  src/calib.cpp
  src/entry.cpp
  src/hooks.cpp
  src/iface.cpp
  src/report.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_adopt.cpp
  src/rs_basis_encode.cpp
  src/rs_texture_basis.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_particles_shim.cpp
  src/rs_gate8_policy.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_mirror.cpp
  src/rs_texture_cache.cpp
  src/rs_texture_delivery.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_mesh_payload.cpp
  src/rs_resource_log.cpp
  src/rs_resource_store.cpp
  src/rs_root_query.cpp
  src/rs_shader_clock.cpp
  src/rs_sha1.cpp
  src/rs_sha256.cpp
  src/rs_shader_payload.cpp
  src/rs_texture_decode.cpp
  src/rs_texture_payload.cpp
  src/rs_texture_worker.cpp
  src/rs_variant.cpp
  src/rs_ws.cpp
  src/vtable.cpp
)
target_include_directories(render_stream_capture PRIVATE src vendor)
target_link_libraries(render_stream_capture PRIVATE grc_warnings grc_codecs grc_basisu)
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

# Gate 0 (WP1) / gate 1 (G1b2) / gate 2 (G2b2) / gate 3 (G3a): the retained canvas mirror, driven
# through its public API with no engine, including draw-index ties, root geometry, the omit-op
# sabotage, the texture table (ids, versions, tombstones, replace, derived unsupported entries)
# and the clip reset of canvas_item_clear (diffed against the previous snapshot).
add_executable(rs_mirror_test test/rs_mirror_test.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp src/rs_shader_payload.cpp
  src/rs_texture_payload.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_diff.cpp src/rs2_codec.cpp)
target_include_directories(rs_mirror_test PRIVATE src)
target_link_libraries(rs_mirror_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_mirror COMMAND rs_mirror_test)
# HC4a: the same cases with the shadow oracle on (every snapshot compared with the full walk).
add_test(NAME rs_mirror_shadow COMMAND rs_mirror_test)
set_tests_properties(rs_mirror_shadow PROPERTIES ENVIRONMENT "RS_MIRROR_TEST_SHADOW=1")

# Gate 1 (G1b2) / gate 2 (G2b2): the render-stream/2 publisher -- full and patch sinks from one
# snapshot per frame, patch/full equivalence, sabotages, per-sink stats, the store directory and
# inline resource records -- against memory sinks, fed by a real mirror.
add_executable(rs_publish_test
  test/rs_publish_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_publish.cpp
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
target_link_libraries(rs_publish_test PRIVATE grc_warnings grc_codecs Threads::Threads)
target_compile_definitions(rs_publish_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_publish_test_tmp")
add_test(NAME rs_publish COMMAND rs_publish_test)

# G1c1: rs_ws, a dependency-free RFC 6455 server on its own I/O thread
# (protocol/gate1-design.md D3, Q3, Q4). Pure transport: no mirror, no engine.
# Linked into render_stream_capture since G1c2 (GRC_LIVE_LISTEN, src/rs1_live.*).
add_executable(rs_ws_test test/rs_ws_test.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_test PRIVATE src)
target_link_libraries(rs_ws_test PRIVATE grc_warnings grc_codecs Threads::Threads)
add_test(NAME rs_ws COMMAND rs_ws_test)

# Test-only echo server for the Node and Godot interop self-tests
# (scripts/test/self-test-rs-ws.ts, receiver/tests/ws_selftest.gd). Not linked
# into render_stream_capture.
add_executable(rs_ws_echo test/rs_ws_echo.cpp src/rs_ws.cpp src/rs_sha1.cpp)
target_include_directories(rs_ws_echo PRIVATE src)
target_link_libraries(rs_ws_echo PRIVATE grc_warnings Threads::Threads)

# Gate 1 (G1c2) / gate 2 (G2b2): the live hub -- credit, resync, message-too-large, hello
# timeout, drop-message, finish, the live log and tap, inline resource records per connection,
# (G2c2) the served set: pins, retirement, unpin, drop-resource, wrong-hash, GET attribution,
# and the control-message parser against golden-2/control/ and (G4e2) golden-3/control/ -- driven
# through a fake transport.
add_executable(rs_live_test
  test/rs_live_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_test PRIVATE src test)
target_link_libraries(rs_live_test PRIVATE grc_warnings grc_codecs Threads::Threads)
target_compile_definitions(rs_live_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2"
  GRC_GOLDEN3_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-3"
  GRC_GOLDEN4_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-4"
  GRC_GOLDEN7_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-7"
  GRC_GOLDEN9_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-9"
  GRC_GOLDEN10_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-10"
  GRC_GOLDEN11_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-11"
  GRC_GOLDEN12_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-12"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_live_test_tmp")
add_test(NAME rs_live COMMAND rs_live_test)
# HC5: the same tests with every hub's formation jobs on the encode thread.
add_test(NAME rs_live_thread COMMAND rs_live_test --formation=thread)
set_tests_properties(rs_live rs_live_thread PROPERTIES RESOURCE_LOCK rs_live_tmp)

# G7q: credit window tests (gate7-design.md D4, Q2 "Credit with window w"): window 1 pinned by
# transcript digests recorded before G7q (test/golden/live-window1-transcripts.txt), and window 2.
add_executable(rs_live_window_test
  test/rs_live_window_test.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_sha256.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_window_test PRIVATE src test)
target_link_libraries(rs_live_window_test PRIVATE grc_warnings grc_codecs Threads::Threads)
target_compile_definitions(rs_live_window_test PRIVATE
  GRC_WINDOW1_TRANSCRIPTS="${CMAKE_CURRENT_SOURCE_DIR}/test/golden/live-window1-transcripts.txt"
  GRC_TEST_TMP_DIR="${CMAKE_CURRENT_BINARY_DIR}/rs_live_window_test_tmp")
add_test(NAME rs_live_window COMMAND rs_live_window_test)
add_test(NAME rs_live_window_thread COMMAND rs_live_window_test --formation=thread)
set_tests_properties(rs_live_window rs_live_window_thread PROPERTIES RESOURCE_LOCK rs_live_window_tmp)

# G7n: test-only live host (rs_ws + the hub around a fixed scene) for the Node interop
# self-test's /6 + /7, hello token, Origin and CORS checks (scripts/test/self-test-rs-ws.ts).
# Not linked into render_stream_capture.
add_executable(rs_live_host
  test/rs_live_host.cpp
  src/rs2_codec.cpp
  src/rs2_diff.cpp
  src/rs_canvas_texture_shim.cpp
  src/rs_histogram.cpp
  src/rs_live.cpp
  src/rs_publish.cpp
  src/rs13_predict.cpp
  src/rs_resource_store.cpp
  src/report.cpp
  src/rs_sha1.cpp
  src/rs_ws.cpp
)
target_include_directories(rs_live_host PRIVATE src test)
target_link_libraries(rs_live_host PRIVATE grc_warnings grc_codecs Threads::Threads)

# W11t: the /11 live coding (rs_live_coding.h): unit checks, and the coding tool whose output for
# golden-11's recordings is pinned byte for byte (protocol/golden-11/coding/).
add_executable(rs_live_coding_test test/rs_live_coding_test.cpp)
target_link_libraries(rs_live_coding_test PRIVATE grc_warnings grc_codecs)
add_test(NAME rs_live_coding COMMAND rs_live_coding_test)
add_executable(rs_live_coding_tool test/rs_live_coding_tool.cpp)
target_link_libraries(rs_live_coding_tool PRIVATE grc_warnings grc_codecs)
foreach(name full patch inline)
  add_test(NAME rs_live_coding_golden_${name}
    COMMAND sh -c "\"$1\" encode \"$2/$3.rs11\" \"$4/$3.coded\" >/dev/null && cmp \"$4/$3.coded\" \"$2/coding/$3.coded\""
      sh $<TARGET_FILE:rs_live_coding_tool> ${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-11
      ${name} ${CMAKE_CURRENT_BINARY_DIR})
endforeach()
# PM5: golden-12/coding/ is the same tool's output for golden-12's recordings (render-stream-12.md:
# /12's live transport is /11's, W11t's coding included).
foreach(name full patch inline)
  add_test(NAME rs_live_coding_golden12_${name}
    COMMAND sh -c "\"$1\" encode \"$2/$3.rs12\" \"$4/$3.12.coded\" >/dev/null && cmp \"$4/$3.12.coded\" \"$2/coding/$3.coded\""
      sh $<TARGET_FILE:rs_live_coding_tool> ${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-12
      ${name} ${CMAKE_CURRENT_BINARY_DIR})
endforeach()

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

# Gate 4 (G4e1): render-stream/3 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version), proven byte-identical to protocol/golden-3/{full,patch,inline}.rs3.
add_executable(rs3_codec_test test/rs3_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs3_codec_test PRIVATE src test)
target_link_libraries(rs3_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs3_codec_test PRIVATE
  GRC_GOLDEN3_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-3")
add_test(NAME rs3_codec COMMAND rs3_codec_test)

# Gate 5 (G5w): render-stream/4 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-4/{full,patch,inline}.rs4 -- the eleven new commands, the mesh table, cmd_i32
# and mesh_f32.
add_executable(rs4_codec_test test/rs4_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs4_codec_test PRIVATE src test)
target_link_libraries(rs4_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs4_codec_test PRIVATE
  GRC_GOLDEN4_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-4")
add_test(NAME rs4_codec COMMAND rs4_codec_test)

# Gate 5.5 (G55w): render-stream/5 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-5/{full,patch,inline}.rs5 -- the shader and material tables, canvas modulate,
# item material/use_parent_material/instance_params and the param_f64 block.
add_executable(rs5_codec_test test/rs5_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs5_codec_test PRIVATE src test)
target_link_libraries(rs5_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs5_codec_test PRIVATE
  GRC_GOLDEN5_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-5")
add_test(NAME rs5_codec COMMAND rs5_codec_test)

# Gate 6 (G6w): render-stream/6 is a protocol-version switch on the SAME /2 codec/diff modules
# (Session::version/Transaction::version/Snapshot::version), proven byte-identical to
# protocol/golden-6/{full,patch,inline}.rs6 -- presentation stretch declarations, the top-level
# publication key and canvas layer/sublayer.
add_executable(rs6_codec_test test/rs6_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs6_codec_test PRIVATE src test)
target_link_libraries(rs6_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs6_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-6")
add_test(NAME rs6_codec COMMAND rs6_codec_test)

# Gate 7 (G7w): render-stream/7 is a live-transport-only protocol-version switch on the SAME /2
# codec module (Session::version), proven byte-identical to protocol/golden-7/{rate,window2}.rs7
# -- the publication.credit_window delta (gate7-design.md D2). No rs2_diff.cpp linkage needed:
# both golden-7 legs are hand-built Transactions, never make_full()/make_patch().
add_executable(rs7_codec_test test/rs7_codec_test.cpp src/rs2_codec.cpp)
target_include_directories(rs7_codec_test PRIVATE src test)
target_link_libraries(rs7_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs7_codec_test PRIVATE
  GRC_GOLDEN7_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-7")
add_test(NAME rs7_codec COMMAND rs7_codec_test)

# Gate 8 (G8w): render-stream/8 is a protocol-version switch on the SAME /2 codec modules, proven
# byte-identical to protocol/golden-8/{full,patch,inline,off}.rs8 (the session's adoption and
# resources.decode keys, adopted resource-table origins, adopted_content, source_format).
add_executable(rs8_codec_test test/rs8_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs8_codec_test PRIVATE src test)
target_link_libraries(rs8_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs8_codec_test PRIVATE
  GRC_GOLDEN8_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-8")
add_test(NAME rs8_codec COMMAND rs8_codec_test)

# Gate 8 (G8k9): render-stream/9 is /8 plus the texture-delivery wire (texture-delivery-design.md
# D4/Q5), proven byte-identical to protocol/golden-9/{full,patch,inline,off}.rs9.
add_executable(rs9_codec_test test/rs9_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs9_codec_test PRIVATE src test)
target_link_libraries(rs9_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs9_codec_test PRIVATE
  GRC_GOLDEN9_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-9")
add_test(NAME rs9_codec COMMAND rs9_codec_test)

# CG1: render-stream/10 is /9 plus the back-buffer item state (canvas_group, copy_to_backbuffer,
# the backbuffer_f32 block; render-stream-10.md), proven byte-identical to
# protocol/golden-10/{full,patch,inline}.rs10.
add_executable(rs10_codec_test test/rs10_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs10_codec_test PRIVATE src test)
target_link_libraries(rs10_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs10_codec_test PRIVATE
  GRC_GOLDEN10_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-10")
add_test(NAME rs10_codec COMMAND rs10_codec_test)

# W11a: render-stream/11 is /10 plus the carried-set rules (records from (B, T)), dynamic mesh
# surfaces (`u8`, the mesh_u8 block), the empty mm_f32 block, resources.mesh_dynamic and a patched
# `unsupported` (render-stream-11.md), proven byte-identical to
# protocol/golden-11/{full,patch,inline}.rs11 and, with keep-carried, invalid/resource-missing.rs11.
add_executable(rs11_codec_test test/rs11_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs11_codec_test PRIVATE src test)
target_link_libraries(rs11_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs11_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-6"
  GRC_GOLDEN10_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-10"
  GRC_GOLDEN11_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-11")
add_test(NAME rs11_codec COMMAND rs11_codec_test)

# PM5: render-stream/12 is /11 plus the particles table, particle_emits, add_particles, the
# optional pt_f32 block and the particle_process_material builtin (render-stream-12.md), proven
# byte-identical to protocol/golden-12/{full,patch,inline}.rs12, with the /11 lowering checked.
add_executable(rs12_codec_test test/rs12_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs12_codec_test PRIVATE src test)
target_link_libraries(rs12_codec_test PRIVATE grc_warnings)
target_compile_definitions(rs12_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-6"
  GRC_GOLDEN10_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-10"
  GRC_GOLDEN11_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-11"
  GRC_GOLDEN12_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-12")
add_test(NAME rs12_codec COMMAND rs12_codec_test)

# W13a: render-stream/13 is /12 plus the GRSD magic, `predict_check` and the predicted blocks
# mesh_u8/mesh_f32/mm_f32 (render-stream-13.md "As built (W13a)", src/rs13_predict.{h,cpp}), proven
# byte-identical to protocol/golden-13 (golden-12's lanes and the prediction lane) both ways.
add_executable(rs13_codec_test test/rs13_codec_test.cpp src/rs2_codec.cpp src/rs2_diff.cpp
  src/rs13_predict.cpp)
target_include_directories(rs13_codec_test PRIVATE src test)
target_link_libraries(rs13_codec_test PRIVATE grc_warnings grc_codecs)
target_compile_definitions(rs13_codec_test PRIVATE
  GRC_GOLDEN6_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-6"
  GRC_GOLDEN10_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-10"
  GRC_GOLDEN11_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-11"
  GRC_GOLDEN12_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-12"
  GRC_GOLDEN13_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-13")
add_test(NAME rs13_codec COMMAND rs13_codec_test)

# Gate 8 (G8w): the GRC_STREAM_VERSION / GRC_ADOPT / GRC_TEXTURE_DECODE parsing, the D2 refusal and
# the live listener's subprotocol offer, plus the two empty seams.
add_executable(rs_gate8_policy_test
  test/rs_gate8_policy_test.cpp src/rs_gate8_policy.cpp
  src/rs_texture_decode.cpp src/rs_texture_delivery.cpp src/iface.cpp)
target_include_directories(rs_gate8_policy_test PRIVATE src vendor)
target_link_libraries(rs_gate8_policy_test PRIVATE grc_warnings)
add_test(NAME rs_gate8_policy COMMAND rs_gate8_policy_test)

# G8kw: the texture worker pool, the publication hold-back and the held hook-log lines
# (texture-delivery-design.md D11, Q7): async predictions plus jobs resolve to the synchronous
# snapshots (full-transaction bytes) and log lines; stop/drain/refusal, mispredict, the fault knob.
add_executable(rs_texture_worker_test
  test/rs_texture_worker_test.cpp src/rs_texture_worker.cpp src/rs_mirror.cpp src/rs_texture_delivery.cpp
  src/rs_resource_log.cpp src/rs_shader_payload.cpp src/rs_texture_payload.cpp
  src/rs_mesh_payload.cpp src/rs_sha256.cpp src/rs2_codec.cpp src/rs2_diff.cpp)
target_include_directories(rs_texture_worker_test PRIVATE src)
target_link_libraries(rs_texture_worker_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_texture_worker COMMAND rs_texture_worker_test)

# G8a: the arm-time adoption pass (gate8-design.md D3-D5, D13): a born-armed hook sequence and the
# walk's AdoptPlan give the same mirror state but for origin; the walk sabotages; the residue under
# strict and skip; the configurable caps. The walk itself runs only inside Godot (run-gate8.sh g8a).
# G8r: adopted textures and meshes equal created ones but for origin and adopted_content, the
# refinement to current, the hook log's adopt lines, GRC_ADOPT_FAULT parsing.
add_executable(rs_adopt_test test/rs_adopt_test.cpp src/rs_adopt.cpp src/iface.cpp
  src/rs_mirror.cpp src/rs_texture_delivery.cpp src/rs_shader_payload.cpp src/rs_texture_payload.cpp src/rs_mesh_payload.cpp
  src/rs_sha256.cpp src/rs2_diff.cpp src/rs_resource_log.cpp src/rs_texture_worker.cpp
  src/rs2_codec.cpp src/rs_variant.cpp)
target_include_directories(rs_adopt_test PRIVATE src vendor)
target_link_libraries(rs_adopt_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_adopt COMMAND rs_adopt_test)

# G8t: the host-decode seam (gate8-design.md D8, Q3): the decode table, the result check that
# refuses an engine decode of the wrong format or shape, perturb-decode and the totals, against a
# fake backend (the engine backend itself runs only inside Godot: run-gate8.sh's g8t legs).
add_executable(rs_texture_decode_test
  test/rs_texture_decode_test.cpp src/rs_texture_decode.cpp src/iface.cpp)
target_include_directories(rs_texture_decode_test PRIVATE src vendor)
target_link_libraries(rs_texture_decode_test PRIVATE grc_warnings)
add_test(NAME rs_texture_decode COMMAND rs_texture_decode_test)

# Gate 2 (G2a): SHA-256 on the FIPS 180-4 vectors, the GRT1 texture payload on the four shapes the
# golden-2 vectors use (literal bytes), and the texture hook log (evidence/resources.jsonl).
# G8sha: the vectors on each path forced (portable, and SHA-NI when the CPU has it), SHA-NI against
# portable on every length 0..10000 and on 16 MiB, and the dispatch choice.
add_executable(rs_sha256_test test/rs_sha256_test.cpp src/rs_sha256.cpp)
target_include_directories(rs_sha256_test PRIVATE src)
target_link_libraries(rs_sha256_test PRIVATE grc_warnings)
add_test(NAME rs_sha256 COMMAND rs_sha256_test)

# G8sha: the SHA-256 throughput microbench (MB/s per path on 64 B..4 KiB and 16 MiB). Built, never
# run by ctest: it measures, it does not judge (results/gate8/g8sha.md).
add_executable(rs_sha256_bench test/rs_sha256_bench.cpp src/rs_sha256.cpp)
target_include_directories(rs_sha256_bench PRIVATE src)
target_link_libraries(rs_sha256_bench PRIVATE grc_warnings)

# Gate 6 (G6r): the fixed-size log-linear histogram (bucket boundaries, the 6.25% relative-error
# bound, exact aggregates, percentile, JSON shape).
add_executable(rs_histogram_test test/rs_histogram_test.cpp src/rs_histogram.cpp src/report.cpp)
target_include_directories(rs_histogram_test PRIVATE src)
target_link_libraries(rs_histogram_test PRIVATE grc_warnings)
add_test(NAME rs_histogram COMMAND rs_histogram_test)

# The opt-in headless CanvasTexture shim (protocol/canvas-texture-headless.md "Experiment (a)
# result"): mode parsing, the headless-only arm decision, private RIDs at index >= 2^31 only for an
# RID() engine result, pass-through when off or when the engine allocated, free bookkeeping.
add_executable(rs_canvas_texture_shim_test
  test/rs_canvas_texture_shim_test.cpp src/rs_canvas_texture_shim.cpp src/report.cpp)
target_include_directories(rs_canvas_texture_shim_test PRIVATE src)
target_link_libraries(rs_canvas_texture_shim_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_canvas_texture_shim COMMAND rs_canvas_texture_shim_test)

# PM5: the particles RID shim and the pre-draw pump's option parsing (render-stream-12.md
# "Headless shims (opt-in)").
add_executable(rs_particles_shim_test test/rs_particles_shim_test.cpp src/rs_particles_shim.cpp)
target_include_directories(rs_particles_shim_test PRIVATE src)
target_link_libraries(rs_particles_shim_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_particles_shim COMMAND rs_particles_shim_test)

add_executable(rs_texture_payload_test
  test/rs_texture_payload_test.cpp src/rs_texture_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_texture_payload_test PRIVATE src)
# G2b2: the payload encoder is byte-identical to protocol/golden-2/payloads/.
target_compile_definitions(rs_texture_payload_test PRIVATE
  GRC_GOLDEN2_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../protocol/golden-2")
target_link_libraries(rs_texture_payload_test PRIVATE grc_warnings)
add_test(NAME rs_texture_payload COMMAND rs_texture_payload_test)

add_executable(rs_resource_log_test
  test/rs_resource_log_test.cpp src/rs_resource_log.cpp src/rs_texture_payload.cpp
  src/rs_mesh_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_resource_log_test PRIVATE src)
target_link_libraries(rs_resource_log_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_resource_log COMMAND rs_resource_log_test)

# Gate 5 (G5a): the GRM1 mesh payload encoder (gate5-design.md Q4) and D7's format classification.
add_executable(rs_mesh_payload_test
  test/rs_mesh_payload_test.cpp src/rs_mesh_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_mesh_payload_test PRIVATE src)
target_link_libraries(rs_mesh_payload_test PRIVATE grc_warnings)
add_test(NAME rs_mesh_payload COMMAND rs_mesh_payload_test)

# Gate 5.5 (G55a): the GRP1 shader payload encoder, the D11 token scan and the D7
# CanvasItemMaterial template recognizer (gate5_5-design.md Q3a, Q4). Engine-free, as the GRM1
# test is.
add_executable(rs_shader_payload_test
  test/rs_shader_payload_test.cpp src/rs_shader_payload.cpp src/rs_sha256.cpp)
target_include_directories(rs_shader_payload_test PRIVATE src)
target_link_libraries(rs_shader_payload_test PRIVATE grc_warnings)
add_test(NAME rs_shader_payload COMMAND rs_shader_payload_test)

# Gate 5.5 (G55a): D8's Variant decode -- every supported type round-trips through a fake
# GDExtension interface built for the test (gdextension_interface.h's own function-pointer
# shapes, never a live engine: iface.h's g_iface is a plain global the test fills in itself, as
# no ctest here ever runs inside Godot).
add_executable(rs_variant_test test/rs_variant_test.cpp src/rs_variant.cpp src/iface.cpp)
target_include_directories(rs_variant_test PRIVATE src vendor)
target_link_libraries(rs_variant_test PRIVATE grc_warnings)
add_test(NAME rs_variant COMMAND rs_variant_test)

# G8kv: the basisu wrapper, on synthetic images: encode, validate the KTX2 against the render-stream/9
# ktx2 profile in C++, thread safety of the one-time init. The Godot-transcoder round trip and the
# TS validator run from scripts/test/g8kv-roundtrip.sh (ctest label "engine" is not used: it needs godot).
add_executable(rs_basis_encode_test test/rs_basis_encode_test.cpp src/rs_basis_encode.cpp)
target_include_directories(rs_basis_encode_test PRIVATE src)
target_link_libraries(rs_basis_encode_test PRIVATE grc_warnings grc_basisu)
add_test(NAME rs_basis_encode COMMAND rs_basis_encode_test)
# G8ku: UASTC level against speed and PSNR on raw RGBA8 inputs (a bench, not a test).
add_executable(rs_basis_level_bench test/rs_basis_level_bench.cpp src/rs_basis_encode.cpp)
target_include_directories(rs_basis_level_bench PRIVATE src)
target_link_libraries(rs_basis_level_bench PRIVATE grc_warnings grc_basisu)
# The Godot-transcoder round trip and the TS validator (needs mise, godot, pnpm; SKIP when no godot).
add_test(NAME rs_basis_roundtrip
  COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/test/g8kv-roundtrip.sh ${CMAKE_CURRENT_BINARY_DIR}/g8kv-roundtrip)
set_tests_properties(rs_basis_roundtrip PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 300)

# G8kc: the persisted host texture cache (texture-delivery-design.md D7, D8): put/get, reopen,
# verify-against-name, corrupt delete, the LRU byte budget, key validation.
add_executable(rs_texture_cache_test test/rs_texture_cache_test.cpp src/rs_texture_cache.cpp src/rs_sha256.cpp)
target_include_directories(rs_texture_cache_test PRIVATE src)
target_link_libraries(rs_texture_cache_test PRIVATE grc_warnings Threads::Threads)
add_test(NAME rs_texture_cache COMMAND rs_texture_cache_test)
