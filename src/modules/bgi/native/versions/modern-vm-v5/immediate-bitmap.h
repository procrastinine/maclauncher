/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_IMMEDIATE_BITMAP_H
#define ML_BGI_IMMEDIATE_BITMAP_H
#include "engine.h"
typedef struct {
    int allocated, sourceValid;
    uint32_t bitmapSlot, selector, maskParameter;
    int32_t x, y, secondX, secondY, offsetX, offsetY;
    uint64_t drawSequence;
    const void *sourceIdentity;
} MLBGI_ImmediateBitmap;
int MLBGI_SetImmediateBitmap(Engine_t *engine, const uint32_t values[9]);
void MLBGI_InvalidateImmediateBitmap(Engine_t *engine, uint32_t slot);
int MLBGI_DrawImmediateBitmap(const Engine_t *engine, uint8_t *rgba, size_t capacity,
                              uint32_t width, uint32_t height, size_t stride);
#endif
