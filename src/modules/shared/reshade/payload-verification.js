const path = require("node:path");
const Native = require("../runtime/bundled-native"), MachO = require("../runtime/local-native");
const Requirements = require("../effects/execution-requirements");
const verified = new Map(), LIMIT = 2048;

function verifyFile(root, row) {
  const file = path.join(root, Native.relativeFile(row.path)), identity = Native.fileIdentity(file, {maximum: row.size});
  const expected = JSON.stringify([row.sha256, row.size]);
  const previous = verified.get(file);
  if (previous?.identity === identity && previous.expected === expected &&
      (row.mode === undefined || row.mode === previous.mode) &&
      (!row.architectures || JSON.stringify([...row.architectures].sort()) === previous.architectures)) return;
  const actual = Native.readRegular(file, row.size);
  if (actual.size !== row.size || actual.sha256 !== row.sha256 || row.mode !== undefined && actual.mode !== row.mode)
    throw new Error(`Bundled runtime checksum or permissions changed: ${row.path}`);
  if (row.architectures && JSON.stringify(MachO.readMachOArchitectures(file, {allowLibrary: true}).sort()) !== JSON.stringify([...row.architectures].sort()))
    throw new Error(`Bundled runtime Mach-O architecture changed: ${row.path}`);
  if (Native.fileIdentity(file, {maximum: row.size}) !== identity) throw new Error("The graphics runtime changed while being read.");
  if (verified.size >= LIMIT) verified.delete(verified.keys().next().value);
  verified.set(file, {identity, expected, mode: actual.mode, architectures: row.architectures ? JSON.stringify([...row.architectures].sort()) : null});
}
function shaderFormat(shader, options) {
  if (shader.preset === "custom") return /\.(glsl|hook)$/i.test(shader.effectPath || "") ? "libplacebo" : /\.(slangp|slang)$/i.test(shader.effectPath || "") ? "slangp" : "fx";
  const Filters = require("./filter-library"), Managed = require("./managed-shaders"), Packs = require("./shader-packs");
  try {
    if (Filters.isFilterId(shader.preset)) return Filters.resolve(options.userDataDir, shader.preset).format;
    if (Managed.isId(shader.preset)) return Managed.resolveEffect(options.userDataDir, shader.preset, options.shaderFeatures || {}, options.graphicsHost, options).format;
    const selected = Packs.lookup(shader.preset);
    return selected ? selected.effect.format || selected.pack.format || "fx" : "fx";
  } catch { return null; } // An unavailable optional row cannot load a provider.
}
function selectedFiles(manifest, entry, options = {}) {
  const demand = Requirements.analyze(entry), needed = demand.needed;
  if (!needed.processor && !options.presenter && !options.activation) return [];
  const names = new Set(["runtime.json", "libreshade-macos.dylib", "libvkd3d-shader.dylib"]), prefixes = [];
  const formats = new Set(demand.shaders.map(shader => shaderFormat(shader, options)).filter(Boolean));
  if (needed.shaders) {
    names.add("fx-compile");prefixes.push("include/");
    for (const shader of demand.shaders) {
      if (shader.preset === "chain") for (const id of shader.effects || ["cas", "crt"]) names.add(`effects/${id}.fx`);
      else if (/^[a-z][a-z0-9-]*$/.test(shader.preset || "")) names.add(`effects/${shader.preset}.fx`);
    }
  }
  if (needed.neural) prefixes.push("neural/");
  if (needed.fsr) prefixes.push("temporal/fsr/");
  if (needed.fsr4) prefixes.push("temporal/fsr4/");
  if (formats.has("libplacebo") || demand.methods.spatial.some(method => method.startsWith("libplacebo:"))) {
    names.add("libmacfx-libplacebo.dylib");names.add("libplacebo-prepare");prefixes.push("libplacebo/");
  }
  if (formats.has("slangp") || formats.has("slang")) {names.add("librashader.dylib");names.add("retroarch-prepare");}
  return manifest.files.filter(row => (names.has(row.path) || prefixes.some(prefix => row.path.startsWith(prefix))) &&
    !row.path.startsWith("neural/notices/") && row.path !== "neural/maclauncher-neural-video");
}
function verifyLaunch(root, entry, options = {}) {
  const manifest = options.manifest || require("./publication").forRoot(root);
  const files = selectedFiles(manifest, entry, options);
  for (const row of files) verifyFile(root, row);
  return {files: files.length, bytes: files.reduce((total, row) => total + row.size, 0)};
}
module.exports = {verifyLaunch, selectedFiles, verifyFile, clear: () => verified.clear()};
