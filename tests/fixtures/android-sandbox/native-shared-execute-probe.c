#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    for (int i = 1; i < argc; ++i) {
        int allowed = argv[i][0] == '+';
        const char *file = argv[i] + 1;
        if (access(file, R_OK)) return 2;
        errno = 0;
        int result = access(file, X_OK), error = errno;
        if (allowed ? result != 0 : result == 0 || (error != EPERM && error != EACCES)) {
            fprintf(stderr, "Execute input %d: result=%d errno=%d\n", i, result, error);
            return 3;
        }
    }
    puts("PASS exact shared ELF X_OK and denied aliases");
    return 0;
}
