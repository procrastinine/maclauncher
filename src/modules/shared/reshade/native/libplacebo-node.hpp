#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include "shader-scene-inputs.h"
// This optional provider is loaded only after checking its architecture and
// macOS requirement. The loader remains alive until every node is retired.
extern "C" uint32_t rsLibplaceboNodeABI();
// Optional ABI-1 extension for owned libplacebo image-filter descriptors.
extern "C" uint32_t rsLibplaceboImageFiltersABI();
// Optional call-local companion. The caller clears it after prepare/encode;
// accepted work retains its exact frame lease until both GPU owners retire.
extern "C" uint32_t rsLibplaceboSceneInputsAPI();
extern "C" int rsLibplaceboBindSceneInputs(macfx::ShaderNode *,const RSShaderSceneInputsV1 *);
extern "C" macfx::ShaderNode *rsCreateLibplaceboShaderNode(const macfx::ShaderSpec *);
// Optional ABI-1 extension: an independent parameter view may share the
// accepted pipeline/history without modifying that node's parameter snapshot.
extern "C" macfx::ShaderNode *rsCloneLibplaceboShaderNode(const macfx::ShaderNode *, const macfx::ShaderParameters *);
extern "C" macfx::ShaderNode *rsCreateLibplaceboScalerNode(const char *name);
// Optional ABI-1 extension; metadata belongs to this node's immutable view.
extern "C" int rsSetLibplaceboNodeColor(macfx::ShaderNode *, const macfx::ImageColorDescription *);
extern "C" const char *rsLibplaceboFilters();
extern "C" const char *rsLibplaceboLastError();
// Optional ABI-1 extension for serialized offline frames. Query after the
// frame command buffer completes. A nonzero result reports the node's latched
// asynchronous failure even when output was repaired to a valid passthrough.
extern "C" int rsLibplaceboNodeCompletion(const macfx::ShaderNode *, char *error, size_t capacity);
// Optional ABI-1 extension. Prepared only on the graph resource worker and
// requested only for an affected adaptive interval. A valid request calls its
// completion exactly once, including rejected/cancelled attempts. Zero
// nanoseconds means no valid GPU measurement.
struct RSLibplaceboGpuTimingRequest {
    uint32_t size=sizeof(RSLibplaceboGpuTimingRequest),version=1;
    uint64_t token=0;void *context=nullptr;
    void (*completed)(void *,uint64_t token,uint64_t frameId,uint64_t nanoseconds)=nullptr;
};
extern "C" uint32_t rsLibplaceboGpuTimingABI();
extern "C" int rsPrepareLibplaceboNodeGpuTiming(macfx::ShaderNode *);
// Returns 0 for encoded, 1 for rejected, 2 for busy.
extern "C" int rsEncodeLibplaceboNodeGpuTimed(macfx::ShaderNode *,const macfx::ShaderFrame *,const RSLibplaceboGpuTimingRequest *,char *error,size_t capacity);
extern "C" const char *rsLibplaceboInspect(const char *file);
