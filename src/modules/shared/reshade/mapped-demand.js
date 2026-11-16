const fs = require("node:fs"), path = require("node:path");
const Writable = require("../writable-input");

// A process maps this byte once. Updates and rollback retain its backing
// inode; ordinary plan documents continue to use atomic replacement.
function write(file, value, {root = path.dirname(file)} = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length !== 1 || bytes[0] !== 48 && bytes[0] !== 49) throw new Error("Mapped demand requires one boolean byte.");
  Writable.assertOwnDirectory(root, path.dirname(file));
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const opened = fs.fstatSync(descriptor), current = fs.lstatSync(file);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino || opened.size > 1)
      throw new Error("Mapped demand must remain one ordinary file.");
    if (fs.writeSync(descriptor, bytes, 0, 1, 0) !== 1) throw new Error("Cannot publish mapped demand.");
  } finally { fs.closeSync(descriptor); }
}
// The late camera file (native late-camera.hpp): the game's NGX core writes it and
// the graphics library reads it, both through a mapping, so an existing file of
// its fixed size keeps its inode and contents. It exists only while wanted.
function camera(file, wanted, {root = path.dirname(file), size = 4096} = {}) {
  Writable.assertOwnDirectory(root, path.dirname(file));
  let current = null;
  try { current = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current && wanted && current.isFile() && current.size === size) return;
  if (current) {
    if (current.isDirectory()) throw new Error("The late camera file must be one ordinary file.");
    fs.unlinkSync(file);
  }
  if (!wanted) return;
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.ftruncateSync(descriptor, size); } finally { fs.closeSync(descriptor); }
}
module.exports = {write, camera};
