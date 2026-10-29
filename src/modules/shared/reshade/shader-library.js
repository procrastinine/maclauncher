const fs = require("node:fs");
const path = require("node:path");
const Filters = require("./filter-library");
const Traits = require("./shader-traits");
const Writable = require("../writable-input");

// Presentation metadata follows the existing stable shader selection. It never
// copies a shader, changes its preparation identity or creates another catalog.
function location(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("The shader library requires the application's data directory.");
  return path.join(userDataDir, "graphics", "shader-names.json");
}
function knownId(id) {
  return typeof id === "string" && (Filters.isFilterId(id) || require("./managed-shaders").isId(id) ||
    Boolean(require("./shader-packs").lookup(id)) ||
    require("./shader-settings").PRESETS.some(row => row.id === id && !["custom", "chain"].includes(id)));
}
function validName(name) {
  return typeof name === "string" && name.length <= Filters.LIMITS.name && !/[\x00-\x1f]/.test(name);
}
function readNames(userDataDir) {
  if (!userDataDir) return {};
  const file = location(userDataDir);
  Writable.assertOwnDirectory(userDataDir, path.dirname(file), { create: false });
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Filters.LIMITS.metadata) throw Error();
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schema !== 1 || !record.names || typeof record.names !== "object" || Array.isArray(record.names) ||
        Object.entries(record.names).some(([id, name]) => !/^[a-z][a-z0-9:-]{0,255}$/.test(id) || !validName(name) || !name.trim())) throw Error();
    return record.names;
  } catch { throw new Error("Shader names could not be read. Restore the saved names before editing them."); }
}
function rename(userDataDir, id, name) {
  if (!knownId(id)) throw new Error("Choose a shader from the library.");
  if (!validName(name)) throw new Error("Enter a shader name of up to 512 characters without control characters.");
  if (Filters.isFilterId(id)) {
    Filters.update(userDataDir, id.slice(7), { name });
    return;
  }
  const names = readNames(userDataDir), value = name.trim();
  if (value) names[id] = value;
  else delete names[id];
  const contents = JSON.stringify({ schema: 1, names }, null, 2) + "\n";
  if (Buffer.byteLength(contents) > Filters.LIMITS.metadata) throw new Error("The shader name list is full.");
  Writable.atomicWrite(location(userDataDir), contents, { root: userDataDir });
}
function present(state, { userDataDir, root } = {}) {
  let names = {}, shaderLibraryError;
  try { names = readNames(userDataDir); } catch (error) { shaderLibraryError = error.message; }
  const imports = new Map((state.filters || []).map(row => [`filter:${row.id}`, row]));
  const presets = state.presets.map(preset => {
    if (["custom", "chain"].includes(preset.id)) return preset;
    const imported = imports.get(preset.id), included = Boolean(preset.bundled) || !/^(shader|filter):/.test(preset.id);
    const file = imported?.path || preset.sourcePath || (included && root ? path.join(root, "effects", preset.id + ".fx") : "");
    const format = preset.format || Filters.formatForPath(file);
    let traits = preset.traits, sourceRevision = preset.sourceRevision;
    if (!traits && file) {
      try { const analysis = Traits.analyzeFile(file, format); traits = analysis.traits; sourceRevision = analysis.sourceRevision; } catch {}
    }
    return { ...preset, ...(names[preset.id] ? { label: names[preset.id] } : {}), sourcePath: file, format,
      ...(traits ? { traits, outputContract: preset.outputContract || Traits.outputContract(traits) } : {}), ...(sourceRevision ? { sourceRevision } : {}) };
  });
  const shaderLibrary = presets.flatMap((preset, index) => {
    if (["custom", "chain"].includes(preset.id)) return [];
    const imported = imports.get(preset.id), included = Boolean(preset.bundled) || !/^(shader|filter):/.test(preset.id);
    const available = state.available !== false && preset.available !== false;
    return [{ id: preset.id, presetId: preset.id,
      implementationId: /^(shader|filter):/.test(preset.id) ? preset.id : `shader:${preset.id}`,
      name: preset.label, defaultName: state.presets[index].label, path: preset.sourcePath, format: preset.format,
      ...(preset.group ? {collectionLabel: preset.group} : {}),
      ...(preset.traits ? { traits: preset.traits, outputContract: preset.outputContract } : {}),
      ...(preset.sourceRevision ? { sourceRevision: preset.sourceRevision } : {}),
      available, ...(!available && (preset.reason || state.reason) ? { reason: preset.reason || state.reason } : {}),
      origin: imported ? "imported" : included ? "included" : "collection",
      canRemove: Boolean(imported), canRelocate: Boolean(imported), ...(imported ? { filterId: imported.id } : {}) }];
  });
  return { ...state, presets, shaderLibrary, ...(shaderLibraryError ? { shaderLibraryError } : {}) };
}
module.exports = { present, rename };
