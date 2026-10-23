const fs = require("node:fs");
const path = require("node:path");
const Catalog = require("./shader-packs.json");
const Writable = require("../writable-input");
const Providers = require("./shader-providers");
const Traits = require("./shader-traits");

function effectId(pack, effect) { return `shader:${pack.id}:${effect.id}`; }
function effectFormat(pack, effect) { return effect.format || pack.format || "fx"; }
function lookup(id) {
  if (typeof id !== "string") return null;
  const stable = /^shader:([a-z0-9-]+):([a-z0-9-]+)$/.exec(id);
  const legacy = /^pack:([a-z0-9-]+):([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([a-z0-9-]+)$/.exec(id);
  if (!stable && !legacy) return null;
  const pack = Catalog.packs.find(item => item.id === (stable || legacy)[1]);
  const effect = pack?.effects.find(item => item.id === (stable ? stable[2] : legacy[3]));
  return effect ? { pack, effect, id: effectId(pack, effect), legacyVersion: legacy?.[2] || null } : null;
}
function normalizeId(id) {
  const selected = lookup(id);
  // Included choices have stable IDs. A previously downloaded local shader
  // retains its old location until explicitly changed to a custom .fx file.
  return selected ? !selected.pack.bundledPath && selected.legacyVersion ? id : selected.id : null;
}
function depthHosts(features = {}) {
  return features.depth?.hosts?.filter(host => ["window", "remote", "explicit"].includes(host)) || [];
}
function requirements(effect, features = {}, graphicsHost) {
  const depthAvailable = features.depth === true || (graphicsHost === undefined ? depthHosts(features).length > 0 : depthHosts(features).includes(graphicsHost));
  if (effect.requires.includes("depth") && !depthAvailable) return "Requires game depth, which this presentation path does not provide.";
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
function localEffect(userDataDir, pack, effect, version = pack.version) {
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version || "")) return null;
  const root = path.join(userDataDir, "runtimes", "reshade-shaders", pack.id, version);
  try {
    Writable.assertOwnDirectory(userDataDir, root, { create: false });
    return describe(root, pack, effect);
  } catch { return null; }
}
function listEffects(userDataDir, features = {}, options = {}) {
  return Catalog.packs.flatMap(pack => pack.effects.flatMap(effect => {
    // Previously selected proprietary files remain local custom inputs. They
    // are never acquired or redistributed by the included shader collection.
    if (!pack.bundledPath && !localEffect(userDataDir, pack, effect)) return [];
    const format = effectFormat(pack, effect);
    let reason = requirements(effect, features, options.graphicsHost) || Providers.availability(format, { ...options, features });
    let source, traits;
    if (pack.bundledPath) {
      try { source = bundledEffect(pack, effect); }
      catch { reason ||= "This included shader is missing. Choose another effect or a local shader file."; }
    }
    if (format === "libplacebo") try {
      source ||= localEffect(userDataDir, pack, effect);
      if (source) traits = Traits.analyzeFile(source.file, format).traits;
    } catch {}
    return [{ id: effectId(pack, effect), label: `${pack.label} · ${effect.label}`, group: pack.label,
      format, available: !reason, reason, installed: true, bundled: Boolean(pack.bundledPath),
      ...(traits ? {traits} : {}),
      ...(effect.requires.includes("depth") && features.depth !== true ? { depthHosts: depthHosts(features) } : {}) }];
  }));
}
function resolveEffect(userDataDir, id, features, graphicsHost, options) {
  const selected = lookup(id);
  if (!selected) throw new Error("Unknown shader.");
  const { pack, effect } = selected, reason = requirements(effect, features, graphicsHost) ||
    Providers.availability(effectFormat(pack, effect), { ...options, features });
  if (reason) throw new Error(reason);
  if (pack.bundledPath) return bundledEffect(pack, effect, options);
  const local = localEffect(userDataDir, pack, effect, selected.legacyVersion || pack.version);
  if (local) return local;
  throw new Error(`${pack.label} is not included. Choose its existing local shader file, or select an included shader.`);
}
module.exports = { Catalog, lookup, normalizeId, requirements, effectId, effectFormat, listEffects, resolveEffect, physicalModuleRoot };
