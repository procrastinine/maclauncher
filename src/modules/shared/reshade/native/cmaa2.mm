// Copyright (c) MacLauncher contributors. MIT license.
// Original CMAA2 kernels: Copyright (c) 2018 Intel Corporation, Apache-2.0.
#include "cmaa2.hpp"
#include "cmaa2-shaders.hpp"
#include "color-conversion.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <tuple>
#include <vector>
namespace macfx {namespace {
struct Settings {unsigned quality=2;bool sharp=false,hasColor=false;ImageColorDescription color;};
Settings settings(const ShaderParameters&params){Settings s;for(const auto&[name,value]:params){if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("CMAA2 parameters require finite scalar values");if(name=="Quality"&&value[0]>=0&&value[0]<=3&&std::floor(value[0])==value[0])s.quality=unsigned(value[0]);else if(name=="ExtraSharpness"&&(value[0]==0||value[0]==1))s.sharp=value[0]!=0;else throw std::invalid_argument("Unsupported CMAA2 parameter or value");}return s;}
ImageColorDescription inputColor(const ShaderFrame&f,const Settings&s){auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);if(f.opaqueDisplay)c.alpha=ColorAlpha::Opaque;return c;}
bool sameColor(const ImageColorDescription&a,const ImageColorDescription&b){return a.primaries==b.primaries&&a.transfer==b.transfer&&a.range==b.range&&a.alpha==b.alpha&&a.referenceWhite==b.referenceWhite&&a.peakLuminance==b.peakLuminance&&a.blackLuminance==b.blackLuminance&&a.hlgSystemGamma==b.hlgSystemGamma&&a.sceneReferred==b.sceneReferred;}
bool hdrColor(const ImageColorDescription&c){return c.transfer==ColorTransfer::PQ||c.transfer==ColorTransfer::HLG||c.peakLuminance>c.referenceWhite;}
struct Buffer {id<MTLBuffer>value;std::shared_ptr<ImageReservation>reservation;};
struct Pipelines {id<MTLDevice>device;std::array<id<MTLComputePipelineState>,4>values;bool hdr=false,sharp=false;};
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0;MTLPixelFormat outputFormat=MTLPixelFormatInvalid;ImageColorDescription color,linear;bool sharp=false;
 std::shared_ptr<Pipelines>pipelines;std::map<std::string,id<MTLTexture>>textures;std::map<std::string,Buffer>buffers;std::vector<PooledImage>pooled;
 std::unique_ptr<ColorEncoder>incoming,outgoing;std::atomic<bool>failed{false};
 bool matches(const ShaderFrame&f,const Settings&s,const ImageColorDescription&c)const{return !failed.load()&&device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&outputFormat==f.target.pixelFormat&&sharp==s.sharp&&sameColor(color,c);}
};
dispatch_queue_t retirement(){static auto q=dispatch_queue_create("MacLauncher CMAA2 retirement",DISPATCH_QUEUE_SERIAL);return q;}
std::shared_ptr<Resources>resources(){return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});});}
Buffer buffer(id<MTLDevice>d,uint64_t bytes,bool shared=false){Buffer b;b.reservation=reserveImageBytes(d,bytes,0,"CMAA2 scratch buffer");b.value=[d newBufferWithLength:bytes options:shared?MTLResourceStorageModeShared:MTLResourceStorageModePrivate];if(!b.value)throw std::runtime_error("Cannot allocate a CMAA2 scratch buffer");b.reservation->commit(b.value.allocatedSize);return b;}
// Color, edge and candidate storage is rewritten before it is read in each
// frame, so instances with the same extent and queue share one device copy.
// The blend-list heads are reset by the final pass for the next frame and stay
// with their instance.
id<MTLTexture>texture(Resources&r,const std::string&name,unsigned w,unsigned h,MTLPixelFormat format,bool target=false){auto td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];td.storageMode=MTLStorageModePrivate;td.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|(target?MTLTextureUsageRenderTarget:0);r.pooled.push_back(shareWorkingImage(r.device,td,"cmaa2."+name,r.queue));return r.pooled.back().texture();}
Buffer working(Resources&r,const std::string&name,uint64_t bytes){r.pooled.push_back(shareWorkingBuffer(r.device,bytes,MTLResourceStorageModePrivate,"cmaa2."+name,r.queue));return {r.pooled.back().buffer(),{}};}
std::shared_ptr<Pipelines>pipelines(id<MTLDevice>d,bool hdr,bool sharp){static std::mutex lock;static std::map<std::tuple<void*,bool,bool>,std::weak_ptr<Pipelines>>cache;auto key=std::make_tuple((__bridge void*)d,hdr,sharp);{std::lock_guard guard(lock);if(auto p=cache[key].lock())return p;}
 auto p=std::make_shared<Pipelines>();p->device=d;p->hdr=hdr;p->sharp=sharp;for(unsigned i=0;i<4;i++){
  const auto&shader=cmaa2_shaders::shaders[hdr][sharp][i];NSError*error=nil;auto library=cachedMetalLibrary(d,shader.source,&error);if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"CMAA2 GPU compilation failed");id<MTLFunction>function;
  if(std::strstr(shader.source,"spvLinearTextureAlignmentOverride")){auto constants=[MTLFunctionConstantValues new];uint32_t alignment=(uint32_t)[d minimumLinearTextureAlignmentForPixelFormat:MTLPixelFormatR32Uint];[constants setConstantValue:&alignment type:MTLDataTypeUInt atIndex:65535];function=[library newFunctionWithName:[NSString stringWithUTF8String:shader.entry] constantValues:constants error:&error];}else function=[library newFunctionWithName:[NSString stringWithUTF8String:shader.entry]];
  if(function)p->values[i]=[d newComputePipelineStateWithFunction:function error:&error];if(!p->values[i]||shader.x*shader.y*shader.z>p->values[i].maxTotalThreadsPerThreadgroup)throw std::runtime_error(error.localizedDescription.UTF8String?:"The CMAA2 work group is unavailable on this GPU");
 }{std::lock_guard guard(lock);cache[key]=p;}return p;
}
void initialize(Resources&r,const ShaderFrame&f,const Settings&s,const ImageColorDescription&c){r.device=f.commands.device;r.queue=f.commands.commandQueue;r.width=(unsigned)f.source.width;r.height=(unsigned)f.source.height;r.outputFormat=f.target.pixelFormat;r.color=c;r.linear=c;r.linear.transfer=ColorTransfer::Linear;r.linear.range=ColorRange::Full;r.linear.alpha=ColorAlpha::Straight;r.sharp=s.sharp;r.pipelines=pipelines(r.device,hdrColor(c),s.sharp);
 const uint64_t pixels=uint64_t(r.width)*r.height,quads=uint64_t((r.width+1)/2)*((r.height+1)/2);if(pixels>(1ull<<26))throw std::runtime_error("The CMAA2 image exceeds its 26-bit packed blend-address domain");
 r.textures["g_inoutColorReadonly"]=texture(r,"g_inoutColorReadonly",r.width,r.height,MTLPixelFormatRGBA16Float,true);r.textures["g_inoutColorWriteonly"]=texture(r,"g_inoutColorWriteonly",r.width,r.height,MTLPixelFormatRGBA16Float,true);r.textures["g_workingEdges"]=texture(r,"g_workingEdges",(r.width+1)/2,r.height,MTLPixelFormatR8Uint);
 r.buffers["g_workingShapeCandidates"]=working(r,"g_workingShapeCandidates",pixels*4);r.buffers["g_workingDeferredBlendLocationList"]=working(r,"g_workingDeferredBlendLocationList",quads*4);r.buffers["g_workingDeferredBlendItemList"]=working(r,"g_workingDeferredBlendItemList",pixels*16);r.buffers["g_workingControlBuffer"]=buffer(r.device,64,true);r.buffers["g_workingExecuteIndirectBuffer"]=buffer(r.device,16);
 const unsigned w=(r.width+1)/2,h=(r.height+1)/2;const auto alignment=[r.device minimumLinearTextureAlignmentForPixelFormat:MTLPixelFormatR32Uint],row=(w*4+alignment-1)&~(alignment-1);auto heads=buffer(r.device,row*h,true);std::memset(heads.value.contents,0xFF,heads.value.length);auto td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Uint width:w height:h mipmapped:NO];td.storageMode=MTLStorageModeShared;td.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;auto headTexture=[heads.value newTextureWithDescriptor:td offset:0 bytesPerRow:row];if(!headTexture)throw std::runtime_error("Cannot allocate the CMAA2 atomic-head texture alias");r.textures["g_workingDeferredBlendItemListHeads"]=headTexture;r.buffers["g_workingDeferredBlendItemListHeads_atomic"]=std::move(heads);
 r.incoming=std::make_unique<ColorEncoder>(r.device);r.outgoing=std::make_unique<ColorEncoder>(r.device);auto a=r.incoming->prepare(MTLPixelFormatRGBA16Float),b=r.outgoing->prepare(f.target.pixelFormat);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);
}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "CMAA2 requires separate images and retaining unsubmitted Metal commands";if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.width!=f.target.width||f.source.height!=f.target.height)return "CMAA2 requires same-extent resolved images on the current GPU";if(!(f.source.usage&MTLTextureUsageShaderRead)||!(f.target.usage&MTLTextureUsageRenderTarget)||f.source.framebufferOnly)return "CMAA2 requires readable color and a renderable output image";return {};}
class Cmaa2 final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;
public:
 explicit Cmaa2(const ShaderParameters&params):options(std::make_shared<Settings>(settings(params))){}
 void setParameters(const ShaderParameters&params)override{auto next=settings(params),old=*std::atomic_load(&options);next.color=old.color;next.hasColor=old.hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid CMAA2 image color description");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<Cmaa2>fork(const ShaderParameters&params){auto next=std::make_shared<Cmaa2>(params);next->state=std::atomic_load(&state);auto value=std::make_shared<Settings>(*next->options);auto old=std::atomic_load(&options);value->color=old->color;value->hasColor=old->hasColor;next->options=value;return next;}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{if(auto error=validate(f);!error.empty())return {false,error,false};auto s=std::atomic_load(&options);auto c=inputColor(f,*s);auto previous=std::atomic_load(&state);if(previous&&previous->matches(f,*s,c))return {true,{},false};auto next=resources();initialize(*next,f,*s,c);std::atomic_store(&state,next);return {true,{},false};}}catch(const std::exception&e){return {false,e.what(),false};}}
 ShaderResult encode(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto error=validate(f);!error.empty())return {false,error,false};auto s=std::atomic_load(&options);auto c=inputColor(f,*s);auto r=std::atomic_load(&state);if(!r||!r->matches(f,*s,c))return {false,"CMAA2 resources are preparing for the current image",true};
  auto source=f.source,target=f.target;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>done){if(done.status!=MTLCommandBufferStatusCompleted)r->failed=true;(void)source;(void)target;}];
  ColorConversion enter;enter.source=r->color;enter.target=r->linear;enter.frameId=f.frameId;auto converted=r->incoming->encode(f.commands,f.source,r->textures.at("g_inoutColorReadonly"),enter);if(!converted.encoded)return converted;
  auto blit=[f.commands blitCommandEncoder];[blit fillBuffer:r->buffers.at("g_workingControlBuffer").value range:NSMakeRange(0,64) value:0];[blit copyFromTexture:r->textures.at("g_inoutColorReadonly") toTexture:r->textures.at("g_inoutColorWriteonly")];[blit endEncoding];
  constexpr float threshold[]={.15f,.10f,.07f,.05f};float scalar[4]={threshold[s->quality],0,0,0};
  auto dispatch=[&](unsigned pass,MTLSize groups,bool indirect){const auto&shader=cmaa2_shaders::shaders[r->pipelines->hdr][r->pipelines->sharp][pass];auto encoder=[f.commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot create a CMAA2 compute encoder");[encoder setComputePipelineState:r->pipelines->values[pass]];std::array<uint32_t,31>sizes{};
   for(const auto&[name,b]:r->buffers)[encoder useResource:b.value usage:MTLResourceUsageRead|MTLResourceUsageWrite];
   for(size_t i=0;i<shader.count;i++){const auto&b=shader.bindings[i];if(std::strcmp(b.kind,"texture")==0){auto it=r->textures.find(b.name);if(it==r->textures.end())throw std::runtime_error("Unknown CMAA2 texture binding");[encoder setTexture:it->second atIndex:b.index];}else if(std::strcmp(b.kind,"buffer")==0){if(std::strcmp(b.name,"MacLauncherCmaaOptions")==0)[encoder setBytes:scalar length:sizeof(scalar) atIndex:b.index];else if(std::strcmp(b.name,"spvBufferSizeConstants")!=0){auto it=r->buffers.find(b.name);if(it==r->buffers.end()||b.index>=sizes.size())throw std::runtime_error("Unknown CMAA2 buffer binding");[encoder setBuffer:it->second.value offset:0 atIndex:b.index];sizes[b.index]=(uint32_t)it->second.value.length;}}else throw std::runtime_error("Unsupported CMAA2 resource binding");}
   for(size_t i=0;i<shader.count;i++)if(std::strcmp(shader.bindings[i].name,"spvBufferSizeConstants")==0)[encoder setBytes:sizes.data() length:sizeof(sizes) atIndex:shader.bindings[i].index];
   const auto threads=MTLSizeMake(shader.x,shader.y,shader.z);if(indirect)[encoder dispatchThreadgroupsWithIndirectBuffer:r->buffers.at("g_workingExecuteIndirectBuffer").value indirectBufferOffset:0 threadsPerThreadgroup:threads];else [encoder dispatchThreadgroups:groups threadsPerThreadgroup:threads];[encoder endEncoding];
  };
  dispatch(0,MTLSizeMake((r->width+27)/28,(r->height+27)/28,1),false);dispatch(1,MTLSizeMake(2,1,1),false);dispatch(2,MTLSizeMake(0,0,0),true);dispatch(1,MTLSizeMake(1,2,1),false);dispatch(3,MTLSizeMake(0,0,0),true);
  ColorConversion leave;leave.source=r->linear;leave.target=r->color;leave.frameId=f.frameId;leave.alphaSource=f.source;return r->outgoing->encode(f.commands,r->textures.at("g_inoutColorWriteonly"),f.target,leave);
 }}catch(const std::exception&e){return {false,e.what(),false};}}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeCmaa2Node(const ShaderParameters&params){return std::make_shared<Cmaa2>(params);}
std::shared_ptr<macfx::ShaderNode>macfx::forkCmaa2Node(const std::shared_ptr<ShaderNode>&previous,const ShaderParameters&params){auto node=std::dynamic_pointer_cast<Cmaa2>(previous);return node?node->fork(params):nullptr;}
void macfx::setCmaa2NodeColor(const std::shared_ptr<ShaderNode>&value,const ImageColorDescription&color){auto node=std::dynamic_pointer_cast<Cmaa2>(value);if(node)node->setColor(color);}
