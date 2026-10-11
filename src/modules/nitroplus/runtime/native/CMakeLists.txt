cmake_minimum_required(VERSION 3.20)
project(maclauncher_npengine LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_INSTALL_RPATH "@loader_path/../lib")
find_package(PkgConfig REQUIRED)
find_package(FLEX REQUIRED)
find_package(BISON REQUIRED)
find_package(ZLIB REQUIRED)
find_package(JPEG REQUIRED)
find_package(PNG REQUIRED)
find_package(OpenGL REQUIRED)
find_package(Threads REQUIRED)
find_path(BOOST_INCLUDE_DIR boost/locale.hpp HINTS /opt/homebrew/include /usr/local/include REQUIRED)
find_library(BOOST_LOCALE_LIBRARY boost_locale HINTS /opt/homebrew/lib /usr/local/lib REQUIRED)
pkg_check_modules(NATIVE REQUIRED IMPORTED_TARGET sdl2 glew pangocairo gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0)
set(NPA "${CMAKE_CURRENT_SOURCE_DIR}/libnpa")
set(ENGINE "${CMAKE_CURRENT_SOURCE_DIR}/libnpengine")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/npa" "${CMAKE_CURRENT_BINARY_DIR}/engine")
FLEX_TARGET(NpaLexer "${NPA}/src/lexer.l" "${CMAKE_CURRENT_BINARY_DIR}/npa/lexer.cpp")
BISON_TARGET(NpaParser "${NPA}/src/parser.y" "${CMAKE_CURRENT_BINARY_DIR}/npa/parser.cpp" DEFINES_FILE "${CMAKE_CURRENT_BINARY_DIR}/npa/parser.hpp")
ADD_FLEX_BISON_DEPENDENCY(NpaLexer NpaParser)
FLEX_TARGET(XmlLexer "${ENGINE}/src/lexer.l" "${CMAKE_CURRENT_BINARY_DIR}/engine/Lexer.cpp")
BISON_TARGET(XmlParser "${ENGINE}/src/parser.y" "${CMAKE_CURRENT_BINARY_DIR}/engine/Parser.cpp" DEFINES_FILE "${CMAKE_CURRENT_BINARY_DIR}/engine/Parser.hpp")
ADD_FLEX_BISON_DEPENDENCY(XmlLexer XmlParser)
add_library(npa STATIC
  "${NPA}/src/npafile.cpp" "${NPA}/src/inpafile.cpp" "${NPA}/src/nsbmagic.cpp"
  "${NPA}/src/scriptfile.cpp" "${NPA}/src/nsbconstants.cpp" "${NPA}/src/nsscompiler.cpp"
  "${NPA}/src/buffer.cpp" "private-files.cpp" ${BISON_NpaParser_OUTPUTS} ${FLEX_NpaLexer_OUTPUTS})
target_include_directories(npa PUBLIC "${NPA}/include" "${BOOST_INCLUDE_DIR}" PRIVATE "${NPA}/src" "${CMAKE_CURRENT_BINARY_DIR}/npa")
target_link_libraries(npa PUBLIC "${BOOST_LOCALE_LIBRARY}" ZLIB::ZLIB)
target_compile_definitions(npa PRIVATE FLEX_VERSION_MAJOR=2 FLEX_VERSION_MINOR=6 FLEX_VERSION_PATCH=4)
add_library(npengine SHARED
  "text-markup.cpp"
  "${ENGINE}/src/Window.cpp" "${ENGINE}/src/NSBInterpreter.cpp" "${ENGINE}/src/ResourceMgr.cpp"
  "${ENGINE}/src/Texture.cpp" "${ENGINE}/src/Variable.cpp" "${ENGINE}/src/NSBContext.cpp"
  "${ENGINE}/src/GLTexture.cpp" "${ENGINE}/src/Playable.cpp" "${ENGINE}/src/Movie.cpp"
  "${ENGINE}/src/Choice.cpp" "${ENGINE}/src/Text.cpp" "${ENGINE}/src/Image.cpp"
  "${ENGINE}/src/NSBDebugger.cpp" "${ENGINE}/src/Scrollbar.cpp"
  ${BISON_XmlParser_OUTPUTS} ${FLEX_XmlLexer_OUTPUTS})
target_include_directories(npengine PUBLIC "${ENGINE}/include" PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/engine" "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(npengine PUBLIC npa PkgConfig::NATIVE JPEG::JPEG PNG::PNG OpenGL::GL Threads::Threads)
add_executable(npengine-runner main.cpp)
target_link_libraries(npengine-runner PRIVATE npengine)
install(TARGETS npengine-runner RUNTIME DESTINATION bin)
install(TARGETS npengine LIBRARY DESTINATION lib)
