const fs = require("node:fs");
const path = require("node:path");

const PACK_MAGIC = Buffer.from("GDPC", "ascii");
const PACK_HEADER_SIZE = 20;

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function readBuffer(fd, offset, length) {
  if (offset < 0 || length <= 0) return null;
  const buf = Buffer.alloc(length);
  const res = fs.readSync(fd, buf, 0, length, offset);
  if (!res) return null;
  if (res < length) return buf.subarray(0, res);
  return buf;
}

function readUInt64LE(buf, offset) {
  if (!buf || buf.length < offset + 8) return null;
  if (typeof buf.readBigUInt64LE === "function") {
    try {
      const value = buf.readBigUInt64LE(offset);
      const num = Number(value);
      if (!Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) return null;
      return num;
    } catch {
      return null;
    }
  }
  const low = buf.readUInt32LE(offset);
  const high = buf.readUInt32LE(offset + 4);
  const num = high * 0x100000000 + low;
  if (!Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) return null;
  return num;
}

function parsePckHeader(buffer) {
  if (!buffer || buffer.length < PACK_HEADER_SIZE) return null;
  if (!buffer.subarray(0, 4).equals(PACK_MAGIC)) return null;
  const packVersion = buffer.readUInt32LE(4);
  const engineMajor = buffer.readUInt32LE(8);
  const engineMinor = buffer.readUInt32LE(12);
  const enginePatch = buffer.readUInt32LE(16);
  if (!Number.isFinite(engineMajor) || !Number.isFinite(engineMinor) || !Number.isFinite(enginePatch)) {
    return null;
  }
  return { packVersion, engineMajor, engineMinor, enginePatch };
}

function readPckHeader(filePath, offset = 0) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = readBuffer(fd, offset, PACK_HEADER_SIZE);
    return parsePckHeader(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isPatchReliable(major, minor) {
  if (major === 3 && minor < 2) return false;
  return true;
}

function formatDetectedVersion(major, minor, patch) {
  if (!Number.isFinite(major) || major <= 0) return null;
  if (!Number.isFinite(minor) || minor < 0) return null;
  if (!Number.isFinite(patch) || patch < 0) return null;
  if (!isPatchReliable(major, minor)) return `${major}.${minor}.x`;
  return `${major}.${minor}.${patch}`;
}

function normalizeDetectedVersion(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d+)\.(\d+)(?:\.(\d+|x))?/i);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] ? match[3].toLowerCase() : null;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, patch };
}

function detectVersionFromHeader(filePath, offset) {
  const header = readPckHeader(filePath, offset);
  if (!header) return null;
  const detectedVersion = formatDetectedVersion(
    header.engineMajor,
    header.engineMinor,
    header.enginePatch
  );
  return {
    detectedVersion,
    detectedMajor: header.engineMajor,
    detectedMinor: header.engineMinor,
    detectedSource: "PCK header"
  };
}

function detectPackVersion(filePath, offset = 0) {
  if (!filePath) return null;
  return detectVersionFromHeader(filePath, offset);
}

function findMagicInRange(fd, start, size, maxScan = 64) {
  if (size <= 0) return null;
  const scan = Math.min(size, maxScan);
  const buf = readBuffer(fd, start, scan);
  if (!buf) return null;
  const idx = buf.indexOf(PACK_MAGIC);
  if (idx < 0) return null;
  return start + idx;
}

function findEmbeddedPckTrailer(fd, fileSize) {
  if (fileSize < 12) return null;
  const tailMagic = readBuffer(fd, fileSize - 4, 4);
  if (!tailMagic || !tailMagic.equals(PACK_MAGIC)) return null;
  const sizeBuf = readBuffer(fd, fileSize - 12, 8);
  const size = sizeBuf ? readUInt64LE(sizeBuf, 0) : null;
  if (!size || size <= 0) return null;

  const candidates = [fileSize - size - 12, fileSize - size - 8];
  for (const offset of candidates) {
    if (offset < 0 || offset + 4 > fileSize) continue;
    const magic = readBuffer(fd, offset, 4);
    if (magic && magic.equals(PACK_MAGIC)) {
      return { offset, size };
    }
  }
  return null;
}

