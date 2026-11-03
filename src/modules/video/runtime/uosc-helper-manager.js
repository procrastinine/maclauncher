const fs = require("node:fs"), path = require("node:path");
const { cloneOrCopySync } = require("../../shared/copy-file");
const Upstream = require("../../shared/runtime/upstream");
const {createPinnedNativeManager} = require("../../shared/runtime/pinned-native-manager");
const {extractPayload} = require("../../shared/runtime/release-files");
const {throwIfAborted, isAbortError} = require("../../shared/runtime/download-utils");

const source = Upstream.github({repository: "tomasklaen/uosc", recognize: release => {
  if (typeof release?.tag_name !== "string") return [];
  const archives = (release.assets || []).filter(asset => /^uosc(?:[._-]|$)/i.test(asset.name || "") && /\.zip$/i.test(asset.name));
  const archive = archives.find(asset => asset.name === "uosc.zip") || archives[0];
  return archive ? {version: release.tag_name, assets: [archive]} : [];
}});

function createManager(dependencies = {}) {
  return createPinnedNativeManager({id: "uosc-helper", label: "uosc helper", upstream: source,
    sourceUrl: "https://github.com/tomasklaen/uosc/releases",
    projectBuilds: {projectId: "uosc-helper", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true},
    resolveExecutable: root => path.join(root, "ziggy-darwin"),
    prepareInstall: async ({unpacked, pin, signal}) => await Upstream.githubLicense({repository: "tomasklaen/uosc",
      revision: pin.upstreamRevision, destination: path.join(unpacked, "LICENSE"), signal}) || undefined,
    dependencies: {extractArchive: (archive, destination, signal) => extractPayload(archive, destination, signal,
      {payloadName: "ziggy-darwin", project: "uosc helper", copy: (file, target) => {
        cloneOrCopySync(file, target); fs.chmodSync(target, 0o755);
      }}), ...dependencies}});
}

const manager = createManager();
manager.ui = {groupId: "mpv", tabLabel: "mpv player", sectionLabel: "uosc helper", order: 210, memberOrder: 2, management: "managed"};

// Plugin installation already has consent. The shared manager chooses the CPU,
// source and version; replacing a staged helper never changes an active plugin.
async function stageHelper({root, binary, ...context}) {
  const selectedManager = manager;
  const resolve = () => selectedManager.resolveSelection({}, context.settings, context.userDataDir);
  try {
    let selected = resolve();
    if (!selected.ready) {
      await selectedManager.refreshCatalog({...context, sourceId: "builds", force: false});
      selected = resolve();
    }
    const pin = selected.version && selectedManager.core.listCatalog({userDataDir: context.userDataDir}).find(pin => pin.version === selected.version);
    // A publisher helper is already present in the plugin. An explicit installed
    // choice remains usable; a missing optional Builds package keeps that helper.
    if (!selected.ready && !pin?.projectPackage) return null;
    if (!selected.ready) {
      await selectedManager.installRuntime({...context, version: selected.version, architecture: selected.architecture});
      selected = resolve();
    }
    if (!selected.ready) return null;
    const install = selected.install;
    const payload = install.catalogEntry?.projectPackage ? path.join(install.installDir, "project-payload", "files") : install.installDir;
    try {
      if (fs.existsSync(path.join(payload, "licenses")))
        cloneOrCopySync(path.join(payload, "licenses"), path.join(root, "licenses", "uosc-helper"));
    } catch (error) { console.warn("The optional uosc licenses could not be copied:", error.message); }
    cloneOrCopySync(install.executablePath, binary + ".native");
    fs.chmodSync(binary + ".native", 0o755); fs.renameSync(binary + ".native", binary);
    return {managerId: manager.id, version: selected.version, architecture: install.architecture};
  } catch (error) {
    try { fs.rmSync(binary + ".native", {force: true}); } catch {}
    throwIfAborted(context.signal);
    if (isAbortError(error)) throw error;
    context.logger?.warn?.(`The uosc publisher helper remains available: ${error.message}`);
    return null;
  }
}

module.exports = Object.assign(manager, {createManager, stageHelper});
