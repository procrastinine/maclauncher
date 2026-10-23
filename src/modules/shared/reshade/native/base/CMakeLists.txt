cmake_minimum_required(VERSION 3.20)
set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS deployment target")
project(reshade_macos LANGUAGES C CXX OBJCXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OBJCXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(SPIRV_CROSS_CLI OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_HLSL OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_CPP OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_C_API OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_REFLECT OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/spirv-cross EXCLUDE_FROM_ALL)
set(FX_SOURCE third_party/reshade/source)
# Generate an owned compatibility overlay; pinned third-party sources stay intact.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${FX_SOURCE}/effect_lexer.cpp")
file(READ "${FX_SOURCE}/effect_lexer.cpp" FX_LEXER_SOURCE)
string(FIND "${FX_LEXER_SOURCE}" "std::from_chars(begin, end, tok.literal_as_float);" FX_FLOAT_CALL)
if(FX_FLOAT_CALL EQUAL -1)
  message(FATAL_ERROR "ReShade float lexer changed; review the macOS compatibility overlay")
endif()
string(REPLACE "std::from_chars(begin, end, tok.literal_as_float);"
  "macfx::parseFloatLiteral(begin, end, tok.literal_as_float);" FX_LEXER_SOURCE "${FX_LEXER_SOURCE}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/effect_lexer_portable.cpp"
  "#include \"float_literal.hpp\"\n${FX_LEXER_SOURCE}")

add_library(reshadefx STATIC
  ${FX_SOURCE}/effect_expression.cpp ${CMAKE_CURRENT_BINARY_DIR}/effect_lexer_portable.cpp
  ${FX_SOURCE}/effect_parser_exp.cpp ${FX_SOURCE}/effect_parser_stmt.cpp
  ${FX_SOURCE}/effect_preprocessor.cpp ${FX_SOURCE}/effect_symbol_table.cpp
  ${FX_SOURCE}/effect_codegen_spirv.cpp src/effect.cpp)
target_include_directories(reshadefx PUBLIC ${FX_SOURCE} src PRIVATE compat
  third_party/reshade/deps/spirv/include third_party/spirv-cross)
target_compile_definitions(reshadefx PRIVATE NDEBUG)
set_source_files_properties(${FX_SOURCE}/effect_symbol_table.cpp PROPERTIES COMPILE_OPTIONS -O0)
target_link_libraries(reshadefx PUBLIC spirv-cross-glsl spirv-cross-msl)
# CPU-only resource validation; no DLL code is loaded and no GPU is created.
set(MAKO_SOURCE third_party/mako/engine)
set(MAKO_EXTRACTION ${MAKO_SOURCE}/mako-backend/src/extraction)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${MAKO_EXTRACTION}/dll_reader.cpp")
include(compat/model-cache.cmake)
set(VERSION_READER_SOURCE "${BOUNDED_READER}")
string(FIND "${VERSION_READER_SOURCE}" "constexpr uint32_t resourceDataType = 10U;" VERSION_READER_MATCH)
if(VERSION_READER_MATCH EQUAL -1)
  message(FATAL_ERROR "MAKO resource reader changed; review the version resource overlay")
endif()
string(REPLACE "constexpr uint32_t resourceDataType = 10U;" "constexpr uint32_t resourceDataType = 16U;" VERSION_READER_SOURCE "${VERSION_READER_SOURCE}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/version_resource_reader.cpp"
  "#define loadDllResourceArchive loadVersionResourceArchive\n#define extractResourcesFromDLL extractVersionResourcesFromDLL\n${VERSION_READER_SOURCE}")
# The CPU reader uses only ls::error, not MAKO's Vulkan error wrapper.
file(READ "${MAKO_SOURCE}/mako-common/include/mako-common/helpers/errors.hpp" CPU_ERRORS_HEADER)
file(READ "${MAKO_SOURCE}/mako-common/src/helpers/errors.cpp" CPU_ERRORS_SOURCE)
string(REPLACE "#include <vulkan/vulkan_core.h>" "" CPU_ERRORS_HEADER "${CPU_ERRORS_HEADER}")
string(REPLACE "#include <vulkan/vulkan_core.h>" "" CPU_ERRORS_SOURCE "${CPU_ERRORS_SOURCE}")
string(FIND "${CPU_ERRORS_HEADER}" "    /// simple vulkan error type" CPU_ERROR_START)
string(FIND "${CPU_ERRORS_HEADER}" "    /// simple error type" CPU_ERROR_END)
if(CPU_ERROR_START LESS 0 OR CPU_ERROR_END LESS CPU_ERROR_START)
  message(FATAL_ERROR "MAKO error classes changed; review the CPU-only overlay")
endif()
string(SUBSTRING "${CPU_ERRORS_HEADER}" 0 ${CPU_ERROR_START} CPU_ERROR_PREFIX)
string(SUBSTRING "${CPU_ERRORS_HEADER}" ${CPU_ERROR_END} -1 CPU_ERROR_SUFFIX)
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/mako-cpu/mako-common/helpers")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/mako-cpu/mako-common/helpers/errors.hpp" "${CPU_ERROR_PREFIX}${CPU_ERROR_SUFFIX}")
string(REPLACE "VkResult vulkan_error::error() const {\n    return this->result;\n}" "" CPU_ERRORS_SOURCE "${CPU_ERRORS_SOURCE}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/mako_cpu_errors.cpp" "${CPU_ERRORS_SOURCE}")
add_library(lossless-reader STATIC src/lossless.cpp
  ${MAKO_EXTRACTION}/dll_inspection.cpp ${CMAKE_CURRENT_BINARY_DIR}/dll_reader_bounded.cpp
  ${MAKO_EXTRACTION}/model_resources.cpp ${MAKO_EXTRACTION}/model_resource_validation.cpp
  ${MAKO_EXTRACTION}/content_hash.cpp ${CMAKE_CURRENT_BINARY_DIR}/mako_cpu_errors.cpp
  ${CMAKE_CURRENT_BINARY_DIR}/version_resource_reader.cpp)
