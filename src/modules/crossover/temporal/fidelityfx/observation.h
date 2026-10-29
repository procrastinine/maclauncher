#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <ffx_api/ffx_upscale.h>
#include <ffx_api/vk/ffx_api_vk.h>
#ifdef _WIN32
#define ML_FFX_CALL __cdecl
#else
#define ML_FFX_CALL
#endif
// This table belongs to the PE proxy, not the FFX SDK or a native ICD. All
// handles/callbacks retain their Windows ABI. A Wine owner must unwrap them
// before constructing the separate native recorded-operation contract.
typedef struct MLFfxUpscaleObservationV1 {
 uint32_t size,version;
 void* originalContext;
 uint64_t contextId,contentId;
 struct ffxCreateContextDescUpscale create;
 struct ffxCreateBackendVKDesc backend;
 struct ffxDispatchDescUpscale dispatch;
} MLFfxUpscaleObservationV1;
typedef struct MLFfxObserverV1 {
 uint32_t size,version;
 void* storage;
 void (ML_FFX_CALL *retain)(void*);
 void (ML_FFX_CALL *release)(void*);
 // Borrowed until return, after genuine successful original dispatch.
 // Recording only: never authorizes omission or changes the FFX result.
 void (ML_FFX_CALL *observed)(void*,const MLFfxUpscaleObservationV1*);
 void (ML_FFX_CALL *destroyed)(void*,uint64_t contextId,void* originalContext);
} MLFfxObserverV1;
typedef struct MLFfxObservationAPIV1 {
 uint32_t size,version;
 int (ML_FFX_CALL *setObserver)(const MLFfxObserverV1*);
} MLFfxObservationAPIV1;
