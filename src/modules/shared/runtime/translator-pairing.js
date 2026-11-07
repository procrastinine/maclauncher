const path = require('node:path');
const Roles = require('./translator-roles');

const isDxgi = file => file.format === 'pe' && path.basename(file.path).toLowerCase() === 'dxgi.dll';
const explicit = row => row?.selected && !['automatic', 'inherit'].includes(row.value);
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
  const missing = (engine, reason) => {
    plan.requiredTranslators = [engine]; plan.pairingError = reason;
    rows.d3d12.used = null; rows.d3d12.fallback = true; rows.d3d12.reasonCode = 'dxgi-pairing'; rows.d3d12.reason = reason;
    return true;
  };
  let d3d12 = rows.d3d12.used;
  const currentDxgi = [rows.d3d11?.used, rows.d3d10?.used, rows['d3d-renderer'].used].find(item => item?.files?.some(isDxgi));
  // A runtime's automatic D3D12 would otherwise remain Wine's builtin DLL
  // behind DXVK's DXGI. Give it the corresponding D3D12 implementation too.
  if (!d3d12 && !explicit(rows.d3d12) && currentDxgi?.engine === 'dxvk' && included.some(item => item.engine === 'vkd3d')) {
    const proton = candidates.find(item => item.engine === 'vkd3d-proton' && usable(item, 'd3d12'));
    if (!proton) return missing('vkd3d-proton', 'DXVK DXGI requires vkd3d-proton for Direct3D 12. Play installs the matching translator after confirmation.');
    d3d12 = rows.d3d12.used = described(proton, 'd3d12');
  }
  if (!['vkd3d-proton', 'vkd3d'].includes(d3d12?.engine)) return false;
  const family = d3d12.engine === 'vkd3d-proton' ? 'dxvk' : 'wined3d';
  const machines = new Set(d3d12.files.filter(file => file.format === 'pe').map(file => file.machine));
  const ordered = [rows.d3d11?.used, rows.d3d10?.used, rows['d3d-renderer'].used, ...candidates];
  const partner = ordered.find(item => item?.engine === family && usable(item, 'd3d11') &&
    [...machines].every(machine => dxgiFiles(described(item, 'd3d11')).some(file => isDxgi(file) && file.machine === machine)));
  if (!partner) return missing(family, `${d3d12.engine} requires ${family === 'dxvk' ? 'DXVK' : "Wine's"} DXGI. Play installs the matching translator after confirmation.`);
  const selected = described(partner, 'd3d11'), binding = dxgiFiles(selected);
  if (![...machines].every(machine => binding.some(file => isDxgi(file) && file.machine === machine)))
    return missing(family, 'The Direct3D 12 translator and its DXGI provider need matching Windows CPU architectures.');
  plan.dxgiBinding = { description: selected, files: binding, roles: ['d3d12'] };
  for (const role of Roles.DIRECT3D_ROLES.filter(role => role.id !== 'd3d12')) {
    const row = rows[role.id], implicit = !explicit(row) && !explicit(rows['d3d-renderer']);
    const ownsDxgi = row.used && filesForRole(row.used, role).some(isDxgi);
    const matching = row.used?.engine === family && (!ownsDxgi || filesForRole(row.used, role).filter(isDxgi).every(file => binding.some(other => other.path === file.path)));
    if (matching || !implicit && !ownsDxgi) continue;
    const replacement = usable(partner, role.id) && (!partner.apis?.length || partner.apis.some(api => role.apis.includes(api))) ? described(partner, role.id) : null;
    if (!replacement && !['d3d10', 'd3d11'].includes(role.id)) continue;
    if (!replacement) return missing(family, 'The selected DXGI provider has no compatible Direct3D 10/11 libraries.');
    row.used = replacement;
    if (!implicit) {
      row.fallback = true; row.reasonCode = 'dxgi-pairing';
      row.reason = `${d3d12.engine} Direct3D 12 requires ${family === 'dxvk' ? 'DXVK' : "Wine's"} DXGI. This API uses the matching provider instead of its incompatible saved choice.`;
    }
  }
  return true;
}
module.exports = { resolvePairing, isDxgi };
