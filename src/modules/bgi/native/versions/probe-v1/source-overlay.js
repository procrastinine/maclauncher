const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const INPUTS = require("./source-inputs.json");

const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const VERSION = "0.0.1-build734-mac-probe-v1";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const within = (root, value) => value === root || value.startsWith(root + path.sep);
const OWNED = ["archive-reader.c", "archive-reader.h", "vm-guards.c", "vm-guards.h", "probe-main.c"];

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
  if (file === "src/engine.h") text = replaceOnce(text, "uint8_t* auxMemory[48];", "uint8_t* auxMemory[48];\n    uint32_t auxMemorySizes[48];", file);
  if (file === "src/thread.h") text = text.replace("#include <stdint.h>", "#include <stdint.h>\n#include <stddef.h>")
    .replace("Thread_LoadCode(Thread_t* thread, uint8_t* code, const char* filename)", "Thread_LoadCode(Thread_t* thread, uint8_t* code, size_t codeBytes, const char* filename)");
  if (file === "src/engine.c") {
    text = replaceOnce(text, '#include "os.h"', '#include "os.h"\n#include "archive-reader.h"\n#include "vm-guards.h"', file);
    text = replaceOnce(text, "for(int i = 0; i < 48; i++)\n\t\tengine->auxMemory[i] = NULL;", "for(int i = 0; i < 48; i++) { engine->auxMemory[i] = NULL; engine->auxMemorySizes[i] = 0; }", file);
    text = replaceOnce(text, "Thread_t* thread = (Thread_t*)malloc(sizeof(Thread_t));", `if (!stackSize || stackSize > 0x100000 || !codeSize || codeSize > 0x2000000 || !memorySize || memorySize > 0x2000000) return NULL;\n\tThread_t* thread = (Thread_t*)calloc(1, sizeof(Thread_t));\n\tif (!thread) return NULL;`, file);
    text = text.replace("(uint8_t*)malloc(stackSize * sizeof(uint32_t))", "(uint8_t*)calloc(stackSize, sizeof(uint32_t))")
      .replace("(uint8_t*)malloc(codeSize)", "(uint8_t*)calloc(1, codeSize)").replace("(uint8_t*)malloc(memorySize)", "(uint8_t*)calloc(1, memorySize)");
    text = replaceOnce(text, "thread->silenceBasicOpcodeLog = 1;", `if (!thread->stack || !thread->code || !thread->localMem) { thread->error = 1; return thread; }\n\tthread->silenceBasicOpcodeLog = 1;`, file);
    text = replaceFunction(text, "uint8_t* Engine_ReadFile(", "uint32_t Engine_LoadProgram(", `uint8_t* Engine_ReadFile(Engine_t* engine, const char* archive, const char* filename, size_t* outSize)\n{\n    (void)engine;\n    return MLBGI_ReadFile(archive, filename, outSize);\n}`, file);
    text = replaceOnce(text, "size_t fileSize;\n\tuint8_t* code = Engine_ReadFile", "if (!thread || thread->error) return 1;\n\tsize_t fileSize;\n\tuint8_t* code = Engine_ReadFile", file);
    text = replaceOnce(text, "if(code == NULL)\n\t\treturn 1;\n\tThread_LoadCode(thread, code, filename);", "if(code == NULL) { thread->error = 1; return 1; }\n\tuint32_t loaded = Thread_LoadCode(thread, code, fileSize, filename);", file);
    text = replaceOnce(text, "return thread->threadId;\n}\n\nuint32_t Engine_ReadFileToMemory", "return loaded == UINT32_MAX ? 1 : thread->threadId;\n}\n\nuint32_t Engine_ReadFileToMemory", file);
    text = replaceFunction(text, "uint32_t Engine_ReadFileToMemory(", "Thread_t* Engine_GetThreadById(", `uint32_t Engine_ReadFileToMemory(Engine_t* engine, const char* archive, const char* filename, uint8_t* buffer)\n{\n    size_t size = 0, capacity = MLBGI_MemoryRemaining(engine, buffer);\n    uint8_t *bytes = MLBGI_ReadFile(archive, filename, &size);\n    if (!bytes) return 0;\n    if (size > capacity) { free(bytes); engine->isRunning = 0; return 0; }\n    memcpy(buffer, bytes, size); free(bytes); return (uint32_t)size;\n}`, file);
    text = replaceOnce(text, "engine->auxMemory[i] = (uint8_t*)malloc(size);", "engine->auxMemory[i] = (uint8_t*)calloc(1, size);\n\t\tif (!engine->auxMemory[i]) return 0;\n\t\tengine->auxMemorySizes[i] = size;", file);
  }
  if (file === "src/thread.c") {
    text = replaceOnce(text, '#include "golden_log.h"', '#include "golden_log.h"\n#include "vm-guards.h"', file);
    text = replaceFunction(text, "uint32_t Thread_LoadCode(", "uint32_t Thread_DeleteProgram(", `uint32_t Thread_LoadCode(Thread_t* thread, uint8_t* code, size_t codeBytes, const char* filename)\n{\n    return MLBGI_LoadCode(thread, code, codeBytes, filename);\n}`, file);
    for (const [name, bytes] of [["Thread_ReadImm8", 1], ["Thread_ReadCode8", 1], ["Thread_ReadCode16", 2], ["Thread_ReadCode32", 4]]) {
      const signature = new RegExp(`(uint(?:8|16|32)_t ${name}\\(Thread_t\\* thread\\)\\n\\{)`);
      if (!signature.test(text)) throw new Error(`Missing OpenBGI read guard context: ${name}`);
      text = text.replace(signature, `$1\n\tif (!MLBGI_CodeAvailable(thread, ${bytes})) return 0;`);
    }
    text = replaceOnce(text, "uint8_t opcode = Thread_ReadImm8(thread);", "uint8_t opcode = Thread_ReadImm8(thread);\n\tif (thread->error) return 0xFFFFFFFC;", file);
    text = replaceOnce(text, "if(GoldenLog[GoldenLogIndex].thread == thread->threadId && GoldenLog[GoldenLogIndex].tick == thread->ticks)", "if(GoldenLogIndex < GoldenLogTotal && GoldenLog[GoldenLogIndex].thread == thread->threadId && GoldenLog[GoldenLogIndex].tick == thread->ticks)", file);
    text = replaceOnce(text, "while(GoldenLog[idx].tick == thread->ticks)", "while(idx < GoldenLogTotal && GoldenLog[idx].tick == thread->ticks)", file);
    text = text.replaceAll("if(GoldenLogTotal)", "if(GoldenLogIndex < GoldenLogTotal)");
    text = replaceOnce(text, "if(thread->stackPointer == thread->stackSize)", "if(thread->stackPointer >= thread->stackSize)", file);
    text = replaceOnce(text, "thread->queuePushQueue[thread->queuePush] = data;", "if (thread->queuePush >= 10) { thread->error = 1; thread->running = 0; return; }\n\tthread->queuePushQueue[thread->queuePush] = data;", file);
    text = replaceOnce(text, "thread->nextInstructionPointer = value;", "if (value >= thread->codeSpaceUsed) { thread->error = 1; thread->running = 0; return; }\n\tthread->nextInstructionPointer = value;", file);
    text = replaceOnce(text, "thread->basePointer = value;", "if (value > thread->localMemSize) { thread->error = 1; thread->running = 0; return; }\n\tthread->basePointer = value;", file);
    text = replaceOnce(text, "int slot = (tag >> 1) - 32;", "int slot = (tag >> 1) - 32;\n\t\t\tif (slot < 0 || slot >= 48 || offset >= thread->engine->auxMemorySizes[slot]) { thread->error = 1; return NULL; }", file);
    const resolveStart = text.indexOf("uint8_t* Thread_ResolveAddr("), resolveEnd = text.indexOf("uint8_t* Thread_PopAndResolveAddress(", resolveStart);
    if (resolveStart < 0 || resolveEnd < 0) throw new Error("Missing OpenBGI address resolution context.");
    let resolve = text.slice(resolveStart, resolveEnd);
    for (const [tag, capacity, base] of [["0", "thread->engine->globalBufferSize", "thread->engine->globalMem"], ["0x10", "thread->localMemSize", "thread->localMem"], ["0x11", "thread->codeSpaceUsed", "thread->code"]]) {
      resolve = replaceOnce(resolve, `case ${tag}:\n`, `case ${tag}:\n\t\t\tif (!${base} || offset >= ${capacity}) { thread->error = 1; return NULL; }\n`, file);
    }
    text = text.slice(0, resolveStart) + resolve + text.slice(resolveEnd);
    text = replaceOnce(text, "*(uint32_t*)(thread->localMem + thread->basePointer) = addr;", "if (thread->basePointer > thread->localMemSize || thread->localMemSize - thread->basePointer < 4) { thread->error = 1; return; }\n\tmemcpy(thread->localMem + thread->basePointer, &addr, 4);", file);
    text = replaceOnce(text, "thread->basePointer -= 4;\n\treturn *(uint32_t *)(thread->localMem + thread->basePointer);", "if (thread->basePointer < 4 || thread->basePointer > thread->localMemSize) { thread->error = 1; return 0; }\n\tthread->basePointer -= 4;\n\tuint32_t value; memcpy(&value, thread->localMem + thread->basePointer, 4); return value;", file);
  }
  if (file === "src/opcodes_sys0.c") text = replaceOnce(text, "Thread_LoadCode(thread, code, filename)", "Thread_LoadCode(thread, code, fileSize, filename)", file);
  if (file === "src/opcodes.c") {
    if (text.split("GoldenLog[GoldenLogIndex].time").length - 1 !== 7) throw new Error("OpenBGI dispatch logging context changed.");
    text = text.replaceAll("GoldenLog[GoldenLogIndex].time", "thread->ticks");
    text = text.replaceAll("uint8_t opcode = Thread_ReadCode8(thread);", "uint8_t opcode = Thread_ReadCode8(thread);\n\tif (thread->error) return 0xFFFFFFFC;");
  }
  if (file === "src/os.c") text = replaceOnce(text, "    }\n}\n\nint OS_Quit()", "    }\n    return 0;\n}\n\nint OS_Quit()", file);
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
  if (INPUTS.sourceRevision !== SOURCE_REVISION) throw new Error("OpenBGI source identity differs from the reviewed overlay.");
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
