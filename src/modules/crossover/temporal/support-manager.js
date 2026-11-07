const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const { withDescription } = require("../../shared/runtime/pinned-native-manager");
const Bundled = require("../../shared/runtime/bundled-native");
const Catalog = require("./catalog");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function createManager(options) { return require("../../shared/runtime/translator-managers").createManager("dxmt", options); }

const FidelityFX = Catalog.FIDELITYFX_PROFILE;
const API_PROJECTS = Object.freeze({
  "fidelityfx-api": { label: "FidelityFX API adapter", source: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",
    description: "A proxy for a Windows game's FidelityFX library that records its upscale dispatches as MacLauncher temporal frames, so the selected MacLauncher upscaler runs." }
});
const apiVerified = new Map();
// Schema 2: one proxy per backend, each with the five FidelityFX API exports.
function apiDescriptor(manifest) {
  const provider = manifest.provider;
  if (Bundled.isManagedDeclaration(manifest)) return provider || {};
  const backends = Object.entries(provider?.backends || {});
  if (provider?.schema !== 2 || provider.profile !== FidelityFX.id || provider.temporalFrames !== 1 || !backends.length ||
      backends.some(([backend, row]) => FidelityFX.libraries[backend] !== row?.library ||
        manifest.files.find(file => file.path === row.library)?.sha256 !== row.sha256))
    throw Error("The FidelityFX package has no supported provider profile.");
  return provider;
}
function verifyAPI(install, projectId, verification = "full") {
  if (Bundled.isManagedDeclaration(install.declaration)) {
    Bundled.verifyPayload(install.root,install.declaration,install.resolveDependency);
    return install;
  }
  const key = install.root, stamp = install.declaration.files.map(file => Bundled.fileIdentity(path.join(key, file.path), { maximum: file.size })).join("|");
  if (verification !== "status" || apiVerified.get(key) !== stamp) {
    Bundled.verifyPayload(key, install.declaration);
    const provider = apiDescriptor(install.manifest), FFX = require("./fidelityfx");
    if (Object.values(provider.backends || {}).some(row => !FFX.apiExports(require("./streamline/pe-exports").inspect(path.join(install.payloadRoot, row.library)))))
      throw Error("The FidelityFX package exports differ from the FidelityFX API.");
    if (apiVerified.size > 16) apiVerified.clear();apiVerified.set(key, stamp);
  }
  return install;
}
function createAPIManager(projectId, dependencies = {}) {
  const definition = API_PROJECTS[projectId];if (!definition) throw Error("Unknown graphics API project.");
  const inspectRuntime = ({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) => {
    const stat = fs.lstatSync(runtimePath), exports = require("./streamline/pe-exports").inspect(runtimePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !exports)
      throw Error("The FidelityFX runtime is not a readable PE library.");
    const sha256 = hash(runtimePath);
    if (expectedSha256 && sha256 !== expectedSha256) throw Error("The FidelityFX adapter checksum changed.");
    return { executablePath: runtimePath, architectures: ["x86_64"], needsRosetta: false, runtimeVersion, upstreamRevision, sha256 };
  };
  const manager = createProjectBuildManager({ projectId, label: definition.label,
    repository: "procrastinine/maclauncher-builds", upstreamUrl: definition.source, nativeLibrary: true,
    inspectRuntime,
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: manifest => manifest.executableRelative,
    validateManifest: manifest => {
      if (Bundled.isManagedDeclaration(manifest)) return;
      const provider = apiDescriptor(manifest);
      if (!Object.values(provider.backends).some(row => row.library === manifest.executableRelative))
        throw Error("The graphics API package has an unexpected primary library.");
    },
    verifyPayload: async (selected, { signal } = {}) => {
      verifyAPI(selected, projectId);
      await Bundled.verifySignatures(selected.root, selected.declaration, { signal });
    }, dependencies });
  return { ...withDescription(manager, definition.description), distributionRequired: false,
    ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: definition.label, memberOrder: 24, management: "managed" },
    resolvePayload(entry, context = {}, options = {}) {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, options);
      if (!selected.ready || !selected.install) return selected;
      try {
        const install = verifyAPI(selected.install, projectId, options.verification || "status");
        return { ...selected, install, provider: apiDescriptor(install.manifest) };
      } catch (error) { return { ...selected, ready: false, install: null, reason: error.message }; }
    }
  };
}
const apiManagers = Object.freeze(Object.fromEntries(Object.keys(API_PROJECTS).map(id => [id, createAPIManager(id)])));
const support = createManager(), managers = Object.freeze({ [support.id]: support, ...apiManagers });
module.exports = { ...support, managers, apiManagers, forRuntime: runtimeId => require("../sources").IDS.includes(runtimeId) ? support : null,
  createManager, createAPIManager, apiDescriptor, verifyAPI };
