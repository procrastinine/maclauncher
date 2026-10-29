// Generated from the shared scene input registry. MIT license.
#pragma once
#include <stdint.h>
#define RS_SHADER_SCENE_ABI_VERSION 1
enum RSShaderSceneRole {
 RS_SHADER_SCENE_NORMAL=0,
 RS_SHADER_SCENE_ROUGHNESS=1,
 RS_SHADER_SCENE_RESOLVED_RADIANCE=2,
 RS_SHADER_SCENE_RESOLVED_SPECULAR=3,
 RS_SHADER_SCENE_DIFFUSE_ALBEDO=4,
 RS_SHADER_SCENE_SPECULAR_ALBEDO=5,
 RS_SHADER_SCENE_NOISY_DIFFUSE=6,
 RS_SHADER_SCENE_NOISY_SPECULAR=7,
 RS_SHADER_SCENE_SPECULAR_HIT_DISTANCE=8,
 RS_SHADER_SCENE_DENOISE_MASK=9,
 RS_SHADER_SCENE_TRANSPARENCY=10,
 RS_SHADER_SCENE_METALLIC=11,
 RS_SHADER_SCENE_HUDLESS_COLOR=12,
 RS_SHADER_SCENE_UI_COLOR_ALPHA=13,
 RS_SHADER_SCENE_DEPTH=14,
 RS_SHADER_SCENE_MOTION=15,
 RS_SHADER_SCENE_EXPOSURE=16,
 RS_SHADER_SCENE_VIEW_MATRIX=17,
 RS_SHADER_SCENE_PROJECTION_MATRIX=18,
 RS_SHADER_SCENE_ROLE_COUNT=19
};
static const char*const rsShaderSceneRoleNames[RS_SHADER_SCENE_ROLE_COUNT]={"normal","roughness","resolvedRadiance","resolvedSpecular","diffuseAlbedo","specularAlbedo","noisyDiffuse","noisySpecular","specularHitDistance","denoiseMask","transparency","metallic","hudlessColor","uiColorAlpha","depth","motion","exposure","viewMatrix","projectionMatrix"};
