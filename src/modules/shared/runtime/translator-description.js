const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { readPeExports } = require('./pe-exports');
const { fileApis, apisForFiles } = require('./translator-roles');
const warn = require('../graphics-warning');
// Ordinary runtime managers expose these descriptions through their installed
// records. Paths refer to installed files, never to a second translator cache.
const COMPONENTS = Object.freeze(['d3d-renderer', 'vulkan-driver', 'd3d12', 'video']);
const ENGINES = Object.freeze(['d3dmetal', 'dxmt', 'dxvk', 'wined3d', 'moltenvk', 'kosmickrisp', 'vkd3d-proton', 'gstreamer']);
const FORMS = Object.freeze(['builtin', 'native', 'icd', 'dylib']);

/**
 * A description has id, component, engine, version, source, apis, form, root,
 * files, macosFloor and unixImports. Each file has path (absolute), optional
 * relative (installation-relative placement), form, apis, machine (PE number),
 * cpuSlices (Mach-O names), macosFloor and unixImports. Imports are
 * { symbol, library, weak? }; library is the Mach-O dependency install name.
 * source may be a catalog id, 'custom', or { kind, id, label, runtime? }.
 * Mixed packages use a per-file form. Unknown fields are retained and ignored.
 * Binary facts are populated by inspectDescription, independently of labels.
 */
function description(input) {
  if (!input || !input.component || !input.engine || !input.form)
    throw new TypeError('A translator component, engine and form are required.');
  if (!Array.isArray(input.files)) throw new TypeError('Translator files are required.');
  const files = input.files.map(file => ({ ...file, ...(file.format === 'pe' ? { apis: fileApis(file) } : {}) }));
  return { ...input, apis: input.apis?.length ? [...input.apis] : apisForFiles(files), files,
    unixImports: [...(input.unixImports || [])], version: String(input.version || '') };
}
function label(value) {
  if (!value) return '';
  const names = { d3dmetal: 'D3DMetal', dxmt: 'DXMT', dxvk: 'DXVK', wined3d: 'WineD3D',
    moltenvk: 'MoltenVK', kosmickrisp: 'KosmicKrisp', 'vkd3d-proton': 'vkd3d-proton', gstreamer: 'GStreamer' };
  const source = typeof value.source === 'object' ? value.source.label || value.source.id : value.source;
  return [names[value.engine] || value.engine, value.version, source ? `(${source})` : ''].filter(Boolean).join(' ');
}
/** Synchronous custom-runtime.inspect seam. Walks the chosen component root. */
function describeTranslator(root, { engine, source, version, component, id, apis = [], form, logger = console } = {}) {
  root = fs.realpathSync(root);
  const files = [], visited = new Set(), warnings = [];
  function visit(file, entry) {
    const framework = file.match(/([^/]+)\.framework\//), required = /\.(?:dll|so|dylib)$/i.test(file) || framework?.[1] === path.basename(file);
    const binary = required || framework && !path.extname(file), json = /\.json$/i.test(file);
    if (entry?.isFile() && !binary && !json) return;
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
  try {
    if (fs.statSync(versionFile).isFile()) {
      if (!fs.realpathSync(versionFile).startsWith(root + path.sep)) throw new Error('Optional version text is outside its component root.');
      version = fs.readFileSync(versionFile, 'utf8').trim() || version;
    }
  }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`Could not read optional component version ${versionFile}: ${error.message}`); }
  apis = [...new Set([...apisForFiles(files), ...files.flatMap(file => {
    if (file.format === 'json') { try { const api = JSON.parse(fs.readFileSync(file.path, 'utf8')).ICD?.api_version; return api ? [`Vulkan ${api}`] : []; } catch {} }
    return [];
  })])];
  const floors = files.flatMap(file => file.macosFloor ? [file.macosFloor] : []);
  for (const warning of warnings) warn(logger, `[translators] ${warning}`);
  return description({ id: id || `${engine}:${root}`, root, component, engine, source, version, apis, form, files,
    warnings,
    macosFloor: floors.sort(compareVersions).at(-1) || null,
    unixImports: files.flatMap(file => file.unixImports || []) });
}
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  return 0;
}
function inspectFile(file) {
  const result = { ...file };
  try {
    const native = readMachOLoadCommands(file.path, { imports: true });
    return { ...result, format: 'macho', form: file.path.endsWith('.so') ? 'builtin' : 'dylib', apis: [], cpuSlices: native.architectures,
      slices: native.slices, macosFloor: native.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort(compareVersions).at(-1) || null,
      unixImports: native.slices.flatMap(slice => slice.imports.map(item => ({ ...item, architecture: slice.architecture }))) };
  } catch (error) {
    if (error.code !== 'MACHO_MALFORMED') result.inspectionWarning = error.message;
  }
  const original = fs.realpathSync(file.path), exports = readPeExports(original), pe = exports || readPeExports(original, { headersOnly: true });
  if (pe) {
    if (!exports) result.inspectionWarning = 'PE export inspection is incomplete; basic image facts are available.';
    // Replacement DLL resources report Windows component versions, not translator releases.
    return { ...result, format: 'pe', form: pe.form, machine: pe.machine, architecture: pe.architecture, macosFloor: null, unixImports: [],
      apis: fileApis({ ...file, format: 'pe' }), version: null };
  }
  return { ...result, format: file.path.endsWith('.json') ? 'json' : 'unknown', apis: [], macosFloor: null, unixImports: [] };
}
module.exports = { COMPONENTS, ENGINES, FORMS, description, label, describeTranslator, inspectFile, compareVersions };
