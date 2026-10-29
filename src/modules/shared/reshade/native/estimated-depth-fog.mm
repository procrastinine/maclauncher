// Copyright (c) MacLauncher contributors. MIT license.
// Original RetroFog shading: Copyright (c) 2017 Lucas Melo, MIT.
#include "estimated-depth-fog.hpp"
#include "depth-fog-shading.hpp"
#include "neural-depth.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include "gpu-completion.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace macfx {namespace {
struct Settings {
 float opacity=1,curveStart=0,curveEnd=1,center=0,quantize=255,red=0,green=0,blue=0;
 unsigned inputSize=252;bool curved=true,dither=true,automatic=false,hasColor=false;ImageColorDescription color;
};
Settings settings(const ShaderParameters&p){Settings s;for(const auto&[name,value]:p){
 if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("Estimated fog requires finite scalar parameters");const auto v=value[0];
 if(name=="InputSize"&&v>=14&&v<=4088&&std::floor(v)==v&&unsigned(v)%14==0)s.inputSize=unsigned(v);else if(name=="Opacity"&&v>=0&&v<=1)s.opacity=v;else if(name=="CurveStart"&&v>=0&&v<=1)s.curveStart=v;else if(name=="CurveEnd"&&v>=0&&v<=1)s.curveEnd=v;else if(name=="Center"&&v>=0&&v<=1)s.center=v;
 else if(name=="Quantize"&&v>=0&&v<=255)s.quantize=v;else if(name=="Red"&&v>=0&&v<=16)s.red=v;else if(name=="Green"&&v>=0&&v<=16)s.green=v;else if(name=="Blue"&&v>=0&&v<=16)s.blue=v;
 else if((name=="Curved"||name=="Dithering"||name=="AutoColor")&&(v==0||v==1)){if(name=="Curved")s.curved=v;else if(name=="Dithering")s.dither=v;else s.automatic=v;}
 else throw std::invalid_argument("Invalid estimated fog parameter");
 }if(s.curveStart>=s.curveEnd)throw std::invalid_argument("Fog curve start must be less than its end");return s;}
