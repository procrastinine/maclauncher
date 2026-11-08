# glslang 16.6.0; runner builds the compiler from an exact public source pin.
find_program(FSR_NODE_EXECUTABLE node REQUIRED)
set(FSR_GLSLANG_EXECUTABLE "" CACHE FILEPATH "Existing glslang 16.6.0 host compiler")
if(FSR_GLSLANG_EXECUTABLE)
  set(FSR_COMPILER "${FSR_GLSLANG_EXECUTABLE}")
  set(FSR_COMPILER_DEP "${FSR_GLSLANG_EXECUTABLE}")
else()
  include(FetchContent)
  set(ENABLE_OPT OFF CACHE BOOL "" FORCE)
  set(ENABLE_GLSLANG_BINARIES ON CACHE BOOL "" FORCE)
  set(GLSLANG_TESTS OFF CACHE BOOL "" FORCE)
  set(BUILD_EXTERNAL OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(fsr_glslang
    GIT_REPOSITORY https://github.com/KhronosGroup/glslang.git
    GIT_TAG e1b562a8bed273a02f30b59b66a5d499793cede5
    GIT_SUBMODULES "")
  FetchContent_MakeAvailable(fsr_glslang)
  set(FSR_COMPILER "$<TARGET_FILE:glslang-standalone>")
  set(FSR_COMPILER_DEP glslang-standalone)
endif()
set(FSR_GENERATED "${CMAKE_CURRENT_BINARY_DIR}/generated/fsr")
add_custom_command(OUTPUT "${FSR_GENERATED}/fsr1-shaders.hpp"
  COMMAND "${FSR_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/compat/fsr/generate.mjs"
    --glslang "${FSR_COMPILER}" --output "${FSR_GENERATED}"
  DEPENDS ${FSR_COMPILER_DEP} compat/fsr/generate.mjs compat/fsr/fsr.comp compat/fsr/fsr1-shaders.json
    third_party/fsr/ffx-fsr/ffx_fsr1.h third_party/fsr/ffx-fsr/ffx_a.h
  VERBATIM)
add_custom_target(fsr1-shaders DEPENDS "${FSR_GENERATED}/fsr1-shaders.hpp")
add_dependencies(reshade-macos fsr1-shaders)
target_include_directories(reshade-macos PRIVATE "${FSR_GENERATED}")
