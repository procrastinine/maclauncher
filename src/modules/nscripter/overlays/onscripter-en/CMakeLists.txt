cmake_minimum_required(VERSION 3.20)
project(MacLauncherONScripterEN LANGUAGES C CXX OBJCXX)

# The upstream checkout stays read-only. This build uses its published source
# and codec sources, plus SDL12-compat's maintained Cocoa/SDL2 implementation.
if(NOT ONS_SOURCE OR NOT SDL12_PREFIX)
  message(FATAL_ERROR "ONS_SOURCE and SDL12_PREFIX are required")
endif()
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(EXTERNAL "${ONS_SOURCE}/extlib/src")
include_directories("${ONS_SOURCE}" "${ONS_SOURCE}/macosx" "${SDL12_PREFIX}/include/SDL")
add_compile_options(-Wno-deprecated-declarations)
find_library(SDL12_LIBRARY NAMES SDL PATHS "${SDL12_PREFIX}/lib" NO_DEFAULT_PATH REQUIRED)
find_library(SDL12_MAIN NAMES SDLmain PATHS "${SDL12_PREFIX}/lib" NO_DEFAULT_PATH REQUIRED)

function(vendor_library target directory)
  set(files ${ARGN})
  list(TRANSFORM files PREPEND "${EXTERNAL}/${directory}/")
  add_library(${target} STATIC ${files})
  target_include_directories(${target} PUBLIC "${EXTERNAL}/${directory}")
endfunction()

file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/generated/ogg")
file(WRITE "${CMAKE_BINARY_DIR}/generated/ogg/config_types.h"
  "#include <stdint.h>\ntypedef int16_t ogg_int16_t;\ntypedef uint16_t ogg_uint16_t;\ntypedef int32_t ogg_int32_t;\ntypedef uint32_t ogg_uint32_t;\ntypedef int64_t ogg_int64_t;\ntypedef uint64_t ogg_uint64_t;\n")
vendor_library(ogg libogg-1.3.5 src/framing.c src/bitwise.c)
target_include_directories(ogg PUBLIC "${CMAKE_BINARY_DIR}/generated" "${EXTERNAL}/libogg-1.3.5/include")
vendor_library(vorbis libvorbis-1.3.7 lib/mdct.c lib/smallft.c lib/block.c lib/envelope.c lib/window.c lib/lsp.c
  lib/lpc.c lib/analysis.c lib/synthesis.c lib/psy.c lib/info.c lib/floor1.c lib/floor0.c lib/res0.c lib/mapping0.c
  lib/registry.c lib/codebook.c lib/sharedbook.c lib/lookup.c lib/bitrate.c lib/vorbisfile.c)
target_include_directories(vorbis PUBLIC "${EXTERNAL}/libvorbis-1.3.7/include")
target_link_libraries(vorbis PUBLIC ogg)

configure_file("${ONS_SOURCE}/macosx/jconfig.h" "${CMAKE_BINARY_DIR}/generated/jconfig.h" COPYONLY)
vendor_library(jpeg jpeg-9f jaricom.c jcapimin.c jcapistd.c jcarith.c jccoefct.c jccolor.c jcdctmgr.c jchuff.c jcinit.c
  jcmainct.c jcmarker.c jcmaster.c jcomapi.c jcparam.c jcprepct.c jcsample.c jctrans.c jdapimin.c jdapistd.c jdarith.c
  jdatadst.c jdatasrc.c jdcoefct.c jdcolor.c jddctmgr.c jdhuff.c jdinput.c jdmainct.c jdmarker.c jdmaster.c jdmerge.c
  jdpostct.c jdsample.c jdtrans.c jerror.c jfdctflt.c jfdctfst.c jfdctint.c jidctflt.c jidctfst.c jidctint.c jquant1.c
  jquant2.c jutils.c jmemmgr.c jmemnobs.c)
target_include_directories(jpeg PUBLIC "${CMAKE_BINARY_DIR}/generated")
vendor_library(png libpng-1.6.39 png.c pngerror.c pngget.c pngmem.c pngpread.c pngread.c pngrio.c pngrtran.c
  pngrutil.c pngset.c pngtrans.c pngwio.c pngwrite.c pngwtran.c pngwutil.c
  arm/arm_init.c arm/filter_neon_intrinsics.c arm/palette_neon_intrinsics.c)
