/* SPDX-License-Identifier: MIT
 * Bounded C port of GARbro's CompressedBG v2 decoder.
 * Reference: morkt/GARbro b09ee4570ccb1daf6ac56710ee8934dc0b8baeb0
 * ArcFormats/Ethornell/ImageCBG.cs and BgiDecoderBase in ArcBGI.cs.
 * The image codec has no VM, file, launcher or display dependencies. */
// Copyright (C) 2015-2018 by morkt
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//


#include "cbg-bitmap.h"
#include <stdlib.h>
#include <string.h>
#pragma STDC FP_CONTRACT OFF

typedef struct { const uint8_t *data; size_t size, position; } Bytes;
typedef struct { const uint8_t *data; size_t size, bit; } Bits;
typedef struct { uint32_t weight; int children[2]; int valid, parent; } Node;
typedef struct { Node nodes[513]; unsigned count; } Tree;
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint32_t le16(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8); }
static int integer(Bytes *input, uint32_t *value) {
    uint32_t result = 0;
    for (unsigned shift = 0; shift < 35; shift += 7) {
        if (input->position >= input->size) return 0;
        uint32_t code = input->data[input->position++];
        if (shift == 28 && (code & 0xf0)) return 0;
        result |= (code & 0x7f) << shift;
        if (!(code & 0x80)) { *value = result; return 1; }
    }
    return 0;
}
static int bits(Bits *input, unsigned count, uint32_t *value) {
    if (count > 24 || input->bit > input->size * 8 || count > input->size * 8 - input->bit) return 0;
    uint32_t result = 0;
    for (unsigned i = 0; i < count; i++, input->bit++) result = (result << 1) | ((input->data[input->bit >> 3] >> (7 - (input->bit & 7))) & 1);
    *value = result; return 1;
}
static int createTree(Bytes *input, unsigned leaves, Tree *tree) {
    memset(tree, 0, sizeof(*tree)); tree->count = leaves;
    uint64_t sum = 0;
    for (unsigned i = 0; i < leaves; i++) {
        uint32_t weight;
        if (!integer(input, &weight)) return 0;
        tree->nodes[i] = (Node){weight, {-1,-1}, weight != 0, 0}; sum += weight;
    }
    if (!sum || sum > UINT32_MAX) return 0;
    for (;;) {
        if (tree->count >= sizeof(tree->nodes) / sizeof(tree->nodes[0])) return 0;
        Node parent = {0, {-1,-1}, 1, 1};
        for (unsigned child = 0; child < 2; child++) {
            unsigned n = 0; int selected = -1; uint32_t minimum = UINT32_MAX;
            for (; n < tree->count; n++) if (tree->nodes[n].valid) { selected = (int)n; minimum = tree->nodes[n++].weight; break; }
            /* v2's native tie ordering starts this second scan at at least
               child+1, rather than resampling every earlier node. */
            if (n < child + 1) n = child + 1;
            for (; n < tree->count; n++) if (tree->nodes[n].valid && tree->nodes[n].weight < minimum) { selected = (int)n; minimum = tree->nodes[n].weight; }
            if (selected >= 0) {
                tree->nodes[selected].valid = 0; parent.children[child] = selected;
                if (parent.weight > UINT32_MAX - tree->nodes[selected].weight) return 0;
                parent.weight += tree->nodes[selected].weight;
            }
        }
        if (parent.children[0] < 0) return 0;
        tree->nodes[tree->count++] = parent;
        if (parent.weight >= sum) return 1;
    }
}
static int token(const Tree *tree, Bits *input, uint32_t *value) {
    int index = (int)tree->count - 1;
    for (unsigned steps = 0; steps < tree->count; steps++) {
        if (index < 0 || (unsigned)index >= tree->count) return 0;
        const Node *node = &tree->nodes[index];
        if (!node->parent) { *value = (uint32_t)index; return 1; }
        uint32_t bit; if (!bits(input, 1, &bit)) return 0;
        index = node->children[bit];
    }
    return 0;
}
static int signedValue(Bits *input, unsigned count, int32_t *value) {
    uint32_t raw;
    if (!bits(input, count, &raw)) return 0;
    *value = count && raw < (1u << (count - 1)) ? (int32_t)raw - (int32_t)((1u << count) - 1) : (int32_t)raw;
    return 1;
}
static int16_t floatToSample(float value) {
    /* The original conversion truncates before the arithmetic shift and
       resets samples above 383. Preserve that codec behavior explicitly. */
    if (value >= 2147483648.0f || value <= -2147483648.0f) return 0;
    int64_t truncated = (int32_t)value;
    int64_t sample = 128 + (truncated < 0 ? -((-truncated + 7) / 8) : truncated / 8);
    return sample <= 0 ? 0 : sample <= 255 ? (int16_t)sample : sample < 384 ? 255 : 0;
}
static uint8_t floatToByte(float value) { return value >= 255 ? 255 : value <= 0 ? 0 : (uint8_t)value; }

