/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include <SDL2/SDL.h>
#include "platform-renderer.h"
#include "vm-dialect.h"
int MLBGI_PresentSDLScene(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->window || state->displaySlot >= 8) return 0;
    uint32_t width = state->displayWidths[state->displaySlot], height = state->displayHeights[state->displaySlot];
    if (!width || !height || width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024) return 0;
    SDL_Surface *surface = SDL_GetWindowSurface(engine->window);
    if (!surface || surface->w <= 0 || surface->h <= 0) return 0;
    SDL_Surface *frame = SDL_CreateRGBSurfaceWithFormat(0, (int)width, (int)height, 32, SDL_PIXELFORMAT_RGBA32);
    if (!frame || frame->pitch <= 0) { if (frame) SDL_FreeSurface(frame); return 0; }
    int okay = MLBGI_DrawScene(engine, frame->pixels, (size_t)frame->pitch * frame->h, width, height, (size_t)frame->pitch);
    if (okay) okay = !SDL_SetSurfaceBlendMode(frame, SDL_BLENDMODE_NONE) && !SDL_BlitScaled(frame, NULL, surface, NULL) && !SDL_UpdateWindowSurface(engine->window);
    SDL_FreeSurface(frame); return okay;
}
