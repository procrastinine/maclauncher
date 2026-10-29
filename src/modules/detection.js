// UI-independent, offline detection orchestration. Modules own engine facts;
// this pipeline owns filesystem facts, stages, ambiguity and diagnostics.
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const Zip = require("./shared/runtime/zip");
const Asar = require("./shared/runtime/asar");
const SevenZip = require("./shared/runtime/sevenzip");
const AppBundle = require("./shared/runtime/app-bundle");
const { executablePriority } = require("./shared/executable-candidates");
const { spawn } = require("node:child_process");

const DEFAULT_LIMITS = Object.freeze({ maxDirectories: 256, maxDirectoryEntries: 4096, maxStats: 8192, maxProbeFiles: 32, maxReadBytes: 64 * 1024 * 1024, maxZipDirectoryBytes: 16 * 1024 * 1024, maxAsarHeaderBytes: 16 * 1024 * 1024, maxWorkers: 3, workerTimeoutMs: 20000 });

class DetectionError extends Error {
  constructor(message, code, report = null) {
    super(message);
    this.name = code === "DETECTION_CONFLICT" ? "DetectionConflictError" : "DetectionError";
    this.code = code;
    if (report) this.detection = report;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeLimits(options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > limits[key]) throw new DetectionError(`Invalid detection limit ${key}. Limits may only be lowered.`, "DETECTION_LIMIT");
    limits[key] = options[key];
  }
  return limits;
}

