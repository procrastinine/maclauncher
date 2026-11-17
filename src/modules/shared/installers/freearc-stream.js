const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { crc32, LIMITS, safePath } = require("./freearc-format");
const { installerError } = require("./inno-header");
const error = message => installerError(message, "INSTALLER_FREEARC_DECODER");
class Input {
  constructor(input) { this.iterator = input[Symbol.asyncIterator]?.() || input[Symbol.iterator](); this.buffer = Buffer.alloc(0); }
  async take(size, optional = false) {
    const chunks = []; let left = size;
    while (left) {
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) { if (optional && left === size) return null; throw error("The FreeArc decoder stream ended early."); }
        this.buffer = Buffer.from(next.value); if (!this.buffer.length) continue;
      }
      const n = Math.min(left, this.buffer.length); chunks.push(this.buffer.subarray(0, n)); this.buffer = this.buffer.subarray(n); left -= n;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }
  async *rest(prefix) {
    if (prefix?.length) yield prefix;
    if (this.buffer.length) { yield this.buffer; this.buffer = Buffer.alloc(0); }
    while (true) { const item = await this.iterator.next(); if (item.done) break; yield item.value; }
  }
}
async function *run(executable, args, input, context = {}) {
  const { signal, cwd, env, onSpawn, maximum = LIMITS.bytes } = context;
  signal?.throwIfAborted();
  const environment = context.wineChild ? { ...env } : { ...process.env, ...env };
  for (const key of Object.keys(environment)) if (/^(?:Malloc|DYLD_)/.test(key) && !env?.[key]) delete environment[key];
  const child = (context.spawn || spawn)(executable, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let failure, closed = false, killing, errBytes = 0, stderr = "", ownership = Promise.resolve();
  const stop = () => { if (!closed) { child.kill("SIGTERM"); killing ||= setTimeout(() => child.kill("SIGKILL"), 1500); killing.unref(); } };
  const done = new Promise(resolve => {
    child.once("error", e => { failure = e; });
    child.once("close", code => { closed = true; resolve(code); });
  });
  child.stderr.on("data", chunk => { if ((errBytes += chunk.length) < 65536) stderr += chunk.toString(); });
  child.once("spawn", () => { ownership = Promise.resolve().then(() => onSpawn?.({ pid: child.pid, executable, args, startedAt: new Date().toISOString() })).catch(e => { failure ||= e; stop(); }); });
  signal?.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(() => { failure ||= error("The FreeArc decoder timed out."); stop(); }, context.timeout || 3600000); timeout.unref();
  const feeding = pipeline(Readable.from(input), child.stdin).then(() => null, e => { failure ||= e; stop(); return e; });
  try {
    if (signal?.aborted) stop();
    let bytes = 0;
    for await (const chunk of child.stdout) { signal?.throwIfAborted(); if ((bytes += chunk.length) > maximum) throw error("The FreeArc decoder exceeded its output limit."); yield chunk; }
    await feeding; const code = await done; await ownership;
    signal?.throwIfAborted();
    if (failure || code !== 0) throw error("The FreeArc decoder failed. " + (failure?.message || stderr).replace(/[\x00-\x1f]/g, " ").slice(0, 1000));
  } finally {
    stop(); await done; await feeding; await ownership; clearTimeout(timeout); clearTimeout(killing); signal?.removeEventListener("abort", stop);
  }
}
async function writeStream(file, input, { maximum = LIMITS.bytes, expected, signal } = {}) {
  const handle = await fs.promises.open(file, "wx"); let total = 0;
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted(); if ((total += chunk.length) > maximum) throw error("The FreeArc decoder exceeded its output limit.");
      let at = 0; while (at < chunk.length) { const n = await handle.write(chunk, at, chunk.length - at); if (!n.bytesWritten) throw error("Could not write decoded installer data."); at += n.bytesWritten; }
    }
    if (expected !== undefined && total !== expected) throw error("The FreeArc block has an incorrect decoded size.");
    return total;
  } finally { await handle.close(); }
}
async function *fourByFour(stage, input, context, decode = decodeStage) {
  const reader = new Input(input), version = await reader.take(4);
  if (version.readUInt32LE() !== 0) throw error("The 4x4 decoder stream version is unsupported.");
  const pending = [], owned = new Set(); const jobs = 2;
  async function emit(item) { return await item; }
  try {
    for (let index = 0;; index++) {
      const header = await reader.take(8, true); if (!header) break;
      const original = header.readInt32LE(), packed = header.readInt32LE(4);
      if (original < -1 || packed < 0 || packed > LIMITS.fileBytes || original > LIMITS.fileBytes) throw error("The 4x4 block has an invalid size.");
      const directory = await fs.promises.mkdtemp(path.join(context.work, "block-")); owned.add(directory);
      const source = path.join(directory, "input"), target = path.join(directory, "output");
      async function *body() { let left = packed; while (left) { const n = Math.min(left, 4 * 1024 * 1024); yield await reader.take(n); left -= n; } }
      await writeStream(source, body(), { maximum: packed, expected: packed, signal: context.signal });
      const task = (async () => {
        if (original === -1) return { directory, output: source };
        await writeStream(target, decode(stage.inner, fs.createReadStream(source), { ...context, work: directory }), { maximum: original, expected: original, signal: context.signal });
        return { directory, output: target };
      })();
      task.catch(() => {}); pending.push(task);
      if (pending.length >= jobs) {
        const result = await emit(pending.shift()); yield* fs.createReadStream(result.output);
        await fs.promises.rm(result.directory, { recursive: true, force: true }); owned.delete(result.directory);
      }
    }
    for (const task of pending) { const result = await emit(task); yield* fs.createReadStream(result.output); }
  } catch (failure) { context.abort?.(failure); throw failure; }
  finally { await Promise.allSettled(pending); for (const directory of owned) await fs.promises.rm(directory, { recursive: true, force: true }); }
}
async function *decodeStage(stage, input, context) {
  if (stage.kind === "4x4") { yield* fourByFour(stage, input, context); return; }
  if (stage.kind === "native") {
    if (stage.name === "storing") { yield* input; return; }
    yield* run(context.tools.filter, [stage.method], input, context); return;
  }
  let body = input;
  if (stage.header) {
    const reader = new Input(input), byte = await reader.take(1, true);
    if (!byte) throw error("The external decoder header is missing.");
    if (byte[0] === 0) { yield* reader.rest(); return; }
    body = reader.rest(byte[0] === 1 ? null : byte);
  }
  let seekableSrep = false;
  if (stage.name === "srep") {
    const reader = new Input(body), header = await reader.take(16);
    seekableSrep = (header.readUInt32LE(8) & 255) === 4;
    body = reader.rest(header);
  }
  if (stage.kind === "native-srep") {
    if (!context.tools.srep) throw error("The selected SREP tool is unavailable.");
    if (!seekableSrep) { yield* run(context.tools.srep, ["-d", "-", "-"], body, context); return; }
    const directory = await fs.promises.mkdtemp(path.join(context.work, "srep-"));
    try {
      const source = path.join(directory, "input"), target = path.join(directory, "output");
      await writeStream(source, body, { signal: context.signal });
      for await (const ignored of run(context.tools.srep, ["-d", source, target], [], context)) { /* Drain bounded diagnostics. */ }
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) throw error("SREP did not produce a regular output file.");
      yield* fs.createReadStream(target);
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    return;
  }
  const wine = context.wine || await context.getWine?.();
  if (!wine) throw error("This FreeArc method requires a Wine runtime.");
  const windowsPath = require("../runtime/managed-windows-tool").windowsPath;
  const command = stage.kind === "cls" ? [windowsPath(context.tools.clsHost), windowsPath(path.join(wine.helpers, stage.dll)), stage.parameters] : [windowsPath(path.join(wine.helpers, stage.cmd[0])), ...stage.cmd.slice(1)];
  if (["pipe", "cls"].includes(stage.kind) && !seekableSrep) { yield* run(wine.executable, command, body, { ...context, env: wine.environment, cwd: wine.helpers, onSpawn: wine.onSpawn, wineChild: true }); return; }
  const directory = await fs.promises.mkdtemp(path.join(context.work, "external-"));
  try {
    const source = path.join(directory, stage.kind === "files" ? stage.packed : "input.bin"), target = path.join(directory, stage.kind === "files" ? stage.unpacked : "output.bin");
    await writeStream(source, body, { signal: context.signal });
    let args = command.map(a => a === "{in}" ? windowsPath(source) : a === "{out}" ? windowsPath(target) : a);
    if (seekableSrep && stage.kind === "pipe") {
      const dashes = args.map((a, i) => a === "-" ? i : -1).filter(i => i >= 0);
      if (dashes.length < 2) throw error("The installer's SREP decoder command needs input and output file arguments.");
      args[dashes.at(-2)] = windowsPath(source); args[dashes.at(-1)] = windowsPath(target);
    }
    for await (const ignored of run(wine.executable, args, [], { ...context, env: wine.environment, cwd: directory, onSpawn: wine.onSpawn, wineChild: true })) { /* Drain bounded diagnostics. */ }
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) throw error("The external decoder did not produce a regular output file.");
    yield* fs.createReadStream(target);
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}
function decodeChain(stages, input, context) { for (const stage of stages) input = decodeStage(stage, input, context); return input; }
async function outputDirectory(root, relative) {
  let directory = root;
  const check = async () => { const stat = await fs.promises.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("The FreeArc output directory cannot be an alias or another file type."); };
  await check();
  if (relative !== ".") for (const part of safePath(relative).split("/")) {
    directory = path.join(directory, part);
    try { await fs.promises.mkdir(directory); } catch (failure) { if (failure.code !== "EEXIST") throw failure; }
    await check();
  }
}
async function extractBlock(archive, block, stages, output, context) {
  const source = block.compsize ? fs.createReadStream(archive, { start: block.offset, end: block.offset + block.compsize - 1 }) : [];
  const input = new Input(decodeChain(stages, source, context));
  try {
  for (const file of block.files) {
    context.signal?.throwIfAborted();
    const name = safePath(file.path), destination = path.join(output, name);
    if (file.dir) { await outputDirectory(output, name); continue; }
    await outputDirectory(output, path.posix.dirname(name));
    let crc = 0, left = file.size;
    async function *contents() { while (left) { const bytes = await input.take(Math.min(left, 4 * 1024 * 1024)); crc = crc32(bytes, crc); left -= bytes.length; yield bytes; } }
    await writeStream(destination, contents(), { maximum: file.size, expected: file.size, signal: context.signal });
    if (file.crc !== undefined && crc !== file.crc) throw error("The FreeArc file checksum is invalid: " + file.path);
  }
  if (await input.take(1, true)) throw error("The FreeArc decoder produced more data than the archive lists.");
  } catch (failure) { context.abort?.(failure); throw failure; }
  finally { await input.iterator.return?.(); }
}
async function decodeControl(method, bytes, size, tools, context) {
  const stages = require("./freearc-codecs").planChain(method);
  if (require("./freearc-codecs").needsWine(stages)) throw error("FreeArc control tables require a native decoder.");
  const chunks = []; let total = 0;
  for await (const chunk of decodeChain(stages, [bytes], { ...context, tools, maximum: Math.min(size, LIMITS.control) })) {
    if ((total += chunk.length) > Math.min(size, LIMITS.control)) throw error("The FreeArc control table exceeds its size limit."); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
module.exports = { Input, run, writeStream, fourByFour, decodeStage, decodeChain, extractBlock, decodeControl };
