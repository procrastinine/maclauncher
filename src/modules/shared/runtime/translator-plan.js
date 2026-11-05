const { COMPONENTS, label } = require('./translator-description');
const AUTOMATIC = 'automatic', INHERIT = 'inherit';
const Roles = require('./translator-roles');
const fs = require('node:fs'), path = require('node:path');
const { fileDigest } = require('./verified-identity');

// Legacy settings are projected for display and consumers without writing or
// changing their existing automatic/backend choice.
function projectRoles(plan) {
  for (const role of Roles.DIRECT3D_ROLES) {
    if (role.id === 'd3d12') continue;
    const base = plan.components['d3d-renderer'];
    const additional = (plan.additional || []).find(item => item.apis?.some(api => role.apis.includes(api)));
    const used = additional || base.used;
    const supported = !used?.apis?.length || used.apis.some(api => role.apis.includes(api));
    plan.components[role.id] = { ...base, used: supported ? used : null, projected: true };
  }
  return plan;
}
const serves = (description, role) => !description?.apis?.length || description.apis.some(api => role.apis.includes(api));
const findChoice = (choices, value) => choices.find(item => item.id === value) || choices.find(item => item.aliases?.includes(value)) || null;
const identity = description => description && `${description.id}:${description.root || ''}`;
function filesForRole(description, role) {
  const files = description?.files || [], primary = files.filter(file => Roles.fileApis(file).some(api => role.apis.includes(api)));
  if (!primary.length || primary.some(file => file.importsComplete !== true)) return files;
  const otherImports = new Set(files.filter(file => file.format === 'pe' && Roles.fileApis(file).length && !primary.includes(file)).flatMap(file => file.peImports || []));
  const wanted = new Set([...primary, ...files.filter(file => file.format === 'pe' && !Roles.fileApis(file).length &&
    path.basename(file.path).toLowerCase() !== 'dxgi.dll' && !otherImports.has(path.basename(file.path).toLowerCase()))]);
  // DXGI is shared by the DXGI-based APIs; this is an API relationship, not an
  // engine/version rule. Other companions follow actual direct PE imports.
  if (['d3d10', 'd3d11', 'd3d12'].includes(role.id)) for (const file of files)
    if (file.format === 'pe' && path.basename(file.path).toLowerCase() === 'dxgi.dll') wanted.add(file);
  for (const file of wanted) for (const name of file.peImports || []) for (const candidate of files)
    if (candidate.format === 'pe' && path.basename(candidate.path).toLowerCase() === name.toLowerCase()) wanted.add(candidate);
  const native = new Set(files.filter(file => {
    if (file.format !== 'macho') return false;
    const counterpart = file.path.endsWith('.so') && files.find(other => other.format === 'pe' &&
      path.basename(other.path).toLowerCase() === path.basename(file.path).replace(/\.so$/, '.dll').toLowerCase());
    return !counterpart || wanted.has(counterpart);
  }));
  for (const file of native) for (const dependency of (file.slices || []).flatMap(slice => slice.dependencies || []))
    for (const candidate of files) if (candidate.format === 'macho' && path.basename(candidate.path) === path.basename(dependency.path)) native.add(candidate);
  return files.filter(file => file.format === 'pe' ? wanted.has(file) : file.format === 'macho' ? native.has(file) : true);
}
function logicalPlacementKey(file) {
  const name = path.basename(file.path).toLowerCase();
  return file.format === 'pe' ? `pe:${file.machine}:${name}` : file.format === 'macho' && file.path.endsWith('.so') ? `unix:${name}` : `source:${file.path}`;
}
function placementKey(file) {
  // Distinct Unix aliases still share the one private bridge/framework binding.
  if (file.format === 'macho' && path.basename(file.realPath || file.path) === 'libd3dshared.dylib')
    return 'external:libd3dshared.dylib';
  return logicalPlacementKey(file);
}
const physicalSource = file => file.realPath || file.path;
function sameComponent(first, second, role) {
  if (first.engine !== second.engine) return false;
  const a = role ? filesForRole(first, role) : first.files || [], b = role ? filesForRole(second, role) : second.files || [];
  if (!a.length || !b.length) return first.id === second.id && first.root && first.root === second.root && a.length === b.length;
  if (a.length !== b.length) return false;
  return a.every(file => b.some(other => {
    if (logicalPlacementKey(file) !== logicalPlacementKey(other) || file.form !== other.form) return false;
    if (physicalSource(file) === physicalSource(other)) return true;
    try { return fs.realpathSync(file.path) === fs.realpathSync(other.path) || fileDigest(file.path).sha256 === fileDigest(other.path).sha256; }
    catch { return false; } // Unknown file facts do not hide a choice.
  }));
}
function uniqueComponents(items, role, selected, sameScope = () => true) {
  const result = [];
  for (const item of items) {
    const index = result.findIndex(other => sameComponent(item, other, role) && sameScope(item, other));
    if (index < 0) result.push(item);
    else if (selected?.id === item.id || selected?.id !== result[index].id && (item.apis?.length || 0) > (result[index].apis?.length || 0)) result[index] = item;
  }
  return result;
}
function offeredForm(item, runtime, role) {
  const form = item.source?.optionsRuntimeForms?.[runtime];
  if (form !== 'builtin' && form !== 'native') return true;
  const primary = (item.files || []).filter(file => file.format === 'pe' &&
    (role ? Roles.fileApis(file).some(api => role.apis.includes(api)) : Roles.fileApis(file).length));
  const known = primary.map(file => file.form).filter(Boolean);
  return !known.length || known.includes(form);
}
function physicalPlacements(plan) {
  const placements = new Map(), bindings = new Map(), conflicts = [];
  const place = (file, description, roles) => {
    const key = placementKey(file), logicalKey = logicalPlacementKey(file), previous = placements.get(logicalKey), binding = bindings.get(key);
    const occupied = previous && physicalSource(previous.file) !== physicalSource(file) ? previous :
      binding && physicalSource(binding.file) !== physicalSource(file) ? binding : null;
    if (occupied) { conflicts.push({ key: occupied === previous ? logicalKey : key, roles: [...new Set([...occupied.roles, ...roles])] }); return; }
    const consumers = binding?.roles || previous?.roles || [];
    for (const role of roles) if (!consumers.includes(role)) consumers.push(role);
    if (!binding) bindings.set(key, { file, roles: consumers });
    if (previous) previous.roles = consumers;
    else placements.set(logicalKey, { file, description, roles: consumers });
  };
  for (const role of Roles.DIRECT3D_ROLES) {
    const description = plan.components[role.id]?.used;
    if (!description) continue;
    for (const file of filesForRole(description, role)) place(file, description, [role.id]);
  }
  for (const description of (plan.additional || []).filter(item => !item.apis?.length))
    for (const file of description.files || []) place(file, description, []);
  return { placements: [...placements.values()], conflicts };
}
function apiGroups(plan) {
  if (plan.runtime === 'crossover' && !plan.components['d3d-renderer'].used && !plan.apiMode) {
    const roles = Roles.DIRECT3D_ROLES.map(role => role.id);
    return [{ id: roles.join('+'), roles, affectedRoles: roles, label: 'Direct3D', reason: 'runtime-global-automatic' }];
  }
  const groups = [];
  if (plan.apiMode) {
    for (const role of Roles.DIRECT3D_ROLES) groups.push({ roles: [role.id], reason: plan.components[role.id]?.used ? 'api-binding' : 'runtime-automatic' });
    for (const placement of plan.placements || []) {
      const shared = groups.filter(group => group.roles.some(role => placement.roles.includes(role)));
      if (shared.length < 2) continue;
      shared[0].roles = Roles.DIRECT3D_ROLES.map(role => role.id).filter(role => shared.some(group => group.roles.includes(role)));
      shared[0].reason = 'shared-physical-binding';
      for (const group of shared.slice(1)) groups.splice(groups.indexOf(group), 1);
    }
  } else {
    for (const role of Roles.DIRECT3D_ROLES) {
      const row = plan.components[role.id], selected = row?.used;
      let group = groups.find(item => item.description === identity(selected) && selected);
      if (!group) { group = { description: identity(selected), roles: [], reason: selected ? 'shared-component' : 'runtime-automatic' }; groups.push(group); }
      group.roles.push(role.id);
    }
  }
  return groups.map(group => ({ id: group.roles.join('+'), roles: group.roles, affectedRoles: group.roles,
    label: group.roles.map(id => Roles.ROLES.find(role => role.id === id).label).join(' / '), reason: group.reason }));
}
function resolveApiRoles(plan, { selections = {}, choices = [], included = [], compatibility = {}, apiCompatibility = {}, automatic = {}, environment } = {}) {
  projectRoles(plan);
  const original = Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, { ...plan.components[role.id] }]));
  const requested = Roles.DIRECT3D_ROLES.some(role => role.id !== 'd3d12' && selections[role.id]);
  if (!requested) { plan.groups = apiGroups(plan); return plan; }
  for (const role of Roles.DIRECT3D_ROLES) {
    const value = selections[role.id]; if (!value) continue;
    const inherited = value === INHERIT;
    const selected = inherited ? environment?.[role.id] || original[role.id].used : findChoice([...included, ...choices], value);
    let used = value === AUTOMATIC ? automatic[role.id] || null : selected, reason = null, reasonCode = null;
    if (value !== AUTOMATIC && value !== INHERIT && !selected) { reason = `The saved translator choice is unavailable: ${value}`; reasonCode = 'missing-choice'; }
    if (selected && !serves(selected, role)) { reason = `The selected component has no ${role.label} library.`; reasonCode = 'missing-api'; }
    const checked = item => apiCompatibility[role.id]?.[item.id] || compatibility[item.id];
    if (selected && checked(selected)?.compatible === false) { reason = checked(selected).reason; reasonCode = 'load-impossible'; }
    if (reason) used = selected && included.find(item => item.engine === selected.engine && serves(item, role) && checked(item)?.compatible !== false) || automatic[role.id] || null;
    if (reason && !used && plan.runtime === 'crossover') used = original[role.id].used;
    plan.components[role.id] = { value, selected, used, inherited, fallback: Boolean(reason), reason, reasonCode, scopeKnown: Boolean(selected?.apis?.length) };
  }
  for (const role of Roles.DIRECT3D_ROLES) {
    const row = plan.components[role.id], files = row.used && apiCompatibility[role.id]?.[row.used.id]?.files;
    if (files) row.used = { ...row.used, files };
  }
  plan.apiMode = true;
  let physical = physicalPlacements(plan);
  if (physical.conflicts.length) {
    // A conflicting namespace cannot hold two files. Retain the requested
    // intent, and restore the existing coherent group rather than pick a DLL.
    const affected = new Set(physical.conflicts.flatMap(item => item.roles));
    for (const role of Roles.DIRECT3D_ROLES) if (affected.has(role.id)) {
      const row = plan.components[role.id]; row.used = original[role.id].used;
      row.fallback = true; row.reasonCode = 'shared-physical-binding'; row.reason = `Shared physical binding conflict: ${physical.conflicts.filter(item => item.roles.includes(role.id)).map(item => item.key).join(', ')}`;
    }
    physical = physicalPlacements(plan);
  }
  const changed = Roles.DIRECT3D_ROLES.some(role => identity(plan.components[role.id].used) !== identity(original[role.id].used));
  const unresolved = Roles.DIRECT3D_ROLES.some(role => !plan.components[role.id].used);
  if ((plan.runtime === 'crossover' && !plan.components['d3d-renderer'].used && changed && unresolved) || physical.conflicts.length) {
    for (const role of Roles.DIRECT3D_ROLES) {
      const row = plan.components[role.id];
      if (identity(row.used) !== identity(original[role.id].used)) {
        row.used = original[role.id].used; row.fallback = true;
        row.reasonCode = plan.runtime === 'crossover' ? 'runtime-global-automatic' : 'shared-physical-binding';
        row.reason = plan.runtime === 'crossover' ? 'CrossOver uses one global backend. The existing automatic composition is retained for this linked selection.' :
          'The requested libraries share a physical binding. The existing coherent composition is retained.';
      }
    }
    plan.apiMode = false;
  }
  if (!changed) plan.apiMode = false;
  if (plan.apiMode) plan.additional = (plan.additional || []).filter(item => !item.apis?.length ||
    Roles.DIRECT3D_ROLES.some(role => identity(plan.components[role.id].used) === identity(item)));
  plan.placements = plan.apiMode ? physical.placements : [];
  plan.groups = apiGroups(plan);
  return plan;
}
function apiOptions(plan, { choices = [], included = [], environment = null, selections = {} } = {}) {
  const result = {};
  const displayDescription = description => {
    if (!description) return description;
    const { files, unixImports, videoPreparation, ...display } = description;
    return display;
  };
  for (const role of Roles.DIRECT3D_ROLES) {
    const rows = [], current = plan.components[role.id], saved = selections[role.id];
    if (environment) rows.push({ value: INHERIT, label: environment.label || 'Environment setting' });
    rows.push({ value: AUTOMATIC, label: plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice" });
    const affectedBy = item => {
      const files = filesForRole(item, role), keys = new Set(files.map(placementKey));
      return Roles.DIRECT3D_ROLES.filter(other => other.id === role.id ||
        (plan.components[other.id]?.used && filesForRole(plan.components[other.id].used, other).some(file => keys.has(placementKey(file)) && files.some(own => placementKey(own) === placementKey(file) && physicalSource(own) !== physicalSource(file)))));
    };
    const scope = item => JSON.stringify(affectedBy(item).map(other => [other.id, serves(item, other)]));
    const candidates = uniqueComponents([...included, ...choices].filter(item => (!item.hiddenChoice || item.id === current.selected?.id) &&
      (item.id === current.selected?.id || offeredForm(item, plan.runtime, role)) &&
      (['d3d-renderer', 'd3d12'].includes(item.component) || item.apis?.some(api => Roles.DIRECT3D_ROLES.some(known => known.apis.includes(api)))) && serves(item, role)), role, current.selected, (a, b) => scope(a) === scope(b));
    for (const item of candidates) {
      const affected = affectedBy(item);
      const patch = Object.fromEntries(affected.map(other => [other.settingsKey, serves(item, other) ? item.id : AUTOMATIC]));
      const value = saved && saved !== AUTOMATIC && saved !== INHERIT && current.selected?.id === item.id ? saved : item.id;
      patch[role.settingsKey] = value;
      const unresolvedGlobal = plan.runtime === 'crossover' && !plan.components['d3d-renderer'].used && !plan.apiMode && Roles.DIRECT3D_ROLES.some(other =>
        affected.some(row => row.id === other.id) ? !serves(item, other) : !plan.components[other.id]?.used &&
          !(selections[other.id] && plan.components[other.id]?.selected && plan.components[other.id].reasonCode === 'runtime-global-automatic'));
      const heldBack = unresolvedGlobal || current.selected?.id === item.id && current.fallback && (!current.used || !sameComponent(item, current.used, role));
      const reason = heldBack ? unresolvedGlobal ? 'runtime-global-automatic' : current.reasonCode || 'fallback' : affected.length > 1 ? 'shared-physical-binding' : undefined;
      const notice = !heldBack ? undefined : reason === 'runtime-global-automatic' ? 'CrossOver keeps its automatic renderer until every Direct3D row has a usable choice.' :
        reason === 'shared-physical-binding' ? 'This choice shares a library with another Direct3D selection. The existing renderer will be used.' :
          'This choice cannot load with the selected runtime. Its included copy or automatic choice will be used.';
      rows.push({ value, label: label(item), apis: item.apis, source: item.source, form: item.form, scopeKnown: Boolean(item.apis?.length), reason, heldBack: Boolean(heldBack), notice,
        groupId: affected.map(item => item.id).join('+'), affectedRoles: affected.map(item => item.id), runtimeSettingsPatch: patch });
    }
    if (!saved) {
      const projected = rows.find(row => row.value === current.value && [AUTOMATIC, INHERIT].includes(row.value));
      if (projected) projected.value = '';
      else rows.push({ value: '', label: 'Default Direct3D engine' });
    } else if (!rows.some(row => row.value === saved)) rows.push({ value: saved, label: 'Saved selection (unavailable)', reason: current.reasonCode || 'missing-choice', heldBack: Boolean(current.fallback),
      notice: current.fallback ? "This saved choice is unavailable. The runtime's current fallback will be used." : undefined, runtimeSettingsPatch: { [role.settingsKey]: saved } });
    result[role.optionsKey] = rows;
  }
  result.translatorGroups = plan.groups || apiGroups(plan);
  result.translatorRoles = Roles.ROLES.map(role => ({ ...role, groupId: result.translatorGroups.find(group => group.roles.includes(role.id))?.id || role.id,
    ...plan.components[role.id], selected: displayDescription(plan.components[role.id]?.selected), used: displayDescription(plan.components[role.id]?.used),
    reason: plan.components[role.id]?.reasonCode || (plan.components[role.id]?.fallback ? 'fallback' : null) }));
  return result;
}

/**
 * One offline decision shared by Wine providers.
 * choices: installed descriptions (id is the persisted choice value).
 * included: descriptions supplied by this Wine/Template.
 * selections: { [component]: id | 'automatic' | 'inherit' }.
 * environment: { label, selections: { [component]: description } } from the
 * shared existing-environment reader. INHERIT means preserve that setting.
 * compatibility: { [id]: { compatible, reason? } }, binary facts only.
 * No version, hash, vendor-string or tested-version checks belong here.
 */
function resolvePlan({ runtime = 'crossover', selections = {}, choices = [], included = [], environment = null, compatibility = {} } = {}) {
  const components = {};
  for (const component of COMPONENTS) {
    const value = selections[component] || (environment ? INHERIT : AUTOMATIC);
    const inherited = value === INHERIT && environment;
    const selected = inherited ? environment.selections?.[component] || null
      : findChoice([...included, ...choices].filter(item => item.component === component), value);
    let used = selected, reason = null;
    if (!selected && value !== AUTOMATIC && value !== INHERIT) {
      reason = `The saved translator choice is unavailable: ${value}`;
    }
    if (selected && compatibility[selected.id]?.compatible === false) {
      reason = compatibility[selected.id].reason;
      used = included.find(item => item.component === component && item.engine === selected.engine && compatibility[item.id]?.compatible !== false) || null;
    }
    components[component] = { value, selected, used, inherited: Boolean(inherited), fallback: Boolean(reason), reason };
  }
  const plan = { runtime, components };
  return { ...plan, warnings: fallbackWarnings(plan) };
}
function fallbackWarnings(plan) {
  return [...new Set(Object.values(plan.components).filter(row => row.fallback).map(row =>
    `${row.selected ? label(row.selected) : row.value} could not load: ${row.reason}. Using ${row.used ? label(row.used) : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "the Template's automatic choice"}.`))];
}
function options({ component, runtime = 'crossover', included = [], choices = [], environment = null, selections = {} } = {}) {
  const result = [];
  if (environment) result.push({ value: INHERIT, label: `${environment.label || (runtime === 'crossover' ? 'Bottle setting' : 'Wrapper setting')}: ${label(environment.selections?.[component]) || 'Automatic'}` });
  result.push({ value: AUTOMATIC, label: runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice" });
  const selected = findChoice([...included, ...choices].filter(item => item.component === component), selections[component]);
  for (const item of uniqueComponents([...included, ...choices].filter(item => item.component === component &&
    (item.id === selected?.id || offeredForm(item, runtime))), null, selected))
    result.push({ value: item === selected ? selections[component] : item.id, label: label(item) });
  return result;
}
module.exports = { AUTOMATIC, INHERIT, resolvePlan, options, fallbackWarnings, projectRoles, resolveApiRoles, apiOptions, filesForRole, ROLES: Roles.ROLES };