function createDetectionSession(inputPath, options = {}) {
  if (typeof inputPath !== "string" || !inputPath || inputPath.includes("\0")) throw new DetectionError("Invalid input path.", "DETECTION_INPUT");
  const limits = normalizeLimits(options);
  const trace = [];
  const metrics = { stats: 0, directories: 0, reads: 0, bytesRead: 0, zipDirectories: 0, archiveListings: 0, asarHeaders: 0, cacheHits: 0, probes: 0, skipped: 0, workersStarted: 0 };
  const caches = { stat: new Map(), directories: new Map(), reads: new Map(), index: new Map(), zip: new Map(), archive: new Map(), asar: new Map(), facts: new Map(), memo: new Map() };
  const pendingArchives = new Map();
  function cached(map, key, read) {
    if (map.has(key)) { metrics.cacheHits++; return map.get(key); }
    const value = read();
    map.set(key, value);
    return value;
  }
  function stat(filePath) {
    const key = path.resolve(filePath);
    return cached(caches.stat, key, () => {
      if (++metrics.stats > limits.maxStats) throw new DetectionError("Detection stat limit exceeded.", "DETECTION_LIMIT");
      try { return fs.statSync(key); } catch { return null; }
    });
  }
  function readdir(dir) {
    const key = path.resolve(dir);
    return cached(caches.directories, key, () => {
      if (++metrics.directories > limits.maxDirectories) throw new DetectionError("Detection directory limit exceeded.", "DETECTION_LIMIT");
      let handle;
      try { handle = fs.opendirSync(key); } catch { return []; }
      const entries = [];
      try {
        for (let entry; (entry = handle.readSync());) {
          if (entries.length >= limits.maxDirectoryEntries) throw new DetectionError("Detection directory entry limit exceeded.", "DETECTION_LIMIT");
          entries.push(entry);
        }
      } finally { handle.closeSync(); }
      return entries;
    });
  }
  function readBytes(filePath, offset = 0, length = 65536) {
    const key = `${path.resolve(filePath)}\0${offset}\0${length}`;
    return cached(caches.reads, key, () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 2 * 1024 * 1024) throw new DetectionError("Invalid bounded detection read.", "DETECTION_LIMIT");
      const info = stat(filePath);
      if (!info?.isFile()) return null;
      const size = Math.max(0, Math.min(length, info.size - offset));
      if (metrics.bytesRead + size > limits.maxReadBytes) throw new DetectionError("Detection read byte limit exceeded.", "DETECTION_LIMIT");
      let fd;
      try {
        fd = fs.openSync(filePath, "r");
        const data = Buffer.alloc(size);
        const read = fs.readSync(fd, data, 0, size, offset);
        metrics.reads++;
        metrics.bytesRead += read;
        return data.subarray(0, read);
      } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
    });
  }
  function readText(filePath, maxBytes = 256 * 1024) {
    const info = stat(filePath);
    if (!info?.isFile() || info.size > maxBytes) return null;
    return readBytes(filePath, 0, maxBytes)?.toString("utf8") || "";
  }
  function findIndexHtml(rootDir) {
    const root = path.resolve(rootDir);
    return cached(caches.index, root, () => {
      const files = [];
      // A selected HTML entry is deliberate. Keep it ahead of package defaults
      // and adjacent landing pages, with the same real-path confinement.
      if (inputStat.isFile() && /\.html?$/i.test(requestedPath) && isInside(root, requestedPath)) files.push(requestedPath);
      try {
        const raw = readText(path.join(root, "package.json"));
        const pkg = raw ? JSON.parse(raw) : null;
        if (typeof pkg?.main === "string" && !pkg.main.includes("\0")) {
          const candidate = path.resolve(root, pkg.main);
          if (/\.html?$/i.test(candidate) && isInside(root, candidate)) files.push(candidate);
        }
      } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
      files.push(path.join(root, "index.html"), path.join(root, "www", "index.html"));
      for (const file of files) {
        if (!stat(file)?.isFile()) continue;
        try { if (isInside(fs.realpathSync(root), fs.realpathSync(file))) return file; } catch {}
      }
      return null;
    });
  }
  function zipFooter(filePath) {
    const info = stat(filePath);
    if (!info?.isFile() || info.size < 22) return null;
    const tailSize = Math.min(info.size, 65535 + 22);
    const tail = readBytes(filePath, info.size - tailSize, tailSize);
    if (!tail) return null;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue;
      const entries = tail.readUInt16LE(i + 10), cdSize = tail.readUInt32LE(i + 12), cdOffset = tail.readUInt32LE(i + 16);
      const eocdOffset = info.size - tailSize + i;
      const zipBase = eocdOffset - cdSize - cdOffset;
      if (zipBase < 0 || cdSize > limits.maxZipDirectoryBytes || cdOffset + cdSize > info.size - zipBase || entries === 65535) return null;
      return { entries, cdSize, cdOffset, zipBase, eocdOffset, fileSize: info.size };
    }
    return null;
  }
  function readZipEntries(filePath) {
    return cached(caches.zip, path.resolve(filePath), () => {
      const footer = zipFooter(filePath);
      if (!footer) return null;
      if (metrics.bytesRead + footer.cdSize > limits.maxReadBytes) throw new DetectionError("ZIP detection read byte limit exceeded.", "DETECTION_LIMIT");
      metrics.zipDirectories++;
      metrics.bytesRead += footer.cdSize;
      try {
        const result = Zip.readZipEntries(filePath);
        return result?.entries?.length === footer.entries ? result : null;
      } catch { return null; }
    });
  }
  function readAsarHeader(filePath) {
    return cached(caches.asar, path.resolve(filePath), () => {
      const prefix = readBytes(filePath, 0, 16);
      if (!prefix || prefix.length !== 16) return null;
      const size = prefix.readUInt32LE(12);
      if (size > limits.maxAsarHeaderBytes || size > (stat(filePath)?.size || 0) - 16 || metrics.bytesRead + size > limits.maxReadBytes) {
        throw new DetectionError("ASAR detection header limit exceeded.", "DETECTION_LIMIT");
      }
      metrics.asarHeaders++;
      metrics.bytesRead += size;
      try { return Asar.readAsarHeader(filePath); } catch { return null; }
    });
  }
  function readArchiveEntries(filePath) {
    return cached(caches.archive, path.resolve(filePath), () => {
      metrics.archiveListings++;
      return SevenZip.listArchiveEntriesSync(filePath);
    });
  }
  function readArchiveEntriesAsync(filePath) {
    const key = path.resolve(filePath);
    if (caches.archive.has(key)) { metrics.cacheHits++; return Promise.resolve(caches.archive.get(key)); }
    if (pendingArchives.has(key)) { metrics.cacheHits++; return pendingArchives.get(key); }
    const binary = SevenZip.resolveSevenZipBinary();
    if (!binary) { caches.archive.set(key, null); return Promise.resolve(null); }
    metrics.archiveListings++;
    const pending = new Promise(resolve => {
      const child = spawn(binary, ["l", "-ba", "-slt", key], { stdio: ["ignore", "pipe", "ignore"] });
      let size = 0;
      const chunks = [];
      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        caches.archive.set(key, value);
        resolve(value);
      }
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 10000);
      child.stdout.on("data", chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { child.kill("SIGKILL"); finish(null); }
        else chunks.push(chunk);
      });
      child.once("error", () => finish(null));
      child.once("close", code => finish(code === 0 ? SevenZip.parseSevenZipList(Buffer.concat(chunks).toString("utf8"), key) : null));
    }).finally(() => pendingArchives.delete(key));
    pendingArchives.set(key, pending);
    return pending;
  }
  function fileFacts(filePath) {
    return cached(caches.facts, path.resolve(filePath), () => {
      const info = stat(filePath);
      if (!info?.isFile()) return { formats: [] };
      const header = readBytes(filePath, 0, Math.min(info.size, 65536)) || Buffer.alloc(0);
      const prefix = header.subarray(0, 8);
      const formats = [];
      if (prefix.subarray(0, 2).toString("ascii") === "MZ") formats.push("pe");
      if (prefix.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) formats.push("elf");
      if (header.subarray(8, 11).equals(Buffer.from([65, 73, 2])) && formats.includes("elf")) formats.push("appimage");
      if (header.includes(Buffer.from(".enigma"))) formats.push("enigma");
      if (header.subarray(0, 4).toString("ascii") === "GDPC" || readBytes(filePath, Math.max(0, info.size - 4), 4)?.toString("ascii") === "GDPC") formats.push("godot");
      const footer = zipFooter(filePath);
      if (footer) formats.push("zip");
      // SFX archive signatures can appear after an executable stub. A bounded
      // prefix gate avoids starting extraction helpers for ordinary executables.
      const scan = formats.includes("pe") ? readBytes(filePath, 0, Math.min(info.size, 1024 * 1024)) || header : header;
      if (scan.includes(Buffer.from([82, 97, 114, 33, 26, 7, 0])) || scan.includes(Buffer.from([82, 97, 114, 33, 26, 7, 1, 0]))) formats.push("rar");
      if (scan.includes(Buffer.from([55, 122, 188, 175, 39, 28]))) formats.push("7z");
      if (scan.includes(Buffer.from([239, 190, 173, 222, 78, 117, 108, 108, 115, 111, 102, 116, 73, 110, 115, 116]))) formats.push("nsis");
      // Exact loader resource/pointer and CRC, rather than a coincidental string.
      if (formats.includes("pe")) {
        try { if (require("./shared/installers/inno-header").probeInno(filePath, { detection: { stat, readBytes } })) formats.push("inno"); }
        catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
      }
      if (scan.includes(Buffer.from("MSCF"))) formats.push("cab");
      return { size: info.size, extension: path.extname(filePath).toLowerCase(), executableBit: Boolean(info.mode & 0o111), formats, zipFooter: footer };
    });
  }
  const requestedPath = path.resolve(inputPath);
  let canonicalPath;
  try { canonicalPath = fs.realpathSync(requestedPath); } catch { throw new DetectionError("Path not found", "DETECTION_NOT_FOUND"); }
  const inputStat = stat(canonicalPath);
  if (!inputStat?.isDirectory() && !inputStat?.isFile()) throw new DetectionError("Input must be a regular file or directory.", "DETECTION_INPUT");
  const namedApp = inputStat.isDirectory() && (canonicalPath.toLowerCase().endsWith(".app") || requestedPath.toLowerCase().endsWith(".app"));
  const applicationBundle = inputStat.isDirectory() && !namedApp
    ? AppBundle.inspectApplicationBundle(requestedPath, { detection: { stat, readBytes } }) : null;
  const isAppBundle = namedApp || Boolean(applicationBundle);
  const kind = isAppBundle ? "app" : inputStat.isDirectory() ? "directory" : "file";
  // Keep the user's selected path spelling in public records and relative game
  // assets. The resolved identity remains available for aliases/diagnostics.
  const rootDir = inputStat.isFile() ? path.dirname(requestedPath) : requestedPath;
  const extension = inputStat.isFile() ? path.extname(requestedPath).toLowerCase() : null;
  const input = { requestedPath, canonicalPath, rootDir, kind, extension, size: inputStat.isFile() ? inputStat.size : null };
  const session = { input, limits, trace, metrics, caches, inlineWorkers: options.workerMode === "inline", stat, readdir, readBytes, readText, findIndexHtml, readZipEntries, readArchiveEntries, readArchiveEntriesAsync, readAsarHeader, fileFacts,
    memo: (namespace, key, read) => cached(caches.memo, `${namespace}\0${key}`, read) };
  session.helpers = { findIndexHtml, stat, readdir, readBytes, readText, readZipEntries, readArchiveEntries, readAsarHeader, fileFacts, memo: session.memo };
  session.context = { inputPath: requestedPath, canonicalPath, rootDir, stat: inputStat, isAppBundle, applicationBundle, fileKind: kind, extension, detection: session.helpers };
  trace.push({ stage: "input", outcome: "normalized", ...input });
  return session;
}

