#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

static volatile uint64_t words[2] = { UINT64_C(0x20ea710), UINT64_C(0xd53bd04b) };

static int wait_for(const char *file) {
    const struct timespec delay = { 0, 10000000 };
    for (unsigned attempt = 0; attempt < 2000; ++attempt) {
        if (access(file, F_OK) == 0) return 0;
        nanosleep(&delay, NULL);
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    printf("READY %ld 0x%" PRIxPTR "\nSECOND 0x%" PRIxPTR "\n",
           (long)getpid(), (uintptr_t)&words[0], (uintptr_t)&words[1]);
    fflush(stdout);
    if (wait_for(argv[1])) return 3;
    uint64_t first = words[0], second = words[1];
    printf("RESULT 0x%" PRIx64 " 0x%" PRIx64 "\n", first, second);
    fflush(stdout);
    if (first != UINT64_C(0x20ea710) || second != UINT64_C(0xd53bd04b)) return 4;
    return wait_for(argv[2]);
}
