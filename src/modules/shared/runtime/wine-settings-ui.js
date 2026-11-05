const Wine = require('./wine-settings');
const option = (value, label) => ({ value, label });
const tri = (key, label, section, extra = {}) => ({ key, label, section, advanced: section !== 'Basic', type: 'select', options: [option('', 'Runtime default'), option('on', 'On'), option('off', 'Off')], ...extra });
const engine = (key, value) => ({ visibleWhen: [{ key, equals: value }] });
function fields() {
  return [
    tri('retina', 'High Resolution (Retina)', 'Basic'),
    { key: 'dpi', label: 'DPI', type: 'string', section: 'Display', advanced: true, description: '48–768; empty uses the runtime default.' },
    tri('fullscreenCapture', 'Fullscreen display capture', 'Display'), tri('verticalSync', 'Vertical sync', 'Display'),
    { key: 'virtualDesktop', label: 'Virtual desktop', type: 'select', section: 'Display', advanced: true, options: [option('', 'Runtime default'), option('off', 'Off'), ...['1280x720', '1920x1080', '2560x1440', '3840x2160'].map(v => option(v, v))] },
    tri('optionAsAlt', 'Option as Alt', 'Input'), tri('commandAsCtrl', 'Command as Ctrl', 'Input'), tri('mouseCapture', 'Mouse capture', 'Input'),
    { key: 'advertiseAvx', label: 'Advertise AVX under Rosetta', type: 'boolean', section: 'Compatibility', advanced: true },
    { key: 'wineD3dConfig', label: 'WineD3D options', type: 'string', section: 'Compatibility', advanced: true, description: 'Comma-separated WineD3D options, such as csmt=0x1,renderer=gl.', ...engine('graphicsBackend', 'wined3d') },
    tri('dxvkAsync', 'DXVK async', 'Compatibility', engine('graphicsBackend', 'dxvk')),
    { key: 'dxmtConfig', label: 'DXMT configuration', type: 'select', section: 'Compatibility', advanced: true, options: [option('', 'Runtime default'), ...[30, 60, 120].map(v => option(`d3d11.preferredMaxFrameRate=${v}`, `${v} FPS`))], ...engine('graphicsBackend', 'dxmt') },
    tri('metalFxSpatial', 'MetalFX spatial', 'Compatibility', engine('graphicsBackend', 'dxmt')),
    { key: 'd3dMetalMaxFps', label: 'D3DMetal FPS limit', type: 'select', section: 'Compatibility', advanced: true, options: [option('', 'Runtime default'), ...[30, 60, 120, 144, 240].map(v => option(String(v), String(v)))], ...engine('graphicsBackend', 'd3dmetal') },
    tri('d3dMetal4', 'D3DMetal Metal 4', 'Compatibility', engine('graphicsBackend', 'd3dmetal')),
    tri('moltenVkFastMath', 'MoltenVK fast math', 'Compatibility', engine('vulkanBackend', 'moltenvk')),
    tri('moltenVkArgumentBuffers', 'MoltenVK argument buffers', 'Compatibility', engine('vulkanBackend', 'moltenvk')),
    tri('moltenVkUe4', 'MoltenVK UE4 compatibility', 'Compatibility', engine('vulkanBackend', 'moltenvk')),
    tri('metalHud', 'Metal Performance HUD', 'Diagnostics'),
    { key: 'dxvkHud', label: 'DXVK HUD', type: 'select', section: 'Diagnostics', advanced: true, options: [option('', 'Runtime default'), option('0', 'Off'), option('fps', 'FPS'), option('fps,frametimes,devinfo', 'Performance'), option('full', 'Full')], ...engine('graphicsBackend', 'dxvk') },
    tri('crashDialog', 'Wine crash dialog', 'Diagnostics'),
  ];
}
function withSettings(manifest) {
  const result = structuredClone(manifest);
  for (const [id, runtime] of Object.entries(result.runtime.entries)) {
    const schema = runtime.settings;
    schema.fields = schema.fields.filter(f => f.key !== 'advertiseAvx');
    for (const field of schema.fields) {
      field.advanced = ['dllOverrides', 'environment', 'bepInExWinhttp', 'wineDebug', 'graphicsBridgeVersion', 'vulkanBackend', 'cncDdraw'].includes(field.key);
      field.section = field.key === 'wineDebug' ? 'Diagnostics' : field.advanced ? 'Compatibility' : 'Basic';
    }
    schema.fields.push(...fields());
    for (const field of fields()) if (!Object.hasOwn(schema.defaults, field.key)) schema.defaults[field.key] = '';
    const versions = Object.entries(Wine.WINDOWS_VERSIONS).map(([value, label]) => option(value, label));
    if (id === 'crossover') {
      schema.defaults.windowsVersion = '';
      schema.fields.push({key: 'windowsVersion', label: 'Per-launch Windows version', section: 'Basic', type: 'select', options: [option('', 'Bottle version'), ...versions]});
    } else schema.fields.find(f => f.key === 'windowsVersion').options = versions;
    schema.fields.sort((a,b) => Number(Boolean(a.advanced)) - Number(Boolean(b.advanced)) || ['Basic','Display','Input','Compatibility','Diagnostics'].indexOf(a.section) - ['Basic','Display','Input','Compatibility','Diagnostics'].indexOf(b.section));
  }
  return result;
}
module.exports = { withSettings, fields };
