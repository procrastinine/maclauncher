/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "raw-bitmap.h"
#include <stdlib.h>

static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
int MLBGI_DecodeRawBitmap(const uint8_t *bytes, size_t size, MLBGI_RawBitmap *output) {
    if (!bytes || !output || output->rgba || size < 16 || le32(bytes + 8) || le32(bytes + 12)) return 0;
    uint32_t width = (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8), height = (uint32_t)bytes[2] | ((uint32_t)bytes[3] << 8);
    uint32_t bits = le32(bytes + 4);
    if (!width || !height || width > 8192 || height > 8192 || (bits != 24 && bits != 32)) return 0;
    size_t pixels = (size_t)width * height, stride = bits / 8;
    if (pixels > 8 * 1024 * 1024 || pixels > (SIZE_MAX - 16) / stride || 16 + pixels * stride != size) return 0;
    uint8_t *rgba = malloc(pixels * 4);
    if (!rgba) return 0;
    for (size_t i = 0; i < pixels; i++) {
        const uint8_t *source = bytes + 16 + i * stride;
        rgba[i * 4] = source[2]; rgba[i * 4 + 1] = source[1]; rgba[i * 4 + 2] = source[0];
        rgba[i * 4 + 3] = stride == 4 ? source[3] : 255;
    }
    output->width = width; output->height = height; output->rgba = rgba; return 1;
}
