// Copyright (c) MacLauncher contributors. MIT license.
// Owned logarithmic histogram, percentile metering and GPU exposure history.
#include "histogram-exposure.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "color-formats.hpp"
#include "image-admission.hpp"
#include "gpu-completion.hpp"
#include "metal-library-cache.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <vector>
namespace macfx {namespace {
struct Settings {
 float key=.18f,low=.1f,high=.9f,minEV=-8,maxEV=8,compensation=0,speed=3,cut=4;
 bool hasColor=false;ImageColorDescription color;
 std::array<float,8>values()const{return {key,low,high,minEV,maxEV,compensation,speed,cut};}
};
Settings settings(const ShaderParameters&p){Settings s;for(const auto&[name,value]:p){if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("Histogram exposure controls require finite scalar values");const float v=value[0];if(name=="KeyGray"&&v>=.001f&&v<=1)s.key=v;else if(name=="LowPercentile"&&v>=0&&v<=.99f)s.low=v;else if(name=="HighPercentile"&&v>=.01f&&v<=1)s.high=v;else if(name=="MinEV"&&v>=-24&&v<=24)s.minEV=v;else if(name=="MaxEV"&&v>=-24&&v<=24)s.maxEV=v;else if(name=="Compensation"&&v>=-24&&v<=24)s.compensation=v;else if(name=="AdaptationSpeed"&&v>=0&&v<=60)s.speed=v;else if(name=="CutThreshold"&&v>=0&&v<=16)s.cut=v;else throw std::invalid_argument("Unknown or out-of-range histogram exposure control: "+name);}
 if(s.low>=s.high||s.minEV>s.maxEV)throw std::invalid_argument("Histogram exposure requires ordered percentiles and EV limits");return s;}
struct Parameters {uint32_t geometry[4];float meter[4],limits[4],timing[4];uint64_t stamp[4],options[2];};
static_assert(sizeof(Parameters)==112);
constexpr uint32_t historyMagic=0x48455850;
const char*shader=R"METAL(
#include <metal_stdlib>
using namespace metal;
struct Parameters{uint4 geometry;float4 meter,limits,timing;ulong stamp[4],options[2];};
struct History{ulong content,epoch,revision,input,options,exact;float ev,target,mean;uint count,magic,reserved;uint bins[256];};
kernel void exposure_histogram(texture2d<float,access::read>source[[texture(0)]],device atomic_uint*bins[[buffer(0)]],constant Parameters&p[[buffer(1)]],constant float4&weights[[buffer(2)]],uint2 point[[thread_position_in_grid]],uint tid[[thread_index_in_threadgroup]]){
 threadgroup atomic_uint local[256];atomic_store_explicit(local+tid,0u,memory_order_relaxed);threadgroup_barrier(mem_flags::mem_threadgroup);
 if(all(point<p.geometry.xy)){float4 c=source.read(point);if(all(isfinite(c))&&(p.geometry.z||c.a>0)){float y=dot(c.rgb,weights.xyz);if(isfinite(y)){float logY=clamp(log2(max(y,exp2(-16.0f))),-16.0f,16.0f);uint bin=min(uint((logY+16.0f)*8.0f),255u);atomic_fetch_add_explicit(local+bin,1u,memory_order_relaxed);}}}
 threadgroup_barrier(mem_flags::mem_threadgroup);uint n=atomic_load_explicit(local+tid,memory_order_relaxed);if(n)atomic_fetch_add_explicit(bins+tid,n,memory_order_relaxed);
}
kernel void exposure_reduce(device const uint*bins[[buffer(0)]],device History&h[[buffer(1)]],constant Parameters&p[[buffer(2)]],uint tid[[thread_position_in_grid]]){
 if(tid||!p.geometry.w)return;uint count=0;for(uint i=0;i<256;++i)count+=bins[i];if(!count)return;
 bool valid=h.magic==0x48455850u;bool same=valid&&h.content==p.stamp[0]&&h.epoch==p.stamp[1]&&h.revision==p.stamp[2]&&h.input==p.stamp[3]&&h.options==p.options[0]&&h.exact==p.options[1];if(same)return;
 float lower=float(count)*p.meter.y,upper=float(count)*p.meter.z,cumulative=0,weighted=0,selected=0,divergence=0;
 for(uint i=0;i<256;++i){float n=float(bins[i]),included=max(0.0f,min(cumulative+n,upper)-max(cumulative,lower));weighted+=included*(-16.0f+(float(i)+.5f)/8.0f);selected+=included;cumulative+=n;if(valid&&h.count)divergence+=abs(n/float(count)-float(h.bins[i])/float(h.count));}
 if(selected<=0)return;float mean=weighted/selected,target=clamp(log2(p.meter.x)-mean+p.meter.w,p.limits.x,p.limits.y);
 bool reset=!valid||p.timing.y!=0||h.epoch!=p.stamp[1]||h.revision!=p.stamp[2]||h.input!=p.stamp[3]||h.options!=p.options[0]||p.stamp[0]<=h.content;
 // This is explicitly an image-derived lighting/cut estimate. It does not
 // claim an authoritative renderer camera-cut signal.
 if(valid&&p.limits.w>0&&.5f*divergence>.85f&&abs(mean-h.mean)>=p.limits.w)reset=true;
 float mixWeight=p.limits.z==0?1.0f:1.0f-exp(-p.limits.z*p.timing.x);float ev=reset?target:mix(h.ev,target,mixWeight);
 h.content=p.stamp[0];h.epoch=p.stamp[1];h.revision=p.stamp[2];h.input=p.stamp[3];h.options=p.options[0];h.exact=p.options[1];h.ev=ev;h.target=target;h.mean=mean;h.count=count;h.magic=0x48455850u;for(uint i=0;i<256;++i)h.bins[i]=bins[i];
}
kernel void exposure_apply(texture2d<float,access::read>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],device const History&h[[buffer(0)]],constant Parameters&p[[buffer(1)]],uint2 point[[thread_position_in_grid]]){
 if(any(point>=p.geometry.xy))return;float4 c=source.read(point);if(all(isfinite(c))&&(p.geometry.z||c.a>0)){float gain=h.magic==0x48455850u?exp2(h.ev):1.0f;c.rgb*=gain;}target.write(c,point);
}
kernel void exposure_restore(texture2d<float,access::read>original[[texture(0)]],texture2d<float,access::read>linear[[texture(1)]],texture2d<float,access::read_write>encoded[[texture(2)]],device const History&h[[buffer(0)]],constant Parameters&p[[buffer(1)]],uint2 point[[thread_position_in_grid]]){
 if(any(point>=p.geometry.xy))return;float4 a=original.read(point),b=encoded.read(point),c=linear.read(point);if(h.magic!=0x48455850u||h.ev==0||any(!isfinite(c))||any(!isfinite(b))||(!p.geometry.z&&a.a<=0))b=a;else b.a=a.a;encoded.write(b,point);
}
)METAL";
template<class T>std::shared_ptr<T>retired(){return std::shared_ptr<T>(new T,[](T*p){dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),p,[](void*p){delete static_cast<T*>(p);});});}
MTLPixelFormat plain(MTLPixelFormat f){return f==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:f==MTLPixelFormatRGBA8Unorm_sRGB?MTLPixelFormatRGBA8Unorm:f;}
id<MTLTexture>image(id<MTLDevice>d,unsigned w,unsigned h,MTLPixelFormat format){auto x=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];x.storageMode=MTLStorageModePrivate;x.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;return newAdmittedTexture(d,x,0,"histogram-exposure-images");}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.commands.retainedReferences||f.commands.status>=MTLCommandBufferStatusCommitted||!f.source||!f.target||f.source==f.target||f.source.device!=f.commands.device||f.target.device!=f.commands.device||!imageRGBFormat(f.source.pixelFormat)||!imageRGBFormat(f.target.pixelFormat)||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.framebufferOnly||f.target.framebufferOnly||f.source.width!=f.target.width||f.source.height!=f.target.height||!f.source.width||!f.source.height||f.source.width>16384||f.source.height>16384||!std::isfinite(f.timeMs)||!std::isfinite(f.frameTimeMs)||f.frameTimeMs<0)return "Histogram exposure requires matched readable RGB images and unsubmitted retained Metal commands";if(plain(f.source.pixelFormat)!=f.source.pixelFormat&&!(f.source.usage&MTLTextureUsagePixelFormatView))return "An sRGB histogram source requires its compatible encoded-pixel view";return {};}
std::atomic<uint64_t>identities{1};
struct Flight;
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;id<MTLTexture>linear,graded,encoded;
 id<MTLComputePipelineState>histogram,reduce,apply,restore;
 id<MTLBuffer>bins,history;std::shared_ptr<ImageReservation>admission;std::vector<PooledImage>pooled;
 std::unique_ptr<ColorEncoder>enter,leave;ImageColorDescription input,working;
 unsigned width=0,height=0;MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,targetFormat=MTLPixelFormatInvalid;FrameOrigin origin=FrameOrigin::TopLeft;bool opaque=false;
 // inputToken follows the input contract (history reset); exactToken follows
 // the exact input, so changed upstream controls meter the same content again.
 std::mutex encoding;std::string inputIdentity,exactIdentity;std::array<float,8>parameters{};uint64_t inputToken=0,optionsToken=0,exactToken=0;
 std::weak_ptr<Flight>latest;
 bool matches(const ShaderFrame&f,const ImageColorDescription&c)const{return device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&sourceFormat==f.source.pixelFormat&&targetFormat==f.target.pixelFormat&&origin==f.origin&&opaque==f.opaqueDisplay&&sameImageColorDescription(input,c);}
};
// The linear and graded images are rewritten before they are read in each
// frame, so instances with the same extent and queue share one device copy.
// The encoded image is the cached result of the latest exact input and stays
// with its instance.
id<MTLTexture>working(Resources&r,const char*role,MTLPixelFormat format){auto x=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:r.width height:r.height mipmapped:NO];x.storageMode=MTLStorageModePrivate;x.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;r.pooled.push_back(shareWorkingImage(r.device,x,role,r.queue));return r.pooled.back().texture();}
struct Flight {
 std::atomic<bool>encoded{false};GPUCompletionFence fence;__weak id<MTLCommandBuffer>commands=nil;std::shared_ptr<Resources>resources;
 NeuralInputStamp stamp;std::array<float,8>parameters;double timeMs=0;FrameOrigin origin=FrameOrigin::TopLeft;bool displayMapped=false;
 // The stamp's identity views belong to the encoding execution's row, which a
 // reused node outlives; the flight keeps its own copy.
 std::string identity;void keep(const NeuralInputStamp&s){stamp=s;identity.assign(s.inputIdentity);stamp.inputIdentity=identity;stamp.historyIdentity={};}
 bool matches(const NeuralInputStamp&s,const Settings&o,FrameOrigin org,bool mapped)const{return stamp.contentId==s.contentId&&stamp.epoch==s.epoch&&stamp.imageRevision==s.imageRevision&&stamp.inputIdentity==s.inputIdentity&&stamp.synthetic==s.synthetic&&parameters==o.values()&&origin==org&&displayMapped==mapped;}
 ShaderResult complete()const{return fence.failed()?ShaderResult{false,"Histogram exposure commands failed"}:fence.completed()?encoded.load(std::memory_order_acquire)?ShaderResult{true,{}}:ShaderResult{false,"Histogram exposure did not encode a complete image"}:ShaderResult{false,"Histogram exposure is still processing",true};}
};
class Histogram final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;std::shared_ptr<Flight>last;std::mutex preparation;
 ImageColorDescription color(const ShaderFrame&f,const Settings&s)const{auto c=s.hasColor?s.color:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::LegacySDR);if(!c.valid())throw std::invalid_argument("Histogram exposure requires valid source color metadata");return c;}
