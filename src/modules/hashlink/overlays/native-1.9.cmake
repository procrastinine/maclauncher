cmake_minimum_required(VERSION 3.20)
project(HashLink19MacNative C)
if(NOT HASHLINK_SDL_LIBRARY OR NOT EXISTS "${HASHLINK_SDL_LIBRARY}")
  message(FATAL_ERROR "A pinned x86_64 SDL2 static library is required")
endif()
if(NOT HASHLINK_OPENAL_LIBRARY OR NOT EXISTS "${HASHLINK_OPENAL_LIBRARY}" OR NOT HASHLINK_OPENAL_INCLUDE)
  message(FATAL_ERROR "A pinned x86_64 OpenAL-soft library and headers are required")
endif()
set(CMAKE_OSX_ARCHITECTURES x86_64)
set(CMAKE_OSX_DEPLOYMENT_TARGET 13.0)
set(CMAKE_C_STANDARD 11)
add_compile_options(-Wno-deprecated-declarations)
add_compile_definitions(SIZEOF_SIZE_T=8)
add_library(hl SHARED IMPORTED)
set_target_properties(hl PROPERTIES IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/libhl.dylib")
include_directories(src include/png include/vorbis include/turbojpeg include/mikktspace include/minimp3)
add_library(fmt MODULE
  include/turbojpeg/jdatadst-tj.c include/turbojpeg/jdatasrc-tj.c libs/fmt/fmt.c
  libs/fmt/sha1.c libs/fmt/mikkt.c include/mikktspace/mikktspace.c
  include/png/png.c include/png/pngerror.c include/png/pngget.c
  include/png/pngmem.c include/png/pngpread.c include/png/pngread.c
  include/png/pngrio.c include/png/pngrtran.c include/png/pngrutil.c
  include/png/pngset.c include/png/pngtrans.c include/png/pngwio.c
  include/png/pngwrite.c include/png/pngwtran.c include/png/pngwutil.c
  include/vorbis/bitrate.c include/vorbis/bitwise.c include/vorbis/block.c
  include/vorbis/codebook.c include/vorbis/envelope.c include/vorbis/floor0.c
  include/vorbis/floor1.c include/vorbis/framing.c include/vorbis/info.c
  include/vorbis/lookup.c include/vorbis/lpc.c include/vorbis/lsp.c
  include/vorbis/mapping0.c include/vorbis/mdct.c include/vorbis/psy.c
  include/vorbis/registry.c include/vorbis/res0.c include/vorbis/sharedbook.c
  include/vorbis/smallft.c include/vorbis/synthesis.c include/vorbis/vorbisfile.c
  include/vorbis/window.c include/turbojpeg/jaricom.c include/turbojpeg/jcapimin.c
  include/turbojpeg/jcapistd.c include/turbojpeg/jcarith.c include/turbojpeg/jccoefct.c
  include/turbojpeg/jccolor.c include/turbojpeg/jcdctmgr.c include/turbojpeg/jchuff.c
  include/turbojpeg/jcinit.c include/turbojpeg/jcmainct.c include/turbojpeg/jcmarker.c
  include/turbojpeg/jcmaster.c include/turbojpeg/jcomapi.c include/turbojpeg/jcparam.c
  include/turbojpeg/jcphuff.c include/turbojpeg/jcprepct.c include/turbojpeg/jcsample.c
  include/turbojpeg/jctrans.c include/turbojpeg/jdapimin.c include/turbojpeg/jdapistd.c
  include/turbojpeg/jdarith.c include/turbojpeg/jdatadst.c include/turbojpeg/jdatasrc.c
  include/turbojpeg/jdcoefct.c include/turbojpeg/jdcolor.c include/turbojpeg/jddctmgr.c
  include/turbojpeg/jdhuff.c include/turbojpeg/jdinput.c include/turbojpeg/jdmainct.c
  include/turbojpeg/jdmarker.c include/turbojpeg/jdmaster.c include/turbojpeg/jdmerge.c
  include/turbojpeg/jdphuff.c include/turbojpeg/jdpostct.c include/turbojpeg/jdsample.c
  include/turbojpeg/jdtrans.c include/turbojpeg/jerror.c include/turbojpeg/jfdctflt.c
  include/turbojpeg/jfdctfst.c include/turbojpeg/jfdctint.c include/turbojpeg/jidctflt.c
  include/turbojpeg/jidctfst.c include/turbojpeg/jidctint.c include/turbojpeg/jidctred.c
  include/turbojpeg/jmemmgr.c include/turbojpeg/jmemnobs.c include/turbojpeg/jquant1.c
  include/turbojpeg/jquant2.c include/turbojpeg/jutils.c include/turbojpeg/transupp.c
  include/turbojpeg/turbojpeg.c include/turbojpeg/jsimd_none.c
)
set_target_properties(fmt PROPERTIES PREFIX "" SUFFIX ".hdll" LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(fmt PRIVATE hl z m)
add_library(sdl MODULE libs/sdl/sdl.c libs/sdl/gl.c)
set_target_properties(sdl PROPERTIES PREFIX "" SUFFIX ".hdll" LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(sdl PRIVATE include)
target_link_libraries(sdl PRIVATE hl "${HASHLINK_SDL_LIBRARY}" "-framework OpenGL" "-framework Cocoa" "-framework IOKit" "-framework ForceFeedback" "-framework Carbon" "-framework CoreAudio" "-framework AudioToolbox" "-framework CoreVideo" "-framework Metal" "-framework CoreFoundation" "-framework Foundation" "-framework AVFoundation" "-framework GameController" "-framework CoreHaptics" "-framework QuartzCore" iconv)
add_library(openal MODULE libs/openal/openal.c)
set_target_properties(openal PROPERTIES PREFIX "" SUFFIX ".hdll" LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(openal PRIVATE openal_soft)
target_include_directories(openal PRIVATE "${HASHLINK_OPENAL_INCLUDE}")
target_link_libraries(openal PRIVATE hl "${HASHLINK_OPENAL_LIBRARY}")
