#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "metal4-classic-bridge.hpp"
#include "scene-aovs.hpp"
#include "scene-matrices.hpp"
#include "scene-destination.hpp"
namespace macfx {
enum class Metal4ImageProvenance {Real,SyntheticUnpaired};
struct Metal4OriginalOperation {
 std::function<ShaderResult(id)>record;
 std::function<bool()>omit;
 std::function<void()>kept;
 std::function<void()>abandoned;
 std::function<bool()>mayOmit;
};
// The adapter retains the genuine SDK image or its exact isolated fallback.
// The ordinary presenter consumes the shared prefix's exact completion receipt
// and remains the generation/display owner.
class Metal4SceneIngress {
 struct State;std::shared_ptr<State>state;
public:
 explicit Metal4SceneIngress(id<MTLDevice>);~Metal4SceneIngress();
 ShaderResult encode(id logical,const RSTemporalFrame&,
  const std::shared_ptr<const SceneAovLease>&,
  const std::optional<RSSceneMatrices>&,
  const std::optional<TemporalSceneDestination>& = {},id<MTLFence>producerFence=nil,Metal4ImageProvenance=Metal4ImageProvenance::Real,
  Metal4OriginalOperation={},bool*originalEncoded=nullptr,double sourceTimeSeconds=0);
};
}
