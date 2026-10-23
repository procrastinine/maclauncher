const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../runtime/pinned-native-manager");
const { downloadToFile, fetchUrlBuffer } = require("../runtime/download-utils");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../runtime/macho-load-commands");
const { systemVersionSync } = require("../runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../runtime/github-runtime-catalog");
const catalog = require("./catalog.json");
const run = promisify(execFile);
const definitions = {
  moltenvk: { label: "MoltenVK", library: "libMoltenVK.dylib", source: "https://github.com/KhronosGroup/MoltenVK/releases" },
  kosmickrisp: { label: "KosmicKrisp", library: "libvulkan_kosmickrisp.dylib", source: "https://www.lwjgl.org/browse/release" }
};

function inspect(file, { architecture = process.arch, macOSVersion = systemVersionSync(), signal } = {}) {
  return assertSystemLibraryClosure(readMachOLoadCommands(file, { architecture, signal }), { fileType: 6, maximumMacOS: macOSVersion });
}
async function extract(archive, output, signal) {
  await run("/usr/bin/tar", ["-xf", archive, "-C", output], { signal, maxBuffer: 1024 * 1024 });
}
async function installLoader(unpacked, pin, dependencies, signal, onProgress) {
  const loader = pin.loader, archive = path.join(unpacked, loader.filename), staging = path.join(unpacked, ".loader");
  const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(
    "https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/vulkan-loader:pull", { signal, maxBytes: 65536 });
  const token = JSON.parse(response.body.toString("utf8")).token;
  if (response.status !== 200 || typeof token !== "string" || !token) throw new Error("Vulkan loader download authorization is unavailable.");
  await (dependencies.downloadToFile || downloadToFile)(loader.url, archive, { signal, onProgress, headers: { Authorization: "Bearer " + token } });
  if (fs.statSync(archive).size !== loader.bytes || hashFile(archive) !== loader.sha256) throw new Error("The Vulkan loader download differs from the selected release.");
  fs.mkdirSync(staging);
  try {
    await extract(archive, staging, signal);
    fs.copyFileSync(path.join(staging, loader.library), path.join(unpacked, "libvulkan.1.dylib"));
    fs.copyFileSync(path.join(staging, loader.license), path.join(unpacked, "Vulkan-Loader-LICENSE.txt"));
  } finally { fs.rmSync(archive, { force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
function createManager(backend, dependencies = {}) {
  const definition = definitions[backend];
  const discovery = backend === "moltenvk" ? createGithubReleaseDiscovery({ owner: "KhronosGroup", repo: "MoltenVK",
    mapRelease: async (release, { githubAssetDigest, resolveRevision }) => {
      const asset = release.assets?.find(item => item.name === "MoltenVK-macos.tar"), sha256 = githubAssetDigest(asset);
      if (!asset || !sha256) return null;
      return { version: release.tag_name.replace(/^v/, ""), versionLabel: "MoltenVK " + release.tag_name.replace(/^v/, ""),
        upstreamRevision: await resolveRevision(release), hostArchitectures: ["arm64", "x64"],
        asset: { filename: asset.name, url: asset.browser_download_url, bytes: asset.size, sha256 } };
    } }) : undefined;
  const manager = createPinnedNativeManager({ id: "vulkan-" + backend, label: definition.label, sourceUrl: definition.source,
    catalog: catalog[backend], nativeLibrary: true, discoverCatalog: discovery,
    resolveExecutable: root => path.join(root, definition.library),
    prepareInstall: async ({ unpacked, pin, signal, onProgress }) => {
      if (backend === "moltenvk") {
        fs.copyFileSync(path.join(unpacked, "MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib"), path.join(unpacked, definition.library));
        fs.copyFileSync(path.join(unpacked, "MoltenVK/LICENSE"), path.join(unpacked, "MoltenVK-LICENSE.txt"));
        fs.rmSync(path.join(unpacked, "MoltenVK"), { recursive: true, force: true });
      } else {
        await installLoader(unpacked, pin, dependencies, signal, onProgress);
        fs.cpSync(path.join(__dirname, "notices"), path.join(unpacked, "notices"), { recursive: true });
      }
      const files = [definition.library, ...(pin.loader ? ["libvulkan.1.dylib"] : [])];
      for (const file of files) {
        fs.chmodSync(path.join(unpacked, file), 0o755);
        inspect(path.join(unpacked, file), { signal });
      }
      return { backend, libraries: files.map(file => ({ file, sha256: hashFile(path.join(unpacked, file)) })) };
    }, dependencies: { ...dependencies, extractArchive: (archive, output, signal) => backend === "moltenvk" ? extract(archive, output, signal)
      : fs.promises.copyFile(archive, path.join(output, definition.library)) } });
  return { ...manager, backend, ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: definition.label, memberOrder: backend === "moltenvk" ? 20 : 21, management: "managed" } };
}
const managers = Object.keys(definitions).map(backend => createManager(backend));
module.exports = { managers, definitions, createManager, inspect };
