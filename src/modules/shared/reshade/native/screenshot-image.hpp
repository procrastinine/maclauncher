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
inline ColorConversion screenshotConversion(const ImageColorDescription&color,uint64_t frameId){
    const bool hdr=screenshotHDR(color);ColorConversion conversion;conversion.source=color;conversion.target=screenshotColor(color);
    conversion.toneMap=hdr?ColorToneMap::Preserve:outputColorMapping("auto",color,conversion.target,false).toneMap;
    conversion.ditherBits=hdr?0:8;conversion.frameId=frameId;return conversion;
}
// A screenshot uses BT.2020 PQ RGBA16Unorm for HDR output and 8-bit sRGB
// with Automatic mapping for SDR output. Presenters, in-place processing and
// capture reservations own their converters. A failed HDR conversion uses the
// existing SDR screenshot route; a failed SDR conversion returns the output,
// which leaves the capture request pending, as an unreadable image does.
class ScreenshotImage {
    std::shared_ptr<ColorEncoder>encoder;id<MTLTexture>image;
public:
    id<MTLTexture> prepare(id<MTLCommandBuffer>commands,id<MTLTexture>output,const ImageColorDescription&color,uint64_t frameId,const std::shared_ptr<ColorEncoder>&shared={}){
        const bool hdr=screenshotHDR(color);const auto format=screenshotFormat(color);
        if(!output||(!hdr&&captureWritesFormat(output.pixelFormat))||(hdr&&screenshotHDRTexture(output)))return output;
        try{
            // A caller without its own encoder gets one on its first converted capture.
            if(shared)encoder=shared;else if(!encoder)encoder=std::make_shared<ColorEncoder>(output.device);
            if(!image||image.device!=output.device||image.width!=output.width||image.height!=output.height||image.pixelFormat!=format){
                auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:output.width height:output.height mipmapped:NO];
                descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
                image=newAdmittedTexture(output.device,descriptor,reinterpret_cast<uintptr_t>(this),"screenshot");
                if(!image)throw std::runtime_error("no image memory");
            }
            const auto conversion=screenshotConversion(color,frameId);
            const auto converted=encoder->encode(commands,output,image,conversion);if(!converted.encoded)throw std::runtime_error(converted.reason);
            if(hdr)markScreenshotHDR(image);
            return image;
        }catch(const std::exception&error){
            static std::atomic<bool>logged{false};if(!logged.exchange(true))nativeLog(std::string("Screenshot color conversion failed: ")+error.what());
            if(hdr)try{
                // Optional HDR storage must not remove the existing SDR capture.
                auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:output.width height:output.height mipmapped:NO];
                descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
                image=newAdmittedTexture(output.device,descriptor,reinterpret_cast<uintptr_t>(this),"screenshot");
                if(!image)throw std::runtime_error("no image memory");
                ColorConversion conversion;conversion.source=color;conversion.target.referenceWhite=std::isfinite(color.referenceWhite)&&color.referenceWhite>0?color.referenceWhite:203;
                conversion.target.peakLuminance=conversion.target.referenceWhite;conversion.toneMap=outputColorMapping("auto",color,conversion.target,false).toneMap;conversion.ditherBits=8;conversion.frameId=frameId;
                if(encoder&&encoder->encode(commands,output,image,conversion).encoded)return image;
            }catch(const std::exception&){}
            return output;
        }
    }
};
}
