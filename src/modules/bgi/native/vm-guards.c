/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "vm-guards.h"
#include "vm-dialect.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t le32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
int MLBGI_CodeAvailable(Thread_t *thread, size_t bytes) {
    if (thread->error || thread->nextInstructionPointer > thread->codeSpaceUsed ||
        bytes > thread->codeSpaceUsed - thread->nextInstructionPointer) {
        thread->error = 1; thread->running = 0;
        fprintf(stderr, "[BGI]: Truncated bytecode at 0x%08X\n", thread->nextInstructionPointer);
        return 0;
    }
    return 1;
}
static size_t remaining(const uint8_t *base, size_t size, const uint8_t *pointer) {
    uintptr_t first = (uintptr_t)base, current = (uintptr_t)pointer;
    if (!base || current < first || current - first >= size) return 0;
    return size - (current - first);
}
size_t MLBGI_MemoryRemaining(Engine_t *engine, const uint8_t *pointer) {
    size_t size = remaining(engine->globalMem, engine->globalBufferSize, pointer);
    if (size) return size;
    for (Thread_t *thread = engine->threads; thread; thread = thread->previousThread) {
        if ((size = remaining(thread->localMem, thread->localMemSize, pointer)) ||
            (size = remaining(thread->code, thread->codeSpaceUsed, pointer))) return size;
    }
    for (unsigned i = 0; i < 48; i++) if ((size = remaining(engine->auxMemory[i], engine->auxMemorySizes[i], pointer))) return size;
    MLBGI_Runtime *state = engine->mlRuntime;
    if (state) for (MLBGI_Allocation *entry = state->allocations; entry; entry = entry->next)
        if ((size = remaining(entry->bytes, entry->size, pointer))) return size;
    return 0;
}
uint32_t MLBGI_LoadCode(Thread_t *thread, uint8_t *bytes, size_t length, const char *filename) {
    uint32_t offset, size;
    MLBGI_Runtime *state = thread->engine ? thread->engine->mlRuntime : NULL;
    if (state && state->dialect == MLBGI_ETHORNELL_172 &&
        (!bytes || length < 16 || le32(bytes) != 16 || le32(bytes + 8) || le32(bytes + 12))) {
        thread->error = 1; thread->running = 0;
        fprintf(stderr, "[BGI]: Program header differs from the supported 1.72 dialect\n");
        return UINT32_MAX;
    }
    if (!bytes || length < 8 || (offset = le32(bytes)) < 8 || offset > length ||
        !(size = le32(bytes + 4)) || size > length - offset || thread->codeSpaceUsed > thread->codeSize ||
        size > thread->codeSize - thread->codeSpaceUsed || !filename || strnlen(filename, 97) > 96) {
        thread->error = 1; thread->running = 0;
        fprintf(stderr, "[BGI]: Invalid program code range or capacity\n");
        return UINT32_MAX;
    }
    Program_t *program = calloc(1, sizeof(*program));
    if (!program || !(program->filename = strdup(filename))) {
        free(program); thread->error = 1; thread->running = 0; return UINT32_MAX;
    }
    program->size = size; program->location = thread->codeSpaceUsed; program->previousProgram = thread->programs;
    memcpy(thread->code + thread->codeSpaceUsed, bytes + offset, size);
    thread->programs = program; thread->codeSpaceUsed += size; thread->programCount++;
    return program->location;
}
