const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { readPeExports } = require('./pe-exports');
const { readPlistFile } = require('./app-bundle');
const { fileApis, apisForFiles } = require('./translator-roles');
const warn = require('../graphics-warning');
const { fileIdentity } = require('./verified-identity');
const inspections = new Map();
const fileInspections = new Map();
function observedIdentity(file) {
  const identity = fileIdentity(file);
  if (identity) return JSON.stringify(identity);
  try { fs.lstatSync(file); return null; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? error.code : null; }
}
function copyDescription(value) {
  return structuredClone(value);
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
function restoreInstallationDescription(root, input) {
  const base = fs.statSync(root).isFile() ? path.dirname(root) : root;
  return description({ ...input, root, id: input.id || `${input.engine}:${root}`,
    files: input.files.map(file => ({ ...file, path: path.resolve(base, file.relative || file.path) })) });
}
function compactDescription(value) {
  const stored = installationDescription(value);
  return { ...stored, root: value.root, id: value.id,
    files: stored.files.map((file, index) => ({ ...file, path: value.files[index].path,
      ...(value.files[index].realPath ? { realPath: value.files[index].realPath } : {}) })) };
}
function label(value) {
  return require('./translator-label').label(value);
}
function displayText(value) { return String(value ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim(); }
// Raised when inspectDescription learns new facts, so retained descriptions
// are prepared again once.
const DESCRIPTION_FORMAT = 3;
function inspectionKey(root, options) {
  const { logger, userDataDir, signal, ...selection } = options;
  return JSON.stringify([fs.realpathSync(root), selection, DESCRIPTION_FORMAT]);
}
function unchangedInspection(entry) {
  return entry && Array.isArray(entry.observed) && entry.observed.length &&
    entry.observed.every(([file, identity]) => identity !== null && observedIdentity(file) === identity);
}
function inspectionFile(key, userDataDir) {
  return userDataDir && path.join(userDataDir, 'cache/translator-descriptions', require('node:crypto').createHash('sha256').update(key).digest('hex') + '.json');
}
// UI inventories read compact facts only. A missing or changed observation is
// filled by prepareTranslator in the existing backend worker, never here.
function cachedTranslator(root, options = {}) {
  let key;
  try {
    key = inspectionKey(root, options);
    let entry = inspections.get(key);
    if (!unchangedInspection(entry)) {
      inspections.delete(key);
      const file = inspectionFile(key, options.userDataDir);
      const stored = file && require('../../../core/json-files').readJsonObject(file);
      if (stored?.key !== key || !stored.value || !unchangedInspection(stored)) return null;
      entry = { value: stored.value, observed: stored.observed, live: false, persistedPath: file };
      inspections.set(key, entry);
    }
    if (!entry.peFactsSeeded) {
      const observed = new Map(entry.observed);
      for (const { path: logical, relative: _relative, apis: _apis, ...facts } of entry.value.files) {
        if (facts.format !== 'pe') continue;
        const source = fileIdentity(logical);
        if (!source || JSON.stringify(source) !== observed.get(logical)) continue;
        const realPath = fs.realpathSync(logical), identity = fileIdentity(realPath);
        if (!identity || JSON.stringify(identity.own) !== JSON.stringify(source.target || source.own)) continue;
        fileInspections.set(realPath, { identity: JSON.stringify(identity), value: { ...facts, realPath } });
      }
      entry.peFactsSeeded = true;
    }
    return copyDescription(compactDescription(entry.value));
  } catch { if (key) inspections.delete(key); return null; }
}
async function prepareTranslator(root, options = {}) {
  options.signal?.throwIfAborted();
  let value = cachedTranslator(root, options);
  if (!value) value = compactDescription(describeTranslator(root, options));
  let key;
  try { key = inspectionKey(root, options); } catch { return value; }
  const entry = inspections.get(key), file = inspectionFile(key, options.userDataDir);
  if (file && entry && entry.persistedPath !== file && unchangedInspection(entry)) {
    options.signal?.throwIfAborted();
    try {
      require('../../../core/json-files').writeJsonAtomic(file, { key, observed: entry.observed, value });
      entry.persistedPath = file;
    } catch (error) { warn(options.logger || console, `[translators] Could not retain component description: ${error.message}`); }
  }
  return copyDescription(value);
}
/** Synchronous custom-runtime.inspect seam; unchanged observed files reuse facts. */
function describeTranslator(root, options = {}) {
  let key;
  try { key = inspectionKey(root, options); }
  catch { return inspectDescription(root, options); }
  const previous = inspections.get(key);
  if (previous?.live !== false && unchangedInspection(previous)) return copyDescription(previous.value);
  const observed = new Map(), observe = file => { if (!observed.has(file)) observed.set(file, observedIdentity(file)); };
  const value = inspectDescription(root, options, observe);
  let result;
  try { result = copyDescription(value); } catch { return value; }
  if ([...observed].every(([file, identity]) => identity !== null && observedIdentity(file) === identity)) inspections.set(key, { value, observed: [...observed], live: true });
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
  // Without version text, a component takes the version of the framework
  // named after its engine, such as D3DMetal.framework, from the Resources
  // beside the framework binary: version.plist first, then Info.plist.
  if (!version) {
    const binary = files.find(file => file.format === 'macho' && path.basename(file.path).toLowerCase() === engine &&
      file.relative.toLowerCase().includes(`${engine}.framework${path.sep}`));
    if (binary) for (const name of ['version.plist', 'Info.plist']) {
      const file = path.join(path.dirname(binary.realPath || fs.realpathSync(binary.path)), 'Resources', name);
      observe(file);
      try {
        const real = fs.realpathSync(file);
        if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) continue;
        const value = readPlistFile(real)?.CFBundleShortVersionString;
        if (typeof value === 'string' && displayText(value)) { version = displayText(value); break; }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`Could not read optional framework version ${file}: ${error.message}`); }
    }
  }
  if (!version && (engine === 'moltenvk' || engine === 'kosmickrisp')) version = driverVersion(files, engine, warnings);
  apis = [...new Set([...apisForFiles(files), ...files.flatMap(file => {
    if (file.format === 'json') { try { const api = JSON.parse(fs.readFileSync(file.path, 'utf8')).ICD?.api_version; return api ? [`Vulkan ${api}`] : []; } catch {} }
    return [];
  })])];
  const floors = files.flatMap(file => file.macosFloor ? [file.macosFloor] : []);
  for (const warning of warnings) warn(logger, `[translators] ${warning}`);
  const result = description({ id: id || `${engine}:${root}`, root, component, engine, source, version, apis, form, files,
    warnings, ...(pluginDirectories === undefined ? {} : { pluginDirectories }),
    macosFloor: floors.sort(compareVersions).at(-1) || null });
  if (!result.version && engine === 'gstreamer') result.version = require('./gstreamer-source').libraryVersion(result);
  return result;
}
// A Vulkan driver without version text names its release in its library's
// strings: MoltenVK keeps its version as one string (it logs "MoltenVK
// version %s"), and Mesa's KosmicKrisp keeps "Mesa <version> (git-...)". A
// version is taken only when every slice names the same one.
const DRIVER_VERSION = Object.freeze({ moltenvk: /\0(\d+\.\d+\.\d+)\0/g, kosmickrisp: /\0Mesa (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)[ \0]/g });
function driverVersion(files, engine, warnings) {
  const versions = new Set();
  for (const file of files.filter(file => file.format === 'macho')) {
    try { for (const match of fs.readFileSync(file.realPath || file.path).toString('latin1').matchAll(DRIVER_VERSION[engine])) versions.add(match[1]); }
    catch (error) { warnings.push(`Could not read the driver version of ${file.path}: ${error.message}`); }
  }
  return versions.size === 1 ? [...versions][0] : '';
}
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  return 0;
}
function inspectFile(file) {
  const { unixImports: _legacyImports, ...result } = file;
  const original = fs.realpathSync(file.path), identity = fileIdentity(original), key = identity && JSON.stringify(identity);
  const previous = fileInspections.get(original);
  let facts = previous?.identity === key && key ? previous.value : null;
  if (!facts) {
    facts = inspectFileFacts(original);
    if (key && JSON.stringify(fileIdentity(original)) === key) fileInspections.set(original, { identity: key, value: facts });
    else fileInspections.delete(original);
  }
  return { ...result, ...copyDescription(facts),
    ...(facts.format === 'unknown' && file.path.endsWith('.json') ? { format: 'json' } : {}),
    ...(facts.format === 'macho' ? { form: file.path.endsWith('.so') ? 'builtin' : 'dylib' } : {}),
    apis: facts.format === 'pe' ? fileApis({ ...file, format: 'pe' }) : [] };
}
function inspectFileFacts(original) {
  const result = {};
  try {
    const native = readMachOLoadCommands(original, { imports: true });
    return { ...result, realPath: original, format: 'macho', cpuSlices: native.architectures,
      slices: native.slices, macosFloor: native.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort(compareVersions).at(-1) || null };
  } catch (error) {
    if (error.code !== 'MACHO_MALFORMED') result.inspectionWarning = error.message;
  }
  const exports = readPeExports(original, { imports: true }), pe = exports || readPeExports(original, { headersOnly: true, imports: true });
  if (pe) {
    if (!exports) result.inspectionWarning = 'PE export inspection is incomplete; basic image facts are available.';
    if (!pe.importsComplete) result.inspectionWarning = [result.inspectionWarning,
      `PE import inspection is incomplete: ${pe.importWarning || 'unknown import metadata'}`].filter(Boolean).join(' ');
    // Replacement DLL resources report Windows component versions, not translator releases.
    return { ...result, realPath: original, format: 'pe', form: pe.form, machine: pe.machine, architecture: pe.architecture, macosFloor: null,
      peImports: pe.peImports, importsComplete: pe.importsComplete, version: null };
  }
  return { ...result, format: 'unknown', macosFloor: null };
}
module.exports = { COMPONENTS, ENGINES, FORMS, description, installationDescription, restoreInstallationDescription, label,
  cachedTranslator, prepareTranslator, describeTranslator, inspectFile, compareVersions };