function declaration(mod) {
  return mod.detection || mod.manifest?.detection || {};
}

function fallbackPriority(mod) {
  const value = declaration(mod).priority;
  return Number.isFinite(value) ? value : 0;
}

function fallbackGroups(modules) {
  const groups = new Map();
  for (const mod of modules) {
    if (!declaration(mod).fallback) continue;
    const priority = fallbackPriority(mod);
    if (!groups.has(priority)) groups.set(priority, []);
    groups.get(priority).push(mod);
  }
  return [...groups].sort(([a], [b]) => b - a).map(([, group]) => group);
}

function extensionOwners(modules, extension) {
  if (!extension) return [];
  return modules.filter(mod => (declaration(mod).extensions || []).some(item => typeof item === "object" && item.exclusive === true && item.extension?.toLowerCase() === extension));
}

function markerEvidence(session, context, config) {
  const evidence = [];
  for (const marker of config.rootMarkers || []) {
    let candidate = path.resolve(context.rootDir, marker);
    if (!isInside(context.rootDir, candidate)) continue;
    if (!session.stat(candidate)) {
      // Gates accept case variants when a module's detector supports them. The
      // detector still validates the content; a gate is never a classification.
      let current = context.rootDir;
      for (const component of path.relative(context.rootDir, candidate).split(path.sep)) {
        const names = session.readdir(current).filter(entry => entry.name.toLowerCase() === component.toLowerCase());
        if (names.length !== 1) { current = null; break; }
        current = path.join(current, names[0].name);
      }
      candidate = current;
    }
    if (candidate && session.stat(candidate)) evidence.push({ type: "root-marker", path: candidate });
  }
  if (config.rootExtensions?.length) {
    for (const entry of session.readdir(context.rootDir)) {
      if (entry.isFile() && config.rootExtensions.includes(path.extname(entry.name).toLowerCase())) evidence.push({ type: "root-extension", path: path.join(context.rootDir, entry.name) });
    }
  }
  if (config.webContent || config.webMarkers?.length) {
    for (const rel of ["", ...(config.webRoots || [])]) {
      const root = path.resolve(context.rootDir, rel);
      if (!isInside(context.rootDir, root)) continue;
      const html = session.findIndexHtml(root);
      if (!html) continue;
      if (config.webContent) evidence.push({ type: "web-index", path: html });
      for (const marker of config.webMarkers || []) {
        const filePath = path.resolve(path.dirname(html), marker);
        if (isInside(root, filePath) && session.stat(filePath)?.isFile()) evidence.push({ type: "web-marker", path: filePath });
      }
    }
  }
  if (config.probeExecutables && context.stat.isDirectory() && !context.isAppBundle && evidence.length === 0) {
    for (const entry of session.readdir(context.rootDir)) {
      if (!entry.isFile()) continue;
      const filePath = path.join(context.rootDir, entry.name);
      const header = session.readBytes(filePath, 0, 16);
      if (!header) continue;
      const formats = [];
      if (header.subarray(0, 2).toString("ascii") === "MZ") formats.push("pe");
      if (header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) formats.push("elf");
      if (header.subarray(0, 4).toString("ascii") === "GDPC") formats.push("godot");
      if ((config.binaryFormats || []).some(format => formats.includes(format))) {
        evidence.push({ type: "root-binary", path: filePath, formats });
        break;
      }
    }
  }
  return evidence;
}

