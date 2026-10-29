#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#if __has_include("temporal-scene-copy-boundary.h")
#include "temporal-scene-copy-boundary.h"
#else
#include "../temporal/scene-copy-boundary.h"
#endif
namespace macfx {
void installSceneCopyBoundaryHooks(id<MTLCommandBuffer>);
class SceneBoundaryOutput {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 SceneBoundaryOutput();~SceneBoundaryOutput();
 ShaderResult prepare(id<MTLDevice>,MTLPixelFormat,bool preserveTargetAlpha=false);
 ShaderResult encode(id<MTLCommandBuffer>,id<MTLTexture>processed,id<MTLTexture>source,id<MTLTexture>target,unsigned sourceX,unsigned sourceY,unsigned targetX=0,unsigned targetY=0,unsigned width=0,unsigned height=0);
};
}
