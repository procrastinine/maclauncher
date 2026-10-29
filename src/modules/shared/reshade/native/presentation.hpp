#pragma once
#include "frame.hpp"
#include "frame-depth.hpp"
#include "target-time.h"
#include "lsfg.hpp"
#include "presentation-hold.hpp"
#include "runtime-status.hpp"
#include "color-contract.hpp"
#include "presentation-content.h"
#include "effects-execution.hpp"
#import <QuartzCore/CAMetalLayer.h>
#include <optional>
namespace macfx {
struct PresenterConfig {SpatialMethod method=SpatialMethod::Bilinear;FrameOrigin origin=FrameOrigin::TopLeft;std::optional<LsfgConfig>generation;double sourceFrameRate=0;bool flipY=false;std::optional<AdaptivePacingConfig>adaptive;std::string generationMethod="lsfg";RuntimeFrameSource frameSource=RuntimeFrameSource::Unknown;std::optional<ImageColorSpace>sourceColorSpace;std::optional<ImageColorDescription>sourceColor;float displayHeadroom=1;std::optional<bool>sourceOpaque;};
enum class PresenterPreparation {Ready,Working,Unavailable};
struct PresenterStatus {
 uint64_t submitted=0,encoded=0,completedReal=0,presentedReal=0,presentedGenerated=0,dropped=0,lastPresentedFrame=0;
 unsigned pending=0,maxPending=0;double lastLatencyMs=0;bool stopped=false;std::string reason;AdaptivePacingStatus adaptive;
};
class SceneWindowAuthority;
class FramePresenter {
public:
 FramePresenter(CAMetalLayer*,void*owner,const PresenterConfig &config = PresenterConfig{});~FramePresenter();
 // Source producer dependencies must already be encoded into this unsubmitted
 // retained buffer. The host commits it; this object owns final presentation.
 FrameResult submit(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime);
 FrameResult submitAtTime(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target);
 // A null target observes immediate real output, including generated chains.
 FrameResult submitAtTimeObserved(id<MTLCommandBuffer>,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target,const RSPresentationObserver*);
 FrameResult submitContent(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,double,const RSPresentationContent&,const RSPresentationObserver*,const RSPresentationTarget*target=nullptr);
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
 void setDisplayHeadroom(float);
 void setFrameSource(RuntimeFrameSource);
 // Unknown visibility remains usable. Hosts set false only for a confirmed
 // hidden output window, preserving the displayed image and prepared graph.
 void setOutputVisible(bool);
 void setPreparationObserver(EffectPreparationObserver);
 void setSceneWindow(std::shared_ptr<const SceneWindowAuthority>);
 PresenterPreparation preparationState()const;
private:struct Impl;std::shared_ptr<Impl>impl;
};
}
