// Copyright (c) MacLauncher contributors. MIT license.
// RetroFog curve/dither/color and Sketch depth-outline functions:
// Copyright (c) 2017 Lucas Melo, MIT; see depth-effects-MIT.txt.
#include "depth-effects.hpp"
#include "depth-fog-shading.hpp"
#include "native-scene-projection.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <algorithm>
#include <atomic>
#include <string>
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
namespace macfx {namespace {
struct Settings {
 float distance=1000,opacity=1,curveStart=0,curveEnd=1,center=0,quantize=255,red=0,green=0,blue=0,threshold=.9f,strength=1;
 bool curved=true,dither=true,automatic=false,hasColor=false;ImageColorDescription color;
};
Settings settings(const ShaderParameters&p,bool outline){Settings s;for(const auto&[name,value]:p){if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("Depth effects require finite scalar parameters");const auto v=value[0];
 if(outline){if(name=="Threshold"&&v>=0&&v<=1)s.threshold=v;else if(name=="Strength"&&v>=0&&v<=1)s.strength=v;else throw std::invalid_argument("Invalid depth outline parameter");}
 else if(name=="Distance"&&v>=.0001&&v<=1000000)s.distance=v;
 else if(name=="Opacity"&&v>=0&&v<=1)s.opacity=v;else if(name=="CurveStart"&&v>=0&&v<=1)s.curveStart=v;else if(name=="CurveEnd"&&v>=0&&v<=1)s.curveEnd=v;else if(name=="Center"&&v>=0&&v<=1)s.center=v;
 else if(name=="Quantize"&&v>=0&&v<=255)s.quantize=v;else if(name=="Red"&&v>=0&&v<=16)s.red=v;else if(name=="Green"&&v>=0&&v<=16)s.green=v;else if(name=="Blue"&&v>=0&&v<=16)s.blue=v;
 else if((name=="Curved"||name=="Dithering"||name=="AutoColor")&&(v==0||v==1)){if(name=="Curved")s.curved=v;else if(name=="Dithering")s.dither=v;else s.automatic=v;}
 else throw std::invalid_argument("Invalid depth fog parameter");}
 if(!outline&&s.curveStart>=s.curveEnd)throw std::invalid_argument("Fog curve start must be less than its end");return s;
}
bool depthFormat(MTLPixelFormat f){return f==MTLPixelFormatDepth16Unorm||f==MTLPixelFormatDepth32Float||f==MTLPixelFormatDepth24Unorm_Stencil8||f==MTLPixelFormatDepth32Float_Stencil8;}
ImageColorDescription color(const ShaderFrame&f,const Settings&s){auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);if(f.opaqueDisplay)c.alpha=ColorAlpha::Opaque;return c;}
struct Options {float fog[4],style[4],color[4],outline[4];};
const std::string shader=std::string(R"MSL(
#include <metal_stdlib>
using namespace metal;
struct Projection {float4 projection[4],inverse[4],jitter;uint4 roi;float4 clip;};
struct Options {float4 fog,style,color,outline;};
)MSL")+depthFogShading+R"MSL(
float depth_value(texture2d<float> image,uint2 p){return image.read(p).r;}
float depth_value(depth2d<float> image,uint2 p){return image.read(p);}
float scene_distance(ML_DEPTH depth,int2 pixel,constant Projection&p){
 int2 logical=clamp(pixel,int2(0),int2(p.roi.zw)-1),physical=logical;if(uint(p.jitter.w)&1)physical.y=int(p.roi.w)-1-physical.y;
 float z=depth_value(depth,uint2(physical)+p.roi.xy);if(!isfinite(z))return NAN;
 float2 uv=(float2(logical)+.5)/float2(p.roi.zw)-p.jitter.xy/float2(p.roi.zw);bool down=(uint(p.jitter.w)&2)!=0;
 float2 ndc=uv*float2(2,down?2:-2)+float2(-1,down?-1:1);float4 v=ndc.x*p.inverse[0]+ndc.y*p.inverse[1]+(z*p.clip.x+p.clip.y)*p.inverse[2]+p.inverse[3];
 if(abs(v.w)<1e-20)return 1e20;return min(abs(v.z/v.w),1e20);
}

kernel void depth_effect(texture2d<float> source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],ML_DEPTH depth[[texture(2)]],constant Projection&p[[buffer(0)]],constant Options&o[[buffer(1)]],uint2 physical[[thread_position_in_grid]]){
 if(any(physical>=p.roi.zw))return;uint2 logical=physical;if(uint(p.jitter.w)&1)logical.y=p.roi.w-1-logical.y;float2 uv=(float2(logical)+.5)/float2(p.roi.zw);
 float4 c=source.read(physical);float z=scene_distance(depth,int2(logical),p);if(!isfinite(z)){target.write(c,physical);return;}
 if(o.outline.w!=0){
  float l=scene_distance(depth,int2(logical)+int2(-1,0),p),r=scene_distance(depth,int2(logical)+int2(1,0),p),t=scene_distance(depth,int2(logical)+int2(0,-1),p),b=scene_distance(depth,int2(logical)+int2(0,1),p);
  float3 n=float3(abs(l-r)*.5*float(p.roi.z),abs(b-t)*.5*float(p.roi.w),z);float maximum=max(max(abs(n.x),abs(n.y)),abs(n.z));if(maximum>0)n/=maximum;float magnitude=length(n);float facing=magnitude>0&&isfinite(magnitude)?n.z/magnitude:1;float outline=step(o.outline.x,facing);c.rgb*=mix(1.f,outline,o.outline.y);
 }else{
  c.rgb=depth_fog_rgb(source,c.rgb,z/o.fog.y,uv,logical,o);
 }
 target.write(c,physical);
}
)MSL";
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0;MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,targetFormat=MTLPixelFormatInvalid;bool depth=false;ImageColorDescription input,linear;
 id<MTLComputePipelineState>pipeline;id<MTLTexture>source,target;std::vector<PooledImage>pooled;std::unique_ptr<ColorEncoder>enter,leave;
 bool matches(const ShaderFrame&f,const ImageColorDescription&c,bool d)const{return device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&sourceFormat==f.source.pixelFormat&&targetFormat==f.target.pixelFormat&&depth==d&&sameImageColorDescription(input,c);}
};
dispatch_queue_t retirement(){static auto q=dispatch_queue_create("MacLauncher depth-effect retirement",DISPATCH_QUEUE_SERIAL);return q;}
std::shared_ptr<Resources>resources(){return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});});}
// Both working images are rewritten before they are read in each frame, so
// instances with the same extent and queue share one device copy.
id<MTLTexture>texture(Resources&r,const char*role,MTLPixelFormat f){auto p=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:f width:r.width height:r.height mipmapped:NO];p.storageMode=MTLStorageModePrivate;p.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;r.pooled.push_back(shareWorkingImage(r.device,p,role,r.queue));return r.pooled.back().texture();}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "Depth effects require separate images and retaining unsubmitted commands";if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.width!=f.target.width||f.source.height!=f.target.height||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D)return "Depth effects require matching resolved RGB images";if(f.source.framebufferOnly)return "Depth effects require readable source color";return {};}
class DepthEffect final:public ShaderNode,public NativeSceneShader {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;
public:
 const bool outline;
 DepthEffect(bool mode,const ShaderParameters&p):options(std::make_shared<Settings>(settings(p,mode))),outline(mode){}
 void setParameters(const ShaderParameters&p)override{auto next=std::make_shared<Settings>(settings(p,outline));auto old=std::atomic_load(&options);next->color=old->color;next->hasColor=old->hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid depth-effect color metadata");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<DepthEffect>fork(const ShaderParameters&p){auto next=std::make_shared<DepthEffect>(outline,p);next->state=std::atomic_load(&state);auto old=std::atomic_load(&options);auto s=std::make_shared<Settings>(*next->options);s->color=old->color;s->hasColor=old->hasColor;next->options=s;return next;}
 std::string sceneInputReason(const ShaderFrame&f,const RSTemporalFrame*s,const std::optional<RSSceneMatrices>&m)const override{if(auto e=validate(f);!e.empty())return e;return sceneProjectionReason(f,s,m);}
 ShaderResult prepare(const ShaderFrame&)override{return {false,"Depth effects need matched renderer depth and projection"};}
 ShaderResult encode(const ShaderFrame&)override{return {false,"Depth effects need matched renderer depth and projection"};}
 ShaderResult prepareScene(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{
  if(auto e=sceneInputReason(f,&s,m);!e.empty())return {false,e};(void)sceneProjectionConstants(f,s,*m);auto setting=std::atomic_load(&options);const auto c=color(f,*setting);const bool d=depthFormat(((__bridge id<MTLTexture>)s.depth).pixelFormat);auto previous=std::atomic_load(&state);if(previous&&previous->matches(f,c,d))return {true,{}};
  auto r=resources();r->device=f.commands.device;r->queue=f.commands.commandQueue;r->width=f.source.width;r->height=f.source.height;r->sourceFormat=f.source.pixelFormat;r->targetFormat=f.target.pixelFormat;r->input=c;r->linear=c;r->linear.transfer=ColorTransfer::Linear;r->linear.range=ColorRange::Full;r->linear.alpha=ColorAlpha::Straight;r->depth=d;
  const auto code=std::string("#define ML_DEPTH ")+(d?"depth2d<float>\n":"texture2d<float>\n")+shader;NSError*error=nil;auto library=cachedMetalLibrary(r->device,code,&error);auto fn=[library newFunctionWithName:@"depth_effect"];if(fn)r->pipeline=[r->device newComputePipelineStateWithFunction:fn error:&error];if(!r->pipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile the depth-effect kernel");
  const auto format=f.source.pixelFormat==MTLPixelFormatRGBA32Float?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float;r->source=texture(*r,"depth-effect.source",format);r->target=texture(*r,"depth-effect.target",format);r->enter=std::make_unique<ColorEncoder>(r->device);r->leave=std::make_unique<ColorEncoder>(r->device);auto a=r->enter->prepare(format),b=r->leave->prepare(f.target.pixelFormat);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);std::atomic_store(&state,r);return {true,{}};
 }}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult encodeScene(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m)override{try{@autoreleasepool{
  if(auto e=sceneInputReason(f,&s,m);!e.empty())return {false,e};auto setting=std::atomic_load(&options);auto c=color(f,*setting);auto r=std::atomic_load(&state);if(!r||!r->matches(f,c,depthFormat(((__bridge id<MTLTexture>)s.depth).pixelFormat)))return {false,"Depth-effect resources are preparing for this frame",true};
  const auto projection=sceneProjectionConstants(f,s,*m);Options o{{setting->opacity,setting->distance,setting->curveStart,setting->curveEnd},{setting->center,float(setting->curved),float(setting->dither),setting->quantize},{setting->red,setting->green,setting->blue,float(setting->automatic)},{setting->threshold,setting->strength,0,float(outline)}};
  auto input=f.source,output=f.target,depth=(__bridge id<MTLTexture>)s.depth;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)r;(void)input;(void)output;(void)depth;}];
  ColorConversion enter;enter.source=r->input;enter.target=r->linear;enter.frameId=f.frameId;auto result=r->enter->encode(f.commands,f.source,r->source,enter);if(!result.encoded)return result;
  auto encoder=[f.commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode depth processing");[encoder setComputePipelineState:r->pipeline];[encoder setTexture:r->source atIndex:0];[encoder setTexture:r->target atIndex:1];[encoder setTexture:(__bridge id<MTLTexture>)s.depth atIndex:2];[encoder setBytes:&projection length:sizeof(projection) atIndex:0];[encoder setBytes:&o length:sizeof(o) atIndex:1];const unsigned x=std::min(8u,unsigned(r->pipeline.maxTotalThreadsPerThreadgroup)),y=std::min(8u,unsigned(r->pipeline.maxTotalThreadsPerThreadgroup)/x);[encoder dispatchThreads:MTLSizeMake(r->width,r->height,1) threadsPerThreadgroup:MTLSizeMake(x,y,1)];[encoder endEncoding];
  ColorConversion leave;leave.source=r->linear;leave.target=r->input;leave.alphaSource=f.source;leave.frameId=f.frameId;return r->leave->encode(f.commands,r->target,f.target,leave);
 }}catch(const std::exception&e){return {false,e.what()};}}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeDepthFogNode(const ShaderParameters&p){return std::make_shared<DepthEffect>(false,p);}
std::shared_ptr<macfx::ShaderNode>macfx::makeDepthOutlinesNode(const ShaderParameters&p){return std::make_shared<DepthEffect>(true,p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkDepthFogNode(const std::shared_ptr<ShaderNode>&n,const ShaderParameters&p){auto d=std::dynamic_pointer_cast<DepthEffect>(n);return d&&!d->outline?d->fork(p):nullptr;}
std::shared_ptr<macfx::ShaderNode>macfx::forkDepthOutlinesNode(const std::shared_ptr<ShaderNode>&n,const ShaderParameters&p){auto d=std::dynamic_pointer_cast<DepthEffect>(n);return d&&d->outline?d->fork(p):nullptr;}
void macfx::setDepthFogNodeColor(const std::shared_ptr<ShaderNode>&n,const ImageColorDescription&c){auto d=std::dynamic_pointer_cast<DepthEffect>(n);if(d&&!d->outline)d->setColor(c);}
void macfx::setDepthOutlinesNodeColor(const std::shared_ptr<ShaderNode>&n,const ImageColorDescription&c){auto d=std::dynamic_pointer_cast<DepthEffect>(n);if(d&&d->outline)d->setColor(c);}
