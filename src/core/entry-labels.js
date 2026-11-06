// Game type labels for one library entry. A module names a variant of its game
// type through ui.entryLabels in its manifest. A rule applies when any of its
// conditions matches the recorded entry, as with action and field conditions;
// otherwise the manifest labels apply.
function valueAt(value, key) { return String(key || "").split(".").reduce((value, part) => value?.[part], value); }
function matches(entry, condition) {
  const value = valueAt(entry, condition?.key);
  if (Object.hasOwn(condition, "equals")) return Array.isArray(value) ? value.includes(condition.equals) : value === condition.equals;
  if (Object.hasOwn(condition, "notEquals")) return Array.isArray(value) ? !value.includes(condition.notEquals) : value !== condition.notEquals;
  if (condition.truthy) return Boolean(value);
  if (condition.falsy) return !value;
  if (condition.endsWith) return typeof value === "string" && value.endsWith(condition.endsWith);
  return false;
}
function entryModuleLabels(info, entry) {
  const rule = (Array.isArray(info?.ui?.entryLabels) ? info.ui.entryLabels : [])
    .find(rule => Array.isArray(rule?.when) && rule.when.some(condition => condition && matches(entry, condition)));
  return { label: rule?.label || info?.label, shortLabel: rule?.shortLabel || rule?.label || info?.shortLabel };
}
module.exports = { entryModuleLabels };
