// Native resident stand-in around the original controller's shutdown path.
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
static void stop(int signal_number) { (void)signal_number; stopped = 1; }
static void record(const char *message, pid_t pid) {
    FILE *file = fopen(getenv("AIM_STOP_TRACE"), "a");
    if (!file) _exit(10);
    fprintf(file, "%s owned-pid=%d\n", message, pid);
    fclose(file);
}
int main(int count, char **arguments) {
    if (count < 4) return 2;
    if (!strcmp(arguments[3], "run")) {
        signal(SIGTERM, stop);
        pid_t child = fork();
        if (child < 0) return 3;
        if (!child) { while (!stopped && getppid() != 1) usleep(1000); _exit(0); }
        record("resident", getpid());record("resident-child", child);
        while (!stopped) usleep(1000);
        errno = 0;
        if (kill((pid_t)strtol(getenv("AIM_STOP_FOREIGN_PID"), NULL, 10), SIGCONT) != -1 || errno != EPERM) return 4;
        record("foreign-signal-denied", getpid());
        if (kill(child, SIGTERM)) return 5;
        int status = 0;
        while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 6;
        if (!WIFEXITED(status) || WEXITSTATUS(status)) return 7;
        record("resident-child-reaped", child);
        return atoi(getenv("AIM_STOP_EXIT"));
    }
    for (int i = 4; i < count; ++i) {
        if (!strcmp(arguments[i], "sys.boot_completed")) { puts("1");return 0; }
        if (!strcmp(arguments[i], "get-started-user-state")) { puts("RUNNING_UNLOCKED");return 0; }
        if (!strcmp(arguments[i], "path")) { puts("package:/data/app/base.apk");return 0; }
        if (!strcmp(arguments[i], "start")) { puts("Status: ok\nComplete");return 0; }
    }
    puts("Success");return 0;
}
