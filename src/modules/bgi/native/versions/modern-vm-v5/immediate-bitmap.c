/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "immediate-bitmap.h"
#include "bitmap-loader.h"
#include "vm-dialect.h"

static int supportedBitmap(const Bitmap_t *bitmap) {
    return bitmap && bitmap->bitmap && bitmap->width > 0 && bitmap->height > 0 &&
        bitmap->width <= 8192 && bitmap->height <= 8192 &&
        (uint64_t)bitmap->width * bitmap->height <= 8 * 1024 * 1024 &&
        (bitmap->format == MLBGI_COLOR32 || bitmap->format == MLBGI_ALPHA32);
}
static void clearCanvas(uint8_t *rgba, uint32_t width, uint32_t height, size_t stride) {
    for (uint32_t row = 0; row < height; row++) for (uint32_t column = 0; column < width; column++) {
        uint8_t *pixel = rgba + (size_t)row * stride + (size_t)column * 4;
        pixel[0] = pixel[1] = pixel[2] = 0; pixel[3] = 255;
    }
}
int MLBGI_SetImmediateBitmap(Engine_t *engine, const uint32_t values[9]) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer || !values ||
        values[2] >= RENDERER_MAX_BITMAPS || (values[5] != 0x7fff && values[5] != UINT32_MAX) ||
        values[6] != UINT32_MAX || values[8] != 0) return 0;
    const Bitmap_t *bitmap = engine->renderer->bitmaps[values[2]];
    if (!supportedBitmap(bitmap)) return 0;
    MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
    if (!object->allocated) {
        if (state->drawSequence == UINT64_MAX) return 0;
        *object = (MLBGI_ImmediateBitmap){ .allocated = 1, .drawSequence = ++state->drawSequence };
    }
    /* The same native type reuses its current immediate object. Source
       pixels stay live; replacement/release invalidates the captured identity. */
    object->sourceValid = 1; object->bitmapSlot = values[2]; object->sourceIdentity = bitmap;
    object->x = (int32_t)values[0]; object->y = (int32_t)values[1];
    object->secondX = (int32_t)values[3]; object->secondY = (int32_t)values[4];
    object->selector = values[5]; object->maskParameter = values[7];
    state->drawOrderDirty = 1;
    return 1;
}
void MLBGI_InvalidateImmediateBitmap(Engine_t *engine, uint32_t slot) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (state && state->immediateBitmap.allocated && state->immediateBitmap.bitmapSlot == slot) {
        state->immediateBitmap.sourceValid = 0;
        state->immediateBitmap.sourceIdentity = NULL;
        state->drawOrderDirty = 1;
    }
}
int MLBGI_DrawImmediateBitmap(const Engine_t *engine, uint8_t *rgba, size_t capacity,
                              uint32_t width, uint32_t height, size_t stride) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer || !rgba || !width || !height ||
        width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024 ||
        stride < (size_t)width * 4 || stride > 32 * 1024 * 1024 / height || stride * height > capacity) return 0;
    const MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
    if (!object->allocated) return 1;
    /* The original bitmap draw returns no pixels after source identity
       changes; its immediate-object wrapper clears the canvas in that case. */
    if (!object->sourceValid) { clearCanvas(rgba, width, height, stride); return 1; }
    if (object->bitmapSlot >= RENDERER_MAX_BITMAPS || (object->selector != 0x7fff && object->selector != UINT32_MAX)) return 0;
    const Bitmap_t *bitmap = engine->renderer->bitmaps[object->bitmapSlot];
    if (bitmap != object->sourceIdentity) { clearCanvas(rgba, width, height, stride); return 1; }
    if (!supportedBitmap(bitmap)) return 0;
    uintptr_t output = (uintptr_t)rgba, input = (uintptr_t)bitmap->bitmap;
    size_t outputBytes = stride * height, inputBytes = (size_t)bitmap->width * bitmap->height * 4;
    if ((output <= input && input - output < outputBytes) || (input <= output && output - input < inputBytes)) return 0;
    /* X/Y are viewport origins in the source, with native wrapping offsets.
       The plain-source branch ignores the second viewport and mask parameter. */
    int64_t x = (int32_t)((uint32_t)object->x + (uint32_t)object->offsetX);
    int64_t y = (int32_t)((uint32_t)object->y + (uint32_t)object->offsetY);
    if (x < 0 || y < 0 || (int64_t)bitmap->width - x < width || (int64_t)bitmap->height - y < height)
        clearCanvas(rgba, width, height, stride);
    int64_t left = x < 0 ? -x : 0, top = y < 0 ? -y : 0;
    int64_t right = width, bottom = height;
    if (right > (int64_t)bitmap->width - x) right = (int64_t)bitmap->width - x;
    if (bottom > (int64_t)bitmap->height - y) bottom = (int64_t)bitmap->height - y;
    for (int64_t row = top; row < bottom; row++) for (int64_t column = left; column < right; column++) {
        const uint8_t *source = bitmap->bitmap + ((size_t)(y + row) * bitmap->width + (size_t)(x + column)) * 4;
        uint8_t *pixel = rgba + (size_t)row * stride + (size_t)column * 4;
        unsigned alpha = bitmap->format == MLBGI_COLOR32 || source[3] >= 254 ? 128 : source[3] >> 1;
        for (unsigned channel = 0; channel < 3; channel++) pixel[channel] = (uint8_t)((uint32_t)source[channel] * alpha >> 7);
        pixel[3] = 255;
    }
    return 1;
}
