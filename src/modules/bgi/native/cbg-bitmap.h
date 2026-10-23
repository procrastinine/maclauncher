/* SPDX-License-Identifier: MIT */
#ifndef ML_BGI_CBG_BITMAP_H
#define ML_BGI_CBG_BITMAP_H
#include <stddef.h>
#include <stdint.h>
typedef struct {
    uint32_t width, height;
    int hasAlpha;
    uint8_t *rgba;
} MLBGI_CbgBitmap;
int MLBGI_DecodeCbgV2(const uint8_t *bytes, size_t size, MLBGI_CbgBitmap *output);
#endif
