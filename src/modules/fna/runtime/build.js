const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Source = require("../../shared/runtime/pinned-native-build");
const BuildTools = require("../../shared/runtime/native-build-tools");
const Bundled = require("../../shared/runtime/bundled-native");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");

const PROFILE = "26.10-MCLv1";
const FNA_REVISION = "00498b0b81425b14bf8da23e68655215b9b5daa7";
const FNA3D_REVISION = "fd1b24671fb0f5d1b544cd7843d3ad9e80d92219";
const PREVIOUS_PROFILE = { profile: "26.10-net8-arm64-v2", revision: "651c0ffdf4db43cd112865ad368c5d6cc3dc7558", dotnetVersion: "8.0.31" };
const DOTNET_VERSION = "8.0.32";
const REQUIRED_FILES = ["FNA.dll", "MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json",
  "native/lib/libSDL3.0.dylib", "native/lib/libFNA3D.0.dylib", "native/lib/libFAudio.0.dylib",
  `host/fxr/${DOTNET_VERSION}/libhostfxr.dylib`, `shared/Microsoft.NETCore.App/${DOTNET_VERSION}/libhostpolicy.dylib`,
  `shared/Microsoft.NETCore.App/${DOTNET_VERSION}/libcoreclr.dylib`, `shared/Microsoft.NETCore.App/${DOTNET_VERSION}/System.Private.CoreLib.dll`];
const PACKAGES = Object.freeze({
  source: { filename: "FNA-2610.zip", url: "https://fna.flibitijibibo.com/archive/FNA-2610.zip", sha256: "863504b5712b17ce8d0ec32238411a10fb6cf56e90d3978f09a8a6c5571dd052" },
  compiler: { filename: "roslyn-4.8.0.zip", url: "https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/4.8.0/microsoft.net.compilers.toolset.4.8.0.nupkg", sha256: "37333f4f1e2ce55e621355d6da651dc23d4cb5f94a8f76b9478816e87f110ad9" },
  references: { filename: "net8-reference-pack.zip", url: "https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.ref/8.0.32/microsoft.netcore.app.ref.8.0.32.nupkg", sha256: "6088b3ebfe5af44511eaf8d592e029e1ef870da01b1fcb80aa790a6536bc14db" },
  sdl: { filename: "SDL3-3.4.18.tar.gz", url: "https://github.com/libsdl-org/SDL/releases/download/release-3.4.18/SDL3-3.4.18.tar.gz", sha256: "9c75cf16330322c217dedd2e0609f1124f1b54b8633e763467b4684d0f4334a3" },
  ...BuildTools.PACKAGES
});

