// Copyright (c) MacLauncher contributors. MIT license.
#include "gpu-surface.hpp"
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import <OpenGL/CGLIOSurface.h>

namespace maclauncher::video {
namespace {
struct GLBindings {
    GLint draw=0,read=0,rectangle=0;
    GLBindings(){glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING,&draw);glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING,&read);glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE,&rectangle);}
    ~GLBindings(){glBindFramebuffer(GL_DRAW_FRAMEBUFFER,draw);glBindFramebuffer(GL_READ_FRAMEBUFFER,read);glBindTexture(GL_TEXTURE_RECTANGLE,rectangle);}
};
}
std::unique_ptr<GPUSurface> GPUSurface::create(id<MTLDevice> device, unsigned width, unsigned height,
                                              bool floatingPoint, std::string &error) {
    if (!device || !CGLGetCurrentContext() || !width || !height || width > 16384 || height > 16384) {
        error = "The decoded GPU surface dimensions or context are invalid.";return nullptr;
    }
    auto result = std::unique_ptr<GPUSurface>(new GPUSurface);
    GLBindings bindings;
    result->context_ = CGLRetainContext(CGLGetCurrentContext());
    result->width_ = width;result->height_ = height;
    const size_t bytes = floatingPoint ? 8 : 4;
    const size_t row = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, width * bytes);
    NSDictionary *properties = @{(id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
      (id)kIOSurfaceBytesPerElement: @(bytes), (id)kIOSurfaceBytesPerRow: @(row),
      (id)kIOSurfaceAllocSize: @(row * height),
      (id)kIOSurfacePixelFormat: @(floatingPoint ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_32BGRA)};
    result->surface_ = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
    if (!result->surface_) {error = "Cannot allocate the decoded GPU surface.";return nullptr;}
    glGenTextures(1, &result->textureGL_);
    glBindTexture(GL_TEXTURE_RECTANGLE, result->textureGL_);
    const CGLError status = CGLTexImageIOSurface2D(CGLGetCurrentContext(), GL_TEXTURE_RECTANGLE,
      floatingPoint ? GL_RGBA16F : GL_RGBA8, width, height,
      floatingPoint ? GL_RGBA : GL_BGRA, floatingPoint ? GL_HALF_FLOAT : GL_UNSIGNED_INT_8_8_8_8_REV,
      result->surface_, 0);
    if (status != kCGLNoError) {error = "OpenGL cannot bind the decoded GPU surface: " + std::string(CGLErrorString(status));return nullptr;}
    glGenFramebuffers(1, &result->framebuffer_);
    glBindFramebuffer(GL_FRAMEBUFFER, result->framebuffer_);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, result->textureGL_, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        error = "The decoded GPU framebuffer is incomplete.";return nullptr;
    }
    MTLTextureDescriptor *descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:
      floatingPoint ? MTLPixelFormatRGBA16Float : MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode = MTLStorageModeShared;
    descriptor.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    result->texture_ = [device newTextureWithDescriptor:descriptor iosurface:result->surface_ plane:0];
    if (!result->texture_) {error = "Metal cannot bind the decoded GPU surface.";return nullptr;}
    result->texture_.label = @"Decoded video GPU surface";
    return result;
}
void GPUSurface::produced() {
    if (fence_) glDeleteSync(fence_);
    fence_ = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    glFlush();
}
bool GPUSurface::ready() {
    if (!fence_) return true;
    // Cross-API ownership is transferred only after OpenGL finishes this slot.
    // The zero-timeout check never stalls the producer or the UI thread.
    const GLenum status = glClientWaitSync(fence_, 0, 0);
    if (status != GL_ALREADY_SIGNALED && status != GL_CONDITION_SATISFIED) return false;
    glDeleteSync(fence_);fence_ = nullptr;return true;
}
GPUSurface::~GPUSurface() {
    const CGLContextObj previous = CGLGetCurrentContext();
    if (context_) CGLSetCurrentContext(context_);
    if (fence_) glDeleteSync(fence_);
    if (framebuffer_) glDeleteFramebuffers(1, &framebuffer_);
    if (textureGL_) glDeleteTextures(1, &textureGL_);
    texture_ = nil;
    if (surface_) CFRelease(surface_);
    if (context_) {CGLSetCurrentContext(previous);CGLReleaseContext(context_);}
}
}
