#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "neural-node.hpp"
#include <functional>
#include <memory>
#include <string>

namespace macfx {
enum class EstimatedDepthRepresentation { RelativeInverse };
// Image-estimated data is deliberately separate from RSTemporalFrame. Pixel
// values carry no renderer near/far, camera matrix, physical units or hidden
// surface validity. The image covers the complete source. Original source-size
// egress uses align-corners bilinear sampling: logical source texel p maps to
// (p/max(sourceExtent-1,1)*(depthExtent-1)+.5)/depthExtent in texture UVs.
struct EstimatedDepthAttachment {
  id<MTLTexture> texture = nil;
  id<MTLBuffer> validity = nil;
  FrameOrigin origin = FrameOrigin::TopLeft;
  EstimatedDepthRepresentation representation =
      EstimatedDepthRepresentation::RelativeInverse;
  uint64_t contentId = 0, epoch = 0, imageRevision = 0, observationId = 0;
  unsigned sourceWidth = 0, sourceHeight = 0;
  std::string inputIdentity, modelIdentity;
  bool synthetic = false;
  std::shared_ptr<void> storage;
  // Nonblocking, after actual source GPU completion. The GPU validity buffer
  // permits the immediate consumer to preserve current color on failure.
  std::function<ShaderResult()> completion;
  NeuralGpuTimingTicket gpuTiming;
};
struct NeuralDepthSpec {
  std::string modelPath;
  unsigned inputSize = 252;
};
struct NeuralDepthResult {
  ShaderResult result;
  EstimatedDepthAttachment attachment;
};
class NeuralDepthEstimator {
  struct Impl;
  std::shared_ptr<Impl> impl;

public:
  NeuralDepthEstimator(id<MTLDevice>, const NeuralDepthSpec &);
  ~NeuralDepthEstimator();
  // Resource-only setup; the common asynchronous graph builder owns calling
  // this method. Model preparation itself is queued off that builder too.
  ShaderResult prepare(const ShaderFrame &, const ImageColorDescription &);
  ShaderResult prepare(const ShaderFrame &, const ImageColorDescription &,
                       unsigned inputSize);
  ShaderResult preparationStatus() const;
  bool gpuTimingAvailable() const;
  NeuralDepthResult encode(const ShaderFrame &, const NeuralInputStamp &,
                           bool redraw = false, bool displayMapped = false,
                           unsigned inputSize = 0, bool measureGpu = false);
};
} // namespace macfx
