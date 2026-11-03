const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const CopyFile = require("./copy-file");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("./writable-input");
const DockIcon = require("./dock-icon");
const FileSignature = require("./file-signature");
const { isDeepStrictEqual } = require("node:util");
const { readJsonObject, writeJsonAtomic } = require("../../core/json-files");
const run = promisify(execFile), pending = new Map();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function sameBasis(previous, current) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return false;
  const { executableIdentity: oldIdentity, ...oldBasis } = previous;
  const { executableIdentity: newIdentity, ...newBasis } = current;
  return FileSignature.same(oldIdentity, newIdentity) && isDeepStrictEqual(oldBasis, newBasis);
}
const xml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
function bundleName(title, fallback = "Application") {
  let name = String(title || fallback).normalize("NFC").replace(/[\x00-\x1f\x7f/:]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  // Finder and Dock may use the bundle filename as well as its display name.
  // Leave room for the suffix within the filesystem's byte-length limit.
  while (Buffer.byteLength(name) > 180) name = Array.from(name).slice(0, -1).join("");
  return (name.trim() || fallback) + ".app";
}
function icns(png, label = "Application") {
  if (png.length < 24 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a" || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256)
    throw new Error(label + " application icons must be 256-pixel PNG images.");
  const output = Buffer.alloc(16 + png.length);
  output.write("icns"); output.writeUInt32BE(output.length, 4);
  output.write("ic08", 8); output.writeUInt32BE(png.length + 8, 12); png.copy(output, 16);
  return output;
}
function plist(title, identifier, fingerprint, icon, executableName, showInDock = false, original = {}) {
  const fields = { ...original, CFBundleExecutable: executableName, CFBundleIdentifier: identifier, CFBundleName: title,
    CFBundleDisplayName: title, CFBundlePackageType: "APPL", CFBundleVersion: original.CFBundleVersion ?? String(parseInt(fingerprint.slice(0, 8), 16)),
    ...(icon ? { CFBundleIconFile: "Application.icns" } : {}) };
  delete fields.LSUIElement; delete fields.NSHighResolutionCapable;
  const encode = value => typeof value === "boolean" ? value ? "<true/>" : "<false/>" :
    typeof value === "number" && Number.isFinite(value) ? `<${Number.isInteger(value) ? "integer" : "real"}>${value}</${Number.isInteger(value) ? "integer" : "real"}>` :
    Array.isArray(value) ? "<array>" + value.map(encode).join("") + "</array>" :
    value && typeof value === "object" ? "<dict>" + Object.entries(value).map(([key, child]) => `<key>${xml(key)}</key>${encode(child)}`).join("") + "</dict>" : `<string>${xml(value)}</string>`;
  return '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
    Object.entries(fields).map(([key, value]) => `<key>${xml(key)}</key>${encode(value)}`).join("") +
    '<key>LSUIElement</key>' + (showInDock ? '<false/>' : '<true/>') + '<key>NSHighResolutionCapable</key>' + (original.NSHighResolutionCapable === false ? '<false/>' : '<true/>') + '</dict></plist>';
}

/** One signed Mac application entry. Runtime libraries remain
 * with their original supplier; only explicitly requested links are installed. */
async function prepare({ executablePath: sourcePath, executableName: requestedExecutableName, links = {}, resourceLinks = {}, nativeLinks = {}, directory, title, iconFile, iconHelper, showInDock = false, signal,
  identifier: requestedIdentifier, identifierPrefix = "com.maclauncher.application.", nameFallback = "Application", applicationLabel = "Application", originalInfo = {}, cloneOnly = false,
  graphicsCompatible = false }, execute = run) {
  const previous = pending.get(directory) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    const executable = await fs.promises.realpath(sourcePath), sourceName = path.basename(executable);
    const executableName = requestedExecutableName ?? sourceName;
    if (typeof executableName !== "string" || !executableName || executableName === "." || executableName === ".." ||
        executableName !== path.basename(executableName) || executableName.includes("\0") || Buffer.byteLength(executableName) > 255)
      throw new Error("Application executable names must be filenames up to 255 bytes.");
    for (const name of [...Object.keys(links), ...Object.keys(resourceLinks), ...Object.keys(nativeLinks)]) if (!name || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0"))
      throw new Error("Application runtime links must be filenames.");
    if (Object.hasOwn(nativeLinks, executableName) || iconFile && Object.hasOwn(resourceLinks, "Application.icns"))
      throw new Error("Application resources conflict with the owned executable or icon.");
    const stat = await fs.promises.stat(executable), png = iconFile ? await fs.promises.readFile(iconFile) : null;
    const basis = { layout: 4, executable, links, executableIdentity: FileSignature.signature(stat), title,
      icon: png ? hash(png) : null, iconHandler: png && iconHelper ? hash(await fs.promises.readFile(iconHelper)) : null,
      ...(png ? { iconStyle: DockIcon.style } : {}),
      ...(showInDock ? { showInDock: true } : {}), ...(executableName !== sourceName ? { executableName } : {}),
      ...(Object.keys(resourceLinks).length ? { resourceLinks } : {}), ...(Object.keys(nativeLinks).length ? { nativeLinks } : {}),
      ...(requestedIdentifier ? { identifier: requestedIdentifier } : {}), ...(Object.keys(originalInfo).length ? { originalInfo } : {}), ...(cloneOnly ? { cloneOnly: true } : {}),
      ...(graphicsCompatible ? { graphicsCompatible: true } : {}) };
    const fingerprint = hash(JSON.stringify(basis)), app = path.join(directory, bundleName(title, nameFallback));
    const identifier = requestedIdentifier || identifierPrefix + hash(path.resolve(directory)).slice(0, 24);
    const executablePath = path.join(app, "Contents/MacOS", executableName), receipt = path.join(directory, "application.json");
    const applyIcon = async () => {
      if (!png || !iconHelper) return true;
      try {
        // Assign the prepared icon directly; IconServices would otherwise add
        // a second background around the generated application artwork.
        await execute(iconHelper, [app], { signal, timeout: 10000, maxBuffer: 65536 });
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        console.warn(applicationLabel + " application icon could not be updated: " + error.message);
        return false;
      }
    };
    const previousReceipt = readJsonObject(receipt);
    if ((previousReceipt?.fingerprint === fingerprint || sameBasis(previousReceipt?.basis, basis)) && fs.existsSync(executablePath)) {
      if (previousReceipt.iconApplied === false) writeJsonAtomic(receipt, { ...previousReceipt, iconApplied: await applyIcon() });
      return { executablePath, app, identifier };
    }
    Writable.assertOwnDirectory(path.dirname(directory), directory);
    const temporary = await fs.promises.mkdtemp(path.join(directory, ".application-"));
    try {
      const staged = path.join(temporary, bundleName(title, nameFallback)), contents = path.join(staged, "Contents");
      await fs.promises.mkdir(path.join(contents, "MacOS"), { recursive: true });
      await fs.promises.mkdir(path.join(contents, "Resources"));
      const destination = path.join(contents, "MacOS", executableName);
      await CopyFile.cloneOrCopy(executable, destination, { signal });
      await fs.promises.chmod(path.join(contents, "MacOS", executableName), 0o755);
      for (const [name, source] of Object.entries(links)) {
        if (fs.existsSync(source)) await fs.promises.symlink(source, path.join(contents, name));
      }
      for (const [base, entries] of [["Resources", resourceLinks], ["MacOS", nativeLinks]]) for (const [name, source] of Object.entries(entries))
        await fs.promises.symlink(source, path.join(contents, base, name));
      if (png) await fs.promises.writeFile(path.join(contents, "Resources/Application.icns"), icns(await DockIcon.render(iconFile, { signal }), applicationLabel));
      await fs.promises.writeFile(path.join(contents, "Info.plist"), plist(title, identifier, fingerprint, Boolean(png), executableName, showInDock, originalInfo));
      // Only the owned entry is re-signed. Linked supplier code is unchanged.
      await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none",
        ...(graphicsCompatible ? ["--options", "0", "--preserve-metadata=entitlements"] : ["--preserve-metadata=entitlements,flags,runtime"]), staged],
        { signal, timeout: 30000, maxBuffer: 65536 });
      signal?.throwIfAborted();
      await fs.promises.rm(app, { recursive: true, force: true });
      await fs.promises.rename(staged, app);
      writeJsonAtomic(receipt, { fingerprint, basis, iconApplied: await applyIcon() });
      const previousName = previousReceipt?.basis?.layout === 1 ? "Application.app" :
        previousReceipt?.basis?.layout >= 2 ? bundleName(previousReceipt.basis.title, nameFallback) : null;
      if (previousName && previousName !== path.basename(app)) await fs.promises.rm(path.join(directory, previousName), { recursive: true, force: true });
      return { executablePath, app, identifier };
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  });
  pending.set(directory, operation);
  try { return await operation; } finally { if (pending.get(directory) === operation) pending.delete(directory); }
}
function serialized(directory, task) {
  const operation = (pending.get(directory) || Promise.resolve()).catch(() => {}).then(task);
  pending.set(directory, operation);
  return operation.finally(() => { if (pending.get(directory) === operation) pending.delete(directory); });
}

