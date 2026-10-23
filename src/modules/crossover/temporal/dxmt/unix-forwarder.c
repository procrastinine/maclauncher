// Only the temporal dispatch entry is adapted; all other Wine/Metal entrypoints
// retain the selected runtime's implementation and shader compiler.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#define WINEMETAL_API
#include "winemetal_thunks.h"

typedef int (*MLUnixCall)(void *);
typedef int (*MLCameraSetter)(void *, void *, const RSTemporalCamera *);
MLUnixCall __wine_unix_call_funcs[ML_UNIX_CALL_COUNT];
MLUnixCall __wine_unix_call_wow64_funcs[ML_UNIX_CALL_COUNT];
static MLUnixCall originalTemporal;
static MLCameraSetter setCamera;
static pthread_once_t resolveCamera = PTHREAD_ONCE_INIT;

static void resolve_camera(void) {
  setCamera = (MLCameraSetter)dlsym(RTLD_DEFAULT, "rsSetTemporalCamera");
}
static int temporal(void *data) {
  struct unixcall_mtlcommandbuffer_temporal_scale *params = data;
  const struct WMTFXTemporalScalerProps *props = params->props.ptr;
  pthread_once(&resolveCamera, resolve_camera);
  if (setCamera) setCamera((void *)params->scaler, (void *)params->cmdbuf,
      props->camera.size == sizeof(RSTemporalCamera) ? &props->camera : NULL);
  return originalTemporal(data);
}
static int unavailable(void *data) { (void)data; return (int)0xc0000135; }

__attribute__((constructor)) static void initialize_forwarder(void) {
  for (unsigned i = 0; i < ML_UNIX_CALL_COUNT; ++i)
    __wine_unix_call_funcs[i] = __wine_unix_call_wow64_funcs[i] = unavailable;
  const char *path = getenv("MACLAUNCHER_DXMT_BASE_LIBRARY");
  void *base = path && path[0] == '/' ? dlopen(path, RTLD_NOW | RTLD_LOCAL) : NULL;
  MLUnixCall *native = base ? dlsym(base, "__wine_unix_call_funcs") : NULL;
  MLUnixCall *wow64 = base ? dlsym(base, "__wine_unix_call_wow64_funcs") : NULL;
  if (!native || !wow64 || native == __wine_unix_call_funcs || !native[58]) {
    fprintf(stderr, "DXMT camera bridge requires its matching original Metal library.\n");
    return;
  }
  memcpy(__wine_unix_call_funcs, native, sizeof(__wine_unix_call_funcs));
  memcpy(__wine_unix_call_wow64_funcs, wow64, sizeof(__wine_unix_call_wow64_funcs));
  originalTemporal = native[58];
  __wine_unix_call_funcs[58] = temporal;
  // 32-bit clients retain their existing descriptor layout and are forwarded.
}
