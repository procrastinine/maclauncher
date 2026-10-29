// Copyright (c) MacLauncher contributors. MIT license.
#include "video-frame.h"
#include "effects-execution.hpp"
#include "color-island.hpp"
#include "image-color.hpp"
#include "image-admission.hpp"
#include "generation-execution.hpp"
#include "comparison.hpp"
#include "output-color.hpp"
#include <condition_variable>
#include <chrono>
#include <mutex>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <stdexcept>
#include <limits>
#include <algorithm>
namespace {
const macfx::OutputPolicy automaticOutputPolicy;
void message(char *out,uint32_t capacity,const std::string &text){if(out&&capacity)std::snprintf(out,capacity,"%s",text.c_str());}
struct PreparationWait {std::mutex lock;std::condition_variable ready;uint64_t sequence=0;};
struct Video {
    id<MTLCommandQueue> queue;
    macfx::EffectPlanExecutor executor;
    std::shared_ptr<macfx::EffectExecution>lastExecution;
    std::mutex metadataLock;
    macfx::ColorEncoder colors;id<MTLTexture>working;
    id<MTLTexture>prefix,comparisonRaw,comparisonBefore,comparisonAfter,comparisonOutput;
    std::shared_ptr<PreparationWait>preparation=std::make_shared<PreparationWait>();
    std::vector<id<MTLTexture>>timeline,finishing;
    std::shared_ptr<macfx::ImageReservation>outputAdmission;
    uint64_t outputBytes=0;
    uint64_t eventSequence=0,lastSourceId=0;double lastSourceTime=0;
    RSVideoOutputColorStatus outputColorStatus{};
    std::mutex lock;
    explicit Video(id<MTLCommandQueue> value):queue(value),colors(value.device){
        executor.requireCompletePreparation(true);
        const std::weak_ptr<PreparationWait>weak=preparation;
        executor.setPreparationObserver([weak](const macfx::EffectPreparationNotice&){if(const auto state=weak.lock()){{std::lock_guard<std::mutex>guard(state->lock);state->sequence++;}state->ready.notify_all();}});
    }
    void accepted(const std::shared_ptr<macfx::EffectExecution>&execution){std::shared_ptr<macfx::EffectExecution>previous;{std::lock_guard<std::mutex>guard(metadataLock);previous=std::move(lastExecution);lastExecution=execution;}}
    void mapped(const macfx::OutputPolicy&policy,const macfx::OutputColorMapping&mapping,std::string_view reason={}){
        RSVideoOutputColorStatus status{};status.size=sizeof(status);status.version=1;
        std::snprintf(status.requested,sizeof(status.requested),"%s",policy.toneMapping.c_str());
        std::snprintf(status.active,sizeof(status.active),"%.*s",int(mapping.active.size()),mapping.active.data());
        if(reason.empty())reason=mapping.reason;if(!reason.empty())std::snprintf(status.reason,sizeof(status.reason),"%.*s",int(reason.size()),reason.data());
        std::lock_guard<std::mutex>guard(metadataLock);outputColorStatus=status;
    }
};
template<class Prepare>macfx::EffectExecutionSelection prepareOffline(Video&video,const macfx::ShaderFrame&frame,const Prepare&prepare){
    for(;;){
        uint64_t sequence;{std::lock_guard<std::mutex>guard(video.preparation->lock);sequence=video.preparation->sequence;}
        auto request=frame;request.commands=[video.queue commandBuffer];if(!request.commands)throw std::runtime_error("Cannot allocate offline preparation commands");
        const auto selected=prepare(request);
        if(!selected.preparing||(selected.qualityPreparing&&selected.execution&&!selected.holdPrevious))return selected;
        std::unique_lock<std::mutex>guard(video.preparation->lock);
        // The offline worker waits for the requested graph. Periodic reads
        // recover a missed notice without turning slow preparation into failure.
        video.preparation->ready.wait_for(guard,std::chrono::seconds(1),[&]{return video.preparation->sequence!=sequence;});
    }
}
uint64_t qualitySequence(const std::shared_ptr<macfx::EffectExecution>&execution){
    return execution&&execution->supportsGpuQuality(macfx::EffectQualityPoint::Offline)?execution->nextQualitySequence():0;
}
void observeQuality(const std::shared_ptr<macfx::EffectExecution>&execution,id<MTLCommandBuffer>commands,const RSVideoFrame&frame,uint64_t sequence){
    if(!execution||!sequence)return;
    const double start=commands.GPUStartTime,end=commands.GPUEndTime;
    if(commands.status!=MTLCommandBufferStatusCompleted||!std::isfinite(start)||!std::isfinite(end)||start<=0||end<=start)return;
    // This is the completed owned frame job, including its encoded output
    // phases. The execution admits it only when affected work is represented
    // by this command buffer; separate provider queues remain pending.
    macfx::AdaptiveQualitySample sample;sample.sequence=sequence;sample.contentId=frame.frameId;sample.epoch=1;sample.milliseconds=(end-start)*1000;
    execution->observeGpuQuality(sample,macfx::EffectQualityPoint::Offline,macfx::RuntimeAdaptiveQualityScope::OfflineFrame);
}
id<MTLTexture>videoImage(Video&video,id<MTLTexture> __strong &image,unsigned width,unsigned height,MTLPixelFormat format,const char*purpose){
    if(!image||image.width!=width||image.height!=height||image.pixelFormat!=format){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;image=macfx::newAdmittedTexture(video.queue.device,descriptor,reinterpret_cast<uintptr_t>(&video),purpose);}return image;
}
bool sameStorage(id<MTLTexture>a,id<MTLTexture>b){if(a==b)return true;for(unsigned i=0;a.parentTexture&&i<16;i++)a=a.parentTexture;for(unsigned i=0;b.parentTexture&&i<16;i++)b=b.parentTexture;return a==b||(a.iosurface&&a.iosurface==b.iosurface&&a.iosurfacePlane==b.iosurfacePlane);}
macfx::ShaderResult videoOutput(Video&video,id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,const macfx::ColorConversion&conversion){
    if(source.pixelFormat==target.pixelFormat&&source.width==target.width&&source.height==target.height&&macfx::sameImageColorDescription(conversion.source,conversion.target)&&conversion.toneMap==macfx::ColorToneMap::Preserve&&conversion.exposure==0&&!conversion.flipY&&!conversion.alphaSource&&!conversion.outputX&&!conversion.outputY&&!conversion.outputWidth&&!conversion.outputHeight){
        // An already encoded output needs no transfer curve or quantization.
        // Preserve its bits when Off or an identity sink copies separate storage.
        if(sameStorage(source,target))return {true,{}};
        auto copy=[commands blitCommandEncoder];if(!copy)return {false,"Cannot copy the video output"};
        [copy copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];return {true,{}};
    }
    return video.colors.encode(commands,source,target,conversion);
}
id<MTLTexture>comparisonSource(Video&video,id<MTLCommandBuffer>commands,id<MTLTexture>source,bool active){
    if(!active){video.comparisonRaw=nil;video.comparisonBefore=nil;video.comparisonAfter=nil;video.comparisonOutput=nil;return source;}
    auto retained=videoImage(video,video.comparisonRaw,source.width,source.height,source.pixelFormat,"video-comparison-source");auto encoder=[commands blitCommandEncoder];if(!encoder)throw std::runtime_error("Cannot retain the video comparison source");[encoder copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:retained destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[encoder endEncoding];return retained;
}
id<MTLTexture>compareVideo(Video&video,const std::shared_ptr<macfx::EffectExecution>&execution,id<MTLCommandBuffer>commands,id<MTLTexture>raw,id<MTLTexture>processed,const macfx::ImageColorDescription&sourceColor,const macfx::ImageColorDescription&targetColor,uint64_t frameId,macfx::ImageColorDescription&encodedColor,bool&displayMapped){
    if(!execution||!execution->outputPolicy().comparison.active())return processed;
    const auto comparison=execution->comparison();if(!comparison)throw std::runtime_error("The video comparison resources have not been prepared");
    auto before=videoImage(video,video.comparisonBefore,processed.width,processed.height,MTLPixelFormatRGBA16Float,"video-comparison-before"),after=videoImage(video,video.comparisonAfter,processed.width,processed.height,MTLPixelFormatRGBA16Float,"video-comparison-after"),target=videoImage(video,video.comparisonOutput,processed.width,processed.height,MTLPixelFormatRGBA16Float,"video-comparison-output");
    const auto mapping=macfx::outputColorMapping(execution->outputPolicy().toneMapping,sourceColor,targetColor,displayMapped);std::string_view reason;
    const auto result=comparison->encodeAligned(commands,raw,processed,before,after,target,execution->outputPolicy().comparison,sourceColor,targetColor,false,displayMapped,frameId,&encodedColor,execution->outputPolicy().toneMapping,&reason);if(!result.encoded)throw std::runtime_error(result.reason);video.mapped(execution->outputPolicy(),mapping,reason);displayMapped=true;return target;
}
}
extern "C" uint32_t rsVideoComparisonAPI(void){return 1;}
extern "C" uint32_t rsOutputColorAPI(void){return 1;}
extern "C" int rsVideoGetOutputColorStatus(void*handle,RSVideoOutputColorStatus*request){
    if(!handle||!request||request->size<sizeof(*request)||request->version!=1)return -1;
    auto&video=*static_cast<Video*>(handle);std::lock_guard<std::mutex>guard(video.metadataLock);
    if(!video.outputColorStatus.requested[0]||!std::strcmp(video.outputColorStatus.requested,"auto"))return 0;
    *request=video.outputColorStatus;return 1;
}
extern "C" void *rsVideoCreate(void *queue,char *error,uint32_t capacity){
    @autoreleasepool {try {
        if(!queue)throw std::runtime_error("A Metal command queue is required for video export");
        return new Video((__bridge id<MTLCommandQueue>)queue);
    }catch(const std::exception &problem){message(error,capacity,problem.what());return nullptr;}}
}
extern "C" void rsVideoRelease(void *handle){delete static_cast<Video*>(handle);}
extern "C" int rsVideoGetQualityStatus(void*handle,RSVideoQualityStatus*request){
    if(!handle||!request||request->size<sizeof(*request)||request->version!=1)return -1;
    auto&video=*static_cast<Video*>(handle);std::shared_ptr<macfx::EffectExecution>execution;
    {std::lock_guard<std::mutex>guard(video.metadataLock);execution=video.lastExecution;}
    const auto value=execution?execution->qualityStatus():video.executor.qualityStatus();
    if(!value.requested)return 0;
    *request={};request->size=sizeof(*request);request->version=1;
    request->state=value.reason.empty()&&value.meanMilliseconds>0?RS_VIDEO_QUALITY_ACTIVE:RS_VIDEO_QUALITY_PENDING;
    request->scope=uint32_t(value.scope);request->scale=value.scale;request->meanMilliseconds=value.meanMilliseconds;
    std::snprintf(request->nodeId,sizeof(request->nodeId),"%s",value.nodeId.c_str());
    auto length=std::min(value.reason.size(),sizeof(request->reason)-1);
    while(length&&length<value.reason.size()&&(static_cast<unsigned char>(value.reason[length])&0xc0)==0x80)--length;
    std::memcpy(request->reason,value.reason.data(),length);return 1;
}
static int processVideo(void *handle,const RSVideoFrame *request,char *error,uint32_t capacity,const RSImageColorDescription*sourceColor=nullptr,const RSImageColorDescription*outputColor=nullptr){
    @autoreleasepool {id<MTLCommandBuffer> commands=nil;try {
        if(!handle||!request||request->size<sizeof(RSVideoFrame)||request->version!=1||!request->sourceTexture||!request->outputTexture||
            !std::isfinite(request->timeMs)||!std::isfinite(request->frameTimeMs)||request->frameTimeMs<=0)
            throw std::runtime_error("Invalid offline video frame");
        auto &video=*static_cast<Video*>(handle);std::lock_guard<std::mutex> guard(video.lock);
        auto source=(__bridge id<MTLTexture>)request->sourceTexture,target=(__bridge id<MTLTexture>)request->outputTexture;
        if(source.device!=video.queue.device||target.device!=video.queue.device||!macfx::SpatialEncoder::supportsFormat(source.pixelFormat)||!macfx::SpatialEncoder::supportsFormat(target.pixelFormat)||(!sourceColor&&(source.pixelFormat!=MTLPixelFormatBGRA8Unorm||target.pixelFormat!=MTLPixelFormatBGRA8Unorm)))
            throw std::runtime_error("Video export requires supported RGB images and matching explicit color metadata");
        std::optional<macfx::ImageColorDescription>inputDescription,targetDescription;if(sourceColor&&outputColor){inputDescription=macfx::readImageColor(*sourceColor);targetDescription=macfx::readImageColor(*outputColor);}else if(sourceColor||outputColor)throw std::runtime_error("Both video color descriptions are required");
        id<MTLTexture>graphTarget=target;
        const bool convert=inputDescription&&(!macfx::sameImageColorDescription(*inputDescription,*targetDescription)||source.pixelFormat!=target.pixelFormat);
        if(convert){const auto format=source.pixelFormat==MTLPixelFormatRGBA16Float||macfx::imageColorIsHDR(*inputDescription)?MTLPixelFormatRGBA16Float:MTLPixelFormatBGRA8Unorm;if(!video.working||video.working.width!=target.width||video.working.height!=target.height||video.working.pixelFormat!=format){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:target.width height:target.height mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;video.working=macfx::newAdmittedTexture(video.queue.device,d,0,"video-color-memory");}graphTarget=video.working;}
        commands=[video.queue commandBuffer];if(!commands)throw std::runtime_error("Cannot allocate a video command buffer");
        macfx::ShaderFrame frame{commands,source,graphTarget,request->frameId,request->timeMs,request->frameTimeMs};frame.opaqueDisplay=true;
        const auto selection=prepareOffline(video,frame,[&](const macfx::ShaderFrame&request){return inputDescription?video.executor.prepareWithColorDescription(request,false,nullptr,macfx::imageColorLabel(*inputDescription),*inputDescription):video.executor.prepare(request);});
        if(!selection.error.empty())throw std::runtime_error(selection.error);
        if(selection.holdPrevious)throw std::runtime_error("The current video frame contract could not be prepared");
        const auto execution=selection.active?selection.execution:nullptr;
        video.accepted(execution);
        if(selection.active&&!execution)throw std::runtime_error("The video graphics plan could not be prepared");
        const auto sourceDescription=inputDescription.value_or(macfx::ImageColorDescription{}),outputDescription=targetDescription.value_or(macfx::ImageColorDescription{});
        const auto&policy=execution?execution->outputPolicy():automaticOutputPolicy;
        if(policy.toneMapping!="auto"&&graphTarget==target){graphTarget=videoImage(video,video.working,target.width,target.height,target.pixelFormat,"video-output-color");frame.target=graphTarget;}
        const bool comparing=execution&&execution->outputPolicy().comparison.active();
        auto raw=comparisonSource(video,commands,source,comparing||(!execution&&convert&&sameStorage(source,target)));bool displayMapped=false;
        const auto encoded=execution?execution->encode(frame,false,false,false,&displayMapped):macfx::ShaderResult{true,{},false};
        auto final=execution?graphTarget:raw;auto finalDescription=sourceDescription;
        if(encoded.encoded&&comparing)final=compareVideo(video,execution,commands,raw,final,sourceDescription,outputDescription,request->frameId,finalDescription,displayMapped);
        const auto mapping=macfx::outputColorMapping(policy.toneMapping,finalDescription,outputDescription,displayMapped);if(!comparing)video.mapped(policy,mapping);
        if(encoded.encoded&&(convert||comparing||policy.toneMapping!="auto"||(!execution&&!sameStorage(final,target)))){macfx::ColorConversion conversion;conversion.source=finalDescription;conversion.target=outputDescription;conversion.headroom=std::max(1.f,outputDescription.peakLuminance/outputDescription.referenceWhite);conversion.frameId=request->frameId;conversion.toneMap=comparing?macfx::ColorToneMap::Preserve:mapping.toneMap;if(target.pixelFormat==MTLPixelFormatBGRA8Unorm||target.pixelFormat==MTLPixelFormatRGBA8Unorm)conversion.ditherBits=8;const auto converted=videoOutput(video,commands,final,target,conversion);if(!converted.encoded)throw std::runtime_error(converted.reason);}
        // Producer events must be submitted even when a later row fails.
        const auto measurement=qualitySequence(execution);
        [commands commit];[commands waitUntilCompleted];
        if(commands.status!=MTLCommandBufferStatusCompleted)throw std::runtime_error(commands.error.localizedDescription.UTF8String?:"Video GPU processing failed");
        if(!encoded.encoded)throw std::runtime_error(encoded.reason.empty()?"The video graphics plan could not process a frame":encoded.reason);
        const auto complete=execution?execution->finishOffline():macfx::ShaderResult{true,{},false};
        if(!complete.encoded)throw std::runtime_error(complete.reason);
        observeQuality(execution,commands,*request,measurement);
        return 0;
    }catch(const std::exception &problem){
        if(commands&&commands.status<MTLCommandBufferStatusCommitted){[commands commit];[commands waitUntilCompleted];}
        message(error,capacity,problem.what());return 1;
    }}
}
extern "C" int rsVideoProcess(void*handle,const RSVideoFrame*request,char*error,uint32_t capacity){return processVideo(handle,request,error,capacity);}
extern "C" int rsVideoProcessColor(void*handle,const RSVideoFrame*request,const RSImageColorDescription*source,const RSImageColorDescription*target,char*error,uint32_t capacity){if(!source||!target){message(error,capacity,"Both video color descriptions are required");return 1;}return processVideo(handle,request,error,capacity,source,target);}
extern "C" int rsVideoProcessSequence(void *handle,const RSVideoFrame *request,RSVideoSequence *sequence,const RSImageColorDescription *sourceColor,const RSImageColorDescription *targetColor,char *error,uint32_t capacity){
 @autoreleasepool {id<MTLCommandBuffer>commands=nil;try{
  if(!handle||!request||request->size<sizeof(*request)||request->version!=1||!request->sourceTexture||!request->outputTexture||!request->frameId||
    !std::isfinite(request->timeMs)||!std::isfinite(request->frameTimeMs)||request->frameTimeMs<=0||!sequence||sequence->size<sizeof(*sequence)||sequence->version!=1||sequence->reserved)
   throw std::runtime_error("Invalid offline video sequence");
  auto &video=*static_cast<Video*>(handle);std::lock_guard<std::mutex>guard(video.lock);
  sequence->count=0;sequence->previousTimeMs=video.lastSourceId?video.lastSourceTime:request->timeMs;
  if(video.lastSourceId&&(request->frameId<=video.lastSourceId||request->timeMs<=video.lastSourceTime))throw std::runtime_error("Video source identities and timestamps must increase");
  auto source=(__bridge id<MTLTexture>)request->sourceTexture,target=(__bridge id<MTLTexture>)request->outputTexture;
  if(source.device!=video.queue.device||target.device!=video.queue.device||!macfx::SpatialEncoder::supportsFormat(source.pixelFormat)||!macfx::SpatialEncoder::supportsFormat(target.pixelFormat))throw std::runtime_error("Video sequence images require one device and supported RGB formats");
  if(bool(sourceColor)!=bool(targetColor))throw std::runtime_error("Both video color descriptions are required");
  auto inputDescription=sourceColor?macfx::readImageColor(*sourceColor):macfx::ImageColorDescription{},outputDescription=targetColor?macfx::readImageColor(*targetColor):macfx::ImageColorDescription{};
  if(!sourceColor&&(source.pixelFormat!=MTLPixelFormatBGRA8Unorm||target.pixelFormat!=MTLPixelFormatBGRA8Unorm))throw std::runtime_error("Floating-point video requires explicit color metadata");
  auto allocate=[&](id<MTLTexture> __strong &image,unsigned w,unsigned h,MTLPixelFormat format,const std::string&purpose){
   if(!image||image.width!=w||image.height!=h||image.pixelFormat!=format){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;image=macfx::newAdmittedTexture(video.queue.device,descriptor,reinterpret_cast<uintptr_t>(handle),purpose);}
   return image;
  };
  const auto format=source.pixelFormat==MTLPixelFormatRGBA16Float||macfx::imageColorIsHDR(inputDescription)?MTLPixelFormatRGBA16Float:MTLPixelFormatBGRA8Unorm;
  auto working=allocate(video.working,target.width,target.height,format,"video-sequence-memory");
  commands=[video.queue commandBuffer];if(!commands)throw std::runtime_error("Cannot allocate video sequence commands");
  macfx::ShaderFrame preparation{commands,source,working,request->frameId,request->timeMs,request->frameTimeMs};preparation.opaqueDisplay=true;
  // The offline writer owns an output timeline, just as a live presenter does.
  const auto selected=prepareOffline(video,preparation,[&](const macfx::ShaderFrame&frame){return sourceColor?video.executor.prepareWithColorDescription(frame,true,nullptr,macfx::imageColorLabel(inputDescription),inputDescription):video.executor.prepare(frame,true);});
  if(!selected.error.empty())throw std::runtime_error(selected.error);if(selected.holdPrevious)throw std::runtime_error("The video sequence frame contract could not be prepared");if(selected.active&&!selected.execution)throw std::runtime_error("The video sequence graphics plan is unavailable");
  const auto execution=selected.active?selected.execution:nullptr;video.accepted(execution);uint32_t required=1;
  const auto&outputPolicy=execution?execution->outputPolicy():automaticOutputPolicy;
  if(!execution)video.mapped(outputPolicy,macfx::outputColorMapping("auto",inputDescription,outputDescription,false));
  const auto snapshot=video.executor.snapshot();
  if(execution&&snapshot&&std::count_if(snapshot->nodes.begin(),snapshot->nodes.end(),[](const auto&node){return node.enabled&&node.kind=="frame-generation";})!=execution->generationStages().size())throw std::runtime_error("The video timeline could not prepare every selected generator");
  if(execution)for(const auto&stage:execution->generationStages()){
   if(stage.encoder->requiresScene())throw std::runtime_error("This generator requires matched scene inputs from a renderer");
   const auto multiplier=stage.graphics.generation->multiplier;
   if(!multiplier||required>std::numeric_limits<uint32_t>::max()/multiplier)throw std::runtime_error("The video generation interval exceeds the output count format");required*=multiplier;
  }
  sequence->multiplier=required;
  // Reserve the caller's entire output batch before allocating its IOSurfaces.
  // This is a resource envelope, independent of a display's timeline capacity.
  auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:target.pixelFormat width:target.width height:target.height mipmapped:NO];descriptor.storageMode=target.storageMode;descriptor.usage=target.usage;
  const uint64_t imageBytes=[video.queue.device heapTextureSizeAndAlignWithDescriptor:descriptor].size;
  if(imageBytes&&required>std::numeric_limits<uint64_t>::max()/imageBytes)throw std::runtime_error("The video output image reservation overflowed");
  if(video.outputBytes!=imageBytes*required||!video.outputAdmission){auto reservation=macfx::reserveImageBytes(video.queue.device,imageBytes*required,reinterpret_cast<uintptr_t>(handle),"video-output-batch");reservation->commit();video.outputAdmission=std::move(reservation);video.outputBytes=imageBytes*required;}
  if(!sequence->outputs){sequence->capacity=required;return 0;}
  if(sequence->capacity<required)throw std::runtime_error("The video sequence output capacity is too small");
  for(unsigned index=0;index<required;++index){auto image=(__bridge id<MTLTexture>)sequence->outputs[index].texture;
   if(!image||image.device!=target.device||image.width!=target.width||image.height!=target.height||image.pixelFormat!=target.pixelFormat||sequence->outputs[index].reserved)throw std::runtime_error("A video sequence output image differs from its declared target");}
  if(!execution){
   auto output=(__bridge id<MTLTexture>)sequence->outputs[0].texture;macfx::ColorConversion conversion;conversion.source=inputDescription;conversion.target=outputDescription;conversion.frameId=request->frameId;conversion.headroom=std::max(1.f,outputDescription.peakLuminance/outputDescription.referenceWhite);conversion.toneMap=macfx::outputColorMapping("auto",inputDescription,outputDescription,false).toneMap;if(output.pixelFormat==MTLPixelFormatBGRA8Unorm||output.pixelFormat==MTLPixelFormatRGBA8Unorm)conversion.ditherBits=8;const bool alias=sameStorage(source,output),conversionNeeded=!macfx::sameImageColorDescription(inputDescription,outputDescription);if(!alias||conversionNeeded){auto original=comparisonSource(video,commands,source,alias);const auto converted=videoOutput(video,commands,original,output,conversion);if(!converted.encoded)throw std::runtime_error(converted.reason);}[commands commit];[commands waitUntilCompleted];if(commands.status!=MTLCommandBufferStatusCompleted)throw std::runtime_error(commands.error.localizedDescription.UTF8String?:"Video copy GPU processing failed");sequence->outputs[0].phase=1;sequence->outputs[0].flags=0;sequence->count=1;video.lastSourceId=request->frameId;video.lastSourceTime=request->timeMs;return 0;
  }
  auto raw=comparisonSource(video,commands,source,execution->outputPolicy().comparison.active());
  auto prefix=allocate(video.prefix,execution->generationWidth(),execution->generationHeight(),format,"video-sequence-prefix");
  macfx::ImageContentStamp content{request->frameId,1,request->frameId,1,false,false};
  macfx::ShaderFrame prefixFrame{commands,source,prefix,request->frameId,request->timeMs,request->frameTimeMs};prefixFrame.opaqueDisplay=true;bool mapped=false;
  const auto encoded=execution->encodeContentImage(prefixFrame,content,false,false,&mapped);if(!encoded.encoded)throw std::runtime_error(encoded.reason);
  macfx::GenerationSequenceInput input;input.commands=commands;input.source=prefix;input.execution=execution;input.capacity=required;input.owner=reinterpret_cast<uintptr_t>(handle);input.sourceFrameId=request->frameId;
  input.timeMs=request->timeMs;input.durationMs=video.lastSourceId?request->timeMs-video.lastSourceTime:request->frameTimeMs;input.color=inputDescription;input.content=content;input.opaque=true;input.displayMapped=mapped;
  input.image=[&](unsigned slot,unsigned w,unsigned h){if(slot>=uint64_t(required)*2)throw std::runtime_error("The video generation storage exceeded its admitted output batch");if(video.timeline.size()<=slot)video.timeline.resize(slot+1);return allocate(video.timeline[slot],w,h,format,"video-generation-interval");};
  auto generated=macfx::encodeGenerationSequence(input,video.eventSequence);if(!generated.result.encoded)throw std::runtime_error(generated.result.reason);
  if(video.finishing.size()<generated.events.size())video.finishing.resize(generated.events.size());
  for(unsigned index=0;index<generated.events.size();++index){const auto&event=generated.events[index];auto output=(__bridge id<MTLTexture>)sequence->outputs[index].texture;auto final=allocate(video.finishing[index],target.width,target.height,format,"video-sequence-finishing");
   auto stamp=content;stamp.contentId=event.synthetic?event.eventId:content.contentId;stamp.synthetic=event.synthetic;stamp.displayMapped=event.displayMapped;
   macfx::ShaderFrame frame{commands,event.image,final,stamp.contentId,input.timeMs-input.durationMs*(1-event.phase),float(input.durationMs/required)};frame.opaqueDisplay=true;bool displayMapped=event.displayMapped;
   const auto suffix=execution->encodeContentImage(frame,stamp,true,false,&displayMapped);if(!suffix.encoded)throw std::runtime_error(suffix.reason);
   auto finalDescription=inputDescription;final=compareVideo(video,execution,commands,raw,final,inputDescription,outputDescription,stamp.contentId,finalDescription,displayMapped);
   macfx::ColorConversion conversion;conversion.source=finalDescription;conversion.target=outputDescription;conversion.frameId=stamp.contentId;conversion.headroom=std::max(1.f,outputDescription.peakLuminance/outputDescription.referenceWhite);
   if(!outputPolicy.comparison.active()){const auto mapping=macfx::outputColorMapping(outputPolicy.toneMapping,finalDescription,outputDescription,displayMapped);conversion.toneMap=mapping.toneMap;video.mapped(outputPolicy,mapping);}
   if(output.pixelFormat==MTLPixelFormatBGRA8Unorm||output.pixelFormat==MTLPixelFormatRGBA8Unorm)conversion.ditherBits=8;
   const auto converted=videoOutput(video,commands,final,output,conversion);if(!converted.encoded)throw std::runtime_error(converted.reason);
   sequence->outputs[index].phase=event.phase;sequence->outputs[index].flags=event.synthetic?RS_VIDEO_OUTPUT_GENERATED:0;
  }
  const auto measurement=qualitySequence(execution);
  [commands commit];[commands waitUntilCompleted];if(commands.status!=MTLCommandBufferStatusCompleted)throw std::runtime_error(commands.error.localizedDescription.UTF8String?:"Video sequence GPU processing failed");
  const auto finished=execution->finishOffline();if(!finished.encoded)throw std::runtime_error(finished.reason);
  unsigned delivered=0;
  for(unsigned index=0;index<generated.events.size();++index){
   if(generated.events[index].synthetic&&!macfx::completeGenerationEvent(generated.events[index]).encoded)continue;
   sequence->outputs[delivered++]=sequence->outputs[index];
  }
  observeQuality(execution,commands,*request,measurement);
  sequence->count=delivered;video.lastSourceId=request->frameId;video.lastSourceTime=request->timeMs;return 0;
 }catch(const std::exception&problem){if(commands&&commands.status<MTLCommandBufferStatusCommitted){[commands commit];[commands waitUntilCompleted];}message(error,capacity,problem.what());return 1;}}
}
