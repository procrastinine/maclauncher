// One presentation path for Included rows and per-game translator choices.
// The original version text and binary facts stay on the description.
const names = { d3dmetal: "D3DMetal", dxmt: "DXMT", dxvk: "DXVK", wined3d: "WineD3D",
  moltenvk: "MoltenVK", kosmickrisp: "KosmicKrisp", "vkd3d-proton": "vkd3d-proton", gstreamer: "GStreamer", mullion: "Mullion" };
const displayText = value => String(value ?? "").replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
function componentRelease(value) {
  const text = displayText(String(value?.version || "").split(/[\r\n]/)[0]).split(/\s*·\s*/)[0];
  return /(?:^|[^\d])v?((\d+(?:\.\d+)+(?:[a-z]+\d*)?)(?:[-+][a-z0-9]+)*)/i.exec(text);
}
function componentVersion(value) {
  return componentRelease(value)?.[2] || "";
}
function componentLabel(value) {
  const name = names[value.engine] || value.engine;
  const [text, ...qualifiers] = displayText(String(value.version || "").split(/[\r\n]/)[0]).split(/\s*·\s*/);
  const version = componentRelease(value)?.[1] || "";
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
// A copy downloaded from a Template release is managed, while the copies in
// an installed Sikarugir Template are included with it; the label says which.
function sourceText(value, host) {
  const source = hostLabel(host, value.source) || (typeof value.source === "string" ? value.source : "");
  if (source === "custom") return "Registered";
  return source && !host && !value.included && value.source?.kind === "template" ? `Managed copy from ${source}` : source;
}
// A qualifier repeats the label when the label already states every word of
// it. A bare package id may carry MacLauncher's own namespace
// ("maclauncher-kosmickrisp" beside "KosmicKrisp 27.0.0"), which tells nothing
// apart; "dxvk-gplasync" beside "DXVK 3.1.1" still adds "gplasync".
const words = value => displayText(value).toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
function repeats(part, stated) {
  const text = displayText(part), known = new Set(words(stated));
  const own = words(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(text) ? text.replace(/^maclauncher[-_]/, "") : text);
  return own.every(word => known.has(word));
}
// A label already written (a row recorded at an earlier Play) without such repeats.
function presentLabel(text) {
  const [first, ...rest] = displayText(text).split(/\s*·\s*/);
  return rest.reduce((parts, part) => repeats(part, parts.join(" ")) ? parts : [...parts, part], [first]).filter(Boolean).join(" · ");
}
function label(value, host, { folder = value?.labelFolder, hostVersionLabel, hostName } = {}) {
  if (!value) return "";
  const component = componentLabel(value), source = sourceText(value, host);
  const parts = [component, source && !repeats(source, component) ? source : ""].filter(Boolean);
  // A qualifier adds only the words the label does not already state, so
  // "CrossOver Preview 26.3" beside "CrossOver 26.3" adds "Preview".
  for (const part of [folder, ...displayText(hostVersionLabel).split(/\s*·\s*/), hostName].map(displayText)) {
    // A folder that tells registrations apart is kept unless the label states all of it.
    if (!part || parts.some(existing => existing.includes(part)) || repeats(part, parts.join(" "))) continue;
    const stated = new Set(parts.join(" ").split(/\s+/)), rest = part.split(/\s+/).filter(word => !stated.has(word)).join(" ");
    if (rest) parts.push(rest);
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
module.exports = { componentVersion, componentLabel, hostLabel, label, presentLabel, registeredLabels };
