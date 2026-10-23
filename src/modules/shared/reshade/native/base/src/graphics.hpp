#pragma once
#include <functional>
#include <optional>
#include <string>
#include "lsfg.hpp"
namespace macfx {
struct GraphicsConfig {
    std::string spatialMethod="off";
    double sharpness=.5;
    bool ls1Performance=false;
    std::optional<LsfgConfig> generation;
    std::optional<AdaptivePacingConfig> adaptive;
    std::string modelPath;
    bool requested() const {return spatialMethod!="off"||generation.has_value();}
};
// Pure validation is also used by hosts with explicit configuration. The process
// environment wrapper is shared by automatic Metal and OpenGL ingress.
GraphicsConfig graphicsConfig(const std::function<std::string(const char*)>&);
GraphicsConfig graphicsEnvironment();
// Cheap hook-installation gate; owner creation performs full validation.
bool graphicsRequested() noexcept;
// Automatic ingress may retain the publisher presentation when only scaling
// is selected and the source already has the physical output dimensions.
// Explicit presenters still own their output and do not use this gate.
bool automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight) noexcept;
}
