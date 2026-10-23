/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_PLATFORM_INPUT_H
#define ML_BGI_PLATFORM_INPUT_H
#include <SDL.h>
#include "vm-input.h"
uint32_t MLBGI_SDLKey(SDL_Keycode key);
void MLBGI_SDLInputEvent(MLBGI_Input *input, const SDL_Event *event, uint32_t milliseconds);
#endif
