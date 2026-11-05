// One presentation path for Included rows and per-game translator choices.
// The original version text and binary facts stay on the description.
const names = { d3dmetal: "D3DMetal", dxmt: "DXMT", dxvk: "DXVK", wined3d: "WineD3D",
  moltenvk: "MoltenVK", kosmickrisp: "KosmicKrisp", "vkd3d-proton": "vkd3d-proton", gstreamer: "GStreamer" };
const displayText = value => String(value ?? "").replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
function componentVersion(value) {
  const text = displayText(String(value?.version || "").split(/[\r\n]/)[0]).split(/\s*·\s*/)[0];
  return /(?:^|[^\d])v?(\d+(?:\.\d+)+(?:[a-z]+\d*)?(?:[-+][a-z0-9]+)*)/i.exec(text)?.[1] || "";
}
function componentLabel(value) {
  const name = names[value.engine] || value.engine;
  const [text, ...qualifiers] = displayText(String(value.version || "").split(/[\r\n]/)[0]).split(/\s*·\s*/);
  const version = componentVersion(value);
  if (!version) return [text.toLowerCase().startsWith(String(name).toLowerCase()) ? text : [name, text].filter(Boolean).join(" "), ...qualifiers].filter(Boolean).join(" · ");
  const prefix = text.slice(0, text.indexOf(version));
  const component = `${name} ${version}${/\basync\b/i.test(prefix) && !/\basync\b/i.test(version) ? " async" : ""}`.replace(/-async\b/i, " async");
  return [component, ...qualifiers].filter(Boolean).join(" · ");
}
function hostLabel(host, source) {
  const name = source && typeof source === "object" ? source.label : "";
  const template = host?.templateVersion || host?.catalogEntry?.template?.version;
  const version = template || host?.upstreamVersion;
  return displayText([name, version && !String(name).endsWith(` ${version}`) ? version : ""].filter(Boolean).join(" ") || host?.displayName || host?.name);
}
function label(value, host, { folder = value?.labelFolder, hostVersionLabel, hostName } = {}) {
  if (!value) return "";
  const source = hostLabel(host, value.source) || (typeof value.source === "string" ? value.source : "");
  const parts = [componentLabel(value), source].filter(Boolean);
  for (const part of [folder, ...displayText(hostVersionLabel).split(/\s*·\s*/), hostName].map(displayText)) {
    if (part && !parts.some(existing => existing.includes(part))) parts.push(part);
  }
  return displayText(parts.join(" · "));
}
function registeredLabels(rows) {
  const primary = row => row.translator && label(row.translator, undefined, { folder: null });
  const counts = new Map();
  for (const row of rows) if (row.translator) counts.set(primary(row), (counts.get(primary(row)) || 0) + 1);
  return rows.map(row => {
    if (!row.translator) return row;
    const translator = { ...row.translator, labelFolder: counts.get(primary(row)) > 1 ? row.registrationName : undefined };
    const result = { ...row, translator, versionLabel: label(translator) }, sortVersion = componentVersion(translator);
    if (sortVersion) result.sortVersion = sortVersion;
    else delete result.sortVersion;
    return result;
  });
}
module.exports = { componentVersion, componentLabel, hostLabel, label, registeredLabels };
