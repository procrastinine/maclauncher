// Copyright (c) MacLauncher contributors. MIT license.
// Image-pair generators built on macOS frameworks: VideoToolbox low-latency
// frame interpolation, MetalFX interpolation from estimated image motion and
// Vision optical flow. Each is an ordinary GenerationEncoder; the shared
// timeline, pair analysis and presenter own scheduling and display.
#include "generation-provider.hpp"
#include "image-admission.hpp"
#include "image-pair-kernels.hpp"
#include "metal-library-cache.hpp"
#include "temporal-provider.hpp"
#import <CoreVideo/CoreVideo.h>
#import <MetalFX/MetalFX.h>
#import <VideoToolbox/VideoToolbox.h>
#import <Vision/Vision.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <dlfcn.h>
#include <map>
#include <mutex>
#include <stdexcept>
namespace macfx {
namespace {
// Optional generation frameworks stay unloaded until a selected provider asks.
// Handles remain open for the process lifetime: asynchronous work retains classes
// and function pointers after an encoder is destroyed.
struct API_AVAILABLE(macos(26.0)) VideoToolboxAPI {
 void*handle=dlopen("/System/Library/Frameworks/VideoToolbox.framework/VideoToolbox",RTLD_LAZY|RTLD_LOCAL);
 decltype(&VTMotionEstimationSessionCreate)create=nullptr;
 decltype(&VTMotionEstimationSessionInvalidate)invalidate=nullptr;
 decltype(&VTMotionEstimationSessionEstimateMotionVectors)estimate=nullptr;
 const CFStringRef*multiPass=nullptr;const CFStringRef*vectorSize=nullptr;
 VideoToolboxAPI(){if(!handle)return;
  create=reinterpret_cast<decltype(create)>(dlsym(handle,"VTMotionEstimationSessionCreate"));
  invalidate=reinterpret_cast<decltype(invalidate)>(dlsym(handle,"VTMotionEstimationSessionInvalidate"));
  estimate=reinterpret_cast<decltype(estimate)>(dlsym(handle,"VTMotionEstimationSessionEstimateMotionVectors"));
  multiPass=static_cast<const CFStringRef*>(dlsym(handle,"kVTMotionEstimationSessionCreationOption_UseMultiPassSearch"));
  vectorSize=static_cast<const CFStringRef*>(dlsym(handle,"kVTMotionEstimationSessionCreationOption_MotionVectorSize"));
 }
 bool motionAvailable()const{return create&&invalidate&&estimate&&multiPass&&vectorSize;}
};
const VideoToolboxAPI&videoToolbox() API_AVAILABLE(macos(26.0)){static const VideoToolboxAPI api;return api;}
bool visionFramework(){static void*handle=dlopen("/System/Library/Frameworks/Vision.framework/Vision",RTLD_LAZY|RTLD_LOCAL);return handle!=nullptr;}
constexpr uint32_t pixelFormatBGRA='BGRA',pixelFormat420Full='420f',pixelFormat420Video='420v';
dispatch_queue_t preparationQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.graphics.image-pair.prepare",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));return queue;}
dispatch_queue_t externalQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.graphics.image-pair.external",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_CONCURRENT,QOS_CLASS_USER_INTERACTIVE,0));return queue;}
bool srgbView(MTLPixelFormat format){return format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA8Unorm_sRGB;}
bool readableColor(id<MTLTexture>image){return image&&image.textureType==MTLTextureType2D&&image.sampleCount==1&&!image.framebufferOnly&&(image.usage&MTLTextureUsageShaderRead);}
struct Convert {uint32_t fullRange=1,flags=0;float coverage[2]={1,1},vectorScale[2]={1,1};};
struct FlowParams {float t,gain,consistency,colorTolerance;};
// Completion callbacks may run in a different order from their registration.
// Read the command's terminal state directly before consulting GPU output;
// keep a cached result after its weak command reference has disappeared.
struct ImagePairReceipt {
 __weak id<MTLCommandBuffer>commands;id<MTLBuffer>valid=nil;
 std::atomic<unsigned>result{0};
 unsigned status()const{
  if(const auto cached=result.load())return cached;
  id<MTLCommandBuffer>current=commands;if(!current)return 0;
  if(current.status==MTLCommandBufferStatusCompleted)return !valid||*static_cast<const uint32_t*>(valid.contents)!=0?1:2;
  return current.status==MTLCommandBufferStatusError?2:0;
 }
};
// Compiled kernels, shared by every provider instance on a device.
struct Kernels {
 id<MTLComputePipelineState>toYCbCr,fromYCbCr,resample,luma,expand,depth,flow;
 explicit Kernels(id<MTLDevice>device){
  NSError*error=nil;auto library=cachedMetalLibrary(device,imagePairKernels,&error);
  if(!library)throw std::runtime_error(std::string("Image-pair generation kernels did not compile: ")+(error.localizedDescription.UTF8String?:"unknown error"));
  const auto make=[&](NSString*name){NSError*failure=nil;auto function=[library newFunctionWithName:name];auto state=function?[device newComputePipelineStateWithFunction:function error:&failure]:nil;if(!state)throw std::runtime_error("Image-pair generation kernel is unavailable");return state;};
  toYCbCr=make(@"rgbToYCbCr");fromYCbCr=make(@"yCbCrToRGB");resample=make(@"resampleRGB");luma=make(@"lumaFromRGB");expand=make(@"expandMotion");depth=make(@"fillDepth");flow=make(@"flowInterpolate");
 }
 static void dispatch(id<MTLComputeCommandEncoder>encoder,id<MTLComputePipelineState>state,unsigned width,unsigned height){
  const NSUInteger w=state.threadExecutionWidth,h=std::max<NSUInteger>(1,state.maxTotalThreadsPerThreadgroup/w);
  [encoder setComputePipelineState:state];[encoder dispatchThreads:MTLSizeMake(width,height,1) threadsPerThreadgroup:MTLSizeMake(w,h,1)];
 }
 bool encode(id<MTLCommandBuffer>commands,id<MTLComputePipelineState>state,std::initializer_list<id<MTLTexture>>textures,const Convert&values,unsigned width,unsigned height,id<MTLBuffer>valid=nil)const{
  auto encoder=[commands computeCommandEncoder];if(!encoder)return false;
  NSUInteger index=0;for(auto texture:textures)[encoder setTexture:texture atIndex:index++];
  [encoder setBytes:&values length:sizeof(values) atIndex:0];if(valid)[encoder setBuffer:valid offset:0 atIndex:1];
  dispatch(encoder,state,width,height);[encoder endEncoding];return true;
 }
};
std::shared_ptr<Kernels>kernels(id<MTLDevice>device){
 static std::mutex lock;static std::map<uint64_t,std::weak_ptr<Kernels>>cached;
 std::lock_guard guard(lock);auto&slot=cached[device.registryID];auto value=slot.lock();if(value)return value;
 value=std::make_shared<Kernels>(device);slot=value;return value;
}
// A Metal view of one IOSurface-backed pixel buffer plane. The holder keeps
// the Core Video texture alive until every command that reads it completes.
struct PlaneView {id<MTLTexture>texture=nil;id holder=nil;};
PlaneView planeView(CVMetalTextureCacheRef cache,CVPixelBufferRef buffer,size_t plane,MTLPixelFormat format){
 const bool planar=CVPixelBufferIsPlanar(buffer);
 const size_t width=planar?CVPixelBufferGetWidthOfPlane(buffer,plane):CVPixelBufferGetWidth(buffer),height=planar?CVPixelBufferGetHeightOfPlane(buffer,plane):CVPixelBufferGetHeight(buffer);
 CVMetalTextureRef value=nullptr;
 if(CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,cache,buffer,nullptr,format,width,height,plane,&value)!=kCVReturnSuccess||!value)return {};
 PlaneView view;view.holder=(__bridge_transfer id)value;view.texture=CVMetalTextureGetTexture(value);return view;
}
CVPixelBufferPoolRef createPool(NSDictionary*required,uint32_t format,unsigned width,unsigned height){
 NSMutableDictionary*attributes=required?[required mutableCopy]:[NSMutableDictionary dictionary];
 attributes[(__bridge id)kCVPixelBufferPixelFormatTypeKey]=@(format);attributes[(__bridge id)kCVPixelBufferWidthKey]=@(width);attributes[(__bridge id)kCVPixelBufferHeightKey]=@(height);
 attributes[(__bridge id)kCVPixelBufferIOSurfacePropertiesKey]=@{};attributes[(__bridge id)kCVPixelBufferMetalCompatibilityKey]=@YES;
 CVPixelBufferPoolRef pool=nullptr;if(CVPixelBufferPoolCreate(kCFAllocatorDefault,nullptr,(__bridge CFDictionaryRef)attributes,&pool)!=kCVReturnSuccess)return nullptr;return pool;
}
id pooledBuffer(CVPixelBufferPoolRef pool){CVPixelBufferRef value=nullptr;if(!pool||CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault,pool,&value)!=kCVReturnSuccess||!value)return nil;return (__bridge_transfer id)value;}
// Even dimensions inside a size limit, keeping the source aspect ratio.
void fitSize(unsigned width,unsigned height,double maximumDimension,double maximumPixels,unsigned&outW,unsigned&outH){
 double scale=std::min({1.0,maximumDimension/std::max(width,height),std::sqrt(maximumPixels/(double(width)*height))});
 outW=std::max(2u,unsigned(width*scale)&~1u);outH=std::max(2u,unsigned(height*scale)&~1u);
}
// One external step between two points of the caller's command buffer. The
// buffer signals 1 once its inputs are written and waits for 2 before the
// steps that read the result. The external work, or a deadline when it is
// late, signals 2 exactly once; a late result is discarded and the pair is
// marked invalid, so the GPU never waits indefinitely.
struct ExternalStep {
 id<MTLSharedEvent>event;id<MTLBuffer>valid;std::atomic<unsigned>state{0};
 explicit ExternalStep(id<MTLDevice>device):event([device newSharedEvent]),valid([device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared]){
  if(!event||!valid)throw std::runtime_error("Cannot synchronize external image-pair work");*static_cast<uint32_t*>(valid.contents)=0;
 }
 // The first completion wins. Results written after a lost race are never
 // read: kernels test the validity flag before sampling external results.
 void complete(bool success){unsigned expected=0;if(!state.compare_exchange_strong(expected,1))return;*static_cast<uint32_t*>(valid.contents)=success?1:0;event.signaledValue=2;}
 static MTLSharedEventListener*listener(){static MTLSharedEventListener*value=[[MTLSharedEventListener alloc] initWithDispatchQueue:externalQueue()];return value;}
 // work runs after the GPU signals 1. It, or a callback it starts, calls
 // complete() after writing the result the GPU reads.
 // Every block and callback holds its own copy of step; the caller's local
 // ends when encode returns, long before the GPU or the external work finishes.
 static void schedule(std::shared_ptr<ExternalStep>step,id<MTLCommandBuffer>commands,double deadlineMs,std::function<void(std::shared_ptr<ExternalStep>)>work){
  [commands encodeSignalEvent:step->event value:1];[commands encodeWaitForEvent:step->event value:2];
  [step->event notifyListener:listener() atValue:1 block:^(id<MTLSharedEvent>,uint64_t){
   dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(deadlineMs*NSEC_PER_MSEC)),externalQueue(),^{step->complete(false);});
   @autoreleasepool{@try{try{work(step);}catch(...){step->complete(false);}}@catch(NSException*){step->complete(false);}}
  }];
  // An abandoned command buffer never signals 1; its completion releases the wait.
  [commands addCompletedHandler:^(id<MTLCommandBuffer>){step->complete(false);}];
 }
};
GenerationResult rejected(uint64_t sequence,std::string reason,bool busy=false){GenerationResult result;result.frameId=sequence;result.reason=std::move(reason);result.busy=busy;return result;}
std::string validatePair(id<MTLDevice>device,id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,const InterpolationPlan&phases,const char*name){
 if(!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||commands.device!=device||!readableColor(source)||source.device!=device||source.width<16||source.height<16)
  return std::string(name)+" requires unsubmitted retained commands and a readable 2D image";
 if(outputs.size()!=phases.count)return std::string(name)+" outputs must match the selected phase plan";
 float prior=0;for(size_t i=0;i<outputs.size();++i){auto output=outputs[i];
  if(!output||output==source||output.device!=device||output.width!=source.width||output.height!=source.height||output.pixelFormat!=source.pixelFormat||!(output.usage&MTLTextureUsageShaderWrite)||!std::isfinite(phases.timestamps[i])||phases.timestamps[i]<=prior||phases.timestamps[i]>=1)
   return std::string(name)+" requires distinct matching writable outputs and increasing phases";
  prior=phases.timestamps[i];}
 return {};
}
// The first image of a pair, or a discontinuity, keeps history and copies the
// real image into the outputs; the timeline reports no generated event for it.
GenerationResult warming(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence){
 auto result=rejected(sequence,"Waiting for the next input image");
 if(!outputs.empty()){auto copy=[commands blitCommandEncoder];if(!copy){result.reason="Cannot retain the first image of the pair";return result;}
  for(auto output:outputs)[copy copyFromTexture:source toTexture:output];[copy endEncoding];}
 result.encoded=true;result.historyFrames=1;return result;
}
id<MTLTexture>historyTexture(id<MTLDevice>device,id<MTLTexture>source,const char*stage){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:source.pixelFormat width:source.width height:source.height mipmapped:NO];
 descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return newAdmittedTexture(device,descriptor,0,stage);
}
id<MTLTexture>sharedTexture(id<MTLDevice>device,MTLPixelFormat format,unsigned width,unsigned height,MTLTextureUsage usage,const char*stage){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
 descriptor.storageMode=MTLStorageModeShared;descriptor.usage=usage;return newAdmittedTexture(device,descriptor,0,stage);
}
// Copies a two-component half-float pixel buffer into a shared texture.
bool copyVectors(CVPixelBufferRef buffer,id<MTLTexture>target){
 if(!buffer||CVPixelBufferGetPixelFormatType(buffer)!=kCVPixelFormatType_TwoComponent16Half)return false;
 if(CVPixelBufferLockBaseAddress(buffer,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess)return false;
 const auto*base=static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(buffer));
 const size_t width=std::min<size_t>(CVPixelBufferGetWidth(buffer),target.width),height=std::min<size_t>(CVPixelBufferGetHeight(buffer),target.height);
 if(base&&width&&height)[target replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:base bytesPerRow:CVPixelBufferGetBytesPerRow(buffer)];
 CVPixelBufferUnlockBaseAddress(buffer,kCVPixelBufferLock_ReadOnly);return base&&width&&height;
}
void requireSDR(const ImageColorDescription&color,const char*name){
 if(!color.valid()||color.transfer==ColorTransfer::Linear||color.transfer==ColorTransfer::PQ||color.transfer==ColorTransfer::HLG)
  throw std::runtime_error(std::string(name)+" requires SDR source color from the shared color adapter");
}

