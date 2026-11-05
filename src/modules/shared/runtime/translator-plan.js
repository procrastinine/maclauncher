const { COMPONENTS, label } = require('./translator-description');
const AUTOMATIC = 'automatic', INHERIT = 'inherit';

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
      : [...included, ...choices].find(item => item.id === value && item.component === component) || null;
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
  return Object.values(plan.components).filter(row => row.fallback).map(row =>
    `${row.selected ? label(row.selected) : row.value} could not load: ${row.reason}. Using ${row.used ? label(row.used) : plan.runtime === 'crossover' ? "CrossOver's automatic choice" : "the Template's automatic choice"}.`);
}
function options({ component, runtime = 'crossover', included = [], choices = [], environment = null } = {}) {
  const result = [];
  if (environment) result.push({ value: INHERIT, label: `${environment.label || (runtime === 'crossover' ? 'Bottle setting' : 'Wrapper setting')}: ${label(environment.selections?.[component]) || 'Automatic'}` });
  result.push({ value: AUTOMATIC, label: runtime === 'crossover' ? "CrossOver's automatic choice" : "Template's automatic choice" });
  for (const item of [...included, ...choices]) if (item.component === component)
    result.push({ value: item.id, label: label(item) });
  return result;
}
module.exports = { AUTOMATIC, INHERIT, resolvePlan, options, fallbackWarnings };
