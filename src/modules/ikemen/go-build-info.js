const fs = require("node:fs");

const MAGIC = Buffer.from("\xff Go buildinf:", "latin1");
const MAX_DATA_BYTES = 64 * 1024;

function parseInlineBuildInfo(data) {
  const start = data.indexOf(MAGIC);
  if (start < 0 || start % 16 || start + 32 > data.length || ![4, 8].includes(data[start + 14]) || !(data[start + 15] & 2)) return null;
  let offset = start + 32;
  function field(limit) {
    let size = 0, shift = 0, byte;
    do {
      if (offset >= data.length || shift > 28) throw new Error("Invalid Go build metadata length.");
      byte = data[offset++]; size += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    if (size > limit || size > data.length - offset) throw new Error("Go build metadata exceeds inspection bounds.");
    const value = data.subarray(offset, offset + size); offset += size; return value;
  }
  const toolchain = field(200).toString("utf8");
  if (!/^go\d+\.\d+(?:\.\d+)?(?:\s|$)/.test(toolchain)) return null;
  let moduleData = field(32 * 1024);
  if (moduleData.length >= 33 && moduleData[16] === 10) moduleData = moduleData.subarray(16, -16);
  const moduleText = moduleData.toString("utf8");
  const fields = moduleText.split("\n").map(line => line.split("\t"));
  const module = fields.find(line => line[0] === "mod");
  if (!module || module[1] !== "github.com/ikemen-engine/Ikemen-GO") return null;
  const settings = new Map(fields.filter(line => line[0] === "build").map(line => {
    const at = line[1]?.indexOf("="); return at > 0 ? [line[1].slice(0, at), line[1].slice(at + 1)] : [];
  }).filter(pair => pair.length));
  const revision = settings.get("vcs.revision");
  return { engine: "ikemen", version: /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(module[2] || "") ? module[2].slice(1) : null,
    revision: /^[a-f0-9]{40}$/.test(revision || "") ? revision : null,
    modified: settings.get("vcs.modified") === "true" ? true : settings.get("vcs.modified") === "false" ? false : null,
    timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(settings.get("vcs.time") || "") ? settings.get("vcs.time") : null,
    platform: settings.get("GOOS") || null, architecture: settings.get("GOARCH") || null, toolchain,
    source: "embedded Go build metadata", confidence: "embedded", inspectedBytes: data.length };
}

// Go puts Windows build info at the beginning of a PE data section. Only inspect
// those bounded section prefixes after the game layout has identified Ikemen.
// Older pointer-based Go headers and absent metadata remain unknown.
function readGoBuildInfo(filePath, { detection } = {}) {
  let fd;
  try {
    if (!detection) fd = fs.openSync(filePath, "r");
    const size = (detection ? detection.stat(filePath) : fs.fstatSync(fd))?.size;
    if (!Number.isSafeInteger(size)) return null;
    function read(offset, length) {
      if (offset < 0 || length < 0 || length > size - offset) throw new Error("Truncated PE build metadata.");
      if (detection) {
        const result = detection.readBytes(filePath, offset, length);
        if (!result || result.length !== length) throw new Error("Truncated PE build metadata.");
        return result;
      }
      const result = Buffer.alloc(length);
      if (fs.readSync(fd, result, 0, length, offset) !== length) throw new Error("Truncated PE build metadata.");
      return result;
    }
    const dos = read(0, 64); if (dos.toString("ascii", 0, 2) !== "MZ") return null;
    const peOffset = dos.readUInt32LE(0x3c); if (peOffset > 1024 * 1024) return null;
    const pe = read(peOffset, 24); if (pe.readUInt32LE(0) !== 0x4550) return null;
    const count = pe.readUInt16LE(6), optionalBytes = pe.readUInt16LE(20);
    if (!count || count > 96 || optionalBytes > 4096) return null;
    const sections = read(peOffset + 24 + optionalBytes, count * 40); let inspected = 0;
    for (let i = 0; i < count; i++) {
      const section = sections.subarray(i * 40, (i + 1) * 40);
      const name = section.toString("ascii", 0, 8).replace(/\0.*/, "");
      if (![".data", ".go.buil"].includes(name)) continue;
      const length = Math.min(section.readUInt32LE(16), MAX_DATA_BYTES - inspected), offset = section.readUInt32LE(20);
      if (!length) continue;
      const data = read(offset, length); inspected += length;
      const result = parseInlineBuildInfo(data);
      if (result) return { ...result, filePath, inspectedBytes: inspected };
      if (inspected >= MAX_DATA_BYTES) break;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { readGoBuildInfo, parseInlineBuildInfo, MAX_DATA_BYTES };