// VideoToolbox low-latency frame interpolation, reimplemented from Apple's
// VTFrameProcessor documentation. The processor runs on the Neural Engine
// inside the caller's command buffer; the GPU converts color to and from the
// processor's pixel format and resamples within its size limit.
class VideoToolboxGeneration final:public GenerationEncoder {
 struct Session {
  unsigned width=0,height=0,frameW=0,frameH=0,interpolated=1;uint32_t format=0;
  id processor=nil;CVPixelBufferPoolRef sourcePool=nullptr,destinationPool=nullptr;CVMetalTextureCacheRef cache=nullptr;
  ~Session(){if(@available(macOS 26.0,*))[processor endSession];if(sourcePool)CVPixelBufferPoolRelease(sourcePool);if(destinationPool)CVPixelBufferPoolRelease(destinationPool);if(cache)CFRelease(cache);}
 };
 struct Preparation {unsigned width=0,height=0;std::shared_ptr<Session>value;std::string error;std::atomic<bool>done{false};};
 id<MTLDevice>device;unsigned multiplier;std::shared_ptr<Kernels>gpu;mutable std::mutex mutex;
 std::shared_ptr<Session>session;std::shared_ptr<Preparation>preparing;
 id previous=nil;uint64_t previousSequence=0;std::string failure;
 // The block copies the request: a captured C++ reference would point at the
 // encoder's member, which a size change or teardown replaces.
 static void prepareSession(std::shared_ptr<Preparation>request,id<MTLDevice>device,unsigned interpolated){
  dispatch_async(preparationQueue(),^{@autoreleasepool{@try{try{
   if(@available(macOS 26.0,*)){
    if(![NSClassFromString(@"VTLowLatencyFrameInterpolationConfiguration") isSupported])throw std::runtime_error("VideoToolbox low-latency interpolation is not supported on this Mac");
    double dimension=1920,pixels=1920.0*1080;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
    if(@available(macOS 27.0,*)){const auto d=[NSClassFromString(@"VTLowLatencyFrameInterpolationConfiguration") maximumDimensionForSpatialScaleFactor:1],p=[NSClassFromString(@"VTLowLatencyFrameInterpolationConfiguration") maximumPixelCountForSpatialScaleFactor:1];if(d>0&&p>0){dimension=double(d);pixels=double(p);}}
#endif
    std::string last="VideoToolbox could not start a low-latency interpolation session";
    // The processor's own limit first, then two smaller sizes.
    const double fallbacks[][2]={{dimension,pixels},{1280,1280.0*720},{960,960.0*540}};
    for(const auto&limit:fallbacks){
     auto next=std::make_shared<Session>();fitSize(request->width,request->height,std::min(dimension,limit[0]),std::min(pixels,limit[1]),next->frameW,next->frameH);
     next->width=request->width;next->height=request->height;next->interpolated=interpolated;
     auto configuration=(VTLowLatencyFrameInterpolationConfiguration*)[[NSClassFromString(@"VTLowLatencyFrameInterpolationConfiguration") alloc] initWithFrameWidth:next->frameW frameHeight:next->frameH numberOfInterpolatedFrames:interpolated];
     if(!configuration)continue;
     NSArray<NSNumber*>*formats=configuration.frameSupportedPixelFormats;
     for(uint32_t candidate:{pixelFormatBGRA,pixelFormat420Full,pixelFormat420Video})if([formats containsObject:@(candidate)]){next->format=candidate;break;}
     if(!next->format){last="VideoToolbox interpolation offers no supported 8-bit pixel format";continue;}
     VTFrameProcessor*processor=[NSClassFromString(@"VTFrameProcessor") new];NSError*error=nil;
     if(![processor startSessionWithConfiguration:configuration error:&error]){if(error.localizedDescription.UTF8String)last=error.localizedDescription.UTF8String;continue;}
     next->processor=processor;
     next->sourcePool=createPool(configuration.sourcePixelBufferAttributes,next->format,next->frameW,next->frameH);
     next->destinationPool=createPool(configuration.destinationPixelBufferAttributes,next->format,next->frameW,next->frameH);
     if(!next->sourcePool||!next->destinationPool||CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&next->cache)!=kCVReturnSuccess)throw std::runtime_error("VideoToolbox interpolation could not allocate its frame buffers");
     request->value=std::move(next);break;
    }
    if(!request->value)request->error=last;
   }else request->error="VideoToolbox low-latency interpolation requires macOS 26 or later";
  }catch(const std::exception&error){request->error=error.what();}}@catch(NSException*error){request->error=error.reason.UTF8String?:"VideoToolbox interpolation preparation failed";}}
  request->done.store(true,std::memory_order_release);});
 }
 // Preparation status for this exact source size; starts it when absent.
 // An empty size during start-up or a resize waits for an actual image.
 ShaderResult ensure(unsigned width,unsigned height){
  if(!width||!height)return {false,"Waiting for a source image",true};
  if(session&&session->width==width&&session->height==height)return {true,{}};
  if(preparing&&preparing->width==width&&preparing->height==height){
   if(!preparing->done.load(std::memory_order_acquire))return {false,"Preparing VideoToolbox interpolation",true};
   if(!preparing->value)return {false,preparing->error};
   session=std::move(preparing->value);preparing.reset();previous=nil;return {true,{}};
  }
  preparing=std::make_shared<Preparation>();preparing->width=width;preparing->height=height;prepareSession(preparing,device,multiplier==4?2:1);
  return {false,"Preparing VideoToolbox interpolation",true};
 }
 // Writes one source image into a processor buffer; false when unavailable.
 bool enter(id<MTLCommandBuffer>commands,id<MTLTexture>source,id buffer,std::vector<id>&holders){
  auto pixels=(__bridge CVPixelBufferRef)buffer;Convert values;values.flags=srgbView(source.pixelFormat)?1:0;values.fullRange=session->format!=pixelFormat420Video;
  if(session->format==pixelFormatBGRA){auto view=planeView(session->cache,pixels,0,MTLPixelFormatBGRA8Unorm);if(!view.texture)return false;holders.push_back(view.holder);return gpu->encode(commands,gpu->resample,{source,view.texture},values,session->frameW,session->frameH);}
  auto luma=planeView(session->cache,pixels,0,MTLPixelFormatR8Unorm),chroma=planeView(session->cache,pixels,1,MTLPixelFormatRG8Unorm);if(!luma.texture||!chroma.texture)return false;
  holders.push_back(luma.holder);holders.push_back(chroma.holder);return gpu->encode(commands,gpu->toYCbCr,{source,luma.texture,chroma.texture},values,session->frameW/2,session->frameH/2);
 }
 bool leave(id<MTLCommandBuffer>commands,id buffer,id<MTLTexture>output,std::vector<id>&holders){
  auto pixels=(__bridge CVPixelBufferRef)buffer;Convert values;values.flags=srgbView(output.pixelFormat)?2:0;values.fullRange=session->format!=pixelFormat420Video;
  if(session->format==pixelFormatBGRA){auto view=planeView(session->cache,pixels,0,MTLPixelFormatBGRA8Unorm);if(!view.texture)return false;holders.push_back(view.holder);return gpu->encode(commands,gpu->resample,{view.texture,output},values,unsigned(output.width),unsigned(output.height));}
  auto luma=planeView(session->cache,pixels,0,MTLPixelFormatR8Unorm),chroma=planeView(session->cache,pixels,1,MTLPixelFormatRG8Unorm);if(!luma.texture||!chroma.texture)return false;
  holders.push_back(luma.holder);holders.push_back(chroma.holder);return gpu->encode(commands,gpu->fromYCbCr,{luma.texture,chroma.texture,output},values,unsigned(output.width),unsigned(output.height));
 }
