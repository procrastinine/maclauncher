#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "lsfg.hpp"
#include "temporal-frame.h"
#include "color-contract.hpp"
#include "effect-node.hpp"
#include "generation-methods.hpp"
#include <functional>
#include <string_view>
namespace macfx {
struct GenerationResult:LsfgResult {
 std::function<ShaderResult()> completion;
 std::function<uint64_t()> gpuTiming;
 GenerationResult()=default;
 GenerationResult(LsfgResult value):LsfgResult(std::move(value)){}
};
using GenerationMeasure=std::function<uint64_t(unsigned,unsigned,unsigned)>;
// One provider owns algorithm/history only. The existing presenter owns all
// submission, timestamps and final real/generated display scheduling.
class GenerationEncoder {
public:
 virtual ~GenerationEncoder()=default;
 virtual const char *method()const noexcept=0;
 virtual bool requiresScene()const noexcept{return false;}
 virtual bool acceptsSynthetic()const noexcept{return !requiresScene();}
 virtual bool requiresOpaque()const noexcept{return true;}
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
};
std::shared_ptr<GenerationEncoder> makeGenerationEncoder(id<MTLDevice>,const std::string&,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeNeuralGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeRifeGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeXessGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
std::shared_ptr<GenerationEncoder> makeFSR3GenerationEncoder(id<MTLDevice>,const LsfgConfig&);
bool metalFXGenerationAvailable(id<MTLDevice>)noexcept;
}
