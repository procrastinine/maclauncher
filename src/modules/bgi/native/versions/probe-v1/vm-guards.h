/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef MACLAUNCHER_BGI_VM_GUARDS_H
#define MACLAUNCHER_BGI_VM_GUARDS_H
#include "engine.h"
#include <stddef.h>
int MLBGI_CodeAvailable(Thread_t *thread, size_t bytes);
size_t MLBGI_MemoryRemaining(Engine_t *engine, const uint8_t *pointer);
uint32_t MLBGI_LoadCode(Thread_t *thread, uint8_t *bytes, size_t length, const char *filename);
#endif
