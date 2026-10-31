#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Performance overlay drawn by the shared presenter over the final fitted
// image. Text is rasterized with Core Text at most four times per second on a
// utility queue; every presented image composites the latest raster with one
// small blended draw. It reads only counters the presenter already keeps.
// Objective-C++ only; plain C++ units see the counters in hud-counters.hpp.
#include "hud-counters.hpp"
#ifdef __OBJC__
#import <CoreText/CoreText.h>
#import <Metal/Metal.h>
#include "color-contract.hpp"
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace macfx {
class HudOverlay {
    struct Raster {id<MTLTexture> texture;unsigned width=0,height=0;};
    struct State {std::mutex mutex;Raster latest;bool rendering=false;double next=0;HudSample previous;bool hasPrevious=false;};
    const std::shared_ptr<State> state=std::make_shared<State>();
    dispatch_queue_t queue=dispatch_queue_create("macfx.hud",DISPATCH_QUEUE_SERIAL);
    std::mutex pipelineMutex;id<MTLLibrary> library;std::map<MTLPixelFormat,id<MTLRenderPipelineState>> pipelines;
    static bool srgbFormat(MTLPixelFormat format){return format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA8Unorm_sRGB;}
    // Core Text into a premultiplied sRGB bitmap, then a texture the GPU can
    // sample. Managed storage keeps discrete GPUs supported.
    static Raster rasterize(id<MTLDevice> device,const std::vector<std::string> &lines,double fontPixels,bool warning){
        Raster result;if(lines.empty())return result;
        CTFontRef font=CTFontCreateUIFontForLanguage(kCTFontUIFontUserFixedPitch,fontPixels,nullptr);
        if(!font)font=CTFontCreateWithName(CFSTR("Menlo"),fontPixels,nullptr);
        if(!font)return result;
        CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        const CGFloat white[]{1,1,1,1},amber[]{1,.78,.3,1};
        std::vector<CTLineRef> rows;double width=0;const double lineHeight=std::ceil(fontPixels*1.3);
        for(size_t i=0;i<lines.size();++i){
            CGColorRef color=CGColorCreate(space,warning&&i+1==lines.size()?amber:white);
            const void *keys[]{kCTFontAttributeName,kCTForegroundColorAttributeName};const void *values[]{font,color};
            CFDictionaryRef attributes=CFDictionaryCreate(nullptr,keys,values,2,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
            CFStringRef text=CFStringCreateWithCString(nullptr,lines[i].c_str(),kCFStringEncodingUTF8);
            CFAttributedStringRef attributed=text?CFAttributedStringCreate(nullptr,text,attributes):nullptr;
            CTLineRef line=attributed?CTLineCreateWithAttributedString(attributed):nullptr;
            if(line){rows.push_back(line);width=std::max(width,CTLineGetTypographicBounds(line,nullptr,nullptr,nullptr));}
            if(attributed)CFRelease(attributed);if(text)CFRelease(text);CFRelease(attributes);CGColorRelease(color);
        }
        const double padding=std::ceil(fontPixels*.6);
        result.width=unsigned(std::ceil(width+2*padding));result.height=unsigned(std::ceil(rows.size()*lineHeight+2*padding));
        if(result.width&&result.height&&result.width<=8192&&result.height<=8192){
            const size_t stride=size_t(result.width)*4;std::vector<uint8_t> pixels(stride*result.height);
            CGContextRef context=CGBitmapContextCreate(pixels.data(),result.width,result.height,8,stride,space,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
            if(context){
                CGContextSetRGBFillColor(context,0,0,0,.62);CGContextFillRect(context,CGRectMake(0,0,result.width,result.height));
                for(size_t i=0;i<rows.size();++i){
                    CGContextSetTextPosition(context,padding,result.height-padding-(i+1)*lineHeight+fontPixels*.3);
                    CTLineDraw(rows[i],context);
                }
                CGContextRelease(context);
                auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:result.width height:result.height mipmapped:NO];
                descriptor.usage=MTLTextureUsageShaderRead;descriptor.storageMode=device.hasUnifiedMemory?MTLStorageModeShared:MTLStorageModeManaged;
                result.texture=[device newTextureWithDescriptor:descriptor];
                [result.texture replaceRegion:MTLRegionMake2D(0,0,result.width,result.height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:stride];
            }
        }
        for(auto row:rows)CFRelease(row);
        CGColorSpaceRelease(space);CFRelease(font);
        if(!result.texture)result={};
        return result;
    }
    id<MTLRenderPipelineState> pipeline(id<MTLDevice> device,MTLPixelFormat format){
        std::lock_guard lock(pipelineMutex);
        if(auto found=pipelines.find(format);found!=pipelines.end())return found->second;
        NSError *error=nil;
        if(!library){
            const char *source=R"MSL(#include <metal_stdlib>
using namespace metal;
struct Policy{float4 rect;uint transfer;float white;uint2 padding;};
struct Varying{float4 position[[position]];float2 uv;};
vertex Varying hud_vertex(uint i[[vertex_id]],constant Policy&policy[[buffer(0)]]){
 const float2 corner[]={float2(0,0),float2(1,0),float2(0,1),float2(1,1)};Varying out;
 const float2 c=corner[i];out.uv=c;out.position=float4(mix(policy.rect.xy,policy.rect.zw,c),0,1);return out;}
float3 hud_linear(float3 v){return select(v/12.92f,pow((v+.055f)/1.055f,float3(2.4f)),v>.04045f);}
float3 hud_encode(float3 v,uint t){if(t==1)return v;if(t==2){float3 p=pow(max(v,0.0),float3(2610.0/16384.0));return pow((3424.0/4096.0+2413.0/128.0*p)/(1.0+2392.0/128.0*p),float3(2523.0/32.0));}
 if(t==3){float3 x=max(v,0.0);return select(sqrt(3.0*x),.17883277*log(max(12.0*x-.28466892,1e-8))+.55991073,x>1.0/12.0);}
 if(t==4)return select(v*4.5,1.099*pow(max(v,0.0),float3(.45))-.099,v>=.018);return select(v*12.92f,1.055f*pow(v,float3(1.0f/2.4f))-.055f,v>.0031308f);}
fragment float4 hud_fragment(Varying in[[stage_in]],texture2d<float>image[[texture(0)]],constant Policy&policy[[buffer(0)]]){
 constexpr sampler linearSampler(filter::linear,address::clamp_to_edge);float4 c=image.sample(linearSampler,in.uv);
 if(c.a<=0)return float4(0);float3 v=hud_linear(c.rgb/c.a)*policy.white;return float4(hud_encode(v,policy.transfer)*c.a,c.a);})MSL";
            library=[device newLibraryWithSource:@(source) options:nil error:&error];
            if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile the performance overlay");
        }
        auto descriptor=[MTLRenderPipelineDescriptor new];
        descriptor.vertexFunction=[library newFunctionWithName:@"hud_vertex"];descriptor.fragmentFunction=[library newFunctionWithName:@"hud_fragment"];
        auto attachment=descriptor.colorAttachments[0];attachment.pixelFormat=format;attachment.blendingEnabled=YES;
        attachment.sourceRGBBlendFactor=MTLBlendFactorOne;attachment.destinationRGBBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        attachment.sourceAlphaBlendFactor=MTLBlendFactorOne;attachment.destinationAlphaBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        auto value=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];
        if(!value)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare the performance overlay");
        return pipelines[format]=value;
    }
public:
    // Drops the raster and the rate baseline, for example when the overlay is
    // turned off, so a later overlay starts from fresh counters.
    void reset(){std::lock_guard lock(state->mutex);state->latest={};state->hasPrevious=false;state->next=0;}
    // `sample` runs on the caller's thread only when a refresh is due. The
    // draw itself never waits for text rasterization.
    void encode(id<MTLCommandBuffer> commands,id<MTLTexture> target,bool detailed,ColorTransfer transfer,double referenceWhite,double now,const std::function<HudSample()> &sample){
        if(!commands||!target)return;
        id<MTLDevice> device=commands.device;
        bool refresh=false;Raster raster;
        {std::lock_guard lock(state->mutex);raster=state->latest;if(!state->rendering&&now>=state->next){state->rendering=true;state->next=now+.25;refresh=true;}}
        if(refresh){
            HudSample current;
            try{current=sample();current.time=now;}catch(...){std::lock_guard lock(state->mutex);state->rendering=false;throw;}
            const double fontPixels=std::clamp(std::round(target.height/48.),11.,30.);
            auto shared=state;
            dispatch_async(queue,^{@autoreleasepool{
                HudSample previous;bool known=false;{std::lock_guard lock(shared->mutex);previous=shared->previous;known=shared->hasPrevious;}
                const auto report=assembleHud(known?previous:current,current);
                Raster next=rasterize(device,hudLines(report,detailed),fontPixels,!report.invariantHolds);
                std::lock_guard lock(shared->mutex);shared->previous=current;shared->hasPrevious=true;shared->rendering=false;if(next.texture)shared->latest=next;
            }});
        }
        if(!raster.texture||raster.width>target.width||raster.height>target.height)return;
        const auto format=target.pixelFormat;
        const bool encodedOutput=srgbFormat(format);
        struct Policy{float rect[4];uint32_t transfer;float white;uint32_t padding[2];}policy{};
        const float margin=std::round(float(target.height)/80.f);
        const float left=-1+2*margin/target.width,top=1-2*margin/target.height;
        policy.rect[0]=left;policy.rect[1]=top;policy.rect[2]=left+2.f*raster.width/target.width;policy.rect[3]=top-2.f*raster.height/target.height;
        // An sRGB render target encodes on write; other targets receive their
        // own transfer. HDR targets show overlay white at reference white.
        policy.transfer=encodedOutput?1u:unsigned(transfer);
        policy.white=transfer==ColorTransfer::PQ?float(std::clamp(referenceWhite,1.,10000.)/10000.):transfer==ColorTransfer::HLG?.26f:1.f;
        auto pass=[MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture=target;pass.colorAttachments[0].loadAction=MTLLoadActionLoad;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
        auto drawPipeline=pipeline(device,format);
        auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Cannot encode the performance overlay");
        [encoder setRenderPipelineState:drawPipeline];[encoder setVertexBytes:&policy length:sizeof(policy) atIndex:0];[encoder setFragmentBytes:&policy length:sizeof(policy) atIndex:0];
        [encoder setFragmentTexture:raster.texture atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];[encoder endEncoding];
    }
};
}
#endif
