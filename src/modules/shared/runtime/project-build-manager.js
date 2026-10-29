const fs = require("node:fs"), path = require("node:path");
const { promisify } = require("node:util"), execute = promisify(require("node:child_process").execFile);
const Catalog = require("./maclauncher-builds"), Bundled = require("./bundled-native");
const { createPinnedNativeManager, compareRuntimeVersions } = require("./pinned-native-manager");
const { selectRuntimeVersion, managerDefaultVersion } = require("./version-choices");
const Custom = require("./custom-runtime");

const SHA = /^[a-f0-9]{64}$/;
function inspectPackage(root, record, { projectId, manifestRelative, sourceRelative, executableRelative, filesPrefix = "", dataOnly = false, validateManifest }) {
  if (record.id !== projectId || record.manifestRelative !== manifestRelative) throw new Error("The runtime package belongs to a different project or format.");
  const stored = Bundled.readRegular(path.join(root, manifestRelative), Bundled.LIMITS.manifestBytes);
  if (stored.sha256 !== record.manifestSha256 || stored.mode !== 0o644) throw new Error("The runtime package manifest changed.");
  const manifest = JSON.parse(stored.bytes);
  if (manifest.schemaVersion !== 1 || manifest.version !== record.version || manifest.minimumMacOS !== record.minimumMacOS ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > Bundled.LIMITS.files)
    throw new Error("The runtime package differs from its selected catalog entry.");
  validateManifest(manifest, record);
  const prefix = typeof filesPrefix === "function" ? filesPrefix(manifest, record) : filesPrefix;
  const sourcePath = typeof sourceRelative === "function" ? sourceRelative(manifest, record) : sourceRelative;
  if (typeof prefix !== "string" || prefix && (!prefix.endsWith("/") || Bundled.relativeFile(prefix.slice(0, -1)) !== prefix.slice(0, -1)))
    throw new Error("The runtime package directory is invalid.");
  if (sourcePath !== null) Bundled.relativeFile(sourcePath);
  const executable = Bundled.relativeFile(typeof executableRelative === "function"
    ? executableRelative(manifest, record) : executableRelative);
  const names = new Set(), files = manifest.files.map(file => {
    const name = Bundled.relativeFile(prefix + Bundled.relativeFile(file.path));
    if (names.has(name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > Bundled.LIMITS.fileBytes ||
        !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !SHA.test(file.sha256 || "") ||
        file.format !== undefined && !["mach-o", "pe"].includes(file.format) || file.format === "pe" && !file.architectures?.length ||
        file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length ||
        file.architectures.some(arch => !(file.format === "pe" ? ["arm64", "x86_64", "x86"] : ["arm64", "x86_64"]).includes(arch)) ||
          file.format !== "pe" && !file.architectures.includes(file.executionArchitecture || (record.arch === "x64" ? "x86_64" : "arm64"))) ||
        Object.hasOwn(file, "executionArchitecture") && (file.executionArchitecture !== "x86_64" || !file.architectures?.includes("x86_64")))
      throw new Error("The runtime package file inventory is invalid.");
    names.add(name); return { ...file, path: name };
  });
  const source = sourcePath === null ? null : sourcePath === manifestRelative
    ? { path: manifestRelative, ...stored, mode: 0o644 } : files.find(file => file.path === sourcePath);
  const primary = files.find(file => file.path === prefix + executable);
  const primaryArchitectures = record.arch === "universal" ? ["arm64", "x86_64"] : [record.arch === "x64" ? "x86_64" : "arm64"];
  if (sourcePath !== null && (!source || source.sha256 !== record.sourceSha256) ||
      !primary || !dataOnly && (!primaryArchitectures.every(architecture => primary.architectures?.includes(architecture)) || primary.executionArchitecture && primary.executionArchitecture !== (record.arch === "x64" ? "x86_64" : "arm64")) ||
      dataOnly && (manifest.kind !== "data" || files.some(file => file.architectures || file.format)) || names.has(manifestRelative))
    throw new Error("The runtime package source or executable identity is invalid.");
  for (const file of [source, primary].filter(Boolean)) {
    const full = path.join(root, file.path);
    Bundled.fileIdentity(full, { maximum: file.size });
    const stat = fs.lstatSync(full);
    if (stat.size !== file.size || (stat.mode & 0o777) !== file.mode)
      throw new Error("The runtime package source or executable differs from its manifest.");
  }
  files.push({ path: manifestRelative, size: stored.size, mode: 0o644, sha256: stored.sha256 });
  return { root, payloadRoot: path.join(root, prefix), manifest,
    declaration: { ...record, files }, executablePath: path.join(root, prefix, executable) };
}

