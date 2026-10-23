/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_CURRENT_DRAW_H
#define ML_BGI_CURRENT_DRAW_H
#include "immediate-bitmap.h"
int MLBGI_InitializeCurrentDraw(Engine_t *engine);
int MLBGI_CurrentDrawSupported(const MLBGI_ImmediateBitmap *object);
int MLBGI_SelectCurrentBitmap(Engine_t *engine);
#endif
