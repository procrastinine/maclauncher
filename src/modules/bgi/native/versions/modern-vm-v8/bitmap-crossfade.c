/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "bitmap-crossfade.h"
#include "bitmap-loader.h"
#include "current-draw.h"
#include "vm-dialect.h"

static int supportedBitmap(const Bitmap_t *bitmap) {
    return bitmap && bitmap->bitmap && bitmap->width > 0 && bitmap->height > 0 &&
        bitmap->width <= 8192 && bitmap->height <= 8192 &&
        (uint64_t)bitmap->width * bitmap->height <= 8 * 1024 * 1024 &&
        (bitmap->format == MLBGI_COLOR32 || bitmap->format == MLBGI_ALPHA32);
}
static int imageSelector(uint32_t slot) {
    return slot < RENDERER_MAX_BITMAPS && slot != 0x7000 && slot != 0x7001 && slot != 0x7fff;
}
int MLBGI_SetImmediateCrossfade(Engine_t *engine, const uint32_t values[9]) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer || !values ||
        values[2] >= RENDERER_MAX_BITMAPS || !imageSelector(values[5]) ||
        values[6] != UINT32_MAX || values[8] > 256) return 0;
    const Bitmap_t *first = engine->renderer->bitmaps[values[2]], *second = engine->renderer->bitmaps[values[5]];
    if (!supportedBitmap(first) || !supportedBitmap(second) || !MLBGI_SelectCurrentBitmap(engine)) return 0;
    MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
    object->sourceValid = 1; object->hasSecond = 1; object->bitmapSlot = values[2];
    object->sourceIdentity = first; object->secondSourceIdentity = second;
    object->x = (int32_t)values[0]; object->y = (int32_t)values[1];
    object->secondX = (int32_t)values[3]; object->secondY = (int32_t)values[4];
    object->selector = values[5]; object->maskParameter = values[7]; object->transparency = values[8];
    state->drawOrderDirty = 1;
    return 1;
}
static int aliasesOutput(const Bitmap_t *bitmap, const uint8_t *rgba, size_t outputBytes) {
    uintptr_t output = (uintptr_t)rgba, input = (uintptr_t)bitmap->bitmap;
    size_t inputBytes = (size_t)bitmap->width * bitmap->height * 4;
    return (output <= input && input - output < outputBytes) ||
        (input <= output && output - input < inputBytes);
}
static void drawViewport(const Bitmap_t *bitmap, uint8_t *rgba, uint32_t width, uint32_t height, size_t stride,
                         int32_t viewportX, int32_t viewportY, unsigned transparency, int copy) {
    int64_t x = viewportX, y = viewportY;
    int64_t left = x < 0 ? -x : 0, top = y < 0 ? -y : 0;
    int64_t right = width, bottom = height;
    if (right > (int64_t)bitmap->width - x) right = (int64_t)bitmap->width - x;
    if (bottom > (int64_t)bitmap->height - y) bottom = (int64_t)bitmap->height - y;
    /* Mode 1 leaves its destination unchanged at transparency 256.
       Both source generations have already been validated by the caller. */
    if (!copy && transparency == 256) return;
    for (int64_t row = top; row < bottom; row++) for (int64_t column = left; column < right; column++) {
        const uint8_t *source = bitmap->bitmap + ((size_t)(y + row) * bitmap->width + (size_t)(x + column)) * 4;
        uint8_t *pixel = rgba + (size_t)row * stride + (size_t)column * 4;
        unsigned weight;
        if (copy) {
            weight = bitmap->format == MLBGI_COLOR32 || source[3] >= 254 ? 128 : source[3] >> 1;
            for (unsigned channel = 0; channel < 3; channel++) pixel[channel] = (uint8_t)((uint32_t)source[channel] * weight >> 7);
        } else {
            if (bitmap->format == MLBGI_COLOR32) weight = 128 - (transparency >> 1);
            else if (!transparency) weight = source[3] >= 254 ? 128 : source[3] >> 1;
            else weight = ((source[3] >> 1) * (256 - transparency)) >> 8;
            for (unsigned channel = 0; channel < 3; channel++)
                pixel[channel] = (uint8_t)(((uint32_t)source[channel] * weight + (uint32_t)pixel[channel] * (128 - weight)) >> 7);
        }
        pixel[3] = 255;
    }
}
int MLBGI_DrawImmediateCrossfade(const Engine_t *engine, uint8_t *rgba, size_t capacity,
                                uint32_t width, uint32_t height, size_t stride) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer || !rgba || !width || !height ||
        width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024 ||
        stride < (size_t)width * 4 || stride > 32 * 1024 * 1024 / height || stride * height > capacity) return 0;
    const MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
    if (!object->allocated || object->type != 4 || object->hasSecond != 1 ||
        object->bitmapSlot >= RENDERER_MAX_BITMAPS || !imageSelector(object->selector) || object->transparency > 256) return 0;
    const Bitmap_t *first = engine->renderer->bitmaps[object->bitmapSlot], *second = engine->renderer->bitmaps[object->selector];
    if (!object->sourceValid || first != object->sourceIdentity || second != object->secondSourceIdentity) return -1;
    if (!supportedBitmap(first) || !supportedBitmap(second) || aliasesOutput(first, rgba, stride * height) ||
        aliasesOutput(second, rgba, stride * height)) return 0;
    uint32_t offsetX = (uint32_t)object->offsetX + (uint32_t)object->secondOffsetX;
    uint32_t offsetY = (uint32_t)object->offsetY + (uint32_t)object->secondOffsetY;
    /* The native two-image path preserves uncovered canvas, copies the
       secondary viewport with format conversion, then blends the primary. */
    drawViewport(second, rgba, width, height, stride,
        (int32_t)((uint32_t)object->secondX + offsetX), (int32_t)((uint32_t)object->secondY + offsetY), 0, 1);
    drawViewport(first, rgba, width, height, stride,
        (int32_t)((uint32_t)object->x + offsetX), (int32_t)((uint32_t)object->y + offsetY), object->transparency, 0);
    return 1;
}
