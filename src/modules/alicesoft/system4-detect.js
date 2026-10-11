const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Eight header bytes from libsys4's legacy MT19937 seed 0x5D3E3. This
// identifies the format without decrypting or rewriting the game's program.
const AIN_HEADER_XOR = Buffer.from("28b050e9d6cf935b", "hex");
const MAX_HEADER_INPUT = 64 * 1024;
const MAX_AIN_INPUT = 8 * 1024 * 1024;
const MAX_AIN_OUTPUT = 16 * 1024 * 1024;

function readAinHeader(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 16) return null;
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_AIN_INPUT));
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    let header;
    let format;
    if (bytes.subarray(0, 8).equals(Buffer.from("4149320000000000", "hex"))) {
      const outputSize = bytes.readUInt32LE(8);
      const compressedSize = bytes.readUInt32LE(12);
      if (outputSize < 8 || outputSize > 512 * 1024 * 1024 || compressedSize < 2 || compressedSize > stat.size - 16) return null;
      // Only inspect a bounded prefix. Large valid programs whose prefix cannot
      // be inflated under this limit retain a structural, non-exact version.
      format = "AIN (AI2/zlib)";
      try { header = zlib.inflateSync(bytes.subarray(16, 16 + compressedSize), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_AIN_OUTPUT }); }
      catch (error) {
        if (error.code !== "ERR_BUFFER_TOO_LARGE") return null;
        return { scenarioFormat: format, ainVersion: null, versionSource: "bounded AI2 container header; AIN version unavailable" };
      }
    } else {
      header = Buffer.from(bytes.subarray(0, 8));
      for (let i = 0; i < 8; i++) header[i] ^= AIN_HEADER_XOR[i];
      format = "AIN (legacy encrypted)";
    }
    if (header.length < 8 || header.toString("ascii", 0, 4) !== "VERS") return null;
    const version = header.readUInt32LE(4);
    if (version > 100) return null;
    return { scenarioFormat: format, ainVersion: version, versionSource: `${format} VERS ${version}; engine build is not encoded here` };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inspectSystem4(rootDir, files) {
  const iniName = files.find(name => /^System40\.ini$/i.test(name));
  if (!iniName) return null;
  try {
    const iniPath = path.join(rootDir, iniName);
    const bytes = fs.readFileSync(iniPath);
    if (bytes.length > MAX_HEADER_INPUT) return null;
    const text = new TextDecoder("shift-jis").decode(bytes);
    const match = text.match(/^\s*CodeName\s*=\s*(?:"([^"\r\n]+)"|([^;\r\n]+))/mi);
    if (!match) return null;
    const relative = (match[1] || match[2]).trim().replace(/\\/g, "/");
    if (!/\.ain$/i.test(relative) || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split("/").some(part => part === ".." || !part)) return null;
    const target = path.resolve(rootDir, relative);
    const sourceRoot = fs.realpathSync(rootDir);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(sourceRoot + path.sep)) return null;
    const header = readAinHeader(realTarget);
    if (!header) return null;
    return { generation: "system4", scenarioPath: target, configPath: iniPath, ...header,
      detectedVersion: "System 4 (engine build unknown)", detectedVersionConfidence: "high",
      detectedVersionSource: `${iniName} CodeName + ${header.versionSource}`,
      recommendedRuntime: "xsystem4", compatibility: "Experimental xsystem4; only titles implemented by the selected runtime are supported. AIN format version does not guarantee title compatibility." };
  } catch { return null; }
}

module.exports = { inspectSystem4, readAinHeader };
