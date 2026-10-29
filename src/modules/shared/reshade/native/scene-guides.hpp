#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "../temporal/frame.h"
#endif
#include <atomic>
#include <mutex>

namespace macfx {
struct SceneGuideTargets {
    id<MTLTexture> depth=nil,motion=nil,exposure=nil,reactive=nil,transparency=nil;
    unsigned width=0,height=0;
};

// The caller owns image admission, scratch lifetime, producer dependencies and
// command submission. Prepare pipelines before the rendering callback. Encode
// only writes supplied textures and appends commands; it never allocates images,
// submits, waits, or reads pixels on the CPU.
class SceneGuideEncoder {
    id<MTLDevice> device;
    id<MTLComputePipelineState> color,depth;
    std::mutex preparation;
    std::atomic<bool> ready{false};
public:
    explicit SceneGuideEncoder(id<MTLDevice>);
    ShaderResult prepare();
    // Initialize normalized from the desired frame contract before this call.
    // Color/output pointers, their offsets, owner, commands, frame identity and
    // matrix authority remain caller-owned. Only guides, their offsets, render
    // extent, jitter, motion scale and OUTPUT_MOTION are normalized here.
    // Cropped masks share color coordinates in ABI 1; set the normalized color
    // origin to zero when supplying mask targets and bind the cropped/resized
    // color separately. Input mask cropping uses the original color origin.
    // Only supplied inputs receive targets. Depth-only, motion-only and
    // metadata-only scenes never acquire invented guide textures. Width/height
    // can explicitly name the normalized extent when no guide target exists.
    ShaderResult encode(id<MTLCommandBuffer>,const RSTemporalFrame&,
                        const SceneGuideTargets&,RSTemporalFrame& normalized,
                        float motionCorrectionX=0,float motionCorrectionY=0,bool removeMotionJitter=false,
                        bool colorJittered=true);
    // RGB unit conversion multiplies supplied exposure by its inverse gain.
    // Other guides and the source pre-exposure/timeline retain their meaning.
    ShaderResult encode(id<MTLCommandBuffer>,const RSTemporalFrame&,
                        const SceneGuideTargets&,RSTemporalFrame&,float,float,bool,bool,float exposureScale);
};
}
