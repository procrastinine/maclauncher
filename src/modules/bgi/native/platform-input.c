/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "platform-input.h"
uint32_t MLBGI_SDLKey(SDL_Keycode key) {
    if (key >= SDLK_a && key <= SDLK_z) return (uint32_t)(key - SDLK_a + 65);
    if (key >= SDLK_0 && key <= SDLK_9) return (uint32_t)key;
    if (key >= SDLK_F1 && key <= SDLK_F12) return (uint32_t)(key - SDLK_F1 + 112);
    if (key >= SDLK_F13 && key <= SDLK_F24) return (uint32_t)(key - SDLK_F13 + 124);
    if (key >= SDLK_KP_1 && key <= SDLK_KP_9) return (uint32_t)(key - SDLK_KP_1 + 97);
    switch (key) {
        case SDLK_BACKSPACE: return 8; case SDLK_TAB: return 9;
        case SDLK_RETURN: case SDLK_KP_ENTER: return 13;
        case SDLK_PAUSE: return 19; case SDLK_CAPSLOCK: return 20;
        case SDLK_ESCAPE: return 27; case SDLK_SPACE: return 32;
        case SDLK_PAGEUP: return 33; case SDLK_PAGEDOWN: return 34;
        case SDLK_END: return 35; case SDLK_HOME: return 36;
        case SDLK_LEFT: return 37; case SDLK_UP: return 38;
        case SDLK_RIGHT: return 39; case SDLK_DOWN: return 40;
        case SDLK_PRINTSCREEN: return 44; case SDLK_INSERT: return 45;
        case SDLK_DELETE: return 46; case SDLK_LGUI: return 91;
        case SDLK_RGUI: return 92; case SDLK_APPLICATION: return 93;
        case SDLK_KP_0: return 96; case SDLK_KP_MULTIPLY: return 106;
        case SDLK_KP_PLUS: return 107; case SDLK_KP_MINUS: return 109;
        case SDLK_KP_PERIOD: return 110; case SDLK_KP_DIVIDE: return 111;
        case SDLK_NUMLOCKCLEAR: return 144; case SDLK_SCROLLLOCK: return 145;
        case SDLK_LSHIFT: return 160; case SDLK_RSHIFT: return 161;
        case SDLK_LCTRL: return 162; case SDLK_RCTRL: return 163;
        case SDLK_LALT: return 164; case SDLK_RALT: return 165;
        case SDLK_SEMICOLON: return 186; case SDLK_EQUALS: return 187;
        case SDLK_COMMA: return 188; case SDLK_MINUS: return 189;
        case SDLK_PERIOD: return 190; case SDLK_SLASH: return 191;
        case SDLK_BACKQUOTE: return 192; case SDLK_LEFTBRACKET: return 219;
        case SDLK_BACKSLASH: return 220; case SDLK_RIGHTBRACKET: return 221;
        case SDLK_QUOTE: return 222; default: return 0;
    }
}
void MLBGI_SDLInputEvent(MLBGI_Input *input, const SDL_Event *event, uint32_t milliseconds) {
    if (!input || !event) return;
    if (event->type == SDL_WINDOWEVENT && event->window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
        MLBGI_ReleaseInput(input); return;
    }
    if (event->type == SDL_KEYDOWN || event->type == SDL_KEYUP) {
        uint32_t key = MLBGI_SDLKey(event->key.keysym.sym);
        if (!key) return;
        int down = event->type == SDL_KEYDOWN;
        MLBGI_InputEvent(input, key, down, event->key.repeat, milliseconds);
        if (key >= 160 && key <= 165) {
            uint32_t first = key & ~1u, generic = (key - 160) / 2 + 16;
            int held = input->held[first] || input->held[first + 1];
            if (down || input->held[generic] != held) MLBGI_InputEvent(input, generic, held, event->key.repeat, milliseconds);
        }
    } else if (event->type == SDL_MOUSEBUTTONDOWN || event->type == SDL_MOUSEBUTTONUP) {
        const uint32_t keys[6] = {0, 1, 4, 2, 5, 6};
        if (event->button.button > 0 && event->button.button < 6) MLBGI_InputEvent(input, keys[event->button.button], event->type == SDL_MOUSEBUTTONDOWN, 0, milliseconds);
    } else if (event->type == SDL_MOUSEWHEEL && event->wheel.y) {
        int64_t steps = event->wheel.y;
        if (event->wheel.direction == SDL_MOUSEWHEEL_FLIPPED) steps = -steps;
        uint32_t key = steps > 0 ? 14 : 15;
        if (steps < 0) steps = -steps;
        if (steps > 64) steps = 64;
        for (int64_t i = 0; i < steps; i++) {
            MLBGI_InputEvent(input, key, 1, 0, milliseconds);
            MLBGI_InputEvent(input, key, 0, 0, milliseconds);
        }
    }
}