public:
 explicit Histogram(const ShaderParameters&p):options(std::make_shared<Settings>(settings(p))){}
 void setParameters(const ShaderParameters&p)override{auto next=settings(p);auto old=std::atomic_load(&options);next.hasColor=old->hasColor;next.color=old->color;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Histogram exposure requires valid source color metadata");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->hasColor=true;next->color=c;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<ShaderNode>fork(const ShaderParameters&p){auto next=std::make_shared<Histogram>(p);auto old=std::atomic_load(&options);if(old->hasColor)next->setColor(old->color);next->state=std::atomic_load(&state);next->last=std::atomic_load(&last);return next;}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{if(auto problem=validate(f);!problem.empty())return {false,problem};std::lock_guard guard(preparation);const auto o=std::atomic_load(&options);const auto c=color(f,*o);auto r=std::atomic_load(&state);if(r&&r->matches(f,c))return {true,{}};
  r=retired<Resources>();r->device=f.commands.device;r->queue=f.commands.commandQueue;r->width=f.source.width;r->height=f.source.height;r->sourceFormat=f.source.pixelFormat;r->targetFormat=f.target.pixelFormat;r->origin=f.origin;r->opaque=f.opaqueDisplay;r->input=c;r->working=c;r->working.transfer=ColorTransfer::Linear;r->working.range=ColorRange::Full;r->working.alpha=ColorAlpha::Straight;
  NSError*error=nil;auto library=cachedMetalLibrary(r->device,shader,&error);auto pipeline=[&](NSString*name){auto fn=[library newFunctionWithName:name];auto value=fn?[r->device newComputePipelineStateWithFunction:fn error:&error]:nil;if(!value)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile histogram exposure");return value;};r->histogram=pipeline(@"exposure_histogram");if(r->histogram.maxTotalThreadsPerThreadgroup<256)throw std::runtime_error("Histogram exposure requires a 256-thread compute group");r->reduce=pipeline(@"exposure_reduce");r->apply=pipeline(@"exposure_apply");r->restore=pipeline(@"exposure_restore");r->linear=working(*r,"histogram-exposure.linear",MTLPixelFormatRGBA32Float);r->graded=working(*r,"histogram-exposure.graded",MTLPixelFormatRGBA32Float);r->encoded=image(r->device,r->width,r->height,plain(r->targetFormat));
  r->admission=reserveImageBytes(r->device,1024+1280,0,"histogram-exposure-metadata");r->bins=[r->device newBufferWithLength:1024 options:MTLResourceStorageModePrivate];r->history=[r->device newBufferWithLength:1280 options:MTLResourceStorageModeShared];if(!r->bins||!r->history)throw std::runtime_error("Cannot allocate histogram exposure metadata");std::memset(r->history.contents,0,r->history.length);r->admission->commit(r->bins.allocatedSize+r->history.allocatedSize);
  r->enter=std::make_unique<ColorEncoder>(r->device);r->leave=std::make_unique<ColorEncoder>(r->device);const auto a=r->enter->prepare(MTLPixelFormatRGBA32Float),b=r->leave->prepare(plain(r->targetFormat));if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);std::atomic_store(&state,r);std::atomic_store(&last,std::shared_ptr<Flight>{});return {true,{}};
 }}catch(const ImageBudgetExceeded&e){throw;}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult encode(const ShaderFrame&f)override{NeuralInputStamp stamp;stamp.contentId=stamp.observationId=f.frameId;stamp.epoch=1;stamp.inputIdentity="unstamped-histogram-exposure";return encodeStamped(f,stamp,false,false,nullptr);}
 ShaderResult encodeStamped(const ShaderFrame&f,const NeuralInputStamp&stamp,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion){try{@autoreleasepool{
  if(auto problem=validate(f);!problem.empty())return {false,problem};if(!stamp.contentId||!stamp.epoch||stamp.inputIdentity.empty())return {false,"Histogram exposure requires exact content identity"};const auto o=std::atomic_load(&options);const auto c=color(f,*o);auto r=std::atomic_load(&state);if(!r||!r->matches(f,c))return {false,"Histogram exposure resources are preparing",true};std::unique_lock lock(r->encoding,std::try_to_lock);if(!lock.owns_lock())return {false,"Histogram exposure is processing another image",true};auto previous=r->latest.lock();bool reset=false;
  if(previous&&previous->resources==r){auto commands=previous->commands;if(commands&&commands!=f.commands&&commands.status<MTLCommandBufferStatusCommitted)return {false,"Histogram exposure is waiting for its prior source submission",true};if(previous->matches(stamp,*o,f.origin,displayMapped)){if(previous->fence.completed()&&previous->encoded.load(std::memory_order_acquire)){auto copy=[f.commands blitCommandEncoder];if(!copy)return {false,"Cannot copy the cached exposure image"};[copy copyFromTexture:r->encoded sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(r->width,r->height,1) toTexture:f.target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];auto cached=std::make_shared<Flight>();cached->resources=r;cached->keep(stamp);cached->parameters=o->values();cached->timeMs=previous->timeMs;cached->origin=f.origin;cached->displayMapped=displayMapped;cached->commands=f.commands;cached->fence.bind(f.commands);cached->encoded.store(true,std::memory_order_release);std::atomic_store(&last,cached);r->latest=cached;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){cached->fence.observe(commands);}];if(completion)*completion=[cached]{return cached->complete();};return {true,{}};}if(commands&&!previous->fence.failed()&&!previous->fence.completed())return {false,"Histogram exposure is still processing this exact image",true};}reset=previous->fence.failed()||previous->fence.completed()&&!previous->encoded.load(std::memory_order_acquire)||!commands&&!previous->fence.completed()||f.timeMs<previous->timeMs;
  }
  // Exposure adaptation continues across upstream control edits; a changed
  // input contract starts it anew.
  if(r->inputIdentity!=stamp.history()){r->inputIdentity=stamp.history();r->inputToken=identities.fetch_add(1);}if(r->exactIdentity!=stamp.inputIdentity){r->exactIdentity=stamp.inputIdentity;r->exactToken=identities.fetch_add(1);}if(r->parameters!=o->values()||!r->optionsToken){r->parameters=o->values();r->optionsToken=identities.fetch_add(1);}
  const double delta=previous&&previous->resources==r?f.timeMs-previous->timeMs:f.frameTimeMs;reset|=delta>10000;const float dt=float(std::clamp(delta>0?delta*.001:double(f.frameTimeMs)*.001,0.,1.));Parameters p{{r->width,r->height,uint32_t(f.opaqueDisplay||c.alpha==ColorAlpha::Opaque),uint32_t(!stamp.synthetic)},{o->key,o->low,o->high,o->compensation},{o->minEV,o->maxEV,o->speed,o->cut},{dt,float(reset),0,0},{stamp.contentId,stamp.epoch,stamp.imageRevision,r->inputToken},{r->optionsToken,r->exactToken}};
  auto flight=std::make_shared<Flight>();flight->resources=r;flight->keep(stamp);flight->parameters=o->values();flight->timeMs=stamp.synthetic&&previous?previous->timeMs:f.timeMs;flight->origin=f.origin;flight->displayMapped=displayMapped;flight->commands=f.commands;flight->fence.bind(f.commands);std::atomic_store(&last,flight);r->latest=flight;auto source=f.source,target=f.target;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);(void)source;(void)target;}];
  ColorConversion enter;enter.source=c;if(f.opaqueDisplay)enter.source.alpha=ColorAlpha::Opaque;enter.target=r->working;enter.frameId=f.frameId;auto result=r->enter->encode(f.commands,f.source,r->linear,enter);if(!result.encoded)return result;
  const auto dispatch=[&](id<MTLComputeCommandEncoder>e){[e dispatchThreads:MTLSizeMake(r->width,r->height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[e endEncoding];};
  if(!stamp.synthetic){auto clear=[f.commands blitCommandEncoder];if(!clear)return {false,"Cannot reset GPU histogram"};[clear fillBuffer:r->bins range:NSMakeRange(0,1024) value:0];[clear endEncoding];std::array<float,4>weights=c.primaries==ColorPrimaries::BT2020?std::array<float,4>{.26270021f,.67799807f,.05930172f,0}:c.primaries==ColorPrimaries::DisplayP3?std::array<float,4>{.22897456f,.69173852f,.07928691f,0}:std::array<float,4>{.21263901f,.71516868f,.07219232f,0};auto histogram=[f.commands computeCommandEncoder];if(!histogram)return {false,"Cannot encode GPU histogram"};[histogram setComputePipelineState:r->histogram];[histogram setTexture:r->linear atIndex:0];[histogram setBuffer:r->bins offset:0 atIndex:0];[histogram setBytes:&p length:sizeof(p) atIndex:1];[histogram setBytes:weights.data() length:16 atIndex:2];[histogram dispatchThreadgroups:MTLSizeMake((r->width+15)/16,(r->height+15)/16,1)threadsPerThreadgroup:MTLSizeMake(16,16,1)];[histogram endEncoding];auto reduce=[f.commands computeCommandEncoder];if(!reduce)return {false,"Cannot encode histogram percentile metering"};[reduce setComputePipelineState:r->reduce];[reduce setBuffer:r->bins offset:0 atIndex:0];[reduce setBuffer:r->history offset:0 atIndex:1];[reduce setBytes:&p length:sizeof(p) atIndex:2];[reduce dispatchThreads:MTLSizeMake(1,1,1)threadsPerThreadgroup:MTLSizeMake(1,1,1)];[reduce endEncoding];}
  auto apply=[f.commands computeCommandEncoder];if(!apply)return {false,"Cannot encode exposure adjustment"};[apply setComputePipelineState:r->apply];[apply setTexture:r->linear atIndex:0];[apply setTexture:r->graded atIndex:1];[apply setBuffer:r->history offset:0 atIndex:0];[apply setBytes:&p length:sizeof(p) atIndex:1];dispatch(apply);
  ColorConversion leave;leave.source=r->working;leave.target=c;if(f.opaqueDisplay||leave.target.alpha==ColorAlpha::Opaque)leave.target.alpha=ColorAlpha::Straight;leave.alphaSource=f.source;leave.frameId=f.frameId;result=r->leave->encode(f.commands,r->graded,r->encoded,leave);if(!result.encoded)return result;
  auto encodedSource=f.source;if(plain(f.source.pixelFormat)!=f.source.pixelFormat){encodedSource=[f.source newTextureViewWithPixelFormat:plain(f.source.pixelFormat)];if(!encodedSource)return {false,"Cannot retain the encoded sRGB source view"};}auto restore=[f.commands computeCommandEncoder];if(!restore)return {false,"Cannot retain exact source alpha"};[restore setComputePipelineState:r->restore];[restore setTexture:encodedSource atIndex:0];[restore setTexture:r->linear atIndex:1];[restore setTexture:r->encoded atIndex:2];[restore setBuffer:r->history offset:0 atIndex:0];[restore setBytes:&p length:sizeof(p) atIndex:1];dispatch(restore);
  auto copy=[f.commands blitCommandEncoder];if(!copy)return {false,"Cannot encode the exposure output"};[copy copyFromTexture:r->encoded sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(r->width,r->height,1) toTexture:f.target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];flight->encoded.store(true,std::memory_order_release);[f.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)encodedSource;}];if(completion)*completion=[flight]{return flight->complete();};return {true,{}};
 }}catch(const ImageBudgetExceeded&e){return {false,e.what(),true};}catch(const std::exception&e){return {false,e.what()};}}
 ShaderResult finish()const{auto f=std::atomic_load(&last);return f?f->complete():ShaderResult{true,{}};}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeHistogramExposureNode(const ShaderParameters&p){return std::make_shared<Histogram>(p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkHistogramExposureNode(const std::shared_ptr<ShaderNode>&n,const ShaderParameters&p){auto node=std::dynamic_pointer_cast<Histogram>(n);return node?node->fork(p):nullptr;}
bool macfx::isHistogramExposureNode(const std::shared_ptr<ShaderNode>&n){return bool(std::dynamic_pointer_cast<Histogram>(n));}
void macfx::setHistogramExposureNodeColor(const std::shared_ptr<ShaderNode>&n,const ImageColorDescription&c){if(auto node=std::dynamic_pointer_cast<Histogram>(n))node->setColor(c);}
macfx::ShaderResult macfx::encodeHistogramExposureStamped(const std::shared_ptr<ShaderNode>&n,const ShaderFrame&f,const NeuralInputStamp&s,bool redraw,bool mapped,std::function<ShaderResult()>*completion){auto node=std::dynamic_pointer_cast<Histogram>(n);return node?node->encodeStamped(f,s,redraw,mapped,completion):n->encode(f);}
macfx::ShaderResult macfx::finishHistogramExposureNode(const std::shared_ptr<ShaderNode>&n){auto node=std::dynamic_pointer_cast<Histogram>(n);return node?node->finish():ShaderResult{true,{}};}
