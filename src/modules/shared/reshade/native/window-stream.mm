#include "window-stream.hpp"
#include "window-overlay-policy.hpp"
#include "graphics.hpp"
#include "effects-plan.hpp"
#include "live-controls.hpp"
#include "presentation-internal.hpp"
#include "spatial.hpp"
#include "diagnostics.hpp"

namespace macfx {
std::string windowCaptureError(const char *phase,NSError *error){
    return std::string(phase)+" domain="+(error.domain.UTF8String?:"unknown")+" code="+std::to_string(error.code)+": "+(error.localizedDescription.UTF8String?:"Window capture failed");
}
bool transientWindowCaptureError(NSError *error){
    if(![error.domain isEqualToString:SCStreamErrorDomain])return false;
    return error.code==SCStreamErrorAttemptToConfigState||error.code==SCStreamErrorInvalidParameter||
        error.code==SCStreamErrorFailedApplicationConnectionInterrupted||error.code==SCStreamErrorInternalError;
}
namespace {std::atomic<unsigned>streamStops{0};}
unsigned pendingWindowStreamStops(){return streamStops.load();}
void WindowStream::streamStopped(NSError *error){fail(windowCaptureError("stream-stopped",error),geometryGeneration>1&&transientWindowCaptureError(error));}
bool WindowStream::prepareDevice(){
    device=MTLCreateSystemDefaultDevice();queue=[device newCommandQueue];
    return queue&&CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&cache)==kCVReturnSuccess;
}
void WindowStream::prepareLayer(CGFloat scale,bool opaque){
    layer=[CAMetalLayer layer];layer.maximumDrawableCount=3;ownPresentation(layer);
    layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=NO;
    layer.hidden=YES;
    layer.displaySyncEnabled=YES;layer.opaque=opaque;layer.contentsScale=scale;
    CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);layer.colorspace=color;CGColorSpaceRelease(color);
    layer.drawableSize=CGSizeMake(width.load(),height.load());
}
void WindowStream::preparePresenter(RuntimeFrameSource source,std::optional<bool>sourceOpaque){
    PresenterConfig config;config.origin=FrameOrigin::TopLeft;config.frameSource=source;config.sourceOpaque=sourceOpaque;
    const auto graphics=presentationGraphicsEnvironment();config.method=spatialMethodForName(graphics.spatialMethod);config.generation=graphics.generation;config.adaptive=graphics.adaptive;
    presenter=std::make_shared<FramePresenter>(layer,(__bridge void*)layer,config);
    const std::weak_ptr<WindowStream>weak=shared_from_this();
    presenter->setPreparationObserver([weak](const EffectPreparationNotice&){if(auto self=weak.lock())self->requestReplay();});
}
bool WindowStream::attach(SCContentFilter *filter,NSError *__autoreleasing *failure){
    receiver=[receiverClass new];receiver->owner=shared_from_this();
    stream=[[SCStream alloc]initWithFilter:filter configuration:configuration(geometry) delegate:receiver];
    return [stream addStreamOutput:receiver type:SCStreamOutputTypeScreen sampleHandlerQueue:intakeQueue error:failure];
}
NSError *WindowStream::attach(SCContentFilter *filter){
    NSError *failure=nil;
    if(!attach(filter,&failure))
        return failure?:[NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorInternalError userInfo:nil];
    return nil;
}
void WindowStream::startCapture(void (^started)()){
    auto self=shared_from_this();starting=true;
    [stream startCaptureWithCompletionHandler:^(NSError *error){
        self->starting=false;
        if(self->retired){dispatch_async(self->renderQueue,^{self->stopCapture();});return;}
        if(error){self->fail(windowCaptureError("start",error));return;}
        if(started)dispatch_async(dispatch_get_main_queue(),^{if(!self->retired)started();});
    }];
}
bool WindowStream::reveal(){
    if(revealed||!presenter||!browserFrameCanReveal(ready.load(),geometryGeneration.load(),completedGeneration.load(),
        presenter->snapshot().completedReal,revealAfter,acceptedGeneration.load(),firstAcceptedFrameId.load(),presenter->lastRealCompletedFrameId()))return false;
    layer.hidden=NO;revealed=true;return true;
}
void WindowStream::fail(const std::string &reason,bool recover){
    if(retired)return;
    if(recover)recoverAfterGeometry=true;
    if(retired.exchange(true))return;
    const auto message=std::string(label)+" graphics unavailable: "+reason+"; original window retained";
    nativeLog(message);
    auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{self->close();self->hostFailed(message);});
}
void WindowStream::close(){ // Main thread. Late stream and GPU callbacks retain only this retired session.
    if(closed.exchange(true))return;retired=true;ready=false;hostClosed();
    ++streamStops;
    auto self=shared_from_this();dispatch_async(renderQueue,^{
        if(self->presenter){self->presenter->setPreparationObserver({});self->presenter->stop();}self->raw.reset();self->sourceTextures.clear();self->replayRequested=false;
        {std::lock_guard<std::mutex>lock(self->pendingMutex);self->pending.reset();}
        self->stopRequested=true;self->stopCapture();
    });
}
void WindowStream::stopCapture(){
    if(!stopRequested||(starting&&deferStopUntilStarted))return;
    stopRequested=false;SCStream *capture=stream;stream=nil;
    MacFXWindowStreamReceiver *output=receiver;if(deferStopUntilStarted)receiver=nil;
    // Keep the stream and its delegate alive until replayd acknowledges stop.
    if(capture)[capture stopCaptureWithCompletionHandler:^(NSError*){(void)capture;(void)output;--streamStops;}];
    else --streamStops;
}
SCStreamConfiguration *WindowStream::configuration(const BrowserFrameGeometry &g){
    auto config=[SCStreamConfiguration new];config.width=g.pixelsWidth;config.height=g.pixelsHeight;
    config.minimumFrameInterval=kCMTimeZero;config.pixelFormat=kCVPixelFormatType_32BGRA;
    config.queueDepth=4;config.showsCursor=showsCursor;config.capturesAudio=NO;
    config.colorSpaceName=kCGColorSpaceSRGB;config.scalesToFit=YES;
    // ScreenCaptureKit source crops use logical points. The destination
    // and stream extent use pixels; no desktop mode or frame-rate change.
    config.sourceRect=CGRectMake(g.x,g.y,g.width,g.height);
    config.destinationRect=CGRectMake(0,0,g.pixelsWidth,g.pixelsHeight);
    if(@available(macOS 14.0,*)){config.preservesAspectRatio=YES;config.captureResolution=SCCaptureResolutionBest;config.ignoreShadowsSingleWindow=YES;}
    if(@available(macOS 14.2,*))config.includeChildWindows=includeChildWindows;
    return config;
}
void WindowStream::configureLatest(){ // renderQueue; at most one SCK operation in flight.
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
                const auto reason=windowCaptureError("configuration",error)+" generation="+std::to_string(generation)+
                    " cropPoints="+std::to_string(g.x)+","+std::to_string(g.y)+","+std::to_string(g.width)+"x"+std::to_string(g.height)+
                    " outputPixels="+std::to_string(g.pixelsWidth)+"x"+std::to_string(g.pixelsHeight);
                if(transientWindowCaptureError(error)&&self->configurationAttempts<2){
                    nativeLog(std::string(self->label)+" capture retry: "+reason);
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,150*NSEC_PER_MSEC),self->renderQueue,^{
                        if(!self->retired&&generation==self->geometryGeneration&&generation==self->requestedGeneration)self->configureLatest();
                    });return;
                }
                self->fail(reason,transientWindowCaptureError(error));
                }catch(const std::exception &exception){self->fail(exception.what(),true);}}
                @catch(NSException *exception){self->fail(exception.reason.UTF8String?:"Capture configuration callback failed",true);}
            });
        }];
    }catch(const std::exception&e){configurationInFlight=false;fail(std::string("Capture configuration: ")+e.what(),true);}}
    @catch(NSException*e){configurationInFlight=false;fail(e.reason.UTF8String?:"Capture configuration failed",true);}
}
void WindowStream::update(const BrowserFrameGeometry &g,NSRect screen,CGFloat scale,CGSize output){ // Main thread.
    if(retired)return;
    const auto started=configurationStarted.load();
    if(configuring&&started>0&&CACurrentMediaTime()-started>=2){fail("Capture configuration did not settle; original window retained",true);return;}
    placeOutput(screen);
    if(layer.contentsScale!=scale)layer.contentsScale=scale;
    const auto drawable=output.width>0&&output.height>0?output:CGSizeMake(g.pixelsWidth,g.pixelsHeight);
    if(!CGSizeEqualToSize(layer.drawableSize,drawable))layer.drawableSize=drawable;
    if(sameWindowGeometry(geometry,g))return;
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
void WindowStream::receive(CMSampleBufferRef sample){
    if(retired||configuring||!CMSampleBufferIsValid(sample))return;
    auto attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);
    if(!attachments||CFArrayGetCount(attachments)<1)return;
    NSDictionary *info=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
    NSNumber *status=info[SCStreamFrameInfoStatus];
    if(!status||status.integerValue!=SCFrameStatusComplete){++idle;return;}
    CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample);
    if(!pixels){++dropped;return;}
    const auto content=captureFrameGeometry(info,uint32_t(CVPixelBufferGetWidth(pixels)),uint32_t(CVPixelBufferGetHeight(pixels)));
    if(!content.valid){++dropped;return;}
    ++complete;bool schedule=false;
    {std::lock_guard<std::mutex>lock(pendingMutex);
        if(pending){++dropped;pending.reset();}
        // At most three distinct SCK samples survive the callback: raw replay,
        // GPU readers and one coalesced newest input share this strict bound.
        auto value=WindowStreamSample::acquire(sample,geometryGeneration.load(),content,retainedSamples);
        if(!value){++dropped;return;}
        pending=std::move(value);if(!worker){worker=true;schedule=true;}
    }
    if(schedule){auto self=shared_from_this();dispatch_async(renderQueue,^{self->drain();});}
}
void WindowStream::drain(){
    const auto now=CACurrentMediaTime();
    if(!retired&&!configuring&&budgetRetryAt>now){
        // Keep one coalesced capture while admission is busy, including a
        // static source that will not produce another complete frame.
        const auto retryAt=budgetRetryAt;auto self=shared_from_this();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t((retryAt-now)*NSEC_PER_SEC)),renderQueue,^{if(self->budgetRetryAt==retryAt)self->drain();});return;
    }
    std::shared_ptr<WindowStreamSample>sample;
    {std::lock_guard<std::mutex>lock(pendingMutex);sample=std::move(pending);}
    if(sample&&!retired&&!configuring&&sample->generation==geometryGeneration){
        @try{try{render(sample);}catch(const std::exception&e){fail(e.what());}}@catch(NSException*e){fail(e.reason.UTF8String?:"Capture GPU submission failed");}
    }
    bool again=false;{std::lock_guard<std::mutex>lock(pendingMutex);again=bool(pending)&&!retired;if(!again)worker=false;}
    if(again){auto self=shared_from_this();dispatch_async(renderQueue,^{self->drain();});}
}
void WindowStream::requestReplay(){
    if(retired||replayQueued.exchange(true))return;const std::weak_ptr<WindowStream>weak=shared_from_this();
    dispatch_async(renderQueue,^{if(auto self=weak.lock()){self->replayQueued=false;if(self->retired)return;self->replayRequested=true;self->submitLatest();}});
}
void WindowStream::pollPublication(){ // Main thread; no rendering or source identity change.
    const BrowserFrameAttemptContract desired{effectPlanDemandGeneration(),liveEffects()?liveState().generation:0};
    if(!publicationRecorded){publication=desired;publicationRecorded=true;return;}
    if(publication!=desired){publication=desired;requestReplay();}
}
void WindowStream::retryLatest(){
    if(retryScheduled||retired)return;retryScheduled=true;const std::weak_ptr<WindowStream>weak=shared_from_this();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,4*NSEC_PER_MSEC),renderQueue,^{if(auto self=weak.lock()){self->retryScheduled=false;if(!self->retired&&self->replayRequested)self->submitLatest();}});
}
void WindowStream::submitLatest(){ // renderQueue; the pinned raw texture never changes in place.
    if(retired||configuring||!raw||!replayRequested)return;
    const auto input=*raw;if(input.generation!=geometryGeneration||input.width!=width||input.height!=height)return;
    bool expected=false;if(!input.slot->busy.compare_exchange_strong(expected,true))return;
    replayRequested=false;auto commands=[queue commandBuffer];if(!commands){input.slot->busy=false;fail("Completed frame GPU submission is unavailable");return;}
    ownPresentationBuffer(commands);
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
        if(diagnosticsEnabled()&&self->diagnosticCompletions.fetch_add(1)<2)dispatch_async(dispatch_get_main_queue(),^{self->readiness("gpu-complete");});
    }];[commands commit];
    if(!encoded){
        if(!submitted.busy){fail(submitted.reason);return;}
        // Candidate readiness has a direct wakeup. Other bounded GPU/slot
        // pressure uses one retry; no new capture/content identity is made.
        if(presenter->preparationState()==PresenterPreparation::Ready){replayRequested=true;retryLatest();}
        return;
    }
    if(raw&&raw->contentId==input.contentId&&raw->generation==input.generation)raw->accepted=true;
    if(!retired&&!configuring&&geometryGeneration==input.generation&&width==input.width&&height==input.height){
        if(acceptedGeneration.load()!=input.generation){firstAcceptedFrameId=frameId;acceptedGeneration=input.generation;}ready=true;
    }
}
void WindowStream::submitCopied(std::shared_ptr<WindowStreamSlot>slot,uint64_t frameId,double time,uint64_t generation,unsigned w,unsigned h){
    slot->busy=false;
    if(retired||configuring||geometryGeneration!=generation||width!=w||height!=h||raw&&raw->contentId>=frameId){++dropped;return;}
    if(!contentTimeOrigin)contentTimeOrigin=time;raw=RawInput{std::move(slot),frameId,generation,time,w,h,false};replayRequested=true;submitLatest();
}
// A settled stream whose complete images never match the configured window
// would drop every image without a reason. After one second without a
// usable image it ends with a recoverable failure.
void WindowStream::unusable(CVPixelBufferRef pixels,unsigned w,unsigned h){ // renderQueue
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
void WindowStream::render(const std::shared_ptr<WindowStreamSample>&sample){
    CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample->value);
    const unsigned w=width.load(),h=height.load();
    const auto content=sample->content;
    if(!pixels||!content.valid||CVPixelBufferGetPixelFormatType(pixels)!=kCVPixelFormatType_32BGRA||
        CVPixelBufferGetWidth(pixels)!=content.surfaceWidth||CVPixelBufferGetHeight(pixels)!=content.surfaceHeight){unusable(pixels,w,h);return;}
    unusableEpoch=0;
    auto attachments=CMSampleBufferGetSampleAttachmentsArray(sample->value,false);
    NSDictionary *info=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
    double time=0;NSNumber *display=info[SCStreamFrameInfoDisplayTime];
    if(display.unsignedLongLongValue)time=CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(display.unsignedLongLongValue));
    else {CMTime pts=CMSampleBufferGetPresentationTimeStamp(sample->value);
        if(stream.synchronizationClock)pts=CMSyncConvertTime(pts,stream.synchronizationClock,CMClockGetHostTimeClock());
        time=CMTimeGetSeconds(pts);}
    if(time<geometryTime.load()||sample->generation!=geometryGeneration||!browserFrameTimeAccepted(time,lastTime)){++dropped;return;}
    if(!windowCaptureIntervalAccepted(time,lastTime,minimumInterval.load())){++dropped;return;}
    const auto generation=sample->generation;
    if(importedGeneration!=generation){sourceTextures.clear();importedGeneration=generation;}
    id<MTLTexture>input=nil;
    if(IOSurfaceRef surface=CVPixelBufferGetIOSurface(pixels))input=sourceTextures.texture(device,surface,MTLPixelFormatBGRA8Unorm);
    if(!input){
        // Preserve the CV buffer route when a direct surface import is not
        // available. A retained sample reuses its wrapper across retries.
        if(!sample->imported)CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,cache,pixels,nullptr,MTLPixelFormatBGRA8Unorm,content.surfaceWidth,content.surfaceHeight,0,&sample->imported);
        if(sample->imported)input=CVMetalTextureGetTexture(sample->imported);
    }
    if(!input){fail("Completed frame is not available as a Metal texture");return;}
    if(content.cropX==0&&content.cropY==0&&content.width==content.surfaceWidth&&content.height==content.surfaceHeight){
        sample->texture=input;sample->busy=true;budgetRetryAt=0;budgetPressure.reset();lastTime=time;
        submitCopied(std::static_pointer_cast<WindowStreamSlot>(sample),++frame,time,generation,w,h);return;
    }
    // Only a padded/cropped image needs a normalization copy. Full-content
    // frames retain their source sample and cached import above, without blits.
    std::shared_ptr<WindowStreamSlot>slot;
    for(auto &entry:slots){if(!entry)entry=std::make_shared<WindowStreamSlot>();if(raw&&entry==raw->slot)continue;bool expected=false;
        if(entry->busy.compare_exchange_strong(expected,true)){slot=entry;break;}}
    if(!slot){++dropped;return;}
    if(!slot->texture||slot->texture.width!=content.width||slot->texture.height!=content.height){
        auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:content.width height:content.height mipmapped:NO];
        desc.storageMode=MTLStorageModePrivate;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
        try{slot->texture=newAdmittedTexture(device,desc,reinterpret_cast<uintptr_t>(this),admissionStage);}
        catch(const ImageBudgetExceeded&error){
            slot->busy=false;
            if(error.structurallyImpossible){++dropped;fail(error.what());return;}
            budgetRetryAt=CACurrentMediaTime()+(budgetPressure.record()?1:.25);
            std::lock_guard<std::mutex>lock(pendingMutex);if(!pending)pending=sample;else ++dropped;
            return;
        }
    }
    if(!slot->texture){slot->busy=false;fail("Completed frame GPU storage is unavailable");return;}
    budgetRetryAt=0;budgetPressure.reset();lastTime=time;
    // Normalization retains the sample only through its private crop copy.
    if(!copyQueueAttempted){copyQueueAttempted=true;copyQueue=[device newCommandQueue];}
    auto copy=[(copyQueue?:queue) commandBuffer];if(!copy){slot->busy=false;fail("Completed frame GPU copy is unavailable");return;}
    ownPresentationBuffer(copy);auto blit=[copy blitCommandEncoder];
    if(!blit){slot->busy=false;fail("Completed frame GPU copy encoder is unavailable");return;}
    [blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(content.cropX,content.cropY,0) sourceSize:MTLSizeMake(content.width,content.height,1)
        toTexture:slot->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];
    const auto frameId=++frame;auto self=shared_from_this();
    [copy addCompletedHandler:^(id<MTLCommandBuffer>buffer){
        (void)sample;const bool failed=buffer.status!=MTLCommandBufferStatusCompleted;
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
}
@implementation MacFXWindowStreamReceiver
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(type==SCStreamOutputTypeScreen)if(auto value=owner.lock()){@try{try{value->receive(sample);}catch(const std::exception&e){value->fail(e.what());}}@catch(NSException*e){value->fail(e.reason.UTF8String?:"Capture input failed");}}
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {if(auto value=owner.lock())value->streamStopped(error);}
@end
