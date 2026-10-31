const fs = require("node:fs");
const path = require("node:path");
const GameAvailability = require("./game-availability");
const GameStore = require("./game-store");
const GameData = require("../modules/shared/game-data");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { randomUUID, createHash } = require("node:crypto");
const { assertOwnDirectory, atomicWrite } = require("../modules/shared/writable-input");
const { resolveModuleId } = require("./launcher");

// Locate… points a library game at the new location of its files. The import's
// detection runs there, and only the game's own type is accepted. The record
// keeps its game ID, so everything stored under that ID stays with the game.

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") ? path.resolve(value) : null;
const S_IFMT = 0o170000, S_IFDIR = 0o040000;

function relocationError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

// Absolute paths inside the old root follow the game to its new root, such as
// a save folder override or a chosen executable. Names and notes are text.
function rebasePaths(value, from, to, depth = 0, references) {
  if (typeof value === "string") {
    if (references?.has(value)) return references.get(value);
    const file = absolute(value);
    return file && from && inside(from, file) ? path.join(to, path.relative(from, file)) : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 256) throw new Error("The stored document is too deeply nested to relocate safely.");
  if (Array.isArray(value)) return value.map(item => rebasePaths(item, from, to, depth + 1, references));
  const entries = Object.entries(value).map(([key, item]) => [rebasePaths(key, from, to, 0, references), rebasePaths(item, from, to, depth + 1, references)]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Relocated record keys would overlap.");
  return Object.fromEntries(entries);
}
function rebaseRecord(entry, from, to) {
  if (from === to) return { ...entry };
  const { name, notes, ...rest } = entry;
  return { ...rebasePaths(rest, from, to), ...(name !== undefined ? { name } : {}), ...(notes !== undefined ? { notes } : {}) };
}

// Folders whose contents belong to the game or its runtime rather than to the
// launcher: saves, snapshots and logs; browser partitions, runtime profiles,
// Windows prefixes and private home folders; and private, unpacked, extracted
// or exported copies of the game's files. Locate does not walk into them. A
// record the launcher keeps at the top of such a folder, such as an extraction
// receipt, has "maclauncher" in its name, and only those are read there.
const GAME_OWNED_FOLDERS = new Set(["saves", "save-snapshots", "logs", "partition", "profiles", "prefixes", "bottles", "home",
  "files", "extracted", "game", "play", "drive-c", "app0", "appimage", "mono-projects", "source-projects", "assets", "exports", "decompiled"]);
const RECORD_LIMIT = 32 * 1024 ** 2; // the largest record a launcher reader accepts
const BACKUPS = ".relocation-backups", MARKER = ".in-progress.json", AFTER = ".after-relocation", PARTIAL = ".relocation-partial";

function restoreOriginals(originals, userDataDir) {
  for (const { file, backup } of originals) {
    try { fs.renameSync(file, backup + AFTER); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (fs.lstatSync(backup).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(backup), file);
    else atomicWrite(file, fs.readFileSync(backup), { root: userDataDir });
  }
}
function backedUp(root, backupRoot, directory = backupRoot, found = []) {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    const backup = path.join(directory, child.name);
    if (child.isDirectory()) backedUp(root, backupRoot, backup, found);
    else if (!child.name.endsWith(AFTER) && !child.name.endsWith(PARTIAL)) found.push({ file: path.join(root, path.relative(backupRoot, backup)), backup });
  }
  return found;
}
function backupNames(root) {
  try { assertOwnDirectory(root, path.join(root, BACKUPS), { create: false }); return fs.readdirSync(path.join(root, BACKUPS)); } catch { return []; }
}

// Launcher receipts can live beside extracted files. Rewrite their JSON paths
// together rather than teaching Locate about each module's receipt format.
// Links into the old root move the same way, so a prepared output never
// records the new root while it still reads the old one. Original bytes and
// links are kept, and a failure part-way restores them. Before the first
// change, a marker beside the backups names the move, so an interrupted
// relocation is finished or undone at the next start.
function rebaseStoredRecords({ userDataDir, gameId, from, to, moves = [{ from, to }] }) {
  const root = GameData.resolveGameDir(userDataDir, gameId);
  assertOwnDirectory(userDataDir, root, { create: false });
  const id = randomUUID(), backupRoot = path.join(root, BACKUPS, id), marker = backupRoot + MARKER;
  const originals = [];
  const result = { rewritten: [],
    restore() { restoreOriginals(originals, userDataDir); fs.rmSync(marker, { force: true }); },
    // After a complete relocation, only its own backups are kept.
    commit() {
      fs.rmSync(marker, { force: true });
      for (const name of backupNames(root)) if (name !== id) fs.rmSync(path.join(root, BACKUPS, name), { recursive: true, force: true });
    } };
  if (moves.every(move => move.from === move.to)) return result;
  const documents = [], links = [], record = GameData.resolveGameDataPath(userDataDir, gameId);
  const rebase = value => moves.reduce((value, move) => rebasePaths(value, move.from, move.to), value);
  // A file that is not valid JSON, or whose keys would overlap, stays
  // byte-for-byte unchanged; its reader sees it as before.
  function read(file) {
    let bytes, value, next;
    try { if (fs.lstatSync(file).size > RECORD_LIMIT) return; bytes = fs.readFileSync(file, "utf8"); value = JSON.parse(bytes); next = rebase(value); } catch { return; }
    documents.push({ file, bytes, value, next });
  }
  function visit(directory, owned) {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, child.name);
      if (owned) { if (child.isFile() && child.name.includes("maclauncher") && child.name.endsWith(".json")) read(file); }
      else if (child.isDirectory()) { if (child.name !== BACKUPS) visit(file, GAME_OWNED_FOLDERS.has(child.name)); }
      // No link is followed. One that points into the old root is replaced by
      // a link to the same place in the new root; others stay as they are.
      else if (child.isSymbolicLink()) {
        const target = path.resolve(directory, fs.readlinkSync(file)), next = rebase(target);
        if (next !== target) links.push({ file, next });
      } else if (child.isFile() && child.name.endsWith(".json") && file !== record) read(file);
    }
  }
  visit(root, false);
  // A name that carries the SHA-256 of its own bytes is a content address.
  // Such a receipt keeps its name and bytes: the new document is published
  // under its own address, and references to it in the other records are
  // updated, so the ordinary reader keeps its checksum verification.
  const sha = bytes => createHash("sha256").update(bytes).digest("hex"), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const references = new Map(), published = [], rewrites = [];
  for (const document of documents) {
    const name = path.basename(document.file), address = name.match(/^(.*?)([a-f0-9]{64})(\.json)$/);
    if (!address || sha(document.bytes) !== address[2] || same(document.value, document.next)) continue;
    const bytes = JSON.stringify(document.next, null, 2), file = path.join(path.dirname(document.file), address[1] + sha(bytes) + address[3]);
    references.set(name, path.basename(file)); references.set(document.file, file);
    published.push({ file, bytes }); document.addressed = true;
  }
  for (const document of documents) {
    if (document.addressed) continue;
    let next;
    try { next = rebasePaths(document.next, null, null, 0, references); } catch { continue; }
    if (!same(document.value, next)) rewrites.push({ file: document.file, next });
  }
  if (!published.length && !links.length && !rewrites.length) return result;
  function preserve(file, move) {
    const backup = path.join(backupRoot, path.relative(root, file));
    assertOwnDirectory(root, path.dirname(backup));
    if (move) fs.renameSync(file, backup);
    else { fs.copyFileSync(file, backup + PARTIAL); fs.renameSync(backup + PARTIAL, backup); }
    originals.push({ file, backup });
  }
  try {
    assertOwnDirectory(root, backupRoot);
    writeJsonAtomic(marker, { moves });
    for (const { file, bytes } of published) if (!fs.existsSync(file)) { atomicWrite(file, bytes, { root: userDataDir }); result.rewritten.push(file); }
    for (const { file, next } of links) { preserve(file, true); fs.symlinkSync(next, file); result.rewritten.push(file); }
    for (const { file, next } of rewrites) { preserve(file, false); writeJsonAtomic(file, next); result.rewritten.push(file); }
  } catch (error) {
    result.restore();
    throw error;
  }
  return result;
}

