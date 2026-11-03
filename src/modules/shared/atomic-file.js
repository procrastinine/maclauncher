// Replaces `filePath` with `contents` (a string or Buffer) and returns
// `filePath`. The bytes go to `.<name>.<16 hex>.tmp` in the same directory and
// are flushed before the rename publishes them, so a reader or a crash sees
// either the previous file or the complete new one. The directory is then
// flushed where the platform allows it. An existing destination keeps its
// permission bits and must be a regular file; a new file is 0600. Missing
// parent directories are created. On any failure before the rename completes,
// the temporary file is removed and the error is rethrown.
//
// The function is self-contained: it requires only the fs, path and crypto
// builtins by their plain names and uses long-standing synchronous APIs,
// because game runtimes embed its source text unchanged.
function writeFileAtomic(filePath, contents) {
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error("Atomic write destination is not a regular file: " + filePath);
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "." + path.basename(filePath) + "." + crypto.randomBytes(8).toString("hex") + ".tmp");
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (ignored) {}
  return filePath;
}

module.exports = { writeFileAtomic };
