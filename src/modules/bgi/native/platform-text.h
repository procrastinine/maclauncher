/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_PLATFORM_TEXT_H
#define ML_BGI_PLATFORM_TEXT_H
#include "engine.h"
typedef struct {
    uint32_t bitmap;
    int32_t x, y;
    const char *text, *family;
    uint32_t height, widthPercent, style, color;
    uint32_t effectType, effectWidthPercent, effectHeightPercent, effectColor, effectOpacity;
} MLBGI_BitmapText;
int MLBGI_RenderBitmapText(Engine_t *engine, const MLBGI_BitmapText *text, uint32_t *characters);
int MLBGI_AttachTextRenderer(Engine_t *engine);
#endif
