const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { inspectPickle, objectClass, objectFields, pythonSource } = require("./pickle-inspect");

const LIMITS = Object.freeze({ indexBytes: 16 * 1024 * 1024, sourceBytes: 8 * 1024 * 1024,
  totalSourceBytes: 24 * 1024 * 1024, members: 250_000, files: 256, directories: 64, archives: 32 });
const decoder = new TextDecoder("utf-8", { fatal: true });
const archiveCache = new Map();
const sourceCache = new Map();
let sourceCacheBytes = 0;

function sourceFingerprint(roots) {
  const parts = [], seen = new Set(); let directoryCount = 0, fileCount = 0;
  function scan(directory, depth = 0) {
    if (seen.has(directory)) return; seen.add(directory);
    if (++directoryCount > LIMITS.directories) throw new Error("Configuration fingerprint directory limit exceeded.");
    let entries;
    try {
      const stat = fs.statSync(directory); parts.push([directory, stat.mtimeMs, stat.ctimeMs]);
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch { parts.push([directory, "missing"]); return; }
    if (entries.length > 4096) throw new Error("Configuration fingerprint entry limit exceeded.");
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory() && depth < 3 && !["tl", "cache", "saves", "renpy", "lib", "game"].includes(item.name.toLowerCase()) && !item.name.startsWith(".")) scan(file, depth + 1);
      else if (item.isFile() && /\.(?:rpyc?|rpa)$/i.test(item.name)) {
        if (++fileCount > LIMITS.files + LIMITS.archives) throw new Error("Configuration fingerprint file limit exceeded.");
        const stat = fs.lstatSync(file); parts.push([file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);
      }
    }
  }
  for (const root of roots) scan(root);
  return JSON.stringify(parts);
}

function inflateBounded(buffer, limit) {
  const result = zlib.inflateSync(buffer, { maxOutputLength: limit, info: true });
  if (result.engine.bytesWritten !== buffer.length) throw new Error("Trailing compressed script/index bytes.");
  return result.buffer;
}

function readBytes(fd, offset, length, limit) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > limit) throw new Error("Invalid or oversized script/index range.");
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const amount = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (!amount) throw new Error("Truncated script/archive data.");
    read += amount;
  }
  return buffer;
}

function regularStat(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Script/archive is not a regular file.");
  return stat;
}

