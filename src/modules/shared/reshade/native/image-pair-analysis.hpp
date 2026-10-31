#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-contract.hpp"
#include "effect-node.hpp"
#include <functional>
#include <memory>
#include <string_view>
#include <vector>

namespace macfx {
// Timeline identities, rather than a node-global last-result flag, bind each
// decision to the actual images which produced that synthetic interval.
struct ImagePairAnalysisKey {
  uint64_t previousEventId = 0, currentEventId = 0, sourceFrameId = 0,
           epoch = 0, imageRevision = 0;
  FrameOrigin origin = FrameOrigin::TopLeft;
  bool opaque = false, displayMapped = false;
};
struct ImagePairAnalysisResult {
  ShaderResult result;
  // Evaluated only after the borrowed command buffer has completed. A false
  // result suppresses synthetic descendants; the real endpoint stays valid.
  std::function<ShaderResult()> completion;
};
// Generated images of the analyzed pair and their phases in (0, 1).
// Static-content blend-back writes each image in place, in the same command
// buffer and before the pair's history advances, so it shares the history
// image and identity check with the repeat and cut decision.
struct ImagePairGenerated {
  std::vector<id<MTLTexture>> images;
  std::vector<float> phases;
};
class ImagePairAnalysis {
  struct Impl;
  std::shared_ptr<Impl> impl;

public:
  // Resource construction belongs to the common graph preparation worker.
  ImagePairAnalysis(id<MTLCommandQueue>, id<MTLTexture> prototype,
                    const ImageColorDescription &, uintptr_t owner);
  ~ImagePairAnalysis();
  ImagePairAnalysisResult encode(id<MTLCommandBuffer>, id<MTLTexture>,
                                 const ImagePairAnalysisKey &,
                                 const ImagePairGenerated &blend = {});
  // False when this device cannot build the blend-back pass for the image
  // format; analysis continues and generated images stay unchanged.
  bool blendAvailable() const noexcept;
};
// Every registered color-pair provider (a generation method that declares no
// scene input) uses the shared analysis and blend-back. These providers expose
// no original SDK scene-cut decision; scene providers retain their own
// reset/no-interpolation contracts.
bool usesImagePairAnalysis(std::string_view method) noexcept;
} // namespace macfx
