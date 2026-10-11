cmake_minimum_required(VERSION 3.16)
project(onsyuri LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(PkgConfig REQUIRED)
pkg_check_modules(YURI_DEPS REQUIRED IMPORTED_TARGET sdl2 SDL2_ttf SDL2_image SDL2_mixer lua)
add_executable(onsyuri
    src/onsyuri/AnimationInfo.cpp
    src/onsyuri/coding2utf16.cpp
    src/onsyuri/DirectReader.cpp
    src/onsyuri/DirtyRect.cpp
    src/onsyuri/FontInfo.cpp
    src/onsyuri/gbk2utf16.cpp
    src/onsyuri/LUAHandler.cpp
    src/onsyuri/NsaReader.cpp
    src/onsyuri/ONScripter.cpp
    src/onsyuri/ONScripter_animation.cpp
    src/onsyuri/ONScripter_command.cpp
    src/onsyuri/ONScripter_effect.cpp
    src/onsyuri/ONScripter_effect_breakup.cpp
    src/onsyuri/ONScripter_event.cpp
    src/onsyuri/ONScripter_file.cpp
    src/onsyuri/ONScripter_file2.cpp
    src/onsyuri/ONScripter_image.cpp
    src/onsyuri/ONScripter_lut.cpp
    src/onsyuri/onscripter_main.cpp
    src/onsyuri/ONScripter_rmenu.cpp
    src/onsyuri/ONScripter_sound.cpp
    src/onsyuri/ONScripter_text.cpp
    src/onsyuri/Parallel.cpp
    src/onsyuri/resize_image.cpp
    src/onsyuri/SarReader.cpp
    src/onsyuri/ScriptHandler.cpp
    src/onsyuri/ScriptParser.cpp
    src/onsyuri/ScriptParser_command.cpp
    src/onsyuri/sjis2utf16.cpp
    src/onsyuri/builtin_dll/layer_oldmovie.cpp
    src/onsyuri/builtin_dll/layer_snow.cpp
    src/onsyuri/builtin_dll/ONScripter_effect_cascade.cpp
    src/onsyuri/builtin_dll/ONScripter_effect_trig.cpp)
# SDL chooses its available renderer. The optional upstream GLES/CAS sharpness
# path is excluded; it requires GLES and does not provide its original shader
# source or separate attribution. Other native feature switches are retained.
target_compile_definitions(onsyuri PRIVATE MACOSX USE_LUA USE_PARALLEL USE_FILELOG USE_BUILTIN_LAYER_EFFECTS ENABLE_1BYTE_CHAR)
target_compile_options(onsyuri PRIVATE -Wno-deprecated-declarations -Wno-invalid-source-encoding)
target_link_libraries(onsyuri PRIVATE PkgConfig::YURI_DEPS "${CMAKE_OSX_SYSROOT}/usr/lib/libbz2.tbd")
install(TARGETS onsyuri RUNTIME DESTINATION bin)
