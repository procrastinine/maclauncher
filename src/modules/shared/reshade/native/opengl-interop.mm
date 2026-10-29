#include "opengl-interop.hpp"
#include "frame.hpp"
#include "frame-depth.hpp"
#include "opengl-depth.hpp"
#include "window.hpp"
#include "view-presentation.hpp"
#include "image-admission.hpp"
#include "presentation-internal.hpp"
#include "diagnostics.hpp"
#include "effects-plan.hpp"
#include "log.hpp"
#include "runtime-status.hpp"
#include "in-place-history.hpp"
#import <CoreVideo/CoreVideo.h>
#include <OpenGL/gl3.h>
#include <OpenGL/CGLIOSurface.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <vector>

namespace macfx {
namespace {
void check(CVReturn result, const char *message) {
    if(result!=kCVReturnSuccess) throw std::runtime_error(message);
}
struct Image {
    std::shared_ptr<ImageReservation>reservation;
    CVPixelBufferRef pixels=nullptr;
    CVOpenGLTextureRef gl=nullptr;
    CVMetalTextureRef metal=nullptr;
    GLuint fbo=0,depthTexture=0;
    void clear() {
        if(fbo)glDeleteFramebuffers(1,&fbo);
        if(depthTexture)glDeleteTextures(1,&depthTexture);
        if(metal)CFRelease(metal);
        if(gl)CFRelease(gl);
        if(pixels)CFRelease(pixels);
        fbo=depthTexture=0;metal=nullptr;gl=nullptr;pixels=nullptr;
        reservation.reset();
    }
    ~Image() {clear();}
};
struct Slot {
    Image source, output, depth;
    GLsync retirement=nullptr;
    std::shared_ptr<std::atomic<bool>> metalBusy=std::make_shared<std::atomic<bool>>(false);
    ~Slot(){if(retirement)glDeleteSync(retirement);}
};
}
struct OpenGLInterop::Impl {
    CGLContextObj context;
    bool presentation=false;
    bool core=false;
    bool contextAvailable=true;
    OpenGLDepthCapture depthCapture;
    std::chrono::steady_clock::time_point depthRetry{};
    std::string depthFailure;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    id<MTLCommandQueue> queue;
    CVOpenGLTextureCacheRef glCache=nullptr;
    CVMetalTextureCacheRef metalCache=nullptr;
    unsigned width=0,height=0,cursor=0;
    uint64_t frameId=0;
    std::shared_ptr<std::atomic<bool>> gpuFailed=std::make_shared<std::atomic<bool>>(false);
    struct FailedInput {std::mutex mutex;uint64_t plan=0,controls=0;unsigned width=0,height=0;};
    std::shared_ptr<FailedInput> failedInput=std::make_shared<FailedInput>();
    std::vector<std::shared_ptr<Slot>> slots;
    struct Completed {std::mutex mutex;uint64_t epoch=1,frame=0;size_t index=SIZE_MAX;};
    std::shared_ptr<Completed>completed=std::make_shared<Completed>();
    InPlaceHistory history;InPlaceHistory::Session coherent;InPlaceRequest request;
    std::string lastRequest;
    explicit Impl(CGLContextObj c,bool p):context(c),presentation(p) {
        const char *version=reinterpret_cast<const char*>(glGetString(GL_VERSION));core=version&&version[0]>='3';
        queue=[device newCommandQueue];
        if(!queue)throw std::runtime_error("Metal command queue is unavailable");
        check(CVOpenGLTextureCacheCreate(kCFAllocatorDefault,nullptr,context,CGLGetPixelFormat(context),nullptr,&glCache),"OpenGL texture cache is unavailable");
        try {check(CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&metalCache),"Metal texture cache is unavailable");}
        catch(...) {CFRelease(glCache);glCache=nullptr;throw;}
    }
    ~Impl() {clear();if(metalCache)CFRelease(metalCache);if(glCache)CFRelease(glCache);}
    void resetHistory(){
        {std::lock_guard lock(completed->mutex);++completed->epoch;completed->index=SIZE_MAX;completed->frame=0;}
        history.reset();coherent.reset();lastRequest.clear();
    }
    void clear() {
        resetHistory();
        // Teardown/resize is rare. Drain GL readers before destroying their
        // framebuffer objects; Metal completion captures retain the CV images.
        if(contextAvailable&&!slots.empty())glFinish();
        if(contextAvailable)depthCapture.clear();
        depthRetry={};depthFailure.clear();
        slots.clear();width=height=cursor=0;
        if(contextAvailable&&glCache)CVOpenGLTextureCacheFlush(glCache,0);
        if(metalCache)CVMetalTextureCacheFlush(metalCache,0);
    }
    void abandon() noexcept {
        contextAvailable=false;
        depthCapture.abandon();
        // Submitted Metal commands retain their CV image leases. Discard only
        // context-owned names, which cannot be safely deleted on another one.
        for(const auto &slot:slots) {
            slot->retirement=nullptr;
            for(auto *image:{&slot->source,&slot->output,&slot->depth})image->fbo=image->depthTexture=0;
        }
    }
    void image(Image &image,bool depth=false) {
        if(depth&&(!width||!height||width>16384||height>16384||size_t(width)*height>(64u<<20)/8))
            throw std::runtime_error("OpenGL depth dimensions exceed the capture limit");
        image.reservation=reserveImageBytes(device,alignedImageBytes(width,height,4),reinterpret_cast<uintptr_t>(context),depth?"gl-depth-memory":"gl-color-memory",true);
        NSDictionary *properties=@{(__bridge NSString*)kCVPixelBufferOpenGLCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferBytesPerRowAlignmentKey:@256,
            (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        check(CVPixelBufferCreate(kCFAllocatorDefault,width,height,depth?kCVPixelFormatType_OneComponent32Float:kCVPixelFormatType_32BGRA,
            (__bridge CFDictionaryRef)properties,&image.pixels),"Cannot allocate interoperable frame texture");
        image.reservation->commit(CVPixelBufferGetDataSize(image.pixels));
        if(depth&&CVPixelBufferGetDataSize(image.pixels)>(64u<<20))throw std::runtime_error("OpenGL depth storage exceeds 64 MiB");
        if(depth) {
            // CV's GL cache accepts OneComponent32Float but exposes a copied
            // texture on macOS; writes do not reach its Metal IOSurface view.
            // Bind that exact backing explicitly for GPU-only R32F publication.
            glGenTextures(1,&image.depthTexture);glBindTexture(GL_TEXTURE_RECTANGLE,image.depthTexture);
            if(CGLTexImageIOSurface2D(context,GL_TEXTURE_RECTANGLE,GL_R32F,width,height,GL_RED,GL_FLOAT,CVPixelBufferGetIOSurface(image.pixels),0)!=kCGLNoError)
                throw std::runtime_error("Cannot bind the OpenGL depth IOSurface");
        } else check(CVOpenGLTextureCacheCreateTextureFromImage(kCFAllocatorDefault,glCache,image.pixels,nullptr,&image.gl),"Cannot bind interoperable OpenGL texture");
        NSDictionary *attributes=@{(__bridge NSString*)kCVMetalTextureUsage:@(MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget)};
        check(CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,metalCache,image.pixels,
            (__bridge CFDictionaryRef)attributes,depth?MTLPixelFormatR32Float:MTLPixelFormatBGRA8Unorm,width,height,0,&image.metal),"Cannot bind interoperable Metal texture");
        attachImageReservation(CVMetalTextureGetTexture(image.metal),image.reservation);
        glGenFramebuffers(1,&image.fbo);glBindFramebuffer(GL_FRAMEBUFFER,image.fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,depth?GL_TEXTURE_RECTANGLE:CVOpenGLTextureGetTarget(image.gl),depth?image.depthTexture:CVOpenGLTextureGetName(image.gl),0);
        if(glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("Interoperable framebuffer is incomplete");
    }
    std::shared_ptr<Slot> acquire() {
        std::unique_lock completionLock(completed->mutex);const auto held=presentation?SIZE_MAX:completed->index;
        for(unsigned n=0;n<slots.size();++n) {
            const unsigned i=(cursor+n)%slots.size();auto slot=slots[i];
            if(i==held||slot->metalBusy->load())continue;
            GLenum status=slot->retirement?glClientWaitSync(slot->retirement,0,0):GL_ALREADY_SIGNALED;
            if(status==GL_ALREADY_SIGNALED||status==GL_CONDITION_SATISFIED) {
                if(slot->retirement)glDeleteSync(slot->retirement);slot->retirement=nullptr;
                if(!presentation&&!slot->output.pixels)image(slot->output);
                cursor=(i+1)%slots.size();slot->metalBusy->store(true);return slot;
            }
        }
        completionLock.unlock();
        if(slots.size()<3) {auto slot=std::make_shared<Slot>();image(slot->source);if(!presentation)image(slot->output);slot->metalBusy->store(true);slots.push_back(slot);return slot;}
        // Retain all busy slots. Neither an owned output nor an in-place
        // compatibility effect may stall the game waiting for a free image.
        return {};
    }
    void replay(bool busy=true){
        if(!coherent)return;
        if(busy&&!InPlaceHistory::transient(coherent))return;
        size_t index;{std::lock_guard lock(completed->mutex);index=completed->index;}
        if(index>=slots.size())return;const auto &slot=slots[index];
        glDisable(GL_SCISSOR_TEST);glDisable(GL_FRAMEBUFFER_SRGB);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,slot->output.fbo);glReadBuffer(GL_COLOR_ATTACHMENT0);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);
        glBlitFramebuffer(0,height,width,0,0,0,width,height,GL_COLOR_BUFFER_BIT,GL_NEAREST);
        if(slot->retirement)glDeleteSync(slot->retirement);
        slot->retirement=glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE,0);glFlush();
        if(!slot->retirement)throw std::runtime_error("Cannot fence processed frame replay");
    }
    void render(unsigned w,unsigned h) {
        auto presenter=presentation?openGLPresentation(context):nullptr;
        if(presentation&&!presenter)return;
        if(gpuFailed->load())throw std::runtime_error("Interoperable Metal command buffer failed");
        if(width!=w||height!=h) {clear();width=w;height=h;}
        if(!presentation){
            const auto selected=request.read();
            if(selected!=lastRequest){lastRequest=selected;std::lock_guard lock(completed->mutex);++completed->epoch;completed->frame=0;}
            if(coherent)coherent=history.prepare(CVMetalTextureGetTexture(slots.front()->output.metal),selected);
            if(coherent&&InPlaceHistory::original(coherent))return;
        }
        const bool needsDepth=frameRequiresDepth(context,device,w,h);
        auto slot=acquire();if(!slot){replay();return;}
        struct AcquireLease {std::shared_ptr<std::atomic<bool>>busy;bool handed=false;~AcquireLease(){if(!handed)busy->store(false);}} acquired{slot->metalBusy};
        if(!presentation&&!coherent)coherent=history.prepare(CVMetalTextureGetTexture(slot->output.metal),lastRequest);
        bool hasDepth=false;
        const bool optionalDepth=needsDepth&&effectPlanMode()==1;
        if(needsDepth&&(!optionalDepth||std::chrono::steady_clock::now()>=depthRetry)) {
            // Lazy allocation: ordinary color effects have no depth textures,
            // depth copies, shader draws or depth completion resources.
            try {
                depthCapture.prepare(w,h,core);
                if(!slot->depth.pixels)image(slot->depth,true);
                depthCapture.capture(slot->depth.fbo);
                hasDepth=true;depthRetry={};depthFailure.clear();
            }catch(const std::exception &error) {
                if(!optionalDepth)throw;
                // An Advanced row without scene depth is bypassed by the
                // ordered processor. Keep color resources and independent rows
                // usable; neither partial storage nor an older depth image is
                // a valid input for this frame.
                slot->depth.clear();depthCapture.clear();
                depthRetry=std::chrono::steady_clock::now()+std::chrono::seconds(1);
                if(depthFailure!=error.what()) {
                    depthFailure=error.what();
                    nativeLog("OpenGL depth capture unavailable; independent graphics stages remain active: "+depthFailure);
                }
            }
        }
        glDisable(GL_SCISSOR_TEST);glDisable(GL_FRAMEBUFFER_SRGB);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glReadBuffer(GL_BACK);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,slot->source.fbo);glDrawBuffer(GL_COLOR_ATTACHMENT0);
        {DiagnosticScope stage(DiagnosticStage::OpenGLSourceCopy,reinterpret_cast<uintptr_t>(context),w,h);
            glBlitFramebuffer(0,0,w,h,0,h,w,0,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
        // Apple's CoreVideo interop contract submits the GL producer before
        // Metal reads the shared pixel buffer; it does not CPU-wait for finish.
        {DiagnosticScope stage(DiagnosticStage::OpenGLSourceWait,reinterpret_cast<uintptr_t>(context),w,h);glFlush();}
        auto commands=[queue commandBuffer];
        if(!commands)throw std::runtime_error("Metal command buffer is unavailable");
        ownPresentationBuffer(commands);
        const uint64_t currentFrame=++frameId;
        // The color blit and depth capture shader already normalize OpenGL
        // into top-to-bottom IOSurface rows before Metal sees either image.
        const DepthFrame depth{hasDepth?CVMetalTextureGetTexture(slot->depth.metal):nil,currentFrame,FrameOrigin::TopLeft};
        GLint surfaceOpacity=1;
        const bool opaque=CGLGetParameter(context,kCGLCPSurfaceOpacity,&surfaceOpacity)!=kCGLNoError||surfaceOpacity!=0;
        auto busy=slot->metalBusy,failed=gpuFailed;auto failedContract=failedInput;
        const auto planGeneration=effectPlanDemandGeneration(),controlsGeneration=liveState().generation;
        const auto outputIndex=std::find(slots.begin(),slots.end(),slot)-slots.begin();const auto state=completed;
        uint64_t epoch;{std::lock_guard lock(state->mutex);epoch=state->epoch;}
        auto encoded=std::make_shared<std::atomic<bool>>(false);
        // CV wrappers, not just MTLTexture objects, retain the interop backing
        // until Metal completion. GL framebuffer deletion stays on its context.
        auto sourcePixels=slot->source.pixels,outputPixels=slot->output.pixels;
        auto sourceMetal=slot->source.metal,outputMetal=slot->output.metal;
        auto depthPixels=hasDepth?slot->depth.pixels:nullptr;
        auto depthMetal=hasDepth?slot->depth.metal:nullptr;
        CFRetain(sourcePixels);if(outputPixels)CFRetain(outputPixels);CFRetain(sourceMetal);if(outputMetal)CFRetain(outputMetal);
        if(depthPixels)CFRetain(depthPixels);if(depthMetal)CFRetain(depthMetal);
        [commands addCompletedHandler:^(id<MTLCommandBuffer> finished){
            if(finished.status==MTLCommandBufferStatusError){
                {std::lock_guard lock(failedContract->mutex);failedContract->plan=planGeneration;failedContract->controls=controlsGeneration;failedContract->width=w;failedContract->height=h;}
                failed->store(true,std::memory_order_release);
            }
            CFRelease(sourceMetal);if(outputMetal)CFRelease(outputMetal);CFRelease(sourcePixels);if(outputPixels)CFRelease(outputPixels);
            if(depthMetal)CFRelease(depthMetal);if(depthPixels)CFRelease(depthPixels);
            std::lock_guard lock(state->mutex);
            if(finished.status==MTLCommandBufferStatusCompleted&&encoded->load()&&state->epoch==epoch&&currentFrame>state->frame){
                state->index=outputIndex;state->frame=currentFrame;}
            busy->store(false);
        }];
        acquired.handed=true;
        // A later row may reject a frame after an earlier row admitted async
        // inference. Always submit its producer signals and retain the exact
        // CV backing until completion, including busy/error returns.
        struct Retire {id<MTLCommandBuffer> commands;~Retire(){if(commands.status<MTLCommandBufferStatusCommitted)[commands commit];}} retire{commands};
        FrameResult result;
        {DiagnosticScope stage(DiagnosticStage::MetalEncode,reinterpret_cast<uintptr_t>(context),w,h);
            if(presentation)result=presenter->submitDisplayFrame(commands,CVMetalTextureGetTexture(slot->source.metal),currentFrame,CACurrentMediaTime(),opaque,hasDepth?&depth:nullptr);
            else result=processFrameWithDepth(context,commands,{CVMetalTextureGetTexture(slot->source.metal),CVMetalTextureGetTexture(slot->output.metal),currentFrame,SpatialColor::Perceptual,FrameOrigin::TopLeft},SpatialMethod::Bilinear,hasDepth?&depth:nullptr,opaque);}
        if(!result.encoded){if(presentation){if(!result.busy&&!presenter->terminalGpuFailure())presenter->stop();return;}if(result.busy){replay();return;}throw std::runtime_error(result.reason);}
        if(!presentation)encoded->store(true);
        if(!presentation)observeRuntimeFrameSource(reinterpret_cast<uintptr_t>(context),RuntimeFrameSource::OpenGLFramebuffer,hasDepth?RuntimeInputDepth:0);
        {DiagnosticScope stage(DiagnosticStage::MetalCommit,reinterpret_cast<uintptr_t>(context),w,h);[commands commit];}
        if(presentation)return; // The original GL present remains underneath the owned Metal view.
        // Only a positively completed Metal image is exposed to GL. Reuse the
        // last such image while this producer is pending; the next game flush
        // can consume a newer completion without any CPU scheduling wait.
        replay(false);
    }
};
OpenGLInterop::OpenGLInterop(CGLContextObj context,bool presentation):impl(std::make_unique<Impl>(context,presentation)){}
OpenGLInterop::~OpenGLInterop()=default;
void OpenGLInterop::render(unsigned width,unsigned height){
    try{impl->render(width,height);}catch(const ImageBudgetExceeded&){if(impl->presentation)throw;impl->replay();}
}
void OpenGLInterop::render(unsigned width,unsigned height,bool presentation){
    impl->presentation=presentation;
    render(width,height);
}
bool OpenGLInterop::terminalGpuFailure()const{return impl->gpuFailed->load(std::memory_order_acquire);}
bool OpenGLInterop::failureMatchesCurrent(unsigned width,unsigned height)const{
    if(!terminalGpuFailure())return false;
    const auto plan=effectPlanDemandGeneration(),controls=liveState().generation;
    std::lock_guard lock(impl->failedInput->mutex);
    return impl->failedInput->plan==plan&&impl->failedInput->controls==controls&&impl->failedInput->width==width&&impl->failedInput->height==height;
}
void OpenGLInterop::resetHistory(){impl->resetHistory();}
void OpenGLInterop::clear(){impl->clear();}
void OpenGLInterop::abandon() noexcept {impl->abandon();}
}
