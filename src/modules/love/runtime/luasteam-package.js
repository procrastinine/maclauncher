const {addLicense} = require("../../../../scripts/license-files.mjs");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Bundle = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Overlay = require("./luasteam-source-overlay");

const run = promisify(execFile);
const DEPENDENCIES = `LuaSteam v4.0.2 (${Overlay.SOURCE_REVISION}) is MIT licensed.
Lua C API headers are from LuaJIT ${Overlay.LUA_HEADERS_REVISION}; their MIT notice is included.
MacLauncher links Lua functions dynamically from the selected host. It does not embed another Lua VM.

Developer-only external input: Valve Steamworks SDK ${Overlay.SDK_VERSION}, header revision ${Overlay.SDK_HEADERS_REVISION}.
The pinned header hashes are recorded in the public producer source. SDK headers, SDK Readme,
proprietary SDK libraries and encrypted-ticket libraries are not included in this package.
Steamworks SDK materials remain subject to Valve's terms:
https://partner.steamgames.com/doc/sdk
https://partner.steamgames.com/documentation/sdk_access_agreement

The bridge uses MacLauncher's separately versioned shared Steam API library at launch.
End users need neither the SDK nor a compiler. The source and build recipe are in MacLauncher Builds under
producers/maclauncher/src/modules/love/runtime/luasteam-build.js. Source builds
require an authorized SDK header checkout and Apple's command-line developer tools.
`;

/** Maintainer staging only. Normal Play resolves this immutable shared payload. */
async function stageBundledHelper({ libraryPath, sourceRoot, destination, profile, projectLicense } = {}) {
  if (!path.isAbsolute(destination || "") || fs.existsSync(destination) || profile?.bridgeVersion !== Overlay.VERSION)
    throw new Error("Choose the exact LuaSteam profile and a fresh absolute bundle directory.");
  const library = Bundle.readRegular(libraryPath, 4 * 1024 * 1024);
  if (library.sha256 !== profile.bridgeLibrarySha256 ||
      !["arm64", "x86_64"].every(cpu => Native.readMachOArchitectures(libraryPath, { allowLibrary: true }).includes(cpu)))
    throw new Error("The LuaSteam candidate differs from its native qualification profile.");
  await run("/usr/bin/codesign", ["--verify", "--strict", libraryPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  const copy = (name, bytes, mode = 0o644) => fs.writeFileSync(path.join(destination, name), bytes, { flag: "wx", mode });
  copy("luasteam.so", library.bytes, 0o755);
  addLicense(destination,"luasteam",sourceRoot&&path.join(sourceRoot,"licenses/luasteam.txt"));
  addLicense(destination,"luajit",sourceRoot&&path.join(sourceRoot,"licenses/luajit.txt"));
  addLicense(destination,"maclauncher",projectLicense);
  fs.mkdirSync(path.join(destination,"licenses"),{recursive:true});
  copy("licenses/luasteam-dependencies.txt",Buffer.from(DEPENDENCIES));
  const files = Bundle.fileInventory(destination).sort().map(name => {
    const file = Bundle.readRegular(path.join(destination, name), 4 * 1024 * 1024);
    return { path: name, size: file.size, sha256: file.sha256, mode: file.mode,
      ...(name === "luasteam.so" ? { architectures: ["arm64", "x86_64"] } : {}) };
  });
  const manifest = { schemaVersion: 1, id: "love-luasteam", version: Overlay.VERSION, upstreamVersion: "4.0.2",
    sourceRevision: Overlay.SOURCE_REVISION, luaHeadersRevision: Overlay.LUA_HEADERS_REVISION,
    sdkHeadersRevision: Overlay.SDK_HEADERS_REVISION, sdkVersion: Overlay.SDK_VERSION,
    hostLuaAbi: Overlay.HOST_LUA_ABI, minimumMacOS: "13.0", abiProfile: profile.id,
    librarySha256: library.sha256, steamHelperVersion: profile.helperVersion,
    steamHelperLibrarySha256: profile.helperLibrarySha256, files };
  copy("helper.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  const sealed = Bundle.readRegular(path.join(destination, "helper.json"), 128 * 1024);
  const declaration = { id: "love-luasteam", version: Overlay.VERSION, arch: "universal",
    launcherArchitectures: ["arm64", "x64"], minimumMacOS: "13.0", sourceRelative: null,
    sourceSha256: Bundle.readRegular(path.join(__dirname, "luasteam-source-overlay.js"), 128 * 1024).sha256,
    directoryRelative: `love-luasteam/${Overlay.VERSION}/universal`, manifestRelative: "helper.json", manifestSha256: sealed.sha256,
    files: [...files, { path: "helper.json", size: sealed.size, sha256: sealed.sha256, mode: 0o644 }] };
  Bundle.verifyPayload(destination, declaration);
  return { manifest, declaration };
}

module.exports = { stageBundledHelper, DEPENDENCIES };
