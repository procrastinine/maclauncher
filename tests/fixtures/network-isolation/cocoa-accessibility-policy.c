#include <stdio.h>
#include <unistd.h>

// Read-only sandbox query declarations match WebKit's Darwin SandboxSPI.h.
enum sandbox_filter_type {
    SANDBOX_FILTER_PATH = 1,
    SANDBOX_FILTER_GLOBAL_NAME = 2,
};
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t, const char *, enum sandbox_filter_type, ...);

static int permits(const char *operation, enum sandbox_filter_type filter, const char *name) {
    return sandbox_check(getpid(), operation, filter | SANDBOX_CHECK_NO_REPORT, name) == 0;
}
int main(void) {
    if (!permits("mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.tccd.system")) {
        fputs("Accessibility client validation is unavailable\n", stderr);
        return 1;
    }
    if (permits("mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.axserver") ||
        permits("mach-register", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.axserver") ||
        permits("mach-register", SANDBOX_FILTER_GLOBAL_NAME, "unrelated.application.service") ||
        permits("file-read-data", SANDBOX_FILTER_PATH, "/private/etc/master.passwd")) {
        fputs("Unrelated accessibility, registration or file access was granted\n", stderr);
        return 2;
    }
    puts("Accessibility validation available; peer servers and private files remain confined");
    return 0;
}
