#include "window-forwarded.hpp"
#include "window-overlay-policy.hpp"
#include "graphics.hpp"
#include "presentation-internal.hpp"
namespace macfx {
void ForwardedStream::updateForwarded(const BrowserFrameGeometry&g,uint64_t remote,NSRect screen,CGFloat scale,CGSize drawable){
 if(retired)return;placeOutput(screen);layer.contentsScale=scale;
 layer.drawableSize=drawable.width>0?drawable:CGSizeMake(g.pixelsWidth,g.pixelsHeight);
 if(serviceGeneration==remote&&sameWindowGeometry(geometry,g))return;
 // At the same extent a new crop or generation keeps the shown image until
 // a frame that matches replaces it.
 if(revealed&&geometry.width==g.width&&geometry.height==g.height&&geometry.pixelsWidth==g.pixelsWidth&&geometry.pixelsHeight==g.pixelsHeight){
  geometry=g;if(remote!=serviceGeneration){serviceGeneration=remote;if(holdAwaits&&remote>holdGeneration){holdAwaits=false;holdUntil=0;}}
  return;
 }
 // A new extent keeps a shown image, as the in-process stream does, until
 // frames at that extent replace it. Before the first reveal the layer
 // stays hidden.
 geometry=g;width=g.pixelsWidth;height=g.pixelsHeight;serviceGeneration=remote;holdAwaits=false;holdUntil=0;
 if(!revealed){layer.hidden=YES;ready=false;acceptedGeneration=0;firstAcceptedFrameId=0;revealAfter=presenter->snapshot().completedReal;}
 ++geometryGeneration;
}
void ForwardedStream::hold(double from,double until,bool awaitGeneration){
 if(!revealed)return;
 const bool active=holdUntil.load()>CACurrentMediaTime();
 holdGeneration=serviceGeneration.load();holdFrom=active?std::min(holdFrom.load(),from):from;holdUntil=until;holdAwaits=(holdAwaits&&active)||awaitGeneration;
}
void ForwardedStream::release(){if(!holdAwaits)holdUntil=0;}
bool ForwardedStream::held(const RSWindowSourceFrame&i)const{
 return i.generation<=holdGeneration.load()&&i.time>=holdFrom.load()&&CACurrentMediaTime()<holdUntil.load();
}
void ForwardedStream::submit(std::shared_ptr<ForwardedFrame> f){
 auto self=std::static_pointer_cast<ForwardedStream>(shared_from_this());dispatch_async(renderQueue,^{self->consume(f);});
}
void ForwardedStream::consume(std::shared_ptr<ForwardedFrame> f){
 const auto i=f->info;const auto generation=geometryGeneration.load();const unsigned w=width,h=height;
 if(retired||!f->surface||i.generation!=serviceGeneration||i.width!=w||i.height!=h||IOSurfaceGetWidth(f->surface)!=w||IOSurfaceGetHeight(f->surface)!=h||(!browserFrameTimeAccepted(i.time,lastTime)||!windowCaptureIntervalAccepted(i.time,lastTime,minimumInterval))||held(i)||(settled&&!settled())){++dropped;return;}
 std::shared_ptr<WindowStreamSlot>slot;
 for(auto &candidate:slots){if(!candidate)candidate=std::make_shared<WindowStreamSlot>();if(raw&&raw->slot==candidate)continue;bool idle=false;if(candidate->busy.compare_exchange_strong(idle,true)){slot=candidate;break;}}
 auto self=std::static_pointer_cast<ForwardedStream>(shared_from_this());
 auto retry=[&]{if(forwardPending)++dropped;forwardPending=f;if(!forwardRetry){forwardRetry=true;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(std::max(.025,budgetRetryAt-CACurrentMediaTime())*NSEC_PER_SEC)),renderQueue,^{self->forwardRetry=false;auto pending=std::move(self->forwardPending);if(pending)self->consume(pending);});}};
 if(!slot){retry();return;}
 auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;desc.storageMode=MTLStorageModePrivate;
 if(!slot->texture||slot->texture.width!=w||slot->texture.height!=h){try{slot->texture=newAdmittedTexture(device,desc,reinterpret_cast<uintptr_t>(this),admissionStage);}catch(const ImageBudgetExceeded&e){slot->busy=false;if(e.structurallyImpossible)fail(e.what());else {budgetRetryAt=CACurrentMediaTime()+(budgetPressure.record()?1:.25);retry();}return;}}
 budgetRetryAt=0;budgetPressure.reset();
 desc.storageMode=MTLStorageModeShared;auto input=[device newTextureWithDescriptor:desc iosurface:f->surface plane:0];
 if(!copyQueueAttempted){copyQueueAttempted=true;copyQueue=[device newCommandQueue];}
 auto copy=[(copyQueue?:queue) commandBuffer];if(copy)ownPresentationBuffer(copy);auto blit=[copy blitCommandEncoder];
 if(!input||!slot->texture||!blit){slot->busy=false;fail("Forwarded image copy unavailable");return;}
 [blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:slot->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];
 const auto frameId=++frame;lastTime=i.time;++complete;
 // A hold or a new generation that began while the copy ran drops the
 // frame as well.
 [copy addCompletedHandler:^(id<MTLCommandBuffer>b){f->release();(void)input;dispatch_async(self->renderQueue,^{
  if(b.status!=MTLCommandBufferStatusCompleted){slot->busy=false;self->fail("Forwarded image copy failed");return;}
  if(self->held(i)||i.generation!=self->serviceGeneration){slot->busy=false;++self->dropped;return;}
  self->submitCopied(slot,frameId,i.time,generation,w,h);});}];[copy commit];
}
}