function gateProbe(session, mod, context, stage) {
  const config = declaration(mod);
  const kind = context.isAppBundle ? "app" : context.stat.isFile() ? "file" : "directory";
  if (config.inputKinds && (!Array.isArray(config.inputKinds) || !config.inputKinds.includes(kind))) return { eligible: false, reason: "input-kind" };
  const evidence = markerEvidence(session, context, config);
  if (kind === "file") {
    const extension = path.extname(context.inputPath).toLowerCase();
    let facts;
    const getFacts = () => facts || (facts = session.fileFacts(context.inputPath));
    if (config.fileExtensions && !config.fileExtensions.includes(extension) && !(config.binaryFormats || []).some(format => getFacts().formats.includes(format))) return { eligible: false, reason: "file-extension" };
    if (config.fileSignatures?.length && !config.fileSignatures.some(signature => {
      const bytes = Buffer.from(signature.hex, "hex");
      return context.stat.size >= (signature.minSize || bytes.length) && session.readBytes(context.inputPath, signature.offset || 0, bytes.length)?.equals(bytes);
    })) return { eligible: false, reason: "file-signature" };
    if (config.containerFormats?.length && evidence.length === 0 && !(config.directFileExtensions || []).includes(extension) && !config.containerFormats.some(format => getFacts().formats.includes(format))) return { eligible: false, reason: "container-signature" };
    evidence.push({ type: "selected-file", path: context.inputPath, extension });
    if (facts) evidence.push({ type: "file-formats", formats: facts.formats });
  } else if (config.rootMarkers || config.rootExtensions || config.webContent || config.webMarkers) {
    if (evidence.length === 0 && !config.allowUnmarkedDirectory) return { eligible: false, reason: "no-root-marker" };
  }
  return { eligible: true, evidence, stage };
}

