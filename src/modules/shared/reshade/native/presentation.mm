#include "presentation.hpp"
#include "target-policy.hpp"
#include "completion.hpp"
#include "delivery-plan.hpp"
#include "presentation-internal.hpp"
#include "presentation-ticket.hpp"
#include "source-timing.hpp"
#include "diagnostics.hpp"
#include "log.hpp"
#include "live-controls.hpp"
#include "graphics.hpp"
#include "effects-execution.hpp"
#include "temporal-plan.hpp"
#include "frame-capture.hpp"
#include "image-admission.hpp"
#include "color-contract.hpp"
#include "runtime-status.hpp"
#include "generation-budget.hpp"
#import <CoreVideo/CoreVideo.h>
#include <atomic>
#include <array>
#include <algorithm>
#include <cmath>
#include <deque>
#include <mutex>
namespace {
struct Retirement;
struct FramePublication {std::optional<macfx::LivePacket>controls;std::string revision;unsigned width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;uintptr_t device=0;};
struct Batch {std::shared_ptr<const FramePublication>publication;unsigned inputWidth=0,inputHeight=0,outputWidth=0,outputHeight=0;double generationRetry=0;std::shared_ptr<macfx::ImageReservation>generationAdmission,previousGenerationAdmission;id<MTLTexture>real,sourceSnapshot;std::vector<id<MTLTexture>>generated,admitted;macfx::InterpolationPlan phases;uint64_t id=0,epoch=0;double sourceTime=0,sourcePeriod=1.0/60;bool targeted=false,opaqueDisplay=false,realIssued=false,retired=false;double target=0;std::shared_ptr<macfx::EffectExecution>execution;std::shared_ptr<macfx::FrameCapture>capture;macfx::PresentationContract contract;std::shared_ptr<Retirement> retirement;};
struct Display {std::shared_ptr<Batch>batch;int generated=-1;double due=0;bool replay=false;};
struct Retirement {
 RSPresentationObserver observer;uint64_t frame;std::mutex mutex;
 std::atomic<bool>done{false};bool armed=false,gpuDone=false,terminal=false;double presented=0;uint32_t outcome=RS_PRESENT_CANCELLED;
 Retirement(const RSPresentationObserver&value,uint64_t id):observer(value),frame(id){}
 void update(bool gpu,bool end,double shown,uint32_t result,bool deferred=false){bool invoke=false;double timestamp=0;uint32_t status=0;{
   std::lock_guard lock(mutex);gpuDone|=gpu;if(end&&(!terminal||gpu)){terminal=true;presented=shown;outcome=result;}
   if(armed&&!done&&gpuDone&&terminal){done=true;invoke=true;timestamp=presented;status=outcome;}
  }if(invoke){const auto callback=observer;const auto id=frame;
   if(deferred)dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{callback.retired(callback.context,id,timestamp,CACurrentMediaTime(),status);});
   else callback.retired(callback.context,id,timestamp,CACurrentMediaTime(),status);
  }
 }
 void completed(MTLCommandBufferStatus status){update(true,status!=MTLCommandBufferStatusCompleted,0,status==MTLCommandBufferStatusError?RS_PRESENT_GPU_ERROR:RS_PRESENT_CANCELLED);}
 void displayed(double time){const bool shown=std::isfinite(time)&&time>0;update(false,true,shown?time:0,shown?RS_PRESENTED:RS_PRESENT_DROPPED);}
 void cancel(){update(false,true,0,RS_PRESENT_CANCELLED);}
 void cancelDeferred(){update(false,true,0,RS_PRESENT_CANCELLED,true);}
 void arm(){std::lock_guard lock(mutex);armed=true;}
 ~Retirement(){if(armed&&!done.exchange(true)){const auto callback=observer;const auto id=frame;
   // A pooled batch can release the last reference while its presenter is
   // locked. The observer may reenter that presenter, including on discard.
   dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{callback.retired(callback.context,id,0,CACurrentMediaTime(),RS_PRESENT_CANCELLED);});
  }}
};
id<MTLTexture> makeTexture(id<MTLDevice>d,unsigned w,unsigned h,MTLPixelFormat format){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;return macfx::newAdmittedTexture(d,descriptor);}
std::string legacyInputIdentity(const macfx::LivePacket&packet){
 std::string value;const auto append=[&](const auto&field){value.append(reinterpret_cast<const char*>(&field),sizeof(field));};
 append(packet.spatial);append(packet.sharpness);append(packet.ls1Mode);
 const uint32_t flags=packet.flags&(8|16|32);append(flags);
 if(flags&8){value.append(packet.effectKey,64);value.append(packet.revision,64);append(packet.count);
  for(unsigned i=0;i<packet.count;++i){const auto&uniform=packet.uniforms[i];value.append(uniform.name,std::strlen(uniform.name)+1);append(uniform.count);value.append(reinterpret_cast<const char*>(uniform.values),sizeof(float)*uniform.count);}}
 return value;
}
}
struct macfx::FramePresenter::Impl:std::enable_shared_from_this<Impl>{
 CAMetalLayer*layer;void*owner;PresenterConfig config;ImageColorSpace colorSpace=ImageColorSpace::LegacySDR;double budgetDeniedAt=0;id<MTLCommandQueue>queue;id<MTLRenderPipelineState>flipPipeline;dispatch_queue_t worker;dispatch_source_t wakeup=nullptr;CVDisplayLinkRef link=nullptr;
 mutable std::mutex mutex;std::mutex submission,privateQueueMutex;std::atomic<bool>privateQueueUnavailable{false};PresenterStatus status;RSPresentationTiming timing{};std::vector<std::shared_ptr<Batch>>pool;std::vector<std::weak_ptr<Retirement>>retirements;std::optional<Display>immediate;
 std::atomic<bool>gpuFailed{false};std::shared_ptr<const FramePublication>publication,failedPublication;uint64_t publicationGeneration=~uint64_t(0);std::unique_ptr<EffectPlanState>failureReader;
 std::atomic<unsigned> displayHz{0};unsigned appliedRefresh=0;uint32_t currentDisplay=0;
 uint64_t appliedControls=~uint64_t(0),presentationEpoch=1;unsigned liveMultiplier=0;bool generationEnabled=true,generationUnavailable=false;double lastTrace=0;std::string legacyInput;
 std::shared_ptr<ImageReservation>generationAdmission;LsfgEncoder*admittedGenerator=nullptr;unsigned admittedGenerationWidth=0,admittedGenerationHeight=0;uint64_t admittedGenerationSequence=0;double generationRetry=0;
 std::shared_ptr<LsfgEncoder>generator;std::unique_ptr<AdaptivePacing>pacing;DeliveryPlan delivery;std::shared_ptr<Batch>latest;bool historyReady=false;uint64_t accountedDeliveryDrops=0;std::atomic<bool>pumpQueued{false},stopping{false};double lastSourceTime=0,interval=1.0/60;uint64_t lastSubmission=0,lastQueuedFrame=0,generationSequence=0;int lastQueuedGenerated=-2;unsigned width=0,height=0,inFlight=0;std::array<double,8>recentPresentations{};unsigned presentationCursor=0;
 std::unique_ptr<EffectPlanExecutor>plans=std::make_unique<EffectPlanExecutor>();std::shared_ptr<EffectExecution>execution;std::shared_ptr<FrameCapture>sceneCapture;id<MTLTexture>planTarget;bool planMode=false;double begun=CACurrentMediaTime(),lastDetachedRetirementTrace=0;uint64_t outputSequence=0;
 EffectPlanState holdPlans;
 uint64_t refreshedHoldEpoch=0,refreshedHoldGeneration=0;const LiveState*refreshedHoldReader=nullptr;
 bool holdActive=false,holdResuming=false,holdReset=false,holdCancelling=false,lastVisibleOpaque=false;unsigned issuedPresentations=0;
 // Bits: same-size native FX, compatible source, explicit source owner needed.
 // Other ingress has no native-Metal override and retains the prior policy.
 std::atomic<unsigned>nativeMetalCapabilities{2};
 std::atomic<bool>replayEnabled{false};bool replayCapture=false,replayPending=false;double lastRealDisplayed=0;uint64_t lastRealCompleted=0;std::shared_ptr<Batch>completedReplay;
 uint64_t visibleEpoch=0;PresentationHoldStatus holdStatus,lastVisible;PresentationHoldCommand heldCommand;PresentationContract desiredHoldContract;
 Impl(CAMetalLayer*l,void*o,const PresenterConfig&c):layer(l),owner(o),config(c){if(!layer||!owner||!layer.device)throw std::runtime_error("Missing presentation layer, owner or device");if(layer.pixelFormat!=MTLPixelFormatBGRA8Unorm&&layer.pixelFormat!=MTLPixelFormatRGBA8Unorm)throw std::runtime_error("Presentation requires an SDR layer");  colorSpace=imageColorSpace(layer.colorspace,layer.wantsExtendedDynamicRangeContent);
  if(colorSpace==ImageColorSpace::Unsupported)throw std::runtime_error(std::string(imageColorReason(colorSpace)));
  if(!modelColorSupported(colorSpace)){config.generation.reset();config.adaptive.reset();if(config.method==SpatialMethod::LS1)config.method=SpatialMethod::Bilinear;}
worker=dispatch_queue_create("macfx.presentation",DISPATCH_QUEUE_SERIAL);layer.framebufferOnly=NO;layer.allowsNextDrawableTimeout=YES;
  if(const auto configured=configuredSourceInterval(config.sourceFrameRate))interval=configured;
  plans->setStatusContext(reinterpret_cast<uintptr_t>(owner));
  if(config.generation)generator=std::make_shared<LsfgEncoder>(layer.device,*config.generation);
  if(config.adaptive){if(!config.generation||config.adaptive->maximumMultiplier!=config.generation->multiplier)throw std::runtime_error("Adaptive pacing requires a matching maximum graph capacity");if(config.sourceFrameRate>0)throw std::runtime_error("Adaptive pacing uses observed source timestamps");pacing=std::make_unique<AdaptivePacing>(*config.adaptive);}
  ownPresentation(layer);
 }
 CAMetalLayer *layerSnapshot()const {
  // Retain the owner before Stop can detach it. Driver/property calls occur
  // after this lock is released, so their callbacks may query presenter state.
  std::lock_guard lock(mutex);return layer;
 }
 id<MTLCommandQueue> privateCommandsQueue(){
  CAMetalLayer *layer=layerSnapshot();
  std::lock_guard lock(privateQueueMutex);if(stopping.load())return nil;
  if(!queue&&!privateQueueUnavailable.load()){
   queue=[layer.device newCommandQueue];
   if(!queue)privateQueueUnavailable.store(true);
  }return queue;
 }
 void retryPrivateQueue(){std::lock_guard lock(privateQueueMutex);privateQueueUnavailable.store(false);generationUnavailable=false;}
 void stopGenerationTiming(){
  if(link){CVDisplayLinkStop(link);CVDisplayLinkRelease(link);link=nullptr;}
  if(wakeup){dispatch_source_cancel(wakeup);wakeup=nullptr;}
 }
 void bypassGeneration(const std::string&reason){
  stopGenerationTiming();
  std::lock_guard lock(mutex);generationUnavailable=true;generationEnabled=false;historyReady=false;if(pacing)pacing->reset();retireDelivery();failWithoutLock(reason);
  RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(owner);event.processing=true;event.phase=RuntimeStatusPhase::Bypassed;event.stageId="frame-generation";event.requestedMethod="lsfg";event.activeMethod="passthrough";event.reason=reason;observeRuntimeStatus(event);
 }
 bool start(bool enabled=true){
  if(!generator||generationUnavailable)return false;
  if(!enabled){if(link&&CVDisplayLinkIsRunning(link))CVDisplayLinkStop(link);return true;}
  @try{try{
   if(!privateCommandsQueue())throw std::runtime_error("Frame generation delivery is unavailable; other effects use the source command buffer");
   if(!link){
    // Generated phases can fall between display-link callbacks. One rearmed
    // timer services the next phase; it never builds an asynchronous frame queue.
    wakeup=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,worker);
    if(!wakeup)throw std::runtime_error("Frame generation scheduling is unavailable");
    std::weak_ptr<Impl>weak=shared_from_this();dispatch_source_set_event_handler(wakeup,^{if(auto self=weak.lock())self->schedule();});
    dispatch_source_set_timer(wakeup,DISPATCH_TIME_FOREVER,DISPATCH_TIME_FOREVER,0);dispatch_resume(wakeup);
    if(CVDisplayLinkCreateWithActiveCGDisplays(&link)!=kCVReturnSuccess||!link)throw std::runtime_error("Frame generation display timing is unavailable");
    if(CVDisplayLinkSetOutputCallback(link,[](CVDisplayLinkRef,const CVTimeStamp*,const CVTimeStamp*out,CVOptionFlags,CVOptionFlags*,void*opaque)->CVReturn{auto*self=static_cast<Impl*>(opaque);if(out&&(out->flags&kCVTimeStampVideoRefreshPeriodValid)&&out->videoRefreshPeriod>0){const auto hz=unsigned(std::lround(double(out->videoTimeScale)/out->videoRefreshPeriod));if(hz>=20&&hz<=1000)self->displayHz.store(hz);}self->schedule();return kCVReturnSuccess;},this)!=kCVReturnSuccess)throw std::runtime_error("Frame generation display callback is unavailable");
    if(currentDisplay&&CVDisplayLinkSetCurrentCGDisplay(link,currentDisplay)!=kCVReturnSuccess)throw std::runtime_error("Frame generation display selection is unavailable");
   }
   if(!CVDisplayLinkIsRunning(link)&&CVDisplayLinkStart(link)!=kCVReturnSuccess)throw std::runtime_error("Frame generation display timing could not start");
   return true;
  }catch(const std::exception&error){bypassGeneration(error.what());}}
  @catch(NSException*error){bypassGeneration(error.reason.UTF8String?:"Frame generation display timing failed");}
  return false;
 }
 ~Impl(){shutdown();}
 void shutdown(){std::vector<std::shared_ptr<Retirement>>cancelled;
  // Releasing a layer can invoke foreign teardown; keep that outside locks.
  CAMetalLayer *retiredLayer __attribute__((objc_precise_lifetime))=nil;{
  std::lock_guard<std::mutex>serial(submission);if(stopping.exchange(true))return;stopGenerationTiming();std::lock_guard<std::mutex>lock(mutex);
  for(auto&weak:retirements)if(auto value=weak.lock())cancelled.push_back(std::move(value));retirements.clear();
  immediate.reset();latest.reset();completedReplay.reset();replayEnabled=false;delivery.clear();pool.clear();status.pending=0;status.stopped=true;retiredLayer=layer;layer=nil;retireRuntimeStatus(reinterpret_cast<uintptr_t>(owner));if(holdActive){holdActive=false;holdResuming=false;holdStatus.state="failed";holdStatus.reason="The source presentation stopped";}releaseFrameOwner(owner);
 }for(auto&value:cancelled)value->cancel();
  // Already-submitted batches retain their exact images/execution. The failed
  // identity remains cheap metadata; stopped owners keep no queue/model graph.
  {std::lock_guard lock(privateQueueMutex);queue=nil;}planTarget=nil;generator.reset();generationAdmission.reset();execution.reset();plans.reset();
 }
 void schedule(){if(stopping.load()||pumpQueued.exchange(true))return;auto self=shared_from_this();dispatch_async(worker,^{@autoreleasepool{self->pump();}});}
 void failWithoutLock(const std::string&reason){if(status.reason!=reason)nativeLog("Graphics presentation: "+reason);status.reason=reason;}
 void fail(const std::string&reason){std::lock_guard<std::mutex>lock(mutex);failWithoutLock(reason);}
 void deliveryMetrics(){const auto value=delivery.snapshot();const auto drops=value.droppedGenerated+value.droppedReal;status.dropped+=drops-accountedDeliveryDrops;accountedDeliveryDrops=drops;status.pending=value.pending;status.maxPending=std::max(status.maxPending,status.pending);}
 // Called with mutex held. Keep the displayed drawable while retiring work
 // that belongs to an older accepted processing contract.
 void cancelRetirements(const Retirement *except=nullptr){for(auto &weak:retirements)if(auto value=weak.lock();value&&value.get()!=except)value->cancelDeferred();}
 void retireBatch(const std::shared_ptr<Batch>&batch){if(batch&&batch->retirement&&!batch->realIssued){batch->retired=true;batch->retirement->cancelDeferred();}}
 void retireDelivery(const Retirement *except=nullptr){++presentationEpoch;cancelRetirements(except);completedReplay.reset();latest.reset();immediate.reset();delivery.clear();if(generator&&generationEnabled)deliveryMetrics();}
 void advanceHold(CGSize size){
  if(!holdActive||holdResuming||issuedPresentations||inFlight)return;
  // Do not acknowledge between an existing producer's admission and its
  // in-flight reservation. Never wait for that producer on the main thread.
  std::unique_lock<std::mutex>serial(submission,std::try_to_lock);if(!serial.owns_lock())return;
  if(holdStatus.state=="resuming"){holdResuming=true;holdStatus.state="presenting";return;}
  const bool completing=holdStatus.state=="settling";
  if(holdStatus.state!="draining"&&!completing)return;
  const auto expected=completing?desiredHoldContract:heldCommand.expected;
  if(lastVisible.contract!=expected||!lastVisibleOpaque||!lastVisible.presentedTime||
     lastVisible.width!=size.width||lastVisible.height!=size.height){holdStatus.state="failed";holdStatus.reason="The displayed image or extent changed before presentation could be held";if(!completing)holdActive=false;return;}
  holdStatus.state=completing?(holdCancelling?"cancelled":"presented"):"held";holdStatus.frameId=lastVisible.frameId;holdStatus.width=lastVisible.width;holdStatus.height=lastVisible.height;
  holdStatus.presentedTime=lastVisible.presentedTime;holdStatus.contract=lastVisible.contract;
 }
 PresentationHoldStatus holdReport()const{auto result=holdStatus;result.holding=holdActive;return result;}
 PresentationHoldStatus beginHold(const PresentationHoldCommand &command){
  CAMetalLayer *layer=layerSnapshot();
  const auto size=layer.drawableSize;
  std::lock_guard<std::mutex>lock(mutex);PresentationHoldStatus rejected;rejected.state="failed";rejected.epoch=command.epoch;rejected.transactionId=command.transactionId;
  rejected.holding=holdActive;
  if(stopping.load()||holdActive||!lastVisible.presentedTime||!lastVisibleOpaque||visibleEpoch!=presentationEpoch||
     lastVisible.width!=size.width||lastVisible.height!=size.height||lastVisible.contract!=command.expected){rejected.reason="A current positively displayed opaque SDR owned output is required";return rejected;}
  heldCommand=command;holdActive=true;holdResuming=false;holdReset=false;holdStatus=rejected;holdStatus.state="draining";holdStatus.reason.clear();
  retireDelivery();advanceHold(size);return holdReport();
 }
 PresentationHoldStatus resumeHold(const PresentationHoldCommand &command){
  CAMetalLayer *layer=layerSnapshot();
  // Abandon is a rollback-complete release, never an image/display receipt.
  // Read restored immutable publication outside presenter locks, then recheck
  // the transaction/epoch under the same lock that owns the held cover.
  PresentationContract restored;
  if(command.action=="abandon"){refreshLiveState();LiveStatePin pin;holdPlans.poll(true);if(const auto plan=holdPlans.snapshot())restored.planRevision=plan->revision;restored.controlsDigest=presentationControlsDigest();}
  const auto size=layer.drawableSize;
  std::lock_guard<std::mutex>lock(mutex);PresentationHoldStatus rejected;rejected.state="failed";rejected.epoch=command.epoch;rejected.transactionId=command.transactionId;
  rejected.holding=holdActive;
  if(command.action=="abandon"){
   if(stopping.load()||!gpuFailed.load()||!holdActive||command.transactionId!=heldCommand.transactionId||command.epoch<=holdStatus.epoch||command.expected!=heldCommand.expected||restored!=heldCommand.expected){rejected.reason="The failed presentation requires the restored original graphics publication before release";return rejected;}
   retireDelivery();holdActive=false;holdResuming=false;holdReset=false;holdStatus=rejected;holdStatus.state="abandoned";holdStatus.contract=command.expected;holdStatus.reason.clear();holdStatus.presentedTime=0;holdStatus.frameId=0;return holdReport();
  }
  if(command.action=="finish"){
   if(stopping.load()||!holdActive||holdResuming||command.transactionId!=heldCommand.transactionId||command.epoch<=holdStatus.epoch||
      (holdStatus.state!="presented"&&holdStatus.state!="cancelled")||command.expected!=holdStatus.contract){rejected.reason="The displayed presentation has not been acknowledged for release";return rejected;}
   holdActive=false;visibleEpoch=presentationEpoch;holdStatus.epoch=command.epoch;holdStatus.state="finished";return holdReport();
  }
  if(stopping.load()||!holdActive||command.transactionId!=heldCommand.transactionId||command.epoch<=holdStatus.epoch||
     (command.action!="present"&&command.action!="cancel")||command.expected!=(command.action=="cancel"?heldCommand.expected:heldCommand.candidate)){
   rejected.reason="The presentation update no longer matches its held contract";return rejected;
  }
  if(command.action=="present"&&holdStatus.state!="held"){rejected.reason="The previous displayed output has not finished draining";return rejected;}
  holdStatus=rejected;holdStatus.state="resuming";holdStatus.reason.clear();holdStatus.contract=command.expected;
  holdStatus.width=unsigned(size.width);holdStatus.height=unsigned(size.height);
  holdResuming=false;holdReset=true;holdCancelling=command.action=="cancel";desiredHoldContract=command.expected;
  retireDelivery();advanceHold(size);return holdReport();
 }
 void publicationFor(const std::shared_ptr<Batch>&batch,id<MTLTexture>source){
  const auto &state=liveState();const auto revision=batch->execution?batch->execution->revision():std::string{};
  const auto device=reinterpret_cast<uintptr_t>((__bridge void*)source.device);
  if(!publication||publicationGeneration!=state.generation||publication->revision!=revision||publication->width!=batch->outputWidth||publication->height!=batch->outputHeight||publication->format!=source.pixelFormat||publication->device!=device){
   auto next=std::make_shared<FramePublication>();if(const auto packet=state.controls.get())next->controls=*packet;next->revision=revision;next->width=batch->outputWidth;next->height=batch->outputHeight;next->format=source.pixelFormat;next->device=device;publication=std::move(next);publicationGeneration=state.generation;
  }batch->publication=publication;
 }
 void gpuFailure(const std::shared_ptr<Batch>&batch,std::string_view reason){
  std::lock_guard lock(mutex);if(!gpuFailed.exchange(true))failedPublication=batch->publication;
  failWithoutLock(std::string(reason));RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(owner);event.processing=true;event.phase=RuntimeStatusPhase::Failed;event.frameId=batch->id;event.planRevision=batch->execution?batch->execution->revision():batch->contract.planRevision;event.reason=reason;observeRuntimeStatus(event);
 }
 void observe(RuntimeStatusPhase phase,const std::shared_ptr<Batch>&batch,bool generated=false,double shown=0,std::string_view reason={}){
  RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(owner);event.processing=true;event.phase=phase;event.generated=generated;
  event.frameId=batch->id;event.sourceTime=batch->sourceTime;event.presentedTime=shown;event.outputWidth=batch->outputWidth;event.outputHeight=batch->outputHeight;
  event.inputWidth=batch->inputWidth;event.inputHeight=batch->inputHeight;event.planRevision=batch->execution?batch->execution->revision():batch->contract.planRevision;
  event.controlsDigest=batch->contract.controlsDigest;event.reason=reason;observeRuntimeStatus(event);
 }
 void stamp(const std::shared_ptr<Batch>&batch){
  if(!presentationHoldConfigured()){batch->contract={};return;}
  batch->contract.controlsDigest=presentationControlsDigest();
  if(batch->execution)batch->contract.planRevision=batch->execution->revision();
  else batch->contract={}; // Simple is stamped only from its encoded receipt.
 }
 bool sameHoldAttempt(uint64_t epoch,const PresentationContract&contract)const{
  return holdActive&&holdResuming&&holdStatus.epoch==epoch&&desiredHoldContract==contract;
 }
 bool failHeldAttempt(uint64_t epoch,const PresentationContract&contract,const std::string&reason){
  std::lock_guard<std::mutex>lock(mutex);if(!sameHoldAttempt(epoch,contract))return false;
  holdResuming=false;holdStatus.state="failed";holdStatus.reason=reason;failWithoutLock(reason);return true;
 }
 bool admitHeld(FrameResult &result,bool opaque,id<MTLTexture>source,std::optional<FrameEncodingInputs>&inputs,std::optional<LiveStatePin>&pin,uint64_t&attemptEpoch,std::optional<PresentationContract>&attemptContract){
  PresentationContract desired;bool reset=false;uint64_t epoch=0;{
   std::lock_guard<std::mutex>lock(mutex);if(!holdActive)return true;
   if(!holdResuming){result.busy=true;result.reason="Presentation is held during a graphics update";return false;}
   desired=desiredHoldContract;epoch=holdStatus.epoch;attemptEpoch=epoch;attemptContract=desired;
  }
  auto &reader=liveStateStorage();
  if(refreshedHoldEpoch!=epoch||refreshedHoldReader!=&reader||refreshedHoldGeneration!=reader.generation){
   refreshLiveState();holdPlans.poll(true);appliedControls=~uint64_t(0);
   refreshedHoldEpoch=epoch;refreshedHoldReader=&reader;refreshedHoldGeneration=reader.generation;
  }
  pin.emplace();
  const auto polled=holdPlans.poll();const auto snapshot=holdPlans.snapshot();
  const PresentationContract actual{polled.valid&&snapshot?snapshot->revision:"",presentationControlsDigest()};
  if(actual!=desired){result.busy=true;result.reason="Waiting for the matching graphics publication";return false;}
  const auto output=layer.drawableSize;
  const auto capabilities=nativeMetalCapabilities.load(std::memory_order_relaxed);
  const bool supported=(capabilities&2)&&SpatialEncoder::supportsFormat(source.pixelFormat)&&SpatialEncoder::supportsFormat(layer.pixelFormat);
  if(!opaque||!supported||!snapshot||(!(capabilities&4)&&!automaticPresentationNeeded(source.width,source.height,output.width,output.height,{bool(capabilities&1)},*snapshot))){
   result.reason=!opaque?"This update no longer supplies opaque presentation content":supported?
       "This update removes owned presentation; the previous displayed image remains held":
       "This update cannot supply the owned SDR image contract; the previous displayed image remains held";
   if(!failHeldAttempt(epoch,desired,result.reason))result.reason="A newer graphics update replaced this frame";
   result.busy=true;return false;
  }
  {std::lock_guard<std::mutex>lock(mutex);
   if(!sameHoldAttempt(epoch,desired)){result.busy=true;result.reason="A newer graphics update replaced this frame";return false;}
   reset=holdReset;holdReset=false;
  }
  inputs.emplace(FrameEncodingInputs{snapshot,actual.controlsDigest,false});
  if(reset){
   // Native renderer changes are not part of shared node identities. A new
   // executor resets temporal neural inputs even when forward frame IDs stay
   // continuous; legacy LSFG receives a forward gap instead of a rewind.
   plans=std::make_unique<EffectPlanExecutor>();appliedControls=~uint64_t(0);legacyInput.clear();historyReady=false;++generationSequence;
  }return true;
 }
 bool updateControls(){const auto &state=liveState();if(appliedControls==state.generation)return true;const auto packet=state.controls.get();if(!packet)return true;const auto&value=*packet;
  bool rebuilt=false;if(appliedControls!=~uint64_t(0))retryPrivateQueue();
  if(liveEffects()){
   auto desired=presentationGraphicsEnvironment();if(!modelColorSupported(colorSpace)){desired.generation.reset();desired.adaptive.reset();}
   config.method=spatialMethodForName(desired.spatialMethod);if(!modelColorSupported(colorSpace)&&config.method==SpatialMethod::LS1)config.method=SpatialMethod::Bilinear;
   const auto &a=desired.generation,&b=config.generation;
   const bool rebuild=a&&(!b||a->multiplier>b->multiplier||a->performance!=b->performance||a->fp16!=b->fp16||a->flowScale!=b->flowScale||a->modelPath!=b->modelPath);
   if(rebuild){
    {std::lock_guard<std::mutex>lock(mutex);if(inFlight)return false;}
    auto next=std::make_shared<LsfgEncoder>(layer.device,*a);
    std::lock_guard<std::mutex>lock(mutex);retireDelivery();generator=std::move(next);config.generation=a;pool.clear();historyReady=false;generationSequence=0;rebuilt=true;
   }
  }
  if(generator)start(value.flags&1);
  appliedControls=state.generation;
  const auto input=legacyInputIdentity(value);
  const unsigned multiplier=generator?std::min(value.multiplier,config.generation->multiplier):0;
  const bool enabled=value.flags&1,adaptive=value.flags&2,stable=value.flags&4;
  std::lock_guard<std::mutex>lock(mutex);
  if(enabled!=generationEnabled||input!=legacyInput){
   if(!rebuilt){retireDelivery();if(generator)++generationSequence;}
   // A forward gap resets a reused graph. Rewinding its IDs would instead
   // reject frames until the old sequence had been reached again.
   historyReady=false;generationEnabled=enabled&&modelColorSupported(colorSpace)&&!privateQueueUnavailable.load()&&!generationUnavailable;legacyInput=input;
  }
  if(!generator)return true;
  if(adaptive!=bool(config.adaptive)||multiplier!=liveMultiplier||
     (adaptive&&(config.adaptive->targetHz!=value.targetHz||config.adaptive->stableCadence!=stable))){
    liveMultiplier=multiplier;config.adaptive.reset();pacing.reset();
    if(adaptive){config.adaptive=AdaptivePacingConfig{value.targetHz,multiplier,displayHz.load(),stable};pacing=std::make_unique<AdaptivePacing>(*config.adaptive);}
    retireBatch(latest);delivery.clear();deliveryMetrics();
  }return true;
 }
 bool updatePlan(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime,double sourcePeriod,const DepthFrame*depth,bool opaque,FrameResult&result){
  if(!effectPlanRequested())return true;
  const auto size=layer.drawableSize;
  if(!std::isfinite(size.width)||!std::isfinite(size.height)||size.width<1||size.height<1||size.width>16384||size.height>16384){result.reason="Invalid presentation dimensions";return false;}
  if(!planTarget||planTarget.width!=size.width||planTarget.height!=size.height||planTarget.pixelFormat!=layer.pixelFormat)planTarget=makeTexture(layer.device,size.width,size.height,layer.pixelFormat);
  ShaderFrame frame{commands,source,planTarget,frameId,(sourceTime-begun)*1000,float(sourcePeriod*1000),config.origin,SpatialColor::Perceptual,depth,opaque};
  auto scene=takeTemporalOutput(commands,source);
  sceneCapture=std::move(scene.capture);
  EffectExecutionSelection selected;
  if(scene.execution){selected.active=true;selected.execution=std::move(scene.execution);}
  else selected=plans->prepareWithColor(frame,true,nullptr,colorSpace);
  if(selected.active&&!selected.execution){result.reason=selected.error.empty()?"The ordered effect plan is unavailable":selected.error;return false;}
  if(selected.active){
   const auto next=selected.execution;const bool historyChanged=execution&&execution->generationInputIdentity()!=next->generationInputIdentity();const bool generationChanged=next->generator()!=generator;
   if(!planMode||execution!=next){
    retryPrivateQueue();
    std::lock_guard<std::mutex>lock(mutex);if(generationChanged&&inFlight){result.busy=true;result.reason="Waiting for the current graphics frame";return false;}
    retireDelivery();
    if(generationChanged){generator=next->generator();pool.clear();historyReady=false;generationSequence=0;generationAdmission.reset();admittedGenerator=nullptr;}
    else if(historyChanged){historyReady=false;++generationSequence;}
    execution=next;execution->setStatusContext(reinterpret_cast<uintptr_t>(owner));planMode=true;config.generation=next->graphics().generation;config.adaptive=next->graphics().adaptive;liveMultiplier=config.generation?config.generation->multiplier:0;generationEnabled=bool(generator);
    pacing=config.adaptive?std::make_unique<AdaptivePacing>(*config.adaptive):nullptr;
   }
   if(generator)start();
   else if(link&&CVDisplayLinkIsRunning(link))CVDisplayLinkStop(link);
  }else if(planMode){
   auto desired=presentationGraphicsEnvironment();if(!modelColorSupported(colorSpace)){desired.generation.reset();desired.adaptive.reset();}auto next=desired.generation?std::make_shared<LsfgEncoder>(layer.device,*desired.generation):nullptr;
   {std::lock_guard<std::mutex>lock(mutex);if(inFlight){result.busy=true;result.reason="Waiting for the current graphics frame";return false;}retireDelivery();generator=std::move(next);execution.reset();planMode=false;config.generation=desired.generation;config.adaptive=desired.adaptive;pool.clear();historyReady=false;generationSequence=0;appliedControls=~uint64_t(0);}
  }
  return true;
 }
 void publish(const std::shared_ptr<Batch>&batch,bool ready){
   CAMetalLayer *layer=layerSnapshot();
   const auto size=layer.drawableSize;
   std::lock_guard<std::mutex>lock(mutex);if(stopping.load()){retireBatch(batch);return;}if(batch->epoch!=presentationEpoch){++status.dropped;retireBatch(batch);return;}const double now=CACurrentMediaTime();if(generator&&!generationEnabled){retireBatch(batch);return;}
   // A producer may complete after the window changed its backing dimensions.
   // Retire that old output without replacing the resized frame's delivery plan.
   if(batch->outputWidth!=size.width||batch->outputHeight!=size.height||batch->outputWidth!=width||batch->outputHeight!=height){++status.dropped;retireBatch(batch);return;}
   if(generator){if(!ready)batch->phases={};const auto phases=batch->phases;
    // Only completed real images establish the generation timeline. Busy raw
    // producer attempts must not compress a slower reconstruction interval.
    const double fresh=latest?batch->sourceTime-latest->sourceTime:batch->sourcePeriod;
    if(std::isfinite(fresh)&&fresh>0)batch->sourcePeriod=boundedSourcePeriod(fresh);
    if(delivery.replace(batch->id,phases,now,batch->sourcePeriod)){if(latest!=batch)retireBatch(latest);latest=batch;}else retireBatch(batch);deliveryMetrics();}
   else {if(immediate)++status.dropped;immediate=Display{batch,-1,now};}
   if(!generator){status.pending=immediate?1:0;status.maxPending=std::max(status.maxPending,status.pending);}
   schedule();}
 // The caller owns submission. Effects-only output is encoded into the producer
 // buffer itself; generated output uses the paced presentation queue.
 void encodeFlipped(id<MTLCommandBuffer>commands,id<MTLTexture>image,id<MTLTexture>output){
  CAMetalLayer *layer=layerSnapshot();
  if(!flipPipeline){
   const char*text=R"MSL(#include <metal_stdlib>
using namespace metal;
vertex float4 output_vertex(uint id [[vertex_id]]){const float2 points[]={float2(-1,-1),float2(3,-1),float2(-1,3)};return float4(points[id],0,1);}
fragment float4 output_flip(float4 p [[position]],texture2d<float,access::read>image [[texture(0)]]){return image.read(uint2(uint(p.x),image.get_height()-1-uint(p.y)));}
)MSL";
   NSError*error=nil;auto library=[layer.device newLibraryWithSource:@(text) options:nil error:&error];if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile presentation orientation");
   auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"output_vertex"];descriptor.fragmentFunction=[library newFunctionWithName:@"output_flip"];descriptor.colorAttachments[0].pixelFormat=layer.pixelFormat;flipPipeline=[layer.device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!flipPipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create presentation orientation");
  }
  auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=output;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Cannot encode presentation orientation");[encoder setRenderPipelineState:flipPipeline];[encoder setFragmentTexture:image atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
 }
 bool encodeFinal(id<MTLCommandBuffer>commands,id<CAMetalDrawable>drawable,const Display&display,bool producer,std::shared_ptr<Retirement>retirement={}){
  CAMetalLayer *layer=layerSnapshot();
  if(display.generated<0&&!retirement)retirement=display.batch->retirement;
  uint64_t frameHoldEpoch=0;
  {std::lock_guard<std::mutex>lock(mutex);if(stopping.load()||display.batch->retired||display.batch->epoch!=presentationEpoch||holdActive&&(!holdResuming||display.batch->contract!=desiredHoldContract)){++status.dropped;if(display.generated<0)retireBatch(display.batch);return false;}if(holdActive)frameHoldEpoch=holdStatus.epoch;}
  const auto image=display.generated<0?display.batch->real:display.batch->generated.at(display.generated);
  const auto outputSize=layer.drawableSize;
  if(display.batch->outputWidth!=outputSize.width||display.batch->outputHeight!=outputSize.height||drawable.texture.width!=outputSize.width||drawable.texture.height!=outputSize.height){std::lock_guard<std::mutex>lock(mutex);++status.dropped;return false;}
  id<MTLTexture> final=image;
  if(display.batch->execution&&!display.replay){
   // The batch retains its exact chain even if a later source selects another
   // revision. Generated images receive no fabricated game depth or motion.
   id<MTLTexture> target=drawable.texture;
   if(config.flipY)target=makeTexture(layer.device,drawable.texture.width,drawable.texture.height,drawable.texture.pixelFormat);
   const double time=display.due>0?display.due:display.batch->sourceTime;
   ShaderFrame frame{commands,image,target,++outputSequence,(time-begun)*1000,float(display.batch->sourcePeriod*1000/(display.batch->phases.count+1)),config.origin,SpatialColor::Perceptual,nullptr};
   frame.opaqueDisplay=display.batch->opaqueDisplay;
   const auto encoded=display.batch->execution->hasTemporal()?display.batch->execution->encodeAfterScene(frame,true,display.generated>=0):display.batch->execution->encode(frame,true,display.generated>=0);
   if(!encoded.encoded){if(encoded.busy){std::lock_guard<std::mutex>lock(mutex);++status.dropped;return false;}throw std::runtime_error(encoded.reason);}
   final=target;
  }
  if(config.flipY&&!display.replay)encodeFlipped(commands,final,drawable.texture);else if(final!=drawable.texture){
  auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Cannot create final presentation encoder");
  [copy copyFromTexture:final sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(final.width,final.height,1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
  if(display.batch->capture&&!display.replay)display.batch->capture->finish(commands,drawable.texture);
  // Only a prepared virtual transition opts into this one immutable image.
  // Capture final orientation/effects once, before the producer may be hidden.
  bool captureReplay=false;if(replayEnabled.load(std::memory_order_relaxed)&&display.generated<0&&!display.replay){std::lock_guard<std::mutex>lock(mutex);if(replayEnabled&&!replayCapture&&!completedReplay){replayCapture=true;captureReplay=true;}}
  if(captureReplay){
   auto snapshot=std::make_shared<Batch>();snapshot->id=display.batch->id;snapshot->epoch=display.batch->epoch;snapshot->sourceTime=display.batch->sourceTime;
   snapshot->outputWidth=drawable.texture.width;snapshot->outputHeight=drawable.texture.height;snapshot->contract=display.batch->contract;snapshot->opaqueDisplay=display.batch->opaqueDisplay;
   try{snapshot->real=makeTexture(layer.device,drawable.texture.width,drawable.texture.height,drawable.texture.pixelFormat);
    auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Cannot retain completed presentation image");
    [copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(drawable.texture.width,drawable.texture.height,1) toTexture:snapshot->real destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
    std::weak_ptr<Impl>weakReplay=shared_from_this();[commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(auto self=weakReplay.lock()){
     CAMetalLayer *layer=self->layerSnapshot();const auto size=layer.drawableSize;std::lock_guard<std::mutex>lock(self->mutex);self->replayCapture=false;
     if(self->replayEnabled&&!self->stopping.load()&&completed.status==MTLCommandBufferStatusCompleted&&snapshot->epoch==self->presentationEpoch&&snapshot->real.width==size.width&&snapshot->real.height==size.height)self->completedReplay=snapshot;
    }}];
   }catch(...){std::lock_guard<std::mutex>lock(mutex);replayCapture=false;throw;}
  }
  auto held=std::make_shared<std::optional<Display>>(display);std::weak_ptr<Impl>weak=shared_from_this();
  const auto generated=display.generated;const bool replay=display.replay;const auto frameWidth=display.batch->outputWidth,frameHeight=display.batch->outputHeight;const auto frameId=display.batch->id,frameEpoch=display.batch->epoch;const auto frameTime=display.batch->sourceTime;
  const auto frameContract=display.batch->contract;const bool frameOpaque=display.batch->opaqueDisplay;const auto observedBatch=display.batch;
  auto issued=std::make_shared<PresentationTicket>(); // Protected by Impl::mutex.
  const bool targeted=display.batch->targeted;const double requestedTime=display.batch->target;
  auto retirementCompletion=retirement?std::make_shared<CompletionLease>([retirement](bool completed){if(!completed)retirement->completed(MTLCommandBufferStatusNotEnqueued);}):nullptr;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){held->reset();if(auto self=weak.lock()){
    if(completed.status!=MTLCommandBufferStatusCompleted){std::lock_guard<std::mutex>lock(self->mutex);
     if(issued->completed()&&self->issuedPresentations)--self->issuedPresentations;
     if(completed.status==MTLCommandBufferStatusError&&frameHoldEpoch&&self->holdActive&&frameHoldEpoch==self->holdStatus.epoch&&frameContract==self->desiredHoldContract){self->holdResuming=false;self->holdStatus.state="failed";self->holdStatus.reason="A pending presentation failed on the GPU";}
    }
    CAMetalLayer *layer=self->layerSnapshot();const auto currentSize=layer.drawableSize;
    if(!replay&&generated<0&&completed.status==MTLCommandBufferStatusCompleted&&currentSize.width==frameWidth&&currentSize.height==frameHeight){std::lock_guard<std::mutex>lock(self->mutex);if(frameEpoch==self->presentationEpoch){++self->status.completedReal;self->observe(RuntimeStatusPhase::Completed,observedBatch,false);self->lastRealCompleted=std::max(self->lastRealCompleted,frameId);}}
    if(targeted){std::lock_guard<std::mutex>lock(self->mutex);if(completed.status==MTLCommandBufferStatusCompleted){++self->timing.completed;self->timing.lastCompletedFrame=frameId;self->timing.lastCompletedTime=CACurrentMediaTime();}else if(completed.status==MTLCommandBufferStatusError)++self->timing.gpuFailed;else ++self->timing.cancelled;}
    // Metal also invokes completion handlers with NotEnqueued when a host
    // discards its buffer. That is cancellation, not a GPU processing error.
    if(completed.status==MTLCommandBufferStatusError)self->gpuFailure(observedBatch,completed.error.localizedDescription.UTF8String?:"Presentation failed");
  }if(retirement){retirement->completed(completed.status);retirementCompletion->finish(true);}
   else if(completed.status==MTLCommandBufferStatusError&&observedBatch->retirement)observedBatch->retirement->completed(completed.status);
  }];
  [drawable addPresentedHandler:^(id<MTLDrawable>presented){
    const double time=presented.presentedTime;const bool displayed=std::isfinite(time)&&time>0;
    if(auto self=weak.lock()){
    CAMetalLayer *layer=self->layerSnapshot();const auto size=layer.drawableSize;
    std::lock_guard<std::mutex>lock(self->mutex);
    if(issued->completed()&&self->issuedPresentations)--self->issuedPresentations;
    if(displayed){
     self->lastVisible.frameId=frameId;self->lastVisible.width=frameWidth;self->lastVisible.height=frameHeight;
     self->lastVisible.presentedTime=time;self->lastVisible.contract=frameContract;self->lastVisibleOpaque=frameOpaque;self->visibleEpoch=frameEpoch;
     if(self->holdActive&&self->holdResuming&&frameEpoch==self->presentationEpoch&&frameContract==self->desiredHoldContract){
      if(size.width==frameWidth&&size.height==frameHeight){self->holdStatus.state="settling";self->holdStatus.frameId=frameId;
       self->holdStatus.width=frameWidth;self->holdStatus.height=frameHeight;self->holdStatus.presentedTime=time;self->holdStatus.contract=frameContract;
       // The launcher must durably acknowledge this actual displayed image
       // before continuous presentation resumes. ACK loss remains rollback-safe.
       self->holdResuming=false;self->retireDelivery(retirement.get());}
     }
    }
    self->advanceHold(size);
    // A callback can report zero when the drawable never reached the display.
    // Coalesced drawables can share a display timestamp; count that instant once.
    if(!displayed||std::find(self->recentPresentations.begin(),self->recentPresentations.end(),time)!=self->recentPresentations.end()){++self->status.dropped;if(targeted)++self->timing.skipped;}
    else {self->recentPresentations[self->presentationCursor++%self->recentPresentations.size()]=time;
    DiagnosticScope scope(generated<0?DiagnosticStage::PresentedReal:DiagnosticStage::PresentedGenerated,reinterpret_cast<uintptr_t>(self->owner),frameWidth,frameHeight);
    if(generated<0){++self->status.presentedReal;self->lastRealDisplayed=time;}else ++self->status.presentedGenerated;
    if(!replay&&self->pacing&&frameEpoch==self->presentationEpoch)self->pacing->reportPresented(generated>=0,frameTime,time);
    if(targeted){++self->timing.presented;self->timing.lastPresentedFrame=frameId;self->timing.lastPresentedTarget=requestedTime;self->timing.lastPresentedTime=time;++self->timing.lateness[targettime::bucket(requestedTime,time)];}
    if(!replay)self->observe(RuntimeStatusPhase::Presented,observedBatch,generated>=0,time);
    self->status.lastPresentedFrame=frameId;self->status.lastLatencyMs=std::max(0.,(time-frameTime)*1000);}
  }if(retirement)retirement->displayed(time);}];
   // Match command-buffer presentDrawable scheduling, while retaining the
   // host-owner cancellation check and the original requested target. Waiting
   // for GPU completion here stalls drawable recycling even with no effects.
   // Never take submission: the next producer may hold it in nextDrawable.
   [commands addScheduledHandler:^(id<MTLCommandBuffer>scheduled){if(auto self=weak.lock()){
    DiagnosticScope scheduledScope(DiagnosticStage::MetalDrawable,reinterpret_cast<uintptr_t>(self->owner),frameWidth,frameHeight,"presentation.scheduled");
    if(self->stopping.load()||scheduled.status<MTLCommandBufferStatusScheduled||scheduled.status==MTLCommandBufferStatusError)return;
    CAMetalLayer *layer=self->layerSnapshot();const auto currentSize=layer.drawableSize;
    bool admitted=false;{std::lock_guard<std::mutex>lock(self->mutex);
     if(!self->stopping.load()&&!observedBatch->retired&&frameEpoch==self->presentationEpoch&&currentSize.width==frameWidth&&currentSize.height==frameHeight&&
        (!self->holdActive||self->holdResuming&&frameContract==self->desiredHoldContract)&&issued->reserve()){
      admitted=true;++self->issuedPresentations;
      if(generated<0)observedBatch->realIssued=true;
     }else ++self->status.dropped;
    }
    if(!admitted){if(retirement)retirement->cancel();return;}
    // Metal/CA and injected callbacks may reenter this presenter. Reserve the
    // issuance under its mutex, then make the foreign call without that lock.
    // A hold/cancel drains this ticket through BOTH return and retirement;
    // a synchronous presented callback cannot acknowledge the barrier early.
    std::string failure;
    @try{try{DiagnosticScope driverScope(DiagnosticStage::MetalDrawable,reinterpret_cast<uintptr_t>(self->owner),frameWidth,frameHeight,"presentation.driver-present");
     if(targeted&&targettime::schedule(requestedTime,CACurrentMediaTime()))[drawable presentAtTime:requestedTime];else [drawable present];}
     catch(const std::exception&error){failure=error.what();}}
    @catch(NSException*error){failure=error.reason.UTF8String?:"Drawable presentation failed";}
    const auto finalSize=layer.drawableSize;
    {std::lock_guard<std::mutex>lock(self->mutex);
     if(!failure.empty()&&issued->completed()&&self->issuedPresentations)--self->issuedPresentations;
     if(issued->callReturned()&&self->issuedPresentations)--self->issuedPresentations;
     if(!failure.empty()){
      self->failWithoutLock(failure);
      if(frameHoldEpoch&&self->holdActive&&frameHoldEpoch==self->holdStatus.epoch&&frameContract==self->desiredHoldContract){self->holdResuming=false;self->holdStatus.state="failed";self->holdStatus.reason=failure;}
     }
     self->advanceHold(finalSize);
    }
    if(!failure.empty()&&retirement)retirement->cancel();
   }}];
  return true;
 }
 bool replayCompleted(){
  {std::lock_guard<std::mutex>lock(mutex);if(stopping.load()||!replayEnabled||replayPending||!completedReplay||completedReplay->epoch!=presentationEpoch||holdActive)return false;}
  if(!privateCommandsQueue())return false;
  {std::lock_guard<std::mutex>lock(mutex);if(stopping.load()||!replayEnabled||replayPending||!completedReplay||completedReplay->epoch!=presentationEpoch||holdActive)return false;replayPending=true;}
  auto self=shared_from_this();dispatch_async(worker,^{@autoreleasepool{
   bool committed=false;
   @try{try{std::shared_ptr<Batch>image;{std::lock_guard<std::mutex>lock(self->mutex);if(!self->stopping.load()&&self->replayEnabled)image=self->completedReplay;}
    if(image){CAMetalLayer *layer=self->layerSnapshot();auto drawable=[layer nextDrawable];if(drawable){auto commands=[self->privateCommandsQueue() commandBuffer];if(commands){ownPresentationBuffer(commands);
     // A replay uses the original ID/time and already finished image. Its
     // real display callback remains the only positive visibility evidence.
     self->encodeFinal(commands,drawable,{image,-1,CACurrentMediaTime(),true},false);
     [commands addCompletedHandler:^(id<MTLCommandBuffer>){std::lock_guard<std::mutex>lock(self->mutex);self->replayPending=false;}];
     [commands commit];committed=true;
    }}}
   }catch(const std::exception&e){self->fail(e.what());}}@catch(NSException*e){self->fail(e.reason.UTF8String?:"Presentation replay failed");}
   if(!committed){std::lock_guard<std::mutex>lock(self->mutex);self->replayPending=false;}
  }});return true;
 }
 void pump(){pollRuntimeStatus(imageProcessingRequested());std::shared_ptr<Batch>undeliveredReal;@try{try{
   CAMetalLayer *layer=layerSnapshot();
   std::optional<Display>display;{std::lock_guard<std::mutex>lock(mutex);if(stopping.load()){pumpQueued.store(false);return;}if(generator&&generationEnabled){const auto due=delivery.take(CACurrentMediaTime());if(due&&latest&&due->sourceId==latest->id)display=Display{latest,due->generated,due->due};deliveryMetrics();}else if(immediate){display=immediate;immediate.reset();status.pending=0;}}
   {std::lock_guard<std::mutex>lock(mutex);if(holdActive&&!holdResuming)display.reset();}
   if(display&&display->batch->id==lastQueuedFrame&&display->generated==lastQueuedGenerated)display.reset();
   if(display){if(display->generated<0)undeliveredReal=display->batch;auto drawable=[layer nextDrawable];if(!drawable){std::lock_guard<std::mutex>lock(mutex);++status.dropped;}else{const auto image=display->generated<0?display->batch->real:display->batch->generated.at(display->generated);if(drawable.texture.width!=display->batch->outputWidth||drawable.texture.height!=display->batch->outputHeight){std::lock_guard<std::mutex>lock(mutex);++status.dropped;}else if(drawable.texture.pixelFormat!=image.pixelFormat){fail("Presentation pixel format changed before the frame completed");}else{
     auto commands=[privateCommandsQueue() commandBuffer];if(!commands)throw std::runtime_error("Independent presentation commands are unavailable");ownPresentationBuffer(commands);const bool presented=encodeFinal(commands,drawable,*display,false);[commands commit];if(presented){lastQueuedFrame=display->batch->id;lastQueuedGenerated=display->generated;undeliveredReal.reset();}
   }}}
  }catch(const std::exception&e){fail(e.what());}}@catch(NSException*e){fail(e.reason.UTF8String?:"Presentation failed");}
  if(undeliveredReal){std::lock_guard<std::mutex>lock(mutex);retireBatch(undeliveredReal);}
  pumpQueued.store(false);bool more=false;{std::lock_guard<std::mutex>lock(mutex);more=immediate.has_value();if(wakeup&&!stopping.load()){const auto next=delivery.nextTime();dispatch_source_set_timer(wakeup,next?dispatch_time(DISPATCH_TIME_NOW,int64_t(std::max(0.,*next-CACurrentMediaTime())*NSEC_PER_SEC)):DISPATCH_TIME_FOREVER,DISPATCH_TIME_FOREVER,100*NSEC_PER_USEC);}}if(more)schedule();
 }
 std::shared_ptr<Batch>acquire(unsigned w,unsigned h){
  const unsigned gw=planMode&&execution&&generator?execution->generationWidth():w,gh=planMode&&execution&&generator?execution->generationHeight():h;
  std::lock_guard<std::mutex>lock(mutex);const unsigned capacity=generator&&generationEnabled?1:std::min(4u,unsigned(layer.maximumDrawableCount));if(inFlight>=capacity)return {};
  if(width!=w||height!=h||!pool.empty()&&(pool.front()->real.width!=gw||pool.front()->real.height!=gh)){cancelRetirements();completedReplay.reset();pool.clear();immediate.reset();latest.reset();delivery.reset();accountedDeliveryDrops=0;if(pacing)pacing->reset();historyReady=false;width=w;height=h;}
  std::shared_ptr<Batch>batch;for(auto&candidate:pool)if(candidate.use_count()==1){batch=candidate;break;}
  if(!batch){if(pool.size()>=4)return {};batch=std::make_shared<Batch>();batch->admitted.reserve(4);batch->real=makeTexture(layer.device,gw,gh,layer.pixelFormat);batch->outputWidth=w;batch->outputHeight=h;pool.push_back(batch);}
  batch->epoch=presentationEpoch;batch->retirement.reset();batch->generationAdmission.reset();batch->realIssued=false;batch->retired=false;
  if(generator&&generationEnabled&&config.generation&&batch->generated.size()<config.generation->multiplier-1&&CACurrentMediaTime()>=batch->generationRetry){
   try{while(batch->generated.size()<config.generation->multiplier-1)batch->generated.push_back(makeTexture(layer.device,gw,gh,layer.pixelFormat));}
   catch(const ImageBudgetExceeded&){batch->generationRetry=CACurrentMediaTime()+.25;}
  }return batch;
 }
 bool admitGeneration(const std::shared_ptr<Batch>&batch,uint64_t sequence){
  if(!config.generation||batch->generated.size()<config.generation->multiplier-1||CACurrentMediaTime()<generationRetry)return false;
  const auto w=unsigned(batch->real.width),h=unsigned(batch->real.height);
  if(admittedGenerator!=generator.get()||admittedGenerationWidth!=w||admittedGenerationHeight!=h||sequence!=admittedGenerationSequence+1){
   try{const auto bytes=generationImageBytes(w,h,config.generation->multiplier,config.generation->flowScale,config.generation->performance,[&](unsigned x,unsigned y,unsigned pixel){
     auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixel==1?MTLPixelFormatR8Unorm:pixel==8?MTLPixelFormatRGBA16Float:MTLPixelFormatRGBA8Unorm width:x height:y mipmapped:NO];desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return uint64_t([layer.device heapTextureSizeAndAlignWithDescriptor:desc].size);});
    auto candidate=reserveImageBytes(layer.device,bytes,reinterpret_cast<uintptr_t>(owner),"frame-generation-memory");
    // Commit an image envelope before the provider can construct its graph.
    // Keep both old and candidate charged until the provider replaces it.
    candidate->commit();batch->previousGenerationAdmission=generationAdmission;generationAdmission=std::move(candidate);admittedGenerator=generator.get();admittedGenerationWidth=w;admittedGenerationHeight=h;
   }catch(const ImageBudgetExceeded&){generationRetry=CACurrentMediaTime()+.25;return false;}
  }
  batch->generationAdmission=generationAdmission;admittedGenerationSequence=sequence;return true;
 }

 bool traceDetachedRetirement(){if(!std::getenv("RESHADE_TRACE"))return false;const auto now=CACurrentMediaTime();if(now-lastDetachedRetirementTrace<2)return false;lastDetachedRetirementTrace=now;return true;}
 void processDetached(std::shared_ptr<Batch>batch,std::shared_ptr<CompletionLease>lease){@autoreleasepool{
  pollRuntimeStatus(imageProcessingRequested());
  id<MTLCommandBuffer>commands=nil;auto produced=std::make_shared<std::atomic<bool>>(false);
  @try{try{
   std::lock_guard<std::mutex>serial(submission);
   const auto size=layer.drawableSize;
   if(stopping.load()||!planMode||execution!=batch->execution||size.width!=batch->real.width||size.height!=batch->real.height){if(traceDetachedRetirement())nativeLog("Detached neural source retired: stopping="+std::to_string(stopping.load())+" plan="+std::to_string(planMode)+" changed="+std::to_string(execution!=batch->execution)+" current="+std::to_string(size.width)+"x"+std::to_string(size.height)+" source="+std::to_string(batch->real.width)+"x"+std::to_string(batch->real.height));lease->finish(false);return;}
   auto drawable=[layer nextDrawable];if(!drawable||drawable.texture.width!=batch->real.width||drawable.texture.height!=batch->real.height||drawable.texture.pixelFormat!=batch->real.pixelFormat){if(traceDetachedRetirement())nativeLog("Detached neural drawable unavailable or changed: drawable="+std::to_string(bool(drawable))+" current="+std::to_string(drawable.texture.width)+"x"+std::to_string(drawable.texture.height)+" source="+std::to_string(batch->real.width)+"x"+std::to_string(batch->real.height));lease->finish(false);return;}
   commands=[privateCommandsQueue() commandBuffer];if(!commands)throw std::runtime_error("Cannot create independent neural presentation commands");ownPresentationBuffer(commands);
   std::weak_ptr<Impl> detachedOwner=shared_from_this();
   [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status==MTLCommandBufferStatusError)if(auto self=detachedOwner.lock())self->gpuFailure(batch,completed.error.localizedDescription.UTF8String?:"Independent neural presentation failed");lease->finish(produced->load()&&completed.status==MTLCommandBufferStatusCompleted);}];
   ShaderFrame frame{commands,batch->sourceSnapshot,batch->real,batch->id,(batch->sourceTime-begun)*1000,float(batch->sourcePeriod*1000),config.origin,SpatialColor::Perceptual,nullptr,batch->opaqueDisplay};
   const auto encoded=batch->execution->encode(frame);
   if(encoded.encoded)produced->store(encodeFinal(commands,drawable,{batch,-1,batch->sourceTime},false));
   else if(!encoded.busy)fail(encoded.reason);
   // This buffer is owned by presentation. Even a later failed row may have
   // admitted neural work; submit its encoded producer signal for retirement.
   [commands commit];
  }catch(const ImageBudgetExceeded&){if(commands&&commands.status<MTLCommandBufferStatusCommitted)[commands commit];else if(!commands)lease->finish(false);}
   catch(const std::exception&e){fail(e.what());if(commands&&commands.status<MTLCommandBufferStatusCommitted)[commands commit];else if(!commands)lease->finish(false);}}
  @catch(NSException*e){fail(e.reason.UTF8String?:"Independent neural presentation failed");if(commands&&commands.status<MTLCommandBufferStatusCommitted)[commands commit];else if(!commands)lease->finish(false);}
 }}
 FrameResult submitDetached(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime,double sourcePeriod,bool opaque){
  FrameResult result;result.effects=true;
  {std::lock_guard<std::mutex>lock(mutex);if(inFlight){++status.dropped;result.busy=true;result.reason="Neural processing is occupied; the previous completed frame remains displayed";return result;}}
  const auto size=layer.drawableSize;auto batch=acquire(size.width,size.height);if(!batch){result.busy=true;result.reason="Independent neural resource capacity is busy";return result;}
  batch->inputWidth=source.width;batch->inputHeight=source.height;batch->id=frameId;batch->sourceTime=sourceTime;batch->sourcePeriod=sourcePeriod;batch->targeted=false;batch->execution=execution;batch->opaqueDisplay=opaque;publicationFor(batch,source);stamp(batch);
  if(!batch->sourceSnapshot||batch->sourceSnapshot.width!=source.width||batch->sourceSnapshot.height!=source.height||batch->sourceSnapshot.pixelFormat!=source.pixelFormat)
   batch->sourceSnapshot=makeTexture(layer.device,source.width,source.height,source.pixelFormat);
  auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Cannot retain an independent neural source frame");
  [copy copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:batch->sourceSnapshot destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
  batch->capture=FrameCapture::begin(commands,source,frameId,config.origin==FrameOrigin::BottomLeft);
  std::weak_ptr<Impl>weak=shared_from_this();
  auto lease=std::make_shared<CompletionLease>([weak,batch](bool success){if(auto self=weak.lock()){std::lock_guard<std::mutex>lock(self->mutex);if(self->inFlight)--self->inFlight;if(self->status.pending)--self->status.pending;if(!success)++self->status.dropped;}});
  {std::lock_guard<std::mutex>lock(mutex);++inFlight;++status.pending;status.maxPending=std::max(status.maxPending,status.pending);++status.encoded;}
  // No waits or submission are added to the game's buffer. Its completion is
  // the handoff; an abandoned buffer releases the lease without running MLX.
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status!=MTLCommandBufferStatusCompleted){lease->finish(false);return;}if(auto self=weak.lock())dispatch_async(self->worker,^{self->processDetached(batch,lease);});else lease->finish(false);}];
  lastSubmission=frameId;if(!config.sourceFrameRate&&lastSourceTime)interval=updateSourceInterval(interval,sourceTime-lastSourceTime);lastSourceTime=sourceTime;
  result.encoded=true;return result;
 }
 FrameResult submit(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target,const DepthFrame* depth=nullptr,const RSPresentationObserver*observer=nullptr,bool opaque=true){std::unique_lock<std::mutex>serial(submission,std::try_to_lock);FrameResult result;
  std::optional<FrameEncodingInputs>heldInputs;std::optional<LiveStatePin>inputPin;std::optional<PresentationContract>heldContract;uint64_t heldEpoch=0;
  @try {try {result=[&]()->FrameResult {if(!serial.owns_lock()){result.busy=true;result.reason="Graphics presentation is occupied; the previous completed frame remains displayed";return result;}
  {std::lock_guard<std::mutex>lock(mutex);if(holdActive){heldEpoch=holdStatus.epoch;heldContract=desiredHoldContract;}}
  if(stopping.load()){result.reason="Presentation is stopped";return result;}if(gpuFailed.load()){std::lock_guard lock(mutex);result.reason=status.reason.empty()?"The presentation GPU context failed; original rendering is retained":status.reason;return result;}if(!std::isfinite(sourceTime)||sourceTime<=0||frameId<=lastSubmission||sourceTime<=lastSourceTime){result.reason="Presentation timestamps and frame IDs must increase";return result;}
  if(!commands||!source||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences){result.reason="Presentation requires an unsubmitted retaining command buffer and source";return result;}
  const double sourcePeriod=measuredSourcePeriod(sourceTime,lastSourceTime,interval);
  if(!admitHeld(result,opaque,source,heldInputs,inputPin,heldEpoch,heldContract))return result;
  // A configured channel also records ordinary baseline output honestly. The
  // synchronous pin spans plan/config selection through uniforms and stamping.
  if(presentationHoldConfigured()&&!inputPin)inputPin.emplace();
  if(!updatePlan(commands,source,frameId,sourceTime,sourcePeriod,depth,opaque,result))return result;
  if(!planMode&&!updateControls()){result.busy=true;result.reason="Waiting for the current graphics frame";return result;}
  {const auto accepted=plans->snapshot();const auto revision=planMode&&execution?execution->revision():accepted&&accepted->mode=="simple"?accepted->revision:std::string{};
   if(!revision.empty()){const auto controlsIdentity=presentationControlsDigest();RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(owner);event.processing=true;event.resourceAccepted=true;event.phase=RuntimeStatusPhase::Prepared;event.planRevision=revision;event.controlsDigest=controlsIdentity;observeRuntimeStatus(event);}}
  if(!opaque&&generator&&generationEnabled){result.reason="Frame generation requires an opaque source image";return result;}
  const double targetSubmittedAt=target?CACurrentMediaTime():0;
  if(target){
   std::lock_guard<std::mutex>lock(mutex);++timing.requested;timing.lastRequestedTime=target->hostTime;
   auto decision=targettime::admit(target->hostTime,targetSubmittedAt);
   if((generator&&generationEnabled)||decision!=targettime::Admission::Accept){++timing.rejected;result.reason=generator&&generationEnabled?"Targeted frame generation is not supported":decision==targettime::Admission::TooFar?"Presentation target exceeds the one-second holding limit":"Invalid presentation target";return result;}
  }
  {std::lock_guard<std::mutex>lock(mutex);++status.submitted;}
  if(std::getenv("RESHADE_TRACE")&&sourceTime-lastTrace>2){lastTrace=sourceTime;std::lock_guard<std::mutex>lock(mutex);nativeLog("Presentation status submitted="+std::to_string(status.submitted)+" encoded="+std::to_string(status.encoded)+" inFlight="+std::to_string(inFlight)+" pool="+std::to_string(pool.size())+" real="+std::to_string(status.presentedReal)+" generated="+std::to_string(status.presentedGenerated)+" pending="+std::to_string(status.pending)+" dropped="+std::to_string(status.dropped)+" sourceAgeMs="+std::to_string(status.lastLatencyMs)+" reason="+status.reason);}
  const auto size=layer.drawableSize;if(!std::isfinite(size.width)||!std::isfinite(size.height)||size.width<1||size.height<1||size.width>16384||size.height>16384){result.reason="Invalid presentation dimensions";return result;}
  if(planMode&&execution&&execution->canDetachNeural()&&!target&&!observer&&!depth&&privateCommandsQueue())return submitDetached(commands,source,frameId,sourceTime,sourcePeriod,opaque);
  auto batch=acquire(size.width,size.height);if(!batch){std::lock_guard<std::mutex>lock(mutex);++status.dropped;result.busy=true;result.reason="Presentation queue is full";return result;}batch->inputWidth=source.width;batch->inputHeight=source.height;batch->id=frameId;batch->sourceTime=sourceTime;batch->sourcePeriod=sourcePeriod;batch->targeted=target!=nullptr;batch->target=target?target->hostTime:0;batch->execution=planMode?execution:nullptr;
  if(batch->execution)stamp(batch);else batch->contract={};
  if(heldInputs&&batch->execution&&batch->execution->revision()!=heldInputs->plan->revision){
   result.reason="The encoded plan does not match the held graphics publication";
   if(!failHeldAttempt(heldEpoch,{heldInputs->plan->revision,heldInputs->controlsDigest},result.reason))result.busy=true;return result;
  }
  id<CAMetalDrawable>drawable=nil;
  if(!generator||!generationEnabled){
   if(!commands||commands.status>=MTLCommandBufferStatusCommitted){result.reason="Presentation requires an unsubmitted command buffer";return result;}
   drawable=[layer nextDrawable];if(!drawable){{std::lock_guard<std::mutex>lock(mutex);++status.dropped;}result.busy=true;result.reason="Presentation layer has no available drawable";return result;}
   if(drawable.texture.width!=batch->outputWidth||drawable.texture.height!=batch->outputHeight){std::lock_guard<std::mutex>lock(mutex);++status.dropped;result.busy=true;result.reason="Presentation size changed before encoding";return result;}
   if(drawable.texture.pixelFormat!=batch->real.pixelFormat){result.reason="Presentation pixel format changed before encoding";fail(result.reason);return result;}
  }
  struct ProducerState {std::atomic<bool>pending{false},dropped{false};};
  std::weak_ptr<Impl>weak=shared_from_this();auto producer=std::make_shared<ProducerState>();
  auto lease=std::make_shared<CompletionLease>([weak,producer,batch](bool success){if(auto self=weak.lock()){std::lock_guard<std::mutex>lock(self->mutex);if(self->inFlight)--self->inFlight;if(producer->pending.load()&&self->status.pending)--self->status.pending;if(!success){if(!producer->dropped.exchange(true))++self->status.dropped;if(self->pacing){self->pacing->reset();self->historyReady=false;}}}});
  {std::lock_guard<std::mutex>lock(mutex);++inFlight;}
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){lease->finish(completed.status==MTLCommandBufferStatusCompleted);}];
  batch->capture.reset();
  batch->opaqueDisplay=opaque;publicationFor(batch,source);
  if(batch->execution){
   batch->capture=sceneCapture?std::move(sceneCapture):FrameCapture::begin(commands,source,frameId,config.origin==FrameOrigin::BottomLeft);
   const ShaderFrame context{commands,source,batch->real,frameId,(sourceTime-begun)*1000,float(batch->sourcePeriod*1000),config.origin,SpatialColor::Perceptual,depth,opaque};
   const auto encoded=batch->execution->hasTemporal()?batch->execution->encodeAfterScene(context):batch->execution->encode(context);result.encoded=encoded.encoded;result.busy=encoded.busy;result.reason=encoded.reason;result.effects=true;
  }else {
   FrameEncodingReceipt encoded;
   result=processFrameWithDepth(owner,commands,{source,batch->real,frameId,SpatialColor::Perceptual,config.origin},config.method,depth,opaque,
       heldInputs?&*heldInputs:nullptr,presentationHoldConfigured()?&encoded:nullptr);
   if(result.encoded&&presentationHoldConfigured()){
    if(!result.effects&&encoded.planRevision.empty()){
     const auto actual=plans->snapshot();if(actual&&actual->mode=="simple")encoded.planRevision=actual->revision;
    }
    batch->contract={encoded.planRevision,encoded.controlsDigest};
   }
  }
  if(result.encoded&&heldInputs&&batch->contract!=PresentationContract{heldInputs->plan->revision,heldInputs->controlsDigest}){
   result.encoded=false;result.reason="The encoded image does not match the held graphics publication";
  }
  if(!result.encoded){if(result.busy){std::lock_guard<std::mutex>lock(mutex);if(!producer->dropped.exchange(true))++status.dropped;}else {
    if(heldInputs){if(!failHeldAttempt(heldEpoch,{heldInputs->plan->revision,heldInputs->controlsDigest},result.reason)){result.busy=true;result.reason="A newer graphics update replaced this frame";}}
    else fail(result.reason);
   }return result;}
  auto retirement=observer?std::make_shared<Retirement>(*observer,frameId):nullptr;
  bool generatedReady=false;if(generator&&generationEnabled){
   InterpolationPlan phases;unsigned requested=0;
   if(pacing){std::lock_guard<std::mutex>lock(mutex);const auto refresh=displayHz.load();if(refresh&&refresh!=appliedRefresh){auto options=*config.adaptive;options.displayRefreshHz=refresh;pacing=std::make_unique<AdaptivePacing>(options);appliedRefresh=refresh;}const auto decision=pacing->observe(frameId,sourceTime,historyReady,5);if(!decision.valid){result.encoded=false;result.reason="Adaptive source identity or submission time is invalid";failWithoutLock(result.reason);return result;}phases=decision.admitted;requested=decision.requested.count;}
   else {const unsigned multiplier=liveMultiplier?liveMultiplier:config.generation->multiplier;phases.count=multiplier-1;for(unsigned i=0;i<phases.count;++i)phases.timestamps[i]=float(i+1)/multiplier;}
   batch->phases=phases;batch->admitted.assign(batch->generated.begin(),batch->generated.begin()+std::min<size_t>(phases.count,batch->generated.size()));
   const auto sequence=++generationSequence;
   if(admitGeneration(batch,sequence)){auto generated=generator->encode(commands,batch->real,batch->admitted,sequence,phases);generatedReady=generated.encoded&&generated.ready;
    if(!generated.encoded&&!generated.busy){admittedGenerator=nullptr;generationRetry=CACurrentMediaTime()+.25;nativeLog("Frame generation bypassed: "+generated.reason);}
   }else{batch->phases={};historyReady=false;}
   batch->previousGenerationAdmission.reset();
   if(pacing){std::lock_guard<std::mutex>lock(mutex);historyReady=generatedReady;pacing->reportDelivery(requested,generatedReady?phases.count:0);}

  }
  if(generator&&generationEnabled){batch->retirement=retirement;auto held=std::make_shared<std::shared_ptr<Batch>>(batch);[commands addCompletedHandler:^(id<MTLCommandBuffer>completed){
    if(retirement)retirement->completed(completed.status);
    if(auto self=weak.lock()){if(completed.status==MTLCommandBufferStatusCompleted)self->publish(*held,generatedReady);else if(completed.status==MTLCommandBufferStatusError)self->gpuFailure(*held,completed.error.localizedDescription.UTF8String?:"Source frame processing failed");}
    held->reset();}];}
  else { {std::lock_guard<std::mutex>lock(mutex);producer->pending.store(true);++status.pending;status.maxPending=std::max(status.maxPending,status.pending);}if(!encodeFinal(commands,drawable,{batch,-1,sourceTime},true,retirement)){result.encoded=false;result.busy=true;result.reason="Neural output is busy; the previous completed frame remains displayed";return result;} }
  // Rejected/busy frames retain their identity so callers can retry unchanged.
  // An accepted encoding reserves identity even if its host later abandons it.
  observe(RuntimeStatusPhase::Encoded,batch);requestRuntimeStatusPoll(true);budgetDeniedAt=0;lastSubmission=frameId;{std::lock_guard<std::mutex>lock(mutex);if(!config.sourceFrameRate&&lastSourceTime)interval=updateSourceInterval(interval,sourceTime-lastSourceTime);lastSourceTime=sourceTime;++status.encoded;if(target){++timing.accepted;if(target->hostTime<=targetSubmittedAt)++timing.lateAtSubmit;}if(retirement){retirements.erase(std::remove_if(retirements.begin(),retirements.end(),[](const auto&entry){auto value=entry.lock();return !value||value->done.load();}),retirements.end());retirements.push_back(retirement);retirement->arm();}}return result;
  }();}catch(const ImageBudgetExceeded&error){result={};const auto now=CACurrentMediaTime();if(!budgetDeniedAt)budgetDeniedAt=now;result.busy=!error.structurallyImpossible&&now-budgetDeniedAt<.25;result.reason=error.what();if(heldContract)failHeldAttempt(heldEpoch,*heldContract,result.reason);}
  catch(const std::exception&error){result={};result.reason=error.what();}}
  @catch(NSException*error){result={};result.reason=error.reason.UTF8String?:"Frame presentation failed";}
  // Ingress treats a fatal non-busy result as permission to remove its owner.
  // During a held update all failures keep that cover; the status channel
  // reports a matching failure, while an old attempt cannot poison rollback.
  if(!result.encoded&&heldContract){
   if(!result.busy)failHeldAttempt(heldEpoch,*heldContract,result.reason);
   result.busy=true;
  }
  return result;
 }
};
macfx::FramePresenter::FramePresenter(CAMetalLayer*layer,void*owner,const PresenterConfig&config):impl(std::make_shared<Impl>(layer,owner,config)){impl->start();}
macfx::FramePresenter::~FramePresenter(){stop();}
macfx::FrameResult macfx::FramePresenter::submit(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime){return submitAtTime(commands,source,frameId,sourceTime,nullptr);}
macfx::FrameResult macfx::FramePresenter::submitAtTime(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget* target){@autoreleasepool{try{return impl->submit(commands,source,frameId,sourceTime,target);}catch(const std::exception&e){FrameResult result;result.reason=e.what();return result;}}}
macfx::FrameResult macfx::FramePresenter::submitAtTimeObserved(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime,const RSPresentationTarget*target,const RSPresentationObserver*observer){@autoreleasepool{try{return impl->submit(commands,source,frameId,sourceTime,target,nullptr,observer);}catch(const std::exception&e){FrameResult result;result.reason=e.what();return result;}}}
macfx::PresenterStatus macfx::FramePresenter::snapshot()const{std::lock_guard<std::mutex>lock(impl->mutex);auto status=impl->status;if(impl->pacing)status.adaptive=impl->pacing->snapshot();return status;}
bool macfx::FramePresenter::requiresDepth()const{std::lock_guard<std::mutex>lock(impl->mutex);return !impl->stopping.load()&&impl->execution&&impl->execution->requiresDepth();}
macfx::PresentationHoldStatus macfx::FramePresenter::beginPresentationHold(const PresentationHoldCommand&command){return impl->beginHold(command);}
macfx::PresentationHoldStatus macfx::FramePresenter::resumePresentationHold(const PresentationHoldCommand&command){return impl->resumeHold(command);}
macfx::PresentationHoldStatus macfx::FramePresenter::presentationHoldStatus()const{CAMetalLayer *layer=impl->layerSnapshot();const auto size=layer.drawableSize;std::lock_guard<std::mutex>lock(impl->mutex);impl->advanceHold(size);return impl->holdReport();}
bool macfx::FramePresenter::presentationHeld()const{std::lock_guard<std::mutex>lock(impl->mutex);return impl->holdActive;}
void macfx::FramePresenter::setNativeMetalCapabilities(bool inPlace,bool owned,bool required){impl->nativeMetalCapabilities.store((inPlace?1:0)|(owned?2:0)|(required?4:0),std::memory_order_relaxed);}
void macfx::FramePresenter::retainCompletedFrameForReplay(bool enabled){std::lock_guard<std::mutex>lock(impl->mutex);impl->replayEnabled=enabled;if(!enabled)impl->completedReplay.reset();}
bool macfx::FramePresenter::completedFrameReplayReady()const{CAMetalLayer *layer=impl->layerSnapshot();const auto size=layer.drawableSize;std::lock_guard<std::mutex>lock(impl->mutex);const auto image=impl->completedReplay;
 return !impl->stopping.load()&&impl->replayEnabled&&image&&image->epoch==impl->presentationEpoch&&image->real.width==size.width&&image->real.height==size.height;}
