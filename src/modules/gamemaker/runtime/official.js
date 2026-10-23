const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const AppBundle = require("../../shared/runtime/app-bundle");
const { hashFile } = require("../inspect");
const Packages = require("./official-packages");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const Catalog = require("./official-catalog");
const Compatibility = require("./official-compatibility");
const Legacy = require("./official-legacy");

const ID = "gamemaker-official";
const VERSION = Catalog.VERSION;
const RUNNER_NAMES = new Set(["Mac_Runner", "Runner", "YoYoRunner", "YoYo Runner", "GameMakerRunner"]);
const HELP_URL = "https://gamemaker.io/en/help/articles/how-to-download-gamemaker-s-runtime-tools-without-using-the-ide";

function normalizeVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error("Official runtime needs an explicit vendor build version.");
  return value;
}
function boundedJson(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Official runtime metadata is missing or too large.");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function receiptVersion(receipt) {
  // Receipt schemas vary. Read only known version fields; do not expose account/licence data.
  for (const key of ["version", "Version", "runtimeVersion", "RuntimeVersion"]) {
    const value = receipt?.[key];
    if (typeof value === "string" && VERSION.test(value)) return value;
  }
  return null;
}
function inspectOfficialRuntime(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot) || runtimeRoot.includes("\0")) throw new Error("Select an absolute installed GameMaker runtime directory.");
  const root = path.resolve(runtimeRoot);
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Select an installed runtime directory; vendor ZIPs must be validated and installed by GameMaker first.");
  const folderVersion = path.basename(root).match(/^runtime-(\d+\.\d+\.\d+\.\d+)$/)?.[1] || null;
  const receiptPath = path.join(root, "receipt.json");
  const receipt = boundedJson(receiptPath);
  const fromReceipt = receiptVersion(receipt);
  if (folderVersion && fromReceipt && folderVersion !== fromReceipt) throw new Error("Official runtime folder and metadata versions disagree.");
  const version = normalizeVersion(fromReceipt || folderVersion);
  const manifestRoot = path.join(root, "manifest");
  const manifestStat = fs.lstatSync(manifestRoot);
  if (!manifestStat.isDirectory() || manifestStat.isSymbolicLink()) throw new Error("Official runtime must contain a receipt.json and manifest directory.");
  const manifestNames = fs.readdirSync(manifestRoot).sort();
  if (manifestNames.length > 128) throw new Error("Official runtime has too many manifest files.");
  const manifests = [];
  let manifestBytes = 0;
  for (const name of manifestNames) {
    const filePath = path.join(manifestRoot, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    manifestBytes += stat.size;
    if (stat.size > 8 * 1024 ** 2 || manifestBytes > 32 * 1024 ** 2) throw new Error("Official runtime manifests exceed the inspection limit.");
    manifests.push({ name, sha256: hashFile(filePath) });
  }
  const diskImages = [];
  const diskImage = path.join(root, "mac", "Mac-YoYoRunner-Release.dmg");
  if (fs.existsSync(diskImage)) {
    const stat = fs.lstatSync(diskImage);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error("Official runner disk image is invalid or exceeds the inspection limit.");
    diskImages.push({ path: diskImage, sha256: hashFile(diskImage) });
  }
  // Current Igor produces an empty manifest directory and a module receipt.
  // This is inventory evidence, not a claim that vendor manifest verification passed.
  if (!manifests.length && !(diskImages.length && typeof receipt.mac === "string" && typeof receipt.base === "string")) throw new Error("Official runtime is missing its Mac module metadata.");
  const runners = [];
  let visited = 0;
  function walk(dir, depth) {
    if (depth > 7) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 3000) throw new Error("Official runtime inventory exceeds the file limit.");
      if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name.endsWith(".app")) {
          const executable = AppBundle.resolveAppBundleExecutablePath(full);
          if (executable && RUNNER_NAMES.has(path.basename(executable))) addRunner(executable, full);
        } else walk(full, depth + 1);
      } else if (item.isFile() && RUNNER_NAMES.has(item.name)) addRunner(full, null);
    }
  }
  function addRunner(executablePath, appPath) {
    try {
      const architectures = Native.readMachOArchitectures(executablePath);
      runners.push({ executablePath, appPath, architectures, binarySha256: hashFile(executablePath) });
    } catch {} // Windows/Linux/compiler templates are inventory limits, not runnable Mac engines.
  }
  // Compiler caches can be large. Limit inspection to the macOS target and runner directories.
  for (const name of ["mac", "macos", "osx", "runner", "Runner.app"]) {
    const candidate = path.join(root, name);
    if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) continue;
    if (name.endsWith(".app")) {
      const executable = AppBundle.resolveAppBundleExecutablePath(candidate);
      if (executable && RUNNER_NAMES.has(path.basename(executable))) addRunner(executable, candidate);
    } else if (fs.statSync(candidate).isDirectory()) walk(candidate, 0);
  }
  const receiptSha256 = hashFile(receiptPath);
  const manifestSha256 = crypto.createHash("sha256").update(JSON.stringify(manifests)).digest("hex");
  return { version, runtimeRoot: root, versionSource: fromReceipt ? "vendor-receipt" : "runtime-folder-name",
    receiptSha256, manifestSha256, manifestCount: manifests.length, runners, diskImages,
    runnerAvailable: runners.length > 0, vendorIntegrityVerified: false, launchReady: false,
    qualification: "Official runtime found. Import is required before playing; game compatibility varies.",
    helpUrl: HELP_URL };
}

