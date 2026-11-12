# Record the same executable invocation used by CTest for the Windows bundle.
function(grc_add_test)
  cmake_parse_arguments(PARSE_ARGV 0 T "" "NAME" "COMMAND")
  if(NOT T_NAME OR NOT T_COMMAND OR T_UNPARSED_ARGUMENTS)
    message(FATAL_ERROR "Invalid grc_add_test: ${ARGV}")
  endif()
  add_test(${ARGV})
  if(GRC_WINDOWS)
    set_property(GLOBAL APPEND PROPERTY GRC_W_NAMES "${T_NAME}")
    set_property(GLOBAL PROPERTY GRC_W_COMMAND_${T_NAME} "${T_COMMAND}")
  endif()
endfunction()

function(grc_linux_only targets reason)
  foreach(target IN LISTS targets)
    message(STATUS "Linux-only: ${target}: ${reason}")
  endforeach()
endfunction()

# Runtime-loaded test inputs travel with the bundle, outside the shipped-code import gate.
function(grc_w_test_file target directory why)
  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/${directory}"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/${directory}"
    GRC_W_FILE_PATH "${directory}/$<TARGET_FILE_NAME:${target}>"
    GRC_W_FILE_WHY "${why}")
  set_property(GLOBAL APPEND PROPERTY GRC_W_FILE_TARGETS "${target}")
endfunction()
