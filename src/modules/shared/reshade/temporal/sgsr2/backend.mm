#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <simd/simd.h>
#include "../frame.h"
#include "../command-order.hpp"
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
extern "C" const RSTemporalProvider *rsGetTemporalProvider(uint32_t);
namespace {
using simd::uint2;using simd::float2;using simd::float4;
struct alignas(16) Params {
    uint2 renderSize,displaySize;float2 renderSizeRcp,displaySizeRcp,jitterOffset;
    float4 clipToPrevClip[4]{};
    float preExposure,cameraFovAngleHor,cameraNear,minLerpContribution;
    uint32_t sameCamera=0,reset;
};
static_assert(offsetof(Params,preExposure)==112&&offsetof(Params,reset)==132&&sizeof(Params)==144);
struct Ingress {uint2 colorOffset,depthOffset,motionOffset,render,motionSize;float2 motionScale,jitterCancellation;uint32_t reversed;};
struct Output {uint2 outputOffset,outputSize;};
struct Binding {std::string name,kind;NSUInteger slot;};
struct Pipeline {id<MTLComputePipelineState> state;std::vector<Binding> bindings;MTLSize threads;};
struct Programs {id<MTLDevice> device;Pipeline convert,upscale;id<MTLComputePipelineState> ingress,output,clear;id<MTLSamplerState> sampler;};
struct Context {
    id<MTLDevice> device;std::shared_ptr<Programs> programs;std::mutex mutex;
    std::array<id<MTLTexture>,2> history;
    id<MTLTexture> color,depth,motion,motionDepth,ycocg,scene;
    std::array<uint32_t,4> extent{};uint32_t historyIndex=0;uint64_t lastFrame=0;
    float2 lastJitter{};float lastPreExposure=1;std::atomic<uint32_t> outstanding{0};std::atomic<bool> failed{false};
    __weak id<MTLCommandBuffer> tail;
};
struct Lease {
    std::shared_ptr<Context> context;bool completed=false;
    void retire(bool success){if(completed)return;completed=true;if(!success)context->failed.store(true,std::memory_order_release);context->outstanding.fetch_sub(1,std::memory_order_acq_rel);}
    ~Lease(){retire(false);}
};
std::mutex ownersMutex,programsMutex;
std::unordered_map<void*,std::shared_ptr<Context>> owners;
std::map<std::pair<void*,std::string>,std::weak_ptr<Programs>> programCache;
int answer(RSTemporalResult *r,int status,const std::string &reason,bool encoded=false,bool reset=false){if(r){r->status=status;r->method=RS_TEMPORAL_SGSR2;r->encoded=encoded;r->reset=reset;std::snprintf(r->reason,sizeof(r->reason),"%s",reason.c_str());}return status;}
std::string message(NSError *error){return error.localizedDescription.UTF8String?:"Metal resource preparation failed";}
std::string rootDirectory(){if(const auto explicitRoot=getenv("RESHADE_SGSR2_SHADER_DIRECTORY");explicitRoot&&*explicitRoot)return explicitRoot;Dl_info info{};if(!dladdr(reinterpret_cast<void*>(&rsGetTemporalProvider),&info)||!info.dli_fname)return {};return std::filesystem::path(info.dli_fname).parent_path().string();}
id<MTLTexture> texture(id<MTLDevice> device,MTLPixelFormat format,unsigned width,unsigned height){auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];desc.storageMode=MTLStorageModePrivate;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return [device newTextureWithDescriptor:desc];}
bool load(Pipeline &p,id<MTLDevice> device,const std::string &root,const char *name,std::string &error){
    const auto file=root+"/sgsr2/"+name;NSError *issue=nil;
    auto source=[NSString stringWithContentsOfFile:[NSString stringWithUTF8String:(file+".metal").c_str()] encoding:NSUTF8StringEncoding error:&issue];
    auto data=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:(file+".json").c_str()]];
    NSDictionary *metadata=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:&issue]:nil;
    if(!source||!metadata){error="SGSR2 translated shader resources are unavailable";return false;}
    auto settings=[MTLCompileOptions new];settings.languageVersion=MTLLanguageVersion2_3;
    auto library=[device newLibraryWithSource:source options:settings error:&issue];
    auto function=[library newFunctionWithName:metadata[@"entry"]];
    p.state=function?[device newComputePipelineStateWithFunction:function error:&issue]:nil;
    if(!p.state){error=message(issue);return false;}
    NSArray *threads=metadata[@"threads"];p.threads=MTLSizeMake([threads[0] unsignedIntegerValue],[threads[1] unsignedIntegerValue],[threads[2] unsignedIntegerValue]);
    if(p.threads.width!=8||p.threads.height!=8||p.threads.depth!=1||p.state.maxTotalThreadsPerThreadgroup<64||[metadata[@"uniformBytes"] unsignedIntValue]!=136){error="SGSR2 shader interface differs from the registered contract";return false;}
    for(NSDictionary *binding in metadata[@"bindings"])p.bindings.push_back({[binding[@"name"] UTF8String],[binding[@"kind"] UTF8String],[binding[@"index"] unsignedIntegerValue]});
    return true;
}
std::shared_ptr<Programs> programs(id<MTLDevice> device,std::string &error){
    const auto root=rootDirectory();if(root.empty()){error="SGSR2 resources are unavailable";return {};}
    std::lock_guard lock(programsMutex);auto &cached=programCache[{(__bridge void*)device,root}];if(auto existing=cached.lock())return existing;
    auto p=std::make_shared<Programs>();p->device=device;
    if(!load(p->convert,device,root,"convert",error)||!load(p->upscale,device,root,"upscale",error))return {};
    NSString *source=@R"MSL(
#include <metal_stdlib>
using namespace metal;
struct Ingress {uint2 colorOffset,depthOffset,motionOffset,render,motionSize;float2 motionScale,jitterCancellation;uint reversed;};
struct Output {uint2 outputOffset,outputSize;};
kernel void ingress(texture2d<float,access::read> color [[texture(0)]],texture2d<float,access::read> depth [[texture(1)]],texture2d<float> motion [[texture(2)]],texture2d<float,access::write> c [[texture(3)]],texture2d<float,access::write> d [[texture(4)]],texture2d<float,access::write> m [[texture(5)]],constant Ingress &p [[buffer(0)]],uint2 at [[thread_position_in_grid]]) {
    if(any(at>=p.render))return;
    constexpr sampler nearest(coord::pixel,filter::nearest,address::clamp_to_edge);
    const float2 uv=(float2(at)+0.5f)/float2(p.render);
    const float2 v=motion.sample(nearest,float2(p.motionOffset)+uv*float2(p.motionSize)).xy*p.motionScale/float2(p.motionSize)+p.jitterCancellation;
    const float z=depth.read(p.depthOffset+at).x;
    c.write(color.read(p.colorOffset+at),at);d.write(float4(p.reversed?1.0f-z:z),at);m.write(float4(-2.0f*v,0,0),at);
}
kernel void output(texture2d<float,access::read> scene [[texture(0)]],texture2d<float> color [[texture(1)]],texture2d<float,access::write> target [[texture(2)]],constant Output &p [[buffer(0)]],uint2 at [[thread_position_in_grid]]) {
    if(any(at>=p.outputSize))return;
    constexpr sampler linear(coord::normalized,filter::linear,address::clamp_to_edge);
    float4 value=scene.read(at);value.a=color.sample(linear,(float2(at)+0.5f)/float2(p.outputSize)).a;target.write(value,p.outputOffset+at);
}
kernel void clear(texture2d<float,access::write> target [[texture(0)]],uint2 at [[thread_position_in_grid]]) {if(at.x<target.get_width()&&at.y<target.get_height())target.write(float4(0),at);}
)MSL";
    NSError *issue=nil;auto library=[device newLibraryWithSource:source options:nil error:&issue];
    p->ingress=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"ingress"] error:&issue];
    p->output=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"output"] error:&issue];
    p->clear=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"clear"] error:&issue];
    if(!p->ingress||!p->output||!p->clear){error=message(issue);return {};}
    auto sampler=[MTLSamplerDescriptor new];sampler.sAddressMode=sampler.tAddressMode=MTLSamplerAddressModeClampToEdge;sampler.minFilter=sampler.magFilter=MTLSamplerMinMagFilterLinear;p->sampler=[device newSamplerStateWithDescriptor:sampler];
    if(!p->sampler){error="SGSR2 sampler allocation failed";return {};}cached=p;return p;
}
bool initialize(Context &c,const RSTemporalFrame &f,id<MTLDevice> device,std::string &error){
    c.programs=programs(device,error);if(!c.programs)return false;c.device=device;c.extent={f.renderWidth,f.renderHeight,f.outputWidth,f.outputHeight};
    c.color=texture(device,MTLPixelFormatRGBA16Float,f.renderWidth,f.renderHeight);c.depth=texture(device,MTLPixelFormatR32Float,f.renderWidth,f.renderHeight);c.motion=texture(device,MTLPixelFormatRG16Float,f.renderWidth,f.renderHeight);
    c.motionDepth=texture(device,MTLPixelFormatRGBA16Float,f.renderWidth,f.renderHeight);c.ycocg=texture(device,MTLPixelFormatR32Uint,f.renderWidth,f.renderHeight);c.scene=texture(device,MTLPixelFormatRGBA16Float,f.outputWidth,f.outputHeight);
    for(auto &history:c.history)history=texture(device,MTLPixelFormatRGBA16Float,f.outputWidth,f.outputHeight);
    if(!c.color||!c.depth||!c.motion||!c.motionDepth||!c.ycocg||!c.scene||!c.history[0]||!c.history[1]){error="SGSR2 private GPU allocation failed";return false;}c.lastFrame=0;c.historyIndex=0;c.lastJitter={0,0};c.lastPreExposure=1;c.failed=false;return true;
}
bool region(id<MTLTexture> t,id<MTLDevice> device,unsigned x,unsigned y,unsigned w,unsigned h){return t&&t.device==device&&t.textureType==MTLTextureType2D&&t.sampleCount==1&&w&&h&&x<=t.width&&y<=t.height&&w<=t.width-x&&h<=t.height-y;}
bool dispatch(id<MTLCommandBuffer> command,const Pipeline &p,const Params &params,const std::map<std::string,id<MTLTexture>> &textures,id<MTLSamplerState> sampler,MTLSize extent){
    auto encoder=[command computeCommandEncoder];if(!encoder)return false;[encoder setComputePipelineState:p.state];
    for(const auto &binding:p.bindings){if(binding.kind=="buffer")[encoder setBytes:&params length:sizeof(params) atIndex:binding.slot];else if(binding.kind=="sampler")[encoder setSamplerState:sampler atIndex:binding.slot];else {const auto found=textures.find(binding.name);if(found==textures.end()||!found->second){[encoder endEncoding];return false;}[encoder setTexture:found->second atIndex:binding.slot];}}
    [encoder dispatchThreadgroups:MTLSizeMake((extent.width+7)/8,(extent.height+7)/8,1) threadsPerThreadgroup:p.threads];[encoder endEncoding];return true;
}
int process(const RSTemporalFrame *f,RSTemporalResult *r,bool prepareOnly){
    if(!r||r->size<sizeof(*r)||r->version!=1)return RS_TEMPORAL_INVALID;r->encoded=r->reset=0;r->reason[0]=0;
    if(!f||f->size<sizeof(*f)||f->version!=1||f->method!=RS_TEMPORAL_SGSR2||!f->owner||!f->commandBuffer||!f->frameId||f->commandBufferKind||f->reserved||f->flags>255)return answer(r,RS_TEMPORAL_INVALID,"SGSR2 requires a version 1 Metal scene frame");
    if(!(f->flags&RS_TEMPORAL_CAMERA_VALID)||!std::isfinite(f->nearPlane)||f->nearPlane<=0||!std::isfinite(f->verticalFov)||f->verticalFov<=0||f->verticalFov>=3.14159265f)return answer(r,RS_TEMPORAL_INVALID,"SGSR2 requires actual camera near-plane and field-of-view metadata");
    if(!std::isfinite(f->preExposure)||f->preExposure<=0||!std::isfinite(f->jitterX)||!std::isfinite(f->jitterY)||!std::isfinite(f->motionScaleX)||!std::isfinite(f->motionScaleY)||!std::isfinite(f->frameTimeMs)||f->frameTimeMs<=0)return answer(r,RS_TEMPORAL_INVALID,"SGSR2 exposure, motion, jitter and timing must be finite");
    @autoreleasepool{@try{try{
        auto command=(__bridge id<MTLCommandBuffer>)f->commandBuffer;auto device=command.device;
        auto color=(__bridge id<MTLTexture>)f->color,depth=(__bridge id<MTLTexture>)f->depth,motion=(__bridge id<MTLTexture>)f->motion,output=(__bridge id<MTLTexture>)f->output;
        const bool outputMotion=f->flags&RS_TEMPORAL_OUTPUT_MOTION;const unsigned mw=outputMotion?f->outputWidth:f->renderWidth,mh=outputMotion?f->outputHeight:f->renderHeight;
        if(command.status>=MTLCommandBufferStatusCommitted||!command.retainedReferences||!region(color,device,f->colorX,f->colorY,f->renderWidth,f->renderHeight)||!region(depth,device,f->depthX,f->depthY,f->renderWidth,f->renderHeight)||!region(motion,device,f->motionX,f->motionY,mw,mh)||!region(output,device,f->outputX,f->outputY,f->outputWidth,f->outputHeight)||color==output||depth==output||motion==output||!(output.usage&MTLTextureUsageShaderWrite))return answer(r,RS_TEMPORAL_INVALID,"SGSR2 requires distinct compatible texture regions and unsubmitted retaining Metal commands");
        if(f->renderWidth>f->outputWidth||f->renderHeight>f->outputHeight||f->outputWidth>16384||f->outputHeight>16384)return answer(r,RS_TEMPORAL_INVALID,"SGSR2 output must be at least the render extent");
        std::shared_ptr<Context> context;{std::lock_guard lock(ownersMutex);auto &entry=owners[f->owner];if(!entry)entry=std::make_shared<Context>();context=entry;}
        std::unique_lock lock(context->mutex,std::try_to_lock);if(!lock.owns_lock())return answer(r,RS_TEMPORAL_BUSY,"The SGSR2 owner has an active frame");
        const std::array<uint32_t,4> extent={f->renderWidth,f->renderHeight,f->outputWidth,f->outputHeight};
        if(!context->programs||context->device!=device||context->extent!=extent||context->failed.load()){
            if(context->outstanding.load(std::memory_order_acquire))return answer(r,RS_TEMPORAL_BUSY,"The SGSR2 owner is retiring its previous resources");
            std::string error;if(!initialize(*context,*f,device,error)){context->failed=true;return answer(r,RS_TEMPORAL_FAILED,error);}
        }
        {std::lock_guard ownerLock(ownersMutex);const auto found=owners.find(f->owner);if(found==owners.end()||found->second!=context)return answer(r,RS_TEMPORAL_BUSY,"The SGSR2 owner was released during preparation");}
        if(prepareOnly)return answer(r,RS_TEMPORAL_OK,"");
        if(context->outstanding.load(std::memory_order_acquire)&&!macfx::orderedTemporalCommands(context->tail,command))return answer(r,RS_TEMPORAL_BUSY,"The SGSR2 frame has no established command order");
        if(context->lastFrame&&f->frameId<=context->lastFrame&&!(f->flags&RS_TEMPORAL_RESET))return answer(r,RS_TEMPORAL_INVALID,"SGSR2 content identities must increase");
        const bool reset=(f->flags&RS_TEMPORAL_RESET)||!context->lastFrame||f->frameId!=context->lastFrame+1;
        Ingress ingress{{f->colorX,f->colorY},{f->depthX,f->depthY},{f->motionX,f->motionY},{f->renderWidth,f->renderHeight},{mw,mh},{f->motionScaleX,f->motionScaleY},{0,0},bool(f->flags&RS_TEMPORAL_DEPTH_REVERSED)};
        if(!reset&&(f->flags&RS_TEMPORAL_JITTERED_MOTION))ingress.jitterCancellation={(f->jitterX-context->lastJitter.x)/f->renderWidth,(f->jitterY-context->lastJitter.y)/f->renderHeight};
        auto lease=std::make_shared<Lease>();lease->context=context;context->outstanding.fetch_add(1,std::memory_order_acq_rel);context->tail=command;
        [command addCompletedHandler:^(id<MTLCommandBuffer> completed){lease->retire(completed.status==MTLCommandBufferStatusCompleted);}];
        auto encoder=[command computeCommandEncoder];if(!encoder)return answer(r,RS_TEMPORAL_BUSY,"SGSR2 ingress encoder is unavailable");[encoder setComputePipelineState:context->programs->ingress];
        const std::array<id<MTLTexture>,6> ingressTextures={color,depth,motion,context->color,context->depth,context->motion};for(NSUInteger index=0;index<ingressTextures.size();++index)[encoder setTexture:ingressTextures[index] atIndex:index];
        [encoder setBytes:&ingress length:sizeof(ingress) atIndex:0];[encoder dispatchThreads:MTLSizeMake(f->renderWidth,f->renderHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        Params params{};params.renderSize={f->renderWidth,f->renderHeight};params.displaySize={f->outputWidth,f->outputHeight};params.renderSizeRcp={1.f/f->renderWidth,1.f/f->renderHeight};params.displaySizeRcp={1.f/f->outputWidth,1.f/f->outputHeight};params.jitterOffset={f->jitterX,f->jitterY};params.preExposure=reset?1:context->lastPreExposure/f->preExposure;
        // Qualcomm's named FOV field contains tan(horizontal FOV / 2), and its
        // exposure field contains previous/current pre-exposure, not an angle
        // or absolute exposure value (upstream v2 integration contract).
        params.cameraFovAngleHor=std::tan(f->verticalFov/2)*f->renderWidth/f->renderHeight;params.cameraNear=f->nearPlane;params.minLerpContribution=0;params.reset=reset;
        // No camera matrix was supplied by this ABI. The conservative five-tap
        // branch is valid; the static-camera optimization stays disabled.
        const auto previous=context->history[context->historyIndex],next=context->history[1-context->historyIndex];
        if(reset){auto wipe=[command computeCommandEncoder];if(!wipe){context->failed=true;return answer(r,RS_TEMPORAL_BUSY,"SGSR2 history initialization is unavailable");}[wipe setComputePipelineState:context->programs->clear];[wipe setTexture:previous atIndex:0];[wipe dispatchThreads:MTLSizeMake(f->outputWidth,f->outputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[wipe endEncoding];}
        if(!dispatch(command,context->programs->convert,params,{{"InputColor",context->color},{"InputDepth",context->depth},{"InputVelocity",context->motion},{"MotionDepthClipAlphaBuffer",context->motionDepth},{"YCoCgColor",context->ycocg}},context->programs->sampler,MTLSizeMake(f->renderWidth,f->renderHeight,1))||!dispatch(command,context->programs->upscale,params,{{"PrevHistoryOutput",previous},{"MotionDepthClipAlphaBuffer",context->motionDepth},{"YCoCgColor",context->ycocg},{"SceneColorOutput",context->scene},{"HistoryOutput",next}},context->programs->sampler,MTLSizeMake(f->outputWidth,f->outputHeight,1))){context->failed=true;return answer(r,RS_TEMPORAL_FAILED,"SGSR2 translated resource bindings are incompatible");}
        Output target{{f->outputX,f->outputY},{f->outputWidth,f->outputHeight}};encoder=[command computeCommandEncoder];if(!encoder){context->failed=true;return answer(r,RS_TEMPORAL_BUSY,"SGSR2 output encoder is unavailable");}[encoder setComputePipelineState:context->programs->output];[encoder setTexture:context->scene atIndex:0];[encoder setTexture:context->color atIndex:1];[encoder setTexture:output atIndex:2];[encoder setBytes:&target length:sizeof(target) atIndex:0];[encoder dispatchThreads:MTLSizeMake(f->outputWidth,f->outputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        context->lastFrame=f->frameId;context->lastJitter=params.jitterOffset;context->lastPreExposure=f->preExposure;context->historyIndex=1-context->historyIndex;
        return answer(r,RS_TEMPORAL_OK,"",true,reset);
    }catch(const std::exception &error){return answer(r,RS_TEMPORAL_FAILED,error.what());}}@catch(NSException *error){return answer(r,RS_TEMPORAL_FAILED,error.reason.UTF8String?:"SGSR2 Metal encoding failed");}}
}
int encode(const RSTemporalFrame *f,RSTemporalResult *r){return process(f,r,false);}
void release(void *owner){std::lock_guard lock(ownersMutex);owners.erase(owner);}
const RSTemporalProvider api={sizeof(api),1,1u<<RS_TEMPORAL_SGSR2,0,encode,release};
}
extern "C" const RSTemporalProvider *rsGetTemporalProvider(uint32_t version){return version==1?&api:nullptr;}
extern "C" int rsPrepareTemporalResources(const RSTemporalFrame *f,RSTemporalResult *r){return process(f,r,true);}
