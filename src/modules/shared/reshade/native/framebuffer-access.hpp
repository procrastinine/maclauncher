#pragma once
#include "image-admission.hpp"
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <objc/runtime.h>
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <stdexcept>
#include "command-resources.hpp"
#include "graphics.hpp"

// Some renderers use framebufferOnly to choose their onscreen coordinate
// convention. Preserve that published property; framebuffer fetch reads the
// final attachment through a render pass, without sampling it as a texture.
namespace macfx::framebuffer {
inline bool supported(id<MTLDevice> device){return [device supportsFamily:MTLGPUFamilyApple2];}
inline bool supportsFormat(MTLPixelFormat pixel) noexcept {
    return nativeFramebufferColorFormatSupported(pixel);
}
inline std::atomic<size_t> &allocated(){static auto *n=new std::atomic<size_t>{0};return *n;}
inline bool reserve(size_t bytes){
    constexpr size_t limit=256u*1024*1024;
    size_t before=allocated().load();
    while(bytes<=limit&&before<=limit-bytes)
        if(allocated().compare_exchange_weak(before,before+bytes))return true;
    return false;
}
struct Slot {
    id<MTLTexture> image;
    size_t bytes=0;bool busy=false;
    void clear(){image=nil;if(bytes)allocated().fetch_sub(bytes);bytes=0;}
    ~Slot(){clear();}
};
struct Pool {
    std::mutex mutex;
    id<MTLDevice> device;
    id<MTLLibrary> library;
    id<MTLRenderPipelineState> fetch,paste;
    MTLPixelFormat format=MTLPixelFormatInvalid;
    std::array<Slot,3> slots;
    void prepare(id<MTLDevice> next,MTLPixelFormat pixel){
        if(device==next&&format==pixel&&fetch&&paste)return;
        if(!supportsFormat(pixel))
            throw std::runtime_error("Framebuffer capture requires a supported RGB drawable");
        NSError *error=nil;
        auto options=[MTLCompileOptions new];options.languageVersion=MTLLanguageVersion2_3;
        auto code=@"#include <metal_stdlib>\nusing namespace metal;\n"
          "vertex float4 fullscreen(uint i [[vertex_id]]){float2 p=float2((i<<1)&2,i&2);return float4(p*2-1,0,1);}\n"
          "struct Copy{float4 value [[color(1)]];};\n"
          "fragment Copy fetch(float4 value [[color(0)]]){Copy o;o.value=value;return o;}\n"
          "fragment float4 paste(float4 p [[position]],texture2d<float,access::read> image [[texture(0)]]){return image.read(uint2(p.xy));}\n";
        auto compiled=[next newLibraryWithSource:code options:options error:&error];
        if(!compiled)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile framebuffer capture");
        auto descriptor=[MTLRenderPipelineDescriptor new];
        descriptor.vertexFunction=[compiled newFunctionWithName:@"fullscreen"];
        descriptor.fragmentFunction=[compiled newFunctionWithName:@"fetch"];
        descriptor.colorAttachments[0].pixelFormat=pixel;
        descriptor.colorAttachments[0].writeMask=MTLColorWriteMaskNone;
        descriptor.colorAttachments[1].pixelFormat=pixel;
        auto read=[next newRenderPipelineStateWithDescriptor:descriptor error:&error];
        if(!read)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create framebuffer capture");
        descriptor.fragmentFunction=[compiled newFunctionWithName:@"paste"];
        descriptor.colorAttachments[0].writeMask=MTLColorWriteMaskAll;
        descriptor.colorAttachments[1].pixelFormat=MTLPixelFormatInvalid;
        auto write=[next newRenderPipelineStateWithDescriptor:descriptor error:&error];
        if(!write)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create framebuffer output");
        device=next;format=pixel;library=compiled;fetch=read;paste=write;
    }
};
struct Lease {
    std::shared_ptr<Pool> pool;unsigned index;
    id<MTLTexture> original,image,raw;
    id<MTLRenderPipelineState> fetch,paste;
    std::atomic<bool> retired{false};
    Lease(std::shared_ptr<Pool> p,unsigned i):pool(std::move(p)),index(i){}
    void retire(){if(!retired.exchange(true)){std::lock_guard<std::mutex>g(pool->mutex);pool->slots[index].busy=false;original=nil;image=nil;raw=nil;fetch=nil;paste=nil;}}
    ~Lease(){retire();}
    void writeBack(id<MTLCommandBuffer> commands){
        auto pass=[MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture=original;
        pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;
        pass.colorAttachments[0].storeAction=MTLStoreActionStore;
        auto encoder=[commands renderCommandEncoderWithDescriptor:pass];
        if(!encoder)throw std::runtime_error("Cannot encode framebuffer output");
        [encoder setRenderPipelineState:paste];[encoder setFragmentTexture:image atIndex:0];
        [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
    }
};
}
@interface RSMFramebufferAccess : NSObject {
@public std::shared_ptr<macfx::framebuffer::Pool> pool;
}
@end
@implementation RSMFramebufferAccess
@end
namespace macfx::framebuffer {
inline std::shared_ptr<Lease> capture(CAMetalLayer *layer,id<MTLCommandBuffer> commands,id<MTLTexture> original){
    static char key;
    RSMFramebufferAccess *owner;
    @synchronized(layer){
        owner=objc_getAssociatedObject(layer,&key);
        if(!owner){owner=[RSMFramebufferAccess new];owner->pool=std::make_shared<Pool>();objc_setAssociatedObject(layer,&key,owner,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
    }
    const auto pool=owner->pool;
    std::unique_lock<std::mutex>guard(pool->mutex);
    if(!supported(commands.device))throw std::runtime_error("Framebuffer capture requires programmable blending");
    if(!original.width||!original.height||original.width>16384||original.height>16384||original.width*original.height>24u*1024*1024)
        throw std::runtime_error("Framebuffer exceeds the 96 MiB capture limit");
    pool->prepare(commands.device,original.pixelFormat);
    unsigned index=3;
    for(unsigned i=0;i<3;++i){auto &slot=pool->slots[i];if(slot.busy)continue;
        if(slot.image&&(slot.image.width!=original.width||slot.image.height!=original.height||slot.image.pixelFormat!=original.pixelFormat||slot.image.device!=commands.device))slot.clear();
        if(index==3||slot.image)index=i;
    }
    if(index==3)throw borrowed::Busy();
    auto &slot=pool->slots[index];
    if(!slot.image){
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:original.pixelFormat width:original.width height:original.height mipmapped:NO];
        descriptor.storageMode=MTLStorageModePrivate;
        descriptor.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead|MTLTextureUsagePixelFormatView;
        const size_t estimate=[commands.device heapTextureSizeAndAlignWithDescriptor:descriptor].size;
        if(estimate>96u*1024*1024)throw std::runtime_error("Framebuffer exceeds the 96 MiB capture limit");
        if(!estimate||!reserve(estimate))throw borrowed::Busy();
        id<MTLTexture> image;
        try{image=newAdmittedTexture(commands.device,descriptor,reinterpret_cast<uintptr_t>((__bridge void*)layer),"framebuffer-memory");}
        catch(...){allocated().fetch_sub(estimate);throw;}
        if(!image){allocated().fetch_sub(estimate);throw std::runtime_error("Cannot allocate framebuffer capture");}
        const size_t bytes=image.allocatedSize;
        if(bytes>96u*1024*1024){allocated().fetch_sub(estimate);throw std::runtime_error("Framebuffer exceeds the 96 MiB capture limit");}
        if(bytes>estimate&&!reserve(bytes-estimate)){allocated().fetch_sub(estimate);throw borrowed::Busy();}
        if(bytes<estimate)allocated().fetch_sub(estimate-bytes);
        slot.image=image;slot.bytes=bytes;
    }
    auto lease=std::make_shared<Lease>(pool,index);
    slot.busy=true;lease->original=original;lease->image=slot.image;lease->raw=slot.image;
    lease->fetch=pool->fetch;lease->paste=pool->paste;
    const auto format=original.pixelFormat;
    if(format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA8Unorm_sRGB)
        lease->raw=[slot.image newTextureViewWithPixelFormat:format==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm];
    guard.unlock();
    if(!lease->raw)throw std::runtime_error("Cannot create framebuffer color view");
    auto pass=[MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture=original;pass.colorAttachments[0].loadAction=MTLLoadActionLoad;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
    pass.colorAttachments[1].texture=lease->image;pass.colorAttachments[1].loadAction=MTLLoadActionDontCare;pass.colorAttachments[1].storeAction=MTLStoreActionStore;
    auto encoder=[commands renderCommandEncoderWithDescriptor:pass];
    if(!encoder)throw std::runtime_error("Cannot encode framebuffer capture");
    // The callback also retains resources for unretained-reference buffers.
    // Releasing an uncommitted buffer destroys it and retires the slot.
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->retire();}];
    [encoder setRenderPipelineState:lease->fetch];
    [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
    return lease;
}
}
