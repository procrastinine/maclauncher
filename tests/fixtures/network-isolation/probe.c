#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef DYLD_PROBE
__attribute__((constructor)) static void injected(void) {
    char pid[32]; snprintf(pid, sizeof(pid), "%d", getpid());
    setenv("MACLAUNCHER_DYLD_PID", pid, 1);
}
#else
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "failed line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
static int denied(int value) { return value == -1 && (errno == EPERM || errno == EACCES); }
int main(int argc, char **argv) {
    alarm(5);
    CHECK(argc == 6);
    char pid[32]; snprintf(pid, sizeof(pid), "%d", getpid());
    CHECK(getenv("MACLAUNCHER_DYLD_PID") && !strcmp(getenv("MACLAUNCHER_DYLD_PID"), pid));
    CHECK(!strcmp(getenv("DYLD_PROBE_LITERAL"), "spaces $(must-not-run) `nor-this` ; = quoted"));
    struct sockaddr_in peer = { .sin_len = sizeof(peer), .sin_family = AF_INET,
        .sin_port = htons(atoi(argv[1])), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    int fd = socket(AF_INET, SOCK_STREAM, 0); CHECK(fd >= 0);
    int connected = connect(fd, (struct sockaddr *)&peer, sizeof(peer));
    CHECK(atoi(argv[3]) ? connected == 0 : denied(connected)); close(fd);
    peer.sin_port = htons(atoi(argv[2])); fd = socket(AF_INET, SOCK_STREAM, 0); CHECK(fd >= 0);
    CHECK(denied(connect(fd, (struct sockaddr *)&peer, sizeof(peer)))); close(fd);
    peer.sin_port = 0; peer.sin_addr.s_addr = htonl(INADDR_ANY);
    fd = socket(AF_INET, SOCK_STREAM, 0); CHECK(fd >= 0);
    int bound = bind(fd, (struct sockaddr *)&peer, sizeof(peer));
    CHECK(denied(bound) || (bound == 0 && denied(listen(fd, 1)))); close(fd);
    fd = socket(AF_INET, SOCK_DGRAM, 0); CHECK(fd >= 0);
    peer.sin_addr.s_addr = htonl(INADDR_LOOPBACK); peer.sin_port = htons(atoi(argv[2]));
    CHECK(denied(sendto(fd, "x", 1, 0, (struct sockaddr *)&peer, sizeof(peer)))); close(fd);
    struct sockaddr_in6 peer6 = { .sin6_len = sizeof(peer6), .sin6_family = AF_INET6,
        .sin6_port = htons(atoi(argv[2])), .sin6_addr = IN6ADDR_LOOPBACK_INIT };
    fd = socket(AF_INET6, SOCK_STREAM, 0); CHECK(fd >= 0);
    CHECK(denied(connect(fd, (struct sockaddr *)&peer6, sizeof(peer6)))); close(fd);
    struct sockaddr_un local = { .sun_len = sizeof(local), .sun_family = AF_UNIX };
    CHECK(snprintf(local.sun_path, sizeof(local.sun_path), "%s/%s.sock", argv[4], pid) < sizeof(local.sun_path));
    fd = socket(AF_UNIX, SOCK_STREAM, 0); CHECK(fd >= 0);
    CHECK(bind(fd, (struct sockaddr *)&local, sizeof(local)) == 0); CHECK(listen(fd, 1) == 0);
    int client = socket(AF_UNIX, SOCK_STREAM, 0); CHECK(client >= 0);
    CHECK(connect(client, (struct sockaddr *)&local, sizeof(local)) == 0);
    int accepted = accept(fd, NULL, NULL); CHECK(accepted >= 0);
    close(accepted); close(client); close(fd); unlink(local.sun_path);
    if (!strcmp(argv[5], "parent")) {
        pid_t child = fork(); CHECK(child >= 0);
        if (child == 0) { argv[5] = "child"; execv(argv[0], argv); _exit(90); }
        int status; CHECK(waitpid(child, &status, 0) == child); CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    puts("network-isolation native sockets, child inheritance and DYLD passed");
    return 0;
}
#endif