function frameworkFiles(root) {
  const project = fs.readFileSync(path.join(root, "FNA.Core.csproj"), "utf8");
  const files = [...project.matchAll(/<Compile Include="([^"]+)"/g)].map(match => {
    const relative = match[1].replace(/\\/g, "/");
    if (path.isAbsolute(relative) || relative.split("/").some(part => part === "..")) throw new Error("Unsafe FNA compile input.");
    const file = path.join(root, relative);
    if (!fs.statSync(file).isFile()) throw new Error("Pinned FNA compile input is missing.");
    return file;
  });
  if (!files.length || files.length > 2000) throw new Error("Invalid FNA compile inventory.");
  return files;
}
function frameworkResources(root) {
  const project = fs.readFileSync(path.join(root, "FNA.Core.csproj"), "utf8");
  const names = new Set();
  const resources = [...project.matchAll(/<EmbeddedResource Include="([^"]+)">\s*<LogicalName>([^<]+)<\/LogicalName>\s*<\/EmbeddedResource>/g)].map(match => {
    const relative = match[1].replace(/\\/g, "/"), name = match[2];
    if (path.isAbsolute(relative) || relative.split("/").some(part => part === "..") ||
        !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || names.has(name)) throw new Error("Unsafe or duplicate FNA resource input.");
    names.add(name);
    const file = path.join(root, relative);
    if (!fs.statSync(file).isFile()) throw new Error("Pinned FNA shader resource is missing.");
    return { file, name };
  });
  if (!resources.length || resources.length > 64) throw new Error("Invalid FNA embedded resource inventory.");
  return resources;
}
function applyOpenGLPolicy(root) {
  const file = path.join(root, "lib", "FNA3D", "src", "FNA3D_Driver_OpenGL.c");
  const original = fs.readFileSync(file, "utf8");
  const needle = "SDL_GL_SetAttribute(SDL_GL_ACCELERATED_VISUAL, 1);";
  if (original.split(needle).length !== 2) throw new Error("Pinned FNA3D software OpenGL overlay no longer matches its source.");
  fs.writeFileSync(file, original.replace(needle,
    'SDL_GL_SetAttribute(SDL_GL_ACCELERATED_VISUAL, SDL_getenv("MACLAUNCHER_ALLOW_SOFTWARE_OPENGL") && SDL_strcmp(SDL_getenv("MACLAUNCHER_ALLOW_SOFTWARE_OPENGL"), "1") == 0 ? 0 : 1);'));
  return Native.hashFile(file);
}
function writeCompilerResponse(file, { sources, references, resources = [], output, target = "library", unsafe = false, define = "" }) {
  // Roslyn response files have their own quote syntax; never pass shell commands.
  if ([...sources, ...references, ...resources.map(resource => resource.file), output].some(value => /[\r\n"]/.test(value)) ||
      resources.some(resource => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(resource.name))) throw new Error("Compiler paths contain unsupported characters.");
  const quote = value => '"' + value + '"';
  const lines = ["/nologo", `/target:${target}`, "/langversion:9", "/nullable:enable", "/nostdlib+", `/out:${quote(output)}`,
    ...(unsafe ? ["/unsafe+"] : []), ...(define ? [`/define:${define}`] : []),
    ...references.map(reference => `/reference:${quote(reference)}`),
    ...resources.map(resource => `/resource:${quote(resource.file)},${resource.name}`), ...sources.map(quote)];
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
function runtimeConfig() {
  return { runtimeOptions: { tfm: "net8.0", framework: { name: "Microsoft.NETCore.App", version: DOTNET_VERSION }, rollForward: "Disable" } };
}
function stageAbiSource(source, destination) {
  const original = fs.readFileSync(source, "utf8");
  // Current FNA intentionally has no Xbox Live services. The upstream Game
  // facade still forwards GamerServicesComponent; omit this unsupported type
  // only in the private build input. Games using those services are rejected.
  const filtered = original.replace(/^\[assembly: TypeForwardedToAttribute\(typeof\(Microsoft\.Xna\.Framework\.GamerServices\.GamerServicesComponent\)\)\]\r?\n/gm, "");
  fs.writeFileSync(destination, filtered);
}
const { resolveBuildTool } = BuildTools;

async function prepareRuntime({ unpacked, pin, logger, signal, sourcePath, fna3dSourcePath, dependencies = {} }) {
  if (pin.version !== PROFILE || process.arch !== "arm64" || process.platform !== "darwin") throw new Error("This FNA runtime requires an Apple Silicon Mac.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fna-build-"));
  const logRoot = path.join(path.dirname(path.dirname(unpacked)), "build-logs");
  fs.mkdirSync(logRoot, { recursive: true });
  const logPath = path.join(logRoot, PROFILE + "-" + Date.now() + ".log");
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const download = dependencies.downloadToFile || downloadToFile;
  fs.writeFileSync(logPath, `FNA ${FNA_REVISION}\nProfile ${PROFILE}\n`);
  try {
    async function packageArchive(key, destination) {
      const item = PACKAGES[key], archive = path.join(temporary, item.filename);
      logger?.info?.(`[fna] downloading ${item.filename}`);
      await download(item.url, archive, { signal });
      throwIfAborted(signal);
      if (Native.hashFile(archive) !== item.sha256) throw new Error(`${item.filename} failed its SHA-256 check.`);
      fs.mkdirSync(destination, { recursive: true });
      await run(item.filename.endsWith(".zip") ? "/usr/bin/ditto" : "/usr/bin/tar",
        item.filename.endsWith(".zip") ? ["-x", "-k", archive, destination] : ["-xzf", archive, "-C", destination], { logPath, signal });
    }
    // Compiler installation is owned by macOS; probe it before any auxiliary
    // downloads. CMake/Ninja have portable publisher releases when absent.
    await run("/usr/bin/xcrun", ["--find", "clang"], { logPath, signal });
    await run("/usr/bin/xcrun", ["--show-sdk-path"], { logPath, signal });
    const toolOptions = { findBuildTool: dependencies.findBuildTool || Source.findBuildTool, packageArchive, temporary };
    const cmake = await resolveBuildTool("cmake", toolOptions);
    const ninja = await resolveBuildTool("ninja", toolOptions);
    const framework = path.join(temporary, "framework");
    const checkout = sourcePath || path.resolve(__dirname, "../../../external/FNA");
    const source = await Source.validatePinnedSource(checkout, FNA_REVISION, { signal });
    const sourceTreeSha256 = Source.stagePinnedFiles(checkout, source.files, framework);
    const fna3dCheckout = fna3dSourcePath || path.resolve(__dirname, "../../../external/source-revisions/fna3d");
    const fna3d = await Source.validatePinnedSource(fna3dCheckout, FNA3D_REVISION, { signal });
    fs.rmSync(path.join(framework, "lib/FNA3D"), { recursive: true, force: true });
    const fna3dSourceSha256 = Source.stagePinnedFiles(fna3dCheckout, fna3d.files, path.join(framework, "lib/FNA3D"));
    const compiler = path.join(temporary, "compiler"), referencePack = path.join(temporary, "reference-pack"), sdlSource = path.join(temporary, "sdl-source");
    await packageArchive("compiler", compiler);
    await packageArchive("references", referencePack);
    await packageArchive("sdl", sdlSource);
    const referenceRoot = path.join(referencePack, "ref", "net8.0");
    const references = fs.readdirSync(referenceRoot).filter(name => name.endsWith(".dll")).map(name => path.join(referenceRoot, name));
    const configPath = path.join(temporary, "compiler.runtimeconfig.json");
    fs.writeFileSync(configPath, JSON.stringify(runtimeConfig()));
    const dotnet = path.join(unpacked, "dotnet"), csc = path.join(compiler, "tasks", "netcore", "bincore", "csc.dll");
    async function compile(sources, output, extra = {}) {
      const response = path.join(temporary, path.basename(output) + ".rsp");
      writeCompilerResponse(response, { sources, references, output, ...extra });
      await run(dotnet, ["exec", "--runtimeconfig", configPath, csc, "@" + response], { logPath, signal });
    }
    const embeddedResources = frameworkResources(framework);
    await compile(frameworkFiles(framework), path.join(unpacked, "FNA.dll"), { unsafe: true, define: "NET;NET8_0;NETCOREAPP", resources: embeddedResources });
    const hostSource = path.resolve(__dirname, "../overlays/ManagedHost.cs");
    const stagedHost = path.join(temporary, "ManagedHost.cs");
    fs.copyFileSync(hostSource, stagedHost);
    await compile([stagedHost], path.join(unpacked, "MacLauncherFnaHost.dll"), { target: "exe" });
    fs.writeFileSync(path.join(unpacked, "MacLauncherFnaHost.runtimeconfig.json"), JSON.stringify(runtimeConfig()));
    const abiRoot = path.join(unpacked, "abi"); fs.mkdirSync(abiRoot);
    const supportedAbi = ["Microsoft.Xna.Framework.cs", "Microsoft.Xna.Framework.Game.cs", "Microsoft.Xna.Framework.Graphics.cs",
      "Microsoft.Xna.Framework.Video.cs", "Microsoft.Xna.Framework.Xact.cs", "Microsoft.Xna.Framework.Input.Touch.cs", "Microsoft.Xna.Framework.Storage.cs"];
    for (const name of supportedAbi) {
      const file = path.join(temporary, name + ".rsp"), output = path.join(abiRoot, name.replace(/\.cs$/, ".dll"));
      const stagedSource = path.join(temporary, name);
      stageAbiSource(path.join(framework, "abi", name), stagedSource);
      writeCompilerResponse(file, { sources: [stagedSource], references: [...references, path.join(unpacked, "FNA.dll")], output });
      await run(dotnet, ["exec", "--runtimeconfig", configPath, csc, "@" + file], { logPath, signal });
    }
    const overlaySha256 = applyOpenGLPolicy(framework);
    const nativePrefix = path.join(temporary, "native");
    const env = { ...process.env, PATH: [path.dirname(cmake), path.dirname(ninja), process.env.PATH || ""].join(path.delimiter) };
    async function cmakeLibrary(source, name, extra = []) {
      const output = path.join(temporary, "build-" + name);
      await run(cmake, ["-S", source, "-B", output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        "-DCMAKE_MAKE_PROGRAM=" + ninja,
        "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
        "-DCMAKE_INSTALL_PREFIX=" + nativePrefix, "-DCMAKE_PREFIX_PATH=" + nativePrefix,
        "-DCMAKE_INSTALL_RPATH=@loader_path", ...extra], { logPath, signal, env });
      await run(cmake, ["--build", output, "--parallel", "4"], { logPath, signal, env });
      await run(cmake, ["--install", output], { logPath, signal, env });
    }
    await cmakeLibrary(path.join(sdlSource, "SDL3-3.4.18"), "sdl", ["-DSDL_SHARED=ON", "-DSDL_STATIC=OFF", "-DSDL_TESTS=OFF", "-DSDL_TEST_LIBRARY=OFF", "-DSDL_EXAMPLES=OFF"]);
    await cmakeLibrary(path.join(framework, "lib", "FNA3D"), "fna3d", ["-DBUILD_SDL3=ON", "-DBUILD_TESTS=OFF"]);
    await cmakeLibrary(path.join(framework, "lib", "FAudio"), "faudio", ["-DBUILD_SDL3=ON", "-DBUILD_TESTS=OFF", "-DBUILD_UTILS=OFF"]);
    const nativeRoot = path.join(unpacked, "native", "lib"); fs.mkdirSync(nativeRoot, { recursive: true });
    for (const name of fs.readdirSync(path.join(nativePrefix, "lib")).filter(name => name.endsWith(".dylib"))) {
      const from = path.join(nativePrefix, "lib", name), to = path.join(nativeRoot, name);
      fs.copyFileSync(from, to);
      if (!Native.readMachOArchitectures(to, { allowLibrary: true }).includes("arm64")) throw new Error("FNA native dependency is missing ARM64 support.");
      await run("/usr/bin/codesign", ["--force", "--sign", "-", to], { logPath, signal });
    }
    const files = [...REQUIRED_FILES,
      ...fs.readdirSync(abiRoot).map(name => "abi/" + name),
      ...fs.readdirSync(nativeRoot).map(name => "native/lib/" + name)];
    const licenseRoot = path.join(unpacked, "licenses"); fs.mkdirSync(licenseRoot);
    for (const [label, source] of [["FNA", path.join(framework, "licenses")], ["FNA3D", path.join(framework, "lib", "FNA3D", "LICENSE")],
      ["MojoShader", path.join(framework, "lib", "FNA3D", "MojoShader", "LICENSE.txt")],
      ["FNA3D-stb-image.txt", path.join(framework, "lib", "FNA3D", "src", "stb_image.h")],
      ["FNA3D-stb-image-write.txt", path.join(framework, "lib", "FNA3D", "src", "stb_image_write.h")],
      ["FAudio", path.join(framework, "lib", "FAudio", "LICENSE")],
      ["FAudio-stb-vorbis.txt", path.join(framework, "lib", "FAudio", "src", "stb_vorbis.h")],
      ["FAudio-stb.txt", path.join(framework, "lib", "FAudio", "src", "stb.h")],
      ["SDL3", path.join(sdlSource, "SDL3-3.4.18", "LICENSE.txt")]]) {
      if (fs.existsSync(source)) fs.cpSync(source, path.join(licenseRoot, label), { recursive: true });
    }
    fs.writeFileSync(path.join(unpacked, "fna-runtime.json"), JSON.stringify({ profile: PROFILE, frameworkVersion: "26.10.0.0",
      dotnetVersion: DOTNET_VERSION, upstreamRevision: FNA_REVISION, architecture: "arm64", sourceTreeSha256,
      sourceArchiveSha256: sourceTreeSha256 ? null : PACKAGES.source.sha256, hostSourceSha256: Native.hashFile(stagedHost), overlaySha256,
      nativeVersions: { sdl: "3.4.18", fna3d: "26.10", faudio: "26.10" },
      nativeSources: { fna3d: { revision: FNA3D_REVISION, sourceTreeSha256: fna3dSourceSha256 } },
      embeddedResources: embeddedResources.map(resource => ({ name: resource.name, sha256: Native.hashFile(resource.file) })),
      videoSupport: false, files: Object.fromEntries([...new Set(files)].map(file => [file, Native.hashFile(path.join(unpacked, file))])) }, null, 2));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function verifyRuntime(install) {
  if (!install?.executablePath) throw new Error("FNA runtime is not installed.");
  const root = path.dirname(install.executablePath);
  const record = JSON.parse(fs.readFileSync(path.join(root, "fna-runtime.json"), "utf8"));
  const specification = [PROFILE, "26.10-net8-arm64-v3"].includes(record.profile) ? { revision: FNA_REVISION, dotnetVersion: DOTNET_VERSION } : record.profile === PREVIOUS_PROFILE.profile ? PREVIOUS_PROFILE : null;
  if (!specification || record.upstreamRevision !== specification.revision || record.dotnetVersion !== specification.dotnetVersion || record.frameworkVersion !== "26.10.0.0" ||
      record.architecture !== "arm64" || !record.files || Object.keys(record.files).length > 128) throw new Error("FNA runtime profile metadata is invalid.");
  let sealedManifest, sealedPayload;
  if (install.source === "bundled") {
    // Distribution relocation and signing change native bytes. The sealed
    // whole-payload manifest binds those final bytes, the original profile
    // metadata and its source identity; do not trust stale pre-relocation hashes.
    if (!Bundled.verifyInstalled({ installDir: install.installDir, record: install,
      pin: { upstreamRevision: specification.revision }, managerId: "fna" })) throw new Error("FNA bundled runtime inventory failed its integrity check.");
    sealedManifest = JSON.parse(fs.readFileSync(Bundled.bundledManifestPath(install), "utf8"));
    sealedPayload = path.join(install.installDir, "files");
  } else if (install.source === "download" && install.catalogEntry?.projectPackage) {
    const selected = install.catalogEntry.projectPackage;
    const matchingProfile = selected.version === record.profile || selected.version === PROFILE && record.profile === "26.10-net8-arm64-v3";
    if (selected.id !== "fna" || !matchingProfile || selected.manifestRelative !== "manifest.json")
      throw new Error("FNA runtime package identity is invalid.");
    const directory = path.join(install.installDir, "project-payload");
    const sealed = Bundled.readRegular(path.join(directory, selected.manifestRelative), Bundled.LIMITS.manifestBytes);
    const manifest = Bundled.validateManifest(JSON.parse(sealed.bytes), {
      managerId: "fna", version: selected.version, upstreamRevision: specification.revision, arch: "arm64"
    });
    if (sealed.sha256 !== selected.manifestSha256) throw new Error("FNA runtime package manifest changed.");
    sealedPayload = path.join(directory, "files");
    Bundled.verifyPayload(sealedPayload, manifest);
    sealedManifest = manifest;
  }
  if (sealedManifest) {
    const prefix = path.relative(sealedPayload, root).split(path.sep).join("/");
    if (path.isAbsolute(prefix) || prefix === ".." || prefix.startsWith("../")) throw new Error("FNA runtime escaped its package.");
    const finalFiles = new Map(sealedManifest.files.map(file => [file.path, file.sha256]));
    record.files = Object.fromEntries(Object.keys(record.files).map(relative => [relative, finalFiles.get((prefix ? prefix + "/" : "") + relative)]));
  }
  for (const file of REQUIRED_FILES) {
    const required = file.replaceAll(DOTNET_VERSION, specification.dotnetVersion);
    if (!record.files[required]) throw new Error("FNA runtime is incomplete.");
  }
  for (const [relative, checksum] of Object.entries(record.files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || !/^[a-f0-9]{64}$/.test(checksum) ||
      Native.hashFile(path.join(root, relative)) !== checksum) throw new Error("FNA runtime file integrity check failed.");
  }
  return { root, ...record };
}

module.exports = { PROFILE, FNA_REVISION, FNA3D_REVISION, PREVIOUS_PROFILE, DOTNET_VERSION, PACKAGES, prepareRuntime, verifyRuntime,
  __test: { REQUIRED_FILES, frameworkFiles, frameworkResources, applyOpenGLPolicy, stageAbiSource, resolveBuildTool, writeCompilerResponse, runtimeConfig } };
