#include "presentation.h"
#include "presentation.hpp"
#include "graphics.hpp"
#include <atomic>
#include <cstring>
#include <stdexcept>

namespace {
struct PresenterHandle {
 macfx::GraphicsConfig graphics;
 CAMetalLayer *layer;
 std::unique_ptr<macfx::FramePresenter> presenter;
};
struct ProducerLease {
 void *token;
 void (*callback)(void *);
 std::atomic<bool> released{false};bool armed=false;
 ProducerLease(void *value,void (*release)(void *)):token(value),callback(release){}
 void release(){if(armed&&!released.exchange(true))callback(token);}
 ~ProducerLease(){release();}
};
template<size_t N>void message(char(&output)[N],const char *value){std::strncpy(output,value?:"Presentation failed",N-1);output[N-1]=0;}
}
extern "C" void *rsCreateFramePresenter(void *metalLayer,void *owner,const RSPresenterOptions *options,RSPresenterError *error) {
 if(!error||error->size<sizeof(*error)||error->version!=RS_PRESENTER_ABI_VERSION)return nullptr;
 error->reason[0]=0;
 if(!options||options->size<sizeof(*options)||options->version!=RS_PRESENTER_ABI_VERSION||options->origin>RS_FRAME_BOTTOM_LEFT||(options->flags&~RS_PRESENTER_FLIP_Y)||!metalLayer||!owner){message(error->reason,"Invalid presentation options, layer or owner");return nullptr;}
 try{@try{
  auto value=std::make_unique<PresenterHandle>();value->graphics=macfx::graphicsEnvironment();value->layer=(__bridge CAMetalLayer*)metalLayer;
  macfx::PresenterConfig config;config.origin=static_cast<macfx::FrameOrigin>(options->origin);config.flipY=options->flags&RS_PRESENTER_FLIP_Y;config.sourceFrameRate=options->sourceFrameRate;
  if(value->graphics.spatialMethod=="metalfx")config.method=macfx::SpatialMethod::MetalFX;
  else if(value->graphics.spatialMethod=="ls1")config.method=macfx::SpatialMethod::LS1;
  else if(value->graphics.spatialMethod=="mako")config.method=macfx::SpatialMethod::Mako;
  else if(value->graphics.spatialMethod=="fsr1")config.method=macfx::SpatialMethod::FSR1;
  else if(value->graphics.spatialMethod!="off"&&value->graphics.spatialMethod!="bilinear")throw std::runtime_error("The selected spatial method is not available in this runtime");
  config.generation=value->graphics.generation;config.adaptive=value->graphics.adaptive;
  value->presenter=std::make_unique<macfx::FramePresenter>(value->layer,owner,config);
  return value.release();
 }@catch(NSException *e){message(error->reason,e.reason.UTF8String);}}
 catch(const std::exception&e){message(error->reason,e.what());}catch(...){message(error->reason,"Cannot create frame presentation");}
 return nullptr;
}
extern "C" int rsSubmitFramePresenter(void *opaque,const RSPresenterSubmission *submission,RSFrameResult *result) {
 if(!opaque||!submission||!result||submission->size<sizeof(*submission)||submission->version!=RS_PRESENTER_ABI_VERSION||result->size<sizeof(*result)||result->version!=RS_FRAME_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;
 const uint32_t size=result->size;*result={};result->size=size;result->version=RS_FRAME_ABI_VERSION;result->frameId=submission->frameId;
 if(bool(submission->lifetimeToken)!=bool(submission->releaseToken)){message(result->reason,"A producer token and release callback must be supplied together");return RS_FRAME_INVALID_ARGUMENT;}
 auto *value=static_cast<PresenterHandle*>(opaque);
 try{@try{
  auto commands=(__bridge id<MTLCommandBuffer>)submission->commandBuffer;
  auto source=(__bridge id<MTLTexture>)submission->sourceTexture;
  result->inputWidth=source.width;result->inputHeight=source.height;result->outputWidth=value->layer.drawableSize.width;result->outputHeight=value->layer.drawableSize.height;
  if(value->graphics.spatialMethod=="off"&&(result->inputWidth!=result->outputWidth||result->inputHeight!=result->outputHeight)){message(result->reason,"Spatial scaling is disabled; source and output dimensions must match");return RS_FRAME_ENCODE_FAILED;}
  auto lease=submission->releaseToken?std::make_shared<ProducerLease>(submission->lifetimeToken,submission->releaseToken):nullptr;
  auto encoded=value->presenter->submit(commands,source,submission->frameId,submission->sourceTime);
  result->encoded=encoded.encoded;result->effects=encoded.effects;result->scaled=encoded.scaled;result->activeMethod=encoded.scaled?static_cast<uint32_t>(encoded.scaling.active):(value->graphics.spatialMethod=="metalfx"?RS_FRAME_METALFX:value->graphics.spatialMethod=="ls1"?RS_FRAME_LS1:value->graphics.spatialMethod=="mako"?RS_FRAME_MAKO:value->graphics.spatialMethod=="fsr1"?RS_FRAME_FSR1:RS_FRAME_BILINEAR);
  message(result->reason,(encoded.reason.empty()?encoded.scaling.reason:encoded.reason).c_str());
  if(!encoded.encoded)return encoded.busy?RS_FRAME_BUSY:RS_FRAME_ENCODE_FAILED;
  if(lease){lease->armed=true;[commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->release();}];}
  return RS_FRAME_OK;
 }@catch(NSException *e){message(result->reason,e.reason.UTF8String);}}
 catch(const std::exception&e){message(result->reason,e.what());}catch(...){message(result->reason,"Cannot submit frame presentation");}
 return RS_FRAME_ENCODE_FAILED;
}
extern "C" int rsGetFramePresenterStatus(void *opaque,RSPresenterStatus *status) {
 if(!opaque||!status||status->size<sizeof(*status)||status->version!=RS_PRESENTER_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;
 auto *value=static_cast<PresenterHandle*>(opaque);const auto current=value->presenter->snapshot();const auto size=status->size;*status={};status->size=size;status->version=RS_PRESENTER_ABI_VERSION;
 status->submitted=current.submitted;status->encoded=current.encoded;status->completedReal=current.completedReal;status->presentedReal=current.presentedReal;status->presentedGenerated=current.presentedGenerated;
 status->dropped=current.dropped;status->lastPresentedFrame=current.lastPresentedFrame;status->pending=current.pending;status->maxPending=current.maxPending;status->stopped=current.stopped;status->lastLatencyMs=current.lastLatencyMs;message(status->reason,current.reason.c_str());return RS_FRAME_OK;
}
extern "C" void rsDestroyFramePresenter(void *opaque){delete static_cast<PresenterHandle*>(opaque);}
