/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_VM_THREADS_H
#define ML_BGI_VM_THREADS_H
#include "engine.h"
#include <stdint.h>
int MLBGI_AttachThreads(Engine_t *engine);
uint32_t MLBGI_LoadBootProgram(Engine_t *engine);
Thread_t *MLBGI_NextReadyThread(Engine_t *engine, uint32_t afterId, uint32_t milliseconds);
#endif
