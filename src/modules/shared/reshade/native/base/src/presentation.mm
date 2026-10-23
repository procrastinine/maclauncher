#include "presentation.hpp"
#include "completion.hpp"
#include "delivery-plan.hpp"
#include "presentation-internal.hpp"
#include "diagnostics.hpp"
#import <CoreVideo/CoreVideo.h>
#include <atomic>
#include <array>
#include <algorithm>
#include <cmath>
#include <deque>
#include <mutex>
namespace {
struct Batch {id<MTLTexture>real;std::vector<id<MTLTexture>>generated,admitted;macfx::InterpolationPlan phases;uint64_t id=0;double sourceTime=0;};
struct Display {std::shared_ptr<Batch>batch;int generated=-1;double due=0;};
id<MTLTexture> makeTexture(id<MTLDevice>d,unsigned w,unsigned h,MTLPixelFormat format){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto texture=[d newTextureWithDescriptor:descriptor];if(!texture)throw std::runtime_error("Cannot allocate presentation texture");return texture;}
}
struct macfx::FramePresenter::Impl:std::enable_shared_from_this<Impl>{
 CAMetalLayer*layer;void*owner;PresenterConfig config;id<MTLCommandQueue>queue;id<MTLRenderPipelineState>flipPipeline;dispatch_queue_t worker;CVDisplayLinkRef link=nullptr;
 mutable std::mutex mutex;std::mutex submission;PresenterStatus status;std::vector<std::shared_ptr<Batch>>pool;std::optional<Display>immediate;std::deque<Display>plan;std::shared_ptr<Batch>previous;
 std::unique_ptr<LsfgEncoder>generator;std::unique_ptr<AdaptivePacing>pacing;DeliveryPlan delivery;std::shared_ptr<Batch>latest;bool historyReady=false;uint64_t accountedDeliveryDrops=0;std::atomic<bool>pumpQueued{false},stopping{false};double lastSourceTime=0,interval=1.0/60;uint64_t lastSubmission=0,lastQueuedFrame=0;int lastQueuedGenerated=-2;unsigned width=0,height=0,inFlight=0;std::array<double,8>recentPresentations{};unsigned presentationCursor=0;
 Impl(CAMetalLayer*l,void*o,const PresenterConfig&c):layer(l),owner(o),config(c){if(!layer||!owner||!layer.device)throw std::runtime_error("Missing presentation layer, owner or device");if(layer.pixelFormat!=MTLPixelFormatBGRA8Unorm&&layer.pixelFormat!=MTLPixelFormatRGBA8Unorm)throw std::runtime_error("Presentation requires an SDR layer");queue=[layer.device newCommandQueue];if(!queue)throw std::runtime_error("Cannot create presentation queue");worker=dispatch_queue_create("macfx.presentation",DISPATCH_QUEUE_SERIAL);ownPresentation(layer);layer.framebufferOnly=NO;layer.allowsNextDrawableTimeout=YES;
  if(!std::isfinite(config.sourceFrameRate)||config.sourceFrameRate<0)throw std::runtime_error("Invalid source frame rate");if(config.sourceFrameRate>0){if(!std::isfinite(config.sourceFrameRate)||config.sourceFrameRate<1||config.sourceFrameRate>240)throw std::runtime_error("Invalid source frame rate");interval=1/config.sourceFrameRate;}
  if(config.generation)generator=std::make_unique<LsfgEncoder>(layer.device,*config.generation);
  if(config.adaptive){if(!config.generation||config.adaptive->maximumMultiplier!=config.generation->multiplier)throw std::runtime_error("Adaptive pacing requires a matching maximum graph capacity");if(config.sourceFrameRate>0)throw std::runtime_error("Adaptive pacing uses observed source timestamps");pacing=std::make_unique<AdaptivePacing>(*config.adaptive);}
 }
 void start(){if(!generator)return;if(CVDisplayLinkCreateWithActiveCGDisplays(&link)!=kCVReturnSuccess||!link)throw std::runtime_error("Display timing is unavailable");CVDisplayLinkSetOutputCallback(link,[](CVDisplayLinkRef,const CVTimeStamp*,const CVTimeStamp*,CVOptionFlags,CVOptionFlags*,void*opaque)->CVReturn{auto*self=static_cast<Impl*>(opaque);self->schedule();return kCVReturnSuccess;},this);if(CVDisplayLinkStart(link)!=kCVReturnSuccess)throw std::runtime_error("Cannot start display timing");}
 ~Impl(){shutdown();}
 void shutdown(){std::lock_guard<std::mutex>serial(submission);if(stopping.exchange(true))return;if(link){CVDisplayLinkStop(link);CVDisplayLinkRelease(link);link=nullptr;}std::lock_guard<std::mutex>lock(mutex);plan.clear();immediate.reset();previous.reset();latest.reset();delivery.clear();pool.clear();status.pending=0;status.stopped=true;releaseFrameOwner(owner);}
 void schedule(){if(stopping.load()||pumpQueued.exchange(true))return;auto self=shared_from_this();dispatch_async(worker,^{@autoreleasepool{self->pump();}});}
 void failWithoutLock(const std::string&reason){status.reason=reason;}
 void fail(const std::string&reason){std::lock_guard<std::mutex>lock(mutex);status.reason=reason;}
 void deliveryMetrics(){const auto value=delivery.snapshot();const auto drops=value.droppedGenerated+value.droppedReal;status.dropped+=drops-accountedDeliveryDrops;accountedDeliveryDrops=drops;status.pending=value.pending;status.maxPending=std::max(status.maxPending,status.pending);}
 void publish(const std::shared_ptr<Batch>&batch,bool ready){if(stopping.load())return;{
   std::lock_guard<std::mutex>lock(mutex);if(stopping.load())return;const double now=CACurrentMediaTime();
   if(pacing){const auto phases=ready?batch->phases:InterpolationPlan{};if(delivery.replace(batch->id,phases,now,interval))latest=batch;deliveryMetrics();}
   else if(generator&&ready&&previous){if(immediate){++status.dropped;immediate.reset();}status.dropped+=plan.size();plan.clear();plan.push_back({previous,-1,now});for(unsigned i=0;i<batch->generated.size();++i)plan.push_back({batch,int(i),now+interval*double(i+1)/config.generation->multiplier});plan.push_back({batch,-1,now+interval});}
   else {if(immediate)++status.dropped;immediate=Display{batch,-1,now};plan.clear();}
   if(!pacing){previous=batch;status.pending=(immediate?1:0)+plan.size();status.maxPending=std::max(status.maxPending,status.pending);}
  }schedule();}
 // The caller owns submission. Effects-only output is encoded into the producer
 // buffer itself; generated output uses the paced presentation queue.
 void encodeFlipped(id<MTLCommandBuffer>commands,id<MTLTexture>image,id<MTLTexture>output){
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
 void encodeFinal(id<MTLCommandBuffer>commands,id<CAMetalDrawable>drawable,const Display&display,bool producer){
  const auto image=display.generated<0?display.batch->real:display.batch->generated.at(display.generated);
  if(config.flipY)encodeFlipped(commands,image,drawable.texture);else {
  auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Cannot create final presentation encoder");
  [copy copyFromTexture:image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(image.width,image.height,1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
  auto held=std::make_shared<std::optional<Display>>(display);std::weak_ptr<Impl>weak=shared_from_this();
  const auto generated=display.generated;const auto frameWidth=unsigned(display.batch->real.width),frameHeight=unsigned(display.batch->real.height);const auto frameId=display.batch->id;const auto frameTime=display.batch->sourceTime;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){held->reset();if(auto self=weak.lock()){
    if(generated<0&&completed.status==MTLCommandBufferStatusCompleted){std::lock_guard<std::mutex>lock(self->mutex);++self->status.completedReal;}
    if(producer&&completed.status==MTLCommandBufferStatusCompleted)[drawable present];
    // Metal also invokes completion handlers with NotEnqueued when a host
    // discards its buffer. That is cancellation, not a GPU processing error.
    if(completed.status==MTLCommandBufferStatusError)self->fail(completed.error.localizedDescription.UTF8String?:"Presentation failed");
  }}];
  [drawable addPresentedHandler:^(id<MTLDrawable>presented){if(auto self=weak.lock()){
    const double time=presented.presentedTime;
    std::lock_guard<std::mutex>lock(self->mutex);
    // A callback can report zero when the drawable never reached the display.
    // Coalesced drawables can share a display timestamp; count that instant once.
    if(!std::isfinite(time)||time<=0||std::find(self->recentPresentations.begin(),self->recentPresentations.end(),time)!=self->recentPresentations.end()){++self->status.dropped;return;}
    self->recentPresentations[self->presentationCursor++%self->recentPresentations.size()]=time;
    DiagnosticScope scope(generated<0?DiagnosticStage::PresentedReal:DiagnosticStage::PresentedGenerated,reinterpret_cast<uintptr_t>(self->owner),frameWidth,frameHeight);
    if(generated<0)++self->status.presentedReal;else ++self->status.presentedGenerated;
    if(self->pacing)self->pacing->reportPresented(generated>=0,frameTime,time);
    self->status.lastPresentedFrame=frameId;self->status.lastLatencyMs=std::max(0.,(time-frameTime)*1000);
  }}];
  if(!producer)[commands presentDrawable:drawable];
 }
 void pump(){@try{try{
   std::optional<Display>display;{std::lock_guard<std::mutex>lock(mutex);if(stopping.load()){pumpQueued.store(false);return;}if(pacing){const auto due=delivery.take(CACurrentMediaTime()+.001);if(due&&latest&&due->sourceId==latest->id)display=Display{latest,due->generated,due->due};deliveryMetrics();}else if(immediate){display=immediate;immediate.reset();}else{const double now=CACurrentMediaTime()+.001;while(!plan.empty()&&plan.front().due<=now){if(display)++status.dropped;display=plan.front();plan.pop_front();}}if(!pacing)status.pending=(immediate?1:0)+plan.size();}
   if(display&&display->batch->id==lastQueuedFrame&&display->generated==lastQueuedGenerated)display.reset();
   if(display){auto drawable=[layer nextDrawable];if(!drawable){std::lock_guard<std::mutex>lock(mutex);++status.dropped;}else{const auto image=display->generated<0?display->batch->real:display->batch->generated.at(display->generated);if(drawable.texture.width!=image.width||drawable.texture.height!=image.height||drawable.texture.pixelFormat!=image.pixelFormat){fail("Presentation size changed before the frame completed");}else{
     auto commands=[queue commandBuffer];ownPresentationBuffer(commands);encodeFinal(commands,drawable,*display,false);[commands commit];lastQueuedFrame=display->batch->id;lastQueuedGenerated=display->generated;
   }}}
  }catch(const std::exception&e){fail(e.what());}}@catch(NSException*e){fail(e.reason.UTF8String?:"Presentation failed");}
  pumpQueued.store(false);bool more=false;{std::lock_guard<std::mutex>lock(mutex);more=immediate.has_value();}if(more)schedule();
 }
 std::shared_ptr<Batch>acquire(unsigned w,unsigned h){std::lock_guard<std::mutex>lock(mutex);const unsigned capacity=generator?4:std::min(4u,unsigned(layer.maximumDrawableCount));if(inFlight>=capacity)return {};if(width!=w||height!=h){pool.clear();plan.clear();immediate.reset();previous.reset();latest.reset();delivery.reset();accountedDeliveryDrops=0;if(pacing)pacing->reset();historyReady=false;width=w;height=h;}for(auto&batch:pool)if(batch.use_count()==1)return batch;if(pool.size()>=4)return {};auto batch=std::make_shared<Batch>();batch->admitted.reserve(4);batch->real=makeTexture(layer.device,w,h,layer.pixelFormat);if(config.generation)for(unsigned i=1;i<config.generation->multiplier;++i)batch->generated.push_back(makeTexture(layer.device,w,h,layer.pixelFormat));pool.push_back(batch);return batch;}
 FrameResult submit(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime){std::lock_guard<std::mutex>serial(submission);FrameResult result;if(stopping.load()){result.reason="Presentation is stopped";return result;}if(!std::isfinite(sourceTime)||sourceTime<=0||frameId<=lastSubmission||sourceTime<=lastSourceTime){result.reason="Presentation timestamps and frame IDs must increase";return result;}
  if(!commands||!source||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences){result.reason="Presentation requires an unsubmitted retaining command buffer and source";return result;}
  {std::lock_guard<std::mutex>lock(mutex);++status.submitted;}
  const auto size=layer.drawableSize;if(!std::isfinite(size.width)||!std::isfinite(size.height)||size.width<1||size.height<1||size.width>16384||size.height>16384){result.reason="Invalid presentation dimensions";return result;}
  auto batch=acquire(size.width,size.height);if(!batch){std::lock_guard<std::mutex>lock(mutex);++status.dropped;result.busy=true;result.reason="Presentation queue is full";return result;}batch->id=frameId;batch->sourceTime=sourceTime;
  id<CAMetalDrawable>drawable=nil;
  if(!generator){
   if(!commands||commands.status>=MTLCommandBufferStatusCommitted){result.reason="Presentation requires an unsubmitted command buffer";return result;}
   drawable=[layer nextDrawable];if(!drawable){{std::lock_guard<std::mutex>lock(mutex);++status.dropped;}result.busy=true;result.reason="Presentation layer has no available drawable";return result;}
   if(drawable.texture.width!=batch->real.width||drawable.texture.height!=batch->real.height||drawable.texture.pixelFormat!=batch->real.pixelFormat){result.reason="Presentation size changed before encoding";fail(result.reason);return result;}
  }
  struct ProducerState {std::atomic<bool>pending{false},dropped{false};};
  std::weak_ptr<Impl>weak=shared_from_this();auto producer=std::make_shared<ProducerState>();
  auto lease=std::make_shared<CompletionLease>([weak,producer,batch](bool success){if(auto self=weak.lock()){std::lock_guard<std::mutex>lock(self->mutex);if(self->inFlight)--self->inFlight;if(producer->pending.load()&&self->status.pending)--self->status.pending;if(!success){if(!producer->dropped.exchange(true))++self->status.dropped;if(self->pacing){self->pacing->reset();self->historyReady=false;}}}});
  {std::lock_guard<std::mutex>lock(mutex);++inFlight;}
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){lease->finish(completed.status==MTLCommandBufferStatusCompleted);}];
  result=processFrame(owner,commands,{source,batch->real,frameId,SpatialColor::Perceptual,config.origin},config.method);if(!result.encoded){if(result.busy){std::lock_guard<std::mutex>lock(mutex);if(!producer->dropped.exchange(true))++status.dropped;}else fail(result.reason);return result;}
  bool generatedReady=false;if(generator){
   InterpolationPlan phases;unsigned requested=0;
   if(pacing){std::lock_guard<std::mutex>lock(mutex);const auto decision=pacing->observe(frameId,sourceTime,historyReady,5);if(!decision.valid){result.encoded=false;result.reason="Adaptive source identity or submission time is invalid";failWithoutLock(result.reason);return result;}phases=decision.admitted;requested=decision.requested.count;}
   else {phases.count=config.generation->multiplier-1;for(unsigned i=0;i<phases.count;++i)phases.timestamps[i]=float(i+1)/config.generation->multiplier;}
   batch->phases=phases;batch->admitted.assign(batch->generated.begin(),batch->generated.begin()+phases.count);
   auto generated=generator->encode(commands,batch->real,batch->admitted,frameId,phases);generatedReady=generated.encoded&&generated.ready;
   if(pacing){std::lock_guard<std::mutex>lock(mutex);historyReady=generatedReady;pacing->reportDelivery(requested,generatedReady?phases.count:0);}
   if(!generated.encoded&&!generated.busy)fail(generated.reason);
  }
  if(generator){auto held=std::make_shared<std::shared_ptr<Batch>>(batch);[commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(auto self=weak.lock()){if(completed.status==MTLCommandBufferStatusCompleted)self->publish(*held,generatedReady);else if(completed.status==MTLCommandBufferStatusError)self->fail(completed.error.localizedDescription.UTF8String?:"Source frame processing failed");}held->reset();}];}
  else { {std::lock_guard<std::mutex>lock(mutex);producer->pending.store(true);++status.pending;status.maxPending=std::max(status.maxPending,status.pending);}encodeFinal(commands,drawable,{batch,-1,sourceTime},true); }
  // Rejected/busy frames retain their identity so callers can retry unchanged.
  // An accepted encoding reserves identity even if its host later abandons it.
  lastSubmission=frameId;{std::lock_guard<std::mutex>lock(mutex);if(!config.sourceFrameRate&&lastSourceTime){const auto sample=sourceTime-lastSourceTime;if(sample>=1.0/240&&sample<=1)interval=interval*.8+sample*.2;}lastSourceTime=sourceTime;++status.encoded;}return result;
 }
};
macfx::FramePresenter::FramePresenter(CAMetalLayer*layer,void*owner,const PresenterConfig&config):impl(std::make_shared<Impl>(layer,owner,config)){impl->start();}
macfx::FramePresenter::~FramePresenter(){stop();}
macfx::FrameResult macfx::FramePresenter::submit(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frameId,double sourceTime){@autoreleasepool{try{return impl->submit(commands,source,frameId,sourceTime);}catch(const std::exception&e){FrameResult result;result.reason=e.what();return result;}}}
macfx::PresenterStatus macfx::FramePresenter::snapshot()const{std::lock_guard<std::mutex>lock(impl->mutex);auto status=impl->status;if(impl->pacing)status.adaptive=impl->pacing->snapshot();return status;}
void macfx::FramePresenter::stop(){if(impl)impl->shutdown();}
