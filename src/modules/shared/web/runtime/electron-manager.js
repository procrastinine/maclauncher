const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { resolveAppBundleExecutablePath } = require("../../runtime/app-bundle");
const Native = require("../../runtime/local-native");
const Upstream = require("../../runtime/upstream");

const ID = "electron";
// The Electron that runs MacLauncher. It is always installed and is the
// default until another version is made the default.
const INCLUDED = "included";
const RELEASES = "https://releases.electronjs.org/releases.json";
const DOWNLOADS = "https://github.com/electron/electron/releases/download";
// Electron reports a packaged app (app.isPackaged) when its executable has a
// name other than Electron. Each downloaded copy carries a second link to its
// executable under this name, and games start through that link.
const PACKAGED_EXECUTABLE = "Electron App";

// Electron's release index lists every release with its Chromium and Node
// versions. The macOS downloads are on GitHub under names set by version and
// CPU. Apple Silicon builds start with Electron 11; Intel builds cover every
// release and run on Apple Silicon through Rosetta.
const source = Upstream.index({ locations: [RELEASES], hosts: ["releases.electronjs.org", "github.com"], parse: ([document], { arch } = {}) => {
  const releases = JSON.parse(document.text);
  const rows = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = typeof release?.version === "string" ? release.version : "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const cpus = (Number(version.split(".")[0]) >= 11 ? ["arm64", "x64"] : ["x64"]).filter(cpu => !arch || cpu === arch);
    const details = { ...(typeof release.chrome === "string" ? { chrome: release.chrome } : {}), ...(typeof release.node === "string" ? { node: release.node } : {}) };
    for (const cpu of cpus) {
      const name = `electron-v${version}-darwin-${cpu}.zip`;
      rows.push({ version, architecture: cpu, details, sourceUrl: `https://github.com/electron/electron/releases/tag/v${version}`,
        ...(typeof release.date === "string" ? { publishedAt: release.date } : {}),
        files: [{ name, url: `${DOWNLOADS}/v${version}/${name}`, architecture: cpu }] });
    }
  }
  return rows;
} });

// Electron publishes the SHA-256 of each release's files in its SHASUMS256.txt.
// A download whose checksum differs is not installed. A release without the
// list keeps the checksum of its download.
async function verifyArtifact({ archiveSha256, pin, signal, logger }) {
  const location = `${DOWNLOADS}/v${pin.version}/SHASUMS256.txt`;
  const checksums = Upstream.index({ locations: [location], hosts: ["github.com"], parse: ([document]) => [{ version: pin.version,
    files: document.text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim())).filter(Boolean)
      .map(([, digest, name]) => ({ name, url: `${DOWNLOADS}/v${pin.version}/${name}`, digest })) }] });
  let row;
  try { [row] = await checksums.discover({ signal, logger }); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (String(error?.message || "").endsWith(`${location} answered 404.`)) return null;
    throw new Error(`Electron's checksum list for ${pin.version} is unavailable. ${error?.message || error}`);
  }
  const value = row?.files?.find(file => file.name === pin.asset.filename)?.digest;
  const listed = (typeof value === "string" ? value : value?.value)?.toLowerCase();
  if (!listed) throw new Error(`Electron's checksum list for ${pin.version} does not list ${pin.asset.filename}. Nothing was installed.`);
  if (listed !== archiveSha256) throw new Error(`${pin.asset.filename} does not match Electron's published checksum. Nothing was installed.`);
  return { verified: true, identity: "Electron SHASUMS256.txt", archiveSha256 };
}

function resolveExecutable(root) {
  return resolveAppBundleExecutablePath(path.join(root, "Electron.app"), PACKAGED_EXECUTABLE);
}

function prepareInstall({ unpacked }) {
  const executable = resolveAppBundleExecutablePath(path.join(unpacked, "Electron.app"));
  if (!executable) throw new Error("The Electron download contains no Electron.app.");
  const packaged = path.join(path.dirname(executable), PACKAGED_EXECUTABLE);
  if (!fs.existsSync(packaged)) fs.linkSync(executable, packaged);
  return { architectures: Native.readMachOArchitectures(executable) };
}

function includedVersion() {
  if (process.versions.electron) return process.versions.electron;
  try { return require("electron/package.json").version; } catch { return null; }
}

function includedSelection() {
  try {
    const executablePath = require("../../../../core/electron-binary").resolveElectronBinary();
    return { version: INCLUDED, ready: true, reason: null, included: true,
      install: { version: INCLUDED, included: true, executablePath, runtimeVersion: includedVersion() } };
  } catch (error) {
    return { version: INCLUDED, ready: false, included: true, install: null, reason: error.message };
  }
}

