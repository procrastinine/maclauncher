// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-execution.hpp"
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
GenerationSequenceResult encodeGenerationSequence(const GenerationSequenceInput&input,uint64_t&eventSequence){
 GenerationSequenceResult output;
 auto fail=[&](const std::string&reason,bool busy=false){output.result={false,reason,busy};return output;};
 if(!input.commands||!input.source||!input.execution||!input.capacity||!input.image||!std::isfinite(input.timeMs)||!std::isfinite(input.durationMs)||input.durationMs<=0)
  return fail("Invalid generation sequence input");
 const auto&stages=input.execution->generationStages();
 GenerationEvent initial;initial.image=input.source;initial.sourceFrameId=input.content.contentId?input.content.contentId:input.sourceFrameId;initial.eventId=++eventSequence;initial.displayMapped=input.displayMapped;
 std::vector<GenerationEvent>events{std::move(initial)};
 for(size_t index=0;index<stages.size();++index){
  const auto&stage=stages[index];
  const bool realOnly=!stage.encoder->acceptsSynthetic();
  unsigned remaining=1;for(size_t later=index+1;later<stages.size();++later){const unsigned multiplier=stages[later].graphics.generation->multiplier;remaining=remaining>input.capacity/multiplier?input.capacity:std::min(input.capacity,remaining*multiplier);}
  const unsigned available=std::max(unsigned(events.size()),input.capacity/remaining);
  const unsigned fanout=realOnly?std::min(stage.graphics.generation->multiplier,input.capacity):std::min(stage.graphics.generation->multiplier,std::max(1u,available/unsigned(events.size())));
  InterpolationPlan phases;phases.count=fanout-1;for(unsigned phase=0;phase<phases.count;++phase)phases.timestamps[phase]=float(phase+1)/fanout;
  if(realOnly){
   // A scene provider observes original real pairs. Earlier image-only phases
   // keep their own provenance; the later provider owns a coincident phase.
   events.erase(std::remove_if(events.begin(),events.end(),[&](const auto&event){if(!event.synthetic)return false;for(unsigned p=0;p<phases.count;++p)if(std::abs(event.phase-phases.timestamps[p])<1e-6)return true;return false;}),events.end());
   while(events.size()+phases.count>input.capacity){const auto removable=std::find_if(events.begin(),events.end(),[](const auto&event){return event.synthetic;});if(removable==events.end())return fail("The real scene interval exceeds its output capacity");events.erase(removable);}
  }
  if(!stage.state->admission){
   const auto bytes=stage.encoder->imageBytes(stage.width,stage.height,[&](unsigned w,unsigned h,unsigned pixel){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixel==1?MTLPixelFormatR8Unorm:pixel==8?MTLPixelFormatRGBA16Float:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return uint64_t([input.source.device heapTextureSizeAndAlignWithDescriptor:descriptor].size);});
   if(bytes){auto admitted=reserveImageBytes(input.source.device,bytes,input.owner,stage.id+"-generation-memory");admitted->commit();stage.state->admission=std::move(admitted);}
  }
  if(stage.state->admission)output.admissions.push_back(stage.state->admission);
  std::vector<GenerationEvent>expanded;expanded.reserve(input.capacity);double previousPhase=0;unsigned used=0;
  for(size_t position=0;position<events.size();++position){
   auto event=events[position];const bool eligible=!realOnly||!event.synthetic;const unsigned count=eligible?phases.count:0,base=unsigned(index%2)*input.capacity+used;used+=count+1;
   auto current=input.image(base+count,stage.width,stage.height);if(!current)return fail("Cannot allocate a generation interval image");
   if(index){
    ShaderFrame frame{input.commands,event.image,current,++stage.state->processingSequence,input.timeMs-input.durationMs*(1-event.phase),float(input.durationMs*(event.phase-previousPhase)),input.origin,spatialColorForDescription(input.color),nullptr,input.opaque};
    auto content=input.content;content.contentId=event.synthetic?event.eventId:content.contentId?content.contentId:input.sourceFrameId;content.synthetic=event.synthetic;content.displayMapped=event.displayMapped;content.qualityContentId=input.content.contentId?input.content.contentId:input.sourceFrameId;content.qualityEpoch=input.content.epoch?input.content.epoch:1;
    const auto encoded=input.execution->encodeGenerationSegment(frame,index,event.synthetic,&content,&event.displayMapped);if(!encoded.encoded)return fail(encoded.reason,encoded.busy);
   }else{
    auto copy=[input.commands blitCommandEncoder];if(!copy)return fail("Cannot retain the generation interval input");
    [copy copyFromTexture:event.image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(stage.width,stage.height,1) toTexture:current destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
   }
   if(!eligible||!phases.count){if(eligible){stage.state->skippedSource=true;if(input.observe)input.observe(stage,RuntimeStatusPhase::Bypassed,"No generated phase fits this output interval");}event.image=current;expanded.push_back(std::move(event));previousPhase=events[position].phase;continue;}
   std::vector<id<MTLTexture>>outputs;outputs.reserve(phases.count);for(unsigned phase=0;phase<phases.count;++phase)outputs.push_back(input.image(base+phase,stage.width,stage.height));
   if(stage.state->skippedSource){++stage.state->sequence;stage.state->skippedSource=false;}
   const auto previousEvent=stage.state->previousEventId;if(stage.encoder->requiresScene()){const auto scene=input.execution->bindGenerationScene(input.commands,index,current,input.content.scene,input.origin,index?nil:event.image);if(!scene.encoded)return fail(scene.reason,scene.busy);}
   const auto encoded=stage.encoder->encodeColorTimed(input.commands,current,outputs,++stage.state->sequence,phases,event.displayMapped,input.execution->generationGpuTimingRequested(index));
   if(input.observe)input.observe(stage,encoded.encoded?RuntimeStatusPhase::Encoded:RuntimeStatusPhase::Bypassed,encoded.reason);
   if(!encoded.encoded)return fail(encoded.reason.empty()?"The generation interval is busy":encoded.reason,encoded.busy);
   if(encoded.ready){auto content=input.content;if(!content.contentId)content.contentId=input.sourceFrameId;if(!content.epoch)content.epoch=1;input.execution->recordGenerationGpuTiming(input.commands,index,content,encoded.gpuTiming);}
   std::function<ShaderResult()>pairCompletion;
   if(stage.state->pairAnalysis){
    const ImagePairAnalysisKey key{previousEvent,event.eventId,event.sourceFrameId,input.content.epoch,input.content.imageRevision,input.origin,input.opaque,event.displayMapped};
    auto analysis=stage.state->pairAnalysis->encode(input.commands,current,key);
    pairCompletion=analysis.result.encoded?std::move(analysis.completion):[result=std::move(analysis.result)]{return result;};
   }
   GenerationEvent ticket;ticket.completions=stage.state->previousCompletions;ticket.completions.insert(ticket.completions.end(),event.completions.begin(),event.completions.end());if(encoded.completion)ticket.completions.push_back(encoded.completion);if(pairCompletion&&encoded.ready)ticket.completions.push_back(pairCompletion);
   output.completions.push_back({index,[ticket=std::move(ticket)]{return completeGenerationEvent(ticket);}});
   stage.state->previousEventId=event.eventId;
   if(encoded.ready)for(unsigned phase=0;phase<phases.count;++phase){GenerationEvent generated;generated.image=outputs[phase];generated.phase=realOnly?phases.timestamps[phase]:previousPhase+(event.phase-previousPhase)*phases.timestamps[phase];generated.sourceFrameId=event.sourceFrameId;generated.eventId=++eventSequence;generated.previousEventId=previousEvent;generated.nextEventId=event.eventId;generated.synthetic=true;generated.displayMapped=stage.encoder->outputDisplayMapped(event.displayMapped);generated.provenance=event.provenance;generated.provenance.push_back(stage.id);generated.completions=stage.state->previousCompletions;generated.completions.insert(generated.completions.end(),event.completions.begin(),event.completions.end());if(encoded.completion)generated.completions.push_back(encoded.completion);if(pairCompletion)generated.completions.push_back(pairCompletion);expanded.push_back(std::move(generated));}
   stage.state->previousCompletions=event.completions;event.image=current;expanded.push_back(std::move(event));previousPhase=events[position].phase;
  }
  if(realOnly)std::stable_sort(expanded.begin(),expanded.end(),[](const auto&a,const auto&b){return a.phase<b.phase;});events=std::move(expanded);
 }
 if(events.empty()||events.back().synthetic||std::abs(events.back().phase-1)>1e-6)return fail("The generation interval lost its original real-frame endpoint");
 output.events=std::move(events);output.result={true,{}};return output;
}
}
