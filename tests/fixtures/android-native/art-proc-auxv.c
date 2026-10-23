#include <dirent.h>
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
typedef struct { Elf64_auxv_t entries[64]; size_t size; } Vector;

static int read_vector(const char *name, Vector *vector) {
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { perror(name); return 21; }
    struct stat metadata;
    if (fstat(fd, &metadata) || !S_ISREG(metadata.st_mode)) return 22;
    vector->size = 0;
    for (;;) {
        unsigned char part[7];
        ssize_t n = read(fd, part, sizeof part);
        if (n < 0 || vector->size + (size_t)n > sizeof vector->entries) return 23;
        if (!n) break;
        memcpy((char *)vector->entries + vector->size, part, (size_t)n);
        vector->size += (size_t)n;
    }
    if (vector->size < sizeof(Elf64_auxv_t) || vector->size % sizeof(Elf64_auxv_t) ||
        vector->entries[vector->size / sizeof(Elf64_auxv_t) - 1].a_type != AT_NULL) return 24;
    unsigned char part[13];
    if (lseek(fd, 3, SEEK_SET) != 3 || read(fd, part, sizeof part) != sizeof part ||
        memcmp(part, (char *)vector->entries + 3, sizeof part)) return 25;
    if (pread(fd, part, sizeof part, 7) != sizeof part ||
        memcmp(part, (char *)vector->entries + 7, sizeof part)) return 26;
    close(fd);
    return 0;
}

static uint64_t value(const Vector *vector, uint64_t key) {
    for (size_t i = 0; i < vector->size / sizeof(Elf64_auxv_t); i++)
        if (vector->entries[i].a_type == key) return vector->entries[i].a_un.a_val;
    return 0;
}

static int verify(const Vector *expected) {
    Vector actual;
    int error = read_vector("/proc/self/auxv", &actual);
    if (error) return error;
    for (size_t i = 0; i + 1 < actual.size / sizeof(Elf64_auxv_t); i++) {
        errno = 0;
        if (getauxval(actual.entries[i].a_type) != actual.entries[i].a_un.a_val || errno) return 27;
    }
    if (expected && (actual.size != expected->size || memcmp(actual.entries, expected->entries, actual.size))) return 28;
    if (value(&actual, AT_PAGESZ) != (uint64_t)sysconf(_SC_PAGESIZE) || !value(&actual, AT_PHDR) ||
        !value(&actual, AT_RANDOM) || !value(&actual, AT_SYSINFO_EHDR)) return 29;
    char name[128];
    const char *formats[] = { "/proc/%d/auxv", "/proc/self/task/%d/auxv", "/proc/thread-self/auxv" };
    for (size_t i = 0; i < sizeof formats / sizeof formats[0]; i++) {
        snprintf(name, sizeof name, formats[i], i == 0 ? getpid() : (int)syscall(SYS_gettid));
        Vector alias;
        if ((error = read_vector(name, &alias))) return error;
        if (alias.size != actual.size || memcmp(alias.entries, actual.entries, actual.size)) return 30;
    }
    DIR *directory = opendir("/proc/self");
    if (!directory) return 31;
    int found = 0;
    for (struct dirent *entry; (entry = readdir(directory));) if (!strcmp(entry->d_name, "auxv")) found = 1;
    closedir(directory);
    return found ? 0 : 32;
}

static void *thread_main(void *expected) { return (void *)(intptr_t)verify(expected); }

int main(int argc, char **argv) {
    Vector original;
    int error = read_vector("/proc/self/auxv", &original);
    if (error || (error = verify(NULL))) return error;
    if (argc > 1 && !strcmp(argv[1], "--exec")) {
        if (!strstr((char *)(uintptr_t)value(&original, AT_EXECFN), "exec-probe")) return 33;
        int ready = atoi(argv[2]), resume = atoi(argv[3]); char byte = 'R';
        if (write(ready, &byte, 1) != 1 || read(resume, &byte, 1) != 1) return 34;
        puts("PASS exec refreshed original Bionic auxiliary vector");
        return 0;
    }
    pthread_t thread;
    if (pthread_create(&thread, NULL, thread_main, &original)) return 35;
    void *thread_error;
    if (pthread_join(thread, &thread_error) || thread_error) return 36;
    char **environment = environ;
    while (*environment) environment++;
    Elf64_auxv_t *stack_vector = (Elf64_auxv_t *)(environment + 1);
    while (stack_vector->a_type != AT_NULL && stack_vector->a_type != AT_PAGESZ) stack_vector++;
    if (stack_vector->a_type != AT_PAGESZ) return 37;
    uint64_t old = stack_vector->a_un.a_val;
    stack_vector->a_un.a_val = old + 1;
    Vector saved;
    error = read_vector("/proc/self/auxv", &saved);
    stack_vector->a_un.a_val = old;
    if (error || saved.size != original.size || memcmp(saved.entries, original.entries, original.size)) return 38;
    int ready[2], resume[2];
    if (pipe(ready) || pipe(resume)) return 39;
    pid_t child = fork();
    if (child < 0) return 40;
    if (!child) {
        close(ready[0]); close(resume[1]);
        if ((error = verify(&original))) _exit(error);
        char out[16], in[16], padding[257];
        snprintf(out, sizeof out, "%d", ready[1]); snprintf(in, sizeof in, "%d", resume[0]);
        memset(padding, 'p', sizeof padding - 1); padding[sizeof padding - 1] = 0;
        execl("/data/local/tmp/probe/exec-probe", "exec-probe", "--exec", out, in, padding, NULL);
        _exit(41);
    }
    close(ready[1]); close(resume[0]);
    char byte;
    if (read(ready[0], &byte, 1) != 1 || byte != 'R') return 42;
    char child_path[96]; snprintf(child_path, sizeof child_path, "/proc/%d/auxv", child);
    Vector remote;
    if ((error = read_vector(child_path, &remote))) return error;
    if (value(&remote, AT_PAGESZ) != old || value(&remote, AT_EXECFN) == value(&original, AT_EXECFN)) return 43;
    if (write(resume[1], "G", 1) != 1) return 44;
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 45;
    close(ready[0]); close(resume[1]);
    puts("PASS original Bionic auxiliary vector: values, aliases, thread, saved snapshot, fork, exec and remote process");
    return 0;
}
