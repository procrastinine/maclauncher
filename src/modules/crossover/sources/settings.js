// Builds each Wine source's runtime entry from the one shared Windows settings
// definition in manifest.json. Every source has the same fields; a source with
// no external environment kind has no environment picker, DirectDraw
// compatibility is listed where the source includes CNC-DDraw, and CrossOver
// keeps its bottle type, which names the bottle its saves live in.
const Sources = require(".");
function withSources(manifest) {
  const result = structuredClone(manifest), shared = result.runtime.windows;
  result.runtime.entries = {}; result.runtime.manager = {}; result.runtime.managerUi = {};
  for (const source of Sources.all()) {
    let fields = structuredClone(shared.settings.fields).filter(field => (field.key !== "environmentReference" || source.environmentKind) &&
      (field.key !== "cncDdraw" || source.directDraw));
    const defaults = { ...shared.settings.defaults };
    if (!source.environmentKind) delete defaults.environmentReference;
    if (!source.directDraw) delete defaults.cncDdraw;
    if (source.prefixModel === "bottleTemplate") {
      fields = fields.map(field => field.key === "windowsVersion" ? structuredClone(shared.bottleTemplateField) : field);
      delete defaults.windowsVersion; defaults.bottleTemplate = "win10_64";
    }
    result.runtime.entries[source.id] = { input: structuredClone(shared.input), label: source.runtimeLabel,
      statusAction: shared.statusAction, statusFromRecord: shared.statusFromRecord, graphicsHost: shared.graphicsHost,
      ...(source.graphicsArchitecture ? { graphicsArchitecture: source.graphicsArchitecture } : {}),
      ...(source.invocation === "wine" ? { supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true } } : {}),
      settings: { defaults, fields } };
    result.runtime.manager[source.id] = source.managerId;
    result.runtime.managerUi[source.id] = { groupId: source.id, tabLabel: source.label, sectionLabel: source.label, memberOrder: 0,
      management: "managed", order: source.order, category: "compatibility" };
  }
  delete result.runtime.windows;
  return result;
}
// The Windows versions that name a separate private prefix folder.
const prefixVersions = manifest => manifest.runtime.windows.settings.fields.find(field => field.key === "windowsVersion").options.map(option => option.value);
module.exports = { withSources, prefixVersions };
