const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Writable = require("../writable-input");
const Traits = require("./shader-traits");

const LIMITS = Object.freeze({ entries: 512, imports: 128, metadata: 1024 * 1024, file: 8 * 1024 * 1024, name: 512, path: 4096 });
const FAMILY_EXTENSIONS = Object.freeze({ reshade: ["fx"], libretro: ["slangp", "slang"], mpv: ["glsl", "hook"] });
const SUPPORTED_EXTENSIONS = Object.freeze(Object.values(FAMILY_EXTENSIONS).flat());
function extensionsForFamily(family) {
  if (family === undefined) return SUPPORTED_EXTENSIONS;
  if (typeof family !== "string" || !Object.hasOwn(FAMILY_EXTENSIONS, family)) throw new Error("Choose ReShade, libretro or MPV filters.");
  return FAMILY_EXTENSIONS[family];
}
function formatForPath(file) {
  if (typeof file !== "string" || /[\x00-\x1f]/.test(file)) return null;
  let canonical = file;
  try { canonical = fs.realpathSync(file); } catch {}
  const extension = path.extname(canonical).slice(1).toLowerCase();
  return extension === "glsl" || extension === "hook" ? "libplacebo" : SUPPORTED_EXTENSIONS.includes(extension) ? extension : null;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nameKey = name => name.normalize("NFKC").toLocaleLowerCase("en-US");
function isFilterId(value) { return typeof value === "string" && value.startsWith("filter:") && UUID.test(value.slice(7)); }
function location(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("The filter library requires the application's data directory.");
  return path.join(userDataDir, "graphics", "reshade-filters.json");
}
function validPath(value) {
  return typeof value === "string" && value.length <= LIMITS.path && path.isAbsolute(value) && SUPPORTED_EXTENSIONS.includes(path.extname(value).slice(1).toLowerCase()) && !/[\x00-\x1f]/.test(value);
}
function validName(value) { return typeof value === "string" && value.trim().length > 0 && value.length <= LIMITS.name && !/[\x00-\x1f]/.test(value); }
function read(userDataDir) {
  if (!userDataDir) return [];
  const file = location(userDataDir);
  Writable.assertOwnDirectory(userDataDir, path.dirname(file), { create: false });
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return [];throw error; }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.metadata) throw new Error();
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schema !== 1 || !Array.isArray(record.filters) || record.filters.length > LIMITS.entries) throw new Error();
    const ids = new Set(), names = new Set();
    return record.filters.map(row => {
      if (!row || !UUID.test(row.id) || !validName(row.name) || !validPath(row.path) || ids.has(row.id) || names.has(nameKey(row.name))) throw new Error();
      ids.add(row.id);names.add(nameKey(row.name));
      return { id: row.id, name: row.name, path: row.path, ...(row.analysis && typeof row.analysis === "object" ? { analysis: row.analysis } : {}) };
    });
  } catch { throw new Error("The filter library could not be read. Restore its saved metadata before editing filters."); }
}
function status(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { available: false, reason: "Choose a .fx, .slangp, .slang, .glsl or .hook file instead of a folder." };
    if (!formatForPath(file)) return { available: false, reason: "Choose a ReShade .fx, RetroArch .slangp or .slang, or MPV/libplacebo .glsl or .hook file." };
    if (stat.size > LIMITS.file) return { available: false, reason: "This filter exceeds the 8 MiB source file limit." };
    fs.accessSync(file, fs.constants.R_OK);
    return { available: true, stat };
  } catch (error) {
    return { available: false, reason: ["ENOENT", "ENOTDIR"].includes(error.code)
      ? "The filter file was not found. Update its path or choose another filter."
      : "The filter file cannot be read. Update its path or choose another filter." };
  }
}
function listed(rows) {
  return rows.map(row => {
    const { available, reason, stat } = status(row.path), { analysis, ...record } = row;
    let traits;
    if (available && stat && formatForPath(row.path) === "libplacebo") {
      if (analysis?.parserVersion === Traits.VERSION && analysis.sourceSize === stat.size && analysis.sourceMtimeMs === stat.mtimeMs && analysis.sourceCtimeMs === stat.ctimeMs) traits = analysis.traits;
      else try { traits = analyze(row.path)?.traits; } catch {}
    }
    return { ...record, format: formatForPath(row.path), ...(traits ? {traits, group: Traits.group(traits)} : {}), available, ...(reason ? { reason } : {}) };
  });
}
function analyze(file) {
  if (formatForPath(file) !== "libplacebo") return undefined;
  return Traits.analyzeFile(file, "libplacebo");
}
function list(userDataDir) { return listed(read(userDataDir)); }
function save(userDataDir, rows) {
  const file = location(userDataDir), contents = JSON.stringify({ schema: 1, filters: rows }, null, 2) + "\n";
  if (rows.length > LIMITS.entries || Buffer.byteLength(contents) > LIMITS.metadata) throw new Error("The filter library is full. Remove an unused filter before importing another.");
  Writable.atomicWrite(file, contents, { root: userDataDir });
  return listed(rows);
}
function source(file) {
  if (!validPath(file)) throw new Error("Choose an existing ReShade .fx, RetroArch .slangp or .slang, or MPV/libplacebo .glsl or .hook file with an absolute path.");
  const result = status(file);
  if (!result.available) throw new Error(result.reason);
  return path.resolve(file);
}
function sourceIdentity(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
function defaultName(file, rows) {
  const base = path.basename(file), names = new Set(rows.map(row => nameKey(row.name)));
  if (!names.has(nameKey(base))) return base;
  const parent = (path.basename(path.dirname(file)) || path.dirname(file)).slice(0, Math.max(1, LIMITS.name - base.length - 16));
  const named = `${base} (${parent})`;
  if (!names.has(nameKey(named))) return named;
  for (let number = 2; ; number++) {
    const candidate = `${named} ${number}`;
    if (!names.has(nameKey(candidate))) return candidate;
  }
}
function importFiles(userDataDir, paths) {
  const rows = read(userDataDir);
  if (paths == null || Array.isArray(paths) && paths.length === 0) return listed(rows);
  if (!Array.isArray(paths) || paths.length > LIMITS.imports) throw new Error("Choose up to 128 shader or filter files to import at once.");
  const files = Array.from(paths, source), identities = new Set(rows.map(row => sourceIdentity(row.path)));
  let changed = false;
  for (const file of files) {
    const identity = sourceIdentity(file);
    if (identities.has(identity)) {
      const existing = rows.find(row => sourceIdentity(row.path) === identity), analysis = analyze(file);
      if (existing && JSON.stringify(existing.analysis) !== JSON.stringify(analysis)) { existing.analysis = analysis;changed = true; }
      continue;
    }
    identities.add(identity);changed = true;
    rows.push({ id: crypto.randomUUID(), name: defaultName(file, rows), path: file, analysis: analyze(file) });
  }
  return changed ? save(userDataDir, rows) : listed(rows);
}
function find(rows, id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Choose a registered filter.");
  const index = rows.findIndex(row => row.id === id);
  if (index === -1) throw new Error("The selected filter was not found in the library. Import its shader file or choose another filter.");
  return index;
}
function update(userDataDir, id, patch) {
  const rows = read(userDataDir), index = find(rows, id);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !["name", "path"].includes(key)))
    throw new Error("Filter edits can change only its name and shader file path.");
  const next = { ...rows[index] }, others = rows.filter(row => row.id !== id);
  if (Object.hasOwn(patch, "path")) {
    next.path = source(patch.path);
    next.analysis = analyze(next.path);
    if (others.some(row => sourceIdentity(row.path) === sourceIdentity(next.path))) throw new Error("This shader file is already in the filter library. Choose a different file.");
  }
  if (Object.hasOwn(patch, "name")) {
    if (typeof patch.name !== "string") throw new Error("Enter a filter name.");
    next.name = patch.name.trim() || defaultName(next.path, others);
    if (!validName(next.name)) throw new Error("Enter a filter name of up to 512 characters without control characters.");
    if (others.some(row => nameKey(row.name) === nameKey(next.name))) throw new Error(`A filter named “${next.name}” already exists. Choose a different name.`);
  }
  rows[index] = next;
  return save(userDataDir, rows);
}
function remove(userDataDir, id) {
  const rows = read(userDataDir), index = find(rows, id);
  rows.splice(index, 1);
  return save(userDataDir, rows);
}
function resolve(userDataDir, preset) {
  if (!isFilterId(preset)) throw new Error("Choose a registered filter.");
  const rows = read(userDataDir), row = rows[find(rows, preset.slice(7))], selected = source(row.path), file = fs.realpathSync(selected), directory = path.dirname(file);
  return { file, format: formatForPath(file), includePaths: [...new Set([directory, path.dirname(selected)])], texturePaths: [directory, path.join(directory, "Textures"), path.join(directory, "../Textures")] };
}
// Used only during explicit preparation/control edits, never native rendering.
// Names do not change shader identity; replacing a path or source invalidates
// parameter metadata and the immutable live snapshot's preparation key.
function identity(userDataDir, preset) {
  if (!isFilterId(preset)) return null;
  try {
    const rows = read(userDataDir), row = rows[find(rows, preset.slice(7))], result = status(row.path);
    return [row.path, sourceIdentity(row.path), formatForPath(row.path), result.stat?.dev ?? null, result.stat?.ino ?? null,
      result.stat?.size ?? null, result.stat?.mtimeMs ?? null, result.stat?.ctimeMs ?? null];
  } catch { return ["unavailable"]; }
}
module.exports = { LIMITS, SUPPORTED_EXTENSIONS, extensionsForFamily, formatForPath, isFilterId, list, importFiles, update, remove, resolve, identity };
