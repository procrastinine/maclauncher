const BinaryArch = require('../../core/binary-arch');
const fs = require("node:fs");
const Native = require("../shared/runtime/local-native");

const BASE_SYMBOLS = ["csmGetVersion", "csmGetLatestMocVersion", "csmGetMocVersion", "csmGetLogFunction", "csmSetLogFunction", "csmReviveMocInPlace", "csmGetSizeofModel", "csmInitializeModelInPlace", "csmUpdateModel", "csmReadCanvasInfo", "csmGetParameterCount", "csmGetParameterIds", "csmGetParameterMinimumValues", "csmGetParameterMaximumValues", "csmGetParameterDefaultValues", "csmGetParameterValues", "csmGetPartCount", "csmGetPartIds", "csmGetPartOpacities", "csmGetPartParentPartIndices", "csmGetDrawableCount", "csmGetDrawableIds", "csmGetDrawableConstantFlags", "csmGetDrawableDynamicFlags", "csmGetDrawableTextureIndices", "csmGetDrawableDrawOrders", "csmGetDrawableOpacities", "csmGetDrawableMaskCounts", "csmGetDrawableMasks", "csmGetDrawableVertexCounts", "csmGetDrawableVertexPositions", "csmGetDrawableVertexUvs", "csmGetDrawableIndexCounts", "csmGetDrawableIndices", "csmGetDrawableMultiplyColors", "csmGetDrawableScreenColors", "csmResetDrawableDynamicFlags"];
const SOURCE = "https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/gl2/live2dcsm.pxi";
// Ren'Py 8.5.3 and later read the Cubism 5.3 Core API; earlier releases read
// the 4.2–5.2 API. `newerCompatible` says on which side of the recommended SDK
// another release of the same API lies.
function requirements(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match || Number(match[1]) < 7) throw new Error("An explicit Ren'Py SDK version of 7 or later is required for Live2D.");
  const [major, minor, patch] = match.slice(1).map(Number);
  const modern = major > 8 || major === 8 && (minor > 5 || minor === 5 && patch >= 3);
  return { renpyVersion: version, major, apiProfile: modern ? "Cubism 5.3" : "Cubism 4.2–5.2", recommendedVersion: modern ? "5-r.5" : "5-r.4.1",
    newerCompatible: modern, source: SOURCE, symbols: [...BASE_SYMBOLS, modern ? "csmGetRenderOrders" : "csmGetDrawableRenderOrders"] };
}

function exportsByArchitecture(file) {
  Native.readMachOArchitectures(file, { allowLibrary: true });
  const size = fs.statSync(file).size;
  if (size > 16 * 1024 * 1024) throw new Error("Live2D Core library exceeds supported inspection bounds.");
  const bytes = fs.readFileSync(file), format = BinaryArch.machoMagic(bytes.readUInt32BE(0)), slices = [];
  if (format?.fat) {
    const container = BinaryArch.machoFatHeader(bytes);
    for (let i = 0; i < container.count; i++) { const entry = BinaryArch.machoFatEntry(bytes.subarray(8), i, container); slices.push({offset:entry.offset,size:entry.size}); }
  } else slices.push({ offset: 0, size: bytes.length });
  const result = {};
  for (const slice of slices) {
    const part = bytes.subarray(slice.offset, slice.offset + slice.size), facts = BinaryArch.machoHeader(part), little = facts.little;
    const u32 = p => little ? part.readUInt32LE(p) : part.readUInt32BE(p);
    if (facts.fileType !== 6) throw new Error("Live2D Core must be a native macOS dynamic library.");
    const arch = facts.architecture === "arm64" ? "arm64" : "x86_64", commands = facts.commandCount, commandEnd = 32 + facts.commandBytes;
    let cursor = 32, symtab;
    for (let i = 0; i < commands; i++) {
      if (cursor + 8 > commandEnd) throw new Error("Truncated Live2D Mach-O commands.");
      const command = u32(cursor), length = u32(cursor + 4);
      if (length < 8 || cursor + length > commandEnd) throw new Error("Invalid Live2D Mach-O command.");
      if (command === 2) { if (length < 24) throw new Error("Truncated Live2D symbol table command."); symtab = { symbols: u32(cursor + 8), count: u32(cursor + 12), strings: u32(cursor + 16), length: u32(cursor + 20) }; }
      cursor += length;
    }
    if (!symtab || symtab.count > 100000 || symtab.symbols + symtab.count * 16 > part.length || symtab.strings + symtab.length > part.length) throw new Error("Live2D library has no bounded exported symbol table.");
    const found = new Set();
    for (let i = 0; i < symtab.count; i++) {
      const p = symtab.symbols + i * 16, index = u32(p), type = part[p + 4];
      if (!(type & 1) || type & 0xe0 || (type & 0x0e) === 0 || index >= symtab.length) continue;
      const begin = symtab.strings + index, end = part.indexOf(0, begin);
      if (end < begin || end >= symtab.strings + symtab.length) throw new Error("Invalid Live2D symbol name.");
      const name = part.toString("utf8", begin, end).replace(/^_/, "");
      if (name.startsWith("csm")) found.add(name);
    }
    result[arch] = found;
  }
  return result;
}

function validateCore(file, version, architectures) {
  const policy = requirements(version), available = exportsByArchitecture(file);
  for (const arch of architectures) {
    const symbols = available[arch];
    if (!symbols) throw Object.assign(new Error(`Live2D Core is missing the runtime's ${arch} architecture.`), { code: "LIVE2D_ARCH_INCOMPATIBLE" });
    const missing = policy.symbols.filter(symbol => !symbols.has(symbol));
    if (missing.length) throw Object.assign(new Error(`Ren'Py ${version} requires ${policy.apiProfile} (${policy.recommendedVersion}); this Core library lacks ${missing.join(", ")}.`), { code: "LIVE2D_API_INCOMPATIBLE" });
  }
  return { ...policy, architectures: Object.keys(available), sha256: Native.hashFile(file) };
}

module.exports = { requirements, exportsByArchitecture, validateCore, BASE_SYMBOLS };
