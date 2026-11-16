// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-execution.hpp"
#include "metalfx-image-ingress.hpp"
#include "metal4-classic-bridge.hpp"
#include "scene-aovs.hpp"
#include "temporal-plan.hpp"
#include <mutex>
#include "source-timing.hpp"
#include "image-admission.hpp"
#include "image-color.hpp"
#include "color-island.hpp"
#include "image-pair-analysis.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace macfx {
ShaderResult completeGenerationEvent(const GenerationEvent&event)noexcept{
 try{for(const auto&complete:event.completions)if(complete){const auto result=complete();if(!result.encoded)return result;}return {true,{}};}
 catch(const std::exception&error){return {false,error.what()};}catch(...){return {false,"The generation provider did not complete this output"};}
}
std::function<ShaderResult()>encodeGenerationPair(id<MTLCommandBuffer>commands,const EffectGenerationStage&stage,id<MTLTexture>real,const ImagePairAnalysisKey&key,const std::vector<id<MTLTexture>>&generated,const InterpolationPlan&phases,bool ready){
 if(!stage.state||!stage.state->pairAnalysis)return {};
 ImagePairGenerated blend;
 if(ready&&stage.keepStaticContent){const size_t count=std::min<size_t>(phases.count,generated.size());blend.images.assign(generated.begin(),generated.begin()+count);blend.phases.assign(phases.timestamps.begin(),phases.timestamps.begin()+count);}
 auto analysis=stage.state->pairAnalysis->encode(commands,real,key,blend);
 if(analysis.result.encoded)return std::move(analysis.completion);
 return [result=std::move(analysis.result)]{return result;};
}
GenerationSequenceResult encodeGenerationSequence(const GenerationSequenceInput&input,uint64_t&eventSequence){
 GenerationSequenceResult output;
 auto fail=[&](const std::string&reason,bool busy=false){output.result={false,reason,busy};return output;};
 if(!input.commands||!input.source||!input.execution||!input.capacity||!input.image||!std::isfinite(input.timeMs)||!std::isfinite(input.durationMs)||input.durationMs<=0)
  return fail("Invalid generation sequence input");
 const auto&stages=input.execution->generationStages();
 // Display-limited suppression: an image that no refresh can show is never
 // generated. Every stage shares this one interval capacity.
 const unsigned capacity=input.displayImages?std::min(input.capacity,input.displayImages):input.capacity;
 const bool displayLimited=capacity<input.capacity;
 // Row cost: a provider's own GPU interval when it reports one; otherwise the
 // source command buffer, which the generation stages share (section 1).
 const bool costTiming=input.execution->rowCostRequested();std::vector<std::string>sharedCost;
 GenerationEvent initial;initial.image=input.source;initial.sourceFrameId=input.content.contentId?input.content.contentId:input.sourceFrameId;initial.eventId=++eventSequence;initial.displayMapped=input.displayMapped;
 std::vector<GenerationEvent>events{std::move(initial)};
 for(size_t index=0;index<stages.size();++index){
  const auto&stage=stages[index];
  const bool realOnly=!stage.encoder->acceptsSynthetic();
  unsigned remaining=1;for(size_t later=index+1;later<stages.size();++later){const unsigned multiplier=stages[later].graphics.generation->multiplier;remaining=remaining>capacity/multiplier?capacity:std::min(capacity,remaining*multiplier);}
  const unsigned available=std::max(unsigned(events.size()),capacity/remaining);
  const unsigned fanout=realOnly?std::min(stage.graphics.generation->multiplier,capacity):std::min(stage.graphics.generation->multiplier,std::max(1u,available/unsigned(events.size())));
  InterpolationPlan phases;phases.count=fanout-1;for(unsigned phase=0;phase<phases.count;++phase)phases.timestamps[phase]=float(phase+1)/fanout;
  if(realOnly){
   // A scene provider observes original real pairs. Earlier image-only phases
   // keep their own provenance; the later provider owns a coincident phase.
   events.erase(std::remove_if(events.begin(),events.end(),[&](const auto&event){if(!event.synthetic)return false;for(unsigned p=0;p<phases.count;++p)if(std::abs(event.phase-phases.timestamps[p])<1e-6)return true;return false;}),events.end());
   while(events.size()+phases.count>capacity){const auto removable=std::find_if(events.begin(),events.end(),[](const auto&event){return event.synthetic;});if(removable==events.end())return fail("The real scene interval exceeds its output capacity");events.erase(removable);}
  }
  if(!stage.state->admission){
   const auto bytes=stage.encoder->imageBytes(stage.width,stage.height,[&](unsigned w,unsigned h,unsigned pixel){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixel==1?MTLPixelFormatR8Unorm:pixel==8?MTLPixelFormatRGBA16Float:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return uint64_t([input.source.device heapTextureSizeAndAlignWithDescriptor:descriptor].size);});
   if(bytes){auto admitted=reserveImageBytes(input.source.device,bytes,input.owner,stage.id+"-generation-memory");admitted->commit();stage.state->admission=std::move(admitted);}
  }
  if(stage.state->admission)output.admissions.push_back(stage.state->admission);
  std::vector<GenerationEvent>expanded;expanded.reserve(capacity);double previousPhase=0;unsigned used=0;bool passedThrough=false;
  for(size_t position=0;position<events.size();++position){
   auto event=events[position];const bool eligible=!realOnly||!event.synthetic;const unsigned count=eligible?phases.count:0,base=unsigned(index%2)*capacity+used;used+=count+1;
   auto current=input.image(base+count,stage.width,stage.height);if(!current)return fail("Cannot allocate a generation interval image");
   if(index){
    ShaderFrame frame{input.commands,event.image,current,++stage.state->processingSequence,generationPhaseTime(input.timeMs,input.durationMs,event.phase),float(input.durationMs*(event.phase-previousPhase)),input.origin,spatialColorForDescription(input.color),nullptr,input.opaque};
    auto content=input.content;content.contentId=event.synthetic?event.eventId:content.contentId?content.contentId:input.sourceFrameId;content.synthetic=event.synthetic;content.displayMapped=event.displayMapped;content.qualityContentId=input.content.contentId?input.content.contentId:input.sourceFrameId;content.qualityEpoch=input.content.epoch?input.content.epoch:1;
    const auto encoded=input.execution->encodeGenerationSegment(frame,index,event.synthetic,&content,&event.displayMapped);if(!encoded.encoded)return fail(encoded.reason,encoded.busy);
   }else{
    auto copy=[input.commands blitCommandEncoder];if(!copy)return fail("Cannot retain the generation interval input");
    [copy copyFromTexture:event.image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(stage.width,stage.height,1) toTexture:current destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
   }
   if(!eligible||!phases.count){
    if(eligible){stage.state->skippedSource=true;const std::string reason=displayLimited?displayLimitedReason:"No generated phase fits this output interval";if(input.observe)input.observe(stage,RuntimeStatusPhase::Bypassed,reason);
     // The completion repeats the reason, so a stage's state after its
     // interval completes is this bypass rather than an older completion.
     if(!passedThrough)output.completions.push_back({index,[reason]{return ShaderResult{false,reason};}});passedThrough=true;}
    event.image=current;expanded.push_back(std::move(event));previousPhase=events[position].phase;continue;}
   std::vector<id<MTLTexture>>outputs;outputs.reserve(phases.count);for(unsigned phase=0;phase<phases.count;++phase)outputs.push_back(input.image(base+phase,stage.width,stage.height));
   if(stage.state->skippedSource){++stage.state->sequence;stage.state->skippedSource=false;}
   const auto previousEvent=stage.state->previousEventId;if(stage.encoder->requiresScene()){const auto scene=input.execution->bindGenerationScene(input.commands,index,current,input.content.scene,input.origin,index?nil:event.image);if(!scene.encoded)return fail(scene.reason,scene.busy);}
   const bool ownCost=costTiming&&stage.encoder->gpuTimingAvailable();
   const auto encoded=stage.encoder->encodeColorTimed(input.commands,current,outputs,++stage.state->sequence,phases,event.displayMapped,input.execution->generationGpuTimingRequested(index)||ownCost);
   if(input.observe&&(!encoded.encoded||!encoded.completion))input.observe(stage,encoded.encoded?RuntimeStatusPhase::Encoded:RuntimeStatusPhase::Bypassed,encoded.reason);
   if(!encoded.encoded)return fail(encoded.reason.empty()?"The generation interval is busy":encoded.reason,encoded.busy);
   if(encoded.ready){auto content=input.content;if(!content.contentId)content.contentId=input.sourceFrameId;if(!content.epoch)content.epoch=1;input.execution->recordGenerationGpuTiming(input.commands,index,content,encoded.gpuTiming);
    if(ownCost&&encoded.gpuTiming){const auto ticket=encoded.gpuTiming;const auto execution=input.execution;const auto stageId=stage.id;[input.commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status==MTLCommandBufferStatusCompleted)if(const auto ns=ticket())execution->recordRowCost(stageId,ns/1e6,false,0);}];}
    else if(costTiming&&std::find(sharedCost.begin(),sharedCost.end(),stage.id)==sharedCost.end())sharedCost.push_back(stage.id);}
   const ImagePairAnalysisKey key{previousEvent,event.eventId,event.sourceFrameId,input.content.epoch,input.content.imageRevision,input.origin,input.opaque,event.displayMapped};
   const auto pairCompletion=encodeGenerationPair(input.commands,stage,current,key,outputs,phases,encoded.ready);
   GenerationEvent ticket;ticket.completions=stage.state->previousCompletions;ticket.completions.insert(ticket.completions.end(),event.completions.begin(),event.completions.end());if(encoded.completion)ticket.completions.push_back(encoded.completion);if(pairCompletion&&encoded.ready)ticket.completions.push_back(pairCompletion);
   output.completions.push_back({index,[ticket=std::move(ticket)]{return completeGenerationEvent(ticket);}});
   stage.state->previousEventId=event.eventId;
   if(encoded.ready)for(unsigned phase=0;phase<phases.count;++phase){GenerationEvent generated;generated.image=outputs[phase];generated.phase=realOnly?phases.timestamps[phase]:previousPhase+(event.phase-previousPhase)*phases.timestamps[phase];generated.sourceFrameId=event.sourceFrameId;generated.eventId=++eventSequence;generated.previousEventId=previousEvent;generated.nextEventId=event.eventId;generated.synthetic=true;generated.displayMapped=stage.encoder->outputDisplayMapped(event.displayMapped);generated.provenance=event.provenance;generated.provenance.push_back(stage.id);generated.completions=stage.state->previousCompletions;generated.completions.insert(generated.completions.end(),event.completions.begin(),event.completions.end());if(encoded.completion)generated.completions.push_back(encoded.completion);if(pairCompletion)generated.completions.push_back(pairCompletion);expanded.push_back(std::move(generated));}
   stage.state->previousCompletions=event.completions;event.image=current;expanded.push_back(std::move(event));previousPhase=events[position].phase;
  }
  if(realOnly)std::stable_sort(expanded.begin(),expanded.end(),[](const auto&a,const auto&b){return a.phase<b.phase;});events=std::move(expanded);
 }
 if(events.empty()||events.back().synthetic||std::abs(events.back().phase-1)>1e-6)return fail("The generation interval lost its original real-frame endpoint");
 if(!sharedCost.empty()){const auto execution=input.execution;[input.commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status==MTLCommandBufferStatusCompleted)for(const auto&name:sharedCost)execution->recordRowCost(name,(completed.GPUEndTime-completed.GPUStartTime)*1000,true,1);}];}
 output.displayLimited=displayLimited&&capacity==1;output.events=std::move(events);output.result={true,{}};return output;
}
}

