const path = require("node:path");
const Bundled = require("../../shared/runtime/bundled-native");
const { createManager: createPackageManager } = require("./legacy-manager");

const ID = "nxnative-tools";
const ADAPTER = "maclauncher-nxnative-1";
function sourceRequirement(install) {
  const root = install?.payloadRoot;
  if (!root) throw new Error("The nxnative native tools are unavailable.");
  const relative=install.manifest?.runtimeFiles?.runtimeProfile || 'runtime.json';
  const stored = Bundled.readRegular(path.join(root, Bundled.relativeFile(relative)), Bundled.LIMITS.manifestBytes);
  const expected = install.manifest?.files?.find(file => file.path === "runtime.json");
  if (!Bundled.isManagedDeclaration(install.declaration) && (!expected || stored.sha256 !== expected.sha256)) throw new Error("The nxnative native tools metadata changed.");
  const config = JSON.parse(stored.bytes);
  const requirement = config.sourceRequirement;
  if (Bundled.isManagedDeclaration(install.declaration)) return requirement && typeof requirement==='object' ? requirement : null;
  if (config.schemaVersion !== 1 || config.id !== ID || config.architecture !== "arm64" ||
      requirement?.repository !== "https://github.com/seedds/nxnative.git" || requirement.adapter !== ADAPTER ||
      !/^[a-f0-9]{40}$/.test(requirement.nativeSourceRevision || "") || !/^[a-f0-9]{12,64}$/.test(requirement.shaderChain || ""))
    throw new Error("This nxnative package does not support separately selected upstream sources. Install compatible native tools.");
  return requirement;
}
function createManager(dependencies = {}) {
  const base = createPackageManager(dependencies, { projectId: ID });
  function resolveSelection(entry, settings, userDataDir, options = {}) {
    const selected = base.resolveSelection(entry, settings, userDataDir, options);
    if (!selected.ready) return selected;
    try { return { ...selected, sourceRequirement: sourceRequirement(selected.install) }; }
    catch (error) { return { ...selected, install: null, ready: false, reason: error.message }; }
  }
  return { ...base, id: ID, resolveSelection, sourceRequirement,
    async installRuntime(options = {}) {
      const installed = await base.installRuntime(options);
      const selected = resolveSelection(null, options.settings, options.userDataDir, { version: installed.version });
      return selected.install;
    }
  };
}
module.exports = { ID, ADAPTER, sourceRequirement, createManager };
