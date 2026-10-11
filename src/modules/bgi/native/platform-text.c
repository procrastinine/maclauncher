/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "platform-text.h"
#include "vm-dialect.h"
#include "vm-strings.h"
#include "bitmap-loader.h"
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreText/CoreText.h>
#include <iconv.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static CFStringRef cp932(const char *text, size_t bound, uint32_t *characters) {
    if (!text) return NULL;
    size_t bytes = strnlen(text, bound);
    if (bytes >= bound) return NULL;
    uint32_t count = 0;
    for (size_t i = 0; i < bytes; i++, count++) {
        unsigned char c = (unsigned char)text[i];
        if (c < 32 || c == 127) return NULL;
        if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) {
            if (++i == bytes) return NULL;
            c = (unsigned char)text[i];
            if (c < 0x40 || c == 0x7f || c > 0xfc) return NULL;
        }
    }
    char *utf8 = malloc(bytes * 4 + 1);
    if (!utf8) return NULL;
    iconv_t converter = iconv_open("UTF-8", "CP932");
    if (converter == (iconv_t)-1) { free(utf8); return NULL; }
    char *source = (char *)text, *output = utf8;
    size_t sourceBytes = bytes, remaining = bytes * 4;
    size_t converted = iconv(converter, &source, &sourceBytes, &output, &remaining);
    iconv_close(converter);
    CFStringRef string = converted == (size_t)-1 || sourceBytes ? NULL :
        CFStringCreateWithBytes(kCFAllocatorDefault, (const UInt8 *)utf8, output - utf8, kCFStringEncodingUTF8, false);
    free(utf8);
    if (string && characters) *characters = count;
    return string;
}

/* A rectangular outline is the maximum coverage in the native effect's
   horizontal and vertical radii. Sliding deques keep large radii linear in
   image size instead of scanning every neighbor of every pixel. */
static void maximumLine(const uint8_t *source, uint8_t *output, size_t length, size_t step, unsigned radius, uint32_t *queue) {
    size_t head = 0, tail = 0, next = 0;
    for (size_t i = 0; i < length; i++) {
        size_t end = i + radius < length ? i + radius : length - 1;
        while (next <= end) {
            while (tail > head && source[(size_t)queue[tail - 1] * step] <= source[next * step]) tail--;
            queue[tail++] = (uint32_t)next++;
        }
        size_t begin = i > radius ? i - radius : 0;
        while (head < tail && queue[head] < begin) head++;
        output[i * step] = source[(size_t)queue[head] * step];
    }
}
static int effectOutline(const uint8_t *source, uint8_t *output, uint32_t width, uint32_t height, unsigned rx, unsigned ry) {
    uint8_t *horizontal = malloc((size_t)width * height);
    uint32_t *queue = malloc((size_t)(width > height ? width : height) * sizeof(*queue));
    if (!horizontal || !queue) { free(horizontal); free(queue); return 0; }
    for (uint32_t y = 0; y < height; y++) maximumLine(source + (size_t)y * width, horizontal + (size_t)y * width, width, 1, rx, queue);
    for (uint32_t x = 0; x < width; x++) maximumLine(horizontal + x, output + x, height, width, ry, queue);
    free(horizontal); free(queue); return 1;
}

static void paint(uint8_t *target, const uint8_t *mask, size_t count, uint32_t format, uint32_t color, unsigned transparency) {
    unsigned rgb[3] = { (color >> 16) & 255, (color >> 8) & 255, color & 255 };
    for (size_t i = 0; i < count; i++) {
        unsigned alpha = mask[i] * (256 - transparency) >> 8;
        if (!alpha) continue;
        uint8_t *pixel = target + i * 4;
        if (alpha == 255) { for (unsigned c = 0; c < 3; c++) pixel[c] = (uint8_t)rgb[c]; pixel[3] = 255; continue; }
        if (format == MLBGI_COLOR32) {
            unsigned weight = alpha >= 254 ? 128 : alpha >> 1;
            for (unsigned c = 0; c < 3; c++) pixel[c] = (uint8_t)((rgb[c] * weight + pixel[c] * (128 - weight)) >> 7);
            pixel[3] = 255;
        } else {
            unsigned source = alpha * 256, previous = pixel[3] * (65536 - source) >> 8, coverage = source + previous;
            unsigned first = (source << 8) / coverage, second = (previous << 8) / coverage;
            for (unsigned c = 0; c < 3; c++) pixel[c] = (uint8_t)((rgb[c] * first + pixel[c] * second) >> 8);
            pixel[3] = (uint8_t)(coverage >> 8);
        }
    }
}

