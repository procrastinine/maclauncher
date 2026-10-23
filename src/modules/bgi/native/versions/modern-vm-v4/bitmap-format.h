/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_BITMAP_FORMAT_H
#define ML_BGI_BITMAP_FORMAT_H
#include "engine.h"
/* 0 success, 1 missing slot, 2 unsupported conversion; UINT32_MAX invalid storage. */
uint32_t MLBGI_SetBitmapFormat(Engine_t *engine, uint32_t slot, uint32_t format);
#endif
