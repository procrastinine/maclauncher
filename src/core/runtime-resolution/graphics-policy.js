'use strict';
// A Wine whose own loader picks its Direct3D libraries by one environment value
// per process declares that choice in its source file as `graphicsPolicy`
// (runtime-sources/schema.js). MetalSharp Wine's ntdll reads GRAPHICS_BACKEND.
// Unset, its Mullion replaces Wine's own DXGI and Direct3D 10 to 12 builtins.
// "dxvk" and "vkd3d" load its DXVK and vkd3d-proton folders for x86_64
// programs, with Mullion for the rest. "wine" leaves every library to Wine's
// own builtin search.
//
// Choosing a value's own included component sets that value. Choosing the
// Wine's own builtin library for a Direct3D API that the default value replaces
// sets the builtin value, so that library is what loads. Another builtin set
// sets nothing: a loader that runs from its publisher's bundle searches the
// Wine's own builtin folder before the game's view, so under the builtin value
// the Wine's own library of that name would load instead. Automatic and inherited
// choices set nothing, and the Wine keeps its own default. While a value is
// set, its components serve each Direct3D API they cover, in order. A native
// library placed in the prefix still loads first.
//
// A value can also declare `directory`: a second variable naming a folder from
// which the Wine's loader takes a separately installed build of a component
// engine, ahead of its included one. MetalSharp Wine's ntdll reads
// DXMT_RUNTIME_DIR and loads DXMT's Windows libraries and winemetal.so from it.
// Choosing such a build, one whose files include every file the loader
// requires there, sets that value and the folder, and none of its files are
// placed.
const path = require('node:path');
const Roles = require('../../modules/shared/runtime/translator-roles');
const { requiredMachine } = require('../../modules/shared/runtime/binary-compatibility');
const AUTOMATIC = 'automatic', INHERIT = 'inherit';
// When choices need different values, the newest Direct3D API's choice sets it.
const PRECEDENCE = ['d3d12', 'd3d11', 'd3d10', 'd3d9', 'd3d8'].map(id => Roles.DIRECT3D_ROLES.find(role => role.id === id));
const PROGRAMS = { x64: ['x86_64', '64-bit Intel'], x86: ['i386', '32-bit Intel'], arm64: ['arm64', 'ARM64'] };

const sourceOf = runtime => require('../../modules/crossover/sources').get(runtime);
const policyOf = runtime => sourceOf(runtime)?.graphicsPolicy || null;
const isLane = (policy, item) => Boolean(item?.included && policy?.values.some(entry => entry.lanes.includes(item.embedId)));
// The value whose own component this is.
const ownValue = (policy, item) => item?.included && policy?.values.find(entry => entry.lanes[0] === item.embedId) || null;
const covers = (item, role) => Boolean(item?.apis?.some(api => role.apis.includes(api)));
const identity = item => item && `${item.id}:${item.root || ''}`;
// The folder of a separately installed build that holds every file a value's
// loader requires, such as a DXMT package's wine folder; null when none does.
function directoryFolder(entry, item) {
  const directory = entry.directory;
  if (item?.included || !path.isAbsolute(item?.root || '') || !directory?.engines.includes(item.engine)) return null;
  const relatives = new Set((item.files || []).map(file => file.relative).filter(Boolean)), [first, ...rest] = directory.files;
  for (const relative of relatives) {
    if (relative !== first && !relative.endsWith('/' + first)) continue;
    const prefix = relative.slice(0, relative.length - first.length);
    if (rest.every(file => relatives.has(prefix + file))) return path.resolve(item.root, prefix || '.');
  }
  return null;
}
// The value that loads this separately installed build from its own folder.
const directoryValue = (policy, item) => policy?.values.find(entry => directoryFolder(entry, item)) || null;
const laneLabel = (runtime, item) => sourceOf(runtime)?.source?.included?.find(embed => embed.id === item.embedId)?.label || item.engine;