function memberName(value) {
  const name = Buffer.isBuffer(value) ? decoder.decode(value) : value;
  if (typeof name !== "string" || !name || name.length > 4096 || name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") || name.split("/")[0].includes(":")) throw new Error("Unsafe RPA member name.");
  return name;
}
function integer(value) {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("Invalid RPA integer.");
  const result = BigInt(value);
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid RPA integer range.");
  return result;
}

function readRpaIndex(file) {
  const stat = regularStat(file);
  const cacheKey = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  if (archiveCache.has(cacheKey)) return archiveCache.get(cacheKey);
  const fd = fs.openSync(file, "r");
  try {
    const headerBytes = readBytes(fd, 0, Math.min(stat.size, 1024), 1024);
    const newline = headerBytes.indexOf(10);
    if (newline < 0) throw new Error("Invalid RPA header.");
    const header = headerBytes.subarray(0, newline).toString("ascii").trim().split(/\s+/);
    if (!["RPA-2.0", "RPA-3.0", "RPA-3.2"].includes(header[0]) || !/^[0-9a-f]+$/i.test(header[1] || "")) throw new Error("Unsupported RPA archive header.");
    const offset = Number(BigInt(`0x${header[1]}`));
    let key = 0n;
    if (header[0] !== "RPA-2.0") {
      const keys = header.slice(header[0] === "RPA-3.2" ? 3 : 2);
      if (!keys.length || keys.some(item => !/^[0-9a-f]+$/i.test(item))) throw new Error("Invalid RPA archive key.");
      for (const item of keys) key ^= BigInt(`0x${item}`);
    }
    if (!Number.isSafeInteger(offset) || offset <= newline || offset > stat.size || stat.size - offset > LIMITS.indexBytes) throw new Error("RPA index range exceeds inspection limit.");
    const data = inflateBounded(readBytes(fd, offset, stat.size - offset, LIMITS.indexBytes), LIMITS.indexBytes);
    const index = inspectPickle(data, { limits: { bytes: LIMITS.indexBytes, blob: LIMITS.indexBytes, items: 2_000_000 } }).value;
    if (!(index instanceof Map) || index.size > LIMITS.members) throw new Error("Invalid or oversized RPA index.");
    const members = new Map();
    for (const [rawName, chunks] of index) {
      const name = memberName(rawName);
      if (members.has(name) || !Array.isArray(chunks) || !chunks.length || chunks.length > 4096) throw new Error("Invalid RPA member chunks.");
      let size = 0;
      const normalized = [];
      for (const chunk of chunks) {
        if (!Array.isArray(chunk) || ![2, 3].includes(chunk.length)) throw new Error("Invalid RPA member tuple.");
        const start = Number(integer(chunk[0]) ^ key), length = Number(integer(chunk[1]) ^ key);
        let prefix = chunk.length === 3 ? chunk[2] : null;
        if (prefix == null) prefix = Buffer.alloc(0);
        else if (typeof prefix === "string") prefix = Buffer.from(prefix, "latin1");
        if (!Buffer.isBuffer(prefix) || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < newline + 1 || length < 0 || start + length > offset) throw new Error("RPA member lies outside archive data.");
        size += length + prefix.length;
        normalized.push({ start, length, prefix });
      }
      members.set(name, { size, chunks: normalized });
    }
    const result = { members, indexBytes: data.length, archiveBytes: stat.size, signature: header[0] };
    // Bound retained archive metadata and invalidate it whenever source metadata changes.
    if (data.length <= 1024 * 1024) {
      for (const stored of archiveCache.keys()) if (stored.startsWith(file + ":")) archiveCache.delete(stored);
      archiveCache.set(cacheKey, result);
      while (archiveCache.size > 8) archiveCache.delete(archiveCache.keys().next().value);
    }
    return result;
  } finally { fs.closeSync(fd); }
}

function readRpaMember(file, member) {
  const record = readRpaIndex(file).members.get(member);
  if (!record || record.size > LIMITS.sourceBytes) throw new Error("RPA script member missing or exceeds inspection limit.");
  const fd = fs.openSync(file, "r");
  try { return Buffer.concat(record.chunks.flatMap(chunk => [chunk.prefix, readBytes(fd, chunk.start, chunk.length, LIMITS.sourceBytes)]), record.size); }
  finally { fs.closeSync(fd); }
}

function readRpycConfiguration(buffer, source, { keys = ["save_directory", "savedir", "extra_savedirs"], includePythonSources = false } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => !/^[a-z_]{1,64}$/.test(key))) throw new Error("Invalid configuration field selection.");
  const relevantPython = new RegExp(`\\bconfig\\.(?:${keys.join("|")})\\b`);
  if (buffer.length > LIMITS.sourceBytes) throw new Error("Compiled script exceeds inspection limit.");
  let compressed = buffer;
  if (buffer.subarray(0, 10).equals(Buffer.from("RENPY RPC2"))) {
    let slot = null;
    for (let index = 10; index + 12 <= Math.min(buffer.length, 1024); index += 12) {
      const id = buffer.readUInt32LE(index), offset = buffer.readUInt32LE(index + 4), size = buffer.readUInt32LE(index + 8);
      if (id === 0) break;
      if (offset < index + 12 || offset + size > buffer.length) throw new Error("Invalid compiled-script slot.");
      if (id === 1) slot = { offset, size };
    }
    if (!slot) throw new Error("Compiled script has no original AST slot.");
    compressed = buffer.subarray(slot.offset, slot.offset + slot.size);
  }
  const pickle = inspectPickle(inflateBounded(compressed, LIMITS.sourceBytes), { primitiveOnly: false });
  const contexts = new Map(), visitedCollections = new Map();
  let traversalOperations = 0;
  const tick = amount => { traversalOperations += amount; if (traversalOperations > 1_000_000) throw new Error("Compiled configuration traversal exceeds inspection limit."); };
  function walkStatements(statements, context = "top", depth = 0) {
    if (depth > 128) throw new Error("Compiled configuration nesting exceeds inspection limit.");
    if (!Array.isArray(statements)) return;
    if (visitedCollections.has(statements)) {
      if (visitedCollections.get(statements) === context || visitedCollections.get(statements) === "unsafe") return;
      context = "unsafe";
    }
    visitedCollections.set(statements, context);
    for (const object of statements) {
      tick(1);
      if (!object) continue;
      const previous = contexts.get(object);
      if (previous === context || previous === "unsafe") continue;
      const effectiveContext = previous !== undefined ? "unsafe" : context;
      const klass = objectClass(object), fields = objectFields(object);
      contexts.set(object, effectiveContext);
      if (klass === "renpy.ast.Init") walkStatements(fields.get("block"), effectiveContext === "unsafe" ? "unsafe" : "init", depth + 1);
      else {
        walkStatements(fields.get("block"), "unsafe", depth + 1);
        const entries = fields.get("entries");
        if (Array.isArray(entries) && !visitedCollections.has(entries)) {
          visitedCollections.set(entries, "unsafe");
          for (const branch of entries) { tick(1); if (Array.isArray(branch)) walkStatements(branch[1], "unsafe", depth + 1); }
        }
      }
    }
  }
  walkStatements(pickle.value?.[1]);
  const assignments = []; let configurationBytes = 0;
  const addAssignment = assignment => {
    configurationBytes += Buffer.byteLength(assignment.expression || assignment.python || "");
    if (assignments.length >= 256 || configurationBytes > LIMITS.sourceBytes) throw new Error("Compiled configuration expressions exceed inspection limit.");
    assignments.push(assignment);
  };
  const text = value => {
    if ((typeof value === "string" || Buffer.isBuffer(value)) && value.length > 256) throw new Error("Compiled configuration identifier exceeds inspection limit.");
    return Buffer.isBuffer(value) ? decoder.decode(value) : value;
  };
  for (const object of pickle.objects) {
    const klass = objectClass(object), fields = objectFields(object);
    if (["renpy.ast.Define", "renpy.ast.Default"].includes(klass) &&
        ["store.config", "config"].includes(text(fields.get("store"))) &&
        keys.includes(text(fields.get("varname")))) {
      const expression = pythonSource(fields.get("code"));
      addAssignment({ key: text(fields.get("varname")), expression,
        source: `${source}:${fields.get("linenumber") || "?"}`, confidence: "exact",
        unsafeContext: !contexts.has(object) || contexts.get(object) === "unsafe" || fields.get("index") != null || ![undefined, "="].includes(text(fields.get("operator"))) });
    } else if (klass === "renpy.ast.Python" || klass === "renpy.ast.EarlyPython") {
      const code = pythonSource(fields.get("code"));
      if (code && (includePythonSources || relevantPython.test(code))) {
        addAssignment({ python: code, source: `${source}:${fields.get("linenumber") || "?"}`,
          unsafeContext: contexts.get(object) !== "init" && klass !== "renpy.ast.EarlyPython" });
      }
    }
  }
  return assignments;
}

