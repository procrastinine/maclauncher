// MacLauncher direct host for siglus_rs's published C API (MPL-2.0 upstream).
// This process owns the native game lifecycle; it never starts a launcher UI.
#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*RunGame)(const char *, const char *);
typedef char *(*ProbeGame)(const char *, const char *, const char *);
typedef void (*FreeString)(char *);

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("MACLAUNCHER_SIGLUS_HOST_V2");
        return 0;
    }
    int fixed_argc = argc;
    for (int i = 4; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { fixed_argc = i; break; }
    }
    if ((fixed_argc != 4 && fixed_argc != 5) ||
        (strcmp(argv[1], "--run") != 0 && strcmp(argv[1], "--probe") != 0)) {
        fputs("usage: siglus-host --run|--probe LIBRARY GAME_ROOT [ENCODING] [-- GAME_ARGUMENTS...]\n", stderr);
        return 2;
    }
    void *library = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "Native interpreter could not load: %s\n", dlerror()); return 1; }
    const char *encoding = fixed_argc == 5 ? argv[4] : NULL;
    if (strcmp(argv[1], "--probe") == 0) {
        ProbeGame probe = (ProbeGame)dlsym(library, "game_probe_json");
        FreeString release = (FreeString)dlsym(library, "game_string_free");
        if (!probe || !release) { fputs("This interpreter does not export the reviewed detection API.\n", stderr); return 1; }
        char *info = probe(argv[3], encoding, NULL);
        if (!info) return 1;
        puts(info); release(info);
        return 0;
    }
    RunGame run = (RunGame)dlsym(library, "game_run_entry");
    if (!run) { fputs("This interpreter does not export the reviewed direct launch API.\n", stderr); return 1; }
    @autoreleasepool {
        // Winit owns finishLaunching/run. Calling them here prevents its
        // expected AppKit notifications and can break teardown.
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        int result = run(argv[3], encoding);
        fflush(stdout); fflush(stderr);
        // Winit has completed its AppKit run loop. Avoid a second host teardown.
        _exit(result);
    }
}
