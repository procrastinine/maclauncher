// Provider architecture is the native Wine loader's architecture, independently
// of the Windows executable and the launcher's own process.
// The launcher CPU is the fallback ABI; an installed Wine loader supplies its own slices.
function architecture(install, hostArchitecture = process.arch, fallback = null) {
  if (install?.graphicsExecutablePath) {
    const selected = require("../shared/runtime/wine-layout").wineLayout(install).architecture;
    if (selected) return selected;
  }
  const normalize = value => value === "x64" ? "x86_64" : value;
  const candidates = (install?.architectures || install?.installationMetadata?.architectures || [])
    .filter(value => typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value)).map(normalize);
  const host = normalize(hostArchitecture);
  return candidates.includes(host) ? host : candidates[0] || fallback;
}
// The scene inputs that any of a launch's scene sources supplies, after the
// first source's own fields.
function merge(...sources) {
  const present = sources.filter(Boolean);
  if (present.length < 2) return present[0] || null;
  const result = { ...present[0] };
  for (const source of present.slice(1)) for (const [key, value] of Object.entries(source)) if (value === true) result[key] = true;
  result.source = present.map(source => source.source).filter(Boolean).join("+");
  return result;
}
function inputs(install, source, options = {}) {
  const selected = architecture(install, options.hostArchitecture, options.fallback);
  return selected ? { ...source, architecture: selected } : source || null;
}
module.exports = { architecture, inputs, merge };
