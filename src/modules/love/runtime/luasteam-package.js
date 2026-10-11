const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Bundle = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Overlay = require("./luasteam-source-overlay");

const run = promisify(execFile);
const OWNED_SOURCES = ["luasteam-source-overlay.js", "luasteam-source-inputs.json", "luasteam-build.js",
  "luasteam-package.js", "luasteam-abi-probe.cpp", "luasteam-abi-probe.lua"];
const DEPENDENCIES = `LuaSteam v4.0.2 (${Overlay.SOURCE_REVISION}) is MIT licensed.
Lua C API headers are from LuaJIT ${Overlay.LUA_HEADERS_REVISION}; their MIT notice is included.
MacLauncher links Lua functions dynamically from the selected host. It does not embed another Lua VM.

Developer-only external input: Valve Steamworks SDK ${Overlay.SDK_VERSION}, header revision ${Overlay.SDK_HEADERS_REVISION}.
The pinned header hashes are recorded in luasteam-source-inputs.json. SDK headers, SDK Readme,
proprietary SDK libraries and encrypted-ticket libraries are not included in this source archive.
Steamworks SDK materials remain subject to Valve's terms:
https://partner.steamgames.com/doc/sdk
https://partner.steamgames.com/documentation/sdk_access_agreement

The bridge uses MacLauncher's separately versioned shared Steam API library at launch.
End users need neither the SDK nor a compiler. The source build entry is
src/modules/love/runtime/luasteam-build.js, buildFromSource; initialize the recorded
submodules and supply an authorized SDK header checkout. Apple's compiler is installed
by xcode-select --install and invoked using /usr/bin/xcrun.
`;

/** Publish only reviewed MIT inputs. SDK files are referenced by hash, never copied. */
async function createSourceArchive({ sourceRoot, destination, moduleRoot = __dirname, projectLicense } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(destination || "") || fs.existsSync(destination))
    throw new Error("Choose an absolute new LuaSteam source archive path.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-luasteam-source-"));
  try {
    for (const input of Overlay.INPUTS.filter(item => item.origin !== "steamSdk")) {
      const record = Bundle.readRegular(path.join(sourceRoot, input.destination), 1024 * 1024);
      if (record.sha256 !== input.sha256 || record.size !== input.size) throw new Error("The reviewed LuaSteam source changed.");
      const file = path.join(temporary, input.destination);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, record.bytes, { flag: "wx", mode: 0o644 });
    }
    for (const name of OWNED_SOURCES) {
      fs.writeFileSync(path.join(temporary, name), Bundle.readRegular(path.join(moduleRoot, name), 2 * 1024 * 1024).bytes,
        { flag: "wx", mode: 0o644 });
    }
    fs.writeFileSync(path.join(temporary, "DEPENDENCIES.txt"), DEPENDENCIES, { flag: "wx", mode: 0o644 });
    if (projectLicense) fs.writeFileSync(path.join(temporary, "notices/MacLauncher-MIT.txt"),
      Bundle.readRegular(projectLicense, 128 * 1024).bytes, { flag: "wx", mode: 0o644 });
    const normalize = directory => {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        if (fs.lstatSync(file).isDirectory()) normalize(file);
        else { fs.chmodSync(file, 0o644); fs.utimesSync(file, new Date(0), new Date(0)); }
      }
      fs.chmodSync(directory, 0o755); fs.utimesSync(directory, new Date(0), new Date(0));
    };
    normalize(temporary);
    const ownership = process.platform === "darwin"
      ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "wheel", "--options", "gzip:timestamp=0"]
      : ["--owner=0", "--group=0", "--numeric-owner", "--mtime=@0"];
    await run("/usr/bin/tar", ["-czf", destination, "--format", "ustar", ...ownership, "-C", temporary, "."],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 30000, maxBuffer: 1024 * 1024 });
    return Bundle.readRegular(destination, 4 * 1024 * 1024);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

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
  copy("luasteam-source-overlay.js", Bundle.readRegular(path.join(__dirname, "luasteam-source-overlay.js"), 128 * 1024).bytes);
  copy("LuaSteam-MIT.txt", Bundle.readRegular(path.join(sourceRoot, "notices/LuaSteam-LICENSE"), 128 * 1024).bytes);
  copy("LuaJIT-MIT.txt", Bundle.readRegular(path.join(sourceRoot, "notices/LuaJIT-COPYRIGHT"), 128 * 1024).bytes);
  copy("MacLauncher-MIT.txt", Bundle.readRegular(projectLicense, 128 * 1024).bytes);
  copy("DEPENDENCIES.txt", Buffer.from(DEPENDENCIES));
  await createSourceArchive({ sourceRoot, destination: path.join(destination, "source.tar.gz"), projectLicense });
  const files = fs.readdirSync(destination).sort().map(name => {
    const file = Bundle.readRegular(path.join(destination, name), 4 * 1024 * 1024);
    return { path: name, size: file.size, sha256: file.sha256, mode: file.mode,
      ...(name === "luasteam.so" ? { architectures: ["arm64", "x86_64"] } : {}) };
  });
  const notices = [
    { name: "LuaSteam", license: "MIT", path: "LuaSteam-MIT.txt", sourceUrl: "https://github.com/uspgamedev/luasteam" },
    { name: "Lua C API headers from LuaJIT", license: "MIT", path: "LuaJIT-MIT.txt", sourceUrl: "https://luajit.org/" },
    { name: "MacLauncher LuaSteam adaptation", license: "MIT", path: "MacLauncher-MIT.txt" }
  ];
  const manifest = { schemaVersion: 1, id: "love-luasteam", version: Overlay.VERSION, upstreamVersion: "4.0.2",
    sourceRevision: Overlay.SOURCE_REVISION, luaHeadersRevision: Overlay.LUA_HEADERS_REVISION,
    sdkHeadersRevision: Overlay.SDK_HEADERS_REVISION, sdkVersion: Overlay.SDK_VERSION,
    hostLuaAbi: Overlay.HOST_LUA_ABI, minimumMacOS: "13.0", abiProfile: profile.id,
    librarySha256: library.sha256, steamHelperVersion: profile.helperVersion,
    steamHelperLibrarySha256: profile.helperLibrarySha256, files, notices };
  copy("helper.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  const sealed = Bundle.readRegular(path.join(destination, "helper.json"), 128 * 1024);
  const declaration = { id: "love-luasteam", version: Overlay.VERSION, arch: "universal",
    launcherArchitectures: ["arm64", "x64"], minimumMacOS: "13.0", sourceRelative: "luasteam-source-overlay.js",
    sourceSha256: files.find(file => file.path === "luasteam-source-overlay.js").sha256,
    directoryRelative: `love-luasteam/${Overlay.VERSION}/universal`, manifestRelative: "helper.json", manifestSha256: sealed.sha256,
    files: [...files, { path: "helper.json", size: sealed.size, sha256: sealed.sha256, mode: 0o644 }], notices };
  Bundle.verifyPayload(destination, declaration);
  return { manifest, declaration };
}

module.exports = { createSourceArchive, stageBundledHelper, OWNED_SOURCES, DEPENDENCIES };
