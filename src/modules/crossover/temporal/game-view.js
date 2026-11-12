const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const warn = require("../../shared/graphics-warning"), Streamline = require("./streamline");
const adapterFor = row => require("./index").libraryAdapter(row);
const stamp = stat => stat && [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const watcher = Symbol("cameraGameViewRetirement");
const stat = file => {try {return fs.lstatSync(file);} catch (error) {if (error.code === "ENOENT") return null;throw error;}};
const coarse = identity => identity && identity[4] % 1000 === 0;
function digest(file, signal) {
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), fd = fs.openSync(file, "r");
  try {let bytes;do {signal?.throwIfAborted();bytes = fs.readSync(fd, buffer, 0, buffer.length, null);if (bytes) hash.update(buffer.subarray(0, bytes));} while (bytes);return hash.digest("hex");}
  finally {fs.closeSync(fd);}
}
const { cloneOrCopy } = require("../../shared/copy-file");
function relative(value) {
  if (typeof value !== "string" || path.isAbsolute(value) || /[\\\0]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".."))
    throw Error("The Windows game view contains an invalid file path.");
  return value;
}
// Each game has one launch folder per Windows source, at a fixed path. Every
// Play replaces it, so it keeps one Windows drive letter and never accumulates.
const LAUNCH_FOLDER = "launch-folder";
// Earlier versions created a new temporal-camera-<id> folder and a
// new drive letter on every Play. The next Play removes them.
const EARLIER_GENERATION = /^temporal-camera-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function locations(directory, kind, generation) {
  if (kind !== "camera" || !/^[a-f0-9-]{36}$/.test(generation || "")) throw Error("The Windows camera generation is invalid.");
  return {root: path.join(directory, LAUNCH_FOLDER), file: path.join(directory, LAUNCH_FOLDER + ".json")};
}
// Removes the previous launch folder and the per-Play folders of earlier
// versions. Their links point at the original game files and are removed as
// links; nothing outside this runtime directory is read or changed.
function retire(directory) {
  if (!stat(directory)) return;
  Writable.assertOwnDirectory(directory, directory, {create: false});
  const names = fs.readdirSync(directory).filter(name => name === LAUNCH_FOLDER || EARLIER_GENERATION.test(name));
  for (const name of names) {
    const root = path.join(directory, name), info = stat(root);
    if (info?.isDirectory() && !info.isSymbolicLink()) fs.rmSync(root, {recursive: true, force: true});
    else if (info) fs.unlinkSync(root);
    const file = root + ".json";if (stat(file)?.isFile()) fs.unlinkSync(file);
  }
}
// Frees the Windows drive letters that earlier versions gave each per-Play
// folder of this runtime directory. Other drive mappings are left unchanged.
function releaseEarlierDrives(prefixPath, directory) {
  const dosdevices = path.join(prefixPath, "dosdevices"), owner = stat(directory) && fs.realpathSync(directory);
  if (!owner || !stat(dosdevices)) return;
  Writable.assertOwnDirectory(prefixPath, dosdevices, {create: false});
  const real = fs.realpathSync(dosdevices);
  for (const letter of fs.readdirSync(dosdevices)) {
    if (!/^[a-z]:$/.test(letter)) continue;
    const mapping = path.join(dosdevices, letter);
    if (!stat(mapping)?.isSymbolicLink()) continue;
    const target = path.resolve(real, fs.readlinkSync(mapping));
    if (path.dirname(target) === owner && EARLIER_GENERATION.test(path.basename(target))) fs.unlinkSync(mapping);
  }
}
function read(file) {
  const info = stat(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 ** 2) throw Error("The Windows game view record is unavailable.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.id || "") || (value.kind !== "camera" || value.originalSource !== true) ||
      !path.isAbsolute(value.base || "") || !Array.isArray(value.directories) || !value.directories.includes("") || !value.entries || Array.isArray(value.entries)) throw Error("The Windows game view record is invalid.");
  for (const folder of value.directories) if (folder !== "") relative(folder);
  for (const [name, item] of Object.entries(value.entries)) {
    relative(name);
    if (!["file", "directory", "link"].includes(item?.kind) || !Array.isArray(item.base) || item.base.length !== 6 || !item.base.every(Number.isFinite) ||
        item.kind === "file" && (!Array.isArray(item.view) || item.view.length !== 6 || !item.view.every(Number.isFinite)) ||
        [item.baseSha256, item.viewSha256].some(hash => hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) ||
        item.kind === "link" && item.link !== path.join(value.base, name)) throw Error("The Windows game view record is invalid.");
  }
  return value;
}
function save(directory, file, value) {Writable.atomicWrite(file, JSON.stringify(value) + "\n", {root: directory});}
// Retire only the current original-source generation. Aliases already write
// through to originals; new executable-relative files remain in this generation.
function reconcile(entry, context, directory, runtimeId) {
  const binding = entry.runtimeData?.[runtimeId]?.cameraGameView;
  if (!binding?.generation) return;
  context.signal?.throwIfAborted();
  const {root, file} = locations(directory, binding.kind, binding.id), record = read(file);
  if (record.id !== binding.id) throw Error("The Windows camera generation changed.");
  Writable.assertOwnDirectory(directory, root, {create: false});
  record.reconciled = true;record.selected = false;record.retained = true;
  save(directory, file, record);entry.runtimeData[runtimeId].cameraGameView = null;
}
async function project(directory, base, executable, names, kind, signal) {
  signal?.throwIfAborted();Writable.assertOwnDirectory(directory, directory);
  const canonicalBase = fs.realpathSync(base);
  if (within(fs.realpathSync(directory), canonicalBase)) throw Error("Windows camera inputs must use the original game folder.");
  const id = crypto.randomUUID(), {root, file} = locations(directory, kind, id);
  if (stat(root) || stat(file)) throw Error("The Windows camera generation already exists.");
  Writable.assertOwnDirectory(directory, root);
  const materialized = new Set([""]), copies = new Set([relative(executable), ...names.map(relative)]);
  for (const name of copies) for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) materialized.add(parent);
  const record = {schema: 1, id, kind, base, originalSource: true, directories: [...materialized], entries: {}, selected: false, reconciled: false, adapters: []}, copiesPending = [];
  const visit = folder => {
    signal?.throwIfAborted();const original = path.join(base, folder), destination = path.join(root, folder);
    Writable.assertOwnDirectory(directory, destination);
    for (const leaf of fs.readdirSync(original)) {
      signal?.throwIfAborted();const name = folder ? path.join(folder, leaf) : leaf;
      const input = path.join(base, name), output = path.join(root, name), info = stat(input);
      if (!info) continue;
      if ((copies.has(name) || materialized.has(name)) && !within(canonicalBase, fs.realpathSync(input))) throw Error("Windows camera code must stay inside its selected game folder.");
      if (materialized.has(name)) {if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Windows camera directories must be private directories.");record.entries[name] = {kind: "directory", base: stamp(info)};visit(name);}
      else if (info.isFile() && !info.isSymbolicLink() && copies.has(name)) {
        // An original-source adapter copies only its executable and selected
        // DLLs. Other assets keep their ordinary original bytes and writes.
        copiesPending.push([input, output]);
        record.entries[name] = {kind: "file", base: stamp(info)};
      } else {
        if (copies.has(name)) throw Error("Windows camera inputs must be private regular files.");
        if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) throw Error("Windows camera assets must be regular files or directories.");
        const linkValue = input;fs.symlinkSync(linkValue, output, info.isDirectory() ? "dir" : "file");
        const link = stat(output);record.entries[name] = {kind: "link", base: stamp(info), link: input, linkValue, viewIdentity: [link.dev, link.ino]};
      }
    }
  };
  try {
    visit("");for (const [input, output] of copiesPending) await cloneOrCopy(input, output, {signal, exclusive: true});signal?.throwIfAborted();
    for (const [input, output] of copiesPending) {
      const info = fs.statSync(input);fs.chmodSync(output, info.mode | 0o600);fs.utimesSync(output, info.atime, info.mtime);
      const name = path.relative(root, output), item = record.entries[name];item.view = stamp(stat(output));
      if (coarse(item.base) || coarse(item.view)) {
        signal?.throwIfAborted();item.baseSha256 = digest(path.join(base, name), signal);item.viewSha256 = digest(output, signal);
      }
    }
    save(directory, file, record);
  }
  catch (error) {try {fs.rmSync(root, {recursive: true, force: true});} catch {}throw error;}
  return {gameRoot: root, executablePath: path.join(root, executable), binding: {schema: 1, kind, id: record.id, generation: true}, record, file, directory};
}
// plan.programs names further executables that load the camera libraries,
// such as the program an Unreal bootstrap declares; they are copied like the
// selected executable.
function camera(directory, gameRoot, executablePath, plan, _recovery, signal) {
  return project(directory, gameRoot, path.relative(gameRoot, executablePath),
    [...(plan.libraries || []).map(row => row.relativePath), ...(plan.programs || [])], "camera", signal);
}
function prepared(view, plan) {
  view.record.adapters = (plan.libraries || []).map(row => {
    const value = adapterFor(row).ownership({gameRoot: view.gameRoot, relativePath: row.relativePath});
    if (!value) throw Error("The prepared camera library cannot be verified.");
    const identity = file => {const info = stat(file);return [info.dev, info.ino];};
    return {adapter: row.adapter || (adapterFor(row) === Streamline ? "streamline" : path.basename(row.relativePath).toLowerCase() === "libxess_dx11.dll" ? "xess" : "fidelityfx"), relativePath: row.relativePath, sourcePath: row.sourcePath, sourceSha256: value.sourceSha256, proxySha256: value.proxySha256,
      recordSha256: digest(value.record), proxyIdentity: identity(value.target), backupIdentity: identity(value.original), recordIdentity: identity(value.record)};
  });save(view.directory, view.file, view.record);
}
// An unused or failed launch folder stays until the next Play replaces it.
function discard(_view) {}
function remember(entry, context, runtimeId, view) {
  if (view.binding && !view.record.selected) {view.record.selected = true;save(view.directory, view.file, view.record);}
  entry.runtimeData = {...entry.runtimeData, [runtimeId]: {...entry.runtimeData?.[runtimeId], cameraGameView: view.binding}};
}
// Camera and scene adapters share one launch folder under the game's runtime
// directory. Each plan's proxy is written only into that folder, and the
// original game folder is never changed. A plan that cannot be prepared is left
// out, and the game keeps that API's original library. A library that cannot
// be restored stays inside the unused launch folder, so Play continues from the
// original folder; only cancellation stops it.
async function prepareLaunchFolder(entry, context, { runtimeId, label, directory, originalRoot, executable, executableArchitecture, plans }) {
  const stop = error => context.signal?.aborted || require("../../shared/runtime/download-utils").isAbortError(error);
  let view = null;
  try {
    const program = require("../runtime/steam-bridge-launch").declaredProgram(executable, originalRoot, executableArchitecture);
    retire(directory);
    view = await camera(directory, originalRoot, executable, { libraries: plans.flatMap(item => item.plan.libraries), programs: program ? [program] : [] }, null, context.signal);
    const ready = new Set(), libraries = [];
    for (const item of plans) {
      try { if (require("./index").prepareGame(item.plan, view.gameRoot, context.signal)) { ready.add(item.kind); libraries.push(...item.plan.libraries); } }
      catch (error) { if (stop(error)) throw error; warn(context.logger, `${label} temporal integration could not be prepared. Using its original game API.`, error.message); }
    }
    if (libraries.length) {
      prepared(view, { libraries }); remember(entry, context, runtimeId, view);
      return { ready, view, gameRoot: view.gameRoot, executablePath: view.executablePath };
    }
    // A plan with no game library to replace runs from the original folder.
    discard(view);
    return { ready, view: null, gameRoot: originalRoot, executablePath: executable };
  } catch (error) {
    discard(view);
    if (stop(error)) throw error;
    warn(context.logger, `${label} temporal integration could not be prepared. Using the selected graphics backend.`, error?.message || String(error));
  }
  return { ready: new Set(), view: null, gameRoot: originalRoot, executablePath: executable };
}
function clearWatch(context) {
  const previous = context[watcher];if (!previous) return;
  if (context.onProcessSpawn === previous.onSpawn) context.onProcessSpawn = previous.originalOnSpawn;
  if (context.spawnDetachedChecked === previous.spawn) context.spawnDetachedChecked = previous.originalSpawn;
  delete context[watcher];
}
function watch(entry, context, directory, runtimeId, view) {
  clearWatch(context);if (!view.binding) return;
  const attached = new WeakSet(), binding = view.binding, marker = "maclauncher-" + runtimeId;
  const supervised = (command, args) => command === "/bin/sh" && args?.[0] === "-c" && args[2] === marker;
  const attach = child => {
    if (!child || attached.has(child)) return;attached.add(child);let finished = false;
    const finish = () => {
      if (finished) return;finished = true;
      if (entry.runtimeData?.[runtimeId]?.cameraGameView?.id !== binding.id) return;
      try {
        // Stop's signal is cancelled, but the completed Wine supervisor has
        // retired all children. Preserve portable writes before lease release.
        reconcile(entry, {...context, signal: undefined}, directory, runtimeId);
        delete entry.runtimeData[runtimeId].cameraViewRecoveryFailure;
      } catch (error) {
        entry.runtimeData[runtimeId].cameraViewRecoveryFailure = String(error.message || error);
        warn(context.logger, "Files the game wrote beside its adapted executable remain in its launch folder until the next Play replaces it.", error.message);
      }
      try {context.onEntryChange?.(entry)?.catch?.(() => {});} catch {}
    };
    for (const event of ["exit", "close"]) (child.prependOnceListener || child.once).call(child, event, finish);
    if (child.exitCode != null || child.signalCode != null) finish();
  };
  const originalOnSpawn = context.onProcessSpawn, originalSpawn = context.spawnDetachedChecked;
  const onSpawn = async child => {if (supervised(child?.spawnfile, child?.spawnargs?.slice(1))) attach(child);return originalOnSpawn?.(child);};
  const spawn = typeof originalSpawn === "function" ? async (...args) => {const child = await originalSpawn(...args);if (supervised(args[0], args[1])) attach(child);return child;} : originalSpawn;
  context[watcher] = {originalOnSpawn, originalSpawn, onSpawn, spawn};context.onProcessSpawn = onSpawn;
  if (spawn) context.spawnDetachedChecked = spawn;
}
module.exports = {reconcile, camera, prepared, discard, remember, clearWatch, watch, prepareLaunchFolder, retire, releaseEarlierDrives};
