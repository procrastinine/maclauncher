#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-contract.hpp"
#include "effect-node.hpp"
#include <functional>
#include <memory>
#include <string_view>

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
class ImagePairAnalysis {
  struct Impl;
  std::shared_ptr<Impl> impl;

public:
  // Resource construction belongs to the common graph preparation worker.
  ImagePairAnalysis(id<MTLCommandQueue>, id<MTLTexture> prototype,
                    const ImageColorDescription &, uintptr_t owner);
  ~ImagePairAnalysis();
  ImagePairAnalysisResult encode(id<MTLCommandBuffer>, id<MTLTexture>,
                                 const ImagePairAnalysisKey &);
};
// These color-pair providers do not expose an original SDK scene-cut decision.
// Scene providers retain their own reset/no-interpolation contracts.
bool usesImagePairAnalysis(std::string_view method) noexcept;
} // namespace macfx
