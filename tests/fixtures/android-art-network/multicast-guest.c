#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <errno.h>
#include <stdio.h>
#include <unistd.h>
#include <assert.h>

int main(void) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    assert(fd >= 0);
    int value = 0;
    if (setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &value, sizeof value)) {
        printf("Original Bionic multicast loopback errno=%d\n", errno);
        close(fd);
        return 2;
    }
    value = 1;
    assert(!setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &value, sizeof value));
    struct ip_mreqn request = {.imr_ifindex=1};
    assert(!setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &request, sizeof request));
    int v6 = socket(AF_INET6, SOCK_DGRAM, 0);
    assert(v6 >= 0);
    assert(!setsockopt(v6, IPPROTO_IPV6, IPV6_MULTICAST_IF, &value, sizeof value));
    value = 0;
    assert(!setsockopt(v6, IPPROTO_IPV6, IPV6_MULTICAST_IF, &value, sizeof value));
    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
        struct in_addr address = {.s_addr=1};
        socklen_t length = sizeof address;
        assert(!getsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &address, &length));
        assert(address.s_addr == 0 && length == 4);
        value = -1;
        length = sizeof value;
        assert(!getsockopt(v6, IPPROTO_IPV6, IPV6_MULTICAST_IF, &value, &length));
        assert(value == 0 && length == 4);
        close(v6);
        close(fd);
        _exit(0);
    }
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(v6);
    close(fd);
    puts("PASS original Bionic multicast initialization and forked interface state");
}