bool macfx::FramePresenter::replayCompletedFrame(){return impl->replayCompleted();}
double macfx::FramePresenter::lastRealPresentedTime()const{std::lock_guard<std::mutex>lock(impl->mutex);return impl->lastRealDisplayed;}
uint64_t macfx::FramePresenter::lastRealCompletedFrameId()const{std::lock_guard<std::mutex>lock(impl->mutex);return impl->lastRealCompleted;}
RSPresentationTiming macfx::FramePresenter::timingSnapshot()const{std::lock_guard<std::mutex>lock(impl->mutex);return impl->timing;}
void macfx::FramePresenter::stop(){if(impl)impl->shutdown();}

macfx::FrameResult macfx::FramePresenter::submitWithDepth(id<MTLCommandBuffer>c,id<MTLTexture>s,uint64_t f,double t,const DepthFrame&d){@autoreleasepool{try{return impl->submit(c,s,f,t,nullptr,&d);}catch(const std::exception&e){FrameResult result;result.reason=e.what();return result;}}}
macfx::FrameResult macfx::FramePresenter::submitDisplayFrame(id<MTLCommandBuffer>c,id<MTLTexture>s,uint64_t f,double t,bool opaque,const DepthFrame*d){@autoreleasepool{try{return impl->submit(c,s,f,t,nullptr,d,nullptr,opaque);}catch(const std::exception&e){FrameResult result;result.reason=e.what();return result;}}}

