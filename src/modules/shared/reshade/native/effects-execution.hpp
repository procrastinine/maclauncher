#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-plan.hpp"
#include "graphics.hpp"
#include "temporal-frame.h"
#include "color-contract.hpp"
namespace macfx {
class EffectExecution {
    struct Impl;
    std::shared_ptr<Impl> impl;
    explicit EffectExecution(std::shared_ptr<Impl>);
    friend class EffectPlanExecutor;
public:
    const std::string &revision() const;
    const GraphicsConfig &graphics() const;
    std::shared_ptr<LsfgEncoder> generator() const;
    // Prefix includes all rows before generation; suffix runs separately on
    // every actual real/generated presentation. No generation means all rows
    // belong to the prefix. These functions never commit a command buffer.
    ShaderResult encode(const ShaderFrame &,bool suffix=false,bool generated=false);
    const std::string &generationInputIdentity()const;
    unsigned generationWidth()const;unsigned generationHeight()const;
    void setStatusContext(uintptr_t);
    bool hasTemporal() const;
    bool requiresDepth() const;
    // Ordinary owned presentation may process independent final images on its
    // own queue. Matched scene inputs and generated timelines stay in place.
    bool canDetachNeural() const;
    // Offline writers validate asynchronous inference before appending output.
    ShaderResult finishOffline();
    // Scene input is the original renderer's matched temporal frame. The
    // remaining prefix resumes only from that frame's exact output receipt.
    ShaderResult encodeScene(const ShaderFrame &,const RSTemporalFrame &);
    ShaderResult encodeAfterScene(const ShaderFrame &,bool suffix=false,bool generated=false);
private:
    ShaderResult encodeRange(const ShaderFrame &,size_t begin,size_t end,bool generated,const RSTemporalFrame *);
};
struct EffectExecutionSelection {
    bool active=false,changed=false;
    std::shared_ptr<EffectExecution> execution;
    std::string error;
};
class EffectPlanExecutor {
    struct Impl;
    std::unique_ptr<Impl> impl;
public:
    EffectPlanExecutor();~EffectPlanExecutor();
    EffectExecutionSelection prepare(const ShaderFrame &,bool presentation=false,const RSTemporalFrame *temporal=nullptr);
    EffectExecutionSelection prepareWithColor(const ShaderFrame &,bool,const RSTemporalFrame *,ImageColorSpace);
    void setStatusContext(uintptr_t);
    bool requiresDepth();
    bool requiresTemporal();
    std::shared_ptr<const EffectPlanSnapshot> snapshot()const;
};
}
