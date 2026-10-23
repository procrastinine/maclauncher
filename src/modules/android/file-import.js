const fs = require("node:fs"), path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { getUiServices } = require("../shared/ui-services");
const Writable = require("../shared/writable-input");
const { prepareStorage, storagePaths } = require("./storage");

const LIMITS = Object.freeze({ files: 128, fileBytes: 1024 ** 3, totalBytes: 4 * 1024 ** 3 });
const pending = new Set();
function assertIdle(context) {
  context.signal?.throwIfAborted();
  if (context.isGameRunning?.()) throw new Error("Quit the Android application before importing files.");
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function regularFile(file) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Select regular files, without symbolic links or folders.");
  if (stat.size > LIMITS.fileBytes) throw new Error("Each imported file must be at most 1 GiB.");
  return stat;
}

async function copySelected(item, target, context, completed, total) {
  assertIdle(context);
  const input = await fs.promises.open(item.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile() || !unchanged(item.stat, before)) throw new Error("A selected file changed before import. Select it again.");
    let copied = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      copied += chunk.length;
      callback(copied > before.size ? new Error("A selected file changed during import. Select it again.") : null, chunk);
    } });
    await pipeline(input.createReadStream({ autoClose: false }), limit,
      fs.createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal: context.signal });
    const after = await input.stat(), named = await regularFile(item.file);
    if (copied !== before.size || !unchanged(before, after) || !unchanged(before, named))
      throw new Error("A selected file changed during import. Select it again.");
    context.onProgress?.({ phase: "import", completed, total, label: "Importing files…" });
  } finally { await input.close(); }
}

async function publish(staged, directory, name) {
  const extension = path.extname(name), stem = name.slice(0, name.length - extension.length);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const target = path.join(directory, suffix ? `${stem} (${suffix + 1})${extension}` : name);
    try {
      // Linking our private copy publishes a complete file without replacing an
      // existing file or following a destination alias. The source is never linked.
      await fs.promises.link(staged, target);
      return target;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error("Too many files share this name in the imports folder.");
}

async function importFiles(entry, payload = {}, context = {}) {
  const paths = storagePaths(context.userDataDir, entry?.gameId);
  assertIdle(context);
  if (pending.has(paths.root)) throw new Error("Files are already being imported for this application.");
  pending.add(paths.root);
  let staging;
  const published = [];
  try {
    let selected = payload.filePaths;
    if (selected === undefined) {
      const result = await getUiServices(context).dialog.showOpenDialog({ title: "Import files into Android application",
        buttonLabel: "Import", properties: ["openFile", "multiSelections", "noResolveAliases"],
        message: "Copy selected files into the application's private imports folder. Original files remain unchanged." });
      if (result.canceled) return { canceled: true };
      selected = result.filePaths;
    }
    assertIdle(context);
    if (!Array.isArray(selected) || selected.some(file => typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")))
      throw new Error("Select an array of absolute file paths.");
    if (!selected.length) return { canceled: true };
    if (selected.length > LIMITS.files) throw new Error("Select at most 128 files per import.");
    const items = [], identities = new Set();
    let bytes = 0;
    for (const file of selected) {
      assertIdle(context);
      const stat = await regularFile(file), identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) throw new Error("The same file was selected more than once.");
      identities.add(identity);
      if ((bytes += stat.size) > LIMITS.totalBytes) throw new Error("Select at most 4 GiB of files per import.");
      items.push({ file, stat });
    }
    await prepareStorage(entry, context.userDataDir, { signal: context.signal });
    assertIdle(context);
    const imports = path.join(paths.filesRoot, "imports");
    Writable.assertOwnDirectory(context.userDataDir, imports);
    staging = await fs.promises.mkdtemp(path.join(paths.root, ".file-import-"));
    for (let index = 0; index < items.length; index++)
      await copySelected(items[index], path.join(staging, String(index)), context, index + 1, items.length);
    for (let index = 0; index < items.length; index++) {
      assertIdle(context);
      Writable.assertOwnDirectory(context.userDataDir, imports, { create: false });
      const staged = path.join(staging, String(index));
      const stat = await fs.promises.lstat(staged);
      const file = await publish(staged, imports, path.basename(items[index].file));
      published.push({ file, stat });
    }
    assertIdle(context);
    return { imported: true, count: items.length, bytes, directory: imports, files: published.map(item => path.basename(item.file)) };
  } catch (error) {
    for (const item of published.reverse()) {
      try {
        const stat = await fs.promises.lstat(item.file);
        if (sameFile(stat, item.stat)) await fs.promises.unlink(item.file);
      } catch (cleanup) { if (cleanup.code !== "ENOENT") context.logger?.warn?.("Could not remove an incomplete Android file import", cleanup); }
    }
    throw error;
  } finally {
    try { if (staging) await fs.promises.rm(staging, { recursive: true, force: true }); }
    finally { pending.delete(paths.root); }
  }
}

module.exports = { importFiles, LIMITS };
