// Copyright (c) MacLauncher contributors. MIT license.
// Original FidelityFX DoF: Copyright (c) 2024 Advanced Micro Devices, Inc.
// Original hash22: Copyright (c) 2014 David Hoskins.
// See dof-MIT.txt and dof-HASH22-MIT.txt.
#include "dof.hpp"
#include "dof-shaders.hpp"
#include "dof-upstream.hpp"
#include "native-scene-projection.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "gpu-completion.hpp"
#include "generation-timeline.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <algorithm>
#include <atomic>
#include <array>
#include <cstring>
#include <map>
#include <mutex>
#include <stdexcept>

namespace macfx {namespace {
static_assert(sizeof(dof_host::DofConstants)==40);
struct Settings {
 float focus=10,radius=12;unsigned quality=3;bool merge=true,hasColor=false;ImageColorDescription color;
};
Settings settings(const ShaderParameters&p){Settings s;for(const auto&[name,values]:p){
 if(values.size()!=1||!std::isfinite(values[0]))throw std::invalid_argument("DoF controls require finite scalar values");const float v=values[0];
 if(name=="FocusDistance"&&v>=.0001f&&v<=1000000)s.focus=v;
 else if(name=="BlurRadius"&&v>=0&&v<=256)s.radius=v;
 else if(name=="Quality"&&v>=1&&v<=8&&std::floor(v)==v)s.quality=unsigned(v);
 else if(name=="MergeRings"&&(v==0||v==1))s.merge=v!=0;
 else throw std::invalid_argument("Invalid FidelityFX DoF control");
 }return s;}
ImageColorDescription color(const ShaderFrame&f,const Settings&s){auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);if(f.opaqueDisplay)c.alpha=ColorAlpha::Opaque;return c;}
bool depthFormat(MTLPixelFormat f){return f==MTLPixelFormatDepth16Unorm||f==MTLPixelFormatDepth32Float||f==MTLPixelFormatDepth24Unorm_Stencil8||f==MTLPixelFormatDepth32Float_Stencil8;}
std::string reason(const ShaderFrame&f,const RSTemporalFrame*scene,const std::optional<RSSceneMatrices>&m){
 if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "DoF requires separate images and retaining unsubmitted commands";
 if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.width!=f.target.width||f.source.height!=f.target.height||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.framebufferOnly)return "DoF requires matching readable resolved RGB images";
 if(f.target.usage!=MTLTextureUsageUnknown&&!(f.target.usage&MTLTextureUsageShaderWrite))return "DoF requires a writable working target";
 if(auto e=sceneProjectionReason(f,scene,m);!e.empty())return "DoF: "+e;
 const auto format=((__bridge id<MTLTexture>)scene->depth).pixelFormat;
 if(!depthFormat(format)&&format!=MTLPixelFormatR32Float&&format!=MTLPixelFormatR16Float&&format!=MTLPixelFormatR16Unorm)return "DoF requires raw floating-point or normalized scalar renderer depth";
 return {};
}
struct Pipelines {
 std::map<std::string,id<MTLComputePipelineState>>values;id<MTLComputePipelineState>depth,restore;
 std::map<std::string,id<MTLSamplerState>>samplers;
};
const char*restoreShader=R"MSL(
#include <metal_stdlib>
using namespace metal;
kernel void dof_restore_invalid(texture2d<float>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],device const uint*valid[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
 if(valid[0]||any(p>=uint2(target.get_width(),target.get_height())))return;
 target.write(source.read(p),p);
}
)MSL";
std::string depthSource(std::string code){
 const std::string declaration="texture2d<float> mlRawDepth",read="mlRawDepth.read(";
 auto at=code.find(declaration);if(at==std::string::npos)throw std::runtime_error("DoF depth boundary declaration changed");code.replace(at,declaration.size(),"depth2d<float> mlRawDepth");
 size_t offset=0;unsigned count=0;while((at=code.find(read,offset))!=std::string::npos){size_t end=at+read.size();unsigned nested=1;for(;end<code.size()&&nested;end++){if(code[end]=='(')nested++;else if(code[end]==')')nested--;}if(nested)throw std::runtime_error("DoF scalar depth read changed");const auto original=code.substr(at,end-at);code.replace(at,end-at,"float4("+original+")");offset=at+original.size()+8;count++;}if(!count)throw std::runtime_error("DoF depth read is unavailable");return code;
}
std::shared_ptr<Pipelines>pipelines(id<MTLDevice>device){
 static std::mutex mutex;static std::map<void*,std::weak_ptr<Pipelines>>cache;const auto key=(__bridge void*)device;
 {std::lock_guard guard(mutex);if(auto previous=cache[key].lock())return previous;}
 auto p=std::make_shared<Pipelines>();const auto compile=[&](const std::string&code,const char*entry){NSError*error=nil;auto library=cachedMetalLibrary(device,code,&error);auto fn=[library newFunctionWithName:@(entry)];auto value=fn?[device newComputePipelineStateWithFunction:fn error:&error]:nil;if(!value||value.staticThreadgroupMemoryLength>device.maxThreadgroupMemoryLength)throw std::runtime_error(error.localizedDescription.UTF8String?:"The DoF compute pipeline is unavailable on this GPU");return value;};
 for(const auto&s:dof_shaders::shaders){auto value=compile(s.source,s.entry);if(s.x*s.y*s.z>value.maxTotalThreadsPerThreadgroup)throw std::runtime_error("The DoF compute workgroup is unavailable on this GPU");p->values[s.name]=value;if(!std::strcmp(s.name,"depth"))p->depth=compile(depthSource(s.source),s.entry);}
 p->restore=compile(restoreShader,"dof_restore_invalid");
 for(const bool linear:{false,true}){auto d=[MTLSamplerDescriptor new];d.minFilter=d.magFilter=linear?MTLSamplerMinMagFilterLinear:MTLSamplerMinMagFilterNearest;d.mipFilter=linear?MTLSamplerMipFilterLinear:MTLSamplerMipFilterNearest;d.sAddressMode=d.tAddressMode=d.rAddressMode=MTLSamplerAddressModeClampToEdge;auto sampler=[device newSamplerStateWithDescriptor:d];if(!sampler)throw std::runtime_error("Cannot prepare a DoF image sampler");p->samplers[linear?"LinearSampler":"PointSampler"]=sampler;}
 {std::lock_guard guard(mutex);if(auto previous=cache[key].lock())return previous;cache[key]=p;}return p;
}
struct ValiditySlot {id<MTLBuffer>buffer;size_t offset=0;};
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0;MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,targetFormat=MTLPixelFormatInvalid;
 ImageColorDescription input,linear;std::shared_ptr<Pipelines>pipelines;std::map<std::string,id<MTLTexture>>textures;std::array<id<MTLTexture>,4>mips{};
 id<MTLBuffer>globals,validity;std::shared_ptr<ImageReservation>globalsReservation,validityReservation;
 std::vector<std::shared_ptr<ValiditySlot>>slots;std::mutex slotMutex;std::vector<PooledImage>pooled;
 std::unique_ptr<ColorEncoder>enter,leave;
 bool matches(const ShaderFrame&f,const ImageColorDescription&c)const{return device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&sourceFormat==f.source.pixelFormat&&targetFormat==f.target.pixelFormat&&sameImageColorDescription(input,c);}
 std::shared_ptr<ValiditySlot>acquire(){std::unique_lock guard(slotMutex,std::try_to_lock);if(!guard)return {};for(const auto&slot:slots)if(slot.use_count()==1){*reinterpret_cast<uint32_t*>(static_cast<char*>(slot->buffer.contents)+slot->offset)=1;return slot;}return {};}
};
// Every working image is rewritten before it is read in each frame, so
// instances with the same extent and queue share one device copy.
id<MTLTexture>texture(Resources&r,const char*role,unsigned w,unsigned h,MTLPixelFormat format,bool render=false,unsigned mips=1){auto td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];td.mipmapLevelCount=mips;td.storageMode=MTLStorageModePrivate;td.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|(render?MTLTextureUsageRenderTarget:0);r.pooled.push_back(shareWorkingImage(r.device,td,role,r.queue));return r.pooled.back().texture();}
dispatch_queue_t retirement(){static auto q=dispatch_queue_create("MacLauncher DoF retirement",DISPATCH_QUEUE_SERIAL);return q;}
std::shared_ptr<Resources>resources(){return {new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});}};}
struct Flight {
 GPUCompletionFence fence;std::shared_ptr<Resources>resources;std::shared_ptr<ValiditySlot>valid;
 ShaderResult complete()const{if(!fence.completed())return {false,fence.failed()?"FidelityFX DoF GPU processing failed":"FidelityFX DoF processing is pending",!fence.failed()};if(valid&&!*reinterpret_cast<const uint32_t*>(static_cast<const char*>(valid->buffer.contents)+valid->offset))return {false,"The renderer supplied nonfinite depth or projection coordinates; current source color was preserved"};return {true,{}};}
};
class Dof final:public ShaderNode,public NativeSceneShader {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;std::shared_ptr<Flight>last;
public:
 explicit Dof(const ShaderParameters&p):options(std::make_shared<Settings>(settings(p))){}
 void setParameters(const ShaderParameters&p)override{auto next=std::make_shared<Settings>(settings(p));auto old=std::atomic_load(&options);next->color=old->color;next->hasColor=old->hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid DoF color metadata");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<Dof>fork(const ShaderParameters&p){auto next=std::make_shared<Dof>(p);next->state=std::atomic_load(&state);auto old=std::atomic_load(&options);auto s=std::make_shared<Settings>(*next->options);s->color=old->color;s->hasColor=old->hasColor;next->options=s;return next;}
 ShaderResult prepare(const ShaderFrame&)override{return {false,"FidelityFX DoF needs actual renderer depth and projection"};}
 ShaderResult encode(const ShaderFrame&)override{return {false,"FidelityFX DoF needs actual renderer depth and projection"};}
 std::string sceneInputReason(const ShaderFrame&f,const RSTemporalFrame*s,const std::optional<RSSceneMatrices>&m)const override{return reason(f,s,m);}
 ShaderResult prepareScene(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{
  if(auto error=reason(f,&s,m);!error.empty())return {false,error};(void)sceneProjectionConstants(f,s,*m);auto c=color(f,*std::atomic_load(&options));auto previous=std::atomic_load(&state);if(previous&&previous->matches(f,c))return {true,{}};
  auto r=resources();r->device=f.commands.device;r->queue=f.commands.commandQueue;r->width=f.source.width;r->height=f.source.height;r->sourceFormat=f.source.pixelFormat;r->targetFormat=f.target.pixelFormat;r->input=c;r->linear=c;r->linear.transfer=ColorTransfer::Linear;r->linear.range=ColorRange::Full;r->linear.alpha=ColorAlpha::Straight;r->pipelines=pipelines(r->device);
  const auto w=r->width,h=r->height,halfW=(w+1)/2,halfH=(h+1)/2;
  r->textures["source"]=texture(*r,"dof.source",w,h,MTLPixelFormatRGBA32Float,true);r->textures["depth"]=texture(*r,"dof.depth",w,h,MTLPixelFormatR32Float);
  r->textures["bilat"]=texture(*r,"dof.bilateral",std::max(8u,halfW),std::max(8u,halfH),MTLPixelFormatRGBA32Float,false,4);
  for(unsigned i=0;i<4;i++){r->mips[i]=[r->textures.at("bilat")newTextureViewWithPixelFormat:MTLPixelFormatRGBA32Float textureType:MTLTextureType2D levels:NSMakeRange(i,1)slices:NSMakeRange(0,1)];if(!r->mips[i])throw std::runtime_error("Cannot create a DoF bilateral mip view");}
  r->textures["radius"]=texture(*r,"dof.radius",(halfW+3)/4,(halfH+4)/4,MTLPixelFormatRG32Float);r->textures["dilated"]=texture(*r,"dof.dilated",(halfW+3)/4,(halfH+4)/4,MTLPixelFormatRG32Float);
  r->textures["near"]=texture(*r,"dof.near",halfW,halfH,MTLPixelFormatRGBA32Float);r->textures["far"]=texture(*r,"dof.far",halfW,halfH,MTLPixelFormatRGBA32Float);
  r->textures["result"]=texture(*r,"dof.result",w,h,MTLPixelFormatRGBA32Float);r->textures["oriented"]=texture(*r,"dof.oriented",w,h,MTLPixelFormatRGBA32Float,true);
  r->globalsReservation=reserveImageBytes(r->device,4096,0,"DoF reduction metadata");r->globals=[r->device newBufferWithLength:4 options:MTLResourceStorageModePrivate];if(!r->globals)throw std::runtime_error("Cannot allocate DoF reduction metadata");r->globalsReservation->commit(r->globals.allocatedSize);
  // Four admitted source command leases can each expand the shared timeline.
  // Metadata slots are prepared once; exhaustion holds the completed image.
  constexpr unsigned count=4*maximumTimelineImages;r->validityReservation=reserveImageBytes(r->device,4096,0,"DoF validity metadata");r->validity=[r->device newBufferWithLength:count*4 options:MTLResourceStorageModeShared];if(!r->validity)throw std::runtime_error("Cannot allocate DoF validity metadata");r->validityReservation->commit(r->validity.allocatedSize);for(unsigned i=0;i<count;i++){auto slot=std::make_shared<ValiditySlot>();slot->buffer=r->validity;slot->offset=i*4;r->slots.push_back(std::move(slot));}
  r->enter=std::make_unique<ColorEncoder>(r->device);r->leave=std::make_unique<ColorEncoder>(r->device);auto a=r->enter->prepare(MTLPixelFormatRGBA32Float),b=r->leave->prepare(f.target.pixelFormat);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);std::atomic_store(&state,r);return {true,{}};
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult encodeScene(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{
  if(auto error=reason(f,&s,m);!error.empty())return {false,error};auto setting=std::atomic_load(&options);auto r=std::atomic_load(&state);if(!r||!r->matches(f,color(f,*setting)))return {false,"FidelityFX DoF resources are preparing",true};
  auto slot=r->acquire();if(!slot)return {false,"FidelityFX DoF frame metadata is in use",true};auto flight=std::make_shared<Flight>();flight->resources=r;flight->valid=slot;flight->fence.bind(f.commands);
  auto source=f.source,target=f.target,depth=(__bridge id<MTLTexture>)s.depth;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);(void)source;(void)target;(void)depth;}];
  if(setting->radius==0&&f.source.pixelFormat==f.target.pixelFormat){auto copy=[f.commands blitCommandEncoder];if(!copy)return {false,"Cannot encode the DoF identity copy"};[copy copyFromTexture:f.source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)sourceSize:MTLSizeMake(r->width,r->height,1)toTexture:f.target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
  else{
   ColorConversion enter;enter.source=r->input;enter.target=r->linear;enter.flipY=f.origin==FrameOrigin::BottomLeft;enter.frameId=f.frameId;auto result=r->enter->encode(f.commands,f.source,r->textures.at("source"),enter);if(!result.encoded)return result;
   const auto projection=sceneProjectionConstants(f,s,*m);dof_host::DofConstants constants{};constants.cocScale=.5f*setting->radius*setting->focus;constants.cocBias=-.5f*setting->radius;constants.inputSizeHalf[0]=(r->width+1)/2;constants.inputSizeHalf[1]=(r->height+1)/2;constants.inputSize[0]=r->width;constants.inputSize[1]=r->height;constants.inputSizeHalfRcp[0]=1.f/constants.inputSizeHalf[0];constants.inputSizeHalfRcp[1]=1.f/constants.inputSizeHalf[1];constants.cocLimit=.5f*setting->radius;constants.maxRings=setting->quality;
   auto reset=[f.commands blitCommandEncoder];if(!reset)return {false,"Cannot reset DoF reduction metadata"};[reset fillBuffer:r->globals range:NSMakeRange(0,4)value:0];[reset endEncoding];
   std::map<std::string,id<MTLTexture>>bindings={{"r_input_depth",r->textures.at("depth")},{"r_input_color",r->textures.at("source")},{"r_internal_bilat_color",r->textures.at("bilat")},{"rw_internal_radius",r->textures.at("radius")},{"r_internal_dilated_radius",r->textures.at("dilated")},{"rw_internal_dilated_radius",r->textures.at("dilated")},{"rw_internal_near",r->textures.at("near")},{"rw_internal_far",r->textures.at("far")},{"rw_output_color",r->textures.at("result")},{"mlRawDepth",(__bridge id<MTLTexture>)s.depth},{"mlDepth",r->textures.at("depth")},{"mlSource",r->textures.at("source")},{"mlResult",r->textures.at("result")},{"mlOutput",r->textures.at("oriented")}};for(unsigned i=0;i<4;i++)bindings["rw_internal_bilat_color_mip"+std::to_string(i)]=r->mips[i];
   const auto dispatch=[&](const std::string&name,MTLSize groups){const dof_shaders::Shader*shader=nullptr;for(const auto&value:dof_shaders::shaders)if(name==value.name){shader=&value;break;}if(!shader)throw std::runtime_error("Unknown DoF compute kernel");auto encoder=[f.commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode FidelityFX DoF");[encoder setComputePipelineState:name=="depth"&&depthFormat(((__bridge id<MTLTexture>)s.depth).pixelFormat)?r->pipelines->depth:r->pipelines->values.at(name)];
    for(size_t i=0;i<shader->count;i++){const auto&b=shader->bindings[i];if(!std::strcmp(b.kind,"texture")){auto found=bindings.find(b.name);if(found==bindings.end())throw std::runtime_error("Unknown DoF texture binding");[encoder setTexture:found->second atIndex:b.index];}else if(!std::strcmp(b.kind,"sampler"))[encoder setSamplerState:r->pipelines->samplers.at(b.name)atIndex:b.index];else if(!std::strcmp(b.name,"cbDOF"))[encoder setBytes:&constants length:sizeof(constants)atIndex:b.index];else if(!std::strcmp(b.name,"MacLauncherScene"))[encoder setBytes:&projection length:sizeof(projection)atIndex:b.index];else if(!std::strcmp(b.name,"rw_internal_globals"))[encoder setBuffer:r->globals offset:0 atIndex:b.index];else if(!std::strcmp(b.name,"mlValidity"))[encoder setBuffer:slot->buffer offset:slot->offset atIndex:b.index];else throw std::runtime_error("Unknown DoF buffer binding");}
    [encoder dispatchThreadgroups:groups threadsPerThreadgroup:MTLSizeMake(shader->x,shader->y,shader->z)];[encoder endEncoding];};
   const auto full=MTLSizeMake((r->width+7)/8,(r->height+7)/8,1);dispatch("depth",full);for(const auto&pass:dof_host::schedule(r->width,r->height)){const std::string name=std::string(pass.name)=="blur"&&!setting->merge?"blur-unmerged":pass.name;dispatch(name,MTLSizeMake(pass.x,pass.y,1));}dispatch("orient",full);
   ColorConversion leave;leave.source=r->linear;leave.target=r->input;leave.alphaSource=f.source;leave.frameId=f.frameId;result=r->leave->encode(f.commands,r->textures.at("oriented"),f.target,leave);if(!result.encoded)return result;
   auto restore=[f.commands computeCommandEncoder];if(!restore)return {false,"Cannot encode the DoF source fallback"};[restore setComputePipelineState:r->pipelines->restore];[restore setTexture:f.source atIndex:0];[restore setTexture:f.target atIndex:1];[restore setBuffer:slot->buffer offset:slot->offset atIndex:0];[restore dispatchThreads:MTLSizeMake(r->width,r->height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[restore endEncoding];
  }
  std::atomic_store(&last,flight);return {true,{}};
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return {false,e.what()};}}
 std::function<ShaderResult()>completionTicket()override{auto flight=std::atomic_load(&last);return flight?[flight]{return flight->complete();}:std::function<ShaderResult()>{};}
 ShaderResult complete(){auto ticket=completionTicket();return ticket?ticket():ShaderResult{true,{}};}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeFfxDofNode(const ShaderParameters&p){return std::make_shared<Dof>(p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkFfxDofNode(const std::shared_ptr<ShaderNode>&previous,const ShaderParameters&p){auto node=std::dynamic_pointer_cast<Dof>(previous);return node?node->fork(p):nullptr;}
void macfx::setFfxDofNodeColor(const std::shared_ptr<ShaderNode>&node,const ImageColorDescription&c){if(auto value=std::dynamic_pointer_cast<Dof>(node))value->setColor(c);}
macfx::ShaderResult macfx::finishFfxDofNode(const std::shared_ptr<ShaderNode>&node){auto value=std::dynamic_pointer_cast<Dof>(node);return value?value->complete():ShaderResult{true,{}};}
