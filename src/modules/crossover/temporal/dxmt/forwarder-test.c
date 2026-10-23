#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define WINEMETAL_API
#include "winemetal_thunks.h"
typedef int (*MLUnixCall)(void *);

#ifdef ML_TEST_BASE
MLUnixCall __wine_unix_call_funcs[146], __wine_unix_call_wow64_funcs[146];
static unsigned calls;
unsigned MLTestGetCallCount(void) { return calls; }
static int forward(void *data) { (void)data; return 0x77; }
static int temporal(void *data) { (void)data; ++calls; return 0x1234; }
__attribute__((constructor)) static void initialize(void) {
  for (unsigned i = 0; i < 146; ++i)
    __wine_unix_call_funcs[i] = __wine_unix_call_wow64_funcs[i] = forward;
  __wine_unix_call_funcs[58] = __wine_unix_call_wow64_funcs[58] = temporal;
}
#else
static RSTemporalCamera captured;
static unsigned binds, clears;
static void *owner, *commands;
int rsSetTemporalCamera(void *scaler, void *buffer, const RSTemporalCamera *camera) {
  owner = scaler; commands = buffer;
  if (camera) { captured = *camera; ++binds; } else { captured = (RSTemporalCamera){0}; ++clears; }
  return 0;
}
int main(int argc, char **argv) {
  assert(argc == 3);
  setenv("MACLAUNCHER_DXMT_BASE_LIBRARY", argv[2], 1);
  void *wrapper = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL); if (!wrapper) { puts(dlerror()); return 1; }
  void *base = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL); assert(base);
  MLUnixCall *native = dlsym(wrapper, "__wine_unix_call_funcs");
  MLUnixCall *wow64 = dlsym(wrapper, "__wine_unix_call_wow64_funcs");
  unsigned (*count)(void) = dlsym(base, "MLTestGetCallCount");
  assert(native && wow64 && count);
  struct WMTFXTemporalScalerProps props = {0};
  props.camera = (RSTemporalCamera){.size = sizeof(RSTemporalCamera), .version = 1,
      .frameId = 17, .viewportId = 29, .nearPlane = .5f, .farPlane = 400.f,
      .verticalFov = 1.1f, .frameTimeMs = 12.5f};
  struct unixcall_mtlcommandbuffer_temporal_scale args = {0};
  args.scaler = 0x123450; args.cmdbuf = 0x678900; args.props.ptr = &props;
  assert(native[58](&args) == 0x1234 && count() == 1);
  assert(binds == 1 && clears == 0 && owner == (void *)args.scaler && commands == (void *)args.cmdbuf);
  assert(captured.frameId == 17 && captured.viewportId == 29 && captured.nearPlane == .5f && captured.frameTimeMs == 12.5f);
  props.camera = (RSTemporalCamera){0};
  assert(native[58](&args) == 0x1234 && count() == 2 && binds == 1 && clears == 1);
  assert(wow64[58](&args) == 0x1234 && count() == 3 && binds == 1 && clears == 1);
  assert(native[0](NULL) == 0x77 && wow64[145](NULL) == 0x77);
  puts("DXMT camera binding, missing-camera clearing, native forwarding and unchanged WoW64 forwarding passed");
  return 0;
}
#endif
