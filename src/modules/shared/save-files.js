const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

function writeSaveWithBackup(filePath, encoded, { expectedHash } = {}) {
  const backupPath = `${filePath}.maclauncher.bak`;
  const tempPath = path.join(path.dirname(filePath), `.maclauncher-save-${randomUUID()}.tmp`);
  const tempBackupPath = path.join(path.dirname(filePath), `.maclauncher-backup-${randomUUID()}.tmp`);
  let original = null;
  let backup = null;
  try {
    original = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (original && !original.isFile()) throw new Error("Save target must be a regular file.");
  const assertCurrentHash = () => {
    if (!expectedHash) return;
    const current = fs.lstatSync(filePath);
    if (!current.isFile()) throw new Error("Save target must be a regular file.");
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (createHash("sha256").update(fs.readFileSync(fd)).digest("hex") !== expectedHash) {
        throw new Error("Save changed during writing. Reload before editing.");
      }
    } finally { fs.closeSync(fd); }
  };
  assertCurrentHash();
  try {
    backup = fs.lstatSync(backupPath);
    if (!backup.isFile()) throw new Error("Save backup must be a regular file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    // Codec strings keep their engine's UTF-8-on-disk convention (including
    // MZ's compressed binary string); Buffer codecs are written byte-for-byte.
    fs.writeFileSync(tempPath, encoded, { encoding: "utf8", flag: "wx", mode: original ? original.mode & 0o777 : 0o600 });
    if (original) {
      if (backup) {
        // Never truncate a previous recovery backup (or its hard-link aliases)
        // while a copy is still in progress.
        fs.copyFileSync(filePath, tempBackupPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(tempBackupPath, backup.mode & 0o777);
        fs.renameSync(tempBackupPath, backupPath);
      } else {
        fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      }
    }
    assertCurrentHash();
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(tempBackupPath, { force: true });
  }
}

module.exports = { writeSaveWithBackup };
