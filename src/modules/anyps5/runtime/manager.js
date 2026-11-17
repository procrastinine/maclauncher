const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Architecture = require("../../shared/runtime/architecture");
const Custom = require("../../shared/runtime/custom-runtime");
const { compareRuntimeVersions } = require("../../shared/runtime/pinned-native-manager");
const { selectRuntimeVersion } = require("../../shared/runtime/version-choices");

const HOST = "AnyPS5.app/Contents/MacOS/anyps5-fex-start";
const isFex = manifest => manifest.files?.some(file => file.path === HOST);
const primary = manifest => isFex(manifest) ? HOST : "tools/relinker";

// The older package's primary is a native converter; the converted game loads
// its Intel libkernel. Execution CPU therefore comes from the selected role's
// actual Mach-O header, independently of the converter's package architecture.
function execution(install) {
  const manifest = install.manifest;
  const root = install.payloadRoot || install.root;
  if (!manifest || !root) throw new Error("The AnyPS5 runtime has no inspected package layout.");
  const fex = isFex(manifest);
  const file = path.join(root, fex ? HOST : "libs/libkernel.prx");
  const architectures = Native.readMachOArchitectures(file, {allowLibrary: !fex});
  const architecture = fex ? "arm64" : "x64";
  if (!architectures.includes(fex ? "arm64" : "x86_64"))
    throw new Error("The AnyPS5 execution library has an unsupported CPU architecture.");
  return {executionArchitecture: architecture, executionArchitectures: architectures, executionPath: file,
    route: fex ? "fex" : Architecture.requiresRosetta("x64") ? "rosetta" : "native"};
}
function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({
    versionCompatibility: () => true,
    projectId: "anyps5", formerIds: ["anyps5-fex"], label: "AnyPS5",
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/boykopovar/AnyPS5",
    manifestRelative: "runtime.json", sourceRelative: "source.json", executableRelative: primary, supportsDefault: true,
    validateManifest(manifest, record) {
      if (isFex(manifest)) {
        if (!["anyps5", "anyps5-fex"].includes(manifest.managerId) || manifest.arch !== "arm64" || record.arch !== "arm64" ||
            !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
            !manifest.files.find(file => file.path === HOST)?.architectures?.includes("arm64"))
          throw new Error("The AnyPS5 package has an unsupported FEX runtime layout.");
        return;
      }
      if (Bundled.isManagedDeclaration(manifest)) return;
      if (manifest.managerId !== "anyps5" || manifest.arch !== record.arch || !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
          manifest.gameArchitecture !== "x86_64" || manifest.runtimeFiles?.libraries !== "libs" ||
          manifest.runtimeFiles?.unwrap !== "tools/unwrap-self.cjs" ||
          !manifest.files.some(file => file.path === "tools/unwrap-self.cjs") ||
          !manifest.files.some(file => file.path === "libs/libkernel.prx" && file.executionArchitecture === "x86_64"))
        throw new Error("The AnyPS5 package has an unsupported runtime layout.");
    },
    async verifyPayload(selected, {signal} = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
      execution(selected);
      await Bundled.verifySignatures(selected.root,selected.declaration,{signal,execute:dependencies.execute || execute});
    }, dependencies });
  const resolve = manager.resolveSelection;
  const state = manager.getState;
  const install = manager.installRuntime;
  const fexPackage = pin => (pin.projectPackage || pin).id === "anyps5-fex";
  const explicitVersion = (entry,settings,options={}) => selectRuntimeVersion({manual:options.version,
    recommended:entry?.runtimeData?.anyps5?.version,defaultVersion:Custom.defaultVersion(settings,"anyps5")}).version;
  function measured(selected) {
    if (!selected?.ready || !selected.install) return selected;
    try {return {...selected, ...execution(selected.install)};}
    catch(error) {return {...selected,ready:false,reason:error.message};}
  }
  // A listed version that is not installed has no host or library to measure
  // yet. Its catalog project names the route: FEX packages run the start host,
  // converter packages run the converted Intel game.
  function listedRoute(version,userDataDir) {
    const pin = manager.core.listDiscoveredCatalog({userDataDir}).find(pin => pin.version === version && pin.projectPackage);
    return pin ? {route: fexPackage(pin) ? "fex" : Architecture.requiresRosetta("x64") ? "rosetta" : "native"} : {};
  }
  manager.resolveSelection = (entry, settings, userDataDir, options = {}) => {
    const explicit = explicitVersion(entry,settings,options);
    const installed = state({userDataDir}).installed || [];
    if (explicit) {
      const row=installed.find(row=>row.version===explicit&&row.ready!==false);
      // Resolve the selected package in its stored converter/host slot. The
      // version row's execution CPU can differ from that package's primary.
      const selected=measured(resolve(entry,settings,userDataDir,{...options,version:explicit,
        ...(row?{architecture:Architecture.recordArchitecture(row)}:{})}));
      return selected.ready || selected.route ? selected : {...selected,...listedRoute(selected.version || explicit,userDataDir)};
    }
    if (!explicit && Architecture.requiresRosetta("x64")) {
      const fex = installed.filter(row => row.ready !== false).map(row => measured(resolve(null,settings,userDataDir,{...options,version:row.version,
        architecture:Architecture.recordArchitecture(row)})))
        .filter(row => row.ready && row.route === "fex").sort((a,b)=>compareRuntimeVersions(a.version,b.version)).at(-1);
      if (fex) return measured(resolve(entry,settings,userDataDir,{...options,recommendedVersion:fex.version,architecture:fex.architecture}));
    }
    const selected = measured(resolve(entry,settings,userDataDir,options));
    if (selected.ready || explicit || !Architecture.requiresRosetta("x64")) return selected;
    return measured(resolve(entry,settings,userDataDir,{...options,compatible:fexPackage}));
  };
  manager.installRuntime = (options = {}) => {
    const settings=options.settings?.runtimes?options.settings:{runtimes:{anyps5:options.settings}};
    return install.call(manager,{...options,...(options.automatic===true&&!explicitVersion(null,settings,options)&&Architecture.requiresRosetta("x64")
      ? {compatible:fexPackage}: {})});
  };
  manager.getState = (options = {}) => {
    const result = state(options);
    const rows = new Map();
    const project = row => {
      if (row.ready === false) return row;
      const key = row.installDir || row.version;
      if (!rows.has(key)) {
        const selected = measured(resolve(null,{},options.userDataDir,{version:row.version,verification:"status"}));
        rows.set(key,selected.ready ? {...row,architecture:selected.executionArchitecture,
          variant:`architecture:${selected.executionArchitecture}`,requiresRosetta:selected.route==="rosetta",needsRosetta:selected.route==="rosetta"} : row);
      }
      return rows.get(key);
    };
    return {...result,installed:result.installed?.map(project),sections:result.sections?.map(section=>({...section,installed:section.installed?.map(project)}))};
  };
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
module.exports.execution = execution;
module.exports.HOST = HOST;
