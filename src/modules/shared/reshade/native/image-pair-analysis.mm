// Copyright (c) MacLauncher contributors. MIT license.
#include "image-pair-analysis.hpp"
#include "generation-timeline.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <array>
#include <atomic>
#include <cstring>
#include <mutex>
#include <stdexcept>

namespace macfx {
namespace {
constexpr unsigned tileSide = 16, threadsPerTile = tileSide * tileSide;
// The shared timeline admits at most 32 images, with at most three submitted
// source batches. A receipt remains leased through both its fence and readers.
constexpr unsigned receiptCount = maximumTimelineImages * 3,
                   receiptStride = 256;
constexpr uint32_t receiptMagic = 0x4d435041;
enum Decision : uint32_t {
  HistoryMissing = 1,
  Repeated = 2,
  EstimatedCut = 4,
  Nonfinite = 8
};
struct Parameters {
  uint32_t width, height, tilesX, tileCount, alphaMode, contract, reserved[2];
  uint64_t previousEventId, currentEventId, sourceFrameId, epoch, imageRevision;
};
struct Receipt {
  uint32_t magic, flags, tileCount, reserved;
  uint64_t previousEventId, currentEventId, sourceFrameId, epoch, imageRevision;
  float meanDifference, changedTileFraction;
  uint32_t changedPixels, pixelCount;
};
static_assert(sizeof(Parameters) == 72 && sizeof(Receipt) == 72);
const char *shader = R"METAL(
#include <metal_stdlib>
using namespace metal;
struct Parameters {
 uint width,height,tilesX,tileCount,alphaMode,contract,reserved0,reserved1;
 ulong previousEventId,currentEventId,sourceFrameId,epoch,imageRevision;
};
struct History {ulong eventId,epoch,imageRevision;uint contract,reserved;};
struct Tile {float difference;uint changed,pixels,nonfinite;};
struct Receipt {
 uint magic,flags,tileCount,reserved;
 ulong previousEventId,currentEventId,sourceFrameId,epoch,imageRevision;
 float meanDifference,changedTileFraction;uint changedPixels,pixelCount;
};
bool matches(device const History&h,constant Parameters&p) {
 return p.previousEventId&&h.eventId==p.previousEventId&&h.epoch==p.epoch&&
        h.imageRevision==p.imageRevision&&h.contract==p.contract;
}
// Bounded encoding-domain color distance is an image estimate, not a camera
// cut or physical luminance measurement. Straight RGB is premultiplied for
// this distance; the exact-repeat comparison below keeps every decoded texel.
float4 visible(float4 c,uint alphaMode) {
 if(alphaMode==2)c.a=1;
 else if(alphaMode==0)c.rgb*=c.a;
 c.rgb=c.rgb/(1+abs(c.rgb));
 return c;
}
kernel void pair_tiles(texture2d<float,access::read>current[[texture(0)]],
 texture2d<float,access::read>previous[[texture(1)]],device Tile*tiles[[buffer(0)]],
 device const History&history[[buffer(1)]],constant Parameters&p[[buffer(2)]],
 uint2 group[[threadgroup_position_in_grid]],uint tid[[thread_index_in_threadgroup]]) {
 threadgroup float distances[256];threadgroup uint changes[256],counts[256],invalid[256];
 uint2 point=group*16+uint2(tid%16,tid/16);
 bool inside=point.x<p.width&&point.y<p.height,valid=matches(history,p);
 float distance=0;uint changed=0,bad=0;
 if(inside){float4 a=current.read(point);bad=any(!isfinite(a));
  if(valid){float4 b=previous.read(point);bad|=any(!isfinite(b));
   changed=any(a!=b);if(!bad)distance=dot(abs(visible(a,p.alphaMode)-visible(b,p.alphaMode)),float4(.25f));
  }
 }
 distances[tid]=distance;changes[tid]=changed;counts[tid]=inside;invalid[tid]=bad;
 threadgroup_barrier(mem_flags::mem_threadgroup);
 for(uint step=128;step;step>>=1){if(tid<step){distances[tid]+=distances[tid+step];changes[tid]+=changes[tid+step];counts[tid]+=counts[tid+step];invalid[tid]+=invalid[tid+step];}threadgroup_barrier(mem_flags::mem_threadgroup);}
 if(!tid)tiles[group.y*p.tilesX+group.x]={distances[0],changes[0],counts[0],invalid[0]};
}
kernel void pair_decision(device const Tile*tiles[[buffer(0)]],device History&history[[buffer(1)]],
 device Receipt&receipt[[buffer(2)]],constant Parameters&p[[buffer(3)]],
 uint tid[[thread_index_in_threadgroup]]) {
 threadgroup float distances[256];threadgroup uint4 totals[256];
 float distance=0;uint4 count=0;
 for(uint index=tid;index<p.tileCount;index+=256){Tile t=tiles[index];distance+=t.difference;
  count+=uint4(t.changed,t.pixels,t.nonfinite,t.pixels&&t.difference/float(t.pixels)>.15f);
 }
 distances[tid]=distance;totals[tid]=count;threadgroup_barrier(mem_flags::mem_threadgroup);
 for(uint step=128;step;step>>=1){if(tid<step){distances[tid]+=distances[tid+step];totals[tid]+=totals[tid+step];}threadgroup_barrier(mem_flags::mem_threadgroup);}
 if(!tid){bool valid=matches(history,p);uint4 sum=totals[0];
  float mean=sum.y?distances[0]/float(sum.y):0,fraction=float(sum.w)/float(p.tileCount);
  uint flags=!valid?1u:!sum.x?2u:mean>.20f&&fraction>.85f?4u:0u;if(sum.z)flags|=8u;
  receipt={0x4d435041u,flags,p.tileCount,0,p.previousEventId,p.currentEventId,p.sourceFrameId,p.epoch,p.imageRevision,mean,fraction,sum.x,sum.y};
  history={p.currentEventId,p.epoch,p.imageRevision,p.contract,0};
 }
}
)METAL";

uint32_t colorContract(const ImageColorDescription &color) {
  uint32_t hash = 2166136261u;
  auto add = [&](uint32_t value) { hash = (hash ^ value) * 16777619u; };
  add(unsigned(color.primaries));
  add(unsigned(color.transfer));
  add(unsigned(color.range));
  add(unsigned(color.alpha));
  for (const float value : {color.referenceWhite, color.peakLuminance,
                            color.blackLuminance, color.hlgSystemGamma}) {
    uint32_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    add(bits);
  }
  add(color.sceneReferred);
  return hash;
}
} // namespace