/** Project catalogs are queried only by Refresh. Included packages remain in
 * place; downloaded packages use the ordinary immutable version installation.
 * Runtimes offers Set default unless a module declares otherwise. */
function createProjectBuildManager({ projectId, runtimeId = projectId, label, repository, upstreamUrl, upstreamLabel, included, retainedIncluded, manifestRelative, sourceRelative,
  executableRelative, filesPrefix = "", validateManifest, verifyPayload, inspectRuntime, dataOnly = false, nativeLibrary = false, supportsDefault = true, launcherContract = 1, dependencies = {} }) {
  if (typeof dataOnly !== "boolean" || dataOnly && inspectRuntime) throw new Error("Data packages use sealed regular-file inspection.");
  const format = { projectId, manifestRelative, sourceRelative, executableRelative, filesPrefix, dataOnly, validateManifest };
  const inspect = (root, record) => inspectPackage(root, record, format);
  const sourceUrl = `https://github.com/${repository}`;
  const compatible = pin => {
    const record = pin.projectPackage || pin;
    return record.manifestRelative === manifestRelative && (process.platform === "darwin" || Boolean(dependencies.systemVersionSync)) &&
      (!pin.minimumMacOS || Bundled.versionAtLeast((dependencies.systemVersionSync || Bundled.systemVersionSync)(), pin.minimumMacOS)) &&
      (!(pin.hostArchitectures || record.launcherArchitectures) || (pin.hostArchitectures || record.launcherArchitectures).includes(process.arch));
  };
  const recordOptions = { projectId, repository, architecture: process.arch, launcherContract };
  const publishedPins = catalog => {
    // Another package layout belongs to a later package format.
    const records = Catalog.preferredPackages(catalog), later = records.filter(record => record.manifestRelative !== manifestRelative);
    return [...records.filter(record => !later.includes(record)).map(record => ({ version: record.version, upstreamRevision: record.manifestSha256,
      architecture: record.arch === "x64" ? "x86_64" : record.arch, hostArchitectures: record.launcherArchitectures,
      minimumMacOS: record.minimumMacOS, localBuild: false, projectPackage: record, asset: record.asset })),
    ...Catalog.unavailablePins(projectId, [...later.map(record => ({ version: record.version, reason: "Requires a newer MacLauncher." })),
      ...catalog.unavailable || []])];
  };
  const core = createPinnedNativeManager({ id: projectId, label,
    catalog: [], sourceUrl, buildsRepository: repository, upstreamUrl, upstreamLabel, nativeLibrary, supportsDefault,
    ...(dataOnly ? { inspectRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) {
      const stored = Bundled.readRegular(runtimePath, Bundled.LIMITS.fileBytes);
      if (expectedSha256 && stored.sha256 !== expectedSha256) throw new Error("The managed script entry changed.");
      return { executablePath: runtimePath, runtimePath, runtimeVersion, upstreamRevision, architecture: process.arch, ready: true };
    } } : inspectRuntime ? { inspectRuntime } : {}),
    discoverCatalog: async ({ signal }) => {
      const catalog = await Catalog.fetchProjectCatalog({ ...recordOptions, signal }, dependencies);
      return publishedPins(catalog);
    },
    resolveExecutable: (root, pin) => typeof executableRelative === "function" || typeof filesPrefix === "function"
      ? inspect(path.join(root, "payload"), pin.projectPackage).executablePath
      : path.join(root, "payload", filesPrefix, executableRelative),
    prepareInstall: async ({ unpacked, pin, signal }) => {
      const record = Catalog.validateProjectRecord(pin.projectPackage, recordOptions);
      const selected = inspect(path.join(unpacked, "payload"), record);
      const wrapper = JSON.parse(Bundled.readRegular(path.join(unpacked, "project-package.json"), Bundled.LIMITS.manifestBytes).bytes);
      const sourcePath = typeof sourceRelative === "function" ? sourceRelative(selected.manifest, record) : sourceRelative;
      if (["id", "version", "arch", "minimumMacOS", "manifestRelative", "manifestSha256", "sourceSha256"].some(key => wrapper[key] !== record[key]) ||
          (sourcePath === null ? wrapper.sourceRelative != null : wrapper.sourceRelative !== sourcePath) || JSON.stringify(wrapper.launcherArchitectures) !== JSON.stringify(record.launcherArchitectures))
        throw new Error("The runtime archive belongs to a different project or version.");
      const inventory = files => files.map(file => [file.path, file.size, file.mode, file.sha256, file.architectures?.slice().sort() || null,
        file.executionArchitecture || null, file.format || null]).sort((a, b) => a[0].localeCompare(b[0]));
      if (!Array.isArray(wrapper.files) || JSON.stringify(inventory(wrapper.files)) !== JSON.stringify(inventory(selected.declaration.files)))
        throw new Error("The runtime archive inventory differs from its sealed manifest.");
      await verifyPayload(selected, { signal });
      return { manifestSha256: record.manifestSha256 };
    },
    dependencies: { ...dependencies, extractArchive: async (archive, unpacked, signal) => {
      const extracted = path.join(unpacked, ".package"); fs.mkdirSync(extracted);
      const options = { signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
      if (dependencies.extractArchive) await dependencies.extractArchive(archive, extracted, signal);
      else {
        const list = await execute("/usr/bin/tar", ["-tzf", archive], options);
        const names = list.stdout.trim().split("\n").map(name => name.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
        if (names.length > Bundled.LIMITS.files * 2 || names.some(name => { try { Bundled.relativeFile(name); return false; } catch { return true; } }))
          throw new Error("The runtime archive contains an unsafe path.");
        const types = await execute("/usr/bin/tar", ["-tvzf", archive], options);
        if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) throw new Error("The runtime archive contains unsupported links.");
        await execute("/usr/bin/tar", ["-xzf", archive, "-C", extracted], options);
      }
      if (JSON.stringify(fs.readdirSync(extracted).sort()) !== JSON.stringify(["files", "runtime-package.json"]))
        throw new Error("The runtime archive layout is invalid.");
      fs.renameSync(path.join(extracted, "runtime-package.json"), path.join(unpacked, "project-package.json"));
      fs.renameSync(path.join(extracted, "files"), path.join(unpacked, "payload"));
      fs.rmdirSync(extracted);
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
    else try { selected = inspect(item.root, item.record); } catch (failure) { error = failure.message; }
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
  function resolveSelection(entry, settings, userDataDir, options = {}) {
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
          Object.assign(selected.install, inspect(path.join(selected.install.installDir, "payload"), record));
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
    },
    async installRuntime(options = {}) {
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
    if (verification === "full") Bundled.verifyPayload(selected.root, selected.declaration);
    return { ...selected, runtimeVersion: manifest.version, manifestSha256: stored.sha256,
      installDir: root, runtimePath, ready: true };
  } });
  return manager;
}
module.exports = { createProjectBuildManager, inspectPackage };
