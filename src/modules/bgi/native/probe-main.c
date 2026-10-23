/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * Developer boot probe only. It does not claim title, input or audio support. */
#include "archive-reader.h"
#include "vm-guards.h"
#include "vm-dialect.h"
#include "vm-threads.h"
#include "bitmap-loader.h"
#include "platform-text.h"
#include "raw-bitmap.h"
#include "version.h"
#include "spng.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <ctype.h>
#include <fcntl.h>
#include <limits.h>

Engine_t *gEngine;
static int capturePath(const char *requested, char output[PATH_MAX]) {
    if (!requested || requested[0] != '/' || strlen(requested) >= PATH_MAX) return 0;
    char parent[PATH_MAX], resolved[PATH_MAX], game[PATH_MAX];
    memcpy(parent, requested, strlen(requested) + 1);
    char *slash = strrchr(parent, '/');
    const char *name = strrchr(requested, '/') + 1;
    if (!name[0] || !strcmp(name, ".") || !strcmp(name, "..") || !getcwd(game, sizeof(game))) return 0;
    if (slash == parent) slash[1] = 0; else *slash = 0;
    if (!realpath(parent, resolved)) return 0;
    size_t gameBytes = strlen(game);
    if (!strncmp(resolved, game, gameBytes) && (!resolved[gameBytes] || resolved[gameBytes] == '/')) return 0;
    int length = snprintf(output, PATH_MAX, "%s/%s", resolved, name);
    return length > 0 && length < PATH_MAX;
}
static int captureScene(const Engine_t *engine, const char *file) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || state->displaySlot >= 8) return 0;
    uint32_t width = state->displayWidths[state->displaySlot], height = state->displayHeights[state->displaySlot];
    if (!width || !height || width > 8192 || height > 8192 || (uint64_t)width * height > 8 * 1024 * 1024) return 0;
    size_t bytes = (size_t)width * height * 4;
    uint8_t *rgba = malloc(bytes);
    if (!rgba || !MLBGI_DrawScene(engine, rgba, bytes, width, height, (size_t)width * 4)) { free(rgba); return 0; }
    spng_ctx *context = spng_ctx_new(SPNG_CTX_ENCODER);
    int descriptor = context ? open(file, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0600) : -1;
    FILE *stream = descriptor >= 0 ? fdopen(descriptor, "wb") : NULL;
    if (!stream && descriptor >= 0) { close(descriptor); unlink(file); }
    int okay = 0;
    if (stream) {
        struct spng_ihdr header = { .width = width, .height = height, .bit_depth = 8, .color_type = SPNG_COLOR_TYPE_TRUECOLOR_ALPHA };
        okay = !spng_set_png_file(context, stream) && !spng_set_ihdr(context, &header) &&
            !spng_encode_image(context, rgba, bytes, SPNG_FMT_PNG, SPNG_ENCODE_FINALIZE);
        if (fclose(stream)) okay = 0;
        if (!okay) unlink(file);
    }
    if (context) spng_ctx_free(context);
    if (okay) {
        size_t colored = 0;
        for (size_t i = 0; i < bytes; i += 4) if (rgba[i] || rgba[i + 1] || rgba[i + 2]) colored++;
        printf("{\"sceneCaptured\":true,\"width\":%u,\"height\":%u,\"coloredPixels\":%zu,\"nativeWindowPresented\":false}\n", width, height, colored);
    }
    free(rgba); return okay;
}
static int archiveRead(const char *archive, const char *name) {
    size_t size; uint8_t *bytes = MLBGI_ReadFile(archive, name, &size);
    if (!bytes) { fprintf(stderr, "%s\n", MLBGI_ArchiveError()); MLBGI_FreeArchiveCache(); return 2; }
    int okay = !size || fwrite(bytes, 1, size, stdout) == size;
    free(bytes); MLBGI_FreeArchiveCache(); return okay ? 0 : 2;
}
int main(int argc, char **argv) {
    if (argc == 5 && !strcmp(argv[1], "--inspect-bitmap")) {
        if (chdir(argv[2])) { perror("BGI game directory"); return 2; }
        size_t size = 0; uint8_t *bytes = MLBGI_ReadFile(argv[3], argv[4], &size);
        MLBGI_RawBitmap bitmap = {0};
        int okay = bytes && MLBGI_DecodeRawBitmap(bytes, size, &bitmap);
        if (okay) printf("{\"width\":%u,\"height\":%u,\"decodedBytes\":%zu,\"rgbaFirstPixel\":[%u,%u,%u,%u]}\n", bitmap.width, bitmap.height, size, bitmap.rgba[0], bitmap.rgba[1], bitmap.rgba[2], bitmap.rgba[3]);
        else fprintf(stderr, "Unsupported or malformed BGI bitmap\n");
        free(bitmap.rgba); free(bytes); MLBGI_FreeArchiveCache(); return okay ? 0 : 2;
    }
    if (argc == 5 && !strcmp(argv[1], "--read-member")) {
        if (chdir(argv[2])) { perror("BGI game directory"); return 2; }
        return archiveRead(argv[3], argv[4]);
    }
    if (argc < 5 || strcmp(argv[1], "--probe") || strcmp(argv[3], "--ticks")) {
        fprintf(stderr, "Developer probe: --probe GAME_DIRECTORY --ticks 1..10000000 [--dialect DIALECT] [--monitor WIDTH HEIGHT] [--state-directory DIRECTORY] [--project-identifier-hex HEX] [--trace-ticks FIRST END] [--memory ADDRESS_HEX BYTES] [--scene-output ABSOLUTE_PNG_PATH]\n"); return 2;
    }
    char *end; unsigned long limit = strtoul(argv[4], &end, 10);
    if (!argv[4][0] || *end || !limit || limit > 10000000 || chdir(argv[2])) { fprintf(stderr, "Invalid BGI probe directory or tick limit\n"); return 2; }
    uint32_t monitorWidth = 1280, monitorHeight = 960;
    const char *dialect = "legacy-v1", *stateDirectory = NULL, *identifierHex = NULL, *sceneOutput = NULL;
    unsigned long traceStart = 0, traceEnd = 0;
    uint32_t memoryAddress = 0, memoryBytes = 0;
    for (int i = 5; i < argc; i++) {
        if (!strcmp(argv[i], "--dialect") && i + 1 < argc) dialect = argv[++i];
        else if (!strcmp(argv[i], "--state-directory") && i + 1 < argc) stateDirectory = argv[++i];
        else if (!strcmp(argv[i], "--project-identifier-hex") && i + 1 < argc) identifierHex = argv[++i];
        else if (!strcmp(argv[i], "--scene-output") && i + 1 < argc) sceneOutput = argv[++i];
        else if (!strcmp(argv[i], "--memory") && i + 2 < argc) {
            unsigned long value = strtoul(argv[++i], &end, 16);
            if (!argv[i][0] || *end || value > UINT32_MAX) return 2;
            memoryAddress = (uint32_t)value;
            value = strtoul(argv[++i], &end, 10);
            if (!argv[i][0] || *end || !value || value > 4096) return 2;
            memoryBytes = (uint32_t)value;
        }
        else if (!strcmp(argv[i], "--trace-ticks") && i + 2 < argc) {
            traceStart = strtoul(argv[++i], &end, 10);
            if (!argv[i][0] || *end || traceStart > limit) return 2;
            traceEnd = strtoul(argv[++i], &end, 10);
            if (!argv[i][0] || *end || traceEnd <= traceStart || traceEnd > limit) return 2;
        }
        else if (!strcmp(argv[i], "--monitor") && i + 2 < argc) {
            unsigned long value = strtoul(argv[++i], &end, 10);
            if (!argv[i][0] || *end || !value || value > 32768) return 2;
            monitorWidth = (uint32_t)value;
            value = strtoul(argv[++i], &end, 10);
            if (!argv[i][0] || *end || !value || value > 32768) return 2;
            monitorHeight = (uint32_t)value;
        } else return 2;
    }
    char scenePath[PATH_MAX];
    if (sceneOutput && !capturePath(sceneOutput, scenePath)) { fprintf(stderr, "Scene capture requires a new absolute path outside the original game directory\n"); return 2; }
    Engine_t engine = {0}; gEngine = &engine; Engine_Init(gEngine);
    if (!MLBGI_ConfigureDialect(gEngine, dialect, monitorWidth, monitorHeight)) { Engine_Free(gEngine); return 2; }
    MLBGI_Runtime *state = engine.mlRuntime;
    if (state->dialect == MLBGI_ETHORNELL_172 && !MLBGI_AttachThreads(&engine)) { Engine_Free(gEngine); return 2; }
    if (state->dialect == MLBGI_ETHORNELL_172 && !MLBGI_AttachBitmapLoader(&engine)) { Engine_Free(gEngine); return 2; }
    if (state->dialect == MLBGI_ETHORNELL_172 && !MLBGI_AttachTextRenderer(&engine)) { Engine_Free(gEngine); return 2; }
    if (stateDirectory && !MLBGI_ConfigureFiles(&state->files, stateDirectory)) { fprintf(stderr, "Invalid isolated BGI state directory\n"); Engine_Free(gEngine); return 2; }
    if (identifierHex) {
        size_t length = strlen(identifierHex);
        if (!length || length > 192 || length & 1) { Engine_Free(gEngine); return 2; }
        for (size_t i = 0; i < length / 2; i++) {
            unsigned value = 0;
            for (unsigned j = 0; j < 2; j++) {
                unsigned char character = (unsigned char)identifierHex[i * 2 + j];
                if (!isxdigit(character)) { Engine_Free(gEngine); return 2; }
                value = value * 16 + (isdigit(character) ? character - '0' : tolower(character) - 'a' + 10);
            }
            if (!value) { Engine_Free(gEngine); return 2; }
            state->projectIdentifier[i] = (char)value;
        }
        if (!MLBGI_ValidSearchPath(state->projectIdentifier)) { Engine_Free(gEngine); return 2; }
        for (size_t i = 0; state->projectIdentifier[i]; i++) {
            unsigned char c = (unsigned char)state->projectIdentifier[i];
            if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) i++;
            else if (c == '/' || c == '\\') { Engine_Free(gEngine); return 2; }
        }
    }
    uint32_t id = state->dialect == MLBGI_ETHORNELL_172 ? MLBGI_LoadBootProgram(gEngine) :
        Engine_LoadProgram(gEngine, "system", "ipl._bp", 0x1000, 0x20000, 0x20000);
    Thread_t *thread = Engine_GetThreadById(gEngine, id);
    if (!thread || thread->error || id < 2) {
        fprintf(stderr, "BGI boot program could not be loaded: %s\n", MLBGI_ArchiveError());
        Engine_Free(gEngine); MLBGI_FreeArchiveCache(); return 2;
    }
    uint32_t result = 0, opcode = 0, address = 0; unsigned long ticks = 0;
    thread->running = 1;
    Thread_t *lastExecuted = thread;
    while (ticks < limit) {
        uint32_t milliseconds = MLBGI_Milliseconds();
        if (!thread->running || !MLBGI_ThreadReady(thread, milliseconds)) {
            Thread_t *next = state->dialect == MLBGI_ETHORNELL_172 ? MLBGI_NextReadyThread(&engine, thread->threadId, milliseconds) : NULL;
            if (next) thread = next;
            else {
                int live = 0; for (Thread_t *entry = engine.threads; entry; entry = entry->previousThread) if (entry->running) live = 1;
                if (!live) break;
                struct timespec interval = {0, 1000000}; nanosleep(&interval, NULL); continue;
            }
        }
        address = thread->nextInstructionPointer;
        thread->silenceBasicOpcodeLog = !(ticks >= traceStart && ticks < traceEnd);
        lastExecuted = thread;
        result = Thread_Execute(thread); opcode = thread->opcode; ticks++;
        if (result == 4 && !thread->error) thread->running = 0;
        else if (result > 3 || thread->error) break;
        if (engine.nextThreadRequest) {
            Thread_t *next = Engine_GetThreadById(gEngine, engine.nextThreadRequest); engine.nextThreadRequest = 0;
            if (!next) { result = UINT32_MAX - 3; break; }
            thread = next;
        } else if (state->dialect == MLBGI_ETHORNELL_172) {
            Thread_t *next = MLBGI_NextReadyThread(&engine, thread->threadId, MLBGI_Milliseconds());
            if (next) thread = next;
        }
    }
    /* Record the executed descriptor, not the scheduler's next candidate. */
    thread = lastExecuted;
    /* A tick limit is not a successful game launch. Unknown services fail. */
    printf("{\"probeVersion\":\"0.0.1-build734-mac-vm-v2\",\"dialect\":\"%s\",\"ticks\":%lu,\"address\":%u,\"opcode\":%u,\"result\":%u,\"error\":%d,\"limitReached\":%s,\"gameplayQualified\":false,\"startupServices\":%u,\"backgroundPolicy\":%u,\"display\":[%u,%u],\"monitor\":[%u,%u],\"stackCursor\":%u,\"localFrame\":%u,\"programCount\":%u,\"codeBytes\":%u,\"stackTail\":[",
           dialect, ticks, address, opcode, result, thread->error, ticks == limit && result <= 3 && !thread->error ? "true" : "false",
           state->startupServices, state->backgroundPolicy, state->displayWidths[state->displaySlot], state->displayHeights[state->displaySlot], monitorWidth, monitorHeight,
           thread->stackPointer, thread->basePointer, thread->programCount, thread->codeSpaceUsed);
    uint32_t words = MLBGI_IsModern(thread) ? (thread->stackSize < 32 ? thread->stackSize : 32) : (thread->stackPointer < 32 ? thread->stackPointer : 32);
    for (uint32_t i = 0; i < words; i++) {
        uint32_t cursor = MLBGI_IsModern(thread) ? (thread->stackPointer + thread->stackSize - words + i) % thread->stackSize : thread->stackPointer - words + i;
        printf("%s%u", i ? "," : "", thread->stack[cursor]);
    }
    unsigned threadCount = 0; for (Thread_t *entry = engine.threads; entry; entry = entry->previousThread) threadCount++;
    printf("],\"threadId\":%u,\"threadCount\":%u,\"archiveGroups\":%u,\"threads\":[", thread->threadId, threadCount, state->archiveGroupCount);
    unsigned index = 0;
    for (Thread_t *entry = engine.threads; entry; entry = entry->previousThread) {
        printf("%s{\"id\":%u,\"running\":%s,\"error\":%d,\"address\":%u,\"nextAddress\":%u,\"opcode\":%u,\"codeBytes\":%u,\"programCount\":%u,\"stackCursor\":%u,\"waitActive\":%s,\"waitDeadline\":%u}",
            index++ ? "," : "", entry->threadId, entry->running ? "true" : "false", entry->error, entry->instructionPointer, entry->nextInstructionPointer,
            entry->opcode, entry->codeSpaceUsed, entry->programCount, entry->stackPointer, entry->mlWaitActive ? "true" : "false", entry->mlWaitDeadline);
    }
    printf("],\"windows\":[");
    index = 0;
    for (unsigned i = 0; i < 16; i++) if (state->windows[i].allocated) {
        const MLBGI_WindowObject *window = &state->windows[i];
        printf("%s{\"handle\":%u,\"visible\":%u,\"position\":[%d,%d],\"offset\":[%d,%d],\"size\":[%u,%u],\"opacity\":[%u,%u,%u],\"blendMode\":%u,\"order\":%u}",
            index++ ? "," : "", 0xb0000000 | i, window->visible, window->x, window->y, window->offsetX, window->offsetY,
            window->width, window->height, window->opacity, window->secondaryOpacity, window->opacityScale, window->blendMode, window->order);
    }
    printf("],\"sprites\":[");
    index = 0;
    for (unsigned i = 0; i < 512; i++) if (state->sprites[i].object.allocated) {
        const MLBGI_Sprite *sprite = &state->sprites[i]; const MLBGI_Filter *object = &sprite->object;
        printf("%s{\"handle\":%u,\"visible\":%u,\"position\":[%d,%d],\"offset\":[%d,%d],\"size\":[%u,%u],\"opacity\":[%u,%u,%u],\"blendMode\":%u,\"order\":%u,\"bitmapSlot\":%u}",
            index++ ? "," : "", 0x80000000 | i, object->visible, object->x, object->y, object->offsetX, object->offsetY,
            sprite->image.width, sprite->image.height, object->opacity, object->secondaryOpacity, object->opacityScale,
            sprite->blendMode, object->order, sprite->bitmapSlot);
    }
    printf("],\"controllers\":[");
    index = 0;
    for (unsigned i = 0; i < 64; i++) if (state->controllers[i].id) {
        const MLBGI_Controller *controller = &state->controllers[i];
        printf("%s{\"id\":%u,\"target\":%u,\"kind\":%u,\"enabled\":%u,\"items\":%u,\"images\":%u,\"imageBytes\":%zu}",
            index++ ? "," : "", controller->id, controller->target, controller->kind, controller->enabled,
            controller->menu ? controller->menu->itemCount : 0, controller->menu ? controller->menu->imageCount : 0,
            controller->menu ? controller->menu->bytes : 0);
    }
    printf("]}\n");
    if (memoryBytes) {
        /* Inspect a copied thread descriptor so an invalid diagnostic address
           cannot alter the interpreter's recorded stop condition. */
        Thread_t descriptor = *thread;
        uint8_t *bytes = MLBGI_ResolveAddress(&descriptor, memoryAddress);
        int valid = bytes && MLBGI_MemoryRemaining(&engine, bytes) >= memoryBytes;
        printf("{\"memoryAddress\":%u,\"memoryBytes\":%u,\"dataHex\":", memoryAddress, memoryBytes);
        if (!valid) printf("null");
        else { printf("\""); for (uint32_t i = 0; i < memoryBytes; i++) printf("%02x", bytes[i]); printf("\""); }
        printf("}\n");
    }
    int status = result > 3 || thread->error ? 3 : 4;
    if (sceneOutput && !captureScene(&engine, scenePath)) { fprintf(stderr, "Native BGI scene capture failed\n"); status = 3; }
    Engine_Free(gEngine); MLBGI_FreeArchiveCache(); return status;
}
