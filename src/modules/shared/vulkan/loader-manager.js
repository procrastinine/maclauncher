const fs = require("node:fs");
const path = require("node:path");
const run = require("node:util").promisify(require("node:child_process").execFile);
const Upstream = require("../runtime/upstream");
const Custom = require("../runtime/custom-runtime");
const Native = require("../runtime/local-native");
const { createPinnedNativeManager } = require("../runtime/pinned-native-manager");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../runtime/bundled-native");
const { confirmToolInstall } = require("../runtime/tool-install");

const id = "vulkan-loader";
const BOTTLE_RELEASES = { golden_gate: "27.0", tahoe: "26.0", sequoia: "15.0", sonoma: "14.0", ventura: "13.0", monterey: "12.0", big_sur: "11.0" };
const scope = url => /\/v2\/(.+)\/blobs\//.exec(new URL(url).pathname)?.[1];

function loaderSource(dependencies = {}) {
  return Upstream.index({ locations: ["https://formulae.brew.sh/api/formula/vulkan-loader.json"], hosts: ["formulae.brew.sh", "ghcr.io"], allArchitectures: true,
    parse: async ([document], { fetch: read }) => {
      const formula = JSON.parse(document.text), bottles = formula?.bottle?.stable?.files || {};
      const macOS = (dependencies.systemVersionSync || systemVersionSync)();
      const releases = Object.keys(BOTTLE_RELEASES).filter(name => versionAtLeast(macOS, BOTTLE_RELEASES[name]));
      const rows = [];
      for (const architecture of ["arm64", "x64"]) {
        const prefix = architecture === "arm64" ? "arm64_" : "";
        const names = [...releases.map(name => prefix + name), "all", ...Object.keys(bottles).filter(key => architecture === "arm64" ? key.startsWith("arm64_") : !key.startsWith("arm64_") && !/linux/.test(key))];
        const bottle = bottles[names.find(name => bottles[name]?.url)];
        if (!bottle) continue;
        const repository = scope(bottle.url);
        const token = repository && JSON.parse((await read(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`).catch(() => null))?.text || "{}")?.token;
        rows.push({ version: String(formula.versions?.stable || "current"), architecture,
          details: { headers: typeof token === "string" && token ? { Authorization: "Bearer " + token } : {} },
          files: [{ name: "vulkan-loader.tar.gz", url: bottle.url, digest: bottle.sha256, algorithm: "sha256", architecture }] });
      }
      return rows;
    } });
}

async function extractBottle(archive, output, signal) {
  const options = { signal, maxBuffer: 32 * 1024 * 1024 };
  const listing = await run("/usr/bin/tar", ["-tf", archive], options);
  const members = listing.stdout.trim().split("\n");
  if (members.length > 4096 || members.some(name => name.length > 1024 || name.startsWith("-") || /[\\\x00-\x1f]/.test(name) || path.posix.isAbsolute(name) || name.split("/").includes("..")))
    throw new Error("The Vulkan loader archive has invalid members.");
  const libraries = members.filter(name => /(?:^|\/)lib\/libvulkan\.\d+(?:\.\d+)+\.dylib$/.test(name));
  if (libraries.length !== 1) throw new Error("The Vulkan loader archive has no unique native library.");
  const library = libraries[0], prefix = library.slice(0, library.lastIndexOf("/lib/"));
  const content = await run("/usr/bin/tar", ["-xOf", archive, library], { ...options, encoding: "buffer" });
  fs.writeFileSync(path.join(output, "libvulkan.1.dylib"), content.stdout, { mode: 0o755 });
  const license = members.find(name => name === prefix + "/LICENSE.txt" || name === prefix + "/LICENSE");
  try { if (license) {
    const text = await run("/usr/bin/tar", ["-xOf", archive, license], { ...options, encoding: "buffer" });
    fs.mkdirSync(path.join(output, "licenses"), { recursive: true });
    fs.writeFileSync(path.join(output, "licenses/Vulkan-Loader.txt"), text.stdout);
  } } catch (error) { signal?.throwIfAborted(); console.warn("The optional Vulkan loader license could not be copied:", error.message); }
}

function inspectLibrary(file, architecture, dependencies) {
  const facts = readMachOLoadCommands(file, { architecture: architecture === "x64" ? "x86_64" : architecture });
  assertSystemLibraryClosure(facts, { fileType: 6, maximumMacOS: (dependencies.systemVersionSync || systemVersionSync)() });
  return facts;
}

function createManager(dependencies = {}) {
  const upstream = dependencies.upstream || loaderSource(dependencies);
  let manager;
  manager = createPinnedNativeManager({ id, label: "Vulkan loader", sourceUrl: "https://github.com/KhronosGroup/Vulkan-Loader", sourceLabel: "Source",
    upstreamUrl: "https://formulae.brew.sh/formula/vulkan-loader", sourceName: "Homebrew Vulkan-Loader", upstream,
    nativeLibrary: true, versionCompatibility: () => true,
    inspectRuntime(options) {
      const native = Native.resolveLocalRuntime({ ...options, allowLibrary: true });
      inspectLibrary(native.executablePath, options.arch, dependencies);
      return native;
    },
    resolveExecutable: root => path.join(root, "libvulkan.1.dylib"),
    prepareInstall({ unpacked, pin }) {
      const file = path.join(unpacked, "libvulkan.1.dylib");
      fs.chmodSync(file, 0o755);
      const facts = inspectLibrary(file, pin.architecture, dependencies);
      return { minimumMacOS: facts.slices.map(slice => slice.minimumMacOS).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) };
    },
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractBottle,
      downloadToFile: dependencies.downloadToFile || (async (url, destination, options) => {
        const pin = manager.core.listCatalog().find(row => row.asset?.url === url);
        if (!pin) throw new Error("Refresh the Vulkan loader versions before installing this version.");
        // Download authorization also permits a fresh anonymous bottle pull
        // token. Status and installed selection never call this source.
        const rows = await upstream.discover({ signal: options.signal });
        const fresh = rows.find(row => row.files.some(file => scope(file.url) === scope(url)));
        return Upstream.download(Upstream.listedFile(pin.asset), destination, { ...options, headers: fresh?.details?.headers || pin.headers });
      }) }
  });
  const result = { ...manager, ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Vulkan loader", order: 200, memberOrder: 268, management: "managed" } };
  Custom.configure(result, { inspect(input) {
    const native = Custom.inspectNative(input, { allowLibrary: true, candidates: ["libvulkan.1.dylib", "lib/libvulkan.1.dylib"] });
    const facts = inspectLibrary(native.executablePath, undefined, dependencies);
    return { ...native, architectures: facts.architectures };
  } });
  return result;
}

function selection(context, manager = module.exports.manager, architecture = "arm64") {
  const selected = manager.resolveSelection(null, context.settings, context.userDataDir, { architecture, verification: "status" });
  if (!selected.ready) return selected;
  const facts = readMachOLoadCommands(selected.install.executablePath);
  const cpu = architecture === "x64" ? "x86_64" : architecture;
  if (!facts.architectures.includes(cpu) && !facts.architectures.some(value => /^cpu-[0-9a-f]+$/.test(value)))
    return { ...selected, ready: false, reason: "The selected Vulkan loader has no " + cpu + " code." };
  return selected;
}
function requirements(context, { manager = module.exports.manager, architecture = "arm64" } = {}) {
  const selected = selection(context, manager, architecture);
  if (selected.ready) {
    context.recordRuntimeUse?.({ managerId: manager.id, version: selected.version, sectionId: "default", sourcePath: selected.install.installDir });
    return [];
  }
  if (selected.install) throw new Error(selected.reason);
  return [{ managerId: manager.id, version: selected.version || null, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}),
    requiresDownload: true, ...(selected.automatic ? { automatic: true } : {}), installOptions: { architecture, ...(selected.automatic ? { automatic: true } : {}) } }];
}
async function ensure(context, { manager = module.exports.manager, architecture = "arm64" } = {}) {
  let selected = selection(context, manager, architecture);
  if (selected.ready) {
    requirements(context, { manager, architecture });
    return selected.install;
  }
  if (selected.install) throw new Error(selected.reason);
  await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, installOptions: { architecture }, detail: "Required by the selected KosmicKrisp driver." });
  if (!selected.version || selected.discoveryRequired) {
    await manager.refreshCatalog({ userDataDir: context.userDataDir, signal: context.signal, force: true });
    selected = selection(context, manager, architecture);
  }
  return manager.installRuntime({ ...context, architecture, version: selected.version, automatic: context.automatic === true && selected.automatic === true });
}
const manager = createManager();
module.exports = { id, manager, createManager, loaderSource, selection, requirements, ensure };
