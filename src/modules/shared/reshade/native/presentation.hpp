#pragma once
#include "frame.hpp"
#include "frame-depth.hpp"
#include "target-time.h"
#include "lsfg.hpp"
#include "presentation-hold.hpp"
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
 FrameResult submitAtTime(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target);
 // A null target observes immediate real output, including generated chains.
 FrameResult submitAtTimeObserved(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target,const RSPresentationObserver*);
 FrameResult submitWithDepth(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,const DepthFrame&);
 FrameResult submitDisplayFrame(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,bool opaque,const DepthFrame*depth=nullptr);
 RSPresentationTiming timingSnapshot()const;
 PresenterStatus snapshot()const;
 // Accepted scene inputs remain required while a live replacement validates.
 bool requiresDepth()const;
 bool terminalGpuFailure()const;
 bool gpuFailureMatchesCurrent(unsigned outputWidth,unsigned outputHeight,MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,id<MTLDevice> sourceDevice=nil);
 PresentationHoldStatus beginPresentationHold(const PresentationHoldCommand &);
 PresentationHoldStatus resumePresentationHold(const PresentationHoldCommand &);
 PresentationHoldStatus presentationHoldStatus()const;
 bool presentationHeld()const;
 // Automatic native Metal supplies this actual renderer capability. Explicit,
 // CGL and remote presenters retain their conservative default.
 void setNativeMetalCapabilities(bool sameSizeFxInPlace,bool ownedSourceSupported,bool presentationRequired=false);
 // Opt-in, temporary image-first source activation. Replay retains the exact
 // completed final pixels/identity; it never reruns effects or generation.
 void retainCompletedFrameForReplay(bool);
 bool completedFrameReplayReady()const;
 bool replayCompletedFrame();
 double lastRealPresentedTime()const;
 uint64_t lastRealCompletedFrameId()const;
 void stop();void setDisplay(uint32_t displayId);
private:struct Impl;std::shared_ptr<Impl>impl;
};
}
