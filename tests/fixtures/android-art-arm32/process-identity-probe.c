#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include "bridge.h"

static pid_t worker_tid;
static void *worker(void *unused) {
    (void)unused;
    worker_tid = gettid();
    assert(worker_tid > 1 && worker_tid <= 65535 && worker_tid != getpid());
    char path[64], target[64];
    snprintf(path, sizeof path, "/proc/self/task/%d", worker_tid);
    assert(access(path, F_OK) == 0);
    ssize_t length = readlink("/proc/thread-self", target, sizeof target - 1);
    assert(length > 0); target[length] = 0;
    snprintf(path, sizeof path, "%d/task/%d", getpid(), worker_tid);
    assert(strcmp(path, target) == 0);
    return NULL;
}

int main(int argc,char **argv) {
    pid_t parent = getpid();
    assert(parent > 1 && parent <= 65535 && gettid() == parent);
    pthread_t thread;
    assert(pthread_create(&thread, NULL, worker, NULL) == 0);
    assert(pthread_join(thread, NULL) == 0);
    assert(setpgid(0, 0) == 0 && getpgid(0) == parent);
    int channel[2]; assert(pipe(channel) == 0);
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
        close(channel[0]);
        pid_t identity[2] = {getpid(), getppid()};
        assert(identity[0] > 1 && identity[0] <= 65535 && identity[0] != parent);
        assert(identity[1] == parent && gettid() == identity[0]);
        assert(getpgid(0) == parent);
        assert(setsid() == identity[0] && getsid(0) == identity[0]);
        assert(getpgid(0) == identity[0]);
        assert(write(channel[1], identity, sizeof identity) == sizeof identity);
        _exit(42);
    }
    close(channel[1]);
    pid_t identity[2] = {0};
    assert(read(channel[0], identity, sizeof identity) == sizeof identity);
    close(channel[0]);
    assert(identity[0] == child && identity[1] == parent);
    siginfo_t info = {0};
    assert(waitid(P_PID, child, &info, WEXITED | WNOWAIT) == 0);
    assert(info.si_pid == child && info.si_code == CLD_EXITED && info.si_status == 42);
    int status = 0;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 42);
    assert(waitpid(child, &status, WNOHANG) == -1 && (errno == ECHILD || errno == ESRCH));
    assert(argc==2);
    int client=atoi(argv[1]);assert(client>=0);
    uint32_t expected[4];assert(read(client,expected,sizeof expected)==sizeof expected);
    struct KljArtPeerCredentials peer={.descriptor=client};
    assert(klj_art_host(12,&peer,sizeof peer)==0);
    assert((uint32_t)peer.androidPid==expected[0]&&(uint32_t)peer.hostPid==expected[1]);
    assert(peer.hostUid==expected[2]&&peer.hostGid==expected[3]);
    struct ucred original;socklen_t length=sizeof original;
    assert(getsockopt(client,SOL_SOCKET,SO_PEERCRED,&original,&length)==0);
    assert(original.pid==peer.androidPid);
    uint32_t accepted=1;assert(write(client,&accepted,sizeof accepted)==sizeof accepted);
    close(client);
    printf("PASS original process/thread identity, procfs, fork, zombie observation and wait retirement\n");
    printf("PASS incoming kernel credentials retain physical UID and logical Android PID\n");
    return 0;
}
