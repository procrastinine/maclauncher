const fs = require("node:fs"), path = require("node:path");
const { cloneOrCopySync, cloneOrCopy } = require("../copy-file");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../runtime/pinned-native-manager");
const Upstream = require("../runtime/upstream");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../runtime/bundled-native");
const Custom = require("../runtime/custom-runtime");
const Loader = require("./loader-manager");
const run = promisify(execFile);
const MoltenVKSource=require('../../../runtime-sources/vulkan-driver/khronos-moltenvk.json');
const {createSourceBackedManager}=require('../../../runtime-sources/manager');
const definitions = {
  moltenvk: { label: "MoltenVK", sourceName: "MoltenVK", sourceDescription: "MoltenVK releases published by KhronosGroup/MoltenVK.", library: "libMoltenVK.dylib", source: "https://github.com/KhronosGroup/MoltenVK/releases" },
  kosmickrisp: { label: "KosmicKrisp", sourceName: "KosmicKrisp (LWJGL build)", sourceDescription: "KosmicKrisp Vulkan drivers published by LWJGL.", library: "libvulkan_kosmickrisp.dylib", source: "https://www.lwjgl.org/browse/release" }
};

// A library must match its consumer process; callers override the launcher ABI for another runtime.
function inspect(file, { architecture = process.arch, macOSVersion = systemVersionSync(), signal } = {}) {
  return assertSystemLibraryClosure(readMachOLoadCommands(file, { architecture, signal }), { fileType: 6, maximumMacOS: macOSVersion });
}
// The macOS package keeps its current name. A renamed or repackaged one is
// matched by platform word and archive type; other Apple platforms and debug
// files are not the macOS library.
function moltenvkAsset(assets) {
  const candidates = (assets || []).filter(item => Object.values(MoltenVKSource.upstream.assets).some(pattern=>new RegExp(pattern,'i').test(item?.name||'')));
  return candidates.find(item => item.name === "MoltenVK-macos.tar") || candidates.find(item => /mac|osx|darwin|universal/i.test(item.name)) ||
    candidates.find(item => /(?:^|[-_.])all(?:[-_.]|$)/i.test(item.name));
}
// Every MoltenVK release with a macOS package; its macOS floor is read from the
// library at installation.
const moltenvk = Upstream.github({ repository: MoltenVKSource.upstream.github, allArchitectures: true, recognize: release => {
  const version = String(release.tag_name || "").replace(/^v(?=\d)/, ""), asset = moltenvkAsset(release.assets);
  return asset ? { version, label: "MoltenVK " + version, assets: [asset] } : { version, installReason: "This release has no macOS package." };
} });
// LWJGL lists its releases on its build host and serves each release's
// KosmicKrisp library there for Apple Silicon. The host's headers state the
// library's size (and an S3 SHA-256 when present); the `.git` file beside it
// names the Mesa revision it was built from. A release without the library is
// left out.
const LWJGL_RELEASES = "https://www.lwjgl.org/list?path=release/";
const kosmickrisp = Upstream.index({ locations: [LWJGL_RELEASES], hosts: ["lwjgl.org", "build.lwjgl.org"], allArchitectures: true,
  parse: async ([listing], { fetch: read }) => {
    const versions = [].concat(JSON.parse(listing.text)?.folders || []).map(folder => String(folder).replace(/\/$/, ""))
      .filter(version => /^\d+(?:\.\d+)+[A-Za-z0-9._-]*$/.test(version));
    const rows = await Promise.all(versions.map(async version => {
      const url = `https://build.lwjgl.org/release/${version}/macosx/arm64/${definitions.kosmickrisp.library}`;
      const head = await read(url, { method: "HEAD" }).catch(() => null);
      if (head?.status !== 200) return null;
      const revision = await read(url + ".git").then(document => document?.status === 200 && /^[a-f0-9]{40}$/.exec(document.text.trim())?.[0]).catch(() => null);
      return { version, label: `LWJGL package ${version}`, architecture: "arm64", sourceUrl: `${definitions.kosmickrisp.source}/${version}/macosx/arm64`,
        ...(revision ? { revision } : {}), files: [{ name: definitions.kosmickrisp.library, url, bytes: head.headers["content-length"],
          ...(head.headers["x-amz-checksum-sha256"] ? { digest: head.headers["x-amz-checksum-sha256"], algorithm: "sha256" } : {}) }] };
    }));
    return rows.filter(Boolean).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  } });
