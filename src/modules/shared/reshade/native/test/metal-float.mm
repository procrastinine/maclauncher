// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "fixture-files.hpp"
#include "frame-capture.hpp"
#include "metal-frame-failure.hpp"
#include "frame.h"
#include "process-phase.hpp"
#include "retroarch.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>

namespace {
void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
// The frame API prepares a new spatial output off the frame path and answers
// RS_FRAME_BUSY without encoding; the host retries the same frame.
int processFrame(const RSFrameRequest &request,RSFrameResult &result){
    int code=RS_FRAME_BUSY;for(unsigned attempt=0;code==RS_FRAME_BUSY&&attempt<2000;++attempt){if(attempt)std::this_thread::sleep_for(std::chrono::milliseconds(1));result={};result.size=sizeof(result);result.version=RS_FRAME_ABI_VERSION;code=rsProcessFrame(&request,&result);}
    return code;
}
// Shader nodes prepare a new format transfer the same way and answer busy
// without encoding or advancing history; the presenter retries the frame.
macfx::ShaderResult encodeReady(const std::shared_ptr<macfx::ShaderNode> &node,const macfx::ShaderFrame &frame){
    auto result=node->encode(frame);for(unsigned attempt=0;!result.encoded&&result.busy&&attempt<2000;++attempt){std::this_thread::sleep_for(std::chrono::milliseconds(1));result=node->encode(frame);}
    return result;
}
struct Files {
    char directory[1024]{};bool owned=true;
    std::string effect,srgb,capture,trigger;
    // The capture phase uses the directory and shaders its parent created.
    explicit Files(const char *existing=nullptr){
        if(existing){owned=false;std::snprintf(directory,sizeof(directory),"%s",existing);}
        else require(mkdtemp(temporaryPath(directory,"maclauncher-metal-float-XXXXXX")),"Cannot create shader directory");
        effect=std::string(directory)+"/grayscale.fx";srgb=std::string(directory)+"/srgb.fx";
        capture=std::string(directory)+"/capture";trigger=std::string(directory)+"/capture.trigger";
        const std::string first=R"FX(
texture Source : COLOR;
sampler SourceSampler { Texture = Source; )FX";
        const std::string last=R"FX( };
void VS(uint id : SV_VertexID,out float4 position : SV_Position,out float2 uv : TEXCOORD0) {
    uv=float2((id<<1)&2,id&2);position=float4(uv*float2(2,-2)+float2(-1,1),0,1);
}
float4 PS(float4 position : SV_Position,float2 uv : TEXCOORD0) : SV_Target {
    float4 c=tex2D(SourceSampler,uv);float gray=dot(c.rgb,float3(0.2126,0.7152,0.0722));
    return float4(gray.xxx,c.a);
}
technique Grayscale { pass { VertexShader=VS; PixelShader=PS; } }
)FX";
        if(owned)for(const auto &file:{effect,srgb}){std::ofstream out(file);out<<first<<(file==srgb?"SRGBTexture = true;":"")<<last;require(out.good(),"Cannot write shader");}
    }
    // The trigger is admitted off the frame path within about 250 ms; the
    // next frame that captures then consumes exactly that request.
    void requestCapture(){
        {std::ofstream out(trigger);out<<"capture\n";require(out.good(),"Cannot request capture");}
        for(unsigned attempt=0;attempt<200&&!macfx::FrameCapture::pending(0);++attempt)std::this_thread::sleep_for(std::chrono::milliseconds(10));
        require(macfx::FrameCapture::pending(0)&&!std::filesystem::exists(trigger),"The capture request was not admitted");
    }
    ~Files(){std::error_code ignored;if(owned)std::filesystem::remove_all(directory,ignored);}
};
using Pixel=std::array<_Float16,4>;
Pixel pixel(unsigned x,unsigned y,unsigned width,unsigned height){
    // Distinct quadrants expose orientation, floating range and alpha changes.
    const Pixel values[]={{{2,.5,-1,.25}},{{.25,.5,4,.5}},{{-2,.25,.5,.75}},{{1,2,.25,1}}};
    return values[(y>=height/2?2:0)+(x>=width/2?1:0)];
}
id<MTLTexture> image(id<MTLDevice>device,unsigned width,unsigned height,MTLPixelFormat format=MTLPixelFormatRGBA16Float,bool shaderWrite=false){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
    if(shaderWrite)descriptor.usage|=MTLTextureUsageShaderWrite;
    auto texture=[device newTextureWithDescriptor:descriptor];require(texture!=nil,"Cannot allocate shader image");return texture;
}
std::vector<Pixel> upload(id<MTLTexture>input){
    std::vector<Pixel> values(input.width*input.height);
    for(unsigned y=0;y<input.height;++y)for(unsigned x=0;x<input.width;++x)values[y*input.width+x]=pixel(x,y,input.width,input.height);
    [input replaceRegion:MTLRegionMake2D(0,0,input.width,input.height) mipmapLevel:0 withBytes:values.data() bytesPerRow:input.width*sizeof(Pixel)];return values;
}
void verify(id<MTLTexture>input,id<MTLTexture>output,const std::vector<Pixel>&source){
    std::vector<Pixel> actual(source.size()),unchanged(source.size());
    [output getBytes:actual.data() bytesPerRow:output.width*sizeof(Pixel) fromRegion:MTLRegionMake2D(0,0,output.width,output.height) mipmapLevel:0];
    [input getBytes:unchanged.data() bytesPerRow:input.width*sizeof(Pixel) fromRegion:MTLRegionMake2D(0,0,input.width,input.height) mipmapLevel:0];
    require(unchanged==source,"Shader modified source pixels");
    bool negative=false,extended=false;
    for(size_t i=0;i<source.size();++i){
        const float expected=float(source[i][0])*.2126f+float(source[i][1])*.7152f+float(source[i][2])*.0722f;
        for(unsigned c=0;c<3;++c)require(std::abs(float(actual[i][c])-expected)<.003f,"FP16 grayscale, orientation or range changed");
        require(actual[i][3]==source[i][3],"Transparent publisher alpha changed");
        negative|=actual[i][0]<0;extended|=actual[i][0]>1;
    }
    require(negative&&extended,"Floating-point output was clamped to SDR");
}
void complete(id<MTLCommandBuffer>commands){
    require(commands.status<MTLCommandBufferStatusCommitted,"Shader submitted caller commands");
    [commands commit];[commands waitUntilCompleted];require(commands.status==MTLCommandBufferStatusCompleted,"Shader GPU work failed");
}
std::vector<uint32_t> uploadTenBit(id<MTLTexture> input,bool bgr){
    const std::array<unsigned,4> colors[]={{{900,73,301,0}},{{73,901,145,1}},{{200,367,1000,2}},{{1023,551,20,3}}};
    std::vector<uint32_t> pixels(input.width*input.height);
    for(unsigned y=0;y<input.height;++y)for(unsigned x=0;x<input.width;++x){
        const auto &c=colors[(y>=input.height/2?2:0)+(x>=input.width/2?1:0)];
        pixels[y*input.width+x]=c[bgr?2:0]|(c[1]<<10)|(c[bgr?0:2]<<20)|(c[3]<<30);
    }
    [input replaceRegion:MTLRegionMake2D(0,0,input.width,input.height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:input.width*4];return pixels;
}
void verifyTenBit(id<MTLTexture> input,id<MTLTexture> output,const std::vector<uint32_t>&source,bool bgr){
    std::vector<uint32_t> actual(source.size()),unchanged(source.size());
    [output getBytes:actual.data() bytesPerRow:output.width*4 fromRegion:MTLRegionMake2D(0,0,output.width,output.height) mipmapLevel:0];
    [input getBytes:unchanged.data() bytesPerRow:input.width*4 fromRegion:MTLRegionMake2D(0,0,input.width,input.height) mipmapLevel:0];
    require(unchanged==source,"10-bit shader modified its source");
    for(size_t i=0;i<source.size();++i){
        const auto value=source[i];const float red=(value>>(bgr?20:0))&1023,green=(value>>10)&1023,blue=(value>>(bgr?0:20))&1023;
        const int gray=std::lround(red*.2126f+green*.7152f+blue*.0722f);
        for(unsigned shift:{0u,10u,20u})require(std::abs(int((actual[i]>>shift)&1023)-gray)<=2,"10-bit channels, grayscale or orientation changed");
        require((actual[i]>>30)==(value>>30),"Two-bit publisher alpha changed");
    }
}
using BytePixel=std::array<unsigned char,4>;
BytePixel storedPixel(BytePixel logical,bool bgr){return bgr?BytePixel{logical[2],logical[1],logical[0],logical[3]}:logical;}
std::vector<BytePixel> readBytes(id<MTLTexture> texture){
    std::vector<BytePixel> pixels(texture.width*texture.height);
    [texture getBytes:pixels.data() bytesPerRow:texture.width*sizeof(BytePixel) fromRegion:MTLRegionMake2D(0,0,texture.width,texture.height) mipmapLevel:0];return pixels;
}
std::vector<BytePixel> historyPixels(unsigned frame){
    const BytePixel colors[]={{223,17,71,41},{41,193,13,109},{5,67,241,187},{151,109,29,233}};
    std::vector<BytePixel> pixels(64);
    for(unsigned y=0;y<8;++y)for(unsigned x=0;x<8;++x)pixels[y*8+x]=colors[((y>=4?2:0)+(x>=4?1:0)+frame)%4];return pixels;
}
int retroarchHistory(const char *preset,const char *provider){
    const auto host=std::getenv("RESHADE_EXPLICIT_HOST");require(host&&std::strcmp(host,"1")==0,"RetroArch history control requires RESHADE_EXPLICIT_HOST=1 at process startup");
    for(const auto name:{"RESHADE_EFFECT_PLAN","RESHADE_LIVE_EFFECTS","RESHADE_LIVE_CONFIG","RESHADE_PREPARED_EFFECT","RESHADE_TECHNIQUE","RESHADE_EFFECT_PLACEMENT","RESHADE_EFFECT","RESHADE_CONTROL_FILE","RESHADE_CAPTURE_PREFIX","RESHADE_CAPTURE_TRIGGER"})unsetenv(name);
    setenv("RESHADE_LIBRASHADER",provider,1);
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal device or queue unavailable");
    const std::array<MTLPixelFormat,2> pairs[]={{{MTLPixelFormatBGRA8Unorm,MTLPixelFormatBGRA8Unorm}},{{MTLPixelFormatRGBA8Unorm,MTLPixelFormatRGBA8Unorm}},{{MTLPixelFormatBGRA8Unorm,MTLPixelFormatRGBA8Unorm}},{{MTLPixelFormatRGBA8Unorm,MTLPixelFormatBGRA8Unorm}}};
    for(const auto &formats:pairs){
        const bool sourceBGR=formats[0]==MTLPixelFormatBGRA8Unorm,targetBGR=formats[1]==MTLPixelFormatBGRA8Unorm;
        const auto sourceName=sourceBGR?"BGRA8":"RGBA8",targetName=targetBGR?"BGRA8":"RGBA8";
        std::printf("linked factory RetroArch history device=%s source=%s target=%s 8x8 TopLeft transparent; no window\n",device.name.UTF8String,sourceName,targetName);std::fflush(stdout);
        macfx::ShaderSpec spec;spec.selection.file=preset;spec.selection.key=std::string(64,'a');spec.selection.revision=std::string(64,'b');
        auto node=macfx::makeShaderNode(spec);require(bool(node),"Cannot create RetroArch shader node");
        NSMutableArray<id<MTLTexture>> *sources=[NSMutableArray new];std::vector<std::vector<BytePixel>> snapshots;std::vector<BytePixel> previous;
        for(unsigned index=0;index<3;++index){
            auto input=image(device,8,8,formats[0]),output=image(device,8,8,formats[1]);
            auto logical=historyPixels(index),stored=logical;for(auto &pixel:stored)pixel=storedPixel(pixel,sourceBGR);
            [input replaceRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0 withBytes:stored.data() bytesPerRow:8*sizeof(BytePixel)];
            [sources addObject:input];snapshots.push_back(stored);
            auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};frame.frameId=index+1;frame.timeMs=(index+1)*16.666667;frame.opaqueDisplay=false;
            const auto ready=node->prepare(frame);require(ready.encoded,ready.reason.c_str());require(commands.status<MTLCommandBufferStatusCommitted,"RetroArch preparation submitted caller commands");
            const auto encoded=encodeReady(node,frame);require(encoded.encoded,encoded.reason.c_str());complete(commands);
            for(unsigned held=0;held<snapshots.size();++held)require(readBytes(sources[held])==snapshots[held],"RetroArch shader modified immutable source pixels");
            if(index){
                auto actual=readBytes(output);for(auto &pixel:actual)pixel=storedPixel(pixel,targetBGR);
                for(unsigned i=0;i<actual.size();++i)for(unsigned component=0;component<4;++component)if(std::abs(int(actual[i][component])-int(previous[i][component]))>1){
                    const auto a=actual[i],e=previous[i];std::fprintf(stderr,"RetroArch %s->%s frame%u pixel(%u,%u) RGBA=%u,%u,%u,%u expected previous=%u,%u,%u,%u\n",sourceName,targetName,index+1,i%8,i/8,a[0],a[1],a[2],a[3],e[0],e[1],e[2],e[3]);
                    throw std::runtime_error("RetroArch previous-frame channels, orientation or alpha changed");
                }
            }
            previous=std::move(logical);
        }
        std::printf("RetroArch %s->%s: three serial frames preserved prior-frame colors, quadrant orientation, alpha, immutable sources and caller submission\n",sourceName,targetName);
    }
    return 0;
}
PFN_libra_mtl_filter_chain_frame queueFrame=nullptr;
__weak id<MTLCommandBuffer> pausedQueueCommands=nil;
id<MTLSharedEvent> queueEvent=nil;
unsigned queueFrames=0,queuePauses=0;
uintptr_t queueInputs[2]{},queueOutputs[2]{};
libra_error_t observedQueueFrame(libra_mtl_filter_chain_t *chain,id<MTLCommandBuffer>commands,size_t frameId,id<MTLTexture>input,id<MTLTexture>output,const libra_viewport_t *viewport,const float *mvp,const frame_mtl_opt_t *options){
    const auto index=queueFrames++;require(index<2,"Unexpected provider frame in queue control");
    queueInputs[index]=reinterpret_cast<uintptr_t>((__bridge void*)input);queueOutputs[index]=reinterpret_cast<uintptr_t>((__bridge void*)output);
    std::fprintf(stderr,"queue provider frame=%u id=%zu chain=%p queue=%p input=%p inputParent=%p output=%p outputParent=%p\n",index+1,frameId,reinterpret_cast<void*>(*chain),(__bridge void*)commands.commandQueue,(__bridge void*)input,(__bridge void*)input.parentTexture,(__bridge void*)output,(__bridge void*)output.parentTexture);
    if(commands==pausedQueueCommands){++queuePauses;[commands encodeSignalEvent:queueEvent value:1];[commands encodeWaitForEvent:queueEvent value:2];}
    return queueFrame(chain,commands,frameId,input,output,viewport,mvp,options);
}
void waitQueue(dispatch_semaphore_t done,const char *reason){require(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))==0,reason);}
// The selected effect is a launch setting: the queue check runs as a phase.
int retroarchQueue(const char *preset,const char *provider,bool phase){
    const auto host=std::getenv("RESHADE_EXPLICIT_HOST");require(host&&std::strcmp(host,"1")==0,"RetroArch queue control requires RESHADE_EXPLICIT_HOST=1 at process startup");
    if(!phase)return fixture::runPhase("retroarch-queue",{{"RESHADE_EFFECT_PLAN",nullptr},{"RESHADE_LIVE_EFFECTS",nullptr},{"RESHADE_LIVE_CONFIG",nullptr},{"RESHADE_PREPARED_EFFECT",nullptr},
        {"RESHADE_TECHNIQUE",nullptr},{"RESHADE_EFFECT_PLACEMENT",nullptr},{"RESHADE_CONTROL_FILE",nullptr},{"RESHADE_CAPTURE_PREFIX",nullptr},{"RESHADE_CAPTURE_TRIGGER",nullptr},
        {"RESHADE_LIBRASHADER",provider},{"RESHADE_EFFECT",preset},{"RESHADE_EFFECT_KEY",std::string(64,'a').c_str()}},{"--retroarch-queue",preset,provider});
    auto device=MTLCreateSystemDefaultDevice();auto first=[device newCommandQueue],second=[device newCommandQueue];require(device&&first&&second&&first!=second,"Distinct Metal queues unavailable");
    auto inputA=image(device,8,8,MTLPixelFormatBGRA8Unorm),inputB=image(device,8,8,MTLPixelFormatBGRA8Unorm);
    auto outputA=image(device,8,8,MTLPixelFormatBGRA8Unorm),outputB=image(device,8,8,MTLPixelFormatBGRA8Unorm);
    const std::vector<BytePixel> red(64,storedPixel({255,0,0,255},true)),blue(64,storedPixel({0,0,255,255},true));
    [inputA replaceRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0 withBytes:red.data() bytesPerRow:32];
    [inputB replaceRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0 withBytes:blue.data() bytesPerRow:32];
    // Load the actual core API through its normal factory without encoding a
    // warm frame. Access its exported singleton storage, never a fixture copy.
    macfx::ShaderSpec spec;spec.selection.file=preset;auto warm=macfx::makeShaderNode(spec);
    auto warmCommands=[first commandBuffer];const auto ready=warm->prepare({warmCommands,inputA,outputA});require(ready.encoded,ready.reason.c_str());require(warmCommands.status==MTLCommandBufferStatusNotEnqueued,"Warm preparation submitted caller commands");
    Dl_info coreInfo{};require(dladdr(reinterpret_cast<const void*>(&rsProcessFrame),&coreInfo)&&coreInfo.dli_fname,"Cannot resolve actual processor core");
    void *core=dlopen(coreInfo.dli_fname,RTLD_NOW|RTLD_NOLOAD);require(core,"Processor core is not already loaded");
    auto storage=static_cast<macfx::RetroarchAPI**>(dlsym(core,"_ZZN5macfx12RetroarchAPI8instanceEvE3api"));
    require(storage&&*storage,"Actual processor RetroArch singleton unavailable");auto &api=**storage;
    Dl_info providerInfo{};require(dladdr(reinterpret_cast<const void*>(api.frame),&providerInfo)&&providerInfo.dli_fname&&std::filesystem::equivalent(providerInfo.dli_fname,provider),"Processor frame function differs from the selected real provider");
    std::fprintf(stderr,"queue core=%s singletonStorage=%p singleton=%p provider=%s\n",coreInfo.dli_fname,storage,*storage,providerInfo.dli_fname);
    queueFrame=api.frame;api.frame=observedQueueFrame;
    struct RestoreAPI {macfx::RetroarchAPI &api;void *core;~RestoreAPI(){api.frame=queueFrame;queueFrame=nullptr;pausedQueueCommands=nil;queueEvent=nil;dlclose(core);}} restore{api,core};
    queueFrames=queuePauses=0;queueEvent=[device newSharedEvent];require(queueEvent,"Metal shared event unavailable");
    struct ReleaseEvent {id<MTLSharedEvent> event;~ReleaseEvent(){event.signaledValue=2;}} release{queueEvent};
    auto listener=[[MTLSharedEventListener alloc]initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];require(listener,"Shared event listener unavailable");
    auto copied=dispatch_semaphore_create(0),doneA=dispatch_semaphore_create(0),doneB=dispatch_semaphore_create(0);
    [queueEvent notifyListener:listener atValue:1 block:^(id<MTLSharedEvent>,uint64_t){dispatch_semaphore_signal(copied);}];
    int owner=0;
    struct ReleaseOwner {void *owner;~ReleaseOwner(){queueEvent.signaledValue=2;rsReleaseFrameOwner(owner);}} releaseOwner{&owner};
    const auto encode=[&](id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,uint64_t frameId){
        RSFrameRequest request{sizeof(RSFrameRequest),RS_FRAME_ABI_VERSION,&owner,(__bridge void*)commands,(__bridge void*)source,(__bridge void*)target,frameId,RS_FRAME_NEAREST,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};
        RSFrameResult result{};result.size=sizeof(result);result.version=RS_FRAME_ABI_VERSION;
        const auto code=processFrame(request,result);require(code==RS_FRAME_OK&&result.encoded&&result.effects,result.reason);
        require(commands.status<MTLCommandBufferStatusCommitted,"Processor submitted caller commands");
    };
    auto a=[first commandBuffer];pausedQueueCommands=a;[a addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(doneA);}];
    encode(a,inputA,outputA,1);[a commit];waitQueue(copied,"Queue A input blit did not reach its GPU signal");
    auto b=[second commandBuffer];[b addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(doneB);}];
    encode(b,inputB,outputB,2);[b commit];waitQueue(doneB,"Queue B did not complete while A was paused");require(b.status==MTLCommandBufferStatusCompleted,"Queue B GPU work failed");
    queueEvent.signaledValue=2;waitQueue(doneA,"Queue A did not complete after release");require(a.status==MTLCommandBufferStatusCompleted,"Queue A GPU work failed");
    require(queueFrames==2&&queuePauses==1,"Actual provider did not receive exactly two frames and one GPU pause");
    require(readBytes(inputA)==red&&readBytes(inputB)==blue,"Queue control modified immutable source images");
    const auto actualA=readBytes(outputA),actualB=readBytes(outputB);const auto firstA=storedPixel(actualA.front(),true),firstB=storedPixel(actualB.front(),true);
    std::printf("queue A RGBA=%u,%u,%u,%u expected=255,0,0,255; queue B RGBA=%u,%u,%u,%u expected=0,0,255,255; private inputs same=%d outputs same=%d\n",firstA[0],firstA[1],firstA[2],firstA[3],firstB[0],firstB[1],firstB[2],firstB[3],queueInputs[0]==queueInputs[1],queueOutputs[0]==queueOutputs[1]);std::fflush(stdout);
    require(actualA==red&&actualB==blue,"Same-owner queue switch overwrote a paused frame's working images");
    require(queueInputs[0]!=queueInputs[1]&&queueOutputs[0]!=queueOutputs[1],"Same-owner queue switch retained shared working images");
    std::puts("Actual rsProcessFrame queue boundary preserved both frames and immutable sources using separate working images");return 0;
}
int pureScalerQueue(){
    const auto host=std::getenv("RESHADE_EXPLICIT_HOST");require(host&&std::strcmp(host,"1")==0,"Pure scaler queue control requires RESHADE_EXPLICIT_HOST=1 at process startup");
    for(const auto name:{"RESHADE_EFFECT_PLAN","RESHADE_LIVE_EFFECTS","RESHADE_LIVE_CONFIG","RESHADE_PREPARED_EFFECT","RESHADE_TECHNIQUE","RESHADE_EFFECT_PLACEMENT","RESHADE_EFFECT","RESHADE_CONTROL_FILE","RESHADE_CAPTURE_PREFIX","RESHADE_CAPTURE_TRIGGER"})unsetenv(name);
    auto device=MTLCreateSystemDefaultDevice();auto first=[device newCommandQueue],second=[device newCommandQueue];require(device&&first&&second&&first!=second,"Distinct Metal queues unavailable");
    auto event=[device newSharedEvent];require(event,"Metal shared event unavailable");
    auto listener=[[MTLSharedEventListener alloc]initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];require(listener,"Shared event listener unavailable");
    auto copied=dispatch_semaphore_create(0),doneA=dispatch_semaphore_create(0),doneB=dispatch_semaphore_create(0);
    [event notifyListener:listener atValue:1 block:^(id<MTLSharedEvent>,uint64_t){dispatch_semaphore_signal(copied);}];
    int owner=0;struct ReleaseOwner {void *owner;id<MTLSharedEvent> event;~ReleaseOwner(){event.signaledValue=2;rsReleaseFrameOwner(owner);}} release{&owner,event};
    constexpr unsigned width=32,height=24;
    const BytePixel colors[]={{217,29,71,255},{37,181,13,255},{7,83,229,255},{151,109,23,255}};
    const auto upload=[&](id<MTLTexture> texture,unsigned frame){
        std::vector<BytePixel> pixels(width*height);
        for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x)pixels[y*width+x]=storedPixel(colors[((y>=height/2?2:0)+(x>=width/2?1:0)+frame)%4],true);
        [texture replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:width*sizeof(BytePixel)];return pixels;
    };
    auto inputA=image(device,width,height,MTLPixelFormatBGRA8Unorm),inputB=image(device,width,height,MTLPixelFormatBGRA8Unorm);
    auto outputA=image(device,width*2,height*2,MTLPixelFormatBGRA8Unorm,true),outputB=image(device,width*2,height*2,MTLPixelFormatBGRA8Unorm,true);
    const auto sourceA=upload(inputA,0),sourceB=upload(inputB,1);
    const auto encode=[&](id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,uint64_t frameId){
        RSFrameRequest request{sizeof(RSFrameRequest),RS_FRAME_ABI_VERSION,&owner,(__bridge void*)commands,(__bridge void*)source,(__bridge void*)target,frameId,RS_FRAME_METALFX,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};
        RSFrameResult result{};result.size=sizeof(result);result.version=RS_FRAME_ABI_VERSION;
        const auto code=processFrame(request,result);require(code==RS_FRAME_OK&&result.encoded,result.reason);
        require(result.effects==0&&result.scaled&&result.activeMethod==RS_FRAME_METALFX,"Pure scaler did not use MetalFX with effects off");
        require(result.inputWidth==width&&result.inputHeight==height&&result.outputWidth==width*2&&result.outputHeight==height*2,"Pure scaler reported incorrect image dimensions");
        require(commands.status<MTLCommandBufferStatusCommitted,"Pure scaler submitted caller commands");
    };
    auto a=[first commandBuffer];[a encodeSignalEvent:event value:1];[a encodeWaitForEvent:event value:2];
    [a addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(doneA);}];encode(a,inputA,outputA,1);[a commit];waitQueue(copied,"Pure scaler A did not reach its GPU pause");
    auto b=[second commandBuffer];[b addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(doneB);}];encode(b,inputB,outputB,2);[b commit];waitQueue(doneB,"Pure scaler B did not complete while A was paused");require(b.status==MTLCommandBufferStatusCompleted,"Pure scaler B GPU work failed");
    event.signaledValue=2;waitQueue(doneA,"Pure scaler A did not complete after release");require(a.status==MTLCommandBufferStatusCompleted,"Pure scaler A GPU work failed");
    require(readBytes(inputA)==sourceA&&readBytes(inputB)==sourceB,"Pure scaler changed immutable sources");
    const auto verify=[&](id<MTLTexture>texture,unsigned frame){
        const auto pixels=readBytes(texture);
        for(unsigned quadrant=0;quadrant<4;++quadrant){
            const auto x=unsigned(texture.width)*(quadrant%2?3:1)/4,y=unsigned(texture.height)*(quadrant/2?3:1)/4;
            const auto actual=storedPixel(pixels[y*texture.width+x],true),expected=colors[(quadrant+frame)%4];
            std::printf("pure MetalFX queue%c quadrant%u RGBA=%u,%u,%u,%u expected=%u,%u,%u,%u\n",frame?'B':'A',quadrant,actual[0],actual[1],actual[2],actual[3],expected[0],expected[1],expected[2],expected[3]);
            for(unsigned c=0;c<4;++c)require(std::abs(int(actual[c])-int(expected[c]))<=4,"Pure scaler queue switch changed quadrant pixels or opaque alpha");
        }
    };
    verify(outputA,0);verify(outputB,1);
    std::puts("Pure MetalFX 2x: effects off, same owner across two queues, actual completion, quadrant orientation, opaque alpha and immutable sources preserved");return 0;
}
}
int main(int argc,char **argv){@autoreleasepool{try{
    const auto phase=fixture::phase(argc,argv);argc=phase.argc;argv=phase.argv;
    if(argc==2&&std::strcmp(argv[1],"--pure-scaler-queue")==0)return pureScalerQueue();
    if(argc>1&&std::strcmp(argv[1],"--capture")){require(argc==4,"Usage: metal-float <--retroarch-history|--retroarch-queue> <preset.slangp> <librashader.dylib>");if(std::strcmp(argv[1],"--retroarch-history")==0)return retroarchHistory(argv[2],argv[3]);require(std::strcmp(argv[1],"--retroarch-queue")==0,"Unknown metal-float control");return retroarchQueue(argv[2],argv[3],!phase.name.empty());}
    static_assert(sizeof(Pixel)==8,"FP16 fixture must use eight bytes per pixel");
    // The effect and capture settings are launch settings: the checks run as a phase.
    if(phase.name.empty()){
        Files files;
        return fixture::runPhase("capture",{{"RESHADE_EFFECT_PLAN",nullptr},{"RESHADE_LIVE_EFFECTS",nullptr},{"RESHADE_LIVE_CONFIG",nullptr},{"RESHADE_PREPARED_EFFECT",nullptr},
            {"RESHADE_TECHNIQUE",nullptr},{"RESHADE_EFFECT_PLACEMENT",nullptr},{"RESHADE_EFFECT",files.effect.c_str()},{"RESHADE_CAPTURE_PREFIX",files.capture.c_str()},
            {"RESHADE_CAPTURE_TRIGGER",files.trigger.c_str()}},{"--capture",files.directory});
    }
    require(argc==3,"Usage: metal-float");Files files(argv[2]);
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal device or queue unavailable");
    macfx::ShaderSpec spec;spec.selection.file=files.effect;auto node=macfx::makeShaderNode(spec);
    for(const auto size:{std::array<unsigned,2>{35,19},std::array<unsigned,2>{11,7}}){
        auto input=image(device,size[0],size[1]),output=image(device,size[0],size[1]);const auto source=upload(input);
        auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};frame.opaqueDisplay=false;
        const auto prepared=node->prepare(frame);require(prepared.encoded,prepared.reason.c_str());
        const auto encoded=node->encode(frame);require(encoded.encoded,encoded.reason.c_str());complete(commands);verify(input,output,source);
    }
    auto input=image(device,35,19),output=image(device,35,19);const auto source=upload(input);
    // Failure admission is a CPU policy, separate from automatic AppKit ingress.
    // Repeated rejected frames admit no compiler work, while actual format or
    // extent changes admit one fresh attempt rather than retaining a bool latch.
    macfx::MetalFrameFailure failure;unsigned attempts=0;
    auto attempt=[&](id<MTLTexture> value){if(failure.blocks(value))return false;++attempts;failure.reject(value);return true;};
    require(attempt(input)&&!attempt(input)&&!attempt(input)&&attempts==1,"Unchanged rejected image admitted repeated work");
    auto packedKey=image(device,35,19,MTLPixelFormatRGB10A2Unorm);
    require(attempt(packedKey)&&!attempt(packedKey)&&attempts==2,"Changed format did not admit exactly one retry");
    auto resizedKey=image(device,11,7,MTLPixelFormatRGB10A2Unorm);
    require(attempt(resizedKey)&&!attempt(resizedKey)&&attempts==3,"Changed extent did not admit exactly one retry");
    failure.clear();require(attempt(resizedKey)&&attempts==4,"Explicit failure reset did not admit work");

    // Exercise the actual shader runtime on the same node: an unsupported
    // readable32-bit source fails before encoding, then supported FP16 recovers.
    auto wideDescriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA32Float width:35 height:19 mipmapped:NO];
    wideDescriptor.storageMode=MTLStorageModeShared;wideDescriptor.usage=MTLTextureUsageShaderRead;
    auto unsupportedImage=[device newTextureWithDescriptor:wideDescriptor];require(unsupportedImage!=nil,"Cannot allocate readable unsupported-format source");
    auto rejectedCommands=[queue commandBuffer];macfx::ShaderFrame rejectedFrame{rejectedCommands,unsupportedImage,output};rejectedFrame.opaqueDisplay=false;
    const auto rejected=node->prepare(rejectedFrame);require(!rejected.encoded,"Unsupported shader source format was silently converted");
    const auto rejectedEncoding=node->encode(rejectedFrame);require(!rejectedEncoding.encoded&&rejectedCommands.status<MTLCommandBufferStatusCommitted,"Rejected shader consumed caller submission");
    auto recoveredCommands=[queue commandBuffer];macfx::ShaderFrame recoveredFrame{recoveredCommands,input,output};recoveredFrame.opaqueDisplay=false;
    const auto recovered=node->encode(recoveredFrame);require(recovered.encoded,recovered.reason.c_str());complete(recoveredCommands);verify(input,output,source);
    spec.selection.file=files.srgb;auto srgb=macfx::makeShaderNode(spec);auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};frame.opaqueDisplay=false;
    const auto unsupported=srgb->prepare(frame);require(!unsupported.encoded&&unsupported.reason.find("sRGB")!=std::string::npos,"FP16 hardware sRGB requirement was silently changed");
    require(commands.status<MTLCommandBufferStatusCommitted,"Rejected shader submitted commands");

    // Ordered capture already declines FP16. Exercise the actual legacy path
    // too: width35 requires280 bytes/row, exceeding its old256-byte buffer row.
    files.requestCapture();require(!macfx::FrameCapture::begin(commands,input,1),"PNG capture accepted FP16 byte storage");
    require(!std::filesystem::exists(files.trigger),"Unsupported capture did not consume its request");
    files.requestCapture();int owner=0;commands=[queue commandBuffer];
    const auto encoded=macfx::processFrameWithDepth(&owner,commands,{input,output,1,macfx::SpatialColor::Linear,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,false);
    require(encoded.encoded&&encoded.effects&&!encoded.scaled,encoded.reason.c_str());complete(commands);verify(input,output,source);
    require(!std::filesystem::exists(files.trigger)&&!std::filesystem::exists(files.capture+"-before.png")&&!std::filesystem::exists(files.capture+"-after.png"),"Unsupported FP16 PNG capture published a false byte image");

    for(auto format:{MTLPixelFormatRGB10A2Unorm,MTLPixelFormatBGR10A2Unorm}){
        const bool bgr=format==MTLPixelFormatBGR10A2Unorm;
        auto packed=image(device,35,19,format),filtered=image(device,35,19,format);const auto pixels=uploadTenBit(packed,bgr);
        files.requestCapture();commands=[queue commandBuffer];
        const auto ten=macfx::processFrameWithDepth(&owner,commands,{packed,filtered,2,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,false);
        require(ten.encoded&&ten.effects&&!ten.scaled,ten.reason.c_str());complete(commands);verifyTenBit(packed,filtered,pixels,bgr);
        require(!std::filesystem::exists(files.trigger)&&!std::filesystem::exists(files.capture+"-before.png")&&!std::filesystem::exists(files.capture+"-after.png"),"Packed10-bit capture was misread as RGBA8 bytes");
    }

    // The same owner may later receive ordinary 8-bit content. Keep its actual
    // format switch and supported PNG capture working rather than disabling
    // capture or effects for the entire owner after an FP16 request.
    auto input8=image(device,35,19,MTLPixelFormatRGBA8Unorm),output8=image(device,35,19,MTLPixelFormatRGBA8Unorm);
    std::vector<std::array<unsigned char,4>> bytes(35*19,{204,51,102,82});
    [input8 replaceRegion:MTLRegionMake2D(0,0,35,19) mipmapLevel:0 withBytes:bytes.data() bytesPerRow:35*4];
    files.requestCapture();commands=[queue commandBuffer];
    const auto eight=macfx::processFrameWithDepth(&owner,commands,{input8,output8,2,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,false);
    require(eight.encoded&&eight.effects&&!eight.scaled,eight.reason.c_str());
    auto completed=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(completed);}];
    complete(commands);require(dispatch_semaphore_wait(completed,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0,"8-bit capture completion timed out");
    require(std::filesystem::exists(files.capture+"-before.png")&&std::filesystem::exists(files.capture+"-after.png"),"Supported 8-bit PNG capture was lost");
    std::vector<std::array<unsigned char,4>> actual8(bytes.size()),source8(bytes.size());
    [output8 getBytes:actual8.data() bytesPerRow:35*4 fromRegion:MTLRegionMake2D(0,0,35,19) mipmapLevel:0];
    [input8 getBytes:source8.data() bytesPerRow:35*4 fromRegion:MTLRegionMake2D(0,0,35,19) mipmapLevel:0];
    require(source8==bytes,"8-bit format switch modified source");
    for(const auto &p:actual8)require(std::abs(int(p[0])-87)<=1&&p[0]==p[1]&&p[1]==p[2]&&p[3]==82,"8-bit format switch changed shader output or alpha");
    macfx::releaseFrameOwner(&owner);
    puts("FP16 and normalized10-bit FX: grayscale, range, channel order, alpha, source, resize, caller submission and supported8-bit capture preserved; unsupported sRGB/PNG capture rejected safely");return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
