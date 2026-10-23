const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");

// gpu-next caches parsed hooks by pathname, including a failed parse. A new
// revision needs a new path. Row bindings also need distinct filename-based
// parameter namespaces when a chain repeats a shader or uses equal basenames.
function snapshot(file, userDataDir, bindingId) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Video shader storage is unavailable.");
  const source = fs.realpathSync(file), fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 8 * 1024 * 1024) throw new Error("Choose a video shader no larger than 8 MiB.");
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("The video shader changed while it was being prepared. Try again.");
  } finally { fs.closeSync(fd); }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = bindingId === undefined ? path.basename(source)
    : "ml-" + crypto.createHash("sha256").update(String(bindingId) + "\0" + digest).digest("hex") + path.extname(source);
  const target = path.join(userDataDir, "graphics", "video-shaders", digest, filename);
  Writable.assertOwnDirectory(userDataDir, path.dirname(target));
  const existing = fs.lstatSync(target, {throwIfNoEntry: false});
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || !fs.readFileSync(target).equals(bytes)))
    throw new Error("The prepared video shader is unavailable. Choose the source file again.");
  if (!existing) Writable.atomicWrite(target, bytes, {root: userDataDir});
  return target;
}

module.exports = {snapshot};
