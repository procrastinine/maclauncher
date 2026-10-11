/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_BITMAP_CROSSFADE_H
#define ML_BGI_BITMAP_CROSSFADE_H
#include "engine.h"
int MLBGI_SetImmediateCrossfade(Engine_t *engine, const uint32_t values[9]);
/* -1 means that a captured source generation disappeared; the native
   immediate wrapper supplies black. Zero rejects an unsupported state. */
int MLBGI_DrawImmediateCrossfade(const Engine_t *engine, uint8_t *rgba, size_t capacity,
                                uint32_t width, uint32_t height, size_t stride);
#endif