set_target_properties(lossless-reader PROPERTIES CXX_STANDARD 20)
target_include_directories(lossless-reader PUBLIC src ${CMAKE_CURRENT_BINARY_DIR}/mako-cpu PRIVATE ${MAKO_EXTRACTION}
  ${MAKO_SOURCE}/mako-backend/include ${MAKO_SOURCE}/mako-common/include)
target_compile_definitions(lossless-reader PRIVATE st_mtim=st_mtimespec st_ctim=st_ctimespec)
add_executable(fx-compile src/compile.cpp)
target_link_libraries(fx-compile PRIVATE reshadefx lossless-reader)
add_library(reshade-diagnostics STATIC src/diagnostics.cpp)
target_include_directories(reshade-diagnostics PUBLIC src)
# Reuse MAKO's graph construction and ordering through owned Metal resources.
set(MAKO_GRAPH_SOURCES ${MAKO_SOURCE}/mako-backend/src/helpers/managed_shader.cpp ${MAKO_SOURCE}/mako-backend/src/helpers/utils.cpp)
foreach(stage mipmaps alpha0 alpha1 beta0 beta1 gamma0 gamma1 delta0 delta1 generate)
  list(APPEND MAKO_GRAPH_SOURCES ${MAKO_SOURCE}/mako-backend/src/shaderchains/${stage}.cpp)
endforeach()
add_library(mako-metal-graph STATIC ${MAKO_GRAPH_SOURCES})
set_target_properties(mako-metal-graph PROPERTIES OBJCXX_STANDARD 20)
set_source_files_properties(${MAKO_GRAPH_SOURCES} PROPERTIES LANGUAGE OBJCXX COMPILE_OPTIONS -fobjc-arc)
target_include_directories(mako-metal-graph PUBLIC compat/mako-metal ${CMAKE_CURRENT_BINARY_DIR}/mako-cpu
  ${MAKO_SOURCE}/mako-backend/src ${MAKO_SOURCE}/mako-backend/include ${MAKO_SOURCE}/mako-common/include third_party/spirv-cross)