public:
 VideoToolboxGeneration(id<MTLDevice>value,const LsfgConfig&config):device(value),multiplier(config.multiplier){
  if(config.multiplier!=2&&config.multiplier!=4)throw std::runtime_error("VideoToolbox interpolation produces 2x or 4x frame rates");
  if(!videoToolboxGenerationAvailable())throw std::runtime_error("VideoToolbox low-latency interpolation is unavailable on this Mac or macOS version");
  gpu=kernels(device);
 }
 const char*method()const noexcept override{return "vt-interpolation";}
 void setColorDescription(const ImageColorDescription&color)override{requireSDR(color,"VideoToolbox interpolation");}
 ShaderResult preparationStatus()const override{
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return {false,"Preparing VideoToolbox interpolation",true};
  if(preparing){if(!preparing->done.load(std::memory_order_acquire))return {false,"Preparing VideoToolbox interpolation",true};if(!preparing->value)return {false,preparing->error};}
  return {true,{}};
 }
 GenerationResult prepare(id<MTLCommandBuffer>,id<MTLTexture>source,const RSTemporalFrame*)override{
  GenerationResult result;if(!readableColor(source)||source.device!=device){result.reason="VideoToolbox interpolation requires a readable 2D image";return result;}
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock()){result.busy=true;result.reason="Preparing VideoToolbox interpolation";return result;}
  const auto ready=ensure(unsigned(source.width),unsigned(source.height));result.encoded=ready.encoded;result.busy=ready.busy;result.reason=ready.reason;return result;
 }
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  if(auto reason=validatePair(device,commands,source,outputs,phases,"VideoToolbox interpolation");!reason.empty())return rejected(sequence,reason);
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return rejected(sequence,"VideoToolbox interpolation is occupied",true);
  const auto ready=ensure(unsigned(source.width),unsigned(source.height));if(!ready.encoded)return rejected(sequence,ready.reason,ready.busy);
  if(@available(macOS 26.0,*)){
   std::vector<id>holders;id current=pooledBuffer(session->sourcePool);if(!current)return rejected(sequence,"VideoToolbox interpolation frame buffers are in use",true);
   if(!enter(commands,source,current,holders))return rejected(sequence,"Cannot convert the image for VideoToolbox interpolation");
   const bool reset=!previous||sequence!=previousSequence+1;id pair=previous;previous=current;previousSequence=sequence;auto keep=session;
   if(reset||outputs.empty()){auto result=warming(commands,source,outputs,sequence);[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)holders;(void)current;(void)keep;}];return result;}
   // The processor offers 2^n - 1 evenly spaced points. A phase between
   // them, which a narrower output interval can request, uses the nearest.
   const unsigned points=(1u<<session->interpolated)-1;NSMutableArray<NSNumber*>*requested=[NSMutableArray array];NSMutableArray<VTFrameProcessorFrame*>*targets=[NSMutableArray array];std::vector<id>destinations;
   for(unsigned i=0;i<phases.count;++i){
    const float point=std::clamp(std::round(phases.timestamps[i]*(points+1)),1.0f,float(points))/float(points+1);
    if(requested.count&&point<=requested.lastObject.floatValue)return rejected(sequence,"VideoToolbox interpolation cannot place these phases");
    id buffer=pooledBuffer(session->destinationPool);if(!buffer)return rejected(sequence,"VideoToolbox interpolation frame buffers are in use",true);
    auto frame=(VTFrameProcessorFrame*)[[NSClassFromString(@"VTFrameProcessorFrame") alloc] initWithBuffer:(__bridge CVPixelBufferRef)buffer presentationTimeStamp:CMTimeMakeWithSeconds(double(previousSequence-1)+point,600)];
    if(!frame)return rejected(sequence,"VideoToolbox interpolation could not describe its output");
    [requested addObject:@(point)];[targets addObject:frame];destinations.push_back(buffer);
   }
   auto sourceFrame=(VTFrameProcessorFrame*)[[NSClassFromString(@"VTFrameProcessorFrame") alloc] initWithBuffer:(__bridge CVPixelBufferRef)current presentationTimeStamp:CMTimeMake(int64_t(sequence),1)];
   auto previousFrame=(VTFrameProcessorFrame*)[[NSClassFromString(@"VTFrameProcessorFrame") alloc] initWithBuffer:(__bridge CVPixelBufferRef)pair presentationTimeStamp:CMTimeMake(int64_t(sequence-1),1)];
   auto parameters=sourceFrame&&previousFrame?(VTLowLatencyFrameInterpolationParameters*)[[NSClassFromString(@"VTLowLatencyFrameInterpolationParameters") alloc] initWithSourceFrame:sourceFrame previousFrame:previousFrame interpolationPhase:requested destinationFrames:targets]:nil;
   if(!parameters)return rejected(sequence,"VideoToolbox interpolation rejected this pair");
   VTFrameProcessor*processor=session->processor;
   @try{InternalTemporalScope scope;[processor processWithCommandBuffer:commands parameters:parameters];}@catch(NSException*error){return rejected(sequence,error.reason.UTF8String?:"VideoToolbox interpolation failed");}
   for(size_t i=0;i<outputs.size();++i)if(!leave(commands,destinations[i],outputs[i],holders))return rejected(sequence,"Cannot convert the VideoToolbox interpolation output");
   auto completed=std::make_shared<ImagePairReceipt>();completed->commands=commands;
   [commands addCompletedHandler:^(id<MTLCommandBuffer>finished){(void)holders;(void)pair;(void)current;(void)parameters;(void)keep;completed->result.store(finished.status==MTLCommandBufferStatusCompleted?1:2);}];
   // These are encoded candidates. The completion receipt alone attests GPU-valid output.
  GenerationResult result;result.frameId=sequence;result.encoded=result.ready=true;result.generated=unsigned(outputs.size());result.historyFrames=2;
   result.completion=[completed]()->ShaderResult{const auto status=completed->status();if(status==1)return {true,{}};if(status==2)return {false,"VideoToolbox interpolation commands failed or were abandoned"};return {false,"VideoToolbox interpolation is still in flight",true};};
   return result;
  }
  return rejected(sequence,"VideoToolbox low-latency interpolation requires macOS 26 or later");
 }
};

