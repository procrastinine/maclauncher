/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "current-draw.h"
#include "vm-dialect.h"

int MLBGI_CurrentDrawSupported(const MLBGI_ImmediateBitmap *object) {
    if (!object || !object->allocated) return 0;
    if (object->type == 4) return 1;
    /* The renderer constructor installs type 1 with no bitmap content.
       Binding content to that type requires a separate draw contract. */
    return object->type == 1 && !object->sourceValid &&
        object->bitmapSlot == UINT32_MAX && !object->sourceIdentity;
}
int MLBGI_InitializeCurrentDraw(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || state->immediateBitmap.allocated ||
        state->drawSequence == UINT64_MAX) return 0;
    state->immediateBitmap = (MLBGI_ImmediateBitmap){
        .allocated = 1, .type = 1, .bitmapSlot = UINT32_MAX,
        .selector = UINT32_MAX, .drawSequence = ++state->drawSequence
    };
    state->drawOrderDirty = 1;
    return 1;
}
int MLBGI_SelectCurrentBitmap(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172) return 0;
    MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
    if (object->allocated && !MLBGI_CurrentDrawSupported(object)) return 0;
    if (object->allocated && object->type == 4) return 1;
    if (state->drawSequence == UINT64_MAX) return 0;
    /* Type selection replaces the sole current scene entry. The initial
       empty type owns no pixel storage; all prior object fields are discarded. */
    *object = (MLBGI_ImmediateBitmap){
        .allocated = 1, .type = 4, .bitmapSlot = UINT32_MAX,
        .selector = UINT32_MAX, .drawSequence = ++state->drawSequence
    };
    state->drawOrderDirty = 1;
    return 1;
}
