// Backcompat: v0.5.1 CrossOver local-<app hash>-<template> bottles and
// Sikarugir <engine/digest hash>-<Windows version> prefixes.
// Adopt once per game during the settings-backed migration, never Play/import/upkeep.
// Remove when supported profiles no longer contain these released environment keys.
const fs = require("node:fs"), path = require("node:path");
const Writable = require("../../shared/writable-input");
const LIMIT = 512;
const layouts = [
  {runtimeId: "crossover", folder: "bottles", field: "bottlePath", legacy: /^local-[a-f0-9]{16}-(win11_64|win10_64|win7_64|winxp_64)$/, stable: /^(win11_64|win10_64|win7_64|winxp_64)$/, marker: "cxbottle.conf"},
  {runtimeId: "sikarugir", folder: "prefixes", field: "prefixPath", legacy: /^[a-f0-9]{20}-(win11|win10|win7|winxp)$/, stable: /^(win11|win10|win7|winxp)$/, marker: "maclauncher-prefix.json"}
];
function stat(file) {try {return fs.lstatSync(file);} catch (error) {if (error.code === "ENOENT") return null;throw error;}}
function activity(directory, marker) {
  for (const name of ["user.reg", marker]) {
    const info = stat(path.join(directory, name));
    if (info?.isFile() && !info.isSymbolicLink() && Number.isFinite(info.mtimeMs) && info.mtimeMs > 0) return info.mtimeMs;
  }
  return null;
}
function collect(entry, context, layout) {
  const launch = layout.runtimeId === "crossover" ? require("../runtime/launch") : require("../sources/wine-launch").forSource(layout.runtimeId);
  const directory = launch.runtimeDirectory(entry, context), parent = path.join(directory, layout.folder);
  Writable.assertPreservesExternalEnvironments(entry, parent);
  Writable.assertOwnDirectory(context.userDataDir, parent, {create: false});
  const folder = stat(parent);
  if (!folder) return [];
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error("The folder of earlier Windows environments at " + parent + " is a symbolic link or not a folder, so they were left in place. Copy any needed files from them before removing the game.");
  const groups = new Map(), stream = fs.opendirSync(parent);
  try {
    let leaf, count = 0;
    while ((leaf = stream.readSync())) {
      if (++count > LIMIT) throw Error("The folder of earlier Windows environments at " + parent + " has too many entries to move them automatically, so they were left in place. Copy any needed files from them before removing the game.");
      const old = layout.legacy.exec(leaf.name), stable = layout.stable.exec(leaf.name);
      if (!old && !stable) continue;
      const key = (old || stable)[1], file = path.join(parent, leaf.name);
      const group = groups.get(key) || {layout, parent, key, target: path.join(parent, key), candidates: []};
      if (old) group.candidates.push({file, info: stat(file)});
      groups.set(key, group);
    }
  } finally {stream.closeSync();}
  return [...groups.values()];
}
function select(entry, group) {
  const target = stat(group.target);
  if (target) {
    if (!target.isDirectory() || target.isSymbolicLink()) throw Error("The current Windows environment at " + group.target + " is a symbolic link or not a folder, so the earlier environments were left in place. Copy any needed files from them before removing the game.");
    return null;
  }
  for (const row of group.candidates) if (!row.info?.isDirectory() || row.info.isSymbolicLink())
    throw Error("The earlier Windows environment at " + row.file + " is a symbolic link or not a folder, so it was left in place. Copy any needed files from it before removing the game.");
  const value = entry.runtimeData?.[group.layout.runtimeId]?.[group.layout.field];
  const recorded = typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
  const chosen = group.candidates.find(row => row.file === recorded);
  if (chosen) return chosen;
  for (const row of group.candidates) row.time = activity(row.file, group.layout.marker);
  if (group.candidates.some(row => row.time === null)) throw Error("MacLauncher could not tell which earlier Windows environment was used last, so these were left in place: " + group.candidates.map(row => row.file).join(", ") + ". Copy any needed files from them before removing the game.");
  const ordered = [...group.candidates].sort((a, b) => b.time - a.time);
  if (ordered.length > 1 && ordered[0].time === ordered[1].time)
    throw Error("These earlier Windows environments were last used at the same time, so MacLauncher could not choose one and left them in place: " + ordered.map(row => row.file).join(", ") + ". Copy any needed files from them before removing the game.");
  return ordered[0] || null;
}
function assertRelocatable(directory) {
  const drives = path.join(directory, "dosdevices"), info = stat(drives);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("The drive letter folder at " + drives + " is a symbolic link or not a folder, so the earlier Windows environment was left in place. Copy any needed files from it before removing the game.");
  const stream = fs.opendirSync(drives);
  try {
    let leaf, count = 0;
    while ((leaf = stream.readSync())) {
      if (++count > LIMIT) throw Error("The drive letter folder at " + drives + " has too many entries to check automatically, so the earlier Windows environment was left in place. Copy any needed files from it before removing the game.");
      const file = path.join(drives, leaf.name), link = stat(file);
      if (!link?.isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target) && (target === directory || target.startsWith(directory + path.sep)))
        throw Error("The drive letter at " + file + " points into the earlier Windows environment by its full path and would break if the environment moved, so it was left in place. Copy any needed files from it before removing the game.");
    }
  } finally {stream.closeSync();}
}
function remapFields(entry, moves) {
  const patch = {}, remap = value => {
    if (typeof value !== "string" || !path.isAbsolute(value)) return value;
    for (const move of moves) if (value === move.from || value.startsWith(move.from + path.sep))
      return path.join(move.to, path.relative(move.from, value));
    return value;
  };
  for (const key of ["defaultSaveDir", "saveDirOverride"]) if (remap(entry[key]) !== entry[key]) patch[key] = remap(entry[key]);
  if (Array.isArray(entry.saveLocations)) {
    const rows = entry.saveLocations.map(row => row && typeof row === "object" && remap(row.directory) !== row.directory ? {...row, directory: remap(row.directory)} : row);
    if (rows.some((row, index) => row !== entry.saveLocations[index])) patch.saveLocations = rows;
  }
  return patch;
}
function migrateLegacyGameData(entry, {userDataDir} = {}) {
  if (!entry?.gameId) return {complete: true};
  let groups;
  try {
    groups = layouts.flatMap(layout => collect(entry, {userDataDir}, layout));
    // Decide ambiguous groups before changing a path. Recorded last use
    // outranks timestamps, including an intentionally empty prefix.
    for (const group of groups) {group.chosen = select(entry, group);if (group.chosen) assertRelocatable(group.chosen.file);}
  } catch (error) {
    const reason = String(error.message || error);
    const retained = (groups || []).flatMap(group => group.candidates.map(row => ({runtimeId: group.layout.runtimeId, path: row.file, reason})));
    return {complete: false, reason, ...(retained.length ? {retained} : {})};
  }
  const runtimeData = {}, moves = [], blocked = [], retainedProfiles = [];
  for (const group of groups) {
    const {layout, target, chosen} = group;
    const data = runtimeData[layout.runtimeId] ||= {...entry.runtimeData?.[layout.runtimeId]};
    const value = entry.runtimeData?.[layout.runtimeId]?.[layout.field];
    const recorded = typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
    try {
      if (chosen) {
        Writable.assertOwnDirectory(userDataDir, group.parent, {create: false});
        const current = stat(chosen.file);
        if (!current?.isDirectory() || current.isSymbolicLink() || current.ino !== chosen.info.ino || current.dev !== chosen.info.dev)
          throw Error("The earlier Windows environment at " + chosen.file + " changed before it could be moved, so it was left in place. Copy any needed files from it before removing the game.");
        // A concurrently created stable environment wins. rename never merges
        // directories; a nonempty destination also makes the filesystem refuse it.
        if (!stat(target)) {fs.renameSync(chosen.file, target);moves.push({from: chosen.file, to: target});}
      }
      const adopted = stat(target);
      if (!adopted?.isDirectory() || adopted.isSymbolicLink()) throw Error("The Windows environment at " + target + " is missing or not a folder after the move, so the earlier environments were left in place. Copy any needed files from them before removing the game.");
      if (group.candidates.some(row => row.file === recorded) || recorded === target ||
          !recorded && group.key === (layout.runtimeId === "crossover" ? "win10_64" : "win10")) data[layout.field] = target;
      const retained = group.candidates.filter(row => stat(row.file)).map(row => ({path: row.file, reason: "This earlier Windows environment was kept separately from the game's current one, and its files were not merged. Copy any needed files from it before removing the game."}));
      retainedProfiles.push(...retained.map(row => ({runtimeId: layout.runtimeId, ...row})));
      if (retained.length) data.retainedWindowsProfiles = [...(data.retainedWindowsProfiles || []), ...retained];
    } catch (error) {
      const reason = String(error.message || error), retained = group.candidates.map(row => ({path: row.file, reason, blocked: true}));
      blocked.push(...retained.map(row => ({runtimeId: layout.runtimeId, ...row})));
      retainedProfiles.push(...retained.map(row => ({runtimeId: layout.runtimeId, ...row})));
      data.retainedWindowsProfiles = [...(data.retainedWindowsProfiles || []), ...retained];
    }
    // A later group failure must not strand saved paths after an earlier
    // successful rename. Persist every actual move even on partial adoption.
    const move = moves.find(row => row.from === recorded);
    if (move) data[layout.field] = move.to;
    if (data.retainedWindowsProfiles) data.retainedWindowsProfiles = data.retainedWindowsProfiles.filter((row, index, rows) => rows.findIndex(other => other.path === row.path) === index);
  }
  if (blocked.length && !moves.length) return {complete: false, retained: retainedProfiles, reason: blocked.map(row => row.reason + " (" + row.path + ")").join("; ")};
  return {complete: true, ...(retainedProfiles.length ? {retained: retainedProfiles} : {}),
    ...(Object.keys(runtimeData).length ? {entryPatch: {...remapFields(entry, moves), runtimeData: {...entry.runtimeData, ...runtimeData}}} : {})};
}
module.exports = {migrateLegacyGameData};
