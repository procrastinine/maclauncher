#include "browser-frame.hpp"
#include "browser-frame-policy.hpp"
#include "window-stream.hpp"
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

@interface MacFXBrowserStream : MacFXWindowStreamReceiver @end
@implementation MacFXBrowserStream @end

namespace {
using Recovery=macfx::WindowStreamRecovery;
using Sample=macfx::WindowStreamSample;
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
using macfx::windowCaptureError;
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
}
@interface MacFXBrowserOutputWindow : NSPanel
@end
@implementation MacFXBrowserOutputWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
namespace {
// The browser's own window is the first client of the completed-window core.
// This adds the channel claim, the visibility edges and the child output host.
struct Session :macfx::WindowStream {
    __weak NSWindow *source=nil;
    MacFXBrowserOutputWindow *output=nil;
    uint32_t claimTicket=0;
    unsigned readinessRecords=0;double readinessStarted=CACurrentMediaTime(),readinessLast=0;
    uintptr_t visibilityView=0;bool visibilityActive=false;
    Session():WindowStream("org.maclauncher.browser-frames","org.maclauncher.browser-capture"){label="Browser completed-window";admissionStage="browser-snapshot-memory";deferStopUntilStarted=false;receiverClass=[MacFXBrowserStream class];}
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
    void readiness(const char *phase)override{ // Main thread, metadata only.
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
    void reportReadiness(const char *phase){readiness(phase);}
    void hostClosed()override{
        publishVisibility(true);channel().release(window,claimTicket);
        if(output.parentWindow)[output.parentWindow removeChildWindow:output];[output orderOut:nil];[output close];output=nil;
    }
    void hostFailed(const std::string &message)override{recordUnavailable(window,message);}
    void placeOutput(NSRect screen)override{if(!NSEqualRects(output.frame,screen))[output setFrame:screen display:NO];}
    void update(const macfx::BrowserFrameGeometry &g,NSRect screen){WindowStream::update(g,screen,source.backingScaleFactor);}
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
                if(!self->prepareDevice()){
                    failAttempt(identifier,"Browser completed-window capture could not prepare its GPU resources; original window retained");return;}
                self->output=[[MacFXBrowserOutputWindow alloc]initWithContentRect:contentScreen(window) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
                self->output.releasedWhenClosed=NO;self->output.ignoresMouseEvents=YES;self->output.hidesOnDeactivate=NO;
                self->output.opaque=NO;self->output.backgroundColor=NSColor.clearColor;self->output.hasShadow=NO;
                self->output.collectionBehavior=NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorIgnoresCycle;
                self->output.contentView.wantsLayer=YES;self->prepareLayer(window.backingScaleFactor,true);self->output.contentView.layer=self->layer;
                self->preparePresenter(macfx::RuntimeFrameSource::BrowserWindow);
                self->reportReadiness("created");
                auto filter=[[SCContentFilter alloc]initWithDesktopIndependentWindow:selected];
                NSError *failure=nil;if(!self->attach(filter,&failure)){
                    self->close();failAttempt(identifier,"Browser completed-window graphics unavailable: "+windowCaptureError("output",failure)+"; original window retained");return;}
                current()=self;pending.ticket=0;
                // Publish a transparent native host before acquiring its first
                // drawable. Only the layer becomes visible after matching GPU
                // completion; input and unprocessed content remain original.
                [window addChildWindow:self->output ordered:NSWindowAbove];[self->output orderFront:nil];
                self->reportReadiness("hosted");
                self->startCapture(^{macfx::nativeLog("Browser source=completed-window GPU window="+std::to_string(self->window)+" reason=native-frame-unavailable interval=0");});
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
        session->reveal();session->pollPublication();session->publishVisibility();session->reportReadiness("poll");return;
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
