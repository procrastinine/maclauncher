const fs = require("node:fs");
const path = require("node:path");
const Managed = require("../shared/runtime/steamworks/managed-profile");

const LIBRARY = /^(?:lib)?steam_api(?:64)?(?:\.(?:dll|dylib|so|bundle))?$/i;
const POSITIVE = /^(?:SteamAPI_|SteamInternal_)/;

function consumerImports(info) {
  const imports = (info.nativeImportEvidence || []).filter(item => LIBRARY.test(item.library || ""));
  return imports.some(item => POSITIVE.test(item.name || "")) ? imports : [];
}
function originalLibraries(source) {
  return fs.readdirSync(source, { withFileTypes: true }).filter(item => item.isFile() && LIBRARY.test(item.name))
    .slice(0, 32).map(item => path.join(source, item.name));
}
function clrAliases(imports) {
  return [...new Set(imports.flatMap(item => {
    // The existing host returns zero for unknown native imports. CLR probing
    // then appends .dylib even when the P/Invoke name already ends in .dll.
    const stem = item.library.replace(/\.(?:dll|so|dylib|bundle)$/i, ""), names = [item.library, `${stem}.dylib`];
    if (!stem.startsWith("lib")) names.push(`lib${stem}.dylib`);
    if (!/\.(?:dylib|bundle)$/i.test(item.library)) {
      names.push(`${item.library}.dylib`);
      if (!item.library.startsWith("lib")) names.push(`lib${item.library}.dylib`);
    }
    return names;
  }))].sort();
}
async function prepareLaunch({ info, context, gameRoot, baseEnvironment, arch = "arm64" }) {
  const imports = consumerImports(info);
  if (!imports.length) return null;
  if (info.dependencyInspection?.complete === false) throw new Error("The game's managed Steam API requirements could not be inspected completely.");
  const source = path.dirname(info.assemblyPath);
  const appId = require("../shared/runtime/steamworks/app-id").readGameAppId({ gameRoot: source });
  const managed = await Managed.selectManagedProfile({ imports, architecture: arch, signal: context.signal });
  const request = { required: true, appId, arch, symbols: [...new Set(imports.map(item => item.name))],
    ...managed,
    nativeLibraryPaths: originalLibraries(source), aliases: clrAliases(imports),
    ownedDirectory: path.join(path.dirname(path.dirname(gameRoot)), "steam-api") };
  const prepared = context.prepareSteamApi ? await context.prepareSteamApi(request, { baseEnvironment }) :
    await require("../shared/runtime/steamworks/automatic").prepareAutomaticLaunch(request, { ...context, baseEnvironment });
  if (!prepared?.libraryPath) throw new Error("The native Steam API library is unavailable.");
  return prepared;
}

module.exports = { consumerImports, clrAliases, prepareLaunch };