// MetalFX frame interpolation driven by motion that VTMotionEstimationSession
// estimates from the image pair, with a constant far-plane depth. The motion
// stays inside this provider and is never published as renderer motion.
class MetalImageGeneration final:public GenerationEncoder {
 struct Session {
  unsigned width=0,height=0,lumaW=0,lumaH=0,fieldW=0,fieldH=0;MTLPixelFormat color=MTLPixelFormatInvalid;
  id interpolator=nil;CFTypeRef estimator=nullptr;CVPixelBufferPoolRef lumaPool=nullptr;CVMetalTextureCacheRef cache=nullptr;
  id<MTLTexture>depth=nil,motion=nil,history[2]={nil,nil};bool depthReady=false;
  ~Session(){if(@available(macOS 26.0,*)){if(estimator){videoToolbox().invalidate((VTMotionEstimationSessionRef)estimator);CFRelease(estimator);}}if(lumaPool)CVPixelBufferPoolRelease(lumaPool);if(cache)CFRelease(cache);}
 };
 struct Preparation {unsigned width=0,height=0;MTLPixelFormat color=MTLPixelFormatInvalid;std::shared_ptr<Session>value;std::string error;std::atomic<bool>done{false};};
 static constexpr unsigned blockSize=16;
 id<MTLDevice>device;std::shared_ptr<Kernels>gpu;mutable std::mutex mutex;std::shared_ptr<Session>session;std::shared_ptr<Preparation>preparing;
 id previousLuma=nil;uint64_t previousSequence=0;int previousSlot=-1;bool resetHistory=true;std::shared_ptr<std::atomic<bool>>busy=std::make_shared<std::atomic<bool>>(false);
 std::chrono::steady_clock::time_point previousTime{};
 // The block copies the request: a captured C++ reference would point at the
 // encoder's member, which a size change or teardown replaces.
 static void prepareSession(std::shared_ptr<Preparation>request,id<MTLDevice>device){
  dispatch_async(preparationQueue(),^{@autoreleasepool{@try{try{
   if(@available(macOS 26.0,*)){
    auto next=std::make_shared<Session>();next->width=request->width;next->height=request->height;next->color=request->color;
    fitSize(request->width,request->height,1920,1920.0*1080,next->lumaW,next->lumaH);
    // One vector per 16x16 block, padded by the estimator to a multiple of four vectors.
    next->fieldW=((next->lumaW+blockSize-1)/blockSize+3)&~3u;next->fieldH=((next->lumaH+blockSize-1)/blockSize+3)&~3u;
    NSDictionary*options=@{(__bridge id)*videoToolbox().multiPass:@YES,(__bridge id)*videoToolbox().vectorSize:@(blockSize)};
    VTMotionEstimationSessionRef estimator=nullptr;
    if(videoToolbox().create(kCFAllocatorDefault,(__bridge CFDictionaryRef)options,next->lumaW,next->lumaH,&estimator)!=noErr||!estimator)throw std::runtime_error("VideoToolbox could not create a motion-estimation session");
    next->estimator=estimator;
    next->lumaPool=createPool(nil,kCVPixelFormatType_OneComponent8,next->lumaW,next->lumaH);
    if(!next->lumaPool||CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&next->cache)!=kCVReturnSuccess)throw std::runtime_error("Motion estimation could not allocate its frame buffers");
    auto descriptor=[MTLFXFrameInterpolatorDescriptor new];
    descriptor.inputWidth=descriptor.outputWidth=request->width;descriptor.inputHeight=descriptor.outputHeight=request->height;
    descriptor.colorTextureFormat=descriptor.outputTextureFormat=request->color;descriptor.depthTextureFormat=MTLPixelFormatR32Float;descriptor.motionTextureFormat=MTLPixelFormatRG16Float;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
    if(@available(macOS 27.0,*))descriptor.requiresPrevColorTexture=YES;
#endif
    id<MTLFXFrameInterpolator>interpolator=nil;@try{InternalTemporalScope scope;interpolator=[descriptor newFrameInterpolatorWithDevice:device];}@catch(NSException*){}
    if(!interpolator)throw std::runtime_error("MetalFX could not create an interpolator for this image");
    next->interpolator=interpolator;
    auto image=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Float width:request->width height:request->height mipmapped:NO];image.storageMode=MTLStorageModePrivate;image.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|interpolator.depthTextureUsage;
    next->depth=newAdmittedTexture(device,image,0,"MetalFX image interpolation depth");
    image=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRG16Float width:request->width height:request->height mipmapped:NO];image.storageMode=MTLStorageModePrivate;image.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|interpolator.motionTextureUsage;
    next->motion=newAdmittedTexture(device,image,0,"MetalFX image interpolation motion");
    image=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:request->color width:request->width height:request->height mipmapped:NO];image.storageMode=MTLStorageModePrivate;image.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|interpolator.colorTextureUsage;
    for(auto&slot:next->history)slot=newAdmittedTexture(device,image,0,"MetalFX image interpolation history");
    if(!next->depth||!next->motion||!next->history[0]||!next->history[1])throw std::runtime_error("MetalFX image interpolation could not allocate its images");
    request->value=std::move(next);
   }else request->error="MetalFX image interpolation requires macOS 26 or later";
  }catch(const std::exception&error){request->error=error.what();}}@catch(NSException*error){request->error=error.reason.UTF8String?:"MetalFX image interpolation preparation failed";}}
  request->done.store(true,std::memory_order_release);});
 }
 ShaderResult ensure(id<MTLTexture>source){
  const unsigned width=unsigned(source.width),height=unsigned(source.height);
  if(!width||!height||source.pixelFormat==MTLPixelFormatInvalid)return {false,"Waiting for a source image",true};
  if(session&&session->width==width&&session->height==height&&session->color==source.pixelFormat)return {true,{}};
  if(preparing&&preparing->width==width&&preparing->height==height&&preparing->color==source.pixelFormat){
   if(!preparing->done.load(std::memory_order_acquire))return {false,"Preparing MetalFX image interpolation",true};
   if(!preparing->value)return {false,preparing->error};
   session=std::move(preparing->value);preparing.reset();previousLuma=nil;previousSlot=-1;return {true,{}};
  }
  preparing=std::make_shared<Preparation>();preparing->width=width;preparing->height=height;preparing->color=source.pixelFormat;prepareSession(preparing,device);
  return {false,"Preparing MetalFX image interpolation",true};
 }
