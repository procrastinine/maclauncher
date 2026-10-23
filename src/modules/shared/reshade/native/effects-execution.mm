// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "spatial.hpp"
#include "neural-node.hpp"
#include "log.hpp"
#include "image-admission.hpp"
#include "runtime-status.hpp"
#include "simple-generation-policy.hpp"
#include "presentation-hold.hpp"
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <array>
#include <tuple>
#include <set>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <chrono>
#include <atomic>
#include <CommonCrypto/CommonDigest.h>

namespace macfx {
namespace {
id<MTLTexture> image(id<MTLDevice> device,unsigned width,unsigned height,MTLPixelFormat format) {
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
    return newAdmittedTexture(device,descriptor);
}
void copy(id<MTLCommandBuffer> commands,id<MTLTexture> source,id<MTLTexture> target) {
    if(source==target)return;
    auto encoder=[commands blitCommandEncoder];
    if(!encoder)throw std::runtime_error("Cannot encode an ordered effect output");
    [encoder copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)
        sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
    [encoder endEncoding];
}
SpatialMethod spatialMethod(const std::string &name) {
    return spatialMethodForName(name);
}
uint32_t temporalMethod(const std::string &name) {
    if(name=="metalfx")return RS_TEMPORAL_METALFX;
    if(name=="fsr2")return RS_TEMPORAL_FSR2;
    if(name=="fsr3")return RS_TEMPORAL_FSR3;
    if(name=="fsr4")return RS_TEMPORAL_FSR4;
    throw std::runtime_error("Unknown ordered temporal method");
}
struct TemporalOwner {
    __weak id<MTLCommandBuffer> previous=nil;
    void admit(id<MTLCommandBuffer> commands){auto old=previous;if(old&&old!=commands&&old.status<MTLCommandBufferStatusCommitted)rsReleaseTemporalOwner(this);previous=commands;}
    ~TemporalOwner(){rsReleaseTemporalOwner(this);}
};
GraphicsConfig rowGraphics(const EffectPlanNode &node) {
    // Route the row through the same validation as the ordinary graphics
    // owner. A row's model and settings never come from another row or packet.
    return graphicsConfig([&](const char *key)->std::string {
        const std::string name=key;
        if(name=="RESHADE_SPATIAL_METHOD")return node.kind=="spatial"?(node.method=="downsample"?"bilinear":node.method):"off";
        if(name=="RESHADE_FRAME_GENERATION")return node.kind=="frame-generation"?node.method:"off";
        if(name=="RESHADE_LOSSLESS_MODEL")return node.modelPath;
        if(name=="RESHADE_SPATIAL_SHARPNESS")return std::to_string(node.settings.number("spatialSharpness",.5));
        if(name=="RESHADE_LS1_MODE")return node.settings.string("ls1Mode","quality");
        if(name=="RESHADE_FRAME_MULTIPLIER")return std::to_string(node.settings.number("frameMultiplier",2));
        if(name=="RESHADE_FRAME_PACING")return node.settings.string("framePacing","fixed");
        if(name=="RESHADE_TARGET_HZ")return std::to_string(node.settings.number("targetFps",120));
        if(name=="RESHADE_STABLE_CADENCE")return node.settings.boolean("smoothCadence")?"1":"0";
        if(name=="RESHADE_LSFG_MODE")return node.settings.string("lsfgMode","quality");
        if(name=="RESHADE_LSFG_FP16")return node.settings.boolean("lsfgFp16",true)?"1":"0";
        if(name=="RESHADE_LSFG_FLOW_SCALE")return std::to_string(node.settings.number("lsfgFlowScale",1));
        return {};
    });
}
std::string shaderIdentity(const EffectPlanNode &node) {
    const auto &s=node.shader.selection;
    auto value=node.id+'\n'+node.format+'\n'+s.file+'\n'+s.key+'\n'+s.revision+'\n'+s.technique;
    // A changed output contract cannot prepare a shared accepted node/history.
    value.push_back(node.outputPresentation?'\1':'\0');
    value.append(reinterpret_cast<const char*>(&node.outputScaleX),sizeof(node.outputScaleX));
    value.append(reinterpret_cast<const char*>(&node.outputScaleY),sizeof(node.outputScaleY));return value;
}
std::string digest(const std::string &bytes) {
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes.data(),CC_LONG(bytes.size()),hash);
    std::string out;const char *hex="0123456789abcdef";for(auto c:hash){out+=hex[c>>4];out+=hex[c&15];}return out;
}
std::string imageIdentity(const std::string &semantics,id<MTLTexture> image) {
    return digest(semantics+':'+std::to_string(image.width)+'x'+std::to_string(image.height)+':'+std::to_string(image.pixelFormat));
}
std::string downstreamIdentity(const std::string &input,const EffectPlanNode &node) {
    std::string value=input;
    const auto append=[&](const std::string &s){const uint64_t size=s.size();value.append(reinterpret_cast<const char*>(&size),sizeof(size));value+=s;};
    append(node.id);append(node.kind);append(shaderIdentity(node));append(node.method);append(node.modelPath);
    append(std::to_string(node.outputWidth));append(std::to_string(node.outputHeight));
    append(std::to_string(node.presentationScale));append(node.resolutionAuto?"auto":"manual");
    for(const auto &[name,values]:node.shader.parameters){append(name);const uint64_t count=values.size();value.append(reinterpret_cast<const char*>(&count),sizeof(count));value.append(reinterpret_cast<const char*>(values.data()),values.size()*sizeof(float));}
    for(const auto &[name,item]:node.settings.values){append(name);value+=char(item.index());
        if(const auto p=std::get_if<bool>(&item))value+=char(*p);
        else if(const auto p=std::get_if<double>(&item))value.append(reinterpret_cast<const char*>(p),sizeof(*p));
        else if(const auto p=std::get_if<std::string>(&item))append(*p);
    }
    return digest(value);
}
struct OptionalProvider {
    using Create=ShaderNode *(*)(const ShaderSpec *);
    using CreateScaler=ShaderNode *(*)(const char *);
    using Error=const char *(*)();
    using Completion=int(*)(const ShaderNode *,char *,size_t);
    void *handle=nullptr;Create create=nullptr;CreateScaler createScaler=nullptr;Error error=nullptr;Completion completion=nullptr;
    OptionalProvider() {
        Dl_info info{};
        if(!dladdr(reinterpret_cast<const void*>(&shaderIdentity),&info)||!info.dli_fname)
            throw std::runtime_error("Cannot locate the optional shader provider");
        const auto path=std::filesystem::path(info.dli_fname).parent_path()/"libmacfx-libplacebo.dylib";
        handle=dlopen(path.c_str(),RTLD_NOW|RTLD_LOCAL);
        if(!handle)throw std::runtime_error(std::string("The libplacebo shader provider is unavailable: ")+(dlerror()?:"unknown error"));
        const auto abi=reinterpret_cast<uint32_t(*)()>(dlsym(handle,"rsLibplaceboNodeABI"));
        create=reinterpret_cast<Create>(dlsym(handle,"rsCreateLibplaceboShaderNode"));
        createScaler=reinterpret_cast<CreateScaler>(dlsym(handle,"rsCreateLibplaceboScalerNode"));
        error=reinterpret_cast<Error>(dlsym(handle,"rsLibplaceboLastError"));
        completion=reinterpret_cast<Completion>(dlsym(handle,"rsLibplaceboNodeCompletion"));
        if(!abi||abi()!=1||!create||!error){dlclose(handle);handle=nullptr;throw std::runtime_error("The libplacebo shader provider has an incompatible API");}
    }
    ~OptionalProvider(){if(handle)dlclose(handle);}
};
std::shared_ptr<ShaderNode> shaderNode(const EffectPlanNode &node) {
    if(node.format!="libplacebo")return makeShaderNode(node.shader);
    return makeLibplaceboShaderNode(node.shader);
}
std::shared_ptr<OptionalProvider> optionalProvider(){
    // The one fixed optional module remains loaded for the process lifetime.
    // Metal/Vulkan callbacks may finish after a node's last core callback;
    // unloading their code from that node's destructor is not safe.
    static auto *loaded=new std::shared_ptr<OptionalProvider>(std::make_shared<OptionalProvider>());
    return *loaded;
}
std::shared_ptr<ShaderNode> optionalShader(const ShaderSpec &spec) {
    auto provider=optionalProvider();
    auto value=provider->create(&spec);
    if(!value)throw std::runtime_error(provider->error()?:"Cannot initialize the libplacebo shader");
    // Keep the provider loaded until its final node and submitted GPU leases
    // have retired, including a chain replaced while a buffer is in flight.
    return std::shared_ptr<ShaderNode>(value,[provider](ShaderNode *p){delete p;});
}
std::shared_ptr<ShaderNode> optionalScaler(const std::string &name){
    auto provider=optionalProvider();if(!provider->createScaler)throw std::runtime_error("Built-in libplacebo scaling filters are unavailable in this provider version");
    auto value=provider->createScaler(name.c_str());if(!value)throw std::runtime_error(provider->error()?:"Cannot initialize the libplacebo scaling filter");
    return std::shared_ptr<ShaderNode>(value,[provider](ShaderNode *p){delete p;});
}
bool sameGeneration(const GraphicsConfig &a,const GraphicsConfig &b) {
    if(bool(a.generation)!=bool(b.generation))return false;
    if(!a.generation)return true;
    const auto &x=*a.generation,&y=*b.generation;
    return x.modelPath==y.modelPath&&x.fp16==y.fp16&&x.performance==y.performance&&x.flowScale==y.flowScale&&x.multiplier==y.multiplier;
}
}
std::shared_ptr<ShaderNode> makeLibplaceboShaderNode(const ShaderSpec &spec){return optionalShader(spec);}
struct EffectExecution::Impl {
    struct Row {
        EffectPlanNode spec;
        std::string inputIdentity;
        std::shared_ptr<ShaderNode> shader;
        std::shared_ptr<ShaderNode> neural;
        std::shared_ptr<SpatialEncoder> spatial;
        std::shared_ptr<TemporalOwner> temporal;
        uint32_t temporalMethod=0;
        float sharpness=.5f;
        SpatialMethod method=SpatialMethod::Bilinear;
        SpatialConfig config;
        bool resizes=false;std::string bypass;
        unsigned targetWidth=0,targetHeight=0;
        MTLPixelFormat targetFormat=MTLPixelFormatInvalid;
    };
    struct Scratch {
        std::map<std::tuple<unsigned,unsigned,MTLPixelFormat>,std::array<id<MTLTexture>,2>> images;
        id<MTLTexture> target(id<MTLDevice> device,const Row &row,id<MTLTexture> source){
            auto &pair=images[{row.targetWidth,row.targetHeight,row.targetFormat}];
            if(!pair[0])pair[0]=image(device,row.targetWidth,row.targetHeight,row.targetFormat);
            if(pair[0]!=source)return pair[0];
            if(!pair[1])pair[1]=image(device,row.targetWidth,row.targetHeight,row.targetFormat);
            return pair[1];
        }
    };
    std::shared_ptr<const EffectPlanSnapshot> snapshot;
    std::vector<Row> rows;
    size_t split=0;
    size_t temporalEnd=0;
    bool generation=false,depthRequired=false,memoryDegraded=false;std::atomic<uintptr_t>statusContext{0};
    unsigned generationW=0,generationH=0;ImageColorSpace colorSpace=ImageColorSpace::LegacySDR;
    std::string generationInputIdentity;
    GraphicsConfig graphics;
    std::shared_ptr<LsfgEncoder> generator;
    id<MTLDevice> device;
    id<MTLCommandQueue> queue;
    unsigned inputW=0,inputH=0,outputW=0,outputH=0;
    MTLPixelFormat inputFormat,outputFormat;
    std::mutex scratchLock;
    std::mutex failureLock;
    std::map<std::string,std::string> failures,reported;
    std::map<std::string,std::pair<std::string,std::chrono::steady_clock::time_point>> spatialReports;
    struct SpatialBypass {std::string id,method;unsigned width,height;size_t position;};
    std::vector<SpatialBypass> spatialBypasses;
    std::set<std::string> unavailableTargets;
    std::map<std::string,std::chrono::steady_clock::time_point> memoryRetry;
    std::unique_ptr<SpatialEncoder> fallback;
    std::vector<std::shared_ptr<Scratch>> scratch;
    std::string failure(const Row &row){std::lock_guard<std::mutex>guard(failureLock);const auto found=failures.find(row.spec.id);return found==failures.end()?std::string{}:found->second;}
    bool targetUnavailable(const Row &row){std::lock_guard<std::mutex>guard(failureLock);return unavailableTargets.count(row.spec.id);}
    void report(const Row &row,const std::string &reason,bool persistent){
        bool changed=false;{std::lock_guard<std::mutex>guard(failureLock);if(persistent)failures[row.spec.id]=reason;
            auto &last=reported[row.spec.id];if(last!=reason){last=reason;changed=true;}}
        RuntimeStatusEvent event;event.context=statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Bypassed;event.planRevision=snapshot->revision;
        event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;event.activeMethod="passthrough";event.reason=reason;
        observeRuntimeStatus(event);
        if(changed)nativeLog("Effect "+row.spec.kind+" ("+row.spec.method+") bypassed: "+reason);
    }
    void reportSpatialText(const std::string &id,const std::string &value){
        const auto now=std::chrono::steady_clock::now();bool emit=false;
        {std::lock_guard<std::mutex>guard(failureLock);auto &last=spatialReports[id];if(last.first!=value&&now>=last.second){last={value,now+std::chrono::seconds(1)};emit=true;}}
        if(emit)nativeLog(value);
    }
    void reportSpatial(const Row &row,const SpatialStatus &status){
        if(!std::getenv("RESHADE_DIAGNOSTICS"))return;
        reportSpatialText(row.spec.id,"Spatial stage "+row.spec.id+" requested="+std::to_string(int(status.requested))+" active="+std::to_string(int(status.active))+" input="+std::to_string(status.inputWidth)+"x"+std::to_string(status.inputHeight)+" output="+std::to_string(status.outputWidth)+"x"+std::to_string(status.outputHeight)+" reason="+status.reason);
    }
    void reportSpatialBypasses(size_t begin,size_t end){
        if(!std::getenv("RESHADE_DIAGNOSTICS"))return;
        for(const auto &row:spatialBypasses)if(row.position>=begin&&row.position<=end)
            reportSpatialText(row.id,"Spatial stage "+row.id+" requestedMethod="+row.method+" active=bypass input="+std::to_string(row.width)+"x"+std::to_string(row.height)+" output="+std::to_string(row.width)+"x"+std::to_string(row.height)+" reason="+(row.method=="downsample"?"Reduction target already matches the input size":"Automatic fitting already matches the input size"));
    }
    ShaderResult fit(const ShaderFrame &frame,id<MTLTexture> source,id<MTLTexture> target){
        if(source.width==target.width&&source.height==target.height&&source.pixelFormat==target.pixelFormat){copy(frame.commands,source,target);return {true,{}};}
        const auto result=fallback->encode(frame.commands,{source,target,frame.frameId,frame.color,frame.origin},SpatialMethod::Bilinear,{});
        return {result.encoded,result.reason,result.busy};
    }
    std::shared_ptr<Scratch> acquire() {
        std::lock_guard<std::mutex> guard(scratchLock);
        for(const auto &slot:scratch)if(slot.use_count()==1)return slot;
        // Explicit callers can retain unsubmitted buffers independently of a
        // presenter. Bound their leases here before encoding any effect work.
        if(scratch.size()>=4)return {};
        auto slot=std::make_shared<Scratch>();
        // Slots are reused only after that exact command buffer completes or
        // is abandoned. Admission stays with the existing frame/presenter.
        scratch.push_back(slot);return slot;
    }
};
EffectExecution::EffectExecution(std::shared_ptr<Impl> value):impl(std::move(value)){}
const std::string &EffectExecution::revision()const{return impl->snapshot->revision;}
const GraphicsConfig &EffectExecution::graphics()const{return impl->graphics;}
std::shared_ptr<LsfgEncoder> EffectExecution::generator()const{return impl->generator;}
const std::string &EffectExecution::generationInputIdentity()const{return impl->generationInputIdentity;}
unsigned EffectExecution::generationWidth()const{return impl->generationW?impl->generationW:impl->outputW;}
unsigned EffectExecution::generationHeight()const{return impl->generationH?impl->generationH:impl->outputH;}
void EffectExecution::setStatusContext(uintptr_t value){impl->statusContext=value;}
bool EffectExecution::hasTemporal()const{return impl->temporalEnd!=0;}
bool EffectExecution::requiresDepth()const{return impl->depthRequired;}
bool EffectExecution::canDetachNeural()const{
    if(impl->generation||hasTemporal())return false;
    bool neural=false;for(const auto &row:impl->rows){
        if(row.spec.requirements.depth||row.spec.requirements.motion||row.temporal||(row.neural&&row.spec.settings.boolean("temporal")))return false;
        neural|=bool(row.neural);
    }return neural;
}
ShaderResult EffectExecution::finishOffline(){
    for(const auto &row:impl->rows)if(row.neural){const auto result=finishNeuralNode(row.neural);if(!result.encoded)return result;}
    for(const auto &row:impl->rows)if(row.shader&&(row.spec.format=="libplacebo"||row.spec.method.rfind("libplacebo:",0)==0)){
        const auto provider=optionalProvider();
        if(!provider->completion)return {false,"This shader provider cannot report video processing completion. Update the graphics runtime."};
        char error[512]{};
        if(provider->completion(row.shader.get(),error,sizeof(error)))return {false,error[0]?error:"The shader provider did not process this video frame."};
    }
    return {true,{}};
}
ShaderResult EffectExecution::encode(const ShaderFrame &frame,bool suffix,bool generated) {
    if(hasTemporal())return {false,"The ordered temporal stage requires its matched scene receipt"};
    return encodeRange(frame,suffix?impl->split:0,suffix?impl->rows.size():impl->split,generated,nullptr);
}
ShaderResult EffectExecution::encodeScene(const ShaderFrame &frame,const RSTemporalFrame &temporal) {
    if(!hasTemporal())return {false,"The ordered plan has no temporal stage"};
    return encodeRange(frame,0,impl->temporalEnd,false,&temporal);
}
ShaderResult EffectExecution::encodeAfterScene(const ShaderFrame &frame,bool suffix,bool generated) {
    return encodeRange(frame,suffix?impl->split:impl->temporalEnd,suffix?impl->rows.size():impl->split,generated,nullptr);
}
ShaderResult EffectExecution::encodeRange(const ShaderFrame &frame,size_t begin,size_t end,bool generated,const RSTemporalFrame *temporal) { @autoreleasepool {
    try {
        if(!frame.commands||!frame.source||!frame.target||frame.commands.status>=MTLCommandBufferStatusCommitted)
            return {false,"Ordered effects require unsubmitted frame images"};
        impl->reportSpatialBypasses(begin,end);
        if(begin==end&&frame.source.width==frame.target.width&&frame.source.height==frame.target.height&&frame.source.pixelFormat==frame.target.pixelFormat){copy(frame.commands,frame.source,frame.target);return {true,{}};}
        bool coordinates=!generated&&begin==0;
        auto held=impl->acquire();
        if(!held)return {false,"Ordered effect resource capacity is busy",true};
        auto lease=std::make_shared<std::pair<std::shared_ptr<Impl::Scratch>,std::shared_ptr<Impl>>>(held,impl);
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>){*lease={};}];
        id<MTLTexture> current=frame.source;std::string reason;
        for(size_t i=begin;i<end;++i) {
            auto &row=impl->rows[i];id<MTLTexture> target;
            if(!row.bypass.empty()){impl->report(row,row.bypass,false);if(reason.empty())reason=row.bypass;coordinates=false;continue;}
            if(impl->targetUnavailable(row)){if(reason.empty())reason=impl->failure(row);coordinates=false;continue;}
            {std::lock_guard<std::mutex>guard(impl->failureLock);const auto retry=impl->memoryRetry.find(row.spec.id);if(retry!=impl->memoryRetry.end()&&std::chrono::steady_clock::now()<retry->second){coordinates=false;continue;}}
            try{target=held->target(impl->device,row,current);}catch(const ImageBudgetExceeded &error){
                {std::lock_guard<std::mutex>guard(impl->failureLock);impl->memoryRetry[row.spec.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);}
                impl->report(row,error.what(),false);if(reason.empty())reason=error.what();coordinates=false;continue;}
            catch(const std::exception &error){
                {std::lock_guard<std::mutex>guard(impl->failureLock);impl->unavailableTargets.insert(row.spec.id);}
                impl->report(row,error.what(),true);if(reason.empty())reason=error.what();coordinates=false;continue;
            }
            ShaderResult encoded;encoded.reason=impl->failure(row);
            bool transientInputs=false;
            if(encoded.reason.empty())try {
            if(row.temporal&&(!temporal||!coordinates)){encoded={false,"The ordered temporal stage requires unchanged matched scene inputs"};transientInputs=true;}
            else if(!row.temporal&&row.spec.requirements.motion){encoded={false,"This shader stage requires a supported motion texture input"};transientInputs=true;}
            else if(!row.temporal&&row.spec.requirements.depth&&(!coordinates||!frame.depth)){encoded={false,"This ordered stage requires unchanged depth from the current game frame"};transientInputs=true;}
            else if(row.shader||row.neural) {
                auto context=frame;context.source=current;context.target=target;context.depth=coordinates?frame.depth:nullptr;
                if(row.neural)setNeuralStatusContext(row.neural,impl->statusContext,row.spec.id,impl->snapshot->revision);
                encoded=(row.neural?row.neural:row.shader)->encode(context);
                // NeuralNode owns its bounded unsupported-input state and
                // retries only when that input contract changes.
                if(row.neural)transientInputs=true;
            }else if(row.temporal) {
                if(temporal->commandBuffer!=(__bridge void*)frame.commands||temporal->color!=(__bridge void*)frame.source||temporal->output!=(__bridge void*)frame.target){
                    encoded={false,"The temporal scene no longer matches its original command buffer and images"};transientInputs=true;
                }else{
                    auto actual=*temporal;actual.owner=row.temporal.get();actual.color=(__bridge void*)current;actual.output=(__bridge void*)target;actual.method=row.temporalMethod;actual.sharpness=row.sharpness;
                    row.temporal->admit(frame.commands);
                    RSTemporalResult result{};result.size=sizeof(result);result.version=1;rsProcessTemporalFrame(&actual,&result);
                    encoded={result.status==RS_TEMPORAL_OK&&bool(result.encoded),result.reason,result.status==RS_TEMPORAL_BUSY};
                }
                coordinates=false;
            }else {
                const auto result=row.spatial->encode(frame.commands,{current,target,frame.frameId,frame.color,frame.origin},row.method,row.config);
                impl->reportSpatial(row,result);
                encoded={result.encoded,result.reason,result.busy};
            }
            }catch(const ImageBudgetExceeded &error){
                {std::lock_guard<std::mutex>guard(impl->failureLock);impl->memoryRetry[row.spec.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);}
                impl->report(row,error.what(),false);if(reason.empty())reason=error.what();coordinates=false;continue;}
            catch(const std::exception &error){encoded={false,error.what()};}
            // A provider still owns its frame resources. Retain the coherent
            // completed presentation, including for history-based shaders;
            // fitting raw input here would alternate filtered/unfiltered frames.
            if(encoded.busy)return encoded;
            if(!encoded.encoded){
                const auto problem=encoded.reason.empty()?"The effect could not process this frame":encoded.reason;
                // A rejected scene must not become the previous frame for a
                // later temporal encode. Busy owners retain their real work.
                if(row.temporal)rsReleaseTemporalOwner(row.temporal.get());
                // A failed row may have already written its scratch target.
                // Overwrite the whole target from the row's retained input,
                // preserving every preceding row before continuing the chain.
                const auto copied=impl->fit(frame,current,target);if(!copied.encoded)return copied;
                impl->report(row,problem,!encoded.busy&&!transientInputs);if(reason.empty())reason=problem;
            }
            {RuntimeStatusEvent event;event.context=impl->statusContext;event.processing=true;event.phase=encoded.encoded?RuntimeStatusPhase::Encoded:RuntimeStatusPhase::Bypassed;
             event.planRevision=impl->snapshot->revision;event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;
             event.activeMethod=!encoded.encoded?"passthrough":row.neural?"pending":event.requestedMethod;event.reason=encoded.reason;event.frameId=frame.frameId;
             event.inputWidth=current.width;event.inputHeight=current.height;event.outputWidth=target.width;event.outputHeight=target.height;observeRuntimeStatus(event);}
            current=target;if(row.resizes||row.spec.kind!="shader"||!row.spec.preservesCoordinates)coordinates=false;
        }
        const auto copied=impl->fit(frame,current,frame.target);if(!copied.encoded)return copied;
        return {true,reason};
    }catch(const ImageBudgetExceeded &error){return {false,error.what()};}
    catch(const std::exception &error){return {false,error.what()};}
}}
struct EffectPlanExecutor::Impl {
    EffectPlanState state;
    std::shared_ptr<EffectExecution> current;
    ImageColorSpace colorSpace=ImageColorSpace::LegacySDR;uintptr_t statusContext=0;
    std::string rejected,reported,memoryRejected;std::chrono::steady_clock::time_point memoryRetry{};
    id<MTLDevice> device=nil;id<MTLCommandQueue> queue=nil;
    unsigned inputW=0,inputH=0,outputW=0,outputH=0;
    MTLPixelFormat inputFormat=MTLPixelFormatInvalid,outputFormat=MTLPixelFormatInvalid;
    std::vector<std::weak_ptr<TemporalOwner>> temporalOwners;
    ~Impl(){for(const auto &weak:temporalOwners)if(auto owner=weak.lock())rsReleaseTemporalOwner(owner.get());}
};
EffectPlanExecutor::EffectPlanExecutor():impl(std::make_unique<Impl>()){}
EffectPlanExecutor::~EffectPlanExecutor()=default;
std::shared_ptr<const EffectPlanSnapshot> EffectPlanExecutor::snapshot()const{return impl->state.snapshot();}
bool EffectPlanExecutor::requiresDepth() {
    impl->state.poll();const auto snapshot=impl->state.snapshot();
    // A simple document contains no ordered rows and needs no GPU validation.
    if(snapshot&&snapshot->mode=="simple")return false;
    // Capture inputs for the candidate without removing inputs from the last
    // accepted execution. A rejected live edit must keep that chain runnable.
    return (impl->current&&impl->current->requiresDepth())||
        (snapshot&&snapshot->mode=="advanced"&&std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto &node){return node.enabled&&node.requirements.depth;}));
}
bool EffectPlanExecutor::requiresTemporal() {
    impl->state.poll();const auto snapshot=impl->state.snapshot();
    return snapshot&&snapshot->mode=="advanced"&&std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto &node){return node.enabled&&node.kind=="temporal";});
}
void EffectPlanExecutor::setStatusContext(uintptr_t value){impl->statusContext=value;if(impl->current)impl->current->setStatusContext(value);}
EffectExecutionSelection EffectPlanExecutor::prepare(const ShaderFrame &frame,bool presentation,const RSTemporalFrame *temporal){return prepareWithColor(frame,presentation,temporal,ImageColorSpace::LegacySDR);}
EffectExecutionSelection EffectPlanExecutor::prepareWithColor(const ShaderFrame &frame,bool presentation,const RSTemporalFrame *temporal,ImageColorSpace colorSpace) { @autoreleasepool {
    EffectExecutionSelection result;const auto poll=impl->state.poll();const auto snapshot=impl->state.snapshot();
    if(!snapshot){result.active=true;result.error=poll.error;return result;}
    if(snapshot->mode=="simple")return result;
    result.active=true;
    const auto sourceIdentity=imageIdentity(std::to_string(int(colorSpace))+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.device))+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.commandQueue)),frame.source);
    const auto identity=snapshot->revision+':'+imageIdentity(sourceIdentity,frame.target);
    const bool changed=!impl->current||impl->colorSpace!=colorSpace||(impl->current->impl->memoryDegraded&&std::chrono::steady_clock::now()>=impl->memoryRetry)||impl->current->revision()!=snapshot->revision||impl->device!=frame.commands.device||impl->queue!=frame.commands.commandQueue||impl->inputW!=frame.source.width||impl->inputH!=frame.source.height||impl->outputW!=frame.target.width||impl->outputH!=frame.target.height||impl->inputFormat!=frame.source.pixelFormat||impl->outputFormat!=frame.target.pixelFormat;
    if(changed&&impl->rejected!=identity&&(impl->memoryRejected!=identity||std::chrono::steady_clock::now()>=impl->memoryRetry))try {
        auto next=std::make_shared<EffectExecution::Impl>();next->snapshot=snapshot;next->device=frame.commands.device;next->queue=frame.commands.commandQueue;next->colorSpace=colorSpace;next->statusContext=impl->statusContext;
        next->fallback=std::make_unique<SpatialEncoder>(next->device);
        next->inputW=frame.source.width;next->inputH=frame.source.height;next->outputW=frame.target.width;next->outputH=frame.target.height;next->inputFormat=frame.source.pixelFormat;next->outputFormat=frame.target.pixelFormat;
        auto input=image(next->device,next->inputW,next->inputH,next->inputFormat),output=image(next->device,next->outputW,next->outputH,next->outputFormat);
        // The document revision also changes for a node's own live uniforms.
        // Only actual upstream image semantics enter that node's history key.
        // Final presentation resize cannot reset an unchanged source prefix.
        id<MTLTexture> current=input;bool coordinates=true;std::string upstream=sourceIdentity;
        // A private unsubmitted buffer permits spatial pipeline validation;
        // no candidate advances source history or writes any publisher image.
        auto validation=[next->queue commandBuffer];
        std::vector<EffectPlanNode> nodes;for(const auto&node:snapshot->nodes)if(node.enabled)nodes.push_back(node);
        bool sourceGeneration=false;
        for(size_t position=0;position<nodes.size();++position){
            // Only a synthesized, explicitly qualified Simple hint can move
            // its final fitting scaler. Advanced documents never emit it.
            if(position+1<nodes.size()){
                const auto&scale=nodes[position];const auto&fg=nodes[position+1];
                const auto factor=scale.settings.values.find("spatialMultiplier");
                const bool defaultFactor=factor==scale.settings.values.end()||std::holds_alternative<std::monostate>(factor->second);
                const bool suffix=std::all_of(nodes.begin()+position+2,nodes.end(),[](const auto&row){return row.kind=="shader"&&!row.requirements.depth&&!row.requirements.motion&&!row.outputPresentation&&row.outputScaleX==1&&row.outputScaleY==1;});
                const auto passes=simplegeneration::scalerPasses(scale.method);
                if(!sourceGeneration&&fg.kind=="frame-generation"&&fg.method=="lsfg"&&fg.settings.string("simpleGenerationPlacement")=="source-cost-v1"&&fg.settings.string("simpleSpatialNodeId")==scale.id&&
                    scale.kind=="spatial"&&passes&&!scale.outputWidth&&!scale.outputHeight&&!scale.presentationScale&&!scale.resolutionAuto&&defaultFactor&&suffix&&
                    std::count_if(nodes.begin(),nodes.end(),[](const auto&row){return row.kind=="frame-generation";})==1){
                    try{const auto options=rowGraphics(fg);
                    const auto decision=simplegeneration::choose({unsigned(current.width),unsigned(current.height)},{next->outputW,next->outputH},options.generation->multiplier,passes,true,0,options.generation->flowScale);
                    if(decision.placement==simplegeneration::Placement::Source){std::swap(nodes[position],nodes[position+1]);sourceGeneration=true;}}catch(const std::exception&){/* Normal row preparation reports invalid options. */}
                }
            }
            const auto&node=nodes[position];
            if(node.kind=="frame-generation") {
                if(!modelColorSupported(colorSpace)){EffectExecution::Impl::Row row;row.spec=node;next->report(row,std::string(imageColorReason(colorSpace)),false);continue;}
                try {
                if(!presentation)throw std::runtime_error("Frame generation requires a presentation owner");
                if(next->generation)throw std::runtime_error("A presentation supports one frame-generation stage");
                const auto config=rowGraphics(node);std::shared_ptr<LsfgEncoder> generator;
                if(impl->current&&sameGeneration(config,impl->current->graphics()))generator=impl->current->generator();
                if(!generator)generator=std::make_shared<LsfgEncoder>(next->device,*config.generation);
                next->graphics=config;next->generation=true;next->split=next->rows.size();next->generationInputIdentity=upstream;next->generator=generator;
                // Generation preserves the preceding row's image extent.
                // Only an explicit earlier scaler (or matched scene stage)
                // moves it to presentation size; suffix fitting stays ordered.
                next->generationW=unsigned(current.width);next->generationH=unsigned(current.height);
                coordinates=false;upstream=downstreamIdentity(upstream,node);
                }catch(const std::exception &error){if(impl->current)throw;EffectExecution::Impl::Row row;row.spec=node;next->report(row,error.what(),true);}
                continue;
            }
            EffectExecution::Impl::Row row;row.spec=node;row.inputIdentity=upstream;
            row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;
            const auto sameTarget=[&](const auto &old){return old.targetWidth==row.targetWidth&&old.targetHeight==row.targetHeight&&old.targetFormat==row.targetFormat;};
            ShaderFrame context=frame;context.commands=validation;context.source=current;context.target=current;context.depth=coordinates?frame.depth:nullptr;
            const bool missingSceneInputs=node.kind!="temporal"&&(node.requirements.motion||node.requirements.depth&&(!coordinates||!frame.depth));
            try {
            if((node.kind=="neural"||node.kind=="temporal"||node.kind=="spatial"&&node.method=="ls1")&&!modelColorSupported(colorSpace)){row.bypass=std::string(imageColorReason(colorSpace));coordinates=false;}
            else if(node.kind=="shader") {
                const double width=node.outputPresentation?next->outputW:std::ceil(current.width*node.outputScaleX),height=node.outputPresentation?next->outputH:std::ceil(current.height*node.outputScaleY);
                if(!std::isfinite(width)||!std::isfinite(height)||width<1||height<1||width>16384||height>16384)throw std::runtime_error("Shader output dimensions must be from 1 to 16384 pixels");
                row.targetWidth=unsigned(width);row.targetHeight=unsigned(height);row.resizes=width!=current.width||height!=current.height;
                auto target=row.resizes?image(next->device,row.targetWidth,row.targetHeight,row.targetFormat):current;context.target=target;
                if(impl->current)for(const auto &old:impl->current->impl->rows)if(old.shader&&old.inputIdentity==upstream&&sameTarget(old)&&shaderIdentity(old.spec)==shaderIdentity(node)&&old.spec.shader.parameters==node.shader.parameters){row.shader=old.shader;break;}
                if(!row.shader){row.shader=shaderNode(node);row.shader->setParameters(node.shader.parameters);}
                const auto ready=row.shader->prepare(context);if(!ready.encoded)throw std::runtime_error(ready.reason);
                {RuntimeStatusEvent event;event.context=next->statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Prepared;
                 event.planRevision=snapshot->revision;event.stageId=node.id;event.requestedMethod=node.format;event.activeMethod=node.format;observeRuntimeStatus(event);}
                current=target;if(row.resizes||!node.preservesCoordinates)coordinates=false;
            }else if(node.kind=="neural") {
                if(next->generation&&node.settings.boolean("temporal"))throw std::runtime_error("Temporal neural rendering must precede frame generation");
                if(node.method!="mlx-dlss")throw std::runtime_error("Unknown neural-rendering method");
                if(impl->current)for(const auto &old:impl->current->impl->rows)if(old.neural&&sameTarget(old)&&(old.inputIdentity==upstream||!node.settings.boolean("temporal"))&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.neural=old.neural;break;}
                if(!row.neural)row.neural=makeNeuralNode({node.modelPath,float(node.settings.number("intensity",1)),node.settings.boolean("temporal")});
                context.depth=nullptr;const auto ready=row.neural->prepare(context);if(!ready.encoded)throw std::runtime_error(ready.reason);
                coordinates=false;
            }else if(node.kind=="temporal") {
                // An unavailable scene scaler still has a declared output
                // extent. Retain that boundary for independent later rows.
                row.targetWidth=next->outputW;row.targetHeight=next->outputH;row.targetFormat=next->outputFormat;row.resizes=true;
                if(!temporal||next->temporalEnd||next->generation||!coordinates)throw std::runtime_error("An ordered temporal stage requires one unchanged matched scene before frame generation");
                if(temporal->commandBuffer!=(__bridge void*)frame.commands||temporal->color!=(__bridge void*)frame.source||temporal->output!=(__bridge void*)frame.target)
                    throw std::runtime_error("The temporal stage does not match the original renderer frame");
                if(node.requirements.depth&&(!coordinates||!frame.depth))throw std::runtime_error("This ordered stage requires unchanged depth from the current game frame");
                row.temporalMethod=temporalMethod(node.method);const auto sharpness=node.settings.number("temporalSharpness",.5);
                if(!std::isfinite(sharpness)||sharpness<0||sharpness>1)throw std::runtime_error("Invalid temporal sharpness");row.sharpness=float(sharpness);
                if(impl->current)for(const auto &old:impl->current->impl->rows)if(old.temporal&&sameTarget(old)&&old.spec.id==node.id&&old.inputIdentity==upstream&&old.temporalMethod==row.temporalMethod){row.temporal=old.temporal;break;}
                if(!row.temporal){row.temporal=std::make_shared<TemporalOwner>();impl->temporalOwners.erase(std::remove_if(impl->temporalOwners.begin(),impl->temporalOwners.end(),[](const auto &weak){return weak.expired();}),impl->temporalOwners.end());impl->temporalOwners.push_back(row.temporal);}
                // Validate with an independent, unsubmitted owner. The live
                // history is untouched until its real scene is encoded.
                auto probe=std::make_shared<TemporalOwner>();auto actual=*temporal;actual.commandBuffer=(__bridge void*)validation;actual.owner=probe.get();actual.color=(__bridge void*)current;actual.output=(__bridge void*)output;actual.method=row.temporalMethod;actual.sharpness=row.sharpness;actual.flags|=RS_TEMPORAL_RESET;
                RSTemporalResult ready{};ready.size=sizeof(ready);ready.version=1;rsProcessTemporalFrame(&actual,&ready);
                if(ready.status!=RS_TEMPORAL_OK||!ready.encoded)throw std::runtime_error(ready.reason);
                next->temporalEnd=next->rows.size()+1;current=output;coordinates=false;
            }else if(node.kind=="spatial") {
                const auto size=spatialOutputSize(node,{unsigned(current.width),unsigned(current.height)},{next->outputW,next->outputH});
                const auto factor=node.settings.values.find("spatialMultiplier");
                const bool automatic=node.resolutionAuto||(!node.outputWidth&&!node.outputHeight&&!node.presentationScale&&(factor==node.settings.values.end()||std::holds_alternative<std::monostate>(factor->second)));
                // A reduction at its target has no work. This also lets an
                // allocation guard cover a rejected renderer request without
                // adding a filter pass when the native allocation succeeded.
                // Explicit non-reduction filters still retain their 1x pass.
                if((automatic||node.method=="downsample")&&size.width==current.width&&size.height==current.height){
                    next->spatialBypasses.push_back({node.id,node.method,unsigned(current.width),unsigned(current.height),next->rows.size()});
                    upstream=imageIdentity(downstreamIdentity(upstream,node),current);continue;
                }
                row.targetWidth=size.width;row.targetHeight=size.height;row.targetFormat=next->outputFormat;
                auto target=image(next->device,size.width,size.height,row.targetFormat);
                if(node.method.rfind("libplacebo:",0)==0){
                    if(impl->current)for(const auto &old:impl->current->impl->rows)if(old.shader&&sameTarget(old)&&old.spec.kind=="spatial"&&old.inputIdentity==upstream&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.shader=old.shader;break;}
                    if(!row.shader)row.shader=optionalScaler(node.method.substr(11));
                    context.source=current;context.target=target;context.depth=nullptr;const auto ready=row.shader->prepare(context);if(!ready.encoded)throw std::runtime_error(ready.reason);
                }else{
                const auto config=rowGraphics(node);row.config={config.sharpness,config.ls1Performance,config.modelPath};row.method=spatialMethod(node.method);
                row.spatial=std::make_shared<SpatialEncoder>(next->device);
                const auto ready=row.spatial->encode(validation,{current,target,frame.frameId,frame.color,frame.origin},row.method,row.config);
                if(!ready.encoded)throw std::runtime_error(ready.reason);
                }
                current=target;coordinates=false;
            }else throw std::runtime_error("Unknown ordered effect stage");
            }catch(const ImageBudgetExceeded &error){
                if(impl->current)throw;
                row.shader.reset();row.neural.reset();row.spatial.reset();row.temporal.reset();row.bypass=error.what();next->memoryDegraded=true;
                next->report(row,error.what(),false);next->memoryRetry[node.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
                // Preserve the prior input extent; a denied resize cannot
                // strand its independent display stages at the requested size.
                row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;row.resizes=false;
                coordinates=false;
            }catch(const std::exception &error){
                // Live edits retain their complete previously valid chain.
                // At first launch, an unavailable optional row becomes a
                // bounded passthrough so independent rows can still run.
                if(impl->current)throw;
                row.temporal.reset();
                next->report(row,error.what(),!missingSceneInputs);
                if(node.kind=="spatial"||row.resizes)current=image(next->device,row.targetWidth,row.targetHeight,row.targetFormat);
                coordinates=false;
            }
            upstream=imageIdentity(downstreamIdentity(upstream,node),current);next->rows.push_back(std::move(row));
        }
        if(!next->generation)next->split=next->rows.size();
        next->depthRequired=std::any_of(next->rows.begin(),next->rows.end(),[](const auto &row){return row.spec.requirements.depth;});
        // Reused nodes keep immutable parameters. Changed parameters belong to
        // fresh candidate nodes, including suffixes retained by older batches.
        impl->current=std::shared_ptr<EffectExecution>(new EffectExecution(next));impl->rejected.clear();impl->memoryRejected.clear();result.changed=true;
        impl->device=frame.commands.device;impl->queue=frame.commands.commandQueue;impl->colorSpace=colorSpace;if(next->memoryDegraded)impl->memoryRetry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
        impl->inputW=frame.source.width;impl->inputH=frame.source.height;impl->outputW=frame.target.width;impl->outputH=frame.target.height;impl->inputFormat=frame.source.pixelFormat;impl->outputFormat=frame.target.pixelFormat;
    }catch(const ImageBudgetExceeded &error){impl->memoryRejected=identity;impl->memoryRetry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);result.error=error.what();}
    catch(const std::exception &error){impl->rejected=identity;result.error=error.what();}
    result.execution=impl->current;
    if(result.execution&&!presentation){const auto controlsIdentity=presentationControlsDigest();RuntimeStatusEvent event;event.context=impl->statusContext;event.processing=true;event.resourceAccepted=true;event.phase=RuntimeStatusPhase::Prepared;
        event.planRevision=result.execution->revision();event.controlsDigest=controlsIdentity;event.inputWidth=frame.source.width;event.inputHeight=frame.source.height;event.outputWidth=frame.target.width;event.outputHeight=frame.target.height;observeRuntimeStatus(event);}
    if(!result.error.empty()&&impl->reported!=result.error){nativeLog("Ordered effect change unavailable; previous chain retained: "+result.error);impl->reported=result.error;}
    return result;
}}
}
