#pragma once
#include <jni.h>
#include <stdatomic.h>
#include <stdint.h>
typedef struct {
 JavaVM *vm;
 int callbacks,legacy,vsync,refresh,refresh_self,delayed,reposted,failures,detached,thread_retired;
 int64_t expected_period;
 int owner_tid,callback_tid;
 int surface_symbols,fallback_calls,missing_lookup;
} ChoreographerProbeCall;