struct ImagePairAnalysis::Impl {
  struct Flight;
  id<MTLCommandQueue> queue;
  id<MTLTexture> previous;
  id<MTLComputePipelineState> tilesPipeline, decisionPipeline;
  id<MTLBuffer> tiles, history, receipts;
  std::shared_ptr<ImageReservation> buffersAdmission;
  std::array<std::atomic<bool>, receiptCount> leased{};
  std::mutex encoding;
  unsigned width = 0, height = 0, tilesX = 0, tileCount = 0;
  uint32_t contract = 0, alphaMode = 0;

  Impl(id<MTLCommandQueue> commands, id<MTLTexture> prototype,
       const ImageColorDescription &color, uintptr_t owner)
      : queue(commands) {
    if (!queue || !prototype || prototype.device != queue.device ||
        !color.valid() || prototype.textureType != MTLTextureType2D ||
        prototype.sampleCount != 1 || prototype.framebufferOnly ||
        !(prototype.usage & MTLTextureUsageShaderRead) || !prototype.width ||
        !prototype.height || prototype.width > 16384 ||
        prototype.height > 16384)
      throw std::runtime_error("Image-pair analysis requires a readable "
                               "resolved image and its command queue");
    width = unsigned(prototype.width);
    height = unsigned(prototype.height);
    tilesX = (width + tileSide - 1) / tileSide;
    tileCount = tilesX * ((height + tileSide - 1) / tileSide);
    contract = colorContract(color);
    alphaMode = unsigned(color.alpha);
    NSError *error = nil;
    auto library = cachedMetalLibrary(queue.device, shader, &error);
    tilesPipeline =
        library ? [queue.device newComputePipelineStateWithFunction:
                                    [library newFunctionWithName:@"pair_tiles"]
                                                              error:&error]
                : nil;
    decisionPipeline =
        library
            ? [queue.device newComputePipelineStateWithFunction:
                                [library newFunctionWithName:@"pair_decision"]
                                                          error:&error]
            : nil;
    if (!tilesPipeline || !decisionPipeline ||
        tilesPipeline.maxTotalThreadsPerThreadgroup < threadsPerTile ||
        decisionPipeline.maxTotalThreadsPerThreadgroup < threadsPerTile)
      throw std::runtime_error(error.localizedDescription.UTF8String
                                   ?: "Cannot prepare GPU image-pair analysis");
    auto descriptor = [MTLTextureDescriptor
        texture2DDescriptorWithPixelFormat:prototype.pixelFormat
                                     width:width
                                    height:height
                                 mipmapped:NO];
    descriptor.storageMode = MTLStorageModePrivate;
    descriptor.usage = MTLTextureUsageShaderRead;
    previous = newAdmittedTexture(queue.device, descriptor, owner,
                                  "image-pair-history");
    if (!previous)
      throw std::runtime_error("Cannot retain GPU image-pair history");
    const uint64_t tileBytes = uint64_t(tileCount) * 16,
                   receiptBytes = receiptCount * receiptStride;
    buffersAdmission =
        reserveImageBytes(queue.device, tileBytes + 32 + receiptBytes, owner,
                          "image-pair-metadata");
    tiles = [queue.device newBufferWithLength:tileBytes
                                      options:MTLResourceStorageModePrivate];
    history = [queue.device newBufferWithLength:32
                                        options:MTLResourceStorageModeShared];
    receipts = [queue.device newBufferWithLength:receiptBytes
                                         options:MTLResourceStorageModeShared];
    if (!tiles || !history || !receipts)
      throw std::runtime_error("Cannot allocate GPU image-pair metadata");
    std::memset(history.contents, 0, 32);
    buffersAdmission->commit(tiles.allocatedSize + history.allocatedSize +
                             receipts.allocatedSize);
  }
};

