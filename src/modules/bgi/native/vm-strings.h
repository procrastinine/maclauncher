/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_VM_STRINGS_H
#define ML_BGI_VM_STRINGS_H
#include "thread.h"
int MLBGI_CP932ToUTF8(const char *source, char *output, size_t capacity);
uint32_t MLBGI_FormatString(Thread_t *thread);
uint32_t MLBGI_CopyString(Thread_t *thread);
uint32_t MLBGI_StringLength(Thread_t *thread);
uint32_t MLBGI_EqualStrings(Thread_t *thread);
uint32_t MLBGI_EqualMemory(Thread_t *thread);
/* Persistent CP932 source\\replacement lines. Returns 1 complete, 0 null,
   -1 malformed or beyond the finite native text support. */
int MLBGI_RegisterTextRules(Engine_t *engine, const char *input);
int MLBGI_TextRulesAffect(const Engine_t *engine, const char *input);
uint32_t MLBGI_CopyMemory(Thread_t *thread);
uint32_t MLBGI_ClearMemory(Thread_t *thread);
#endif