function findEmbeddedPckPe(fd, fileSize) {
  const dos = readBuffer(fd, 0, 64);
  if (!dos || dos.length < 64) return null;
  if (dos.readUInt16LE(0) !== 0x5a4d) return null;
  const peOffset = dos.readUInt32LE(0x3c);
  if (!peOffset || peOffset + 6 > fileSize) return null;
  const sig = readBuffer(fd, peOffset, 4);
  if (!sig || sig.toString("ascii") !== "PE\u0000\u0000") return null;
  const fileHeader = readBuffer(fd, peOffset + 4, 20);
  if (!fileHeader || fileHeader.length < 20) return null;
  const sectionCount = fileHeader.readUInt16LE(2);
  const optionalSize = fileHeader.readUInt16LE(16);
  const sectionTable = peOffset + 24 + optionalSize;
  const entrySize = 40;
  if (!sectionCount || sectionTable + sectionCount * entrySize > fileSize) return null;

  for (let i = 0; i < sectionCount; i++) {
    const offset = sectionTable + i * entrySize;
    const section = readBuffer(fd, offset, entrySize);
    if (!section || section.length < entrySize) return null;
    const name = section
      .subarray(0, 8)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    if (name !== "pck") continue;
    const size = section.readUInt32LE(16);
    const ptr = section.readUInt32LE(20);
    if (!size || !ptr || ptr >= fileSize) continue;
    const rangeSize = Math.min(size, fileSize - ptr);
    const found = findMagicInRange(fd, ptr, rangeSize);
    if (found !== null) {
      return { offset: found, size: rangeSize - (found - ptr) };
    }
  }
  return null;
}

function readElfHeader(fd, fileSize) {
  const ident = readBuffer(fd, 0, 16);
  if (!ident || ident.length < 16) return null;
  if (ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46) {
    return null;
  }
  const klass = ident[4];
  const endian = ident[5];
  if (endian !== 1) return null;

  if (klass === 1) {
    const header = readBuffer(fd, 0, 52);
    if (!header || header.length < 52) return null;
    const shoff = header.readUInt32LE(0x20);
    const shentsize = header.readUInt16LE(0x2e);
    const shnum = header.readUInt16LE(0x30);
    const shstrndx = header.readUInt16LE(0x32);
    if (!shoff || !shentsize || !shnum) return null;
    if (shoff + shentsize * shnum > fileSize) return null;
    return { klass: 32, shoff, shentsize, shnum, shstrndx };
  }

  if (klass === 2) {
    const header = readBuffer(fd, 0, 64);
    if (!header || header.length < 64) return null;
    const shoff = readUInt64LE(header, 0x28);
    const shentsize = header.readUInt16LE(0x3a);
    const shnum = header.readUInt16LE(0x3c);
    const shstrndx = header.readUInt16LE(0x3e);
    if (!shoff || !shentsize || !shnum) return null;
    if (shoff + shentsize * shnum > fileSize) return null;
    return { klass: 64, shoff, shentsize, shnum, shstrndx };
  }

  return null;
}

function findEmbeddedPckElf(fd, fileSize) {
  const info = readElfHeader(fd, fileSize);
  if (!info) return null;
  const { klass, shoff, shentsize, shnum, shstrndx } = info;
  if (shstrndx >= shnum) return null;

  const strHeader = readBuffer(fd, shoff + shentsize * shstrndx, shentsize);
  if (!strHeader || strHeader.length < shentsize) return null;

  let strOffset = 0;
  let strSize = 0;
  if (klass === 32) {
    strOffset = strHeader.readUInt32LE(0x10);
    strSize = strHeader.readUInt32LE(0x14);
  } else {
    strOffset = readUInt64LE(strHeader, 0x18);
    strSize = readUInt64LE(strHeader, 0x20);
  }
  if (!strOffset || !strSize || strOffset + strSize > fileSize) return null;
  const strtab = readBuffer(fd, strOffset, strSize);
  if (!strtab) return null;

  for (let i = 0; i < shnum; i++) {
    const entryOffset = shoff + shentsize * i;
    const entry = readBuffer(fd, entryOffset, shentsize);
    if (!entry || entry.length < shentsize) return null;
    const nameOffset = entry.readUInt32LE(0);
    if (nameOffset >= strtab.length) continue;
    const name = strtab.subarray(nameOffset).toString("ascii").replace(/\0.*$/, "");
    if (name !== "pck") continue;

    let sectionOffset = 0;
    let sectionSize = 0;
    if (klass === 32) {
      sectionOffset = entry.readUInt32LE(0x10);
      sectionSize = entry.readUInt32LE(0x14);
    } else {
      sectionOffset = readUInt64LE(entry, 0x18);
      sectionSize = readUInt64LE(entry, 0x20);
    }
    if (!sectionOffset || !sectionSize || sectionOffset + sectionSize > fileSize) continue;
    const found = findMagicInRange(fd, sectionOffset, sectionSize);
    if (found !== null) {
      return { offset: found, size: sectionSize - (found - sectionOffset) };
    }
  }
  return null;
}