function readGameConfigurationSources(roots, { keys = ["save_directory", "savedir", "extra_savedirs"], includePythonSources = false } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => !/^[a-z_]{1,64}$/.test(key))) throw new Error("Invalid configuration field selection.");
  const relevantSource = new RegExp(`\\bconfig\\.(?:${keys.filter(key => key !== "extra_savedirs").join("|")})\\s*=`);
  roots = (roots || []).filter(Boolean);
  const cacheKey = roots.map(root => path.resolve(root)).join("\0") + JSON.stringify([keys, includePythonSources]);
  let fingerprint = null;
  try { fingerprint = sourceFingerprint(roots); } catch {}
  const cached = sourceCache.get(cacheKey);
  if (fingerprint && cached?.fingerprint === fingerprint) return cached.result;
  const sources = [], errors = [], seenRoots = new Set();
  let totalBytes = 0;
  for (const root of roots || []) {
    if (!root || seenRoots.has(path.resolve(root))) continue;
    seenRoots.add(path.resolve(root));
    const candidates = new Map(), archives = [];
    let directories = 0, files = 0;
    function scan(dir, prefix = "", depth = 0) {
      if (++directories > LIMITS.directories) throw new Error("Configuration directory inspection limit exceeded.");
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.length > 4096) throw new Error("Configuration directory entry limit exceeded.");
      for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, item.name), name = prefix + item.name;
        if (item.isDirectory() && depth < 3 && !["tl", "cache", "saves", "renpy", "lib", "game"].includes(item.name.toLowerCase()) && !item.name.startsWith(".")) scan(file, name + "/", depth + 1);
        else if (item.isFile() && /\.rpyc?$/i.test(item.name)) {
          if (++files > LIMITS.files) throw new Error("Configuration script inspection limit exceeded.");
          candidates.set(name, { name, source: file, load: () => {
            const stat = regularStat(file);
            if (stat.size > LIMITS.sourceBytes) throw new Error("Configuration source exceeds inspection limit.");
            return fs.readFileSync(file);
          } });
        } else if (item.isFile() && !prefix && /\.rpa$/i.test(item.name)) archives.push(file);
      }
    }
    try {
      scan(root);
      if (archives.length > LIMITS.archives) throw new Error("Too many archives for configuration inspection.");
      // Ren'Py normally searches archives in reverse filename order; loose files
      // take precedence. Translations are not unconditional game configuration.
      for (const archive of archives.sort().reverse()) {
        try {
          for (const name of readRpaIndex(archive).members.keys()) {
            if (/\.rpyc?$/i.test(name) && !/^(?:tl|cache|saves)\//i.test(name) && !candidates.has(name)) {
              if (++files > LIMITS.files) throw new Error("Configuration archive script inspection limit exceeded.");
              candidates.set(name, { name, source: `${archive}!/${name}`, load: () => readRpaMember(archive, name) });
            }
          }
        } catch (error) { errors.push({ source: archive, error: error.message }); }
      }
      const rank = name => /^(options|gui)\.rpyc?$/i.test(name) ? 0 : 1;
      const selected = [...candidates.values()].filter(item => !item.name.endsWith(".rpyc") || !candidates.has(item.name.slice(0, -1)))
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      for (const item of selected) {
        if (totalBytes >= LIMITS.totalSourceBytes) { errors.push({ source: item.source, error: "Aggregate configuration source inspection limit exceeded." }); break; }
        try {
          const bytes = item.load(); totalBytes += bytes.length;
          if (totalBytes > LIMITS.totalSourceBytes) { errors.push({ source: item.source, error: "Aggregate configuration source inspection limit exceeded." }); break; }
          if (item.name.endsWith(".rpyc")) sources.push({ source: item.source, compiledAssignments: readRpycConfiguration(bytes, item.source, { keys, includePythonSources }) });
          else sources.push({ source: item.source, text: decoder.decode(bytes) });
        } catch (error) { errors.push({ source: item.source, error: error.message }); }
      }
    } catch (error) { errors.push({ source: root, error: error.message }); }
    // Extracted roots intentionally precede original roots supplied by callers.
    if (sources.some(item => item.text && relevantSource.test(item.text) || item.compiledAssignments?.some(a => a.key || a.python))) break;
  }
  const result = { sources, errors, totalBytes };
  if (fingerprint) {
    if (cached) { sourceCacheBytes -= cached.result.totalBytes; sourceCache.delete(cacheKey); }
    sourceCache.set(cacheKey, { fingerprint, result }); sourceCacheBytes += totalBytes;
    while (sourceCache.size > 16 || sourceCacheBytes > 64 * 1024 * 1024) {
      const oldest = sourceCache.keys().next().value; sourceCacheBytes -= sourceCache.get(oldest).result.totalBytes; sourceCache.delete(oldest);
    }
  }
  return result;
}

module.exports = { LIMITS, inflateBounded, readRpaIndex, readRpaMember, readRpycConfiguration, readGameConfigurationSources };
