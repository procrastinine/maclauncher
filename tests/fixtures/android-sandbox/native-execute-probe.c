#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 8) return 2;
    for (int i = 1; i <= 6; ++i) {
        if (access(argv[i], R_OK)) {
            fprintf(stderr, "Readable control %d failed: %d\n", i, errno);
            return 3;
        }
        errno = 0;
        int result = access(argv[i], X_OK), error = errno;
        if (i == 1 ? result != 0 : result == 0 || (error != EPERM && error != EACCES)) {
            fprintf(stderr, "Execute control %d: result=%d errno=%d\n", i, result, error);
            return 4;
        }
    }
    errno = 0;
    if (link(argv[1], argv[7]) == 0) {
        unlink(argv[7]);
        fprintf(stderr, "Read-only executable gained a writable hard-link alias\n");
        return 5;
    }
    if (errno != EPERM && errno != EACCES) return 6;
    puts("PASS installed ARM ELF X_OK; Mach-O, script, foreign, writable and linked inputs denied; writable hard-link alias denied");
    return 0;
}
