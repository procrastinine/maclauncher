const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Catalog = require("./catalog");
const Download = require("./download");
const fs = require("node:fs");
const Custom = require("../../shared/runtime/custom-runtime");

// HashLink's bytecode JIT is Intel-only. A genuine x64 package can serve Apple
// Silicon through Rosetta without relabeling its executable as native ARM.
const intelBundle = createBundledNativeRuntime({ managerId: "hashlink", arch: "x64" });
const bundledRuntime = { ...intelBundle, resolve: options => intelBundle.resolve({ ...options, arch: "x64" }) };

const discoverCatalog = Catalog.createDiscovery();

function createManager(dependencies = {}) { const base = createPinnedNativeManager({ id: "hashlink", label: "HashLink", discoverCatalog: Catalog.createDiscovery(dependencies), legacyInstalledRuntime: bundledRuntime,
  projectBuilds: { projectId: "hashlink", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true },
  distributionRequired: false, importLocal: true,
  sourceUrl: "https://github.com/HaxeFoundation/hashlink/releases",
  catalog: [],
  resolveExecutable: Download.resolveExecutable,
  prepareInstall: options => Download.prepareInstall(options, dependencies), dependencies });
  const family = version => /^1\.9(?:[.-]|$)/.test(version) ? "1.9" : /^1\.12(?:[.-]|$)/.test(version) ? "1.12" : "current";
  return { ...base, getState(options = {}) {
    const state = base.getState(options), { sourceCatalog } = require("../../shared/runtime/runtime-sources");
    const sections = [{ id: "current", label: "Upstream", description: "Game bytecode and native libraries must match the selected HashLink version. Apple Silicon requires Rosetta." },
      { id: "1.9", label: "HashLink 1.9", description: "Mac runtime with graphics and audio support for HashLink 1.9 games. Apple Silicon requires Rosetta." },
      { id: "1.12", label: "HashLink 1.12", description: "Mac runtime with graphics and audio support for HashLink 1.12 games. Apple Silicon requires Rosetta." }].map(section => {
      const versions = state.catalog.versions.filter(version => family(version) === section.id);
      const catalog = sourceCatalog(state.catalog, { id: section.id, label: section.label, source: state.catalog.source, versions });
      catalog.sources = (state.catalog.sources || []).filter(source => section.id === "current" ? source.id === "upstream" : source.id === "builds").map(source => sourceCatalog(source, { ...source,
        versions: source.versions.filter(version => family(version) === section.id) }));
      catalog.sourceLinks = section.id === "current" ? [] : [{ label: "upstream code", url: "https://github.com/HaxeFoundation/hashlink" }];
      if (section.id !== "current") for (const source of catalog.sources) source.source = source.sourceUrl =
        `https://procrastinine.github.io/maclauncher-builds/#hashlink-${section.id.replace(".", "-")}`;
      catalog.source = catalog.sources[0]?.source || state.catalog.source;
      return { ...state, ...section, sections: undefined, catalog, installed: state.installed.filter(row => family(row.version) === section.id) };
    });
    return { ...state, sections };
  } };
}
const manager = createManager();
const inspectCustom = manager.customRuntime.inspect;
Custom.configure(manager, { inspect(runtimePath, options = {}) {
  const install = inspectCustom(runtimePath, options);
  if (!install.architectures.includes("x86_64")) throw new Error("HashLink bytecode requires an Intel VM executable.");
  if (install.catalogEntry?.supportedBytecodeVersions) {
    const version = install.catalogEntry.upstreamVersion || install.runtimeVersion;
    const family = /^1\.9(?:[.-]|$)/.test(version) ? "1.9" : /^1\.12(?:[.-]|$)/.test(version) ? "1.12" : "current";
    if (options.sectionId && options.sectionId !== family) throw new Error(`This HashLink VM belongs in the ${family} runtime list.`);
    return install;
  }
  const root = path.dirname(install.executablePath), header = path.join(root, "include", "hl.h");
  if (fs.statSync(header).size > 1024 * 1024) throw new Error("The HashLink version header exceeds its size limit.");
  const version = /^\s*#\s*define\s+HL_VERSION\s+0x([a-f0-9]+)/im.exec(fs.readFileSync(header, "utf8"))?.[1];
  if (!version) throw new Error("Select a complete HashLink VM directory with its include/hl.h version header.");
  const number = Number.parseInt(version, 16), runtimeVersion = `${number >>> 16}.${(number >>> 8) & 255}.${number & 255}`;
  const family = runtimeVersion.startsWith("1.9.") ? "1.9" : runtimeVersion.startsWith("1.12.") ? "1.12" : "current";
  if (options.sectionId && options.sectionId !== family) throw new Error(`This HashLink VM belongs in the ${family} runtime list.`);
  const known = manager.core.catalog.find(pin => pin.upstreamVersion === runtimeVersion || pin.version === runtimeVersion || pin.version === runtimeVersion.replace(/\.0$/, ""));
  const supportedBytecodeVersions = Catalog.bytecodeVersions(runtimeVersion);
  if (!supportedBytecodeVersions.length && !known?.supportedBytecodeVersions?.length) throw new Error("The selected HashLink VM needs runtime metadata describing its bytecode format.");
  const nativeFiles = fs.readdirSync(root).filter(name => /\.(?:hdll|dylib)$/.test(name)).map(name => path.join(root, name));
  const corePath = nativeFiles.find(file => /^libhl(?:\.[\d.]+)?\.dylib$/.test(path.basename(file)));
  if (!corePath) throw new Error("The HashLink VM is missing its libhl library.");
  const profile = require("./primitive-signatures").packageProfile({ executablePath: install.executablePath, corePath, nativeFiles });
  const sdlSignature = profile.libraries.sdl?.signatures?.event_loop;
  return { ...install, runtimeVersion, catalogEntry: { version: runtimePath, architecture: "x86_64",
    supportedBytecodeVersions: supportedBytecodeVersions.length ? supportedBytecodeVersions : known.supportedBytecodeVersions,
    nativeAbi: { sdlEventLoop: sdlSignature?.startsWith("PD") ? "dynamic" : sdlSignature?.startsWith("PO") ? "typed-event" : "unknown" },
    customPrimitiveProfile: profile } };
} });
// Stock and adapted ABI profiles install as managed versioned downloads.
manager.createManager = createManager;
manager.discoverCatalog = discoverCatalog;
module.exports = manager;
