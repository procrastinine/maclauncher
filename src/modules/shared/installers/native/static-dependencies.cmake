# Static Boost components are compiled from their pinned tracked sources.
# Compression links Apple's platform libraries, with no Homebrew dylib closure.
if(NOT DEFINED MACLAUNCHER_BOOST_HEADERS OR NOT DEFINED MACLAUNCHER_BOOST_SOURCE_ROOT)
  message(FATAL_ERROR "Choose the pinned Boost source/header profile")
endif()
set(Boost_VERSION_MACRO 109200)
set(Boost_INCLUDE_DIR "${MACLAUNCHER_BOOST_HEADERS}")
set(Boost_LIBRARY_DIRS "")
set(Boost_HAS_STATIC_LIBS TRUE)
set(Boost_FOUND TRUE)
set(Boost_USE_STATIC_LIBS TRUE)
add_compile_definitions(BOOST_ALL_NO_LIB BOOST_ALL_STATIC_LINK)

set(_fs "${MACLAUNCHER_BOOST_SOURCE_ROOT}/boost-filesystem")
set(_po "${MACLAUNCHER_BOOST_SOURCE_ROOT}/boost-program-options")
set(_io "${MACLAUNCHER_BOOST_SOURCE_ROOT}/boost-iostreams")
add_library(maclauncher_boost_filesystem STATIC
  "${_fs}/src/codecvt_error_category.cpp" "${_fs}/src/exception.cpp"
  "${_fs}/src/operations.cpp" "${_fs}/src/directory.cpp"
  "${_fs}/src/path.cpp" "${_fs}/src/path_traits.cpp"
  "${_fs}/src/portability.cpp" "${_fs}/src/unique_path.cpp"
  "${_fs}/src/utf8_codecvt_facet.cpp")
target_include_directories(maclauncher_boost_filesystem PUBLIC "${_fs}/include" "${Boost_INCLUDE_DIR}" PRIVATE "${_fs}/src")
target_compile_definitions(maclauncher_boost_filesystem PUBLIC BOOST_FILESYSTEM_STATIC_LINK=1 PRIVATE BOOST_FILESYSTEM_SOURCE)
file(GLOB _po_sources CONFIGURE_DEPENDS "${_po}/src/*.cpp")
add_library(maclauncher_boost_program_options STATIC ${_po_sources})
target_include_directories(maclauncher_boost_program_options PUBLIC "${_po}/include" "${Boost_INCLUDE_DIR}")
target_compile_definitions(maclauncher_boost_program_options PUBLIC BOOST_PROGRAM_OPTIONS_STATIC_LINK)
add_library(maclauncher_boost_iostreams STATIC
  "${_io}/src/zlib.cpp" "${_io}/src/bzip2.cpp" "${_io}/src/gzip.cpp"
  "${_io}/src/file_descriptor.cpp" "${_io}/src/mapped_file.cpp")
target_include_directories(maclauncher_boost_iostreams PUBLIC "${_io}/include" "${Boost_INCLUDE_DIR}")
target_link_libraries(maclauncher_boost_iostreams PUBLIC "${CMAKE_OSX_SYSROOT}/usr/lib/libz.tbd" "${CMAKE_OSX_SYSROOT}/usr/lib/libbz2.tbd")
set(Boost_LIBRARIES maclauncher_boost_iostreams maclauncher_boost_filesystem maclauncher_boost_program_options)
