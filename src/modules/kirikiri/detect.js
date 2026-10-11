const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { inspectArchive, readScript } = require("./xp3");
const { decode, declaredVersion, requiredNativeFeatures } = require("./script");

const XP3_MAGIC = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

function readExactly(fd, size, offset) {
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Truncated XP3 index.");
  return data;
}

function safeNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("XP3 index exceeds supported bounds.");
  return number;
}

// Inspect only archive metadata. No game scripts, native plugins or archive files execute.
function readPlainXp3Index(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 28) return null;
    fd = fs.openSync(filePath, "r");
    const header = readExactly(fd, 19, 0);
    if (!header.subarray(0, 11).equals(XP3_MAGIC)) return null;
    const offset = safeNumber(header.readBigUInt64LE(11));
    if (offset < 19 || offset > stat.size - 9) return null;
    const block = readExactly(fd, 9, offset);
    const flags = block[0];
    // Chained indexes and unfamiliar compression remain unsupported rather than guessed.
    if (flags !== 0 && flags !== 1) return null;
    const storedSize = safeNumber(block.readBigUInt64LE(1));
    const prefixSize = flags === 1 ? 17 : 9;
    if (storedSize > MAX_INDEX_BYTES || storedSize > stat.size - offset - prefixSize) return null;
    let data = readExactly(fd, storedSize, offset + prefixSize);
    if (flags === 1) {
      const unpackedSize = safeNumber(readExactly(fd, 8, offset + 9).readBigUInt64LE(0));
      if (unpackedSize > MAX_INDEX_BYTES) return null;
      data = zlib.inflateSync(data, { maxOutputLength: MAX_INDEX_BYTES });
      if (data.length !== unpackedSize) return null;
    }
    const files = [];
    let protectedEntries = 0;
    function chunks(buffer, visit) {
      for (let cursor = 0; cursor < buffer.length;) {
        if (buffer.length - cursor < 12) throw new Error("Truncated XP3 chunk.");
        const length = safeNumber(buffer.readBigUInt64LE(cursor + 4));
        if (length > buffer.length - cursor - 12) throw new Error("Invalid XP3 chunk size.");
        visit(buffer.subarray(cursor, cursor + 4).toString("ascii"), buffer.subarray(cursor + 12, cursor + 12 + length));
        cursor += 12 + length;
      }
    }
    chunks(data, (type, payload) => {
      if (type !== "File") return;
      chunks(payload, (kind, info) => {
        if (kind !== "info") return;
        if (info.length < 22) throw new Error("Truncated XP3 file info.");
        const length = info.readUInt16LE(20);
        if (info.length !== 22 + length * 2) throw new Error("Invalid XP3 filename length.");
        const protectedEntry = Boolean(info.readUInt32LE(0) & 0x80000000);
        files.push(info.subarray(22).toString("utf16le"));
        if (protectedEntry) protectedEntries += 1;
      });
    });
    return { files, protectedEntries };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readXp3Index(filePath) {
  const plain = readPlainXp3Index(filePath);
  if (plain) return plain;
  try { const archive = inspectArchive(filePath); return { files: [...archive.members.values()].map(member => member.name), protectedEntries: archive.protectedEntries, archiveBase: archive.base }; } catch { return null; }
}

function inspectRoot(rootDir, selectedArchive, selectedIndex) {
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return null; }
  const startup = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "startup.tjs");
  if (!selectedArchive && startup) return { launchTarget: rootDir, sourceKind: "project", protectedEntries: 0 };
  const archives = selectedArchive ? [selectedArchive] : entries.filter(entry => entry.isFile() && /\.(xp3|exe)$/i.test(entry.name))
    .sort((a, b) => Number(b.name.toLowerCase() === "data.xp3") - Number(a.name.toLowerCase() === "data.xp3"))
    .map(entry => path.join(rootDir, entry.name));
  for (const archive of archives) {
    const index = archive === selectedArchive && selectedIndex || readXp3Index(archive);
    if (!index?.files.some(name => name.toLowerCase() === "startup.tjs")) continue;
    return { launchTarget: archive, sourceKind: "xp3", archivePath: archive, protectedEntries: index.protectedEntries };
  }
  return null;
}

