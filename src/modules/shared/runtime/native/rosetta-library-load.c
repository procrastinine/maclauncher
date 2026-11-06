/* SPDX-License-Identifier: MIT */
#define _DARWIN_C_SOURCE 1
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if !defined(__x86_64__)
#error This helper must run as x86_64 to load the translated library closure.
#endif

static double
milliseconds(void)
{
   struct timespec value;
   if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
   return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

/* Error bytes are escaped independently; paths remain the caller's metadata. */
static void
json_error(FILE *out, const char *message)
{
   fputc('"', out);
   for (const unsigned char *p = (const unsigned char *)message; *p; ++p) {
      if (*p == '"' || *p == '\\') fprintf(out, "\\%c", *p);
      else if (*p < 32 || *p >= 127) fprintf(out, "\\u%04x", *p);
      else fputc(*p, out);
   }
   fputc('"', out);
}

/* The caller supplies verified final installed paths and controls cancellation.
 * No Vulkan or Metal entrypoint is invoked by this helper. */
int
main(int argc, char **argv)
{
   const double started = milliseconds();
   if (argc < 2) return 64;
   void **handles = calloc((size_t)argc - 1, sizeof(*handles));
   double *times = calloc((size_t)argc - 1, sizeof(*times));
   if (!handles || !times) { free(handles); free(times); return 71; }

   /* Library initializers may print; keep the result channel separate. */
   int report_fd = dup(STDOUT_FILENO);
   if (report_fd < 0) { free(handles); free(times); return 71; }
   FILE *report = fdopen(report_fd, "w");
   if (!report || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
      if (report) fclose(report); else close(report_fd);
      free(handles); free(times); return 71;
   }

   unsigned loaded = 0, attempted = 0;
   int failed = -1;
   char *error = NULL;
   for (int i = 1; i < argc; ++i) {
      double begin = milliseconds();
      struct stat info;
      if (argv[i][0] != '/') {
         error = strdup("Library path must be absolute.");
      } else if (stat(argv[i], &info)) {
         error = strdup(strerror(errno));
      } else if (!S_ISREG(info.st_mode)) {
         error = strdup("Library path must name a regular file.");
      } else {
         dlerror();
         handles[loaded] = dlopen(argv[i], RTLD_NOW | RTLD_LOCAL);
         if (!handles[loaded]) {
            const char *detail = dlerror();
            error = strdup(detail ? detail : "Library loading failed.");
         }
      }
      times[attempted++] = milliseconds() - begin;
      if (!handles[loaded]) { failed = i - 1; break; }
      ++loaded;
   }

   const double load_ms = milliseconds() - started;
   /* Keep the whole closure loaded until every requested library was tried. */
   for (unsigned i = loaded; i; --i) dlclose(handles[i - 1]);
   fprintf(report, "{\"rosetta_library_load\":1,\"architecture\":\"x86_64\","
      "\"requested\":%d,\"loaded\":%u,\"failed_index\":%d,\"load_ms\":%.3f,\"libraries_ms\":[",
      argc - 1, loaded, failed, load_ms);
   for (unsigned i = 0; i < attempted; ++i) fprintf(report, "%s%.3f", i ? "," : "", times[i]);
   fputs("],\"error\":", report);
   if (failed >= 0) json_error(report, error ? error : "Library loading failed.");
   else fputs("null", report);
   fputs("}\n", report);
   int result = failed < 0 && !ferror(report) ? 0 : 1;
   if (fclose(report) && !result) result = 1;
   free(error); free(times); free(handles);
   return result;
}
