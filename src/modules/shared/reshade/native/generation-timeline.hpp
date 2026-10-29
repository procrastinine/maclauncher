#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "adaptive-pacing.hpp"
#include "effect-node.hpp"
#include <array>
#include <string>
#include <vector>
#include <functional>
#import <Metal/Metal.h>
namespace macfx {
// A bounded completed source interval. Providers retain their own pair limits;
// this is the single presenter's admitted expansion, independent of row count.
constexpr unsigned maximumTimelineImages=32;
struct TimelinePhases {
 std::array<float,maximumTimelineImages-1>timestamps{};unsigned count=0;
 TimelinePhases&operator=(const InterpolationPlan&value){count=value.count;for(unsigned i=0;i<count;++i)timestamps[i]=value.timestamps[i];return *this;}
};
struct GenerationEvent {
 id<MTLTexture>image=nil;double phase=1;uint64_t sourceFrameId=0,eventId=0,previousEventId=0,nextEventId=0;
 bool synthetic=false;std::vector<std::string>provenance;bool displayMapped=false;
 std::vector<std::function<ShaderResult()>>completions;
};
}