static const float dctScale[64] = {
            1.00000000f, 1.38703990f, 1.30656302f, 1.17587554f, 1.00000000f, 0.78569496f, 0.54119611f, 0.27589938f,
            1.38703990f, 1.92387950f, 1.81225491f, 1.63098633f, 1.38703990f, 1.08979023f, 0.75066054f, 0.38268343f,
            1.30656302f, 1.81225491f, 1.70710683f, 1.53635550f, 1.30656302f, 1.02655995f, 0.70710677f, 0.36047992f,
            1.17587554f, 1.63098633f, 1.53635550f, 1.38268340f, 1.17587554f, 0.92387950f, 0.63637930f, 0.32442334f,
            1.00000000f, 1.38703990f, 1.30656302f, 1.17587554f, 1.00000000f, 0.78569496f, 0.54119611f, 0.27589938f,
            0.78569496f, 1.08979023f, 1.02655995f, 0.92387950f, 0.78569496f, 0.61731654f, 0.42521504f, 0.21677275f,
            0.54119611f, 0.75066054f, 0.70710677f, 0.63637930f, 0.54119611f, 0.42521504f, 0.29289323f, 0.14931567f,
            0.27589938f, 0.38268343f, 0.36047992f, 0.32442334f, 0.27589938f, 0.21677275f, 0.14931567f, 0.07612047f,
        };

static void decodeDct(unsigned channel, const int16_t *data, const float quant[2][64], int16_t colors[64][3])
        {
            float v1, v2, v3, v4, v5, v6, v7, v8;
            float v9, v10, v11, v12, v13, v14, v15, v16, v17;
            int d = channel > 0 ? 1 : 0;
            float tmp[8][8];

            for (int i = 0; i < 8; ++i)
            {
                if (0 == data[8 + i] && 0 == data[16 + i] && 0 == data[24 + i]
                    && 0 == data[32 + i] && 0 == data[40 + i] && 0 == data[48 + i]
                    && 0 == data[56 + i])
                {
                    float t = data[i] * quant[d][i];
                    tmp[0][i] = t;
                    tmp[1][i] = t;
                    tmp[2][i] = t;
                    tmp[3][i] = t;
                    tmp[4][i] = t;
                    tmp[5][i] = t;
                    tmp[6][i] = t;
                    tmp[7][i] = t;
                    continue;
                }

                v1 = data[i] * quant[d][i];
                v2 = data[8 + i]  * quant[d][8 + i];
                v3 = data[16 + i] * quant[d][16 + i];
                v4 = data[24 + i] * quant[d][24 + i];
                v5 = data[32 + i] * quant[d][32 + i];
                v6 = data[40 + i] * quant[d][40 + i];
                v7 = data[48 + i] * quant[d][48 + i];
                v8 = data[56 + i] * quant[d][56 + i];

                v10 = v1 + v5;
                v11 = v1 - v5;
                v12 = v3 + v7;
                v13 = (v3 - v7) * 1.414213562f - v12;
                v1 = v10 + v12;
                v7 = v10 - v12;
                v3 = v11 + v13;
                v5 = v11 - v13;
                v14 = v2 + v8;
                v15 = v2 - v8;
                v16 = v6 + v4;
                v17 = v6 - v4;
                v8 = v14 + v16;
                v11 = (v14 - v16) * 1.414213562f;
                v9 = (v17 + v15) * 1.847759065f;
                v10 =  1.082392200f * v15 - v9;
                v13 = -2.613125930f * v17 + v9;
                v6 = v13 - v8;
                v4 = v11 - v6;
                v2 = v10 + v4;

                tmp[0][i] = v1 + v8;
                tmp[1][i] = v3 + v6;
                tmp[2][i] = v5 + v4;
                tmp[3][i] = v7 - v2;
                tmp[4][i] = v7 + v2;
                tmp[5][i] = v5 - v4;
                tmp[6][i] = v3 - v6;
                tmp[7][i] = v1 - v8;
            }
            int dst = 0;
            for (int i = 0; i < 8; ++i)
            {
                v10 = tmp[i][0] + tmp[i][4];
                v11 = tmp[i][0] - tmp[i][4];
                v12 = tmp[i][2] + tmp[i][6];
                v13 = tmp[i][2] - tmp[i][6];
                v14 = tmp[i][1] + tmp[i][7];
                v15 = tmp[i][1] - tmp[i][7];
                v16 = tmp[i][5] + tmp[i][3];
                v17 = tmp[i][5] - tmp[i][3];

                v13 = 1.414213562f * v13 - v12;
                v1 = v10 + v12;
                v7 = v10 - v12;
                v3 = v11 + v13;
                v5 = v11 - v13;
                v8 = v14 + v16;
                v11 = (v14 - v16) * 1.414213562f;
                v9 = (v17 + v15) * 1.847759065f;
                v10 = v9 - v15 * 1.082392200f;
                v13 = v9 - v17 * 2.613125930f;
                v6 = v13 - v8;
                v4 = v11 - v6;
                v2 = v10 - v4;

                colors[dst++][channel] = floatToSample (v1 + v8);
                colors[dst++][channel] = floatToSample (v3 + v6);
                colors[dst++][channel] = floatToSample (v5 + v4);
                colors[dst++][channel] = floatToSample (v7 + v2);
                colors[dst++][channel] = floatToSample (v7 - v2);
                colors[dst++][channel] = floatToSample (v5 - v4);
                colors[dst++][channel] = floatToSample (v3 - v6);
                colors[dst++][channel] = floatToSample (v1 - v8);
            }
        }



