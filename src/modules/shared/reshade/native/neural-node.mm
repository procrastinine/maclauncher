// Copyright (c) MacLauncher contributors. MIT license.
#include "neural-node.hpp"
#include "native-config.hpp"
#include "neural-depth.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "color-formats.hpp"
#include "metal-library-cache.hpp"
#include "gpu-completion.hpp"
#include "frame-capture.hpp"
#include "neural-provider.h"
#include "neural-service.hpp"
#include "generation-provider.hpp"
#include "spatial.hpp"
#include "log.hpp"
#include "image-admission.hpp"
#include "runtime-status.hpp"
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#include <atomic>
#include <algorithm>
#include <cstdlib>
#include <dlfcn.h>
#include <mutex>
#include <condition_variable>
#include <stdexcept>
#include <chrono>
#include <cstdio>
#include <array>
#include <utility>
#include <optional>
#include <unistd.h>

namespace macfx {
namespace {
void quarantineNeuralResources(std::shared_ptr<void> resources){
    // A missing process reply cannot prove GPU completion. Keep the exact
    // textures and budget leases for the game-process lifetime; a replacement
    // node receives independent state and cannot recycle these allocations.
    static auto *retired=new std::vector<std::shared_ptr<void>>;
    static std::mutex mutex;std::lock_guard guard(mutex);retired->push_back(std::move(resources));
}
bool lostNeuralOwnership(const char *message){return message&&std::strncmp(message,"Neural service ownership was lost",33)==0;}
// Every provider wait in a caller buffer is bounded (releaseLateProvider).
constexpr const char *lateInference="Neural provider exceeded its GPU wait bound; frames continue without it until it completes";
// A provider failure is not final; the row reports it while it waits to retry.
constexpr const char *warmingUp="Neural provider is warming up";
std::string retrying(const std::string &error){return "Neural provider failed; retrying"+(error.empty()?std::string():": "+error);}
bool neuralDiagnosticsEnabled(){return !nativeConfig().diagnostics.path.empty();}
using DiagnosticClock=std::chrono::steady_clock;
struct NeuralDiagnostics {
    std::mutex lock;FILE *output=nullptr;uint64_t rows=0,observed=0,rendered=0,inferred=0,cacheHits=0,passthrough=0,failed=0,busy=0;
    DiagnosticClock::time_point last{},flushed{};
    NeuralDiagnostics(){const auto path=nativeConfig().diagnostics.path+".neural."+std::to_string(getpid())+".jsonl";output=std::fopen(path.c_str(),"a");}
    void record(uint64_t frame,unsigned width,unsigned height,int status,bool completion,DiagnosticClock::time_point started,bool cacheHit){
        std::lock_guard<std::mutex>guard(lock);if(!output||rows>=20000)return;
        ++observed;if(completion&&status==ML_NEURAL_RENDERED)++rendered;else if(completion&&status==ML_NEURAL_PASSTHROUGH)++passthrough;else if(status==ML_NEURAL_BUSY)++busy;else ++failed;
        if(completion&&status==ML_NEURAL_RENDERED){if(cacheHit)++cacheHits;else ++inferred;}
        const auto now=DiagnosticClock::now();if(last.time_since_epoch().count()&&now-last<std::chrono::microseconds(8333))return;last=now;++rows;
        const char *name=completion&&status==ML_NEURAL_RENDERED?"rendered":completion&&status==ML_NEURAL_PASSTHROUGH?"passthrough":status==ML_NEURAL_BUSY?"busy":completion?"failed":"rejected";
        const double elapsed=completion?std::chrono::duration<double,std::milli>(now-started).count():0;
        const auto time=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        std::fprintf(output,"{\"pid\":%d,\"frameId\":%llu,\"inputWidth\":%u,\"inputHeight\":%u,\"event\":\"%s\",\"status\":\"%s\",\"providerStatus\":%d,\"completed_at_ms\":%lld,\"elapsed_wall_ms\":%.6f,\"observed\":%llu,\"rendered\":%llu,\"inference\":%s,\"cacheHit\":%s,\"inferred\":%llu,\"cacheHits\":%llu,\"passthrough\":%llu,\"failed\":%llu,\"busy\":%llu,\"records\":%llu}\n",getpid(),(unsigned long long)frame,width,height,completion?"completion":"bypass",name,status,(long long)time,elapsed,(unsigned long long)observed,(unsigned long long)rendered,completion&&status==ML_NEURAL_RENDERED&&!cacheHit?"true":"false",cacheHit?"true":"false",(unsigned long long)inferred,(unsigned long long)cacheHits,(unsigned long long)passthrough,(unsigned long long)failed,(unsigned long long)busy,(unsigned long long)rows);
        if(!flushed.time_since_epoch().count()||now-flushed>=std::chrono::seconds(1)){std::fflush(output);flushed=now;}
    }
};
void neuralDiagnostic(uint64_t frame,unsigned width,unsigned height,int status,bool completion,DiagnosticClock::time_point started={},bool cacheHit=false)noexcept{
    if(!neuralDiagnosticsEnabled())return;
    try{static auto *const output=new NeuralDiagnostics;output->record(frame,width,height,status,completion,started,cacheHit);}catch(...){}
}
struct Library {
    using Create=MLNeuralProvider(*)(const char *,float,int,char *,size_t);
    decltype(&ml_neural_submit) submit=nullptr;
    decltype(&ml_neural_destroy) destroy=nullptr;
    decltype(&ml_neural_create_v2) create2=nullptr;
    decltype(&ml_neural_submit_v2) submit2=nullptr;
    decltype(&ml_neural_submit_batch_v2) submitBatch=nullptr;
    decltype(&ml_neural_submit_scene_v3) submitScene=nullptr;
    decltype(&ml_neural_prepare_depth_v1) prepareDepth=nullptr;
    decltype(&ml_neural_timing_supported_v1) timingSupported=nullptr;
    decltype(&ml_neural_submit_timed_v1) submitTimed=nullptr;
    decltype(&ml_neural_submit_batch_timed_v1) submitBatchTimed=nullptr;
    decltype(&ml_neural_destroy_v2) destroy2=nullptr;
    Create create=nullptr;
    std::string path;
    void *handle=nullptr;
    explicit Library(const std::string &file,bool service=false):path(file){
        if(service){create=ml_neural_service_create;submit=ml_neural_service_submit;destroy=ml_neural_service_destroy;
            create2=ml_neural_service_create_v2;submit2=ml_neural_service_submit_v2;submitBatch=ml_neural_service_submit_batch_v2;submitScene=ml_neural_service_submit_scene_v3;prepareDepth=ml_neural_service_prepare_depth_v1;timingSupported=ml_neural_service_timing_supported_v1;submitTimed=ml_neural_service_submit_timed_v1;submitBatchTimed=ml_neural_service_submit_batch_timed_v1;destroy2=ml_neural_service_destroy;return;}
        handle=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);
        if(!handle)throw std::runtime_error(std::string("Neural rendering is unavailable: ")+(dlerror()?:"Cannot load its provider"));
        create=reinterpret_cast<Create>(dlsym(handle,"ml_neural_create_with_options"));
        submit=reinterpret_cast<decltype(submit)>(dlsym(handle,"ml_neural_submit"));
        destroy=reinterpret_cast<decltype(destroy)>(dlsym(handle,"ml_neural_destroy"));
        create2=reinterpret_cast<decltype(create2)>(dlsym(handle,"ml_neural_create_v2"));
        submit2=reinterpret_cast<decltype(submit2)>(dlsym(handle,"ml_neural_submit_v2"));
        submitBatch=reinterpret_cast<decltype(submitBatch)>(dlsym(handle,"ml_neural_submit_batch_v2"));
        submitScene=reinterpret_cast<decltype(submitScene)>(dlsym(handle,"ml_neural_submit_scene_v3"));
        const auto depthAPI=reinterpret_cast<decltype(&ml_neural_depth_api)>(dlsym(handle,"ml_neural_depth_api"));
        if(depthAPI&&depthAPI()==1)prepareDepth=reinterpret_cast<decltype(prepareDepth)>(dlsym(handle,"ml_neural_prepare_depth_v1"));
        destroy2=reinterpret_cast<decltype(destroy2)>(dlsym(handle,"ml_neural_destroy_v2"));
        const auto timingAPI=reinterpret_cast<uint32_t(*)()>(dlsym(handle,"ml_neural_timing_api"));
        if(timingAPI&&timingAPI()==1){timingSupported=reinterpret_cast<decltype(timingSupported)>(dlsym(handle,"ml_neural_timing_supported_v1"));submitTimed=reinterpret_cast<decltype(submitTimed)>(dlsym(handle,"ml_neural_submit_timed_v1"));submitBatchTimed=reinterpret_cast<decltype(submitBatchTimed)>(dlsym(handle,"ml_neural_submit_batch_timed_v1"));}
        if(!create||!submit||!destroy){dlclose(handle);handle=nullptr;throw std::runtime_error("The neural-rendering provider has an incompatible API");}
    }
};
std::shared_ptr<Library> library(){
    if(@available(macOS 14.0,*)){}else throw std::runtime_error("Neural rendering requires macOS 14 or later");
    const char *file=std::getenv("RESHADE_NEURAL_LIBRARY");
    if(!file||*file!='/')throw std::runtime_error("The neural-rendering provider is unavailable");
    // Swift tasks and completion callbacks can outlive their last native row.
    // Keep the fixed provider code loaded until the game process exits.
    static auto *loaded=new std::vector<std::shared_ptr<Library>>;
    static std::mutex lock;std::lock_guard<std::mutex>guard(lock);
    for(const auto &item:*loaded)if(item->path==file)return item;
#if defined(__arm64__)
    const auto execution=std::getenv("RESHADE_NEURAL_EXECUTION");
    const bool service=execution&&!std::strcmp(execution,"service");
#else
    const bool service=true;
#endif
    auto value=std::make_shared<Library>(file,service);loaded->push_back(value);return value;
}
struct Image {
    CVPixelBufferRef pixels=nullptr;
    id<MTLTexture> texture;
    std::shared_ptr<ImageReservation> reservation;
    ~Image(){if(pixels)CVPixelBufferRelease(pixels);}
    void allocate(id<MTLDevice> device,unsigned width,unsigned height,unsigned precision=0){
        reservation=reserveImageBytes(device,alignedImageBytes(width,height,precision==2?16:precision==1?8:4),0,"neural-memory",true);
        NSDictionary *properties=@{(__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferBytesPerRowAlignmentKey:@256,
            (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        if(CVPixelBufferCreate(kCFAllocatorDefault,width,height,precision==3?kCVPixelFormatType_OneComponent32Float:precision==2?kCVPixelFormatType_128RGBAFloat:precision?kCVPixelFormatType_64RGBAHalf:kCVPixelFormatType_32BGRA,
            (__bridge CFDictionaryRef)properties,&pixels)!=kCVReturnSuccess)
            throw std::runtime_error("Cannot allocate a neural-rendering frame");
        auto surface=CVPixelBufferGetIOSurface(pixels);
        reservation->commit(CVPixelBufferGetDataSize(pixels));
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:precision==3?MTLPixelFormatR32Float:precision==2?MTLPixelFormatRGBA32Float:precision?MTLPixelFormatRGBA16Float:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
        texture=[device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
        if(!texture)throw std::runtime_error("Cannot bind a neural-rendering frame to Metal");
        attachImageReservation(texture,reservation);
    }
};
struct Images {Image source,destination;unsigned width=0,height=0,outputWidth=0,outputHeight=0;};
bool opaqueBlack(const Image &image){
    if(!image.pixels||CVPixelBufferGetPixelFormatType(image.pixels)!=kCVPixelFormatType_32BGRA||CVPixelBufferLockBaseAddress(image.pixels,0)!=kCVReturnSuccess)return false;
    auto *base=static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(image.pixels));const size_t row=CVPixelBufferGetBytesPerRow(image.pixels),width=CVPixelBufferGetWidth(image.pixels),height=CVPixelBufferGetHeight(image.pixels);
    for(size_t y=0;base&&y<height;++y){auto *line=reinterpret_cast<uint32_t*>(base+y*row);std::fill(line,line+width,0xff000000u);}
    CVPixelBufferUnlockBaseAddress(image.pixels,0);return base!=nullptr;
}
void captureNeuralInput(const ShaderFrame &frame,const std::shared_ptr<Images> &images){
    const char *enabled=std::getenv("RESHADE_NEURAL_CAPTURE_INPUT"),*path=std::getenv("RESHADE_CAPTURE_PREFIX");
    if(!enabled||std::strcmp(enabled,"1")||!path||!*path)return;
    static std::atomic<bool> captured{false};if(captured.exchange(true))return;
    const unsigned width=images->width,height=images->height,stride=(width*4+255)&~255u;
    auto bytes=[frame.commands.device newBufferWithLength:size_t(stride)*height options:MTLResourceStorageModeShared];
    if(!bytes)return;
    auto copy=[frame.commands blitCommandEncoder];
    [copy copyFromTexture:images->source.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:size_t(stride)*height];[copy endEncoding];
    const std::string prefix=std::string(path)+"-neural-input.png";
    [frame.commands addCompletedHandler:^(id<MTLCommandBuffer> commands){
        if(commands.status!=MTLCommandBufferStatusCompleted)return;
        unsigned minimum=255,maximum=0;size_t nonopaque=0;const auto data=static_cast<const unsigned char*>(bytes.contents);
        for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x){const unsigned alpha=data[size_t(y)*stride+x*4+3];minimum=std::min(minimum,alpha);maximum=std::max(maximum,alpha);nonopaque+=alpha!=255;}
        nativeLog("Neural input capture "+std::to_string(width)+"x"+std::to_string(height)+" alpha_min="+std::to_string(minimum)+" alpha_max="+std::to_string(maximum)+" nonopaque="+std::to_string(nonopaque));
        try{writeCapturedFrame(prefix,bytes.contents,width,height,true,false,stride);}catch(const std::exception &error){nativeLog(error.what());}
    }];
}
struct NeuralObservation {uintptr_t context=0;std::string stage,revision,method;};
struct InputStamp {
    uint64_t contentId=0,epoch=0,imageRevision=0;
    std::string inputIdentity,historyIdentity;
    bool synthetic=false,opaque=false,straight=false,displayMapped=false;
    unsigned width=0,height=0,outputWidth=0,outputHeight=0;
    FrameOrigin origin=FrameOrigin::TopLeft;SpatialColor color=SpatialColor::Perceptual;
    InputStamp()=default;
    InputStamp(const NeuralInputStamp &stamp,const ShaderFrame &frame,bool normalized):
        contentId(stamp.contentId),epoch(stamp.epoch),imageRevision(stamp.imageRevision),inputIdentity(stamp.inputIdentity),historyIdentity(stamp.history()),
        synthetic(stamp.synthetic),opaque(frame.opaqueDisplay),straight(normalized),width(frame.source.width),height(frame.source.height),
        outputWidth(frame.target.width),outputHeight(frame.target.height),origin(frame.origin),color(frame.color){}
    // History continues while the input contract holds; an upstream control
    // edit changes only inputIdentity, which still invalidates exact results.
    bool sameInput(const InputStamp &other)const{
        return epoch==other.epoch&&imageRevision==other.imageRevision&&historyIdentity==other.historyIdentity&&
            opaque==other.opaque&&straight==other.straight&&displayMapped==other.displayMapped&&width==other.width&&height==other.height&&
            outputWidth==other.outputWidth&&outputHeight==other.outputHeight&&origin==other.origin&&color==other.color;
    }
    bool operator==(const InputStamp &other)const{return contentId==other.contentId&&synthetic==other.synthetic&&inputIdentity==other.inputIdentity&&sameInput(other);}
};
struct State;
struct Flight {
    std::shared_ptr<State> owner;std::shared_ptr<const NeuralObservation> observation;
    std::shared_ptr<Images> images;
    id<MTLSharedEvent> event;
    id<MTLBuffer> valid;
    __weak id<MTLCommandBuffer> commands;
    GPUCompletionFence fence;
    std::atomic<bool> providerDone{false},gpuDone{false},expired{false};
    uint64_t frameId=0,observationId=0,producer=0,done=0,serial=0,historyRevision=0;
    bool warmup=false;
    InputStamp stamp;bool stamped=false;
    std::atomic<int> result{ML_NEURAL_BUSY};
    DiagnosticClock::time_point started{};bool opaqueDisplay=false,reset=false;
    std::atomic<unsigned> submission{0};
    uint64_t timingToken=0;bool measureGpu=false,timingCacheOnly=false;std::atomic<uint64_t>gpuNanoseconds{0};
};
struct State {
    std::shared_ptr<Library> api;
    MLNeuralProvider provider=nullptr;
    bool version2=false;
    std::string method;
    id<MTLDevice> device;
    id<MTLComputePipelineState> modelInput,restoreAlpha;
    std::vector<std::shared_ptr<Images>> slots;
    std::weak_ptr<Flight> pending;
    std::shared_ptr<Images> cachedImages;
    InputStamp cachedStamp,lastStamp;
    uint64_t scheduled=0,cachedSerial=0,historyRevision=0;
    bool hasStamp=false;
    std::mutex lock;
    std::condition_variable completion;
    int lastStatus=ML_NEURAL_RENDERED;
    uint64_t eventValue=0,lastFrame=0;
    unsigned lastWidth=0,lastHeight=0;double lastTimeMs=0;
    // The extent of a completed warm-up inference, and the one in flight.
    // No frame or provider holds a warm-up before its submission, so the
    // state owns it until completed() resolves it, which ends the cycle.
    unsigned warmWidth=0,warmHeight=0,warmOutputWidth=0,warmOutputHeight=0;std::shared_ptr<Flight> warming;
    bool warm(unsigned width,unsigned height,unsigned outputWidth,unsigned outputHeight)const{return warmWidth==width&&warmHeight==height&&warmOutputWidth==outputWidth&&warmOutputHeight==outputHeight;}
    bool hasFrame=false,failed=false,unsupported=false,unsupportedOpaque=false;
    // A failed inference retries after 1 s, doubling to 30 s; a rendered one
    // resets the delay. No runtime failure is final. Frames already in flight
    // when it failed do not extend the delay. Called with lock held.
    std::chrono::steady_clock::time_point retryAt{};std::chrono::milliseconds retryDelay{0};
    void fail(){if(failed)return;failed=true;retryDelay=retryDelay.count()?std::min(retryDelay*2,std::chrono::milliseconds(30000)):std::chrono::milliseconds(1000);retryAt=std::chrono::steady_clock::now()+retryDelay;}
    bool unavailable(){if(failed&&std::chrono::steady_clock::now()>=retryAt)failed=false;return failed;}
    unsigned unsupportedWidth=0,unsupportedHeight=0;
    std::string lastError;
    State(const NeuralSpec &spec,id<MTLDevice> gpu):api(library()),device(gpu),method(spec.method){
        if(gpu.registryID!=MTLCreateSystemDefaultDevice().registryID)throw std::runtime_error("Neural rendering requires the system Metal device");
        char error[512]{};
        if(spec.method=="mlx-dlss"&&!(api->timingSupported&&api->submitTimed&&api->create2))provider=api->create(spec.modelPath.c_str(),spec.intensity,spec.temporal,error,sizeof(error));
        else {
            if(!api->create2||!api->submit2||!api->destroy2)throw std::runtime_error("This neural operation requires an updated graphics provider");
            if(spec.method=="depth-anything-v2-small"&&!api->prepareDepth)throw std::runtime_error("This graphics provider does not supply scalar relative-depth inference");
            MLNeuralOptionsV2 options{};options.size=sizeof(options);options.version=2;
            options.operation=spec.method=="mlx-dlss"?ML_NEURAL_NR:spec.method=="depth-anything-v2-small"?ML_NEURAL_DEPTH_ANYTHING_V2_SMALL:spec.method=="rife"?ML_NEURAL_RIFE:spec.method=="realcugan"?ML_NEURAL_CUGAN:spec.method=="nafnet"?ML_NEURAL_NAFNET:spec.method=="realesrgan"?ML_NEURAL_SRVGG:spec.method=="mlx-vsr"?ML_NEURAL_VSR:spec.method=="mlx-interpolation"?ML_NEURAL_INTERPOLATION:spec.method=="mlx-sr-scene"?ML_NEURAL_SR_SCENE:ML_NEURAL_SR_IMAGE;
            options.intensity=spec.intensity;options.temporal=spec.temporal;
            if(spec.method=="realesrgan"){static_assert(sizeof(float)==sizeof(uint32_t));std::memcpy(&options.reserved[0],&spec.denoiseStrength,sizeof(float));options.reserved[1]=1;}
            provider=api->create2(spec.modelPath.c_str(),&options,error,sizeof(error));version2=true;
        }
        if(!provider)throw std::runtime_error(error[0]?error:"Cannot create neural rendering");
        try{if(spec.method!="depth-anything-v2-small")prepareCopyPipelines();}catch(...){if(version2)api->destroy2(provider);else api->destroy(provider);provider=nullptr;throw;}
    }
    ~State(){if(provider){if(version2)api->destroy2(provider);else api->destroy(provider);}}
    void prepareCopyPipelines(){
        if(!modelInput){
            NSError *error=nil;
            auto code=@"#include <metal_stdlib>\nusing namespace metal;kernel void model_input(texture2d<float,access::sample> source [[texture(0)]],texture2d<float,access::write> target [[texture(1)]],constant uint2 &control [[buffer(0)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height()){constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=(float2(p)+.5f)/float2(target.get_width(),target.get_height());if(control.y)uv.y=1-uv.y;float4 c=source.sample(s,uv);if(control.x)c.a=1;target.write(c,p);}}kernel void restore_alpha(texture2d<float,access::sample> source [[texture(0)]],texture2d<float,access::sample> model [[texture(1)]],texture2d<float,access::write> target [[texture(2)]],constant uint2 &control [[buffer(0)]],device const uint *valid [[buffer(1)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height()){constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=(float2(p)+.5f)/float2(target.get_width(),target.get_height());float2 modelUV=uv;if(control.y)modelUV.y=1-modelUV.y;float4 c;if(*valid)c=model.sample(s,modelUV);else c=source.sample(s,uv);if(control.x!=2||!*valid)c.a=source.sample(s,uv).a;target.write(c,p);}}";
            auto library=[device newLibraryWithSource:code options:nil error:&error];
            if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare opaque neural input");
            modelInput=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"model_input"] error:&error];
            restoreAlpha=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"restore_alpha"] error:&error];
            if(!modelInput||!restoreAlpha)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare neural alpha preservation");
        }
    }
    void copyModelFrame(const ShaderFrame &frame,id<MTLTexture> target,id<MTLTexture> model=nil,id<MTLBuffer> valid=nil,bool modelAlpha=false,bool normalizeAlpha=false){
        auto encoder=[frame.commands computeCommandEncoder];
        if(!encoder)throw std::runtime_error("Cannot encode neural alpha preservation");
        uint32_t control[]={model&&modelAlpha?2u:frame.opaqueDisplay||normalizeAlpha?1u:0u,frame.origin==FrameOrigin::BottomLeft?1u:0u};
        [encoder setComputePipelineState:model?restoreAlpha:modelInput];[encoder setTexture:frame.source atIndex:0];
        [encoder setTexture:model?:target atIndex:1];if(model)[encoder setTexture:target atIndex:2];
        [encoder setBytes:control length:sizeof(control) atIndex:0];
        if(model)[encoder setBuffer:valid offset:0 atIndex:1];
        [encoder dispatchThreads:MTLSizeMake(target.width,target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
    }
    std::shared_ptr<Images> acquire(unsigned width,unsigned height,unsigned outputWidth,unsigned outputHeight){
        for(const auto &slot:slots)if(slot.use_count()==1&&slot->width==width&&slot->height==height&&slot->outputWidth==outputWidth&&slot->outputHeight==outputHeight)return slot;
        slots.erase(std::remove_if(slots.begin(),slots.end(),[&](const auto &slot){return slot.use_count()==1&&(slot->width!=width||slot->height!=height||slot->outputWidth!=outputWidth||slot->outputHeight!=outputHeight);}),slots.end());
        if(slots.size()>=32)return {};
        auto slot=std::make_shared<Images>();slot->width=width;slot->height=height;slot->outputWidth=outputWidth;slot->outputHeight=outputHeight;
        slot->source.allocate(device,width,height);slot->destination.allocate(device,outputWidth,outputHeight,method=="depth-anything-v2-small"?3:0);slots.push_back(slot);return slot;
    }
};
void adoptCompletedImageCache(State&state,const std::shared_ptr<Flight>&flight){
    if(!flight||!flight->stamped||!flight->providerDone.load(std::memory_order_acquire)||!flight->fence.completed()||flight->result.load(std::memory_order_relaxed)!=ML_NEURAL_RENDERED)return;
    if(!state.failed&&flight->historyRevision==state.historyRevision&&flight->serial>=state.cachedSerial){state.cachedImages=flight->images;state.cachedStamp=flight->stamp;state.cachedSerial=flight->serial;}
}
void completed(void *context,int status,const char *message){
    std::unique_ptr<std::shared_ptr<Flight>> held(static_cast<std::shared_ptr<Flight>*>(context));auto flight=*held;
    const bool unsubmitted=flight->submission.load(std::memory_order_acquire)==2;
    if(status!=ML_NEURAL_RENDERED&&flight->valid)*static_cast<uint32_t*>(flight->valid.contents)=0;
    if(status==ML_NEURAL_FAILED&&lostNeuralOwnership(message))quarantineNeuralResources(flight);
    if(flight->observation&&!unsubmitted&&!(flight->expired.load(std::memory_order_acquire)&&status==ML_NEURAL_RENDERED)){RuntimeStatusEvent event;event.context=flight->observation->context;event.processing=true;event.phase=status==ML_NEURAL_RENDERED?RuntimeStatusPhase::Completed:RuntimeStatusPhase::Bypassed;
        event.planRevision=flight->observation->revision;event.stageId=flight->observation->stage;event.requestedMethod=flight->observation->method;
        const std::string activeMethod=status==ML_NEURAL_RENDERED?flight->observation->method+(message&&!std::strcmp(message,"Exact-frame cache")?"-cache":""):"passthrough";
        event.activeMethod=activeMethod;
        event.reason=message?message:"";event.frameId=flight->observationId?:flight->frameId;event.inputWidth=flight->images->width;event.outputWidth=flight->images->outputWidth;event.inputHeight=flight->images->height;event.outputHeight=flight->images->outputHeight;observeRuntimeStatus(event);}
    neuralDiagnostic(flight->observationId?:flight->frameId,flight->images->width,flight->images->height,status,true,flight->started,status==ML_NEURAL_RENDERED&&message&&!std::strcmp(message,"Exact-frame cache"));
    if(!unsubmitted){std::lock_guard<std::mutex>guard(flight->owner->lock);
        // Keep an unavailable model or failed inference from repeating costly
        // work on every game frame. Unsupported input retries only after its
        // extent or verified display contract changes; other failures, such
        // as GPU errors after a watchdog or renewal, retry after a backoff.
        const bool unsupportedAlpha=status==ML_NEURAL_PASSTHROUGH&&message&&!std::strcmp(message,"Neural rendering requires an opaque SDR frame");
        // Admission follows the frames this node consumes. A warm-up image
        // is synthetic, so its content verdict never latches a real extent.
        const bool contentVerdict=unsupportedAlpha&&flight->warmup;
        if(unsupportedAlpha&&!flight->warmup){flight->owner->unsupported=true;flight->owner->unsupportedWidth=flight->images->width;flight->owner->unsupportedHeight=flight->images->height;flight->owner->unsupportedOpaque=flight->opaqueDisplay;}
        else if(status==ML_NEURAL_FAILED||(status==ML_NEURAL_PASSTHROUGH&&message&&*message&&!contentVerdict))flight->owner->fail();
        else{if(status==ML_NEURAL_RENDERED)flight->owner->retryDelay={};
            if(flight->warmup){auto &owner=*flight->owner;owner.warmWidth=flight->images->width;owner.warmHeight=flight->images->height;owner.warmOutputWidth=flight->images->outputWidth;owner.warmOutputHeight=flight->images->outputHeight;}}
        if(status!=ML_NEURAL_RENDERED&&message&&*message&&!contentVerdict&&flight->owner->lastError!=message){
            flight->owner->lastError=message;nativeLog("Neural rendering: "+std::string(message));
        }
    }
    // An abandoned caller buffer never reached the provider. Its watchdog
    // must not poison this model or overwrite a newer frame's status/history.
    if(!unsubmitted){std::lock_guard<std::mutex>guard(flight->owner->lock);flight->owner->lastStatus=status;}
    if(flight->warmup){std::lock_guard<std::mutex>guard(flight->owner->lock);if(flight->owner->warming==flight)flight->owner->warming.reset();}
    flight->result.store(status,std::memory_order_relaxed);flight->providerDone.store(true,std::memory_order_release);
    flight->owner->completion.notify_all();
}
std::atomic<uint64_t>neuralTimingTokens{1};
NeuralGpuTimingTicket timingTicket(const std::shared_ptr<Flight>&flight){return [flight]{if(!flight->fence.completed()||!flight->providerDone.load(std::memory_order_acquire)||flight->result.load(std::memory_order_relaxed)!=ML_NEURAL_RENDERED)return NeuralGpuTimingValue{};const auto ns=flight->gpuNanoseconds.load(std::memory_order_acquire);return NeuralGpuTimingValue{ns,flight->timingCacheOnly?NeuralGpuTimingState::NoNewWork:ns?NeuralGpuTimingState::Complete:NeuralGpuTimingState::Unavailable};};}
void neuralTimed(void*context,const MLNeuralGPUTimingV1*receipt){
    if(!context||!receipt)return;const auto&flight=*static_cast<std::shared_ptr<Flight>*>(context);
    if(receipt->size>=sizeof(*receipt)&&receipt->version==1&&receipt->job_token==flight->timingToken&&receipt->status==0&&receipt->command_buffers&&receipt->gpu_nanoseconds)flight->gpuNanoseconds.store(receipt->gpu_nanoseconds,std::memory_order_release);
}
void expireImage(const std::shared_ptr<Flight>&flight){
    flight->expired.store(true,std::memory_order_release);
    if(flight->observation){RuntimeStatusEvent event;event.context=flight->observation->context;event.processing=true;event.phase=RuntimeStatusPhase::Bypassed;
        event.planRevision=flight->observation->revision;event.stageId=flight->observation->stage;event.requestedMethod=flight->observation->method;event.activeMethod="passthrough";event.reason=lateInference;
        event.frameId=flight->observationId?:flight->frameId;event.inputWidth=flight->images->width;event.outputWidth=flight->images->outputWidth;event.inputHeight=flight->images->height;event.outputHeight=flight->images->outputHeight;observeRuntimeStatus(event);}
    std::lock_guard<std::mutex>guard(flight->owner->lock);
    if(flight->owner->lastError!=lateInference){flight->owner->lastError=lateInference;nativeLog(std::string("Neural rendering: ")+lateInference);}
}
void scheduleImage(const std::shared_ptr<Flight> &flight){
    static auto listener=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
    const std::weak_ptr<Flight> weak=flight;
    [flight->event notifyListener:listener atValue:flight->producer block:^(id<MTLSharedEvent>,uint64_t){
        auto flight=weak.lock();if(!flight)return;
        unsigned waiting=0;if(!flight->submission.compare_exchange_strong(waiting,1))return;
        bool failed;{std::lock_guard guard(flight->owner->lock);failed=flight->owner->failed;}
        auto held=new std::shared_ptr<Flight>(flight);int accepted=ML_NEURAL_FAILED;
        if(!failed){auto owner=flight->owner;
            if(owner->version2){MLNeuralFrameV2 request{};request.size=sizeof(request);request.version=2;request.source=flight->images->source.pixels;request.destination=flight->images->destination.pixels;request.shared_event=(__bridge void*)flight->event;request.producer_value=flight->producer;request.done_value=flight->done;request.frame_id=flight->frameId;request.reset_history=flight->reset;accepted=flight->measureGpu&&owner->api->submitTimed?owner->api->submitTimed(owner->provider,&request,flight->timingToken,neuralTimed,completed,held):owner->api->submit2(owner->provider,&request,completed,held);}
            else accepted=owner->api->submit(owner->provider,flight->images->source.pixels,flight->images->destination.pixels,(__bridge void*)flight->event,flight->producer,flight->done,flight->frameId,flight->reset,completed,held);
        }
        if(failed||accepted!=ML_NEURAL_RENDERED){completed(held,ML_NEURAL_FAILED,failed?"The neural image owner is unavailable":"The neural image provider rejected this frame");flight->event.signaledValue=std::max(flight->event.signaledValue,flight->done);}
        else if(!flight->warmup){id<MTLBuffer> valid=flight->valid;releaseLateProvider(flight->event,flight->done,^{
            auto late=weak.lock();if(late&&late->providerDone.load(std::memory_order_acquire))return;
            *static_cast<uint32_t*>(valid.contents)=0;if(late)expireImage(late);});}
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        if(auto pending=weak.lock()){unsigned waiting=0;if(pending->submission.compare_exchange_strong(waiting,2)){completed(new std::shared_ptr<Flight>(pending),ML_NEURAL_FAILED,"The neural source was not submitted");pending->event.signaledValue=std::max(pending->event.signaledValue,pending->done);}}
    });
}
bool format(MTLPixelFormat value){return value==MTLPixelFormatBGRA8Unorm||value==MTLPixelFormatRGBA8Unorm;}
std::string invalid(const ShaderFrame &frame,const NeuralSpec &spec){
    if(!frame.commands||!frame.source||!frame.target||frame.commands.status>=MTLCommandBufferStatusCommitted)return "Neural rendering requires an unsubmitted frame";
    if(!frame.commands.retainedReferences)return "Neural rendering requires a retaining command buffer";
    if(frame.source.device!=frame.commands.device||frame.target.device!=frame.commands.device)return "Neural images must use the command buffer's Metal device";
    if(frame.color!=SpatialColor::Perceptual||!format(frame.source.pixelFormat)||!format(frame.target.pixelFormat))return "Neural rendering requires SDR RGBA8 or BGRA8 color";
    const unsigned scale=spec.intrinsicScale?spec.intrinsicScale:(spec.method=="mlx-dlss"||spec.method=="nafnet")?1:spec.method=="realesrgan"?4:2;
    if(frame.source.width*scale!=frame.target.width||frame.source.height*scale!=frame.target.height)return scale==1?"Neural rendering preserves the current frame dimensions":"The target must match this model's intrinsic output scale";
    if(!frame.source.width||!frame.source.height||frame.source.width>16384||frame.source.height>16384)return "Neural frame dimensions are outside the supported range";
    if(frame.source.textureType!=MTLTextureType2D||frame.target.textureType!=MTLTextureType2D||frame.source.sampleCount!=1||frame.target.sampleCount!=1||frame.source.framebufferOnly||frame.target.framebufferOnly)return "Neural rendering requires accessible, resolved 2D images";
    if(!(frame.source.usage&MTLTextureUsageShaderRead)||!(frame.target.usage&MTLTextureUsageShaderWrite))return "Neural frames require readable input and writable output images";
    return {};
}
class NeuralNode final:public ShaderNode {
    std::mutex ticketMutex;std::shared_ptr<Flight>lastFlight;
    void rememberFlight(const std::shared_ptr<Flight>&flight){std::lock_guard guard(ticketMutex);lastFlight=flight;}
    NeuralSpec spec;
    std::atomic<bool> straightInput{false};
    std::shared_ptr<State> state;std::mutex stateMutex,observationMutex;std::shared_ptr<const NeuralObservation> observation;
    std::shared_ptr<State> stateFor(id<MTLDevice> device){
        // Candidate preparation and retained batches may share this node.
        // Serialize provider creation, then retain a state snapshot through
        // each operation without holding this ownership lock in callbacks.
        std::unique_lock<std::mutex>guard(stateMutex);
        if(state&&state->device==device)return state;
        auto next=std::make_shared<State>(spec,device);
        auto previous=std::exchange(state,next);guard.unlock();return next;
    }
    ShaderResult prepareState(const ShaderFrame &frame,std::shared_ptr<State> &selected,bool reserve=true){
        try{
            if(auto reason=invalid(frame,spec);!reason.empty())return {false,reason};
            selected=stateFor(frame.commands.device);
            std::lock_guard<std::mutex>guard(selected->lock);
            if(selected->unavailable())return {false,retrying(selected->lastError)};
            if(selected->unsupported){
                if(selected->unsupportedWidth==frame.source.width&&selected->unsupportedHeight==frame.source.height&&selected->unsupportedOpaque==frame.opaqueDisplay)
                    return {false,selected->lastError.empty()?"Neural input is unsupported":selected->lastError};
                selected->unsupported=false;selected->lastError.clear();selected->hasFrame=false;
            }
            if(reserve&&!selected->acquire(frame.source.width,frame.source.height,frame.target.width,frame.target.height))return {false,"Neural frame resources are busy",true};
            return {true,{}};
        }catch(const ImageBudgetExceeded &){throw;}
        catch(const std::exception &error){return {false,error.what()};}
    }
public:
    std::function<ShaderResult()>ticket(){std::lock_guard guard(ticketMutex);auto flight=lastFlight;return [flight]{if(!flight)return ShaderResult{false,"No neural image has been encoded"};if(flight->submission.load(std::memory_order_acquire)==2)return ShaderResult{false,"The neural source was not submitted",true};if(flight->expired.load(std::memory_order_acquire))return ShaderResult{false,lateInference};if(flight->fence.failed())return ShaderResult{false,"The neural image GPU commands failed"};if(!flight->fence.completed()||!flight->providerDone.load(std::memory_order_acquire))return ShaderResult{false,"The neural image work is pending",true};return flight->result.load(std::memory_order_relaxed)==ML_NEURAL_RENDERED&&flight->valid&&*static_cast<const uint32_t*>(flight->valid.contents)?ShaderResult{true,{}}:ShaderResult{false,"The neural provider did not render this exact image"};};}
    void inputColor(const ImageColorDescription &value){straightInput.store(value.alpha==ColorAlpha::Straight,std::memory_order_release);}
    void statusContext(uintptr_t owner,std::string_view stage,std::string_view revision){if(!owner)return;std::lock_guard guard(observationMutex);if(observation&&observation->context==owner&&observation->stage==stage&&observation->revision==revision)return;auto value=std::make_shared<NeuralObservation>();value->context=owner;value->stage=stage;value->revision=revision;value->method=spec.method;observation=std::move(value);}
    explicit NeuralNode(const NeuralSpec &value):spec(value){}
    ShaderResult finishOffline(){
        std::shared_ptr<State> selected;{std::lock_guard<std::mutex>guard(stateMutex);selected=state;}
        if(!selected)return {false,"The neural stage was not initialized"};
        std::unique_lock<std::mutex>guard(selected->lock);
        const auto flight=selected->pending.lock();
        if(flight&&!selected->completion.wait_for(guard,std::chrono::seconds(5),[&]{return flight->providerDone.load(std::memory_order_acquire);}))
            return {false,"Neural video processing did not report completion"};
        if(flight&&flight->submission.load(std::memory_order_acquire)==2)return {false,"The neural source was not submitted"};
        if(flight&&flight->expired.load(std::memory_order_acquire))return {false,lateInference};
        if(selected->failed||selected->unsupported||selected->lastStatus!=ML_NEURAL_RENDERED)
            return {false,selected->lastError.empty()?"The neural stage did not render this video frame":selected->lastError};
        return {true,{}};
    }
    void setParameters(const ShaderParameters &)override{}
    ShaderResult prepare(const ShaderFrame &frame)override{
        std::shared_ptr<State> selected;return prepareState(frame,selected);
    }
    // One inference at this frame's extent on the provider alone: no caller
    // buffer waits for it, so a cold model's first inference never delays a
    // presented frame. Busy until it completes; a failed warm-up stays busy
    // through its retry backoff and then runs again.
    ShaderResult warmup(const ShaderFrame &frame){
        std::shared_ptr<State> selected;const auto ready=prepareState(frame,selected,false);
        if(!ready.encoded){if(selected){std::lock_guard<std::mutex>guard(selected->lock);if(selected->failed)return {false,ready.reason,true};}return ready;}
        std::lock_guard<std::mutex>guard(selected->lock);
        if(selected->warm(frame.source.width,frame.source.height,frame.target.width,frame.target.height))return {true,{}};
        if(const auto running=selected->warming;running&&!running->providerDone.load(std::memory_order_acquire))return {false,warmingUp,true};
        auto images=selected->acquire(frame.source.width,frame.source.height,frame.target.width,frame.target.height);if(!images)return {false,"Neural frame resources are busy",true};
        auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=images;flight->event=[selected->device newSharedEvent];flight->warmup=true;
        flight->valid=[selected->device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
        if(!flight->event||!flight->valid)return {false,"Cannot create neural GPU synchronization"};*static_cast<uint32_t*>(flight->valid.contents)=1;
        flight->producer=1;flight->done=2;flight->reset=true;flight->opaqueDisplay=frame.opaqueDisplay;if(neuralDiagnosticsEnabled())flight->started=DiagnosticClock::now();
        // Opaque black content runs the model itself. An uninitialized
        // source could read as transparent and skip the inference it warms.
        if(!opaqueBlack(images->source))return {false,"Cannot initialize the neural warm-up image"};
        selected->warming=flight;scheduleImage(flight);flight->event.signaledValue=1;
        return {false,warmingUp,true};
    }
    ShaderResult warmupStatus(){
        std::shared_ptr<State> selected;{std::lock_guard<std::mutex>guard(stateMutex);selected=state;}
        if(!selected)return {true,{}};
        std::lock_guard<std::mutex>guard(selected->lock);
        if(selected->failed&&std::chrono::steady_clock::now()<selected->retryAt)return {false,retrying(selected->lastError),true};
        if(const auto running=selected->warming;running&&!running->providerDone.load(std::memory_order_acquire))return {false,warmingUp,true};
        return {true,{}};
    }
    ShaderResult encode(const ShaderFrame &frame)override{return encodeStamped(frame,nullptr,false);}
    bool gpuTimingAvailable(){std::unique_lock guard(stateMutex,std::try_to_lock);return guard&&state&&state->version2&&state->api->submitTimed&&state->api->timingSupported&&state->api->timingSupported(state->provider)==1;}
    ShaderResult encodeStamped(const ShaderFrame &frame,const NeuralInputStamp *stamp,bool redraw,NeuralGpuTimingTicket*timing=nullptr){
        if(timing)*timing={};
        std::shared_ptr<State> selected;
        const uint64_t observed=stamp&&stamp->observationId?stamp->observationId:frame.frameId;
        const auto ready=prepareState(frame,selected,false);if(!ready.encoded){neuralDiagnostic(observed,frame.source.width,frame.source.height,ready.busy?ML_NEURAL_BUSY:ML_NEURAL_FAILED,false);return ready;}
        std::lock_guard<std::mutex>guard(selected->lock);
        const bool straight=straightInput.load(std::memory_order_acquire);
        const InputStamp identity=stamp?InputStamp(*stamp,frame,straight):InputStamp{};
        adoptCompletedImageCache(*selected,selected->pending.lock());
        if(stamp&&selected->cachedImages&&identity==selected->cachedStamp){
            auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=selected->cachedImages;flight->commands=frame.commands;flight->fence.bind(frame.commands);flight->frameId=frame.frameId;flight->observationId=observed;
            flight->valid=[selected->device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
            if(!flight->valid)return {false,"Cannot retain neural redraw validity"};*static_cast<uint32_t*>(flight->valid.contents)=1;
            flight->timingCacheOnly=true;flight->result.store(ML_NEURAL_RENDERED,std::memory_order_relaxed);flight->providerDone.store(true,std::memory_order_release);if(timing)*timing=timingTicket(flight);rememberFlight(flight);
            if(neuralDiagnosticsEnabled())flight->started=DiagnosticClock::now();
            {std::lock_guard guard(observationMutex);flight->observation=observation;}
            selected->copyModelFrame(frame,frame.target,flight->images->destination.texture,flight->valid);
            [frame.commands addCompletedHandler:^(id<MTLCommandBuffer> commands){
                flight->fence.observe(commands);
                flight->gpuDone.store(true,std::memory_order_release);
                completed(new std::shared_ptr<Flight>(flight),commands.status==MTLCommandBufferStatusCompleted?ML_NEURAL_RENDERED:ML_NEURAL_FAILED,
                    commands.status==MTLCommandBufferStatusCompleted?"Exact-frame cache":"The neural redraw command failed");
            }];
            return {true,{}};
        }
        if(auto pending=selected->pending.lock()){
            // A late flight holds no caller buffer. Frames continue without
            // this row until its provider finishes, instead of waiting on it.
            if(pending->expired.load(std::memory_order_acquire)&&!pending->providerDone.load(std::memory_order_acquire)){neuralDiagnostic(observed,frame.source.width,frame.source.height,ML_NEURAL_BUSY,false);return {false,lateInference};}
            auto commands=pending->commands;
            const bool abandoned=pending->providerDone.load(std::memory_order_acquire)&&(!commands||commands!=frame.commands&&commands.status<MTLCommandBufferStatusCommitted);
            const bool duplicateRedraw=redraw&&stamp&&pending->stamped&&pending->stamp==identity;
            if((commands!=frame.commands||duplicateRedraw)&&!abandoned&&(!pending->providerDone.load(std::memory_order_acquire)||!(pending->fence.completed()||pending->fence.failed()))){neuralDiagnostic(observed,frame.source.width,frame.source.height,ML_NEURAL_BUSY,false);return {false,"Neural rendering is busy",true};}
        }
        auto images=selected->acquire(frame.source.width,frame.source.height,frame.target.width,frame.target.height);if(!images){neuralDiagnostic(frame.frameId,frame.source.width,frame.source.height,ML_NEURAL_BUSY,false);return {false,"Neural frame resources are busy",true};}
        auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=images;flight->event=[selected->device newSharedEvent];flight->commands=frame.commands;flight->fence.bind(frame.commands);
        flight->valid=[selected->device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
        if(!flight->valid)return {false,"Cannot retain neural output validity"};*static_cast<uint32_t*>(flight->valid.contents)=1;
        {std::lock_guard guard(observationMutex);flight->observation=observation;}
        flight->frameId=frame.frameId;flight->observationId=observed;flight->opaqueDisplay=frame.opaqueDisplay;if(neuralDiagnosticsEnabled())flight->started=DiagnosticClock::now();
        if(!flight->event)return {false,"Cannot create neural GPU synchronization"};
        // Initialize the destination before publishing the producer event. A
        // provider timeout can release an abandoned buffer without reading it;
        // any later submission still has a complete passthrough image.
        // The model consumes top-left rows regardless of the caller's storage
        // origin. Unknown/opaque display alpha is normalized only at ingress.
        for(auto target:{images->source.texture,images->destination.texture})selected->copyModelFrame(frame,target,nil,nil,false,straight);
        captureNeuralInput(frame,images);
        const auto producer=selected->eventValue+1,done=producer+1;
        // Presentation may skip source frames while inference is busy. Motion
        // is estimated between the accepted images, so forward ID gaps retain
        // history; actual timeline rewinds and geometry changes start anew.
        const bool changedInput=stamp&&selected->hasStamp&&!identity.sameInput(selected->lastStamp);
        // An uncached redraw infers once with fresh history. It never invents
        // a new producer frame; later exact redraws use the completed cache.
        const bool reset=redraw||changedInput||!selected->hasFrame||frame.frameId<=selected->lastFrame||frame.timeMs<selected->lastTimeMs||
            frame.source.width!=selected->lastWidth||frame.source.height!=selected->lastHeight;
        if(reset||!stamp){++selected->historyRevision;selected->cachedImages.reset();}
        flight->stamped=stamp!=nullptr;flight->stamp=identity;flight->serial=++selected->scheduled;flight->historyRevision=selected->historyRevision;
        selected->hasStamp=stamp!=nullptr;if(stamp)selected->lastStamp=identity;
        flight->producer=producer;flight->done=done;flight->reset=reset;flight->measureGpu=timing&&selected->version2&&selected->api->submitTimed&&selected->api->timingSupported&&selected->api->timingSupported(selected->provider)==1;rememberFlight(flight);if(flight->measureGpu)flight->timingToken=neuralTimingTokens.fetch_add(1,std::memory_order_relaxed);if(timing)*timing=timingTicket(flight);scheduleImage(flight);
        selected->eventValue=done;selected->lastFrame=frame.frameId;selected->lastTimeMs=frame.timeMs;
        selected->lastWidth=frame.source.width;selected->lastHeight=frame.source.height;selected->hasFrame=true;selected->pending=flight;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer> commands){
            flight->fence.observe(commands);
            flight->gpuDone.store(true,std::memory_order_release);
            if(commands.status!=MTLCommandBufferStatusCompleted||!flight->stamped||!flight->providerDone.load(std::memory_order_acquire)||flight->result.load(std::memory_order_relaxed)!=ML_NEURAL_RENDERED)return;
            auto owner=flight->owner;std::lock_guard guard(owner->lock);
            adoptCompletedImageCache(*owner,flight);
        }];
        [frame.commands encodeSignalEvent:flight->event value:producer];
        [frame.commands encodeWaitForEvent:flight->event value:done];
        // Restore RGB to the declared storage origin and retain source alpha at
        // that original pixel, including explicitly transparent caller frames.
        selected->copyModelFrame(frame,frame.target,images->destination.texture,flight->valid);return {true,{}};
    }
};

struct SceneImages {Image color,guides,output;unsigned width=0,height=0;};
struct SceneFlight {
    std::shared_ptr<State> owner;std::shared_ptr<SceneImages> images;
    id<MTLSharedEvent> event;id<MTLBuffer> valid;__weak id<MTLCommandBuffer> commands;
    std::atomic<bool> providerDone{false},gpuDone{false},expired{false};
    GPUCompletionFence fence;std::atomic<int> result{ML_NEURAL_BUSY};std::string message;
};
void sceneCompleted(void *context,int status,const char *message){
    std::unique_ptr<std::shared_ptr<SceneFlight>> held(static_cast<std::shared_ptr<SceneFlight>*>(context));auto flight=*held;
    if(status!=ML_NEURAL_RENDERED){
        *static_cast<uint32_t*>(flight->valid.contents)=0;
        if(status==ML_NEURAL_FAILED&&lostNeuralOwnership(message))quarantineNeuralResources(flight);
        std::lock_guard guard(flight->owner->lock);flight->owner->fail();flight->owner->lastError=message&&*message?message:"Scene SR did not complete";
    }
    flight->message=message?message:"";flight->result.store(status,std::memory_order_relaxed);
    {std::lock_guard guard(flight->owner->lock);flight->owner->lastStatus=status;if(status==ML_NEURAL_RENDERED)flight->owner->retryDelay={};}
    flight->providerDone.store(true,std::memory_order_release);
}
struct SceneControl {
    uint32_t extent[2],outputExtent[2],colorBase[2],depthBase[2],motionBase[2],outputBase[2];
    float jitter[2],previousJitter[2],motionScale[2],motionRatio[2];float preExposure;uint32_t flags;
};
class SceneEncoder final:public NeuralSceneEncoder {
    id<MTLDevice> device;std::shared_ptr<State> state;std::mutex mutex;
    id<MTLComputePipelineState> ingress,egress;bool depthSampler=false;
    std::vector<std::shared_ptr<SceneImages>> slots;std::weak_ptr<SceneFlight> pending;
    uint64_t previousID=0;unsigned previousWidth=0,previousHeight=0;float previousJitter[2]{};
    static bool region(id<MTLTexture> texture,uint32_t x,uint32_t y,uint32_t width,uint32_t height){return texture&&x<=texture.width&&y<=texture.height&&width<=texture.width-x&&height<=texture.height-y;}
    std::string invalid(const RSTemporalFrame &f){
        auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;
        auto color=(__bridge id<MTLTexture>)f.color,depth=(__bridge id<MTLTexture>)f.depth,motion=(__bridge id<MTLTexture>)f.motion,output=(__bridge id<MTLTexture>)f.output;
        if(f.size<sizeof(f)||f.version!=1||f.commandBufferKind||!commands||commands.device!=device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return "Scene SR requires the actual unsubmitted retaining Metal command buffer";
        if(!f.frameId||!f.renderWidth||!f.renderHeight||f.renderWidth>4096||f.renderHeight>4096||!f.outputWidth||!f.outputHeight)return "This DLSS SR model supports up to 4096 input pixels per side and a nonempty output region";
        if(f.flags&RS_TEMPORAL_HDR||!format(color.pixelFormat)||!format(output.pixelFormat))return "This DLSS SR model requires an explicit SDR color island";
        const unsigned mw=f.flags&RS_TEMPORAL_OUTPUT_MOTION?f.outputWidth:f.renderWidth,mh=f.flags&RS_TEMPORAL_OUTPUT_MOTION?f.outputHeight:f.renderHeight;
        if(!region(color,f.colorX,f.colorY,f.renderWidth,f.renderHeight)||!region(depth,f.depthX,f.depthY,f.renderWidth,f.renderHeight)||!region(motion,f.motionX,f.motionY,mw,mh)||!region(output,f.outputX,f.outputY,f.outputWidth,f.outputHeight))return "Scene SR requires matching color, depth, motion and output regions";
        for(auto image:{color,depth,motion,output})if(image.device!=device||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly)return "Scene SR requires resolved accessible textures on its Metal device";
        if(color==output||depth==output||motion==output||!(color.usage&MTLTextureUsageShaderRead)||!(depth.usage&MTLTextureUsageShaderRead)||!(motion.usage&MTLTextureUsageShaderRead)||!(output.usage&MTLTextureUsageShaderWrite))return "Scene SR requires distinct readable guides and writable output";
        if(!std::isfinite(f.jitterX)||!std::isfinite(f.jitterY)||!std::isfinite(f.motionScaleX)||!std::isfinite(f.motionScaleY)||!std::isfinite(f.preExposure)||f.preExposure<=0)return "Scene SR requires finite jitter, motion scales and positive pre-exposure";
        if(f.exposure){auto exposure=(__bridge id<MTLTexture>)f.exposure;if(exposure.device!=device||exposure.width!=1||exposure.height!=1||!(exposure.usage&MTLTextureUsageShaderRead))return "Scene SR exposure must be the same scene's readable 1 by 1 GPU texture";}
        return {};
    }
    std::shared_ptr<SceneImages> acquire(unsigned width,unsigned height){
        for(const auto &slot:slots)if(slot.use_count()==1&&slot->width==width&&slot->height==height)return slot;
        slots.erase(std::remove_if(slots.begin(),slots.end(),[](const auto &slot){return slot.use_count()==1;}),slots.end());
        if(slots.size()>=4)return {};
        auto slot=std::make_shared<SceneImages>();slot->width=width;slot->height=height;
        slot->color.allocate(device,width,height);slot->guides.allocate(device,width,height,2);slot->output.allocate(device,width*2,height*2);slots.push_back(slot);return slot;
    }
    void pipelines(MTLPixelFormat format){
        const bool useDepth=format==MTLPixelFormatDepth32Float||format==MTLPixelFormatDepth32Float_Stencil8||format==MTLPixelFormatDepth24Unorm_Stencil8;
        if(ingress&&depthSampler==useDepth)return;
        NSString *source=[NSString stringWithFormat:@"#include <metal_stdlib>\nusing namespace metal;struct Control{uint2 extent,outputExtent,colorBase,depthBase,motionBase,outputBase;float2 jitter,previousJitter,motionScale,motionRatio;float preExposure;uint flags;};kernel void scene_input(texture2d<float,access::sample> color [[texture(0)]],%@ depth [[texture(1)]],texture2d<float,access::sample> motion [[texture(2)]],texture2d<float,access::read> exposure [[texture(3)]],texture2d<float,access::write> target [[texture(4)]],texture2d<float,access::write> guides [[texture(5)]],constant Control &c [[buffer(0)]],uint2 p [[thread_position_in_grid]]){if(any(p>=c.extent))return;constexpr sampler linear(coord::normalized,address::clamp_to_edge,filter::linear);constexpr sampler nearest(coord::normalized,address::clamp_to_edge,filter::nearest);float2 point=float2(p)+.5f+c.jitter;float4 value=color.sample(linear,(point+float2(c.colorBase))/float2(color.get_width(),color.get_height()));float gain=(c.flags&256)?max(exposure.read(uint2(0)).x,1e-6f):1;value.rgb=clamp(value.rgb*gain/c.preExposure,0.0f,1.0f);target.write(value,p);float2 flow=motion.sample(linear,(point*c.motionRatio+float2(c.motionBase))/float2(motion.get_width(),motion.get_height())).xy*c.motionScale;if(c.flags&32)flow+=c.previousJitter-c.jitter;float z=float4(depth.sample(nearest,(point+float2(c.depthBase))/float2(depth.get_width(),depth.get_height()))).x;if(c.flags&2)z=1-z;guides.write(float4(flow,z,1),p);}kernel void scene_output(texture2d<float,access::sample> original [[texture(0)]],texture2d<float,access::sample> model [[texture(1)]],texture2d<float,access::read> exposure [[texture(2)]],texture2d<float,access::write> target [[texture(3)]],constant Control &c [[buffer(0)]],device const uint *valid [[buffer(1)]],uint2 p [[thread_position_in_grid]]){uint2 size=c.outputExtent;if(any(p>=size))return;constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=(float2(p)+.5f)/float2(size);float4 src=original.sample(s,(uv*float2(c.extent)+float2(c.colorBase))/float2(original.get_width(),original.get_height()));float4 value=src;if(*valid){value=model.sample(s,uv);float gain=(c.flags&256)?max(exposure.read(uint2(0)).x,1e-6f):1;value.rgb*=c.preExposure/gain;value.a=src.a;}target.write(value,p+c.outputBase);}",useDepth?@"depth2d<float,access::sample>":@"texture2d<float,access::sample>"];
        NSError *error=nil;auto library=[device newLibraryWithSource:source options:nil error:&error];
        if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare scene SR ingestion");
        auto nextInput=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"scene_input"] error:&error];
        auto nextOutput=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"scene_output"] error:&error];
        if(!nextInput||!nextOutput)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare scene SR output");
        ingress=nextInput;egress=nextOutput;depthSampler=useDepth;
    }
