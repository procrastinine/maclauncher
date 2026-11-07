// SPDX-License-Identifier: MIT
#pragma once
#include "temporal-carrier.h"
#include "scene-aovs.h"
#include "scene-matrices.h"
#include <math.h>
#include <stdbool.h>
#include <string.h>
/* Fixed producer conventions: Streamline b998246a3d499c08765c5681b229c9e6b4513348,
 * docs/ProgrammingGuideDLSS_RR.md:138,146 (linear reflectance),166,357-358
 * (material roughness R, squared for BRDF alpha),212 (world hit distance).
 * docs/ProgrammingGuideDLSS_G.md:235-236: HUD-less matches the BACKBUFFER;
 * TEMPORAL_UI RGB is premultiplied. The carrier does not declare that backbuffer's
 * absolute domain, normal encoding/space, or an atlas ROI: do not infer them. */
static bool mvkTemporalScene_matrix(const float *source, float *target)
{
    bool nonzero = false;
    for (unsigned i = 0; i < 16; i++) {
        if (!isfinite(source[i])) return false;
        nonzero |= source[i] != 0.0f;
    }
    if (nonzero) memcpy(target, source, 16 * sizeof(float));
    return nonzero;
}
static RSSceneMatrices mvkTemporalScene_matrices(const VkTemporalFrameInfoMVK *info)
{
    RSSceneMatrices m = {0};
    m.size = sizeof(m); m.version = RS_SCENE_MATRICES_ABI_VERSION; m.frameId = info->frameId;
    /* Both contracts are row-major row vectors; copy unchanged, without transpose. */
    if (mvkTemporalScene_matrix(info->worldToViewMatrix, m.view)) m.flags |= RS_SCENE_VIEW_VALID;
    if (mvkTemporalScene_matrix(info->viewToClipMatrix, m.projection)) m.flags |= RS_SCENE_PROJECTION_VALID;
    return m;
}
static bool mvkTemporalScene_aovs(const RSTemporalFrame *f, uint64_t feature_id, uint32_t feature_type, uint32_t scene_flags, bool roughness_alias,
                       void *const *textures, const uint32_t *widths, const uint32_t *heights,
                       RSSceneAovs *a)
{
    memset(a, 0, sizeof(*a));
    a->size = sizeof(*a); a->version = RS_SCENE_AOV_ABI_VERSION; a->frameId = f->frameId;
    /* One SDK feature is one driver history/view lifetime; each evaluate is its image revision. */
    a->viewId = a->epoch = feature_id; a->imageRevision = f->frameId;
    a->preExposure = f->preExposure;
    if (feature_type == TEMPORAL_RAY_RECONSTRUCTION) a->flags |= RS_SCENE_AOV_COLOR_NOISY;
    /* Preserve the existing RSTemporalFrame RGB contract, not the absent backbuffer domain. */
    a->color.size = sizeof(a->color); a->color.version = 1; a->color.primaries = RS_COLOR_BT709;
    a->color.transfer = f->flags & RS_TEMPORAL_HDR ? RS_COLOR_LINEAR : RS_COLOR_SRGB;
    a->color.range = RS_COLOR_FULL; a->color.alpha = RS_COLOR_STRAIGHT;
    a->color.referenceWhite = 203; a->color.peakLuminance = f->flags & RS_TEMPORAL_HDR ? 1000 : 203;
    a->color.hlgSystemGamma = 1.2f;
    if (feature_type == TEMPORAL_RAY_RECONSTRUCTION) a->color.flags = RS_COLOR_SCENE_REFERRED;
    if(textures[TEMPORAL_UI])a->uiColor.alpha = RS_COLOR_PREMULTIPLIED; /* unknown domain, known alpha. */
    static const unsigned inputs[] = {TEMPORAL_NORMALS, TEMPORAL_ROUGHNESS, TEMPORAL_DIFFUSE_ALBEDO, TEMPORAL_SPECULAR_ALBEDO,
                                     TEMPORAL_SPECULAR_HIT_DISTANCE, TEMPORAL_HUDLESS, TEMPORAL_UI};
    static const unsigned slots[] = {RS_SCENE_AOV_NORMAL, RS_SCENE_AOV_ROUGHNESS,
        RS_SCENE_AOV_DIFFUSE_ALBEDO, RS_SCENE_AOV_SPECULAR_ALBEDO, RS_SCENE_AOV_SPECULAR_HIT_DISTANCE,
        RS_SCENE_AOV_HUDLESS_COLOR, RS_SCENE_AOV_UI_COLOR_ALPHA};
    bool supplied = false;
    for (unsigned n = 0; n < sizeof(inputs) / sizeof(inputs[0]); n++) {
        const unsigned input = inputs[n], slot = slots[n];
        if (!textures[input]) continue;
        supplied = true;
        RSSceneAovImage *image = &a->images[slot];
        image->texture = textures[input]; image->width = widths[input]; image->height = heights[input];
        image->scale = 1; image->origin = RS_SCENE_AOV_TOP_LEFT;
        if (slot == RS_SCENE_AOV_NORMAL) image->encoding = RS_SCENE_AOV_UNKNOWN;
        else if (slot == RS_SCENE_AOV_ROUGHNESS || slot == RS_SCENE_AOV_SPECULAR_HIT_DISTANCE)
            image->encoding = RS_SCENE_AOV_SCALAR;
        else if (slot == RS_SCENE_AOV_HUDLESS_COLOR || slot == RS_SCENE_AOV_UI_COLOR_ALPHA)
            image->encoding = RS_SCENE_AOV_COLOR;
        else image->encoding = RS_SCENE_AOV_LINEAR;
        if(slot==RS_SCENE_AOV_ROUGHNESS){
            if(scene_flags&TEMPORAL_ROUGHNESS_NORMAL_ALPHA){
                if(roughness_alias)image->channel=3;else image->encoding=RS_SCENE_AOV_UNKNOWN;
            }else if(roughness_alias)image->encoding=RS_SCENE_AOV_UNKNOWN; /* old producer lost packed mode */
        }
        if (slot == RS_SCENE_AOV_SPECULAR_HIT_DISTANCE) image->space = RS_SCENE_AOV_SPACE_WORLD;
        /* No guide-atlas offset is carried. Retain mismatched views as unknown,
         * never stretch an allocation into a purported active render viewport. */
        if (slot != RS_SCENE_AOV_HUDLESS_COLOR && slot != RS_SCENE_AOV_UI_COLOR_ALPHA &&
            (image->width != f->renderWidth || image->height != f->renderHeight))
            image->encoding = RS_SCENE_AOV_UNKNOWN;
    }
    return supplied;
}