void macfx::FramePresenter::setDisplay(uint32_t displayId){std::unique_lock<std::mutex>serial(impl->submission,std::try_to_lock);if(!serial.owns_lock())return;if(displayId&&displayId!=impl->currentDisplay&&!impl->stopping.load()){
 impl->currentDisplay=displayId;
 if(impl->link&&CVDisplayLinkSetCurrentCGDisplay(impl->link,displayId)!=kCVReturnSuccess)impl->bypassGeneration("Frame generation display selection is unavailable");
}}

bool macfx::FramePresenter::terminalGpuFailure()const{return impl->gpuFailed.load();}
bool macfx::FramePresenter::gpuFailureMatchesCurrent(unsigned w,unsigned h,MTLPixelFormat format,id<MTLDevice>device){
 if(!impl->gpuFailed.load())return false;std::shared_ptr<const FramePublication> failed;{std::lock_guard lock(impl->mutex);failed=impl->failedPublication;}
 if(!failed||failed->width!=w||failed->height!=h||format!=MTLPixelFormatInvalid&&failed->format!=format||device&&failed->device!=reinterpret_cast<uintptr_t>((__bridge void*)device))return false;
 const auto packet=livePacket();if(bool(packet)!=bool(failed->controls)||packet&&std::memcmp(packet,&*failed->controls,sizeof(*packet)))return false;
 if(!impl->failureReader)impl->failureReader=std::make_unique<EffectPlanState>();impl->failureReader->poll();const auto plan=impl->failureReader->snapshot();
 return failed->revision.empty()?(!plan||plan->mode=="simple"):(plan&&plan->revision==failed->revision);
}
