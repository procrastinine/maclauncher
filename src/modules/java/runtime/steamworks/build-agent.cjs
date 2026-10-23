// Development only: pass the bin directory of a Java 9+ JDK. End users run the
// sealed Included JAR and need only the launcher's managed Java runtime.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function jar(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries.sort((a, b) => a[0].localeCompare(b[0], "en"))) {
    const encoded = Buffer.from(name), checksum = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(encoded.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x21, 14); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(encoded.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, encoded, bytes); central.push(record, encoded); offset += header.length + encoded.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function build(jdkBin, output) {
  if (!path.isAbsolute(jdkBin || "") || !path.isAbsolute(output || "")) throw new Error("Pass absolute JDK bin and output JAR paths.");
  const source = path.join(__dirname, "MacLauncherSteamAgent.java"), classes = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-agent-"));
  try {
    execFileSync(path.join(jdkBin, "javac"), ["--release", "8", "-g:none", "-encoding", "UTF-8", "-d", classes, source], { timeout: 30000, stdio: "pipe" });
    const entries = [["META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\r\nPremain-Class: io.maclauncher.steam.MacLauncherSteamAgent\r\n\r\n")]];
    function walk(directory) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) walk(file);
        else if (item.isFile() && item.name.endsWith(".class")) entries.push([path.relative(classes, file).split(path.sep).join("/"), fs.readFileSync(file)]);
        else throw new Error("Unexpected Java compiler output.");
      }
    }
    walk(classes); const bytes = jar(entries);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes, { mode: 0o644 });
    return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
      sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"), classMajor: 52 };
  } finally { fs.rmSync(classes, { recursive: true, force: true }); }
}
if (require.main === module) console.log(JSON.stringify(build(process.argv[2], process.argv[3])));
module.exports = { build, jar };
