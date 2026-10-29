// Copyright (c) MacLauncher contributors. MIT license.
// Native original FSR4.1.1 profiles; borrowed commands remain unsubmitted.
#include "../frame.h"
#include "fsr411_runtime.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
namespace {
using Contract = std::array<uint64_t, 48>;
dispatch_queue_t preparationQueue() {
  static auto q = dispatch_queue_create("MacLauncher FSR4 preparation",
                                        DISPATCH_QUEUE_SERIAL);
  return q;
}
std::shared_ptr<fsr411::View> newView() {
  return {new fsr411::View, [](fsr411::View *p) {
            dispatch_async(preparationQueue(), ^{
              delete p;
            });
          }};
}
struct RetainedFrame {
  RSTemporalFrame value{};
  id commands;
  std::array<id<MTLTexture>, 8> textures;
  explicit RetainedFrame(const RSTemporalFrame &f)
      : value(f), commands((__bridge id)f.commandBuffer),
        textures{{(__bridge id<MTLTexture>)f.color,
                  (__bridge id<MTLTexture>)f.depth,
                  (__bridge id<MTLTexture>)f.motion,
                  (__bridge id<MTLTexture>)f.output,
                  (__bridge id<MTLTexture>)f.exposure,
                  (__bridge id<MTLTexture>)f.reactive,
                  (__bridge id<MTLTexture>)f.transparency, nil}} {}
};
struct Owner {
  std::mutex mutex;
  std::shared_ptr<fsr411::View> view;
  std::shared_ptr<RetainedFrame> requested;
  Contract prepared{}, wanted{}, failed{};
  std::string reason;
  uint64_t generation = 0, lastFrame = 0;
  bool hasFrame = false, preparing = false, retired = false;
};
struct Context {
  fsr411::Runtime runtime;
  std::map<void *, std::shared_ptr<Owner>> owners;
  std::vector<std::shared_ptr<fsr411::View>> retired;
  std::atomic<bool> retirementScheduled{false}, hasRetired{false};
  Context(id<MTLDevice> d, const char *root, const char *build)
      : runtime(d, root, build) {}
  void collect() {
    retired.erase(std::remove_if(retired.begin(), retired.end(),
                                 [](const auto &v) {
                                   return std::all_of(v->slots.begin(),
                                                      v->slots.end(),
                                                      [](const auto &s) {
                                                        return s->retired();
                                                      });
                                 }),
                  retired.end());
    hasRetired = !retired.empty();
  }
};
void collectLater(std::shared_ptr<Context> context) {
  if (context->retirementScheduled.exchange(true))
    return;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                 preparationQueue(), ^{
                   context->collect();
                   context->retirementScheduled = false;
                   if (context->hasRetired)
                     collectLater(context);
                 });
}
std::mutex registryMutex;
std::map<void *, std::shared_ptr<Context>> contexts;
int result(RSTemporalResult *out, uint32_t status,
           const std::string &reason = {}, bool encoded = false) {
  if (out && out->size >= sizeof(*out)) {
    out->version = 1;
    out->status = status;
    out->encoded = encoded;
    out->method = RS_TEMPORAL_FSR4;
    out->reset = 0;
    std::snprintf(out->reason, sizeof(out->reason), "%s", reason.c_str());
  }
  return status;
}
Fsr4InputSurface surface(id<MTLTexture> texture, uint32_t x, uint32_t y) {
  if (texture.width > UINT32_MAX || texture.height > UINT32_MAX)
    return {};
  return {uint32_t(texture.width), uint32_t(texture.height), x, y};
}
fsr411::Frame frame(const RSTemporalFrame &f) {
  fsr411::Frame v;
  v.color = (__bridge id<MTLTexture>)f.color;
  v.depth = (__bridge id<MTLTexture>)f.depth;
  v.motion = (__bridge id<MTLTexture>)f.motion;
  v.output = (__bridge id<MTLTexture>)f.output;
  v.exposure = (__bridge id<MTLTexture>)f.exposure;
  auto &i = v.input;
  i.geometry = {surface(v.color, f.colorX, f.colorY),
                surface(v.depth, f.depthX, f.depthY),
                surface(v.motion, f.motionX, f.motionY),
                surface(v.output, f.outputX, f.outputY),
                f.maxRenderWidth,
                f.maxRenderHeight};
  i.rw = f.renderWidth;
  i.rh = f.renderHeight;
  i.uw = f.outputWidth;
  i.uh = f.outputHeight;
  i.jitterX = f.jitterX;
  i.jitterY = f.jitterY;
  i.mvScaleX = f.motionScaleX;
  i.mvScaleY = f.motionScaleY;
  i.preExposure = f.preExposure;
  i.reset = !!(f.flags & RS_TEMPORAL_RESET);
  i.depthReversed = !!(f.flags & RS_TEMPORAL_DEPTH_REVERSED);
  i.jitteredMV = !!(f.flags & RS_TEMPORAL_JITTERED_MOTION);
  i.outputResMV = !!(f.flags & RS_TEMPORAL_OUTPUT_MOTION);
  i.autoExposure = !!(f.flags & RS_TEMPORAL_AUTO_EXPOSURE);
  i.hasExposureTexture = f.exposure != nullptr;
  i.inputContentProperties = 1;
  return v;
}
fsr411::Options options(const RSTemporalFrame &f) {
  fsr411::Options o;
  o.profile = f.reserved == 2   ? fsr411::Profile::Lossy
              : f.reserved == 3 ? fsr411::Profile::Lossy2
                                : fsr411::Profile::ExactFast;
  o.allowCompile = false;
  o.ultraPerformance =
      f.renderWidth && double(f.outputWidth) / f.renderWidth >= 2.99;
  o.rcas = f.sharpness > 0;
  o.sharpness = f.sharpness;
  return o;
}
Contract contract(const RSTemporalFrame &f) {
  Contract c{};
  size_t n = 0;
  const id<MTLTexture> textures[] = {
      (__bridge id<MTLTexture>)f.color, (__bridge id<MTLTexture>)f.depth,
      (__bridge id<MTLTexture>)f.motion, (__bridge id<MTLTexture>)f.output,
      (__bridge id<MTLTexture>)f.exposure};
  for (auto t : textures) {
    c[n++] = t.width;
    c[n++] = t.height;
    c[n++] = t.pixelFormat;
    c[n++] = t.usage;
    c[n++] = t.textureType;
  }
  const uint32_t fields[] = {
      f.renderWidth,
      f.renderHeight,
      f.outputWidth,
      f.outputHeight,
      f.maxRenderWidth,
      f.maxRenderHeight,
      f.colorX,
      f.colorY,
      f.depthX,
      f.depthY,
      f.motionX,
      f.motionY,
      f.outputX,
      f.outputY,
      f.flags & (RS_TEMPORAL_DEPTH_REVERSED | RS_TEMPORAL_JITTERED_MOTION |
                 RS_TEMPORAL_OUTPUT_MOTION | RS_TEMPORAL_AUTO_EXPOSURE),
      f.reserved <= 1 ? 0 : f.reserved,
      f.sharpness > 0 ? 1u : 0u,
      f.commandBufferKind};
  for (auto v : fields)
    c[n++] = v;
  return c;
}
std::string validate(const RSTemporalFrame *f) {
  if (!f || f->size < sizeof(*f) || f->version != 1 ||
      f->method != RS_TEMPORAL_FSR4 || f->reserved > 3 ||
      f->commandBufferKind > 1)
    return "Invalid FSR4 temporal frame or model profile";
  if (!f->owner || !f->commandBuffer || !f->color || !f->depth || !f->motion ||
      !f->output)
    return "FSR4 requires color, depth, motion and output textures";
  auto color = (__bridge id<MTLTexture>)f->color;
  if (![color.device supportsFamily:MTLGPUFamilyApple7])
    return "FSR4 requires an Apple Silicon GPU";
  return {};
}
std::pair<std::shared_ptr<Context>, std::shared_ptr<Owner>>
resolve(const RSTemporalFrame &f) {
  const char *root = std::getenv("FSR4_ROOT"),
             *build = std::getenv("FSR4_BUILD_DIR");
  if (!root || root[0] != '/' || !build || build[0] != '/')
    return {};
  std::unique_lock lock(registryMutex, std::try_to_lock);
  if (!lock.owns_lock())
    return {};
  auto device = ((__bridge id<MTLTexture>)f.color).device;
  auto &context = contexts[(__bridge void *)device];
  if (!context)
    context = std::make_shared<Context>(device, root, build);
  auto &owner = context->owners[f.owner];
  if (!owner)
    owner = std::make_shared<Owner>();
  return {context, owner};
}
void prepare(std::shared_ptr<Context> context, std::shared_ptr<Owner> owner) {
  dispatch_async(preparationQueue(), ^{
    @autoreleasepool {
      for (;;) {
        std::shared_ptr<RetainedFrame> request;
        Contract wanted;
        uint64_t generation;
        {
          std::lock_guard lock(owner->mutex);
          if (owner->retired) {
            owner->preparing = false;
            return;
          }
          request = owner->requested;
          wanted = owner->wanted;
          generation = owner->generation;
        }
        auto view = newView();
        std::string error;
        bool ready = false;
        try {
          @try {
            auto f = frame(request->value);
            auto o = options(request->value);
            ready = context->runtime.prepare_resources(
                *view, f, o, request->value.commandBufferKind == 1, error);
          } @catch (NSException *e) {
            error = e.reason.UTF8String ?: "FSR4 preparation failed";
          }
        } catch (const std::exception &e) {
          error = e.what();
        }
        {
          std::lock_guard lock(owner->mutex);
          if (owner->retired) {
            owner->preparing = false;
            return;
          }
          if (generation != owner->generation) {
            prepare(context, owner);
            return;
          }
          if (ready) {
            if (owner->view) {
              context->retired.push_back(std::move(owner->view));
              context->hasRetired = true;
            }
            owner->view = view;
            owner->prepared = wanted;
            owner->hasFrame = false;
            owner->failed = {};
            owner->reason.clear();
          } else {
            owner->failed = wanted;
            owner->reason = error.empty()
                                ? "FSR4 profile resources are unavailable"
                                : error;
          }
          owner->preparing = false;
          owner->requested.reset();
        }
        context->collect();
        if (context->hasRetired)
          collectLater(context);
        return;
      }
    }
  });
}
int request(const RSTemporalFrame &f, const std::shared_ptr<Context> &context,
            const std::shared_ptr<Owner> &owner, const Contract &key,
            RSTemporalResult *out) {
  std::unique_lock lock(owner->mutex, std::try_to_lock);
  if (!lock.owns_lock())
    return result(out, RS_TEMPORAL_BUSY, "FSR4 state is updating");
  if (owner->view && owner->prepared == key)
    return result(out, RS_TEMPORAL_OK);
  if (owner->failed == key && !owner->reason.empty())
    return result(out, RS_TEMPORAL_FAILED, owner->reason);
  if (!owner->preparing || owner->wanted != key) {
    owner->wanted = key;
    owner->requested = std::make_shared<RetainedFrame>(f);
    ++owner->generation;
    if (!owner->preparing) {
      owner->preparing = true;
      prepare(context, owner);
    }
  }
  return result(out, RS_TEMPORAL_BUSY, "FSR4 profile resources are preparing");
}
int prepareResources(const RSTemporalFrame *f, RSTemporalResult *out) {
  @autoreleasepool {
    if (@available(macOS 15.0, *)) {
    } else
      return result(out, RS_TEMPORAL_UNAVAILABLE,
                    "FSR4 requires macOS 15 or newer");
    if (auto reason = validate(f); !reason.empty())
      return result(out, RS_TEMPORAL_INVALID, reason);
    auto [c, o] = resolve(*f);
    if (!c || !o)
      return result(out, RS_TEMPORAL_BUSY,
                    "FSR4 resources are unavailable or updating");
    return request(*f, c, o, contract(*f), out);
  }
}
int encode(const RSTemporalFrame *f, RSTemporalResult *out) {
  @autoreleasepool {
    if (@available(macOS 15.0, *)) {
    } else
      return result(out, RS_TEMPORAL_UNAVAILABLE,
                    "FSR4 requires macOS 15 or newer");
    if (auto reason = validate(f); !reason.empty())
      return result(out, RS_TEMPORAL_INVALID, reason);
    auto [context, owner] = resolve(*f);
    if (!context || !owner)
      return result(out, RS_TEMPORAL_BUSY,
                    "FSR4 resources are unavailable or updating");
    const auto key = contract(*f);
    std::unique_lock lock(owner->mutex, std::try_to_lock);
    if (!lock.owns_lock())
      return result(out, RS_TEMPORAL_BUSY, "FSR4 state is updating");
    if (!owner->view || owner->prepared != key) {
      lock.unlock();
      return request(*f, context, owner, key, out);
    }
    auto &view = *owner->view;
    auto v = frame(*f);
    auto o = options(*f);
    bool reset = owner->hasFrame && (owner->lastFrame == UINT64_MAX ||
                                     f->frameId != owner->lastFrame + 1);
    for (auto &s : view.slots)
      if (s->completion &&
          s->completion.status == MTLCommandBufferStatusError) {
        s->busy = false;
        s->completion = nil;
        view.invalidate();
        view.zeroScratch = view.zeroTargets = true;
        reset = true;
      }
    v.input.reset |= reset;
    std::string error;
    @try {
      if (!context->runtime.encode((__bridge id)f->commandBuffer, view, v, o,
                                   error))
        return result(out,
                      error.find("in flight") != std::string::npos
                          ? RS_TEMPORAL_BUSY
                          : RS_TEMPORAL_FAILED,
                      error);
    } @catch (NSException *e) {
      view.invalidate();
      return result(out, RS_TEMPORAL_FAILED,
                    e.reason.UTF8String ?: "FSR4 encoding failed");
    }
    owner->lastFrame = f->frameId;
    owner->hasFrame = true;
    const bool didReset = view.prepared.reset;
    lock.unlock();
    if (!f->commandBufferKind) {
      std::weak_ptr<Context> weak = context;
      [(__bridge id<MTLCommandBuffer>)f->commandBuffer
          addCompletedHandler:^(id<MTLCommandBuffer>) {
            if (auto c = weak.lock(); c && c->hasRetired)
              collectLater(c);
          }];
    }
    const auto status = result(out, RS_TEMPORAL_OK, {}, true);
    if (out && out->size >= sizeof(*out))
      out->reset = didReset;
    return status;
  }
}
void release(void *identity) {
  std::shared_ptr<Owner> removed;
  {
    std::lock_guard lock(registryMutex);
    for (auto &pair : contexts) {
      auto context = pair.second;
      auto found = context->owners.find(identity);
      if (found == context->owners.end())
        continue;
      auto owner = found->second;
      context->owners.erase(found);
      dispatch_async(preparationQueue(), ^{
        std::lock_guard lock(owner->mutex);
        owner->retired = true;
        if (owner->view) {
          context->retired.push_back(std::move(owner->view));
          context->hasRetired = true;
        }
        owner->requested.reset();
        context->collect();
        if (context->hasRetired)
          collectLater(context);
      });
    }
  }
}
const RSTemporalProvider provider = {
    sizeof(RSTemporalProvider), 1, 1u << RS_TEMPORAL_FSR4, 0, encode, release};
} // namespace
extern "C" __attribute__((visibility("default"))) const RSTemporalProvider *
rsGetTemporalProvider(uint32_t version) {
  return version == 1 ? &provider : nullptr;
}
extern "C" __attribute__((visibility("default"))) int
rsPrepareTemporalResources(const RSTemporalFrame *f, RSTemporalResult *out) {
  return prepareResources(f, out);
}
extern "C" __attribute__((visibility("default"))) uint32_t
rsTemporalProviderProfiles(uint32_t method) {
  return method == RS_TEMPORAL_FSR4 ? 15u : 0u;
}
