#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-scene-aovs.h")
#include "temporal-scene-aovs.h"
#else
#include "../temporal/scene-aovs.h"
#endif
#import <Metal/Metal.h>
#include <array>
#include <memory>
#include <string_view>
#include <optional>
namespace macfx {
inline constexpr std::array<std::string_view,RS_SCENE_AOV_COUNT>sceneAovNames={"normal","roughness","resolvedRadiance","resolvedSpecular","diffuseAlbedo","specularAlbedo","noisyDiffuse","noisySpecular","specularHitDistance","denoiseMask","transparency","metallic","hudlessColor","uiColorAlpha"};
struct SceneAovLease {
 RSSceneAovs value{};
 // Validation belongs to raw ingress. Retained immutable attachments keep
 // their actual device through trusted rebinding and derived color views.
 id<MTLDevice>validatedDevice=nil;
 std::array<id<MTLTexture>,RS_SCENE_AOV_COUNT>textures{};
 RSSceneAovRetirement retirement{};
 std::shared_ptr<const SceneAovLease>upstream;
 // A HUD split belongs to this exact composed image, not every later image
 // retaining its scene guides. Internal only; the public packet stays fixed.
 id<MTLTexture>composedColor=nil;
 uint32_t composedX=0,composedY=0,composedWidth=0,composedHeight=0;
 bool composedRegionKnown=false;
 ~SceneAovLease();
};
std::shared_ptr<const SceneAovLease>temporalSceneAovs(const RSTemporalFrame&);
std::shared_ptr<SceneAovLease>captureSceneAovs(const RSSceneAovs&,id<MTLDevice>);
std::optional<RSSceneAovs>validatedSceneAovs(const RSSceneAovs&,id<MTLDevice>);
int bindTemporalAovsForTextures(const RSTemporalFrame&);
int takeTemporalAovsForTextures(const RSTemporalFrame&,std::shared_ptr<const SceneAovLease>&);
// Metadata observers can read an exact producer registration without stealing
// it from the actual renderer/frame consumer. Owner and frame come from that
// registration; absence or ambiguity never creates a replacement identity.
int peekTemporalAovsForTextures(const RSTemporalFrame&,std::shared_ptr<const SceneAovLease>&,void*&registeredOwner);
// A derived full-viewport color retains the original attachment UV domain.
// The caller copies this lease before the producer command completes.
int bindSceneAovLease(const RSTemporalFrame&,const std::shared_ptr<const SceneAovLease>&);
// Only for an already-recorded full-image, same-format byte copy. It cannot
// authorize a split after a shader, color conversion, crop or other transform.
std::shared_ptr<const SceneAovLease>copiedSceneAovLease(const std::shared_ptr<const SceneAovLease>&,id<MTLTexture>source,id<MTLTexture>target);
}
