const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { readPeExports } = require('./pe-exports');
const { readPeVersion } = require('./pe-version');
// Ordinary runtime managers expose these descriptions through their installed
// records. Paths refer to installed files, never to a second translator cache.
const COMPONENTS = Object.freeze(['d3d-renderer', 'vulkan-driver', 'd3d12', 'video']);
const ENGINES = Object.freeze(['d3dmetal', 'dxmt', 'dxvk', 'wined3d', 'moltenvk', 'kosmickrisp', 'vkd3d-proton', 'gstreamer']);
const FORMS = Object.freeze(['builtin', 'native', 'icd', 'dylib']);

/**
 * A description has id, component, engine, version, source, apis, form, root,
 * files, macosFloor and unixImports. Each file has path (absolute), optional
 * relative (installation-relative placement), form, machine (PE number),
 * cpuSlices (Mach-O names), macosFloor and unixImports. Imports are
 * { symbol, library, weak? }; library is the Mach-O dependency install name.
 * source may be a catalog id, 'custom', or { kind, id, label, runtime? }.
 * Mixed packages use a per-file form. Unknown fields are retained and ignored.
 * Binary facts are populated by inspectDescription, independently of labels.
 */
function description(input) {
  if (!input || !COMPONENTS.includes(input.component) || !ENGINES.includes(input.engine))
    throw new TypeError('A translator component and engine are required.');
  if (!FORMS.includes(input.form)) throw new TypeError('A translator form is required.');
  if (!Array.isArray(input.files)) throw new TypeError('Translator files are required.');
  return { ...input, apis: [...(input.apis || [])], files: input.files.map(file => ({ ...file })),
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
function describeTranslator(root, { engine, source, version, component, id, apis = [], form } = {}) {
  root = fs.realpathSync(root);
  const files = [], visited = new Set();
  function visit(file) {
    const real = fs.realpathSync(file), stat = fs.statSync(file);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('A translator link escapes its component root.');
    if (stat.isDirectory()) {
      if (visited.has(real)) return;
      visited.add(real);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else if (stat.isFile()) {
      const relative = path.relative(root, file) || path.basename(file);
      if (/\.(?:dll|so|dylib|json)$/i.test(file) || /\.framework\//.test(file) && !path.extname(file))
        files.push(inspectFile({ path: file, relative }));
    }
  }
  visit(root);
  component ||= ['moltenvk', 'kosmickrisp'].includes(engine) ? 'vulkan-driver' : engine === 'vkd3d-proton' ? 'd3d12' : engine === 'gstreamer' ? 'video' : 'd3d-renderer';
  form ||= component === 'vulkan-driver' ? 'icd' : component === 'video' ? 'dylib' : 'builtin';
  const pe = files.find(file => file.format === 'pe');
  if (component !== 'vulkan-driver' && component !== 'video') form = pe?.form || form;
  const versionFile = path.join(root, 'version');
  if (fs.existsSync(versionFile) && fs.statSync(versionFile).isFile()) version = fs.readFileSync(versionFile, 'utf8').trim() || version;
  version ||= pe?.version;
  const floors = files.flatMap(file => file.macosFloor ? [file.macosFloor] : []);
  return description({ id: id || `${engine}:${root}`, root, component, engine, source, version, apis, form, files,
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
    return { ...result, format: 'macho', form: file.path.endsWith('.so') ? 'builtin' : 'dylib', cpuSlices: native.architectures,
      slices: native.slices, macosFloor: native.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort(compareVersions).at(-1) || null,
      unixImports: native.slices.flatMap(slice => slice.imports.map(item => ({ ...item, architecture: slice.architecture }))) };
  } catch (error) {
    if (error.code !== 'MACHO_MALFORMED') result.inspectionWarning = error.message;
  }
  const pe = readPeExports(fs.realpathSync(file.path));
  if (pe) {
    const version = readPeVersion(file.path);
    return { ...result, format: 'pe', form: pe.form, machine: pe.machine, macosFloor: null, unixImports: [],
      version: version?.strings?.ProductVersion || version?.productVersion || null };
  }
  return { ...result, format: file.path.endsWith('.json') ? 'json' : 'unknown', macosFloor: null, unixImports: [] };
}
module.exports = { COMPONENTS, ENGINES, FORMS, description, label, describeTranslator, inspectFile, compareVersions };
