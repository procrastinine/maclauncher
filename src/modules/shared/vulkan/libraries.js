const fs = require("node:fs"), path = require("node:path");
const { cloneOrCopySync, cloneOrCopy } = require("../copy-file");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../runtime/pinned-native-manager");
const Upstream = require("../runtime/upstream");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../runtime/bundled-native");
const Custom = require("../runtime/custom-runtime");
const run = promisify(execFile);
const definitions = {
  moltenvk: { label: "MoltenVK", library: "libMoltenVK.dylib", source: "https://github.com/KhronosGroup/MoltenVK/releases" },
  kosmickrisp: { label: "KosmicKrisp", library: "libvulkan_kosmickrisp.dylib", source: "https://www.lwjgl.org/browse/release" }
};

// A library must match its consumer process; callers override the launcher ABI for another runtime.
function inspect(file, { architecture = process.arch, macOSVersion = systemVersionSync(), signal } = {}) {
  return assertSystemLibraryClosure(readMachOLoadCommands(file, { architecture, signal }), { fileType: 6, maximumMacOS: macOSVersion });
}
// The macOS package keeps its current name. A renamed or repackaged one is
// matched by platform word and archive type; other Apple platforms and debug
// files are not the macOS library.
const MOLTENVK_ARCHIVE = /^MoltenVK.*\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|txz|zip)$/i;
const OTHER_PLATFORM = /(?:^|[-_.])(?:ios|tvos|visionos|xros|watchos|linux|windows|riscv\d*|debug|symbols?|dsym)(?:[-_.]|$)/i;
function moltenvkAsset(assets) {
  const candidates = (assets || []).filter(item => MOLTENVK_ARCHIVE.test(item?.name || "") && !OTHER_PLATFORM.test(item.name));
  return candidates.find(item => item.name === "MoltenVK-macos.tar") || candidates.find(item => /mac|osx|darwin|universal/i.test(item.name)) ||
    candidates.find(item => /(?:^|[-_.])all(?:[-_.]|$)/i.test(item.name));
}
// Every MoltenVK release with a macOS package; its macOS floor is read from the
// library at installation.
const moltenvk = Upstream.github({ repository: "KhronosGroup/MoltenVK", allArchitectures: true, recognize: release => {
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
      return { version, label: "KosmicKrisp · LWJGL " + version, architecture: "arm64", sourceUrl: `${definitions.kosmickrisp.source}/${version}/macosx/arm64`,
        ...(revision ? { revision } : {}), files: [{ name: definitions.kosmickrisp.library, url, bytes: head.headers["content-length"],
          ...(head.headers["x-amz-checksum-sha256"] ? { digest: head.headers["x-amz-checksum-sha256"], algorithm: "sha256" } : {}) }] };
    }));
    return rows.filter(Boolean).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  } });
