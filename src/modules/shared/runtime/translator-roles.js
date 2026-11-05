const path = require('node:path');

// API vocabulary is independent of the project/version that supplies its files.
const ROLES = Object.freeze([
  { id: 'd3d8', label: 'Direct3D 8', settingsKey: 'translatorD3D8', apis: ['Direct3D 8'] },
  { id: 'd3d9', label: 'Direct3D 9', settingsKey: 'translatorD3D9', apis: ['Direct3D 9'] },
  { id: 'd3d10', label: 'Direct3D 10 / 10.1', settingsKey: 'translatorD3D10', apis: ['Direct3D 10', 'Direct3D 10.1'] },
  { id: 'd3d11', label: 'Direct3D 11', settingsKey: 'translatorD3D11', apis: ['Direct3D 11'] },
  { id: 'd3d12', label: 'Direct3D 12', settingsKey: 'translatorD3D12', apis: ['Direct3D 12'] },
  { id: 'vulkan-driver', label: 'Vulkan driver', settingsKey: 'translatorVulkan', apis: [] },
  { id: 'video', label: 'Video codecs', settingsKey: 'translatorVideo', apis: [] }
].map(role => Object.freeze({ ...role, apis: Object.freeze(role.apis), optionsKey: role.settingsKey + 'Options' })));
const DIRECT3D_ROLES = Object.freeze(ROLES.filter(role => role.id.startsWith('d3d')));

function fileApis(file) {
  if (file?.format !== 'pe') return [];
  const match = path.basename(file.path || file.relative || '').match(/^d3d(\d+)(?:_(\d+))?(?:core)?\.dll$/i);
  return match ? [`Direct3D ${match[1]}${match[2] ? '.' + match[2] : ''}`] : [];
}
function apisForFiles(files = []) { return [...new Set(files.flatMap(fileApis))]; }
function usedForApi(plan, roleId) {
  const rows = plan?.components || {};
  if (Object.hasOwn(rows, roleId)) return rows[roleId]?.used || null;
  if (plan?.apiMode || !roleId?.startsWith('d3d')) return null;
  return rows[roleId === 'd3d12' ? 'd3d12' : 'd3d-renderer']?.used || null;
}
function usedRenderers(plan) {
  const values = DIRECT3D_ROLES.map(role => usedForApi(plan, role.id));
  if (!plan?.apiMode) values.push(plan?.components?.['d3d-renderer']?.used);
  values.push(...(plan?.additional || []));
  const seen = new Set();
  return values.filter(value => {
    if (!value) return false;
    const key = value.id ? value.id + '\0' + (value.root || '') : value;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

module.exports = { ROLES, DIRECT3D_ROLES, fileApis, apisForFiles, usedForApi, usedRenderers };
