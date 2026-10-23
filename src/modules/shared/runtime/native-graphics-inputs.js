const path = require("node:path");
const Native = require("./local-native");
const normalize = value => value === "x64" ? "x86_64" : typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value) ? value : null;
function choose(values, hostArchitecture) {
  const architectures = [...new Set((Array.isArray(values) ? values : []).map(normalize).filter(value => ["arm64", "x86_64"].includes(value)))];
  const host = normalize(hostArchitecture);
  return architectures.includes(host) ? host : architectures.length === 1 ? architectures[0] : null;
}
// Native executables are inspected only after graphics demand is established.
// Engine input capabilities and explicitly declared provider architectures stay
// authoritative; this fallback neither starts a process nor inspects game data.
function resolveArchitecture(entry, {runtimeId, declaredArchitecture, graphicsInputs, hostArchitecture = process.arch,
  readArchitectures = Native.readMachOArchitectures} = {}) {
  const declared = normalize(graphicsInputs?.architecture) || normalize(declaredArchitecture);
  if (declared) return declared;
  if (runtimeId !== "native" || entry?.moduleData?.launchKind === "script") return null;
  for (const values of [entry?.moduleData?.executableArchitectures, entry?.runtimeData?.mac32?.executableArchitectures]) {
    const architecture = choose(values, hostArchitecture);
    if (architecture) return architecture;
  }
  let executable = entry?.moduleData?.executablePath || entry?.runtimeData?.mac32?.executablePath ||
    (entry?.moduleData?.launchKind === "executable" ? entry.gamePath : null);
  if (!executable) {
    for (const bundle of new Set([entry?.nativeAppPath, entry?.gamePath])) {
      if (typeof bundle !== "string" || !path.isAbsolute(bundle) || !/\.app$/i.test(bundle) || /[\0\r\n]/.test(bundle)) continue;
      executable = require("./app-bundle").resolveAppBundleExecutablePath(bundle);
      if (executable) break;
    }
  }
  if (typeof executable !== "string" || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) return null;
  try { return choose(readArchitectures(executable), hostArchitecture); } catch { return null; }
}
function withInputs(entry, options = {}) {
  const architecture = resolveArchitecture(entry, options);
  return architecture ? {...options.graphicsInputs, architecture} : options.graphicsInputs || null;
}
module.exports = {resolveArchitecture, withInputs};