static const uint8_t zigzag[64] = {
    0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,
    12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
    35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
    58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63
};
static int decodeStrip(const uint8_t *data, size_t size, const Tree *dc, const Tree *ac,
                       uint32_t width, uint32_t bpp, const float quant[2][64], uint8_t *rgba) {
    Bytes input = {data, size, 0}; uint32_t count;
    unsigned channels = bpp == 8 ? 1 : 3;
    if (!integer(&input, &count) || count != width * 8u * channels) return 0;
    int16_t *coefficients = calloc(count, sizeof(*coefficients));
    if (!coefficients) return 0;
    Bits reader = {data, size, input.position * 8}; uint32_t accumulator = 0; int okay = 1;
    for (uint32_t i = 0; okay && i < count; i += 64) {
        uint32_t category; int32_t delta;
        okay = token(dc, &reader, &category) && category <= 15 && signedValue(&reader, category, &delta);
        if (okay) { accumulator += (uint32_t)delta; uint32_t low = accumulator & 0xffff; coefficients[i] = (int16_t)(low < 32768 ? (int32_t)low : (int32_t)low - 65536); }
    }
    reader.bit = (reader.bit + 7) & ~(size_t)7;
    for (uint32_t i = 0; okay && i < count; i += 64) {
        unsigned index = 1;
        while (okay && index < 64) {
            uint32_t code;
            if (!(okay = token(ac, &reader, &code)) || !code) break;
            if (code == 15) { index += 16; if (index > 64) okay = 0; continue; }
            index += code & 15;
            unsigned category = code >> 4; int32_t value;
            if (index >= 64 || !category || category > 10 || !signedValue(&reader, category, &value)) { okay = 0; break; }
            coefficients[i + zigzag[index++]] = (int16_t)value;
        }
    }
    for (unsigned block = 0; okay && block < width / 8; block++) {
        int16_t colors[64][3] = {{0}};
        for (unsigned channel = 0; channel < channels; channel++) decodeDct(channel, coefficients + block * 64 + channel * width * 8, quant, colors);
        for (unsigned pixel = 0; pixel < 64; pixel++) {
            size_t at = (((size_t)(pixel >> 3) * width) + block * 8 + (pixel & 7)) * 4;
            if (bpp == 8) rgba[at] = rgba[at + 1] = rgba[at + 2] = (uint8_t)colors[pixel][0];
            else {
                float y = colors[pixel][0], cb = colors[pixel][1], cr = colors[pixel][2];
                rgba[at] = floatToByte(y + 1.402f * cr - 178.956f);
                rgba[at + 1] = floatToByte(y - 0.34414f * cb - 0.71414f * cr + 135.95984f);
                rgba[at + 2] = floatToByte(y + 1.772f * cb - 226.316f);
            }
            rgba[at + 3] = 255;
        }
    }
    free(coefficients); return okay;
}
static int decodeAlpha(const uint8_t *data, size_t size, uint32_t width, size_t pixels, uint8_t *rgba, int *hasAlpha) {
    if (size < 4) return 0;
    uint32_t kind = le32(data); *hasAlpha = 0;
    if (!kind) return 1;
    if (kind != 1) return 0;
    size_t position = 4, dst = 0; uint32_t control = 2;
    while (dst < pixels) {
        control >>= 1;
        if (control == 1) { if (position >= size) return 0; control = data[position++] | 0x100u; }
        if (control & 1) {
            if (size - position < 2) return 0;
            uint32_t value = le16(data + position); position += 2;
            int x = value & 63, y = (value >> 6) & 7;
            if (x > 31) x -= 64;
            if (y) y -= 8;
            unsigned count = (value >> 9) + 3;
            int64_t source = (int64_t)dst + x + (int64_t)y * width;
            if (source < 0 || source >= (int64_t)dst || count > pixels - dst) return 0;
            for (unsigned i = 0; i < count; i++, dst++, source++) rgba[dst * 4 + 3] = rgba[(size_t)source * 4 + 3];
        } else {
            if (position >= size) return 0;
            rgba[dst++ * 4 + 3] = data[position++];
        }
    }
    *hasAlpha = 1; return 1;
}
int MLBGI_DecodeCbgV2(const uint8_t *data, size_t size, MLBGI_CbgBitmap *output) {
    if (!data || !output || output->rgba || size < 48 || size > 32u * 1024 * 1024 || memcmp(data, "CompressedBG___", 16) || le16(data + 46) != 2) return 0;
    uint32_t width = le16(data + 16), height = le16(data + 18), bpp = le32(data + 20), encodedSize = le32(data + 40);
    uint32_t paddedWidth = (width + 7) & ~7u, paddedHeight = (height + 7) & ~7u;
    if (!width || !height || paddedWidth > 8192 || paddedHeight > 8192 ||
        (uint64_t)paddedWidth * paddedHeight > 8 * 1024 * 1024 || (bpp != 8 && bpp != 24 && bpp != 32) ||
        encodedSize < 128 || encodedSize > 1024 * 1024 || encodedSize > size - 48) return 0;
    uint32_t key = le32(data + 36); uint8_t sum = 0, xor = 0; float quant[2][64];
    for (uint32_t i = 0; i < encodedSize; i++) {
        uint32_t low = 20021u * (key & 65535), high = ((key >> 16) * 20021u + key * 346u + (low >> 16)) & 65535;
        key = (high << 16) + (low & 65535) + 1;
        uint8_t value = (uint8_t)(data[48 + i] - (uint8_t)high); sum += value; xor ^= value;
        if (i < 128) quant[i >> 6][i & 63] = value * dctScale[i & 63];
    }
    if (sum != data[44] || xor != data[45]) return 0;
    size_t base = 48 + encodedSize; Bytes input = {data, size, base}; Tree dc, ac;
    if (!createTree(&input, 16, &dc) || !createTree(&input, 176, &ac)) return 0;
    unsigned rows = paddedHeight / 8, offsetCount = rows + 1; size_t tableBytes = (size_t)offsetCount * 4;
    if (tableBytes > size - input.position) return 0;
    size_t endTable = input.position + tableBytes; size_t offsets[1025];
    for (unsigned i = 0; i < offsetCount; i++) {
        uint32_t raw = le32(data + input.position + i * 4);
        if (i == rows && bpp != 32 && raw == UINT32_MAX) offsets[i] = size;
        else {
            if (raw > size - base || raw < endTable - base) return 0;
            offsets[i] = base + raw;
        }
        if (i && offsets[i] < offsets[i - 1]) return 0;
    }
    size_t pixels = (size_t)paddedWidth * paddedHeight;
    uint8_t *rgba = malloc(pixels * 4);
    if (!rgba) return 0;
    unsigned padding = ((paddedWidth >> 3) + 7) >> 3; int okay = 1, hasAlpha = 0;
    for (unsigned i = 0; okay && i < rows; i++) {
        size_t count = offsets[i + 1] - offsets[i];
        if (count < padding) okay = 0;
        else okay = decodeStrip(data + offsets[i] + padding, count - padding, &dc, &ac, paddedWidth, bpp, quant, rgba + (size_t)i * paddedWidth * 32);
    }
    if (okay && bpp == 32) okay = decodeAlpha(data + offsets[rows], size - offsets[rows], paddedWidth, pixels, rgba, &hasAlpha);
    if (!okay) { free(rgba); return 0; }
    if (width != paddedWidth || height != paddedHeight) {
        uint8_t *cropped = malloc((size_t)width * height * 4);
        if (!cropped) { free(rgba); return 0; }
        for (uint32_t row = 0; row < height; row++) memcpy(cropped + (size_t)row * width * 4, rgba + (size_t)row * paddedWidth * 4, (size_t)width * 4);
        free(rgba); rgba = cropped;
    }
    *output = (MLBGI_CbgBitmap){width, height, hasAlpha, rgba}; return 1;
}
