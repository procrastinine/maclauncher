#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "screenshot-color.hpp"
#include "image-admission.hpp"
#include "log.hpp"
#include "output-color.hpp"
#include <atomic>
#include <memory>
#include <stdexcept>
#include <string>
namespace macfx {
// The image frame capture reads for one output: an 8-bit output itself,
// otherwise the output converted once to 8-bit sRGB at its reference white
// with Automatic mapping. The shared presenter and in-place processing each
// own one. A failed conversion returns the output, which leaves the capture
// request pending, as an unreadable image does.
class ScreenshotImage {
    std::shared_ptr<ColorEncoder>encoder;id<MTLTexture>image;
public:
    id<MTLTexture> prepare(id<MTLCommandBuffer>commands,id<MTLTexture>output,const ImageColorDescription&color,uint64_t frameId,const std::shared_ptr<ColorEncoder>&shared={}){
        if(!output||captureWritesFormat(output.pixelFormat))return output;
        try{
            // A caller without its own encoder gets one on its first converted capture.
            if(shared)encoder=shared;else if(!encoder)encoder=std::make_shared<ColorEncoder>(output.device);
            if(!image||image.device!=output.device||image.width!=output.width||image.height!=output.height){
                auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:output.width height:output.height mipmapped:NO];
                descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
                image=newAdmittedTexture(output.device,descriptor,reinterpret_cast<uintptr_t>(this),"screenshot");
                if(!image)throw std::runtime_error("no image memory");
            }
            ColorConversion conversion;conversion.source=color;conversion.target=screenshotColor(color);conversion.toneMap=outputColorMapping("auto",color,conversion.target,false).toneMap;conversion.ditherBits=8;conversion.frameId=frameId;
            const auto converted=encoder->encode(commands,output,image,conversion);if(!converted.encoded)throw std::runtime_error(converted.reason);
            return image;
        }catch(const std::exception&error){static std::atomic<bool>logged{false};if(!logged.exchange(true))nativeLog(std::string("Screenshot color conversion failed: ")+error.what());return output;}
    }
};
}
