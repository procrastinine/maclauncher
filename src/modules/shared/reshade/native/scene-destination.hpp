#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-scene-destination.h")
#include "temporal-scene-destination.h"
#else
#include "../temporal/scene-destination.h"
#endif
#include "temporal-frame.h"
#include <optional>
#include <memory>
#include "effects-execution.hpp"
namespace macfx {
class SceneWindowAuthority{
public:
 virtual ~SceneWindowAuthority()=default;
 virtual uint64_t identity()const noexcept=0;
 virtual uint32_t windowNumber()const noexcept=0;
 virtual bool alive()const noexcept=0;
};
std::shared_ptr<const SceneWindowAuthority>temporalSceneWindow(void*nativeWindow);
// A presented destination is not registered by the producer: it names the
// only window whose presenter continues scenes on the frame's device.
struct TemporalSceneDestination{std::shared_ptr<const SceneWindowAuthority>window;void*owner=nullptr;uint64_t frameId=0;uint32_t flags=0;bool presented=false;};
// Frame ID zero performs exact-texture producer-ID lookup before a camera
// receipt exists; actual provider frames always receive the registered ID.
std::optional<TemporalSceneDestination>takeTemporalSceneDestination(const RSTemporalFrame&);
// A presenter that continues scenes in its window notes it with each final
// image. A frame without a registered destination continues in the only such
// window on its device; with none or several, it has no destination.
void noteSceneWindowPresenter(const std::shared_ptr<const void>&presenter,const std::shared_ptr<const SceneWindowAuthority>&,id<MTLDevice>);
std::optional<TemporalSceneDestination>presentedTemporalSceneDestination(const RSTemporalFrame&);
// The registered destination, or else the presented one.
std::optional<TemporalSceneDestination>temporalSceneDestination(const RSTemporalFrame&lookup,const RSTemporalFrame&actual);
class TemporalSceneContinuation {
public:
 virtual ~TemporalSceneContinuation()=default;
 virtual std::shared_ptr<EffectExecution>execution()const=0;
 virtual std::shared_ptr<const EffectSceneLease>scene()const=0;
 virtual uint64_t frameId()const noexcept=0;
 virtual uint32_t inputs()const noexcept=0;
 virtual bool displayMapped()const noexcept=0;
 virtual ShaderResult ready(id<MTLCommandBuffer>)const=0;
 virtual ShaderResult completion()const=0;
 virtual bool claim(id<MTLCommandBuffer>,id<MTLTexture>)=0;
};
void publishTemporalSceneContinuation(id<MTLCommandBuffer>,const TemporalSceneDestination&,const RSTemporalFrame&,std::shared_ptr<EffectExecution>,bool displayMapped=false);
std::shared_ptr<TemporalSceneContinuation>publishRetainedTemporalSceneContinuation(id<MTLCommandBuffer>,const TemporalSceneDestination&,const RSTemporalFrame&,std::shared_ptr<EffectExecution>,std::shared_ptr<const EffectSceneLease>,bool displayMapped=false,id<MTLSharedEvent>readyEvent=nil,uint64_t readyValue=0);
std::shared_ptr<TemporalSceneContinuation>temporalSceneContinuation(const std::shared_ptr<const SceneWindowAuthority>&);
// The continuation for this final image. A presented destination's scene
// continues once, on a final image of the scene's output extent.
std::shared_ptr<TemporalSceneContinuation>temporalSceneContinuation(const std::shared_ptr<const SceneWindowAuthority>&,id<MTLTexture>finalImage);
// Reissue the unchanged image receipt with its original producer dependency.
std::shared_ptr<TemporalSceneContinuation>repeatTemporalSceneContinuation(const TemporalSceneDestination&,const std::shared_ptr<TemporalSceneContinuation>&);
void releaseTemporalSceneContinuations(void*owner);
}
