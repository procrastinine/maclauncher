const { AsyncLocalStorage } = require("node:async_hooks");
const { architectureSupport, getHostCapabilities, defaultArchitecture } = require("./host-capabilities");
const Requirements = require("./feature-requirements");
const context = new AsyncLocalStorage();
// A CPU this launcher installs builds for, or null.
function normalizeArchitecture(value) {
  const normalized = Requirements.normalizeArchitecture(value);
  return ["arm64", "x64", "universal"].includes(normalized) ? normalized : null;
}
function selectedArchitecture() { return context.getStore() || defaultArchitecture(); }
function targetArchitecture(value) {
  const architecture = normalizeArchitecture(value);
  return ["arm64", "x64"].includes(architecture) ? architecture : null;
}
function requestedArchitecture(payload) {
  return targetArchitecture(payload?.architecture) || (typeof payload?.variant === "string" && payload.variant.startsWith("architecture:")
    ? targetArchitecture(payload.variant.slice(13)) : null);
}
function withArchitecture(architecture, action) {
  const selected = normalizeArchitecture(architecture);
  if (!["arm64", "x64"].includes(selected)) throw new Error("Choose an Apple Silicon or Intel build.");
  return context.run(selected, action);
}
function architectureLabel(architecture) { return normalizeArchitecture(architecture) === "x64" ? "Intel" : "Apple Silicon"; }
function recordArchitecture(record) {
  return normalizeArchitecture(record?.arch || record?.architecture || record?.projectPackage?.arch || record?.catalogEntry?.architecture);
}
function matchesArchitecture(record, architecture = selectedArchitecture()) {
  const declared = recordArchitecture(record);
  return declared ? declared === "universal" || declared === architecture
    : !record?.hostArchitectures || record.hostArchitectures.includes(architecture);
}
// One build choice for a manager: an explicit request, then a saved choice (a
// caller's preference, the game's saved build, then the manager's saved
// default), then the launcher's CPU. With `offers(cpu)` telling whether a CPU
// lists or holds a build, a saved or automatic choice without one gives way to
// the launcher's CPU and then to another CPU this Mac runs, such as Apple
// Silicon builds in the Intel app on Apple Silicon. Universal builds count for
// every CPU. An explicit request stays as given, and so does the preferred CPU
// when no CPU has a build.
function chooseArchitecture({ request, saved, entry, settings, managerId, launcher = selectedArchitecture(), offers, host } = {}) {
  const requested = requestedArchitecture(request);
  if (requested) return requested;
  const preferred = targetArchitecture(saved || entry?.runtimeData?.[managerId]?.architecture ||
    settings?.runtimes?.[managerId]?.defaultArchitecture);
  if (typeof offers !== "function") return preferred || launcher;
  const runnable = architecture => architecture === launcher || architectureSupport(architecture, host || getHostCapabilities()).supported;
  return [...new Set([preferred, launcher, "arm64", "x64"])].find(architecture => architecture && runnable(architecture) && offers(architecture)) ||
    preferred || launcher;
}
// CPU named in a publisher's file name, for catalogs without other CPU facts.
function assetArchitecture(name) {
  const token = pattern => new RegExp(`(?:^|[._-])(?:${pattern})(?:[._-]|$)`, "i").test(String(name || ""));
  return token("universal|universal2") ? "universal" : token("arm64|aarch64") ? "arm64" : token("x86_64|x86-64|x64|amd64") ? "x64" : null;
}
function requiresRosetta(architecture, host = getHostCapabilities()) {
  return normalizeArchitecture(architecture) === "x64" && host.platform === "darwin" && host.hardwareArch === "arm64";
}
// A Mach-O image without an Apple Silicon slice runs its Intel slice through Rosetta.
function imageRequiresRosetta(architectures, host) {
  const slices = (architectures || []).map(Requirements.normalizeArchitecture);
  return !slices.includes("arm64") && slices.includes("x64") && requiresRosetta("x64", host);
}
// An installed row carries its CPU and whether this Mac runs it; Runtimes shows
// the reason for a build this Mac cannot run.
function tagInstall(row, architecture) {
  const actual = recordArchitecture(row) || normalizeArchitecture(architecture);
  if (!actual) return row;
  const support = architectureSupport(actual), rosetta = requiresRosetta(actual);
  return { ...row, architecture: actual, architectureSupported: support.supported, needsRosetta: rosetta, requiresRosetta: rosetta,
    ...(support.supported ? {} : { ready: false, error: support.reason }) };
}
async function ensureArchitecture(architecture, options = {}) {
  const support = architectureSupport(normalizeArchitecture(architecture), options.host || getHostCapabilities());
  if (!support.supported) throw new Error(support.reason);
  if (support.installRosetta) await require("./rosetta").ensure(options);
  return support;
}
module.exports = { normalizeArchitecture, defaultArchitecture, selectedArchitecture, withArchitecture, architectureLabel,
  recordArchitecture, matchesArchitecture, ensureArchitecture, requestedArchitecture, targetArchitecture, chooseArchitecture,
  assetArchitecture, requiresRosetta, imageRequiresRosetta, tagInstall };
