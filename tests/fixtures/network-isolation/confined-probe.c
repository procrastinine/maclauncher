#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
static int expected(int result, int allowed) {
    return allowed ? result >= 0 : result == -1 && (errno == EPERM || errno == EACCES);
}
static int sockets(int port4, int port6, int allowed) {
    struct sockaddr_in peer4 = { .sin_len = sizeof(peer4), .sin_family = AF_INET,
        .sin_port = htons(port4), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    struct sockaddr_in6 peer6 = { .sin6_len = sizeof(peer6), .sin6_family = AF_INET6,
        .sin6_port = htons(port6), .sin6_addr = IN6ADDR_LOOPBACK_INIT };
    for (int ipv6 = 0; ipv6 < 2; ipv6++) {
        int family = ipv6 ? AF_INET6 : AF_INET;
        struct sockaddr *peer = ipv6 ? (struct sockaddr *)&peer6 : (struct sockaddr *)&peer4;
        socklen_t length = ipv6 ? sizeof(peer6) : sizeof(peer4);
        int fd = socket(family, SOCK_STREAM, 0); CHECK(fd >= 0);
        CHECK(expected(connect(fd, peer, length), allowed)); close(fd);
        fd = socket(family, SOCK_DGRAM, 0); CHECK(fd >= 0);
        CHECK(expected(sendto(fd, "x", 1, 0, peer, length), allowed)); close(fd);
        // Games also bind UDP for local play and receive on TCP listeners.
        // Exercise those operations under the same policy as outbound traffic.
        for (int type = SOCK_STREAM; type <= SOCK_DGRAM; type++) {
            struct sockaddr_storage local = {0};
            if (ipv6) {
                struct sockaddr_in6 address = { .sin6_len = sizeof(address), .sin6_family = AF_INET6,
                    .sin6_addr = IN6ADDR_LOOPBACK_INIT };
                *(struct sockaddr_in6 *)&local = address;
            } else {
                struct sockaddr_in address = { .sin_len = sizeof(address), .sin_family = AF_INET,
                    .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
                *(struct sockaddr_in *)&local = address;
            }
            fd = socket(family, type, 0); CHECK(fd >= 0);
            CHECK(expected(bind(fd, (struct sockaddr *)&local, length), allowed));
            if (allowed) {
                CHECK(getsockname(fd, (struct sockaddr *)&local, &length) == 0);
                int client = socket(family, type, 0); CHECK(client >= 0);
                if (type == SOCK_STREAM) {
                    CHECK(listen(fd, 1) == 0);
                    CHECK(connect(client, (struct sockaddr *)&local, length) == 0);
                    int accepted = accept(fd, NULL, NULL); CHECK(accepted >= 0); close(accepted);
                } else {
                    CHECK(sendto(client, "x", 1, 0, (struct sockaddr *)&local, length) == 1);
                    char byte = 0; CHECK(recv(fd, &byte, 1, 0) == 1 && byte == 'x');
                }
                close(client);
            }
            close(fd);
        }
    }
    return 0;
}
int main(int argc, char **argv) {
    alarm(5); CHECK(argc == 4);
    CHECK(sockets(atoi(argv[1]), atoi(argv[2]), atoi(argv[3])) == 0);
    pid_t child = fork(); CHECK(child >= 0);
    if (child == 0) _exit(sockets(atoi(argv[1]), atoi(argv[2]), atoi(argv[3])));
    int status; CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    puts("confined IPv4/IPv6 TCP/UDP and child policy passed");
    return 0;
}
