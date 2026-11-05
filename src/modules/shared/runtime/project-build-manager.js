const fs = require("node:fs"), path = require("node:path");
const { promisify } = require("node:util"), execute = promisify(require("node:child_process").execFile);
const Catalog = require("./maclauncher-builds"), Bundled = require("./bundled-native");
const { createPinnedNativeManager, compareRuntimeVersions } = require("./pinned-native-manager");
const { selectRuntimeVersion, managerDefaultVersion } = require("./version-choices");
const Custom = require("./custom-runtime");
const Architecture = require("./architecture");

const Contract = require("./package-contract.cjs");
function inspectPackage(root, record, { projectId, manifestRelative, sourceRelative, executableRelative, filesPrefix = "", dataOnly = false, validateManifest, validatePayload, resolveDependency, declaration, metadataOnly = false, managed = false }) {
  if (managed) manifestRelative = declaration?.manifestRelative || record.manifestRelative || manifestRelative;
  if (!managed && (record.id !== projectId || record.manifestRelative !== manifestRelative)) throw new Error("The runtime package belongs to a different project or format.");
  Bundled.relativeFile(manifestRelative);
  const stored = Bundled.readRegular(path.join(root, manifestRelative), Bundled.LIMITS.manifestBytes);
  if (!managed && (stored.sha256 !== record.manifestSha256 || stored.mode !== 0o644)) throw new Error("The runtime package manifest changed.");
  const manifest = JSON.parse(stored.bytes);
  if (managed) {
    Bundled.managedDeclaration(manifest);
    manifest.files ||= [];
    manifest.dependencies ||= [];
    Bundled.validateRuntimeManifest(manifest);
    const declared = manifest.executableRelative || manifest.executable;
    if (declared && fs.existsSync(path.join(root,Bundled.relativeFile(declared)))) filesPrefix = '';
    else filesPrefix = declaration?.filesPrefix ?? manifest.filesPrefix ?? filesPrefix;
  }
  validateManifest?.(manifest, record);
  const { prefix, executable, files, primary } = Contract.manifestPayload(manifest, record, { executableRelative, filesPrefix, dataOnly, resolveDependency, managed });
  validatePayload?.(manifest, record, { primary, files });
  const sourcePath = typeof sourceRelative === "function" ? sourceRelative(manifest, record) : sourceRelative;
  for (const file of metadataOnly ? [] : [primary]) {
    const full = path.join(root, file.path);
    const alias = declaration?.aliases?.files?.[file.path];
    const physical = alias && typeof alias === 'object' ? resolveDependency(alias,declaration.dependencies.find(dep=>dep.project===alias.project)).path : full;
    Bundled.fileIdentity(physical, managed ? undefined : { maximum: file.size });
    const stat = fs.statSync(full);
    const mode=stat.mode&0o777;
    if (!managed && (stat.size !== file.size || (alias ? (mode&~0o111)!==(file.mode&~0o111)||(mode&file.mode&0o111)!==(file.mode&0o111) : mode!==file.mode)))
      throw new Error("The runtime package source or executable differs from its manifest.");
  }
  files.push({ path: manifestRelative, size: stored.size, mode: 0o644, sha256: stored.sha256 });
  const item = { ...record, manifestRelative, files };
  return require('./package-dependencies').attach({ root, primary, payloadRoot: path.join(root, prefix), manifest,
    declaration: managed ? Bundled.managedDeclaration(item) : item, executablePath: path.join(root, prefix, executable),
    sourceIdentity: Catalog.sourceIdentity(record, {manifest, sourceRelative: sourcePath}) },{resolveDependency});
}

/** Project catalogs are queried only by Refresh. Included packages remain in
 * place; downloaded packages use the ordinary immutable version installation.
 * Runtimes offers Set default unless a module declares otherwise. */