int MLBGI_RenderBitmapText(Engine_t *engine, const MLBGI_BitmapText *request, uint32_t *characters) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer || !request || !characters ||
        request->bitmap >= RENDERER_MAX_BITMAPS || request->height < 4 || request->height > 200 ||
        request->widthPercent < 25 || request->widthPercent > 200 || request->effectType > 2 ||
        request->effectWidthPercent > 100 || request->effectHeightPercent > 100 || request->effectOpacity > 256) return 0;
    /* Registered text substitutions have layout and glyph-index effects.
       Until that consumer is implemented, never paint their source text as
       if it were the original native replacement. Unaffected text is valid. */
    if (MLBGI_TextRulesAffect(engine, request->text)) return 0;
    Bitmap_t *bitmap = engine->renderer->bitmaps[request->bitmap];
    if (!bitmap || !bitmap->bitmap || bitmap->width <= 0 || bitmap->height <= 0 || bitmap->width > 8192 || bitmap->height > 32768 ||
        (uint64_t)bitmap->width * bitmap->height > 8 * 1024 * 1024 ||
        (bitmap->format != MLBGI_COLOR32 && bitmap->format != MLBGI_ALPHA32)) return 0;
    CFStringRef string = NULL, family = NULL;
    CTFontRef font = NULL;
    CFNumberRef zero = NULL;
    CFDictionaryRef attributes = NULL;
    CFAttributedStringRef attributed = NULL;
    CTLineRef line = NULL;
    CGColorSpaceRef gray = NULL;
    CGContextRef context = NULL;
    uint8_t *mask = NULL, *effect = NULL, *temporary = NULL;
    int okay = 0;
    uint32_t count = 0;
    size_t pixels = (size_t)bitmap->width * bitmap->height;
    string = cp932(request->text, 4096, &count); family = cp932(request->family, 1024, NULL);
    if (!string || !family || !CFStringGetLength(family)) goto cleanup;
    if (!count) { *characters = 0; okay = 1; goto cleanup; }
    font = CTFontCreateWithName(family, request->height, NULL);
    if (!font) goto cleanup;
    if (request->style) {
        CTFontRef bold = CTFontCreateCopyWithSymbolicTraits(font, request->height, NULL, kCTFontBoldTrait, kCTFontBoldTrait);
        if (!bold) goto cleanup;
        CFRelease(font); font = bold;
    }
    int noLigatures = 0;
    zero = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &noLigatures);
    const void *keys[] = { kCTFontAttributeName, kCTLigatureAttributeName };
    const void *values[] = { font, zero };
    if (!zero) goto cleanup;
    attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!attributes) goto cleanup;
    attributed = CFAttributedStringCreate(kCFAllocatorDefault, string, attributes);
    if (!attributed) goto cleanup;
    line = CTLineCreateWithAttributedString(attributed);
    if (!line) goto cleanup;
    CGFloat ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font);
    if (!isfinite(ascent) || !isfinite(descent) || ascent <= 0 || descent < 0 || ascent + descent <= 0) goto cleanup;
    CGFloat sy = request->height / (ascent + descent), sx = sy * request->widthPercent / 100;
    mask = calloc(1, pixels); temporary = malloc(pixels * 4);
    if (!mask || !temporary) goto cleanup;
    gray = CGColorSpaceCreateDeviceGray();
    if (!gray) goto cleanup;
    context = CGBitmapContextCreate(mask, bitmap->width, bitmap->height, 8, bitmap->width, gray, kCGImageAlphaNone);
    if (!context) goto cleanup;
    CGContextTranslateCTM(context, 0, bitmap->height); CGContextScaleCTM(context, 1, -1);
    CGContextSetShouldAntialias(context, state->antialiasLevel != 0);
    CGContextSetGrayFillColor(context, 1, 1);
    CFArrayRef runs = CTLineGetGlyphRuns(line);
    for (CFIndex i = 0; i < CFArrayGetCount(runs); i++) {
        CTRunRef run = CFArrayGetValueAtIndex(runs, i);
        CFIndex glyphCount = CTRunGetGlyphCount(run);
        if (glyphCount < 0 || glyphCount > 4095) goto cleanup;
        CTFontRef runFont = CFDictionaryGetValue(CTRunGetAttributes(run), kCTFontAttributeName);
        if (!runFont) goto cleanup;
        CGGlyph glyphs[4096]; CGPoint positions[4096]; CFIndex indices[4096];
        CTRunGetGlyphs(run, CFRangeMake(0, glyphCount), glyphs);
        CTRunGetPositions(run, CFRangeMake(0, glyphCount), positions);
        CTRunGetStringIndices(run, CFRangeMake(0, glyphCount), indices);
        for (CFIndex j = 0; j < glyphCount; j++) {
            CGPathRef path = CTFontCreatePathForGlyph(runFont, glyphs[j], NULL);
            if (!path) {
                if (indices[j] < 0 || indices[j] >= CFStringGetLength(string)) goto cleanup;
                UniChar character = CFStringGetCharacterAtIndex(string, indices[j]);
                if (character != ' ' && character != 0x3000) goto cleanup;
                continue; /* Space has an advance and no outline. */
            }
            CGAffineTransform transform = CGAffineTransformMake(sx, 0, 0, -sy,
                request->x + positions[j].x * sx, request->y + ascent * sy - positions[j].y * sy);
            CGPathRef placed = CGPathCreateCopyByTransformingPath(path, &transform);
            CFRelease(path);
            if (!placed) goto cleanup;
            CGContextAddPath(context, placed); CGContextFillPath(context); CFRelease(placed);
        }
    }
    CGContextFlush(context);
    memcpy(temporary, bitmap->bitmap, pixels * 4);
    if (request->effectType && request->effectOpacity) {
        effect = calloc(1, pixels);
        if (!effect) goto cleanup;
        unsigned rx = request->height * request->effectWidthPercent / 100,
            ry = request->height * request->effectHeightPercent / 100;
        if (!rx) rx = 1;
        if (!ry) ry = 1;
        if (request->effectType == 2) {
            if (!effectOutline(mask, effect, bitmap->width, bitmap->height, rx, ry)) goto cleanup;
        } else {
            for (uint32_t y = ry; y < (uint32_t)bitmap->height; y++) for (uint32_t x = rx; x < (uint32_t)bitmap->width; x++)
                effect[(size_t)y * bitmap->width + x] = mask[(size_t)(y - ry) * bitmap->width + x - rx];
        }
        paint(temporary, effect, pixels, bitmap->format, request->effectColor, 256 - request->effectOpacity);
    }
    paint(temporary, mask, pixels, bitmap->format, request->color, 0);
    memcpy(bitmap->bitmap, temporary, pixels * 4); *characters = count; okay = 1;
cleanup:
    if (context) CGContextRelease(context);
    if (gray) CGColorSpaceRelease(gray);
    if (line) CFRelease(line);
    if (attributed) CFRelease(attributed);
    if (attributes) CFRelease(attributes);
    if (zero) CFRelease(zero);
    if (font) CFRelease(font);
    if (family) CFRelease(family);
    if (string) CFRelease(string);
    free(mask); free(effect); free(temporary); return okay;
}
int MLBGI_AttachTextRenderer(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->renderer) return 0;
    state->drawBitmapText = MLBGI_RenderBitmapText; return 1;
}
