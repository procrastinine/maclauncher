#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "xess-protocol.h"
#include <string.h>
enum {ML_XESS_FLAG_FRAME_GENERATION=0x80000000u,ML_XESS_FLAG_GENERATION_HDR10=0x20000000u,ML_XESS_FLAG_GENERATED=0x40000000u};
typedef struct MLXessGenerationConstants {float view[16],projection[16],renderTimeMs;uint32_t reserved;} MLXessGenerationConstants;
// FRAME success messages carry typed input constants in the existing reserved
// message space. HELLO/configuration/errors retain their original text ABI.
// For FG completion replies, inferenceMs is backend wall time through its GPU
// output fences; it is not a GPU timestamp or an engine-latency measurement.
static inline MLXessGenerationConstants mlXessGenerationConstants(const MLXessCall *call){MLXessGenerationConstants value;memcpy(&value,call->message,sizeof(value));return value;}
static inline void mlXessSetGenerationConstants(MLXessCall *call,const MLXessGenerationConstants *value){memset(call->message,0,sizeof(call->message));memcpy(call->message,value,sizeof(*value));}
#if defined(__cplusplus)
static_assert(sizeof(MLXessGenerationConstants)<=sizeof(MLXessCall::message));
#endif
