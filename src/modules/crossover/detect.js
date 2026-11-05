const fs = require("node:fs");
const path = require("node:path");
const { executablePriority, executableRole } = require("../shared/executable-candidates");
const { readDefaultWindowsExecutable } = require("../../core/steam-downloads");

const LIMITS = Object.freeze({ directories: 256, entries: 8192, executables: 128, depth: 8 });
// Third-party installers, redistributables and bundled Java runtimes.
const SKIPPED_DIRECTORIES = /^(?:node_modules|_?redist|redistributables?|_commonredist|__macosx|directx|dotnet|vc_?redist|prereqs?|prerequisites|(?:jre|jdk)(?:[-_.\d].*)?)$/i;
const NATIVE_MAGIC = new Set([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const stat = file => { try { return fs.statSync(file); } catch { return null; } };
// A game recorded at or inside an app bundle runs as that app. An app bundle
// beside a Windows executable, as in Ren'Py's PC releases, is not the game's
// path and does not count. This reads the recorded paths only, never the disk.
const inAppBundle = file => typeof file === "string" && /\.app(?:\/|$)/i.test(file);
const bundledGame = entry => inAppBundle(entry?.gamePath) || inAppBundle(entry?.contentRootDir);

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

// Detection and Play read the game's files; the library reads only the record.
function isNativeImport(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (bundledGame(entry)) return true;
  // A native executable that is itself the game keeps its identity even when a
  // sibling Windows helper exists. A launcher script or binary selected inside
  // a folder game, or a folder import, leaves the identity to the whole folder.
  const identity = entry.gamePath;
  if (typeof identity !== "string") return false;
  if (typeof entry.importPath === "string" && entry.importPath !== identity && stat(entry.importPath)?.isDirectory()) return false;
  if (/\.(?:appimage|sh|elf|x86_64|x86)$/i.test(identity)) return true;
  // Read only the game file's header, never the game tree.
  if (!stat(identity)?.isFile()) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(identity, "r");
    const header = Buffer.alloc(4);
    return fs.readSync(descriptor, header, 0, 4, 0) === 4 && NATIVE_MAGIC.has(header.readUInt32BE(0));
  } catch { return false; } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

// The game's own folder: a folder game path, or the folder holding a single-file
// game. A content root inside it, such as a data or resources folder, does not
// narrow the search. A content root or recorded release folder that encloses it,
// such as the NW.js release around an imported www folder, widens it.
function searchRoot(entry) {
  const directory = file => {
    const info = typeof file === "string" && path.isAbsolute(file) ? stat(file) : null;
    return info?.isDirectory() ? file : info?.isFile() ? path.dirname(file) : null;
  };
  const enclosing = [entry.contentRootDir, entry.releaseRootDir]
    .filter(folder => typeof folder === "string" && path.isAbsolute(folder) && stat(folder)?.isDirectory());
  let root = directory(entry.gamePath) || enclosing[0] || null;
  for (const folder of enclosing) if (root && inside(folder, root)) root = folder;
  return root;
}

// The executable that detection recorded. Library views and runtime choices
// use only this record and the recorded paths, so they never touch the disk and
// a game on a disconnected drive keeps its choices. Detection writes the record
// on import and whenever the game's details are refreshed; Play searches again.
function cachedWindowsExecutable(entry) {
  const known = entry?.runtimeData?.crossover, file = known?.windowsExecutablePath;
  if (typeof file !== "string" || !path.isAbsolute(file) || bundledGame(entry) || inAppBundle(file)) return null;
  // Records from earlier versions can lack the searched folder.
  const sourceRoot = [known.sourceRoot, entry.releaseRootDir, entry.contentRootDir, entry.gamePath, typeof entry.gamePath === "string" ? path.dirname(entry.gamePath) : null]
    .find(root => typeof root === "string" && path.isAbsolute(root) && root !== file && inside(root, file));
  return sourceRoot ? { windowsExecutablePath: file, executableArchitecture: known.executableArchitecture, sourceRoot } : null;
}

// CrossOver and Sikarugir both run x86 and x64 Windows executables.
const supportsWindowsRuntimes = entry => ["x86", "x86_64"].includes(cachedWindowsExecutable(entry)?.executableArchitecture);

const comparableName = value => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
const fileStem = file => typeof file === "string" ? path.basename(file).replace(/\.[a-z0-9_]{1,8}$/i, "") : null;

function findWindowsExecutable(entry, { detection, selectedPath } = {}) {
  if (!entry || isNativeImport(entry)) return null;
  const root = searchRoot(entry);
  if (!root) return null;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch { return null; }
  const check = file => {
    if (typeof file !== "string" || !/\.exe$/i.test(file) || !inside(root, path.resolve(file)) ||
        inAppBundle(path.relative(root, path.resolve(file)))) return null;
    try { if (!inside(canonicalRoot, fs.realpathSync(file))) return null; } catch { return null; }
    return readWindowsExecutable(file, detection);
  };
  const imported = typeof entry.importPath === "string" && path.isAbsolute(entry.importPath) ? entry.importPath : null;
  // User selections precede the publisher's recorded entry, then the module's
  // entry and detection's cached game file. All pass the same file checks.
  // A game file chosen by detection, rather than by the user, counts only when it
  // is not an installer or other support program, such as a setup package.
  for (const file of [selectedPath,
    stat(imported)?.isFile() ? imported : null,
    readDefaultWindowsExecutable(root),
    imported !== root && stat(imported)?.isDirectory() && inside(imported, root) ? readDefaultWindowsExecutable(imported) : null,
    entry.moduleData?.executablePath, entry.moduleData?.exePath,
    entry.runtimeData?.crossover?.windowsExecutablePath, entry.windowsExecutablePath,
    stat(entry.gamePath)?.isFile() && executableRole(entry.gamePath) !== "support" ? entry.gamePath : null]) {
    const match = check(file);
    if (match) return { ...match, sourceRoot: root };
  }
  // A folder game, or a game imported as a folder, owns everything below its
  // folder. The folder around a single-file game can hold unrelated programs,
  // so only executables beside it and named like it count.
  const folderGame = Boolean(stat(entry.gamePath)?.isDirectory() || imported && stat(imported)?.isDirectory() &&
    (inside(imported, root) || inside(root, imported)));
  const names = [entry.name, fileStem(entry.gamePath), fileStem(imported), folderGame ? path.basename(root) : null]
    .map(comparableName).filter(name => name.length >= 3);
  const related = name => names.some(other => name === other ||
    Math.min(name.length, other.length) >= 4 && (name.startsWith(other) || other.startsWith(name)));
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
      if (item.isDirectory() && folderGame && depth < LIMITS.depth && !/^\.|\.app$/i.test(item.name) && !SKIPPED_DIRECTORIES.test(item.name)) {
        queue.push({ directory: file, depth: depth + 1 });
      } else if (item.isFile() && /\.exe$/i.test(item.name)) {
        // Uninstallers, crash handlers, redistributables and SDK tools are
        // never the game's executable.
        const role = executableRole(file), name = comparableName(path.basename(item.name, path.extname(item.name)));
        if (role === "support" || !folderGame && !related(name)) continue;
        if (++executables > LIMITS.executables) break;
        const match = check(file);
        if (!match) continue;
        candidates.push({ ...match, sourceRoot: root, score: (role === "secondary" ? -100 : 0) + (related(name) ? 50 : 0) +
          (name === "game" ? 10 : 0) - depth * 5 });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.windowsExecutablePath.localeCompare(b.windowsExecutablePath));
  const { score: _score, ...best } = candidates[0] || {};
  return candidates.length ? best : null;
}

// Records the game's Windows executable, or its absence, for every detected
// game. The detection input tells a folder import from a single-file import.
function decorateEntry(entry, { inputPath } = {}) {
  const match = findWindowsExecutable(entry?.importPath || !inputPath ? entry : { ...entry, importPath: inputPath });
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
    match = check(readDefaultWindowsExecutable(sourceRoot));
    if (!match) {
      const children = context.detection?.readdir ? context.detection.readdir(sourceRoot) : fs.readdirSync(sourceRoot, { withFileTypes: true });
      if (children.length > LIMITS.entries) throw Object.assign(new Error("The Windows game folder contains too many entries. Select a Windows executable directly."), { code: "DETECTION_LIMIT" });
      const candidates = [];
      for (const item of children) {
        // Installers, redistributables and bundled tools never identify a Windows game.
        if (!item.isFile() && !item.isSymbolicLink() || executableRole(item.name) === "support") continue;
        const executable = check(path.join(sourceRoot, item.name));
        if (!executable) continue;
        candidates.push({ executable, priority: executablePriority(executable.windowsExecutablePath) });
      }
      candidates.sort((a, b) => b.priority - a.priority);
      const strongest = candidates.filter(candidate => candidate.priority === candidates[0].priority);
      if (strongest.length > 1) throw Object.assign(new Error("Multiple Windows executables were found in this folder. Select one .exe file to identify the game."), { code: "DETECTION_CONFLICT" });
      match = strongest[0]?.executable;
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

module.exports = { LIMITS, inside, readWindowsExecutable, isNativeImport, cachedWindowsExecutable, supportsWindowsRuntimes,
  findWindowsExecutable, decorateEntry, detectGame };
