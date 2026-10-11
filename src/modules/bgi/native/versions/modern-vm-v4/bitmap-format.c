/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "bitmap-format.h"
#include "bitmap-loader.h"

uint32_t MLBGI_SetBitmapFormat(Engine_t *engine, uint32_t slot, uint32_t format) {
    if (!engine || !engine->renderer || slot >= RENDERER_MAX_BITMAPS || !engine->renderer->bitmaps[slot]) return 1;
    Bitmap_t *bitmap = engine->renderer->bitmaps[slot];
    if (!bitmap->bitmap || bitmap->width <= 0 || bitmap->height <= 0 || bitmap->width > 8192 || bitmap->height > 8192 ||
        (uint64_t)bitmap->width * bitmap->height > 8 * 1024 * 1024 ||
        (bitmap->format != MLBGI_COLOR32 && bitmap->format != MLBGI_ALPHA32)) return UINT32_MAX;
    if (format == bitmap->format) return 0;
    if (bitmap->format != MLBGI_ALPHA32 || format != MLBGI_COLOR32) return 2;
    /* The original service changes only format and bytes-per-pixel metadata.
       Both supported formats have four bytes per pixel. Color32 consumers
       ignore the retained alpha byte; storage and cache accounting stay intact. */
    bitmap->format = MLBGI_COLOR32;
    return 0;
}
