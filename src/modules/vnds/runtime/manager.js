const path = require("node:path");
const Bundled = require("../../shared/runtime/bundled-native");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "vnds-love", label: "VNDS-LOVE",
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/ajusa/VNDS-LOVE",
    manifestRelative: "manifest.json", sourceRelative: "manifest.json",
    executableRelative: "engine/main.lua", dataOnly: true, supportsDefault: true,
    validateManifest(manifest, record) {
      if (manifest.kind !== "data" || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision || "") ||
          record.source && manifest.sourceRevision !== record.source.revision || manifest.loveVersion !== "11.5" ||
          !manifest.files.some(file => file.path === "engine/conf.lua") || !manifest.files.some(file => file.path === "engine/LICENSE"))
        throw new Error("The VNDS-LOVE package has an unsupported interpreter profile.");
    },
    async verifyPayload(selected, { signal } = {}) { signal?.throwIfAborted(); Bundled.verifyPayload(selected.root, selected.declaration); },
    dependencies });
}
const manager = createManager();
function resolveEngine(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready || !selected.install) throw new Error(selected.reason || "The selected VNDS-LOVE version is not installed.");
  Bundled.verifyPayload(selected.install.root, selected.install.declaration);
  return { ...selected.install, root: path.join(selected.install.payloadRoot, "engine"), profile: selected.install.manifest };
}
module.exports = { ...manager, createManager, resolveEngine };
