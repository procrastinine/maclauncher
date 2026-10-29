#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
enum { ML_XESS_VERSION=1,ML_XESS_SLOTS=3 };
enum MLXessBridgeCommand {ML_XESS_INIT,ML_XESS_NEXT,ML_XESS_READY,ML_XESS_BIND,ML_XESS_INGRESS,ML_XESS_EGRESS,ML_XESS_FAILURE};
enum MLXessMessageCommand {ML_XESS_HELLO=1,ML_XESS_CONFIGURE,ML_XESS_FRAME,ML_XESS_CLOSE,ML_XESS_ADMIT};
typedef struct MLXessMapping {uint64_t address,bytes;uint32_t rowPitch,reserved;} MLXessMapping;
// Image addresses belong only to the helper's D3D12 mapped allocations. The
// native bridge aliases these pages as Metal buffers; pixels are copied by GPU.
typedef struct MLXessCall {
    uint32_t size,version,command,slot;
    uint32_t inputWidth,inputHeight,outputWidth,outputHeight,flags,reset;
    int32_t status,process;
    uint64_t request,frameId;
    float jitterX,jitterY;
    MLXessMapping mappings[5];
    uint64_t allocationBytes;
    double sourceCopyMs,inputCopyMs,inferenceMs,outputCopyMs;
    char endpoint[256],message[512];
} MLXessCall;
#if defined(_WIN32)
#include <windows.h>
typedef LONG (WINAPI *MLXessBridge)(unsigned,MLXessCall*);
#endif
