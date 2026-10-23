#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int child(const char *executable, const char *mode, int stop) {
    posix_spawnattr_t attributes;
    int error = posix_spawnattr_init(&attributes);
    if (error) return error;
    error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_START_SUSPENDED);
    pid_t pid = 0;
    char *arguments[] = {(char *)executable, (char *)mode, NULL};
    if (!error) error = posix_spawn(&pid, executable, NULL, &attributes, arguments, environ);
    posix_spawnattr_destroy(&attributes);
    if (error) return error;
    if (kill(pid, SIGCONT)) return errno;
    if (stop && kill(pid, SIGKILL)) return errno;
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return errno;
    }
    if (stop ? !WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL
             : !WIFEXITED(status) || WEXITSTATUS(status) != 0) return ECHILD;
    return 0;
}

int main(int count, char **arguments) {
    if (count == 2 && !strcmp(arguments[1], "exit")) return 0;
    if (count == 2 && !strcmp(arguments[1], "wait")) for (;;) pause();
    if (count != 1) return 2;
    int error = child(arguments[0], "exit", 0);
    if (!error) error = child(arguments[0], "wait", 1);
    if (error) {
        fprintf(stderr, "Owned child signal failed: %s\n", strerror(error));
        return 3;
    }
    puts("Owned children resume, terminate and reap");
    return 0;
}
