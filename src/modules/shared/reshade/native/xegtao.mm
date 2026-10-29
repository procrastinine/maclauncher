// Copyright (c) MacLauncher contributors. MIT license.
// Original XeGTAO kernels: Copyright (c) 2016-2021 Intel Corporation, MIT.
#include "xegtao.hpp"
#include "native-scene.hpp"
#include "xegtao-shaders.hpp"
#include "color-conversion.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <cassert>
#include "xegtao-upstream.h"
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <vector>
namespace macfx {namespace {
struct Settings {unsigned quality=2,denoise=1;float radius=.5f,strength=1;bool hasColor=false;ImageColorDescription color;};
Settings settings(const ShaderParameters&params){Settings s;for(const auto&[name,value]:params){if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("XeGTAO parameters require finite scalar values");const float v=value[0];if(name=="Quality"&&v>=0&&v<=3&&std::floor(v)==v)s.quality=unsigned(v);else if(name=="DenoisePasses"&&v>=0&&v<=3&&std::floor(v)==v)s.denoise=unsigned(v);else if(name=="Radius"&&v>=.0001f&&v<=100000)s.radius=v;else if(name=="Strength"&&v>=0&&v<=1)s.strength=v;else throw std::invalid_argument("Unsupported XeGTAO parameter or value");}return s;}
ImageColorDescription inputColor(const ShaderFrame&f,const Settings&s){auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);if(f.opaqueDisplay)c.alpha=ColorAlpha::Opaque;return c;}
bool sameColor(const ImageColorDescription&a,const ImageColorDescription&b){return a.primaries==b.primaries&&a.transfer==b.transfer&&a.range==b.range&&a.alpha==b.alpha&&a.referenceWhite==b.referenceWhite&&a.peakLuminance==b.peakLuminance&&a.blackLuminance==b.blackLuminance&&a.hlgSystemGamma==b.hlgSystemGamma&&a.sceneReferred==b.sceneReferred;}
bool depthFormat(MTLPixelFormat f){return f==MTLPixelFormatDepth32Float||f==MTLPixelFormatDepth32Float_Stencil8||f==MTLPixelFormatDepth16Unorm;}
bool invert(const float*input,float*output){double a[4][8]{};for(unsigned i=0;i<4;i++)for(unsigned j=0;j<4;j++){if(!std::isfinite(input[i*4+j]))return false;a[i][j]=input[i*4+j];a[i][j+4]=i==j;}
 for(unsigned c=0;c<4;c++){unsigned pivot=c;for(unsigned r=c+1;r<4;r++)if(std::abs(a[r][c])>std::abs(a[pivot][c]))pivot=r;if(std::abs(a[pivot][c])<1e-15)return false;for(unsigned j=0;j<8;j++)std::swap(a[c][j],a[pivot][j]);double d=a[c][c];for(unsigned j=0;j<8;j++)a[c][j]/=d;for(unsigned r=0;r<4;r++)if(r!=c){double v=a[r][c];for(unsigned j=0;j<8;j++)a[r][j]-=v*a[c][j];}}
 for(unsigned i=0;i<4;i++)for(unsigned j=0;j<4;j++){output[i*4+j]=float(a[i][j+4]);if(!std::isfinite(output[i*4+j]))return false;}return true;
}
struct SceneConstants {float projection[16],inverse[16],jitterSign[4];uint32_t depthROI[4];float clip[4];};
static_assert(sizeof(SceneConstants)==176);static_assert(sizeof(XeGTAO::GTAOConstants)==96);
std::string sceneReason(const ShaderFrame&f,const RSTemporalFrame*scene,const std::optional<RSSceneMatrices>&matrices){
 if(!scene||!scene->depth)return "XeGTAO requires matching renderer depth";
 if(!matrices||(matrices->flags&RS_SCENE_PROJECTION_VALID)==0)return "XeGTAO requires the actual scene projection matrix";
 const uint32_t clip=matrices->flags&(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE);if(clip!=RS_SCENE_CLIP_ZERO_TO_ONE&&clip!=RS_SCENE_CLIP_MINUS_ONE_TO_ONE)return "XeGTAO requires the projection's explicit depth clip range";
 if(scene->frameId!=matrices->frameId||scene->commandBufferKind||scene->commandBuffer!=(__bridge void*)f.commands)return "XeGTAO depth and projection must belong to the current scene commands";
 if(scene->renderWidth!=f.source.width||scene->renderHeight!=f.source.height)return "XeGTAO requires depth and projection aligned to the current image extent";
 auto depth=(__bridge id<MTLTexture>)scene->depth;if(depth.device!=f.commands.device||depth.textureType!=MTLTextureType2D||depth.sampleCount!=1||depth.framebufferOnly||!(depth.usage&MTLTextureUsageShaderRead)||uint64_t(scene->depthX)+scene->renderWidth>depth.width||uint64_t(scene->depthY)+scene->renderHeight>depth.height)return "XeGTAO requires readable resolved depth covering the current image";
 if(!depthFormat(depth.pixelFormat)&&depth.pixelFormat!=MTLPixelFormatR32Float&&depth.pixelFormat!=MTLPixelFormatR16Float&&depth.pixelFormat!=MTLPixelFormatR16Unorm)return "XeGTAO requires floating-point or normalized scalar depth";
 if(!std::isfinite(scene->jitterX)||!std::isfinite(scene->jitterY))return "XeGTAO requires finite scene sample jitter";
 float inverse[16];if(!invert(matrices->projection,inverse))return "XeGTAO requires an invertible finite projection matrix";return {};
}
SceneConstants constants(const ShaderFrame&f,const RSTemporalFrame&scene,const RSSceneMatrices&m,const Settings&s){SceneConstants c{};std::memcpy(c.projection,m.projection,64);if(!invert(m.projection,c.inverse))throw std::invalid_argument("Invalid XeGTAO projection");
 // Derive the actual view-forward sign from this projection, independent of
 // reverse Z, handedness, perspective/orthographic or an infinite far plane.
 float z=c.inverse[10]*.5f+c.inverse[14],w=c.inverse[11]*.5f+c.inverse[15];if(!std::isfinite(z/w)||z/w==0){z=c.inverse[10]*.25f+c.inverse[14];w=c.inverse[11]*.25f+c.inverse[15];}if(!std::isfinite(z/w)||z/w==0)throw std::invalid_argument("XeGTAO projection has no finite forward view ray");
 const bool bottom=f.origin==FrameOrigin::BottomLeft;const bool jittered=(m.flags&RS_SCENE_PROJECTION_JITTERED)!=0;c.jitterSign[0]=jittered?0:scene.jitterX;c.jitterSign[1]=jittered?0:(bottom?-scene.jitterY:scene.jitterY);c.jitterSign[2]=z/w>0?1.f:-1.f;c.jitterSign[3]=float((bottom?1u:0u)|((m.flags&RS_SCENE_PROJECTION_Y_DOWN)?2u:0u));
 c.depthROI[0]=scene.depthX;c.depthROI[1]=scene.depthY;c.depthROI[2]=scene.renderWidth;c.depthROI[3]=scene.renderHeight;c.clip[0]=(m.flags&RS_SCENE_CLIP_MINUS_ONE_TO_ONE)?2.f:1.f;c.clip[1]=(m.flags&RS_SCENE_CLIP_MINUS_ONE_TO_ONE)?-1.f:0.f;c.clip[2]=s.strength;
 c.clip[3]=(m.projection[1]==0&&m.projection[3]==0&&m.projection[4]==0&&m.projection[7]==0&&m.projection[0]!=0&&m.projection[5]!=0)?1.f:0.f;return c;
}
struct Pipelines {id<MTLDevice>device;std::array<id<MTLComputePipelineState>,9>values;id<MTLComputePipelineState>depth;id<MTLSamplerState>point;};
struct Resources {id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0;MTLPixelFormat output=MTLPixelFormatInvalid;ImageColorDescription color,linear;std::shared_ptr<Pipelines>pipelines;std::map<std::string,id<MTLTexture>>textures;std::vector<PooledImage>pooled;std::unique_ptr<ColorEncoder>incoming,outgoing;std::atomic<bool>failed{false};
 bool matches(const ShaderFrame&f,const ImageColorDescription&c)const{return !failed.load()&&device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&output==f.target.pixelFormat&&sameColor(color,c);}
};
dispatch_queue_t retirement(){static auto q=dispatch_queue_create("MacLauncher XeGTAO retirement",DISPATCH_QUEUE_SERIAL);return q;}
std::shared_ptr<Resources>resources(){return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});});}
// Every working image is rewritten before it is read in each frame, so
// instances with the same extent and queue share one device copy.
id<MTLTexture>texture(Resources&r,const std::string&name,unsigned w,unsigned h,MTLPixelFormat format,bool target=false,unsigned mips=1){auto td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];td.mipmapLevelCount=mips;td.storageMode=MTLStorageModePrivate;td.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|(target?MTLTextureUsageRenderTarget:0);r.pooled.push_back(shareWorkingImage(r.device,td,"xegtao."+name,r.queue));return r.pooled.back().texture();}
std::shared_ptr<Pipelines>pipelines(id<MTLDevice>d){static std::mutex lock;static std::map<void*,std::weak_ptr<Pipelines>>cache;auto key=(__bridge void*)d;{std::lock_guard guard(lock);if(auto p=cache[key].lock())return p;}
 auto p=std::make_shared<Pipelines>();p->device=d;for(unsigned i=0;i<9;i++){const auto&s=xegtao_shaders::shaders[i];NSError*error=nil;auto lib=cachedMetalLibrary(d,s.source,&error);auto fn=[lib newFunctionWithName:[NSString stringWithUTF8String:s.entry]];if(fn)p->values[i]=[d newComputePipelineStateWithFunction:fn error:&error];if(!p->values[i]||s.x*s.y*s.z>p->values[i].maxTotalThreadsPerThreadgroup)throw std::runtime_error(error.localizedDescription.UTF8String?:"XeGTAO GPU compilation failed");}
 // Depth-format textures have a distinct Metal resource type; the exact same
 // unprojection kernel is specialized only at that texture declaration.
 std::string depth=xegtao_shaders::shaders[7].source;auto at=depth.find("texture2d<float> g_srcRawDepth");if(at==std::string::npos)throw std::runtime_error("XeGTAO depth texture declaration changed");depth.replace(at,std::strlen("texture2d<float> g_srcRawDepth"),"depth2d<float> g_srcRawDepth");auto read=depth.find("g_srcRawDepth.read(");if(read==std::string::npos)throw std::runtime_error("XeGTAO depth read contract changed");unsigned nested=1;size_t end=read+std::strlen("g_srcRawDepth.read(");for(;end<depth.size()&&nested;end++){if(depth[end]=='(')nested++;else if(depth[end]==')')nested--;}if(nested||depth.compare(end,2,".x")!=0)throw std::runtime_error("XeGTAO scalar depth read contract changed");depth.erase(end,2);NSError*error=nil;auto lib=cachedMetalLibrary(d,depth,&error);auto fn=[lib newFunctionWithName:@"CSUnprojectDepth"];if(fn)p->depth=[d newComputePipelineStateWithFunction:fn error:&error];if(!p->depth)throw std::runtime_error(error.localizedDescription.UTF8String?:"XeGTAO depth-format GPU compilation failed");
 auto sampler=[MTLSamplerDescriptor new];sampler.minFilter=MTLSamplerMinMagFilterNearest;sampler.magFilter=MTLSamplerMinMagFilterNearest;sampler.mipFilter=MTLSamplerMipFilterNearest;sampler.sAddressMode=MTLSamplerAddressModeClampToEdge;sampler.tAddressMode=MTLSamplerAddressModeClampToEdge;p->point=[d newSamplerStateWithDescriptor:sampler];if(!p->point)throw std::runtime_error("Cannot create the XeGTAO depth sampler");{std::lock_guard guard(lock);cache[key]=p;}return p;
}
void initialize(Resources&r,const ShaderFrame&f,const ImageColorDescription&c){r.device=f.commands.device;r.queue=f.commands.commandQueue;r.width=(unsigned)f.source.width;r.height=(unsigned)f.source.height;r.output=f.target.pixelFormat;r.color=c;r.linear=c;r.linear.transfer=ColorTransfer::Linear;r.linear.range=ColorRange::Full;r.linear.alpha=ColorAlpha::Straight;r.pipelines=pipelines(r.device);
 r.textures["linearColor"]=texture(r,"linearColor",r.width,r.height,MTLPixelFormatRGBA16Float,true);r.textures["shadedColor"]=texture(r,"shadedColor",r.width,r.height,MTLPixelFormatRGBA16Float,true);r.textures["linearDepth"]=texture(r,"linearDepth",r.width,r.height,MTLPixelFormatR32Float);
 const unsigned levels=std::min(5u,1u+(unsigned)std::floor(std::log2(std::max(r.width,r.height))));r.textures["workingDepth"]=texture(r,"workingDepth",r.width,r.height,MTLPixelFormatR32Float,false,levels);
 for(unsigned i=0;i<5;i++){auto view=i<levels?[r.textures["workingDepth"] newTextureViewWithPixelFormat:MTLPixelFormatR32Float textureType:MTLTextureType2D levels:NSMakeRange(i,1) slices:NSMakeRange(0,1)]:texture(r,"mip"+std::to_string(i),1,1,MTLPixelFormatR32Float);if(!view)throw std::runtime_error("Cannot create a XeGTAO depth mip view");r.textures["mip"+std::to_string(i)]=view;}
 r.textures["ao0"]=texture(r,"ao0",r.width,r.height,MTLPixelFormatR8Uint);r.textures["ao1"]=texture(r,"ao1",r.width,r.height,MTLPixelFormatR8Uint);r.textures["edges"]=texture(r,"edges",r.width,r.height,MTLPixelFormatR8Unorm);
 r.incoming=std::make_unique<ColorEncoder>(r.device);r.outgoing=std::make_unique<ColorEncoder>(r.device);auto a=r.incoming->prepare(MTLPixelFormatRGBA16Float),b=r.outgoing->prepare(f.target.pixelFormat);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);
}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "XeGTAO requires separate images and retaining unsubmitted Metal commands";if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.target.sampleCount!=1||!f.source.width||!f.source.height||f.source.width!=f.target.width||f.source.height!=f.target.height)return "XeGTAO requires same-extent resolved images on the current GPU";if(!(f.source.usage&MTLTextureUsageShaderRead)||!(f.target.usage&MTLTextureUsageRenderTarget)||f.source.framebufferOnly)return "XeGTAO requires readable color and a renderable output image";return {};}
class Xegtao final:public ShaderNode,public NativeSceneShader {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;
public:
 explicit Xegtao(const ShaderParameters&params):options(std::make_shared<Settings>(settings(params))){}
 void setParameters(const ShaderParameters&params)override{auto next=settings(params),old=*std::atomic_load(&options);next.color=old.color;next.hasColor=old.hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid XeGTAO image color description");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<Xegtao>fork(const ShaderParameters&params){auto next=std::make_shared<Xegtao>(params);next->state=std::atomic_load(&state);auto value=std::make_shared<Settings>(*next->options);auto old=std::atomic_load(&options);value->color=old->color;value->hasColor=old->hasColor;next->options=value;return next;}
 std::string sceneInputReason(const ShaderFrame&f,const RSTemporalFrame*s,const std::optional<RSSceneMatrices>&m)const override{return sceneReason(f,s,m);}
 ShaderResult prepare(const ShaderFrame&)override{return {false,"XeGTAO requires matching renderer depth and projection",true};}
 ShaderResult encode(const ShaderFrame&)override{return {false,"XeGTAO requires matching renderer depth and projection",true};}
 ShaderResult prepareScene(const ShaderFrame&f,const RSTemporalFrame&scene,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{if(auto error=validate(f);!error.empty())return {false,error,false};if(auto error=sceneReason(f,&scene,m);!error.empty())return {false,error,true};auto s=std::atomic_load(&options);auto c=inputColor(f,*s);(void)constants(f,scene,*m,*s);auto previous=std::atomic_load(&state);if(previous&&previous->matches(f,c))return {true,{},false};auto next=resources();initialize(*next,f,c);std::atomic_store(&state,next);return {true,{},false};}}catch(const std::exception&e){return {false,e.what(),false};}}
 ShaderResult encodeScene(const ShaderFrame&f,const RSTemporalFrame&scene,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{
  if(auto error=validate(f);!error.empty())return {false,error,false};if(auto error=sceneReason(f,&scene,m);!error.empty())return {false,error,true};auto s=std::atomic_load(&options);auto c=inputColor(f,*s);auto r=std::atomic_load(&state);if(!r||!r->matches(f,c))return {false,"XeGTAO resources are preparing for the current image",true};auto sc=constants(f,scene,*m,*s);
  XeGTAO::GTAOConstants gc{};XeGTAO::GTAOSettings gs;gs.Radius=s->radius;gs.DenoisePasses=(int)s->denoise;XeGTAO::GTAOUpdateConstants(gc,r->width,r->height,gs,m->projection,true,0);
  // Geometry uses the actual projection boundary, not the original helper's
  // perspective-only FOV/depth coefficients. Keep the remaining SDK tuning.
  auto source=f.source,target=f.target,depth=(__bridge id<MTLTexture>)scene.depth;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>done){if(done.status!=MTLCommandBufferStatusCompleted)r->failed=true;(void)source;(void)target;(void)depth;}];
  ColorConversion enter;enter.source=r->color;enter.target=r->linear;enter.frameId=f.frameId;auto converted=r->incoming->encode(f.commands,f.source,r->textures.at("linearColor"),enter);if(!converted.encoded)return converted;
  auto dispatch=[&](unsigned pass,MTLSize groups,const std::map<std::string,id<MTLTexture>>&textures){const auto&shader=xegtao_shaders::shaders[pass];auto encoder=[f.commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot create a XeGTAO compute encoder");auto depth=(__bridge id<MTLTexture>)scene.depth;[encoder setComputePipelineState:pass==7&&depthFormat(depth.pixelFormat)?r->pipelines->depth:r->pipelines->values[pass]];
   for(size_t i=0;i<shader.count;i++){const auto&b=shader.bindings[i];if(std::strcmp(b.kind,"texture")==0){auto it=textures.find(b.name);if(it==textures.end())throw std::runtime_error("Unknown XeGTAO texture binding");[encoder setTexture:it->second atIndex:b.index];}else if(std::strcmp(b.kind,"sampler")==0)[encoder setSamplerState:r->pipelines->point atIndex:b.index];else if(std::strcmp(b.name,"GTAOConstantBuffer")==0)[encoder setBytes:&gc length:sizeof(gc) atIndex:b.index];else if(std::strcmp(b.name,"MacLauncherScene")==0)[encoder setBytes:&sc length:sizeof(sc) atIndex:b.index];else throw std::runtime_error("Unknown XeGTAO constant binding");}
   [encoder dispatchThreadgroups:groups threadsPerThreadgroup:MTLSizeMake(shader.x,shader.y,shader.z)];[encoder endEncoding];
  };
  const auto full=MTLSizeMake((r->width+7)/8,(r->height+7)/8,1);dispatch(7,full,{{"g_srcRawDepth",(__bridge id<MTLTexture>)scene.depth},{"g_outWorkingDepthMIP0",r->textures.at("linearDepth")}});
  std::map<std::string,id<MTLTexture>>prefilter={{"g_srcRawDepth",r->textures.at("linearDepth")}};for(unsigned i=0;i<5;i++)prefilter["g_outWorkingDepthMIP"+std::to_string(i)]=r->textures.at("mip"+std::to_string(i));dispatch(0,MTLSizeMake((r->width+15)/16,(r->height+15)/16,1),prefilter);
  dispatch(1+s->quality,full,{{"g_srcWorkingDepth",r->textures.at("workingDepth")},{"g_outWorkingAOTerm",r->textures.at("ao0")},{"g_outWorkingEdges",r->textures.at("edges")}});
  unsigned current=0;for(unsigned i=0;i<std::max(1u,s->denoise);i++){unsigned next=1-current;dispatch(i+1==std::max(1u,s->denoise)?6:5,MTLSizeMake((r->width+15)/16,(r->height+7)/8,1),{{"g_srcWorkingAOTerm",r->textures.at("ao"+std::to_string(current))},{"g_srcWorkingEdges",r->textures.at("edges")},{"g_outFinalAOTerm",r->textures.at("ao"+std::to_string(next))}});current=next;}
  dispatch(8,full,{{"mlColor",r->textures.at("linearColor")},{"mlAO",r->textures.at("ao"+std::to_string(current))},{"mlOutput",r->textures.at("shadedColor")}});
  ColorConversion leave;leave.source=r->linear;leave.target=r->color;leave.frameId=f.frameId;leave.alphaSource=f.source;return r->outgoing->encode(f.commands,r->textures.at("shadedColor"),f.target,leave);
 }}catch(const std::exception&e){return {false,e.what(),false};}}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeXegtaoNode(const ShaderParameters&p){return std::make_shared<Xegtao>(p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkXegtaoNode(const std::shared_ptr<ShaderNode>&previous,const ShaderParameters&p){auto node=std::dynamic_pointer_cast<Xegtao>(previous);return node?node->fork(p):nullptr;}
void macfx::setXegtaoNodeColor(const std::shared_ptr<ShaderNode>&value,const ImageColorDescription&c){auto node=std::dynamic_pointer_cast<Xegtao>(value);if(node)node->setColor(c);}
