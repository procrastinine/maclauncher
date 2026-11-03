const fs = require("node:fs");
const { cloneOrCopySync } = require("../../shared/copy-file");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GameData = require("../../shared/game-data");
const { readMachOArchitectures } = require("../../shared/runtime/local-native");
const Architecture = require("../../shared/runtime/architecture");
const SDK_LAYOUT_FILE = ".maclauncher-sdk.json";
const MAC_LIB_NAMES = {
  py2: ["py2-mac-universal", "py2-mac-x86_64", "py2-mac-x86-64", "mac-x86_64"],
  py3: ["py3-mac-universal", "py3-mac-x86_64", "py3-mac-x86-64", "mac-x86_64"]
};

function normalizeRenpyMajor(input) {
  const major = Number(input);
  if (!Number.isFinite(major)) return null;
  if (major >= 8) return 8;
  if (major >= 1) return 7;
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function removePath(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function guessPythonTag(renpyMajor) {
  const major = normalizeRenpyMajor(renpyMajor);
  return major === 7 ? "py2" : "py3";
}

function platformFromLibDirName(name) {
  if (!name) return null;
  const stripped = String(name).replace(/^py\d+-/, "");
  return stripped || null;
}

function findMacLibDir(rootDir, renpyMajor, {version, baseName} = {}) {
  const tag = guessPythonTag(String(renpyMajor).split(".")[0]);
  const libDir = path.join(rootDir, "lib");
  const result = name => ({name, dir: path.join(libDir, name), platform: platformFromLibDirName(name)});
  const hasProgram = name => existsFile(path.join(libDir, name, "renpy")) ||
    Boolean(baseName && existsFile(path.join(libDir, name, baseName)));
  try {
    const file = path.join(rootDir, SDK_LAYOUT_FILE);
    const saved = fs.statSync(file).size <= 65536 ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const name = saved?.macLibDirName;
    if (typeof name === "string" && name.length <= 1024 && !path.isAbsolute(name) && !name.split(/[\\/]/).includes("..") && hasProgram(name)) return result(name);
  } catch {}
  const rootName = path.basename(rootDir);
  const hint = version || (/^\d+\.\d+\.\d+$|^renpy-\d+\.\d+\.\d+-sdk$/.test(rootName) ? rootName : "");
  const release = String(hint).match(/(\d+)\.(\d+)\./);
  const legacy = release && (Number(release[1]) < 7 || Number(release[1]) === 7 && Number(release[2]) < 4);
  const oldNames = ["darwin-x86_64", "mac-x86_64", "mac-universal"];
  const newNames = [...MAC_LIB_NAMES[tag], `${tag}-mac-arm64`, "mac-arm64", "darwin-arm64", "darwin-universal"];
  const names = [...new Set(legacy ? [...oldNames, ...newNames] : [...newNames, ...oldNames])];
  for (const name of names) {
    if (hasProgram(name)) return result(name);
  }
  // New publisher names are recognized by Mac Python and launcher contents.
  // Bound breadth, depth and entries; directory symlinks are not traversed.
  const queue = [{name: "", depth: 0}], matches = [];
  const target = Architecture.selectedArchitecture() === "x64" ? "x86_64" : "arm64";
  let visited = 0, entriesRead = 0;
  while (queue.length && visited++ < 256 && entriesRead < 4096) {
    const current = queue.shift(), directory = path.join(libDir, current.name);
    let entries;
    try { entries = fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 4096 - entriesRead); }
    catch { continue; }
    entriesRead += entries.length;
    const python = entries.find(item => /^(?:python(?:[23](?:\.\d+)*)?|pythonw)$/.test(item.name));
    const program = entries.find(item => item.name === "renpy" || baseName && item.name === baseName);
    if (current.name && python && program) {
      try {
        readMachOArchitectures(path.join(directory, python.name));
        const architectures = readMachOArchitectures(path.join(directory, program.name));
        const family = path.basename(current.name).match(/^py([23])/);
        matches.push({...current, cpuRank: architectures.includes(target) ? 0 : 1,
          familyRank: family ? `py${family[1]}` === tag ? 0 : 2 : 1});
      } catch {}
    }
    if (current.depth < 3) for (const item of entries) {
      if (item.isDirectory() && queue.length < 256) queue.push({name: path.join(current.name, item.name), depth: current.depth + 1});
    }
  }
  matches.sort((a, b) => a.familyRank - b.familyRank || a.cpuRank - b.cpuRank || a.depth - b.depth || a.name.localeCompare(b.name));
  return matches.length ? result(matches[0].name) : null;
}

function ensureExecutable(filePath) {
  try {
    const st = fs.statSync(filePath);
    const mode = st.mode | 0o111;
    fs.chmodSync(filePath, mode);
  } catch {}
}

function clearQuarantine(paths) {
  const xattr = fs.existsSync("/usr/bin/xattr") ? "/usr/bin/xattr" : "xattr";
  for (const p of paths) {
    if (!p) continue;
    try {
      spawnSync(xattr, ["-dr", "com.apple.quarantine", p], { stdio: "ignore" });
      spawnSync(xattr, ["-dr", "com.apple.provenance", p], { stdio: "ignore" });
    } catch {}
  }
}

function patchRootDir(userDataDir, gameId) {
  if (!userDataDir || !gameId) return null;
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"), "patches");
}

function patchMetaPath(userDataDir, gameId) {
  const root = patchRootDir(userDataDir, gameId);
  if (!root) return null;
  return path.join(root, "patch.json");
}

function readPatchMeta(userDataDir, gameId) {
  const p = patchMetaPath(userDataDir, gameId);
  if (!existsFile(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writePatchMeta(userDataDir, gameId, meta) {
  const p = patchMetaPath(userDataDir, gameId);
  if (!p) throw new Error("Missing patch metadata path.");
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
  return p;
}

function buildPatchStatus({ userDataDir, gameId, gamePath, contentRootDir, renpyBaseName, renpyMajor }) {
  const meta = readPatchMeta(userDataDir, gameId);
  const libInfo = meta?.macLibDirName
    ? {
        name: meta.macLibDirName,
        dir: path.join(contentRootDir, "lib", meta.macLibDirName),
        platform: meta.platform || platformFromLibDirName(meta.macLibDirName)
      }
    : findMacLibDir(contentRootDir, renpyMajor, {baseName: renpyBaseName});
  const libDir = libInfo?.dir || null;
  const baseName = renpyBaseName || null;
  const baseBinary = baseName && libDir ? path.join(libDir, baseName) : null;
  const renpyBinary = libDir ? path.join(libDir, "renpy") : null;
  const shPath = baseName ? path.join(contentRootDir, `${baseName}.sh`) : null;

  const macLibExists = Boolean(libDir && existsDir(libDir));
  const baseBinaryExists = Boolean(baseBinary && existsFile(baseBinary));
  const renpyBinaryExists = Boolean(renpyBinary && existsFile(renpyBinary));
  const shellScriptExists = Boolean(shPath && existsFile(shPath));
  const patched = macLibExists && (baseBinaryExists || renpyBinaryExists);
  const partial = macLibExists && !patched;

  return {
    engine: "renpy",
    gamePath,
    contentRootDir,
    renpyBaseName: baseName,
    macLibDir: libInfo?.name || null,
    platform: libInfo?.platform || null,
    sdkVersion: meta?.sdkVersion || null,
    patched,
    partial,
    details: {
      metaExists: Boolean(meta),
      macLibExists,
      baseBinaryExists,
      renpyBinaryExists,
      shellScriptExists
    }
  };
}

function patchGame({
  userDataDir,
  gameId,
  gamePath,
  contentRootDir,
  renpyBaseName,
  renpyMajor,
  sdkInstallDir,
  sdkVersion,
  renpyVersion
}) {
  if (!contentRootDir || !existsDir(contentRootDir)) {
    throw new Error("Game directory not found.");
  }
  if (!sdkInstallDir || !existsDir(sdkInstallDir)) {
    throw new Error("Ren'Py SDK not found.");
  }

  const baseName = renpyBaseName;
  if (!baseName) {
    throw new Error("Missing Ren'Py executable name.");
  }

  const sdkLib = findMacLibDir(sdkInstallDir, renpyMajor, {version: sdkVersion});
  if (!sdkLib) {
    throw new Error("Ren'Py SDK is missing macOS libraries.");
  }

  const targetLibDir = path.join(contentRootDir, "lib", sdkLib.name);
  const preexistingLib = existsDir(targetLibDir);
  if (!preexistingLib) {
    ensureDir(path.dirname(targetLibDir));
    cloneOrCopySync(sdkLib.dir, targetLibDir);
  }

  const renpyBinaryPath = path.join(targetLibDir, "renpy");
  const baseBinaryPath = path.join(targetLibDir, baseName);
  const preexistingBinary = existsFile(baseBinaryPath);
  if (!preexistingBinary) {
    if (!existsFile(renpyBinaryPath)) {
      throw new Error("Ren'Py mac binary not found in SDK libs.");
    }
    cloneOrCopySync(renpyBinaryPath, baseBinaryPath);
  }

  ensureExecutable(renpyBinaryPath);
  ensureExecutable(baseBinaryPath);

  const shPath = path.join(contentRootDir, `${baseName}.sh`);
  if (existsFile(shPath)) ensureExecutable(shPath);

  clearQuarantine([targetLibDir, shPath]);

  const meta = {
    gamePath,
    contentRootDir,
    renpyVersion: renpyVersion || null,
    renpyMajor: Number.isFinite(Number(renpyMajor)) ? Number(renpyMajor) : null,
    sdkVersion: sdkVersion || null,
    macLibDirName: sdkLib.name,
    platform: sdkLib.platform,
    renpyBaseName: baseName,
    createdBinary: !preexistingBinary,
    preexistingMacLib: preexistingLib,
    patchedAt: new Date().toISOString()
  };
  writePatchMeta(userDataDir, gameId, meta);

  return buildPatchStatus({
    userDataDir,
    gameId,
    gamePath,
    contentRootDir,
    renpyBaseName: baseName,
    renpyMajor
  });
}

function unpatchGame({ userDataDir, gameId, gamePath, contentRootDir, renpyBaseName, renpyMajor }) {
  const meta = readPatchMeta(userDataDir, gameId);
  if (!meta) {
    return buildPatchStatus({
      userDataDir,
      gameId,
      gamePath,
      contentRootDir,
      renpyBaseName,
      renpyMajor
    });
  }

  if (!meta.preexistingMacLib && meta.macLibDirName) {
    const libDir = path.join(contentRootDir, "lib", meta.macLibDirName);
    removePath(libDir);
  }

  if (meta.createdBinary && meta.macLibDirName && meta.renpyBaseName) {
    const binPath = path.join(contentRootDir, "lib", meta.macLibDirName, meta.renpyBaseName);
    removePath(binPath);
  }

  removePath(patchMetaPath(userDataDir, gameId));

  return buildPatchStatus({
    userDataDir,
    gameId,
    gamePath,
    contentRootDir,
    renpyBaseName,
    renpyMajor
  });
}

module.exports = {
  buildPatchStatus,
  patchGame,
  unpatchGame,
  readPatchMeta,
  SDK_LAYOUT_FILE,
  findMacLibDir
};
