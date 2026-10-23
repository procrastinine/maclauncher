#include <stdio.h>
#include <unistd.h>

// The SDK omits this read-only SPI; declarations follow WebKit's SandboxSPI.h.
// https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/spi/darwin/SandboxSPI.h
enum sandbox_filter_type {
    SANDBOX_FILTER_PATH = 1,
    SANDBOX_FILTER_GLOBAL_NAME = 2,
    SANDBOX_FILTER_XPC_SERVICE_NAME = 12,
};
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t, const char *, enum sandbox_filter_type, ...);

static int permits(const char *operation, enum sandbox_filter_type filter, const char *name) {
    return sandbox_check(getpid(), operation, filter | SANDBOX_CHECK_NO_REPORT, name) == 0;
}
int main(void) {
    if (!permits("mach-lookup", SANDBOX_FILTER_XPC_SERVICE_NAME, "com.apple.SafariPlatformSupport.Helper") ||
        !permits("mach-lookup", SANDBOX_FILTER_XPC_SERVICE_NAME, "com.apple.ViewBridgeAuxiliary") ||
        !permits("mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "mul-xpc (Apple)_OpenStep") ||
        !permits("mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "en-xpc (Apple)_OpenStep")) {
        fputs("Native text service unavailable\n", stderr);
        return 1;
    }
    if (permits("mach-lookup", SANDBOX_FILTER_XPC_SERVICE_NAME, "com.apple.appkit.xpc.openAndSavePanelService") ||
        permits("mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.securityd") ||
        permits("file-read-data", SANDBOX_FILTER_PATH, "/private/etc/master.passwd")) {
        fputs("Unrelated service or file access was granted\n", stderr);
        return 2;
    }
    puts("Native text services available; unrelated services and files remain confined");
    return 0;
}
