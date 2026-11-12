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

# the gsw-input/1 reference injector embedded in the library for
# GRC_LIVE_TRACK_INPUT_INJECT=reference. cmake/embed_gsw_input.cmake composes the addon's scripts
# and src/track_inject_glue.gd into one GDScript (inner classes, renamed) and a header with its
# bytes and the addon digest. The stamp makes a changed addon file regenerate; the generated files
# are written only when their content changed, so an unchanged addon rebuilds nothing.
set(GRC_GSW_INPUT_ADDON ${CMAKE_CURRENT_SOURCE_DIR}/../../../packages/input/godot/addons/gsw_input)
set(GRC_INJECT_GEN ${CMAKE_CURRENT_BINARY_DIR}/generated)
file(GLOB GRC_GSW_INPUT_SCRIPTS CONFIGURE_DEPENDS ${GRC_GSW_INPUT_ADDON}/*.gd)
add_custom_command(
  OUTPUT ${GRC_INJECT_GEN}/embed.stamp
  COMMAND ${CMAKE_COMMAND} -DADDON_DIR=${GRC_GSW_INPUT_ADDON}
    -DGLUE=${CMAKE_CURRENT_SOURCE_DIR}/src/track_inject_glue.gd -DOUT_DIR=${GRC_INJECT_GEN}
    -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_gsw_input.cmake
  COMMAND ${CMAKE_COMMAND} -E touch ${GRC_INJECT_GEN}/embed.stamp
  DEPENDS ${GRC_GSW_INPUT_SCRIPTS} src/track_inject_glue.gd cmake/embed_gsw_input.cmake
  COMMENT "Embedding the gsw-input reference injector"
  VERBATIM)
add_custom_target(grc_inject_script DEPENDS ${GRC_INJECT_GEN}/embed.stamp)