function createProjectBuildManager({ projectId, runtimeId = projectId, label, repository, upstreamUrl, upstreamLabel, sourceLabel, included, retainedIncluded, manifestRelative, sourceRelative,
  executableRelative, filesPrefix = "", validateManifest, verifyPayload, inspectRuntime, dataOnly = false, nativeLibrary = false, supportsDefault = true, launcherContract = 2, dependencies = {} }) {
  if (typeof dataOnly !== "boolean" || dataOnly && inspectRuntime) throw new Error("Data packages use sealed regular-file inspection.");
  const format = { projectId, manifestRelative, sourceRelative, executableRelative, filesPrefix, dataOnly, validateManifest };
  const inspect = (root, record, {userDataDir,verification='status',resolveDependency,installedDependencies,metadataOnly=false} = {}) => {
    const P = require('./package-dependencies'), wrapper = path.join(path.dirname(root),'project-package.json');
    const outer = fs.existsSync(wrapper) ? JSON.parse(Bundled.readRegular(wrapper,Bundled.LIMITS.manifestBytes).bytes) : null;
    if (outer && !installedDependencies) installedDependencies = P.load(userDataDir || (outer.dependencies?.length?P.userDataForPayload(root):undefined),outer.dependencies,{verification:'status'});
    resolveDependency ||= P.resolver(installedDependencies || new Map());
    const selected = inspectPackage(root,record,{...format,resolveDependency,declaration:outer,metadataOnly,managed:Boolean(outer)});
    if (outer) selected.declaration=P.bind(root,record,selected.declaration,resolveDependency,wrapper);
    selected.dependencyLibraryPaths=P.loaderPaths(selected.declaration,installedDependencies||new Map());
    selected.dependencyReadRoots=P.readRoots(installedDependencies||new Map());
    return P.attach(selected,{resolveDependency,sealedDeclaration:outer});
  };
  const sourceUrl = `https://github.com/${repository}`;
  const compatible = pin => {
    const record = pin.projectPackage || pin;
    return (process.platform === "darwin" || Boolean(dependencies.systemVersionSync)) &&
      (!pin.minimumMacOS || Bundled.versionAtLeast((dependencies.systemVersionSync || Bundled.systemVersionSync)(), pin.minimumMacOS)) &&
      (!(pin.hostArchitectures || record.launcherArchitectures) || (pin.hostArchitectures || record.launcherArchitectures).includes(require("./architecture").selectedArchitecture()));
  };
  const recordOptions = { projectId, repository, launcherContract };
  const publishedPins = catalog => {
    const records = catalog.packages;
    return [...records.map(record => ({ version: record.version, upstreamRevision: record.source?.revision || record.asset.sha256,
      architecture: record.arch === "x64" ? "x86_64" : record.arch, hostArchitectures: record.launcherArchitectures,
      minimumMacOS: record.minimumMacOS, localBuild: false, projectPackage: record, asset: record.asset })),
    ...Catalog.unavailablePins(projectId, catalog.unavailable || [])];
  };
  const core = createPinnedNativeManager({ id: projectId, runtimeId, label,
    sourceUrl, sourceLabel, buildsRepository: repository, upstreamUrl, upstreamLabel, nativeLibrary, supportsDefault,
    // An included package counts as a build for the CPU it runs on.
    includedBuilds: options => includedPackages(options).all.some(item => item.present && item.ready),
    ...(dataOnly ? { inspectRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) {
      const stored = Bundled.readRegular(runtimePath, Bundled.LIMITS.fileBytes);
      if (expectedSha256 && stored.sha256 !== expectedSha256) throw new Error("The managed script entry changed.");
      return { executablePath: runtimePath, runtimePath, runtimeVersion, upstreamRevision, architecture: process.arch, ready: true };
    } } : inspectRuntime ? { inspectRuntime } : {}),
    discoverCatalog: async ({ signal }) => {
      const catalog = await Catalog.fetchProjectCatalog({ ...recordOptions, signal }, dependencies);
      return publishedPins(catalog);
    },
    resolveExecutable: (root, pin, options) => inspect(path.join(root, "payload"), pin.projectPackage, options).executablePath,
    prepareInstall: async ({ unpacked, pin, signal, userDataDir, resolveDependency, installedDependencies }) => {
      const record = Catalog.validateProjectRecord(pin.projectPackage, recordOptions);
      const wrapper = Bundled.managedDeclaration(JSON.parse(Bundled.readRegular(path.join(unpacked, "project-package.json"), Bundled.LIMITS.manifestBytes).bytes));
      const P=require('./package-dependencies');
      const selected = inspect(path.join(unpacked, "payload"), record, {userDataDir,resolveDependency,installedDependencies,verification:"status",metadataOnly:true});
      if(wrapper.aliases)Bundled.verifyStoredPayload(selected.root,wrapper,{managed:true});
      P.materialize(selected.root,wrapper,resolveDependency,{verify:false});
      inspectPackage(selected.root,record,{...format,resolveDependency,declaration:wrapper,managed:true});
      const sourcePath = typeof sourceRelative === "function" ? sourceRelative(selected.manifest, record) : sourceRelative;
      await verifyPayload(selected, { signal });
      return { manifestSha256: record.manifestSha256,
        sourceIdentity: Catalog.sourceIdentity(record, {manifest: selected.manifest, wrapper, sourceRelative: sourcePath}) };
    },
    dependencies: { ...dependencies, extractArchive: async (archive, unpacked, signal) => {
      const extracted = path.join(unpacked, ".package"); fs.mkdirSync(extracted);
      const options = { signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
      if (dependencies.extractArchive) await dependencies.extractArchive(archive, extracted, signal);
      else {
        const list = await execute("/usr/bin/tar", ["-tf", archive], options);
        const names = list.stdout.trim().split("\n").map(name => name.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
        if (names.length > Bundled.LIMITS.files * 2 || names.some(name => { try { Bundled.relativeFile(name); return false; } catch { return true; } }))
          throw new Error("The runtime archive contains an unsafe path.");
        const types = await execute("/usr/bin/tar", ["-tvf", archive], options);
        if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) throw new Error("The runtime archive contains unsupported links.");
        await execute("/usr/bin/tar", ["-xf", archive, "-C", extracted], options);
      }
      fs.renameSync(path.join(extracted, "runtime-package.json"), path.join(unpacked, "project-package.json"));
      fs.renameSync(path.join(extracted, "files"), path.join(unpacked, "payload"));
      if (!fs.readdirSync(extracted).length) fs.rmdirSync(extracted);
    } }
  });
  function include(item) {
    const pin = { version: item.record.version, upstreamRevision: item.record.manifestSha256, minimumMacOS: item.record.minimumMacOS,
      hostArchitectures: item.record.launcherArchitectures, projectPackage: item.record, localBuild: false, includedPackage: true };
    const present = [manifestRelative, ...(typeof sourceRelative === "function" || sourceRelative === null ? [] : [sourceRelative]),
      ...(typeof executableRelative === "function" || typeof filesPrefix === "function" ? [] : [filesPrefix + executableRelative])]
      .every(relative => fs.existsSync(path.join(item.root, relative)));
    if (present && !core.core.catalog.some(row => row.version === pin.version)) core.core.rememberResolvedVersion({ entry: pin });
    let selected, error;
    if (!present) error = `${label} ${pin.version} is not installed. Install this version in Runtimes.`;
    else try {
      const relative=item.record.directoryRelative;
      const resources=relative&&path.resolve(item.root,...Array(Bundled.relativeFile(relative).split('/').length+1).fill('..'));
      if(resources&&fs.existsSync(path.join(resources,'runtime-packages.json'))){
        const included=require('./included-helpers').resolveIncluded([item.record],{id:projectId,version:pin.version,resourcesRoot:resources});
        selected=inspectPackage(item.root,included.item,{...format,resolveDependency:included.resolveDependency,declaration:included.item});
        require('./package-dependencies').attach(Object.assign(selected,{declaration:included.item}),included);
      }else selected = inspect(item.root, item.record);
    } catch (failure) { error = failure.message; }
    return { ...selected, version: pin.version, source: "bundled", bundledExecution: "direct", readOnly: true, removable: false,
      root: item.root, declaration: selected?.declaration || item.record, installDir: item.root,
      runtimePath: selected?.executablePath, upstreamRevision: pin.upstreamRevision, present, ready: !error && compatible(pin), ...(error ? { error } : {}) };
  }
  function includedPackages(options = {}) {
    const primary = included?.(options), retained = retainedIncluded?.(options) || [];
    if (!Array.isArray(retained)) throw new Error("Retained runtime metadata must be a list.");
    const versions = new Set(), all = [];
    for (const item of [primary, ...retained].filter(Boolean)) {
      if (versions.has(item.record.version)) throw new Error("Included runtime metadata repeats a version.");
      versions.add(item.record.version); all.push(include(item));
    }
    return { all, fallback: all[0] || null };
  }
  // The shared build resolver chooses the CPU; selection runs in its context.
  function resolveSelection(entry, settings, userDataDir, options = {}) {
    const architecture = core.chooseArchitecture(entry, settings, userDataDir, options);
    return Architecture.withArchitecture(architecture, () => ({
      ...resolveForArchitecture(entry, settings, userDataDir, { ...options, architecture }), architecture }));
  }
  function resolveForArchitecture(entry, settings, userDataDir, options) {
    const { all } = includedPackages(options);
    const explicit = selectRuntimeVersion({ manual: options.version, recommended: entry?.runtimeData?.[runtimeId]?.version }).version;
    const recommendation = options.recommendedVersion ?? options.recommended;
    const configured = selectRuntimeVersion({ manual: explicit,
      recommended: explicit ? null : typeof recommendation === "function" ? recommendation() : recommendation,
      defaultVersion: core.normalizeSettings(settings?.runtimes?.[projectId]).defaultVersion,
      fallback: managerDefaultVersion({ listed: core.core.listDiscoveredCatalog({ userDataDir }).filter(pin => compatible(pin) && !pin.installReason && (!options.compatible || options.compatible(pin))).map(pin => pin.version).sort(compareRuntimeVersions),
        installed: all.filter(item => item.present && item.ready).map(item => item.version).concat(core.getState({userDataDir}).installed.filter(row => row.ready !== false).map(row => row.version)).sort(compareRuntimeVersions) }) }).version;
    const published = core.core.listDiscoveredCatalog({ userDataDir }).filter(pin => pin.projectPackage && pin.asset);
    const select = selectedVersion => {
      const version = selectedVersion.trim().replace(/^v(?=\d)/i, "");
      const bundled = all.find(item => item.version === version);
      const pin = core.core.catalog.find(item => item.version === version);
      if (pin && options.compatible && !options.compatible(pin)) return { version, ready: false, install: null,
        reason: `${label} ${version} has an incompatible runtime profile.` };
      if (bundled?.present) return { version, ready: bundled.ready, install: bundled,
        reason: bundled.ready ? null : bundled.error || `${label} ${version} requires a compatible Mac with macOS ${bundled.declaration.minimumMacOS}.` };
      const selected = core.resolveSelection(entry, settings, userDataDir, { ...options, version });
      if (selected.install) {
        try {
          const record = Catalog.validateProjectRecord(selected.install.catalogEntry.projectPackage, recordOptions);
          const inspected=inspect(path.join(selected.install.installDir, "payload"), record, {userDataDir,verification:options.verification});
          require('./package-dependencies').attach(Object.assign(selected.install,inspected),inspected);
        } catch (error) { return { version, ready: false, install: null, reason: error.message }; }
      }
      return bundled && !selected.ready ? { ...selected, version, install: null, reason: bundled.error } : selected;
    };
    if (configured) return select(configured);
    return { version: null, ready: false, install: null,
      requiresDownload: true, discoveryRequired: !published.some(compatible),
      reason: `No ${label} versions are available to download.` };
  }
  const manager = { ...core, resolveSelection,
    delivery: Object.freeze({ included: included || retainedIncluded ? "direct" : "none", catalog: "remote", sourceBuild: false }),
    getState(options = {}) {
      // Included packages are checked for the CPU of the automatic list.
      return Architecture.withArchitecture(core.chooseArchitecture(null, null, options.userDataDir), () => stateForArchitecture(options));
    },
    async installRuntime(input = {}) {
      // An installation without a build choice uses the build Play would use.
      const architecture = Architecture.requestedArchitecture(input) || (Architecture.selectedArchitecture() === core.launcherArchitecture
        ? core.chooseArchitecture(null, input.settings, input.userDataDir) : Architecture.selectedArchitecture());
      return Architecture.withArchitecture(architecture, () => installForArchitecture({ ...input, architecture }));
    },
    async uninstallRuntime(options = {}) {
      if (includedPackages(options).all.some(item => item.present && item.version === options.version)) throw new Error("The included runtime cannot be removed separately.");
      return core.uninstallRuntime(options);
    },
    updateSettingsAfterUninstall(settings, payload) {
      if (!supportsDefault) return undefined;
      return core.normalizeSettings(settings).defaultVersion === payload.version ? { ...settings, defaultVersion: null } : settings;
    },
    inspectPackage: inspect
  };
  function stateForArchitecture(options) {
    const { all } = includedPackages(options), state = core.getState(options), present = all.filter(item => item.present),
      versions = new Set(present.map(item => item.version));
    state.installed = [...present.map(item => {
      const { manifest, declaration, payloadRoot, present: includedPresent, ...display } = item;
      return { ...display, status: item.ready ? "ready" : item.error ? "damaged-bundled" : "unsupported-host" };
    }), ...state.installed.filter(row => !versions.has(row.version))];
    state.catalog.includedVersions = [...versions];
    const saved = core.normalizeSettings(options.settings).defaultVersion;
    state.defaultVersion = saved || managerDefaultVersion({
      listed: state.catalog.versions.filter(version => !state.catalog.versionRequirements[version]?.installReason).sort(compareRuntimeVersions),
      installed: state.installed.filter(row => row.ready !== false).map(row => row.version).sort(compareRuntimeVersions) });
    state.defaultSource = saved ? "saved" : "manager";
    state.catalog.installableVersions = state.catalog.installableVersions.filter(version => !versions.has(version));
    state.catalog.installable = state.catalog.installableVersions.length > 0;
    const usable = state.installed.filter(item => item.ready !== false);
    state.catalog.latestInstalledVersion = null;
    if (usable.length || state.catalog.installable) state.catalog.installReason = null;
    for (const item of present) state.catalog.versionRequirements[item.version] = { minimumMacOS: item.declaration.minimumMacOS, included: true,
      available: item.ready, requiresDownload: false, requiresBuild: false, installLabel: "Included" };
    const { sections, ...view } = state;
    return { ...view, sections: [{ id: "default", label: `${label} versions`, ...view }] };
  }
  async function installForArchitecture(options) {
    const selectionOptions = { ...options, version: options.version };
    let selected = resolveSelection(null, options.settings, options.userDataDir, selectionOptions);
    if (selected.ready) return selected.install;
    const downloadable = () => core.core.listDiscoveredCatalog({ userDataDir: options.userDataDir })
      .find(pin => pin.version === selected.version && pin.asset && compatible(pin));
    // Installation is an explicit action, including Play's consented
    // preparation. Status and selection never discover versions themselves.
    if (!downloadable()) {
      await core.refreshCatalog({ ...options, force: true });
      selected = resolveSelection(null, options.settings, options.userDataDir, selectionOptions);
      if (selected.ready) return selected.install;
    }
    if (!selected.version) throw new Error(`No ${label} versions are available to download.`);
    if (!downloadable()) throw new Error(core.core.listDiscoveredCatalog({ userDataDir: options.userDataDir })
      .find(pin => pin.version === selected.version && pin.projectPackage?.unavailable)?.installReason ||
      `${label} ${selected.version} is not available for installation from its runtime catalog.`);
    return core.installRuntime({ ...options, version: selected.version });
  }
  Custom.configure(manager, { inspect(runtimePath, { verification } = {}) {
    const roots = [], start = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
    for (let root = start, depth = 0; depth < 7; depth += 1) {
      roots.push(root, path.join(root, "payload"), path.join(root, "files"));
      if (path.dirname(root) === root) break;
      root = path.dirname(root);
    }
    const root = roots.find(candidate => fs.existsSync(path.join(candidate, manifestRelative)));
    if (!root) throw new Error(`Select the complete ${label} runtime directory containing ${manifestRelative}.`);
    const stored = Bundled.readRegular(path.join(root, manifestRelative), Bundled.LIMITS.manifestBytes), manifest = JSON.parse(stored.bytes);
    const sourcePath = typeof sourceRelative === "function" ? sourceRelative(manifest) : sourceRelative;
    const source = sourcePath === null ? stored : Bundled.readRegular(path.join(root, sourcePath), Bundled.LIMITS.manifestBytes);
    const executable = typeof executableRelative === "function" ? executableRelative(manifest) : executableRelative;
    const architectures = manifest.files?.find(file => file.path === executable)?.architectures || manifest.architectures || [];
    const arch = manifest.arch || (architectures.includes("arm64") ? "arm64" : architectures.includes("x86_64") ? "x64" : null);
    const record = { id: projectId, version: manifest.version, arch, minimumMacOS: manifest.minimumMacOS,
      manifestRelative, manifestSha256: stored.sha256, sourceSha256: source.sha256 };
    if (!compatible(record)) throw new Error(`${label} requires macOS ${manifest.minimumMacOS} or later on a compatible Mac.`);
    const selected = inspect(root, record);
    if (verification === "full") Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
    return { ...selected, runtimeVersion: manifest.version, manifestSha256: stored.sha256,
      installDir: root, runtimePath, ready: true };
  } });
  for (const method of ["installRuntime", "uninstallRuntime", "importRuntime", "performInstalledAction", "performSetupAction"]) {
    const original = manager[method];
    if (typeof original !== "function") continue;
    manager[method] = function (options = {}, ...args) {
      return Architecture.withArchitecture(Architecture.requestedArchitecture(options) || Architecture.selectedArchitecture(),
        () => original.call(this, options, ...args));
    };
  }
  return manager;
}
module.exports = { createProjectBuildManager, inspectPackage };