function registrationDir(userDataDir, version) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new Error("An absolute launcher data directory is required.");
  const parts = ["runtimes", ID, normalizeVersion(version)];
  let current = path.resolve(userDataDir);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) throw new Error("Official runtime registration path contains a symlink.");
  }
  return current;
}
function registerOfficialRuntime({ userDataDir, runtimeRoot }) {
  const inspection = inspectOfficialRuntime(runtimeRoot);
  const directory = registrationDir(userDataDir, inspection.version);
  if (fs.existsSync(path.join(directory, "runtime.json"))) throw new Error(`Official GameMaker ${inspection.version} is already registered. Remove its registration before replacing it.`);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.runtime-${crypto.randomUUID()}.json`);
  fs.writeFileSync(temp, JSON.stringify({ ...inspection, registeredAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temp, path.join(directory, "runtime.json"));
  return inspection;
}
async function importOfficialRuntime({ userDataDir, runtimeRoot, runtimePath, version: selectedVersion, dependencies = {} }) {
  runtimeRoot = runtimeRoot || runtimePath;
  const inspection = inspectOfficialRuntime(runtimeRoot);
  if (selectedVersion && normalizeVersion(selectedVersion) !== inspection.version) throw new Error("Selected official build does not match the imported runtime directory version.");
  const Installer = require("./official-installer");
  const directory = registrationDir(userDataDir, inspection.version);
  if (fs.existsSync(directory)) throw new Error(`Official GameMaker ${inspection.version} is already registered or incomplete. Remove its registration before replacing it.`);
  const root = Installer.ownedDirectory(userDataDir, path.join("runtimes", ID));
  const staging = fs.mkdtempSync(path.join(root, ".import-"));
  try {
    const app = path.join(staging, "YoYo Runner.app");
    let executable;
    if (inspection.runners.length === 1 && inspection.runners[0].appPath) {
      await (dependencies.runProcess || require("../tools").runTool)("/usr/bin/ditto", [inspection.runners[0].appPath, app], { timeout: 60000 });
      executable = path.join(app, "Contents", "MacOS", "Mac_Runner");
    } else if (inspection.diskImages.length === 1) {
      const diskImage = inspection.diskImages[0];
      if (inspection.version === Installer.BUILD.version && diskImage.sha256 !== Installer.BUILD.diskImageSha256) throw new Error("Official runner disk image checksum does not match this build.");
      executable = await (dependencies.extractRunnerApp || Installer.extractRunnerApp)(diskImage.path, app, dependencies);
    } else throw new Error("This vendor runtime has no unambiguous complete Mac runner app/disk image to import.");
    const upstreamRevision = `vendor-runtime:${inspection.version}`;
    const native = Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: inspection.version, upstreamRevision });
    if (inspection.version === Installer.BUILD.version && native.sha256 !== Installer.BUILD.binarySha256) throw new Error("Official runner executable checksum does not match this build.");
    const record = { ...inspection, runnerAppPath: path.join(directory, "YoYo Runner.app"),
      executablePath: path.join(directory, "YoYo Runner.app", "Contents", "MacOS", "Mac_Runner"),
      runnerTreeSha256: require("./official-launch").hashRunnerTree(app), upstreamRevision, binarySha256: native.sha256,
      backend: "official-studio-vm", source: "local-vendor-import", artifactsPinned: false, runtimeReady: true,
      launchReady: true, gameplayQualified: false, installedAt: new Date().toISOString(),
      qualification: "Runs compatible GameMaker Studio data using the selected official Mac runtime." };
    fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(staging, directory);
    const installed = resolveInstalled({ userDataDir, version: inspection.version });
    if (!installed?.launchReady) throw new Error("Imported official runner failed its final build identity check.");
    return installed;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
function resolveInstalled({ userDataDir, version }) {
  try {
    const directory = registrationDir(userDataDir, version);
    const record = boundedJson(path.join(directory, "runtime.json"));
    if (record.source === "vendor-legacy-package") return require("./official-legacy").resolveInstalled({ record, directory, version });
    const current = inspectOfficialRuntime(record.runtimeRoot);
    if (record.version !== version || current.version !== version || current.receiptSha256 !== record.receiptSha256 || current.manifestSha256 !== record.manifestSha256 ||
      JSON.stringify(current.runners) !== JSON.stringify(record.runners) || JSON.stringify(current.diskImages) !== JSON.stringify(record.diskImages)) return null;
    if (!record.launchReady) return { ...record, installDir: directory, ready: false, status: "inventory" };
    if (!["vendor-native-install", "local-vendor-import"].includes(record.source) || record.upstreamRevision !== `vendor-runtime:${version}` ||
      !/^[a-f0-9]{64}$/.test(record.binarySha256 || "") || !record.runnerAppPath || !record.runnerTreeSha256) return null;
    const native = Native.resolveLocalRuntime({ runtimePath: record.runnerAppPath, runtimeVersion: version,
      upstreamRevision: record.upstreamRevision, expectedSha256: record.binarySha256, preferredExecutable: "Mac_Runner" });
    if (require("./official-launch").hashRunnerTree(record.runnerAppPath) !== record.runnerTreeSha256) return null;
    return { ...record, ...native, installDir: directory, ready: true, status: "ready", runtimeReady: true };
  } catch { return null; }
}
function listInstalled(userDataDir) {
  try {
    const root = path.join(userDataDir, "runtimes", ID);
    return fs.readdirSync(root).filter(name => VERSION.test(name)).map(version => resolveInstalled({ userDataDir, version })).filter(Boolean);
  } catch { return []; }
}
function normalizeSettings(settings) { return { defaultVersion: typeof settings?.defaultVersion === "string" ? settings.defaultVersion : null }; }
function resolveSelection(entry, settings, userDataDir) {
  const data = entry?.runtimeData || {};
  const override = Object.hasOwn(data, "official-studio") ? data["official-studio"]?.version : data[ID]?.version;
  const requested = typeof override === "string" && override.trim() ? override.trim() : null;
  const preferred = normalizeSettings(settings?.runtimes?.[ID]).defaultVersion;
  const inspection = entry?.moduleData || {}, cached = Catalog.cachedCatalog(userDataDir)?.entries || [];
  const accepts = version => Compatibility.compatibility(inspection, version).compatible;
  let version = requested, selectionSource = requested ? "explicit-selection" : null, install = null;
  if (!version && preferred && accepts(preferred)) { version = preferred; selectionSource = "compatible-global-default"; }
  if (!version) {
    // Check only compatible version directories; unrelated installed generations
    // need no hashing or inspection during this game's launch selection.
    let installedVersions = [];
    const recommended = Compatibility.defaultCandidates(inspection);
    try { installedVersions = fs.readdirSync(path.join(userDataDir, "runtimes", ID)).filter(name => VERSION.test(name) && accepts(name))
      .sort((a, b) => (recommended.includes(a) ? recommended.indexOf(a) : 1000) - (recommended.includes(b) ? recommended.indexOf(b) : 1000) || Catalog.versionCompare(a, b)); } catch {}
    for (const candidate of installedVersions) {
      const existing = resolveInstalled({ userDataDir, version: candidate });
      if (existing?.launchReady) { version = candidate; install = existing; selectionSource = "installed-format-recommendation"; break; }
    }
  }
  if (!version && inspection.wadVersion === 16) { version = Legacy.BUILD.version; selectionSource = "format-generation-default"; }
  if (!version) {
    const recommended = Compatibility.defaultCandidates(inspection);
    const priority = version => recommended.includes(version) ? recommended.indexOf(version) : 1000;
    const candidate = [...cached].filter(item => accepts(item.version)).sort((a, b) =>
      priority(a.version) - priority(b.version) || Catalog.versionCompare(a.version, b.version))[0];
    if (candidate) { version = candidate.version; selectionSource = "cached-format-recommendation"; }
  }
  if (!version) {
    version = Compatibility.defaultCandidates(inspection)[0] || null;
    selectionSource = version ? inspection.wadVersion === 16 ? "format-generation-default" : "reviewed-default" : "unqualified-generation";
  }
  if (!version) return { version: null, install: null, ready: false, selectionSource, reason:
    inspection.minimumEngineVersion && inspection.maximumOfficialRuntimeExclusive &&
      require("../version").compareVersions(inspection.minimumEngineVersion, inspection.maximumOfficialRuntimeExclusive) >= 0
      ? "This archive has conflicting resource format constraints; no official runner can satisfy both."
      : `No compatible official Mac runner for WAD ${inspection.wadVersion ?? "unknown"}. Butterscotch is available for supported VM formats.` };
  const result = Compatibility.compatibility(inspection, version);
  if (!result.compatible) return { version, install: null, ready: false, selectionSource, capability: result.capability, reason: result.reason };
  install ||= resolveInstalled({ userDataDir, version });
  let catalogReady = true;
  try { require("./official-installer").resolveBuild({ userDataDir, version }); } catch { catalogReady = false; }
  if (!requested && !catalogReady && !install?.launchReady) selectionSource = "format-recommendation-unavailable";
  return { version, install: install?.launchReady ? install : null, ready: Boolean(install?.launchReady), capability: result.capability,
    catalogReady, selectionSource, reason: install?.launchReady ? null : `GameMaker ${version} is not installed.` };
}
function listRuntimeRows(userDataDir) {
  try {
    return fs.readdirSync(path.join(userDataDir, "runtimes", ID)).filter(name => VERSION.test(name)).map(version => {
      const install = resolveInstalled({ userDataDir, version });
      return install || { version, ready: false, status: "damaged", error: "Official runtime metadata or runner changed. Reinstall or import this version again." };
    });
  } catch { return []; }
}
function catalogState(userDataDir, installed = []) {
  const cached = Catalog.cachedCatalog(userDataDir), versions = [...new Set([...(cached?.entries || []).map(item => item.version), ...installed.map(item => item.version)])].sort(Catalog.versionCompare);
  const state = Catalog.stateFor(userDataDir), hostSupported = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch);
  const installableVersions = hostSupported ? versions.filter(version => {
    try { require("./official-installer").resolveBuild({ userDataDir, version }); return true; } catch { return false; }
  }) : [];
  return { ...state, versions, source: Catalog.FEEDS.map(feed => feed.url).join(" · "), sourceUrl: Catalog.FEEDS[0].url,
    fetchedAt: cached?.fetchedAt || null, versionDetails: versions.map(version => {
      const entry = cached?.entries.find(item => item.version === version) || (version === Legacy.BUILD.version ? Legacy.BUILD : null);
      return { version, channel: entry?.channel || null, sourceUrl: entry?.source || null, publishedAt: entry?.publishedAt || null,
        gameplayQualified: false, ...Compatibility.capabilityForVersion(version) };
    }),
    versionLabels: Object.fromEntries((cached?.entries || []).map(entry => [entry.version, `${entry.version} (${entry.channel})`])),
    supportsLatestOnly: false, updateAvailable: false, latestAvailableVersion: versions[0] || null,
    installable: hostSupported, installableVersions, importable: true,
    importLabel: "Import runtime", importInputKinds: ["directory"],
    importDescription: "A complete runtime-<version> folder containing receipt.json, manifest/ and the Mac runner app or disk image.",
    installReason: "Installs the Mac runtime and, for Studio 2, Igor automatically. No IDE or account required." };
}
function getState({ settings, userDataDir } = {}) {
  const installed = userDataDir ? listRuntimeRows(userDataDir) : [];
  const tool = require("./official-installer").getIgorStatus({ userDataDir });
  const pin = require("./official-installer").bootstrapForArch();
  const localTools = require("./official-tools").listLocalIgors({ userDataDir });
  const toolVersions = [...new Set([pin.version, ...localTools.map(item => item.version), tool.version])];
  const bootstrapInstalled = require("./official-installer").getIgorStatus({ userDataDir, toolVersion: pin.version }).ready;
  const setupActions = [{ id: "installIgor", toolLabel: "Igor", label: "Igor", buttonLabel: tool.status === "damaged" ? "Repair Igor" : "Install Igor", installed: tool.ready,
    version: tool.version, versions: toolVersions, versionLabels: { [pin.version]: `Igor ${pin.version} (${process.arch})`,
      ...Object.fromEntries(localTools.map(item => [item.version, item.versionLabel])) },
    selectedVersion: tool.version, installedVersion: tool.ready ? tool.version : null,
    installedVersions: [...(bootstrapInstalled ? [pin.version] : []), ...localTools.filter(item => item.installed).map(item => item.version)],
    architecture: process.arch, archiveSha256: tool.archiveSha256, binarySha256: tool.binarySha256 || null,
    description: `Igor installs automatically with Studio 2 runtimes (31–33 MB), under Launcher Data/runtimes/gamemaker-official/tools/.`, sourceUrl: tool.sourceUrl }];
  const state = { ...normalizeSettings(settings), installed, installing: null, variants: [],
    setupActions, catalog: catalogState(userDataDir, installed) };
  return { ...state, sections: [{ id: "default", label: "Official", ...state }] };
}
const manager = {
  id: ID, label: "GameMaker", normalizeSettings, getState, resolveSelection,
  delivery: { catalog: "remote", included: "none", sourceBuild: false },
  refreshCatalog: async options => { await Catalog.refreshCatalog(options); return catalogState(options?.userDataDir, listRuntimeRows(options?.userDataDir)); },
  importRuntime: importOfficialRuntime,
  performSetupAction: ({ setupActionId, downloads, onProgress, ...options } = {}) => {
    if (setupActionId !== "installIgor") throw new Error("Unknown official GameMaker setup action.");
    const Installer = require("./official-installer"), pin = Installer.bootstrapForArch();
    const version = options.toolVersion || require("./official-tools").getSelectedIgorVersion(options) || pin.version;
    return runDownloadTask(downloads, { label: "GameMaker Igor", detail: `Igor ${version} (${process.arch})`,
      kind: "runtime-tool", managerId: ID, sectionId: "default", version, dedupeKey: `${ID}:igor:${process.arch}:${version}` },
    task => Installer.ensureIgor({ userDataDir: options.userDataDir, toolVersion: options.toolVersion, signal: task.signal, onProgress: task.onProgress,
      prerequisiteContext: options.prerequisiteContext, confirmRuntimeInstall: options.confirmRuntimeInstall, logger: options.logger,
      download: options.dependencies?.downloadToFile, runProcess: options.dependencies?.runProcess }), { onProgress });
  },
  installRuntime: ({ downloads, onProgress, ...options } = {}) => {
    const version = options.version || Packages.CATALOG[0].version;
    const existing = resolveInstalled({ userDataDir: options.userDataDir, version });
    if (existing?.launchReady) return Promise.resolve(existing);
    return runDownloadTask(downloads, { label: "GameMaker runtime", detail: version === Legacy.BUILD.version ? `${version}: Studio 1.4 Mac module (34 MB)` : `${version}: Mac runtime and Igor`,
      kind: "runtime", managerId: ID, sectionId: "default", version, dedupeKey: `${ID}:${version}` },
    task => require("./official-installer").installOfficialVersion({ ...options, version, signal: task.signal, onProgress: task.onProgress }), { onProgress });
  },
  uninstallRuntime: ({ userDataDir, version }) => { fs.rmSync(registrationDir(userDataDir, version), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return true; },
  applySettingsUpdate: (action, payload, settings) => action === "setDefault" ? { ...settings, defaultVersion: payload?.version ? normalizeVersion(payload.version) : null } : settings,
  updateSettingsAfterInstall: (settings, installed) => ({ ...settings, defaultVersion: settings?.defaultVersion || installed.version }),
  updateSettingsAfterUninstall: (settings, payload) => ({ ...settings, defaultVersion: settings?.defaultVersion === payload?.version ? null : settings?.defaultVersion || null }),
  core: { normalizeVersion, registerOfficialRuntime, importOfficialRuntime, inspectOfficialRuntime, resolveInstalled, listInstalled, listRuntimeRows,
    catalog: [require("./official-installer").BUILD, Legacy.BUILD] }
};

module.exports = { manager, inspectOfficialRuntime, registerOfficialRuntime, importOfficialRuntime, HELP_URL };