struct ImagePairAnalysis::Impl::Flight {
  std::shared_ptr<Impl> owner;
  ImagePairAnalysisKey key;
  unsigned slot = 0;
  std::atomic<unsigned> fence{0};
  ~Flight() { owner->leased[slot].store(false, std::memory_order_release); }
  ShaderResult complete() const {
    const auto done = fence.load(std::memory_order_acquire);
    if (!done)
      return {false, "Image-pair decision is awaiting its GPU fence", true};
    if (done != 1)
      return {false, "Image-pair analysis did not complete on the GPU"};
    // This is a fixed-size scalar decision/identity receipt. Image pixels
    // and the per-tile statistics remain on the GPU.
    const auto &r = *reinterpret_cast<const Receipt *>(
        static_cast<const uint8_t *>(owner->receipts.contents) +
        slot * receiptStride);
    if (r.magic != receiptMagic || r.previousEventId != key.previousEventId ||
        r.currentEventId != key.currentEventId ||
        r.sourceFrameId != key.sourceFrameId || r.epoch != key.epoch ||
        r.imageRevision != key.imageRevision || r.tileCount != owner->tileCount)
      return {false, "Image-pair decision does not match this source interval"};
    if (r.flags & Nonfinite)
      return {false, "Image-pair analysis found nonfinite input"};
    if (r.flags & HistoryMissing)
      return {false, "Image-pair analysis is establishing this source history"};
    if (r.flags & Repeated)
      return {false, "The source image pair repeats exactly"};
    if (r.flags & EstimatedCut)
      return {false, "The source image pair has an estimated scene cut"};
    if (r.flags)
      return {false, "Image-pair analysis returned an invalid decision"};
    return {true, {}};
  }
};

ImagePairAnalysis::ImagePairAnalysis(id<MTLCommandQueue> queue,
                                     id<MTLTexture> prototype,
                                     const ImageColorDescription &color,
                                     uintptr_t owner)
    : impl(std::make_shared<Impl>(queue, prototype, color, owner)) {}
