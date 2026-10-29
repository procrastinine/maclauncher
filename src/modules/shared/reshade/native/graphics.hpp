#pragma once
#import <Metal/Metal.h>
#include <functional>
#include <optional>
#include <string>
#include "lsfg.hpp"
namespace macfx {
struct GraphicsConfig {
    std::string spatialMethod="off";
    double sharpness=.5;
    bool ls1Performance=false;
    std::optional<LsfgConfig> generation;
    std::optional<AdaptivePacingConfig> adaptive;
    std::string modelPath;
    std::string generationMethod="lsfg";
    bool requested() const {return spatialMethod!="off"||generation.has_value();}
};
// Pure validation is also used by hosts with explicit configuration. The process
// environment wrapper is shared by automatic Metal and OpenGL ingress.
GraphicsConfig graphicsConfig(const std::function<std::string(const char*)>&);
GraphicsConfig graphicsEnvironment();
// Ordered execution owns its validated resources. Legacy-only constructors
// must not demand an inherited model for a not-yet-activated live graph.
const GraphicsConfig &presentationGraphicsEnvironment();
// Borrowed until the next controls refresh on this rendering thread.
const GraphicsConfig &graphicsEnvironmentView();
// Cheap hook-installation gate; owner creation performs full validation.
bool graphicsRequested() noexcept;
// Automatic ingress may retain the publisher presentation when only scaling
// is selected and the source already has the physical output dimensions.
// Explicit presenters still own their output and do not use this gate.
bool automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight) noexcept;
// Only a renderer that can read and rewrite its original drawable can use
// size-preserving FX without a separate presentation owner. Window backing
// changes may temporarily lag the original drawable; its renderer owns that fit.
// Explicit source reduction/virtual output remain separate owner requirements.
// Other ingress stays conservative, including imported hooks whose geometry
// is provider-owned.
struct AutomaticPresentationCapabilities {bool sameSizeNativeFxInPlace=false;};
bool automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight,AutomaticPresentationCapabilities) noexcept;
struct EffectPlanSnapshot;
// A held transaction uses its already-validated immutable plan rather than an
// independently polled process-wide plan that may still describe an old edit.
bool automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight,AutomaticPresentationCapabilities,const EffectPlanSnapshot &) noexcept;
inline MTLPixelFormat nativeFxColorFormat(MTLPixelFormat format) noexcept {
    return format==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:
           format==MTLPixelFormatRGBA8Unorm_sRGB?MTLPixelFormatRGBA8Unorm:format;
}
inline bool nativeFxColorFormatSupported(MTLPixelFormat format) noexcept {
    return format==MTLPixelFormatBGRA8Unorm||format==MTLPixelFormatRGBA8Unorm||format==MTLPixelFormatRGBA16Float||
           format==MTLPixelFormatRGB10A2Unorm||format==MTLPixelFormatBGR10A2Unorm;
}
inline bool nativeFramebufferColorFormatSupported(MTLPixelFormat format) noexcept {
    const auto color=nativeFxColorFormat(format);
    return color==MTLPixelFormatBGRA8Unorm||color==MTLPixelFormatRGBA8Unorm||color==MTLPixelFormatRGBA16Float||color==MTLPixelFormatRGB10A2Unorm||color==MTLPixelFormatBGR10A2Unorm||color==MTLPixelFormatBGRA10_XR||color==MTLPixelFormatBGRA10_XR_sRGB||color==MTLPixelFormatBGR10_XR||color==MTLPixelFormatBGR10_XR_sRGB;
}
// The programmable-blending adapter reads supported framebuffer-only RGB
// attachments without changing the publisher's framebufferOnly property.
inline bool nativeMetalSourceReadable(MTLPixelFormat format,bool framebufferOnly,bool framebufferFetchAvailable) noexcept {
    return !framebufferOnly||(framebufferFetchAvailable&&nativeFramebufferColorFormatSupported(format));
}
// Dormant live hooks are not image-processing demand. Capture publishers use
// this gate. An existing output remains an actual reader while its final
// source frame drains, even when source and output now have equal dimensions.
bool imageProcessingRequested(bool activePresentation=false) noexcept;
}