function detectScriptVersion(rootDir, sourceKind, archivePath) {
  const unknown = {
    detectedVersion: "unknown", detectedVersionConfidence: "unknown",
    detectedVersionSource: sourceKind === "xp3" ? "XP3 metadata; no readable explicit script version declaration" : "startup.tjs; no explicit version declaration",
    engineGeneration: "KiriKiri/TJS (generation unknown)", kagVersion: null, tjsVersion: null, xp3ContentProfile: null, requiredNativeFeatures: []
  };
  let archive;
  if (sourceKind === "xp3") {
    try { archive = inspectArchive(archivePath); } catch { return unknown; }
  }
  for (const relative of ["system/Initialize.tjs", "Initialize.tjs", "startup.tjs"]) {
    try {
      let data;
      if (archive) {
        const member = archive.members.get(relative.toLowerCase());
        if (!member || member.size > 512 * 1024) continue;
        data = readScript(archive, member, { allowPlainProtected: true });
      } else {
        const file = path.join(rootDir, relative);
        if (!fs.statSync(file).isFile() || fs.statSync(file).size > 512 * 1024) continue;
        data = fs.readFileSync(file);
      }
      const { kag, tjs } = declaredVersion(data) || {};
      if (kag || tjs) return {
        ...unknown, detectedVersion: kag ? `KAG ${kag}` : `TJS ${tjs}`,
        detectedVersionConfidence: "declared", detectedVersionSource: `${archive ? `${path.basename(archive.file)}!/` : ""}${relative} explicit script version constant`,
        engineGeneration: kag ? `KAG ${kag[0]} on KiriKiri/TJS (host generation unknown)` : `TJS ${tjs} (KiriKiri host generation unknown)`,
        kagVersion: kag || null, tjsVersion: tjs || null,
        requiredNativeFeatures: requiredNativeFeatures(decode(data)),
        xp3ContentProfile: archive?.members.get(relative.toLowerCase())?.protectedEntry ? "verified-plain-v1" : null
      };
    } catch {}
  }
  return unknown;
}

function inspectKagSaveRouting(rootDir, sourceKind) {
  const unknown = { kagSaveRouting: "unknown (game scripts may override the runtime data path)", unsafeRuntimeSavePath: false };
  if (sourceKind !== "project") return unknown;
  let framework = "";
  for (const relative of ["system/MainWindow.tjs", "MainWindow.tjs"]) {
    try {
      const file = path.join(rootDir, relative);
      if (fs.statSync(file).size > 512 * 1024) continue;
      const bytes = fs.readFileSync(file);
      framework += bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
    } catch {}
  }
  if (!/saveDataLocation\s*=\s*System\.exePath\s*\+\s*saveDataLocation/.test(framework)) return unknown;
  for (const relative of ["Config.tjs", "system/Config.tjs"]) {
    try {
      const file = path.join(rootDir, relative);
      if (fs.statSync(file).size > 512 * 1024) continue;
      const bytes = fs.readFileSync(file);
      const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const settings = [...code.matchAll(/\bsaveDataLocation\s*=\s*([^;\r\n]+)/g)];
      if (!settings.length) continue;
      const expression = settings.at(-1)[1].trim();
      if (expression === "System.dataPath") return { kagSaveRouting: `${relative}: System.dataPath (declared)`, unsafeRuntimeSavePath: false };
      const literal = expression.match(/^["']([^"']+)["']$/)?.[1];
      if (literal && !literal.includes(":")) return { kagSaveRouting: `${relative}: relative saveDataLocation resolves beside the runtime executable`, unsafeRuntimeSavePath: true };
      return unknown;
    } catch {}
  }
  return unknown;
}

function detectGame(context) {
  if (!context?.rootDir) return null;
  const isFile = context.stat?.isFile?.() === true;
  const inputPath = context.inputPath;
  const extension = path.extname(inputPath || "").toLowerCase();
  if (isFile && extension !== ".exe" && extension !== ".xp3" && path.basename(inputPath).toLowerCase() !== "startup.tjs") return null;
  const roots = context.isAppBundle
    ? ["Contents/Resources/game", "Contents/Resources/data", "Contents/Resources"].map(relative => path.join(context.rootDir, relative))
    : [context.rootDir];
  for (const rootDir of roots) {
    const selectedIndex = isFile && [".xp3", ".exe"].includes(extension) ? readXp3Index(inputPath) : null;
    // Some Windows hosts embed an XP3 containing only a plugin or identifier,
    // while their actual startup lives in sibling data.xp3. Such an EXE is not
    // a definitive archive input. Explicit .xp3 imports remain strict so an
    // asset-only or malformed archive cannot borrow another game's startup.
    if (isFile && extension === ".xp3" && !selectedIndex) return null;
    const selectedArchive = selectedIndex && (extension === ".xp3" ||
      selectedIndex.files.some(name => name.toLowerCase() === "startup.tjs")) ? inputPath : null;
    const info = inspectRoot(rootDir, selectedArchive, selectedIndex);
    if (!info) continue;
    const version = detectScriptVersion(rootDir, info.sourceKind, info.archivePath);
    return {
      engine: "kirikiri", gameType: "scripted", gamePath: inputPath || context.rootDir,
      contentRootDir: rootDir,
      name: path.basename(context.isAppBundle ? context.rootDir : isFile && extension !== ".exe" ? rootDir : inputPath || rootDir, context.isAppBundle ? ".app" : extension === ".exe" ? path.extname(inputPath) : ""),
      moduleData: { ...info, ...version, ...inspectKagSaveRouting(rootDir, info.sourceKind), compatibility: info.protectedEntries && version.xp3ContentProfile !== "verified-plain-v1" ? "Unsupported XP3 content filter." : "Windows plugins and native menus are unsupported." }
    };
  }
  return null;
}

module.exports = { detectGame, readXp3Index, XP3_MAGIC };
