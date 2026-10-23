#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "../src/modules/shared/reshade/temporal/frame.h"
#include <dlfcn.h>
#include <cmath>
#include <cstdio>
#include <vector>
#include <cstring>

// Standalone GPU check: fsr-temporal-metal <provider dylib> <shader directory>.
// The application owns submission; the provider must leave buffers uncommitted.
int main(int argc,char **argv) { @autoreleasepool {
    if(argc!=3)return 2;
    setenv("RESHADE_FSR_SHADER_DIRECTORY",argv[2],1);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){std::fprintf(stderr,"%s\n",dlerror());return 2;}
    auto get=(RSGetTemporalProvider)dlsym(library,"rsGetTemporalProvider");
    const RSTemporalProvider *provider=get?get(1):nullptr;
    if(!provider)return 2;
    const uint32_t method=provider->methods&(1u<<RS_TEMPORAL_FSR3)?RS_TEMPORAL_FSR3:RS_TEMPORAL_FSR2;
    if(!(provider->methods&(1u<<method)))return 2;
    id<MTLDevice> device=MTLCreateSystemDefaultDevice(); if(!device)return 2;
    id<MTLCommandQueue> queue=[device newCommandQueue];
    auto texture=[&](MTLPixelFormat format,unsigned w,unsigned h) {
        MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];
        d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;d.storageMode=MTLStorageModeShared;
        return [device newTextureWithDescriptor:d];
    };
    constexpr unsigned w=128,h=96,ow=192,oh=144;
    id<MTLTexture> color=texture(MTLPixelFormatRGBA32Float,w,h),depth=texture(MTLPixelFormatR32Float,w,h),motion=texture(MTLPixelFormatRG32Float,w,h),output=texture(MTLPixelFormatRGBA32Float,ow,oh);
    std::vector<float> colors(w*h*4),depths(w*h,.5f),motions(w*h*2,0),pixels(ow*oh*4);
    for(unsigned i=0;i<w*h;++i){colors[4*i]=.2f;colors[4*i+1]=.4f;colors[4*i+2]=.7f;colors[4*i+3]=1;}
    [color replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:colors.data() bytesPerRow:w*16];
    [depth replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:depths.data() bytesPerRow:w*4];
    [motion replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:motions.data() bytesPerRow:w*8];
    RSTemporalFrame frame{};frame.size=sizeof(frame);frame.version=1;frame.owner=&frame;frame.method=method;
    frame.color=(__bridge void *)color;frame.depth=(__bridge void *)depth;frame.motion=(__bridge void *)motion;frame.output=(__bridge void *)output;
    frame.renderWidth=frame.maxRenderWidth=w;frame.renderHeight=frame.maxRenderHeight=h;frame.outputWidth=ow;frame.outputHeight=oh;
    frame.nearPlane=.1f;frame.farPlane=100.f;frame.verticalFov=1.1f;frame.preExposure=1;frame.frameTimeMs=16.6667f;frame.motionScaleX=w;frame.motionScaleY=h;
    RSTemporalResult result{};result.size=sizeof(result);result.version=1;
    id<MTLCommandBuffer> invalid=[queue commandBuffer];frame.commandBuffer=(__bridge void *)invalid;
    if(provider->encode(&frame,&result)!=RS_TEMPORAL_INVALID){std::fprintf(stderr,"Camera-less frame was accepted\n");return 1;}
    for(unsigned n=1;n<=5;++n) {
        frame.flags=RS_TEMPORAL_CAMERA_VALID|(n==1?RS_TEMPORAL_RESET:0);frame.frameId=n;
        frame.jitterX=n&1?.25f:-.25f;frame.jitterY=n&1?-.25f:.25f;frame.sharpness=n==4?.5f:0;
        id<MTLCommandBuffer> command=[queue commandBuffer];frame.commandBuffer=(__bridge void *)command;
        int status=provider->encode(&frame,&result);
        if(status!=RS_TEMPORAL_OK || !result.encoded){std::fprintf(stderr,"frame %u: %d %s\n",n,status,result.reason);return 1;}
        if(command.status>=MTLCommandBufferStatusCommitted){std::fprintf(stderr,"Provider committed caller commands\n");return 1;}
        if(provider->encode(&frame,&result)!=RS_TEMPORAL_BUSY){std::fprintf(stderr,"Pending frame not bounded\n");return 1;}
        [command commit];[command waitUntilCompleted];
        if(command.status==MTLCommandBufferStatusError){std::fprintf(stderr,"GPU: %s\n",command.error.localizedDescription.UTF8String);return 1;}
        [output getBytes:pixels.data() bytesPerRow:ow*16 fromRegion:MTLRegionMake2D(0,0,ow,oh) mipmapLevel:0];
        double sum[3]={};unsigned count=0;
        for(unsigned y=8;y<oh-8;++y)for(unsigned x=8;x<ow-8;++x){for(unsigned c=0;c<3;++c){float v=pixels[(y*ow+x)*4+c];if(!std::isfinite(v))return 1;sum[c]+=v;}++count;}
        const float expected[3]={.2f,.4f,.7f};
        for(unsigned c=0;c<3;++c)if(std::abs(sum[c]/count-expected[c])>.025){std::fprintf(stderr,"Unexpected RGB mean frame=%u c=%u value=%g\n",n,c,sum[c]/count);return 1;}
        std::printf("frame=%u rgb=%.5f,%.5f,%.5f GPU-ms=%.3f\n",n,sum[0]/count,sum[1]/count,sum[2]/count,(command.GPUEndTime-command.GPUStartTime)*1000);
    }
    // Dropping an encoded but uncommitted buffer must release BUSY and abandon
    // its history, even though the owner stays alive for a later frame.
    @autoreleasepool {
        id<MTLCommandBuffer> discarded=[queue commandBufferWithUnretainedReferences];
        frame.commandBuffer=(__bridge void *)discarded;frame.frameId=6;
        if(provider->encode(&frame,&result)!=RS_TEMPORAL_OK)return 1;
        discarded=nil;frame.commandBuffer=nullptr;
    }
    @autoreleasepool {
        id<MTLCommandBuffer> resumed=[queue commandBufferWithUnretainedReferences];
        frame.commandBuffer=(__bridge void *)resumed;frame.frameId=7;
        if(provider->encode(&frame,&result)!=RS_TEMPORAL_OK || !result.reset){std::fprintf(stderr,"Discarded frame did not release pending history: %s\n",result.reason);return 1;}
        __weak id<MTLTexture> retainedColor=color;
        color=nil;depth=nil;motion=nil;provider->release(frame.owner);
        if(!retainedColor){std::fprintf(stderr,"Input textures were not retained through submission\n");return 1;}
        [resumed commit];[resumed waitUntilCompleted];
        if(resumed.status==MTLCommandBufferStatusError){std::fprintf(stderr,"Unretained-buffer GPU failure: %s\n",resumed.error.localizedDescription.UTF8String);return 1;}
    }
    provider->release(frame.owner);
    std::printf("FSR%u Metal temporal encoding, sharpening, camera validation, discarded buffers and resource lifetime checks passed.\n",method);
    return 0;
} }