// Runs at start, before any game's records are used. A relocation interrupted
// while the record still names the old root is undone from its backups; one
// interrupted after the record was saved has finished and only loses its
// marker. Resolves to the game IDs whose recovery failed.
function recoverInterruptedRelocations(userDataDir) {
  const failed = [];
  for (const gameId of GameStore.listGameIds(userDataDir)) {
    const root = GameData.resolveGameDir(userDataDir, gameId);
    for (const name of backupNames(root).filter(name => name.endsWith(MARKER))) {
      try {
        const marker = path.join(root, BACKUPS, name), moves = readJsonObject(marker)?.moves, record = GameStore.readGameRecord(userDataDir, gameId);
        if (!record || !Array.isArray(moves) || !absolute(moves[0]?.from)) continue;
        if (GameAvailability.rootPath(record, { userDataDir }) === absolute(moves[0].from)) {
          restoreOriginals(backedUp(root, marker.slice(0, -MARKER.length)), userDataDir);
        }
        fs.rmSync(marker, { force: true });
      } catch { failed.push(gameId); }
    }
  }
  return failed;
}

// The unpacked copies a game has before a Locate attempt. A refused location
// removes only the copies that attempt added, never one that existed before.
function containerCopies(userDataDir, gameId) {
  const root = path.join(GameData.resolveGameDir(userDataDir, gameId), "containers"), found = new Set();
  const folders = directory => { try { return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory()); } catch { return []; } };
  for (const provider of folders(root)) for (const copy of folders(path.join(root, provider.name))) found.add(path.join(root, provider.name, copy.name));
  return found;
}
function removeAddedContainerCopies(userDataDir, gameId, before) {
  for (const copy of containerCopies(userDataDir, gameId)) if (!before.has(copy)) fs.rmSync(copy, { recursive: true, force: true });
}

