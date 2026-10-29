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
struct TemporalSceneDestination{std::shared_ptr<const SceneWindowAuthority>window;void*owner=nullptr;uint64_t frameId=0;uint32_t flags=0;};
// Frame ID zero performs exact-texture producer-ID lookup before a camera
// receipt exists; actual provider frames always receive the registered ID.
std::optional<TemporalSceneDestination>takeTemporalSceneDestination(const RSTemporalFrame&);
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
void publishRetainedTemporalSceneContinuation(id<MTLCommandBuffer>,const TemporalSceneDestination&,const RSTemporalFrame&,std::shared_ptr<EffectExecution>,std::shared_ptr<const EffectSceneLease>,bool displayMapped=false,id<MTLSharedEvent>readyEvent=nil,uint64_t readyValue=0);
std::shared_ptr<TemporalSceneContinuation>temporalSceneContinuation(const std::shared_ptr<const SceneWindowAuthority>&);
void releaseTemporalSceneContinuations(void*owner);
}
