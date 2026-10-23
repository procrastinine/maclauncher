#pragma once
#include "frame.hpp"
#include "lsfg.hpp"
#import <QuartzCore/CAMetalLayer.h>
#include <optional>
namespace macfx {
struct PresenterConfig {SpatialMethod method=SpatialMethod::Bilinear;FrameOrigin origin=FrameOrigin::TopLeft;std::optional<LsfgConfig>generation;double sourceFrameRate=0;bool flipY=false;std::optional<AdaptivePacingConfig>adaptive;};
struct PresenterStatus {
 uint64_t submitted=0,encoded=0,completedReal=0,presentedReal=0,presentedGenerated=0,dropped=0,lastPresentedFrame=0;
 unsigned pending=0,maxPending=0;double lastLatencyMs=0;bool stopped=false;std::string reason;AdaptivePacingStatus adaptive;
};
class FramePresenter {
public:
 FramePresenter(CAMetalLayer*,void*owner,const PresenterConfig &config = PresenterConfig{});~FramePresenter();
 // Source producer dependencies must already be encoded into this unsubmitted
 // retained buffer. The host commits it; this object owns final presentation.
 FrameResult submit(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime);
 PresenterStatus snapshot()const;void stop();
private:struct Impl;std::shared_ptr<Impl>impl;
};
}