namespace macfx {
void observeCallerIntervalFallback(const RSTemporalFrame&frame,const ShaderResult&result){
 if(!runtimeStatusLeased())return;auto plan=currentEffectPlan();if(!plan)return;
 for(const auto&node:plan->nodes)if(node.enabled&&node.kind=="frame-generation"){RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(frame.owner);event.phase=result.busy?RuntimeStatusPhase::Preparing:RuntimeStatusPhase::Bypassed;event.processing=true;event.frameId=frame.frameId;event.planRevision=plan->revision;event.stageId=node.id;event.requestedMethod=node.method;event.activeMethod="metalfx";event.reason=result.reason;observeRuntimeStatus(event);}
}
static std::shared_ptr<EffectPlanSnapshot>callerIntervalPlan(std::string&reason){
 auto snapshot=currentEffectPlan();if(!snapshot||snapshot->mode!="advanced")return {};
 auto selected=std::make_shared<EffectPlanSnapshot>(*snapshot);selected->nodes.clear();selected->output={};selected->quality.reset();
 for(const auto&node:snapshot->nodes)if(node.enabled&&node.kind=="frame-generation")selected->nodes.push_back(node);
 if(selected->nodes.size()!=1){reason="A caller-owned midpoint requires exactly one enabled Frame generation row";return {};}
 if(selected->nodes.front().settings.number("frameMultiplier",2)!=2){reason="The SDK caller requests one midpoint; the enabled row requests another interval multiplier";return {};}
 return selected;
}
struct SdkIntervalBridgeState {std::shared_ptr<Metal4ClassicBridge>bridge;std::atomic<bool>ready{false},preparing{false};std::mutex mutex;std::string error;struct Slot{id<MTLTexture>image=nil;std::atomic<bool>busy{false};};std::array<std::shared_ptr<Slot>,4>slots;explicit SdkIntervalBridgeState(id<MTLDevice>device):bridge(std::make_shared<Metal4ClassicBridge>(device)){for(auto&slot:slots)slot=std::make_shared<Slot>();}};
struct SdkInterpolationProcessor::Impl {std::shared_ptr<CallerIntervalSourceOwnership>sourceClaim;EffectPlanExecutor plan;std::mutex mutex;void*owner=nullptr;std::shared_ptr<GenerationEncoder>nativeEncoder;std::string nativeRow,nativeMethod,nativeModel;std::map<std::string,EffectPlanScalar>nativeSettings;std::shared_ptr<SdkIntervalBridgeState>bridge;~Impl(){if(owner){rsReleaseTemporalSceneMatrices(owner);rsReleaseTemporalSceneAovs(owner);}}};
SdkInterpolationProcessor::SdkInterpolationProcessor():impl(std::make_unique<Impl>()){}
SdkInterpolationProcessor::~SdkInterpolationProcessor()=default;
ShaderResult SdkInterpolationProcessor::encode(const MetalFxImageInputs&input,const std::shared_ptr<const SceneAovLease>&metadata,bool*recorded,std::function<ShaderResult()>*completion){
 if(recorded)*recorded=false;
 if(!effectPlanDemands(PlanDemandGeneration))return {false,{}};
 std::string selectionReason;auto selected=callerIntervalPlan(selectionReason);if(!selected)return {false,selectionReason};
 const auto&row=selected->nodes.front();
 auto scene=input.frame;auto commands=(__bridge id<MTLCommandBuffer>)scene.commandBuffer;
 auto current=(__bridge id<MTLTexture>)scene.color,output=(__bridge id<MTLTexture>)scene.output,previous=input.previousColor;
 if(!commands||scene.commandBufferKind||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return {false,"The caller interval requires an unsubmitted retaining classic Metal command buffer"};
 const auto resolved=[&](id<MTLTexture>image){return image&&image.device==commands.device&&image.textureType==MTLTextureType2D&&image.sampleCount==1&&!image.framebufferOnly&&image.storageMode!=MTLStorageModeMemoryless;};
 for(auto image:{current,previous,output,input.depth,input.motion})if(!resolved(image))return {false,"The caller interval requires resolved readable images on its recording device"};
 if(!std::isfinite(scene.frameTimeMs)||scene.frameTimeMs<=0||!std::isfinite(scene.jitterX)||!std::isfinite(scene.jitterY)||!std::isfinite(scene.motionScaleX)||!std::isfinite(scene.motionScaleY))return {false,"The caller interval motion and duration must be finite"};
 if(!std::isfinite(input.aspectRatio)||input.aspectRatio<=0)return {false,"The caller interval camera aspect is invalid"};
 if(scene.flags&RS_TEMPORAL_DEPTH_INFINITE)scene.farPlane=0;
 if(scene.flags&RS_TEMPORAL_RESET)return {false,"The caller reset keeps its original interpolation encode"};
 if(previous==output||current==output||input.depth==output||input.motion==output||input.uiColor==output||previous.width!=current.width||previous.height!=current.height||previous.pixelFormat!=current.pixelFormat||output.pixelFormat!=current.pixelFormat||output.width!=current.width||output.height!=current.height)return {false,"The caller interval requires a complete matching real color pair and a distinct output"};
 if(input.distortion)return {false,"The caller distortion field needs an exact provider distortion binding"};
 if(input.outputRegion.x||input.outputRegion.y||input.outputRegion.width!=output.width||input.outputRegion.height!=output.height)return {false,"The caller interval output region is not a complete image"};
 if(input.depthRegion.x||input.depthRegion.y||input.motionRegion.x||input.motionRegion.y||input.depthRegion.width!=input.motionRegion.width||input.depthRegion.height!=input.motionRegion.height)return {false,"The caller interval guide regions cannot be represented by the selected scene provider"};
 scene.renderWidth=scene.maxRenderWidth=input.depthRegion.width;scene.renderHeight=scene.maxRenderHeight=input.depthRegion.height;
 scene.depth=(__bridge void*)input.depth;scene.motion=(__bridge void*)input.motion;
 if(!scene.renderWidth||!scene.renderHeight||input.depth.width<scene.renderWidth||input.depth.height<scene.renderHeight||input.motion.width<scene.renderWidth||input.motion.height<scene.renderHeight)return {false,"The caller interval guides do not cover their declared render extent"};
 if(row.method!="metalfx"&&std::abs(input.aspectRatio-float(current.width)/current.height)>1e-4f)return {false,"The caller camera aspect differs from the selected provider image contract"};
 std::unique_lock guard(impl->mutex,std::try_to_lock);if(!guard)return {false,"The caller interval owner is busy",true};
 impl->sourceClaim=reserveCallerIntervalSource(current,input.callerOutput?:output,impl->sourceClaim,selected->revision,row.id);
 if(!impl->sourceClaim)return {false,"The caller interval needs its current real image and requested output to be current drawables of the same presentation source; the original SDK encode is retained"};
 impl->owner=scene.owner;
 if(input.matricesValid&&rsBindTemporalSceneMatrices(&scene,&input.matrices)!=RS_TEMPORAL_OK)return {false,"The caller interval camera matrices could not be bound"};
 observeRuntimeFrameSource(reinterpret_cast<uintptr_t>(scene.owner),RuntimeFrameSource::RendererScene,temporalSceneInputMask(scene));
 std::shared_ptr<GenerationEncoder>encoder;std::shared_ptr<EffectExecution>execution;
 if(metadata){
  const auto color=readImageColor(metadata->value.color);
  if(imageColorIsHDR(color))scene.flags|=RS_TEMPORAL_HDR;else scene.flags&=~RS_TEMPORAL_HDR;
  if(bindSceneAovLease(scene,metadata)!=RS_TEMPORAL_OK)return {false,"The caller interval attachments no longer match"};
  impl->plan.setStatusContext(reinterpret_cast<uintptr_t>(scene.owner));
  ShaderFrame frame{commands,current,output,scene.frameId,0,scene.frameTimeMs,FrameOrigin::TopLeft,spatialColorForDescription(color),nullptr,color.alpha==ColorAlpha::Opaque};
  const auto prepared=impl->plan.prepareSceneContinuation(frame,&scene,imageColorLabel(color),color,selected,"sdk-owned-midpoint");
  if(prepared.holdPrevious||prepared.preparing||!prepared.execution)return {false,prepared.error.empty()?"The caller interval provider is preparing":prepared.error,true};
  const auto&stages=prepared.execution->generationStages();if(stages.size()!=1)return {false,"The selected generation row lacks required caller-interval inputs"};
  encoder=stages.front().encoder;execution=prepared.execution;
 }else{
  // Raw SDK color has no declared absolute color domain or opaque-alpha
  // contract. Only a provider that explicitly preserves that native domain
  // may consume it. No RGB profile or alpha metadata is synthesized here.
  if(!generationPreservesUnspecifiedColor(row.method))return {false,"The selected provider needs a declared source color encoding; the SDK call supplies none"};
  if(!impl->nativeEncoder||impl->nativeRow!=row.id||impl->nativeMethod!=row.method||impl->nativeModel!=row.modelPath||impl->nativeSettings!=row.settings.values){
   const auto config=effectRowGraphics(row);if(!config.generation)return {false,"The caller generation row has no valid provider configuration"};
   impl->nativeEncoder=makeGenerationEncoder(current.device,config.generationMethod,*config.generation);impl->nativeRow=row.id;impl->nativeMethod=row.method;impl->nativeModel=row.modelPath;impl->nativeSettings=row.settings.values;
  }
  encoder=impl->nativeEncoder;
  if(!encoder->acceptsUnspecifiedColor())return {false,"The selected provider needs a declared source color encoding; the SDK call supplies none"};
  auto ui=encoder->setIntervalUI(input.uiColor,input.uiComposited,input.aspectRatio);if(!ui.encoded)return ui;
  encoder->setSceneOrigin(FrameOrigin::TopLeft);
  const auto prepared=encoder->prepare(commands,current,&scene);if(!prepared.encoded)return {false,prepared.reason,prepared.busy};
 }
 if(!encoder->acceptsExplicitIntervals())return {false,"The selected provider does not accept an explicit caller-owned interval"};
 const auto ui=encoder->setIntervalUI(input.uiColor,input.uiComposited,input.aspectRatio);if(!ui.encoded)return ui;
 encoder->setScene(scene);encoder->setSceneOrigin(FrameOrigin::TopLeft);
 InterpolationPlan phases{};phases.count=1;phases.timestamps[0]=.5f;
 if(input.fence){auto wait=[commands computeCommandEncoder];if(!wait)return {false,"The caller interval fence encoder is unavailable"};[wait waitForFence:input.fence];[wait endEncoding];}
 const auto encoded=encoder->encodeInterval(commands,previous,current,{output},scene.frameId,phases);
 if(recorded)*recorded=encoded.encoded;if(completion)*completion=encoded.completion;
 const bool owned=encoded.encoded&&encoded.ready&&encoded.generated==1;
 if(encoded.encoded){
  auto retained=std::make_shared<MetalFxImageInputs>(input);auto complete=encoded.completion;auto sourceClaim=impl->sourceClaim;
  const auto context=reinterpret_cast<uintptr_t>(scene.owner);const auto revision=selected->revision,stageId=row.id,method=std::string(encoder->activeMethod());const auto frameId=scene.frameId;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>done){(void)retained;(void)metadata;(void)execution;(void)encoder;(void)sourceClaim;auto result=done.status==MTLCommandBufferStatusCompleted?(complete?complete():ShaderResult{true,{}}):ShaderResult{false,"The caller interpolation command buffer failed"};if(owned){RuntimeStatusEvent event;event.context=context;event.processing=event.generated=true;event.phase=result.encoded?RuntimeStatusPhase::Completed:RuntimeStatusPhase::Failed;event.frameId=frameId;event.planRevision=revision;event.stageId=stageId;event.activeMethod=method;event.reason=result.reason;observeRuntimeStatus(event);}}];
 }
 if(owned&&!input.callerOutput)impl->sourceClaim->consume();
 if(!owned)return {false,encoded.reason.empty()?"The selected provider did not encode the requested midpoint":encoded.reason,encoded.busy};
 if(input.fence){auto update=[commands computeCommandEncoder];[update updateFence:input.fence];[update endEncoding];}
 RuntimeStatusEvent event;event.context=reinterpret_cast<uintptr_t>(scene.owner);event.processing=event.generated=true;event.phase=RuntimeStatusPhase::Encoded;event.frameId=scene.frameId;event.planRevision=selected->revision;event.stageId=row.id;event.requestedMethod=row.method;event.activeMethod=encoder->activeMethod();observeRuntimeStatus(event);
 return {true,{}};
}

}
namespace macfx {
ShaderResult SdkInterpolationProcessor::encodeMetal4(id logical,const MetalFxImageInputs&input,const std::shared_ptr<const SceneAovLease>&metadata,bool*owned,Metal4OriginalOperation original,bool*originalEncoded){
 if(owned)*owned=false;
 if(!effectPlanDemands(PlanDemandGeneration))return {false,{}};
 if(!logical)return {false,"The Metal 4 caller interval recording is absent"};
 std::string selectionReason;auto selected=callerIntervalPlan(selectionReason);if(!selected)return {false,selectionReason};
 if(!metadata&&!generationPreservesUnspecifiedColor(selected->nodes.front().method))return {false,"The selected provider needs a declared source color encoding; the SDK call supplies none"};
 if(!input.previousColor||input.frame.flags&RS_TEMPORAL_RESET)return {false,"The caller interval keeps its original reset or missing-pair operation"};
 auto target=(__bridge id<MTLTexture>)input.frame.output;if(!target)return {false,"The Metal 4 caller interval output is absent"};
 impl->sourceClaim=reserveCallerIntervalSource((__bridge id<MTLTexture>)input.frame.color,target,impl->sourceClaim,selected->revision,selected->nodes.front().id);
 if(!impl->sourceClaim)return {false,"The caller interval lacks an exact observed presentation source; the original SDK encode is retained"};
 if(!impl->bridge)impl->bridge=std::make_shared<SdkIntervalBridgeState>(target.device);auto state=impl->bridge;
 if(!state->ready.load(std::memory_order_acquire)){
  if(!state->preparing.exchange(true)){static auto queue=dispatch_queue_create("org.maclauncher.graphics.sdk-interval.prepare",DISPATCH_QUEUE_SERIAL);dispatch_async(queue,^{@autoreleasepool{try{const auto result=state->bridge->prepare(4);{std::lock_guard guard(state->mutex);state->error=result.reason;}state->ready.store(result.encoded,std::memory_order_release);}catch(const std::exception&error){std::lock_guard guard(state->mutex);state->error=error.what();}state->preparing.store(false);}});}
  std::lock_guard guard(state->mutex);return {false,state->error.empty()?"Preparing the Metal 4 caller interval bridge":state->error,true};
 }
 std::shared_ptr<SdkIntervalBridgeState::Slot>slot;{std::lock_guard guard(state->mutex);for(auto&candidate:state->slots){bool free=false;if(candidate->busy.compare_exchange_strong(free,true)){slot=candidate;break;}}}
 if(!slot)return {false,"The Metal 4 caller interval pool is busy",true};
 struct Release{std::shared_ptr<SdkIntervalBridgeState::Slot>slot;bool accepted=false;~Release(){if(!accepted)slot->busy=false;}}release{slot};
 if(!slot->image||slot->image.width!=target.width||slot->image.height!=target.height||slot->image.pixelFormat!=target.pixelFormat){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:target.pixelFormat width:target.width height:target.height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;slot->image=newAdmittedTexture(target.device,descriptor,reinterpret_cast<uintptr_t>(input.frame.owner),"SDK caller interval output");if(!slot->image)return {false,"Cannot prepare the Metal 4 caller interval output"};}
 struct Flight{bool owned=false;std::function<ShaderResult()>complete;std::shared_ptr<MetalFxImageInputs>inputs;};auto flight=std::make_shared<Flight>();flight->inputs=std::make_shared<MetalFxImageInputs>(input);
 Metal4ClassicJob job;job.completeProducerImage=!original.record;job.recordOriginal=std::move(original.record);job.originalKept=std::move(original.kept);job.originalAbandoned=std::move(original.abandoned);job.isolateOriginal=bool(job.recordOriginal);job.producerFence=input.fence;
 job.mayOmitOriginal=[flight,allowed=std::move(original.mayOmit)]{return flight->owned&&allowed&&allowed();};job.omitOriginal=[flight,allowed=std::move(original.omit)]{return flight->owned&&allowed&&allowed();};
 job.encode=[this,flight,slot,metadata](id<MTLCommandBuffer>commands){auto copied=*flight->inputs;copied.frame.commandBuffer=(__bridge void*)commands;copied.frame.commandBufferKind=0;copied.callerOutput=(__bridge id<MTLTexture>)copied.frame.output;copied.frame.output=(__bridge void*)slot->image;copied.fence=nil;bool recorded=false;auto result=encode(copied,metadata,&recorded,&flight->complete);flight->owned=result.encoded;return recorded?ShaderResult{true,{}}:result;};
 job.completion=[flight]{return flight->complete?flight->complete():ShaderResult{true,{}};};
 job.publish=[flight,slot,target](id<MTLCommandBuffer>commands,bool success){if(!success||!flight->owned)return ShaderResult{true,{}};auto copy=[commands blitCommandEncoder];if(!copy)return ShaderResult{false,"The SDK interval publication encoder is unavailable"};[copy copyFromTexture:slot->image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(target.width,target.height,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];return ShaderResult{true,{}};};
 job.retired=[slot,flight,state](ShaderResult){slot->busy=false;};
 auto result=state->bridge->encode(logical,std::move(job),originalEncoded);release.accepted=result.encoded;if(result.encoded&&flight->owned)impl->sourceClaim->consume();if(owned)*owned=result.encoded&&flight->owned;return result;
}
}
