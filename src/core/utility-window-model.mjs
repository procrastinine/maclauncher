const definitions = Object.freeze({
  external: Object.freeze({ title: "External", width: 1180, height: 780, minWidth: 760, minHeight: 520 }),
  settings: Object.freeze({ title: "Settings", width: 1040, height: 740, minWidth: 700, minHeight: 480 }),
  runtimes: Object.freeze({ title: "Runtimes", width: 1100, height: 760, minWidth: 760, minHeight: 480 }),
  credits: Object.freeze({ title: "Credits", width: 860, height: 660, minWidth: 560, minHeight: 400 })
});

export function normalizeUtilityWindowRequest(value) {
  if (!value || typeof value !== "object" || typeof value.view !== "string" || !Object.hasOwn(definitions, value.view)) {
    throw new Error("Unknown launcher window.");
  }
  const request = { view: value.view };
  if (value.view === "runtimes" && value.managerId != null && value.managerId !== "") {
    if (typeof value.managerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.managerId)) {
      throw new Error("Invalid runtime manager.");
    }
    request.managerId = value.managerId;
  }
  if (value.view === "settings" && value.sectionId != null && value.sectionId !== "") {
    if (typeof value.sectionId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.sectionId)) {
      throw new Error("Invalid settings section.");
    }
    request.sectionId = value.sectionId;
  }
  return request;
}

export function utilityWindowDefinition(view) {
  return Object.hasOwn(definitions, view) ? definitions[view] : null;
}

export function readUtilityWindowContext(search) {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (!utilityWindowDefinition(view)) return null;
  return normalizeUtilityWindowRequest({ view, managerId: params.get("managerId"), sectionId: params.get("sectionId") });
}
