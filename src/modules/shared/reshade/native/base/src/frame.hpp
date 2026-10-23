#pragma once
#include "spatial.hpp"

namespace macfx {
struct FrameResult {
    bool encoded = false;
    bool effects = false;
    bool scaled = false;
    SpatialStatus scaling;
    std::string reason;
    bool busy = false;
};
// The host owns producer synchronization, command submission and presentation.
// Sources remain unchanged when output is distinct. No CPU image transfer occurs.
// Stop new submissions for this identity before release. In-flight encoded GPU
// resources remain retained by their command buffers.
void releaseFrameOwner(void *owner);
FrameResult processFrame(void *owner, id<MTLCommandBuffer> commands,
    const SpatialFrame &frame, SpatialMethod method = SpatialMethod::Bilinear);
}