public:
 MetalImageGeneration(id<MTLDevice>value,const LsfgConfig&config):device(value){
  if(config.multiplier!=2)throw std::runtime_error("MetalFX image interpolation produces one midpoint between real frames");
  bool motionAvailable=false;if(@available(macOS 26.0,*))motionAvailable=videoToolbox().motionAvailable();
  if(!motionAvailable||!metalFXGenerationAvailable(device))throw std::runtime_error("MetalFX interpolation is unavailable on this device or macOS version");
  gpu=kernels(device);
 }
 const char*method()const noexcept override{return "metalfx-image";}
 void setColorDescription(const ImageColorDescription&color)override{if(!color.valid())throw std::runtime_error("MetalFX image interpolation requires valid source color metadata");}
 ShaderResult preparationStatus()const override{
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return {false,"Preparing MetalFX image interpolation",true};
  if(preparing){if(!preparing->done.load(std::memory_order_acquire))return {false,"Preparing MetalFX image interpolation",true};if(!preparing->value)return {false,preparing->error};}
  return {true,{}};
 }
 GenerationResult prepare(id<MTLCommandBuffer>,id<MTLTexture>source,const RSTemporalFrame*)override{
  GenerationResult result;if(!readableColor(source)||source.device!=device){result.reason="MetalFX image interpolation requires a readable 2D image";return result;}
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock()){result.busy=true;result.reason="Preparing MetalFX image interpolation";return result;}
  const auto ready=ensure(source);result.encoded=ready.encoded;result.busy=ready.busy;result.reason=ready.reason;return result;
 }
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  if(auto reason=validatePair(device,commands,source,outputs,phases,"MetalFX image interpolation");!reason.empty())return rejected(sequence,reason);
  if(phases.count>1||phases.count&&std::abs(phases.timestamps[0]-.5f)>.00001f)return rejected(sequence,"MetalFX image interpolation supports the midpoint phase only");
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return rejected(sequence,"MetalFX image interpolation is occupied",true);
  const auto ready=ensure(source);if(!ready.encoded)return rejected(sequence,ready.reason,ready.busy);
  if(busy->load())return rejected(sequence,"The preceding MetalFX image interpolation is still in flight",true);
  if(@available(macOS 26.0,*)){
   auto current=session;std::vector<id>holders;id luma=pooledBuffer(current->lumaPool);if(!luma)return rejected(sequence,"Motion-estimation frame buffers are in use",true);
   auto lumaView=planeView(current->cache,(__bridge CVPixelBufferRef)luma,0,MTLPixelFormatR8Unorm);if(!lumaView.texture)return rejected(sequence,"Cannot prepare the motion-estimation image");holders.push_back(lumaView.holder);
   Convert values;values.flags=srgbView(source.pixelFormat)?1:0;
   if(!gpu->encode(commands,gpu->luma,{source,lumaView.texture},values,current->lumaW,current->lumaH))return rejected(sequence,"Cannot prepare the motion-estimation image");
   const auto now=std::chrono::steady_clock::now();const double interval=previousSlot<0?1.0/60:std::clamp(std::chrono::duration<double>(now-previousTime).count(),1.0/480,0.25);previousTime=now;
   const bool reset=previousSlot<0||!previousLuma||sequence!=previousSequence+1;const int slot=previousSlot<0?0:1-previousSlot;
   auto snapshot=current->history[slot],previousColor=reset?snapshot:current->history[previousSlot];id reference=previousLuma;
   previousLuma=luma;previousSequence=sequence;
   auto copy=[commands blitCommandEncoder];if(!copy)return rejected(sequence,"Cannot retain the real interpolation frame");[copy copyFromTexture:source toTexture:snapshot];[copy endEncoding];
   if(!current->depthReady){auto encoder=[commands computeCommandEncoder];if(!encoder)return rejected(sequence,"Cannot prepare constant depth");[encoder setTexture:current->depth atIndex:0];Kernels::dispatch(encoder,gpu->depth,current->width,current->height);[encoder endEncoding];current->depthReady=true;}
   if(reset||outputs.empty()){
    previousSlot=slot;resetHistory=true;auto result=warming(commands,source,outputs,sequence);[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)holders;(void)luma;(void)current;}];return result;
   }
   auto blocks=sharedTexture(device,MTLPixelFormatRG16Float,current->fieldW,current->fieldH,MTLTextureUsageShaderRead,"MetalFX image interpolation motion field");
   auto step=std::make_shared<ExternalStep>(device);if(!blocks)return rejected(sequence,"Cannot allocate the motion field");
   // A field that is not ready within 100 ms leaves the pair without motion.
   // Its generated image is then omitted and the real endpoint stays.
   ExternalStep::schedule(step,commands,100,[current,reference,luma,blocks](std::shared_ptr<ExternalStep>step){
    if(@available(macOS 26.0,*)){
     const OSStatus status=videoToolbox().estimate((VTMotionEstimationSessionRef)current->estimator,(__bridge CVPixelBufferRef)reference,(__bridge CVPixelBufferRef)luma,kVTMotionEstimationFrameFlags_CurrentBufferWillBeNextReferenceBuffer,nullptr,
      ^(OSStatus result,VTMotionEstimationInfoFlags,CFDictionaryRef,CVPixelBufferRef vectors){step->complete(result==noErr&&copyVectors(vectors,blocks));});
     if(status!=noErr)step->complete(false);
    }else step->complete(false);
   });
   values.coverage[0]=float(current->lumaW)/blockSize/current->fieldW;values.coverage[1]=float(current->lumaH)/blockSize/current->fieldH;
   values.vectorScale[0]=float(current->width)/current->lumaW;values.vectorScale[1]=float(current->height)/current->lumaH;
   if(!gpu->encode(commands,gpu->expand,{blocks,current->motion},values,current->width,current->height,step->valid))return rejected(sequence,"Cannot expand the motion field");
   id<MTLFXFrameInterpolator>interpolator=current->interpolator;
   if((outputs[0].usage&interpolator.outputTextureUsage)!=interpolator.outputTextureUsage||(source.usage&interpolator.colorTextureUsage)!=interpolator.colorTextureUsage)return rejected(sequence,"The image does not satisfy MetalFX interpolation usage requirements");
   interpolator.colorTexture=source;interpolator.prevColorTexture=previousColor;interpolator.depthTexture=current->depth;interpolator.motionTexture=current->motion;interpolator.uiTexture=nil;
   interpolator.motionVectorScaleX=interpolator.motionVectorScaleY=1;interpolator.jitterOffsetX=interpolator.jitterOffsetY=0;interpolator.deltaTime=float(interval);
   // Captured content is a flat plane at the far end of a nominal camera.
   interpolator.nearPlane=.1f;interpolator.farPlane=1000;interpolator.fieldOfView=60;interpolator.aspectRatio=float(source.width)/source.height;interpolator.depthReversed=NO;interpolator.shouldResetHistory=resetHistory;resetHistory=false;
   for(auto output:outputs){interpolator.outputTexture=output;InternalTemporalScope scope;[interpolator encodeToCommandBuffer:commands];}
   previousSlot=slot;busy->store(true);auto completed=std::make_shared<ImagePairReceipt>();completed->commands=commands;completed->valid=step->valid;auto flag=busy;
   [commands addCompletedHandler:^(id<MTLCommandBuffer>finished){(void)holders;(void)reference;(void)luma;(void)blocks;(void)previousColor;(void)snapshot;(void)current;
    const bool valid=finished.status==MTLCommandBufferStatusCompleted&&*static_cast<const uint32_t*>(step->valid.contents)!=0;completed->result.store(valid?1:2);flag->store(false);}];
   // These are encoded candidates. The completion receipt alone attests GPU-valid output.
  GenerationResult result;result.frameId=sequence;result.encoded=result.ready=true;result.generated=unsigned(outputs.size());result.historyFrames=2;
   result.completion=[completed]()->ShaderResult{const auto status=completed->status();if(status==1)return {true,{}};if(status==2)return {false,"MetalFX image interpolation had no motion field for this pair or its commands failed"};return {false,"MetalFX image interpolation is still in flight",true};};
   return result;
  }
  return rejected(sequence,"MetalFX image interpolation requires macOS 26 or later");
 }
};