public:
    SceneEncoder(id<MTLDevice> gpu,const NeuralSpec &spec):device(gpu),state(std::make_shared<State>(spec,gpu)){
        if(spec.method!="mlx-sr-scene"||!state->api->submitScene)throw std::runtime_error("Scene SR requires the actual guide-capable neural provider");
    }
    ShaderResult prepare(const RSTemporalFrame &f)override{
        try{std::lock_guard guard(mutex);if(auto reason=invalid(f);!reason.empty())return {false,reason};
            {std::lock_guard lock(state->lock);if(state->unavailable())return {false,retrying(state->lastError)};}
            pipelines(((__bridge id<MTLTexture>)f.depth).pixelFormat);if(!acquire(f.renderWidth,f.renderHeight))return {false,"Scene SR resources are in use",true};return {true,{}};
        }catch(const ImageBudgetExceeded&){throw;}catch(const std::exception &error){return {false,error.what()};}
    }
    ShaderResult completion()override{
        std::lock_guard guard(mutex);
        if(auto flight=pending.lock())if(!flight->providerDone.load(std::memory_order_acquire))return {false,"Scene SR completion metadata is pending",true};
        std::lock_guard lock(state->lock);return state->failed||state->lastStatus!=ML_NEURAL_RENDERED?ShaderResult{false,state->lastError.empty()?"Scene SR did not render":state->lastError}:ShaderResult{true,{}};
    }
    std::function<ShaderResult()> completionTicket()override{
        std::shared_ptr<SceneFlight>flight;{std::lock_guard guard(mutex);flight=pending.lock();}
        if(!flight)return []{return ShaderResult{false,"Scene SR has no submitted image"};};
        return [flight]{
            if(flight->expired.load(std::memory_order_acquire))return ShaderResult{false,lateInference};
            if(!flight->providerDone.load(std::memory_order_acquire))return ShaderResult{false,"Scene SR completion metadata is pending",true};
            if(!flight->fence.completed())return ShaderResult{false,flight->fence.failed()?"Scene SR GPU work failed":"Scene SR GPU work is pending",!flight->fence.failed()};
            return flight->result.load(std::memory_order_relaxed)==ML_NEURAL_RENDERED&&*static_cast<const uint32_t*>(flight->valid.contents)?ShaderResult{true,{}}:ShaderResult{false,flight->message.empty()?"Scene SR did not render this image":flight->message};
        };
    }
    ShaderResult encode(const RSTemporalFrame &f)override{
        const auto ready=prepare(f);if(!ready.encoded)return ready;
        std::lock_guard guard(mutex);auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;
        if(auto flight=pending.lock()){
            if(flight->expired.load()&&!flight->providerDone.load())return {false,lateInference};
            if(!flight->providerDone.load()||!(flight->fence.completed()||flight->fence.failed()))return {false,"Scene SR inference is in use",true};
        }
        try{
            const auto images=acquire(f.renderWidth,f.renderHeight);if(!images)return {false,"Scene SR resources are in use",true};
            auto flight=std::make_shared<SceneFlight>();flight->owner=state;flight->images=images;flight->commands=commands;flight->fence.bind(commands);flight->event=[device newSharedEvent];flight->valid=[device newBufferWithLength:4 options:MTLResourceStorageModeShared];
            if(!flight->event||!flight->valid)return {false,"Cannot synchronize scene SR"};*static_cast<uint32_t*>(flight->valid.contents)=1;
            const bool reset=(f.flags&RS_TEMPORAL_RESET)||!previousID||f.frameId<=previousID||f.frameId!=previousID+1||previousWidth!=f.renderWidth||previousHeight!=f.renderHeight;
            SceneControl c{{f.renderWidth,f.renderHeight},{f.outputWidth,f.outputHeight},{f.colorX,f.colorY},{f.depthX,f.depthY},{f.motionX,f.motionY},{f.outputX,f.outputY},{f.jitterX,f.jitterY},{reset?f.jitterX:previousJitter[0],reset?f.jitterY:previousJitter[1]},{f.motionScaleX,f.motionScaleY},{1,1},f.preExposure,f.flags|(f.exposure?256u:0u)};
            if(f.flags&RS_TEMPORAL_OUTPUT_MOTION){c.motionRatio[0]=float(f.outputWidth)/f.renderWidth;c.motionRatio[1]=float(f.outputHeight)/f.renderHeight;c.motionScale[0]*=float(f.renderWidth)/f.outputWidth;c.motionScale[1]*=float(f.renderHeight)/f.outputHeight;}
            auto color=(__bridge id<MTLTexture>)f.color,depth=(__bridge id<MTLTexture>)f.depth,motion=(__bridge id<MTLTexture>)f.motion,output=(__bridge id<MTLTexture>)f.output,exposure=f.exposure?(__bridge id<MTLTexture>)f.exposure:color;
            auto encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:ingress];for(unsigned i=0;i<6;++i)[encoder setTexture:std::array<id<MTLTexture>,6>{color,depth,motion,exposure,images->color.texture,images->guides.texture}[i] atIndex:i];[encoder setBytes:&c length:sizeof(c) atIndex:0];[encoder dispatchThreads:MTLSizeMake(f.renderWidth,f.renderHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
            ShaderFrame initialized;initialized.commands=commands;initialized.source=images->color.texture;initialized.target=images->output.texture;initialized.opaqueDisplay=false;state->copyModelFrame(initialized,images->output.texture);
            MLNeuralSceneFrameV3 request{};request.size=sizeof(request);request.version=3;request.guides=images->guides.pixels;auto &frame=request.frame;frame.size=sizeof(frame);frame.version=2;frame.source=images->color.pixels;frame.destination=images->output.pixels;frame.shared_event=(__bridge void*)flight->event;frame.producer_value=1;frame.done_value=2;frame.frame_id=f.frameId;frame.reset_history=reset;
            auto held=new std::shared_ptr<SceneFlight>(flight);const auto accepted=state->api->submitScene(state->provider,&request,sceneCompleted,held);if(accepted!=ML_NEURAL_RENDERED){delete held;return {false,"Scene SR rejected the actual scene guides",accepted==ML_NEURAL_BUSY};}
            [commands encodeSignalEvent:flight->event value:1];[commands encodeWaitForEvent:flight->event value:2];
            {static auto listener=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
             const std::weak_ptr<SceneFlight> weak=flight;id<MTLBuffer> valid=flight->valid;
             [flight->event notifyListener:listener atValue:1 block:^(id<MTLSharedEvent> reached,uint64_t){releaseLateProvider(reached,2,^{
                auto late=weak.lock();if(late&&late->providerDone.load(std::memory_order_acquire))return;
                *static_cast<uint32_t*>(valid.contents)=0;if(late)late->expired.store(true,std::memory_order_release);});}];}
            encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:egress];[encoder setTexture:color atIndex:0];[encoder setTexture:images->output.texture atIndex:1];[encoder setTexture:exposure atIndex:2];[encoder setTexture:output atIndex:3];[encoder setBytes:&c length:sizeof(c) atIndex:0];[encoder setBuffer:flight->valid offset:0 atIndex:1];[encoder dispatchThreads:MTLSizeMake(f.outputWidth,f.outputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
            [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){flight->fence.observe(completed);flight->gpuDone.store(true,std::memory_order_release);}];
            previousID=f.frameId;previousWidth=f.renderWidth;previousHeight=f.renderHeight;previousJitter[0]=f.jitterX;previousJitter[1]=f.jitterY;pending=flight;return {true,{}};
        }catch(const ImageBudgetExceeded&){throw;}catch(const std::exception &error){return {false,error.what()};}
    }
};

