// maclauncher-winemetal.so loads the graphics layer inside a Wine process whose
// loader ignores DYLD variables but loads unsigned libraries (the hardened
// runtime with disable-library-validation). A Wine whose ntdll reads
// DXMT_RUNTIME_DIR loads <dir>/aarch64-unix/winemetal.so as the Unix side of its
// Metal library. This library takes that place: it re-exports the runtime's own
// winemetal.so, which the view links beside it as winemetal-runtime.so and
// which dyld loads first, so Wine's call tables are the runtime's own. Its
// constructor then opens each library named in MACLAUNCHER_GRAPHICS_LIBRARIES.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((constructor)) static void load_graphics_libraries(void) {
  const char *list = getenv("MACLAUNCHER_GRAPHICS_LIBRARIES");
  if (!list || !*list) return;
  char *copy = strdup(list);
  if (!copy) return;
  for (char *next = copy, *library; (library = strsep(&next, ":")) != NULL;) {
    if (library[0] != '/') continue;
    if (!dlopen(library, RTLD_NOW | RTLD_GLOBAL)) fprintf(stderr, "MacLauncher graphics: %s\n", dlerror());
  }
  free(copy);
}
