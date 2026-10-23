/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "bitmap-loader.h"
#include "archive-reader.h"
#include "raw-bitmap.h"
#include "cbg-bitmap.h"
#include "vm-dialect.h"
#include "particle-resources.h"
#include "spng.h"
Bitmap_t *MLBGI_DecodeBitmap(const uint8_t *bytes, size_t length) {
    if (!bytes || !length || length > 32 * 1024 * 1024) return NULL;
    Bitmap_t *bitmap = NULL;
    const uint8_t signature[8] = {0x89, 'P', 'N', 'G', 13, 10, 26, 10};
    if (length >= 8 && !memcmp(bytes, signature, 8)) {
        spng_ctx *context = spng_ctx_new(0);
        if (!context) return NULL;
        struct spng_ihdr header = {0}; size_t rgbaBytes = 0;
        if (!spng_set_png_buffer(context, bytes, length) && !spng_get_ihdr(context, &header) &&
            header.width && header.height && header.width <= 8192 && header.height <= 8192 &&
            (uint64_t)header.width * header.height <= 8 * 1024 * 1024 &&
            !spng_decoded_image_size(context, SPNG_FMT_RGBA8, &rgbaBytes) &&
            rgbaBytes == (size_t)header.width * header.height * 4) {
            bitmap = calloc(1, sizeof(*bitmap));
            if (bitmap) {
                bitmap->width = (int)header.width; bitmap->height = (int)header.height;
                struct spng_trns transparency = {0};
                bitmap->format = header.color_type == SPNG_COLOR_TYPE_TRUECOLOR_ALPHA ||
                    header.color_type == SPNG_COLOR_TYPE_GRAYSCALE_ALPHA || !spng_get_trns(context, &transparency) ? MLBGI_ALPHA32 : MLBGI_COLOR32;
                bitmap->bitmap = malloc(rgbaBytes);
                if (!bitmap->bitmap || spng_decode_image(context, bitmap->bitmap, rgbaBytes, SPNG_FMT_RGBA8, SPNG_DECODE_TRNS)) {
                    free(bitmap->bitmap); free(bitmap); bitmap = NULL;
                }
            }
        }
        spng_ctx_free(context);
    } else if (length >= 16 && !memcmp(bytes, "CompressedBG___", 16)) {
        MLBGI_CbgBitmap decoded = {0};
        if (!MLBGI_DecodeCbgV2(bytes, length, &decoded)) return NULL;
        bitmap = calloc(1, sizeof(*bitmap));
        if (bitmap) {
            bitmap->width = (int)decoded.width; bitmap->height = (int)decoded.height;
            bitmap->format = decoded.hasAlpha ? MLBGI_ALPHA32 : MLBGI_COLOR32; bitmap->bitmap = decoded.rgba;
        } else free(decoded.rgba);
    } else {
        MLBGI_RawBitmap raw = {0};
        if (!MLBGI_DecodeRawBitmap(bytes, length, &raw)) return NULL;
        bitmap = calloc(1, sizeof(*bitmap));
        if (bitmap) { bitmap->width = (int)raw.width; bitmap->height = (int)raw.height; bitmap->format = bytes[4] == 32 ? MLBGI_ALPHA32 : MLBGI_COLOR32; bitmap->bitmap = raw.rgba; }
        else free(raw.rgba);
    }
    return bitmap;
}
int MLBGI_LoadBitmap(Renderer_t *renderer, int slot, const char *filename, const char *archive) {
    if (!renderer || slot < 0 || slot >= RENDERER_MAX_BITMAPS || !filename) return 0;
    MLBGI_Runtime *state = renderer->engine ? renderer->engine->mlRuntime : NULL;
    if (state) state->bitmapLoadError[0] = 0;
    size_t length = 0;
    uint8_t *bytes = Engine_ReadFile(renderer->engine, archive, filename, &length);
    if (!bytes) {
        if (state) snprintf(state->bitmapLoadError, sizeof(state->bitmapLoadError), "Bitmap '%.*s' could not be read: %.*s", 96, filename, 96, MLBGI_ArchiveError());
        return 0;
    }
    Bitmap_t *bitmap = MLBGI_DecodeBitmap(bytes, length);
    if (!bitmap && state) {
        char header[33]; size_t shown = length < 16 ? length : 16;
        for (size_t i = 0; i < shown; i++) snprintf(header + i * 2, 3, "%02x", bytes[i]);
        header[shown * 2] = 0;
        snprintf(state->bitmapLoadError, sizeof(state->bitmapLoadError), "Bitmap '%.*s' has an unsupported or invalid format (%zu bytes, header %s)", 96, filename, length, header);
    }
    free(bytes);
    if (!bitmap) return 0;
    Bitmap_t *previous = renderer->bitmaps[slot];
    size_t oldBytes = previous ? (size_t)previous->width * previous->height * 4 : 0;
    if (!MLBGI_AccountBitmap(renderer->engine, oldBytes, (size_t)bitmap->width * bitmap->height * 4)) {
        if (state) snprintf(state->bitmapLoadError, sizeof(state->bitmapLoadError), "Bitmap '%.*s' exceeds its image memory budget", 96, filename);
        free(bitmap->bitmap); free(bitmap); return 0;
    }
    renderer->bitmaps[slot] = bitmap;
    if (previous) { free(previous->bitmap); free(previous); }
    return 1;
}
static int load(Engine_t *engine, uint32_t slot, const char *archive, const char *filename) {
    return slot < RENDERER_MAX_BITMAPS && MLBGI_LoadBitmap(engine->renderer, (int)slot, filename, archive);
}
static int info(Engine_t *engine, uint32_t slot, uint32_t output[6]) {
    if (!engine || !engine->renderer || slot >= RENDERER_MAX_BITMAPS || !output) return 0;
    Bitmap_t *bitmap = engine->renderer->bitmaps[slot];
    if (!bitmap) return 0;
    /* Native pixel pointers stay outside VM address space. The public
       metadata preserves the original six-word shape and source format. */
    /* Both native padded color32 (1) and alpha32 (2) use four bytes.
       File bit depth is distinct from this runtime pixel-format ID. */
    uint32_t bytesPerPixel = 4;
    output[0] = 0; output[1] = (uint32_t)bitmap->width * bytesPerPixel;
    output[2] = (uint32_t)bitmap->width; output[3] = (uint32_t)bitmap->height;
    output[4] = bitmap->format; output[5] = bytesPerPixel;
    return 1;
}
int MLBGI_CropBitmap(Renderer_t *renderer, uint32_t destination, uint32_t source, int32_t x, int32_t y, uint32_t width, uint32_t height) {
    if (!renderer || destination >= RENDERER_MAX_BITMAPS || source >= RENDERER_MAX_BITMAPS ||
        !width || !height || width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024) return 0;
    Bitmap_t *original = renderer->bitmaps[source];
    /* Contained source rectangles have a defined exact copy contract.
       Outside-source clipping remains unsupported until its fill policy
       can be reproduced without exposing uninitialized native pixels. */
    if (!original || x < 0 || y < 0 || (uint64_t)(uint32_t)x + width > (uint32_t)original->width ||
        (uint64_t)(uint32_t)y + height > (uint32_t)original->height) return 0;
    Bitmap_t *bitmap = calloc(1, sizeof(*bitmap));
    if (!bitmap) return 0;
    size_t bytes = (size_t)width * height * 4;
    bitmap->bitmap = malloc(bytes);
    if (!bitmap->bitmap) { free(bitmap); return 0; }
    bitmap->width = (int)width; bitmap->height = (int)height; bitmap->format = original->format;
    for (uint32_t row = 0; row < height; row++)
        memcpy(bitmap->bitmap + (size_t)row * width * 4,
               original->bitmap + ((size_t)(y + row) * original->width + (uint32_t)x) * 4, (size_t)width * 4);
    Bitmap_t *previous = renderer->bitmaps[destination];
    size_t oldBytes = previous ? (size_t)previous->width * previous->height * 4 : 0;
    if (!MLBGI_AccountBitmap(renderer->engine, oldBytes, bytes)) { free(bitmap->bitmap); free(bitmap); return 0; }
    renderer->bitmaps[destination] = bitmap;
    if (previous) { free(previous->bitmap); free(previous); }
    return 1;
}
int MLBGI_FreeBitmap(Renderer_t *renderer, uint32_t slot) {
    if (!renderer || slot >= RENDERER_MAX_BITMAPS || !renderer->bitmaps[slot]) return 0;
    Bitmap_t *bitmap = renderer->bitmaps[slot];
    if (!MLBGI_AccountBitmap(renderer->engine, (size_t)bitmap->width * bitmap->height * 4, 0)) return 0;
    renderer->bitmaps[slot] = NULL; free(bitmap->bitmap); free(bitmap); return 1;
}
int MLBGI_CreateBitmap(Renderer_t *renderer, uint32_t slot, uint32_t width, uint32_t height, uint32_t format) {
    if (!renderer || slot >= RENDERER_MAX_BITMAPS || !width || !height || width > 8192 || height > 8192 ||
        (uint64_t)width * height > 8 * 1024 * 1024 || (format != 1 && format != 2)) return 0;
    Bitmap_t *bitmap = calloc(1, sizeof(*bitmap));
    if (!bitmap) return 0;
    size_t bytes = (size_t)width * height * 4;
    bitmap->bitmap = calloc(1, bytes);
    if (!bitmap->bitmap) { free(bitmap); return 0; }
    bitmap->width = (int)width; bitmap->height = (int)height; bitmap->format = format;
    if (format == MLBGI_COLOR32) for (size_t offset = 3; offset < bytes; offset += 4) bitmap->bitmap[offset] = 255;
    Bitmap_t *previous = renderer->bitmaps[slot];
    size_t oldBytes = previous ? (size_t)previous->width * previous->height * 4 : 0;
    if (!MLBGI_AccountBitmap(renderer->engine, oldBytes, bytes)) { free(bitmap->bitmap); free(bitmap); return 0; }
    renderer->bitmaps[slot] = bitmap;
    if (previous) { free(previous->bitmap); free(previous); }
    return 1;
}
int MLBGI_ClearBitmap(Renderer_t *renderer, uint32_t slot, uint32_t color) {
    if (!renderer || slot >= RENDERER_MAX_BITMAPS || !renderer->bitmaps[slot]) return 0;
    Bitmap_t *bitmap = renderer->bitmaps[slot];
    uint8_t red = (uint8_t)(color >> 16), green = (uint8_t)(color >> 8), blue = (uint8_t)color;
    uint8_t alpha = bitmap->format == MLBGI_COLOR32 ? 255 : (uint8_t)(color >> 24);
    size_t bytes = (size_t)bitmap->width * bitmap->height * 4;
    for (size_t offset = 0; offset < bytes; offset += 4) {
        bitmap->bitmap[offset] = red; bitmap->bitmap[offset + 1] = green;
        bitmap->bitmap[offset + 2] = blue; bitmap->bitmap[offset + 3] = alpha;
    }
    return 1;
}
int MLBGI_BlitBitmap(Renderer_t *renderer, uint32_t destination, int32_t x, int32_t y, uint32_t source, uint32_t mode, uint32_t opacity) {
    /* The modern service takes mode before opacity. Mode 128 copies raw
       pixels with native format conversion; mode 64 erases selected
       pixels. Modes 0 and 1 composite both color32 and alpha32 sources.
       Color destinations use seven-bit alpha; alpha destinations use
       the native coverage-normalization calculation. Other branches fail before
       changing any pixels. */
    if (!renderer || destination >= RENDERER_MAX_BITMAPS || source >= RENDERER_MAX_BITMAPS || opacity > 256 ||
        (mode != 0 && mode != 1 && mode != 64 && mode != 128)) return 0;
    Bitmap_t *target = renderer->bitmaps[destination], *original = renderer->bitmaps[source];
    if (!target || !original || (target->format != 1 && target->format != 2) ||
        (original->format != 1 && original->format != 2)) return 0;
    /* Native mode 1 dispatches to mode 0 at zero transparency and does
       not touch any pixel at its fully transparent endpoint. */
    if (mode == 1 && !opacity) mode = 0;
    else if (mode == 1 && opacity == 256) return 1;
    int64_t left = x < 0 ? -(int64_t)x : 0, top = y < 0 ? -(int64_t)y : 0;
    int64_t right = original->width, bottom = original->height;
    if (right > (int64_t)target->width - x) right = (int64_t)target->width - x;
    if (bottom > (int64_t)target->height - y) bottom = (int64_t)target->height - y;
    if (left >= right || top >= bottom) return 1;
    size_t width = (size_t)(right - left), rows = (size_t)(bottom - top), rowBytes = width * 4;
    uint8_t *snapshot = NULL;
    if (target == original) {
        snapshot = malloc(rowBytes * rows);
        if (!snapshot) return 0;
        for (size_t row = 0; row < rows; row++) memcpy(snapshot + row * rowBytes,
            original->bitmap + (((size_t)top + row) * original->width + (size_t)left) * 4, rowBytes);
    }
    for (size_t row = 0; row < rows; row++) {
        uint8_t *output = target->bitmap + (((size_t)((int64_t)y + top) + row) * target->width + (size_t)((int64_t)x + left)) * 4;
        const uint8_t *input = snapshot ? snapshot + row * rowBytes :
            original->bitmap + (((size_t)top + row) * original->width + (size_t)left) * 4;
        for (size_t column = 0; column < width; column++, output += 4, input += 4) {
            if ((mode == 0 || mode == 1) && original->format == MLBGI_ALPHA32) {
                unsigned alpha = input[3];
                if (!alpha) continue;
                if (!mode && alpha == 255) { memcpy(output, input, 4); output[3] = 255; continue; }
                if (target->format == MLBGI_COLOR32) {
                    unsigned weight = mode == 0 ? alpha >= 254 ? 128 : alpha >> 1 : ((alpha >> 1) * (256 - opacity)) >> 8;
                    for (unsigned channel = 0; channel < 3; channel++)
                        output[channel] = (uint8_t)(((uint32_t)input[channel] * weight + (uint32_t)output[channel] * (128 - weight)) >> 7);
                    output[3] = 255;
                } else {
                    /* The original scalar consumer normalizes straight
                       RGB by separate eight-bit coverage weights. */
                    uint32_t sourceCoverage = alpha * (mode ? 256 - opacity : 256);
                    uint32_t targetCoverage = ((uint32_t)output[3] * (65536 - sourceCoverage)) >> 8;
                    uint32_t coverage = sourceCoverage + targetCoverage;
                    uint32_t sourceWeight = (sourceCoverage << 8) / coverage, targetWeight = (targetCoverage << 8) / coverage;
                    for (unsigned channel = 0; channel < 3; channel++)
                        output[channel] = (uint8_t)(((uint32_t)input[channel] * sourceWeight + (uint32_t)output[channel] * targetWeight) >> 8);
                    output[3] = (uint8_t)(coverage >> 8);
                }
            } else if (mode == 1 && target->format == MLBGI_ALPHA32) {
                /* Color32 supplies full source coverage; this native
                   conversion keeps sixteen-bit RGB normalization. */
                uint32_t sourceCoverage = 255 * (256 - opacity);
                uint32_t targetCoverage = ((uint32_t)output[3] * (65536 - sourceCoverage)) >> 8;
                uint32_t coverage = sourceCoverage + targetCoverage;
                uint32_t sourceWeight = (sourceCoverage << 16) / coverage, targetWeight = (targetCoverage << 16) / coverage;
                for (unsigned channel = 0; channel < 3; channel++)
                    output[channel] = (uint8_t)(((uint32_t)input[channel] * sourceWeight + (uint32_t)output[channel] * targetWeight) >> 16);
                output[3] = (uint8_t)(coverage >> 8);
            } else if (mode == 1) {
                unsigned weight = opacity >> 1;
                for (unsigned channel = 0; channel < 3; channel++)
                    output[channel] = (uint8_t)(((uint32_t)input[channel] * (128 - weight) + (uint32_t)output[channel] * weight) >> 7);
                output[3] = 255;
            } else if (mode == 64) {
                int erase = original->format == MLBGI_COLOR32 ? input[0] || input[1] || input[2] :
                    opacity ? input[3] != 0 : input[3] == 255;
                if (erase) {
                    output[0] = output[1] = output[2] = 0;
                    output[3] = target->format == MLBGI_COLOR32 ? 255 : 0;
                }
            } else if (original->format == MLBGI_ALPHA32 && target->format == MLBGI_COLOR32) {
                /* The native conversion uses a seven-bit alpha table.
                   Its terminal entry maps alpha 254 and 255 to 128. */
                unsigned alpha = input[3] >= 254 ? 128 : input[3] >> 1;
                for (unsigned channel = 0; channel < 3; channel++) output[channel] = (uint8_t)(input[channel] * alpha >> 7);
                output[3] = 255;
            } else {
                memcpy(output, input, 4);
                if (target->format == MLBGI_COLOR32 || original->format == MLBGI_COLOR32) output[3] = 255;
            }
        }
    }
    free(snapshot); return 1;
}
static int crop(Engine_t *engine, uint32_t destination, uint32_t source, int32_t x, int32_t y, uint32_t width, uint32_t height) {
    return engine && MLBGI_CropBitmap(engine->renderer, destination, source, x, y, width, height);
}
static int release(Engine_t *engine, uint32_t slot) { return engine && MLBGI_FreeBitmap(engine->renderer, slot); }
static int create(Engine_t *engine, uint32_t slot, uint32_t width, uint32_t height, uint32_t format) {
    return engine && MLBGI_CreateBitmap(engine->renderer, slot, width, height, format);
}
static int clear(Engine_t *engine, uint32_t slot, uint32_t color) { return engine && MLBGI_ClearBitmap(engine->renderer, slot, color); }
static int blit(Engine_t *engine, uint32_t destination, int32_t x, int32_t y, uint32_t source, uint32_t mode, uint32_t opacity) {
    return engine && MLBGI_BlitBitmap(engine->renderer, destination, x, y, source, mode, opacity);
}
static int windowBitmap(Engine_t *engine, uint32_t slot, uint32_t bitmapSlot) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || !engine->renderer || slot >= 16 || !state->windows[slot].allocated) return 0;
    MLBGI_WindowObject *window = &state->windows[slot];
    if (!window->pixels || !window->width || !window->height || window->width > 8192 || window->height > 32768 ||
        (uint64_t)window->width * window->height > 8 * 1024 * 1024) return 0;
    Bitmap_t *bitmap = bitmapSlot < RENDERER_MAX_BITMAPS ? engine->renderer->bitmaps[bitmapSlot] : NULL;
    if (bitmapSlot != UINT32_MAX && (!bitmap || !bitmap->bitmap || bitmap->width <= 0 || bitmap->height <= 0 ||
        bitmap->width > 8192 || bitmap->height > 8192 || (uint64_t)bitmap->width * bitmap->height > 8 * 1024 * 1024 ||
        (bitmap->format != MLBGI_COLOR32 && bitmap->format != MLBGI_ALPHA32))) return 0;
    size_t bytes = (size_t)window->width * window->height * 4;
    if (bitmap) {
        uintptr_t targetAddress = (uintptr_t)window->pixels, sourceAddress = (uintptr_t)bitmap->bitmap;
        size_t sourceBytes = (size_t)bitmap->width * bitmap->height * 4;
        if ((targetAddress <= sourceAddress && sourceAddress - targetAddress < bytes) ||
            (sourceAddress <= targetAddress && targetAddress - sourceAddress < sourceBytes)) return 0;
    }
    memset(window->pixels, 0, bytes);
    if (bitmap) {
        uint32_t width = window->width < (uint32_t)bitmap->width ? window->width : (uint32_t)bitmap->width;
        uint32_t height = window->height < (uint32_t)bitmap->height ? window->height : (uint32_t)bitmap->height;
        for (uint32_t y = 0; y < height; y++) for (uint32_t x = 0; x < width; x++) {
            uint8_t *output = window->pixels + ((size_t)y * window->width + x) * 4;
            const uint8_t *input = bitmap->bitmap + ((size_t)y * bitmap->width + x) * 4;
            memcpy(output, input, 4);
            if (bitmap->format == MLBGI_COLOR32) output[3] = 255;
        }
    }
    window->backgroundEnabled = bitmapSlot != UINT32_MAX; return 1;
}
static int exportWindowBitmap(Engine_t *engine, uint32_t destination, uint32_t slot) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || !engine->renderer || destination >= RENDERER_MAX_BITMAPS || slot >= 16 || !state->windows[slot].allocated) return 0;
    const MLBGI_WindowObject *window = &state->windows[slot];
    if (!window->pixels || !window->width || !window->height || window->width > 8192 || window->height > 32768 ||
        (uint64_t)window->width * window->height > 8 * 1024 * 1024 ||
        !MLBGI_CreateBitmap(engine->renderer, destination, window->width, window->height, MLBGI_ALPHA32)) return 0;
    memcpy(engine->renderer->bitmaps[destination]->bitmap, window->pixels, (size_t)window->width * window->height * 4);
    return 1;
}
static int captureScene(Engine_t *engine, uint32_t slot, uint32_t maximumOrder) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || !engine->renderer || slot >= RENDERER_MAX_BITMAPS || maximumOrder >= 65536 || state->displaySlot >= 8) return 0;
    uint32_t width = state->displayWidths[state->displaySlot], height = state->displayHeights[state->displaySlot];
    if (!width || !height || width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024) return 0;
    Bitmap_t *bitmap = calloc(1, sizeof(*bitmap)); if (!bitmap) return 0;
    size_t bytes = (size_t)width * height * 4;
    bitmap->bitmap = malloc(bytes);
    if (!bitmap->bitmap || !MLBGI_DrawSceneThroughOrder(engine, maximumOrder, bitmap->bitmap, bytes, width, height, (size_t)width * 4)) {
        free(bitmap->bitmap); free(bitmap); return 0;
    }
    Bitmap_t *previous = engine->renderer->bitmaps[slot];
    size_t oldBytes = previous ? (size_t)previous->width * previous->height * 4 : 0;
    if (!MLBGI_AccountBitmap(engine, oldBytes, bytes)) { free(bitmap->bitmap); free(bitmap); return 0; }
    bitmap->width = (int)width; bitmap->height = (int)height; bitmap->format = MLBGI_COLOR32;
    engine->renderer->bitmaps[slot] = bitmap;
    if (previous) { free(previous->bitmap); free(previous); } return 1;
}
static int copyMenuImage(Engine_t *engine, uint32_t slot, MLBGI_MenuImage *output) {
    if (!engine || !engine->renderer || !output || slot >= RENDERER_MAX_BITMAPS) return -1;
    const Bitmap_t *bitmap = engine->renderer->bitmaps[slot];
    if (!bitmap) return 0;
    if (!bitmap->bitmap || bitmap->width <= 0 || bitmap->height <= 0 || bitmap->width > 8192 || bitmap->height > 8192 ||
        (uint64_t)bitmap->width * bitmap->height > 8 * 1024 * 1024 ||
        (bitmap->format != MLBGI_COLOR32 && bitmap->format != MLBGI_ALPHA32)) return -1;
    size_t bytes = (size_t)bitmap->width * bitmap->height * 4;
    uint8_t *pixels = malloc(bytes);
    if (!pixels) return -1;
    memcpy(pixels, bitmap->bitmap, bytes);
    if (bitmap->format == MLBGI_COLOR32) for (size_t i = 3; i < bytes; i += 4) pixels[i] = 255;
    *output = (MLBGI_MenuImage){(uint32_t)bitmap->width, (uint32_t)bitmap->height, bitmap->format, pixels};
    return 1;
}
int MLBGI_AttachBitmapLoader(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer) return 0;
    state->loadBitmap = load; state->bitmapInfo = info; state->cropBitmap = crop; state->freeBitmap = release;
    state->createBitmap = create; state->clearBitmap = clear; state->blitBitmap = blit;
    state->windowBitmap = windowBitmap;
    state->exportWindowBitmap = exportWindowBitmap;
    state->captureScene = captureScene;
    state->copyMenuImage = copyMenuImage;
    return MLBGI_AttachParticleResources(engine);
}
