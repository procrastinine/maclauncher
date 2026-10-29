#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include "temporal-frame.h"
#include <functional>
namespace macfx {
// Scene providers share actual color/guide/ROI ownership. Preparation may
// report busy while an independent GPU host prepares its pipelines; encoding
// never commits or performs a CPU wait on the caller's command buffer.
class SceneComputeEncoder {
public:
    virtual ~SceneComputeEncoder()=default;
    virtual void setColorDescription(const ImageColorDescription&){}
    virtual ShaderResult preparationStatus(){return {true,{}};}
    // Exact incoming producer context. A discarded prior recording can request
    // fresh worker resources without compiling or waiting in the warm path.
    virtual ShaderResult framePreparationStatus(const RSTemporalFrame&){return preparationStatus();}
    virtual ShaderResult prepare(const RSTemporalFrame&)=0;
    virtual ShaderResult encode(const RSTemporalFrame&)=0;
    virtual ShaderResult completion()=0;
    // Capture immediately after encode; concurrent providers retain the exact
    // submitted flight instead of querying their latest mutable state later.
    virtual std::function<ShaderResult()>completionTicket(){return [this]{return completion();};}
};
}
