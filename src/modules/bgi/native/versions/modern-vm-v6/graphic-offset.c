/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "graphic-offset.h"
#include "vm-dialect.h"

static int validObject(const MLBGI_Runtime *state, uint32_t handle, unsigned visited, unsigned *checked) {
    unsigned slot = handle & 0x00ffffff;
    if (!handle) return state->immediateBitmap.allocated;
    switch (handle & 0xff000000) {
        case 0x80000000: return slot < 512 && state->sprites[slot].object.allocated;
        case 0x90000000: return slot < 8 && state->filters[slot].allocated;
        case 0xb0000000: return slot < 16 && state->windows[slot].allocated;
        case 0xf1000000: {
            if (slot >= 8 || !state->groups[slot].allocated || (visited & (1u << slot))) return 0;
            if (*checked & (1u << slot)) return 1;
            const MLBGI_Group *group = &state->groups[slot];
            if (group->memberCount > 1024) return 0;
            for (unsigned i = 0; i < group->memberCount; i++)
                if (!validObject(state, group->members[i].handle, visited | (1u << slot), checked)) return 0;
            *checked |= 1u << slot;
            return 1;
        }
        default: return 0;
    }
}
static void applyOffset(MLBGI_Runtime *state, uint32_t handle, int32_t x, int32_t y, unsigned *applied) {
    unsigned slot = handle & 0x00ffffff;
    if (!handle) {
        state->immediateBitmap.secondOffsetX = x; state->immediateBitmap.secondOffsetY = y;
    } else if ((handle & 0xff000000) == 0x80000000) {
        state->sprites[slot].object.secondOffsetX = x; state->sprites[slot].object.secondOffsetY = y;
    } else if ((handle & 0xff000000) == 0x90000000) {
        state->filters[slot].secondOffsetX = x; state->filters[slot].secondOffsetY = y;
    } else if ((handle & 0xff000000) == 0xb0000000) {
        state->windows[slot].secondOffsetX = x; state->windows[slot].secondOffsetY = y;
    } else {
        if (*applied & (1u << slot)) return;
        *applied |= 1u << slot;
        MLBGI_Group *group = &state->groups[slot];
        group->secondOffsetX = x; group->secondOffsetY = y;
        for (unsigned i = 0; i < group->memberCount; i++) applyOffset(state, group->members[i].handle, x, y, applied);
    }
}
int MLBGI_SetGraphicSecondOffset(Engine_t *engine, uint32_t handle, int32_t x, int32_t y) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    unsigned checked = 0, applied = 0;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !validObject(state, handle, 0, &checked)) return 0;
    /* Native handle zero selects the current immediate draw object.
       Other handles retain their own namespace and existing child graph. */
    applyOffset(state, handle, x, y, &applied); state->drawOrderDirty = 1;
    return 1;
}
