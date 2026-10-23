#pragma once
#include "effect.hpp"
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cstdlib>
#include <algorithm>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <vector>
#include <fstream>

namespace macfx {
template<class T> struct ImageOwner {
    T value;
    explicit ImageOwner(T object):value(object){}
    ~ImageOwner(){if(value)CFRelease(value);}
    ImageOwner(const ImageOwner&)=delete;
};
struct SourceTexture {unsigned width=0,height=0,channels=0;std::vector<unsigned char> pixels;};
inline std::string textureSource(const reshadefx::texture &texture) {
    for(const auto &annotation:texture.annotations)if(annotation.name=="source")return annotation.value.string_data;
    return {};
}
inline SourceTexture loadSourceTexture(const reshadefx::texture &texture,const std::string &effect,size_t &budget) {
    using F=reshadefx::texture_format;
    unsigned channels=texture.format==F::r8?1:texture.format==F::rg8?2:texture.format==F::rgba8||texture.format==F::unknown?4:0;
    if(!channels||texture.levels!=1)throw std::runtime_error("Image textures require single-level R8, RG8 or RGBA8 storage");
    constexpr size_t limit=64u*1024u*1024u;
    const size_t width=texture.width,height=texture.height;
    if(!width||!height||width>16384||height>16384||width*height>limit/4)throw std::runtime_error("Image texture dimensions exceed 64 MiB");
    const size_t bytes=width*height*channels;
    if(bytes>256u*1024u*1024u-budget)throw std::runtime_error("Image textures exceed the 256 MiB effect limit");
    budget+=bytes;
    std::string name=textureSource(texture);for(char &c:name)if(c=='\\')c='/';
    if(name.empty()||name.find('\0')!=std::string::npos)throw std::runtime_error("Image texture source is missing");
    std::vector<std::filesystem::path> roots={std::filesystem::path(effect).parent_path()};
    if(const char *paths=std::getenv("RESHADE_TEXTURE_PATH")){std::stringstream stream(paths);std::string item;while(std::getline(stream,item,':'))if(!item.empty())roots.emplace_back(item);}
    std::filesystem::path found;
    if(std::filesystem::path(effect).filename()=="effect.prepared.fx"){
        std::ifstream mapping(std::filesystem::path(effect).parent_path()/"texture-sources");std::string input,local;
        for(unsigned i=0;i<128&&std::getline(mapping,input)&&std::getline(mapping,local);++i)
            if(input==name&&local.rfind("texture-",0)==0&&local.find_first_not_of("0123456789",8)==std::string::npos){found=std::filesystem::path(effect).parent_path()/local;break;}
    }
    if(found.empty())for(const auto &root:roots){auto candidate=root/name;std::error_code error;if(std::filesystem::is_regular_file(candidate,error)){found=std::move(candidate);break;}}
    if(found.empty())throw std::runtime_error("Image texture was not found: "+name);
    std::error_code error;auto length=std::filesystem::file_size(found,error);
    if(error||length>limit)throw std::runtime_error("Image texture file exceeds 64 MiB: "+name);
    const auto file=found.string();ImageOwner<CFURLRef> url(CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault,reinterpret_cast<const UInt8*>(file.data()),file.size(),false));
    if(!url.value)throw std::runtime_error("Image texture path is invalid");
    ImageOwner<CGImageSourceRef> source(CGImageSourceCreateWithURL(url.value,nullptr));
    const auto imageType=source.value?CGImageSourceGetType(source.value):nullptr;
    if(!imageType||!(CFEqual(imageType,CFSTR("public.png"))||CFEqual(imageType,CFSTR("public.jpeg"))||
        CFEqual(imageType,CFSTR("com.microsoft.bmp"))||CFEqual(imageType,CFSTR("com.compuserve.gif"))))
        throw std::runtime_error("Image texture must be PNG, JPEG, BMP or GIF: "+name);
    ImageOwner<CFDictionaryRef> properties(CGImageSourceCopyPropertiesAtIndex(source.value,0,nullptr));
    int64_t sourceWidth=0,sourceHeight=0;
    if(properties.value){auto w=CFDictionaryGetValue(properties.value,kCGImagePropertyPixelWidth);auto h=CFDictionaryGetValue(properties.value,kCGImagePropertyPixelHeight);
        if(w&&CFGetTypeID(w)==CFNumberGetTypeID())CFNumberGetValue(static_cast<CFNumberRef>(w),kCFNumberSInt64Type,&sourceWidth);
        if(h&&CFGetTypeID(h)==CFNumberGetTypeID())CFNumberGetValue(static_cast<CFNumberRef>(h),kCFNumberSInt64Type,&sourceHeight);}
    if(sourceWidth<=0||sourceHeight<=0||sourceWidth>16384||sourceHeight>16384||uint64_t(sourceWidth)*sourceHeight>limit/4)
        throw std::runtime_error("Decoded image texture exceeds 64 MiB: "+name);
    ImageOwner<CGImageRef> decoded(CGImageSourceCreateImageAtIndex(source.value,0,nullptr));
    if(!decoded.value)throw std::runtime_error("Cannot decode image texture: "+name);
    ImageOwner<CGColorSpaceRef> rgb(CGColorSpaceCreateDeviceRGB());
    // Lookup textures contain numeric data. Reinterpret RGB values in the
    // destination space instead of applying an embedded display color profile.
    ImageOwner<CGImageRef> numeric(CGColorSpaceGetModel(CGImageGetColorSpace(decoded.value))==kCGColorSpaceModelRGB?CGImageCreateCopyWithColorSpace(decoded.value,rgb.value):nullptr);
    std::vector<unsigned char> rgba(width*height*4);
    ImageOwner<CGContextRef> bitmap(CGBitmapContextCreate(rgba.data(),width,height,8,width*4,rgb.value,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big));
    if(!bitmap.value)throw std::runtime_error("Cannot allocate image texture decoder");
    CGContextSetBlendMode(bitmap.value,kCGBlendModeCopy);
    // ReShade resizes supplied images to the declared texture dimensions. Exact
    // lookup images retain their original samples; overlays can scale once here.
    CGContextSetInterpolationQuality(bitmap.value,sourceWidth==int64_t(width)&&sourceHeight==int64_t(height)?kCGInterpolationNone:kCGInterpolationHigh);
    CGContextDrawImage(bitmap.value,CGRectMake(0,0,width,height),numeric.value?numeric.value:decoded.value);
    SourceTexture result{unsigned(width),unsigned(height),channels,{}};result.pixels.resize(width*height*channels);
    for(size_t i=0;i<width*height;++i){const unsigned a=rgba[i*4+3];for(unsigned c=0;c<channels;++c)
        result.pixels[i*channels+c]=c==3?a:a?std::min(255u,(unsigned(rgba[i*4+c])*255u+a/2)/a):0;}
    return result;
}
}
