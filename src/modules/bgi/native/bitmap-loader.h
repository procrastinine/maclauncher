/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_BITMAP_LOADER_H
#define ML_BGI_BITMAP_LOADER_H
#include "renderer.h"
enum { MLBGI_COLOR32 = 1, MLBGI_ALPHA32 = 2 };
Bitmap_t *MLBGI_DecodeBitmap(const uint8_t *bytes, size_t length);
int MLBGI_LoadBitmap(Renderer_t *renderer, int slot, const char *filename, const char *archive);
int MLBGI_CropBitmap(Renderer_t *renderer, uint32_t destination, uint32_t source, int32_t x, int32_t y, uint32_t width, uint32_t height);
int MLBGI_FreeBitmap(Renderer_t *renderer, uint32_t slot);
int MLBGI_CreateBitmap(Renderer_t *renderer, uint32_t slot, uint32_t width, uint32_t height, uint32_t format);
int MLBGI_ClearBitmap(Renderer_t *renderer, uint32_t slot, uint32_t color);
int MLBGI_BlitBitmap(Renderer_t *renderer, uint32_t destination, int32_t x, int32_t y, uint32_t source, uint32_t mode, uint32_t opacity);
int MLBGI_AttachBitmapLoader(Engine_t *engine);
#endif
