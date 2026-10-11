/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * The 1.72 dialect has 26-bit addresses and a second system-service group.
 * Contracts are deliberately finite; unknown services never become success. */
#include "vm-dialect.h"
#include "vm-guards.h"
#include "vm-strings.h"
#include "archive-reader.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <math.h>
#ifdef __APPLE__
#include <sys/types.h>
#include <sys/sysctl.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#endif

static uint32_t fault(Thread_t *thread, const char *message) {
    thread->error = 1; thread->running = 0;
    fprintf(stderr, "[BGI]: %s at 0x%08X\n", message, thread->instructionPointer);
    return UINT32_MAX - 3;
}
static MLBGI_Runtime *runtime(const Engine_t *engine) { return engine ? engine->mlRuntime : NULL; }
static uint32_t fixedTrigonometry(Thread_t *thread, int cosine) {
    if (!MLBGI_IsModern(thread)) return fault(thread, "Fixed-point trigonometry requires the 1.72 VM dialect");
    uint32_t bits = Thread_PopStack(thread);
    if (thread->error) return UINT32_MAX - 3;
    /* The original handlers use signed 16.16 degrees, the binary64 pi
       constant, and truncation toward zero after rescaling to 16.16. */
    double radians = (double)(int32_t)bits * 3.141592653589793 / 11796480.0;
    double value = (cosine ? cos(radians) : sin(radians)) * 65536.0;
    Thread_PushStack(thread, (uint32_t)(int32_t)value);
    return thread->error ? UINT32_MAX - 3 : 0;
}
uint32_t MLBGI_FixedSine(Thread_t *thread) { return fixedTrigonometry(thread, 0); }
uint32_t MLBGI_FixedCosine(Thread_t *thread) { return fixedTrigonometry(thread, 1); }
static Thread_t *messageThread(Engine_t *engine, uint32_t id) {
    if (!id) return NULL;
    for (Thread_t *entry = engine->threads; entry; entry = entry->previousThread) if (entry->threadId == id) return entry;
    return NULL;
}
static MLBGI_Filter *filterObject(MLBGI_Runtime *state, uint32_t handle) {
    uint32_t slot = handle & 0x00ffffff;
    return (handle & 0xff000000) == 0x90000000 && slot < 8 && state->filters[slot].allocated ? &state->filters[slot] : NULL;
}
static MLBGI_Sprite *spriteObject(MLBGI_Runtime *state, uint32_t handle) {
    uint32_t slot = handle & 0x00ffffff;
    return (handle & 0xff000000) == 0x80000000 && slot < 512 && state->sprites[slot].object.allocated ? &state->sprites[slot] : NULL;
}
static MLBGI_Filter *graphicObject(MLBGI_Runtime *state, uint32_t handle) {
    MLBGI_Sprite *sprite = spriteObject(state, handle);
    return sprite ? &sprite->object : filterObject(state, handle);
}
static MLBGI_Group *groupObject(MLBGI_Runtime *state, uint32_t handle) {
    uint32_t slot = handle & 0x00ffffff;
    return (handle & 0xff000000) == 0xf1000000 && slot < 8 && state->groups[slot].allocated ? &state->groups[slot] : NULL;
}
static MLBGI_WindowObject *windowObject(MLBGI_Runtime *state, uint32_t handle) {
    uint32_t slot = handle & 0x00ffffff;
    return (handle & 0xff000000) == 0xb0000000 && slot < 16 && state->windows[slot].allocated ? &state->windows[slot] : NULL;
}
static MLBGI_Controller *controllerObject(MLBGI_Runtime *state, uint32_t id) {
    if (!id) return NULL;
    for (unsigned i = 0; i < 64; i++) if (state->controllers[i].id == id) return &state->controllers[i];
    return NULL;
}
int MLBGI_PostControllerEvent(Engine_t *engine, uint32_t id, uint32_t type, uint32_t first, uint32_t second) {
    MLBGI_Runtime *state = runtime(engine);
    MLBGI_Controller *controller = state ? controllerObject(state, id) : NULL;
    if (!controller || controller->eventCount >= 1024) return 0;
    uint32_t *event = controller->events[(controller->eventHead + controller->eventCount++) % 1024];
    event[0] = type; event[1] = first; event[2] = second; return 1;
}
static void discardMenu(MLBGI_Menu *menu) {
    if (!menu) return;
    for (unsigned i = 0; i < menu->imageCount; i++) free(menu->images[i].pixels);
    free(menu->images); free(menu->imageSlots); free(menu->items); free(menu->groups); free(menu);
}
static uint32_t *objectOwner(MLBGI_Runtime *state, uint32_t handle) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    return filter ? &filter->owner : group ? &group->owner : window ? &window->owner : NULL;
}
static uint32_t *objectOpacity(MLBGI_Runtime *state, uint32_t handle) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    return filter ? &filter->opacity : group ? &group->opacity : window ? &window->opacity : NULL;
}
static void detachObject(MLBGI_Runtime *state, uint32_t handle) {
    uint32_t *owner = objectOwner(state, handle);
    MLBGI_Group *group = owner ? groupObject(state, *owner) : NULL;
    if (group) for (unsigned i = 0; i < group->memberCount; i++) if (group->members[i].handle == handle) {
        memmove(group->members + i, group->members + i + 1, (size_t)(group->memberCount - i - 1) * sizeof(*group->members));
        group->memberCount--; break;
    }
    if (owner) *owner = 0;
}
static void groupVisible(MLBGI_Runtime *state, MLBGI_Group *group, uint32_t visible) {
    group->visible = visible;
    for (unsigned i = 0; i < group->memberCount; i++) {
        uint32_t handle = group->members[i].handle;
        MLBGI_Filter *filter = graphicObject(state, handle);
        MLBGI_Group *child = groupObject(state, handle);
        MLBGI_WindowObject *window = windowObject(state, handle);
        if (filter) filter->visible = visible;
        else if (child) groupVisible(state, child, visible);
        else if (window) window->visible = visible;
    }
}
static void groupPosition(MLBGI_Runtime *state, MLBGI_Group *group, int32_t x, int32_t y) {
    group->x = x; group->y = y;
    for (unsigned i = 0; i < group->memberCount; i++) {
        MLBGI_GroupMember *member = &group->members[i];
        int32_t childX = (int32_t)((uint32_t)x + (uint32_t)member->x), childY = (int32_t)((uint32_t)y + (uint32_t)member->y);
        MLBGI_Filter *filter = graphicObject(state, member->handle);
        MLBGI_Group *child = groupObject(state, member->handle);
        MLBGI_WindowObject *window = windowObject(state, member->handle);
        if (filter) { filter->x = childX; filter->y = childY; }
        else if (child) groupPosition(state, child, childX, childY);
        else if (window) { window->x = childX; window->y = childY; }
    }
}
static void groupOpacity(MLBGI_Runtime *state, MLBGI_Group *group, uint32_t opacity) {
    group->opacity = opacity;
    for (unsigned i = 0; i < group->memberCount; i++) {
        uint32_t handle = group->members[i].handle;
        MLBGI_Filter *filter = graphicObject(state, handle);
        MLBGI_Group *child = groupObject(state, handle);
        MLBGI_WindowObject *window = windowObject(state, handle);
        if (filter) filter->opacity = opacity;
        else if (child) groupOpacity(state, child, opacity);
        else if (window) window->opacity = opacity;
    }
}
static int setObjectVisible(MLBGI_Runtime *state, uint32_t handle, uint32_t value) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    if (filter) filter->visible = value;
    else if (group) groupVisible(state, group, value);
    else if (window) window->visible = value;
    else return 0;
    return 1;
}
static int setObjectOpacity(MLBGI_Runtime *state, uint32_t handle, uint32_t value) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    if (value > 256) return 0;
    if (filter) filter->opacity = value;
    else if (group) groupOpacity(state, group, value);
    else if (window) window->opacity = value;
    else return 0;
    return 1;
}
static int setObjectOpacityFactor(MLBGI_Runtime *state, uint32_t handle, uint32_t value, int secondary) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    if (value > 256) return 0;
    if (filter) { if (secondary) filter->secondaryOpacity = value; else filter->opacityScale = value; }
    else if (group) {
        if (secondary) group->secondaryOpacity = value; else group->opacityScale = value;
        for (unsigned i = 0; i < group->memberCount; i++)
            if (!setObjectOpacityFactor(state, group->members[i].handle, value, secondary)) return 0;
    } else if (window) { if (secondary) window->secondaryOpacity = value; else window->opacityScale = value; }
    else return 0;
    return 1;
}
static int setObjectPosition(MLBGI_Runtime *state, uint32_t handle, int32_t x, int32_t y) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    if (filter) { filter->x = x; filter->y = y; }
    else if (group) groupPosition(state, group, x, y);
    else if (window) { window->x = x; window->y = y; }
    else return 0;
    return 1;
}
static int setObjectOffset(MLBGI_Runtime *state, uint32_t handle, int32_t x, int32_t y) {
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    if (!handle) {
        /* Handle zero is the original display root, which always exists.
           The native setter replaces the offsets of its current children;
           newly constructed objects still start with zero offsets. */
        state->rootOffsetX = x; state->rootOffsetY = y;
        for (unsigned i = 0; i < 8; i++) {
            if (state->filters[i].allocated) { state->filters[i].offsetX = x; state->filters[i].offsetY = y; }
            if (state->groups[i].allocated) { state->groups[i].offsetX = x; state->groups[i].offsetY = y; }
        }
        for (unsigned i = 0; i < 16; i++) if (state->windows[i].allocated) {
            state->windows[i].offsetX = x; state->windows[i].offsetY = y;
        }
        for (unsigned i = 0; i < 512; i++) if (state->sprites[i].object.allocated) {
            state->sprites[i].object.offsetX = x; state->sprites[i].object.offsetY = y;
        }
    } else if (filter) { filter->offsetX = x; filter->offsetY = y; }
    else if (window) { window->offsetX = x; window->offsetY = y; }
    else if (group) {
        group->offsetX = x; group->offsetY = y;
        for (unsigned i = 0; i < group->memberCount; i++)
            if (!setObjectOffset(state, group->members[i].handle, x, y)) return 0;
    } else return 0;
    state->drawOrderDirty = 1; return 1;
}
static MLBGI_ObjectData *objectData(MLBGI_Runtime *state, uint32_t handle) {
    if (!handle) return &state->rootData;
    MLBGI_Filter *filter = graphicObject(state, handle);
    MLBGI_Group *group = groupObject(state, handle);
    MLBGI_WindowObject *window = windowObject(state, handle);
    return filter ? &filter->data : group ? &group->data : window ? &window->data : NULL;
}
int MLBGI_ApplyFilter(const Engine_t *engine, uint32_t handle, uint8_t *rgba, size_t bytes) {
    MLBGI_Runtime *state = runtime(engine);
    MLBGI_Filter *filter = state ? filterObject(state, handle) : NULL;
    if (!filter || !rgba || !bytes || bytes % 4 || bytes > 32 * 1024 * 1024 || filter->kind != 0 ||
        filter->opacity > 256 || filter->secondaryOpacity > 256 || filter->opacityScale > 256) return 0;
    unsigned opacity = (filter->opacity * (256 - filter->secondaryOpacity) * filter->opacityScale) >> 16;
    if (!filter->visible || !opacity) return 1;
    uint32_t colors[3] = { (filter->parameter >> 16) & 255, (filter->parameter >> 8) & 255, filter->parameter & 255 };
    for (size_t offset = 0; offset < bytes; offset += 4)
        for (unsigned channel = 0; channel < 3; channel++)
            rgba[offset + channel] = (uint8_t)(((uint32_t)rgba[offset + channel] * (256 - opacity) + colors[channel] * opacity) >> 8);
    return 1;
}
static int windowMenuOutputSafe(const MLBGI_Runtime *state, uint32_t handle, const MLBGI_WindowObject *window,
                                const uint8_t *rgba, size_t outputBytes) {
    for (unsigned i = 0; i < 64; i++) {
        const MLBGI_Controller *controller = &state->controllers[i];
        const MLBGI_Menu *menu = controller->menu;
        if (!controller->id || controller->target != handle || !menu) continue;
        if (!menu->header[0] || menu->header[0] > 256 || menu->itemCount > 256 || menu->imageCount > 1024 ||
            !menu->groups || !menu->items || !menu->images || !menu->imageSlots) return 0;
        if (controller->enabled && window->visible && menu->itemCount && window->blendMode != 1 &&
            (window->opacity || window->secondaryOpacity || window->opacityScale != 256)) return 0;
        for (unsigned j = 0; j < menu->itemCount; j++) {
            if (menu->items[j].group >= menu->header[0]) return 0;
            for (unsigned k = 0; k < 4; k++) if (menu->items[j].images[k] != UINT32_MAX && menu->items[j].images[k] >= menu->imageCount) return 0;
        }
        for (unsigned j = 0; j < menu->imageCount; j++) {
            const MLBGI_MenuImage *image = &menu->images[j];
            if (!image->pixels || !image->width || !image->height || image->width > 8192 || image->height > 8192 ||
                (uint64_t)image->width * image->height > 8 * 1024 * 1024 || (image->format != 1 && image->format != 2)) return 0;
            uintptr_t output = (uintptr_t)rgba, source = (uintptr_t)image->pixels;
            size_t sourceBytes = (size_t)image->width * image->height * 4;
            if ((output <= source && source - output < outputBytes) || (source <= output && output - source < sourceBytes)) return 0;
        }
    }
    return 1;
}
static int drawWindowMenus(const MLBGI_Runtime *state, uint32_t handle, const MLBGI_WindowObject *window,
                           uint8_t *rgba, uint32_t width, uint32_t height, size_t stride) {
    int32_t baseX = (int32_t)((uint32_t)window->x + (uint32_t)window->offsetX);
    int32_t baseY = (int32_t)((uint32_t)window->y + (uint32_t)window->offsetY);
    for (unsigned i = 0; i < 64; i++) {
        const MLBGI_Controller *controller = &state->controllers[i];
        const MLBGI_Menu *menu = controller->menu;
        if (!controller->id || controller->target != handle || !menu) continue;
        if (!controller->enabled || !window->visible) continue;
        unsigned weight = ((256 - window->opacity) * (256 - window->secondaryOpacity) * window->opacityScale) >> 16;
        for (unsigned j = 0; j < menu->itemCount; j++) {
            const MLBGI_MenuItem *item = &menu->items[j];
            if (!item->values[1]) continue;
            unsigned which = menu->header[2] == item->group && menu->groups[item->group][3] == item->index ? 2 : 0;
            unsigned imageIndex = item->images[which];
            if (imageIndex == UINT32_MAX) continue;
            if (imageIndex >= menu->imageCount) return 0;
            const MLBGI_MenuImage *image = &menu->images[imageIndex];
            if (!image->pixels || !image->width || !image->height || image->width > 8192 || image->height > 8192 ||
                (uint64_t)image->width * image->height > 8 * 1024 * 1024 || (image->format != 1 && image->format != 2)) return 0;
            int32_t drawX = (int32_t)((uint32_t)baseX + item->values[2]), drawY = (int32_t)((uint32_t)baseY + item->values[3]);
            int64_t left = drawX < 0 ? -(int64_t)drawX : 0, top = drawY < 0 ? -(int64_t)drawY : 0;
            int64_t right = image->width, bottom = image->height;
            if (right > (int64_t)width - drawX) right = (int64_t)width - drawX;
            if (bottom > (int64_t)height - drawY) bottom = (int64_t)height - drawY;
            for (int64_t y = top; y < bottom; y++) for (int64_t x = left; x < right; x++) {
                const uint8_t *input = image->pixels + ((size_t)y * image->width + (size_t)x) * 4;
                uint8_t *output = rgba + (size_t)(drawY + y) * stride + (size_t)(drawX + x) * 4;
                unsigned alpha = image->format == 1 || input[3] >= 254 ? 128 : input[3] >> 1;
                if (window->blendMode == 1 && weight != 256) alpha = ((input[3] >> 1) * weight) >> 8;
                for (unsigned channel = 0; channel < 3; channel++)
                    output[channel] = (uint8_t)(((uint32_t)input[channel] * alpha + (uint32_t)output[channel] * (128 - alpha)) >> 7);
                output[3] = 255;
            }
        }
    }
    return 1;
}
int MLBGI_DrawWindow(const Engine_t *engine, uint32_t handle, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    MLBGI_WindowObject *window = state ? windowObject(state, handle) : NULL;
    if (!window || !rgba || !width || !height || width > 8192 || height > 8192 ||
        (uint64_t)width * height > 8 * 1024 * 1024 || stride < (size_t)width * 4 || stride > 32 * 1024 * 1024 / height || stride * height > capacity ||
        window->opacity > 256 || window->secondaryOpacity > 256 || window->opacityScale > 256 ||
        (window->blendMode != 0 && window->blendMode != 1 && window->blendMode != 128) ||
        !window->pixels || !window->width || !window->height || window->width > 8192 || window->height > 32768 ||
        (uint64_t)window->width * window->height > 8 * 1024 * 1024) return 0;
    if (!windowMenuOutputSafe(state, handle, window, rgba, stride * height)) return 0;
    /* A canvas owns its source bytes. Presentation may not alias them. */
    uintptr_t outputAddress = (uintptr_t)rgba, sourceAddress = (uintptr_t)window->pixels;
    size_t outputBytes = stride * height, sourceBytes = (size_t)window->width * window->height * 4;
    if ((outputAddress <= sourceAddress && sourceAddress - outputAddress < outputBytes) ||
        (sourceAddress <= outputAddress && outputAddress - sourceAddress < sourceBytes)) return 0;
    if (!window->visible) return 1;
    int32_t drawX = (int32_t)((uint32_t)window->x + (uint32_t)window->offsetX);
    int32_t drawY = (int32_t)((uint32_t)window->y + (uint32_t)window->offsetY);
    int64_t left = drawX < 0 ? -(int64_t)drawX : 0, top = drawY < 0 ? -(int64_t)drawY : 0;
    int64_t right = window->width, bottom = window->height;
    if (right > (int64_t)width - drawX) right = (int64_t)width - drawX;
    if (bottom > (int64_t)height - drawY) bottom = (int64_t)height - drawY;
    if (left >= right || top >= bottom) return drawWindowMenus(state, handle, window, rgba, width, height, stride);
    unsigned transparency = 256 - (((256 - window->opacity) * (256 - window->secondaryOpacity) * window->opacityScale) >> 16);
    for (int64_t y = top; y < bottom; y++) for (int64_t x = left; x < right; x++) {
        uint8_t *output = rgba + (size_t)(drawY + y) * stride + (size_t)(drawX + x) * 4;
        const uint8_t *input = window->pixels + ((size_t)y * window->width + (size_t)x) * 4;
        unsigned alpha = input[3] >= 254 ? 128 : input[3] >> 1;
        if (window->blendMode == 1 && transparency) alpha = ((input[3] >> 1) * (256 - transparency)) >> 8;
        for (unsigned channel = 0; channel < 3; channel++)
            output[channel] = window->blendMode == 128 ? (uint8_t)((uint32_t)input[channel] * alpha >> 7) :
                (uint8_t)(((uint32_t)input[channel] * alpha + (uint32_t)output[channel] * (128 - alpha)) >> 7);
        output[3] = 255;
    }
    return drawWindowMenus(state, handle, window, rgba, width, height, stride);
}
typedef struct { uint32_t key, handle; uint64_t sequence; } SceneEntry;
static int drawSprite(const MLBGI_Sprite *sprite, uint8_t *rgba, uint32_t width, uint32_t height, size_t stride) {
    const MLBGI_Filter *object = &sprite->object;
    const MLBGI_MenuImage *image = &sprite->image;
    if (!object->visible || !image->pixels) return 1;
    int32_t drawX = (int32_t)((uint32_t)object->x + (uint32_t)object->offsetX);
    int32_t drawY = (int32_t)((uint32_t)object->y + (uint32_t)object->offsetY);
    int64_t left = drawX < 0 ? -(int64_t)drawX : 0, top = drawY < 0 ? -(int64_t)drawY : 0;
    int64_t right = image->width, bottom = image->height;
    if (right > (int64_t)width - drawX) right = (int64_t)width - drawX;
    if (bottom > (int64_t)height - drawY) bottom = (int64_t)height - drawY;
    unsigned weight = ((256 - object->opacity) * (256 - object->secondaryOpacity) * object->opacityScale) >> 16;
    for (int64_t y = top; y < bottom; y++) for (int64_t x = left; x < right; x++) {
        uint8_t *output = rgba + (size_t)(drawY + y) * stride + (size_t)(drawX + x) * 4;
        const uint8_t *input = image->pixels + ((size_t)y * image->width + (size_t)x) * 4;
        unsigned alpha = input[3] >= 254 ? 128 : input[3] >> 1;
        if (sprite->blendMode == 1 && weight != 256) alpha = ((input[3] >> 1) * weight) >> 8;
        for (unsigned channel = 0; channel < 3; channel++)
            output[channel] = sprite->blendMode == 128 ? (uint8_t)((uint32_t)input[channel] * alpha >> 7) :
                (uint8_t)(((uint32_t)input[channel] * alpha + (uint32_t)output[channel] * (128 - alpha)) >> 7);
        output[3] = 255;
    }
    return 1;
}
static uint32_t sceneKey(const MLBGI_Runtime *state, uint32_t order, unsigned kind, int32_t y) {
    int32_t band = y / 8 - (y % 8 < 0);
    return state->drawOrderBase + (order << 16) + (kind << 13) + (((uint32_t)4095 - (uint32_t)band) & 0x1fff);
}
static int sceneCompare(const void *a, const void *b) {
    const SceneEntry *left = a, *right = b;
    if (left->key != right->key) return left->key < right->key ? -1 : 1;
    if (left->sequence != right->sequence) return left->sequence < right->sequence ? -1 : 1;
    return left->handle < right->handle ? -1 : left->handle != right->handle;
}
static int drawScene(const Engine_t *engine, uint32_t maximumKey, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !rgba || !width || !height || width > 8192 || height > 8192 ||
        (uint64_t)width * height > 8 * 1024 * 1024 || stride < (size_t)width * 4 ||
        stride > 32 * 1024 * 1024 / height || stride * height > capacity) return 0;
    SceneEntry entries[536]; unsigned count = 0;
    for (unsigned i = 0; i < 512; i++) if (state->sprites[i].object.allocated) {
        const MLBGI_Sprite *sprite = &state->sprites[i];
        const MLBGI_Filter *object = &sprite->object;
        const MLBGI_MenuImage *image = &sprite->image;
        if (object->order >= 65536) return 0;
        int32_t y = (int32_t)((uint32_t)object->y + (uint32_t)object->offsetY);
        uint32_t key = sceneKey(state, object->order, 2, y); if (key > maximumKey) continue;
        if (object->opacity > 256 || object->secondaryOpacity > 256 || object->opacityScale > 256 ||
            (sprite->blendMode != 0 && sprite->blendMode != 1 && sprite->blendMode != 128)) return 0;
        if (!image->pixels) { if (image->width || image->height || image->format) return 0; continue; }
        if (!image->width || !image->height || image->width > 8192 || image->height > 8192 ||
            (uint64_t)image->width * image->height > 8 * 1024 * 1024 || (image->format != 1 && image->format != 2)) return 0;
        uintptr_t outputAddress = (uintptr_t)rgba, sourceAddress = (uintptr_t)image->pixels;
        size_t outputBytes = stride * height, sourceBytes = (size_t)image->width * image->height * 4;
        if ((outputAddress <= sourceAddress && sourceAddress - outputAddress < outputBytes) ||
            (sourceAddress <= outputAddress && outputAddress - sourceAddress < sourceBytes)) return 0;
        entries[count++] = (SceneEntry){ key, 0x80000000 | i, object->drawSequence };
    }
    for (unsigned i = 0; i < 8; i++) if (state->filters[i].allocated) {
        const MLBGI_Filter *filter = &state->filters[i];
        if (filter->order >= 65536) return 0;
        int32_t y = (int32_t)((uint32_t)filter->y + (uint32_t)filter->offsetY);
        uint32_t key = sceneKey(state, filter->order, 7, y); if (key > maximumKey) continue;
        if (filter->kind || filter->opacity > 256 || filter->secondaryOpacity > 256 || filter->opacityScale > 256) return 0;
        entries[count++] = (SceneEntry){ key, 0x90000000 | i, filter->drawSequence };
    }
    for (unsigned i = 0; i < 16; i++) if (state->windows[i].allocated) {
        const MLBGI_WindowObject *window = &state->windows[i];
        if (window->order >= 65536) return 0;
        int32_t y = (int32_t)((uint32_t)window->y + (uint32_t)window->offsetY);
        uint32_t key = sceneKey(state, window->order, 3, y); if (key > maximumKey) continue;
        if (!window->pixels || !window->width || !window->height || window->width > 8192 || window->height > 32768 ||
            (uint64_t)window->width * window->height > 8 * 1024 * 1024 || window->order >= 65536) return 0;
        if (!windowMenuOutputSafe(state, 0xb0000000 | i, window, rgba, stride * height)) return 0;
        uintptr_t outputAddress = (uintptr_t)rgba, sourceAddress = (uintptr_t)window->pixels;
        size_t outputBytes = stride * height, sourceBytes = (size_t)window->width * window->height * 4;
        if ((outputAddress <= sourceAddress && sourceAddress - outputAddress < outputBytes) ||
            (sourceAddress <= outputAddress && outputAddress - sourceAddress < sourceBytes)) return 0;
        entries[count++] = (SceneEntry){ key, 0xb0000000 | i, window->drawSequence };
    }
    qsort(entries, count, sizeof(*entries), sceneCompare);
    /* Compose offscreen so a missing pixel contract never leaves a
       partly drawn frame in the presentation surface. Padding is kept. */
    size_t bytes = (size_t)width * height * 4;
    uint8_t *canvas = malloc(bytes);
    if (!canvas) return 0;
    uint32_t background = state->canvasEnabled ? state->canvasBackground : 0;
    for (size_t offset = 0; offset < bytes; offset += 4) {
        canvas[offset] = (uint8_t)(background >> 16); canvas[offset + 1] = (uint8_t)(background >> 8);
        canvas[offset + 2] = (uint8_t)background; canvas[offset + 3] = 255;
    }
    int okay = 1;
    for (unsigned i = 0; i < count && okay; i++)
        okay = (entries[i].handle & 0xff000000) == 0x80000000 ? drawSprite(&state->sprites[entries[i].handle & 0x00ffffff], canvas, width, height, (size_t)width * 4) :
            (entries[i].handle & 0xff000000) == 0x90000000 ? MLBGI_ApplyFilter(engine, entries[i].handle, canvas, bytes) :
            MLBGI_DrawWindow(engine, entries[i].handle, canvas, bytes, width, height, (size_t)width * 4);
    if (okay) for (uint32_t y = 0; y < height; y++) memcpy(rgba + (size_t)y * stride, canvas + (size_t)y * width * 4, (size_t)width * 4);
    free(canvas); return okay;
}
int MLBGI_DrawScene(const Engine_t *engine, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride) {
    return drawScene(engine, UINT32_MAX, rgba, capacity, width, height, stride);
}
int MLBGI_DrawSceneThroughOrder(const Engine_t *engine, uint32_t maximumOrder, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride) {
    return maximumOrder < 65536 && drawScene(engine, (maximumOrder << 16) | 0xffff, rgba, capacity, width, height, stride);
}
uint32_t MLBGI_WindowLineHeight(const Engine_t *engine, uint32_t handle) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    MLBGI_WindowObject *window = state ? windowObject(state, handle) : NULL;
    return window && window->fontConfigured ? window->fontHeight + window->fontHeight * window->textLineSpacingPercent / 100 : 0;
}
/* The 1.72 allocator divides its 26-bit offset into a fixed-size slot and
   an intra-allocation offset. A full smaller tier falls through to the next
   tier. Region three is object memory; regions four through fifteen remain
   unmapped and must never alias these byte allocations. */
