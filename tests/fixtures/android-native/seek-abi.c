#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "seek-bridge.h"

/* The fixture uses real files; the original OBB owner declines unrelated FDs. */
static off_t kl_obbmap_lseek(int fd, off_t offset, int whence, int *handled) {
    (void)fd; (void)offset; (void)whence; *handled = 0; return -1;
}
#include "seek-functions.c"

int main(void) {
    _Static_assert(sizeof(off_t) == 8, "Android ARM64 offsets are 64-bit");
    char name[] = "/tmp/android-seek-XXXXXX";
    int fd = mkstemp(name); assert(fd >= 0); assert(!unlink(name));
    const off_t end = ((off_t)1 << 32) + 4096;
    assert(pwrite(fd, "data", 4, 0) == 4);
    assert(pwrite(fd, "tail", 4, end - 4) == 4);
    assert(!fsync(fd));
    off_t data = lseek(fd, 0, SEEK_DATA), hole = lseek(fd, 0, SEEK_HOLE);
    assert(data == 0 && hole > data && hole <= end);
    off_t (*functions[])(int, off_t, int) = {klb_lseek, klb_lseek64};
    for (unsigned i = 0; i < sizeof(functions)/sizeof(*functions); ++i) {
        assert(functions[i](fd, 0, 3) == data);
        assert(functions[i](fd, 0, 4) == hole);
        assert(functions[i](fd, end - 4, 3) == end - 4);
        assert(functions[i](fd, end - 4, 4) == end);
        assert(functions[i](fd, 8, 0) == 8);
        assert(functions[i](fd, 5, 1) == 13);
        assert(functions[i](fd, -4, 2) == end - 4);
        char tail[4]; assert(read(fd, tail, sizeof(tail)) == 4 && tail[0] == 't');
        errno = 0; assert(functions[i](fd, end, 3) == -1 && errno == ENXIO);
        errno = 0; assert(functions[i](fd, 0, 12345) == -1 && errno == EINVAL);
    }
    assert(!close(fd));
    int pipefd[2]; assert(!pipe(pipefd));
    errno = 0; assert(klb_lseek(pipefd[0], 0, 3) == -1 && errno == ESPIPE);
    close(pipefd[0]); close(pipefd[1]);
    puts("PASS original native seek APIs: Linux DATA/HOLE, sparse 64-bit offsets and native errors");
}