function versionEvidence(result) {
  const data = result?.moduleData || {};
  const value = data.detectedVersion || data.version || data.rawVersion || data.classicVersion || null;
  const source = data.detectedVersionSource || data.detectedSource || data.versionSource || null;
  const unreliable = data.rawVersionReliable === false || (typeof value === "string" && /(?:\.x|unknown|inferred)/i.test(value));
  const declared = data.detectedVersionConfidence || data.versionConfidence;
  const exactHeader = typeof value === "string" && /^\d+\.\d+\.\d+(?:\.\d+)*$/.test(value) && /\bheader\b/i.test(source || "");
  const certainty = !value ? "unknown" : declared || (unreliable ? "inferred" : exactHeader ? "exact" : "reported");
  return { value, source, certainty, engineVariant: data.rgssVersion || data.generation || null, rawVersionReliable: data.rawVersionReliable ?? null,
    detectedMajor: data.detectedMajor ?? data.major ?? null, detectedMinor: data.detectedMinor ?? null };
}

function candidateFor(mod, context, stage, gate, result) {
  if (!result || typeof result !== "object" || !result.gamePath) return null;
  const config = declaration(mod);
  const moduleEvidence = Array.isArray(result.detectionEvidence) ? result.detectionEvidence : [];
  // Packaged engines may retain their parent directory as gamePath while
  // validating the explicitly selected container. Rank the validated artifact
  // using common module metadata/evidence rather than engine-specific rules.
  const validatedPaths = [result.gamePath, result.moduleData?.packagedPath,
    ...moduleEvidence.filter(item => item?.type === "selected-artifact").map(item => item.path)];
  const direct = context.stat.isFile() && validatedPaths.some(filePath =>
    typeof filePath === "string" && filePath && path.resolve(filePath) === context.inputPath);
  const score = (config.fallback ? fallbackPriority(mod) : direct ? 100 : context.stat.isFile() ? 70 : 80)
    + (stage === "artifacts" ? executablePriority(context.inputPath) : 0);
  return { moduleId: mod.id, label: mod.manifest?.label || mod.id, stage, inputPath: context.inputPath, score,
    evidence: [...gate.evidence, ...moduleEvidence, ...(direct ? [{ type: "validated-selected-artifact", path: context.inputPath }] : [])], version: versionEvidence(result), detected: result };
}

function buildTasks(session, modules, context, stage) {
  const tasks = [];
  for (const mod of modules) {
    if (typeof mod.detectGame !== "function" && typeof mod.detectGameAsync !== "function") continue;
    const gate = gateProbe(session, mod, context, stage);
    if (!gate.eligible) { session.metrics.skipped++; session.trace.push({ stage, moduleId: mod.id, inputPath: context.inputPath, outcome: "skipped", reason: gate.reason }); continue; }
    tasks.push({ mod, context, stage, gate });
  }
  return tasks;
}

function recordProbe(session, task, result, error = null) {
  session.metrics.probes++;
  if (error) {
    session.trace.push({ stage: task.stage, moduleId: task.mod.id, inputPath: task.context.inputPath, outcome: "error", message: String(error.message || error), ...(error.code ? { code: error.code } : {}) });
    if (error.code === "DETECTION_LIMIT" || error.code === "DETECTION_CONFLICT") throw error;
    return null;
  }
  const candidate = candidateFor(task.mod, task.context, task.stage, task.gate, result);
  session.trace.push({ stage: task.stage, moduleId: task.mod.id, inputPath: task.context.inputPath, outcome: candidate ? "matched" : "no-match", ...(candidate ? { score: candidate.score, evidence: candidate.evidence, version: candidate.version } : {}) });
  return candidate;
}

function runTasksSync(session, tasks) {
  const results = [];
  for (const task of tasks) {
    if (typeof task.mod.detectGame !== "function") {
      session.trace.push({ stage: task.stage, moduleId: task.mod.id, outcome: "skipped", reason: "async-only-probe" });
      continue;
    }
    let result;
    let error;
    try {
      result = task.mod.detectGame(task.context, session.helpers);
      if (result && typeof result.then === "function") throw new Error("Async detection requires detectGameAsync/explainDetectionAsync.");
    } catch (e) { error = e; }
    const candidate = recordProbe(session, task, result, error);
    if (candidate) results.push(candidate);
  }
  return results;
}

