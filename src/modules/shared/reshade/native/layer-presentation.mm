#include "layer-presentation.hpp"
#import <QuartzCore/CATransaction.h>
#include "presentation-internal.hpp"
#include "completion.hpp"
#include "image-admission.hpp"
#include "command-resources.hpp"
#include "live-controls.hpp"
#include "effects-plan.hpp"
#include "runtime-status.hpp"
#include "command-deadline.hpp"
#include <atomic>
#include <algorithm>
#include <mutex>
#include <stdexcept>

@interface MacFXRemotePresentationLayer : CAMetalLayer
@end
@implementation MacFXRemotePresentationLayer
- (CALayer *)hitTest:(CGPoint)point { return nil; }
@end

namespace {
struct Snapshot {
    id<MTLTexture>texture;
    unsigned width,height;
    MTLPixelFormat format;
};
struct Transaction {Transaction(){[CATransaction begin];[CATransaction setDisableActions:YES];}~Transaction(){[CATransaction commit];}};
}
struct macfx::LayerPresentation::Impl:std::enable_shared_from_this<Impl> {
    __weak CALayer *source;
    MacFXRemotePresentationLayer *output;
    id<MTLCommandQueue>copies,processing;
    std::unique_ptr<FramePresenter>presenter;
    mutable std::mutex mutex;
    std::vector<std::shared_ptr<Snapshot>>pool;
    bool bypassed=false;double budgetDeniedAt=0;std::string bypassReason,bypassedRevision;std::optional<LivePacket>bypassedControls;unsigned bypassedWidth=0,bypassedHeight=0;EffectPlanState failurePlans;
    void bypassLocked(const std::string&reason){
        if(bypassed)return;bypassed=true;bypassReason=reason;bypassedWidth=width;bypassedHeight=height;
        if(const auto packet=livePacket())bypassedControls=*packet;failurePlans.poll();if(const auto plan=failurePlans.snapshot())bypassedRevision=plan->revision;
        presenter->stop();pool.clear();copies=nil;processing=nil;Transaction transaction;output.hidden=YES;[output removeFromSuperlayer];
        RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(this);event.processing=true;event.phase=RuntimeStatusPhase::Bypassed;event.reason=reason;observeRuntimeStatus(event);
    }
    bool sameFailure(){
        if(width!=bypassedWidth||height!=bypassedHeight)return false;const auto packet=livePacket();if(bool(packet)!=bool(bypassedControls)||packet&&std::memcmp(packet,&*bypassedControls,sizeof(*packet)))return false;
        failurePlans.poll();const auto plan=failurePlans.snapshot();return (plan?plan->revision:std::string{})==bypassedRevision;
    }
    std::atomic<bool>stopped{false},revealQueued{false},revealed{false};
    unsigned width=0,height=0;
    uint64_t nextFrame=0,generation=0;
    const bool sourceOpaque;
    Impl(CALayer *layer,unsigned w,unsigned h,const PresenterConfig &config,bool opaqueSource):source(layer),sourceOpaque(opaqueSource) {
        if(!layer||!w||!h)throw std::runtime_error("Remote presentation requires a source layer and dimensions");
        auto device=MTLCreateSystemDefaultDevice();copies=[device newCommandQueue];processing=[device newCommandQueue];
        if(!copies||!processing)throw std::runtime_error("Cannot create remote presentation queues");
        output=[MacFXRemotePresentationLayer layer];output.device=device;output.pixelFormat=MTLPixelFormatBGRA8Unorm;
        if(!opaqueSource&&config.generation)throw std::runtime_error("Frame generation requires an opaque source image");
        output.framebufferOnly=NO;output.opaque=opaqueSource;output.displaySyncEnabled=YES;output.hidden=YES;
        presenter=std::make_unique<FramePresenter>(output,this,config);
        {Transaction transaction;[layer insertSublayer:output atIndex:0];}
        layout(w,h);
    }
    void layout(unsigned w,unsigned h) {
        CALayer *layer=source;if(!layer)return;
        const bool changed=w!=width||h!=height||!CGRectEqualToRect(output.frame,layer.bounds);
        if(!changed)return;
        ++generation;width=w;height=h;
        Transaction transaction;if(!revealed.load())output.hidden=YES;output.frame=layer.bounds;
        output.contentsScale=layer.bounds.size.width>0?w/layer.bounds.size.width:1;
        output.drawableSize=CGSizeMake(w,h);
    }
    std::shared_ptr<Snapshot>acquire(unsigned w,unsigned h,MTLPixelFormat format) {
        for(auto&image:pool)if(image.use_count()==1&&image->width==w&&image->height==h&&image->format==format)return image;
        pool.erase(std::remove_if(pool.begin(),pool.end(),[](const auto&image){return image.use_count()==1;}),pool.end());
        if(pool.size()>=4)return {};
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];
        descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead;
        auto image=std::make_shared<Snapshot>();image->texture=newAdmittedTexture(output.device,descriptor,reinterpret_cast<uintptr_t>(this),"remote-snapshot-memory");image->width=w;image->height=h;image->format=format;
        if(!image->texture)throw std::runtime_error("Cannot allocate remote source snapshot");pool.push_back(image);return image;
    }
    FrameResult submit(IOSurfaceRef surface) {@autoreleasepool{
        std::lock_guard<std::mutex>lock(mutex);FrameResult result;
        if(bypassed){result.busy=sameFailure();result.reason=bypassReason;return result;}
        if(stopped.load()||!source||output.superlayer!=source){result.reason="Remote presentation is detached";return result;}
        const auto format=IOSurfaceGetPixelFormat(surface)=='BGRA'?MTLPixelFormatBGRA8Unorm:IOSurfaceGetPixelFormat(surface)=='RGBA'?MTLPixelFormatRGBA8Unorm:MTLPixelFormatInvalid;
        if(format==MTLPixelFormatInvalid){result.reason="Remote presentation requires an SDR surface (format="+std::to_string(IOSurfaceGetPixelFormat(surface))+")";return result;}
        const auto inputW=IOSurfaceGetWidth(surface),inputH=IOSurfaceGetHeight(surface);
        if(!inputW||!inputH||inputW>width||inputH>height||width>inputW*2||height>inputH*2){result.reason="Remote output dimensions must be between the source size and twice its size";return result;}
        auto image=acquire(inputW,inputH,format);
        if(!image){result.busy=true;result.reason="Remote source queue is full";return result;}
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:image->width height:image->height mipmapped:NO];
        descriptor.usage=MTLTextureUsageShaderRead;auto input=[output.device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
        if(!input){result.reason="Cannot read remote source surface";return result;}
        waitWindowSurfaceProducer((__bridge void*)source);
        // The publisher may recycle this IOSurface as soon as setContents returns.
        // Wait only for an owned source copy, never for neural work or presentation.
        auto copy=[copies commandBuffer];ownPresentationBuffer(copy);auto encoder=[copy blitCommandEncoder];
        [encoder copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(image->width,image->height,1) toTexture:image->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[encoder endEncoding];
        auto sourceLease=std::shared_ptr<const void>(CFRetain(surface),[](const void*value){CFRelease(value);});
        [copy addCompletedHandler:^(id<MTLCommandBuffer>){(void)sourceLease;(void)image;}];
        CommandDeadline completed(copy,CommandDeadline::Milestone::Completed);
        [copy commit];
        if(!completed.wait()){result.busy=true;result.reason="Remote source copying did not complete within its compatibility wait; original rendering is retained";bypassLocked(result.reason);return result;}
        auto commands=[processing commandBuffer];ownPresentationBuffer(commands);
        auto lease=std::make_shared<std::shared_ptr<Snapshot>>(image);[commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->reset();}];
        result=presenter->submitDisplayFrame(commands,image->texture,nextFrame+1,CACurrentMediaTime(),sourceOpaque);
        // A later row may fail after an earlier asynchronous provider encoded
        // its producer signal. Submit owned work so those resources can retire.
        if(!result.encoded){[commands commit];if(presenter->terminalGpuFailure()){bypassLocked(result.reason);result.busy=true;}return result;}
        ++nextFrame;const auto frameGeneration=generation;std::weak_ptr<Impl>weak=shared_from_this();
        [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status!=MTLCommandBufferStatusCompleted)return;if(auto self=weak.lock())if(!self->revealed.load()&&!self->revealQueued.exchange(true)){
            dispatch_async(dispatch_get_main_queue(),^{if(auto value=weak.lock()){std::lock_guard<std::mutex>guard(value->mutex);if(!value->stopped.load()&&value->generation==frameGeneration&&value->source&&value->output.superlayer==value->source){Transaction transaction;value->output.hidden=NO;value->revealed.store(true);}value->revealQueued.store(false);}});
        }}];[commands commit];return result;
    }}
    void stop(){std::lock_guard<std::mutex>lock(mutex);if(stopped.exchange(true))return;presenter->stop();pool.clear();Transaction transaction;output.hidden=YES;[output removeFromSuperlayer];}
};
macfx::LayerPresentation::LayerPresentation(CALayer *layer,unsigned width,unsigned height,const PresenterConfig &config):LayerPresentation(layer,width,height,config,true){}
macfx::LayerPresentation::LayerPresentation(CALayer *layer,unsigned width,unsigned height,const PresenterConfig &config,bool opaqueSource):impl(std::make_shared<Impl>(layer,width,height,config,opaqueSource)){}
macfx::LayerPresentation::~LayerPresentation(){stop();}
void macfx::LayerPresentation::update(unsigned width,unsigned height){std::lock_guard<std::mutex>lock(impl->mutex);if(!impl->stopped.load())impl->layout(width,height);}
macfx::FrameResult macfx::LayerPresentation::submit(IOSurfaceRef surface){try{return impl->submit(surface);}catch(const borrowed::Busy&e){FrameResult result;result.busy=true;result.reason=e.what();return result;}catch(const ImageBudgetExceeded&e){FrameResult result;result.busy=true;result.reason=e.what();std::lock_guard lock(impl->mutex);const auto now=CACurrentMediaTime();if(!impl->budgetDeniedAt)impl->budgetDeniedAt=now;if(e.structurallyImpossible||now-impl->budgetDeniedAt>=.25)impl->bypassLocked(result.reason);return result;}catch(const std::exception&e){FrameResult result;result.busy=true;result.reason=e.what();std::lock_guard lock(impl->mutex);impl->bypassLocked(result.reason);return result;}}
macfx::PresenterStatus macfx::LayerPresentation::snapshot()const{return impl->presenter->snapshot();}
void macfx::LayerPresentation::stop(){if(impl)impl->stop();}
