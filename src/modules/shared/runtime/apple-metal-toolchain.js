const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager } = require("./pinned-native-manager");
const { extractDmg } = require("./dmg");
const { downloadApproved } = require("./tool-install");
const { createAbortError, throwIfAborted } = require("./download-utils");
const Native = require("./local-native");
const Custom = require("./custom-runtime");
const execute = promisify(execFile);
const ID = "apple-metal-toolchain", ENVIRONMENT = "MCL_APPLE_METAL_TOOLCHAIN_ROOT";
const SOURCE = "https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components";
const LICENSE = "https://www.apple.com/legal/sla/docs/xcode.pdf";
const CATALOG = "/System/Library/AssetsV2/com_apple_MobileAsset_MetalToolchain/com_apple_MobileAsset_MetalToolchain.xml";
const TOOLCHAIN = "Metal.xctoolchain", MINIMUM_MACOS = "14.0";
const versionText = value => String(value || "").trim().split(/\r?\n/)[0].replace(/^Apple metal version /, "");

function readLocalCatalog(runSync = execFileSync) {
  const read = key => runSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", CATALOG],
    { encoding: "utf8", timeout: 15000, maxBuffer: 65536 }).trim();
  let count;
  try { count = Number(read("Assets")); }
  catch { throw new Error("The public macOS Metal component catalog is unavailable on this Mac."); }
  if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error("The macOS Metal component catalog has no supported records.");
  return Array.from({ length: count }, (_, index) => Object.fromEntries(
    ["AssetType", "AssetFormat", "Build", "__BaseURL", "__RelativePath", "_DownloadSize", "_Measurement-SHA256", "ArchiveDecryptionKey"]
      .map(key => [key, read("Assets." + index + "." + key)])));
}
function componentEntry(asset) {
  if (asset.AssetType !== "com.apple.MobileAsset.MetalToolchain" || asset.AssetFormat !== "AppleArchive" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.Build || "")) throw new Error("The macOS Metal component record has an unsupported format.");
  const url = new URL(asset.__RelativePath, asset.__BaseURL), bytes = Number(asset._DownloadSize);
  const digest = Buffer.from(asset["_Measurement-SHA256"] || "", "base64"), key = Buffer.from(asset.ArchiveDecryptionKey || "", "base64");
  if (url.protocol !== "https:" || !/(?:^|\.)(?:apple\.com|cdn-apple\.com)$/.test(url.hostname) || url.username || url.password || url.search || url.hash ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4 * 1024 ** 3 || digest.length !== 32 ||
      digest.toString("base64") !== asset["_Measurement-SHA256"] || key.length !== 32 || key.toString("base64") !== asset.ArchiveDecryptionKey)
    throw new Error("The macOS Metal component download identity is invalid.");
  return { version: asset.Build, upstreamRevision: asset.Build, minimumMacOS: MINIMUM_MACOS, hostArchitectures: ["arm64", "x64"],
    asset: { url: url.href, filename: "MetalToolchain-" + asset.Build + ".aar", bytes, sha256: digest.toString("hex") },
    component: { archiveDecryptionKey: asset.ArchiveDecryptionKey } };
}
function toolchain(directory) {
  let root = fs.statSync(directory).isDirectory() ? directory : path.dirname(directory);
  if (fs.existsSync(path.join(root, TOOLCHAIN))) root = path.join(root, TOOLCHAIN);
  for (let depth = 0; !fs.existsSync(path.join(root, "ToolchainInfo.plist")) && depth < 8; depth++) root = path.dirname(root);
  const canonical = fs.realpathSync(root);
  for (const relative of ["ToolchainInfo.plist", "usr/bin/metal", "usr/bin/metallib", "usr/metal/current/bin/metal", "usr/metal/current/bin/air-lld", "usr/metal/current/lib/clang"]) {
    const file = path.join(root, relative), actual = fs.realpathSync(file);
    if (!actual.startsWith(canonical + path.sep) || !fs.statSync(actual)[relative.endsWith("/clang") ? "isDirectory" : "isFile"]())
      throw new Error("The Apple Metal toolchain layout is invalid.");
  }
  return root;
}
const signedTools = ["usr/bin/metal", "usr/bin/metallib", "usr/metal/current/bin/metal", "usr/metal/current/bin/air-lld"];
async function signatures(root, run, signal) {
  for (const relative of signedTools)
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple", path.join(root, relative)], { signal, timeout: 30000, maxBuffer: 65536 });
}
function diskImage(directory) {
  const images = []; let files = 0;
  function walk(root, depth = 0) {
    if (depth > 8 || files > 256) throw new Error("The Metal component archive layout exceeds its limit.");
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      files++; const file = path.join(root, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".dmg")) images.push(file);
    }
  }
  walk(directory);
  if (images.length !== 1) throw new Error("The Metal component does not contain one toolchain image.");
  return images[0];
}
function createManager(dependencies = {}) {
  const run = dependencies.execute || execute, runSync = dependencies.executeSync || execFileSync;
  const base = createPinnedNativeManager({ id: ID, label: "Metal compiler", catalog: [], upstreamUrl: SOURCE, sourceUrl: SOURCE, supportsDefault: true,
    discoverCatalog: async ({ signal } = {}) => { throwIfAborted(signal); return (await (dependencies.readCatalog || (() => readLocalCatalog(runSync)))()).map(componentEntry); },
    resolveExecutable: directory => path.join(toolchain(directory), "usr/bin/metal"),
    prepareInstall: async ({ unpacked, signal }) => {
      const root = toolchain(unpacked); await signatures(root, run, signal);
      const options = { signal, timeout: 30000, maxBuffer: 65536 };
      const result = await run(path.join(root, "usr/bin/metal"), ["--version"], options);
      if (!result.stdout?.startsWith("Apple metal version ")) throw new Error("The Metal component did not report its compiler identity.");
      const identifier = await run("/usr/bin/plutil", ["-extract", "Identifier", "raw", path.join(root, "ToolchainInfo.plist")], options);
      return { toolchainIdentifier: identifier.stdout.trim(), compilerVersion: versionText(result.stdout), licenseURL: LICENSE };
    },
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || (async (archive, destination, signal) => {
      const empty = path.join(destination, ".empty"), component = path.join(destination, ".component");
      fs.mkdirSync(empty); fs.mkdirSync(component);
      try {
        throwIfAborted(signal);
        const version = path.basename(archive, ".aar").replace(/^MetalToolchain-/, "");
        const selected = base.core.catalog.find(row => row.version === version);
        if (!selected?.component?.archiveDecryptionKey) throw new Error("Refresh the macOS Metal component catalog before installing this version.");
        await run("/usr/bin/aa", ["patch", "-i", archive, "-key-value", "base64:" + selected.component.archiveDecryptionKey, "-src", empty, "-dst", component],
          { signal, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
        await extractDmg(diskImage(component), destination, signal, { payloadName: TOOLCHAIN, project: "Apple Metal", run,
          copy(source, target) { fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
            filter() { throwIfAborted(signal); return true; } }); } });
      } finally { fs.rmSync(empty, { recursive: true, force: true }); fs.rmSync(component, { recursive: true, force: true }); }
    }) } });
  Custom.configure(base, { inspect(runtimePath) {
    const root = toolchain(runtimePath), executablePath = path.join(root, "usr/bin/metal");
    const options = { encoding: "utf8", timeout: 30000, maxBuffer: 65536 };
    const identifier = runSync("/usr/bin/plutil", ["-extract", "Identifier", "raw", path.join(root, "ToolchainInfo.plist")], options).trim();
    for (const relative of signedTools) runSync("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple", path.join(root, relative)], options);
    const compiler = runSync(executablePath, ["--version"], options);
    if (!compiler.startsWith("Apple metal version ")) throw new Error("The selected Apple Metal compiler has an unsupported identity.");
    return { ...Native.resolveLocalRuntime({ runtimePath: executablePath, runtimeVersion: "custom", upstreamRevision: identifier }),
      compilerVersion: versionText(compiler), toolchainRoot: root, installDir: root, root, payloadRoot: root };
  } });
  base.ui = { ...base.ui, groupId: "nxnative", tabLabel: "nxnative", sectionLabel: "Metal compiler", management: "managed", order: 50 };
  return base;
}
async function systemCompiler(requirement, run, signal) {
  try {
    const result = await run("/usr/bin/xcrun", ["-sdk", "macosx", "metal", "--version"], { signal, timeout: 15000, maxBuffer: 65536 });
    if (!result.stdout?.startsWith("Apple metal version ") || requirement.version && versionText(result.stdout) !== versionText(requirement.version)) return null;
    return { environment: {}, source: "system", version: versionText(result.stdout) };
  } catch { throwIfAborted(signal); return null; }
}
function createService({ manager = createManager(), run = execute, probeSystem = systemCompiler } = {}) {
  async function ensure(context = {}, requirement) {
    throwIfAborted(context.signal);
    if (!requirement?.required) return { environment: {}, source: "not-required" };
    const managed = requirement.delivery === "managed" && requirement.managerId === ID && requirement.environment === ENVIRONMENT;
    const configured = [Custom.defaultVersion(context.settings, ID), manager.normalizeSettings(context.settings?.runtimes?.[ID]).defaultVersion]
      .some(value => typeof value === "string" && value.trim() && !["auto", "latest"].includes(value.trim().toLowerCase()));
    if (!managed || !configured) {
      const present = await probeSystem(requirement, run, context.signal); if (present) return present;
    }
    if (!managed) throw new Error("The selected native tools require the system Apple Metal compiler. A compatible native-tools version supports managed compiler installation.");
    let selected = manager.resolveSelection(null, context.settings, context.userDataDir);
    if (!selected.ready && Custom.isPath(selected.version)) throw new Error(selected.reason || "The selected custom Metal toolchain is unavailable.");
    if (!selected.ready) {
      const version = selected.version;
      if (!await downloadApproved(context, { kind: "prerequisite", prerequisiteId: ID, managerId: ID, label: "Metal compiler", version,
        requiresDownload: true, sourceUrl: SOURCE, licenseUrl: LICENSE, licenseRequired: true, confirmLabel: "Agree and Download",
        detail: "Required for shader preparation. Downloaded directly from Apple; Apple's Xcode and SDK terms apply. " + LICENSE }))
        throw createAbortError("Metal compiler installation canceled.");
      throwIfAborted(context.signal);
      context.onProgress?.({ phase: "install", label: "Installing Metal compiler…", managerId: ID, version });
      const installed = await manager.installRuntime({ ...context, version }); throwIfAborted(context.signal);
      selected = manager.resolveSelection(null, context.settings, context.userDataDir, { version: version || installed?.version });
    }
    if (!selected.ready) throw new Error(selected.reason);
    const root = selected.install.toolchainRoot || toolchain(selected.install.installDir);
    await signatures(root, run, context.signal);
    const result = await run(path.join(root, "usr/bin/metal"), ["--version"], { signal: context.signal, timeout: 30000, maxBuffer: 65536 });
    if (!result.stdout?.startsWith("Apple metal version ") || requirement.version && versionText(result.stdout) !== versionText(requirement.version))
      throw new Error("The selected native tools require a different Apple Metal compiler API version.");
    context.recordRuntimeUse?.({ managerId: ID, version: selected.version, sectionId: "default", sourcePath: selected.install.installDir });
    return { environment: { [ENVIRONMENT]: root }, source: "managed", version: selected.version, install: selected.install };
  }
  return { manager, ensure };
}
const service = createService();
module.exports = { ...service, createService, createManager, ID, ENVIRONMENT, __test: { readLocalCatalog, componentEntry, diskImage } };
