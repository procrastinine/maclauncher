/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * Both image-protocol types own at most 32 matching frames, each with
 * a 32-level, 1/32-step scale pyramid. Emitter motion is separate. */
#include "particle-resources.h"
#include "bitmap-loader.h"
#include "vm-dialect.h"
#include <stdlib.h>
#include <string.h>
typedef struct { Bitmap_t *levels[32][32]; size_t bytes; uint32_t count, rates[2]; } Bank;
typedef struct {
    Bank banks[2][64];
    int32_t configurations[64][10], frameConfigurations[64][17];
    uint8_t configured[64], frameConfigured[64];
} Resources;
static void discard(Bank *bank) {
    for (unsigned level = 0; level < 32; level++) for (unsigned frame = 0; frame < 32; frame++) if (bank->levels[level][frame]) {
        free(bank->levels[level][frame]->bitmap); free(bank->levels[level][frame]);
    }
    memset(bank, 0, sizeof(*bank));
}
static void release(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    Resources *resources = state ? state->particleResources : NULL;
    if (!resources) return;
    for (unsigned type = 0; type < 2; type++) for (unsigned i = 0; i < 64; i++) {
        MLBGI_AccountBitmap(engine, resources->banks[type][i].bytes, 0);
        discard(&resources->banks[type][i]);
    }
    free(resources); state->particleResources = NULL;
}
static int registerFrames(Engine_t *engine, uint32_t type, uint32_t slot, uint32_t count, uint32_t firstBitmap,
                          uint32_t rateA, uint32_t rateB, uint32_t scale) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || !engine->renderer || type > 1 || slot >= 64 || state->imageProtocolRateMode > 2) return 0;
    Resources *resources = state->particleResources;
    /* Zero frames or the native missing-image sentinel releases a bank. */
    if (!count || firstBitmap == UINT32_MAX) {
        if (resources) {
            if (!MLBGI_AccountBitmap(engine, resources->banks[type][slot].bytes, 0)) return 0;
            discard(&resources->banks[type][slot]);
        }
        return 1;
    }
    if (count > 32 || firstBitmap >= RENDERER_MAX_BITMAPS || count > RENDERER_MAX_BITMAPS - firstBitmap) return 0;
    const Bitmap_t *first = engine->renderer->bitmaps[firstBitmap];
    if (!first || (first->format != 1 && first->format != 2) || !first->bitmap || first->width < 1 || first->height < 1) return 0;
    for (uint32_t frame = 0; frame < count; frame++) {
        const Bitmap_t *source = engine->renderer->bitmaps[firstBitmap + frame];
        if (!source || !source->bitmap || source->width != first->width || source->height != first->height || source->format != first->format) return 0;
    }
    uint32_t fixedScale = scale << 16, rates[2] = { rateA ? fixedScale / rateA : 0, 0 };
    if (!state->imageProtocolRateMode) rates[1] = rateB ? fixedScale / rateB : 0;
    else if (state->imageProtocolRateMode == 1) {
        if (rateA && rateB) {
            uint32_t denominator = rateA + rateB;
            if (!denominator) return 0;
            rates[1] = fixedScale / denominator - rates[0];
        }
    } else if (rateA) rates[1] = (uint32_t)((uint64_t)rates[0] * rateB / rateA);
    if (!resources) {
        resources = calloc(1, sizeof(*resources));
        if (!resources) return 0;
    }
    Bank candidate = {0}; candidate.count = count;
    memcpy(candidate.rates, rates, sizeof(rates));
    for (unsigned level = 0; level < 32; level++) {
        uint32_t scale = 32 - level;
        uint32_t width = (uint32_t)((uint64_t)(uint32_t)first->width * scale / 32);
        uint32_t height = (uint32_t)((uint64_t)(uint32_t)first->height * scale / 32);
        if (!width || !height) continue;
        for (uint32_t frame = 0; frame < count; frame++) {
        const Bitmap_t *source = engine->renderer->bitmaps[firstBitmap + frame];
        size_t bytes = (size_t)width * height * 4;
        if (bytes > 32 * 1024 * 1024 - candidate.bytes) goto fail;
        Bitmap_t *image = calloc(1, sizeof(*image));
        if (!image) goto fail;
        candidate.levels[level][frame] = image;
        image->bitmap = malloc(bytes);
        if (!image->bitmap) goto fail;
        image->width = (int)width; image->height = (int)height; image->format = source->format;
        candidate.bytes += bytes;
        /* Finite integer bilinear sampling. The full-scale level is an
           exact copy; smaller levels sample the authored source image. */
        for (uint32_t y = 0; y < height; y++) for (uint32_t x = 0; x < width; x++) {
            uint64_t fixedX = (uint64_t)x * source->width * 65536 / width;
            uint64_t fixedY = (uint64_t)y * source->height * 65536 / height;
            uint32_t left = (uint32_t)(fixedX >> 16), top = (uint32_t)(fixedY >> 16);
            uint32_t right = left + 1 < (uint32_t)source->width ? left + 1 : left;
            uint32_t bottom = top + 1 < (uint32_t)source->height ? top + 1 : top;
            uint32_t dx = (uint32_t)fixedX & 65535, dy = (uint32_t)fixedY & 65535;
            uint8_t *pixel = image->bitmap + ((size_t)y * width + x) * 4;
            for (unsigned channel = 0; channel < 4; channel++) {
                uint32_t a = source->bitmap[((size_t)top * source->width + left) * 4 + channel];
                uint32_t b = source->bitmap[((size_t)top * source->width + right) * 4 + channel];
                uint32_t c = source->bitmap[((size_t)bottom * source->width + left) * 4 + channel];
                uint32_t d = source->bitmap[((size_t)bottom * source->width + right) * 4 + channel];
                uint64_t upper = (uint64_t)a * (65536 - dx) + (uint64_t)b * dx;
                uint64_t lower = (uint64_t)c * (65536 - dx) + (uint64_t)d * dx;
                pixel[channel] = (uint8_t)((upper * (65536 - dy) + lower * dy) >> 32);
            }
            if (image->format == MLBGI_COLOR32) pixel[3] = 255;
        }
        }
    }
    if (!MLBGI_AccountBitmap(engine, resources->banks[type][slot].bytes, candidate.bytes)) goto fail;
    discard(&resources->banks[type][slot]); resources->banks[type][slot] = candidate;
    state->particleResources = resources; return 1;
