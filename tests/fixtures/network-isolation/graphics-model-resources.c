#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int readable(const char *file) {
  char bytes[16] = {0};
  int fd = open(file, O_RDONLY);
  if (fd < 0) { perror("model read"); return 0; }
  ssize_t size = read(fd, bytes, sizeof(bytes));
  close(fd);
  return size == 5 && memcmp(bytes, "model", 5) == 0;
}

static int denied(const char *file, int flags) {
  int fd = open(file, flags, 0600);
  if (fd >= 0) { close(fd); fprintf(stderr, "unexpected file access\n"); return 0; }
  return errno == EPERM || errno == EACCES;
}

int main(int argc, char **argv) {
  if (argc != 7 && argc != 8) return 2;
  if (argc == 8) {
    if (strcmp(argv[7], "wait") != 0) return 2;
    puts("ready"); fflush(stdout);
    if (getchar() != 'x') return 7;
  }
  if (!readable(argv[1]) || !readable(argv[2])) return 3;
  if (!denied(argv[3], O_RDONLY) || !denied(argv[4], O_RDONLY)) return 4;
  if (!denied(argv[1], O_WRONLY) || !denied(argv[2], O_WRONLY)) return 5;
  if (!denied(argv[5], O_WRONLY | O_CREAT | O_EXCL) || !denied(argv[6], O_WRONLY | O_CREAT | O_EXCL)) return 6;
  puts("Live model stores are readable; neighboring data and model writes are denied");
  return 0;
}