// The compatibility of an included component that the Wine loads itself: the
// programs its value applies to. null for any other component.
function laneCompatibility(runtime, item, executableArchitecture) {
  const policy = policyOf(runtime);
  if (!isLane(policy, item)) return null;
  const allowed = ownValue(policy, item)?.architectures, machine = requiredMachine(executableArchitecture);
  if (!allowed || !machine || allowed.some(cpu => requiredMachine(PROGRAMS[cpu][0]) === machine))
    return { compatible: true, reason: null, warnings: [], files: item.files };
  return { compatible: false, warnings: [],
    reason: `${laneLabel(runtime, item)} loads only for ${allowed.map(cpu => PROGRAMS[cpu][1]).join(' and ')} programs.` };
}

// Sets plan.graphicsPolicy and the Direct3D rows it decides. Runs on the
// per-API rows before their files are placed; returns whether a value is set.
function applyPolicy(plan, { selections = {}, included = [], filesForRole }) {
  delete plan.graphicsPolicy;
  const policy = policyOf(plan.runtime);
  if (!policy) return false;
  const component = id => included.find(item => item.included && item.embedId === id) || null;
  const lanesOf = value => (policy.values.find(entry => entry.value === value)?.lanes || []).map(component).filter(Boolean);
  const chosen = role => ![undefined, null, '', AUTOMATIC, INHERIT].includes(selections[role.id]) && Boolean(plan.components[role.id]?.used);
  const builtin = (item, role) => filesForRole(item, role).some(file => file.format === 'pe' && file.form === 'builtin' &&
    Roles.fileApis(file).some(api => role.apis.includes(api)));
  const replacedByDefault = role => lanesOf(policy.default).some(item => covers(item, role));
  const demand = role => {
    if (!chosen(role)) return null;
    const row = plan.components[role.id], own = ownValue(policy, row.used) || !row.fallback && directoryValue(policy, row.used);
    if (own) return own.value;
    return !row.fallback && row.used.included && !isLane(policy, row.used) && replacedByDefault(role) && builtin(row.used, role) ? policy.builtins : null;
  };
  const first = PRECEDENCE.find(demand);
  if (!first) return false;
  const value = demand(first);
  // The first chosen build this value loads from its folder serves every API it covers.
  const directed = PRECEDENCE.filter(role => demand(role) === value).map(role => plan.components[role.id].used)
    .find(item => directoryValue(policy, item)) || null;
  const lanes = value === policy.builtins ? [] : [directed, ...lanesOf(value)].filter(Boolean);
  const wineOwn = role => included.find(item => !isLane(policy, item) && ['wined3d', 'vkd3d'].includes(item.engine) && covers(item, role)) || null;
  for (const role of Roles.DIRECT3D_ROLES) {
    const row = plan.components[role.id], served = lanes.find(item => covers(item, role)) || null;
    if (!chosen(role)) { if (served && identity(row.used) !== identity(served)) row.used = served; continue; }
    const asked = demand(role);
    if (asked === value && (!served || identity(served) === identity(row.used))) continue;
    // A placed native library, or a builtin no component of this value replaces, still loads.
    if (!asked && !isLane(policy, row.used) && (!builtin(row.used, role) || !served)) continue;
    Object.assign(row, { used: served || wineOwn(role), fallback: true, reasonCode: 'graphics-policy',
      reason: `${sourceOf(plan.runtime)?.label || 'This Wine'} loads one Direct3D route per game, and the ${first.label} choice sets it.` });
  }
  const entry = directed && directoryValue(policy, directed);
  plan.graphicsPolicy = { variable: policy.variable, value, lanes: [...new Set(policy.values.flatMap(entry => entry.lanes))],
    ...(entry ? { env: { [entry.directory.variable]: directoryFolder(entry, directed) }, items: [directed.id] } : {}) };
  return true;
}
// Whether the Wine loads this component itself, so no file of it is placed.
const loadedByWine = (plan, item) => Boolean(item?.included && plan?.graphicsPolicy?.lanes.includes(item.embedId) ||
  item && !item.included && plan?.graphicsPolicy?.items?.includes(item.id));

module.exports = { policyOf, laneCompatibility, applyPolicy, loadedByWine };