configure_file("${EXTERNAL}/libpng-1.6.39/scripts/pnglibconf.h.prebuilt" "${CMAKE_BINARY_DIR}/generated/pnglibconf.h" COPYONLY)
target_include_directories(png PUBLIC "${CMAKE_BINARY_DIR}/generated")
target_compile_options(png PRIVATE -include math.h)
target_link_libraries(png PUBLIC z)
vendor_library(bzip2 bzip2-1.0.8 blocksort.c huffman.c crctable.c randtable.c compress.c decompress.c bzlib.c)

vendor_library(freetype freetype-2.13.0 src/base/ftbase.c src/base/ftbbox.c src/base/ftbdf.c src/base/ftbitmap.c
  src/base/ftcid.c src/base/ftdebug.c src/base/ftfstype.c src/base/ftgasp.c src/base/ftglyph.c src/base/ftgxval.c
  src/base/ftinit.c src/base/ftmm.c src/base/ftotval.c src/base/ftpatent.c src/base/ftpfr.c src/base/ftstroke.c
  src/base/ftsynth.c src/base/fttype1.c src/base/ftwinfnt.c src/base/ftsystem.c src/autofit/autofit.c src/bdf/bdf.c
  src/cache/ftcache.c src/cff/cff.c src/cid/type1cid.c src/gzip/ftgzip.c src/lzw/ftlzw.c src/pcf/pcf.c src/pfr/pfr.c
  src/psaux/psaux.c src/pshinter/pshinter.c src/psnames/psnames.c src/raster/raster.c src/sdf/sdf.c src/sfnt/sfnt.c
  src/smooth/smooth.c src/svg/svg.c src/truetype/truetype.c src/type1/type1.c src/type42/type42.c src/winfonts/winfnt.c)
target_include_directories(freetype PUBLIC "${EXTERNAL}/freetype-2.13.0/include")
target_compile_definitions(freetype PRIVATE FT2_BUILD_LIBRARY)

vendor_library(smpeg smpeg MPEG.cpp MPEGring.cpp MPEGlist.cpp MPEGstream.cpp MPEGsystem.cpp MPEGfilter.c smpeg.cpp
  audio/MPEGaudio.cpp audio/bitwindow.cpp audio/filter.cpp audio/filter_2.cpp audio/hufftable.cpp audio/mpeglayer1.cpp
  audio/mpeglayer2.cpp audio/mpeglayer3.cpp audio/mpegtable.cpp audio/mpegtoraw.cpp video/MPEGvideo.cpp
  video/decoders.cpp video/floatdct.cpp video/gdith.cpp video/jrevdct.cpp video/motionvec.cpp video/parseblock.cpp
  video/readfile.cpp video/util.cpp video/video.cpp video/vhar128.cpp)
target_include_directories(smpeg PRIVATE "${EXTERNAL}/smpeg/audio" "${EXTERNAL}/smpeg/video")
target_compile_definitions(smpeg PRIVATE LITTLE_ENDIAN_ARCHITECTURE=1 NOCONTROLS)
set_target_properties(smpeg PROPERTIES CXX_STANDARD 98)
target_link_libraries(smpeg PUBLIC "${SDL12_LIBRARY}")

vendor_library(sdl_image SDL_image-1.2.12 IMG.c IMG_bmp.c IMG_gif.c IMG_jpg.c IMG_lbm.c IMG_pcx.c IMG_png.c
  IMG_pnm.c IMG_tga.c IMG_tif.c IMG_xcf.c IMG_xpm.c IMG_xv.c IMG_webp.c)
target_compile_definitions(sdl_image PRIVATE SDL_IMAGE_USE_COMMON_BACKEND LOAD_BMP LOAD_GIF LOAD_JPG LOAD_LBM
  LOAD_PCX LOAD_PNG LOAD_PNM LOAD_TGA LOAD_XCF LOAD_XPM LOAD_XV)
# SDL_image 1.2 predates libpng's const-qualified function-pointer declarations;
# the pointee const changes preserve the ABI of these reviewed library versions.
target_compile_options(sdl_image PRIVATE -Wno-incompatible-function-pointer-types)
target_link_libraries(sdl_image PUBLIC jpeg png "${SDL12_LIBRARY}")
vendor_library(sdl_ttf SDL_ttf-2.0.11 SDL_ttf.c)
target_link_libraries(sdl_ttf PUBLIC freetype "${SDL12_LIBRARY}")
vendor_library(sdl_mixer SDL_mixer-1.2.12 effect_position.c effect_stereoreverse.c effects_internal.c load_aiff.c
  load_voc.c load_ogg.c mixer.c music.c music_cmd.c wavestream.c music_ogg.c dynamic_ogg.c dynamic_mp3.c)