target_link_libraries(mako-metal-graph PUBLIC lossless-reader spirv-cross-msl "-framework Foundation" "-framework Metal")
# Adaptive cadence policy uses pinned MAKO source with the shared Metal presenter.
add_library(mako-adaptive STATIC src/adaptive-pacing.cpp ${MAKO_SOURCE}/mako-render/src/adaptive_scheduler.cpp)
set_target_properties(mako-adaptive PROPERTIES CXX_STANDARD 20)
target_include_directories(mako-adaptive PUBLIC src PRIVATE ${MAKO_SOURCE}/mako-render/src ${MAKO_SOURCE}/mako-common/include)
add_subdirectory(compat/vkd3d)
include(compat/mako-ls1.cmake)
add_library(reshade-macos SHARED src/fsr1.mm src/layer-presentation.mm src/mako-spatial.mm src/ls1.mm src/presentation-api.mm src/view-presentation.mm src/graphics.mm src/presentation.mm src/lsfg.mm src/opengl-interop.mm src/opengl.mm src/metal.mm src/window.mm src/spatial.mm)
add_dependencies(reshade-macos vkd3d-shader)
target_include_directories(reshade-macos PRIVATE ${MAKO_SOURCE}/mako-render/src)
target_link_libraries(reshade-macos PRIVATE mako-adaptive mako-ls1 mako-metal-graph reshadefx reshade-diagnostics "-framework Cocoa" "-framework OpenGL" "-framework Metal" "-framework MetalFX" "-framework CoreVideo" "-framework QuartzCore" "-framework IOSurface")
set_source_files_properties(src/fsr1.mm src/layer-presentation.mm src/mako-spatial.mm src/ls1.mm src/presentation-api.mm src/view-presentation.mm src/graphics.mm src/presentation.mm src/opengl-interop.mm src/metal.mm src/window.mm src/spatial.mm PROPERTIES COMPILE_OPTIONS -fobjc-arc)
target_compile_options(reshade-macos PRIVATE -Wno-deprecated-declarations -Werror=unguarded-availability)
enable_testing()
add_executable(fx-gpu-test tests/gpu.cpp)
target_link_libraries(fx-gpu-test PRIVATE reshade-macos)
add_test(NAME metal-two-pass-resize COMMAND fx-gpu-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders)
add_test(NAME metal-crt-alpha COMMAND fx-gpu-test
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sweetfx/Shaders/SweetFX/CRT.fx
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders crt)
add_executable(fx-window-test tests/window.mm)
target_link_libraries(fx-window-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore" "-framework IOSurface")
target_compile_options(fx-window-test PRIVATE -fobjc-arc)
add_test(NAME metal-window-isolation-resize COMMAND fx-window-test)
add_test(NAME metal-scheduled-window-isolation-resize COMMAND fx-window-test scheduled)
add_test(NAME metal-scheduled-time-window-isolation-resize COMMAND fx-window-test scheduled-time)
add_test(NAME metal-scheduled-duration-window-isolation-resize COMMAND fx-window-test scheduled-duration)
add_test(NAME metal-window-surface-preservation COMMAND fx-window-test surface)
set_tests_properties(metal-window-isolation-resize metal-scheduled-window-isolation-resize metal-scheduled-time-window-isolation-resize metal-scheduled-duration-window-isolation-resize metal-window-surface-preservation PROPERTIES
  ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")
add_executable(fx-opengl-test tests/opengl.mm)
target_link_libraries(fx-opengl-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL")
target_compile_options(fx-opengl-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-pixels-state COMMAND fx-opengl-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders)
set_tests_properties(opengl-pixels-state PROPERTIES SKIP_RETURN_CODE 77 ENVIRONMENT
  "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")
add_test(NAME prepare-effect COMMAND fx-compile --prepare ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_BINARY_DIR}/prepared-test.fx)
set_tests_properties(prepare-effect PROPERTIES FIXTURES_SETUP PreparedEffect ENVIRONMENT "RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")
add_test(NAME metal-prepared-resize COMMAND fx-gpu-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders)
set_tests_properties(metal-prepared-resize PROPERTIES FIXTURES_REQUIRED PreparedEffect
  ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_PREPARED_EFFECT=${CMAKE_CURRENT_BINARY_DIR}/prepared-test.fx")
add_executable(fx-effects-test tests/effects.cpp)
target_link_libraries(fx-effects-test PRIVATE reshade-macos)
add_test(NAME metal-blend-srgb-mipmaps COMMAND fx-effects-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/render-state.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders state)
add_test(NAME metal-luma-sharpen COMMAND fx-effects-test
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sweetfx/Shaders/SweetFX/LumaSharpen.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders sharpen)
add_test(NAME metal-vibrance COMMAND fx-effects-test
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sweetfx/Shaders/SweetFX/Vibrance.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders vibrance)
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/third_party/quint/Shaders/qUINT_bloom.fx)
 add_test(NAME metal-quint-bloom COMMAND fx-effects-test
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/quint/Shaders/qUINT_bloom.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders bloom)
endif()
add_executable(fx-timing-test tests/timing.mm)
target_include_directories(fx-timing-test PRIVATE src)
target_link_libraries(fx-timing-test PRIVATE reshade-diagnostics "-framework Foundation" "-framework Metal")
target_compile_options(fx-timing-test PRIVATE -fobjc-arc)
add_test(NAME metal-gpu-timing-bounds COMMAND fx-timing-test enabled ${CMAKE_CURRENT_BINARY_DIR}/gpu-timing-test)
add_test(NAME metal-gpu-timing-disabled COMMAND fx-timing-test disabled ${CMAKE_CURRENT_BINARY_DIR}/gpu-timing-disabled)

add_executable(fx-ownership-test tests/ownership.mm)
target_include_directories(fx-ownership-test PRIVATE src)
target_link_libraries(fx-ownership-test PRIVATE reshade-macos "-framework Cocoa" "-framework QuartzCore")
target_compile_options(fx-ownership-test PRIVATE -fobjc-arc)
add_test(NAME window-ownership-lifecycle COMMAND fx-ownership-test)
set_tests_properties(window-ownership-lifecycle PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-window-state-test tests/window-state.cpp)
target_include_directories(fx-window-state-test PRIVATE src)
add_test(NAME window-state-single-publisher COMMAND fx-window-state-test)

# Check the final drawable after native presentation callbacks finish. Reading
# inside the original game buffer alone misses a second scheduled effect pass.
add_test(NAME metal-native-present-once COMMAND fx-window-test native-completed)
add_test(NAME metal-native-time-present-once COMMAND fx-window-test native-time)
add_test(NAME metal-native-duration-present-once COMMAND fx-window-test native-duration)
set_tests_properties(metal-native-present-once metal-native-time-present-once metal-native-duration-present-once PROPERTIES
  ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-float-literal-test tests/float-literal.cpp)
target_include_directories(fx-float-literal-test PRIVATE compat)
add_test(NAME float-literal-portability COMMAND fx-float-literal-test)

add_test(NAME opengl-legacy-pixels-state COMMAND fx-opengl-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders legacy)
set_tests_properties(opengl-legacy-pixels-state PROPERTIES SKIP_RETURN_CODE 77 ENVIRONMENT
  "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-opengl-recreate-test tests/opengl-recreate.mm)
target_link_libraries(fx-opengl-recreate-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL")
target_compile_options(fx-opengl-recreate-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-context-recreation COMMAND fx-opengl-recreate-test)
add_test(NAME opengl-legacy-context-recreation COMMAND fx-opengl-recreate-test legacy)
set_tests_properties(opengl-context-recreation opengl-legacy-context-recreation PROPERTIES SKIP_RETURN_CODE 77 ENVIRONMENT
  "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-surface-sync-test tests/surface-sync.mm)
target_link_libraries(fx-surface-sync-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal" "-framework IOSurface")
target_compile_options(fx-surface-sync-test PRIVATE -fobjc-arc)
add_test(NAME opengl-surface-independent-metal-queue COMMAND fx-surface-sync-test)
add_test(NAME window-surface-pending-metal-producer COMMAND fx-surface-sync-test window)
set_tests_properties(opengl-surface-independent-metal-queue window-surface-pending-metal-producer PROPERTIES TIMEOUT 15 ENVIRONMENT
  "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_LAYER_SURFACE=1")

add_executable(fx-opengl-threaded-test tests/opengl-threaded.mm)
target_link_libraries(fx-opengl-threaded-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL")
target_compile_options(fx-opengl-threaded-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-threaded-window-updates COMMAND fx-opengl-threaded-test)
add_test(NAME opengl-legacy-threaded-window-updates COMMAND fx-opengl-threaded-test legacy)
set_tests_properties(opengl-threaded-window-updates opengl-legacy-threaded-window-updates PROPERTIES
    TIMEOUT 20 SKIP_RETURN_CODE 77
    ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_WINDOW_TITLE=Filtered")

set_property(TEST opengl-threaded-window-updates opengl-legacy-threaded-window-updates APPEND PROPERTY ENVIRONMENT "RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")

add_executable(fx-diagnostics-test tests/diagnostics.cpp)
target_link_libraries(fx-diagnostics-test PRIVATE reshade-diagnostics)
foreach(mode disabled enabled bounded gpu-output)
  add_test(NAME diagnostics-${mode} COMMAND fx-diagnostics-test ${mode} ${CMAKE_CURRENT_BINARY_DIR}/diagnostics-${mode})
  set_tests_properties(diagnostics-${mode} PROPERTIES TIMEOUT 10)
endforeach()

add_executable(fx-opengl-timing-test tests/opengl-timing.cpp)
target_include_directories(fx-opengl-timing-test PRIVATE src)
target_compile_options(fx-opengl-timing-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-timing-asynchronous COMMAND fx-opengl-timing-test)
set_tests_properties(opengl-timing-asynchronous PROPERTIES TIMEOUT 10)

add_executable(fx-opengl-owner-cache-test tests/opengl-owner-cache.mm)
target_include_directories(fx-opengl-owner-cache-test PRIVATE src)
target_link_libraries(fx-opengl-owner-cache-test PRIVATE reshade-macos "-framework Cocoa")
target_compile_options(fx-opengl-owner-cache-test PRIVATE -fobjc-arc)
add_test(NAME opengl-ownership-view-binding COMMAND fx-opengl-owner-cache-test)
set_tests_properties(opengl-ownership-view-binding PROPERTIES TIMEOUT 15 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-opengl-single-test tests/opengl-single.mm)
target_link_libraries(fx-opengl-single-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL")
target_compile_options(fx-opengl-single-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-single-rgb-alpha COMMAND fx-opengl-single-test)
add_test(NAME opengl-single-partial-discard COMMAND fx-opengl-single-test)
add_test(NAME opengl-single-msaa-fallback COMMAND fx-opengl-single-test msaa)
set_tests_properties(opengl-single-rgb-alpha opengl-single-partial-discard opengl-single-msaa-fallback PROPERTIES
    TIMEOUT 15 SKIP_RETURN_CODE 77
    ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/single-preserve.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")
set_property(TEST opengl-single-partial-discard APPEND PROPERTY ENVIRONMENT "RESHADE_TECHNIQUE=PartialDiscard")

foreach(mode 1 copy setup)
    add_test(NAME opengl-diagnostics-passthrough-${mode} COMMAND fx-opengl-single-test)
    set_tests_properties(opengl-diagnostics-passthrough-${mode} PROPERTIES TIMEOUT 15 SKIP_RETURN_CODE 77
        ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/single-preserve.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/diagnostic-opengl-${mode};RESHADE_DIAGNOSTICS_OPENGL_PASSTHROUGH=${mode}")
endforeach()

add_executable(fx-spatial-test tests/spatial.mm)
target_include_directories(fx-spatial-test PRIVATE src)
target_link_libraries(fx-spatial-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal" "-framework MetalFX")
target_compile_options(fx-spatial-test PRIVATE -fobjc-arc)
add_test(NAME metal-spatial-output-lifetime COMMAND fx-spatial-test)
set_tests_properties(metal-spatial-output-lifetime PROPERTIES TIMEOUT 30)

add_test(NAME opengl-core-metal-pixels-state COMMAND fx-opengl-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders)
add_test(NAME opengl-core-metal-context-recreation COMMAND fx-opengl-recreate-test)
add_test(NAME opengl-core-metal-threaded COMMAND fx-opengl-threaded-test)
add_test(NAME opengl-core-metal-single-alpha COMMAND fx-opengl-single-test)
foreach(name pixels-state context-recreation threaded single-alpha)
  set(effect two-pass)
  if(name STREQUAL "single-alpha")
    set(effect single-preserve)
  endif()
  set_tests_properties(opengl-core-metal-${name} PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77
    ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/${effect}.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/core-metal-${name};RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT=metal")
endforeach()

add_executable(fx-frame-test tests/frame.mm)
target_include_directories(fx-frame-test PRIVATE src)
target_link_libraries(fx-frame-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal")
target_compile_options(fx-frame-test PRIVATE -fobjc-arc)
add_test(NAME metal-shared-frame-source-output COMMAND fx-frame-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders ${CMAKE_CURRENT_SOURCE_DIR}/tests/single-preserve.fx)
set_tests_properties(metal-shared-frame-source-output PROPERTIES TIMEOUT 30)

add_test(NAME opengl-corevideo-pixels-state COMMAND fx-opengl-test
  ${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx ${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders)
add_test(NAME opengl-corevideo-context-recreation COMMAND fx-opengl-recreate-test)
add_test(NAME opengl-corevideo-threaded COMMAND fx-opengl-threaded-test)
add_test(NAME opengl-corevideo-single-alpha COMMAND fx-opengl-single-test)
add_test(NAME opengl-corevideo-partial-discard COMMAND fx-opengl-single-test)
add_test(NAME opengl-corevideo-msaa COMMAND fx-opengl-single-test msaa)
foreach(name pixels-state context-recreation threaded single-alpha partial-discard msaa)
  set(effect two-pass)
  if(name STREQUAL "single-alpha" OR name STREQUAL "partial-discard" OR name STREQUAL "msaa")
    set(effect single-preserve)
  endif()
  set_tests_properties(opengl-corevideo-${name} PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77
    ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/${effect}.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/corevideo-${name};RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT=corevideo")
endforeach()
set_property(TEST opengl-corevideo-partial-discard APPEND PROPERTY ENVIRONMENT "RESHADE_TECHNIQUE=PartialDiscard")

add_executable(fx-opengl-sequence-test tests/opengl-sequence.mm)
target_link_libraries(fx-opengl-sequence-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL")
target_compile_options(fx-opengl-sequence-test PRIVATE -Wno-deprecated-declarations)
add_test(NAME opengl-corevideo-frame-sequence COMMAND fx-opengl-sequence-test)
set_tests_properties(opengl-corevideo-frame-sequence PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77
  ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/corevideo-sequence;RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT=corevideo")

add_executable(fx-lossless-reader-test ${MAKO_SOURCE}/mako-backend/tests/dll_inspection_tests.cpp)
set_target_properties(fx-lossless-reader-test PROPERTIES CXX_STANDARD 20)
target_include_directories(fx-lossless-reader-test BEFORE PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/mako-cpu ${MAKO_SOURCE}/mako-backend/include ${MAKO_SOURCE}/mako-backend/src ${MAKO_SOURCE}/mako-common/include)
target_link_libraries(fx-lossless-reader-test PRIVATE lossless-reader)
add_test(NAME lossless-resource-validation COMMAND fx-lossless-reader-test)
set_tests_properties(lossless-resource-validation PROPERTIES TIMEOUT 30)
add_executable(fx-lossless-version-test tests/lossless-version.cpp)
target_include_directories(fx-lossless-version-test PRIVATE src)
add_test(NAME lossless-version-metadata COMMAND fx-lossless-version-test)
target_include_directories(fx-window-test PRIVATE src)
add_test(NAME metal-explicit-host-single-application COMMAND fx-window-test explicit)
set_tests_properties(metal-explicit-host-single-application PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

set_source_files_properties(src/lsfg.mm PROPERTIES COMPILE_OPTIONS "-fobjc-arc;-std=c++20")
add_executable(fx-lsfg-test tests/lsfg.mm)
target_include_directories(fx-lsfg-test PRIVATE src)
target_link_libraries(fx-lsfg-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal")
target_compile_options(fx-lsfg-test PRIVATE -fobjc-arc)
# Licensed model resources are supplied explicitly, never portable test data.
set(LOSSLESS_TEST_DLL "" CACHE FILEPATH "Local model file for optional GPU graph tests")
if(LOSSLESS_TEST_DLL)
 foreach(precision fp16 fp32)
  foreach(mode quality performance)
   add_test(NAME metal-lsfg-${precision}-${mode} COMMAND fx-lsfg-test "${LOSSLESS_TEST_DLL}" ${precision} ${mode} 2 1)
   set_tests_properties(metal-lsfg-${precision}-${mode} PROPERTIES TIMEOUT 30)
  endforeach()
 endforeach()
 add_test(NAME metal-lsfg-five-times-flow COMMAND fx-lsfg-test "${LOSSLESS_TEST_DLL}" fp16 performance 5 0.5)
 set_tests_properties(metal-lsfg-five-times-flow PROPERTIES TIMEOUT 30)
endif()

add_executable(fx-presentation-test tests/presentation.mm)
target_include_directories(fx-presentation-test PRIVATE src)
target_link_libraries(fx-presentation-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-presentation-test PRIVATE -fobjc-arc)
add_test(NAME metal-presentation-current-frame COMMAND fx-presentation-test)
set_tests_properties(metal-presentation-current-frame PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")
if(LOSSLESS_TEST_DLL)
 add_test(NAME metal-presentation-generated-frames COMMAND fx-presentation-test generation "${LOSSLESS_TEST_DLL}")
 set_tests_properties(metal-presentation-generated-frames PROPERTIES TIMEOUT 30)
endif()

add_executable(fx-metal4-test tests/metal4.mm)
target_link_libraries(fx-metal4-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-metal4-test PRIVATE -fobjc-arc -Werror=unguarded-availability)
foreach(mode direct time duration descriptor)
  add_test(NAME metal4-${mode}-producer-isolation-resize COMMAND fx-metal4-test ${mode})
  set_tests_properties(metal4-${mode}-producer-isolation-resize PROPERTIES TIMEOUT 30 SKIP_RETURN_CODE 77 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")
endforeach()

# Shared launch configuration validation does not create a GPU device.
add_executable(fx-graphics-config-test tests/graphics.mm src/graphics.mm)
target_include_directories(fx-graphics-config-test PRIVATE src)
target_link_libraries(fx-graphics-config-test PRIVATE "-framework Foundation" "-framework Metal")
target_compile_options(fx-graphics-config-test PRIVATE -fobjc-arc)
add_test(NAME graphics-configuration-validation COMMAND fx-graphics-config-test)

add_executable(fx-view-presentation-test tests/view-presentation.mm)
target_include_directories(fx-view-presentation-test PRIVATE src)
target_link_libraries(fx-view-presentation-test PRIVATE reshade-macos "-framework Cocoa" "-framework OpenGL" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-view-presentation-test PRIVATE -fobjc-arc -Wno-deprecated-declarations)
add_test(NAME opengl-owned-view-presentation COMMAND fx-view-presentation-test)
set_tests_properties(opengl-owned-view-presentation PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/overlay-test;RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT=overlay")

add_executable(fx-presentation-api-test tests/presentation-api.mm)
target_include_directories(fx-presentation-api-test PRIVATE src)
target_link_libraries(fx-presentation-api-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-presentation-api-test PRIVATE -fobjc-arc)
add_test(NAME metal-presentation-c-api-disabled-exact COMMAND fx-presentation-api-test off)
set_tests_properties(metal-presentation-c-api-disabled-exact PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_SPATIAL_METHOD=off")
add_test(NAME metal-presentation-c-api-flip-resize-lifetime COMMAND fx-presentation-api-test flip)
set_tests_properties(metal-presentation-c-api-flip-resize-lifetime PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_SPATIAL_METHOD=metalfx;RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")

add_test(NAME opengl-legacy-owned-view-presentation COMMAND fx-view-presentation-test legacy)
set_tests_properties(opengl-legacy-owned-view-presentation PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered;RESHADE_DIAGNOSTICS=${CMAKE_CURRENT_BINARY_DIR}/legacy-overlay-test;RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT=overlay")

add_test(NAME opengl-owned-view-graphics-only COMMAND fx-view-presentation-test)
add_test(NAME opengl-legacy-owned-view-graphics-only COMMAND fx-view-presentation-test legacy)
set_tests_properties(opengl-owned-view-graphics-only opengl-legacy-owned-view-graphics-only PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-metal-presentation-test tests/metal-presentation.mm)
target_include_directories(fx-metal-presentation-test PRIVATE src)
target_link_libraries(fx-metal-presentation-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-metal-presentation-test PRIVATE -fobjc-arc)
add_test(NAME metal-automatic-spatial-native-output COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-spatial-native-output PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=metalfx;RESHADE_WINDOW_TITLE=Filtered")
add_test(NAME metal-automatic-effects-spatial-native-output COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-effects-spatial-native-output PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=metalfx;RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

add_executable(fx-ls1-test tests/ls1.mm)
target_include_directories(fx-ls1-test PRIVATE src)
target_link_libraries(fx-ls1-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal")
target_compile_options(fx-ls1-test PRIVATE -fobjc-arc)
if(LOSSLESS_TEST_DLL)
 add_test(NAME metal-ls1-all-models-lifetimes COMMAND fx-ls1-test "${LOSSLESS_TEST_DLL}")
 set_tests_properties(metal-ls1-all-models-lifetimes PROPERTIES TIMEOUT 30 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1")
endif()

add_executable(fx-ls1-translation-test tests/ls1-translation.cpp)
target_include_directories(fx-ls1-translation-test PRIVATE ${MAKO_SOURCE}/mako-backend/include)
target_link_libraries(fx-ls1-translation-test PRIVATE mako-ls1)
add_dependencies(fx-ls1-translation-test vkd3d-shader)
if(LOSSLESS_TEST_DLL)
 add_test(NAME lossless-ls1-adjacent-translation COMMAND fx-ls1-translation-test "${LOSSLESS_TEST_DLL}")
 set_tests_properties(lossless-ls1-adjacent-translation PROPERTIES TIMEOUT 15)
endif()

add_executable(fx-model-cache-test tests/model-cache.cpp)
target_include_directories(fx-model-cache-test PRIVATE ${MAKO_EXTRACTION})
target_link_libraries(fx-model-cache-test PRIVATE lossless-reader)
if(LOSSLESS_TEST_DLL)
 add_test(NAME lossless-model-cache-bounds COMMAND fx-model-cache-test "${LOSSLESS_TEST_DLL}")
 set_tests_properties(lossless-model-cache-bounds PROPERTIES TIMEOUT 15)
endif()

add_test(NAME metal-automatic-mako-native-output COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-mako-native-output PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=mako;RESHADE_WINDOW_TITLE=Filtered")
if(LOSSLESS_TEST_DLL)
 add_test(NAME metal-automatic-ls1-native-output COMMAND fx-metal-presentation-test)
 set_tests_properties(metal-automatic-ls1-native-output PROPERTIES TIMEOUT 30 ENVIRONMENT "RESHADE_SPATIAL_METHOD=ls1;RESHADE_LOSSLESS_MODEL=${LOSSLESS_TEST_DLL};RESHADE_WINDOW_TITLE=Filtered")
endif()

add_executable(fx-owner-lifetime-test tests/owner-lifetime.mm)
target_include_directories(fx-owner-lifetime-test PRIVATE src)
target_link_libraries(fx-owner-lifetime-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore" "-framework IOSurface")
target_compile_options(fx-owner-lifetime-test PRIVATE -fobjc-arc)
add_test(NAME metal-owner-resource-lifetime COMMAND fx-owner-lifetime-test)
set_tests_properties(metal-owner-resource-lifetime PROPERTIES TIMEOUT 15 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")

add_executable(fx-log-test tests/log.cpp)
target_include_directories(fx-log-test PRIVATE src)
add_test(NAME native-log-bounded COMMAND fx-log-test "${CMAKE_CURRENT_BINARY_DIR}/native-log-test")

add_test(NAME metal-scheduled-bounded-producer COMMAND fx-window-test scheduled-bounded)
set_tests_properties(metal-scheduled-bounded-producer PROPERTIES TIMEOUT 15 ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

add_test(NAME metal-automatic-backpressure-recovery COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-backpressure-recovery PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=metalfx;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_BACKPRESSURE=1")

add_test(NAME opengl-low-dpi-native-output COMMAND fx-view-presentation-test)
add_test(NAME opengl-legacy-low-dpi-native-output COMMAND fx-view-presentation-test legacy)
set_tests_properties(opengl-low-dpi-native-output opengl-legacy-low-dpi-native-output PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77 ENVIRONMENT "RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_LOW_DPI=1")

add_executable(fx-remote-presentation-test tests/remote-presentation.mm)
target_include_directories(fx-remote-presentation-test PRIVATE src)
target_link_libraries(fx-remote-presentation-test PRIVATE reshade-macos "-framework Cocoa" "-framework QuartzCore" "-framework Metal" "-framework IOSurface")
target_compile_options(fx-remote-presentation-test PRIVATE -fobjc-arc)
add_test(NAME remote-common-spatial-source-reuse COMMAND fx-remote-presentation-test)
add_test(NAME remote-common-effects-spatial-source-reuse COMMAND fx-remote-presentation-test)
set_tests_properties(remote-common-spatial-source-reuse remote-common-effects-spatial-source-reuse PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77 ENVIRONMENT "RESHADE_LAYER_SURFACE=1;RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered")
set_property(TEST remote-common-effects-spatial-source-reuse APPEND PROPERTY ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")

add_test(NAME metal-presentation-zero-time-dropped COMMAND fx-presentation-test)
set_tests_properties(metal-presentation-zero-time-dropped PROPERTIES ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_TEST_PRESENTED_ZERO=1" TIMEOUT 20)
add_test(NAME metal-presentation-duplicate-time-dropped COMMAND fx-presentation-test)
set_tests_properties(metal-presentation-duplicate-time-dropped PROPERTIES ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_TEST_PRESENTED_DUPLICATE=1" TIMEOUT 20)

# Automatic scaling has no work when publisher pixels already match output.
# Repeated source/output changes must release and recreate the owned surface.
add_test(NAME metal-automatic-scaling-passthrough-transitions COMMAND fx-metal-presentation-test)
add_test(NAME metal-automatic-shader-equal-extents COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-scaling-passthrough-transitions metal-automatic-shader-equal-extents PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_TRANSITIONS=1")
set_property(TEST metal-automatic-shader-equal-extents APPEND PROPERTY ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")
add_test(NAME opengl-scaling-passthrough-transitions COMMAND fx-view-presentation-test)
add_test(NAME opengl-legacy-scaling-passthrough-transitions COMMAND fx-view-presentation-test legacy)
set_tests_properties(opengl-scaling-passthrough-transitions opengl-legacy-scaling-passthrough-transitions PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77 ENVIRONMENT "RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_TRANSITIONS=1")

add_test(NAME remote-scaling-passthrough-transitions COMMAND fx-remote-presentation-test)
add_test(NAME remote-shader-equal-extents COMMAND fx-remote-presentation-test)
set_tests_properties(remote-scaling-passthrough-transitions remote-shader-equal-extents PROPERTIES TIMEOUT 20 SKIP_RETURN_CODE 77 ENVIRONMENT "RESHADE_LAYER_SURFACE=1;RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_TRANSITIONS=1")
set_property(TEST remote-shader-equal-extents APPEND PROPERTY ENVIRONMENT "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")

add_test(NAME metal-scheduled-scaling-passthrough-transitions COMMAND fx-metal-presentation-test)
set_tests_properties(metal-scheduled-scaling-passthrough-transitions PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=bilinear;RESHADE_WINDOW_TITLE=Filtered;RESHADE_TEST_TRANSITIONS=1;RESHADE_TEST_SCHEDULED=1")

# Pure cadence and bounded delivery checks do not initialize a GPU.
add_executable(fx-adaptive-policy-test tests/adaptive-pacing.cpp)
target_link_libraries(fx-adaptive-policy-test PRIVATE mako-adaptive)
add_test(NAME adaptive-policy-source-delivery-separation COMMAND fx-adaptive-policy-test)
add_executable(fx-adaptive-delivery-test tests/adaptive-delivery.cpp)
target_include_directories(fx-adaptive-delivery-test PRIVATE src)
add_test(NAME adaptive-delivery-bounded-real-priority COMMAND fx-adaptive-delivery-test)
add_executable(fx-lsfg-variable-test tests/lsfg-variable.mm)
target_include_directories(fx-lsfg-variable-test PRIVATE src)
target_link_libraries(fx-lsfg-variable-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal")
target_compile_options(fx-lsfg-variable-test PRIVATE -fobjc-arc)
add_executable(fx-adaptive-presentation-test tests/adaptive-presentation.mm)
target_include_directories(fx-adaptive-presentation-test PRIVATE src)
target_link_libraries(fx-adaptive-presentation-test PRIVATE reshade-macos "-framework Cocoa" "-framework Metal" "-framework QuartzCore")
target_compile_options(fx-adaptive-presentation-test PRIVATE -fobjc-arc)
if(LOSSLESS_TEST_DLL)
 foreach(precision fp16 fp32)
  foreach(mode quality performance)
   add_test(NAME metal-lsfg-variable-${precision}-${mode} COMMAND fx-lsfg-variable-test "${LOSSLESS_TEST_DLL}" ${precision} ${mode})
   set_tests_properties(metal-lsfg-variable-${precision}-${mode} PROPERTIES TIMEOUT 25 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1")
  endforeach()
 endforeach()
 add_test(NAME metal-adaptive-presentation-lifecycle COMMAND fx-adaptive-presentation-test generation "${LOSSLESS_TEST_DLL}")
 set_tests_properties(metal-adaptive-presentation-lifecycle PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1")
 add_test(NAME metal-fixed-presentation-lifecycle COMMAND fx-adaptive-presentation-test generation "${LOSSLESS_TEST_DLL}")
 set_tests_properties(metal-fixed-presentation-lifecycle PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_TEST_FIXED_PACING=1")
endif()

# Automatic hooks retain exact resources used by borrowed Metal command buffers.
add_executable(fx-command-resources-test tests/command-resources.mm)
target_include_directories(fx-command-resources-test PRIVATE src)
target_compile_options(fx-command-resources-test PRIVATE -fobjc-arc)
target_link_libraries(fx-command-resources-test PRIVATE "-framework Foundation" "-framework Metal")
add_test(NAME metal-borrowed-resource-bounds COMMAND fx-command-resources-test)
add_test(NAME metal-native-unretained-owner-teardown COMMAND fx-window-test native-unretained)
set_tests_properties(metal-borrowed-resource-bounds metal-native-unretained-owner-teardown PROPERTIES TIMEOUT 20)
set_tests_properties(metal-native-unretained-owner-teardown PROPERTIES ENVIRONMENT
 "RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders;RESHADE_WINDOW_TITLE=Filtered")

# AMD FSR1 uses checked-in SPIR-V and the shared Metal spatial encoder.
target_include_directories(reshade-macos PRIVATE third_party/fsr/ffx-fsr compat/fsr)
add_executable(fx-fsr1-test tests/fsr1.mm)
set_target_properties(fx-fsr1-test PROPERTIES OBJCXX_STANDARD 20)
target_include_directories(fx-fsr1-test PRIVATE src tests)
target_compile_options(fx-fsr1-test PRIVATE -fobjc-arc)
target_link_libraries(fx-fsr1-test PRIVATE reshade-macos "-framework Foundation" "-framework Metal")
add_test(NAME metal-fsr1-pixels-ownership COMMAND fx-fsr1-test)
add_executable(fx-fsr1-budget-test tests/fsr1-budget.cpp)
set_target_properties(fx-fsr1-budget-test PROPERTIES CXX_STANDARD 20)
target_include_directories(fx-fsr1-budget-test PRIVATE src)
add_test(NAME fsr1-global-scratch-budget COMMAND fx-fsr1-budget-test)

add_test(NAME metal-automatic-fsr1-native-output COMMAND fx-metal-presentation-test)
set_tests_properties(metal-automatic-fsr1-native-output PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_SPATIAL_METHOD=fsr1;RESHADE_WINDOW_TITLE=Filtered")
add_test(NAME metal-presentation-c-api-fsr1-flip-resize-lifetime COMMAND fx-presentation-api-test flip)
set_tests_properties(metal-presentation-c-api-fsr1-flip-resize-lifetime PROPERTIES TIMEOUT 20 ENVIRONMENT "RESHADE_EXPLICIT_HOST=1;RESHADE_SPATIAL_METHOD=fsr1;RESHADE_EFFECT=${CMAKE_CURRENT_SOURCE_DIR}/tests/two-pass.fx;RESHADE_INCLUDE_PATH=${CMAKE_CURRENT_SOURCE_DIR}/third_party/reshade-shaders/Shaders")