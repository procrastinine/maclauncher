const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const AppBundle = require("../../shared/runtime/app-bundle");
const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const { readMachOArchitectures } = require("../../shared/runtime/local-native");
const { createRuntimeSettingsStore } = require("../../../core/runtime-settings");

const AUTOMATIC_PATHS = ["/Applications/CrossOver.app", path.join(os.homedir(), "Applications", "CrossOver.app")];
const registryPath = userDataDir => path.join(userDataDir, "runtimes", "crossover", "registrations.json");
const identity = appPath => "local-" + crypto.createHash("sha256").update(appPath).digest("hex").slice(0, 16);
const applicationCache = new Map();

function readRegistry(userDataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath(userDataDir), "utf8"));
    return { applications: Array.isArray(value.applications) ? value.applications : [],
      ignoredPaths: Array.isArray(value.ignoredPaths) ? value.ignoredPaths : [] };
  } catch { return { applications: [], ignoredPaths: [] }; }
}
function writeRegistry(userDataDir, registry) {
  const destination = registryPath(userDataDir);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, destination); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function inspectApplication(runtimePath) {
  if (typeof runtimePath !== "string" || !path.isAbsolute(runtimePath) || runtimePath.includes("\0") || !/\.app\/?$/i.test(runtimePath)) {
    throw new Error("Select an installed CrossOver application (.app).");
  }
  const appPath = fs.realpathSync(runtimePath);
  if (!fs.statSync(appPath).isDirectory()) throw new Error("CrossOver application was not found.");
  const root = path.join(appPath, "Contents", "SharedSupport", "CrossOver");
  const executablePath = path.join(root, "bin", "wine"), bottleToolPath = path.join(root, "bin", "cxbottle");
  const loaderPath = path.join(root, "bin", "wineloader"), serverPath = path.join(root, "bin", "wineserver");
  // Modern Wine re-execs this separate loader after reserving its Windows
  // address space. Graphics providers load into that process, whose available
  // architectures can differ from the front loader's universal slices.
  const childLoader = path.join(root, "lib", "wine", "x86_64-unix", "wine");
  const graphicsExecutablePath = fs.existsSync(childLoader) ? childLoader : loaderPath;
  const commands = [...new Set([executablePath, bottleToolPath, loaderPath, serverPath, graphicsExecutablePath])];
  const signature = [path.join(appPath, "Contents", "Info.plist"), ...commands]
    .map(file => { const stat = fs.statSync(file); return [fs.realpathSync(file), stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]; });
  const key = JSON.stringify(signature), cached = applicationCache.get(appPath);
  if (cached?.key === key) return { ...cached.install, architectures: [...cached.install.architectures] };
  for (const file of commands) {
    if (!fs.statSync(file).isFile() || !(fs.statSync(file).mode & 0o111)) throw new Error("The selected application has no usable CrossOver command-line runtime.");
    const relative = path.relative(appPath, fs.realpathSync(file));
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("CrossOver runtime commands must remain inside the selected application.");
  }
  const info = AppBundle.readInfoPlist(appPath);
  const upstreamVersion = info?.CFBundleShortVersionString || info?.CFBundleVersion || "Unknown version";
  const loaderArchitectures = readMachOArchitectures(loaderPath);
  const architectures = graphicsExecutablePath === loaderPath ? loaderArchitectures : readMachOArchitectures(graphicsExecutablePath);
  const serverArchitectures = readMachOArchitectures(serverPath);
  const install = { version: identity(appPath), upstreamVersion, versionLabel: `${upstreamVersion} · ${path.basename(appPath)}`,
    appPath, installDir: appPath, runtimePath: appPath, executablePath, bottleToolPath, loaderPath, serverPath,
    crossoverRoot: root, graphicsExecutablePath, architectures, loaderArchitectures, serverArchitectures,
    needsRosetta: process.arch === "arm64" && (!loaderArchitectures.includes("arm64") || !architectures.includes("arm64") || !serverArchitectures.includes("arm64")),
    minimumMacOS: info?.LSMinimumSystemVersion || null, ready: true, external: true, imported: true,
    removalLabel: "Remove", removalConfirm: "Remove this application from Runtimes? The application will remain installed." };
  applicationCache.set(appPath, { key, install });
  return { ...install, architectures: [...install.architectures] };
}
function compareApplications(a, b) {
  return String(b.upstreamVersion).localeCompare(String(a.upstreamVersion), undefined, { numeric: true }) || a.appPath.localeCompare(b.appPath);
}
function listInstalled(userDataDir, { automaticPaths = AUTOMATIC_PATHS } = {}) {
  const registry = userDataDir ? readRegistry(userDataDir) : { applications: [], ignoredPaths: [] };
  const paths = [...registry.applications.map(item => ({ appPath: item.appPath, imported: true })),
    ...automaticPaths.filter(file => !registry.ignoredPaths.includes(file)).map(appPath => ({ appPath, imported: false }))];
  const seen = new Set(), installed = [];
  for (const record of paths) {
    if (typeof record.appPath !== "string") continue;
    let row;
    try { row = inspectApplication(record.appPath); }
    catch (error) {
      if (!record.imported) continue;
      row = { version: identity(record.appPath), appPath: record.appPath, installDir: record.appPath, runtimePath: record.appPath,
        upstreamVersion: "Unavailable", versionLabel: `${path.basename(record.appPath)} · Unavailable`, ready: false,
        reason: "CrossOver application is unavailable. Add its current location in Runtimes.", external: true, imported: true,
        removalLabel: "Remove", removalConfirm: "Remove this application from Runtimes? The application will remain installed." };
    }
    if (seen.has(row.version)) continue;
    seen.add(row.version);
    installed.push({ ...row, imported: record.imported, automatic: !record.imported });
  }
  installed.sort(compareApplications);
  const repeated = new Map();
  for (const row of installed) repeated.set(row.versionLabel, (repeated.get(row.versionLabel) || 0) + 1);
  return installed.map(row => repeated.get(row.versionLabel) > 1
    ? { ...row, versionLabel: `${row.versionLabel} · ${path.dirname(row.appPath)}` } : row);
}
function normalizeSettings(value) {
  return { defaultVersion: typeof value?.defaultVersion === "string" && /^local-[a-f0-9]{16}$/.test(value.defaultVersion) ? value.defaultVersion : null };
}
function getState({ userDataDir, settings } = {}) {
  const installed = listInstalled(userDataDir), versions = installed.filter(item => item.ready).map(item => item.version);
  const versionLabels = Object.fromEntries(installed.map(item => [item.version, item.versionLabel]));
  const catalog = { status: "success", versions, versionLabels, delivery: "local", installable: false,
    importable: true, importLabel: "Add CrossOver…", importInputKinds: ["file"], importExtensions: ["app"],
    importDescription: "Register an installed CrossOver application. Applications remain in their original locations.",
    refreshLabel: "Find installed applications", supportsLatestOnly: false,
    source: "https://www.codeweavers.com/crossover", fetchedAt: null, error: null,
    latestInstalledVersion: versions[0] || null, latestAvailableVersion: null, updateAvailable: false };
  const section = { id: "default", label: "CrossOver applications", installed, installing: null,
    defaultVersion: selectRuntimeVersion({ defaultVersion: normalizeSettings(settings).defaultVersion, fallback: managerDefaultVersion({ installed: versions }) }).version,
    defaultSource: normalizeSettings(settings).defaultVersion ? "saved" : "manager", versionLabels, catalog, variants: [] };
  return { ...section, sections: [section] };
}
function importRuntime({ userDataDir, runtimePath } = {}) {
  if (!userDataDir) throw new Error("Launcher data directory is unavailable.");
  const installed = inspectApplication(runtimePath), registry = readRegistry(userDataDir);
  registry.applications = registry.applications.filter(item => item.appPath !== installed.appPath);
  registry.applications.push({ appPath: installed.appPath });
  registry.ignoredPaths = registry.ignoredPaths.filter(file => file !== runtimePath && file !== installed.appPath);
  writeRegistry(userDataDir, registry);
  return installed;
}
function uninstallRuntime({ userDataDir, version } = {}) {
  const installed = listInstalled(userDataDir).find(item => item.version === version);
  if (!installed) throw new Error("The selected CrossOver application was not found.");
  const registry = readRegistry(userDataDir);
  registry.applications = registry.applications.filter(item => item.appPath !== installed.appPath);
  for (const file of AUTOMATIC_PATHS) {
    let canonical; try { canonical = fs.realpathSync(file); } catch { canonical = file; }
    if (canonical === installed.appPath && !registry.ignoredPaths.includes(file)) registry.ignoredPaths.push(file);
  }
  writeRegistry(userDataDir, registry);
  return true;
}
function resolveSelection(entry, settings, userDataDir, runtimeSettings) {
  const installed = listInstalled(userDataDir);
  if (!runtimeSettings && userDataDir) {
    const manifest = require("../temporal/catalog").withSettingsOptions(require("../manifest.json"));
    runtimeSettings = createRuntimeSettingsStore({ userDataDir }).resolveForEntry(entry, settings,
      { ...manifest, id: entry?.moduleId || entry?.engine || "crossover" }, "crossover");
  }
  const manual = selectRuntimeVersion({ manual: runtimeSettings?.version,
    recommended: entry?.runtimeData?.crossover?.version }).version;
  const requested = selectRuntimeVersion({ manual,
    defaultVersion: normalizeSettings(settings?.runtimes?.crossover).defaultVersion,
    fallback: managerDefaultVersion({ installed: installed.filter(item => item.ready).map(item => item.version) }) }).version;
  const install = installed.find(item => item.version === requested);
  return { version: requested || install?.version || null, install: install || null, ready: Boolean(install?.ready),
    reason: install?.ready ? null : install?.reason || (requested
      ? "The selected CrossOver application is unavailable. Add its current location in Runtimes or select Automatic."
      : "CrossOver was not found. Add an installed CrossOver application in Runtimes.") };
}
const manager = { id: "crossover", label: "CrossOver", ui: { groupId: "crossover", tabLabel: "CrossOver", order: 200, memberOrder: 0 }, normalizeSettings, getState, importRuntime, uninstallRuntime, resolveSelection,
  refreshCatalog: async ({ userDataDir } = {}) => getState({ userDataDir }).catalog,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? { ...settings, defaultVersion: normalizeSettings({ defaultVersion: payload?.version }).defaultVersion } : settings,
  updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? settings : { ...settings, defaultVersion: installed.version },
  updateSettingsAfterUninstall: (settings, _payload, { userDataDir } = {}) => {
    const current = normalizeSettings(settings).defaultVersion;
    return listInstalled(userDataDir).some(item => item.version === current) ? settings : { ...settings, defaultVersion: null };
  },
  isAvailable: userDataDir => listInstalled(userDataDir).some(item => item.ready),
  core: { listInstalled, inspectApplication, identity },
  __test: { AUTOMATIC_PATHS, readRegistry, writeRegistry, registryPath, compareApplications } };
require("../../shared/runtime/custom-runtime").configure(manager, { inspect: inspectApplication });
module.exports = manager;
