/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include <SDL2/SDL.h>
#include "platform-window.h"
#include "vm-dialect.h"
static int configure(Engine_t *engine, uint32_t kind, uint32_t width, uint32_t height) {
    if (!engine || !engine->window || kind > 1 || !width || !height || width > 16384 || height > 16384) return 0;
    if (SDL_SetWindowFullscreen(engine->window, kind ? 0 : SDL_WINDOW_FULLSCREEN_DESKTOP)) return 0;
    if (kind) SDL_SetWindowSize(engine->window, (int)width, (int)height);
    return 1;
}
static void show(Engine_t *engine, int visible) {
    if (!engine || !engine->window) return;
    if (visible) SDL_ShowWindow(engine->window);
    else SDL_HideWindow(engine->window);
}
static void setCaption(Engine_t *engine, const char *caption) {
    if (engine && engine->window && caption) SDL_SetWindowTitle(engine->window, caption);
}
int MLBGI_AttachSDLWindow(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->window) return 0;
    state->configureWindow = configure; state->showWindow = show; state->setCaption = setCaption;
    if (state->captionConfigured) setCaption(engine, state->windowCaption);
    return 1;
}
void MLBGI_ToggleSDLWindow(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !engine->window) return;
    uint32_t kind = !state->displayKind;
    uint32_t width = state->clientWidth ? state->clientWidth : state->displayWidths[state->displaySlot];
    uint32_t height = state->clientHeight ? state->clientHeight : state->displayHeights[state->displaySlot];
    if (configure(engine, kind, width, height)) state->displayKind = kind;
}