// Detection records the game's own Electron app here. Other versions than the
// included one run that app, so a game without one always uses the included
// Electron.
const APP_RECORD = "electron-app";
const hasApp = entry => typeof entry?.runtimeData?.[APP_RECORD]?.app === "string" && Boolean(entry.runtimeData[APP_RECORD].app);
const runtimeData = entry => entry?.runtimeData?.[entry?.runtimeId] || null;
const chosen = value => typeof value === "string" && value.trim() && value.trim() !== "auto" ? value.trim() : null;
const managerSettings = settings => settings?.runtimes ? settings.runtimes[ID] : settings;

function createElectronManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: ID, label: "Electron", runtimeId: ID,
    sourceUrl: "https://github.com/electron/electron", sourceName: "Electron releases", upstream: source, maxEntries: 2000,
    resolveExecutable, prepareInstall, verifyArtifact,
    versionContents: pin => [pin.chrome && `Chromium ${pin.chrome}`, pin.node && `Node ${pin.node}`].filter(Boolean).join(" · ") || null,
    // A game's app states no Electron release; any version is a choice.
    versionCompatibility: () => true, dependencies });

  const label = () => [includedVersion(), "MacLauncher"].filter(Boolean).join(" · ");
  const includedRow = () => ({ version: INCLUDED, versionLabel: label(), ready: true, included: true, readOnly: true, removable: false,
    supportsDefault: true, detail: "The Electron that runs MacLauncher", ...(includedVersion() ? { sortVersion: includedVersion() } : {}) });

  // The included row joins the installed versions. Without a saved default it
  // is the default.
  const getState = manager.getState;
  manager.getState = function(options = {}) {
    const state = getState.call(this, options), saved = manager.normalizeSettings(options.settings).defaultVersion || null;
    const display = section => ({ ...section, installed: [includedRow(), ...(section.installed || [])],
      versionLabels: { ...section.versionLabels, [INCLUDED]: label() },
      ...(saved ? {} : { defaultVersion: INCLUDED, defaultSource: "manager" }) });
    return { ...display(state), sections: state.sections?.map(display) };
  };

  // The game's own choice comes first, then the saved default, then the
  // included Electron. A saved default of another version applies only to
  // games with an Electron app of their own; a game without one asked to use
  // such a version learns why it cannot, before anything is downloaded.
  const resolveSelection = manager.resolveSelection;
  manager.resolveSelection = function(entry, settings, userDataDir, options = {}) {
    const own = runtimeData(entry), version = chosen(options.version) || chosen(own?.version);
    if (version === INCLUDED) return includedSelection();
    if (entry && !hasApp(entry)) {
      return version ? { version: null, ready: false, included: false, install: null,
        reason: `Electron ${version} runs a game's own Electron app, and this game has none. Choose MacLauncher's Electron.` } : includedSelection();
    }
    if (!version && !manager.normalizeSettings(managerSettings(settings)).defaultVersion) return includedSelection();
    // The choice is kept under the runtime that shows it; the version list reads it as Electron's.
    const subject = entry && entry.runtimeId !== ID ? { ...entry, runtimeData: { ...entry.runtimeData, [ID]: own } } : entry;
    return resolveSelection.call(this, subject, settings, userDataDir, { ...options, ...(version ? { version } : {}) });
  };

  // Making the included Electron the default clears the saved default.
  const applySettingsUpdate = manager.applySettingsUpdate;
  manager.applySettingsUpdate = function(action, payload, settings, ...context) {
    if (action === "setDefault" && payload?.version === INCLUDED) return applySettingsUpdate.call(this, action, { ...payload, version: null }, settings, ...context);
    return applySettingsUpdate.call(this, action, payload, settings, ...context);
  };
  // Installing a version leaves the default unchanged, and removing the default
  // version returns the default to the included Electron.
  manager.updateSettingsAfterInstall = () => undefined;
  manager.updateSettingsAfterUninstall = (settings, payload) => {
    const saved = manager.normalizeSettings(settings).defaultVersion;
    return saved && saved === payload?.version ? { ...settings, defaultVersion: null } : undefined;
  };
  return Object.assign(manager, { INCLUDED, APP_RECORD, PACKAGED_EXECUTABLE, includedVersion, includedSelection, source, verifyArtifact, prepareInstall, resolveExecutable });
}

module.exports = createElectronManager();
module.exports.createElectronManager = createElectronManager;
