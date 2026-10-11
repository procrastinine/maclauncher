const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const SOURCE_SHA256 = "c9bc0b0cd42e0fbcb82a09635bb5abed86afbdd4abc9e76fa5716638217cb59f";
const LICENSE_SHA256 = "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96";
const VERSION = "cp932-2.01-eudc-ml1";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

/** Developer-only transform of exact published data. No network or host codec. */
function stage({ sourceFile, licenseFile, destination } = {}) {
  if ([sourceFile, licenseFile, destination].some(file => !path.isAbsolute(file || "")) || fs.existsSync(destination))
    throw new Error("Exact absolute CP932 source/license inputs and a new destination are required.");
  const read = (file, expected, maximum) => {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > maximum) throw new Error("Invalid CP932 data source.");
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== expected) throw new Error("The pinned CP932 data source changed.");
    return bytes;
  };
  const source = read(sourceFile, SOURCE_SHA256, 512 * 1024), license = read(licenseFile, LICENSE_SHA256, 16 * 1024);
  const table = Buffer.alloc(60 * 188 * 2); let entries = 0;
  for (const line of source.toString("ascii").split(/\r?\n/)) {
    const match = /^0x([0-9A-F]+)\s+0x([0-9A-F]+)/i.exec(line);
    if (!match) continue;
    const encoded = parseInt(match[1], 16), unicode = parseInt(match[2], 16);
    if (encoded <= 255) continue;
    const lead = encoded >>> 8, trail = encoded & 255;
    const row = lead - (lead < 0xa0 ? 0x81 : 0xc1), column = trail - (trail < 0x7f ? 0x40 : 0x41);
    if (row < 0 || row >= 60 || column < 0 || column >= 188 || !unicode || unicode > 0xffff)
      throw new Error("Unsupported published CP932 mapping.");
    const offset = (row * 188 + column) * 2;
    if (table.readUInt16LE(offset)) throw new Error("Duplicate published CP932 mapping.");
    table.writeUInt16LE(unicode, offset); entries++;
  }
  const manifest = { schemaVersion: 1, version: VERSION, sourceVersion: "Microsoft CP932 table 2.01, 1998-04-15",
    sourceUrl: "https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP932.TXT", sourceSha256: SOURCE_SHA256,
    table: "cp932.bin", tableBytes: table.length, tableSha256: sha256(table), doubleByteMappings: entries,
    license: "Unicode-3.0", licenseFile: "Unicode-LICENSE.txt", licenseSha256: LICENSE_SHA256,
    privateUse: "F0-F9 valid trail bytes map to U+E000-U+E757 using Windows EUDC",
    privateUseReference: "https://encoding.spec.whatwg.org/#shift_jis-decoder",
    undefinedSingleBytes: ["80", "a0", "fd", "fe", "ff"] };
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "cp932.bin"), table, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(path.join(destination, "Unicode-LICENSE.txt"), license, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(path.join(destination, "cp932.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return manifest;
}
module.exports = { SOURCE_SHA256, LICENSE_SHA256, VERSION, stage };
if (require.main === module) {
  const [sourceFile, licenseFile, destination] = process.argv.slice(2);
  console.log(JSON.stringify(stage({ sourceFile, licenseFile, destination })));
}
