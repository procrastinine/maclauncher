const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
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

function findMacLibDir(rootDir, renpyMajor) {
  const tag = guessPythonTag(renpyMajor);
  const libDir = path.join(rootDir, "lib");
  const names = MAC_LIB_NAMES[tag] || MAC_LIB_NAMES.py3;
  for (const name of names) {
    const candidate = path.join(libDir, name);
    if (existsDir(candidate)) {
      return { name, dir: candidate, platform: platformFromLibDirName(name) };
    }
  }
  return null;
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

function patchRootDir(userDataDir) {
  return path.join(userDataDir, "modules", "renpy", "patches");
}

function patchMetaPath(userDataDir, gamePath) {
  const id = stableIdForPath(gamePath);
  return path.join(patchRootDir(userDataDir), `${id}.json`);
}

function readPatchMeta(userDataDir, gamePath) {
  const p = patchMetaPath(userDataDir, gamePath);
  if (!existsFile(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writePatchMeta(userDataDir, gamePath, meta) {
  const p = patchMetaPath(userDataDir, gamePath);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
  return p;
}

function buildPatchStatus({ userDataDir, gamePath, contentRootDir, renpyBaseName, renpyMajor }) {
  const meta = readPatchMeta(userDataDir, gamePath);
  const libInfo = meta?.macLibDirName
    ? {
        name: meta.macLibDirName,
        dir: path.join(contentRootDir, "lib", meta.macLibDirName),
        platform: meta.platform || platformFromLibDirName(meta.macLibDirName)
      }
    : findMacLibDir(contentRootDir, renpyMajor);
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

  const sdkLib = findMacLibDir(sdkInstallDir, renpyMajor);
  if (!sdkLib) {
    throw new Error("Ren'Py SDK is missing macOS libraries.");
  }

  const targetLibDir = path.join(contentRootDir, "lib", sdkLib.name);
  const preexistingLib = existsDir(targetLibDir);
  if (!preexistingLib) {
    ensureDir(path.dirname(targetLibDir));
    fs.cpSync(sdkLib.dir, targetLibDir, { recursive: true });
  }

  const renpyBinaryPath = path.join(targetLibDir, "renpy");
  const baseBinaryPath = path.join(targetLibDir, baseName);
  const preexistingBinary = existsFile(baseBinaryPath);
  if (!preexistingBinary) {
    if (!existsFile(renpyBinaryPath)) {
      throw new Error("Ren'Py mac binary not found in SDK libs.");
    }
    fs.copyFileSync(renpyBinaryPath, baseBinaryPath);
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
  writePatchMeta(userDataDir, gamePath, meta);

  return buildPatchStatus({
    userDataDir,
    gamePath,
    contentRootDir,
    renpyBaseName: baseName,
    renpyMajor
  });
}

function unpatchGame({ userDataDir, gamePath, contentRootDir, renpyBaseName, renpyMajor }) {
  const meta = readPatchMeta(userDataDir, gamePath);
  if (!meta) {
    return buildPatchStatus({
      userDataDir,
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

  removePath(patchMetaPath(userDataDir, gamePath));

  return buildPatchStatus({
    userDataDir,
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
  findMacLibDir
};