// A private copy of a Mac app, or of a standalone executable, whose code
// signature refuses the shared graphics library. Real directories lead to the
// code that is re-signed and to each signed bundle's Info.plist; every other
// item is an alias of the original, so the app reads and writes its own files
// in place and only the re-signed code takes new space. Launch arguments,
// working directories and environment retain the original game paths.
// Re-signed code is signed ad hoc without the hardened runtime,
// restrict or library-validation flags and keeps its entitlements, except the
// restricted ones that only a provisioning profile can grant.
const SIGNATURE_FILES = ["_CodeSignature", "CodeResources"];
const RESTRICTED = /^(?:com\.apple\.developer\..+|com\.apple\.private\..+|com\.apple\.application-identifier|keychain-access-groups)$/;
const SANDBOXED = "The app uses the App Sandbox. macOS ties its data container to the original signature, so a re-signed copy would need permission to open that container or would not start.";
const contains = (root, file) => file === root || file.startsWith(root + path.sep);

/** The outermost bundle that contains a file, or the file itself. */
function copyUnit(file) {
  file = path.resolve(file);
  let unit = file;
  for (let current = path.dirname(file); current !== path.dirname(current); current = path.dirname(current)) {
    try { if (file.startsWith(path.join(current, "Contents") + path.sep) && fs.statSync(path.join(current, "Contents", "Info.plist")).isFile()) unit = current; }
    catch {}
  }
  return unit;
}
function copyPlan(unit, executables) {
  const real = new Set(), dirs = new Set(), signed = new Set(), skip = new Set();
  for (const file of executables) {
    const relative = path.relative(unit, path.resolve(file)), parts = relative.split(path.sep), owner = parts.slice(0, -3).join(path.sep);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A graphics copy holds only code from inside the original app.");
    real.add(relative);
    // A bundle's main executable is signed together with its bundle.
    if (parts.length >= 3 && parts.at(-2) === "MacOS" && parts.at(-3) === "Contents" &&
        require("./runtime/app-bundle").resolveAppBundleExecutablePath(path.join(unit, owner)) === path.join(unit, relative)) {
      signed.add(owner); real.add(path.join(owner, "Contents", "Info.plist"));
      for (const name of SIGNATURE_FILES) skip.add(path.join(owner, "Contents", name));
    } else signed.add(relative);
  }
  for (let directory of real) while (directory) { directory = path.dirname(directory); if (directory === ".") directory = ""; dirs.add(directory); }
  const sorted = set => [...set].sort();
  return { real: sorted(real), dirs: sorted(dirs), signed: sorted(signed), skip: sorted(skip) };
}
// The original facts a copy depends on: the listing of each real directory,
// its aliases and the identity of each file the copy owns.
async function describeCopy(unit, plan) {
  const listing = {}, links = {}, files = {};
  for (const directory of plan.dirs) {
    const names = [];
    for (const item of await fs.promises.readdir(path.join(unit, directory), { withFileTypes: true })) {
      const relative = path.join(directory, item.name);
      if (plan.skip.includes(relative)) continue;
      names.push(item.name);
      if (item.isSymbolicLink()) links[relative] = await fs.promises.readlink(path.join(unit, relative));
    }
    listing[directory] = names.sort();
  }
  for (const relative of plan.real) files[relative] = FileSignature.signature(await fs.promises.stat(path.join(unit, relative)));
  return { layout: 1, unit, plan, listing, links, files };
}
// Restricted code can derive data paths from its bundle's parent, rather
// than cwd. Keep those compatibility aliases only for this signed copy.
async function linkSiblings(unit, view, owned) {
  const parent = path.dirname(unit), name = path.basename(unit);
  const before = FileSignature.signature(await fs.promises.stat(parent, { bigint: true }));
  const wanted = new Set((await fs.promises.readdir(parent)).filter(item => item !== name));
  for (const item of await fs.promises.readdir(view, { withFileTypes: true })) {
    if (item.name === name || !item.isSymbolicLink()) continue;
    if (wanted.has(item.name) && await fs.promises.readlink(path.join(view, item.name)) === path.join(parent, item.name)) wanted.delete(item.name);
    else if (!owned || owned[item.name]?.link === await fs.promises.readlink(path.join(view, item.name))) {
      await fs.promises.unlink(path.join(view, item.name));
      if (owned) delete owned[item.name];
    }
  }
  for (const item of wanted) {
    const link = path.join(parent, item);
    try { await fs.promises.symlink(link, path.join(view, item)); if (owned) owned[item] = { link }; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const after = FileSignature.signature(await fs.promises.stat(parent, { bigint: true }));
  // A concurrent rename leaves no reusable listing generation.
  return FileSignature.same(before, after) ? after : null;
}
async function signedEntitlements(text, file, execute, signal) {
  await fs.promises.writeFile(file, text);
  const dropped = [];
  for (const key of new Set([...text.matchAll(/<key>\s*([^<]*?)\s*<\/key>/g)].map(match => match[1]).filter(key => RESTRICTED.test(key)))) {
    try { await execute("/usr/libexec/PlistBuddy", ["-c", "Delete :" + key, file], { signal, timeout: 10000, maxBuffer: 65536 }); dropped.push(key); }
    catch { signal?.throwIfAborted(); }
  }
  return dropped;
}

// Only entries recorded when the copy was made belong to the launcher. A game
// can create files in any of its real directories, or replace one of its aliases.
async function copyEntries(root) {
  const entries = Object.create(null);
  const walk = async relative => {
    const file = path.join(root, relative), stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink()) entries[relative] = { link: await fs.promises.readlink(file) };
    else if (stat.isDirectory()) {
      entries[relative] = { directory: true };
      for (const name of await fs.promises.readdir(file)) await walk(path.join(relative, name));
    } else if (stat.isFile()) entries[relative] = { file: FileSignature.signature(stat) };
    else entries[relative] = { other: true };
  };
  const exists = await fs.promises.lstat(root).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (exists) await walk("");
  return entries;
}
// Receipts made before entry ownership was recorded still identify their
// directory spines, copied code and original aliases. Unknown entries stay.
function copyOwnership(receipt, entries) {
  if (receipt.owned) return receipt.owned;
  const { unit, plan, listing, links } = receipt.basis, name = path.basename(unit), owned = Object.assign(Object.create(null), { "": { directory: true } });
  for (const directory of plan.dirs) owned[path.join(name, directory)] = { directory: true };
  for (const relative of plan.real) owned[path.join(name, relative)] = { file: receipt.copied?.[relative] };
  for (const [directory, names] of Object.entries(listing)) for (const item of names) {
    const relative = path.join(directory, item), key = path.join(name, relative), source = path.join(unit, relative), link = links[relative];
    if (!owned[key]) owned[key] = { link: link !== undefined && !path.isAbsolute(link) && contains(unit, path.resolve(path.dirname(source), link)) ? link : source };
  }
  for (const relative of plan.skip) {
    const key = path.join(name, relative);
    if (path.basename(relative) === "_CodeSignature") {
      owned[key] = { directory: true };
      if (entries[path.join(key, "CodeResources")]?.file) owned[path.join(key, "CodeResources")] = entries[path.join(key, "CodeResources")];
    } else if (entries[key]?.file) owned[key] = entries[key];
  }
  for (const [key, entry] of Object.entries(entries)) if (key && !key.includes(path.sep) && entry.link === path.join(path.dirname(unit), key)) owned[key] = entry;
  return owned;
}
function privateCopyEntries(entries, owned, strict = false) {
  const keep = [];
  for (const [key, actual] of Object.entries(entries)) {
    if (keep.some(parent => contains(parent, key))) continue;
    const expected = Object.hasOwn(owned, key) ? owned[key] : null;
    const same = expected && (actual.directory && expected.directory || actual.link !== undefined && actual.link === expected.link ||
      actual.file && expected.file && (!strict || FileSignature.same(actual.file, expected.file)));
    if (!same) keep.push(key);
  }
  return keep;
}
async function discardCopy(file, trashFolder = path.dirname(file)) {
  const Storage = require("../../core/storage-maintenance");
  const stat = await fs.promises.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (stat) { if (stat.isSymbolicLink()) throw new Error("A graphics copy directory must not be an alias."); await Storage.removeTrash(Storage.moveToTrash(file, { trashFolder })); }
}
// New stages contain only copies of data still held elsewhere. Legacy stages
// have no marker: older preparation could have moved the only private bytes in.
async function discardCopyStages(directory) {
  for (const name of await fs.promises.readdir(directory)) {
    if (!/^\.stage-[A-Za-z0-9]{6}$/.test(name)) continue;
    const file = path.join(directory, name), stat = await fs.promises.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 86400000) continue;
    const marker = readJsonObject(path.join(file, "copy-stage.json"));
    if (marker?.schema !== 1 || marker.duplicateOnly !== true || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) continue;
    try { process.kill(marker.pid, 0); continue; } catch (error) { if (error.code !== "ESRCH") continue; }
    await discardCopy(file, path.dirname(directory));
  }
}
// A self-updater can change a copied executable or Info.plist. Refresh still
// uses the current original code, but the changed bytes are never discarded.
async function preserveCopyChanges(root, stage, unit, entries, owned, signal) {
  const source = Object.fromEntries(Object.entries(entries).filter(([key, actual]) => actual.file && owned[key]?.file && !FileSignature.same(actual.file, owned[key].file)));
  if (!Object.keys(source).length) return null;
  const directory = path.join(stage, "recovered"), stored = {};
  for (const relative of Object.keys(source)) {
    const destination = path.join(directory, "files", relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await CopyFile.cloneOrCopy(path.join(root, relative), destination, { signal, exclusive: true });
    stored[relative] = FileSignature.signature(await fs.promises.lstat(destination));
  }
  const record = { unit, source, stored };
  writeJsonAtomic(path.join(directory, "record.json"), record);
  return { directory, record, key: crypto.createHash("sha256").update(JSON.stringify({ unit, source })).digest("hex") };
}
async function publishCopyChanges(directory, snapshot) {
  if (!snapshot) return;
  const parent = path.join(directory, "recovered");
  Writable.assertOwnDirectory(directory, parent);
  let target = path.join(parent, snapshot.key);
  const existing = await fs.promises.lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (existing) {
    // An unsuccessful publication may already have preserved these same
    // source identities. Reuse only an intact snapshot, never overwrite it.
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      const record = readJsonObject(path.join(target, "record.json"));
      if (record?.unit === snapshot.record.unit && isDeepStrictEqual(record.source, snapshot.record.source)) {
        const entries = await copyEntries(path.join(target, "files"));
        if (Object.entries(record.stored || {}).length === Object.keys(record.source).length &&
            Object.entries(record.stored).every(([key, identity]) => entries[key]?.file && FileSignature.same(entries[key].file, identity))) return;
      }
    }
    target += "-" + crypto.randomUUID();
  }
  // This permanent area is outside the stage and is never trash or pruned.
  // It is published before replacing root, so no failure can lose old bytes.
  await fs.promises.rename(snapshot.directory, target);
}
// The previous root is not trash until the new root AND receipt are committed.
// A crash before that point restores it, including every game-written file.
async function recoverCopy(directory) {
  const journalFile = path.join(directory, "copy-publication.json"), journal = readJsonObject(journalFile);
  if (!journal) return;
  if (!/^\.previous-[0-9a-f-]{36}$/.test(journal.previous || "") || journal.id !== journal.previous.slice(10)) throw new Error("The graphics copy publication record is invalid.");
  const root = path.join(directory, "root"), previous = path.join(directory, journal.previous), receiptFile = path.join(directory, "copy.json");
  if (readJsonObject(receiptFile)?.publicationId === journal.id) await discardCopy(previous, path.dirname(directory));
  else {
    const exists = await fs.promises.lstat(previous).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (exists) {
      if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error("The previous graphics copy is not a directory.");
      await discardCopy(root, path.dirname(directory));
      await fs.promises.rename(previous, root);
    } else if (!journal.hadRoot) await discardCopy(root, path.dirname(directory));
    if (journal.receipt) writeJsonAtomic(receiptFile, journal.receipt);
    else await fs.promises.rm(receiptFile, { force: true });
  }
  await fs.promises.unlink(journalFile);
}

