const fs = require("node:fs");
const path = require("node:path");

const LIMITS = Object.freeze({ directories: 256, entries: 8192, executables: 128, depth: 8 });
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const stat = file => { try { return fs.statSync(file); } catch { return null; } };

// An extension or DOS stub alone does not establish Windows playback. Validate
// the PE signature, executable flags, optional header and Windows subsystem.
function readWindowsExecutable(file, detection) {
  let descriptor;
  try {
    const info = detection?.stat ? detection.stat(file) : stat(file);
    if (!info?.isFile() || info.size < 128) return null;
    const read = (offset, length) => {
      if (offset < 0 || offset + length > info.size) return null;
      if (detection?.readBytes) return detection.readBytes(file, offset, length);
      descriptor ??= fs.openSync(file, "r");
      const result = Buffer.alloc(length);
      return fs.readSync(descriptor, result, 0, length, offset) === length ? result : null;
    };
    const dos = read(0, 64);
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > 1024 * 1024) return null;
    const header = read(offset, 24);
    if (!header || header.readUInt32LE(0) !== 0x4550) return null;
    const machine = header.readUInt16LE(4), sections = header.readUInt16LE(6);
    const optionalSize = header.readUInt16LE(20), flags = header.readUInt16LE(22);
    if (!(flags & 2) || flags & 0x2000 || !sections || sections > 96 || optionalSize < 70 || optionalSize > 4096) return null;
    const optional = read(offset + 24, 70);
    const architecture = new Map([[0x14c, "x86"], [0x8664, "x86_64"], [0xaa64, "arm64"]]).get(machine);
    if (!optional || !architecture || ![0x10b, 0x20b].includes(optional.readUInt16LE(0)) ||
        ![2, 3].includes(optional.readUInt16LE(68)) ||
        optional.readUInt16LE(0) === 0x10b && machine !== 0x14c ||
        optional.readUInt16LE(0) === 0x20b && machine === 0x14c ||
        offset + 24 + optionalSize + sections * 40 > info.size) return null;
    return { windowsExecutablePath: path.resolve(file), executableArchitecture: architecture };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function isNativeImport(entry) {
  // Native app bundles retain their native identity. Their
  // helpers or unrelated sibling executables do not establish a Windows game.
  return [entry?.gamePath, entry?.contentRootDir, entry?.importPath]
    .some(file => typeof file === "string" && /\.app(?:\/|$)/i.test(file));
}

function findWindowsExecutable(entry, { detection, selectedPath } = {}) {
  if (!entry || isNativeImport(entry)) return null;
  const gamePath = entry.contentRootDir || entry.gamePath;
  if (typeof gamePath !== "string" || !path.isAbsolute(gamePath)) return null;
  const root = stat(gamePath)?.isFile() ? path.dirname(gamePath) : gamePath;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch { return null; }
  const check = file => {
    if (typeof file !== "string" || !/\.exe$/i.test(file) || !inside(root, path.resolve(file))) return null;
    try { if (!inside(canonicalRoot, fs.realpathSync(file))) return null; } catch { return null; }
    return readWindowsExecutable(file, detection);
  };
  // Deliberately selected executable and engine-provided paths precede guesses.
  for (const file of [selectedPath, entry.runtimeData?.crossover?.windowsExecutablePath,
    entry.moduleData?.executablePath, entry.moduleData?.exePath, entry.windowsExecutablePath,
    stat(entry.importPath)?.isFile() ? entry.importPath : null, stat(gamePath)?.isFile() ? gamePath : null]) {
    const match = check(file);
    if (match) return { ...match, sourceRoot: root };
  }
  const queue = [{ directory: root, depth: 0 }], candidates = [];
  let directories = 0, entries = 0, executables = 0;
  while (queue.length && directories < LIMITS.directories && entries < LIMITS.entries && executables < LIMITS.executables) {
    const { directory, depth } = queue.shift();
    directories++;
    let children;
    try { children = detection?.readdir ? detection.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "DETECTION_LIMIT") throw error; continue; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of children) {
      if (++entries > LIMITS.entries) break;
      const file = path.join(directory, item.name);
      if (item.isDirectory() && depth < LIMITS.depth && !/^\.|\.app$/i.test(item.name) &&
          !/^(?:node_modules|redist|redistributables|_commonredist|__macosx)$/i.test(item.name)) {
        queue.push({ directory: file, depth: depth + 1 });
      } else if (item.isFile() && /\.exe$/i.test(item.name)) {
        if (++executables > LIMITS.executables) break;
        const match = check(file);
        if (!match) continue;
        const name = path.basename(item.name, path.extname(item.name));
        const helper = /(?:^unins|uninstall|^install|^setup|^config$|crash|report|redist|vcredist|dxwebsetup|pythonw?$|zsync|createdump|server$)/i.test(name);
        const title = String(entry.name || path.basename(root)).replace(/[^a-z0-9]/gi, "").toLowerCase();
        const sameTitle = name.replace(/[^a-z0-9]/gi, "").toLowerCase() === title;
        candidates.push({ ...match, sourceRoot: root, score: (helper ? -1000 : 0) + (sameTitle ? 50 : 0) + (/^game$/i.test(name) ? 10 : 0) - depth * 5 });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.windowsExecutablePath.localeCompare(b.windowsExecutablePath));
  return candidates[0] || null;
}

function decorateEntry(entry) {
  const match = findWindowsExecutable(entry);
  const { windowsExecutablePath = null, executableArchitecture = null, sourceRoot = entry?.contentRootDir || entry?.gamePath || null } = match || {};
  return { ...entry, runtimeData: { ...entry.runtimeData, crossover: { ...entry.runtimeData?.crossover,
    detectionComplete: true, windowsExecutablePath, executableArchitecture, sourceRoot } } };
}

function detectGame(context) {
  if (!context || context.isAppBundle) return null;
  // Generic Windows fallback must be deliberate and unambiguous. Known engine
  // entries use the separate recursive provider evidence search above.
  const sourceRoot = context.rootDir;
  let canonicalRoot; try { canonicalRoot = fs.realpathSync(sourceRoot); } catch { return null; }
  const check = file => {
    if (!/\.exe$/i.test(file)) return null;
    try { if (!inside(canonicalRoot, fs.realpathSync(file))) return null; } catch { return null; }
    const executable = readWindowsExecutable(file, context.detection);
    return executable ? { ...executable, sourceRoot } : null;
  };
  let match;
  if (context.stat?.isFile()) match = check(context.inputPath);
  else if (context.stat?.isDirectory()) {
    const children = context.detection?.readdir ? context.detection.readdir(sourceRoot) : fs.readdirSync(sourceRoot, { withFileTypes: true });
    if (children.length > LIMITS.entries) throw Object.assign(new Error("The Windows game folder contains too many entries. Select a Windows executable directly."), { code: "DETECTION_LIMIT" });
    for (const item of children) {
      if (!item.isFile() && !item.isSymbolicLink()) continue;
      const executable = check(path.join(sourceRoot, item.name));
      if (!executable) continue;
      if (match) throw Object.assign(new Error("Multiple Windows executables were found in this folder. Select one .exe file to identify the game."), { code: "DETECTION_CONFLICT" });
      match = executable;
    }
  }
  if (!match) return null;
  const { windowsExecutablePath, executableArchitecture } = match;
  return { engine: "crossover", moduleId: "crossover", gameType: "windows",
    name: path.basename(windowsExecutablePath, path.extname(windowsExecutablePath)),
    gamePath: sourceRoot, contentRootDir: sourceRoot,
    runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath, executableArchitecture, sourceRoot } },
    moduleData: { executablePath: windowsExecutablePath, executableArchitecture },
    detectionEvidence: [{ type: "windows-pe", path: windowsExecutablePath, architecture: executableArchitecture }] };
}

module.exports = { LIMITS, inside, readWindowsExecutable, isNativeImport, findWindowsExecutable, decorateEntry, detectGame };
