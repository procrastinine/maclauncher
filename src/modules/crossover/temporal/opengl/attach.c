#include "graphics-library-attach.h"
__attribute__((constructor)) static void attach_graphics(void) { maclauncher_attach_graphics_libraries(); }
// Wine's Unix-library initialization obtains these tables after dlopen has
// applied the constructor. No graphics entry points cross this call table.
static int attach_ready(void *unused) { return 0; }
__attribute__((visibility("default"))) int (*const __wine_unix_call_funcs[])(void *) = { attach_ready };
__attribute__((visibility("default"))) int (*const __wine_unix_call_wow64_funcs[])(void *) = { attach_ready };
