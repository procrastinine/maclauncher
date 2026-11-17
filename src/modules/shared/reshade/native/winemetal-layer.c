// maclauncher-winemetal.so loads the graphics layer inside a Wine process whose
// loader ignores DYLD variables but loads unsigned libraries (the hardened
// runtime with disable-library-validation). A Wine whose ntdll reads
// DXMT_RUNTIME_DIR loads <dir>/aarch64-unix/winemetal.so as the Unix side of its
// Metal library. This library takes that place: it re-exports the runtime's own
// winemetal.so, which the view links beside it as winemetal-runtime.so and
// which dyld loads first, so Wine's call tables are the runtime's own. Its
// constructor then applies each library named in MACLAUNCHER_GRAPHICS_LIBRARIES
// (graphics-library-attach.h).
#include "graphics-library-attach.h"

__attribute__((constructor)) static void load_graphics_libraries(void) { maclauncher_attach_graphics_libraries(); }
