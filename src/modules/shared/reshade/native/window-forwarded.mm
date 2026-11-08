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
 const bool crop=i.cropWidth||i.cropHeight;
 const unsigned x=crop?i.cropX:0,y=crop?i.cropY:0,cropWidth=crop?i.cropWidth:i.width,cropHeight=crop?i.cropHeight:i.height;
 if(retired||!w||!h||!f->surface||i.generation!=serviceGeneration||!i.width||!i.height||IOSurfaceGetWidth(f->surface)!=i.width||IOSurfaceGetHeight(f->surface)!=i.height||
    !cropWidth||!cropHeight||x>i.width||y>i.height||cropWidth>i.width-x||cropHeight>i.height-y||
    (!browserFrameTimeAccepted(i.time,lastTime)||!windowCaptureIntervalAccepted(i.time,lastTime,minimumInterval))||held(i)||(settled&&!settled())){++dropped;return;}
 if(importedGeneration!=i.generation){sourceTextures.clear();importedGeneration=i.generation;}
 auto input=sourceTextures.texture(device,f->surface,MTLPixelFormatBGRA8Unorm);
 if(!input){fail("Forwarded source texture unavailable");return;}
 // A leased SCK frame can be read directly. The frame itself is the raw/GPU
 // slot, so the service's sample acknowledgment waits until both the latest
 // replay image and all GPU reads release it. The service permits the next
 // frame concurrently; one retained static image cannot stall the stream.
 if(x==0&&y==0&&cropWidth==i.width&&cropHeight==i.height){
  f->texture=input;f->busy=true;budgetRetryAt=0;budgetPressure.reset();
  const auto frameId=++frame;lastTime=i.time;++complete;
  submitCopied(std::static_pointer_cast<WindowStreamSlot>(f),frameId,i.time,generation,w,h);return;
 }
 // A padded/nonzero content rectangle needs one normalization copy because
 // FramePresenter consumes a complete source texture, rather than a subrect.
 // Full-content frames above avoid the copy and reuse their imported texture.
 std::shared_ptr<WindowStreamSlot>slot;
 for(auto &candidate:slots){if(!candidate)candidate=std::make_shared<WindowStreamSlot>();if(raw&&raw->slot==candidate)continue;bool idle=false;if(candidate->busy.compare_exchange_strong(idle,true)){slot=candidate;break;}}
 auto self=std::static_pointer_cast<ForwardedStream>(shared_from_this());
 auto retry=[&]{if(forwardPending)++dropped;forwardPending=f;if(!forwardRetry){forwardRetry=true;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(std::max(.025,budgetRetryAt-CACurrentMediaTime())*NSEC_PER_SEC)),renderQueue,^{self->forwardRetry=false;auto pending=std::move(self->forwardPending);if(pending)self->consume(pending);});}};
 if(!slot){retry();return;}
 auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:cropWidth height:cropHeight mipmapped:NO];desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;desc.storageMode=MTLStorageModePrivate;
 if(!slot->texture||slot->texture.width!=cropWidth||slot->texture.height!=cropHeight){try{slot->texture=newAdmittedTexture(device,desc,reinterpret_cast<uintptr_t>(this),admissionStage);}catch(const ImageBudgetExceeded&e){slot->busy=false;if(e.structurallyImpossible)fail(e.what());else {budgetRetryAt=CACurrentMediaTime()+(budgetPressure.record()?1:.25);retry();}return;}}
 budgetRetryAt=0;budgetPressure.reset();
 if(!copyQueueAttempted){copyQueueAttempted=true;copyQueue=[device newCommandQueue];}
 auto copy=[(copyQueue?:queue) commandBuffer];if(copy)ownPresentationBuffer(copy);auto blit=[copy blitCommandEncoder];
 if(!slot->texture||!blit){slot->busy=false;fail("Forwarded content crop unavailable");return;}
 [blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(x,y,0) sourceSize:MTLSizeMake(cropWidth,cropHeight,1) toTexture:slot->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];
 const auto frameId=++frame;lastTime=i.time;++complete;
 [copy addCompletedHandler:^(id<MTLCommandBuffer>b){f->release();(void)input;dispatch_async(self->renderQueue,^{
  if(b.status!=MTLCommandBufferStatusCompleted){slot->busy=false;self->fail("Forwarded content crop failed");return;}
  if(self->held(i)||i.generation!=self->serviceGeneration){slot->busy=false;++self->dropped;return;}
  self->submitCopied(slot,frameId,i.time,generation,w,h);});}];[copy commit];
}
}
