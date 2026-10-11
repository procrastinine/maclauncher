/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * Original program bytes are shared by neither thread nor game. Archive
 * payloads remain in place; each VM thread owns only its requested buffers. */
#include "vm-threads.h"
#include "vm-dialect.h"
#include "vm-guards.h"
#include <stdlib.h>
#define THREAD_LIMIT 64
#define THREAD_MEMORY_LIMIT ((size_t)128 * 1024 * 1024)
static void discard(Engine_t *engine, Thread_t *thread) {
    Thread_t **link = &engine->threads;
    while (*link && *link != thread) link = &(*link)->previousThread;
    if (!*link) return;
    *link = thread->previousThread;
    while (thread->programs) {
        Program_t *program = thread->programs;
        thread->programs = program->previousProgram; free(program->filename); free(program);
    }
    if (thread->stackMemoryConfig.isAllocated) free(thread->stackMemoryConfig.mem);
    if (thread->codeMemoryConfig.isAllocated) free(thread->codeMemoryConfig.mem);
    if (thread->localMemConfig.isAllocated) free(thread->localMemConfig.mem);
    free(thread);
}
static uint32_t createProgram(Engine_t *engine, const char *archive, const char *filename,
                              uint32_t stackWords, uint32_t codeBytes, uint32_t localBytes) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !stackWords || stackWords > 0x100000 || !codeBytes || codeBytes > 0x2000000 ||
        !localBytes || localBytes > 0x2000000 || engine->threadCounter < 2 || engine->threadCounter == UINT32_MAX) return 0;
    size_t used = 0, requested = (size_t)stackWords * 4 + codeBytes + localBytes;
    unsigned count = 0;
    for (Thread_t *thread = engine->threads; thread; thread = thread->previousThread) {
        if (++count >= THREAD_LIMIT) return 0;
        size_t bytes = (size_t)thread->stackSize * 4 + thread->codeSize + thread->localMemSize;
        if (bytes > THREAD_MEMORY_LIMIT - used) return 0;
        used += bytes;
    }
    if (requested > THREAD_MEMORY_LIMIT - used) return 0;
    size_t bytes = 0; uint8_t *program = MLBGI_ReadEngineResource(engine, archive, filename, &bytes);
    if (!program) return 0;
    Thread_t *child = Engine_CreateThread(engine, stackWords, codeBytes, localBytes);
    if (!child || child->error) { free(program); if (child) discard(engine, child); return 0; }
    uint32_t location = MLBGI_LoadCode(child, program, bytes, filename); free(program);
    if (location == UINT32_MAX || child->error) { discard(engine, child); return 0; }
    child->running = 1; return child->threadId;
}
static uint32_t create(Thread_t *parent, const char *archive, const char *filename,
                       uint32_t stackWords, uint32_t codeBytes, uint32_t localBytes) {
    return MLBGI_IsModern(parent) ? createProgram(parent->engine, archive, filename, stackWords, codeBytes, localBytes) : 0;
}
uint32_t MLBGI_LoadBootProgram(Engine_t *engine) {
    /* The 1.72 bootstrap requests these fixed buffers. Child programs retain
       their authored sizes; loading never silently expands a full buffer. */
    if (!engine || engine->threads || engine->threadCounter != 2) return 0;
    return createProgram(engine, "system", "ipl._bp", 0x1000, 0x800000, 0x400000);
}
int MLBGI_AttachThreads(Engine_t *engine) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || state->createThread) return 0;
    state->createThread = create; return 1;
}
Thread_t *MLBGI_NextReadyThread(Engine_t *engine, uint32_t afterId, uint32_t milliseconds) {
    Thread_t *first = NULL, *next = NULL;
    if (!engine) return NULL;
    for (Thread_t *thread = engine->threads; thread; thread = thread->previousThread) {
        if (!thread->running || thread->error || !MLBGI_ThreadReady(thread, milliseconds)) continue;
        if (!first || thread->threadId < first->threadId) first = thread;
        if (thread->threadId > afterId && (!next || thread->threadId < next->threadId)) next = thread;
    }
    return next ? next : first;
}
