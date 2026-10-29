#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "MVKCommand.h"
#include "scene-interop.h"
#include <memory>
namespace macfxMvkScene { struct Operation; }
class MVKCmdMacfxScene final : public MVKCommand {
public:
    ~MVKCmdMacfxScene() override;
    VkResult setContent(MVKCommandBuffer*,const RSVulkanSceneOperationV1*);
    void encode(MVKCommandEncoder*) override;
    void discardMacfxSceneOperation();
protected:
    MVKCommandTypePool<MVKCommand>*getTypePool(MVKCommandPool*) override;
    std::shared_ptr<macfxMvkScene::Operation>_operation;
    MVKDevice*_sceneDevice=nullptr;
};
