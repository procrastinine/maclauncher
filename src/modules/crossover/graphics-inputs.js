// Provider architecture is the native Wine loader's architecture, independently
// of the Windows executable and the launcher's own process.
function architecture(install, hostArchitecture = process.arch, fallback = null) {
  const normalize = value => value === "x64" ? "x86_64" : value;
  const candidates = (install?.architectures || install?.installationMetadata?.architectures || [])
    .filter(value => typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value)).map(normalize);
  const host = normalize(hostArchitecture);
  return candidates.includes(host) ? host : candidates[0] || fallback;
}
function inputs(install, source, options = {}) {
  const selected = architecture(install, options.hostArchitecture, options.fallback);
  return selected ? { ...source, architecture: selected } : source || null;
}
module.exports = { architecture, inputs };
