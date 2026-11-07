const path = require('node:path');
const Roles = require('./translator-roles');
const { label } = require('./translator-description');

const isDxgi = file => file.format === 'pe' && path.basename(file.path).toLowerCase() === 'dxgi.dll';
const explicit = row => row?.selected && !row.projected && !['automatic', 'inherit'].includes(row.value);
function dxgiFiles(description) {
  const files = description?.files || [], wanted = new Set(files.filter(isDxgi));
  for (const file of wanted) {
    for (const imported of file.peImports || []) for (const other of files)
      if (other.format === 'pe' && other.machine === file.machine && path.basename(other.path).toLowerCase() === imported.toLowerCase()) wanted.add(other);
    const unix = files.find(other => other.format === 'macho' && path.basename(other.path) === path.basename(file.path).replace(/\.dll$/i, '.so'));
    if (unix) wanted.add(unix);
    for (const dependency of (file.slices || []).flatMap(slice => slice.dependencies || [])) for (const other of files)
      if (other.format === 'macho' && path.basename(other.path) === path.basename(dependency.path)) wanted.add(other);
  }
  return [...wanted];
}
function resolvePairing(plan, { choices = [], included = [], compatibility = {}, apiCompatibility = {}, filesForRole }) {
  delete plan.dxgiBinding; delete plan.requiredTranslators; delete plan.pairingError;
  const rows = plan.components, candidates = [...choices, ...included];
  const checked = (item, role) => apiCompatibility[role]?.[item.id] || compatibility[item.id];
  const usable = (item, role) => item && checked(item, role)?.compatible !== false;
  const described = (item, role) => checked(item, role)?.files ? { ...item, files: checked(item, role).files } : item;
  const originalD3D12 = { ...rows.d3d12 };
  let ownerRole = ['d3d12', 'd3d11', 'd3d10'].find(role => explicit(rows[role]) && rows[role].used && !rows[role].fallback) ||
    (rows.d3d12.used ? 'd3d12' : null);
  const missing = (engine, reason, role = ownerRole || 'd3d12') => {
    plan.requiredTranslators = [engine]; plan.pairingError = reason;
    rows[role].used = null; rows[role].fallback = true; rows[role].reasonCode = 'dxgi-pairing'; rows[role].reason = reason;
    return true;
  };
  const currentDxgi = ownerRole ? rows[ownerRole].used :
    [rows.d3d11?.used, rows.d3d10?.used, rows['d3d-renderer'].used].find(item => item?.files?.some(isDxgi));
  // Wine's automatic D3D12 cannot share DXVK DXGI with upstream vkd3d.
  if (!explicit(rows.d3d12) && rows.d3d12.used?.engine !== 'vkd3d-proton' && currentDxgi?.engine === 'dxvk' &&
      currentDxgi.files?.some(isDxgi) && included.some(item => item.engine === 'vkd3d')) {
    const proton = candidates.find(item => item.engine === 'vkd3d-proton' && usable(item, 'd3d12'));
    if (!proton) return missing('vkd3d-proton', 'DXVK DXGI requires vkd3d-proton for Direct3D 12. Play installs the matching translator after confirmation.', 'd3d12');
    if (rows.d3d12.inherited) {
      rows.d3d12.fallback = true; rows.d3d12.reasonCode = 'dxgi-pairing'; rows.d3d12.reason = 'DXVK DXGI requires vkd3d-proton for Direct3D 12.';
    }
    rows.d3d12.used = described(proton, 'd3d12');
    ownerRole ||= 'd3d12';
  }
  if (!ownerRole) return false;
  const owner = rows[ownerRole].used;
  const family = { 'vkd3d-proton': 'dxvk', vkd3d: 'wined3d' }[owner.engine] || owner.engine;
  const familyLabel = family === 'wined3d' ? "Wine's" : label({ engine: family });
  const ownerLabel = label({ engine: owner.engine }) + ' ' + Roles.ROLES.find(role => role.id === ownerRole).label;
  const machines = new Set(owner.files.filter(file => file.format === 'pe').map(file => file.machine));
  const providerRole = ownerRole === 'd3d12' ? 'd3d11' : ownerRole;
  // An explicit API owns its exact DXGI/Unix closure, not another version of
  // the same engine. Proton and Wine vkd3d have separately supplied DXGI.
  const ownDxgi = family === owner.engine;
  const ordered = ownDxgi ? [...candidates.filter(item => item.id === owner.id || item.root && item.root === owner.root), owner] :
    [rows.d3d11?.used, rows.d3d10?.used, rows['d3d-renderer'].used, ...candidates];
  // Absent DXGI facts still leave physical bridge conflicts authoritative.
  if (ownDxgi && !ordered.some(item => item.files?.some(isDxgi))) return false;
  const partner = ordered.find(item => item?.engine === family && usable(item, providerRole) &&
    [...machines].every(machine => dxgiFiles(described(item, providerRole)).some(file => isDxgi(file) && file.machine === machine)));
  if (!partner) return missing(family, ownerLabel + ' requires ' + familyLabel + ' DXGI. Play installs the matching translator after confirmation.');
  const selected = described(partner, providerRole), binding = dxgiFiles(selected);
  const bindingRoles = [ownerRole];
  if (ownerRole !== 'd3d12' && !explicit(rows.d3d12)) {
    const engine = family === 'dxvk' ? 'vkd3d-proton' : family === 'wined3d' ? 'vkd3d' : family;
    const companion = engine === 'vkd3d-proton' ? (rows.d3d12.used?.engine === engine ? rows.d3d12.used : null) : candidates.find(item => item.engine === engine &&
      (engine === 'vkd3d' || item.root === partner.root) && item.apis?.includes('Direct3D 12') && usable(item, 'd3d12'));
    if (rows.d3d12.inherited && rows.d3d12.used?.id !== companion?.id) {
      rows.d3d12.fallback = true; rows.d3d12.reasonCode = 'dxgi-pairing';
      rows.d3d12.reason = ownerLabel + ' requires a matching Direct3D 12 implementation.';
    }
    rows.d3d12.used = companion ? described(companion, 'd3d12') : null;
    if (companion) bindingRoles.push('d3d12');
  }
  const updates = [];
  for (const role of Roles.DIRECT3D_ROLES.filter(role => role.id !== 'd3d12')) {
    const row = rows[role.id], implicit = !explicit(row);
    const ownsDxgi = row.used && filesForRole(row.used, role).some(isDxgi);
    const matching = row.used && (ownsDxgi ? filesForRole(row.used, role).filter(isDxgi).every(file =>
      binding.some(other => (other.realPath || other.path) === (file.realPath || file.path))) : row.used.engine === family);
    if (matching || !implicit && !ownsDxgi) continue;
    const replacement = usable(partner, role.id) && (!partner.apis?.length || partner.apis.some(api => role.apis.includes(api))) ? described(partner, role.id) : null;
    if (!replacement && !['d3d10', 'd3d11'].includes(role.id)) continue;
    if (!replacement) {
      // A partial provider cannot replace this API. Let the existing physical
      // bindings report any actual collision instead of inventing a download.
      if (ownerRole !== 'd3d12') { Object.assign(rows.d3d12, originalD3D12); return false; }
      return missing(family, 'The selected DXGI provider has no compatible Direct3D 10/11 libraries.');
    }
    const conflicts = !implicit || row.inherited && row.used?.id !== replacement.id;
    updates.push({ row, replacement, conflicts });
  }
  plan.dxgiBinding = { description: selected, files: binding, roles: bindingRoles };
  for (const { row, replacement, conflicts } of updates) {
    row.used = replacement;
    if (conflicts) {
      row.fallback = true; row.reasonCode = 'dxgi-pairing';
      row.reason = ownerLabel + ' requires ' + familyLabel + ' DXGI. This API uses the matching provider instead of its incompatible saved choice.';
    }
  }
  return true;
}
module.exports = { resolvePairing, isDxgi };
