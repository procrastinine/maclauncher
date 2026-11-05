const fs = require('node:fs'), path = require('node:path');
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
  root = path.resolve(root);
  const files = [], visited = new Set();
  function visit(file) {
    const real = fs.realpathSync(file), stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (visited.has(real)) return;
      visited.add(real);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else if (stat.isFile()) {
      const relative = path.relative(root, file);
      if (/\.(?:dll|so|dylib|json)$/i.test(file) || /\.framework\//.test(file) && !path.extname(file))
        files.push({ path: file, relative });
    }
  }
  visit(root);
  component ||= ['moltenvk', 'kosmickrisp'].includes(engine) ? 'vulkan-driver' : engine === 'vkd3d-proton' ? 'd3d12' : engine === 'gstreamer' ? 'video' : 'd3d-renderer';
  form ||= component === 'vulkan-driver' ? 'icd' : component === 'video' ? 'dylib' : 'builtin';
  return description({ id: id || `${engine}:${root}`, root, component, engine, source, version, apis, form, files });
}
module.exports = { COMPONENTS, ENGINES, FORMS, description, label, describeTranslator };
