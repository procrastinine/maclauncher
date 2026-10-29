#pragma once
#include "frame-depth.hpp"
namespace macfx {
// Known affine image resizing can retain resolved same-frame depth. The caller
// owns the output lease and command submission; no frame history is invented.
class DepthResampler {
    id<MTLDevice> device;
    id<MTLComputePipelineState> color,depth;
public:
    explicit DepthResampler(id<MTLDevice>);
    bool encode(id<MTLCommandBuffer>,const DepthFrame &,id<MTLTexture> output,FrameOrigin outputOrigin,std::string &reason,float jitterX=0,float jitterY=0);
};
}
