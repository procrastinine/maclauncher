#include "browser-frame.hpp"
#include "browser-frame-policy.hpp"
#include "graphics.hpp"
#include "effects-plan.hpp"
#include "live-controls.hpp"
#include "presentation.hpp"
#include "image-admission.hpp"
#include "presentation-internal.hpp"
#include "presentation-hold.hpp"
#include "runtime-status.hpp"
#include "diagnostics.hpp"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>
#include <atomic>
#include <array>
#include <cstring>
#include <cctype>
#include <fcntl.h>
#include <mutex>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
inline bool sameGeometry(const macfx::BrowserFrameGeometry &a,const macfx::BrowserFrameGeometry &b)noexcept {
    return a.x==b.x&&a.y==b.y&&a.width==b.width&&a.height==b.height&&a.pixelsWidth==b.pixelsWidth&&a.pixelsHeight==b.pixelsHeight;
}
// A failed resize may retry one fresh stream after the source settles. This is
// metadata only; Off and source changes discard the budget without any work.
struct Recovery {
    uint32_t window=0;bool armed=false,spent=false;macfx::BrowserFrameGeometry geometry{};double stableSince=0;
    void reset()noexcept{*this={};}
    void arm(uint32_t value,const macfx::BrowserFrameGeometry &g,double now)noexcept{
        if(window!=value){reset();window=value;}
        if(spent||!value||!macfx::browserFrameGeometryValid(g))return;
        armed=true;geometry=g;stableSince=now;
    }
    bool ready(uint32_t value,const macfx::BrowserFrameGeometry &g,double now)noexcept{
        if(!armed||spent||window!=value||!macfx::browserFrameGeometryValid(g)||!std::isfinite(now))return false;
        if(!sameGeometry(geometry,g)){geometry=g;stableSince=now;return false;}
        if(now<stableSince+.25)return false;
        spent=true;armed=false;return true;
    }
};
// The per-launch token is inherited only by the dedicated browser/helper tree.
// A separate mmap leaves the existing window-state ABI unchanged.
struct Channel {
    void *mapping=nullptr;std::once_flag opened;
    uint32_t *words(){return static_cast<uint32_t*>(mapping);}
    bool open(){
        std::call_once(opened,[&]{
        const char *file=getenv("RESHADE_BROWSER_FRAME_STATE"),*token=getenv("RESHADE_BROWSER_FRAME_TOKEN");
        const auto result=macfx::mapBrowserFrameChannel(file,token);mapping=result.mapping;
        if(file&&token&&macfx::diagnosticsEnabled())macfx::nativeLog("browser-channel pid="+std::to_string(getpid())+
            " stage="+result.stage+" errno="+std::to_string(result.error));
        });return mapping;
    }
    macfx::BrowserFrameChannelState state(){return {words()};}
    uint32_t window(){return open()?state().window():0;}
    bool processingAllowed(){return !open()||state().processingAllowed();}
    void observe(uint32_t value,bool full){if(open())state().observe(value,full);}
    void demand(uint32_t value,bool localWindow){if(open())state().demand(value,localWindow,uint32_t(getpid()));}
    macfx::BrowserFrameDemand demand(){return open()?state().demand():macfx::BrowserFrameDemand{};}
    bool probe(uint32_t value,uint32_t epoch){return open()&&state().probe(value,epoch);}
    bool eligible(uint32_t value){return open()&&state().eligible(value);}
    uint32_t claim(uint32_t value){return open()?state().claim(value,uint32_t(getpid())):0;}
    bool owns(uint32_t value,uint32_t ticket){return open()&&state().owns(value,ticket);}
    void release(uint32_t value,uint32_t ticket){if(open())state().release(value,ticket,uint32_t(getpid()));}
};
Channel &channel(){static auto *v=new Channel;return *v;}
std::string captureError(const char *phase,NSError *error){
    return std::string(phase)+" domain="+(error.domain.UTF8String?:"unknown")+" code="+std::to_string(error.code)+": "+(error.localizedDescription.UTF8String?:"Window capture failed");
}
bool transientConfigurationError(NSError *error){
    if(![error.domain isEqualToString:SCStreamErrorDomain])return false;
    return error.code==SCStreamErrorAttemptToConfigState||error.code==SCStreamErrorInvalidParameter||
        error.code==SCStreamErrorFailedApplicationConnectionInterrupted||error.code==SCStreamErrorInternalError;
}
struct PendingClaim {
    uint32_t window,ticket;
    ~PendingClaim(){if(ticket)channel().release(window,ticket);}
};
// The latest failed capture attempt for a selected window. While processing
// stays requested and no session runs for that window, its control tick
// records Failed with the current plan revision and this reason, so the plan
// does not wait without one. Main thread only.
struct Unavailable {uint32_t window=0;uintptr_t context=0;std::string reason,revision;double reportedAt=0;};
Unavailable &unavailable(){static auto *v=new Unavailable;return *v;}
void recordUnavailable(uint32_t window,const std::string &reason){
    auto &value=unavailable();value.window=window;value.reason=reason;value.revision.clear();value.reportedAt=0;
}
// A new attempt, a different window or Off ends the record. Off keeps the
// context that its pass-through acknowledgement now writes.
void clearUnavailable(uintptr_t keep=0){
    auto &value=unavailable();if(value.context&&value.context!=keep)macfx::retireRuntimeStatus(value.context);value={};
}
void failAttempt(uint32_t window,const std::string &reason){macfx::nativeLog(reason);recordUnavailable(window,reason);}
void reportUnavailable(NSWindow *window)noexcept{ // Metadata only; it never changes the window.
    auto &value=unavailable();if(!value.window||value.window!=uint32_t(window.windowNumber)||!macfx::runtimeStatusLeased())return;
    try{
        const auto plan=macfx::currentEffectPlan();if(!plan||plan->revision.empty())return;
        const double now=CACurrentMediaTime();if(value.revision==plan->revision&&now<value.reportedAt+1)return;
        const auto context=reinterpret_cast<uintptr_t>((__bridge void*)window);
        if(value.context&&value.context!=context)macfx::retireRuntimeStatus(value.context);
        value.context=context;value.revision=plan->revision;value.reportedAt=now;const auto controls=macfx::presentationControlsDigest();
        macfx::RuntimeStatusEvent event;event.context=context;event.processing=true;event.phase=macfx::RuntimeStatusPhase::Failed;
        event.planRevision=value.revision;event.controlsDigest=controls;event.reason=value.reason;macfx::observeRuntimeStatus(event);
    }catch(...){}
}
// Like the existing window-state constructor mapping, this must precede the
// Chromium helper sandbox. No stream/content enumeration/Metal resource starts.
__attribute__((constructor)) static void prepareBrowserFrameChannel(){
    if(getenv("RESHADE_BROWSER_FRAME_STATE")&&getenv("RESHADE_BROWSER_FRAME_TOKEN")){
        @autoreleasepool{@try{try{channel().open();}catch(...){}}@catch(NSException *exception){(void)exception;}}
    }
}
struct Sample {CMSampleBufferRef value=nullptr;uint64_t generation=0;explicit Sample(CMSampleBufferRef v,uint64_t g):value(v),generation(g){CFRetain(v);}~Sample(){CFRelease(value);}};
struct PixelLease {std::shared_ptr<Sample>sample;CVMetalTextureRef texture=nullptr;~PixelLease(){if(texture)CFRelease(texture);}};
struct Slot {id<MTLTexture>texture=nil;std::atomic<bool>busy{false};};
struct Session;
}
@interface MacFXBrowserOutputWindow : NSPanel
@end
@implementation MacFXBrowserOutputWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
@interface MacFXBrowserStream : NSObject<SCStreamOutput,SCStreamDelegate> {
@public std::weak_ptr<Session> session;
}
@end
namespace {
struct Session :std::enable_shared_from_this<Session> {
    __weak NSWindow *source=nil;
    MacFXBrowserOutputWindow *output=nil;CAMetalLayer *layer=nil;
    id<MTLDevice>device=nil;id<MTLCommandQueue>queue=nil,copyQueue=nil;bool copyQueueAttempted=false;
    SCStream *stream=nil;MacFXBrowserStream *receiver=nil;
    CVMetalTextureCacheRef cache=nullptr;
    dispatch_queue_t renderQueue=dispatch_queue_create("org.maclauncher.browser-frames",DISPATCH_QUEUE_SERIAL);
    dispatch_queue_t intakeQueue=dispatch_queue_create("org.maclauncher.browser-capture",DISPATCH_QUEUE_SERIAL);
    std::shared_ptr<macfx::FramePresenter>presenter;
    std::atomic<bool>retired{false},closed{false},ready{false},configuring{false},recoverAfterGeometry{false};
    std::atomic<double>configurationStarted{0};
    std::atomic<unsigned>width{0},height{0};std::atomic<uint64_t>geometryGeneration{1};std::atomic<double>geometryTime{0};
    std::atomic<uint64_t>completedGeneration{0},acceptedGeneration{0},firstAcceptedFrameId{0};uint64_t revealAfter=0;
    uint32_t window=0,claimTicket=0;uint64_t frame=0,delivery=0;double lastTime=0;
    struct RawInput{std::shared_ptr<Slot>slot;uint64_t contentId=0,generation=0;double pts=0;unsigned width=0,height=0;bool accepted=false;};
    std::optional<RawInput>raw;double contentTimeOrigin=0;bool replayRequested=false,retryScheduled=false;std::atomic<bool>replayQueued{false};
    macfx::BrowserFrameAttemptContract publication{};bool publicationRecorded=false;
    std::mutex pendingMutex;std::shared_ptr<Sample>pending;bool worker=false;
    std::array<std::shared_ptr<Slot>,3>slots;
    std::atomic<uint64_t>complete{0},idle{0},dropped{0};bool revealed=false;
    unsigned readinessRecords=0;double readinessStarted=CACurrentMediaTime(),readinessLast=0;
    uintptr_t visibilityView=0;bool visibilityActive=false;
    std::atomic<unsigned>diagnosticCompletions{0};
    macfx::BrowserFrameGeometry geometry;
    // Only renderQueue owns the asynchronous configuration transaction. A
    // serial dispatch queue alone does not serialize escaping SCK callbacks.
    macfx::BrowserFrameGeometry requestedGeometry;
    uint64_t requestedGeneration=0;unsigned configurationAttempts=0;bool configurationInFlight=false;
    double budgetRetryAt=0;macfx::TransientBound budgetPressure;
    // renderQueue: nonzero while complete images keep an unusable extent or
    // format for the settled configuration.
    uint64_t unusableEpoch=0,unusableEpochs=0;
    ~Session(){if(cache)CFRelease(cache);}
    void publishVisibility(bool inactive=false){ // Main thread; state edges only.
        if(!NSThread.isMainThread)return;
        NSWindow *windowSource=source;
        const auto view=reinterpret_cast<uintptr_t>((__bridge void*)windowSource.contentView);
        const bool active=!inactive&&!retired&&revealed&&view&&channel().owns(window,claimTicket)&&
            windowSource.visible&&!windowSource.miniaturized&&!NSApp.hidden&&windowSource.onActiveSpace&&
            output.visible&&output.onActiveSpace&&(output.occlusionState&NSWindowOcclusionStateVisible);
        bool value=false;uintptr_t identity=visibilityView;
        if(visibilityActive&&(!active||view!=visibilityView))visibilityActive=false;
        else if(active&&!visibilityActive){value=true;visibilityActive=true;visibilityView=identity=view;}
        else return;
        const char *token=getenv("RESHADE_BROWSER_FRAME_TOKEN");if(!token||strlen(token)!=32)return;
        for(unsigned i=0;i<32;++i)if(!isxdigit(static_cast<unsigned char>(token[i])))return;
        // A supported Electron local-notification subscriber can temporarily
        // retain source production under this exact owned cover. Record the
        // edge first: observers run synchronously and can close this session.
        NSString *name=[@"org.maclauncher.browser-frame-visibility." stringByAppendingString:@(token)];
        @try{[NSNotificationCenter.defaultCenter postNotificationName:name object:nil userInfo:@{@"schema":@1,@"pid":@(getpid()),
            @"nativeView":[NSString stringWithFormat:@"%llx",(unsigned long long)identity],@"active":@(value)}];}
        @catch(NSException *exception){(void)exception;} // An optional observer cannot stop graphics or the source.
    }
    void reportReadiness(const char *phase){ // Main thread, metadata only.
        if(!macfx::diagnosticsEnabled()||readinessRecords>=12||!presenter)return;
        const double now=CACurrentMediaTime();if(now-readinessStarted>5)return;
        if(readinessRecords&&now-readinessLast<.2&&!strcmp(phase,"poll"))return;
        ++readinessRecords;readinessLast=now;const auto status=presenter->snapshot();const auto size=layer.drawableSize;
        macfx::nativeLog("browser-readiness pid="+std::to_string(getpid())+" window="+std::to_string(window)+" phase="+phase+
            " elapsedMs="+std::to_string((now-readinessStarted)*1000)+" samples="+std::to_string(complete.load())+
            " encoded="+std::to_string(status.encoded)+" gpuCompletedReal="+std::to_string(status.completedReal)+
            " presentedReal="+std::to_string(status.presentedReal)+" presentedGenerated="+std::to_string(status.presentedGenerated)+
            " dropped="+std::to_string(status.dropped)+" ready="+std::to_string(ready.load())+" revealed="+std::to_string(revealed)+
            " generation="+std::to_string(geometryGeneration.load())+" completedGeneration="+std::to_string(completedGeneration.load())+
            " acceptedGeneration="+std::to_string(acceptedGeneration.load())+" firstAcceptedFrame="+std::to_string(firstAcceptedFrameId.load())+
            " finalCompletedFrame="+std::to_string(presenter->lastRealCompletedFrameId())+
            " outputVisible="+std::to_string(bool(output.visible))+" outputOcclusion="+std::to_string(output.occlusionState)+
            " sourceVisible="+std::to_string(bool(source.visible))+" drawable="+std::to_string(unsigned(size.width))+"x"+std::to_string(unsigned(size.height))+
            " layerBounds="+std::to_string(layer.bounds.size.width)+"x"+std::to_string(layer.bounds.size.height));
    }
    void fail(const std::string &reason,bool recover=false){
        if(retired)return;
        if(recover)recoverAfterGeometry=true;
        if(retired.exchange(true))return;
        const auto message="Browser completed-window graphics unavailable: "+reason+"; original window retained";
        macfx::nativeLog(message);
        auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{self->close();recordUnavailable(self->window,message);});
    }
    void close(){ // Main thread. Late stream and GPU callbacks retain only this retired session.
        if(closed.exchange(true))return;retired=true;ready=false;publishVisibility(true);channel().release(window,claimTicket);
        if(output.parentWindow)[output.parentWindow removeChildWindow:output];[output orderOut:nil];[output close];output=nil;
        auto self=shared_from_this();dispatch_async(renderQueue,^{
            if(self->presenter){self->presenter->setPreparationObserver({});self->presenter->stop();}self->raw.reset();self->replayRequested=false;
            {std::lock_guard<std::mutex>lock(self->pendingMutex);self->pending.reset();}
            SCStream *stream=self->stream;self->stream=nil;MacFXBrowserStream *receiver=self->receiver;
            if(stream)[stream stopCaptureWithCompletionHandler:^(NSError*){(void)receiver;}];
        });
    }
    SCStreamConfiguration *configuration(const macfx::BrowserFrameGeometry &g){
        auto config=[SCStreamConfiguration new];config.width=g.pixelsWidth;config.height=g.pixelsHeight;
        config.minimumFrameInterval=kCMTimeZero;config.pixelFormat=kCVPixelFormatType_32BGRA;
        config.queueDepth=3;config.showsCursor=NO;config.capturesAudio=NO;
        config.colorSpaceName=kCGColorSpaceSRGB;config.scalesToFit=YES;
        // ScreenCaptureKit source crops use logical points. The destination
        // and stream extent use pixels; no desktop mode or frame-rate change.
        config.sourceRect=CGRectMake(g.x,g.y,g.width,g.height);
        config.destinationRect=CGRectMake(0,0,g.pixelsWidth,g.pixelsHeight);
        if(@available(macOS 14.0,*)){config.preservesAspectRatio=YES;config.captureResolution=SCCaptureResolutionBest;config.ignoreShadowsSingleWindow=YES;}
        if(@available(macOS 14.2,*))config.includeChildWindows=NO;
        return config;
    }
    void configureLatest(){ // renderQueue; at most one SCK operation in flight.
        if(retired||configurationInFlight||!stream||!requestedGeneration||requestedGeneration!=geometryGeneration)return;
        const auto generation=requestedGeneration;const auto g=requestedGeometry;
        configurationInFlight=true;++configurationAttempts;auto self=shared_from_this();
        @try{try{
            [stream updateConfiguration:configuration(g) completionHandler:^(NSError *error){
                dispatch_async(self->renderQueue,^{
                    @try{try{
                    self->configurationInFlight=false;
                    if(self->retired)return;
                    // A superseded callback cannot accept or reject the newer
                    // geometry. Always drain the latest coalesced request.
                    if(generation!=self->geometryGeneration||generation!=self->requestedGeneration){self->configureLatest();return;}
                    if(!error){self->configuring=false;self->configurationStarted=0;self->unusableEpoch=0;return;}
                    const auto reason=captureError("configuration",error)+" generation="+std::to_string(generation)+
                        " cropPoints="+std::to_string(g.x)+","+std::to_string(g.y)+","+std::to_string(g.width)+"x"+std::to_string(g.height)+
                        " outputPixels="+std::to_string(g.pixelsWidth)+"x"+std::to_string(g.pixelsHeight);
                    if(transientConfigurationError(error)&&self->configurationAttempts<2){
                        macfx::nativeLog("Browser completed-window capture retry: "+reason);
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,150*NSEC_PER_MSEC),self->renderQueue,^{
                            if(!self->retired&&generation==self->geometryGeneration&&generation==self->requestedGeneration)self->configureLatest();
                        });return;
                    }
                    self->fail(reason,transientConfigurationError(error));
                    }catch(const std::exception &exception){self->fail(exception.what(),true);}}
                    @catch(NSException *exception){self->fail(exception.reason.UTF8String?:"Capture configuration callback failed",true);}
                });
            }];
        }catch(const std::exception&e){configurationInFlight=false;fail(std::string("Capture configuration: ")+e.what(),true);}}
        @catch(NSException*e){configurationInFlight=false;fail(e.reason.UTF8String?:"Capture configuration failed",true);}
    }
    void update(const macfx::BrowserFrameGeometry &g,NSRect screen){ // Main thread.
        if(retired)return;
        const auto started=configurationStarted.load();
        if(configuring&&started>0&&CACurrentMediaTime()-started>=2){fail("Capture configuration did not settle; original window retained",true);return;}
        if(!NSEqualRects(output.frame,screen))[output setFrame:screen display:NO];
        const auto scale=source.backingScaleFactor;if(layer.contentsScale!=scale)layer.contentsScale=scale;
        const auto drawable=CGSizeMake(g.pixelsWidth,g.pixelsHeight);
        if(!CGSizeEqualToSize(layer.drawableSize,drawable))layer.drawableSize=drawable;
        if(sameGeometry(geometry,g))return;
        geometry=g;width=g.pixelsWidth;height=g.pixelsHeight;
        if(!configuring.exchange(true))configurationStarted=CACurrentMediaTime();
        if(!revealed){layer.hidden=YES;ready=false;acceptedGeneration=0;firstAcceptedFrameId=0;revealAfter=presenter->snapshot().completedReal;}
        const auto generation=geometryGeneration.fetch_add(1)+1;geometryTime=CACurrentMediaTime();
        // A block captures a C++ reference by reference, and the caller's
        // geometry is gone when the render queue runs. Copy it.
        const auto requested=g;auto self=shared_from_this();dispatch_async(renderQueue,^{
            if(self->retired||!self->stream||self->geometryGeneration!=generation)return;
            self->budgetRetryAt=0;self->budgetPressure.reset();self->unusableEpoch=0;self->drain();
            self->requestedGeometry=requested;self->requestedGeneration=generation;self->configurationAttempts=0;self->configureLatest();
        });
    }
    void receive(CMSampleBufferRef sample){
        if(retired||configuring||!CMSampleBufferIsValid(sample))return;
        auto attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
        if(!attachments||CFArrayGetCount(attachments)<1)return;
        NSDictionary *info=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
        NSNumber *status=info[SCStreamFrameInfoStatus];
        if(!status||status.integerValue!=SCFrameStatusComplete){++idle;return;}
        ++complete;auto value=std::make_shared<Sample>(sample,geometryGeneration.load());bool schedule=false;
        {std::lock_guard<std::mutex>lock(pendingMutex);if(pending)++dropped;pending=std::move(value);if(!worker){worker=true;schedule=true;}}
        if(schedule){auto self=shared_from_this();dispatch_async(renderQueue,^{self->drain();});}
    }
    void drain(){
        const auto now=CACurrentMediaTime();
        if(!retired&&!configuring&&budgetRetryAt>now){
            // Keep one coalesced capture while admission is busy, including a
            // static source that will not produce another complete frame.
            const auto retryAt=budgetRetryAt;auto self=shared_from_this();
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t((retryAt-now)*NSEC_PER_SEC)),renderQueue,^{if(self->budgetRetryAt==retryAt)self->drain();});return;
        }
        std::shared_ptr<Sample>sample;
        {std::lock_guard<std::mutex>lock(pendingMutex);sample=std::move(pending);}
        if(sample&&!retired&&!configuring&&sample->generation==geometryGeneration){
            @try{try{render(sample);}catch(const std::exception&e){fail(e.what());}}@catch(NSException*e){fail(e.reason.UTF8String?:"Capture GPU submission failed");}
        }
        bool again=false;{std::lock_guard<std::mutex>lock(pendingMutex);again=bool(pending)&&!retired;if(!again)worker=false;}
        if(again){auto self=shared_from_this();dispatch_async(renderQueue,^{self->drain();});}
    }
    void requestReplay(){
        if(retired||replayQueued.exchange(true))return;const std::weak_ptr<Session>weak=shared_from_this();
        dispatch_async(renderQueue,^{if(auto self=weak.lock()){self->replayQueued=false;if(self->retired)return;self->replayRequested=true;self->submitLatest();}});
    }
    void pollPublication(){ // Main thread; no rendering or source identity change.
        const macfx::BrowserFrameAttemptContract desired{macfx::effectPlanDemandGeneration(),macfx::liveEffects()?macfx::liveState().generation:0};
        if(!publicationRecorded){publication=desired;publicationRecorded=true;return;}
        if(publication!=desired){publication=desired;requestReplay();}
    }
    void retryLatest(){
        if(retryScheduled||retired)return;retryScheduled=true;const std::weak_ptr<Session>weak=shared_from_this();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,4*NSEC_PER_MSEC),renderQueue,^{if(auto self=weak.lock()){self->retryScheduled=false;if(!self->retired&&self->replayRequested)self->submitLatest();}});
    }
    void submitLatest(){ // renderQueue; the pinned raw texture never changes in place.
        if(retired||configuring||!raw||!replayRequested)return;
        const auto input=*raw;if(input.generation!=geometryGeneration||input.width!=width||input.height!=height)return;
        bool expected=false;if(!input.slot->busy.compare_exchange_strong(expected,true))return;
        replayRequested=false;auto commands=[queue commandBuffer];if(!commands){input.slot->busy=false;fail("Completed frame GPU submission is unavailable");return;}
        macfx::ownPresentationBuffer(commands);
        const auto frameId=++delivery;const double time=CACurrentMediaTime();
        RSPresentationContent content{};content.size=sizeof(content);content.version=1;content.contentId=input.contentId;content.epoch=1;content.pts=input.pts-contentTimeOrigin;content.duration=0;content.flags=input.accepted?RS_PRESENT_CONTENT_REDRAW:0;
        auto submitted=presenter->submitContent(commands,input.slot->texture,frameId,time,content,nullptr);
        const bool encoded=submitted.encoded;auto self=shared_from_this();
        [commands addCompletedHandler:^(id<MTLCommandBuffer>buffer){const bool failed=buffer.status==MTLCommandBufferStatusError,completed=buffer.status==MTLCommandBufferStatusCompleted;
            dispatch_async(self->renderQueue,^{input.slot->busy=false;
                if(completed&&encoded&&!self->retired&&!self->configuring&&self->geometryGeneration==input.generation&&self->width==input.width&&self->height==input.height)self->completedGeneration=input.generation;
                if(failed)self->fail("Completed frame GPU command failed");
                else if(self->replayRequested&&!self->retryScheduled)self->submitLatest();
            });
            if(macfx::diagnosticsEnabled()&&self->diagnosticCompletions.fetch_add(1)<2)dispatch_async(dispatch_get_main_queue(),^{self->reportReadiness("gpu-complete");});
        }];[commands commit];
        if(!encoded){
            if(!submitted.busy){fail(submitted.reason);return;}
            // Candidate readiness has a direct wakeup. Other bounded GPU/slot
            // pressure uses one retry; no new capture/content identity is made.
            if(presenter->preparationState()==macfx::PresenterPreparation::Ready){replayRequested=true;retryLatest();}
            return;
        }
        if(raw&&raw->contentId==input.contentId&&raw->generation==input.generation)raw->accepted=true;
        if(!retired&&!configuring&&geometryGeneration==input.generation&&width==input.width&&height==input.height){
            if(acceptedGeneration.load()!=input.generation){firstAcceptedFrameId=frameId;acceptedGeneration=input.generation;}ready=true;
        }
    }
    void submitCopied(std::shared_ptr<Slot>slot,uint64_t frameId,double time,uint64_t generation,unsigned w,unsigned h){
        slot->busy=false;
        if(retired||configuring||geometryGeneration!=generation||width!=w||height!=h||raw&&raw->contentId>=frameId){++dropped;return;}
        if(!contentTimeOrigin)contentTimeOrigin=time;raw=RawInput{std::move(slot),frameId,generation,time,w,h,false};replayRequested=true;submitLatest();
    }
    // A settled stream whose complete images never match the configured window
    // would drop every image without a reason. After one second without a
    // usable image it ends with a recoverable failure.
    void unusable(CVPixelBufferRef pixels,unsigned w,unsigned h){ // renderQueue
        ++dropped;if(unusableEpoch)return;
        const auto epoch=unusableEpoch=++unusableEpochs;const auto generation=geometryGeneration.load();
        const auto reason=pixels?"capture delivers "+std::to_string(CVPixelBufferGetWidth(pixels))+"x"+std::to_string(CVPixelBufferGetHeight(pixels))+
            (CVPixelBufferGetPixelFormatType(pixels)==kCVPixelFormatType_32BGRA?"":" non-BGRA")+" images for the "+std::to_string(w)+"x"+std::to_string(h)+" window"
            :std::string("capture delivers images without pixels");
        auto self=shared_from_this();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),renderQueue,^{
            if(self->unusableEpoch==epoch&&self->geometryGeneration==generation&&!self->configuring)self->fail(reason,true);
        });
    }
    void render(const std::shared_ptr<Sample>&sample){
        CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample->value);
        const unsigned w=width.load(),h=height.load();
        if(!pixels||CVPixelBufferGetPixelFormatType(pixels)!=kCVPixelFormatType_32BGRA||
            CVPixelBufferGetWidth(pixels)!=w||CVPixelBufferGetHeight(pixels)!=h){unusable(pixels,w,h);return;}
        unusableEpoch=0;
        auto attachments=CMSampleBufferGetSampleAttachmentsArray(sample->value,false);
        NSDictionary *info=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
        double time=0;NSNumber *display=info[SCStreamFrameInfoDisplayTime];
        if(display.unsignedLongLongValue)time=CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(display.unsignedLongLongValue));
        else {CMTime pts=CMSampleBufferGetPresentationTimeStamp(sample->value);
            if(stream.synchronizationClock)pts=CMSyncConvertTime(pts,stream.synchronizationClock,CMClockGetHostTimeClock());
            time=CMTimeGetSeconds(pts);}
        if(time<geometryTime.load()||sample->generation!=geometryGeneration||!macfx::browserFrameTimeAccepted(time,lastTime)){++dropped;return;}
        std::shared_ptr<Slot>slot;
        for(auto &entry:slots){if(!entry)entry=std::make_shared<Slot>();if(raw&&entry==raw->slot)continue;bool expected=false;
            if(entry->busy.compare_exchange_strong(expected,true)){slot=entry;break;}}
        if(!slot){++dropped;return;}
        auto lease=std::make_shared<PixelLease>();lease->sample=sample;
        const auto result=CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,cache,pixels,nullptr,MTLPixelFormatBGRA8Unorm,w,h,0,&lease->texture);
        if(result!=kCVReturnSuccess||!lease->texture){slot->busy=false;fail("Completed frame is not available as a Metal texture");return;}
        id<MTLTexture>input=CVMetalTextureGetTexture(lease->texture);
        if(!input){slot->busy=false;return;}
        if(!slot->texture||slot->texture.width!=w||slot->texture.height!=h){
            auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
            desc.storageMode=MTLStorageModePrivate;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
            try{slot->texture=macfx::newAdmittedTexture(device,desc,reinterpret_cast<uintptr_t>(this),"browser-snapshot-memory");}
            catch(const macfx::ImageBudgetExceeded&error){
                slot->busy=false;
                if(error.structurallyImpossible){++dropped;fail(error.what());return;}
                budgetRetryAt=CACurrentMediaTime()+(budgetPressure.record()?1:.25);
                std::lock_guard<std::mutex>lock(pendingMutex);if(!pending)pending=sample;else ++dropped;
                return;
            }
        }
        if(!slot->texture){slot->busy=false;fail("Completed frame GPU storage is unavailable");return;}
        budgetRetryAt=0;budgetPressure.reset();lastTime=time;
        // A separate, ordered GPU copy releases the SCK pool lease independently
        // of slow neural inference or generated-frame presentation.
        if(!copyQueueAttempted){copyQueueAttempted=true;copyQueue=[device newCommandQueue];}
        auto copy=[(copyQueue?:queue) commandBuffer];if(!copy){slot->busy=false;fail("Completed frame GPU copy is unavailable");return;}
        macfx::ownPresentationBuffer(copy);auto blit=[copy blitCommandEncoder];
        if(!blit){slot->busy=false;fail("Completed frame GPU copy encoder is unavailable");return;}
        [blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1)
            toTexture:slot->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];
        const auto frameId=++frame,generation=sample->generation;auto self=shared_from_this();
        [copy addCompletedHandler:^(id<MTLCommandBuffer>buffer){
            (void)lease;const bool failed=buffer.status!=MTLCommandBufferStatusCompleted;
            // Never call a presenter or wait for submission from a Metal
            // callback. Failed copies never become effect inputs.
            dispatch_async(self->renderQueue,^{
                if(failed){slot->busy=false;self->fail("Completed frame GPU copy failed");return;}
                @try{try{self->submitCopied(slot,frameId,time,generation,w,h);}
                    catch(const std::exception&e){slot->busy=false;self->fail(e.what());}
                }@catch(NSException*e){slot->busy=false;self->fail(e.reason.UTF8String?:"Completed frame submission failed");}
            });
        }];[copy commit];
    }
};
std::shared_ptr<Session> &current(){static auto *v=new std::shared_ptr<Session>;return *v;}
uint32_t &attemptedWindow(){static uint32_t v=0;return v;}
macfx::BrowserFrameAttemptContract &attemptedContract(){static macfx::BrowserFrameAttemptContract v;return v;}
uint64_t &requestEpoch(){static uint64_t v=0;return v;}
Recovery &recovery(){static Recovery v;return v;}
NSRect contentScreen(NSWindow *window){return [window convertRectToScreen:[window.contentView convertRect:window.contentView.bounds toView:nil]];}
macfx::BrowserFrameGeometry geometry(NSWindow *window){
    const auto content=contentScreen(window),frame=window.frame;
    const auto pixels=[window.contentView convertRectToBacking:window.contentView.bounds];
    if(!std::isfinite(pixels.size.width)||!std::isfinite(pixels.size.height)||pixels.size.width<1||pixels.size.height<1||pixels.size.width>16384||pixels.size.height>16384)return {};
    return {NSMinX(content)-NSMinX(frame),NSMaxY(frame)-NSMaxY(content),content.size.width,content.size.height,
        unsigned(std::ceil(pixels.size.width)),unsigned(std::ceil(pixels.size.height))};
}
bool start(NSWindow *window){
    const uint32_t identifier=uint32_t(window.windowNumber);
    if(!window.opaque){attemptedWindow()=identifier;failAttempt(identifier,"Browser completed-window graphics requires an opaque SDR window; original window retained");return true;}
    if(@available(macOS 14.4,*)){
        const auto claim=channel().claim(identifier);if(!claim)return false;
        clearUnavailable();attemptedWindow()=identifier;const auto epoch=++requestEpoch();PendingClaim pending{identifier,claim};
        __weak NSWindow *weak=window;
        [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError *error){
            dispatch_async(dispatch_get_main_queue(),^{
                PendingClaim pending{identifier,claim};
                std::shared_ptr<Session> created;
                @try{try{
                NSWindow *window=weak;
                if(!window||!window.visible||window.windowNumber!=identifier||attemptedWindow()!=identifier||requestEpoch()!=epoch||!macfx::imageProcessingRequested()||!channel().owns(identifier,claim))return;
                SCWindow *selected=nil;for(SCWindow *candidate in content.windows)
                    if(candidate.windowID==identifier&&candidate.owningApplication.processID==getpid()){selected=candidate;break;}
                if(error||!selected){failAttempt(identifier,"Browser completed-window capture is unavailable for the selected window; original window retained");return;}
                auto self=std::make_shared<Session>();created=self;self->source=window;self->window=identifier;self->claimTicket=claim;
                self->geometry=geometry(window);
                if(!macfx::browserFrameGeometryValid(self->geometry)){failAttempt(identifier,"Browser completed-window capture has no valid window extent; original window retained");return;}
                self->width=self->geometry.pixelsWidth;self->height=self->geometry.pixelsHeight;
                self->device=MTLCreateSystemDefaultDevice();self->queue=[self->device newCommandQueue];
                if(!self->queue||CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,self->device,nullptr,&self->cache)!=kCVReturnSuccess){
                    failAttempt(identifier,"Browser completed-window capture could not prepare its GPU resources; original window retained");return;}
                self->output=[[MacFXBrowserOutputWindow alloc]initWithContentRect:contentScreen(window) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
                self->output.releasedWhenClosed=NO;self->output.ignoresMouseEvents=YES;self->output.hidesOnDeactivate=NO;
                self->output.opaque=NO;self->output.backgroundColor=NSColor.clearColor;self->output.hasShadow=NO;
                self->output.collectionBehavior=NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorIgnoresCycle;
                self->output.contentView.wantsLayer=YES;self->layer=[CAMetalLayer layer];macfx::ownPresentation(self->layer);
                self->layer.device=self->device;self->layer.pixelFormat=MTLPixelFormatBGRA8Unorm;self->layer.framebufferOnly=NO;
                self->layer.hidden=YES;
                self->layer.displaySyncEnabled=YES;self->layer.opaque=YES;self->layer.contentsScale=window.backingScaleFactor;
                CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);self->layer.colorspace=color;CGColorSpaceRelease(color);
                self->layer.drawableSize=CGSizeMake(self->width.load(),self->height.load());self->output.contentView.layer=self->layer;
                macfx::PresenterConfig config;config.origin=macfx::FrameOrigin::TopLeft;config.frameSource=macfx::RuntimeFrameSource::BrowserWindow;
                const auto graphics=macfx::presentationGraphicsEnvironment();config.method=macfx::spatialMethodForName(graphics.spatialMethod);config.generation=graphics.generation;config.adaptive=graphics.adaptive;
                self->presenter=std::make_shared<macfx::FramePresenter>(self->layer,(__bridge void*)self->layer,config);
                {const std::weak_ptr<Session>weak=self;self->presenter->setPreparationObserver([weak](const macfx::EffectPreparationNotice&){if(auto self=weak.lock())self->requestReplay();});}
                self->reportReadiness("created");
                self->receiver=[MacFXBrowserStream new];self->receiver->session=self;
                auto filter=[[SCContentFilter alloc]initWithDesktopIndependentWindow:selected];
                self->stream=[[SCStream alloc]initWithFilter:filter configuration:self->configuration(self->geometry) delegate:self->receiver];
                NSError *failure=nil;if(![self->stream addStreamOutput:self->receiver type:SCStreamOutputTypeScreen sampleHandlerQueue:self->intakeQueue error:&failure]){
                    self->close();failAttempt(identifier,"Browser completed-window graphics unavailable: "+captureError("output",failure)+"; original window retained");return;}
                current()=self;pending.ticket=0;
                // Publish a transparent native host before acquiring its first
                // drawable. Only the layer becomes visible after matching GPU
                // completion; input and unprocessed content remain original.
                [window addChildWindow:self->output ordered:NSWindowAbove];[self->output orderFront:nil];
                self->reportReadiness("hosted");
                [self->stream startCaptureWithCompletionHandler:^(NSError *error){
                    if(error){self->fail(captureError("start",error));return;}
                    dispatch_async(dispatch_get_main_queue(),^{if(self->retired)return;
                        macfx::nativeLog("Browser source=completed-window GPU window="+std::to_string(self->window)+" reason=native-frame-unavailable interval=0");});
                }];
                }catch(const std::exception &e){if(created)created->fail(e.what());else failAttempt(identifier,"Browser window capture unavailable; original window retained");}
                 catch(...){if(created)created->fail("Window capture preparation failed");else failAttempt(identifier,"Browser window capture unavailable; original window retained");}
                }@catch(NSException *e){if(created)created->fail(e.reason.UTF8String?:"Window capture preparation failed");else failAttempt(identifier,"Browser window capture unavailable; original window retained");}
            });
        }];
        pending.ticket=0;
    }else {attemptedWindow()=identifier;failAttempt(identifier,"Browser completed-window capture requires macOS 14.4 or later; original window retained");}
    return true;
}
}
@implementation MacFXBrowserStream
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(type==SCStreamOutputTypeScreen)if(auto value=session.lock()){@try{try{value->receive(sample);}catch(const std::exception&e){value->fail(e.what());}}@catch(NSException*e){value->fail(e.reason.UTF8String?:"Capture input failed");}}
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {if(auto value=session.lock())value->fail(captureError("stream-stopped",error),value->geometryGeneration>1&&transientConfigurationError(error));}
@end
namespace macfx {
bool browserFrameFallbackEnabled()noexcept{static const bool enabled=[] {const char*v=getenv("RESHADE_BROWSER_FRAME_STATE"),*token=getenv("RESHADE_BROWSER_FRAME_TOKEN");return v&&*v&&token&&strlen(token)==32;}();return enabled;}
void browserFrameNativeObservation(uint32_t window,bool full)noexcept{if(!browserFrameFallbackEnabled())return;channel().observe(window,full);}
BrowserFrameDemand browserFrameDemand()noexcept{return browserFrameFallbackEnabled()?channel().demand():BrowserFrameDemand{};}
bool browserFrameNativeProbe(uint32_t window,uint32_t epoch)noexcept{return browserFrameFallbackEnabled()&&channel().probe(window,epoch);}
bool browserFrameProcessingAllowed()noexcept{return !browserFrameFallbackEnabled()||channel().processingAllowed();}
bool browserFrameOwnsWindow(uint32_t window)noexcept{return browserFrameFallbackEnabled()&&window&&channel().window()==window;}
bool isBrowserFrameOutputWindow(NSWindow*window)noexcept{return [window isKindOfClass:MacFXBrowserOutputWindow.class];}
static void pollBrowserFrameFallbackUnchecked(NSWindow *window,bool processing){
    if(!browserFrameFallbackEnabled()||!NSThread.isMainThread)return;
    const bool active=processing&&window&&window.visible&&!window.miniaturized&&window.contentView;
    channel().demand(active?uint32_t(window.windowNumber):0,window&&window.windowNumber>0);
    // Without processing no stream runs, so the selected window acknowledges
    // a pass-through plan from this control tick. Without a status lease this
    // returns after one load.
    if(!processing&&window)observeBypassedPlan(reinterpret_cast<uintptr_t>((__bridge void*)window));
    auto session=current();
    if(!active||session&&(session->retired||session->window!=window.windowNumber)){
        const bool changed=session&&window&&session->window!=window.windowNumber;
        if(session){if(active&&!changed&&session->recoverAfterGeometry)recovery().arm(session->window,session->geometry,CACurrentMediaTime());session->close();current().reset();}
        if(!active||changed){if(attemptedWindow())++requestEpoch();attemptedWindow()=0;recovery().reset();
            clearUnavailable(processing?0:reinterpret_cast<uintptr_t>((__bridge void*)window));}return;
    }
    const auto dimensions=geometry(window);if(!macfx::browserFrameGeometryValid(dimensions)){if(session){session->close();current().reset();}return;}
    if(session){session->update(dimensions,contentScreen(window));
        if(!session->revealed&&macfx::browserFrameCanReveal(session->ready.load(),session->geometryGeneration.load(),
                session->completedGeneration.load(),session->presenter->snapshot().completedReal,session->revealAfter,
                session->acceptedGeneration.load(),session->firstAcceptedFrameId.load(),session->presenter->lastRealCompletedFrameId())){
            session->layer.hidden=NO;session->revealed=true;
        }session->pollPublication();session->publishVisibility();session->reportReadiness("poll");return;
    }
    const bool fallback=channel().eligible(uint32_t(window.windowNumber));
    if(fallback&&!channel().window()){
        const BrowserFrameAttemptContract requested{effectPlanDemandGeneration(),liveEffects()?liveState().generation:0};
        if(attemptedWindow()!=window.windowNumber||attemptedContract()!=requested||
           recovery().ready(uint32_t(window.windowNumber),dimensions,CACurrentMediaTime())){
            if(start(window))attemptedContract()=requested;
        }
    }
    // While this window still needs the fallback, a failed attempt reads as
    // failed for every published revision until a new attempt, Off or another
    // window. A pending recovery is not a failure.
    if(fallback&&!(recovery().armed&&recovery().window==uint32_t(window.windowNumber)))reportUnavailable(window);
}
void pollBrowserFrameFallback(NSWindow *window,bool processing){
    if(!browserFrameFallbackEnabled()||!NSThread.isMainThread)return;
    @try{try{pollBrowserFrameFallbackUnchecked(window,processing);}
        catch(const std::exception &e){if(auto value=current())value->fail(e.what());else nativeLog("Browser window graphics unavailable; original window retained");}
        catch(...){if(auto value=current())value->fail("Window update failed");else nativeLog("Browser window graphics unavailable; original window retained");}
    }@catch(NSException *e){if(auto value=current())value->fail(e.reason.UTF8String?:"Window update failed");else nativeLog("Browser window graphics unavailable; original window retained");}
}
}
extern "C" unsigned rsBrowserFrameAPI(){return 1;}