// A container's source set may include companion files next to its import.
// They follow that file's directory; its launcher-owned extracted copy stays.
function sourceMoves(entry, target) {
  const moves = [{ from: target.from, to: target.input }];
  if (target.field === "importPath") {
    const directory = path.dirname(target.from);
    for (const source of entry.containerData?.sources || []) {
      const from = absolute(source?.path);
      if (from && from !== target.from && inside(directory, from)) moves.push({ from, to: path.join(path.dirname(target.input), path.relative(directory, from)) });
    }
  }
  return moves;
}

// Each value whose key is the old game path moves to the new one, such as the
// notices from the game's latest Play.
function moveKeys(maps, from, to) {
  if (from === to) return;
  for (const map of maps) {
    if (!map?.has?.(from)) continue;
    map.set(to, map.get(from)); map.delete(from);
  }
}

// A folder or a file, as the saved root was. The metadata cache records the
// root's file type; without it, an app bundle or a supported game file
// extension marks a file and anything else a folder.
function rootKind(entry, root, { userDataDir, extensions = [] } = {}) {
  if (/\.app$/i.test(root)) return "file";
  try {
    const file = path.join(GameData.resolveGameDir(userDataDir, entry.gameId), "metadata.json"), stat = fs.lstatSync(file);
    const files = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 ** 2 ? readJsonObject(file)?.files : null;
    const mode = Array.isArray(files) ? files.find(item => Array.isArray(item) && item[0] === root)?.[1]?.[2] : null;
    if (Number.isInteger(mode)) return (mode & S_IFMT) === S_IFDIR ? "directory" : "file";
  } catch {}
  const extension = path.extname(root).slice(1).toLowerCase();
  return extension && extensions.includes(extension) ? "file" : "directory";
}

// The nearest folder above the saved root that exists, using the bounded
// availability check, so a location that does not respond never holds up the
// chooser.
async function nearestExistingParent(file, { check = folder => GameAvailability.checkGameAvailability({ gamePath: folder }, { timeoutMs: 1000 }) } = {}) {
  for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
    try { if ((await check(folder))?.available) return folder; } catch {}
    if (path.dirname(folder) === folder) return null;
  }
}

async function chooser(entry, { userDataDir, extensions, check } = {}) {
  const root = GameAvailability.rootPath(entry, { userDataDir });
  if (!root) throw relocationError("MacLauncher keeps this game's files, so its location cannot be changed.", "GAME_LOCATION_OWNED");
  const kind = rootKind(entry, root, { userDataDir, extensions });
  const defaultPath = await nearestExistingParent(root, { check });
  return { label: `Locate ${entry.name || path.basename(root)}`, kinds: [kind], extensions: [], buttonLabel: "Locate",
    message: kind === "directory" ? "Choose the game's folder at its new location." : "Choose the game's file at its new location.",
    ...(defaultPath ? { defaultPath } : {}) };
}

