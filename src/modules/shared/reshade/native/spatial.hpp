#pragma once
#import <Metal/Metal.h>
#include <cstdint>
#include <memory>
#include <string>

namespace macfx {
enum class SpatialMethod { Bilinear, MetalFX, LS1, Mako, FSR1, Nearest, Bicubic, Area };
SpatialMethod spatialMethodForName(const std::string &);
// The canonical plan name of a method, for status reports.
const char *spatialMethodName(SpatialMethod)noexcept;
enum class SpatialColor { Perceptual, Linear, HDR };
enum class FrameOrigin { TopLeft, BottomLeft };
struct SpatialFrame {
    id<MTLTexture> source;
    id<MTLTexture> output;
    uint64_t frameId = 0;
    SpatialColor color = SpatialColor::Perceptual;
    FrameOrigin origin = FrameOrigin::TopLeft;
};
struct SpatialStatus {
    bool encoded = false;
    bool busy = false;
    SpatialMethod requested = SpatialMethod::Bilinear;
    SpatialMethod active = SpatialMethod::Bilinear;
    uint64_t frameId = 0;
    unsigned inputWidth = 0, inputHeight = 0, outputWidth = 0, outputHeight = 0;
    std::string reason;
};
struct SpatialConfig {double sharpness=.5;bool ls1Performance=false;std::string modelPath;};
// The caller owns submission and completion. Both textures remain retained by
// the command buffer through completion. This encoder never presents or waits.
class SpatialEncoder {
public:
    explicit SpatialEncoder(id<MTLDevice> device);
    ~SpatialEncoder();
    SpatialEncoder(const SpatialEncoder&) = delete;
    SpatialEncoder& operator=(const SpatialEncoder&) = delete;
    SpatialStatus encode(id<MTLCommandBuffer> commands, const SpatialFrame& frame, SpatialMethod method);
    SpatialStatus encode(id<MTLCommandBuffer> commands, const SpatialFrame& frame, SpatialMethod method,const SpatialConfig &);
    SpatialStatus prepare(const SpatialFrame&,SpatialMethod,const SpatialConfig&);
    static bool metalFXAvailable(id<MTLDevice> device);
    static bool supportsFormat(MTLPixelFormat format) noexcept {
        return format==MTLPixelFormatRGBA8Unorm||format==MTLPixelFormatBGRA8Unorm||format==MTLPixelFormatRGBA16Float;
    }
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};
}
