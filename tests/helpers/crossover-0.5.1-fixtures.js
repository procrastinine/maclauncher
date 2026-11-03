// Produces the private Windows game/ copies that MacLauncher 0.5.1 staged for
// CrossOver and Sikarugir, so tests can check how current code treats them.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../src/modules/shared/writable-input");
const { cloneOrCopy } = require("../../src/modules/shared/copy-file");
const { inside } = require("../../src/modules/crossover/detect");

async function stageGameFiles(sourceRoot, directory, context = {}) {
  const source = fs.realpathSync(sourceRoot), gameRoot = path.join(directory, "game"), receiptPath = path.join(directory, "game-files.json");
  let parent = path.resolve(directory), missing = [];
  while (!fs.existsSync(parent)) { missing.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const destination = path.join(fs.realpathSync(parent), ...missing);
  if (inside(source, destination) || inside(destination, source)) throw new Error("Windows game data must be outside the original game folder.");
  let receipt;
  try { receipt = JSON.parse(await fs.promises.readFile(receiptPath, "utf8")); } catch {}
  Writable.assertOwnDirectory(directory, gameRoot, { create: false });
  Writable.assertOwnDirectory(directory, gameRoot);
  const previous = receipt?.layoutVersion === 2 && receipt.files && typeof receipt.files === "object"
    ? receipt.files : {};
  // Keep records for removed originals without deleting private files. These
  // may contain saves or edits even when an upstream update removes the asset.
  const records = { ...previous };
  let files = 0;
  let hashedBytes = 0, lastHashProgress = 0;
  const stamp = stat => stat && [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  const coarse = identity => identity && identity[4] % 1000 === 0;
  const equal = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
  // A drive that is ejected and reconnected may return under another device
  // number with the same files, so the device alone never marks a file changed.
  const unchanged = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => !index || value === b[index]);
  async function leafStat(file) {
    let stat; try { stat = await fs.promises.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Windows game files must be private regular files.");
    return stat || null;
  }
  async function hashFile(file, progress = true) {
    context.signal?.throwIfAborted();
    if (progress) context.onProgress?.({ phase: "prepare", label: "Preparing Windows game…", completed: files, bytesRead: hashedBytes });
    context.signal?.throwIfAborted();
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file, { signal: context.signal })) {
      context.signal?.throwIfAborted();
      hash.update(chunk); hashedBytes += chunk.length;
      if (progress && Date.now() - lastHashProgress > 250) {
        lastHashProgress = Date.now();
        context.onProgress?.({ phase: "prepare", label: "Preparing Windows game…", completed: files, bytesRead: hashedBytes });
      }
    }
    context.signal?.throwIfAborted();
    return hash.digest("hex");
  }
  async function assertSourceStable(input, resolved, original, expectedHash) {
    if (await fs.promises.realpath(input) !== resolved || !inside(source, resolved) ||
      !equal(stamp(await fs.promises.stat(input)), original) || coarse(original) &&
      (!expectedHash || await hashFile(resolved, false) !== expectedHash || !equal(stamp(await fs.promises.stat(input)), original)))
      throw new Error("The original Windows game changed during preparation. Try Play again.");
  }
  async function assertPrivateStable(output, expected, expectedHash) {
    const current = await leafStat(output);
    if (expected ? !current || !equal(stamp(current), expected) || coarse(expected) &&
        (!expectedHash || await hashFile(output, false) !== expectedHash || !equal(stamp(await leafStat(output)), expected)) : current) {
      throw new Error("The game's private Windows files changed during preparation. Try Play again.");
    }
  }
  async function reconcile(input, resolved, output, stat, relative) {
    const original = stamp(stat), old = Object.hasOwn(previous, relative) ? previous[relative] : null;
    const existing = await leafStat(output);
    // Fine-precision files keep the metadata-only fast path. Coarse source
    // identities need content evidence before trusting a previous baseline.
    if (receipt?.sourceRoot === source && old && unchanged(old.source, original) && !coarse(original)) {
      if (!equal(old.source, original)) records[relative] = { ...old, source: original };
      return;
    }
    const privateStamp = existing ? stamp(existing) : null;
    if (old && !existing) {
      // Deleting a private asset can itself be an intentional game modification.
      records[relative] = { ...old, source: original }; return;
    }
    // Capture coarse source bytes before progress callbacks can interleave an
    // update. Later checks compare bytes, not only a same-second stat.
    let sourceHash = coarse(original) ? await hashFile(resolved, false) : undefined, privateHash;
    if (existing) {
      privateHash = await hashFile(output);
      await assertPrivateStable(output, privateStamp, privateHash);
      const untouched = old?.baseline && privateHash === old.baseline;
      // An untouched copy of an original whose bytes did not change, such as a
      // folder copied or restored elsewhere, only needs its record updated.
      if (sourceHash === undefined && (!untouched || stat.size === privateStamp[2])) sourceHash = await hashFile(resolved);
      if (!untouched || sourceHash === old.baseline) {
        await assertSourceStable(input, resolved, original, sourceHash);
        await assertPrivateStable(output, privateStamp, privateHash);
        // Older no-hash records and interrupted earlier updates are safe to
        // adopt only when the current private bytes equal the current original.
        records[relative] = { source: original, baseline: privateHash === sourceHash ? sourceHash : old?.baseline || null };
        return;
      }
    }
    const temporary = output + "." + crypto.randomUUID() + ".tmp";
    try {
      await assertSourceStable(input, resolved, original, sourceHash);
      // Arbitrary Windows games may write beside any asset. Copy-on-write clones
      // preserve that isolation without allocating a second copy when supported.
      await cloneOrCopy(resolved, temporary, { signal: context.signal });
      await fs.promises.chmod(temporary, stat.mode | 0o600);
      await fs.promises.utimes(temporary, stat.atime, stat.mtime);
      // The stamp, including the change time, still matches the hashed original.
      const baseline = sourceHash ?? await hashFile(temporary);
      if (coarse(original) && await hashFile(temporary) !== baseline) throw new Error("The original Windows game changed during preparation. Try Play again.");
      await assertSourceStable(input, resolved, original, baseline);
      await assertPrivateStable(output, privateStamp, privateHash);
      context.signal?.throwIfAborted();
      await fs.promises.rename(temporary, output);
      records[relative] = { source: original, baseline };
    } finally { await fs.promises.rm(temporary, { force: true }); }
  }
  const ancestors = new Set();
  async function visit(from, to, depth = 0) {
    context.signal?.throwIfAborted();
    if (depth > 64) throw new Error("Windows game directories are too deeply nested.");
    const real = await fs.promises.realpath(from);
    if (!inside(source, real) || ancestors.has(real)) throw new Error("Windows game folder contains an external or cyclic alias.");
    ancestors.add(real);
    Writable.assertOwnDirectory(directory, to);
    for (const item of await fs.promises.readdir(real, { withFileTypes: true })) {
      context.signal?.throwIfAborted();
      if (item.name === ".DS_Store" || /\.app$/i.test(item.name)) continue;
      const input = path.join(real, item.name), output = path.join(to, item.name);
      const resolved = await fs.promises.realpath(input);
      if (!inside(source, resolved)) throw new Error("Windows game folder contains an alias outside its content folder.");
      const stat = await fs.promises.stat(input);
      if (stat.isDirectory()) await visit(resolved, output, depth + 1);
      else if (stat.isFile()) {
        if (++files > 250000) throw new Error("Windows game folder contains too many files.");
        await reconcile(input, resolved, output, stat, path.relative(gameRoot, output));
        if (files % 128 === 0) context.onProgress?.({ phase: "prepare", label: "Preparing Windows game…", completed: files });
      } else throw new Error("Windows game files must be regular files or directories.");
    }
    ancestors.delete(real);
  }
  await visit(source, gameRoot);
  context.signal?.throwIfAborted();
  Writable.atomicWrite(receiptPath, JSON.stringify({ sourceRoot: source, files: records, fileCount: files, layoutVersion: 2 }) + "\n", { root: directory });
  return gameRoot;
}

module.exports = { stageGameFiles };
