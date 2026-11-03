const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const SOURCE_SHA256 = "c9bc0b0cd42e0fbcb82a09635bb5abed86afbdd4abc9e76fa5716638217cb59f";
const { addLicense } = require("../../../../scripts/license-files.mjs");
const VERSION = "cp932-2.01-eudc-ml1";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

/** Transform exact published source data without a host codec. */
function stage({ sourceFile, licenseFile, destination } = {}) {
  if ([sourceFile, destination].some(file => !path.isAbsolute(file || "")) || fs.existsSync(destination))
    throw new Error("Exact absolute CP932 source and a new destination are required.");
  const read = (file, expected, maximum) => {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > maximum) throw new Error("Invalid CP932 data source.");
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== expected) throw new Error("The pinned CP932 data source changed.");
    return bytes;
  };
  const source = read(sourceFile, SOURCE_SHA256, 512 * 1024);
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
    license: "Unicode-3.0",
    privateUse: "F0-F9 valid trail bytes map to U+E000-U+E757 using Windows EUDC",
    privateUseReference: "https://encoding.spec.whatwg.org/#shift_jis-decoder",
    undefinedSingleBytes: ["80", "a0", "fd", "fe", "ff"] };
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "cp932.bin"), table, { flag: "wx", mode: 0o644 });
  addLicense(destination, "Unicode CP932", licenseFile, "Unicode-3.0");
  fs.writeFileSync(path.join(destination, "cp932.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return manifest;
}
/** Shared preparation for checkout setup, local packaging and the app workflow. */
async function prepare({ repoRoot = path.resolve(__dirname, "../../../.."),
  download = require("../../../../scripts/native-payload.cjs").downloadPayload } = {}) {
  const directory = path.join(repoRoot, "src/modules/catsystem2/resources/encoding");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "cp932.json"), "utf8"));
  const output = path.join(directory, "cp932.bin"), existing = fs.lstatSync(output, { throwIfNoEntry: false });
  if (existing?.isFile() && existing.size === manifest.tableBytes && sha256(fs.readFileSync(output)) === manifest.tableSha256)
    return { version: VERSION, generated: false };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-cp932-"));
  const replacement = path.join(directory, ".cp932-" + crypto.randomUUID() + ".tmp");
  try {
    const sourceFile = path.join(temporary, "CP932.TXT"), destination = path.join(temporary, "generated");
    await download(manifest.sourceUrl, sourceFile);
    stage({ sourceFile, licenseFile: path.join(directory, "Unicode-LICENSE.txt"), destination });
    fs.copyFileSync(path.join(destination, "cp932.bin"), replacement, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(replacement, 0o644); fs.renameSync(replacement, output);
    return { version: VERSION, generated: true };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(replacement, { force: true }); }
}
module.exports = { SOURCE_SHA256, VERSION, stage, prepare };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (!args.length) return prepare();
  if (args.length !== 3) throw new Error("Use no arguments for setup, or three input and output paths.");
  const [sourceFile, licenseFile, destination] = args;
  return stage({ sourceFile, licenseFile, destination });
})().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
