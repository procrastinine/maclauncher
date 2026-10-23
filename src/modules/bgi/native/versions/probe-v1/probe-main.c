/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * Developer boot probe only. It does not claim title, input or audio support. */
#include "archive-reader.h"
#include "vm-guards.h"
#include "version.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

Engine_t *gEngine;
static int archiveRead(const char *archive, const char *name) {
    size_t size; uint8_t *bytes = MLBGI_ReadFile(archive, name, &size);
    if (!bytes) { fprintf(stderr, "%s\n", MLBGI_ArchiveError()); MLBGI_FreeArchiveCache(); return 2; }
    int okay = !size || fwrite(bytes, 1, size, stdout) == size;
    free(bytes); MLBGI_FreeArchiveCache(); return okay ? 0 : 2;
}
int main(int argc, char **argv) {
    if (argc == 5 && !strcmp(argv[1], "--read-member")) {
        if (chdir(argv[2])) { perror("BGI game directory"); return 2; }
        return archiveRead(argv[3], argv[4]);
    }
    if (argc != 5 || strcmp(argv[1], "--probe") || strcmp(argv[3], "--ticks")) {
        fprintf(stderr, "Developer probe: --probe GAME_DIRECTORY --ticks 1..100000\n"); return 2;
    }
    char *end; unsigned long limit = strtoul(argv[4], &end, 10);
    if (!argv[4][0] || *end || !limit || limit > 100000 || chdir(argv[2])) { fprintf(stderr, "Invalid BGI probe directory or tick limit\n"); return 2; }
    Engine_t engine = {0}; gEngine = &engine; Engine_Init(gEngine);
    uint32_t id = Engine_LoadProgram(gEngine, "system", "ipl._bp", 0x1000, 0x20000, 0x20000);
    Thread_t *thread = Engine_GetThreadById(gEngine, id);
    if (!thread || thread->error || id < 2) {
        fprintf(stderr, "BGI boot program could not be loaded: %s\n", MLBGI_ArchiveError());
        Engine_Free(gEngine); MLBGI_FreeArchiveCache(); return 2;
    }
    uint32_t result = 0, opcode = 0, address = 0; unsigned long ticks = 0;
    thread->running = 1;
    while (ticks < limit) {
        address = thread->nextInstructionPointer;
        result = Thread_Execute(thread); opcode = thread->opcode; ticks++;
        if (result > 3 || thread->error) break;
        if (engine.nextThreadRequest) {
            Thread_t *next = Engine_GetThreadById(gEngine, engine.nextThreadRequest); engine.nextThreadRequest = 0;
            if (!next) { result = UINT32_MAX - 3; break; }
            thread = next;
        }
    }
    /* A tick limit is not a successful game launch. Unknown services fail. */
    printf("{\"probeVersion\":\"0.0.1-build734-mac-probe-v1\",\"ticks\":%lu,\"address\":%u,\"opcode\":%u,\"result\":%u,\"error\":%d,\"limitReached\":%s,\"gameplayQualified\":false}\n",
           ticks, address, opcode, result, thread->error, ticks == limit && result <= 3 && !thread->error ? "true" : "false");
    int status = result > 3 || thread->error ? 3 : 4;
    Engine_Free(gEngine); MLBGI_FreeArchiveCache(); return status;
}
