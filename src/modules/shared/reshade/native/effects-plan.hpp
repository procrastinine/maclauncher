#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include <functional>
#include <variant>

namespace macfx {
struct EffectPlanRequirements {bool depth=false,motion=false;};
using EffectPlanScalar=std::variant<std::monostate,bool,double,std::string>;
struct EffectPlanSettings {
    std::map<std::string,EffectPlanScalar> values;
    std::string string(const std::string &,std::string fallback={}) const;
    double number(const std::string &,double fallback=0) const;
    bool boolean(const std::string &,bool fallback=false) const;
};
struct EffectPlanNode {
    std::string id,kind,format,method,modelPath;
    bool enabled=true,preservesCoordinates=false;
    unsigned outputWidth=0,outputHeight=0;
    double presentationScale=0;
    // Prepared Simple-only sizing. Saved Advanced plans use explicit sizes.
    bool resolutionAuto=false;
    double outputScaleX=1,outputScaleY=1;
    bool outputPresentation=false;
    ShaderSpec shader;
    EffectPlanSettings settings;
    EffectPlanRequirements requirements;
};
struct EffectPlanSize {unsigned width=0,height=0;};
// Spatial rows resize their previous row's actual image. Auto fits the final
// presentation. An explicit size takes precedence over presentation-relative
// sizing, which in turn precedes a scale of the preceding row's input.
EffectPlanSize spatialOutputSize(const EffectPlanNode &,EffectPlanSize input,EffectPlanSize presentation);
struct EffectPlanSnapshot {std::string revision,mode;std::vector<EffectPlanNode> nodes;};
struct EffectPlanPoll {bool active=false,changed=false;std::string error;bool valid=false;};
bool effectPlanRequested() noexcept;
// 0: absent/Simple, 1: Advanced with enabled rows, 2: Advanced pass-through.
int effectPlanMode() noexcept;
// Metadata publication identity, including row/resource/parameter changes.
uint64_t effectPlanDemandGeneration() noexcept;
// Metadata-only: every enabled Advanced row is same-size native ReShadeFX
// without a scene-guide contract. No shader or model resources are prepared.
bool effectPlanNativeFxOnly() noexcept;
bool effectPlanNativeFxOnly(const EffectPlanSnapshot &) noexcept;
// One state belongs to one serialized frame owner. A frame retains its immutable
// snapshot while encoding; the host still owns targets, leases and submission.
// This parser never encodes GPU commands, commits work or copies image data.
class EffectPlanState {
    struct Impl;
    std::unique_ptr<Impl> impl;
public:
    using Factory=std::function<std::shared_ptr<ShaderNode>(const EffectPlanNode &)>;
    EffectPlanState();
    ~EffectPlanState();
    EffectPlanState(const EffectPlanState &)=delete;
    EffectPlanState &operator=(const EffectPlanState &)=delete;
    EffectPlanPoll poll();
    EffectPlanPoll poll(bool force);
    std::shared_ptr<const EffectPlanSnapshot> snapshot() const;
    std::string error() const;
    std::shared_ptr<ShaderNode> shader(const EffectPlanNode &,const Factory &factory={});
};
}