const loaderSource = Loader.loaderSource;
// The known path wins; otherwise a bounded search prefers a macOS folder and
// then the shallowest match, skipping __MACOSX.
function findFile(root, known, pattern) {
  if (fs.existsSync(path.join(root, known))) return path.join(root, known);
  const found = [], mac = file => file.split(path.sep).some(part => /^(?:macos|mac|osx|darwin)$/i.test(part));
  (function visit(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "__MACOSX" && depth < 8) visit(child, depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) found.push(child);
    }
  })(root, 0);
  return found.sort((a, b) => mac(b) - mac(a) || a.split(path.sep).length - b.split(path.sep).length)[0] || null;
}
// bsdtar reads every tar compression and zip.
async function extract(archive, output, signal) {
  await run("/usr/bin/tar", ["-xf", archive, "-C", output], { signal, maxBuffer: 1024 * 1024 });
}
function loaderContext(options) {
  let settings = options.settings?.runtimes ? options.settings : null;
  if (!settings) try { settings = JSON.parse(fs.readFileSync(path.join(options.userDataDir, "settings.json"), "utf8")); } catch {}
  return { ...options, settings: settings || {} };
}
async function installLoader(unpacked, context, manager) {
  const selected = Loader.selection(loaderContext(context), manager);
  if (!selected.ready) throw new Error("The selected KosmicKrisp driver requires the Vulkan loader from Tools.");
  await cloneOrCopy(selected.install.executablePath, path.join(unpacked, "libvulkan.1.dylib"), { signal: context.signal });
  try {
    const licenses = path.join(selected.install.installDir, "licenses");
    if (fs.existsSync(licenses)) cloneOrCopySync(licenses, path.join(unpacked, "licenses"));
  } catch (error) { context.signal?.throwIfAborted(); console.warn("The optional Vulkan loader license could not be copied:", error.message); }
}
function createManager(backend, dependencies = {}) {
  const definition = definitions[backend], loader = backend === "kosmickrisp";
  const loaderManager = dependencies.loaderManager || Loader.manager;
  const manager = createPinnedNativeManager({
    versionCompatibility: () => true, // Vulkan is stable across versions of this driver id; consumer capability checks remain separate.
     id: "vulkan-" + backend, label: definition.label, sourceUrl: definition.source, sourceLabel: "Source", sourceName: definition.sourceName, sourceDescription: definition.sourceDescription,
    nativeLibrary: true,
    ...(backend === "kosmickrisp" ? { formatVersionLabel: (pin, installed) => pin ? [installed?.translator?.version, `LWJGL package ${pin.upstreamTag || pin.version}`].filter(Boolean).join(" · ") : undefined } : {}),
    ...(backend==='moltenvk'?{verifyArtifact:options=>require('../../../runtime-adapters/publisher-verification').verifyPublisher(MoltenVKSource,options)}:{}),
    inspectRuntime(options) {
      const metadata = options.runtimeInstallationMetadata;
      if (metadata?.translator) {
        const root = options.runtimeRoot || path.dirname(options.runtimePath), Component = require('../runtime/component-runtime');
        const translator = require('../runtime/translator-description').restoreInstallationDescription(root, metadata.translator);
        const native = Component.inspected(root, { entryLibrary: definition.library }, { translator });
        const architectures = translator.files.find(file => file.path === options.runtimePath)?.cpuSlices || native.architectures;
        const sha256 = options.runtimeBinarySha256 || metadata.libraries?.find(file => path.resolve(root, file.file) === options.runtimePath)?.sha256;
        return { ...native, executablePath: options.runtimePath, architectures, sha256,
          needsRosetta: require('../runtime/architecture').imageRequiresRosetta(architectures, { platform: 'darwin', hardwareArch: options.hostArchitecture }),
          runtimeVersion: options.runtimeVersion, upstreamRevision: options.upstreamRevision };
      }
      const native = require("../runtime/local-native").resolveLocalRuntime(options), root = path.dirname(native.executablePath);
      const translator = require("../runtime/component-runtime").description(root, { engine: backend, apis: ["Vulkan"] }, {
        source: backend === "kosmickrisp" ? { kind: "upstream", id: definition.source, label: `LWJGL ${options.runtimeVersion} package` } : "upstream",
        ...(backend === "kosmickrisp" ? {} : { version: options.runtimeVersion }) });
      return { ...native, translator, translatorRoot: root };
    }, upstream: backend === "moltenvk" ? moltenvk : kosmickrisp,
    resolveExecutable: root => path.join(root, definition.library),
    prepareInstall: async ({ unpacked, signal, userDataDir }) => {
      if (backend === "moltenvk") {
        const library = findFile(unpacked, "MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib", /^libMoltenVK\.dylib$/);
        if (!library) throw new Error("The MoltenVK package has no macOS library.");
        const license = findFile(unpacked, "MoltenVK/LICENSE", /^LICEN[CS]E(?:\.(?:md|txt))?$/i);
        const kept = { [definition.library]: fs.readFileSync(library) };
        try { if (license) kept["licenses/MoltenVK.txt"] = fs.readFileSync(license); }
        catch (error) { console.warn("The optional MoltenVK license could not be copied:", error.message); }
        for (const name of fs.readdirSync(unpacked)) fs.rmSync(path.join(unpacked, name), { recursive: true, force: true });
        for (const [name, bytes] of Object.entries(kept)) {
          fs.mkdirSync(path.dirname(path.join(unpacked, name)), { recursive: true });
          fs.writeFileSync(path.join(unpacked, name), bytes);
        }
      } else {
        await installLoader(unpacked, { signal, userDataDir }, loaderManager);
        try { cloneOrCopySync(path.join(__dirname, "notices"), path.join(unpacked, "licenses")); }
        catch (error) { console.warn("The optional Vulkan licenses could not be copied:", error.message); }
      }
      const files = [definition.library, ...(loader ? ["libvulkan.1.dylib"] : [])];
      let minimumMacOS = "1.0";
      for (const file of files) {
        fs.chmodSync(path.join(unpacked, file), 0o755);
        const native = inspect(path.join(unpacked, file), { signal, ...(backend === "moltenvk" ? { architecture: require("../runtime/architecture").selectedArchitecture() } : {}),
          macOSVersion: (dependencies.systemVersionSync || systemVersionSync)() });
        for (const slice of native.slices) if (versionAtLeast(slice.minimumMacOS, minimumMacOS)) minimumMacOS = slice.minimumMacOS;
      }
      const translator = require("../runtime/component-runtime").description(unpacked, { engine: backend, apis: ["Vulkan"] }, { source: "upstream" });
      const stored = require("../runtime/translator-description").installationDescription(translator);
      return { translator: stored, backend, minimumMacOS, libraries: files.map(file => ({ file, sha256: hashFile(path.join(unpacked, file)) })) };
    }, dependencies: { ...dependencies, extractArchive: (archive, output, signal) => backend === "moltenvk" ? extract(archive, output, signal)
      : cloneOrCopy(archive, path.join(output, definition.library), { signal }) } });
  const result = { ...manager, upstream: loader ? kosmickrisp : moltenvk, backend, translatorEngine: backend, ui: { groupId: "vulkan-drivers", sectionLabel: definition.label, memberOrder: backend === "moltenvk" ? 20 : 21, management: "managed", ...(backend === "kosmickrisp" ? { hostFeature: "METAL4" } : {}) } };
  Custom.configure(result, { inspect(runtimePath) {
    const native = Custom.inspectExecutable(runtimePath, { candidates: [definition.library, "MoltenVK", "Versions/A/MoltenVK"], allowLibrary: true });
    native.executablePath = fs.realpathSync(native.executablePath);
    const root = path.dirname(native.executablePath), files = [native.executablePath,
      ...(backend === "kosmickrisp" ? [path.join(root, "libvulkan.1.dylib")] : [])];
    for (const file of files) inspect(file, { architecture: native.architectures[0] === "x86_64" ? "x64" : "arm64" });
    return { ...native, installDir: root, installationMetadata: { backend, libraries: files.map(file => ({ file: path.basename(file), sha256: hashFile(file) })) } };
  } });
  const Component = require("../runtime/component-runtime"), customInspect = result.customRuntime.inspect;
  Component.configure(result, { engine: backend, names: [backend], entryLibrary: definition.library,
    library: backend === "moltenvk" ? /^lib(?:MoltenVK|MVK)\.dylib$/ : /^libvulkan_kosmickrisp\.dylib$/,
    inspect(root, context) {
      const inspected = customInspect(root, context), source = context.source;
      const descriptions = inspected.installationMetadata.libraries.map(file => Component.description(path.join(inspected.installDir, file.file), { engine: backend, apis: ["Vulkan"] }, { source }));
      const translator = { ...descriptions[0], files: descriptions.flatMap(item => item.files),
        macosFloor: descriptions.map(item => item.macosFloor).filter(Boolean).sort(require("../runtime/translator-description").compareVersions).at(-1) || null };
      return { ...inspected, translator, translatorRoot: translator.root };
  } });
  const backendManager=Component.withIncludedReferences(result);
  if (backend === "kosmickrisp") {
    const install = backendManager.installRuntime, resolve = backendManager.resolveSelection;
    backendManager.loaderManager = loaderManager;
    backendManager.installRuntime = async function (options = {}) {
      const context = loaderContext(options), selected = resolve.call(this, null, context.settings, options.userDataDir, options);
      if (!selected.ready) await Loader.ensure(context, { manager: loaderManager });
      return install.call(this, options);
    };
    backendManager.resolveSelection = function (entry, settings, userDataDir, options = {}) {
      const selected = resolve.call(this, entry, settings, userDataDir, options);
      if (!selected.ready || !selected.install) return selected;
      const architecture = require("../runtime/architecture").normalizeArchitecture(options.architecture || selected.architecture || selected.install.architecture) || "arm64";
      const dependency = Loader.selection({ settings, userDataDir }, loaderManager, architecture);
      if (!dependency.ready) return dependency.install ? { ...selected, ready: false, reason: dependency.reason } : selected;
      const install = { ...selected.install }, root = install.translatorRoot || install.installDir;
      const Description = require("../runtime/translator-description");
      const description = install.translator || (install.installationMetadata?.translator && Description.restoreInstallationDescription(root, install.installationMetadata.translator));
      if (!description) return selected;
      install.translator = { ...description, files: [...description.files.filter(file => !/libvulkan(?:\.\d+)*\.dylib$/.test(file.path)),
        Description.inspectFile({ path: dependency.install.executablePath, relative: "libvulkan.1.dylib" })] };
      return { ...selected, install, runtimeUses: [{ managerId: this.id, version: selected.version, sourcePath: selected.install.installDir },
        { managerId: loaderManager.id, version: dependency.version, sourcePath: dependency.install.installDir }] };
    };
  }
  return backend==='moltenvk'?createSourceBackedManager({id:backendManager.id,source:MoltenVKSource,adapter:require('../../../runtime-adapters/vulkan-driver'),backend:backendManager}):backendManager;
}
const managers = Object.keys(definitions).map(backend => createManager(backend));
module.exports = { managers, definitions, createManager, inspect, moltenvkAsset, findFile, sources: { moltenvk, kosmickrisp }, loaderSource };