typedef struct { uint32_t bits, firstRegion, endRegion, slots; } MemoryTier;
static const MemoryTier memoryTiers[5] = {
    {12, 16, 20, 65536}, {16, 20, 24, 4096}, {20, 24, 28, 256},
    {24, 28, 32, 16}, {26, 32, 64, 32}
};
#define MLBGI_MAX_ALLOCATED_BYTES ((size_t)256 * 1024 * 1024)
static MLBGI_Allocation *allocation(MLBGI_Runtime *state, uint32_t address, uint32_t *offset) {
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return NULL;
    uint32_t region = address >> 26;
    for (unsigned i = 0; i < 5; i++) {
        const MemoryTier *tier = &memoryTiers[i];
        if (region < tier->firstRegion || region >= tier->endRegion) continue;
        uint32_t slot = ((region - tier->firstRegion) << (26 - tier->bits)) |
            ((address & 0x03ffffff) >> tier->bits);
        *offset = address & (((uint32_t)1 << tier->bits) - 1);
        return state->allocationSlots[i] && slot < tier->slots ? state->allocationSlots[i][slot] : NULL;
    }
    return NULL;
}
uint32_t MLBGI_AllocateMemory(Engine_t *engine, uint32_t bytes) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !bytes || bytes > 0x04000000 ||
        state->allocatedBytes > MLBGI_MAX_ALLOCATED_BYTES || bytes > MLBGI_MAX_ALLOCATED_BYTES - state->allocatedBytes) return 0;
    for (unsigned i = 0; i < 5; i++) {
        const MemoryTier *tier = &memoryTiers[i];
        if (bytes > ((uint32_t)1 << tier->bits)) continue;
        if (!state->allocationSlots[i]) {
            state->allocationSlots[i] = calloc(tier->slots, sizeof(*state->allocationSlots[i]));
            if (!state->allocationSlots[i]) return 0;
        }
        uint32_t slot = state->nextAllocationSlot[i];
        while (slot < tier->slots && state->allocationSlots[i][slot]) slot++;
        if (slot == tier->slots) { state->nextAllocationSlot[i] = slot; continue; }
        MLBGI_Allocation *entry = calloc(1, sizeof(*entry));
        if (!entry || !(entry->bytes = calloc(1, bytes))) { free(entry); return 0; }
        entry->size = bytes; entry->tier = i; entry->slot = slot;
        entry->next = state->allocations; state->allocations = entry;
        state->allocationSlots[i][slot] = entry; state->nextAllocationSlot[i] = slot + 1;
        state->allocatedBytes += bytes;
        return ((tier->firstRegion + (slot >> (26 - tier->bits))) << 26) |
            ((slot & (((uint32_t)1 << (26 - tier->bits)) - 1)) << tier->bits);
    }
    return 0;
}
int MLBGI_FreeMemory(Engine_t *engine, uint32_t address) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return 0;
    if (!address) return 1;
    uint32_t offset = 0;
    MLBGI_Allocation *entry = allocation(state, address, &offset);
    if (!entry || offset) return 0;
    MLBGI_Allocation **link = &state->allocations;
    while (*link && *link != entry) link = &(*link)->next;
    if (!*link) return 0;
    *link = entry->next; state->allocatedBytes -= entry->size;
    state->allocationSlots[entry->tier][entry->slot] = NULL;
    if (entry->slot < state->nextAllocationSlot[entry->tier]) state->nextAllocationSlot[entry->tier] = entry->slot;
    free(entry->bytes); free(entry); return 1;
}
int MLBGI_RegisterArchiveGroup(Engine_t *engine, const char *alias, const char *const *names, unsigned count) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !MLBGI_ValidResourceName(alias) ||
        !names || !count || count > 128 || state->archiveGroupCount >= 64) return 0;
    for (unsigned i = 0; i < state->archiveGroupCount; i++)
        if (MLBGI_ResourceNameEqual(state->archiveGroups[i].alias, alias)) return 0;
    MLBGI_ArchiveGroup candidate = {0};
    memcpy(candidate.alias, alias, strlen(alias) + 1);
    candidate.filenames = calloc(count, sizeof(*candidate.filenames));
    if (!candidate.filenames) return 0;
    for (unsigned i = 0; i < count; i++) {
        if (!MLBGI_ValidResourceName(names[i])) goto fail;
        for (unsigned j = 0; j < i; j++) if (MLBGI_ResourceNameEqual(names[i], names[j])) goto fail;
        candidate.filenames[i] = strdup(names[i]);
        if (!candidate.filenames[i]) goto fail;
        candidate.count++;
    }
    state->archiveGroups[state->archiveGroupCount++] = candidate; return 1;
