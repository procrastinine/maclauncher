#include "opengl-interop.hpp"
#include "frame.hpp"
#include "window.hpp"
#include "view-presentation.hpp"
#include "presentation-internal.hpp"
#include "diagnostics.hpp"
#import <CoreVideo/CoreVideo.h>
#include <OpenGL/gl3.h>
#include <atomic>
#include <chrono>
#include <stdexcept>
#include <vector>

namespace macfx {
namespace {
void check(CVReturn result, const char *message) {
    if(result!=kCVReturnSuccess) throw std::runtime_error(message);
}
struct Image {
    CVPixelBufferRef pixels=nullptr;
    CVOpenGLTextureRef gl=nullptr;
    CVMetalTextureRef metal=nullptr;
    GLuint fbo=0;
    ~Image() {
        if(fbo)glDeleteFramebuffers(1,&fbo);
        if(metal)CFRelease(metal);
        if(gl)CFRelease(gl);
        if(pixels)CFRelease(pixels);
    }
};
struct Slot {
    Image source, output;
    GLsync retirement=nullptr;
    std::shared_ptr<std::atomic<bool>> metalBusy=std::make_shared<std::atomic<bool>>(false);
    ~Slot(){if(retirement)glDeleteSync(retirement);}
};
}
struct OpenGLInterop::Impl {
    CGLContextObj context;
    bool presentation=false;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    id<MTLCommandQueue> queue;
    CVOpenGLTextureCacheRef glCache=nullptr;
    CVMetalTextureCacheRef metalCache=nullptr;
    unsigned width=0,height=0,cursor=0;
    uint64_t frameId=0;
    std::shared_ptr<std::atomic<bool>> gpuFailed=std::make_shared<std::atomic<bool>>(false);
    std::vector<std::shared_ptr<Slot>> slots;
    explicit Impl(CGLContextObj c,bool p):context(c),presentation(p) {
        queue=[device newCommandQueue];
        if(!queue)throw std::runtime_error("Metal command queue is unavailable");
        check(CVOpenGLTextureCacheCreate(kCFAllocatorDefault,nullptr,context,CGLGetPixelFormat(context),nullptr,&glCache),"OpenGL texture cache is unavailable");
        try {check(CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&metalCache),"Metal texture cache is unavailable");}
        catch(...) {CFRelease(glCache);glCache=nullptr;throw;}
    }
    ~Impl() {clear();if(metalCache)CFRelease(metalCache);if(glCache)CFRelease(glCache);}
    void clear() {
        // Teardown/resize is rare. Drain GL readers before destroying their
        // framebuffer objects; Metal completion captures retain the CV images.
        if(!slots.empty())glFinish();
        slots.clear();width=height=cursor=0;
        if(glCache)CVOpenGLTextureCacheFlush(glCache,0);
        if(metalCache)CVMetalTextureCacheFlush(metalCache,0);
    }
    void image(Image &image) {
        NSDictionary *properties=@{(__bridge NSString*)kCVPixelBufferOpenGLCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        check(CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,
            (__bridge CFDictionaryRef)properties,&image.pixels),"Cannot allocate interoperable frame texture");
        check(CVOpenGLTextureCacheCreateTextureFromImage(kCFAllocatorDefault,glCache,image.pixels,nullptr,&image.gl),"Cannot bind interoperable OpenGL texture");
        NSDictionary *attributes=@{(__bridge NSString*)kCVMetalTextureUsage:@(MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget)};
        check(CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,metalCache,image.pixels,
            (__bridge CFDictionaryRef)attributes,MTLPixelFormatBGRA8Unorm,width,height,0,&image.metal),"Cannot bind interoperable Metal texture");
        glGenFramebuffers(1,&image.fbo);glBindFramebuffer(GL_FRAMEBUFFER,image.fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,CVOpenGLTextureGetTarget(image.gl),CVOpenGLTextureGetName(image.gl),0);
        if(glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("Interoperable framebuffer is incomplete");
    }
    std::shared_ptr<Slot> acquire() {
        for(unsigned n=0;n<slots.size();++n) {
            const unsigned i=(cursor+n)%slots.size();auto slot=slots[i];
            if(slot->metalBusy->load())continue;
            GLenum status=slot->retirement?glClientWaitSync(slot->retirement,0,0):GL_ALREADY_SIGNALED;
            if(status==GL_ALREADY_SIGNALED||status==GL_CONDITION_SATISFIED) {
                if(slot->retirement)glDeleteSync(slot->retirement);slot->retirement=nullptr;
                cursor=(i+1)%slots.size();return slot;
            }
        }
        if(slots.size()<3) {auto slot=std::make_shared<Slot>();image(slot->source);if(!presentation)image(slot->output);slots.push_back(slot);return slot;}
        if(presentation)return {}; // Never block the game waiting for overlay output.
        // Bound retirement waiting instead of reusing an image still in flight.
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
        auto slot=slots[cursor];
        while(std::chrono::steady_clock::now()<deadline) {
            GLenum status=glClientWaitSync(slot->retirement,GL_SYNC_FLUSH_COMMANDS_BIT,1000000);
            if((status==GL_ALREADY_SIGNALED||status==GL_CONDITION_SATISFIED)&&!slot->metalBusy->load()) {
                glDeleteSync(slot->retirement);slot->retirement=nullptr;cursor=(cursor+1)%slots.size();return slot;
            }
            if(status==GL_WAIT_FAILED)break;
        }
        throw std::runtime_error("Interoperable frame retirement timed out");
    }
    void render(unsigned w,unsigned h) {
        auto presenter=presentation?openGLPresentation(context):nullptr;
        if(presentation&&!presenter)return;
        if(gpuFailed->load())throw std::runtime_error("Interoperable Metal command buffer failed");
        if(width!=w||height!=h) {clear();width=w;height=h;}
        auto slot=acquire();if(!slot)return;
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
        FrameResult result;
        {DiagnosticScope stage(DiagnosticStage::MetalEncode,reinterpret_cast<uintptr_t>(context),w,h);
            if(presentation)result=presenter->submit(commands,CVMetalTextureGetTexture(slot->source.metal),++frameId,CACurrentMediaTime());
            else result=processFrame(context,commands,{CVMetalTextureGetTexture(slot->source.metal),CVMetalTextureGetTexture(slot->output.metal),++frameId,SpatialColor::Perceptual,FrameOrigin::BottomLeft});}
        if(!result.encoded){if(presentation){if(!result.busy)presenter->stop();return;}throw std::runtime_error(result.reason);}
        auto busy=slot->metalBusy,failed=gpuFailed;busy->store(true);
        // CV wrappers, not just MTLTexture objects, retain the interop backing
        // until Metal completion. GL framebuffer deletion stays on its context.
        auto sourcePixels=slot->source.pixels,outputPixels=slot->output.pixels;
        auto sourceMetal=slot->source.metal,outputMetal=slot->output.metal;
        CFRetain(sourcePixels);if(outputPixels)CFRetain(outputPixels);CFRetain(sourceMetal);if(outputMetal)CFRetain(outputMetal);
        [commands addCompletedHandler:^(id<MTLCommandBuffer> finished){
            if(finished.status!=MTLCommandBufferStatusCompleted)failed->store(true);
            CFRelease(sourceMetal);if(outputMetal)CFRelease(outputMetal);CFRelease(sourcePixels);if(outputPixels)CFRelease(outputPixels);busy->store(false);
        }];
        {DiagnosticScope stage(DiagnosticStage::MetalCommit,reinterpret_cast<uintptr_t>(context),w,h);[commands commit];}
        if(presentation)return; // The original GL present remains underneath the owned Metal view.
        // The GL consumer must be submitted after the Metal producer has been
        // scheduled. Completion remains asynchronous across shared CV backing.
        {DiagnosticScope stage(DiagnosticStage::MetalEffectWait,reinterpret_cast<uintptr_t>(context),w,h);[commands waitUntilScheduled];}
        glBindFramebuffer(GL_READ_FRAMEBUFFER,slot->output.fbo);glReadBuffer(GL_COLOR_ATTACHMENT0);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);
        {DiagnosticScope stage(DiagnosticStage::OpenGLCopyBack,reinterpret_cast<uintptr_t>(context),w,h);
            glBlitFramebuffer(0,h,w,0,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
        slot->retirement=glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE,0);
        if(!slot->retirement)throw std::runtime_error("Cannot fence interoperable output retirement");
        glFlush();
    }
};
OpenGLInterop::OpenGLInterop(CGLContextObj context,bool presentation):impl(std::make_unique<Impl>(context,presentation)){}
OpenGLInterop::~OpenGLInterop()=default;
void OpenGLInterop::render(unsigned width,unsigned height){impl->render(width,height);}
void OpenGLInterop::clear(){impl->clear();}
}
