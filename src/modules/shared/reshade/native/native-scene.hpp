#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "scene-matrices.hpp"
#include <functional>
namespace macfx {
// Optional internal interface for compiled image nodes using renderer guides.
// ShaderNode's separately loaded provider ABI remains unchanged.
class NativeSceneShader {
public:
    virtual ~NativeSceneShader()=default;
    // A nonempty reason leaves this row pending while independent rows run.
    // This metadata-only check must not compile, allocate, encode or wait.
    virtual std::string sceneInputReason(const ShaderFrame&,const RSTemporalFrame*,const std::optional<RSSceneMatrices>&)const{return {};}
    virtual ShaderResult prepareScene(const ShaderFrame&,const RSTemporalFrame&,const std::optional<RSSceneMatrices>&)=0;
    virtual ShaderResult encodeScene(const ShaderFrame&,const RSTemporalFrame&,const std::optional<RSSceneMatrices>&)=0;
    // Captured immediately after encoding; only actual submitted work supplies
    // a result. Missing optional tickets retain ordinary command completion.
    virtual std::function<ShaderResult()>completionTicket(){return {};}
};
// The supplied scene has guides aligned to the actual current color extent.
// Depth is raw resolved device depth; projection clip range is explicit in the
// matrix flags. Inverting that actual projection already handles reverse Z.
// Unless PROJECTION_JITTERED is declared, jitter is sample offset in current render pixels:
// TopLeft NDC = ((pixel + .5 - jitter) / extent) * (2,-2) + (-1,1).
// BottomLeft uses (2,2) + (-1,-1); PROJECTION_Y_DOWN reverses the NDC Y mapping.
// An already-jittered projection receives no second sample-jitter correction.
// Reconstructed/dejittered color has zero separate sample jitter.
}
