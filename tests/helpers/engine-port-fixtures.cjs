const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

function temporary(t, prefix = "engine-port-") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, data = "") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }
// A DOS program header, or a Windows one with a PE signature.
function mz(signature) {
  const bytes = Buffer.alloc(512); bytes.write("MZ"); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(4, 8);
  if (signature) { bytes.writeUInt32LE(128, 0x3c); bytes.write(signature, 128); }
  return bytes;
}
// A Windows GUI program for 32-bit x86.
function pe() {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt16LE(2, 220);
  return bytes;
}
const wad = (magic = "IWAD") => Buffer.concat([Buffer.from(magic), Buffer.alloc(8)]);
const grp = () => Buffer.concat([Buffer.from("KenSilverman"), Buffer.alloc(4)]);
const gob = () => Buffer.from("GOB\n\0\0\0\0");
function context(input) {
  const stat = fs.statSync(input);
  return { inputPath: input, rootDir: stat.isDirectory() ? input : path.dirname(input), stat, isAppBundle: false };
}

module.exports = { temporary, write, mz, pe, wad, grp, gob, context };
