// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#import <Metal/Metal.h>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "adaptive-pacing.hpp"
namespace macfx {
struct LsfgConfig {std::string modelPath;bool fp16=true,performance=false;float flowScale=1;unsigned multiplier=2;};
struct LsfgResult {bool encoded=false,ready=false,busy=false;uint64_t frameId=0;unsigned generated=0,historyFrames=0,dispatches=0,graphBuilds=0;std::string modelHash,reason;};
// Opaque SDR only. Outputs correspond to ascending intermediate timestamps.
// A retained command buffer, source dependency and final presentation belong
// to the caller. One graph submission may be in flight; busy returns immediately.
class LsfgEncoder {
public:
 LsfgEncoder(id<MTLDevice>,const LsfgConfig&);~LsfgEncoder();
 LsfgResult encode(id<MTLCommandBuffer>,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId);
 LsfgResult encode(id<MTLCommandBuffer>,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId,const InterpolationPlan&);
 LsfgEncoder(const LsfgEncoder&)=delete;LsfgEncoder&operator=(const LsfgEncoder&)=delete;
private:struct Impl;std::unique_ptr<Impl>impl;
};
}