function findEmbeddedPck(filePath) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fileSize = stat.size;
    fd = fs.openSync(filePath, "r");

    const header = readBuffer(fd, 0, 4);
    if (header && header.equals(PACK_MAGIC)) {
      return { offset: 0, size: fileSize };
    }

    const trailer = findEmbeddedPckTrailer(fd, fileSize);
    if (trailer) return trailer;

    const pe = findEmbeddedPckPe(fd, fileSize);
    if (pe) return pe;

    const elf = findEmbeddedPckElf(fd, fileSize);
    if (elf) return elf;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

function parseConfigVersion(text) {
  const match = String(text || "").match(/^\s*config_version\s*=\s*(\d+)/m);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function mapConfigVersion(version) {
  switch (version) {
    case 5:
      return { major: 4, minor: 0 };
    case 4:
      return { major: 3, minor: 1 };
    case 3:
      return { major: 3, minor: 0 };
    case 2:
      return { major: 2, minor: 0 };
    case 1:
      return { major: 1, minor: 0 };
    default:
      return null;
  }
}

function detectProjectConfigVersion(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const configVersion = parseConfigVersion(raw);
    if (!configVersion) return null;
    const mapped = mapConfigVersion(configVersion);
    if (!mapped) return null;
    return {
      detectedMajor: mapped.major,
      detectedMinor: mapped.minor,
      detectedVersion: `${mapped.major}.${mapped.minor}.x`,
      detectedSource: "Project config"
    };
  } catch {
    return null;
  }
}

function findProjectMarker(rootDir) {
  const candidates = [
    "project.godot",
    "project.binary",
    "engine.cfg",
    "engine.cfb"
  ];
  for (const name of candidates) {
    const candidate = path.join(rootDir, name);
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

function listRootPcks(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith(".pck"))
    .map(name => path.join(rootDir, name));
}

function detectAppBundle(rootDir) {
  const resourcesDir = path.join(rootDir, "Contents", "Resources");
  if (!existsDir(resourcesDir)) return null;
  const bundleName = path.basename(rootDir, ".app");
  const preferred = bundleName ? path.join(resourcesDir, `${bundleName}.pck`) : null;
  const candidates = [];
  if (preferred && existsFile(preferred)) candidates.push(preferred);
  if (candidates.length === 0) {
    let entries = [];
    try {
      entries = fs.readdirSync(resourcesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".pck")) continue;
      candidates.push(path.join(resourcesDir, entry.name));
    }
  }

  for (const candidate of candidates) {
    const version = detectVersionFromHeader(candidate, 0);
    if (!version) continue;
    return {
      packPath: candidate,
      ...version
    };
  }

  return null;
}

