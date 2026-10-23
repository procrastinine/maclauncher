// Copyright (c) MacLauncher contributors. MIT license.
#include "neural-node.hpp"
#include "frame-capture.hpp"
#include "neural-provider.h"
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
#include <unistd.h>

namespace macfx {
namespace {
bool neuralDiagnosticsEnabled(){static const bool enabled=[](){const auto path=std::getenv("RESHADE_DIAGNOSTICS");return path&&*path;}();return enabled;}
using DiagnosticClock=std::chrono::steady_clock;
struct NeuralDiagnostics {
    std::mutex lock;FILE *output=nullptr;uint64_t rows=0,observed=0,rendered=0,inferred=0,cacheHits=0,passthrough=0,failed=0,busy=0;
    DiagnosticClock::time_point last{},flushed{};
    NeuralDiagnostics(){const auto path=std::string(std::getenv("RESHADE_DIAGNOSTICS"))+".neural."+std::to_string(getpid())+".jsonl";output=std::fopen(path.c_str(),"a");}
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
    Create create=nullptr;
    std::string path;
    void *handle=nullptr;
    explicit Library(const std::string &file):path(file){
        handle=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);
        if(!handle)throw std::runtime_error(std::string("Neural rendering is unavailable: ")+(dlerror()?:"Cannot load its provider"));
        create=reinterpret_cast<Create>(dlsym(handle,"ml_neural_create_with_options"));
        submit=reinterpret_cast<decltype(submit)>(dlsym(handle,"ml_neural_submit"));
        destroy=reinterpret_cast<decltype(destroy)>(dlsym(handle,"ml_neural_destroy"));
        if(!create||!submit||!destroy){dlclose(handle);handle=nullptr;throw std::runtime_error("The neural-rendering provider has an incompatible API");}
    }
};
std::shared_ptr<Library> library(){
#if !defined(__arm64__)
    throw std::runtime_error("Neural rendering requires Apple Silicon");
#else
    if(@available(macOS 14.0,*)){}else throw std::runtime_error("Neural rendering requires macOS 14 or later");
    const char *file=std::getenv("RESHADE_NEURAL_LIBRARY");
    if(!file||*file!='/')throw std::runtime_error("The neural-rendering provider is unavailable");
    // Swift tasks and completion callbacks can outlive their last native row.
    // Keep the fixed provider code loaded until the game process exits.
    static auto *loaded=new std::vector<std::shared_ptr<Library>>;
    static std::mutex lock;std::lock_guard<std::mutex>guard(lock);
    for(const auto &item:*loaded)if(item->path==file)return item;
    auto value=std::make_shared<Library>(file);loaded->push_back(value);return value;
#endif
}
struct Image {
    CVPixelBufferRef pixels=nullptr;
    id<MTLTexture> texture;
    std::shared_ptr<ImageReservation> reservation;
    ~Image(){if(pixels)CVPixelBufferRelease(pixels);}
    void allocate(id<MTLDevice> device,unsigned width,unsigned height){
        reservation=reserveImageBytes(device,alignedImageBytes(width,height,4),0,"neural-memory",true);
        NSDictionary *properties=@{(__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,
            (__bridge NSString*)kCVPixelBufferBytesPerRowAlignmentKey:@256,
            (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        if(CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,
            (__bridge CFDictionaryRef)properties,&pixels)!=kCVReturnSuccess)
            throw std::runtime_error("Cannot allocate a neural-rendering frame");
        auto surface=CVPixelBufferGetIOSurface(pixels);
        reservation->commit(CVPixelBufferGetDataSize(pixels));
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
        texture=[device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
        if(!texture)throw std::runtime_error("Cannot bind a neural-rendering frame to Metal");
        attachImageReservation(texture,reservation);
    }
};
struct Images {Image source,destination;unsigned width=0,height=0;};
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
struct NeuralObservation {uintptr_t context=0;std::string stage,revision;};
struct State;
struct Flight {
    std::shared_ptr<State> owner;std::shared_ptr<const NeuralObservation> observation;
    std::shared_ptr<Images> images;
    id<MTLSharedEvent> event;
    __weak id<MTLCommandBuffer> commands;
    std::atomic<bool> providerDone{false},gpuDone{false};
    uint64_t frameId=0;DiagnosticClock::time_point started{};bool opaqueDisplay=false;
};
struct State {
    std::shared_ptr<Library> api;
    MLNeuralProvider provider=nullptr;
    id<MTLDevice> device;
    id<MTLComputePipelineState> modelInput,restoreAlpha;
    std::vector<std::shared_ptr<Images>> slots;
    std::weak_ptr<Flight> pending;
    std::mutex lock;
    std::condition_variable completion;
    int lastStatus=ML_NEURAL_RENDERED;
    uint64_t eventValue=0,lastFrame=0;
    unsigned lastWidth=0,lastHeight=0;double lastTimeMs=0;
    bool hasFrame=false,failed=false,unsupported=false,unsupportedOpaque=false;
    unsigned unsupportedWidth=0,unsupportedHeight=0;
    std::string lastError;
    State(const NeuralSpec &spec,id<MTLDevice> gpu):api(library()),device(gpu){
        if(gpu.registryID!=MTLCreateSystemDefaultDevice().registryID)throw std::runtime_error("Neural rendering requires the system Metal device");
        char error[512]{};provider=api->create(spec.modelPath.c_str(),spec.intensity,spec.temporal,error,sizeof(error));
        if(!provider)throw std::runtime_error(error[0]?error:"Cannot create neural rendering");
    }
    ~State(){if(provider)api->destroy(provider);}
    void copyModelFrame(const ShaderFrame &frame,id<MTLTexture> target,id<MTLTexture> model=nil){
        if(!modelInput){
            NSError *error=nil;
            auto code=@"#include <metal_stdlib>\nusing namespace metal;kernel void model_input(texture2d<float,access::read> source [[texture(0)]],texture2d<float,access::write> target [[texture(1)]],constant uint2 &control [[buffer(0)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height()){uint2 q=uint2(p.x,control.y?target.get_height()-1-p.y:p.y);float4 c=source.read(q);if(control.x)c.a=1;target.write(c,p);}}kernel void restore_alpha(texture2d<float,access::read> source [[texture(0)]],texture2d<float,access::read> model [[texture(1)]],texture2d<float,access::write> target [[texture(2)]],constant uint2 &control [[buffer(0)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height()){uint2 q=uint2(p.x,control.y?target.get_height()-1-p.y:p.y);float4 c=model.read(q);c.a=source.read(p).a;target.write(c,p);}}";
            auto library=[device newLibraryWithSource:code options:nil error:&error];
            if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare opaque neural input");
            modelInput=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"model_input"] error:&error];
            restoreAlpha=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"restore_alpha"] error:&error];
            if(!modelInput||!restoreAlpha)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare neural alpha preservation");
        }
        auto encoder=[frame.commands computeCommandEncoder];
        if(!encoder)throw std::runtime_error("Cannot encode neural alpha preservation");
        uint32_t control[]={frame.opaqueDisplay?1u:0u,frame.origin==FrameOrigin::BottomLeft?1u:0u};
        [encoder setComputePipelineState:model?restoreAlpha:modelInput];[encoder setTexture:frame.source atIndex:0];
        [encoder setTexture:model?:target atIndex:1];if(model)[encoder setTexture:target atIndex:2];
        [encoder setBytes:control length:sizeof(control) atIndex:0];
        [encoder dispatchThreads:MTLSizeMake(target.width,target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
    }
    std::shared_ptr<Images> acquire(unsigned width,unsigned height){
        for(const auto &slot:slots)if(slot.use_count()==1&&slot->width==width&&slot->height==height)return slot;
        slots.erase(std::remove_if(slots.begin(),slots.end(),[&](const auto &slot){return slot.use_count()==1&&(slot->width!=width||slot->height!=height);}),slots.end());
        if(slots.size()>=4)return {};
        auto slot=std::make_shared<Images>();slot->width=width;slot->height=height;
        slot->source.allocate(device,width,height);slot->destination.allocate(device,width,height);slots.push_back(slot);return slot;
    }
};
void completed(void *context,int status,const char *message){
    std::unique_ptr<std::shared_ptr<Flight>> held(static_cast<std::shared_ptr<Flight>*>(context));auto flight=*held;
    if(flight->observation){RuntimeStatusEvent event;event.context=flight->observation->context;event.processing=true;event.phase=status==ML_NEURAL_RENDERED?RuntimeStatusPhase::Completed:RuntimeStatusPhase::Bypassed;
        event.planRevision=flight->observation->revision;event.stageId=flight->observation->stage;event.requestedMethod="mlx-dlss";
        event.activeMethod=status==ML_NEURAL_RENDERED?(message&&!std::strcmp(message,"Exact-frame cache")?"mlx-dlss-cache":"mlx-dlss"):"passthrough";
        event.reason=message?message:"";event.frameId=flight->frameId;event.inputWidth=event.outputWidth=flight->images->width;event.inputHeight=event.outputHeight=flight->images->height;observeRuntimeStatus(event);}
    neuralDiagnostic(flight->frameId,flight->images->width,flight->images->height,status,true,flight->started,status==ML_NEURAL_RENDERED&&message&&!std::strcmp(message,"Exact-frame cache"));
    {std::lock_guard<std::mutex>guard(flight->owner->lock);
        // Keep an unavailable model or failed inference from repeating costly
        // work on every game frame. Unsupported input retries only after its
        // extent or verified display contract changes; model errors need a
        // changed node configuration.
        const bool unsupportedAlpha=status==ML_NEURAL_PASSTHROUGH&&message&&!std::strcmp(message,"Neural rendering requires an opaque SDR frame");
        if(unsupportedAlpha){flight->owner->unsupported=true;flight->owner->unsupportedWidth=flight->images->width;flight->owner->unsupportedHeight=flight->images->height;flight->owner->unsupportedOpaque=flight->opaqueDisplay;}
        else if(status==ML_NEURAL_FAILED||(status==ML_NEURAL_PASSTHROUGH&&message&&*message))flight->owner->failed=true;
        if(status!=ML_NEURAL_RENDERED&&message&&*message&&flight->owner->lastError!=message){
            flight->owner->lastError=message;nativeLog("Neural rendering: "+std::string(message));
        }
    }
    {std::lock_guard<std::mutex>guard(flight->owner->lock);flight->owner->lastStatus=status;flight->providerDone.store(true,std::memory_order_release);}
    flight->owner->completion.notify_all();
}
bool format(MTLPixelFormat value){return value==MTLPixelFormatBGRA8Unorm||value==MTLPixelFormatRGBA8Unorm;}
std::string invalid(const ShaderFrame &frame){
    if(!frame.commands||!frame.source||!frame.target||frame.commands.status>=MTLCommandBufferStatusCommitted)return "Neural rendering requires an unsubmitted frame";
    if(!frame.commands.retainedReferences)return "Neural rendering requires a retaining command buffer";
    if(frame.source.device!=frame.commands.device||frame.target.device!=frame.commands.device)return "Neural images must use the command buffer's Metal device";
    if(frame.color!=SpatialColor::Perceptual||!format(frame.source.pixelFormat)||!format(frame.target.pixelFormat))return "Neural rendering requires SDR RGBA8 or BGRA8 color";
    if(frame.source.width!=frame.target.width||frame.source.height!=frame.target.height)return "Neural rendering preserves the current frame dimensions";
    if(!frame.source.width||!frame.source.height||frame.source.width>16384||frame.source.height>16384)return "Neural frame dimensions are outside the supported range";
    if(frame.source.textureType!=MTLTextureType2D||frame.target.textureType!=MTLTextureType2D||frame.source.sampleCount!=1||frame.target.sampleCount!=1||frame.source.framebufferOnly||frame.target.framebufferOnly)return "Neural rendering requires accessible, resolved 2D images";
    if(!(frame.source.usage&MTLTextureUsageShaderRead)||!(frame.target.usage&MTLTextureUsageShaderWrite))return "Neural frames require readable input and writable output images";
    return {};
}
class NeuralNode final:public ShaderNode {
    NeuralSpec spec;
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
    ShaderResult prepareState(const ShaderFrame &frame,std::shared_ptr<State> &selected){
        try{
            if(auto reason=invalid(frame);!reason.empty())return {false,reason};
            selected=stateFor(frame.commands.device);
            std::lock_guard<std::mutex>guard(selected->lock);
            if(selected->failed)return {false,selected->lastError.empty()?"Neural rendering is unavailable for this frame":selected->lastError};
            if(selected->unsupported){
                if(selected->unsupportedWidth==frame.source.width&&selected->unsupportedHeight==frame.source.height&&selected->unsupportedOpaque==frame.opaqueDisplay)
                    return {false,selected->lastError.empty()?"Neural input is unsupported":selected->lastError};
                selected->unsupported=false;selected->lastError.clear();selected->hasFrame=false;
            }
            if(!selected->acquire(frame.source.width,frame.source.height))return {false,"Neural frame resources are busy",true};
            return {true,{}};
        }catch(const ImageBudgetExceeded &){throw;}
        catch(const std::exception &error){return {false,error.what()};}
    }
public:
    void statusContext(uintptr_t owner,std::string_view stage,std::string_view revision){if(!owner)return;std::lock_guard guard(observationMutex);if(observation&&observation->context==owner&&observation->stage==stage&&observation->revision==revision)return;auto value=std::make_shared<NeuralObservation>();value->context=owner;value->stage=stage;value->revision=revision;observation=std::move(value);}
    explicit NeuralNode(const NeuralSpec &value):spec(value){}
    ShaderResult finishOffline(){
        std::shared_ptr<State> selected;{std::lock_guard<std::mutex>guard(stateMutex);selected=state;}
        if(!selected)return {false,"The neural stage was not initialized"};
        std::unique_lock<std::mutex>guard(selected->lock);
        const auto flight=selected->pending.lock();
        if(flight&&!selected->completion.wait_for(guard,std::chrono::seconds(5),[&]{return flight->providerDone.load(std::memory_order_acquire);}))
            return {false,"Neural video processing did not report completion"};
        if(selected->failed||selected->unsupported||selected->lastStatus!=ML_NEURAL_RENDERED)
            return {false,selected->lastError.empty()?"The neural stage did not render this video frame":selected->lastError};
        return {true,{}};
    }
    void setParameters(const ShaderParameters &)override{}
    ShaderResult prepare(const ShaderFrame &frame)override{
        std::shared_ptr<State> selected;return prepareState(frame,selected);
    }
    ShaderResult encode(const ShaderFrame &frame)override{
        std::shared_ptr<State> selected;
        const auto ready=prepareState(frame,selected);if(!ready.encoded){neuralDiagnostic(frame.frameId,frame.source.width,frame.source.height,ready.busy?ML_NEURAL_BUSY:ML_NEURAL_FAILED,false);return ready;}
        std::lock_guard<std::mutex>guard(selected->lock);
        if(auto pending=selected->pending.lock()){
            auto commands=pending->commands;
            const bool abandoned=pending->providerDone.load(std::memory_order_acquire)&&(!commands||commands!=frame.commands&&commands.status<MTLCommandBufferStatusCommitted);
            if(!abandoned&&(!pending->providerDone.load(std::memory_order_acquire)||!pending->gpuDone.load(std::memory_order_acquire))){neuralDiagnostic(frame.frameId,frame.source.width,frame.source.height,ML_NEURAL_BUSY,false);return {false,"Neural rendering is busy",true};}
        }
        auto images=selected->acquire(frame.source.width,frame.source.height);if(!images){neuralDiagnostic(frame.frameId,frame.source.width,frame.source.height,ML_NEURAL_BUSY,false);return {false,"Neural frame resources are busy",true};}
        auto flight=std::make_shared<Flight>();flight->owner=selected;flight->images=images;flight->event=[selected->device newSharedEvent];flight->commands=frame.commands;
        {std::lock_guard guard(observationMutex);flight->observation=observation;}
        flight->frameId=frame.frameId;flight->opaqueDisplay=frame.opaqueDisplay;if(neuralDiagnosticsEnabled())flight->started=DiagnosticClock::now();
        if(!flight->event)return {false,"Cannot create neural GPU synchronization"};
        // Initialize the destination before publishing the producer event. A
        // provider timeout can release an abandoned buffer without reading it;
        // any later submission still has a complete passthrough image.
        // The model consumes top-left rows regardless of the caller's storage
        // origin. Unknown/opaque display alpha is normalized only at ingress.
        for(auto target:{images->source.texture,images->destination.texture})selected->copyModelFrame(frame,target);
        captureNeuralInput(frame,images);
        const auto producer=selected->eventValue+1,done=producer+1;
        // Presentation may skip source frames while inference is busy. Motion
        // is estimated between the accepted images, so forward ID gaps retain
        // history; actual timeline rewinds and geometry changes start anew.
        const bool reset=!selected->hasFrame||frame.frameId<=selected->lastFrame||frame.timeMs<selected->lastTimeMs||
            frame.source.width!=selected->lastWidth||frame.source.height!=selected->lastHeight;
        auto context=new std::shared_ptr<Flight>(flight);
        const int accepted=selected->api->submit(selected->provider,images->source.pixels,images->destination.pixels,(__bridge void*)flight->event,producer,done,frame.frameId,reset,completed,context);
        if(accepted!=ML_NEURAL_RENDERED){delete context;neuralDiagnostic(frame.frameId,frame.source.width,frame.source.height,accepted,false);return {false,accepted==ML_NEURAL_BUSY?"Neural rendering is busy":"Neural rendering rejected this frame",accepted==ML_NEURAL_BUSY};}
        selected->eventValue=done;selected->lastFrame=frame.frameId;selected->lastTimeMs=frame.timeMs;
        selected->lastWidth=frame.source.width;selected->lastHeight=frame.source.height;selected->hasFrame=true;selected->pending=flight;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>){flight->gpuDone.store(true,std::memory_order_release);}];
        [frame.commands encodeSignalEvent:flight->event value:producer];
        [frame.commands encodeWaitForEvent:flight->event value:done];
        // Restore RGB to the declared storage origin and retain source alpha at
        // that original pixel, including explicitly transparent caller frames.
        selected->copyModelFrame(frame,frame.target,images->destination.texture);return {true,{}};
    }
};
}
std::shared_ptr<ShaderNode> makeNeuralNode(const NeuralSpec &spec){
    if(spec.modelPath.empty()||spec.modelPath.front()!='/'||!std::isfinite(spec.intensity)||spec.intensity<0||spec.intensity>2)
        throw std::runtime_error("Choose a local neural model and an intensity from 0 to 2");
    return std::make_shared<NeuralNode>(spec);
}
void setNeuralStatusContext(const std::shared_ptr<ShaderNode>&node,uintptr_t owner,std::string_view stage,std::string_view revision){if(const auto neural=std::dynamic_pointer_cast<NeuralNode>(node))neural->statusContext(owner,stage,revision);}
ShaderResult finishNeuralNode(const std::shared_ptr<ShaderNode> &node){
    const auto neural=std::dynamic_pointer_cast<NeuralNode>(node);
    return neural?neural->finishOffline():ShaderResult{false,"Invalid neural video stage"};
}
}