fail:
    for (unsigned i = 0; i < candidate.count; i++) free(candidate.filenames[i]);
    free(candidate.filenames); return 0;
}
uint8_t *MLBGI_ReadEngineResource(Engine_t *engine, const char *archive, const char *filename, size_t *bytes) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return MLBGI_ReadFile(archive, filename, bytes);
    if (archive && *archive) for (unsigned i = 0; i < state->archiveGroupCount; i++) {
        MLBGI_ArchiveGroup *group = &state->archiveGroups[i];
        if (MLBGI_ResourceNameEqual(group->alias, archive)) return MLBGI_ReadArchiveList(
            (const char *const *)group->filenames, group->count, filename,
            (const char *const *)state->searchPaths, state->searchPathCount, state->searchDirectoriesEnabled != 0, bytes);
    }
    return MLBGI_ReadResource(archive, filename, (const char *const *)state->searchPaths,
        state->searchPathCount, state->searchDirectoriesEnabled != 0, bytes);
}
static int resourceStatus(Engine_t *engine, const char *archive, const char *filename) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return -1;
    if (archive && *archive) for (unsigned i = 0; i < state->archiveGroupCount; i++) {
        MLBGI_ArchiveGroup *group = &state->archiveGroups[i];
        if (MLBGI_ResourceNameEqual(group->alias, archive)) return MLBGI_ArchiveListStatus(
            (const char *const *)group->filenames, group->count, filename,
            (const char *const *)state->searchPaths, state->searchPathCount, state->searchDirectoriesEnabled != 0);
    }
    return MLBGI_ResourceStatus(archive, filename, (const char *const *)state->searchPaths,
        state->searchPathCount, state->searchDirectoriesEnabled != 0);
}
int MLBGI_PostMessage(Engine_t *engine, uint32_t type, uint32_t first, uint32_t second) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || state->messageCount >= MLBGI_MESSAGE_CAPACITY) return 0;
    unsigned tail = (state->messageHead + state->messageCount) % MLBGI_MESSAGE_CAPACITY;
    state->messages[tail][0] = type; state->messages[tail][1] = first; state->messages[tail][2] = second;
    state->messageCount++; return 1;
}
static int intern(MLBGI_Runtime *state, const char *name, uint32_t flags, int setFlags) {
    for (unsigned i = 0; i < state->nameCount; i++) {
        if (strcmp(state->names[i], name)) continue;
        if (setFlags) state->nameFlags[i] = flags;
        return (int)i;
    }
    size_t bytes = strlen(name) + 1;
    if (state->nameCount >= 256 || bytes > 1024) return -1;
    char *copy = malloc(bytes);
    if (!copy) return -1;
    memcpy(copy, name, bytes);
    unsigned index = state->nameCount++;
    state->names[index] = copy; state->nameFlags[index] = setFlags ? flags : 0;
    return (int)index;
}
static uint32_t persistentStringHash(const char *text) {
    uint32_t hash = 0;
    /* Original byte hashing sign-extends each CP932 byte and wraps at 32 bits. */
    for (const unsigned char *input = (const unsigned char *)text; *input; input++)
        hash = hash * 233u + (uint32_t)(int32_t)(int8_t)*input;
    return hash;
}
static int persistentStringIndex(const MLBGI_Runtime *state, const char *text, uint32_t hash) {
    for (unsigned i = 0; i < state->persistentStringCount; i++)
        if (state->persistentStrings[i].hash == hash && !strcmp(state->persistentStrings[i].text, text)) return (int)i;
    return -1;
}
static int registerPersistentString(MLBGI_Runtime *state, const char *text) {
    uint32_t hash = persistentStringHash(text);
    if (persistentStringIndex(state, text, hash) >= 0) return 1;
    size_t bytes = strlen(text) + 1;
    if (state->persistentStringCount >= 65536 || state->persistentStringBytes > 16u * 1024 * 1024 ||
        bytes > 16u * 1024 * 1024 - state->persistentStringBytes) return 0;
    char *copy = malloc(bytes);
    if (!copy) return 0;
    memcpy(copy, text, bytes);
    if (state->persistentStringCount == state->persistentStringCapacity) {
        unsigned capacity = state->persistentStringCapacity ? state->persistentStringCapacity * 2 : 32;
        MLBGI_PersistentString *entries = realloc(state->persistentStrings, (size_t)capacity * sizeof(*entries));
        if (!entries) { free(copy); return 0; }
        state->persistentStrings = entries; state->persistentStringCapacity = capacity;
    }
    state->persistentStrings[state->persistentStringCount++] = (MLBGI_PersistentString){hash, copy};
    state->persistentStringBytes += bytes; return 1;
}
static MLBGI_RecordList *recordList(MLBGI_Runtime *state, uint32_t id) {
    if (!state || !id) return NULL;
    for (unsigned i = 0; i < 64; i++) if (state->recordLists[i].id == id) return &state->recordLists[i];
    return NULL;
}
static void freeRecords(MLBGI_Runtime *state, MLBGI_RecordList *list) {
    for (uint32_t i = 0; i < list->count; i++) free(list->records[i]);
    state->recordBytes -= (size_t)list->bytes * list->count;
    free(list->records); memset(list, 0, sizeof(*list));
}
static MLBGI_KeyedContainer *keyedContainer(MLBGI_Runtime *state, uint32_t id) {
    if (!state || !id) return NULL;
    for (unsigned i = 0; i < 64; i++) if (state->keyedContainers[i].id == id) return &state->keyedContainers[i];
    return NULL;
}
static void freeKeyedRecord(MLBGI_Runtime *state, MLBGI_KeyedContainer *container, MLBGI_KeyedRecord *record) {
    state->keyedBytes -= sizeof(*record) + strlen(record->key) + 1 + container->bytes;
    free(record->key); free(record->bytes); free(record); container->count--;
}
static void freeKeyedContainer(MLBGI_Runtime *state, MLBGI_KeyedContainer *container) {
    while (container->records) {
        MLBGI_KeyedRecord *record = container->records;
        container->records = record->next; freeKeyedRecord(state, container, record);
    }
    memset(container, 0, sizeof(*container));
}
static MLBGI_FlagGroup *flagGroup(MLBGI_Runtime *state, const char *name) {
    for (unsigned i = 0; i < 64; i++) if (state->flagGroups[i].name && !strcmp(state->flagGroups[i].name, name)) return &state->flagGroups[i];
    return NULL;
}
int MLBGI_ConfigureDialect(Engine_t *engine, const char *name, uint32_t width, uint32_t height) {
    if (!engine || engine->mlRuntime || !name || !width || !height || width > 32768 || height > 32768) return 0;
    MLBGI_Dialect dialect;
    if (!strcmp(name, "legacy-v1")) dialect = MLBGI_LEGACY;
    else if (!strcmp(name, "ethornell-1.72")) dialect = MLBGI_ETHORNELL_172;
    else return 0;
    MLBGI_Runtime *state = calloc(1, sizeof(*state));
    if (!state) return 0;
    state->dialect = dialect; state->monitorWidth = width; state->monitorHeight = height;
    state->cursorVisible = 1; state->cursorX = state->cursorY = INT32_MIN;
    state->canvasEnabled = 1;
    state->skipKeysEnabled = state->skipOutputEnabled = 1;
    state->keyboardRoutes[0] = 1; state->keyboardRouteCount = 1;
    state->mouseRoutes[0] = (MLBGI_InputRoute){1, {INT32_MIN, INT32_MIN, INT32_MAX, INT32_MAX}};
    state->mouseRouteCount = 1;
    state->wheelObjectNavigation = 1;
    state->textShadowWidthPercent = state->textShadowHeightPercent = 17;
    state->textShadowOpacity = 192;
    MLBGI_InitInput(&state->input);
    for (unsigned i = 0; i < 16; i++) state->audioChannelVolumes[i] = 128;
    for (unsigned i = 0; i < 128; i++) state->audioEffectVolumes[i] = 128;
    state->files.sourceFd = state->files.stateFd = -1;
    const uint32_t widths[8] = {320, 640, 800, 1024, 1024, 1024, 1280, 1920};
    const uint32_t heights[8] = {240, 480, 600, 768, 576, 600, 720, 1080};
    memcpy(state->displayWidths, widths, sizeof(widths)); memcpy(state->displayHeights, heights, sizeof(heights));
    /* The dialect seeds two font-family names before IPL. The Latin aliases
       preserve the original default IDs on a non-Japanese host. */
    if (dialect == MLBGI_ETHORNELL_172 && (intern(state, "MS Gothic", 0, 0) != 0 || intern(state, "MS Mincho", 0, 0) != 1)) {
        for (unsigned i = 0; i < state->nameCount; i++) free(state->names[i]);
        free(state); return 0;
    }
    /* This dialect's interpreter bootstrap allocates level-four global memory
       before IPL; IPL may read startup configuration before reallocating it. */
    if (dialect == MLBGI_ETHORNELL_172 && !engine->globalMem) {
        engine->globalMem = calloc(1, 0x10000);
        if (!engine->globalMem) { for (unsigned i = 0; i < state->nameCount; i++) free(state->names[i]); free(state); return 0; }
        engine->globalBufferSize = 0x10000;
    }
    engine->mlRuntime = state; return 1;
}
void MLBGI_FreeDialect(Engine_t *engine) {
    MLBGI_Runtime *state = runtime(engine);
    if (state) {
        for (unsigned i = 0; i < 64; i++) discardMenu(state->controllers[i].menu);
        if (state->freeParticleResources) state->freeParticleResources(engine);
        for (unsigned i = 0; i < 64; i++) freeRecords(state, &state->recordLists[i]);
        for (unsigned i = 0; i < 64; i++) freeKeyedContainer(state, &state->keyedContainers[i]);
        for (unsigned i = 0; i < 64; i++) { free(state->flagGroups[i].name); free(state->flagGroups[i].bits); }
        for (unsigned i = 0; i < state->nameCount; i++) free(state->names[i]);
        for (unsigned i = 0; i < state->persistentStringCount; i++) free(state->persistentStrings[i].text);
        free(state->persistentStrings);
        for (unsigned i = 0; i < state->searchPathCount; i++) free(state->searchPaths[i]);
        for (unsigned i = 0; i < state->archiveGroupCount; i++) {
            MLBGI_ArchiveGroup *group = &state->archiveGroups[i];
            for (unsigned j = 0; j < group->count; j++) free(group->filenames[j]);
            free(group->filenames);
        }
        while (state->allocations) {
            MLBGI_Allocation *entry = state->allocations;
            state->allocations = entry->next; free(entry->bytes); free(entry);
        }
        for (unsigned i = 0; i < 5; i++) free(state->allocationSlots[i]);
        for (unsigned i = 0; i < 16; i++) free(state->windows[i].pixels);
        for (unsigned i = 0; i < 512; i++) free(state->sprites[i].image.pixels);
        MLBGI_CloseFiles(&state->files);
        free(state);
    }
    if (engine) engine->mlRuntime = NULL;
}
int MLBGI_IsModern(const Thread_t *thread) { MLBGI_Runtime *state = thread ? runtime(thread->engine) : NULL; return state && state->dialect == MLBGI_ETHORNELL_172; }
int MLBGI_ThreadReady(Thread_t *thread, uint32_t milliseconds) {
    if (!thread) return 0;
    if (!MLBGI_IsModern(thread)) return 1;
    MLBGI_Runtime *state = runtime(thread->engine);
    for (unsigned i = 0; i < 64; i++) if (state->transitions[i].thread == thread) {
        MLBGI_Transition *transition = &state->transitions[i];
        uint32_t elapsed = milliseconds - transition->startMilliseconds;
        if (elapsed > transition->duration) elapsed = transition->duration;
        uint32_t opacity = transition->targetOpacity;
        if (elapsed < transition->duration) {
            uint32_t fraction = (uint32_t)(((uint64_t)elapsed << 24) / transition->duration) >> 8;
            int64_t product = ((int64_t)transition->targetOpacity - transition->initialOpacity) * fraction;
            int64_t change = product < 0 ? -((-product + 65535) / 65536) : product / 65536;
            opacity = (uint32_t)((int64_t)transition->initialOpacity + change);
        }
        if (!setObjectOpacity(state, transition->object, opacity)) {
            memset(transition, 0, sizeof(*transition)); thread->mlWaitActive = 0;
            fault(thread, "Timed opacity target is no longer available"); return 0;
        }
        state->framePending = 1;
        if (elapsed < transition->duration) return 0;
        uint64_t frames = state->presentedFrames - transition->initialPresentedFrames;
        uint64_t rate = frames > UINT64_MAX / 1000 ? UINT32_MAX : frames * 1000 / transition->duration;
        memset(transition, 0, sizeof(*transition)); thread->mlWaitActive = 0;
        Thread_PushStack(thread, rate > UINT32_MAX ? UINT32_MAX : (uint32_t)rate);
        Thread_PushStack(thread, 0); return !thread->error;
    }
    if (!thread->mlWaitActive) return 1;
    int interrupted = thread->mlWaitOutputPending && thread->mlWaitInputEnabled &&
        MLBGI_InputInterrupted(&state->input, 0x80000181, thread->mlWaitInputBaseline);
    if (!interrupted && (int32_t)(thread->mlWaitDeadline - milliseconds) > 0) return 0;
    thread->mlWaitActive = 0;
    if (thread->mlWaitOutputPending) {
        thread->mlWaitOutputPending = 0; thread->mlWaitInputEnabled = 0;
        Thread_PushStack(thread, interrupted != 0);
    }
    return !thread->error;
}
uint32_t MLBGI_LocalAddress(Thread_t *thread, uint32_t offset) {
    uint32_t mask = MLBGI_IsModern(thread) ? 0x03ffffff : 0x00ffffff;
    if (offset > mask || offset >= thread->localMemSize) { fault(thread, "Local address exceeds its memory region"); return 0; }
    return offset | (MLBGI_IsModern(thread) ? 0x08000000 : 0x10000000);
}
uint32_t MLBGI_CodeAddress(Thread_t *thread, uint32_t offset) {
    uint32_t mask = MLBGI_IsModern(thread) ? 0x03ffffff : 0x00ffffff;
    if (offset > mask || offset >= thread->codeSpaceUsed) { fault(thread, "Code address exceeds its program region"); return 0; }
    return offset | (MLBGI_IsModern(thread) ? 0x04000000 : 0x11000000);
}
uint8_t *MLBGI_ResolveAddress(Thread_t *thread, uint32_t address) {
    if (!address) return NULL; /* Both dialects reserve zero for null. */
    unsigned modern = MLBGI_IsModern(thread), region = modern ? address >> 26 : address >> 24;
    uint32_t offset = address & (modern ? 0x03ffffff : 0x00ffffff), size = 0;
    uint8_t *base = NULL;
    if (region == 0) { base = thread->engine->globalMem; size = thread->engine->globalBufferSize; }
    else if (region == (modern ? 1u : 0x11u)) { base = thread->code; size = thread->codeSpaceUsed; }
    else if (region == (modern ? 2u : 0x10u)) { base = thread->localMem; size = thread->localMemSize; }
    else if (!modern && region >= 0x40 && region <= 0x9f) {
        unsigned slot = (region >> 1) - 32;
        base = thread->engine->auxMemory[slot]; size = thread->engine->auxMemorySizes[slot];
    }
    else if (modern && region >= 16) {
        MLBGI_Allocation *entry = allocation(runtime(thread->engine), address, &offset);
        if (entry) { base = entry->bytes; size = entry->size; }
    }
    /* Object/structure pointers require a separate semantic contract. */
    if (!base || offset >= size) { fault(thread, "Unmapped or out-of-bounds VM address"); return NULL; }
    return base + offset;
}
uint32_t MLBGI_ReadInteger(Thread_t *thread, const uint8_t *pointer, uint8_t width) {
    if (width > 2 || !pointer || MLBGI_MemoryRemaining(thread->engine, pointer) < (size_t)(1u << width)) { fault(thread, "Integer read exceeds VM memory"); return 0; }
    if (!width) return (uint32_t)(int32_t)(int8_t)pointer[0];
    uint32_t value = (uint32_t)pointer[0] | ((uint32_t)pointer[1] << 8);
    if (width == 1) return (uint32_t)(int32_t)(int16_t)value;
    return value | ((uint32_t)pointer[2] << 16) | ((uint32_t)pointer[3] << 24);
}
uint32_t MLBGI_WriteInteger(Thread_t *thread, uint8_t *pointer, uint8_t width, uint32_t value) {
    if (width > 2 || !pointer || MLBGI_MemoryRemaining(thread->engine, pointer) < (size_t)(1u << width)) return fault(thread, "Integer write exceeds VM memory");
    for (unsigned i = 0; i < (1u << width); i++) pointer[i] = (uint8_t)(value >> (8 * i));
    return 0;
}
const char *MLBGI_ReadString(Thread_t *thread, uint32_t address, size_t maximumBytes) {
    uint8_t *pointer = MLBGI_ResolveAddress(thread, address);
    size_t remaining = pointer ? MLBGI_MemoryRemaining(thread->engine, pointer) : 0;
    if (remaining > maximumBytes) remaining = maximumBytes;
    if (!pointer || !remaining || !memchr(pointer, 0, remaining)) { fault(thread, "String exceeds VM memory or its supported bound"); return NULL; }
    return (const char *)pointer;
}
uint32_t MLBGI_WriteString(Thread_t *thread, uint32_t address, const char *value) {
    uint8_t *pointer = MLBGI_ResolveAddress(thread, address);
    size_t length = strlen(value) + 1;
    if (!pointer || MLBGI_MemoryRemaining(thread->engine, pointer) < length) return fault(thread, "String write exceeds VM memory");
    memmove(pointer, value, length); return 0;
}
uint32_t MLBGI_Milliseconds(void) {
    struct timespec now = {0};
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
    return (uint32_t)((uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000);
}
int MLBGI_WindowCloseAllowed(const Engine_t *engine) {
    MLBGI_Runtime *state = runtime(engine);
    return !state || state->dialect != MLBGI_ETHORNELL_172 || !state->closeDisabled;
}
int MLBGI_ShouldRender(const Engine_t *engine, int focused) {
    MLBGI_Runtime *state = runtime(engine);
    return !state || state->dialect != MLBGI_ETHORNELL_172 || !state->renderRequiresFocus || focused;
}
int MLBGI_DisplayHotkey(const Engine_t *engine, uint32_t key) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || !state->displayHotkeysEnabled || !key) return 0;
    for (unsigned i = 0; i < 16 && state->displayHotkeys[i]; i++) if (state->displayHotkeys[i] == key) return 1;
    return 0;
}
int MLBGI_UpdateCursor(Engine_t *engine, int focused, int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t milliseconds) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return 1;
    state->windowFocused = focused != 0;
    int moved = x != state->cursorX || y != state->cursorY;
    state->cursorX = x; state->cursorY = y;
    if (!state->cursorDelayEnabled) return state->cursorVisible;
    if (!focused || moved || x < 0 || y < 0 || (uint32_t)x >= width || (uint32_t)y >= height) {
        state->cursorVisible = 1;
        state->cursorDeadline = milliseconds + state->cursorDelay;
    } else if (state->cursorDeadline <= milliseconds) state->cursorVisible = 0;
    return state->cursorVisible;
}
int MLBGI_ShouldExecute(const Engine_t *engine, int focused) {
    MLBGI_Runtime *state = runtime(engine);
    return !state || state->dialect != MLBGI_ETHORNELL_172 || focused || state->backgroundPolicy != 0;
}
int MLBGI_FrameDue(const Engine_t *engine, uint32_t milliseconds) {
    MLBGI_Runtime *state = runtime(engine);
    return state && state->dialect == MLBGI_ETHORNELL_172 && state->framePending &&
        (uint32_t)(milliseconds - state->lastFrameMilliseconds) >= state->frameMilliseconds;
}
int MLBGI_SkipWait(Engine_t *engine, int held, uint32_t milliseconds) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return held != 0;
    if (!state->skipInterval) {
        if (!held) state->skipDeadline = 0;
        return held != 0;
    }
    if (!state->skipDeadline) state->skipDeadline = milliseconds + state->skipInterval;
    else if (!held && state->skipDeadline <= milliseconds) { state->skipDeadline = 0; return 0; }
    return 1;
}
void MLBGI_FramePresented(Engine_t *engine, uint32_t milliseconds) {
    MLBGI_Runtime *state = runtime(engine);
    if (state) {
        state->framePending = 0; state->frameFlags = 0; state->lastFrameMilliseconds = milliseconds;
        if (state->presentedFrames != UINT64_MAX) state->presentedFrames++;
    }
}
int MLBGI_AccountBitmap(Engine_t *engine, size_t oldBytes, size_t newBytes) {
    MLBGI_Runtime *state = runtime(engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return 1;
    if (oldBytes > state->imageCacheBytes || newBytes > 32 * 1024 * 1024) return 0;
    size_t used = state->imageCacheBytes - oldBytes + newBytes;
    size_t limit = state->imageCacheLimit ? state->imageCacheLimit : 256 * 1024 * 1024;
    if (used > limit || used > 512 * 1024 * 1024) return 0;
    state->imageCacheBytes = (uint32_t)used; return 1;
}
static int pop(Thread_t *thread, uint32_t *value) {
    if (thread->error || !thread->stack || !thread->stackSize || thread->stackPointer >= thread->stackSize) {
        fault(thread, "System service operand cursor exceeds its memory"); return 0;
    }
    *value = Thread_PopStack(thread); return !thread->error;
}
static int physicalMemory(uint32_t *totalOut, uint32_t *availableOut) {
    uint64_t total = 0, available = 0;
#ifdef __APPLE__
    size_t size = sizeof(total);
    if (sysctlbyname("hw.memsize", &total, &size, NULL, 0) || size != sizeof(total)) return 0;
    host_t host = mach_host_self(); vm_size_t pageSize = 0;
    vm_statistics64_data_t pages = {0}; mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    kern_return_t result = host_page_size(host, &pageSize);
    if (result == KERN_SUCCESS) result = host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&pages, &count);
    mach_port_deallocate(mach_task_self(), host);
    if (result != KERN_SUCCESS || !pageSize) return 0;
    available = ((uint64_t)pages.free_count + pages.inactive_count + pages.speculative_count) * pageSize;
#elif defined(_SC_PHYS_PAGES) && defined(_SC_AVPHYS_PAGES)
    long pageSize = sysconf(_SC_PAGESIZE), totalPages = sysconf(_SC_PHYS_PAGES), availablePages = sysconf(_SC_AVPHYS_PAGES);
    if (pageSize <= 0 || totalPages <= 0 || availablePages < 0) return 0;
    total = (uint64_t)pageSize * totalPages; available = (uint64_t)pageSize * availablePages;
#else
    return 0;
#endif
    if (available > total) available = total;
    *totalOut = total > INT32_MAX ? INT32_MAX : (uint32_t)total;
    *availableOut = available > INT32_MAX ? INT32_MAX : (uint32_t)available;
    return *totalOut != 0;
}
static uint32_t skipRequested(Thread_t *thread, MLBGI_Runtime *state) {
    const uint32_t *keys = state->input.maps[24];
    uint32_t requested = state->skipOverride;
    int held = 0;
    if (state->windowFocused && state->skipKeysEnabled) for (unsigned i = 0; i < 16 && keys[i]; i++) {
        if (keys[i] > 255) { fault(thread, "Skip input contains an unsupported key"); return 0; }
        int down = state->input.held[keys[i]] != 0;
        held |= down;
        if (state->skipLatch) { if (MLBGI_ConsumeKey(&state->input, keys[i])) requested = 1; }
        else if (down) requested = 1;
    }
    if (state->skipLatch && !held) state->skipLatch = 0;
    return state->skipOutputEnabled && requested;
}
static int keyboardEligible(const MLBGI_Runtime *state, uint32_t priority) {
    return state->skipKeysEnabled && (!state->keyboardRouteCount || priority >= state->keyboardRoutes[0]);
}
static int mouseEligible(const MLBGI_Runtime *state, uint32_t priority) {
    if (!state->skipKeysEnabled) return 0;
    for (unsigned i = 0; i < state->mouseRouteCount; i++) {
        const MLBGI_InputRoute *route = &state->mouseRoutes[i];
        if (route->priority < priority) return 0;
        if (state->cursorX < route->bounds[0] || state->cursorY < route->bounds[1] ||
            state->cursorX > route->bounds[2] || state->cursorY > route->bounds[3]) continue;
        return route->priority == priority;
    }
    return 0;
}
static uint32_t pollRoutedInput(Thread_t *thread, MLBGI_Runtime *state, uint32_t priority) {
    static const uint32_t keyboardActions[19] = {
        64, 128, 256, 512, 4096, 8192, 16384, 32768, 65536, 131072,
        262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216, 33554432, 0x40000000
    };
    uint32_t selected = 0;
    if (keyboardEligible(state, priority)) {
        for (unsigned i = 0; i < 19; i++) for (unsigned j = 0; j < 16 && state->input.maps[i + 5][j]; j++) {
            uint32_t key = state->input.maps[i + 5][j];
            if (key > 255) { fault(thread, "Input action contains an unsupported key"); return 0; }
            /* The original stops at the first consumed key for each action. */
            if (MLBGI_ConsumeKey(&state->input, key)) { selected |= keyboardActions[i]; break; }
        }
        if (skipRequested(thread, state)) selected |= 0x80000000;
    }
    if (mouseEligible(state, priority)) {
        static const uint32_t keys[5] = {1, 2, 4, 5, 6}, actions[5] = {1, 2, 4, 16, 32};
        for (unsigned i = 0; i < 5; i++) if (MLBGI_ConsumeKey(&state->input, keys[i])) selected |= actions[i];
    }
    return selected;
}
static int readMenuWords(Thread_t *thread, uint32_t address, uint32_t *values, unsigned count) {
    uint8_t *input = MLBGI_ResolveAddress(thread, address);
    if (!input || count > 16384 || MLBGI_MemoryRemaining(thread->engine, input) < (size_t)count * 4) {
        fault(thread, "Image-menu descriptor exceeds VM memory"); return 0;
    }
    for (unsigned i = 0; i < count; i++) values[i] = MLBGI_ReadInteger(thread, input + i * 4, 2);
    return !thread->error;
}
static int menuImage(Thread_t *thread, MLBGI_Menu *menu, uint32_t slot, uint32_t *index) {
    *index = UINT32_MAX;
    if (slot == UINT32_MAX) return 1;
    if (slot >= 16384) { fault(thread, "Image-menu bitmap slot exceeds its supported bound"); return 0; }
    for (unsigned i = 0; i < menu->imageCount; i++) if (menu->imageSlots[i] == slot) { *index = i; return 1; }
    MLBGI_Runtime *state = thread->engine->mlRuntime;
    MLBGI_MenuImage image = {0};
    int found = state->copyMenuImage ? state->copyMenuImage(thread->engine, slot, &image) : -1;
    if (!found) return 1;
    size_t bytes = (size_t)image.width * image.height * 4;
    if (found < 0 || !image.pixels || !image.width || !image.height || image.width > 8192 || image.height > 8192 ||
        (uint64_t)image.width * image.height > 8 * 1024 * 1024 || (image.format != 1 && image.format != 2) ||
        menu->imageCount >= 1024 || bytes > 32u * 1024 * 1024 - menu->bytes) {
        free(image.pixels); fault(thread, "Image-menu bitmap requires a supported bounded snapshot"); return 0;
    }
    *index = menu->imageCount;
    menu->imageSlots[menu->imageCount] = slot; menu->images[menu->imageCount++] = image; menu->bytes += bytes;
    return 1;
}
static int configureImageMenu(Thread_t *thread, MLBGI_Controller *controller, uint32_t address) {
    MLBGI_Menu *menu = calloc(1, sizeof(*menu));
    if (!menu) { fault(thread, "Image-menu allocation failed"); return 0; }
    int okay = readMenuWords(thread, address, menu->header, 10);
    uint32_t groupCount = menu->header[0];
    if (okay && (!groupCount || groupCount > 256 ||
        (menu->header[2] != UINT32_MAX && menu->header[2] >= groupCount) ||
        menu->header[3] || menu->header[4] || menu->header[5] > 2 || menu->header[6] || menu->header[8] || menu->header[9])) {
        fault(thread, "Image-menu grouping, modal routing or extra controls are not supported"); okay = 0;
    }
    if (okay) {
        menu->groups = calloc(groupCount, sizeof(*menu->groups));
        menu->items = calloc(256, sizeof(*menu->items));
        menu->images = calloc(1024, sizeof(*menu->images));
        menu->imageSlots = calloc(1024, sizeof(*menu->imageSlots));
        if (!menu->groups || !menu->items || !menu->images || !menu->imageSlots) {
            fault(thread, "Image-menu storage allocation failed"); okay = 0;
        }
    }
    if (okay) okay = readMenuWords(thread, menu->header[1], &menu->groups[0][0], groupCount * 16);
    for (unsigned group = 0; group < groupCount && okay; group++) {
        uint32_t *fields = menu->groups[group], count = fields[0];
        if (!count || count > 256 - menu->itemCount || fields[1] > 256 ||
            (fields[3] != UINT32_MAX && fields[3] >= count) || fields[4] || fields[5] || fields[6] || fields[7] ||
            fields[8] != UINT32_MAX || fields[9] || fields[10] || fields[11] != UINT32_MAX ||
            fields[12] || fields[13] || fields[14] != UINT32_MAX || fields[15]) {
            fault(thread, "Image-menu items, navigation or extra group effects are not supported"); okay = 0; break;
        }
        uint8_t *items = MLBGI_ResolveAddress(thread, fields[2]);
        if (!items || MLBGI_MemoryRemaining(thread->engine, items) < (size_t)count * 196) {
            fault(thread, "Image-menu item table exceeds VM memory"); okay = 0; break;
        }
        for (unsigned j = 0; j < count && okay; j++) {
            MLBGI_MenuItem *item = &menu->items[menu->itemCount++];
            item->group = group; item->index = j;
            for (unsigned k = 0; k < 49; k++) item->values[k] = MLBGI_ReadInteger(thread, items + (size_t)j * 196 + k * 4, 2);
            uint32_t *value = item->values;
            if (value[0] > 1 || value[1] > 1 || value[4] || value[5] || value[6] != 1 || value[7] ||
                value[11] != UINT32_MAX || value[44] != UINT32_MAX || value[47] != UINT32_MAX || value[48]) {
                fault(thread, "Image-menu item layout or extra controls are not supported"); okay = 0; break;
            }
            for (unsigned k = 13; k < 44; k++) if (value[k]) {
                fault(thread, "Image-menu item transforms, text or additional effects are not supported"); okay = 0; break;
            }
            if (value[45] || value[46]) { fault(thread, "Image-menu item sound effects are not supported"); okay = 0; }
            for (unsigned k = 0; k < 4 && okay; k++) okay = menuImage(thread, menu, value[k == 3 ? 12 : 8 + k], &item->images[k]);
        }
    }
    size_t previousBytes = controller->menu ? controller->menu->bytes : 0;
    if (okay && !MLBGI_AccountBitmap(thread->engine, previousBytes, menu->bytes)) {
        fault(thread, "Image-menu snapshots exceed the image memory budget"); okay = 0;
    }
    if (!okay) { discardMenu(menu); return 0; }
    discardMenu(controller->menu); controller->menu = menu;
    return 1;
}
static void addInputRoute(MLBGI_Runtime *state, uint32_t priority) {
    unsigned position = 0;
    while (position < state->keyboardRouteCount && state->keyboardRoutes[position] > priority) position++;
    memmove(state->keyboardRoutes + position + 1, state->keyboardRoutes + position,
            (state->keyboardRouteCount - position) * sizeof(*state->keyboardRoutes));
    state->keyboardRoutes[position] = priority; state->keyboardRouteCount++;
    position = 0;
    while (position < state->mouseRouteCount && state->mouseRoutes[position].priority > priority) position++;
    memmove(state->mouseRoutes + position + 1, state->mouseRoutes + position,
            (state->mouseRouteCount - position) * sizeof(*state->mouseRoutes));
    state->mouseRoutes[position] = (MLBGI_InputRoute){priority, {INT32_MIN, INT32_MIN, INT32_MAX, INT32_MAX}};
    state->mouseRouteCount++;
}
static void removeInputRoute(MLBGI_Runtime *state, uint32_t priority) {
    for (unsigned i = 0; i < state->keyboardRouteCount; i++) if (state->keyboardRoutes[i] == priority) {
        memmove(state->keyboardRoutes + i, state->keyboardRoutes + i + 1,
                (--state->keyboardRouteCount - i) * sizeof(*state->keyboardRoutes)); break;
    }
    for (unsigned i = 0; i < state->mouseRouteCount; i++) if (state->mouseRoutes[i].priority == priority) {
        memmove(state->mouseRoutes + i, state->mouseRoutes + i + 1,
                (--state->mouseRouteCount - i) * sizeof(*state->mouseRoutes)); break;
    }
}
int MLBGI_TryService(Thread_t *thread, uint8_t group, uint8_t service, uint32_t *result) {
    MLBGI_Runtime *state = runtime(thread->engine);
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return 0;
    uint32_t a, b, c;
    *result = 0;
    if (group == 0x80 && service == 0x08) {
        Thread_PushStack(thread, (uint32_t)state->cursorX);
        Thread_PushStack(thread, (uint32_t)state->cursorY); return 1;
    }
    if (group == 0x80 && service == 0x11) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a > 255 || a == 7) { *result = fault(thread, "Physical key query requires a supported key; movie-state key7 is separate"); return 1; }
        Thread_PushStack(thread, state->windowFocused && state->input.held[a]); return 1;
    }
    if (group == 0x90 && service == 0x20) {
        uint32_t values[6];
        for (int i = 5; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        uint32_t *opacity = objectOpacity(state, values[0]);
        if (!opacity || *opacity > 256 || values[1] > 256 || values[2] > INT32_MAX ||
            !values[3] || values[3] > 1000 || values[4] || values[5] || thread->mlWaitActive || thread->mlWaitOutputPending) {
            *result = fault(thread, "Timed opacity requires an existing target, bounded timing and supported input options"); return 1;
        }
        MLBGI_Transition *transition = NULL;
        for (unsigned i = 0; i < 64; i++) if (!state->transitions[i].thread) { transition = &state->transitions[i]; break; }
        if (!transition) { *result = fault(thread, "Timed opacity contexts exceed their supported bound"); return 1; }
        uint32_t milliseconds = MLBGI_Milliseconds(), duration = values[2] ? values[2] : 1;
        *transition = (MLBGI_Transition){thread, values[0], milliseconds, duration, *opacity, values[1], state->presentedFrames};
        setObjectVisible(state, values[0], 1);
        thread->mlWaitActive = 1; thread->mlWaitDeadline = milliseconds + duration;
        state->framePending = 1; *result = 2; return 1;
    }
    if (group == 0x80 && (service == 0x20 || service == 0x21)) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x20) {
            b = MLBGI_AllocateMemory(thread->engine, a);
            if (!b) { *result = fault(thread, "Invalid, excessive or exhausted dynamic memory allocation"); return 1; }
            Thread_PushStack(thread, b);
        } else {
            if (!MLBGI_FreeMemory(thread->engine, a)) { *result = fault(thread, "Dynamic memory release requires a live allocation base"); return 1; }
            /* The original result reports removal from optional debug
               allocation tracking, which is disabled at normal startup. */
            Thread_PushStack(thread, 0);
        }
        return 1;
    }
    if (group == 0x80 && service == 0x25) {
        uint32_t arguments[5];
        for (unsigned i = 5; i; i--) if (!pop(thread, &arguments[i - 1])) { *result = UINT32_MAX - 3; return 1; }
        if (arguments[3] || state->files.sourceFd < 0) { *result = fault(thread, "Recursive or unconfigured filename search is not implemented"); return 1; }
        const char *pattern = MLBGI_ReadString(thread, arguments[2], 257);
        uint8_t *output = arguments[0] ? MLBGI_ResolveAddress(thread, arguments[0]) : NULL;
        if (!pattern || (arguments[0] && (!output || arguments[1] > MLBGI_MemoryRemaining(thread->engine, output)))) {
            *result = fault(thread, "Filename search output exceeds VM memory"); return 1;
        }
        size_t written = 0;
        int count = MLBGI_FindFiles(&state->files, pattern, arguments[4], output, arguments[1], &written);
        Thread_PushStack(thread, count < 0 ? UINT32_MAX : output ? (uint32_t)count : (uint32_t)written);
        return 1;
    }
    if (group == 0x80 && service == 0x38) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *alias = MLBGI_ReadString(thread, a, 97), *names[128];
        uint8_t *list = MLBGI_ResolveAddress(thread, b);
        size_t remaining = list ? MLBGI_MemoryRemaining(thread->engine, list) : 0;
        unsigned count = 0; int terminated = 0;
        if (!alias || !list) { *result = fault(thread, "Archive registration requires an alias and bounded filename pointers"); return 1; }
        for (unsigned i = 0; i <= 128; i++) {
            if (remaining < (size_t)(i + 1) * 4) break;
            uint32_t address = MLBGI_ReadInteger(thread, list + i * 4, 2);
            if (!address) { terminated = 1; break; }
            if (i == 128 || !(names[i] = MLBGI_ReadString(thread, address, 97))) break;
            count++;
        }
        if (!terminated || thread->error) { *result = fault(thread, "Archive filename pointer list is invalid or unterminated"); return 1; }
        Thread_PushStack(thread, MLBGI_RegisterArchiveGroup(thread->engine, alias, names, count)); return 1;
    }
    if (group == 0x80 && service == 0x44) {
        uint32_t arguments[5];
        for (unsigned i = 5; i; i--) if (!pop(thread, &arguments[i - 1])) { *result = UINT32_MAX - 3; return 1; }
        const char *filename = MLBGI_ReadString(thread, arguments[1], 97);
        const char *archive = arguments[0] ? MLBGI_ReadString(thread, arguments[0], 97) : NULL;
        if (!filename || (arguments[0] && !archive) || !state->createThread) { *result = fault(thread, "Program thread creation requires a native scheduler"); return 1; }
        uint32_t id = state->createThread(thread, archive, filename, arguments[2], arguments[3], arguments[4]);
        if (!id) { *result = fault(thread, "Program thread resource, buffer sizes or capacity are invalid"); return 1; }
        Thread_PushStack(thread, id); return 1;
    }
    if (group == 0x80 && service == 0x47) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        Thread_PushStack(thread, messageThread(thread->engine, a) != NULL); return 1;
    }
    if (group == 0x80 && service == 0x48) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        Thread_t *recipient = messageThread(thread->engine, a);
        if (!recipient || recipient->mlMessageCount >= 1024) {
            *result = fault(thread, "Thread message requires an existing recipient and available queue capacity"); return 1;
        }
        recipient->mlMessages[(recipient->mlMessageHead + recipient->mlMessageCount++) % 1024] = b;
        return 1;
    }
    if (group == 0x80 && service == 0x49) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 4) {
            *result = fault(thread, "Thread message output exceeds its VM memory"); return 1;
        }
        if (!thread->mlMessageCount) { Thread_PushStack(thread, 0); return 1; }
        MLBGI_WriteInteger(thread, output, 2, thread->mlMessages[thread->mlMessageHead]);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        thread->mlMessageHead = (thread->mlMessageHead + 1) % 1024; thread->mlMessageCount--;
        Thread_PushStack(thread, 1); return 1;
    }
    if (group == 0x80 && service == 0x4a) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        Thread_t *recipient = messageThread(thread->engine, a);
        uint8_t *input = MLBGI_ResolveAddress(thread, c);
        if (!recipient || !b || b > 1024 || !input || (size_t)b * 4 > MLBGI_MemoryRemaining(thread->engine, input) ||
            recipient->mlMessageCount > 1024 || b > 1024 - recipient->mlMessageCount) {
            *result = fault(thread, "Thread message batch requires a bounded source and recipient queue capacity"); return 1;
        }
        uint32_t values[1024];
        for (uint32_t i = 0; i < b; i++) values[i] = MLBGI_ReadInteger(thread, input + (size_t)i * 4, 2);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        for (uint32_t i = 0; i < b; i++) recipient->mlMessages[(recipient->mlMessageHead + recipient->mlMessageCount++) % 1024] = values[i];
        return 1;
    }
    if (group == 0x80 && service == 0x4b) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, b);
        if (!a || a > 1024 || !output || (size_t)a * 4 > MLBGI_MemoryRemaining(thread->engine, output) || thread->mlMessageCount > 1024) {
            *result = fault(thread, "Thread message batch output requires a bounded writable VM buffer"); return 1;
        }
        uint32_t count = a < thread->mlMessageCount ? a : thread->mlMessageCount;
        for (uint32_t i = 0; i < count; i++) MLBGI_WriteInteger(thread, output + (size_t)i * 4, 2, thread->mlMessages[(thread->mlMessageHead + i) % 1024]);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        thread->mlMessageHead = (thread->mlMessageHead + count) % 1024; thread->mlMessageCount -= count;
        Thread_PushStack(thread, count); return 1;
    }
    if (group == 0x80 && (service == 0x00 || service == 0x58 || service == 0x68)) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x00) state->randomState = a;
        else if (service == 0x58) thread->unknownTimestamp = MLBGI_Milliseconds() + a;
        else state->closeDisabled = a;
        return 1;
    }
    if (group == 0x80 && service == 0x04) { Thread_PushStack(thread, MLBGI_Milliseconds()); return 1; }
    if (group == 0x80 && service == 0x59) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        thread->unknownTimestamp += a;
        Thread_PushStack(thread, (int32_t)(thread->unknownTimestamp - MLBGI_Milliseconds()) > 0);
        return 1;
    }
    if (group == 0x80 && service == 0x5a) {
        int waiting = (int32_t)(thread->unknownTimestamp - MLBGI_Milliseconds()) > 0;
        thread->mlWaitActive = waiting; thread->mlWaitDeadline = thread->unknownTimestamp;
        Thread_PushStack(thread, waiting); *result = 2; return 1;
    }
    if (group == 0x80 && service == 0x5c) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a > INT32_MAX || (b && c) || thread->mlWaitOutputPending) {
            *result = fault(thread, "Timed input wait requires a bounded duration and the default input context"); return 1;
        }
        thread->mlWaitActive = 1; thread->mlWaitOutputPending = 1;
        thread->mlWaitDeadline = MLBGI_Milliseconds() + a; thread->mlWaitInputEnabled = b != 0;
        if (b) memcpy(thread->mlWaitInputBaseline, state->input.events, sizeof(thread->mlWaitInputBaseline));
        *result = 2; return 1;
    }
    /* The 1.72 yield service has no operands and no stack result. Its
       interpreter result asks the scheduler to run another ready thread. */
    if (group == 0x80 && service == 0x5f) { *result = 1; return 1; }
    if (group == 0x80 && service == 0xa0) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 12) {
            *result = fault(thread, "Message output exceeds VM memory"); return 1;
        }
        /* An empty queue does not modify the caller's three-word buffer. */
        if (!state->messageCount) { Thread_PushStack(thread, 0); return 1; }
        const uint32_t *message = state->messages[state->messageHead];
        for (unsigned i = 0; i < 3; i++) MLBGI_WriteInteger(thread, output + i * 4, 2, message[i]);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        state->messageHead = (state->messageHead + 1) % MLBGI_MESSAGE_CAPACITY; state->messageCount--;
        Thread_PushStack(thread, 1); return 1;
    }
    if (group == 0x80 && service == 0xa1) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!MLBGI_PostMessage(thread->engine, 0, a, b)) *result = fault(thread, "Message queue capacity exceeded");
        return 1;
    }
    /* Grp0 DD exchanges the wheel-navigation policy. The original window
       handler consults it before changing a registered graphic object. */
    if (group == 0x90 && service == 0xdd) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        b = state->wheelObjectNavigation; state->wheelObjectNavigation = a;
        Thread_PushStack(thread, b); return 1;
    }
    if (group == 0x90 && service == 0x09) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a >= 65536) { *result = fault(thread, "Graphic draw-order group exceeds its supported range"); return 1; }
        state->drawOrderBase = a << 16; state->drawOrderDirty = 1; return 1;
    }
    if (group == 0x90 && service == 0x05) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a >= 16384 || b >= 65536 || !state->captureScene || !state->captureScene(thread->engine, a, b))
            *result = fault(thread, "Scene capture requires a supported bitmap slot, draw order and pixel state");
        return 1;
    }
    if (group == 0x90 && (service == 0x30 || service == 0x32 || service == 0x34 || service == 0x35)) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!(service == 0x30 ? setObjectVisible(state, a, b) : service == 0x32 ? setObjectOpacity(state, a, b) :
            setObjectOpacityFactor(state, a, b, service == 0x34)))
            *result = fault(thread, "Graphic object property requires an existing object and a valid value");
        return 1;
    }
    if (group == 0x90 && service == 0x33) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!setObjectPosition(state, a, (int32_t)b, (int32_t)c))
            *result = fault(thread, "Graphic object position requires an existing object");
        return 1;
    }
    if (group == 0x90 && service == 0x37) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!setObjectOffset(state, a, (int32_t)b, (int32_t)c))
            *result = fault(thread, "Graphic offset requires an existing object or the display root");
        return 1;
    }
    if (group == 0x90 && service == 0x38) {
        uint32_t values[4];
        for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_ObjectData *data = objectData(state, values[0]);
        if (!data) { *result = fault(thread, "Graphic data requires an existing object or the display root"); return 1; }
        /* The native object dispatch recognizes an opaque data word and
           sixteen application slots. Other property tags need their own
           pixel/state contract; none are treated as a successful default. */
        if (values[1] == 0x7fff0000) data->value = values[2];
        else if (values[1] == 0x7fffffff && values[2] < 16) data->slots[values[2]] = values[3];
        else { *result = fault(thread, "Unsupported graphic property tag or application slot"); return 1; }
        return 1;
    }
    if (group == 0x90 && service == 0x9b) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        state->textTiming[0] = (int32_t)a; state->textTiming[1] = (int32_t)b; return 1;
    }
    if (group == 0x90 && service == 0x60) {
        unsigned slot = 0;
        while (slot < 8 && state->filters[slot].allocated) slot++;
        if (slot == 8) { *result = fault(thread, "Filter object capacity exhausted"); return 1; }
        if (state->drawSequence == UINT64_MAX) { *result = fault(thread, "Graphic object registration sequence exhausted"); return 1; }
        state->filters[slot] = (MLBGI_Filter){ .allocated = 1, .opacityScale = 256, .drawSequence = ++state->drawSequence };
        state->filterCount++;
        Thread_PushStack(thread, 0x90000000 | slot); return 1;
    }
    if (group == 0x90 && service == 0x50) {
        unsigned slot = 0;
        while (slot < 512 && state->sprites[slot].object.allocated) slot++;
        if (slot == 512 || state->drawSequence == UINT64_MAX) {
            *result = fault(thread, "Sprite capacity or registration sequence exhausted"); return 1;
        }
        state->sprites[slot] = (MLBGI_Sprite){ .object = { .allocated = 1, .opacityScale = 256, .drawSequence = ++state->drawSequence },
            .bitmapSlot = UINT32_MAX, .blendMode = 128 };
        state->spriteCount++; Thread_PushStack(thread, 0x80000000 | slot); return 1;
    }
    if (group == 0x90 && service == 0x51) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Sprite *sprite = spriteObject(state, a);
        if (!sprite) { *result = fault(thread, "Sprite removal requires an existing object"); return 1; }
        size_t bytes = (size_t)sprite->image.width * sprite->image.height * 4;
        if (!MLBGI_AccountBitmap(thread->engine, bytes, 0)) { *result = fault(thread, "Sprite image memory accounting is invalid"); return 1; }
        detachObject(state, a); free(sprite->image.pixels); memset(sprite, 0, sizeof(*sprite)); state->spriteCount--;
        return 1;
    }
    if (group == 0x90 && service == 0x54) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Sprite *sprite = spriteObject(state, a);
        if (!sprite) { *result = fault(thread, "Sprite visibility requires an existing object"); return 1; }
        sprite->object.visible = b; state->framePending = 1; return 1;
    }
    if (group == 0x90 && service == 0x56) {
        uint32_t values[7];
        for (int i = 6; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Sprite *sprite = spriteObject(state, values[0]);
        if (!sprite || values[3] >= 16384 || values[5] > 256 || values[6] >= 65536 ||
            (values[4] != 0 && values[4] != 1 && values[4] != 128) || !state->copyMenuImage) {
            *result = fault(thread, "Sprite image requires an existing object and supported bitmap, blend, opacity and draw order"); return 1;
        }
        MLBGI_MenuImage image = {0};
        int copied = state->copyMenuImage(thread->engine, values[3], &image);
        if (copied != 1 || !image.pixels || !image.width || !image.height || image.width > 8192 || image.height > 8192 ||
            (uint64_t)image.width * image.height > 8 * 1024 * 1024 || (image.format != 1 && image.format != 2)) {
            free(image.pixels); *result = fault(thread, "Sprite bitmap source is missing or its pixel format is unsupported"); return 1;
        }
        size_t oldBytes = (size_t)sprite->image.width * sprite->image.height * 4, bytes = (size_t)image.width * image.height * 4;
        if (!MLBGI_AccountBitmap(thread->engine, oldBytes, bytes)) {
            free(image.pixels); *result = fault(thread, "Sprite image exceeds its memory budget"); return 1;
        }
        free(sprite->image.pixels); sprite->image = image; sprite->bitmapSlot = values[3];
        sprite->object.x = (int32_t)values[1]; sprite->object.y = (int32_t)values[2];
        sprite->blendMode = values[4]; sprite->object.opacity = values[5]; sprite->object.order = values[6];
        state->framePending = 1; return 1;
    }
    if (group == 0x90 && (service == 0x61 || service == 0x64)) {
        if ((service == 0x64 && !pop(thread, &b)) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Filter *filter = filterObject(state, a);
        if (!filter) { *result = fault(thread, "Filter service requires an existing object handle"); return 1; }
        if (service == 0x64) filter->visible = b;
        else { detachObject(state, a); memset(filter, 0, sizeof(*filter)); state->filterCount--; }
        return 1;
    }
    if (group == 0x90 && service == 0xe0) {
        unsigned slot = 0;
        while (slot < 8 && state->groups[slot].allocated) slot++;
        if (slot == 8) { *result = fault(thread, "Group object capacity exhausted"); return 1; }
        state->groups[slot] = (MLBGI_Group){ .allocated = 1, .opacityScale = 256 }; state->groupCount++;
        Thread_PushStack(thread, 0xf1000000 | slot); return 1;
    }
    if (group == 0x90 && service == 0x80) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a < 32) a *= 32;
        if (b < 20) b *= 32;
        if (!a || !b || a > 8192 || b > 32768 || (uint64_t)a * b > 8 * 1024 * 1024) {
            *result = fault(thread, "Window object dimensions exceed their supported range"); return 1;
        }
        unsigned slot = 0;
        while (slot < 16 && state->windows[slot].allocated) slot++;
        if (state->drawSequence == UINT64_MAX) { *result = fault(thread, "Graphic object registration sequence exhausted"); return 1; }
        size_t bytes = (size_t)a * b * 4;
        if (slot == 16 || !MLBGI_AccountBitmap(thread->engine, 0, bytes)) {
            *result = fault(thread, "Window object capacity or image memory budget exhausted"); return 1;
        }
        uint8_t *pixels = calloc(1, bytes);
        if (!pixels) { MLBGI_AccountBitmap(thread->engine, bytes, 0); *result = fault(thread, "Window object allocation failed"); return 1; }
        state->windows[slot] = (MLBGI_WindowObject){ .allocated = 1, .width = a, .height = b, .blendMode = 128, .opacityScale = 256, .pixels = pixels, .textWidth = a, .textHeight = b, .drawSequence = ++state->drawSequence };
        state->windowCount++; Thread_PushStack(thread, 0xb0000000 | slot); return 1;
    }
    if (group == 0x90 && (service == 0x81 || service == 0x84)) {
        if ((service == 0x84 && !pop(thread, &b)) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_WindowObject *window = windowObject(state, a);
        if (!window) { *result = fault(thread, "Window service requires an existing object handle"); return 1; }
        if (service == 0x84) window->visible = b;
        else {
            for (unsigned i = 0; i < 64; i++) if (state->controllers[i].id && state->controllers[i].target == a) {
                *result = fault(thread, "Window removal requires its active controllers to be released first"); return 1;
            }
            size_t bytes = (size_t)window->width * window->height * 4;
            if (!MLBGI_AccountBitmap(thread->engine, bytes, 0)) { *result = fault(thread, "Window object memory accounting is invalid"); return 1; }
            detachObject(state, a); free(window->pixels); memset(window, 0, sizeof(*window)); state->windowCount--;
        }
        return 1;
    }
    if (group == 0x90 && service == 0x83) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!windowObject(state, b) || a >= 16384 || !state->exportWindowBitmap ||
            !state->exportWindowBitmap(thread->engine, a, b & 0x00ffffff)) {
            *result = fault(thread, "Window bitmap export requires an existing window and a bounded bitmap destination"); return 1;
        }
        return 1;
    }
    if (group == 0x90 && service == 0x86) {
        uint32_t values[4];
        for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        /* The original wrapper consumes two legacy diagnostic operands;
           its window consumer receives only the handle and bitmap ID. */
        if (!windowObject(state, values[0]) || (values[3] != UINT32_MAX && values[3] >= 16384) || !state->windowBitmap ||
            !state->windowBitmap(thread->engine, values[0] & 0x00ffffff, values[3])) {
            *result = fault(thread, "Window bitmap attachment requires an existing object and supported native bitmap"); return 1;
        }
        return 1;
    }
    if (group == 0x90 && service == 0x87) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_WindowObject *window = windowObject(state, a);
        if (!window) { *result = fault(thread, "Window text composition requires an existing object"); return 1; }
        /* The native text layer can erase registered child masks from
           its backdrop before composition. Rendering consumes this flag. */
        window->textBackdropKnockout = b; return 1;
    }
    if (group == 0x90 && service == 0x88) {
        uint32_t values[5];
        for (int i = 4; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_WindowObject *window = windowObject(state, values[0]);
        if (!window || !values[3] || !values[4] || values[1] >= window->width || values[2] >= window->height ||
            values[3] > window->width - values[1] || values[4] > window->height - values[2]) {
            *result = fault(thread, "Window text rectangle must fit inside its native canvas"); return 1;
        }
        window->textX = values[1]; window->textY = values[2]; window->textWidth = values[3]; window->textHeight = values[4];
        window->textCursorX = (int32_t)(window->textX + (window->textDirection ? window->textWidth - 1 : 0));
        window->textCursorY = (int32_t)window->textY;
        return 1;
    }
    if (group == 0x90 && service == 0x85) {
        uint32_t values[7];
        for (int i = 6; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_WindowObject *window = windowObject(state, values[0]);
        if (!window || state->drawSequence == UINT64_MAX || values[4] > 256 || values[5] > 256 || values[6] >= 65536 ||
            (values[3] != 0 && values[3] != 1 && values[3] != 128)) {
            *result = fault(thread, "Window configuration requires an existing object, a supported blend mode, bounded transparency and draw order"); return 1;
        }
        /* The native wrapper validates the second transparency operand,
           but passes only the first one into the object's pixel consumer. */
        window->x = (int32_t)values[1]; window->y = (int32_t)values[2]; window->blendMode = values[3];
        window->opacity = values[4]; window->order = values[6]; window->drawSequence = ++state->drawSequence; return 1;
    }
    if (group == 0x90 && (service == 0xe1 || service == 0xe4)) {
        if ((service == 0xe4 && !pop(thread, &b)) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Group *object = groupObject(state, a);
        if (!object) { *result = fault(thread, "Group service requires an existing object handle"); return 1; }
        if (service == 0xe4) groupVisible(state, object, b);
        else {
            detachObject(state, a);
            while (object->memberCount) detachObject(state, object->members[object->memberCount - 1].handle);
            memset(object, 0, sizeof(*object)); state->groupCount--;
        }
        return 1;
    }
    if (group == 0x90 && (service == 0xe5 || service == 0xe8)) {
        uint32_t values[4];
        for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Group *object = groupObject(state, values[0]);
        if (!object) { *result = fault(thread, "Group configuration requires an existing object handle"); return 1; }
        if (service == 0xe5) {
            if (values[3] > 256) { *result = fault(thread, "Group opacity exceeds its supported bound"); return 1; }
            groupPosition(state, object, (int32_t)values[1], (int32_t)values[2]); groupOpacity(state, object, values[3]);
        } else {
            uint32_t *owner = objectOwner(state, values[1]);
            if (!owner || *owner || object->memberCount >= 1024) {
                *result = fault(thread, "Group member requires an unowned native object and available capacity"); return 1;
            }
            for (uint32_t ancestor = values[0]; ancestor;) {
                if (ancestor == values[1]) { *result = fault(thread, "Group membership cannot contain a cycle"); return 1; }
                uint32_t *parent = objectOwner(state, ancestor); ancestor = parent ? *parent : 0;
            }
            object->members[object->memberCount++] = (MLBGI_GroupMember){ values[1], (int32_t)values[2], (int32_t)values[3] };
            *owner = values[0]; groupPosition(state, object, object->x, object->y);
        }
        return 1;
    }
    if (group == 0x90 && service == 0xe9) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint32_t *owner = objectOwner(state, b);
        if (!groupObject(state, a) || !owner || *owner != a) {
            *result = fault(thread, "Group removal requires a member of the specified native group"); return 1;
        }
        detachObject(state, b); return 1;
    }
    if (group == 0x90 && service == 0x65) {
        uint32_t values[4];
        for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Filter *filter = filterObject(state, values[0]);
        if (!filter || state->drawSequence == UINT64_MAX || values[2] > 256 || values[3] >= 65536) {
            *result = fault(thread, "Color filter requires an existing object, bounded opacity and draw order"); return 1;
        }
        filter->kind = 0; filter->parameter = values[1]; filter->opacity = values[2]; filter->order = values[3]; filter->drawSequence = ++state->drawSequence;
        return 1;
    }
    if (group == 0x80 && service == 0xd0) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 4) {
            *result = fault(thread, "Keyed-container ID output exceeds VM memory"); return 1;
        }
        if (b <= 1) { Thread_PushStack(thread, 0x80000001); return 1; }
        if (b > 32u * 1024 * 1024 || state->lastKeyedContainerId == UINT32_MAX) {
            *result = fault(thread, "Keyed-container record size or ID exceeds its supported bound"); return 1;
        }
        MLBGI_KeyedContainer *container = NULL;
        for (unsigned i = 0; i < 64; i++) if (!state->keyedContainers[i].id) { container = &state->keyedContainers[i]; break; }
        if (!container) { *result = fault(thread, "Keyed-container capacity exceeded"); return 1; }
        *container = (MLBGI_KeyedContainer){ ++state->lastKeyedContainerId, b, 0, NULL };
        MLBGI_WriteInteger(thread, output, 2, container->id); Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0xd1) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_KeyedContainer *container = keyedContainer(state, a);
        if (container) freeKeyedContainer(state, container);
        Thread_PushStack(thread, container ? 0 : 0x80000002); return 1;
    }
    if (group == 0x80 && service == 0xd2) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *input = MLBGI_ResolveAddress(thread, c);
        const char *key = MLBGI_ReadString(thread, b, 4096);
        if (!input || !key) { *result = fault(thread, "Keyed record requires valid VM data and a bounded key"); return 1; }
        MLBGI_KeyedContainer *container = keyedContainer(state, a);
        if (!container) { Thread_PushStack(thread, 0x80000002); return 1; }
        if (MLBGI_MemoryRemaining(thread->engine, input) < container->bytes) {
            *result = fault(thread, "Keyed-record input exceeds VM memory"); return 1;
        }
        MLBGI_KeyedRecord **slot = &container->records;
        while (*slot && strcmp((*slot)->key, key)) slot = &(*slot)->next;
        if (*slot) { memcpy((*slot)->bytes, input, container->bytes); Thread_PushStack(thread, 0); return 1; }
        size_t keyBytes = strlen(key) + 1, bytes = sizeof(**slot) + keyBytes + container->bytes;
        if (container->count >= 65536 || state->keyedBytes > 256u * 1024 * 1024 || bytes > 256u * 1024 * 1024 - state->keyedBytes) {
            *result = fault(thread, "Keyed-record count or memory budget exceeds its supported bound"); return 1;
        }
        MLBGI_KeyedRecord *record = calloc(1, sizeof(*record));
        if (record) { record->key = malloc(keyBytes); record->bytes = malloc(container->bytes); }
        if (!record || !record->key || !record->bytes) {
            if (record) { free(record->key); free(record->bytes); free(record); }
            *result = fault(thread, "Keyed-record allocation failed"); return 1;
        }
        memcpy(record->key, key, keyBytes); memcpy(record->bytes, input, container->bytes);
        *slot = record; container->count++; state->keyedBytes += bytes; Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0xd3) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *key = MLBGI_ReadString(thread, b, 4096);
        if (!key) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_KeyedContainer *container = keyedContainer(state, a);
        if (!container) { Thread_PushStack(thread, 0x80000002); return 1; }
        MLBGI_KeyedRecord **slot = &container->records;
        while (*slot && strcmp((*slot)->key, key)) slot = &(*slot)->next;
        if (!*slot) { Thread_PushStack(thread, 0x80000003); return 1; }
        MLBGI_KeyedRecord *record = *slot; *slot = record->next;
        freeKeyedRecord(state, container, record); Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0xd4) {
        uint32_t values[4];
        for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        const char *key = values[2] ? MLBGI_ReadString(thread, values[2], 4096) : NULL;
        uint8_t *output = MLBGI_ResolveAddress(thread, values[0]);
        if ((values[2] && !key) || !output) { *result = fault(thread, "Keyed-record output requires valid VM memory and a bounded optional key"); return 1; }
        MLBGI_KeyedContainer *container = keyedContainer(state, values[1]);
        if (!container) { Thread_PushStack(thread, 0x80000002); return 1; }
        MLBGI_KeyedRecord *record = container->records;
        if (key) { while (record && strcmp(record->key, key)) record = record->next; }
        else { for (uint32_t index = 0; record && index < values[3]; index++) record = record->next; }
        if (!record) { Thread_PushStack(thread, 0x80000003); return 1; }
        if (MLBGI_MemoryRemaining(thread->engine, output) < container->bytes) {
            *result = fault(thread, "Keyed-record output exceeds VM memory"); return 1;
        }
        memcpy(output, record->bytes, container->bytes); Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0x98) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 4) { *result = fault(thread, "Record-list ID output exceeds VM memory"); return 1; }
        if (!b || !c) { Thread_PushStack(thread, 2); return 1; }
        if (b > 65536 || c > 32u * 1024 * 1024 || state->lastRecordListId == UINT32_MAX) {
            *result = fault(thread, "Record-list size or ID exceeds its supported bound"); return 1;
        }
        MLBGI_RecordList *list = NULL;
        for (unsigned i = 0; i < 64; i++) if (!state->recordLists[i].id) { list = &state->recordLists[i]; break; }
        if (!list) { *result = fault(thread, "Record-list capacity exceeded"); return 1; }
        uint8_t **records = calloc(b, sizeof(*records));
        if (!records) { *result = fault(thread, "Record-list allocation failed"); return 1; }
        *list = (MLBGI_RecordList){ ++state->lastRecordListId, b, c, 0, records };
        MLBGI_WriteInteger(thread, output, 2, list->id); Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0x99) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_RecordList *list = recordList(state, a);
        if (list) freeRecords(state, list);
        Thread_PushStack(thread, list ? 0 : 1); return 1;
    }
    if (group == 0x80 && (service == 0x9a || service == 0x9d)) {
        if ((service == 0x9d && !pop(thread, &c)) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output) { *result = fault(thread, "Record-list output requires valid VM memory"); return 1; }
        MLBGI_RecordList *list = recordList(state, b);
        if (!list) { Thread_PushStack(thread, 1); return 1; }
        if (service == 0x9d && c >= list->count) { Thread_PushStack(thread, 2); return 1; }
        uint32_t bytes = service == 0x9a ? 4 : list->bytes;
        if (MLBGI_MemoryRemaining(thread->engine, output) < bytes) { *result = fault(thread, "Record-list output exceeds VM memory"); return 1; }
        if (service == 0x9a) MLBGI_WriteInteger(thread, output, 2, list->count);
        else memcpy(output, list->records[c], bytes);
        Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0x9c) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *input = MLBGI_ResolveAddress(thread, b);
        if (!input) { *result = fault(thread, "Record-list input requires valid VM memory"); return 1; }
        MLBGI_RecordList *list = recordList(state, a);
        if (!list) { Thread_PushStack(thread, 1); return 1; }
        if (MLBGI_MemoryRemaining(thread->engine, input) < list->bytes || state->recordBytes > 256u * 1024 * 1024 ||
            list->bytes > 256u * 1024 * 1024 - state->recordBytes) {
            *result = fault(thread, "Record-list input or memory budget exceeds its supported bound"); return 1;
        }
        uint8_t *copy = malloc(list->bytes);
        if (!copy) { *result = fault(thread, "Record-list copy allocation failed"); return 1; }
        memcpy(copy, input, list->bytes);
        if (list->count == list->maximum) {
            free(list->records[--list->count]); state->recordBytes -= list->bytes;
        }
        memmove(list->records + 1, list->records, (size_t)list->count * sizeof(*list->records));
        list->records[0] = copy; list->count++; state->recordBytes += list->bytes;
        Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0x9e) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_RecordList *list = recordList(state, a);
        if (!list) { Thread_PushStack(thread, 1); return 1; }
        if (b >= list->count) { Thread_PushStack(thread, 2); return 1; }
        if (c > list->count - b) c = list->count - b;
        for (uint32_t i = 0; i < c; i++) free(list->records[b + i]);
        memmove(list->records + b, list->records + b + c, (size_t)(list->count - b - c) * sizeof(*list->records));
        list->count -= c; state->recordBytes -= (size_t)c * list->bytes;
        Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0x66) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *source = MLBGI_ReadString(thread, a, 1024);
        char caption[sizeof(state->windowCaption)];
        if (!source || !MLBGI_CP932ToUTF8(source, caption, sizeof(caption))) {
            *result = fault(thread, "Window caption requires bounded CP932 text"); return 1;
        }
        memcpy(state->windowCaption, caption, strlen(caption) + 1); state->captionConfigured = 1;
        if (state->setCaption) state->setCaption(thread->engine, state->windowCaption);
        return 1;
    }
    if ((group == 0x90 || group == 0x91) && service == 0xb8) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!windowObject(state, a) || state->lastControllerId == UINT32_MAX || state->controllerCount >= 64) {
            *result = fault(thread, "Controller creation requires an existing window and a bounded independent ID"); return 1;
        }
        MLBGI_Controller *controller = NULL;
        for (unsigned i = 0; i < 64; i++) if (!state->controllers[i].id) { controller = &state->controllers[i]; break; }
        *controller = (MLBGI_Controller){ .id = ++state->lastControllerId, .target = a, .kind = group == 0x91, .enabled = 1 };
        state->controllerCount++; Thread_PushStack(thread, controller->id); return 1;
    }
    if (group == 0x90 && service == 0xb9) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Controller *controller = controllerObject(state, a);
        if (controller) {
            if (controller->menu && !MLBGI_AccountBitmap(thread->engine, controller->menu->bytes, 0)) {
                *result = fault(thread, "Controller image memory accounting is invalid"); return 1;
            }
            discardMenu(controller->menu); memset(controller, 0, sizeof(*controller)); state->controllerCount--;
        }
        Thread_PushStack(thread, controller != NULL); return 1;
    }
    if (group == 0x91 && service == 0xba) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_Controller *controller = controllerObject(state, a);
        if (!controller) { Thread_PushStack(thread, 1); return 1; }
        if (!controller->kind) { Thread_PushStack(thread, 4); return 1; }
        if (!configureImageMenu(thread, controller, b)) { *result = UINT32_MAX - 3; return 1; }
        Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x90 && service == 0xbf) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = MLBGI_ResolveAddress(thread, a);
        if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 12) {
            *result = fault(thread, "Controller event output requires three writable VM words"); return 1;
        }
        MLBGI_Controller *controller = controllerObject(state, b);
        if (!controller) { Thread_PushStack(thread, 0); return 1; }
        /* The native existence status is independent of queue emptiness.
           An existing empty controller writes three zero words. */
        const uint32_t empty[3] = {0};
        const uint32_t *event = controller->eventCount ? controller->events[controller->eventHead] : empty;
        for (unsigned i = 0; i < 3; i++) MLBGI_WriteInteger(thread, output + i * 4, 2, event[i]);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        if (controller->eventCount) { controller->eventHead = (controller->eventHead + 1) % 1024; controller->eventCount--; }
        Thread_PushStack(thread, 1); return 1;
    }
    if (group == 0x91 && service == 0x96) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *rules = a ? MLBGI_ReadString(thread, a, 65536) : NULL;
        if (a && !rules) { *result = UINT32_MAX - 3; return 1; }
        int registered = MLBGI_RegisterTextRules(thread->engine, rules);
        if (registered < 0) { *result = fault(thread, "Text replacement list requires bounded CP932 source and replacement lines"); return 1; }
        Thread_PushStack(thread, (uint32_t)registered); return 1;
    }
    if (group == 0x80 && service >= 0x13 && service <= 0x17) {
        if (service <= 0x15) {
            if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
            if (service == 0x13) { state->skipKeysEnabled = a; MLBGI_ResetInputCounters(&state->input); }
            else if (service == 0x14) state->skipOutputEnabled = a;
            else state->skipOverride = a;
            return 1;
        }
        const uint32_t *keys = state->input.maps[24];
        if (service == 0x16) {
            state->skipLatch = 1;
            for (unsigned i = 0; i < 16 && keys[i]; i++) {
                if (keys[i] > 255) { *result = fault(thread, "Skip input contains an unsupported key"); return 1; }
                MLBGI_ConsumeKey(&state->input, keys[i]);
            }
            return 1;
        }
        uint32_t requested = skipRequested(thread, state);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        Thread_PushStack(thread, requested); return 1;
    }
    if (group == 0x80 && ((service >= 0x18 && service <= 0x1a) || service == 0x1d)) {
        if ((service == 0x1d && !pop(thread, &b)) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        /* This is a layer priority, not a virtual key. The native wrapper
           replaces its low word with 0xffff and discards overflow bits. */
        uint32_t priority = (a << 16) | 0xffff;
        if (service == 0x18) {
            if (state->keyboardRouteCount >= 256 || state->mouseRouteCount >= 256) {
                *result = fault(thread, "Input layers exceed their supported bound"); return 1;
            }
            addInputRoute(state, priority);
        }
        uint32_t selected;
        if (service == 0x1d) {
            if (b > 255) { *result = fault(thread, "Input query contains an unsupported key"); return 1; }
            int eligible = b == 1 || b == 2 ? mouseEligible(state, priority) : keyboardEligible(state, priority);
            selected = eligible ? MLBGI_ConsumeKey(&state->input, b) : 0;
        } else selected = pollRoutedInput(thread, state, priority);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x19) removeInputRoute(state, priority);
        else if (service == 0x1a || service == 0x1d) Thread_PushStack(thread, selected);
        return 1;
    }
    if (group == 0x80 && service == 0xfd) { Thread_PushStack(thread, state->launcherContext != 0); return 1; }
    if (group == 0x80 && (service == 0x30 || service == 0x35)) {
        if (!pop(thread, &b) || !pop(thread, &a) || (service == 0x30 && !pop(thread, &c))) { *result = UINT32_MAX - 3; return 1; }
        const char *filename = MLBGI_ReadString(thread, b, 97), *archive = a ? MLBGI_ReadString(thread, a, 97) : NULL;
        if (!filename || (a && !archive)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *output = service == 0x30 ? MLBGI_ResolveAddress(thread, c) : NULL;
        if (service == 0x30 && (!output || MLBGI_MemoryRemaining(thread->engine, output) < 16)) {
            *result = fault(thread, "Resource-load output requires at least sixteen bytes of VM memory"); return 1;
        }
        int status = resourceStatus(thread->engine, archive, filename);
        if (!status) { if (output) memset(output, 0, 16); Thread_PushStack(thread, 0); return 1; }
        size_t bytes = 0;
        /* The native consumer obtains the decoded resource size, not the
           compressed member's index length. Unknown codecs stay explicit. */
        uint8_t *resource = status > 0 ? MLBGI_ReadEngineResource(thread->engine, archive, filename, &bytes) : NULL;
        if (!resource || bytes > 64u * 1024 * 1024) {
            free(resource); *result = fault(thread, "Resource access requires a supported bounded source resource"); return 1;
        }
        if (output && MLBGI_MemoryRemaining(thread->engine, output) < bytes) {
            free(resource); *result = fault(thread, "Resource-load output exceeds VM memory"); return 1;
        }
        if (output) { memset(output, 0, 16); memcpy(output, resource, bytes); }
        free(resource); Thread_PushStack(thread, (uint32_t)bytes); return 1;
    }
    if (group == 0x80 && service == 0x40) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *filename = MLBGI_ReadString(thread, b, 97), *archive = a ? MLBGI_ReadString(thread, a, 97) : NULL;
        if (!filename || (a && !archive)) { *result = UINT32_MAX - 3; return 1; }
        size_t bytes = 0;
        uint8_t *program = MLBGI_ReadEngineResource(thread->engine, archive, filename, &bytes);
        if (!program) { *result = fault(thread, "Program resource is missing or invalid"); return 1; }
        uint32_t location = MLBGI_LoadCode(thread, program, bytes, filename); free(program);
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
        Thread_PushStack(thread, location); return 1;
    }
    if (group == 0x80 && service == 0x41) {
        Program_t *program = thread->programs;
        if (!program) { Thread_PushStack(thread, 0x80000001); return 1; }
        if (!thread->programCount || program->size > thread->codeSpaceUsed || program->location != thread->codeSpaceUsed - program->size || thread->nextInstructionPointer >= program->location) {
            *result = fault(thread, "Program removal would invalidate the active code frame"); return 1;
        }
        thread->programs = program->previousProgram; thread->codeSpaceUsed -= program->size; thread->programCount--;
        memset(thread->code + program->location, 0, program->size); free(program->filename); free(program);
        Thread_PushStack(thread, thread->programCount); return 1;
    }
    if (group == 0x80 && service == 0x33) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *name = MLBGI_ReadString(thread, b, 257);
        const char *directory = a ? MLBGI_ReadString(thread, a, 257) : NULL;
        if (!name || (a && !directory) || state->files.stateFd < 0) {
            *result = fault(thread, "File deletion requires bounded paths and an isolated native state directory"); return 1;
        }
        char target[257];
        int bytes = directory && *directory ? snprintf(target, sizeof(target), "%s\\%s", directory, name) : snprintf(target, sizeof(target), "%s", name);
        if (bytes < 0 || bytes >= (int)sizeof(target)) { *result = fault(thread, "File deletion path exceeds its supported bound"); return 1; }
        Thread_PushStack(thread, MLBGI_DeleteFile(&state->files, target)); return 1;
    }
    if (group == 0x80 && service == 0x34) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *name = MLBGI_ReadString(thread, b, a ? 97 : 257);
        const char *archive = a ? MLBGI_ReadString(thread, a, 97) : NULL;
        if (!name || (a && !archive)) { *result = UINT32_MAX - 3; return 1; }
        if (!a) {
            if (state->files.stateFd < 0) { *result = fault(thread, "File query requires an isolated native state directory"); return 1; }
            Thread_PushStack(thread, MLBGI_PathStatus(&state->files, name, 0)); return 1;
        }
        int found = resourceStatus(thread->engine, archive, name);
        if (found < 0) { *result = fault(thread, MLBGI_ArchiveError()); return 1; }
        Thread_PushStack(thread, found); return 1;
    }
    if (group == 0x80 && (service == 0x28 || service == 0x2a)) {
        if (!pop(thread, &b)) { *result = UINT32_MAX - 3; return 1; }
        const char *name = MLBGI_ReadString(thread, b, 257);
        if (!name || state->files.stateFd < 0) { *result = fault(thread, "Filesystem services require an isolated native state directory"); return 1; }
        if (service == 0x28) a = MLBGI_CreateDirectory(&state->files, name);
        else a = MLBGI_PathStatus(&state->files, name, service == 0x2a);
        Thread_PushStack(thread, a); return 1;
    }
    if (group == 0x80 && service == 0x3d) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (b > 1 || state->files.stateFd < 0) { *result = fault(thread, "Unsupported or unconfigured filesystem directory"); return 1; }
        if (!b) { *result = MLBGI_WriteString(thread, a, MLBGI_VirtualDirectory()); if (!thread->error) Thread_PushStack(thread, 1); }
        else Thread_PushStack(thread, 0); /* There is no secondary native root. */
        return 1;
    }
    if (group == 0x80 && service == 0xe8) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!state->projectIdentifier[0]) { *result = fault(thread, "Project identifier requires original executable evidence"); return 1; }
        *result = MLBGI_WriteString(thread, a, state->projectIdentifier); return 1;
    }
    if (group == 0x80 && service == 0x80) {
        int status = MLBGI_GlobalDatabaseStatus(&state->files);
        if (status) { *result = fault(thread, status < 0 ? "Global database state is inaccessible" : "Existing global database decoding is not implemented"); return 1; }
        /* A missing database has an explicit original status of one. The
           authored IPL initializes its defaults only after this result. */
        Thread_PushStack(thread, 0); Thread_PushStack(thread, 0); Thread_PushStack(thread, 1); return 1;
    }
    if (group == 0x80 && (service == 0x84 || service == 0x85)) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *text = MLBGI_ReadString(thread, a, 65536);
        if (!text) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x85) Thread_PushStack(thread, persistentStringIndex(state, text, persistentStringHash(text)) >= 0);
        else {
            if (!registerPersistentString(state, text)) { *result = fault(thread, "Persistent string registry exceeds its memory or entry bound"); return 1; }
            Thread_PushStack(thread, 1);
        }
        return 1;
    }
    if (group == 0x80 && service >= 0x88 && service <= 0x8b) {
        uint32_t values[4] = {0};
        unsigned count = service == 0x88 ? 2 : service == 0x8a ? 4 : 3;
        for (int i = (int)count - 1; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        const char *name = MLBGI_ReadString(thread, values[service == 0x8b ? 1 : 0], 4096);
        if (!name) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_FlagGroup *flags = flagGroup(state, name);
        if (service == 0x88) {
            /* The native ceiling calculation is unsigned and returns false
               for zero bytes. Existing groups preserve their old byte bits. */
            uint32_t bytes = (values[1] + 7u) >> 3;
            if (!bytes) { Thread_PushStack(thread, 0); return 1; }
            if (values[1] > 64u * 1024 * 1024) { *result = fault(thread, "Flag-group count exceeds its supported bound"); return 1; }
            if (!flags) for (unsigned i = 0; i < 64; i++) if (!state->flagGroups[i].name) { flags = &state->flagGroups[i]; break; }
            if (!flags) { *result = fault(thread, "Flag-group capacity exceeded"); return 1; }
            size_t nameBytes = flags->name ? 0 : strlen(name) + 1;
            size_t previous = flags->name ? ((size_t)flags->count + 7) >> 3 : 0;
            if (state->flagBytes > 256u * 1024 * 1024 || bytes + nameBytes > 256u * 1024 * 1024 - state->flagBytes + previous) {
                *result = fault(thread, "Flag-group memory budget exceeded"); return 1;
            }
            uint8_t *bits = calloc(1, bytes); char *copy = nameBytes ? malloc(nameBytes) : NULL;
            if (!bits || (nameBytes && !copy)) { free(bits); free(copy); *result = fault(thread, "Flag-group allocation failed"); return 1; }
            if (previous) memcpy(bits, flags->bits, previous < bytes ? previous : bytes);
            if (nameBytes) { memcpy(copy, name, nameBytes); flags->name = copy; }
            free(flags->bits); flags->bits = bits; flags->count = values[1];
            state->flagBytes = state->flagBytes - previous + bytes + nameBytes; Thread_PushStack(thread, 1); return 1;
        }
        uint8_t *output = service == 0x8b ? MLBGI_ResolveAddress(thread, values[0]) : NULL;
        if (service == 0x8b && (!output || MLBGI_MemoryRemaining(thread->engine, output) < 4)) {
            *result = fault(thread, "Flag output exceeds VM memory"); return 1;
        }
        if (!flags) { Thread_PushStack(thread, 1); return 1; }
        uint32_t index = values[service == 0x8b ? 2 : 1];
        if (index >= flags->count) { Thread_PushStack(thread, 2); return 1; }
        if (service == 0x8b) {
            MLBGI_WriteInteger(thread, output, 2, (flags->bits[index >> 3] & (0x80u >> (index & 7))) != 0);
            Thread_PushStack(thread, 0); return 1;
        }
        uint32_t length = service == 0x8a ? values[3] : 1;
        if (!length || length > 65536 || length > flags->count - index) { Thread_PushStack(thread, 3); return 1; }
        for (uint32_t i = index; i < index + length; i++) {
            uint8_t mask = (uint8_t)(0x80u >> (i & 7));
            if (values[2]) flags->bits[i >> 3] |= mask; else flags->bits[i >> 3] &= (uint8_t)~mask;
        }
        Thread_PushStack(thread, 0); return 1;
    }
    if (group == 0x80 && service == 0xaf) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a <= 1) state->actorPolicy = a;
        Thread_PushStack(thread, a <= 1); return 1;
    }
    if (group == 0x80 && (service == 0x36 || service == 0x37)) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x36) state->searchDirectoriesEnabled = a;
        else {
            const char *path = MLBGI_ReadString(thread, a, 257);
            if (!path || !MLBGI_ValidSearchPath(path) || state->searchPathCount >= 64) { *result = fault(thread, "Invalid or excessive resource search directories"); return 1; }
            size_t bytes = strlen(path) + 1; char *copy = malloc(bytes);
            if (!copy) { *result = fault(thread, "Resource search directory allocation failed"); return 1; }
            memcpy(copy, path, bytes); state->searchPaths[state->searchPathCount++] = copy;
        }
        return 1;
    }
    if (group == 0x80 && service == 0x70) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a > 12) { Thread_PushStack(thread, 0); return 1; }
        size_t bytes = (size_t)4096 << a;
        uint8_t *replacement = calloc(1, bytes);
        if (!replacement) { Thread_PushStack(thread, 0); return 1; }
        free(thread->engine->globalMem);
        thread->engine->globalMem = replacement; thread->engine->globalBufferSize = (uint32_t)bytes;
        Thread_PushStack(thread, 1); return 1;
    }
    if (group == 0x80 && (service == 0x67 || service == 0x74)) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (service == 0x67) {
            /* Zero removes the original message-loop response delay. Other
               delay modes require their platform scheduling contract. */
            if (a) { *result = fault(thread, "Nonzero response-delay modes are not implemented"); return 1; }
            state->responseDelay = a;
        } else state->saveCryptPolicy = a;
        return 1;
    }
    if (group == 0x80 && service == 0x52) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        state->backgroundPolicy = a; state->startupServices++; return 1;
    }
    if (group == 0x80 && service == 0x60) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a >= 8 || b >= 2) { *result = fault(thread, "Invalid display request"); return 1; }
        uint32_t width = !state->clientWidth || state->automaticClientSize ? state->displayWidths[a] : state->clientWidth;
        uint32_t height = !state->clientHeight || state->automaticClientSize ? state->displayHeights[a] : state->clientHeight;
        if (state->configureWindow && (c || !state->configureWindow(thread->engine, b, width, height))) {
            *result = fault(thread, c ? "Additional native display reset modes are not implemented" : "Native display configuration failed"); return 1;
        }
        state->displaySlot = a; state->displayKind = b; state->displayFlags = c;
        state->startupServices++; return 1;
    }
    if (group == 0x80 && service == 0x61) {
        Thread_PushStack(thread, state->displayKind); return 1;
    }
    if (group == 0x80 && service == 0x46) {
        Thread_PushStack(thread, thread->threadId); return 1;
    }
    if (group == 0x80 && service == 0x64) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        state->windowVisible = a != 0;
        if (state->showWindow) state->showWindow(thread->engine, state->windowVisible);
        MLBGI_ClearInput(&state->input); return 1;
    }
    if (group == 0x80 && service == 0x1b) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *pointer = MLBGI_ResolveAddress(thread, b);
        size_t remaining = pointer ? MLBGI_MemoryRemaining(thread->engine, pointer) : 0;
        uint32_t keys[16] = {0}; unsigned count = 0;
        for (; count < 16; count++) {
            if (remaining < (count + 1) * 4u) { *result = fault(thread, "Input mapping exceeds VM memory"); return 1; }
            keys[count] = MLBGI_ReadInteger(thread, pointer + count * 4, 2);
            if (!keys[count]) break;
        }
        if (!MLBGI_SetInputMap(&state->input, a, keys, count)) { *result = fault(thread, "Invalid input action, key or mapping bound"); return 1; }
        return 1;
    }
    if (group == 0x80 && service == 0x1c) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        Thread_PushStack(thread, MLBGI_InputEventCount(&state->input, a)); return 1;
    }
    if (group == 0x80 && service == 0x62) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        uint32_t keys[16] = {0};
        if (a && b) {
            uint8_t *pointer = MLBGI_ResolveAddress(thread, b);
            size_t remaining = pointer ? MLBGI_MemoryRemaining(thread->engine, pointer) : 0;
            unsigned i = 0;
            for (; i < 16; i++) {
                if (remaining < (i + 1) * 4u) { *result = fault(thread, "Display hotkeys exceed VM memory"); return 1; }
                keys[i] = MLBGI_ReadInteger(thread, pointer + i * 4, 2);
                if (!keys[i]) break;
            }
            if (i == 16) { *result = fault(thread, "Display hotkeys lack a bounded terminator"); return 1; }
        }
        if (a) memcpy(state->displayHotkeys, keys, sizeof(keys));
        state->displayHotkeysEnabled = a; return 1;
    }
    if (group == 0x80 && service == 0x0d) {
        if (!physicalMemory(&a, &b)) { *result = fault(thread, "Physical memory information is unavailable"); return 1; }
        /* The original service pushes total first, then available memory. */
        Thread_PushStack(thread, a); Thread_PushStack(thread, b); return 1;
    }
    if (group == 0x80) {
        fprintf(stderr, "[BGI]: Unsupported modern Sys0 service 0x%02X\n", service);
        *result = UINT32_MAX; return 1;
    }
    if (group == 0xa0 && (service == 0x08 || service == 0x09)) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        unsigned count = service == 0x08 ? 16 : 128;
        if (a >= count || b > 128) { *result = fault(thread, "Invalid audio channel or volume"); return 1; }
        if (service == 0x08) state->audioChannelVolumes[a] = b;
        else state->audioEffectVolumes[a] = b;
        return 1;
    }
    if (group == 0xb0 && service == 0xc1) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        const char *name = MLBGI_ReadString(thread, a, 1024);
        if (!name) { *result = UINT32_MAX - 3; return 1; }
        int index = intern(state, name, b == 0 ? 0x80 : 1, b <= 1);
        if (index < 0) { *result = fault(thread, "String registry exceeds its supported bound"); return 1; }
        Thread_PushStack(thread, (uint32_t)index); return 1;
    }
    if (group == 0xb0 && service == 0x05) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a) {
            if (!state->cursorDelayEnabled) {
                state->cursorVisible = 1;
                state->cursorX = state->cursorY = INT32_MIN;
            }
            state->cursorDelayEnabled = 1;
            state->cursorDelay = a; state->cursorDeadline = MLBGI_Milliseconds() + a;
        } else {
            state->cursorDelayEnabled = 0; state->cursorVisible = 1;
        }
        return 1;
    }
    if (group == 0xc0 && service == 0x18) {
        uint32_t values[7];
        for (int i = 6; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        if (!state->registerImageProtocol || !state->registerImageProtocol(thread->engine, values[0], values[1],
            values[2], values[3], values[4], values[5], values[6])) {
            *result = fault(thread, "Image protocol requires bounded matching frames and valid rate parameters"); return 1;
        }
        return 1;
    }
    if (group == 0xc0 && service == 0x1f) {
        if (!pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (a > 2) { *result = fault(thread, "Invalid image protocol rate mode"); return 1; }
        state->imageProtocolRateMode = a; return 1;
    }
    if (group == 0xc0 && (service == 0x24 || service == 0x2c)) {
        if (!pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        int success = service == 0x24 ? state->registerParticleImage && state->registerParticleImage(thread->engine, a, b) :
            state->registerImageProtocol && state->registerImageProtocol(thread->engine, 1, a, 1, b, 0, 0, 0);
        if (!success) {
            *result = fault(thread, "Particle image protocol requires a valid bank and supported source image"); return 1;
        }
        return 1;
    }
    if (group == 0xc0 && service == 0x25) {
        uint32_t values[11];
        for (int i = 10; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *pointer = MLBGI_ResolveAddress(thread, values[10]);
        if (!pointer || MLBGI_MemoryRemaining(thread->engine, pointer) < 4) {
            *result = fault(thread, "Particle configuration requires bounded fixed-point input"); return 1;
        }
        values[10] = MLBGI_ReadInteger(thread, pointer, 2);
        if (thread->error || !state->configureParticle || !state->configureParticle(thread->engine, values[0], values + 1)) {
            *result = fault(thread, "Particle configuration requires a valid native bank"); return 1;
        }
        return 1;
    }
    if (group == 0xc0 && service == 0x2d) {
        uint32_t values[18];
        for (int i = 17; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        uint8_t *pointer = MLBGI_ResolveAddress(thread, values[14]);
        if (!pointer || MLBGI_MemoryRemaining(thread->engine, pointer) < 4) {
            *result = fault(thread, "Image protocol configuration requires bounded fixed-point input"); return 1;
        }
        values[14] = MLBGI_ReadInteger(thread, pointer, 2);
        if (thread->error || !state->configureImageProtocol ||
            !state->configureImageProtocol(thread->engine, values[0], values + 1)) {
            *result = fault(thread, "Image protocol configuration requires a valid native bank"); return 1;
        }
        return 1;
    }
    if (group == 0x90) {
        switch (service) {
            case 0x00:
                if (!pop(thread, &a)) break;
                if (state->framePending) state->frameFlags |= a != 0;
                else { state->framePending = 1; state->frameFlags = a != 0; }
                return 1;
            case 0x02:
                if (!pop(thread, &a)) break;
                if (a > 1000) { *result = fault(thread, "Invalid frame rate"); return 1; }
                state->frameMilliseconds = a ? 1000 / a : 0;
                return 1;
            case 0x03:
                if (!pop(thread, &a)) break;
                if (a > 512 * 1024 * 1024) { *result = fault(thread, "Image cache exceeds its supported bound"); return 1; }
                state->imageCacheLimit = a; return 1;
            case 0x07:
                if (!pop(thread, &a)) break;
                state->skipInterval = a; state->skipDeadline = 0; return 1;
            case 0x08:
                if (!pop(thread, &a)) break;
                state->renderConfiguration = a; return 1;
            case 0x0c:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                if (b > 256) { *result = fault(thread, "Invalid postprocessing opacity"); return 1; }
                state->effectOpacityEnabled = a; state->effectOpacity = b; return 1;
            case 0x4c:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                state->canvasEnabled = a; state->canvasBackground = b; return 1;
            case 0x9f:
                if (!pop(thread, &a)) break;
                state->animationPolicy = a; return 1;
            case 0x9c:
                if (!pop(thread, &a)) break;
                state->textShadowEnabled = a; return 1;
            case 0x9d:
                if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) break;
                if ((int32_t)a < 0 || (int32_t)b < 0 || c > 256) {
                    *result = fault(thread, "Window text shadow requires nonnegative width/height percentages and bounded opacity"); return 1;
                }
                /* The native helper leaves the prior configuration intact
                   when either percentage exceeds its supported range. */
                if (a <= 100 && b <= 100) {
                    state->textShadowWidthPercent = a; state->textShadowHeightPercent = b; state->textShadowOpacity = c;
                }
                return 1;
            case 0x94:
                if (!pop(thread, &a)) break;
                state->bitmapConfiguration = a; return 1;
            case 0x95:
            case 0x96:
            case 0x97:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                /* The first two contracts validate their context before
                   changing either word. The third stores an unrestricted
                   pair. Their presentation consumers are separate. */
                if (service != 0x97 && (a < 1 || a > 256)) {
                    *result = fault(thread, "Invalid renderer context"); return 1;
                }
                state->renderPairs[service - 0x95][0] = a;
                state->renderPairs[service - 0x95][1] = b; return 1;
            case 0xaf:
                if (!pop(thread, &a)) break;
                state->renderRequiresFocus = a; return 1;
            case 0x0d:
                if (!pop(thread, &a)) break;
                if (a > 3) { *result = fault(thread, "Invalid font antialias level"); return 1; }
                state->antialiasLevel = a; return 1;
            case 0x0e: {
                uint32_t values[5];
                for (int i = 4; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (values[0] >= state->nameCount || values[1] < 4 || values[1] > 200 || values[2] < 25 || values[2] > 200 || values[4] < 2 || values[4] > 16384) {
                    *result = fault(thread, "Invalid font family, size, width or cache bound"); return 1;
                }
                unsigned index = 0;
                while (index < state->fontCount) {
                    MLBGI_FontProfile *font = &state->fonts[index];
                    if (font->family == values[0] && font->size == values[1] && font->width == values[2] && (font->style != 0) == (values[3] != 0)) break;
                    index++;
                }
                if (index >= 64) { *result = fault(thread, "Font cache registry exceeds its supported bound"); return 1; }
                if (index == state->fontCount) state->fontCount++;
                state->fonts[index] = (MLBGI_FontProfile){values[0], values[1], values[2], values[3], values[4]};
                return 1;
            }
            case 0x10:
                if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) break;
                if (a >= 16384 || !state->loadBitmap) { *result = fault(thread, "Bitmap service requires a native resource loader and a valid slot"); return 1; }
                {
                    const char *name = MLBGI_ReadString(thread, c, 97), *archive = b ? MLBGI_ReadString(thread, b, 97) : NULL;
                    if (!name || (b && !archive)) { *result = UINT32_MAX - 3; return 1; }
                    if (!state->loadBitmap(thread->engine, a, archive, name)) {
                        *result = fault(thread, state->bitmapLoadError[0] ? state->bitmapLoadError : "Bitmap resource is missing, invalid, or exceeds memory"); return 1;
                    }
                }
                /* Decoding completes before the cooperative yield. This
                   service has no operand-stack completion value. */
                *result = 2; return 1;
            case 0x12:
                if (!pop(thread, &a)) break;
                if (a >= 16384 || !state->freeBitmap) { *result = fault(thread, "Bitmap release requires a native loader and a valid slot"); return 1; }
                Thread_PushStack(thread, state->freeBitmap(thread->engine, a)); return 1;
            case 0x11: {
                uint32_t values[4];
                for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (!state->createBitmap || !state->createBitmap(thread->engine, values[0], values[1], values[2], values[3])) {
                    *result = fault(thread, "Bitmap creation requires a bounded size and supported pixel format"); return 1;
                }
                return 1;
            }
            case 0x13:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                if (!state->clearBitmap || !state->clearBitmap(thread->engine, a, b)) {
                    *result = fault(thread, "Bitmap clear requires an existing native bitmap"); return 1;
                }
                return 1;
            case 0x16:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                {
                    uint8_t *output = MLBGI_ResolveAddress(thread, a);
                    uint32_t values[6] = {0};
                    if (!output || MLBGI_MemoryRemaining(thread->engine, output) < sizeof(values) || !state->bitmapInfo) {
                        *result = fault(thread, "Bitmap metadata requires a native loader and bounded output"); return 1;
                    }
                    c = state->bitmapInfo(thread->engine, b, values);
                    if (c) for (unsigned i = 0; i < 6; i++) MLBGI_WriteInteger(thread, output + i * 4, 2, values[i]);
                    else MLBGI_WriteInteger(thread, output, 2, 0);
                    Thread_PushStack(thread, c); return 1;
                }
            case 0x18: {
                uint32_t values[6];
                for (int i = 5; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (!state->blitBitmap || !state->blitBitmap(thread->engine, values[0], (int32_t)values[1],
                    (int32_t)values[2], values[3], values[4], values[5])) {
                    uint32_t destination[6] = {0}, source[6] = {0};
                    if (state->bitmapInfo) {
                        state->bitmapInfo(thread->engine, values[0], destination);
                        state->bitmapInfo(thread->engine, values[3], source);
                    }
                    char message[224];
                    snprintf(message, sizeof(message), "Bitmap copy failed: mode %u, transparency %u, source slot %u (format %u), destination slot %u (format %u)",
                             values[4], values[5], values[3], source[4], values[0], destination[4]);
                    *result = fault(thread, message); return 1;
                }
                return 1;
            }
            case 0x1f: {
                uint32_t values[6];
                for (int i = 5; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (!state->cropBitmap || !state->cropBitmap(thread->engine, values[0], values[1],
                    (int32_t)values[2], (int32_t)values[3], values[4], values[5])) {
                    *result = fault(thread, "Bitmap crop requires valid slots and a supported source rectangle"); return 1;
                }
                return 1;
            }
            default: break;
        }
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
    }
    if (group == 0x92 && service == 0x9c) {
        uint32_t values[21];
        for (int i = 20; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        /* This dialect passes direction/ruby/layout operands to the
           text compositor. The plain horizontal path has an actual
           native glyph host; other contracts remain explicit. The
           last reserved word is discarded by the original handler. */
        if (!state->drawBitmapText || values[0] >= 16384 || values[8] >= state->nameCount ||
            values[9] < 4 || values[9] > 200 || values[10] < 25 || values[10] > 200 ||
            values[4] || values[5] || values[6] || values[7] || values[13] || values[14] ||
            values[15] > 2 || values[16] > 100 || values[17] > 100 || values[19] > 256) {
            *result = fault(thread, "Bitmap text requires a native renderer and supported font, layout and effect operands"); return 1;
        }
        for (unsigned i = 0; i < 4; i++) if (state->fontTransforms[values[8]][i]) {
            *result = fault(thread, "Bitmap text font transforms are not yet supported"); return 1;
        }
        const char *text = MLBGI_ReadString(thread, values[3], 4096);
        if (!text) { *result = UINT32_MAX - 3; return 1; }
        MLBGI_BitmapText request = { values[0], (int32_t)values[1], (int32_t)values[2], text, state->names[values[8]],
            values[9], values[10], values[11], values[12], values[15], values[16], values[17], values[18], values[19] };
        uint32_t characters = 0;
        if (!state->drawBitmapText(thread->engine, &request, &characters)) {
            *result = fault(thread, "Bitmap text contains an unsupported control, font or layout, or its destination is invalid"); return 1;
        }
        Thread_PushStack(thread, characters); return 1;
    }
    if (group == 0x91) {
        switch (service) {
            case 0x88: {
                uint32_t values[7];
                for (int i = 6; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                MLBGI_WindowObject *window = windowObject(state, values[0]);
                if (!window || values[1] >= state->nameCount || !state->names[values[1]][0] || strlen(state->names[values[1]]) >= 32 ||
                    values[2] < 4 || values[2] > 200 || values[3] < 25 || values[3] > 200) {
                    *result = fault(thread, "Window font requires an existing object, a bounded family name, size and width"); return 1;
                }
                window->fontFamily = values[1]; window->fontHeight = values[2]; window->fontWidthPercent = values[3];
                window->fontStyle = values[4]; window->fontColor = values[5]; window->textReserveLine = values[6]; window->fontConfigured = 1;
                /* The native font selector reserves one character-width
                   band at the bottom only when the caller enables it. */
                uint32_t reserved = values[2] * values[3] / 100;
                if (values[6] && reserved < window->height && window->textHeight > window->height - reserved)
                    window->textHeight = window->height - reserved;
                return 1;
            }
            case 0x8a:
            case 0x8b: {
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                MLBGI_WindowObject *window = windowObject(state, a);
                if (!window || b > (service == 0x8a ? 1u : 2u)) {
                    *result = fault(thread, "Window text layout requires an existing object and a supported direction or alignment"); return 1;
                }
                if (service == 0x8a) {
                    window->textDirection = b;
                    window->textCursorX = (int32_t)(window->textX + (b ? window->textWidth - 1 : 0));
                    window->textCursorY = (int32_t)window->textY;
                }
                else window->textAlignment = b;
                return 1;
            }
            case 0x8c: {
                uint32_t values[3];
                for (int i = 2; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                MLBGI_WindowObject *window = windowObject(state, values[0]);
                if (!window) { *result = fault(thread, "Window text cursor requires an existing object"); return 1; }
                window->textCursorX = (int32_t)values[1]; window->textCursorY = (int32_t)values[2]; return 1;
            }
            case 0x8d: {
                if (!pop(thread, &a)) break;
                MLBGI_WindowObject *window = windowObject(state, a);
                if (!window) { *result = fault(thread, "Window text cursor query requires an existing object"); return 1; }
                Thread_PushStack(thread, 1);
                Thread_PushStack(thread, (uint32_t)window->textCursorX);
                Thread_PushStack(thread, (uint32_t)window->textCursorY); return 1;
            }
            case 0x89: {
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                MLBGI_WindowObject *window = windowObject(state, a);
                if (!window || b > 800) {
                    *result = fault(thread, "Window line spacing requires an existing object and a percentage up to 800"); return 1;
                }
                window->textLineSpacingPercent = b; return 1;
            }
            case 0x1f:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                {
                    uint32_t values[6] = {0};
                    if (!state->bitmapInfo || !state->cropBitmap || !state->bitmapInfo(thread->engine, b, values) ||
                        !state->cropBitmap(thread->engine, a, b, 0, 0, values[2], values[3])) {
                        *result = fault(thread, "Bitmap duplication requires an existing source and bounded destination"); return 1;
                    }
                }
                return 1;
            case 0x00:
                if (!pop(thread, &a)) break;
                state->presentationPolicy = a; return 1;
            case 0x0a:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                if (a == 0x01220000) { state->codecOptions[0] = b; Thread_PushStack(thread, 1); }
                else if (a == 0x80111600) { state->codecOptions[1] = b; Thread_PushStack(thread, 1); }
                else Thread_PushStack(thread, 0);
                return 1;
            case 0x9a:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                if (a == 0) state->renderAttributes[0] = b;
                else if (a >= 0x80000000 && a <= 0x80000004) {
                    if (a == 0x80000001 && (int32_t)b < 0) { *result = fault(thread, "Invalid renderer attribute value"); return 1; }
                    state->renderAttributes[1 + a - 0x80000000] = b;
                } else { *result = fault(thread, "Invalid renderer attribute ID"); return 1; }
                return 1;
            case 0x98: {
                uint32_t values[6];
                for (int i = 5; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (values[3] < 25 || values[3] > 100 || (int32_t)values[4] < 0) { *result = fault(thread, "Invalid ruby text ratio or margin"); return 1; }
                if (!values[1]) values[1] = 1;
                memcpy(state->rubyConfiguration, values, sizeof(values)); return 1;
            }
            case 0x0e: {
                uint32_t values[4];
                for (int i = 3; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
                if (!pop(thread, &a)) break;
                const char *name = MLBGI_ReadString(thread, a, 1024);
                if (!name) { *result = UINT32_MAX - 3; return 1; }
                int zero = !(values[0] | values[1] | values[2] | values[3]);
                if (!zero) {
                    if ((values[0] && (values[0] < 0x10000 || values[0] > 0x20000)) || values[1] < 0x10000 || values[1] > 0x20000) {
                        *result = fault(thread, "Invalid font transform scale"); return 1;
                    }
                    uint32_t horizontal = values[0] ? values[0] : values[1];
                    int32_t maximumX = (int32_t)(4294967296.0 / horizontal - 65536.0);
                    int32_t maximumY = (int32_t)(4294967296.0 / values[1] - 65536.0);
                    if ((int32_t)values[2] > maximumX || (int32_t)values[3] > maximumY) { *result = fault(thread, "Invalid font transform coordinates"); return 1; }
                }
                int index = intern(state, name, 0, 0);
                if (index < 0) { *result = fault(thread, "Font transform registry exceeds its supported bound"); return 1; }
                for (unsigned i = 0; i < 4; i++) state->fontTransforms[index][i] = (int32_t)values[i];
                return 1;
            }
            default: break;
        }
        if (thread->error) { *result = UINT32_MAX - 3; return 1; }
    }
    if (group != 0x81) {
        fprintf(stderr, "[BGI]: Unsupported modern service 0x%02X%02X\n", group, service);
        *result = UINT32_MAX; return 1;
    }
    switch (service) {
        case 0x60: /* Register width/height in one of eight display slots. */
            if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) break;
            if (a >= 8) Thread_PushStack(thread, 1);
            else if (!b || !c) Thread_PushStack(thread, 2);
            else { state->displayWidths[a] = b; state->displayHeights[a] = c; Thread_PushStack(thread, 0); }
            state->startupServices++; return 1;
        case 0x62:
        case 0x63:
            if (!pop(thread, &a)) break;
            b = service == 0x62 ? 1 : 2;
            if (a <= b) { if (service == 0x62) state->windowPolicy = a; else state->scalingPolicy = a; }
            Thread_PushStack(thread, a <= b ? 1 : 0); state->startupServices++; return 1;
        case 0x0e: { /* Normalized desktop dimensions, two LE32 output words. */
            if (!pop(thread, &a)) break;
            uint8_t *output = MLBGI_ResolveAddress(thread, a);
            if (!output || MLBGI_MemoryRemaining(thread->engine, output) < 8) { *result = fault(thread, "Desktop size output exceeds VM memory"); return 1; }
            b = state->monitorWidth; c = state->monitorHeight;
            if ((uint64_t)b * 4 / c >= 10) b >>= 1;
            if (c / state->monitorWidth >= 1 && (uint64_t)c * 100 / state->monitorWidth < 125) c >>= 1;
            MLBGI_WriteInteger(thread, output, 2, b); MLBGI_WriteInteger(thread, output + 4, 2, c);
            state->startupServices++; return 1;
        }
        case 0x64:
            if (!pop(thread, &b) || !pop(thread, &a)) break;
            c = !a || !b;
            a = c ? state->displayWidths[state->displaySlot] : a;
            b = c ? state->displayHeights[state->displaySlot] : b;
            if (state->configureWindow && !state->configureWindow(thread->engine, state->displayKind, a, b)) { *result = fault(thread, "Native client sizing failed"); return 1; }
            state->automaticClientSize = c; state->clientWidth = a; state->clientHeight = b;
            state->startupServices++; return 1;
        default:
            fprintf(stderr, "[BGI]: Unsupported modern Sys1 service 0x%02X\n", service);
            *result = UINT32_MAX; return 1;
    }
    *result = UINT32_MAX - 3; return 1;
}
uint32_t MLBGI_DispatchSys1(Thread_t *thread) {
    uint8_t service = Thread_ReadCode8(thread);
    thread->inBasicOpcode = 0; thread->opcode = 0x8100 | service;
    if (thread->error) return UINT32_MAX - 3;
    uint32_t result;
    if (MLBGI_TryService(thread, 0x81, service, &result)) return result;
    fprintf(stderr, "[BGI]: Unsupported Sys1 service 0x%02X\n", service);
    return UINT32_MAX;
}