function detectFileInput(inputPath, rootDir, stat) {
  const ext = path.extname(String(inputPath || "")).toLowerCase();
  if (ext === ".pck") {
    const version = detectVersionFromHeader(inputPath, 0);
    if (!version) return null;
    return {
      packagedType: "pck",
      packagedPath: inputPath,
      packPath: inputPath,
      packOffset: 0,
      packSize: stat?.size || null,
      ...version
    };
  }

  const isExe = ext === ".exe";
  const isExecutable = isExe || ((stat?.mode || 0) & 0o111) !== 0;
  if (isExecutable) {
    const embedded = findEmbeddedPck(inputPath);
    if (embedded) {
      const version = detectVersionFromHeader(inputPath, embedded.offset);
      if (!version) return null;
      return {
        packagedType: "exe-embedded",
        packagedPath: inputPath,
        packPath: inputPath,
        packOffset: embedded.offset,
        packSize: embedded.size,
        ...version
      };
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const sibling = path.join(rootDir, `${baseName}.pck`);
    if (existsFile(sibling)) {
      const version = detectVersionFromHeader(sibling, 0);
      if (version) {
        return {
          packagedType: "exe-sibling-pck",
          packagedPath: inputPath,
          packPath: sibling,
          packOffset: 0,
          packSize: safeStat(sibling)?.size || null,
          ...version
        };
      }
    }
  }

  return null;
}

function detectDirectory(rootDir) {
  const marker = findProjectMarker(rootDir);
  if (marker) {
    let version = null;
    const name = path.basename(marker).toLowerCase();
    if (name === "project.godot" || name === "engine.cfg") {
      version = detectProjectConfigVersion(marker);
    } else if (existsFile(path.join(rootDir, "project.godot"))) {
      version = detectProjectConfigVersion(path.join(rootDir, "project.godot"));
    } else if (existsFile(path.join(rootDir, "engine.cfg"))) {
      version = detectProjectConfigVersion(path.join(rootDir, "engine.cfg"));
    }
    return {
      packagedType: "project-dir",
      packagedPath: rootDir,
      projectRoot: rootDir,
      ...version
    };
  }

  const pcks = listRootPcks(rootDir);
  if (pcks.length === 1) {
    const candidate = pcks[0];
    const version = detectVersionFromHeader(candidate, 0);
    if (version) {
      const stat = safeStat(candidate);
      return {
        packagedType: "pck",
        packagedPath: candidate,
        packPath: candidate,
        packOffset: 0,
        packSize: stat?.size || null,
        ...version
      };
    }
  }

  return null;
}

function buildDetection({ name, gamePath, contentRootDir, versionInfo, moduleData }) {
  const info = versionInfo || {};
  const data = {
    ...moduleData,
    packagedType: moduleData.packagedType || null,
    packagedPath: moduleData.packagedPath || null,
    packPath: moduleData.packPath || null,
    packOffset: Number.isFinite(moduleData.packOffset) ? moduleData.packOffset : null,
    packSize: Number.isFinite(moduleData.packSize) ? moduleData.packSize : null,
    projectRoot: moduleData.projectRoot || null
  };
  if (info.detectedVersion) data.detectedVersion = info.detectedVersion;
  if (Number.isFinite(info.detectedMajor)) data.detectedMajor = info.detectedMajor;
  if (Number.isFinite(info.detectedMinor)) data.detectedMinor = info.detectedMinor;
  if (info.detectedSource) data.detectedSource = info.detectedSource;

  return {
    gameType: "engine",
    engine: "godot",
    gamePath,
    contentRootDir,
    name,
    indexDir: null,
    indexHtml: null,
    moduleData: data
  };
}

function detectGame(context) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  if (context?.isAppBundle) {
    const app = detectAppBundle(rootDir);
    if (!app) return null;
    const moduleData = {
      packagedType: "app-bundle",
      packagedPath: rootDir,
      packPath: app.packPath,
      packOffset: 0,
      packSize: safeStat(app.packPath)?.size || null
    };
    return buildDetection({
      name: path.basename(rootDir, ".app"),
      gamePath: rootDir,
      contentRootDir: rootDir,
      versionInfo: app,
      moduleData
    });
  }

  if (context?.stat?.isFile && context.stat.isFile()) {
    const inputPath = context?.inputPath;
    const fileInfo = detectFileInput(inputPath, rootDir, context.stat);
    if (fileInfo) {
      const moduleData = {
        packagedType: fileInfo.packagedType,
        packagedPath: fileInfo.packagedPath,
        packPath: fileInfo.packPath || null,
        packOffset: Number.isFinite(fileInfo.packOffset) ? fileInfo.packOffset : null,
        packSize: Number.isFinite(fileInfo.packSize) ? fileInfo.packSize : null
      };
      return buildDetection({
        name: path.basename(inputPath, path.extname(inputPath)),
        gamePath: inputPath,
        contentRootDir: rootDir,
        versionInfo: fileInfo,
        moduleData
      });
    }
  }

  const dirInfo = detectDirectory(rootDir);
  if (dirInfo) {
    const moduleData = {
      packagedType: dirInfo.packagedType,
      packagedPath: dirInfo.packagedPath,
      packPath: dirInfo.packPath || null,
      packOffset: Number.isFinite(dirInfo.packOffset) ? dirInfo.packOffset : null,
      packSize: Number.isFinite(dirInfo.packSize) ? dirInfo.packSize : null,
      projectRoot: dirInfo.projectRoot || null
    };
    return buildDetection({
      name: path.basename(rootDir),
      gamePath: rootDir,
      contentRootDir: rootDir,
      versionInfo: dirInfo,
      moduleData
    });
  }

  return null;
}

module.exports = {
  detectGame,
  detectPackVersion,
  detectProjectConfigVersion,
  __test: {
    parsePckHeader,
    readPckHeader,
    readUInt64LE,
    findEmbeddedPck,
    formatDetectedVersion,
    normalizeDetectedVersion,
    detectProjectConfigVersion
  }
};
