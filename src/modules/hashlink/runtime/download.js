const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { hashFile } = require("../../shared/runtime/pinned-native-manager");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const { inspectMachOExports } = require("../../shared/runtime/macho-exports");
const { versionAtLeast } = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const run = promisify(execFile);
const Primitives = require("./primitive-signatures");
const Profiles = require("./primitive-profiles");
const crypto = require("node:crypto");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const systemLibrary = file => /^(?:\/usr\/lib\/|\/System\/Library\/)/.test(file) && path.normalize(file) === file;

function resolveExecutable(root) {
  if (fs.existsSync(path.join(root, "hl"))) return path.join(root, "hl");
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && fs.existsSync(path.join(root, item.name, "hl")));
  if (directories.length !== 1) throw new Error("The HashLink archive must contain one bytecode VM.");
  return path.join(root, directories[0].name, "hl");
}

function inspectPackage(unpacked, pin, { signal } = {}) {
  const root = fs.realpathSync(unpacked), executablePath = resolveExecutable(root), nativeFiles = [], aliases = [];
  const header = path.join(path.dirname(executablePath), "include", "hl.h");
  if (!pin.sourceMetadata?.headerSha256 || !fs.lstatSync(header).isFile() || hashFile(header) !== pin.sourceMetadata.headerSha256)
    throw new Error("The HashLink archive header differs from its source commit.");
  let count = 0, bytes = 0;
  function visit(directory, depth = 0) {
    if (depth > 8) throw new Error("The HashLink archive is too deeply nested.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      const file = path.join(directory, item.name), stat = fs.lstatSync(file);
      if (++count > 256) throw new Error("The HashLink archive contains too many files.");
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(file);
        if (!inside(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error("A HashLink archive alias leaves its package.");
        aliases.push({ path: path.relative(root, file), target: path.relative(root, resolved) });
      } else if (stat.isDirectory()) visit(file, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > 64 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error("The HashLink archive exceeds its size limit.");
        if (file === executablePath || /\.(?:hdll|dylib)$/.test(item.name)) {
          const info = readMachOLoadCommands(file, { signal });
          if (info.architectures.length !== 1 || info.architectures[0] !== "x86_64") throw new Error("The HashLink bytecode VM and modules must use Intel code.");
          const image = info.slices[0];
          if (image.fileType !== (file === executablePath ? 2 : 6) || image.platform !== 1 || !image.minimumMacOS ||
            !versionAtLeast(pin.minimumMacOS, image.minimumMacOS) || image.dyldEnvironment.length ||
            image.dynamicLinker && !systemLibrary(image.dynamicLinker)) throw new Error("The HashLink archive has incompatible native platform requirements.");
          nativeFiles.push({ file, image });
        }
      } else throw new Error("The HashLink archive contains an unsupported file type.");
    }
  }
  visit(root);
  const nativeByPath = new Map(nativeFiles.map(item => [item.file, item]));
  const executable = nativeByPath.get(executablePath);
  const searchRoot = token => {
    if (token.startsWith("@executable_path")) return path.dirname(executablePath);
    if (token.startsWith("@loader_path")) return null;
    throw new Error("The HashLink archive has an external library search path.");
  };
  for (const item of nativeFiles) {
    const expand = value => {
      const token = /^@(loader|executable)_path(?=\/|$)/.exec(value)?.[0];
      if (!token) throw new Error("The HashLink archive has an external library search path.");
      const result = path.resolve(searchRoot(token) || path.dirname(item.file), value.slice(token.length).replace(/^\//, ""));
      if (!inside(root, result)) throw new Error("The HashLink archive has an external library search path.");
      return result;
    };
    const searchPaths = [...item.image.runPaths, ...executable.image.runPaths].map(expand);
    for (const library of item.image.dependencies) {
      if (systemLibrary(library.path)) continue;
      const candidates = library.path.startsWith("@rpath/") ? searchPaths.map(directory => path.join(directory, library.path.slice(7))) : [expand(library.path)];
      const dependency = candidates.find(file => {
        if (!inside(root, file) || !fs.existsSync(file)) return false;
        return nativeByPath.has(fs.realpathSync(file));
      });
      if (!dependency) throw new Error("The HashLink archive is missing a required Mac library.");
    }
  }
  const core = nativeFiles.find(item => /^libhl\.[\d.]+\.dylib$/.test(path.basename(item.file)));
  if (!core || core.image.installName?.currentVersion !== pin.upstreamVersion) throw new Error("The HashLink VM library version differs from the selected build.");
  return { root, executablePath, nativeFiles, aliases, core, header };
}

async function prepareInstall({ unpacked, pin, signal }, dependencies = {}) {
  const inspected = inspectPackage(unpacked, pin, { signal });
  const exports = dependencies.inspectMachOExports || inspectMachOExports;
  for (const item of inspected.nativeFiles) {
    const name = path.basename(item.file);
    const required = item === inspected.core ? ["hl_alloc_obj", "hl_alloc_dynamic"] : name === "sdl.hdll" ? ["hlp_event_loop", "hlp_init_once"] : [];
    if (required.length) {
      const symbols = new Set(await exports(item.file, { arch: "x86_64", signal }));
      if (!required.every(symbol => symbols.has(symbol))) throw new Error("The HashLink archive is missing required VM or native-module symbols.");
    }
    await (dependencies.run || run)("/usr/bin/codesign", ["--force", "--sign", "-", item.file], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    await (dependencies.run || run)("/usr/bin/codesign", ["--verify", "--strict", item.file], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  const profile = (dependencies.packageProfile || Primitives.packageProfile)({ executablePath: inspected.executablePath,
    corePath: inspected.core.file, nativeFiles: inspected.nativeFiles.map(item => item.file) });
  const expected = Profiles.forPin(pin);
  if (expected && Object.entries(expected.libraries).some(([library, info]) => {
    const actual = profile.libraries[library]?.signatures;
    return !actual || Object.keys(actual).length !== Object.keys(info.signatures).length ||
      Object.entries(info.signatures).some(([name, signature]) => actual[name] !== signature);
  }))
    throw new Error("The HashLink archive's native primitive signatures differ from its pinned profile.");
  const primitiveProfile = { schemaVersion: 1, sha256: crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
    libraries: Object.fromEntries(Object.entries(profile.libraries).map(([name, info]) => [name,
      { sha256: info.sha256, primitives: Object.keys(info.signatures).length, unsupported: info.unsupported.length }])) };
  return { schemaVersion: 1, upstreamVersion: pin.upstreamVersion, architecture: "x86_64", minimumMacOS: pin.minimumMacOS,
    supportedBytecodeVersions: pin.supportedBytecodeVersions, nativeAbi: pin.nativeAbi, primitiveProfile,
    files: inspected.nativeFiles.map(item => ({ path: path.relative(inspected.root, item.file), sha256: hashFile(item.file), minimumMacOS: item.image.minimumMacOS })),
    aliases: inspected.aliases, header: { path: path.relative(inspected.root, inspected.header), sha256: hashFile(inspected.header) } };
}

function verifyInstalled(install) {
  if (install?.source !== "download") return;
  const metadata = install.installationMetadata;
  if (metadata?.schemaVersion !== 1 || !Array.isArray(metadata.files) || metadata.files.length < 2 || metadata.files.length > 128 ||
    !Array.isArray(metadata.aliases) || metadata.aliases.length > 128 || !metadata.header) throw new Error("HashLink package metadata is missing. Reinstall this runtime.");
  const root = fs.realpathSync(install.installDir);
  const resolve = value => {
    if (typeof value !== "string" || path.isAbsolute(value) || value.split(/[\\/]/).some(part => !part || part === "." || part === ".."))
      throw new Error("HashLink package metadata contains an invalid path.");
    const file = path.join(root, value);
    if (!inside(root, fs.realpathSync(file))) throw new Error("A HashLink package file leaves its installation.");
    return file;
  };
  for (const item of [...metadata.files, metadata.header]) {
    const file = resolve(item.path);
    if (!fs.lstatSync(file).isFile() || hashFile(file) !== item.sha256) throw new Error("A HashLink package file changed. Reinstall this runtime.");
  }
  for (const alias of metadata.aliases) {
    const file = resolve(alias.path), target = resolve(alias.target);
    if (!fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== target) throw new Error("A HashLink library alias changed. Reinstall this runtime.");
  }
}

module.exports = { resolveExecutable, inspectPackage, prepareInstall, verifyInstalled };
