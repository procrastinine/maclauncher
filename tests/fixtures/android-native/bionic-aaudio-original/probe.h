#pragma once
#include <jni.h>
#include <stdatomic.h>
#include <stdint.h>
typedef struct{
 JavaVM *vm;void *stream;
 _Atomic int callbacks,failures,tls_retired;
 int32_t callback_tid;
 int32_t observed_errno,flush_result,timestamp_result,hardware_rate,hardware_channels;
 _Atomic int goal;
 int32_t other_continued;
 int32_t loader_detached_before,loader_detached_after,loader_constructor_detached;
 int32_t loader_value,loader_closed,loader_tid;
 char loader_error[256];
} AAudioProbeCall;
JavaVM *aaudio_original_probe_vm(void);
