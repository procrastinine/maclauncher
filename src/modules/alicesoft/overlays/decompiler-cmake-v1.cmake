cmake_minimum_required(VERSION 3.16)
project(maclauncher_alicesoft_decompiler LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
include_directories(common)

# Select only the pinned decompiler and its actual common sources. Image tools,
# compilers, documentation generators and their unused dependencies stay out.
if(MACLAUNCHER_TOOL STREQUAL "sys3dc")
  add_executable(sys3dc
    common/ag00.c common/dri.c common/container.c common/game_id.c
    common/sjisutf.c common/util.c
    decompiler/cali.c decompiler/decompile.c decompiler/sys3dc.c)
elseif(MACLAUNCHER_TOOL STREQUAL "xsys35dc")
  add_executable(xsys35dc
    common/ald.c common/container.c common/sjisutf.c common/util.c
    decompiler/ain.c decompiler/cali.c decompiler/debuginfo.c decompiler/decompile.c
    decompiler/preprocess.c decompiler/xsys35dc.c)
  target_compile_definitions(xsys35dc PRIVATE VERSION="${MACLAUNCHER_TOOL_VERSION}")
else()
  message(FATAL_ERROR "Choose an explicitly reviewed decompiler target")
endif()
