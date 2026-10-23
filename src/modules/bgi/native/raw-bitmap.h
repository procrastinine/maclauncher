/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_RAW_BITMAP_H
#define ML_BGI_RAW_BITMAP_H
#include <stdint.h>
#include <stddef.h>
typedef struct { uint32_t width, height; uint8_t *rgba; } MLBGI_RawBitmap;
/* The supported raw variant has a 16-byte LE header, tightly packed BGR/BGRA
   pixels and two zero reserved words. Other image variants are rejected. */
int MLBGI_DecodeRawBitmap(const uint8_t *bytes, size_t size, MLBGI_RawBitmap *output);
#endif
