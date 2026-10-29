#include "spatial.hpp"
#include "frame.h"
#import <Foundation/Foundation.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>
using namespace macfx;
static int failures=0;
static NSMutableArray *records;
static void check(bool pass,NSString *name,NSDictionary *details=@{}) {
    [records addObject:@{@"name":name,@"pass":@(pass),@"details":details}];
    if(!pass) ++failures;
}
static id<MTLTexture> texture(id<MTLDevice> d,unsigned w,unsigned h) {
    auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];
    desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    return [d newTextureWithDescriptor:desc];
}
static void fill(id<MTLTexture> t,unsigned seed,bool solid) {
    std::vector<unsigned char> bytes(t.width*t.height*4);
    for(unsigned y=0;y<t.height;++y) for(unsigned x=0;x<t.width;++x) {
        auto p=&bytes[(y*t.width+x)*4];
        p[0]=solid?seed:(x*13+seed)%256;p[1]=solid?127:(y*19+seed)%256;p[2]=solid?203:((x+y)*7+seed)%256;p[3]=255;
    }
    [t replaceRegion:MTLRegionMake2D(0,0,t.width,t.height) mipmapLevel:0 withBytes:bytes.data() bytesPerRow:t.width*4];
}
static std::vector<unsigned char> read(id<MTLTexture> t) {
    std::vector<unsigned char> bytes(t.width*t.height*4);
    [t getBytes:bytes.data() bytesPerRow:t.width*4 fromRegion:MTLRegionMake2D(0,0,t.width,t.height) mipmapLevel:0];return bytes;
}
static bool finish(id<MTLCommandBuffer> cb) {[cb commit];[cb waitUntilCompleted];return cb.status==MTLCommandBufferStatusCompleted;}
int main(int argc,char **argv) { @autoreleasepool {
    records=[NSMutableArray new];auto d=MTLCreateSystemDefaultDevice();if(!d) return 2;
    auto q=[d newCommandQueue];SpatialEncoder scaler(d);
    // Status reports name the running method; each name parses back to it.
    for(auto method:{SpatialMethod::Bilinear,SpatialMethod::MetalFX,SpatialMethod::LS1,SpatialMethod::Mako,SpatialMethod::FSR1,SpatialMethod::Nearest,SpatialMethod::Bicubic,SpatialMethod::Area})
        check(spatialMethodForName(spatialMethodName(method))==method,@"spatial status name",@{@"name":@(spatialMethodName(method))});
    for(auto method:{SpatialMethod::Bilinear,SpatialMethod::MetalFX,SpatialMethod::Mako}) {
        auto source=texture(d,17,11),output=texture(d,34,22);fill(source,51,true);
        auto cb=[q commandBuffer];auto status=scaler.encode(cb,{source,output,1},method);
        bool complete=finish(cb);auto pixels=read(output);int error=0;
        for(size_t p=0;p<pixels.size();p+=4) {
            error=std::max({error,abs(pixels[p]-51),abs(pixels[p+1]-127),abs(pixels[p+2]-203),abs(pixels[p+3]-255)});
        }
        check(status.encoded&&complete&&status.active==method&&error<=2,
            method==SpatialMethod::Bilinear?@"bilinear-solid-2x":method==SpatialMethod::MetalFX?@"metalfx-solid-2x":@"mako-solid-2x",
            @{@"maxByteError":@(error),@"reason":@(status.reason.c_str()),@"gpuMs":@((cb.GPUEndTime-cb.GPUStartTime)*1000)});
    }
    {
        auto source=texture(d,2,2),output=texture(d,4,4);
        const unsigned char pattern[]={0,0,0,255, 240,0,0,255, 0,240,0,255, 240,240,0,255};
        [source replaceRegion:MTLRegionMake2D(0,0,2,2) mipmapLevel:0 withBytes:pattern bytesPerRow:8];
        auto cb=[q commandBuffer];auto status=scaler.encode(cb,{source,output,50},SpatialMethod::Bilinear);bool done=finish(cb);auto pixels=read(output);auto before=read(source);int error=0;
        const int expected[]={0,60,180,240};for(unsigned y=0;y<4;++y)for(unsigned x=0;x<4;++x){auto p=&pixels[(y*4+x)*4];error=std::max({error,abs(p[0]-expected[x]),abs(p[1]-expected[y]),(int)p[2],abs(p[3]-255)});}
        check(done&&status.encoded&&error<=1,@"bilinear-gradient-pixel-centres",@{@"maxByteError":@(error)});
        check(std::equal(before.begin(),before.end(),pattern),@"spatial-preserves-source-pixels");
        cb=[q commandBuffer];status=scaler.encode(cb,{source,output,51},SpatialMethod::Nearest);done=finish(cb);pixels=read(output);error=0;
        const int nearest[]={0,0,240,240};for(unsigned y=0;y<4;++y)for(unsigned x=0;x<4;++x){auto p=&pixels[(y*4+x)*4];error=std::max({error,abs(p[0]-nearest[x]),abs(p[1]-nearest[y]),(int)p[2],abs(p[3]-255)});}
        check(done&&status.encoded&&status.active==SpatialMethod::Nearest&&error==0,@"nearest-gradient-pixel-centres",@{@"maxByteError":@(error)});
    }
    {
        auto source=texture(d,5,3),output=texture(d,2,2);fill(source,11,false);auto original=read(source);auto commands=[q commandBuffer];auto status=scaler.encode(commands,{source,output,52},SpatialMethod::Nearest);const bool done=finish(commands);auto pixels=read(output);int error=0;
        const unsigned xs[]={1,3},ys[]={0,2};for(unsigned y=0;y<2;++y)for(unsigned x=0;x<2;++x)for(unsigned c=0;c<4;++c)error=std::max(error,abs(pixels[(y*2+x)*4+c]-original[(ys[y]*5+xs[x])*4+c]));
        check(done&&status.encoded&&status.active==SpatialMethod::Nearest&&status.reason.empty()&&error==0,@"nearest-downsample-odd-ratio",@{@"maxByteError":@(error)});
    }
    {
        auto source=texture(d,4,4);const unsigned char ramp[]={0,255,0,255};std::vector<unsigned char> pixels(4*4*4);for(unsigned y=0;y<4;++y)for(unsigned x=0;x<4;++x){auto p=&pixels[(y*4+x)*4];p[0]=ramp[x];p[1]=ramp[y];p[2]=203;p[3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,4,4) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:16];
        const std::vector<int> expectedUp={0,58,221,215,40,34,197,255},expectedDown={34,128,221};
        for(const auto &expected:{expectedUp,expectedDown}){
            const unsigned size=expected.size();auto output=texture(d,size,size);auto commands=[q commandBuffer];auto status=scaler.encode(commands,{source,output,53+size},SpatialMethod::Bicubic);const bool done=finish(commands);auto actual=read(output);int error=0;
            for(unsigned y=0;y<size;++y)for(unsigned x=0;x<size;++x){auto p=&actual[(y*size+x)*4];error=std::max({error,abs(p[0]-expected[x]),abs(p[1]-expected[y]),abs(p[2]-203),abs(p[3]-255)});}
            check(done&&status.encoded&&status.active==SpatialMethod::Bicubic&&status.reason.empty()&&error<=1,size==8?@"bicubic-catmull-rom-4x4-upsample":@"bicubic-catmull-rom-4x4-downsample",@{@"maxByteError":@(error)});
        }
    }
    // Queue differently sized images before any completion. The first scaler and
    // texture pair must survive cache replacement and each output stays distinct.
    NSMutableArray *buffers=[NSMutableArray new],*outputs=[NSMutableArray new];
    for(unsigned i=0;i<8;++i) {
        auto source=texture(d,16+i,16+i),output=texture(d,32+i*2,32+i*2);fill(source,30+i*10,true);
        auto cb=[q commandBuffer];auto status=scaler.encode(cb,{source,output,i+2},SpatialMethod::MetalFX);
        check(status.encoded&&status.active==SpatialMethod::MetalFX,@"metalfx-resize-encode",@{@"frame":@(i)});
        [buffers addObject:cb];[outputs addObject:output];[cb commit];
    }
    for(unsigned i=0;i<buffers.count;++i) {
        id<MTLCommandBuffer> cb=buffers[i];[cb waitUntilCompleted];auto pixels=read(outputs[i]);int error=0;
        for(size_t p=0;p<pixels.size();p+=4) error=std::max(error,abs(pixels[p]-(30+(int)i*10)));
        check(cb.status==MTLCommandBufferStatusCompleted&&error<=2,@"metalfx-resize-complete",@{@"frame":@(i),@"maxByteError":@(error)});
    }
    // Same-size independent command buffers exercise the reusable scaler path.
    [buffers removeAllObjects];[outputs removeAllObjects];
    for(unsigned i=0;i<8;++i) {
        auto source=texture(d,24,24),output=texture(d,48,48);fill(source,30+i*10,true);
        auto cb=[q commandBuffer];auto status=scaler.encode(cb,{source,output,i+20},SpatialMethod::MetalFX);
        check(status.encoded,@"metalfx-inflight-encode",@{@"frame":@(i)});
        [buffers addObject:cb];[outputs addObject:output];[cb commit];
    }
    for(unsigned i=0;i<buffers.count;++i) {
        id<MTLCommandBuffer> cb=buffers[i];[cb waitUntilCompleted];auto pixels=read(outputs[i]);int error=0;
        for(size_t p=0;p<pixels.size();p+=4) error=std::max(error,abs(pixels[p]-(30+(int)i*10)));
        check(cb.status==MTLCommandBufferStatusCompleted&&error<=2,@"metalfx-inflight-complete",@{@"frame":@(i),@"maxByteError":@(error)});
    }
    auto input=texture(d,16,16),smaller=texture(d,8,8),large=texture(d,64,64);auto cb=[q commandBuffer];
    check(!scaler.encode(cb,{input,input},SpatialMethod::MetalFX).encoded,@"reject-alias");
    check(!scaler.encode(nil,{input,large},SpatialMethod::MetalFX).encoded,@"reject-missing-buffer");
    // An upscaler keeps its identity: a reduction is rejected without a
    // substituted filter (the graph owns explicit fits), and later ratios
    // return to the requested method without constructing a new encoder owner.
    for(auto method:{SpatialMethod::MetalFX,SpatialMethod::Mako,SpatialMethod::FSR1}) {
        fill(input,49,true);
        for(unsigned extent:{64u,8u,32u,96u}) {
            auto output=texture(d,extent,extent);auto commands=[q commandBuffer];
            const bool reduces=extent<16;auto status=scaler.encode(commands,{input,output,90+extent},method);
            const bool done=finish(commands);auto pixels=read(output);int error=0;
            if(!reduces)for(size_t p=0;p<pixels.size();p+=4)error=std::max({error,abs(pixels[p]-49),abs(pixels[p+1]-127),abs(pixels[p+2]-203),abs(pixels[p+3]-255)});
            check(status.encoded!=reduces&&done&&status.requested==method&&status.active==method&&status.reason.empty()!=reduces&&error<=3,
                @"spatial-resize-fallback-recovery",@{@"method":@(unsigned(method)),@"output":@(extent),@"active":@(unsigned(status.active)),@"reason":@(status.reason.c_str()),@"maxByteError":@(error)});
        }
    }
    for(auto method:{SpatialMethod::Nearest,SpatialMethod::Bicubic})for(unsigned extent:{64u,8u,32u,96u}){
        fill(input,49,true);auto output=texture(d,extent,extent);auto commands=[q commandBuffer];auto status=scaler.encode(commands,{input,output,190+extent},method);const bool done=finish(commands);auto pixels=read(output);int error=0;
        for(size_t p=0;p<pixels.size();p+=4)error=std::max({error,abs(pixels[p]-49),abs(pixels[p+1]-127),abs(pixels[p+2]-203),abs(pixels[p+3]-255)});
        check(done&&status.encoded&&status.active==method&&status.reason.empty()&&error<=1,@"interpolation-arbitrary-ratio",@{@"method":@(unsigned(method)),@"output":@(extent),@"maxByteError":@(error)});
    }
    // The frame API prepares a new spatial output off the frame path and
    // answers RS_FRAME_BUSY until it is ready; the host retries a later frame.
    for(unsigned method:{unsigned(RS_FRAME_NEAREST),unsigned(RS_FRAME_BICUBIC)}){
        auto output=texture(d,8,8);id<MTLCommandBuffer> commands=nil;int owner=0,code=RS_FRAME_BUSY;RSFrameResult result{};
        for(unsigned attempt=0;code==RS_FRAME_BUSY&&attempt<2000;++attempt){if(attempt)std::this_thread::sleep_for(std::chrono::milliseconds(1));commands=[q commandBuffer];RSFrameRequest request{sizeof(RSFrameRequest),RS_FRAME_ABI_VERSION,&owner,(__bridge void*)commands,(__bridge void*)input,(__bridge void*)output,300+method,method,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};result={};result.size=sizeof(result);result.version=RS_FRAME_ABI_VERSION;code=rsProcessFrame(&request,&result);}
        const bool done=finish(commands);check(code==RS_FRAME_OK&&result.encoded&&result.activeMethod==method&&done,@"interpolation-c-frame-api",@{@"method":@(method),@"reason":@(result.reason)});rsReleaseFrameOwner(&owner);
    }
    // New scaler owners can be destroyed before their queued work completes.
    for(unsigned i=0;i<16;++i){@autoreleasepool{
        auto source=texture(d,19+i,13+i),output=texture(d,38+i*2,26+i*2);fill(source,31+i,true);auto before=read(source);auto commands=[q commandBuffer];
        const SpatialMethod methods[]={SpatialMethod::MetalFX,SpatialMethod::Mako,SpatialMethod::Nearest,SpatialMethod::Bicubic};
        {SpatialEncoder transient(d);auto status=transient.encode(commands,{source,output,i},methods[i%4]);check(status.encoded,@"spatial-owner-queued",@{@"frame":@(i)});}
        bool done=finish(commands);auto pixels=read(output);int error=0;for(size_t p=0;p<pixels.size();p+=4)error=std::max({error,abs(pixels[p]-(31+(int)i)),abs(pixels[p+1]-127),abs(pixels[p+2]-203),abs(pixels[p+3]-255)});
        check(done&&error<=2&&read(source)==before,@"spatial-owner-release-resize",@{@"frame":@(i),@"maxByteError":@(error)});
    }}
    NSDictionary *report=@{@"device":d.name,@"metalfxAvailable":@(SpatialEncoder::metalFXAvailable(d)),@"failures":@(failures),@"tests":records};
    NSData *json=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];fwrite(json.bytes,1,json.length,stdout);putchar('\n');return failures?1:0;
}}