function runWorker(session, task) {
  session.metrics.workersStarted++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "detection-worker.js"), { workerData: {
      modulePath: path.join(task.mod.__moduleDir, "main.js"), inputPath: task.context.inputPath, limits: session.limits,
      // Read-only ZIP metadata can be reused in the worker's cache; no files
      // are extracted and neither application/game entry points execute.
      zip: Array.from(session.caches.zip.entries()), archive: Array.from(session.caches.archive.entries())
    } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Detection worker timed out.")); }, session.limits.workerTimeoutMs);
    let settled = false;
    worker.once("message", message => {
      settled = true;
      clearTimeout(timer);
      if (message.error) reject(Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {})); else resolve(message.result);
    });
    worker.once("error", error => { settled = true; clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); if (!settled) reject(new Error(`Detection worker exited without a result (${code}).`)); });
  });
}

async function runTasksAsync(session, tasks) {
  const prepared = new Set();
  const archivePaths = [];
  for (const task of tasks) {
    if (!task.context.stat.isFile() || prepared.has(task.context.inputPath)) continue;
    prepared.add(task.context.inputPath);
    const facts = session.fileFacts(task.context.inputPath);
    if (facts.formats.includes("zip")) session.readZipEntries(task.context.inputPath);
    if (facts.formats.some(format => ["rar", "7z", "nsis", "inno", "cab"].includes(format))) archivePaths.push(task.context.inputPath);
  }
  // Share each expensive archive inventory across engine workers. The 7-Zip
  // helper is a native metadata reader and receives the selected file as data.
  let nextArchive = 0;
  await Promise.all(Array.from({ length: Math.min(session.limits.maxWorkers, archivePaths.length) }, async () => {
    while (nextArchive < archivePaths.length) await session.readArchiveEntriesAsync(archivePaths[nextArchive++]);
  }));
  const results = new Array(tasks.length);
  const failures = new Array(tasks.length);
  let stopped = false;
  let next = 0;
  async function work() {
    while (!stopped && next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      let result, error;
      try {
        if (typeof task.mod.detectGameAsync === "function") result = await task.mod.detectGameAsync(task.context, session.helpers);
        else if (!session.inlineWorkers && declaration(task.mod).worker === true && task.context.stat.isFile() && task.mod.__moduleDir) result = await runWorker(session, task);
        else result = await task.mod.detectGame(task.context, session.helpers);
      } catch (e) { error = e; }
      try { results[index] = recordProbe(session, task, result, error); }
      catch (failure) { failures[index] = failure; stopped = true; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(session.limits.maxWorkers, tasks.length) }, work));
  // Already-running probes finish before returning a failure. Reports stay
  // stable, and a rejected module cannot leave unobserved work in the session.
  const failure = failures.find(Boolean);
  if (failure) throw failure;
  return results.filter(Boolean);
}

function artifactContexts(session, modules) {
  const initial = session.context;
  if (!initial.stat.isDirectory() || initial.isAppBundle) return [];
  const extensions = new Set(modules.flatMap(mod => declaration(mod).directoryFileExtensions || []));
  const probeExecutables = modules.some(mod => declaration(mod).probeExecutables);
  const paths = session.readdir(initial.rootDir).filter(entry => {
    if (!entry.isFile()) return false;
    if (extensions.has(path.extname(entry.name).toLowerCase())) return true;
    if (!probeExecutables) return false;
    const header = session.readBytes(path.join(initial.rootDir, entry.name), 0, 16);
    return Boolean(header && (header.subarray(0, 2).toString("ascii") === "MZ" || header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))));
  }).map(entry => path.join(initial.rootDir, entry.name));
  paths.sort((a, b) => {
    const base = path.basename(initial.rootDir).toLowerCase();
    const exactA = path.basename(a, path.extname(a)).toLowerCase() === base;
    const exactB = path.basename(b, path.extname(b)).toLowerCase() === base;
    return Number(exactB) - Number(exactA) || a.localeCompare(b);
  });
  if (paths.length > session.limits.maxProbeFiles) throw new DetectionError("Too many candidate game files; select a game file directly.", "DETECTION_LIMIT");
  return paths.map(inputPath => ({ inputPath, rootDir: initial.rootDir, stat: session.stat(inputPath), isAppBundle: false, fileKind: "file", extension: path.extname(inputPath).toLowerCase(), detection: session.helpers }));
}