struct GenerationFlight {
    std::shared_ptr<State> owner;std::shared_ptr<Image> previous,current;
    std::vector<std::shared_ptr<Image>> outputs;InterpolationPlan phases;
    id<MTLSharedEvent> event;__weak id<MTLCommandBuffer> commands;
    id<MTLBuffer> valid;
    uint64_t previousID=0,currentID=0,timingToken=0;unsigned phase=0;bool measureGpu=false;std::atomic<uint64_t>gpuNanoseconds{0};
    std::atomic<unsigned> submission{0};
    std::atomic<bool> providerDone{false},gpuDone{false},expired{false};
    GPUCompletionFence fence;std::atomic<int> result{ML_NEURAL_BUSY};std::string message;
};
void generationTimed(void*context,const MLNeuralGPUTimingV1*receipt){if(!context||!receipt)return;const auto&flight=*static_cast<std::shared_ptr<GenerationFlight>*>(context);if(receipt->size>=sizeof(*receipt)&&receipt->version==1&&receipt->job_token==flight->timingToken&&receipt->status==0&&receipt->command_buffers&&receipt->gpu_nanoseconds)flight->gpuNanoseconds.store(receipt->gpu_nanoseconds,std::memory_order_release);}
bool cancelUnsubmittedGeneration(const std::shared_ptr<GenerationFlight>&flight,const char*reason){
    unsigned waiting=0;if(!flight->submission.compare_exchange_strong(waiting,2))return false;
    // No provider has taken this job. Cancel its output gate, but leave GPU
    // completion and all command-owned image leases with the actual buffer.
    if(flight->valid)*static_cast<uint32_t*>(flight->valid.contents)=0;flight->message=reason;flight->result.store(ML_NEURAL_FAILED,std::memory_order_relaxed);flight->providerDone.store(true,std::memory_order_release);flight->event.signaledValue=std::max(flight->event.signaledValue,uint64_t(2));return true;
}
int submitGenerationPhase(const std::shared_ptr<GenerationFlight>&);
void generationCompleted(void *context,int status,const char *message){
    std::unique_ptr<std::shared_ptr<GenerationFlight>> held(static_cast<std::shared_ptr<GenerationFlight>*>(context));auto flight=*held;
    if(status!=ML_NEURAL_RENDERED){
        if(flight->valid)*static_cast<uint32_t*>(flight->valid.contents)=0;
        if(status==ML_NEURAL_FAILED&&lostNeuralOwnership(message))quarantineNeuralResources(flight);
        {std::lock_guard guard(flight->owner->lock);flight->owner->fail();flight->owner->lastError=message&&*message?message:"Neural interpolation did not complete";}
    }else{std::lock_guard guard(flight->owner->lock);flight->owner->retryDelay={};}
    flight->message=message?message:"";flight->result.store(status,std::memory_order_relaxed);
    flight->providerDone.store(true,std::memory_order_release);
    if(status!=ML_NEURAL_RENDERED)flight->event.signaledValue=std::max(flight->event.signaledValue,uint64_t(2));
}
int submitGenerationPhase(const std::shared_ptr<GenerationFlight> &flight){
    // A composed timeline can encode many pairs before the borrowed command
    // buffer is submitted. Admit their image leases now, but enqueue inference
    // only after each pair's GPU producer fence. Earlier pair waits serialize
    // this owner's inference without filling its bounded task queue.
    static auto listener=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
    const std::weak_ptr<GenerationFlight> weak=flight;
    [flight->event notifyListener:listener atValue:1 block:^(id<MTLSharedEvent>,uint64_t){
        auto flight=weak.lock();if(!flight)return;
        unsigned waiting=0;if(!flight->submission.compare_exchange_strong(waiting,1))return;
        bool failed;{std::lock_guard guard(flight->owner->lock);failed=flight->owner->failed;}
        auto held=new std::shared_ptr<GenerationFlight>(flight);
        if(failed){generationCompleted(held,ML_NEURAL_FAILED,"The interpolation owner is unavailable");return;}
        MLNeuralFrameV2 frame{};frame.size=sizeof(frame);frame.version=2;
        frame.source=flight->previous->pixels;frame.next_source=flight->current->pixels;
        frame.destination=flight->outputs[0]->pixels;frame.shared_event=(__bridge void*)flight->event;
        frame.producer_value=1;frame.done_value=2;frame.frame_id=flight->previousID;frame.next_frame_id=flight->currentID;
        frame.phase=flight->phases.timestamps[0];
        std::vector<const void*> destinations;for(const auto &output:flight->outputs)destinations.push_back(output->pixels);
        const int accepted=flight->measureGpu?flight->owner->api->submitBatchTimed(flight->owner->provider,&frame,destinations.data(),flight->phases.timestamps.data(),destinations.size(),flight->timingToken,generationTimed,generationCompleted,held):flight->owner->api->submitBatch(flight->owner->provider,&frame,destinations.data(),flight->phases.timestamps.data(),destinations.size(),generationCompleted,held);
        if(accepted!=ML_NEURAL_RENDERED)generationCompleted(held,ML_NEURAL_FAILED,"The neural interpolator rejected this pair");
        else{id<MTLBuffer> valid=flight->valid;releaseLateProvider(flight->event,2,^{
            auto late=weak.lock();if(late&&late->providerDone.load(std::memory_order_acquire))return;
            if(valid)*static_cast<uint32_t*>(valid.contents)=0;if(late)late->expired.store(true,std::memory_order_release);});}
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        if(auto pending=weak.lock())cancelUnsubmittedGeneration(pending,"The interpolation pair was canceled before source submission");
    });
    return ML_NEURAL_RENDERED;
}
class NeuralGenerationEncoder final:public GenerationEncoder {
    id<MTLDevice> device;LsfgConfig config;std::shared_ptr<State> state;std::string operationMethod;
    std::shared_ptr<Image> previous;__weak id<MTLCommandBuffer> previousCommands;
    id<MTLSharedEvent> previousReady;
    std::vector<std::shared_ptr<GenerationFlight>> pending;uint64_t previousID=0;unsigned history=0;
    std::mutex mutex;
public:
    NeuralGenerationEncoder(id<MTLDevice> gpu,const LsfgConfig &value,std::string method="mlx-interpolation"):device(gpu),config(value),operationMethod(std::move(method)){
        if(!gpu||value.modelPath.empty()||value.multiplier<2||value.multiplier>5)throw std::runtime_error("Choose a local interpolation model and supported multiplier");
        state=std::make_shared<State>(NeuralSpec{value.modelPath,1,false,operationMethod},gpu);
        if(!state->api->submitBatch)throw std::runtime_error("Neural interpolation requires the batched generation provider");
    }
    const char *method()const noexcept override{return operationMethod.c_str();}
    bool requiresOpaque()const noexcept override{return false;}
    bool gpuTimingAvailable()const override{return state->api->submitBatchTimed&&state->api->timingSupported&&state->api->timingSupported(state->provider)==1;}
    uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure &)const override{
        // Every actual IOSurface is charged by Image::allocate, including each
        // admitted pair in a composed timeline. Do not reserve those bytes a
        // second time in the plan estimate. MLX's opaque model allocations are
        // covered by device headroom rather than an invented exact size.
        return 0;
    }
    GenerationResult encode(id<MTLCommandBuffer> commands,id<MTLTexture> source,
        const std::vector<id<MTLTexture>> &outputs,uint64_t sequence,const InterpolationPlan &phases)override{return encodeColorTimed(commands,source,outputs,sequence,phases,false,false);}
    GenerationResult encodeColorTimed(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases,bool,bool measureGpu)override{
        @autoreleasepool {
        GenerationResult result;result.frameId=sequence;
        if(!commands||!source||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||commands.device!=device||source.device!=device||!format(source.pixelFormat)||source.textureType!=MTLTextureType2D||source.sampleCount!=1||source.framebufferOnly||!(source.usage&MTLTextureUsageShaderRead)){
            result.reason="Neural interpolation requires an unsubmitted readable SDR image";return result;
        }
        if(phases.count>config.multiplier-1||phases.count>phases.timestamps.size()||outputs.size()!=phases.count){result.reason="Interpolation outputs must match the selected phase plan";return result;}
        float prior=0;
        for(size_t i=0;i<outputs.size();++i){const auto output=outputs[i];bool duplicate=false;for(size_t j=0;j<i;++j)duplicate|=outputs[j]==output;
            if(!std::isfinite(phases.timestamps[i])||phases.timestamps[i]<=prior||phases.timestamps[i]>=1||!output||output==source||duplicate||output.device!=device||output.width!=source.width||output.height!=source.height||!format(output.pixelFormat)||output.framebufferOnly||!(output.usage&MTLTextureUsageShaderWrite)){
                result.reason="Neural interpolation requires distinct matching outputs and increasing phases";return result;
            }prior=phases.timestamps[i];
        }
        std::lock_guard guard(mutex);
        pending.erase(std::remove_if(pending.begin(),pending.end(),[&](const auto &flight){
            auto original=flight->commands;
            if(!original||original!=commands&&original.status<MTLCommandBufferStatusCommitted)cancelUnsubmittedGeneration(flight,"The unsubmitted interpolation pair was replaced by a later source");
            const bool abandoned=flight->providerDone.load()&&(!original||original!=commands&&original.status<MTLCommandBufferStatusCommitted);
            return abandoned||flight->providerDone.load()&&(flight->fence.completed()||flight->fence.failed());
        }),pending.end());
        if(std::any_of(pending.begin(),pending.end(),[](const auto &flight){return flight->expired.load()&&!flight->providerDone.load();})){result.reason=lateInference;return result;}
        if(pending.size()>=32){result.busy=true;result.reason="The neural interpolation pair capacity is in use";return result;}
        {std::lock_guard lock(state->lock);if(state->unavailable()){result.reason=retrying(state->lastError);return result;}}
        try{
            auto current=std::make_shared<Image>();current->allocate(device,source.width,source.height);
            ShaderFrame context;context.commands=commands;context.source=source;context.target=current->texture;context.frameId=sequence;context.opaqueDisplay=false;
            state->copyModelFrame(context,current->texture);
            auto currentReady=[device newSharedEvent];if(!currentReady)throw std::runtime_error("Cannot retain the neural source dependency");
            [commands encodeSignalEvent:currentReady value:1];
            auto precedingCommands=previousCommands;
            const bool reset=!previous||previous->texture.width!=source.width||previous->texture.height!=source.height||sequence<=previousID||
                ((!previousReady||previousReady.signaledValue<1)&&(!precedingCommands||precedingCommands!=commands&&precedingCommands.status<MTLCommandBufferStatusCommitted));
            if(reset||outputs.empty()){
                previous=current;previousID=sequence;previousCommands=commands;previousReady=currentReady;history=1;
                for(auto output:outputs)state->copyModelFrame(context,output);
                [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)current;}];
                result.encoded=true;result.historyFrames=history;result.reason="Waiting for the next input image";return result;
            }
            auto flight=std::make_shared<GenerationFlight>();flight->owner=state;flight->previous=previous;flight->current=current;
            flight->previousID=previousID;flight->currentID=sequence;flight->phases=phases;flight->commands=commands;flight->fence.bind(commands);flight->event=[device newSharedEvent];
            if(!flight->event)throw std::runtime_error("Cannot synchronize neural interpolation");
            flight->valid=[device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
            if(!flight->valid)throw std::runtime_error("Cannot retain neural interpolation validity");*static_cast<uint32_t*>(flight->valid.contents)=1;
            for(auto output:outputs){auto image=std::make_shared<Image>();image->allocate(device,source.width,source.height);state->copyModelFrame(context,image->texture);flight->outputs.push_back(image);}
            // Retain every encoded image through the actual buffer even if a
            // later output encode rejects this source before publication.
            [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){flight->fence.observe(completed);flight->gpuDone.store(true,std::memory_order_release);}];
            flight->measureGpu=measureGpu&&gpuTimingAvailable();if(flight->measureGpu)flight->timingToken=neuralTimingTokens.fetch_add(1,std::memory_order_relaxed);
            const int accepted=submitGenerationPhase(flight);
            if(accepted!=ML_NEURAL_RENDERED){result.busy=accepted==ML_NEURAL_BUSY;result.reason="The neural interpolator cannot admit this pair";return result;}
            [commands encodeWaitForEvent:previousReady value:1];
            [commands encodeSignalEvent:flight->event value:1];[commands encodeWaitForEvent:flight->event value:2];
            for(size_t i=0;i<outputs.size();++i){auto resolved=context;resolved.target=outputs[i];state->copyModelFrame(resolved,outputs[i],flight->outputs[i]->texture,flight->valid,true);}
            previous=current;previousID=sequence;previousCommands=commands;previousReady=currentReady;pending.push_back(flight);
            result.encoded=true;result.ready=true;result.generated=outputs.size();result.historyFrames=++history;
            if(flight->measureGpu)result.gpuTiming=[flight]{return flight->fence.completed()&&flight->providerDone.load(std::memory_order_acquire)&&flight->result.load(std::memory_order_relaxed)==ML_NEURAL_RENDERED?flight->gpuNanoseconds.load(std::memory_order_acquire):uint64_t(0);};
            result.completion=[flight]{
                if(flight->submission.load(std::memory_order_acquire)==2)return ShaderResult{false,flight->message,true};
                if(flight->expired.load(std::memory_order_acquire))return ShaderResult{false,lateInference};
                if(!flight->providerDone.load(std::memory_order_acquire))return ShaderResult{false,"Neural interpolation completion is pending",true};
                if(!flight->fence.completed())return ShaderResult{false,flight->fence.failed()?"Neural interpolation GPU work failed":"Neural interpolation GPU work is pending",!flight->fence.failed()};
                return flight->result.load(std::memory_order_relaxed)==ML_NEURAL_RENDERED&&*static_cast<const uint32_t*>(flight->valid.contents)?ShaderResult{true,{}}:ShaderResult{false,flight->message.empty()?"Neural interpolation did not generate this pair":flight->message};
            };return result;
        }catch(const ImageBudgetExceeded&){throw;}
        catch(const std::exception &error){result.reason=error.what();return result;}
        }
    }
};
}
struct NeuralDepthEstimator::Impl:std::enable_shared_from_this<NeuralDepthEstimator::Impl> {
    struct Request {
        unsigned width=0,height=0,networkWidth=0,networkHeight=0,inputSize=252;
        MTLPixelFormat format=MTLPixelFormatInvalid;FrameOrigin origin=FrameOrigin::TopLeft;
        ImageColorDescription color;
        bool operator==(const Request &r)const{return width==r.width&&height==r.height&&networkWidth==r.networkWidth&&networkHeight==r.networkHeight&&inputSize==r.inputSize&&format==r.format&&origin==r.origin&&sameImageColorDescription(color,r.color);}
    };
    struct Resources {
        Request request;std::shared_ptr<State> state;std::unique_ptr<ColorEncoder> conversion;
        ColorConversion ingress;id<MTLComputePipelineState> clear;
    };
    struct Preparation {std::shared_ptr<Impl> owner;std::shared_ptr<Resources> resources;};
    id<MTLDevice> device;NeuralDepthSpec spec;
    mutable std::mutex mutex;bool preparing=false;std::string error;std::optional<Request> attempted;
    std::chrono::steady_clock::time_point retryPreparation{};std::chrono::milliseconds preparationDelay{0};
    void preparationFailed(std::string reason){error=std::move(reason);preparationDelay=preparationDelay.count()?std::min(preparationDelay*2,std::chrono::milliseconds(30000)):std::chrono::milliseconds(1000);retryPreparation=std::chrono::steady_clock::now()+preparationDelay;}
    std::shared_ptr<Resources> ready;std::shared_ptr<State> modelState;
    static dispatch_queue_t work(){static auto queue=dispatch_queue_create("MacLauncher relative depth preparation",DISPATCH_QUEUE_SERIAL);return queue;}
    static dispatch_queue_t retire(){static auto queue=dispatch_queue_create("MacLauncher relative depth retirement",DISPATCH_QUEUE_SERIAL);return queue;}
    Impl(id<MTLDevice>gpu,const NeuralDepthSpec&options):device(gpu),spec(options){
        if(!gpu||spec.modelPath.empty()||spec.modelPath.front()!='/'||spec.inputSize<14||spec.inputSize>4096||spec.inputSize%14)
            throw std::invalid_argument("Choose a local relative-depth model and an input size divisible by fourteen");
    }
    std::optional<Request> request(const ShaderFrame&f,const ImageColorDescription&color,unsigned inputSize,std::string&reason)const{
        if(inputSize<14||inputSize>4096||inputSize%14){reason="Relative-depth input size must be a positive multiple of fourteen up to 4088";return {};}
        if(!f.commands||!f.source||f.commands.device!=device||f.source.device!=device||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences){reason="Relative depth requires actual retaining unsubmitted Metal commands";return {};}
        if(!color.valid()||!imageRGBFormat(f.source.pixelFormat)||f.source.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.source.framebufferOnly||!(f.source.usage&MTLTextureUsageShaderRead)||!f.source.width||!f.source.height||f.source.width>16384||f.source.height>16384){reason="Relative depth requires resolved readable RGB input and explicit color metadata";return {};}
        Request r;r.width=f.source.width;r.height=f.source.height;r.format=f.source.pixelFormat;r.origin=f.origin;r.color=color;r.inputSize=inputSize;
        const double scale=std::max(double(inputSize)/r.width,double(inputSize)/r.height);
        const auto extent=[&](unsigned source){return std::max(inputSize,unsigned(std::lround(source*scale/14))*14);};
        r.networkWidth=extent(r.width);r.networkHeight=extent(r.height);
        if(r.networkWidth>4096||r.networkHeight>4096){reason="The aspect-preserving relative-depth grid exceeds the scalar provider's 4096-pixel extent";return {};}
        return r;
    }
    static void prepared(void*pointer,int status,const char*message){
        std::unique_ptr<Preparation>job(static_cast<Preparation*>(pointer));auto owner=job->owner;
        std::lock_guard guard(owner->mutex);owner->preparing=false;
        if(status==ML_NEURAL_RENDERED){
            auto state=job->resources->state;{std::lock_guard lock(state->lock);++state->historyRevision;state->cachedImages.reset();}
            owner->ready=job->resources;owner->error.clear();owner->preparationDelay={};
        }else owner->preparationFailed(message&&*message?message:"Relative-depth model resources could not be prepared");
    }
    ShaderResult prepare(const ShaderFrame&frame,const ImageColorDescription&color,unsigned inputSize){
        std::string reason;auto requested=request(frame,color,inputSize,reason);if(!requested)return {false,reason};
        std::unique_lock guard(mutex,std::try_to_lock);if(!guard)return {false,"Relative-depth resources are preparing",true};
        if(ready&&ready->request==*requested)return {true,{}};
        if(preparing)return {false,"Relative-depth model resources are preparing",true};
        if(attempted&&*attempted==*requested&&!error.empty()&&std::chrono::steady_clock::now()<retryPreparation)return {false,error};
        attempted=*requested;preparing=true;error.clear();auto owner=shared_from_this();const auto next=*requested;
        dispatch_async(work(),^{@autoreleasepool{
            std::shared_ptr<Resources>resources;
            try{
                resources=std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retire(),^{delete p;});});resources->request=next;
                if(!owner->modelState){NeuralSpec options;options.modelPath=owner->spec.modelPath;options.method="depth-anything-v2-small";owner->modelState=std::shared_ptr<State>(new State(options,owner->device),[](State*p){dispatch_async(retire(),^{delete p;});});}
                resources->state=owner->modelState;
                {std::lock_guard lock(resources->state->lock);if(resources->state->failed)throw std::runtime_error(resources->state->lastError);if(!resources->state->acquire(next.width,next.height,next.networkWidth,next.networkHeight))throw std::runtime_error("Relative-depth images are in use");}
                resources->conversion=std::make_unique<ColorEncoder>(owner->device);auto converted=resources->conversion->prepare(MTLPixelFormatBGRA8Unorm);if(!converted.encoded)throw std::runtime_error(converted.reason);
                resources->ingress.source=next.color;resources->ingress.target=describeImageColor(ImageColorSpace::SRGB);resources->ingress.target.alpha=ColorAlpha::Opaque;
                resources->ingress.flipY=next.origin==FrameOrigin::BottomLeft;
                if(next.color.peakLuminance>next.color.referenceWhite||next.color.transfer==ColorTransfer::PQ||next.color.transfer==ColorTransfer::HLG)resources->ingress.toneMap=ColorToneMap::Reinhard;
                NSError*failure=nil;auto library=cachedMetalLibrary(owner->device,"#include <metal_stdlib>\nusing namespace metal;kernel void clear_depth(texture2d<float,access::write> target[[texture(0)]],uint2 p[[thread_position_in_grid]]){if(all(p<uint2(target.get_width(),target.get_height())))target.write(float4(0),p);}",&failure);
                auto function=[library newFunctionWithName:@"clear_depth"];resources->clear=function?[owner->device newComputePipelineStateWithFunction:function error:&failure]:nil;
                if(!resources->clear)throw std::runtime_error(failure.localizedDescription.UTF8String?:"Cannot prepare scalar depth initialization");
                auto job=new Preparation{owner,resources};const auto accepted=resources->state->api->prepareDepth(resources->state->provider,next.networkWidth,next.networkHeight,prepared,job);
                if(accepted!=ML_NEURAL_RENDERED)prepared(job,ML_NEURAL_FAILED,accepted==ML_NEURAL_BUSY?"The relative-depth model worker is in use":"The scalar provider cannot prepare this model grid");
            }catch(const std::exception&e){std::lock_guard lock(owner->mutex);owner->preparationFailed(e.what());owner->preparing=false;}
        }});
        return {false,"Relative-depth model resources are preparing",true};
    }
    ShaderResult status()const{
        std::unique_lock guard(mutex,std::try_to_lock);if(!guard||preparing)return {false,"Relative-depth model resources are preparing",true};
        return error.empty()?ShaderResult{true,{}}:ShaderResult{false,error};
    }
    EstimatedDepthAttachment attachment(const std::shared_ptr<Flight>&flight,const NeuralInputStamp&stamp)const{
        EstimatedDepthAttachment a;a.texture=flight->images->destination.texture;a.validity=flight->valid;a.contentId=stamp.contentId;a.epoch=stamp.epoch;a.imageRevision=stamp.imageRevision;a.observationId=stamp.observationId;
        a.inputIdentity=stamp.inputIdentity;a.modelIdentity=spec.modelPath;a.synthetic=stamp.synthetic;a.sourceWidth=flight->images->width;a.sourceHeight=flight->images->height;a.storage=flight;
        a.completion=[flight]{
            if(flight->submission.load(std::memory_order_acquire)==2)return ShaderResult{false,"The neural source was not submitted",true};
            // A consumer's fence handler may run before this node's later
            // registered handler. The command's actual Completed status is
            // sufficient GPU authority; callback registration order is not.
            if(!flight->providerDone.load(std::memory_order_acquire))return ShaderResult{false,"Relative-depth completion metadata is pending",true};
            if(!flight->fence.completed())return ShaderResult{false,flight->fence.failed()?"Relative-depth GPU work failed":"Relative-depth GPU work is pending",!flight->fence.failed()};
            if(flight->result.load(std::memory_order_relaxed)==ML_NEURAL_RENDERED&&*static_cast<const uint32_t*>(flight->valid.contents))return ShaderResult{true,{}};
            std::lock_guard guard(flight->owner->lock);return ShaderResult{false,flight->owner->lastError.empty()?"Relative depth was not produced for this image":flight->owner->lastError};
        };a.gpuTiming=timingTicket(flight);return a;
    }
    NeuralDepthResult encode(const ShaderFrame&frame,const NeuralInputStamp&stamp,bool,bool displayMapped,unsigned expectedInputSize,bool measureGpu){
        std::shared_ptr<Resources>resources;{std::unique_lock guard(mutex,std::try_to_lock);if(!guard)return {{false,"Relative-depth resources are preparing",true},{}};resources=ready;}
        if(!resources)return {{false,"Relative-depth model resources are preparing",true},{}};
        if(!expectedInputSize)expectedInputSize=spec.inputSize;
        if(resources->request.inputSize!=expectedInputSize)return {{false,"The selected relative-depth input size is preparing",true},{}};
        std::string reason;auto requested=request(frame,resources->request.color,expectedInputSize,reason);if(!requested)return {{false,reason},{}};
        if(!(*requested==resources->request))return {{false,"Relative-depth source geometry or origin is preparing",true},{}};
        auto selected=resources->state;std::unique_lock guard(selected->lock,std::try_to_lock);if(!guard)return {{false,"Relative-depth inference is busy",true},{}};
        if(selected->unavailable())return {{false,retrying(selected->lastError)},{}};
        InputStamp identity(stamp,frame,true);identity.outputWidth=resources->request.networkWidth;identity.outputHeight=resources->request.networkHeight;identity.displayMapped=displayMapped;
        adoptCompletedImageCache(*selected,selected->pending.lock());
        if(selected->cachedImages&&selected->cachedStamp==identity){
            auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=selected->cachedImages;flight->commands=frame.commands;flight->fence.bind(frame.commands);
            flight->valid=[device newBufferWithLength:4 options:MTLResourceStorageModeShared];if(!flight->valid)return {{false,"Cannot retain relative-depth cache validity"},{}};
            *static_cast<uint32_t*>(flight->valid.contents)=1;flight->timingCacheOnly=true;flight->result.store(ML_NEURAL_RENDERED,std::memory_order_relaxed);flight->providerDone.store(true,std::memory_order_release);
            [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);if(commands.status!=MTLCommandBufferStatusCompleted){flight->result.store(ML_NEURAL_FAILED,std::memory_order_relaxed);*static_cast<uint32_t*>(flight->valid.contents)=0;}flight->gpuDone.store(true,std::memory_order_release);}];
            return {{true,{}},attachment(flight,stamp)};
        }
        if(auto flight=selected->pending.lock()){
            if(flight->expired.load(std::memory_order_acquire)&&!flight->providerDone.load(std::memory_order_acquire))return {{false,lateInference},{}};
            auto commands=flight->commands;
            if((commands!=frame.commands||flight->stamp==identity)&&(!flight->providerDone.load(std::memory_order_acquire)||!(flight->fence.completed()||flight->fence.failed())))return {{false,"Relative-depth inference is busy",true},{}};
        }
        const auto&r=resources->request;auto images=selected->acquire(r.width,r.height,r.networkWidth,r.networkHeight);if(!images)return {{false,"Relative-depth images are in use",true},{}};
        auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=images;flight->commands=frame.commands;flight->fence.bind(frame.commands);flight->valid=[device newBufferWithLength:4 options:MTLResourceStorageModeShared];flight->event=[device newSharedEvent];
        if(!flight->valid||!flight->event)return {{false,"Cannot synchronize relative-depth inference"},{}};
        *static_cast<uint32_t*>(flight->valid.contents)=1;flight->producer=selected->eventValue+1;flight->done=flight->producer+1;selected->eventValue=flight->done;
        auto ingress=resources->ingress;ingress.frameId=frame.frameId;if(displayMapped)ingress.toneMap=ColorToneMap::Preserve;auto converted=resources->conversion->encode(frame.commands,frame.source,images->source.texture,ingress);if(!converted.encoded)return {converted,{}};
        auto clear=[frame.commands computeCommandEncoder];if(!clear)return {{false,"Cannot initialize scalar relative-depth output"},{}};
        [clear setComputePipelineState:resources->clear];[clear setTexture:images->destination.texture atIndex:0];[clear dispatchThreads:MTLSizeMake(r.networkWidth,r.networkHeight,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[clear endEncoding];
        flight->frameId=++selected->scheduled;flight->observationId=stamp.observationId;flight->serial=flight->frameId;flight->stamped=true;flight->stamp=identity;flight->historyRevision=selected->historyRevision;flight->reset=true;
        flight->measureGpu=measureGpu&&selected->api->submitTimed&&selected->api->timingSupported&&selected->api->timingSupported(selected->provider)==1;if(flight->measureGpu)flight->timingToken=neuralTimingTokens.fetch_add(1,std::memory_order_relaxed);
        if(neuralDiagnosticsEnabled())flight->started=DiagnosticClock::now();selected->pending=flight;scheduleImage(flight);
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){
            flight->fence.observe(commands);
            flight->gpuDone.store(true,std::memory_order_release);
            if(commands.status!=MTLCommandBufferStatusCompleted){*static_cast<uint32_t*>(flight->valid.contents)=0;return;}
            if(!flight->providerDone.load(std::memory_order_acquire)||flight->result.load(std::memory_order_relaxed)!=ML_NEURAL_RENDERED)return;
            auto owner=flight->owner;std::lock_guard lock(owner->lock);adoptCompletedImageCache(*owner,flight);
        }];
        [frame.commands encodeSignalEvent:flight->event value:flight->producer];[frame.commands encodeWaitForEvent:flight->event value:flight->done];
        auto result=attachment(flight,stamp);[frame.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)resources;(void)flight;}];return {{true,{}},std::move(result)};
    }
};
NeuralDepthEstimator::NeuralDepthEstimator(id<MTLDevice>device,const NeuralDepthSpec&spec):impl(new Impl(device,spec),[](Impl*p){dispatch_async(Impl::retire(),^{delete p;});}){}
NeuralDepthEstimator::~NeuralDepthEstimator()=default;
ShaderResult NeuralDepthEstimator::prepare(const ShaderFrame&f,const ImageColorDescription&c){return impl->prepare(f,c,impl->spec.inputSize);}
ShaderResult NeuralDepthEstimator::prepare(const ShaderFrame&f,const ImageColorDescription&c,unsigned inputSize){return impl->prepare(f,c,inputSize);}
ShaderResult NeuralDepthEstimator::preparationStatus()const{return impl->status();}
bool NeuralDepthEstimator::gpuTimingAvailable()const{std::unique_lock guard(impl->mutex,std::try_to_lock);const auto r=guard?impl->ready:nullptr;return r&&r->state->api->timingSupported&&r->state->api->submitTimed&&r->state->api->timingSupported(r->state->provider)==1;}
NeuralDepthResult NeuralDepthEstimator::encode(const ShaderFrame&f,const NeuralInputStamp&s,bool redraw,bool mapped,unsigned inputSize,bool measureGpu){try{return impl->encode(f,s,redraw,mapped,inputSize,measureGpu);}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return {{false,e.what()},{}};}}
std::shared_ptr<ShaderNode> makeNeuralNode(const NeuralSpec &spec){
    if(spec.method!="mlx-dlss"&&spec.method!="mlx-vsr"&&spec.method!="mlx-sr-image"&&spec.method!="realesrgan"&&spec.method!="nafnet"&&spec.method!="realcugan")throw std::runtime_error("Choose a supported neural image operation");
    if(spec.modelPath.empty()||spec.modelPath.front()!='/'||!std::isfinite(spec.intensity)||spec.intensity<0||spec.intensity>2||!std::isfinite(spec.denoiseStrength)||spec.denoiseStrength<0||spec.denoiseStrength>1)
        throw std::runtime_error("Choose a local neural model and an intensity from 0 to 2");
    auto selected=spec;
    if(spec.method=="realcugan"){
        NSString*file=[@(spec.modelPath.c_str()) stringByAppendingPathComponent:@"manifest.json"];
        const auto attributes=[[NSFileManager defaultManager]attributesOfItemAtPath:file error:nil];
        const auto size=[attributes[NSFileSize]unsignedLongLongValue];
        if(!size||size>1048576)throw std::runtime_error("Choose a complete bounded Real-CUGAN model manifest");
        NSData*bytes=[NSData dataWithContentsOfFile:file];
        id decoded=bytes?[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil]:nil;
        NSString*architecture=[decoded isKindOfClass:NSDictionary.class]?decoded[@"architecture"]:nil;
        const unsigned scale=[architecture isEqual:@"realcugan.upcunet2x.v1"]?2:[architecture isEqual:@"realcugan.upcunet3x.v1"]?3:[architecture isEqual:@"realcugan.upcunet4x.v1"]?4:0;
        if(!scale||(spec.intrinsicScale&&spec.intrinsicScale!=scale))throw std::runtime_error("The Real-CUGAN output scale must match its typed model architecture");
        selected.intrinsicScale=scale;
    }else{
        const unsigned scale=(spec.method=="mlx-dlss"||spec.method=="nafnet")?1:spec.method=="realesrgan"?4:2;
        if(spec.intrinsicScale&&spec.intrinsicScale!=scale)throw std::runtime_error("The neural output scale must match its operation's typed model contract");
        selected.intrinsicScale=scale;
    }
    return std::make_shared<NeuralNode>(selected);
}
void setNeuralStatusContext(const std::shared_ptr<ShaderNode>&node,uintptr_t owner,std::string_view stage,std::string_view revision){if(const auto neural=std::dynamic_pointer_cast<NeuralNode>(node))neural->statusContext(owner,stage,revision);}
void setNeuralInputColor(const std::shared_ptr<ShaderNode>&node,const ImageColorDescription &color){if(const auto neural=std::dynamic_pointer_cast<NeuralNode>(node))neural->inputColor(color);}
bool neuralGpuTimingAvailable(const std::shared_ptr<ShaderNode>&node){const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);return neural&&neural->gpuTimingAvailable();}
ShaderResult encodeNeuralStamped(const std::shared_ptr<ShaderNode>&node,const ShaderFrame &frame,const NeuralInputStamp &stamp,bool redraw,NeuralGpuTimingTicket*timing){
    const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);
    return neural?neural->encodeStamped(frame,&stamp,redraw,timing):ShaderResult{false,"Invalid neural image stage"};
}
std::function<ShaderResult()>neuralImageCompletionTicket(const std::shared_ptr<ShaderNode>&node){const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);return neural?neural->ticket():std::function<ShaderResult()>{};}
ShaderResult warmNeuralNode(const std::shared_ptr<ShaderNode>&node,const ShaderFrame &frame){
    const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);
    return neural?neural->warmup(frame):ShaderResult{false,"Invalid neural image stage"};
}
ShaderResult neuralWarmupStatus(const std::shared_ptr<ShaderNode>&node){
    const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);
    return neural?neural->warmupStatus():ShaderResult{false,"Invalid neural image stage"};
}
ShaderResult finishNeuralNode(const std::shared_ptr<ShaderNode> &node){
    const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);
    return neural?neural->finishOffline():ShaderResult{false,"Invalid neural video stage"};
}
std::shared_ptr<GenerationEncoder> makeRifeGenerationEncoder(id<MTLDevice> device,const LsfgConfig &config){return std::make_shared<NeuralGenerationEncoder>(device,config,"rife");}
std::shared_ptr<GenerationEncoder> makeNeuralGenerationEncoder(id<MTLDevice> device,const LsfgConfig &config){return std::make_shared<NeuralGenerationEncoder>(device,config);}
std::shared_ptr<NeuralSceneEncoder> makeNeuralSceneEncoder(id<MTLDevice> device,const NeuralSpec &spec){return std::make_shared<SceneEncoder>(device,spec);}
}

extern "C" uint32_t rsNeuralGpuTimingAPI(void){return 1;}
