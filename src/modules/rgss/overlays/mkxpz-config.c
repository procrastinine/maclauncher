// MacLauncher MKXP-Z config isolation helper, MIT.
// Interpose only the selected child's bundle config-directory transition.
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int active;
static char source_directory[PATH_MAX];
static char target_directory[PATH_MAX];

static void fail(const char *message) {
  fprintf(stderr, "MacLauncher MKXP-Z config helper: %s\n", message);
  _exit(78);
}

__attribute__((constructor)) static void configure(void) {
  const char *expected = getenv("MACLAUNCHER_MKXPZ_CONFIG_EXECUTABLE");
  const char *source = getenv("MACLAUNCHER_MKXPZ_CONFIG_SOURCE");
  const char *target = getenv("MACLAUNCHER_MKXPZ_CONFIG_TARGET");
  if (!expected || !source || !target) return;
  char executable[PATH_MAX], canonical[PATH_MAX];
  uint32_t length = sizeof(executable);
  if (_NSGetExecutablePath(executable, &length) != 0 || !realpath(executable, canonical)) return;
  // Inherited injections cannot redirect another executable or the launcher.
  if (strcmp(canonical, expected) != 0) return;

  char derived[PATH_MAX];
  if (strlen(expected) >= sizeof(derived)) fail("selected executable path is too long");
  strcpy(derived, expected);
  char *suffix = strrchr(derived, '/');
  if (!suffix) fail("invalid selected executable path");
  *suffix = '\0';
  suffix = strrchr(derived, '/');
  if (!suffix || strcmp(suffix, "/MacOS") != 0) fail("selected executable is outside Contents/MacOS");
  strcpy(suffix, "/Game");
  if (realpath(derived, canonical)) strcpy(derived, canonical);
  // A missing publisher Game directory is valid: the child starts in its
  // private config directory, and the exact failed source transition redirects.
  if (strcmp(derived, source) != 0) fail("config source does not match the selected runtime");
  if (!realpath(target, canonical) || strcmp(canonical, target) != 0) fail("private config directory changed");
  struct stat info;
  if (stat(target, &info) != 0 || !S_ISDIR(info.st_mode)) fail("private config directory is unavailable");
  if (strlen(source) >= sizeof(source_directory) || strlen(target) >= sizeof(target_directory)) fail("config path is too long");
  strcpy(source_directory, source);
  strcpy(target_directory, target);
  active = 1;
}

static int config_chdir(const char *requested) {
  if (active && requested) {
    char canonical[PATH_MAX];
    const char *candidate = realpath(requested, canonical) ? canonical : requested;
    if (strcmp(candidate, source_directory) == 0) {
      if (chdir(target_directory) != 0) fail("cannot enter the private config directory");
      return 0;
    }
  }
  return chdir(requested);
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} config_interpose __attribute__((section("__DATA,__interpose"))) = {
  (const void *)config_chdir, (const void *)chdir
};