/** Prepare or reuse the graphics copy of `unit` in `directory`. `executables`
 * returns the original files to re-sign; it runs only when the copy is made. */
function prepareCopy({ unit, executables, directory, signal }, execute = run) {
  unit = path.resolve(unit);
  return serialized(directory, async () => {
    signal?.throwIfAborted();
    Writable.assertOwnDirectory(path.dirname(directory), directory, { create: false });
    const Injection = require("./runtime/native-injection");
    const name = path.basename(unit), root = path.join(directory, "root"), copy = path.join(root, name), receiptFile = path.join(directory, "copy.json");
    await recoverCopy(directory);
    const receipt = readJsonObject(receiptFile);
    const entries = await copyEntries(root);
    if (entries[""] && (!entries[""].directory || receipt?.basis?.unit !== unit)) throw new Error("The existing graphics copy has no matching ownership record.");
    const owned = receipt?.basis?.unit === unit ? copyOwnership(receipt, entries) : {};
    let basis = receipt?.basis?.unit === unit && receipt.basis.plan ? await describeCopy(unit, receipt.basis.plan).catch(() => null) : null;
    let dropped = receipt?.droppedEntitlements || [];
    const intact = basis && isDeepStrictEqual(basis, receipt.basis) && Object.entries(receipt.copied || {}).every(([relative, identity]) => {
      try { return FileSignature.same(identity, FileSignature.signature(fs.statSync(path.join(copy, relative)))); } catch { return false; }
    });
    if (intact) {
      const siblingsIdentity = FileSignature.signature(await fs.promises.stat(path.dirname(unit), { bigint: true }));
      const missingLink = Object.entries(owned).some(([relative, identity]) => relative && !relative.includes(path.sep) &&
        relative !== name && identity.link !== undefined && !entries[relative]);
      if (!FileSignature.same(receipt.siblingsIdentity, siblingsIdentity) || missingLink) {
        const current = await linkSiblings(unit, root, owned);
        writeJsonAtomic(receiptFile, { ...receipt, owned, siblingsIdentity: current });
      }
    } else {
      const plan = copyPlan(unit, await executables());
      basis = await describeCopy(unit, plan);
      // Nested code first, then the bundles that contain it. A sandboxed
      // program is refused before anything is written.
      const order = [...plan.signed].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || (a < b ? -1 : a > b ? 1 : 0));
      const facts = [];
      for (const relative of order) {
        const original = path.join(unit, relative);
        const executable = fs.statSync(original).isDirectory() ? require("./runtime/app-bundle").resolveAppBundleExecutablePath(original) : original;
        facts.push(await Injection.inspect(executable, { execute, signal }));
        if (facts.at(-1).sandbox) throw new Error(SANDBOXED);
      }
      Writable.assertOwnDirectory(path.dirname(directory), directory);
      await discardCopyStages(directory).catch(error => console.warn("Earlier graphics-copy staging could not be removed: " + error.message));
      const stage = await fs.promises.mkdtemp(path.join(directory, ".stage-"));
      try {
        writeJsonAtomic(path.join(stage, "copy-stage.json"), { schema: 1, duplicateOnly: true, pid: process.pid });
        const view = path.join(stage, "root"), target = path.join(view, name), real = new Set(plan.real), dirs = new Set(plan.dirs);
        await fs.promises.mkdir(view);
        const place = async relative => {
          const source = path.join(unit, relative), destination = path.join(target, relative);
          if (real.has(relative)) return CopyFile.cloneOrCopy(source, destination, { signal, exclusive: true });
          if (dirs.has(relative)) {
            await fs.promises.mkdir(destination);
            for (const item of basis.listing[relative]) await place(path.join(relative, item));
            return;
          }
          // A relative alias that stays inside the app keeps its own spelling.
          const link = basis.links[relative];
          await fs.promises.symlink(link !== undefined && !path.isAbsolute(link) && contains(unit, path.resolve(path.dirname(source), link)) ? link : source, destination);
        };
        await place("");
        const siblingsIdentity = await linkSiblings(unit, view);
        // Carry private entries by copying, not moving: the old root stays
        // usable if copying, signing, cancellation or publication fails.
        const carried = privateCopyEntries(entries, owned);
        for (const relative of carried) {
          signal?.throwIfAborted();
          if (!relative) throw new Error("The graphics copy root is not a directory.");
          let parent = "";
          for (const part of relative.split(path.sep).slice(0, -1)) {
            parent = path.join(parent, part);
            const destination = path.join(view, parent), stat = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
            if (stat?.isSymbolicLink()) {
              // A newly aliased directory can have private descendants in the
              // old copy. Materialize its spine without writing through it.
              const source = await fs.promises.realpath(destination);
              if (!(await fs.promises.stat(source)).isDirectory()) throw new Error("A private graphics-copy file conflicts with the updated app: " + relative);
              await fs.promises.unlink(destination); await fs.promises.mkdir(destination);
              for (const child of await fs.promises.readdir(source)) {
                const key = path.join(parent, child), link = path.join(source, child);
                await fs.promises.symlink(link, path.join(view, key));
              }
            } else if (!stat) await fs.promises.mkdir(destination);
            else if (!stat.isDirectory()) throw new Error("A private graphics-copy file conflicts with the updated app: " + relative);
          }
          const destination = path.join(view, relative), existing = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
          if (existing && !existing.isSymbolicLink()) throw new Error("A private graphics-copy file conflicts with the updated app: " + relative);
          if (existing) await fs.promises.unlink(destination);
          if (entries[relative].link !== undefined) await fs.promises.symlink(entries[relative].link, destination);
          else await CopyFile.cloneOrCopy(path.join(root, relative), destination, { signal, exclusive: true });
        }
        const preserved = await preserveCopyChanges(root, stage, unit, entries, owned, signal);
        const removed = new Set();
        for (const [index, relative] of order.entries()) {
          const options = ["--force", "--sign", "-", "--timestamp=none", "--options", "0"];
          if (facts[index].entitlements) {
            const file = path.join(stage, "entitlements-" + index + ".plist");
            for (const key of await signedEntitlements(facts[index].entitlements, file, execute, signal)) removed.add(key);
            options.push("--entitlements", file);
          }
          await execute("/usr/bin/codesign", [...options, path.join(target, relative)], { signal, timeout: 60000, maxBuffer: 1024 * 1024 });
        }
        const copied = {};
        for (const relative of plan.real) copied[relative] = FileSignature.signature(await fs.promises.stat(path.join(target, relative)));
        const nextOwned = await copyEntries(view);
        for (const relative of Object.keys(nextOwned)) if (carried.some(parent => contains(parent, relative))) delete nextOwned[relative];
        // The source and the private data must still describe the inputs we
        // copied. In particular, do not discard writes made during signing.
        if (!isDeepStrictEqual(entries, await copyEntries(root)) || !isDeepStrictEqual(basis, await describeCopy(unit, plan)))
          throw new Error("The app or its private graphics-copy files changed during preparation; try Play again.");
        signal?.throwIfAborted();
        dropped = [...removed].sort();
        await publishCopyChanges(directory, preserved);
        const id = crypto.randomUUID(), previous = ".previous-" + id;
        writeJsonAtomic(path.join(directory, "copy-publication.json"), { id, previous, hadRoot: !!entries[""], receipt });
        try {
          if (entries[""]) await fs.promises.rename(root, path.join(directory, previous));
          await fs.promises.rename(view, root);
          writeJsonAtomic(receiptFile, { basis, copied, owned: nextOwned, siblingsIdentity, publicationId: id, ...(dropped.length ? { droppedEntitlements: dropped } : {}) });
        } catch (error) { await recoverCopy(directory); throw error; }
        await recoverCopy(directory).catch(error => console.warn("An earlier graphics copy could not be removed: " + error.message));
      } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
    }
    let real = null;
    try { real = fs.realpathSync(unit); } catch {}
    const prefixes = [...new Set([unit, real].filter(Boolean))];
    const map = value => {
      if (typeof value === "string") for (const prefix of prefixes) if (contains(prefix, value)) return copy + value.slice(prefix.length);
      return value;
    };
    // Only the executable needs the replacement signature. Data arguments,
    // cwd and environment remain exactly as the module supplied them.
    const launch = ({ command, args = [], options = {} }) => ({ command: map(command), args, options });
    return { app: copy, map, launch, droppedEntitlements: dropped };
  });
}
/** Releases an entirely derived copy; game-created or modified entries stay. */
function releaseCopy(directory, unit) {
  return serialized(directory, async () => {
    Writable.assertOwnDirectory(path.dirname(directory), directory, { create: false });
    await recoverCopy(directory);
    const receipt = readJsonObject(path.join(directory, "copy.json"));
    if (receipt?.basis?.unit !== path.resolve(unit)) return false;
    const entries = await copyEntries(path.join(directory, "root"));
    if (privateCopyEntries(entries, copyOwnership(receipt, entries), true).length ||
        (await fs.promises.readdir(directory)).some(name => name !== "root" && name !== "copy.json")) return false;
    await discardCopy(directory);
    return true;
  });
}

async function isolation(application) {
  let cache;
  try { cache = await require("./runtime/metal-cache").prepare({ identifier: application.identifier }); }
  catch (error) { console.warn("Native shader cache is unavailable: " + error.message); }
  return { readDirectories: [application.app], writeDirectories: cache?.writeDirectories || [],
    machServices: cache?.machServices || [], fileExtensions: { ...cache?.fileExtensions, read: [application.app] } };
}
module.exports = { prepare, isolation, bundleName, icns, plist, copyUnit, prepareCopy, releaseCopy };
