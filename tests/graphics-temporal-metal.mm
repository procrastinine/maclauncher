#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#include "../src/modules/shared/reshade/temporal/frame.h"
#include <dlfcn.h>
#include <vector>
#include <fstream>
#include <thread>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>

// graphics-temporal-metal LIBRARY CONTROL_FILE [FSR4_PAYLOAD [mtl4]]
// Runs an ordinary application's MetalFX scaler as well as the explicit API.
// The optional Metal 4 branch covers descriptor capture and live replacement only.
static void check(bool value,const char *message){if(!value){fprintf(stderr,"%s\n",message);exit(1);}}
int main(int argc,char **argv){@autoreleasepool{
    if(argc<3||argc>5||(argc==5&&strcmp(argv[4],"mtl4")))return 2;
    const bool metal4=argc==5,hasFSR4=argc>=4;
    setenv("RESHADE_TEMPORAL_CONTROL_FILE",argv[2],1);
    auto controls=[&](uint32_t method){struct Packet {char magic[8];uint32_t method;float sharpness;uint32_t flags,reserved;};
        Packet p{};memcpy(p.magic,"MLTMCTL1",8);p.method=method;p.sharpness=.35f;
        std::string temporary=std::string(argv[2])+".next";
        {std::ofstream file(temporary,std::ios::binary);file.write((const char*)&p,sizeof(p));}
        check(rename(temporary.c_str(),argv[2])==0,"Cannot publish live controls");
        std::this_thread::sleep_for(std::chrono::milliseconds(110));
    };
    controls(0);
    if(hasFSR4){std::string root=argv[3];setenv("RESHADE_FSR4_LIBRARY",(root+"/libmaclauncher-fsr4.dylib").c_str(),1);setenv("FSR4_ROOT",root.c_str(),1);setenv("FSR4_BUILD_DIR",(root+"/build").c_str(),1);}
    void *lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);check(lib,dlerror()?:"Library not loaded");
    auto process=(decltype(&rsProcessTemporalFrame))dlsym(lib,"rsProcessTemporalFrame");auto release=(decltype(&rsReleaseTemporalOwner))dlsym(lib,"rsReleaseTemporalOwner");check(process&&release,"Temporal API missing");
    auto device=MTLCreateSystemDefaultDevice();check(device,"No Metal device");auto queue=[device newCommandQueue];
    constexpr unsigned w=64,h=48,ow=128,oh=96;
    auto texture=[&](MTLPixelFormat format,unsigned width,unsigned height,MTLTextureUsage usage,bool priv=false){
        auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];d.usage=usage;d.storageMode=priv?MTLStorageModePrivate:MTLStorageModeShared;return [device newTextureWithDescriptor:d];
    };
    auto descriptor=[MTLFXTemporalScalerDescriptor new];descriptor.inputWidth=w;descriptor.inputHeight=h;descriptor.outputWidth=ow;descriptor.outputHeight=oh;
    descriptor.colorTextureFormat=descriptor.outputTextureFormat=MTLPixelFormatRGBA16Float;descriptor.depthTextureFormat=MTLPixelFormatR32Float;descriptor.motionTextureFormat=MTLPixelFormatRG16Float;
    id<MTLFXTemporalScalerBase> scaler;
    if(metal4){
        if(@available(macOS 26.0,*)){
            if(![descriptor respondsToSelector:@selector(newTemporalScalerWithDevice:compiler:)]||![device respondsToSelector:@selector(newMTL4CommandQueue)]){
                unlink(argv[2]);fputs("Metal 4 temporal scaler interface unavailable\n",stderr);return 77;
            }
            NSError *error=nil;auto compiler=[device newCompilerWithDescriptor:[MTL4CompilerDescriptor new] error:&error];
            check(compiler,error.localizedDescription.UTF8String?:"Cannot create Metal 4 compiler");
            scaler=[descriptor newTemporalScalerWithDevice:device compiler:compiler];
            if(!scaler){unlink(argv[2]);fputs("Metal 4 temporal scaler unsupported by this device\n",stderr);return 77;}
        }else{unlink(argv[2]);fputs("Metal 4 temporal scaler requires macOS 26\n",stderr);return 77;}
    }else scaler=[descriptor newTemporalScalerWithDevice:device];
    check(scaler,"Cannot create application MetalFX scaler");
    auto color=texture(MTLPixelFormatRGBA16Float,w,h,scaler.colorTextureUsage),depth=texture(MTLPixelFormatR32Float,w,h,scaler.depthTextureUsage),motion=texture(MTLPixelFormatRG16Float,w,h,scaler.motionTextureUsage);
    auto output=texture(MTLPixelFormatRGBA16Float,ow,oh,scaler.outputTextureUsage,true);
    std::vector<_Float16> colors(w*h*4),motions(w*h*2,0);std::vector<float> depths(w*h,.5f);
    for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){auto i=(y*w+x)*4;colors[i]=.1f+float(x)/w*.6f;colors[i+1]=.15f+float(y)/h*.5f;colors[i+2]=(x%7<3)?.7f:.2f;colors[i+3]=1;}
    [color replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:colors.data() bytesPerRow:w*8];
    [depth replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:depths.data() bytesPerRow:w*4];
    [motion replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:motions.data() bytesPerRow:w*4];
    auto readback=[device newBufferWithLength:ow*oh*8 options:MTLResourceStorageModeShared];
    auto finish=[&](id<MTLCommandBuffer> cb){auto blit=[cb blitCommandEncoder];[blit copyFromTexture:output sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(ow,oh,1) toBuffer:readback destinationOffset:0 destinationBytesPerRow:ow*8 destinationBytesPerImage:ow*oh*8];[blit endEncoding];[cb commit];[cb waitUntilCompleted];check(!cb.error,cb.error.localizedDescription.UTF8String?:"GPU error");auto p=(const _Float16*)readback.contents;double sum=0;for(unsigned i=0;i<ow*oh;++i)for(unsigned c=0;c<3;++c){check(std::isfinite(float(p[i*4+c])),"Non-finite temporal output");sum+=float(p[i*4+c]);}check(sum>100&&sum<ow*oh*3,"Temporal output lost its signal");return sum;};
    scaler.colorTexture=color;scaler.depthTexture=depth;scaler.motionTexture=motion;scaler.outputTexture=output;scaler.preExposure=1;scaler.motionVectorScaleX=scaler.motionVectorScaleY=1;scaler.inputContentWidth=w;scaler.inputContentHeight=h;
    if(metal4){
        if(@available(macOS 26.0,*)){
            auto queue4=[device newMTL4CommandQueue];check(queue4,"Cannot create Metal 4 command queue");
            NSError *error=nil;auto residency=[device newResidencySetWithDescriptor:[MTLResidencySetDescriptor new] error:&error];
            check(residency,error.localizedDescription.UTF8String?:"Cannot create Metal 4 input residency set");
            for(id<MTLAllocation> resource in @[color,depth,motion,output])[residency addAllocation:resource];
            [residency commit];[queue4 addResidencySet:residency];
            std::vector<uint8_t> baseline(readback.length);unsigned index=0;
            for(const auto method:{0u,4u,1u,0u}){
                controls(method);auto allocator=[device newCommandAllocator];auto cb=[device newCommandBuffer];
                check(allocator&&cb,"Cannot allocate Metal 4 command buffer");[cb beginCommandBufferWithAllocator:allocator];
                // The application resets its initial frame only. Method switches must reset the captured history.
                scaler.reset=index==0;[(id<MTL4FXTemporalScaler>)scaler encodeToCommandBuffer:cb];[cb endCommandBuffer];
                auto completed=dispatch_semaphore_create(0);__block NSError *gpuError=nil;
                auto options=[MTL4CommitOptions new];[options addFeedbackHandler:^(id<MTL4CommitFeedback> feedback){gpuError=feedback.error;dispatch_semaphore_signal(completed);}];
                id<MTL4CommandBuffer> list[]={cb};[queue4 commit:list count:1 options:options];
                check(dispatch_semaphore_wait(completed,dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC))==0,"Metal 4 command queue did not complete");
                check(!gpuError,gpuError.localizedDescription.UTF8String?:"Metal 4 GPU error");
                const auto sum=finish([queue commandBuffer]);
                if(index==0)memcpy(baseline.data(),readback.contents,readback.length);
                else if(method==4)check(memcmp(baseline.data(),readback.contents,readback.length)!=0,"Metal 4 descriptor hook did not replace the original scaler");
                else check(memcmp(baseline.data(),readback.contents,readback.length)==0,"Metal 4 original scaler history did not reset on live switching");
                printf("metal4 live method=%u checksum=%.4f original-restored=%u\n",method,sum,index>1);++index;
            }
            [queue4 removeResidencySet:residency];unlink(argv[2]);puts("Metal 4 descriptor capture, FSR4 replacement and live restoration passed.");return 0;
        }
    }
    RSTemporalFrame f{};f.size=sizeof(f);f.version=1;f.owner=&f;f.method=RS_TEMPORAL_METALFX;f.color=(__bridge void*)color;f.depth=(__bridge void*)depth;f.motion=(__bridge void*)motion;f.output=(__bridge void*)output;
    f.renderWidth=f.maxRenderWidth=w;f.renderHeight=f.maxRenderHeight=h;f.outputWidth=ow;f.outputHeight=oh;f.motionScaleX=f.motionScaleY=f.preExposure=1;f.frameTimeMs=16.67;f.sharpness=.35;
    RSTemporalResult r{};r.size=sizeof(r);r.version=1;
    for(unsigned n=1;n<=3;++n){auto cb=[queue commandBuffer];f.commandBuffer=(__bridge void*)cb;f.frameId=n;f.jitterX=(n%2)?.25:-.25;f.jitterY=-f.jitterX;
        check(process(&f,&r)==RS_TEMPORAL_OK,r.reason);check(r.encoded&&(n!=1||r.reset),"Initial history was not reset");check(cb.status<MTLCommandBufferStatusCommitted,"Caller commands committed prematurely");
        check(process(&f,&r)==RS_TEMPORAL_BUSY,"Pending temporal work was not bounded");printf("explicit frame=%u checksum=%.4f\n",n,finish(cb));
    }
    f.frameId=5;auto invalid=[queue commandBuffer];f.commandBuffer=(__bridge void*)invalid;f.motion=nullptr;check(process(&f,&r)==RS_TEMPORAL_INVALID&&!r.encoded,"Missing motion was accepted");f.motion=(__bridge void*)motion;
    check(process(&f,&r)==RS_TEMPORAL_OK&&r.reset,"Skipped frame did not reset history");finish(invalid);
    @autoreleasepool{auto discarded=[queue commandBuffer];f.frameId=6;f.commandBuffer=(__bridge void*)discarded;check(process(&f,&r)==RS_TEMPORAL_OK,r.reason);release(&f);}
    auto resumed=[queue commandBuffer];f.frameId=7;f.commandBuffer=(__bridge void*)resumed;auto resumedStatus=process(&f,&r);
    for(unsigned retry=0;resumedStatus==RS_TEMPORAL_BUSY&&retry<100;++retry){std::this_thread::sleep_for(std::chrono::milliseconds(2));resumedStatus=process(&f,&r);}
    if(resumedStatus!=RS_TEMPORAL_OK||!r.reset)fprintf(stderr,"resume status=%u reset=%u reason=%s\n",resumedStatus,r.reset,r.reason);check(resumedStatus==RS_TEMPORAL_OK&&r.reset,"Discarded command buffer retained capacity or history");finish(resumed);release(&f);
    scaler.fence=[device newFence];
    for(const auto method:{0u,hasFSR4?4u:2u,1u,0u}){controls(method);auto cb=[queue commandBuffer];auto before=[cb blitCommandEncoder];[before updateFence:scaler.fence];[before endEncoding];scaler.reset=YES;[(id<MTLFXTemporalScaler>)scaler encodeToCommandBuffer:cb];auto after=[cb blitCommandEncoder];[after waitForFence:scaler.fence];[after endEncoding];check(cb.status<MTLCommandBufferStatusCommitted,"Hook committed application commands");printf("live method=%u checksum=%.4f\n",method,finish(cb));}
    unlink(argv[2]);puts("Native temporal API, renderer input capture, live switching and fallback passed.");return 0;
}}
