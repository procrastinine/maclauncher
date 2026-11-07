// SPDX-License-Identifier: MIT
#pragma once
#include "MVKCommand.h"
#include "temporal-carrier.h"
#include <memory>
struct MVKTemporalState;
struct MVKTemporalRecord;
const char* mvkTemporalDriverInfo(id<MTLDevice> device);
void mvkTemporalFinish(MVKDevice* device);
class MVKCmdTemporalFrame final : public MVKCommand {
public:
    VkResult setContent(MVKCommandBuffer*, const VkTemporalFrameInfoMVK*);
    void encode(MVKCommandEncoder*) override;
protected:
    MVKCommandTypePool<MVKCommand>* getTypePool(MVKCommandPool*) override;
    std::shared_ptr<MVKTemporalRecord> _frame;
};
