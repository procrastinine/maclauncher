#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "poll-bridge.h"
static unsigned kl_default_mcast_if(void) { return 0; }
#include "socket-addresses.c"
static void *half_close(void *argument) {
    struct timespec delay = {0, 20000000}; nanosleep(&delay, NULL);
    assert(!shutdown(*(int *)argument, SHUT_WR)); return NULL;
}

int main(void) {
    int pair[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    struct pollfd writable = {pair[0], 0x100, -1};
    assert(klj_poll(&writable, 1, 0) == 1 && writable.revents == 0x100);
    writable.events = 0x104;
    assert(klj_poll(&writable, 1, 0) == 1 && writable.revents == 0x104);
    writable.events = 0x4000;
    assert(klj_poll(&writable, 1, 0) == 0 && writable.revents == 0);
    struct pollfd negative = {-1, -1, -1};
    assert(klj_poll(&negative, 1, 0) == 0 && negative.revents == 0);
    assert(write(pair[1], "x", 1) == 1);
    struct pollfd only_close = {pair[0], 0x2000, -1};
    struct timespec before, after; clock_gettime(CLOCK_MONOTONIC, &before);
    assert(klj_poll(&only_close, 1, 35) == 0 && only_close.revents == 0);
    clock_gettime(CLOCK_MONOTONIC, &after);
    assert((after.tv_sec-before.tv_sec)*1000000000L + after.tv_nsec-before.tv_nsec >= 25000000L);
    struct pollfd input = {pair[0], 0x40, -1};
    assert(klj_poll(&input, 1, 0) == 1 && input.revents == 0x40);
    pthread_t closer; assert(!pthread_create(&closer, NULL, half_close, &pair[1]));
    input.events = 0x2000;
    assert(klj_poll(&input, 1, 500) == 1 && (input.revents & 0x2000));
    assert(!pthread_join(closer, NULL));
    char data; assert(read(pair[0], &data, 1) == 1 && data == 'x');
    assert(klj_poll(&input, 1, 0) == 1 && (input.revents & 0x2000));
    close(pair[0]); close(pair[1]);

    int server = socket(AF_INET, SOCK_STREAM, 0); assert(server >= 0);
    struct sockaddr_in bound = {.sin_len = sizeof(bound), .sin_family = AF_INET,
                               .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(!bind(server, (void *)&bound, sizeof(bound)) && !listen(server, 1));
    socklen_t length = sizeof(bound); assert(!getsockname(server, (void *)&bound, &length));
    size_t page = (size_t)getpagesize();
    unsigned char *guard = mmap(NULL, page * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(guard != MAP_FAILED && !mprotect(guard + page, page, PROT_NONE));
    for (unsigned size = 0; size <= sizeof(bound); size++) {
        unsigned char *buffer = guard + page - size;
        if (size) memset(buffer, 0xee, size);
        length = size;
        assert(!kl_getsockname(server, (void *)buffer, &length) && length == sizeof(bound));
        if (size) assert(buffer[0] == 2);
        if (size >= 2) assert(buffer[1] == 0);
    }
    struct sockaddr_storage host;
    for (unsigned size = 0; size < sizeof(bound); size++) {
        unsigned char *buffer = guard + page - size;
        if (size) memset(buffer, 0, size);
        if (size) buffer[0] = 2;
        assert(kl_sa_to_host(&host, (void *)buffer, size) == -1 && errno == EINVAL);
    }
    for (unsigned size = 0; size <= 2; size++) {
        int client = socket(AF_INET, SOCK_STREAM, 0); assert(client >= 0);
        assert(!connect(client, (void *)&bound, sizeof(bound)));
        length = size;
        int accepted = kl_accept(server, (void *)(guard + page - size), &length);
        assert(accepted >= 0 && length == sizeof(bound));
        if (size) assert(guard[page-size] == 2);
        length = size;
        assert(!kl_getpeername(client, (void *)(guard + page - size), &length) && length == sizeof(bound));
        close(accepted); close(client);
    }
    close(server); assert(!munmap(guard, page * 2));
    puts("PASS shared Linux poll bits and half-close, bounded original socket address input/output");
}
