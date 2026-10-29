#include "presentation.h"
#include "frame-depth.h"
#include "target-time.h"
#include "presentation-observed.h"
#include "presentation.hpp"
#include "graphics.hpp"
#include "image-color.hpp"
#include "presentation-source.h"
#include "presentation-content.h"
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <cmath>

namespace {
struct PresenterHandle {
 macfx::GraphicsConfig graphics;
 CAMetalLayer *layer;
 std::unique_ptr<macfx::FramePresenter> presenter;
};
struct PreparationObserverLease {
 RSFramePreparationObserver observer;
 explicit PreparationObserverLease(const RSFramePreparationObserver&value):observer(value){if(observer.retain)observer.retain(observer.context);}
 ~PreparationObserverLease(){if(observer.release){const auto value=observer;dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{value.release(value.context);});}}
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
static void *createPresenter(void *metalLayer,void *owner,const RSPresenterOptions *options,RSPresenterError *error,const RSImageColorDescription*color=nullptr,float displayHeadroom=1) {
 if(!error||error->size<sizeof(*error)||error->version!=RS_PRESENTER_ABI_VERSION)return nullptr;
 error->reason[0]=0;
 if(!options||options->size<sizeof(*options)||options->version!=RS_PRESENTER_ABI_VERSION||options->origin>RS_FRAME_BOTTOM_LEFT||(options->flags&~RS_PRESENTER_FLIP_Y)||!metalLayer||!owner){message(error->reason,"Invalid presentation options, layer or owner");return nullptr;}
 try{@try{
  auto value=std::make_unique<PresenterHandle>();value->graphics=macfx::presentationGraphicsEnvironment();value->layer=(__bridge CAMetalLayer*)metalLayer;
  macfx::PresenterConfig config;config.frameSource=macfx::RuntimeFrameSource::ExplicitTexture;config.origin=static_cast<macfx::FrameOrigin>(options->origin);config.flipY=options->flags&RS_PRESENTER_FLIP_Y;config.sourceFrameRate=options->sourceFrameRate;
  config.method=macfx::spatialMethodForName(value->graphics.spatialMethod);
  config.generation=value->graphics.generation;config.generationMethod=value->graphics.generationMethod;config.adaptive=value->graphics.adaptive;
  if(color){config.sourceColor=macfx::readImageColor(*color);config.sourceColorSpace=macfx::imageColorLabel(*config.sourceColor);config.sourceOpaque=config.sourceColor->alpha==macfx::ColorAlpha::Opaque;if(!std::isfinite(displayHeadroom)||displayHeadroom<1||displayHeadroom>100)throw std::runtime_error("Invalid display headroom");config.displayHeadroom=displayHeadroom;}
  value->presenter=std::make_unique<macfx::FramePresenter>(value->layer,owner,config);
  return value.release();
 }@catch(NSException *e){message(error->reason,e.reason.UTF8String);}}
 catch(const std::exception&e){message(error->reason,e.what());}catch(...){message(error->reason,"Cannot create frame presentation");}
 return nullptr;
}
extern "C" void *rsCreateFramePresenter(void*l,void*owner,const RSPresenterOptions*options,RSPresenterError*error){return createPresenter(l,owner,options,error);}
extern "C" void *rsCreateColorFramePresenter(void*l,void*owner,const RSPresenterOptions*options,const RSImageColorDescription*color,float headroom,RSPresenterError*error){if(!color)return nullptr;return createPresenter(l,owner,options,error,color,headroom);}
extern "C" void rsSetColorFramePresenterHeadroom(void*opaque,float headroom){if(opaque)static_cast<PresenterHandle*>(opaque)->presenter->setDisplayHeadroom(headroom);}
extern "C" int rsSetFramePresenterSource(void*opaque,uint32_t source){if(!opaque||source>RS_FRAME_SOURCE_DECODED_VIDEO)return RS_FRAME_INVALID_ARGUMENT;static_cast<PresenterHandle*>(opaque)->presenter->setFrameSource(static_cast<macfx::RuntimeFrameSource>(source));return RS_FRAME_OK;}
extern "C" int rsObserveFramePresenterPreparation(void*opaque,const RSFramePreparationObserver*observer){
 if(!opaque||observer&&(observer->size<sizeof(*observer)||observer->version!=1||!observer->wake||bool(observer->retain)!=bool(observer->release)||observer->context&&!observer->retain))return RS_FRAME_INVALID_ARGUMENT;
 try{@try{auto*value=static_cast<PresenterHandle*>(opaque);
  if(!observer){value->presenter->setPreparationObserver({});return RS_FRAME_OK;}
  auto lease=std::make_shared<PreparationObserverLease>(*observer);
  value->presenter->setPreparationObserver([lease](const macfx::EffectPreparationNotice&notice){RSFramePreparationNotice value{};value.size=sizeof(value);value.version=1;value.sequence=notice.sequence;message(value.revision,notice.revision.c_str());message(value.contract,notice.contract.c_str());lease->observer.wake(lease->observer.context,&value);});
  return RS_FRAME_OK;
 }@catch(NSException*error){(void)error;return RS_FRAME_ENCODE_FAILED;}}catch(...){return RS_FRAME_ENCODE_FAILED;}
}
static int submit(void *opaque,const RSPresenterSubmission *submission,const RSPresentationTarget* target,RSFrameResult *result,const RSFrameDepth *depth=nullptr,const RSPresentationObserver*observer=nullptr,const RSPresentationContent*content=nullptr) {
 if(!opaque||!submission||!result||submission->size<sizeof(*submission)||submission->version!=RS_PRESENTER_ABI_VERSION||result->size<sizeof(*result)||result->version!=RS_FRAME_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;
 const uint32_t size=result->size;*result={};result->size=size;result->version=RS_FRAME_ABI_VERSION;result->frameId=submission->frameId;
 if(bool(submission->lifetimeToken)!=bool(submission->releaseToken)){message(result->reason,"A producer token and release callback must be supplied together");return RS_FRAME_INVALID_ARGUMENT;}
 auto *value=static_cast<PresenterHandle*>(opaque);
 try{@try{
  auto commands=(__bridge id<MTLCommandBuffer>)submission->commandBuffer;
  auto source=(__bridge id<MTLTexture>)submission->sourceTexture;
  result->inputWidth=source.width;result->inputHeight=source.height;result->outputWidth=value->layer.drawableSize.width;result->outputHeight=value->layer.drawableSize.height;
  // Optional upscaling does not own the game's buffer size. Normal presentation
  // still fits a producer's native/dynamic resolution to its output window.
  auto lease=submission->releaseToken?std::make_shared<ProducerLease>(submission->lifetimeToken,submission->releaseToken):nullptr;
  const macfx::DepthFrame captured{depth?(__bridge id<MTLTexture>)depth->texture:nil,depth?depth->frameId:0,depth?static_cast<macfx::FrameOrigin>(depth->origin):macfx::FrameOrigin::TopLeft};
  auto encoded=content?value->presenter->submitContent(commands,source,submission->frameId,submission->sourceTime,*content,observer,target):depth?value->presenter->submitWithDepth(commands,source,submission->frameId,submission->sourceTime,captured):observer?value->presenter->submitAtTimeObserved(commands,source,submission->frameId,submission->sourceTime,target,observer):target?value->presenter->submitAtTime(commands,source,submission->frameId,submission->sourceTime,target):value->presenter->submit(commands,source,submission->frameId,submission->sourceTime);
  result->encoded=encoded.encoded;result->effects=encoded.effects;result->scaled=encoded.scaled;result->activeMethod=static_cast<uint32_t>(encoded.scaled?encoded.scaling.active:macfx::spatialMethodForName(value->graphics.spatialMethod));
  message(result->reason,(encoded.reason.empty()?encoded.scaling.reason:encoded.reason).c_str());
  if(!encoded.encoded)return encoded.busy?RS_FRAME_BUSY:RS_FRAME_ENCODE_FAILED;
  if(lease){lease->armed=true;[commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->release();}];}
  return RS_FRAME_OK;
 }@catch(NSException *e){message(result->reason,e.reason.UTF8String);}}
 catch(const std::exception&e){message(result->reason,e.what());}catch(...){message(result->reason,"Cannot submit frame presentation");}
 return RS_FRAME_ENCODE_FAILED;
}
extern "C" int rsSubmitFramePresenter(void* opaque,const RSPresenterSubmission* submission,RSFrameResult* result){return submit(opaque,submission,nullptr,result);}
extern "C" int rsSubmitFramePresenterObserved(void*opaque,const RSPresenterSubmission*submission,const RSPresentationObserver*observer,RSFrameResult*result){if(!observer||observer->size<sizeof(*observer)||observer->version!=RS_TARGET_ABI_VERSION||!observer->retired)return RS_FRAME_INVALID_ARGUMENT;return submit(opaque,submission,nullptr,result,nullptr,observer);}
extern "C" int rsSubmitFramePresenterContent(void*opaque,const RSPresenterSubmission*submission,const RSPresentationContent*content,const RSPresentationObserver*observer,RSFrameResult*result){if(!content||content->size<sizeof(*content)||content->version!=1||content->flags&~(RS_PRESENT_CONTENT_REDRAW|RS_PRESENT_CONTENT_PTS_UNKNOWN|RS_PRESENT_CONTENT_DISPLAY_MAPPED)||content->reserved||!content->contentId||!content->epoch||!std::isfinite(content->pts)||!std::isfinite(content->duration)||content->duration<0||(observer&&(observer->size<sizeof(*observer)||observer->version!=1||!observer->retired)))return RS_FRAME_INVALID_ARGUMENT;return submit(opaque,submission,nullptr,result,nullptr,observer,content);}
extern "C" int rsSubmitFramePresenterContentAtTime(void*opaque,const RSPresenterSubmission*submission,const RSPresentationContent*content,const RSPresentationTarget*target,const RSPresentationObserver*observer,RSFrameResult*result){if(!target||target->size<sizeof(*target)||target->version!=1||!content||content->size<sizeof(*content)||content->version!=1||content->flags&~(RS_PRESENT_CONTENT_REDRAW|RS_PRESENT_CONTENT_PTS_UNKNOWN|RS_PRESENT_CONTENT_DISPLAY_MAPPED)||content->reserved||!content->contentId||!content->epoch||!std::isfinite(content->pts)||!std::isfinite(content->duration)||content->duration<0||(observer&&(observer->size<sizeof(*observer)||observer->version!=1||!observer->retired)))return RS_FRAME_INVALID_ARGUMENT;return submit(opaque,submission,target,result,nullptr,observer,content);}
extern "C" int rsSubmitFramePresenterAtTime(void* opaque,const RSPresenterSubmission* submission,const RSPresentationTarget* target,RSFrameResult* result){if(!target||target->size<sizeof(*target)||target->version!=RS_TARGET_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;return submit(opaque,submission,target,result);}
extern "C" int rsSubmitFramePresenterAtTimeObserved(void*opaque,const RSPresenterSubmission*submission,const RSPresentationTarget*target,const RSPresentationObserver*observer,RSFrameResult*result){if(!target||target->size<sizeof(*target)||target->version!=RS_TARGET_ABI_VERSION||!observer||observer->size<sizeof(*observer)||observer->version!=RS_TARGET_ABI_VERSION||!observer->retired)return RS_FRAME_INVALID_ARGUMENT;return submit(opaque,submission,target,result,nullptr,observer);}
extern "C" int rsGetFramePresenterTiming(void* opaque,RSPresentationTiming* result){if(!opaque||!result||result->size<sizeof(*result)||result->version!=RS_TARGET_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;const auto size=result->size;*result=static_cast<PresenterHandle*>(opaque)->presenter->timingSnapshot();result->size=size;result->version=RS_TARGET_ABI_VERSION;return RS_FRAME_OK;}
extern "C" int rsGetFramePresenterStatus(void *opaque,RSPresenterStatus *status) {
 if(!opaque||!status||status->size<sizeof(*status)||status->version!=RS_PRESENTER_ABI_VERSION)return RS_FRAME_INVALID_ARGUMENT;
 auto *value=static_cast<PresenterHandle*>(opaque);const auto current=value->presenter->snapshot();const auto size=status->size;*status={};status->size=size;status->version=RS_PRESENTER_ABI_VERSION;
 status->submitted=current.submitted;status->encoded=current.encoded;status->completedReal=current.completedReal;status->presentedReal=current.presentedReal;status->presentedGenerated=current.presentedGenerated;
 status->dropped=current.dropped;status->lastPresentedFrame=current.lastPresentedFrame;status->pending=current.pending;status->maxPending=current.maxPending;status->stopped=current.stopped;status->lastLatencyMs=current.lastLatencyMs;message(status->reason,current.reason.c_str());return RS_FRAME_OK;
}
extern "C" void rsDestroyFramePresenter(void *opaque){delete static_cast<PresenterHandle*>(opaque);}

extern "C" int rsSubmitFramePresenterWithDepth(void *owner,const RSPresenterSubmission *submission,const RSFrameDepth *depth,RSFrameResult *result){if(!depth||depth->size<sizeof(*depth)||depth->version!=RS_DEPTH_ABI_VERSION||depth->reserved||depth->origin>RS_FRAME_BOTTOM_LEFT||!depth->texture)return RS_FRAME_INVALID_ARGUMENT;return submit(owner,submission,nullptr,result,depth);}
