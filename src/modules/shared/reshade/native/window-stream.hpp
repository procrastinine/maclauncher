#pragma once
#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <QuartzCore/QuartzCore.h>
#include "browser-frame-policy.hpp"
#include "image-admission.hpp"
#include "presentation.hpp"
#include "runtime-status.hpp"
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
// The completed-window adapter. One ScreenCaptureKit stream delivers composed
// window images; complete frames are copied into GPU slots and submitted to a
// FramePresenter, so every mode the presenter supports applies to the capture.
// Clients supply the content filter, the geometry and the output host:
// browser-frame.mm for a browser's own window, window-source.mm for any
// window or display the user picks.
namespace macfx {
struct WindowStream;
}
@interface MacFXWindowStreamReceiver : NSObject<SCStreamOutput,SCStreamDelegate> {
@public std::weak_ptr<macfx::WindowStream> owner;
}
@end
namespace macfx {
struct WindowStreamSample {
    CMSampleBufferRef value=nullptr;uint64_t generation=0;
    explicit WindowStreamSample(CMSampleBufferRef v,uint64_t g):value(v),generation(g){CFRetain(v);}
    ~WindowStreamSample(){CFRelease(value);}
};
struct WindowStreamPixelLease {std::shared_ptr<WindowStreamSample>sample;CVMetalTextureRef texture=nullptr;~WindowStreamPixelLease(){if(texture)CFRelease(texture);}};
struct WindowStreamSlot {id<MTLTexture>texture=nil;std::atomic<bool>busy{false};};
inline bool sameWindowGeometry(const BrowserFrameGeometry &a,const BrowserFrameGeometry &b)noexcept {
    return a.x==b.x&&a.y==b.y&&a.width==b.width&&a.height==b.height&&a.pixelsWidth==b.pixelsWidth&&a.pixelsHeight==b.pixelsHeight;
}
// A failed resize may retry one fresh stream after the source settles. This is
// metadata only; Off and source changes discard the budget without any work.
struct WindowStreamRecovery {
    uint32_t window=0;bool armed=false,spent=false;BrowserFrameGeometry geometry{};double stableSince=0;
    void reset()noexcept{*this={};}
    void arm(uint32_t value,const BrowserFrameGeometry &g,double now)noexcept{
        if(window!=value){reset();window=value;}
        if(spent||!value||!browserFrameGeometryValid(g))return;
        armed=true;geometry=g;stableSince=now;
    }
    bool ready(uint32_t value,const BrowserFrameGeometry &g,double now)noexcept{
        if(!armed||spent||window!=value||!browserFrameGeometryValid(g)||!std::isfinite(now))return false;
        if(!sameWindowGeometry(geometry,g)){geometry=g;stableSince=now;return false;}
        if(now<stableSince+.25)return false;
        spent=true;armed=false;return true;
    }
};
std::string windowCaptureError(const char *phase,NSError *error);
bool transientWindowCaptureError(NSError *error);
// Closed streams of this process whose capture has not finished stopping. A
// helper waits for zero before it exits, so the system never handles a stop
// request from a process that has already gone.
unsigned pendingWindowStreamStops();
struct WindowStream :std::enable_shared_from_this<WindowStream> {
    // Client identity for logs and reasons, and the image-budget stage.
    const char *label="Window",*admissionStage="window-capture-memory";
    // Stream options; change only before attach() or with the next update().
    bool showsCursor=false,includeChildWindows=false;
    bool deferStopUntilStarted=true;
    Class receiverClass=[MacFXWindowStreamReceiver class];
    // Captures closer than 0.75 of this interval to the previous accepted one
    // are dropped (seconds; zero accepts every complete frame).
    std::atomic<double>minimumInterval{0};
    CAMetalLayer *layer=nil;
    id<MTLDevice>device=nil;id<MTLCommandQueue>queue=nil,copyQueue=nil;bool copyQueueAttempted=false;
    SCStream *stream=nil;MacFXWindowStreamReceiver *receiver=nil;
    CVMetalTextureCacheRef cache=nullptr;
    dispatch_queue_t renderQueue,intakeQueue;
    explicit WindowStream(const char*frames="org.maclauncher.window-frames",const char*capture="org.maclauncher.window-capture")
        :renderQueue(dispatch_queue_create(frames,DISPATCH_QUEUE_SERIAL)),intakeQueue(dispatch_queue_create(capture,DISPATCH_QUEUE_SERIAL)) {}
    std::shared_ptr<FramePresenter>presenter;
    std::atomic<bool>retired{false},closed{false},ready{false},configuring{false},recoverAfterGeometry{false};
    // Window capture waits for start before stopping; browser sessions stop
    // immediately. stopRequested belongs to renderQueue.
    std::atomic<bool>starting{false};bool stopRequested=false;
    std::atomic<double>configurationStarted{0};
    std::atomic<unsigned>width{0},height{0};std::atomic<uint64_t>geometryGeneration{1};std::atomic<double>geometryTime{0};
    std::atomic<uint64_t>completedGeneration{0},acceptedGeneration{0},firstAcceptedFrameId{0};uint64_t revealAfter=0;
    uint32_t window=0;uint64_t frame=0,delivery=0;double lastTime=0;
    struct RawInput{std::shared_ptr<WindowStreamSlot>slot;uint64_t contentId=0,generation=0;double pts=0;unsigned width=0,height=0;bool accepted=false;};
    std::optional<RawInput>raw;double contentTimeOrigin=0;bool replayRequested=false,retryScheduled=false;std::atomic<bool>replayQueued{false};
    BrowserFrameAttemptContract publication{};bool publicationRecorded=false;
    std::mutex pendingMutex;std::shared_ptr<WindowStreamSample>pending;bool worker=false;
    std::array<std::shared_ptr<WindowStreamSlot>,3>slots;
    std::atomic<uint64_t>complete{0},idle{0},dropped{0};bool revealed=false;
    std::atomic<unsigned>diagnosticCompletions{0};
    BrowserFrameGeometry geometry;
    // Only renderQueue owns the asynchronous configuration transaction. A
    // serial dispatch queue alone does not serialize escaping SCK callbacks.
    BrowserFrameGeometry requestedGeometry;
    uint64_t requestedGeneration=0;unsigned configurationAttempts=0;bool configurationInFlight=false;
    double budgetRetryAt=0;TransientBound budgetPressure;
    // renderQueue: nonzero while complete images keep an unusable extent or
    // format for the settled configuration.
    uint64_t unusableEpoch=0,unusableEpochs=0;
    virtual ~WindowStream(){if(cache)CFRelease(cache);}
    // Client hooks. hostClosed releases the output host on the main thread
    // before capture is released; hostFailed records the reason afterwards.
    virtual void hostClosed(){}
    virtual void hostFailed(const std::string &){}
    virtual void placeOutput(NSRect){}
    virtual void readiness(const char *){}
    virtual void streamStopped(NSError *error);
    // Main-thread preparation shared by every client.
    bool prepareDevice();
    void prepareLayer(CGFloat scale,bool opaque);
    void preparePresenter(RuntimeFrameSource source,std::optional<bool>sourceOpaque={});
    bool attach(SCContentFilter *filter,NSError *__autoreleasing *failure);
    NSError *attach(SCContentFilter *filter);
    void startCapture(void (^started)());
    // Main thread: reveals the layer once a frame of the current geometry
    // has completed. Returns true at the reveal.
    bool reveal();
    void fail(const std::string &reason,bool recover=false);
    void close();
    void stopCapture(); // renderQueue; exactly one stop.
    SCStreamConfiguration *configuration(const BrowserFrameGeometry &g);
    void configureLatest();
    // A nonzero drawable sets the output extent in pixels; the presenter
    // scales the source to it. Zero keeps the source extent.
    void update(const BrowserFrameGeometry &g,NSRect screen,CGFloat scale,CGSize drawable=CGSizeZero);
    void receive(CMSampleBufferRef sample);
    void drain();
    void requestReplay();
    void pollPublication();
    void retryLatest();
    void submitLatest();
    void submitCopied(std::shared_ptr<WindowStreamSlot>slot,uint64_t frameId,double time,uint64_t generation,unsigned w,unsigned h);
    void unusable(CVPixelBufferRef pixels,unsigned w,unsigned h);
    void render(const std::shared_ptr<WindowStreamSample>&sample);
};
}
