const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { readPeExports } = require('./pe-exports');
const { readPlistFile } = require('./app-bundle');
const { fileApis, apisForFiles } = require('./translator-roles');
const warn = require('../graphics-warning');
const { fileIdentity } = require('./verified-identity');
const inspections = new Map();
function observedIdentity(file) {
  const identity = fileIdentity(file);
  if (identity) return JSON.stringify(identity);
  try { fs.lstatSync(file); return null; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? error.code : null; }
}
function copyDescription(value) {
  const { source, ...facts } = value;
  return { ...structuredClone(facts), source };
}
// Ordinary runtime managers expose these descriptions through their installed
// records. Paths refer to installed files, never to a second translator cache.
const COMPONENTS = Object.freeze(['d3d-renderer', 'vulkan-driver', 'd3d12', 'video']);
const ENGINES = Object.freeze(['d3dmetal', 'dxmt', 'dxvk', 'wined3d', 'moltenvk', 'kosmickrisp', 'vkd3d-proton', 'gstreamer']);
const FORMS = Object.freeze(['builtin', 'native', 'icd', 'dylib']);

/**
 * A description has id, component, engine, version, source, apis, form, root,
 * files and macosFloor. Each file has path (absolute), optional
 * relative (installation-relative placement), form, apis, machine (PE number),
 * cpuSlices (Mach-O names), macosFloor and slices. Mach-O slice imports keep
 * { symbol, library, weak? }; library is the dependency install name.
 * source may be a catalog id, 'custom', or { kind, id, label, runtime? }.
 * Mixed packages use a per-file form. Unknown fields are retained and ignored.
 * Optional pluginDirectories lists plugin search directories relative to root;
 * dependency libraries remain in files without becoming plugin directories.
 * Binary facts are populated by inspectDescription, independently of labels.
 */