// KosmicKrisp loads the Vulkan loader from Homebrew's bottle for this macOS,
// verified by the SHA-256 in Homebrew's formula metadata. Known release names
// order the bottles, newest not above this Mac first; another arm64 bottle is
// used when none of them is offered.
const BOTTLE_RELEASES = { golden_gate: "27.0", tahoe: "26.0", sequoia: "15.0", sonoma: "14.0", ventura: "13.0", monterey: "12.0", big_sur: "11.0" };
function loaderSource(dependencies = {}) {
  return Upstream.index({ locations: ["https://formulae.brew.sh/api/formula/vulkan-loader.json"], hosts: ["formulae.brew.sh", "ghcr.io"],
    parse: async ([document], { fetch: read }) => {
      const formula = JSON.parse(document.text), bottles = formula?.bottle?.stable?.files || {}, macOS = (dependencies.systemVersionSync || systemVersionSync)();
      const known = Object.keys(BOTTLE_RELEASES).filter(name => versionAtLeast(macOS, BOTTLE_RELEASES[name])).map(name => "arm64_" + name);
      const name = [...known, "all", ...Object.keys(bottles).filter(key => key.startsWith("arm64_"))].find(key => bottles[key]?.url);
      const bottle = name && bottles[name];
      if (!bottle) return [];
      // GitHub Packages hands out an anonymous pull token for the bottle's repository.
      const scope = /\/v2\/(.+)\/blobs\//.exec(new URL(bottle.url).pathname)?.[1];
      const token = scope && JSON.parse((await read(`https://ghcr.io/token?service=ghcr.io&scope=repository:${scope}:pull`).catch(() => null))?.text || "{}")?.token;
      return [{ version: String(formula.versions?.stable || "current"), details: { headers: typeof token === "string" && token ? { Authorization: "Bearer " + token } : {} },
        files: [{ name: "vulkan-loader.tar.gz", url: bottle.url, digest: bottle.sha256, algorithm: "sha256" }] }];
    } });
}
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
async function installLoader(unpacked, loader, signal) {
  const archive = path.join(unpacked, ".vulkan-loader.tar.gz");
  const [row] = await loader.discover({ signal });
  if (!row?.files[0]) throw new Error("The Vulkan loader publisher has no compatible Mac bottle.");
  await loader.download(row.files[0], archive, { signal, headers: row.details?.headers });
  try {
    const listing = await run("/usr/bin/tar", ["-tf", archive], { signal, maxBuffer: 1024 * 1024 });
    const members = listing.stdout.trim().split("\n");
    if (members.length > 4096 || members.some(name => name.length > 1024 || name.startsWith("-") || /[\\\x00-\x1f]/.test(name) ||
        path.posix.isAbsolute(name) || name.split("/").includes(".."))) throw new Error("The Vulkan loader archive has invalid members.");
    const libraries = members.filter(name => /(?:^|\/)lib\/libvulkan\.\d+(?:\.\d+)+\.dylib$/.test(name));
    if (libraries.length !== 1) throw new Error("The Vulkan loader archive has no unique native library.");
    const library = libraries[0], prefix = library.slice(0, library.lastIndexOf("/lib/"));
    // The bottle's license notice accompanies the library when it has one.
    const license = members.find(name => name === prefix + "/LICENSE.txt" || name === prefix + "/LICENSE");
    const content = await run("/usr/bin/tar", ["-xOf", archive, library], { signal, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" });
    fs.writeFileSync(path.join(unpacked, "libvulkan.1.dylib"), content.stdout);
    try { if (license) {
      const text = await run("/usr/bin/tar", ["-xOf", archive, license], { signal, encoding: "buffer" });
      fs.mkdirSync(path.join(unpacked, "licenses"), { recursive: true });
      fs.writeFileSync(path.join(unpacked, "licenses", "Vulkan-Loader.txt"), text.stdout);
    } } catch (error) { signal?.throwIfAborted(); console.warn("The optional Vulkan loader license could not be copied:", error.message); }
  } finally { fs.rmSync(archive, { force: true }); }
}
function createManager(backend, dependencies = {}) {
  const definition = definitions[backend], loader = backend === "kosmickrisp" ? loaderSource(dependencies) : null;
  const manager = createPinnedNativeManager({ id: "vulkan-" + backend, label: definition.label, sourceUrl: definition.source,
    nativeLibrary: true, upstream: backend === "moltenvk" ? moltenvk : kosmickrisp,
    resolveExecutable: root => path.join(root, definition.library),
    prepareInstall: async ({ unpacked, signal }) => {
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
        await installLoader(unpacked, loader, signal);
        try { cloneOrCopySync(path.join(__dirname, "notices"), path.join(unpacked, "licenses")); }
        catch (error) { console.warn("The optional Vulkan licenses could not be copied:", error.message); }
      }
      const files = [definition.library, ...(loader ? ["libvulkan.1.dylib"] : [])];
      let minimumMacOS = "1.0";
      for (const file of files) {
        fs.chmodSync(path.join(unpacked, file), 0o755);
        const native = inspect(path.join(unpacked, file), { signal, macOSVersion: (dependencies.systemVersionSync || systemVersionSync)() });
        for (const slice of native.slices) if (versionAtLeast(slice.minimumMacOS, minimumMacOS)) minimumMacOS = slice.minimumMacOS;
      }
      return { backend, minimumMacOS, libraries: files.map(file => ({ file, sha256: hashFile(path.join(unpacked, file)) })) };
    }, dependencies: { ...dependencies, extractArchive: (archive, output, signal) => backend === "moltenvk" ? extract(archive, output, signal)
      : cloneOrCopy(archive, path.join(output, definition.library), { signal }) } });
  const result = { ...manager, upstream: loader ? [kosmickrisp, loader] : moltenvk, backend, ui: { groupId: "translators", tabLabel: "Translators", sectionLabel: definition.label, memberOrder: backend === "moltenvk" ? 20 : 21, management: "managed", ...(backend === "kosmickrisp" ? { hostFeature: "METAL4" } : {}) } };
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
module.exports = { managers, definitions, createManager, inspect, moltenvkAsset, findFile, sources: { moltenvk, kosmickrisp }, loaderSource };
