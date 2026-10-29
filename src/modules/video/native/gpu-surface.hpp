#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <IOSurface/IOSurface.h>
#include <memory>
#include <string>

namespace maclauncher::video {
// A bounded producer slot shared by libmpv's OpenGL render API and the Metal
// graphics presenter. All methods run on the owning CGL serial queue. No image
// download, upload, IOSurface CPU lock or blocking GPU wait is performed.
class GPUSurface {
public:
    static std::unique_ptr<GPUSurface> create(id<MTLDevice>, unsigned width, unsigned height,
                                              bool floatingPoint, std::string &error);
    ~GPUSurface();
    GPUSurface(const GPUSurface &) = delete;
    GPUSurface &operator=(const GPUSurface &) = delete;
    GLuint framebuffer() const {return framebuffer_;}
    unsigned width() const {return width_;}
    unsigned height() const {return height_;}
    id<MTLTexture> texture() const {return texture_;}
    void produced();
    bool ready();
private:
    GPUSurface() = default;
    unsigned width_ = 0, height_ = 0;
    GLuint textureGL_ = 0, framebuffer_ = 0;
    GLsync fence_ = nullptr;
    id<MTLTexture> texture_;
    IOSurfaceRef surface_ = nullptr;
    CGLContextObj context_ = nullptr;
};
}