target_compile_definitions(sdl_mixer PRIVATE CMD_MUSIC WAV_MUSIC OGG_MUSIC MP3_MUSIC)
target_compile_options(sdl_mixer PRIVATE -Wno-incompatible-function-pointer-types)
target_link_libraries(sdl_mixer PUBLIC vorbis smpeg "${SDL12_LIBRARY}")

set(ONS_FILES onscripter.cpp DirectReader.cpp SarReader.cpp NsaReader.cpp ScriptHandler.cpp ScriptParser.cpp
  ScriptParser_command.cpp ONScripterReporter.cpp ONScripterLabel.cpp ONScripterLabel_command.cpp ONScripterLabel_text.cpp
  ONScripterLabel_effect.cpp ONScripterLabel_effect_breakup.cpp ONScripterLabel_effect_cascade.cpp ONScripterLabel_effect_trig.cpp
  ONScripterLabel_event.cpp ONScripterLabel_rmenu.cpp ONScripterLabel_animation.cpp ONScripterLabel_sound.cpp
  ONScripterLabel_file.cpp ONScripterLabel_file2.cpp ONScripterLabel_image.cpp AnimationInfo.cpp FontInfo.cpp DirtyRect.cpp
  graphics_routines.cpp resize_image.cpp sjis2utf16.cpp DirPaths.cpp Layer.cpp Encoding.cpp)
list(REMOVE_ITEM ONS_FILES ONScripterLabel.cpp ONScripterLabel_command.cpp)
list(TRANSFORM ONS_FILES PREPEND "${ONS_SOURCE}/")
# The published Mac branch refers to a parameter removed from errorAndExit.
# Correct that branch only in a disposable build input; fatal errors retain
# their alert, while warnings retain the upstream Ignore/Quit choice.
file(READ "${ONS_SOURCE}/ONScripterLabel.cpp" LABEL_SOURCE)
if(NOT LABEL_SOURCE MATCHES "if \\(is_simple && !is_warning\\)")
  message(FATAL_ERROR "The reviewed ONScripter-EN Cocoa overlay no longer matches")
endif()
string(REPLACE "if (is_simple && !is_warning)" "if (!is_warning)" LABEL_SOURCE "${LABEL_SOURCE}")
file(WRITE "${CMAKE_BINARY_DIR}/generated/ONScripterLabel.mm" "${LABEL_SOURCE}")
list(APPEND ONS_FILES "${CMAKE_BINARY_DIR}/generated/ONScripterLabel.mm")
file(READ "${ONS_SOURCE}/ONScripterLabel_command.cpp" COMMAND_SOURCE)
if(NOT COMMAND_SOURCE MATCHES "if \\(save_buf != '\\\\0'\\)")
  message(FATAL_ERROR "The reviewed ONScripter-EN delimiter overlay no longer matches")
endif()
string(REPLACE "if (save_buf != '\\0')" "if (*save_buf != '\\0')" COMMAND_SOURCE "${COMMAND_SOURCE}")
file(WRITE "${CMAKE_BINARY_DIR}/generated/ONScripterLabel_command.cpp" "${COMMAND_SOURCE}")
list(APPEND ONS_FILES "${CMAKE_BINARY_DIR}/generated/ONScripterLabel_command.cpp")
add_executable(onscripter-en ${ONS_FILES} cocoa-support.mm)
target_compile_definitions(onscripter-en PRIVATE MACOSX UTF8_CAPTION UTF8_FILESYSTEM USE_OGG_VORBIS HAVE_LOCALTIME_R)
target_link_libraries(onscripter-en PRIVATE sdl_ttf sdl_image sdl_mixer smpeg vorbis bzip2 "${SDL12_MAIN}"
  "-framework Cocoa" "-framework CoreFoundation")
set_target_properties(onscripter-en PROPERTIES INSTALL_RPATH "@executable_path/../lib")
install(TARGETS onscripter-en RUNTIME DESTINATION bin)