function description(input) {
  if (!input || !input.component || !input.engine || !input.form)
    throw new TypeError('A translator component, engine and form are required.');
  if (!Array.isArray(input.files)) throw new TypeError('Translator files are required.');
  const { unixImports: _legacyImports, ...value } = input;
  const files = input.files.map(({ unixImports: _legacyFileImports, ...file }) => ({ ...file, ...(file.format === 'pe' ? { apis: fileApis(file) } : {}) }));
  return { ...value, apis: input.apis?.length ? [...input.apis] : apisForFiles(files), files, version: String(input.version || '') };
}
// Installation metadata retains placement facts; imports are inspected again
// from the selected files before preparation, rather than persisted per symbol.
function installationDescription(input) {
  const { root: _root, id: _id, ...value } = description(input);
  return { ...value, files: value.files.map(({ realPath: _realPath, ...file }) => ({ ...file, path: file.relative,
    ...(file.format === 'macho' && Array.isArray(file.slices) ? { slices: file.slices.map(({ imports: _imports, ...slice }) =>
      ({ ...slice, importsComplete: false })) } : {}) })) };
}
function label(value) {
  if (!value) return '';
  const names = { d3dmetal: 'D3DMetal', dxmt: 'DXMT', dxvk: 'DXVK', wined3d: 'WineD3D',
    moltenvk: 'MoltenVK', kosmickrisp: 'KosmicKrisp', 'vkd3d-proton': 'vkd3d-proton', gstreamer: 'GStreamer' };
  const source = displayText(typeof value.source === 'object' && value.source ? value.source.label || value.source.id : value.source);
  return [names[value.engine] || value.engine, value.version, source ? `(${source})` : ''].map(displayText).filter(Boolean).join(' ');
}
function displayText(value) { return String(value ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim(); }
/** Synchronous custom-runtime.inspect seam; unchanged observed files reuse facts. */
function describeTranslator(root, options = {}) {
  const { logger, ...selection } = options;
  let key;
  try { key = JSON.stringify([fs.realpathSync(root), selection]); }
  catch { return inspectDescription(root, options); }
  const previous = inspections.get(key);
  if (previous && previous.observed.every(([file, identity]) => observedIdentity(file) === identity)) return copyDescription(previous.value);
  const observed = new Map(), observe = file => { if (!observed.has(file)) observed.set(file, observedIdentity(file)); };
  const value = inspectDescription(root, options, observe);
  let result;
  try { result = copyDescription(value); } catch { return value; }
  if ([...observed].every(([file, identity]) => identity !== null && observedIdentity(file) === identity)) inspections.set(key, { value, observed: [...observed] });
  else inspections.delete(key);
  return result;
}
function inspectDescription(root, { engine, source, version, component, id, apis = [], form, pluginDirectories, frameworkRoot, logger = console } = {}, observe = () => {}) {
  observe(root);
  root = fs.realpathSync(root);
  if (pluginDirectories !== undefined) {
    if (!Array.isArray(pluginDirectories)) throw new TypeError('Plugin directories must be root-relative paths.');
    pluginDirectories = [...new Set(pluginDirectories.map(relative => {
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new TypeError('Plugin directories must be root-relative paths.');
      const selected = path.resolve(root, relative);
      if (selected !== root && !selected.startsWith(root + path.sep)) throw new Error('A plugin directory escapes its component root.');
      const real = fs.realpathSync(selected);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error('A plugin directory escapes its component root.');
      if (!fs.statSync(real).isDirectory()) throw new TypeError('A plugin directory must be a directory.');
      return path.relative(root, real) || '.';
    }))];
  }
  const files = [], visited = new Set(), warnings = [];
  function visit(file, entry) {
    const framework = file.match(/([^/]+)\.framework\//), required = /\.(?:dll|so|dylib)$/i.test(file) || framework?.[1] === path.basename(file);
    const binary = required || framework && !path.extname(file), json = /\.json$/i.test(file);
    if (entry?.isFile() && !binary && !json) return;
    observe(file);
    let real, stat;
    try { real = fs.realpathSync(file); stat = fs.statSync(file); }
    catch (error) {
      if (file === root || required) throw error;
      warnings.push(`Skipped inaccessible component entry ${file}: ${error.message}`); return;
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      if (required) throw new Error('A translator link escapes its component root.');
      if (json && stat.isFile()) {
        let icd;
        try { icd = JSON.parse(fs.readFileSync(file, 'utf8')).ICD; } catch {}
        if (icd) throw new Error('A translator link escapes its component root.');
      }
      warnings.push(`Skipped component entry outside its root: ${file}`); return;
    }
    if (stat.isDirectory()) {
      if (visited.has(real)) return;
      visited.add(real);
      let entries;
      try { entries = fs.readdirSync(file, { withFileTypes: true }); }
      catch (error) {
        if (file === root) throw error;
        warnings.push(`Skipped inaccessible component directory ${file}: ${error.message}`); return;
      }
      for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) visit(path.join(file, child.name), child);
    } else if (stat.isFile()) {
      const relative = path.relative(root, file) || path.basename(file);
      if (json) {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).ICD) files.push(inspectFile({ path: file, relative })); }
        catch (error) { warnings.push(`Could not inspect optional component metadata ${file}: ${error.message}`); }
      } else if (binary) {
        try { fs.accessSync(file, fs.constants.R_OK); }
        catch (error) {
          if (required || file === root) throw error;
          warnings.push(`Skipped inaccessible component entry ${file}: ${error.message}`); return;
        }
        const facts = inspectFile({ path: file, relative });
        if (path.extname(file) || facts.format === 'macho') files.push(facts);
        if (facts.inspectionWarning) warnings.push(`${file}: ${facts.inspectionWarning}`);
      }
    }
  }
  visit(root);
  component ||= ['moltenvk', 'kosmickrisp'].includes(engine) ? 'vulkan-driver' : engine === 'vkd3d-proton' ? 'd3d12' : engine === 'gstreamer' ? 'video' : 'd3d-renderer';
  form ||= component === 'vulkan-driver' ? 'icd' : component === 'video' ? 'dylib' : 'builtin';
  const pe = files.find(file => file.format === 'pe');
  if (component !== 'vulkan-driver' && component !== 'video') form = pe?.form || form;
  const versionFile = path.join(root, 'version');
  observe(versionFile);
  let componentVersion;
  try {
    if (fs.statSync(versionFile).isFile()) {
      if (!fs.realpathSync(versionFile).startsWith(root + path.sep)) throw new Error('Optional version text is outside its component root.');
      componentVersion = displayText(fs.readFileSync(versionFile, 'utf8'));
      version = componentVersion || version;
    }
  }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`Could not read optional component version ${versionFile}: ${error.message}`); }
  if (!componentVersion) {
    let infoFile;
    try {
      if (frameworkRoot) observe(frameworkRoot);
      const metadataRoot = frameworkRoot ? fs.realpathSync(frameworkRoot) : root;
      infoFile = path.join(metadataRoot, 'Resources/Info.plist');
      observe(infoFile);
      if (!fs.statSync(infoFile).isFile()) throw new Error('The optional framework property list is not a regular file.');
      if (!fs.realpathSync(infoFile).startsWith(metadataRoot + path.sep)) throw new Error('Optional framework metadata is outside its root.');
      const plist = readPlistFile(infoFile), frameworkVersion = typeof plist?.CFBundleShortVersionString === 'string' ? displayText(plist.CFBundleShortVersionString) : '';
      if (frameworkVersion) version = frameworkVersion;
      else warnings.push(`Could not read optional framework version ${infoFile}: CFBundleShortVersionString is unavailable.`);
    } catch (error) {
      if (frameworkRoot || error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`Could not read optional framework version ${infoFile || String(frameworkRoot || root)}: ${error.message}`);
    }
  }
  apis = [...new Set([...apisForFiles(files), ...files.flatMap(file => {
    if (file.format === 'json') { try { const api = JSON.parse(fs.readFileSync(file.path, 'utf8')).ICD?.api_version; return api ? [`Vulkan ${api}`] : []; } catch {} }
    return [];
  })])];
  const floors = files.flatMap(file => file.macosFloor ? [file.macosFloor] : []);
  for (const warning of warnings) warn(logger, `[translators] ${warning}`);
  return description({ id: id || `${engine}:${root}`, root, component, engine, source, version, apis, form, files,
    warnings, ...(pluginDirectories === undefined ? {} : { pluginDirectories }),
    macosFloor: floors.sort(compareVersions).at(-1) || null });
}
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  return 0;
}
function inspectFile(file) {
  const { unixImports: _legacyImports, ...result } = file;
  try {
    const native = readMachOLoadCommands(file.path, { imports: true });
    return { ...result, realPath: fs.realpathSync(file.path), format: 'macho', form: file.path.endsWith('.so') ? 'builtin' : 'dylib', apis: [], cpuSlices: native.architectures,
      slices: native.slices, macosFloor: native.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort(compareVersions).at(-1) || null };
  } catch (error) {
    if (error.code !== 'MACHO_MALFORMED') result.inspectionWarning = error.message;
  }
  const original = fs.realpathSync(file.path), exports = readPeExports(original, { imports: true }), pe = exports || readPeExports(original, { headersOnly: true, imports: true });
  if (pe) {
    if (!exports) result.inspectionWarning = 'PE export inspection is incomplete; basic image facts are available.';
    if (!pe.importsComplete) result.inspectionWarning = [result.inspectionWarning,
      `PE import inspection is incomplete: ${pe.importWarning || 'unknown import metadata'}`].filter(Boolean).join(' ');
    // Replacement DLL resources report Windows component versions, not translator releases.
    return { ...result, realPath: original, format: 'pe', form: pe.form, machine: pe.machine, architecture: pe.architecture, macosFloor: null,
      apis: fileApis({ ...file, format: 'pe' }), peImports: pe.peImports, importsComplete: pe.importsComplete, version: null };
  }
  return { ...result, format: file.path.endsWith('.json') ? 'json' : 'unknown', apis: [], macosFloor: null };
}
module.exports = { COMPONENTS, ENGINES, FORMS, description, installationDescription, label, describeTranslator, inspectFile, compareVersions };
