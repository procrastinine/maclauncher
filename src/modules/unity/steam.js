const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../shared/game-data");
const Bundle = require("../shared/runtime/bundled-native");
const Managed = require("../shared/runtime/steamworks/managed-profile");

const LIBRARY = /^(?:lib)?steam_api(?:64)?(?:\.(?:dll|dylib|so|bundle))?$/i;
const POSITIVE = /^(?:SteamAPI_|SteamInternal_)/;

function consumerImports(info) {
  const imports = (info.nativeImportEvidence || []).filter(item => LIBRARY.test(item.library || ""));
  return imports.some(item => POSITIVE.test(item.name || "")) ? imports : [];
}
function aliases(imports) {
  return [...new Set(imports.flatMap(item => {
    const stem = item.library.replace(/\.(?:dll|so|dylib|bundle)$/i, "");
    return [item.library, stem, `${stem}.dylib`, ...(stem.startsWith("lib") ? [] : [`lib${stem}.dylib`])];
  }))].sort();
}
function originalLibraries(info) {
  const root = path.dirname(info.dataRoot), candidates = [];
  for (const directory of [root, info.dataRoot]) for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isFile() && LIBRARY.test(item.name)) candidates.push(path.join(directory, item.name));
  }
  for (const relative of info.nativePlugins || []) {
    if (typeof relative !== "string" || !LIBRARY.test(path.basename(relative))) continue;
    const file = path.resolve(info.dataRoot, relative), within = path.relative(info.dataRoot, file);
    if (within.startsWith(".." + path.sep) || within === ".." || path.isAbsolute(within)) throw new Error("A Unity Steam plugin path escapes the original game.");
    candidates.push(file);
  }
  return [...new Set(candidates)].slice(0, 32);
}
async function prepareLaunch({ info, entry, context, selection, baseEnvironment }) {
  const imports = consumerImports(info);
  if (!imports.length) return null;
  if (info.managedDependencyInspection?.complete === false) throw new Error("Unity's managed Steam API requirements could not be inspected completely.");
  const appId = require("../shared/runtime/steamworks/app-id").readGameAppId({ gameRoot: path.dirname(info.dataRoot), extraRoots: [info.dataRoot] });
  const arch = selection.install.needsRosetta ? "x64" : process.arch;
  const managed = await Managed.selectManagedProfile({ imports, architecture: arch, signal: context.signal });
  const request = { required: true, appId, arch, ...managed,
    symbols: [...new Set(imports.map(item => item.name))], aliases: aliases(imports), nativeLibraryPaths: originalLibraries(info),
    ownedDirectory: path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "unity"), "steam-api") };
  const prepared = context.prepareSteamApi ? await context.prepareSteamApi(request, { baseEnvironment }) :
    await require("../shared/runtime/steamworks/automatic").prepareAutomaticLaunch(request, { ...context, baseEnvironment });
  if (!prepared?.libraryPath) throw new Error("The native Steam API library is unavailable.");
  return prepared;
}
function profileIdentity(steam) {
  return steam ? { ...steam.identity, mode: steam.mode, libraryPath: steam.libraryPath, aliases: steam.aliases } : null;
}
function stagePlugins(contents, data, sourceContents, steam) {
  if (!steam) return;
  const plugins = path.join(contents, "Plugins"), stock = path.join(sourceContents, "Plugins");
  fs.mkdirSync(plugins);
  if (fs.existsSync(stock)) for (const item of fs.readdirSync(stock, { withFileTypes: true })) {
    if (steam.aliases.includes(item.name)) throw new Error("A native Unity player plugin conflicts with the selected Steam API library.");
    fs.symlinkSync(path.join(stock, item.name), path.join(plugins, item.name));
  }
  for (const name of steam.aliases) {
    if (!LIBRARY.test(name)) throw new Error("Invalid Unity Steam plugin alias.");
    fs.symlinkSync(steam.libraryPath, path.join(plugins, name));
  }
  // Both current and fused-Mono data layouts read this small private alias tree.
  fs.symlinkSync(path.relative(data, plugins), path.join(data, "Plugins"), "dir");
}
function verifyPlugins(contents, data, sourceContents, steam) {
  if (!steam) return true;
  const plugins = path.join(contents, "Plugins"), dataPlugins = path.join(data, "Plugins"), stock = path.join(sourceContents, "Plugins");
  Bundle.realDirectory(plugins);
  if (!fs.lstatSync(dataPlugins).isSymbolicLink() || fs.readlinkSync(dataPlugins) !== path.relative(data, plugins)) throw new Error("Unity's private Steam plugin directory changed.");
  const expected = new Map(steam.aliases.map(name => [name, steam.libraryPath]));
  if (fs.existsSync(stock)) for (const item of fs.readdirSync(stock)) {
    if (expected.has(item)) throw new Error("A native Unity player plugin conflicts with the selected Steam API library.");
    expected.set(item, path.join(stock, item));
  }
  if (JSON.stringify(fs.readdirSync(plugins).sort()) !== JSON.stringify([...expected.keys()].sort())) throw new Error("Unity's private Steam plugin inventory changed.");
  for (const [name, target] of expected) {
    const file = path.join(plugins, name);
    if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== target) throw new Error("Unity's private Steam plugin alias changed.");
  }
  return true;
}

module.exports = { consumerImports, aliases, originalLibraries, prepareLaunch, profileIdentity, stagePlugins, verifyPlugins };
