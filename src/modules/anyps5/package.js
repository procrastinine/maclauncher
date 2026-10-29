const fs = require("node:fs");
const path = require("node:path");

// FIH/CNT and PFS header fields match pkg-to-anyps5's fih.rs and pfs.rs:
// https://github.com/awake-devel/pkg-to-anyps5 at
// 2e9b12267840f9777f8d825335c4b4938160d9c4. Inspection reads no encrypted files.
function inspect(file, detection, readBytes) {
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0x100) return null;
    const header = readBytes(file, 0, 0x100, detection);
    if (header.length !== 0x100 || header.toString("hex", 0, 4) !== "7f464948") return null;
    const size = BigInt(stat.size), pfsOffset = header.readBigUInt64LE(0x10), pfsSize = header.readBigUInt64LE(0x18),
      superblockOffset = header.readBigUInt64LE(0x20), metadataOffset = header.readBigUInt64LE(0x58);
    if (pfsOffset < 0x100n || !pfsSize || pfsOffset > size || pfsSize > size - pfsOffset) return null;
    const result = { format: "pkg", sourceKind: "PS5 PKG", bytes: stat.size, inspectionOnly: true,
      packagePath: file, packageVersion: header.readUInt16LE(6), signedFlag: header[5],
      packageSigning: header[5] === 0x80 ? "Retail" : header[5] === 0 ? "Debug / fake-signed" : "Signed (" + header[5] + ")",
      pfsOffset: Number(pfsOffset), pfsSize: Number(pfsSize), metadataOffset: metadataOffset.toString(), metadataAvailable: false };
    const at = superblockOffset >= pfsOffset && superblockOffset + 0x400n <= pfsOffset + pfsSize ? superblockOffset : pfsOffset;
    if (at + 0x400n <= size) {
      const pfs = readBytes(file, Number(at), 0x400, detection);
      if (pfs.length === 0x400 && [1n, 2n].includes(pfs.readBigUInt64LE(0)) && pfs.readBigUInt64LE(8) === 20130315n) {
        result.pfsSuperblockOffset = Number(at);result.pfsVersion = Number(pfs.readBigUInt64LE(0));
        result.pfsMode = pfs.readUInt16LE(0x1c);result.pfsBlockSize = pfs.readUInt32LE(0x20);
        result.encrypted = Boolean(result.pfsMode & 4) && !pfs.subarray(0x370, 0x380).equals(Buffer.from("PPRPLAIN-NOAUTH!"));
      }
    }
    if (metadataOffset >= 0x100n && metadataOffset + 0x80n <= size) {
      const cnt = readBytes(file, Number(metadataOffset), 0x80, detection);
      if (cnt.length === 0x80 && cnt.toString("hex", 0, 4) === "7f434e54") {
        const count = cnt.readUInt32BE(16), tableOffset = cnt.readUInt32BE(24), bodyOffset = cnt.readBigUInt64BE(0x20), bodySize = cnt.readBigUInt64BE(0x28);
        if (count > 0 && count <= 4096 && tableOffset >= 0x80 && BigInt(tableOffset + count * 32) <= size - metadataOffset &&
            bodyOffset <= size - metadataOffset && bodySize <= size - metadataOffset - bodyOffset) {
          result.metadataAvailable = true;result.metadataEntryCount = count;
          const contentId = cnt.subarray(0x40, 0x64).toString("utf8").split("\0", 1)[0];
          if (/^[A-Z0-9_-]{1,36}$/.test(contentId)) {
            result.contentId = contentId;result.titleId = /PPSA\d{5}/.exec(contentId)?.[0] || null;
            if (result.titleId) result.titleIdSource = "CNT content ID";
          }
        }
      }
    }
    if (!result.titleId) {
      result.titleId = /PPSA\d{5}/i.exec(path.basename(file))?.[0]?.toUpperCase() || null;
      if (result.titleId) result.titleIdSource = "Filename";
    }
    result.inspectionReason = result.encrypted === true
      ? "Encrypted PS5 package. Play and decompilation require a decrypted game folder or executable."
      : "PS5 package extraction is required before Play or decompilation.";
    if (!result.metadataAvailable) result.metadataNote = "No CNT metadata container is present at the declared offset.";
    return result;
  } catch { return null; }
}
module.exports = { inspect };