ImagePairAnalysis::~ImagePairAnalysis() = default;
ImagePairAnalysisResult
ImagePairAnalysis::encode(id<MTLCommandBuffer> commands, id<MTLTexture> source,
                          const ImagePairAnalysisKey &key) {
  if (!commands || commands.commandQueue != impl->queue ||
      !commands.retainedReferences ||
      commands.status >= MTLCommandBufferStatusCommitted || !source ||
      source.device != impl->queue.device || source.width != impl->width ||
      source.height != impl->height ||
      source.pixelFormat != impl->previous.pixelFormat || !key.currentEventId)
    return {{false, "Image-pair analysis requires its prepared image and "
                    "unsubmitted command buffer"},
            {}};
  std::unique_lock lock(impl->encoding, std::try_to_lock);
  if (!lock.owns_lock())
    return {{false, "Image-pair analysis is in use", true}, {}};
  unsigned slot = receiptCount;
  for (unsigned index = 0; index < receiptCount; ++index) {
    bool free = false;
    if (impl->leased[index].compare_exchange_strong(
            free, true, std::memory_order_acq_rel)) {
      slot = index;
      break;
    }
  }
  if (slot == receiptCount)
    return {{false, "Image-pair decision capacity is in use", true}, {}};
  auto flight = std::make_shared<Impl::Flight>();
  flight->owner = impl;
  flight->key = key;
  flight->slot = slot;
  // Retain every leased resource even if a later encoder cannot be created.
  // A partially encoded buffer may still be submitted by its owner.
  [commands addCompletedHandler:^(id<MTLCommandBuffer> finished) {
    flight->fence.store(finished.status == MTLCommandBufferStatusCompleted ? 1
                                                                           : 2,
                        std::memory_order_release);
  }];
  auto compute = [commands computeCommandEncoder];
  if (!compute)
    return {{false, "Cannot encode GPU image-pair analysis"}, {}};
  uint32_t contract =
      impl->contract ^
      (key.origin == FrameOrigin::BottomLeft ? 0x80000000u : 0) ^
      (key.displayMapped ? 0x40000000u : 0) ^ (key.opaque ? 0x20000000u : 0);
  const Parameters parameters{impl->width,
                              impl->height,
                              impl->tilesX,
                              impl->tileCount,
                              key.opaque ? 2u : impl->alphaMode,
                              contract,
                              {0, 0},
                              key.previousEventId,
                              key.currentEventId,
                              key.sourceFrameId,
                              key.epoch,
                              key.imageRevision};
  [compute setComputePipelineState:impl->tilesPipeline];
  [compute setTexture:source atIndex:0];
  [compute setTexture:impl->previous atIndex:1];
  [compute setBuffer:impl->tiles offset:0 atIndex:0];
  [compute setBuffer:impl->history offset:0 atIndex:1];
  [compute setBytes:&parameters length:sizeof(parameters) atIndex:2];
  [compute dispatchThreadgroups:MTLSizeMake(
                                    impl->tilesX,
                                    (impl->height + tileSide - 1) / tileSide, 1)
          threadsPerThreadgroup:MTLSizeMake(threadsPerTile, 1, 1)];
  [compute endEncoding];
  // Publish the new history identity only after its actual image copy. A
  // discarded/failed partial command must never make stale pixels appear to
  // belong to the next pair, even when its old CPU-side event IDs advanced.
  auto copy = [commands blitCommandEncoder];
  if (!copy)
    return {{false, "Cannot retain GPU image-pair history"}, {}};
  [copy copyFromTexture:source
            sourceSlice:0
            sourceLevel:0
           sourceOrigin:MTLOriginMake(0, 0, 0)
             sourceSize:MTLSizeMake(impl->width, impl->height, 1)
              toTexture:impl->previous
       destinationSlice:0
       destinationLevel:0
      destinationOrigin:MTLOriginMake(0, 0, 0)];
  [copy endEncoding];
  compute = [commands computeCommandEncoder];
  if (!compute)
    return {{false, "Cannot reduce GPU image-pair analysis"}, {}};
  [compute setComputePipelineState:impl->decisionPipeline];
  [compute setBuffer:impl->tiles offset:0 atIndex:0];
  [compute setBuffer:impl->history offset:0 atIndex:1];
  [compute setBuffer:impl->receipts offset:slot * receiptStride atIndex:2];
  [compute setBytes:&parameters length:sizeof(parameters) atIndex:3];
  [compute dispatchThreadgroups:MTLSizeMake(1, 1, 1)
          threadsPerThreadgroup:MTLSizeMake(threadsPerTile, 1, 1)];
  [compute endEncoding];
  return {{true, {}}, [flight] { return flight->complete(); }};
}
bool usesImagePairAnalysis(std::string_view method) noexcept {
  return method == "lsfg" || method == "mlx-interpolation" || method == "rife";
}
} // namespace macfx
