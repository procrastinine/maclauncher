const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const warn = require("../../shared/graphics-warning"), Streamline = require("./streamline");
const stamp = stat => stat && [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const watcher = Symbol("cameraGameViewRetirement");
const stat = file => {try {return fs.lstatSync(file);} catch (error) {if (error.code === "ENOENT") return null;throw error;}};
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const { cloneFiles, prepareClones } = require("../../shared/runtime/clone-file");
function clone(source, output, directory) {
  Writable.assertOwnDirectory(directory, path.dirname(output));
  const temporary = path.join(path.dirname(output), ".camera-copy-" + crypto.randomUUID());
  try {
    cloneFiles([[source, temporary]]);
    const info = fs.statSync(source);fs.chmodSync(temporary, info.mode | 0o600);fs.utimesSync(temporary, info.atime, info.mtime);
    fs.renameSync(temporary, output);
  } finally {fs.rmSync(temporary, {force: true});}
}
function relative(value) {
  if (typeof value !== "string" || path.isAbsolute(value) || /[\\\0]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".."))
    throw Error("The Windows game view contains an invalid file path.");
  return value;
}
function locations(directory, kind) {
  if (!["camera", "original"].includes(kind)) throw Error("The Windows game view is invalid.");
  return {root: path.join(directory, "temporal-" + kind), file: path.join(directory, "temporal-" + kind + ".json")};
}
function read(file) {
  const info = stat(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 ** 2) throw Error("The Windows game view record is unavailable.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.id || "") || !["camera", "original"].includes(value.kind) ||
      !path.isAbsolute(value.base || "") || !Array.isArray(value.directories) || !value.directories.includes("") || !value.entries || Array.isArray(value.entries)) throw Error("The Windows game view record is invalid.");
  for (const folder of value.directories) if (folder !== "") relative(folder);
  for (const [name, item] of Object.entries(value.entries)) {
    relative(name);
    if (!["file", "directory", "link"].includes(item?.kind) || !Array.isArray(item.base) || item.base.length !== 6 || !item.base.every(Number.isFinite) ||
        item.kind === "file" && (!Array.isArray(item.view) || item.view.length !== 6 || !item.view.every(Number.isFinite)) ||
        item.kind === "link" && item.link !== path.join(value.base, name)) throw Error("The Windows game view record is invalid.");
  }
  return value;
}
function save(directory, file, value) {Writable.atomicWrite(file, JSON.stringify(value) + "\n", {root: directory});}
// Only the small materialized camera/executable ancestor directories are
// reconciled. Unaffected directories link directly to the private game copy.
function reconcile(entry, context, directory, runtimeId) {
  const binding = entry.runtimeData?.[runtimeId]?.cameraGameView;
  if (!binding) return; // Never-used Off does no view discovery or filesystem IO.
  const clearBinding = () => {entry.runtimeData[runtimeId].cameraGameView = null;};
  context.signal?.throwIfAborted();
  const {root, file} = locations(directory, binding.kind), record = read(file), base = path.join(directory, "game");
  // A crash can persist the selected receipt before the library's new binding.
  // Preparing this stable view already required its predecessor to reconcile.
  if (record.id !== binding.id && !record.selected) {clearBinding();return;}
  if (record.base !== base) throw Error("The active Windows game view changed before its files could be preserved.");
  if (record.reconciled) {clearBinding();return;}
  Writable.assertOwnDirectory(directory, root, {create: false});Writable.assertOwnDirectory(directory, base, {create: false});
  const ignored = new Set(), adapterFiles = new Map();
  for (const library of record.adapters || []) {
    const name = relative(library.relativePath);
    const parent = path.dirname(name);
    for (const [role, identity, hash] of [["proxy", library.proxyIdentity, library.proxySha256], ["backup", library.backupIdentity, library.sourceSha256], ["record", library.recordIdentity, library.recordSha256]])
      if (Array.isArray(identity) && identity.length === 2 && identity.every(Number.isFinite)) adapterFiles.set(identity.join(":"), {role, hash, library});
    for (const [leaf, hashes] of [[name, [library.proxySha256, library.sourceSha256]],
      [path.join(parent, Streamline.ORIGINAL), [library.sourceSha256]], [path.join(parent, Streamline.RECORD), [library.recordSha256]]]) {
      try {const file = path.join(root, leaf), info = stat(file);if (info?.isFile() && !info.isSymbolicLink() && hashes.includes(digest(file))) ignored.add(leaf);} catch {}
    }
  }
  let conflicts = 0, conflictRoot;
  const preserveConflict = (from, name, link = false) => {
    conflictRoot ||= path.join(directory, "temporal-conflicts", crypto.randomUUID());
    const output = path.join(conflictRoot, relative(name) + (link ? ".symlink.json" : ""));
    Writable.assertOwnDirectory(directory, path.dirname(output));
    if (link) Writable.atomicWrite(output, JSON.stringify({path: name, target: fs.readlinkSync(from)}) + "\n", {root: directory});
    else fs.renameSync(from, output);
    conflicts++;return output;
  };
  const privateBase = fs.realpathSync(base), aliases = new Map();
  for (const row of Object.values(record.entries)) if (row.kind === "link" && Array.isArray(row.viewIdentity)) aliases.set(row.viewIdentity.join(":"), row);
  const aliasSource = (file, info) => {
    const owned = aliases.get([info.dev, info.ino].join(":"));
    if (!owned || fs.readlinkSync(file) !== owned.linkValue) return null;
    const canonical = fs.realpathSync(owned.link);
    if (!within(privateBase, canonical) || !fs.statSync(canonical).isDirectory()) throw Error("Windows game changes contain an unrecognized alias.");
    return canonical;
  };
  const sourceFile = (input, info) => {
    const owned = adapterFiles.get([info.dev, info.ino].join(":"));
    if (!owned || digest(input) !== owned.hash) return input;
    if (owned.role !== "proxy") return null;
    const row = owned.library;
    for (const candidate of [path.join(path.dirname(input), Streamline.ORIGINAL), path.join(base, row.relativePath), row.sourcePath]) {
      if (!candidate) continue;const value = stat(candidate);
      if (value?.isFile() && !value.isSymbolicLink() && digest(candidate) === row.sourceSha256) return candidate;
    }
    throw Error("The original Streamline library is unavailable while preserving Windows game changes.");
  };
  const snapshotTree = (from, target) => {
    const ancestors = new Set(), jobs = [];let files = 0;
    const visit = (input, output, depth = 0) => {
      context.signal?.throwIfAborted();if (depth > 64) throw Error("Windows game directories are too deeply nested.");
      const real = fs.realpathSync(input);if (ancestors.has(real)) throw Error("Windows game changes contain a cyclic alias.");ancestors.add(real);
      Writable.assertOwnDirectory(directory, output);
      for (const leaf of fs.readdirSync(input)) {
        const source = path.join(input, leaf), destination = path.join(output, leaf), info = stat(source);
        if (++files > 250000) throw Error("Windows game changes contain too many files.");
        if (info?.isFile() && !info.isSymbolicLink()) {const selected = sourceFile(source, info);if (selected) jobs.push([selected, destination]);}
        else if (info?.isDirectory() && !info.isSymbolicLink()) visit(source, destination, depth + 1);
        else if (info?.isSymbolicLink()) {
          const canonical = aliasSource(source, info);if (!canonical) throw Error("Windows game changes contain an unrecognized alias.");
          visit(canonical, destination, depth + 1);
        } else throw Error("Windows game changes must be regular files or directories.");
      }
      ancestors.delete(real);
    };
    visit(from, target);cloneFiles(jobs);
  };
  const directories = new Set(record.directories), byFolder = new Map(), changes = [], snapshots = [];
  for (const name of Object.keys(record.entries)) {const parent = path.dirname(name);if (!byFolder.has(parent)) byFolder.set(parent, []);byFolder.get(parent).push(path.basename(name));}
  for (const folder of [...directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    context.signal?.throwIfAborted();
    if (folder) relative(folder);
    const from = path.join(root, folder), info = stat(from);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue; // Its parent preserves a deletion/replacement.
    Writable.assertOwnDirectory(directory, from, {create: false});
    const names = new Set([...byFolder.get(folder || ".") || [], ...fs.readdirSync(from)]);
    for (const leaf of names) {
      context.signal?.throwIfAborted();
      const name = folder ? path.join(folder, leaf) : leaf;if (ignored.has(name)) continue;
      relative(name);const source = path.join(root, name), target = path.join(base, name), previous = record.entries[name], current = stat(source);
      if (directories.has(name) && current?.isDirectory() && !current.isSymbolicLink()) continue;
      if (current?.isSymbolicLink() && previous?.kind === "link" && path.resolve(path.dirname(source), fs.readlinkSync(source)) === previous.link) continue;
      if (current?.isFile() && previous?.kind === "file" && same(stamp(current), previous.view)) continue;
      if (!current && !previous) continue;
      changes.push({name, source, target, previous, current});
    }
  }
  try {
    // A renamed materialized directory can still contain aliases to the old
    // baseline parent. Complete its snapshot before deleting or replacing any referent.
    for (const row of changes) {
      const source = row.current?.isDirectory() && !row.current.isSymbolicLink() ? row.source : row.current?.isSymbolicLink() && aliasSource(row.source, row.current);
      if (!source) continue;
      row.snapshot = path.join(directory, ".camera-reconcile-" + crypto.randomUUID());snapshots.push(row.snapshot);snapshotTree(source, row.snapshot);
    }
    for (const row of [...changes.filter(row => row.current), ...changes.filter(row => !row.current)]) {
      context.signal?.throwIfAborted();const {name, source, target, previous, current} = row;
      Writable.assertOwnDirectory(directory, path.dirname(target));
      if (current?.isSymbolicLink() && !row.snapshot) {preserveConflict(source, name, true);continue;}
      const targetInfo = stat(target), unchanged = same(stamp(targetInfo), previous?.base || null);
      if (!current) {if (targetInfo && !unchanged) preserveConflict(target, name);else if (targetInfo) fs.rmSync(target, {recursive: targetInfo.isDirectory()});continue;}
      if (!current.isFile() && !current.isDirectory() && !row.snapshot) throw Error("Windows game changes must be regular files or directories.");
      let displaced;
      if (targetInfo && (!unchanged || targetInfo.isDirectory() || row.snapshot)) displaced = preserveConflict(target, name);
      try {
        // Retain launch files until the entire receipt commits, so retry cannot
        // mistake an already-moved save for a deletion after a later failure.
        if (row.snapshot) fs.renameSync(row.snapshot, target);else clone(source, target, directory);
      } catch (error) {
        if (displaced && !stat(target)) try {fs.renameSync(displaced, target);} catch {}
        throw error;
      }
    }
  } finally {for (const candidate of snapshots) try {fs.rmSync(candidate, {recursive: true, force: true});} catch {}}
  record.reconciled = true;record.selected = false;save(directory, file, record);clearBinding();
  if (conflicts) warn(context.logger, "Conflicting Windows game files were preserved separately.", conflictRoot);
}
function legacy(gameRoot, libraries) {
  const overrides = {}, omitted = new Set(), recovered = [];
  for (const row of libraries) {
    const name = relative(row.relativePath);let recorded, owned;
    try {recorded = Streamline.recorded({gameRoot, relativePath: name});owned = Streamline.ownership({gameRoot, relativePath: name});} catch {}
    if (!recorded || ![recorded.proxySha256, recorded.sourceSha256].includes(recorded.currentSha256)) continue;
    if (recorded.currentSha256 === recorded.proxySha256) {
      if (owned) overrides[name] = owned.original;
      else {
        const source = row.sourcePath, info = source && stat(source);
        if (!info?.isFile() || info.isSymbolicLink() || digest(source) !== recorded.sourceSha256)
          throw Error("The original Streamline library is unavailable. Restore the supplied game library before starting again.");
        overrides[name] = source;
      }
    }
    const parent = path.dirname(name);omitted.add(path.join(parent, Streamline.RECORD));
    if (owned) omitted.add(path.join(parent, Streamline.ORIGINAL));
    recovered.push(name);
  }
  return {overrides, omitted, libraries: recovered};
}
async function project(directory, base, executable, names, recovery, kind, signal) {
  signal?.throwIfAborted();const {root, file} = locations(directory, kind);
  Writable.assertOwnDirectory(directory, base, {create: false});
  const canonicalBase = fs.realpathSync(base);
  if (stat(root)) {
    Writable.assertOwnDirectory(directory, root, {create: false});const old = read(file);
    if (old.selected && !old.reconciled) throw Error("Windows game changes must be preserved before preparing another game view.");
    fs.rmSync(root, {recursive: true});
  }
  Writable.assertOwnDirectory(directory, root);
  const materialized = new Set([""]), copies = new Set([relative(executable), ...names.map(relative), ...Object.keys(recovery.overrides)]);
  for (const name of copies) for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) materialized.add(parent);
  const record = {schema: 1, id: crypto.randomUUID(), kind, base, directories: [...materialized], entries: {}, selected: false, reconciled: false, adapters: []}, copiesPending = [];
  const visit = folder => {
    signal?.throwIfAborted();const original = path.join(base, folder), destination = path.join(root, folder);
    Writable.assertOwnDirectory(directory, original, {create: false});Writable.assertOwnDirectory(directory, destination);
    for (const leaf of fs.readdirSync(original)) {
      signal?.throwIfAborted();const name = folder ? path.join(folder, leaf) : leaf;if (recovery.omitted.has(name)) continue;
      const input = path.join(base, name), output = path.join(root, name), info = stat(input);
      if (!info) continue;
      if (!within(canonicalBase, fs.realpathSync(input))) throw Error("A Windows game view cannot reference files outside its private game copy.");
      if (materialized.has(name)) {if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Windows camera directories must be private directories.");record.entries[name] = {kind: "directory", base: stamp(info)};visit(name);}
      else if (info.isFile() && !info.isSymbolicLink()) {
        // Clone immediate leaves without reading their bytes. Forced COW avoids
        // a second multi-GB game copy on filesystems without clone support.
        copiesPending.push([recovery.overrides[name] || input, output]);
        record.entries[name] = {kind: "file", base: stamp(info)};
      } else {
        if (copies.has(name)) throw Error("Windows camera inputs must be private regular files.");
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Windows game view assets must be private regular files or directories.");
        const linkValue = path.relative(path.dirname(output), input);fs.symlinkSync(linkValue, output, info.isDirectory() ? "dir" : "file");
        const link = stat(output);record.entries[name] = {kind: "link", base: stamp(info), link: input, linkValue, viewIdentity: [link.dev, link.ino]};
      }
    }
  };
  try {
    visit("");await prepareClones(copiesPending, signal);signal?.throwIfAborted();
    for (const [input, output] of copiesPending) {
      const info = fs.statSync(input);fs.chmodSync(output, info.mode | 0o600);fs.utimesSync(output, info.atime, info.mtime);
      record.entries[path.relative(root, output)].view = stamp(stat(output));
    }
    save(directory, file, record);
  }
  catch (error) {try {fs.rmSync(root, {recursive: true, force: true});} catch {}throw error;}
  return {gameRoot: root, executablePath: path.join(root, executable), binding: {schema: 1, kind, id: record.id}, record, file, directory};
}
async function baseline(entry, context, directory, gameRoot, executablePath, runtimeId, libraries) {
  const previous = entry.runtimeData?.[runtimeId], known = new Map(libraries.map(row => [row.relativePath, row]));
  for (const name of previous?.cameraLegacyLibraries || []) if (!known.has(name)) known.set(name, {relativePath: name, sourcePath: previous.sourceRoot && path.join(previous.sourceRoot, name)});
  const recovery = known.size ? legacy(gameRoot, [...known.values()]) : {overrides: {}, omitted: new Set(), libraries: []};
  const result = {gameRoot, executablePath, binding: null, recovery};
  if (Object.keys(recovery.overrides).length) Object.assign(result, await project(directory, gameRoot, path.relative(gameRoot, executablePath), [], recovery, "original", context.signal));
  return result;
}
function camera(directory, gameRoot, executablePath, plan, recovery, signal) {
  return project(directory, gameRoot, path.relative(gameRoot, executablePath), (plan.libraries || []).map(row => row.relativePath), recovery, "camera", signal);
}
function prepared(view, plan) {
  view.record.adapters = (plan.libraries || []).map(row => {
    const value = Streamline.ownership({gameRoot: view.gameRoot, relativePath: row.relativePath});
    if (!value) throw Error("The prepared camera library cannot be verified.");
    const identity = file => {const info = stat(file);return [info.dev, info.ino];};
    return {relativePath: row.relativePath, sourcePath: row.sourcePath, sourceSha256: value.sourceSha256, proxySha256: value.proxySha256,
      recordSha256: digest(value.record), proxyIdentity: identity(value.target), backupIdentity: identity(value.original), recordIdentity: identity(value.record)};
  });save(view.directory, view.file, view.record);
}
// Retain the small unselected/completed receipt even if setup failed. A library
// write interrupted before publication may still refer to the older generation.
function discard(view) {if (!view) return;try {fs.rmSync(view.gameRoot, {recursive: true, force: true});} catch {}}
function remember(entry, context, runtimeId, view, recovery) {
  if (view.binding && !view.record.selected) {view.record.selected = true;save(view.directory, view.file, view.record);}
  entry.runtimeData = {...entry.runtimeData, [runtimeId]: {...entry.runtimeData?.[runtimeId], cameraGameView: view.binding, cameraLegacyLibraries: recovery.libraries}};
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
        warn(context.logger, "Windows game changes remain in their private launch view and will be preserved before the next Play.", error.message);
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
module.exports = {reconcile, baseline, camera, prepared, discard, remember, clearWatch, watch};