fail:
    discard(&candidate);
    if (!state->particleResources) free(resources);
    return 0;
}
static int registerImage(Engine_t *engine, uint32_t slot, uint32_t bitmapSlot) {
    return registerFrames(engine, 0, slot, 1, bitmapSlot, 0, 0, 0);
}
const Bitmap_t *MLBGI_ImageProtocolResource(const Engine_t *engine, uint32_t type, uint32_t slot, uint32_t frame, uint32_t level) {
    const MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    const Resources *resources = state ? state->particleResources : NULL;
    return resources && type < 2 && slot < 64 && level < 32 && frame < resources->banks[type][slot].count ?
        resources->banks[type][slot].levels[level][frame] : NULL;
}
int MLBGI_ImageProtocolInfo(const Engine_t *engine, uint32_t type, uint32_t slot, uint32_t output[3]) {
    const MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    const Resources *resources = state ? state->particleResources : NULL;
    if (!resources || type > 1 || slot >= 64 || !output || !resources->banks[type][slot].count) return 0;
    const Bank *bank = &resources->banks[type][slot];
    output[0] = bank->count; output[1] = bank->rates[0]; output[2] = bank->rates[1]; return 1;
}
const Bitmap_t *MLBGI_ParticleResource(const Engine_t *engine, uint32_t slot, uint32_t level) {
    return MLBGI_ImageProtocolResource(engine, 0, slot, 0, level);
}
static int32_t fixedPoint(uint32_t bits, int absolute) {
    if (absolute && (int32_t)bits < 0) bits = 0u - bits;
    /* Arithmetic right shift includes the original INT32_MIN wrap. */
    return (int32_t)((bits >> 8) | (bits & 0x80000000 ? 0xff000000 : 0));
}
static int configure(Engine_t *engine, uint32_t slot, const uint32_t values[10]) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || slot >= 64 || !values) return 0;
    Resources *resources = state->particleResources;
    if (!resources) {
        resources = calloc(1, sizeof(*resources));
        if (!resources) return 0;
    }
    for (unsigned i = 0; i < 10; i++) resources->configurations[slot][i] = fixedPoint(values[i], !(i & 1));
    resources->configured[slot] = 1; state->particleResources = resources; return 1;
}
const int32_t *MLBGI_ParticleConfiguration(const Engine_t *engine, uint32_t slot) {
    const MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    const Resources *resources = state ? state->particleResources : NULL;
    return resources && slot < 64 && resources->configured[slot] ? resources->configurations[slot] : NULL;
}
static int configureFrames(Engine_t *engine, uint32_t slot, const uint32_t values[17]) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || slot >= 64 || !values) return 0;
    Resources *resources = state->particleResources;
    if (!resources) {
        resources = calloc(1, sizeof(*resources));
        if (!resources) return 0;
    }
    int32_t *output = resources->frameConfigurations[slot];
    for (unsigned i = 0; i < 17; i++) output[i] = (int32_t)values[i];
    for (unsigned i = 2; i <= 10; i++) output[i] = fixedPoint(values[i], !(i & 1));
    output[13] = fixedPoint(values[13], 0);
    if (!output[14]) output[14] = 1;
    if (!output[15]) output[15] = 1;
    resources->frameConfigured[slot] = 1; state->particleResources = resources; return 1;
}
const int32_t *MLBGI_ImageProtocolConfiguration(const Engine_t *engine, uint32_t slot) {
    const MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    const Resources *resources = state ? state->particleResources : NULL;
    return resources && slot < 64 && resources->frameConfigured[slot] ? resources->frameConfigurations[slot] : NULL;
}
int MLBGI_DrawParticleResource(const Engine_t *engine, uint32_t slot, uint32_t level, uint8_t *rgba,
                              uint32_t width, uint32_t height, size_t bytes, int32_t x, int32_t y) {
    const Bitmap_t *image = MLBGI_ParticleResource(engine, slot, level);
    if (!image || !rgba || !width || !height || width > 8192 || height > 8192 ||
        (uint64_t)width * height > 8 * 1024 * 1024 || bytes != (size_t)width * height * 4) return 0;
    for (uint32_t row = 0; row < (uint32_t)image->height; row++) {
        int64_t targetY = (int64_t)y + row;
        if (targetY < 0 || targetY >= height) continue;
        for (uint32_t column = 0; column < (uint32_t)image->width; column++) {
            int64_t targetX = (int64_t)x + column;
            if (targetX < 0 || targetX >= width) continue;
            memcpy(rgba + ((size_t)targetY * width + (size_t)targetX) * 4,
                   image->bitmap + ((size_t)row * image->width + column) * 4, 4);
        }
    }
    return 1;
}
int MLBGI_AttachParticleResources(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer) return 0;
    state->registerParticleImage = registerImage; state->configureParticle = configure;
    state->configureImageProtocol = configureFrames;
    state->registerImageProtocol = registerFrames;
    state->freeParticleResources = release; return 1;
}
