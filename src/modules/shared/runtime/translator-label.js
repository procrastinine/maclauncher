// One presentation path for Included rows and per-game translator choices.
// The original version text and binary facts stay on the description.
const names = { d3dmetal: "D3DMetal", dxmt: "DXMT", dxvk: "DXVK", wined3d: "WineD3D",
  moltenvk: "MoltenVK", kosmickrisp: "KosmicKrisp", "vkd3d-proton": "vkd3d-proton", gstreamer: "GStreamer" };
function componentLabel(value) {
  const name = names[value.engine] || value.engine;
  const text = String(value.version || "").split(/[\r\n]/)[0].trim();
  const release = /(?:^|[^\d])v?(\d+(?:\.\d+)+(?:[-+][a-z0-9]+)*)/i.exec(text);
  if (!release) return text.toLowerCase().startsWith(String(name).toLowerCase()) ? text : [name, text].filter(Boolean).join(" ");
  const prefix = text.slice(0, release.index), version = release[1];
  return `${name} ${version}${/\basync\b/i.test(prefix) && !/\basync\b/i.test(version) ? " async" : ""}`.replace(/-async\b/i, " async");
}
function hostLabel(host, source) {
  const name = source && typeof source === "object" ? source.label : "";
  const template = host?.templateVersion || host?.catalogEntry?.template?.version;
  const version = template || host?.upstreamVersion;
  return [name, version && !String(name).endsWith(` ${version}`) ? version : ""].filter(Boolean).join(" ") || host?.displayName || host?.name || "";
}
function label(value, host) {
  if (!value) return "";
  const source = hostLabel(host, value.source) || (typeof value.source === "string" ? value.source : "");
  return [componentLabel(value), source].filter(Boolean).join(" · ");
}
module.exports = { componentLabel, hostLabel, label };
