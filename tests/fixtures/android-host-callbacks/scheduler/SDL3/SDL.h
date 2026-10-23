#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef uint32_t Uint32;
typedef struct SDL_Event { Uint32 type; struct { int code; } user; } SDL_Event;
Uint32 SDL_RegisterEvents(int count);
bool SDL_PushEvent(SDL_Event *event);
void SDL_FlushEvent(Uint32 type);
