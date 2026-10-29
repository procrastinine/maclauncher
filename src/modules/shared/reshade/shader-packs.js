const fs = require("node:fs");
const path = require("node:path");
const Providers = require("./shader-providers");
// The native collection's effects are the methods its provider describes.
const Catalog = (catalog => ({...catalog, packs: catalog.packs.map(pack => pack.format === "native" && !pack.effects ?
  {...pack, effects: require("./native-filter").collection} : pack)}))(require("./shader-packs.json"));
const Traits = require("./shader-traits"), Items = require("../item-results");

function effectId(pack, effect) { return `shader:${pack.id}:${effect.id}`; }
function effectFormat(pack, effect) { return effect.format || pack.format || "fx"; }
function parse(id) {
  if (typeof id !== "string") return null;
  const stable = /^shader:([a-z0-9-]+):([a-z0-9-]+)$/.exec(id);
  const legacy = /^pack:([a-z0-9-]+):([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([a-z0-9-]+)$/.exec(id);
  return stable ? { pack: stable[1], effect: stable[2], version: null } : legacy ? { pack: legacy[1], effect: legacy[3], version: legacy[2] } : null;
}
function lookup(id) {
  const parsed = parse(id), pack = parsed && Catalog.packs.find(item => item.id === parsed.pack);
  const effect = pack?.effects.find(item => item.id === parsed.effect);
  return effect ? { pack, effect, id: effectId(pack, effect), legacyVersion: parsed.version } : null;
}
// An effect from a collection that became a managed upstream collection keeps
// working under that collection's ID.
function renamedId(id) {
  const parsed = parse(id), key = parsed && `shader:${parsed.pack}:${parsed.effect}`;
  return key && Object.hasOwn(Catalog.aliases, key) ? Catalog.aliases[key] : null;
}
function normalizeId(id) { return lookup(id)?.id || renamedId(id); }
function depthHosts(features = {}) {
  return features.depth?.hosts?.filter(host => ["window", "remote", "explicit"].includes(host)) || [];
}
function requirements(effect, features = {}, graphicsHost) {
  if(effect.libplaceboMethod&&features.providers?.libplacebo?.imageFiltersAPI!==1)return "This libplacebo image filter requires a graphics processor with image-filter support.";
  if(effect.nativeMethod&&!features.providers?.native?.methods?.includes(effect.nativeMethod))return "This compiled image algorithm is unavailable in the selected graphics processor.";
  // Scene resources are checked against the actual admitted frame. Their
  // absence keeps this row pending rather than disabling a whole source route.
  if (effect.requires.includes("sourceTextures") && features.sourceTextures !== true) return "Requires lookup texture loading in the included ReShade runtime.";
  if (effect.requires.includes("smaa") && features.smaa !== true) return "Requires SMAA support in the included ReShade runtime.";
  return null;
}
// The native compiler cannot open Electron's virtual ASAR paths. Collection
// assets are unpacked once beside app.asar; source development uses its ordinary
// module directory. Nothing is materialized into versioned user-data caches.
function physicalModuleRoot(directory = __dirname) {
  const parts = path.resolve(directory).split(path.sep);
  const archive = parts.findIndex(part => part.endsWith(".asar"));
  if (archive !== -1) parts[archive] += ".unpacked";
  return parts.join(path.sep);
}
function contained(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) ||
      /[\\\x00-\x1f]/.test(relative) || relative.split("/").some(part => part === ".." || part === "."))
    throw new Error("Invalid included shader path.");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error("Invalid included shader path.");
  return file;
}
function describe(root, pack, effect) {
  const file = contained(root, effect.file), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("The selected shader file is unavailable. Choose another effect or a local shader file.");
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep))
    throw new Error("The selected shader file is outside its collection.");
  return { file, format: effectFormat(pack, effect), includePaths: pack.includePaths.map(item => contained(root, item)),
    texturePaths: pack.texturePaths.map(item => contained(root, item)) };
}
function bundledEffect(pack, effect, options) {
  if (!pack.bundledPath?.startsWith("shader-collection/")) throw new Error("This shader is not included.");
  return describe(contained(physicalModuleRoot(options?.moduleRoot), pack.bundledPath), pack, effect);
}
// An effect that cannot be read is listed as unavailable with its reason.
function listEffects(userDataDir, features = {}, options = {}) {
  const listed = Items.settle(Catalog.packs.flatMap(pack => pack.effects.map(effect => ({pack, effect}))), ({pack, effect}) => listedEffect(pack, effect),
    {id: ({pack, effect}) => ({id: effectId(pack, effect), label: `${pack.label} · ${effect.label}`, group: pack.label})});
  return [...listed.results.flat(), ...listed.failures.map(({id, reason}) => ({...id, available: false, reason, installed: true}))];
  function listedEffect(pack, effect) {
    const format = effectFormat(pack, effect);
    let reason = requirements(effect, features, options.graphicsHost) || Providers.availability(format, { ...options, features });
    let source, traits, sourceRevision;
    try { source = bundledEffect(pack, effect); }
    catch { reason ||= "This included shader is missing. Choose another effect or a local shader file."; }
    try {
      if (source) { const analysis = Traits.analyzeFile(source.file, format); traits = analysis.traits; sourceRevision = analysis.sourceRevision; }
    } catch {}
    if(traits)reason ||= Providers.traitsAvailability(format,traits,{features});
    return [{ id: effectId(pack, effect), label: `${pack.label} · ${effect.label}`, group: pack.label, ...(effect.purpose ? { purpose: effect.purpose } : {}),
      format, available: !reason, reason, installed: true, bundled: true,
      ...(source ? {sourcePath: source.file} : {}), ...(sourceRevision ? {sourceRevision} : {}),
      ...(traits ? {traits,outputContract:Traits.outputContract(traits)} : {}),
      ...(effect.requires.includes("depth") && features.depth !== true ? { depthHosts: depthHosts(features) } : {}) }];
  }
}
function resolveEffect(userDataDir, id, features, graphicsHost, options) {
  const selected = lookup(id);
  if (!selected) throw new Error("Unknown shader.");
  const { pack, effect } = selected, reason = requirements(effect, features, graphicsHost) ||
    Providers.availability(effectFormat(pack, effect), { ...options, features });
  if (reason) throw new Error(reason);
  const source=bundledEffect(pack,effect,options);
  const invalid=Providers.traitsAvailability(effectFormat(pack,effect),Traits.analyzeFile(source.file,effectFormat(pack,effect)).traits,{features});if(invalid)throw Error(invalid);return source;
}
module.exports = { Catalog, lookup, normalizeId, renamedId, requirements, effectId, effectFormat, listEffects, resolveEffect, physicalModuleRoot };
