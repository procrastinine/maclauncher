const fs = require("node:fs"), path = require("node:path");
const Upstream = require("./upstream"), Bundled = require("./bundled-native"), Native = require("./local-native");
const { downloadApproved } = require("./tool-install");
const { createAbortError, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const pending = new Map();

function filename(asset, userDataDir) {
  if (!path.isAbsolute(userDataDir || "") || !/^[a-z0-9-]+$/.test(asset.id || "") ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 || "") || path.basename(asset.filename || "") !== asset.filename ||
      !asset.filename || [".", ".."].includes(asset.filename) || /[\\\0]/.test(asset.filename) ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) throw Error("Invalid shared asset identity.");
  return path.join(userDataDir, "assets", asset.id, asset.sha256, asset.filename);
}
function resolve(asset, userDataDir) {
  if (!userDataDir) return null;
  const file = filename(asset, userDataDir);
  try {
    if (!Bundled.realDirectory(path.dirname(file))) return null;
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.bytes && Native.hashFile(file) === asset.sha256 ? file : null;
  } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}
async function ensure(asset, context) {
  throwIfAborted(context.signal);
  const existing = resolve(asset, context.userDataDir); if (existing) return existing;
  const target = filename(asset, context.userDataDir);
  if (pending.has(target)) return pending.get(target);
  const work = (async () => {
    const listed = Upstream.listedFile(asset);
    if (!listed) throw Error(`${asset.label} download is unavailable.`);
    if (!await downloadApproved(context, { managerId: asset.id, version: asset.sha256, label: asset.label,
      requiresDownload: true, kind: "asset", confirmLabel: "Download and Play",
      detail: `${asset.bytes.toLocaleString("en-US")} bytes. Stored once and shared between games.` }))
      throw createAbortError("Asset download canceled.");
    return runDownloadTask(context.downloads, { managerId: asset.id, label: asset.label, version: asset.sha256, kind: "asset" }, async task => {
      const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal;
      throwIfAborted(signal);
      Bundled.realDirectory(path.dirname(target), { create: true });
      const staging = fs.mkdtempSync(path.join(path.dirname(target), ".download-"));
      try {
        const temporary = path.join(staging, asset.filename);
        await Upstream.download(listed, temporary, { signal, onProgress: task.onProgress || context.onProgress });
        throwIfAborted(signal);
        const other = resolve(asset, context.userDataDir); if (other) return other;
        try { if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw Error("The shared asset destination is not a regular file."); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        fs.renameSync(temporary, target); return target;
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }, { onProgress: context.onProgress });
  })();
  pending.set(target, work);
  try { return await work; } finally { pending.delete(target); }
}
module.exports = { filename, resolve, ensure };