// The paths detection starts from. A game rooted on its own path moves to the
// chosen location, and a file imported from inside it, such as its executable,
// keeps its place there when it exists. A game whose playable copy is
// launcher-owned, such as an unpacked installer, is rooted on its import.
function target(entry, inputPath, { userDataDir, exists = fs.existsSync } = {}) {
  const from = GameAvailability.rootPath(entry, { userDataDir }), input = absolute(inputPath);
  if (!from) throw relocationError("MacLauncher keeps this game's files, so its location cannot be changed.", "GAME_LOCATION_OWNED");
  if (!input) throw relocationError("Choose a folder or file for the game.", "GAME_LOCATION_INVALID");
  if (absolute(entry.gamePath) !== from) return { from, field: "importPath", input, paths: { importPath: input } };
  const imported = absolute(entry.importPath);
  const nested = imported && imported !== from && inside(from, imported) ? path.join(input, path.relative(from, imported)) : null;
  let kept = false;
  try { kept = Boolean(nested && exists(nested)); } catch {}
  return { from, field: "gamePath", input, paths: { gamePath: input, importPath: kept ? nested : input } };
}

// Accepts detection's result for the chosen location only when it is the
// entry's own game type, and moves the record's paths to the new root.
function adopt(entry, detected, { from, field, input, previous, registry, games = [] }) {
  const expected = resolveModuleId(previous), found = resolveModuleId(detected);
  if (found !== expected) {
    const label = id => registry?.getModuleInfo?.(id)?.label || id;
    throw relocationError(`The selected location is detected as ${label(found)}, not ${label(expected)}.`, "GAME_TYPE_MISMATCH");
  }
  const detectedPath = absolute(detected?.gamePath);
  if (detectedPath && games.some(game => game?.gameId !== previous.gameId && absolute(game?.gamePath) === detectedPath)) {
    throw relocationError("Another game in the library already uses the selected location.", "GAME_LOCATION_IN_USE");
  }
  const to = field === "gamePath" ? detectedPath || input : input;
  return { ...rebaseRecord(entry, from, to), ...(field === "gamePath" ? { gamePath: to } : {}), updatedAt: Date.now() };
}

// Detection failures read as one sentence about the selected location.
function userRelocationError(error) {
  const code = error?.code;
  if (error?.name === "AbortError" || code === "ABORT_ERR" || String(code).startsWith("GAME_")) return error;
  const message = code === "DETECTION_CONFLICT" ? "The selected location contains more than one possible game."
    : code === "DETECTION_UNSUPPORTED" || code === "DETECTION_UNSUPPORTED_EXTENSION" ? "MacLauncher does not recognize a game at the selected location."
    : code === "DETECTION_NOT_FOUND" || code === "ENOENT" || code === "ENOTDIR" ? "The selected location could not be found."
    : code === "EACCES" || code === "EPERM" ? "The selected location could not be read."
    : code === "DETECTION_LIMIT" ? "The selected location could not be searched completely."
    : String(code).startsWith("INSTALLER_") ? "The installer at the selected location could not be used for this game."
    : null;
  return message ? Object.assign(relocationError(message, code, error), error?.detection ? { detection: error.detection } : {}) : error;
}

function createGameRelocation({ userDataDir, registry, metadata, choose, check } = {}) {
  if (typeof choose !== "function") throw new Error("Locating a game requires a location chooser.");
  return {
    // Resolves to { relocated: false } when the chooser is canceled, or to the
    // updated record.
    async relocate(entry, settings, options = {}) {
      const stored = entry?.gameId ? GameStore.readGameRecord(userDataDir, entry.gameId) : null;
      if (!stored) throw relocationError("Game not found in library.", "GAME_NOT_FOUND");
      const extensions = typeof registry?.listSupportedInputExtensions === "function" ? registry.listSupportedInputExtensions() : [];
      const selected = await choose(await chooser(stored, { userDataDir, extensions, check }));
      if (typeof selected !== "string" || !selected) return { relocated: false };
      try { return { relocated: true, entry: await metadata.relocateEntry(stored, selected, settings, options) }; }
      catch (error) { throw userRelocationError(error); }
    }
  };
}

module.exports = { createGameRelocation, chooser, target, adopt, rebasePaths, rebaseRecord, rebaseStoredRecords, recoverInterruptedRelocations,
  containerCopies, removeAddedContainerCopies, sourceMoves, rootKind, nearestExistingParent, moveKeys, userRelocationError };