function chooseCandidate(candidates) {
  if (!candidates.length) return null;
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.moduleId}\0${path.resolve(candidate.detected.gamePath)}`;
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  }
  const sorted = Array.from(unique.values()).sort((a, b) => b.score - a.score || a.moduleId.localeCompare(b.moduleId));
  const strongest = sorted.filter(candidate => candidate.score === sorted[0].score);
  if (strongest.length > 1) throw new DetectionError(`Ambiguous game input: ${strongest.map(candidate => `${candidate.label} (${candidate.detected.gamePath})`).join("; ")}. Select an individual game file or a more specific folder.`, "DETECTION_CONFLICT");
  return strongest[0];
}

function childAppContexts(session) {
  const initial = session.context;
  if (!initial.stat.isDirectory() || initial.isAppBundle) return [];
  const apps = session.readdir(initial.rootDir).filter(entry => entry.isDirectory()).map(entry => {
    const inputPath = path.join(initial.rootDir, entry.name);
    const applicationBundle = /\.app$/i.test(entry.name) ? null
      : AppBundle.inspectApplicationBundle(inputPath, { detection: session.helpers });
    return /\.app$/i.test(entry.name) || applicationBundle ? { name: entry.name, applicationBundle } : null;
  }).filter(Boolean);
  if (apps.length > session.limits.maxProbeFiles) throw new DetectionError("Too many app bundles; select an app directly.", "DETECTION_LIMIT");
  return apps.sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const inputPath = path.join(initial.rootDir, entry.name);
    return { inputPath, canonicalPath: path.join(initial.canonicalPath, entry.name), rootDir: inputPath,
      stat: session.stat(inputPath), isAppBundle: true, applicationBundle: entry.applicationBundle, fileKind: "app", extension: null, detection: session.helpers };
  });
}

// Try a single immediate wrapper folder only after the selected folder has no
// recognized game. The existing session shares caches and all detection budgets.
function* detectionContexts(session) {
  const initial = session.context;
  yield initial;
  if (!initial.stat.isDirectory() || initial.isAppBundle) return;
  const children = session.readdir(initial.rootDir).filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  if (children.length !== 1) return;
  const inputPath = path.join(initial.rootDir, children[0].name);
  const canonicalPath = fs.realpathSync(inputPath);
  if (!isInside(initial.canonicalPath, canonicalPath)) return;
  const applicationBundle = /\.app$/i.test(inputPath) ? null : AppBundle.inspectApplicationBundle(inputPath, { detection: session.helpers });
  const isAppBundle = /\.app$/i.test(inputPath) || Boolean(applicationBundle);
  yield { inputPath, canonicalPath, rootDir: inputPath, stat: session.stat(inputPath),
    isAppBundle, applicationBundle, fileKind: isAppBundle ? "app" : "directory", extension: null, detection: session.helpers };
}

function chooseChildApp(candidates) {
  if (candidates.length > 1) throw new DetectionError("Multiple game apps found. Select an individual app bundle.", "DETECTION_CONFLICT");
  return candidates[0] || null;
}

function reportFor(session, candidates, selected = null, error = null) {
  return { format: "maclauncher-detection-v1", input: session.input, detected: selected?.detected || null, selectedModuleId: selected?.moduleId || null,
    candidates, versions: candidates.map(candidate => ({ moduleId: candidate.moduleId, ...candidate.version })), trace: session.trace,
    metrics: session.metrics, limits: session.limits, ...(error ? { error: { code: error.code || "DETECTION_ERROR", message: error.message } } : {}) };
}

function notFoundError(session, modules) {
  if (session.context.isAppBundle) return new DetectionError(`Unsupported app bundle. Supported modules: ${modules.map(mod => mod.manifest?.label || mod.id).join(", ")}.`, "DETECTION_UNSUPPORTED");
  return new DetectionError("No supported game found. Could not find index.html in root or www/ or a recognized engine artifact.", "DETECTION_UNSUPPORTED");
}

function exclusiveError(session, owners) {
  return new DetectionError(`Unsupported ${session.input.extension || "file"} input for ${owners.map(mod => mod.manifest?.label || mod.id).join(", ")}`, "DETECTION_UNSUPPORTED_EXTENSION");
}

function explainDetection(inputPath, modules, options = {}) {
  let session;
  const candidates = [];
  try {
    session = createDetectionSession(inputPath, options);
    for (const context of detectionContexts(session)) {
      session.context = context;
      const owners = extensionOwners(modules, session.input.extension);
      if (owners.length) {
        candidates.push(...runTasksSync(session, buildTasks(session, owners, session.context, "owned-extension")));
        const selected = chooseCandidate(candidates);
        if (!selected) throw exclusiveError(session, owners);
        return reportFor(session, candidates, selected);
      }
      const specific = modules.filter(mod => !declaration(mod).fallback);
      candidates.push(...runTasksSync(session, buildTasks(session, specific, session.context, "specific")));
      let selected = chooseCandidate(candidates);
      if (selected) return reportFor(session, candidates, selected);
      for (const context of artifactContexts(session, specific)) {
        const owners = extensionOwners(specific, context.extension);
        candidates.push(...runTasksSync(session, buildTasks(session, owners.length ? owners : specific, context, "artifacts")));
      }
      selected = chooseCandidate(candidates);
      if (selected) return reportFor(session, candidates, selected);
      const appCandidates = [];
      for (const context of childAppContexts(session)) {
        let matches = runTasksSync(session, buildTasks(session, specific, context, "child-app"));
        for (const group of fallbackGroups(modules)) {
          if (matches.length) break;
          matches = runTasksSync(session, buildTasks(session, group, context, "child-app-fallback"));
        }
        const app = chooseCandidate(matches);
        if (app) appCandidates.push(app);
      }
      candidates.push(...appCandidates);
      selected = chooseChildApp(appCandidates);
      if (selected) return reportFor(session, candidates, selected);
      for (const group of fallbackGroups(modules)) {
        candidates.push(...runTasksSync(session, buildTasks(session, group, session.context, "fallback")));
        selected = chooseCandidate(candidates);
        if (selected) return reportFor(session, candidates, selected);
      }
    }
    throw notFoundError(session, modules);
  } catch (error) {
    if (!session) return { format: "maclauncher-detection-v1", input: { requestedPath: inputPath }, detected: null, candidates, trace: [], versions: [], metrics: {}, error: { code: error.code || "DETECTION_ERROR", message: error.message } };
    return reportFor(session, candidates, null, error);
  }
}

async function explainDetectionAsync(inputPath, modules, options = {}) {
  let session;
  const candidates = [];
  try {
    session = createDetectionSession(inputPath, options);
    for (const context of detectionContexts(session)) {
      session.context = context;
      const owners = extensionOwners(modules, session.input.extension);
      if (owners.length) {
        candidates.push(...await runTasksAsync(session, buildTasks(session, owners, session.context, "owned-extension")));
        const selected = chooseCandidate(candidates);
        if (!selected) throw exclusiveError(session, owners);
        return reportFor(session, candidates, selected);
      }
      const specific = modules.filter(mod => !declaration(mod).fallback);
      candidates.push(...await runTasksAsync(session, buildTasks(session, specific, session.context, "specific")));
      let selected = chooseCandidate(candidates);
      if (selected) return reportFor(session, candidates, selected);
      const tasks = artifactContexts(session, specific).flatMap(context => {
        const owners = extensionOwners(specific, context.extension);
        return buildTasks(session, owners.length ? owners : specific, context, "artifacts");
      });
      candidates.push(...await runTasksAsync(session, tasks));
      selected = chooseCandidate(candidates);
      if (selected) return reportFor(session, candidates, selected);
      const appCandidates = [];
      for (const context of childAppContexts(session)) {
        let matches = await runTasksAsync(session, buildTasks(session, specific, context, "child-app"));
        for (const group of fallbackGroups(modules)) {
          if (matches.length) break;
          matches = await runTasksAsync(session, buildTasks(session, group, context, "child-app-fallback"));
        }
        const app = chooseCandidate(matches);
        if (app) appCandidates.push(app);
      }
      candidates.push(...appCandidates);
      selected = chooseChildApp(appCandidates);
      if (selected) return reportFor(session, candidates, selected);
      for (const group of fallbackGroups(modules)) {
        candidates.push(...await runTasksAsync(session, buildTasks(session, group, session.context, "fallback")));
        selected = chooseCandidate(candidates);
        if (selected) return reportFor(session, candidates, selected);
      }
    }
    throw notFoundError(session, modules);
  } catch (error) {
    if (!session) return { format: "maclauncher-detection-v1", input: { requestedPath: inputPath }, detected: null, candidates, trace: [], versions: [], metrics: {}, error: { code: error.code || "DETECTION_ERROR", message: error.message } };
    return reportFor(session, candidates, null, error);
  }
}

function resultOrThrow(report) {
  if (report.error) throw new DetectionError(report.error.message, report.error.code, report);
  return report.detected;
}

module.exports = { DEFAULT_LIMITS, DetectionError, createDetectionSession, explainDetection, explainDetectionAsync, resultOrThrow, declaration, versionEvidence, extensionOwners, gateProbe, chooseCandidate };
