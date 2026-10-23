const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const INPUTS = require("./source-inputs.json");

const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const VERSION = "0.0.1-build734-mac-vm-v2";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const within = (root, value) => value === root || value.startsWith(root + path.sep);
const OWNED = ["archive-reader.c", "archive-reader.h", "vm-guards.c", "vm-guards.h", "vm-dialect.c", "vm-dialect.h", "vm-threads.c", "vm-threads.h", "vm-strings.c", "vm-strings.h", "vm-input.c", "vm-input.h", "platform-input.c", "platform-input.h", "platform-window.c", "platform-window.h", "platform-renderer.c", "platform-renderer.h", "platform-text.c", "platform-text.h", "bitmap-loader.c", "bitmap-loader.h", "particle-resources.c", "particle-resources.h", "raw-bitmap.c", "raw-bitmap.h", "cbg-bitmap.c", "cbg-bitmap.h", "state-files.c", "state-files.h", "probe-main.c"];

function replaceOnce(text, before, after, file) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned OpenBGI overlay context changed: ${file}`);
  return text.replace(before, after);
}
function replaceFunction(text, start, next, body, file) {
  const first = text.indexOf(start), end = text.indexOf(next, first + start.length);
  if (first < 0 || end < 0 || text.indexOf(start, first + 1) >= 0) throw new Error(`Pinned OpenBGI function context changed: ${file}`);
  return text.slice(0, first) + body + "\n\n" + text.slice(end);
}
function patch(file, original) {
  let text = original.toString("utf8");
  if (file === "src/engine.h") text = replaceOnce(text, "uint8_t* auxMemory[48];", "uint8_t* auxMemory[48];\n    uint32_t auxMemorySizes[48];\n    void* mlRuntime;", file);
  if (file === "src/thread.h") text = text.replace("#include <stdint.h>", "#include <stdint.h>\n#include <stddef.h>")
    .replace("Thread_LoadCode(Thread_t* thread, uint8_t* code, const char* filename)", "Thread_LoadCode(Thread_t* thread, uint8_t* code, size_t codeBytes, const char* filename)");
  if (file === "src/thread.h") text = replaceOnce(text, "uint32_t unknownTimestamp;",
    "uint32_t unknownTimestamp;\n    uint32_t mlWaitDeadline;\n    int mlWaitActive;\n    int mlWaitOutputPending;\n    int mlWaitInputEnabled;\n    uint32_t mlWaitInputBaseline[256];\n    uint32_t mlMessages[1024];\n    unsigned mlMessageHead, mlMessageCount;", file);
  if (file === "src/engine.c") {
    text = replaceOnce(text, '#include "os.h"', '#include "os.h"\n#include "archive-reader.h"\n#include "vm-guards.h"\n#include "vm-dialect.h"', file);
    text = replaceOnce(text, "engine->window = NULL;", "engine->window = NULL;\n\tengine->mlRuntime = NULL;", file);
    text = replaceOnce(text, "for(int i = 0; i < 48; i++)\n\t\tengine->auxMemory[i] = NULL;", "for(int i = 0; i < 48; i++) { engine->auxMemory[i] = NULL; engine->auxMemorySizes[i] = 0; }", file);
    text = replaceOnce(text, "Thread_t* thread = (Thread_t*)malloc(sizeof(Thread_t));", `if (!stackSize || stackSize > 0x100000 || !codeSize || codeSize > 0x2000000 || !memorySize || memorySize > 0x2000000) return NULL;\n\tThread_t* thread = (Thread_t*)calloc(1, sizeof(Thread_t));\n\tif (!thread) return NULL;`, file);
    text = text.replace("(uint8_t*)malloc(stackSize * sizeof(uint32_t))", "(uint8_t*)calloc(stackSize, sizeof(uint32_t))")
      .replace("(uint8_t*)malloc(codeSize)", "(uint8_t*)calloc(1, codeSize)").replace("(uint8_t*)malloc(memorySize)", "(uint8_t*)calloc(1, memorySize)");
    text = replaceOnce(text, "thread->silenceBasicOpcodeLog = 1;", `if (!thread->stack || !thread->code || !thread->localMem) { thread->error = 1; return thread; }\n\tthread->silenceBasicOpcodeLog = 1;`, file);
    text = replaceFunction(text, "uint8_t* Engine_ReadFile(", "uint32_t Engine_LoadProgram(", `uint8_t* Engine_ReadFile(Engine_t* engine, const char* archive, const char* filename, size_t* outSize)\n{\n    return MLBGI_ReadEngineResource(engine, archive, filename, outSize);\n}`, file);
    text = replaceOnce(text, "size_t fileSize;\n\tuint8_t* code = Engine_ReadFile", "if (!thread || thread->error) return 1;\n\tsize_t fileSize;\n\tuint8_t* code = Engine_ReadFile", file);
    text = replaceOnce(text, "if(code == NULL)\n\t\treturn 1;\n\tThread_LoadCode(thread, code, filename);", "if(code == NULL) { thread->error = 1; return 1; }\n\tuint32_t loaded = Thread_LoadCode(thread, code, fileSize, filename);", file);
    text = replaceOnce(text, "return thread->threadId;\n}\n\nuint32_t Engine_ReadFileToMemory", "return loaded == UINT32_MAX ? 1 : thread->threadId;\n}\n\nuint32_t Engine_ReadFileToMemory", file);
    text = replaceFunction(text, "uint32_t Engine_ReadFileToMemory(", "Thread_t* Engine_GetThreadById(", `uint32_t Engine_ReadFileToMemory(Engine_t* engine, const char* archive, const char* filename, uint8_t* buffer)\n{\n    size_t size = 0, capacity = MLBGI_MemoryRemaining(engine, buffer);\n    uint8_t *bytes = MLBGI_ReadFile(archive, filename, &size);\n    if (!bytes) return 0;\n    if (size > capacity) { free(bytes); engine->isRunning = 0; return 0; }\n    memcpy(buffer, bytes, size); free(bytes); return (uint32_t)size;\n}`, file);
    text = replaceOnce(text, "engine->auxMemory[i] = (uint8_t*)malloc(size);", "engine->auxMemory[i] = (uint8_t*)calloc(1, size);\n\t\tif (!engine->auxMemory[i]) return 0;\n\t\tengine->auxMemorySizes[i] = size;", file);
    text = replaceOnce(text, "\t\tOS_Poll();", "\t\tOS_Poll();\n\t\tif (!MLBGI_ShouldExecute(engine, !engine->window || (SDL_GetWindowFlags(engine->window) & SDL_WINDOW_INPUT_FOCUS))) { Engine_Sleep(10000); continue; }", file);
    text = replaceOnce(text, "\t\tOS_Poll();", "\t\tOS_Poll();\n\t\tif (MLBGI_FrameDue(engine, SDL_GetTicks()) && MLBGI_ShouldRender(engine, !engine->window || (SDL_GetWindowFlags(engine->window) & SDL_WINDOW_INPUT_FOCUS))) { Renderer_DrawScreen(engine->renderer); MLBGI_FramePresented(engine, SDL_GetTicks()); }", file);
    text = replaceOnce(text, "\tRenderer_Free(engine->renderer);", "\tRenderer_Free(engine->renderer);\n\tMLBGI_FreeDialect(engine);", file);
  }
  if (file === "src/thread.c") {
    text = replaceOnce(text, '#include "golden_log.h"', '#include "golden_log.h"\n#include "vm-guards.h"\n#include "vm-dialect.h"', file);
    text = replaceFunction(text, "uint32_t Thread_LoadCode(", "uint32_t Thread_DeleteProgram(", `uint32_t Thread_LoadCode(Thread_t* thread, uint8_t* code, size_t codeBytes, const char* filename)\n{\n    return MLBGI_LoadCode(thread, code, codeBytes, filename);\n}`, file);
    for (const [name, bytes] of [["Thread_ReadImm8", 1], ["Thread_ReadCode8", 1], ["Thread_ReadCode16", 2], ["Thread_ReadCode32", 4]]) {
      const signature = new RegExp(`(uint(?:8|16|32)_t ${name}\\(Thread_t\\* thread\\)\\n\\{)`);
      if (!signature.test(text)) throw new Error(`Missing OpenBGI read guard context: ${name}`);
      text = text.replace(signature, `$1\n\tif (!MLBGI_CodeAvailable(thread, ${bytes})) return 0;`);
    }
    text = replaceOnce(text, "thread->code[thread->nextInstructionPointer] | \n\t\t(thread->code[thread->nextInstructionPointer + 1] << 8) |\n\t\t(thread->code[thread->nextInstructionPointer + 2] << 16) |\n\t\t(thread->code[thread->nextInstructionPointer + 3] << 24)", "(uint32_t)thread->code[thread->nextInstructionPointer] | \n\t\t((uint32_t)thread->code[thread->nextInstructionPointer + 1] << 8) |\n\t\t((uint32_t)thread->code[thread->nextInstructionPointer + 2] << 16) |\n\t\t((uint32_t)thread->code[thread->nextInstructionPointer + 3] << 24)", file);
    text = replaceOnce(text, "uint8_t opcode = Thread_ReadImm8(thread);", "uint8_t opcode = Thread_ReadImm8(thread);\n\tif (thread->error) return 0xFFFFFFFC;", file);
    text = replaceOnce(text, "uint32_t Thread_Execute(Thread_t* thread)\n{",
      "uint32_t Thread_Execute(Thread_t* thread)\n{\n    if (!MLBGI_ThreadReady(thread, MLBGI_Milliseconds())) return 2;", file);
    text = replaceOnce(text, "if(GoldenLog[GoldenLogIndex].thread == thread->threadId && GoldenLog[GoldenLogIndex].tick == thread->ticks)", "if(GoldenLogIndex < GoldenLogTotal && GoldenLog[GoldenLogIndex].thread == thread->threadId && GoldenLog[GoldenLogIndex].tick == thread->ticks)", file);
    text = replaceOnce(text, "while(GoldenLog[idx].tick == thread->ticks)", "while(idx < GoldenLogTotal && GoldenLog[idx].tick == thread->ticks)", file);
    text = text.replaceAll("if(GoldenLogTotal)", "if(GoldenLogIndex < GoldenLogTotal)");
    text = replaceOnce(text, "void Thread_PushStack(Thread_t* thread, uint32_t data)\n{",
      `void Thread_PushStack(Thread_t* thread, uint32_t data)\n{\n    if (MLBGI_IsModern(thread)) {\n        if (!thread->stack || !thread->stackSize || thread->stackPointer >= thread->stackSize) { thread->error = 1; thread->running = 0; return; }\n        uint32_t cursor = thread->stackPointer;\n        thread->stack[cursor] = data;\n        thread->stackPointer = cursor + 1 == thread->stackSize ? 0 : cursor + 1;\n        if (!thread->silenceBasicOpcodeLog) printf("[Thread %d]: PushStack(0x%.8X) @ 0x%.8X\\n", thread->threadId, data, cursor);\n        return;\n    }`, file);
    text = replaceOnce(text, "uint32_t Thread_PopStack(Thread_t* thread)\n{",
      `uint32_t Thread_PopStack(Thread_t* thread)\n{\n    if (MLBGI_IsModern(thread)) {\n        if (!thread->stack || !thread->stackSize || thread->stackPointer >= thread->stackSize) { thread->error = 1; thread->running = 0; return 0; }\n        uint32_t cursor = thread->stackPointer ? thread->stackPointer - 1 : thread->stackSize - 1;\n        uint32_t data = thread->stack[cursor]; thread->stackPointer = cursor;\n        if (!thread->silenceBasicOpcodeLog) printf("[Thread %d]: PopStack() @ 0x%.8X = 0x%.8X\\n", thread->threadId, cursor, data);\n        return data;\n    }`, file);
    text = replaceOnce(text, "if(thread->stackPointer == thread->stackSize)", "if(thread->stackPointer >= thread->stackSize)", file);
    text = replaceOnce(text, "thread->queuePushQueue[thread->queuePush] = data;", "if (thread->queuePush >= 10) { thread->error = 1; thread->running = 0; return; }\n\tthread->queuePushQueue[thread->queuePush] = data;", file);
    text = replaceOnce(text, "thread->nextInstructionPointer = value;", "if (value >= thread->codeSpaceUsed) { thread->error = 1; thread->running = 0; return; }\n\tthread->nextInstructionPointer = value;", file);
    text = replaceOnce(text, "thread->basePointer = value;", "if (value > thread->localMemSize) { thread->error = 1; thread->running = 0; return; }\n\tthread->basePointer = value;", file);
    text = replaceFunction(text, "uint8_t* Thread_ResolveAddr(", "uint8_t* Thread_PopAndResolveAddress(", `uint8_t* Thread_ResolveAddr(Thread_t* thread, uint32_t address)\n{\n    return MLBGI_ResolveAddress(thread, address);\n}`, file);
    text = replaceFunction(text, "uint32_t Thread_WriteIntToMemory(", "void Thread_WriteReturnAddr(", `uint32_t Thread_WriteIntToMemory(Thread_t* thread, uint8_t* ptr, uint8_t size, uint32_t value)\n{\n    return MLBGI_WriteInteger(thread, ptr, size, value);\n}`, file);
    text = replaceOnce(text, "*(uint32_t*)(thread->localMem + thread->basePointer) = addr;", "if (thread->basePointer > thread->localMemSize || thread->localMemSize - thread->basePointer < 4) { thread->error = 1; return; }\n\tmemcpy(thread->localMem + thread->basePointer, &addr, 4);", file);
    text = replaceOnce(text, "thread->basePointer -= 4;\n\treturn *(uint32_t *)(thread->localMem + thread->basePointer);", "if (thread->basePointer < 4 || thread->basePointer > thread->localMemSize) { thread->error = 1; return 0; }\n\tthread->basePointer -= 4;\n\tuint32_t value; memcpy(&value, thread->localMem + thread->basePointer, 4); return value;", file);
  }
  if (file === "src/opcodes_sys0.c") text = replaceOnce(text, "Thread_LoadCode(thread, code, filename)", "Thread_LoadCode(thread, code, fileSize, filename)", file);
  if (file === "src/opcodes.c") {
    text = replaceOnce(text, '#include "golden_log.h"', '#include "golden_log.h"\n#include "vm-dialect.h"\n#include "vm-strings.h"', file);
    for (const [name, next, adapted] of [["Sprintf", "Memcpy", "FormatString"], ["Memcpy", "IsZero", "CopyMemory"], ["Memclr", "Strcpy", "ClearMemory"], ["Strcpy", "StrToLower", "CopyString"], ["Strlen", "Streq", "StringLength"], ["Streq", "Nop", "EqualStrings"]]) {
      if (name === "Streq") {
        text = replaceOnce(text, "\tuint8_t* str1 = Thread_PopAndResolveAddress(thread);\n\tuint8_t* str2 = Thread_PopAndResolveAddress(thread);\n\tThread_PushStack(thread, strcmp(str1, str2) == 0);\n\treturn 0;", "\treturn MLBGI_EqualStrings(thread);", file);
      } else text = replaceFunction(text, `uint32_t Opcode_${name}(`, `uint32_t Opcode_${next}(`, `uint32_t Opcode_${name}(Thread_t* thread)\n{\n    return MLBGI_${adapted}(thread);\n}`, file);
    }
    text = replaceOnce(text, '/* 0x81 129 */ "Unknown",', '/* 0x81 129 */ "Sys1",', file);
    text = replaceOnce(text, '/* 0x63  99 */ "Unknown",', '/* 0x63  99 */ "EqualMemory",', file);
    text = replaceOnce(text, '/* 0x63  99 */ 0,', '/* 0x63  99 */ MLBGI_EqualMemory,', file);
    for (const [opcode, decimal, name] of [["48", "72", "Sine"], ["49", "73", "Cosine"]]) {
      text = replaceOnce(text, `/* 0x${opcode}  ${decimal} */ "Unknown",`, `/* 0x${opcode}  ${decimal} */ "Fixed${name}",`, file);
      text = replaceOnce(text, `/* 0x${opcode}  ${decimal} */ 0,`, `/* 0x${opcode}  ${decimal} */ MLBGI_Fixed${name},`, file);
    }
    text = replaceOnce(text, '/* 0x81 129 */ 0,', '/* 0x81 129 */ MLBGI_DispatchSys1,', file);
    text = replaceOnce(text, "\tif(OpcodesSys0[opcode] == NULL)", "\tuint32_t adaptedResult;\n\tif (MLBGI_TryService(thread, 0x80, opcode, &adaptedResult)) { thread->level--; return adaptedResult; }\n\tif(OpcodesSys0[opcode] == NULL)", file);
    for (const [name, group] of [["Grp0", 0x90], ["Grp1", 0x91], ["Grp2", 0x92], ["Snd0", 0xa0], ["Ext0", 0xb0], ["Ext1", 0xc0]])
      text = replaceOnce(text, `\tif(Opcodes${name}[opcode] == NULL)`, `\tuint32_t adaptedResult;\n\tif (MLBGI_TryService(thread, ${group}, opcode, &adaptedResult)) { thread->level--; return adaptedResult; }\n\tif(Opcodes${name}[opcode] == NULL)`, file);
    text = replaceOnce(text, "uint16_t data = Thread_ReadCode16(thread);\n\tuint32_t ip = Thread_GetInstructionPointer(thread);\n\tdata += ip;\n\tThread_PushStack(thread, data);", "uint16_t encoded = Thread_ReadCode16(thread);\n\tuint32_t ip = Thread_GetInstructionPointer(thread);\n\tint64_t target = (int64_t)ip + (MLBGI_IsModern(thread) ? (int16_t)encoded : (int32_t)encoded);\n\tif (target < 0 || target >= thread->codeSpaceUsed) { thread->error = 1; return 0xFFFFFFFC; }\n\tThread_PushStack(thread, (uint32_t)target);", file);
    text = replaceOnce(text, "Thread_PushStack(thread, (ip + offset) | 0x11000000);", "int64_t target = (int64_t)ip + (MLBGI_IsModern(thread) ? (int16_t)offset : (int32_t)offset);\n\tif (target < 0 || target >= thread->codeSpaceUsed) { thread->error = 1; return 0xFFFFFFFC; }\n\tThread_PushStack(thread, MLBGI_CodeAddress(thread, (uint32_t)target));", file);
    text = replaceOnce(text, "uint32_t taggedValue    = relativeOffset | 0x10000000;", "uint32_t taggedValue = MLBGI_LocalAddress(thread, relativeOffset);", file);
    text = replaceFunction(text, "uint32_t Opcode_Leq(", "uint32_t Opcode_Geq(", `uint32_t Opcode_Leq(Thread_t* thread)\n{\n    int32_t right = (int32_t)Thread_PopStack(thread), left = (int32_t)Thread_PopStack(thread);\n    Thread_PushStack(thread, MLBGI_IsModern(thread) ? left <= right : left >= right);\n    return 0;\n}`, file);
    text = replaceFunction(text, "uint32_t Opcode_CondJump(", "uint32_t Opcode_Call(", `uint32_t Opcode_CondJump(Thread_t* thread)\n{\n    uint32_t destination = Thread_PopStack(thread), bits = Thread_PopStack(thread);\n    uint8_t mode = Thread_ReadCode8(thread);\n    int32_t signedValue = (int32_t)bits;\n    int modern = MLBGI_IsModern(thread), take;\n    switch (mode) {\n        case 0: take = bits != 0; break;\n        case 1: take = bits == 0; break;\n        case 2: take = modern && signedValue < 0; break;\n        case 3: take = !modern || signedValue >= 0; break;\n        case 4: take = modern ? signedValue <= 0 : bits == 0; break;\n        case 5: take = modern ? signedValue > 0 : bits > 0; break;\n        default: thread->error = 1; return 0xFFFFFFFC;\n    }\n    if (thread->error) return 0xFFFFFFFC;\n    if (take) Thread_SetInstructionPointer(thread, destination);\n    return thread->error ? 0xFFFFFFFC : 0;\n}`, file);
    text = replaceFunction(text, "uint32_t Opcode_ReadMem(", "uint32_t Opcode_WriteCopy(", `uint32_t Opcode_ReadMem(Thread_t* thread)\n{\n    uint8_t* ptr = Thread_PopAndResolveAddress(thread);\n    if (thread->error) return 0xFFFFFFFC;\n    uint8_t size = Thread_ReadCode8(thread);\n    if (thread->error) return 0xFFFFFFFC;\n    uint32_t value = MLBGI_ReadInteger(thread, ptr, size);\n    if (thread->error) return 0xFFFFFFFC;\n    Thread_PushStack(thread, value); return 0;\n}`, file);
    for (const name of ["Sys0", "Grp0", "Grp1", "Grp2", "Snd0", "Ext0", "Ext1"]) {
      const trace = '\tprintf("[Thread %d]: %s' + name + ' Executing opcode ' + name + '.%s (0x%.2X / %d) (%d)\\n", thread->threadId, TLevel[thread->level], Opcodes' + name + 'Mnemonics[opcode], opcode, opcode, GoldenLog[GoldenLogIndex].time);';
      text = replaceOnce(text, trace, '\tif (!MLBGI_IsModern(thread) || !thread->silenceBasicOpcodeLog)' + trace.trimStart(), file);
    }
    if (text.split("GoldenLog[GoldenLogIndex].time").length - 1 !== 7) throw new Error("OpenBGI dispatch logging context changed.");
    text = text.replaceAll("GoldenLog[GoldenLogIndex].time", "thread->ticks");
    text = text.replaceAll("uint8_t opcode = Thread_ReadCode8(thread);", "uint8_t opcode = Thread_ReadCode8(thread);\n\tif (thread->error) return 0xFFFFFFFC;");
  }
  if (file === "src/os.c") {
    text = replaceOnce(text, '#include "engine.h"', '#include "engine.h"\n#include "vm-dialect.h"\n#include "platform-input.h"\n#include "platform-window.h"', file);
    text = replaceOnce(text, "SDL_WINDOW_SHOWN            // Flags (make it visible)", "engine->mlRuntime && ((MLBGI_Runtime *)engine->mlRuntime)->dialect == MLBGI_ETHORNELL_172 ? SDL_WINDOW_HIDDEN : SDL_WINDOW_SHOWN", file);
    text = replaceOnce(text, "engine->window = window;", "engine->window = window;\n    if (engine->mlRuntime) MLBGI_AttachSDLWindow(engine);", file);
    text = replaceOnce(text, "\twhile(SDL_PollEvent(&event))\n\t{", "\twhile(SDL_PollEvent(&event))\n\t{\n        MLBGI_Runtime *state = osEngine ? osEngine->mlRuntime : NULL;\n        if (state && state->dialect == MLBGI_ETHORNELL_172) {\n            MLBGI_SDLInputEvent(&state->input, &event, MLBGI_Milliseconds());\n            if (event.type == SDL_KEYDOWN && !event.key.repeat && MLBGI_DisplayHotkey(osEngine, MLBGI_SDLKey(event.key.keysym.sym))) MLBGI_ToggleSDLWindow(osEngine);\n        }", file);
    text = replaceOnce(text, "if(event.type == SDL_QUIT)", "if ((event.type == SDL_QUIT || (event.type == SDL_WINDOWEVENT && event.window.event == SDL_WINDOWEVENT_CLOSE)) && MLBGI_WindowCloseAllowed(osEngine))", file);
    text = replaceOnce(text, "    }\n}\n\nint OS_Quit()", `    }\n    if (osEngine && osEngine->window) {\n        int x = 0, y = 0, width = 0, height = 0;\n        SDL_GetMouseState(&x, &y); SDL_GetWindowSize(osEngine->window, &width, &height);\n        uint32_t flags = SDL_GetWindowFlags(osEngine->window);\n        int focused = (flags & SDL_WINDOW_INPUT_FOCUS) && !(flags & SDL_WINDOW_MINIMIZED);\n        SDL_ShowCursor(MLBGI_UpdateCursor(osEngine, focused, x, y, width > 0 ? (uint32_t)width : 0, height > 0 ? (uint32_t)height : 0, MLBGI_Milliseconds()) ? SDL_ENABLE : SDL_DISABLE);\n    }\n    return 0;\n}\n\nint OS_Quit()`, file);
  }
  if (file === "src/renderer.h") {
    text = replaceOnce(text, "void Renderer_LoadBitmap(", "int Renderer_LoadBitmap(", file);
    text = replaceOnce(text, "#define RENDERER_MAX_BITMAPS 0x1000", "#define RENDERER_MAX_BITMAPS 0x4000", file);
    text = replaceOnce(text, "typedef struct Bitmap\n{\n\tint width;\n\tint height;", "typedef struct Bitmap\n{\n\tint width;\n\tint height;\n    uint32_t format;", file);
  }
  if (file === "src/renderer.c") {
    text = replaceOnce(text, '#include "spng.h"', '#include "spng.h"\n#include "bitmap-loader.h"\n#include "platform-renderer.h"\n#include "vm-dialect.h"', file);
    text = replaceFunction(text, "void Renderer_LoadBitmap(", "void Renderer_DrawScreen(", `int Renderer_LoadBitmap(Renderer_t* renderer, int slot, const char* filename, const char* archive)\n{\n    return MLBGI_LoadBitmap(renderer, slot, filename, archive);\n}`, file);
    text = replaceOnce(text, "void Renderer_DrawScreen(Renderer_t* renderer)\n{",
      `void Renderer_DrawScreen(Renderer_t* renderer)\n{\n    MLBGI_Runtime *state = renderer && renderer->engine ? renderer->engine->mlRuntime : NULL;\n    if (state && state->dialect == MLBGI_ETHORNELL_172) {\n        if (!MLBGI_PresentSDLScene(renderer->engine)) { fprintf(stderr, "[BGI]: Scene presentation failed\\n"); renderer->engine->isRunning = 0; }\n        return;\n    }`, file);
  }
  return Buffer.from(text);
}
function canonicalOutput(value) {
  let current = path.resolve(value), parts = [];
  while (!fs.existsSync(current)) { parts.unshift(path.basename(current)); current = path.dirname(current); }
  return path.join(fs.realpathSync(current), ...parts);
}
/** Developer-only immutable input staging. Nothing runs or downloads here. */
function stageSource({ sourceRoot, destination } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(destination || "")) throw new Error("Explicit absolute OpenBGI source and output directories are required.");
  const source = fs.realpathSync(sourceRoot), output = canonicalOutput(destination);
  if (within(source, output) || within(output, source) || fs.existsSync(output)) throw new Error("Stage OpenBGI into a fresh directory outside its read-only source.");
  if (INPUTS.sourceRevision !== SOURCE_REVISION) throw new Error("OpenBGI source identity differs from its pinned overlay.");
  const staged = [];
  for (const input of INPUTS.files) {
    const file = path.join(source, input.path), stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !within(source, fs.realpathSync(file)) || stat.size !== BigInt(input.size)) throw new Error(`OpenBGI input changed: ${input.path}`);
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => stat[key] !== after[key]) || sha256(bytes) !== input.sha256) throw new Error(`OpenBGI input changed: ${input.path}`);
    staged.push({ path: input.path === "src/main.c" ? "upstream/main.c" : input.path,
      bytes: patch(input.path, bytes), originalPath: input.path, originalSha256: input.sha256 });
  }
  for (const file of OWNED) {
    const owned = path.join(__dirname, file), stat = fs.lstatSync(owned);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid OpenBGI owned source: ${file}`);
    staged.push({ path: file === "probe-main.c" ? "src/main.c" : `src/${file}`, bytes: fs.readFileSync(owned), owned: true });
  }
  fs.mkdirSync(output, { recursive: true });
  const records = [];
  for (const file of staged) {
    const target = path.join(output, file.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: "wx", mode: 0o644 });
    records.push({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes),
      ...(file.originalSha256 ? { originalPath: file.originalPath, originalSha256: file.originalSha256 } : { owned: true }) });
  }
  return { version: VERSION, sourceRevision: SOURCE_REVISION, gameplayQualified: false, files: records, sourceTreeSha256: sha256(JSON.stringify(records)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS, OWNED, stageSource, patch, sha256 };
