#pragma once
#include "frame.hpp"
#include "live-controls.hpp"
namespace macfx {
struct DepthFrame {
    id<MTLTexture> texture;
    uint64_t frameId;
    FrameOrigin origin;
};
// Cached per owner and dimensions; no depth capture/allocation for color effects.
bool frameRequiresDepth(void *owner, id<MTLDevice>, unsigned width, unsigned height);
FrameResult processFrameWithDepth(void *owner, id<MTLCommandBuffer>,
    const SpatialFrame &, SpatialMethod, const DepthFrame *);
FrameResult processFrameWithDepth(void *owner, id<MTLCommandBuffer>,
    const SpatialFrame &, SpatialMethod, const DepthFrame *, bool opaqueDisplay);
struct EffectPlanSnapshot;
// Internal held-only contract. Normal callers retain their existing fallback.
// Inputs/receipt never escape the synchronous encoding call or enter a C ABI.
struct FrameEncodingInputs {
    std::shared_ptr<const EffectPlanSnapshot> plan;
    std::string controlsDigest;
    bool refreshControls=false;
};
struct FrameEncodingReceipt {
    std::string planRevision,controlsDigest;
    EffectSelection selection;
    uint64_t controlsGeneration=0;
    bool advanced=false,afterScaling=false;
};
FrameResult processFrameWithDepth(void *owner,id<MTLCommandBuffer>,const SpatialFrame &,SpatialMethod,
    const DepthFrame *,bool opaqueDisplay,const FrameEncodingInputs &,FrameEncodingReceipt &);
FrameResult processFrameWithDepth(void *owner,id<MTLCommandBuffer>,const SpatialFrame &,SpatialMethod,
    const DepthFrame *,bool opaqueDisplay,const FrameEncodingInputs *,FrameEncodingReceipt *);
}
