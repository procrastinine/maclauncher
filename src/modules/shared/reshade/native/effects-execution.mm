// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "native-config.hpp"
#include "image-pair-analysis.hpp"
#include "temporal-provider.hpp"
#include "scene-matrices.hpp"
#include "scene-aovs.hpp"
#include "scene-shader-inputs.hpp"
#include "shader-history.hpp"
#include "scene-copy-boundary.hpp"
#include "scene-guides.hpp"
#include "spatial.hpp"
#include "neural-node.hpp"
#include "log.hpp"
#include "image-admission.hpp"
#include "image-color.hpp"
#include "runtime-status.hpp"
#include "generation-timeline.hpp"
#include "presentation-hold.hpp"
#include "depth-resample.hpp"
#include "color-island.hpp"
#include "isf-node.hpp"
#include "magpie-node.hpp"
#include "comparison.hpp"
#include "native-image.hpp"
#include "native-scene.hpp"
#include "libplacebo-node.hpp"
#include "color-formats.hpp"
#include "xess-node.hpp"
#include "metalfx-denoised.hpp"
#include "metalfx-generation-resources.hpp"
#include "recorded-scene.h"
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <array>
#include <tuple>
#include <utility>
#include <set>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <chrono>
#include <atomic>
#include <dispatch/dispatch.h>
#include <CommonCrypto/CommonDigest.h>
extern "C" uint32_t rsAdaptiveQualityAPI(void){return 1;}