// Vision optical-flow generation, ported from MetalDuck's VisionFlowProvider
// and flowInterpolate (MIT; see metalduck-MIT.txt). Forward and backward flow
// come from VNGenerateOpticalFlowRequest at up to 800 pixels; the warp checks
// each vector against the opposite field, keeps the side that sees an
// occluded pixel and blends where neither side is reliable or flow is late.
class VisionFlowGeneration final:public GenerationEncoder {
 static constexpr double maximumDimension=800;
 static constexpr float consistency=1;
 id<MTLDevice>device;std::shared_ptr<Kernels>gpu;std::mutex mutex;CVMetalTextureCacheRef cache=nullptr;CVPixelBufferPoolRef pool=nullptr;
 unsigned poolW=0,poolH=0,flowW=0,flowH=0;NSUInteger revision=0;float gain=1;
 id previousFlow=nil;id<MTLTexture>history[2]={nil,nil};int previousSlot=-1;uint64_t previousSequence=0;unsigned historyW=0,historyH=0;MTLPixelFormat historyFormat=MTLPixelFormatInvalid;
 static bool vectors(CVPixelBufferRef source,CVPixelBufferRef target,NSUInteger revision,id<MTLTexture>output){
  auto request=(VNGenerateOpticalFlowRequest*)[[NSClassFromString(@"VNGenerateOpticalFlowRequest") alloc] initWithTargetedCVPixelBuffer:target options:@{}];
  request.revision=revision;request.computationAccuracy=VNGenerateOpticalFlowRequestComputationAccuracyHigh;request.outputPixelFormat=kCVPixelFormatType_TwoComponent16Half;
  NSError*error=nil;auto handler=(VNImageRequestHandler*)[[NSClassFromString(@"VNImageRequestHandler") alloc] initWithCVPixelBuffer:source options:@{}];
  if(![handler performRequests:@[request] error:&error])return false;
  auto observation=request.results.firstObject;return observation&&copyVectors(observation.pixelBuffer,output);
 }
public:
 VisionFlowGeneration(id<MTLDevice>value,const LsfgConfig&config):device(value){
  if(config.multiplier<2||config.multiplier>5)throw std::runtime_error("Vision optical flow supports 2x to 5x frame rates");
  if(!visionFlowGenerationAvailable())throw std::runtime_error("Vision optical flow is unavailable on this macOS version");
  gpu=kernels(device);
  if(CVMetalTextureCacheCreate(kCFAllocatorDefault,nullptr,device,nullptr,&cache)!=kCVReturnSuccess)throw std::runtime_error("Vision optical flow could not create its texture cache");
  // Revision 1 reports vectors in pixels; the later revision reports about
  // 0.38 of the displacement at this size and accuracy.
  if([[NSClassFromString(@"VNGenerateOpticalFlowRequest") supportedRevisions] containsIndex:VNGenerateOpticalFlowRequestRevision1])revision=VNGenerateOpticalFlowRequestRevision1;
  else{revision=[NSClassFromString(@"VNGenerateOpticalFlowRequest") defaultRevision];gain=2.6f;}
 }
 ~VisionFlowGeneration(){if(pool)CVPixelBufferPoolRelease(pool);if(cache)CFRelease(cache);}
 const char*method()const noexcept override{return "vision-flow";}
 void setColorDescription(const ImageColorDescription&color)override{if(!color.valid())throw std::runtime_error("Vision optical flow requires valid source color metadata");}
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  if(auto reason=validatePair(device,commands,source,outputs,phases,"Vision optical flow");!reason.empty())return rejected(sequence,reason);
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return rejected(sequence,"Vision optical flow is occupied",true);
  @autoreleasepool{
  unsigned width,height;fitSize(unsigned(source.width),unsigned(source.height),maximumDimension,maximumDimension*maximumDimension,width,height);
  if(!pool||poolW!=width||poolH!=height){if(pool)CVPixelBufferPoolRelease(pool);pool=createPool(nil,kCVPixelFormatType_32BGRA,width,height);poolW=width;poolH=height;previousFlow=nil;if(!pool)return rejected(sequence,"Vision optical flow could not allocate its frame buffers");}
  if(historyW!=source.width||historyH!=source.height||historyFormat!=source.pixelFormat){
   for(auto&slot:history)if(!(slot=historyTexture(device,source,"Vision optical flow history")))return rejected(sequence,"Vision optical flow could not allocate its history");
   historyW=unsigned(source.width);historyH=unsigned(source.height);historyFormat=source.pixelFormat;previousSlot=-1;
  }
  std::vector<id>holders;id frame=pooledBuffer(pool);if(!frame)return rejected(sequence,"Vision optical flow frame buffers are in use",true);
  auto view=planeView(cache,(__bridge CVPixelBufferRef)frame,0,MTLPixelFormatBGRA8Unorm);if(!view.texture)return rejected(sequence,"Cannot prepare the Vision input image");holders.push_back(view.holder);
  Convert values;values.flags=srgbView(source.pixelFormat)?1:0;
  if(!gpu->encode(commands,gpu->resample,{source,view.texture},values,width,height))return rejected(sequence,"Cannot prepare the Vision input image");
  const bool reset=previousSlot<0||!previousFlow||sequence!=previousSequence+1;const int slot=previousSlot<0?0:1-previousSlot;
  auto snapshot=history[slot],previousColor=reset?snapshot:history[previousSlot];id reference=previousFlow;
  auto copy=[commands blitCommandEncoder];if(!copy)return rejected(sequence,"Cannot retain the real interpolation frame");[copy copyFromTexture:source toTexture:snapshot];[copy endEncoding];
  previousFlow=frame;previousSequence=sequence;previousSlot=slot;
  if(reset||outputs.empty()){auto result=warming(commands,source,outputs,sequence);[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)holders;(void)frame;}];return result;}
  auto forward=sharedTexture(device,MTLPixelFormatRG16Float,width,height,MTLTextureUsageShaderRead,"Vision forward flow"),backward=sharedTexture(device,MTLPixelFormatRG16Float,width,height,MTLTextureUsageShaderRead,"Vision backward flow");
  if(!forward||!backward)return rejected(sequence,"Cannot allocate Vision optical flow");
  auto step=std::make_shared<ExternalStep>(device);const NSUInteger chosen=revision;
  // Flow that is not ready within 100 ms gives way to the blend fallback.
  ExternalStep::schedule(step,commands,100,[reference,frame,forward,backward,chosen](std::shared_ptr<ExternalStep>step){
   __block bool forwardReady=false,backwardReady=false;auto previous=(__bridge CVPixelBufferRef)reference,next=(__bridge CVPixelBufferRef)frame;
   // Forward and backward requests run in parallel.
   dispatch_apply(2,externalQueue(),^(size_t index){@autoreleasepool{@try{const bool ready=vectors(index?next:previous,index?previous:next,chosen,index?backward:forward);if(index)backwardReady=ready;else forwardReady=ready;}@catch(NSException*){}}});
   step->complete(forwardReady&&backwardReady);
  });
  for(size_t i=0;i<outputs.size();++i){
   FlowParams params{phases.timestamps[i],gain,consistency,0};auto encoder=[commands computeCommandEncoder];if(!encoder)return rejected(sequence,"Cannot encode Vision optical-flow generation");
   [encoder setTexture:previousColor atIndex:0];[encoder setTexture:snapshot atIndex:1];[encoder setTexture:forward atIndex:2];[encoder setTexture:backward atIndex:3];[encoder setTexture:outputs[i] atIndex:4];
   [encoder setBytes:&params length:sizeof(params) atIndex:0];[encoder setBuffer:step->valid offset:0 atIndex:1];Kernels::dispatch(encoder,gpu->flow,unsigned(source.width),unsigned(source.height));[encoder endEncoding];
  }
  auto completed=std::make_shared<ImagePairReceipt>();completed->commands=commands;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>finished){(void)holders;(void)reference;(void)frame;(void)forward;(void)backward;(void)previousColor;(void)snapshot;completed->result.store(finished.status==MTLCommandBufferStatusCompleted?1:2);}];
  // These are encoded candidates. The completion receipt alone attests GPU-valid output.
  GenerationResult result;result.frameId=sequence;result.encoded=result.ready=true;result.generated=unsigned(outputs.size());result.historyFrames=2;
  result.completion=[completed]()->ShaderResult{const auto status=completed->status();if(status==1)return {true,{}};if(status==2)return {false,"Vision optical-flow commands failed or were abandoned"};return {false,"Vision optical flow is still in flight",true};};
  return result;
  }
 }
};
}
bool videoToolboxGenerationAvailable()noexcept{@try{if(@available(macOS 26.0,*))return videoToolbox().handle&&[NSClassFromString(@"VTLowLatencyFrameInterpolationConfiguration") isSupported];}@catch(NSException*){}return false;}
bool visionFlowGenerationAvailable()noexcept{return visionFramework()&&NSClassFromString(@"VNGenerateOpticalFlowRequest")&&NSClassFromString(@"VNImageRequestHandler");}
std::shared_ptr<GenerationEncoder>makeVideoToolboxGenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<VideoToolboxGeneration>(device,config);}
std::shared_ptr<GenerationEncoder>makeMetalFXImageGenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<MetalImageGeneration>(device,config);}
std::shared_ptr<GenerationEncoder>makeVisionFlowGenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<VisionFlowGeneration>(device,config);}
}
