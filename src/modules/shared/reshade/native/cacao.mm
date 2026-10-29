// Copyright (c) MacLauncher contributors. MIT license.
// Original CACAO kernels and constant functions: AMD, MIT; see cacao-MIT.txt.
#include "cacao.hpp"
#include "cacao-shaders.hpp"
#include "cacao-upstream.hpp"
#include "color-conversion.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include "native-scene-projection.hpp"
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
namespace macfx {
namespace {
struct Settings {
  unsigned quality = 4, blur = 2;
  float radius = 1.2f, strength = 1, sharpness = .98f, fade = 300;
  bool downsample = false, hasColor = false;
  ImageColorDescription color;
};
Settings settings(const ShaderParameters &parameters) {
  Settings s;
  for (const auto &[name, value] : parameters) {
    if (value.size() != 1 || !std::isfinite(value[0]))
      throw std::invalid_argument(
          "CACAO parameters require finite scalar values");
    const float v = value[0];
    if (name == "Quality" && v >= 0 && v <= 4 && std::floor(v) == v)
      s.quality = unsigned(v);
    else if (name == "BlurPasses" && v >= 0 && v <= 8 && std::floor(v) == v)
      s.blur = unsigned(v);
    else if (name == "Radius" && v >= .0001f && v <= 100000)
      s.radius = v;
    else if (name == "Strength" && v >= 0 && v <= 5)
      s.strength = v;
    else if (name == "Sharpness" && v >= 0 && v <= 1)
      s.sharpness = v;
    else if (name == "FadeDistance" && v >= .0001f && v <= 100000)
      s.fade = v;
    else if (name == "HalfResolution" && (v == 0 || v == 1))
      s.downsample = v != 0;
    else
      throw std::invalid_argument("Unsupported CACAO parameter or value");
  }
  return s;
}
ImageColorDescription inputColor(const ShaderFrame &f, const Settings &s) {
  auto c = s.hasColor ? s.color
                      : describeImageColor(f.color == SpatialColor::HDR
                                               ? ImageColorSpace::ExtendedSRGB
                                           : f.color == SpatialColor::Linear
                                               ? ImageColorSpace::LinearSRGB
                                               : ImageColorSpace::SRGB);
  if (f.opaqueDisplay)
    c.alpha = ColorAlpha::Opaque;
  return c;
}
bool sameColor(const ImageColorDescription &a, const ImageColorDescription &b) {
  return a.primaries == b.primaries && a.transfer == b.transfer &&
         a.range == b.range && a.alpha == b.alpha &&
         a.referenceWhite == b.referenceWhite &&
         a.peakLuminance == b.peakLuminance &&
         a.blackLuminance == b.blackLuminance &&
         a.hlgSystemGamma == b.hlgSystemGamma &&
         a.sceneReferred == b.sceneReferred;
}
bool depthFormat(MTLPixelFormat f) {
  return f == MTLPixelFormatDepth24Unorm_Stencil8 ||
         f == MTLPixelFormatDepth32Float ||
         f == MTLPixelFormatDepth32Float_Stencil8 ||
         f == MTLPixelFormatDepth16Unorm;
}
std::string sceneReason(const ShaderFrame &f, const RSTemporalFrame *scene,
                        const std::optional<RSSceneMatrices> &m) {
  auto reason = sceneProjectionReason(f, scene, m);
  if (!reason.empty())
    return "CACAO: " + reason;
  auto depth = (__bridge id<MTLTexture>)scene->depth;
  if (!depthFormat(depth.pixelFormat) &&
      depth.pixelFormat != MTLPixelFormatR32Float &&
      depth.pixelFormat != MTLPixelFormatR16Float &&
      depth.pixelFormat != MTLPixelFormatR16Unorm)
    return "CACAO requires floating-point or normalized scalar depth";
  return {};
}
struct Pipelines {
  id<MTLDevice> device;
  std::map<std::string, id<MTLComputePipelineState>> values;
  id<MTLComputePipelineState> depth;
  std::map<std::string, id<MTLSamplerState>> samplers;
};
struct Resources {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  unsigned width = 0, height = 0;
  bool downsample = false;
  MTLPixelFormat output = MTLPixelFormatInvalid;
  ImageColorDescription color, linear;
  cacao_host::FfxCacaoBufferSizeInfo sizes{};
  std::shared_ptr<Pipelines> pipelines;
  std::map<std::string, id<MTLTexture>> textures;
  std::vector<PooledImage> pooled;
  id<MTLBuffer> counter;
  std::shared_ptr<ImageReservation> counterReservation;
  std::unique_ptr<ColorEncoder> incoming, outgoing;
  std::atomic<bool> failed{false};
  bool matches(const ShaderFrame &f, const Settings &s,
               const ImageColorDescription &c) const {
    return !failed.load() && device == f.commands.device &&
           queue == f.commands.commandQueue && width == f.source.width &&
           height == f.source.height && output == f.target.pixelFormat &&
           downsample == s.downsample && sameColor(color, c);
  }
};
dispatch_queue_t retirement() {
  static auto q = dispatch_queue_create("MacLauncher CACAO retirement",
                                        DISPATCH_QUEUE_SERIAL);
  return q;
}
std::shared_ptr<Resources> resources() {
  return {new Resources, [](Resources *p) {
            dispatch_async(retirement(), ^{
              delete p;
            });
          }};
}
// Every working image is rewritten before it is read in each frame, so
// instances with the same extent and queue share one device copy.
id<MTLTexture> texture(Resources &r, const std::string &name, unsigned w,
                       unsigned h, MTLPixelFormat format, bool target = false,
                       unsigned layers = 1, unsigned mips = 1) {
  auto td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format
                                                               width:w
                                                              height:h
                                                           mipmapped:NO];
  td.textureType = layers > 1 ? MTLTextureType2DArray : MTLTextureType2D;
  td.arrayLength = layers;
  td.mipmapLevelCount = mips;
  td.storageMode = MTLStorageModePrivate;
  td.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite |
             (target ? MTLTextureUsageRenderTarget : 0);
  r.pooled.push_back(shareWorkingImage(r.device, td, "cacao." + name, r.queue));
  return r.pooled.back().texture();
}
std::shared_ptr<Pipelines> pipelines(id<MTLDevice> d) {
  static std::mutex lock;
  static std::map<void *, std::weak_ptr<Pipelines>> cache;
  const auto key = (__bridge void *)d;
  {
    std::lock_guard guard(lock);
    if (auto p = cache[key].lock())
      return p;
  }
  auto p = std::make_shared<Pipelines>();
  p->device = d;
  for (const auto &s : cacao_shaders::shaders) {
    NSError *error = nil;
    auto lib = cachedMetalLibrary(d, s.source, &error);
    auto fn = [lib newFunctionWithName:[NSString stringWithUTF8String:s.entry]];
    auto ps =
        fn ? [d newComputePipelineStateWithFunction:fn error:&error] : nil;
    if (!ps || s.x * s.y * s.z > ps.maxTotalThreadsPerThreadgroup ||
        ps.staticThreadgroupMemoryLength > d.maxThreadgroupMemoryLength)
      throw std::runtime_error(
          error.localizedDescription.UTF8String
              ?: "The CACAO compute work group is unavailable on this GPU");
    p->values[s.name] = ps;
    if (std::strcmp(s.name, "unproject") == 0) {
      std::string code = s.source;
      const char *declaration = "texture2d<float> mlRawDepth";
      auto at = code.find(declaration);
      if (at == std::string::npos)
        throw std::runtime_error("CACAO depth boundary declaration changed");
      code.replace(at, std::strlen(declaration), "depth2d<float> mlRawDepth");
      auto read = code.find("mlRawDepth.read(");
      if (read == std::string::npos)
        throw std::runtime_error("CACAO depth read changed");
      unsigned nested = 1;
      size_t end = read + std::strlen("mlRawDepth.read(");
      for (; end < code.size() && nested; end++) {
        if (code[end] == '(')
          nested++;
        else if (code[end] == ')')
          nested--;
      }
      if (nested || code.compare(end, 2, ".x") != 0)
        throw std::runtime_error("CACAO scalar depth read changed");
      code.erase(end, 2);
      lib = cachedMetalLibrary(d, code, &error);
      fn = [lib newFunctionWithName:[NSString stringWithUTF8String:s.entry]];
      if (fn)
        p->depth = [d newComputePipelineStateWithFunction:fn error:&error];
      if (!p->depth)
        throw std::runtime_error(
            error.localizedDescription.UTF8String
                ?: "CACAO depth-format compilation failed");
    }
  }
  for (const auto &name :
       {"g_PointClampSampler", "g_PointMirrorSampler", "g_LinearClampSampler",
        "g_ViewspaceDepthTapSampler"}) {
    auto s = [MTLSamplerDescriptor new];
    s.minFilter = std::strcmp(name, "g_LinearClampSampler") == 0
                      ? MTLSamplerMinMagFilterLinear
                      : MTLSamplerMinMagFilterNearest;
    s.magFilter = s.minFilter;
    s.mipFilter = MTLSamplerMipFilterNearest;
    s.sAddressMode = s.tAddressMode =
        std::strcmp(name, "g_PointMirrorSampler") == 0
            ? MTLSamplerAddressModeMirrorRepeat
            : MTLSamplerAddressModeClampToEdge;
    auto sampler = [d newSamplerStateWithDescriptor:s];
    if (!sampler)
      throw std::runtime_error("Cannot create a CACAO sampler");
    p->samplers[name] = sampler;
  }
  {
    std::lock_guard guard(lock);
    cache[key] = p;
  }
  return p;
}
void initialize(Resources &r, const ShaderFrame &f, const Settings &s,
                const ImageColorDescription &c) {
  r.device = f.commands.device;
  r.queue = f.commands.commandQueue;
  r.width = (unsigned)f.source.width;
  r.height = (unsigned)f.source.height;
  r.output = f.target.pixelFormat;
  r.downsample = s.downsample;
  r.color = c;
  r.linear = c;
  r.linear.transfer = ColorTransfer::Linear;
  r.linear.range = ColorRange::Full;
  r.linear.alpha = ColorAlpha::Straight;
  r.pipelines = pipelines(r.device);
  cacao_host::ffxCacaoUpdateBufferSizeInfo(r.width, r.height, s.downsample,
                                           &r.sizes);
  auto &b = r.sizes;
  r.textures["linearColor"] =
      texture(r, "linearColor", r.width, r.height, MTLPixelFormatRGBA16Float, true);
  r.textures["shadedColor"] =
      texture(r, "shadedColor", r.width, r.height, MTLPixelFormatRGBA16Float, true);
  r.textures["linearDepth"] =
      texture(r, "linearDepth", r.width, r.height, MTLPixelFormatR32Float);
  r.textures["visibility"] =
      texture(r, "visibility", r.width, r.height, MTLPixelFormatR8Unorm);
  const unsigned levels =
      std::min(4u, 1u + (unsigned)std::floor(std::log2(
                            std::max(b.deinterleavedDepthBufferWidth,
                                     b.deinterleavedDepthBufferHeight))));
  r.textures["depth"] = texture(r, "depth", b.deinterleavedDepthBufferWidth,
                                b.deinterleavedDepthBufferHeight,
                                MTLPixelFormatR16Float, false, 4, levels);
  for (unsigned i = 0; i < 4; i++) {
    auto view = i < levels
                    ? [r.textures["depth"]
                          newTextureViewWithPixelFormat:MTLPixelFormatR16Float
                                            textureType:MTLTextureType2DArray
                                                 levels:NSMakeRange(i, 1)
                                                 slices:NSMakeRange(0, 4)]
                    : texture(r, "mip" + std::to_string(i), 1, 1, MTLPixelFormatR16Float,
                              false, 4);
    if (!view)
      throw std::runtime_error("Cannot create a CACAO depth mip view");
    r.textures["mip" + std::to_string(i)] = view;
  }
  r.textures["normals"] =
      texture(r, "normals", b.ssaoBufferWidth, b.ssaoBufferHeight,
              MTLPixelFormatRGBA8Snorm, false, 4);
  r.textures["ping"] = texture(r, "ping", b.ssaoBufferWidth, b.ssaoBufferHeight,
                               MTLPixelFormatRG8Unorm, false, 4);
  r.textures["pong"] = texture(r, "pong", b.ssaoBufferWidth, b.ssaoBufferHeight,
                               MTLPixelFormatRG8Unorm, false, 4);
  r.textures["importance"] =
      texture(r, "importance", b.importanceMapWidth, b.importanceMapHeight,
              MTLPixelFormatR8Unorm);
  r.textures["importancePong"] =
      texture(r, "importancePong", b.importanceMapWidth, b.importanceMapHeight,
              MTLPixelFormatR8Unorm);
  r.counterReservation =
      reserveImageBytes(r.device, 64, 0, "CACAO adaptive load counter");
  r.counter = [r.device newBufferWithLength:64
                                    options:MTLResourceStorageModePrivate];
  if (!r.counter)
    throw std::runtime_error("Cannot allocate the CACAO adaptive counter");
  r.counterReservation->commit(r.counter.allocatedSize);
  r.incoming = std::make_unique<ColorEncoder>(r.device);
  r.outgoing = std::make_unique<ColorEncoder>(r.device);
  auto a = r.incoming->prepare(MTLPixelFormatRGBA16Float),
       out = r.outgoing->prepare(f.target.pixelFormat);
  if (!a.encoded || !out.encoded)
    throw std::runtime_error(!a.encoded ? a.reason : out.reason);
}
std::string validate(const ShaderFrame &f) {
  if (!f.commands || !f.source || !f.target || f.source == f.target ||
      f.commands.status >= MTLCommandBufferStatusCommitted ||
      !f.commands.retainedReferences)
    return "CACAO requires separate images and retaining unsubmitted Metal "
           "commands";
  if (f.source.device != f.commands.device ||
      f.target.device != f.commands.device ||
      f.source.textureType != MTLTextureType2D ||
      f.target.textureType != MTLTextureType2D || f.source.sampleCount != 1 ||
      f.target.sampleCount != 1 || !f.source.width || !f.source.height ||
      f.source.width != f.target.width || f.source.height != f.target.height)
    return "CACAO requires same-extent resolved images on the current GPU";
  if ((f.source.usage != MTLTextureUsageUnknown &&
       !(f.source.usage & MTLTextureUsageShaderRead)) ||
      (f.target.usage != MTLTextureUsageUnknown &&
       !(f.target.usage & MTLTextureUsageRenderTarget)) ||
      f.source.framebufferOnly)
    return "CACAO requires readable color and a renderable output image";
  return {};
}
class Cacao final : public ShaderNode, public NativeSceneShader {
  std::shared_ptr<const Settings> options;
  std::shared_ptr<Resources> state;

public:
  explicit Cacao(const ShaderParameters &p)
      : options(std::make_shared<Settings>(settings(p))) {}
  void setParameters(const ShaderParameters &p) override {
    auto next = settings(p), old = *std::atomic_load(&options);
    next.color = old.color;
    next.hasColor = old.hasColor;
    std::atomic_store(&options, std::shared_ptr<const Settings>(
                                    std::make_shared<Settings>(next)));
  }
  void setColor(const ImageColorDescription &c) {
    if (!c.valid())
      throw std::invalid_argument("Invalid CACAO image color description");
    auto next = std::make_shared<Settings>(*std::atomic_load(&options));
    next->color = c;
    next->hasColor = true;
    std::atomic_store(&options, std::shared_ptr<const Settings>(next));
  }
  std::shared_ptr<Cacao> fork(const ShaderParameters &p) {
    auto next = std::make_shared<Cacao>(p);
    next->state = std::atomic_load(&state);
    auto value = std::make_shared<Settings>(*next->options);
    auto old = std::atomic_load(&options);
    value->color = old->color;
    value->hasColor = old->hasColor;
    next->options = value;
    return next;
  }
  std::string
  sceneInputReason(const ShaderFrame &f, const RSTemporalFrame *s,
                   const std::optional<RSSceneMatrices> &m) const override {
    return sceneReason(f, s, m);
  }
  ShaderResult prepare(const ShaderFrame &) override {
    return {false, "CACAO requires matching renderer depth and projection",
            true};
  }
  ShaderResult encode(const ShaderFrame &) override {
    return {false, "CACAO requires matching renderer depth and projection",
            true};
  }
  ShaderResult prepareScene(const ShaderFrame &f, const RSTemporalFrame &scene,
                            const std::optional<RSSceneMatrices> &m) override {
    try {
      @autoreleasepool {
        if (auto e = validate(f); !e.empty())
          return {false, e, false};
        if (auto e = sceneReason(f, &scene, m); !e.empty())
          return {false, e, true};
        (void)sceneProjectionConstants(f, scene, *m);
        auto s = std::atomic_load(&options);
        auto c = inputColor(f, *s);
        auto prior = std::atomic_load(&state);
        if (prior && prior->matches(f, *s, c))
          return {true, {}, false};
        auto next = resources();
        initialize(*next, f, *s, c);
        std::atomic_store(&state, next);
        return {true, {}, false};
      }
    } catch (const std::exception &e) {
      return {false, e.what(), false};
    }
  }
  ShaderResult encodeScene(const ShaderFrame &f, const RSTemporalFrame &scene,
                           const std::optional<RSSceneMatrices> &m) override {
    try {
      @autoreleasepool {
        if (auto e = validate(f); !e.empty())
          return {false, e, false};
        if (auto e = sceneReason(f, &scene, m); !e.empty())
          return {false, e, true};
        auto s = std::atomic_load(&options);
        auto c = inputColor(f, *s);
        auto r = std::atomic_load(&state);
        if (!r || !r->matches(f, *s, c))
          return {false, "CACAO resources are preparing for the current image",
                  true};
        auto projection = sceneProjectionConstants(f, scene, *m);
        cacao_host::FfxCacaoConstants constants{};
        static_assert(sizeof(constants) == 688);
        auto sdk = cacao_host::FFX_CACAO_DEFAULT_SETTINGS;
        sdk.radius = s->radius;
        sdk.shadowMultiplier = s->strength;
        sdk.qualityLevel = (cacao_host::FfxCacaoQuality)s->quality;
        sdk.blurPassCount = s->blur;
        sdk.sharpness = s->sharpness;
        sdk.fadeOutFrom = s->fade / 6;
        sdk.fadeOutTo = s->fade;
        sdk.generateNormals = true;
        cacao_host::FfxFloat32x4x4 matrix;
        std::memcpy(matrix, m->projection, 64);
        cacao_host::ffxCacaoUpdateConstants(&constants, &sdk, &r->sizes,
                                            &matrix, nullptr, 1, 0);
        constants.EffectSamplingRadiusNearLimitRec =
            std::abs(constants.EffectSamplingRadiusNearLimitRec);
        auto source = f.source, target = f.target,
             depth = (__bridge id<MTLTexture>)scene.depth;
        [f.commands addCompletedHandler:^(id<MTLCommandBuffer> done) {
          if (done.status != MTLCommandBufferStatusCompleted)
            r->failed = true;
          (void)source;
          (void)target;
          (void)depth;
        }];
        ColorConversion enter;
        enter.source = r->color;
        enter.target = r->linear;
        enter.frameId = f.frameId;
        auto entered = r->incoming->encode(
            f.commands, f.source, r->textures.at("linearColor"), enter);
        if (!entered.encoded)
          return entered;
        auto clear = [f.commands blitCommandEncoder];
        [clear fillBuffer:r->counter range:NSMakeRange(0, 64) value:0];
        [clear endEncoding];
        std::map<std::string, id<MTLTexture>> bindings = {
            {"g_DepthIn", r->textures.at("linearDepth")},
            {"g_DeinterleavedDepth", r->textures.at("depth")},
            {"g_RwDeinterleavedDepth", r->textures.at("mip0")},
            {"g_DeinterleavedNormals", r->textures.at("normals")},
            {"g_RwDeinterleavedNormals", r->textures.at("normals")},
            {"g_SsaoBufferPing", r->textures.at("ping")},
            {"g_RwSsaoBufferPing", r->textures.at("ping")},
            {"g_SsaoBufferPong", r->textures.at("pong")},
            {"g_RwSsaoBufferPong", r->textures.at("pong")},
            {"g_ImportanceMap", r->textures.at("importance")},
            {"g_RwImportanceMap", r->textures.at("importance")},
            {"g_ImportanceMapPong", r->textures.at("importancePong")},
            {"g_RwImportanceMapPong", r->textures.at("importancePong")},
            {"g_RwOutput", r->textures.at("visibility")},
            {"mlRawDepth", (__bridge id<MTLTexture>)scene.depth},
            {"mlLinearDepth", r->textures.at("linearDepth")},
            {"mlColor", r->textures.at("linearColor")},
            {"mlAO", r->textures.at("visibility")},
            {"mlOutput", r->textures.at("shadedColor")}};
        for (unsigned i = 0; i < 4; i++)
          bindings["g_RwDepthMip" + std::to_string(i)] =
              r->textures.at("mip" + std::to_string(i));
        auto dispatch = [&](const std::string &name, MTLSize groups) {
          const cacao_shaders::Shader *shader = nullptr;
          for (const auto &v : cacao_shaders::shaders)
            if (name == v.name) {
              shader = &v;
              break;
            }
          if (!shader)
            throw std::runtime_error("Unknown CACAO kernel");
          auto encoder = [f.commands computeCommandEncoder];
          if (!encoder)
            throw std::runtime_error("Cannot create a CACAO compute encoder");
          auto depth = (__bridge id<MTLTexture>)scene.depth;
          [encoder
              setComputePipelineState:name == "unproject" &&
                                              depthFormat(depth.pixelFormat)
                                          ? r->pipelines->depth
                                          : r->pipelines->values.at(name)];
          [encoder useResource:r->counter
                         usage:MTLResourceUsageRead | MTLResourceUsageWrite];
          for (size_t i = 0; i < shader->count; i++) {
            const auto &b = shader->bindings[i];
            if (std::strcmp(b.kind, "texture") == 0) {
              auto it = bindings.find(b.name);
              if (it == bindings.end())
                throw std::runtime_error("Unknown CACAO texture binding");
              [encoder setTexture:it->second atIndex:b.index];
            } else if (std::strcmp(b.kind, "sampler") == 0)
              [encoder setSamplerState:r->pipelines->samplers.at(b.name)
                               atIndex:b.index];
            else if (std::strcmp(b.name, "SSAOConstantsBuffer_t") == 0)
              [encoder setBytes:&constants
                         length:sizeof(constants)
                        atIndex:b.index];
            else if (std::strcmp(b.name, "MacLauncherScene") == 0)
              [encoder setBytes:&projection
                         length:sizeof(projection)
                        atIndex:b.index];
            else if (std::strcmp(b.name, "g_LoadCounter") == 0 ||
                     std::strcmp(b.name, "g_RwLoadCounter") == 0)
              [encoder setBuffer:r->counter offset:0 atIndex:b.index];
            else
              throw std::runtime_error("Unknown CACAO buffer binding");
          }
          [encoder dispatchThreadgroups:groups
                  threadsPerThreadgroup:MTLSizeMake(shader->x, shader->y,
                                                    shader->z)];
          [encoder endEncoding];
        };
        const auto ceil = [](unsigned value, unsigned tile) {
          return (value + tile - 1) / tile;
        };
        const auto full = MTLSizeMake(ceil(r->width, 8), ceil(r->height, 8), 1);
        dispatch("unproject", full);
        const auto &b = r->sizes;
        const auto prep =
            MTLSizeMake(ceil(b.deinterleavedDepthBufferWidth, 8),
                        ceil(b.deinterleavedDepthBufferHeight, 8), 1);
        const std::string mode = s->downsample ? "downsampled" : "native";
        dispatch("prepare-" + mode + "-" +
                     (s->quality == 0   ? "depths-half"
                      : s->quality == 1 ? "depths"
                                        : "depths-and-mips"),
                 prep);
        dispatch("prepare-" + mode + "-normals",
                 MTLSizeMake(ceil(b.ssaoBufferWidth, 8),
                             ceil(b.ssaoBufferHeight, 8), 1));
        if (s->quality == 4) {
          bindings["g_RwSsaoBufferPing"] = r->textures.at("pong");
          dispatch("generate-q3-base",
                   MTLSizeMake(ceil(b.ssaoBufferWidth, 8),
                               ceil(b.ssaoBufferHeight, 8), 4));
          bindings["g_RwSsaoBufferPing"] = r->textures.at("ping");
          const auto importance = MTLSizeMake(
              ceil(b.importanceMapWidth, 8), ceil(b.importanceMapHeight, 8), 1);
          dispatch("importance", importance);
          dispatch("importance-a", importance);
          dispatch("importance-b", importance);
        }
        const unsigned q = s->quality ? s->quality - 1 : 0;
        if (s->quality <= 2)
          dispatch("generate-q" + std::to_string(q),
                   MTLSizeMake(ceil(ceil(b.ssaoBufferWidth, 4), 5),
                               ceil(b.ssaoBufferHeight, 16),
                               5 * (s->quality == 0 ? 2 : 4)));
        else
          dispatch("generate-q" + std::to_string(q),
                   MTLSizeMake(ceil(b.ssaoBufferWidth, 8),
                               ceil(b.ssaoBufferHeight, 8), 4));
        if (s->blur)
          dispatch("blur-" + std::to_string(s->blur),
                   MTLSizeMake(ceil(b.ssaoBufferWidth, 64 - 2 * s->blur),
                               ceil(b.ssaoBufferHeight, 48 - 2 * s->blur),
                               s->quality == 0 ? 2 : 4));
        if (s->blur)
          bindings["g_SsaoBufferPing"] = r->textures.at("pong");
        if (s->downsample)
          dispatch(s->quality == 0   ? "upscale-half"
                   : s->quality <= 2 ? "upscale-linear"
                                     : "upscale-smart",
                   MTLSizeMake(ceil(r->width, 16), ceil(r->height, 16), 1));
        else
          dispatch(s->quality == 0   ? "apply-non-smart-half"
                   : s->quality == 1 ? "apply-non-smart"
                                     : "apply",
                   full);
        dispatch("compose", full);
        ColorConversion leave;
        leave.source = r->linear;
        leave.target = r->color;
        leave.frameId = f.frameId;
        leave.alphaSource = f.source;
        auto result = r->outgoing->encode(
            f.commands, r->textures.at("shadedColor"), f.target, leave);
        return result;
      }
    } catch (const std::exception &e) {
      return {false, e.what(), false};
    }
  }
};
} // namespace
} // namespace macfx
std::shared_ptr<macfx::ShaderNode>
macfx::makeCacaoNode(const ShaderParameters &p) {
  return std::make_shared<Cacao>(p);
}
std::shared_ptr<macfx::ShaderNode>
macfx::forkCacaoNode(const std::shared_ptr<ShaderNode> &old,
                     const ShaderParameters &p) {
  auto node = std::dynamic_pointer_cast<Cacao>(old);
  return node ? node->fork(p) : nullptr;
}
void macfx::setCacaoNodeColor(const std::shared_ptr<ShaderNode> &node,
                              const ImageColorDescription &c) {
  if (auto n = std::dynamic_pointer_cast<Cacao>(node))
    n->setColor(c);
}