ImageColorDescription color(const ShaderFrame&f,const Settings&s){auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);if(f.opaqueDisplay)c.alpha=ColorAlpha::Opaque;return c;}
struct Options {float fog[4],style[4],color[4],reserved[4];};
struct RangeOptions {uint64_t stamp[4];float timing[4];uint32_t flags[4];};
constexpr size_t rangeHistoryBytes=48+64*16;
std::atomic<uint64_t>rangeIdentities{1};
const std::string shader=std::string(R"MSL(
#include <metal_stdlib>
using namespace metal;
struct Options {float4 fog,style,color,reserved;};
struct RangeOptions {ulong stamp[4];float4 timing;uint4 flags;};
struct RangeHistory {ulong content,epoch,revision,input;float lo,hi;uint magic,valid;float4 thumbnail[64];};
)MSL")+depthFogShading+R"MSL(
uint ordered(float v){uint b=as_type<uint>(v);return b&0x80000000u?~b:b^0x80000000u;}
float unordered(uint v){return as_type<float>(v&0x80000000u?v^0x80000000u:~v);}
kernel void estimate_range(texture2d<float>depth[[texture(0)]],device atomic_uint*range[[buffer(0)]],device const uint*valid[[buffer(1)]],uint2 p[[thread_position_in_grid]]){
 if(any(p>=uint2(depth.get_width(),depth.get_height()))||!valid[0])return;
 const float d=depth.read(p).r;if(!isfinite(d))return;
 atomic_fetch_min_explicit(range,ordered(d),memory_order_relaxed);atomic_fetch_max_explicit(range+1,ordered(d),memory_order_relaxed);atomic_fetch_add_explicit(range+2,1u,memory_order_relaxed);
}
kernel void estimate_histogram(texture2d<float>depth[[texture(0)]],device const uint*range[[buffer(0)]],device atomic_uint*bins[[buffer(1)]],device const uint*valid[[buffer(2)]],uint2 p[[thread_position_in_grid]]){
 if(any(p>=uint2(depth.get_width(),depth.get_height()))||!valid[0]||!range[2])return;
 const float d=depth.read(p).r;if(!isfinite(d)||range[1]<=range[0])return;
 const ulong width=(ulong(range[1])-range[0]+256ul)/256ul;
 atomic_fetch_add_explicit(bins+min(uint((ulong(ordered(d))-range[0])/width),255u),1u,memory_order_relaxed);
}
kernel void estimate_quantile_buckets(device uint*range[[buffer(0)]],device const uint*bins[[buffer(1)]],uint tid[[thread_position_in_grid]]){
 if(tid||!range[2]||range[1]<=range[0])return;uint count=0;for(uint i=0;i<256;++i)count+=bins[i];
 ulong width=(ulong(range[1])-range[0]+256ul)/256ul;uint cumulative=0;bool lower=false;
 for(uint i=0;i<256;++i){uint before=cumulative;cumulative+=bins[i];if(!lower&&float(cumulative)>=float(count)*.01f){range[4]=uint(ulong(range[0])+width*i);range[6]=before;lower=true;}if(float(cumulative)>=float(count)*.99f){range[7]=uint(ulong(range[0])+width*i);range[8]=before;break;}}range[5]=uint(width);
}
kernel void estimate_refine(texture2d<float>depth[[texture(0)]],device const uint*range[[buffer(0)]],device atomic_uint*bins[[buffer(1)]],device const uint*valid[[buffer(2)]],uint2 p[[thread_position_in_grid]]){
 if(any(p>=uint2(depth.get_width(),depth.get_height()))||!valid[0]||!range[2]||!range[5])return;float d=depth.read(p).r;if(!isfinite(d))return;ulong code=ordered(d),width=range[5];
 if(code>=range[4]&&code<ulong(range[4])+width)atomic_fetch_add_explicit(bins+256+min(uint((code-range[4])*256ul/width),255u),1u,memory_order_relaxed);
 if(code>=range[7]&&code<ulong(range[7])+width)atomic_fetch_add_explicit(bins+512+min(uint((code-range[7])*256ul/width),255u),1u,memory_order_relaxed);
}
kernel void estimate_stabilize(texture2d<float>source[[texture(0)]],device uint*range[[buffer(0)]],device const uint*bins[[buffer(1)]],device const RangeHistory&previous[[buffer(2)]],device RangeHistory&next[[buffer(3)]],constant RangeOptions&p[[buffer(4)]],device const uint*valid[[buffer(5)]],uint tid[[thread_position_in_grid]]){
 if(tid)return;
 // An unusable prediction preserves the accepted scalar range, never old
 // depth pixels. The current image still follows the color fallback below.
 next.content=previous.content;next.epoch=previous.epoch;next.revision=previous.revision;next.input=previous.input;next.lo=previous.lo;next.hi=previous.hi;next.magic=previous.magic;next.valid=previous.valid;
 for(uint i=0;i<64;++i)next.thumbnail[i]=previous.thumbnail[i];
 if(!valid[0]||!range[2])return;
 float lo=unordered(range[0]),hi=unordered(range[1]),span=hi-lo;if(!isfinite(span)||span<=max(1e-20f,max(abs(lo),abs(hi))*1e-7f)){range[2]=0;return;}
 uint count=0;for(uint i=0;i<256;++i)count+=bins[i];if(!count){range[2]=0;return;}
 uint cumulative=range[6],lower=0,upper=255;
 for(uint i=0;i<256;++i){cumulative+=bins[256+i];if(float(cumulative)>=float(count)*.01f){lower=i;break;}}
 cumulative=range[8];for(uint i=0;i<256;++i){cumulative+=bins[512+i];if(float(cumulative)>=float(count)*.99f){upper=i;break;}}
 lo=unordered(max(range[0],uint(ulong(range[4])+ulong(range[5])*lower/256ul)));
 hi=unordered(uint(min(ulong(range[1]),ulong(range[7])+(ulong(range[5])*(upper+1)+255ul)/256ul-1ul)));
 if(!isfinite(hi-lo)||hi<=lo){range[2]=0;return;}
 bool history=previous.magic==0x4452414eu&&previous.valid&&isfinite(previous.hi-previous.lo)&&previous.hi>previous.lo;
 bool reset=!history||p.timing.y!=0||previous.epoch!=p.stamp[1]||previous.revision!=p.stamp[2]||previous.input!=p.stamp[3]||p.stamp[0]<previous.content;
 float change=0;uint changed=0;
 for(uint i=0;i<64;++i){uint2 at=min(uint2(source.get_width()-1,source.get_height()-1),uint2((float2(i%8,i/8)+.5f)*float2(source.get_width(),source.get_height())/8.f));float3 rgb=source.read(at).rgb;rgb=select(float3(0),rgb,isfinite(rgb));float4 measured=float4(sign(rgb)*log2(1.f+abs(rgb)),0);next.thumbnail[i]=measured;if(history){float difference=dot(abs(measured.rgb-previous.thumbnail[i].rgb),float3(1.f/3.f));change+=difference;changed+=difference>.55f;}}
 // This is an image-derived discontinuity estimate, not renderer cut data.
 if(history&&change/64.f>.45f&&changed>48u)reset=true;
 if(history){float oldSpan=previous.hi-previous.lo,ratio=(hi-lo)/oldSpan;if(ratio>4.f||ratio<.25f||abs((hi+lo)-(previous.hi+previous.lo))>5.f*oldSpan)reset=true;}
 const bool duplicate=history&&p.stamp[0]==previous.content;
 if(!reset){if(!p.flags.x||duplicate){lo=previous.lo;hi=previous.hi;}else{float oldCenter=(previous.lo+previous.hi)*.5f,newCenter=(lo+hi)*.5f,oldSpan=previous.hi-previous.lo,newSpan=hi-lo;float center=mix(oldCenter,newCenter,1.f-exp(-4.f*p.timing.x));span=mix(oldSpan,newSpan,1.f-exp(-(newSpan>oldSpan?8.f:3.f)*p.timing.x));lo=center-span*.5f;hi=center+span*.5f;}}
 range[0]=ordered(lo);range[1]=ordered(hi);
 next.content=p.stamp[0];next.epoch=p.stamp[1];next.revision=p.stamp[2];next.input=p.stamp[3];next.lo=lo;next.hi=hi;next.valid=1;next.magic=0x4452414eu;
}
kernel void estimate_fog(texture2d<float>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],texture2d<float>depth[[texture(2)]],device const uint*range[[buffer(0)]],device const uint*valid[[buffer(1)]],constant Options&o[[buffer(2)]],constant uint&bottom[[buffer(3)]],uint2 p[[thread_position_in_grid]]){
 uint2 extent=uint2(target.get_width(),target.get_height());if(any(p>=extent))return;float4 c=source.read(p);
 if(!valid[0]||!range[2]){target.write(c,p);return;}
 const float lo=unordered(range[0]),hi=unordered(range[1]);float span=hi-lo;
 if(!isfinite(span)||span<=max(1e-20f,max(abs(lo),abs(hi))*1e-7f)){target.write(c,p);return;}
 uint2 logical=p;if(bottom)logical.y=extent.y-1-logical.y;float2 uv=(float2(logical)+.5f)/float2(extent);
 // Original infer_image expands raw prediction with bilinear align_corners=True.
 const float2 depthExtent=float2(depth.get_width(),depth.get_height());
 const float2 depthUV=(float2(logical)/max(float2(extent)-1.f,1.f)*(depthExtent-1.f)+.5f)/depthExtent;
 constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float inverse=depth.sample(s,depthUV,level(0)).r;
 if(isfinite(inverse)){float relativeFar=1-clamp((inverse-lo)/span,0.f,1.f);c.rgb=depth_fog_rgb(source,c.rgb,relativeFar,uv,logical,o);}
 target.write(c,p);
}
kernel void estimate_restore_invalid(texture2d<float>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],device const uint*valid[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
 if(valid[0]||any(p>=uint2(target.get_width(),target.get_height())))return;
 target.write(source.read(p),p);
}
)MSL";
struct Flight {
 GPUCompletionFence fence;__weak id<MTLCommandBuffer>commands=nil;std::atomic<bool>encoded{false};
 std::function<ShaderResult()>modelCompletion;uint64_t contentId=0,epoch=0,imageRevision=0;std::string inputIdentity,modelIdentity;
 unsigned historyIndex=0,inputSize=0;double timeMs=0;bool advance=false,displayMapped=false;
 ShaderResult complete()const{if(fence.failed())return {false,"Estimated fog commands failed"};if(!fence.completed())return {false,"Estimated fog is still processing",true};if(!encoded.load(std::memory_order_acquire))return {false,"Estimated fog did not encode a complete image"};return modelCompletion?modelCompletion():ShaderResult{false,"Estimated depth completion is unavailable"};}
};
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0,inputSize=0;FrameOrigin origin=FrameOrigin::TopLeft;bool opaque=false;MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,targetFormat=MTLPixelFormatInvalid;ImageColorDescription input,linear;
 id<MTLComputePipelineState>reduce,histogram,buckets,refine,stabilize,fog,restore;id<MTLTexture>source,target;std::vector<PooledImage>pooled;id<MTLBuffer>range,bins;std::array<id<MTLBuffer>,2>history;std::shared_ptr<ImageReservation>metadata;std::unique_ptr<ColorEncoder>enter,leave;std::shared_ptr<NeuralDepthEstimator>estimator;
 std::mutex encoding;std::shared_ptr<Flight>latest,accepted;std::string inputIdentity;uint64_t inputToken=0;
 bool matches(const ShaderFrame&f,const ImageColorDescription&c,unsigned size)const{return device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&sourceFormat==f.source.pixelFormat&&targetFormat==f.target.pixelFormat&&origin==f.origin&&opaque==f.opaqueDisplay&&inputSize==size&&sameImageColorDescription(input,c);}
};
ShaderResult historyReady(Resources&r){
 if(auto previous=r.latest){auto command=previous->commands;if(command&&!previous->fence.completed()&&!previous->fence.failed())return {false,"Estimated fog is waiting for its prior source submission",true};
  const auto completed=previous->complete();if(completed.busy&&previous->fence.completed())return completed;
  // Only the latest admitted complete real image can become history. GPU
  // callbacks record their own fence; they never publish an older range.
  if(completed.encoded&&previous->advance&&(!r.accepted||previous->epoch!=r.accepted->epoch||previous->contentId>r.accepted->contentId))r.accepted=previous;
 }return {true,{}};
}
dispatch_queue_t retirement(){static auto q=dispatch_queue_create("MacLauncher estimated fog retirement",DISPATCH_QUEUE_SERIAL);return q;}
std::shared_ptr<Resources>resources(){return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});});}
// Both working images are rewritten before they are read in each frame, so
// instances with the same extent and queue share one device copy. The range
// history stays with its instance.
id<MTLTexture>texture(Resources&r,const char*role,MTLPixelFormat f){auto p=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:f width:r.width height:r.height mipmapped:NO];p.storageMode=MTLStorageModePrivate;p.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;r.pooled.push_back(shareWorkingImage(r.device,p,role,r.queue));return r.pooled.back().texture();}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "Estimated fog requires separate images and retaining unsubmitted commands";if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.width!=f.target.width||f.source.height!=f.target.height||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D)return "Estimated fog requires matching resolved RGB images";if(f.source.framebufferOnly)return "Estimated fog requires readable source color";if(f.target.usage!=MTLTextureUsageUnknown&&!(f.target.usage&MTLTextureUsageShaderWrite))return "Estimated fog requires a writable working target";return {};}
class EstimatedFog final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;std::shared_ptr<Flight>lastCompletion;
public:
 const std::string modelPath;
 EstimatedFog(const ShaderParameters&p,std::string model):options(std::make_shared<Settings>(settings(p))),modelPath(std::move(model)){if(modelPath.empty()||modelPath.front()!='/')throw std::invalid_argument("Choose a prepared relative-depth model");}
 void setParameters(const ShaderParameters&p)override{auto next=std::make_shared<Settings>(settings(p));auto old=std::atomic_load(&options);next->color=old->color;next->hasColor=old->hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid estimated fog color metadata");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<EstimatedFog>fork(const ShaderParameters&p,const std::string&model){if(model!=modelPath)return {};auto next=std::make_shared<EstimatedFog>(p,model);next->state=std::atomic_load(&state);auto old=std::atomic_load(&options);auto s=std::make_shared<Settings>(*next->options);s->color=old->color;s->hasColor=old->hasColor;next->options=s;return next;}
 bool gpuTimingAvailable()const{auto r=std::atomic_load(&state);return r&&r->estimator->gpuTimingAvailable();}
 ShaderResult preparing()const{auto r=std::atomic_load(&state);return r?r->estimator->preparationStatus():ShaderResult{true,{}};}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto e=validate(f);!e.empty())return {false,e};auto setting=std::atomic_load(&options);const auto c=color(f,*setting);auto r=std::atomic_load(&state);
  if(!r||!r->matches(f,c,setting->inputSize)){
   r=resources();r->device=f.commands.device;r->queue=f.commands.commandQueue;r->width=f.source.width;r->height=f.source.height;r->inputSize=setting->inputSize;r->origin=f.origin;r->opaque=f.opaqueDisplay;r->sourceFormat=f.source.pixelFormat;r->targetFormat=f.target.pixelFormat;r->input=c;r->linear=c;r->linear.transfer=ColorTransfer::Linear;r->linear.range=ColorRange::Full;r->linear.alpha=ColorAlpha::Straight;
   NSError*error=nil;auto library=cachedMetalLibrary(r->device,shader,&error);const auto pipeline=[&](NSString*name){auto fn=[library newFunctionWithName:name];auto value=fn?[r->device newComputePipelineStateWithFunction:fn error:&error]:nil;if(!value)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile estimated fog");return value;};r->reduce=pipeline(@"estimate_range");r->histogram=pipeline(@"estimate_histogram");r->buckets=pipeline(@"estimate_quantile_buckets");r->refine=pipeline(@"estimate_refine");r->stabilize=pipeline(@"estimate_stabilize");r->fog=pipeline(@"estimate_fog");r->restore=pipeline(@"estimate_restore_invalid");
   const auto format=f.source.pixelFormat==MTLPixelFormatRGBA32Float?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float;r->source=texture(*r,"estimated-fog.source",format);r->target=texture(*r,"estimated-fog.target",format);r->metadata=reserveImageBytes(r->device,64+3072+2*rangeHistoryBytes,0,"estimated-depth-range-history");r->range=[r->device newBufferWithLength:64 options:MTLResourceStorageModePrivate];r->bins=[r->device newBufferWithLength:3072 options:MTLResourceStorageModePrivate];for(auto&buffer:r->history)buffer=[r->device newBufferWithLength:rangeHistoryBytes options:MTLResourceStorageModePrivate];if(!r->range||!r->bins||!r->history[0]||!r->history[1])throw std::runtime_error("Cannot allocate estimated fog range history");r->metadata->commit(r->range.allocatedSize+r->bins.allocatedSize+r->history[0].allocatedSize+r->history[1].allocatedSize);
   r->enter=std::make_unique<ColorEncoder>(r->device);r->leave=std::make_unique<ColorEncoder>(r->device);auto a=r->enter->prepare(format),b=r->leave->prepare(f.target.pixelFormat);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);
   r->estimator=std::make_shared<NeuralDepthEstimator>(r->device,NeuralDepthSpec{modelPath,setting->inputSize});std::atomic_store(&state,r);
  }
  return r->estimator->prepare(f,c,setting->inputSize);
 }}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult encode(const ShaderFrame&f)override{NeuralInputStamp stamp;stamp.contentId=stamp.observationId=f.frameId;stamp.epoch=1;stamp.imageRevision=0;stamp.inputIdentity="unstamped-native-image";return encodeStamped(f,stamp,false,false,nullptr);}
 ShaderResult encodeStamped(const ShaderFrame&f,const NeuralInputStamp&stamp,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion,NeuralGpuTimingTicket*timing=nullptr){try{@autoreleasepool{
  if(auto e=validate(f);!e.empty())return {false,e};auto setting=std::atomic_load(&options);const auto c=color(f,*setting);auto r=std::atomic_load(&state);if(!r||!r->matches(f,c,setting->inputSize))return {false,"Estimated fog resources are preparing",true};
  if(!stamp.contentId||!stamp.epoch||stamp.inputIdentity.empty()||!std::isfinite(f.timeMs)||!std::isfinite(f.frameTimeMs)||f.frameTimeMs<0)return {false,"Estimated fog requires exact content identity and finite timing"};
  std::unique_lock lock(r->encoding,std::try_to_lock);if(!lock.owns_lock())return {false,"Estimated fog is processing another image",true};
  if(auto ready=historyReady(*r);!ready.encoded)return ready;

  auto estimate=r->estimator->encode(f,stamp,redraw,displayMapped,setting->inputSize,timing!=nullptr);if(!estimate.result.encoded)return estimate.result;auto attachment=std::move(estimate.attachment);
  if(!attachment.texture||attachment.texture.pixelFormat!=MTLPixelFormatR32Float||attachment.texture.device!=r->device||!attachment.validity||attachment.validity.device!=r->device||attachment.validity.length<4||attachment.origin!=FrameOrigin::TopLeft||attachment.representation!=EstimatedDepthRepresentation::RelativeInverse||attachment.sourceWidth!=f.source.width||attachment.sourceHeight!=f.source.height||attachment.contentId!=stamp.contentId||attachment.epoch!=stamp.epoch||attachment.imageRevision!=stamp.imageRevision||attachment.inputIdentity!=stamp.inputIdentity||attachment.synthetic!=stamp.synthetic||attachment.modelIdentity.empty()||!attachment.completion)return {false,"The estimated depth attachment does not match its source image"};
  if(timing)*timing=attachment.gpuTiming;
  auto flight=std::make_shared<Flight>();flight->commands=f.commands;flight->fence.bind(f.commands);flight->contentId=stamp.contentId;flight->epoch=stamp.epoch;flight->imageRevision=stamp.imageRevision;flight->inputIdentity=stamp.inputIdentity;flight->modelIdentity=attachment.modelIdentity;flight->inputSize=setting->inputSize;flight->displayMapped=displayMapped;flight->timeMs=f.timeMs;
  flight->advance=!redraw&&!stamp.synthetic&&(!r->accepted||stamp.epoch!=r->accepted->epoch||stamp.contentId>r->accepted->contentId);flight->historyIndex=r->accepted?1-r->accepted->historyIndex:0;
  flight->modelCompletion=[completed=attachment.completion]{try{return completed();}catch(const std::exception&e){return ShaderResult{false,e.what()};}catch(...){return ShaderResult{false,"Estimated depth completion is unavailable"};}};
  r->latest=flight;std::atomic_store(&lastCompletion,flight);if(completion)*completion=[flight]{return flight->complete();};
  auto input=f.source,output=f.target;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);(void)r;(void)input;(void)output;(void)attachment;}];
  ColorConversion enter;enter.source=r->input;enter.target=r->linear;enter.frameId=f.frameId;auto result=r->enter->encode(f.commands,f.source,r->source,enter);if(!result.encoded)return result;
  auto reset=[f.commands blitCommandEncoder];if(!reset)throw std::runtime_error("Cannot reset estimated depth reduction");[reset fillBuffer:r->range range:NSMakeRange(0,4) value:255];[reset fillBuffer:r->range range:NSMakeRange(4,60) value:0];[reset fillBuffer:r->bins range:NSMakeRange(0,3072) value:0];if(!r->accepted){[reset fillBuffer:r->history[0] range:NSMakeRange(0,rangeHistoryBytes) value:0];[reset fillBuffer:r->history[1] range:NSMakeRange(0,rangeHistoryBytes) value:0];}[reset endEncoding];
  auto reduce=[f.commands computeCommandEncoder];if(!reduce)throw std::runtime_error("Cannot encode estimated depth normalization");[reduce setComputePipelineState:r->reduce];[reduce setTexture:attachment.texture atIndex:0];[reduce setBuffer:r->range offset:0 atIndex:0];[reduce setBuffer:attachment.validity offset:0 atIndex:1];[reduce dispatchThreads:MTLSizeMake(attachment.texture.width,attachment.texture.height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[reduce endEncoding];
  auto histogram=[f.commands computeCommandEncoder];if(!histogram)throw std::runtime_error("Cannot encode robust depth range");[histogram setComputePipelineState:r->histogram];[histogram setTexture:attachment.texture atIndex:0];[histogram setBuffer:r->range offset:0 atIndex:0];[histogram setBuffer:r->bins offset:0 atIndex:1];[histogram setBuffer:attachment.validity offset:0 atIndex:2];[histogram dispatchThreads:MTLSizeMake(attachment.texture.width,attachment.texture.height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[histogram endEncoding];
  auto buckets=[f.commands computeCommandEncoder];if(!buckets)throw std::runtime_error("Cannot encode depth quantile bounds");[buckets setComputePipelineState:r->buckets];[buckets setBuffer:r->range offset:0 atIndex:0];[buckets setBuffer:r->bins offset:0 atIndex:1];[buckets dispatchThreads:MTLSizeMake(1,1,1)threadsPerThreadgroup:MTLSizeMake(1,1,1)];[buckets endEncoding];
  auto refine=[f.commands computeCommandEncoder];if(!refine)throw std::runtime_error("Cannot refine robust depth range");[refine setComputePipelineState:r->refine];[refine setTexture:attachment.texture atIndex:0];[refine setBuffer:r->range offset:0 atIndex:0];[refine setBuffer:r->bins offset:0 atIndex:1];[refine setBuffer:attachment.validity offset:0 atIndex:2];[refine dispatchThreads:MTLSizeMake(attachment.texture.width,attachment.texture.height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[refine endEncoding];
  // The stabilized depth range continues across upstream control edits; a
  // changed input contract starts it anew.
  if(r->inputIdentity!=stamp.history()){r->inputIdentity=stamp.history();r->inputToken=rangeIdentities.fetch_add(1);}
  const auto accepted=r->accepted;const double delta=accepted?f.timeMs-accepted->timeMs:f.frameTimeMs;const bool resetRange=accepted&&(delta<0||delta>10000||accepted->displayMapped!=displayMapped||accepted->modelIdentity!=attachment.modelIdentity||accepted->inputSize!=setting->inputSize);
  RangeOptions rangeOptions{{stamp.contentId,stamp.epoch,stamp.imageRevision,r->inputToken},{float(std::clamp(delta>0?delta*.001:double(f.frameTimeMs)*.001,0.,.25)),float(resetRange),0,0},{uint32_t(flight->advance),0,0,0}};
  auto stabilize=[f.commands computeCommandEncoder];if(!stabilize)throw std::runtime_error("Cannot encode depth range stabilization");[stabilize setComputePipelineState:r->stabilize];[stabilize setTexture:r->source atIndex:0];[stabilize setBuffer:r->range offset:0 atIndex:0];[stabilize setBuffer:r->bins offset:0 atIndex:1];[stabilize setBuffer:r->history[accepted?accepted->historyIndex:1] offset:0 atIndex:2];[stabilize setBuffer:r->history[flight->historyIndex] offset:0 atIndex:3];[stabilize setBytes:&rangeOptions length:sizeof(rangeOptions) atIndex:4];[stabilize setBuffer:attachment.validity offset:0 atIndex:5];[stabilize dispatchThreads:MTLSizeMake(1,1,1)threadsPerThreadgroup:MTLSizeMake(1,1,1)];[stabilize endEncoding];
  Options o{{setting->opacity,1,setting->curveStart,setting->curveEnd},{setting->center,float(setting->curved),float(setting->dither),setting->quantize},{setting->red,setting->green,setting->blue,float(setting->automatic)},{0,0,0,0}};const uint32_t bottom=f.origin==FrameOrigin::BottomLeft;
  auto fog=[f.commands computeCommandEncoder];if(!fog)throw std::runtime_error("Cannot encode estimated fog");[fog setComputePipelineState:r->fog];[fog setTexture:r->source atIndex:0];[fog setTexture:r->target atIndex:1];[fog setTexture:attachment.texture atIndex:2];[fog setBuffer:r->range offset:0 atIndex:0];[fog setBuffer:attachment.validity offset:0 atIndex:1];[fog setBytes:&o length:sizeof(o) atIndex:2];[fog setBytes:&bottom length:sizeof(bottom) atIndex:3];[fog dispatchThreads:MTLSizeMake(r->width,r->height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[fog endEncoding];
  ColorConversion leave;leave.source=r->linear;leave.target=r->input;leave.alphaSource=f.source;leave.frameId=f.frameId;result=r->leave->encode(f.commands,r->target,f.target,leave);if(!result.encoded)return result;
  // An unavailable model must preserve current encoded pixels, including PQ
  // values which need not round-trip exactly through a linear working image.
  auto restore=[f.commands computeCommandEncoder];if(!restore)throw std::runtime_error("Cannot encode estimated fog source fallback");[restore setComputePipelineState:r->restore];[restore setTexture:f.source atIndex:0];[restore setTexture:f.target atIndex:1];[restore setBuffer:attachment.validity offset:0 atIndex:0];[restore dispatchThreads:MTLSizeMake(r->width,r->height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[restore endEncoding];
  flight->encoded.store(true,std::memory_order_release);return result;
 }}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult finish()const{auto c=std::atomic_load(&lastCompletion);return c?c->complete():ShaderResult{false,"No estimated depth was produced for this image"};}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeEstimatedDepthFogNode(const ShaderParameters&p,const std::string&model){return std::make_shared<EstimatedFog>(p,model);}
std::shared_ptr<macfx::ShaderNode>macfx::forkEstimatedDepthFogNode(const std::shared_ptr<ShaderNode>&n,const ShaderParameters&p,const std::string&model){auto d=std::dynamic_pointer_cast<EstimatedFog>(n);return d?d->fork(p,model):nullptr;}
void macfx::setEstimatedDepthFogNodeColor(const std::shared_ptr<ShaderNode>&n,const ImageColorDescription&c){if(auto d=std::dynamic_pointer_cast<EstimatedFog>(n))d->setColor(c);}
macfx::ShaderResult macfx::estimatedDepthFogPreparationStatus(const std::shared_ptr<ShaderNode>&n){auto d=std::dynamic_pointer_cast<EstimatedFog>(n);return d?d->preparing():ShaderResult{true,{}};}
bool macfx::estimatedDepthFogGpuTimingAvailable(const std::shared_ptr<ShaderNode>&n){auto d=std::dynamic_pointer_cast<EstimatedFog>(n);return d&&d->gpuTimingAvailable();}
macfx::ShaderResult macfx::encodeEstimatedDepthFogStamped(const std::shared_ptr<ShaderNode>&n,const ShaderFrame&f,const NeuralInputStamp&s,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion,NeuralGpuTimingTicket*timing){auto d=std::dynamic_pointer_cast<EstimatedFog>(n);return d?d->encodeStamped(f,s,redraw,displayMapped,completion,timing):n->encode(f);}
macfx::ShaderResult macfx::finishEstimatedDepthFogNode(const std::shared_ptr<ShaderNode>&n){auto d=std::dynamic_pointer_cast<EstimatedFog>(n);return d?d->finish():ShaderResult{true,{}};}