namespace macfx {
dispatch_queue_t effectPreparationQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.graphics.graph.prepare",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));return queue;}
namespace {
std::atomic<uint64_t>displayImageSequence{1};
enum SceneGuideDemand:unsigned { GuideDepth=1,GuideMotion=2,GuideExposure=4,GuideAll=31 };
unsigned shaderGuideDemand(const EffectPlanRequirements&r){return (r.depth?GuideDepth:0u)|(r.motion?GuideMotion:0u)|(r.exposure?GuideExposure:0u);}
RSTemporalFrame consumedGuides(const RSTemporalFrame&source,unsigned mask){auto result=source;if(!(mask&GuideDepth))result.depth=nullptr;if(!(mask&GuideMotion))result.motion=nullptr;if(!(mask&GuideExposure))result.exposure=nullptr;if(!(mask&8))result.reactive=nullptr;if(!(mask&16))result.transparency=nullptr;return result;}
struct ScenePreparing:std::runtime_error{std::function<ShaderResult()>ready;explicit ScenePreparing(const std::string&reason,std::function<ShaderResult()>query={}):std::runtime_error(reason),ready(std::move(query)){};};
// A failure always carries a reason. An empty message would otherwise let a
// rejected candidate read as accepted and leave its row reason blank.
std::string failureReason(const std::exception&error){return *error.what()?error.what():"The effect could not be prepared";}
// The one mapping from a provider's preparation status to a build outcome. A
// busy status is transient and retried with a soft backoff; other unready status
// is a failure with its reason.
template<class Status>void require(const Status&ready){
    if(ready.encoded)return;if(ready.busy)throw TransientBusy(ready.reason);
    throw std::runtime_error(ready.reason.empty()?"The effect could not be prepared":ready.reason);
}
template<class T>void retireResource(T*value){if(value)dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),value,[](void*pointer){delete static_cast<T*>(pointer);});}
template<class T>std::shared_ptr<T>deferredShared(){return std::shared_ptr<T>(new T,[](T*value){retireResource(value);});}
std::string sceneInputReason(const EffectPlanRequirements&required,const RSTemporalFrame*scene,const std::optional<RSSceneMatrices>&matrices,const std::shared_ptr<const SceneAovLease>&capturedAovs={},bool aovsResolved=false){
    // Image frame sources can carry depth but never a renderer scene. Name the
    // projection such a frame lacks rather than the depth it may supply.
    if(!scene&&required.projectionMatrix)return "The frame source supplies no camera projection";
    if(required.depth&&(!scene||!scene->depth))return "Needs matching renderer depth";
    if(required.exposure&&(!scene||!scene->exposure))return "Needs matching renderer exposure";
    if(required.motion&&(!scene||!scene->motion))return "Needs matching renderer motion";
    if(required.camera&&(!scene||!(scene->flags&RS_TEMPORAL_CAMERA_VALID)))return "Needs matching renderer camera parameters";
    if(required.viewMatrix&&(!matrices||!(matrices->flags&RS_SCENE_VIEW_VALID)))return "Needs a matching renderer view matrix";
    if(required.projectionMatrix&&(!matrices||!(matrices->flags&RS_SCENE_PROJECTION_VALID)))return "Needs a matching renderer projection matrix";
    if(required.sceneAovs){const auto aovs=capturedAovs||aovsResolved?capturedAovs:scene?temporalSceneAovs(*scene):nullptr;for(unsigned slot=0;slot<RS_SCENE_AOV_COUNT;++slot)if((required.sceneAovs&(uint32_t(1)<<slot))&&(!aovs||!aovs->value.images[slot].texture))return "Needs matching renderer "+std::string(sceneAovNames[slot]);}
    if(required.noisyColor){const auto aovs=capturedAovs?capturedAovs:scene?temporalSceneAovs(*scene):nullptr;if(!aovs||!(aovs->value.flags&RS_SCENE_AOV_COLOR_NOISY))return "Needs actual noisy renderer color";}
    return {};
}
std::string sceneColorInputReason(const EffectPlanNode&node,const ImageColorDescription&working,const RSTemporalFrame*scene,const std::shared_ptr<const SceneAovLease>&aovs,bool displayMapped=false,bool validateExposure=true){
    if(node.inputPolicy!="linear-source")return {};
    bool radiance=false,color=false;for(const auto&[name,role]:node.sceneBindings){radiance|=role==RS_SHADER_SCENE_RESOLVED_RADIANCE||role==RS_SHADER_SCENE_RESOLVED_SPECULAR||role==RS_SHADER_SCENE_NOISY_DIFFUSE||role==RS_SHADER_SCENE_NOISY_SPECULAR;color|=radiance||role==RS_SHADER_SCENE_DIFFUSE_ALBEDO||role==RS_SHADER_SCENE_SPECULAR_ALBEDO;}
    if(!color)return {};
    if(!scene||!aovs)return "Needs matching renderer color input metadata";
    const auto&packet=aovs->value;const auto declared=readImageColor(packet.color);
    if(radiance&&(displayMapped||!working.sceneReferred||!declared.sceneReferred))return "Scene-linear shader inputs need the original scene-referred color domain";
    if(validateExposure&&radiance&&(!std::isfinite(scene->preExposure)||scene->preExposure<=0))return "Scene radiance needs the actual current color pre-exposure";
    for(const auto&[name,role]:node.sceneBindings)if(role==RS_SHADER_SCENE_RESOLVED_RADIANCE||role==RS_SHADER_SCENE_RESOLVED_SPECULAR||role==RS_SHADER_SCENE_NOISY_DIFFUSE||role==RS_SHADER_SCENE_NOISY_SPECULAR){const auto pass=packet.images[role].pass?:packet.pass;if(!pass||pass!=packet.colorPass)return "Scene radiance does not cover the current color pass";}
    return {};
}
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
    if(name=="metalfx-denoised")return RS_TEMPORAL_METALFX_DENOISED;
    if(name=="fsr2")return RS_TEMPORAL_FSR2;
    if(name=="fsr3")return RS_TEMPORAL_FSR3;
    if(name=="fsr4")return RS_TEMPORAL_FSR4;
    if(name=="asr")return RS_TEMPORAL_ASR;
    if(name=="sgsr2")return RS_TEMPORAL_SGSR2;
    throw std::runtime_error("Unknown ordered temporal method");
}
struct TemporalOwner {
    __weak id<MTLCommandBuffer> previous=nil;
    void admit(id<MTLCommandBuffer> commands){auto old=previous;if(old&&old!=commands&&old.status<MTLCommandBufferStatusCommitted)rsReleaseTemporalOwner(this);previous=commands;}
    ~TemporalOwner(){rsReleaseTemporalOwner(this);}
};
bool canonicalTemporalColor(const ImageColorDescription&c){
    return c.primaries==ColorPrimaries::BT709&&c.transfer==ColorTransfer::Linear&&c.range==ColorRange::Full&&c.alpha!=ColorAlpha::Premultiplied&&c.referenceWhite==203;
}
ImageColorDescription temporalWorkingColor(const ImageColorDescription&source){
    auto result=describeImageColor(ImageColorSpace::ExtendedSRGB);result.peakLuminance=std::max(result.peakLuminance,source.peakLuminance);result.sceneReferred=source.sceneReferred;return result;
}
GraphicsConfig rowGraphics(const EffectPlanNode &node,const OutputPolicy*output=nullptr) {
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
        if(name=="RESHADE_FRAME_PACING")return output&&output->hasPacing?output->framePacing:node.settings.string("framePacing","fixed");
        if(name=="RESHADE_TARGET_HZ")return std::to_string(output&&output->hasPacing?output->targetFps:node.settings.number("targetFps",120));
        if(name=="RESHADE_STABLE_CADENCE")return (output&&output->hasPacing?output->smoothCadence:node.settings.boolean("smoothCadence"))?"1":"0";
        if(name=="RESHADE_LSFG_MODE")return node.settings.string("lsfgMode","quality");
        if(name=="RESHADE_LSFG_FP16")return node.settings.boolean("lsfgFp16",true)?"1":"0";
        if(name=="RESHADE_LSFG_FLOW_SCALE")return std::to_string(node.settings.number("lsfgFlowScale",1));
        return {};
    });
}
std::string shaderIdentity(const EffectPlanNode &node) {
    const auto &s=node.shader.selection;
    auto value=node.id+'\n'+node.format+'\n'+s.file+'\n'+s.key+'\n'+s.revision+'\n'+s.technique;
    for(const auto&member:node.planeGroupMembers)value+='\n'+member;
    value+=node.displaySubframes?"\ndisplay":"\nsource";
    value.push_back(char(unsigned(node.requirements.depth)|unsigned(node.requirements.motion)<<1|unsigned(node.requirements.camera)<<2|unsigned(node.requirements.viewMatrix)<<3|unsigned(node.requirements.projectionMatrix)<<4));
    value.push_back(node.preservesCoordinates?'\1':'\0');
    value+='\n'+node.gpuWorkScope;
    value+='\n'+node.inputPolicy;value+=node.realHistory?"\nhistory-real":"\nhistory-display";
    for(const auto&[name,role]:node.sceneBindings)value+='\n'+name+':'+std::to_string(role);
    value.append(reinterpret_cast<const char*>(&node.requirements.sceneAovs),sizeof(node.requirements.sceneAovs));value+=char(node.requirements.noisyColor);value+=char(node.requirements.exposure);
    value+='\n'+node.modelOperation+'\n'+node.modelPath;
    // A changed output contract cannot prepare a shared accepted node/history.
    value.push_back(node.outputPresentation?'\1':'\0');
    value.append(reinterpret_cast<const char*>(&node.outputScaleX),sizeof(node.outputScaleX));
    value.append(reinterpret_cast<const char*>(&node.outputScaleY),sizeof(node.outputScaleY));return value;
}
std::string digest(const std::string &bytes) {
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes.data(),CC_LONG(bytes.size()),hash);
    std::string out;const char *hex="0123456789abcdef";for(auto c:hash){out+=hex[c>>4];out+=hex[c&15];}return out;
}
std::string imageIdentity(const std::string &semantics,EffectPlanSize size,MTLPixelFormat format) {
    return digest(semantics+':'+std::to_string(size.width)+'x'+std::to_string(size.height)+':'+std::to_string(format));
}
std::string imageIdentity(const std::string &semantics,id<MTLTexture> image) {
    return imageIdentity(semantics,{unsigned(image.width),unsigned(image.height)},image.pixelFormat);
}
std::string downstreamIdentity(const std::string &input,const EffectPlanNode &node) {
    std::string value=input;
    const auto append=[&](const std::string &s){const uint64_t size=s.size();value.append(reinterpret_cast<const char*>(&size),sizeof(size));value+=s;};
    append(node.id);append(node.kind);append(shaderIdentity(node));append(node.method);append(node.modelPath);
    append(std::to_string(node.outputWidth));append(std::to_string(node.outputHeight));
    append(std::to_string(node.presentationScale));append(node.resolutionAuto?"auto":"manual");append(node.resizeDirection);append(std::to_string(node.intrinsicScale));
    append(std::to_string(node.workingScale));
    for(const auto &[name,values]:node.shader.parameters){append(name);const uint64_t count=values.size();value.append(reinterpret_cast<const char*>(&count),sizeof(count));value.append(reinterpret_cast<const char*>(values.data()),values.size()*sizeof(float));}
    for(const auto &[name,item]:node.settings.values){append(name);value+=char(item.index());
        if(const auto p=std::get_if<bool>(&item))value+=char(*p);
        else if(const auto p=std::get_if<double>(&item))value.append(reinterpret_cast<const char*>(p),sizeof(*p));
        else if(const auto p=std::get_if<std::string>(&item))append(*p);
    }
    return digest(value);
}
// The input contract after a node: downstreamIdentity without the node's
// numeric controls. A later history-owning row keeps its history and
// prepared resources across those control edits; size, format, color,
// method, shader and every switch still change it.
std::string contractIdentity(const std::string &input,const EffectPlanNode &node) {
    auto contract=node;contract.shader.parameters.clear();
    auto &values=contract.settings.values;for(auto item=values.begin();item!=values.end();)item=std::holds_alternative<double>(item->second)?values.erase(item):std::next(item);
    return downstreamIdentity(input,contract);
}
struct OptionalProvider {
    using Create=ShaderNode *(*)(const ShaderSpec *);
    using CreateScaler=ShaderNode *(*)(const char *);
    using Error=const char *(*)();
    using Completion=int(*)(const ShaderNode *,char *,size_t);
    using Clone=ShaderNode *(*)(const ShaderNode *,const ShaderParameters *);
    using SetColor=int(*)(ShaderNode *,const ImageColorDescription *);
    using PrepareTiming=int(*)(ShaderNode *);
    using EncodeTimed=int(*)(ShaderNode *,const ShaderFrame *,const RSLibplaceboGpuTimingRequest *,char *,size_t);
    using BindScene=int(*)(ShaderNode*,const RSShaderSceneInputsV1*);
    void *handle=nullptr;Create create=nullptr;CreateScaler createScaler=nullptr;Error error=nullptr;Completion completion=nullptr;Clone clone=nullptr;SetColor setColor=nullptr;
    PrepareTiming prepareTiming=nullptr;EncodeTimed encodeTimed=nullptr;BindScene bindScene=nullptr;
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
        clone=reinterpret_cast<Clone>(dlsym(handle,"rsCloneLibplaceboShaderNode"));
        setColor=reinterpret_cast<SetColor>(dlsym(handle,"rsSetLibplaceboNodeColor"));
        const auto timingABI=reinterpret_cast<uint32_t(*)()>(dlsym(handle,"rsLibplaceboGpuTimingABI"));
        if(timingABI&&timingABI()==1){prepareTiming=reinterpret_cast<PrepareTiming>(dlsym(handle,"rsPrepareLibplaceboNodeGpuTiming"));encodeTimed=reinterpret_cast<EncodeTimed>(dlsym(handle,"rsEncodeLibplaceboNodeGpuTimed"));}
        const auto sceneABI=reinterpret_cast<uint32_t(*)()>(dlsym(handle,"rsLibplaceboSceneInputsAPI"));if(sceneABI&&sceneABI()==1)bindScene=reinterpret_cast<BindScene>(dlsym(handle,"rsLibplaceboBindSceneInputs"));
        if(!abi||abi()!=1||!create||!error){dlclose(handle);handle=nullptr;throw std::runtime_error("The libplacebo shader provider has an incompatible API");}
    }
    ~OptionalProvider(){if(handle)dlclose(handle);}
};
std::shared_ptr<ShaderNode> shaderNode(const EffectPlanNode &node) {
    if(node.format=="isf")return makeISFShaderNode(node.shader);
    if(node.format=="magpie")return makeMagpieShaderNode(node.shader);
    if(node.format=="native")return makeNativeImageShaderNode(node.shader,node.modelPath,node.modelOperation);
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
std::shared_ptr<ShaderNode> forkShader(const EffectPlanNode&node,const std::shared_ptr<ShaderNode>&previous){
    if(node.format=="isf")return forkISFShaderNode(previous,node.shader);
    if(node.format=="magpie")return forkMagpieShaderNode(previous,node.shader);
    if(node.format=="native")return forkNativeImageShaderNode(previous,node.shader,node.modelPath,node.modelOperation);
    if(node.format!="libplacebo")return forkCoreShaderNode(previous,node.shader);
    auto provider=optionalProvider();if(!provider->clone)return {};
    auto clone=provider->clone(previous.get(),&node.shader.parameters);if(!clone)return {};
    return std::shared_ptr<ShaderNode>(clone,[provider](ShaderNode*p){delete p;});
}
EffectPlanSize shaderOutputSize(const EffectPlanNode&node,EffectPlanSize input,EffectPlanSize presentation,std::shared_ptr<ShaderNode>&geometryNode){
    const bool explicitExtent=node.outputWidth||node.outputHeight||node.presentationScale||node.resolutionAuto;
    const auto selected=explicitExtent?spatialOutputSize(node,input,presentation):EffectPlanSize{};
    double width=explicitExtent?selected.width:node.outputPresentation?presentation.width:std::ceil(input.width*node.outputScaleX);
    double height=explicitExtent?selected.height:node.outputPresentation?presentation.height:std::ceil(input.height*node.outputScaleY);
    if(node.format=="magpie"){geometryNode=shaderNode(node);geometryNode->setParameters(node.shader.parameters);
        const auto geometry=magpieOutputGeometry(geometryNode.get(),input.width,input.height,explicitExtent?selected.width:presentation.width,explicitExtent?selected.height:presentation.height);
        if(!geometry.error.empty())throw std::runtime_error(geometry.error);width=geometry.width;height=geometry.height;}
    if(!explicitExtent&&node.workingScale!=1){width=std::max(1.,std::ceil(width*node.workingScale));height=std::max(1.,std::ceil(height*node.workingScale));}
    if(!std::isfinite(width)||!std::isfinite(height)||width<1||height<1||width>16384||height>16384)throw std::runtime_error("Shader output dimensions must be from 1 to 16384 pixels");
    return {unsigned(width),unsigned(height)};
}
bool sameGeneration(const GraphicsConfig &a,const GraphicsConfig &b) {
    if(bool(a.generation)!=bool(b.generation))return false;
    if(!a.generation)return true;
    const auto &x=*a.generation,&y=*b.generation;
    return a.generationMethod==b.generationMethod&&x.modelPath==y.modelPath&&x.fp16==y.fp16&&x.performance==y.performance&&x.flowScale==y.flowScale&&x.multiplier==y.multiplier;
}
}
std::shared_ptr<ShaderNode> makeLibplaceboShaderNode(const ShaderSpec &spec){return optionalShader(spec);}
namespace {
class ShaderCallBindings {
 ShaderSceneInputScope scope;std::shared_ptr<ShaderNode>node;std::shared_ptr<OptionalProvider>module;bool isf=false,placebo=false;
public:
 ShaderResult result{true,{}};
 ShaderCallBindings(const std::shared_ptr<ShaderNode>&n,const std::string&format,const RSShaderSceneInputsV1*p):scope(p),node(n){
  if(!p)return;
  if(format=="isf"){isf=true;result=bindISFSceneInputs(node,p);}
  else if(format=="libplacebo"){module=optionalProvider();if(!module->bindScene){result={false,"The installed libplacebo provider has no named scene input interface"};return;}placebo=true;if(module->bindScene(node.get(),p))result={false,module->error()?:"The libplacebo scene input binding is unavailable"};}
  else if(format!="fx"&&format!="magpie"&&format!="slangp")result={false,"This shader provider does not expose named per-frame scene inputs"};
 }
 ~ShaderCallBindings(){if(isf)bindISFSceneInputs(node,nullptr);if(placebo)module->bindScene(node.get(),nullptr);}
};
bool generationCameraAvailable(const std::string&method,const RSTemporalFrame*scene){if(!scene)return false;if(scene->flags&RS_TEMPORAL_CAMERA_VALID)return true;if(method=="metalfx")if(@available(macOS 27.0,*)){const auto matrices=temporalSceneMatrices(*scene);return matrices&&(matrices->flags&(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))==(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID)&&(matrices->flags&(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE));}return false;}
ShaderResult sceneShaderCall(const std::shared_ptr<ShaderNode>&node,const std::string&format,const ShaderFrame&frame,const RSShaderSceneInputsV1*inputs,bool prepare){ShaderCallBindings bindings(node,format,inputs);if(!bindings.result.encoded)return bindings.result;return prepare?node->prepare(frame):node->encode(frame);}

}
struct EffectSceneGuideHistory {struct Sample{uint64_t id=0;float x=0,y=0;unsigned width=0,height=0;};std::mutex mutex;Sample latest,previous;uint64_t qualityEpoch=1,qualityContent=0;};
struct EffectSceneLease {bool resolvedColor=false;RSTemporalFrame frame{};id<MTLTexture>color=nil,output=nil;std::array<id<MTLTexture>,5>guides{};std::optional<RSSceneMatrices>matrices;std::shared_ptr<const SceneAovLease>aovs;std::shared_ptr<void>storage;std::shared_ptr<const EffectSceneLease>upstream;const EffectSceneLease*guideSource=nullptr;std::shared_ptr<EffectSceneGuideHistory>guideHistory;};
const RSTemporalFrame&rawSceneGuides(const std::shared_ptr<const EffectSceneLease>&lease){return lease->guideSource?lease->guideSource->frame:lease->frame;}
std::optional<RSTemporalFrame>retainedSceneFrame(const std::shared_ptr<const EffectSceneLease>&lease){return lease?std::optional<RSTemporalFrame>(lease->frame):std::nullopt;}
struct EffectExecution::Impl {
    id<MTLTexture>boundaryTarget=nil;std::shared_ptr<SceneBoundaryOutput>boundaryOutput;bool boundarySuffix=false;
    struct Row {
        EffectPlanNode spec;
        // Exact input pixels (caches, redraws) and the input contract
        // (reuse of history-owning nodes, history continuity).
        std::string inputIdentity,mappedInputIdentity,historyIdentity,mappedHistoryIdentity;
        std::shared_ptr<ShaderNode> shader;
        std::shared_ptr<ShaderNode> neural;
        std::shared_ptr<SpatialEncoder> spatial;
        std::shared_ptr<TemporalOwner> temporal;
        std::shared_ptr<NeuralSceneEncoder> neuralScene;
        std::shared_ptr<NativeSceneShader> nativeScene;
        std::shared_ptr<SceneShaderInputs>namedInputs;
        std::optional<RSTemporalFrame>preparationScene;
        std::optional<RSSceneMatrices>preparationMatrices;
        std::shared_ptr<const SceneAovLease>preparationAovs;
        std::shared_ptr<ColorIsland>colorIsland;
        id<MTLCommandQueue>preparedQueue=nil;
        std::optional<ShaderFrame>preparationFrame;
        std::optional<DepthFrame>preparationDepth;
        bool reusedPreparation=false;unsigned guideDemand=0;
        uint32_t temporalMethod=0,temporalProfile=0;
        bool temporalLinearABI=false,temporalColorInputIdentity=false,temporalPrepared=false;
        float temporalExposureScale=1;
        float sharpness=.5f;
        SpatialMethod method=SpatialMethod::Bilinear;
        SpatialConfig config;
        bool resizes=false,fitBypass=false;std::string bypass;
        // The bypass is a neural provider still warming: the row reports
        // Preparing with activeMethod "pending" until its warm node is adopted.
        bool warming=false;
        // A live edit that failed for this row: the row runs its previous
        // working version and reports this reason with activeMethod "retained".
        std::string retained;
        bool externalTiming=false;std::string timingReason;
        unsigned targetWidth=0,targetHeight=0;
        MTLPixelFormat targetFormat=MTLPixelFormatInvalid;
    };
    struct Scratch {
        struct Prepared:std::enable_shared_from_this<Prepared>{PreparedImageLease key;std::atomic<bool>warming{false};
            PooledImage acquire(){auto value=key.acquire();if(!value&&!warming.exchange(true)){auto self=shared_from_this();dispatch_async(effectPreparationQueue(),^{@autoreleasepool{try{self->key.prepare();}catch(...){}self->warming.store(false);}});}return value;}
        };
        struct Storage{std::vector<PooledImage>holds;};
        struct Pair{std::array<id<MTLTexture>,2>images{};std::shared_ptr<Prepared>prepared;};
        struct Depth{id<MTLTexture>image=nil;std::shared_ptr<Prepared>prepared;};
        struct Guides{std::array<SceneGuideTargets,2>images;std::array<std::shared_ptr<Prepared>,5>prepared;};
        __weak id<MTLCommandBuffer>commands=nil;bool preparing=true;unsigned extraHolds=0;
        std::shared_ptr<ImagePoolClient>client;std::shared_ptr<Storage>storage=std::make_shared<Storage>();
        std::vector<std::function<ShaderResult()>>completions;
        std::map<std::tuple<unsigned,unsigned,MTLPixelFormat>,Pair>images;
        std::map<std::pair<unsigned,unsigned>,Depth>depths;
        using GuideKey=std::tuple<unsigned,unsigned,bool,bool,MTLPixelFormat,MTLPixelFormat,MTLPixelFormat>;
        std::map<GuideKey,Guides>guides;bool resolvedColor=false;std::optional<RSTemporalFrame>scene;std::weak_ptr<const EffectSceneLease>lease;std::shared_ptr<const EffectSceneLease>guideLease;
        Scratch()=default;
        explicit Scratch(const Scratch&source):preparing(false),extraHolds(source.extraHolds),client(source.client),images(source.images),depths(source.depths),guides(source.guides){clearImages();storage->holds.reserve(images.size()*2+depths.size()+guides.size()*10+extraHolds);}
        void clearImages(){for(auto&[key,pair]:images)pair.images={};for(auto&[key,value]:depths)value.image=nil;for(auto&[key,value]:guides)for(auto&image:value.images)image={};if(storage&&storage.use_count()==1)storage->holds.clear();else storage.reset();}
        std::shared_ptr<Prepared>prepare(id<MTLDevice>device,unsigned width,unsigned height,MTLPixelFormat format,const char*role){
            if(!preparing)throw TransientBusy("The effect image geometry requires resource preparation");
            if(!client)client=std::make_shared<ImagePoolClient>(device);
            auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
            auto result=std::make_shared<Prepared>();result->key=client->prepare(descriptor,std::string(role)+':'+std::to_string(width)+':'+std::to_string(height)+':'+std::to_string(format),8);
            // Warm both ping-pong destinations on the existing worker. Frames
            // only acquire prepared holds, and never allocate GPU resources.
            std::array<PooledImage,2>temporary;for(auto&hold:temporary){if(!result->key.prepare()||!(hold=result->key.acquire()))throw TransientBusy("Ordered effect image capacity is busy");}
            return result;
        }
        id<MTLTexture>take(const std::shared_ptr<Prepared>&prepared){auto hold=prepared->acquire();if(!hold)throw TransientBusy("Ordered effect image capacity is busy");auto result=hold.texture();storage->holds.push_back(std::move(hold));return result;}
        void prepareTarget(id<MTLDevice>d,unsigned w,unsigned h,MTLPixelFormat f){auto&pair=images[{w,h,f}];if(!pair.prepared)pair.prepared=prepare(d,w,h,f,"effect-color");}
        void prepareDepth(id<MTLDevice>d,unsigned w,unsigned h){auto&value=depths[{w,h}];if(!value.prepared)value.prepared=prepare(d,w,h,MTLPixelFormatR32Float,"effect-depth");}
        SceneGuideTargets guideTargets(id<MTLDevice>device,const RSTemporalFrame&source,unsigned width,unsigned height,bool halfExposure,float exposureScale=1){
            const auto format=[](void*value){return value?((__bridge id<MTLTexture>)value).pixelFormat:MTLPixelFormatInvalid;};
            const auto exposure=source.exposure?(exposureScale!=1?MTLPixelFormatR32Float:halfExposure?MTLPixelFormatR16Float:format(source.exposure)):MTLPixelFormatInvalid;
            auto&pair=guides[{width,height,bool(source.depth),bool(source.motion),exposure,format(source.reactive),format(source.transparency)}];
            auto&targets=pair.images[(source.depth&&pair.images[0].depth==(__bridge id<MTLTexture>)source.depth)||(source.motion&&pair.images[0].motion==(__bridge id<MTLTexture>)source.motion)?1:0];targets.width=width;targets.height=height;
            const std::array<MTLPixelFormat,5>formats{source.depth?MTLPixelFormatR32Float:MTLPixelFormatInvalid,source.motion?MTLPixelFormatRG32Float:MTLPixelFormatInvalid,exposure,format(source.reactive),format(source.transparency)};
            std::array<id<MTLTexture> __strong *,5>textures{&targets.depth,&targets.motion,&targets.exposure,&targets.reactive,&targets.transparency};
            constexpr const char*roles[]={"effect-guide-depth","effect-guide-motion","effect-guide-exposure","effect-guide-reactive","effect-guide-transparency"};
            for(unsigned i=0;i<formats.size();++i)if(formats[i]!=MTLPixelFormatInvalid&&!*textures[i]){if(!pair.prepared[i])pair.prepared[i]=prepare(device,i==2?1:width,i==2?1:height,formats[i],roles[i]);*textures[i]=take(pair.prepared[i]);}return targets;
        }
        id<MTLTexture>depthTarget(id<MTLDevice>device,unsigned width,unsigned height){auto&value=depths[{width,height}];if(!value.prepared)prepareDepth(device,width,height);if(!value.image)value.image=take(value.prepared);return value.image;}
        id<MTLTexture>target(id<MTLDevice>device,unsigned width,unsigned height,MTLPixelFormat format,id<MTLTexture>source){auto&pair=images[{width,height,format}];if(!pair.prepared)prepareTarget(device,width,height,format);if(!pair.images[0])pair.images[0]=take(pair.prepared);if(pair.images[0]!=source)return pair.images[0];if(!pair.images[1])pair.images[1]=take(pair.prepared);return pair.images[1];}
        id<MTLTexture>target(id<MTLDevice>d,const Row&row,id<MTLTexture>source){return target(d,row.targetWidth,row.targetHeight,row.targetFormat,source);}
    };
    std::shared_ptr<Scratch::Prepared>recordedImages;
    std::shared_ptr<const EffectPlanSnapshot> snapshot;
    std::string builtFor;
    std::shared_ptr<EffectQualitySession>quality;
    uint64_t qualityAdoption=0;
    uint32_t qualityExternalMask=0,qualityGenerationMask=0;EffectQualityPoint qualityPoint=EffectQualityPoint::Source;
    struct ExternalQualityFrame {
        std::mutex mutex;std::shared_ptr<EffectQualitySession>session;std::shared_ptr<const EffectPlanSnapshot>snapshot;
        AdaptiveQualitySample sample;uint64_t adoption=0;uintptr_t context=0;EffectQualityPoint point;uint32_t expected=0,seen=0;uint64_t nanoseconds=0;
        bool completed=false,failed=false,published=false;std::array<unsigned,32>expectedJobs{},reportedJobs{};uint32_t generationExpected=0;std::map<uint32_t,std::vector<std::function<uint64_t()>>>generationTickets;
        ~ExternalQualityFrame(){try{if(!published&&session&&snapshot&&snapshot->quality){session->timingUnavailable(*snapshot->quality,adoption,point,"Waiting for every affected external GPU interval to complete");session->publish(context,snapshot->revision);}}catch(...){} }
        void publish()noexcept{try{
            AdaptiveQualitySample measured;bool invalid=false;
            {std::lock_guard guard(mutex);if(published||!completed||!failed&&seen!=expected)return;published=true;measured=sample;measured.milliseconds=nanoseconds/1e6;invalid=failed;}
            if(!invalid&&!measured.milliseconds)return;
            if(invalid)session->timingUnavailable(*snapshot->quality,adoption,point,"The affected external renderer did not report a complete GPU timestamp interval");
            else session->observe(*snapshot->quality,adoption,measured,point,RuntimeAdaptiveQualityScope::ExternalProcessing);
            session->publish(context,snapshot->revision);
        }catch(...){} }
        void expect(uint32_t bit){std::lock_guard guard(mutex);for(unsigned i=0;i<32;++i)if(bit==(uint32_t(1)<<i)){++expectedJobs[i];seen&=~bit;return;}failed=true;}
        void generation(uint32_t bit,std::function<uint64_t()>ticket){std::lock_guard guard(mutex);if(completed)failed=true;else generationTickets[bit].push_back(std::move(ticket));}
        void complete(bool success)noexcept{try{
            std::map<uint32_t,std::vector<std::function<uint64_t()>>>tickets;{std::lock_guard guard(mutex);if(completed)return;tickets=std::move(generationTickets);}
            for(unsigned index=0;index<32;++index){const auto bit=uint32_t(1)<<index;if(!(generationExpected&bit))continue;uint64_t ns=0;bool valid=success;const auto found=tickets.find(bit);if(found==tickets.end()||found->second.empty())valid=false;else for(const auto&ticket:found->second){const auto value=ticket?ticket():0;if(!value||UINT64_MAX-ns<value){valid=false;break;}ns+=value;}expect(bit);reported(bit,valid?ns:0);}
            {std::lock_guard guard(mutex);completed=true;failed|=!success;}publish();
        }catch(...){} }
        void reported(uint32_t bit,uint64_t ns,bool noWork=false)noexcept{try{{std::lock_guard guard(mutex);for(unsigned i=0;i<32;++i)if(bit==(uint32_t(1)<<i)){if(++reportedJobs[i]>expectedJobs[i])failed=true;if(reportedJobs[i]==expectedJobs[i])seen|=bit;break;}if(!ns&&!noWork||UINT64_MAX-nanoseconds<ns)failed=true;else nanoseconds+=ns;}publish();}catch(...){} }
    };
    std::mutex qualityFramesMutex;std::map<std::tuple<void*,uint64_t,uint64_t>,std::weak_ptr<ExternalQualityFrame>>qualityFrames;
    std::atomic<uint64_t>qualityTimingTokens{0};
    std::shared_ptr<ExternalQualityFrame>externalQualityFrame(const ShaderFrame&frame,const ImageContentStamp*content,bool generated,bool redraw){
        const bool grouped=content&&content->qualityContentId&&content->qualityEpoch;
        if(!qualityExternalMask||!quality||!snapshot->quality||redraw||!grouped&&(generated||content&&content->synthetic)||!quality->supports(*snapshot->quality,qualityAdoption,qualityPoint))return {};
        const auto contentId=grouped?content->qualityContentId:content?content->contentId:frame.frameId,epoch=grouped?content->qualityEpoch:content?content->epoch:1;const auto key=std::make_tuple((__bridge void*)frame.commands,contentId,epoch);
        std::lock_guard guard(qualityFramesMutex);for(auto i=qualityFrames.begin();i!=qualityFrames.end();)if(i->second.expired())i=qualityFrames.erase(i);else++i;
        if(auto found=qualityFrames.find(key);found!=qualityFrames.end())if(auto retained=found->second.lock())return retained;
        if(qualityFrames.size()>=32)return {};
        auto value=std::make_shared<ExternalQualityFrame>();value->session=quality;value->snapshot=snapshot;value->adoption=qualityAdoption;value->context=statusContext;value->point=qualityPoint;value->expected=qualityExternalMask;value->generationExpected=qualityGenerationMask;value->sample={quality->nextSequence(),contentId,epoch,0,true,false};qualityFrames[key]=value;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){value->complete(commands.status==MTLCommandBufferStatusCompleted);}];return value;
    }
    std::shared_ptr<const EffectPlanSnapshot>continuationSnapshot;
    std::string sceneIdentity;
    std::vector<Row> rows;
    size_t split=0,firstSplit=0;
    std::vector<EffectGenerationStage>stages;
    std::pair<EffectQualityPoint,std::string>qualityContract(){
        qualityExternalMask=qualityGenerationMask=0;
        auto point=EffectQualityPoint::Source;const auto request=snapshot->quality;if(!request)return {point,{}};
        const auto position=[&](const std::string&id){const auto n=std::find_if(snapshot->nodes.begin(),snapshot->nodes.end(),[&](const auto&node){return node.id==id;});return size_t(n-snapshot->nodes.begin());};
        const auto target=position(request->nodeId);
        if(temporalEnd&&target<=position(rows[temporalEnd-1].spec.id))point=EffectQualityPoint::Scene;
        else if(split<rows.size()&&target>=position(rows[split].spec.id))point=EffectQualityPoint::Final;
        for(size_t index=target;index<snapshot->nodes.size();++index){const auto&node=snapshot->nodes[index];if(!node.enabled)continue;
            const auto row=std::find_if(rows.begin(),rows.end(),[&](const auto&row){return row.spec.id==node.id;});
            const auto generatedStage=std::find_if(stages.begin(),stages.end(),[&](const auto&stage){return stage.id==node.id;});const bool generation=generatedStage!=stages.end();
            const bool encoded=generation||(row!=rows.end()&&row->bypass.empty());
            if(encoded&&node.gpuWorkScope!="caller-command-buffer"){
                if(row!=rows.end()&&node.gpuWorkScope=="external-queues"&&row->externalTiming)qualityExternalMask|=uint32_t(1)<<size_t(row-rows.begin());
                else if(generation&&node.gpuWorkScope=="external-queues"&&generatedStage->encoder->gpuTimingAvailable()){const auto bit=uint32_t(1)<<unsigned(rows.size()+size_t(generatedStage-stages.begin()));qualityExternalMask|=bit;qualityGenerationMask|=bit;}
                else {qualityExternalMask=qualityGenerationMask=0;return {point,row!=rows.end()&&!row->timingReason.empty()?row->timingReason:node.gpuWorkScope=="external-queues"?"The affected provider's GPU duration is not reported by the frame command buffer":"Waiting for the affected provider's declared GPU timing scope"};}
            }
            if(index!=target){
                const auto factor=node.settings.values.find("spatialMultiplier");
                const bool fittedSpatial=node.kind=="spatial"&&(node.outputWidth||node.outputHeight||node.presentationScale||(!node.resolutionAuto&&node.method!="downsample"&&node.resizeDirection!="downsample"&&(factor==node.settings.values.end()||std::holds_alternative<std::monostate>(factor->second))));
                if(encoded&&(node.kind=="temporal"||fittedSpatial||node.kind=="shader"&&(node.outputPresentation||node.outputWidth||node.outputHeight||node.presentationScale)))break;
            }
        }
        qualityPoint=point;return {point,{}};
    }
    size_t temporalEnd=0;
    // A donor holds only an accepted chain's rows that a release build may
    // still reuse; it is never encoded or adopted.
    bool donor=false;
    bool generation=false,depthRequired=false,memoryDegraded=false,sceneRequired=false;uint32_t plainDepthMask=0;std::atomic<uintptr_t>statusContext{0};
    unsigned generationW=0,generationH=0;ImageColorSpace colorSpace=ImageColorSpace::LegacySDR;
    ImageColorDescription colorDescription;
    std::string generationInputIdentity;
    GraphicsConfig graphics;
    std::shared_ptr<GenerationEncoder> generator;
    id<MTLDevice> device;
    id<MTLCommandQueue> queue,finalQueue;
    unsigned inputW=0,inputH=0,outputW=0,outputH=0,storageOutputW=0,storageOutputH=0;
    MTLPixelFormat inputFormat,outputFormat;
    std::mutex scratchLock;
    std::mutex failureLock;
    std::map<std::string,std::string> failures,reported;
    std::map<std::string,std::pair<std::string,std::chrono::steady_clock::time_point>> spatialReports;
    struct SpatialBypass {std::string id,method;unsigned width,height;size_t position;};
    std::vector<SpatialBypass> spatialBypasses;
    std::set<std::string> unavailableTargets;
    std::map<std::string,std::chrono::steady_clock::time_point> memoryRetry;
    std::map<std::string,TransientBound> transientBounds;
    std::unique_ptr<SpatialEncoder> fallback;
    std::shared_ptr<ColorEncoder>colors;std::shared_ptr<ComparisonEncoder>comparison;
    std::shared_ptr<DepthResampler>depthResampler;
    std::shared_ptr<SceneGuideEncoder>sceneGuides;
    using SceneHistory=EffectSceneGuideHistory;
    std::shared_ptr<SceneHistory>sceneHistory=std::make_shared<SceneHistory>();
    unsigned sceneInputW=0,sceneInputH=0;
    RSTemporalFrame normalizeScene(Scratch&scratch,id<MTLCommandBuffer>commands,const RSTemporalFrame&input,id<MTLTexture>colour,id<MTLTexture>output,bool jittered,bool validation=false,bool halfExposure=false,bool sourceOwned=false,const std::shared_ptr<const SceneAovLease>&retainedAovs={},float exposureScale=1,unsigned demand=GuideAll,const RSTemporalFrame*rawGuides=nullptr){
        const auto source=consumedGuides(rawGuides?*rawGuides:input,demand);
        if(!sceneGuides)throw std::runtime_error("Scene guide resources have not been prepared");
        auto actual=input;actual.commandBuffer=(__bridge void*)commands;actual.color=(__bridge void*)colour;actual.output=(__bridge void*)output;
        actual.colorX=actual.colorY=actual.outputX=actual.outputY=0;actual.outputWidth=output.width;actual.outputHeight=output.height;
        const auto aovs=retainedAovs?retainedAovs:temporalSceneAovs(input);
        const auto bindAovs=[&](){if(aovs&&bindSceneAovLease(actual,aovs)!=RS_TEMPORAL_OK)throw std::runtime_error("The exact renderer attachments could not be retained for this image");if(!validation)bindMetalFxGenerationResources(actual,input);};
        float correctionX=0,correctionY=0;const bool removeMotionJitter=source.motion&&(source.flags&RS_TEMPORAL_JITTERED_MOTION);
        if(removeMotionJitter){SceneHistory::Sample previous;{std::lock_guard guard(sceneHistory->mutex);previous=sceneHistory->latest.id==source.frameId?sceneHistory->previous:sceneHistory->latest;}
            const bool consecutive=!validation&&!(source.flags&RS_TEMPORAL_RESET)&&previous.id+1==source.frameId&&previous.width&&previous.height;
            if(consecutive){correctionX=source.jitterX/source.renderWidth-previous.x/previous.width;correctionY=source.jitterY/source.renderHeight-previous.y/previous.height;}else actual.flags|=RS_TEMPORAL_RESET;
        }
        const auto depth=(__bridge id<MTLTexture>)source.depth,motion=(__bridge id<MTLTexture>)source.motion,exposure=(__bridge id<MTLTexture>)source.exposure;
        if(sourceOwned&&(!exposure||exposureScale==1)&&(!motion||!(source.flags&(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION)))&&
           (jittered||(!source.jitterX&&!source.jitterY))&&source.renderWidth==colour.width&&source.renderHeight==colour.height&&
           !source.colorX&&!source.colorY&&
           (!depth||(!source.depthX&&!source.depthY&&depth.width==colour.width&&depth.height==colour.height&&depth.pixelFormat==MTLPixelFormatR32Float))&&
           (!motion||(!source.motionX&&!source.motionY&&motion.width==colour.width&&motion.height==colour.height&&motion.pixelFormat==MTLPixelFormatRG32Float&&source.motionScaleX==colour.width&&source.motionScaleY==colour.height))&&
           (!source.reactive||((__bridge id<MTLTexture>)source.reactive).width==colour.width&&((__bridge id<MTLTexture>)source.reactive).height==colour.height)&&
           (!source.transparency||((__bridge id<MTLTexture>)source.transparency).width==colour.width&&((__bridge id<MTLTexture>)source.transparency).height==colour.height)&&
           (!halfExposure||!exposure||exposure.pixelFormat==MTLPixelFormatR16Float)){
            actual.depth=source.depth;actual.motion=source.motion;actual.exposure=source.exposure;actual.reactive=source.reactive;actual.transparency=source.transparency;actual.depthX=actual.depthY=actual.motionX=actual.motionY=0;actual.motionScaleX=source.motionScaleX;actual.motionScaleY=source.motionScaleY;actual.jitterX=jittered?source.jitterX:0;actual.jitterY=jittered?source.jitterY:0;actual.maxRenderWidth=colour.width;actual.maxRenderHeight=colour.height;bindAovs();return actual;
        }
        const auto targets=scratch.guideTargets(device,source,colour.width,colour.height,halfExposure,exposureScale);
        const auto result=sceneGuides->encode(commands,source,targets,actual,correctionX,correctionY,removeMotionJitter,jittered,exposureScale);
        require(result);bindAovs();return actual;
    }

    std::shared_ptr<Scratch>scratchTemplate;std::vector<std::shared_ptr<Scratch>> scratch;
    void observe(const Row&row,RuntimeStatusEvent event){
        observeRuntimeStatus(event);
        for(const auto&member:row.spec.planeGroupMembers)if(member!=row.spec.id){event.stageId=member;observeRuntimeStatus(event);}
    }
    std::string failure(const Row &row){std::lock_guard<std::mutex>guard(failureLock);const auto found=failures.find(row.spec.id);return found==failures.end()?std::string{}:found->second;}
    bool targetUnavailable(const Row &row){std::lock_guard<std::mutex>guard(failureLock);return unavailableTargets.count(row.spec.id);}
    void report(const Row &row,const std::string &reason,bool persistent){
        bool changed=false;{std::lock_guard<std::mutex>guard(failureLock);if(persistent)failures[row.spec.id]=reason;
            auto &last=reported[row.spec.id];if(last!=reason){last=reason;changed=true;}}
        RuntimeStatusEvent event;event.context=statusContext;event.processing=true;event.phase=row.warming?RuntimeStatusPhase::Preparing:RuntimeStatusPhase::Bypassed;event.planRevision=snapshot->revision;
        event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;event.activeMethod=row.warming?"pending":"passthrough";event.reason=reason;
        observe(row,event);
        if(changed)nativeLog("Effect "+row.spec.kind+" ("+row.spec.method+") "+(row.warming?"pending: ":"bypassed: ")+reason);
    }
    void retain(const Row &row){
        RuntimeStatusEvent event;event.context=statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Prepared;event.planRevision=snapshot->revision;
        event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;event.activeMethod="retained";event.reason=row.retained;
        observe(row,event);nativeLog("Effect "+row.spec.kind+" ("+row.spec.method+") keeps its previous working version: "+row.retained);
    }
    bool retryTransient(const Row&row,const std::string&reason,bool impossible=false){bool retry;{
        std::lock_guard guard(failureLock);auto&bound=transientBounds[row.spec.id];bound.record();retry=!impossible;
        if(retry)memoryRetry[row.spec.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(bound.exhausted()?1000:250);
    }report(row,reason,!retry);return retry;}
    void reportSpatialText(const std::string &id,const std::string &value){
        const auto now=std::chrono::steady_clock::now();bool emit=false;
        {std::lock_guard<std::mutex>guard(failureLock);auto &last=spatialReports[id];if(last.first!=value&&now>=last.second){last={value,now+std::chrono::seconds(1)};emit=true;}}
        if(emit)nativeLog(value);
    }
    void reportSpatial(const Row &row,const SpatialStatus &status){
        if(!nativeConfig().diagnostics.enabled)return;
        reportSpatialText(row.spec.id,"Spatial stage "+row.spec.id+" requested="+std::to_string(int(status.requested))+" active="+std::to_string(int(status.active))+" input="+std::to_string(status.inputWidth)+"x"+std::to_string(status.inputHeight)+" output="+std::to_string(status.outputWidth)+"x"+std::to_string(status.outputHeight)+" reason="+status.reason);
    }
    void reportSpatialBypasses(size_t begin,size_t end){
        if(!nativeConfig().diagnostics.enabled)return;
        for(const auto &row:spatialBypasses)if(row.position>=begin&&row.position<=end)
            reportSpatialText(row.id,"Spatial stage "+row.id+" requestedMethod="+row.method+" active=bypass input="+std::to_string(row.width)+"x"+std::to_string(row.height)+" output="+std::to_string(row.width)+"x"+std::to_string(row.height)+" reason="+(row.method=="downsample"?"Reduction target already matches the input size":"Automatic fitting already matches the input size"));
    }
    ShaderResult fit(const ShaderFrame &frame,id<MTLTexture> source,id<MTLTexture> target){
        if(source.width==target.width&&source.height==target.height&&source.pixelFormat==target.pixelFormat){copy(frame.commands,source,target);return {true,{}};}
        if(!SpatialEncoder::supportsFormat(target.pixelFormat)){ColorConversion conversion;conversion.source=colorDescription;conversion.target=colorDescription;conversion.frameId=frame.frameId;conversion.ditherBits=imageQuantizationBits(target.pixelFormat);return colors->encode(frame.commands,source,target,conversion);}
        const auto result=fallback->encode(frame.commands,{source,target,frame.frameId,frame.color,frame.origin},SpatialMethod::Bilinear,{});
        return {result.encoded,result.reason,result.busy};
    }
    std::shared_ptr<Scratch>acquire(id<MTLCommandBuffer>commands){
        std::lock_guard guard(scratchLock);for(const auto&slot:scratch)if(slot->commands==commands)return slot;
        std::shared_ptr<Scratch>slot;for(const auto&value:scratch)if(value.use_count()==1){slot=value;break;}
        if(!slot){if(scratch.size()>=4||!scratchTemplate)return {};slot=std::make_shared<Scratch>(*scratchTemplate);scratch.push_back(slot);}
        slot->commands=commands;if(!slot->storage){slot->storage=std::make_shared<Scratch::Storage>();slot->storage->holds.reserve(slot->images.size()*2+slot->depths.size()+slot->guides.size()*10+slot->extraHolds);}slot->resolvedColor=false;slot->scene.reset();slot->lease.reset();slot->guideLease.reset();slot->completions.clear();
        struct Retirement{std::shared_ptr<Scratch>slot;std::atomic<bool>done{false};void finish(){if(!done.exchange(true)){slot->clearImages();slot.reset();}}~Retirement(){finish();}};
        auto held=std::make_shared<Retirement>();held->slot=slot;[commands addCompletedHandler:^(id<MTLCommandBuffer>){held->finish();}];return slot;
    }

};
EffectExecution::EffectExecution(std::shared_ptr<Impl> value):impl(std::move(value)){}
const std::string &EffectExecution::revision()const{return impl->snapshot->revision;}
const OutputPolicy&EffectExecution::outputPolicy()const{return impl->snapshot->output;}
std::shared_ptr<ComparisonEncoder>EffectExecution::comparison()const{return impl->comparison;}
EffectQualityStatus EffectExecution::qualityStatus()const{return impl->quality?impl->quality->status():EffectQualityStatus{};}
bool EffectExecution::supportsGpuQuality(EffectQualityPoint point)const{return !impl->qualityExternalMask&&impl->quality&&impl->snapshot->quality&&impl->quality->supports(*impl->snapshot->quality,impl->qualityAdoption,point);}
uint64_t EffectExecution::nextQualitySequence()noexcept{return impl->quality?impl->quality->nextSequence():0;}
void EffectExecution::observeGpuQuality(const AdaptiveQualitySample&sample,EffectQualityPoint point,RuntimeAdaptiveQualityScope scope){if(impl->quality&&impl->snapshot->quality){impl->quality->observe(*impl->snapshot->quality,impl->qualityAdoption,sample,point,scope);publishQualityStatus();}}
void EffectExecution::publishQualityStatus()const noexcept{if(impl->quality)impl->quality->publish(impl->statusContext,impl->snapshot->revision);}
const ImageColorDescription&EffectExecution::imageColor()const{return impl->colorDescription;}
bool EffectExecution::frameContractMatches(const ShaderFrame&f)const{return frameContractMatches(f,f.commands.commandQueue);}
bool EffectExecution::frameContractMatches(const ShaderFrame&f,id<MTLCommandQueue>queue)const{return f.commands.device==impl->device&&queue==impl->queue&&f.source.width==impl->inputW&&f.source.height==impl->inputH&&f.target.width==(impl->storageOutputW?:impl->outputW)&&f.target.height==(impl->storageOutputH?:impl->outputH)&&(!SpatialEncoder::supportsFormat(f.source.pixelFormat)||imageColorIsHDR(impl->colorDescription)?MTLPixelFormatRGBA16Float:f.source.pixelFormat)==impl->inputFormat&&(!SpatialEncoder::supportsFormat(f.target.pixelFormat)||imageColorIsHDR(impl->colorDescription)?MTLPixelFormatRGBA16Float:f.target.pixelFormat)==impl->outputFormat;}
id<MTLCommandQueue>EffectExecution::commandQueue()const{return impl->queue;}
id<MTLCommandQueue>EffectExecution::finalCommandQueue()const{return impl->finalQueue?:impl->queue;}
bool EffectExecution::hasDisplaySubframes()const{return std::any_of(impl->rows.begin()+impl->split,impl->rows.end(),[](const auto&row){return row.spec.displaySubframes;});}
const GraphicsConfig &EffectExecution::graphics()const{return impl->graphics;}
std::shared_ptr<GenerationEncoder> EffectExecution::generator()const{return impl->generator;}
const std::vector<EffectGenerationStage>&EffectExecution::generationStages()const{return impl->stages;}
bool EffectExecution::generationGpuTimingRequested(size_t stage)const{return stage<impl->stages.size()&&(impl->qualityGenerationMask&(uint32_t(1)<<unsigned(impl->rows.size()+stage)));}
void EffectExecution::recordGenerationGpuTiming(id<MTLCommandBuffer>commands,size_t stage,const ImageContentStamp&content,std::function<uint64_t()>ticket){if(!generationGpuTimingRequested(stage))return;ShaderFrame metadata;metadata.commands=commands;metadata.frameId=content.contentId;auto frame=impl->externalQualityFrame(metadata,&content,false,false);if(frame)frame->generation(uint32_t(1)<<unsigned(impl->rows.size()+stage),std::move(ticket));}
const std::string &EffectExecution::generationInputIdentity()const{return impl->generationInputIdentity;}
unsigned EffectExecution::generationWidth()const{return impl->generationW?impl->generationW:impl->outputW;}
unsigned EffectExecution::generationHeight()const{return impl->generationH?impl->generationH:impl->outputH;}
unsigned EffectExecution::generationOutputWidth()const{return impl->stages.empty()?generationWidth():impl->stages.back().width;}
unsigned EffectExecution::generationOutputHeight()const{return impl->stages.empty()?generationHeight():impl->stages.back().height;}
ShaderResult EffectExecution::encodeGenerationSegment(const ShaderFrame&frame,size_t stage,bool generated,const ImageContentStamp*content){return encodeGenerationSegment(frame,stage,generated,content,nullptr);}
ShaderResult EffectExecution::encodeGenerationSegment(const ShaderFrame&frame,size_t stage,bool generated,const ImageContentStamp*content,bool*displayMapped){
    if(!stage||stage>=impl->stages.size())return {false,"The generation segment is unavailable"};
    auto stamp=content?*content:ImageContentStamp{};if(generated||!impl->stages[stage-1].sceneCoordinates)stamp.scene.reset();else if(!stamp.scene)stamp.scene=captureSceneLease(frame.commands);
    return encodeRange(frame,impl->stages[stage-1].row,impl->stages[stage].row,generated,nullptr,false,&stamp,content&&content->displayMapped,displayMapped);
}
void EffectExecution::setStatusContext(uintptr_t value){impl->statusContext=value;}
bool EffectExecution::hasTemporal()const{return impl->temporalEnd!=0||impl->sceneRequired;}
bool EffectExecution::replacesTemporal()const{return impl->temporalEnd!=0;}
std::shared_ptr<const EffectPlanSnapshot>EffectExecution::sceneSuffixSnapshot()const{return impl->continuationSnapshot;}
const std::string&EffectExecution::sceneOutputIdentity()const{return impl->sceneIdentity;}
void EffectExecution::markImageBoundary(){if(impl->boundarySuffix)return;size_t count=0;if(impl->firstSplit){const auto&id=impl->rows[impl->firstSplit-1].spec.id;const auto end=std::find_if(impl->snapshot->nodes.begin(),impl->snapshot->nodes.end(),[&](const auto&node){return node.id==id;});if(end==impl->snapshot->nodes.end())return;count=size_t(end-impl->snapshot->nodes.begin())+1;for(size_t i=0;i<impl->firstSplit;++i)impl->sceneIdentity=downstreamIdentity(impl->sceneIdentity,impl->rows[i].spec);}setSceneBoundarySuffix(impl->snapshot,count);}
void EffectExecution::setSceneBoundarySuffix(std::shared_ptr<const EffectPlanSnapshot>snapshot,size_t count){
    if(impl->boundarySuffix||!snapshot||snapshot->revision!=revision()||count>snapshot->nodes.size())return;
    auto suffix=std::make_shared<EffectPlanSnapshot>(*snapshot);suffix->nodes.erase(suffix->nodes.begin(),suffix->nodes.begin()+count);impl->continuationSnapshot=std::move(suffix);impl->boundarySuffix=true;
}
ShaderResult EffectExecution::encodeSceneBoundary(const ShaderFrame&frame,const RSTemporalFrame&scene,bool*displayMapped){
    if(!impl->boundaryTarget)return {false,"The renderer copy boundary has no prepared output",true};
    auto working=frame;working.target=impl->boundaryTarget;bool mapped=false;
    auto result=encodeScene(working,scene,&mapped);if(!result.encoded)return result;
    result=encodeAfterScene(working,false,false,mapped,&mapped);
    if(!result.encoded||!result.reason.empty())return {false,result.reason,result.busy};
    // The renderer's identity copy remains intact until the complete optional
    // prefix encoded successfully into its private prepared image.
    result=impl->boundaryOutput->encode(frame.commands,working.target,frame.source,frame.target,scene.colorX,scene.colorY);if(result.encoded&&displayMapped)*displayMapped=mapped;return result;
}
ShaderResult EffectExecution::encodeRecordedScene(const ShaderFrame&frame,const RSTemporalFrame&scene,bool*displayMapped,DepthFrame*alignedDepth){@autoreleasepool{try{
    if(!impl->recordedImages||!impl->boundaryOutput)return {false,"The retained renderer output is preparing",true};
    auto scratch=impl->acquire(frame.commands);if(!scratch)return {false,"The retained renderer command capacity is busy",true};
    scratch->resolvedColor=true;
    if(!replacesTemporal()){
        auto working=frame;auto actual=scene;
        // Guide alignment consumes the logical output grid, not spare texture
        // capacity. This prepared view supplies geometry only; no RGB is read.
        if(alignedDepth&&impl->plainDepthMask){working.target=scratch->take(impl->recordedImages);actual.output=(__bridge void*)working.target;actual.outputX=actual.outputY=0;}
        if(actual.output!=scene.output){if(auto aovs=temporalSceneAovs(scene))bindSceneAovLease(actual,aovs);if(auto matrices=temporalSceneMatrices(scene))rsBindTemporalSceneMatrices(&actual,&*matrices);}
        auto result=encodeScene(working,actual,displayMapped,alignedDepth);
        if(scratch->scene){scratch->scene->output=scene.output;scratch->scene->outputX=scene.outputX;scratch->scene->outputY=scene.outputY;}
        return result;
    }
    auto processed=scratch->take(impl->recordedImages);
    auto working=frame;working.target=processed;auto actual=scene;actual.output=(__bridge void*)processed;actual.outputX=actual.outputY=0;
    if(auto aovs=temporalSceneAovs(scene))bindSceneAovLease(actual,aovs);
    if(auto matrices=temporalSceneMatrices(scene))rsBindTemporalSceneMatrices(&actual,&*matrices);
    auto result=encodeScene(working,actual,displayMapped,alignedDepth);if(!result.encoded||!result.reason.empty())return {false,result.reason,result.busy};
    const bool direct=frame.target.usage==MTLTextureUsageUnknown||(frame.target.usage&MTLTextureUsageRenderTarget);
    auto publication=direct?frame.target:scratch->take(impl->recordedImages);
    if(!direct){
        // Storage-only SDK outputs cannot be render attachments. Copy their
        // exact stored alpha into the prepared attachment; no CPU pixels or
        // shader alpha conversion is involved.
        auto copy=[frame.commands blitCommandEncoder];if(!copy)return {false,"The renderer output storage is busy",true};
        [copy copyFromTexture:frame.target sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(scene.outputX,scene.outputY,0) sourceSize:MTLSizeMake(scene.outputWidth,scene.outputHeight,1) toTexture:publication destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
    }
    result=impl->boundaryOutput->encode(frame.commands,processed,nil,publication,0,0,direct?scene.outputX:0,direct?scene.outputY:0,scene.outputWidth,scene.outputHeight);
    if(result.encoded&&!direct){auto copy=[frame.commands blitCommandEncoder];if(!copy)return {false,"The completed renderer output cannot be published",true};[copy copyFromTexture:publication sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(scene.outputWidth,scene.outputHeight,1) toTexture:frame.target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(scene.outputX,scene.outputY,0)];[copy endEncoding];}
    if(result.encoded&&scratch->scene){scratch->scene->output=scene.output;scratch->scene->outputX=scene.outputX;scratch->scene->outputY=scene.outputY;scratch->scene->outputWidth=scene.outputWidth;scratch->scene->outputHeight=scene.outputHeight;}
    return result;
}catch(const TransientBusy&error){return {false,error.what(),!error.structurallyImpossible};}catch(const std::exception&error){return {false,error.what()};}}}
bool EffectExecution::requiresDepth()const{return impl->depthRequired;}
bool EffectExecution::canDetachNeural()const{
    if(impl->generation||hasTemporal())return false;
    bool neural=false;for(const auto &row:impl->rows){
        if(row.spec.requirements.scene()||row.temporal||row.neuralScene||(row.neural&&row.spec.settings.boolean("temporal")))return false;
        neural|=row.spec.kind=="neural";
    }return neural;
}
std::function<ShaderResult()>EffectExecution::completionTicket(id<MTLCommandBuffer>commands){std::vector<std::function<ShaderResult()>>tickets;{std::lock_guard guard(impl->scratchLock);for(const auto&slot:impl->scratch)if(slot->commands==commands){tickets=slot->completions;break;}}return [tickets=std::move(tickets)]{for(const auto&ticket:tickets)if(ticket){auto result=ticket();if(!result.encoded)return result;}return ShaderResult{true,{}};};}
ShaderResult EffectExecution::finishOffline(){
    for(const auto &row:impl->rows)if(row.bypass.empty()&&row.neural){const auto result=finishNeuralNode(row.neural);if(!result.encoded)return result;}
    for(const auto &row:impl->rows)if(row.bypass.empty()&&row.shader&&row.spec.format=="native"){const auto result=finishNativeImageNode(row.shader);if(!result.encoded)return result;}
    for(const auto &row:impl->rows)if(row.bypass.empty()&&row.shader&&(row.spec.format=="libplacebo"||row.spec.method.rfind("libplacebo:",0)==0)){
        const auto provider=optionalProvider();
        if(!provider->completion)return {false,"This shader provider cannot report video processing completion. Update the graphics runtime."};
        char error[512]{};
        if(provider->completion(row.shader.get(),error,sizeof(error)))return {false,error[0]?error:"The shader provider did not process this video frame."};
    }
    return {true,{}};
}
ShaderResult EffectExecution::encode(const ShaderFrame &frame,bool suffix,bool generated){return encode(frame,suffix,generated,false,nullptr);}
ShaderResult EffectExecution::encode(const ShaderFrame &frame,bool suffix,bool generated,bool inputMapped,bool*displayMapped) {
    if(hasTemporal())return {false,"The ordered temporal stage requires its matched scene receipt"};
    return encodeRange(frame,suffix?impl->split:0,suffix?impl->rows.size():impl->firstSplit,generated,nullptr,false,nullptr,inputMapped,displayMapped);
}
ShaderResult EffectExecution::encodeScene(const ShaderFrame &frame,const RSTemporalFrame &temporal){return encodeScene(frame,temporal,nullptr);}
ShaderResult EffectExecution::encodeScene(const ShaderFrame&frame,const RSTemporalFrame&temporal,bool*displayMapped){return encodeScene(frame,temporal,displayMapped,nullptr);}
ShaderResult EffectExecution::encodeScene(const ShaderFrame&frame,const RSTemporalFrame&temporal,bool*displayMapped,DepthFrame*alignedDepth,bool inputMapped){@autoreleasepool{try{
    if(!hasTemporal())return {false,"The ordered plan has no temporal stage"};
    auto scratch=impl->acquire(frame.commands);if(!scratch)return {false,"Scene guide command capacity is busy",true};
    auto colour=frame.source;
    if(replacesTemporal()&&(temporal.colorX||temporal.colorY||colour.width!=temporal.renderWidth||colour.height!=temporal.renderHeight)){
        colour=scratch->target(impl->device,temporal.renderWidth,temporal.renderHeight,frame.source.pixelFormat,frame.source);
        auto copy=[frame.commands blitCommandEncoder];if(!copy)return {false,"The scene colour region cannot be copied"};
        [copy copyFromTexture:frame.source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(temporal.colorX,temporal.colorY,0) sourceSize:MTLSizeMake(temporal.renderWidth,temporal.renderHeight,1) toTexture:colour destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
    }
    // Retain the original guide tuple when this graph does not reconstruct the
    // scene. Each actual consumer normalizes only its prepared inputs later.
    const auto rawGuides=scratch->guideLease?&rawSceneGuides(scratch->guideLease):nullptr;
    auto canonical=replacesTemporal()?impl->normalizeScene(*scratch,frame.commands,temporal,colour,frame.target,true,false,false,false,{},1,GuideAll,rawGuides):temporal;
    // Normalization rebinds the images; a receipt for other commands stays
    // visible to the ordered stage check and never reaches the provider.
    canonical.commandBuffer=temporal.commandBuffer;
    if(auto matrices=temporalSceneMatrices(temporal);matrices&&!temporalSceneMatrices(canonical))rsBindTemporalSceneMatrices(&canonical,&*matrices);
    scratch->scene=canonical;
    const auto history=impl->sceneHistory;const auto&historySource=rawGuides?*rawGuides:temporal;const Impl::SceneHistory::Sample sample{historySource.frameId,historySource.jitterX,historySource.jitterY,historySource.renderWidth,historySource.renderHeight};const bool reset=temporal.flags&RS_TEMPORAL_RESET;
    [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){if(commands.status==MTLCommandBufferStatusCompleted){std::lock_guard guard(history->mutex);if(reset){history->previous={};history->latest=sample;}else if(sample.id>history->latest.id){history->previous=history->latest;history->latest=sample;}}}];
    DepthFrame inputDepth{(__bridge id<MTLTexture>)canonical.depth,frame.frameId,frame.origin};auto working=frame;working.source=colour;working.depth=&inputDepth;
    ShaderResult result{true,{}};if(replacesTemporal())result=encodeRange(working,0,impl->temporalEnd,false,&canonical,false,nullptr,inputMapped,displayMapped);
    if(!result.encoded)return result;
    if(!replacesTemporal()&&displayMapped)*displayMapped=inputMapped;
    if(alignedDepth){*alignedDepth={nil,0,frame.origin};if(impl->plainDepthMask&&(rawGuides?rawGuides->depth:canonical.depth)){const bool jittered=!replacesTemporal()&&!scratch->resolvedColor&&temporal.method==RS_TEMPORAL_OFF;auto aligned=impl->normalizeScene(*scratch,frame.commands,canonical,frame.target,frame.target,jittered,false,false,true,{},1,GuideDepth,replacesTemporal()?nullptr:rawGuides);*alignedDepth={(__bridge id<MTLTexture>)aligned.depth,frame.frameId,frame.origin};}}
    if(supportsGpuQuality(EffectQualityPoint::Scene)){
        uint64_t epoch=0;{std::lock_guard guard(history->mutex);if(temporal.frameId<history->qualityContent)++history->qualityEpoch;history->qualityContent=temporal.frameId;epoch=history->qualityEpoch;}
        const auto state=impl;AdaptiveQualitySample quality;quality.sequence=nextQualitySequence();quality.contentId=temporal.frameId;quality.epoch=epoch;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){if(commands.status==MTLCommandBufferStatusCompleted){auto observed=quality;observed.milliseconds=(commands.GPUEndTime-commands.GPUStartTime)*1000;state->quality->observe(*state->snapshot->quality,state->qualityAdoption,observed,EffectQualityPoint::Scene,RuntimeAdaptiveQualityScope::SourceAndProcessing);state->quality->publish(state->statusContext,state->snapshot->revision);}}];
    }
    return result;
}catch(const TransientBusy&error){return {false,error.what(),!error.structurallyImpossible};}catch(const std::exception&error){return {false,error.what()};}}}
std::shared_ptr<const EffectSceneLease>EffectExecution::captureSceneLease(id<MTLCommandBuffer>commands){
    auto scratch=impl->acquire(commands);if(!scratch||!scratch->scene)return {};if(auto prior=scratch->lease.lock())if(prior->frame.frameId==scratch->scene->frameId)return prior;
    auto lease=std::make_shared<EffectSceneLease>();lease->resolvedColor=scratch->resolvedColor||replacesTemporal();lease->frame=*scratch->scene;lease->color=(__bridge id<MTLTexture>)lease->frame.color;lease->output=(__bridge id<MTLTexture>)lease->frame.output;lease->guideHistory=impl->sceneHistory;lease->upstream=scratch->guideLease;lease->guideSource=scratch->guideLease?(scratch->guideLease->guideSource?:scratch->guideLease.get()):nullptr;lease->guides={(__bridge id<MTLTexture>)lease->frame.depth,(__bridge id<MTLTexture>)lease->frame.motion,(__bridge id<MTLTexture>)lease->frame.exposure,(__bridge id<MTLTexture>)lease->frame.reactive,(__bridge id<MTLTexture>)lease->frame.transparency};lease->matrices=temporalSceneMatrices(lease->frame);lease->aovs=temporalSceneAovs(lease->frame);lease->storage=scratch->storage;scratch->lease=lease;return lease;
}
ShaderResult EffectExecution::bindSceneImage(id<MTLCommandBuffer>commands,id<MTLTexture>colour,id<MTLTexture>output,const std::shared_ptr<const EffectSceneLease>&source,std::shared_ptr<const EffectSceneLease>&normalized){return bindSceneImage(commands,colour,output,source,normalized,FrameOrigin::TopLeft);}
ShaderResult EffectExecution::bindSceneImage(id<MTLCommandBuffer>commands,id<MTLTexture>colour,id<MTLTexture>output,const std::shared_ptr<const EffectSceneLease>&source,std::shared_ptr<const EffectSceneLease>&normalized,FrameOrigin origin){try{
    if(!source)return {false,"The final image has no retained renderer scene"};
    if(!commands||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||!colour||!output||colour.device!=commands.device||output.device!=commands.device)return {false,"The final scene association needs retaining unsubmitted commands on the actual image device"};
    // This view describes the current image. Raw guide coordinates remain in
    // the retained source lease and are resolved once by the actual consumer.
    auto result=std::make_shared<EffectSceneLease>();result->frame=source->frame;auto&actual=result->frame;
    const bool jittered=!replacesTemporal()&&!source->resolvedColor&&source->frame.method==RS_TEMPORAL_OFF;
    actual.owner=result.get();actual.commandBuffer=(__bridge void*)commands;actual.color=(__bridge void*)colour;actual.output=(__bridge void*)output;
    actual.depth=actual.motion=actual.exposure=actual.reactive=actual.transparency=nullptr;
    actual.colorX=actual.colorY=actual.outputX=actual.outputY=actual.depthX=actual.depthY=actual.motionX=actual.motionY=0;
    actual.renderWidth=actual.maxRenderWidth=colour.width;actual.renderHeight=actual.maxRenderHeight=colour.height;actual.outputWidth=output.width;actual.outputHeight=output.height;
    actual.jitterX=jittered?source->frame.jitterX*float(colour.width)/source->frame.renderWidth:0;actual.jitterY=jittered?source->frame.jitterY*float(colour.height)/source->frame.renderHeight:0;
    actual.motionScaleX=actual.motionScaleY=0;actual.flags&=~uint32_t(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION);
    result->resolvedColor=source->resolvedColor||replacesTemporal();result->color=colour;result->output=output;result->upstream=source;result->guideSource=source->guideSource?:source.get();result->guideHistory=source->guideHistory;
    result->matrices=sceneMatricesForImage(source->frame,source->matrices,jittered,origin==FrameOrigin::BottomLeft);
    if(result->matrices&&rsBindTemporalSceneMatrices(&actual,&*result->matrices)!=RS_TEMPORAL_OK)return {false,"The final image camera matrices could not be retained"};
    if(source->aovs){if(bindSceneAovLease(actual,source->aovs)!=RS_TEMPORAL_OK)return {false,"The final image attachments could not be retained"};result->aovs=temporalSceneAovs(actual);}
    bindMetalFxGenerationResources(actual,source->frame);normalized=std::move(result);return {true,{}};
}catch(const std::exception&error){return {false,error.what()};}}
ShaderResult EffectExecution::bindGenerationScene(id<MTLCommandBuffer>commands,size_t index,id<MTLTexture>colour,const std::shared_ptr<const EffectSceneLease>&lease,FrameOrigin origin,id<MTLTexture>copiedFrom){try{
    if(index>=impl->stages.size())return {false,"The generation stage is unavailable"};const auto&stage=impl->stages[index];if(!stage.encoder->requiresScene())return {true,{}};
    auto scratch=impl->acquire(commands);if(!scratch||(!lease&&!scratch->scene))return {false,"This real generation endpoint has no matching scene lease"};
    const auto&source=lease?lease->frame:*scratch->scene;const auto rawGuides=lease?&rawSceneGuides(lease):scratch->guideLease?&rawSceneGuides(scratch->guideLease):nullptr;const bool jittered=!replacesTemporal()&&!(lease?lease->resolvedColor:scratch->resolvedColor)&&source.method==RS_TEMPORAL_OFF;
    const auto attachments=lease?copiedFrom?copiedSceneAovLease(lease->aovs,copiedFrom,colour):lease->aovs:nullptr;
    auto actual=impl->normalizeScene(*scratch,commands,source,colour,colour,jittered,false,false,true,attachments,1,GuideAll,rawGuides);const auto aovs=temporalSceneAovs(actual);actual.owner=stage.state.get();if(aovs&&bindSceneAovLease(actual,aovs)!=RS_TEMPORAL_OK)return {false,"The generation endpoint attachments could not be retained"};
    bindMetalFxGenerationResources(actual,source,copiedFrom);
    if(auto matrices=sceneMatricesForImage(source,lease?lease->matrices:temporalSceneMatrices(source),jittered,origin==FrameOrigin::BottomLeft);matrices&&!temporalSceneMatrices(actual))rsBindTemporalSceneMatrices(&actual,&*matrices);
    actual.method=RS_TEMPORAL_OFF;actual.reserved=0;stage.encoder->setScene(actual);stage.encoder->setSceneColorJitter(jittered);stage.encoder->setSceneOrigin(origin);return {true,{}};
}catch(const TransientBusy&error){return {false,error.what(),!error.structurallyImpossible};}catch(const std::exception&error){return {false,error.what()};}}
ShaderResult EffectExecution::encodeAfterScene(const ShaderFrame &frame,bool suffix,bool generated){return encodeAfterScene(frame,suffix,generated,false,nullptr);}
ShaderResult EffectExecution::encodeAfterScene(const ShaderFrame &frame,bool suffix,bool generated,bool inputMapped,bool*displayMapped) {
    return encodeRange(frame,suffix?impl->split:impl->temporalEnd,suffix?impl->rows.size():impl->firstSplit,generated,nullptr,false,nullptr,inputMapped,displayMapped);
}
ShaderResult EffectExecution::encodeRealImage(const ShaderFrame&frame,bool afterScene,bool suffix){if(hasTemporal()&&!afterScene)return {false,"The retained scene image requires its matched scene receipt"};return encodeRange(frame,suffix?impl->split:afterScene?impl->temporalEnd:0,suffix?impl->rows.size():impl->split,false,nullptr,true);}
ShaderResult EffectExecution::encodeContentImage(const ShaderFrame&frame,const ImageContentStamp&content,bool suffix,bool redraw){return encodeContentImage(frame,content,suffix,redraw,nullptr);}
ShaderResult EffectExecution::encodeContentImage(const ShaderFrame&frame,const ImageContentStamp&content,bool suffix,bool redraw,bool*displayMapped){return encodeRange(frame,suffix?impl->split:hasTemporal()?impl->temporalEnd:0,suffix?impl->rows.size():redraw?impl->split:impl->firstSplit,content.synthetic,nullptr,redraw,&content,content.displayMapped,displayMapped);}
ShaderResult EffectExecution::encodeRange(const ShaderFrame&frame,size_t begin,size_t end,bool generated,const RSTemporalFrame*temporal,bool redraw,const ImageContentStamp*content){return encodeRange(frame,begin,end,generated,temporal,redraw,content,false,nullptr);}
ShaderResult EffectExecution::encodeRange(const ShaderFrame &incoming,size_t begin,size_t end,bool generated,const RSTemporalFrame *temporal,bool redraw,const ImageContentStamp*content,bool inputMapped,bool*displayMapped) { @autoreleasepool {
    ShaderFrame frame=incoming;DepthFrame retainedDepth{nil,0,FrameOrigin::TopLeft};auto sceneLease=content&&!generated?content->scene:nullptr;
    bool mapped=content?content->displayMapped:inputMapped;if(displayMapped)*displayMapped=mapped;
    try {
        if(!frame.commands||!frame.source||!frame.target||frame.commands.status>=MTLCommandBufferStatusCommitted)
            return {false,"Ordered effects require unsubmitted frame images"};
        impl->reportSpatialBypasses(begin,end);
        uint32_t rangeTimingMask=0;for(size_t index=begin;index<end;++index)rangeTimingMask|=uint32_t(1)<<index;
        auto externalQuality=(rangeTimingMask&impl->qualityExternalMask)?impl->externalQualityFrame(frame,content,generated,redraw):nullptr;
        if(begin==end&&frame.source.width==frame.target.width&&frame.source.height==frame.target.height&&frame.source.pixelFormat==frame.target.pixelFormat){copy(frame.commands,frame.source,frame.target);return {true,{}};}
        bool coordinates=!generated&&(begin==0||impl->temporalEnd&&begin==impl->temporalEnd);bool colourJittered=temporal!=nullptr;
        auto held=impl->acquire(frame.commands);
        if(!held)return {false,"Ordered effect resource capacity is busy",true};
        if(!sceneLease&&!generated)sceneLease=held->guideLease;
        const auto rawGuides=sceneLease?&rawSceneGuides(sceneLease):nullptr;
        if(sceneLease){bool known=begin==0||impl->temporalEnd&&begin==impl->temporalEnd;for(const auto&stage:impl->stages)if(stage.row<=begin)known=stage.sceneCoordinates;
            coordinates=known;
            const bool needsDepth=impl->plainDepthMask&rangeTimingMask;
            const bool aligned=frame.depth&&frame.depth->texture&&frame.depth->frameId==sceneLease->frame.frameId&&frame.depth->origin==frame.origin&&frame.depth->texture.width==frame.source.width&&frame.depth->texture.height==frame.source.height&&
                (frame.depth->texture!=(__bridge id<MTLTexture>)sceneLease->frame.depth||(!sceneLease->frame.depthX&&!sceneLease->frame.depthY));
            if(known&&needsDepth&&!aligned){const bool jittered=!replacesTemporal()&&!sceneLease->resolvedColor&&sceneLease->frame.method==RS_TEMPORAL_OFF;auto normalized=impl->normalizeScene(*held,frame.commands,sceneLease->frame,frame.source,frame.target,jittered,false,false,true,sceneLease->aovs,1,GuideDepth,rawGuides);retainedDepth={(__bridge id<MTLTexture>)normalized.depth,sceneLease->frame.frameId,frame.origin};frame.depth=&retainedDepth;}
        }
        struct Observation {size_t row=0;unsigned inputW=0,inputH=0,outputW=0,outputH=0;std::function<ShaderResult()>completion;const char*active=nullptr;};
        struct Lease {std::shared_ptr<Impl::Scratch>scratch;std::shared_ptr<Impl>execution;std::array<Observation,32>observations{};unsigned count=0;};
        auto lease=std::make_shared<Lease>();lease->scratch=held;lease->execution=impl;
        const uint64_t frameId=content?content->observationId:frame.frameId;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>completed){
            const auto execution=lease->execution;
            for(unsigned index=0;execution&&index<lease->count;++index){const auto&observed=lease->observations[index];const auto&row=execution->rows[observed.row];
                std::string problem;bool success=completed.status==MTLCommandBufferStatusCompleted;
                if(success&&observed.completion){const auto result=observed.completion();success=result.encoded;problem=result.reason;}
                if(success&&row.neuralScene&&!observed.completion){const auto result=row.neuralScene->completion();success=result.encoded;problem=result.reason;}
                if(success&&row.shader&&(row.spec.format=="libplacebo"||row.spec.method.rfind("libplacebo:",0)==0)){
                    const auto provider=optionalProvider();char message[512]{};
                    if(!provider->completion){success=false;problem="This shader provider cannot report completed processing";}
                    else if(provider->completion(row.shader.get(),message,sizeof(message))){success=false;problem=message[0]?message:"The shader provider did not complete this frame";}
                }
                if(!success&&problem.empty())problem=completed.error.localizedDescription.UTF8String?:"The effect command buffer did not complete";
                RuntimeStatusEvent event;event.context=execution->statusContext;event.processing=true;event.phase=success?RuntimeStatusPhase::Completed:RuntimeStatusPhase::Failed;
                event.frameId=frameId;event.planRevision=execution->snapshot->revision;event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;event.activeMethod=!success?std::string_view("passthrough"):!row.retained.empty()?std::string_view("retained"):observed.active?std::string_view(observed.active):event.requestedMethod;event.reason=success&&!row.retained.empty()?std::string_view(row.retained):std::string_view(problem);
                event.inputWidth=observed.inputW;event.inputHeight=observed.inputH;event.outputWidth=observed.outputW;event.outputHeight=observed.outputH;execution->observe(row,event);
            }
            lease->scratch.reset();lease->execution.reset();
        }];
        id<MTLTexture> current=frame.source;std::string reason;bool displayAdvanced=false,insideSDR=false;uint64_t displayContentId=0;
        id<MTLTexture>islandAlpha=nil;std::shared_ptr<ColorIsland>lastIsland;MTLPixelFormat islandFormat=MTLPixelFormatInvalid;
        const auto compatibleSDR=[](const Impl::Row&row){return row.colorIsland&&row.colorIsland->mapsToDisplay()&&(row.neural||row.spatial&&row.spec.method=="ls1")&&!row.spec.requirements.scene();};
        const auto closeIsland=[&]()->ShaderResult{if(!insideSDR)return {true,{}};
            auto target=held->target(impl->device,current.width,current.height,islandFormat,islandAlpha?:current);
            auto converted=lastIsland->leave(frame.commands,current,target,frame.frameId,islandAlpha);if(converted.encoded){current=target;insideSDR=false;islandAlpha=nil;lastIsland.reset();}return converted;};
        if(!SpatialEncoder::supportsFormat(current.pixelFormat)||imageColorIsHDR(impl->colorDescription)&&current.pixelFormat!=MTLPixelFormatRGBA16Float){
            auto normalized=held->target(impl->device,current.width,current.height,MTLPixelFormatRGBA16Float,current);ColorConversion conversion;conversion.source=impl->colorDescription;conversion.target=impl->colorDescription;conversion.frameId=frame.frameId;
            const auto converted=impl->colors->encode(frame.commands,current,normalized,conversion);if(!converted.encoded)return converted;current=normalized;
        }
        // The range's last plain FX row writes the final target when that
        // target can stand in for a working image; the final fit then has
        // nothing to copy. A failed row fits its input into it the same way.
        // FX reports busy only before its first write, so a held frame never
        // shows a partial target.
        constexpr auto workingUsage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
        const auto finalTarget=[&](const auto&row,size_t index,id<MTLTexture>input){const auto value=frame.target;
            return index+1==end&&!insideSDR&&row.shader&&row.spec.format=="fx"&&!row.neural&&!row.nativeScene&&!row.temporal&&!row.neuralScene&&!row.colorIsland&&value!=input&&value!=frame.source&&
                value.width==row.targetWidth&&value.height==row.targetHeight&&value.pixelFormat==row.targetFormat&&(value.usage&workingUsage)==workingUsage&&!value.framebufferOnly&&
                value.textureType==MTLTextureType2D&&value.sampleCount==1&&value.storageMode!=MTLStorageModeMemoryless;};
        for(size_t i=begin;i<end;++i) {
            auto &row=impl->rows[i];id<MTLTexture> target;
            const bool eligible=compatibleSDR(row);
            if(insideSDR&&(!eligible||!row.bypass.empty()||impl->targetUnavailable(row))){const auto converted=closeIsland();if(!converted.encoded)return converted;}
            if(!row.bypass.empty()){if(row.fitBypass&&row.resizes){auto target=held->target(impl->device,row,current);const auto fitted=impl->fit(frame,current,target);if(!fitted.encoded)return fitted;current=target;}impl->report(row,row.bypass,false);if(reason.empty())reason=row.bypass;continue;}
            if(impl->targetUnavailable(row)){if(reason.empty())reason=impl->failure(row);continue;}
            bool retried=false;{std::lock_guard<std::mutex>guard(impl->failureLock);const auto retry=impl->memoryRetry.find(row.spec.id);retried=retry!=impl->memoryRetry.end();if(retried&&std::chrono::steady_clock::now()<retry->second){const auto reported=impl->reported.find(row.spec.id);return {false,reported==impl->reported.end()?"Waiting for graphics resources":reported->second,true};}}
            const bool continueSDR=eligible&&i+1<end&&compatibleSDR(impl->rows[i+1])&&impl->rows[i+1].bypass.empty()&&!impl->targetUnavailable(impl->rows[i+1]);
            std::optional<ColorIsland::Images>colorImages;
            try{if(continueSDR){colorImages=row.colorIsland->acquire(frame.commands,current.width,current.height,row.targetWidth,row.targetHeight,1,!insideSDR);target=colorImages->outputs.front();}else if(finalTarget(row,i,current))target=frame.target;else target=held->target(impl->device,row,insideSDR?islandAlpha:current);}
            // Resource pressure holds the completed image during its retry
            // backoff; a request that can never fit remains row-local.
            catch(const TransientBusy &error){
                if(impl->retryTransient(row,error.what(),error.structurallyImpossible))return {false,error.what(),true};{std::lock_guard guard(impl->failureLock);impl->unavailableTargets.insert(row.spec.id);}if(reason.empty())reason=error.what();continue;}
            catch(const std::exception &error){
                {std::lock_guard<std::mutex>guard(impl->failureLock);impl->unavailableTargets.insert(row.spec.id);}
                impl->report(row,error.what(),true);if(reason.empty())reason=error.what();continue;
            }
            ShaderResult encoded;encoded.reason=impl->failure(row);std::function<ShaderResult()>rowCompletion;NeuralGpuTimingTicket neuralTiming;const auto imageDenials=threadImageDenials();
            // A spatial provider may complete with a fallback method; status
            // names the method that ran, with the provider's reason.
            const char*activeSpatial=nullptr;
            if(row.preparedQueue&&row.preparedQueue!=frame.commands.commandQueue)encoded={false,"The image stage is waiting for preparation on its actual execution queue",true};
            id<MTLTexture>providerInput=current,providerTarget=target;
            if(row.colorIsland&&encoded.reason.empty()){
                if(!colorImages)colorImages=row.colorIsland->acquire(frame.commands,current.width,current.height,target.width,target.height,1,!insideSDR&&!row.temporalColorInputIdentity);
                if(!insideSDR&&!row.temporalColorInputIdentity){const auto converted=row.colorIsland->enter(frame.commands,current,*colorImages,frame.frameId,mapped);if(!converted.encoded)return converted;providerInput=colorImages->input;}
                providerTarget=colorImages->outputs.front();
            }
            bool transientInputs=false;
            if(encoded.reason.empty())try {
            if((row.temporal||row.neuralScene)&&(!temporal||!coordinates)){encoded={false,"The ordered temporal stage requires unchanged matched scene inputs"};transientInputs=true;}
            else if(row.nativeScene){
                auto context=frame;context.source=providerInput;context.target=providerTarget;context.color=spatialColorForDescription(row.colorIsland?row.colorIsland->providerColor():impl->colorDescription);
                const auto source=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr;
                const auto matrices=sceneLease?sceneLease->matrices:source?temporalSceneMatrices(*source):std::nullopt;
                auto problem=!coordinates?std::string("Needs matching renderer scene coordinates"):sceneInputReason(row.spec.requirements,rawGuides?:source,matrices,sceneLease?sceneLease->aovs:source?temporalSceneAovs(*source):nullptr,true);
                if(problem.empty()&&!source)problem=row.nativeScene->sceneInputReason(context,nullptr,matrices);
                if(!problem.empty()||!source){encoded={false,problem.empty()?"Needs matching renderer scene inputs":problem};transientInputs=true;}
                else{
                    const bool jittered=temporal?colourJittered:!replacesTemporal()&&source->method==RS_TEMPORAL_OFF;
                    auto actual=impl->normalizeScene(*held,frame.commands,*source,providerInput,providerTarget,jittered,false,false,true,sceneLease?sceneLease->aovs:nullptr,1,row.guideDemand,rawGuides);
                    DepthFrame depth{(__bridge id<MTLTexture>)actual.depth,actual.frameId,frame.origin};context.depth=depth.texture?&depth:nullptr;context.frameId=actual.frameId;
                    const auto normalizedMatrices=sceneMatricesForImage(*source,matrices,jittered,frame.origin==FrameOrigin::BottomLeft);
                    problem=row.nativeScene->sceneInputReason(context,&actual,normalizedMatrices);
                    if(!problem.empty()){encoded={false,problem};transientInputs=true;}else{encoded=row.nativeScene->encodeScene(context,actual,normalizedMatrices);if(encoded.encoded)rowCompletion=row.nativeScene->completionTicket();}
                }
            }
            else if(!row.temporal&&!row.neuralScene&&row.spec.requirements.motion&&row.spec.sceneBindings.empty()){encoded={false,"This shader stage requires a supported motion texture input"};transientInputs=true;}
            else if(!row.temporal&&!row.neuralScene&&row.spec.requirements.depth&&row.spec.sceneBindings.empty()&&(!coordinates||!frame.depth||!frame.depth->texture||frame.depth->frameId!=(sceneLease?sceneLease->frame.frameId:frame.frameId))){encoded={false,"This ordered stage requires matching depth from the current game frame"};transientInputs=true;}
            else if(row.shader||row.neural) {
                auto context=frame;context.source=providerInput;context.target=providerTarget;context.depth=coordinates?frame.depth:nullptr;
                context.color=spatialColorForDescription(row.colorIsland?row.colorIsland->providerColor():impl->colorDescription);
                DepthFrame transformed{};
                if(context.depth&&row.spec.requirements.depth&&
                   (context.depth->texture.width!=current.width||context.depth->texture.height!=current.height||context.depth->origin!=frame.origin||temporal&&!colourJittered&&(temporal->jitterX||temporal->jitterY))){
                    transientInputs=true;
                    if(!impl->depthResampler)throw std::runtime_error("This depth transform has no prepared GPU resampler");
                    if(context.depth->frameId!=(sceneLease?sceneLease->frame.frameId:frame.frameId))throw std::runtime_error("Depth does not belong to this color frame");
                    auto depthTarget=held->depthTarget(impl->device,current.width,current.height);std::string problem;
                    if(!impl->depthResampler->encode(frame.commands,*context.depth,depthTarget,frame.origin,problem,temporal&&!colourJittered?temporal->jitterX:0,temporal&&!colourJittered?temporal->jitterY:0))throw std::runtime_error(problem);
                    transformed={depthTarget,context.depth->frameId,frame.origin};context.depth=&transformed;
                }
                if(row.spec.requirements.depth&&context.depth)context.frameId=context.depth->frameId;
                transientInputs=false;
                SceneShaderInputFrame namedFrame;
                if(!row.spec.sceneBindings.empty()){
                    const auto source=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr;
                    if(!coordinates||!source||!row.namedInputs){transientInputs=true;throw std::runtime_error("Needs matching prepared named scene inputs");}
                    const auto matrices=sceneLease?sceneLease->matrices:temporalSceneMatrices(*source);const auto aovs=sceneLease?sceneLease->aovs:temporalSceneAovs(*source);auto problem=sceneInputReason(row.spec.requirements,rawGuides?:source,matrices,aovs,true);if(problem.empty()&&mapped&&row.spec.inputPolicy=="linear-source"&&(row.spec.requirements.sceneAovs&((1u<<RS_SCENE_AOV_RESOLVED_RADIANCE)|(1u<<RS_SCENE_AOV_RESOLVED_SPECULAR)|(1u<<RS_SCENE_AOV_NOISY_DIFFUSE)|(1u<<RS_SCENE_AOV_NOISY_SPECULAR))))problem="Scene radiance needs the original scene-referred color domain";if(!problem.empty()){transientInputs=true;throw std::runtime_error(problem);}
                    const bool jittered=temporal?colourJittered:!replacesTemporal()&&source->method==RS_TEMPORAL_OFF;auto actual=impl->normalizeScene(*held,frame.commands,*source,providerInput,providerTarget,jittered,false,false,true,aovs,1,row.guideDemand,rawGuides);context.frameId=actual.frameId;const auto normalizedMatrices=sceneMatricesForImage(*source,matrices,jittered,frame.origin==FrameOrigin::BottomLeft);auto ready=row.namedInputs->frame(context,actual,normalizedMatrices,aovs,true,namedFrame);if(!ready.encoded){transientInputs=true;throw std::runtime_error(ready.reason);}
                }
                const auto historyScene=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr;const auto historyAovs=sceneLease?sceneLease->aovs:historyScene?temporalSceneAovs(*historyScene):nullptr;
                ShaderHistoryInput history;history.contentId=content?content->contentId:context.frameId;history.epoch=content&&content->epoch?content->epoch:historyAovs?historyAovs->value.epoch:1;history.imageRevision=content&&content->imageRevision?content->imageRevision:historyAovs?historyAovs->value.imageRevision:0;history.inputIdentity=mapped?row.mappedInputIdentity:row.inputIdentity;history.historyIdentity=mapped?row.mappedHistoryIdentity:row.historyIdentity;history.synthetic=generated||displayAdvanced||(content&&content->synthetic);history.redraw=redraw&&!displayAdvanced;history.reset=historyScene&&(historyScene->flags&RS_TEMPORAL_RESET);ShaderHistoryScope historyScope(&history);
                ShaderCallBindings inputBindings(row.shader,row.spec.format,row.spec.sceneBindings.empty()?nullptr:&namedFrame.value);if(!inputBindings.result.encoded){transientInputs=true;throw std::runtime_error(inputBindings.result.reason);}
                if(row.neural)setNeuralStatusContext(row.neural,impl->statusContext,row.spec.id,impl->snapshot->revision);
                if(row.neural||row.spec.format=="native"){if(displayAdvanced&&!displayContentId)displayContentId=displayImageSequence.fetch_add(1,std::memory_order_relaxed);NeuralInputStamp stamp;stamp.contentId=displayAdvanced?displayContentId:content?content->contentId:context.frameId;stamp.epoch=content?content->epoch:1;stamp.observationId=frameId;stamp.imageRevision=content?content->imageRevision:0;stamp.inputIdentity=mapped?row.mappedInputIdentity:row.inputIdentity;stamp.historyIdentity=mapped?row.mappedHistoryIdentity:row.historyIdentity;stamp.synthetic=displayAdvanced||(content?content->synthetic:generated);const bool measure=externalQuality&&(impl->qualityExternalMask&(uint32_t(1)<<i));encoded=row.neural?encodeNeuralStamped(row.neural,context,stamp,redraw&&!displayAdvanced,measure?&neuralTiming:nullptr):encodeNativeImageStamped(row.shader,context,stamp,redraw&&!displayAdvanced,mapped,&rowCompletion,measure?&neuralTiming:nullptr);if(measure&&encoded.encoded){const auto timing=std::move(neuralTiming);const auto bit=uint32_t(1)<<i;externalQuality->expect(bit);[frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){const auto measured=commands.status==MTLCommandBufferStatusCompleted&&timing?timing():NeuralGpuTimingValue{};externalQuality->reported(bit,measured.state==NeuralGpuTimingState::Complete?measured.nanoseconds:0,measured.state==NeuralGpuTimingState::NoNewWork);}];}}
                else if(externalQuality&&(impl->qualityExternalMask&(uint32_t(1)<<i))){
                    struct Ticket {std::shared_ptr<Impl::ExternalQualityFrame> frame;uint32_t bit;uint64_t token,frameId;};
                    auto*ticket=new Ticket{externalQuality,uint32_t(1)<<i,++impl->qualityTimingTokens,context.frameId};externalQuality->expect(ticket->bit);
                    RSLibplaceboGpuTimingRequest request;request.token=ticket->token;request.context=ticket;
                    request.completed=[](void*opaque,uint64_t token,uint64_t frameId,uint64_t ns){std::unique_ptr<Ticket>ticket(static_cast<Ticket*>(opaque));ticket->frame->reported(ticket->bit,token==ticket->token&&frameId==ticket->frameId?ns:0);};
                    char message[512]{};const auto status=optionalProvider()->encodeTimed(row.shader.get(),&context,&request,message,sizeof(message));encoded={status==0,message,status==2};
                }else {encoded=row.shader->encode(context);if(encoded.encoded)rowCompletion=coreShaderHistoryCompletionTicket(row.shader);}
                // NeuralNode owns its bounded unsupported-input state and
                // retries only when that input contract changes.
                if(row.neural)transientInputs=true;
            }else if(row.temporal||row.neuralScene) {
                if(temporal->commandBuffer!=(__bridge void*)frame.commands||temporal->color!=(__bridge void*)frame.source||temporal->output!=(__bridge void*)frame.target){
                    encoded={false,"The temporal scene no longer matches its original command buffer and images"};transientInputs=true;
                }else{
                    auto guideSource=*temporal;if(mapped){guideSource.preExposure=1;guideSource.exposure=nullptr;guideSource.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}auto actual=impl->normalizeScene(*held,frame.commands,guideSource,providerInput,providerTarget,colourJittered,false,row.temporalMethod==RS_TEMPORAL_METALFX,true,{},row.temporalExposureScale,mapped?GuideAll&~GuideExposure:GuideAll,rawGuides);if(mapped){actual.preExposure=1;actual.exposure=nullptr;actual.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}if(row.temporalLinearABI)actual.flags|=RS_TEMPORAL_HDR;else if(row.colorIsland)actual.flags&=~RS_TEMPORAL_HDR;if(row.colorIsland){if(row.colorIsland->mapsToDisplay()){actual.preExposure=1;actual.exposure=nullptr;actual.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}}
                    if(row.neuralScene){actual.method=row.spec.method=="xess"?RS_TEMPORAL_XESS:row.spec.method=="metalfx-denoised"?RS_TEMPORAL_METALFX_DENOISED:RS_TEMPORAL_OFF;actual.reserved=0;if(auto matrices=sceneMatricesForImage(*temporal,temporalSceneMatrices(*temporal),colourJittered,frame.origin==FrameOrigin::BottomLeft);matrices&&!temporalSceneMatrices(actual))rsBindTemporalSceneMatrices(&actual,&*matrices);encoded=row.neuralScene->encode(actual);if(encoded.encoded)rowCompletion=row.neuralScene->completionTicket();}
                    else {actual.owner=row.temporal.get();actual.method=row.temporalMethod;actual.reserved=row.temporalProfile;actual.sharpness=row.sharpness;
                        row.temporal->admit(frame.commands);
                        RSTemporalResult result{};result.size=sizeof(result);result.version=1;if(row.temporalMethod==RS_TEMPORAL_METALFX)encodeTemporalProvider(&actual,&result,row.colorIsland?row.colorIsland->providerColor():impl->colorDescription);else encodeTemporalProvider(&actual,&result);
                        encoded={result.status==RS_TEMPORAL_OK&&bool(result.encoded),result.reason,result.status==RS_TEMPORAL_BUSY};}
                    if(encoded.encoded){auto alias=actual;alias.owner=temporal->owner;alias.color=actual.output;alias.colorX=actual.outputX;alias.colorY=actual.outputY;alias.renderWidth=actual.outputWidth;alias.renderHeight=actual.outputHeight;bindMetalFxGenerationResources(alias,actual);}
                }
                coordinates=true;if(encoded.encoded)colourJittered=false;
            }else {
                const auto color=row.colorIsland&&row.method==SpatialMethod::MetalFX?SpatialColor::HDR:spatialColorForDescription(row.colorIsland?row.colorIsland->providerColor():impl->colorDescription);
                const auto result=row.spatial->encode(frame.commands,{providerInput,providerTarget,frame.frameId,color,frame.origin},row.method,row.config);
                impl->reportSpatial(row,result);
                encoded={result.encoded,result.reason,result.busy};if(result.encoded&&result.active!=row.method)activeSpatial=spatialMethodName(result.active);
            }
            }catch(const TransientBusy &error){
                if(impl->retryTransient(row,error.what(),error.structurallyImpossible))return {false,error.what(),true};encoded={false,error.what()};}
            catch(const std::exception &error){encoded={false,error.what()};}
            // A provider still owns its frame resources. Retain the coherent
            // completed presentation, including for history-based shaders;
            // fitting raw input here would alternate filtered/unfiltered frames.
            // Ordinary in-flight work becomes ready through its completion,
            // so the next frame checks it again without a memory cooldown.
            // An adapter that returned Busy after a real image denial retains
            // the same bounded resource-pressure retry as a typed refusal.
            if(encoded.busy&&threadImageDenials()!=imageDenials)impl->retryTransient(row,encoded.reason.empty()?"Waiting for graphics resources":encoded.reason);
            if(encoded.busy){RuntimeStatusEvent event;event.context=impl->statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Bypassed;event.planRevision=impl->snapshot->revision;event.stageId=row.spec.id;event.requestedMethod=row.spec.method.empty()?row.spec.format:row.spec.method;event.activeMethod="pending";event.reason=encoded.reason.empty()?std::string_view("The effect is still processing its previous image"):std::string_view(encoded.reason);event.frameId=frameId;event.inputWidth=current.width;event.inputHeight=current.height;event.outputWidth=target.width;event.outputHeight=target.height;impl->observe(row,event);return encoded;}
            if(encoded.encoded&&retried){std::lock_guard guard(impl->failureLock);impl->transientBounds.erase(row.spec.id);impl->memoryRetry.erase(row.spec.id);}
            if(encoded.encoded&&row.colorIsland){mapped=mapped||row.colorIsland->mapsToDisplay();
                if(continueSDR){if(!insideSDR)islandAlpha=current;insideSDR=true;lastIsland=row.colorIsland;islandFormat=row.targetFormat;}
                else{const auto converted=row.colorIsland->leave(frame.commands,providerTarget,target,frame.frameId,row.spec.kind=="shader"?nil:insideSDR?islandAlpha:current);if(!converted.encoded)return converted;insideSDR=false;islandAlpha=nil;lastIsland.reset();}}
            if(!encoded.encoded){
                if(insideSDR){const auto converted=closeIsland();if(!converted.encoded)return converted;}
                if(continueSDR)target=held->target(impl->device,row,current);
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
             // Neural completion supplies the effective method; enqueueing another image does not replace it.
             event.activeMethod=!encoded.encoded?"passthrough":!row.retained.empty()?"retained":row.neural?std::string_view{}:activeSpatial?std::string_view(activeSpatial):event.requestedMethod;event.reason=encoded.encoded&&!row.retained.empty()?std::string_view(row.retained):std::string_view(encoded.reason);event.frameId=frameId;
             event.inputWidth=current.width;event.inputHeight=current.height;event.outputWidth=target.width;event.outputHeight=target.height;impl->observe(row,event);}
            if(encoded.encoded&&row.neural)rowCompletion=neuralImageCompletionTicket(row.neural);if(encoded.encoded&&rowCompletion)held->completions.push_back(rowCompletion);
            if(encoded.encoded&&!row.neural&&lease->count<lease->observations.size())lease->observations[lease->count++]={i,unsigned(current.width),unsigned(current.height),unsigned(target.width),unsigned(target.height),std::move(rowCompletion),activeSpatial};
            if(encoded.encoded&&row.spec.displaySubframes)displayAdvanced=true;
            const bool preservesCoordinates=!encoded.encoded||row.spec.kind=="spatial"||bool(row.neural)||bool(row.temporal)||bool(row.neuralScene)||(row.spec.kind=="shader"&&row.spec.preservesCoordinates);
            current=target;if(!preservesCoordinates)coordinates=false;
        }
        if(insideSDR){const auto converted=closeIsland();if(!converted.encoded)return converted;}
        const auto copied=impl->fit(frame,current,frame.target);if(!copied.encoded)return copied;if(displayMapped)*displayMapped=mapped;
        if(const auto scene=temporal?temporal:sceneLease?&sceneLease->frame:held->scene?&*held->scene:nullptr){auto from=*scene;from.color=(__bridge void*)current;from.output=nullptr;from.colorX=from.colorY=0;from.renderWidth=current.width;from.renderHeight=current.height;auto to=from;to.color=(__bridge void*)frame.target;to.renderWidth=frame.target.width;to.renderHeight=frame.target.height;const bool byteCopy=current.width==frame.target.width&&current.height==frame.target.height&&current.pixelFormat==frame.target.pixelFormat;bindMetalFxGenerationResources(to,from,byteCopy?current:nil);}
        return {true,reason};
    }catch(const TransientBusy&error){return {false,error.what(),!error.structurallyImpossible};}
    catch(const std::exception &error){return {false,error.what()};}
}}
struct EffectPlanExecutor::Impl {
    EffectPlanState state;
    std::shared_ptr<const EffectPlanSnapshot>boundaryFull,boundaryPrefix;size_t boundaryCount=0;
    std::shared_ptr<EffectQualitySession>quality=std::make_shared<EffectQualitySession>();
    std::shared_ptr<EffectExecution> current;
    std::shared_ptr<EffectExecution>partial;
    std::function<ShaderResult()>waiting;
    struct Request{
        ShaderFrame frame;id<MTLCommandQueue>queue=nil;DepthFrame depth{nil,0,FrameOrigin::TopLeft};bool hasDepth=false,presentation=false,allowPending=false,release=false;
        std::shared_ptr<const EffectSceneLease>sceneLease;std::optional<RSTemporalFrame>rawGuides;
        std::optional<RSTemporalFrame>scene;std::array<id<MTLTexture>,5>guides{};std::optional<RSSceneMatrices>matrices;std::shared_ptr<const SceneAovLease>aovs;
        ImageColorSpace space=ImageColorSpace::LegacySDR;ImageColorDescription color;std::shared_ptr<const EffectPlanSnapshot>snapshot;id<MTLCommandQueue>finalQueue=nil;
        std::string key,prefix,guideKey;
    };
    // Every completed candidate build is one outcome. prepareSnapshot alone
    // converts it into adoption, a bounded wait or a failure with a reason.
    enum class Outcome{Ready,Preparing,Busy,Failed};
    struct Readiness{Outcome outcome=Outcome::Preparing;std::string reason;std::function<ShaderResult()>probe;bool memory=false;};
    struct Job{std::shared_ptr<Request>request;EffectExecutionSelection result;Readiness readiness;bool running=false,done=false;uint64_t notified=0;};
    struct Preparation{
        std::mutex mutex;std::atomic<bool>cancelled{false};std::shared_ptr<EffectPlanExecutor>compiler;std::shared_ptr<Job>job;
        EffectPreparationObserver observer;std::string desiredKey,desiredRevision,desiredContract;uint64_t sequence=1;
        dispatch_source_t readiness=nullptr;
        // A candidate reports under this preparation's own status context,
        // so frames of the retained chain cannot replace its revision and
        // reason: Preparing while it prepares or waits, then Failed. The
        // report repeats each second, because a status write is skipped
        // while another writer holds the page. Guarded by mutex.
        std::string statusKey;RuntimeStatusPhase statusPhase=RuntimeStatusPhase::Preparing;std::chrono::steady_clock::time_point statusAt{};bool statusReported=false;
        // Elapsed time only backs off observation/retry. Slow preparation can
        // finish later for this same key. Healthy rows may be adopted with a
        // recoverable pending row; only a real provider error is a failure.
        // Guarded by mutex.
        std::string boundKey,degradedKey;TransientBound busy,degraded;std::chrono::steady_clock::time_point unfinishedSince{};
        void record(const Job&job){const auto&key=job.request->key;
            if(job.readiness.outcome!=Outcome::Busy&&job.readiness.outcome!=Outcome::Preparing){if(boundKey==key)boundKey.clear();return;}
            if(boundKey!=key){boundKey=key;busy.reset();unfinishedSince=std::chrono::steady_clock::now();}
            if(job.readiness.outcome==Outcome::Busy)busy.record();
        }
        bool softGrace()const{return !boundKey.empty()&&std::chrono::steady_clock::now()-unfinishedSince>=std::chrono::seconds(2);}
        // Release before build: the accepted chain was released so that a
        // candidate it crowded out of device image memory can be admitted.
        // Callers hold their last completed output, for at most one second;
        // after that, rows that still do not fit stay pending in an adopted
        // partial chain. Guarded by mutex.
        std::optional<std::chrono::steady_clock::time_point>releasedAt;
        bool holdExpired()const{return releasedAt&&std::chrono::steady_clock::now()-*releasedAt>=std::chrono::seconds(1);}
        void report(RuntimeStatusPhase phase,const std::string&key,const std::string&revision,const std::string&reason){
            const auto now=std::chrono::steady_clock::now();if(statusKey==key&&statusPhase==phase&&now-statusAt<std::chrono::seconds(1))return;statusKey=key;statusPhase=phase;statusAt=now;statusReported=true;
            RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(this);event.processing=true;event.phase=phase;
            const auto controls=presentationControlsDigest();event.planRevision=revision;event.controlsDigest=controls;event.reason=reason;observeRuntimeStatus(event);
        }
        void failed(const std::string&key,const std::string&revision,const std::string&reason){report(RuntimeStatusPhase::Failed,key,revision,reason);}
        void accepted(){statusKey.clear();boundKey.clear();releasedAt.reset();if(std::exchange(statusReported,false))retireRuntimeStatus(reinterpret_cast<uintptr_t>(this));}
        ~Preparation(){if(readiness)dispatch_source_cancel(readiness);if(statusReported)retireRuntimeStatus(reinterpret_cast<uintptr_t>(this));}
    };
    static dispatch_queue_t notificationQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.graphics.preparation.notice",DISPATCH_QUEUE_SERIAL);return queue;}
    static void notify(const std::shared_ptr<Preparation>&state){
        std::shared_ptr<Job>job;std::function<ShaderResult()>query;uint64_t sequence=0;
        {std::lock_guard guard(state->mutex);
            if(state->cancelled.load()||!state->observer||!state->job||!state->job->done){if(state->readiness){dispatch_source_cancel(state->readiness);state->readiness=nullptr;}return;}
            job=state->job;sequence=state->sequence;if(job->notified==sequence)return;
            if(job->request->key==state->desiredKey&&job->result.preparing)query=job->readiness.probe;
        }
        ShaderResult ready{true,{}};if(query){try{ready=query();}catch(const std::exception&error){ready={false,error.what()};}catch(...){ready={false,"Graphics preparation failed"};}}
        EffectPreparationObserver observer;EffectPreparationNotice notice;
        {std::lock_guard guard(state->mutex);if(state->cancelled.load()||state->job!=job||state->sequence!=sequence||!state->observer)return;
            if(ready.busy&&!state->softGrace()&&!state->holdExpired()){if(!state->readiness){state->readiness=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,notificationQueue());
                if(state->readiness){const std::weak_ptr<Preparation>weak=state;dispatch_source_set_event_handler(state->readiness,^{if(auto state=weak.lock())notify(state);});dispatch_source_set_timer(state->readiness,dispatch_time(DISPATCH_TIME_NOW,25*NSEC_PER_MSEC),25*NSEC_PER_MSEC,5*NSEC_PER_MSEC);dispatch_resume(state->readiness);}}
                return;
            }
            if(state->readiness){dispatch_source_cancel(state->readiness);state->readiness=nullptr;}
            job->notified=sequence;observer=state->observer;notice={state->desiredRevision,state->desiredContract,sequence};
        }
        // No provider/owner mutex is held during a producer notification.
        try{observer(notice);}catch(...){}
    }
    std::shared_ptr<Preparation>preparation;
    std::string acceptedKey,acceptedContractKey,acceptedError,buildKey,guideKey,acceptedGuideKey,partialKey;
    uint64_t sceneRecoveryGeneration=0,bypassEpoch=0;bool sceneRecoveryRequested=false,transientBusy=false,allowPending=false,releaseRetained=false,memoryBusy=false,completePreparation=false;
    // Request digests of the latest exact inputs for up to two scopes. Warm
    // frames compare those bytes instead of hashing them again.
    struct RequestKeys {std::string prefix,geometry,revision,quality,guideKey,key,contractKey;size_t guideBytes=0;uint64_t recovery=0;bool valid=false;};
    std::array<RequestKeys,2>requestKeys;unsigned requestKeysNext=0;std::string geometry;
    const RequestKeys &keys(const std::string&revision,const std::string&prefix,size_t guideBytes,const std::string&quality,uint64_t recovery){
        RequestKeys *slot=nullptr;for(auto&value:requestKeys)if(value.valid&&value.prefix==prefix)slot=&value;
        if(slot&&slot->guideBytes==guideBytes&&slot->geometry==geometry){
            if(slot->revision==revision&&slot->quality==quality&&slot->recovery==recovery)return *slot;
        }else{
            if(!slot){slot=&requestKeys[requestKeysNext];requestKeysNext^=1;slot->prefix=prefix;}
            slot->geometry=geometry;slot->guideBytes=guideBytes;slot->guideKey=digest(geometry.substr(0,guideBytes));slot->contractKey=digest(prefix+':'+geometry);
        }
        slot->revision=revision;slot->quality=quality;slot->recovery=recovery;slot->valid=true;
        slot->key=digest(revision+':'+prefix+':'+geometry+':'+quality+":resources:"+std::to_string(recovery));return *slot;
    }
    ImageColorSpace colorSpace=ImageColorSpace::LegacySDR;uintptr_t statusContext=0;unsigned sceneInputs=0;bool opaqueDisplay=true;id<MTLCommandQueue>finalQueue=nil;
    ImageColorDescription colorDescription;
    struct PendingScene {std::string identity;std::shared_ptr<SceneComputeEncoder>encoder;};
    std::map<std::string,PendingScene>pendingScenes;
    struct PendingNative {std::string identity;ShaderParameters parameters;std::shared_ptr<ShaderNode>node;};
    std::map<std::string,PendingNative>pendingNative;
    struct PendingGeneration {std::string identity,algorithmIdentity,guideKey;std::shared_ptr<GenerationEncoder>encoder;std::shared_ptr<EffectGenerationStage::State>state;bool acceptedResource=false;};
    std::map<std::string,PendingGeneration>pendingGenerations;
    // A row whose neural provider is still warming keeps that node across
    // preparation retries, so its warm-up completes instead of restarting.
    struct PendingNeural {std::string identity;id<MTLDevice>device=nil;std::shared_ptr<ShaderNode>node;};
    std::map<std::string,PendingNeural>pendingNeural;
    std::shared_ptr<ShaderNode>neuralNode(const EffectPlanNode&node,id<MTLDevice>target){
        const auto pending=pendingNeural.find(node.id);
        if(pending!=pendingNeural.end()){if(pending->second.device==target&&pending->second.identity==downstreamIdentity({},node))return pending->second.node;pendingNeural.erase(pending);}
        return makeNeuralNode({node.modelPath,float(node.settings.number("intensity",1)),node.settings.boolean("temporal"),node.method,float(node.settings.number("denoiseStrength",1)),unsigned(node.intrinsicScale)});
    }
    std::string rejected,reported,rejectionReason,scopeIdentity,settledKey;std::chrono::steady_clock::time_point memoryRetry{};
    id<MTLDevice> device=nil;id<MTLCommandQueue> queue=nil;
    unsigned inputW=0,inputH=0,outputW=0,outputH=0;
    MTLPixelFormat inputFormat=MTLPixelFormatInvalid,outputFormat=MTLPixelFormatInvalid;
    std::vector<std::weak_ptr<TemporalOwner>> temporalOwners;
    ~Impl(){for(const auto &weak:temporalOwners)if(auto owner=weak.lock())rsReleaseTemporalOwner(owner.get());}
};
EffectPlanExecutor::EffectPlanExecutor():impl(std::make_unique<Impl>()){}
EffectPlanExecutor::~EffectPlanExecutor(){if(impl){if(impl->preparation)impl->preparation->cancelled.store(true,std::memory_order_release);retireResource(impl.release());}}
std::shared_ptr<const EffectPlanSnapshot> EffectPlanExecutor::snapshot()const{return impl->state.snapshot();}
EffectQualityStatus EffectPlanExecutor::qualityStatus()const{return impl->quality->status();}
// Inputs for the candidate come from the reader's demand; inputs of the last
// accepted execution stay captured, because a rejected live edit must keep that
// chain runnable. Neither query reads a plan.
bool EffectPlanExecutor::requiresDepth() {
    return (impl->current&&impl->current->requiresDepth())||effectPlanDemands(PlanDemandDepth);
}
bool EffectPlanExecutor::requiresTemporal() {return effectPlanDemands(PlanDemandTemporal);}
void EffectPlanExecutor::setStatusContext(uintptr_t value){impl->statusContext=value;if(impl->current)impl->current->setStatusContext(value);}
void EffectPlanExecutor::setPreparationObserver(EffectPreparationObserver observer){
    if(!impl->preparation){impl->preparation=deferredShared<Impl::Preparation>();impl->preparation->compiler=std::make_shared<EffectPlanExecutor>();}
    const auto state=impl->preparation;{std::lock_guard guard(state->mutex);state->observer=std::move(observer);if(!state->observer&&state->readiness){dispatch_source_cancel(state->readiness);state->readiness=nullptr;}}
    dispatch_async(Impl::notificationQueue(),^{Impl::notify(state);});
}
void EffectPlanExecutor::requireCompletePreparation(bool value){impl->completePreparation=value;}
EffectExecutionSelection EffectPlanExecutor::prepare(const ShaderFrame &frame,bool presentation,const RSTemporalFrame *temporal){return prepareWithColor(frame,presentation,temporal,ImageColorSpace::LegacySDR);}
EffectExecutionSelection EffectPlanExecutor::prepareWithColor(const ShaderFrame &incoming,bool presentation,const RSTemporalFrame *temporal,ImageColorSpace colorSpace){return prepareWithColorDescription(incoming,presentation,temporal,colorSpace,describeImageColor(colorSpace));}
EffectExecutionSelection EffectPlanExecutor::prepareWithColorDescription(const ShaderFrame&frame,bool presentation,const RSTemporalFrame*scene,ImageColorSpace space,const ImageColorDescription&color){return prepareSnapshot(frame,presentation,scene,space,color,{},{});}
EffectExecutionSelection EffectPlanExecutor::prepareRecordedScene(const ShaderFrame&frame,const RSTemporalFrame&scene,const ImageColorDescription&color){return prepareSnapshot(frame,true,&scene,imageColorLabel(color),color,{},"recorded-original");}
EffectExecutionSelection EffectPlanExecutor::prepareForQueue(const ShaderFrame&frame,id<MTLCommandQueue>queue,bool presentation,ImageColorSpace space,const ImageColorDescription&color){return prepareSnapshot(frame,presentation,nullptr,space,color,{}, {},queue);}
bool EffectPlanExecutor::prefersIndependentImageQueue(){return effectPlanDemands(PlanDemandIndependentImageQueue);}
bool EffectPlanExecutor::requiresPresentationQueue(){return effectPlanDemands(PlanDemandPresentationQueue);}
void EffectPlanExecutor::setFinalQueue(id<MTLCommandQueue>queue){impl->finalQueue=queue;}
EffectExecutionSelection EffectPlanExecutor::prepareSceneContinuation(const ShaderFrame&frame,const RSTemporalFrame*scene,ImageColorSpace space,const ImageColorDescription&color,std::shared_ptr<const EffectPlanSnapshot>snapshot,const std::string&prefix){return prepareSceneContinuation(frame,scene,space,color,std::move(snapshot),prefix,{});}
EffectExecutionSelection EffectPlanExecutor::prepareSceneContinuation(const ShaderFrame&frame,const RSTemporalFrame*scene,ImageColorSpace space,const ImageColorDescription&color,std::shared_ptr<const EffectPlanSnapshot>snapshot,const std::string&prefix,const std::shared_ptr<const EffectSceneLease>&lease){auto result=prepareSnapshot(frame,true,scene,space,color,std::move(snapshot),prefix,nil,lease);if(result.execution&&!result.holdPrevious&&lease){auto scratch=result.execution->impl->acquire(frame.commands);if(scratch)scratch->guideLease=lease;}return result;}
EffectExecutionSelection EffectPlanExecutor::prepareSceneBoundary(const ShaderFrame&frame,const RSTemporalFrame&scene,const ImageColorDescription&color,std::shared_ptr<const EffectPlanSnapshot>snapshot,size_t count){
    EffectExecutionSelection result;if(!snapshot||!count||count>snapshot->nodes.size())return result;
    if(impl->boundaryFull!=snapshot||impl->boundaryCount!=count){auto prefix=std::make_shared<EffectPlanSnapshot>(*snapshot);prefix->nodes.resize(count);prefix->output={};impl->boundaryFull=snapshot;impl->boundaryPrefix=std::move(prefix);impl->boundaryCount=count;}
    result=prepareSnapshot(frame,true,&scene,imageColorLabel(color),color,impl->boundaryPrefix,"scene-copy-boundary");
    if(result.execution&&!result.holdPrevious)result.execution->setSceneBoundarySuffix(std::move(snapshot),count);return result;
}
EffectExecutionSelection EffectPlanExecutor::prepareSnapshot(const ShaderFrame&incoming,bool presentation,const RSTemporalFrame*temporal,ImageColorSpace space,const ImageColorDescription&color,std::shared_ptr<const EffectPlanSnapshot>overrideSnapshot,const std::string&prefix,id<MTLCommandQueue>executionQueue,const std::shared_ptr<const EffectSceneLease>&sceneLease){@autoreleasepool{
    // A pass-through plan adopted by this process retires the accepted image,
    // even when no frame reached this executor during the bypass. A later plan
    // then prepares without presenting the earlier processed result.
    if(const auto epoch=effectPlanBypassEpoch();epoch!=impl->bypassEpoch){impl->bypassEpoch=epoch;impl->current.reset();impl->acceptedKey.clear();impl->acceptedError.clear();}
    const auto poll=overrideSnapshot?EffectPlanPoll{true,false,{},true}:impl->state.poll();auto snapshot=overrideSnapshot?std::move(overrideSnapshot):impl->state.snapshot();
    EffectExecutionSelection result;result.active=true;result.execution=impl->current;result.error=poll.error;
    if(!snapshot)return result;
    snapshot=impl->quality->select(std::move(snapshot));
    if(snapshot->mode=="simple"||(prefix.empty()&&!snapshot->output.processing()&&std::none_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled;}))){
        if(impl->preparation)impl->preparation->cancelled.store(true,std::memory_order_release);
        // Keep the same compiler owner across Off/On. An uncancellable driver
        // compilation may finish, but a toggle cannot create another worker.
        impl->current.reset();impl->acceptedKey.clear();impl->acceptedError.clear();result.execution.reset();result.active=false;return result;
    }
    if(!incoming.commands||!incoming.source||!incoming.target||!color.valid()||space==ImageColorSpace::Unsupported){result.error="The graphics preparation input contract is invalid";result.holdPrevious=bool(impl->current);return result;}
    const auto actualQueue=executionQueue?:incoming.commands.commandQueue;const auto finalQueue=impl->finalQueue?:actualQueue;if(!actualQueue||actualQueue.device!=incoming.commands.device||finalQueue.device!=incoming.commands.device||executionQueue&&temporal){result.error="Graphics resources require the actual execution queues on the producer device";result.holdPrevious=bool(impl->current);return result;}
    const auto matrices=sceneLease?sceneLease->matrices:temporal?temporalSceneMatrices(*temporal):std::optional<RSSceneMatrices>{};
    const auto aovs=sceneLease?sceneLease->aovs:temporal?temporalSceneAovs(*temporal):nullptr;
    const auto rawGuides=sceneLease?&rawSceneGuides(sceneLease):nullptr;
    auto &geometry=impl->geometry;geometry.clear();const auto append=[&](uint64_t value){geometry.append(reinterpret_cast<const char*>(&value),sizeof(value));};
    const auto imageInfo=[&](id<MTLTexture>image){append(bool(image));if(image){append(image.width);append(image.height);append(image.pixelFormat);append(image.textureType);append(image.sampleCount);append(image.usage);append(image.framebufferOnly);}};
    if(incoming.depth){imageInfo(incoming.depth->texture);append(unsigned(incoming.depth->origin));}else append(0);
    if(temporal){for(void*guide:{temporal->depth,temporal->motion,temporal->exposure,temporal->reactive,temporal->transparency})imageInfo((__bridge id<MTLTexture>)guide);for(const auto value:{temporal->renderWidth,temporal->renderHeight,temporal->outputWidth,temporal->outputHeight,temporal->maxRenderWidth,temporal->maxRenderHeight,temporal->colorX,temporal->colorY,temporal->depthX,temporal->depthY,temporal->motionX,temporal->motionY,temporal->outputX,temporal->outputY,temporal->flags&~uint32_t(RS_TEMPORAL_RESET),temporal->commandBufferKind})append(value);append(matrices?matrices->flags:0);}else append(0);
    if(rawGuides){for(void*guide:{rawGuides->depth,rawGuides->motion,rawGuides->exposure,rawGuides->reactive,rawGuides->transparency})imageInfo((__bridge id<MTLTexture>)guide);for(const auto value:{rawGuides->renderWidth,rawGuides->renderHeight,rawGuides->depthX,rawGuides->depthY,rawGuides->motionX,rawGuides->motionY,rawGuides->colorX,rawGuides->colorY,rawGuides->flags&~uint32_t(RS_TEMPORAL_RESET)})append(value);}else append(0);
    if(aovs){const auto&packet=aovs->value;append(packet.flags);append(packet.pass);append(packet.colorPass);append(packet.viewId);append(packet.epoch);for(const auto&attachment:packet.images){imageInfo((__bridge id<MTLTexture>)attachment.texture);for(uint32_t v:{attachment.x,attachment.y,attachment.width,attachment.height,attachment.encoding,attachment.space,attachment.channel,attachment.origin,attachment.pass})append(v);geometry.append(reinterpret_cast<const char*>(&attachment.scale),sizeof(float)*2);}geometry.append(reinterpret_cast<const char*>(&packet.color),sizeof(packet.color));geometry.append(reinterpret_cast<const char*>(&packet.uiColor),sizeof(packet.uiColor));geometry.append(reinterpret_cast<const char*>(&packet.hudlessColor),sizeof(packet.hudlessColor));}else append(0);
    const auto guideBytes=geometry.size();imageInfo(incoming.source);imageInfo(incoming.target);append(reinterpret_cast<uintptr_t>((__bridge void*)incoming.commands.device));append(reinterpret_cast<uintptr_t>((__bridge void*)actualQueue));append(reinterpret_cast<uintptr_t>((__bridge void*)finalQueue));append(incoming.opaqueDisplay);append(unsigned(incoming.origin));append(presentation);append(unsigned(space));append(unsigned(color.primaries));append(unsigned(color.transfer));append(unsigned(color.range));append(unsigned(color.alpha));append(color.sceneReferred);
    for(const float value:{color.referenceWhite,color.peakLuminance,color.blackLuminance,color.hlgSystemGamma})geometry.append(reinterpret_cast<const char*>(&value),sizeof(value));
    const auto qualityKey=snapshot->quality?snapshot->quality->key+':'+std::to_string(snapshot->quality->scale)+':'+std::to_string(snapshot->quality->requestId):std::string{};
    bool recoverScene=false;if(temporal&&impl->current)for(const auto&row:impl->current->impl->rows)if(row.neuralScene){const auto status=row.neuralScene->framePreparationStatus(*temporal);recoverScene|=!status.encoded&&!status.busy;}
    if(recoverScene&&!impl->sceneRecoveryRequested){++impl->sceneRecoveryGeneration;impl->sceneRecoveryRequested=true;}else if(!recoverScene)impl->sceneRecoveryRequested=false;
    const auto &keys=impl->keys(snapshot->revision,prefix,guideBytes,qualityKey,impl->sceneRecoveryGeneration);
    const auto &key=keys.key,&contractKey=keys.contractKey,&guideKey=keys.guideKey;
    const auto acceptedQuality=impl->current?impl->current->impl->snapshot->quality:nullptr;
    const bool qualityReplacement=snapshot->quality&&acceptedQuality&&snapshot->quality->key==acceptedQuality->key&&(snapshot->quality->requestId!=acceptedQuality->requestId||snapshot->quality->scale!=acceptedQuality->scale)&&snapshot->revision==impl->current->revision()&&impl->scopeIdentity==prefix;
    const bool retryResources=key==impl->acceptedKey&&impl->current&&impl->current->impl->memoryDegraded&&std::chrono::steady_clock::now()>=impl->memoryRetry;
    // Warm frames inspect metadata only. Capturing texture ownership and
    // scheduling retirement belongs to a new preparation request.
    if(key==impl->acceptedKey&&impl->current&&!retryResources){if(impl->preparation)impl->preparation->cancelled.store(true,std::memory_order_release);result.execution=impl->current;if(result.error.empty())result.error=impl->acceptedError;return result;}
    const auto pending=[&](std::string reason){result.preparing=true;result.error=reason.empty()?"Preparing graphics resources":std::move(reason);result.execution=impl->current;
        auto frame=incoming;if(prefix.empty()&&temporal&&std::none_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.kind=="temporal";})&&temporal->method!=RS_TEMPORAL_OFF)frame.source=frame.target;
        result.holdPrevious=!impl->current||impl->acceptedContractKey!=contractKey||impl->scopeIdentity!=prefix||!impl->current->frameContractMatches(frame,actualQueue)||!sameImageColorDescription(impl->current->imageColor(),color);result.qualityPreparing=qualityReplacement&&!result.holdPrevious;if(result.qualityPreparing){impl->quality->preparing(*snapshot->quality,result.error);if(poll.error.empty())result.error.clear();}return result;};
    if(!impl->preparation){impl->preparation=deferredShared<Impl::Preparation>();impl->preparation->compiler=std::make_shared<EffectPlanExecutor>();}
    const auto state=impl->preparation;state->cancelled.store(false,std::memory_order_release);
    std::unique_lock lock(state->mutex,std::try_to_lock);if(!lock.owns_lock())return pending("Preparing graphics resources");auto job=state->job;
    if(state->desiredKey!=key){state->desiredKey=key;state->desiredRevision=snapshot->revision;state->desiredContract=contractKey;state->boundKey=key;state->busy.reset();state->unfinishedSince=std::chrono::steady_clock::now();++state->sequence;}
    const auto failed=[&](std::string reason){result.preparing=false;result.error=reason.empty()?"The effect plan revision could not be prepared":std::move(reason);result.holdPrevious=impl->current&&impl->acceptedContractKey!=contractKey;
        if(qualityReplacement&&!result.holdPrevious){impl->quality->rejected(*snapshot->quality,result.error);result.qualityPreparing=true;result.error=poll.error;}
        else state->failed(key,snapshot->revision,result.error);return result;};
    if(job&&job->running){
        state->report(RuntimeStatusPhase::Preparing,key,snapshot->revision,"Preparing graphics resources");return pending("Preparing graphics resources");
    }
    if(job&&job->request->key==key&&job->done&&!retryResources){
        if(job->readiness.outcome==Impl::Outcome::Ready){
            const auto candidate=job->result.execution;
            if(!candidate||candidate->impl->builtFor!=key||candidate->revision()!=snapshot->revision)return failed("Graphics preparation returned an execution for a different request");
            // Preparation never reads or resets accepted temporal history.
            // Adoption runs on this owner's serialized producer. A skipped
            // sequence forces LSFG's existing first-use history cut after the
            // old command buffer has retired, while retaining its allocation.
            for(auto&stage:candidate->impl->stages)if(stage.historySource){stage.state->startAfterCut(*stage.historySource);stage.historySource.reset();}
            impl->current=candidate;impl->scopeIdentity=prefix;impl->acceptedKey=key;impl->acceptedContractKey=contractKey;impl->acceptedError=job->result.error;
            impl->current->impl->quality=impl->quality;if(snapshot->quality){const auto contract=impl->current->impl->qualityContract();impl->current->impl->qualityAdoption=impl->quality->adopted(*snapshot->quality,contract.first,contract.second);}
            if(impl->current->impl->memoryDegraded){if(state->degradedKey!=key){state->degradedKey=key;state->degraded.reset();}state->degraded.record();impl->memoryRetry=std::chrono::steady_clock::now()+std::chrono::milliseconds(state->degraded.exhausted()?1000:250);}
            impl->current->setStatusContext(impl->statusContext);state->accepted();result=job->result;result.changed=true;result.execution=impl->current;if(!poll.error.empty())result.error=poll.error;return result;
        }
        if(job->readiness.outcome==Impl::Outcome::Failed)return failed(job->readiness.reason);
        // The accepted chain and this edit do not both fit in device image
        // memory. Release the accepted chain and build the edit while callers
        // hold their last completed output. A resource retry of the accepted
        // revision never releases it.
        const bool release=job->readiness.outcome==Impl::Outcome::Busy&&job->readiness.memory&&impl->current&&impl->current->impl->builtFor!=key&&!state->releasedAt;
        if(release){impl->current.reset();impl->acceptedKey.clear();impl->acceptedError.clear();state->releasedAt=std::chrono::steady_clock::now();nativeLog("Graphics edit released the previous chain to fit device image memory");}
        const auto query=release?nullptr:job->readiness.probe;
        if(query){lock.unlock();ShaderResult ready;try{ready=query();}catch(const TransientBusy&error){ready={false,error.what(),!error.structurallyImpossible};}catch(const std::exception&error){ready={false,failureReason(error)};}
            lock.lock();if(state->job!=job)return pending("Preparing graphics resources");
            if(!ready.encoded&&!ready.busy)return failed(ready.reason);
            if(ready.busy&&(impl->completePreparation||!state->softGrace()&&!state->holdExpired())){state->report(RuntimeStatusPhase::Preparing,key,snapshot->revision,ready.reason);return pending(ready.reason);}
        }
    }
    auto request=deferredShared<Impl::Request>();request->frame=incoming;request->queue=actualQueue;request->frame.commands=nil;
    request->sceneLease=sceneLease;if(rawGuides)request->rawGuides=*rawGuides;
    request->allowPending=!impl->completePreparation&&(state->softGrace()||retryResources||state->holdExpired());request->release=bool(state->releasedAt);request->presentation=presentation;request->space=space;request->color=color;request->snapshot=snapshot;request->prefix=prefix;request->key=key;request->guideKey=guideKey;request->finalQueue=finalQueue;
    if(incoming.depth){request->hasDepth=true;request->depth=*incoming.depth;request->frame.depth=&request->depth;}else request->frame.depth=nullptr;
    if(temporal){request->scene=*temporal;request->guides={(__bridge id<MTLTexture>)temporal->depth,(__bridge id<MTLTexture>)temporal->motion,(__bridge id<MTLTexture>)temporal->exposure,(__bridge id<MTLTexture>)temporal->reactive,(__bridge id<MTLTexture>)temporal->transparency};request->matrices=matrices;request->aovs=aovs;}
    if(retryResources)impl->acceptedKey.clear();
    if(state->boundKey!=key){state->boundKey=key;state->busy.reset();state->unfinishedSince=std::chrono::steady_clock::now();}
    job=deferredShared<Impl::Job>();job->request=std::move(request);job->running=true;state->job=job;state->report(RuntimeStatusPhase::Preparing,key,snapshot->revision,"Preparing graphics resources");lock.unlock();
    // Provider-owned asynchronous model/SDK jobs can warm independently. The
    // graph's CPU/compiler work has one bounded lane, separate from rendering.
    dispatch_async(effectPreparationQueue(),^{@autoreleasepool{
        EffectExecutionSelection built;built.active=true;built.preparing=true;Impl::Readiness readiness;
        @try{try{if(!state->cancelled.load(std::memory_order_acquire)){
            // Explicit producers may have no AppKit control poll. Map an
            // already requested observation lease on this preparation worker
            // before their first completed image, without touching rendering.
            pollRuntimeStatus(imageProcessingRequested());
            const auto&input=*job->request;auto commands=[input.queue commandBuffer];if(!commands)throw std::runtime_error("The graphics preparation command buffer is unavailable");
            auto frame=input.frame;frame.commands=commands;std::optional<RSTemporalFrame>scene=input.scene;
            if(scene){scene->owner=job.get();scene->commandBuffer=(__bridge void*)commands;scene->color=(__bridge void*)frame.source;scene->output=(__bridge void*)frame.target;if(input.matrices)rsBindTemporalSceneMatrices(&*scene,&*input.matrices);if(input.aovs)bindSceneAovLease(*scene,input.aovs); }
            struct Binding{void*owner;~Binding(){if(owner){rsReleaseTemporalSceneMatrices(owner);rsReleaseTemporalSceneAovs(owner);}}}binding{scene?scene->owner:nullptr};
            state->compiler->impl->guideKey=input.guideKey;state->compiler->impl->allowPending=input.allowPending;state->compiler->impl->releaseRetained=input.release;
            state->compiler->impl->finalQueue=input.finalQueue;
            built=state->compiler->buildSnapshot(frame,input.presentation,scene?&*scene:nullptr,input.space,input.color,input.snapshot,input.prefix,input.key,input.rawGuides?&*input.rawGuides:nullptr,input.sceneLease);readiness.probe=state->compiler->impl->waiting;readiness.memory=state->compiler->impl->memoryBusy;readiness.outcome=built.preparing?(state->compiler->impl->transientBusy?Impl::Outcome::Busy:Impl::Outcome::Preparing):built.execution&&built.execution->impl->builtFor==input.key&&built.execution->revision()==input.snapshot->revision?Impl::Outcome::Ready:Impl::Outcome::Failed;
        }}catch(const std::exception&error){built.active=true;built.preparing=false;built.error=failureReason(error);}}@catch(NSException*error){built.active=true;built.preparing=false;built.error=error.reason.UTF8String?:"Graphics resource preparation failed";}
        {std::lock_guard guard(state->mutex);{
            if(!built.preparing&&readiness.outcome!=Impl::Outcome::Ready)readiness.outcome=Impl::Outcome::Failed;
            readiness.reason=built.error.empty()?(readiness.outcome==Impl::Outcome::Ready?std::string{}:readiness.outcome==Impl::Outcome::Failed?"The effect plan revision could not be prepared":"Preparing graphics resources"):built.error;
            job->result=std::move(built);job->readiness=std::move(readiness);if(job->request->key==state->desiredKey)state->record(*job);
        }job->running=false;job->done=true;}
        dispatch_async(Impl::notificationQueue(),^{Impl::notify(state);});
    }});
    return pending("Preparing graphics resources");
}}
EffectExecutionSelection EffectPlanExecutor::buildSnapshot(const ShaderFrame &incoming,bool presentation,const RSTemporalFrame *temporal,ImageColorSpace colorSpace,const ImageColorDescription&description,std::shared_ptr<const EffectPlanSnapshot>overrideSnapshot,const std::string&prefixIdentity,const std::string&requestIdentity,const RSTemporalFrame*rawGuides,const std::shared_ptr<const EffectSceneLease>&sourceLease) { @autoreleasepool {
    impl->waiting={};
    const auto guideSource=rawGuides?:temporal;
    impl->transientBusy=impl->memoryBusy=false;const auto denials=threadImageDenials();
    EffectExecutionSelection result;const auto poll=overrideSnapshot?EffectPlanPoll{true,false,{},true}:impl->state.poll();const auto snapshot=overrideSnapshot?std::move(overrideSnapshot):impl->state.snapshot();result.error=poll.error;
    if(!poll.error.empty()&&impl->reported!=poll.error){nativeLog("Ordered effect change unavailable; previous chain retained: "+poll.error);impl->reported=poll.error;}
    if(!snapshot){result.active=true;return result;}
    if(snapshot->mode=="simple"){result.active=!result.error.empty();return result;}
    ShaderFrame frame=incoming;
    frame.color=spatialColorForDescription(description);
    if(!description.valid()||colorSpace==ImageColorSpace::Unsupported){result.active=true;result.execution=impl->current;result.error="The image requires valid explicit color metadata";return result;}
    const auto pending=[&](const std::string&reason){result.active=true;result.preparing=true;result.error=reason.empty()?"The scene provider is preparing":reason;result.execution=impl->current;
        result.holdPrevious=!impl->current||impl->scopeIdentity!=prefixIdentity||impl->device!=frame.commands.device||impl->queue!=frame.commands.commandQueue||impl->inputW!=frame.source.width||impl->inputH!=frame.source.height||impl->outputW!=frame.target.width||impl->outputH!=frame.target.height||impl->inputFormat!=frame.source.pixelFormat||impl->outputFormat!=frame.target.pixelFormat||!sameImageColorDescription(impl->colorDescription,description);return result;};
    std::set<std::string>wantedScenes;for(const auto&node:snapshot->nodes)if(node.enabled&&node.kind=="temporal"&&(node.method=="xess"||node.method=="metalfx-denoised"))wantedScenes.insert(node.id);
    for(auto it=impl->pendingScenes.begin();it!=impl->pendingScenes.end();)if(!wantedScenes.count(it->first))it=impl->pendingScenes.erase(it);else ++it;
    std::set<std::string>wantedNative;for(const auto&node:snapshot->nodes)if(node.enabled&&node.kind=="shader"&&node.format=="native"&&!node.modelOperation.empty())wantedNative.insert(node.id);
    for(auto it=impl->pendingNative.begin();it!=impl->pendingNative.end();)if(!wantedNative.count(it->first))it=impl->pendingNative.erase(it);else ++it;
    std::set<std::string>wantedGeneration;for(const auto&node:snapshot->nodes)if(node.enabled&&node.kind=="frame-generation")wantedGeneration.insert(node.id);
    for(auto it=impl->pendingGenerations.begin();it!=impl->pendingGenerations.end();)if(!wantedGeneration.count(it->first))it=impl->pendingGenerations.erase(it);else ++it;
    std::set<std::string>wantedNeural;for(const auto&node:snapshot->nodes)if(node.enabled&&node.kind=="neural")wantedNeural.insert(node.id);
    for(auto it=impl->pendingNeural.begin();it!=impl->pendingNeural.end();)if(!wantedNeural.count(it->first))it=impl->pendingNeural.erase(it);else ++it;
    // When no reconstruction node replaces it, the real game scaler produces
    // the source that scene generation will observe at presentation.
    if(prefixIdentity.empty()&&temporal&&std::none_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.kind=="temporal";})&&
       temporal->method!=RS_TEMPORAL_OFF)frame.source=frame.target;
    result.active=true;
    std::string colorIdentity=std::to_string(int(colorSpace))+':'+std::to_string(int(description.primaries))+':'+std::to_string(int(description.transfer))+':'+std::to_string(int(description.range))+':'+std::to_string(int(description.alpha));
    for(const auto value:{description.referenceWhite,description.peakLuminance,description.blackLuminance,description.hlgSystemGamma})colorIdentity.append(reinterpret_cast<const char*>(&value),sizeof(value));colorIdentity+=description.sceneReferred?'1':'0';
    const auto sourceIdentity=imageIdentity(prefixIdentity+':'+colorIdentity+':'+(temporal?std::to_string(temporal->colorX)+','+std::to_string(temporal->colorY)+','+std::to_string(temporal->renderWidth)+','+std::to_string(temporal->renderHeight):std::string{})+':'+std::to_string(unsigned(frame.origin))+':'+(frame.opaqueDisplay?"opaque:":"alpha:")+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.device))+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.commandQueue)),frame.source);
    const auto sceneMatrices=temporal?temporalSceneMatrices(*temporal):std::optional<RSSceneMatrices>{};
    const unsigned sceneInputs=temporal?(1u|((temporal->flags&RS_TEMPORAL_CAMERA_VALID)?2u:0u)|(sceneMatrices&&sceneMatrices->flags&RS_SCENE_VIEW_VALID?4u:0u)|(sceneMatrices&&sceneMatrices->flags&RS_SCENE_PROJECTION_VALID?8u:0u)):0u;
    const auto identity=requestIdentity;
    // Release before build. The accepted execution becomes a donor holding
    // only rows this snapshot names; each donor row is dropped as soon as its
    // reuse is decided, before the candidate row allocates.
    if(impl->releaseRetained&&impl->current&&!impl->current->impl->donor){
        auto donor=std::make_shared<EffectExecution::Impl>();auto&old=*impl->current->impl;donor->donor=true;
        const auto named=[&](const std::string&id){return std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[&](const auto&node){return node.enabled&&node.id==id;});};
        donor->snapshot=old.snapshot;donor->builtFor=old.builtFor;donor->device=old.device;donor->queue=old.queue;donor->finalQueue=old.finalQueue;donor->colorSpace=old.colorSpace;donor->colorDescription=old.colorDescription;
        donor->colors=old.colors;donor->comparison=old.comparison;donor->sceneHistory=old.sceneHistory;
        for(const auto&row:old.rows)if(named(row.spec.id))donor->rows.push_back(row);
        for(const auto&stage:old.stages)if(named(stage.id))donor->stages.push_back(stage);
        {std::lock_guard guard(old.failureLock);donor->failures=old.failures;donor->unavailableTargets=old.unavailableTargets;}
        impl->current=std::shared_ptr<EffectExecution>(new EffectExecution(donor),[](EffectExecution*value){retireResource(value);});impl->partial.reset();impl->partialKey.clear();
    }
    if(impl->releaseRetained&&impl->current&&impl->current->impl->donor){
        auto&donor=*impl->current->impl;
        std::set<std::string>rows,stages,pendingNative,pendingScenes,pendingGenerations;
        const EffectPlanSize presentationSize{prefixIdentity=="recorded-original"&&temporal?temporal->outputWidth:unsigned(frame.target.width),prefixIdentity=="recorded-original"&&temporal?temporal->outputHeight:unsigned(frame.target.height)};
        auto format=!SpatialEncoder::supportsFormat(frame.source.pixelFormat)||imageColorIsHDR(description)?MTLPixelFormatRGBA16Float:frame.source.pixelFormat;
        const auto outputFormat=!SpatialEncoder::supportsFormat(frame.target.pixelFormat)||imageColorIsHDR(description)?MTLPixelFormatRGBA16Float:frame.target.pixelFormat;
        const bool reconstructs=std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.kind=="temporal";});
        const auto recordedInput=temporal?rsRecordedSceneInputExtent(temporal,reconstructs):RSRecordedSceneExtentV1{};
        EffectPlanSize size{prefixIdentity=="recorded-original"&&temporal?recordedInput.width:temporal&&reconstructs?temporal->renderWidth:unsigned(frame.source.width),prefixIdentity=="recorded-original"&&temporal?recordedInput.height:temporal&&reconstructs?temporal->renderHeight:unsigned(frame.source.height)};
        auto contract=sourceIdentity,upstream=sourceIdentity;
        const bool guides=impl->acceptedGuideKey==impl->guideKey;
        // Metadata only: incompatible ownership must leave before even the
        // candidate's first image can be denied. Numeric controls do not
        // change history; actual output geometry and algorithm contracts do.
        try{for(const auto&node:snapshot->nodes){if(!node.enabled)continue;
            if(snapshot->unpairedSyntheticInput&&(node.kind=="temporal"||node.kind=="frame-generation"||node.requirements.scene()||node.kind=="neural"&&node.settings.boolean("temporal")))continue;
            if(node.kind=="frame-generation"){
                if(!presentation||generationRequiresScene(node.method)&&(!temporal||generationRequiresCamera(node.method)&&!generationCameraAvailable(node.method,temporal)))continue;
                const auto config=rowGraphics(node,&snapshot->output);
                for(const auto&old:donor.stages)if(old.id==node.id&&(!generationRequiresScene(node.method)||guides)&&
                    (old.historyIdentity==contract||node.method=="lsfg"&&sameImageColorDescription(donor.colorDescription,description)&&donor.queue==frame.commands.commandQueue)&&
                    old.width==size.width&&old.height==size.height&&sameGeneration(config,old.graphics)){stages.insert(node.id);break;}
                const bool linear=node.method=="lsfg"&&(imageColorNeedsSDRIsland(description)||(format!=MTLPixelFormatRGBA8Unorm&&format!=MTLPixelFormatBGRA8Unorm));
                const auto working=colorIdentity+(node.method=="lsfg"?(linear?":linear-scRGB80":":sdr-8"):"");
                const auto algorithm=downstreamIdentity(working+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.device))+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)frame.commands.commandQueue)),node);
                const auto pending=impl->pendingGenerations.find(node.id);if(pending!=impl->pendingGenerations.end()&&pending->second.algorithmIdentity==algorithm&&
                    (!pending->second.acceptedResource||(pending->second.identity==downstreamIdentity(imageIdentity(upstream,size,format),node)&&(!generationRequiresScene(node.method)||pending->second.guideKey==impl->guideKey))))pendingGenerations.insert(node.id);
                upstream=downstreamIdentity(upstream,node);contract=contractIdentity(contract,node);continue;
            }
            auto target=size;auto targetFormat=format;
            if(node.kind=="shader"){std::shared_ptr<ShaderNode>geometry;target=shaderOutputSize(node,size,presentationSize,geometry);
                const auto pending=impl->pendingNative.find(node.id);if(pending!=impl->pendingNative.end()&&pending->second.identity==shaderIdentity(node))pendingNative.insert(node.id);
            }else if(node.kind=="neural")target={unsigned(std::ceil(size.width*node.intrinsicScale)),unsigned(std::ceil(size.height*node.intrinsicScale))};
            else if(node.kind=="temporal"){
                if(!temporal)continue;target=presentationSize;targetFormat=outputFormat;
                const auto identity=imageIdentity(contractIdentity(contract,node),size,format)+':'+std::to_string(target.width)+'x'+std::to_string(target.height)+':'+std::to_string(targetFormat)+':'+impl->guideKey;
                const auto pending=impl->pendingScenes.find(node.id);if(pending!=impl->pendingScenes.end()&&pending->second.identity==identity)pendingScenes.insert(node.id);
            }else if(node.kind=="spatial"){
                target=spatialOutputSize(node,size,presentationSize);
                const auto factor=node.settings.values.find("spatialMultiplier");
                const bool automatic=node.resolutionAuto||(!node.outputWidth&&!node.outputHeight&&!node.presentationScale&&(factor==node.settings.values.end()||std::holds_alternative<std::monostate>(factor->second)));
                if((automatic||node.method=="downsample"||!node.resizeDirection.empty())&&target.width==size.width&&target.height==size.height){upstream=imageIdentity(downstreamIdentity(upstream,node),size,format);contract=imageIdentity(contractIdentity(contract,node),size,format);continue;}
                targetFormat=outputFormat;
            }
            for(const auto&old:donor.rows)if(old.spec.id==node.id&&old.spec.kind==node.kind&&old.historyIdentity==contract&&old.bypass.empty()&&
                old.targetWidth==target.width&&old.targetHeight==target.height&&old.targetFormat==targetFormat&&
                (!node.requirements.scene()||guides)&&
                (node.kind=="shader"?shaderIdentity(old.spec)==shaderIdentity(node):node.kind=="temporal"?contractIdentity({},old.spec)==contractIdentity({},node):downstreamIdentity({},old.spec)==downstreamIdentity({},node))){rows.insert(node.id);break;}
            size=target;format=targetFormat;upstream=imageIdentity(downstreamIdentity(upstream,node),size,format);contract=imageIdentity(contractIdentity(contract,node),size,format);
        }}catch(const std::exception&){/* The ordinary build reports the invalid row; only a known reusable prefix remains. */}
        donor.rows.erase(std::remove_if(donor.rows.begin(),donor.rows.end(),[&](const auto&row){return !rows.count(row.spec.id);}),donor.rows.end());
        donor.stages.erase(std::remove_if(donor.stages.begin(),donor.stages.end(),[&](const auto&stage){return !stages.count(stage.id);}),donor.stages.end());
        for(auto it=impl->pendingNative.begin();it!=impl->pendingNative.end();)if(!pendingNative.count(it->first))it=impl->pendingNative.erase(it);else ++it;
        for(auto it=impl->pendingScenes.begin();it!=impl->pendingScenes.end();)if(!pendingScenes.count(it->first))it=impl->pendingScenes.erase(it);else ++it;
        for(auto it=impl->pendingGenerations.begin();it!=impl->pendingGenerations.end();)if(!pendingGenerations.count(it->first))it=impl->pendingGenerations.erase(it);else ++it;
    }
    for(const auto&[id,entry]:impl->pendingScenes){const auto state=entry.encoder->preparationStatus();if(state.busy&&!impl->allowPending){impl->waiting=[encoder=entry.encoder]{return encoder->preparationStatus();};return pending(state.reason);}}
    const auto resources=impl->partial&&impl->partialKey==requestIdentity?impl->partial:impl->current;
    const auto released=[&](const std::string&id){if(resources&&resources->impl->donor){auto&donor=*resources->impl;
        donor.rows.erase(std::remove_if(donor.rows.begin(),donor.rows.end(),[&](const auto&row){return row.spec.id==id;}),donor.rows.end());
        donor.stages.erase(std::remove_if(donor.stages.begin(),donor.stages.end(),[&](const auto&stage){return stage.id==id;}),donor.stages.end());}};
    // The accepted execution's working version of an image row with the same
    // input contract; a row prepared after the chain's extents are fixed also
    // needs the same output.
    const auto retainable=[&](const EffectExecution::Impl::Row&row,bool sameOutput)->const EffectExecution::Impl::Row*{
        if(!impl->current||(row.spec.kind!="shader"&&row.spec.kind!="spatial"&&row.spec.kind!="neural"))return nullptr;
        auto&accepted=*impl->current->impl;
        for(const auto&old:accepted.rows)if(old.spec.id==row.spec.id&&old.spec.kind==row.spec.kind&&old.historyIdentity==row.historyIdentity&&old.bypass.empty()&&(old.shader||old.neural||old.spatial)&&
            (!sameOutput||(old.targetWidth==row.targetWidth&&old.targetHeight==row.targetHeight&&old.targetFormat==row.targetFormat))&&accepted.failure(old).empty()&&!accepted.targetUnavailable(old))return &old;
        return nullptr;
    };
    // The retained Row keeps this graph's identities, so exact caches and
    // history checks key on the current upstream image.
    const auto keepPrevious=[](EffectExecution::Impl&owner,EffectExecution::Impl::Row&row,const EffectExecution::Impl::Row&previous,const std::string&reason){
        auto input=std::move(row.inputIdentity),mapped=std::move(row.mappedInputIdentity),history=std::move(row.historyIdentity),mappedHistory=std::move(row.mappedHistoryIdentity);
        row=previous;row.inputIdentity=std::move(input);row.mappedInputIdentity=std::move(mapped);row.historyIdentity=std::move(history);row.mappedHistoryIdentity=std::move(mappedHistory);
        row.retained=reason;owner.retain(row);
    };
    const bool guideCompatible=resources&&(resources==impl->partial||impl->acceptedGuideKey==impl->guideKey);
    std::shared_ptr<EffectExecution::Impl>building;
    const bool changed=impl->buildKey!=requestIdentity||!impl->current||impl->scopeIdentity!=prefixIdentity||impl->opaqueDisplay!=frame.opaqueDisplay||impl->sceneInputs!=sceneInputs||impl->colorSpace!=colorSpace||!sameImageColorDescription(impl->colorDescription,description)||(impl->current->impl->memoryDegraded&&std::chrono::steady_clock::now()>=impl->memoryRetry)||impl->current->revision()!=snapshot->revision||impl->device!=frame.commands.device||impl->queue!=frame.commands.commandQueue||impl->inputW!=frame.source.width||impl->inputH!=frame.source.height||impl->outputW!=frame.target.width||impl->outputH!=frame.target.height||impl->inputFormat!=frame.source.pixelFormat||impl->outputFormat!=frame.target.pixelFormat;
    if(changed&&impl->rejected!=identity)try {
        auto next=building=std::make_shared<EffectExecution::Impl>();next->snapshot=snapshot;next->builtFor=requestIdentity;next->device=frame.commands.device;next->queue=frame.commands.commandQueue;next->finalQueue=impl->finalQueue?:next->queue;next->colorSpace=colorSpace;next->colorDescription=description;next->statusContext=impl->statusContext;
        next->sceneRequired=temporal&&!prefixIdentity.empty();
        if(temporal){next->sceneRequired=!prefixIdentity.empty()||std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.requirements.scene();});next->sceneInputW=temporal->renderWidth;next->sceneInputH=temporal->renderHeight;next->sceneGuides=std::make_shared<SceneGuideEncoder>(next->device);
            const unsigned availableGuides=(guideSource->depth?GuideDepth:0u)|(guideSource->motion?GuideMotion:0u)|(guideSource->exposure?GuideExposure:0u);
            const bool consumesGuides=std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[&](const auto&node){return node.enabled&&((shaderGuideDemand(node.requirements)&availableGuides)||(guideSource->depth&&guideSource->motion&&(node.kind=="temporal"||node.kind=="frame-generation"&&generationRequiresScene(node.method))));});
            if(consumesGuides){const auto ready=next->sceneGuides->prepare();require(ready);}if(sourceLease&&sourceLease->guideHistory)next->sceneHistory=sourceLease->guideHistory;else if(resources&&guideCompatible)next->sceneHistory=resources->impl->sceneHistory;}
        next->fallback=std::make_unique<SpatialEncoder>(next->device);
        next->colors=resources&&resources->impl->device==next->device?resources->impl->colors:std::make_shared<ColorEncoder>(next->device);
        if(snapshot->output.comparison.active()){next->comparison=resources&&resources->impl->device==next->device?resources->impl->comparison:nullptr;if(!next->comparison)next->comparison=std::make_shared<ComparisonEncoder>();const auto ready=next->comparison->prepare(next->device,MTLPixelFormatRGBA16Float);require(ready);}
        if(snapshot->output.comparison.active()||snapshot->output.toneMapping!="auto")for(auto format:{MTLPixelFormatRGBA16Float,frame.target.pixelFormat}){const auto colorReady=next->colors->prepare(format);require(colorReady);}
        if(!imageRGBFormat(frame.source.pixelFormat)||!imageRGBFormat(frame.target.pixelFormat))throw std::runtime_error("The ordered graph requires supported RGB input and output formats");
        next->inputW=frame.source.width;next->inputH=frame.source.height;next->storageOutputW=frame.target.width;next->storageOutputH=frame.target.height;next->outputW=prefixIdentity=="recorded-original"&&temporal?temporal->outputWidth:unsigned(frame.target.width);next->outputH=prefixIdentity=="recorded-original"&&temporal?temporal->outputHeight:unsigned(frame.target.height);next->inputFormat=!SpatialEncoder::supportsFormat(frame.source.pixelFormat)||imageColorIsHDR(description)?MTLPixelFormatRGBA16Float:frame.source.pixelFormat;next->outputFormat=!SpatialEncoder::supportsFormat(frame.target.pixelFormat)||imageColorIsHDR(description)?MTLPixelFormatRGBA16Float:frame.target.pixelFormat;
        if(prefixIdentity=="scene-copy-boundary"){next->boundaryTarget=image(next->device,next->outputW,next->outputH,frame.target.pixelFormat);next->boundaryOutput=std::make_shared<SceneBoundaryOutput>();const auto ready=next->boundaryOutput->prepare(next->device,frame.target.pixelFormat);require(ready);}
        if(next->inputFormat!=frame.source.pixelFormat||next->outputFormat!=frame.target.pixelFormat){for(const auto format:{MTLPixelFormatRGBA16Float,frame.target.pixelFormat}){const auto ready=next->colors->prepare(format);require(ready);}}
        const bool reconstructs=std::any_of(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.kind=="temporal";});
        const auto recordedInput=temporal?rsRecordedSceneInputExtent(temporal,reconstructs):RSRecordedSceneExtentV1{};
        auto input=image(next->device,prefixIdentity=="recorded-original"&&temporal?recordedInput.width:temporal&&reconstructs?temporal->renderWidth:next->inputW,prefixIdentity=="recorded-original"&&temporal?recordedInput.height:temporal&&reconstructs?temporal->renderHeight:next->inputH,next->inputFormat),output=image(next->device,next->outputW,next->outputH,next->outputFormat);
        // The document revision also changes for a node's own live uniforms.
        // Only actual upstream image semantics enter that node's history key.
        // Final presentation resize cannot reset an unchanged source prefix.
        id<MTLTexture> current=input;bool coordinates=true,sceneCoordinates=true,projectedMapped=false,sceneColourJittered=reconstructs||prefixIdentity!="recorded-original"&&temporal&&temporal->method==RS_TEMPORAL_OFF;std::string upstream=sourceIdentity,contract=sourceIdentity;next->sceneIdentity=sourceIdentity;
        // A private unsubmitted buffer permits spatial pipeline validation;
        // no candidate advances source history or writes any publisher image.
        auto validation=[next->queue commandBuffer];auto sceneScratch=std::make_shared<EffectExecution::Impl::Scratch>();
        if(prefixIdentity=="recorded-original"){
            sceneScratch->extraHolds=2;
            next->recordedImages=sceneScratch->prepare(next->device,next->outputW,next->outputH,frame.target.pixelFormat,"effect-recorded-output");
            next->boundaryOutput=std::make_shared<SceneBoundaryOutput>();require(next->boundaryOutput->prepare(next->device,frame.target.pixelFormat,true));
            if(temporal)sceneScratch->prepareTarget(next->device,temporal->renderWidth,temporal->renderHeight,frame.source.pixelFormat);
        }
        std::vector<EffectPlanNode> nodes;for(const auto&node:snapshot->nodes)if(node.enabled)nodes.push_back(node);
        // Rows the reader rejected are bypassed with their reason; every other row still runs.
        for(const auto&node:snapshot->nodes)if(!node.rejection.empty()){EffectExecution::Impl::Row row;row.spec=node;row.bypass=node.rejection;next->report(row,node.rejection,false);}
        const auto prepareTiming=[&](EffectExecution::Impl::Row&row){
            if(!snapshot->quality)return;
            if(row.neural)row.externalTiming=neuralGpuTimingAvailable(row.neural);
            else if(row.spec.format=="native")row.externalTiming=nativeImageGpuTimingAvailable(row.shader);
            else if(row.shader&&(row.spec.format=="libplacebo"||row.spec.method.rfind("libplacebo:",0)==0)){const auto provider=optionalProvider();row.externalTiming=provider->prepareTiming&&provider->encodeTimed&&provider->prepareTiming(row.shader.get())==0;if(!row.externalTiming)row.timingReason=provider->prepareTiming&&provider->error&&provider->error()[0]?provider->error():"This affected renderer version does not report exact GPU intervals";}
            if(!row.externalTiming&&row.spec.gpuWorkScope=="external-queues"&&row.timingReason.empty())row.timingReason="This affected provider does not report complete per-job GPU intervals";
        };
        for(size_t position=0;position<nodes.size();++position){
            const auto&node=nodes[position];
            if(snapshot->unpairedSyntheticInput&&(node.kind=="temporal"||node.kind=="frame-generation"||node.requirements.scene()||node.kind=="neural"&&node.settings.boolean("temporal"))){EffectExecution::Impl::Row row;row.spec=node;row.inputIdentity=upstream;row.historyIdentity=contract;row.bypass=node.kind=="frame-generation"?"Generated input needs an exact real-endpoint pair before another generation stage":"This stage needs real scene inputs; the supplied image is generated";next->rows.push_back(std::move(row));continue;}
            if(node.kind=="frame-generation") {
                if(generationRequiresScene(node.method)&&(!temporal||generationRequiresCamera(node.method)&&!generationCameraAvailable(node.method,temporal))){
                    // Without a scene the row is bypassed and ordinary color
                    // stages still encode on every host route; a scene that
                    // lacks camera inputs keeps the scene route. Like a
                    // temporal row, the bypassed row stays in the execution so
                    // every encoded frame reports its stage.
                    if(temporal)next->sceneRequired=true;
                    EffectExecution::Impl::Row row;row.spec=node;row.inputIdentity=upstream;row.historyIdentity=contract;
                    row.bypass=temporal?"Needs matching renderer camera inputs":generationRequiresCamera(node.method)?"Needs matching renderer depth, motion and camera inputs":"Needs matching renderer depth, motion and scene matrices";
                    next->report(row,row.bypass,false);next->rows.push_back(std::move(row));continue;
                }
                try {
                if(!presentation)throw std::runtime_error("Frame generation requires a presentation owner");
                const auto config=rowGraphics(node,&snapshot->output);std::shared_ptr<GenerationEncoder> generator;
                std::shared_ptr<EffectGenerationStage::State>stageState,historySource;
                const auto pendingIdentity=downstreamIdentity(imageIdentity(upstream,current),node);
                const bool lsfgLinear=node.method=="lsfg"&&(imageColorNeedsSDRIsland(description)||(current.pixelFormat!=MTLPixelFormatRGBA8Unorm&&current.pixelFormat!=MTLPixelFormatBGRA8Unorm));
                const auto workingColorIdentity=colorIdentity+(node.method=="lsfg"?(lsfgLinear?":linear-scRGB80":":sdr-8"):"");
                const auto algorithmIdentity=downstreamIdentity(workingColorIdentity+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)next->device))+':'+std::to_string(reinterpret_cast<uintptr_t>((__bridge void*)next->queue)),node);
                bool reusedGenerator=false,acceptedGenerator=false;
                if(resources)for(const auto&old:resources->generationStages())if((!generationRequiresScene(node.method)||guideCompatible)&&old.id==node.id&&
                    (old.historyIdentity==contract||node.method=="lsfg"&&sameImageColorDescription(resources->imageColor(),description)&&resources->commandQueue()==next->queue)&&
                    old.width==current.width&&old.height==current.height&&sameGeneration(config,old.graphics)){
                    generator=old.encoder;reusedGenerator=true;acceptedGenerator=resources==impl->current;
                    if(old.historyIdentity==contract){stageState=old.state;historySource=old.historySource;}
                    else historySource=old.historySource?old.historySource:old.state;
                    break;
                }
                released(node.id);
                if(!generator){const auto pending=impl->pendingGenerations.find(node.id);if(pending!=impl->pendingGenerations.end()&&pending->second.algorithmIdentity==algorithmIdentity){
                    const bool sameContract=pending->second.identity==pendingIdentity&&(!generationRequiresScene(node.method)||pending->second.guideKey==impl->guideKey);
                    if(!pending->second.acceptedResource||sameContract){const auto status=pending->second.encoder->preparationStatus();if(status.busy)throw ScenePreparing(status.reason,[encoder=pending->second.encoder]{return encoder->preparationStatus();});generator=pending->second.encoder;acceptedGenerator=pending->second.acceptedResource;reusedGenerator=acceptedGenerator;if(sameContract)stageState=pending->second.state;}
                }}
                if(!generator){
                    generator=makeGenerationEncoder(next->device,node.method,*config.generation);
                    const bool sdr=node.method=="mlx-interpolation"||node.method=="rife";
                    if(imageColorNeedsSDRIsland(description)||current.pixelFormat==MTLPixelFormatRGBA16Float||lsfgLinear)generator=makeColorIslandGenerationEncoder(next->device,generator,description,sdr,config.generation->multiplier-1);
                    else generator->setColorDescription(description);
                }
                if(!stageState)stageState=std::make_shared<EffectGenerationStage::State>();
                impl->pendingGenerations[node.id]={pendingIdentity,algorithmIdentity,impl->guideKey,generator,stageState,acceptedGenerator};
                if(!frame.opaqueDisplay&&generator->requiresOpaque()){EffectExecution::Impl::Row row;row.spec=node;row.inputIdentity=upstream;row.historyIdentity=contract;row.bypass="Needs an opaque image";next->report(row,row.bypass,false);next->rows.push_back(std::move(row));continue;}
                if(generator->requiresScene()){
                    if(!temporal||generationRequiresCamera(node.method)&&!generationCameraAvailable(node.method,temporal))throw std::runtime_error("This generator requires its matching scene inputs");
                    if(!sceneCoordinates)throw std::runtime_error("Scene generation requires a known matching coordinate transform");
                    next->sceneRequired=true;
                }
                auto probe=temporal?*temporal:RSTemporalFrame{};int probeOwner=0;
                if(temporal&&generator->requiresScene()){probe=next->normalizeScene(*sceneScratch,validation,*temporal,current,current,sceneColourJittered,true,false,false,{},1,GuideAll,rawGuides);probe.owner=&probeOwner;if(auto matrices=sceneMatricesForImage(*temporal,sceneMatrices,sceneColourJittered,frame.origin==FrameOrigin::BottomLeft))rsBindTemporalSceneMatrices(&probe,&*matrices);}
                struct ProbeBinding {void*owner;~ProbeBinding(){if(owner)rsReleaseTemporalSceneMatrices(owner);}}probeBinding{temporal?probe.owner:nullptr};
                if(!reusedGenerator)generator->setSceneOrigin(frame.origin);
                ShaderResult ready;if(reusedGenerator)ready=generator->preparationStatus();else{const auto prepared=generator->prepare(validation,current,temporal&&generator->requiresScene()?&probe:nullptr);ready={prepared.encoded,prepared.reason,prepared.busy};}
                if(!ready.encoded){if(ready.busy)throw ScenePreparing(ready.reason,[generator]{return generator->preparationStatus();});impl->pendingGenerations.erase(node.id);require(ready);}
                if(usesImagePairAnalysis(node.method)&&!stageState->pairAnalysis)
                    stageState->pairAnalysis=std::make_shared<ImagePairAnalysis>(next->queue,current,description,next->statusContext);
                EffectGenerationStage stage;stage.id=node.id;stage.inputIdentity=upstream;stage.historyIdentity=contract;stage.sceneCoordinates=sceneCoordinates;stage.row=next->rows.size();stage.width=current.width;stage.height=current.height;stage.graphics=config;stage.encoder=generator;if(stageState)stage.state=std::move(stageState);stage.historySource=std::move(historySource);
                next->stages.push_back(std::move(stage));
                {RuntimeStatusEvent event;event.context=next->statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Prepared;event.planRevision=snapshot->revision;event.stageId=node.id;event.requestedMethod=node.method;event.activeMethod=node.method;event.inputWidth=current.width;event.inputHeight=current.height;event.outputWidth=current.width;event.outputHeight=current.height;observeRuntimeStatus(event);}
                if(!next->generation){next->graphics=config;next->firstSplit=next->rows.size();next->generationInputIdentity=upstream;next->generator=generator;next->generationW=unsigned(current.width);next->generationH=unsigned(current.height);}
                next->generation=true;next->split=next->rows.size();
                // Generation preserves the preceding row's image extent.
                // Only an explicit earlier scaler (or matched scene stage)
                // moves it to presentation size; suffix fitting stays ordered.
                // Generation preserves the real endpoint's coordinates.
                // Synthetic events carry their own guide eligibility at encode.
                upstream=downstreamIdentity(upstream,node);contract=contractIdentity(contract,node);
                }catch(const ScenePreparing&error){if(!impl->allowPending)throw;EffectExecution::Impl::Row row;row.spec=node;row.bypass=failureReason(error);next->memoryDegraded=true;next->report(row,row.bypass,false);next->rows.push_back(std::move(row));}catch(const TransientBusy&error){if(impl->current&&!impl->allowPending&&!error.structurallyImpossible)throw;EffectExecution::Impl::Row row;row.spec=node;row.bypass=failureReason(error);next->memoryDegraded=!error.structurallyImpossible;next->report(row,row.bypass,error.structurallyImpossible);next->rows.push_back(std::move(row));}catch(const std::exception &error){EffectExecution::Impl::Row row;row.spec=node;row.bypass=failureReason(error);next->report(row,row.bypass,true);next->rows.push_back(std::move(row));}
                continue;
            }
            EffectExecution::Impl::Row row;bool reusedPrepared=false;row.spec=node;row.inputIdentity=upstream;row.mappedInputIdentity=upstream+":display-mapped";row.historyIdentity=contract;row.mappedHistoryIdentity=contract+":display-mapped";
            row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;
            const auto sameTarget=[&](const auto &old){return old.targetWidth==row.targetWidth&&old.targetHeight==row.targetHeight&&old.targetFormat==row.targetFormat;};
            row.guideDemand=shaderGuideDemand(node.requirements);
            ShaderFrame context=frame;context.commands=validation;context.source=current;context.target=current;context.depth=coordinates?frame.depth:nullptr;
            DepthFrame validationDepth{};
            if(temporal&&coordinates&&node.requirements.depth){auto normalized=next->normalizeScene(*sceneScratch,validation,*temporal,current,output,sceneColourJittered,true,false,false,{},1,GuideDepth,rawGuides);validationDepth={(__bridge id<MTLTexture>)normalized.depth,frame.frameId,frame.origin};context.depth=&validationDepth;}
            const bool missingSceneInputs=node.kind!="temporal"&&node.requirements.scene()&&(!coordinates||!sceneInputReason(node.requirements,temporal,sceneMatrices).empty());
            try {
            const bool shaderSDR=node.kind=="shader"&&(node.inputPolicy=="srgb-sdr"||(node.inputPolicy.empty()&&(node.format=="isf"||node.format=="magpie"||node.format=="native"&&nativeImageUsesSDR(node.shader))));
            const bool model=node.kind=="neural"||node.kind=="spatial"&&node.method=="ls1"||node.kind=="temporal"&&node.method=="mlx-sr-scene"||shaderSDR;
            const bool linearSpatial=node.kind=="spatial"&&node.method=="metalfx"&&(description.transfer==ColorTransfer::PQ||description.transfer==ColorTransfer::HLG||description.alpha!=ColorAlpha::Opaque);
            const bool linearShader=node.kind=="shader"&&(node.inputPolicy=="linear-source"||node.format=="libplacebo"&&description.transfer==ColorTransfer::BT709)||node.kind=="spatial"&&node.method.rfind("libplacebo:",0)==0&&description.transfer==ColorTransfer::BT709;
            if(model&&(imageColorNeedsSDRIsland(description)||current.pixelFormat==MTLPixelFormatRGBA16Float)||linearSpatial||linearShader){
                row.colorIsland=std::make_shared<ColorIsland>(next->device,description,!linearSpatial&&!linearShader);
                const auto ready=row.colorIsland->prepare(row.targetFormat);require(ready);
                context.source=image(next->device,current.width,current.height,row.colorIsland->providerFormat());context.target=context.source;context.color=spatialColorForDescription(row.colorIsland->providerColor());
            }
            if(node.kind=="shader") {
                std::shared_ptr<ShaderNode>geometryNode;
                const auto size=shaderOutputSize(node,{unsigned(current.width),unsigned(current.height)},{next->outputW,next->outputH},geometryNode);
                row.targetWidth=size.width;row.targetHeight=size.height;row.resizes=size.width!=current.width||size.height!=current.height;
                auto target=row.resizes?image(next->device,row.targetWidth,row.targetHeight,row.targetFormat):current;
                // The executor always encodes shaders into distinct scratch
                // images, including same-size rows. Resource validation must
                // use that same contract rather than an aliased probe target.
                context.target=image(next->device,row.targetWidth,row.targetHeight,row.colorIsland?row.colorIsland->providerFormat():row.targetFormat);
                if(resources)for(const auto &old:resources->impl->rows)if(old.shader&&old.bypass.empty()&&(!node.requirements.scene()||guideCompatible)&&old.historyIdentity==contract&&sameTarget(old)&&shaderIdentity(old.spec)==shaderIdentity(node)){
                    reusedPrepared=old.spec.shader.parameters==node.shader.parameters&&(next->finalQueue!=next->queue||old.preparedQueue==context.commands.commandQueue);row.shader=reusedPrepared?old.shader:forkShader(node,old.shader);row.preparedQueue=reusedPrepared?old.preparedQueue:nil;break;
                }
                released(node.id);
                const bool nativeModel=node.format=="native"&&!node.modelOperation.empty();
                if(nativeModel&&!row.shader){auto pending=impl->pendingNative.find(node.id);if(pending!=impl->pendingNative.end()&&pending->second.identity==shaderIdentity(node))row.shader=pending->second.parameters==node.shader.parameters?pending->second.node:forkShader(node,pending->second.node);}
                if(!row.shader){row.shader=geometryNode?std::move(geometryNode):shaderNode(node);if(node.format!="native")row.shader->setParameters(node.shader.parameters);}
                if(node.realHistory){if(node.format!="fx")throw std::runtime_error("This shader provider does not expose real-frame feedback history");auto history=coreShaderWithRealHistory(row.shader,true);if(history!=row.shader){row.shader=std::move(history);reusedPrepared=false;}}
                if(node.format=="slangp"){auto capacity=coreShaderWithConcurrency(row.shader,next->generation?4*maximumTimelineImages:4);if(capacity!=row.shader){row.shader=std::move(capacity);reusedPrepared=false;}}
                if(nativeModel)impl->pendingNative[node.id]={shaderIdentity(node),node.shader.parameters,row.shader};
                row.nativeScene=std::dynamic_pointer_cast<NativeSceneShader>(row.shader);
                if(!reusedPrepared&&node.format=="native")setNativeImageShaderColor(row.shader,row.colorIsland?row.colorIsland->providerColor():description);
                if(!reusedPrepared&&node.format=="libplacebo"){const auto provider=optionalProvider();const auto&metadata=row.colorIsland?row.colorIsland->providerColor():description;if(provider->setColor&&provider->setColor(row.shader.get(),&metadata))throw std::runtime_error(provider->error()?:"The shader provider rejected color metadata");}
                ShaderResult ready{true,{}};
                if(row.nativeScene){
                    auto problem=!coordinates?std::string("Needs matching renderer scene coordinates"):sceneInputReason(node.requirements,guideSource,sceneMatrices,temporal?temporalSceneAovs(*temporal):nullptr,true);
                    if(problem.empty()&&!temporal)problem=row.nativeScene->sceneInputReason(context,nullptr,sceneMatrices);
                    if(problem.empty()&&temporal){auto probe=next->normalizeScene(*sceneScratch,validation,*temporal,context.source,context.target,sceneColourJittered,true,false,false,{},1,row.guideDemand,rawGuides);DepthFrame depth{(__bridge id<MTLTexture>)probe.depth,probe.frameId,frame.origin};context.depth=depth.texture?&depth:nullptr;context.frameId=probe.frameId;const auto matrices=sceneMatricesForImage(*temporal,sceneMatrices,sceneColourJittered,frame.origin==FrameOrigin::BottomLeft);problem=row.nativeScene->sceneInputReason(context,&probe,matrices);if(problem.empty()&&!reusedPrepared)ready=row.nativeScene->prepareScene(context,probe,matrices);}
                    else if(problem.empty())problem="Needs matching renderer scene inputs";
                    if(!problem.empty()){row.bypass=problem;next->report(row,problem,false);}
                }else if(!node.sceneBindings.empty()){
                    auto problem=!coordinates?std::string("Needs matching renderer scene coordinates"):sceneInputReason(node.requirements,guideSource,sceneMatrices,temporal?temporalSceneAovs(*temporal):nullptr,true);
                    if(problem.empty())problem=sceneColorInputReason(node,row.colorIsland?row.colorIsland->providerColor():description,temporal,temporal?temporalSceneAovs(*temporal):nullptr,false,false);
                    if(problem.empty()&&!temporal)problem="Needs matching renderer scene inputs";
                    if(problem.empty()){
                        auto probe=next->normalizeScene(*sceneScratch,validation,*temporal,context.source,context.target,sceneColourJittered,true,false,false,{},1,row.guideDemand,rawGuides);context.frameId=probe.frameId;
                        row.preparationScene=probe;row.preparationMatrices=sceneMatricesForImage(*temporal,sceneMatrices,sceneColourJittered,frame.origin==FrameOrigin::BottomLeft);row.preparationAovs=temporalSceneAovs(*temporal);
                        if(next->finalQueue!=next->queue){row.preparationFrame=context;row.preparationFrame->commands=nil;row.reusedPreparation=reusedPrepared;}
                        else{row.namedInputs=std::make_shared<SceneShaderInputs>(context.commands.commandQueue,node.sceneBindings,node.inputPolicy=="linear-source"?std::optional<ImageColorDescription>(row.colorIsland?row.colorIsland->providerColor():description):std::nullopt);ready=row.namedInputs->prepare(context,probe,row.preparationMatrices,row.preparationAovs);SceneShaderInputFrame named;if(ready.encoded)ready=row.namedInputs->frame(context,probe,row.preparationMatrices,row.preparationAovs,false,named);if(ready.encoded)ready=sceneShaderCall(row.shader,node.format,context,&named.value,true);if(!ready.encoded){if(ready.busy)throw TransientBusy(ready.reason);problem=ready.reason.empty()?"The scene inputs could not be prepared":ready.reason;}row.preparationScene.reset();row.preparationMatrices.reset();row.preparationAovs.reset();}
                    }
                    if(!problem.empty()){row.bypass=problem;next->report(row,problem,false);ready={true,{}};}
                }else if(next->finalQueue!=next->queue){row.preparationFrame=context;row.preparationFrame->commands=nil;if(context.depth)row.preparationDepth=*context.depth;row.preparationFrame->depth=nullptr;row.reusedPreparation=reusedPrepared;}else if(!reusedPrepared)ready=row.shader->prepare(context);
                if(!ready.encoded){if(nativeModel&&ready.busy)throw ScenePreparing(ready.reason,[node=row.shader]{return nativeImagePreparationStatus(node);});if(nativeModel)impl->pendingNative.erase(node.id);require(ready);}
                if(nativeModel&&!row.preparationFrame)impl->pendingNative.erase(node.id);if(!row.preparationFrame&&row.bypass.empty()&&ready.encoded)row.preparedQueue=context.commands.commandQueue;
                if(row.bypass.empty()){RuntimeStatusEvent event;event.context=next->statusContext;event.processing=true;event.phase=RuntimeStatusPhase::Prepared;
                 event.planRevision=snapshot->revision;event.stageId=node.id;event.requestedMethod=node.format;event.activeMethod=node.format;next->observe(row,event);}
                current=target;if(!node.preservesCoordinates)coordinates=false;if(!node.preservesCoordinates)sceneCoordinates=false;
            }else if(node.kind=="neural") {
                if(node.method!="mlx-dlss"&&node.method!="mlx-vsr"&&node.method!="mlx-sr-image"&&node.method!="realesrgan"&&node.method!="realcugan"&&node.method!="nafnet")throw std::runtime_error("Unknown neural method");
                row.targetWidth=unsigned(std::ceil(current.width*node.intrinsicScale));row.targetHeight=unsigned(std::ceil(current.height*node.intrinsicScale));
                if(!row.targetWidth||!row.targetHeight||row.targetWidth>16384||row.targetHeight>16384)throw std::runtime_error("Neural output dimensions exceed the supported extent");
                row.resizes=row.targetWidth!=current.width||row.targetHeight!=current.height;
                auto target=row.resizes?image(next->device,row.targetWidth,row.targetHeight,row.targetFormat):current;context.target=row.colorIsland?image(next->device,row.targetWidth,row.targetHeight,row.colorIsland->providerFormat()):target;
                if(resources)for(const auto &old:resources->impl->rows)if(old.neural&&old.historyIdentity==contract&&sameTarget(old)&&sameImageColorDescription(resources->imageColor(),description)&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.neural=old.neural;row.preparedQueue=old.preparedQueue;reusedPrepared=next->finalQueue!=next->queue||old.preparedQueue==context.commands.commandQueue;break;}released(node.id);
                if(!row.neural)row.neural=impl->neuralNode(node,next->device);
                if(!reusedPrepared&&(row.colorIsland||colorSpace!=ImageColorSpace::LegacySDR))setNeuralInputColor(row.neural,row.colorIsland?row.colorIsland->providerColor():description);
                context.depth=nullptr;if(next->finalQueue!=next->queue){row.preparationFrame=context;row.preparationFrame->commands=nil;row.reusedPreparation=reusedPrepared;}else{if(!reusedPrepared&&row.preparedQueue&&row.preparedQueue!=context.commands.commandQueue){row.neural=impl->neuralNode(node,next->device);setNeuralInputColor(row.neural,row.colorIsland?row.colorIsland->providerColor():description);}const auto ready=reusedPrepared?ShaderResult{true,{}}:warmNeuralNode(row.neural,context);if(!ready.encoded&&ready.busy){impl->pendingNeural[node.id]={downstreamIdentity({},node),next->device,row.neural};throw ScenePreparing(ready.reason,[neural=row.neural]{return neuralWarmupStatus(neural);});}impl->pendingNeural.erase(node.id);require(ready);row.preparedQueue=context.commands.commandQueue;}
                current=target;
            }else if(node.kind=="temporal") {
                // An unavailable scene scaler still has a declared output
                // extent. Retain that boundary for independent later rows.
                row.targetWidth=next->outputW;row.targetHeight=next->outputH;row.targetFormat=next->outputFormat;row.resizes=true;
                if(!temporal){
                    // Without a scene this row is a bypass at the input extent;
                    // ordinary color stages still encode on every host route.
                    row.resizes=false;row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;
                    row.bypass="Needs matching renderer depth, motion and jitter";next->report(row,row.bypass,false);next->rows.push_back(std::move(row));continue;
                }
                if(next->generation||!coordinates)throw std::runtime_error("This temporal stage requires matching real-scene coordinates before frame generation");
                if(temporal->commandBuffer!=(__bridge void*)frame.commands||temporal->color!=(__bridge void*)frame.source||temporal->output!=(__bridge void*)frame.target)
                    throw std::runtime_error("The temporal stage does not match the original renderer frame");
                if(node.requirements.depth&&(!coordinates||!guideSource||!guideSource->depth))throw std::runtime_error("This ordered stage requires unchanged depth from the current game frame");
                if(node.method=="mlx-sr-scene"||node.method=="xess"||node.method=="metalfx-denoised"){
                    if(node.method=="mlx-sr-scene"&&node.modelPath.empty())throw std::runtime_error("Choose a prepared scene reconstruction model");
                    if(resources&&guideCompatible)for(const auto&old:resources->impl->rows)if(old.neuralScene&&sameTarget(old)&&old.historyIdentity==contract&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.neuralScene=old.neuralScene;reusedPrepared=true;break;}released(node.id);
                    const auto sceneIdentity=imageIdentity(contractIdentity(contract,node),current)+':'+std::to_string(row.targetWidth)+'x'+std::to_string(row.targetHeight)+':'+std::to_string(row.targetFormat)+':'+impl->guideKey;
                    if(node.method=="xess"||node.method=="metalfx-denoised"){
                        auto found=impl->pendingScenes.find(node.id);if(found!=impl->pendingScenes.end()&&found->second.identity==sceneIdentity)row.neuralScene=found->second.encoder;
                        if(!row.neuralScene)row.neuralScene=node.method=="metalfx-denoised"?makeMetalFxDenoisedEncoder(next->device):makeXessSceneEncoder(next->device,{node.settings.string("xessExecutionBackend",node.settings.string("xessBackend","auto"))});
                        if(!reusedPrepared)row.neuralScene->setColorDescription(description);impl->pendingScenes[node.id]={sceneIdentity,row.neuralScene};
                    }else if(!row.neuralScene)row.neuralScene=makeNeuralSceneEncoder(next->device,{node.modelPath,1,true,node.method});
                    auto guideSource=*temporal;if(projectedMapped||row.colorIsland&&row.colorIsland->mapsToDisplay()){guideSource.preExposure=1;guideSource.exposure=nullptr;guideSource.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}auto actual=next->normalizeScene(*sceneScratch,validation,guideSource,context.source,row.colorIsland?image(next->device,row.targetWidth,row.targetHeight,row.colorIsland->providerFormat()):output,sceneColourJittered,true,false,false,{},1,projectedMapped||row.colorIsland&&row.colorIsland->mapsToDisplay()?GuideAll&~GuideExposure:GuideAll,rawGuides);if(projectedMapped){actual.preExposure=1;actual.exposure=nullptr;actual.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}if(row.temporalLinearABI)actual.flags|=RS_TEMPORAL_HDR;else if(row.colorIsland)actual.flags&=~RS_TEMPORAL_HDR;if(row.colorIsland){if(row.colorIsland->mapsToDisplay()){actual.preExposure=1;actual.exposure=nullptr;actual.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}}
                    if(auto matrices=sceneMatricesForImage(*temporal,sceneMatrices,sceneColourJittered,frame.origin==FrameOrigin::BottomLeft))rsBindTemporalSceneMatrices(&actual,&*matrices);
                    const auto ready=row.neuralScene->prepare(actual);if(!ready.encoded){if(ready.busy)throw ScenePreparing(ready.reason,[encoder=row.neuralScene]{return encoder->preparationStatus();});impl->pendingScenes.erase(node.id);require(ready);}
                    impl->pendingScenes.erase(node.id);
                }else{
                row.temporalMethod=temporalMethod(node.method);if(row.temporalMethod==RS_TEMPORAL_ASR){const auto profile=node.settings.string("asrQuality","quality");row.temporalProfile=profile=="quality"?1:profile=="balanced"?2:profile=="performance"?3:profile=="ultra-performance"?4:0;if(!row.temporalProfile)throw std::runtime_error("Unknown Arm ASR quality profile");}else if(row.temporalMethod==RS_TEMPORAL_FSR4){const auto profile=node.settings.string("fsr4Profile","exact-fast");row.temporalProfile=profile=="exact-fast"?1:profile=="lite"?2:profile=="lite2"?3:0;if(!row.temporalProfile)throw std::runtime_error("Unknown FSR4 profile");}const auto sharpness=node.settings.number("temporalSharpness",.5);
                if(!std::isfinite(sharpness)||sharpness<0||sharpness>1)throw std::runtime_error("Invalid temporal sharpness");row.sharpness=float(sharpness);
                row.temporalLinearABI=linearABI1TemporalMethod(row.temporalMethod)!=nullptr;
                if(resources&&guideCompatible)for(const auto&old:resources->impl->rows)if(old.temporal&&sameTarget(old)&&old.spec.id==node.id&&old.historyIdentity==contract&&old.temporalMethod==row.temporalMethod&&old.temporalProfile==row.temporalProfile){row.temporal=old.temporal;reusedPrepared=old.temporalPrepared;if(resources==impl->partial)row.colorIsland=old.colorIsland;break;}released(node.id);
                if(row.temporalLinearABI){
                    const auto working=temporalWorkingColor(description);
                    // PrepareRgb = RGB / preExposure * exposure. Converting RGB
                    // units by sourceWhite/203 therefore needs the inverse gain
                    // on a supplied exposure; preExposure itself remains the
                    // producer's actual same-frame/history factor.
                    if(row.temporalMethod!=RS_TEMPORAL_SGSR2)row.temporalExposureScale=working.referenceWhite/description.referenceWhite;
                    if(temporal->exposure&&row.temporalExposureScale!=1){
                        if(resources==impl->partial&&resources)next->scratch=resources->impl->scratch;
                        while(next->scratch.size()<4)next->scratch.push_back(std::make_shared<EffectExecution::Impl::Scratch>());
                        for(const auto&slot:next->scratch)slot->guideTargets(next->device,*temporal,current.width,current.height,false,row.temporalExposureScale);
                    }
                    row.temporalColorInputIdentity=canonicalTemporalColor(description)&&current.pixelFormat==MTLPixelFormatRGBA16Float;
                    if(!row.temporalColorInputIdentity||description.alpha!=ColorAlpha::Opaque||row.targetFormat!=MTLPixelFormatRGBA16Float){
                        if(!row.colorIsland)row.colorIsland=std::make_shared<ColorIsland>(next->device,description,working);
                        const auto ready=row.colorIsland->prepare(row.targetFormat);require(ready);
                        // Reserve the existing four command-owned conversion
                        // slots on the preparation worker, rather than allocate
                        // an image on each of the first rendering callbacks.
                        std::array<ColorIsland::Images,4>prepared;
                        for(auto&slot:prepared)slot=row.colorIsland->prepareImages(current.width,current.height,row.targetWidth,row.targetHeight,1,!row.temporalColorInputIdentity);
                        context.source=row.temporalColorInputIdentity?current:prepared.front().input;context.target=prepared.front().outputs.front();context.color=SpatialColor::HDR;
                    }
                }
                
                if(!row.temporal){row.temporal=std::make_shared<TemporalOwner>();impl->temporalOwners.erase(std::remove_if(impl->temporalOwners.begin(),impl->temporalOwners.end(),[](const auto &weak){return weak.expired();}),impl->temporalOwners.end());impl->temporalOwners.push_back(row.temporal);}
                // New row owners retain resource-only preparations. Older
                // providers without that optional hook use a disposable probe.
                auto guideSource=*temporal;if(projectedMapped){guideSource.preExposure=1;guideSource.exposure=nullptr;guideSource.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}
                auto actual=next->normalizeScene(*sceneScratch,validation,guideSource,context.source,row.colorIsland?context.target:output,sceneColourJittered,true,row.temporalMethod==RS_TEMPORAL_METALFX,false,{},row.temporalExposureScale,projectedMapped?GuideAll&~GuideExposure:GuideAll,rawGuides);actual.owner=row.temporal.get();actual.method=row.temporalMethod;actual.reserved=row.temporalProfile;actual.sharpness=row.sharpness;actual.flags|=RS_TEMPORAL_RESET;if(row.temporalLinearABI)actual.flags|=RS_TEMPORAL_HDR;
                RSTemporalResult ready{};ready.size=sizeof(ready);ready.version=1;
                const auto&workingColor=row.colorIsland?row.colorIsland->providerColor():description;const bool resourceOnly=reusedPrepared||(row.temporalMethod==RS_TEMPORAL_METALFX?prepareTemporalProvider(&actual,&ready,workingColor):prepareTemporalProvider(&actual,&ready));
                if(reusedPrepared)ready.status=RS_TEMPORAL_OK;
                else if(!resourceOnly){auto probe=std::make_shared<TemporalOwner>();actual.owner=probe.get();if(row.temporalMethod==RS_TEMPORAL_METALFX)encodeTemporalProvider(&actual,&ready,workingColor);else encodeTemporalProvider(&actual,&ready);}
                if(ready.status==RS_TEMPORAL_BUSY&&resourceOnly){
                    auto owner=row.temporal;const auto pending=actual;const auto metadata=workingColor;const bool exact=row.temporalMethod==RS_TEMPORAL_METALFX;next->rows.push_back(std::move(row));
                    throw ScenePreparing(ready.reason,[owner,pending,metadata,exact,commands=validation]{(void)owner;(void)commands;RSTemporalResult status{};status.size=sizeof(status);status.version=1;if(exact)prepareTemporalProvider(&pending,&status,metadata);else prepareTemporalProvider(&pending,&status);return ShaderResult{status.status==RS_TEMPORAL_OK,status.reason,status.status==RS_TEMPORAL_BUSY};});
                }
                if(ready.status==RS_TEMPORAL_BUSY)throw TransientBusy(ready.reason);if(ready.status!=RS_TEMPORAL_OK||(!resourceOnly&&!ready.encoded))throw std::runtime_error(*ready.reason?ready.reason:"The scene reconstruction could not be prepared");
                row.temporalPrepared=true;
                }
                next->temporalEnd=next->rows.size()+1;current=output;coordinates=true;sceneColourJittered=false;
            }else if(node.kind=="spatial") {
                const auto size=spatialOutputSize(node,{unsigned(current.width),unsigned(current.height)},{next->outputW,next->outputH});
                const auto factor=node.settings.values.find("spatialMultiplier");
                const bool automatic=node.resolutionAuto||(!node.outputWidth&&!node.outputHeight&&!node.presentationScale&&(factor==node.settings.values.end()||std::holds_alternative<std::monostate>(factor->second)));
                // A reduction at its target has no work. This also lets an
                // allocation guard cover a rejected renderer request without
                // adding a filter pass when the native allocation succeeded.
                // Explicit non-reduction filters still retain their 1x pass.
                if((automatic||node.method=="downsample"||!node.resizeDirection.empty())&&size.width==current.width&&size.height==current.height){
                    next->spatialBypasses.push_back({node.id,node.method,unsigned(current.width),unsigned(current.height),next->rows.size()});
                    upstream=imageIdentity(downstreamIdentity(upstream,node),current);contract=imageIdentity(contractIdentity(contract,node),current);continue;
                }
                row.targetWidth=size.width;row.targetHeight=size.height;row.targetFormat=next->outputFormat;
                auto target=image(next->device,size.width,size.height,row.targetFormat);
                if(node.method.rfind("libplacebo:",0)==0){
                    if(resources)for(const auto &old:resources->impl->rows)if(old.shader&&sameTarget(old)&&old.spec.kind=="spatial"&&old.historyIdentity==contract&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.shader=old.shader;row.preparedQueue=old.preparedQueue;reusedPrepared=next->finalQueue!=next->queue||old.preparedQueue==context.commands.commandQueue;break;}released(node.id);
                    if(!row.shader)row.shader=optionalScaler(node.method.substr(11));
                    if(!reusedPrepared){const auto provider=optionalProvider();const auto&metadata=row.colorIsland?row.colorIsland->providerColor():description;if(provider->setColor&&provider->setColor(row.shader.get(),&metadata))throw std::runtime_error(provider->error()?:"The scaling provider rejected color metadata");}
                    if(!row.colorIsland)context.source=current;context.target=row.colorIsland?image(next->device,row.targetWidth,row.targetHeight,row.colorIsland->providerFormat()):target;context.depth=nullptr;if(next->finalQueue!=next->queue){row.preparationFrame=context;row.preparationFrame->commands=nil;row.reusedPreparation=reusedPrepared;}else{if(!reusedPrepared&&row.preparedQueue&&row.preparedQueue!=context.commands.commandQueue){row.shader=optionalScaler(node.method.substr(11));const auto provider=optionalProvider();const auto&metadata=row.colorIsland?row.colorIsland->providerColor():description;if(provider->setColor&&provider->setColor(row.shader.get(),&metadata))throw std::runtime_error(provider->error()?:"The scaling provider rejected color metadata");}const auto ready=reusedPrepared?ShaderResult{true,{}}:row.shader->prepare(context);require(ready);row.preparedQueue=context.commands.commandQueue;}
                }else{
                const auto config=rowGraphics(node);row.config={config.sharpness,config.ls1Performance,config.modelPath};row.method=spatialMethod(node.method);
                if(resources)for(const auto&old:resources->impl->rows)if(old.spatial&&sameTarget(old)&&old.historyIdentity==contract&&downstreamIdentity({},old.spec)==downstreamIdentity({},node)){row.spatial=old.spatial;reusedPrepared=true;break;}released(node.id);
                if(!row.spatial)row.spatial=std::make_shared<SpatialEncoder>(next->device);
                SpatialStatus ready;if(reusedPrepared)ready.encoded=true;else if(row.method!=SpatialMethod::LS1)ready=row.spatial->encode(validation,{context.source,row.colorIsland?image(next->device,row.targetWidth,row.targetHeight,row.colorIsland->providerFormat()):target,frame.frameId,row.colorIsland?(row.method==SpatialMethod::MetalFX?SpatialColor::HDR:spatialColorForDescription(row.colorIsland->providerColor())):frame.color,frame.origin},row.method,row.config);
                if(!reusedPrepared&&row.method==SpatialMethod::LS1)ready=row.spatial->prepare({context.source,target,frame.frameId,context.color,frame.origin},row.method,row.config);
                // A provider that is busy (a full scratch budget or queue) is
                // retried like the image budget; only a real failure rejects.
                require(ready);
                }
                current=target;
            }else throw std::runtime_error("Unknown ordered effect stage");
            if(!row.preparationFrame)prepareTiming(row);
            }catch(const ScenePreparing&error){if(!impl->allowPending)throw;row.bypass=failureReason(error);row.fitBypass=row.resizes;row.warming=bool(row.neural);next->memoryDegraded=true;next->report(row,row.bypass,false);if(row.resizes)current=image(next->device,row.targetWidth,row.targetHeight,row.targetFormat);}
            catch(const TransientBusy &error){
                if(impl->current&&!impl->allowPending&&!error.structurallyImpossible)throw;
                row.shader.reset();row.nativeScene.reset();row.neural.reset();row.spatial.reset();row.temporal.reset();row.neuralScene.reset();row.bypass=failureReason(error);next->memoryDegraded|=!error.structurallyImpossible;
                next->report(row,error.what(),false);next->memoryRetry[node.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
                // Preserve the prior input extent; a denied resize cannot
                // strand its independent display stages at the requested size.
                row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;row.resizes=false;
            }catch(const std::exception &error){
                // A live edit that breaks a working image row keeps running
                // that row's previous version and reports the edit's reason.
                // At launch, or without a compatible previous version, the
                // row becomes a passthrough so independent rows still run.
                const auto reason=failureReason(error);
                if(const auto previous=missingSceneInputs?nullptr:retainable(row,false)){
                    keepPrevious(*next,row,*previous,reason);
                    if(row.resizes||row.spec.kind=="spatial")current=image(next->device,row.targetWidth,row.targetHeight,row.targetFormat);
                    if(row.spec.kind=="shader"&&!row.spec.preservesCoordinates){coordinates=false;sceneCoordinates=false;}
                }else{
                    row.temporal.reset();row.neuralScene.reset();row.shader.reset();row.neural.reset();row.nativeScene.reset();row.spatial.reset();
                    next->report(row,reason,!missingSceneInputs);
                    // A failed resizing row keeps its declared extent, so later
                    // rows keep their prepared dimensions; its input is fitted
                    // to that extent. An extent that cannot be allocated falls
                    // back to the input extent.
                    bool declared=false;
                    if((row.resizes||row.spec.kind=="spatial")&&row.targetWidth&&row.targetHeight)try{if(const auto value=image(next->device,row.targetWidth,row.targetHeight,row.targetFormat)){current=value;declared=true;}}catch(const std::exception&){}
                    if(!declared){row.targetWidth=current.width;row.targetHeight=current.height;row.targetFormat=current.pixelFormat;row.resizes=false;}
                }
            }
            if(row.colorIsland&&row.colorIsland->mapsToDisplay()&&row.bypass.empty()&&next->failure(row).empty())projectedMapped=true;
            // Later rows are keyed by the content that feeds them: a retained
            // row's previous version, not the edit that failed.
            upstream=imageIdentity(downstreamIdentity(upstream,row.retained.empty()?node:row.spec),current);contract=imageIdentity(contractIdentity(contract,row.retained.empty()?node:row.spec),current);next->rows.push_back(std::move(row));
            if(node.kind=="temporal"&&next->temporalEnd==next->rows.size())next->sceneIdentity=upstream;
        }
        {const auto ready=next->fallback->encode(validation,{input,output,frame.frameId,frame.color,frame.origin},SpatialMethod::Bilinear,{});require(ready);}
        if(!next->generation){
            next->split=next->rows.size();
            if(snapshot->output.active())for(size_t index=0;index<next->rows.size();++index)if(next->rows[index].spec.displaySubframes){
                const bool displaySuffix=std::all_of(next->rows.begin()+index,next->rows.end(),[](const auto&row){return row.spec.kind=="shader"&&(row.spec.displaySubframes||row.spec.preservesCoordinates)&&!row.spec.requirements.scene();});
                if(displaySuffix)next->split=index;
                break;
            }
        }

        // The actual split may differ from the requested generator positions
        // when a provider is unavailable. Prepare each deferred image owner on
        // its actual phase queue only after that split has been resolved.
        id<MTLCommandBuffer>finalValidation=nil;
        for(size_t index=0;index<next->rows.size();++index){auto&row=next->rows[index];if(!row.preparationFrame)continue;auto context=*row.preparationFrame;if(row.preparationDepth)context.depth=&*row.preparationDepth;
            const auto desired=index>=next->split?next->finalQueue:next->queue;
            if(desired==next->queue)context.commands=validation;else{if(!finalValidation)finalValidation=[desired commandBuffer];if(!finalValidation)throw std::runtime_error("The final image preparation queue is unavailable");context.commands=finalValidation;}
            try{
                if(row.reusedPreparation&&row.preparedQueue!=desired){
                    if(row.neural){row.neural=impl->neuralNode(row.spec,next->device);setNeuralInputColor(row.neural,row.colorIsland?row.colorIsland->providerColor():description);}
                    else{auto previous=row.shader;row.shader=row.spec.kind=="spatial"?optionalScaler(row.spec.method.substr(11)):forkShader(row.spec,previous);if(!row.shader)row.shader=row.spec.kind=="spatial"?optionalScaler(row.spec.method.substr(11)):shaderNode(row.spec);if(row.spec.format=="native")setNativeImageShaderColor(row.shader,row.colorIsland?row.colorIsland->providerColor():description);if(row.spec.format=="libplacebo"||row.spec.method.rfind("libplacebo:",0)==0){const auto provider=optionalProvider();const auto&metadata=row.colorIsland?row.colorIsland->providerColor():description;if(provider->setColor&&provider->setColor(row.shader.get(),&metadata))throw std::runtime_error(provider->error()?:"The image provider rejected color metadata");}}
                    row.reusedPreparation=false;
                }
                ShaderResult ready{true,{}};
                if(row.preparationScene){auto scene=*row.preparationScene;scene.commandBuffer=(__bridge void*)context.commands;context.frameId=scene.frameId;row.namedInputs=std::make_shared<SceneShaderInputs>(desired,row.spec.sceneBindings,row.spec.inputPolicy=="linear-source"?std::optional<ImageColorDescription>(row.colorIsland?row.colorIsland->providerColor():next->colorDescription):std::nullopt);ready=row.namedInputs->prepare(context,scene,row.preparationMatrices,row.preparationAovs);SceneShaderInputFrame named;if(ready.encoded)ready=row.namedInputs->frame(context,scene,row.preparationMatrices,row.preparationAovs,false,named);if(ready.encoded)ready=sceneShaderCall(row.shader,row.spec.format,context,&named.value,true);if(!ready.encoded){if(ready.busy)throw TransientBusy(ready.reason);row.bypass=ready.reason.empty()?"The scene inputs could not be prepared":ready.reason;next->report(row,row.bypass,false);ready={true,{}};}}
                else ready=row.reusedPreparation&&row.preparedQueue==desired?ShaderResult{true,{}}:row.neural?warmNeuralNode(row.neural,context):row.shader->prepare(context);
                if(!ready.encoded){if(ready.busy){if(row.spec.format=="native"&&!row.spec.modelOperation.empty())throw ScenePreparing(ready.reason,[node=row.shader]{return nativeImagePreparationStatus(node);});if(row.neural){impl->pendingNeural[row.spec.id]={downstreamIdentity({},row.spec),next->device,row.neural};throw ScenePreparing(ready.reason,[neural=row.neural]{return neuralWarmupStatus(neural);});}throw TransientBusy(ready.reason);}require(ready);}
                row.preparedQueue=desired;if(row.spec.format=="native"&&!row.spec.modelOperation.empty())impl->pendingNative.erase(row.spec.id);if(row.neural)impl->pendingNeural.erase(row.spec.id);
                prepareTiming(row);
            }catch(const ScenePreparing&error){if(!impl->allowPending)throw;row.bypass=failureReason(error);row.fitBypass=row.resizes;row.warming=bool(row.neural);next->memoryDegraded=true;next->report(row,row.bypass,false);}catch(const TransientBusy&error){if(impl->current&&!impl->allowPending&&!error.structurallyImpossible)throw;row.shader.reset();row.neural.reset();row.preparedQueue=nil;next->memoryDegraded|=!error.structurallyImpossible;next->memoryRetry[row.spec.id]=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);next->report(row,failureReason(error),error.structurallyImpossible);}catch(const std::exception&error){const auto reason=failureReason(error);
                if(const auto previous=retainable(row,true))keepPrevious(*next,row,*previous,reason);else next->report(row,reason,true);}
            row.preparationFrame.reset();row.preparationDepth.reset();row.preparationScene.reset();row.preparationMatrices.reset();row.preparationAovs.reset();row.reusedPreparation=false;
        }
        sceneScratch->prepareTarget(next->device,input.width,input.height,input.pixelFormat);sceneScratch->prepareTarget(next->device,output.width,output.height,output.pixelFormat);
        for(const auto&row:next->rows)if(row.targetWidth&&row.targetHeight){sceneScratch->prepareTarget(next->device,row.targetWidth,row.targetHeight,row.targetFormat);if(row.spec.requirements.depth)sceneScratch->prepareDepth(next->device,row.targetWidth,row.targetHeight);}
        if(temporal&&temporal->depth)sceneScratch->prepareDepth(next->device,input.width,input.height);
        sceneScratch->clearImages();next->scratchTemplate=sceneScratch;
        if(!next->generation)next->firstSplit=next->split;
        next->depthRequired=std::any_of(next->rows.begin(),next->rows.end(),[](const auto &row){return row.bypass.empty()&&row.spec.requirements.depth&&(row.shader||row.temporal||row.neuralScene);});
        for(size_t index=0;index<next->rows.size();++index){const auto&row=next->rows[index];if(row.bypass.empty()&&row.shader&&!row.nativeScene&&row.spec.sceneBindings.empty()&&row.spec.requirements.depth)next->plainDepthMask|=uint32_t(1)<<index;}
        if(next->depthRequired||next->sceneGuides)next->depthResampler=std::make_shared<DepthResampler>(next->device);
        next->continuationSnapshot=snapshot;
        if(prefixIdentity=="scene-copy-boundary")next->sceneIdentity=upstream;
        if(next->temporalEnd){auto suffix=std::make_shared<EffectPlanSnapshot>(*snapshot);const auto&cut=next->rows[next->temporalEnd-1].spec.id;const auto end=std::find_if(suffix->nodes.begin(),suffix->nodes.end(),[&](const auto&node){return node.id==cut;});if(end==suffix->nodes.end())throw std::runtime_error("The scene prefix is missing from its immutable graph");suffix->nodes.erase(suffix->nodes.begin(),end+1);next->continuationSnapshot=std::move(suffix);}
        // Reused nodes keep immutable parameters. Changed parameters belong to
        // fresh candidate nodes, including suffixes retained by older batches.
        impl->current=std::shared_ptr<EffectExecution>(new EffectExecution(next),[](EffectExecution*value){retireResource(value);});impl->partial.reset();impl->partialKey.clear();impl->buildKey=requestIdentity;impl->acceptedGuideKey=impl->guideKey;impl->pendingGenerations.clear();impl->rejected.clear();impl->rejectionReason.clear();result.changed=true;
        impl->device=frame.commands.device;impl->queue=frame.commands.commandQueue;impl->colorSpace=colorSpace;impl->colorDescription=description;impl->sceneInputs=sceneInputs;impl->opaqueDisplay=frame.opaqueDisplay;impl->scopeIdentity=prefixIdentity;if(next->memoryDegraded)impl->memoryRetry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
        impl->inputW=frame.source.width;impl->inputH=frame.source.height;impl->outputW=frame.target.width;impl->outputH=frame.target.height;impl->inputFormat=frame.source.pixelFormat;impl->outputFormat=frame.target.pixelFormat;
    }catch(const ScenePreparing&error){if(building){impl->partial=std::shared_ptr<EffectExecution>(new EffectExecution(building),[](EffectExecution*value){retireResource(value);});impl->partialKey=requestIdentity;}impl->waiting=error.ready;if(!impl->waiting){const auto retry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);impl->waiting=[retry]{return std::chrono::steady_clock::now()<retry?ShaderResult{false,"Preparing graphics resources",true}:ShaderResult{true,{}};};}return pending(error.what());}
    catch(const TransientBusy &error){
        if(error.structurallyImpossible){impl->rejected=identity;impl->rejectionReason=result.error=failureReason(error);}
        else{impl->transientBusy=true;impl->memoryBusy=threadImageDenials()!=denials;impl->rejectionReason=error.what();impl->partial.reset();impl->partialKey.clear();const auto retry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);impl->waiting=[retry]{return std::chrono::steady_clock::now()<retry?ShaderResult{false,"Waiting for graphics resources",true}:ShaderResult{true,{}};};return pending(error.what());}
    }
    catch(const std::exception &error){impl->rejected=identity;impl->rejectionReason=result.error=failureReason(error);}
    if(result.error.empty()&&impl->rejected==identity)result.error=impl->rejectionReason;
    result.execution=impl->current;
    if(result.execution&&!presentation){const auto controlsIdentity=presentationControlsDigest();RuntimeStatusEvent event;event.context=impl->statusContext;event.processing=true;event.resourceAccepted=true;event.phase=RuntimeStatusPhase::Prepared;
        event.planRevision=result.execution->revision();event.controlsDigest=controlsIdentity;event.reason=result.error;event.inputWidth=frame.source.width;event.inputHeight=frame.source.height;event.outputWidth=frame.target.width;event.outputHeight=frame.target.height;observeRuntimeStatus(event);}
    if(!result.error.empty()&&impl->reported!=result.error){nativeLog("Ordered effect change unavailable; previous chain retained: "+result.error);impl->reported=result.error;}
    return result;
}}
}
extern "C" uint32_t rsShaderInputPolicyAPI(void){return 1;}

extern "C" uint32_t rsShaderLinearInputPolicyAPI(void){return 1;}
