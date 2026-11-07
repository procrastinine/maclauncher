// Whether a runtime manager, or one section of it, has a row of its own in
// Runtimes. A manager whose UI metadata hides it or marks it built-in has
// none, and Runtimes → Tools → Downloaded files lists its downloads instead
// (core/component-service.js). The renderer and the backend share this file.
export function hasRuntimesRow(ui, sectionId) {
  if (ui?.hidden === true || ui?.management === "built-in") return false;
  return !sectionId || ui?.sectionManagement?.[sectionId] !== "built-in";
}
