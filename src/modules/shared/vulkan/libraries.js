const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../runtime/pinned-native-manager");
const { downloadToFile, fetchUrlBuffer } = require("../runtime/download-utils");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../runtime/github-runtime-catalog");
const Custom = require("../runtime/custom-runtime");
const HTTP = require("undici");
const run = promisify(execFile);
const definitions = {
  moltenvk: { label: "MoltenVK", library: "libMoltenVK.dylib", defaultVersion: "1.4.2", source: "https://github.com/KhronosGroup/MoltenVK/releases" },
  kosmickrisp: { label: "KosmicKrisp", library: "libvulkan_kosmickrisp.dylib", defaultVersion: "3.4.3", source: "https://www.lwjgl.org/browse/release" }
};
const observedMinimumMacOS = {
  "moltenvk:1.4.2@db66022459ffb663aa2b50f6b018bc2e124f5edf": "12.0",
  "kosmickrisp:3.4.3@30fac9b95f99cda97312232be25ba55297bf9951": "26.0"
};
function releasePlatform(backend, version, revision) {
  const minimumMacOS = observedMinimumMacOS[`${backend}:${version}@${revision}`];
  return minimumMacOS ? { minimumMacOS } : {};
}

function inspect(file, { architecture = process.arch, macOSVersion = systemVersionSync(), signal } = {}) {
  return assertSystemLibraryClosure(readMachOLoadCommands(file, { architecture, signal }), { fileType: 6, maximumMacOS: macOSVersion });
}
async function extract(archive, output, signal) {
  await run("/usr/bin/tar", ["-xf", archive, "-C", output], { signal, maxBuffer: 1024 * 1024 });
}
async function headArtifact(url, { signal, headers } = {}) {
  const timeout = AbortSignal.timeout(20000);
  const response = await HTTP.fetch(url, { method: "HEAD", redirect: "follow", headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Vulkan release lookup failed (${response.status}).`);
  const bytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 * 1024) throw new Error("The Vulkan release has no valid artifact size.");
  const checksum = response.headers.get("x-amz-checksum-sha256");
  const sha256 = checksum ? Buffer.from(checksum, "base64").toString("hex") : null;
  return { bytes, ...(/^[a-f0-9]{64}$/.test(sha256 || "") ? { sha256 } : {}) };
}
function kosmicArtifact(entry) {
  return { filename: definitions.kosmickrisp.library,
    url: `https://build.lwjgl.org/release/${encodeURIComponent(entry.version)}/macosx/arm64/${definitions.kosmickrisp.library}`,
    artifactId: `lwjgl3:${entry.upstreamTag}:${entry.upstreamRevision}:macosx/arm64/${definitions.kosmickrisp.library}` };
}
function validateKosmicArtifact(asset, entry) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry?.version || "") ||
      !/^[a-f0-9]{40}$/.test(entry.upstreamRevision || "") ||
      entry.upstreamTag !== undefined && String(entry.upstreamTag).replace(/^v(?=\d)/, "") !== entry.version) return false;
  const expected = kosmicArtifact(entry);
  return asset?.url === expected.url && asset.filename === expected.filename &&
    (asset.artifactId === expected.artifactId && typeof entry.upstreamTag === "string" ||
      /^[a-f0-9]{64}$/.test(asset.sha256 || "") && asset.artifactId === undefined) &&
    Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 64 * 1024 * 1024;
}
async function loaderHeaders(dependencies, signal) {
  const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(
    "https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/vulkan-loader:pull", { signal, maxBytes: 65536 });
  if (response.status !== 200) throw new Error("Vulkan loader download authorization is unavailable.");
  const token = JSON.parse(response.body.toString("utf8")).token;
  if (typeof token !== "string" || !token) throw new Error("Vulkan loader download authorization is unavailable.");
  return { Authorization: "Bearer " + token };
}
async function discoverLoader(dependencies, signal) {
  const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)("https://formulae.brew.sh/api/formula/vulkan-loader.json",
    { signal, maxBytes: 1024 * 1024 });
  if (response.status !== 200) throw new Error(`Vulkan loader catalog lookup failed (${response.status}).`);
  const formula = JSON.parse(response.body.toString("utf8")), macOS = (dependencies.systemVersionSync || systemVersionSync)();
  const platforms = { golden_gate: "27.0", tahoe: "26.0", sequoia: "15.0", sonoma: "14.0", ventura: "13.0", monterey: "12.0", big_sur: "11.0" };
  const bottles = formula.bottle?.stable?.files;
  const platform = Object.keys(platforms).find(name => versionAtLeast(macOS, platforms[name]) && bottles?.["arm64_" + name]);
  const bottle = platform && bottles["arm64_" + platform];
  if (formula.name !== "vulkan-loader" || !bottle || !/^[a-f0-9]{64}$/.test(bottle.sha256 || "") ||
      bottle.url !== "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + bottle.sha256)
    throw new Error("The Vulkan loader publisher has no compatible Mac bottle.");
  const metadata = await (dependencies.headArtifact || headArtifact)(bottle.url, { signal, headers: await loaderHeaders(dependencies, signal) });
  if (!metadata || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > 64 * 1024 * 1024)
    throw new Error("The selected Vulkan loader bottle is unavailable.");
  return { filename: "vulkan-loader.tar.gz", url: bottle.url, bytes: metadata.bytes, sha256: bottle.sha256 };
}
function kosmicDiscovery(dependencies) {
  return options => {
    let loader;
    return createGithubReleaseDiscovery({ owner: "LWJGL", repo: "lwjgl3", dependencies,
      mapRelease: async (release, { resolveRevision }) => {
        const version = String(release.tag_name || "").replace(/^v(?=\d)/, "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || version.includes("..") || version.endsWith(".")) return null;
        const upstreamRevision = await resolveRevision(release);
        const entry = { version, versionLabel: "KosmicKrisp · LWJGL " + version, upstreamTag: release.tag_name,
          upstreamRevision, hostArchitectures: ["arm64"], ...releasePlatform("kosmickrisp", version, upstreamRevision) };
        const identity = kosmicArtifact(entry), metadata = await (dependencies.headArtifact || headArtifact)(identity.url, { signal: options?.signal });
        if (!metadata) return null;
        loader ||= discoverLoader(dependencies, options?.signal);
        return { ...entry, asset: { ...identity, bytes: metadata.bytes,
          ...(/^[a-f0-9]{64}$/.test(metadata.sha256 || "") ? { sha256: metadata.sha256 } : { integrity: "recorded-local" }) }, loader: await loader };
      } })(options);
  };
}
async function installLoader(unpacked, pin, dependencies, signal, onProgress) {
  const loader = pin.loader, archive = path.join(unpacked, ".vulkan-loader.tar.gz");
  if (!loader || !/^[a-f0-9]{64}$/.test(loader.sha256 || "") ||
      !Number.isSafeInteger(loader.bytes) || loader.bytes < 1 || loader.bytes > 64 * 1024 * 1024 ||
      loader.url !== "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + loader.sha256)
    throw new Error("The selected Vulkan loader identity is invalid.");
  await (dependencies.downloadToFile || downloadToFile)(loader.url, archive, { signal, onProgress, headers: await loaderHeaders(dependencies, signal) });
  if (fs.statSync(archive).size !== loader.bytes || hashFile(archive) !== loader.sha256) throw new Error("The Vulkan loader download differs from the selected release.");
  try {
    const listing = await run("/usr/bin/tar", ["-tf", archive], { signal, maxBuffer: 1024 * 1024 });
    const members = listing.stdout.trim().split("\n");
    if (members.length > 4096 || members.some(name => name.length > 1024 || name.startsWith("-") || /[\\\x00-\x1f]/.test(name) ||
        path.posix.isAbsolute(name) || name.split("/").includes(".."))) throw new Error("The Vulkan loader archive has invalid members.");
    const libraries = members.filter(name => /(?:^|\/)lib\/libvulkan\.\d+(?:\.\d+)+\.dylib$/.test(name));
    if (libraries.length !== 1) throw new Error("The Vulkan loader archive has no unique native library.");
    const library = libraries[0], prefix = library.slice(0, library.lastIndexOf("/lib/"));
    const license = members.find(name => name === prefix + "/LICENSE.txt" || name === prefix + "/LICENSE");
    if (!license) throw new Error("The Vulkan loader archive has no license.");
    for (const [member, output, maxBuffer] of [[library, "libvulkan.1.dylib", 32 * 1024 * 1024], [license, "Vulkan-Loader-LICENSE.txt", 1024 * 1024]]) {
      const content = await run("/usr/bin/tar", ["-xOf", archive, member], { signal, maxBuffer, encoding: "buffer" });
      fs.writeFileSync(path.join(unpacked, output), content.stdout);
    }
  } finally { fs.rmSync(archive, { force: true }); }
}
function createManager(backend, dependencies = {}) {
  const definition = definitions[backend];
  const discovery = backend === "moltenvk" ? createGithubReleaseDiscovery({ owner: "KhronosGroup", repo: "MoltenVK", dependencies,
    mapRelease: async (release, { githubAssetDigest, resolveRevision }) => {
      const asset = release.assets?.find(item => item.name === "MoltenVK-macos.tar"), sha256 = githubAssetDigest(asset);
      if (!asset || !sha256) return null;
      const version = release.tag_name.replace(/^v/, ""), upstreamRevision = await resolveRevision(release);
      return { version, versionLabel: "MoltenVK " + version,
        upstreamRevision, hostArchitectures: ["arm64", "x64"], ...releasePlatform("moltenvk", version, upstreamRevision),
        asset: { filename: asset.name, url: asset.browser_download_url, bytes: asset.size, sha256 } };
    } }) : kosmicDiscovery(dependencies);
  const manager = createPinnedNativeManager({ id: "vulkan-" + backend, label: definition.label, sourceUrl: definition.source,
    catalog: [], recommendedVersion: definition.defaultVersion, nativeLibrary: true, discoverCatalog: discovery,
    ...(backend === "kosmickrisp" ? { validateRecordedArtifact: validateKosmicArtifact,
      verifyArtifact({ archivePath, archiveSha256, pin, signal }) {
        if (!validateKosmicArtifact(pin.asset, pin)) throw new Error("The KosmicKrisp artifact differs from its selected upstream release.");
        const native = inspect(archivePath, { architecture: "arm64", macOSVersion: (dependencies.systemVersionSync || systemVersionSync)(), signal });
        return { verified: true, identity: pin.asset.artifactId || pin.asset.url + "#" + pin.asset.sha256, archiveSha256,
          architectures: native.architectures, minimumMacOS: native.slices[0].minimumMacOS };
      } } : {}),
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
      let minimumMacOS = "1.0";
      for (const file of files) {
        fs.chmodSync(path.join(unpacked, file), 0o755);
        const native = inspect(path.join(unpacked, file), { signal, macOSVersion: (dependencies.systemVersionSync || systemVersionSync)() });
        for (const slice of native.slices) if (versionAtLeast(slice.minimumMacOS, minimumMacOS)) minimumMacOS = slice.minimumMacOS;
      }
      return { backend, minimumMacOS, libraries: files.map(file => ({ file, sha256: hashFile(path.join(unpacked, file)) })) };
    }, dependencies: { ...dependencies, extractArchive: (archive, output, signal) => backend === "moltenvk" ? extract(archive, output, signal)
      : fs.promises.copyFile(archive, path.join(output, definition.library)) } });
  const result = { ...manager, backend, ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: definition.label, memberOrder: backend === "moltenvk" ? 20 : 21, management: "managed" } };
  Custom.configure(result, { inspect(runtimePath) {
    const native = Custom.inspectExecutable(runtimePath, { candidates: [definition.library, "MoltenVK", "Versions/A/MoltenVK"], allowLibrary: true });
    native.executablePath = fs.realpathSync(native.executablePath);
    const root = path.dirname(native.executablePath), files = [native.executablePath,
      ...(backend === "kosmickrisp" ? [path.join(root, "libvulkan.1.dylib")] : [])];
    for (const file of files) inspect(file, { architecture: native.architectures[0] === "x86_64" ? "x64" : "arm64" });
    return { ...native, installDir: root, installationMetadata: { backend, libraries: files.map(file => ({ file: path.basename(file), sha256: hashFile(file) })) } };
  } });
  return result;
}
const managers = Object.keys(definitions).map(backend => createManager(backend));
module.exports = { managers, definitions, createManager, inspect };
