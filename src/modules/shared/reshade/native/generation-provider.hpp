#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "lsfg.hpp"
#include "temporal-frame.h"
#include "color-contract.hpp"
#include "effect-node.hpp"
#include "generation-methods.hpp"
#include <functional>
#include <string_view>
#include <mutex>
namespace macfx {
// Native MetalFX interpolation preserves its caller's raw color domain;
// learned/SDK providers requiring a declared encoding cannot use this entry.
inline bool generationPreservesUnspecifiedColor(std::string_view method)noexcept{return method=="metalfx";}
struct GenerationResult:LsfgResult {
 bool preparing=false; // Replacement preparation is not evidence of overload.
 std::function<ShaderResult()> completion;
 std::function<uint64_t()> gpuTiming;
 GenerationResult()=default;
 GenerationResult(LsfgResult value):LsfgResult(std::move(value)){}
};
using GenerationMeasure=std::function<uint64_t(unsigned,unsigned,unsigned)>;
// One provider owns algorithm/history only. Its host owns submission and
// scheduling: the presenter for graph intervals, or the original SDK caller
// for an interval written into the caller's requested output.
class GenerationEncoder {
 std::mutex callerMutex;id<MTLTexture>callerPrevious=nil;uint64_t callerFrame=0,callerSequence=0;
public:
 virtual ~GenerationEncoder()=default;
 virtual const char *method()const noexcept=0;
 virtual bool requiresScene()const noexcept{return false;}
 virtual bool acceptsSynthetic()const noexcept{return !requiresScene();}
 virtual bool requiresOpaque()const noexcept{return true;}
 // Caller-owned interpolation: exact real pair and requested phases, with no
 // presenter, submission or implicit replacement of the previous endpoint.
 virtual bool acceptsExplicitIntervals()const noexcept{return true;}
 virtual bool acceptsUnspecifiedColor()const noexcept{return generationPreservesUnspecifiedColor(method());}
 // Most providers use verified contiguous real-endpoint history. Providers
 // overriding this consume the explicit previous texture directly.
 virtual bool usesExplicitPreviousImage()const noexcept{return false;}
 virtual ShaderResult setIntervalUI(id<MTLTexture>ui,bool,float){return {!ui,ui?"This provider needs a declared alpha UI image rather than a raw SDK UI texture":""};}
 virtual GenerationResult encodeInterval(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,const std::vector<id<MTLTexture>>&,uint64_t,const InterpolationPlan&);
 virtual void setColorDescription(const ImageColorDescription&){}
 virtual ShaderResult preparationStatus()const{return {true,{}};}
 virtual GenerationResult prepare(id<MTLCommandBuffer>,id<MTLTexture>,const RSTemporalFrame*){GenerationResult result;result.encoded=true;return result;}
 // A scene binding is valid only for this exact unsubmitted command buffer.
 // Implementations retain real textures, never an unowned process-local pointer.
 virtual void setScene(const RSTemporalFrame&){}
 virtual void setSceneColorJitter(bool){}
 virtual void setSceneOrigin(FrameOrigin){}
 virtual GenerationResult encode(id<MTLCommandBuffer>,id<MTLTexture>,const std::vector<id<MTLTexture>>&,
   uint64_t,const InterpolationPlan&)=0;
 // Known image envelope; opaque framework/model allocations are not represented
// as exact accounting. Existing device-headroom admission remains in effect.
 virtual uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const=0;
 virtual bool outputDisplayMapped(bool input)const noexcept{return input;}
 virtual GenerationResult encodeColor(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases,bool){return encode(commands,source,outputs,sequence,phases);}
 virtual bool gpuTimingAvailable()const{return false;}
 virtual GenerationResult encodeColorTimed(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases,bool mapped,bool){return encodeColor(commands,source,outputs,sequence,phases,mapped);}
 // The method that ran the latest pair; Automatic reports its current candidate.
 virtual const char *activeMethod()const noexcept{return method();}
 // Why activeMethod() runs, when a provider chooses among methods; empty otherwise.
 virtual std::string activeReason()const{return {};}
};
std::shared_ptr<GenerationEncoder> makeGenerationEncoder(id<MTLDevice>,const std::string&,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeNeuralGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeRifeGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeXessGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeANRGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeFSR3GenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeVideoToolboxGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeMetalFXImageGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeVisionFlowGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
bool metalFXGenerationAvailable(id<MTLDevice>)noexcept;
bool videoToolboxGenerationAvailable()noexcept;
bool visionFlowGenerationAvailable()noexcept;
}
