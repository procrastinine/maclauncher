#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
// This optional provider is loaded only after checking its architecture and
// macOS requirement. The loader remains alive until every node is retired.
extern "C" uint32_t rsLibplaceboNodeABI();
extern "C" macfx::ShaderNode *rsCreateLibplaceboShaderNode(const macfx::ShaderSpec *);
extern "C" macfx::ShaderNode *rsCreateLibplaceboScalerNode(const char *name);
extern "C" const char *rsLibplaceboFilters();
extern "C" const char *rsLibplaceboLastError();
// Optional ABI-1 extension for serialized offline frames. Query after the
// frame command buffer completes. A nonzero result reports the node's latched
// asynchronous failure even when output was repaired to a valid passthrough.
extern "C" int rsLibplaceboNodeCompletion(const macfx::ShaderNode *, char *error, size_t capacity);
extern "C" const char *rsLibplaceboInspect(const char *file);
